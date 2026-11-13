import type { ExecutableInstallation, ProviderAuthFacade, Runtime } from "@botiverse/oar";
import type { OpencodeProviderAuth, OpencodeProviderAuthOptions } from "@botiverse/oar/runtimes/opencode";
import type { QwenProviderAuth, QwenProviderAuthOptions } from "@botiverse/oar/runtimes/qwen";
import type { RuntimeAccountUsageProvider } from "@botiverse/raft-shared";
import { seaDetected } from "./drivers/nodeHostLaunch";

/**
 * Loads one OAR runtime on first use, never OAR's root entry: the root loads
 * every runtime OAR supports (~49 MB of heap), while each runtime entry is
 * 1-2.4 MB and loads the ACP SDK only when it actually needs it (opening a
 * session or listing models for an ACP runtime, reading Grok's usage). The
 * daemon uses OAR for account-usage reads and the opencode and claude model listings, so
 * a machine only pays for the runtimes it reads. Import OAR's values only
 * through this module; type imports are free. The one exception is
 * `@botiverse/oar/runtimes/codex/installation-candidates` (OAR 0.101), a
 * synchronous list of Codex install locations that loads no runtime, which
 * drivers/codex.ts imports statically (oarLoader.test.ts source guard).
 */
/** The runtimes with no legacy driver, which only the OAR host runs (drivers/oarOnly.ts). */
export type OarOnlyRuntimeId = "qwen" | "qoder" | "codebuddy";

type OarRuntimeId = RuntimeAccountUsageProvider | "antigravity" | "cursor" | "opencode" | OarOnlyRuntimeId;

/**
 * The Cursor SDK (`@cursor/sdk`, OAR's optional peer, pinned by OAR to
 * 1.3.1): a daemon dependency, so npm and Electron installs of the Computer
 * ship it with its native companion (`@cursor/sdk-<platform>-<arch>`). The
 * daemon never imports it: OAR runs it in a Node child per session
 * (`execution: "subprocess"`), which imports it from the file URL resolved
 * here. tsdown keeps it external, and the Computer's single-file (SEA) build
 * has no node_modules, so a SEA never advertises Cursor on OAR
 * (daemon/src/agentHost/README.md, "cursor").
 */
const CURSOR_SDK_PACKAGE = "@cursor/sdk";

/** The Cursor SDK's entry as a file URL, for OAR's child to import; throws when it is not installed. */
export function cursorSdkModule(): string {
  return import.meta.resolve(CURSOR_SDK_PACKAGE);
}

/** The oldest Node the Cursor SDK supports (`@cursor/sdk` 1.3.1 `engines.node`); its child runs on the daemon's own Node. */
const CURSOR_SDK_MIN_NODE: readonly [number, number] = [22, 13];

/**
 * Whether this daemon can run Cursor through the SDK
 * (#oar-raft:#10, `runtime-host:oar:cursor`): Linux only, never the
 * single-file (SEA) build (OAR cannot start its child there), on a Node the
 * SDK supports, and only where `@cursor/sdk` resolves. Resolving loads
 * nothing. Synchronous, for the `ready` frame.
 */
export function cursorSdkAvailable(input: {
  platform?: NodeJS.Platform;
  sea?: boolean | undefined;
  nodeVersion?: string;
  resolve?: (specifier: string) => string;
} = {}): boolean {
  if ((input.platform ?? process.platform) !== "linux") return false;
  // `undefined`: the SEA probe could not answer; never assume it is not one.
  if (("sea" in input ? input.sea : seaDetected()) !== false) return false;
  const [major = 0, minor = 0] = (input.nodeVersion ?? process.versions.node).split(".").map(Number);
  if (major < CURSOR_SDK_MIN_NODE[0] || (major === CURSOR_SDK_MIN_NODE[0] && minor < CURSOR_SDK_MIN_NODE[1])) return false;
  const resolve = input.resolve ?? ((specifier: string) => import.meta.resolve(specifier));
  try {
    return Boolean(resolve(CURSOR_SDK_PACKAGE));
  } catch {
    return false;
  }
}

