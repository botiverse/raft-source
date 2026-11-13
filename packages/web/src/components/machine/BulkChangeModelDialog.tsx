import { Button, Checkbox, Spinner, TextLink } from "@botiverse/raft-ui";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { formatRuntimeLabelBesideBadge, runtimeShowsExperimentalBadge } from "../../utils/runtimeAvailabilityLabel";
import { ArrowRight, Check, X } from "lucide-react";
import {
  REASONING_EFFORT_RUNTIMES,
  currentTimeMs,
  getDefaultModel,
  getRuntimeDisplayName,
  runtimeChoiceModel,
} from "@botiverse/raft-shared";
import type { ReasoningEffort } from "@botiverse/raft-shared";
import api from "../../api/client";
import DialogCard from "../ui/DialogCard";
import AvatarSlot from "../ui/AvatarSlot";
import { RuntimeSelectControl } from "../agent/RuntimeConfigFields";
import { useRuntimeModels } from "../../hooks/useRuntimeModels";
import { fetchExistingAgentRuntimeOptions } from "../../hooks/useRuntimeSelectionCatalog";
import { isRuntimeDeprecatedOnServer, useServerRuntimeCatalog } from "../../hooks/useServerRuntimeCatalog";
import { reasoningEffortOptionsForModel, reconcileReasoningEffort } from "../../utils/reasoningEffortOptions";
import { useAgentStore } from "../../store/agentStore";
import { useServerStore } from "../../store/serverStore";
import { runtimeAccountUsageClient } from "../../utils/runtimeAccountUsageClient";
import { usageProviderForRuntime } from "../../utils/runtimeUsageProvider";
import { runtimeUsageText } from "./runtimeUsageText";
import type { Agent } from "../../store/agentStore";
import type { Machine } from "../../store/machineStore";
import type { BulkChangeReceipt, BulkUnfinishedAgent } from "../../store/bulkChangeModelReceiptStore";
import { BULK_SUCCESS_BANNER_MS } from "../../store/bulkChangeModelReceiptStore";
import {
  newBulkModelChangeOperation,
  trackBulkModelChangeClosed,
  trackBulkModelChangeFinished,
  trackBulkModelChangeOpened,
  trackBulkModelChangeSubmitted,
} from "../../analytics/bulkModelChange";
import type { BulkModelChangeAgentResult } from "../../analytics/bulkModelChange";
import {
  buildBulkAgentUpdate,
  classifyUnfinished,
  formatBulkModelLabel,
  isBulkSelectableRuntime,
  planBulkModelChange,
  summarizeRuntimeUsage,
} from "./bulkChangeModelPlan";
import type { BulkModelTarget, BulkPlanAgentInput, BulkPlanRow, BulkRuntimeUsageSummary, BulkUnfinishedPhase } from "./bulkChangeModelPlan";
import { DialogCardFooter, DialogCancel, DialogCommit } from "../ui/NarrowDialog";

type Step = "choose" | "review" | "applying";
type ApplyState = "saving" | "saved" | "failed";

const REASONING_DEFAULT_VALUE = "__default__";

/** Raft DS field label: 13/18 600, ink. */
const FIELD_LABEL_CLASS_NAME = "text-footnote font-semibold text-foreground";


const SKIP_REASON_MESSAGE = {
  customSettings: "machine.detail.bulkModel.skip.customSettings",
  runtimeUnavailable: "machine.detail.bulkModel.skip.runtimeUnavailable",
  noChange: "machine.detail.bulkModel.skip.noChange",
} as const;

const APPLY_STATE_MESSAGE = {
  saving: "machine.detail.bulkModel.applyState.saving",
  saved: "machine.detail.bulkModel.applyState.saved",
  failed: "machine.detail.bulkModel.applyState.failed",
} as const;

export interface BulkChangeModelDialogProps {
  machine: Machine;
  agents: Agent[];
  isRunning: (agent: Agent) => boolean;
  /** Same visibility rule as the runtime usage badge on this page. When false,
   *  no usage is read or shown. */
  canViewUsage?: boolean;
  /** Re-opened from a partial-failure receipt: last target + per-agent phase. */
  retry?: { target: BulkModelTarget; unfinished: BulkUnfinishedAgent[] };
  onClose: () => void;
  onOpenAgent: (agentId: string) => void;
  onFinished: (receipt: BulkChangeReceipt, highlightedAgentIds: string[]) => void;
  now?: () => number;
}

