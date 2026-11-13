import { ChevronRight, Hash, Lock } from "lucide-react";
import { useCallback, useState } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import {
  PanelHeader,
  PanelHeaderContent,
  PanelHeaderIcon,
  PanelTitle,
  SidebarHeader,
} from "@botiverse/raft-ui";
import { RAFT_APP_SERVER_PATH_PREFIX } from "../../brand/constants";
import AvatarSlot from "../ui/AvatarSlot";
import SectionEyebrow from "../ui/SectionEyebrow";

import type { MessageId } from "../../i18n/messages";

// The section labels reuse the REAL sidebar's ids rather than minting preview
// copies. Six ids already read "Channels"; a seventh would be one more row for
// the `common.*` hoist to clean up (task #17). It also makes the preview track
// what it is previewing — and surfaced that the two had already drifted: the
// sidebar says "Direct Messages", this said "Direct messages". Converging on the
// sidebar's casing is a deliberate visible change, flagged for @AngLee.
//
// The preview's channel names, slug, and address are DELIBERATELY not catalog
// ids. `all` and `onboarding-owner` are real channels this flow creates, so the
// preview would be lying if it showed a translated name the user then could not
// find. Same for the sample server slug, which must stay URL-safe ASCII.
const PREVIEW_CHANNEL = "onboarding-owner";

// Stryker disable all: this is a visual-only onboarding preview shell. Behavior
// is covered at the ServerSelector boundary; fidelity is verified by screenshot
// review against the design fixture.
const DEFAULT_SERVER_NAME = "Alex Chen Studio";
const DEFAULT_SERVER_SLUG = "alex-chen-studio";

const DIRECT_MESSAGES = [
  { name: "Cindy", avatarUrl: "pixel:mug" },
];

function displayServerName(name: string) {
  return name.trim() || DEFAULT_SERVER_NAME;
}

function displayServerSlug(slug: string) {
  return slug.trim() || DEFAULT_SERVER_SLUG;
}

function SectionLabel({
  labelId,
  count,
  testId,
  expanded,
  controls,
  onToggle,
}: {
  // Named `labelId`, not `label`, and typed as MessageId. A prop called `label`
  // holding an id is precisely the confusion that lets a raw string render on
  // screen while typecheck stays green — and a bare `label="some.catalog.id"`
  // also reads as prose to the hardcoded-English scanner.
  labelId: MessageId;
  count: number;
  testId: string;
  expanded: boolean;
  controls: string;
  onToggle: () => void;
}) {
  const { formatMessage } = useIntl();
  const labelText = formatMessage({ id: labelId });
  return (
    <div className="mb-1 mt-3 flex h-7 items-center justify-between px-2">
      <SectionEyebrow
        as="button"
        onClick={onToggle}
        className="-mx-1 flex min-w-0 items-center gap-1.5 rounded-control px-1 py-0.5 outline-none hover:bg-fill-medium focus-visible:shadow-focus active:bg-fill-medium"
        // Was aria-label={`${label} section`}. Blank the hole and the residue is
        // " section" — a single lowercase word that no prose heuristic can tell
        // from code, which is exactly why the shared scanner grew a positional
        // rule for template literals in text-bearing props (#5840).
        aria-label={formatMessage({ id: "onboarding.serverPreview.sectionAria" }, { label: labelText })}
        aria-expanded={expanded}
        aria-controls={controls}
        data-testid={testId}
      >
        <ChevronRight
          size={14}
          strokeWidth={2}
          className={`shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`}
          aria-hidden="true"
        />
        <span>{labelText}</span>
        <span className="font-mono text-mono-meta font-normal">
          {count}
        </span>
      </SectionEyebrow>
    </div>
  );
}

