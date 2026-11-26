'use strict';

const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const { createServer } = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { stripVTControlCharacters } = require('node:util');
const { reopenWorkbench } = require('./verify-workbench-clipboard.cjs');

async function createCodexFixture(home, project, executable, env) {
  const prompts = [];
  const model = 'gpt-5.4';
  const server = createServer(async (request, response) => {
    if (request.url?.split('?')[0] !== '/v1/responses') {
      response.writeHead(404).end();
      return;
    }
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const user = body.input?.findLast(item => item.role === 'user');
      prompts.push(user?.content?.map(item => item.text || '').join(''));
      const message = { id: 'msg_' + prompts.length, type: 'message', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: 'Fixture acknowledged.', annotations: [] }] };
      const result = { id: 'resp_' + prompts.length, object: 'response', status: 'completed', model, output: [message],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const events = [
        { type: 'response.created', response: { ...result, status: 'in_progress', output: [] } },
        { type: 'response.output_item.added', output_index: 0, item: { ...message, status: 'in_progress', content: [] } },
        { type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: message.id, delta: message.content[0].text },
        { type: 'response.output_item.done', output_index: 0, item: message },
        { type: 'response.completed', response: result },
      ];
      for (const [sequence_number, event] of events.entries()) {
        response.write('event: ' + event.type + '\ndata: ' + JSON.stringify({ ...event, sequence_number }) + '\n\n');
      }
      response.end();
    } catch {
      response.writeHead(400).end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port + '/v1';
  try {
    await fs.mkdir(home);
    await fs.writeFile(path.join(home, 'config.toml'), [
      'model = ' + JSON.stringify(model), 'model_provider = "aio_fixture"',
      '[model_providers.aio_fixture]', 'name = "Local fixture"', 'base_url = ' + JSON.stringify(base),
      'env_key = "OPENAI_API_KEY"', 'wire_api = "responses"',
      '[projects.' + JSON.stringify(await fs.realpath(project)) + ']', 'trust_level = "trusted"', '',
    ].join('\n'));
    await fs.writeFile(path.join(home, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'aio-loopback-fixture' }));
  } catch (error) {
    server.close();
    throw error;
  }
  Object.assign(env, {
    AIO_CODEX_BINARY: executable, CODEX_HOME: home, OPENAI_API_KEY: 'aio-loopback-fixture',
    OPENAI_BASE_URL: base, NO_PROXY: 'localhost,127.0.0.1', HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '',
  });
  return { prompts, executable, project, env, close: () => { server.closeAllConnections(); server.close(); } };
}

async function waitForPrompt(prompts, text) {
  const end = Date.now() + 30000;
  while (Date.now() < end && !prompts.includes(text)) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(prompts.includes(text), true, 'Expected one exact user prompt. Loopback request lengths: ' +
    JSON.stringify(prompts.map(prompt => ({
      length: prompt?.length ?? null,
      matchingPrefix: [...(prompt || '')].findIndex((char, index) => char !== text[index]),
      newlineCount: (prompt?.match(/\n/g) || []).length,
      carriageReturnCount: (prompt?.match(/\r/g) || []).length,
    }))) + '; expected length: ' + text.length);
}

