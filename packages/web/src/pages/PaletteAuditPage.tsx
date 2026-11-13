import type { CSSProperties, ReactNode } from "react";
import { useIntl } from "react-intl";
import type { IntlShape } from "react-intl";
import {
  AlertTriangle,
  ListTodo,
  Hash,
  Link as LinkIcon,
  OctagonAlert,
  Plus,
  Trash2,
} from "lucide-react";
import { Button, Card, InlineCode, ScrollArea, Status, TaskStatusBadge } from "@botiverse/raft-ui";
import { MessageIcon } from "@botiverse/ricons";
import AvatarSlot from "../components/ui/AvatarSlot";
import SectionEyebrow from "../components/ui/SectionEyebrow";

/**
 * Palette audit page — task #92 (#proj-uiux:0e6befb8), rebuilt for the Raft
 * Design System (RUI `raft` family).
 *
 * Every token is shown twice, in a light and a dark (`.light` / `.dark`)
 * scope side by side, so a reviewer audits both modes at once without
 * switching the app. Swatches read the live CSS custom properties, so what is
 * shown is what raft-ui ships, not a copied hex. Under each colour family sit
 * samples of the DS roles it is allowed to play (yellow = you, pink = do it,
 * fixed status colours, stickers with an ink edge).
 *
 * Standalone (no MainLayout, no auth) so overflow-y-auto works without
 * the `#root { overflow: hidden }` cage. Activate via /palette-audit.
 */

type TokenSwatch = {
  name: string;
  /** CSS custom property in the raft scope. */
  token: string;
  /** The Tailwind utility a call site uses. */
  utility: string;
  /** Where the DS allows it (from the DS token notes). */
  note: string;
  soft?: { token: string; utility: string };
};

const COLOR_FAMILY: readonly TokenSwatch[] = [
  { name: "yellow", token: "--brand-400", utility: "bg-brand", note: "Brand: the frame, the channel you are in, your workspace tile. A theme may gray it (Boring Gray); where you are and what you selected use selected, @you and a search hit use you. Never a button or a wash.", soft: { token: "--brand-soft", utility: "bg-brand-soft" } },
  { name: "selected", token: "--selected", utility: "bg-selected", note: "Where you are and what is on: the selected sidebar row, a segment, a tab, a switch, the current step, the picked option. Yellow in every theme." },
  { name: "you", token: "--you", utility: "bg-you", note: "Addressed to you: a mention of you, the @ marker, a search hit, the comment you opened. Yellow in every theme." },
  { name: "pink", token: "--attention-400", utility: "bg-attention", note: "Do it: the one primary button per screen, unread counts, attention dots.", soft: { token: "--attention-soft", utility: "bg-attention-soft" } },
  { name: "cyan", token: "--info", utility: "bg-info", note: "Info: In Progress, runtime tags, external agents; cyan-soft is the selected item in a content list.", soft: { token: "--info-soft", utility: "bg-info-soft" } },
  { name: "lime", token: "--success", utility: "bg-success", note: "Success: online, Done, saved.", soft: { token: "--success-soft", utility: "bg-success-soft" } },
  { name: "lavender", token: "--task-status-in-review", utility: "bg-task-status-in-review", note: "In Review; the fallback behind a person without a photo.", soft: { token: "--task-status-in-review-soft", utility: "bg-task-status-in-review-soft" } },
  { name: "orange", token: "--warning", utility: "bg-warning", note: "Problems: Todo, an agent error, a warning that can be recovered.", soft: { token: "--warning-soft", utility: "bg-warning-soft" } },
  { name: "red", token: "--danger", utility: "bg-danger", note: "Only irreversible consequences: the destructive button. Field errors use danger-strong ink.", soft: { token: "--danger-soft", utility: "bg-danger-soft" } },
  { name: "stone", token: "--inactive", utility: "bg-inactive", note: "Neutral, exited: Closed, offline, neutral tags.", soft: { token: "--inactive-soft", utility: "bg-inactive-soft" } },
];

