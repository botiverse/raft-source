import { useContext, useLayoutEffect, useRef, useState } from "react";
import { useIntl } from "react-intl";
import { RefreshCw } from "lucide-react";
import { TopBarUpdateButton } from "./TopBarUpdateButton";
import { TopBarTrailingRoomContext } from "./topBarHostContext";
import { holdTopBarUpdateSlot, reloadOntoPublishedRelease, useWebVersionPromptStore } from "../../utils/webVersionCheck";
import { updateButtonForm } from "./updateButtonForm";
import type { UpdateButtonForm } from "./updateButtonForm";

/**
 * A newer Web release is published and this tab has not reloaded itself
 * yet, at a safe moment (utils/webVersionCheck): at desktop width the
 * prompt is the top bar's Update button, the desktop app's own
 * (TopBarUpdateButton), not a banner over the bar. A click reloads; there is
 * no Dismiss, it goes with the reload. While the bar is mounted it holds the
 * prompt's place, so the banner (NewWebVersionBanner) shows only on a phone or
 * on a page without the bar. Hidden, like the banner, while the stale-build
 * strip shows: its Refresh already loads the new release.
 *
 * The search field never shrinks below its 360px base. Where the right region
 * has no room for the label (768px holds the Bell, who is working and the
 * moon, not "Update" too; the installed app's window controls and longer
 * translations take more), the button is a square refresh icon with the same
 * name, as the desktop app shortens its own label on a narrow bar; where even
 * that would run into the field, the banner is the prompt (updateButtonForm).
 *
 * `slotOnly`: the frame of a server still being resolved (inert, it asks for
 * nothing) holds the prompt's place without the button, so the banner does not
 * flash on the way to the live bar.
 */
export function WebUpdateButton({ onReload = reloadOntoPublishedRelease, slotOnly = false }: { onReload?: () => void; slotOnly?: boolean }) {
  const { formatMessage } = useIntl();
  const release = useWebVersionPromptStore((state) => state.release);
  const chunkStripShown = useWebVersionPromptStore((state) => state.chunkStripShown);
  const room = useContext(TopBarTrailingRoomContext);
  const label = formatMessage({ id: "app.update.updateButtonAria" });
  const text = formatMessage({ id: "app.update.updateButton" });
  // The form found for this label; another language starts labelled again.
  const [fit, setFit] = useState<{ text: string; form: UpdateButtonForm } | null>(null);
  const form: UpdateButtonForm = fit?.text === text ? fit.form : "label";
  const box = useRef<HTMLSpanElement>(null);
  const labelledPx = useRef<number | null>(null);
  const iconPx = useRef<number | null>(null);
  const prompting = Boolean(release) && !chunkStripShown && !slotOnly;
  // Holds the prompt's place while the bar can show it. Layout effect: the
  // banner steps aside before the first paint with the bar.
  const holdsSlot = slotOnly || form !== "banner";
  useLayoutEffect(() => (holdsSlot ? holdTopBarUpdateSlot() : undefined), [holdsSlot]);
  // Decide on each new measure of the room only: right after a switch the room
  // is still the one measured before it, and deciding on it again would step
  // twice for one measure. The bar measures again once the button changes.
  const formNow = useRef(form);
  formNow.current = form;
  useLayoutEffect(() => {
    if (!prompting) return;
    const current = formNow.current;
    const width = box.current?.getBoundingClientRect().width ?? 0;
    if (current === "label") labelledPx.current = width;
    if (current === "icon") iconPx.current = width;
    const next = updateButtonForm(current, room, width, labelledPx.current, iconPx.current);
    if (next !== current) setFit({ text, form: next });
  }, [prompting, room, text]);

  if (slotOnly) return null;
  const shown = prompting && form !== "banner";
  return (
    <>
      {/* The bar's button appears without a word; this says it, once, politely. */}
      <span role="status" className="sr-only" data-testid="web-update-announcement">
        {shown ? formatMessage({ id: "app.update.newVersionAvailable" }) : ""}
      </span>
      {shown ? (
        <TopBarUpdateButton
          ref={box}
          iconOnly={form === "icon"}
          label={label}
          // Icon only: the tooltip is the word it stands for. Labelled: what is
          // ready, as the desktop app's tooltip says what its update is.
          tooltip={form === "icon" ? text : formatMessage({ id: "app.update.newVersionAvailable" })}
          onClick={onReload}
          testId="web-update-button"
          dotTestId="web-update-attention-dot"
        >
          {form === "label" ? text : <RefreshCw aria-hidden />}
        </TopBarUpdateButton>
      ) : null}
    </>
  );
}
