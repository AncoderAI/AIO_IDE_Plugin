'use strict';

// Keep the test ConPTY handles in a subprocess. Some Windows versions keep
// the native PTY reader alive after the client has exited.
const pty = require('../workbench/service/node_modules/node-pty');

process.once('message', ({ executable, project, prompt }) => {
  const terminal = pty.spawn(executable, ['--no-daemon', '--', prompt], {
    name: 'xterm-256color', cwd: project, env: { ...process.env, TERM: 'xterm-256color' },
    cols: 100, rows: 30, useConptyDll: true,
  });
  terminal.onExit(() => process.exit(0));
  terminal.onData(data => {
    if (process.connected) process.send(data);
    if (data.includes('\x1b[6n')) terminal.write('\x1b[1;1R');
    if (data.includes('\x1b[c')) terminal.write('\x1b[?1;2c');
    if (data.includes('\x1b[>c')) terminal.write('\x1b[>0;276;0c');
    if (data.includes('\x1b]11;?')) terminal.write('\x1b]11;rgb:1111/1111/1111\x1b\\');
  });
  process.once('disconnect', () => {
    terminal.write('\x03\x03');
    setTimeout(() => {
      terminal.kill();
      setTimeout(() => process.exit(0), 250);
    }, 800);
  });
});
