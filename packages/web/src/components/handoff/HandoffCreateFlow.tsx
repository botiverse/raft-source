import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { useIntl } from "react-intl";
import { useNavigate } from "react-router-dom";
import { FolderOpen, Search, TriangleAlert } from "lucide-react";

import { useAgentStore } from "../../store/agentStore";
import type { Agent } from "../../store/agentStore";
import { useChannelStore } from "../../store/channelStore";
import { useMessageStore } from "../../store/messageStore";
import { useMachineStore } from "../../store/machineStore";
import { useServerStore } from "../../store/serverStore";
import SectionEyebrow from "../ui/SectionEyebrow";
import { Badge, Banner, BannerDescription, Button, Card, DescriptionDetails, DescriptionItem, DescriptionList, DescriptionTerm, Input, InputGroup, InputGroupAddon, InputGroupInput, ScrollArea, SegmentedControl, Spinner, ListRow, ListRowBody, ListRowGroup, ListRowIcon, ListRowMeta, ListRowTitle, TextLink } from "@botiverse/raft-ui";
import {
  dirBasename,
  getHandoffBridge,
  pickLocalOnlineMachine,
  searchReducer,
  TOOL_LABEL,
} from "./handoffSessions";
import type { LocalSession, SessionExcerpt } from "./handoffSessions";
import { useLocalComputerIdentity } from "../machine/localComputer/localComputerStore";
import { HandoffToolTab } from "./HandoffToolTab";
import { DialogCardFooter, DialogCommit } from "../ui/NarrowDialog";

// Desktop-only Handoff flow (#kabi-desktop task #13; design: raft-artifacts
// desktop-handoff-design v2). Since task #104 it is the "start from a local
// Claude Code / Codex session" option INSIDE Create Agent, not a rail page:
// handoff is a create-agent with a fixed starting point, so it lives where
// agents are created. The flow lists recent LOCAL sessions via the electron
// bridge and migrates the selected one into a normal Raft agent: existing
// createAgent API + a briefing DM the user previews and confirms. No
// protocol/daemon/server changes by design — the transcript stays on this
// machine; only the previewed briefing is sent.
//
// Two stages inline (no nested dialog — this already sits in the Create Agent
// dialog): pick a session → the locked-down form (name editable; computer /
// runtime / model fixed by the session) with the briefing preview.

export interface HandoffFlowState {
  /** createAgent / briefing send in flight — the flow must not be unmounted or closed. */
  creating: boolean;
  /** The agent exists but the briefing has not been delivered; a retry is offered. */
  retryPending: boolean;
}

const HANDOFF_TOOLS = ["claude-code", "codex"] as const;

