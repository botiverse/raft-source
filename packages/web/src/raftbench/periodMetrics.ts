import api from "../api/client";
import { comparisonWindow } from "./taskMetrics";
interface Period { completed: number; durationSamples: number; meanHours: number | null; medianHours: number | null }
export interface TaskPeriods { current: Period; previous: Period; surfaces: number }
export interface TaskSnapshot {
  surfaces: number; total: number; backlog: number; todo: number; inProgress: number; inReview: number; done: number; closed: number;
  humanCreated: number; agentCreated: number; durationSamples: number; medianHours: number | null; p90Hours: number | null;
  firstCreatedAt: string | null; latestCreatedAt: string | null; latestUpdatedAt: string | null;
}
export async function loadTaskSnapshot(serverId: string, channelId: string | null, signal: AbortSignal): Promise<TaskSnapshot> {
  const { data } = await api.get<unknown>("/tasks/server/snapshot-metrics", {
    params: channelId ? { channelId } : {}, headers: { "X-Server-Id": serverId }, signal,
  });
  if (!data || typeof data !== "object") throw new Error("Invalid task snapshot");
  const row = data as Record<string, unknown>;
  const count = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
  const date = (v: unknown): v is string | null => v === null || (typeof v === "string" && Number.isFinite(Date.parse(v)));
  const hours = (v: unknown): v is number | null => v === null || (typeof v === "number" && Number.isFinite(v) && v >= 0);
  const keys = ["surfaces", "total", "backlog", "todo", "inProgress", "inReview", "done", "closed", "humanCreated", "agentCreated", "durationSamples"];
  if (keys.some((key) => !count(row[key])) || !hours(row.medianHours) || !hours(row.p90Hours) ||
    !date(row.firstCreatedAt) || !date(row.latestCreatedAt) || !date(row.latestUpdatedAt) ||
    row.total !== Number(row.backlog) + Number(row.todo) + Number(row.inProgress) + Number(row.inReview) + Number(row.done) + Number(row.closed) ||
    row.total !== Number(row.humanCreated) + Number(row.agentCreated)) throw new Error("Invalid task snapshot");
  return row as unknown as TaskSnapshot;
}
function parsePeriod(value: unknown): Period {
  if (!value || typeof value !== "object") throw new Error("Invalid task period");
  const p = value as Record<string, unknown>;
  const count = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
  const hours = (v: unknown): v is number | null => v === null || (typeof v === "number" && Number.isFinite(v) && v >= 0);
  if (!count(p.completed) || !count(p.durationSamples) || p.durationSamples > p.completed || !hours(p.meanHours) || !hours(p.medianHours) ||
    (p.durationSamples === 0 ? p.meanHours !== null || p.medianHours !== null : p.meanHours === null || p.medianHours === null)) throw new Error("Invalid task period");
  return { completed: p.completed, durationSamples: p.durationSamples, meanHours: p.meanHours, medianHours: p.medianHours };
}
export async function loadTaskPeriods(serverId: string, now: string, channelId: string | null, signal: AbortSignal): Promise<TaskPeriods> {
  const w = comparisonWindow(now);
  const { data } = await api.get<unknown>("/tasks/server/period-metrics", {
    params: { from: new Date(w.previousStart).toISOString(), midpoint: new Date(w.start).toISOString(), to: new Date(w.end).toISOString(), ...(channelId ? { channelId } : {}) },
    headers: { "X-Server-Id": serverId }, signal,
  });
  if (!data || typeof data !== "object") throw new Error("Invalid task metrics");
  const row = data as Record<string, unknown>;
  if (typeof row.surfaces !== "number" || !Number.isSafeInteger(row.surfaces) || row.surfaces < 0 ||
    typeof row.from !== "string" || Date.parse(row.from) !== w.previousStart || typeof row.midpoint !== "string" || Date.parse(row.midpoint) !== w.start || typeof row.to !== "string" || Date.parse(row.to) !== w.end) throw new Error("Invalid task window");
  return { current: parsePeriod(row.current), previous: parsePeriod(row.previous), surfaces: row.surfaces };
}
