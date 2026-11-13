import { useCallback, useEffect, useId, useMemo, useRef } from "react";
import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import { useIntl } from "react-intl";
import { FileX, Link as LinkIcon } from "lucide-react";
import { defineCatalog } from "@json-render/core";
import { ActionProvider, defineRegistry, Renderer, StateProvider, VisibilityProvider } from "@json-render/react";
import { schema } from "@json-render/react/schema";
import {
  Badge,
  Button,
  MessageReferenceChip,
  MessageReferenceLabel,
  MessageReferencePending,
  MessageReferenceSuffix,
  MessageReferenceUnavailable,
  Popover,
  PopoverContent,
  PopoverTrigger,
  PreviewCard,
  PreviewCardContent,
  PreviewCardTitle,
  PreviewCardTrigger,
  Text,
  toast,
} from "@botiverse/raft-ui";
import {
  PopoverActions,
  PreviewCardActions,
  PreviewCardBody,
  PreviewCardFooter,
  useTruncated,
} from "@botiverse/raft-ui/wip";
import { previewBadgeProps, previewStackProps, previewTextProps } from "@botiverse/raft-shared/src/appLinkPreview";
import { ArtifactLinkPreview, artifactKindIcon, artifactUrl, openArtifactOnPlainClick, useArtifactsAppName } from "../../apps/artifacts";
import { appLinkDomain, appLinkOpenHref, appLinkShortAddress } from "../../utils/appLinkAddress";
import { useAuthStore } from "../../store/authStore";
import { linkPreviewAppKey, linkPreviewViewerKey, useLinkPreviewConsentStore } from "../../store/linkPreviewConsentStore";
import type { LinkPreviewAnswerStatus, LinkPreviewApp } from "../../store/linkPreviewConsentStore";
import { useServerStore } from "../../store/serverStore";
import Tooltip from "../ui/Tooltip";
import { KEEP_END, KeptEnd } from "./CardElements";
import { LinkCardActions, LinkCardConfirmDialog } from "./LinkCardActions";
import { AppLinkIcon } from "./AppLinkIcon";
import { LinkCardBoundary } from "./LinkCardBoundary";
import { LinkCardElements } from "./LinkCardElements";
import { LinkPreviewConsentPrompt } from "./LinkPreviewConsentPrompt";
import type { LinkPreviewPromptState } from "./LinkPreviewConsentPrompt";
import { appLinkChipTitle } from "./useAppLinkPreviews";
import type { AppLinkResult } from "./useAppLinkPreviews";
import { useMessageLinkCard } from "./useMessageLinkCards";
import type { ObjectLinkCard } from "./useMessageLinkCards";

// The v1 card's read-only catalog, painted with raft-ui inside the hover card.
// The App's state is a neutral soft Badge, in its own words (PreviewCard ›
// Item card rules). v1 has no buttons; v2's go in PreviewCardActions
// (LinkCardActions.tsx).
const emptyState = Object.freeze({});
const noActions = Object.freeze({});
const catalog = defineCatalog(schema, {
  components: {
    Stack: { props: previewStackProps, slots: ["default"] },
    Text: { props: previewTextProps },
    Badge: { props: previewBadgeProps },
  },
  actions: {},
});
const { registry } = defineRegistry(catalog, { actions: {}, components: {
  Stack: ({ children }) => <div className="flex min-w-0 flex-col gap-1.5">{children}</div>,
  Text: ({ props }) => <Text.Sans size="small" variant={props.tone === "muted" ? "muted" : "default"} className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{props.text}</Text.Sans>,
  Badge: ({ props }) => <Badge appearance="soft" className="max-w-full self-start whitespace-normal break-words">{props.text}</Badge>,
} });

/** The plain text of a Markdown link's rendered children (a hast element). */
export function markdownLinkText(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const value = (node as { value?: unknown }).value;
  if (typeof value === "string") return value;
  const children = (node as { children?: unknown }).children;
  return Array.isArray(children) ? children.map(markdownLinkText).join("") : "";
}

