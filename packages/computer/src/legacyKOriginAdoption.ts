import { isDeepStrictEqual } from "node:util";

import {
  loadOperation,
  persistOperation,
  type OperationRead,
  type OperationRecord,
} from "@botiverse/k-carrier";

import { isProcessAlive } from "./internal/process-primitives.js";
import { kStateDir } from "./kPaths.js";
import { prepareExactLocalUpgradeLifecycleOperationResult } from "./localLifecycleIntents.js";
import { COMPUTER_VERSION } from "./version.js";

const LEGACY_ORIGIN_BINDING = "legacy-local-k/v1";
const OPERATION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PROCESS_ID_RE = /^(?:service:(\d+)|runner:([^\s:]{1,240}):(\d+))$/u;

interface LegacyKOriginAdoptionDeps {
  loadOperationFn?: typeof loadOperation;
  persistOperationFn?: typeof persistOperation;
  prepareExactLifecycleFn?: typeof prepareExactLocalUpgradeLifecycleOperationResult;
  isAlive?: (pid: number) => boolean;
}

export type LegacyKUpgradeOriginAdoptionResult =
  | { status: "adopted"; operationId: string }
  | {
      status: "retryable_ready_pending";
      operationId: string;
      code: "computer_offline" | "computer_lifecycle_completion_ready_pending";
    }
  | { status: "not_adopted" };

function priorProcessIdentities(record: OperationRecord): string[] | null {
  try {
    const parsed = JSON.parse(record.metadata.priorProcessIdentities ?? "null") as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 512) return null;
    return parsed.every((identity) => typeof identity === "string" && PROCESS_ID_RE.test(identity))
      ? parsed as string[]
      : null;
  } catch {
    return null;
  }
}

function eligibleLegacyReceipt(
  observed: OperationRead,
  serverId: string,
  isAlive: (pid: number) => boolean,
): OperationRecord | null {
  if (observed.kind !== "observed") return null;
  const record = observed.operation;
  if (
    !OPERATION_ID_RE.test(record.id)
    || record.phase !== "promoted"
    || record.outcome !== "promoted"
    || record.targetVersion !== COMPUTER_VERSION
    || record.acknowledgedAtMs !== null
    || record.metadata.upgradeScopeVersion !== undefined
    || record.metadata.upgradeScope !== undefined
    || record.metadata.originServerId !== undefined
    || record.metadata.trigger !== "cli"
    || record.provenance?.who !== "local"
    || record.provenance.carrier !== "cli"
  ) return null;
  const identities = priorProcessIdentities(record);
  if (!identities) return null;
  const hasServicePredecessor = identities.some((identity) => PROCESS_ID_RE.exec(identity)?.[1] !== undefined);
  const candidateOwnedPredecessor = identities.some((identity) => {
    const match = PROCESS_ID_RE.exec(identity);
    return match?.[2] === serverId;
  });
  if (!hasServicePredecessor || !candidateOwnedPredecessor) return null;
  if (identities.some((identity) => {
    const match = PROCESS_ID_RE.exec(identity);
    const pid = Number(match?.[1] ?? match?.[3]);
    return !Number.isSafeInteger(pid) || pid <= 0 || isAlive(pid);
  })) return null;
  return record;
}

function sameUnboundReceipt(left: OperationRecord, right: OperationRecord): boolean {
  return isDeepStrictEqual(left, right);
}

/**
 * Bind the one legacy 1.0.18 local-CLI K receipt to a Server-owned lifecycle
 * intent after its successor runner has connected. Nothing in K changes until
 * the Server accepts the exact id and the local acknowledgement is durable.
 */
export async function adoptLegacyKUpgradeOrigin(
  input: { slockHome: string; serverId: string },
  deps: LegacyKOriginAdoptionDeps = {},
): Promise<LegacyKUpgradeOriginAdoptionResult> {
  const read = deps.loadOperationFn ?? loadOperation;
  const write = deps.persistOperationFn ?? persistOperation;
  const alive = deps.isAlive ?? isProcessAlive;
  const stateDir = kStateDir(input.slockHome);
  const initial = await read(stateDir);
  const candidate = eligibleLegacyReceipt(initial, input.serverId, alive);
  if (!candidate) return { status: "not_adopted" };

  const prepared = await (
    deps.prepareExactLifecycleFn ?? prepareExactLocalUpgradeLifecycleOperationResult
  )(
    input.slockHome,
    input.serverId,
    candidate.id,
    candidate.targetVersion,
    "cli",
  );
  if (prepared.status === "retryable_ready_pending") {
    return {
      status: "retryable_ready_pending",
      operationId: candidate.id,
      code: prepared.code,
    };
  }
  if (prepared.status !== "prepared"
    || prepared.operation.operationId !== candidate.id
    || prepared.operation.serverId !== input.serverId) {
    return { status: "not_adopted" };
  }

  const fresh = await read(stateDir);
  if (fresh.kind !== "observed" || !sameUnboundReceipt(candidate, fresh.operation)) {
    return { status: "not_adopted" };
  }
  const bound: OperationRecord = {
    ...fresh.operation,
    provenance: { who: input.serverId, carrier: "cli" },
    metadata: {
      ...fresh.operation.metadata,
      originServerId: input.serverId,
      originBinding: LEGACY_ORIGIN_BINDING,
    },
  };
  await write(stateDir, bound);
  const verified = await read(stateDir);
  return verified.kind === "observed" && isDeepStrictEqual(verified.operation, bound)
    ? { status: "adopted", operationId: candidate.id }
    : { status: "not_adopted" };
}
