import type { RawEvent } from "@botiverse/oar";
import { buildCodexInstructionShapeAttrs, buildCodexInstructionShapeStaticAttrs, type CodexInstructionObservationPhase, type CodexThreadRequestMethod } from "../drivers/index";
import { mcpStartupOutcome } from "./oarCodexLaunch";

/**
 * Codex on OAR: the traces the legacy driver records around a thread, so a canary
 * reads the same: `daemon.runtime.tooling.exposure` when the launch commits and when
 * the managed MCP server settles, and `daemon.codex.request_instruction_shape` at
 * the thread request, around each compaction and at the first request after one.
 * Lengths and hashes, never the instructions.
 */
export interface CodexTraceFacts {
  developerInstructions: string | undefined;
  resumed: boolean;
  managedMcpServerName: string | null;
}

type ManagedMcpStatus = "not_configured" | "pending" | "ready" | "failed";

export class CodexSessionTraces {
  private readonly method: CodexThreadRequestMethod;
  private readonly staticAttrs: ReturnType<typeof buildCodexInstructionShapeStaticAttrs>;
  private readonly params: Record<string, unknown>;
  private managedMcpStatus: ManagedMcpStatus;
  private compactionStarts = 0;
  private compactionFinishes = 0;
  private postCompactionPending = false;

  constructor(
    private readonly facts: CodexTraceFacts,
    private readonly record: (name: string, attrs: Record<string, unknown>) => void,
  ) {
    this.method = facts.resumed ? "thread/resume" : "thread/start";
    this.staticAttrs = buildCodexInstructionShapeStaticAttrs({ standingInstructions: facts.developerInstructions });
    this.params = facts.developerInstructions === undefined ? {} : { developerInstructions: facts.developerInstructions };
    this.managedMcpStatus = facts.managedMcpServerName ? "pending" : "not_configured";
  }

  opened(): void {
    this.recordTooling();
    this.recordShape("thread_request_sent");
  }

  private recordTooling(): void {
    this.record("daemon.runtime.tooling.exposure", {
      source: "codex_app_server",
      session_request_method: this.method,
      // As on the legacy driver: the app-server doesn't report its built-in tools, and that stays a negative fact.
      native_tool_inventory_observation: "unreported_by_app_server",
      cli_transport_configured: true,
      managed_mcp_configured: this.facts.managedMcpServerName !== null,
      managed_mcp_status: this.managedMcpStatus,
    });
  }

  private recordShape(phase: CodexInstructionObservationPhase): void {
    this.record("daemon.codex.request_instruction_shape", {
      ...buildCodexInstructionShapeAttrs({
        staticAttrs: this.staticAttrs,
        requestParams: this.params,
        requestMethod: this.method,
        observationPhase: phase,
        compactionStarts: this.compactionStarts,
        compactionFinishes: this.compactionFinishes,
      }),
      status: "ok",
    });
  }

  observeRecord(record: RawEvent): void {
    if (!this.facts.managedMcpServerName || this.managedMcpStatus !== "pending") return;
    const outcome = mcpStartupOutcome(record, this.facts.managedMcpServerName);
    if (!outcome) return;
    if (outcome !== "ready" && outcome !== "failed") return;
    this.managedMcpStatus = outcome;
    this.recordTooling();
  }

  observeEvent(kind: string): void {
    if (kind === "compaction_started") {
      this.compactionStarts += 1;
      this.recordShape("compaction_started");
    } else if (kind === "compaction_ended") {
      this.compactionFinishes += 1;
      this.postCompactionPending = true;
      this.recordShape("compaction_finished");
    } else if (kind === "turn_started" && this.postCompactionPending) {
      this.postCompactionPending = false;
      this.recordShape("post_compaction_first_request");
    }
  }
}
