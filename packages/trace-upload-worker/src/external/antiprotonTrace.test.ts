import assert from "node:assert/strict";
import { handleRequest, type TraceUploadWorkerEnv } from "../index";

const TOKEN = "external-antiproton-trace-token-for-tests";

function env(overrides: Partial<TraceUploadWorkerEnv> = {}) {
  const calls: Array<{ url: string; body: string }> = [];
  const value: TraceUploadWorkerEnv = {
    SCOPE_ATTESTATION_SECRET: "unused",
    TRACE_BUNDLES: { put: async () => ({}) },
    TRACE_INGEST_OTLP_ENDPOINT: "https://telescope.test/v1/traces",
    TRACE_INGEST_FETCH: (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: String(init?.body ?? "") });
      return new Response(null, { status: 200 });
    }) as typeof fetch,
    EXTERNAL_ANTIPROTON_TRACE_TOKEN: TOKEN,
    DEPLOYMENT_ENV: "production",
    ...overrides,
  };
  return { env: value, calls };
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    at: "2026-10-20T23:19:00.000Z",
    kind: "turn.timing",
    tenant_id: "raft_036dc685",
    agent_id: "raft_77e9fc9e",
    seq: 101,
    span_id: "sp_0001",
    env: "preview",
    status: "ok",
    verdict: "ok",
    ms: 90_412,
    inbound_to_start_ms: 812,
    model_ms: 61_002,
    tools: 7,
    ...overrides,
  };
}

function post(body: unknown, token: string | null = TOKEN) {
  return new Request("https://trace-worker.test/api/external/antiproton-trace", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
}

function records(body: string) {
  const payload = JSON.parse(body);
  return payload.resourceLogs[0].scopeLogs[0].logRecords.map((record: any) => ({
    name: record.body.stringValue,
    attrs: Object.fromEntries(record.attributes.map((a: any) => [a.key, a.value.stringValue ?? a.value.intValue ?? a.value.boolValue ?? a.value.doubleValue])),
  }));
}

test("antiproton-trace forwards allowlisted kinds as antiproton.<kind> OTLP logs with a dedup key", async () => {
  const { env: e, calls } = env();
  const res = await handleRequest(post({
    rows: [
      row(),
      row({ kind: "model.attempt", seq: 102, span_id: "call_a1|fc_b2", attempt: 2, phase: "call", outcome: "http", http_status: 529, error_class: "OverloadedError", total_ms: 36_100, provider_ms: 35_900, model: "anthropic/claude-sonnet" }),
    ],
  }), e);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, accepted: 2, rejected: [] });
  assert.equal(calls[0].url, "https://telescope.test/v1/logs");
  const payload = JSON.parse(calls[0].body);
  const resource = payload.resourceLogs[0].resource.attributes;
  assert.ok(resource.some((a: any) => a.key === "service.name" && a.value.stringValue === "antiproton"));
  const [timing, attempt] = records(calls[0].body);
  assert.equal(timing.name, "antiproton.turn.timing");
  assert.equal(String(timing.attrs.model_ms), "61002");
  assert.equal(timing.attrs["slock.trace_ingest.event_key"], "raft_036dc685:raft_77e9fc9e:101");
  assert.equal(attempt.name, "antiproton.model.attempt");
  assert.equal(attempt.attrs.phase, "call");
  assert.equal(attempt.attrs.model, "anthropic/claude-sonnet");
  assert.equal(attempt.attrs.span_id, "call_a1|fc_b2");
  assert.equal(String(attempt.attrs.http_status), "529");
  assert.equal(attempt.attrs.error_class, "OverloadedError");
  assert.equal(attempt.attrs["slock.trace_ingest.event_key"], "raft_036dc685:raft_77e9fc9e:102");
});

test("antiproton-trace drops unknown fields, free text, other kinds' fields and out-of-set enums", async () => {
  const { env: e, calls } = env();
  const res = await handleRequest(post({
    rows: [
      row({
        kind: "tool.call",
        tool: "artifacts.read",
        error_code: "Tool failed: secret file /home/x",
        stop_reason: "toolUse",
        error: "ENOENT: no such file, open '/home/x/.env'",
        args: { path: "/home/x/.env" },
        model_ms: 5,
        exit_code: -1,
      }),
      row({ kind: "raft.assistant_wake", result: "invoked", caught_up_via: "somewhere", candidates: 1, conversations: -3 }),
    ],
  }), e);
  assert.equal(res.status, 200);
  for (const leaked of ["secret file", "ENOENT", "/home/x", "somewhere"]) assert.ok(!calls[0].body.includes(leaked), leaked);
  const [tool, wake] = records(calls[0].body);
  assert.equal(tool.attrs.tool, "artifacts.read");
  assert.equal(String(tool.attrs.exit_code), "-1");
  assert.equal(tool.attrs.model_ms, undefined);
  assert.equal(wake.attrs.result, "invoked");
  assert.equal(String(wake.attrs.candidates), "1");
  assert.equal(wake.attrs.conversations, undefined);
});

