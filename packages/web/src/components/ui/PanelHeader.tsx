import { ArrowLeft } from "lucide-react";
import { isHostShell } from "../../embed";
import type { HTMLAttributes, ReactNode } from "react";
import Button from "./Button";

// React's `HTMLAttributes` doesn't expose `data-*` keys in TS, so widen
// passthrough prop types with a string-key index signature so callsites
// can attach `data-testid` etc. without casting.
type DivPassthroughProps = HTMLAttributes<HTMLDivElement> & Record<`data-${string}`, string | undefined>;
type ButtonPassthroughProps = HTMLAttributes<HTMLButtonElement> & Record<`data-${string}`, string | undefined>;

/**
 * Canonical panel-header primitive — covers every panel column header
 * in the app (12 callsites: ChatPanel / AgentDetailPanel / HumanDetailPanel
 * / MachineDetailPanel / SettingsPanel / SavedPanel / ThreadsInbox /
 * MessageSearchPage / ReleaseNotesPanel / ThreadPanel × 2 instances).
 *
 * Captures the layout contract from CLAUDE.md "Layout Dimensions" —
 * h-[62px] header, 36px icon container, mobile back chevron, title +
 * optional subtitle, right-aligned actions slot.
 *
 * stdrc 2026-05-10 #wg-theme:220bdc61 ("可以开始了") and follow-up
 * 9b4579f8 ("你想想，能用同一个组件吗？") — Tier 1 audit candidate.
 * Same component, different prop combinations for each surface.
 *
 * **API design**:
 * - `iconBg` accepts a className token (e.g. `"bg-soft-signal"`),
 *   not a raw color value. Future theme upgrades can swap the token
 *   map without touching call sites (Joy 2026-05-10 design API note).
 * - `titleSlot` replaces the H2+subtitle stack entirely — for
 *   non-text titles like the search input in MessageSearchPage.
 * - `titleSuffix` renders inline next to the H2 title — for status
 *   dots / activity indicators in ChatPanel / AgentDetailPanel
 *   that should NOT be truncated with the title text.
 * - `subtitleMultiline` allows subtitle to wrap (default: truncate
 *   to single line). Used by ChatPanel for channel descriptions.
 * - `containerProps` / `titleClickProps` / `mobileBackProps` allow
 *   callsites to pass `data-testid`, click handlers, or HTML title
 *   attributes through to specific elements without leaking the
 *   internal DOM structure into PanelHeader's API surface.
 */
export interface PanelHeaderProps {
  /** Title — primary text or custom node. Wrapped in `<h2 truncate>`.
   *  Use `titleSlot` instead for non-text titles. */
  title?: ReactNode;
  /** Replaces the entire title block (h2 + subtitle). Use this for
   *  non-text titles like search inputs. When provided, `title` /
   *  `subtitle` / `titleSuffix` / `subtitleMultiline` are ignored. */
  titleSlot?: ReactNode;
  /** Optional inline node rendered next to the H2 title (e.g. status
   *  dot, activity indicator). Lives OUTSIDE the truncate envelope so
   *  it never gets cut off. Inside the same flex row as the H2. */
  titleSuffix?: ReactNode;
  /** Optional subtitle line below the title (font-mono, text-xs,
   *  text-black/50). Truncated to single line by default. */
  subtitle?: ReactNode;
  /** When true, subtitle is allowed to wrap to multiple lines instead
   *  of single-line truncation. Used for channel descriptions. */
  subtitleMultiline?: boolean;
  /** Optional icon node (e.g. `<Bookmark size={18} />`) — rendered
   *  inside the size-icon-header container, desktop-only (md:flex). */
  icon?: ReactNode;
  /** ClassName for the icon container background. Defaults to
   *  `bg-soft-signal`. Pass tokens like `bg-brutal-cyan` for
   *  agent/DM surfaces. */
  iconBg?: string;
  /** Pre-wrapped icon slot — bypasses the size-icon-header /
   *  border-2 / iconBg wrapper. Pass elements that bring their own
   *  container (e.g. `<AvatarSlot context="panel-header" ... />`).
   *  Mutually exclusive with `icon`. Honors the same visibility
   *  rules as `icon` (mobile hide unless `iconAlwaysVisible`). */
  iconSlot?: ReactNode;
  /** Whether the icon is visible on every viewport. Default `false`
   *  matches "non-identity" surfaces (Saved / Release Notes / Settings)
   *  that hide the icon on mobile to save header space. Set to `true`
   *  for "identity" surfaces (Human / Agent / Machine detail panels)
   *  where the icon (avatar / mark) IS the identity and must stay
   *  visible at every viewport. */
  iconAlwaysVisible?: boolean;
  /** Optional mobile back-chevron callback. When provided, renders a
   *  `btn-brutal-sm` chevron-left button visible only on mobile
   *  (`md:hidden` by default; ThreadPanel uses `lg:hidden` because
   *  it's an overlay panel with a different breakpoint contract). */
  onMobileBack?: () => void;
  /** Tailwind breakpoint at which the mobile back chevron hides.
   *  Default `"md"`. Use `"lg"` for ThreadPanel-style overlay panels
   *  that show their back chevron longer (because the parent column
   *  layout collapses later). */
  mobileBreakpoint?: "md" | "lg";
  /** Additional props passed to the mobile back button (e.g.
   *  `data-testid`, `title` for tooltip). */
  mobileBackProps?: ButtonPassthroughProps;
  /** Back buttons are responsive by default: they disappear once the
   *  parent/detail columns are visible side-by-side. Drawer-internal page
   *  stacks still need a structural Back control on desktop, because it
   *  returns to the previous page inside the same drawer rather than closing
   *  the drawer. */
  backButtonVisibility?: "responsive" | "always";
  /** Additional props passed to the title-block wrapper (e.g.
   *  `data-testid`, `onClick` for header-title click handlers,
   *  `title` for tooltip). */
  titleClickProps?: DivPassthroughProps;
  /** Additional props passed to the outer header container (e.g.
   *  `data-testid`, `title` for tooltip, additional `className`). */
  containerProps?: DivPassthroughProps;
  /** Right-aligned action slot — typically a row of `Button`s
   *  with `gap-1.5`. */
  actions?: ReactNode;
}

