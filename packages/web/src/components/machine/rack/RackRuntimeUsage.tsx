import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { IntlShape } from "react-intl";
import { useIntl } from "react-intl";
import { formatRuntimeLabelWithStatus } from "../../../utils/runtimeAvailabilityLabel";
import { useRuntimeDeprecatedHere } from "../../../hooks/useServerRuntimeCatalog";
import { SquareTerminal } from "lucide-react";
import { Skeleton, Status } from "@botiverse/raft-ui";
import { Meter, MeterIndicator, MeterTrack } from "@botiverse/raft-ui/wip";
import { currentTimeMs, getRuntimeDisplayName, RUNTIME_ACCOUNT_USAGE_PROVIDERS } from "@botiverse/raft-shared";
// OAR's runtime marks (LobeHub lobe-icons, MIT; see the package's
// assets/brands/NOTICE.md). Only the files imported here are bundled. Every
// mark is drawn as a mask over currentColor, so all of them are one colour,
// the text's, in either theme.
import antigravityMark from "@botiverse/oar/assets/brands/antigravity.svg";
import claudeMark from "@botiverse/oar/assets/brands/claude.svg";
import codebuddyMark from "@botiverse/oar/assets/brands/codebuddy.svg";
import codexMark from "@botiverse/oar/assets/brands/codex.svg";
import cursorMark from "@botiverse/oar/assets/brands/cursor.svg";
import grokMark from "@botiverse/oar/assets/brands/grok.svg";
import kimiMark from "@botiverse/oar/assets/brands/kimi.svg";
import opencodeMark from "@botiverse/oar/assets/brands/opencode.svg";
import piMark from "@botiverse/oar/assets/brands/pi.svg";
import qoderMark from "@botiverse/oar/assets/brands/qoder.svg";
import qwenMark from "@botiverse/oar/assets/brands/qwen.svg";
import type { Machine } from "../../../store/machineStore";
import { runtimeAccountUsageClient } from "../../../utils/runtimeAccountUsageClient";
import Tooltip from "../../ui/Tooltip";
import { RuntimeUsageHoverCard } from "../RuntimeAccountUsageChip";
import { usageProviderForRuntime } from "../../../utils/runtimeUsageProvider";
import type { RuntimeUsageTriggerProps } from "../RuntimeAccountUsageChip";
import { runtimeUsageText } from "../runtimeUsageText";
import { RACK_USAGE_WARN_PERCENT, rackLoginStep, rackRuntimeCell, rackUsageTwoLines } from "./rackRuntimeColumns";
import { rackReset, rackResetText } from "./rackResetText";
import type { RackLoginStep, RackModelLine, RackRuntimeCell, RackUsageColumn, RackUsageResults } from "./rackRuntimeColumns";
import { readinessDoLabel } from "../../../utils/readinessCopy";
import { SkeletonTextBar } from "../../ui/Skeleton";
import { readRackUsageTwoLines, writeRackUsageTwoLines } from "./rackUsageLines";

const RUNTIME_MARKS: Record<string, string> = {
  claude: claudeMark,
  codex: codexMark,
  grok: grokMark,
  builtin: piMark,
  antigravity: antigravityMark,
  "kimi-sdk": kimiMark,
  kimi: kimiMark,
  cursor: cursorMark,
  opencode: opencodeMark,
  pi: piMark,
  qwen: qwenMark,
  qoder: qoderMark,
  codebuddy: codebuddyMark,
};

/** A runtime's mark, 12px, in the text's colour; a terminal for one with none. */
export function RackRuntimeMark({ runtimeId }: { runtimeId: string }) {
  const src = RUNTIME_MARKS[runtimeId];
  if (!src) return <SquareTerminal size={12} aria-hidden="true" className="shrink-0" data-runtime-mark={runtimeId} />;
  return (
    <span
      aria-hidden="true"
      className="size-3 shrink-0 bg-current mask-contain mask-center mask-no-repeat"
      style={{ maskImage: `url("${src}")` }}
      data-runtime-mark={runtimeId}
    />
  );
}

