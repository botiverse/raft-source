import { useContext } from "react";
import { ArrowLeft } from "lucide-react";
import { isHostShell } from "../../embed";
import type { HTMLAttributes, ReactNode, Ref } from "react";
import type { PanelActionProps } from "@botiverse/raft-ui";
import { PanelAction, PanelActions, PanelHeader, PanelHeaderContent, PanelHeaderIcon, PanelHeading, PanelMeta, PanelStatus, PanelTitle } from "@botiverse/raft-ui";
import { PanelHeadChromeContext } from "../layout/panelHeadChrome";

// React's `HTMLAttributes` doesn't expose `data-*` keys in TS, so widen
// passthrough prop types with a string-key index signature so callsites
// can attach `data-testid` etc. without casting.
type DivPassthroughProps = HTMLAttributes<HTMLDivElement> & Record<`data-${string}`, string | undefined>;
type ButtonPassthroughProps = HTMLAttributes<HTMLButtonElement> & Record<`data-${string}`, string | undefined>;
// raft-ui's PanelAction options the Back takes as well (`activateOnTouchEnd`: Back on finger lift).
type BackButtonProps = ButtonPassthroughProps & Pick<PanelActionProps, "activateOnTouchEnd">;

const NO_CONTAINER_PROPS: DivPassthroughProps = {};

// raft-ui's header icon is the yellow location sticker. Every other panel's
// icon is the DS neutral tile (`rf-chan` / `rf-tile`: the sunken fill, an
// ink-2 glyph, no visible edge and no die-cut ring). raft-ui has no neutral
// PanelHeaderIcon tone yet, so the tile is drawn over the sticker here; the
// ring has to go too, or dark mode cuts a sticker edge round a plain tile.
const ICON_TONE_CLASS = {
  location: "",
  neutral: "border-transparent bg-fill-muted text-foreground-muted ring-0",
} as const;

/**
 * A profile handle is an id, so it is machine text (Space Mono) everywhere:
 * the header subtitle, the creator row and the detail-block handle. The size
 * stays with the slot it sits in.
 */
export const PROFILE_HANDLE_FONT_CLASS = "font-mono";

/**
 * The panel column head: one component for every column, with different
 * prop combinations per surface.
 *
 * Raft Design System › Panel: one head for every column — 56 tall (48 in
 * short windows), white paper with a seam bottom, a 17/22 headline title, a
 * 12/16 ink-3 subtitle, the location sticker or avatar on the left and ghost
 * icon buttons on the right. raft-ui's panel-header recipe draws all of it,
 * edges included; this adapter only arranges the slots.
 *
 * **API design**:
 * - `iconTone` says what the icon tile means: `"location"` is the yellow
 *   "you are here" sticker that only a channel (#) head carries; every other
 *   panel (Tasks, Activity, Saved, Settings, a computer, …) gets the
 *   default `"neutral"` tile — the sunken fill and an ink-2 glyph (DS
 *   ChannelIcon / tile: yellow only marks where you are).
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
export interface AppPanelHeaderProps {
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
  /** Optional subtitle line below the title (12/16 ink-3; pass ids in
   *  `font-mono`). Truncated to single line by default. */
  subtitle?: ReactNode;
  /** When true, subtitle is allowed to wrap to multiple lines instead
   *  of single-line truncation. Used for channel descriptions. */
  subtitleMultiline?: boolean;
  /** Extra classes for the subtitle element (e.g. the profile handle's
   *  machine type — see PROFILE_HANDLE_FONT_CLASS). */
  subtitleClassName?: string;
  /** Optional icon node (e.g. `<Bookmark size={18} />`) — rendered in the
   *  head's 27px icon tile, desktop-only unless `iconAlwaysVisible`. */
  icon?: ReactNode;
  /** What the icon tile means. `"location"` = the yellow "you are here"
   *  sticker, for a channel head only. `"neutral"` (default) = the sunken
   *  tile with an ink-2 glyph, for every other panel. */
  iconTone?: "location" | "neutral";
  /** Pre-wrapped icon slot — bypasses the tile wrapper. Pass
   *  elements that bring their own container (e.g.
   *  `<AvatarSlot context="panel-header" ... />`).
   *  Mutually exclusive with `icon`. Honors the same visibility
   *  rules as `icon` (mobile hide unless `iconAlwaysVisible`). */
  iconSlot?: ReactNode;
  /** Marks what the icon slot holds. `"avatar"` declares an identity
   *  avatar: the sticker chrome is dropped (recipe reads
   *  `data-icon-kind="avatar"` → transparent, auto size) so the avatar's
   *  own sticker is the only frame. Glyph icons keep the sticker. */
  iconKind?: "avatar";
  /** Whether the icon is visible on every viewport. Default `false`
   *  matches "non-identity" surfaces (Saved / Release Notes / Settings)
   *  that hide the icon on mobile to save header space. Set to `true`
   *  for "identity" surfaces (Human / Agent / Machine detail panels)
   *  where the icon (avatar / mark) IS the identity and must stay
   *  visible at every viewport. */
  iconAlwaysVisible?: boolean;
  /** Optional mobile back-chevron callback. When provided, renders a
   *  ghost back button visible only on mobile
   *  (`md:hidden` by default; ThreadPanel uses `lg:hidden` because
   *  it's an overlay panel with a different breakpoint contract). */
  onMobileBack?: () => void;
  /** Tailwind breakpoint at which the mobile back chevron hides.
   *  Default `"md"`. Use `"lg"` for ThreadPanel-style overlay panels
   *  that show their back chevron longer (because the parent column
   *  layout collapses later). */
  mobileBreakpoint?: "md" | "lg";
  /** Additional props passed to the mobile back button (e.g.
   *  `data-testid`, `title` for tooltip, `activateOnTouchEnd`). */
  mobileBackProps?: BackButtonProps;
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
   *  `data-testid`, `title` for tooltip, additional `className`; a `ref`
   *  where the head carries a drag grip, task v2's side sections). */
  containerProps?: DivPassthroughProps & { ref?: Ref<HTMLDivElement> };
  /** Right-aligned action slot — typically ghost icon buttons
   *  (`PanelAction`). */
  actions?: ReactNode;
  /** Classes for the actions group: `[--icon-inset:0px]` when its last action
   *  is a filled button, which sits on the margin rather than being pulled
   *  out by a frameless icon's inset (raft-ui head-edges). */
  actionsClassName?: string;
  /** A control before everything but Back (a `PanelAction`: task v2's collapse chevron). */
  leading?: ReactNode;
}

