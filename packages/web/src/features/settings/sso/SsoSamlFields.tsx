import { Button, Checkbox, Input, Textarea } from "@botiverse/raft-ui";
import { Plus } from "lucide-react";
import { useCallback } from "react";
import type { ChangeEvent } from "react";
import { useIntl } from "react-intl";
import FormField from "../../../components/ui/FormField";
import { useTimeFormatter } from "../../../hooks/useTimeFormatter";
import type { SsoCertificateView } from "./ssoApi";
import { SSO_MAX_CERTIFICATES } from "./ssoConnectionForm";
import type { SsoConnectionForm } from "./ssoConnectionForm";

/**
 * The SAML connection's fields: the IdP's entity id and sign-in URL, one or
 * two signing certificates (two while the IdP rotates), and whether the IdP's
 * email can be trusted to link existing Raft accounts.
 */
export function SsoSamlFields({ form, disabled, savedCertificates, onChange }: {
  form: SsoConnectionForm;
  disabled: boolean;
  /** The certificates as saved, with what the server read from them. */
  savedCertificates: SsoCertificateView[];
  onChange: (patch: Partial<SsoConnectionForm>) => void;
}) {
  const { formatMessage } = useIntl();
  const { formatShortDateTime } = useTimeFormatter();
  const handleEntityIdChange = useCallback((event: ChangeEvent<HTMLInputElement>) => onChange({ idpEntityId: event.target.value }), [onChange]);
  const handleSsoUrlChange = useCallback((event: ChangeEvent<HTMLInputElement>) => onChange({ idpSsoUrl: event.target.value }), [onChange]);
  const handleEmailManagedChange = useCallback((checked: boolean) => onChange({ emailManagedByAdmins: checked }), [onChange]);
  const handleCertificateChange = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => {
    const index = Number(event.target.dataset.index);
    onChange({ idpCertificates: form.idpCertificates.map((pem, i) => (i === index ? event.target.value : pem)) });
  }, [form.idpCertificates, onChange]);
  const handleAddCertificate = useCallback(() => onChange({ idpCertificates: [...form.idpCertificates, ""] }), [form.idpCertificates, onChange]);
  const handleRemoveCertificate = useCallback(() => onChange({ idpCertificates: form.idpCertificates.slice(0, 1) }), [form.idpCertificates, onChange]);

  const certificateNote = (pem: string) => {
    const saved = savedCertificates.find((certificate) => certificate.pem.trim() === pem.trim());
    if (!saved) return undefined;
    if (!saved.readable) return formatMessage({ id: "settings.sso.samlCertificateUnreadable" });
    return formatMessage(
      { id: "settings.sso.samlCertificateDetails" },
      { subject: saved.subject ?? "", notAfter: formatShortDateTime(saved.notAfter) },
    );
  };

  return (
    <>
      <FormField label={formatMessage({ id: "settings.sso.samlEntityId" })} size="compact" htmlFor="sso-saml-entity-id">
        <Input
          id="sso-saml-entity-id"
          value={form.idpEntityId}
          onChange={handleEntityIdChange}
          disabled={disabled}
          autoComplete="off"
          className="w-full"
        />
      </FormField>

      <FormField label={formatMessage({ id: "settings.sso.samlSsoUrl" })} size="compact" htmlFor="sso-saml-sso-url">
        <Input
          id="sso-saml-sso-url"
          type="url"
          value={form.idpSsoUrl}
          onChange={handleSsoUrlChange}
          disabled={disabled}
          className="w-full"
        />
      </FormField>

      {form.idpCertificates.map((pem, index) => (
        <FormField
          // The list is one or two fixed slots, never reordered.
          // oxlint-disable-next-line react/no-array-index-key
          key={index}
          label={index === 0
            ? formatMessage({ id: "settings.sso.samlCertificate" })
            : formatMessage({ id: "settings.sso.samlSecondCertificate" })}
          hint={certificateNote(pem) ?? (index === 0 ? formatMessage({ id: "settings.sso.samlCertificateHint" }) : undefined)}
          size="compact"
          htmlFor={`sso-saml-certificate-${index}`}
          labelAction={index > 0 && !disabled ? (
            <Button type="button" variant="ghost" size="md" onClick={handleRemoveCertificate}>
              {formatMessage({ id: "settings.sso.samlRemoveCertificate" })}
            </Button>
          ) : undefined}
        >
          <Textarea
            id={`sso-saml-certificate-${index}`}
            data-index={index}
            data-testid={`sso-saml-certificate-${index}`}
            value={pem}
            onChange={handleCertificateChange}
            disabled={disabled}
            rows={5}
            spellCheck={false}
            className="resize-y font-mono"
          />
        </FormField>
      ))}
      {!disabled && form.idpCertificates.length < SSO_MAX_CERTIFICATES && (
        <div>
          <Button type="button" variant="outline" size="md" onClick={handleAddCertificate}>
            <Plus size={14} />
            {formatMessage({ id: "settings.sso.samlAddCertificate" })}
          </Button>
        </div>
      )}

      <label className={`flex items-start gap-3 ${disabled ? "cursor-not-allowed" : ""}`}>
        <Checkbox
          checked={form.emailManagedByAdmins}
          disabled={disabled}
          onCheckedChange={handleEmailManagedChange}
          data-testid="sso-saml-email-managed"
        />
        <span className="min-w-0">
          <span className={`block text-subhead font-semibold ${disabled ? "text-foreground-disabled" : "text-foreground"}`}>
            {formatMessage({ id: "settings.sso.emailManagedByAdmins" })}
          </span>
          <span className="mt-0.5 block text-footnote text-foreground-muted">
            {formatMessage({ id: "settings.sso.emailManagedByAdminsHint" })}
          </span>
        </span>
      </label>
    </>
  );
}
