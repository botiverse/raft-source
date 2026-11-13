// Back / Forward / History for the top bar (task #127, Slack's ‹ › 🕘). The
// bar renders them at the end of its left region, right next to the search
// field, when its host asks for them (TopBarHost.historyControls: a shell with
// no browser buttons of its own). Back/Forward step the in-app history
// (react-router over window.history, position from the Navigation API);
// History lists recently visited conversations. Disabled = nothing to step to,
// exactly like a browser. The host's history commands (⌘[ / ⌘], trackpad
// swipe, mouse side buttons) take the same step (historyNavigation.ts).
//
// Raft Design System › top bar / IconButton: they sit on the frame, so they are
// frame items like the web bar's own workspace button: raft-ui Button
// `on-frame` at `icon-md` — 36px, a 20px glyph, on-frame ink, the frame's
// pressed wash for hover and press, no box. Disabled only greys the glyph
// (ink-disabled) and ignores hover and press.

import { useCallback } from "react";
import { useIntl } from "react-intl";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { Button, TooltipProvider } from "@botiverse/raft-ui";
import AppTooltip from "../ui/Tooltip";
import { HistoryMenu } from "./HistoryMenu";
import { useHistoryPosition, useHistoryStep } from "./historyNavigation";

const IS_MAC = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);
// Mirrors the desktop app's native History menu accelerators.
const HISTORY_KEYS = IS_MAC ? { back: "⌘[", forward: "⌘]" } : { back: "Alt+←", forward: "Alt+→" };

export function HistoryControls() {
  const { formatMessage } = useIntl();
  const history = useHistoryPosition();
  const stepHistory = useHistoryStep();
  const goBack = useCallback(() => { stepHistory("back"); }, [stepHistory]);
  const goForward = useCallback(() => { stepHistory("forward"); }, [stepHistory]);
  const back = formatMessage({ id: "desktop.history.back", defaultMessage: "Go back" });
  const forward = formatMessage({ id: "desktop.history.forward", defaultMessage: "Go forward" });
  return (
    <TooltipProvider>
      <AppTooltip content={`${back} ${HISTORY_KEYS.back}`}>
        <Button
          variant="on-frame"
          size="icon-md"
          aria-label={back}
          disabled={!history.canGoBack}
          onClick={goBack}
          data-testid="desktop-history-back"
        >
          <ArrowLeft aria-hidden />
        </Button>
      </AppTooltip>
      <AppTooltip content={`${forward} ${HISTORY_KEYS.forward}`}>
        <Button
          variant="on-frame"
          size="icon-md"
          aria-label={forward}
          disabled={!history.canGoForward}
          onClick={goForward}
          data-testid="desktop-history-forward"
        >
          <ArrowRight aria-hidden />
        </Button>
      </AppTooltip>
      <HistoryMenu />
    </TooltipProvider>
  );
}
