import { scrubText } from "./service";

/** First-pass labels: cheap and per message. Loops are judged per thread in the second pass. */
export const TRIAGE_LABELS = ["frustration", "correction", "self_retract", "failure", "unclear"] as const;
export type TriageLabel = typeof TRIAGE_LABELS[number];
export type TriageMessage = { id: string; createdAt: Date; sender: string | null; senderKind: "human" | "agent"; content: string };
/** One conversation unit: a top-level message with its replies, never split across batches unless it alone exceeds a batch. */
export type TriageThread = { target: string; messages: TriageMessage[] };
export type TriageBatch = { text: string; messages: Map<string, { id: string; target: string }> };
export type TriageLabelRecord = { messageId: string; target: string; label: TriageLabel; why: string };

const MAX_BODY_CHARS = 1_200;
// Haiku's base price holds only below 100k input tokens; keep headroom for the prompt.
export const TRIAGE_BATCH_TOKENS = 88_000;
/** Deliberately high: CJK can cost more than one token per character; line prefixes, logs and code about 0.4–0.5 per ASCII character. */
export function estimateTokens(text: string): number {
  let tokens = 0;
  for (const char of text) tokens += char.charCodeAt(0) < 128 ? 0.5 : 1.5;
  return Math.ceil(tokens);
}

function line(message: TriageMessage): string {
  const body = scrubText(message.content).replace(/\r?\n/g, " ⏎ ");
  const bounded = body.length > MAX_BODY_CHARS ? `${body.slice(0, MAX_BODY_CHARS)}…[truncated]` : body;
  const at = message.createdAt.toISOString();
  return `[${message.id.slice(0, 8)}] ${at.slice(5, 10)} ${at.slice(11, 16)} @${message.sender ?? "unknown"} (${message.senderKind}): ${bounded}`;
}

/** Whole threads per batch; an oversized thread continues in the next batch under a repeated header. */
export function packTriageBatches(threads: TriageThread[], max = TRIAGE_BATCH_TOKENS, measure = estimateTokens): TriageBatch[] {
  const batches: TriageBatch[] = [];
  let lines: string[] = [], size = 0, messages: TriageBatch["messages"] = new Map();
  const flush = () => { if (lines.length) batches.push({ text: lines.join("\n"), messages }); lines = []; size = 0; messages = new Map(); };
  for (const thread of threads) {
    if (!thread.messages.length) continue;
    const rendered = thread.messages.map(message => ({ message, text: line(message) }));
    const header = (part: number) => `=== thread ${thread.target} (${thread.messages.length} msgs${part ? `, continued ${part + 1}` : ""})`;
    const cost = (text: string) => measure(text) + 1;
    const whole = cost(header(0)) + rendered.reduce((sum, item) => sum + cost(item.text), 0);
    if (size && size + whole > max) flush();
    let part = 0;
    lines.push(header(part)); size += cost(header(part));
    for (const item of rendered) {
      if (size + cost(item.text) > max && messages.size) {
        flush(); part += 1;
        lines.push(header(part)); size += cost(header(part));
      }
      lines.push(item.text); size += cost(item.text);
      messages.set(item.message.id, { id: item.message.id, target: thread.target });
    }
  }
  flush();
  return batches;
}

/** Keep only well-formed labels whose short ID names exactly one message of this batch. */
export function parseTriageOutput(output: string, batch: TriageBatch) {
  const byShort = new Map<string, { id: string; target: string } | null>();
  for (const message of batch.messages.values()) {
    const short = message.id.slice(0, 8);
    byShort.set(short, byShort.has(short) ? null : message);
  }
  const labels: TriageLabelRecord[] = [];
  const seen = new Set<string>();
  let rejected = 0;
  for (const raw of output.split("\n")) {
    const text = raw.trim();
    if (!text.startsWith("{")) continue;
    let value: unknown;
    try { value = JSON.parse(text); } catch { rejected += 1; continue; }
    const record = value as { id?: unknown; label?: unknown; why?: unknown };
    const message = typeof record.id === "string" ? byShort.get(record.id.slice(0, 8)) : undefined;
    if (!message || !TRIAGE_LABELS.includes(record.label as TriageLabel)) { rejected += 1; continue; }
    const key = `${message.id}:${record.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    labels.push({ messageId: message.id, target: message.target, label: record.label as TriageLabel, why: typeof record.why === "string" ? scrubText(record.why).slice(0, 200) : "" });
  }
  return { labels, rejected };
}
