import assert from "node:assert/strict";
import test from "node:test";

import { Command } from "commander";

import { defineCommand, registerCliCommand } from "./command.js";
import { CliError, CliExit } from "./errors.js";
import type { CliIo } from "./io.js";

function memoryIo(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: { write: (chunk: string | Uint8Array) => { stdout.push(String(chunk)); return true; } },
      stderr: { write: (chunk: string | Uint8Array) => { stderr.push(String(chunk)); return true; } },
    },
  };
}

function readLabeledLine(output: string, label: string): string | null {
  const prefix = `${label}: `;
  const line = output.split("\n").find((candidate) => candidate.startsWith(prefix));
  return line ? line.slice(prefix.length) : null;
}

test("registered command receives injected context and writes through injected io", async () => {
  const { io, stdout, stderr } = memoryIo();
  const program = new Command();
  program.exitOverride();
  registerCliCommand(
    program,
    defineCommand(
      {
        name: "fixture",
        description: "fixture command",
      },
      (ctx) => {
        ctx.io.stdout.write("ok\n");
      },
    ),
    { io },
  );

  await program.parseAsync(["node", "slock", "fixture"]);

  assert.deepEqual(stdout, ["ok\n"]);
  assert.deepEqual(stderr, []);
});

test("registered command renders CliError as canonical text stderr", async () => {
  const { io, stdout, stderr } = memoryIo();
  const program = new Command();
  program.exitOverride();
  registerCliCommand(
    program,
    defineCommand(
      {
        name: "fixture",
        description: "fixture command",
      },
      () => {
        throw new CliError({
          code: "INVALID_ARG",
          message: "bad input",
          suggestedNextAction: "Pass a valid fixture argument.",
        });
      },
    ),
    { io },
  );

  await assert.rejects(
    () => program.parseAsync(["node", "slock", "fixture"]),
    /CliExit\(1\)/,
  );

  assert.deepEqual(stdout, []);
  const rendered = stderr.join("");
  assert.equal(rendered, "Error: bad input\nCode: INVALID_ARG\nNext action: Pass a valid fixture argument.\n");
  assert.equal(readLabeledLine(rendered, "Code"), "INVALID_ARG");
  assert.equal(readLabeledLine(rendered, "Next action"), "Pass a valid fixture argument.");
});

test("registered command renders optional draft-saved visibility line", async () => {
  const { io, stdout, stderr } = memoryIo();
  const program = new Command();
  program.exitOverride();
  registerCliCommand(
    program,
    defineCommand(
      {
        name: "fixture",
        description: "fixture command",
      },
      () => {
        throw new CliError({
          code: "SERVER_5XX",
          message: "failed to proxy local agent request",
          draftSaved: false,
        });
      },
    ),
    { io },
  );

  await assert.rejects(
    () => program.parseAsync(["node", "slock", "fixture"]),
    /CliExit\(1\)/,
  );

  assert.deepEqual(stdout, []);
  const rendered = stderr.join("");
  assert.equal(rendered, "Error: failed to proxy local agent request\nCode: SERVER_5XX\nDraft saved: no\n");
  assert.equal(readLabeledLine(rendered, "Draft saved"), "no");
});

test("registered command renders stable effect and retryability fields", async () => {
  const { io, stdout, stderr } = memoryIo();
  const program = new Command();
  program.exitOverride();
  registerCliCommand(
    program,
    defineCommand(
      {
        name: "fixture",
        description: "fixture command",
      },
      () => {
        throw new CliError({
          code: "SEND_HELD_AS_DRAFT",
          message: "message did not reach the target",
          effect: "draft_saved",
          retryable: false,
        });
      },
    ),
    { io },
  );

  await assert.rejects(
    () => program.parseAsync(["node", "slock", "fixture"]),
    /CliExit\(1\)/,
  );

  assert.deepEqual(stdout, []);
  const rendered = stderr.join("");
  assert.equal(
    rendered,
    "Error: message did not reach the target\n"
      + "Code: SEND_HELD_AS_DRAFT\n"
      + "Retryable: no\n"
      + "Effect: draft_saved\n",
  );
  assert.equal(readLabeledLine(rendered, "Effect"), "draft_saved");
  assert.equal(readLabeledLine(rendered, "Retryable"), "no");
});