/** The column's short name: the catalog name's first word (Claude, Codex, Kimi). */
export function rackRuntimeShortName(runtimeId: string): string {
  return getRuntimeDisplayName(runtimeId).split(" ")[0] ?? runtimeId;
}

/**
 * A column heading: the mark and the short name, the full name on hover and
 * for a screen reader. `role` is the list's columnheader on desktop.
 */
export function RackRuntimeHeading({ runtimeId, className = "", role }: { runtimeId: string; className?: string; role?: "columnheader" }) {
  const name = getRuntimeDisplayName(runtimeId);
  return (
    <Tooltip content={name}>
      <span role={role} className={`flex min-w-0 items-center gap-1 ${className}`} data-testid={`rack-column-${runtimeId}`}>
        <RackRuntimeMark runtimeId={runtimeId} />
        <span className="truncate" aria-hidden="true">{rackRuntimeShortName(runtimeId)}</span>
        <span className="sr-only">{name}</span>
      </span>
    </Tooltip>
  );
}

/** The usage providers of a Computer's runtimes, in the providers' order. */
function machineUsageProviders(machine: Machine) {
  const wanted = new Set(machine.runtimes.map(usageProviderForRuntime));
  return RUNTIME_ACCOUNT_USAGE_PROVIDERS.filter((provider) => wanted.has(provider));
}

const EMPTY_RESULTS: RackUsageResults = {};
/** A read that failed (not allowed, or the request failed): answered, nothing to read ("—"). */
const FAILED_READ = { state: "missing", snapshot: null } as const;

type UsageReads = Readonly<Record<string, { subject: string; results: RackUsageResults }>>;

/**
 * The cached usage reads of each Computer's runtimes (the usage card's
 * client, so its 60s cache is shared), read again whenever a card fetches
 * newer ones. Read once for the whole list, so the list can also sort by
 * them. A Computer `isEnabled` refuses is not in the map (nothing is
 * read); a provider not answered yet is missing from its results (its cell
 * is pending), a failed read is answered as missing. A Computer's results
 * stay the same object while only another's change.
 */
export function useRackRuntimeUsages(
  machines: readonly Machine[],
  serverId: string | null,
  isEnabled: (machine: Machine) => boolean,
): ReadonlyMap<string, RackUsageResults | null> {
  const client = runtimeAccountUsageClient;
  // One line per Computer that reads: "<id>\0<providers>", so the effect
  // restarts only when what is read changes.
  const targets = machines
    .filter((machine) => isEnabled(machine))
    .map((machine) => `${machine.id}\0${machineUsageProviders(machine).join(",")}`);
  const targetsKey = targets.join("\n");
  const [reads, setReads] = useState<UsageReads>({});
  // Synchronizes with the usage client (an external cache): read on show,
  // and again whenever a usage card refreshes it.
  useEffect(() => {
    if (!serverId || !targetsKey) return;
    let live = true;
    const load = () => {
      for (const target of targetsKey.split("\n")) {
        const [machineId, providersKey] = target.split("\0");
        if (!machineId || !providersKey) continue;
        const subject = `${serverId}\0${target}`;
        for (const provider of RUNTIME_ACCOUNT_USAGE_PROVIDERS.filter((candidate) => providersKey.split(",").includes(candidate))) {
          const answer = (result: NonNullable<RackUsageResults[typeof provider]>) => {
            if (!live) return;
            // How many lines this answer draws, for the cell's placeholder the next time it is read (a failure says nothing of it).
            if (result !== FAILED_READ) writeRackUsageTwoLines(serverId, machineId, provider, rackUsageTwoLines(result));
            setReads((current) => {
              const own = current[machineId];
              const results = own?.subject === subject ? own.results : {};
              if (results[provider] === result) return current;
              // A failed read again keeps what an earlier read answered.
              if (result === FAILED_READ && results[provider]) return current;
              return { ...current, [machineId]: { subject, results: { ...results, [provider]: result } } };
            });
          };
          // Not allowed, or the read failed: that runtime shows "—".
          client.read(serverId, machineId, provider).then(answer, () => answer(FAILED_READ));
        }
      }
    };
    load();
    const unsubscribe = client.subscribe(load);
    return () => {
      live = false;
      unsubscribe();
    };
  }, [client, serverId, targetsKey]);
  return useMemo(() => {
    const byMachine = new Map<string, RackUsageResults | null>();
    for (const target of targetsKey ? targetsKey.split("\n") : []) {
      const machineId = target.split("\0")[0]!;
      const own = reads[machineId];
      byMachine.set(machineId, own?.subject === `${serverId}\0${target}` ? own.results : EMPTY_RESULTS);
    }
    return byMachine;
  }, [reads, serverId, targetsKey]);
}

