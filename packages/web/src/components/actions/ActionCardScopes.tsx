// The OAuth permissions an action card asks for, in the raft-ui scope list (a
// capped scroll area). Raft's notes on where the app may send are notices
// (ActionCardScopeNotices.tsx), drawn just before the list.

import { useIntl } from "react-intl";
import {
  MessageActionCardScope,
  MessageActionCardScopeDescription,
  MessageActionCardScopeList,
  MessageActionCardScopeListLabel,
  MessageActionCardScopeListViewport,
  MessageActionCardScopeName,
} from "@botiverse/raft-ui";
import { OAUTH_SCOPE_PRESENTATION, isVisibleOAuthScope } from "../../lib/oauthScopePresentation";

export function ActionCardScopes({ scopes }: { scopes: readonly string[] }) {
  const { formatMessage } = useIntl();
  // Every scope the card carries, a scope this build has no copy for under its
  // raw name: a hidden scope would still be granted.
  const shownScopes = [...new Set(scopes.map((scope) => scope.trim()).filter(Boolean))];
  const label = formatMessage({ id: "actionCard.permissions" }, { count: shownScopes.length });

  // No scope Raft describes: the raw names on one line, nothing to explain.
  if (!shownScopes.some(isVisibleOAuthScope)) {
    return (
      <MessageActionCardScopeList>
        <MessageActionCardScopeListLabel>{label}</MessageActionCardScopeListLabel>
        <div className="break-all font-mono text-mono-meta text-foreground">{shownScopes.length > 0 ? shownScopes.join(", ") : "-"}</div>
      </MessageActionCardScopeList>
    );
  }

  return (
    <MessageActionCardScopeList>
      <MessageActionCardScopeListLabel>{label}</MessageActionCardScopeListLabel>
      <MessageActionCardScopeListViewport aria-label={label}>
        {shownScopes.map((scope) => (
          <MessageActionCardScope key={scope}>
            <MessageActionCardScopeName>{scope}</MessageActionCardScopeName>
            <MessageActionCardScopeDescription>
              {isVisibleOAuthScope(scope)
                ? formatMessage({ id: OAUTH_SCOPE_PRESENTATION[scope].copyId })
                : formatMessage({ id: "appPermissionSet.unrecognizedScope" })}
            </MessageActionCardScopeDescription>
          </MessageActionCardScope>
        ))}
      </MessageActionCardScopeListViewport>
    </MessageActionCardScopeList>
  );
}
