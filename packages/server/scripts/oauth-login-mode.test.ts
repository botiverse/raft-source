import assert from "node:assert/strict";
import {
  main,
  OAuthLoginModeRefusal,
  OAuthLoginModeUsageError,
  parseOAuthLoginModeArgs,
  validateSwitchInput,
} from "./oauth-login-mode";

// The script's arguments and exit codes before it touches a database. What it
// reads and writes is tested against the migrated schema in
// src/routes/oauthLoginModeSwitch.api.test.ts.

const SWITCH = ["switch", "--client", "vault", "--review", "https://stamp.build/github/botiverse/slock/pull/1", "--reason", "Vault moves to account mode (RFC 079 3c)"];

test("show names one App by its client id, trimmed; it takes nothing else", () => {
  assert.deepEqual(parseOAuthLoginModeArgs(["--", "show", "--client", "vault"]), { command: "show", client: "vault" });
  assert.deepEqual(parseOAuthLoginModeArgs(["show", "--client", "  Vault-App_2  "]), { command: "show", client: "Vault-App_2" });
  assert.throws(() => parseOAuthLoginModeArgs(["show"]), /--client is the App's client id/);
  assert.throws(() => parseOAuthLoginModeArgs(["show", "--client", "two words"]), /printable ASCII/);
  assert.throws(() => parseOAuthLoginModeArgs(["show", "--client", "vaulté"]), /printable ASCII/);
  assert.throws(() => parseOAuthLoginModeArgs(["show", "--client", "x".repeat(129)]), /1 to 128/);
  assert.equal(parseOAuthLoginModeArgs(["show", "--client", "x".repeat(128)]).client.length, 128);
  assert.throws(() => parseOAuthLoginModeArgs(["show", "--client", "vault", "--reason", "x"]), /unknown argument: --reason/);
  assert.throws(() => parseOAuthLoginModeArgs(["show", "--client", "vault", "--client", "other"]), /--client given twice/);
});

test("there is no command but show and switch: no way back to server mode", () => {
  for (const command of ["unswitch", "revert", "server", "set", undefined]) {
    assert.throws(() => parseOAuthLoginModeArgs(command === undefined ? [] : [command, "--client", "vault"]), (error: unknown) => {
      assert.ok(error instanceof OAuthLoginModeUsageError);
      assert.match(error.message, /the command is show or switch \(there is no switching back\)/);
      return true;
    });
  }
  assert.throws(() => parseOAuthLoginModeArgs([...SWITCH, "--to", "server"]), /unknown argument: --to/);
});

test("switch needs --review and --reason, trimmed and bounded; --operator is optional", () => {
  assert.deepEqual(parseOAuthLoginModeArgs(["--", ...SWITCH]), {
    command: "switch",
    client: "vault",
    review: "https://stamp.build/github/botiverse/slock/pull/1",
    reason: "Vault moves to account mode (RFC 079 3c)",
  });
  assert.deepEqual(parseOAuthLoginModeArgs(["switch", "--client", " vault ", "--review", "  #wg-apps:4f2a  ", "--reason", "  line one\nline two\t ", "--operator", "  Alice  "]), {
    command: "switch", client: "vault", review: "#wg-apps:4f2a", reason: "line one\nline two", operator: "Alice",
  });
  const without = (flag: string) => {
    const at = SWITCH.indexOf(flag);
    return [...SWITCH.slice(0, at), ...SWITCH.slice(at + 2)];
  };
  const withValue = (flag: string, value: string) => SWITCH.map((arg, i) => (SWITCH[i - 1] === flag ? value : arg));
  assert.throws(() => parseOAuthLoginModeArgs(without("--review")), /--review is required/);
  assert.throws(() => parseOAuthLoginModeArgs(withValue("--review", "   ")), /--review is required/);
  assert.throws(() => parseOAuthLoginModeArgs(withValue("--review", "x".repeat(501))), /--review is required/);
  assert.throws(() => parseOAuthLoginModeArgs(withValue("--review", "ref\nsecond line")), /--review is required/);
  assert.throws(() => parseOAuthLoginModeArgs(without("--reason")), /--reason is required/);
  assert.throws(() => parseOAuthLoginModeArgs(withValue("--reason", " \n ")), /--reason is required/);
  assert.throws(() => parseOAuthLoginModeArgs(withValue("--reason", "x".repeat(1001))), /--reason is required: 1 to 1000/);
  assert.equal((parseOAuthLoginModeArgs(withValue("--reason", "x".repeat(1000))) as { reason: string }).reason.length, 1000);
  assert.throws(() => parseOAuthLoginModeArgs(withValue("--reason", "bell\u0007")), /no control characters/);
  assert.throws(() => parseOAuthLoginModeArgs(without("--client")), /--client is the App's client id/);
  assert.throws(() => parseOAuthLoginModeArgs([...SWITCH, "--operator", " "]), /--operator is your name/);
  assert.throws(() => parseOAuthLoginModeArgs(["switch", "--client", "vault", "--review", "--reason", "x"]), /--review needs a value/);
  assert.throws(() => parseOAuthLoginModeArgs([...SWITCH, "--review", "again"]), /--review given twice/);
});

test("the exported switch input check is the same rule, as a refusal", () => {
  const input = { client: "vault", review: "ref", reason: "why", operator: "alice" };
  assert.deepEqual(validateSwitchInput({ ...input, reason: "  why  " }), input);
  for (const [field, value] of [["review", ""], ["review", undefined], ["reason", "  "], ["reason", "x".repeat(1001)], ["operator", ""], ["client", ""]] as const) {
    assert.throws(() => validateSwitchInput({ ...input, [field]: value }), (error: unknown) => {
      assert.ok(error instanceof OAuthLoginModeRefusal, field);
      assert.equal(error.code, "invalid_input");
      return true;
    });
  }
});

test("the CLI exits 2 on bad arguments, a missing operator or no DATABASE_URL, before it opens a database", async () => {
  const run = async (argv: string[], env: NodeJS.ProcessEnv) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(argv, env, { out: (line) => out.push(line), err: (line) => err.push(line) });
    return { code, out, err: err.join("\n") };
  };
  const env = { DATABASE_URL: "postgres://unused.invalid/none", USER: "alice" };

  const bad = await run(["switch", "--client", "vault", "--reason", "why"], env);
  assert.deepEqual([bad.code, bad.out], [2, []]);
  assert.match(bad.err, /--review is required/);

  const noOperator = await run(SWITCH, { DATABASE_URL: env.DATABASE_URL });
  assert.equal(noOperator.code, 2);
  assert.match(noOperator.err, /name the operator: --operator <name>/);
  assert.equal((await run(SWITCH, { DATABASE_URL: env.DATABASE_URL, USER: "  " })).code, 2);
  // $USER goes through the operator rule too.
  assert.match((await run(SWITCH, { DATABASE_URL: env.DATABASE_URL, USER: "a\u0000b" })).err, /--operator is your name/);

  for (const argv of [SWITCH, ["show", "--client", "vault"]]) {
    const noUrl = await run(argv, { USER: "alice" });
    assert.deepEqual([noUrl.code, noUrl.out, noUrl.err], [2, [], "DATABASE_URL is required"]);
  }
});
