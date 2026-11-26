'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { createRequire } = require('node:module');

async function main() {
  const upstream = process.env.AIO_SOURCE || path.resolve(__dirname, '../../AIO');
  const upstreamRequire = createRequire(path.join(upstream, 'package.json'));
  const { chromium } = upstreamRequire('playwright');
  const xtermScript = upstreamRequire.resolve('@xterm/xterm/lib/xterm.js');
  const edge = process.env.AIO_CHROMIUM_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const browser = await chromium.launch({ headless: true, ...(fs.existsSync(edge) ? { executablePath: edge } : {}) });
  try {
    const page = await browser.newPage();
    await page.setContent('<div class="xterm-host"></div>');
    await page.addScriptTag({ path: xtermScript });
    await page.evaluate(() => {
      window.__terminalData = '';
      const terminal = new Terminal();
      terminal.open(document.querySelector('.xterm-host'));
      terminal.onData(data => { window.__terminalData += data; });
    });
    await page.addScriptTag({ path: path.resolve(__dirname, '../src/file-drop.js') });
    const result = await page.evaluate(async () => {
      addEventListener('aio:file-drop-request', event => dispatchEvent(new CustomEvent('aio:file-drop-resolved', {
        detail: { id: event.detail.id, references: ['@"C:\\repo\\中文 file.ts"'] },
      })));
      const transfer = new DataTransfer();
      transfer.setData('text/uri-list', 'file:///C:/repo/%E4%B8%AD%E6%96%87%20file.ts');
      document.querySelector('.xterm-screen').dispatchEvent(new DragEvent('drop', {
        bubbles: true, cancelable: true, dataTransfer: transfer,
      }));
      await new Promise(resolve => setTimeout(resolve, 50));
      return window.__terminalData;
    });
    assert.equal(result, '@"C:\\repo\\中文 file.ts"');
    assert.doesNotMatch(result, /[\r\n\x1b]/);
    console.log('xterm received the dropped reference without Enter:', result);
  } finally {
    await browser.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
