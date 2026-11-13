import { Button, Input } from "@botiverse/raft-ui";
import Tooltip from "../../../components/ui/Tooltip";
import { useCallback, useState, useEffect } from "react";
import type { ChangeEvent, FormEvent } from "react";
import { Check, Building2 } from "lucide-react";
import { useServerStore } from "../../../store/serverStore";
import { useServerPermissions } from "../../../hooks/useServerPermissions";
import Banner from "../../../components/ui/Banner";
import { useIntl } from "react-intl";
import { avatarUploadApiErrorMessage, isAvatarFileTooLarge, isAvatarTooLargeError, PROFILE_AVATAR_ACCEPT } from "../../../utils/avatarUpload";
import SectionHeader from "../../../components/ui/SectionHeader";
import FormField from "../../../components/ui/FormField";
import AvatarSlot from "../../../components/ui/AvatarSlot";
import AvatarEditVeil from "../../../components/ui/AvatarEditVeil";
import SlugInput from "../../../components/ui/SlugInput";
import SettingsProfileCard from "../../../components/settings/SettingsProfileCard";

export function ProfileSection() {
  const { formatMessage } = useIntl();
  const server = useServerStore((s) => s.current);
  const updateServerProfile = useServerStore((s) => s.updateServerProfile);
  const uploadServerAvatar = useServerStore((s) => s.uploadServerAvatar);
  const { capabilities } = useServerPermissions();
  const canEdit = capabilities.editServerSettings;

  const [name, setName] = useState(server?.name ?? "");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [avatarSaving, setAvatarSaving] = useState(false);
  const [avatarError, setAvatarError] = useState("");

  useEffect(() => {
    setName(server?.name ?? "");
  }, [server?.id, server?.name]);

  const handleNameChange = useCallback((e: ChangeEvent<HTMLInputElement>) => setName(e.target.value), []);

  if (!server) return null;

  const serverInitial = (server.name || "S").trim().charAt(0).toUpperCase() || "S";
  const dirty =
    name.trim().length > 0
    && name.trim() !== server.name;

  const handleUploadAvatar = async (file: File) => {
    if (isAvatarFileTooLarge(file)) {
      setAvatarError(formatMessage({ id: "avatar.tooLarge" }, { maxLabel: formatMessage({ id: "common.fileSize.maxLabel5mb" }) }));
      return;
    }
    setAvatarError("");
    setAvatarSaving(true);
    try {
      await uploadServerAvatar(file);
    } catch (err: any) {
      setAvatarError(isAvatarTooLargeError(err)
        ? formatMessage({ id: "avatar.tooLarge" }, { maxLabel: formatMessage({ id: "common.fileSize.maxLabel5mb" }) })
        : avatarUploadApiErrorMessage(err, formatMessage({ id: "settings.serverProfile.failedUploadAvatar" })));
    } finally {
      setAvatarSaving(false);
    }
  };

  const handleSave = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setSaved(false);
    setSaving(true);
    try {
      await updateServerProfile({
        name: name.trim(),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err: any) {
      setError(err.response?.data?.error || formatMessage({ id: "settings.serverProfile.failedUpdate" }));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mb-6">
      <SectionHeader
        className="mb-3"
        icon={<Building2 size={16} />}
        label={formatMessage({ id: "settings.serverProfile.sectionLabel" })}
      />

      <SettingsProfileCard
        testId="server-profile-card"
        title={server.name}
        subtitle={`/${server.slug}`}
        avatar={
          canEdit ? (
            <Tooltip content={avatarSaving ? formatMessage({ id: "settings.common.uploadingAvatar" }) : formatMessage({ id: "settings.common.uploadImage" })}>
            <label
              className={`group/avatar-edit relative flex shrink-0 rounded-sticker has-[:focus-visible]:shadow-focus ${avatarSaving ? "cursor-not-allowed opacity-70" : ""}`}
            >
              <input
                type="file"
                accept={PROFILE_AVATAR_ACCEPT}
                className="peer/avatar-edit sr-only"
                aria-label={avatarSaving ? formatMessage({ id: "settings.common.uploadingAvatar" }) : formatMessage({ id: "settings.common.uploadImage" })}
                disabled={avatarSaving}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.currentTarget.value = "";
                  if (file) void handleUploadAvatar(file);
                }}
              />
              <AvatarSlot context="profile-tile" type="server" serverAvatarUrl={server.avatarUrl} serverInitial={serverInitial} />
              <AvatarEditVeil busy={avatarSaving} />
            </label>
            </Tooltip>
          ) : (
            <AvatarSlot context="profile-tile" type="server" serverAvatarUrl={server.avatarUrl} serverInitial={serverInitial} />
          )
        }
      >
        {avatarError ? (
          <p className="text-caption text-danger-strong" role="alert">{avatarError}</p>
        ) : null}
        <form onSubmit={handleSave} className="stack-y-3">
          <FormField id="server-name" label={formatMessage({ id: "settings.serverProfile.nameLabel" })} size="compact">
            {canEdit ? (
              <Input
                data-testid="server-profile-name-input"
                type="text"
                value={name}
                onChange={handleNameChange}
                maxLength={100}
                className="w-full"
              />
            ) : (
              <div
                data-testid="server-profile-name-readonly"
                className="flex min-h-control w-full items-center rounded-(--control-radius) border border-line-hairline bg-fill-muted px-3 text-body text-foreground-muted"
              >
                {server.name}
              </div>
            )}
          </FormField>

          <FormField label={formatMessage({ id: "settings.serverProfile.slugLabel" })} size="compact">
            <SlugInput
              type="text"
              value={server.slug}
              readOnly
              aria-readonly="true"
              tabIndex={-1}
              className="border-line-hairline bg-fill-muted shadow-none focus-within:shadow-none"
              inputClassName="cursor-default text-foreground-muted"
            />
          </FormField>

          {error && (
            <Banner intent="warning" density="sm">{error}</Banner>
          )}

          {canEdit && (
            <Button
              variant="accent" size="md"
              data-testid="server-profile-save-button"
              data-save-state={saving ? "saving" : saved ? "saved" : dirty ? "dirty" : "pristine"}
              type="submit"
              disabled={!dirty || saving}
              className="flex items-center gap-1.5"
            >
              {saving ? formatMessage({ id: "settings.common.saving" }) : saved ? (
                <><Check size={14} /> {formatMessage({ id: "settings.common.saved" })}</>
              ) : formatMessage({ id: "settings.serverProfile.saveProfile" })}
            </Button>
          )}
        </form>
      </SettingsProfileCard>
    </div>
  );
}