/**
 * Only a bare URL becomes a chip: an autolink, or a Markdown link whose text
 * is its own address. A link the author gave words to stays as written
 * (addendum 5 §1). Links in code never reach here.
 */
function isBareLink(href: string, text: string): boolean {
  try {
    return new URL(text.trim()).href === new URL(href).href;
  } catch {
    return false;
  }
}

/**
 * A message link: when the author wrote the bare URL, the chip its link card
 * asks for (useMessageLinkCards): an App's result, or a first-party object
 * answered `ok`, or a dimmed chip for one answered `deleted`; otherwise
 * `children` (the author's own link). A first-party link still loading,
 * unavailable or failed stays the author's link, as an App link the App
 * answered plain does, and as one whose version 3 answer lists no chip (a
 * block card alone: the card goes after the paragraph, AppLinkBlockCard.tsx).
 */
export function MessageAppLink({ href, text, children }: { href: string | undefined; text: string; children: ReactNode }) {
  // A chip that throws while drawing is the author's link again, never the conversation's end (#triage:#351).
  return <LinkCardBoundary fallback={children}><MessageAppLinkDrawn href={href} text={text}>{children}</MessageAppLinkDrawn></LinkCardBoundary>;
}

function MessageAppLinkDrawn({ href, text, children }: { href: string | undefined; text: string; children: ReactNode }) {
  const card = useMessageLinkCard(href);
  if (!href || !card) return <>{children}</>;
  if (!isBareLink(href, text)) {
    // An Artifact the author gave words to (#proj-workspace:#289): the words stay, and open it as its card does.
    return card.kind === "object" && card.state === "ok" ? <ObjectLabelledLink link={card}>{children}</ObjectLabelledLink> : <>{children}</>;
  }
  if (card.kind === "app" && card.data.kind === "card" && card.data.drawn?.chip === false) return <>{children}</>;
  if (card.kind === "app") return <AppLinkChip result={card.data} />;
  if (card.state === "deleted") return <DeletedObjectChip title={card.data.deleted.title} />;
  if (card.state !== "ok") return <>{children}</>;
  return <ObjectLinkChip link={card} />;
}

/**
 * A link to an Artifact the author gave words to (#proj-workspace:#289): the
 * author's link as written (their words, not the chip), and a plain click
 * opens the Artifact in place, as its card under the message does. A
 * modified or middle click is the link's own (a new tab).
 */
function ObjectLabelledLink({ link, children }: { link: Extract<ObjectLinkCard, { state: "ok" }>; children: ReactNode }) {
  const { target } = link.data;
  const onClickCapture = useCallback((event: MouseEvent<HTMLElement>) => openArtifactOnPlainClick(event, target), [target]);
  return <span className="contents" onClickCapture={onClickCapture} data-artifact-labelled-link="">{children}</span>;
}

/**
 * A deleted Artifact's link, to a viewer who could see it before (anyone
 * else gets the author's link): the gray chip of a reference that can't be
 * opened (`MessageReferenceUnavailable`), dimmed as deleted things are (DS
 * States › Dimmed), with its title and "deleted" after it. A `span`: not a
 * link, no hover card. Who deleted it and when are on the card under the
 * message. raft-ui's unavailable chip has no `capped`: the same 24em cap as
 * the other chips, by class, since the title is the author's words; its
 * words are `foreground-muted`, not the chip's `foreground-hint`, so they
 * still read at 60%.
 */
function DeletedObjectChip({ title }: { title: string }) {
  const { formatMessage } = useIntl();
  return (
    <MessageReferenceUnavailable className="max-w-[min(100%,24em)] text-foreground-muted opacity-dimmed" data-app-link-chip="deleted">
      <FileX aria-hidden />
      <MessageReferenceLabel>{title}</MessageReferenceLabel>
      <MessageReferenceSuffix className="text-foreground-muted">{formatMessage({ id: "artifacts.chip.deleted" })}</MessageReferenceSuffix>
    </MessageReferenceUnavailable>
  );
}

