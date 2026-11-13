import { useCallback, useContext, useMemo, useRef } from "react";
import type { ReactNode, RefObject } from "react";
import { useIntl } from "react-intl";
import { ArrowLeft, ChevronDown, ChevronRight, X } from "lucide-react";
import { PanelAction, PanelActions, PanelHeader, PanelHeaderContent, PanelHeading, PanelMeta, PanelStatus, PanelTitle } from "@botiverse/raft-ui";

import type { MessageId } from "../../i18n/messages";
import Tooltip from "../ui/Tooltip";
import { useDomMeasureEffect } from "../../hooks/effectPrimitives";
import { useFocusRestore } from "../../hooks/useFocusRestore";
import { SideCardContext } from "./sideCardsLayout";
import type { SideCardState } from "./sideCardsLayout";
import { useSideSectionHead } from "./sideSectionDrag";
import { useStackEndHead } from "./stackEnd";
import { useColumnMoveItems } from "./columnMoves";
import { SidePanelEscapeProvider, useSidePanelEscape } from "./sidePanelEscape";
import { ColumnOverflowMenu } from "../layout/ColumnOverflowMenu";
import type { ColumnMenuItem } from "../layout/ColumnOverflowMenu";
import { HEAD_ACTION_WIDTH, shownOwnActions, useHeadWidth } from "../layout/headFit";
import { RowExpandAction } from "../layout/RowExpandAction";
import { RowTabs } from "../layout/RowTabs";
import { stackFolds, useRowExpand, useRowPlanStore, useRowTabs } from "../layout/rowPlanStore";

const STANDALONE: Omit<SideCardState, "card"> = { mode: "beside", collapsible: false, collapsed: false, onCollapsedChange: () => {} };
const NO_ACTIONS: readonly ColumnMenuItem[] = [];

/**
 * The shell of a section beside the message list: Tasks or Files.
 *
 * The sections sit in the layout and take their width from the message list
 * (the list moves left, nothing is covered), flat and edge to edge like the
 * thread column: no radius, no gaps, a 1px seam between regions (task #165).
 * Each has the column head every panel has (PanelHeader: 56px, a seam under
 * it, the 20px margin), so its title and buttons line up with the thread's
 * and the channel's. Its size comes from its column (ChannelSideArea); on a phone Back
 * closes it.
 *
 * The column tells the section where it sits (SideCardContext): covering the
 * conversation on a phone it is a flat page with Back; floating over the
 * messages it is part of the column's one elevated surface; stacked with the
 * other section it can fold to its header: the same 56px header, the body
 * hidden, so a folded section's title and buttons sit exactly where they do
 * unfolded.
 *
 * Standing in the row, its head is also the handle that moves the section
 * among the side columns (sideSectionDrag): its grip along its top edge.
 *
 * Its head is the one head rule (#189 rule 6): the title, then its own
 * actions (`ownActions`) as buttons, ⋯ with what didn't fit, then Expand and
 * Close side by side; the actions fold into ⋯, the last first, where the head
 * runs out of room, and ⋯ shows only with something in it.
 */
