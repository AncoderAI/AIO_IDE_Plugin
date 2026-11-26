'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const EXPECTED_COMMIT = '492adf86872f0bb05723e67a8290690c7baf506c';

test('bundled service records and contains the compatible CLI changes from the selected AIO commit', () => {
  const root = path.resolve(__dirname, '..');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'workbench', 'manifest.json'), 'utf8'));
  const service = fs.readFileSync(path.join(root, 'workbench', 'service', 'workbench-service.cjs'), 'utf8');

  assert.ok(manifest.syncedUpstreamCommits.includes(EXPECTED_COMMIT));
  assert.deepEqual(manifest.syncedUpstreamFeatures.slice(0, 3), [
    'windows-claude-discovery',
    'coding-cli-executable-metadata',
    'coding-cli-configured-executable',
  ]);
  for (const evidence of [
    'var WindowsClaudeDiscovery = class',
    'source: "windows-path"',
    'source: "native"',
    'source: "winget"',
    'source: "npm"',
    'source: "configured"',
    'source: "environment"',
    '"coding-plugins:set-executable"',
    'executableVersion:',
    'executableIssue:',
    'executableSource:',
  ]) assert.ok(service.includes(evidence), `Missing bundled upstream evidence: ${evidence}`);

  assert.ok(manifest.syncedUpstreamCommits.includes('561bc25d4aeeec8310ab279e52e997b0f3ad1988'));
  for (const evidence of ['BotControlService', 'AIO_BOT_CAPABILITY', 'bot:terminal-created']) {
    assert.ok(service.includes(evidence), 'Missing bundled Bot evidence: ' + evidence);
  }
});
