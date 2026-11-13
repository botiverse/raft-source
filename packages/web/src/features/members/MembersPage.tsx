import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { useLocation } from "react-router-dom";
import { ChartColumn, Rows3, TableProperties, UserPlus } from "lucide-react";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  ListRowGroup,
  ScrollArea,
  Select,
  SelectContent,
  SelectItem,
  SelectItemIndicator,
  SelectItemText,
  SelectList,
  SelectTrigger,
  Skeleton,
} from "@botiverse/raft-ui";
import { FitToolbar, FitToolbarButton, FitToolbarGroup, FitToolbarPicker, FitToolbarSearch } from "@botiverse/raft-ui/wip";
import { LIST_TOOLBAR_AIR_CLASS, LIST_TOOLBAR_STEP, LIST_TOOLBAR_MORE_GROUP_CLASS } from "../../components/ui/listToolbar";
import { ListScope, ListToolbarMore, ListViewSwitch, MoreMenuChoices } from "../../components/ui/ListToolbarParts";
import type { ListViewOption } from "../../components/ui/ListToolbarParts";
import { isExternalAgentRuntime } from "@botiverse/raft-shared";
import { useIsDesktopShell } from "../../components/layout/ShellFrame";
import { MemberActionsContext } from "./memberActionsContext";
import { useMemberActions } from "./useMemberActions";
import { usePinnedHeadRailInset } from "../../hooks/usePinnedHeadRailInset";
import { InviteHumanDialog } from "../../components/member/DeferredInviteHumanDialog";
import PanelHeader from "../../components/ui/PanelHeader";
import { useMobileBack } from "../../hooks/useAppNavigate";
import { useServerPermissions } from "../../hooks/useServerPermissions";
import type { MessageId } from "../../i18n/messages/en";
import { isAgentInMemberLists, resolveAgentDisplayState, useAgentStore } from "../../store/agentStore";
import { useAuthStore } from "../../store/authStore";
import { useMachineStore } from "../../store/machineStore";
import type { Machine } from "../../store/machineStore";
import { useProfileStore } from "../../store/profileStore";
import { useServerStore } from "../../store/serverStore";
import { SidebarCellList } from "../sidebar/rows/SidebarCellList";
import { SidebarRowsSkeleton } from "../sidebar/rows/SidebarRowsSkeleton";
import { useAgentsGrouping, writeAgentsGrouping } from "./agentsGroupingPreference";
import { MembersAddAgentDialogs } from "./MembersAddAgentDialogs";
import { MembersCreateAgentButton } from "./MembersCreateAgentButton";
import { useAddAgentActions } from "./useAddAgentActions";
import type { MembersLocateState } from "./useMembersProfileRedirect";
import type { AddAgentStep } from "./useAddAgentActions";
import { MemberPhoneRow } from "./MemberPhoneRow";
import { AgentRowSkeleton, MembersAgentGroup } from "./MembersAgentList";
import { MemberTile } from "./MemberTile";
import { MembersAgentUsageBody } from "./MembersAgentUsage";
import { MembersAgentUsageFilter } from "./MembersAgentUsageFilter";
import { useMembersAgentUsage, useMembersUsageAccess } from "./useMembersAgentUsage";
import { AgentUsagePeriodSelect } from "../agent/AgentUsageParts";
import { AfterSkeletonDelay, MemberTileSkeletons } from "./MemberTileSkeletons";
import { membersGroupPlaceholders, useRememberedMembersGroupCounts } from "./membersGroupCounts";
import {
  agentEntry,
  agentsGroupingOptions,
  DEFAULT_AGENTS_GROUPING,
  effectiveAgentsGrouping,
  groupsForTab,
  humanEntry,
  tabCount,
  visibleTabs,
} from "./membersPageModel";
import type { AgentsGrouping, MemberEntry, MemberGroup, MembersPopulation, MembersTab } from "./membersPageModel";

/** The tiles' grid under a group heading, and its skeleton's. */
const MEMBERS_TILE_GRID_CLASS = "grid gap-3 px-5 pt-2 [grid-template-columns:repeat(auto-fill,minmax(240px,1fr))]";

/** How long after arriving the page keeps the located member centred through resizes. */
const LOCATE_FOLLOW_MS = 1500;

const TAB_LABEL: Record<MembersTab, MessageId> = {
  all: "members.page.tab.all",
  humans: "layout.sidebar.humans",
  agents: "layout.sidebar.agents",
};

