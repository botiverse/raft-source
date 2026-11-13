import type { ChangeEvent, MouseEvent } from "react";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { useIntl } from "react-intl";
import { Button, Card, Input, ScrollArea, SegmentedControl, SegmentedControlCount, SegmentedControlItem, SegmentedControlLabel } from "@botiverse/raft-ui";
import { RAFTBENCH_PATTERN_KINDS } from "@botiverse/raft-shared";
import type { RaftbenchPatternKind, RaftbenchReport, HostedAgentModelView } from "@botiverse/raft-shared";
import api from "../api/client";
import { useAppNavigate } from "../hooks/useAppNavigate";
import { useServerStore } from "../store/serverStore";
import Banner from "../components/ui/Banner";
import { EvidenceChip } from "./EvidenceChip";
import { parseEvidenceTarget } from "./evidenceTarget";
import { useAuthStore } from "../store/authStore";
import ReaderAccess from "./ReaderAccess";
import { canUseRaftBench } from "./access";

type FindingFeedback = { evidenceAt?: string; id: string; version: string; value: "agree" | "inaccurate" | null };
type Dashboard = {
  findingFeedback?: FindingFeedback[];
  findingIndex?: { kindCounts: Record<RaftbenchPatternKind, number> };
  historyFrom?: string | null;
  // `streams` and `run.sourceKind` come from servers that read thread replies separately; older servers omit them.
  progress?: { readMessages: number; completedBatches: number; scannedThroughAt: string | null; streams?: Partial<Record<"channel" | "thread", { readMessages: number; scannedThroughAt: string | null }>> };
  // First-pass triage (staging); null while RaftBench is off, absent on older servers.
  triage?: { state: "off" | "no_key" | "running" | "idle" | "budget_exhausted"; triagedMessages: number; labeledMessages: number; runningBatches: number; todayTokens: number; dailyTokenLimit: number } | null;
  coverage?: { totalMessages: number; windowMessages: number; earliestAt: string | null; latestAt: string | null; from: string; to: string; checkedAt: string } | null;
  enabled: boolean; revision: number; channelIds: string[]; agentId: string | null;
  provisioning: { state: string; error: string | null; profile: string | null } | null;
  intervalMinutes: number;
  run: { runId: string; status: string; from: string; to: string; updatedAt: string; fetchedMessages: number; skippedRanges?: Array<{ from: string; to: string; messages: number | null }>; stopReason: string; sourceKind?: "channel" | "thread"; failureCount?: number; unreadRetries?: Partial<Record<"channel" | "thread", { failures: number; reason: string | null }>>; exhausted: boolean; failureReason: string | null; report: Pick<RaftbenchReport, "status" | "reason" | "gaps" | "patterns"> | null } | null;
  pagination: { page: number; pageCount: number; total: number; pageSize: number };
};
type Option = { value: string; label: string };
// The All view groups findings by kind; each group pages through its own kind so every finding stays reachable.
type Group = { patterns: RaftbenchReport["patterns"]; feedback: FindingFeedback[]; total: number };
type Groups = Partial<Record<RaftbenchPatternKind, Group>>;
type ServiceAgent = { agentId: string; name: string; state: string | null; ready: boolean };
// Load and save failures are kept apart so a failed save does not read as a broken page, and vice versa.
type View = { data: Dashboard | null; loading: boolean; saving: boolean; loadError: string | null; saveError: string | null };
const initial: View = { data: null, loading: true, saving: false, loadError: null, saveError: null };
// A diagnostic code safe to show on the page: the HTTP status or the transport failure, never the response body or headers.
const errorCode = (error: unknown) => { const failure = error as { response?: { status?: number }; code?: string }; return failure.response?.status ? `HTTP ${failure.response.status}` : failure.code === "ECONNABORTED" || failure.code === "ETIMEDOUT" ? "TIMEOUT" : failure.code === "ERR_NETWORK" ? "NETWORK" : "UNKNOWN"; };
const statusKeys = { stale: "raftbench.aiStale", queued: "raftbench.aiQueued", running: "raftbench.aiReading", ready: "raftbench.aiReady", partial: "raftbench.aiPartial", failed: "raftbench.aiFailed" } as const;
const kindKeys = { repeated_clarification: "raftbench.aiClarification", repeated_attempt: "raftbench.aiRepeated", unsupported_completion: "raftbench.aiUnsupported", successful_practice: "raftbench.aiSuccessful" } as const;

