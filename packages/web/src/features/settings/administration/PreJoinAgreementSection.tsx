import { Checkbox, Textarea, TextareaCounter, Button, Card, Input } from "@botiverse/raft-ui";
import { useCallback, useState, useEffect, useEffectEvent } from "react";
import type { ChangeEvent } from "react";
import { FileText } from "lucide-react";
import { useServerStore } from "../../../store/serverStore";
import Banner from "../../../components/ui/Banner";
import api from "../../../api/client";
import { useIntl } from "react-intl";
import SectionEyebrow from "../../../components/ui/SectionEyebrow";
import SectionHeader from "../../../components/ui/SectionHeader";
import FormField from "../../../components/ui/FormField";
import AgreementBody from "../../../components/server/AgreementBody";

const PRE_JOIN_AGREEMENT_BODY_MAX_LENGTH = 5_000;
const PRE_JOIN_AGREEMENT_BODY_MAX_LENGTH_LABEL = "5,000";

export function PreJoinAgreementSection() {
  const { formatMessage } = useIntl();
  const currentServer = useServerStore((s) => s.current);
  const [enabled, setEnabled] = useState(false);
  const [title, setTitle] = useState("");
  const [bodyMarkdown, setBodyMarkdown] = useState("");
  const [savedEnabled, setSavedEnabled] = useState(false);
  const [savedTitle, setSavedTitle] = useState("");
  const [savedBodyMarkdown, setSavedBodyMarkdown] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const serverId = currentServer?.id;

  // Read at failure time so a locale switch does not refetch the agreement.
  const formatLoadError = useEffectEvent(() => formatMessage({ id: "settings.preJoinAgreement.failedLoad" }));

  // Async-loader: load the agreement only when the active server id changes,
  // not on unrelated churn of the `currentServer` store object. Same FP family
  // as L1696.
  // oxlint-disable-next-line react-doctor/no-cascading-set-state
  useEffect(() => {
    if (!serverId) return;
    let cancelled = false;
    // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change
    setLoading(true);
    // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change
    setError("");
    void api
      .get(`/servers/${serverId}/agreement`)
      .then(({ data }) => {
        if (cancelled) return;
        const nextEnabled = !!data.enabled;
        const nextTitle = data.agreement?.title ?? "";
        const nextBodyMarkdown = data.agreement?.bodyMarkdown ?? "";
        setEnabled(nextEnabled);
        setTitle(nextTitle);
        setBodyMarkdown(nextBodyMarkdown);
        setSavedEnabled(nextEnabled);
        setSavedTitle(nextTitle);
        setSavedBodyMarkdown(nextBodyMarkdown);
        setSaved(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const responseError = (err as { response?: { data?: { error?: unknown } } }).response?.data?.error;
        setError(
          typeof responseError === "string" && responseError.trim()
            ? responseError
            : formatLoadError(),
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [serverId]);

  const handleEnabledChange = useCallback((checked: boolean) => {
    setEnabled(checked);
    setSaved(false);
  }, []);

  const handleTitleChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setTitle(event.target.value);
    setSaved(false);
  }, []);

  const handleBodyMarkdownChange = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => {
    setBodyMarkdown(event.target.value);
    setSaved(false);
  }, []);

  const bodyMarkdownTooLong = bodyMarkdown.length > PRE_JOIN_AGREEMENT_BODY_MAX_LENGTH;

  const handleSave = useCallback(async () => {
    if (!serverId || bodyMarkdownTooLong) return;
    setSaving(true);
    setSaved(false);
    setError("");
    try {
      const { data } = await api.put(`/servers/${serverId}/agreement`, {
        enabled,
        title,
        bodyMarkdown,
      });
      const nextEnabled = !!data.enabled;
      const nextTitle = data.agreement?.title ?? title;
      const nextBodyMarkdown = data.agreement?.bodyMarkdown ?? bodyMarkdown;
      setEnabled(nextEnabled);
      setTitle(nextTitle);
      setBodyMarkdown(nextBodyMarkdown);
      setSavedEnabled(nextEnabled);
      setSavedTitle(nextTitle);
      setSavedBodyMarkdown(nextBodyMarkdown);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1500);
    } catch (err: any) {
      setError(err.response?.data?.error || formatMessage({ id: "settings.preJoinAgreement.failedSave" }));
    } finally {
      setSaving(false);
    }
  }, [bodyMarkdown, bodyMarkdownTooLong, enabled, formatMessage, serverId, title]);

  if (!currentServer) return null;

  const dirty =
    enabled !== savedEnabled
    || title !== savedTitle
    || bodyMarkdown !== savedBodyMarkdown;
  const bodyMarkdownError = bodyMarkdownTooLong
    ? formatMessage({ id: "settings.preJoinAgreement.bodyTooLong" }, { max: PRE_JOIN_AGREEMENT_BODY_MAX_LENGTH_LABEL })
    : "";

  return (
    <div className="mb-6">
      <SectionHeader
        className="mb-3"
        icon={<FileText size={16} />}
        label={formatMessage({ id: "settings.preJoinAgreement.sectionLabel" })}
      />

      {/* 16px inside, like the rows of the other sections and the SSO cards, so its
          text starts on their line. */}
      <Card className="stack-y-4 p-4">
        <label className={`flex items-start gap-3 ${saving || loading ? "cursor-not-allowed" : ""}`}>
          <Checkbox
            checked={enabled}
            disabled={saving || loading}
            onCheckedChange={handleEnabledChange}
          />
          <span className="min-w-0">
            <span className={`block text-subhead font-semibold ${saving || loading ? "text-foreground-disabled" : "text-foreground"}`}>{formatMessage({ id: "settings.preJoinAgreement.requireTitle" })}</span>
          </span>
        </label>

        {enabled && (
          <>
            <FormField label={formatMessage({ id: "settings.preJoinAgreement.titleLabel" })} size="compact">
              <Input
                value={title}
                onChange={handleTitleChange}
                maxLength={160}
                disabled={saving || loading}
                className="w-full"
              />
            </FormField>
            <FormField label={formatMessage({ id: "settings.preJoinAgreement.bodyLabel" })} size="compact">
              <Textarea
                value={bodyMarkdown}
                onChange={handleBodyMarkdownChange}
                rows={7}
                maxLength={PRE_JOIN_AGREEMENT_BODY_MAX_LENGTH}
                aria-invalid={bodyMarkdownError ? true : undefined}
                aria-describedby={bodyMarkdownError ? "pre-join-agreement-error" : "pre-join-agreement-counter"}
                disabled={saving || loading}
                className="resize-y font-mono"
              />
              <div className="mt-1 flex items-start justify-between gap-3">
                {bodyMarkdownError ? (
                  <p id="pre-join-agreement-error" role="alert" className="text-caption text-danger-strong">
                    {bodyMarkdownError}
                  </p>
                ) : (
                  <span />
                )}
                <TextareaCounter id="pre-join-agreement-counter" value={bodyMarkdown} limit={PRE_JOIN_AGREEMENT_BODY_MAX_LENGTH} />
              </div>
            </FormField>
            <div className="rounded-container border border-line-hairline bg-layer-canvas p-3">
              <SectionEyebrow as="div" className="mb-2">{formatMessage({ id: "settings.preJoinAgreement.preview" })}</SectionEyebrow>
              <div className="text-callout">
                <AgreementBody source={bodyMarkdown} />
              </div>
            </div>
          </>
        )}

        {error && (
          <Banner intent="warning" density="sm">
            {error}
          </Banner>
        )}

        <div className="flex flex-col items-start gap-2">
          <div className="text-caption text-foreground-hint">
            {formatMessage({ id: "settings.preJoinAgreement.versionNote" })}
          </div>
          <Button
            variant="accent" size="md"
            type="button"
            onClick={handleSave}
            disabled={!dirty || bodyMarkdownTooLong || saving || loading}
          >
            {saving ? formatMessage({ id: "settings.common.saving" }) : saved ? formatMessage({ id: "settings.common.saved" }) : formatMessage({ id: "settings.common.save" })}
          </Button>
        </div>
      </Card>
    </div>
  );
}
