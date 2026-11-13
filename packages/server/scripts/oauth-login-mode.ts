#!/usr/bin/env -S node --import=@oxc-node/core/register
/**
 * RFC 079 phase 3a: the reviewed switch of an App from server-mode to
 * account-mode Login with Raft (design §2.4), and the read that goes with it.
 * The only writer of `login_mode = 'account'` (decision Q6: no HTTP path).
 * Runbook: docs/operations/oauth-login-mode-switch.md.
 *
 *   show   --client <client id>                                                read only
 *   switch --client <client id> --review <ref> --reason <text> [--operator <name>]
 *
 * There is no way back: an App never leaves account mode (D16), and the
 * oauth_clients_login_mode_forward_only trigger (migration 0560) refuses it
 * whatever the writer. The kill switch, the feature flag oauth_account_login,
 * is not this script's: the runbook says when to turn it on.
 *
 * `switch`, in one transaction: lock the App's row (FOR UPDATE, so a
 * concurrent switch, or a login row whose guard reads the mode FOR SHARE,
 * queues behind it); refuse an App that is not user-managed (built-in or
 * platform-managed); stop with `changed: false` and write nothing when it is
 * already in account mode; set login_mode; write the audit event
 * oauth.login_mode_switched with the review, the reason, the operator and
 * what the switch finds (design §2.3): the App's live server-mode human
 * tokens and its open server-mode human codes.
 *
 * Output: one JSON line on stdout. Exit 0: done, or nothing to do. Exit 1: a
 * refusal (stderr says which) or an error. Exit 2: bad arguments, no
 * operator or no DATABASE_URL. `--operator` defaults to $USER, a self-reported name: pass
 * your real name. Needs DATABASE_URL, as the server has it.
 */
import { pathToFileURL } from "node:url";
import { and, eq, gt, gte, isNotNull, isNull, sql } from "drizzle-orm";
import { closeDatabase, getDb, initDatabase, type DatabaseExecutor } from "../src/db/index";
import { oauthAccessRequests, oauthAccessTokens, oauthClients, type OAuthClientLoginMode } from "../src/db/schema";
import { recordIntegrationAuditEvent, sanitizeIntegrationAuditMetadata } from "../src/services/integrationAuditService";
import { oauthClientIsUserManagedPredicate } from "../src/services/oauthClientManagementPolicy";
import { HUMAN_AUTHORIZATION_CODE_TTL_MS } from "../src/services/oauthService";

const USAGE = `Usage:
  pnpm --filter @botiverse/raft-server db:oauth-login-mode -- show --client <client id>
  pnpm --filter @botiverse/raft-server db:oauth-login-mode -- switch --client <client id> --review <ref> --reason <text> [--operator <name>]`;

export const CLIENT_KEY_MAX_CHARS = 128;
export const REVIEW_MAX_CHARS = 500;
export const REASON_MAX_CHARS = 1000;
export const OPERATOR_MAX_CHARS = 128;

/** A client id as stored: printable ASCII, no spaces. Matched exactly (client ids are case-sensitive). */
const CLIENT_KEY_PATTERN = new RegExp(`^[\\x21-\\x7e]{1,${CLIENT_KEY_MAX_CHARS}}$`);
// One-line fields (review, operator) take no control character; the reason may span lines.
const ANY_CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const CONTROL_BUT_NEWLINE_OR_TAB = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;

export type OAuthLoginModeCommand =
  | { command: "show"; client: string }
  | { command: "switch"; client: string; review: string; reason: string; operator?: string };

export interface OAuthLoginModeSwitchInput {
  client: string;
  review: string;
  reason: string;
  operator: string;
}

/** Bad arguments: exit 2, before anything is read. */
export class OAuthLoginModeUsageError extends Error {
  override readonly name = "OAuthLoginModeUsageError";
}

export type OAuthLoginModeRefusalCode = "invalid_input" | "unknown_client" | "not_user_managed";

/** The switch refused: nothing was written. Exit 1. */
export class OAuthLoginModeRefusal extends Error {
  override readonly name = "OAuthLoginModeRefusal";
  constructor(readonly code: OAuthLoginModeRefusalCode, message: string) {
    super(message);
  }
}

