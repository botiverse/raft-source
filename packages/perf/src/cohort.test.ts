import { describe, expect, it } from "vitest";
import {
  benchmarkStepsApart,
  buildCohort,
  cohortExtra,
  cohortFromRows,
  compareCohorts,
  connectRttStepsApart,
  parseConnectRttMs,
  parseEdgeColo,
  parseServerTimingMs,
} from "./cohort";

describe("parseEdgeColo", () => {
  it("extracts 3-letter IATA metro codes from Cloudflare cf-ray and CloudFront x-amz-cf-pop", () => {
    expect(parseEdgeColo({ "cf-ray": "8e45ab12cd34ef56-SIN" })).toBe("SIN");
    expect(parseEdgeColo({ "X-Amz-Cf-Pop": "HEL51-P8" })).toBe("HEL");
    expect(parseEdgeColo({ "x-amz-cf-pop": "iad89-p2" })).toBe("IAD");
    expect(parseEdgeColo({ server: "nginx" })).toBeNull();
    expect(parseEdgeColo(null)).toBeNull();
  });
});

describe("parseServerTimingMs", () => {
  it("parses W3C Server-Timing durations and prefers total/app over summing sub-spans", () => {
    expect(parseServerTimingMs("db;dur=42.3, auth;dur=10.2")).toBe(52.5);
    expect(parseServerTimingMs('db;dur=40, cache;dur=5, total;dur="48.6";desc="Total"')).toBe(48.6);
    expect(parseServerTimingMs(["sql;dur=12", "app;dur=19.4"])).toBe(19.4);
    expect(parseServerTimingMs("miss, cache;desc=hit")).toBeNull();
    expect(parseServerTimingMs(undefined)).toBeNull();
  });
});

describe("parseConnectRttMs", () => {
  it("extracts pure TCP handshake 1-RTT excluding TLS, and skips reused or QUIC/HTTP/3 0-ms sslStart==connectStart", () => {
    expect(parseConnectRttMs({ connectStart: 10, sslStart: 21.4, connectEnd: 46.8 }, "h2")).toBe(11.4);
    expect(parseConnectRttMs({ connectStart: 5, sslStart: -1, connectEnd: 32 }, "http/1.1")).toBe(27);
    expect(parseConnectRttMs({ connectStart: 12, sslStart: 12, connectEnd: 35 })).toBeNull();
    expect(parseConnectRttMs({ connectStart: 10, sslStart: 20, connectEnd: 40 }, "h3")).toBeNull();
    expect(parseConnectRttMs({ connectStart: 10, sslStart: 20, connectEnd: 40 }, "h3-29")).toBeNull();
    expect(parseConnectRttMs({ connectStart: -1, sslStart: -1, connectEnd: -1 })).toBeNull();
    expect(parseConnectRttMs(null)).toBeNull();
  });
});

