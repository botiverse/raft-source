import assert from "node:assert/strict";
import {
  detectLogindSessionRisk,
  formatLogindSessionRisk,
  parseBusctlStrings,
  sessionScopeFromCgroup,
  type CommandRunner,
} from "./logindSessionRisk";

const SSH_SESSION = "0::/user.slice/user-1001.slice/session-24.scope\n";

function logind(props: { kill?: string; exclude?: string; only?: string; linger?: string; failBusctl?: boolean }): CommandRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const run = (async (command: string, args: string[]) => {
    calls.push([command, ...args]);
    if (command === "busctl") {
      if (props.failBusctl) return { code: null, stdout: "" };
      const property = args[args.length - 1];
      const value = property === "KillUserProcesses" ? props.kill ?? "b false"
        : property === "KillExcludeUsers" ? props.exclude ?? "as 0"
        : props.only ?? "as 0";
      return { code: 0, stdout: `${value}\n` };
    }
    return { code: 0, stdout: `${props.linger ?? "no"}\n` };
  }) as CommandRunner & { calls: string[][] };
  run.calls = calls;
  return run;
}

const base = { platform: "linux" as const, readCgroup: async () => SSH_SESSION, user: "archer", uid: 1001 };

test("task #37: the login session scope is read from cgroup v2 and v1, and only a session scope counts", () => {
  assert.deepEqual(sessionScopeFromCgroup(SSH_SESSION), { scope: "session-24.scope", ownerUid: 1001 });
  assert.deepEqual(sessionScopeFromCgroup("12:memory:/user.slice\n1:name=systemd:/user.slice/user-1000.slice/session-c2.scope\n"), { scope: "session-c2.scope", ownerUid: 1000 });
  assert.equal(sessionScopeFromCgroup("0::/user.slice/user-1001.slice/user@1001.service/app.slice/raft-computer.service\n"), null);
  assert.equal(sessionScopeFromCgroup("0::/system.slice/cron.service\n"), null);
  assert.deepEqual(parseBusctlStrings('as 2 "root" "alice"'), ["root", "alice"]);
  assert.deepEqual(parseBusctlStrings("as 0"), []);
});

test("task #37: a session scope that logind kills at logout is a risk, with linger reported", async () => {
  assert.deepEqual(
    await detectLogindSessionRisk({ ...base, run: logind({ kill: "b true", linger: "no" }) }),
    { sessionScope: "session-24.scope", user: "archer", linger: false },
  );
  // Linger does not exempt the session scope (verified on Ubuntu 24.04): still a risk.
  assert.deepEqual(
    await detectLogindSessionRisk({ ...base, run: logind({ kill: "b true", linger: "yes" }) }),
    { sessionScope: "session-24.scope", user: "archer", linger: true },
  );
});

test("task #37: no risk when logind keeps the scope, excludes the user, or cannot be asked", async () => {
  assert.equal(await detectLogindSessionRisk({ ...base, run: logind({ kill: "b false" }) }), null);
  assert.equal(await detectLogindSessionRisk({ ...base, run: logind({ kill: "b true", exclude: 'as 2 "root" "archer"' }) }), null);
  assert.equal(await detectLogindSessionRisk({ ...base, run: logind({ kill: "b true", only: 'as 1 "alice"' }) }), null);
  assert.equal(await detectLogindSessionRisk({ ...base, run: logind({ failBusctl: true }) }), null);
});

test("task #37: under sudo/su the session belongs to someone else, so nothing is asked or advised", async () => {
  const run = logind({ kill: "b true" });
  assert.equal(await detectLogindSessionRisk({ ...base, uid: 0, user: "root", run }), null);
  assert.deepEqual(run.calls, []);
});

test("task #37: nothing is asked outside Linux or outside a login session", async () => {
  const off = logind({ kill: "b true" });
  assert.equal(await detectLogindSessionRisk({ ...base, platform: "darwin", run: off }), null);
  assert.equal(await detectLogindSessionRisk({ ...base, readCgroup: async () => "0::/user.slice/user-1001.slice/user@1001.service/app.slice/x.service\n", run: off }), null);
  assert.equal(await detectLogindSessionRisk({ ...base, readCgroup: async () => { throw new Error("ENOENT"); }, run: off }), null);
  assert.deepEqual(off.calls, []);
});

test("task #37: the advice enables linger only when it is off and runs the service as a supervised user unit", () => {
  const lines = formatLogindSessionRisk(
    { sessionScope: "session-24.scope", user: "archer", linger: false },
    { command: ["/home/archer/.local/bin/raft-computer"], raftHome: "/home/archer/.raft" },
  );
  const text = lines.join("\n");
  assert.match(text, /KillUserProcesses=yes/);
  assert.match(text, /loginctl enable-linger archer/);
  assert.match(text, /\/home\/archer\/\.local\/bin\/raft-computer stop/);
  assert.match(text, /systemd-run --user --unit=raft-computer --setenv=RAFT_HOME=\/home\/archer\/\.raft .*-p OOMPolicy=continue .*-p RestartPreventExitStatus="77 78" -p StartLimitIntervalSec=600 -p StartLimitBurst=\d+ \/home\/archer\/\.local\/bin\/raft-computer start --foreground/);
  const lingering = formatLogindSessionRisk(
    { sessionScope: "session-24.scope", user: "archer", linger: true },
    { command: ["/usr/local/bin/node", "/opt/raft dir/raft-computer.js"], raftHome: "/home/archer/.raft" },
  ).join("\n");
  assert.doesNotMatch(lingering, /enable-linger/);
  assert.match(lingering, /\/usr\/local\/bin\/node '\/opt\/raft dir\/raft-computer\.js' start --foreground/);
  assert.match(lingering, /reset-failed raft-computer/);
});
