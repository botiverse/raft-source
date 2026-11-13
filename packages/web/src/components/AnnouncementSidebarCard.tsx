import { Button, Card, CardContent, CardFooter, CardHeader, CardTitle, InlineCode, MarkdownLink, TextLinkExternalIcon, ScrollArea } from "@botiverse/raft-ui";
import { AnnouncementDialogLabel } from "@botiverse/raft-ui/wip";
import { ArrowUpRight, X } from "lucide-react";
import { useMemo } from "react";
import type { CSSProperties } from "react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkCjkFriendly from "remark-cjk-friendly";
import type { AnnouncementContent } from "@botiverse/raft-shared/announcement-presentation";
import { INTEGRATION_INVITE_PATH_PREFIX } from "@botiverse/raft-shared";
import { useMediaQuery } from "../hooks/effectPrimitives";
import AnnouncementCardPicture from "./AnnouncementCardPicture";

const REMARK_PLUGINS = [remarkGfm, remarkCjkFriendly];
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/** An announcement's link or call to action leaves Raft unless it is a path
 *  in the app ("/…" or "?…", which the call to action navigates to in place). */
/** Where an announcement link goes inside Raft (path, query and hash), or
 *  null when it leaves Raft. A relative href, or an absolute one on this app's
 *  own origin, stays inside; anything else is another site. */
export function announcementInAppPath(href: string | undefined): string | null {
  if (!href) return null;
  if (href.startsWith("/") || href.startsWith("?") || href.startsWith("#")) return href;
  if (typeof window === "undefined") return null;
  try {
    const url = new URL(href, window.location.origin);
    return url.origin === window.location.origin ? `${url.pathname}${url.search}${url.hash}` : null;
  } catch {
    return null;
  }
}

