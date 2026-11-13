import { useCallback, useId, useMemo } from "react";
import type { MouseEvent } from "react";
import { PanelRight } from "lucide-react";
import { useIntl } from "react-intl";
import { Button, MessageEmbed, MessageEmbedFooter, Tooltip, TooltipContent, TooltipTrigger, messageCard } from "@botiverse/raft-ui";
import { cn } from "@botiverse/raft-ui/cn";
import type { MessageCard } from "@botiverse/raft-shared";
import { openArtifactOnPlainClick, useArtifactLinkTargets } from "../../apps/artifacts";
import LeavingRaftMark, { opensInNewTabAriaLabel } from "../ui/LeavingRaftMark";
import { appLinkDomain, appLinkOpenHref } from "../../utils/appLinkAddress";
import { CardRelativeTime, KEEP_END, KeptEnd } from "./CardElements";
import { MessageCardElements, MessageCardHeaderView } from "./MessageCardElements";
import { messageCardDrawsSomething } from "./messageCardTree";
import { messageCardShowsUpdated } from "./messageCardRead";
import { useDesktopWebPreviewView, useWebPreviewEnabled } from "../../features/webPreview/useWebPreview";
import { openWebPreviewBeside, webPreviewTarget } from "../../features/webPreview/webPreviewStore";
import { useRaftPermalinkHostnames } from "../../store/raftAppHosts";
import type { ReadMessageCard } from "./messageCardRead";

/**
 * A card message's card in the message body (RFC 082 §5), under the sender's
 * name as any message's words are: who posted it is the message's own header,
 * from Raft's records, never anything on the card.
 *
 * The elements are drawn by MessageCardElements.tsx, on the leaves link cards
 * share (CardElements.tsx). They sit in the frame every card in a message
 * shares (raft-ui MessageEmbed, an item card's width) and take its parts from
 * messageCard (DS Cards in messages): no MessageActionCard chrome, icon or
 * status, so it never reads as one of Raft's own cards. The sender's optional
 * header (v2.0, §4.8) is the card's body: messageCard's title, a muted
 * subtitle, tags in their status tone, and no colour of its own. Badges in the body are neutral (DS PreviewCard rules,
 * raft-design #939). Buttons only leave Raft: a link with its label, its
 * domain and ↗, in a new tab without opener or referrer. Every string is
 * React text, never HTML; a Markdown element is drawn by the message
 * renderer restricted to its subset. The buttons are messageCard's row, at
 * the card's bottom end. Once replaced (revision > 1) the footer says when
 * ("Updated 3 minutes ago").
 */
export function MessageCardBody({ read }: { read: ReadMessageCard }) {
  const { formatMessage } = useIntl();
  const buttons = messageCardButtons(read.card);
  const elements = messageCardDrawsSomething(read.card, read.card.root, 0);
  const { inset, actionRow } = messageCard();
  return (
    <MessageEmbed size="item" className="my-1" data-message-card="" data-message-card-revision={read.revision}>
      {read.card.header ? <MessageCardHeaderView header={read.card.header} /> : null}
      {elements || buttons.length || !read.card.header ? (
        // Under the header the body goes on at the card's inset: 12px from the header's last line, not 24.
        <div className={inset({ className: cn("flex min-w-0 flex-col gap-3", read.card.header && "pt-0") })} data-message-card-content="">
          {elements ? <MessageCardElements card={read.card} /> : null}
          {buttons.length ? (
            <div className={actionRow({ className: "min-w-0" })} data-message-card-buttons="">
              {buttons.map(([id, button], index) => <MessageCardLink key={id} button={button} showDomain={!repeatsLater(buttons, index)} />)}
            </div>
          ) : null}
        </div>
      ) : null}
      {messageCardShowsUpdated(read) ? (
        <MessageEmbedFooter className="border-t border-line-hairline font-sans text-caption text-foreground-hint" data-message-card-updated="">
          <span>{formatMessage({ id: "message.messageCard.updated" }, { time: <CardRelativeTime key="time" at={read.updatedAt} /> })}</span>
        </MessageEmbedFooter>
      ) : null}
    </MessageEmbed>
  );
}

type MessageCardButton = Extract<MessageCard["elements"][string], { type: "Button" }>["props"];

/** The card's buttons in tree order (within the schema's depth bound). */
function messageCardButtons(card: MessageCard): Array<[string, MessageCardButton]> {
  const buttons: Array<[string, MessageCardButton]> = [];
  const visit = (id: string, depth: number) => {
    const node = Object.hasOwn(card.elements, id) ? card.elements[id] : undefined;
    if (!node || depth > 4) return;
    if (node.type === "Button") buttons.push([id, node.props]);
    else if (node.type === "Stack") for (const child of node.children ?? []) visit(child, depth + 1);
  };
  visit(card.root, 0);
  return buttons;
}

/** The address a navigate button opens, as the web opens it; null for one it draws no link for (disabled, or a URL it can't open). */
function buttonTarget(button: MessageCardButton): string | null {
  return button.disabledReason ? null : appLinkOpenHref(button.action.url);
}

