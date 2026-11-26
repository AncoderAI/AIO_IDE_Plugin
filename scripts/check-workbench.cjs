'use strict';

const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../workbench');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const required = [...manifest.generated, 'licenses/AIO-LICENSE.txt'];
if (manifest.platform === 'win32') {
  required.push('service/node_modules/node-pty/lib/index.js',
    'service/node_modules/node-pty/prebuilds/win32-' + manifest.architecture + '/conpty.node');
}
for (const file of required) {
  if (!fs.statSync(path.join(root, file)).isFile()) throw new Error('Missing workbench asset: ' + file);
}
fs.mkdirSync(path.resolve(__dirname, '../dist'), { recursive: true });
