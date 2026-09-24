// `raft attachment view <attachmentId> --output <path>`
// → GET /internal/agent-api/attachments/:id
//
// Writes the downloaded bytes to disk. Caller controls where the file lands.

import { writeFileSync } from "node:fs";

import {
  AGENT_API_ATTACHMENT_DOWNLOAD_UNAVAILABLE_MESSAGE,
  AGENT_API_ATTACHMENT_DOWNLOAD_UNAVAILABLE_NEXT_ACTION,
} from "@botiverse/raft-shared";
import type { Command } from "commander";

import { createAgentApiSurfaceClient } from "../../agentApiPath.js";
import { defineCommand, registerCliCommand } from "../../core/command.js";
import type { CommandRuntimeOptions } from "../../core/context.js";
import { CliError } from "../../core/errors.js";
import { writeText,  } from "../../core/renderer.js";
import { formatAttachmentDownloaded } from "./_format.js";

interface ViewOpts {
  id?: string;
  output: string;
}

function validateViewOpts(positionalId: string | undefined, opts: Partial<ViewOpts>): { id: string; output: string } {
  const positional = positionalId?.trim();
  const optionId = opts.id?.trim();
  if (positional && optionId) {
    throw new CliError({
      code: "INVALID_ARG",
      message: "pass the attachment id either positionally or with --id, not both",
    });
  }
  const id = positional || optionId;
  const output = opts.output;
  if (!id) {
    throw new CliError({
      code: "INVALID_ARG",
      message: "attachment id is required (pass <attachmentId> or --id)",
    });
  }
  if (!output) {
    throw new CliError({
      code: "INVALID_ARG",
      message: "--output is required",
    });
  }
  return { id, output };
}

export const attachmentViewCommand = defineCommand(
  {
    name: "view",
    description: "Download an attachment by id and save it to a local path",
    arguments: ["[attachmentId]"],
    options: [
      { flags: "--id <attachmentId>", description: "Attachment UUID (transition alias; prefer positional <attachmentId>)" },
      { flags: "--output <path>", description: "Local path to write the file to" },
    ],
  },
  async (ctx, attachmentIdOrOpts: string | Partial<ViewOpts> | undefined, maybeOpts?: Partial<ViewOpts>) => {
    const positionalId = typeof attachmentIdOrOpts === "string" ? attachmentIdOrOpts : undefined;
    const opts = typeof attachmentIdOrOpts === "object" && attachmentIdOrOpts !== null ? attachmentIdOrOpts : (maybeOpts ?? {});
    const { id, output } = validateViewOpts(positionalId, opts);
    const agentContext = ctx.loadAgentContext();
    const client = ctx.createApiClient(agentContext);
    const res = await createAgentApiSurfaceClient(client).attachments.view({ attachmentId: id });
    if (!res.ok) {
      const unavailable = res.status === 404;
      throw new CliError({
        code: res.status >= 500 ? "SERVER_5XX" : "VIEW_FAILED",
        message: unavailable
          ? AGENT_API_ATTACHMENT_DOWNLOAD_UNAVAILABLE_MESSAGE
          : (res.error ?? `HTTP ${res.status}`),
        suggestedNextAction: unavailable
          ? AGENT_API_ATTACHMENT_DOWNLOAD_UNAVAILABLE_NEXT_ACTION
          : undefined,
      });
    }
    if (res.data === null) {
      throw new CliError({
        code: "VIEW_FAILED",
        message: "Attachment download returned no bytes",
      });
    }

    const buffer = Buffer.from(res.data);
    writeFileSync(output, buffer);

    writeText(ctx.io, formatAttachmentDownloaded(output));
  },
);

export function registerAttachmentViewCommand(parent: Command, runtimeOptions?: CommandRuntimeOptions): void {
  registerCliCommand(parent, attachmentViewCommand, runtimeOptions);
}