const LOADERS = {
  antigravity: async () => (await import("@botiverse/oar/runtimes/antigravity")).antigravityRuntime,
  claude: async () => (await import("@botiverse/oar/runtimes/claude")).claudeRuntime,
  codex: async () => (await import("@botiverse/oar/runtimes/codex")).codexRuntime,
  // OAR 0.101: the SDK in a Node child per session (and per sign-in or model
  // call), started from an empty environment: the child gets only what a
  // session's `env` gives it (oarCursorLaunch.ts `cursorChildEnv`) plus OAR's
  // native-companion variables. Never in the daemon's process.
  cursor: async () => (await import("@botiverse/oar/runtimes/cursor")).createCursorRuntime({ execution: "subprocess", sdkModule: cursorSdkModule(), envBase: "clean" }),
  kimi: async () => (await import("@botiverse/oar/runtimes/kimi")).kimiRuntime,
  grok: async () => (await import("@botiverse/oar/runtimes/grok")).grokRuntime,
  opencode: async () => (await import("@botiverse/oar/runtimes/opencode")).opencodeRuntime,
  qwen: async () => (await import("@botiverse/oar/runtimes/qwen")).qwenRuntime,
  qoder: async () => (await import("@botiverse/oar/runtimes/qoder")).qoderRuntime,
  codebuddy: async () => (await import("@botiverse/oar/runtimes/codebuddy")).codebuddyRuntime,
} as const satisfies Record<OarRuntimeId, () => Promise<Runtime>>;

const loading = new Map<OarRuntimeId, Promise<Runtime>>();

export function loadOarRuntime(id: OarRuntimeId): Promise<Runtime> {
  let runtime = loading.get(id);
  if (!runtime) {
    runtime = LOADERS[id]();
    // A failed load is retried on the next call rather than cached.
    runtime.catch(() => { if (loading.get(id) === runtime) loading.delete(id); });
    loading.set(id, runtime);
  }
  return runtime;
}

/**
 * One native process per session, whatever OAR's `auto` would pick: a shared
 * process runs tools and plugins under its own HOME and environment, not the
 * agent's. In-process runtimes reject an explicit placement, so only
 * process-backed ones are pinned.
 */
export function pinIsolated(runtime: Runtime): Runtime {
  return runtime.execution === "process" ? runtime.withPlacement("isolated") : runtime;
}

const sessionRuntimes = new Map<OarRuntimeId, Promise<Runtime>>();

/** The runtime to open agent sessions on: `loadOarRuntime` pinned to one process per session. */
export function loadOarSessionRuntime(id: OarRuntimeId): Promise<Runtime> {
  let runtime = sessionRuntimes.get(id);
  if (!runtime) {
    runtime = loadOarRuntime(id).then(pinIsolated);
    runtime.catch(() => { if (sessionRuntimes.get(id) === runtime) sessionRuntimes.delete(id); });
    sessionRuntimes.set(id, runtime);
  }
  return runtime;
}

/**
 * A runtime's provider settings facade (Qwen Code's `createQwenProviderAuth`:
 * list the providers, save one's API key). Each operation starts the
 * runtime's own process; creating the facade starts nothing.
 */
export interface OarProviderAuth {
  create(installation: ExecutableInstallation, options: QwenProviderAuthOptions): Promise<QwenProviderAuth>;
}

let qwenProviderAuthLoading: Promise<OarProviderAuth> | null = null;

/** Qwen Code's provider facade, from its runtime entry (never OAR's root), on first use. */
export function loadOarQwenProviderAuth(): Promise<OarProviderAuth> {
  if (!qwenProviderAuthLoading) {
    const loading = import("@botiverse/oar/runtimes/qwen").then(({ createQwenProviderAuth }) => ({ create: createQwenProviderAuth }));
    loading.catch(() => { if (qwenProviderAuthLoading === loading) qwenProviderAuthLoading = null; });
    qwenProviderAuthLoading = loading;
  }
  return qwenProviderAuthLoading;
}

