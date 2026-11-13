import { OAUTH_CLIENT_CATEGORIES } from "@botiverse/raft-shared";
import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectIcon,
  SelectItem,
  SelectItemIndicator,
  SelectItemText,
  SelectList,
  SelectTrigger,
  SelectValue,
  Textarea,
} from "@botiverse/raft-ui";
import { Upload } from "lucide-react";
import { useCallback, useMemo, useRef } from "react";
import type { ChangeEvent } from "react";
import { useIntl } from "react-intl";
import FormField from "../../ui/FormField";
import { AppWhenToUseField } from "../AppWhenToUseField";
import { CONNECTED_APP_CATEGORY_LABEL_ID } from "../../../features/apps/connected-apps/connectedAppCatalog";
import { ConnectedAppLogo } from "../ConnectedAppLogo";
import type { McpAppProfileDraft } from "./mcpAppApi";

/**
 * An MCP App's Profile: the ordinary App's profile fields (logo, name, homepage, category,
 * description, when to use), nothing added. The logo is uploaded and reset exactly as an ordinary
 * App's, once the App exists (`logo` is null before that).
 */
export function McpAppProfileSection({
  profile,
  onChange,
  logoUrl,
  seed,
  disabled,
  logo,
}: {
  profile: McpAppProfileDraft;
  onChange: (patch: Partial<McpAppProfileDraft>) => void;
  logoUrl: string | null;
  seed: string;
  disabled: boolean;
  /** Upload/reset for a saved App; null for a new one (register first, as for an ordinary App). */
  logo: { uploading: boolean; onUpload: (file: File) => void; onReset: () => void } | null;
}) {
  const { formatMessage } = useIntl();
  const logoInputRef = useRef<HTMLInputElement | null>(null);
  const handlePickLogo = useCallback(() => logoInputRef.current?.click(), []);
  const handleLogoFile = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) logo?.onUpload(file);
  }, [logo]);
  const categoryItems = useMemo(() => OAUTH_CLIENT_CATEGORIES.map((value) => ({
    value,
    label: formatMessage({ id: CONNECTED_APP_CATEGORY_LABEL_ID[value] }),
  })), [formatMessage]);
  const handleName = useCallback((event: ChangeEvent<HTMLInputElement>) => onChange({ name: event.target.value }), [onChange]);
  const handleHomepage = useCallback((event: ChangeEvent<HTMLInputElement>) => onChange({ homepageUrl: event.target.value }), [onChange]);
  const handleDescription = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => onChange({ description: event.target.value }), [onChange]);
  const handleWhenToUse = useCallback((event: ChangeEvent<HTMLInputElement>) => onChange({ whenToUse: event.target.value }), [onChange]);
  const handleCategory = useCallback((value: string | null) => onChange({ category: value ?? "" }), [onChange]);

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-[140px_minmax(0,1fr)]">
        <FormField
          label={formatMessage({ id: "settings.connectedApps.logoLabel" })}
         
          size="compact"
          // Only before the app exists, which is when there is no upload yet: how to get one (HelperText step 1).
          hint={logo ? undefined : formatMessage({ id: "settings.connectedApps.logoHintNew" })}
        >
          <div className="stack-y-2">
            <div className="flex h-[120px] w-[120px] items-center justify-center border-2 border-dashed border-line-strong bg-layer-sidebar">
              <ConnectedAppLogo name={profile.name || seed} logoUrl={logoUrl} seed={seed} size="lg" />
            </div>
            {logo ? (
              <div className="flex flex-wrap gap-2">
                <input
                  ref={logoInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/gif,image/webp"
                  className="hidden"
                  onChange={handleLogoFile}
                  data-testid="mcp-app-logo-input"
                />
                <Button type="button" onClick={handlePickLogo} disabled={logo.uploading} size="md">
                  <Upload size={14} />
                  {formatMessage({ id: logo.uploading ? "settings.connectedApps.uploading" : logoUrl ? "settings.connectedApps.change" : "settings.connectedApps.upload" })}
                </Button>
                {logoUrl ? (
                  <Button type="button" onClick={logo.onReset} disabled={logo.uploading} size="md">
                    {formatMessage({ id: "settings.connectedApps.reset" })}
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
        </FormField>
        <div className="stack-y-3">
          <FormField label={formatMessage({ id: "settings.connectedApps.appNameLabel" })} size="compact" required>
            <Input
              type="text"
              value={profile.name}
              onChange={handleName}
              className="w-full"
              placeholder={formatMessage({ id: "settings.mcpApp.profile.namePlaceholder" })}
              disabled={disabled}
              required
              data-testid="mcp-app-name"
            />
          </FormField>
          <FormField label={formatMessage({ id: "settings.connectedApps.homepageUrlFieldLabel" })} size="compact" optional>
            <Input
              type="url"
              value={profile.homepageUrl}
              onChange={handleHomepage}
              className="w-full"
              placeholder={formatMessage({ id: "settings.mcpApp.profile.homepagePlaceholder" })}
              disabled={disabled}
            />
          </FormField>
          <FormField label={formatMessage({ id: "settings.connectedApps.categoryLabel" })} size="compact" optional>
            <Select value={profile.category || null} onValueChange={handleCategory} items={categoryItems} disabled={disabled}>
              <SelectTrigger className="w-full" aria-label={formatMessage({ id: "settings.connectedApps.appCategoryAriaLabel" })}>
                <SelectValue placeholder={formatMessage({ id: "settings.connectedApps.categoryLabel" })} />
                <SelectIcon />
              </SelectTrigger>
              <SelectContent>
                <SelectList>
                  {categoryItems.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      <SelectItemText>{item.label}</SelectItemText>
                      <SelectItemIndicator />
                    </SelectItem>
                  ))}
                </SelectList>
              </SelectContent>
            </Select>
          </FormField>
        </div>
      </div>
      <FormField label={formatMessage({ id: "settings.connectedApps.descriptionLabel" })} size="compact" optional>
        <Textarea
          value={profile.description}
          onChange={handleDescription}
          rows={3}
          placeholder={formatMessage({ id: "settings.mcpApp.profile.descriptionPlaceholder" })}
          className="resize-none"
          disabled={disabled}
        />
      </FormField>
      {disabled ? null : <AppWhenToUseField value={profile.whenToUse} onChange={handleWhenToUse} />}
    </>
  );
}
