import { Skeleton, Card, Switch, Separator } from "@botiverse/raft-ui";
import { Fragment, useCallback, useState, useEffect, useMemo, useRef } from "react";
import { AlertTriangle, FlaskConical } from "lucide-react";
import { useServerStore } from "../../../store/serverStore";
import { useServerPermissions } from "../../../hooks/useServerPermissions";
import Banner from "../../../components/ui/Banner";
import api from "../../../api/client";
import { useIntl } from "react-intl";
import SectionHeader from "../../../components/ui/SectionHeader";
import {
  createServerLabEnrollmentMutation,
  createServerLabMasterMutation,
  getServerLabSettingsAuthority,
  isServerLabEnrollmentEditable,
  normalizeServerLabSettingsReadback,
} from "../../../utils/serverLabsSettings";
import type { CanonicalServerLabSettingsReadback, ServerLabSettingsReadback } from "../../../utils/serverLabsSettings";
import { refreshServerFeatureFlags } from "../../../store/serverFeatureFlags";
import {
  beginServerLabsMutation,
  createServerLabsStoreContext,
  failServerLabsMutation,
  loadServerLabsSettings,
  publishServerLabsReadback,
  useServerLabsSettingsSnapshot,
} from "../../../store/serverLabsSettingsStore";
import type { ServerLabsStoreContext } from "../../../store/serverLabsSettingsStore";
import { ServerLabRow } from "../../../components/settings/ServerLabRow";

function isActiveServerLabsContext(context: ServerLabsStoreContext) {
  const serverState = useServerStore.getState();
  return serverState.current?.id === context.serverId && serverState.serverEpoch === context.serverEpoch;
}

interface ServerLabsSavingTarget {
  serverId: string;
  serverEpoch: number;
  token: number;
  target: string;
}