test("antiproton-trace drops invalid rows, reports them, and ingests the rest of the batch", async () => {
  const { env: e, calls } = env();
  const bad = [
    [{ kind: "inbound" }, "kind_not_allowed"],
    [{ kind: "__proto__" }, "kind_not_allowed"],
    [{ agent_id: "has spaces" }, "identity_invalid"],
    [{ seq: undefined }, "seq_invalid"],
    [{ seq: -1 }, "seq_invalid"],
    [{ env: "staging" }, "env_invalid"],
  ] as const;
  const res = await handleRequest(post({ rows: [...bad.map(([o]) => row(o)), row({ seq: 200 })] }), e);
  assert.equal(res.status, 200);
  const json = await res.json() as { accepted: number; rejected: Array<{ index: number; reason: string }> };
  assert.equal(json.accepted, 1);
  assert.deepEqual(json.rejected, bad.map(([, reason], index) => ({ index, reason })));
  assert.equal(calls.length, 1);
  assert.equal(records(calls[0].body).length, 1);
});

test("antiproton-trace: a batch of only invalid rows posts nothing; a malformed body is still 400", async () => {
  const { env: e, calls } = env();
  const res = await handleRequest(post({ rows: [row({ kind: "inbound" })] }), e);
  assert.equal(res.status, 200);
  assert.equal(calls.length, 0);
  assert.equal((await handleRequest(post({ notRows: [] }), e)).status, 400);
  assert.equal((await handleRequest(post({ rows: ["not an object"] }), e)).status, 200);
});

test("antiproton-trace auth: unset token = 404, wrong or missing bearer = 401", async () => {
  assert.equal((await handleRequest(post({ rows: [row()] }), env({ EXTERNAL_ANTIPROTON_TRACE_TOKEN: undefined }).env)).status, 404);
  assert.equal((await handleRequest(post({ rows: [row()] }, "wrong"), env().env)).status, 401);
  assert.equal((await handleRequest(post({ rows: [row()] }, null), env().env)).status, 401);
});

test("antiproton-trace without a sink answers 503 so the sender retries", async () => {
  const res = await handleRequest(post({ rows: [row()] }), env({ TRACE_INGEST_OTLP_ENDPOINT: undefined }).env);
  assert.equal(res.status, 503);
});

test("antiproton-trace accepts the shared github-refresh token when no dedicated token is set", async () => {
  const shared = env({ EXTERNAL_ANTIPROTON_TRACE_TOKEN: undefined, EXTERNAL_GITHUB_REFRESH_TOKEN: "shared-ingest-token" });
  assert.equal((await handleRequest(post({ rows: [row()] }, "shared-ingest-token"), shared.env)).status, 200);
  assert.equal((await handleRequest(post({ rows: [row()] }, TOKEN), shared.env)).status, 401);
});

test("antiproton-trace keeps real mixed-case codes and drops sentences", async () => {
  const { env: e, calls } = env();
  const res = await handleRequest(post({
    rows: [
      row({ kind: "model.call", stop_reason: "toolUse" }),
      row({ kind: "tool.call", seq: 103, error_code: "NOT_FOUND" }),
      row({ kind: "turn.stop", seq: 104, trigger: "owner", error_class: "stopped: by owner", turn: "t_9" }),
      row({ kind: "raft.assistant_wake", seq: 105, result: "inbox_lagging", inbox_lagging_gave_up: 1 }),
    ],
  }), e);
  assert.equal(res.status, 200);
  const [call, tool, stop, wake] = records(calls[0].body);
  assert.equal(call.attrs.stop_reason, "toolUse");
  assert.equal(tool.attrs.error_code, "NOT_FOUND");
  assert.equal(stop.attrs.error_class, undefined);
  assert.equal(stop.attrs.turn, "t_9");
  assert.ok(!calls[0].body.includes("stopped: by owner"));
  assert.equal(wake.attrs.result, "inbox_lagging");
});

test("antiproton-trace keeps mount_index on the kinds that carry a mount", async () => {
  const { env: e, calls } = env();
  const res = await handleRequest(post({
    rows: [
      row({ kind: "tool.call", seq: 301, tool: "raft.send", mount: "raft", mount_index: 2 }),
      row({ kind: "raft.assistant_wake", seq: 302, result: "invoked", mount_index: 0 }),
      row({ kind: "turn.timing", seq: 303, mount_index: 5 }),
    ],
  }), e);
  assert.equal(res.status, 200);
  const [tool, wake, timing] = records(calls[0].body);
  assert.equal(String(tool.attrs.mount_index), "2");
  assert.equal(tool.attrs.mount, "raft");
  assert.equal(String(wake.attrs.mount_index), "0");
  assert.equal(timing.attrs.mount_index, undefined);
});

