import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import type { IntlShape } from "react-intl";
import {
  AlertTriangle,
  Check,
  CheckSquare,
  Hash,
  Link as LinkIcon,
  MessageSquare,
  Monitor,
  Plus,
  Settings as SettingsIcon,
  Trash2,
  Users,
} from "lucide-react";
import { InlineCode } from "raft-ui";
import AvatarSlot from "../components/ui/AvatarSlot";

/**
 * Palette audit page — task #92 (#proj-uiux:0e6befb8).
 *
 * Goal: every sample below is a 1:1 copy of how the token is actually
 * used somewhere in the app. Each sample carries a `// from <file>:<line>`
 * pointer so a reviewer can confirm we're auditing the real surface, not a
 * hand-wavy approximation.
 *
 * stdrc 2026-05-03 #proj-uiux:0e6befb8: "你为什么无法完全原样 demo 用到的
 * 组件" — first cut had hand-painted className strings that drifted from
 * reality (e.g. `text-white` slapped on the Delete button when the real
 * one uses default black; `bg-brutal-orange` for thinking dot when the
 * real `getActivityDotClass` returns `bg-soft-signal animate-pulse`).
 * This rewrite rebuilds every sample from the live source.
 *
 * Standalone (no MainLayout, no auth) so overflow-y-auto works without
 * the `#root { overflow: hidden }` cage. Activate via /palette-audit.
 */

const COLORS = [
  {
    name: "brutal-yellow",
    hex: "#FFD440",
    note: "Plan A — Soft Signal (full saturation, brand anchor)",
  },
  {
    name: "brutal-pink",
    hex: "#FE7DA8",
    note: "Plan A — Bubble Pink (full saturation, CTA anchor)",
  },
  {
    name: "brutal-cyan",
    hex: "#27CCF3",
    note: "OKLCH(78.3%, 0.135, 219°) — locked to lavender's L (closest cool figma anchor)",
  },
  {
    name: "brutal-orange",
    hex: "#F8A16F",
    note: "OKLCH(78.5%, 0.123, 50°) — figma avg L − 2%",
  },
  {
    name: "brutal-lime",
    hex: "#A9D877",
    note: "OKLCH(82.6%, 0.135, 130°) — figma avg L + 2%",
  },
  {
    name: "brutal-lavender",
    hex: "#BBAFE6",
    note: "Plan A — Soft Haze (full saturation, kept)",
  },
  {
    name: "brutal-red",
    hex: "#F97264",
    note: "OKLCH(71%, 0.168, 28°) — coral-red, lightness +2% from #F26C5E per stdrc \"再淡一点点\"",
  },
] as const;

const TINTS = [10, 20, 30, 40, 50, 60] as const;

function Section({ title, eyebrow, children }: { title: string; eyebrow?: string; children: ReactNode }) {
  return (
    <section className="mb-12">
      <header className="mb-4">
        {eyebrow && (
          <div className="text-xs font-bold uppercase text-black/60 tracking-widest mb-1">{eyebrow}</div>
        )}
        <h2 className="text-2xl font-bold font-display">{title}</h2>
      </header>
      <div className="space-y-6">{children}</div>
    </section>
  );
}

function Sample({ source, children }: { source: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3 py-1">
      <InlineCode className="w-72 shrink-0 text-[11px] leading-snug text-black/45">{source}</InlineCode>
      <div className="flex items-center gap-3 flex-wrap min-h-[2rem]">{children}</div>
    </div>
  );
}

function ColorRow({ color }: { color: typeof COLORS[number] }) {
  const { formatMessage } = useIntl();
  return (
    <div className="border-2 border-black bg-white p-5 shadow-brutal">
      {/* Token header */}
      <div className="flex items-baseline gap-3 mb-4 flex-wrap">
        <h3 className="text-xl font-bold font-display">{color.name}</h3>
        <InlineCode className="text-sm text-black/60">{color.hex}</InlineCode>
        <span className="text-xs text-black/50 italic">{color.note}</span>
      </div>

      {/* Solid + tints scale.
          Dynamic Tailwind class names (`bg-${name}/${t}`) don't work with
          v4 JIT — classes must be literal strings. Use `style` with CSS
          color-mix on the @theme variable instead, which gives us the
          identical opacity-blend behavior for any token + tint level. */}
      <div className="mb-5">
        <div className="text-xs font-bold uppercase text-black/60 tracking-widest mb-2">{formatMessage({ id: "pages.paletteAudit.solidTints" })}</div>
        <div className="flex items-center gap-1">
          <div
            className="w-16 h-16 border-2 border-black flex items-center justify-center text-[10px] font-mono text-black/60"
            title="100%"
            style={{ backgroundColor: `var(--color-${color.name})` }}
          >
            100
          </div>
          {TINTS.map((t) => (
            <div
              key={t}
              className="w-16 h-16 border-2 border-black flex items-center justify-center text-[10px] font-mono text-black/60"
              title={`${t}%`}
              style={{ backgroundColor: `color-mix(in srgb, var(--color-${color.name}) ${t}%, transparent)` }}
            >
              /{t}
            </div>
          ))}
        </div>
      </div>

      {/* Real-component samples */}
      <div>
        <div className="text-xs font-bold uppercase text-black/60 tracking-widest mb-2">{formatMessage({ id: "pages.paletteAudit.realComponentsPrefix" })} {color.name}</div>
        <div className="space-y-1">{realComponentsFor(color.name, formatMessage)}</div>
      </div>
    </div>
  );
}