const SURFACE_FAMILY: readonly TokenSwatch[] = [
  { name: "frame", token: "--layer-frame", utility: "bg-layer-frame", note: "The frame only: desktop rail, phone top bar. Neutral in dark." },
  { name: "sidebar", token: "--layer-sidebar", utility: "bg-layer-sidebar", note: "The desktop sidebar (cream)." },
  { name: "paper", token: "--layer-canvas", utility: "bg-layer-canvas", note: "Everything you read: main content, panel headers, conversation." },
  { name: "surface", token: "--layer-card", utility: "bg-layer-card", note: "Cards, inset lists, inputs, composer." },
  { name: "surface-sunken", token: "--fill-muted", utility: "bg-fill-muted", note: "Segmented tracks, inline code, tokens, skeletons, disabled." },
  { name: "popover", token: "--layer-popover", utility: "bg-layer-popover", note: "Menus, selects, dialogs, sheets." },
  { name: "code", token: "--layer-code", utility: "bg-layer-code", note: "Code blocks and command lines." },
  { name: "hud", token: "--layer-hud", utility: "bg-layer-hud", note: "Tooltip and toast: neutral dark, never yellow." },
];

const LINE_AND_INK_FAMILY: readonly TokenSwatch[] = [
  { name: "line", token: "--line-hairline", utility: "border-line-hairline", note: "Hairline inside content." },
  { name: "line-seam", token: "--line-seam", utility: "border-line-seam", note: "Between regions; menu and dialog edges." },
  { name: "line-strong", token: "--line-strong", utility: "border-[1.5px] border-line-strong", note: "This is a control." },
  { name: "ink", token: "--foreground", utility: "text-foreground", note: "Primary text and icons." },
  { name: "ink-2", token: "--foreground-muted", utility: "text-foreground-muted", note: "Secondary text." },
  { name: "ink-3", token: "--foreground-hint", utility: "text-foreground-hint", note: "Times, ids, section titles, placeholders." },
  { name: "link", token: "--foreground-link", utility: "text-foreground-link", note: "Links in prose." },
  { name: "danger-strong", token: "--danger-strong", utility: "text-danger-strong", note: "Invalid field border and help text, destructive menu items." },
];

const MODES = ["light", "dark"] as const;

const STICKER = "rounded-sticker border-[1.5px] border-sticker-ink";

function Section({ title, eyebrow, children }: { title: string; eyebrow?: string; children: ReactNode }) {
  return (
    <section className="mb-12">
      <header className="mb-4">
        {eyebrow && (
          <div className="mb-1 font-mono text-mono-meta text-foreground-hint">{eyebrow}</div>
        )}
        <h2 className="text-title">{title}</h2>
      </header>
      <div className="stack-y-6">{children}</div>
    </section>
  );
}

function Sample({ source, children }: { source: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 py-1.5 sm:flex-row sm:items-start sm:gap-3">
      <InlineCode className="shrink-0 text-mono-meta text-foreground-hint sm:w-72">{source}</InlineCode>
      <div className="flex min-h-8 min-w-0 flex-wrap items-center gap-3">{children}</div>
    </div>
  );
}

function swatchStyle(token: string): CSSProperties {
  return { backgroundColor: `var(${token})` };
}

/** The same token resolved in a light and a dark raft scope. */
function ModePair({ swatch }: { swatch: TokenSwatch }) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {MODES.map((mode) => (
        <div
          key={mode}
          className={`${mode} flex items-center gap-3 rounded-control border border-line-hairline bg-layer-canvas p-3 text-foreground`}
        >
          <span className={`size-12 shrink-0 ${STICKER}`} style={swatchStyle(swatch.token)} aria-hidden="true" />
          {swatch.soft ? (
            <span className="size-12 shrink-0 rounded-sticker" style={swatchStyle(swatch.soft.token)} aria-hidden="true" />
          ) : null}
          <span className="min-w-0 font-mono text-mono-meta text-foreground-muted">
            <span className="block text-foreground">{mode}</span>
            <span className="block truncate">{swatch.token}</span>
            {swatch.soft ? <span className="block truncate">{swatch.soft.token}</span> : null}
          </span>
        </div>
      ))}
    </div>
  );
}

