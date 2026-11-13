// Settings › Appearance › Assistant (#proj-assistant:#21; Kirby: rows on the
// settings page, not a dialog): whether the otter shows over every page, and
// the shortcut that hides it for now. Both live on the account (every
// device). The switch saves when it is flipped; the shortcut row shows the
// current keys and Customize, which opens the keyboard shortcuts panel, where
// it changes (#proj-frontend:#37). On a phone there is no keyboard, so only
// the switch.

import { useCallback, useId, useState } from "react";
import { useIntl } from "react-intl";
import { useNavigate } from "react-router-dom";
import { PawPrint } from "lucide-react";
import {
  Banner,
  Button,
  ListRow,
  ListRowBody,
  ListRowChevron,
  ListRowDescription,
  ListRowGroup,
  ListRowTitle,
  Switch,
} from "@botiverse/raft-ui";
import { KbdShortcut } from "@botiverse/raft-ui/wip";
import { shortcutSpokenLabel } from "../utils/keyboardShortcuts";
import { useShortcutBinding } from "../features/shortcuts/useShortcutBinding";
import { openShortcutsToCustomize } from "../features/keyboard-shortcuts/shortcutHelpStore";
import { useMediaQuery } from "../hooks/effectPrimitives";
import AssistantSettingChanges from "../components/settings/AssistantSettingChanges";
import { ASSISTANT_ACTION_SETTINGS } from "../components/settings/assistantSettingChangesData";
import { PHONE_MEDIA_QUERY } from "../components/ui/NarrowDialog";
import SectionHeader from "../components/ui/SectionHeader";
import { useServerStore } from "../store/serverStore";
import { useMyAssistant } from "./assistantClient";
import { saveAssistantOtterPrefs } from "./assistantOtterPrefs";
import type { AssistantOtterPrefs } from "./assistantOtterPrefs";
import { useOtterVisibleSetting } from "./assistantOtterState";

/**
 * Settings › Appearance › Assistant: shown only to a person with an assistant
 * here. The switch, and under it the shortcut row; on a phone only the switch.
 */

export function AssistantOtterSettingsSection() {
  const { formatMessage } = useIntl();
  const phone = useMediaQuery(PHONE_MEDIA_QUERY);
  const mine = useMyAssistant();
  const assistant = mine.status === "ready" ? mine.assistant : null;
  if (!assistant) return null;
  return (
    <section className="mt-6" data-testid="assistant-otter-settings">
      <SectionHeader className="mb-3" icon={<PawPrint size={16} />} label={formatMessage({ id: "settings.appearance.assistantSection" })} />
      <ListRowGroup>
        <OtterVisibleRow name={assistant.name} />
        {phone ? null : <OtterShortcutRow name={assistant.name} />}
      </ListRowGroup>
      <ListRowGroup className="mt-3">
        <AssistantPanelLink name={assistant.name} agentId={assistant.agentId} />
      </ListRowGroup>
      <div className="mt-6">
        <AssistantSettingChanges settings={ASSISTANT_ACTION_SETTINGS} />
      </div>
    </section>
  );
}

/**
 * The way to the rest of the assistant's settings (permissions, extra
 * instructions, WeChat, delete): its profile panel, beside its chat, which
 * edits this same otter setting too (Kirby 4f20e4e7).
 */
function AssistantPanelLink({ name, agentId }: { name: string; agentId: string }) {
  const { formatMessage } = useIntl();
  const navigate = useNavigate();
  const serverSlug = useServerStore((s) => s.current?.slug ?? null);
  const open = useCallback(() => {
    if (!serverSlug) return;
    navigate(`/s/${serverSlug}/assistant?profile=agent:${agentId}`);
  }, [agentId, navigate, serverSlug]);
  if (!serverSlug) return null;
  return (
    <ListRow variant="plain" onClick={open} data-testid="assistant-otter-settings-panel-link">
      <ListRowBody>
        <ListRowTitle>{formatMessage({ id: "settings.appearance.assistantPanelLinkTitle" }, { name })}</ListRowTitle>
        <ListRowDescription wrap>{formatMessage({ id: "settings.appearance.assistantPanelLinkDescription" }, { name })}</ListRowDescription>
      </ListRowBody>
      <ListRowChevron />
    </ListRow>
  );
}

