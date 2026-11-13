import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runClaim } from "./claimCommand";

const OLD = "aaaaaaa1111111111111111111111111111111aa";
const NEW = "bbbbbbb2222222222222222222222222222222bb";
let dir: string;
let claims: string;

const rowsFile = (name: string, commit: string | null, values: number[]) => {
  const path = join(dir, name);
  writeFileSync(path, values.map((v) => JSON.stringify({ commit_sha: commit, extra: { ready_ms: v } })).join("\n") + "\n");
  return path;
};
const run = (...argv: string[]) => {
  let stdout = "";
  let stderr = "";
  const code = runClaim(argv, { stdout: (t) => (stdout += t), stderr: (t) => (stderr += t) });
  return { code, stdout, stderr };
};
const open = (extra: string[] = [], before = rowsFile("before.jsonl", OLD, [900, 950, 1000])) =>
  run("open", "--claims", claims, "--id", "c-1", "--project", "raft-web", "--env", "staging", "--title", "t", "--ref", "r", "--author", "a", "--scenario", "load/home", "--metric", "ready_ms", "--predicted-delta", "-300", "--before", before, "--runner", "lab", "--verify-command", "v", ...extra);
const lines = () => readFileSync(claims, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "raft-perf-claim-"));
  claims = join(dir, "claims.jsonl");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("raft-perf claim", () => {
  it("open, ship, verify: one row per call, the verdict decides the exit code, and a judged claim is final", () => {
    const before = rowsFile("before.jsonl", OLD, [900, 950, 1000]);
    const after = rowsFile("after.jsonl", NEW, [600, 650, 640]);
    expect(open().code).toBe(0);
    expect(run("verify", "--claims", claims, "--id", "c-1", "--before", before, "--after", after)).toMatchObject({ code: 2, stderr: expect.stringMatching(/has not shipped/) });
    expect(run("ship", "--claims", claims, "--id", "c-1", "--commit", NEW.slice(0, 10)).code).toBe(0);
    const verified = run("verify", "--claims", claims, "--id", "c-1", "--before", before, "--after", after);
    expect(verified.code).toBe(0);
    expect(lines().map((r) => r.event)).toEqual(["opened", "shipped", "verified"]);
    expect(lines()[2]).toMatchObject({ baseline_value: 950, measured_value: 640, measured_delta: -310, runs_before: 3, runs_after: 3, commit_sha: NEW.slice(0, 10) });
    expect(run("verify", "--claims", claims, "--id", "c-1", "--before", before, "--after", after)).toMatchObject({ code: 2, stderr: expect.stringMatching(/final/) });
    expect(lines()).toHaveLength(3);
    const status = run("status", "--claims", claims);
    expect(status.code).toBe(0);
    expect(JSON.parse(status.stdout).claims).toHaveLength(1);
  });

  it("a refuted claim exits 1", () => {
    open();
    run("ship", "--claims", claims, "--id", "c-1", "--commit", NEW);
    const r = run("verify", "--claims", claims, "--id", "c-1", "--before", rowsFile("before.jsonl", OLD, [900, 950, 1000]), "--after", rowsFile("after.jsonl", NEW, [910, 940, 990]));
    expect(r.code).toBe(1);
    expect(lines()[2].event).toBe("refuted");
  });

  it("verify refuses rows that do not fit the claim, and writes nothing", () => {
    const before = rowsFile("before.jsonl", OLD, [900, 950, 1000]);
    open();
    run("ship", "--claims", claims, "--id", "c-1", "--commit", NEW);
    const verify = (b: string, a: string) => run("verify", "--claims", claims, "--id", "c-1", "--before", b, "--after", a);
    expect(verify(before, rowsFile("a1.jsonl", OLD, [600, 610, 620])).stderr).toMatch(/not measured on the shipped commit/);
    expect(verify(before, rowsFile("a2.jsonl", null, [600, 610, 620])).stderr).toMatch(/names no commit/);
    expect(verify(rowsFile("b1.jsonl", NEW, [900, 950, 1000]), rowsFile("a3.jsonl", NEW, [600, 610, 620])).stderr).toMatch(/shipped commit .* itself/);
    expect(verify(rowsFile("b2.jsonl", OLD, [900, 950, 950, 1000]), rowsFile("a3.jsonl", NEW, [600, 610, 620])).stderr).toMatch(/opened with 3/);
    expect(verify(rowsFile("b3.jsonl", OLD, [900, 960, 1000]), rowsFile("a3.jsonl", NEW, [600, 610, 620])).stderr).toMatch(/baseline of 960/);
    expect(lines()).toHaveLength(2);
  });

  it("accepts the negative prediction as its own argument or with =, and refuses a commit that is not a sha", () => {
    expect(open().code).toBe(0);
    expect(lines()[0].predicted_delta).toBe(-300);
    claims = join(dir, "second.jsonl");
    expect(open(["--predicted-delta=-120"]).code).toBe(0);
    expect(lines()[0].predicted_delta).toBe(-120);
    expect(run("ship", "--claims", claims, "--id", "c-1", "--commit", "b")).toMatchObject({ code: 2, stderr: expect.stringMatching(/7 to 40 hex/) });
  });

  it("appends on a new line when the file's last line has none", () => {
    open();
    writeFileSync(claims, readFileSync(claims, "utf8").trimEnd());
    expect(run("ship", "--claims", claims, "--id", "c-1", "--commit", NEW).code).toBe(0);
    expect(lines().map((r) => r.event)).toEqual(["opened", "shipped"]);
  });

  it("reports bad input in one line, exit 2, without a stack trace", () => {
    writeFileSync(join(dir, "notrows.jsonl"), "5\n6\n7\n");
    for (const r of [run("status", "--claims", dir), open([], join(dir, "notrows.jsonl")), open(["--id", " "]), run("open", "--claims", join(dir, "no-such-dir", "c.jsonl"), "--id", "c-1", "--project", "p", "--env", "e", "--title", "t", "--ref", "r", "--author", "a", "--scenario", "s", "--metric", "ready_ms", "--predicted-delta=-300", "--before", rowsFile("b.jsonl", OLD, [900, 950, 1000]), "--runner", "lab", "--verify-command", "v"), run("open", "--claims", claims, "--id", "c-1", "--predicted-delta"), open(["--ref", ""]), run("--claims", claims, "status"), run("status", "--claims", join(dir, "missing.jsonl")), run("bogus", "--claims", claims)]) {
      expect(r.code).toBe(2);
      expect(r.stderr).not.toMatch(/\n\s+at /);
    }
    appendFileSync(claims, "not json\n");
    expect(run("status", "--claims", claims)).toMatchObject({ code: 2, stderr: expect.stringMatching(/line 1: not JSON/) });
  });

  it("open refuses baseline rows that name no commit: verify would refuse them after shipping", () => {
    expect(open([], rowsFile("nocommit.jsonl", null, [900, 950, 1000]))).toMatchObject({ code: 2, stderr: expect.stringMatching(/names no commit/) });
    expect(run("status", "--claims", claims).code).toBe(2); // nothing was written
  });

  it("help is exit 0 wherever the flag is; no arguments is usage on stderr, exit 2", () => {
    expect(run("--help")).toMatchObject({ code: 0, stdout: expect.stringMatching(/raft-perf claim </) });
    expect(run("--help", "status").code).toBe(0);
    expect(run("status", "-h").code).toBe(0);
    expect(run()).toMatchObject({ code: 2, stdout: "", stderr: expect.stringMatching(/raft-perf claim </) });
    // a help flag where a value belongs is a missing value: refused, nothing printed as help, nothing written
    expect(open(["--note", "--help"])).toMatchObject({ code: 2, stdout: "" });
    expect(open(["--title", "-h"])).toMatchObject({ code: 2, stdout: "" });
    expect(run("--note", "--help")).toMatchObject({ code: 2, stdout: "", stderr: expect.stringMatching(/command comes first/) });
    expect(run("status", "--claims", claims).code).toBe(2);
  });

  it("a blank ship note keeps the note the claim was opened with", () => {
    open(["--note", "why it should help"]);
    run("ship", "--claims", claims, "--id", "c-1", "--commit", NEW, "--note", "  ");
    expect(lines()[1]).toMatchObject({ event: "shipped", note: "why it should help" });
  });

  it("warns at open when the prediction is too small to tell from noise", () => {
    expect(open(["--predicted-delta=-40"]).stderr).toMatch(/could not be told from noise: if no move shows, the verdict will be inconclusive/);
  });
});