function TokenRow({ swatch }: { swatch: TokenSwatch }) {
  const { formatMessage } = useIntl();
  const samples = realComponentsFor(swatch.name, formatMessage);
  return (
    <Card className="p-5">
      <div className="mb-4 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="text-headline">{swatch.name}</h3>
        <InlineCode>{swatch.utility}</InlineCode>
        {swatch.soft ? <InlineCode>{swatch.soft.utility}</InlineCode> : null}
        <span className="basis-full text-caption text-foreground-hint">{swatch.note}</span>
      </div>

      <div className="mb-5">
        <SectionEyebrow as="div" className="mb-2">{formatMessage({ id: "pages.paletteAudit.solidTints" })}</SectionEyebrow>
        <ModePair swatch={swatch} />
      </div>

      {samples ? (
        <div>
          <SectionEyebrow as="div" className="mb-2">{formatMessage({ id: "pages.paletteAudit.realComponentsPrefix" })} {swatch.name}</SectionEyebrow>
          <div className="stack-y-1">{samples}</div>
        </div>
      ) : null}
    </Card>
  );
}

function realComponentsFor(
  token: string,
  formatMessage: IntlShape["formatMessage"],
): ReactNode {
  switch (token) {
    case "yellow":
      return (
        <>
          <Sample source="AppRail — frame, workspace tile, selected item">
            <div className="flex w-16 shrink-0 flex-col items-center gap-2 rounded-container border border-line-seam bg-layer-frame py-2">
              <span className="inline-flex size-[35px] items-center justify-center rounded-sticker bg-sticker-ink text-subhead font-bold text-brand shadow-[0_0_0_1.5px_var(--sticker-edge)]">
                S
              </span>
              <span className="inline-flex size-10 items-center justify-center rounded-control border-[1.5px] border-line-frame-active bg-layer-frame-active text-foreground-on-frame-active">
                <MessageIcon width={20} height={20} />
              </span>
              <span className="inline-flex size-10 items-center justify-center rounded-control text-foreground-on-frame">
                <ListTodo size={20} />
              </span>
            </div>
          </Sample>

          <Sample source="PanelHeader — the channel you are in">
            <span className={`inline-flex size-[27px] items-center justify-center bg-brand text-sticker-ink ${STICKER}`}>
              <Hash size={14} />
            </span>
          </Sample>

          <Sample source="Sidebar — selected row">
            <span className={`inline-flex h-9 items-center gap-2 rounded-control border-[1.5px] border-sticker-ink bg-selected pl-2 pr-2.5 text-subhead font-bold text-sticker-ink`}>
              <Hash size={16} />
              <span>general</span>
            </span>
          </Sample>

          <Sample source="Message — @you">
            <span className="text-body">
              <span className="rounded-sticker bg-you px-[3px] font-semibold text-sticker-ink shadow-[inset_0_0_0_1.5px_var(--sticker-ink)]">@stdrc</span>{" "}
              <span className="text-foreground-muted">{formatMessage({ id: "pages.paletteAudit.sampleRiskyMessage" })}</span>
            </span>
          </Sample>

          <Sample source="Menu — hover / keyboard highlight (yellow-soft)">
            <div className="w-60 rounded-container bg-layer-popover p-1 shadow-float ring-1 ring-line-seam">
              <div className="flex h-9 items-center gap-2 rounded-control bg-brand-soft px-2.5 text-callout font-medium text-foreground">
                <span>Hover me</span>
              </div>
              <div className="flex h-9 items-center gap-2 rounded-control px-2.5 text-callout font-medium text-foreground">
                <Plus size={16} className="text-foreground-muted" />
                <span>Switch or create server</span>
              </div>
            </div>
          </Sample>

          <Sample source="Presence — busy (static, never pulsing)">
            <Status variant="primary" aria-hidden="true" />
            <span className="font-mono text-mono-meta text-foreground-muted">thinking…</span>
          </Sample>
        </>
      );

    case "pink":
      return (
        <>
          <Sample source="Badge — unread count">
            <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-sticker bg-attention px-1.5 font-mono text-mono-meta font-bold text-sticker-ink shadow-[inset_0_0_0_1.5px_var(--sticker-ink)]">
              99+
            </span>
          </Sample>

          <Sample source="Button — the screen's one primary action">
            <Button variant="accent" size="lg">
              <Plus size={18} />
              <span>Add machine</span>
            </Button>
            <Button variant="accent" size="md">
              <Plus size={16} />
              <span>New task</span>
            </Button>
          </Sample>

          <Sample source="Message — channel reference chip (pink-soft)">
            <span className="inline-flex h-[22px] items-center gap-0.5 rounded-sticker bg-attention-soft pl-[3px] pr-1.5 text-callout font-semibold text-foreground">
              <span>#engineering</span>
            </span>
          </Sample>
        </>
      );

    case "cyan":
      return (
        <>
          <Sample source="ChatPanel — panel header avatar (the sprite carries its colour)">
            <AvatarSlot context="panel-header" type="agent" agentAvatarUrl="pixel:robot-cyan" />
          </Sample>

          <Sample source="AgentDetailPanel — large agent avatar">
            <AvatarSlot context="profile-tile" type="agent" agentAvatarUrl="pixel:robot-cyan" />
          </Sample>

          <Sample source="StatusChip — runtime tag (cyan-soft, mono)">
            <span className="inline-flex h-[22px] items-center rounded-chip bg-info-soft px-2 font-mono text-mono-meta text-foreground">
              {formatMessage({ id: "brand.claudeCode" })}
            </span>
          </Sample>

          <Sample source="Message — task reference, In Progress">
            <span className="inline-flex h-[22px] items-center gap-1.5 rounded-chip bg-task-status-in-progress-soft pl-1.5 pr-2 text-caption font-semibold text-foreground">
              <Status variant="information" aria-hidden="true" />
              <span className="font-mono font-normal">task #92</span>
            </span>
          </Sample>

          <Sample source="Message — thread and message references (cyan-soft)">
            <span className="inline-flex h-[22px] items-center gap-0.5 rounded-sticker bg-info-soft pl-[3px] pr-1.5 text-callout font-semibold text-foreground">
              <span>#proj-uiux:0e6befb8</span>
            </span>
            <span className="inline-flex h-[22px] items-center gap-1 rounded-sticker bg-info-soft pl-[3px] pr-1.5 text-callout font-semibold text-foreground">
              <LinkIcon size={14} className="text-foreground-muted" />
              <span>#general</span>
              <span className="font-mono text-mono-meta font-normal text-foreground-hint">msg</span>
            </span>
          </Sample>

          <Sample source="Message — jumped-to message (cyan-soft)">
            <div className="w-80 rounded-control bg-info-soft px-3 py-2 text-callout text-foreground">
              {formatMessage({ id: "pages.paletteAudit.sampleQuotedMessageContents" })}
            </div>
          </Sample>
        </>
      );

    case "lime":
      return (
        <Sample source="Presence — online">
          <span className="inline-flex h-[22px] items-center gap-1.5 rounded-chip bg-success-soft pl-1.5 pr-2 text-caption font-semibold text-foreground">
            <Status variant="success" aria-hidden="true" />
            <span>online</span>
          </span>
        </Sample>
      );

    case "lavender":
      return (
        <>
          <Sample source="ChatPanel — person without a photo">
            <AvatarSlot context="panel-header" type="human" humanPlaceholder />
          </Sample>

          <Sample source="ProfilePreviewCardContent — hover-card avatar">
            <AvatarSlot context="mention-card" type="human" humanPlaceholder />
          </Sample>

          <Sample source="ChannelMembers — small person avatar">
            <AvatarSlot context="compact-row" type="human" humanPlaceholder />
          </Sample>

          <Sample source="TaskStatusBadge — In Review">
            <TaskStatusBadge status="in-review">
              <span>In review</span>
            </TaskStatusBadge>
          </Sample>
        </>
      );

    case "orange":
      return (
        <>
          <Sample source="Presence — error (orange, not red)">
            <span className="inline-flex h-[22px] items-center gap-1.5 rounded-chip bg-warning-soft pl-1.5 pr-2 text-caption font-semibold text-foreground">
              <Status variant="warning" aria-hidden="true" />
              <span>error</span>
            </span>
          </Sample>

          <Sample source="Banner — warning (orange-soft, ink type, hairline)">
            <div className="flex w-80 items-start gap-2 rounded-container border border-line-hairline bg-warning-soft p-3 text-callout text-foreground">
              <AlertTriangle size={18} className="mt-px shrink-0" />
              <span className="font-bold">No machine connected.</span>
            </div>
          </Sample>
        </>
      );

    case "red":
      return (
        <>
          <Sample source="Button — irreversible (red sticker, ink type)">
            <Button variant="danger" size="lg">
              <Trash2 size={18} />
              <span>Delete agent</span>
            </Button>
            <Button variant="danger" size="md">
              <Trash2 size={16} />
              <span>Delete computer</span>
            </Button>
          </Sample>

          <Sample source="Dialog — the consequence, then the confirm">
            <div className="w-80 stack-y-3 rounded-dialog bg-layer-popover p-5 shadow-float ring-1 ring-line-seam">
              <div className="flex items-start gap-2 rounded-container border border-line-hairline bg-danger-soft p-3 text-callout text-foreground">
                <OctagonAlert size={18} className="mt-px shrink-0" />
                <span>This will remove all associated data and cannot be undone.</span>
              </div>
              <div className="flex justify-end">
                <Button variant="danger" size="lg">
                  <span>Delete</span>
                </Button>
              </div>
            </div>
          </Sample>

          <Sample source="TextField — invalid (danger-strong ink)">
            <div className="flex w-80 flex-col gap-1.5">
              <span className="flex h-control items-center rounded-control border border-danger-strong bg-layer-card px-3" aria-hidden="true" />
              <span className="text-caption font-semibold text-danger-strong">Title cannot be empty.</span>
            </div>
          </Sample>
        </>
      );

    case "stone":
      return (
        <>
          <Sample source="Presence — offline">
            <Status aria-hidden="true" />
          </Sample>

          <Sample source="Tag — neutral machine label">
            <span className="inline-flex h-[22px] items-center rounded-chip px-1.5 font-mono text-mono-meta text-foreground-muted shadow-[inset_0_0_0_1px_var(--line-hairline)]">
              fires 14:35
            </span>
          </Sample>

          <Sample source="Message — unavailable task reference">
            <span className="inline-flex h-[22px] items-center rounded-chip bg-inactive-soft px-2 font-mono text-mono-meta text-foreground-hint">
              task #abc
            </span>
          </Sample>
        </>
      );

    default:
      return null;
  }
}