const VALUE_CLASS = "font-mono text-mono-meta whitespace-nowrap";
const FOCUS_CLASS = "rounded-control outline-none focus-visible:shadow-focus";

type ResetText = ReturnType<typeof rackResetText>;

/**
 * The words for a cell: what a screen reader says and the tooltip shows. A
 * used-up cell with a known reset says it in full, as the cell shows it
 * ("Used up · back in 3 hours" for "Back in 3h").
 */
function cellLabel(cell: Exclude<RackRuntimeCell, { kind: "absent" | "pending" }>, reset: ResetText, { formatMessage, locale }: IntlShape): string {
  const runtime = getRuntimeDisplayName(cell.runtimeId);
  // An account that needs attention (sign in again) is always said.
  const attention = runtimeUsageText(cell.attention, formatMessage, locale);
  if (cell.kind === "unavailable") {
    return attention
      ? formatMessage({ id: "machine.rack.usageMeter" }, { runtime, usage: attention })
      : formatMessage({ id: "machine.rack.usageUnavailable" }, { runtime });
  }
  const value = reset
    ? [cell.summary.plan ?? formatMessage({ id: "machine.runtimeUsage.accountFallback" }), reset.full].join(" · ")
    : runtimeUsageText(cell.summary, formatMessage, locale);
  const model = cell.model ? modelLabel(cell.model, intlNow({ formatMessage, locale })) : null;
  const usage = [value, model, attention].filter(Boolean).join(" · ");
  return formatMessage({ id: cell.stale ? "machine.rack.usageMeterStale" : "machine.rack.usageMeter" }, { runtime, usage });
}

type IntlNow = Pick<IntlShape, "formatMessage" | "locale"> & { nowMs: number };

function intlNow(intl: Pick<IntlShape, "formatMessage" | "locale">): IntlNow {
  return { ...intl, nowMs: currentTimeMs() };
}

/** The model line in words, for the cell's name: "Opus: 40% used", "Opus: Used up · back in 6 days". */
function modelLabel(model: RackModelLine, { formatMessage, locale, nowMs }: IntlNow): string {
  const usage = model.usedUp
    ? rackResetText(model.resetsAt, { formatMessage, locale }, nowMs)?.full ?? formatMessage({ id: "machine.rack.usedUp" })
    : formatMessage({ id: "machine.rack.percentUsed" }, { percent: model.used });
  return formatMessage({ id: "machine.rack.modelUsage" }, { model: model.name, usage });
}

/** The model line's value after the name: "40%", or once used up when it resets ("6d"), or "Used up". */
function modelValueText(model: RackModelLine, { formatMessage, nowMs }: IntlNow): string {
  if (!model.usedUp) return formatMessage({ id: "machine.rack.modelPercent" }, { percent: model.used });
  const reset = rackReset(model.resetsAt, nowMs);
  return reset ? formatMessage({ id: MODEL_RESET_IDS[reset.unit] }, { count: reset.count }) : formatMessage({ id: "machine.rack.usedUp" });
}

const MODEL_RESET_IDS = {
  minute: "machine.rack.modelResetsInMinutes",
  hour: "machine.rack.modelResetsInHours",
  day: "machine.rack.modelResetsInDays",
} as const;

