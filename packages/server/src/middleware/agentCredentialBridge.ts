// Bridge marker for reusing legacy machine-path business handlers from the
// `sk_agent_*` `/internal/agent-api/*` surface.
//
// Some old handlers only need a non-empty `req.machineId` for tracing or
// guard shape, not a real machine principal. agent-api routes set this marker
// only after `sk_agent_*` auth has already bound `req.actingAgentId`; it must
// never be accepted as authentication and must never cross a network boundary.
//
// Typed as MachineId: the sentinel semantically IS the machine-id slot's value,
// so consumers compare/assign brand-vs-brand without re-wrapping.
import { asMachineId, type MachineId } from "@botiverse/raft-shared";

export const AGENT_CREDENTIAL_BRIDGE_MACHINE_ID: MachineId = asMachineId("__slock_agent_credential_bridge__");
