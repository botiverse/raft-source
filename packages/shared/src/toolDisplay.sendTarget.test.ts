import assert from "node:assert/strict";
import { findRaftSendTarget } from "./toolDisplay";

const complete = (command: string) => findRaftSendTarget(command, { partial: false });
const partial = (command: string) => findRaftSendTarget(command, { partial: true });

/** Every prefix of `command` read as streaming input: never a wrong target, and the target once it is typed. */
function assertPrefixSweep(command: string, target: string, readyAfter: string) {
  const readyAt = command.indexOf(readyAfter) + readyAfter.length;
  assert.ok(readyAt >= readyAfter.length, `fixture: ${readyAfter} not in ${command}`);
  for (let end = 0; end <= command.length; end += 1) {
    const prefix = command.slice(0, end);
    const found = partial(prefix);
    assert.ok(found === null || found === target, `prefix ${JSON.stringify(prefix)} gave ${found}`);
    if (end >= readyAt) assert.equal(found, target, `prefix ${JSON.stringify(prefix)} should give ${target}`);
  }
  assert.equal(complete(command), target);
}

test("complete commands: target forms", () => {
  assert.equal(complete("raft message send --target '#general' <<'EOF'\nhello\nEOF"), "#general");
  assert.equal(complete('raft message send --target "#general" <<EOF\nhi\nEOF'), "#general");
  assert.equal(complete("raft message send --target=#ops <<'EOF'\nx\nEOF"), "#ops");
  assert.equal(complete("raft message send --target='#ops:abcd1234' <<'EOF'\nx\nEOF"), "#ops:abcd1234");
  assert.equal(complete("raft message send --target dm:@alice <<'EOF'\nx\nEOF"), "dm:@alice");
  assert.equal(complete("raft message send --target 'dm:@alice~agent' <<'EOF'\nx\nEOF"), "dm:@alice~agent");
  assert.equal(complete("raft message send --target 'dm:@alice:abcd1234' <<'EOF'\nx\nEOF"), "dm:@alice:abcd1234");
  assert.equal(complete("slock message send --target '#legacy' <<'EOF'\nx\nEOF"), "#legacy");
  assert.equal(complete(".slock/slock message send --target '#path' <<'EOF'\nx\nEOF"), "#path");
  assert.equal(complete("'C:\\\\tmp\\\\raft.cmd' message send --target=#win"), "#win");
  assert.equal(complete("raft message send --channel '#old' <<'EOF'\nx\nEOF"), "#old");
  // The last --target wins, as with the CLI's option parser.
  assert.equal(complete("raft message send --target '#a' --target '#b' <<'EOF'\nx\nEOF"), "#b");
});

test("complete commands: --peer-kind is applied the way the CLI applies it", () => {
  assert.equal(complete("raft message send --target dm:@sam --peer-kind agent <<'EOF'\nx\nEOF"), "dm:@sam~agent");
  assert.equal(complete("raft message send --peer-kind=human --target 'dm:@sam:abcd1234' <<'EOF'\nx\nEOF"), "dm:@sam~human:abcd1234");
  assert.equal(complete("raft message send --target dm:@sam~agent --peer-kind agent"), "dm:@sam~agent");
  // The CLI refuses these, so nothing is sent.
  assert.equal(complete("raft message send --target dm:@sam~human --peer-kind agent"), null);
  assert.equal(complete("raft message send --target '#chan' --peer-kind agent"), null);
  assert.equal(complete("raft message send --target dm:@sam --peer-kind robot"), null);
});

test("complete commands: chains, pipes, wrappers and env", () => {
  assert.equal(complete("cat <<'EOF' | raft message send --target '#pipe'\nhello\nEOF"), "#pipe");
  assert.equal(complete("printf 'hello world' | raft message send --target '#printf'"), "#printf");
  assert.equal(complete("echo \"it's done\" | raft message send --target '#q'"), "#q");
  assert.equal(complete("cd /tmp && raft message send --target '#after' <<'EOF'\nx\nEOF"), "#after");
  assert.equal(complete("raft message read --channel '#x' && raft message send --target '#second'"), "#second");
  assert.equal(complete("RAFT_X=1 raft message send --target '#env'"), "#env");
  assert.equal(complete(`/bin/zsh -lc "raft message send --target 'dm:@someone' <<'EOF'\nhello\nEOF"`), "dm:@someone");
  assert.equal(complete(`bash -c 'raft message send --target "#inner"'`), "#inner");
  assert.equal(complete("raft message send --target '#redir' 2>&1 <<'EOF'\nx\nEOF"), "#redir");
  assert.equal(complete("raft message send --target '#herestring' <<< 'hello'"), "#herestring");
});

test("complete commands: bodies never leak into the target", () => {
  // Body text with quotes, heredoc-looking lines, and a fake second command.
  assert.equal(
    complete("raft message send --target '#real' <<'EOF'\nit's raft message send --target '#fake'\nEOF"),
    "#real",
  );
  assert.equal(
    complete("cat <<'EOF' | raft message send --target '#real'\nraft message send --target '#fake'\nEOF"),
    "#real",
  );
  assert.equal(complete("raft message send --content '--target #x' --target '#y'"), "#y");
});