function clientKeyOf(raw: string | undefined): string | null {
  const key = raw?.trim() ?? "";
  return CLIENT_KEY_PATTERN.test(key) ? key : null;
}

function textOf(raw: string | undefined, max: number, control: RegExp): string | null {
  const text = raw?.trim() ?? "";
  return text.length > 0 && text.length <= max && !control.test(text) ? text : null;
}

const CLIENT_RULE = `--client is the App's client id (its public key): 1 to ${CLIENT_KEY_MAX_CHARS} printable ASCII characters, no spaces`;
const REVIEW_RULE = `--review is required: the reference of the human sign-off (a link or an id), 1 to ${REVIEW_MAX_CHARS} characters on one line`;
const REASON_RULE = `--reason is required: 1 to ${REASON_MAX_CHARS} characters, no control characters (it goes in the audit row)`;
const OPERATOR_RULE = `--operator is your name: 1 to ${OPERATOR_MAX_CHARS} characters on one line (it goes in the audit row)`;

/** The switch's input, trimmed and checked, or the refusal. The CLI and every direct caller go through it. */
export function validateSwitchInput(input: { client?: string; review?: string; reason?: string; operator?: string }): OAuthLoginModeSwitchInput {
  const client = clientKeyOf(input.client);
  if (client === null) throw new OAuthLoginModeRefusal("invalid_input", CLIENT_RULE);
  const review = textOf(input.review, REVIEW_MAX_CHARS, ANY_CONTROL);
  if (review === null) throw new OAuthLoginModeRefusal("invalid_input", REVIEW_RULE);
  const reason = textOf(input.reason, REASON_MAX_CHARS, CONTROL_BUT_NEWLINE_OR_TAB);
  if (reason === null) throw new OAuthLoginModeRefusal("invalid_input", REASON_RULE);
  const operator = textOf(input.operator, OPERATOR_MAX_CHARS, ANY_CONTROL);
  if (operator === null) throw new OAuthLoginModeRefusal("invalid_input", OPERATOR_RULE);
  return { client, review, reason, operator };
}

export function parseOAuthLoginModeArgs(argv: readonly string[]): OAuthLoginModeCommand {
  const args = argv[0] === "--" ? argv.slice(1) : [...argv];
  const command = args.shift();
  if (command !== "show" && command !== "switch") {
    throw new OAuthLoginModeUsageError(`the command is show or switch (there is no switching back)\n${USAGE}`);
  }
  const allowed = command === "show" ? ["--client"] : ["--client", "--review", "--reason", "--operator"];
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!allowed.includes(arg)) throw new OAuthLoginModeUsageError(`unknown argument: ${arg}\n${USAGE}`);
    const next = args[++i];
    if (next === undefined || next.startsWith("--")) throw new OAuthLoginModeUsageError(`${arg} needs a value\n${USAGE}`);
    if (values.has(arg)) throw new OAuthLoginModeUsageError(`${arg} given twice`);
    values.set(arg, next);
  }
  const usage = (rule: string) => new OAuthLoginModeUsageError(`${rule}\n${USAGE}`);
  const client = clientKeyOf(values.get("--client"));
  if (client === null) throw usage(CLIENT_RULE);
  if (command === "show") return { command, client };
  const review = textOf(values.get("--review"), REVIEW_MAX_CHARS, ANY_CONTROL);
  if (review === null) throw usage(REVIEW_RULE);
  const reason = textOf(values.get("--reason"), REASON_MAX_CHARS, CONTROL_BUT_NEWLINE_OR_TAB);
  if (reason === null) throw usage(REASON_RULE);
  if (!values.has("--operator")) return { command, client, review, reason };
  const operator = textOf(values.get("--operator"), OPERATOR_MAX_CHARS, ANY_CONTROL);
  if (operator === null) throw usage(OPERATOR_RULE);
  return { command, client, review, reason, operator };
}

const CLIENT_COLUMNS = {
  id: oauthClients.id,
  serverId: oauthClients.serverId,
  name: oauthClients.name,
  appType: oauthClients.appType,
  loginMode: oauthClients.loginMode,
  userManaged: sql<boolean>`(${oauthClientIsUserManagedPredicate()})`,
  enabled: oauthClients.enabled,
  publishStatus: oauthClients.publishStatus,
};

