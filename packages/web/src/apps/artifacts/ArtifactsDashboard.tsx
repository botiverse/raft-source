import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { ArrowLeft } from "lucide-react";
import {
  PanelAction,
  PanelHeader,
  PanelHeaderContent,
  PanelHeading,
  PanelMeta,
  PanelTitle,
} from "@botiverse/raft-ui";
import { ArtifactIcon } from "@botiverse/ricons";
import { WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import type {
  ArtifactCard,
  ArtifactDashboardAuthor,
  ArtifactWebDashboardAll,
} from "@botiverse/raft-shared";

import { useDebouncedValue } from "../../hooks/useDebouncedValue";
import { showToast } from "../../components/toastBridge";
import EmptyState from "../../components/ui/EmptyState";
import { useMediaQuery } from "../../hooks/effectPrimitives";
import { useServerFeatureFlag } from "../../store/serverFeatureFlags";
import { useServerPageDocumentLabel } from "../../utils/browserDocumentTitle";
import { useFocusRestore } from "../../hooks/useFocusRestore";
import { watchFocusIntent } from "../../utils/focusRequest";
import { artifactErrorCode } from "./artifactApi";
import { PHONE_QUERY } from "./artifactPhoneHistory";
import ArtifactViewer from "./ArtifactViewer";
import { artifactSource } from "./artifactSource";
import { useArtifactActivityChanged } from "./useArtifactActivityRefresh";
import { setArtifactReturnFocus } from "./artifactViewerStore";
import type { ArtifactLinkTarget, ArtifactOpenAddress, ArtifactOpenShown } from "./artifactLinks";
import type { ArtifactOpenSource } from "./artifactAnalytics";
import { useArtifactReaderId } from "./artifactAuthorText";
import { useArtifactDashboardPrefs } from "./artifactDashboardPrefs";
import { cacheDashboardPage, cachedDashboardPage, forgetDashboardPages } from "./artifactDashboardCache";
import type { ArtifactHomeSort } from "./artifactDashboardPrefs";
import type {
  AllState,
  ArtifactPlace,
  DashboardLayout,
  ShownCounts,
  TableProps,
} from "./artifactDashboardParts";
import { DashboardList } from "./ArtifactDashboardList";
import { ViewToggle } from "./ArtifactDashboardToolbar";

/**
 * The Artifacts home page (S7, G8): one list under a header like Tasks' (the
 * title, a count line), redesigned in #proj-workspace:#210 from Kirby's design
 * for xxchan's tablet: no tabs, one filter bar, every Artifact the reader can
 * see in the current server (`dashboardAll`). What the For you tab held is a
 * toggle in the bar (和我有关, `relevant`: every Artifact the reader is involved
 * with, read or not: one they or an agent they created published, one they follow, one a comment mentions them
 * on; what has something new for them first, a mention first of all, then the
 * rest by update; its badge counts only what is new, #proj-workspace:#276) and
 * what it called recently opened is the default order. The grid's tiles (ArtifactTile), or the list, which is a table on a
 * wider screen (ArtifactsTable) and one row per Artifact on a phone. The view,
 * the table's widths and the sort are kept on the device
 * (artifactDashboardPrefs). Every card names who made it (ArtifactAuthor), and
 * what is new on it is one pink sticker (ArtifactNewSticker, option B), the same
 * with the toggle on or off. The filters (conversation, author, the title search, the
 * toggle) are this page's own state: a new visit starts with none. Which conversation
 * or home (ArtifactConversationFilter) and which author: one of each.
 *
 * Reads only. Opening a row shows the viewer over the page, and opening the
 * current version is what clears what was new, so the page reads itself again
 * when the viewer closes, and on new activity (`activity:changed`) unless "Load More" has added rows, keeping its rows.
 * The viewer open is the host's address (`address`, `?artifact=`): Back closes
 * it and the list is as it was (its filters, search and scroll never left).
 *
 * The data comes from the app's data source (`dashboardAll`); the server is the
 * request's (X-Server-Id), so `serverId` only says when to read again.
 */
export interface ArtifactsDashboardProps {
  serverId: string | null;
  /** The phone header's Back (the host's navigation); none on a wider screen. */
  onMobileBack?: () => void;
  /**
   * What is open over the page, kept by the host: the route's address
   * (`?artifact=<id>`, `&version=<n>`: MainLayout's useArtifactOpenAddress),
   * which a row pushes, Back and close take away, and a reload or a copied
   * address opens again. Without one (a test), the page's own state.
   */
  address?: ArtifactOpenAddress;
}

/** Typing waits for a pause before the list asks again (the dashboard's 120 a minute). */
const ALL_SEARCH_DEBOUNCE_MS = 300;

type AllAction =
  | { type: "read"; generation: number; keepRows: boolean; keepCounts: boolean }
  | { type: "loaded"; generation: number; page: ArtifactWebDashboardAll; byOpened: boolean; narrowed: boolean }
  | { type: "failed"; generation: number; off: boolean }
  | { type: "paging" }
  | { type: "paged"; generation: number; page: ArtifactWebDashboardAll | null };

const INITIAL_ALL: AllState = { generation: 0, status: "idle", page: null, pageGeneration: 0, pageByOpened: false, counts: null, paging: false, extended: false };

/** The list's first state: the home page this tab last read for that reader, server and sort, shown as answered, else nothing yet. */
function cachedAllState({ readerId, serverId, sort }: { readerId: string | null; serverId: string | null; sort: string }): AllState {
  const hit = serverId === null ? null : cachedDashboardPage(readerId, serverId, sort);
  if (!hit) return INITIAL_ALL;
  const counts: ShownCounts | null = hit.page.counts ? { ...hit.page.counts, narrowed: false } : null;
  return { ...INITIAL_ALL, status: "ok", page: hit.page, pageByOpened: hit.byOpened, counts };
}

function allReducer(state: AllState, action: AllAction): AllState {
  switch (action.type) {
    case "read":
      return { ...state, generation: action.generation, status: "loading", page: action.keepRows ? state.page : null, counts: action.keepCounts ? state.counts : null, paging: false };
    case "loaded": {
      if (action.generation !== state.generation) return state;
      const counts: ShownCounts | null = action.page.counts ? { ...action.page.counts, narrowed: action.narrowed } : state.counts;
      return { ...state, status: "ok", page: action.page, pageGeneration: action.generation, pageByOpened: action.byOpened, counts, extended: false };
    }
    case "failed":
      if (action.generation !== state.generation) return state;
      return { ...state, status: action.off ? "off" : "failed" };
    case "paging":
      return { ...state, paging: true };
    case "paged": {
      // A page counts only against the rows it continues, and not while a read is replacing them: its cursor would
      // point past rows that have moved. A read that failed replaced nothing, so the rows on screen still hold.
      const current = action.generation === state.pageGeneration && state.status !== "loading";
      if (!action.page || !current || !state.page) return { ...state, paging: false };
      const seen = new Set(state.page.rows.map((row) => row.card.id));
      const rows = [...state.page.rows, ...action.page.rows.filter((row) => !seen.has(row.card.id))];
      return { ...state, paging: false, page: { rows, nextCursor: action.page.nextCursor }, extended: true };
    }
  }
}

/**
 * The list's rows (`dashboardAll`): read when there is a server to read, again
 * for a new server, filter or search (from the skeleton), a new sort (the
 * server sorts: the first page again, the rows on screen kept until it answers,
 * so the table stays; what the rows' time says follows them, `pageByOpened`, which
 * a read that fails leaves as it was, and takes the sort back to it); "Show more" continues the rows on screen
 * with the filter, search and sort they were read for (a cursor pages only its
 * own order). An answer to an older read is dropped, so pages of two orders never
 * mix. `relevant` asks for no sort: the server fixes the order.
 */
function useAllArtifacts(active: boolean, serverId: string | null, place: ArtifactPlace | null, q: string, author: ArtifactDashboardAuthor | null, sort: ArtifactHomeSort, relevant: boolean, onSortFailed: (sort: ArtifactHomeSort) => void) {
  const { formatMessage } = useIntl();
  const readerId = useArtifactReaderId();
  const placeKey = place === null ? "" : place.kind === "home" ? `home:${place.home}` : place.conversation.id;
  const filterKey = `${serverId ?? ""}|${placeKey}|${q}|${author ?? ""}|${relevant}`;
  const key = `${filterKey}|${sort}`;
  // The home's page last read in this tab (artifactDashboardCache): on screen at once, read again behind it. A page
  // mounts with no filter, search or toggle, so only that list is kept.
  const [state, dispatch] = useReducer(allReducer, { readerId, serverId, sort }, cachedAllState);
  const generation = useRef(0);
  // An answer that lands after the page went away is no one's: it doesn't overwrite a newer visit's kept page.
  useEffect(() => () => { generation.current += 1; }, []);
  // Each sort goes in its default direction; `updated`, the server's own order, is asked for by none (the only one an
  // older server knows).
  const options = useMemo(() => ({
    ...(place?.kind === "home" ? { home: place.home } : place ? { conversation: place.conversation.id } : {}),
    ...(q ? { q } : {}),
    ...(author ? { author: [author] } : {}),
    ...(relevant ? { relevant } : sort === "updated" ? {} : { sort }),
  }), [place, q, author, sort, relevant]);
  const narrowed = place !== null || q !== "" || author !== null || relevant;
  // What the rows on screen were read with: their cursor continues only that.
  const shownOptions = useRef(options);
  // The sort of the last read that answered: where a re-sort that fails goes back to.
  const answeredSort = useRef(sort);

  /** Reads the first page; resolves once its answer is on screen (or dropped). */
  const read = useCallback((keepRows: boolean, keepCounts = true) => {
    const current = ++generation.current;
    dispatch({ type: "read", generation: current, keepRows, keepCounts });
    return artifactSource().dashboardAll(options).then(
      (page) => {
        if (current === generation.current) {
          shownOptions.current = options;
          answeredSort.current = sort;
          if (!narrowed && serverId !== null) cacheDashboardPage(readerId, serverId, sort, { page, byOpened: sort === "opened" });
        }
        dispatch({ type: "loaded", generation: current, page, byOpened: !relevant && sort === "opened", narrowed });
      },
      (error: unknown) => {
        const off = artifactErrorCode(error) === "ARTIFACTS_NOT_ENABLED";
        // Rows this reader can't have any more aren't shown again on the next visit.
        if (serverId !== null) forgetDashboardPages(serverId);
        dispatch({ type: "failed", generation: current, off });
        // The control goes back with the rows, which that sort never replaced: its value is what they show.
        if (off || current !== generation.current || answeredSort.current === sort) return;
        showToast({ title: formatMessage({ id: "artifacts.dashboard.failedTitle" }), type: "warning" });
        onSortFailed(answeredSort.current);
      },
    );
  }, [options, sort, relevant, narrowed, readerId, serverId, formatMessage, onSortFailed]);

  // What the rows on screen were read for: the same filter again (another sort) keeps them while it reads, and so
  // does a page shown from the cache.
  const readFor = useRef<string | null>(state.page ? filterKey : null);
  const readServer = useRef(serverId);
  useEffect(() => {
    if (!active) return;
    const keepRows = readFor.current === filterKey;
    // Another server's numbers say nothing here; this server's stand until the new filter's answer.
    const keepCounts = readServer.current === serverId;
    readFor.current = filterKey;
    readServer.current = serverId;
    // oxlint-disable-next-line react-doctor/no-event-handler -- A read keyed on the server, the flag, the filter, the sort and the (settled) search: the server changes outside this page, the flag resolves after mount, and the search settles after typing pauses.
    void read(keepRows, keepCounts);
  }, [active, key, filterKey, serverId, read]);

  const { pageGeneration } = state;
  const shownGeneration = useRef(pageGeneration);
  shownGeneration.current = pageGeneration;
  const loadMore = useCallback((cursor: string) => {
    dispatch({ type: "paging" });
    void artifactSource().dashboardAll({ ...shownOptions.current, cursor }).then(
      (next) => dispatch({ type: "paged", generation: pageGeneration, page: next }),
      (error: unknown) => {
        dispatch({ type: "paged", generation: pageGeneration, page: null });
        if (shownGeneration.current !== pageGeneration) return;
        // A cursor the server no longer takes (400: one of an older shape, across a deploy) would fail every retry: the
        // list starts again from its first page, the rows on screen until it answers.
        if ((error as { status?: unknown } | null)?.status === 400) {
          void read(true);
          return;
        }
        showToast({ title: formatMessage({ id: "artifacts.dashboard.moreFailed" }), type: "warning" });
      },
    );
  }, [pageGeneration, formatMessage, read]);

  return { state, read, loadMore };
}

/** The open Artifact in the page's own state, for a host with no address: what a host's address does, with no history. */
function useLocalOpenAddress(): ArtifactOpenAddress {
  const [shown, setShown] = useState<ArtifactOpenShown | null>(null);
  const open = useCallback((target: ArtifactLinkTarget, source: ArtifactOpenSource) => setShown({ ...target, source }), []);
  const close = useCallback(() => setShown(null), []);
  const showVersion = useCallback((version: number | null) => setShown((current) => (current ? { ...current, version } : current)), []);
  return useMemo(() => ({ shown, open, close, showVersion }), [shown, open, close, showVersion]);
}

export default function ArtifactsDashboard({ serverId, onMobileBack, address: hostAddress }: ArtifactsDashboardProps) {
  const { formatMessage } = useIntl();
  const flag = useServerFeatureFlag(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY);
  const phone = useMediaQuery(PHONE_QUERY);
  const readerId = useArtifactReaderId();
  const { prefs, setView, setWidth, setSort } = useArtifactDashboardPrefs();
  // The list view is the table on a wider screen and one row per Artifact on a phone (design D20, p3).
  const layout: DashboardLayout = prefs.view === "grid" ? "grid" : phone ? "rows" : "table";
  const localAddress = useLocalOpenAddress();
  const address = hostAddress ?? localAddress;
  const open = address.shown;
  // The list's place of the row it was opened from, for focus once it closes (none: opened by an address).
  const openedFrom = useRef<number | null>(null);
  const enabled = flag.enabled;

  const [place, setPlace] = useState<ArtifactPlace | null>(null);
  const [author, setAuthor] = useState<ArtifactDashboardAuthor | null>(null);
  // Both name someone or somewhere in one server, and the page stays mounted across servers: another's list starts with neither.
  // oxlint-disable-next-line react-doctor/no-derived-useState -- not a copy to keep in sync: the server the filters were set in, compared with the prop below to reset them while rendering.
  const [filtersServer, setFiltersServer] = useState(serverId);
  if (filtersServer !== serverId) {
    setFiltersServer(serverId);
    setPlace(null);
    setAuthor(null);
  }
  const [search, setSearch] = useState("");
  const query = useDebouncedValue(search.trim(), ALL_SEARCH_DEBOUNCE_MS);
  const [relevant, setRelevant] = useState(false);
  const all = useAllArtifacts(enabled && serverId !== null, serverId, place, query, author, prefs.listSort, relevant, setSort);
  // The list is a raft-ui ScrollArea: its overlay scrollbar takes no width, so
  // the rows' shapes sit 8px from both edges on every platform.
  const listRef = useRef<HTMLDivElement | null>(null);

  const { read } = all;
  // New activity on this server's Artifacts: the list again, rows kept (none under a viewer: closing reads it). Not past
  // the first page: a read would take away the rows "Load More" added, and this fires on any activity on the server.
  const { extended } = all.state;
  useArtifactActivityChanged(enabled && serverId && open === null ? serverId : null, null, () => (extended ? Promise.resolve() : read(true)));

  const { open: openAddress, close: closeViewer } = address;
  const openArtifact = useCallback((card: ArtifactCard, from: HTMLElement, index: number) => {
    setArtifactReturnFocus(from);
    openedFrom.current = index;
    openAddress({ id: card.id, version: null }, "all");
  }, [openAddress]);

  // However it closed (its close, Escape, Back, the address changed by hand): the list as it was, read again.
  // Opening it read the current version: what waited or was new may be gone, and the Artifact may have moved in the
  // order. If the item that had focus went with it, focus goes to the item now in its place (or the last), else to
  // the list. Every view's opener is `[data-artifact-open]`. Only when focus went nowhere (useFocusRestore): someone
  // who moved it on (to the filter, say) keeps it there.
  const restoreAt = useRef<number | null>(null);
  const restoreFocus = useFocusRestore(() => {
    const list = listRef.current;
    const index = restoreAt.current;
    const triggers = list && index !== null ? [...list.querySelectorAll<HTMLElement>("[data-artifact-open]")] : [];
    return [triggers[Math.min(index ?? 0, triggers.length - 1)], list];
  });
  const shown = open !== null;
  const wasShown = useRef(shown);
  useEffect(() => {
    const closed = wasShown.current && !shown;
    wasShown.current = shown;
    if (!closed) return;
    restoreAt.current = openedFrom.current;
    openedFrom.current = null;
    // A press while the list is read again is the person moving on (focus plan rule 3), wherever it put focus.
    const wanted = watchFocusIntent();
    void read(true).then(() => {
      if (wanted()) restoreFocus();
    });
  }, [shown, read, restoreFocus]);

  const table = useMemo<TableProps>(() => ({ widths: prefs.widths, onWidthChange: setWidth }), [prefs.widths, setWidth]);

  // The tab's title (`Artifacts | <server> | Raft`): the Artifact open over the page names it once its viewer has
  // loaded it, and the page's own name comes back when it closes. One the reader can't open names nothing.
  const [viewerTitle, setViewerTitle] = useState<string | null>(null);
  useServerPageDocumentLabel(open !== null && viewerTitle !== null ? viewerTitle : formatMessage({ id: "artifacts.dashboard.title" }));

  const { counts } = all.state;
  const header = (
    <PanelHeader data-testid="artifacts-dashboard-header">
      {onMobileBack ? (
        <PanelAction aria-label={formatMessage({ id: "artifacts.dashboard.back" })} onClick={onMobileBack} className="md:hidden">
          <ArrowLeft />
        </PanelAction>
      ) : null}
      <PanelHeaderContent>
        <PanelHeading>
          <PanelTitle render={<h1>{formatMessage({ id: "artifacts.dashboard.title" })}</h1>} />
        </PanelHeading>
        {counts ? <PanelMeta render={<p />} data-testid="artifacts-dashboard-count">{countLine(formatMessage, counts)}</PanelMeta> : null}
      </PanelHeaderContent>
    </PanelHeader>
  );

  if ((flag.resolved && !enabled) || all.state.status === "off") {
    return (
      <div className="flex min-h-0 flex-1 flex-col bg-layer-canvas" data-testid="artifacts-dashboard">
        {header}
        <EmptyState
          className="flex flex-1 flex-col items-center justify-center p-6"
          icon={<ArtifactIcon width={36} height={36} />}
          title={formatMessage({ id: "artifacts.dashboard.offTitle" })}
          titleHeading="h2"
          data-testid="artifacts-dashboard-off"
        />
      </div>
    );
  }

  return (
    // A column of list cells: its head, filter row and rows share one edge,
    // 20px at every width (raft-ui --column-margin; raft-design patterns/lists.md).
    <div className="relative flex min-h-0 flex-1 flex-col bg-layer-canvas [--column-margin:20px]" data-testid="artifacts-dashboard">
      {/* The page under the viewer is a layer of its own (`isolate`): its header is sticky at z-chrome on
          a phone (PanelHeader). The viewer's z-cover is above that already; the isolate keeps it so.
          A pushed page covers the page under it (page structure), so the viewer is above all of it. */}
      <div className="isolate flex min-h-0 flex-1 flex-col" inert={open !== null || undefined} data-testid="artifacts-dashboard-page">
        {header}
        <DashboardList
          all={all}
          place={place}
          onPlace={setPlace}
          author={author}
          onAuthor={setAuthor}
          search={search}
          onSearch={setSearch}
          query={query}
          relevant={relevant}
          onRelevant={setRelevant}
          sort={prefs.listSort}
          onSort={setSort}
          listRef={listRef}
          onOpen={openArtifact}
          layout={layout}
          phone={phone}
          view={<ViewToggle view={prefs.view} onChange={setView} />}
          readerId={readerId}
          table={table}
        />
      </div>
      {open ? (
        <div className="absolute inset-0 z-cover flex flex-col bg-layer-canvas" data-testid="artifacts-dashboard-viewer">
          {/* A page over the page: Back on a phone (page structure), close beside the expanded card elsewhere. Its
              history entry is the address's (`?artifact=`), on a phone too: no entry of its own (usePhoneHistoryEntry). */}
          <ArtifactViewer key={open.id} target={open} source={open.source} expanded covering={phone} ownBack onClose={closeViewer} onShowVersion={address.showVersion} onShownTitle={setViewerTitle} />
        </div>
      ) : null}
    </div>
  );
}

/** The header's line (design, as Tasks': "24 Artifacts", and "5 of 24 Artifacts" with any filter on), its numbers in Space Mono. */
function countLine(formatMessage: ReturnType<typeof useIntl>["formatMessage"], { total, filtered, narrowed }: ShownCounts): ReactNode {
  const filteredNumber = (chunks: ReactNode[]) => <span key="filtered" className="font-mono">{chunks}</span>;
  const totalNumber = (chunks: ReactNode[]) => <span key="total" className="font-mono">{chunks}</span>;
  return narrowed
    ? formatMessage({ id: "artifacts.dashboard.countFiltered" }, { filtered, total, n: filteredNumber, t: totalNumber })
    : formatMessage({ id: "artifacts.dashboard.count" }, { count: total, n: totalNumber });
}
