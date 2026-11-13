// RFC-067 product analytics controls: the personal "Share usage data" switch
// (Settings → Account) and the workspace switch (Settings → Administration).
// Always shown: "Share usage data" is on by default (2026-10-21), so the way
// to turn it off must never be hidden.
// Both save on toggle; the server gate (productAnalyticsGate) is what enforces
// them, and the tracker asks /product-events/config before sending anything.

import { useCallback, useEffect, useId, useState } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { ListRow, ListRowBody, ListRowDescription, ListRowGroup, ListRowTitle, Switch, TextLink, TextLinkExternalIcon } from "@botiverse/raft-ui";
import { BarChart3 } from "lucide-react";
import { PRIVACY_URL, SHARE_USAGE_DATA_DEFAULT } from "@botiverse/raft-shared";
import api from "../../api/client";
import { useAuthStore } from "../../store/authStore";
import { useServerStore } from "../../store/serverStore";
import Banner from "../ui/Banner";
import SectionHeader from "../ui/SectionHeader";
import { opensInNewTabAriaLabel } from "../ui/LeavingRaftMark";

function SwitchRow({
  idPrefix,
  title,
  description,
  checked,
  disabled,
  onCheckedChange,
  footer,
}: {
  idPrefix: string;
  title: string;
  description: ReactNode;
  checked: boolean;
  disabled: boolean;
  onCheckedChange: (checked: boolean) => void;
  footer?: ReactNode;
}) {
  // DS ListRow › a setting row: raft-ui's `plain` display-only ListRow (the
  // Switch is the target) in an inset group. A save failure comes and goes, so
  // it shows under the group, not in the row: in the row it would make the row
  // taller and move the Switch centred on it.
  return (
    <>
      <ListRowGroup>
        <ListRow variant="plain" interactive={false}>
          <ListRowBody>
            <ListRowTitle id={`${idPrefix}-label`}>{title}</ListRowTitle>
            <ListRowDescription id={`${idPrefix}-description`} wrap>
              {description}
            </ListRowDescription>
          </ListRowBody>
          <Switch
            checked={checked}
            disabled={disabled}
            onCheckedChange={onCheckedChange}
            aria-labelledby={`${idPrefix}-label`}
            aria-describedby={`${idPrefix}-description`}
          />
        </ListRow>
      </ListRowGroup>
      {footer ? <div className="mt-3">{footer}</div> : null}
    </>
  );
}

/** Settings → Account. */
export function UsageDataSettingsCard() {
  const { formatMessage } = useIntl();
  const idPrefix = useId();
  const shareUsageData = useAuthStore((s) => s.user?.shareUsageData ?? null);
  const updateProfile = useAuthStore((s) => s.updateProfile);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  const handleChange = useCallback((checked: boolean) => {
    setSaving(true);
    setFailed(false);
    void updateProfile({ shareUsageData: checked })
      .catch(() => setFailed(true))
      .finally(() => setSaving(false));
  }, [updateProfile]);

  // A section of its own, with the same header as Administration's workspace
  // switch, so it doesn't read as part of the section above it.
  return (
    <div className="mb-6" data-testid="account-usage-data">
      <SectionHeader
        className="mb-3"
        icon={<BarChart3 size={16} />}
        label={formatMessage({ id: "settings.workspaceProductAnalytics.sectionLabel" })}
      />
      <SwitchRow
        idPrefix={idPrefix}
        title={formatMessage({ id: "settings.usageData.title" })}
        description={(
          <>
            {formatMessage({ id: "settings.usageData.description" })}{" "}
            <TextLink render={<a href={PRIVACY_URL} target="_blank" rel="noopener noreferrer" aria-label={opensInNewTabAriaLabel(formatMessage, formatMessage({ id: "settings.usageData.learnMore" }))} />} variant="strong">
              {formatMessage({ id: "settings.usageData.learnMore" })}
              <TextLinkExternalIcon label={formatMessage({ id: "common.opensInNewTab" })} />
            </TextLink>
          </>
        )}
        checked={shareUsageData ?? SHARE_USAGE_DATA_DEFAULT}
        disabled={saving}
        onCheckedChange={handleChange}
        footer={failed && (
          <Banner intent="warning" density="sm">
            {formatMessage({ id: "settings.usageData.saveFailed" })}
          </Banner>
        )}
      />
    </div>
  );
}

interface WorkspaceProductAnalyticsSettings {
  productAnalyticsEnabled: boolean;
  canManageProductAnalytics: boolean;
}

/** Settings → Administration (owners and admins). */
export function WorkspaceProductAnalyticsSection() {
  const { formatMessage } = useIntl();
  const idPrefix = useId();
  const serverId = useServerStore((s) => s.current?.id);
  const [settings, setSettings] = useState<WorkspaceProductAnalyticsSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!serverId) return;
    let cancelled = false;
    api.get<WorkspaceProductAnalyticsSettings>(`/servers/${serverId}/product-analytics-settings`)
      .then(({ data }) => {
        if (!cancelled) setSettings(data);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [serverId]);

  // Declared before the early return below: hooks must run on every render.
  const handleChange = useCallback((checked: boolean) => {
    if (!serverId) return;
    setSaving(true);
    setFailed(false);
    void api.patch<WorkspaceProductAnalyticsSettings>(
      `/servers/${serverId}/product-analytics-settings`,
      { productAnalyticsEnabled: checked },
    )
      .then(({ data }) => setSettings(data))
      .catch(() => setFailed(true))
      .finally(() => setSaving(false));
  }, [serverId]);

  if (!serverId) return null;

  return (
    <div className="mb-6">
      <SectionHeader
        className="mb-3"
        icon={<BarChart3 size={16} />}
        label={formatMessage({ id: "settings.workspaceProductAnalytics.sectionLabel" })}
      />
      <SwitchRow
        idPrefix={idPrefix}
        title={formatMessage({ id: "settings.workspaceProductAnalytics.title" })}
        description={formatMessage({ id: "settings.workspaceProductAnalytics.description" })}
        checked={settings?.productAnalyticsEnabled ?? true}
        disabled={saving || settings === null || !settings.canManageProductAnalytics}
        onCheckedChange={handleChange}
        footer={failed && (
          <Banner intent="warning" density="sm">
            {formatMessage({ id: "settings.workspaceProductAnalytics.saveFailed" })}
          </Banner>
        )}
      />
    </div>
  );
}
