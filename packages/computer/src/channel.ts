// `raft-computer channel show|set` — CLI presenters over the ComputerApi.
// The channel STATE core (parse/read/write, v6 §11 enum) lives in
// lib/channelState.ts so the facade and upgrade/service internals consume it
// without importing this presenter layer (decycle R0, #wg-raft-computer:18ab6541).
// The core symbols are re-exported here verbatim for existing import sites.

import { computerDir } from "./paths.js";
import { info, present } from "./output.js";
import { createComputerApi } from "./lib/api.js";
import { clearClockTimeout, setClockTimeout } from "@botiverse/raft-shared";
import { parseChannel, readChannel } from "./lib/channelState.js";
import { ComputerError } from "./lib/errors.js";
import { HANDS_API_ORIGIN, HANDS_COMPUTER_APP_SLUG } from "./releaseAuthority.js";
import { COMPUTER_VERSION } from "./version.js";

export {
  DEFAULT_CHANNEL,
  SEMVER_RE,
  parseChannel,
  readChannel,
  writeChannel,
  type Channel,
} from "./lib/channelState.js";

// --- CLI command handlers ---

/**
 * `raft-computer channel show` — CLI presenter over `api.channelShow`. Prints
 * the current channel (default `latest` when unset).
 */
export async function runChannelShow(slockHome: string): Promise<void> {
  void computerDir; // ensure import preserved when only used downstream
  const api = createComputerApi(slockHome);
  await present(async () => {
    info(await api.channelShow());
  });
}

/**
 * `raft-computer channel set <channel>` — CLI presenter over `api.channelSet`.
 * The api validates + persists the channel and throws `CHANNEL_INVALID`
 * (mapped to the shared stderr error contract by `present()`).
 */
export async function runChannelSet(slockHome: string, raw: string): Promise<void> {
  const api = createComputerApi(slockHome);
  await present(async () => {
    const parsed = await api.channelSet(raw);
    info(`Channel set to ${parsed}.`);
    info(`The next \`raft-computer upgrade\` uses ${parsed}.`);
  });
}

export type ListedChannel = "latest" | "alpha";

export interface ChannelVersionEntry {
  version: string;
  status: "active" | "superseded";
  publishedAt: number;
  releaseId: string;
  sha256: string;
  sizeBytes: number;
}

export interface ChannelVersionsResult {
  schemaVersion: 1;
  channel: ListedChannel;
  installedVersion: string;
  target: { platform: string; arch: string };
  truncated: boolean;
  versions: Array<ChannelVersionEntry & {
    label: "latest" | "available";
    installed: boolean;
  }>;
}

interface HandsVersionsResponse {
  schema_version: 1;
  app: { slug: string };
  channel: string;
  target: { platform: string; arch: string };
  truncated: boolean;
  versions: Array<{
    version: string;
    version_code: number;
    status: "active" | "superseded";
    published_at: number;
    release_id: string;
    sha256: string;
    size_bytes: number;
  }>;
}

export interface ChannelVersionsDeps {
  fetchFn?: typeof fetch;
  apiOrigin?: string;
  appSlug?: string;
  platform?: string;
  arch?: string;
  installedVersion?: string;
  timeoutMs?: number;
}

export interface RunChannelVersionsOptions {
  json?: boolean;
  limit?: number;
}

const CHANNEL_VERSIONS_DEFAULT_LIMIT = 20;
const CHANNEL_VERSIONS_MAX_LIMIT = 100;

function isStrictSemver(value: unknown): value is string {
  return typeof value === "string"
    && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(value);
}

function mapListedChannel(channel: ListedChannel): "main" | "alpha" {
  return channel === "latest" ? "main" : "alpha";
}

function validateVersionsResponse(
  value: unknown,
  expected: { appSlug: string; channel: "main" | "alpha"; platform: string; arch: string },
): HandsVersionsResponse {
  if (!value || typeof value !== "object") {
    throw new ComputerError("CHANNEL_VERSIONS_INVALID", "Hands returned a malformed version index.");
  }
  const body = value as Partial<HandsVersionsResponse>;
  if (
    body.schema_version !== 1
    || body.app?.slug !== expected.appSlug
    || body.channel !== expected.channel
    || body.target?.platform !== expected.platform
    || body.target.arch !== expected.arch
    || typeof body.truncated !== "boolean"
    || !Array.isArray(body.versions)
  ) {
    throw new ComputerError("CHANNEL_VERSIONS_INVALID", "Hands returned a version index for a different channel or target.");
  }
  for (const entry of body.versions) {
    if (
      !isStrictSemver(entry?.version)
      || !Number.isSafeInteger(entry.version_code)
      || entry.version_code < 0
      || (entry.status !== "active" && entry.status !== "superseded")
      || !Number.isSafeInteger(entry.published_at)
      || entry.published_at < 0
      || !Number.isFinite(new Date(entry.published_at).valueOf())
      || typeof entry.release_id !== "string"
      || entry.release_id.length === 0
      || !/^[a-f0-9]{64}$/u.test(entry.sha256 ?? "")
      || !Number.isSafeInteger(entry.size_bytes)
      || entry.size_bytes < 0
    ) {
      throw new ComputerError("CHANNEL_VERSIONS_INVALID", "Hands returned a version entry with invalid release identity.");
    }
  }
  return body as HandsVersionsResponse;
}

