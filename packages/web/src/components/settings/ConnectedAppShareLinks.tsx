/**
 * The private share links of one App in its editor (#proj-apps:769a57d4).
 *
 * A link installs the App once, on the one Server its creator names by slug,
 * for an owner or admin of that Server. Raft never says whether the slug names
 * a Server, so this lists each link by the slug as it was typed, never by a
 * resolved name. One link per target: a new link for the same slug replaces
 * the old one. The URL is shown once, right after it is created.
 */
import { useCallback, useEffect, useEffectEvent, useId, useRef, useState } from "react";
import type { ChangeEvent, KeyboardEvent } from "react";
import { useIntl } from "react-intl";
import { Check, Copy } from "lucide-react";
import { buildIntegrationInviteUrl, validateServerSlugReferenceReason } from "@botiverse/raft-shared";
import {
  Button,
  Input,
  ListRow,
  ListRowBody,
  ListRowDescription,
  ListRowGroup,
  ListRowTitle,
} from "@botiverse/raft-ui";
import api from "../../api/client";
import { shareableWebOrigin } from "../../utils/desktopShell";
import FormField from "../ui/FormField";

export interface ConnectedAppShareLink {
  id: string;
  clientId: string;
  /** The target Server's slug as it was typed; never a resolved name. */
  targetServerSlug: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  consumedAt?: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** The slug as the server stores it (trimmed, lowercased), or null when it is not slug-shaped. */
export function normalizeShareTargetSlug(raw: string): string | null {
  const slug = raw.trim().toLowerCase();
  return validateServerSlugReferenceReason(slug) ? null : slug;
}

function errorMessage(err: unknown): string | undefined {
  const response = (err as { response?: { data?: { error?: unknown } } } | null)?.response;
  return typeof response?.data?.error === "string" ? response.data.error : undefined;
}

function errorStatus(err: unknown): number | undefined {
  return (err as { response?: { status?: number } } | null)?.response?.status;
}

function ShareLinkRow({
  link,
  disabled,
  onRevoke,
}: {
  link: ConnectedAppShareLink;
  disabled: boolean;
  onRevoke: (link: ConnectedAppShareLink) => Promise<void>;
}) {
  const { formatDate, formatMessage } = useIntl();
  const handleRevoke = useCallback(() => {
    void onRevoke(link);
  }, [link, onRevoke]);
  const slug = link.targetServerSlug ?? "";
  return (
    // Display-only row: its Revoke button is the one target.
    <ListRow variant="plain" interactive={false} data-testid="connected-app-share-link-row">
      <ListRowBody>
        <ListRowTitle>{slug}</ListRowTitle>
        <ListRowDescription>
          {formatMessage(
            { id: "settings.connectedApps.shareLinkExpires" },
            { when: link.expiresAt ? formatDate(link.expiresAt) : formatMessage({ id: "settings.connectedApps.never" }) },
          )}
        </ListRowDescription>
      </ListRowBody>
      <Button
        type="button"
        variant="ghost"
        size="md"
        onClick={handleRevoke}
        disabled={disabled}
        aria-label={formatMessage({ id: "settings.connectedApps.revokeShareLinkAria" }, { slug })}
      >
        {formatMessage({ id: "settings.connectedApps.revoke" })}
      </Button>
    </ListRow>
  );
}

export function ConnectedAppShareLinks<TClient>({
  clientId,
  onClientUpdated,
  onError,
}: {
  clientId: string;
  /** Creating the first link turns a server-local App into a privately shared one. */
  onClientUpdated: (client: TClient) => void;
  /** The editor's error line; "" clears it. */
  onError: (message: string) => void;
}) {
  const { formatMessage } = useIntl();
  const inputId = useId();
  const [links, setLinks] = useState<ConnectedAppShareLink[]>([]);
  const [targetSlug, setTargetSlug] = useState("");
  const [targetError, setTargetError] = useState("");
  const [saving, setSaving] = useState(false);
  const [created, setCreated] = useState<{ linkId: string; slug: string; url: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const copyResetRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (copyResetRef.current) window.clearTimeout(copyResetRef.current);
  }, []);

  // Effect Event: reloads only when the App changes, reading the current callbacks.
  const loadLinks = useEffectEvent(async () => {
    try {
      const { data } = await api.get(`/integrations/clients/${clientId}/share-links`);
      setLinks(Array.isArray(data?.links) ? data.links : []);
    } catch (err: unknown) {
      if (errorStatus(err) !== 404) {
        onError(errorMessage(err) || formatMessage({ id: "settings.connectedApps.failedLoadShare" }));
      }
    }
  });

  useEffect(() => {
    void loadLinks();
  }, [clientId]);

