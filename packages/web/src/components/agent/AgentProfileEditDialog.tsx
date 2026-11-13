import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useIntl } from "react-intl";
import { Upload, X } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogBody,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Banner,
  Button,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  RadioGroup,
  RadioGroupItem,
  Text,
  Textarea,
} from "@botiverse/raft-ui";
import type { ServerRole } from "@botiverse/raft-shared";
import api from "../../api/client";
import { useAgentStore } from "../../store/agentStore";
import type { Agent } from "../../store/agentStore";
import { avatarUploadApiErrorMessage, isAvatarFileTooLarge, isAvatarTooLargeError, PROFILE_AVATAR_ACCEPT } from "../../utils/avatarUpload";
import type { MessageId } from "../../i18n/messages";
import AvatarSlot from "../ui/AvatarSlot";
import FormField from "../ui/FormField";
import Tooltip from "../ui/Tooltip";
import { DialogActions, DialogCommit, NarrowDialogContent } from "../ui/NarrowDialog";
import type { DialogNarrow } from "../ui/NarrowDialog";
import { AVATAR_SERIES, DEFAULT_AVATAR_KEY, isCustomAvatar, parsePixelAvatar } from "./PixelAvatar";

export type AgentProfileEditField = "displayName" | "description" | "role" | "avatar";
type EditableRole = Extract<ServerRole, "admin" | "member">;

export const MAX_AGENT_DESCRIPTION_LENGTH = 3000;

const TITLE_ID = {
  displayName: "agent.detail.editDisplayName",
  description: "agent.detail.editDescription",
  role: "agent.detail.editRole",
  avatar: "agent.detail.chooseAvatar",
} as const satisfies Record<AgentProfileEditField, MessageId>;

/** On a phone (NarrowDialog): the avatar grid is the sheet; a name, a
 *  description or a role is the centred card (it moves up with the keyboard). */
function narrowFor(field: AgentProfileEditField): DialogNarrow {
  return field === "avatar" ? "sheet" : "centered";
}

/** Heading of each avatar series in the picker, by pixelAvatars.json series key. */
const AVATAR_SERIES_TITLE_ID: Record<string, MessageId> = {
  bots: "agent.avatar.series.bots",
  critters: "agent.avatar.series.critters",
  space: "agent.avatar.series.space",
  desk: "agent.avatar.series.desk",
  food: "agent.avatar.series.food",
  quest: "agent.avatar.series.quest",
  weather: "agent.avatar.series.weather",
  plants: "agent.avatar.series.plants",
  spooky: "agent.avatar.series.spooky",
};

/** Avatar choice staged in the dialog; nothing is sent until Save. */
type AvatarDraft =
  | { kind: "unchanged" }
  | { kind: "preset"; key: string }
  | { kind: "default" }
  | { kind: "upload"; file: File; previewUrl: string };

export type AgentProfileEditDialogProps = {
  agent: Agent;
  open: boolean;
  /** The one field this dialog edits (the one whose pencil was clicked). */
  field: AgentProfileEditField;
  onClose: () => void;
  /** Role options the viewer may assign; empty = role is not editable here. */
  roleOptions: { id: EditableRole; label: string }[];
};

/**
 * Edits one profile field (name, description, role or avatar) in a dialog. The
 * change is staged and applied only on Save; closing with unsaved changes asks
 * first. Saved values go through the agent store, which every surface
 * (profile header, info, top bar, lists) reads, so nothing is left stale.
 */