export default function ChannelSideCard({
  title,
  lead,
  meta,
  titleStatus,
  ownActions = NO_ACTIONS,
  menuItems = NO_ACTIONS,
  closeLabelId,
  onClose,
  closeOnEscape = false,
  returnFocus,
  expandable = true,
  testId,
  children,
}: {
  title: string;
  /** Before the title, after Back: whose it is (an agent's avatar on its context view). */
  lead?: ReactNode;
  /** A line under the title (PanelMeta): who and when. */
  meta?: ReactNode;
  /** A tag on the title (PanelStatus, DS Panel), such as the context view's Verified. */
  titleStatus?: ReactNode;
  /** Its own actions, shown as buttons where they fit, else in ⋯. */
  ownActions?: readonly ColumnMenuItem[];
  /** Its ⋯'s other commands (its Move Left / Move Right are its own, rule 7). */
  menuItems?: readonly ColumnMenuItem[];
  closeLabelId: MessageId;
  /** Close, Back where it covers the conversation: false when it asked first instead (the unsaved-changes prompt). */
  onClose: () => boolean | void;
  /**
   * Escape closes it while focus is inside, after what is open in it (raft-design panel.md; sidePanelEscape), and
   * focus goes back to what opened it, else to `returnFocus`.
   */
  closeOnEscape?: boolean;
  returnFocus?: () => HTMLElement | null;
  /**
   * Whether its head has Expand (#189 rule 5). The channel details have none: a description and settings rows gain
   * nothing from the row's whole width (raft-design panel.md, stdrc 2026-11-10, #proj-raft-ui:dae8db07).
   */
  expandable?: boolean;
  testId: string;
  children: ReactNode;
}) {
  const { formatMessage } = useIntl();
  // Outside a column (a test rendering one section alone), it sits beside the messages and doesn't fold.
  const grid = useContext(SideCardContext) ?? STANDALONE;
  const toggleCollapsed = useCallback(() => {
    grid.onCollapsedChange(!(grid.collapsible && grid.collapsed));
  }, [grid]);
  const closeLabel = formatMessage({ id: closeLabelId });
  const covering = grid.mode === "overlay";
  const asideRef = useRef<HTMLElement | null>(null);
  useCoveringFocus(asideRef, covering && grid.shown !== false);
  const escapeSteps = useSidePanelEscape(asideRef, closeOnEscape, { onClose, returnFocus });
  const card = (grid as Partial<SideCardState>).card ?? null;
  // A region of its column expanded (#189 rule 5): that one fills the column, the others show their heads alone, and
  // neither folds by its chevron until the row is restored (its own fold kept for then).
  const stackFold = useRowPlanStore((s) => (card ? stackFolds(s.plan, card) : null));
  const foldable = grid.collapsible && stackFold === null;
  const collapsed = stackFold ?? (grid.collapsible && grid.collapsed);
  const collapseLabel = formatMessage({ id: collapsed ? "task.sideCard.expand" : "task.sideCard.collapse" }, { title });
  const head = useStackEndHead(card, useSideSectionHead(card, grid.mode === "beside"));
  // Its column holds the columns the row couldn't give 160 (#189 rule 4): their tabs in place of its title.
  const rowTabs = useRowTabs(card ?? "");
  // The head always fits (rule 6): its own actions fold into ⋯ where they don't.
  const [measure, headWidth] = useHeadWidth();
  const expand = useRowExpand(card ?? "");
  // Its keyboard way to move (#189 rule 7): Move Left / Move Right in ⋯, where it can move.
  const moves = useColumnMoveItems(grid.mode === "beside" ? card : null);
  const own = collapsed ? NO_ACTIONS : ownActions;
  const shownCount = shownOwnActions({
    width: headWidth,
    lead: (covering ? 1 : 0) + (foldable ? 1 : 0),
    own: own.map(() => HEAD_ACTION_WIDTH),
    controls: (expand.shown && expandable && !covering ? 1 : 0) + (covering ? 0 : 1),
    menuItems: menuItems.length + moves.length,
    tabs: !!rowTabs,
  });
  const menu = useMemo(() => [...own.slice(shownCount), ...menuItems, ...moves], [menuItems, moves, own, shownCount]);
  return (
    <aside
      ref={asideRef}
      data-testid={testId}
      data-collapsed={collapsed ? "true" : "false"}
      aria-label={title}
      // Where focus goes when the section covers the conversation (ChatPanel), as the Artifact viewer takes it.
      tabIndex={-1}
      data-side-card-focus=""
      className={`flex min-h-0 w-full flex-col bg-layer-canvas outline-none ${collapsed ? "shrink-0" : "h-full"}`}
    >
      {/* One 56px head, folded or not: the panel head every column has. Its
          recipe puts the first and last icon on the 20px margin. */}
      <PanelHeader data-testid={`${testId}-header`} {...head.props} ref={measure}>
        {/* On a phone the channel header's Back closes the covering section
            (ChatPanel), so the section draws none: one Back on screen. A
            narrow desktop panel has no header Back, so it keeps its own. */}
        {covering ? (
          <PanelAction className="max-md:hidden" aria-label={closeLabel} onClick={onClose} data-testid={`${testId}-back`}>
            <ArrowLeft />
          </PanelAction>
        ) : null}
        {foldable ? (
          <Tooltip content={collapseLabel}>
            <PanelAction
              aria-label={collapseLabel}
              aria-expanded={!collapsed}
              onClick={toggleCollapsed}
              data-testid={`${testId}-collapse`}
            >
              {collapsed ? <ChevronRight /> : <ChevronDown />}
            </PanelAction>
          </Tooltip>
        ) : null}
        {lead && !rowTabs ? lead : null}
        <PanelHeaderContent>
          {rowTabs ? <RowTabs region={card!} /> : (
            <>
              <PanelHeading>
                <PanelTitle render={<h2>{title}</h2>} />
                {titleStatus ? <PanelStatus>{titleStatus}</PanelStatus> : null}
              </PanelHeading>
              {meta ? <PanelMeta>{meta}</PanelMeta> : null}
            </>
          )}
          {/* Absolute along the head's top edge: not one of the head's first or last controls. */}
          {head.grip}
        </PanelHeaderContent>
        <PanelActions>
          {own.slice(0, shownCount).map((action) => (
            <Tooltip key={action.id} content={action.label}>
              <PanelAction aria-label={action.label} onClick={action.onSelect} data-testid={action.testId}>{action.icon}</PanelAction>
            </Tooltip>
          ))}
          <ColumnOverflowMenu items={menu} testId={`${testId}-overflow`} />
          {/* Its Expand (#189 rule 5), a window control against Close. */}
          {covering || !card || !expandable ? null : <RowExpandAction region={card} testId={`${testId}-expand`} />}
          {covering ? null : (
            <Tooltip content={closeLabel}>
              <PanelAction aria-label={closeLabel} onClick={onClose} data-testid={`${testId}-close`}>
                <X />
              </PanelAction>
            </Tooltip>
          )}
        </PanelActions>
      </PanelHeader>
      {/* Folded, the body stays mounted (scroll, folded lanes) and only hides. */}
      <div className={collapsed ? "hidden" : "flex min-h-0 flex-1 flex-col"}>
        <SidePanelEscapeProvider value={escapeSteps}>{children}</SidePanelEscapeProvider>
      </div>
    </aside>
  );
}

