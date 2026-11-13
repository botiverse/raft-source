// An external agent's credentials, beside "How it connects" (#wg-external-agent-ux:#2, Jasper's board 3):
// each one by where it came from and when it was last used; ⋯ has Create new credential (the page's
// own credential only) and Revoke. The menu is uncoloured; the confirms carry the colour.
import { useCallback } from "react";
import { useIntl } from "react-intl";
import { Ban, EllipsisVertical, Plus } from "lucide-react";
import { Button, Card, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@botiverse/raft-ui";
import SectionEyebrow from "../../components/ui/SectionEyebrow";
import { formatRelativeTime } from "../../utils/relativeTime";
import { PAGE_CREDENTIAL_NAME } from "./externalAgentSetup";
import type { AgentCredentialRow } from "./externalAgentSetup";

function CredentialItem({ credential, disabled, onReplace, onRevoke }: {
  credential: AgentCredentialRow;
  disabled: boolean;
  onReplace: (credentialId: string) => void;
  onRevoke: (credentialId: string) => void;
}) {
  const intl = useIntl();
  const { formatMessage, formatDate } = intl;
  const fromPage = credential.name === PAGE_CREDENTIAL_NAME;
  const title = fromPage
    ? formatMessage({ id: "agent.externalCard.pageCredential" })
    : credential.name || formatMessage({ id: "agent.externalCard.unnamedCredential" });
  const created = formatDate(credential.createdAt, { dateStyle: "medium" });
  const used = credential.lastUsedAt
    ? formatMessage({ id: "agent.externalCard.credentialUsed" }, { date: created, time: formatRelativeTime(credential.lastUsedAt, intl.locale) ?? "" })
    : formatMessage({ id: "agent.externalCard.credentialNotUsed" }, { date: created });
  const handleReplace = useCallback(() => onReplace(credential.id), [credential.id, onReplace]);
  const handleRevoke = useCallback(() => onRevoke(credential.id), [credential.id, onRevoke]);
  const menuLabel = formatMessage({ id: "agent.externalCard.credentialActions" }, { credential: title });
  return (
    <li className="flex min-w-0 items-center gap-2 px-3 py-2.5" data-testid="external-agent-credential-row" data-credential-id={credential.id}>
      <div className="min-w-0 flex-1">
        <p className="break-words text-callout font-semibold text-foreground">{title}</p>
        <p className="text-footnote text-foreground-muted">{used}</p>
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="ghost" size="icon-lg" aria-label={menuLabel} disabled={disabled} data-testid="external-agent-credential-menu" />}>
          <EllipsisVertical />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {fromPage ? (
            <DropdownMenuItem onClick={handleReplace} data-testid="external-agent-credential-replace">
              <Plus />
              {formatMessage({ id: "agent.externalCard.createNewCredential" })}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem onClick={handleRevoke} data-testid="external-agent-credential-revoke">
            <Ban />
            {formatMessage({ id: "agent.externalCard.revoke" })}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}

export function ExternalAgentCredentialList({ credentials, loading, listError, disabled, onReplace, onRevoke }: {
  credentials: AgentCredentialRow[];
  loading: boolean;
  listError: boolean;
  disabled: boolean;
  onReplace: (credentialId: string) => void;
  onRevoke: (credentialId: string) => void;
}) {
  const { formatMessage } = useIntl();
  return (
    <section className="stack-y-2" data-testid="external-agent-credentials">
      <SectionEyebrow as="div">{formatMessage({ id: "agent.externalCard.credentials" })}</SectionEyebrow>
      {loading ? <p role="status" className="text-footnote text-foreground-hint">{formatMessage({ id: "agent.externalCard.credentialsLoading" })}</p> : null}
      {listError ? <p role="alert" className="text-footnote font-semibold text-warning-strong">{formatMessage({ id: "agent.externalCard.credentialsError" })}</p> : null}
      {!loading && !listError && credentials.length === 0 ? (
        <p className="text-footnote text-foreground-hint">{formatMessage({ id: "agent.externalCard.credentialsEmpty" })}</p>
      ) : null}
      {!loading && !listError && credentials.length > 0 ? (
        <Card className="block p-0">
          <ul className="rule-y rule-line-hairline">
            {credentials.map((credential) => (
              <CredentialItem key={credential.id} credential={credential} disabled={disabled} onReplace={onReplace} onRevoke={onRevoke} />
            ))}
          </ul>
        </Card>
      ) : null}
    </section>
  );
}
