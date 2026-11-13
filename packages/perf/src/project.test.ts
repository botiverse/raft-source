import { describe, expect, it } from "vitest";
import { parseProjectConfig, selectRun } from "./project";

const ok = { project: "raft-design", envs: { production: { origin: "https://raft-design.botiverse.build/" } }, pages: [{ name: "home", path: "/", ready: { selector: "main h1" } }] };

describe("parseProjectConfig", () => {
  it("normalises the origin and defaults hasText", () => {
    expect(parseProjectConfig(ok)).toEqual({ project: "raft-design", envs: { production: { origin: "https://raft-design.botiverse.build" } }, pages: [{ name: "home", path: "/", ready: { selector: "main h1", hasText: true } }] });
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

describe("selectRun", () => {
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
});
