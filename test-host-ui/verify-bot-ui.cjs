'use strict'

const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs/promises')
const path = require('node:path')
const { prepareClaudeFixture, reopenWorkbench } = require('./verify-workbench-clipboard.cjs')

async function waitFor(predicate, message, timeout = 12000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(message)
}

async function compileBotFixture(project, exposeTestCapability = false) {
  const source = path.join(project, 'bot-fixture.cs')
  const executable = path.join(project, 'bot-fixture.exe')
  const escapedProject = project.replaceAll('"', '""')
  const program = [
    'using System;',
    'using System.IO;',
    'using System.Net.Http;',
    'using System.Net.Http.Headers;',
    'using System.Text;',
    'class BotFixture {',
    '  static string Clean(string value) {',
    '    return value.Replace("\\u001b[200~", "").Replace("\\u001b[201~", "").Replace("\\u001b[C", "");',
    '  }',
    '  static int Main(string[] args) {',
    '    Console.InputEncoding = new UTF8Encoding(false);',
    '    Console.OutputEncoding = new UTF8Encoding(false);',
    '    if (args.Length == 1 && args[0] == "--version") { Console.WriteLine("1.0.0 (Claude Code)"); return 0; }',
    '    bool bot = !String.IsNullOrEmpty(Environment.GetEnvironmentVariable("AIO_BOT_SESSION_ID"));',
    '    File.WriteAllText(Path.Combine(@"' + escapedProject + '", (bot ? "bot" : "worker") + "-started.txt"), String.Join("|", args), new UTF8Encoding(false));',
    ...(exposeTestCapability ? [
      '    if (bot) File.WriteAllLines(Path.Combine(@"' + escapedProject + '", "bot-control.fixture"), new[] {',
      '      Environment.GetEnvironmentVariable("AIO_BOT_API_URL"), Environment.GetEnvironmentVariable("AIO_BOT_CAPABILITY"),',
      '    }, new UTF8Encoding(false));',
    ] : []),
    '    int index = 0;',
    '    Console.Write("\\u001b[?2004h❯");',
    '    string line;',
    '    while ((line = Console.ReadLine()) != null) {',
    '      string text = Clean(line);',
    '      index++;',
    '      File.WriteAllText(Path.Combine(@"' + escapedProject + '", (bot ? "bot" : "worker") + "-input-" + index + ".txt"), text, new UTF8Encoding(false));',
    '      if (bot && text == "CREATE_WORKER") {',
    '        using (var client = new HttpClient()) {',
    '          client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", Environment.GetEnvironmentVariable("AIO_BOT_CAPABILITY"));',
    '          var content = new StringContent("{\\"agent\\":\\"claude\\"}", Encoding.UTF8, "application/json");',
    '          var response = client.PostAsync(Environment.GetEnvironmentVariable("AIO_BOT_API_URL") + "/v1/terminals", content).Result;',
    '          response.EnsureSuccessStatusCode();',
    '        }',
    '      }',
    '      Console.Write("❯");',
    '    }',
    '    return 0;',
    '  }',
    '}',
  ].join('\n')
  await fs.writeFile(source, program, 'utf8')
  const framework = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319')
  execFileSync(path.join(framework, 'csc.exe'), [
    '/nologo', '/target:exe', '/r:' + path.join(framework, 'System.Net.Http.dll'),
    '/out:' + executable, source,
  ], { windowsHide: true, stdio: 'pipe' })
  return executable
}

async function submit(window, frame, prompt) {
  const composer = frame.locator('.coding-cli-composer:visible').first()
  const textarea = composer.locator('textarea')
  await textarea.click()
  await window.keyboard.type(prompt)
  assert.equal(await textarea.inputValue(), prompt)
  await window.keyboard.press('Enter')
}

async function verifyBotUi(window, initialFrame, project) {
  const executable = await compileBotFixture(project)
  await prepareClaudeFixture(initialFrame, executable)
  const frame = await reopenWorkbench(window, initialFrame)
  const runtimePicker = frame.getByTestId('coding-runtime-select').getByRole('button').first()
  await runtimePicker.waitFor({ state: 'visible' })
  await runtimePicker.click()
  await frame.getByText('Claude Code', { exact: true }).last().click()
  const workerTab = frame.locator('.terminal-tab').filter({ hasText: /^Claude Code(?!_Bot)/ }).last()
  await workerTab.waitFor({ state: 'visible' })
  const selector = frame.locator('select[data-testid="bot-selector"]:visible').first()
  await selector.waitFor({ state: 'visible', timeout: 8000 }).catch(async error => {
    const plugins = await frame.evaluate(() => window.__TAURI__.core.invoke('desktop_request', {
      channel: 'coding-plugins:list', args: [],
    }))
    throw new Error('Bot selector unavailable: ' + JSON.stringify(plugins) + ' / ' + error.message)
  })
  assert.equal(await selector.inputValue(), 'none')
  assert.deepEqual(await selector.locator('option').evaluateAll(options => options.map(option => option.value)),
    ['none', 'omp', 'claude', 'codex'])

  await selector.selectOption('claude')
  const botTab = frame.locator('.terminal-tab').filter({ hasText: /Claude Code_Bot|claude_Bot/ }).first()
  await botTab.waitFor({ state: 'visible' })
  await waitFor(() => fs.stat(path.join(project, 'bot-started.txt')).catch(() => undefined), 'Bot process did not receive its session environment')
  assert.match(await frame.locator('.coding-cli-composer textarea:visible, .composer textarea:visible').first().getAttribute('placeholder'),
    /Claude Code Bot/)

  await workerTab.click()
  await submit(window, frame, 'CREATE_WORKER')
  await waitFor(() => fs.readFile(path.join(project, 'bot-input-1.txt'), 'utf8').catch(() => undefined),
    'Bottom prompt did not reach the Bot. Worker input: ' +
      String(await fs.readFile(path.join(project, 'worker-input-1.txt'), 'utf8').catch(() => 'none')) +
      '. UI error: ' + String(await frame.locator('.coding-cli-panel__error').textContent().catch(() => 'none')))
  assert.equal(await fs.readFile(path.join(project, 'bot-input-1.txt'), 'utf8'), 'CREATE_WORKER')
  await waitFor(async () => (await frame.locator('.terminal-tab').filter({ hasText: /^Claude Code(?!_Bot)/ }).count()) >= 2,
    'Bot-created worker tab did not appear')
  const createdWorkerTab = frame.locator('.terminal-tab').filter({ hasText: /^Claude Code(?!_Bot)/ }).last()
  await createdWorkerTab.click()
  await submit(window, frame, 'BOT_AFTER_WORKER_TAB')
  await waitFor(() => fs.readFile(path.join(project, 'bot-input-2.txt'), 'utf8').catch(() => undefined),
    'Prompt was not routed to the Bot while the Bot-created worker tab was active')
  assert.equal(await fs.readFile(path.join(project, 'bot-input-2.txt'), 'utf8'), 'BOT_AFTER_WORKER_TAB')
  assert.equal(await fs.stat(path.join(project, 'worker-input-1.txt')).catch(() => null), null)

  await selector.selectOption('none')
  await waitFor(() => botTab.count().then(count => count === 0), 'Bot tab did not close')
  return {
    defaultNoBot: true,
    allOptions: true,
    botLabel: true,
    composerTargetsBot: true,
    workerCreated: true,
    crossTabPromptTargetsBot: true,
    botClosed: true,
  }
}

module.exports = { compileBotFixture, verifyBotUi }
