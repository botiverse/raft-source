// The assistant's own settings, in its profile panel (#proj-assistant:#21;
// Artea c834dba8 / af3f1bc4, Kirby 4f20e4e7): the gear in the assistant's
// header opens the agent profile panel, and under the profile its owner finds
// one 「Assistant」 section with everything that used to sit in the gear's
// menu: Assistant Permissions (RFC 077), showing the otter (and its
// shortcut), Extra Instructions, WeChat, and Delete Assistant last. Only the
// owner sees it (the endpoints answer only them; the server still checks each
// save). Settings › Appearance › Assistant edits the same otter setting.

import { useCallback, useEffect, useId, useState } from "react";
import { useIntl } from "react-intl";
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
  ListRow,
  ListRowBody,
  ListRowChevron,
  ListRowDescription,
  ListRowGroup,
  ListRowTitle,
  Separator,
  Switch,
} from "@botiverse/raft-ui";
import SectionEyebrow from "../components/ui/SectionEyebrow";
import { DialogActions, DialogCommit, NarrowDialogContent, PHONE_MEDIA_QUERY } from "../components/ui/NarrowDialog";
import { useMediaQuery } from "../hooks/effectPrimitives";
import { deleteAssistant, updateAssistantSetting, useMyAssistant } from "./assistantClient";
import type { AssistantOwnerSetting } from "./assistantClient";
import AssistantInstructionsDialog from "./AssistantInstructionsDialog";
import { OtterShortcutRow, OtterVisibleRow } from "./AssistantOtterSettings";
import { AssistantSettingChangesList } from "../components/settings/AssistantSettingChanges";
import { ASSISTANT_ACTION_SETTINGS, useAssistantSettingChanges } from "../components/settings/assistantSettingChangesData";
import { refreshWeChatStatus, useWeChatStatus } from "./wechatClient";
import { WeChatConnectDialog } from "./WeChatConnectDialog";

type Open = "instructions" | "wechat" | "changes" | "delete" | null;

/**
 * The owner's section of their assistant's profile panel. Renders nothing for
 * any other agent, or for anyone but the owner (useMyAssistant is the
 * viewer's own assistant). What a row needs from the server shows only when
 * the server reports it, as the gear's menu did: a permission switch when its
 * setting is not null, Extra Instructions when the notes are reported, WeChat
 * while it may be connected here or a connection exists.
 */
