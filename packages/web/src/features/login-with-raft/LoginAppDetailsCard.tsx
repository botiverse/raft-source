import { Badge, Card } from "@botiverse/raft-ui";
import { useIntl } from "react-intl";
import AvatarSlot from "../../components/ui/AvatarSlot";
import LeavingRaftMark, { opensInNewTabAriaLabel } from "../../components/ui/LeavingRaftMark";
import { initialsForApp } from "./appInitials";
import type { LoginClientSummary } from "./loginClientSummary";
import { APP_DETAILS_CARD_CLASS, APP_DETAILS_LINK_CARD_CLASS } from "./loginSetupClassNames";

export function LoginAppDetailsCard({ client }: { client: LoginClientSummary }) {
  const { formatMessage } = useIntl();
  const content = (
    <div className="flex min-w-0 items-start gap-3">
      <AvatarSlot
        context="list-row"
        type="app"
        appAvatarUrl={client.logoUrl}
        appInitials={initialsForApp(client.name)}
      />
      <div className="min-w-0 flex-1 stack-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 break-words text-subhead font-bold">{client.name}</span>
          {/* Suspended reads as the Server rows' Suspended badge, never a green Ready. */}
          {client.availability === "suspended" ? (
            <Badge variant="muted" appearance="soft">{formatMessage({ id: "pages.humanLogin.suspendedCompact" })}</Badge>
          ) : (
            <Badge variant="success" appearance="soft">{formatMessage({
              id: client.marketplace || client.availability === "install_required"
                ? "pages.humanLogin.marketplace"
                : "pages.humanLogin.ready",
            })}</Badge>
          )}
        </div>
        {client.description && <div className="text-footnote text-foreground-muted">{client.description}</div>}
      </div>
    </div>
  );

  if (!client.homepageUrl) {
    return <Card className={APP_DETAILS_CARD_CLASS}>{content}</Card>;
  }

  return (
    <Card
      render={(
        <a
          href={client.homepageUrl}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={opensInNewTabAriaLabel(formatMessage, `${formatMessage({ id: "pages.humanLogin.openAppAriaPrefix" })} ${client.name}`)}
        />
      )}
      className={APP_DETAILS_LINK_CARD_CLASS}
    >
      {/* The card leaves Raft for the app's homepage: ↗ at its top right. */}
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">{content}</div>
        <LeavingRaftMark className="mt-0.5 size-4 text-foreground-hint" />
      </div>
    </Card>
  );
}
