// Kimi Code's web sign-in on the Kimi Code SDK the daemon bundles
// (`@botiverse/kimi-code-sdk`, the one its agents run on), not on OAR's `kimi`
// runtime: that one drives a separately installed Kimi Code CLI (`kimi
// login`, 2.3.3 or later), so a Computer without the CLI could not sign in
// although its agents need none.
//
// The SDK's `KimiAuthFacade` (2.3.1-botiverse.1), as read from its source:
// - Built as the SDK's own harness builds it: `homeDir`, `configPath` from the
//   SDK's exported `resolveConfigPath({homeDir})` (`<home>/config.toml`), and
//   the host identity.
// - With no provider name, status, login and logout all act on the SDK's
//   default `managed:kimi-code` (not exported by the SDK, so none is passed).
// - `status()` lists that provider with `hasToken`: the token stored in the
//   slot its config points to (`credentials/kimi-code.json` for mainland-cn,
//   `credentials/kimi-code-env-<16 hex>.json` for any other OAuth/API host
//   pair, global included) loads and its `access_token` is not empty (an
//   emptied one is the SDK's revoked tombstone). No account. The daemon does
//   not call it: status is read from those files here, without loading the
//   SDK (`readKimiCodeSignInStatus`).
// - `login()` runs the RFC 8628 device flow when no usable token is stored
//   (calling `onDeviceCode` again with a fresh code if one expires), stores
//   the token, then provisions the managed provider and default model into
//   `config.toml`. `region` picks the service, unless `KIMI_CODE_OAUTH_HOST`
//   or `KIMI_CODE_BASE_URL` is set in the daemon process's `process.env`
//   (the SDK reads them there itself). It throws on any failure:
//   `OAuthAccessDeniedError` (denied on the consent page),
//   `DeviceCodeTimeoutError` (its own 15 min bound), `OAuthConnectionError`,
//   `OAuthUnauthorizedError`, and `OAuthError("Login aborted by caller")`
//   once `signal` is aborted, checked only between polls (so up to a poll
//   interval later), and its device-code and poll requests take no signal: a
//   cancel here answers at once, drops that late rejection, and reports when
//   the SDK's login has really ended (`sdkSettled`), so no second one starts
//   writing the same token and config before then.
// - `logout()` removes the stored token and the managed provider from
//   `config.toml`; it throws on failure.
//
// - `getManagedUsage()` reads the managed provider's quota with the stored
//   token (refreshing it as agents do); used for the usage card on a Computer
//   without the Kimi Code CLI (`runtimeAccountUsage/kimiSdkUsage.ts`).
//
// The SDK is loaded for a login, a logout or a usage read only (`loadKimiSdk`;
// the usage read only when signed in), never at daemon startup or for a status
// report (~70 MB of heap per runner; a runner with a Kimi Code agent has it
// loaded already).

import type { KimiAuthFacade } from "@botiverse/kimi-code-sdk";
import type {
  RuntimeAuthLoginEvent,
  RuntimeAuthLoginRegion,
  RuntimeAuthLoginResult,
  RuntimeAuthLogoutResult,
  RuntimeAuthStatus,
} from "@botiverse/raft-shared";

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

/** The part of the SDK's `KimiAuthFacade` the web sign-in uses; tests pass a fake. */
export type KimiSdkAuth = Pick<KimiAuthFacade, "status" | "login" | "logout" | "getManagedUsage">;

/** The SDK's device authorization as `onDeviceCode` gets it (not exported by the SDK). */
type KimiDeviceAuthorization = Parameters<NonNullable<NonNullable<Parameters<KimiAuthFacade["login"]>[1]>["onDeviceCode"]>>[0];

/**
 * The SDK's facade for Kimi Code's sign-in in `homeDir` (the home its agents
 * read: the caller resolves it as the kimi-sdk driver and the credential
 * watch do), with the identity agents present. Loads the SDK: for a login or
 * a logout only.
 */
export async function loadKimiSdkAuth(homeDir: string): Promise<KimiSdkAuth> {
  const { kimiCodeHostIdentity, loadKimiSdk } = await import("../drivers/index");
  const sdk = await loadKimiSdk();
  return new sdk.KimiAuthFacade({ homeDir, configPath: sdk.resolveConfigPath({ homeDir }), identity: kimiCodeHostIdentity() });
}

/** The SDK's token slots: `kimi-code` (mainland-cn) and `kimi-code-env-<digest>` (any other host pair). */
const KIMI_TOKEN_FILE = /^kimi-code(?:-env-[0-9a-f]{16})?\.json$/u;

/**
 * Whether Kimi Code is signed in, from its stored tokens and without the SDK:
 * `logged_in` when any of its token slots holds a token the SDK would count
 * (`hasToken`, see `kimiTokenSlot`). The SDK asks only the slot its config
 * points to; a token left in another region's slot reads signed in here (the
 * next login or logout corrects it). `unknown` when a slot could not be read
 * and none counts.
 */
export async function readKimiCodeSignInStatus(homeDir: string): Promise<RuntimeAuthStatus> {
  const dir = path.join(homeDir, "credentials");
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return { kind: "logged_out" };
    return { kind: "unknown" };
  }
  let unreadable = false;
  for (const name of names.filter((entry) => KIMI_TOKEN_FILE.test(entry))) {
    const slot = await kimiTokenSlot(path.join(dir, name));
    if (slot === "token") return { kind: "logged_in" };
    if (slot === "unreadable") unreadable = true;
  }
  return unreadable ? { kind: "unknown" } : { kind: "logged_out" };
}

