// The assistant opened from the otter (prototype v13, v10's panel): its head
// and the owner's DM with it. A module of its own, loaded on the first open:
// it brings ChatPanel, which itself draws the otter's anchor. Each open
// attaches the conversation the otter lay on (AssistantContextChip) until the
// owner removes it or sends a message with it.

import { useCallback, useState } from "react";
import { useIntl } from "react-intl";
import { PanelAction } from "@botiverse/raft-ui";
import { ChevronDown, Maximize2 } from "lucide-react";
import PanelHeader from "../components/ui/PanelHeader";
import Tooltip from "../components/ui/Tooltip";
import type { AssistantOwnerSettings, AssistantRecord } from "./assistantClient";
import { AssistantDm, AssistantSubtitle } from "./AssistantConversation";
import { useAssistantContextRef } from "./AssistantContextChip";
import type { AssistantOrigin } from "./AssistantContextChip";
import { AssistantPausedChip } from "./AssistantPaused";
import type { OtterMood } from "./assistantOtterState";
import curiousUrl from "./otter/curious.webp";

const HEADER_CONTAINER_PROPS = { "data-testid": "assistant-otter-panel-header" } as const;
const TOOLTIP_CONTENT_PROPS = { side: "bottom" as const };

/** The meta line: what it is doing, else what it can read. */
function metaId(mood: OtterMood, readsDms: boolean) {
  if (mood === "working") return "assistant.otter.meta.working" as const;
  if (mood === "confirm") return "assistant.otter.meta.confirm" as const;
  return readsDms ? "assistant.header.metaWithDms" as const : "assistant.header.meta" as const;
}

export default function AssistantOtterPanel({
  assistant,
  dmChannelId,
  settings,
  mood,
  paused,
  onCollapse,
  onExpand,
  origin,
}: {
  assistant: AssistantRecord;
  dmChannelId: string;
  settings: AssistantOwnerSettings;
  mood: OtterMood;
  paused: boolean;
  onCollapse: () => void;
  /** Opens the assistant page in its place (Raft DS › Panel: an expand-type action, before Collapse). */
  onExpand: () => void;
  /** The conversation whose composer it was opened from. */
  origin: AssistantOrigin;
}) {
  const { formatMessage } = useIntl();
  const collapse = formatMessage({ id: "assistant.otter.collapse" });
  const expand = formatMessage({ id: "assistant.otter.expand" });
  // The panel mounts on each open, so each open attaches it afresh.
  const [attached, setAttached] = useState(true);
  const detach = useCallback(() => setAttached(false), []);
  const context = useAssistantContextRef(origin, settings.readsDms === true);
  const meta = formatMessage({ id: metaId(mood, settings.readsDms === true) });
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-layer-canvas" data-testid="assistant-otter-panel">
      <PanelHeader
        iconSlot={(
          // The otter's head as the assistant's face: the image is cut at
          // its chest, so it sits on the box's bottom edge.
          <span aria-hidden="true" className="flex size-8 items-end justify-center overflow-hidden">
            <img src={curiousUrl} alt="" width={38} height={26} className="block max-w-none" draggable={false} />
          </span>
        )}
        iconKind="avatar"
        iconAlwaysVisible
        title={assistant.name}
        titleSuffix={paused ? <AssistantPausedChip className="shrink-0" /> : undefined}
        subtitle={<AssistantSubtitle key={meta} text={meta} />}
        containerProps={HEADER_CONTAINER_PROPS}
        actions={(
          <>
            {/* On a phone the sheet covers 82% of the screen, not all of it:
                the page is still more, so Expand stays there too. */}
            <Tooltip content={expand} contentProps={TOOLTIP_CONTENT_PROPS}>
              <PanelAction aria-label={expand} onClick={onExpand} data-testid="assistant-otter-expand">
                <Maximize2 />
              </PanelAction>
            </Tooltip>
            {/* Down, on a desktop too: it goes back into the otter below it. */}
            <PanelAction aria-label={collapse} onClick={onCollapse} data-testid="assistant-otter-collapse">
              <ChevronDown />
            </PanelAction>
          </>
        )}
      />
      <AssistantDm dmChannelId={dmChannelId} name={assistant.name} context={attached ? context : null} onDetachContext={detach} inPopover />
    </div>
  );
}