/**
 * Pi's provider sign-ins (OAR's `createPiProviderAuth`, from the Pi runtime
 * entry, never OAR's root): a fresh facade per call, on the `auth.json` and
 * `models.json` given, so each read sees the file as it is now. In-process,
 * on every platform; it starts no process. The pi SDK it runs on is the one
 * the Pi driver already loads.
 */
export async function loadOarPiProviderAuth(paths: { authPath: string; modelsPath: string }): Promise<ProviderAuthFacade> {
  const { createPiProviderAuth } = await import("@botiverse/oar/runtimes/pi");
  return createPiProviderAuth(paths);
}

/**
 * OpenCode 2's provider sign-ins (OAR 0.100 `createOpencodeProviderAuth`,
 * from the OpenCode runtime entry, never OAR's root) on the installation
 * given. Creating it starts `opencode serve` once to read OpenCode's
 * registry; OpenCode 1 is refused (`version_unsupported`).
 */
export async function loadOarOpencodeProviderAuth(installation: ExecutableInstallation, options: OpencodeProviderAuthOptions): Promise<OpencodeProviderAuth> {
  const { createOpencodeProviderAuth } = await import("@botiverse/oar/runtimes/opencode");
  return createOpencodeProviderAuth(installation, options);
}

export type OarObserve = typeof import("@botiverse/oar/observe");
let observeLoading: Promise<OarObserve> | null = null;

/**
 * OAR's browser-safe observe entry (`observeStalls`, folds), on first use:
 * no runtime and no SDK, for the OAR agent host (agentHost/oarAgentHost.ts).
 */
export function loadOarObserve(): Promise<OarObserve> {
  if (!observeLoading) {
    const loading = import("@botiverse/oar/observe");
    loading.catch(() => { if (observeLoading === loading) observeLoading = null; });
    observeLoading = loading;
  }
  return observeLoading;
}

/**
 * The OAR host's modules as a launch reaches them, for every runtime the host
 * runs (antigravity, codex, grok, and the OAR-only qwen, qoder and codebuddy): the runtime entry, the observe
 * entry, and the session path (opened on an executable that does not exist,
 * so it fails at the spawn, after every module it needs was loaded),
 * Grok's and CodeBuddy's sign-in modules (loaded apart from their sessions), and
 * OpenCode's provider sign-in facade (OAR 0.100, loaded on creation). The
 * Computer's release smoke (`__verify-bundled-oar`) runs this on the
 * single-file binary, so a module missing from the bundle fails the build
 * rather than a user's first OAR-hosted agent.
 */
