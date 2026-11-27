// C:/Users/beyon/AppData/Local/Temp/aio-bot-source-rpTBQq/research/tauri-spike/omp-metadata-worker.ts
var import_node_worker_threads = require("node:worker_threads");

// C:/Users/beyon/AppData/Local/Temp/aio-bot-source-rpTBQq/electron/main/validation.ts
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// C:/Users/beyon/AppData/Local/Temp/aio-bot-source-rpTBQq/electron/main/sessions/bucketed.ts
var import_node_path = require("node:path");

// C:/Users/beyon/AppData/Local/Temp/aio-bot-source-rpTBQq/src/lib/transcript-fallbacks.ts
var DISCARDED_RETRY_FALLBACK = "The model discarded a failed attempt before finishing this turn.";

// C:/Users/beyon/AppData/Local/Temp/aio-bot-source-rpTBQq/electron/main/sessions/metadata.ts
var import_node_fs2 = require("node:fs");
var import_promises2 = require("node:fs/promises");

// C:/Users/beyon/AppData/Local/Temp/aio-bot-source-rpTBQq/electron/main/jsonl-limits.ts
var SESSION_FILE_RECORD_LIMIT_BYTES = 64 * 1024 * 1024;
var RPC_READ_FRAME_LIMIT_BYTES = 16 * 1024 * 1024;
var RPC_WRITE_FRAME_LIMIT_BYTES = 2 * 1024 * 1024;
var DAEMON_FRAME_LIMIT_BYTES = 1024 * 1024;

// C:/Users/beyon/AppData/Local/Temp/aio-bot-source-rpTBQq/electron/main/sessions/transcript.ts
var import_node_fs = require("node:fs");
var import_promises = require("node:fs/promises");

// C:/Users/beyon/AppData/Local/Temp/aio-bot-source-rpTBQq/electron/main/jsonl.ts
var import_node_string_decoder = require("node:string_decoder");
var MAX_UNFRAMED_BYTES = SESSION_FILE_RECORD_LIMIT_BYTES;
var FragmentedLineBuffer = class {
  constructor(maxUnframedBytes, recordName) {
    this.maxUnframedBytes = maxUnframedBytes;
    this.recordName = recordName;
  }
  fragments = [];
  bytes = 0;
  append(fragment, fragmentBytes) {
    if (!fragment && !fragmentBytes) return;
    if (this.bytes + fragmentBytes > this.maxUnframedBytes) this.tooLarge();
    if (fragment) this.fragments.push(fragment);
    this.bytes += fragmentBytes;
  }
  takeLine(fragment, fragmentBytes) {
    const totalBytes = this.bytes + fragmentBytes;
    if (totalBytes > this.maxUnframedBytes + 1) this.tooLarge();
    if (fragment) this.fragments.push(fragment);
    const line = this.fragments.join("");
    this.fragments = [];
    this.bytes = 0;
    const framed = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (totalBytes - Number(line.endsWith("\r")) > this.maxUnframedBytes) this.tooLarge();
    return framed;
  }
  finish() {
    if (!this.fragments.length) return void 0;
    const line = this.fragments.join("");
    this.fragments = [];
    this.bytes = 0;
    return line.endsWith("\r") ? line.slice(0, -1) : line;
  }
  tooLarge() {
    throw new Error(`${this.recordName} record exceeded the maximum frame size`);
  }
};
function* encodedLines(chunk, decoder, buffer) {
  let start = 0;
  while (true) {
    const index = chunk.indexOf(10, start);
    if (index < 0) break;
    yield buffer.takeLine(decoder.write(chunk.subarray(start, index)), index - start);
    start = index + 1;
  }
  const rest = chunk.subarray(start);
  buffer.append(decoder.write(rest), rest.length);
}
function asBuffer(chunk) {
  return typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
}
async function* strictJsonLines(stream, maxUnframedBytes = MAX_UNFRAMED_BYTES) {
  const decoder = new import_node_string_decoder.StringDecoder("utf8");
  const buffer = new FragmentedLineBuffer(maxUnframedBytes, "JSONL");
  for await (const raw of stream) {
    for (const line of encodedLines(asBuffer(raw), decoder, buffer)) yield line;
  }
  buffer.append(decoder.end(), 0);
  const finalLine = buffer.finish();
  if (finalLine !== void 0) yield finalLine;
}

