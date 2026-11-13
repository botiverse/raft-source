// The activity-log row for a runtime diagnostic, the same on either host
// (the process manager and the OAR host).

import { PI_RESPONSE_NOTICE_TITLE, type TrajectoryEntry } from "@botiverse/raft-shared";
import type { RuntimeDiagnosticEvent } from "./runtimeEventTrace";

function runtimeDiagnosticTitle(event: RuntimeDiagnosticEvent): string {
  if (event.source === "pi_empty_response") return PI_RESPONSE_NOTICE_TITLE;
  switch (event.itemType) {
    case "configWarning":
      return "Codex config warning";
    case "guardianWarning":
      return "Codex guardian warning";
    case "deprecationNotice":
      return "Codex deprecation notice";
    default:
      return event.source === "grok_acp_notification" ? "Grok Build warning" : "Codex warning";
  }
}

function summarizeDiagnosticRange(range: unknown): string | null {
  if (range === undefined || range === null) return null;
  try {
    const json = JSON.stringify(range);
    if (!json) return null;
    return json.length <= 300 ? json : `${json.slice(0, 299)}…`;
  } catch {
    return null;
  }
}

export function runtimeDiagnosticTrajectoryEntry(event: RuntimeDiagnosticEvent): TrajectoryEntry {
  const lines = [event.message];
  if (event.details && event.details !== event.message) {
    lines.push(event.details);
  }
  if (event.path) {
    lines.push(`Path: ${event.path}`);
  }
  const range = summarizeDiagnosticRange(event.range);
  if (range) {
    lines.push(`Range: ${range}`);
  }
  return {
    kind: "system",
    title: runtimeDiagnosticTitle(event),
    text: lines.join("\n"),
  };
}