export default function AppPanelHeader({
  title,
  titleSlot,
  titleSuffix,
  subtitle,
  subtitleMultiline = false,
  subtitleClassName,
  icon,
  iconTone = "neutral",
  iconSlot,
  iconKind,
  iconAlwaysVisible = false,
  onMobileBack,
  mobileBreakpoint = "md",
  mobileBackProps,
  backButtonVisibility = "responsive",
  titleClickProps,
  containerProps,
  actions,
  actionsClassName,
  leading,
}: AppPanelHeaderProps) {
  // The head of a row region's panel (the profile beside the conversation, #189; RowRegionChrome): the grip that moves
  // it (rule 7), and where its column holds the columns the row couldn't give 160, their tabs in place of its icon and
  // title (rule 4). Every other head is as it is.
  const chrome = useContext(PanelHeadChromeContext);
  const drag = chrome;
  const rowTabs = chrome?.tabs ?? null;
  // HOST-SHELL EMBED: the native WebView already draws a title bar, so web must not
  // draw a second one. But the ACTIONS must not die with the title — Computers' "+"
  // and Connected Apps' "Register App" live in this slot, and dropping the whole
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
        className={`flex items-center justify-end gap-2 px-(--surface-inset) pt-3 ${containerProps?.className ?? ""}`}
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
    ? ""
    : mobileBreakpoint === "lg"
    ? "hidden lg:flex"
    : "hidden md:flex";
  const { className: containerExtraClass, ...containerRest } = containerProps ?? NO_CONTAINER_PROPS;
  return (
    <PanelHeader
      {...containerRest}
      data-side-head={drag?.props["data-side-head"] ?? containerRest["data-side-head"]}
      // Last in its column with its head alone (stackEnd): no seam along the column's bottom.
      data-stack-end={drag?.props["data-stack-end"] ?? containerRest["data-stack-end"]}
      ref={containerProps?.ref}
      // Padding, gap and the edge buttons' placement belong to the raft-ui
      // recipe, so every column head starts and ends on the same edges.
      className={[containerExtraClass, drag?.props.className].filter(Boolean).join(" ") || undefined}
    >
      {/* Back first, at the top left (DS Navigation), before a leading control. The two never show together: the
          thread's fold chevron renders only where it is stacked in the row, which hides its Back (index.css); covering
          the conversation, or on a phone, it stands in no column and has no chevron. */}
      {onMobileBack && (
        <PanelAction
          {...mobileBackProps}
          onClick={onMobileBack}
          // raft-ui's head puts this Back's icon box on the content margin
          // at every width, mirroring the last action (DS › Alignment).
          className={`${mobileHiddenClass} ${mobileBackProps?.className ?? ""}`}
        >
          <ArrowLeft size={22} />
        </PanelAction>
      )}
      {leading}
      {icon && !rowTabs && (
        <PanelHeaderIcon className={`${iconVisibilityClass} ${ICON_TONE_CLASS[iconTone]}`}>
          {icon}
        </PanelHeaderIcon>
      )}
      {iconSlot && !rowTabs && (
        <PanelHeaderIcon className={iconVisibilityClass} data-icon-kind={iconKind}>
          {iconSlot}
        </PanelHeaderIcon>
      )}
      {rowTabs ? (
        <PanelHeaderContent>{rowTabs}{drag?.grip}</PanelHeaderContent>
      ) : titleSlot ? (
        <PanelHeaderContent>{titleSlot}{drag?.grip}</PanelHeaderContent>
      ) : (
        <PanelHeaderContent {...titleClickProps}>
          <PanelHeading>
            <PanelTitle
              render={(
                <h2>
                  {title}
                </h2>
              )}
            />
            {/* PanelStatus, not PanelMeta: the meta line truncates
                (overflow hidden), which would cut a badge's edge ring. */}
            {titleSuffix && <PanelStatus>{titleSuffix}</PanelStatus>}
          </PanelHeading>
          {subtitle && (
            <PanelMeta
              render={<p />}
              className={`${
                subtitleMultiline ? "" : "truncate"
              }${subtitleClassName ? ` ${subtitleClassName}` : ""}`}
            >
              {subtitle}
            </PanelMeta>
          )}
          {/* The grip, absolute along the head's top edge (a row region's, #189 rule 7). */}
          {drag?.grip}
        </PanelHeaderContent>
      )}
      {actions && (
        <PanelActions className={actionsClassName}>{actions}</PanelActions>
      )}
    </PanelHeader>
  );
}
