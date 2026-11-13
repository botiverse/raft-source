import { Button, Card, Input, Switch } from "@botiverse/raft-ui";
import { useCallback, useState } from "react";
import type { ChangeEvent } from "react";
import { useIntl } from "react-intl";
import Banner from "../../../components/ui/Banner";
import FormField from "../../../components/ui/FormField";
import { ssoErrorMessage, updateSsoRules } from "./ssoApi";
import type { SsoConnectionView, SsoRules } from "./ssoApi";

const MIN_DAYS = 1;
const MAX_DAYS = 30;

/**
 * What the connection does for people on the verified domains (RFC 083 §6):
 * auto-join, Require SSO and how long an SSO sign-in lasts. Owner only; each
 * change is its own PATCH /rules with just that field. Require SSO needs an
 * active connection (one that passed a test sign-in), applies to the managed
 * people's whole Raft account, and never locks the owner out. It also needs
 * the platform's review of the organization: without it the switch cannot be
 * turned on, and one already on does nothing until the review is back.
 */
export function SsoRulesCard({ serverId, connection, canManage, requireReviewed, onConnectionChange }: {
  serverId: string;
  connection: SsoConnectionView;
  canManage: boolean;
  requireReviewed: boolean;
  onConnectionChange: (connection: SsoConnectionView) => void;
}) {
  const { formatMessage } = useIntl();
  const { rules } = connection;
  const [saving, setSaving] = useState<keyof SsoRules | null>(null);
  const [days, setDays] = useState(String(rules.sessionMaxAgeDays));
  const [error, setError] = useState("");

  const disabled = !canManage || saving !== null;
  const active = connection.status === "active";
  const parsedDays = Number(days);
  const daysValid = Number.isInteger(parsedDays) && parsedDays >= MIN_DAYS && parsedDays <= MAX_DAYS;

  const save = useCallback(async (change: Partial<SsoRules>) => {
    const field = Object.keys(change)[0] as keyof SsoRules;
    setSaving(field);
    setError("");
    try {
      const next = await updateSsoRules(serverId, change);
      onConnectionChange(next);
      setDays(String(next.rules.sessionMaxAgeDays));
    } catch (err) {
      setError(ssoErrorMessage(err, formatMessage({ id: "settings.sso.failedRules" })));
    } finally {
      setSaving(null);
    }
  }, [formatMessage, onConnectionChange, serverId]);

  const handleAutoJoinChange = useCallback((checked: boolean) => void save({ autoJoin: checked }), [save]);
  const handleRequiredChange = useCallback((checked: boolean) => void save({ required: checked }), [save]);
  const handleDaysChange = useCallback((event: ChangeEvent<HTMLInputElement>) => setDays(event.target.value), []);
  const handleSaveDays = useCallback(() => void save({ sessionMaxAgeDays: parsedDays }), [parsedDays, save]);

  return (
    <Card className="stack-y-4 p-4" data-testid="sso-rules">
      <div>
        <h3 className="text-subhead font-semibold text-foreground">
          {formatMessage({ id: "settings.sso.rulesTitle" })}
        </h3>
        {!canManage && (
          <p className="mt-1 text-footnote text-foreground-muted">
            {formatMessage({ id: "settings.sso.rulesOwnerOnly" })}
          </p>
        )}
      </div>

      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <p id="sso-auto-join-label" className="text-subhead font-semibold text-foreground">
            {formatMessage({ id: "settings.sso.autoJoin" })}
          </p>
        </div>
        <Switch
          checked={rules.autoJoin}
          disabled={disabled}
          onCheckedChange={handleAutoJoinChange}
          aria-labelledby="sso-auto-join-label"
          data-testid="sso-auto-join-switch"
        />
      </div>

      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <p id="sso-required-label" className="text-subhead font-semibold text-foreground">
            {formatMessage({ id: "settings.sso.required" })}
          </p>
          <p id="sso-required-description" className="mt-1 text-footnote text-foreground-muted">
            {formatMessage({ id: "settings.sso.requiredDescription" })}
          </p>
          {!active && !rules.required && (
            <p className="mt-1 text-footnote text-foreground-hint">
              {formatMessage({ id: "settings.sso.requiredNeedsActive" })}
            </p>
          )}
          {active && !requireReviewed && (
            <p className="mt-1 text-footnote text-foreground-hint" data-testid="sso-required-needs-review">
              {formatMessage({ id: rules.required ? "settings.sso.requiredNotInEffect" : "settings.sso.requiredNeedsReview" })}
            </p>
          )}
        </div>
        <Switch
          checked={rules.required}
          // Turning it on needs an active, reviewed connection; turning it off never does.
          disabled={disabled || (!rules.required && (!active || !requireReviewed))}
          onCheckedChange={handleRequiredChange}
          aria-labelledby="sso-required-label"
          aria-describedby="sso-required-description"
          data-testid="sso-required-switch"
        />
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <FormField
          label={formatMessage({ id: "settings.sso.sessionMaxAge" })}
          error={!daysValid ? formatMessage({ id: "settings.sso.sessionMaxAgeInvalid" }, { min: MIN_DAYS, max: MAX_DAYS }) : undefined}
          size="compact"
          htmlFor="sso-session-max-age"
          className="w-48"
        >
          <Input
            id="sso-session-max-age"
            type="number"
            min={MIN_DAYS}
            max={MAX_DAYS}
            step={1}
            value={days}
            onChange={handleDaysChange}
            disabled={disabled}
            className="w-full"
            data-testid="sso-session-max-age"
          />
        </FormField>
        {canManage && (
          <Button
            variant="outline" size="lg"
            type="button"
            onClick={handleSaveDays}
            disabled={!daysValid || parsedDays === rules.sessionMaxAgeDays}
            loading={saving === "sessionMaxAgeDays"}
            loadingLabel={formatMessage({ id: "settings.common.saving" })}
            data-testid="sso-session-max-age-save"
          >
            {formatMessage({ id: "settings.common.save" })}
          </Button>
        )}
      </div>

      {error && (
        <Banner intent="warning" density="sm">
          {error}
        </Banner>
      )}
    </Card>
  );
}