describe("buildCohort and compareCohorts", () => {
  const base = buildCohort({
    browserWhere: "browser-run",
    edgeColo: "SIN",
    hostCpuCount: 12,
    hostBenchmarkMs: 8.5,
    device: { browserCpuCount: 4, browserMemoryGb: 2, browserBenchmarkMs: 18.2 },
    connectRttSamplesMs: [12, 14, 11],
    cpuSlowdown: 1,
    addedRttMs: 0,
    net: "fast",
    fixture: "bench-v1@5395d2b0",
  });

  it("encodes remote browser hardware, PoP, RTT, interception and fixture into both cohort.key and extra", () => {
    expect(base.key).toBe("browser-run|colo=SIN|cpu=4c/14-28ms|slow=1x|rtt=+0ms|net=fast|fixture=bench-v1@5395d2b0");
    expect(base.connectRttMs).toBe(12);
    const extra = cohortExtra(base);
    expect(extra).toMatchObject({
      browser_where: "browser-run",
      edge_colo: "SIN",
      fixture_tag: "bench-v1@5395d2b0",
      document_intercepted: 0,
      browser_cpu_count: 4,
      browser_benchmark_ms: 18.2,
      connect_rtt_ms: 12,
      cpu_slowdown_count: 1,
      added_rtt_ms: 0,
    });

    const intercepted = buildCohort({
      browserWhere: "browser-run",
      edgeColo: "SIN",
      hostCpuCount: 12,
      hostBenchmarkMs: 8.5,
      device: { browserCpuCount: 4, browserMemoryGb: 2, browserBenchmarkMs: 10.5 },
      documentIntercepted: true,
    });
    expect(intercepted.key).toBe("browser-run|colo=SIN|cpu=4c/6-14ms|slow=1x|rtt=+0ms|net=fast|intercept=doc");
    expect(cohortExtra(intercepted).document_intercepted).toBe(1);
  });

  it("keeps 8..11 ms machines in one key band (6-14ms) and treats minor benchmark/RTT jitter as comparable", () => {
    const morning = buildCohort({
      browserWhere: "browser-run",
      edgeColo: "SIN",
      hostCpuCount: 12,
      hostBenchmarkMs: 8.8,
      device: { browserCpuCount: 4, browserMemoryGb: 2, browserBenchmarkMs: 8.9 },
      connectRttSamplesMs: [12],
      fixture: "bench-v1@5395d2b0",
    });
    const afternoon = buildCohort({
      browserWhere: "browser-run",
      edgeColo: "SIN",
      hostCpuCount: 12,
      hostBenchmarkMs: 9.3,
      device: { browserCpuCount: 4, browserMemoryGb: 2, browserBenchmarkMs: 10.8 },
      connectRttSamplesMs: [16],
      fixture: "bench-v1@5395d2b0",
    });
    expect(morning.key).toBe(afternoon.key);
    expect(compareCohorts({ browserWhere: "browser-run", fixture: "bench-v1@5395d2b0", benchmarkMs: 8.9, connectRttMs: 12 }, afternoon)).toEqual({
      comparable: true,
      differences: [],
    });
  });

  it("fails comparability when expected benchmarkMs or edgeColo is missing (null) on actual", () => {
    const failedProbe = buildCohort({
      browserWhere: "browser-run",
      edgeColo: null,
      hostCpuCount: 12,
      hostBenchmarkMs: 8.8,
      device: { browserCpuCount: null, browserMemoryGb: null, browserBenchmarkMs: null },
    });
    const cmp = compareCohorts({ browserWhere: "browser-run", edgeColo: "SIN", benchmarkMs: 10.5 }, failedProbe);
    expect(cmp.comparable).toBe(false);
    expect(cmp.differences.map((d) => d.field)).toEqual(["edgeColo", "benchmarkMs"]);
  });

  it("catches machine swaps (20 ms -> 9 ms), datacenter jumps (228 ms -> 11 ms), browser-where, interception and fixture changes", () => {
    expect(benchmarkStepsApart(20, 9)).toBe(true);
    expect(benchmarkStepsApart(7.7, 9.2)).toBe(false);
    expect(connectRttStepsApart(228, 11)).toBe(true);
    expect(connectRttStepsApart(12, 19)).toBe(false);

    const moved = buildCohort({
      browserWhere: "local",
      edgeColo: "HEL",
      hostCpuCount: 12,
      hostBenchmarkMs: 8.8,
      device: { browserCpuCount: 12, browserMemoryGb: 8, browserBenchmarkMs: 8.8 },
      connectRttSamplesMs: [228],
      cpuSlowdown: 4,
      documentIntercepted: true,
      fixture: null,
    });
    const cmp = compareCohorts(
      { browserWhere: "browser-run", edgeColo: "SIN", cpuSlowdown: 1, documentIntercepted: false, fixture: "bench-v1@5395d2b0", benchmarkMs: 20, connectRttMs: 12 },
      moved,
    );
    expect(cmp.comparable).toBe(false);
    expect(cmp.differences.map((d) => d.field)).toEqual([
      "browserWhere",
      "fixture",
      "documentIntercepted",
      "cpuSlowdown",
      "edgeColo",
      "benchmarkMs",
      "connectRttMs",
    ]);
  });

  it("infers local browserWhere and buffered documentIntercepted on pre-0.26 rows so tool upgrades cannot masquerade as wins", () => {
    const legacyMeasureRows = [1, 2, 3].map(() => ({
      state: "release",
      net: "fast",
      extra: { content_ms: 1450, host_cpu_count: 12, host_benchmark_ms: 9.1 },
    }));
    const newBrowserRunRows = [1, 2, 3].map(() => ({
      state: "release",
      net: "fast",
      extra: {
        content_ms: 1180,
        ...cohortExtra(
          buildCohort({
            browserWhere: "browser-run",
            edgeColo: "SIN",
            hostCpuCount: 12,
            hostBenchmarkMs: 9.1,
            device: { browserCpuCount: 4, browserMemoryGb: 2, browserBenchmarkMs: 10.5 },
            documentIntercepted: false,
          }),
        ),
      },
    }));
    const legacyLocalCohort = cohortFromRows(legacyMeasureRows);
    const newLocalUnintercepted = cohortFromRows(
      [1, 2, 3].map(() => ({
        state: "release",
        net: "fast",
        extra: {
          content_ms: 1380,
          ...cohortExtra(
            buildCohort({
              browserWhere: "local",
              edgeColo: "HEL",
              hostCpuCount: 12,
              hostBenchmarkMs: 9.1,
              device: { browserCpuCount: 12, browserMemoryGb: 16, browserBenchmarkMs: 9.1 },
              documentIntercepted: false,
            }),
          ),
        },
      })),
    );
    expect(legacyLocalCohort.expectation.browserWhere).toBe("local");
    expect(legacyLocalCohort.expectation.documentIntercepted).toBe(true);
    expect(compareCohorts(legacyLocalCohort.expectation, cohortFromRows(newBrowserRunRows).actual).differences.map((d) => d.field)).toContain("browserWhere");
    expect(compareCohorts(legacyLocalCohort.expectation, newLocalUnintercepted.actual).differences.map((d) => d.field)).toEqual(["documentIntercepted"]);
  });
});
