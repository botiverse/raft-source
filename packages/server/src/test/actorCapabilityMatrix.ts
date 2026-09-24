import assert from "node:assert/strict";
import type { ServerCapability } from "@botiverse/raft-shared";
import {
  actorHasServerCapabilityInServer,
  type ActorContextType,
} from "../lib/actorPermissions.js";

export interface ActorCapabilityMatrixCase {
  label: string;
  actorType: ActorContextType;
  actorId: string;
  expected: boolean;
}

export async function assertActorServerCapabilityMatrix(input: {
  surface: string;
  serverId: string;
  capability: ServerCapability;
  cases: ActorCapabilityMatrixCase[];
}) {
  for (const matrixCase of input.cases) {
    assert.equal(
      await actorHasServerCapabilityInServer(
        input.serverId,
        matrixCase.actorType,
        matrixCase.actorId,
        input.capability,
      ),
      matrixCase.expected,
      `${input.surface}: ${matrixCase.label} ${input.capability}`,
    );
  }
}
