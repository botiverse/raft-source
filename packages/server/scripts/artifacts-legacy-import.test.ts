import assert from "node:assert/strict";
import { parseLegacyImportArgs } from "./artifacts-legacy-import";

test("plan names its servers (--server, repeated, or --servers a,b,c); there is no --all-servers", () => {
  assert.deepEqual(parseLegacyImportArgs(["--", "plan", "--server", "acme"]), { command: "plan", servers: ["acme"] });
  assert.deepEqual(parseLegacyImportArgs(["plan", "--servers", "a, b,c", "--server", "a", "--page-size", "50"]), { command: "plan", servers: ["a", "b", "c"], pageSize: 50 });
  assert.throws(() => parseLegacyImportArgs(["plan"]), /name the server/);
  assert.throws(() => parseLegacyImportArgs(["plan", "--all-servers"]), /--all-servers is not supported/);
  assert.throws(() => parseLegacyImportArgs(["plan", "--server", "a", "--yes"]), /--yes is for run only/);
  assert.throws(() => parseLegacyImportArgs(["import", "--server", "a"]), /the command is plan, run or comments/);
});

test("run moves exactly one server; without --yes it only plans; --max, --stop-at, --state, --operator are checked", () => {
  assert.deepEqual(parseLegacyImportArgs(["run", "--server", "acme"]), { command: "run", servers: ["acme"], yes: false, restart: false });
  assert.deepEqual(
    parseLegacyImportArgs(["run", "--server", "acme", "--yes", "--max", "10", "--stop-at", "2026-10-27T06:00:00Z", "--state", "s.json", "--operator", "alice", "--restart", "--report", "r.json"]),
    { command: "run", servers: ["acme"], yes: true, restart: true, max: 10, stopAt: new Date("2026-10-27T06:00:00Z"), state: "s.json", operator: "alice", report: "r.json" },
  );
  assert.throws(() => parseLegacyImportArgs(["run", "--servers", "a,b", "--yes"]), /one server at a time/);
  assert.throws(() => parseLegacyImportArgs(["run", "--server", "a", "--max", "0"]), /--max is a positive integer/);
  assert.throws(() => parseLegacyImportArgs(["run", "--server", "a", "--stop-at", "tomorrow"]), /--stop-at is a date and time/);
  assert.throws(() => parseLegacyImportArgs(["run", "--server", "--yes"]), /--server needs a value/);
});

test("--public is opt-in, for plan and run alike", () => {
  assert.deepEqual(parseLegacyImportArgs(["plan", "--server", "acme", "--public"]), { command: "plan", servers: ["acme"], public: true });
  assert.deepEqual(parseLegacyImportArgs(["run", "--server", "acme", "--yes", "--public"]), { command: "run", servers: ["acme"], yes: true, restart: false, public: true });
  assert.equal("public" in parseLegacyImportArgs(["run", "--server", "acme", "--yes"]), false);
});

test("--approved-by, --plan-digest and --approval-ref: run --public only, all three together", () => {
  assert.deepEqual(
    parseLegacyImportArgs(["run", "--server", "acme", "--yes", "--public", "--approved-by", "ada", "--plan-digest", "abc", "--approval-ref", "#c:1"]),
    { command: "run", servers: ["acme"], yes: true, restart: false, public: true, approval: { approvedBy: "ada", planDigest: "abc", approvalRef: "#c:1" } },
  );
  assert.throws(() => parseLegacyImportArgs(["run", "--server", "acme", "--public", "--approved-by", "ada"]), /all three/);
  assert.throws(() => parseLegacyImportArgs(["run", "--server", "acme", "--approved-by", "ada", "--plan-digest", "abc", "--approval-ref", "r"]), /--approved-by is for --public only/);
  assert.throws(() => parseLegacyImportArgs(["plan", "--server", "acme", "--approved-by", "ada"]), /--approved-by is for run only/);
});

test("run takes several servers only under one approval of their combined plan, each with its default state file", () => {
  const approval = ["--public", "--approved-by", "ada", "--plan-digest", "abc", "--approval-ref", "#c:1"];
  assert.deepEqual(
    parseLegacyImportArgs(["run", "--servers", "a,b", "--server", "c", "--yes", ...approval]),
    { command: "run", servers: ["a", "b", "c"], yes: true, restart: false, public: true, approval: { approvedBy: "ada", planDigest: "abc", approvalRef: "#c:1" } },
  );
  assert.throws(() => parseLegacyImportArgs(["run", "--servers", "a,b", "--yes", "--public"]), /one server at a time: .* under one approval of their combined plan/);
  assert.throws(() => parseLegacyImportArgs(["run", "--servers", "a,b", "--yes", ...approval, "--state", "s.json"]), /--state is one server's state file/);
});

test("comments plan names its servers and only reads; comments run needs the approval, all three", () => {
  assert.deepEqual(parseLegacyImportArgs(["--", "comments", "plan", "--servers", "a,b", "--server", "a"]), { command: "comments", action: "plan", servers: ["a", "b"] });
  assert.deepEqual(parseLegacyImportArgs(["comments", "plan", "--server", "a", "--page-size", "20"]), { command: "comments", action: "plan", servers: ["a"], pageSize: 20 });
  assert.deepEqual(
    parseLegacyImportArgs(["comments", "run", "--servers", "a,b", "--approved-by", "ada", "--plan-digest", "abc", "--approval-ref", "#c:1", "--operator", "alice", "--report", "r.json"]),
    { command: "comments", action: "run", servers: ["a", "b"], approval: { approvedBy: "ada", planDigest: "abc", approvalRef: "#c:1" }, operator: "alice", report: "r.json" },
  );
  assert.throws(() => parseLegacyImportArgs(["comments", "run", "--servers", "a", "--approved-by", "ada", "--plan-digest", "abc"]), /all three/);
  assert.throws(() => parseLegacyImportArgs(["comments", "plan", "--server", "a", "--approved-by", "ada"]), /--approved-by is for comments run only/);
  assert.throws(() => parseLegacyImportArgs(["comments", "plan"]), /name the server/);
  assert.throws(() => parseLegacyImportArgs(["comments", "import", "--server", "a"]), /comments plan or comments run/);
  assert.throws(() => parseLegacyImportArgs(["comments", "run", "--server", "a", "--public"]), /unknown argument for comments run: --public/);
});

test("--max-file-mib (run only): a download's limit for this run, at most 64 MiB", () => {
  assert.deepEqual(parseLegacyImportArgs(["run", "--server", "acme", "--yes", "--max-file-mib", "64"]), { command: "run", servers: ["acme"], yes: true, restart: false, maxFileMib: 64 });
  assert.throws(() => parseLegacyImportArgs(["run", "--server", "acme", "--max-file-mib", "65"]), /--max-file-mib is at most 64/);
  assert.throws(() => parseLegacyImportArgs(["run", "--server", "acme", "--max-file-mib", "0"]), /--max-file-mib is a positive integer/);
  assert.throws(() => parseLegacyImportArgs(["plan", "--server", "acme", "--max-file-mib", "64"]), /--max-file-mib is for run only/);
});