export default function AgentProfileEditDialog({ agent, open, field, onClose, roleOptions }: AgentProfileEditDialogProps) {
  const { formatMessage } = useIntl();
  const updateAgent = useAgentStore((s) => s.updateAgent);
  const ids = { name: useId(), description: useId(), role: useId(), avatar: useId(), title: useId() };
  const currentRole: EditableRole | null = agent.serverRole === "admin" || agent.serverRole === "member" ? agent.serverRole : null;
  const canEditRole = currentRole !== null && roleOptions.length > 0;

  const [displayName, setDisplayName] = useState(agent.displayName || "");
  const [description, setDescription] = useState(agent.description || "");
  const [role, setRole] = useState<EditableRole | null>(currentRole);
  const [avatar, setAvatar] = useState<AvatarDraft>({ kind: "unchanged" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // The dialog is mounted per opening, so the initial state above is always the
  // store's current values (the single source of truth). A staged upload's
  // preview URL is released when replaced and when the dialog unmounts.
  const previewUrlRef = useRef<string | null>(null);
  useEffect(() => () => {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
  }, []);
  const stageAvatar = (next: AvatarDraft) => {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    previewUrlRef.current = next.kind === "upload" ? next.previewUrl : null;
    setAvatar(next);
  };

  const trimmedName = displayName.trim();
  const trimmedDescription = description.trim();
  // Only the field this dialog edits can change.
  const nameChanged = field === "displayName" && trimmedName !== (agent.displayName || "");
  const descriptionChanged = field === "description" && trimmedDescription !== (agent.description || "");
  const roleChanged = field === "role" && canEditRole && role !== currentRole;
  const avatarChanged = field === "avatar" && avatar.kind !== "unchanged";
  const dirty = nameChanged || descriptionChanged || roleChanged || avatarChanged;
  const descriptionTooLong = field === "description" && trimmedDescription.length > MAX_AGENT_DESCRIPTION_LENGTH;

  const requestClose = useCallback(() => {
    if (saving) return;
    if (dirty) setConfirmDiscard(true);
    else onClose();
  }, [saving, dirty, onClose]);

  const handleDialogOpenChange = useCallback((next: boolean) => {
    if (!next) requestClose();
  }, [requestClose]);

  const handleDisplayNameChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setDisplayName(e.target.value.replace(/[\r\n]+/g, " "));
  }, []);

  const handleDescriptionChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setDescription(e.target.value);
  }, []);

  const handleRoleChange = useCallback((next: string) => {
    if (next === "admin" || next === "member") setRole(next);
  }, []);

  const handleConfirmDiscardChange = useCallback((next: boolean) => {
    if (!next) setConfirmDiscard(false);
  }, []);

  const handleDiscardClick = useCallback(() => {
    setConfirmDiscard(false);
    onClose();
  }, [onClose]);

  const previewAvatarUrl = useMemo(() => {
    if (avatar.kind === "preset") return `pixel:${avatar.key}`;
    if (avatar.kind === "default") return null;
    if (avatar.kind === "upload") return avatar.previewUrl;
    return agent.avatarUrl ?? null;
  }, [avatar, agent.avatarUrl]);
  const selectedPreset = avatar.kind === "preset"
    ? avatar.key
    : avatar.kind === "default"
      ? DEFAULT_AVATAR_KEY
      : avatar.kind === "unchanged" && !isCustomAvatar(agent.avatarUrl)
        ? (parsePixelAvatar(agent.avatarUrl ?? "") ?? DEFAULT_AVATAR_KEY)
        : null;

  const stageUpload = (file: File) => {
    if (isAvatarFileTooLarge(file)) {
      setError(formatMessage({ id: "avatar.tooLarge" }, { maxLabel: formatMessage({ id: "common.fileSize.maxLabel5mb" }) }));
      return;
    }
    setError("");
    stageAvatar({ kind: "upload", file, previewUrl: URL.createObjectURL(file) });
  };

  const save = useCallback(async () => {
    if (!dirty || descriptionTooLong) return;
    setSaving(true);
    setError("");
    try {
      if (avatar.kind === "upload") {
        const formData = new FormData();
        formData.append("avatar", avatar.file);
        const res = await api.post(`/agents/${agent.id}/avatar`, formData, {
          headers: { "Content-Type": "multipart/form-data" },
        });
        // The server stored the avatar; write its record into the shared store.
        useAgentStore.setState((state) => ({
          agents: state.agents.map((a) => (a.id === agent.id ? { ...a, ...res.data } : a)),
        }));
      }
      const fields: Parameters<typeof updateAgent>[1] = {};
      if (nameChanged) fields.displayName = trimmedName || null;
      if (descriptionChanged) fields.description = trimmedDescription || null;
      if (roleChanged && role) fields.serverRole = role;
      if (avatar.kind === "preset") fields.avatarUrl = `pixel:${avatar.key}`;
      if (avatar.kind === "default") fields.avatarUrl = null;
      if (Object.keys(fields).length > 0) await updateAgent(agent.id, fields);
      onClose();
    } catch (err: unknown) {
      if (avatar.kind === "upload" && isAvatarTooLargeError(err)) {
        setError(formatMessage({ id: "avatar.tooLarge" }, { maxLabel: formatMessage({ id: "common.fileSize.maxLabel5mb" }) }));
      } else if (avatar.kind === "upload") {
        setError(avatarUploadApiErrorMessage(err, formatMessage({ id: "agent.detail.uploadAvatarFailed" })));
      } else {
        const axiosErr = err as { response?: { data?: { error?: string } } };
        setError(axiosErr.response?.data?.error || formatMessage({ id: "agent.detail.editProfile.saveFailed" }));
      }
    } finally {
      setSaving(false);
    }
  }, [agent.id, avatar, descriptionChanged, descriptionTooLong, dirty, formatMessage, nameChanged, onClose, role, roleChanged, trimmedDescription, trimmedName, updateAgent]);

  const handleSaveClick = useCallback(() => {
    void save();
  }, [save]);

  // "You chose this" is yellow: the picked tile is a yellow sticker behind the
  // sprite, which keeps its own background. The upload tile is dashed until used.
  const presetButtonClass = (selected: boolean, upload = false) =>
    `flex size-11 items-center justify-center overflow-hidden rounded-control border-[1.5px] text-foreground-muted outline-none focus-visible:shadow-focus ${
      selected
        ? "border-sticker-ink bg-selected text-sticker-ink hover:overlay-sticker-medium"
        : upload
          ? "border-dashed border-line-strong hover:bg-fill-medium"
          : "border-transparent hover:bg-fill-medium"
    }`;

  return (
    <>
      <Dialog open={open} onOpenChange={handleDialogOpenChange}>
        <NarrowDialogContent
          narrow={narrowFor(field)}
          aria-labelledby={ids.title}
          className="max-w-lg"
          data-testid="agent-profile-edit-dialog"
          title={formatMessage({ id: TITLE_ID[field] })}
          titleId={ids.title}
          closeLabel={formatMessage({ id: "common.close" })}
          closeDisabled={saving}
          header={
          <DialogHeader>
            <DialogTitle id={ids.title}>{formatMessage({ id: TITLE_ID[field] })}</DialogTitle>
            <Button
              type="button"
              variant="ghost"
              size="icon-md"
              className="-my-1.5"
              aria-label={formatMessage({ id: "common.close" })}
              onClick={requestClose}
              disabled={saving}
            >
              <X className="size-4.5" aria-hidden="true" />
            </Button>
          </DialogHeader>
          }
        >
          <DialogBody className="grid gap-5">
            {field === "displayName" ? (
            <FormField label={formatMessage({ id: "agent.detail.displayName" })} htmlFor={ids.name}>
              <Input
                id={ids.name}
                value={displayName}
                autoFocus={field === "displayName"}
                placeholder={agent.name}
                onChange={handleDisplayNameChange}
                data-testid="agent-profile-edit-display-name"
              />
            </FormField>
            ) : null}
            {field === "description" ? (
            <FormField
              label={formatMessage({ id: "machine.detail.description" })}
              htmlFor={ids.description}
              error={descriptionTooLong
                ? formatMessage({ id: "agent.detail.descriptionMaxLength" }, { count: MAX_AGENT_DESCRIPTION_LENGTH })
                : undefined}
            >
              <Textarea
                id={ids.description}
                value={description}
                rows={3}
                autoFocus={field === "description"}
                placeholder={formatMessage({ id: "agent.detail.describeAgentPlaceholder" })}
                onChange={handleDescriptionChange}
                data-testid="agent-profile-edit-description"
              />
            </FormField>
            ) : null}
            {field === "role" && canEditRole && role ? (
              <RadioGroup
                aria-label={formatMessage({ id: "agent.detail.role" })}
                value={role}
                onValueChange={handleRoleChange}
                className="grid"
                data-testid="agent-profile-edit-role"
              >
                {roleOptions.map((option) => (
                  <label key={option.id} className="flex min-h-11 items-center gap-3 text-subhead font-semibold text-foreground">
                    <RadioGroupItem value={option.id} autoFocus={option.id === role} />
                    {option.label}
                  </label>
                ))}
              </RadioGroup>
            ) : null}
            {field === "avatar" ? (
            // The dialog title already names this field, so no separate label.
            <div className="grid gap-4" data-testid="agent-profile-edit-avatar">
              <div className="flex items-center gap-4">
                <AvatarSlot context="profile-tile" type="agent" agentAvatarUrl={previewAvatarUrl} />
                <Tooltip content={formatMessage({ id: "agent.detail.uploadImage" })}>
                  <button
                    type="button"
                    autoFocus={field === "avatar"}
                    aria-label={formatMessage({ id: "agent.detail.uploadImage" })}
                    onClick={() => fileInputRef.current?.click()}
                    className={presetButtonClass(avatar.kind === "upload" || (avatar.kind === "unchanged" && isCustomAvatar(agent.avatarUrl)), true)}
                  >
                    <Upload size={18} />
                  </button>
                </Tooltip>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={PROFILE_AVATAR_ACCEPT}
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.currentTarget.value = "";
                    if (file) stageUpload(file);
                  }}
                />
              </div>
              {/* One series per row of 8; a container narrower than 8 tiles
                  (a phone) wraps each series into two rows of 4. */}
              <div className="@container grid gap-3">
                {AVATAR_SERIES.map((series) => {
                  const headingId = `${ids.avatar}-${series.key}`;
                  return (
                    <div
                      key={series.key}
                      role="group"
                      aria-labelledby={headingId}
                      className="grid gap-1.5"
                      data-avatar-series={series.key}
                    >
                      <Text.Sans
                        size="group"
                        id={headingId}
                        render={<h3>{formatMessage({ id: AVATAR_SERIES_TITLE_ID[series.key] })}</h3>}
                      />
                      <div className="grid w-fit grid-cols-4 gap-2 @min-[408px]:grid-cols-8">
                        {series.avatars.map((key) => (
                          <Tooltip key={key} content={key}>
                            <button
                              type="button"
                              aria-label={key}
                              aria-pressed={selectedPreset === key}
                              onClick={() => stageAvatar(key === DEFAULT_AVATAR_KEY ? { kind: "default" } : { kind: "preset", key })}
                              className={presetButtonClass(selectedPreset === key)}
                            >
                              <AvatarSlot context="panel-header" type="agent" agentAvatarUrl={`pixel:${key}`} />
                            </button>
                          </Tooltip>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
            ) : null}
            {error ? <Banner status="warning" size="sm" role="alert">{error}</Banner> : null}
          </DialogBody>
          <DialogActions as={DialogFooter}>
            <Button type="button" variant="ghost" size="lg" onClick={requestClose} disabled={saving}>
              {formatMessage({ id: "common.confirm.cancel" })}
            </Button>
            <DialogCommit>
              {(inHead) => (
                <Button
                  type="button"
                  variant="accent"
                  size={inHead ? "md" : "lg"}
                  loading={saving}
                  disabled={!dirty || descriptionTooLong}
                  onClick={handleSaveClick}
                  data-testid="agent-profile-edit-save"
                >
                  {formatMessage({ id: "machine.detail.save" })}
                </Button>
              )}
            </DialogCommit>
          </DialogActions>
        </NarrowDialogContent>
      </Dialog>

      <AlertDialog open={confirmDiscard} onOpenChange={handleConfirmDiscardChange}>
        <AlertDialogContent data-testid="agent-profile-edit-discard">
          <AlertDialogHeader>
            <AlertDialogTitle>{formatMessage({ id: "message.chatPanel.overflow.unsavedTitle" })}</AlertDialogTitle>
          </AlertDialogHeader>
          <AlertDialogBody>{formatMessage({ id: "agent.detail.editProfile.discardBody" })}</AlertDialogBody>
          <AlertDialogFooter>
            <AlertDialogCancel size="lg">{formatMessage({ id: "message.chatPanel.overflow.keepEditing" })}</AlertDialogCancel>
            <AlertDialogAction
              variant="danger"
              size="lg"
              onClick={handleDiscardClick}
            >
              {formatMessage({ id: "message.chatPanel.overflow.discardChanges" })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
