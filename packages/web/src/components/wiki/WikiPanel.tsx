import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { MessageId } from "../../i18n/messages";
import { useIntl } from "react-intl";
import { Badge } from "raft-ui";
import type { BadgeProps } from "raft-ui";
import {
  clearClockInterval,
  clearClockTimeout,
  MIN_WIKI_DAEMON_VERSION,
  setClockInterval,
  setClockTimeout,
} from "@botiverse/raft-shared";
import {
  ArrowLeft,
  Bot,
  FileText,
  Hash,
  MessageSquare,
  Network,
  RefreshCw,
  Search,
  Sparkles,
} from "lucide-react";
import api from "../../api/client";
import { useTimeFormatter } from "../../hooks/useTimeFormatter";
import CreateAgentDialog from "../agent/CreateAgentDialog";
import { RefText } from "../agent/RefText";
import CreateChannelDialog from "../channel/CreateChannelDialog";
import { createMarkdownOutlineHeadingComponents, extractMarkdownOutline } from "../markdown/MarkdownOutline";
import { useAppNavigate, useMobileBack } from "../../hooks/useAppNavigate";
import { useChannelStore } from "../../store/channelStore";
import { useServerStore } from "../../store/serverStore";
import ConfirmDialog from "../ConfirmDialog";
import DialogCard from "../ui/DialogCard";
import MarkdownContent from "../markdown/MarkdownContent";
import Banner from "../ui/Banner";
import Button from "../ui/Button";
import PanelHeader from "../ui/PanelHeader";
import ProgressBar from "../ui/ProgressBar";
import Spinner from "../ui/Spinner";

type WikiStatus =
  | "setup_required"
  | "ready_uninitialized"
  | "initializing"
  | "active"
  | "error";

type WikiJobStatus = "running" | "completed" | "failed" | "canceled";
type WikiArtifactStatus = "current" | "tentative" | "contested" | "superseded" | "stale" | "archived";

// Initialization progress contract (#wiki-project:cec621e5 msg=6f0e296a):
// present while status is "initializing". `resumable` is true only when the
// frozen target is not reached AND no scan job is running.
interface WikiInitializationState {
  currentSeq: number;
  targetSeq: number;
  resumable: boolean;
}

interface WikiSpaceSummary {
  id?: string;
  status: WikiStatus;
  wikiAgentId?: string | null;
  wikiAgentName?: string | null;
  wikiChannelId?: string | null;
  wikiChannelName?: string | null;
  initializedAt?: string | null;
  lastScannedAt?: string | null;
  lastIngestReceiptId?: string | null;
  lastIngestRequestedAt?: string | null;
  lastLintAt?: string | null;
  dailyScanReminderId?: string | null;
  dailyScanNextAt?: string | null;
  weeklyLintReminderId?: string | null;
  weeklyLintNextAt?: string | null;
  manifestRevision?: number | null;
  initialization?: WikiInitializationState | null;
}

// Mirrors the server's sanitized status projection (serializeStatusJob):
// no internal job id, progress carries only percent+label, error is a
// semantic summary.
interface WikiJobSummary {
  jobType?: string | null;
  status: WikiJobStatus;
  phase?: string | null;
  progress?: {
    percent?: number | null;
    label?: string | null;
  } | null;
  error?: string | null;
  createdAt?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
}

interface WikiArtifactSummary {
  id: string;
  artifactType: string;
  title: string;
  slug?: string | null;
  summary?: string | null;
  currentUnderstanding?: string | null;
  status?: WikiArtifactStatus;
  confidence?: "low" | "medium" | "high";
  sourcePolicy?: "cached_summary" | "prefer_live_source";
  timeRangeStart?: string | null;
  timeRangeEnd?: string | null;
  updatedAt?: string | null;
  sourceRefs?: unknown[];
  followUps?: unknown[];
}

interface WikiDirectory {
  pages: WikiArtifactSummary[];
  index: WikiArtifactSummary | null;
  log: WikiArtifactSummary | null;
  lintSummary?: {
    stale?: number;
    contested?: number;
    missingSourceRefs?: number;
  } | null;
}

interface WikiPageResponse extends WikiArtifactSummary {
  markdown?: string | null;
  content?: string | null;
  metadata?: unknown;
}

// Canonical /wiki/status shape — the server emits exactly {space, lastJob};
// no multi-shape compatibility layer.
interface WikiStatusResponse {
  space?: Partial<WikiSpaceSummary> | null;
  lastJob?: WikiJobSummary | null;
}

interface WikiRefreshResponse {
  space: WikiSpaceSummary;
  job: WikiJobSummary;
  upToDate: boolean;
}

const DEFAULT_WIKI_AGENT_NAME = "WikiAgent";
const DEFAULT_WIKI_CHANNEL_NAME = "Wiki";

interface WikiPageLoadState {
  loading: boolean;
  page: WikiPageResponse | null;
}

type WikiPageLoadAction =
  | { type: "clear" }
  | { type: "loading" }
  | { type: "loaded"; page: WikiPageResponse | null };

function wikiPageLoadReducer(_state: WikiPageLoadState, action: WikiPageLoadAction): WikiPageLoadState {
  switch (action.type) {
    case "clear":
      return { loading: false, page: null };
    case "loading":
      return { loading: true, page: null };
    case "loaded":
      return { loading: false, page: action.page };
  }
}

const STATUS_LABEL_ID: Record<WikiStatus, MessageId> = {
  setup_required: "wiki.status.setupRequired",
  ready_uninitialized: "wiki.status.readyToInitialize",
  initializing: "wiki.status.initializing",
  active: "wiki.status.active",
  error: "wiki.status.error",
};

type WikiBadgeVariant = NonNullable<BadgeProps["variant"]>;

const ARTIFACT_STATUS_VARIANT: Record<WikiArtifactStatus, WikiBadgeVariant> = {
  current: "success",
  tentative: "warning",
  contested: "warning",
  superseded: "muted",
  stale: "warning",
  archived: "muted",
};

const WIKI_ARTIFACT_STATUS_LABEL_ID: Record<WikiArtifactStatus, MessageId> = {
  current: "wiki.status.current",
  tentative: "wiki.status.tentative",
  contested: "wiki.status.contested",
  superseded: "wiki.status.superseded",
  stale: "wiki.status.stale",
  archived: "wiki.status.archived",
};

