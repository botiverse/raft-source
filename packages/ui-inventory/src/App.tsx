import { useEffect, useMemo, useState, type MouseEvent, type ReactNode } from "react";
import {
  AlertTriangle,
  AtSign,
  Bell,
  Bookmark,
  Bot,
  CalendarRange,
  Check,
  CheckSquare,
  ChevronDown,
  Circle,
  Code2,
  FileText,
  Hash,
  Inbox,
  Info,
  LayoutList,
  Monitor,
  Palette,
  Plus,
  Search,
  Settings,
  Sparkles,
  Star,
  Trash2,
  User,
  UserCircle2,
  Users,
  X,
} from "lucide-react";
import {
  Badge,
  SegmentedControl,
  SegmentedControlCount,
  SegmentedControlItem,
  SegmentedControlLabel,
  Select,
  SelectContent,
  SelectIcon,
  SelectItem,
  SelectItemIndicator,
  SelectItemText,
  SelectList,
  SelectTrigger,
  SelectValue,
} from "raft-ui";
import Banner from "@botiverse/raft-web/src/components/ui/Banner";
import Button from "@botiverse/raft-web/src/components/ui/Button";
import Textarea from "@botiverse/raft-web/src/components/ui/Textarea";
import Checkbox from "@botiverse/raft-web/src/components/ui/Checkbox";
import CheckMarker from "@botiverse/raft-web/src/components/ui/CheckMarker";
import EmptyState from "@botiverse/raft-web/src/components/ui/EmptyState";
import FormField from "@botiverse/raft-web/src/components/ui/FormField";
import KeyValueRow from "@botiverse/raft-web/src/components/ui/KeyValueRow";
import PanelHeader from "@botiverse/raft-web/src/components/ui/PanelHeader";
import SelectionPopover from "@botiverse/raft-web/src/components/ui/SelectionPopover";
import SectionEyebrow from "@botiverse/raft-web/src/components/ui/SectionEyebrow";
import SectionHeader from "@botiverse/raft-web/src/components/ui/SectionHeader";
import StatusDot from "@botiverse/raft-web/src/components/ui/StatusDot";
import AttentionDot from "@botiverse/raft-web/src/components/ui/AttentionDot";
import AvatarSlot from "@botiverse/raft-web/src/components/ui/AvatarSlot";
import AvatarListRow from "@botiverse/raft-web/src/components/ui/AvatarListRow";
import SurfaceListItem from "@botiverse/raft-web/src/components/ui/SurfaceListItem";
import ConversationPreviewCard from "@botiverse/raft-web/src/components/ui/cards/ConversationPreviewCard";
import { AgentAvatar } from "@botiverse/raft-web/src/components/agent/PixelAvatar";
import InlineBadgeEditor from "@botiverse/raft-web/src/components/InlineBadgeEditor";
import { StatusBadge } from "@botiverse/raft-web/src/components/task/StatusBadge";
import type { TaskStatus } from "@botiverse/raft-web/src/store/taskStore";

type SectionId =
  | "purpose"
  | "foundation"
  | "buttons"
  | "forms"
  | "selection"
  | "feedback"
  | "identity"
  | "lists"
  | "messages"
  | "pages";

const SECTIONS: { id: SectionId; label: string }[] = [
  { id: "purpose", label: "Purpose" },
  { id: "foundation", label: "Foundation" },
  { id: "buttons", label: "Buttons & Badges" },
  { id: "forms", label: "Forms" },
  { id: "selection", label: "Selection" },
  { id: "feedback", label: "Feedback" },
  { id: "identity", label: "Identity" },
  { id: "lists", label: "Lists & Cards" },
  { id: "messages", label: "Messages" },
  { id: "pages", label: "Page Shells" },
];

const TASK_STATUSES: TaskStatus[] = ["todo", "in_progress", "in_review", "done", "closed"];

const SELECT_SORT_OPTIONS = [
  { value: "relevance", label: "Relevance" },
  { value: "recent", label: "Most recent" },
  { value: "oldest", label: "Oldest first" },
];

// Source content is Title Case so future non-brutal themes can render it
// natural-cased; brutal theme's Badge CSS uppercases it.
const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  todo: "Todo",
  in_progress: "In Progress",
  in_review: "In Review",
  done: "Done",
  closed: "Closed",
};

function InventorySection({
  id,
  title,
  description,
  children,
}: {
  id: SectionId;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-6 border-t-2 border-black bg-white px-5 py-6">
      <div className="mb-4 max-w-3xl">
        <SectionEyebrow as="div" className="mb-1">
          {id}
        </SectionEyebrow>
        <h2 className="font-display text-2xl font-bold text-black">{title}</h2>
        <p className="mt-1 text-sm leading-6 text-black/60">{description}</p>
      </div>
      <div className="grid gap-4">{children}</div>
    </section>
  );
}