test("antiproton-trace accepts assistant rules and told rows with counts and codes only", async () => {
  const { env: e, calls } = env();
  const res = await handleRequest(post({
    rows: [
      row({ kind: "raft.assistant_rules", seq: 401, status: "added", action: "add", result: "added", effect: "mute", scope: "channel",
        rules_total: 3, mute_channel: 2, always_person: 1, note: "mute #random please", channel: "C123" }),
      row({ kind: "raft.assistant_rules", seq: 402, action: "remove", result: "refused:no_such_rule", effect: "loud", digest_legacy: 4 }),
      row({ kind: "raft.assistant_chat_told", seq: 403, status: "told", told: 2 }),
    ],
  }), e);
  assert.equal(res.status, 200);
  for (const leaked of ["mute #random", "C123"]) assert.ok(!calls[0].body.includes(leaked), leaked);
  const [added, refused, told] = records(calls[0].body);
  assert.equal(added.name, "antiproton.raft.assistant_rules");
  assert.equal(added.attrs.result, "added");
  assert.equal(String(added.attrs.mute_channel), "2");
  assert.equal(String(added.attrs.always_person), "1");
  assert.equal(refused.attrs.result, "refused:no_such_rule");
  assert.equal(refused.attrs.effect, undefined);
  assert.equal(String(refused.attrs.digest_legacy), "4");
  assert.equal(told.name, "antiproton.raft.assistant_chat_told");
  assert.equal(String(told.attrs.told), "2");
});

test("antiproton-trace accepts send-as-owner rows without text, names or ids", async () => {
  const { env: e, calls } = env();
  const res = await handleRequest(post({
    rows: [
      row({ kind: "raft.assistant_send_as_owner", seq: 501, result: "sent", target_kind: "message", in_thread: true, chars: 42, http_status: 201,
        text: "hey alice, the owner says yes", target: "#general:9f1c2a", peer: "alice" }),
      row({ kind: "raft.assistant_send_as_owner", seq: 502, result: "refused:assistant_send_as_owner_off", target_kind: "group", chars: 7 }),
    ],
  }), e);
  assert.equal(res.status, 200);
  for (const leaked of ["owner says yes", "#general", "alice"]) assert.ok(!calls[0].body.includes(leaked), leaked);
  const [sent, refused] = records(calls[0].body);
  assert.equal(sent.name, "antiproton.raft.assistant_send_as_owner");
  assert.equal(sent.attrs.result, "sent");
  assert.equal(sent.attrs.in_thread, true);
  assert.equal(String(sent.attrs.http_status), "201");
  assert.equal(refused.attrs.result, "refused:assistant_send_as_owner_off");
  assert.equal(refused.attrs.target_kind, undefined);
});

test("antiproton-trace accepts reply_fallback chat_told rows with result and failure code only", async () => {
  const { env: e, calls } = env();
  const res = await handleRequest(post({
    rows: [
      row({ kind: "raft.assistant_chat_told", seq: 601, status: "reply_fallback", reply_fallback: 1, result: "failed", code: "dm_unread_hold",
        text: "Here is your summary of today" }),
      row({ kind: "raft.assistant_chat_told", seq: 602, status: "reply_fallback", reply_fallback: 1, result: "maybe" }),
    ],
  }), e);
  assert.equal(res.status, 200);
  assert.ok(!calls[0].body.includes("summary of today"));
  const [failed, odd] = records(calls[0].body);
  assert.equal(failed.attrs.status, "reply_fallback");
  assert.equal(failed.attrs.result, "failed");
  assert.equal(failed.attrs.code, "dm_unread_hold");
  assert.equal(String(failed.attrs.reply_fallback), "1");
  assert.equal(odd.attrs.result, undefined);
});

test("antiproton-trace keeps failed_turn as a count on chat_told rows", async () => {
  const { env: e, calls } = env();
  const res = await handleRequest(post({
    rows: [
      row({ kind: "raft.assistant_chat_told", seq: 701, status: "reply_fallback", reply_fallback: 1, failed_turn: 1, result: "sent" }),
      row({ kind: "raft.assistant_chat_told", seq: 702, status: "reply_fallback", reply_fallback: 1, failed_turn: "boom" }),
    ],
  }), e);
  assert.equal(res.status, 200);
  const [ok, bad] = records(calls[0].body);
  assert.equal(String(ok.attrs.failed_turn), "1");
  assert.equal(ok.attrs.result, "sent");
  assert.equal(bad.attrs.failed_turn, undefined);
});