/**
 * The cell's second line when the account reports a model's own window:
 * "Opus · 40%" over a thin bar (orange from 80%, a full orange bar when used
 * up), the same raft-ui Meter as the first line.
 */
function ModelUsageLine({ model }: { model: RackModelLine }) {
  const intl = useIntl();
  const now = intlNow(intl);
  return (
    <Meter render={<span />} used={model.used} warnAt={RACK_USAGE_WARN_PERCENT / 100} valueText={modelLabel(model, now)} className="gap-1" data-testid="rack-usage-model">
      <span className={`flex min-w-0 items-center ${VALUE_CLASS} text-(--meter-value)`}>
        <span className="min-w-0 truncate">{model.name}</span>
        <span className="shrink-0 ps-1">{"· "}{modelValueText(model, now)}</span>
      </span>
      <MeterTrack render={<span />} className="block">
        <MeterIndicator render={<span />} />
      </MeterTrack>
    </Meter>
  );
}

/** The bar of what is used: raft-ui Meter (warning from 80% used, a full warning bar when used up). */
function UsageMeter({ cell, label, className = "", children }: {
  cell: Extract<RackRuntimeCell, { kind: "value" }>;
  label: string;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <Meter render={<span />} used={cell.used} warnAt={RACK_USAGE_WARN_PERCENT / 100} valueText={label} className={className}>
      {children}
      <MeterTrack render={<span />} className="block">
        <MeterIndicator render={<span />} />
      </MeterTrack>
    </Meter>
  );
}

/**
 * A value's words: "62% used"; once its limit is reached, when it resets
 * ("Back in 3h", "Back in 2d"), or "Used up" when that isn't known.
 */
function usedText(cell: Extract<RackRuntimeCell, { kind: "value" }>, reset: ResetText, { formatMessage }: IntlShape): string {
  if (!cell.usedUp) return formatMessage({ id: "machine.rack.percentUsed" }, { percent: cell.used });
  return reset?.short ?? formatMessage({ id: "machine.rack.usedUp" });
}

/** An account needing attention, beside a value: the usage card's warning pixel. */
function AttentionPixel({ cell }: { cell: Exclude<RackRuntimeCell, { kind: "absent" }> }) {
  if (cell.kind === "pending" || !cell.attention) return null;
  return <Status size="sm" variant="warning" aria-hidden="true" className="shrink-0" data-testid="rack-usage-attention" />;
}

interface RackUsageProps {
  machine: Machine;
  column: RackUsageColumn;
  results: RackUsageResults | null;
  serverId: string | null;
  /** The computer's agents' model groups, for the model line (`rackAgentModelGroups`); keep it one array while they stay the same. */
  modelGroups?: readonly string[];
}

const NO_MODEL_GROUPS: readonly string[] = [];

/** Opens the runtime's usage card (the usage card's own hover / tap rules). */
function UsageCardTrigger({ machine, cell, serverId, render }: {
  machine: Machine;
  cell: Exclude<RackRuntimeCell, { kind: "absent" }>;
  serverId: string;
  render: (trigger: RuntimeUsageTriggerProps) => ReactNode;
}) {
  return (
    <RuntimeUsageHoverCard
      runtimeId={cell.runtimeId}
      provider={cell.provider}
      runtimeVersion={machine.runtimeVersions?.[cell.runtimeId]}
      serverId={serverId}
      machineId={machine.id}
      renderTrigger={render}
    />
  );
}

/**
 * A provider's cell on a computer (kept while the reads and the computer are
 * the same) and its words. A used-up cell's reset is counted from now on each
 * render (the rack has no clock of its own; it renders again on every read).
 */
