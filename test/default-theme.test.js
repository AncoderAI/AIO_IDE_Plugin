'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { WorkbenchService } = require('../src/workbench');

test('new profiles start dark and saved light or system preferences survive restart', async () => {
  const profilePath = await fs.mkdtemp(path.join(os.tmpdir(), 'aio-theme-'));
  const resourceRoot = path.resolve(__dirname, '../workbench/service');
  try {
    for (const [expected, next] of [['dark', 'light'], ['light', 'system'], ['system', undefined]]) {
      const service = new WorkbenchService({
        resourceRoot, profilePath, servicePath: path.join(resourceRoot, 'workbench-service.cjs'),
        version: 'test', resolveNodeRuntime: () => ({ executable: process.execPath, runAsNode: false }),
        spawn: (exe, args, options) => spawn(exe, [...args, '--smoke'], options),
      });
      service.start();
      try {
        assert.equal((await service.request('settings:get', [])).theme, expected);
        if (next) await service.request('settings:update', [{ theme: next }]);
      } finally {
        const stopped = once(service, 'exit');
        service.stop();
        await stopped;
      }
    }
  } finally {
    await fs.rm(profilePath, { recursive: true, force: true, maxRetries: 3 });
  }
});