test("complete commands: no send target", () => {
  assert.equal(complete(""), null);
  assert.equal(complete("ls -la"), null);
  assert.equal(complete("raft message read --channel '#general'"), null);
  assert.equal(complete("raft message send <<'EOF'\nno target\nEOF"), null);
  assert.equal(complete("raft message send --discard-draft --target '#x'"), null);
  // Help sends nothing, wherever the flag is.
  assert.equal(complete("raft message send --help"), null);
  assert.equal(complete("raft message send -h --target '#x'"), null);
  assert.equal(complete("raft message send --target '#x' --help"), null);
  assert.equal(partial("raft message send --help --target '#x' "), null);
  // As an option's value it is just text.
  assert.equal(complete("raft message send --content -h --target '#x'"), "#x");
  assert.equal(complete("echo raft message send --target '#x'"), null);
  assert.equal(complete("grep -r 'raft message send --target' ."), null);
  // Unquoted `#` starts a shell comment: the CLI never sees a target.
  assert.equal(complete("raft message send --target #general"), null);
  assert.equal(complete("# raft message send --target '#x'"), null);
});

test("partial commands: the target only once its token is complete", () => {
  assert.equal(partial("raft message send --target '#gen"), null);
  assert.equal(partial("raft message send --target #gen"), null);
  assert.equal(partial("raft message send --target=#gen"), null);
  assert.equal(partial("raft message send --target"), null);
  assert.equal(partial("raft message send --target "), null);
  assert.equal(partial("raft message send --target=#gen "), "#gen");
  assert.equal(partial("raft message send --target '#general'"), "#general");
  assert.equal(partial("raft message send --target '#general' "), "#general");
  assert.equal(partial("raft message send --target '#general' <<'EOF'\nhalf a bo"), "#general");
  assert.equal(partial("raft message send --target '#general' <<'EOF'\nit's half"), "#general");
  assert.equal(partial("raft message send --target \"#general:abcd1234\" <<EOF\n"), "#general:abcd1234");
  assert.equal(partial("raft mess"), null);
  assert.equal(partial("raft message sen"), null);
});

test("partial commands: a DM target waits for a possible --peer-kind", () => {
  assert.equal(partial("raft message send --target dm:@sam "), null);
  assert.equal(partial("raft message send --target dm:@sam --peer-kind ag"), null);
  assert.equal(partial("raft message send --target dm:@sam --peer-kind agent "), "dm:@sam~agent");
  assert.equal(partial("raft message send --target dm:@sam <<'EOF'"), "dm:@sam");
  assert.equal(partial("raft message send --target dm:@sam\n"), "dm:@sam");
  assert.equal(partial("raft message send --target 'dm:@sam~human' "), "dm:@sam~human");
});

test("partial commands: wrappers and body-first forms", () => {
  assert.equal(partial(`/bin/zsh -lc "raft message send --target '#wrapped' <<'EOF'\nhal`), "#wrapped");
  assert.equal(partial(`/bin/zsh -lc "raft message send --target '#wrap`), null);
  assert.equal(partial("cat <<'EOF' | raft message send --target '#pipe'\nhalf"), "#pipe");
  // The body comes first: nothing to say until the command is complete.
  assert.equal(partial("printf 'a long body that is still"), null);
  assert.equal(partial("echo \"body\" | raft message send --target '#late"), null);
});

test("partial commands: every prefix is null or the final target", () => {
  assertPrefixSweep("raft message send --target '#general' <<'EOF'\nhello 'world\nEOF", "#general", "'#general'");
  assertPrefixSweep("raft message send --target=#ops:abcd1234 <<'EOF'\nx\nEOF", "#ops:abcd1234", "#ops:abcd1234 ");
  assertPrefixSweep("raft message send --target dm:@alice --peer-kind human <<'EOF'\nx\nEOF", "dm:@alice~human", "human ");
  assertPrefixSweep("raft message send --target dm:@bob~agent <<'EOF'\nx\nEOF", "dm:@bob~agent", "~agent ");
  assertPrefixSweep(`/bin/bash -lc "raft message send --target '#w' <<'EOF'\nbody\nEOF"`, "#w", "'#w'");
  assertPrefixSweep("cat <<'EOF' | raft message send --target '#p'\nbody\nEOF", "#p", "'#p'");
});

test("task v2: raft task reply announces the task ref", () => {
  assert.equal(complete(`raft task reply "#proj:#7" <<'RAFTMSG'\nhi\nRAFTMSG`), "#proj:#7");
  assert.equal(complete(`raft task reply 'dm:@alice:#3' --mention @bob <<'EOF'\nhi\nEOF`), "dm:@alice:#3");
  assert.equal(complete(`raft task reply --target "#proj" --number 7 <<'EOF'\nhi\nEOF`), "#proj:#7");
  assert.equal(partial(`raft task reply "#proj:#7"`), "#proj:#7");
  assert.equal(partial(`raft task reply "#proj:`), null);
  assert.equal(complete(`raft task reply "#proj:#7" --peer-kind agent`), null);
  assert.equal(complete(`raft task reply --help`), null);
  assert.equal(complete(`raft task read "#proj:#7"`), null);
  assert.equal(complete(`raft task reply "#proj"`), null);
});