function useRackCell(machine: Machine, column: RackUsageColumn, results: RackUsageResults | null, serverId: string | null, modelGroups: readonly string[]) {
  const intl = useIntl();
  const cell = useMemo(() => rackRuntimeCell(machine, column.provider, results, modelGroups), [column.provider, machine, modelGroups, results]);
  const step = cell.kind === "absent" ? null : rackLoginStep(machine, column.provider);
  // Pending: as many lines as the last answer here drew (rackUsageLines, remembered by useRackRuntimeUsages).
  const pending = cell.kind === "pending" && step === null;
  const machineId = machine.id;
  const { provider } = column;
  const pendingTwoLines = useMemo(
    () => (pending && serverId ? readRackUsageTwoLines(serverId, machineId, provider) : false),
    [machineId, pending, provider, serverId],
  );
  const reset = cell.kind === "value" && cell.usedUp && cell.summary.kind === "limit"
    ? rackResetText(cell.summary.resetsAt, intl, currentTimeMs())
    : null;
  const label = cell.kind === "absent"
    ? ""
    : step
      ? intl.formatMessage({ id: "machine.rack.usageMeter" }, { runtime: getRuntimeDisplayName(cell.runtimeId), usage: readinessDoLabel(intl.formatMessage, step) })
      : cell.kind === "pending"
        ? intl.formatMessage({ id: "machine.rack.usageMeter" }, { runtime: getRuntimeDisplayName(cell.runtimeId), usage: intl.formatMessage({ id: "common.loading" }) })
        : cellLabel(cell, reset, intl);
  const text = step ? intl.formatMessage({ id: STEP_IDS[step] }) : cell.kind === "value" ? usedText(cell, reset, intl) : "";
  return { cell, label, text, step, pending, pendingTwoLines };
}

const STEP_IDS = {
  verify_account: "machine.rack.step.verify_account",
  sign_in: "machine.rack.step.sign_in",
} as const satisfies Record<RackLoginStep, string>;

/** A login step on a cell ("Verify", "Sign in"): warning-strong, no bar. */
function StepText({ text, className = "" }: { text: string; className?: string }) {
  return <span className={`block ${VALUE_CLASS} text-warning-strong ${className}`} data-testid="rack-usage-step">{text}</span>;
}

/** A card line's name: the mark and the short name (the line's label says it in full); bold on the line the cards are sorted by. */
function CardLineName({ runtimeId, emphasized = false }: { runtimeId: string; emphasized?: boolean }) {
  return (
    <span className={`${LINE_LABEL_CLASS} ${emphasized ? EMPHASIZED_LABEL_CLASS : ""}`} aria-hidden="true">
      <RackRuntimeMark runtimeId={runtimeId} />
      <span className="truncate">{rackRuntimeShortName(runtimeId)}</span>
    </span>
  );
}

/**
 * A card's model line, under its provider's line when the account reports a
 * model's own window: the model's name (under the provider's name), its bar,
 * "40%" or, used up, when it resets ("6d"). Three cells of the card's grid.
 */
function ModelCardLine({ model }: { model: RackModelLine }) {
  const intl = useIntl();
  const now = intlNow(intl);
  const warn = model.used >= RACK_USAGE_WARN_PERCENT;
  return (
    <>
      <span className={`${LINE_LABEL_CLASS} pl-[18px]`} aria-hidden="true">
        <span className="truncate">{model.name}</span>
      </span>
      <Meter render={<span />} used={model.used} warnAt={RACK_USAGE_WARN_PERCENT / 100} valueText={modelLabel(model, now)} className="w-full" data-testid="rack-usage-model">
        <MeterTrack render={<span />} className="block">
          <MeterIndicator render={<span />} />
        </MeterTrack>
      </Meter>
      <span className={`text-right ${VALUE_CLASS} ${warn ? "text-warning-strong" : "text-foreground-hint"}`} aria-hidden="true">
        {modelValueText(model, now)}
      </span>
    </>
  );
}

/** A card line's "—", with the attention pixel when an account needs it. */
function CardLineDash({ cell }: { cell: Exclude<RackRuntimeCell, { kind: "absent" }> }) {
  return <span className={`flex items-center justify-end gap-1 ${VALUE_CLASS} text-foreground-hint`} aria-hidden="true"><AttentionPixel cell={cell} />—</span>;
}

