import { TextLinkExternalIcon } from "@botiverse/raft-ui";
import Tooltip from "../../../components/ui/Tooltip";
import { useLeavingRaftLabel } from "../../../components/ui/LeavingRaftMark";

export function ConnectedAppUrlLink({ url, label, className = "" }: { url?: string | null; label?: string | null; className?: string }) {
  const opensInNewTab = useLeavingRaftLabel();
  const href = url?.trim();
  if (!href) return null;
  const visibleLabel = label?.trim() || href;
  return (
    <Tooltip content={href}>
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(event) => event.stopPropagation()}
      className={`inline-flex max-w-full min-w-0 items-center rounded-sticker font-mono text-mono-meta text-foreground-muted outline-none hover:text-foreground focus-visible:shadow-focus ${className}`.trim()}
    >
      {/* The underline stays on the text and stops before the ↗ (raft-design
          navigation.md "Links that leave Raft"). */}
      <span className="min-w-0 truncate underline decoration-[1.5px] underline-offset-[3px]">{visibleLabel}</span>
      <TextLinkExternalIcon label={opensInNewTab} />
    </a>
    </Tooltip>
  );
}
