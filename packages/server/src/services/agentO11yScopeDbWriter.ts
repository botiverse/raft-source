import type { Application } from "express";
import { Client } from "scopedb";

import type {
  AgentO11yAcceptedEvent,
  AgentO11yJsonValue,
  AgentO11yPayloadTier,
} from "./agentO11yValidation.js";
import type { ScopeDbPersistenceTier } from "./scopeDbSdkPolicy.js";

export const AGENT_O11Y_WRITER_APP_KEY = "agentO11yScopeDbWriter";

export interface AgentO11yTenancy {
  server_id: string;
  computer_id: string;
  machine_id?: string | null;
}

export interface AgentO11yScopeDbWriter {
  writeEvents(
    events: readonly AgentO11yAcceptedEvent[],
    tenancy: AgentO11yTenancy,
  ): Promise<{ accepted: number }>;
}

export type AgentO11yPayloadMode = "hash" | "summary" | "full";

export class AgentO11yWriterUnavailableError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "AgentO11yWriterUnavailableError";
    this.code = code;
  }
}

export interface ScopeDbWriterConfig {
  endpoint: string;
  token: string;
  ingestStatement: string;
}

export const AGENT_O11Y_SCOPEDB_PERSISTENCE_TIER: ScopeDbPersistenceTier = "decision_support";

export function getAgentO11yScopeDbWriter(app: Application): AgentO11yScopeDbWriter {
  const existing = app.get(AGENT_O11Y_WRITER_APP_KEY) as AgentO11yScopeDbWriter | undefined;
  if (existing) return existing;

  const writer = createAgentO11yScopeDbWriterFromEnv();
  app.set(AGENT_O11Y_WRITER_APP_KEY, writer);
  return writer;
}

function createAgentO11yScopeDbWriterFromEnv(): AgentO11yScopeDbWriter {
  const endpoint = process.env.SCOPEDB_ENDPOINT;
  const token = process.env.SCOPEDB_AGENT_O11Y_WRITE_KEY;
  const ingestStatement = process.env.SCOPEDB_AGENT_O11Y_INGEST_STATEMENT;

  if (!endpoint || !token || !ingestStatement) {
    return new UnconfiguredAgentO11yScopeDbWriter();
  }
  return new SdkAgentO11yScopeDbWriter({ endpoint, token, ingestStatement });
}

class UnconfiguredAgentO11yScopeDbWriter implements AgentO11yScopeDbWriter {
  async writeEvents(): Promise<{ accepted: number }> {
    throw new AgentO11yWriterUnavailableError(
      "agent_o11y_writer_unconfigured",
      "agent o11y ScopeDB writer is not configured",
    );
  }
}

export class SdkAgentO11yScopeDbWriter implements AgentO11yScopeDbWriter {
  private readonly client: Pick<Client, "insert">;
  private readonly ingestStatement: string;

  constructor(config: ScopeDbWriterConfig, client?: Pick<Client, "insert">) {
    this.client = client ?? new Client(config.endpoint, { apiKey: config.token });
    this.ingestStatement = config.ingestStatement;
  }

  async writeEvents(
    events: readonly AgentO11yAcceptedEvent[],
    tenancy: AgentO11yTenancy,
  ): Promise<{ accepted: number }> {
    const rows = events
      .map((event) => toScopeDbRow(event, tenancy))
      .map((row) => JSON.stringify(row))
      .join("\n");
    try {
      // Persistence tier: decision_support. This synchronous endpoint returns
      // accepted=N, so it must wait for committed ingest rather than report a
      // server-buffer acceptance as if it were a committed acknowledgement.
      // This is not authoritative durability: no outbox/replay/idempotency is
      // provided here, and callers must reclassify before using it as a gate.
      const result = await this.client.insert(rows, this.ingestStatement);
      return { accepted: result.num_rows_inserted };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new AgentO11yWriterUnavailableError(
        "agent_o11y_writer_unavailable",
        `agent o11y ScopeDB write failed: ${message}`,
      );
    }
  }
}

function toScopeDbRow(
  event: AgentO11yAcceptedEvent,
  tenancy: AgentO11yTenancy,
): Record<string, AgentO11yJsonValue> {
  return {
    server_id: tenancy.server_id,
    computer_id: tenancy.computer_id,
    machine_id: tenancy.machine_id ?? null,
    event_kind: event.event_kind,
    agent_id: event.agent_id,
    turn_id: event.turn_id,
    occurred_at: event.occurred_at,
    // Transport uses payload_tier to avoid stale ScopeDB column names on the
    // daemon wire. The server writer is the boundary that maps tiers to the
    // canonical ScopeDB payload_mode enum.
    payload_mode: mapAgentO11yPayloadTierToPayloadMode(event.payload_tier),
    turn_trigger_hash: event.turn_trigger_hash ?? null,
    step_input_hash: event.step_input_hash ?? null,
    fields: event.fields ?? {},
  };
}

export function mapAgentO11yPayloadTierToPayloadMode(
  payloadTier: AgentO11yPayloadTier,
): AgentO11yPayloadMode {
  // v0 POC locality: `payload_mode` is a tier proxy for the relaxed POC table.
  // Canonical ScopeDB schema will split event-level payload_tier from
  // per-column post-redaction payload_mode in rev 3.3.
  switch (payloadTier) {
    case "T0":
      return "hash";
    case "T1":
      return "summary";
    case "T2":
      return "full";
  }
}
