import {
  appSnapshotTraceAttrs,
  appSourceTraceAttrs,
} from "@botiverse/raft-shared/src/appRuntimeTrace.js";
import type { ReminderJob } from "@botiverse/raft-shared";

import { composeAppSnapshot } from "../../services/appSnapshotComposition.js";
import { BUILT_IN_REMINDER_APP } from "./definition.js";
import { getSnapshotForAgent, toReminderJob } from "./service.js";

export function composeReminderSnapshot(ownerAgentId: string) {
  const snapshotTraceAttrs = appSnapshotTraceAttrs({
    appId: BUILT_IN_REMINDER_APP.appId,
    ownerAgentId,
    snapshotKind: "reminder",
  });
  return composeAppSnapshot<ReminderJob>(
    [
      {
        snapshotTraceAttrs,
        build: async () =>
          (await getSnapshotForAgent(ownerAgentId)).map((row) => ({
            value: toReminderJob(row),
            traceAttrs: appSourceTraceAttrs({
              ownerAgentId,
              sourceRef: {
                kind: "reminder",
                id: row.id,
                revision: String(row.version),
              },
            }),
          })),
      },
    ],
    snapshotTraceAttrs,
  );
}
