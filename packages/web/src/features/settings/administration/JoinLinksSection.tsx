import { Button, Input, ListRow, ListRowBody, ListRowDescription, ListRowGroup } from "@botiverse/raft-ui";
import { useCallback, useState, useEffect } from "react";
import type { ChangeEvent, FormEvent } from "react";
import { Plus, Link } from "lucide-react";
import { useServerStore } from "../../../store/serverStore";
import { useServerPermissions } from "../../../hooks/useServerPermissions";
import { useTimeFormatter } from "../../../hooks/useTimeFormatter";
import ConfirmDialog from "../../../components/ConfirmDialog";
import Banner from "../../../components/ui/Banner";
import api from "../../../api/client";
import { trackFeature } from "../../../analytics/features";
import { useIntl } from "react-intl";
import SectionHeader from "../../../components/ui/SectionHeader";
import FormField from "../../../components/ui/FormField";
import { JoinLinkRow } from "../../../components/settings/JoinLinkRow";
import type { JoinLinkRecord } from "../shared/inviteRecords";
import { buildJoinLinkUrl } from "./buildJoinLinkUrl";

export function JoinLinksSection() {
  const { formatMessage } = useIntl();
  const current = useServerStore((s) => s.current);
  const serverId = current?.id;
  const { capabilities } = useServerPermissions();
  const { formatShortDateTime } = useTimeFormatter();

  const [links, setLinks] = useState<JoinLinkRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");
  const [copiedLinkId, setCopiedLinkId] = useState<string | null>(null);
  const [maxUses, setMaxUses] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [revokeTarget, setRevokeTarget] = useState<JoinLinkRecord | null>(null);

  const canManageLinks = capabilities.inviteMembers;

  const loadLinks = useCallback(async () => {
    if (!serverId) return;
    setLoading(true);
    try {
      const { data } = await api.get(`/servers/${serverId}/join-links`);
      setLinks(data);
    } catch {
      // Ignore
    } finally {
      setLoading(false);
    }
  }, [serverId]);

  // Reload when the active server id (via `loadLinks`) or permission changes.
  useEffect(() => {
    if (serverId && canManageLinks) {
      void loadLinks();
    }
  }, [canManageLinks, loadLinks, serverId]);

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    if (!current) return;
    setCreating(true);
    setCreateError("");
    try {
      const { data } = await api.post(`/servers/${current.id}/join-links`, {
        maxUses: maxUses ? Number(maxUses) : null,
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
      });
      setLinks((prev) => [data.link, ...prev]);
    } catch (err: any) {
      setCreateError(err.response?.data?.error || formatMessage({ id: "settings.joinLinks.failedCreate" }));
    } finally {
      setCreating(false);
    }
  };

  const handleCopy = useCallback(async (linkId: string, token: string) => {
    await navigator.clipboard.writeText(buildJoinLinkUrl(token));
    trackFeature("invite", "submit", { surface: "settings", variant: "link" });
    setCopiedLinkId(linkId);
    window.setTimeout(() => setCopiedLinkId((current) => current === linkId ? null : current), 1500);
  }, []);

  const handleRevoke = useCallback(async (linkId: string) => {
    if (!serverId) return;
    try {
      await api.delete(`/servers/${serverId}/join-links/${linkId}`);
      setLinks((prev) => prev.filter((link) => link.id !== linkId));
    } catch {
      // Ignore
    }
  }, [serverId]);

  const handleConfirmRevoke = useCallback(
    () => (revokeTarget ? handleRevoke(revokeTarget.id) : undefined),
    [handleRevoke, revokeTarget],
  );
  const handleCloseRevoke = useCallback(() => setRevokeTarget(null), []);
  const handleMaxUsesChange = useCallback((e: ChangeEvent<HTMLInputElement>) => setMaxUses(e.target.value), []);
  const handleExpiresAtChange = useCallback((e: ChangeEvent<HTMLInputElement>) => setExpiresAt(e.target.value), []);

  if (!canManageLinks) return null;

  return (
    <div id="invite-links" className="mb-6">
      <SectionHeader
        className="mb-3"
        icon={<Link size={16} />}
        label={formatMessage({ id: "settings.joinLinks.sectionLabel" })}
        count={links.length > 0 ? links.length : null}
      />

      {/* One ListRowGroup (DS Forms › A setting's row; cindyz, #proj-raft-ui:#220): the
          new link's fields are the first row (side by side from 32rem of the group's own
          width), then a row per active link. */}
      <ListRowGroup className="@container" data-testid="join-links-rows">
        <ListRow variant="plain" interactive={false}>
          <ListRowBody render={<div />}>
            <form onSubmit={handleCreate} className="stack-y-3">
              <div className="grid gap-3 @lg:grid-cols-2">
                <FormField label={formatMessage({ id: "settings.joinLinks.maxUses" })} size="compact" htmlFor="join-link-max-uses">
                  <Input
                    id="join-link-max-uses"
                    type="number"
                    min="1"
                    value={maxUses}
                    onChange={handleMaxUsesChange}
                    placeholder={formatMessage({ id: "settings.joinLinks.unlimited" })}
                    className="w-full"
                  />
                </FormField>

                <FormField label={formatMessage({ id: "settings.joinLinks.expiresAt" })} size="compact" htmlFor="join-link-expires-at">
                  <Input
                    id="join-link-expires-at"
                    type="datetime-local"
                    value={expiresAt}
                    onChange={handleExpiresAtChange}
                    className="w-full"
                  />
                </FormField>
              </div>

              {createError && (
                <Banner intent="warning" density="sm">
                  {createError}
                </Banner>
              )}

              <Button
                variant="outline" size="md"
                type="submit"
                disabled={creating}
              >
                <Plus size={14} />
                {creating ? formatMessage({ id: "settings.joinLinks.creating" }) : formatMessage({ id: "settings.joinLinks.createLink" })}
              </Button>
            </form>
          </ListRowBody>
        </ListRow>
        {links.length > 0 ? (
          links.map((link) => (
            <JoinLinkRow
              key={link.id}
              link={link}
              copied={copiedLinkId === link.id}
              formatShortDateTime={formatShortDateTime}
              onCopy={handleCopy}
              onRequestRevoke={setRevokeTarget}
            />
          ))
        ) : !loading ? (
          <ListRow variant="plain" interactive={false}>
            <ListRowBody>
              <ListRowDescription wrap>{formatMessage({ id: "settings.joinLinks.emptyState" })}</ListRowDescription>
            </ListRowBody>
          </ListRow>
        ) : null}
      </ListRowGroup>

      {revokeTarget && (
        <ConfirmDialog
          chromeLocale="active"
          title={formatMessage({ id: "settings.joinLinks.confirmTitle" })}
          message={formatMessage({ id: "settings.joinLinks.confirmMessage" })}
          confirmLabel={formatMessage({ id: "settings.joinLinks.confirmLabel" })}
          loadingLabel={formatMessage({ id: "settings.joinLinks.revoking" })}
          onConfirm={handleConfirmRevoke}
          onClose={handleCloseRevoke}
        />
      )}
    </div>
  );
}