function SampleCard({
  title,
  source,
  note,
  children,
}: {
  title: string;
  source: string;
  note?: string;
  children: ReactNode;
}) {
  return (
    <article className="border-2 border-black/30 bg-white p-4 shadow-brutal-sm">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-bold text-black">{title}</h3>
          {note ? <p className="mt-1 max-w-[64ch] text-xs leading-5 text-black/55">{note}</p> : null}
        </div>
        <code className="shrink-0 border border-black/20 bg-white px-1.5 py-0.5 font-mono text-[10px] text-black/50">
          {source}
        </code>
      </div>
      <div className="min-w-0">{children}</div>
    </article>
  );
}

function SampleGrid({ children }: { children: ReactNode }) {
  return <div className="grid gap-4 lg:grid-cols-2">{children}</div>;
}

function ColorChip({ name, className }: { name: string; className: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className={`h-8 w-8 shrink-0 border-2 border-black ${className}`} />
      <span className="font-mono text-xs text-black/60">{name}</span>
    </div>
  );
}

function SelectionSamples() {
  const [channelSearch, setChannelSearch] = useState("");
  // Pre-select a channel so the trigger button demos the "after selection"
  // state — stdrc msg=53458622 asked to show how `# CHANNEL` chip changes
  // once a value is committed.
  const [selectedChannel, setSelectedChannel] = useState<string | null>("proj-theme");
  const [filterValue, setFilterValue] = useState<"all" | "mentions" | "unread">("all");
  const [selectValue, setSelectValue] = useState("recent");
  const [badgeOpen, setBadgeOpen] = useState(false);
  const [badgeValue, setBadgeValue] = useState("in_progress");

  const channelOptions = useMemo(() => {
    const all = [
      { id: "general", label: "#general" },
      { id: "proj-uiux", label: "#proj-uiux" },
      { id: "proj-theme", label: "#proj-theme" },
      { id: "engineering", label: "#engineering" },
    ];
    const needle = channelSearch.trim().toLowerCase();
    return needle ? all.filter((option) => option.label.toLowerCase().includes(needle)) : all;
  }, [channelSearch]);

  return (
    <SampleGrid>
      <SampleCard
        title="Segmented control"
        source="SegmentedControl"
        note="Fixed, small enumerations. Do not turn these into search boxes."
      >
        <SegmentedControl
          value={filterValue}
          onValueChange={setFilterValue}
          aria-label="Inbox filter"
        >
          <SegmentedControlItem value="all">
            <SegmentedControlLabel>All</SegmentedControlLabel>
            <SegmentedControlCount>24</SegmentedControlCount>
          </SegmentedControlItem>
          <SegmentedControlItem value="mentions">
            <AtSign size={12} />
            <SegmentedControlLabel>Mentions</SegmentedControlLabel>
            <SegmentedControlCount>3</SegmentedControlCount>
          </SegmentedControlItem>
          <SegmentedControlItem value="unread">
            <SegmentedControlLabel>Unread</SegmentedControlLabel>
            <SegmentedControlCount>9</SegmentedControlCount>
          </SegmentedControlItem>
        </SegmentedControl>
      </SampleCard>

      <SampleCard
        title="Select"
        source="Select"
        note="raft-ui compositional select. Good for small, fixed enumerations."
      >
        <div className="max-w-xs">
          <Select
            value={selectValue}
            onValueChange={(value) => {
              if (value == null) return;
              setSelectValue(value);
            }}
            items={SELECT_SORT_OPTIONS}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Sort by" />
              <SelectIcon />
            </SelectTrigger>
            <SelectContent>
              <SelectList>
                {SELECT_SORT_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    <SelectItemText>{option.label}</SelectItemText>
                    <SelectItemIndicator />
                  </SelectItem>
                ))}
              </SelectList>
            </SelectContent>
          </Select>
        </div>
      </SampleCard>

      <SampleCard
        title="Searchable filter popover"
        source="SelectionPopover"
        note="Standard pattern for dynamic entity filters: channel, member, agent, machine, model."
      >
        {/* Trigger style is the real MessageSearchPage / TasksPanel filter
            chip recipe — copied verbatim. The "after-selection" trigger
            variant (with × clear / yellow-fill state) was previously
            invented in this sample and removed per stdrc msg=33993ba1
            ("不要做任何非必要发散"); re-add only after verifying against
            the real selected-state chrome. */}
        <div className="h-80">
          <div className="relative inline-block">
            <button
              type="button"
              className="inline-flex items-center gap-2 border-2 border-black bg-white px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-black/70 hover:border-black"
            >
              <Hash size={14} />
              Channel
              <ChevronDown size={12} />
            </button>
            <SelectionPopover
              title="Channels"
              searchable
              search={channelSearch}
              onSearchChange={setChannelSearch}
              options={channelOptions.map((option) => ({
                key: option.id,
                checked: option.id === selectedChannel,
                label: option.label,
                leading: <Hash size={12} className="text-black/50" />,
                onClick: () => setSelectedChannel(option.id),
              }))}
              showClear
              onClear={() => {
                setChannelSearch("");
                setSelectedChannel(null);
              }}
              emptyLabel="No matching channels"
            />
          </div>
        </div>
      </SampleCard>

      <SampleCard
        title="Inline badge editor"
        source="InlineBadgeEditor"
        note="Compact status/role editor used in task and profile surfaces."
      >
        <InlineBadgeEditor
          // Source content is Title Case (`In Progress`), brutal Badge CSS
          // uppercases it (stdrc msg=832c2c02). Future themes can render
          // the Title Case content natural-cased.
          displayValue={TASK_STATUS_LABELS[badgeValue as TaskStatus] ?? badgeValue}
          selectedId={badgeValue}
          options={(["todo", "in_progress", "in_review", "done"] as TaskStatus[]).map((status) => ({
            id: status,
            label: TASK_STATUS_LABELS[status],
          }))}
          onSelect={(id) => {
            setBadgeValue(id);
            setBadgeOpen(false);
          }}
          open={badgeOpen}
          onToggle={() => setBadgeOpen((open) => !open)}
          onRequestClose={() => setBadgeOpen(false)}
          badgeClassName="bg-brutal-cyan"
          dropdownAlign="left"
        />
      </SampleCard>
    </SampleGrid>
  );
}

