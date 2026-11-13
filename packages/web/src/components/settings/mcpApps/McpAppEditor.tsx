import { Button } from "@botiverse/raft-ui";
import { useCallback, useEffect, useEffectEvent, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { useIntl } from "react-intl";
import { isAppWhenToUseTooLong } from "@botiverse/raft-shared";
import api from "../../../api/client";
import Banner from "../../ui/Banner";
import { showToast } from "../../toastBridge";
import { FormDialog } from "../../ui/FormDialog";
import { DialogCommit } from "../../ui/NarrowDialog";
import type { FormDialogSection } from "../../ui/FormDialog";
import {
  canDeleteSourceOwnedConnectedApp,
  connectedAppDistributionStatus,
} from "../../../features/apps/connected-apps/connectedAppStatus";
import { ConnectedAppEditorActionRow } from "../../../features/apps/connected-apps/ConnectedAppEditorActionRow";
import { ConnectedAppEditorSection } from "../../../features/apps/connected-apps/ConnectedAppEditorSection";
import { McpAppAgentsSection } from "./McpAppAgentsSection";
import { McpAppConnectionsSection } from "./McpAppConnectionsSection";
import { McpAppDangerZone } from "./McpAppDangerZone";
import { McpAppProfileSection } from "./McpAppProfileSection";
import { McpAppServerCreate, McpAppServerFacts } from "./McpAppServerSection";
import {
  authKindForProbe,
  MCP_APP_SECTION_IDS,
  mcpAppErrorMessage,
  profileDraftFromView,
  sameHeaderNames,
  profilePayload,
} from "./mcpAppApi";
import type {
  McpAppProfileDraft,
  McpAppSectionId,
  McpAppView,
  McpProbeResult,
} from "./mcpAppApi";
import type { MessageId } from "../../../i18n/messages";

const EMPTY_PROFILE: McpAppProfileDraft = { name: "", description: "", homepageUrl: "", category: "", whenToUse: "" };

const SECTION_LABEL_ID: Record<McpAppSectionId, MessageId> = {
  profile: "settings.connectedApps.section.profile",
  mcp_server: "settings.mcpApp.section.mcpServer",
  connections: "settings.mcpApp.section.connections",
  agents: "settings.mcpApp.section.agents",
  distribution: "settings.connectedApps.section.distribution",
  danger: "settings.connectedApps.section.dangerZone",
};

/**
 * Add App ▸ Add a Custom MCP App (a server by its URL), and an MCP App's editor once it exists
 * (`appId`). Raft-maintained MCP Apps are installed from the Marketplace, not made here.
 *
 * Same shell as the ordinary App editor (FormDialog: head, section list with scroll sync, Save in
 * the footer), with an MCP
 * App's sections: Profile · MCP Server · Connections · Agents · Distribution · Danger zone. Login
 * with Raft and App Notifications do not apply to an MCP App and are not shown. Profile,
 * Distribution and Danger zone behave as an ordinary App's; only MCP Server and Connections (how the
 * App is authorized) are its own. Like an ordinary App's editor, it is opened only by App managers.
 */
export function McpAppEditor({
  appId,
  initialSection,
  onBrowseMarketplace,
  canManage,
  onClose,
  onChanged,
}: {
  /** null: add a new Custom MCP App. */
  appId: string | null;
  /** Opens scrolled to this section: Connections, right after a Marketplace install. */
  initialSection?: "connections";
  /** The new-App form's Browse Marketplace: the MCP Apps Raft maintains are installed there. */
  onBrowseMarketplace: () => void;
  canManage: boolean;
  onClose: () => void;
  /** The App was created, changed or deleted: the caller refreshes its list. */
  onChanged: () => void;
}) {
  const { formatMessage } = useIntl();
  const [view, setView] = useState<McpAppView | null>(null);
  const [loadingView, setLoadingView] = useState(appId !== null);
  const [profile, setProfile] = useState<McpAppProfileDraft>(EMPTY_PROFILE);
  const [endpointUrl, setEndpointUrl] = useState("");
  // An API-key App's required header names, as edited in MCP Server (edit mode).
  const [editHeaderNames, setEditHeaderNames] = useState<string[]>([]);
  const [probe, setProbe] = useState<McpProbeResult | null>(null);
  const [useWithoutSignIn, setUseWithoutSignIn] = useState(false);
  const [probing, setProbing] = useState(false);
  const [probeError, setProbeError] = useState("");
  const [headerNames, setHeaderNames] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [logoUploading, setLogoUploading] = useState(false);

  const applyView = useCallback((next: McpAppView) => {
    setView(next);
    setProfile(profileDraftFromView(next));
    setEndpointUrl(next.server.endpointUrl);
    setEditHeaderNames(next.server.requiredHeaderNames.length > 0 ? next.server.requiredHeaderNames : [""]);
  }, []);

  const loadView = useCallback(async (id: string | null) => {
    // A new App has nothing to load.
    if (id === null) return;
    setLoadingView(true);
    try {
      const { data } = await api.get<McpAppView>(`/mcp/apps/${id}`);
      applyView(data);
      setError("");
    } catch (loadError) {
      setError(mcpAppErrorMessage(loadError, formatMessage));
    } finally {
      setLoadingView(false);
    }
  }, [applyView, formatMessage]);

  // Load the App once per id; a locale switch (new `formatMessage`) must not refetch.
  const loadViewForApp = useEffectEvent(loadView);
  useEffect(() => {
    void loadViewForApp(appId);
  }, [appId]);

  const reloadView = useCallback(async () => {
    if (!view) return;
    try {
      const { data } = await api.get<McpAppView>(`/mcp/apps/${view.id}`);
      // Connections, the default and the catalogue change; the Profile draft being edited does not.
      setView(data);
      onChanged();
    } catch (reloadError) {
      setError(mcpAppErrorMessage(reloadError, formatMessage));
    }
  }, [formatMessage, onChanged, view]);

  const handleDeleted = useCallback(() => {
    onChanged();
    onClose();
  }, [onChanged, onClose]);

  const handleProfileChange = useCallback((patch: Partial<McpAppProfileDraft>) => {
    setProfile((current) => ({ ...current, ...patch }));
  }, []);

  const handleEndpointUrlChange = useCallback((value: string) => {
    setEndpointUrl(value);
    // A result is about the URL it was taken for; editing the URL means validating again.
    setProbe(null);
    setUseWithoutSignIn(false);
    setProbeError("");
  }, []);

  const handleValidate = useCallback(async () => {
    const url = endpointUrl.trim();
    if (!url) return;
    setProbing(true);
    setProbeError("");
    setProbe(null);
    setUseWithoutSignIn(false);
    try {
      const { data } = await api.post<McpProbeResult>("/mcp/probe", { endpointUrl: url });
      setProbe(data);
      if (data.outcome === "headers") setHeaderNames(data.suggestedHeaderNames?.length ? data.suggestedHeaderNames : ["Authorization"]);
    } catch (probeFailure) {
      setProbeError(mcpAppErrorMessage(probeFailure, formatMessage));
    } finally {
      setProbing(false);
    }
  }, [endpointUrl, formatMessage]);

  const createApp = useCallback(async () => {
    if (!probe || probe.outcome === "unreachable") throw new Error(formatMessage({ id: "settings.mcpApp.error.validateFirst" }));
    const authKind = probe.outcome === "oauth" && probe.tools && useWithoutSignIn ? "none" : authKindForProbe(probe.outcome);
    const names = headerNames.map((name) => name.trim()).filter(Boolean);
    if (authKind === "headers" && names.length === 0) throw new Error(formatMessage({ id: "settings.mcpApp.error.headerNamesRequired" }));
    return api.post<McpAppView>("/mcp/apps", {
      source: { kind: "url", endpointUrl: probe.endpointUrl },
      profile: profilePayload(profile),
      authKind,
      ...(authKind === "headers" ? { requiredHeaderNames: names } : {}),
    });
  }, [formatMessage, headerNames, probe, profile, useWithoutSignIn]);

  const handleSave = useCallback(async (event: FormEvent) => {
    event.preventDefault();
    if (!canManage || saving) return;
    setError("");
    if (!profile.name.trim()) {
      setError(formatMessage({ id: "settings.mcpApp.error.nameRequired" }));
      return;
    }
    setSaving(true);
    try {
      if (view) {
        const endpointChanged = !view.source.maintainedByRaft && endpointUrl.trim() !== view.server.endpointUrl;
        const headerNamesChanged = !view.source.maintainedByRaft && view.server.authKind === "headers"
          && !sameHeaderNames(editHeaderNames, view.server.requiredHeaderNames);
        const names = editHeaderNames.map((name) => name.trim()).filter(Boolean);
        if (headerNamesChanged && names.length === 0) throw new Error(formatMessage({ id: "settings.mcpApp.error.headerNamesRequired" }));
        const { data } = await api.patch<McpAppView>(`/mcp/apps/${view.id}`, {
          profile: profilePayload(profile),
          ...(endpointChanged ? { endpointUrl: endpointUrl.trim() } : {}),
          ...(headerNamesChanged ? { requiredHeaderNames: names } : {}),
        });
        applyView(data);
        showToast({ type: "success", data: { hasIcon: false }, title: formatMessage({ id: "settings.mcpApp.saved" }) });
      } else {
        const { data } = await createApp();
        applyView(data);
        showToast({ type: "success", data: { hasIcon: false }, title: formatMessage({ id: data.server.authKind === "none" ? "settings.mcpApp.createdReady" : "settings.mcpApp.createdNeedsConnection" }) });
      }
      onChanged();
    } catch (saveError) {
      setError(saveError instanceof Error && !(saveError as { response?: unknown }).response
        ? saveError.message
        : mcpAppErrorMessage(saveError, formatMessage));
    } finally {
      setSaving(false);
    }
  }, [applyView, canManage, createApp, editHeaderNames, endpointUrl, formatMessage, onChanged, profile, saving, view]);

  // Same calls and messages as an ordinary App's logo; only the route differs.
  const handleUploadLogo = useCallback(async (file: File) => {
    if (!view) return;
    setLogoUploading(true);
    setError("");
    try {
      const formData = new FormData();
      formData.append("logo", file);
      const { data } = await api.post<McpAppView>(`/mcp/apps/${view.id}/logo`, formData);
      setView(data);
      onChanged();
    } catch (uploadError) {
      const message = (uploadError as { response?: { data?: { error?: unknown } } })?.response?.data?.error;
      setError(typeof message === "string" && message ? message : formatMessage({ id: "settings.connectedApps.failedUploadLogo" }));
    } finally {
      setLogoUploading(false);
    }
  }, [formatMessage, onChanged, view]);

  const handleResetLogo = useCallback(async () => {
    if (!view) return;
    setLogoUploading(true);
    setError("");
    try {
      const { data } = await api.delete<McpAppView>(`/mcp/apps/${view.id}/logo`);
      setView(data);
      onChanged();
    } catch (resetError) {
      const message = (resetError as { response?: { data?: { error?: unknown } } })?.response?.data?.error;
      setError(typeof message === "string" && message ? message : formatMessage({ id: "settings.connectedApps.failedResetLogo" }));
    } finally {
      setLogoUploading(false);
    }
  }, [formatMessage, onChanged, view]);

  const logoControls = useMemo(() => (view && canManage
    ? { uploading: logoUploading, onUpload: (file: File) => { void handleUploadLogo(file); }, onReset: () => { void handleResetLogo(); } }
    : null), [canManage, handleResetLogo, handleUploadLogo, logoUploading, view]);

  const handleRefresh = useCallback(async () => {
    if (!view) return;
    setRefreshing(true);
    setError("");
    try {
      const { data } = await api.post<McpAppView>(`/mcp/apps/${view.id}/refresh`);
      // Health and the tool catalogue change; Profile, URL and header-name drafts being edited do not.
      setView(data);
      onChanged();
    } catch (refreshError) {
      setError(mcpAppErrorMessage(refreshError, formatMessage));
    } finally {
      setRefreshing(false);
    }
  }, [formatMessage, onChanged, view]);

  const sectionStatus = useMemo((): Record<McpAppSectionId, string> => {
    const saveFirst = formatMessage({ id: "settings.connectedApps.editor.status.saveAppFirst" });
    const serverStatus = (() => {
      if (view) {
        return formatMessage({ id: view.server.health.status === "reachable"
          ? "settings.mcpApp.server.healthReachable"
          : view.server.health.status === "unreachable"
            ? "settings.mcpApp.server.healthUnreachable"
            : "settings.mcpApp.server.healthUnknown" });
      }
      if (!probe) return formatMessage({ id: "settings.mcpApp.status.notValidated" });
      if (probe.outcome === "ready") return formatMessage({ id: "settings.connectedApps.mcp.toolCount" }, { count: probe.tools?.count ?? 0 });
      if (probe.outcome === "oauth") return formatMessage({ id: "settings.mcpApp.authKind.oauth" });
      if (probe.outcome === "headers") return formatMessage({ id: "settings.mcpApp.authKind.headers" });
      return formatMessage({ id: "settings.mcpApp.server.healthUnreachable" });
    })();
    return {
      profile: formatMessage({ id: profile.name.trim() && profile.description.trim()
        ? "settings.connectedApps.editor.status.complete"
        : "settings.connectedApps.editor.status.needsDetails" }),
      mcp_server: serverStatus,
      connections: !view
        ? saveFirst
        : view.server.authKind === "none"
          ? formatMessage({ id: "settings.mcpApp.status.noConnectionNeeded" })
          : formatMessage({ id: "settings.mcpApp.status.connectionCount" }, { count: view.connections.length }),
      agents: view ? formatMessage({ id: "settings.mcpApp.status.agentCount" }, { count: view.agentsSummary.total }) : saveFirst,
      distribution: formatMessage({ id: connectedAppDistributionStatus(view?.distribution.publishStatus ?? null) }),
      // Shown only once the App is saved (a new App's form stops before the Danger zone).
      danger: view ? formatMessage({ id: "settings.connectedApps.editor.dangerStatusRestricted" }) : saveFirst,
    };
  }, [formatMessage, probe, profile.description, profile.name, view]);

  const formSections = useMemo((): FormDialogSection[] => {
    // An existing App says which sections it has; a new one stops before Distribution and the Danger zone.
    const ids = view
      ? MCP_APP_SECTION_IDS.filter((id) => view.sections.includes(id))
      : MCP_APP_SECTION_IDS.filter((id) => id !== "distribution" && id !== "danger");
    return ids.map((id) => ({
      id: `connected-app-editor-${id}`,
      label: formatMessage({ id: SECTION_LABEL_ID[id] }),
    }));
  }, [formatMessage, view]);

  const title = view?.profile.name ?? (loadingView ? "" : formatMessage({ id: "settings.mcpApp.newApp" }));
  const readOnly = !canManage;
  const saveDisabled = saving || loadingView || isAppWhenToUseTooLong(profile.whenToUse) || (appId !== null && !view);
  const saveFirstNote = (
    <Banner intent="info" density="sm">{formatMessage({ id: "settings.mcpApp.saveFirst" })}</Banner>
  );

  return (
    <FormDialog
      narrow="sheet"
      testId="mcp-app-editor"
      bodyTestId="mcp-app-editor-content"
      navTestId="mcp-app-editor-rail"
      navLabel={formatMessage({ id: "settings.connectedApps.appEditorSectionsAriaLabel" })}
      sections={formSections}
      initialSectionId={initialSection ? `connected-app-editor-${initialSection}` : undefined}
      title={title}
      closeLabel={formatMessage({ id: "settings.connectedApps.closeAppForm" })}
      onClose={onClose}
      onSubmit={handleSave}
      notice={error ? <Banner intent="warning" density="sm" data-testid="mcp-app-error">{error}</Banner> : null}
      footer={(
        <>
          <Button type="button" variant="ghost" size="lg" onClick={onClose}>
            {formatMessage({ id: "settings.common.cancel" })}
          </Button>
          {canManage ? (
            <DialogCommit>{(inHead) => (
              <Button type="submit" disabled={saveDisabled} variant="accent" size={inHead ? "md" : "lg"} data-testid="mcp-app-save">
                {formatMessage({ id: saving ? "settings.common.saving" : view ? "settings.common.save" : "settings.connectedApps.addApp" })}
              </Button>
            )}</DialogCommit>
          ) : null}
        </>
      )}
    >
            {loadingView ? (
              <div className="py-4 text-callout text-foreground-muted">{formatMessage({ id: "common.loadingLabel" })}</div>
            ) : (
              <>
                <ConnectedAppEditorSection
                  sectionId="profile"
                  title={formatMessage({ id: SECTION_LABEL_ID.profile })}
                  status={sectionStatus.profile}
                >
                  <McpAppProfileSection
                    profile={profile}
                    onChange={handleProfileChange}
                    logoUrl={view?.profile.logoUrl ?? null}
                    seed={view?.id ?? "new-mcp-app"}
                    disabled={readOnly}
                    logo={logoControls}
                  />
                </ConnectedAppEditorSection>
                <ConnectedAppEditorSection
                  sectionId="mcp_server"
                  title={formatMessage({ id: SECTION_LABEL_ID.mcp_server })}
                  status={sectionStatus.mcp_server}
                >
                  {view ? (
                    <McpAppServerFacts
                      view={view}
                      endpointUrl={endpointUrl}
                      onEndpointUrlChange={setEndpointUrl}
                      headerNames={editHeaderNames}
                      onHeaderNamesChange={setEditHeaderNames}
                      canManage={canManage}
                      onRefresh={handleRefresh}
                      refreshing={refreshing}
                    />
                  ) : appId ? null : (
                    <McpAppServerCreate
                      onBrowseMarketplace={onBrowseMarketplace}
                      endpointUrl={endpointUrl}
                      onEndpointUrlChange={handleEndpointUrlChange}
                      onValidate={handleValidate}
                      probing={probing}
                      probe={probe}
                      probeError={probeError}
                      headerNames={headerNames}
                      onHeaderNamesChange={setHeaderNames}
                      useWithoutSignIn={useWithoutSignIn}
                      onUseWithoutSignInChange={setUseWithoutSignIn}
                    />
                  )}
                </ConnectedAppEditorSection>
                <ConnectedAppEditorSection
                  sectionId="connections"
                  title={formatMessage({ id: SECTION_LABEL_ID.connections })}
                  status={sectionStatus.connections}
                >
                  {view ? <McpAppConnectionsSection view={view} canManage={canManage} onReload={reloadView} /> : saveFirstNote}
                </ConnectedAppEditorSection>
                <ConnectedAppEditorSection
                  sectionId="agents"
                  title={formatMessage({ id: SECTION_LABEL_ID.agents })}
                  status={sectionStatus.agents}
                >
                  {view ? <McpAppAgentsSection view={view} /> : saveFirstNote}
                </ConnectedAppEditorSection>
                {/* Like an ordinary App's form, a new App's stops before Distribution and the Danger zone. */}
                {view ? (
                  <ConnectedAppEditorSection
                    sectionId="distribution"
                    title={formatMessage({ id: SECTION_LABEL_ID.distribution })}
                    status={sectionStatus.distribution}
                  >
                    {/* An ordinary private App's Distribution, with publishing not offered yet (follow-up). */}
                    <ConnectedAppEditorActionRow
                      testId="connected-app-publish-request-card"
                      title={formatMessage({ id: "settings.connectedApps.publishRequestTitle" })}
                      description={formatMessage({ id: "settings.mcpApp.distribution.publishUnavailable" })}
                      action={(
                        <Button type="button" disabled size="md">
                          {formatMessage({ id: "settings.connectedApps.requestPublish" })}
                        </Button>
                      )}
                    />
                  </ConnectedAppEditorSection>
                ) : null}
                {view ? (
                  <ConnectedAppEditorSection
                    sectionId="danger"
                    title={formatMessage({ id: SECTION_LABEL_ID.danger })}
                    description={formatMessage({ id: "settings.mcpApp.section.dangerDescription" })}
                    status={sectionStatus.danger}
                  >
                    {canManage && canDeleteSourceOwnedConnectedApp(view.distribution.publishStatus) ? (
                      <McpAppDangerZone view={view} onDeleted={handleDeleted} />
                    ) : null}
                  </ConnectedAppEditorSection>
                ) : null}
              </>
            )}
    </FormDialog>
  );
}
