import type { Command } from "commander";
import type { AgentApiTaskResourceReceiptBody } from "@botiverse/raft-shared";

import { createAgentApiSurfaceClient } from "../../agentApiPath.js";
import { defineCommand, registerCliCommand } from "../../core/command.js";
import type { CommandRuntimeOptions } from "../../core/context.js";
import { CliError } from "../../core/errors.js";
import { writeText, adoptCliReplyText } from "../../core/renderer.js";
import { requireTargetAlias, type TargetAliasOpts } from "../_target.js";

interface ReceiptOpts extends TargetAliasOpts {
  number?: string;
  object?: string;
  purpose?: string;
  teardownOwner?: string;
  securityPrivacy?: string;
  expiry?: string;
  runbook?: string;
  tracking?: string;
}

function requiredNonblank(opts: ReceiptOpts, key: keyof ReceiptOpts, flag: string): string {
  const value = opts[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new CliError({ code: "INVALID_ARG", message: `${flag} is required and must be nonblank` });
  }
  return value.trim();
}

export const taskReceiptCommand = defineCommand(
  {
    name: "receipt",
    description: "Record the structured receipt for a resource-creating task",
    options: [
      { flags: "--target <target>", description: "Channel target: '#channel'" },
      { flags: "--channel <target>", description: "Legacy alias for --target (accepted during transition)" },
      { flags: "--number <n>", description: "Task number" },
      { flags: "--object <description>", description: "Exact resource object or identity" },
      { flags: "--purpose <description>", description: "Why the resource exists" },
      { flags: "--teardown-owner <@agent>", description: "Agent responsible for teardown" },
      { flags: "--security-privacy <summary>", description: "Security/privacy classification and controls (never include secrets)" },
      { flags: "--expiry <iso>", description: "Future ISO-8601 expiry timestamp" },
      { flags: "--runbook <reference>", description: "Teardown/operations runbook reference" },
      { flags: "--tracking <reference>", description: "Authoritative tracking reference" },
    ],
    helpAfter: [
      "All seven receipt fields are required and nonblank.",
      "Recording succeeds atomically with a durable expiry follow-up owned by --teardown-owner and anchored to this task.",
      "Do not place credentials, tokens, or secret values in receipt fields.",
    ].join("\n"),
  },
  async (ctx, opts: ReceiptOpts) => {
    const channel = requireTargetAlias(opts);
    const taskNumber = Number(opts.number);
    if (!Number.isInteger(taskNumber) || taskNumber <= 0) {
      throw new CliError({ code: "INVALID_ARG", message: `--number must be a positive integer; got ${opts.number}` });
    }
    const teardownOwner = requiredNonblank(opts, "teardownOwner", "--teardown-owner");
    if (!teardownOwner.startsWith("@") || teardownOwner.slice(1).trim().length === 0) {
      throw new CliError({ code: "INVALID_ARG", message: "--teardown-owner must be an @agent handle" });
    }
    const expiry = requiredNonblank(opts, "expiry", "--expiry");
    if (!Number.isFinite(new Date(expiry).getTime())) {
      throw new CliError({ code: "INVALID_ARG", message: "--expiry must be an ISO-8601 timestamp" });
    }

    const body: AgentApiTaskResourceReceiptBody = {
      channel,
      task_number: taskNumber,
      receipt: {
        object: requiredNonblank(opts, "object", "--object"),
        purpose: requiredNonblank(opts, "purpose", "--purpose"),
        teardown_owner: `@${teardownOwner.slice(1).trim()}`,
        security_privacy: requiredNonblank(opts, "securityPrivacy", "--security-privacy"),
        expiry: new Date(expiry).toISOString(),
        runbook: requiredNonblank(opts, "runbook", "--runbook"),
        tracking: requiredNonblank(opts, "tracking", "--tracking"),
      },
    };
    const agentContext = ctx.loadAgentContext();
    const client = ctx.createApiClient(agentContext);
    const agentApi = createAgentApiSurfaceClient(client);
    const res = await agentApi.tasks.recordResourceReceipt(body);
    if (!res.ok) {
      throw new CliError({
        code: res.status >= 500 ? "SERVER_5XX" : "RECEIPT_FAILED",
        message: res.error ?? `HTTP ${res.status}`,
      });
    }
    if (!res.data) {
      throw new CliError({
        code: "INVALID_JSON_RESPONSE",
        message: "Agent API taskResourceReceipt returned an empty response body",
      });
    }
    writeText(ctx.io, adoptCliReplyText([
      `Resource receipt recorded for task #${res.data.taskNumber} in ${channel}.`,
      `Expiry follow-up ${res.data.expiryFollowup.id.slice(0, 8)} owned by ${res.data.expiryFollowup.owner} fires ${res.data.expiryFollowup.fireAt}.`,
      `Follow-up anchor: msg=${res.data.expiryFollowup.msgId.slice(0, 8)} targetChannelId=${res.data.expiryFollowup.targetChannelId}.`,
    ].join("\n") + "\n"));
  },
);

export function registerTaskReceiptCommand(parent: Command, runtimeOptions?: CommandRuntimeOptions): void {
  registerCliCommand(parent, taskReceiptCommand, runtimeOptions);
}