function realComponentsFor(
  token: string,
  formatMessage: IntlShape["formatMessage"],
): ReactNode {
  switch (token) {
    case "brutal-yellow":
      return (
        <>
          {/* from LeftRail.tsx:88 — full rail strip wrapper */}
          <Sample source="LeftRail.tsx:88 — rail strip">
            <div className="hidden md:flex h-32 w-[64px] shrink-0 flex-col items-center border-2 border-black bg-soft-signal gap-1.5 py-2">
              <button
                type="button"
                className="relative inline-flex size-10 items-center justify-center border-2 border-black bg-black font-display text-base font-bold text-soft-signal shadow-brutal-sm"
              >
                S
              </button>
              <button
                type="button"
                aria-pressed="true"
                className="inline-flex size-10 items-center justify-center border-2 border-black bg-white shadow-brutal-sm"
              >
                <MessageSquare size={18} />
              </button>
              <button
                type="button"
                className="inline-flex size-10 items-center justify-center border-2 border-transparent hover:border-black hover:bg-white"
              >
                <CheckSquare size={18} />
              </button>
            </div>
          </Sample>

          {/* from ChatPanel.tsx:558-ish — channel hash icon container */}
          <Sample source="ChatPanel.tsx panel header channel icon">
            <div className="flex size-9 shrink-0 items-center justify-center border-2 border-black bg-soft-signal text-black">
              <Hash size={18} />
            </div>
          </Sample>

          {/* from MessageItem.tsx:340 — task ref inline link */}
          <Sample source="MessageItem.tsx:340 — task #N inline ref">
            <a
              href="#"
              className="bg-soft-signal/40 px-1 text-sm font-bold text-black border border-black hover:bg-soft-signal"
            >
              task #92
            </a>
          </Sample>

          {/* from MessageItem.tsx:328 — invalid task ref placeholder */}
          <Sample source="MessageItem.tsx:328 — invalid task ref">
            <span className="bg-soft-signal/30 px-1 text-sm font-bold text-black border border-black opacity-60">
              task #abc
            </span>
          </Sample>

          {/* from MessageItem.tsx:374 — slock permalink to current server */}
          <Sample source="MessageItem.tsx:374 — slock permalink (current server)">
            <a
              href="#"
              className="inline-flex items-center gap-1 border border-black px-1.5 py-0.5 text-sm font-bold bg-soft-signal/40 text-black hover:bg-soft-signal"
            >
              <LinkIcon size={12} />
              <span>#general</span>
              <span className="font-mono text-[10px] text-black/50">msg</span>
            </a>
          </Sample>

          {/* from LeftRail.tsx:130 — server menu hover (normal) */}
          <Sample source="LeftRail.tsx:130 — menu hover (normal)">
            <div className="card-brutal overflow-hidden w-56">
              <button className="flex w-full items-center gap-2 px-3 py-2 text-sm font-medium text-black hover:bg-soft-signal transition-colors">
                <Check size={14} className="opacity-100" />
                <span>Hover Me</span>
              </button>
            </div>
          </Sample>

          {/* from getActivityDotClass — thinking/working dot is FIXED status
              yellow + animate-pulse (status lights never re-skin) */}
          <Sample source="utils/activity.ts:11 — thinking/working dot">
            <span className="size-2.5 rounded-full border border-black bg-status-busy animate-pulse" />
            <span className="text-sm text-black/60 font-mono">thinking…</span>
          </Sample>
        </>
      );

    case "brutal-pink":
      return (
        <>
          {/* from Sidebar.tsx:561 — selected sidebar item */}
          <Sample source="Sidebar.tsx:561 — selected channel item">
            <div className="inline-flex items-center gap-2 border-2 border-black bg-brutal-pink text-black shadow-brutal-sm font-bold px-2 py-1 text-sm">
              <Hash size={14} />
              <span>general</span>
            </div>
          </Sample>

          {/* from Sidebar.tsx:703 — unread count badge (sidebar inline) */}
          <Sample source="Sidebar.tsx:703 / ThreadsInbox.tsx:136 — unread count badge">
            <span className="rounded bg-brutal-pink px-1.5 py-0.5 text-[10px] font-bold leading-none text-white border border-black">
              99+
            </span>
          </Sample>

          {/* from LeftRail.tsx:107 — small notification dot on server initial */}
          <Sample source="LeftRail.tsx:107 — server-switcher unread dot">
            <span className="size-2.5 rounded-full border border-black bg-brutal-pink" />
          </Sample>

          {/* from AnnouncementModal.tsx:181 — primary CTA */}
          <Sample source="AnnouncementModal.tsx:181 — primary CTA">
            <button className="btn-brutal bg-brutal-pink px-4 py-2 text-sm font-bold inline-flex items-center gap-1">
              <Plus size={14} />
              Add Machine
            </button>
          </Sample>

          {/* Small pink action button token sample */}
          <Sample source="small CTA token sample">
            <button className="btn-brutal-sm flex h-7 shrink-0 items-center gap-1 whitespace-nowrap bg-brutal-pink px-2 text-xs font-bold">
              <Plus size={12} />
              New Task
            </button>
          </Sample>

          {/* from MessageItem.tsx:316 — #channel inline ref */}
          <Sample source="MessageItem.tsx:316 — #channel inline ref">
            <a
              href="#"
              className="bg-brutal-pink/30 px-1 text-sm font-bold text-black border border-black hover:bg-brutal-pink/60"
            >
              #engineering
            </a>
          </Sample>

          {/* from ServerSwitcherMenu.tsx — destructive menu item is PINK, not red */}
          <Sample source="ServerSwitcherMenu.tsx — destructive menu item (pink)">
            <div className="card-brutal overflow-hidden w-56">
              <button className="flex w-full items-center gap-2 px-3 py-2 text-sm font-bold text-black hover:bg-brutal-pink transition-colors">
                <Plus size={14} />
                Switch or Create Server
              </button>
            </div>
          </Sample>
        </>
      );

    case "brutal-cyan":
      return (
        <>
          {/* from ChatPanel.tsx — DM/agent panel header avatar.
              Avatar frames intentionally do not use cyan background anymore. */}
          <Sample source="ChatPanel.tsx — panel header avatar (no cyan fill)">
            <AvatarSlot context="panel-header" type="agent" agentAvatarUrl="pixel:robot-cyan" />
          </Sample>

          {/* from AgentDetailPanel.tsx — large avatar.
              Avatar frames intentionally do not use cyan background anymore. */}
          <Sample source="AgentDetailPanel.tsx — large agent avatar (no cyan fill)">
            <AvatarSlot context="profile-tile" type="agent" agentAvatarUrl="pixel:robot-cyan" />
          </Sample>

          {/* from AgentDetailPanel.tsx:995 — runtime label badge */}
          <Sample source="AgentDetailPanel.tsx:995 — runtime label badge">
            <span className="inline-block border-2 border-black bg-brutal-cyan px-2 py-0.5 text-xs font-bold text-black">
              {formatMessage({ id: "brand.claudeCode" })}
            </span>
          </Sample>

          {/* from MessageItem.tsx:981 — pinned/quoted message frame */}
          <Sample source="MessageItem.tsx:981 — pinned/quoted block">
            <div className="border-2 border-black bg-brutal-cyan/25 shadow-brutal mb-1 px-3 py-2 text-sm">
              {formatMessage({ id: "pages.paletteAudit.sampleQuotedMessageContents" })}
            </div>
          </Sample>

          {/* from MessageItem.tsx:290 — thread ref inline link */}
          <Sample source="MessageItem.tsx:290 — thread ref inline">
            <a
              href="#"
              className="bg-brutal-cyan/30 px-1 text-sm font-bold text-black border border-black hover:bg-brutal-cyan/60"
            >
              #proj-uiux:0e6befb8
            </a>
          </Sample>
        </>
      );

    case "brutal-orange":
      return (
        <>
          {/* from getActivityDotClass — error dot only.
              NOTE: thinking/working dots are YELLOW (animate-pulse), not orange.
              See yellow row above for the live thinking dot. */}
          <Sample source="utils/activity.ts:14 — error dot (orange)">
            <span className="size-2.5 rounded-full border border-black bg-brutal-orange" />
            <span className="text-sm text-black/60 font-mono">error</span>
          </Sample>

          {/* from CreateTaskDialog.tsx:68 — error/warning notice card */}
          <Sample source="CreateTaskDialog.tsx:68 — error notice card">
            <div className="border-2 border-black bg-brutal-orange/20 p-3 text-sm text-black font-bold">
              <AlertTriangle size={14} className="inline mr-1.5 -mt-0.5" />
              Title cannot be empty.
            </div>
          </Sample>

          {/* from ConfirmDialog.tsx:75 — destructive notice inside confirm dialog */}
          <Sample source="ConfirmDialog.tsx:75 — confirm-dialog notice">
            <div className="border-2 border-black bg-brutal-orange/20 p-3 text-sm text-black w-80">
              This will remove all associated data and cannot be undone.
            </div>
          </Sample>

          {/* from SettingsPanel.tsx:1409 — full warning card with shadow */}
          <Sample source="SettingsPanel.tsx:1409 — settings warning panel">
            <div className="border-2 border-black bg-brutal-orange/20 shadow-brutal-sm p-4 text-sm text-black w-80">
              <AlertTriangle size={14} className="inline mr-1.5 -mt-0.5" />
              <span className="font-bold">No machine connected.</span>
            </div>
          </Sample>

          {/* from NotificationCenter dot — info=yellow / warning|error=orange.
              Per NotificationCenter.tsx KIND_DOT_BG. */}
          <Sample source="NotificationCenter.tsx — kind dot (warning/error)">
            <div className="flex size-6 shrink-0 items-center justify-center border-2 border-black bg-brutal-orange">
              <AlertTriangle size={14} className="text-black" />
            </div>
          </Sample>
        </>
      );

    case "brutal-lime":
      return (
        <>
          {/* from getActivityDotClass — online */}
          <Sample source="utils/activity.ts:8 — online dot">
            <span className="size-2.5 rounded-full border border-black bg-brutal-lime" />
            <span className="text-sm text-black/60 font-mono">online</span>
          </Sample>

        </>
      );

    case "brutal-lavender":
      return (
        <>
          {/* from ChatPanel.tsx — human/DM panel header avatar.
              Avatar frames intentionally do not use lavender background anymore. */}
          <Sample source="ChatPanel.tsx — human DM header avatar (no lavender fill)">
            <AvatarSlot context="panel-header" type="human" humanPlaceholder />
          </Sample>

          {/* from MentionLink.tsx:27 — actual @mention inline link.
              Note: this is the canonical mention highlight — the prior
              audit version used bg-brutal-orange/20, that was wrong. */}
          <Sample source="MentionLink.tsx:27 — @mention inline">
            <span>
              <a
                href="#"
                className="bg-brutal-lavender/40 px-1 text-sm font-bold text-black border border-black hover:bg-brutal-lavender"
              >
                @stdrc
              </a>{" "}
              <span className="text-sm text-black/60">
                {formatMessage({ id: "pages.paletteAudit.sampleRiskyMessage" })}
              </span>
            </span>
          </Sample>

          {/* from ProfilePreviewCardContent.tsx — bigger avatar in hover card.
              Avatar frames intentionally do not use lavender background anymore. */}
          <Sample source="ProfilePreviewCardContent.tsx — hover-card avatar (no lavender fill)">
            <AvatarSlot context="mention-card" type="human" humanPlaceholder />
          </Sample>

          {/* from ChannelMembers.tsx — small h-7 human avatar.
              Avatar frames intentionally do not use lavender background anymore. */}
          <Sample source="ChannelMembers.tsx — small human avatar (no lavender fill)">
            <AvatarSlot context="members-row" type="human" humanPlaceholder />
          </Sample>

          {/* from AgentRemindersSection.tsx:60 — reminder timestamp pill */}
          <Sample source="AgentRemindersSection.tsx:60 — reminder pill">
            <span className="inline-flex items-center gap-1 border border-black bg-brutal-lavender/30 px-1.5 py-0.5 font-mono text-[11px] text-black">
              fires 14:35
            </span>
          </Sample>

          {/* from ThreadsInbox.tsx:117 — in-review task badge */}
          <Sample source="ThreadsInbox.tsx:117 — in-review task badge">
            <span className="inline-flex items-center gap-1 border-2 border-black bg-brutal-lavender px-1.5 py-0.5 text-[10px] font-bold uppercase">
              In review
            </span>
          </Sample>
        </>
      );

    case "brutal-red":
      return (
        <>
          {/* from AgentDetailPanel.tsx:1673 — Delete agent button.
              Note: NO text-white — actual button uses default black text. */}
          <Sample source="AgentDetailPanel.tsx:1673 — Delete Agent">
            <button className="btn-brutal flex items-center justify-center gap-2 bg-brutal-red px-4 py-2 text-sm font-bold">
              <Trash2 size={14} />
              Delete Agent
            </button>
          </Sample>

          {/* from ConfirmDialog.tsx:94 — destructive confirm button */}
          <Sample source="ConfirmDialog.tsx:94 — destructive confirm">
            <button className="btn-brutal bg-brutal-red px-4 py-2 text-sm">
              Delete
            </button>
          </Sample>

          {/* from MachineDetailPanel.tsx:614 — machine delete button */}
          <Sample source="MachineDetailPanel.tsx:614 — Delete machine">
            <button className="btn-brutal bg-brutal-red px-4 py-2 text-sm font-bold flex items-center gap-1.5 shrink-0">
              <Trash2 size={14} />
              Delete Computer
            </button>
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
    <div className="min-h-screen w-full bg-brutal-cream font-display text-black overflow-y-auto">
      <div className="max-w-5xl mx-auto px-6 py-10">
        <header className="mb-10 border-b-2 border-black pb-6">
          <div className="text-xs font-bold uppercase text-black/60 tracking-widest mb-1">
            {formatMessage({ id: "pages.paletteAudit.eyebrow" })}
          </div>
          <h1 className="text-4xl font-bold font-display mb-2">{formatMessage({ id: "pages.paletteAudit.title" })}</h1>
          <p className="text-sm text-black/60 max-w-2xl">
            {formatMessage({ id: "pages.paletteAudit.introPrefix" })}{" "}
            <InlineCode>file:line</InlineCode>{formatMessage({ id: "pages.paletteAudit.introFileMid" })}
            <InlineCode> packages/web/src/index.css</InlineCode>{" "}
            <InlineCode>@theme</InlineCode> {formatMessage({ id: "pages.paletteAudit.introThemeMid" })}
            {" "}{formatMessage({ id: "pages.paletteAudit.introSuffix" })}
          </p>
        </header>

        <Section title={formatMessage({ id: "pages.paletteAudit.sectionPaletteTitle" })} eyebrow={formatMessage({ id: "pages.paletteAudit.sectionPaletteEyebrow" })}>
          {COLORS.map((c) => (
            <ColorRow key={c.name} color={c} />
          ))}
        </Section>

        <Section title={formatMessage({ id: "pages.paletteAudit.sectionNotesTitle" })} eyebrow={formatMessage({ id: "pages.paletteAudit.sectionNotesEyebrow" })}>
          <div className="border-2 border-black bg-white p-5 text-sm text-black/70 space-y-2">
            <p>
              <SettingsIcon size={12} className="inline mr-1 -mt-0.5" /> The
              <InlineCode className="mx-1">getActivityDotClass()</InlineCode>
              {formatMessage({ id: "pages.paletteAudit.noteActivityDot" })}
            </p>
            <p>
              <Users size={12} className="inline mr-1 -mt-0.5" /> {formatMessage({ id: "pages.paletteAudit.noteMentionPrefix" })}
              <InlineCode className="mx-1">bg-brutal-lavender/40</InlineCode>
              {formatMessage({ id: "pages.paletteAudit.noteMentionMid1" })}
              <InlineCode className="mx-1">MentionLink.tsx:27</InlineCode>
              {formatMessage({ id: "pages.paletteAudit.noteMentionMid2" })}{" "}
              (&quot;@mentioned&quot;){" "}
              {formatMessage({ id: "pages.paletteAudit.noteMentionSuffix" })}
            </p>
            <p>
              <Monitor size={12} className="inline mr-1 -mt-0.5" />{" "}
              <InlineCode className="mx-1">brutal-red</InlineCode> {formatMessage({ id: "pages.paletteAudit.noteRedPrefix" })}{" "}
              <InlineCode className="mx-1">#E08585</InlineCode> {formatMessage({ id: "pages.paletteAudit.noteRedMid1" })}{" "}
              <InlineCode className="mx-1">brutal-pink</InlineCode>{" "}
              {formatMessage({ id: "pages.paletteAudit.noteRedMid2" })} &quot;destructive&quot; {formatMessage({ id: "pages.paletteAudit.noteRedMid3" })}{" "}
              &quot;CTA&quot; {formatMessage({ id: "pages.paletteAudit.noteRedSuffix" })}
            </p>
          </div>
        </Section>
      </div>
    </div>
  );
}
