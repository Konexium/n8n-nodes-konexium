// Development only; this script is excluded from the published package.
const { copyFileSync } = require('node:fs');
for (const name of ['Konexium', 'KonexiumTrigger']) {
  copyFileSync(`nodes/Konexium/${name}.node.json`, `dist/nodes/Konexium/${name}.node.json`);
}
copyFileSync('nodes/Konexium/konexium.svg', 'dist/nodes/Konexium/konexium.svg');