function SidebarRow({
  children,
  avatar,
  active = false,
  hash = false,
}: {
  children: ReactNode;
  avatar?: ReactNode;
  active?: boolean;
  hash?: boolean;
}) {
  return (
    <div
      className={`flex min-h-8 items-center gap-1.5 rounded-control border-[1.5px] px-2 py-1 text-footnote ${
        active
          ? "border-sticker-ink bg-selected font-bold text-sticker-ink"
          : "border-transparent font-medium text-foreground"
      }`}
    >
      {hash ? <span className={active ? "text-sticker-ink" : "text-foreground-hint"}>#</span> : null}
      {avatar}
      <span className="truncate">{children}</span>
    </div>
  );
}
// Stryker restore all

function MessageRow({
  avatar,
  name,
  label,
  children,
}: {
  avatar: ReactNode;
  name: string;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-start gap-2.5">
      {avatar}
      <div className="min-w-0">
        <div className="flex min-w-0 items-baseline gap-1.5">
          <span className="text-footnote font-bold text-foreground">{name}</span>
          <span className="truncate text-caption text-foreground-hint">
            {label}
          </span>
        </div>
        <div className="mt-0.5 text-callout text-foreground">{children}</div>
      </div>
    </div>
  );
}

export default function ServerCreatePreview({
  serverName,
  serverSlug,
}: {
  serverName: string;
  serverSlug: string;
}) {
  const { formatMessage } = useIntl();
  const previewName = displayServerName(serverName);
  const previewSlug = displayServerSlug(serverSlug);
  const hasCustomName = previewName !== DEFAULT_SERVER_NAME;
  const hasCustomSlug = previewSlug !== DEFAULT_SERVER_SLUG;
  const [channelsExpanded, setChannelsExpanded] = useState(true);
  const [agentsExpanded, setAgentsExpanded] = useState(true);
  const handleToggleChannels = useCallback(() => {
    setChannelsExpanded((expanded) => !expanded);
  }, []);
  const handleToggleAgents = useCallback(() => {
    setAgentsExpanded((expanded) => !expanded);
  }, []);

  return (
    <div
      className="flex min-h-[520px] flex-1 rotate-[-1deg] flex-col overflow-hidden rounded-container border-[1.5px] border-line-strong bg-layer-canvas shadow-sticker"
      data-testid="server-create-preview"
    >
      <div className="flex shrink-0 flex-col gap-2 border-b border-line-seam bg-layer-sidebar p-3">
        <div className="flex gap-1.5 pl-px" aria-hidden="true">
          <i className="size-3 rounded-[2px] border-[1.5px] border-sticker-ink bg-attention" />
          <i className="size-3 rounded-[2px] border-[1.5px] border-sticker-ink bg-brand" />
          <i className="size-3 rounded-[2px] border-[1.5px] border-sticker-ink bg-success" />
        </div>
        <div className="flex h-8 items-center justify-center rounded-control border-[1.5px] border-line-strong bg-layer-card px-3 font-mono text-mono-meta text-foreground-muted">
          <span className="inline-flex min-w-0 items-center gap-1.5">
            <Lock size={12} className="shrink-0 text-foreground-hint" />
            <span className="shrink-0 text-foreground-hint">{RAFT_APP_SERVER_PATH_PREFIX}</span>
            <span
              key={previewSlug}
              className={`min-w-0 truncate font-bold text-foreground ${hasCustomSlug ? "onboarding-preview-pop inline-block" : ""}`}
              data-testid="server-preview-address-slug"
            >
              {previewSlug}
            </span>
          </span>
        </div>
      </div>
      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-[200px] shrink-0 flex-col border-r border-line-seam bg-layer-sidebar sm:flex">
          {/* The preview's heads are the app's own raft-ui heads. */}
          <SidebarHeader>
            <span
              key={previewName}
              className="onboarding-preview-pop inline-flex h-8 max-w-full items-center gap-1.5 rounded-control bg-sticker-ink px-2.5 text-footnote font-bold text-brand shadow-[0_0_0_1.5px_var(--sticker-edge)] [--onboarding-pop-rotate:-2deg]"
              data-testid="server-preview-sidebar-badge"
            >
              <span className="truncate">{previewName}</span>
            </span>
          </SidebarHeader>
          <SectionLabel
            labelId="layout.sidebar.channels"
            count={2}
            testId="server-preview-section-channels"
            expanded={channelsExpanded}
            controls="server-preview-channel-rows"
            onToggle={handleToggleChannels}
          />
          {channelsExpanded ? (
            <div className="flex flex-col gap-1 px-2" id="server-preview-channel-rows">
              {/* #all first: it is the channel everyone is in, and the one the eye
                  should land on before the owner-only setup channel. */}
              <SidebarRow hash>all</SidebarRow>
              <SidebarRow active hash>{PREVIEW_CHANNEL}</SidebarRow>
            </div>
          ) : null}
          <SectionLabel
            labelId="layout.sidebar.directMessages"
            count={DIRECT_MESSAGES.length}
            testId="server-preview-section-dms"
            expanded={agentsExpanded}
            controls="server-preview-dm-rows"
            onToggle={handleToggleAgents}
          />
          {agentsExpanded ? (
            <div className="flex flex-col gap-1 px-2" id="server-preview-dm-rows">
              {DIRECT_MESSAGES.map((dm) => (
                <SidebarRow
                  key={dm.name}
                  avatar={
                    <AvatarSlot
                      context="compact-list"
                      type="agent"
                      agentAvatarUrl={dm.avatarUrl}
                      className="mt-px"
                    />
                  }
                >
                  {dm.name}
                </SidebarRow>
              ))}
            </div>
          ) : null}
        </aside>
        <section className="flex min-w-0 flex-1 flex-col bg-layer-canvas">
          <PanelHeader>
            <PanelHeaderIcon>
              <Hash />
            </PanelHeaderIcon>
            <PanelHeaderContent>
              <PanelTitle render={<h2>{PREVIEW_CHANNEL}</h2>} />
            </PanelHeaderContent>
          </PanelHeader>
          <div className="flex min-h-0 flex-1 flex-col gap-3.5 p-4">
            <MessageRow
              avatar={
                <AvatarSlot context="compact-row" type="agent" agentAvatarUrl="pixel:mug" className="mt-px" />
              }
              name="Cindy"
              label={formatMessage({ id: "onboarding.serverPreview.agentRole" })}
            >
              <span key={`${previewName}:${previewSlug}`} className="onboarding-live-message inline-block">
                {hasCustomName
                  ? formatMessage({ id: "onboarding.serverPreview.agentPreparing" }, { serverName: previewName })
                  : formatMessage({ id: "onboarding.serverPreview.agentIntro" })}
              </span>
            </MessageRow>
          </div>
          <div className="p-3">
            <div className="rounded-container border-[1.5px] border-line-strong bg-layer-card px-3 py-2 text-callout text-foreground-hint">
              {formatMessage({ id: "onboarding.serverPreview.composerPlaceholder" }, { channel: PREVIEW_CHANNEL })}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