function PageShellSamples() {
  return (
    <SampleGrid>
      <SampleCard title="Panel header" source="PanelHeader">
        <div className="overflow-hidden border-2 border-black">
          <PanelHeader
            title="Search"
            subtitle="Search channels, DMs, people, agents, and message history."
            icon={<Search size={18} />}
            actions={(
              <div className="flex items-center gap-1.5">
                <Button size="sm" shape="icon" aria-label="Close">
                  <X size={14} />
                </Button>
              </div>
            )}
          />
        </div>
      </SampleCard>

      <SampleCard title="Search page filter row" source="MessageSearchPage">
        <div className="border-2 border-black bg-white">
          <PanelHeader titleSlot={(
            <div className="flex items-center gap-3">
              <div className="flex size-icon-header shrink-0 items-center justify-center border-2 border-black bg-brutal-yellow">
                <Search size={18} />
              </div>
              <div className="flex min-w-0 flex-1 items-center gap-2 border-2 border-black bg-white px-3 py-1.5 shadow-brutal-sm">
                <input
                  className="min-w-0 flex-1 bg-transparent font-display text-sm font-medium outline-none"
                  value="design system"
                  readOnly
                />
                <button type="button" className="btn-brutal-sm bg-white p-1" aria-label="Clear search">
                  <X size={12} />
                </button>
                <span className="hidden border border-black px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase text-black/50 sm:inline">
                  ESC
                </span>
              </div>
            </div>
          )} />
          <div className="flex flex-wrap items-center gap-2 border-b-2 border-black bg-white px-4 py-3">
            <button type="button" className="inline-flex items-center gap-2 border-2 border-black bg-[#ff7ad9] px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-black shadow-brutal-sm transition-colors">
              My messages
            </button>
            <button type="button" className="inline-flex items-center gap-2 border-2 border-black/30 bg-white px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-black/70 transition-colors hover:border-black">
              <Hash size={14} />
              Channel
              <ChevronDown size={12} />
            </button>
            <button type="button" className="inline-flex items-center gap-2 border-2 border-black bg-brutal-cyan px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-black shadow-brutal-sm transition-colors">
              <CalendarRange size={14} />
              Last 7 days
              <ChevronDown size={12} />
            </button>
            <button type="button" className="inline-flex items-center gap-2 border border-black bg-white px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-black/60 hover:text-black">
              Clear all
            </button>
            <SegmentedControl
              value="relevance"
              onValueChange={() => {}}
              aria-label="Sort search results"
              className="ml-auto"
            >
              <SegmentedControlItem value="relevance">
                <SegmentedControlLabel>Relevant</SegmentedControlLabel>
              </SegmentedControlItem>
              <SegmentedControlItem value="recent">
                <SegmentedControlLabel>Recent</SegmentedControlLabel>
              </SegmentedControlItem>
            </SegmentedControl>
          </div>
        </div>
      </SampleCard>

      <SampleCard title="Tasks filter row" source="TasksPanel">
        <div className="border-2 border-black bg-white">
          <div className="flex h-panel-header items-center gap-3 border-b-2 border-black bg-white px-5">
            <div className="hidden size-icon-header items-center justify-center border-2 border-black bg-brutal-yellow md:flex">
              <CheckSquare size={18} />
            </div>
            <div className="min-w-0 flex-1">
              <h2 className="text-base font-bold leading-tight">Tasks</h2>
              <p className="font-mono text-xs text-black/50">12 of 42 channel tasks</p>
            </div>
          </div>
          <div className="shrink-0 border-b-2 border-black bg-white px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" className="inline-flex items-center gap-2 border-2 border-black bg-brutal-cyan px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-black shadow-brutal-sm transition-colors">
                <Hash size={14} />
                Channel
                <span className="border border-black px-1 py-0.5 font-mono text-[10px] leading-none">2</span>
                <ChevronDown size={12} />
              </button>
              <button type="button" className="inline-flex items-center gap-2 border-2 border-black/30 bg-white px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-black/70 transition-colors hover:border-black">
                <UserCircle2 size={14} />
                Creator
                <ChevronDown size={12} />
              </button>
              <button type="button" className="inline-flex items-center gap-2 border-2 border-black bg-brutal-cyan px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-black shadow-brutal-sm transition-colors">
                <User size={14} />
                Assignee
                <span className="border border-black px-1 py-0.5 font-mono text-[10px] leading-none">1</span>
                <ChevronDown size={12} />
              </button>
              <button type="button" className="inline-flex items-center gap-2 border border-black bg-white px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-black/60 hover:text-black">
                Clear all
              </button>
              <SegmentedControl
                value="board"
                onValueChange={() => {}}
                aria-label="Task view"
                className="ml-auto"
              >
                <SegmentedControlItem value="board">
                  <SegmentedControlLabel>Board</SegmentedControlLabel>
                </SegmentedControlItem>
                <SegmentedControlItem value="list">
                  <SegmentedControlLabel>List</SegmentedControlLabel>
                </SegmentedControlItem>
              </SegmentedControl>
            </div>
          </div>
        </div>
      </SampleCard>

      {/* Sidebar list density sample dropped (stdrc msg=79eaffd3):
          previous hand-rolled rows used `hover:border-black` only — real
          Sidebar.tsx uses `border-transparent hover:border-black
          hover:bg-white hover:shadow-brutal-sm` (4+ duplicated callsites,
          lines 708/1367/1404/1440/1464). The right move is to extract
          a `SidebarItem` primitive from those callsites and then mount
          the real component here — tracked as next slice. */}
<SampleCard title="Settings surface" source="SettingsPanel">
        <div className="border-2 border-black bg-white p-4 shadow-brutal-sm">
          <SectionHeader label="Notification Schedule" icon={<CalendarRange size={16} />} className="mb-3" />
          <div className="space-y-4">
            <KeyValueRow label="Timezone" value="Asia/Shanghai" mono />
            <SegmentedControl
              value="weekday"
              onValueChange={() => {}}
              aria-label="Notification schedule"
            >
              <SegmentedControlItem value="weekday">
                <SegmentedControlLabel>Weekdays</SegmentedControlLabel>
              </SegmentedControlItem>
              <SegmentedControlItem value="daily">
                <SegmentedControlLabel>Daily</SegmentedControlLabel>
              </SegmentedControlItem>
            </SegmentedControl>
          </div>
        </div>
      </SampleCard>
    </SampleGrid>
  );
}