test("registered command renders optional proxy diagnostics", async () => {
  const { io, stdout, stderr } = memoryIo();
  const program = new Command();
  program.exitOverride();
  registerCliCommand(
    program,
    defineCommand(
      {
        name: "fixture",
        description: "fixture command",
      },
      () => {
        throw new CliError({
          code: "PROXY_5XX",
          message: "failed to proxy local agent request",
          layer: "local_daemon_proxy",
          correlationId: "0123456789abcdef",
          proxyFailureClass: "pre_response_transport",
          proxyCauseCode: "UND_ERR_CONNECT_TIMEOUT",
          proxyRouteFamily: "tasks/claim",
          proxyUpstreamLayer: "tcp",
          proxyUpstreamStatus: 502,
          proxyResponseStarted: false,
          proxyResponseComplete: false,
          suggestedNextAction: "Inspect daemon proxy logs.",
        });
      },
    ),
    { io },
  );

  await assert.rejects(
    () => program.parseAsync(["node", "slock", "fixture"]),
    /CliExit\(1\)/,
  );

  assert.deepEqual(stdout, []);
  const rendered = stderr.join("");
  assert.equal(
    rendered,
    "Error: failed to proxy local agent request\n"
      + "Code: PROXY_5XX\n"
      + "Layer: local_daemon_proxy\n"
      + "Correlation: 0123456789abcdef\n"
      + "Proxy failure class: pre_response_transport\n"
      + "Proxy cause code: UND_ERR_CONNECT_TIMEOUT\n"
      + "Proxy route family: tasks/claim\n"
      + "Proxy upstream layer: tcp\n"
      + "Proxy upstream status: 502\n"
      + "Proxy response started: no\n"
      + "Proxy response complete: no\n"
      + "Next action: Inspect daemon proxy logs.\n",
  );
  assert.equal(readLabeledLine(rendered, "Layer"), "local_daemon_proxy");
  assert.equal(readLabeledLine(rendered, "Correlation"), "0123456789abcdef");
  assert.equal(readLabeledLine(rendered, "Proxy failure class"), "pre_response_transport");
  assert.equal(readLabeledLine(rendered, "Proxy cause code"), "UND_ERR_CONNECT_TIMEOUT");
  assert.equal(readLabeledLine(rendered, "Fault domain"), null, "fault_domain alias should not duplicate Layer");
});

test("registered command JSON errors preserve proxy diagnostics and details together", async () => {
  const { io, stdout, stderr } = memoryIo();
  const program = new Command();
  program.exitOverride();
  registerCliCommand(
    program,
    defineCommand(
      {
        name: "fixture",
        description: "fixture command",
      },
      () => {
        throw new CliError({
          code: "PROXY_5XX",
          message: "failed to proxy local agent request",
          outputMode: "json",
          layer: "local_daemon_proxy",
          correlationId: "0123456789abcdef",
          proxyFailureClass: "pre_response_transport",
          proxyCauseCode: "UND_ERR_CONNECT_TIMEOUT",
          proxyRouteFamily: "messages/send",
          proxyUpstreamLayer: "tcp",
          proxyUpstreamStatus: 502,
          proxyResponseStarted: false,
          proxyResponseComplete: false,
          details: {
            result: {
              state: "partial",
              message: { status: "queued", id: "message-1" },
            },
          },
        });
      },
    ),
    { io },
  );

  await assert.rejects(
    () => program.parseAsync(["node", "slock", "fixture"]),
    /CliExit\(1\)/,
  );

  assert.deepEqual(stdout, []);
  const rendered = stderr.join("");
  assert.equal(rendered.trim().split("\n").length, 1, "JSON error mode must render one document");
  const parsed = JSON.parse(rendered);
  assert.equal(parsed.error.code, "PROXY_5XX");
  assert.deepEqual(parsed.error.proxy, {
    correlation_id: "0123456789abcdef",
    failure_class: "pre_response_transport",
    cause_code: "UND_ERR_CONNECT_TIMEOUT",
    route_family: "messages/send",
    upstream_layer: "tcp",
    upstream_status: 502,
    response_started: false,
    response_complete: false,
  });
  assert.deepEqual(parsed.details, {
    result: {
      state: "partial",
      message: { status: "queued", id: "message-1" },
    },
  });
});

