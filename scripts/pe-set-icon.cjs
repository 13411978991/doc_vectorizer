// scripts/pe-set-icon.cjs — Pure-JS icon swap for Windows .exe files.
// Used in place of the rcedit binary (which is flaky on Windows and
// fails with "Unable to commit changes" intermittently). Uses
// resedit + pe-library that ship with app-builder-lib.
//
// Usage:
//   node scripts/pe-set-icon.cjs <input.exe> <output.exe> <icon.ico>
//
// Writes the result to <output.exe>. If <output.exe> equals <input.exe>
// the script aborts (resedit's own docs warn against rewriting in
// place). Caller should write to a temp path then rename.
const fs = require("node:fs");
const path = require("node:path");

const reseditRoot = path.join(
  __dirname, "..", "node_modules",
  "app-builder-lib", "node_modules"
);
const ResEdit = require(path.join(reseditRoot, "resedit"));

function setIcon(inputExe, outputExe, iconPath) {
  const data = fs.readFileSync(inputExe);
  const exe = ResEdit.NtExecutable.from(data);
  const res = ResEdit.NtExecutableResource.from(exe);

  const iconFile = ResEdit.Data.IconFile.from(fs.readFileSync(iconPath));
  // Add a fresh icon group (type 14 / RT_GROUP_ICON) at id=101 lang=1033.
  // If the target exe already had icon groups we add ours alongside
  // rather than overwriting, which keeps Electron's own cursors /
  // runtime resources intact.
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
    res.entries,
    101,
    1033,
    iconFile.icons.map((i) => i.data)
  );

  res.outputResource(exe);
  const newBinary = exe.generate();
  fs.writeFileSync(outputExe, Buffer.from(newBinary));
  return outputExe;
}

if (require.main === module) {
  const [, , inputExe, outputExe, iconPath] = process.argv;
  if (!inputExe || !outputExe || !iconPath) {
    console.error("Usage: node pe-set-icon.cjs <input.exe> <output.exe> <icon.ico>");
    process.exit(2);
  }
  if (path.resolve(inputExe) === path.resolve(outputExe)) {
    console.error("refusing to rewrite in place; pass a different <output.exe>");
    process.exit(2);
  }
  try {
    setIcon(inputExe, outputExe, iconPath);
    console.log(`✓ icon written: ${outputExe} (${fs.statSync(outputExe).size} bytes)`);
  } catch (err) {
    console.error(`✗ icon swap failed: ${err.message}`);
    process.exit(1);
  }
}

module.exports = { setIcon };