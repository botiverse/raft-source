// "On this computer" checks: read-only code shipped with the Computer that
// answers "is X installed, which version, who is signed in locally". The
// server can only switch a check on or off and ask for a refresh; it never
// sends commands, arguments, paths or scripts. Design: Tenny-approved
// cfdc8e41 (#proj-raft-computer).
//
// The checks, their rows and the report are the wire contract
// (packages/shared/src/computerChecks.ts); re-exported here for the checks.
import type { CheckItem, ComputerCheckId } from "@botiverse/raft-shared";

export {
  COMPUTER_CHECK_IDS,
  isComputerCheckId,
  type CheckItem,
  type CheckItemStatus,
  type CheckUnconfirmedReason,
  type ComputerCheckId,
  type ComputerCheckPluginReport,
  type ComputerChecksEnabled,
  type ComputerChecksReport,
  type OwnerSwitchDisabled,
  type OwnerSwitchReport,
} from "@botiverse/raft-shared";

/** Turns a raw value into the only form allowed out, or drops it. */
export type ValueShape = (raw: string) => string | undefined;

export interface DeclaredKey {
  /** The key as written in the file; `suffix` matches keys ending with it. */
  key: string;
  match?: "exact" | "suffix";
  shape: ValueShape;
}

/**
 * A file a check may read, relative to HOME. `{param}` in the path is filled
 * from `readKeys`'s param, which must pass `paramShape`. `line` reads the
 * first non-empty line as key `value`; `ini` and `yaml` read top-level keys
 * into section `""` and each `[section]` / top-level mapping into its own,
 * whose name must pass `sectionShape` or the whole section is dropped.
 */
export interface DeclaredFile {
  path: string;
  format: "line" | "ini" | "yaml";
  keys: readonly DeclaredKey[];
  sectionShape?: ValueShape;
  paramShape?: ValueShape;
}

export interface ReadSection {
  /** `""` for keys outside any section; else the shaped section name. */
  name: string;
  /** Declared keys only, each already through its shape. */
  values: Partial<Record<string, string>>;
}

export type ReadKeysResult =
  | { sections: ReadSection[] }
  | { unavailable: "missing" | "unreadable" | "parse_failed" };

export type ExecResult =
  | { stdout: string; exitCode: number }
  | { unavailable: "not_installed" | "timeout" | "failed" | "unsupported" };

export interface CheckContext {
  /** The only way to run a command: argv must exactly equal one the check declared. */
  exec(argv: readonly string[]): Promise<ExecResult>;
  /** The only way to read a file: one the check declared, declared keys only. */
  readKeys(file: DeclaredFile, param?: string): Promise<ReadKeysResult>;
  signal: AbortSignal;
}

export interface ComputerCheck {
  id: ComputerCheckId;
  /** Every argv this check may run, complete and fixed. */
  commands: readonly (readonly string[])[];
  files: readonly DeclaredFile[];
  run(ctx: CheckContext): Promise<CheckItem[]>;
}
