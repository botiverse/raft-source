import { useCallback, useMemo, useState } from "react";
import { useIntl } from "react-intl";
import {
  Select,
  SelectActionItem,
  SelectContent,
  SelectIcon,
  SelectItem,
  SelectItemIndicator,
  SelectItemText,
  SelectList,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@botiverse/raft-ui";
import { useServerStore } from "../../store/serverStore";
import {
  sidebarCreateSectionUpdate,
  sidebarItemSectionKey,
  sidebarMoveToCustomSectionUpdate,
  sidebarMoveToHomeUpdate,
  sidebarMoveToPinnedUpdate,
  sidebarSectionItemKey,
} from "../../store/sidebarSections";
import type { SidebarCustomSection, SidebarSectionPlacement } from "../../store/sidebarSections";
import { hasSidebarPinnedRef, removeSidebarPinnedRef } from "../../utils/sidebarPinnedRefs";
import type { SidebarPinnedRef } from "../../utils/sidebarPinnedRefs";
import SidebarSectionDialog from "../layout/SidebarSectionDialog";
import type { ConversationSidebarSection } from "./useConversationSidebarSection";

const NO_PINNED_REFS: SidebarPinnedRef[] = [];
const NO_SECTIONS: SidebarCustomSection[] = [];
const NO_PLACEMENTS: SidebarSectionPlacement[] = [];
const NO_SECTION_ORDER: string[] = [];

/** The Select's values: the conversation's home section, Pinned, or a custom one. */
const DEFAULT_VALUE = "default";
const PINNED_VALUE = "pinned";
const CUSTOM_PREFIX = "custom:";

interface SectionOption {
  value: string;
  label: string;
  emoji?: string | null;
}

/**
 * "Move to section" in channel and DM settings: where this conversation sits
 * in MY sidebar. The same placement model as the sidebar row menu's Move to
 * Section ▸ (the shared moves in store/sidebarSections): Pinned is the
 * system section `system:pinned` (a pinned ref), a custom section is a
 * placement, a move into one leaves the other, and the default is the
 * conversation's home section. `section` is the sidebar's model of the
 * conversation (useConversationSidebarSection): its placement item, pinned
 * ref (a DM is pinned by its peer) and home section (Channels, Joint
 * Channels / External, or Direct Messages). "Create section" opens the
 * sidebar's section dialog and creates the section with this conversation
 * already in it.
 */
export function ChannelSectionSelect({
  section: { item, pinnedRef, stalePinnedRefs, homeKey, homeLabelId },
  "aria-labelledby": ariaLabelledBy,
  testId = "channel-settings-section-select",
}: {
  section: ConversationSidebarSection;
  "aria-labelledby"?: string;
  testId?: string;
}) {
  const { formatMessage } = useIntl();
  const sidebarOrder = useServerStore((s) => s.sidebarOrder);
  const updateSidebarOrder = useServerStore((s) => s.updateSidebarOrder);
  const [creating, setCreating] = useState(false);

  // Legacy fixtures and older payloads may omit any of these arrays.
  const pinnedRefs = sidebarOrder.pinned ?? NO_PINNED_REFS;
  const customSections = sidebarOrder.customSections ?? NO_SECTIONS;
  const sectionPlacements = sidebarOrder.sectionPlacements ?? NO_PLACEMENTS;
  const sectionOrder = sidebarOrder.sectionOrder ?? NO_SECTION_ORDER;

  // Every move starts from the pins without the stale ones.
  const basePinned = useMemo(
    () => stalePinnedRefs.reduce((refs, ref) => (hasSidebarPinnedRef(refs, ref) ? removeSidebarPinnedRef(refs, ref) : refs), pinnedRefs),
    [pinnedRefs, stalePinnedRefs],
  );
  const itemKey = sidebarSectionItemKey(item.kind, item.id);
  const placement = sectionPlacements.find((p) => sidebarSectionItemKey(p.kind, p.id) === itemKey) ?? null;
  // Where the sidebar shows the conversation (Pinned wins over a placement; a
  // placement in a deleted section is home). A new section goes before it.
  const currentSectionKey = sidebarItemSectionKey({
    pinned: !!pinnedRef && hasSidebarPinnedRef(pinnedRefs, pinnedRef),
    placementSectionId: placement?.sectionId ?? null,
    customSections,
    homeKey,
  });
  const value = currentSectionKey === "system:pinned"
    ? PINNED_VALUE
    : currentSectionKey === homeKey ? DEFAULT_VALUE : `${CUSTOM_PREFIX}${currentSectionKey}`;

  const canPin = !!pinnedRef;
  const options = useMemo<SectionOption[]>(() => [
    { value: DEFAULT_VALUE, label: formatMessage({ id: homeLabelId }) },
    ...(canPin ? [{ value: PINNED_VALUE, label: formatMessage({ id: "layout.sidebar.pinned" }) }] : []),
    ...customSections.map((section) => ({
      value: `${CUSTOM_PREFIX}${section.id}`,
      label: section.name,
      emoji: section.emoji,
    })),
  ], [canPin, customSections, homeLabelId, formatMessage]);

  const handleChange = useCallback((next: unknown) => {
    if (typeof next !== "string") return;
    // The same moves as the sidebar's Move to Section ▸; fire-and-forget,
    // the store rolls back on failure.
    const state = { pinned: basePinned, sectionPlacements };
    if (next === DEFAULT_VALUE) {
      // No value guard: an orphaned placement (its section deleted) shows as
      // home, and picking home is how it is cleared. Already home: no write.
      const update = sidebarMoveToHomeUpdate(state, item, pinnedRef);
      const withStale = update.pinned || basePinned === pinnedRefs ? update : { ...update, pinned: basePinned };
      if (Object.keys(withStale).length > 0) void updateSidebarOrder(withStale);
      return;
    }
    if (next === value) {
      // Already there. A legacy channel-id pin can still hide it there (the
      // select shows its placement; the sidebar shows it nowhere): re-picking
      // drops that pin and leaves the placement where it is.
      if (basePinned !== pinnedRefs) void updateSidebarOrder({ pinned: basePinned });
      return;
    }
    if (next === PINNED_VALUE) {
      if (pinnedRef) void updateSidebarOrder(sidebarMoveToPinnedUpdate(state, item, pinnedRef));
    } else if (next.startsWith(CUSTOM_PREFIX)) {
      void updateSidebarOrder(sidebarMoveToCustomSectionUpdate(state, item, next.slice(CUSTOM_PREFIX.length), pinnedRef));
    }
  }, [basePinned, item, pinnedRef, pinnedRefs, sectionPlacements, updateSidebarOrder, value]);

  const openCreate = useCallback(() => setCreating(true), []);
  const closeCreate = useCallback(() => setCreating(false), []);
  const submitCreate = useCallback((input: { name: string; emoji: string | null }) => {
    const section: SidebarCustomSection = { id: crypto.randomUUID(), name: input.name, emoji: input.emoji, sortMode: "manual" };
    void updateSidebarOrder(sidebarCreateSectionUpdate(
      { customSections, sectionOrder, sectionPlacements, pinned: basePinned },
      section,
      { insertBefore: currentSectionKey, moveItem: item, moveItemRef: pinnedRef },
    ));
    setCreating(false);
  }, [basePinned, currentSectionKey, customSections, item, pinnedRef, sectionOrder, sectionPlacements, updateSidebarOrder]);

  return (
    <>
      <Select value={value} onValueChange={handleChange} items={options}>
        <SelectTrigger className="w-full max-w-sm" aria-labelledby={ariaLabelledBy} data-testid={testId}>
          <SelectValue />
          <SelectIcon />
        </SelectTrigger>
        <SelectContent>
          <SelectList>
            {options.map((option) => (
              <SelectItem key={option.value} value={option.value} data-testid={`${testId}-${option.value}`}>
                <SelectItemText>
                  {/* The emoji as the sidebar shows it (SidebarChatSections), apart from the name. */}
                  {option.emoji && <span aria-hidden className="mr-1">{option.emoji}</span>}
                  {option.label}
                </SelectItemText>
                <SelectItemIndicator />
              </SelectItem>
            ))}
            <SelectSeparator />
            <SelectActionItem closeOnAction onAction={openCreate} data-testid={`${testId}-create`}>
              {formatMessage({ id: "message.channelSettings.sectionCreate" })}
            </SelectActionItem>
          </SelectList>
        </SelectContent>
      </Select>
      {creating && (
        <SidebarSectionDialog
          title={formatMessage({ id: "layout.sidebar.newSectionTitle" })}
          submitLabel={formatMessage({ id: "layout.sidebar.createSection" })}
          layer={1}
          onSubmit={submitCreate}
          onClose={closeCreate}
        />
      )}
    </>
  );
}