function PageTile({
  title,
  route,
  children,
}: {
  title: string;
  route: string;
  children: ReactNode;
}) {
  return (
    <div className="border-2 border-black/30 bg-white p-3 shadow-brutal-sm">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="text-sm font-bold text-black">{title}</div>
        <code className="border border-black/20 bg-white px-1.5 py-0.5 font-mono text-[10px] text-black/50">
          {route}
        </code>
      </div>
      <div className="min-h-32 overflow-hidden border-2 border-black/20 bg-brutal-cream/40">
        {children}
      </div>
    </div>
  );
}

function PageInventoryGrid() {
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <PageTile title="Auth login/register" route="/">
        <div className="flex h-40 items-center justify-center bg-brutal-yellow/40 p-3">
          <div className="w-56 border-2 border-black bg-white p-4 shadow-brutal">
            <div className="mb-3 text-lg font-bold">Sign in</div>
            <div className="mb-2 h-8 border-2 border-black bg-white" />
            <div className="mb-3 h-8 border-2 border-black bg-white" />
            <div className="h-8 border-2 border-black bg-brutal-pink" />
          </div>
        </div>
      </PageTile>
      <PageTile title="Server picker" route="/ server resolver">
        <div className="flex h-40 items-center justify-center bg-brutal-cream p-3">
          <div className="w-60 space-y-2">
            <div className="border-2 border-black bg-white p-3 text-sm font-bold shadow-brutal-sm">Botiverse</div>
            <div className="border-2 border-black bg-white p-3 text-sm font-bold shadow-brutal-sm">Slock Internal</div>
            <div className="border-2 border-black bg-brutal-yellow p-2 text-center text-xs font-bold">+ Create new server</div>
          </div>
        </div>
      </PageTile>
      <PageTile title="Channel / DM chat" route="/s/:server/channel/:id">
        <div className="h-40 bg-white">
          <PanelHeader title="proj-theme" subtitle="Theme and component reuse" icon={<Hash size={18} />} />
          <div className="space-y-2 p-3">
            <div className="ml-8 h-8 border-2 border-black/20 bg-white" />
            <div className="h-8 border-2 border-black/20 bg-brutal-yellow/20" />
          </div>
        </div>
      </PageTile>
      <PageTile title="Agent detail" route="/s/:server/agent/:id">
        <div className="h-40 bg-white">
          <PanelHeader
            title="Wug"
            subtitle="@Wug · codex"
            iconSlot={<AvatarSlot context="panel-header" type="agent" agentAvatarUrl="pixel:robot" />}
            iconAlwaysVisible
          />
          <div className="grid grid-cols-2 gap-2 p-3">
            <KeyValueRow label="Runtime" value="codex" mono />
            <KeyValueRow label="Model" value="gpt-5.5" mono />
          </div>
        </div>
      </PageTile>
      <PageTile title="Human profile" route="/s/:server/human/:id">
        <div className="h-40 bg-white">
          <PanelHeader
            title="cindyz"
            subtitle="@cindyz"
            iconSlot={<AvatarSlot context="panel-header" type="human" humanPlaceholder />}
            iconAlwaysVisible
          />
          <div className="p-3">
            <AvatarListRow
              avatar={<AvatarSlot context="surface-list" type="agent" agentAvatarUrl="pixel:star" />}
              name="Created agent"
              subtitle="active"
            />
          </div>
        </div>
      </PageTile>
      <PageTile title="Machine detail" route="/s/:server/computer/:id">
        <div className="h-40 bg-white">
          <PanelHeader title="wenyideMacBook" subtitle="online" icon={<Monitor size={18} />} iconBg="bg-brutal-lime" />
          <div className="space-y-2 p-3">
            <AvatarListRow
              avatar={<AvatarSlot context="surface-list" type="agent" agentAvatarUrl="pixel:flame" />}
              name="Agent on this computer"
              subtitle="working"
              rightContent={<StatusDot tone="bg-brutal-yellow" pulse />}
            />
          </div>
        </div>
      </PageTile>
      <PageTile title="Search" route="/s/:server/search">
        <div className="h-40 bg-white">
          <PanelHeader titleSlot={(
            <div className="flex items-center gap-2">
              <div className="flex size-icon-header shrink-0 items-center justify-center border-2 border-black bg-brutal-yellow">
                <Search size={18} />
              </div>
              <div className="h-8 flex-1 border-2 border-black bg-white shadow-brutal-sm" />
            </div>
          )} />
          <div className="flex gap-2 border-b-2 border-black p-2">
            <span className="inline-flex items-center border-2 border-black bg-[#ff7ad9] px-2 py-1 text-[10px] font-bold uppercase shadow-brutal-sm">My messages</span>
            <span className="inline-flex items-center gap-1 border-2 border-black/30 bg-white px-2 py-1 text-[10px] font-bold uppercase text-black/70">
              <Hash size={12} />
              Channel
            </span>
          </div>
          <div className="p-2">
            <ConversationPreviewCard channelLabel="#proj-theme" preview="Search result preview..." />
          </div>
        </div>
      </PageTile>
      <PageTile title="Tasks" route="/s/:server/tasks">
        <div className="h-40 bg-white">
          <PanelHeader title="Tasks" subtitle="42 channel tasks" icon={<CheckSquare size={18} />} />
          <div className="flex gap-2 border-b-2 border-black p-2">
            <span className="inline-flex items-center gap-1 border-2 border-black bg-brutal-cyan px-2 py-1 text-[10px] font-bold uppercase shadow-brutal-sm">
              <Hash size={12} />
              Channel
            </span>
            <span className="inline-flex items-center gap-1 border-2 border-black/30 bg-white px-2 py-1 text-[10px] font-bold uppercase text-black/70">
              <User size={12} />
              Assignee
            </span>
          </div>
          <div className="p-2">
            <StatusBadge status="in_review">task #13</StatusBadge>
          </div>
        </div>
      </PageTile>
      <PageTile title="Settings" route="/s/:server/settings">
        <div className="h-40 bg-white p-3">
          <SectionHeader label="Owners & Admins" icon={<Settings size={16} />} count={3} className="mb-3" />
          <div className="space-y-2">
            <div className="h-8 border-2 border-black bg-white" />
            <div className="h-8 border-2 border-black bg-white" />
            <Banner intent="warning" density="sm">Settings warning</Banner>
          </div>
        </div>
      </PageTile>
      <PageTile title="Inbox / Threads" route="/s/:server/inbox">
        <div className="h-40 bg-white">
          <PanelHeader title="Inbox" subtitle="Unread work across channels" icon={<Inbox size={18} />} />
          <div className="p-2">
            <ConversationPreviewCard channelLabel="#engineering" preview="Latest reply in a followed thread" active />
          </div>
        </div>
      </PageTile>
      <PageTile title="Saved / Files / Release Notes" route="/s/:server/saved">
        <div className="h-40 bg-white p-3">
          <SectionHeader label="Saved" icon={<Bookmark size={16} />} count={8} className="mb-2" />
          <SurfaceListItem>
            <div className="flex items-center gap-2 text-sm font-bold">
              <FileText size={14} />
              Saved message row
            </div>
          </SurfaceListItem>
        </div>
      </PageTile>
      <PageTile title="Dialogs & modals" route="modal surfaces">
        <div className="flex h-40 items-center justify-center bg-black/10 p-3">
          <div className="w-64 border-2 border-black bg-white p-4 shadow-brutal">
            <div className="mb-3 flex items-center justify-between">
              <div className="font-bold uppercase">Delete agent</div>
              <X size={16} />
            </div>
            <Banner intent="destructive" density="sm" withIcon>Irreversible action.</Banner>
          </div>
        </div>
      </PageTile>
    </div>
  );
}

