import type { ReactNode } from "react";
import type { IntlShape } from "react-intl";
import type { AgentMigrationLogEntry } from "@botiverse/raft-shared";

/** The cloud as a place on the ring; real computers use their machine id. */
export const CLOUD_NODE = "cloud";

export type NodeId = string;

export interface LogNode {
  id: NodeId;
  /** The computer's current name, else the name it had when it last moved an agent. */
  name: string;
  /** Three characters, unique on the server, like an airport code (HX3, CMA). */
  code: string;
  /** Where it is hosted (provider, else device class); the ring groups by it. */
  group: string;
  /** Still a computer of this server (false: deleted since, or the cloud). */
  known: boolean;
}

export interface MachineLike {
  id: string;
  name: string;
  hostProvider?: string | null;
  deviceClass?: string | null;
}

export interface RouteCell {
  src: NodeId;
  dst: NodeId;
  ok: number;
  failed: number;
}

export interface LogFilters {
  agents: string[];
  /** A computer on either end. */
  computers: string[];
  /** Moves leaving these computers (source machine ids). */
  from: NodeId[];
  /** Moves arriving at these places (target node ids, the cloud included). */
  to: NodeId[];
  outcomes: Array<"completed" | "failed" | "canceled">;
  /** Days back from now; null for all time. */
  days: number | null;
}

export const EMPTY_FILTERS: LogFilters = { agents: [], computers: [], from: [], to: [], outcomes: [], days: null };

export const targetNode = (entry: AgentMigrationLogEntry): NodeId =>
  entry.targetKind === "hosted" ? CLOUD_NODE : entry.targetMachineId ?? CLOUD_NODE;

/**
 * A code from a computer's name: the first letters of up to three words, keeping
 * a digit when the name ends in one (hetzner-ex63-3 → HX3, armbian-1 → AB1,
 * Alices-MacBook-Air → AMA). Codes are unique on the server: a clash takes the
 * next letter of the last word instead (letters, not numbers, so they still read
 * as codes).
 */
export function computerCodes(names: Array<{ id: string; name: string }>): Map<string, string> {
  const out = new Map<string, string>();
  const used = new Set<string>();
  const sorted = [...names].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  for (const { id, name } of sorted) {
    const words = name.replace(/\.local$/i, "").split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    const letters = words.join("").toUpperCase().replace(/[^\p{L}\p{N}]/gu, "");
    const last = words.at(-1) ?? "";
    let base: string;
    if (/^\d+$/.test(last) && words.length >= 2) {
      base = (words[0][0] + (words.length >= 3 ? words[1][0] : words[0][1] ?? "X") + last).toUpperCase();
    } else if (words.length >= 3) {
      base = (words[0][0] + words[1][0] + words[2][0]).toUpperCase();
    } else if (words.length === 2) {
      base = (words[0][0] + words[1].slice(0, 2)).toUpperCase();
    } else {
      base = (letters || "PC").slice(0, 3).toUpperCase();
    }
    base = base.slice(0, 3).padEnd(3, "X");
    let code = base;
    // Clashes: walk through the remaining letters of the name for the last character.
    for (let i = 0; used.has(code) && i < letters.length; i++) code = base.slice(0, 2) + letters[i];
    for (let i = 0; used.has(code) && i < 26; i++) code = base.slice(0, 2) + String.fromCharCode(65 + i);
    used.add(code);
    out.set(id, code);
  }
  return out;
}

const groupOfMachine = (machine: MachineLike | undefined): string =>
  (machine?.hostProvider || machine?.deviceClass || "other").toLowerCase();

/**
 * Every place that appears in the log, plus every current computer of the
 * server, moves or not (so a computer without moves still has a filter option,
 * a label and a sliver on the ring).
 */