export function LabsSection() {
  const { formatMessage } = useIntl();
  const current = useServerStore((s) => s.current);
  const serverEpoch = useServerStore((s) => s.serverEpoch);
  const { role } = useServerPermissions();
  const { readback, loading, unavailable, errorId } = useServerLabsSettingsSnapshot(current?.id, serverEpoch);
  const [savingTarget, setSavingTarget] = useState<ServerLabsSavingTarget | null>(null);
  const mutationRequestTokenRef = useRef(0);
  const activeServerId = current?.id ?? null;
  const activeReadback = readback?.serverId === activeServerId ? readback : null;
  const activeSavingTarget = savingTarget?.serverId === activeServerId && savingTarget.serverEpoch === serverEpoch ? savingTarget : null;

  const authority = useMemo(
    () => getServerLabSettingsAuthority(role, activeReadback?.permissions),
    [activeReadback?.permissions, role],
  );

  useEffect(() => {
    if (!current?.id) return;
    const requestContext = createServerLabsStoreContext(current.id, serverEpoch);
    loadServerLabsSettings(requestContext).catch(() => {});
  }, [current?.id, serverEpoch]);

  const applyReadbackMutation = useCallback(async (
    target: string,
    requestFactory: (serverId: string, snapshot: ServerLabSettingsReadback) => Promise<{ data: ServerLabSettingsReadback | CanonicalServerLabSettingsReadback | { data: ServerLabSettingsReadback | CanonicalServerLabSettingsReadback } }>,
  ) => {
    if (!activeServerId || !activeReadback || activeReadback.serverId !== activeServerId) return;
    const requestContext: ServerLabsStoreContext = {
      serverId: activeServerId,
      serverEpoch,
      token: mutationRequestTokenRef.current + 1,
    };
    mutationRequestTokenRef.current = requestContext.token;
    beginServerLabsMutation(requestContext);
    setSavingTarget({
      serverId: requestContext.serverId,
      serverEpoch: requestContext.serverEpoch,
      token: requestContext.token,
      target,
    });
    try {
      const response = await requestFactory(requestContext.serverId, activeReadback);
      if (!isActiveServerLabsContext(requestContext) || mutationRequestTokenRef.current !== requestContext.token) return;
      const normalized = normalizeServerLabSettingsReadback(response.data);
      if (normalized.serverId !== requestContext.serverId) {
        failServerLabsMutation(requestContext, "settings.labs.failedServerMismatch");
        return;
      }
      const published = publishServerLabsReadback(requestContext, normalized, "mutation");
      if (published) void refreshServerFeatureFlags(requestContext.serverId);
    } catch {
      if (!isActiveServerLabsContext(requestContext) || mutationRequestTokenRef.current !== requestContext.token) return;
      failServerLabsMutation(requestContext, "settings.labs.failedUpdate");
    } finally {
      if (isActiveServerLabsContext(requestContext) && mutationRequestTokenRef.current === requestContext.token) {
        setSavingTarget((existing) => (
          existing?.serverId === requestContext.serverId && existing.serverEpoch === requestContext.serverEpoch && existing.token === requestContext.token ? null : existing
        ));
      }
    }
  }, [activeReadback, activeServerId, serverEpoch]);

  const handleMasterChange = useCallback((enabled: boolean) => {
    if (!activeReadback || !authority.canSetMasterAccess) return;
    void applyReadbackMutation(
      "master",
      (serverId, snapshot) => api.patch(`/servers/${serverId}/labs/access`, createServerLabMasterMutation(snapshot, enabled)),
    );
  }, [activeReadback, applyReadbackMutation, authority.canSetMasterAccess]);

  const handleEnrollmentChange = useCallback((labKey: string, enabled: boolean) => {
    if (!activeReadback) return;
    const lab = activeReadback.labs.find((candidate) => candidate.key === labKey);
    if (!lab || !isServerLabEnrollmentEditable(lab, authority, activeReadback.masterEnabled)) return;
    void applyReadbackMutation(
      `lab:${labKey}`,
      (serverId, snapshot) => api.put(`/servers/${serverId}/labs/${encodeURIComponent(labKey)}`, createServerLabEnrollmentMutation(snapshot, enabled)),
    );
  }, [activeReadback, applyReadbackMutation, authority]);

  if (!current) return null;

  const error = errorId ? formatMessage({ id: errorId }) : "";

  return (
    <div className="mb-6">
      <SectionHeader
        className="mb-3"
        icon={<FlaskConical size={16} />}
        label={formatMessage({ id: "settings.labs.sectionLabel" })}
        count={activeReadback?.labs.length}
      />

      <Card className="p-4">
        {loading ? (
          <div className="stack-y-3">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : unavailable ? (
          <div className="flex items-start gap-3">
            <AlertTriangle size={16} className="mt-0.5 shrink-0 text-foreground-muted" />
            <div>
              <div className="text-subhead font-semibold text-foreground">{formatMessage({ id: "settings.labs.unavailableTitle" })}</div>
              <div className="mt-0.5 text-footnote text-foreground-muted">{formatMessage({ id: "settings.labs.unavailableDescription" })}</div>
            </div>
          </div>
        ) : activeReadback ? (
          <div className="stack-y-4">
            <div>
              <div className="flex min-h-8 items-center justify-between gap-4">
                <div className="min-w-0">
                  <div className="text-subhead font-semibold text-foreground">{formatMessage({ id: "settings.labs.masterTitle" })}</div>
                  {!authority.canSetMasterAccess && (
                    <div className="mt-0.5 text-footnote text-foreground-muted">
                      {formatMessage({ id: "settings.labs.masterOwnerOnly" })}
                    </div>
                  )}
                </div>
                <Switch
                  checked={activeReadback.masterEnabled}
                  disabled={!authority.canSetMasterAccess || activeSavingTarget != null}
                  onCheckedChange={handleMasterChange}
                  aria-label={formatMessage({ id: "settings.labs.masterTitle" })}
                  className="shrink-0"
                />
              </div>
              <Separator className="mt-4" />
            </div>

            {activeReadback.labs.length === 0 ? (
              <div className="text-footnote text-foreground-hint">{formatMessage({ id: "settings.labs.emptyState" })}</div>
            ) : (
              <div data-testid="server-labs-list">
                {activeReadback.labs.map((lab, index) => (
                  <Fragment key={lab.key}>
                  {index > 0 ? <Separator /> : null}
                  <ServerLabRow
                    lab={lab}
                    authority={authority}
                    masterEnabled={activeReadback.masterEnabled}
                    mutationPending={activeSavingTarget != null}
                    saving={activeSavingTarget?.target === `lab:${lab.key}`}
                    onEnrollmentChange={handleEnrollmentChange}
                  />
                  </Fragment>
                ))}
              </div>
            )}

            {error && (
              <Banner intent="warning" density="sm">
                {error}
              </Banner>
            )}
          </div>
        ) : error ? (
          <Banner intent="warning" density="sm">
            {error}
          </Banner>
        ) : null}
      </Card>
    </div>
  );
}