export default function PaletteAuditPage() {
  const { formatMessage } = useIntl();
  return (
    <ScrollArea className="min-h-screen w-full bg-layer-canvas font-display text-foreground">
      <div className="mx-auto max-w-5xl px-4 py-10 sm:px-6">
        <header className="mb-10 border-b border-line-seam pb-6">
          <div className="mb-1 font-mono text-mono-meta text-foreground-hint">
            {formatMessage({ id: "pages.paletteAudit.eyebrow" })}
          </div>
          <h1 className="mb-2 text-display">{formatMessage({ id: "pages.paletteAudit.title" })}</h1>
          <p className="max-w-2xl text-callout text-foreground-muted">
            {formatMessage({ id: "pages.paletteAudit.introPrefix" })}{" "}
            <InlineCode>file:line</InlineCode>{formatMessage({ id: "pages.paletteAudit.introFileMid" })}
            <InlineCode> packages/web/src/index.css</InlineCode>{" "}
            <InlineCode>@theme</InlineCode> {formatMessage({ id: "pages.paletteAudit.introThemeMid" })}
            {" "}{formatMessage({ id: "pages.paletteAudit.introSuffix" })}
          </p>
        </header>

        <Section title={formatMessage({ id: "pages.paletteAudit.sectionPaletteTitle" })} eyebrow={formatMessage({ id: "pages.paletteAudit.sectionPaletteEyebrow" })}>
          {COLOR_FAMILY.map((swatch) => (
            <TokenRow key={swatch.name} swatch={swatch} />
          ))}
        </Section>

        <Section title={formatMessage({ id: "pages.paletteAudit.sectionNotesTitle" })} eyebrow={formatMessage({ id: "pages.paletteAudit.sectionNotesEyebrow" })}>
          {[...SURFACE_FAMILY, ...LINE_AND_INK_FAMILY].map((swatch) => (
            <TokenRow key={swatch.name} swatch={swatch} />
          ))}
        </Section>
      </div>
    </ScrollArea>
  );
}
