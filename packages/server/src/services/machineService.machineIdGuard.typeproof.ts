import { asMachineId, asServerId } from "@botiverse/raft-shared";
import { getMachine } from "./machineService.js";

// Compile-time guard for the serverId→machine confusion class. All ids are
// UUID strings, so before branding `getMachine(machineId: string)` happily
// accepted a server id passed in error (the kind of mistake that, on the
// access-control side, became the #945 cross-server leak). With
// `getMachine(machineId: MachineId)` the wrong id is a compile error.
//
// This is NOT a runtime test: the ts-expect-error directives are the check,
// enforced by `pnpm --filter @botiverse/raft-server typecheck`. If getMachine's
// parameter is ever widened back to a plain string, the now-unused directive
// fails typecheck.
function _typeLevelGuard(): void {
  // A proven machine id is accepted (minted at the auth/route boundary in real
  // code):
  void getMachine(asMachineId("00000000-0000-0000-0000-000000000000"));

  // @ts-expect-error — a raw string cannot be passed as a machine id.
  void getMachine("00000000-0000-0000-0000-000000000000");

  // @ts-expect-error — a ServerId is NOT a MachineId: passing a server id where a
  // machine is expected no longer type-checks.
  void getMachine(asServerId("11111111-1111-1111-1111-111111111111"));
}
void _typeLevelGuard;