/**
 * Covering the conversation (a phone, a narrow panel), the card on top takes
 * focus, as the Artifact viewer does, so nothing stays focused in the
 * messages and composer gone inert under it; unless focus is already in the
 * column (its tabs). When it stops covering (Back, close), focus goes back to
 * what had it (the header's toggle, the composer) if it was lost on the way.
 * Measured before paint, while what had focus still has it.
 */
function useCoveringFocus(ref: RefObject<HTMLElement | null>, active: boolean) {
  const openerRef = useRef<HTMLElement | null>(null);
  const restoreFocus = useFocusRestore(openerRef);
  useDomMeasureEffect(() => {
    const card = ref.current;
    if (!active || !card) return;
    const focused = document.activeElement;
    openerRef.current = focused instanceof HTMLElement && focused !== document.body ? focused : null;
    let cancelled = false;
    let frame = 0;
    const take = () => {
      if (cancelled || !card.isConnected) return false;
      if (!(focused && card.closest("[data-testid='channel-side-column']")?.contains(focused))) card.focus();
      return true;
    };
    // The side area attaches a section's element to its column in its own
    // layout effect, which may run after this one: then once it is there.
    if (!take()) queueMicrotask(() => { if (!take() && !cancelled) frame = requestAnimationFrame(take); });
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      // Once the card is gone, and what it covered no longer inert.
      restoreFocus();
    };
  }, [active, ref, restoreFocus]);
}
