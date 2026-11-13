import { createHash } from "node:crypto";

// Synthetic Claude Code 2.1.30x session files. The builder computes hashes and
// request digests with its own small implementation of the recorded algorithm
// (sorted-key compact JSON, SHA-256; string content as one text block and
// cache_control set at each path for the digest), so the restorer is checked
// against the format, not against itself.

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Msg = { role: string; content: Json; [key: string]: Json };

function canon(value: Json): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canon).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canon(value[key]!)}`).join(",")}}`;
}

export function sha(value: Json): string {
  return createHash("sha256").update(canon(value)).digest("hex");
}

export class SessionBuilder {
  private readonly lines: string[] = [];
  private readonly requestMessages = new Map<string, Msg[]>();
  private shape: { system: Json; tools: Json } | null = null;
  private shapeHash = "";
  readonly sessionId = "sess-1";

  private push(record: Record<string, Json>): void {
    this.lines.push(JSON.stringify({ sessionId: this.sessionId, ...record }));
  }

  /** Current byte length (what the index records as `offset`). */
  get offset(): number {
    return Buffer.byteLength(this.lines.map((line) => `${line}\n`).join(""));
  }

  setShape(system: Json, tools: Json): void {
    this.shape = { system, tools };
    this.shapeHash = sha(this.shape as Json);
    this.push({ type: "api-request-shape", shapeHash: this.shapeHash, timestamp: "2026-11-04T10:00:00.000Z", version: "2.1.304", shape: this.shape as Json });
  }

  user(content: Json, extra: Record<string, Json> = {}): Msg {
    const message: Msg = { role: "user", content };
    this.push({ type: "user", uuid: `u${this.lines.length}`, message, ...extra });
    return message;
  }

  /** One response block per record, as Claude Code writes them. */
  assistantBlock(requestRef: string, apiBlockIndex: number, block: Json, extra: Record<string, Json> = {}): void {
    this.push({
      type: "assistant",
      requestRef,
      apiBlockIndex,
      message: { id: `msg_${requestRef}`, role: "assistant", model: "claude-test", content: [block], usage: { input_tokens: 7, cache_creation_input_tokens: 3, cache_read_input_tokens: 90, output_tokens: 20 } },
      ...extra,
    });
  }

  blob(message: Msg): Msg {
    this.push({ type: "api-request-blob", hash: sha(message), message });
    return message;
  }

  raw(record: Record<string, Json>): void {
    this.push(record);
  }

  /**
   * An `api-request`: the messages are `base`'s first `keep` plus `tail`.
   * `digestOf` lets a test record the digest of a different body.
   */
  request(id: string, opts: { base?: string; keep?: number; tail: Msg[]; cacheControl?: { path: (string | number)[]; value: Json }[]; tailHashes?: string[] }): void {
    const keep = opts.keep ?? 0;
    const prefix = opts.base ? this.requestMessages.get(opts.base)!.slice(0, keep) : [];
    const messages = [...prefix, ...opts.tail];
    this.requestMessages.set(id, messages);
    const params = { model: "claude-test-model", max_tokens: 1000 };
    const cacheControl = opts.cacheControl ?? [];
    const body = JSON.parse(JSON.stringify({ ...params, system: this.shape!.system, tools: this.shape!.tools, messages })) as { messages: Msg[] };
    for (const message of body.messages) {
      if (typeof message.content === "string") message.content = [{ type: "text", text: message.content }];
    }
    for (const entry of cacheControl) {
      let node = body as unknown as Record<string | number, unknown>;
      for (const key of entry.path) node = node[key] as Record<string | number, unknown>;
      node.cache_control = entry.value;
    }
    this.push({
      type: "api-request",
      id,
      timestamp: `2026-11-04T10:0${this.requestMessages.size}:00.000Z`,
      version: "2.1.304",
      querySource: "sdk",
      shapeHash: this.shapeHash,
      params,
      ...(opts.base ? { base: opts.base } : {}),
      keep,
      tail: opts.tailHashes ?? opts.tail.map((message) => sha(message)),
      cacheControl: cacheControl as Json,
      requestDigest: sha(body as unknown as Json),
    });
  }

  buffer(): Buffer {
    return Buffer.from(this.lines.map((line) => `${line}\n`).join(""));
  }
}

export const SEND_1 = 'raft message send --target "#general" <<\'EOF\'\nplan\nEOF';

/** Two requests: R1 (a prompt) answered with a send; R2 (R1's messages + its response, tool result, two system blobs) answered with another send. */
export function twoRequestSession() {
  const s = new SessionBuilder();
  s.setShape(
    [{ type: "text", text: "You are a Raft agent." }, { type: "text", text: "Workspace rules." }],
    [{ name: "Bash", description: "Run a shell command", input_schema: { type: "object", properties: { command: { type: "string" } } } }],
  );
  const prompt = s.user("Post the plan to #general.");
  s.request("r1", { tail: [prompt] });
  // Written out of order: the restorer orders by apiBlockIndex. The stored
  // tool input differs from what was sent; the wire input wins.
  s.assistantBlock("r1", 1, { type: "text", text: "Posting it." });
  s.assistantBlock("r1", 0, { type: "thinking", thinking: "The user wants the plan.", signature: "sig" });
  s.assistantBlock("r1", 2, { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "(display form)" }, caller: { type: "direct" } }, { wireToolInputs: { toolu_1: { command: SEND_1 } } });
  const offsetAtSend1 = s.offset;
  const result = s.user([{ type: "tool_result", tool_use_id: "toolu_1", content: "Message sent to #general. Message ID: msg-1", is_error: false }]);
  const followUp = s.user([{ type: "text", text: "<system-reminder>a note</system-reminder>" }]);
  const reminder = s.blob({ role: "system", content: [{ type: "text", text: "The user is waiting." }] });
  const response1: Msg = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "The user wants the plan.", signature: "sig" },
      { type: "text", text: "Posting it." },
      { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: SEND_1 }, caller: { type: "direct" } },
    ],
  };
  const mergedUser: Msg = { role: "user", content: [...(result.content as Json[]), ...(followUp.content as Json[])] };
  // The same system message twice: a cache mark on the last must not appear on the first.
  s.request("r2", {
    base: "r1",
    keep: 1,
    tail: [response1, mergedUser, reminder, reminder],
    cacheControl: [{ path: ["system", 1], value: { type: "ephemeral" } }, { path: ["messages", 4, "content", 0], value: { type: "ephemeral", ttl: "1h" } }],
  });
  s.assistantBlock("r2", 0, { type: "tool_use", id: "toolu_2", name: "Bash", input: { command: "raft message send --target '#general' 'done'" } });
  s.user([{ type: "tool_result", tool_use_id: "toolu_2", content: [{ type: "text", text: "Message sent. Message ID: msg-2" }], is_error: false }]);
  return { s, offsetAtSend1 };
}