// C:/Users/beyon/AppData/Local/Temp/aio-bot-source-rpTBQq/electron/main/sessions/transcript.ts
var MAX_TRANSCRIPT_GRAPH_BYTES = 16 * 1024 * 1024;
var MAX_TRANSCRIPT_GRAPH_RECORDS = 1e4;
var MAX_TRANSCRIPT_MESSAGES = 400;
var MAX_TRANSCRIPT_PARTS = 2e3;
var MAX_TRANSCRIPT_TEXT_CHARS = 1024 * 1024;
var MAX_TRANSCRIPT_TOOL_CHARS = 512 * 1024;
var MAX_TRANSCRIPT_ARGS_CHARS = 256 * 1024;
var MAX_TRANSCRIPT_IMAGE_CHARS = 2 * 1024 * 1024;
var MAX_PART_TEXT_CHARS = 256 * 1024;
var MAX_PART_TOOL_CHARS = 128 * 1024;
var MAX_PART_ARGS_CHARS = 128 * 1024;
var MAX_PART_IMAGE_CHARS = 2 * 1024 * 1024;
var MAX_PARTS_PER_RECORD = 200;
var TRUNCATION_MARKER = "\n\u2026 [truncated] \u2026\n";
function boundedString(value, max) {
  if (max <= 0) return "";
  if (value.length <= max) return value;
  if (max <= TRUNCATION_MARKER.length) return value.slice(-max);
  const available = max - TRUNCATION_MARKER.length;
  const head = Math.floor(available / 3);
  return `${value.slice(0, head)}${TRUNCATION_MARKER}${value.slice(-(available - head))}`;
}
function textFromContent(content, max = MAX_PART_TEXT_CHARS) {
  if (typeof content === "string") return boundedString(content, max);
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const part of content) {
    if (!isRecord(part)) continue;
    const addition = part.type === "text" && typeof part.text === "string" ? part.text : part.type === "thinking" && typeof part.thinking === "string" ? part.thinking : "";
    if (!addition) continue;
    text += `${text ? "\n" : ""}${addition}`;
    if (text.length > max) return boundedString(text, max);
  }
  return text;
}
function compactText(value, max = 160) {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}\u2026` : oneLine;
}
function customActivityName(value) {
  return value.split(/[_-]+/).filter(Boolean).map((word) => word.toLowerCase() === "ipython" ? "IPython" : `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`).join(" ") || "Activity";
}
function validTimestamp(value, fallback) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const timestamp = new Date(value);
    if (Number.isFinite(timestamp.getTime())) return timestamp.toISOString();
  }
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  return fallback;
}
function roleOf(message) {
  switch (message.role) {
    case "user":
      return "user";
    case "assistant":
      return "assistant";
    case "system":
      return "system";
    default:
      return "tool";
  }
}
function boundedArgs(value) {
  if (value === void 0) return void 0;
  try {
    const serialized = typeof value === "string" ? value : JSON.stringify(value);
    return serialized.length <= MAX_PART_ARGS_CHARS ? value : boundedString(serialized, MAX_PART_ARGS_CHARS);
  } catch {
    return "[unserializable arguments]";
  }
}
function partsFromMessage(message) {
  const content = message.content;
  const parts = [];
  if (typeof content === "string") parts.push({ type: "text", text: boundedString(content, MAX_PART_TEXT_CHARS) });
  else if (Array.isArray(content)) {
    const selected = content.length <= MAX_PARTS_PER_RECORD ? content : [...content.slice(0, 20), ...content.slice(-(MAX_PARTS_PER_RECORD - 20))];
    for (const raw of selected) {
      if (!isRecord(raw) || typeof raw.type !== "string") continue;
      if (raw.type === "text" && typeof raw.text === "string") parts.push({ type: "text", text: boundedString(raw.text, MAX_PART_TEXT_CHARS) });
      else if (raw.type === "thinking" && typeof raw.thinking === "string") parts.push({ type: "thinking", text: boundedString(raw.thinking, MAX_PART_TEXT_CHARS) });
      else if ((raw.type === "toolCall" || raw.type === "tool_call") && typeof raw.name === "string") {
        parts.push({
          type: "toolCall",
          id: typeof raw.id === "string" ? boundedString(raw.id, 1024) : void 0,
          name: boundedString(raw.name, 512),
          args: boundedArgs(raw.arguments ?? raw.args)
        });
      } else if (raw.type === "image") {
        parts.push({
          type: "image",
          mimeType: typeof raw.mimeType === "string" ? boundedString(raw.mimeType, 128) : void 0,
          data: typeof raw.data === "string" ? boundedString(raw.data, MAX_PART_IMAGE_CHARS) : void 0,
          dataTruncated: typeof raw.data === "string" && raw.data.length > MAX_PART_IMAGE_CHARS || void 0
        });
      }
    }
  }
  if (message.role === "toolResult" || message.role === "tool") {
    const text = parts.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    return [{
      type: "toolResult",
      name: typeof message.toolName === "string" ? boundedString(message.toolName, 512) : void 0,
      text: boundedString(text, MAX_PART_TOOL_CHARS),
      isError: message.isError === true
    }];
  }
  if (message.role === "bashExecution") {
    return [{
      type: "toolResult",
      name: "bash",
      text: typeof message.output === "string" ? boundedString(message.output, MAX_PART_TOOL_CHARS) : "",
      isError: typeof message.exitCode === "number" && message.exitCode !== 0
    }];
  }
  return parts.length ? parts : [{ type: "text", text: "" }];
}
function boundedTranscript(transcript) {
  let textBudget = MAX_TRANSCRIPT_TEXT_CHARS;
  let toolBudget = MAX_TRANSCRIPT_TOOL_CHARS;
  let argsBudget = MAX_TRANSCRIPT_ARGS_CHARS;
  let imageBudget = MAX_TRANSCRIPT_IMAGE_CHARS;
  let partBudget = MAX_TRANSCRIPT_PARTS;
  const bounded = [];
  for (const message of transcript.slice(-MAX_TRANSCRIPT_MESSAGES).reverse()) {
    const parts = [];
    for (const part of [...message.parts].reverse()) {
      if (partBudget <= 0) break;
      let next;
      if (part.type === "text" || part.type === "thinking" || part.type === "agentMessage") {
        if (textBudget > 0) {
          const text = boundedString(part.text, textBudget);
          textBudget -= text.length;
          next = part.type === "agentMessage" ? { ...part, text, agentName: part.agentName ? boundedString(part.agentName, 200) : void 0 } : { ...part, text };
        }
      } else if (part.type === "toolResult") {
        if (toolBudget > 0) {
          const text = boundedString(part.text, toolBudget);
          toolBudget -= text.length;
          next = { ...part, text };
        }
      } else if (part.type === "toolCall") {
        let args;
        if (part.args !== void 0 && argsBudget > 0) {
          const serialized = typeof part.args === "string" ? part.args : JSON.stringify(part.args);
          if (serialized.length <= argsBudget) args = part.args;
          else args = boundedString(serialized, argsBudget);
          argsBudget -= Math.min(serialized.length, argsBudget);
        }
        next = { ...part, args };
      } else if (part.type === "compaction") {
        const boundedText = (value) => {
          if (!value || textBudget <= 0) return void 0;
          const text = boundedString(value, textBudget);
          textBudget -= text.length;
          return text;
        };
        next = {
          ...part,
          summary: boundedText(part.summary),
          error: boundedText(part.error),
          customInstructions: boundedText(part.customInstructions)
        };
      } else if (part.type === "image") {
        let data;
        if (part.data && imageBudget > 0) {
          data = boundedString(part.data, imageBudget);
          imageBudget -= Math.min(part.data.length, imageBudget);
        }
        next = { ...part, data, dataTruncated: part.dataTruncated || Boolean(part.data && data !== part.data) || void 0 };
      }
      if (next) {
        parts.push(next);
        partBudget -= 1;
      }
    }
    if (parts.length) bounded.push({ ...message, parts: parts.reverse() });
  }
  return bounded.reverse();
}
var primeTranscriptDialect = {
  isRenderable: (entry) => entry.type === "message" || entry.type === "compaction" || entry.type === "custom_message" && entry.display === true
};
function createTranscriptReader(dialect = primeTranscriptDialect) {
  return (filePath, isStreaming) => readTranscriptWithDialect(dialect, filePath, isStreaming);
}
async function readTranscriptWithDialect(dialect, filePath, isStreaming) {
  if ((await (0, import_promises.stat)(filePath)).size > 256 * 1024 * 1024) throw new Error("Session transcript is too large to display");
  const entries = /* @__PURE__ */ new Map();
  const parentEdges = /* @__PURE__ */ new Map();
  let graphBytes = 0;
  let leafId = null;
  let recordCount = 0;
  for await (const line of strictJsonLines((0, import_node_fs.createReadStream)(filePath), SESSION_FILE_RECORD_LIMIT_BYTES)) {
    if (!line) continue;
    if (++recordCount > 2e5) throw new Error("Session transcript has too many records");
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(entry) || entry.type === "session" || typeof entry.id !== "string" || entry.id.length > 1024) continue;
    const parentId = typeof entry.parentId === "string" && entry.parentId.length <= 1024 ? entry.parentId : null;
    parentEdges.delete(entry.id);
    parentEdges.set(entry.id, parentId);
    while (parentEdges.size > MAX_TRANSCRIPT_GRAPH_RECORDS * 4) {
      const oldestEdge = parentEdges.keys().next().value;
      if (oldestEdge === void 0) break;
      parentEdges.delete(oldestEdge);
    }
    if (!dialect.isRenderable(entry)) continue;
    const existing = entries.get(entry.id);
    if (existing) {
      graphBytes -= existing.bytes;
      entries.delete(entry.id);
    }
    const bytes = Buffer.byteLength(line, "utf8");
    entries.set(entry.id, { id: entry.id, parentId, entry, bytes });
    graphBytes += bytes;
    leafId = entry.id;
    while (entries.size > MAX_TRANSCRIPT_GRAPH_RECORDS || graphBytes > MAX_TRANSCRIPT_GRAPH_BYTES) {
      const oldestId = entries.keys().next().value;
      if (oldestId === void 0) break;
      graphBytes -= entries.get(oldestId)?.bytes ?? 0;
      entries.delete(oldestId);
    }
  }
  const walkBranch = (startId) => {
    const collected = [];
    const visited = /* @__PURE__ */ new Set();
    let currentId = startId;
    while (currentId && !visited.has(currentId)) {
      visited.add(currentId);
      const node = entries.get(currentId);
      if (node) collected.push(node);
      currentId = parentEdges.get(currentId) ?? null;
    }
    return collected;
  };
  let branch = walkBranch(leafId);
  if (!branch.length && entries.size) {
    let fallbackId = null;
    for (const id of entries.keys()) fallbackId = id;
    branch = walkBranch(fallbackId);
  }
  branch.reverse();
  const transcript = [];
  let activeAssistant;
  let toolCallIndexById = /* @__PURE__ */ new Map();
  const beginAssistantTurn = () => {
    toolCallIndexById = /* @__PURE__ */ new Map();
  };
  const registerToolCalls = (startIndex, added) => {
    for (let offset = 0; offset < added.length; offset += 1) {
      const part = added[offset];
      if (part.type === "toolCall" && part.id !== void 0 && !toolCallIndexById.has(part.id)) {
        toolCallIndexById.set(part.id, startIndex + offset);
      }
    }
  };
  const appendAssistantParts = (added) => {
    if (!activeAssistant) return;
    registerToolCalls(activeAssistant.parts.length, added);
    activeAssistant.parts.push(...added);
  };
  for (const { id, entry } of branch) {
    const safeId = boundedString(id, 1024);
    if (entry.type === "compaction") {
      const timestamp2 = typeof entry.timestamp === "string" ? boundedString(entry.timestamp, 128) : void 0;
      const tokensBefore = typeof entry.tokensBefore === "number" && Number.isFinite(entry.tokensBefore) && entry.tokensBefore >= 0 ? entry.tokensBefore : void 0;
      const summary = typeof entry.summary === "string" ? boundedString(entry.summary, MAX_PART_TEXT_CHARS) : void 0;
      const firstKeptEntryId = typeof entry.firstKeptEntryId === "string" ? boundedString(entry.firstKeptEntryId, 1024) : void 0;
      const customInstructions = typeof entry.customInstructions === "string" ? boundedString(entry.customInstructions, MAX_PART_TEXT_CHARS) : void 0;
      transcript.push({
        id: safeId,
        role: "system",
        timestamp: timestamp2,
        startedAt: timestamp2,
        completedAt: timestamp2,
        parts: [{ type: "compaction", status: "done", tokensBefore, summary, firstKeptEntryId, customInstructions }]
      });
      activeAssistant = void 0;
      continue;
    }
    if (entry.type === "custom_message") {
      const details = isRecord(entry.details) ? entry.details : void 0;
      const from = isRecord(details?.from) ? details.from : void 0;
      const customType = typeof entry.customType === "string" ? boundedString(entry.customType, 200) : "activity";
      if (customType === "compaction_outcome") {
        const outcome = details?.outcome === "cancelled" ? "cancelled" : details?.outcome === "skipped" ? "skipped" : "failed";
        const reason = details?.reason === "manual" || details?.reason === "threshold" || details?.reason === "overflow" || details?.reason === "requested" ? details.reason : void 0;
        const timestamp3 = typeof entry.timestamp === "string" ? boundedString(entry.timestamp, 128) : void 0;
        const text2 = boundedString(textFromContent(entry.content), MAX_PART_TEXT_CHARS);
        transcript.push({
          id: safeId,
          role: "system",
          timestamp: timestamp3,
          startedAt: timestamp3,
          completedAt: timestamp3,
          parts: [{ type: "compaction", status: outcome === "cancelled" ? "cancelled" : "failed", outcome, reason, error: text2 }]
        });
        activeAssistant = void 0;
        continue;
      }
      const isAgentMessage = customType === "agent_message";
      const isGoalSummary = customType === "goal_context";
      const detailMessage = typeof details?.message === "string" ? details.message : void 0;
      const goalObjective = typeof details?.objective === "string" ? details.objective : void 0;
      const agentName = typeof from?.sessionName === "string" ? boundedString(from.sessionName, 200) : void 0;
      const readableText = isGoalSummary ? goalObjective ?? detailMessage : detailMessage;
      const text = boundedString(readableText ?? textFromContent(entry.content), MAX_PART_TEXT_CHARS);
      const timestamp2 = typeof entry.timestamp === "string" ? boundedString(entry.timestamp, 128) : void 0;
      if (isAgentMessage && activeAssistant) {
        appendAssistantParts([{ type: "agentMessage", text, agentName }]);
        activeAssistant.completedAt = timestamp2 ?? activeAssistant.completedAt;
      } else if (!isAgentMessage && !isGoalSummary && activeAssistant) {
        const name = customActivityName(customType);
        appendAssistantParts([{ type: "toolCall", id: safeId, name }, { type: "toolResult", name, text }]);
        activeAssistant.completedAt = timestamp2 ?? activeAssistant.completedAt;
      } else {
        const name = customActivityName(customType);
        transcript.push({
          id: safeId,
          role: isAgentMessage ? "agent" : isGoalSummary ? "goal" : "tool",
          timestamp: timestamp2,
          agentName: isAgentMessage ? agentName : void 0,
          parts: isAgentMessage || isGoalSummary ? [{ type: "text", text }] : [{ type: "toolCall", id: safeId, name }, { type: "toolResult", name, text }]
        });
        activeAssistant = void 0;
      }
      continue;
    }
    if (entry.type !== "message") {
      const rendered = dialect.renderEntry?.(entry, safeId);
      if (rendered) transcript.push(rendered);
      activeAssistant = void 0;
      continue;
    }
    const message = isRecord(entry.message) ? entry.message : {};
    const role = roleOf(message);
    const entryTimestamp = typeof entry.timestamp === "string" ? boundedString(entry.timestamp, 128) : void 0;
    const rawTimestamp = typeof message.timestamp === "string" || typeof message.timestamp === "number" ? message.timestamp : entryTimestamp;
    const timestamp = typeof rawTimestamp === "string" ? boundedString(rawTimestamp, 128) : rawTimestamp;
    const completedAt = entryTimestamp ?? timestamp;
    const parts = partsFromMessage(message);
    if (role === "tool" && activeAssistant) {
      const toolCallId = typeof message.toolCallId === "string" ? boundedString(message.toolCallId, 1024) : void 0;
      const callIndex = toolCallId !== void 0 ? toolCallIndexById.get(toolCallId) ?? -1 : -1;
      if (callIndex >= 0) {
        activeAssistant.parts.splice(callIndex + 1, 0, ...parts);
        for (const [callId, index] of toolCallIndexById) {
          if (index > callIndex) toolCallIndexById.set(callId, index + parts.length);
        }
        registerToolCalls(callIndex + 1, parts);
      } else appendAssistantParts(parts);
      activeAssistant.completedAt = completedAt ?? activeAssistant.completedAt;
      continue;
    }
    if (role === "assistant") {
      if (activeAssistant) {
        appendAssistantParts(parts);
        activeAssistant.completedAt = completedAt ?? activeAssistant.completedAt;
      } else {
        beginAssistantTurn();
        registerToolCalls(0, parts);
        activeAssistant = { id: safeId, role, timestamp, startedAt: timestamp, completedAt, parts };
        transcript.push(activeAssistant);
      }
      continue;
    }
    const item = { id: safeId, role, timestamp, parts };
    transcript.push(item);
    activeAssistant = void 0;
  }
  if (isStreaming && activeAssistant) {
    activeAssistant.streaming = true;
    activeAssistant.completedAt = void 0;
  }
  return boundedTranscript(transcript);
}
var readTranscript = createTranscriptReader();

// C:/Users/beyon/AppData/Local/Temp/aio-bot-source-rpTBQq/electron/main/sessions/metadata.ts
var MAX_SESSION_FILE_BYTES = 256 * 1024 * 1024;
var MAX_METADATA_RECORDS = 2e5;
var MAX_METADATA_RECORD_BYTES = SESSION_FILE_RECORD_LIMIT_BYTES;
var MAX_TRACKED_METADATA_STATES = 5e3;
var METADATA_VERIFY_TAIL_BYTES = 4096;
var LINE_FEED = 10;
var CARRIAGE_RETURN = 13;
function statusFrom(taskState, lifecycle, lastRole, stopReason) {
  if (lifecycle === "crash") return "failed";
  if (lifecycle === "archived") return "complete";
  if (taskState === "completed") return "complete";
  if (taskState === "needs_input") return "waiting";
  if (stopReason === "error") return "failed";
  if (lastRole === "assistant" || lastRole === "toolResult") return "complete";
  if (lastRole === "user") return "idle";
  return "unknown";
}
function ingestMessageActivity(state, record) {
  if (!isRecord(record.message)) return;
  const message = record.message;
  if (typeof message.role === "string") state.lastRole = message.role;
  if (typeof message.stopReason === "string") state.stopReason = message.stopReason;
  const text = textFromContent(message.content, 4096);
  if (message.role === "user") {
    if (!state.firstUser && text) state.firstUser = text;
    state.lastUserMessageAt = validTimestamp(message.timestamp, validTimestamp(record.timestamp, state.lastUserMessageAt ?? state.createdAt));
  }
  if ((message.role === "assistant" || message.role === "user") && text) state.preview = text;
}
var nodeMetadataReaderIo = {
  inspect: import_promises2.stat,
  openStream: (path, start, end) => (0, import_node_fs2.createReadStream)(path, { start, end })
};
function trimTrailingCarriageReturn(line) {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}
function lastBytes(data, max) {
  return data.length <= max ? data : Buffer.from(data.subarray(data.length - max));
}
function ingestBytes(parser, state, bytes) {
  state.tail = state.tail.length + bytes.length <= METADATA_VERIFY_TAIL_BYTES ? Buffer.concat([state.tail, bytes]) : lastBytes(bytes.length >= METADATA_VERIFY_TAIL_BYTES ? bytes : Buffer.concat([state.tail, bytes]), METADATA_VERIFY_TAIL_BYTES);
  const data = state.pending.length ? Buffer.concat([state.pending, bytes]) : bytes;
  let start = 0;
  while (true) {
    const newline = data.indexOf(LINE_FEED, start);
    if (newline < 0) break;
    if (newline - start > MAX_METADATA_RECORD_BYTES) throw new Error("JSONL record exceeded the maximum frame size");
    const end = newline > start && data[newline - 1] === CARRIAGE_RETURN ? newline - 1 : newline;
    parser.ingestLine(state.accumulator, data.toString("utf8", start, end));
    start = newline + 1;
  }
  const rest = data.subarray(start);
  if (rest.length > MAX_METADATA_RECORD_BYTES) throw new Error("JSONL record exceeded the maximum frame size");
  state.pending = Buffer.from(rest);
}
function snapshotState(parser, state, filePath, fallbackUpdated) {
  if (!state.pending.length) return parser.snapshot(state.accumulator, filePath, fallbackUpdated);
  const speculative = { ...state.accumulator };
  parser.ingestLine(speculative, trimTrailingCarriageReturn(state.pending.toString("utf8")));
  return parser.snapshot(speculative, filePath, fallbackUpdated);
}
async function ingestRange(io, parser, state, filePath, start, end) {
  if (end <= start) {
    state.size = end;
    return;
  }
  const stream = io.openStream(filePath, start, end - 1);
  try {
    for await (const chunk of stream) {
      ingestBytes(parser, state, typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
    }
  } finally {
    stream.destroy();
  }
  state.size = end;
}
function createIncrementalMetadataReader(parser, io = nodeMetadataReaderIo, reservedHeaderBytes = 0) {
  const states = /* @__PURE__ */ new Map();
  const locks = /* @__PURE__ */ new Map();
  const remember = (filePath, state) => {
    states.delete(filePath);
    states.set(filePath, state);
    while (states.size > MAX_TRACKED_METADATA_STATES) {
      const oldest = states.keys().next().value;
      if (oldest === void 0) break;
      states.delete(oldest);
    }
  };
  const fullRead = async (filePath, fileStat) => {
    const state = {
      size: 0,
      mtimeMs: fileStat.mtimeMs,
      pending: Buffer.alloc(0),
      tail: Buffer.alloc(0),
      accumulator: parser.createAccumulator(filePath, fileStat)
    };
    await ingestRange(io, parser, state, filePath, Math.min(reservedHeaderBytes, fileStat.size), fileStat.size);
    remember(filePath, state);
    return snapshotState(parser, state, filePath, fileStat.mtime.toISOString());
  };
  const perform = async (filePath, knownStat) => {
    let fileStat;
    try {
      fileStat = knownStat ?? await io.inspect(filePath);
    } catch (error) {
      states.delete(filePath);
      throw error;
    }
    if (fileStat.size > MAX_SESSION_FILE_BYTES) {
      states.delete(filePath);
      throw new Error("Session file is too large");
    }
    const state = states.get(filePath);
    if (state && fileStat.size === state.size && fileStat.mtimeMs === state.mtimeMs) {
      remember(filePath, state);
      return snapshotState(parser, state, filePath, fileStat.mtime.toISOString());
    }
    if (state && fileStat.size > state.size) {
      try {
        const verified = state.tail;
        const verifyStart = state.size - verified.length;
        const resumed = {
          size: state.size,
          mtimeMs: fileStat.mtimeMs,
          pending: state.pending,
          tail: state.tail,
          accumulator: { ...state.accumulator }
        };
        let verifiedBytes = 0;
        let mismatch = false;
        const stream = io.openStream(filePath, verifyStart, fileStat.size - 1);
        try {
          for await (const raw of stream) {
            let chunk = typeof raw === "string" ? Buffer.from(raw, "utf8") : raw;
            if (verifiedBytes < verified.length) {
              const compare = Math.min(verified.length - verifiedBytes, chunk.length);
              if (!chunk.subarray(0, compare).equals(verified.subarray(verifiedBytes, verifiedBytes + compare))) {
                mismatch = true;
                break;
              }
              verifiedBytes += compare;
              chunk = chunk.subarray(compare);
            }
            if (chunk.length) ingestBytes(parser, resumed, chunk);
          }
        } finally {
          stream.destroy();
        }
        if (!mismatch && verifiedBytes === verified.length) {
          resumed.size = fileStat.size;
          remember(filePath, resumed);
          return snapshotState(parser, resumed, filePath, fileStat.mtime.toISOString());
        }
      } catch (error) {
        if (error instanceof Error && (error.message === "Session file has too many records" || error.message === "JSONL record exceeded the maximum frame size")) {
          states.delete(filePath);
          throw error;
        }
      }
    }
    try {
      return await fullRead(filePath, fileStat);
    } catch (error) {
      states.delete(filePath);
      throw error;
    }
  };
  return (filePath, knownStat) => {
    const previous = locks.get(filePath) ?? Promise.resolve();
    const run = previous.then(() => perform(filePath, knownStat), () => perform(filePath, knownStat));
    const settled = run.then(() => void 0, () => void 0);
    locks.set(filePath, settled);
    void settled.then(() => {
      if (locks.get(filePath) === settled) locks.delete(filePath);
    });
    return run;
  };
}

// C:/Users/beyon/AppData/Local/Temp/aio-bot-source-rpTBQq/electron/main/sessions/bucketed.ts
var BUCKETED_SESSION_FILE_NAME = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z_[0-9a-f][0-9a-f-]*\.jsonl$/i;
function timestampFromBucketedSessionName(name) {
  const file = name.slice(name.lastIndexOf("/") + 1);
  const match = BUCKETED_SESSION_FILE_NAME.exec(file);
  if (!match) return void 0;
  const parsed = Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`);
  return Number.isFinite(parsed) ? parsed : void 0;
}
function idFromBucketedFileName(filePath) {
  const base = (0, import_node_path.basename)(filePath, ".jsonl");
  const separator = base.indexOf("_");
  return separator >= 0 ? base.slice(separator + 1) : base;
}
function createBucketedAccumulator(filePath, fileStat) {
  const nameTimestamp = timestampFromBucketedSessionName((0, import_node_path.basename)(filePath));
  return {
    id: idFromBucketedFileName(filePath),
    projectPath: "",
    createdAt: nameTimestamp !== void 0 ? new Date(nameTimestamp).toISOString() : fileStat.birthtime.toISOString(),
    updatedAt: fileStat.mtime.toISOString(),
    sawRecordTimestamp: false,
    firstUser: "",
    preview: "",
    records: 0
  };
}
function bucketedMetadataFromAccumulator(state, filePath, fallbackUpdated) {
  return {
    id: state.id,
    filePath,
    projectPath: state.projectPath,
    title: compactText(state.displayName ?? "", 100) || compactText(state.firstUser, 100) || "Untitled session",
    createdAt: state.createdAt,
    updatedAt: state.sawRecordTimestamp ? state.updatedAt : fallbackUpdated,
    lastUserMessageAt: state.lastUserMessageAt ?? state.createdAt,
    status: statusFrom(void 0, void 0, state.lastRole, state.stopReason),
    model: state.model,
    provider: state.provider,
    thinkingLevel: state.thinkingLevel,
    depth: 0,
    pinned: false,
    unread: false,
    preview: compactText(state.preview || state.firstUser)
  };
}
function createBucketedMetadataParser(ingestRecord) {
  return {
    createAccumulator: createBucketedAccumulator,
    ingestLine: (state, line) => {
      if (!line) return;
      if (++state.records > MAX_METADATA_RECORDS) throw new Error("Session file has too many records");
      let value;
      try {
        value = JSON.parse(line);
      } catch {
        return;
      }
      if (!isRecord(value)) return;
      const recordTimestamp = validTimestamp(value.timestamp, "");
      if (recordTimestamp) {
        state.updatedAt = recordTimestamp;
        state.sawRecordTimestamp = true;
      }
      if (value.type === "session") {
        if (typeof value.id === "string") state.id = value.id;
        if (typeof value.cwd === "string") state.projectPath = value.cwd;
        state.createdAt = validTimestamp(value.timestamp, state.createdAt);
      } else if (value.type === "thinking_level_change" && typeof value.thinkingLevel === "string") state.thinkingLevel = value.thinkingLevel;
      else if (value.type === "message") ingestMessageActivity(state, value);
      else ingestRecord(state, value);
    },
    snapshot: bucketedMetadataFromAccumulator
  };
}
function createBranchSummaryTranscriptReader() {
  return createTranscriptReader({
    isRenderable: (entry) => entry.type === "message" || entry.type === "compaction" || entry.type === "branch_summary" || entry.type === "custom_message" && entry.display === true,
    renderEntry: (entry, safeId) => {
      if (entry.type !== "branch_summary") return void 0;
      const timestamp = typeof entry.timestamp === "string" ? boundedString(entry.timestamp, 128) : void 0;
      const details = isRecord(entry.details) ? entry.details : void 0;
      const summary = typeof entry.summary === "string" ? entry.summary.trim() : "";
      const text = summary || (details?.kind === "discarded-entry-branch" ? DISCARDED_RETRY_FALLBACK : textFromContent(entry.content, MAX_PART_TEXT_CHARS).trim());
      if (!text) return void 0;
      return {
        id: safeId,
        role: "system",
        timestamp,
        startedAt: timestamp,
        completedAt: timestamp,
        parts: [{ type: "text", text: boundedString(text, MAX_PART_TEXT_CHARS) }]
      };
    }
  });
}

