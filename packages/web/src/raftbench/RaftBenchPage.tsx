import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { BenchIcon } from "./BenchIcon";
import PanelHeader from "../components/ui/PanelHeader";
import type { ChangeEvent, MouseEvent } from "react";
import { useIntl } from "react-intl";
import { useNavigate } from "react-router-dom";
import { useAppNavigate, useMobileBack } from "../hooks/useAppNavigate";
import {
  Badge,
  Panel,
  Button,
  Card,
  Input,
  Select,
  SelectContent,
  SelectIcon,
  SelectItem,
  SelectItemIndicator,
  SelectItemText,
  SelectList,
  SelectTrigger,
  SelectValue,
  ScrollArea,
  Separator,
  Status,
  Textarea,
} from "@botiverse/raft-ui";
import { useServerStore } from "../store/serverStore";
import { useAuthStore } from "../store/authStore";
import {
  RAFTBENCH_OVERVIEW_FLAG_KEY,
  useServerFeatureFlag,
  refreshServerFeatureFlags,
} from "../store/serverFeatureFlags";
import { useChannelStore } from "../store/channelStore";
import HostedAnalysis from "./HostedAnalysis";
import ManagerOverview from "./ManagerOverview";
import { canUseRaftBench, isRaftBenchChannel } from "./access";
import { evaluateMessages, RULE_VERSION } from "./model";
import type { ReviewLabel, SignalKind } from "./model";
import {
  loadChannelSnapshots,
  OVERVIEW_CHANNEL_LIMIT as MAX_CHANNELS,
} from "./liveMessages";
import type { OverviewSnapshot } from "./liveMessages";

const WORKSPACE_SCOPE = "workspace";
// Cards are the raft-ui Card surface; only spacing is set here.
const PANEL = "p-4 md:p-5";
// A highlight is a soft wash with ink type and no edge (DS rule 3).
const WARNING_PANEL = `${PANEL} border-transparent bg-warning-soft`;
// Selected item in a content list / applied filter (DS: cyan-soft).
const SELECTED_CLASS = "bg-info-soft hover:bg-info-soft";
const signalTone = {
  frustration: "bg-warning-soft",
  negative: "bg-danger-soft",
  repetition: "bg-info-soft",
} as const;
const signalPixel = {
  frustration: "warning",
  negative: "danger",
  repetition: "information",
} as const;
const signalBadge = {
  frustration: "warning",
  negative: "danger",
  repetition: "information",
} as const;
const labels = {
  frustration: "raftbench.frustration",
  negative: "raftbench.negative",
  repetition: "raftbench.repetition",
} as const;
const rules = {
  frustration: "raftbench.frustrationRule",
  negative: "raftbench.negativeRule",
  repetition: "raftbench.repetitionRule",
} as const;
interface Review {
  status: ReviewLabel;
  note: string;
}
const UNREVIEWED: Review = { status: "needs_review", note: "" };
interface ViewState {
  snapshotState: { scopeKey: string; value: OverviewSnapshot } | null;
  loading: boolean;
  failed: boolean;
  selected: string;
  reviews: Record<string, Review>;
}