export function buildNodes(entries: AgentMigrationLogEntry[], machines: MachineLike[]): LogNode[] {
  const byId = new Map(machines.map((m) => [m.id, m]));
  const names = new Map<NodeId, string>();
  for (const m of machines) names.set(m.id, m.name);
  for (const e of entries) {
    names.set(e.sourceMachineId, byId.get(e.sourceMachineId)?.name ?? e.sourceMachineName ?? e.sourceMachineId.slice(0, 8));
    const dst = targetNode(e);
    if (dst !== CLOUD_NODE) names.set(dst, byId.get(dst)?.name ?? e.targetMachineName ?? dst.slice(0, 8));
  }
  const codes = computerCodes([...names].map(([id, name]) => ({ id, name })));
  const nodes: LogNode[] = [...names].map(([id, name]) => ({
    id, name, code: codes.get(id)!, group: byId.has(id) ? groupOfMachine(byId.get(id)) : "removed", known: byId.has(id),
  }));
  if (entries.some((e) => targetNode(e) === CLOUD_NODE)) nodes.push({ id: CLOUD_NODE, name: "", code: "CLD", group: "cloud", known: false });
  // Ring order: groups by size, then names; the cloud and removed computers last.
  const size = new Map<string, number>();
  for (const n of nodes) size.set(n.group, (size.get(n.group) ?? 0) + 1);
  const rank = (g: string) => (g === "cloud" ? 2 : g === "removed" ? 3 : g === "other" ? 1 : 0);
  return nodes.sort((a, b) => rank(a.group) - rank(b.group) || (size.get(b.group)! - size.get(a.group)!) || a.group.localeCompare(b.group) || a.name.localeCompare(b.name));
}

export function filterEntries(entries: AgentMigrationLogEntry[], f: LogFilters, now: number): AgentMigrationLogEntry[] {
  const since = f.days == null ? null : now - f.days * 86_400_000;
  return entries.filter((e) =>
    (!f.agents.length || f.agents.includes(e.agentId))
    && (!f.computers.length || f.computers.includes(e.sourceMachineId) || f.computers.includes(targetNode(e)))
    && (!f.from.length || f.from.includes(e.sourceMachineId))
    && (!f.to.length || f.to.includes(targetNode(e)))
    && (!f.outcomes.length || (e.outcome !== "in_progress" && f.outcomes.includes(e.outcome)))
    && (since == null || Date.parse(e.startedAt) >= since));
}

export const isFiltered = (f: LogFilters) =>
  f.agents.length > 0 || f.computers.length > 0 || f.from.length > 0 || f.to.length > 0 || f.outcomes.length > 0 || f.days != null;

/** Routes with their successful and failed moves; canceled and running moves are not drawn. */
export function routeCells(entries: AgentMigrationLogEntry[]): RouteCell[] {
  const cells = new Map<string, RouteCell>();
  for (const e of entries) {
    if (e.outcome !== "completed" && e.outcome !== "failed") continue;
    const dst = targetNode(e), key = `${e.sourceMachineId}>${dst}`;
    const cell = cells.get(key) ?? { src: e.sourceMachineId, dst, ok: 0, failed: 0 };
    if (e.outcome === "completed") cell.ok++; else cell.failed++;
    cells.set(key, cell);
  }
  return [...cells.values()];
}

export interface Leg {
  entry: AgentMigrationLogEntry;
  /** Failed and canceled tries on the way to this move, oldest first. */
  tries: AgentMigrationLogEntry[];
}

/** One agent's path: each completed move, with the tries that led to it; `pending` tries after the last one. */
export function journey(entries: AgentMigrationLogEntry[], agentId: string): { start: NodeId | null; legs: Leg[]; pending: AgentMigrationLogEntry[] } {
  const mine = entries.filter((e) => e.agentId === agentId);
  const legs: Leg[] = [];
  let tries: AgentMigrationLogEntry[] = [];
  for (const e of mine) {
    if (e.outcome === "completed") { legs.push({ entry: e, tries }); tries = []; } else if (e.outcome !== "in_progress") tries.push(e);
  }
  return { start: mine[0]?.sourceMachineId ?? null, legs, pending: tries };
}

export interface LogStats {
  total: number;
  /** Completed out of finished moves, cancels excluded; null with none finished. */
  successRate: number | null;
  agents: number;
  computers: number;
}

