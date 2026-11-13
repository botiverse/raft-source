// The device-code prompt every approval flow prints (`login`, `attach`,
// `setup`): the approval page's address, the code to type there, and keep
// this command running. One presenter so the wording stays the same
// everywhere (#11891: "Then enter this code on the page").
import { canInstallEnterToOpenUrl, installEnterToOpenUrl, openUrlInBrowser } from "./browserHandoff";
import { info } from "./output";
import { formatServerSlugDisplay } from "./serverState";
import type { ComputerApiEvent } from "./lib/events";

export type DeviceCodePromptOptions = {
  input?: NodeJS.ReadableStream;
  openUrl?: (url: string) => void;
  /** "sign-in": a user-session login. "approval": a one-time approval that
   *  adds this machine to a server (the server picked on the page). */
  purpose: "sign-in" | "approval";
  /** The server the approval is for, when the command named one. */
  serverSlug?: string;
};

/**
 * Prints the prompt for a `login.device-code` event. Returns the cleanup for
 * the Enter-to-open listener, if one was installed.
 */
export function presentDeviceCode(
  event: Extract<ComputerApiEvent, { kind: "login.device-code" }>,
  opts: DeviceCodePromptOptions,
): (() => void) | undefined {
  const input = opts.input ?? process.stdin;
  const openUrl = opts.openUrl ?? openUrlInBrowser;
  let browserOpenRequested = false;
  try {
    openUrl(event.verifyUrl);
    browserOpenRequested = true;
  } catch {
    // Best-effort convenience only. The URL/code are still printed.
  }

  // Action-first ordering (ghostex case: user skimmed past the URL
  // to "Waiting…"). The approval URL leads; the code is the "if the
  // page asks" secondary; keep-running comes last. The URL lands on
  // the account-level /login/device page — device approval is
  // user-scoped, so we never point at a server-scoped surface (e.g. a
  // Connect Computer dialog) to approve it.
  const enterOpensBrowser = canInstallEnterToOpenUrl(input);
  info(
    opts.purpose === "approval"
      ? "To approve this machine, open this link in a browser:"
      : "To finish signing in, open this link in a browser:",
  );
  info(`  ${event.verifyUrl}`);
  if (browserOpenRequested) {
    info(
      enterOpensBrowser
        ? "  (opened automatically — if it didn't, press Enter to open it again)"
        : "  (opened automatically — open it on any device, including your phone, if it didn't)",
    );
  } else {
    info(
      enterOpensBrowser
        ? "  (press Enter to open it, or open it on any device including your phone)"
        : "  (open it on any device, including your phone)",
    );
  }
  info(`Then enter this code on the page: ${event.userCode}`);
  if (opts.purpose === "approval" && opts.serverSlug) {
    info(`If the page asks which server, choose ${formatServerSlugDisplay(opts.serverSlug)}.`);
  }
  info(
    opts.purpose === "approval"
      ? `Keep this command running — it finishes here automatically once you approve (expires in ${event.expiresInSeconds}s).`
      : `Keep this command running — sign-in completes here automatically (expires in ${event.expiresInSeconds}s).`,
  );
  return enterOpensBrowser ? installEnterToOpenUrl({ input, url: event.verifyUrl, openUrl }) : undefined;
}

/** The attach progress lines (byte-identical to the session attach's). */
export function presentAttachEvent(event: ComputerApiEvent): void {
  if (event.kind === "attach.attaching") {
    info(`Attaching this machine to server ${formatServerSlugDisplay(event.serverSlug)}…`);
  } else if (event.kind === "attach.preflight") {
    info(event.resumed ? "Resumed existing attachment; running preflight…" : "Attachment issued; running preflight…");
  } else if (event.kind === "attach.session-fallback") {
    info("This server does not support one-time approvals yet, so this machine signed in with a user session instead.");
  } else if (event.kind === "attach.attached") {
    info(`Attached. Computer state written to ${event.attachmentPath}`);
    info(`  server:        ${formatServerSlugDisplay(event.serverSlug)}`);
    info(`  serverMachine: ${event.serverMachineId}`);
  }
}
