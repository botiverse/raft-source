import { TextLink } from "@botiverse/raft-ui";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import AppBadge from "../../components/agent/AppBadge";
import type { Agent } from "../../store/agentStore";
import { useManagedAppDetailLink } from "./useManagedAppDetailLink";

type AppBotAgent = Pick<Agent, "managedByAppInstallId" | "managedByApp" | "serverId" | "profileProjection">;

function AppLogo({ url }: { url: string | null | undefined }) {
  return url ? <img src={url} alt="" className="size-4 shrink-0 rounded-sm object-cover" /> : null;
}

/**
 * The App an App bot belongs to, as one TextLink (a real link: a new tab works) to the App's detail
 * (useManagedAppDetailLink), named "Open <App> app details"; plain text where
 * the viewer has no Apps page. The same pieces, the same row, either way.
 */
function AppIdentity({ agent, className, testId, children }: { agent: AppBotAgent; className: string; testId: string; children: ReactNode }) {
  const link = useManagedAppDetailLink(agent);
  if (!link) return <span className={className}>{children}</span>;
  return (
    <TextLink
      variant="strong"
      render={<a href={link.href}>{children}</a>}
      onClick={link.onClick}
      aria-label={link.label}
      data-testid={testId}
      className={className}
    >
      {children}
    </TextLink>
  );
}

/** The profile hero's "From <logo> <App>" after the App badge. */
export function AppBotFromApp({ agent }: { agent: AppBotAgent }) {
  const { formatMessage } = useIntl();
  const app = agent.managedByApp;
  if (!app) return null;
  return (
    <span className="inline-flex min-w-0 items-center gap-1 text-footnote text-foreground-muted" data-testid="agent-profile-bot-from-app">
      {formatMessage({ id: "agent.appFromApp" }, {
        app: (
          <AppIdentity key="app" agent={agent} className="inline-flex min-w-0 items-center gap-1" testId="agent-profile-bot-from-app-link">
            <AppLogo url={app.logoUrl} />
            <span className="min-w-0 truncate text-foreground">{app.name}</span>
          </AppIdentity>
        ),
      })}
    </span>
  );
}

/** The Managed by app row's value: logo, App badge, name. */
export function ManagedByAppValue({ agent }: { agent: AppBotAgent }) {
  const { formatMessage } = useIntl();
  return (
    <AppIdentity agent={agent} className="inline-flex max-w-full items-center gap-1.5" testId="agent-profile-managed-by-app-link">
      <AppLogo url={agent.managedByApp?.logoUrl} />
      <AppBadge />
      <span className="min-w-0 truncate">
        {agent.managedByApp?.name ?? formatMessage({ id: "agent.detail.managedByAppUnknown" })}
      </span>
    </AppIdentity>
  );
}