// C:/Users/beyon/AppData/Local/Temp/aio-bot-source-rpTBQq/electron/main/sessions/omp.ts
var OMP_TITLE_SLOT_BYTES = 256;
var ompMetadataParser = createBucketedMetadataParser((state, value) => {
  if (value.type === "model_change" && typeof value.model === "string") {
    if (value.role === void 0 || value.role === "default") {
      const separator = value.model.indexOf("/");
      state.provider = separator > 0 ? value.model.slice(0, separator) : void 0;
      state.model = separator > 0 ? value.model.slice(separator + 1) : value.model;
    }
  } else if ((value.type === "title_change" || value.type === "title") && typeof value.title === "string") {
    state.displayName = value.title;
  }
});
async function readOmpTitleSlot(io, filePath) {
  const stream = io.openStream(filePath, 0, OMP_TITLE_SLOT_BYTES - 1);
  const chunks = [];
  try {
    for await (const chunk of stream) chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
  } finally {
    stream.destroy();
  }
  const slot = Buffer.concat(chunks);
  const newline = slot.indexOf(10);
  if (newline < 0) return void 0;
  let value;
  try {
    value = JSON.parse(slot.toString("utf8", 0, newline));
  } catch {
    return void 0;
  }
  if (!isRecord(value) || value.type !== "title" || typeof value.title !== "string" || !value.title.trim()) return void 0;
  return value.title;
}
function createOmpSessionMetadataReader(io = nodeMetadataReaderIo) {
  const readTail = createIncrementalMetadataReader(ompMetadataParser, io, OMP_TITLE_SLOT_BYTES);
  return async (filePath, knownStat) => {
    const [metadata, title] = await Promise.all([readTail(filePath, knownStat), readOmpTitleSlot(io, filePath)]);
    if (title !== void 0) metadata.title = compactText(title, 100);
    return metadata;
  };
}
var readOmpTranscript = createBranchSummaryTranscriptReader();

// C:/Users/beyon/AppData/Local/Temp/aio-bot-source-rpTBQq/research/tauri-spike/omp-metadata-worker.ts
var port = import_node_worker_threads.parentPort;
if (!port) throw new Error("OMP metadata worker requires a parent port");
var read = createOmpSessionMetadataReader();
port.on("message", async ({ id, path }) => {
  try {
    const metadata = await read(path);
    port.postMessage({ id, metadata });
  } catch (error) {
    port.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
});
