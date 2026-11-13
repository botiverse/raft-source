// Settings › Notifications › Content (design §4.3 item 3): one account-wide
// preview setting, the sound switch, "Phone alerts" (mobileDelay, contract
// §1.3: when the phone rings while you're active on a computer) and "Replies
// in threads I follow" (followedThreadReplies, contract §1.2, #triage:#357:
// off, a followed thread alerts only when a reply @mentions you; it stays in
// Activity), applied by the server to every device. One ListRowGroup of settings rows (DS Forms › A
// setting's row; Jasper + cindyz, #triage:c95a5e53): the preview Select and the
// sound Switch end their rows (the Select under the text where the row is under
// 32rem wide); Phone alerts' Select stays under its text for now.

import { useCallback, useMemo } from "react";
import { useIntl } from "react-intl";
import { Eye } from "lucide-react";
import {
  ListRow,
  ListRowBody,
  ListRowDescription,
  ListRowGroup,
  ListRowTitle,
  Select,
  SelectContent,
  SelectIcon,
  SelectItem,
  SelectItemIndicator,
  SelectItemText,
  SelectList,
  SelectTrigger,
  SelectValue,
  Switch,
  toast,
} from "@botiverse/raft-ui";
import { NOTIFICATION_PREVIEW_MODES, isNotificationMobileDelay, isNotificationPreviewMode } from "@botiverse/raft-shared";
import type { NotificationMobileDelay, NotificationPreviewMode } from "@botiverse/raft-shared";
import type { MessageId } from "../../../i18n/messages";
import { useNotificationSettingsStore } from "../../../store/notificationSettingsStore";
import type { AccountNotificationSettingsPatch } from "../../../notifications/notificationApi";
import SectionHeader from "../../ui/SectionHeader";

const PREVIEW_LABEL: Record<NotificationPreviewMode, MessageId> = {
  full: "settings.notifications.preview.full",
  sender_only: "settings.notifications.preview.senderOnly",
  hidden: "settings.notifications.preview.hidden",
};

// The default first, then each step more eager to ring, "always" last.
const MOBILE_DELAY_ORDER: readonly NotificationMobileDelay[] = ["inactive", "1m", "2m", "5m", "10m", "always"];

const MOBILE_DELAY_LABEL: Record<NotificationMobileDelay, MessageId> = {
  always: "settings.notifications.mobileDelay.always",
  inactive: "settings.notifications.mobileDelay.inactive",
  "1m": "settings.notifications.mobileDelay.1m",
  "2m": "settings.notifications.mobileDelay.2m",
  "5m": "settings.notifications.mobileDelay.5m",
  "10m": "settings.notifications.mobileDelay.10m",
};

