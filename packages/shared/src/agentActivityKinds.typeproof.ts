// Compile-time proofs for the agent activity kind unions. This is NOT a
// runtime test: its teeth are the ts-expect-error directives below, exercised
// by `pnpm --filter @botiverse/raft-shared typecheck`. If a kind is added to a union
// without registering it (making the assignment valid), the now-unused
// directive fails typecheck.
import type { AgentActivityDetailKind, AgentActivityKind } from "./index.js";

const activityKind: AgentActivityKind = "working";
const detailKind: AgentActivityDetailKind = "running_command";

// @ts-expect-error proof-of-catch: activity kind additions must be registered in AGENT_ACTIVITIES.
const unregisteredActivityKind: AgentActivityKind = "streaming";
// @ts-expect-error proof-of-catch: detail kind additions must be registered in AGENT_ACTIVITY_DETAIL_KINDS.
const unregisteredDetailKind: AgentActivityDetailKind = "display_text_changed";

void activityKind;
void detailKind;
void unregisteredActivityKind;
void unregisteredDetailKind;