const firstSegment = (path: string) => path.slice(1).split(/[/?#]/, 1)[0];

/** First path segments of the top-level routes in App.tsx (keep in step with
 *  it); any other in-app path belongs to a server (#raft-operations:fd1d5a00). */
const TOP_LEVEL_SEGMENTS = new Set([
  "s", "servers", "download", "artifacts", "connections", "appsumo", "dev", "palette-audit",
  "login", "login-with-raft", "login-with-slock", "login-with-slock-human",
  // "community": CHINESE_COMMUNITY_PAGE_PATH (utils/communityServers; not imported, the admin bundles this file).
  "community", firstSegment(INTEGRATION_INVITE_PATH_PREFIX),
]);

/** An in-app call to action written once for every server: `/apps` opens the
 *  reader's current server (`/s/<slug>/apps`). Paths already under `/s/`, the
 *  app's top-level pages, and `?…` / `#…` stay as written. */
export function announcementServerPath(path: string, serverSlug: string | undefined): string {
  if (!serverSlug || !path.startsWith("/")) return path;
  if (TOP_LEVEL_SEGMENTS.has(firstSegment(path))) return path;
  return `/s/${encodeURIComponent(serverSlug)}${path === "/" ? "" : path}`;
}

export function isAnnouncementExternalHref(href: string | undefined): boolean {
  return !!href && announcementInAppPath(href) === null;
}

/** Announcement body Markdown: Raft Design System prose links (raft-ui
 *  MarkdownLink: link blue with a quiet underline that deepens on hover). The
 *  copy is ours, not a person's, so a link that leaves Raft ends in ↗ with
 *  `opensInNewTab` for a screen reader (raft-design navigation.md "Links that
 *  leave Raft"). */
export function announcementMarkdownComponents(opensInNewTab?: string): Components {
  return {
    a: ({ children, href }) => (
      <MarkdownLink
        href={href}
        // Only a link that leaves Raft opens in a new tab: on desktop a
        // new-tab link to Raft itself goes nowhere.
        {...(isAnnouncementExternalHref(href) ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      >
        {children}
        {isAnnouncementExternalHref(href) ? <TextLinkExternalIcon label={opensInNewTab} /> : null}
      </MarkdownLink>
    ),
    code: ({ children }) => <InlineCode>{children}</InlineCode>,
  };
}

/** Pure product composition, also used by the operator's local-only preview. */
export default function AnnouncementSidebarCard({ content, imageUrl, defaultLabel, closeLabel, gotItLabel, opensInNewTabLabel, zoomLabel, onZoomImage, position = 1, total = 1, positionText, positionLabel, onClose, onAction, onAcknowledge }: {
  content: AnnouncementContent;
  imageUrl?: string;
  defaultLabel: string;
  closeLabel: string;
  gotItLabel: string;
  /** Read after a link or call to action that leaves Raft. */
  opensInNewTabLabel?: string;
  /** Names the picture's open-full-size button; without it the picture is not zoomable. */
  zoomLabel?: string;
  onZoomImage?: () => void;
  /** 1-based place in this entry's stack of sidebar cards, and its size; a single card shows neither. */
  position?: number;
  total?: number;
  /** Shown form of the position, e.g. "2 / 5", and its spoken form, e.g. "2 of 5". */
  positionText?: string;
  positionLabel?: string;
  onClose: () => void;
  onAction: () => void;
  onAcknowledge: () => void;
}) {
  const markdownComponents = useMemo(() => announcementMarkdownComponents(opensInNewTabLabel), [opensInNewTabLabel]);
  const behind = Math.max(0, Math.min(total - position, 2));
  // An animated picture plays on its own, except under reduced motion.
  const reducedMotion = useMediaQuery(REDUCED_MOTION_QUERY);
  const card = <Card render={<aside aria-label={content.title} />} className="relative min-w-0 select-text max-h-[min(60vh,36rem)]" data-testid="announcement-sidebar-card">
    <CardHeader className="block p-4">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <AnnouncementDialogLabel>{content.label || defaultLabel}</AnnouncementDialogLabel>
        {total > 1 && positionText && <span className="ms-auto shrink-0 text-caption tabular-nums text-foreground-muted" aria-label={positionLabel} data-testid="announcement-sidebar-position">{positionText}</span>}
        <Button variant="ghost" size="icon-md" className="-my-1 -me-1 shrink-0 text-foreground-muted [&_svg]:size-3.5" aria-label={closeLabel} onClick={onClose}><X aria-hidden /></Button>
      </div>
      <CardTitle className="mt-1 break-words">{content.title}</CardTitle>
    </CardHeader>
    {/* The body scrolls between the header and the buttons in a raft-ui
        ScrollArea (the card keeps its max height), a region named like the
        card: a tab stop once it overflows. */}
    <CardContent render={<ScrollArea role="region" aria-label={content.title} />} className="min-h-0 px-4 pt-3 pb-4">
      {content.image && imageUrl && <AnnouncementCardPicture src={imageUrl} alt={content.image.alt} playing={!reducedMotion} zoomLabel={zoomLabel} onZoom={onZoomImage} />}
      <div className="break-words text-callout text-foreground-muted [&_p]:mb-2 [&_p:last-child]:mb-0 [&_ul]:list-disc [&_ul]:pl-4 [&_ol]:list-decimal [&_ol]:pl-4">
        <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={markdownComponents}>{content.pages[0]?.body ?? ""}</ReactMarkdown>
      </div>
    </CardContent>
    <CardFooter className="flex-col items-stretch gap-2 border-0 px-4 pt-0 pb-4">
      {content.cta && (
        <Button variant="primary" className="h-auto min-h-8 w-full whitespace-normal break-words py-1" onClick={onAction}>
          {content.cta.label}
          {isAnnouncementExternalHref(content.cta.href) ? (
            <>
              <ArrowUpRight data-icon="inline-end" aria-hidden="true" focusable="false" className="shrink-0" />
              {opensInNewTabLabel ? <>{" "}<span className="sr-only">{opensInNewTabLabel}</span></> : null}
            </>
          ) : null}
        </Button>
      )}
      {/* Below the call to action when there is one (Cindy, #wg-announcement:6ec5ae99). */}
      <Button variant={content.cta ? "ghost" : "primary"} className="w-full" onClick={content.cta ? onAcknowledge : onAction}>{gotItLabel}</Button>
    </CardFooter>
  </Card>;
  if (!behind) return card;
  // Edges of the cards still to come, so a reader can tell more follow.
  return <div className="relative pb-[var(--stack-pad)]" style={{ "--stack-pad": `${behind * 5}px` } as CSSProperties} data-testid="announcement-sidebar-stack">
    {behind >= 2 && <div aria-hidden className="absolute inset-x-4 bottom-0 h-4 rounded-b-sticker border border-t-0 border-line-seam bg-layer-card opacity-70" />}
    <div aria-hidden className="absolute inset-x-2 bottom-[calc(var(--stack-pad)-5px)] h-4 rounded-b-sticker border border-t-0 border-line-seam bg-layer-card" />
    {card}
  </div>;
}
