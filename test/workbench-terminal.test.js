'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const { WorkbenchService } = require('../src/workbench');

test('Windows workbench PTY accepts input, resizes and closes each provider terminal', {
  skip: process.platform !== 'win32' || process.arch !== 'x64',
  timeout: 50000,
}, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aio-pty-'));
  const resourceRoot = path.resolve(__dirname, '../workbench/service');
  const service = new WorkbenchService({
    resourceRoot,
    servicePath: path.join(resourceRoot, 'workbench-service.cjs'),
    profilePath: path.join(root, 'profile'),
    version: 'test',
    resolveNodeRuntime: () => ({ executable: process.execPath, runAsNode: false }),
    spawn: (executable, args, options) => spawn(executable, [...args, '--smoke'], options),
  });
  const output = new Map();
  const exits = new Set();
  service.on('event', ({ payload: { event, payload } }) => {
    if (event === 'terminal:data') {
      output.set(payload.terminalId, (output.get(payload.terminalId) || '') + payload.data);
    } else if (event === 'terminal:exit') {
      exits.add(payload.terminalId);
    }
  });
  service.start();
  t.after(async () => {
    const exit = once(service, 'exit');
    service.stop();
    await exit;
    await fs.rm(root, { recursive: true, force: true, maxRetries: 4 });
  });
  const cwd = path.join(root, '项目 A');
  await fs.mkdir(cwd);
  const project = await service.request('projects:add-selected', [cwd]);
  for (const agent of ['omp', 'claude', 'codex']) {
    const { terminalId } = await service.request('terminal:create', [{ cwd, projectId: project.id, agent }]);
    await service.request('terminal:resize', [terminalId, 100, 32]);
    // cmd /Q suppresses input echo. Arithmetic makes the result unique to execution.
    await service.request('terminal:input', [terminalId, 'set /a 701*1301\r']);
    const deadline = Date.now() + 5000;
    while (!output.get(terminalId)?.includes(String(701 * 1301)) && Date.now() < deadline) await delay(20);
    assert.match(output.get(terminalId) || '', new RegExp('AIO-TERMINAL-' + agent.toUpperCase()));
    assert.ok(output.get(terminalId).includes(String(701 * 1301)), agent + ' did not process terminal input');
    await service.request('terminal:kill', [terminalId]);
    const closeDeadline = Date.now() + 3000;
    while (!exits.has(terminalId) && Date.now() < closeDeadline) await delay(20);
    assert.ok(exits.has(terminalId), agent + ' did not signal exit');
  }
});