/**
 * What the switch changes for the App's existing logins (design §2.3), read
 * now: its live (not revoked, not expired) server-mode human tokens, which
 * keep working until they expire; its open (approved, unconsumed, under ten
 * minutes old) server-mode human codes, which the exchange refuses once the
 * App is in account mode; and its live account-mode tokens (none before the
 * switch; a test login's after it).
 */
async function loginCountsOf(executor: DatabaseExecutor, clientRecordId: string) {
  const { rows: [counts] } = await executor.execute<{
    liveServerHumanTokens: number;
    openServerHumanCodes: number;
    liveAccountTokens: number;
  }>(sql`SELECT
    (SELECT count(*)::int FROM ${oauthAccessTokens} WHERE ${and(
      eq(oauthAccessTokens.clientId, clientRecordId),
      eq(oauthAccessTokens.principalType, "human"),
      isNotNull(oauthAccessTokens.serverId),
      isNull(oauthAccessTokens.revokedAt),
      gt(oauthAccessTokens.expiresAt, sql`now()`),
    )}) AS "liveServerHumanTokens",
    (SELECT count(*)::int FROM ${oauthAccessRequests} WHERE ${and(
      eq(oauthAccessRequests.clientId, clientRecordId),
      eq(oauthAccessRequests.principalType, "human"),
      isNotNull(oauthAccessRequests.serverId),
      eq(oauthAccessRequests.status, "approved"),
      isNull(oauthAccessRequests.consumedAt),
      gte(oauthAccessRequests.createdAt, sql`now() - make_interval(secs => ${HUMAN_AUTHORIZATION_CODE_TTL_MS / 1000})`),
    )}) AS "openServerHumanCodes",
    (SELECT count(*)::int FROM ${oauthAccessTokens} WHERE ${and(
      eq(oauthAccessTokens.clientId, clientRecordId),
      isNull(oauthAccessTokens.serverId),
      isNull(oauthAccessTokens.revokedAt),
      gt(oauthAccessTokens.expiresAt, sql`now()`),
    )}) AS "liveAccountTokens"`);
  if (!counts) throw new Error("the login counts read returned no row");
  return {
    liveServerHumanTokens: counts.liveServerHumanTokens,
    openServerHumanCodes: counts.openServerHumanCodes,
    liveAccountTokens: counts.liveAccountTokens,
  };
}

export interface OAuthLoginModeState {
  client: string;
  id: string;
  name: string;
  appType: string;
  loginMode: OAuthClientLoginMode;
  userManaged: boolean;
  enabled: boolean;
  publishStatus: string;
  liveServerHumanTokens: number;
  openServerHumanCodes: number;
  liveAccountTokens: number;
}

/** `show`: the App and what a switch would change. Read only. */
export async function showOAuthLoginMode(clientKey: string, executor: DatabaseExecutor = getDb()): Promise<OAuthLoginModeState> {
  const client = clientKeyOf(clientKey);
  if (client === null) throw new OAuthLoginModeRefusal("invalid_input", CLIENT_RULE);
  const [row] = await executor.select(CLIENT_COLUMNS).from(oauthClients).where(eq(oauthClients.clientId, client)).limit(1);
  if (!row) throw new OAuthLoginModeRefusal("unknown_client", `no App has the client id ${client}`);
  return {
    client,
    id: row.id,
    name: row.name,
    appType: row.appType,
    loginMode: row.loginMode,
    userManaged: row.userManaged === true,
    enabled: row.enabled,
    publishStatus: row.publishStatus,
    ...await loginCountsOf(executor, row.id),
  };
}

export type OAuthLoginModeSwitchResult =
  | {
    changed: true;
    client: string;
    id: string;
    from: OAuthClientLoginMode;
    to: "account";
    review: string;
    reason: string;
    operator: string;
    liveServerHumanTokens: number;
    openServerHumanCodes: number;
    auditEventId: string;
  }
  | { changed: false; client: string; id: string; loginMode: "account" };