/** A cell opens the usage card when there is something on it to read: a value, an account needing attention, or a login step. */
function opensCard(cell: Exclude<RackRuntimeCell, { kind: "absent" }>, step: RackLoginStep | null): boolean {
  return cell.kind === "value" || (cell.kind === "unavailable" && cell.attention !== null) || step !== null;
}

/** A bar of a pending value (UsageMeter, ModelUsageLine): its words' line over its track. */
function PendingMeter({ word }: { word: string }) {
  return (
    <span className="grid w-full min-w-0 gap-1">
      <span className={VALUE_CLASS}><SkeletonTextBar className={word} /></span>
      <Skeleton className="h-2 w-full" />
    </span>
  );
}

/**
 * A list cell whose usage is being read: bars in the value's shape, two when
 * the last answer had a model line, so the row keeps its height when it
 * lands. Not "—" (nothing to read); a screen reader hears it is loading.
 */
function PendingUsageCell({ label, twoLines, testId, className }: { label: string; twoLines: boolean; testId: string; className: string }) {
  return (
    <div className={`block ${className}`} data-testid={testId} data-usage="pending" data-usage-lines={twoLines ? "2" : "1"}>
      <span className="sr-only">{label}</span>
      <span className="flex flex-col gap-1.5" aria-hidden="true">
        <PendingMeter word="w-14" />
        {twoLines ? <PendingMeter word="w-16" /> : null}
      </span>
    </div>
  );
}

/** A card line whose usage is being read: its name, then bars in the value's shape (two lines when the last answer had a model line). */
function PendingUsageCardLine({ runtimeId, label, twoLines, emphasized, testId }: { runtimeId: string; label: string; twoLines: boolean; emphasized: boolean; testId: string }) {
  return (
    <div className={`${LINE_CLASS} ${twoLines ? "gap-y-1" : ""}`} data-testid={testId} data-usage="pending" data-usage-lines={twoLines ? "2" : "1"}>
      <span className="sr-only">{label}</span>
      <CardLineName runtimeId={runtimeId} emphasized={emphasized} />
      <span className="flex items-center" aria-hidden="true"><Skeleton className="h-2 w-full" /></span>
      <span className={`text-right ${VALUE_CLASS}`} aria-hidden="true"><SkeletonTextBar className="w-12" /></span>
      {twoLines ? (
        <>
          <span className={`${LINE_LABEL_CLASS} pl-[18px]`} aria-hidden="true"><span className="truncate"><SkeletonTextBar className="w-10" /></span></span>
          <span className="flex items-center" aria-hidden="true"><Skeleton className="h-2 w-full" /></span>
          <span className={`text-right ${VALUE_CLASS}`} aria-hidden="true"><SkeletonTextBar className="w-8" /></span>
        </>
      ) : null}
    </div>
  );
}

/**
 * A usage column's cell (list view): "x% used" (or, used up, when it resets) over the bar;
 * "—" when the runtime is installed but has no share used to read; empty when it is not
 * installed. A value, or an account needing attention, opens the usage card;
 * a plain "—" says why on hover and focus; bars while it is read (PendingUsageCell). `className` sets the width.
 */
