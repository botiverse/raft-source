import { asMachineId, type MachineId, type MachineToServerMessage } from "@botiverse/raft-shared";
import type Redis from "ioredis";
import { RouteFailureError } from "./tracing/routeFailure";

export type RelayedMachineResponse = Extract<MachineToServerMessage, {
  type:
    | "machine:runtime_models:result"
    | "machine:migration:source_workspace_archive_result"
    | "machine:provider_probe:result"
    | "machine:runtime_account_usage:snapshot"
    | "machine:runtime_account_usage:limit_reset:result"
    | "machine:runtime_account_usage:limit_resets:read:result"
    | "agent:interrupt-turn:result"
    | "agent:interrupt-subagent:result"
    | "machine:runtime_auth:logout:result"
    | "machine:runtime_auth:providers:result"
    | "machine:runtime_auth:connect_provider:result";
}>;
export type MachineReplyRequestId = string & { readonly __machineReplyRequestId: unique symbol };
export type MachineReplyReplicaId = string & { readonly __machineReplyReplicaId: unique symbol };
export function asMachineReplyRequestId(value: string): MachineReplyRequestId {
  if (!value) throw new Error("Empty machine reply request ID");
  return value as MachineReplyRequestId;
}
export function asMachineReplyReplicaId(value: string): MachineReplyReplicaId {
  if (!value) throw new Error("Empty machine reply replica ID");
  return value as MachineReplyReplicaId;
}
export interface MachineReplyRequest {
  requestId: MachineReplyRequestId;
  machineId: MachineId;
  type: RelayedMachineResponse["type"];
  replyReplicaId: MachineReplyReplicaId;
  agentId?: string;
  migrationId?: string;
  /** Probe correlation: results for another probe must never satisfy a wait. */
  probeId?: string;
}
interface ReplyRecord extends MachineReplyRequest {
  response?: RelayedMachineResponse;
  /**
   * The response exactly as written. cjson (Redis Lua) re-encodes an empty
   * array as `{}`, so `response` round-tripped through the Lua script loses
   * them (a usage account's `windows: []` came back as `{}`, #triage:#151).
   * Readers prefer this; `response` stays for replicas on older code.
   */
  responseJson?: string;
  sourceReplicaId?: MachineReplyReplicaId;
}
export interface MachineReplyStore {
  open(request: MachineReplyRequest, ttlMs: number): Promise<void>;
  write(machineId: string, response: RelayedMachineResponse, sourceReplicaId: MachineReplyReplicaId): Promise<MachineReplyReplicaId | null>;
  read(requestId: MachineReplyRequestId): Promise<ReplyRecord | null>;
  remove(requestId: MachineReplyRequestId): Promise<void>;
}
const key = (id: MachineReplyRequestId) => `slock:machine-reply:${id}`;
// Identity check + first response wins + original deadline in one Redis operation.
const WRITE_REPLY = `
local raw = redis.call('GET', KEYS[1])
if not raw then return false end
local record = cjson.decode(raw)
local response = cjson.decode(ARGV[2])
if record.machineId ~= ARGV[1] or record.type ~= response.type or record.requestId ~= response.requestId then return false end
if record.agentId and record.agentId ~= response.agentId then return false end
if record.migrationId and record.migrationId ~= response.migrationId then return false end
if record.probeId and record.probeId ~= response.probeId then return false end
if not record.response then
  record.response = response
  record.responseJson = ARGV[2]
  record.sourceReplicaId = ARGV[3]
  redis.call('SET', KEYS[1], cjson.encode(record), 'KEEPTTL')
end
return record.replyReplicaId
`;
export function redisMachineReplyStore(redis: () => Redis): MachineReplyStore {
  return {
    async open(request, ttlMs) {
      const result = await redis().set(key(request.requestId), JSON.stringify(request), "PX", ttlMs, "NX");
      if (result !== "OK") throw new Error("Machine reply request already exists");
    },
    async write(machineId, response, sourceReplicaId) {
      // Some relayed types (e.g. runtime-account usage snapshots) can arrive
      // uncorrelated; without a requestId there is no mailbox slot to fill.
      if (!response.requestId) return null;
      const target = await redis().eval(WRITE_REPLY, 1, key(asMachineReplyRequestId(response.requestId)), machineId, JSON.stringify(response), sourceReplicaId);
      return typeof target === "string" ? asMachineReplyReplicaId(target) : null;
    },
    async read(requestId) {
      const raw = await redis().get(key(requestId));
      if (!raw) return null;
      const record = JSON.parse(raw) as ReplyRecord;
      if (typeof record.responseJson === "string") record.response = JSON.parse(record.responseJson) as RelayedMachineResponse;
      delete record.responseJson;
      return record;
    },
    async remove(requestId) { await redis().del(key(requestId)); },
  };
}