/** `switch` (design §2.4): server → account in one transaction, audited. See the header for the steps. */
export async function switchOAuthLoginMode(
  rawInput: { client: string; review: string; reason: string; operator: string },
  executor: DatabaseExecutor = getDb(),
): Promise<OAuthLoginModeSwitchResult> {
  const input = validateSwitchInput(rawInput);
  return executor.transaction(async (tx) => {
    // Fail rather than queue every login of the App behind a stuck switch; the operator reruns it.
    await tx.execute(sql`SELECT set_config('lock_timeout', '5s', true), set_config('statement_timeout', '30s', true)`);
    const [row] = await tx.select(CLIENT_COLUMNS).from(oauthClients)
      .where(eq(oauthClients.clientId, input.client))
      .limit(1)
      .for("update", { of: oauthClients });
    if (!row) throw new OAuthLoginModeRefusal("unknown_client", `no App has the client id ${input.client}`);
    if (row.userManaged !== true) {
      throw new OAuthLoginModeRefusal("not_user_managed", `${input.client} is a built-in or platform-managed App (${row.appType}); only user-managed Apps switch`);
    }
    if (row.loginMode === "account") return { changed: false, client: input.client, id: row.id, loginMode: "account" };

    const counts = await loginCountsOf(tx, row.id);
    const metadata = {
      clientKey: input.client,
      from: row.loginMode,
      to: "account",
      review: input.review,
      reason: input.reason,
      operator: input.operator,
      liveServerHumanTokens: counts.liveServerHumanTokens,
      openServerHumanCodes: counts.openServerHumanCodes,
    };
    // The audit writer silently drops a credential-shaped value; this record must be whole.
    const dropped = Object.keys(metadata).filter((key) => !(key in sanitizeIntegrationAuditMetadata("oauth.login_mode_switched", metadata)));
    if (dropped.length > 0) {
      throw new OAuthLoginModeRefusal("invalid_input", `the audit row would drop ${dropped.join(", ")} (it looks like a credential): reword it`);
    }
    const updated = await tx.update(oauthClients).set({ loginMode: "account" })
      .where(and(eq(oauthClients.id, row.id), eq(oauthClients.loginMode, row.loginMode)))
      .returning({ id: oauthClients.id });
    if (updated.length !== 1) throw new Error(`the switch of ${input.client} updated ${updated.length} rows; rolled back`);
    const event = await recordIntegrationAuditEvent({
      serverId: row.serverId,
      clientId: row.id,
      eventType: "oauth.login_mode_switched",
      outcome: "success",
      source: "system",
      actor: { type: "system" },
      subject: { type: "app", id: row.id },
      target: { type: "app", id: row.id },
      metadata,
    }, tx);
    if (!event) throw new Error(`the audit row for ${input.client} was not written; rolled back`);
    return {
      changed: true,
      client: input.client,
      id: row.id,
      from: row.loginMode,
      to: "account",
      review: input.review,
      reason: input.reason,
      operator: input.operator,
      liveServerHumanTokens: counts.liveServerHumanTokens,
      openServerHumanCodes: counts.openServerHumanCodes,
      auditEventId: event.id,
    };
  });
}

export interface OAuthLoginModeIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

/** The CLI: the exit code, one JSON line on `out` when it succeeds, the reason on `err` when not. */
export async function main(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  io: OAuthLoginModeIo = { out: (line) => console.log(line), err: (line) => console.error(line) },
): Promise<number> {
  let parsed: OAuthLoginModeCommand;
  let switchInput: OAuthLoginModeSwitchInput | null = null;
  const url = env.DATABASE_URL;
  try {
    parsed = parseOAuthLoginModeArgs(argv);
    if (parsed.command === "switch") {
      const operator = parsed.operator ?? env.USER?.trim() ?? "";
      if (!operator) throw new OAuthLoginModeUsageError("name the operator: --operator <name> (recorded in the audit row)");
      switchInput = validateSwitchInput({ client: parsed.client, review: parsed.review, reason: parsed.reason, operator });
    }
    if (!url) throw new OAuthLoginModeUsageError("DATABASE_URL is required");
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    return 2;
  }
  try {
    await initDatabase(url, undefined, { log: () => {} });
    try {
      const result = switchInput ? await switchOAuthLoginMode(switchInput) : await showOAuthLoginMode(parsed.client);
      io.out(JSON.stringify(result));
      return 0;
    } finally {
      await closeDatabase();
    }
  } catch (error) {
    io.err(error instanceof OAuthLoginModeRefusal
      ? `refused (${error.code}): ${error.message}`
      : `failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => {
    process.exitCode = code;
  }, (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