/** The element a chip or button renders as to open `href` in a new tab; `label` mirrors its visible words. */
function newTabLink(href: string, label: string) {
  return <a href={href} target="_blank" rel="noopener noreferrer" aria-label={label} />;
}

/** A first-party chip's link: a page of Raft's, followed in this tab unless `onClick` opens it in place. */
type InRaftLink = { href: string; onClick: (event: MouseEvent<HTMLAnchorElement>) => void };
function inRaftLink({ href, onClick }: InRaftLink, label: string) {
  return <a href={href} aria-label={label} onClick={onClick} />;
}

/**
 * An App link in the message's text (addendum 5 §2, DS MessageItem › App
 * links). Its text is always React text, never HTML, and the label truncates.
 * An App's chip opens only an http(s) address, in a new tab without opener or
 * referrer (a first-party chip opens like its card: ObjectLinkChip).
 */
export function AppLinkChip({ result }: { result: AppLinkResult }) {
  const { formatMessage } = useIntl();
  // This chip, as the owner of a confirm dialog it opens (a link written twice has two chips).
  const owner = useId();
  const href = appLinkOpenHref(result.url);
  const domain = appLinkDomain(result.url);
  if (!href || !domain) return null;
  if (result.kind === "consent") return <AppLinkConsentChip result={result} href={href} domain={domain} />;
  if (result.kind === "pending") return <AppLinkPendingChip href={href} />;
  const card = result.kind === "card";
  const words = card ? appLinkChipTitle(result) : appLinkShortAddress(result.url) ?? domain;
  const label = card ? formatMessage({ id: "message.appLink.chipLabel" }, { title: words, domain }) : words;
  const chip = (
    <>
      <AppLinkIcon app={result.app} frame="chip" />
      {card ? (
        // Where the link goes, on the chip itself where no hover card
        // can show it (addendum 5 §2a; raft-design #749): on any device
        // that can tap, a touch laptop too. The title truncates first;
        // the domain keeps its width, and if even that is too wide it
        // loses its start, never its end.
        <span className="flex min-w-0 items-baseline gap-1">
          <MessageReferenceLabel>{words}</MessageReferenceLabel>
          <MessageReferenceSuffix className={`hidden max-w-full any-pointer-coarse:block ${KEEP_END}`} data-app-link-chip-domain="">
            <KeptEnd text={domain} />
          </MessageReferenceSuffix>
        </span>
      ) : <MessageReferenceLabel>{words}</MessageReferenceLabel>}
    </>
  );
  // A version 3 answer opens a hover card only when it lists one: a chip
  // whose card is a block card, or that has no card, has none (DS Navigation ›
  // What an app's answer lists).
  if (card && result.drawn && result.drawn.card !== "hover") return <AppLinkInlineChip label={label} href={href}>{chip}</AppLinkInlineChip>;
  return (
    <AppLinkHoverCard
      label={label}
      chip={chip}
      href={href}
      kind={result.kind}
      confirmFor={card && result.cardV2 ? result : undefined}
      owner={owner}
    >
      {card ? <AppLinkCardBody result={result} owner={owner} /> : <AppLinkConnectBody result={result} />}
      <LinkCardFooter app={result.app.name} domain={domain} />
    </AppLinkHoverCard>
  );
}

/**
 * A chip with no hover card (a version 3 answer that lists `inline` and a
 * block card, or `inline` alone): the same chip, a link that opens the item in
 * a new tab on every device. Share screenshots turn it back into the author's
 * link, as any chip.
 */
function AppLinkInlineChip({ label, href, children }: { label: string; href: string; children: ReactNode }) {
  const chipRef = useRef<HTMLAnchorElement>(null);
  useEffect(() => takeFocusAfterAllow(href, chipRef.current), [href]);
  return (
    <MessageReferenceChip ref={chipRef} variant="info" capped render={newTabLink(href, label)} data-app-link-chip="inline" data-app-link-chip-url={href}>
      {children}
    </MessageReferenceChip>
  );
}

