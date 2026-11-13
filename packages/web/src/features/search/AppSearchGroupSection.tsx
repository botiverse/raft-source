// The app groups of global search (core's `GET /api/search`), one section
// each, drawn from the answer: as many sections as it has groups, in its
// order. What core search knows of an app is only how to draw its results and
// name its section, by the app's id (APP_SEARCH_RENDERERS, the web side of
// the contract's WebSearchItemsByApp: an app added there fails typecheck here
// until it has a row); which apps answer is the server's. The one thing the
// client asks first is whether any of them is on for the server at all (its
// flag, `flagKey`): with none on, the page doesn't ask the server.
import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { ComponentType, MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { useIntl } from "react-intl";
import { Button, SearchResultsList, SearchResultsSection, SearchResultsSectionHeading, Skeleton } from "@botiverse/raft-ui";
import type { WebSearchApp, WebSearchItemsByApp } from "@botiverse/raft-shared";
import { WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import { ArtifactSearchHit } from "../../apps/artifacts";
import type { SearchContentSlot } from "../../store/searchContentStore";
import { prefetchServerFeatureFlags, readServerFeatureFlagState, subscribeServerFeatureFlags } from "../../store/serverFeatureFlags";
import type { RegisteredServerFeatureFlagKey } from "../../store/serverFeatureFlags";
import type { MessageId } from "../../i18n/messages/en";
import AppBanner from "../../components/ui/Banner";
import type { AppGroupState, AppSearchPageGroup } from "./useAppSearchGroups";

interface AppHitRowProps<A extends WebSearchApp> {
  item: WebSearchItemsByApp[A];
  highlight: (text: string) => ReactNode;
  selected: boolean;
  onOpen: (event: ReactMouseEvent<HTMLButtonElement>) => void;
}

interface AppSearchRenderer<A extends WebSearchApp> {
  /**
   * The section's heading, the app's name: the contract names a group by its
   * app id only, so the label is the client's, by id.
   */
  labelId: MessageId;
  /** An item's identity within the group (selection, paging without repeats). */
  keyOf: (item: WebSearchItemsByApp[A]) => string;
  /** The hit's row: the app's own, from its card. */
  Row: ComponentType<AppHitRowProps<A>>;
  /**
   * What opening a hit shows in Search's detail area, as any result opens
   * there (#proj-workspace:#104: an Artifact clicked in Raft opens in the
   * layout it was clicked in).
   */
  slotOf: (item: WebSearchItemsByApp[A]) => SearchContentSlot;
  /**
   * The app's per-server flag: global search asks the server for app groups
   * only while at least one app's flag is on. Absent: always on (test apps).
   */
  flagKey?: RegisteredServerFeatureFlagKey;
}

function ArtifactHitRow({ item, ...props }: AppHitRowProps<"artifacts">) {
  return <ArtifactSearchHit hit={item} {...props} />;
}

const APP_SEARCH_RENDERERS: { [A in WebSearchApp]: AppSearchRenderer<A> } = {
  artifacts: {
    labelId: "search.appGroup.artifacts",
    keyOf: (hit) => hit.card.id,
    Row: ArtifactHitRow,
    // Its viewer in the detail area, beside the results (MainLayout's ArtifactContentSlot).
    slotOf: (hit) => ({ kind: "artifact", id: hit.card.id }),
    flagKey: WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY,
  },
};

// Test-only apps beside the real ones (as the server's routes/search tests
// register theirs): a page with two groups, or a group of an app that isn't Artifacts.
const testRenderers = new Map<string, AppSearchRenderer<WebSearchApp>>();

/** Test seam: draw groups of `app` with `renderer` until reset (null resets all). */
export function setAppSearchRendererForTests(app: string | null, renderer?: AppSearchRenderer<WebSearchApp>): void {
  if (app === null) testRenderers.clear();
  else if (renderer) testRenderers.set(app, renderer);
}
export type { AppHitRowProps, AppSearchRenderer };

/** Whether this client can draw an app's group (a newer server's app it doesn't know is left out). */
export function isRenderedSearchApp(app: string): app is WebSearchApp {
  return testRenderers.has(app) || Object.hasOwn(APP_SEARCH_RENDERERS, app);
}

function anySearchAppEnabled(serverId: string | null): boolean {
  const renderers: Array<{ flagKey?: RegisteredServerFeatureFlagKey }> = [...Object.values(APP_SEARCH_RENDERERS), ...testRenderers.values()];
  return renderers.some(({ flagKey }) => flagKey === undefined || readServerFeatureFlagState(serverId, flagKey) === "enabled");
}

/**
 * Whether any app that global search draws is on for the server (off while
 * the flags load or can't be read): with none, there is no `GET /api/search`.
 */
export function useAppSearchEnabled(serverId: string | null): boolean {
  const subscribe = useCallback((listener: () => void) => {
    const unsubscribe = subscribeServerFeatureFlags(listener);
    void prefetchServerFeatureFlags(serverId);
    return unsubscribe;
  }, [serverId]);
  return useSyncExternalStore(subscribe, () => anySearchAppEnabled(serverId), () => false);
}

// The renderer of a group's own app: one app's renderer reads that app's items.
function rendererOf(app: WebSearchApp): AppSearchRenderer<WebSearchApp> {
  return testRenderers.get(app) ?? APP_SEARCH_RENDERERS[app] as unknown as AppSearchRenderer<WebSearchApp>;
}

/** An app's name, its section's heading. */
export function appSearchLabelId(app: WebSearchApp): MessageId {
  return rendererOf(app).labelId;
}

/** One hit of an app's group, as the page selects and opens it. */
export interface AppSearchHit {
  /** Unique across the page's results: `app:<app>:<item key>`. */
  key: string;
  app: WebSearchApp;
  item: WebSearchItemsByApp[WebSearchApp];
  /** What it opens in Search's detail area. */
  slot: SearchContentSlot;
}

export function appSearchHitKeyOf(group: AppSearchPageGroup, index: number): string {
  const item = group.items[index];
  return item === undefined ? `${index}` : rendererOf(group.app).keyOf(item);
}

/** A group's hits in order, at most `limit` (the overlay's preview). */
export function appSearchHits(group: AppGroupState, limit = Number.POSITIVE_INFINITY): AppSearchHit[] {
  if (group.status !== "ok") return [];
  const renderer = rendererOf(group.app);
  return group.group.items.slice(0, limit).map((item) => ({
    key: `app:${group.app}:${renderer.keyOf(item)}`,
    app: group.app,
    item,
    slot: renderer.slotOf(item),
  }));
}

/** The skeleton of a group's rows while it loads: the entity row's tile and two lines (DS Loading). */
function AppHitSkeleton() {
  return (
    <div className="flex flex-col" data-testid="search-app-group-loading">
      {Array.from({ length: 3 }, (_, index) => (
        <div key={index} className="grid grid-cols-[27px_minmax(0,1fr)] items-center gap-x-3 px-(--surface-inset) py-2">
          <Skeleton variant="block" className="size-[27px]" />
          <div className="stack-y-2">
            <Skeleton variant="line" className="h-3 w-2/5" />
            <Skeleton variant="line" className="h-3 w-3/5" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function AppSearchGroupSection({
  group,
  highlight,
  previewLimit,
  canShowMore,
  selectedKey,
  onOpen,
  onRetry,
  onMore,
}: {
  group: AppGroupState;
  highlight: (text: string) => ReactNode;
  /** The overlay previews a few hits, like its messages; the page shows the group. */
  previewLimit: number;
  /** The page pages a group on; the overlay hands "everything" to the page. */
  canShowMore: boolean;
  selectedKey: string | undefined;
  onOpen: (hit: AppSearchHit) => void;
  onRetry: (app: WebSearchApp) => void;
  onMore: (app: WebSearchApp) => void;
}) {
  const { formatMessage } = useIntl();
  const renderer = rendererOf(group.app);
  const label = formatMessage({ id: renderer.labelId });
  const hits = useMemo(() => appSearchHits(group, previewLimit), [group, previewLimit]);
  const retry = useCallback(() => onRetry(group.app), [group.app, onRetry]);
  const more = useCallback(() => onMore(group.app), [group.app, onMore]);
  // An app with nothing for these words has no section (DS: empty sections hidden).
  if (group.status === "ok" && hits.length === 0) return null;
  const { Row } = renderer;
  return (
    <SearchResultsSection data-testid="search-app-group" data-app={group.app} aria-busy={group.status === "loading" || undefined}>
      <SearchResultsSectionHeading>
        {label}
        {group.status === "ok" ? (
          <span className="font-mono text-mono-meta font-normal" data-testid="search-app-group-count">{group.group.items.length}</span>
        ) : null}
      </SearchResultsSectionHeading>
      {group.status === "loading" ? (
        <AppHitSkeleton />
      ) : group.status === "failed" ? (
        // Feedback: what broke and the one way out, in this section only.
        <div className="px-(--column-margin)">
          <AppBanner
            intent="warning"
            density="sm"
            live={false}
            withIcon
            data-testid="search-app-group-failed"
            actions={(
              <Button type="button" variant="outline" size="md" onClick={retry} data-testid="search-app-group-retry">
                {formatMessage({ id: "search.retry" })}
              </Button>
            )}
          >
            {formatMessage({ id: group.error === "timeout" ? "search.appGroup.timedOut" : "search.appGroup.failed" }, { app: label })}
          </AppBanner>
        </div>
      ) : (
        <SearchResultsList>
          {hits.map((hit) => (
            <AppHitRow key={hit.key} hit={hit} Row={Row} highlight={highlight} selected={selectedKey === hit.key} onOpen={onOpen} />
          ))}
        </SearchResultsList>
      )}
      {group.status === "ok" && canShowMore && group.group.nextCursor ? (
        <div className="px-(--column-margin) pt-1">
          <Button
            type="button"
            size="md"
            variant="ghost"
            loading={group.paging}
            loadingLabel={formatMessage({ id: "common.loading" })}
            onClick={more}
            data-testid="search-app-group-more"
          >
            {formatMessage({ id: "search.loadMore" })}
          </Button>
        </div>
      ) : null}
    </SearchResultsSection>
  );
}

function AppHitRow({ hit, Row, highlight, selected, onOpen }: {
  hit: AppSearchHit;
  Row: ComponentType<AppHitRowProps<WebSearchApp>>;
  highlight: (text: string) => ReactNode;
  selected: boolean;
  onOpen: (hit: AppSearchHit) => void;
}) {
  const open = useCallback(() => onOpen(hit), [hit, onOpen]);
  return <Row item={hit.item} highlight={highlight} selected={selected} onOpen={open} />;
}

/** The whole request failed (offline, rate limited, a server error): one line where the groups go, with Retry. */
export function AppSearchFailed({ onRetry }: { onRetry: () => void }) {
  const { formatMessage } = useIntl();
  return (
    <div className="px-(--column-margin) pt-2">
      <AppBanner
        intent="warning"
        density="sm"
        live={false}
        withIcon
        data-testid="search-app-groups-failed"
        actions={(
          <Button type="button" variant="outline" size="md" onClick={onRetry} data-testid="search-app-groups-retry">
            {formatMessage({ id: "search.retry" })}
          </Button>
        )}
      >
        {formatMessage({ id: "search.appGroups.failed" })}
      </AppBanner>
    </div>
  );
}