test("antiproton-trace drops credential-shaped ids and codes, even inside a longer name", async () => {
  const { env: e, calls } = env();
  const ghp = "ghp_" + "a1B2c3D4e5".repeat(4);
  const sk = "sk-live0123456789abcdefXYZ";
  const hex = "0123456789abcdef0123456789abcdef01234567";
  const res = await handleRequest(post({
    rows: [
      row({ kind: "tool.call", seq: 801, tool: `x_${ghp}`, mount: "github" }),
      row({ kind: "tool.call", seq: 802, tool: `x_${sk}`, mount: "github" }),
      row({ kind: "tool.call", seq: 803, tool: `${hex}.x`, mount: "github" }),
      row({ kind: "tool.call", seq: 804, tool: "task-runner-abcdefghijklmnop", mount: "disk-usage-0123456789abcdef" }),
    ],
  }), e);
  assert.equal(res.status, 200);
  assert.ok(!calls[0].body.includes(ghp));
  assert.ok(!calls[0].body.includes(sk));
  assert.ok(!calls[0].body.includes(hex));
  const [a, b, c, ok] = records(calls[0].body);
  assert.equal(a.attrs.tool, undefined);
  assert.equal(b.attrs.tool, undefined);
  assert.equal(c.attrs.tool, undefined);
  assert.equal(a.attrs.mount, "github");
  assert.equal(ok.attrs.tool, "task-runner-abcdefghijklmnop");
  assert.equal(ok.attrs.mount, "disk-usage-0123456789abcdef");
});

test("antiproton-trace keeps RFC 077 step 2 check fields, the new kinds and widened enums", async () => {
  const { env: e, calls } = env();
  const res = await handleRequest(post({
    rows: [
      row({ kind: "raft.assistant_wake", seq: 901, status: "invoked", result: "check_refused", check_id: "chk-1a2b", raft_check: true,
        reason: "no_notify", tools_dropped: 2, named: 3, night_held: 1, behind: 1, error_code: "inbox_shape", instruction: "Summarize …" }),
      row({ kind: "raft.assistant_check", seq: 902, status: "turn_ended", check_id: "chk-1a2b", trigger: "brief", outcome: "completed", mount_index: 0 }),
      row({ kind: "raft.assistant_notify", seq: 903, state: "duplicate", dropped_not_in_check: 1, check_id: "chk-1a2b", forwarded: 1 }),
      row({ kind: "raft.assistant_rules", seq: 904, action: "other", result: "removed_partial", left: 2, via: "raft" }),
      row({ kind: "turn.end_unrecorded", seq: 905, status: "failed", stage: "record", error_class: "HarnessClosed" }),
      row({ kind: "rebuild.outcome", seq: 906, decision: "rb_9f3a", trigger: "cold-wake", agreement: "false-warm", measured_cold: true, rule: "ops-policy-x" }),
    ],
  }), e);
  assert.equal(res.status, 200);
  assert.ok(!calls[0].body.includes("Summarize"));
  assert.ok(!calls[0].body.includes("ops-policy-x"));
  const [wake, check, notify, rules, unrecorded, rebuild] = records(calls[0].body);
  assert.equal(wake.attrs.result, "check_refused");
  assert.equal(wake.attrs.reason, "no_notify");
  assert.equal(String(wake.attrs.raft_check), "true");
  assert.equal(String(wake.attrs.named), "3");
  assert.equal(String(wake.attrs.behind), "1");
  assert.equal(wake.attrs.error_code, "inbox_shape");
  assert.equal(check.name, "antiproton.raft.assistant_check");
  assert.equal(check.attrs.outcome, "completed");
  assert.equal(notify.attrs.state, "duplicate");
  assert.equal(String(notify.attrs.dropped_not_in_check), "1");
  assert.equal(rules.attrs.action, "other");
  assert.equal(String(rules.attrs.left), "2");
  assert.equal(unrecorded.attrs.stage, "record");
  assert.equal(rebuild.attrs.agreement, "false-warm");
  assert.equal(rebuild.attrs.rule, undefined);
});

test("antiproton-trace keeps state.dropped sizes and drops the text", async () => {
  const { env: e, calls } = env();
  const res = await handleRequest(post({
    rows: [
      row({ kind: "state.dropped", seq: 1001, mount: "state", key: "journal", lines: 12, characters: 2048, text: "met Alice at 3pm" }),
      row({ kind: "state.dropped", seq: 1002, mount: "state", key: "notes-2026", lines: 1, characters: 40 }),
    ],
  }), e);
  assert.equal(res.status, 200);
  assert.ok(!calls[0].body.includes("met Alice"));
  const [journal, other] = records(calls[0].body);
  assert.equal(journal.name, "antiproton.state.dropped");
  assert.equal(journal.attrs.mount, "state");
  assert.equal(journal.attrs.key, "journal");
  assert.equal(String(journal.attrs.lines), "12");
  assert.equal(String(journal.attrs.characters), "2048");
  assert.equal(journal.attrs.text, undefined);
  assert.equal(other.attrs.key, undefined);
});
