import { HOST_PROVIDER_LABELS, isHostProvider, isMachineDiskLow } from "@botiverse/raft-shared";
import type { RuntimeAccountUsageProvider } from "@botiverse/raft-shared";
import type { Machine } from "../../store/machineStore";
import type { ComputersRackFilters, ComputersRackGroupBy, ComputersRackRuntimeFilter } from "../../store/computersRackFilterPreference";
import { getComputerAttentionStatus, serverNeedsAttention } from "../../utils/computerUpgradeIndicator";
import { usageProviderForRuntime } from "../../utils/runtimeUsageProvider";
import type { RackRuntimeColumns } from "../../components/machine/rack/rackRuntimeColumns";

/**
 * The Computers overview's filters and groups (Raft DS › Raft Chat ›
 * Computers), pure, so the toolbar and the list read the same answer.
 */

/** A usage provider's name as the filter and the sort say it: the product, not one of its runtimes. */
export const RACK_PROVIDER_NAMES: Record<RuntimeAccountUsageProvider, string> = {
  claude: "Claude Code",
  codex: "Codex",
  kimi: "Kimi",
  grok: "Grok",
  antigravity: "Antigravity",
};

/** The Runtime filter's items: the usage providers these computers have, then Other when any runtime has none. */
export function runtimeFilterOptions(columns: RackRuntimeColumns): ComputersRackRuntimeFilter[] {
  const options: ComputersRackRuntimeFilter[] = columns.usage.map((column) => column.provider);
  if (columns.other.length > 0) options.push("other");
  return options;
}

/**
 * The runtimes the filter applies: those chosen that the computers still
 * have. One chosen earlier whose computers have gone filters nothing (and
 * isn't in the list to take off), in the list, the trigger and Clear all alike.
 */
export function effectiveRuntimeFilter(
  chosen: readonly ComputersRackRuntimeFilter[],
  options: readonly ComputersRackRuntimeFilter[],
): readonly ComputersRackRuntimeFilter[] {
  const kept = chosen.filter((runtime) => options.includes(runtime));
  return kept.length === chosen.length ? chosen : kept;
}

/**
 * Something to act on. The server's summary when it sent one (#68: a block
 * holding an agent here, offline, an update available or required; never a
 * wait that clears by itself); otherwise an upgrade waiting, low disk, or offline.
 */
export function rackNeedsAttention(machine: Machine): boolean {
  const server = serverNeedsAttention(machine);
  if (server !== undefined) return server;
  if (getComputerAttentionStatus(machine) !== "none") return true;
  if (machine.status !== "online") return machine.isComputer === true;
  return Boolean(machine.diskStatus && isMachineDiskLow(machine.diskStatus));
}

function machineRuntimeFilters(machine: Machine): Set<ComputersRackRuntimeFilter> {
  const out = new Set<ComputersRackRuntimeFilter>();
  for (const runtimeId of machine.runtimes) out.add(usageProviderForRuntime(runtimeId) ?? "other");
  return out;
}

function ownerName(machine: Machine): string | null {
  const owner = machine.ownerUserId ? machine.owner ?? null : null;
  return owner ? owner.displayName || owner.name : null;
}

/** Which of a computer's searched fields hold the search text. */
export interface RackSearchMatch {
  name: boolean;
  hostname: boolean;
  owner: boolean;
}

/**
 * The search's own rule, per field: the text, trimmed and without case, is
 * part of the computer's name, its host name, or its owner's name (display
 * name or handle). Null when the search holds nothing.
 */
export function rackSearchMatch(machine: Machine, search: string): RackSearchMatch | null {
  const query = search.trim().toLocaleLowerCase();
  if (!query) return null;
  const holds = (part: string | null | undefined) => (part ? part.toLocaleLowerCase().includes(query) : false);
  return {
    name: holds(machine.name),
    hostname: holds(machine.hostname),
    owner: holds(ownerName(machine)) || holds(machine.owner?.name),
  };
}