export default function HandoffCreateFlow({ onClose, onStateChange }: {
  /** Closes the hosting Create Agent dialog (Cancel, and after a successful handoff). */
  onClose: () => void;
  /**
   * Busy-state report for the HOST (review of #8024): the host owns the
   * start-mode switch and the dialog close, so it must know when switching
   * away would abandon an in-flight create or a pending briefing retry.
   * Reports `{ creating: false, retryPending: false }` on unmount.
   */
  onStateChange?: (state: HandoffFlowState) => void;
}) {
  const { formatMessage, formatRelativeTime } = useIntl();

  const formatSessionAge = useCallback((lastActiveAt: number) => {
    const minutes = Math.round((lastActiveAt - Date.now()) / 60000);
    if (Math.abs(minutes) < 60) return formatRelativeTime(minutes, "minute", { style: "narrow" });
    const hours = Math.round(minutes / 60);
    if (Math.abs(hours) < 48) return formatRelativeTime(hours, "hour", { style: "narrow" });
    return formatRelativeTime(Math.round(hours / 24), "day", { style: "narrow" });
  }, [formatRelativeTime]);
  const navigate = useNavigate();
  const serverSlug = useServerStore((s) => s.current?.slug ?? null);
  const machines = useMachineStore((s) => s.machines);
  const createAgent = useAgentStore((s) => s.createAgent);
  const openDM = useChannelStore((s) => s.openDM);
  const sendMessage = useMessageStore((s) => s.sendMessage);

  const bridge = getHandoffBridge();
  const [sessions, setSessions] = useState<LocalSession[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<LocalSession | null>(null);
  const [excerpt, setExcerpt] = useState<SessionExcerpt | null>(null);
  const [agentName, setAgentName] = useState("");
  // Which of the server's machines this app runs on (localComputerStore).
  const localIdentity = useLocalComputerIdentity();
  const [excerptFailed, setExcerptFailed] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createdAgent, setCreatedAgent] = useState<Agent | null>(null);
  // Full-content search runs in the desktop main process (bodies live on disk).
  // A reducer keeps the scan effect to plain dispatches (one state machine).
  const [search, dispatchSearch] = useReducer(searchReducer, { status: "idle" });
  const searchGenRef = useRef(0);
  const supportsContentSearch = typeof bridge?.searchContent === "function";

  // Unmount guard for the async confirm: if the host still unmounts the flow
  // mid-create (it should not — see onStateChange), the late continuation must
  // not close/navigate a dialog that now hosts something else.
  // Set in SETUP and cleared in cleanup (symmetric): under React StrictMode the
  // mount effect runs setup → cleanup → setup, so a cleanup-only guard would stay
  // false forever and the confirm continuation would silently bail (review of
  // #8024 round 2: agent created, stuck "Creating…", no briefing, cannot close).
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  // Busy state is reported from the event handlers that change it (not from an
  // effect watching state): `creating` and `createdAgent` only ever change in
  // selectSession / chooseAnother / confirm below. The unmount cleanup resets it.
  const reportState = useCallback((next: { creating: boolean; createdAgent: Agent | null }) => {
    onStateChange?.({ creating: next.creating, retryPending: next.createdAgent !== null && !next.creating });
  }, [onStateChange]);
  useEffect(() => () => { onStateChange?.({ creating: false, retryPending: false }); }, [onStateChange]);

  useEffect(() => {
    // The bridge is a stable global in the desktop shell, so this runs once.
    const bridge = getHandoffBridge();
    if (!bridge) return;
    let alive = true;
    bridge.listSessions()
      .then((list) => { if (alive) setSessions(list); })
      .catch(() => { if (alive) setLoadError(true); });
    return () => { alive = false; };
  }, []);

  const localMachine = useMemo(
    () => pickLocalOnlineMachine(machines, localIdentity),
    [machines, localIdentity],
  );

  // Debounced full-content search. A newer query supersedes: the renderer bumps a
  // generation (discards stale results) AND the main-process scan self-cancels
  // because each call bumps its own generation there. No-op without bridge support.
  useEffect(() => {
    // bridge is a stable global in the desktop shell; only `query` changes.
    const searchFn = getHandoffBridge()?.searchContent;
    if (!searchFn) return;
    const q = query.trim();
    // Clearing the box: discard any pending resolve AND cancel the in-flight
    // main-process scan (an empty query bumps its generation and aborts its reads).
    if (!q) {
      searchGenRef.current += 1;
      dispatchSearch({ type: "reset" });
      void searchFn("").catch(() => {});
      return;
    }
    const gen = ++searchGenRef.current;
    dispatchSearch({ type: "pending", query: q });
    const timer = setTimeout(() => {
      searchFn(q)
        .then((res) => {
          if (gen === searchGenRef.current) dispatchSearch({ type: "done", query: q, summaries: res.matches, complete: res.complete });
        })
        .catch(() => {
          if (gen === searchGenRef.current) dispatchSearch({ type: "done", query: q, summaries: [], complete: false });
        });
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  // On unmount, cancel any in-flight scan so it stops reading transcripts.
  useEffect(() => {
    const bridge = getHandoffBridge();
    return () => {
      searchGenRef.current += 1;
      void bridge?.searchContent?.("").catch(() => {});
    };
  }, []);

  const filtered = useMemo(() => {
    const list = sessions ?? [];
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return list;
    // Metadata-only AND over the loaded list: id + directory + model + title. These
    // are confirmed hits that must NEVER disappear — not while the scan is pending,
    // and not if the scan fails or is truncated.
    const metadataMatch = (s: LocalSession) => {
      const haystack = [s.sessionId, s.cwd, s.model, s.title].filter(Boolean).join("\n").toLowerCase();
      return terms.every((t) => haystack.includes(t));
    };
    const metaHits = list.filter(metadataMatch);
    if (!supportsContentSearch) return metaHits;
    // Union the confirmed metadata hits with the scan's summaries (which carry
    // cross-field + body matches AND may lie outside the recency-bounded list),
    // deduped by session id. On scan failure/truncation, summaries is empty, so at
    // least the metadata hits survive.
    const scanHits = search.status === "done" && search.query === query.trim() ? search.summaries : [];
    const byId = new Map<string, LocalSession>();
    for (const s of metaHits) byId.set(s.sessionId, s);
    for (const s of scanHits) if (!byId.has(s.sessionId)) byId.set(s.sessionId, s);
    return [...byId.values()].sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  }, [sessions, query, supportsContentSearch, search]);

  const searching = supportsContentSearch && search.status === "pending";
  const searchIncomplete = supportsContentSearch
    && search.status === "done"
    && search.query === query.trim()
    && !search.complete;

  const grouped = useMemo(() => ({
    "claude-code": filtered.filter((s) => s.tool === "claude-code"),
    codex: filtered.filter((s) => s.tool === "codex"),
  }), [filtered]);

  // One list at a time, switched by a segmented control (task #110, @WAWQAQ:
  // the two-column layout did not fit the dialog). Until the user picks a tool,
  // the active tab follows the data: Claude Code unless it has nothing and Codex
  // does. Counts follow the current search so the other tab's hits stay visible.
  const [toolChoice, setToolChoice] = useState<LocalSession["tool"] | null>(null);
  const activeTool: LocalSession["tool"] = toolChoice
    ?? (grouped["claude-code"].length === 0 && grouped.codex.length > 0 ? "codex" : "claude-code");

  // Request GENERATION, not path identity: reopening the SAME session must
  // also invalidate an earlier in-flight excerpt (open A → cancel → open A —
  // the first request may resolve last). Cancel, reselect, and unmount all
  // bump the generation so only the newest request may write the preview.
  const excerptGenRef = useRef(0);
  const briefingRandomIdRef = useRef<string | null>(null);
  useEffect(() => () => { excerptGenRef.current += 1; }, []);
  const selectSession = useCallback((session: LocalSession) => {
    setSelected(session);
    setExcerpt(null);
    setExcerptFailed(false);
    setCreateError(null);
    setCreatedAgent(null);
    reportState({ creating: false, createdAgent: null });
    setAgentName(dirBasename(session.cwd) ?? TOOL_LABEL[session.tool]);
    briefingRandomIdRef.current = null;
    const generation = ++excerptGenRef.current;
    if (bridge) {
      bridge.sessionExcerpt({ transcriptPath: session.transcriptPath, tool: session.tool })
        .then((result) => {
          if (excerptGenRef.current === generation) setExcerpt(result);
        })
        .catch(() => {
          if (excerptGenRef.current === generation) {
            // Visible degradation, not silent success: the form shows a
            // warning and the preview reflects the missing recent context.
            setExcerptFailed(true);
            setExcerpt({ firstUserMessage: session.title, recentExcerpt: "" });
          }
        });
    }
  }, [bridge, reportState]);

  const briefing = useMemo(() => {
    if (!selected) return "";
    return formatMessage(
      { id: "handoff.briefing.template" },
      {
        tool: TOOL_LABEL[selected.tool],
        model: selected.model ?? formatMessage({ id: "handoff.wizard.modelUnknown" }),
        cwd: selected.cwd ?? "-",
        firstMessage: excerpt?.firstUserMessage ?? selected.title ?? "-",
        recent: excerpt?.recentExcerpt ?? "",
      },
    );
  }, [selected, excerpt, formatMessage]);

  // Back to the list. No-ops while creation is in flight so the form cannot
  // be abandoned mid-create and a second create started from another row.
  const chooseAnother = useCallback(() => {
    if (creating) return;
    setSelected(null);
    setCreatedAgent(null);
    reportState({ creating: false, createdAgent: null });
    excerptGenRef.current += 1;
  }, [creating, reportState]);

  const confirm = useCallback(async () => {
    if (!selected || !localMachine || creating) return;
    setCreating(true);
    reportState({ creating: true, createdAgent });
    setCreateError(null);
    // Stage 1 — create the agent, exactly once: a briefing failure below must
    // not create a second agent for the same directory on retry.
    let agent = createdAgent;
    if (!agent) {
      try {
        agent = await createAgent(agentName.trim() || (dirBasename(selected.cwd) ?? "handoff"), {
          description: formatMessage(
            { id: "handoff.agent.description" },
            { tool: TOOL_LABEL[selected.tool], cwd: selected.cwd ?? "-" },
          ),
          // The agent must continue on the session's own runtime — a Codex
          // session on the default (claude) runtime would mismatch its model.
          runtime: selected.tool === "codex" ? "codex" : "claude",
          ...(selected.model ? { model: selected.model } : {}),
          machineId: localMachine.id,
        });
        if (!mountedRef.current) return;
        setCreatedAgent(agent);
      } catch (error) {
        if (!mountedRef.current) return;
        setCreateError(error instanceof Error ? error.message : String(error));
        setCreating(false);
        reportState({ creating: false, createdAgent: null });
        return;
      }
    }
    // Stage 2 — open the DM and send the briefing; retry re-runs only this.
    // The random id is stable across retries so an uncertain first send (e.g.
    // network cut after the server accepted) deduplicates instead of doubling.
    if (!briefingRandomIdRef.current) briefingRandomIdRef.current = crypto.randomUUID();
    try {
      const dm = await openDM(agent.id);
      await sendMessage(dm.id, briefing, undefined, undefined, undefined, briefingRandomIdRef.current);
      if (!mountedRef.current) return;
      // Done: leave the flow settled before the hosting dialog closes and the
      // app navigates to the new agent's DM (closing normally unmounts this
      // flow, but it must not stay stuck "creating" if it does not).
      setSelected(null);
      setCreatedAgent(null);
      setCreating(false);
      reportState({ creating: false, createdAgent: null });
      excerptGenRef.current += 1;
      onClose();
      if (serverSlug) navigate(`/s/${serverSlug}/dm/${dm.id}`);
    } catch (error) {
      if (!mountedRef.current) return;
      const detail = error instanceof Error ? error.message : String(error);
      setCreateError(
        `${formatMessage({ id: "handoff.wizard.briefingFailed" }, { name: agent.displayName ?? agent.name })} ${detail}`,
      );
      setCreating(false);
      reportState({ creating: false, createdAgent: agent });
    }
  }, [selected, localMachine, creating, createdAgent, createAgent, agentName, formatMessage, openDM, sendMessage, briefing, serverSlug, navigate, onClose, reportState]);

  const handleConfirmClick = useCallback(() => {
    void confirm();
  }, [confirm]);

  const handleAgentNameChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setAgentName(event.target.value);
  }, []);

  const handleQueryChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setQuery(event.target.value);
  }, []);

  if (!bridge) {
    return (
      <div className="flex items-center justify-center p-8 text-callout text-foreground-muted" data-testid="handoff-desktop-only">
        {formatMessage({ id: "handoff.desktopOnly" })}
      </div>
    );
  }

  const cancelButton = (
    <Button size="lg"
      type="button"
      variant="ghost"
      onClick={onClose}
      disabled={creating}
    >
      {formatMessage({ id: "handoff.wizard.cancel" })}
    </Button>
  );

  if (selected) {
    return (
      <div data-testid="handoff-create-form" className="flex flex-col">
        <Card className="mb-3 flex-row items-start justify-between gap-3 px-3 py-2">
          <div className="min-w-0">
            <SectionEyebrow as="div" className="mb-0.5">{formatMessage({ id: "handoff.selectedSession" })}</SectionEyebrow>
            <div className="truncate text-subhead font-semibold text-foreground">
              {selected.title ?? formatMessage({ id: "handoff.untitledSession" })}
            </div>
            <div className="truncate font-mono text-mono-meta text-foreground-hint">
              {TOOL_LABEL[selected.tool]} · {selected.cwd ?? "-"}
            </div>
          </div>
          <TextLink
            onClick={chooseAnother}
            disabled={creating}
            data-testid="handoff-choose-another"
            className="shrink-0"
          >
            {formatMessage({ id: "handoff.wizard.chooseAnother" })}
          </TextLink>
        </Card>

        {selected.activeRecently && (
          <Banner status="warning" className="mb-3">
            <BannerDescription>
              {formatMessage({ id: "handoff.wizard.activeWarning" }, { tool: TOOL_LABEL[selected.tool] })}
            </BannerDescription>
          </Banner>
        )}

        <label className="mb-1 block text-footnote font-semibold text-foreground-muted" htmlFor="handoff-agent-name">
          {formatMessage({ id: "handoff.wizard.agentName" })}
        </label>
        <Input
          id="handoff-agent-name"
          value={agentName}
          onChange={handleAgentNameChange}
          data-testid="handoff-agent-name-input"
          className="mb-3 w-full"
        />

        {/* DS PropertyList: what the session fixes (model, directory, Computer)
            is read-only; its machine values are Space Mono. */}
        <DescriptionList direction="horizontal" className="mb-3">
          <DescriptionItem>
            <DescriptionTerm>{formatMessage({ id: "handoff.wizard.model" })}</DescriptionTerm>
            <DescriptionDetails>
              {selected.model
                ? <span className="min-w-0 truncate font-mono text-mono-meta">{selected.model}</span>
                : <span className="min-w-0 truncate text-foreground-hint">{formatMessage({ id: "handoff.wizard.modelUnknown" })}</span>}
            </DescriptionDetails>
          </DescriptionItem>
          <DescriptionItem>
            <DescriptionTerm>{formatMessage({ id: "handoff.wizard.directory" })}</DescriptionTerm>
            <DescriptionDetails>
              <span className="min-w-0 truncate font-mono text-mono-meta">{selected.cwd ?? "-"}</span>
            </DescriptionDetails>
          </DescriptionItem>
          <DescriptionItem>
            <DescriptionTerm>{formatMessage({ id: "handoff.wizard.computer" })}</DescriptionTerm>
            <DescriptionDetails>
              {localMachine
                ? <span className="min-w-0 truncate font-mono text-mono-meta">{localMachine.name || localMachine.hostname}</span>
                : <span className="min-w-0 truncate text-footnote font-semibold text-warning-strong">{formatMessage({ id: "handoff.wizard.computerMissing" })}</span>}
            </DescriptionDetails>
          </DescriptionItem>
        </DescriptionList>

        {excerptFailed && (
          <Banner status="warning" className="mb-2">
            <BannerDescription>
              {formatMessage({ id: "handoff.wizard.excerptFailed" })}
            </BannerDescription>
          </Banner>
        )}
        <label className="mb-1 block text-footnote font-semibold text-foreground-muted">
          {formatMessage({ id: "handoff.wizard.briefingPreview" })}
        </label>
        {/* The code frame scrolls in a raft-ui ScrollArea (a <pre> holds
            phrasing content only, so the area frames it); the padding is on
            the <pre>, inside, so the scrollbar sits at the frame's edge. In
            the dialog's scroller, so a scroll at its end carries on. */}
        <ScrollArea
          role="region"
          aria-label={formatMessage({ id: "handoff.wizard.briefingPreview" })}
          overscroll="auto"
          className="mb-3 max-h-48 rounded-container border border-line-hairline bg-layer-code"
        >
          <pre className="m-0 whitespace-pre-wrap break-words px-3 py-2 font-mono text-mono-code text-foreground">
            {excerpt === null ? formatMessage({ id: "handoff.loading" }) : briefing}
          </pre>
        </ScrollArea>

        {createError && (
          <Banner status="warning" className="mb-3">
            <BannerDescription>
              {createError}
            </BannerDescription>
          </Banner>
        )}

        <DialogCardFooter>
          {cancelButton}
          <DialogCommit>
            {(inHead) => (
              <Button size={inHead ? "md" : "lg"}
                type="button"
                variant="primary"
                disabled={creating || excerpt === null || !localMachine}
                onClick={handleConfirmClick}
                data-testid="handoff-confirm-button"
              >
                {creating
                  ? formatMessage({ id: "handoff.wizard.creating" })
                  : createdAgent
                    ? formatMessage({ id: "handoff.wizard.retryBriefing" })
                    : formatMessage({ id: "handoff.wizard.confirm" })}
              </Button>
            )}
          </DialogCommit>
        </DialogCardFooter>
      </div>
    );
  }

  return (
    <div data-testid="handoff-session-picker" className="flex flex-col">
      <InputGroup className="mb-3 w-full">
        <InputGroupAddon align="inline-start">
          <Search size={18} className="text-foreground-muted" aria-hidden="true" />
        </InputGroupAddon>
        <InputGroupInput
          value={query}
          onChange={handleQueryChange}
          placeholder={formatMessage({ id: "handoff.searchPlaceholder" })}
          aria-label={formatMessage({ id: "handoff.searchPlaceholder" })}
          data-testid="handoff-search-input"
        />
        {searching && (
          <InputGroupAddon align="inline-end">
            <span data-testid="handoff-search-pending" title={formatMessage({ id: "handoff.searching" })}>
              <Spinner size="sm" aria-label={formatMessage({ id: "handoff.searching" })} />
            </span>
          </InputGroupAddon>
        )}
      </InputGroup>

      {searchIncomplete && (
        <Banner status="warning" className="mb-3" data-testid="handoff-search-incomplete">
          <BannerDescription>
            {formatMessage({ id: "handoff.searchIncomplete" })}
          </BannerDescription>
        </Banner>
      )}

      {sessions === null && !loadError && (
        <div className="flex items-center gap-2 py-6 text-callout text-foreground-muted">
          <Spinner size="sm" aria-label={formatMessage({ id: "handoff.loading" })} />
          {formatMessage({ id: "handoff.loading" })}
        </div>
      )}
      {loadError && (
        <div className="py-6 text-footnote font-semibold text-warning-strong">{formatMessage({ id: "handoff.loadError" })}</div>
      )}
      {sessions !== null && filtered.length === 0 && !loadError && (
        <div className="py-6 text-center text-callout text-foreground-hint">{formatMessage({ id: "handoff.empty" })}</div>
      )}

      {sessions !== null && !loadError && (
        <SegmentedControl<LocalSession["tool"]>
          value={activeTool}
          onValueChange={setToolChoice}
          aria-label={formatMessage({ id: "handoff.toolSwitcher" })}
          className="mb-3"
        >
          {HANDOFF_TOOLS.map((tool) => (
            <HandoffToolTab
              key={tool}
              tool={tool}
              count={grouped[tool].length}
              onChoose={setToolChoice}
            />
          ))}
        </SegmentedControl>
      )}

      {sessions !== null && !loadError && filtered.length > 0 && (
        // Each session row is a button that takes focus: the list is no tab
        // stop. In the dialog's scroller: a scroll at its end carries on.
        <ScrollArea tabIndex={-1} overscroll="auto" className="max-h-[50vh]" data-testid={`handoff-tool-list-${activeTool}`}>
          {grouped[activeTool].length === 0 ? (
            <div className="rounded-container bg-fill-muted px-3 py-4 text-center text-callout text-foreground-hint">
              {formatMessage({ id: "handoff.toolEmpty" }, { tool: TOOL_LABEL[activeTool] })}
            </div>
          ) : (
            // Raft Design System › ListRow (raft-ui) in an inset list: a 20px
            // folder icon, the session's title and where it ran (machine
            // type), then the time. `plain`: the hairline between rows starts
            // at the row's 16px edge.
            <ListRowGroup>
              {grouped[activeTool].map((session) => (
                <HandoffSessionRow key={session.transcriptPath} session={session} age={formatSessionAge(session.lastActiveAt)} onSelect={selectSession} />
              ))}
            </ListRowGroup>
          )}
        </ScrollArea>
      )}

      <DialogCardFooter className="mt-4">
        {cancelButton}
      </DialogCardFooter>
    </div>
  );
}

/** One local session to hand off: a raft-ui `plain` ListRow (a 20px folder
 *  icon, the title, where it ran in machine type, then how long ago). */
function HandoffSessionRow({ session, age, onSelect }: { session: LocalSession; age: string; onSelect: (session: LocalSession) => void }) {
  const { formatMessage } = useIntl();
  const handleClick = useCallback(() => onSelect(session), [onSelect, session]);
  return (
    <ListRow variant="plain" data-testid="handoff-session-row" onClick={handleClick}>
      <ListRowIcon>
        <FolderOpen />
      </ListRowIcon>
      <ListRowBody>
        <ListRowTitle>
          {session.title ?? formatMessage({ id: "handoff.untitledSession" })}
        </ListRowTitle>
        <span className="truncate font-mono text-mono-meta text-foreground-hint">
          {session.cwd ?? "-"}{session.model ? ` · ${session.model}` : ""}
        </span>
      </ListRowBody>
      {session.activeRecently && (
        <Badge appearance="soft" variant="warning">
          <TriangleAlert aria-hidden="true" />
          {formatMessage({ id: "handoff.activeRecently" })}
        </Badge>
      )}
      <ListRowMeta>{age}</ListRowMeta>
    </ListRow>
  );
}