function normalizeStatusResponse(data: WikiStatusResponse): {
  space: WikiSpaceSummary;
  lastJob: WikiJobSummary | null;
} {
  const source = data.space ?? {};
  const status = source.status ?? "setup_required";
  return {
    space: {
      id: source.id,
      status,
      wikiAgentId: source.wikiAgentId ?? null,
      wikiAgentName: source.wikiAgentName ?? null,
      wikiChannelId: source.wikiChannelId ?? null,
      wikiChannelName: source.wikiChannelName ?? null,
      initializedAt: source.initializedAt ?? null,
      lastScannedAt: source.lastScannedAt ?? null,
      lastIngestReceiptId: source.lastIngestReceiptId ?? null,
      lastIngestRequestedAt: source.lastIngestRequestedAt ?? null,
      lastLintAt: source.lastLintAt ?? null,
      dailyScanReminderId: source.dailyScanReminderId ?? null,
      dailyScanNextAt: source.dailyScanNextAt ?? null,
      weeklyLintReminderId: source.weeklyLintReminderId ?? null,
      weeklyLintNextAt: source.weeklyLintNextAt ?? null,
      manifestRevision: typeof source.manifestRevision === "number" ? source.manifestRevision : null,
      initialization: source.initialization ?? null,
    },
    lastJob: data.lastJob ?? null,
  };
}

function normalizeDirectory(data: Partial<WikiDirectory> & {
  artifacts?: WikiArtifactSummary[];
}): WikiDirectory {
  const artifacts = data.artifacts ?? [];
  const pages = data.pages ?? artifacts.filter((artifact) => artifact.artifactType === "page");
  const index = data.index ?? artifacts.find((artifact) => artifact.artifactType === "index") ?? null;
  const log = data.log ?? artifacts.find((artifact) => artifact.artifactType === "log") ?? null;
  return {
    pages,
    index,
    log,
    lintSummary: data.lintSummary ?? null,
  };
}

function formatMaybeDateTime(value: string | null | undefined, formatDateTime: (value: string) => string, notYet: string): string {
  return value ? formatDateTime(value) : notYet;
}

function itemTitle(item: unknown): string {
  if (typeof item === "string") return item;
  if (!item || typeof item !== "object") return String(item ?? "");
  const record = item as Record<string, unknown>;
  // slockRef first: it is the canonical, linkifiable form of a source ref.
  const value = record.slockRef ?? record.title ?? record.label ?? record.name ?? record.id ?? record.messageId ?? record.url;
  return typeof value === "string" ? value : JSON.stringify(item);
}

function itemDetail(item: unknown): string | null {
  if (!item || typeof item !== "object") return null;
  const record = item as Record<string, unknown>;
  const value = record.summary ?? record.note ?? record.reason ?? record.status ?? record.kind ?? record.type;
  return typeof value === "string" ? value : null;
}

function jobProgressValue(job: WikiJobSummary | null): number | null {
  const pct = job?.progress?.percent;
  if (typeof pct !== "number" || Number.isNaN(pct)) return null;
  return Math.max(0, Math.min(100, pct));
}

function extractApiError(err: unknown): {
  status?: number;
  message?: string;
} {
  if (typeof err !== "object" || !err || !("response" in err)) return {};
  const response = (err as {
    response?: {
      status?: number;
      data?: { error?: string };
    };
  }).response;
  return {
    status: response?.status,
    message: response?.data?.error,
  };
}

