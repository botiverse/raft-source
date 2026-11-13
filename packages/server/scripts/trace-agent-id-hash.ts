#!/usr/bin/env -S node --import=@oxc-node/core/register
// Incident helper: id -> the keyed hash its spans carry (agent_id_hash by
// default; --kind server|machine|message|conversation|feedback-reporter|job for the other kinds), so you can find them in
// ScopeDB. Needs the same JWT_SECRET as the servers. There is deliberately no
// reverse direction here.
import "dotenv/config";
import { traceIdentityHash, type TraceIdentityKind } from "../src/tracing/traceIdentity";

const args = process.argv.slice(2);
let kind: TraceIdentityKind = "agent_id_hash";
const kindAt = args.indexOf("--kind");
if (kindAt !== -1) {
  const value = args[kindAt + 1];
  const kinds: Record<string, TraceIdentityKind> = {
    agent: "agent_id_hash", server: "server_id_hash", machine: "machine_id_hash", message: "message_id_hash",
    conversation: "conversation_id_hash", "feedback-reporter": "feedback_reporter_hash", job: "job_id_hash",
  };
  const selected = value ? kinds[value] : undefined;
  if (!selected) {
    console.error("--kind must be agent, server, machine, message, conversation, feedback-reporter or job");
    process.exit(2);
  }
  kind = selected;
  args.splice(kindAt, 2);
}
if (!args.length) {
  console.error("usage: pnpm --filter @botiverse/raft-server trace:agent-id-hash [--kind agent|server|machine|message|conversation|feedback-reporter|job] <id>...");
  process.exit(2);
}
for (const id of args) {
  const hash = traceIdentityHash(kind, id);
  if (!hash) {
    console.error("JWT_SECRET is not set; cannot derive the trace identity key");
    process.exit(1);
  }
  console.log(`${id}\t${hash}`);
}