export async function listChannelVersions(
  channel: ListedChannel,
  limit: number,
  deps: ChannelVersionsDeps = {},
): Promise<ChannelVersionsResult> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > CHANNEL_VERSIONS_MAX_LIMIT) {
    throw new ComputerError(
      "CHANNEL_VERSIONS_LIMIT_INVALID",
      `--limit must be an integer from 1 to ${CHANNEL_VERSIONS_MAX_LIMIT}.`,
    );
  }
  const platform = deps.platform ?? process.platform;
  const arch = deps.arch ?? process.arch;
  const apiChannel = mapListedChannel(channel);
  const origin = (deps.apiOrigin ?? HANDS_API_ORIGIN).replace(/\/+$/u, "");
  const appSlug = deps.appSlug ?? HANDS_COMPUTER_APP_SLUG;
  const url = new URL(`/public/v2/apps/${encodeURIComponent(appSlug)}/versions`, `${origin}/`);
  url.searchParams.set("channel", apiChannel);
  url.searchParams.set("platform", platform);
  url.searchParams.set("arch", arch);
  url.searchParams.set("limit", String(limit));

  const controller = new AbortController();
  const timeoutId = setClockTimeout(() => controller.abort(), deps.timeoutMs ?? 10_000);
  let response: Response;
  try {
    response = await (deps.fetchFn ?? fetch)(url, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
  } catch (error) {
    throw new ComputerError(
      "CHANNEL_VERSIONS_FAILED",
      `Could not read the ${channel} version index from Hands. Check network/VPN/proxy connectivity and retry.${error instanceof Error && error.name === "AbortError" ? " The request timed out." : ""}`,
    );
  } finally {
    clearClockTimeout(timeoutId);
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { code?: unknown } | null;
    const suffix = typeof body?.code === "string" ? ` (${body.code})` : "";
    throw new ComputerError(
      response.status === 409 ? "CHANNEL_VERSIONS_INVALID" : "CHANNEL_VERSIONS_UNAVAILABLE",
      `Hands could not provide the ${channel} version index${suffix}.`,
    );
  }
  const parsed = await response.json().catch(() => {
    throw new ComputerError("CHANNEL_VERSIONS_INVALID", "Hands returned a malformed version index.");
  });
  const body = validateVersionsResponse(parsed, {
    appSlug,
    channel: apiChannel,
    platform,
    arch,
  });
  const installedVersion = deps.installedVersion ?? COMPUTER_VERSION;
  return {
    schemaVersion: 1,
    channel,
    installedVersion,
    target: { platform, arch },
    truncated: body.truncated,
    versions: body.versions.map((entry) => ({
      version: entry.version,
      status: entry.status,
      publishedAt: entry.published_at,
      releaseId: entry.release_id,
      sha256: entry.sha256,
      sizeBytes: entry.size_bytes,
      label: entry.status === "active" ? "latest" : "available",
      installed: entry.version === installedVersion,
    })),
  };
}

function formatHumanVersions(result: ChannelVersionsResult): string[] {
  if (result.versions.length === 0) {
    return [`No installable versions are published on channel ${result.channel} for ${result.target.platform}-${result.target.arch}.`];
  }
  const rows = result.versions.map((entry) => ({
    version: entry.version,
    channel: result.channel,
    status: [entry.label, ...(entry.installed ? ["installed"] : [])].join(","),
    published: new Date(entry.publishedAt).toISOString().slice(0, 10),
  }));
  const widths = {
    version: Math.max("VERSION".length, ...rows.map((row) => row.version.length)),
    channel: Math.max("CHANNEL".length, ...rows.map((row) => row.channel.length)),
    status: Math.max("STATUS".length, ...rows.map((row) => row.status.length)),
  };
  return [
    `${"VERSION".padEnd(widths.version)}  ${"CHANNEL".padEnd(widths.channel)}  ${"STATUS".padEnd(widths.status)}  PUBLISHED`,
    ...rows.map((row) =>
      `${row.version.padEnd(widths.version)}  ${row.channel.padEnd(widths.channel)}  ${row.status.padEnd(widths.status)}  ${row.published}`),
    ...(result.truncated
      ? [`Showing the first ${result.versions.length} versions. Re-run with a larger --limit (maximum ${CHANNEL_VERSIONS_MAX_LIMIT}).`]
      : []),
  ];
}

/** `raft-computer channel versions [channel]` — read-only Hands index presenter. */
export async function runChannelVersions(
  slockHome: string,
  rawChannel: string | undefined,
  opts: RunChannelVersionsOptions = {},
  deps: ChannelVersionsDeps = {},
): Promise<void> {
  await present(async () => {
    const selected = rawChannel === undefined ? await readChannel(slockHome) : parseChannel(rawChannel);
    if (selected === null) {
      throw new ComputerError(
        "CHANNEL_INVALID",
        `Invalid channel "${rawChannel}". Accepted: \`latest\` or \`alpha\`.`,
      );
    }
    if (selected !== "latest" && selected !== "alpha") {
      throw new ComputerError(
        "CHANNEL_VERSIONS_PINNED",
        "A pinned selector names one exact version, not a version channel. Pass `latest` or `alpha`.",
      );
    }
    const result = await listChannelVersions(
      selected,
      opts.limit ?? CHANNEL_VERSIONS_DEFAULT_LIMIT,
      deps,
    );
    if (opts.json) {
      info(JSON.stringify(result));
      return;
    }
    for (const line of formatHumanVersions(result)) info(line);
  });
}