/**
 * One token slot as the SDK's `FileTokenStorage.load` and `classifyToken`
 * see it: a file that is missing, not JSON or not an object holds no token;
 * one whose `access_token` is empty or absent is revoked (the tombstone the
 * SDK writes when a refresh is rejected); anything else is a token, whether
 * or not it has expired (the SDK refreshes it). A file that exists but
 * cannot be read is `unreadable`, which the SDK would also read as none, but
 * here it is no claim either way.
 */
async function kimiTokenSlot(file: string): Promise<"token" | "none" | "unreadable"> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException | null)?.code === "ENOENT" ? "none" : "unreadable";
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "none";
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return "none";
  const accessToken = (parsed as Record<string, unknown>).access_token;
  return typeof accessToken === "string" && accessToken.length > 0 ? "token" : "none";
}

export interface KimiSdkLoginInteraction {
  region: RuntimeAuthLoginRegion | undefined;
  signal: AbortSignal;
  /** Shows the event on the web; false when it could not be shown. */
  relay(event: RuntimeAuthLoginEvent): boolean;
}

/** A login's result, and for a failure the SDK error's kind for the trace (a class name, never its message). */
export interface KimiSdkLoginOutcome {
  result: RuntimeAuthLoginResult;
  errorKind?: string;
  /**
   * Settles when the SDK's own login has ended, which after a cancel can be
   * a poll interval after `result`; absent when it never started.
   */
  sdkSettled?: Promise<void>;
}

const NOT_SHOWN = new Error("the Kimi device code could not be shown on the web");

export async function kimiSdkAuthLogin(auth: KimiSdkAuth, interaction: KimiSdkLoginInteraction): Promise<KimiSdkLoginOutcome> {
  const { signal } = interaction;
  if (signal.aborted) return { result: { kind: "cancelled" } };
  const login = auth.login(undefined, {
    signal,
    ...(interaction.region ? { region: interaction.region } : {}),
    onDeviceCode: (device) => {
      // A login already answered cancelled shows nothing more; the SDK stops at its next check.
      if (signal.aborted) return;
      // A code the web cannot show would leave the person waiting for
      // nothing: throwing ends the SDK's login before it polls.
      if (!interaction.relay(webDeviceCode(device))) throw NOT_SHOWN;
    },
  });
  const cancelled = new Promise<"cancelled">((resolve) => signal.addEventListener("abort", () => resolve("cancelled"), { once: true }));
  // After a cancel the SDK still rejects (at its next poll): its outcome is dropped.
  const sdkSettled = login.then(() => undefined, () => undefined);
  try {
    const outcome = await Promise.race([login, cancelled]);
    return { result: outcome === "cancelled" ? { kind: "cancelled" } : { kind: "logged_in" }, sdkSettled };
  } catch (error) {
    if (signal.aborted) return { result: { kind: "cancelled" }, sdkSettled };
    return { ...kimiSdkLoginFailure(error), sdkSettled };
  }
}

/** Why the SDK's login failed, from its error class only: its message is never relayed. */
function kimiSdkLoginFailure(error: unknown): KimiSdkLoginOutcome {
  if (error === NOT_SHOWN) {
    return { result: { kind: "failed", reason: "interaction_failed", detail: "Could not present the Kimi device code" }, errorKind: "not_shown" };
  }
  const name = error instanceof Error ? error.name : undefined;
  switch (name) {
    case "OAuthAccessDeniedError":
      return { result: { kind: "failed", reason: "rejected", detail: "Kimi reported that the sign-in was denied" }, errorKind: name };
    case "OAuthUnauthorizedError":
      return { result: { kind: "failed", reason: "rejected", detail: "Kimi did not accept the sign-in" }, errorKind: name };
    case "DeviceCodeTimeoutError":
      return { result: { kind: "failed", reason: "timed_out", detail: "The Kimi device code was not approved in time" }, errorKind: name };
    case "OAuthConnectionError":
      return { result: { kind: "failed", reason: "process_failed", detail: "Kimi's sign-in service could not be reached" }, errorKind: name };
    default:
      return { result: { kind: "failed", reason: "process_failed", detail: "Kimi sign-in did not complete" }, errorKind: "other" };
  }
}

export async function kimiSdkAuthLogout(auth: KimiSdkAuth): Promise<RuntimeAuthLogoutResult> {
  try {
    await auth.logout();
    return { kind: "logged_out" };
  } catch {
    return { kind: "failed", reason: "process_failed", detail: "Kimi sign-out did not complete" };
  }
}

/**
 * The device code as the web shows it, the shape OAR's `kimi` login relayed:
 * the link Kimi's own CLI opens (the one with the code in it, when it is
 * https) and the code to check against it.
 */
function webDeviceCode(device: KimiDeviceAuthorization): RuntimeAuthLoginEvent {
  const verificationUri = isHttps(device.verificationUriComplete) ? device.verificationUriComplete : device.verificationUri;
  const expiresIn = device.expiresIn;
  return {
    kind: "device_code",
    userCode: device.userCode,
    verificationUri,
    ...(typeof expiresIn === "number" && expiresIn >= 1 ? { expiresInSeconds: Math.min(3600, Math.round(expiresIn)) } : {}),
  };
}

function isHttps(value: string | undefined): value is string {
  if (!value) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}
