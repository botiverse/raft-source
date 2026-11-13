import { afterEach, expect, test, vi } from "vitest";
import api from "../src/api/client";
import { loadTaskPeriods, loadTaskSnapshot } from "../src/raftbench/periodMetrics";
vi.mock("../src/api/client", () => ({ default: { get: vi.fn() } }));
afterEach(() => vi.clearAllMocks());
const empty = { completed: 0, durationSamples: 0, meanHours: null, medianHours: null };
const result = () => ({ current: { completed: 1001, durationSamples: 1001, meanHours: 24, medianHours: 12 }, previous: empty, surfaces: 2, from: "2026-10-04T00:00:00Z", midpoint: "2026-10-11T00:00:00Z", to: "2026-10-18T00:00:00Z" });
test("reads aggregated periods with server, scope, time and cancellation instead of walking task pages", async () => {
  vi.mocked(api.get).mockResolvedValue({ data: result() });
  const signal = new AbortController().signal;
  expect((await loadTaskPeriods("s1", "2026-10-18T12:00:00Z", "c1", signal)).current.completed).toBe(1001);
  expect(api.get).toHaveBeenCalledTimes(1);
  expect(api.get).toHaveBeenCalledWith("/tasks/server/period-metrics", { params: { from: "2026-10-04T00:00:00.000Z", midpoint: "2026-10-11T00:00:00.000Z", to: "2026-10-18T00:00:00.000Z", channelId: "c1" }, headers: { "X-Server-Id": "s1" }, signal });
});
test.each(["window", "samples", "missing-mean", "count"])("rejects malformed %s rather than showing an invented zero", async (kind) => {
  const data = result();
  if (kind === "window") data.from = "2026-10-05T00:00:00Z";
  if (kind === "samples") data.current.durationSamples = 1002;
  if (kind === "missing-mean") data.previous = { ...empty, durationSamples: 1, completed: 1 };
  if (kind === "count") data.current.completed = -1;
  vi.mocked(api.get).mockResolvedValue({ data });
  await expect(loadTaskPeriods("s1", "2026-10-18T12:00:00Z", null, new AbortController().signal)).rejects.toThrow();
});

test("a snapshot with backlog tasks adds up: the server counts them in its total", async () => {
  const snapshot = {
    surfaces: 1, total: 3, backlog: 1, todo: 1, inProgress: 0, inReview: 0, done: 1, closed: 0,
    humanCreated: 2, agentCreated: 1, durationSamples: 0, medianHours: null, p90Hours: null,
    firstCreatedAt: null, latestCreatedAt: null, latestUpdatedAt: null,
  };
  vi.mocked(api.get).mockResolvedValueOnce({ data: snapshot });
  await expect(loadTaskSnapshot("s1", null, new AbortController().signal)).resolves.toMatchObject({ backlog: 1, total: 3 });
});