type Observe = (event: string, attrs: Record<string, string | boolean>) => void;
interface Pending {
  request: MachineReplyRequest;
  reading: boolean;
  finish: (error?: Error, record?: ReplyRecord) => void;
  observe: Observe;
}

/** Targeted Redis notification accelerates delivery; a TTL mailbox covers lost notifications. */
export class MachineResponseRelay {
  private pending = new Map<MachineReplyRequestId, Pending>();
  readonly replicaId: MachineReplyReplicaId;
  constructor(
    replicaId: string,
    private store: MachineReplyStore,
    private publish: (replicaId: string, requestId: string) => Promise<void>,
    private pollMs = 250,
    private isAvailable: () => boolean = () => true,
  ) { this.replicaId = asMachineReplyReplicaId(replicaId); }

  request(
    input: Omit<MachineReplyRequest, "replyReplicaId" | "requestId" | "machineId"> & { requestId: string; machineId: string },
    timeoutMs: number,
    send: () => Promise<unknown>,
    observe: Observe,
  ): Promise<RelayedMachineResponse> {
    const request: MachineReplyRequest = { ...input, requestId: asMachineReplyRequestId(input.requestId),
      machineId: asMachineId(input.machineId), replyReplicaId: this.replicaId };
    return new Promise((resolve, reject) => {
      const attrs = { request_id: request.requestId, machine_id: request.machineId, reply_replica_id: this.replicaId, message_type: request.type };
      const finish: Pending["finish"] = (error, record) => {
        if (this.pending.get(request.requestId) !== pending) return;
        this.pending.delete(request.requestId);
        clearTimeout(timeout);
        clearInterval(poll);
        void this.store.remove(request.requestId).catch(() => {}); // TTL is the cleanup backstop.
        observe(error ? "failed" : "consumed", { ...attrs, ...(record?.sourceReplicaId ? { source_replica_id: record.sourceReplicaId } : {}) });
        if (error) reject(error);
        else resolve(record!.response!);
      };
      const pending: Pending = { request, reading: false, finish, observe };
      const timeout = setTimeout(() => finish(new RouteFailureError("daemon_timeout", "Machine response timed out")), timeoutMs);
      const poll = setInterval(() => { void this.consume(request.requestId); }, this.pollMs);
      this.pending.set(request.requestId, pending);
      void (async () => {
        try {
          await this.store.open(request, timeoutMs);
          if (this.pending.get(request.requestId) !== pending) {
            await this.store.remove(request.requestId);
            return;
          }
          observe("registered", attrs);
          await send();
        } catch {
          finish(new RouteFailureError("daemon_offline", "Machine reply transport unavailable"));
        }
      })();
    });
  }

  async consume(wireRequestId: string): Promise<void> {
    if (!wireRequestId) return;
    const requestId = asMachineReplyRequestId(wireRequestId);
    const pending = this.pending.get(requestId);
    if (!pending || pending.reading) return;
    pending.reading = true;
    try {
      const record = await this.store.read(requestId);
      if (!record?.response || this.pending.get(requestId) !== pending) return;
      const expected = pending.request;
      if (record.replyReplicaId !== this.replicaId || record.machineId !== expected.machineId
        || record.requestId !== requestId || record.response.requestId !== requestId
        || record.response.type !== expected.type) return;
      if (expected.agentId && (!("agentId" in record.response) || record.response.agentId !== expected.agentId)) return;
      if (expected.migrationId && (!("migrationId" in record.response) || record.response.migrationId !== expected.migrationId)) return;
    if (expected.probeId && (!("probeId" in record.response) || record.response.probeId !== expected.probeId)) return;
      pending.finish(undefined, record);
    } catch {
      // A transient Redis read failure may recover before the original deadline.
    } finally { pending.reading = false; }
  }

  async forward(machineId: string, response: RelayedMachineResponse, observe: Observe): Promise<void> {
    if (!this.isAvailable()) return; // Single-replica deployments have no relay mailbox.
    // Uncorrelated pushes (a snapshot with no requestId) have no waiter to
    // notify; skip them before any mailbox access.
    if (!response.requestId) {
      observe("unmatched", { request_id: "", machine_id: machineId, source_replica_id: this.replicaId, message_type: response.type });
      return;
    }
    const attrs = { request_id: response.requestId, machine_id: machineId, source_replica_id: this.replicaId, message_type: response.type };
    try {
      const target = await this.store.write(machineId, response, this.replicaId);
      if (!target) { observe("unmatched", attrs); return; }
      observe("stored", { ...attrs, reply_replica_id: target });
      await this.publish(target, response.requestId);
    } catch {
      observe("forward_failed", attrs);
    }
  }
}