export default function UIInventoryPage() {
  const [checked, setChecked] = useState(true);
  const scrollToSection = (id: SectionId) => {
    document.getElementById(id)?.scrollIntoView({ block: "start" });
    window.history.replaceState(null, "", `#${id}`);
  };
  const handleSectionClick = (event: MouseEvent<HTMLAnchorElement>, id: SectionId) => {
    event.preventDefault();
    scrollToSection(id);
  };

  useEffect(() => {
    const hash = window.location.hash.slice(1);
    if (!SECTIONS.some((section) => section.id === hash)) return;
    window.requestAnimationFrame(() => scrollToSection(hash as SectionId));
  }, []);

  return (
    <div className="h-full overflow-y-auto bg-brutal-cream font-display text-black">
      <div className="grid min-h-screen lg:grid-cols-[260px_minmax(0,1fr)]">
        <aside className="hidden border-r-2 border-black bg-brutal-yellow px-4 py-5 lg:block">
          <div className="sticky top-5">
            <div className="mb-5 border-2 border-black bg-white p-3 shadow-brutal-sm">
              <SectionEyebrow as="div" className="mb-1">
                Design System
              </SectionEyebrow>
              <h1 className="font-display text-2xl font-bold leading-tight">Slock UI Library</h1>
              <p className="mt-2 text-xs leading-5 text-black/60">
                A standalone inspection page for the real app components, repeated UI patterns, and reuse gaps.
              </p>
            </div>
            <nav className="space-y-1">
              {SECTIONS.map((section) => (
                <a
                  key={section.id}
                  href={`#${section.id}`}
                  onClick={(event) => handleSectionClick(event, section.id)}
                  className="flex items-center justify-between border-2 border-transparent px-2 py-1.5 text-xs font-bold uppercase tracking-wide hover:border-black hover:bg-white"
                >
                  {section.label}
                </a>
              ))}
            </nav>
          </div>
        </aside>

        <main className="min-w-0">
          <header id="purpose" className="border-b-2 border-black bg-white px-5 py-6">
            <div className="max-w-4xl">
              <SectionEyebrow as="div" className="mb-2">
                Design System
              </SectionEyebrow>
              <h1 className="font-display text-4xl font-bold leading-tight text-black">Slock UI Library</h1>
              <p className="mt-3 max-w-3xl text-sm leading-6 text-black/65">
                A live gallery of every primitive in the Slock web package — rendered with the real components and tokens, grouped by use. Use it to compare similar UI, spot drift, and decide which surfaces should reuse a shared primitive.
              </p>
              <div className="mt-4 flex flex-wrap gap-2">
                <Badge variant="warning" uppercase>Standalone</Badge>
                <Badge variant="information" uppercase>Real Components</Badge>
                <Badge variant="accent" uppercase>Grouped By Use</Badge>
              </div>
            </div>
          </header>

          <InventorySection
            id="foundation"
            title="Foundation"
            description="Core tokens and small primitives that many larger components depend on."
          >
            <SampleGrid>
              <SampleCard title="Brutal palette" source="index.css theme tokens">
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  <ColorChip name="brutal-yellow" className="bg-brutal-yellow" />
                  <ColorChip name="brutal-pink" className="bg-brutal-pink" />
                  <ColorChip name="brutal-cyan" className="bg-brutal-cyan" />
                  <ColorChip name="brutal-lavender" className="bg-brutal-lavender" />
                  <ColorChip name="brutal-lime" className="bg-brutal-lime" />
                  <ColorChip name="brutal-orange" className="bg-brutal-orange" />
                  <ColorChip name="brutal-red" className="bg-brutal-red" />
                  <ColorChip name="brutal-stone" className="bg-brutal-stone" />
                  <ColorChip name="brutal-cream" className="bg-brutal-cream" />
                </div>
              </SampleCard>
              <SampleCard title="Section labels" source="SectionEyebrow / SectionHeader">
                <div className="space-y-3">
                  <SectionEyebrow as="div">Plain eyebrow</SectionEyebrow>
                  <SectionHeader label="Agents on this computer" icon={<Bot size={16} />} count={12} action={<Plus size={14} />} />
                  <KeyValueRow label="Machine" value="wenyideMacBook-Pro.local" mono breakAll />
                </div>
              </SampleCard>
            </SampleGrid>
          </InventorySection>

          <InventorySection
            id="buttons"
            title="Buttons & Badges"
            description="Command surfaces, status badges, and compact action affordances."
          >
            <SampleGrid>
              <SampleCard title="Button sizes" source="Button">
                <div className="flex flex-wrap items-center gap-2">
                  <Button size="xs">Extra small</Button>
                  <Button size="sm">Small</Button>
                  <Button size="md" tone="pink">Primary</Button>
                  <Button size="lg" shape="iconText" tone="yellow">
                    <Plus size={16} />
                    New
                  </Button>
                  <Button shape="icon" tone="red" aria-label="Delete">
                    <Trash2 size={14} />
                  </Button>
                </div>
              </SampleCard>
              <SampleCard title="Badges and task status" source="Badge / StatusBadge">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="warning" uppercase>Channel</Badge>
                  <Badge render={<button type="button" />} variant="accent" uppercase>99+</Badge>
                  {TASK_STATUSES.map((status) => (
                    <StatusBadge key={status} status={status}>
                      {TASK_STATUS_LABELS[status]}
                    </StatusBadge>
                  ))}
                </div>
              </SampleCard>
            </SampleGrid>
          </InventorySection>

          <InventorySection
            id="forms"
            title="Forms"
            description="Field wrappers, inputs, textareas, checkboxes, and validation states."
          >
            <SampleGrid>
              <SampleCard title="Form fields" source="FormField + input-brutal">
                <div className="grid gap-3">
                  <FormField label="Agent name" required hint="Use a short display name.">
                    <input className="input-brutal w-full" value="Wug" readOnly />
                  </FormField>
                  <FormField label="Description" optional error="Description is too long.">
                    <input className="input-brutal !border-brutal-red w-full ring-2 ring-brutal-red/60" value="Full Stack. Design. Visual." readOnly />
                  </FormField>
                </div>
              </SampleCard>
              <SampleCard title="Textarea + checkbox" source="Textarea / Checkbox">
                <div className="grid gap-3">
                  <Textarea
                    value="Keep the terminal window open, and don't stop the command you just ran."
                    readOnly
                    showCounter
                    limit={120}
                    hint="Helper text and counter stay inside the same primitive."
                  />
                  {/* Match the real MessageInput "As Task" composer affordance:
                      inline-flex + items-center + gap-1.5 — same row, vertical-center
                      box + text. */}
                  <label className="inline-flex items-center gap-1.5 select-none text-sm font-bold">
                    <Checkbox checked={checked} onChange={(event) => setChecked(event.currentTarget.checked)} size="md" />
                    <span>Send this as a task</span>
                  </label>
                  <div className="flex items-center gap-2">
                    <CheckMarker checked size="lg" />
                    <CheckMarker checked={false} previewOnHover size="lg" />
                    <CheckMarker checked shape="circle" tone="yellow-fill" size="lg" />
                  </div>
                </div>
              </SampleCard>
            </SampleGrid>
          </InventorySection>

          <InventorySection
            id="selection"
            title="Selection"
            description="Selection boxes, filters, menus, and the split between pure enumeration and searchable entity lists."
          >
            <SelectionSamples />
          </InventorySection>

          <InventorySection
            id="feedback"
            title="Feedback"
            description="Banners, empty states, dots, and loading or attention indicators."
          >
            <SampleGrid>
              <SampleCard title="Banners by intent" source="Banner">
                <div className="space-y-2">
                  <Banner intent="info" withIcon title="Info">Plan limit notice or neutral guidance.</Banner>
                  <Banner intent="warning" withIcon title="Warning">Recoverable validation or setup issue.</Banner>
                  <Banner intent="destructive" withIcon title="Destructive">Irreversible delete or stop warning.</Banner>
                  <Banner intent="success" withIcon title="Success">Saved or completed confirmation.</Banner>
                </div>
              </SampleCard>
              <SampleCard title="Empty and attention states" source="EmptyState / StatusDot / AttentionDot">
                <div className="grid gap-3">
                  <div className="flex items-center gap-4">
                    <StatusDot tone="bg-brutal-lime" />
                    <StatusDot tone="bg-brutal-yellow" pulse />
                    <StatusDot tone="bg-gray-400" />
                    <AttentionDot />
                    <AttentionDot size="sm" />
                  </div>
                  <div className="border-2 border-black/20">
                    <EmptyState
                      icon={<Inbox size={36} />}
                      title="No tasks match this filter"
                      description="Try another channel filter or clear the current selection."
                      action={<Button>Clear filters</Button>}
                    />
                  </div>
                </div>
              </SampleCard>
            </SampleGrid>
          </InventorySection>

          <InventorySection
            id="identity"
            title="Identity"
            description="Agent and human avatar sizes, presence, and participant rows."
          >
            <SampleGrid>
              <SampleCard title="Avatar contexts" source="AvatarSlot / PixelAvatar">
                <div className="flex flex-wrap items-end gap-4">
                  <AvatarSlot context="profile-tile" type="agent" agentAvatarUrl="pixel:robot" />
                  <AvatarSlot context="mention-card" type="agent" agentAvatarUrl="pixel:star" />
                  <AvatarSlot context="panel-header" type="human" humanPlaceholder />
                  <AvatarSlot context="surface-list" type="agent" agentAvatarUrl="pixel:flame" />
                  <AvatarSlot context="compact-list" type="human" humanPlaceholder />
                  <AgentAvatar avatarUrl="pixel:random:ui-inventory" size={40} />
                </div>
              </SampleCard>
              <SampleCard title="Avatar list row" source="AvatarListRow">
                <div className="space-y-2">
                  <AvatarListRow
                    avatar={<AvatarSlot context="surface-list" type="agent" agentAvatarUrl="pixel:robot" />}
                    name="Wug"
                    subtitle="codex / gpt-5.5"
                    rightContent={<><StatusDot tone="bg-brutal-yellow" pulse /><span className="text-xs font-mono text-black/50">working</span></>}
                    onClick={() => {}}
                  />
                  <AvatarListRow
                    avatar={<AvatarSlot context="surface-list" type="human" humanPlaceholder />}
                    name="cindyz"
                    subtitle="owner"
                    rightContent={<Button size="xs">Remove</Button>}
                  />
                </div>
              </SampleCard>
            </SampleGrid>
          </InventorySection>

          <InventorySection
            id="lists"
            title="Lists & Cards"
            description="Reusable row/card shells for task, inbox, channel members, and detail panels."
          >
            <SampleGrid>
              <SampleCard title="Surface list items" source="SurfaceListItem">
                <div className="space-y-2">
                  <SurfaceListItem selected>
                    <div className="flex items-center gap-2">
                      <Star size={14} />
                      <span className="font-bold">Selected row</span>
                    </div>
                  </SurfaceListItem>
                  <SurfaceListItem>
                    <div className="flex items-center gap-2">
                      <FileText size={14} />
                      <span className="font-bold">Interactive row</span>
                    </div>
                  </SurfaceListItem>
                </div>
              </SampleCard>
              <SampleCard title="Conversation preview" source="ConversationPreviewCard">
                <ConversationPreviewCard
                  channelLabel="#proj-theme"
                  author={{ kind: "agent", name: "Wug", avatarUrl: "pixel:robot" }}
                  timestamp="2m ago"
                  preview="This shared selection component should cover both searchable entity filters and fixed enum lists."
                  marker={<Badge variant="accent" uppercase>thread</Badge>}
                  active
                />
              </SampleCard>
            </SampleGrid>
          </InventorySection>

          <InventorySection
            id="messages"
            title="Messages"
            description="Two distinct shapes — the preview card used in activity / saved / threads-inbox surfaces, and the full chat-timeline message row. Every sample below imports the real component (stdrc #proj-theme:ac79cf20 msg=61b61c6c + msg=ed524769 — UI Library is the single source of truth; samples must use the actual import so changes here propagate to every callsite)."
          >
            <SampleGrid>
              <SampleCard
                title="Message preview card"
                source="ConversationPreviewCard"
                note="Used in DMs list / Threads inbox / search results."
              >
                <ConversationPreviewCard
                  channelLabel="#proj-theme"
                  author={{ kind: "agent", name: "Wug", avatarUrl: "pixel:robot" }}
                  timestamp="2m"
                  preview="Added /ui-inventory route with grouped component samples."
                />
              </SampleCard>
              <SampleCard
                title="Message timeline row"
                source="MessageItem"
                note="Pending — MessageItem couples ~10 zustand stores + react-router. Adding MockProviders wrapper as next slice (see #proj-theme:ac79cf20 plan)."
              >
                <div className="border-2 border-black/30 bg-white p-4 text-xs text-black/50 font-mono">
                  TODO: import {`<MessageItem />`} with MockProviders.
                </div>
              </SampleCard>
            </SampleGrid>
          </InventorySection>

          <InventorySection
            id="pages"
            title="Page Shells"
            description="Route-level surfaces — panel header, filter/toolbar row, content density. Each card mounts the real composable chrome (PanelHeader / SegmentedControl / SelectionPopover / SectionHeader / StatusBadge etc.) at full size; the stand-in body rows match the shape of the actual MessageSearchPage / TasksPanel / SettingsPanel / ChatPanel surfaces."
          >
            <PageShellSamples />
          </InventorySection>
        </main>
      </div>
    </div>
  );
}