  const handleTargetChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setTargetSlug(event.target.value);
    setTargetError("");
  }, []);

  const handleCreate = useCallback(async () => {
    if (saving) return;
    const slug = normalizeShareTargetSlug(targetSlug);
    if (!slug) {
      setTargetError(formatMessage({ id: "settings.connectedApps.shareTargetInvalid" }));
      return;
    }
    setSaving(true);
    onError("");
    try {
      const { data } = await api.post(`/integrations/clients/${clientId}/share-links`, { targetServerSlug: slug });
      const link = data.link as ConnectedAppShareLink;
      onClientUpdated(data.client as TClient);
      // The new link replaces this target's previous one.
      setLinks((current) => [link, ...current.filter((item) => item.targetServerSlug !== link.targetServerSlug)]);
      setCreated({ linkId: link.id, slug: link.targetServerSlug ?? slug, url: buildIntegrationInviteUrl(shareableWebOrigin(), data.token) });
      setCopied(false);
      setTargetSlug("");
    } catch (err: unknown) {
      onError(errorMessage(err) || formatMessage({ id: "settings.connectedApps.failedCreateShare" }));
    } finally {
      setSaving(false);
    }
  }, [clientId, formatMessage, onClientUpdated, onError, saving, targetSlug]);

  const handleCreateClick = useCallback(() => { void handleCreate(); }, [handleCreate]);
  const handleTargetKeyDown = useCallback((event: KeyboardEvent<HTMLInputElement>) => {
    // Safari sends the Enter that confirms CJK input with isComposing false and keyCode 229.
    if (event.key !== "Enter" || event.nativeEvent.isComposing || event.keyCode === 229) return;
    // This input lives inside the App editor form. Enter creates the link
    // instead of submitting and closing the whole editor.
    event.preventDefault();
    event.stopPropagation();
    void handleCreate();
  }, [handleCreate]);

  const handleRevoke = useCallback(async (link: ConnectedAppShareLink) => {
    setSaving(true);
    onError("");
    try {
      await api.delete(`/integrations/clients/${clientId}/share-links/${link.id}`);
      setLinks((current) => current.filter((item) => item.id !== link.id));
      setCreated((current) => (current?.linkId === link.id ? null : current));
    } catch (err: unknown) {
      onError(errorMessage(err) || formatMessage({ id: "settings.connectedApps.failedRevokeShare" }));
    } finally {
      setSaving(false);
    }
  }, [clientId, formatMessage, onError]);

  const handleCopy = useCallback(async () => {
    if (!created) return;
    onError("");
    try {
      await navigator.clipboard.writeText(created.url);
      setCopied(true);
      if (copyResetRef.current) window.clearTimeout(copyResetRef.current);
      copyResetRef.current = window.setTimeout(() => {
        setCopied(false);
        copyResetRef.current = null;
      }, 1500);
    } catch (err: unknown) {
      onError((err instanceof Error && err.message) || formatMessage({ id: "settings.connectedApps.failedCopyShare" }));
    }
  }, [created, formatMessage, onError]);

  const handleCopyClick = useCallback(() => {
    void handleCopy();
  }, [handleCopy]);

  return (
    <div className="flex flex-col gap-3" data-testid="connected-app-share-links">
      <div>
        <FormField
          label={formatMessage({ id: "settings.connectedApps.shareTargetLabel" })}
          hint={formatMessage({ id: "settings.connectedApps.shareTargetHint" })}
          error={targetError || undefined}
          htmlFor={inputId}
          size="compact"
        >
          <div className="flex gap-2">
            <Input
              id={inputId}
              type="text"
              value={targetSlug}
              onChange={handleTargetChange}
              onKeyDown={handleTargetKeyDown}
              placeholder={formatMessage({ id: "settings.connectedApps.shareTargetPlaceholder" })}
              className="min-w-0 flex-1 font-mono"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              aria-required="true"
              data-testid="connected-app-share-target-input"
            />
            <Button
              type="button"
              size="lg"
              onClick={handleCreateClick}
              disabled={saving || !targetSlug.trim()}
              data-testid="connected-app-share-create-button"
            >
              {saving ? formatMessage({ id: "settings.connectedApps.working" }) : formatMessage({ id: "settings.connectedApps.createLink" })}
            </Button>
          </div>
        </FormField>
      </div>
      {created ? (
        <div className="flex flex-col gap-2" data-testid="connected-app-share-created">
          <div className="text-footnote text-foreground-muted">
            {formatMessage({ id: "settings.connectedApps.shareLinkCreatedFor" }, { slug: created.slug })}
          </div>
          <div className="flex gap-2">
            <Input
              type="text"
              readOnly
              value={created.url}
              className="min-w-0 flex-1 font-mono"
              aria-label={formatMessage({ id: "settings.connectedApps.privateShareUrlAria" })}
            />
            <Button type="button" size="lg" onClick={handleCopyClick}>
              {copied ? <Check size={18} /> : <Copy size={18} />}
              {copied ? formatMessage({ id: "settings.connectedApps.copied" }) : formatMessage({ id: "settings.connectedApps.copy" })}
            </Button>
          </div>
        </div>
      ) : null}
      {links.length > 0 ? (
        <ListRowGroup data-testid="connected-app-share-link-list">
          {links.map((link) => (
            <ShareLinkRow key={link.id} link={link} disabled={saving} onRevoke={handleRevoke} />
          ))}
        </ListRowGroup>
      ) : null}
    </div>
  );
}
