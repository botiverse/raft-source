import { createRequire } from "node:module";

/**
 * The three shapes `process.execPath` actually takes across our shipped
 * channels. Established by reading the installers and build config, not by
 * inference:
 *
 * - `node`     — a real Node binary. Dev, and any host that runs the daemon
 *                from a JS entry.
 * - `electron` — the Electron executable. `packages/daemon` embedded in the
 *                Electron app; `electron-builder.yml` publishes dmg (macOS)
 *                and an unpublished nsis target (Windows).
 * - `sea`      — a single-file executable where `process.execPath` IS the
 *                bundled app and there is no JS script entry
 *                (`packages/computer/src/service.ts` `isSeaBinary`). This is
 *                what the OFFICIAL installers ship on every platform:
 *                `install.ps1` places `raft-computer.exe`, `install.sh`
 *                downloads "the prebuilt single-file (SEA) binary".
 *
 * The distinction that matters: `electron` can be told to behave like Node
 * (`ELECTRON_RUN_AS_NODE=1`); `sea` cannot. There is no Node mode to enable
 * inside a SEA, so running a JS entry needs a Node host found elsewhere.
 * Treating `sea` as `node` — which is what testing only `versions.electron`
 * does — hands a JS file to an executable that cannot run it.
 *
 * `unknown` exists because this list is what we have ENUMERATED, not what is
 * provably exhaustive. A host that is none of the three must not silently
 * inherit `node`'s behaviour.
 *
 * ASSUMPTION, not verified: an Electron build is never also a SEA, so
 * Electron is checked first. It is stated here rather than left implicit
 * because this whole defect grew out of an unstated assumption about what
 * Windows hosts are.
 */
export type NodeHostKind = "node" | "electron" | "sea" | "unknown";

export interface NodeHostKindOptions {
  execIsElectron?: boolean;
  /** `undefined` means the SEA probe could not answer, not that it answered no. */
  execIsSea?: boolean | undefined;
  hasNodeRuntime?: boolean;
  /**
   * The SEA probe itself. This seam exists because `execIsSea` cannot express
   * "the probe could not answer": `options.execIsSea ?? probe()` treats an
   * explicit `undefined` exactly like an omitted field, so that state is
   * unreachable from outside. Without this, the branch that stops a failed
   * probe from being read as `node` is untestable — and an untestable guard
   * is indistinguishable from an absent one.
   */
  seaProbe?: () => boolean | undefined;
}

export interface NodeHostLaunchOptions extends NodeHostKindOptions {
  env?: NodeJS.ProcessEnv;
  execPath?: string;
}

const seaRequire = createRequire(import.meta.url);

/**
 * Ask the runtime whether it is a SEA.
 *
 * Returns `undefined` for "could not ask", which is NOT the same as `false`.
 * A bare `require` here would have collapsed the two: this package is
 * `"type": "module"` / `"module": "ESNext"`, so on a pure-ESM path `require`
 * is not defined, the ReferenceError would be swallowed, and the probe would
 * answer "not a SEA" — degrading silently into the exact defect this file
 * exists to fix, with the evidence eaten by the catch.
 *
 * `createRequire` is how `packages/computer/src/service.ts` already does this.
 */
export function seaDetected(
  requireModule: (specifier: string) => unknown = seaRequire,
): boolean | undefined {
  let sea: { isSea(): boolean };
  try {
    sea = requireModule("node:sea") as { isSea(): boolean };
  } catch (error) {
    // A runtime with no `node:sea` at all cannot be a SEA — that is real
    // evidence. Anything else means the probe failed, not that the answer is
    // no, and must not be reported as one.
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "MODULE_NOT_FOUND" || code === "ERR_UNKNOWN_BUILTIN_MODULE") return false;
    return undefined;
  }
  try {
    return sea.isSea();
  } catch {
    return undefined;
  }
}

/**
 * Classify the current host. Electron is checked first because an Electron
 * build is never a SEA, and because `versions.electron` is the cheaper and
 * more certain signal of the two.
 */
export function detectNodeHostKind(options: NodeHostKindOptions = {}): NodeHostKind {
  const execIsElectron = options.execIsElectron ?? Boolean(process.versions.electron);
  if (execIsElectron) return "electron";

  const execIsSea = options.execIsSea ?? (options.seaProbe ?? seaDetected)();
  if (execIsSea) return "sea";
  // The probe could not answer. "I could not ask" is not evidence of "not a
  // SEA", so it must not fall through to the node branch.
  if (execIsSea === undefined) return "unknown";

  // `node` is a POSITIVE determination, never the residue of two failed
  // checks. The shipped defect was exactly a residue — "not Electron,
  // therefore node" — and a three-way version of the same shape would put
  // any host we have not enumerated back onto the branch that assumes a JS
  // entry can be executed directly. An unrecognised host says so.
  const hasNodeRuntime = options.hasNodeRuntime ?? Boolean(process.versions.node);
  return hasNodeRuntime ? "node" : "unknown";
}

export interface NodeHostLaunch {
  command: string;
  env: NodeJS.ProcessEnv;
}

/**
 * Raised when the current host cannot run a JavaScript entry and no Node host
 * has been resolved for it.
 *
 * Before this existed, a SEA host silently returned `process.execPath` — the
 * bundled application — as the command for a `.js` file. The spawn then failed
 * somewhere downstream with whatever the OS said about handing a script to an
 * executable that does not take one, which is why the original report read as
 * an inscrutable startup failure rather than a missing capability. Failing
 * here names the actual condition.
 */
export class NodeHostUnavailableError extends Error {
  readonly kind = "node_host_unavailable" as const;
  readonly hostKind: NodeHostKind;

  constructor(hostKind: NodeHostKind) {
    super(
      hostKind === "sea"
        ? "This Computer is a single-file build, which has no Node mode and cannot execute a JavaScript CLI entry directly. A separate Node host is required."
        : `Cannot determine how to run a JavaScript CLI entry on this host (host_kind=${hostKind}).`,
    );
    this.name = "NodeHostUnavailableError";
    this.hostKind = hostKind;
  }
}

/**
 * Run a JavaScript CLI entry through the daemon's current Node-capable host.
 *
 * Packaged Computer embeds the daemon in Electron, so process.execPath points
 * at the Electron executable rather than a standalone node binary. Electron's
 * supported Node mode is selected with ELECTRON_RUN_AS_NODE=1. A plain Node
 * host keeps both the executable and environment object unchanged.
 */
export function resolveNodeHostLaunch(options: NodeHostLaunchOptions = {}): NodeHostLaunch {
  const env = options.env ?? process.env;
  const command = options.execPath ?? process.execPath;
  const hostKind = detectNodeHostKind(options);

  // Electron can be told to behave as Node.
  if (hostKind === "electron") {
    return { command, env: { ...env, ELECTRON_RUN_AS_NODE: "1" } };
  }

  // A real Node host runs the entry as-is.
  if (hostKind === "node") return { command, env };

  // `sea` cannot be switched into a Node mode, and `unknown` is by definition
  // a host whose capabilities we have not established. Neither may fall back
  // to returning execPath — that is what shipped, and it is how an absent
  // capability came to look like a broken launch.
  throw new NodeHostUnavailableError(hostKind);
}