function useSavePrefs() {
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const save = useCallback((prefs: AssistantOtterPrefs) => {
    setSaving(true);
    setFailed(false);
    saveAssistantOtterPrefs(prefs)
      .catch(() => setFailed(true))
      .finally(() => setSaving(false));
  }, []);
  return { saving, failed, save };
}

function SaveFailed({ testId }: { testId: string }) {
  const { formatMessage } = useIntl();
  return (
    <div className="px-4 pb-3">
      <Banner status="warning" size="sm" role="alert" data-testid={testId}>
        {formatMessage({ id: "assistant.settings.saveFailed" })}
      </Banner>
    </div>
  );
}

/** `description`: the profile panel's shorter line (Kirby a977b5f1); Settings keeps the full one. */
export function OtterVisibleRow({ name, description }: { name: string; description?: string }) {
  const { formatMessage } = useIntl();
  const idPrefix = useId();
  const visible = useOtterVisibleSetting();
  const { saving, failed, save } = useSavePrefs();
  const handleChange = useCallback((next: boolean) => save({ assistantOtterVisible: next }), [save]);
  return (
    <>
      <ListRow variant="plain" interactive={false}>
        <ListRowBody>
          <ListRowTitle id={`${idPrefix}-label`}>{formatMessage({ id: "assistant.otter.showEverywhere" }, { name })}</ListRowTitle>
          <ListRowDescription id={`${idPrefix}-description`} wrap>
            {description ?? formatMessage({ id: "assistant.otter.showEverywhereDescription" }, { name })}
          </ListRowDescription>
        </ListRowBody>
        <Switch
          checked={visible}
          disabled={saving}
          onCheckedChange={handleChange}
          aria-labelledby={`${idPrefix}-label`}
          aria-describedby={`${idPrefix}-description`}
          data-testid="assistant-otter-visible"
        />
      </ListRow>
      {failed ? <SaveFailed testId="assistant-otter-visible-error" /> : null}
    </>
  );
}

/**
 * The otter's shortcut, as the keyboard shortcuts panel has it (the panel is where it changes, Artea
 * #proj-frontend:#37): its keys, or "Off", and Customize, which opens the panel.
 */
export function OtterShortcutRow({ name, description, stacked = false }: {
  name: string;
  /** The profile panel's shorter line (Kirby a977b5f1); Settings keeps the full one. */
  description?: string;
  /** The keys and Customize on their own line under the text (the narrow profile panel). */
  stacked?: boolean;
}) {
  const { formatMessage } = useIntl();
  const idPrefix = useId();
  const binding = useShortcutBinding("assistant-otter");
  const controls = (
    <div className={stacked ? "mt-2 flex items-center gap-2" : "flex shrink-0 items-center gap-2"}>
      {binding.combos[0] ? (
        <KbdShortcut
          keys={binding.keyNames[0]!}
          size="md"
          platform={binding.platform}
          label={shortcutSpokenLabel(binding.combos[0], formatMessage)}
          data-testid="assistant-otter-shortcut-keys"
        />
      ) : (
        <span className="text-footnote text-foreground-muted" data-testid="assistant-otter-shortcut-off">
          {formatMessage({ id: "assistant.otter.shortcutOff" })}
        </span>
      )}
      <Button
        type="button"
        variant="outline"
        size="md"
        aria-describedby={`${idPrefix}-label`}
        onClick={openShortcutsToCustomize}
        data-testid="assistant-otter-shortcut-customize"
      >
        {formatMessage({ id: "keyboardShortcuts.settings.customize" })}
      </Button>
    </div>
  );
  return (
    <ListRow variant="plain" interactive={false}>
      <ListRowBody>
        <ListRowTitle id={`${idPrefix}-label`}>{formatMessage({ id: "assistant.otter.shortcut" })}</ListRowTitle>
        <ListRowDescription id={`${idPrefix}-description`} wrap>
          {description ?? formatMessage({ id: "assistant.otter.shortcutDescription" }, { name })}
        </ListRowDescription>
        {stacked ? controls : null}
      </ListRowBody>
      {stacked ? null : controls}
    </ListRow>
  );
}