export function stats(entries: AgentMigrationLogEntry[]): LogStats {
  const finished = entries.filter((e) => e.outcome === "completed" || e.outcome === "failed");
  const ok = finished.filter((e) => e.outcome === "completed").length;
  return {
    total: entries.length,
    successRate: finished.length ? Math.round((ok / finished.length) * 100) : null,
    agents: new Set(entries.map((e) => e.agentId)).size,
    computers: new Set(entries.flatMap((e) => [e.sourceMachineId, targetNode(e)])).size,
  };
}

/** URL search params ↔ filters, so a filtered view can be shared and reloaded (DS Tasks › Filters). */
export function filtersFromSearch(params: URLSearchParams): LogFilters {
  const list = (k: string) => params.getAll(k).flatMap((v) => v.split(",")).filter(Boolean);
  const outcomes = list("outcome").filter((o): o is LogFilters["outcomes"][number] => o === "completed" || o === "failed" || o === "canceled");
  const days = Number(params.get("days"));
  return { agents: list("agent"), computers: list("computer"), from: list("from"), to: list("to"), outcomes, days: Number.isFinite(days) && days > 0 ? days : null };
}

export function searchFromFilters(f: LogFilters): URLSearchParams {
  const p = new URLSearchParams();
  if (f.agents.length) p.set("agent", f.agents.join(","));
  if (f.computers.length) p.set("computer", f.computers.join(","));
  if (f.from.length) p.set("from", f.from.join(","));
  if (f.to.length) p.set("to", f.to.join(","));
  if (f.outcomes.length) p.set("outcome", f.outcomes.join(","));
  if (f.days != null) p.set("days", String(f.days));
  return p;
}

/** A person who started a move, as the API sends them. */
export type Initiator = NonNullable<AgentMigrationLogEntry["initiatedBy"]>;
/** How a page shows the person's name (a link to their profile); `label` is the name as plain text. */
export type RenderInitiator = (person: Initiator, label: string) => ReactNode;

/**
 * Who started a move: the person's display name, else their handle; a former
 * member when they are no longer on the server (left, removed or deleted: the
 * API sends null), always plain text. Only people start moves today.
 */
function initiatorName(t: IntlShape["formatMessage"], entry: AgentMigrationLogEntry, render?: RenderInitiator): ReactNode {
  if (!entry.initiatedBy) return t({ id: "agent.migrationLog.formerMember" });
  const label = entry.initiatedBy.displayName || entry.initiatedBy.name;
  return render ? render(entry.initiatedBy, label) : label;
}

/** A move row's line (its route and failure reason), then who started that move; with `render`, only the name is rendered by it. */
export function withInitiator(t: IntlShape["formatMessage"], detail: string, entry: AgentMigrationLogEntry): string;
export function withInitiator(t: IntlShape["formatMessage"], detail: string, entry: AgentMigrationLogEntry, render: RenderInitiator): ReactNode;
export function withInitiator(t: IntlShape["formatMessage"], detail: string, entry: AgentMigrationLogEntry, render?: RenderInitiator): ReactNode {
  return t({ id: "agent.migrationLog.fmt.initiatedBy" }, { detail, name: initiatorName(t, entry, render) });
}

/** Who started a move, on a line of its own (a computer card's most recent move, where the card is too narrow to run it on). */
export function initiatedBy(t: IntlShape["formatMessage"], entry: AgentMigrationLogEntry): string;
export function initiatedBy(t: IntlShape["formatMessage"], entry: AgentMigrationLogEntry, render: RenderInitiator): ReactNode;
export function initiatedBy(t: IntlShape["formatMessage"], entry: AgentMigrationLogEntry, render?: RenderInitiator): ReactNode {
  return t({ id: "agent.migrationLog.fmt.initiatedByName" }, { name: initiatorName(t, entry, render) });
}

/** An outcome's word, for the log's outcome filter and badges. */
export const OUTCOME_LABEL = {
  completed: "agent.migrationLog.outcome.completed",
  failed: "agent.migrationLog.outcome.failed",
  canceled: "agent.migrationLog.outcome.canceled",
} as const;