export async function verifyBundledOarHost(): Promise<void> {
  const observe = await loadOarObserve();
  for (const name of ["observeStalls", "classifyTool"] as const) {
    if (typeof observe[name] !== "function") throw new Error(`bundled OAR observe entry has no ${name}`);
  }
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  for (const id of ["antigravity", "codex", "grok", "qwen", "qoder", "codebuddy"] as const) {
    const runtime = await loadOarSessionRuntime(id);
    if (runtime.id !== id) throw new Error(`bundled OAR ${id} runtime reports id ${runtime.id}`);
    const missing = join(tmpdir(), `raft-oar-verify-${process.pid}-no-such-${id}`);
    try {
      const session = await runtime.session({ kind: "available", via: "executable", command: missing }, { cwd: tmpdir() });
      await session.dispose();
      throw new Error(`an OAR ${id} session opened on an executable that does not exist`);
    } catch (error) {
      if (!isMissingExecutableFailure(error)) throw error;
    }
  }
  // Qwen's provider facade (web provider connect) loads its process module on
  // creation; creating one starts no process.
  const qwenProviderAuth = await (await loadOarQwenProviderAuth()).create({ kind: "available", via: "executable", command: join(tmpdir(), `raft-oar-verify-${process.pid}-no-such-qwen`) }, { cwd: tmpdir() });
  if (typeof qwenProviderAuth.connect !== "function") throw new Error("bundled OAR qwen provider facade has no connect");
  // Grok's status, login and logout (web sign-in) load their own module on
  // first use: a status read on an executable that does not exist loads it
  // and answers unknown without starting anything.
  const grok = await loadOarRuntime("grok");
  if (!grok.authStatus || !grok.login || !grok.logout) throw new Error("bundled OAR grok runtime has no sign-in");
  const grokStatus = await grok.authStatus({ kind: "available", via: "executable", command: join(tmpdir(), `raft-oar-verify-${process.pid}-no-such-grok-auth`) }, { timeoutMs: 5_000 });
  if (grokStatus.kind !== "unknown") throw new Error(`bundled OAR grok status read ${grokStatus.kind} for an executable that does not exist`);
  // CodeBuddy's status, login and logout (web sign-in) likewise: its account
  // query on an executable that does not exist answers unknown.
  const codebuddy = await loadOarRuntime("codebuddy");
  if (!codebuddy.authStatus || !codebuddy.login || !codebuddy.logout) throw new Error("bundled OAR codebuddy runtime has no sign-in");
  const codebuddyStatus = await codebuddy.authStatus({ kind: "available", via: "executable", command: join(tmpdir(), `raft-oar-verify-${process.pid}-no-such-codebuddy-auth`) }, { timeoutMs: 5_000 });
  if (codebuddyStatus.kind !== "unknown") throw new Error(`bundled OAR codebuddy status read ${codebuddyStatus.kind} for an executable that does not exist`);
  // OpenCode's provider sign-in loads its facade and server modules on
  // creation. Given a version (no `--version` run), creating one on an
  // executable that does not exist loads them and fails at the spawn of
  // `opencode serve`, with OAR's own error.
  try {
    const opencodeAuth = await loadOarOpencodeProviderAuth(
      { kind: "available", via: "executable", command: join(tmpdir(), `raft-oar-verify-${process.pid}-no-such-opencode`), version: "opencode v2.0.0" },
      { timeoutMs: 5_000, idleMs: 0, loopback: "refuse" },
    );
    await opencodeAuth.close();
    throw new Error("an OAR opencode provider sign-in started on an executable that does not exist");
  } catch (error) {
    if ((error as { name?: unknown } | null)?.name !== "OpencodeProviderAuthError") throw error;
  }
}

/**
 * Only a failure at the process proves the session path ran up to it: the
 * spawn's own ENOENT, bare or as the cause of OAR's process failure. On Windows OAR launches runtimes through a shim, so a
 * missing executable surfaces as the launched process ending instead (grok:
 * AcpError `process_exited`, release run 40445551777). The OAR host runs no
 * sessions on Windows (oarAgentHost.ts `platform_unsupported`), so there the
 * smoke only has to prove the bundle: any failure but a missing module.
 */
export function isMissingExecutableFailure(error: unknown, platform: NodeJS.Platform = process.platform): boolean {
  const failure = error as { code?: unknown; message?: unknown; cause?: { error?: { code?: unknown } } } | null;
  if (failure?.code === "ENOENT") return true;
  // From OAR 0.76.2 Qoder reads `--version` first; a failed spawn there is
  // OAR's process failure, the native error kept in `cause.error`.
  if (failure?.cause?.error?.code === "ENOENT") return true;
  if (platform !== "win32") return false;
  const moduleMissing = failure?.code === "ERR_MODULE_NOT_FOUND" || failure?.code === "MODULE_NOT_FOUND"
    || (typeof failure?.message === "string" && /Cannot find (module|package)/u.test(failure.message));
  return !moduleMissing;
}
