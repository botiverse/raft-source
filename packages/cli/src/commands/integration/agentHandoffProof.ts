import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { AgentContext } from "../../auth/env";
import type { createAgentApiSurfaceClient } from "../../agentApiPath";
import { cliError } from "../../core/errors";
import { resolveRaftHome } from "../../state/raftHome";

type Api = ReturnType<typeof createAgentApiSurfaceClient>;
type Body = Parameters<Api["integrations"]["login"]>[0];
type Pending = { verifier: string; requestId?: string; challenge: string };

function location(context: AgentContext, env: NodeJS.ProcessEnv, body: Body): { dir: string; prefix: string } {
  const root = context.profileCredentialPath ? path.dirname(context.profileCredentialPath) : path.join(resolveRaftHome(env), "integration-sessions", context.agentId);
  const key = createHash("sha256").update(JSON.stringify([context.serverUrl, context.agentId, body.service, [...(body.scopes ?? [])].sort()])).digest("hex");
  return { dir: path.join(root, "integrations"), prefix: `.handoff-${key}-` };
}
function readPending(file: string): Pending | undefined {
  try {
    const info = fs.lstatSync(file);
    if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > 2048) return undefined;
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as Pending;
    if (!/^[A-Za-z0-9_-]{43}$/.test(value.verifier) || (value.requestId !== undefined && !/^[0-9a-f-]{36}$/i.test(value.requestId))) return undefined;
    const challenge = createHash("sha256").update(value.verifier).digest("base64url");
    if (value.challenge !== challenge) return undefined;
    return value;
  } catch { return undefined; }
}
function writePending(file: string, value: Pending): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(file), `.raft-proof-${randomUUID()}.tmp`);
  try { fs.writeFileSync(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 }); fs.renameSync(temporary, file); }
  finally { try { fs.unlinkSync(temporary); } catch { /* moved or not created */ } }
}
function removePending(file: string | undefined): void {
  if (!file) return;
  try { fs.unlinkSync(file); } catch { /* no pending file */ }
}

/** Preserve the legacy request unchanged. V1 retains a distinct verifier for
 * every approval request; retry examines all of them before choosing pending. */
export async function loginWithAgentProof(input: { api: Api; body: Body; context: AgentContext; env: NodeJS.ProcessEnv }) {
  // The normal legacy request and its result stay exactly as before. Only a
  // v1 Server's authenticated refusal selects the proof-recovery path.
  const initial = await input.api.integrations.login(input.body);
  if (initial.ok || initial.errorCode !== "INTEGRATION_HANDOFF_UPGRADE_REQUIRED") {
    return { result: initial, verifier: undefined, clear: () => {} };
  }
  const { dir, prefix } = location(input.context, input.env, input.body);
  let names: string[];
  try { names = fs.readdirSync(dir).filter((name) => name.startsWith(prefix) && name.endsWith(".json")).sort(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; names = []; }
  if (names.length > 128) throw cliError("INTEGRATION_HANDOFF_TOO_MANY_REQUESTS", "Too many pending Agent Login requests exist for this App and scope.");

  let firstPending: { result: Awaited<ReturnType<Api["integrations"]["login"]>>; pending: Pending; file: string } | undefined;
  for (const name of names) {
    const file = path.join(dir, name);
    const pending = readPending(file);
    if (!pending || name !== `${prefix}${pending.challenge}.json`) continue;
    const result = await input.api.integrations.login({ ...input.body, target: undefined, agentHandoffChallenge: pending.challenge, resumeRequestId: pending.requestId });
    if (!result.ok && result.errorCode === "INTEGRATION_HANDOFF_REQUEST_UNAVAILABLE") { removePending(file); continue; }
    if (!result.ok || !result.data) return { result, verifier: pending.verifier, clear: () => removePending(file) };
    if (result.data.agentHandoffProtocol !== "v1") throw cliError("INTEGRATION_AGENT_HANDOFF_FAILED", "The App's stored Agent Login request no longer matches its protocol.");
    if (result.data.status !== "approval_required") return { result, verifier: pending.verifier, clear: () => removePending(file) };
    if (!pending.requestId && result.data.requestId) { pending.requestId = result.data.requestId; writePending(file, pending); }
    firstPending ??= { result, pending, file };
  }
  if (firstPending) {
    const { pending, file } = firstPending;
    const result = input.body.target
      ? await input.api.integrations.login({ ...input.body, agentHandoffChallenge: pending.challenge, resumeRequestId: pending.requestId })
      : firstPending.result;
    return { result, verifier: pending.verifier, clear: () => removePending(file) };
  }

  let result = initial;
  let verifier: string | undefined;
  let file: string | undefined;
  if (!result.ok && result.errorCode === "INTEGRATION_HANDOFF_UPGRADE_REQUIRED") {
    verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    file = path.join(dir, `${prefix}${challenge}.json`);
    // Persist before the server can create an approval card. A lost response
    // can then recover the same request by its Agent-bound challenge.
    writePending(file, { verifier, challenge });
    result = await input.api.integrations.login({ ...input.body, agentHandoffChallenge: challenge });
    if (result.ok && result.data?.agentHandoffProtocol === "v1" && result.data.status === "approval_required") {
      const requestId = result.data.requestId;
      if (!requestId || !/^[0-9a-f-]{36}$/i.test(requestId)) throw cliError("INTEGRATION_AGENT_HANDOFF_FAILED", "The Agent Login approval request is invalid.");
      writePending(file, { verifier, challenge, requestId });
    }
  }
  return { result, verifier, clear: () => removePending(file) };
}