export function filterRackMachines(
  machines: readonly Machine[],
  filters: Pick<ComputersRackFilters, "query" | "status" | "runtimes">,
): readonly Machine[] {
  const query = filters.query.trim().toLocaleLowerCase();
  const noFilter = !query && filters.status === "all" && filters.runtimes.length === 0;
  if (noFilter) return machines;
  return machines.filter((machine) => {
    if (query) {
      const match = rackSearchMatch(machine, query);
      if (!(match?.name || match?.hostname || match?.owner)) return false;
    }
    if (filters.status === "online" && machine.status !== "online") return false;
    if (filters.status === "offline" && machine.status === "online") return false;
    if (filters.status === "attention" && !rackNeedsAttention(machine)) return false;
    if (filters.runtimes.length > 0) {
      const own = machineRuntimeFilters(machine);
      if (!filters.runtimes.some((runtime) => own.has(runtime))) return false;
    }
    return true;
  });
}

/** One word prefix of a name: `key` compares (lowercase words joined by "-"), `title` is the name's own text up to there. */
interface NamePrefix {
  key: string;
  title: string;
}

/** A name's word prefixes, shortest first: words split on "-", "_" and ".". */
function namePrefixes(name: string): NamePrefix[] {
  const trimmed = name.trim();
  const words = [...trimmed.matchAll(/[^-_.]+/g)];
  return words.map((word, index) => ({
    key: words.slice(0, index + 1).map((w) => w[0].toLowerCase()).join("-"),
    title: trimmed.slice(0, word.index + word[0].length),
  }));
}

/**
 * Group by name prefix (#triage:#291): each name's group, in the order given,
 * or null for Other. Names split into words on "-", "_" and "."; prefixes
 * compare case-insensitively. A group's title is its prefix as most of its
 * members write it (a tie: the smallest by code point), so neither the title
 * nor the groups depend on the order given. Deterministic:
 *
 * 1. A name's candidates are its word prefixes shorter than the whole name,
 *    plus the whole name when it is a shorter prefix of another name
 *    ("armbian" beside "armbian-2") or another name is the same
 *    ("raspberrypi" twice, "x.local" and "X-local"), kept only when at least
 *    two names have them. A name with no words (empty) has none.
 * 2. Each name takes its longest candidate (hetzner-ex63-3 → hetzner-ex63).
 * 3. While a group has one member (the longest such group first, then A to Z):
 *    if other groups sit under its prefix, the smallest of them (then A to Z)
 *    moves up into it (atlas-hostinger-root alone at "atlas" takes
 *    atlas-fluence-claude and -root with it: all three are "atlas");
 *    otherwise the lone name falls back to its next shorter candidate, or to
 *    Other when it has none.
 *
 * So no group has a single member, and every name otherwise keeps the
 * longest prefix it shares. Each step removes a group or shortens a name's
 * prefix, so it ends.
 */
export function rackNamePrefixGroups(names: readonly string[]): (NamePrefix | null)[] {
  const prefixes = names.map(namePrefixes);
  const shorterThanAName = new Set(prefixes.flatMap((own) => own.slice(0, -1).map((prefix) => prefix.key)));
  const wholeNames = new Map<string, number>();
  for (const own of prefixes) {
    const whole = own.at(-1);
    if (whole) wholeNames.set(whole.key, (wholeNames.get(whole.key) ?? 0) + 1);
  }
  const support = new Map<string, number>();
  const ownCandidates = prefixes.map((own) => own.filter((prefix, index) => index < own.length - 1 || shorterThanAName.has(prefix.key) || (wholeNames.get(prefix.key) ?? 0) > 1));
  for (const own of ownCandidates) for (const { key } of own) support.set(key, (support.get(key) ?? 0) + 1);
  // Longest first, only those another name shares.
  const candidates = ownCandidates.map((own) => own.filter(({ key }) => (support.get(key) ?? 0) > 1).map(({ key }) => key).reverse());
  const assigned: (string | null)[] = candidates.map((own) => own[0] ?? null);
  const depth = (key: string) => key.split("-").length;
  for (;;) {
    const groups = new Map<string, number[]>();
    assigned.forEach((key, index) => {
      if (key !== null) groups.set(key, [...(groups.get(key) ?? []), index]);
    });
    const lone = [...groups].filter(([, members]) => members.length === 1).map(([key]) => key)
      .sort((a, b) => depth(b) - depth(a) || (a < b ? -1 : a > b ? 1 : 0))[0];
    if (lone === undefined) break;
    const under = [...groups].filter(([key]) => key.startsWith(`${lone}-`))
      .sort(([a, am], [b, bm]) => am.length - bm.length || (a < b ? -1 : a > b ? 1 : 0))[0];
    if (under) {
      for (const index of under[1]) assigned[index] = lone;
    } else {
      const index = groups.get(lone)![0]!;
      const own = candidates[index]!;
      assigned[index] = own[own.indexOf(lone) + 1] ?? null;
    }
  }
  // Each group's spellings, counted; the most common wins, then the smallest by code point.
  const spellings = new Map<string, Map<string, number>>();
  assigned.forEach((key, index) => {
    if (key === null) return;
    const title = prefixes[index]!.find((prefix) => prefix.key === key)!.title;
    const counts = spellings.get(key) ?? new Map<string, number>();
    counts.set(title, (counts.get(title) ?? 0) + 1);
    spellings.set(key, counts);
  });
  const titles = new Map([...spellings].map(([key, counts]) => [key, [...counts].sort(([a, an], [b, bn]) => bn - an || (a < b ? -1 : a > b ? 1 : 0))[0]![0]]));
  return assigned.map((key) => (key === null ? null : { key, title: titles.get(key)! }));
}