export function RackUsageCell({ machine, column, results, serverId, modelGroups = NO_MODEL_GROUPS, className }: RackUsageProps & { className: string }) {
  const { cell, label, text, step, pending, pendingTwoLines } = useRackCell(machine, column, results, serverId, modelGroups);
  const testId = `rack-usage-${machine.id}-${column.provider}`;
  const dash = <span className={`${VALUE_CLASS} text-foreground-hint`}>—</span>;
  const render = useCallback((trigger: RuntimeUsageTriggerProps) => {
    if (cell.kind === "absent") return null;
    return (
      <button
        type="button"
        {...trigger}
        aria-label={label}
        className={`block cursor-help text-left ${FOCUS_CLASS} ${cell.kind === "value" && cell.stale ? "opacity-60" : ""} ${className}`}
        data-testid={testId}
        data-usage={cell.kind}
        data-usage-warn={cell.kind === "value" && cell.warn ? "true" : undefined}
        data-usage-stale={cell.kind === "value" && cell.stale ? "true" : undefined}
        data-usage-step={step ?? undefined}
      >
        {step ? (
          <StepText text={text} />
        ) : cell.kind === "value" ? (
          <span className="flex flex-col gap-1.5">
            <UsageMeter cell={cell} label={label} className="gap-1">
              <span className="flex min-w-0 items-center gap-1">
                <span className={`min-w-0 truncate ${VALUE_CLASS} text-(--meter-value)`}>{text}</span>
                <AttentionPixel cell={cell} />
              </span>
            </UsageMeter>
            {cell.model && <ModelUsageLine model={cell.model} />}
          </span>
        ) : (
          <span className="flex items-center gap-1"><span className={`${VALUE_CLASS} text-foreground-hint`}>—</span><AttentionPixel cell={cell} /></span>
        )}
      </button>
    );
  }, [cell, className, label, step, testId, text]);
  if (cell.kind === "absent") return <div className={className} aria-hidden="true" data-testid={testId} data-usage="absent" />;
  if (pending) return <PendingUsageCell label={label} twoLines={pendingTwoLines} testId={testId} className={className} />;
  if (!serverId || !opensCard(cell, step)) {
    return (
      <Tooltip content={label}>
        <button type="button" aria-label={label} className={`block cursor-help text-left ${FOCUS_CLASS} ${className}`} data-testid={testId} data-usage="unavailable">
          {dash}
        </button>
      </Tooltip>
    );
  }
  return <UsageCardTrigger machine={machine} cell={cell} serverId={serverId} render={render} />;
}

/**
 * The Other column's cell: each runtime's mark, their names on hover and
 * focus. More marks than the 40px column holds wrap onto further lines
 * rather than run into the next step's column (the Upgrade button).
 */
export function RackOtherCell({ machineId, runtimeIds, className = "" }: { machineId: string; runtimeIds: string[]; className?: string }) {
  const { formatList } = useIntl();
  if (runtimeIds.length === 0) return <div className={`shrink-0 ${className}`} aria-hidden="true" data-testid={`rack-other-${machineId}`} />;
  const names = formatList(runtimeIds.map(getRuntimeDisplayName), { type: "conjunction" });
  return (
    <Tooltip content={names}>
      <button
        type="button"
        aria-label={names}
        className={`flex min-h-[18px] shrink-0 cursor-help flex-wrap items-center gap-1 py-[3px] text-foreground-hint ${FOCUS_CLASS} ${className}`}
        data-testid={`rack-other-${machineId}`}
      >
        {runtimeIds.map((runtimeId) => <RackRuntimeMark key={runtimeId} runtimeId={runtimeId} />)}
      </button>
    </Tooltip>
  );
}

const LINE_CLASS = `col-span-3 grid grid-cols-subgrid items-center text-left ${FOCUS_CLASS}`;
const LINE_LABEL_CLASS = "flex min-w-0 items-center gap-1.5 text-footnote text-foreground-muted";
/** The line the cards are sorted by, at the top of the meters: bold, in ink. */
const EMPHASIZED_LABEL_CLASS = "font-bold text-foreground";

/** A card's line: name, bar, value. Disk and Memory use it too. */
export function RackCardLine({ label, bar, value, warn = false, emphasized = false }: { label: ReactNode; bar: ReactNode; value: ReactNode; warn?: boolean; emphasized?: boolean }) {
  return (
    <>
      <span className={`${LINE_LABEL_CLASS} ${emphasized ? EMPHASIZED_LABEL_CLASS : ""}`}>{label}</span>
      <span className="flex items-center">{bar}</span>
      <span className={`text-right ${VALUE_CLASS} ${warn ? "text-warning-strong" : emphasized ? "text-foreground" : "text-foreground-hint"} ${emphasized ? "font-bold" : ""}`}>{value}</span>
    </>
  );
}

