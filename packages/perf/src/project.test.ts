import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  detectAuthRedirect,
  loadProjectConfig,
  parseProjectConfig,
  resolveProjectAuth,
  scrubAuthSecrets,
  selectRun,
} from "./project";

const ok = {
  project: "raft-design",
  envs: { production: { origin: "https://raft-design.botiverse.build/" } },
  pages: [{ name: "home", path: "/", ready: { selector: "main h1" } }],
};

describe("parseProjectConfig", () => {
  it("normalises the origin and defaults hasText while staying backward-compatible with v1 configs", () => {
    expect(parseProjectConfig(ok)).toEqual({
      project: "raft-design",
      envs: { production: { origin: "https://raft-design.botiverse.build" } },
      pages: [{ name: "home", path: "/", ready: { selector: "main h1", hasText: true } }],
    });
  });

  it("parses ProjectSpec v2 shell milestones, per-env paths/envs, and rejects literal secrets or unknown keys", () => {
    const stamp = loadProjectConfig("stamp");
    expect(stamp.project).toBe("stamp");
    expect(Object.keys(stamp.envs)).toEqual(["staging", "production"]);
    expect(stamp.pages.map((p) => p.name)).toEqual(["sign-in", "home", "pulls", "repositories", "pr-detail", "repo"]);
    expect(stamp.pages[0]?.auth).toBe(false);
    expect(stamp.pages[1]?.shell).toEqual({ selector: "nav.st-topnav", hasText: true });

    // Staging default selection omits production-only `pr-detail` and `repo`
    expect(selectRun(stamp, "staging").pages.map((p) => p.name)).toEqual(["sign-in", "home", "pulls", "repositories"]);
    // Production includes all 6 pages with resolved production paths
    expect(selectRun(stamp, "production").pages.map((p) => p.name)).toEqual([
      "sign-in",
      "home",
      "pulls",
      "repositories",
      "pr-detail",
      "repo",
    ]);
    expect(() => selectRun(stamp, "staging", "pr-detail")).toThrow(/not configured for env "staging"/);

    // Per-env paths resolution
    const multiRepo = parseProjectConfig({
      project: "stamp-custom",
      envs: {
        staging: { origin: "https://staging.stamp.build" },
        production: { origin: "https://stamp.build" },
      },
      pages: [
        {
          name: "repo",
          paths: {
            staging: "/github/stamp-build/stamp-setup-test",
            production: "/github/botiverse/mobile",
          },
          ready: { selector: "main h2" },
        },
      ],
    });
    expect(selectRun(multiRepo, "staging", "repo").pages[0]?.path).toBe("/github/stamp-build/stamp-setup-test");
    expect(selectRun(multiRepo, "production", "repo").pages[0]?.path).toBe("/github/botiverse/mobile");

    // Reject lowercase, hex-only, single-word tokens, and unknown fields like `cookie.value`
    expect(() =>
      parseProjectConfig({
        ...ok,
        auth: { kind: "cookie", cookie: { name: "sid", valueEnv: "my-secret-cookie-value" } },
      }),
    ).toThrow(/valueEnv/);
    expect(() =>
      parseProjectConfig({
        ...ok,
        auth: { kind: "cookie", cookie: { name: "sid", valueEnv: "DEADBEEF_12345678" } },
      }),
    ).toThrow(/valueEnv/);
    expect(() =>
      parseProjectConfig({
        ...ok,
        auth: { kind: "cookie", cookie: { name: "sid", valueEnv: "SINGLEWORD" } },
      }),
    ).toThrow(/valueEnv/);
    expect(() =>
      parseProjectConfig({
        ...ok,
        auth: { kind: "cookie", cookie: { name: "sid", valueEnv: "STAMP_SESSION", value: "leaked" } },
      }),
    ).toThrow(/unknown field "value"/);
  });

  it("names what is wrong", () => {
    expect(() => parseProjectConfig({ ...ok, project: "Raft Web" })).toThrow(/"project"/);
    expect(() => parseProjectConfig({ ...ok, envs: {} })).toThrow(/"envs"/);
    expect(() => parseProjectConfig({ ...ok, envs: { production: { origin: "ftp://x" } } })).toThrow(/origin/);
    expect(() => parseProjectConfig({ ...ok, envs: { production: { origin: "https://x.example/app" } } })).toThrow(/no path/);
    expect(() => parseProjectConfig({ ...ok, envs: [{ origin: "https://x.example" }] })).toThrow(/"envs"/);
    expect(() => parseProjectConfig({ ...ok, envs: { "Prod Env": { origin: "https://x.example" } } })).toThrow(/env name/);
    expect(() => parseProjectConfig({ ...ok, pages: [] })).toThrow(/"pages"/);
    expect(() => parseProjectConfig({ ...ok, pages: [{ name: "home", path: "home", ready: { selector: "h1" } }] })).toThrow(/path/);
    expect(() => parseProjectConfig({ ...ok, pages: [{ name: "home", path: "/" }] })).toThrow(/ready\.selector/);
    expect(() => parseProjectConfig({ ...ok, pages: [ok.pages[0], ok.pages[0]] })).toThrow(/twice/);
  });
});

