"""
scripts/pe-set-subsystem.py — Change a Windows .exe's PE optional
header Subsystem field.

Why: postject's output is a console subsystem (CLI) binary because
node.exe's stock PE has Subsystem=3 (CONSOLE). When the user
double-clicks SAG.exe, Windows attaches a console window that
stays open for the process lifetime — annoying and unprofessional.

Setting Subsystem=2 (WINDOWS_GUI) makes the .exe a GUI app: no
console window pops up, stdout/stderr become detached (which is
why logger.ts auto-routes them to <release>/logs/ in that case).

Run: python pe-set-subsystem.py <path-to-exe> <subsystem-id>
where <subsystem-id> is 2 (GUI) or 3 (CONSOLE).

Cross-platform: Python stdlib struct only.
"""

import struct
import sys
from pathlib import Path

PE_SIGNATURE = b"PE\0\0"

# Subsystem IDs per PE spec:
#   0  UNKNOWN
#   1  NATIVE
#   2  WINDOWS_GUI   (no console window)
#   3  WINDOWS_CUI   (console; default for node.exe)
#   9  WINDOWS_CE_GUI
SUBSYSTEM_NAMES = {0: "UNKNOWN", 1: "NATIVE", 2: "WINDOWS_GUI", 3: "WINDOWS_CUI", 9: "WINDOWS_CE_GUI"}


def set_subsystem(exe_path: Path, subsystem: int) -> dict:
    if subsystem not in SUBSYSTEM_NAMES:
        raise SystemExit(f"unknown subsystem id: {subsystem} (valid: 0,1,2,3,9)")
    with exe_path.open("rb+") as f:
        dos = f.read(64)
        if dos[:2] != b"MZ":
            raise SystemExit(f"{exe_path} is not a PE (no MZ header)")
        pe_offset = struct.unpack_from("<I", dos, 0x3C)[0]
        f.seek(pe_offset)
        if f.read(4) != PE_SIGNATURE:
            raise SystemExit(f"{exe_path} is not a PE (signature mismatch)")
        # Optional header magic at PE+0x18 (right after the COFF
        # header's 20 bytes). We don't actually need the magic here;
        # the Subsystem field lives at optional-header offset 68 for
        # both PE32 and PE32+.
        opt_header_start = f.tell() + 20
        subsystem_offset = opt_header_start + 68
        f.seek(subsystem_offset)
        old = struct.unpack("<H", f.read(2))[0]
        if old == subsystem:
            return {"changed": False, "old": old, "new": subsystem}
        f.seek(subsystem_offset)
        f.write(struct.pack("<H", subsystem))
    return {"changed": True, "old": old, "new": subsystem}


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("usage: pe-set-subsystem.py <exe-path> <subsystem-id>", file=sys.stderr)
        print("       subsystem-id: 2 (GUI) or 3 (CONSOLE)", file=sys.stderr)
        sys.exit(2)
    exe = Path(sys.argv[1])
    if not exe.exists():
        print(f"not found: {exe}", file=sys.stderr)
        sys.exit(1)
    try:
        ss = int(sys.argv[2], 0)
    except ValueError:
        print(f"bad subsystem id: {sys.argv[2]}", file=sys.stderr)
        sys.exit(2)
    try:
        result = set_subsystem(exe, ss)
    except SystemExit:
        raise
    old_name = SUBSYSTEM_NAMES.get(result["old"], str(result["old"]))
    new_name = SUBSYSTEM_NAMES.get(result["new"], str(result["new"]))
    if result["changed"]:
        print(f"[pe-subsystem] {exe.name}: {old_name}({result['old']}) -> {new_name}({result['new']})")
    else:
        print(f"[pe-subsystem] {exe.name}: already {new_name}({result['new']}), no change")