import fs from "node:fs";

import type { AgentApiRequestBodyByRoute } from "@botiverse/raft-shared";
import type { Command } from "commander";

import { createAgentApiSurfaceClient } from "../../agentApiPath.js";
import { defineCommand, registerCliCommand } from "../../core/command.js";
import type { CommandRuntimeOptions } from "../../core/context.js";
import { CliError } from "../../core/errors.js";
import { writeJson } from "../../core/renderer.js";

interface WikiPublishOptions {
  input: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function wikiError(
  operation: "manifest" | "artifact" | "publish",
  response: {
    status: number;
    error?: string | null;
    errorCode?: string | null;
    suggestedNextAction?: string | null;
  },
): CliError {
  return new CliError({
    code: operation === "manifest"
      ? "WIKI_MANIFEST_GET_FAILED"
      : operation === "artifact"
        ? "WIKI_ARTIFACT_READ_FAILED"
        : "WIKI_MANIFEST_PUBLISH_FAILED",
    message: response.error ?? `HTTP ${response.status}`,
    suggestedNextAction: response.suggestedNextAction ?? undefined,
  });
}

export const wikiManifestCommand = defineCommand(
  {
    name: "manifest",
    description: "Read the canonical Wiki manifest and its current ETag",
  },
  async (ctx) => {
    const agentContext = ctx.loadAgentContext();
    const client = ctx.createApiClient(agentContext);
    const response = await createAgentApiSurfaceClient(client).wiki.manifest();
    if (!response.ok || !response.data) {
      throw wikiError("manifest", response);
    }
    writeJson(ctx.io, response.data);
  },
);

export const wikiReadCommand = defineCommand(
  {
    name: "read",
    description: "Read the current canonical Markdown for one Wiki artifact",
    arguments: ["<artifactId>"],
  },
  async (ctx, artifactId: string | undefined) => {
    const normalizedArtifactId = artifactId?.trim() ?? "";
    if (!UUID_RE.test(normalizedArtifactId)) {
      throw new CliError({
        code: "INVALID_ARG",
        message: "artifactId must be a full UUID",
        suggestedNextAction: "Run `raft wiki manifest` to find the current artifact id.",
      });
    }
    const agentContext = ctx.loadAgentContext();
    const client = ctx.createApiClient(agentContext);
    const response = await createAgentApiSurfaceClient(client).wiki.read({
      artifactId: normalizedArtifactId,
    });
    if (!response.ok || !response.data) {
      throw wikiError("artifact", response);
    }
    writeJson(ctx.io, response.data);
  },
);

export const wikiPublishCommand = defineCommand(
  {
    name: "publish",
    description: "Conditionally publish immutable Wiki revisions and the canonical manifest",
    options: [{
      flags: "--input <path>",
      description: "JSON file containing expectedEtag, manifest, and revisionBodies",
    }],
    helpAfter:
      "\nThe input JSON must match the Wiki publication contract. Read the latest ETag with\n"
      + "`raft wiki manifest` immediately before constructing a publication.\n",
  },
  async (ctx, options: WikiPublishOptions) => {
    if (!options.input?.trim()) {
      throw new CliError({
        code: "INVALID_ARG",
        message: "--input is required",
        suggestedNextAction: "Run `raft wiki publish --help` for syntax.",
      });
    }

    let body: AgentApiRequestBodyByRoute["wikiManifestPublish"];
    try {
      body = JSON.parse(fs.readFileSync(options.input, "utf8")) as AgentApiRequestBodyByRoute["wikiManifestPublish"];
    } catch (cause) {
      throw new CliError({
        code: "INVALID_ARG",
        message: `Could not read Wiki publication JSON from ${options.input}`,
        cause,
      });
    }

    const agentContext = ctx.loadAgentContext();
    const client = ctx.createApiClient(agentContext);
    const response = await createAgentApiSurfaceClient(client).wiki.publish(body);
    if (!response.ok || !response.data) {
      throw wikiError("publish", response);
    }
    writeJson(ctx.io, response.data);
  },
);

export function registerWikiCommands(parent: Command, runtimeOptions?: CommandRuntimeOptions): void {
  registerCliCommand(parent, wikiManifestCommand, runtimeOptions);
  registerCliCommand(parent, wikiReadCommand, runtimeOptions);
  registerCliCommand(parent, wikiPublishCommand, runtimeOptions);
}