/** The Agents tab's views: the agents' facts, or their token usage (agent_usage_v0). */
type AgentsListView = "details" | "usage";

const GROUPING_LABEL: Record<AgentsGrouping, MessageId> = {
  creator: "members.page.group.byCreator",
  computer: "members.page.group.byComputer",
  none: "members.page.group.none",
};

/** How many of the listed agents are working or thinking: a number, so a store update that leaves it alone renders nothing. */
function selectWorkingAgentCount(state: ReturnType<typeof useAgentStore.getState>): number {
  let working = 0;
  for (const agent of state.agents) {
    if (!isAgentInMemberLists(agent)) continue;
    const external = agent.external === true || isExternalAgentRuntime(agent.runtime);
    const { activity } = resolveAgentDisplayState(agent, state.agentActivities[agent.id], external);
    if (activity === "working" || activity === "thinking") working += 1;
  }
  return working;
}

/** "2 agents working · 17 members", in the header's machine type. */
function MembersCounts({ members }: { members: number }) {
  const { formatMessage } = useIntl();
  const working = useAgentStore(selectWorkingAgentCount);
  return (
    <span className="ml-2 hidden truncate font-mono text-mono-meta text-foreground-hint md:inline" data-testid="members-counts">
      {formatMessage({ id: "members.page.counts" }, { working, members })}
    </span>
  );
}

/**
 * The Members page (raft-design design/products/raft-chat/members.md): the
 * server's directory of people (guests among them) and agents, a full page beside the
 * rail like Computers. The header adds people and agents; the tabs filter;
 * the Agents tab can group. Everyone opens their profile in the side panel.
 *
 * Desktop: people (and agents under All) as tiles, the Agents tab as a list
 * with columns. A phone: the sidebar's 44px rows under the same tabs and
 * groups.
 */
