import { Button, Card, Input, Switch } from "@botiverse/raft-ui";
import { SETTINGS_STACK_CARD_DESKTOP } from "../../../components/settings/settingsCardClasses";
import { useCallback, useEffect, useReducer } from "react";
import { Check, Copy, Globe } from "lucide-react";
import { getApiErrorResponse } from "../../../utils/apiErrorResponse";
import { PUBLIC_SERVER_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import { useServerStore } from "../../../store/serverStore";
import { useServerPermissions } from "../../../hooks/useServerPermissions";
import ConfirmDialog from "../../../components/ConfirmDialog";
import Banner from "../../../components/ui/Banner";
import api from "../../../api/client";
import { shareableWebOrigin } from "../../../utils/desktopShell";
import { useIntl } from "react-intl";
import SectionHeader from "../../../components/ui/SectionHeader";
import CopyButton from "../../../components/ui/CopyButton";
import { useServerFeatureFlag } from "../../../store/serverFeatureFlags";
import { publicVisibilityUiReducer } from "./publicVisibilityUiReducer";
import type { PublicVisibilityReadback } from "./publicVisibilityUiReducer";
import { PublicChannelList } from "./PublicChannelList";

const NO_PUBLIC_CHANNELS: PublicVisibilityReadback["exposedChannels"] = [];

export function PublicVisibilitySection() {
  const { formatMessage } = useIntl();
  const server = useServerStore((s) => s.current);
  const { role } = useServerPermissions();
  const publicServerEnabled = useServerFeatureFlag(PUBLIC_SERVER_FEATURE_FLAG_KEY).enabled;
  const [ui, dispatch] = useReducer(publicVisibilityUiReducer, {
    readback: null,
    loading: false,
    saving: false,
    error: "",
    confirmOpen: false,
  });
  const { readback, loading, saving, error, confirmOpen } = ui;

  useEffect(() => {
    if (!server?.id || role !== "owner" || !publicServerEnabled) return;
    let active = true;
    dispatch({ type: "load" });
    api.get<PublicVisibilityReadback>(`/servers/${server.id}/public-visibility`)
      .then(({ data }) => {
        if (active) dispatch({ type: "loaded", readback: data });
      })
      .catch((err: unknown) => {
        if (active) {
          const response = getApiErrorResponse(err);
          dispatch({ type: "failed", error: response?.error || formatMessage({ id: "settings.publicVisibility.failedLoad" }) });
        }
      });
    return () => {
      active = false;
    };
  }, [formatMessage, publicServerEnabled, role, server?.id]);

  const serverId = server?.id;
  const updateVisibility = useCallback(async (publiclyVisible: boolean) => {
    if (!serverId) return;
    dispatch({ type: "saving" });
    try {
      const { data } = await api.patch<{ publiclyVisible: boolean }>(`/servers/${serverId}/public-visibility`, { publiclyVisible });
      if (useServerStore.getState().current?.id !== serverId) return;
      dispatch({ type: "saved", publiclyVisible: data.publiclyVisible });
      // The server list carries publicPageLive (the globe on the server
      // avatar and on public channels). Members pick the change up on their
      // next list refresh; the owner who just flipped it should not wait.
      void useServerStore.getState().loadServers({ fresh: true });
    } catch (err: unknown) {
      if (useServerStore.getState().current?.id !== serverId) return;
      const response = getApiErrorResponse(err);
      dispatch({ type: "failed", error: response?.error || formatMessage({ id: "settings.publicVisibility.failedUpdate" }) });
      throw err;
    }
  }, [formatMessage, serverId]);

  const updateSearch = useCallback(async (publicSearchEnabled: boolean) => {
    if (!serverId) return;
    dispatch({ type: "saving" });
    try {
      const { data } = await api.patch<{ publicSearchEnabled: boolean }>(
        `/servers/${serverId}/public-search`,
        { publicSearchEnabled },
      );
      if (useServerStore.getState().current?.id !== serverId) return;
      dispatch({ type: "searchSaved", publicSearchEnabled: data.publicSearchEnabled });
    } catch (err: unknown) {
      if (useServerStore.getState().current?.id !== serverId) return;
      const response = getApiErrorResponse(err);
      dispatch({ type: "failed", error: response?.error || formatMessage({ id: "settings.publicVisibility.failedSearchUpdate" }) });
      throw err;
    }
  }, [formatMessage, serverId]);

  const handleSearchCheckedChange = useCallback((checked: boolean) => {
    void updateSearch(checked).catch(() => {});
  }, [updateSearch]);

  const handleVisibilityCheckedChange = useCallback((checked: boolean) => {
    if (checked) dispatch({ type: "confirm", open: true });
    else void updateVisibility(false).catch(() => {});
  }, [updateVisibility]);

  const handleCopyUrlError = useCallback(() => dispatch({
    type: "failed",
    error: formatMessage({ id: "settings.publicVisibility.failedCopyUrl" }),
  }), [formatMessage]);

  const handleConfirmPublic = useCallback(() => updateVisibility(true), [updateVisibility]);
  const handleCloseConfirm = useCallback(() => dispatch({ type: "confirm", open: false }), []);

  if (!server || role !== "owner" || !publicServerEnabled) return null;

  const channels = readback?.exposedChannels ?? NO_PUBLIC_CHANNELS;
  const publicUrl = readback?.publiclyVisible
    ? `${shareableWebOrigin()}/s/${readback.slug}`
    : "";

  return (
    <div className="mb-6" data-testid="public-visibility-section">
      <SectionHeader
        className="mb-3"
        icon={<Globe size={16} />}
        label={formatMessage({ id: "settings.publicVisibility.sectionLabel" })}
      />
      {/* Two levels (cindyz, #wg-rbac task #127): "Make this server public"
          with its link and, under it, the settings that only apply to a
          public server; then, after a divider, the channel list, which is
          about the whole public server and sits at the first level. The
          Guest-join setting is gone: a Guest now belongs to one channel and
          is never made from the public page (#wg-rbac:#15). */}
      <Card className={`stack-y-4 p-4 ${SETTINGS_STACK_CARD_DESKTOP}`}>
        <div id="public-access" className="stack-y-4 md:pointer-fine:stack-y-3" data-testid="public-visibility-primary">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <h3 id="public-visibility-label" className="text-subhead font-semibold text-foreground">
              {formatMessage({ id: "settings.publicVisibility.title" })}
            </h3>
            <p className="mt-1 text-footnote text-foreground-muted">
              {formatMessage({ id: "settings.publicVisibility.description" })}
            </p>
          </div>
          <Switch
            checked={readback?.publiclyVisible === true}
            disabled={loading || saving || !readback}
            onCheckedChange={handleVisibilityCheckedChange}
            aria-labelledby="public-visibility-label"
            data-testid="public-visibility-switch"
          />
        </div>

        {publicUrl ? (
          <div data-testid="public-visibility-url">
            <label
              htmlFor="public-visibility-url-input"
              className="mb-1.5 block text-footnote font-semibold text-foreground"
            >
              {formatMessage({ id: "settings.publicVisibility.publicUrl" })}
            </label>
            <div className="flex gap-2">
              <Input
                id="public-visibility-url-input"
                className="min-w-0 flex-1"
                type="url"
                value={publicUrl}
                readOnly
              />
              <CopyButton
                text={publicUrl}
                resetKey={publicUrl}
                onCopyError={handleCopyUrlError}
              >
                {({ copied, disabled, onClick, onMouseDown }) => (
                  <Button
                    size="lg"
                    
                    variant="outline"
                    className="shrink-0"
                    disabled={disabled}
                    onMouseDown={onMouseDown}
                    onClick={onClick}
                    data-testid="public-visibility-copy-url"
                  >
                    {copied ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
                    {formatMessage({
                      id: copied
                        ? "settings.publicVisibility.copiedUrl"
                        : "settings.publicVisibility.copyUrl",
                    })}
                  </Button>
                )}
              </CopyButton>
            </div>
          </div>
        ) : null}

        {/* Public server SEO: also second level. It never makes anything
            readable; it only decides whether public content may be indexed. */}
        <div className="ml-1 flex items-center justify-between gap-4 border-l border-line-hairline pl-4" data-testid="public-search-setting">
          <div className="min-w-0">
            <h3 id="public-search-label" className="text-subhead font-semibold text-foreground">
              {formatMessage({ id: "settings.publicVisibility.allowSearch" })}
            </h3>
            <p className="mt-1 text-footnote text-foreground-muted">
              {formatMessage({ id: "settings.publicVisibility.allowSearchDescription" })}
            </p>
          </div>
          <Switch
            checked={readback?.publiclyVisible === true && readback.publicSearchEnabled}
            disabled={loading || saving || !readback || !readback.publiclyVisible}
            onCheckedChange={handleSearchCheckedChange}
            aria-labelledby="public-search-label"
            data-testid="public-search-switch"
          />
        </div>
        </div>

        <div className="border-t border-line-hairline pt-4" data-testid="public-visibility-channels">
          <h3 className="mb-2 text-subhead font-semibold text-foreground">
            {formatMessage({ id: "settings.publicVisibility.channelListLabel" })}
          </h3>
          {loading ? (
            <div className="h-16 animate-pulse rounded-container bg-fill-muted" data-testid="public-visibility-loading" />
          ) : <PublicChannelList channels={channels} />}
        </div>

        {error ? <Banner intent="warning" density="sm">{error}</Banner> : null}
      </Card>

      {confirmOpen ? (
        <ConfirmDialog
          title={formatMessage({ id: "settings.publicVisibility.confirmTitle" })}
          message={(
            <div className="stack-y-4 md:pointer-fine:stack-y-3">
              <p className="text-callout text-foreground">
                {formatMessage({ id: "settings.publicVisibility.confirmDescription" })}
              </p>
              <PublicChannelList channels={channels} />
              <p className="text-footnote text-foreground-muted">
                {formatMessage({ id: "settings.publicVisibility.confirmAudienceChange" })}
              </p>
            </div>
          )}
          confirmLabel={formatMessage({ id: "settings.publicVisibility.confirmAction" })}
          loadingLabel={formatMessage({ id: "settings.publicVisibility.confirmSaving" })}
          confirmVariant="accent"
          confirmTestId="public-visibility-confirm-button"
          plainMessage
          maxWidthClass="max-w-lg"
          chromeLocale="active"
          onConfirm={handleConfirmPublic}
          onClose={handleCloseConfirm}
        />
      ) : null}
    </div>
  );
}
