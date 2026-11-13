import { Button, ListRow, ListRowBody, ListRowMeta } from "@botiverse/raft-ui";
import Tooltip from "../ui/Tooltip";
import { useCallback } from "react";
import { Check, Copy, X } from "lucide-react";
import { useIntl } from "react-intl";
import { buildJoinLinkUrl } from "../../features/settings/administration/buildJoinLinkUrl";
import type { JoinLinkRecord } from "../../features/settings/shared/inviteRecords";

export function JoinLinkRow({
  link,
  copied,
  formatShortDateTime,
  onCopy,
  onRequestRevoke,
}: {
  link: JoinLinkRecord;
  copied: boolean;
  formatShortDateTime: (value: string) => string;
  onCopy: (linkId: string, token: string) => void;
  onRequestRevoke: (link: JoinLinkRecord) => void;
}) {
  const { formatMessage } = useIntl();
  const handleCopy = useCallback(() => onCopy(link.id, link.token), [link.id, link.token, onCopy]);
  const handleRequestRevoke = useCallback(() => onRequestRevoke(link), [link, onRequestRevoke]);

  // A row of Administration › Invite links' ListRowGroup: the link and its uses
  // and expiry under it, Copy and Revoke at the row's end.
  return (
    <ListRow variant="plain" interactive={false}>
      <ListRowBody className="gap-1.5">
        <span className="block min-w-0 select-all truncate rounded-control bg-fill-muted px-2.5 py-1.5 font-mono text-mono-meta text-foreground">
          {buildJoinLinkUrl(link.token)}
        </span>
        <ListRowMeta className="whitespace-normal">
          {link.maxUses != null
            ? formatMessage({ id: "settings.joinLinks.usesWithMax" }, { used: link.useCount, max: link.maxUses })
            : formatMessage({ id: "settings.joinLinks.uses" }, { used: link.useCount })}
          {" · "}
          {link.expiresAt
            ? formatMessage({ id: "settings.joinLinks.expires" }, { when: formatShortDateTime(link.expiresAt) })
            : formatMessage({ id: "settings.joinLinks.noExpiry" })}
        </ListRowMeta>
      </ListRowBody>
      <Tooltip content={formatMessage({ id: "settings.joinLinks.copyLink" })}>
      <Button
        variant="outline" size="icon-md" type="button"
        onClick={handleCopy}
        className="shrink-0"
        aria-label={formatMessage({ id: "settings.joinLinks.copyLink" })}
        data-slot="button"
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </Button>
      </Tooltip>
      <Tooltip content={formatMessage({ id: "settings.joinLinks.revokeLink" })}>
      <Button
        variant="outline" size="icon-md" type="button"
        onClick={handleRequestRevoke}
        className="shrink-0"
        aria-label={formatMessage({ id: "settings.joinLinks.revokeLink" })}
        data-slot="button"
      >
        <X size={14} />
      </Button>
      </Tooltip>
    </ListRow>
  );
}
