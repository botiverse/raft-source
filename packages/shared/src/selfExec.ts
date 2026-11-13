// How to start the running Computer/daemon program again in another hidden
// mode (`__service`, `__run <serverId>`, `__detect-runtimes`, `__print-env`).
//
// The same code runs on three hosts, and `process.argv[1]` means something
// different on each:
//
// - `node-script`  — a Node binary running a JS entry (dev, the npm package,
//                    and Electron under ELECTRON_RUN_AS_NODE=1). argv[1] IS
//                    the entry script, so it has to be passed again.
// - `sea`          — a single-executable build: execPath is the program and
//                    there is no script; argv[1] is the first user argument.
// - `electron-app` — the Electron app's main process (Raft Desktop). execPath
//                    is the app launcher, which always runs the app's own main
//                    and routes hidden modes from its argv guard. argv[1] is
//                    whatever the app was launched with (often nothing, so the
//                    resident spawn passes ""), and only names the app itself
//                    when the binary is the default app (`electron <appPath>`,
//                    dev).
//
// Re-executing with argv[1] as if it were always a script entry is how the
// packaged Desktop's runtime detection child became `<app> "" __detect-runtimes`
// and booted the GUI instead of probing runtimes.
//
// Pure: callers pass the process facts, so this module touches no globals.

export type SelfExecHostShape = "node-script" | "sea" | "electron-app";

export interface SelfExecHost {
  /** Path to re-exec. SEA callers pass the live path (resolveLiveExecutablePath). */
  execPath: string;
  execArgv: readonly string[];
  /** `process.argv`; argv[1] is read only where it is the entry script or app path. */
  argv: readonly string[];
  isSea: boolean;
  /** `process.versions.electron` */
  electronVersion?: string | undefined;
  /** `process.type`: "browser" in an Electron app's main process, absent under ELECTRON_RUN_AS_NODE. */
  electronProcessType?: string | undefined;
  /** `process.defaultApp`: the Electron binary was started as `electron <appPath>`. */
  electronDefaultApp?: boolean | undefined;
}

export interface SelfExec {
  command: string;
  args: string[];
  shape: SelfExecHostShape;
}

/** The fields of `process` this module reads (Electron adds `type` / `defaultApp`). */
export interface SelfExecProcessFacts {
  execPath: string;
  execArgv: readonly string[];
  argv: readonly string[];
  versions: Readonly<Record<string, string | undefined>>;
  type?: string | undefined;
  defaultApp?: boolean | undefined;
}

export function selfExecHostFromProcess(
  proc: SelfExecProcessFacts,
  isSea: boolean,
  execPath: string = proc.execPath,
): SelfExecHost {
  return {
    execPath,
    execArgv: proc.execArgv,
    argv: proc.argv,
    isSea,
    electronVersion: proc.versions.electron,
    electronProcessType: proc.type,
    electronDefaultApp: proc.defaultApp,
  };
}

/**
 * Electron is checked first: an Electron build is never a SEA. Electron in Node
 * mode (ELECTRON_RUN_AS_NODE=1, no `process.type`) runs a script exactly like
 * Node, and its children inherit that env, so it is a `node-script` host.
 */
export function selfExecHostShape(host: SelfExecHost): SelfExecHostShape {
  if (host.electronVersion && host.electronProcessType === "browser") return "electron-app";
  if (host.isSea) return "sea";
  return "node-script";
}

/** Command and args that run this program again with `modeArgs` (e.g. `["__run", id]`). */
export function resolveSelfExec(modeArgs: readonly string[], host: SelfExecHost): SelfExec {
  const shape = selfExecHostShape(host);
  const entry = host.argv[1];
  let prefix: string[];
  if (shape === "electron-app") {
    prefix = host.electronDefaultApp && entry !== undefined ? [entry] : [];
  } else if (shape === "sea") {
    prefix = [];
  } else {
    prefix = entry !== undefined ? [entry] : [];
  }
  // execArgv is carried on every host so a dev TS loader (--import …) or an
  // inspector flag survives the re-exec; a SEA and a packaged app have none.
  return { command: host.execPath, args: [...host.execArgv, ...prefix, ...modeArgs], shape };
}
