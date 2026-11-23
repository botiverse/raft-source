// `raft-computer attach <serverSlug>` — CLI presenter over the ComputerApi
// (CLI-over-lib convergence). The pure logic lives in `lib/api.ts`
// (`api.attachWithApproval` drives the one-time approval + AttachService —
// fail-closed preflight, secret-free events, the ATTACH_* closed-set codes).
// This presenter supplies the EVENT SINK (`onEvent`) that maps the approval
// prompt + attach events → `info()` lines, and `present()` maps a thrown
// `ComputerError` → the shared stderr error contract.
//
// `useUserSession` keeps the user-session attach for setup's legacy-daemon
// migration branch, which already signed in to read the legacy roster.
import { presentAttachEvent, presentDeviceCode } from "./deviceApprovalPrompt";
import { createLoopbackLoginPresenter } from "./loopbackLoginPrompt";
import { fail, info, present } from "./output";
import { resolveRaftHome } from "./paths";
import { normalizeServerSlug } from "./serverState";
import { createComputerApi } from "./lib/api";
import { createComputerTracer } from "./lib/computerTracer";
import type { ComputerCliAttachJson } from "@botiverse/raft-shared";

export async function runAttach(opts: {
  serverSlug: string;
  serverUrl?: string;
  name?: string;
  start?: boolean;
  foreground?: boolean;
  orchestrated?: boolean;
  useUserSession?: boolean;
  input?: NodeJS.ReadableStream;
  openUrl?: (url: string) => void;
  /** `--device-code`: approve with a code even when the browser is on this machine. */
  deviceCode?: boolean;
  /** `--pair`, already checked (pairFlag.ts): sent on a device-code approval only. */
  pairingId?: string;
}): Promise<void> {
  const slockHome = resolveRaftHome();
  const api = createComputerApi(slockHome);
  const loopback = createLoopbackLoginPresenter({
    deviceCode: opts.deviceCode,
    tracer: createComputerTracer(slockHome, "computer.cli"),
    ...(opts.input ? { input: opts.input } : {}),
  });
  let cleanupEnterToOpen: (() => void) | undefined;
  await present(async () => {
    try {
      const attachOpts = { serverSlug: opts.serverSlug, serverUrl: opts.serverUrl, name: opts.name };
      const onEvent = (event: Parameters<typeof presentAttachEvent>[0]) => {
        if (loopback.handleEvent(event)) return;
        if (event.kind === "login.device-code") {
          cleanupEnterToOpen?.();
          cleanupEnterToOpen = presentDeviceCode(event, {
            purpose: "approval",
            serverSlug: opts.serverSlug,
            ...(opts.input ? { input: opts.input } : {}),
            ...(opts.openUrl ? { openUrl: opts.openUrl } : {}),
          });
          return;
        }
        if (event.kind === "attach.attaching" || event.kind === "attach.session-fallback") {
          // Approved: the Enter-to-open listener is no longer useful.
          cleanupEnterToOpen?.();
          cleanupEnterToOpen = undefined;
        }
        presentAttachEvent(event);
      };
      if (opts.useUserSession) {
        await api.attach(attachOpts, onEvent);
      } else {
        await api.attachWithApproval(
          {
            ...attachOpts,
            loopback: loopback.options,
            ...(opts.pairingId ? { pairing: { pairingId: opts.pairingId, serverSlug: normalizeServerSlug(opts.serverSlug) } } : {}),
          },
          onEvent,
        );
      }
    } finally {
      loopback.cleanup();
      cleanupEnterToOpen?.();
    }
  });

  if (opts.orchestrated) {
    return;
  }
  if (opts.start === false) {
    info("Next: run `raft-computer start` to run it in the background.");
  } else {
    // `attach` writes local state only; the resident process is started
    // explicitly by `start` (its own lifecycle / pidfile). Auto-spawn on
    // attach is intentionally not coupled here.
    info("Next: run `raft-computer start` (background) — closing the terminal is fine.");
  }
}

/** The single-use token on stdin: the first line, trimmed (bounded). */
async function readTokenFromStdin(input: NodeJS.ReadableStream): Promise<string> {
  let text = "";
  for await (const chunk of input) {
    text += String(chunk);
    if (text.length > 4_096 || text.includes("\n")) break;
  }
  return text.split(/\r?\n/, 1)[0]?.trim() ?? "";
}

/**
 * `raft-computer attach <slug> --server-id <id> --server-url <url>
 * --attach-token-stdin [--json]`: Raft Desktop ran the one-time approval
 * itself and hands the single-use `dvat_*` token over stdin (never argv, so
 * it is never in a process list). Attaches only; `start` is separate.
 */
export async function runAttachWithTokenFromStdin(opts: {
  serverSlug: string;
  serverId?: string;
  serverUrl?: string;
  name?: string;
  json: boolean;
  input?: NodeJS.ReadableStream;
}): Promise<void> {
  const api = createComputerApi(resolveRaftHome());
  await present(async () => {
    if (!opts.serverId || !opts.serverUrl) {
      fail("ATTACH_TOKEN_INPUT_INVALID", "--attach-token-stdin needs --server-id and --server-url. Nothing was changed.");
    }
    const attachToken = await readTokenFromStdin(opts.input ?? process.stdin);
    const result = await api.attachWithToken({
      serverSlug: opts.serverSlug,
      serverId: opts.serverId,
      serverUrl: opts.serverUrl,
      attachToken,
      ...(opts.name ? { name: opts.name } : {}),
    }, opts.json ? () => {} : presentAttachEvent);
    if (opts.json) {
      const json: ComputerCliAttachJson = {
        serverId: result.serverId,
        serverSlug: result.serverSlug,
        machineId: result.machineId ?? null,
        resumed: result.resumed,
      };
      process.stdout.write(`${JSON.stringify(json)}\n`);
    }
  });
}