export function MembersPage() {
  const { formatMessage, locale } = useIntl();
  const isDesktop = useIsDesktopShell();
  const serverSlug = useServerStore((s) => s.current?.slug);
  const hideHumansSetting = useServerStore((s) => s.current?.hideHumansFromMembers === true);
  const members = useServerStore((s) => s.members);
  const membersLoadError = useServerStore((s) => s.membersLoadError);
  const allAgents = useAgentStore((s) => s.agents);
  const agentsLoading = useAgentStore((s) => s.loading);
  const machines = useMachineStore((s) => s.machines);
  const userId = useAuthStore((s) => s.user?.id);
  const openProfile = useProfileStore((s) => s.openProfile);
  const { role, capabilities } = useServerPermissions();
  const storedGrouping = useAgentsGrouping();

  // Who the viewer may see, as the sidebar's Members list decided it: a member
  // of a server that hides its people sees no Humans (nor who made an agent:
  // no By creator); only owners and admins see the guests, among the Humans.
  const showHumans = !(role === "member" && hideHumansSetting);
  const showGuests = role === "owner" || role === "admin";
  const creatorsHidden = !showHumans;
  const agentsGrouping = effectiveAgentsGrouping(storedGrouping, creatorsHidden);

  const memberListAgents = useMemo(() => allAgents.filter(isAgentInMemberLists), [allAgents]);
  const population = useMemo<MembersPopulation>(() => {
    const humans: MemberEntry[] = [];
    for (const member of members) {
      if (member.role === "guest" ? showGuests : showHumans) humans.push(humanEntry(member));
    }
    return { humans, agents: memberListAgents.map(agentEntry) };
  }, [memberListAgents, members, showGuests, showHumans]);
  const machinesById = useMemo(() => new Map<string, Machine>(machines.map((m) => [m.id, m])), [machines]);
  // A creator the agent list sent no summary for, named from what the page has.
  const creatorName = useCallback((type: "human" | "agent", id: string): string | null => {
    if (type === "human") {
      const member = members.find((m) => m.userId === id);
      return member ? member.displayName || member.name : null;
    }
    const agent = allAgents.find((a) => a.id === id);
    return agent ? agent.displayName || agent.name : null;
  }, [allAgents, members]);
  const tabs = visibleTabs({ showHumans });

  const [tabChoice, setTab] = useState<MembersTab>("all");
  const tab = tabs.includes(tabChoice) ? tabChoice : "all";
  const [query, setQuery] = useState("");
  // The usage view (#proj-o11y:#36): on a desktop's Agents tab, for whoever
  // may inspect an agent while agent_usage_v0 is on; one read per period.
  const usageAccess = useMembersUsageAccess(memberListAgents, userId, capabilities.editAgents);
  const [agentsView, setAgentsView] = useState<AgentsListView>("details");
  const usageOffered = isDesktop && tab === "agents" && usageAccess;
  const usage = useMembersAgentUsage(usageOffered && agentsView === "usage", memberListAgents);
  const showViewSwitch = usageOffered && !usage.none;
  const showUsage = showViewSwitch && agentsView === "usage";
  const groups = useMemo(
    () => groupsForTab({ tab, population, query, agentsGrouping, machines: machinesById, selfId: userId, creatorName, locale }),
    [agentsGrouping, creatorName, locale, machinesById, population, query, tab, userId],
  );
  // Arriving from /agent/<id> or /human/<id> (useMembersProfileRedirect): the
  // member is scrolled into view once its tile or row renders (artin, #702),
  // once per arrival. Matched by attribute value, never a selector built from
  // the id. The side panel opening beside the page narrows it and reflows the
  // tiles after that first scroll (the Activity tab later than the Profile
  // one), so for a moment after arrival the page keeps the member centred
  // whenever it resizes, until the person scrolls it themselves.
  const location = useLocation();
  const locate = (location.state as Partial<MembersLocateState> | null)?.membersLocate ?? null;
  const pageRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  // The toolbar is pinned inside the scroller: the scrollbar starts below it
  // (its height changes when the search wraps on a phone).
  const toolbarRef = useRef<HTMLDivElement>(null);
  const toolbarRailInset = usePinnedHeadRailInset(toolbarRef, true);
  const locatedKey = useRef<string | null>(null);
  const follow = useRef<{ target: HTMLElement; until: number } | null>(null);
  useEffect(() => {
    if (!locate || locatedKey.current === location.key) return;
    const target = Array.from(pageRef.current?.querySelectorAll<HTMLElement>("[data-member-entry-id]") ?? [])
      .find((element) => element.dataset.memberEntryId === locate.id);
    if (!target) return;
    locatedKey.current = location.key;
    follow.current = { target, until: Date.now() + LOCATE_FOLLOW_MS };
    target.scrollIntoView({ block: "center" });
  }, [groups, locate, location.key]);
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || typeof ResizeObserver === "undefined") return;
    const recentre = () => {
      const current = follow.current;
      if (!current) return;
      if (Date.now() > current.until || !current.target.isConnected) {
        follow.current = null;
        return;
      }
      current.target.scrollIntoView({ block: "center" });
    };
    const release = () => { follow.current = null; };
    const observer = new ResizeObserver(recentre);
    observer.observe(scroller);
    scroller.addEventListener("wheel", release, { passive: true });
    scroller.addEventListener("touchstart", release, { passive: true });
    return () => {
      observer.disconnect();
      scroller.removeEventListener("wheel", release);
      scroller.removeEventListener("touchstart", release);
    };
  }, []);
  // Members always holds the viewer once it has loaded; agents say so themselves.
  const loading = (members.length === 0 && !membersLoadError) || (agentsLoading && allAgents.length === 0);
  // How many humans and agents were listed last time here, for the tiles'
  // skeleton (membersGroupCounts); remembered once both lists are read.
  const serverId = useServerStore((s) => s.current?.id);
  const rememberedGroups = useRememberedMembersGroupCounts({
    userId,
    serverId,
    loaded: loading || membersLoadError ? null : { humans: population.humans.length, agents: population.agents.length },
  });

  const [showInvite, setShowInvite] = useState(false);
  const openInvite = useCallback(() => setShowInvite(true), []);
  const closeInvite = useCallback(() => setShowInvite(false), []);
  const scopeLabel = formatMessage({ id: "members.page.filterLabel" });
  const scopeOptions = useMemo(() => visibleTabs({ showHumans }).map((value) => ({
    value,
    label: formatMessage({ id: TAB_LABEL[value] }),
    count: loading ? null : tabCount(value, population),
    testId: `members-tab-${value}`,
  })), [formatMessage, loading, population, showHumans]);
  const groupingOptions = useMemo(
    () => agentsGroupingOptions(creatorsHidden).map((value) => ({ value, label: formatMessage({ id: GROUPING_LABEL[value] }) })),
    [creatorsHidden, formatMessage],
  );
  const [addAgent, setAddAgent] = useState<AddAgentStep>(null);
  const addAgentActions = useAddAgentActions(setAddAgent);
  // A tile's or row's menu and double-click (MemberMenuTrigger), and the dialogs they open.
  const { actions: memberActions, dialogs: memberDialogs } = useMemberActions();
  const onOpen = useCallback((entry: MemberEntry) => openProfile(entry.kind, entry.id), [openProfile]);
  // In the usage view a row opens the agent at its Usage tab.
  const onOpenUsage = useCallback((entry: MemberEntry) => openProfile(entry.kind, entry.id, { defaultAgentTabIntent: "usage" }), [openProfile]);
  const viewOptions = useMemo<ListViewOption<AgentsListView>[]>(() => [
    { value: "details", label: formatMessage({ id: "members.page.view.details" }), icon: <TableProperties />, testId: "members-view-details" },
    { value: "usage", label: formatMessage({ id: "members.page.view.usage" }), icon: <ChartColumn />, testId: "members-view-usage" },
  ], [formatMessage]);
  // The period in ⋯ once the toolbar folds it there: the presets (a picked day is the bars').
  const periodOptions = useMemo(() => [
    { value: "today", label: formatMessage({ id: "agent.usage.period.today" }) },
    ...([7, 14, 30] as const).map((range) => ({ value: String(range), label: formatMessage({ id: "agent.usage.period.days" }, { count: range }) })),
  ], [formatMessage]);
  const periodValue = usage.view.day === usage.today ? "today" : usage.view.day ? "" : String(usage.view.range);
  const { setView: setUsageView, today: usageToday } = usage;
  const choosePeriod = useCallback((next: string) => {
    if (next === "today") setUsageView((current) => ({ range: current.range, day: usageToday }));
    else setUsageView({ range: Number(next) as 7 | 14 | 30, day: null });
  }, [setUsageView, usageToday]);
  // The member open in the side panel is the selected tile or row (Raft DS › States, "Selected: content").
  const openKey = useProfileStore((s) => (s.profileType === "agent" || s.profileType === "human" ? `${s.profileType}:${s.profileId}` : null));
  const isOpen = (entry: MemberEntry) => openKey === `${entry.kind}:${entry.id}`;
  const onMobileBack = useMobileBack(serverSlug ? `/s/${serverSlug}` : "/");
  const mobileBackProps = useMemo(
    () => ({ "data-testid": "members-mobile-back", title: formatMessage({ id: "common.announcement.back" }) }),
    [formatMessage],
  );

  // The add actions end the toolbar (Raft DS › A page of a list; members.md): Invite human
  // (`default`), then Create agent (`primary`), the primary last.
  const canInvite = capabilities.inviteMembers;
  const canCreateAgents = capabilities.createAgents;

  // Group headings are hand-rolled (footnote 700 in hint, sentence case): raft-ui has no list heading part yet.
  const heading = useCallback((group: MemberGroup): ReactNode => group.label ? (
    <h3 className="flex min-w-0 items-baseline gap-2 text-footnote font-bold text-foreground-hint" data-testid="members-group-heading">
      <span className="truncate">{"id" in group.label ? formatMessage({ id: group.label.id }) : group.label.text}</span>
      {group.self ? <span className="shrink-0 font-normal [text-spacing-trim:trim-start]">{formatMessage({ id: "layout.sidebar.youSuffix" })}</span> : null}
      {group.agentCreator ? <span className="shrink-0 font-normal">{formatMessage({ id: "members.page.group.agentCreator" })}</span> : null}
      <span className="font-mono font-normal">{group.entries.length}</span>
    </h3>
  ) : null, [formatMessage]);

  const renderBody = () => {
    if (groups.length === 0) {
      if (query.trim()) {
        return (
          <p className="px-5 pt-3 text-callout text-foreground-hint" data-testid="members-empty">
            {formatMessage({ id: "members.page.noMatches" }, { query: query.trim() })}
          </p>
        );
      }
      if (loading) {
        // The shape that is coming, where it will be: under a group heading's
        // line, tiles in their grid, or the Agents tab's rows in their group;
        // a phone's sidebar rows. raft-ui Skeleton's own tone, after the 1s
        // wait raft-design Feedback asks (AfterSkeletonDelay), so a fast load
        // shows nothing in between.
        const headingLine = (
          <span className="flex h-lh items-center text-footnote"><AfterSkeletonDelay><Skeleton variant="line" className="w-16" /></AfterSkeletonDelay></span>
        );
        if (!isDesktop) {
          return (
            <section className="pt-3" aria-busy="true" data-testid="members-loading" data-skeleton="rows">
              <div className="px-5">{headingLine}</div>
              <div className="py-2"><AfterSkeletonDelay><SidebarRowsSkeleton rows={8} /></AfterSkeletonDelay></div>
            </section>
          );
        }
        if (tab !== "agents") {
          // As many tiles in each group as last time here, each group under
          // its heading as the loaded page draws them (All: Humans, then
          // Agents, an empty one left out; Humans: no heading); never loaded
          // here, eight, under one heading on All.
          const tileGroups = !rememberedGroups
            ? [{ key: "all", heading: tab === "all", count: 8 }]
            : tab === "all"
              ? [
                { key: "humans", heading: true, count: rememberedGroups.humans },
                { key: "agents", heading: true, count: rememberedGroups.agents },
              ].filter((group) => group.count > 0)
              : [{ key: "humans", heading: false, count: rememberedGroups.humans }];
          return (
            <div aria-busy="true" data-testid="members-loading" data-skeleton="tiles">
              {tileGroups.map((group) => (
                <section key={group.key} className="flex flex-col" data-testid={`members-loading-group-${group.key}`}>
                  {group.heading ? <div className="px-5 pt-4">{headingLine}</div> : null}
                  <div className={MEMBERS_TILE_GRID_CLASS}>
                    <AfterSkeletonDelay><MemberTileSkeletons count={membersGroupPlaceholders(group.count)} /></AfterSkeletonDelay>
                  </div>
                </section>
              ))}
            </div>
          );
        }
        return (
          <section aria-busy="true" data-testid="members-loading" data-skeleton="rows">
            <div className="mx-5 border-x border-transparent pt-4">{headingLine}</div>
            <AfterSkeletonDelay>
              <ListRowGroup className="mx-5 mt-2">
                {Array.from({ length: 6 }, (_, index) => <AgentRowSkeleton key={index} />)}
              </ListRowGroup>
            </AfterSkeletonDelay>
          </section>
        );
      }
      // A failed load says so above; "no one here" would say something untrue.
      if (membersLoadError) return null;
      return (
        <p className="px-5 pt-3 text-callout text-foreground-hint" data-testid="members-empty">
          {formatMessage({ id: "members.page.empty" })}
        </p>
      );
    }
    if (!isDesktop) {
      return groups.map((group) => (
        <section key={group.key} data-testid={`members-group-${group.key}`}>
          {group.label ? <div className="px-5 pt-3">{heading(group)}</div> : null}
          <SidebarCellList data-testid="members-phone-list">
            {group.entries.map((entry) => (
              <MemberPhoneRow
                key={entry.id}
                entry={entry}
                isSelf={entry.id === userId}
                runtimeLine={tab === "agents"}
                machineName={entry.kind === "agent" && entry.agent.machineId && agentsGrouping !== "computer"
                  ? machinesById.get(entry.agent.machineId)?.name ?? null
                  : null}
                onOpen={onOpen}
              />
            ))}
          </SidebarCellList>
        </section>
      ));
    }
    if (tab === "agents" && showUsage) {
      return <MembersAgentUsageBody usage={usage} groups={groups} heading={heading} openKey={openKey} onOpen={onOpenUsage} />;
    }
    if (tab === "agents") {
      return groups.map((group, index) => (
        <MembersAgentGroup
          key={group.key}
          heading={heading(group)}
          entries={group.entries}
          machinesById={machinesById}
          showComputer={agentsGrouping !== "computer"}
          showColumnHeadings={index === 0}
          openKey={openKey}
          onOpen={onOpen}
        />
      ));
    }
    return groups.map((group) => (
      <section key={group.key} className="flex flex-col" data-testid={`members-group-${group.key}`}>
        {group.label ? <div className="px-5 pt-4">{heading(group)}</div> : null}
        <div
          className={MEMBERS_TILE_GRID_CLASS}
          data-testid="members-tile-grid"
        >
          {group.entries.map((entry) => (
            <MemberTile key={entry.id} entry={entry} isSelf={entry.id === userId} selected={isOpen(entry)} onOpen={onOpen} />
          ))}
        </div>
      </section>
    ));
  };

  return (
    // One 20px edge for the head, the toolbar and the rows at every width (raft-ui listColumnMargin).
    <MemberActionsContext.Provider value={memberActions}>
    <div ref={pageRef} className="flex min-h-0 min-w-0 flex-1 flex-col font-sans [--column-margin:20px]" data-testid="members-page" data-layout={isDesktop ? "desktop" : "phone"}>
      <PanelHeader
        title={formatMessage({ id: "members.page.title" })}
        // No "0 members" while they load: the counts come with the members.
        titleSuffix={loading ? undefined : <MembersCounts members={tabCount("all", population)} />}
        onMobileBack={onMobileBack}
        mobileBackProps={mobileBackProps}
      />
      <ScrollArea ref={scrollerRef} railInset={toolbarRailInset} className="min-h-0 flex-1 bg-layer-canvas pb-5 safe-bottom" data-testid="members-scroller">
        {/* The toolbar over the list (Raft DS › The toolbar over a list), pinned under the header while the
            members scroll: the tabs, the search filling the line, the Agents tab's Group menu and Invite human,
            then ⋯ (More, while it holds anything) and Create agent, the last. One line, 44px with a mouse and 49px
            by touch; as it narrows the Group menu shows its icon, Invite human its icon, Create agent becomes +, the
            tabs become a Select, the Group menu and Invite human fold into ⋯ (step 6), and last an empty search
            becomes its button. */}
        <div ref={toolbarRef} className={`sticky top-0 z-sticky px-5 ${LIST_TOOLBAR_AIR_CLASS}`} data-testid="members-toolbar">
          <FitToolbar aria-label={formatMessage({ id: "members.page.title" })} wrap={showUsage} className="gap-2">
            <ListScope value={tab} options={scopeOptions} onValueChange={setTab} label={scopeLabel} testId="members-tabs" selectTestId="members-scope-select" />
            <FitToolbarSearch
              value={query}
              onValueChange={setQuery}
              collapseOrder={LIST_TOOLBAR_STEP.searchButton}
              placeholder={formatMessage({ id: "members.page.searchLabel" })}
              aria-label={formatMessage({ id: "members.page.searchLabel" })}
              clearLabel={formatMessage({ id: "ui.listToolbar.clearSearch" })}
              data-testid="members-search"
            />
            {/* The usage view's agent filter (Raft DS › The toolbar over a list: the filters after the search):
                its label gives way first, then it moves to a second line of its own, and it never folds into ⋯. */}
            {showUsage ? (
              <FitToolbarGroup overflow="scroll" wrapOrder={LIST_TOOLBAR_STEP.filtersWrap} className="gap-2" data-testid="members-usage-filters">
                <MembersAgentUsageFilter options={usage.filterOptions} value={usage.filter} onChange={usage.setFilter} />
              </FitToolbarGroup>
            ) : null}
            {/* Step 6 folds the Group menu and Invite human into ⋯ together (one group), so the search keeps its
                field on a phone, on the Agents tab too (raft-ui 0.90: its least width is at most 120, the
                placeholder ellipsised); Invite human shows its icon alone first (step 35). */}
            {tab === "agents" || canInvite ? (
              <FitToolbarGroup
                firstLine
                className="gap-2"
                moreOrder={LIST_TOOLBAR_STEP.displayMore}
                moreItem={(
                  <>
                    {showViewSwitch ? (
                      <>
                        <MoreMenuChoices
                          heading={formatMessage({ id: "ui.listToolbar.view" })}
                          value={agentsView}
                          options={viewOptions}
                          onValueChange={setAgentsView}
                          testId="members-more-view"
                        />
                        <DropdownMenuSeparator />
                      </>
                    ) : null}
                    {showUsage ? (
                      <>
                        <MoreMenuChoices
                          heading={formatMessage({ id: "agent.usage.periodLabel" })}
                          value={periodValue}
                          options={periodOptions}
                          onValueChange={choosePeriod}
                          testId="members-more-period"
                        />
                        <DropdownMenuSeparator />
                      </>
                    ) : null}
                    {tab === "agents" ? (
                      <MoreMenuChoices
                        heading={formatMessage({ id: "ui.listToolbar.group" })}
                        value={agentsGrouping}
                        options={groupingOptions}
                        onValueChange={writeAgentsGrouping}
                        testId="members-more-group"
                      />
                    ) : null}
                    {tab === "agents" && canInvite ? <DropdownMenuSeparator /> : null}
                    {canInvite ? (
                      <DropdownMenuItem onClick={openInvite} data-testid="members-more-invite-human">
                        <UserPlus />
                        {formatMessage({ id: "layout.sidebar.inviteHuman" })}
                      </DropdownMenuItem>
                    ) : null}
                  </>
                )}
                data-testid="members-display-group"
              >
                {showViewSwitch ? (
                  <ListViewSwitch
                    value={agentsView}
                    options={viewOptions}
                    onValueChange={setAgentsView}
                    label={formatMessage({ id: "members.page.view.label" })}
                    testId="members-view-switch"
                  />
                ) : null}
                {showUsage ? <AgentUsagePeriodSelect view={usage.view} today={usage.today} onChange={usage.setView} testId="members-usage-period" /> : null}
                {tab === "agents" ? (
                  <GroupSelect
                    value={agentsGrouping}
                    options={agentsGroupingOptions(creatorsHidden)}
                    applied={agentsGrouping !== DEFAULT_AGENTS_GROUPING}
                  />
                ) : null}
                {canInvite ? (
                  <FitToolbarButton
                    variant="default"
                    icon={<UserPlus />}
                    labelOrder={LIST_TOOLBAR_STEP.secondaryLabels}
                    onClick={openInvite}
                    data-testid="members-invite-human"
                  >
                    {formatMessage({ id: "layout.sidebar.inviteHuman" })}
                  </FitToolbarButton>
                ) : null}
              </FitToolbarGroup>
            ) : null}
            <FitToolbarGroup firstLine className={canCreateAgents ? "gap-2" : LIST_TOOLBAR_MORE_GROUP_CLASS}>
              <ListToolbarMore testId="members-more" />
              {canCreateAgents ? <MembersCreateAgentButton actions={addAgentActions} /> : null}
            </FitToolbarGroup>
          </FitToolbar>
        </div>
        {membersLoadError ? (
          <p className="px-5 pb-2 font-sans text-footnote font-semibold text-warning-strong" data-testid="members-load-error">
            {formatMessage({ id: "layout.sidebar.humansFailedToLoad" })}
          </p>
        ) : null}
        {/* Its own stacking context, so nothing in it (an avatar's badge is z-raised, and later in
            the DOM) is drawn over the sticky toolbar (raft-design lists.md: no row shows through). */}
        <div className="isolate" data-testid="members-body">{renderBody()}</div>
      </ScrollArea>
      {showInvite ? <InviteHumanDialog onClose={closeInvite} surface="members_page" /> : null}
      <MembersAddAgentDialogs step={addAgent} onStep={setAddAgent} />
      {memberDialogs}
    </div>
    </MemberActionsContext.Provider>
  );
}

