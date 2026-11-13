#!/usr/bin/env -S node --import @oxc-node/core/register
import "dotenv/config";
import {
  assertTaskConversationIndexReady,
  assertTaskIdColumnExists,
  createPool,
  describeTaskConversationIndexStatus,
  readConstraintValidated,
  readTaskConversationIndexStatus,
  TASK_CONVERSATION_INDEXES,
  TASK_V2_NOT_VALID_CONSTRAINTS,
} from "./channels-task-conversation-indexes";

async function main() {
  const pool = createPool();
  const client = await pool.connect();
  try {
    await assertTaskIdColumnExists(client);
    for (const spec of TASK_CONVERSATION_INDEXES) {
      const status = await readTaskConversationIndexStatus(client, spec);
      assertTaskConversationIndexReady(spec, status);
      console.error(describeTaskConversationIndexStatus(spec.name, status));
    }
    for (const constraint of TASK_V2_NOT_VALID_CONSTRAINTS) {
      const status = await readConstraintValidated(client, constraint);
      if (!status.validated) throw new Error(`${constraint.name} is ${status.exists ? "not validated" : "missing"}`);
      console.error(`${constraint.name}: validated`);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