/** Rendered behind ServerResolver: normal human login, selected server and channel ACL. */
export default function RaftBenchPage() {
  const { formatMessage: t } = useIntl();
  const server = useServerStore((s) => s.current);
  const principalId = useAuthStore((s) => s.user?.id ?? null);
  const { state: flagState } = useServerFeatureFlag(RAFTBENCH_OVERVIEW_FLAG_KEY);
  const epoch = useServerStore((s) => s.serverEpoch);
  const flagScope = JSON.stringify([server?.id, principalId, server?.role, epoch]);
  const [confirmedFlag, setConfirmedFlag] = useState({ scope: "", enabled: false });
  const lastRefresh = useRef(0);
  useEffect(() => {
    if (flagState === "enabled" || flagState === "disabled") {
      // Last successful authorization is historical state: an undetermined response
      // cannot reconstruct it. Scope changes never inherit this cached grant.
      // oxlint-disable-next-line react-doctor/no-derived-state
      setConfirmedFlag({ scope: flagScope, enabled: flagState === "enabled" });
    }
  }, [flagState, flagScope]);
  const enabled = flagState === "enabled" ||
    (flagState === "undetermined" && confirmedFlag.scope === flagScope && confirmedFlag.enabled);
  useEffect(() => {
    if (!server || !canUseRaftBench(server.role)) return;
    const refresh = () => {
      const now = Date.now();
      if (document.visibilityState !== "visible" || now - lastRefresh.current < 1000) return;
      lastRefresh.current = now;
      void refreshServerFeatureFlags(server.id);
    };
    const timer = window.setInterval(refresh, 30_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [server]);
  if (!canUseRaftBench(server?.role))
    return <RaftBenchGate title={t({ id: "raftbench.adminOnly" })} help={t({ id: "raftbench.adminOnlyHelp" })} />;
  if (!enabled)
    return <RaftBenchGate title={t({ id: "raftbench.notEnabled" })} help={t({ id: "raftbench.notEnabledHelp" })} />;
  return (
    <RaftBenchAdminPage
      key={flagScope}
      analysisAllowed={flagState === "enabled"}
    />
  );
}

/** The page in front of RaftBench when it is not open to this person or not
 *  enabled. On a phone it is a pushed page like any other, so it has Back
 *  (Raft DS › Navigation: a gate page is no dead end). Wider screens keep the
 *  bare card. */
function RaftBenchGate({ title, help }: { title: string; help: string }) {
  const { formatMessage: t } = useIntl();
  const slug = useServerStore((s) => s.current?.slug);
  const back = useMobileBack(slug ? `/s/${slug}/settings` : "/");
  const backProps = useMemo(
    () => ({ "aria-label": t({ id: "raftbench.back" }), "data-testid": "raftbench-gate-back" }),
    [t],
  );
  return (
    <main className="flex min-h-0 flex-1 flex-col bg-layer-canvas text-foreground">
      <PanelHeader
        title={t({ id: "raftbench.nav" })}
        onMobileBack={back}
        mobileBackProps={backProps}
        containerProps={GATE_HEADER_PROPS}
      />
      <ScrollArea role="region" aria-label={t({ id: "raftbench.nav" })} className="min-h-0 flex-1" contentClassName="p-6">
        <Card className={PANEL}>
          <h1 className="text-title">{title}</h1>
          <p className="mt-2 text-callout text-foreground-muted">{help}</p>
        </Card>
      </ScrollArea>
    </main>
  );
}
const GATE_HEADER_PROPS = { className: "md:hidden" };

function RaftBenchAdminPage({ analysisAllowed }: { analysisAllowed: boolean }) {
  const { formatMessage: t, formatDate, formatTime } = useIntl();
  const navigate = useNavigate();
  const appNav = useAppNavigate();
  const server = useServerStore((s) => s.current);
  const principalId = useAuthStore((s) => s.user?.id ?? null);
  const serverEpoch = useServerStore((s) => s.serverEpoch);
  const channels = useChannelStore((s) => s.channels);
  const loadChannels = useChannelStore((s) => s.loadChannels);
  const [consented, setConsented] = useState(false);
  const [chosenChannelId, setChannelId] = useState(WORKSPACE_SCOPE);
  const [drillChannelId, setDrillChannelId] = useState("");
  const membershipKey = JSON.stringify(
    channels
      .filter(isRaftBenchChannel)
      .map((c) => c.id)
      .sort(),
  );
  const channelId =
    chosenChannelId === WORKSPACE_SCOPE
      ? WORKSPACE_SCOPE
      : channels.some((c) => c.id === chosenChannelId && isRaftBenchChannel(c))
        ? chosenChannelId
        : "";
  const [view, updateView] = useReducer(
    (current: ViewState, patch: Partial<ViewState>): ViewState => ({
      ...current,
      ...patch,
    }),
    {
      snapshotState: null,
      loading: false,
      failed: false,
      selected: "",
      reviews: {},
    },
  );
  const { snapshotState, loading, failed, selected, reviews } = view;
  const scopeKey = JSON.stringify([
    principalId,
    server?.id,
    serverEpoch,
    channelId,
    membershipKey,
    consented,
  ]);
  const managerScopeKey = JSON.stringify([principalId, server?.id, serverEpoch, channelId, membershipKey]);
  const snapshot =
    snapshotState?.scopeKey === scopeKey ? snapshotState.value : null;
  const [minimum, setMinimum] = useState(3),
    [filter, setFilter] = useState<"all" | SignalKind>("all");
  const pending = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const options = useMemo(
    () =>
      channels
        .filter(isRaftBenchChannel)
        .map((c) => ({
          value: c.id,
          label: c.name,
          unjoinedPublic: c.type === "channel" && c.joined === false,
        })),
    [channels],
  );
  useEffect(() => {
    void loadChannels();
  }, [loadChannels, server?.id]);
  const abortPending = useCallback(() => {
    pending.current?.abort();
  }, []);
  useEffect(() => {
    generation.current++;
    pending.current?.abort();
    updateView({
      snapshotState: null,
      reviews: {},
      selected: "",
      failed: false,
      loading: false,
    });
    return abortPending;
  }, [
    channelId,
    principalId,
    server?.id,
    serverEpoch,
    membershipKey,
    consented,
    abortPending,
  ]);
  const evaluation = useMemo(
    () => evaluateMessages(snapshot?.messages ?? [], minimum),
    [snapshot, minimum],
  );
  const findings = evaluation.findings.filter(
    (f) =>
      (filter === "all" || f.kind === filter) &&
      (!drillChannelId || f.evidence[0].channelId === drillChannelId),
  );
  const finding = findings.find((f) => f.id === selected) ?? findings[0];
  const review = finding ? (reviews[finding.id] ?? UNREVIEWED) : null;
  const evidenceIds = new Set(finding?.evidence.map((e) => e.id));
  const start = finding ? Date.parse(finding.evidence[0].createdAt) : 0;
  const end = finding ? Date.parse(finding.evidence.at(-1)!.createdAt) : 0;
  const nearby =
    snapshot?.messages
      .filter(
        (m) =>
          m.channelId === finding?.evidence[0].channelId &&
          !evidenceIds.has(m.id) &&
          Date.parse(m.createdAt) >= start - 120_000 &&
          Date.parse(m.createdAt) <= end + 120_000,
      )
      .slice(0, 4) ?? [];
  const evidence = [...(finding?.evidence ?? []), ...nearby].sort(
    (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
  );
  const analyze = useCallback(async () => {
    if (
      !consented ||
      !analysisAllowed ||
      !server ||
      !channelId ||
      !principalId ||
      !canUseRaftBench(server.role)
    )
      return;
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    const currentGeneration = ++generation.current;
    // This route can cold-load before the message-page principal is initialized.
    // Fence this local snapshot against the actual Web auth/server stores instead.
    const isContextCurrent = () => {
      const current = useServerStore.getState();
      return useAuthStore.getState().user?.id === principalId &&
        current.current?.id === server.id &&
        current.serverEpoch === serverEpoch &&
        canUseRaftBench(current.current?.role);
    };
    updateView({
      loading: true,
      failed: false,
      snapshotState: null,
      reviews: {},
      selected: "",
    });
    try {
      const activity = useChannelStore.getState().channelActivity;
      const targets =
        channelId === WORKSPACE_SCOPE
          ? [...options]
              .sort(
                (a, b) =>
                  (activity[b.value] ?? "").localeCompare(
                    activity[a.value] ?? "",
                  ) || a.value.localeCompare(b.value),
              )
              .slice(0, MAX_CHANNELS)
              .map((o) => o.value)
          : [channelId];
      const result = await loadChannelSnapshots(
        targets,
        server.id,
        controller.signal,
      );
      if (
        controller.signal.aborted ||
        currentGeneration !== generation.current ||
        !isContextCurrent()
      )
        return;
      updateView({ snapshotState: { scopeKey, value: result } });
    } catch {
      if (
        !controller.signal.aborted &&
        currentGeneration === generation.current &&
        isContextCurrent()
      )
        updateView({ failed: true });
    } finally {
      if (
        !controller.signal.aborted &&
        currentGeneration === generation.current
      )
        updateView({ loading: false });
    }
  }, [server, serverEpoch, channelId, principalId, scopeKey, options, consented, analysisAllowed]);
  const updateReview = useCallback(
    (change: Partial<Review>) => {
      if (finding && review)
        updateView({
          reviews: { ...reviews, [finding.id]: { ...review, ...change } },
        });
    },
    [finding, review, reviews],
  );
  const backToWorkspace = useCallback(() => {
    navigate(`/s/${server?.slug}/settings`);
  }, [navigate, server?.slug]);
  const mobileBackProps = useMemo(
    () => ({ "aria-label": t({ id: "raftbench.back" }) }),
    [t],
  );
  const chooseChannel = useCallback((value: string | null) => {
    setChannelId(value ?? WORKSPACE_SCOPE);
    setDrillChannelId("");
  }, []);
  const startAnalysis = useCallback(() => {
    void analyze();
  }, [analyze]);
  const chooseFilter = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    const kind = event.currentTarget.dataset.kind;
    if (
      kind === "all" ||
      kind === "frustration" ||
      kind === "negative" ||
      kind === "repetition"
    )
      setFilter(kind);
  }, []);
  const changeMinimum = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const n = Number(event.target.value);
    if (Number.isInteger(n) && n >= 2 && n <= 20) {
      setMinimum(n);
      updateView({ reviews: {} });
    }
  }, []);
  const chooseFinding = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    updateView({ selected: event.currentTarget.dataset.finding ?? "" });
  }, []);
  const openSource = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      const id = event.currentTarget.dataset.message;
      const message = evidence.find((m) => m.id === id);
      if (message) appNav.toMessage(message.channelId, message.id);
    },
    [appNav, evidence],
  );
  const changeNote = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      updateReview({ note: event.target.value });
    },
    [updateReview],
  );
  const confirmSignal = useCallback(() => {
    updateReview({ status: "confirmed" });
  }, [updateReview]);
  const dismissSignal = useCallback(() => {
    updateReview({ status: "dismissed" });
  }, [updateReview]);
  const reopenSignal = useCallback(() => {
    updateReview({ status: "needs_review" });
  }, [updateReview]);
  const channelName =
    channelId === WORKSPACE_SCOPE
      ? t({ id: "raftbench.overview" })
      : options.find((o) => o.value === channelId)?.label;
  const selectionOptions = useMemo(
    () => [
      { value: WORKSPACE_SCOPE, label: t({ id: "raftbench.overview" }) },
      ...options,
    ],
    [options, t],
  );
  const drillToChannel = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    setDrillChannelId(event.currentTarget.dataset.channel ?? "");
  }, []);
  const clearDrill = useCallback(() => setDrillChannelId(""), []);
  return (
    <Panel edge="inset" className="flex min-h-0 min-w-0 flex-1 flex-col bg-layer-canvas text-foreground" data-testid="raftbench-page">
      <PanelHeader
        title={t({ id: "raftbench.nav" })}
        icon={<BenchIcon width={18} height={18} />}
        onMobileBack={backToWorkspace}
        mobileBackProps={mobileBackProps}
      />
      {/* The page and its two inner lists scroll in raft-ui ScrollAreas; the lists hand a scroll past their end on to the page. */}
      <ScrollArea role="region" aria-label={t({ id: "raftbench.nav" })} className="min-h-0 flex-1 bg-layer-canvas" contentClassName="px-5 py-4 mobile-nav-clearance">
      <div className="mx-auto max-w-7xl stack-y-4 md:stack-y-5">
        {!analysisAllowed && <Card role="status" className={`${WARNING_PANEL} text-callout`}>
          {t({ id: "raftbench.flagUncertain" })}
        </Card>}
        <header>
          <h1 className="text-title md:text-display">{t({ id: "raftbench.title" })}</h1>
          <p className="mt-2 text-callout text-foreground-muted">{t({ id: "raftbench.subtitle" })}</p>
        </header>
        <Card className={PANEL}>
          <div className="flex flex-wrap items-end gap-4">
            <div className="w-full min-w-0 sm:w-auto sm:min-w-60 sm:flex-1">
              <label
                id="raftbench-channel-label"
                className="mb-1.5 block text-footnote font-semibold text-foreground-muted"
              >
                {t({ id: "raftbench.scope" })}
              </label>
              <Select
                value={channelId}
                onValueChange={chooseChannel}
                items={selectionOptions}
              >
                <SelectTrigger
                  aria-labelledby="raftbench-channel-label"
                  className="w-full"
                >
                  <SelectValue placeholder={t({ id: "raftbench.choose" })} />
                  <SelectIcon />
                </SelectTrigger>
                <SelectContent>
                  <SelectList>
                    {selectionOptions.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        <SelectItemText>{o.label}</SelectItemText>
                        <SelectItemIndicator />
                      </SelectItem>
                    ))}
                  </SelectList>
                </SelectContent>
              </Select>
            </div>

          </div>
        </Card>
        <section id="raftbench-ai" aria-label={t({ id: "raftbench.aiTitle" })}>
          <HostedAnalysis key={managerScopeKey} channelId={channelId === WORKSPACE_SCOPE ? null : channelId} allowed={analysisAllowed} options={options} onEnabled={setConsented} />
        </section>
        <details id="raftbench-metrics" className="stack-y-3" aria-label={t({ id: "raftbench.managerTitle" })}>
          <summary className="cursor-pointer rounded-container border border-line-hairline p-3 text-callout font-semibold">{t({ id: "raftbench.managerTitle" })}</summary>
          <ManagerOverview key={managerScopeKey} channelId={channelId === WORKSPACE_SCOPE ? null : channelId} />
        </details>
        <details className="stack-y-4" data-testid="raftbench-legacy-rules">
          <summary className="cursor-pointer rounded-container border border-line-hairline p-3 text-callout font-semibold">{t({ id: "raftbench.ruleCuesTitle" })}</summary>
          <div className="stack-y-4">
        <Card className={PANEL}>
          <p className="mb-3 text-caption text-foreground-hint">{t({ id: "raftbench.ruleCuesHelp" })}</p>
          <div className="flex flex-wrap items-center gap-3">
            <Button size="md"
              className="flex-1 sm:flex-none"
              onClick={startAnalysis}
              disabled={!consented || !analysisAllowed || !channelId || !options.length || loading}
            >
              {t({
                id: loading
                  ? "raftbench.loading"
                  : snapshot
                    ? "raftbench.refresh"
                    : "raftbench.analyze",
              })}
            </Button>
            <p className="text-caption text-foreground-hint">{t({ id: "raftbench.noExport" })}</p>
          </div>
        </Card>
        {failed && (
          <Card role="alert" className={`${WARNING_PANEL} text-callout`}>
            {t({ id: "raftbench.error" })}
          </Card>
        )}
        {!snapshot && !failed && !loading && (
          <Card className={`${PANEL} text-callout text-foreground-muted`}>{t({ id: "raftbench.empty" })}</Card>
        )}
        {snapshot && (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
              <Card className={WARNING_PANEL}>
                <p className="text-caption font-semibold">
                  {t({ id: "raftbench.cues" })}
                </p>
                <p
                  className="mt-2 text-title tabular-nums"
                  data-testid="raftbench-cue-count"
                >
                  {evaluation.findings.length}
                </p>
                <p className="mt-1 text-caption text-foreground-muted">
                  {t({ id: "raftbench.pendingCount" }, { count: evaluation.findings.filter((f) => !reviews[f.id] || reviews[f.id].status === "needs_review").length })}
                </p>
              </Card>
              <Card className={PANEL}>
                <p className="text-caption font-semibold text-foreground-muted">
                  {t({ id: "raftbench.messages" })}
                </p>
                <p className="mt-2 text-title tabular-nums">
                  {snapshot.messages.length}
                </p>
              </Card>
              <Card className={`${PANEL} col-span-2 lg:col-span-1`}>
                <p className="text-caption font-semibold text-foreground-muted">
                  {t({ id: "raftbench.sentiment" })}
                </p>
                <p className="mt-3 text-callout">
                  {t({ id: "raftbench.polarity" }, evaluation.sentiment)}
                </p>
              </Card>
            </div>
            <Card className={`${PANEL} text-caption text-foreground-muted`}>
              <details>
                <summary className="cursor-pointer py-1 text-footnote font-semibold text-foreground">
                  {t({ id: "raftbench.coverageDetails" })}
                </summary>
                <div className="mt-3 stack-y-2">
              <p className="font-semibold text-foreground">
                {channelName} ·{" "}
                {t(
                  { id: "raftbench.coverage" },
                  {
                    count: snapshot.messages.length,
                    time: formatTime(snapshot.fetchedAt, {
                      hour: "2-digit",
                      minute: "2-digit",
                      second: "2-digit",
                    }),
                  },
                )}
              </p>
              <p>
                {t({ id: "raftbench.limited" })}{" "}
                {snapshot.historyLimited && t({ id: "raftbench.planLimited" })}
              </p>
              <p>
                {t(
                  { id: "raftbench.channelCoverage" },
                  {
                    read: snapshot.channels.length,
                    requested: snapshot.requestedChannels,
                    visible: options.length,
                  },
                )}
              </p>
              <p>
                {t(
                  { id: "raftbench.unjoinedPublicCoverage" },
                  {
                    available: options.filter((o) => o.unjoinedPublic).length,
                    read: snapshot.channels.filter((c) =>
                      options.some((o) => o.value === c.channelId && o.unjoinedPublic),
                    ).length,
                  },
                )}
              </p>
              {channelId === WORKSPACE_SCOPE &&
                options.length > MAX_CHANNELS && (
                  <p>
                    {t(
                      { id: "raftbench.scanCap" },
                      {
                        limit: MAX_CHANNELS,
                        omitted: options.length - MAX_CHANNELS,
                      },
                    )}
                  </p>
                )}
              {snapshot.unavailableChannelIds.length > 0 && (
                <p role="status">
                  {t(
                    { id: "raftbench.unavailable" },
                    { count: snapshot.unavailableChannelIds.length },
                  )}
                </p>
              )}
              <p>{t({ id: "raftbench.noTools" })}</p>
                </div>
              </details>
            </Card>
            <Card className={`${PANEL} stack-y-3`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-headline">
                  {t({ id: "raftbench.channels" })}
                </h2>
                <Button size="md" variant="ghost" onClick={clearDrill}>
                  {t({ id: "raftbench.allChannels" })}
                </Button>
              </div>
              <div className="flex flex-wrap gap-2">
                {snapshot.channels.map((channel) => (
                  <Button
                    key={channel.channelId}
                    variant="outline"
                    size="md"
                    className={drillChannelId === channel.channelId ? SELECTED_CLASS : undefined}
                    aria-pressed={drillChannelId === channel.channelId}
                    data-channel={channel.channelId}
                    onClick={drillToChannel}
                  >
                    {options.find((o) => o.value === channel.channelId)
                      ?.label ?? channel.channelId}{" "}
                    ·{" "}
                    {t(
                      { id: "raftbench.filteredCount" },
                      {
                        count: evaluation.findings.filter(
                          (f) => f.evidence[0].channelId === channel.channelId,
                        ).length,
                      },
                    )}
                  </Button>
                ))}
              </div>
            </Card>
            <div className="grid items-start gap-4 lg:grid-cols-2">
              <Card className={`${PANEL} stack-y-4`}>
                <h2 className="text-headline">
                  {t({ id: "raftbench.queue" })}
                </h2>
                <div className="flex flex-wrap gap-2">
                  {(
                    ["all", "frustration", "negative", "repetition"] as const
                  ).map((kind) => (
                    <Button
                      key={kind}
                      size="md"
                      variant="outline"
                      className={filter === kind ? SELECTED_CLASS : undefined}
                      aria-pressed={filter === kind}
                      data-kind={kind}
                      onClick={chooseFilter}
                    >
                      {t({
                        id: kind === "all" ? "raftbench.all" : labels[kind],
                      })}
                    </Button>
                  ))}
                </div>
                <details className="text-footnote text-foreground-muted">
                  <summary className="cursor-pointer py-2 font-semibold">{t({ id: "raftbench.ruleSettings" })}</summary>
                <label className="mt-2 block text-footnote font-semibold text-foreground-muted">
                  {t({ id: "raftbench.threshold" })}
                  <Input
                    className="mt-2 max-w-24"
                    type="number"
                    min={2}
                    max={20}
                    value={minimum}
                    onChange={changeMinimum}
                  />
                </label>
                </details>
                <Separator />
                <p className="text-caption text-foreground-hint">
                  {t(
                    { id: "raftbench.filteredCount" },
                    { count: findings.length },
                  )}
                </p>
                <ScrollArea tabIndex={-1} overscroll="auto" className="max-h-64 lg:max-h-[32rem]" contentClassName="stack-y-2">
                  {findings.map((f) => (
                    <Button
                      key={f.id}
                      variant="ghost"
                      className={`h-auto w-full items-start justify-start whitespace-normal px-3 py-2.5 text-left ${finding?.id === f.id ? SELECTED_CLASS : ""}`}
                      data-finding={f.id}
                      onClick={chooseFinding}
                      aria-pressed={finding?.id === f.id}
                    >
                      <Status variant={signalPixel[f.kind]} className="mt-1.5" aria-hidden="true" />
                      <span className="block min-w-0">
                        <span className="block text-callout font-bold">
                          {t({ id: labels[f.kind] })} · {f.evidence.length}
                        </span>
                        <span className="mt-0.5 block text-caption font-medium text-foreground-muted">
                          {
                            options.find(
                              (o) => o.value === f.evidence[0].channelId,
                            )?.label
                          }{" "}
                          · {f.evidence[0].senderName ?? f.evidence[0].senderId}{" "}
                          · {formatTime(f.evidence[0].createdAt)} ·{" "}
                          {t({
                            id: `raftbench.${reviews[f.id]?.status ?? "needs_review"}`,
                          })}
                        </span>
                      </span>
                    </Button>
                  ))}
                </ScrollArea>
                {!findings.length && (
                  <p className="text-callout text-foreground-muted">
                    {t({ id: "raftbench.noCues" })}
                  </p>
                )}
              </Card>
              <Card className={`${PANEL} stack-y-4`}>
                <h2 className="text-headline">
                  {t({ id: "raftbench.evidence" })}
                </h2>
                {finding && review ? (
                  <>
                    <Badge variant={signalBadge[finding.kind]} appearance="soft">
                      {t({ id: labels[finding.kind] })}
                    </Badge>
                    <p className="text-callout text-foreground-muted">
                      {t({ id: rules[finding.kind] })}
                    </p>
                    <Separator />
                    <ScrollArea role="region" aria-label={t({ id: "raftbench.evidence" })} overscroll="auto" className="max-h-[30rem]" contentClassName="stack-y-4">
                      {evidence.map((m) => (
                        <article
                          key={m.id}
                          className={`rounded-container p-3 ${evidenceIds.has(m.id) ? signalTone[finding.kind] : "bg-fill-muted"}`}
                        >
                          <div className="flex flex-wrap items-center gap-2 text-caption text-foreground-muted">
                            <strong className="text-footnote font-bold text-foreground">{m.senderName ?? m.senderId}</strong>
                            <span className="font-mono text-mono-meta text-foreground-hint">
                              {formatDate(m.createdAt)}{" "}
                              {formatTime(m.createdAt)}
                            </span>
                            <Badge appearance="outline">
                              {t({
                                id: evidenceIds.has(m.id)
                                  ? "raftbench.matched"
                                  : "raftbench.context",
                              })}
                            </Badge>
                          </div>
                          <p className="my-2 whitespace-pre-wrap break-words text-callout text-foreground">
                            {m.content}
                          </p>
                          <Button
                            variant="ghost"
                            size="md"
                            data-message={m.id}
                            onClick={openSource}
                          >
                            {t({ id: "raftbench.openSource" })}
                          </Button>
                        </article>
                      ))}
                    </ScrollArea>
                    <Separator />
                    <label
                      className="block text-footnote font-semibold text-foreground-muted"
                      htmlFor="raftbench-note"
                    >
                      {t({ id: "raftbench.note" })}
                    </label>
                    <Textarea
                      id="raftbench-note"
                      value={review.note}
                      onChange={changeNote}
                    />
                    <div className="flex flex-wrap gap-2">
                      <Button size="md" onClick={confirmSignal}>
                        {t({ id: "raftbench.confirm" })}
                      </Button>
                      <Button
                        size="md"
                        variant="outline"
                        onClick={dismissSignal}
                      >
                        {t({ id: "raftbench.dismiss" })}
                      </Button>
                      <Button size="md" variant="ghost" onClick={reopenSignal}>
                        {t({ id: "raftbench.reopen" })}
                      </Button>
                    </div>
                    <p className="text-caption text-foreground-hint">
                      {t({ id: "raftbench.reviewHelp" })}
                    </p>
                  </>
                ) : (
                  <p className="text-callout text-foreground-muted">
                    {t({ id: "raftbench.noEvidence" })}
                  </p>
                )}
              </Card>
            </div>
          </>
        )}
        <p className="text-caption text-foreground-hint">
          {t({ id: "raftbench.rules" }, { version: RULE_VERSION })}
        </p>
          </div>
        </details>
      </div>
      </ScrollArea>
    </Panel>
  );
}