/**
 * A usage provider's line on a card (cards view): mark and name, the bar,
 * "x% used" (or, used up, when it resets), or "—" when there is no share used to read; the same targets as
 * the list's cell. Nothing for a provider the computer doesn't have.
 */
export function RackUsageCardLine({ machine, column, results, serverId, modelGroups = NO_MODEL_GROUPS, emphasized = false }: RackUsageProps & { emphasized?: boolean }) {
  const { cell, label, text, step, pending, pendingTwoLines } = useRackCell(machine, column, results, serverId, modelGroups);
  const testId = `rack-usage-${machine.id}-${column.provider}`;
  const render = useCallback((trigger: RuntimeUsageTriggerProps) => {
    if (cell.kind === "absent") return null;
    return (
      <button
        type="button"
        {...trigger}
        aria-label={label}
        className={`${LINE_CLASS} cursor-help ${cell.kind === "value" && cell.model ? "gap-y-1" : ""} ${cell.kind === "value" && cell.stale ? "opacity-60" : ""}`}
        data-testid={testId}
        data-usage={cell.kind}
        data-usage-warn={cell.kind === "value" && cell.warn ? "true" : undefined}
        data-usage-stale={cell.kind === "value" && cell.stale ? "true" : undefined}
        data-emphasized={emphasized ? "true" : undefined}
        data-usage-step={step ?? undefined}
      >
        <CardLineName runtimeId={cell.runtimeId} emphasized={emphasized} />
        {cell.kind === "value" && !step ? <UsageMeter cell={cell} label={label} className="w-full" /> : <span aria-hidden="true" />}
        {step ? (
          <StepText text={text} className="text-right" />
        ) : cell.kind === "value" ? (
          <span className={`flex items-center justify-end gap-1 ${VALUE_CLASS} ${cell.warn ? "text-warning-strong" : emphasized ? "text-foreground" : "text-foreground-hint"} ${emphasized ? "font-bold" : ""}`}>
            <AttentionPixel cell={cell} />
            {text}
          </span>
        ) : <CardLineDash cell={cell} />}
        {cell.kind === "value" && cell.model && <ModelCardLine model={cell.model} />}
      </button>
    );
  }, [cell, emphasized, label, step, testId, text]);
  if (cell.kind === "absent") return null;
  if (pending) return <PendingUsageCardLine runtimeId={cell.runtimeId} label={label} twoLines={pendingTwoLines} emphasized={emphasized} testId={testId} />;
  if (!serverId || !opensCard(cell, step)) {
    return (
      <Tooltip content={label}>
        <button type="button" aria-label={label} className={`${LINE_CLASS} cursor-help`} data-testid={testId} data-usage="unavailable">
          <CardLineName runtimeId={cell.runtimeId} emphasized={emphasized} />
          <span aria-hidden="true" />
          <CardLineDash cell={cell} />
        </button>
      </Tooltip>
    );
  }
  return <UsageCardTrigger machine={machine} cell={cell} serverId={serverId} render={render} />;
}

/** A card's Other runtimes line: each runtime's mark and name. */
export function RackOtherCardLine({ machineId, runtimeIds }: { machineId: string; runtimeIds: string[] }) {
  const { formatMessage } = useIntl();
  const deprecatedHere = useRuntimeDeprecatedHere();
  if (runtimeIds.length === 0) return null;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-footnote text-foreground-hint" data-testid={`rack-other-${machineId}`}>
      <span className="shrink-0">{formatMessage({ id: "machine.rack.otherRuntimes" })}</span>
      {runtimeIds.map((runtimeId) => (
        <span key={runtimeId} className="flex shrink-0 items-center gap-1">
          <RackRuntimeMark runtimeId={runtimeId} />
          {formatRuntimeLabelWithStatus(runtimeId, formatMessage, deprecatedHere(runtimeId))}
        </span>
      ))}
    </div>
  );
}