/**
 * The hover card's last line: whose link it is (the App's name, or the
 * first-party app's) and, for an App's link, its domain. One footer for every
 * link chip. A first-party link has no domain: the name alone. The name gives
 * way first; the domain is never cut, it wraps. A host too long for the line
 * goes under "App ·", so the name keeps its room.
 */
function LinkCardFooter({ app, domain }: { app: string; domain?: string }) {
  return (
    <PreviewCardFooter className="flex flex-wrap items-baseline gap-x-1 whitespace-normal">
      <span className="min-w-0 truncate" data-app-link-preview-app="">{app}</span>
      {domain ? (
        <>
          <span aria-hidden="true">·</span>
          <span className="max-w-full shrink-0 break-all" data-app-link-preview-host="">{domain}</span>
        </>
      ) : null}
    </PreviewCardFooter>
  );
}

/**
 * A first-party object's link in the message's text (an Artifact answered
 * `ok` by the message's one link-card read): the same chip and hover card as
 * an App link (AppLinkHoverCard; share screenshots turn it back into the
 * author's link), with the object's title on the chip and no domain (not on
 * the chip, not in the footer). The card under the message is drawn from the
 * same answer (ArtifactMessageRefs), and a click
 * does what a click on that card does (Kirby, #11331): a plain click opens
 * the Artifact in place, in the layout it was clicked in (openArtifactInPlace,
 * #proj-workspace:#104); the chip's address is `artifactUrl`, as the card's
 * is, for Cmd/Ctrl, Shift and middle clicks (a new tab or window).
 *
 * The chip's mark (the kind's icon) and the card's body (an item card from
 * raft-ui's PreviewCard parts: title, details row, description) are the
 * app's (`artifactKindIcon`, `ArtifactLinkPreview`; #proj-workspace:#34);
 * the chip, the hover card and its footer are this file's, as for an App.
 */
function ObjectLinkChip({ link }: { link: Extract<ObjectLinkCard, { state: "ok" }> }) {
  const owner = useId();
  const appName = useArtifactsAppName();
  const { target, summary } = link.data;
  const onClick = useCallback((event: MouseEvent<HTMLAnchorElement>) => openArtifactOnPlainClick(event, target), [target]);
  const open = useMemo<InRaftLink>(() => ({ href: artifactUrl(target.id, target.version), onClick }), [target, onClick]);
  const href = appLinkOpenHref(link.url);
  if (!href) return null;
  // No domain, on the chip (touch included) or in the footer: the link is
  // Raft's own (xxchan, Remy; #proj-workspace:fbc76200).
  return (
    <AppLinkHoverCard
      label={summary.title}
      chip={
        <>
          {artifactKindIcon(summary.kind)}
          <MessageReferenceLabel>{summary.title}</MessageReferenceLabel>
        </>
      }
      href={href}
      open={open}
      kind="object"
      owner={owner}
    >
      <ArtifactLinkPreview card={summary} />
      <LinkCardFooter app={appName} />
    </AppLinkHoverCard>
  );
}

const FOCUSABLE = "a[href], button:not([disabled]), [tabindex]:not([tabindex='-1'])";

/**
 * The chip as a link that opens the hover card on hover and keyboard focus
 * (DS PreviewCard). On touch the card doesn't open, so a tap opens the link.
 *
 * The card is portaled, out of the tab order, but its buttons must be reachable
 * from the keyboard (addendum 5 §3): Tab on the chip moves into the open card;
 * Tab past its last control (or Shift+Tab before its first) comes back to the
 * chip, so the reader continues from where the link is in the message.
 *
 * A v2 card's confirm dialog (`confirmFor`, opened by this chip, `owner`) is
 * drawn beside the card, never in it: it stays when the card closes (addendum
 * 5 §3), and gives focus back to the chip.
 */