describe("selectRun, detectAuthRedirect, and resolveProjectAuth", () => {
  const c = parseProjectConfig({ ...ok, pages: [...ok.pages, { name: "docs", path: "/docs", ready: { selector: "article" } }] });
  it("all pages by default, one by name", () => {
    expect(selectRun(c, "production").pages.map((p) => p.name)).toEqual(["home", "docs"]);
    expect(selectRun(c, "production", "docs").pages.map((p) => p.name)).toEqual(["docs"]);
  });
  it("refuses an unknown env or page, listing what exists", () => {
    expect(() => selectRun(c, "staging")).toThrow(/has: production/);
    expect(() => selectRun(c, "constructor")).toThrow(/has: production/);
    expect(() => selectRun(c, "production", "nope")).toThrow(/has: home, docs/);
  });

  it("detects both same-origin /sign-in router redirects and cross-host OAuth redirects while allowing public /sign-in", () => {
    expect(detectAuthRedirect(true, "staging.stamp.build", "/pulls", "https://staging.stamp.build/sign-in?next=%2Fpulls")).toEqual({
      redirectedToAuth: true,
      finalPath: "/sign-in",
    });
    expect(detectAuthRedirect(true, "staging.stamp.build", "/", "https://raft.build/oauth/authorize")).toEqual({
      redirectedToAuth: true,
      finalPath: "/oauth/authorize",
    });
    expect(detectAuthRedirect(false, "staging.stamp.build", "/sign-in", "https://staging.stamp.build/sign-in")).toEqual({
      redirectedToAuth: false,
      finalPath: "/sign-in",
    });
    // In-place SPA login wall (URL stays `/pulls` or `/`, `/api/web/me` returns 401)
    expect(
      detectAuthRedirect(true, "staging.stamp.build", "/", "https://staging.stamp.build/", [
        { route: "/api/web/me?return", status: 401 },
      ]),
    ).toEqual({
      redirectedToAuth: true,
      finalPath: "/",
    });
  });

  it("resolves __Host- cookies or storageState fallback from env and scrubs secrets", () => {
    const stamp = loadProjectConfig("stamp");
    expect(() => resolveProjectAuth(stamp, "staging", {})).toThrow(/STAMP_STAGING_SESSION/);

    const resolved = resolveProjectAuth(stamp, "staging", {
      STAMP_STAGING_SESSION: "super-secret-token-123",
      STAMP_SKIP: "1",
    });
    expect(resolved.authenticated).toBe(true);
    expect(resolved.cookies).toHaveLength(2);
    expect(resolved.cookies[0]).toMatchObject({
      name: "__Host-raft_git_gateway_session",
      url: "https://staging.stamp.build/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    });
    expect(scrubAuthSecrets("failed with super-secret-token-123 in header", resolved.secretsToScrub)).toBe(
      "failed with <redacted> in header",
    );

    const tmp = mkdtempSync(path.join(tmpdir(), "raft-perf-proj-"));
    try {
      const stateFile = path.join(tmp, "state.json");
      writeFileSync(stateFile, '{"cookies":[],"origins":[]}');
      const fallback = resolveProjectAuth(stamp, "staging", { STAMP_STAGING_STORAGE_STATE: stateFile });
      expect(fallback.storageStatePath).toBe(stateFile);
      expect(fallback.cookies).toHaveLength(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
