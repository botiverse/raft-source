import {
  addDiagnosticRedactionCounts,
  redactDiagnosticSecrets,
  type AgentContextView,
  type AgentContextViewPart,
  type DiagnosticRedactionCounts,
  type JsonValue,
} from "@botiverse/raft-shared";

/**
 * Every text of a restored view through the shared counted redaction
 * (`redactDiagnosticSecrets`): system prompt, tool descriptions and schemas,
 * message text, thinking, tool inputs (each string in them) and outputs, and
 * the compaction summary. `redactions` is the sum of what was replaced.
 */
export function redactContextView(view: AgentContextView): AgentContextView {
  let counts: DiagnosticRedactionCounts = {};
  const text = (value: string): string => {
    const result = redactDiagnosticSecrets(value);
    if (Object.keys(result.counts).length > 0) counts = addDiagnosticRedactionCounts(counts, result.counts);
    return result.text;
  };
  const nullableText = (value: string | null): string | null => (value === null ? null : text(value));
  const json = (value: JsonValue): JsonValue => {
    if (typeof value === "string") return text(value);
    if (Array.isArray(value)) return value.map(json);
    if (value !== null && typeof value === "object") {
      const out: Record<string, JsonValue> = {};
      for (const [key, item] of Object.entries(value)) out[key] = json(item);
      return out;
    }
    return value;
  };
  const part = (p: AgentContextViewPart): AgentContextViewPart => {
    switch (p.kind) {
      case "text":
        return { kind: "text", text: text(p.text) };
      case "thinking":
        return { kind: "thinking", text: nullableText(p.text) };
      case "tool_use":
        return { ...p, input: json(p.input) };
      case "tool_result":
        return { ...p, output: text(p.output) };
      case "compaction":
        return { kind: "compaction", text: nullableText(p.text) };
      default:
        return p;
    }
  };
  const redacted: AgentContextView = {
    ...view,
    system: view.system.map((entry) => ({ text: text(entry.text) })),
    tools: view.tools.map((tool) => ({
      name: tool.name,
      description: text(tool.description),
      inputSchema: tool.inputSchema === null ? null : json(tool.inputSchema),
    })),
    messages: view.messages.map((message) => ({ role: message.role, parts: message.parts.map(part) })),
    compaction: view.compaction.happened && view.compaction.summary?.kind === "text"
      ? { happened: true, summary: { kind: "text", text: text(view.compaction.summary.text) } }
      : view.compaction,
  };
  redacted.redactions = addDiagnosticRedactionCounts(view.redactions, counts);
  return redacted;
}

/** Total markers in a count set (for traces). */
export function totalRedactions(counts: DiagnosticRedactionCounts): number {
  return Object.values(counts).reduce((sum, value) => sum + (value ?? 0), 0);
}