function AppLinkHoverCard({ chip, label, href, open, kind, confirmFor, owner, children }: {
  chip: ReactNode;
  label: string;
  /** The link the chip stands for (the author's): screenshots turn the chip back into it. */
  href: string;
  /** A first-party chip's own page in Raft and its click; without it the chip opens `href` in a new tab. */
  open?: InRaftLink;
  /** What the chip is: an App result's kind, or a first-party `object`. */
  kind: AppLinkResult["kind"] | "object";
  confirmFor?: Extract<AppLinkResult, { kind: "card" }>;
  owner: string;
  children: ReactNode;
}) {
  const chipRef = useRef<HTMLAnchorElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  // Closed (Escape, or the pointer leaving) with focus in it: focus goes back
  // to the chip instead of being dropped with the card.
  const returnFocus = useCallback((open: boolean) => {
    const active = document.activeElement;
    if (!open && active && cardRef.current?.contains(active)) chipRef.current?.focus();
  }, []);
  useEffect(() => takeFocusAfterAllow(href, chipRef.current), [href]);
  const intoCard = useCallback((event: KeyboardEvent) => {
    if (event.key !== "Tab" || event.shiftKey) return;
    const first = cardRef.current?.querySelector<HTMLElement>(FOCUSABLE);
    if (!first) return;
    event.preventDefault();
    first.focus();
  }, []);
  const outOfCard = useCallback((event: KeyboardEvent) => {
    if (event.key !== "Tab") return;
    const controls = [...(cardRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
    if (event.target !== (event.shiftKey ? controls[0] : controls.at(-1))) return;
    chipRef.current?.focus();
    // Shift+Tab lands on the chip; Tab goes on from the chip to what follows it.
    if (event.shiftKey) event.preventDefault();
  }, []);
  return (
    <>
    <PreviewCard onOpenChange={returnFocus}>
      <PreviewCardTrigger
        ref={chipRef}
        render={<MessageReferenceChip variant="info" capped render={open ? inRaftLink(open, label) : newTabLink(href, label)} />}
        onKeyDown={intoCard}
        data-app-link-chip={kind}
        data-app-link-chip-url={href}
      >
        {chip}
      </PreviewCardTrigger>
      {/* Per-viewer App data: share screenshots strip it (selectScreenshot.ts).
          A card showing one item is item-wide; one asking for one action (connect, allow) keeps the default. */}
      <PreviewCardContent ref={cardRef} size={kind === "card" || kind === "object" ? "item" : "profile"} onKeyDown={outOfCard} data-app-link-preview="">
        {children}
      </PreviewCardContent>
    </PreviewCard>
    {confirmFor ? <LinkCardConfirmDialog result={confirmFor} owner={owner} finalFocus={chipRef} /> : null}
    </>
  );
}

/**
 * The card: the App's full title, then its elements: v2's (LinkCardElements)
 * or v1's read-only catalog, then v2's buttons. The chip may show the shorter
 * inline title; the card always shows `title`.
 */
function AppLinkCardBody({ result, owner }: { result: Extract<AppLinkResult, { kind: "card" }>; owner: string }) {
  return (
    <>
      <PreviewCardBody>
        <ItemCardTitle title={result.title} />
        {result.cardV2 ? (
          <LinkCardBoundary key={JSON.stringify(result.cardV2)}>
            <LinkCardElements card={result.cardV2} />
          </LinkCardBoundary>
        ) : result.card ? (
          <LinkCardBoundary key={JSON.stringify(result.card)}>
            <StateProvider initialState={emptyState}><VisibilityProvider><ActionProvider handlers={noActions}>
              <Renderer spec={result.card} registry={registry} />
            </ActionProvider></VisibilityProvider></StateProvider>
          </LinkCardBoundary>
        ) : null}
      </PreviewCardBody>
      {/* v2 (RFC 076): the card's buttons, in PreviewCardActions. */}
      {result.cardV2 ? <LinkCardActions result={result} owner={owner} /> : null}
    </>
  );
}

/**
 * The App's title, clamped by raft-ui. Only when the clamp cuts it does
 * hovering it show the whole title, in a raft-ui Tooltip (the DS gives a
 * truncated name one; a title shown whole gets none, as for the buttons).
 */
const SELECTABLE_TRIGGER = { className: "select-text" };

function ItemCardTitle({ title }: { title: string }) {
  const titleRef = useRef<HTMLParagraphElement>(null);
  const truncated = useTruncated(titleRef);
  return (
    // The trigger takes the slot from the child's props and would otherwise drop the title's own
    // (selectors and tests read it; its clamp now comes from PreviewCardBody's context, not the slot), and it makes text
    // unselectable: a title stays selectable.
    <Tooltip content={title} disabled={!truncated} triggerProps={SELECTABLE_TRIGGER}>
      <PreviewCardTitle ref={titleRef} data-slot="preview-card-title" data-link-card-title="">{title}</PreviewCardTitle>
    </Tooltip>
  );
}

/** `connect_account`: Raft's own words and one button to the App's connect page. No text of the App's. */
function AppLinkConnectBody({ result }: { result: Extract<AppLinkResult, { kind: "connect_account" }> }) {
  const { formatMessage } = useIntl();
  const connectHref = appLinkOpenHref(result.connectUrl);
  return (
    <>
      <PreviewCardBody>
        <PreviewCardTitle>{formatMessage({ id: "message.appLink.connect.title" }, { app: result.app.name })}</PreviewCardTitle>
        <Text.Sans size="small" variant="muted">{formatMessage({ id: "message.appLink.connect.description" }, { app: result.app.name })}</Text.Sans>
      </PreviewCardBody>
      {connectHref ? (
        <PreviewCardActions>
          <Button variant="outline" nativeButton={false} role="link" render={newTabLink(connectHref, formatMessage({ id: "message.appLink.connect.action" }))}>
            {formatMessage({ id: "message.appLink.connect.action" })}
          </Button>
        </PreviewCardActions>
      ) : null}
    </>
  );
}

function promptState(status: LinkPreviewAnswerStatus | undefined): LinkPreviewPromptState {
  return status === "allowing" || status === "declining" || status === "failed" ? status : "idle";
}

// Where keyboard focus goes once the question is answered and its chip is
// replaced: the card chip that comes for this link after Allow (AppLinkHoverCard
// takes it when it mounts in the same message), or the plain link after Don't
// Allow. Someone who has moved on keeps their focus.
let focusAfterAllow: { href: string; root: Element } | null = null;
/** Whether the viewer is answering from the keyboard (focus on the chip or in the question), and in which message. */
function answeringFrom(chip: HTMLElement | null, ask: HTMLElement | null): { hadFocus: boolean; root: Element | null } {
  const active = document.activeElement;
  const hadFocus = !!active && (!!chip?.contains(active) || !!ask?.contains(active));
  return { hadFocus, root: chip?.closest("[data-message-id]") ?? chip?.parentElement ?? null };
}
/** After Don't Allow the grey chip is the author's link again: focus it once it is back. */
function focusPlainLink(root: Element | null, href: string) {
  window.setTimeout(() => {
    const active = document.activeElement;
    if (active && active !== document.body) return;
    root?.querySelector<HTMLElement>(`a[href="${CSS.escape(href)}"]`)?.focus();
  }, 0);
}
function takeFocusAfterAllow(href: string, chip: HTMLElement | null) {
  if (!chip || focusAfterAllow?.href !== href || !focusAfterAllow.root.contains(chip)) return;
  focusAfterAllow = null;
  const active = document.activeElement;
  if (!active || active === document.body) chip.focus();
}

/**
 * The viewer hasn't answered this App: a grey chip with Raft's stored icon and
 * the shortened address, as a button, not a link, so a click, a tap or Enter
 * asks first instead of leaving (DS Navigation › App links; addendum 5 §1,
 * the phone exception). On desktop hovering opens the same question, the
 * hover card's place. The question is #10725's consent prompt; nothing has
 * been asked of the App, and nothing is until the viewer allows it.
 */
function AppLinkConsentChip({ result, href, domain }: { result: Extract<AppLinkResult, { kind: "consent" }>; href: string; domain: string }) {
  const { formatMessage } = useIntl();
  const viewer = useAuthStore((s) => s.user?.id);
  const server = useServerStore((s) => s.current?.id);
  const viewerKey = linkPreviewViewerKey(viewer, server);
  const status = useLinkPreviewConsentStore((s) => s.status[linkPreviewAppKey(viewerKey, result.app.id)]);
  const chipRef = useRef<HTMLButtonElement>(null);
  const askRef = useRef<HTMLDivElement>(null);
  const allow = useCallback((app: LinkPreviewApp) => {
    const { hadFocus, root } = answeringFrom(chipRef.current, askRef.current);
    void useLinkPreviewConsentStore.getState().allow(viewerKey, app).then((answer) => {
      // Failed: the prompt stays, its Allow button now Retry.
      if (answer === "failed") return;
      if (answer === "unavailable") {
        toast.info(formatMessage({ id: "message.linkPreviewPrompt.unavailable" }, { app: app.name }));
        if (hadFocus) focusPlainLink(root, href);
        return;
      }
      if (hadFocus && root) focusAfterAllow = { href, root };
    });
  }, [formatMessage, href, viewerKey]);
  const decline = useCallback((app: LinkPreviewApp) => {
    const { hadFocus, root } = answeringFrom(chipRef.current, askRef.current);
    void useLinkPreviewConsentStore.getState().decline(viewerKey, app).then((answer) => {
      if (answer === "declined") toast.info(formatMessage({ id: "message.linkPreviewPrompt.declined" }, { app: app.name }));
      else if (answer === "unavailable") toast.info(formatMessage({ id: "message.linkPreviewPrompt.unavailable" }, { app: app.name }));
      else if (answer === "failed") toast.error(formatMessage({ id: "message.linkPreviewPrompt.declineFailed" }, { app: app.name }));
      if (answer !== "failed" && hadFocus) focusPlainLink(root, href);
    });
  }, [formatMessage, href, viewerKey]);
  return (
    <Popover>
      <PopoverTrigger
        ref={chipRef}
        openOnHover
        delay={80}
        closeDelay={40}
        render={<MessageReferenceChip variant="muted" capped render={<button type="button" />} />}
        data-app-link-chip="consent"
        data-app-link-chip-url={href}
      >
        <AppLinkIcon app={result.app} frame="chip" />
        <MessageReferenceLabel>{appLinkShortAddress(result.url)}</MessageReferenceLabel>
      </PopoverTrigger>
      {/* An item popover (raft-ui size="item"): the 400px of the item card it stands in for, never wider than the screen. */}
      <PopoverContent ref={askRef} size="item" data-app-link-preview="">
        <div className="p-2 pb-0">
          <LinkPreviewConsentPrompt app={result.app} state={promptState(status)} onAllow={allow} onDecline={decline} />
        </div>
        <PopoverActions className="justify-between pt-2">
          <span className={`min-w-0 font-sans text-footnote text-foreground-muted ${KEEP_END}`} data-app-link-preview-host=""><KeptEnd text={domain} /></span>
          <Button variant="ghost" nativeButton={false} role="link" render={newTabLink(href, formatMessage({ id: "message.messageItem.openLink" }))}>
            {formatMessage({ id: "message.messageItem.openLink" })}
          </Button>
        </PopoverActions>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Just allowed: the link waits as a pending chip while it is read again, with
 * the same ends and cap as the chip that replaces it (DS MessageItem › App
 * links).
 */
function AppLinkPendingChip({ href }: { href: string }) {
  return (
    <MessageReferencePending capped data-app-link-chip="pending" data-app-link-chip-url={href} data-app-link-preview-pending="">
      <LinkIcon aria-hidden />
      <MessageReferenceLabel>{appLinkShortAddress(href)}</MessageReferenceLabel>
    </MessageReferencePending>
  );
}
