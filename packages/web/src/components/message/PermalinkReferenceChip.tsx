import { useCallback } from "react";
import { Link } from "lucide-react";
import { ReferenceChip } from "./ReferenceChip";

/** Permalink chip for quoted-message links in markdown bodies — a real
    component so its click handler can be a useCallback (task #709).
    Its label is the conversation as this viewer resolves it, so share images
    show the link the author wrote instead (`authorText`: the link's text as
    written, its address for a bare link). */
export function PermalinkReferenceChip({
  href,
  authorText,
  quotedMessageUnavailable,
  channelLabel,
  onOpenPermalink,
}: {
  href: string;
  authorText: string;
  quotedMessageUnavailable: boolean;
  channelLabel: string;
  onOpenPermalink?: (href: string) => void;
}) {
  const handleClick = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    onOpenPermalink?.(href);
  }, [onOpenPermalink, href]);
  return (
    <ReferenceChip
      as={quotedMessageUnavailable ? "span" : "a"}
      href={quotedMessageUnavailable ? undefined : href}
      onClick={quotedMessageUnavailable ? undefined : handleClick}
      title={quotedMessageUnavailable ? undefined : href}
      icon={Link}
      variant="link"
      label={channelLabel}
      data-select-screenshot-author-link={href}
      data-select-screenshot-author-text={authorText}
      trailing={quotedMessageUnavailable ? undefined : (
        <span className="font-mono text-label font-normal leading-none text-foreground-hint">msg</span>
      )}
    />
  );
}