export function AssistantOwnerSection({ agentId }: { agentId: string }) {
  const { formatMessage } = useIntl();
  const phone = useMediaQuery(PHONE_MEDIA_QUERY);
  const mine = useMyAssistant();
  const [open, setOpen] = useState<Open>(null);
  const [busy, setBusy] = useState(false);
  const wechat = useWeChatStatus();
  // Read again each time the panel opens: the bridge may have stopped working
  // (WeChat refused its token) since the page loaded.
  useEffect(() => {
    void refreshWeChatStatus();
  }, []);
  const openInstructions = useCallback(() => setOpen("instructions"), []);
  const openWeChat = useCallback(() => setOpen("wechat"), []);
  const openChanges = useCallback(() => setOpen("changes"), []);
  const changes = useAssistantSettingChanges(ASSISTANT_ACTION_SETTINGS);
  const handleChangesOpenChange = useCallback((next: boolean) => {
    if (!next) setOpen(null);
  }, []);
  const openDelete = useCallback(() => setOpen("delete"), []);
  const closeAll = useCallback(() => setOpen(null), []);
  const handleDeleteOpenChange = useCallback((next: boolean) => {
    if (!next && !busy) setOpen(null);
  }, [busy]);
  const handleDelete = useCallback(() => {
    setBusy(true);
    void deleteAssistant().finally(() => {
      setBusy(false);
      setOpen(null);
    });
  }, []);

  const assistant = mine.status === "ready" ? mine.assistant : null;
  if (!assistant || assistant.agentId !== agentId) return null;
  const settings = mine.status === "ready" ? mine.settings : null;
  if (!settings) return null;
  const name = assistant.name;
  const wechatStatus = wechat.status === "ready" ? wechat.value : null;
  const hasWeChat = wechatStatus !== null && (wechatStatus.available || wechatStatus.binding !== null);

  return (
    <>
      <Separator />
      <section className="px-(--surface-inset) py-4" data-testid="assistant-owner-section">
        <SectionEyebrow as="div" className="mb-3">
          {formatMessage({ id: "settings.appearance.assistantSection" })}
        </SectionEyebrow>
        <div className="stack-y-4">
          {settings.readsDms !== null || settings.sendAsOwner !== null ? (
            <ListRowGroup data-testid="assistant-owner-permissions">
              {settings.readsDms !== null ? (
                <OwnerSwitchRow
                  setting="readsDms"
                  checked={settings.readsDms}
                  title={formatMessage({ id: "assistant.settings.readsDms" })}
                  description={formatMessage({ id: "assistant.panel.readsDmsDescription" })}
                />
              ) : null}
              {settings.sendAsOwner !== null ? (
                <OwnerSwitchRow
                  setting="sendAsOwner"
                  checked={settings.sendAsOwner}
                  title={formatMessage({ id: "assistant.settings.sendAsOwner" })}
                  description={formatMessage({ id: "assistant.panel.sendAsOwnerDescription" })}
                />
              ) : null}
            </ListRowGroup>
          ) : null}

          <ListRowGroup data-testid="assistant-owner-otter">
            <OtterVisibleRow name={name} description={formatMessage({ id: "assistant.panel.showEverywhereDescription" })} />
            {phone ? null : (
              <OtterShortcutRow name={name} stacked description={formatMessage({ id: "assistant.panel.shortcutDescription" })} />
            )}
          </ListRowGroup>

          {settings.ownerNotes !== null || hasWeChat || changes.length > 0 ? (
            <ListRowGroup>
              {settings.ownerNotes !== null ? (
                <ListRow variant="plain" onClick={openInstructions} data-testid="assistant-settings-instructions">
                  <ListRowBody>
                    <ListRowTitle>{formatMessage({ id: "assistant.settings.instructions" })}</ListRowTitle>
                    <ListRowDescription wrap>
                      {formatMessage({ id: "assistant.panel.instructionsDescription" }, { name })}
                    </ListRowDescription>
                  </ListRowBody>
                  <ListRowChevron />
                </ListRow>
              ) : null}
              {hasWeChat ? (
                <ListRow variant="plain" onClick={openWeChat} data-testid="assistant-settings-wechat">
                  <ListRowBody>
                    <ListRowTitle>
                      {formatMessage({ id: wechatStatus.binding ? "assistant.wechat.menuConnected" : "assistant.wechat.menuConnect" })}
                    </ListRowTitle>
                    <ListRowDescription wrap>
                      {formatMessage({ id: "assistant.panel.wechatDescription" }, { name })}
                    </ListRowDescription>
                  </ListRowBody>
                  <ListRowChevron />
                </ListRow>
              ) : null}
              {changes.length > 0 ? (
                <ListRow variant="plain" onClick={openChanges} data-testid="assistant-settings-changes">
                  <ListRowBody>
                    <ListRowTitle>{formatMessage({ id: "assistant.panel.recentChanges" })}</ListRowTitle>
                    <ListRowDescription wrap>
                      {formatMessage({ id: "assistant.panel.recentChangesDescription" }, { name })}
                    </ListRowDescription>
                  </ListRowBody>
                  <ListRowChevron />
                </ListRow>
              ) : null}
            </ListRowGroup>
          ) : null}

          <Button
            type="button"
            variant="danger-outline"
            size="lg"
            className="w-full"
            onClick={openDelete}
            data-testid="assistant-settings-delete"
          >
            {formatMessage({ id: "assistant.settings.delete" })}
          </Button>
        </div>
      </section>

      <AssistantInstructionsDialog
        key={open === "instructions" ? "open" : "closed"}
        open={open === "instructions" && settings.ownerNotes !== null}
        name={name}
        savedNotes={settings.ownerNotes ?? ""}
        onDone={closeAll}
      />

      {open === "wechat" && wechatStatus ? (
        <WeChatConnectDialog name={name} status={wechatStatus} onClose={closeAll} />
      ) : null}

      <Dialog open={open === "changes"} onOpenChange={handleChangesOpenChange}>
        <NarrowDialogContent
          narrow="centered"
          className="max-w-md"
          data-testid="assistant-changes-dialog"
          title={formatMessage({ id: "assistant.panel.recentChanges" })}
          closeLabel={formatMessage({ id: "common.close" })}
          header={null}
        >
          <DialogActions as={DialogHeader}>
            <DialogTitle>{formatMessage({ id: "assistant.panel.recentChanges" })}</DialogTitle>
          </DialogActions>
          <DialogBody>
            <AssistantSettingChangesList changes={changes} />
          </DialogBody>
          <DialogActions as={DialogFooter}>
            <DialogCommit>
              {(inHead) => (
                <Button type="button" variant="primary" size={inHead ? "md" : "lg"} onClick={closeAll} data-testid="assistant-changes-done">
                  {formatMessage({ id: "assistant.settings.done" })}
                </Button>
              )}
            </DialogCommit>
          </DialogActions>
        </NarrowDialogContent>
      </Dialog>

      <AlertDialog open={open === "delete"} onOpenChange={handleDeleteOpenChange}>
        <AlertDialogContent data-testid="assistant-delete-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>{formatMessage({ id: "assistant.settings.delete" })}</AlertDialogTitle>
          </AlertDialogHeader>
          <AlertDialogBody>
            {formatMessage({ id: "assistant.settings.deleteBody" }, { name })}
          </AlertDialogBody>
          <AlertDialogFooter>
            <AlertDialogCancel size="lg" disabled={busy}>
              {formatMessage({ id: "assistant.settings.cancel" })}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="danger"
              size="lg"
              disabled={busy}
              onClick={handleDelete}
              data-testid="assistant-delete-confirm-action"
            >
              {formatMessage({ id: "assistant.settings.delete" })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/**
 * One owner switch (Read My DMs, Send Messages as Me). It saves when flipped,
 * optimistically: it moves at once and moves back, with an orange banner
 * under it, when the save fails (as Settings › Share usage data).
 */
function OwnerSwitchRow({
  setting,
  checked,
  title,
  description,
}: {
  setting: AssistantOwnerSetting;
  checked: boolean;
  title: string;
  description: string;
}) {
  const { formatMessage } = useIntl();
  const idPrefix = useId();
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const handleChange = useCallback((next: boolean) => {
    setSaving(true);
    setFailed(false);
    updateAssistantSetting(setting, next)
      .catch(() => setFailed(true))
      .finally(() => setSaving(false));
  }, [setting]);
  return (
    <>
      <ListRow variant="plain" interactive={false}>
        <ListRowBody>
          <ListRowTitle id={`${idPrefix}-label`}>{title}</ListRowTitle>
          <ListRowDescription id={`${idPrefix}-description`} wrap>
            {description}
          </ListRowDescription>
        </ListRowBody>
        <Switch
          checked={checked}
          disabled={saving}
          onCheckedChange={handleChange}
          aria-labelledby={`${idPrefix}-label`}
          aria-describedby={`${idPrefix}-description`}
          data-testid={`assistant-setting-${setting}`}
        />
      </ListRow>
      {failed ? (
        <div className="px-4 pb-3">
          <Banner status="warning" size="sm" role="alert" data-testid={`assistant-setting-${setting}-error`}>
            {formatMessage({ id: "assistant.settings.saveFailed" })}
          </Banner>
        </div>
      ) : null}
    </>
  );
}