function ErrorLine({ id, code }: { id: "raftbench.aiLoadError" | "raftbench.aiSaveError"; code: string }) {
  const { formatMessage: t } = useIntl();
  return <div role="alert" className="mt-3 text-danger-strong"><p>{t({ id }, { code })}</p>{(code === "HTTP 401" || code === "HTTP 403") && <p className="mt-1 text-caption">{t({ id: code === "HTTP 401" ? "raftbench.aiErrorSignIn" : "raftbench.aiErrorAccess" })}</p>}</div>;
}

export default function HostedAnalysis({ allowed, options, onEnabled, channelId = null }: { allowed: boolean; options: Option[]; onEnabled: (value: boolean) => void; channelId?: string | null }) {
  const { formatMessage: t, formatDate, formatTime, formatNumber } = useIntl();
  const server = useServerStore(s => s.current), epoch = useServerStore(s => s.serverEpoch), principal = useAuthStore(s => s.user?.id ?? null);
  const nav = useAppNavigate();
  const [view, update] = useReducer((state: View, patch: Partial<View>) => ({ ...state, ...patch }), initial);
  const [feedbackSaving, setFeedbackSaving] = useState<string | null>(null);
  const [feedbackError, setFeedbackError] = useState(false);
  const feedbackRequest = useRef<AbortController | null>(null);
  useEffect(() => { setFeedbackSaving(null); setFeedbackError(false); return () => { feedbackRequest.current?.abort(); }; }, [server?.id, epoch, principal]);
  const [page, setPage] = useState(1);
  const [period, setPeriod] = useState<"recent" | "history">("recent");
  const [kind, setKind] = useState<RaftbenchPatternKind | null>(null);
  const [groups, setGroups] = useState<Groups | null>(null);
  const [groupsUnavailable, setGroupsUnavailable] = useState(false);
  const [groupPages, setGroupPages] = useState<Partial<Record<RaftbenchPatternKind, number>>>({});
  const [model, setModel] = useState<{ agentId: string; label: string | null } | null>(null);
  const [serviceAgents, setServiceAgents] = useState<ServiceAgent[]>([]);
  const [selection, select] = useState<string[] | null>(null);
  const [historyDate, setHistoryDate] = useState<string | null>(null);
  useEffect(() => { select(null); setHistoryDate(null); setServiceAgents([]); }, [server?.id, epoch, principal]);
  const pending = useRef<AbortController | null>(null);
  const mutation = useRef<AbortController | null>(null);
  const saving = useRef(false);
  const reading = useRef(false);
  const current = useCallback(() => allowed && useServerStore.getState().current?.id === server?.id && useServerStore.getState().serverEpoch === epoch && useAuthStore.getState().user?.id === principal && canUseRaftBench(useServerStore.getState().current?.role), [allowed, server?.id, epoch, principal]);
  const load = useCallback(async () => {
    if (!current() || !server || saving.current || reading.current) return;
    pending.current?.abort(); const controller = new AbortController(); pending.current = controller; reading.current = true;
    try {
      const { data } = await api.get<Dashboard>("/raftbench", { params: { page, period, ...(kind ? { kind } : {}), ...(channelId ? { channelId } : {}) }, signal: controller.signal, headers: { "X-Server-Id": server.id } });
      let grouped: Groups | null = null, groupFailed = false;
      const counts = data.findingIndex?.kindCounts;
      const kinds = counts ? RAFTBENCH_PATTERN_KINDS.filter(value => counts[value] > 0) : [];
      if (!kind && data.enabled && counts && kinds.length) {
        // A failed group fetch falls back to the flat paged list instead of failing the whole page.
        try {
          const pages = await Promise.all(kinds.map(value => Promise.all(Array.from({ length: groupPages[value] ?? 1 }, (_, index) => api.get<Dashboard>("/raftbench", { params: { page: index + 1, period, kind: value, ...(channelId ? { channelId } : {}) }, signal: controller.signal, headers: { "X-Server-Id": server.id } }).then(response => response.data)))));
          grouped = Object.fromEntries(kinds.map((value, index) => [value, { patterns: pages[index].flatMap(page => page.run?.report?.patterns ?? []), feedback: pages[index].flatMap(page => page.findingFeedback ?? []), total: pages[index][0]?.pagination.total ?? counts[value] }]));
        } catch { groupFailed = true; }
      }
      if (!controller.signal.aborted && current()) { update({ data, loading: false, loadError: null }); setGroups(grouped); setGroupsUnavailable(groupFailed); onEnabled(data.enabled); }
      try {
        const { data: listed } = await api.get<{ agents: ServiceAgent[] }>("/raftbench/agents", { signal: controller.signal, headers: { "X-Server-Id": server.id } });
        if (!controller.signal.aborted && current()) setServiceAgents(listed.agents ?? []);
      } catch { if (!controller.signal.aborted && current()) setServiceAgents([]); }
    } catch (error) {
      if (!controller.signal.aborted && current()) { update({ data: null, loading: false, loadError: errorCode(error) }); onEnabled(false); }
    } finally { if (pending.current === controller) reading.current = false; }
  }, [current, server, page, kind, period, channelId, groupPages, onEnabled]);
  useEffect(() => {
    void load(); const timer = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, 5000);
    return () => { window.clearInterval(timer); pending.current?.abort(); reading.current = false; mutation.current?.abort(); };
  }, [load]);
  const data = allowed ? view.data : null;
  const agentId = data?.enabled && data.provisioning?.state === "active" ? data.agentId : null;
  useEffect(() => {
    if (!agentId || !current()) return;
    const controller = new AbortController();
    const read = async () => {
      try {
        const { data: value } = await api.get<HostedAgentModelView>(`/agents/${agentId}/hosted-runtime/model`, { signal: controller.signal });
        if (!controller.signal.aborted && current()) setModel({ agentId, label: value.label ?? value.model ?? value.defaultLabel ?? value.default });
      } catch { if (!controller.signal.aborted && current()) setModel({ agentId, label: null }); }
    };
    void read(); const timer = window.setInterval(() => { void read(); }, 60_000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [agentId, current]);
  const selected = selection ?? (data?.channelIds.length ? data.channelIds : options.slice(0, 50).map(o => o.value));
  const dateValue = historyDate ?? data?.historyFrom?.slice(0, 10) ?? new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
  const invalidHistory = historyDate !== null && (!historyDate || !Number.isFinite(Date.parse(`${historyDate}T00:00:00Z`)) || Date.parse(`${historyDate}T00:00:00Z`) >= Date.now());
  const createServiceAgent = useCallback(async () => {
    if (!current() || !server || view.saving) return;
    saving.current = true; update({ saving: true, saveError: null });
    try {
      await api.post("/raftbench/agents", {}, { headers: { "X-Server-Id": server.id } });
    } catch (error) { if (current()) update({ saveError: errorCode(error) }); }
    finally { saving.current = false; if (current()) { update({ saving: false }); void load(); } }
  }, [current, server, view.saving, load]);
  const assignAgent = useCallback(async (agentId: string) => {
    if (!current() || !server || !data || view.saving || !selected.length || invalidHistory || (data.revision > 0 && (selection !== null || historyDate !== null))) return;
    saving.current = true; update({ saving: true, saveError: null });
    try {
      await api.put("/raftbench/assignment", { agentId, expectedRevision: data.revision, ...(data.revision === 0 ? { channelIds: selected, historyFrom: new Date(`${dateValue}T00:00:00Z`).toISOString() } : {}) }, { headers: { "X-Server-Id": server.id } });
      setPage(1); onEnabled(true);
    } catch (error) { if (current()) update({ saveError: errorCode(error) }); }
    finally { saving.current = false; if (current()) { update({ saving: false }); void load(); } }
  }, [current, server, data, view.saving, selected, invalidHistory, selection, historyDate, dateValue, onEnabled, load]);
  const openAgentCard = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    const id = event.currentTarget.dataset.agent;
    if (id) nav.toAgent(id);
  }, [nav]);
  const assignAgentFromCard = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    const id = event.currentTarget.dataset.agent;
    if (id) void assignAgent(id);
  }, [assignAgent]);
  const save = useCallback(async (enabled: boolean, startDate = historyDate) => {
    if (!current() || !data || !server) return;
    saving.current = true;
    update({ saving: true, saveError: null });
    const controller = new AbortController(); pending.current?.abort(); reading.current = false; mutation.current = controller;
    try {
      await api.put("/raftbench", { enabled, channelIds: selected, expectedRevision: data.revision, ...(enabled && startDate ? { historyFrom: new Date(`${startDate}T00:00:00Z`).toISOString() } : {}) }, { signal: controller.signal, headers: { "X-Server-Id": server.id } });
      if (!controller.signal.aborted && current()) { update({ data: { ...data, enabled, run: null } }); select(null); setHistoryDate(null); setPage(1); onEnabled(enabled); saving.current = false; await load(); }
    } catch (error) { if (!controller.signal.aborted && current()) update({ saveError: errorCode(error) }); }
    finally { saving.current = false; if (!controller.signal.aborted && current()) update({ saving: false }); }
  }, [current, data, server, selected, historyDate, onEnabled, load]);
  const toggle = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const id = event.currentTarget.value;
    select(selected.includes(id) ? selected.filter(value => value !== id) : [...selected, id].slice(0, 50));
  }, [selected]);
  const choosePeriod = useCallback((value: "recent" | "history") => {
    if (value === period) return;
    pending.current?.abort(); reading.current = false;
    setPeriod(value); setPage(1); setGroupPages({}); setGroups(null); update({ data: null, loading: true });
  }, [period]);
  const filterKind = useCallback((next: RaftbenchPatternKind | "all") => {
    const value = next === "all" ? null : next;
    if (value === kind) return;
    pending.current?.abort(); reading.current = false;
    setKind(value); setPage(1); setGroupPages({}); setGroups(null); update({ data: null, loading: true });
  }, [kind]);
  const reviewFinding = useCallback(async (event: MouseEvent<HTMLButtonElement>) => {
    const { finding, version, vote, selected: wasSelected } = event.currentTarget.dataset;
    if (!current() || !server || !data || !finding || !version || (vote !== "agree" && vote !== "inaccurate") || feedbackSaving) return;
    const controller = new AbortController(); feedbackRequest.current = controller;
    setFeedbackSaving(finding); setFeedbackError(false);
    try {
      await api.put(`/raftbench/findings/${finding}/feedback`, { revision: data.revision, version, value: wasSelected === "true" ? null : vote }, { signal: controller.signal, headers: { "X-Server-Id": server.id } });
      if (!controller.signal.aborted && current()) await load();
    } catch { if (!controller.signal.aborted && current()) setFeedbackError(true); }
    finally { if (!controller.signal.aborted && current()) setFeedbackSaving(null); }
  }, [current, server, data, feedbackSaving, load]);
  const previous = useCallback(() => setPage(value => Math.max(1, value - 1)), []);
  const next = useCallback(() => setPage(value => value + 1), []);
  const showMore = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    const value = event.currentTarget.dataset.kind as RaftbenchPatternKind | undefined;
    if (value && RAFTBENCH_PATTERN_KINDS.includes(value)) setGroupPages(pages => ({ ...pages, [value]: (pages[value] ?? 1) + 1 }));
  }, []);
  const toggleAnalysis = useCallback(() => { if (data) void save(!data.enabled); }, [data, save]);
  const applySettings = useCallback(() => { void save(true); }, [save]);
  const changeHistory = useCallback((event: ChangeEvent<HTMLInputElement>) => setHistoryDate(event.currentTarget.value), []);
  const chooseHistory = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    const days = Number(event.currentTarget.dataset.days);
    if ([7, 30, 90].includes(days)) setHistoryDate(new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10));
  }, []);
  const changed = selection !== null || historyDate !== null;
  const emptyRange = !!data?.coverage && data.coverage.totalMessages > 0 && data.coverage.windowMessages === 0;
  const availableHistory = data?.coverage?.latestAt?.slice(0, 10);
  const analyzeAvailableHistory = useCallback(() => {
    if (availableHistory) void save(true, availableHistory);
  }, [availableHistory, save]);
  const run = data?.run;
  const streams = data?.progress?.streams;
  const emptyScan = emptyRange && !run?.failureReason && !run?.report?.patterns.length && !data?.progress?.readMessages && !run?.fetchedMessages;
  const noMaterial = !!run?.report && run.fetchedMessages === 0 && !(data?.progress?.readMessages) && !run.failureReason;
  // Progressive scans run in batches; that is an implementation detail, so empty polls and per-batch status stay hidden.
  const progressive = !!data?.progress;
  const emptyPoll = progressive && run?.fetchedMessages === 0 && !run?.failureReason;
  const busy = data?.enabled && data.provisioning?.state !== "failed" && (!run || run.status === "queued" || run.status === "running");
  const stamp = (value: string) => `${formatDate(value)} ${formatTime(value, { hour: "numeric", minute: "2-digit" })}`;
  const renderFinding = (pattern: RaftbenchReport["patterns"][number], index: number, feedback?: FindingFeedback, grouped = false) => (<li key={feedback?.id ?? `legacy-${index}`} className="min-w-0 rounded-container border border-line-hairline p-3">{!grouped && <h3 className="font-semibold">{t({ id: kindKeys[pattern.kind] })}</h3>}<p className={grouped ? "text-caption text-foreground-hint" : "mt-1 text-caption text-foreground-hint"}>{t({ id: "raftbench.findingEvidenceAt" }, { time: feedback?.evidenceAt ? stamp(feedback.evidenceAt) : t({ id: "raftbench.aiUnknown" }) })}</p><p className="mt-1 break-words text-callout">{pattern.explanation}</p>{pattern.evidenceLevel === "insufficient" && <p className="mt-2 text-caption text-foreground-hint">{t({ id: "raftbench.aiInsufficient" })}</p>}{[false, true].map(counter => { const refs = counter ? pattern.counterevidence : pattern.evidence; return refs.length > 0 && <div key={String(counter)} className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5"><span className="text-caption text-foreground-hint">{t({ id: counter ? "raftbench.aiCounterEvidence" : "raftbench.aiEvidence" })}</span>{refs.map(ref => <EvidenceChip key={`${counter}-${ref.target}-${ref.messageId}`} target={ref.target} messageId={ref.messageId} channelId={options.find(option => option.label.replace(/^#/, "") === parseEvidenceTarget(ref.target).channelName)?.value ?? null} />)}</div>; })}{pattern.suggestion && <div className="mt-3 rounded bg-layer-sidebar p-2 text-callout"><p className="font-semibold">{t({ id: "raftbench.aiProposal" })}</p><p className="mt-1 whitespace-pre-wrap break-words">{pattern.suggestion}</p></div>}{feedback && <div className="mt-3 flex flex-wrap gap-2">{(["agree", "inaccurate"] as const).map(value => <Button key={value} size="md" variant="ghost" aria-pressed={feedback.value === value} disabled={!!feedbackSaving} data-finding={feedback.id} data-version={feedback.version} data-vote={value} data-selected={feedback.value === value} onClick={reviewFinding}>{t({ id: value === "agree" ? "raftbench.feedbackAgree" : "raftbench.feedbackInaccurate" })}</Button>)}</div>}</li>);
  return <Card className="min-w-0 overflow-hidden border-line-hairline bg-layer-canvas p-0" data-testid="raftbench-hosted-analysis">
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line-hairline p-4 md:p-5"><h2 className="text-headline">{t({ id: "raftbench.aiTitle" })}</h2>
      <Button onClick={toggleAnalysis} disabled={!allowed || !data || view.saving || (!data.enabled && (!selected.length || invalidHistory))}>{t({ id: view.saving ? "raftbench.aiSaving" : data?.enabled ? "raftbench.aiDisable" : "raftbench.aiEnable" })}</Button>
    </div>
    <div className="p-4 md:p-5">
    {view.loading && <p role="status" className="mt-3">{t({ id: "raftbench.aiLoading" })}</p>}
    {view.loadError && <ErrorLine id="raftbench.aiLoadError" code={view.loadError} />}
    {view.saveError && <ErrorLine id="raftbench.aiSaveError" code={view.saveError} />}
    {data?.enabled && data.triage && <TriageLine triage={data.triage} />}
    {data?.enabled && data.findingIndex && <section className="mb-5" aria-label={t({ id: "raftbench.focusTitle" })} data-testid="raftbench-finding-index">
      <SegmentedControl<"recent" | "history"> className="mb-3" value={period} aria-label={t({ id: "raftbench.findingPeriod" })} onValueChange={choosePeriod}>{(["recent", "history"] as const).map(value => <SegmentedControlItem key={value} value={value} data-testid={`raftbench-period-${value}`}><SegmentedControlLabel>{t({ id: value === "recent" ? "raftbench.findingRecent" : "raftbench.findingHistory" })}</SegmentedControlLabel></SegmentedControlItem>)}</SegmentedControl>
      <p className="mb-3 text-caption text-foreground-hint">{t({ id: "raftbench.findingCoverage" }, { scanned: data.progress?.scannedThroughAt ? stamp(data.progress.scannedThroughAt) : t({ id: "raftbench.aiUnknown" }) })}</p>
      {streams?.channel && streams.thread && <p className="mb-3 text-caption text-foreground-hint" data-testid="raftbench-stream-read">{t({ id: "raftbench.aiStreamRead" }, { channel: streams.channel.readMessages, thread: streams.thread.readMessages })}</p>}
      {/* Kept per stream even while the other stream runs, so a reply failure stays visible after reading moves on to channels. */}
      {(["channel", "thread"] as const).map(stream => { const failures = run?.unreadRetries?.[stream]?.failures ?? 0; return failures > 0 && <p key={stream} className="mb-3 text-caption text-warning-strong" data-testid={`raftbench-stream-retry-${stream}`}>{t({ id: stream === "thread" ? "raftbench.aiStreamRetryThread" : "raftbench.aiStreamRetryChannel" }, { count: failures })}</p>; })}
      <h3 className="text-headline">{t({ id: "raftbench.focusTitle" })}</h3>
      <div className="mt-3 min-w-0"><SegmentedControl<RaftbenchPatternKind | "all"> value={kind ?? "all"} aria-label={t({ id: "raftbench.focusTitle" })} onValueChange={filterKind}>
        <SegmentedControlItem value="all" data-testid="raftbench-kind-all"><SegmentedControlLabel>{t({ id: "raftbench.focusAll" })}</SegmentedControlLabel></SegmentedControlItem>
        {RAFTBENCH_PATTERN_KINDS.map(value => <SegmentedControlItem key={value} value={value} data-testid={`raftbench-kind-${value}`}><SegmentedControlLabel>{t({ id: kindKeys[value] })}</SegmentedControlLabel><SegmentedControlCount>{formatNumber(data.findingIndex!.kindCounts[value])}</SegmentedControlCount></SegmentedControlItem>)}
      </SegmentedControl></div>
    </section>}
    <details className="mt-4"><summary className="cursor-pointer text-callout font-semibold">{t({ id: "raftbench.focusCoverage" })}</summary>
    {data?.enabled && data.progress && data.progress.readMessages > 0 && <div className="mt-4" role="status"><p className="font-semibold">{data.coverage ? t({ id: "raftbench.aiCumulativeRead" }, { count: data.progress.readMessages, total: data.coverage.windowMessages }) : t({ id: "raftbench.aiCumulativeUnknown" }, { count: data.progress.readMessages })}</p><p className="mt-1 text-caption text-foreground-hint">{t({ id: "raftbench.aiProgressiveHelp" })}</p></div>}
    {data?.coverage && <div className="mt-4 rounded-container border border-line-hairline p-3 text-callout" role="status"><p>{t({ id: "raftbench.aiCoverageCounts" }, { total: data.coverage.totalMessages, count: data.coverage.windowMessages })}</p><p className="mt-1 text-caption text-foreground-hint">{data.coverage.latestAt ? t({ id: "raftbench.aiLatestSource" }, { time: stamp(data.coverage.latestAt) }) : t({ id: "raftbench.aiSourceEmpty" })}</p><p className="mt-1 text-caption text-foreground-hint">{t({ id: "raftbench.aiWindow" }, { from: stamp(data.coverage.from), to: stamp(data.coverage.to) })}</p>{emptyRange && <div className="mt-3"><p>{t({ id: "raftbench.aiOutsideWindow" })}</p>{data.enabled && availableHistory && <><p className="mt-2 text-caption text-foreground-hint">{t({ id: "raftbench.aiAvailableHistoryHelp" }, { count: data.coverage.totalMessages })}</p><Button className="mt-3" onClick={analyzeAvailableHistory} disabled={view.saving || changed}>{t({ id: "raftbench.aiAnalyzeAvailableHistory" }, { date: availableHistory })}</Button></>}</div>}</div>}
    {data?.enabled && <p className="mt-2 text-caption text-foreground-hint">{t({ id: "raftbench.aiModel" }, { model: model?.agentId === data.agentId && model.label ? model.label : t({ id: "raftbench.aiUnknown" }) })}</p>}
    {data?.enabled && <p className="mt-3 text-caption text-foreground-hint">{t({ id: "raftbench.aiCadence" }, { count: data.intervalMinutes, sources: data.channelIds.length })}</p>}
    {data?.enabled && data.provisioning?.state === "failed" && <p role="alert" className="mt-3 text-danger-strong">{t({ id: "raftbench.aiProvisionFailed" })}</p>}
    {busy && !emptyScan && <div className="mt-4" role="status" aria-live="polite"><p className="text-callout font-semibold">{t({ id: data?.provisioning?.state === "failed" ? "raftbench.aiProvisionFailed" : data?.provisioning?.state !== "active" ? "raftbench.aiProvisioning" : !run || run.status === "queued" ? "raftbench.aiQueued" : run.stopReason === "more_pages" ? (run.sourceKind === "thread" ? "raftbench.aiReadingReplies" : "raftbench.aiReading") : "raftbench.aiAnalyzing" })}</p><div className="mt-2 h-2 overflow-hidden rounded bg-layer-sidebar" role="progressbar" aria-label={t({ id: "raftbench.aiProgress" })} aria-valuetext={t({ id: data?.progress ? "raftbench.aiBatchReadCount" : "raftbench.aiReadCount" }, { count: run?.fetchedMessages ?? 0 })}><div className="h-full w-1/3 animate-pulse rounded bg-brand" /></div><p className="mt-2 text-caption text-foreground-hint">{t({ id: data?.progress ? "raftbench.aiBatchProgress" : "raftbench.aiReadUnknown" }, { count: run?.fetchedMessages ?? 0 })}</p></div>}
    {run?.skippedRanges && run.skippedRanges.length > 0 && <Banner intent="warning" density="sm" className="mt-3">{run.skippedRanges.map((range, index) => <p key={`${range.from}-${index}`}>{t({ id: "raftbench.aiSkippedWindow" }, { from: stamp(range.from), to: stamp(range.to), count: range.messages === null ? t({ id: "raftbench.aiUnknown" }) : formatNumber(range.messages) })}</p>)}</Banner>}
    </details>
    {run && !emptyScan && <div className="mt-4">{!progressive && <div className="flex flex-wrap justify-between gap-2 text-caption text-foreground-hint"><span>{t({ id: "raftbench.aiWindow" }, { from: stamp(run.from), to: stamp(run.to) })}</span><span>{t({ id: "raftbench.aiReadCount" }, { count: run.fetchedMessages })}</span></div>}
      {!busy && !emptyPoll && !(progressive && run.status === "partial") && (noMaterial || run.status !== "ready") && <p className="mt-3 font-semibold">{t({ id: noMaterial ? "raftbench.aiNoMaterial" : statusKeys[run.status as keyof typeof statusKeys] ?? "raftbench.aiUnknown" })}</p>}
      {run.failureReason && <p role="alert" className="mt-2 text-callout text-warning-strong">{run.failureReason}</p>}
      {run.report?.reason && run.report.reason !== run.failureReason && !emptyPoll && <p className="mt-2 break-words text-callout text-warning-strong">{run.report.reason}</p>}
      {run.report && <>{run.report.patterns.length === 0 && !(groups && Object.keys(groups).length) && <p className="mt-4 text-callout">{t({ id: noMaterial ? "raftbench.aiNoMaterialHelp" : "raftbench.findingPeriodEmpty" })}</p>}
        {feedbackError && <p role="alert" className="mt-3 text-danger-strong">{t({ id: "raftbench.feedbackError" })}</p>}
        {groupsUnavailable && <p role="status" className="mt-3 text-caption text-foreground-hint">{t({ id: "raftbench.groupUnavailable" })}</p>}
        {groups ? <div className="mt-3 stack-y-5" data-testid="raftbench-finding-groups">{RAFTBENCH_PATTERN_KINDS.map(value => { const group = groups[value]; return group && group.patterns.length > 0 && <section key={value} aria-label={t({ id: kindKeys[value] })} data-testid={`raftbench-group-${value}`}><h3 className="flex items-baseline gap-2 font-semibold"><span>{t({ id: kindKeys[value] })}</span><span className="text-callout text-foreground-hint">{formatNumber(group.total)}</span></h3><ol className="mt-2 stack-y-3">{group.patterns.map((pattern, index) => renderFinding(pattern, index, group.feedback[index], true))}</ol>{group.patterns.length < group.total && <Button className="mt-2" size="md" variant="ghost" data-kind={value} onClick={showMore}>{t({ id: "raftbench.groupMore" }, { count: group.total - group.patterns.length })}</Button>}</section>; })}</div>
        : <ol className="mt-3 stack-y-3">{run.report.patterns.map((pattern, index) => renderFinding(pattern, index, data.findingFeedback?.[index]))}</ol>}
        <p className="mt-3 text-caption text-foreground-hint">{t({ id: "raftbench.aiLimits" })}</p>
        {!groups && <nav className="mt-4 flex flex-wrap items-center justify-between gap-3" aria-label={t({ id: "raftbench.aiPages" })}><Button disabled={data.pagination.page <= 1 || data.pagination.page !== page} onClick={previous}>{t({ id: "raftbench.aiPrevious" })}</Button><span className="text-callout">{t({ id: "raftbench.aiPage" }, { page: formatNumber(data.pagination.page), total: formatNumber(data.pagination.pageCount), count: data.pagination.total })}</span><Button disabled={data.pagination.page >= data.pagination.pageCount || data.pagination.page !== page} onClick={next}>{t({ id: "raftbench.aiNext" })}</Button></nav>}</>}
    </div>}
    {data && <details className="mt-4 rounded-container border border-line-hairline p-3" open={!data.agentId}>
      <summary className="cursor-pointer font-semibold">{t({ id: "raftbench.agentCardTitle" })}</summary>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2"><p className="text-caption text-foreground-hint">{t({ id: "raftbench.agentCardHelp" })}</p><Button size="md" onClick={createServiceAgent} disabled={view.saving}>{t({ id: "raftbench.createServiceAgent" })}</Button></div>
      {serviceAgents.length > 0 && <ul className="mt-3 stack-y-2">{serviceAgents.map(agent => <li key={agent.agentId} className="flex flex-wrap items-center justify-between gap-2 rounded border border-line-hairline p-2 text-callout"><div><button className="font-semibold underline" data-agent={agent.agentId} onClick={openAgentCard}>{agent.name}</button><p className="text-caption text-foreground-hint">{data.agentId === agent.agentId ? t({ id: "raftbench.assignedAgent" }) : agent.ready ? t({ id: "raftbench.agentReady" }) : t({ id: "raftbench.agentProvisioning" })}</p></div>{data.agentId !== agent.agentId && <Button size="md" data-agent={agent.agentId} disabled={!agent.ready || view.saving || !selected.length || invalidHistory || (data.revision > 0 && (selection !== null || historyDate !== null))} onClick={assignAgentFromCard}>{t({ id: "raftbench.assignAgent" })}</Button>}</li>)}</ul>}
      <p className="mt-2 text-caption text-foreground-hint">{t({ id: "raftbench.computerComing" })}</p>
    </details>}
    {server && <ReaderAccess key={`${server.id}:${useAuthStore.getState().user?.id}`} serverId={server.id} enabled={!!data?.enabled} />}
    {/* The sources list scrolls in a raft-ui ScrollArea: no tab stop (each box is one), and a scroll at its end carries on to the page. */}
    <details className="mt-4" open={!data?.enabled}><summary className="cursor-pointer text-callout font-semibold">{t({ id: "raftbench.aiSettings" })}</summary><fieldset className="mt-3" disabled={view.saving}><legend className="text-callout font-semibold">{t({ id: "raftbench.aiSources" })}</legend><p className="mt-1 text-caption text-foreground-hint">{t({ id: "raftbench.aiConsent" })}</p><p className="mt-1 text-caption text-foreground-hint">{t({ id: "raftbench.aiRuntime" })}</p><ScrollArea tabIndex={-1} overscroll="auto" className="mt-2 max-h-44" contentClassName="grid grid-cols-1 gap-2 sm:grid-cols-2">{options.map(option => <label key={option.value} className="flex min-w-0 items-center gap-2 text-callout"><input type="checkbox" checked={selected.includes(option.value)} value={option.value} onChange={toggle} /><span className="truncate">{option.label}</span></label>)}</ScrollArea>
      <div className="mt-4"><label htmlFor="raftbench-history-from" className="block text-callout font-semibold">{t({ id: "raftbench.aiHistoryFrom" })}</label><Input id="raftbench-history-from" className="mt-2 w-full sm:w-auto" type="date" value={dateValue} max={new Date().toISOString().slice(0, 10)} onChange={changeHistory} /><div className="mt-2 flex flex-wrap gap-2">{[7, 30, 90].map(days => <Button key={days} size="md" data-days={days} onClick={chooseHistory}>{t({ id: "raftbench.aiHistoryDays" }, { days })}</Button>)}</div><p className="mt-2 text-caption text-foreground-hint">{t({ id: "raftbench.aiHistoryHelp" })}</p></div>
      {data?.enabled && changed && <Button className="mt-3" onClick={applySettings} disabled={!selected.length || invalidHistory}>{t({ id: "raftbench.aiApplyScope" })}</Button>}
    </fieldset></details>
    </div>
  </Card>;
}

// "off" and "no_key" both mean nothing is being labeled, so they read as not enabled rather than as progress.
function TriageLine({ triage }: { triage: NonNullable<Dashboard["triage"]> }) {
  const { formatMessage: t } = useIntl();
  const usage = triage.dailyTokenLimit > 0 ? Math.min(100, Math.round(triage.todayTokens / triage.dailyTokenLimit * 100)) : 0;
  if (triage.state === "off" || triage.state === "no_key") return <p className="mt-3 text-caption text-foreground-hint" data-testid="raftbench-triage" data-state={triage.state}>{t({ id: "raftbench.triageOff" })}</p>;
  if (triage.state === "budget_exhausted") return <p className="mt-3 text-caption text-warning-strong" data-testid="raftbench-triage" data-state={triage.state}>{t({ id: "raftbench.triageBudget" }, { triaged: triage.triagedMessages, labeled: triage.labeledMessages })}</p>;
  return <p className="mt-3 text-caption text-foreground-hint" data-testid="raftbench-triage" data-state={triage.state}>{t({ id: triage.state === "running" ? "raftbench.triageRunning" : "raftbench.triageIdle" }, { triaged: triage.triagedMessages, labeled: triage.labeledMessages, usage })}</p>;
}