/**
 * The Agents tab's Group menu: raft-ui Select on a FitToolbarPicker, the
 * Select › Filters look (as the Apps toolbar), filled info-soft while it is
 * off its default. Its name says what it groups and how.
 */
function GroupSelect({ value, options, applied }: { value: AgentsGrouping; options: readonly AgentsGrouping[]; applied: boolean }) {
  const { formatMessage } = useIntl();
  const label = formatMessage({ id: GROUPING_LABEL[value] });
  const handleChange = useCallback((next: AgentsGrouping | null) => {
    if (next != null) writeAgentsGrouping(next);
  }, []);
  return (
    <Select<AgentsGrouping> value={value} onValueChange={handleChange}>
      <FitToolbarPicker
        trigger={<SelectTrigger />}
        icon={<Rows3 />}
        labelOrder={LIST_TOOLBAR_STEP.displayLabels}
        aria-label={formatMessage({ id: "members.page.group.triggerLabel" }, { grouping: label })}
        data-has-value={applied ? "" : undefined}
        data-testid="members-group-select"
      >
        {label}
      </FitToolbarPicker>
      <SelectContent align="end">
        <SelectList>
          {options.map((option) => (
            <SelectItem key={option} value={option} data-testid={`members-group-option-${option}`}>
              <SelectItemText>{formatMessage({ id: GROUPING_LABEL[option] })}</SelectItemText>
              <SelectItemIndicator />
            </SelectItem>
          ))}
        </SelectList>
      </SelectContent>
    </Select>
  );
}