/**
 * One group of the overview. `fallback` groups (Personal computers, Other)
 * always come last. `title` is already words; `key` is stable.
 */
export interface RackGroup {
  key: string;
  title: string;
  fallback: boolean;
  machines: readonly Machine[];
}

export interface RackGroupLabels {
  personal: string;
  other: string;
}

function groupKeyAndTitle(machine: Machine, groupBy: Exclude<ComputersRackGroupBy, "none">, labels: RackGroupLabels, prefix: NamePrefix | null): { key: string; title: string; fallback: boolean } {
  if (groupBy === "provider") {
    const provider = machine.hostProvider;
    return provider && isHostProvider(provider)
      ? { key: `provider:${provider}`, title: HOST_PROVIDER_LABELS[provider], fallback: false }
      : { key: "fallback:provider", title: labels.personal, fallback: true };
  }
  return prefix
    ? { key: `prefix:${prefix.key}`, title: prefix.title, fallback: false }
    : { key: "fallback:prefix", title: labels.other, fallback: true };
}

/**
 * `machines` (already sorted) in groups, each keeping the sorted order inside
 * it. Groups follow `rank`: a group's best member under the sort (lower rank
 * first), so a usage sort puts the most used group first; groups without a
 * ranked member, and every group when `rank` is null, go A to Z; fallback
 * groups are last.
 */
export function groupRackMachines(
  machines: readonly Machine[],
  groupBy: ComputersRackGroupBy,
  labels: RackGroupLabels,
  locale: string,
  rank: ((machine: Machine) => number | null) | null,
): RackGroup[] {
  if (groupBy === "none") return [{ key: "all", title: "", fallback: false, machines }];
  const prefixes = groupBy === "prefix" ? rackNamePrefixGroups(machines.map((machine) => machine.name)) : null;
  const groups = new Map<string, RackGroup & { machines: Machine[]; best: number | null }>();
  for (const [index, machine] of machines.entries()) {
    const { key, title, fallback } = groupKeyAndTitle(machine, groupBy, labels, prefixes?.[index] ?? null);
    let group = groups.get(key);
    if (!group) {
      group = { key, title, fallback, machines: [], best: null };
      groups.set(key, group);
    }
    group.machines.push(machine);
    const value = rank ? rank(machine) : null;
    if (value !== null && (group.best === null || value < group.best)) group.best = value;
  }
  const collator = new Intl.Collator(locale, { numeric: true, sensitivity: "base" });
  return [...groups.values()]
    .sort((a, b) => {
      if (a.fallback !== b.fallback) return a.fallback ? 1 : -1;
      if (a.best !== null || b.best !== null) {
        if (a.best === null) return 1;
        if (b.best === null) return -1;
        if (a.best !== b.best) return a.best - b.best;
      }
      return collator.compare(a.title, b.title);
    })
    .map(({ key, title, fallback, machines: members }) => ({ key, title, fallback, machines: members }));
}