export default function PanelHeader({
  title,
  titleSlot,
  titleSuffix,
  subtitle,
  subtitleMultiline = false,
  icon,
  iconBg = "bg-soft-signal",
  iconSlot,
  iconAlwaysVisible = false,
  onMobileBack,
  mobileBreakpoint = "md",
  mobileBackProps,
  backButtonVisibility = "responsive",
  titleClickProps,
  containerProps,
  actions,
}: PanelHeaderProps) {
  // HOST-SHELL EMBED: the native WebView already draws a title bar, so web must not
  // draw a second one. But the ACTIONS must not die with the title — Computers' "+"
  // and Connected Apps' "Register app" live in this slot, and dropping the whole
  // header (which is what the pre-contract `embed=1` did) silently deletes them.
  // So: no title, no back button, no chrome — actions only, in a compact row.
  //
  // Read synchronously at module load (see embed.ts): a `useEffect` would paint the
  // header on the first frame and remove it on the second — a visible flash that
  // every functional test would still call green.
  if (isHostShell()) {
    if (!actions) return null;
    return (
      <div
        {...containerProps}
        data-testid="panel-header-embed-actions"
        data-embed-shell="host"
        className={`flex items-center justify-end gap-2 px-5 pt-3 ${containerProps?.className ?? ""}`}
      >
        {actions}
      </div>
    );
  }

  const mobileHiddenClass = backButtonVisibility === "always"
    ? ""
    : mobileBreakpoint === "lg"
      ? "lg:hidden"
      : "md:hidden";
  const iconVisibilityClass = iconAlwaysVisible
    ? "flex"
    : mobileBreakpoint === "lg"
    ? "hidden lg:flex"
    : "hidden md:flex";
  const { className: containerExtraClass, ...containerRest } = containerProps ?? {};
  return (
    <div
      {...containerRest}
      // stdrc 2026-05-14 #wg-theme:16123203 "确保同类页面用的组件都是
      // 长得左边 (BEFORE) 那样" — flat `gap-3 px-5` everywhere, no narrow-
      // viewport shrink. Earlier 2026-05-10 rule (`gap-2 px-3 sm:gap-3
      // sm:px-5`) was reverted: stdrc preferred the wider padding seen on
      // the old hand-rolled MobileComputersPanel, so every Settings sub-page
      // (Account / Browser / Server / Computers) now reads the same width
      // at every breakpoint.
      className={`flex h-panel-header items-center gap-3 border-b-2 border-black bg-white px-5 ${containerExtraClass ?? ""}`}
    >
      {onMobileBack && (
        <Button
          {...mobileBackProps}
          onClick={onMobileBack}
          shape="icon"
          className={`${mobileHiddenClass} ${mobileBackProps?.className ?? ""}`}
        >
          <ArrowLeft size={14} />
        </Button>
      )}
      {icon && (
        <div
          className={`${iconVisibilityClass} size-icon-header shrink-0 items-center justify-center border-2 border-black ${iconBg}`}
        >
          {icon}
        </div>
      )}
      {iconSlot && (
        <div className={`${iconVisibilityClass} shrink-0`}>{iconSlot}</div>
      )}
      {titleSlot ? (
        <div className="min-w-0 flex-1">{titleSlot}</div>
      ) : (
        <div
          {...titleClickProps}
          className={`min-w-0 flex-1 ${titleClickProps?.className ?? ""}`}
        >
          <div className="flex items-center gap-2 min-w-0">
            <h2 className="truncate font-bold text-base leading-tight text-black">
              {title}
            </h2>
            {titleSuffix && <div className="shrink-0">{titleSuffix}</div>}
          </div>
          {subtitle && (
            <p
              className={`text-xs text-black/50 font-mono ${
                subtitleMultiline ? "" : "truncate"
              }`}
            >
              {subtitle}
            </p>
          )}
        </div>
      )}
      {actions && (
        <div className="flex shrink-0 items-center gap-1.5">{actions}</div>
      )}
    </div>
  );
}
