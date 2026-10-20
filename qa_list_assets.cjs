// qa_list_assets.cjs
const fs = require('fs');
const path = require('path');
const dir = path.resolve('web/dist/assets');
if (!fs.existsSync(dir)) {
  console.error('NO_DIR', dir);
  process.exit(1);
}
const entries = fs.readdirSync(dir);
for (const name of entries) {
  const st = fs.statSync(path.join(dir, name));
  console.log(name + '  ' + st.size + '  ' + st.mtime.toISOString());
}