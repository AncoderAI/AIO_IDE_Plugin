'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

async function main() {
  const upstream = process.env.AIO_SOURCE || path.resolve(__dirname, '../../AIO');
  const fromAio = createRequire(path.join(upstream, 'package.json'));
  const assets = path.resolve(__dirname, '../workbench/ui/assets');
  const drawer = fs.readdirSync(assets).find(name => /^TerminalDrawer-.*\.js$/.test(name));
  const ratio = Number(fs.readFileSync(path.join(assets, drawer), 'utf8').match(/minimumContrastRatio:([\d.]+)/)?.[1]);
  assert.equal(ratio, 4.5);
  const browser = await fromAio('playwright').chromium.launch({
    channel: 'msedge', headless: true,
  });
  try {
    const page = await browser.newPage();
    await page.setContent('<div id="terminal"></div>');
    await page.addScriptTag({ path: fromAio.resolve('@xterm/xterm/lib/xterm.js') });
    const result = await page.evaluate(async ratio => {
      const terminal = new Terminal({ minimumContrastRatio: ratio, theme: { background: '#111110', foreground: '#deded9' } });
      terminal.open(document.querySelector('#terminal'));
      await new Promise(resolve => terminal.write('\x1b[38;2;0;0;0mDARK-INPUT\x1b[0m', resolve));
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const glyph = [...document.querySelectorAll('.xterm-rows span')].find(span => span.textContent.includes('D'));
      return getComputedStyle(glyph).color;
    }, ratio);
    const luminance = rgb => rgb.map(v => v / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
      .reduce((sum, component, i) => sum + component * [0.2126, 0.7152, 0.0722][i], 0);
    const actual = (luminance(result.match(/\d+/g).map(Number)) + 0.05) / (luminance([17, 17, 16]) + 0.05);
    assert.ok(actual >= 4.5, 'Insufficient contrast: ' + actual);
    console.log('Rendered dark input', result, 'contrast', actual.toFixed(2));
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
