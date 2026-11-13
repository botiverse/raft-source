// The login scopes and data groups an install or an approved update records.
// Every surface that sends `expected_scopes` / `expected_groups`
// shows the same set here first, so what the admin reads is what the server
// records. Nothing is filtered: a scope or group this build has no copy for is
// listed by its raw name rather than dropped.
//
// Raft Design System › Built from existing parts › Authorization: the
// requested permissions as a DescriptionList.

import { useIntl } from "react-intl";
import {
  Badge,
  DescriptionDetails,
  DescriptionItem,
  DescriptionList,
  DescriptionTerm,
  InlineCode,
} from "@botiverse/raft-ui";
import type { AppNotificationGroup } from "@botiverse/raft-shared";
import type { MessageId } from "../../i18n/messages";
import { OAUTH_SCOPE_PRESENTATION, isVisibleOAuthScope } from "../../lib/oauthScopePresentation";
import { APP_NOTIFICATION_GROUP_META, permissionGroupLabel } from "../settings/appNotificationSelection";

// Scopes in the shared catalog that are deliberately NOT in
// OAUTH_SCOPE_PRESENTATION: that table also decides which scopes the consent
// screen recognizes and Settings offers as toggles, and these are reserved, so
// adding them there would make them selectable. An app can still declare one,
// and an install still records it, so this list describes it rather than
// saying Raft knows nothing about a scope Raft defined.
const RESERVED_SCOPE_COPY_IDS: Readonly<Record<string, MessageId>> = {
  "agent:action_request:write": "appPermissionSet.scope.agentActionRequestWrite",
};

function unpresentedScopeCopyId(scope: string): MessageId {
  return Object.prototype.hasOwnProperty.call(RESERVED_SCOPE_COPY_IDS, scope)
    ? RESERVED_SCOPE_COPY_IDS[scope]!
    : "appPermissionSet.unrecognizedScope";
}

function isKnownGroup(group: string): group is AppNotificationGroup {
  return Object.prototype.hasOwnProperty.call(APP_NOTIFICATION_GROUP_META, group);
}

function uniqueValues(values: readonly string[] | null | undefined): string[] {
  return [...new Set(values ?? [])];
}

export function AppPermissionSetList({
  scopes,
  groups,
  newScopes,
  newGroups,
  className,
}: {
  /** Absent reads as none (an older card or response), never as "unknown". */
  scopes: readonly string[] | null | undefined;
  groups: readonly string[] | null | undefined;
  /** Marked New: what an update adds to what the Server approved before. */
  newScopes?: readonly string[];
  newGroups?: readonly string[];
  className?: string;
}) {
  const { formatMessage } = useIntl();
  const none = formatMessage({ id: "appPermissionSet.none" });
  const newLabel = formatMessage({ id: "appPermissionSet.new" });

  const scopeRows = uniqueValues(scopes).map((scope) => ({
    key: scope,
    name: <InlineCode>{scope}</InlineCode>,
    description: isVisibleOAuthScope(scope)
      ? formatMessage({ id: OAUTH_SCOPE_PRESENTATION[scope].copyId })
      : formatMessage({ id: unpresentedScopeCopyId(scope) }),
    isNew: newScopes?.includes(scope) ?? false,
  }));
  const groupRows = uniqueValues(groups).map((group) => ({
    key: group,
    name: isKnownGroup(group)
      ? <span className="font-semibold text-foreground">{permissionGroupLabel(group, formatMessage)}</span>
      : <InlineCode>{group}</InlineCode>,
    description: isKnownGroup(group)
      ? formatMessage({ id: APP_NOTIFICATION_GROUP_META[group].summaryId })
      : formatMessage({ id: "appPermissionSet.unrecognizedGroup" }),
    isNew: newGroups?.includes(group) ?? false,
  }));

  const renderRows = (kind: "scope" | "group", rows: typeof scopeRows) => (
    rows.length === 0 ? (
      <span className="text-foreground-hint">{none}</span>
    ) : (
      <ul className="stack-y-2">
        {rows.map((row) => (
          <li key={row.key} data-app-permission-kind={kind} data-app-permission-value={row.key}>
            <div className="flex flex-wrap items-center gap-1.5">
              {row.name}
              {row.isNew ? <Badge appearance="outline">{newLabel}</Badge> : null}
            </div>
            <div className="mt-0.5 text-footnote text-foreground-muted">{row.description}</div>
          </li>
        ))}
      </ul>
    )
  );

  return (
    // Each value carries a description line, so the facts need more air than
    // the list's default 2px row gap.
    <DescriptionList direction="horizontal" className={className ? `gap-y-3 ${className}` : "gap-y-3"} data-testid="app-permission-set">
      <DescriptionItem>
        <DescriptionTerm>{formatMessage({ id: "appPermissionSet.loginScopes" })}</DescriptionTerm>
        <DescriptionDetails>{renderRows("scope", scopeRows)}</DescriptionDetails>
      </DescriptionItem>
      <DescriptionItem>
        <DescriptionTerm>{formatMessage({ id: "appPermissionSet.dataAccess" })}</DescriptionTerm>
        <DescriptionDetails>{renderRows("group", groupRows)}</DescriptionDetails>
      </DescriptionItem>
    </DescriptionList>
  );
}
