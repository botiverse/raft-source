// `raft artifact pull <artifact> [--dir <dir>] [--rev <n>]`
// → GET /internal/agent-api/artifacts/:artifact, then each file's bytes
//
// Puts one version's files in a directory and records that version as the base
// of the next `raft artifact push <dir>`. Pulling into a directory that
// holds the same artifact updates it, unless it has changes not pushed yet. Every
// file is downloaded before the directory is touched, so a failed pull leaves
// it as it was. Another server's artifact (the read's `mayPush` false: a public
// one, a joint's) comes down as a copy with no base, into a new or empty
// directory, and the output says to push it as a new artifact instead. A file
// of the artifact's own named .raft-artifact.json is never written, in either
// mode: that name ties a directory to an artifact, and the file is the author's
// (another server's, for a copy), so it could point a push anywhere.

import { existsSync, rmSync } from "node:fs";

import type { Command } from "commander";
import { artifactsFile, artifactsRead, foldAgentOneLineText, formatHint, isWellFormedArtifactFilePath, RAFT_HINTS } from "@botiverse/raft-shared/src/agentCliSurface";

import { createAgentApiContractSurfaceClient } from "../../agentApiPath";
import { defineCommand, registerCliCommand } from "../../core/command";
import type { CommandRuntimeOptions } from "../../core/context";
import { CliError } from "../../core/errors";
import { writeText } from "../../core/renderer";
import { ARTIFACT_STATE_FILE, fileTarget, isArtifactStateFilePath, isEmptyDir, localChanges, pullDirName, readDirState, sha256Of, unsafeArtifactPath, writeDirState, writeFileUnder } from "./_dir";
import { formatArtifactPulled } from "./_format";
import { artifactArgument, artifactCliError, parseVersion, splitArgs } from "./_shared";

interface PullOpts {
  artifact?: string;
  dir?: string;
  rev?: string;
}

/** How many files a pull downloads at once. */
export const PULL_CONCURRENCY = 6;

/**
 * `fn` over `items`, at most `limit` at a time; results in the items' order.
 * The first rejection rejects it, and nothing more is started after it (the
 * ones already running finish), so a failed pull doesn't go on downloading.
 */
export async function mapConcurrently<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (!failed && next < items.length) {
      const index = next++;
      try {
        results[index] = await fn(items[index]!);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export const artifactPullCommand = defineCommand(
  {
    name: "pull",
    description: "Download an artifact's files into a directory to work on them; the version pulled is the base of your next push",
    arguments: ["[artifact]"],
    options: [
      { flags: "--artifact <artifact>", description: "The artifact, if not given as the first argument: its id, link or exact title" },
      { flags: "--dir <dir>", description: "Where to put the files (default: ./<its title>, made safe as a folder name; its short id if nothing is left)" },
      { flags: "--rev <n>", description: "Pull an older version, e.g. 9 or v9 (default: the current one)" },
    ],
  },
  async (ctx, ...args: unknown[]) => {
    const { positionals, opts } = splitArgs<PullOpts>(args, 1);
    const artifact = artifactArgument(positionals[0], opts.artifact);
    const version = parseVersion(opts.rev);
    const agentContext = ctx.loadAgentContext();
    const api = createAgentApiContractSurfaceClient(ctx.createApiClient(agentContext));

    const read = await artifactsRead(api, { artifact, ...(version === undefined ? {} : { version }) });
    if (!read.ok) throw artifactCliError(read);
    const summary = read.data.artifact;
    const shown = read.data.version;
    if (!shown) {
      throw new CliError({ code: "ARTIFACT_FAILED", message: `"${foldAgentOneLineText(summary.title)}" (${summary.id}) has no version yet, so there is nothing to pull.` });
    }
    const dir = opts.dir ?? `./${pullDirName(summary)}`;
    const elsewhere = formatHint(RAFT_HINTS.artifactPull({ artifact: summary.id, dir: "<new dir>" }));
    // Another server's Artifact (`mayPush` false; absent from older Servers: true): a copy, no base to push to.
    const copy = read.data.mayPush === false;

    const state = existsSync(dir) ? readDirState(dir) : null;
    if (state && copy) {
      throw new CliError({ code: "ARTIFACT_DIR_CONFLICT", message: `${dir} holds a pulled artifact (${state.artifact}).`, suggestedNextAction: `Pull the copy into a new or empty directory: ${elsewhere}` });
    }
    if (state) {
      if (state.artifact !== summary.id) {
        throw new CliError({ code: "ARTIFACT_DIR_CONFLICT", message: `${dir} holds another artifact (${state.artifact}).`, suggestedNextAction: `Pull into another directory: ${elsewhere}` });
      }
      const { changed, missing } = localChanges(dir, state);
      if (changed.length > 0 || missing.length > 0) {
        throw new CliError({
          code: "ARTIFACT_DIR_CONFLICT",
          message: `${dir} has changes not pushed yet (${[...changed, ...missing.map((p) => `${p} removed`)].join(", ")}).`,
          suggestedNextAction: `Push them first (${formatHint(RAFT_HINTS.artifactPublish({ dir }))}), or pull into another directory: ${elsewhere}`,
        });
      }
    } else if (!isEmptyDir(dir)) {
      throw new CliError({
        code: "ARTIFACT_DIR_CONFLICT",
        message: `${dir} is not empty and holds no pulled artifact (no ${ARTIFACT_STATE_FILE}).`,
        suggestedNextAction: `Pull into a new or empty directory: ${elsewhere}`,
      });
    }

    // A path the CLI never writes (`.git/config`, `..`) refuses the whole pull before any download or write.
    for (const file of shown.files) {
      if (!isWellFormedArtifactFilePath(file.path)) throw unsafeArtifactPath(file.path, dir);
    }

    // Everything first: a failed download leaves the directory as it was. The files come
    // PULL_CONCURRENCY at a time (reads have no rate limit), so a pull costs about one round
    // trip per batch, not one per file; the first failure refuses the whole pull.
    const wanted = shown.files.filter((file) => !isArtifactStateFilePath(file.path));
    const leftOutStateFile = wanted.length < shown.files.length;
    const downloaded = await mapConcurrently(wanted, PULL_CONCURRENCY, async (file) => {
      const got = await artifactsFile(api, { artifact: summary.id, path: file.path, version: shown.number });
      if (!got.ok) throw artifactCliError(got);
      return { path: file.path, bytes: got.data.bytes };
    });

    if (state) for (const path of Object.keys(state.files)) rmSync(fileTarget(dir, path), { force: true });
    const files: Record<string, string> = {};
    let sizeBytes = 0;
    for (const { path, bytes } of downloaded) {
      writeFileUnder(dir, path, bytes);
      files[path] = sha256Of(bytes);
      sizeBytes += bytes.byteLength;
    }
    // A copy records no base: pushing the directory makes a new artifact (--target), never a version of this one.
    if (!copy) writeDirState(dir, { artifact: summary.id, title: summary.title, version: shown.number, files });
    // What others added since the agent last looked: it is about to edit these files.
    writeText(ctx.io, formatArtifactPulled({ artifact: summary.id, title: summary.title, version: shown.number, fileCount: wanted.length, sizeBytes, dir, updated: state !== null, unseen: read.data.unseen, ...(copy ? { copy: { url: summary.url } } : {}), leftOutStateFile }));
  },
);

export function registerArtifactPullCommand(parent: Command, runtimeOptions?: CommandRuntimeOptions): void {
  registerCliCommand(parent, artifactPullCommand, runtimeOptions);
}
