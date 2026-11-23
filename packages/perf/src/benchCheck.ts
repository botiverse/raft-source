#!/usr/bin/env node
/**
 * raft-perf bench-check: verify that a frozen benchmark channel on a deployed
 * Raft server still matches its expected message/thread counts and content
 * SHA-256 before (or after) measurements run (#proj-frontend:#71).
 *
 *   RAFT_PERF_EMAIL=… RAFT_PERF_PASSWORD=… \
 *   pnpm --filter @botiverse/raft-perf bench-check -- --fixture bench-v1
 *
 * Exit codes: 0 verified, 1 the channel drifted from its fixture, 2 usage/network error.
 */

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { cliArgs } from "./args";
import { computeChannelDigest, loadBenchFixture, verifyFixtureDigest } from "./benchFixture";
import { isProductionHost } from "./page";

const HELP = `raft-perf bench-check — verify a frozen benchmark channel's content and counts

Required env: RAFT_PERF_EMAIL, RAFT_PERF_PASSWORD (a test account).
Options:
  --fixture <f>       built-in fixture name (default bench-v1) or path to fixture JSON
  --api <url>         API origin (default https://api-aws-staging.botiverse.dev)
  --allow-production  allow checking a production API (*.raft.build)
Exit codes: 0 matches, 1 drifted (mismatches listed), 2 error.
`;

class BenchCheckError extends Error {}
const fail = (message: string): never => {
  throw new BenchCheckError(message);
};

/** Sign in with an existing token or fetch a channel's first-page digest and verify it against `spec`. */
export async function fetchAndVerifyFixture(
  api: string,
  accessToken: string,
  serverId: string,
  channelId: string,
  spec: ReturnType<typeof loadBenchFixture>,
): Promise<ReturnType<typeof verifyFixtureDigest>> {
  let response: Response;
  try {
    response = await fetch(`${api}/api/messages/channel/${channelId}?limit=200`, {
      headers: { authorization: `Bearer ${accessToken}`, "x-server-id": serverId },
    });
  } catch (error) {
    throw new Error(`GET /api/messages/channel/:id failed: ${(error as Error).message}`);
  }
  if (!response.ok) throw new Error(`GET /api/messages/channel/:id answered ${response.status}`);
  const payload = await response.json().catch(() => {
    throw new Error("/api/messages/channel/:id did not answer JSON");
  });
  return verifyFixtureDigest(computeChannelDigest(payload), spec);
}

async function main(): Promise<number> {
  const { values: args } = parseArgs({
    args: cliArgs(),
    options: {
      fixture: { type: "string", default: "bench-v1" },
      api: { type: "string", default: "https://api-aws-staging.botiverse.dev" },
      out: { type: "string" },
      "allow-production": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const api = args.api!.replace(/\/$/, "");
  let production = false;
  try {
    production = isProductionHost(api);
  } catch {
    fail("--api must be an http(s) URL");
  }
  if (production && !args["allow-production"]) {
    fail("refusing a production API without --allow-production");
  }
  const spec = (() => {
    try {
      return loadBenchFixture(args.fixture!);
    } catch (error) {
      return fail((error as Error).message);
    }
  })();
  const email = process.env.RAFT_PERF_EMAIL;
  const password = process.env.RAFT_PERF_PASSWORD;
  if (!email || !password) fail("set RAFT_PERF_EMAIL and RAFT_PERF_PASSWORD (a test account)");

  const json = async (url: string, init: RequestInit = {}): Promise<unknown> => {
    const response = await fetch(url, init).catch((error: Error) => fail(`${new URL(url).pathname} failed: ${error.message}`));
    if (!response.ok) fail(`${new URL(url).pathname} answered ${response.status}`);
    return response.json().catch(() => fail(`${new URL(url).pathname} did not answer JSON`));
  };
  const session = (await json(`${api}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  })) as { accessToken?: string };
  if (!session.accessToken) fail("sign-in returned no access token");
  const auth = { authorization: `Bearer ${session.accessToken}` };
  const servers = (await json(`${api}/api/servers`, { headers: auth })) as Array<{ id: string; slug: string }> | { servers: Array<{ id: string; slug: string }> };
  const server = (Array.isArray(servers) ? servers : servers.servers).find((s) => s.slug === spec.server) ?? fail(`the account is not a member of server ${spec.server}`);
  const channels = (await json(`${api}/api/channels`, { headers: { ...auth, "x-server-id": server.id } })) as Array<{ id: string; name: string }> | { channels: Array<{ id: string; name: string }> };
  const list = Array.isArray(channels) ? channels : channels.channels;
  const channel = list.find((c) => c.name === spec.channel) ?? fail(`no channel ${spec.channel} in ${spec.server}`);
  if (spec.other && !list.some((c) => c.name === spec.other)) fail(`no secondary channel ${spec.other} in ${spec.server}`);

  const check = await fetchAndVerifyFixture(api, session.accessToken!, server.id, channel.id, spec).catch((error: Error) => fail(error.message));
  const report = {
    tool: "raft-perf bench-check",
    checkedAt: new Date().toISOString(),
    api,
    fixture: spec.fixture,
    server: spec.server,
    channel: spec.channel,
    ...(spec.other ? { other: spec.other } : {}),
    ...check,
  };
  const text = `${JSON.stringify(report, null, 2)}\n`;
  process.stdout.write(text);
  if (args.out) writeFileSync(args.out, text);
  if (!check.ok) {
    process.stderr.write(`raft-perf bench-check ${spec.fixture}: DRIFTED (${check.mismatches.join("; ")})\n`);
    return 1;
  }
  process.stderr.write(`raft-perf bench-check ${check.tag}: ok (${check.digest.topLevel} messages, ${check.digest.threadSummaries} threads, ${check.digest.contentChars} chars)\n`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`raft-perf bench-check: ${error instanceof BenchCheckError ? error.message : `failed: ${(error as Error)?.stack ?? String(error)}`}\n`);
      process.exitCode = 2;
    },
  );
}