test("registered command renders explicit distinct fault domain alongside layer", async () => {
  const { io, stdout, stderr } = memoryIo();
  const program = new Command();
  program.exitOverride();
  registerCliCommand(
    program,
    defineCommand(
      {
        name: "fixture",
        description: "fixture command",
      },
      () => {
        throw new CliError({
          code: "LOCAL_WRITE_SOURCE_FAILED",
          message: "failed to read response body from service",
          layer: "transport",
          faultDomain: "file_write:source_read",
          suggestedNextAction: "Retry once.",
        });
      },
    ),
    { io },
  );

  await assert.rejects(
    () => program.parseAsync(["node", "slock", "fixture"]),
    /CliExit\(1\)/,
  );

  assert.deepEqual(stdout, []);
  const rendered = stderr.join("");
  assert.equal(
    rendered,
    "Error: failed to read response body from service\n"
      + "Code: LOCAL_WRITE_SOURCE_FAILED\n"
      + "Fault domain: file_write:source_read\n"
      + "Layer: transport\n"
      + "Next action: Retry once.\n",
  );
  assert.equal(readLabeledLine(rendered, "Fault domain"), "file_write:source_read");
  assert.equal(readLabeledLine(rendered, "Layer"), "transport");
});

test("registered command renders bootstrap errors with recovery text", async () => {
  const { io, stdout, stderr } = memoryIo();
  const program = new Command();
  program.exitOverride();
  registerCliCommand(
    program,
    defineCommand(
      {
        name: "fixture",
        description: "fixture command",
      },
      (ctx) => {
        ctx.loadAgentContext();
      },
    ),
    {
      io,
      env: {},
    },
  );

  await assert.rejects(
    () => program.parseAsync(["node", "slock", "fixture"]),
    /CliExit\(1\)/,
  );

  assert.deepEqual(stdout, []);
  const rendered = stderr.join("");
  assert.equal(
    rendered,
    "Error: SLOCK_AGENT_ID is required\n"
      + "Code: MISSING_AGENT_ID\n"
      + "Next action: Use a Raft profile with `raft --profile <slug> ...`; create one with `raft agent login --server <server-url> --agent <agent-id> --profile-slug <slug>`.\n",
  );
  assert.equal(readLabeledLine(rendered, "Code"), "MISSING_AGENT_ID");
  assert.match(readLabeledLine(rendered, "Next action") ?? "", /raft agent login/);
});

test("registered command supports repeatable option parsers", async () => {
  const { io, stdout } = memoryIo();
  const program = new Command();
  program.exitOverride();
  registerCliCommand(
    program,
    defineCommand(
      {
        name: "fixture",
        description: "fixture command",
        options: [
          {
            flags: "--item <value>",
            description: "Repeatable value",
            parse: (value, previous: string[] = []) => previous.concat(value),
          },
        ],
      },
      (ctx, opts: { item?: string[] }) => {
        ctx.io.stdout.write(JSON.stringify(opts.item ?? []) + "\n");
      },
    ),
    { io },
  );

  await program.parseAsync(["node", "slock", "fixture", "--item", "a", "--item", "b"]);

  assert.deepEqual(stdout, ['["a","b"]\n']);
});

test("a handler-thrown CliExit passes through without an INTERNAL_BUG rendering (task #60)", async () => {
  const { io, stderr } = memoryIo();
  const program = new Command();
  program.exitOverride();
  registerCliCommand(
    program,
    defineCommand(
      {
        name: "exit-fixture",
        description: "throws the sanctioned silent exit",
      },
      (ctx) => {
        ctx.io.stdout.write("per-row account already written\n");
        throw new CliExit(1);
      },
    ),
    { io },
  );

  await assert.rejects(
    program.parseAsync(["node", "slock", "exit-fixture"]),
    (error: unknown) => error instanceof CliExit && error.exitCode === 1,
  );
  // The whole defect: the wrapper used to wrap CliExit into InternalBugError,
  // printing "Unexpected error: CliExit(1) / Code: INTERNAL_BUG" over a normal
  // refusal. Nothing internal happened, so stderr must not claim it did.
  const rendered = stderr.join("");
  assert.doesNotMatch(rendered, /INTERNAL_BUG/);
  assert.doesNotMatch(rendered, /Unexpected error/);
});