async function verifyCodexSubmission(window, firstFrame, fixture) {
  await firstFrame.evaluate(() => window.__TAURI__.core.invoke('desktop_request', {
    channel: 'coding-plugins:set', args: ['codex', 'install'],
  }));
  const frame = await reopenWorkbench(window, firstFrame);
  await frame.evaluate(() => {
    window.prime.terminal.onData(({ terminalId, data }) => {
      window.aioCodexTerminalId = terminalId;
      window.aioCodexOutput = ((window.aioCodexOutput || '') + data).slice(-50000);
    });
  });
  const picker = frame.getByTestId('coding-runtime-select').getByRole('button').first();
  await picker.evaluate(element => element.click());
  await frame.getByRole('menuitemradio', { name: /^Codex/ }).evaluate(element => element.click());
  const terminal = frame.locator('.terminal-surface:not([hidden]) .xterm').last();
  await terminal.waitFor({ state: 'visible' });
  await frame.waitForFunction(() => window.aioCodexOutput?.includes('Ask Codex'));
  await terminal.locator('.xterm-helper-textarea').focus();
  const cdp = await window.context().newCDPSession(window);
  try {
    const first = 'AIO 中文回车验收';
    await window.keyboard.type('AIO ');
    await cdp.send('Input.imeSetComposition', { text: 'zhongwen', selectionStart: 8, selectionEnd: 8 });
    await cdp.send('Input.insertText', { text: '中文回车验收' });
    assert.equal(fixture.prompts.length, 0, 'Composition must not submit the prompt.');
    await window.keyboard.press('Enter');
    await waitForPrompt(fixture.prompts, first);
    await new Promise(resolve => setTimeout(resolve, 750));
    assert.equal(fixture.prompts.filter(text => text === first).length, 1);

    const followUp = '@\n\n' + Array.from({ length: 8 }, (_, index) =>
      (index + 1) + '. 中文多段任务：只核对提交内容与次数，保留引号 "example" 和空行。').join('\n\n') + '\n\n@';
    const submit = text => frame.evaluate(value => window.__TAURI__.core.invoke('desktop_request', {
      channel: 'terminal:submit-task', args: [window.aioCodexTerminalId, value],
    }), text);
    await assert.rejects(submit(followUp), /must be single-line/);
    try {
      await submit('AIO 单行后续任务');
    } catch (error) {
      const output = await frame.evaluate(() => window.aioCodexOutput || '');
      throw new Error(error.message + ' / terminal tail: ' + stripVTControlCharacters(output).slice(-1500), { cause: error });
    }
    await waitForPrompt(fixture.prompts, 'AIO 单行后续任务');
    assert.equal(fixture.prompts.filter(text => text === 'AIO 单行后续任务').length, 1);
    assert.equal(fixture.prompts.some(text => text && followUp.split('\n').some(line => line && line === text)), false,
      'Rejected multi-line input must not submit fragments.');

    const worker = fork(path.join(__dirname, 'codex-native-fixture.cjs'), [], {
      env: fixture.env, windowsHide: true,
    });
    const workerExited = once(worker, 'exit');
    let startupOutput = '';
    worker.on('message', data => {
      startupOutput = (startupOutput + data).slice(-6000);
    });
    worker.send({ executable: fixture.executable, project: fixture.project, prompt: followUp });
    try {
      await waitForPrompt(fixture.prompts, followUp);
    } catch (error) {
      throw new Error(error.message + ' / worker tail: ' + stripVTControlCharacters(startupOutput).slice(-1800), { cause: error });
    } finally {
      if (worker.connected) worker.disconnect();
      const exited = await Promise.race([workerExited.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 5000))]);
      if (!exited) worker.kill();
    }
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(fixture.prompts.filter(text => text === followUp).length, 1);

    const bot = frame.locator('select[data-testid="bot-selector"]:visible').first();
    assert.equal(await bot.inputValue(), 'none');
    await bot.selectOption('codex');
    await frame.locator('.terminal-tab').filter({ hasText: /codex_Bot/i }).first().waitFor({ state: 'visible' });
    const composer = frame.locator('.coding-cli-composer textarea:visible, .composer textarea:visible').first();
    await composer.click();
    const botText = 'AIO Codex Bot composer check';
    await window.keyboard.type(botText);
    assert.equal(await composer.inputValue(), botText);
    await window.keyboard.press('Enter');
    await waitForPrompt(fixture.prompts, botText);
    assert.equal(fixture.prompts.filter(text => text === botText).length, 1);
  } finally { await cdp.detach(); }
}

module.exports = { createCodexFixture, verifyCodexSubmission };