export function ContentCard() {
  const { formatMessage } = useIntl();
  const account = useNotificationSettingsStore((s) => s.account);
  const patchAccount = useNotificationSettingsStore((s) => s.patchAccount);

  const save = useCallback((patch: AccountNotificationSettingsPatch) => {
    void patchAccount(patch).then((result) => {
      if (result.kind === "error") toast.error(formatMessage({ id: "settings.notifications.saveFailed" }));
      else if (result.kind === "conflict") toast.error(formatMessage({ id: "settings.notifications.saveConflict" }));
    });
  }, [formatMessage, patchAccount]);

  const options = useMemo(() => NOTIFICATION_PREVIEW_MODES.map((mode) => ({ value: mode, label: formatMessage({ id: PREVIEW_LABEL[mode] }) })), [formatMessage]);
  const handlePreview = useCallback((value: unknown) => {
    if (isNotificationPreviewMode(value) && value !== account?.previewMode) save({ previewMode: value });
  }, [account?.previewMode, save]);
  const handleSound = useCallback((checked: boolean) => save({ sound: checked }), [save]);
  const handleFollowedThreadReplies = useCallback((checked: boolean) => save({ followedThreadReplies: checked }), [save]);
  const delayOptions = useMemo(() => MOBILE_DELAY_ORDER.map((delay) => ({ value: delay, label: formatMessage({ id: MOBILE_DELAY_LABEL[delay] }) })), [formatMessage]);
  const mobileDelay = account?.mobileDelay ?? "inactive";
  const handleMobileDelay = useCallback((value: unknown) => {
    if (isNotificationMobileDelay(value) && value !== account?.mobileDelay) save({ mobileDelay: value });
  }, [account?.mobileDelay, save]);
  const disabled = !account;

  return (
    <div>
      <SectionHeader className="mb-3" icon={<Eye size={16} />} label={formatMessage({ id: "settings.notifications.content.sectionLabel" })} />
      <ListRowGroup className="@container" data-testid="notification-content-card">
        <ListRow id="notification-preview" variant="plain" interactive={false} className="@max-lg:flex-wrap">
          <ListRowBody>
            <ListRowTitle id="notification-preview-label">{formatMessage({ id: "settings.notifications.preview.title" })}</ListRowTitle>
          </ListRowBody>
          <div className="shrink-0 @max-lg:basis-full">
            <Select value={account?.previewMode ?? "full"} onValueChange={handlePreview} disabled={disabled} items={options}>
              <SelectTrigger fit className="@max-lg:w-full @max-lg:max-w-sm" aria-labelledby="notification-preview-label" data-testid="notification-preview-select">
                <SelectValue />
                <SelectIcon />
              </SelectTrigger>
              <SelectContent>
                <SelectList>
                  {options.map((option) => (
                    <SelectItem key={option.value} value={option.value} data-testid={`notification-preview-${option.value}`}>
                      <SelectItemText>{option.label}</SelectItemText>
                      <SelectItemIndicator />
                    </SelectItem>
                  ))}
                </SelectList>
              </SelectContent>
            </Select>
          </div>
        </ListRow>
        <ListRow id="notification-mobile-delay" variant="plain" interactive={false}>
          <ListRowBody>
            <ListRowTitle id="notification-mobile-delay-label">{formatMessage({ id: "settings.notifications.mobileDelay.title" })}</ListRowTitle>
            {/* What "active" means, or nobody knows why their phone didn't ring (Kirby). */}
            <ListRowDescription id="notification-mobile-delay-description" wrap>{formatMessage({ id: "settings.notifications.mobileDelay.description" })}</ListRowDescription>
            {/* Stays under the text, unlike the other settings selects: its options are long
                phrases and their copy is pending (#triage:c95a5e53). */}
            <div className="pt-2">
              <Select value={mobileDelay} onValueChange={handleMobileDelay} disabled={disabled} items={delayOptions}>
                <SelectTrigger className="w-full max-w-sm" aria-labelledby="notification-mobile-delay-label" aria-describedby="notification-mobile-delay-description" data-testid="notification-mobile-delay-select">
                  <SelectValue />
                  <SelectIcon />
                </SelectTrigger>
                <SelectContent>
                  <SelectList>
                    {delayOptions.map((option) => (
                      <SelectItem key={option.value} value={option.value} data-testid={`notification-mobile-delay-${option.value}`}>
                        <SelectItemText>{option.label}</SelectItemText>
                        <SelectItemIndicator />
                      </SelectItem>
                    ))}
                  </SelectList>
                </SelectContent>
              </Select>
            </div>
          </ListRowBody>
        </ListRow>
        <ListRow id="notification-sound" variant="plain" interactive={false}>
          <ListRowBody>
            <ListRowTitle id="notification-sound-label">{formatMessage({ id: "settings.notifications.sound.title" })}</ListRowTitle>
          </ListRowBody>
          <Switch
            checked={account?.sound !== false}
            disabled={disabled}
            onCheckedChange={handleSound}
            aria-labelledby="notification-sound-label"
            data-testid="notification-sound-switch"
          />
        </ListRow>
        <ListRow id="notification-followed-thread-replies" variant="plain" interactive={false}>
          <ListRowBody>
            <ListRowTitle id="notification-followed-thread-replies-label">{formatMessage({ id: "settings.notifications.followedThreadReplies.title" })}</ListRowTitle>
            {/* What off keeps, or people think they lose the thread (#triage:#357). */}
            <ListRowDescription id="notification-followed-thread-replies-description" wrap>{formatMessage({ id: "settings.notifications.followedThreadReplies.description" })}</ListRowDescription>
          </ListRowBody>
          <Switch
            checked={account?.followedThreadReplies !== false}
            disabled={disabled}
            onCheckedChange={handleFollowedThreadReplies}
            aria-labelledby="notification-followed-thread-replies-label"
            aria-describedby="notification-followed-thread-replies-description"
            data-testid="notification-followed-thread-replies-switch"
          />
        </ListRow>
      </ListRowGroup>
    </div>
  );
}