function mostCommon(values: string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best: string | undefined;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Fixed-width shell whose body slides/fades between steps and whose height
 * follows its content smoothly. `motion-reduce` switches instantly.
 */
function StepBody({ stepKey, children }: { stepKey: string; children: ReactNode }) {
  const innerRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | undefined>(undefined);
  useLayoutEffect(() => {
    const node = innerRef.current;
    if (!node) return;
    const measure = () => setHeight(node.offsetHeight);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [stepKey]);
  return (
    <div
      // Negative margin + matching padding: the clip box is 4px larger than the
      // content, so focus rings (2px paper gap + 2px ink) are not cut.
      className="-m-1 overflow-hidden transition-[height] duration-200 ease-out motion-reduce:transition-none"
      style={height === undefined ? undefined : { height }}
    >
      <div ref={innerRef} key={stepKey} className="bulk-model-step p-1" data-testid={`bulk-model-step-${stepKey}`}>
        {children}
      </div>
    </div>
  );
}

function EditAgentLink({ agentId, onOpenAgent }: { agentId: string; onOpenAgent: (agentId: string) => void }) {
  const { formatMessage } = useIntl();
  const open = useCallback(() => onOpenAgent(agentId), [agentId, onOpenAgent]);
  return (
    // The "·" separator is drawn by CSS so it is not a JSX literal.
    <TextLink variant="strong" className="before:mr-1 before:inline-block before:no-underline before:content-['·']" onClick={open}>
      {formatMessage({ id: "machine.detail.bulkModel.edit" })}
    </TextLink>
  );
}

// Raft DS Steps, drawn on the stepper's existing markup (raft-ui Steps would
// turn it into an announced list): a 20px square mark per step — done is ink
// with a paper check, the current step a yellow sticker, the next a seam box —
// a 13/18 600 label, and a short seam between steps.
const STEP_MARK_CLASS_NAME =
  "inline-flex size-5 shrink-0 items-center justify-center rounded-sticker font-mono text-mono-meta font-bold";
const STEP_MARK_DONE_CLASS_NAME = "border-[1.5px] border-foreground bg-foreground text-foreground-inverse";
const STEP_MARK_CURRENT_CLASS_NAME = "border-[1.5px] border-sticker-ink bg-selected text-sticker-ink";
const STEP_MARK_NEXT_CLASS_NAME = "border border-line-seam bg-layer-card text-foreground-hint";

function Stepper({ step }: { step: Step }) {
  const { formatMessage } = useIntl();
  const reviewing = step !== "choose";
  return (
    <div className="mb-4 flex items-center gap-2 text-footnote font-semibold text-foreground-hint">
      <span className={`flex items-center gap-2 ${reviewing ? "text-foreground-muted" : "text-foreground"}`}>
        <span className={`${STEP_MARK_CLASS_NAME} ${reviewing ? STEP_MARK_DONE_CLASS_NAME : STEP_MARK_CURRENT_CLASS_NAME}`}>
          {reviewing ? <Check size={14} aria-hidden /> : <span aria-hidden>{1}</span>}
        </span>
        {formatMessage({ id: "machine.detail.bulkModel.stepChoose" })}
      </span>
      <span className="w-4 shrink-0 border-t border-line-seam" aria-hidden />
      <span className={`flex items-center gap-2 ${reviewing ? "text-foreground" : ""}`}>
        <span className={`${STEP_MARK_CLASS_NAME} ${reviewing ? STEP_MARK_CURRENT_CLASS_NAME : STEP_MARK_NEXT_CLASS_NAME}`}>
          <span aria-hidden>{2}</span>
        </span>
        {formatMessage({ id: "machine.detail.bulkModel.stepReview" })}
      </span>
    </div>
  );
}

export default function BulkChangeModelDialog({
  machine,
  agents,
  isRunning,
  retry,
  onClose,
  onOpenAgent,
  onFinished,
  canViewUsage = false,
  now = currentTimeMs,
}: BulkChangeModelDialogProps) {
  const { formatMessage, locale } = useIntl();
  const serverId = useServerStore((s) => s.current?.id);
  const updateAgent = useAgentStore((s) => s.updateAgent);
  const resetAgent = useAgentStore((s) => s.resetAgent);

  const runtimeIds = useMemo(
    () => machine.runtimes.filter((id) => isBulkSelectableRuntime(id)),
    [machine.runtimes],
  );
  // Read-only usage per runtime (task #1292). Cached client, same 60 s cache as
  // the badge; errors and missing snapshots simply show nothing.
  const [usageByRuntime, setUsageByRuntime] = useState<Record<string, BulkRuntimeUsageSummary | null>>({});
  useEffect(() => {
    if (!canViewUsage || !serverId) return;
    let cancelled = false;
    for (const runtimeId of runtimeIds) {
      const provider = usageProviderForRuntime(runtimeId);
      if (!provider) continue;
      void runtimeAccountUsageClient.read(serverId, machine.id, provider)
        .then((result) => {
          if (cancelled) return;
          setUsageByRuntime((current) => ({ ...current, [runtimeId]: summarizeRuntimeUsage(result.snapshot) }));
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [canViewUsage, machine.id, runtimeIds, serverId]);

  const initialRuntime = useMemo(() => {
    if (retry && runtimeIds.includes(retry.target.runtime)) return retry.target.runtime;
    const common = mostCommon(agents.map((a) => a.runtime).filter((id) => runtimeIds.includes(id)));
    return common ?? runtimeIds[0] ?? "";
  }, [agents, retry, runtimeIds]);

  const [step, setStep] = useState<Step>("choose");
  const [runtime, setRuntime] = useState(initialRuntime);
  // User choices; the effective values are derived during render so they stay
  // valid for whatever the runtime's model list currently offers.
  const [modelChoice, setModelChoice] = useState(retry?.target.model ?? "");
  const [reasoningChoice, setReasoningChoice] = useState<ReasoningEffort | null>(retry?.target.reasoningEffort ?? null);
  const [runtimeAllowed, setRuntimeAllowed] = useState<Record<string, boolean> | null>(null);
  const [checkingRuntime, setCheckingRuntime] = useState(false);
  const [applyStates, setApplyStates] = useState<Record<string, ApplyState>>({});
  // Reconciler step 11c: running agents switch at their next idle point unless asked to restart now.
  const [restartNow, setRestartNow] = useState(false);

  // Usage events (RFC-067): one operation per dialog open, pinned to the
  // server it was opened in. The ref keeps React's dev double-run of effects
  // from counting an open twice.
  const [operation] = useState(() => newBulkModelChangeOperation(serverId));
  const openTracked = useRef(false);
  useEffect(() => {
    if (openTracked.current) return;
    openTracked.current = true;
    trackBulkModelChangeOpened(operation, retry ? "partial_receipt" : "machine_panel", agents.length);
  }, [agents.length, operation, retry]);

  const runtimeModels = useRuntimeModels(machine.id, runtime, { reuseRecentMs: 60_000 });
  // "The runtime chooses" (Antigravity's configured default) stays first and
  // preselected, so confirming without a pick does not pin agents to the
  // model the runtime happens to start on today, nor to its effort.
  const runtimeChoice = runtimeChoiceModel(runtime);
  const models = useMemo(
    () => (runtimeChoice ? [runtimeChoice, ...runtimeModels.models.filter((m) => m.id !== runtimeChoice.id)] : runtimeModels.models),
    [runtimeChoice, runtimeModels.models],
  );

  const model = useMemo(() => {
    if (models.some((m) => m.id === modelChoice)) return modelChoice;
    const preferred = runtimeChoice?.id ?? runtimeModels.default ?? getDefaultModel(runtime);
    return models.find((m) => m.id === preferred)?.id ?? models[0]?.id ?? "";
  }, [modelChoice, models, runtime, runtimeChoice, runtimeModels.default]);

  const supportsReasoning = REASONING_EFFORT_RUNTIMES.has(runtime);
  const reasoning = useMemo(
    () => (supportsReasoning && model ? reconcileReasoningEffort(runtime, model, reasoningChoice, models) : null),
    [model, models, reasoningChoice, runtime, supportsReasoning],
  );

  const target: BulkModelTarget = useMemo(
    () => ({ runtime, model, reasoningEffort: supportsReasoning ? reasoning : null }),
    [model, reasoning, runtime, supportsReasoning],
  );

  const phaseById = useMemo(() => {
    const map = new Map<string, BulkUnfinishedPhase>();
    for (const item of retry?.unfinished ?? []) map.set(item.agentId, item.phase);
    return map;
  }, [retry]);

  const planInputs: BulkPlanAgentInput[] = useMemo(() => agents.map((agent) => ({
    id: agent.id,
    runtime: agent.runtime,
    model: agent.model,
    reasoningEffort: agent.reasoningEffort ?? null,
    runtimeConfig: agent.runtimeConfig ?? null,
    envVars: agent.envVars ?? null,
    external: agent.external,
    running: isRunning(agent),
    ...(runtimeAllowed && agent.id in runtimeAllowed ? { targetRuntimeAllowed: runtimeAllowed[agent.id] } : {}),
    ...(phaseById.has(agent.id) ? { phase: phaseById.get(agent.id) } : {}),
  })), [agents, isRunning, phaseById, runtimeAllowed]);

  const plan = useMemo(() => planBulkModelChange(planInputs, target, { restartNow }), [planInputs, restartNow, target]);
  const agentById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);

  const usageText = useCallback(
    (summary: BulkRuntimeUsageSummary | null | undefined) => runtimeUsageText(summary, formatMessage, locale),
    [formatMessage, locale],
  );
  // "(deprecated)" is this server's answer: a runtime it offers again is not.
  const runtimeCatalog = useServerRuntimeCatalog(serverId);
  const runtimeOptions = useMemo(() => runtimeIds.map((id) => {
    const description = usageText(usageByRuntime[id]);
    const deprecated = isRuntimeDeprecatedOnServer(id, runtimeCatalog);
    // Like every runtime picker: raft-ui's Experimental badge, not "(experimental)" text.
    return {
      value: id,
      label: formatRuntimeLabelBesideBadge(id, formatMessage, deprecated),
      ...(runtimeShowsExperimentalBadge(id, deprecated) ? { experimental: true } : {}),
      ...(description ? { description } : {}),
    };
  }), [formatMessage, runtimeCatalog, runtimeIds, usageByRuntime, usageText]);
  // Models this Computer's runtime listed as disabled come last, greyed and not
  // selectable, with the runtime's own reason (plain text).
  const modelOptions = useMemo(() => {
    const usable = models.map((m) => ({ value: m.id, label: m.label || m.id }));
    if (runtimeModels.unavailable.length === 0) return usable;
    const group = formatMessage({ id: "agent.runtimeModels.unavailableGroup" });
    return [
      ...usable,
      ...runtimeModels.unavailable.map((m) => ({
        value: m.id,
        label: m.label || m.id,
        disabled: true,
        group,
        ...(m.runtimeReason ? { description: m.runtimeReason } : {}),
      })),
    ];
  }, [formatMessage, models, runtimeModels.unavailable]);
  const reasoningOptions = useMemo(() => {
    if (!supportsReasoning || !model) return [];
    return [
      { value: REASONING_DEFAULT_VALUE, label: formatMessage({ id: "machine.detail.bulkModel.reasoningDefault" }) },
      ...reasoningEffortOptionsForModel(runtime, model, models).map((option) => ({
        value: option.value,
        label: formatMessage({ id: option.labelId }),
      })),
    ];
  }, [formatMessage, model, models, runtime, supportsReasoning]);

  const handleRuntimeChange = useCallback((next: string) => {
    setRuntime(next);
    setModelChoice("");
    setRuntimeAllowed(null);
  }, []);
  const handleReasoningChange = useCallback((next: string) => {
    setReasoningChoice(next === REASONING_DEFAULT_VALUE ? null : next as ReasoningEffort);
  }, []);
  const ignoreClose = useCallback(() => {}, []);
  const handleClose = useCallback(() => {
    if (step !== "applying") trackBulkModelChangeClosed(operation, step);
    onClose();
  }, [onClose, operation, step]);
  const backToChoose = useCallback(() => setStep("choose"), []);

  const goToReview = useCallback(async () => {
    const switching = agents.filter((agent) => agent.runtime !== runtime);
    if (switching.length === 0) {
      setRuntimeAllowed({});
      setStep("review");
      return;
    }
    setCheckingRuntime(true);
    try {
      const entries = await Promise.all(switching.map(async (agent) => {
        const options = await fetchExistingAgentRuntimeOptions(agent.id);
        const option = options.find((o) => o.runtimeId === runtime);
        // Fail closed: an unreadable catalog means we cannot prove it is allowed.
        return [agent.id, Boolean(option?.canSelectInThisContext)] as const;
      }));
      setRuntimeAllowed(Object.fromEntries(entries));
      setStep("review");
    } finally {
      setCheckingRuntime(false);
    }
  }, [agents, runtime]);

  const apply = useCallback(async () => {
    const applying = plan.rows.filter((row): row is Exclude<BulkPlanRow, { kind: "skip" }> => row.kind !== "skip");
    if (applying.length === 0) return;
    const startedAt = now();
    const changeCount = applying.filter((row) => row.kind === "change").length;
    trackBulkModelChangeSubmitted(operation, {
      change: changeCount,
      restartOnly: applying.length - changeCount,
      skip: plan.rows.length - applying.length,
    });
    setStep("applying");
    setApplyStates(Object.fromEntries(applying.map((row) => [row.agentId, "saving" as ApplyState])));
    const inputById = new Map(planInputs.map((input) => [input.id, input]));
    const results = await Promise.all(applying.map(async (row) => {
      const input = inputById.get(row.agentId)!;
      try {
        if (row.kind === "restartOnly") {
          await resetAgent(row.agentId, "restart");
        } else {
          await updateAgent(
            row.agentId,
            buildBulkAgentUpdate(input, target),
            row.restarts ? { restartMode: "restart" } : undefined,
          );
        }
        setApplyStates((current) => ({ ...current, [row.agentId]: "saved" }));
        return { agentId: row.agentId, ok: true as const, result: "succeeded" as BulkModelChangeAgentResult };
      } catch {
        let phase: BulkUnfinishedPhase = "save_failed";
        let result: BulkModelChangeAgentResult = "unconfirmed";
        try {
          const { data } = await api.get<Agent>(`/agents/${row.agentId}`);
          useAgentStore.setState((state) => ({
            agents: state.agents.map((agent) => (agent.id === data.id ? { ...agent, ...data } : agent)),
          }));
          phase = classifyUnfinished(
            { runtime: data.runtime, model: data.model, reasoningEffort: data.reasoningEffort ?? null },
            target,
          );
          result = phase;
        } catch {
          phase = row.kind === "restartOnly" ? "restart_pending" : "save_failed";
        }
        setApplyStates((current) => ({ ...current, [row.agentId]: "failed" }));
        return { agentId: row.agentId, ok: false as const, phase, result };
      }
    }));
    trackBulkModelChangeFinished(operation, results.map((r) => r.result), now() - startedAt);
    const failed = results.filter((r): r is Extract<typeof r, { ok: false }> => !r.ok);
    const changedAgentIds = results.filter((r) => r.ok).map((r) => r.agentId);
    const skippedAgentIds = plan.rows.filter((row) => row.kind === "skip").map((row) => row.agentId);
    const receipt: BulkChangeReceipt = failed.length === 0
      ? { kind: "success", target, changedAgentIds, skippedAgentIds, bannerUntil: now() + BULK_SUCCESS_BANNER_MS }
      : { kind: "partial", target, total: applying.length, unfinished: failed.map((r) => ({ agentId: r.agentId, phase: r.phase })) };
    onFinished(receipt, changedAgentIds);
  }, [now, onFinished, operation, plan.rows, planInputs, resetAgent, target, updateAgent]);

  const handleNext = useCallback(() => { void goToReview(); }, [goToReview]);
  const handleApply = useCallback(() => { void apply(); }, [apply]);
  const title = formatMessage({ id: "machine.detail.bulkModel.title" }, { count: agents.length });
  const nextDisabled = !runtime || !model || checkingRuntime || (runtimeModels.loading && models.length === 0);

  return (
    <DialogCard
      title={step === "applying"
        ? formatMessage({ id: "machine.detail.bulkModel.applyingTitle" }, { count: plan.applyCount })
        : title}
      onClose={step === "applying" ? ignoreClose : handleClose}
      maxWidthClass="max-w-2xl"
      testId="bulk-change-model-dialog"
      narrow="sheet"
    >
      {step !== "applying" && <Stepper step={step} />}
      <StepBody stepKey={step}>
        {step === "choose" && (
          <div className="stack-y-4">
            {runtimeIds.length === 0 ? (
              <p className="text-callout text-foreground-muted">{formatMessage({ id: "machine.detail.bulkModel.noRuntimes" })}</p>
            ) : (
              <>
                <div className="stack-y-1.5">
                  <div className={FIELD_LABEL_CLASS_NAME}>{formatMessage({ id: "machine.detail.bulkModel.runtime" })}</div>
                  <RuntimeSelectControl
                    value={runtime}
                    onValueChange={handleRuntimeChange}
                    options={runtimeOptions}
                    placeholder={formatMessage({ id: "machine.detail.bulkModel.runtime" })}
                    testId="bulk-model-runtime"
                  />
                  <p className="text-caption text-foreground-muted">
                    {formatMessage({ id: "machine.detail.bulkModel.accountHint" }, { runtime: getRuntimeDisplayName(runtime) })}
                  </p>
                </div>
                <div className="stack-y-1.5">
                  <div className={FIELD_LABEL_CLASS_NAME}>{formatMessage({ id: "machine.detail.bulkModel.model" })}</div>
                  <RuntimeSelectControl
                    value={model}
                    onValueChange={setModelChoice}
                    options={modelOptions}
                    placeholder={formatMessage({ id: "machine.detail.bulkModel.loadingModels" })}
                    testId="bulk-model-model"
                  />
                </div>
                {reasoningOptions.length > 0 && (
                  <div className="stack-y-1.5">
                    <div className={FIELD_LABEL_CLASS_NAME}>{formatMessage({ id: "machine.detail.bulkModel.reasoning" })}</div>
                    <RuntimeSelectControl
                      value={reasoning ?? REASONING_DEFAULT_VALUE}
                      onValueChange={handleReasoningChange}
                      options={reasoningOptions}
                      placeholder={formatMessage({ id: "machine.detail.bulkModel.reasoningDefault" })}
                      testId="bulk-model-reasoning"
                    />
                  </div>
                )}
              </>
            )}
            <DialogCardFooter>
              <Button size="lg" variant="ghost" type="button" onClick={handleClose}>
                {formatMessage({ id: "common.confirm.cancel" })}
              </Button>
              <DialogCommit>
                {(inHead) => (
                  <Button
                    size={inHead ? "md" : "lg"}
                    variant="primary"
                    type="button"
                    onClick={handleNext}
                    disabled={nextDisabled}
                    data-testid="bulk-model-next"
                  >
                    {checkingRuntime && <Spinner size="xs" aria-label={formatMessage({ id: "common.loadingLabel" })} />}
                    {formatMessage({ id: "machine.detail.bulkModel.next" })}
                  </Button>
                )}
              </DialogCommit>
            </DialogCardFooter>
          </div>
        )}

        {step === "review" && (
          <div>
            <ul className="rule-y rule-line-hairline border-y border-line-hairline" data-testid="bulk-model-review-list">
              {plan.rows.map((row) => {
                const agent = agentById.get(row.agentId)!;
                const sameRuntime = agent.runtime === runtime;
                const from = formatBulkModelLabel(agent.runtime, agent.model, !sameRuntime);
                const to = formatBulkModelLabel(runtime, model, !sameRuntime);
                const skipped = row.kind === "skip";
                return (
                  <li
                    key={row.agentId}
                    className={`flex min-w-0 items-center gap-2 py-2 text-callout ${skipped ? "text-foreground-hint" : ""}`}
                    data-testid={`bulk-model-row-${row.agentId}`}
                    data-row-kind={row.kind}
                  >
                    <AvatarSlot context="compact-list" type="agent" agentAvatarUrl={agent.avatarUrl} />
                    <span className="w-24 shrink-0 truncate font-semibold text-foreground" title={agent.displayName ?? agent.name}>
                      {agent.displayName ?? agent.name}
                    </span>
                    <span className="flex min-w-0 flex-1 items-center gap-1.5 font-mono text-mono-meta">
                      {row.kind === "restartOnly" ? (
                        <span className="truncate text-foreground">{to}</span>
                      ) : (
                        <>
                          <span className="truncate text-foreground-hint">{from}</span>
                          <ArrowRight size={12} className="shrink-0 text-foreground-muted" aria-hidden />
                          {skipped
                            ? <s className="truncate">{to}</s>
                            : <span className="truncate text-foreground">{to}</span>}
                        </>
                      )}
                    </span>
                    {skipped && (
                      <span className="flex shrink-0 items-center gap-1 text-caption text-warning-strong">
                        {formatMessage({ id: SKIP_REASON_MESSAGE[row.reason] })}
                        {row.reason !== "noChange" && (
                          <EditAgentLink agentId={row.agentId} onOpenAgent={onOpenAgent} />
                        )}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
            {plan.runningChangeCount > 0 && (
              <label className="mt-3 flex select-none items-center gap-2">
                <Checkbox checked={restartNow} onCheckedChange={setRestartNow} data-testid="bulk-model-restart-now" />
                <span className="text-callout font-semibold">{formatMessage({ id: "machine.detail.bulkModel.restartNow" })}</span>
              </label>
            )}
            {!restartNow && plan.runningChangeCount > 0 && (
              <p className="mt-3 text-footnote text-foreground-muted" data-testid="bulk-model-idle-line">
                {formatMessage({ id: "machine.detail.bulkModel.idleLine" }, { count: plan.runningChangeCount })}
              </p>
            )}
            {plan.restartCount > 0 && (
              <p className="mt-3 text-footnote text-foreground-muted" data-testid="bulk-model-restart-line">
                {formatMessage({ id: "machine.detail.bulkModel.restartLine" }, { count: plan.restartCount })}
              </p>
            )}
            <div className="mt-4 flex items-center gap-2">
              <Button size="lg" variant="outline" type="button" onClick={backToChoose}>
                {formatMessage({ id: "machine.detail.bulkModel.back" })}
              </Button>
              <span className="flex-1" />
              <DialogCancel>
                <Button size="lg" variant="ghost" type="button" onClick={handleClose}>
                  {formatMessage({ id: "common.confirm.cancel" })}
                </Button>
              </DialogCancel>
              <DialogCommit>
                {(inHead) => (
                  <Button
                    size={inHead ? "md" : "lg"}
                    variant="accent"
                    type="button"
                    onClick={handleApply}
                    disabled={plan.applyCount === 0}
                    data-testid="bulk-model-apply"
                  >
                    {formatMessage({ id: "machine.detail.bulkModel.apply" }, { count: plan.applyCount })}
                  </Button>
                )}
              </DialogCommit>
            </div>
          </div>
        )}

        {step === "applying" && (
          <ul className="rule-y rule-line-hairline" data-testid="bulk-model-applying-list">
            {plan.rows.filter((row) => row.kind !== "skip").map((row) => {
              const agent = agentById.get(row.agentId)!;
              const state = applyStates[row.agentId] ?? "saving";
              return (
                <li key={row.agentId} className="flex items-center gap-2 py-2 text-callout">
                  <AvatarSlot context="compact-list" type="agent" agentAvatarUrl={agent.avatarUrl} />
                  <span className="flex-1 truncate font-semibold text-foreground">{agent.displayName ?? agent.name}</span>
                  <span className="flex items-center gap-1 text-caption text-foreground-muted" data-testid={`bulk-model-apply-${row.agentId}`} data-apply-state={state}>
                    {state === "saving" && <Spinner size="xs" aria-label={formatMessage({ id: "common.loadingLabel" })} />}
                    {state === "saved" && <Check size={14} className="text-foreground" aria-hidden />}
                    {state === "failed" && <X size={14} className="text-warning-strong" aria-hidden />}
                    {formatMessage({ id: APPLY_STATE_MESSAGE[state] })}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </StepBody>
    </DialogCard>
  );
}
