import { lazy, Suspense, useCallback, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { Pencil, Smile, Upload } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@botiverse/raft-ui";
import { PROFILE_AVATAR_ACCEPT } from "../../utils/avatarUpload";
import { HUMAN_AVATAR_BUILDER_FEATURE_FLAG_KEY, useServerFeatureFlag } from "../../store/serverFeatureFlags";
import AvatarSlot from "../ui/AvatarSlot";
import type { AvatarContext } from "../ui/AvatarSlot";
import AvatarEditVeil from "../ui/AvatarEditVeil";

const HumanAvatarBuilderDialog = lazy(() => import("./HumanAvatarBuilderDialog").then((module) => ({ default: module.HumanAvatarBuilderDialog })));

/**
 * Your own avatar where you can change it (Settings › Account, your profile,
 * account setup): the avatar itself is the button, with the pencil veil, and
 * opens a menu: Upload a photo (the file picker; `onUpload` stores it the
 * way that page does) and Build an avatar (HumanAvatarBuilderDialog, which
 * saves on its own). There is no Remove: to change an avatar you upload or
 * build another (product decision, huxijin). Build an avatar, the builder's
 * only way in, shows only while human_avatar_builder_v0 is on for the current
 * server (off with no current server, e.g. account setup before joining one).
 */
export function HumanAvatarEditMenu({
  avatarUrl,
  context,
  busy = false,
  onUpload,
  onBuilt,
  avatar,
  testId,
}: {
  /** The stored avatar: where the builder opens. */
  avatarUrl: string | null | undefined;
  context: AvatarContext;
  /** An upload in flight: the veil stays up, the menu is off. */
  busy?: boolean;
  onUpload: (file: File) => void;
  /** After the builder saved. */
  onBuilt?: () => void;
  /** What to draw instead of the stored avatar (a photo not uploaded yet). */
  avatar?: ReactNode;
  testId?: string;
}) {
  const { formatMessage } = useIntl();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [builderOpen, setBuilderOpen] = useState(false);
  const builderEnabled = useServerFeatureFlag(HUMAN_AVATAR_BUILDER_FEATURE_FLAG_KEY).enabled;
  const label = formatMessage({ id: "avatar.edit.trigger" });
  // While a photo is saving the avatar says so (it is off until then).
  const triggerLabel = busy ? formatMessage({ id: "settings.common.uploadingAvatar" }) : label;
  const chooseFile = useCallback(() => inputRef.current?.click(), []);
  const openBuilder = useCallback(() => setBuilderOpen(true), []);

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept={PROFILE_AVATAR_ACCEPT}
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        data-avatar-edit-file=""
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.currentTarget.value = "";
          if (file) onUpload(file);
        }}
      />
      <DropdownMenu>
        <DropdownMenuTrigger
          disabled={busy}
          aria-label={triggerLabel}
          aria-busy={busy || undefined}
          data-testid={testId}
          data-avatar-edit-trigger=""
          render={(
            <button
              type="button"
              className="group/avatar-edit relative flex shrink-0 rounded-sticker outline-none focus-visible:shadow-focus disabled:cursor-wait"
            />
          )}
        >
          {avatar ?? <AvatarSlot context={context} type="human" humanAvatarUrl={avatarUrl} />}
          <AvatarEditVeil icon={Pencil} busy={busy} />
        </DropdownMenuTrigger>
        <DropdownMenuContent side="bottom" align="start" sideOffset={6} aria-label={label} data-avatar-edit-menu="">
          <DropdownMenuItem onClick={chooseFile} data-avatar-edit-action="upload">
            <Upload aria-hidden="true" />
            {formatMessage({ id: "avatar.edit.upload" })}
          </DropdownMenuItem>
          {builderEnabled ? (
            <DropdownMenuItem onClick={openBuilder} data-avatar-edit-action="build">
              <Smile aria-hidden="true" />
              {formatMessage({ id: "avatar.edit.build" })}
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      {builderOpen && builderEnabled ? (
        <Suspense fallback={null}>
          <HumanAvatarBuilderDialog open onOpenChange={setBuilderOpen} avatarUrl={avatarUrl} onSaved={onBuilt} />
        </Suspense>
      ) : null}
    </>
  );
}
