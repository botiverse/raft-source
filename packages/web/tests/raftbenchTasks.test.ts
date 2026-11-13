import { afterEach, expect, test, vi } from "vitest";
import api from "../src/api/client";
import { loadTaskSnapshot, summarizeTasks } from "../src/raftbench/taskMetrics";
import type { TaskFact } from "../src/raftbench/taskMetrics";
vi.mock("../src/api/client", () => ({ default: { get: vi.fn() } }));
afterEach(() => vi.clearAllMocks());
const fact = (patch: Partial<TaskFact> = {}): TaskFact => ({ id: "t1", channelId: "c1", status: "done", owner: "agent", createdAt: "2026-10-01T00:00:00Z", completedAt: "2026-10-01T02:00:00Z", ...patch });
const row = (patch = {}) => ({ ...fact(), claimedByType: "agent", ...patch });
test("separates closed/active/unknown owner from done and uses only valid done elapsed times", () => {
  const r = summarizeTasks([fact(), fact({ id: "t2", status: "closed", owner: "user" }), fact({ id: "t3", status: "in_review", owner: null }), fact({ id: "t4", completedAt: "2026-10-01T06:00:00Z" }), fact({ id: "t5", completedAt: "2026-09-30T00:00:00Z" })]);
  expect(r.statuses).toEqual({ backlog: 0, todo: 0, in_progress: 0, in_review: 1, done: 3, closed: 1 });
  expect(r.owners).toEqual({ user: 1, agent: 3, unassigned: 1 });
  expect(r.medianHours).toBe(4);
  expect(r.durationSamples).toBe(2);
  expect(summarizeTasks([]).medianHours).toBeNull();
});
test("a backlog row is a valid task, not an invalid snapshot", async () => {
  vi.mocked(api.get).mockResolvedValueOnce({ data: { tasks: [row({ status: "backlog" })], next_cursor: null } });
  const result = await loadTaskSnapshot("s1", new AbortController().signal);
  expect(result.tasks.map((task) => task.status)).toEqual(["backlog"]);
  expect(summarizeTasks(result.tasks).statuses.backlog).toBe(1);
});
test("walks ACL-filtered summary pages with server/cancellation context and drops bodies", async () => {
  vi.mocked(api.get).mockResolvedValueOnce({ data: { tasks: [row({ description: "not retained" })], next_cursor: "next" } }).mockResolvedValueOnce({ data: { tasks: [row({ id: "t2", channelId: "c2" })], next_cursor: null } });
  const signal = new AbortController().signal;
  const result = await loadTaskSnapshot("s1", signal);
  expect(result.complete).toBe(true);
  expect(result.tasks).toHaveLength(2);
  expect(result.tasks[0]).not.toHaveProperty("description");
  expect(api.get).toHaveBeenLastCalledWith("/tasks/server", { params: { detail: "summary", limit: 250, cursor: "next" }, headers: { "X-Server-Id": "s1" }, signal });
});
test("a capped read remains partial rather than claiming workspace totals", async () => {
  let page = 0;
  vi.mocked(api.get).mockImplementation(async () => ({ data: { tasks: [row({ id: String(++page) })], next_cursor: String(page) } }));
  const result = await loadTaskSnapshot("s1", new AbortController().signal);
  expect(result.complete).toBe(false);
  expect(api.get).toHaveBeenCalledTimes(4);
});
test.each(["duplicate", "cursor", "invalid"])("rejects %s evidence instead of silently counting a corrupt snapshot", async (kind) => {
  vi.mocked(api.get).mockResolvedValueOnce({ data: { tasks: [row()], next_cursor: "next" } }).mockResolvedValueOnce({ data: { tasks: [row({ id: kind === "duplicate" ? "t1" : "t2", status: kind === "invalid" ? "mystery" : "done" })], next_cursor: kind === "cursor" ? "next" : null } });
  await expect(loadTaskSnapshot("s1", new AbortController().signal)).rejects.toThrow();
});
