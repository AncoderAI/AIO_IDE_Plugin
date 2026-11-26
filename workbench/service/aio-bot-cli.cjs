var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// C:/Users/beyon/AppData/Local/Temp/aio-bot-source-mD5KhF/research/tauri-spike/bot-cli.ts
var bot_cli_exports = {};
__export(bot_cli_exports, {
  parseBotCliArgs: () => parseBotCliArgs,
  requestBotControl: () => requestBotControl
});
module.exports = __toCommonJS(bot_cli_exports);
var HELP = `AIO Bot terminal controller

Usage:
  aio-bot list [--json]
  aio-bot create <omp|claude|codex> [--model <model-id>] [--stdin] [--json]
  aio-bot send <terminal-id> <prompt>|--stdin [--json]
  aio-bot close <terminal-id> [--json]
  aio-bot events [--wait <milliseconds>] [--json]
  aio-bot report <status> <summary> [--json]

Commands operate only on terminals owned by the current AIO Bot session.`;
function fail(message) {
  throw new Error(message);
}
function hasControlCharacter(value) {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}
function parseBotCliArgs(argv) {
  const values = [...argv];
  const jsonIndex = values.indexOf("--json");
  const json = jsonIndex >= 0;
  if (json) values.splice(jsonIndex, 1);
  if (values.includes("--help") || values.includes("-h") || values.length === 0) return { help: true };
  const command = values.shift();
  if (command === "list") {
    if (values.length) fail("list does not accept positional arguments");
    return { command, args: {}, json };
  }
  if (command === "create") {
    const stdinIndex = values.indexOf("--stdin");
    const stdin = stdinIndex >= 0;
    if (stdin) values.splice(stdinIndex, 1);
    const modelIndex = values.indexOf("--model");
    let model;
    if (modelIndex >= 0) {
      model = values[modelIndex + 1];
      if (!model || model.length > 256 || hasControlCharacter(model)) fail("create --model requires a valid model id");
      values.splice(modelIndex, 2);
    }
    const agent = values.shift();
    if (agent !== "omp" && agent !== "claude" && agent !== "codex") fail("create requires omp, claude, or codex");
    if (stdin && agent !== "codex") fail("create --stdin is supported only for Codex");
    if (values.length) fail("create accepts one agent name");
    return { command, args: { agent, ...model ? { model } : {}, ...stdin ? { stdin: true } : {} }, json };
  }
  if (command === "send") {
    const terminalId = values.shift();
    if (terminalId && values.length === 1 && values[0] === "--stdin") {
      return { command, args: { terminalId, stdin: true }, json };
    }
    const prompt = values.join(" ");
    if (!terminalId || !prompt) fail("send requires a terminal id and prompt");
    return { command, args: { terminalId, prompt }, json };
  }
  if (command === "close") {
    const terminalId = values.shift();
    if (!terminalId || values.length) fail("close requires one terminal id");
    return { command, args: { terminalId }, json };
  }
  if (command === "events") {
    const waitIndex = values.indexOf("--wait");
    let waitMs = 0;
    if (waitIndex >= 0) {
      const value = values[waitIndex + 1];
      if (!value || !/^\d+$/.test(value)) fail("events --wait requires a non-negative integer");
      waitMs = Number(value);
      if (waitMs > 25e3) fail("events --wait cannot exceed 25000 milliseconds");
      values.splice(waitIndex, 2);
    }
    if (values.length) fail("events accepts only --wait");
    return { command, args: { waitMs }, json };
  }
  if (command === "report") {
    const status = values.shift();
    const summary = values.join(" ");
    if (!status || !summary) fail("report requires a status and summary");
    if (status.length > 64) fail("report status is too long");
    return { command, args: { status, summary }, json };
  }
  fail(`Unknown command: ${command}`);
}
async function requestBotControl(baseUrl, token, parsed, timeoutMs = 1e4) {
  const terminalId = typeof parsed.args.terminalId === "string" ? encodeURIComponent(parsed.args.terminalId) : "";
  let path = "/v1/terminals";
  let method = "GET";
  let body;
  if (parsed.command === "create") {
    method = "POST";
    body = parsed.args;
  }
  if (parsed.command === "send") {
    path += `/${terminalId}/input`;
    method = "POST";
    body = { data: parsed.args.prompt };
  }
  if (parsed.command === "close") {
    path += `/${terminalId}`;
    method = "DELETE";
  }
  if (parsed.command === "events") path = `/v1/events?waitMs=${parsed.args.waitMs}`;
  if (parsed.command === "report") {
    path = "/v1/events";
    method = "POST";
    body = { status: parsed.args.status, summary: parsed.args.summary };
  }
  const response = await fetch(new URL(path, baseUrl), {
    method,
    headers: { authorization: `Bearer ${token}`, ...body ? { "content-type": "application/json" } : {} },
    body: body ? JSON.stringify(body) : void 0,
    signal: AbortSignal.timeout(parsed.command === "events" ? Math.max(timeoutMs, Number(parsed.args.waitMs) + 2e3) : timeoutMs)
  });
  const result = await response.json();
  if (!response.ok) fail(typeof result.error === "string" ? result.error : `AIO Bot control request failed (${response.status})`);
  return result;
}
function renderResult(value) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "terminalId" in value) {
    const result = value;
    return [result.terminalId, result.agent, result.label].filter(Boolean).join("	");
  }
  if (Array.isArray(value)) {
    return value.map((entry) => renderResult(entry)).join("\n");
  }
  return value === void 0 ? "ok" : JSON.stringify(value);
}
async function main() {
  const parsed = parseBotCliArgs(process.argv.slice(2));
  if ("help" in parsed) {
    process.stdout.write(`${HELP}
`);
    return;
  }
  const baseUrl = process.env.AIO_BOT_API_URL;
  const token = process.env.AIO_BOT_CAPABILITY;
  if (!baseUrl || !token) fail("This command must run inside an AIO Bot terminal");
  if ((parsed.command === "send" || parsed.command === "create") && parsed.args.stdin) {
    if (process.stdin.isTTY) fail(`Pipe UTF-8 task text to ${parsed.command} --stdin`);
    process.stdin.setEncoding("utf8");
    let prompt = "";
    for await (const chunk of process.stdin) {
      prompt += chunk;
      if (prompt.length > 64 * 1024) fail("Task text exceeds 64 KiB");
    }
    if (!prompt.trim()) fail("No task text on stdin");
    delete parsed.args.stdin;
    if (parsed.command === "create") parsed.args.initialPrompt = prompt;
    else parsed.args.prompt = prompt;
  }
  const result = await requestBotControl(baseUrl, token, parsed);
  process.stdout.write(`${parsed.json ? JSON.stringify(result) : renderResult(result)}
`);
}
if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`aio-bot: ${error instanceof Error ? error.message : String(error)}
`);
    process.exitCode = 1;
  });
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  parseBotCliArgs,
  requestBotControl
});