export default function WikiPanel() {
  const { formatMessage } = useIntl();
  const formatMessageRef = useRef(formatMessage);
  const { formatShortDateTime } = useTimeFormatter();
  const nav = useAppNavigate();
  const serverSlug = useServerStore((s) => s.current?.slug);
  // Wiki is a level-2 push on mobile (tab bar hidden), so the header must
  // carry the standard mobile back chevron like Search/Saved/Activity.
  const onMobileBack = useMobileBack(serverSlug ? `/s/${serverSlug}` : "/");
  const openDM = useChannelStore((s) => s.openDM);
  const [space, setSpace] = useState<WikiSpaceSummary>({ status: "setup_required" });
  const [lastJob, setLastJob] = useState<WikiJobSummary | null>(null);
  const [directory, setDirectory] = useState<WikiDirectory | null>(null);
  const [pageState, dispatchPage] = useReducer(wikiPageLoadReducer, { loading: false, page: null });
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [{ requested: ingestRequested, notice }, setIngestUi] = useState<{
    requested: boolean;
    notice: string | null;
  }>({ requested: false, notice: null });
  const [setupOpen, setSetupOpen] = useState(false);
  const [initOpen, setInitOpen] = useState(false);
  const [submittingAction, setSubmittingAction] = useState<string | null>(null);
  const [openingDm, setOpeningDm] = useState(false);
  const ingestBaselineReceiptRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    formatMessageRef.current = formatMessage;
  }, [formatMessage]);

  const askWikiAgent = async () => {
    if (!space.wikiAgentId) return;
    setOpeningDm(true);
    setError(null);
    try {
      const channel = await openDM(space.wikiAgentId);
      nav.toDm(channel.id);
    } catch {
      setError(formatMessage({ id: "wiki.failedOpenConversation" }));
    } finally {
      setOpeningDm(false);
    }
  };

  const openWikiChannel = () => {
    if (!space.wikiChannelId) return;
    nav.toChannel(space.wikiChannelId);
  };

  const loadWiki = useCallback(async (mode: "initial" | "refresh" = "refresh") => {
    if (mode === "initial") setLoading(true);
    setError(null);
    try {
      const { data } = await api.get<WikiStatusResponse>("/wiki/status");
      const normalized = normalizeStatusResponse(data);
      setSpace(normalized.space);
      setLastJob(normalized.lastJob);
      const baselineReceipt = ingestBaselineReceiptRef.current;
      const currentReceipt = normalized.space.lastIngestReceiptId ?? null;
      if (
        baselineReceipt !== undefined
        && currentReceipt !== null
        && currentReceipt !== baselineReceipt
      ) {
        ingestBaselineReceiptRef.current = undefined;
        setIngestUi({
          requested: false,
          notice: formatMessageRef.current({ id: "wiki.ingest.completed" }),
        });
      }
      if (normalized.space.status === "active" || normalized.space.status === "initializing" || normalized.space.status === "ready_uninitialized") {
        try {
          const directoryResponse = await api.get<Partial<WikiDirectory> & { artifacts?: WikiArtifactSummary[] }>("/wiki/directory");
          setDirectory(normalizeDirectory(directoryResponse.data));
        } catch (directoryError) {
          setDirectory(null);
          if (normalized.space.status === "active") throw directoryError;
        }
      } else {
        setDirectory(null);
      }
    } catch (err: unknown) {
      const { status: responseStatus, message } = extractApiError(err);
      // 404 means the wiki_v0 feature gate is off for this server (the rail
      // entry shares the same flag, so this only appears if the flag flips
      // mid-session). Do not fake a setup-ready state.
      setError(responseStatus === 404
        ? formatMessageRef.current({ id: "wiki.unavailable" })
        : message || formatMessageRef.current({ id: "wiki.failedLoadState" }));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadWiki("initial");
  }, [loadWiki]);

  useEffect(() => {
    if (
      !ingestRequested
      && space.status !== "initializing"
      && lastJob?.status !== "running"
    ) return;
    const id = setClockInterval(() => void loadWiki("refresh"), 5000);
    return () => clearClockInterval(id);
  }, [ingestRequested, space.status, lastJob?.status, loadWiki]);

  useEffect(() => {
    if (!ingestRequested) return;
    const timeout = setClockTimeout(() => {
      ingestBaselineReceiptRef.current = undefined;
      setIngestUi({
        requested: false,
        notice: formatMessageRef.current({ id: "wiki.ingest.receiptTimeout" }),
      });
    }, 5 * 60 * 1000);
    return () => clearClockTimeout(timeout);
  }, [ingestRequested]);

  const pages = useMemo(() => directory?.pages ?? [], [directory]);
  // Index and Log are system artifacts, not knowledge pages: they stay
  // reachable through quiet directory-footer links instead of a tab.
  const allArtifacts = useMemo(
    () => [directory?.index, directory?.log, ...pages].filter((item): item is WikiArtifactSummary => !!item),
    [directory, pages],
  );

  const effectiveSelectedArtifactId = useMemo(() => {
    if (allArtifacts.some((item) => item.id === selectedArtifactId)) return selectedArtifactId;
    // Landing selection: the Index (content map) until a page is chosen.
    return directory?.index?.id ?? pages[0]?.id ?? null;
  }, [allArtifacts, selectedArtifactId, directory, pages]);
  const visibleSelectedPage = pageState.page?.id === effectiveSelectedArtifactId ? pageState.page : null;

  useEffect(() => {
    if (!effectiveSelectedArtifactId) {
      dispatchPage({ type: "clear" });
      return;
    }
    let cancelled = false;
    dispatchPage({ type: "loading" });
    void api
      .get<WikiPageResponse>(`/wiki/artifacts/${effectiveSelectedArtifactId}`)
      .then(({ data }) => {
        if (!cancelled) dispatchPage({ type: "loaded", page: data });
      })
      .catch(() => {
        if (!cancelled) {
          const summary = allArtifacts.find((item) => item.id === effectiveSelectedArtifactId);
          dispatchPage({ type: "loaded", page: summary ? { ...summary, markdown: null } : null });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [allArtifacts, effectiveSelectedArtifactId]);

  // Initialization and Refresh use the same semantic Agent wake. The Agent
  // reads eligible Raft source and commits one new ingest receipt; the Web
  // polls for that receipt instead of mistaking a concurrent lint publication
  // for completion or pretending the wake itself is a scan.
  const triggerCoverageRefresh = async (action: "init" | "scan") => {
    setSubmittingAction(action);
    setError(null);
    setIngestUi((current) => ({ ...current, notice: null }));
    try {
      const { data } = await api.post<WikiRefreshResponse>("/wiki/refresh");
      if (data.upToDate) {
        ingestBaselineReceiptRef.current = undefined;
        setIngestUi({
          requested: false,
          notice: formatMessage({ id: "wiki.ingest.alreadyUpToDate" }),
        });
        if (action === "init") setInitOpen(false);
        await loadWiki("refresh");
        return;
      }
      ingestBaselineReceiptRef.current = data.space.lastIngestReceiptId ?? null;
      setIngestUi({
        requested: true,
        notice: action === "init"
          ? formatMessage({ id: "wiki.notice.ingestCompleted" })
          : formatMessage({ id: "wiki.notice.pageUpdated" }),
      });
      if (action === "init") setInitOpen(false);
      await loadWiki("refresh");
    } catch (err: unknown) {
      const { message } = extractApiError(err);
      setError(message || (action === "init" ? formatMessage({ id: "wiki.init.failedStart" }) : formatMessage({ id: "wiki.init.failedScan" })));
    } finally {
      setSubmittingAction(null);
    }
  };

  const startInitialization = () => triggerCoverageRefresh("init");
  const startScanUpdates = () => triggerCoverageRefresh("scan");

  // Progress truth is server-owned: lastJob.progress.percent or nothing
  // (indeterminate). A client-side seq approximation would restart from a
  // fake low percent after every reload.
  const initialization = space.status === "initializing" ? space.initialization ?? null : null;

  const selectedStatusVariant: WikiBadgeVariant = space.status === "active"
    ? "success"
    : space.status === "error"
      ? "danger"
      : "warning";

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-white">
      <PanelHeader
        icon={<Network size={18} />}
        title={formatMessage({ id: "wiki.title" })}
        onMobileBack={onMobileBack}
        mobileBackProps={{ "data-testid": "wiki-mobile-back" }}
        subtitle={formatMessage({ id: "wiki.panelSubtitle" })}
        titleSuffix={<Badge variant={selectedStatusVariant}>{formatMessage({ id: STATUS_LABEL_ID[space.status] })}</Badge>}
        actions={
          <>
            {space.status === "setup_required" && (
              // The setup card below carries the same CTA; skip the header
              // duplicate where narrow-viewport header space is scarce. The
              // wrapper (not a Button className) must own the hiding: Button
              // always applies a base `inline-flex`, and `hidden` on the same
              // element loses to stylesheet order, not class order.
              <span className="hidden sm:inline-flex">
                <Button
                  size="sm"
                  shape="iconText"
                  tone="pink"
                  onClick={() => setSetupOpen(true)}
                >
                  <Sparkles size={14} />
                  {formatMessage({ id: "wiki.setupButton" })}
                </Button>
              </span>
            )}
            {space.status === "active" && (
              <>
                <Button
                  size="sm"
                  shape="iconText"
                  disabled={!space.wikiAgentId || openingDm}
                  aria-label={formatMessage({ id: "wiki.askAgent" })}
                  title={formatMessage({ id: "wiki.askAgent" })}
                  onClick={() => void askWikiAgent()}
                >
                  <MessageSquare size={14} />
                  <span className="hidden sm:inline">{openingDm ? formatMessage({ id: "wiki.opening" }) : formatMessage({ id: "wiki.askAgent" })}</span>
                </Button>
                <Button
                  size="sm"
                  shape="iconText"
                  disabled={!space.wikiChannelId}
                  aria-label={formatMessage({ id: "wiki.openChannel" }, { channel: space.wikiChannelName || formatMessage({ id: "wiki.channelNameFallback" }) })}
                  title={formatMessage({ id: "wiki.openChannel" }, { channel: space.wikiChannelName || formatMessage({ id: "wiki.channelNameFallback" }) })}
                  onClick={openWikiChannel}
                >
                  <Hash size={14} />
                  <span className="hidden sm:inline">{space.wikiChannelName || formatMessage({ id: "wiki.channelNameFallback" })}</span>
                </Button>
                <Button
                  size="sm"
                  shape="iconText"
                  disabled={submittingAction === "scan" || ingestRequested}
                  aria-label={ingestRequested ? formatMessage({ id: "wiki.refreshRequested" }) : formatMessage({ id: "wiki.refreshWikiNow" })}
                  title={ingestRequested ? formatMessage({ id: "wiki.refreshRequested" }) : formatMessage({ id: "wiki.refreshWikiNow" })}
                  onClick={() => void startScanUpdates()}
                >
                  <RefreshCw size={14} className={submittingAction === "scan" || ingestRequested ? "animate-spin" : ""} />
                  <span className="hidden sm:inline">{ingestRequested ? formatMessage({ id: "wiki.agentWorking" }) : formatMessage({ id: "wiki.refreshNow" })}</span>
                </Button>
              </>
            )}
          </>
        }
      />

      {loading ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm font-bold uppercase text-black/40">
          <Spinner size="lg" label={formatMessage({ id: "wiki.loading" })} />
          {formatMessage({ id: "wiki.loading" })}
        </div>
      ) : (
        <>
          {error && (
            <div className="border-b-2 border-black bg-white px-5 py-3">
              <Banner intent="warning" density="sm" withIcon>{error}</Banner>
            </div>
          )}
          {notice && (
            <div className="border-b-2 border-black bg-white px-5 py-3">
              <Banner intent="info" density="sm" withIcon>{notice}</Banner>
            </div>
          )}

          {space.status === "setup_required" ? (
            <SetupRequiredState onSetup={() => setSetupOpen(true)} />
          ) : space.status === "ready_uninitialized" ? (
            <ReadyState
              space={space}
              busy={submittingAction === "init" || ingestRequested}
              onInitialize={() => setInitOpen(true)}
            />
          ) : space.status === "initializing" ? (
            <JobState
              title={formatMessage({ id: "wiki.init.initializingTitle" })}
              description={formatMessage({ id: "wiki.init.compileDesc" })}
              job={lastJob}
              formatDateTime={formatShortDateTime}
              initialization={initialization}
              resuming={submittingAction === "init"}
              onResume={() => void triggerCoverageRefresh("init")}
            />
          ) : space.status === "error" ? (
            <ErrorState job={lastJob} onRetry={() => setInitOpen(true)} busy={submittingAction === "init"} />
          ) : (
            <ActiveWikiState
              space={space}
              pages={pages}
              indexDoc={directory?.index ?? null}
              logDoc={directory?.log ?? null}
              selectedArtifactId={effectiveSelectedArtifactId}
              setSelectedArtifactId={setSelectedArtifactId}
              selectedPage={visibleSelectedPage}
              pageLoading={pageState.loading}
              lastJob={lastJob}
              formatDateTime={formatShortDateTime}
            />
          )}
        </>
      )}

      {setupOpen && (
        <WikiSetupDialog
          onClose={() => setSetupOpen(false)}
          onCreated={async () => {
            setSetupOpen(false);
            await loadWiki("refresh");
          }}
        />
      )}
      {initOpen && (
        <WikiInitDialog
          busy={submittingAction === "init"}
          onClose={() => setInitOpen(false)}
          onInitialize={startInitialization}
        />
      )}
    </div>
  );
}

function SetupRequiredState({ onSetup }: { onSetup: () => void }) {
  const { formatMessage } = useIntl();
  return (
    <div className="scrollbar-quiet min-h-0 flex-1 overflow-auto bg-white p-5 safe-bottom">
      <div className="mx-auto max-w-2xl border-2 border-black bg-white p-5 shadow-brutal-sm">
        <div className="mb-5 flex items-center gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center border-2 border-black bg-soft-signal">
            <Network size={20} />
          </div>
          <h2 className="text-xl font-bold leading-tight">{formatMessage({ id: "wiki.setupHeading" })}</h2>
        </div>
        <div className="space-y-3">
          <SetupPiece icon={<Bot size={16} />} title={formatMessage({ id: "wiki.setup.agentTitle" })} body={formatMessage({ id: "wiki.setup.agentBody" })} />
          <SetupPiece icon={<Hash size={16} />} title={formatMessage({ id: "wiki.setup.channelTitle" })} body={formatMessage({ id: "wiki.setup.channelBody" })} />
        </div>
        <p className="mt-4 text-sm text-black/55">
          {formatMessage({ id: "wiki.setupOnlyCreates" })}
        </p>
        <div className="mt-5">
          <Button size="md" shape="iconText" tone="pink" onClick={onSetup}>
            <Sparkles size={16} />
            {formatMessage({ id: "wiki.setupCardButton" })}
          </Button>
        </div>
      </div>
    </div>
  );
}

function SetupPiece({ icon, title, body }: { icon: ReactNode; title: string; body: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="inline-flex size-8 shrink-0 items-center justify-center border-2 border-black bg-brutal-cream">
        {icon}
      </span>
      <div className="min-w-0">
        <span className="font-bold">{title}</span>
        <span className="text-black/55"> — {body}</span>
      </div>
    </div>
  );
}

function ReadyState({
  space,
  busy,
  onInitialize,
}: {
  space: WikiSpaceSummary;
  busy: boolean;
  onInitialize: () => void;
}) {
  const { formatMessage } = useIntl();
  const { formatShortDateTime } = useTimeFormatter();
  return (
    <div className="scrollbar-quiet min-h-0 flex-1 overflow-auto bg-white p-5 safe-bottom">
      <div className="mx-auto max-w-4xl border-2 border-black bg-white p-5 shadow-brutal-sm">
        <div className="mb-4">
          <h2 className="text-xl font-bold leading-tight">{formatMessage({ id: "wiki.init.ready" })}</h2>
          <p className="mt-1 text-sm font-mono text-black/50">{formatMessage({ id: "wiki.startInitHint" })}</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <KeyFact icon={<Bot size={16} />} label={formatMessage({ id: "wiki.agentLabel" })} value={space.wikiAgentName || space.wikiAgentId || formatMessage({ id: "wiki.setup.agentTitle" })} />
          <KeyFact icon={<Hash size={16} />} label={formatMessage({ id: "wiki.setup.channelTitle" })} value={space.wikiChannelName ? `#${space.wikiChannelName}` : space.wikiChannelId || `#${formatMessage({ id: "wiki.channelNameFallback" })}`} />
        </div>
        <p className="mt-4 text-sm text-black/55">
          {formatMessage({ id: "wiki.readyParagraph" })}
        </p>
        {space.lastIngestRequestedAt && (
          <p className="mt-3 text-sm text-black/55">
            {formatMessage(
              { id: "wiki.init.requestedAt" },
              { date: formatShortDateTime(space.lastIngestRequestedAt) },
            )}
          </p>
        )}
        <div className="mt-5">
          <Button size="md" shape="iconText" tone="pink" disabled={busy} onClick={onInitialize}>
            <Search size={16} />
            {busy ? formatMessage({ id: "wiki.init.working" }) : formatMessage({ id: "wiki.init.heading" })}
          </Button>
        </div>
      </div>
    </div>
  );
}

function WikiInitDialog({
  busy,
  onClose,
  onInitialize,
}: {
  busy: boolean;
  onClose: () => void;
  onInitialize: () => Promise<void>;
}) {
  const { formatMessage } = useIntl();

  return (
    <ConfirmDialog
      title={formatMessage({ id: "wiki.init.heading" })}
      message={(
        <div className="space-y-4">
          <Banner intent="info" density="sm" title={formatMessage({ id: "wiki.setup.allPublicChannels" })}>
            {formatMessage({ id: "wiki.initBanner" })}
          </Banner>
          <p className="text-sm leading-relaxed text-black/65">
            {formatMessage({ id: "wiki.initialize.flowDescription" })}
          </p>
        </div>
      )}
      chromeLocale="active"
      confirmLabel={formatMessage({ id: "wiki.init.start" })}
      loadingLabel={formatMessage({ id: "wiki.status.initializing" })}
      confirmColor="bg-brutal-pink"
      confirmDisabled={busy}
      maxWidthClass="max-w-2xl"
      plainMessage
      closeOnConfirm={false}
      onConfirm={onInitialize}
      onClose={onClose}
    />
  );
}

function JobState({
  title,
  description,
  job,
  formatDateTime,
  initialization = null,
  resuming = false,
  onResume,
}: {
  title: string;
  description: string;
  job: WikiJobSummary | null;
  formatDateTime: (value: string) => string;
  initialization?: WikiInitializationState | null;
  resuming?: boolean;
  onResume?: () => void;
}) {
  const { formatMessage } = useIntl();
  const progress = jobProgressValue(job);
  // resumable=true means the frozen target is not reached and no scan job is
  // running — the previous run was interrupted or its round failed.
  const resumable = Boolean(initialization?.resumable && onResume) && !resuming;
  const spinning = !resumable;
  return (
    <div className="scrollbar-quiet min-h-0 flex-1 overflow-auto bg-white p-5 safe-bottom">
      <div className="mx-auto max-w-3xl border-2 border-black bg-white p-5 shadow-brutal-sm">
        <div className="mb-4 flex items-center gap-3">
          <div className="flex size-10 items-center justify-center border-2 border-black bg-brutal-orange">
            <RefreshCw size={18} className={spinning ? "animate-spin" : ""} />
          </div>
          <div>
            <h2 className="text-xl font-bold leading-tight">{title}</h2>
            <p className="text-sm text-black/60">{description}</p>
          </div>
        </div>
        <ProgressBar value={progress} label={job?.progress?.label || formatMessage({ id: "wiki.waitingPublication" })} showPercent={progress !== null} tone="pink" />
        <div className="mt-4 grid gap-2 text-xs font-mono text-black/50 sm:grid-cols-2">
          <span>{formatMessage({ id: "wiki.started" })}: {formatMaybeDateTime(job?.startedAt, formatDateTime, formatMessage({ id: "wiki.status.notYet" }))}</span>
          <span>{formatMessage({ id: "wiki.updated" })}: {formatMaybeDateTime(job?.completedAt ?? job?.createdAt, formatDateTime, formatMessage({ id: "wiki.status.notYet" }))}</span>
        </div>
        {resumable && (
          <div className="mt-5 border-t-2 border-black pt-4">
            <p className="text-sm text-black/65">
              {job?.status === "failed"
                ? formatMessage({ id: "wiki.ingestFailed" })
                : formatMessage({ id: "wiki.init.interrupted" })}
            </p>
            <Button
              className="mt-3"
              shape="iconText"
              tone="pink"
              disabled={resuming}
              onClick={onResume}
            >
              <RefreshCw size={14} />
              {job?.status === "failed" ? formatMessage({ id: "wiki.init.retry" }) : formatMessage({ id: "wiki.init.resume" })}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function ErrorState({ job, onRetry, busy }: { job: WikiJobSummary | null; onRetry: () => void; busy: boolean }) {
  const { formatMessage } = useIntl();
  return (
    <div className="scrollbar-quiet min-h-0 flex-1 overflow-auto bg-white p-5 safe-bottom">
      <div className="mx-auto max-w-3xl border-2 border-black bg-white p-5 shadow-brutal-sm">
        <Banner intent="destructive" withIcon title={formatMessage({ id: "wiki.maintenanceFailed" })}>
          {job?.error || formatMessage({ id: "wiki.maintenanceRunFailed" })}
        </Banner>
        <Button className="mt-4" shape="iconText" tone="pink" disabled={busy} onClick={onRetry}>
          <RefreshCw size={14} />
          {formatMessage({ id: "wiki.init.retry" })}
        </Button>
      </div>
    </div>
  );
}

function ActiveWikiState({
  space,
  pages,
  indexDoc,
  logDoc,
  selectedArtifactId,
  setSelectedArtifactId,
  selectedPage,
  pageLoading,
  lastJob,
  formatDateTime,
}: {
  space: WikiSpaceSummary;
  pages: WikiArtifactSummary[];
  indexDoc: WikiArtifactSummary | null;
  logDoc: WikiArtifactSummary | null;
  selectedArtifactId: string | null;
  setSelectedArtifactId: (id: string) => void;
  selectedPage: WikiPageResponse | null;
  pageLoading: boolean;
  lastJob: WikiJobSummary | null;
  formatDateTime: (value: string) => string;
}) {
  const { formatMessage } = useIntl();

  // Below md the two desktop panes become a master-detail flow: the document
  // list is the only surface until a document is explicitly opened. Desktop
  // keeps both panes side by side and ignores this state.
  const [mobileDocOpen, setMobileDocOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const normalizedFilter = filter.trim().toLowerCase();
  const visibleList = normalizedFilter
    ? pages.filter((artifact) =>
        `${artifact.title} ${artifact.summary ?? ""}`.toLowerCase().includes(normalizedFilter),
      )
    : pages;
  const buildingInitial = lastJob?.status === "running";

  const openArtifact = (id: string) => {
    setSelectedArtifactId(id);
    setMobileDocOpen(true);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-white">
      <div className="hidden border-b-2 border-black bg-white px-4 py-1.5 md:block">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] font-mono text-black/45">
          <span>{formatMessage({ id: "wiki.refreshed" })} {formatMaybeDateTime(space.lastScannedAt, formatDateTime, formatMessage({ id: "wiki.status.notYet" }))}</span>
          <span aria-hidden>·</span>
          <span>
            {formatMessage(
              { id: "wiki.status.nextIngest" },
              {
                date: space.dailyScanNextAt
                  ? formatDateTime(space.dailyScanNextAt)
                  : formatMessage({ id: "wiki.status.pendingSetup" }),
              },
            )}
          </span>
          <span aria-hidden>·</span>
          <span>
            {formatMessage(
              { id: "wiki.status.nextLint" },
              {
                date: space.weeklyLintNextAt
                  ? formatDateTime(space.weeklyLintNextAt)
                  : formatMessage({ id: "wiki.status.pendingSetup" }),
              },
            )}
          </span>
          {lastJob?.status === "running" && (
            <>
              <span aria-hidden>·</span>
              <span className="text-black/60">{formatMessage({ id: "wiki.maintenanceRunning" })}</span>
            </>
          )}
          {lastJob?.status === "failed" && (
            <>
              <span aria-hidden>·</span>
              <span className="text-brutal-orange">{formatMessage({ id: "wiki.maintenanceFailedLatest" })}</span>
            </>
          )}
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 bg-white md:grid-cols-[300px_minmax(0,1fr)]">
        <aside className={`${mobileDocOpen ? "hidden md:flex" : "flex"} min-h-0 flex-col bg-brutal-cream md:border-r-2 md:border-black`}>
          <div className="shrink-0 border-b-2 border-black bg-white p-3">
            <input
              type="search"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder={formatMessage({ id: "wiki.filterPages" })}
              aria-label={formatMessage({ id: "wiki.filterPages" })}
              className="input-brutal w-full px-2 py-1.5 text-sm"
            />
          </div>
          <div className="scrollbar-quiet min-h-0 flex-1 overflow-y-auto p-3">
            {visibleList.length ? (
              <div className="space-y-2">
                {visibleList.map((artifact) => (
                  <ArtifactRow
                    key={artifact.id}
                    artifact={artifact}
                    active={artifact.id === selectedArtifactId}
                    onClick={() => openArtifact(artifact.id)}
                  />
                ))}
              </div>
            ) : pages.length ? (
              <EmptyList label={formatMessage({ id: "wiki.noMatchingPages" })} hint={formatMessage({ id: "wiki.tryDifferentFilter" })} />
            ) : buildingInitial ? (
              <EmptyList
                busy
                label={formatMessage({ id: "wiki.init.building" })}
                hint={formatMessage({ id: "wiki.scanningHint" })}
              />
            ) : (
              <EmptyList label={formatMessage({ id: "wiki.noPagesYet" })} hint={formatMessage({ id: "wiki.emptyHint" })} />
            )}
          </div>
          {(indexDoc || logDoc) && (
            <div className="shrink-0 border-t-2 border-black bg-white px-3 py-2 safe-bottom">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-mono">
                {indexDoc && (
                  <button
                    type="button"
                    onClick={() => openArtifact(indexDoc.id)}
                    className={`hover:text-black ${selectedArtifactId === indexDoc.id ? "font-bold text-black" : "text-black/50"}`}
                  >
                    {formatMessage({ id: "wiki.indexLabel" })}
                  </button>
                )}
                {logDoc && (
                  <button
                    type="button"
                    onClick={() => openArtifact(logDoc.id)}
                    className={`hover:text-black ${selectedArtifactId === logDoc.id ? "font-bold text-black" : "text-black/50"}`}
                  >
                    {formatMessage({ id: "wiki.logLabel" })}
                  </button>
                )}
              </div>
            </div>
          )}
        </aside>

        <main className={`${mobileDocOpen ? "block" : "hidden md:block"} scrollbar-quiet min-h-0 overflow-y-auto bg-white p-5 safe-bottom`}>
          <div className="mb-4 md:hidden">
            <Button size="sm" shape="iconText" onClick={() => setMobileDocOpen(false)}>
              <ArrowLeft size={14} />
              {formatMessage({ id: "wiki.allDocuments" })}
            </Button>
          </div>
          {pageLoading ? (
            <div className="flex h-full items-center justify-center text-sm font-bold uppercase text-black/40">
              {formatMessage({ id: "wiki.loadingDocument" })}
            </div>
          ) : selectedPage ? (
            <WikiDocument page={selectedPage} formatDateTime={formatDateTime} />
          ) : (
            <div className="flex h-full items-center justify-center text-center text-sm font-bold uppercase text-black/40">
              {formatMessage({ id: "wiki.emptyDocument" })}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

function WikiDocument({ page, formatDateTime }: { page: WikiPageResponse; formatDateTime: (value: string) => string }) {
  const { formatMessage } = useIntl();
  const markdown = page.markdown ?? page.content ?? "";
  const outline = useMemo(() => (markdown ? extractMarkdownOutline(markdown) : []), [markdown]);
  const showOutline = outline.length >= 3;
  const outlineComponents = useMemo(
    () => (showOutline ? createMarkdownOutlineHeadingComponents(outline) : undefined),
    [showOutline, outline],
  );
  return (
    <div className="mx-auto flex max-w-5xl justify-center gap-8">
    <article className="min-w-0 max-w-3xl flex-1">
      <h1 className="text-2xl font-bold leading-tight sm:text-3xl">{page.title}</h1>
      <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-xs font-mono text-black/50">
        {page.status && <Badge variant={ARTIFACT_STATUS_VARIANT[page.status]}>{formatMessage({ id: WIKI_ARTIFACT_STATUS_LABEL_ID[page.status] })}</Badge>}
        {page.confidence && <Badge appearance="outline">{formatMessage({ id: "wiki.pageConfidence" }, { confidence: page.confidence })}</Badge>}
        {page.sourcePolicy === "prefer_live_source" && <Badge variant="warning">{formatMessage({ id: "wiki.preferLiveSource" })}</Badge>}
        {(page.timeRangeStart || page.timeRangeEnd) && (
          <span>
            {formatMaybeDateTime(page.timeRangeStart, formatDateTime, formatMessage({ id: "wiki.status.notYet" }))} → {formatMaybeDateTime(page.timeRangeEnd, formatDateTime, formatMessage({ id: "wiki.status.notYet" }))}
          </span>
        )}
        <span>{formatMessage({ id: "wiki.updated" })} {formatMaybeDateTime(page.updatedAt, formatDateTime, formatMessage({ id: "wiki.status.notYet" }))}</span>
      </div>
      {page.summary && (
        <p className="mt-5 border-l-4 border-black pl-3 text-base font-medium leading-relaxed">
          {page.summary}
        </p>
      )}
      {page.currentUnderstanding && (
        <section className="mt-5 border-2 border-black bg-brutal-cream p-4">
          <h2 className="text-sm font-bold uppercase tracking-wide">{formatMessage({ id: "wiki.currentUnderstanding" })}</h2>
          <p className="mt-2 text-sm leading-relaxed">{page.currentUnderstanding}</p>
        </section>
      )}
      <div className="mt-6 border-t-2 border-black pt-5 text-base leading-relaxed">
        {markdown ? (
          <MarkdownContent source={markdown} density="document" enableMermaid components={outlineComponents} />
        ) : (
          <p className="text-sm font-mono text-black/50">{formatMessage({ id: "wiki.noMarkdownYet" })}</p>
        )}
      </div>
      <ReferenceList title={formatMessage({ id: "wiki.sourceRefs" })} items={page.sourceRefs} />
    </article>
    {showOutline && (
      <nav className="hidden w-52 shrink-0 xl:block" aria-label={formatMessage({ id: "wiki.documentOutline" })}>
        <div className="sticky top-4 border-l-2 border-black/10 pl-3">
          <div className="mb-2 text-xs font-bold uppercase tracking-wide text-black/40">{formatMessage({ id: "wiki.onThisPage" })}</div>
          {outline.map((item) => (
            <a
              key={item.id}
              href={`#${item.id}`}
              className={`block truncate py-0.5 text-sm text-black/60 hover:text-black ${
                item.level === 3 ? "pl-4" : item.level === 2 ? "pl-2" : ""
              }`}
              onClick={(event) => {
                // Scroll inside the panel without writing a URL hash: raw
                // hashes interact badly with the app's legacy-hash handling.
                event.preventDefault();
                document.getElementById(item.id)?.scrollIntoView({ behavior: "smooth", block: "start" });
              }}
            >
              {item.title}
            </a>
          ))}
        </div>
      </nav>
    )}
    </div>
  );
}

function ReferenceList({ title, items }: { title: string; items?: unknown[] }) {
  if (!Array.isArray(items) || items.length === 0) return null;
  return (
    <section className="mt-5 border-t-2 border-black pt-4">
      <h2 className="text-sm font-bold uppercase tracking-wide">{title}</h2>
      <div className="mt-2 space-y-2">
        {items.map((item, index) => (
          <div key={`${title}-${index}`} className="border border-black bg-white p-2">
            <div className="break-words text-sm font-bold">
              <RefText text={itemTitle(item)} />
            </div>
            {itemDetail(item) && <div className="mt-1 text-xs text-black/55">{itemDetail(item)}</div>}
          </div>
        ))}
      </div>
    </section>
  );
}

function WikiSetupDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => Promise<void> }) {
  const { formatMessage } = useIntl();
  const [createdAgent, setCreatedAgent] = useState<{ id: string; name: string } | null>(null);
  const [createdChannel, setCreatedChannel] = useState<{ id: string; name: string } | null>(null);
  const [activeCreateDialog, setActiveCreateDialog] = useState<"agent" | "channel" | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    if (!createdAgent || !createdChannel) {
      setError(formatMessage({ id: "wiki.setup.createBothHint" }));
      setSubmitting(false);
      return;
    }
    try {
      await api.post("/wiki/setup", {
        agentId: createdAgent.id,
        agentName: createdAgent.name,
        channelId: createdChannel.id,
        channelName: createdChannel.name,
      });
      await onCreated();
    } catch (err: unknown) {
      const { status: responseStatus, message } = extractApiError(err);
      setError(responseStatus === 404 ? formatMessage({ id: "wiki.setup.apiNotMounted" }) : message || formatMessage({ id: "wiki.setup.failed" }));
    } finally {
      setSubmitting(false);
    }
  };

  if (activeCreateDialog === "agent") {
    return (
      <CreateAgentDialog
        onClose={() => setActiveCreateDialog(null)}
        prefilledName={DEFAULT_WIKI_AGENT_NAME}
        prefilledDescription={formatMessage({ id: "wiki.defaultAgentDescription" })}
        minimumDaemonVersion={MIN_WIKI_DAEMON_VERSION}
        stayOnCreate
        onCreated={(agent) => {
          setCreatedAgent(agent);
          setCreatedChannel(null);
          setActiveCreateDialog(null);
        }}
      />
    );
  }

  if (activeCreateDialog === "channel") {
    return (
      <CreateChannelDialog
        onClose={() => setActiveCreateDialog(null)}
        prefilledName={DEFAULT_WIKI_CHANNEL_NAME}
        prefilledDescription={formatMessage({ id: "wiki.defaultChannelDescription" })}
        prefilledVisibility="public"
        prefilledAgentIds={createdAgent ? [createdAgent.id] : undefined}
        stayOnCreate
        onCreated={(channel) => {
          setCreatedChannel(channel);
          setActiveCreateDialog(null);
        }}
      />
    );
  }

  return (
    <DialogCard title={formatMessage({ id: "wiki.setupDialogTitle" })} onClose={onClose} maxWidthClass="max-w-2xl">
        <form onSubmit={submit} className="space-y-4">
          {error && <Banner intent="warning" density="sm">{error}</Banner>}
          <div className="grid gap-3 md:grid-cols-2">
            <SetupResourceCard
              icon={<Bot size={16} />}
              title={formatMessage({ id: "wiki.setup.agentTitle" })}
              value={createdAgent ? `@${createdAgent.name}` : formatMessage({ id: "wiki.status.notCreated" })}
              description={formatMessage({ id: "wiki.defaultAgentDescription" })}
              actionLabel={createdAgent ? formatMessage({ id: "wiki.setup.replaceAgent" }) : formatMessage({ id: "wiki.setup.createAgent" })}
              complete={Boolean(createdAgent)}
              onAction={() => setActiveCreateDialog("agent")}
            />
            <SetupResourceCard
              icon={<Hash size={16} />}
              title={formatMessage({ id: "wiki.setup.channelTitle" })}
              value={createdChannel ? `#${createdChannel.name}` : formatMessage({ id: "wiki.status.notCreated" })}
              description={formatMessage({ id: "wiki.defaultChannelDescription" })}
              actionLabel={createdChannel ? formatMessage({ id: "wiki.setup.replaceChannel" }) : formatMessage({ id: "wiki.setup.createChannel" })}
              complete={Boolean(createdChannel)}
              disabled={!createdAgent}
              disabledReason={formatMessage({ id: "wiki.setup.createAgentHint" })}
              onAction={() => setActiveCreateDialog("channel")}
            />
          </div>
          <div className="flex flex-wrap justify-end gap-2 pt-2">
            <Button type="button" onClick={onClose}>{formatMessage({ id: "common.confirm.cancel" })}</Button>
            <Button type="submit" tone="pink" disabled={submitting || !createdAgent || !createdChannel}>
              {submitting ? formatMessage({ id: "wiki.setup.saving" }) : formatMessage({ id: "wiki.setup.finish" })}
            </Button>
          </div>
        </form>
    </DialogCard>
  );
}

function SetupResourceCard({
  icon,
  title,
  value,
  description,
  actionLabel,
  complete,
  disabled = false,
  disabledReason,
  onAction,
}: {
  icon: ReactNode;
  title: string;
  value: string;
  description: string;
  actionLabel: string;
  complete: boolean;
  disabled?: boolean;
  disabledReason?: string;
  onAction: () => void;
}) {
  const { formatMessage } = useIntl();
  return (
    <div className="flex min-h-full flex-col border-2 border-black bg-white p-3 shadow-brutal-sm">
      <div className="flex items-center gap-2">
        <span className="inline-flex h-7 w-7 items-center justify-center border-2 border-black bg-soft-signal">{icon}</span>
        <div className="min-w-0">
          <h3 className="text-sm font-bold uppercase tracking-wide">{title}</h3>
          <p className="truncate text-xs font-mono text-black/55">{value}</p>
        </div>
        <Badge variant={complete ? "success" : "warning"} className="ml-auto">{complete ? formatMessage({ id: "wiki.status.ready" }) : formatMessage({ id: "wiki.setup.required" })}</Badge>
      </div>
      <p className="mt-3 flex-1 text-sm leading-relaxed text-black/65">{description}</p>
      {disabled && disabledReason ? <p className="mt-3 text-xs font-mono text-black/45">{disabledReason}</p> : null}
      <button
        type="button"
        onClick={onAction}
        disabled={disabled}
        className={`btn-brutal-sm mt-3 w-full px-3 py-2 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-50 ${complete ? "bg-white" : "bg-brutal-pink"}`}
      >
        {actionLabel}
      </button>
    </div>
  );
}

function ArtifactRow({ artifact, active, onClick }: { artifact: WikiArtifactSummary; active: boolean; onClick: () => void }) {
  const { formatMessage } = useIntl();
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full border-2 p-3 text-left transition-colors ${
        active ? "border-black bg-white shadow-brutal-sm" : "border-transparent bg-white/70 hover:border-black hover:bg-white"
      }`}
    >
      <div className="flex items-start gap-2">
        <FileText size={14} className="mt-0.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-bold">{artifact.title}</div>
          {artifact.summary && <div className="mt-1 line-clamp-2 text-xs text-black/55">{artifact.summary}</div>}
        </div>
      </div>
      {((artifact.status && artifact.status !== "current") || artifact.sourcePolicy === "prefer_live_source") && (
        <div className="mt-2 flex flex-wrap gap-1">
          {artifact.status && artifact.status !== "current" && (
            <Badge variant={ARTIFACT_STATUS_VARIANT[artifact.status]}>{formatMessage({ id: WIKI_ARTIFACT_STATUS_LABEL_ID[artifact.status] })}</Badge>
          )}
          {artifact.sourcePolicy === "prefer_live_source" && <Badge variant="warning">{formatMessage({ id: "wiki.live" })}</Badge>}
        </div>
      )}
    </button>
  );
}

function KeyFact({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="border-2 border-black bg-brutal-cream p-3">
      <div className="mb-1 flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-black/60">
        {icon}
        {label}
      </div>
      <div className="truncate font-bold">{value}</div>
    </div>
  );
}

function EmptyList({ label, hint, busy = false }: { label: string; hint?: string; busy?: boolean }) {
  return (
    <div className="flex flex-col items-center gap-2 border-2 border-dashed border-black/30 bg-white/60 px-4 py-8 text-center">
      {busy ? <Spinner size="md" label={label} /> : <FileText size={20} className="text-black/30" />}
      <div className="text-xs font-bold uppercase tracking-wide text-black/40">{label}</div>
      {hint && <div className="max-w-56 text-xs text-black/40">{hint}</div>}
    </div>
  );
}