/**
 * Whether a later button of the card opens the same address (Jasper): the
 * address's domain is shown once, on the last of the buttons that open it,
 * so "New tab" and "Open preview" on one page don't both repeat the host.
 */
function repeatsLater(buttons: ReadonlyArray<[string, MessageCardButton]>, index: number): boolean {
  const target = buttonTarget(buttons[index]![1]);
  return target !== null && buttons.slice(index + 1).some(([, later]) => buttonTarget(later) === target);
}

/**
 * A card button: a link that leaves Raft, never an action. Its label, then
 * where it goes (the link's domain, as App links show it; only on the last
 * of the card's buttons that open the same address), then ↗. The
 * sender's reason for a disabled one is its tooltip and description; it opens
 * nothing. A URL Raft can't open is not drawn.
 *
 * `open: "beside"` (web_preview_v0): with the flag on, a plain click opens the
 * page in the web preview panel beside the conversation (the side area's
 * Artifact place), and the button ends in the panel icon instead of ↗. It
 * stays a link to the page, so a modified or middle click, and any page Raft
 * doesn't frame or a conversation with no side area, still open a new tab.
 * Flag off, it is today's new-tab button.
 *
 * In Raft Desktop with its web preview view (desktop_web_preview_view_v0 and
 * raftDesktop.webPreview) beside is the default: a button to a web page opens
 * beside unless it says `open: "tab"`, whatever web_preview_v0 says and
 * whatever the person chose for links in a message's text (Settings ›
 * Appearance › How web links open is about those, not about cards).
 *
 * A button whose address is an Artifact is an Artifact opener like any other
 * (#proj-workspace:#104, #282): a plain click opens the Artifact in place, in
 * the layout it was clicked in, whatever `open` says and whatever the web
 * preview's flag says (the web preview never frames Raft's own pages, so such
 * a button used to fall through to a new tab, a new window in the desktop
 * app). It ends in the panel icon. Where no place can hold the viewer, and on
 * a modified or middle click, the link is followed as before.
 */
function MessageCardLink({ button, showDomain }: { button: MessageCardButton; showDomain: boolean }) {
  const { formatMessage } = useIntl();
  const reasonId = useId();
  const variant = button.variant === "ghost" ? "ghost" : "default";
  const href = appLinkOpenHref(button.action.url);
  const domain = appLinkDomain(button.action.url);
  const besideEnabled = useWebPreviewEnabled();
  const raftHostnames = useRaftPermalinkHostnames();
  // Raft Desktop's native view (desktop_web_preview_view_v0) shows http pages too.
  const nativeView = useDesktopWebPreviewView() !== null;
  const url = button.action.url;
  const urls = useMemo(() => [url], [url]);
  const artifact = useArtifactLinkTargets(urls).get(url) ?? null;
  const besideByDefault = nativeView && button.open !== "tab" && webPreviewTarget(url, raftHostnames) !== null;
  const beside = artifact !== null || besideByDefault || (besideEnabled && button.open === "beside");
  const openBeside = useCallback((event: MouseEvent<HTMLAnchorElement>) => {
    if (artifact) {
      openArtifactOnPlainClick(event, artifact, "link");
      return;
    }
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    // Opened beside: the link's own new tab doesn't open too. Else the link opens its tab.
    if (openWebPreviewBeside(url, event.currentTarget, event.currentTarget, raftHostnames, nativeView)) event.preventDefault();
  }, [artifact, nativeView, raftHostnames, url]);
  if (button.disabledReason) {
    return (
      <>
        <Tooltip>
          <TooltipTrigger
            render={(
              <Button size="sm" variant={variant} disabled focusableWhenDisabled aria-describedby={reasonId} className="min-w-0" data-message-card-button="disabled">
                <span className="truncate">{button.label}</span>
              </Button>
            )}
          />
          <TooltipContent>{button.disabledReason}</TooltipContent>
        </Tooltip>
        <span id={reasonId} className="sr-only">{button.disabledReason}</span>
      </>
    );
  }
  if (!href || !domain) return null;
  return (
    <Button
      size="sm"
      variant={variant}
      nativeButton={false}
      role="link"
      render={beside
        ? <a href={href} target="_blank" rel="noopener noreferrer" onClick={openBeside} aria-label={formatMessage({ id: "webPreview.cardButtonLabel" }, { name: `${button.label} · ${domain}` })} />
        : <a href={href} target="_blank" rel="noopener noreferrer" aria-label={opensInNewTabAriaLabel(formatMessage, `${button.label} · ${domain}`)} />}
      className="min-w-0 max-w-full"
      data-message-card-button={artifact ? "artifact" : beside ? "beside" : "navigate"}
    >
      <span className="truncate" data-message-card-button-label="">{button.label}</span>
      {/* Too long, the domain keeps its end (`…review.example.com`): that part says where the link goes.
          Shown once per address: on the last button that opens it. The accessible name keeps it on every one. */}
      {showDomain ? <span className={`min-w-0 text-foreground-muted ${KEEP_END}`} data-message-card-button-domain=""><KeptEnd text={domain} /></span> : null}
      {beside ? <PanelRight aria-hidden data-icon="inline-end" /> : <LeavingRaftMark data-icon="inline-end" />}
    </Button>
  );
}
