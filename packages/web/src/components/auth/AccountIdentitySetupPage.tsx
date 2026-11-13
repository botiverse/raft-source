import { useCallback, useEffect, useState } from "react";
import { Input, InputGroup, InputGroupAddon, InputGroupInput, Button } from "@botiverse/raft-ui";
import type { ChangeEvent, FormEvent, ReactNode } from "react";
import { useIntl } from "react-intl";
import { validateNameReason } from "@botiverse/raft-shared";
import type { NameValidationReason } from "@botiverse/raft-shared";
import { Hash } from "lucide-react";
import { useAuthStore } from "../../store/authStore";
import type { User } from "../../store/authStore";
import type { MessageId } from "../../i18n/messages";
import api from "../../api/client";
import AvatarSlot from "../ui/AvatarSlot";
import { HumanAvatarEditMenu } from "../member/HumanAvatarEditMenu";
import { isHumanPixelAvatarUrl } from "../../utils/humanAvatar";
import Banner from "../ui/Banner";
import FormField from "../ui/FormField";
import { AuthPageIntro } from "./AuthPageFrame";
import OnboardingCreateShell from "./OnboardingCreateShell";
import { authServerErrorMessage } from "./authErrors";
import { avatarUploadApiErrorMessage, isAvatarFileTooLarge, isAvatarTooLargeError } from "../../utils/avatarUpload";
import { formatNameValidationError } from "../../i18n/nameValidation";
import { useOptionalAppTheme } from "../../hooks/useAppTheme";
import { hasDeviceThemePreference } from "../../theme/appThemeCache";
import { markOnboardingDisplayStylePending } from "../../utils/onboardingDisplayStyle";

const DISPLAY_NAME_MAX_LENGTH = 64;

// Returns a REASON, not a sentence. The struct that used to live here held seven
// English strings and typechecked forever, because a struct of strings is
// exactly as valid when the strings are copy as when they are ids. The whole
// auth block hit this shape repeatedly.
//
// The codes deliberately match @botiverse/raft-shared's NameValidationReason, so the
// display name reuses the same `validation.name.*` sentences as every other
// name field instead of minting a second pair that says the same thing.
function validateDisplayName(displayName: string): NameValidationReason | null {
  const trimmed = displayName.trim();
  if (!trimmed) return { code: "required" };
  if (trimmed.length > DISPLAY_NAME_MAX_LENGTH) {
    return { code: "tooLong", maxLength: DISPLAY_NAME_MAX_LENGTH };
  }
  return null;
}

type IdentitySetupError = {
  onboardingStep?: "avatar" | "profile";
  response?: { data?: { error?: unknown } };
};

function identitySetupError(error: unknown): IdentitySetupError {
  return typeof error === "object" && error !== null ? error as IdentitySetupError : {};
}

function PreviewAvatar({
  avatarPreviewUrl,
  persistedAvatarUrl,
  safeOnly,
  size,
}: {
  avatarPreviewUrl: string | null;
  persistedAvatarUrl: string | null;
  safeOnly: boolean;
  size: number;
}) {
  const src = !safeOnly && avatarPreviewUrl ? avatarPreviewUrl : persistedAvatarUrl;
  // A built pixel avatar (a new account's) is drawn by AvatarSlot itself; a
  // photo (a chosen file's local preview, the provider's) as an image.
  const image = src && !isHumanPixelAvatarUrl(src) ? src : null;
  return (
    <AvatarSlot
      context={size === 28 ? "compact-row" : "account-tile"}
      type="human"
      humanAvatarUrl={src}
    >
      {image ? <img src={image} alt="" className="h-full w-full object-cover" /> : undefined}
    </AvatarSlot>
  );
}

function IdentityImpactPreview({
  avatarPreviewUrl,
  persistedAvatarUrl,
  displayName,
  handle,
  safeOnly,
}: {
  avatarPreviewUrl: string | null;
  persistedAvatarUrl: string | null;
  displayName: string;
  handle: string;
  safeOnly: boolean;
}) {
  const { formatMessage } = useIntl();
  // Sample identity shown before the user types anything. These are COPY, not
  // fixtures: they render on a first-run screen, so a zh user meets an English
  // stand-in name. Whether the sample person should also be renamed per locale
  // is a wording call — flagged for @AngLee rather than decided here.
  const previewDisplayName = displayName.trim() || formatMessage({ id: "pages.identitySetup.previewSampleName" });
  const previewHandle = handle.trim() || formatMessage({ id: "pages.identitySetup.previewSampleHandle" });
  const previewAvatarKey = avatarPreviewUrl ?? persistedAvatarUrl;

  return (
    <div
      className="relative z-raised min-h-[520px] w-full max-w-[640px] p-4 sm:p-6"
      data-testid="identity-impact-preview"
    >
      <div className="relative flex h-full min-h-[460px] items-center justify-center">
        <div className="w-[min(100%,520px)]">
          <div className="relative pb-24" data-testid="identity-preview-cardzone">
            <section
              className="onboarding-identity-card-enter relative z-raised w-[min(92%,480px)] rotate-[-1deg] overflow-hidden rounded-container border-[1.5px] border-line-strong bg-layer-canvas shadow-sticker [--identity-card-rotate:-1deg]"
              data-testid="identity-channel-preview"
            >
              <header className="flex h-12 md:pointer-fine:h-(--header-height) items-center gap-2 border-b border-line-seam bg-layer-canvas px-4">
                <span className="flex size-[27px] items-center justify-center rounded-chip border-[1.5px] border-sticker-ink bg-brand text-sticker-ink">
                  <Hash size={14} />
                </span>
                <span className="truncate text-headline text-foreground">
                  {formatMessage({ id: "pages.identitySetup.previewChannel" })}
                </span>
              </header>
              <div className="stack-y-4 p-4">
                <div className="flex items-start gap-2.5">
                  <div className="mt-px flex size-[27px] shrink-0 items-center justify-center rounded-sticker border-[1.5px] border-sticker-ink bg-palette-lavender text-footnote font-bold text-sticker-ink shadow-[0_0_0_1.5px_var(--sticker-edge)]">
                    M
                  </div>
                  <div className="min-w-0">
                    <div className="text-footnote font-bold text-foreground">
                      {formatMessage({ id: "pages.identitySetup.previewSenderName" })}
                    </div>
                    <div className="mt-0.5 text-callout text-foreground" data-testid="identity-seeded-message-copy">
                      {/* ONE message. The mention sits mid-sentence and zh puts it
                          elsewhere, so splitting this into "morning — can" +
                          mention + "take a look…" would bake English word order
                          into every translation. */}
                      {formatMessage(
                        { id: "pages.identitySetup.previewSeededMessage" },
                        {
                          handle: previewHandle,
                          mention: (chunks: ReactNode) => (
                            // The key is the HANDLE, not the tag name, and that is
                            // load-bearing: changing it remounts the span so the
                            // `onboarding-identity-pop` animation replays as the
                            // user types. Keying it "mention" is stable, renders
                            // identically, and silently kills the animation — a
                            // behavior test catches it, no i18n guard would.
                            <span
                              key={previewHandle}
                              className="onboarding-identity-pop inline-block rounded-sticker bg-brand px-[3px] font-semibold text-sticker-ink shadow-[inset_0_0_0_1.5px_var(--sticker-ink)]"
                              data-testid="identity-seeded-mention"
                            >
                              {chunks}
                            </span>
                          ),
                        },
                      )}
                    </div>
                  </div>
                </div>
                <div
                  className="flex items-start gap-2.5"
                  data-testid="identity-user-message-preview"
                >
                  <div
                    key={`${previewDisplayName}:${previewAvatarKey}:message-avatar`}
                    className="onboarding-identity-pop mt-px size-[27px] shrink-0"
                    data-testid="identity-user-message-avatar"
                  >
                    <PreviewAvatar
                      avatarPreviewUrl={avatarPreviewUrl}
                      persistedAvatarUrl={persistedAvatarUrl}
                      safeOnly={safeOnly}
                      size={28}

                    />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
                      <span
                        key={`${previewDisplayName}:message-name`}
                        className="onboarding-identity-pop inline-block max-w-full truncate text-footnote font-bold text-foreground"
                        data-testid="identity-user-message-name"
                      >
                        {previewDisplayName}
                      </span>
                      <span className="font-mono text-mono-meta text-foreground-hint">
                        {formatMessage({ id: "pages.identitySetup.previewTimestamp" })}
                      </span>
                    </div>
                    <p className="mt-0.5 text-callout text-foreground">
                      {formatMessage({ id: "pages.identitySetup.previewReply" })}
                    </p>
                  </div>
                </div>
              </div>
            </section>

            <section
              className="onboarding-identity-card-enter absolute bottom-2 right-0 z-raised w-[min(78%,360px)] rotate-[2deg] rounded-container border-[1.5px] border-line-strong bg-layer-popover p-4 shadow-sticker [--identity-card-delay:80ms] [--identity-card-rotate:2deg]"
              data-testid="identity-profile-preview"
            >
              <div className="flex items-start gap-3">
                <div
                  key={`${previewDisplayName}:${previewAvatarKey}:profile-avatar`}
                  className="onboarding-identity-pop size-[51px] shrink-0"
                  data-testid="identity-profile-avatar"
                >
                  <PreviewAvatar
                    avatarPreviewUrl={avatarPreviewUrl}
                    persistedAvatarUrl={persistedAvatarUrl}
                    safeOnly={safeOnly}
                    size={56}

                  />
                </div>
                <div className="min-w-0 flex-1">
                  <div
                    key={`${previewDisplayName}:profile-name`}
                    className="onboarding-identity-pop truncate text-headline text-foreground"
                    data-testid="identity-profile-name"
                  >
                    {previewDisplayName}
                  </div>
                  <div className="font-mono text-mono-meta text-foreground-hint" data-testid="identity-profile-handle">
                    <span
                      key={`${previewHandle}:profile-handle`}
                      className="onboarding-identity-pop inline-block"
                      data-testid="identity-profile-handle-value"
                    >
                      @{previewHandle}
                    </span>
                  </div>
                </div>
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function AccountIdentitySetupPage({
  previewUser,
  onPreviewComplete,
}: {
  previewUser?: User;
  onPreviewComplete?: (name: string, displayName: string, avatarFile?: File | null) => Promise<void>;
} = {}) {
  const { formatMessage } = useIntl();
  const storeUser = useAuthStore((state) => state.user);
  const storeCompleteOnboardingProfile = useAuthStore((state) => state.completeOnboardingProfile);
  const loading = useAuthStore((state) => state.loading);
  const user = previewUser ?? storeUser;
  const completeOnboardingProfile = onPreviewComplete ?? storeCompleteOnboardingProfile;
  // The dev/fixture preview has no real session, so it opts out of the shell's
  // sign-out affordance.
  const previewMode = onPreviewComplete != null;
  // Task #247: a new account sees light until it picks a style later in
  // onboarding. Only when this browser has no choice yet; an existing choice
  // is the user's and is left alone, and they are not asked again.
  const appTheme = useOptionalAppTheme();
  const setThemeMode = appTheme?.setMode;
  useEffect(() => {
    if (previewMode || !setThemeMode || hasDeviceThemePreference()) return;
    // A brand-new account starts in light; onboarding offers the choice later.
    setThemeMode("light");
    markOnboardingDisplayStylePending();
  }, [previewMode, setThemeMode]);
  const [displayName, setDisplayName] = useState(user?.displayName ?? "");
  // The display name mirrors the username as you type it — until the user edits
  // the display name themselves, at which point it detaches and keeps its own
  // value (same pattern as server name → server slug). A pre-filled display
  // name (e.g. from an OAuth provider) counts as already-edited so we never
  // clobber it.
  const [displayNameEdited, setDisplayNameEdited] = useState(Boolean(user?.displayName));
  const [handle, setHandle] = useState(user?.profileSetupProvider ? user.profileSetupSuggestedHandle ?? "" : "");
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarPreviewUrl, setAvatarPreviewUrl] = useState<string | null>(null);
  const [avatarUploadFailed, setAvatarUploadFailed] = useState(false);
  const [avatarError, setAvatarError] = useState("");
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<{ displayName?: string; handle?: string }>({});
  const provider = user?.profileSetupProvider ?? null;

  const nameError = useCallback(
    (reason: NameValidationReason | null, label: MessageId) =>
      formatNameValidationError(reason, label, formatMessage),
    [formatMessage],
  );
  const avatarUploadErrorMessage = (error: unknown) => {
    // The size code must be mapped BEFORE the generic API-error path. This page
    // calls completeOnboardingProfile, which throws AVATAR_TOO_LARGE_CODE for an
    // oversized avatar; avatarUploadApiErrorMessage then returns error.message,
    // so the raw string "AVATAR_TOO_LARGE" would render inside the Chinese
    // sentence. Trading English for an identifier is a worse outcome than the
    // bug this whole change set is fixing.
    if (isAvatarTooLargeError(error)) {
      return formatMessage({ id: "avatar.tooLarge" }, { maxLabel: formatMessage({ id: "common.fileSize.maxLabel5mb" }) });
    }
    return formatMessage(
      { id: "pages.identitySetup.avatarUploadError" },
      { reason: avatarUploadApiErrorMessage(error, formatMessage({ id: "pages.identitySetup.avatarUploadFallback" })) },
    );
  };

  useEffect(() => {
    return () => {
      if (avatarPreviewUrl) URL.revokeObjectURL(avatarPreviewUrl);
    };
  }, [avatarPreviewUrl]);

  const stageAvatarFile = useCallback((file: File | null) => {
    setAvatarError("");
    setAvatarUploadFailed(false);
    // The util's *Error form returns an English sentence; using it as a
    // predicate keeps the copy here, in the catalog.
    const tooLarge = file ? isAvatarFileTooLarge(file) : false;
    if (tooLarge) {
      setAvatarError(formatMessage({ id: "avatar.tooLarge" }, { maxLabel: formatMessage({ id: "common.fileSize.maxLabel5mb" }) }));
      setAvatarFile(null);
      setAvatarPreviewUrl((current) => {
        if (current) URL.revokeObjectURL(current);
        return null;
      });
      return;
    }
    setAvatarFile(file);
    setAvatarPreviewUrl((current) => {
      if (current) URL.revokeObjectURL(current);
      return file ? URL.createObjectURL(file) : null;
    });
  }, [formatMessage]);

  // Validate the display name on blur (not just on Continue) so format errors
  // surface as soon as the user leaves the field.
  const handleDisplayNameBlur = useCallback(() => {
    setFieldErrors((current) => ({
      ...current,
      displayName: nameError(validateDisplayName(displayName), "pages.identitySetup.displayNameLabel") ?? undefined,
    }));
  }, [displayName, nameError]);

  // On-blur username validation: run the hard-constraint (format) check FIRST
  // and surface it immediately; only if the format is valid do we hit the
  // uniqueness precheck. Both run on blur, not just on Continue. The uniqueness
  // call is advisory — completeProfile still enforces it authoritatively.
  const handleHandleChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const nextHandle = event.target.value.replace(/^@+/, "");
    setHandle(nextHandle);
    // Mirror into the display name until the user takes it over.
    if (!displayNameEdited) {
      setDisplayName(nextHandle);
      setFieldErrors((current) => ({ ...current, displayName: undefined }));
    }
    setFieldErrors((current) => ({ ...current, handle: undefined }));
  }, [displayNameEdited]);

  const handleDisplayNameChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setDisplayName(event.target.value);
    // Manual edit detaches the display name from the username mirror.
    setDisplayNameEdited(true);
    setFieldErrors((current) => ({ ...current, displayName: undefined }));
  }, []);

  // A built avatar is saved by the builder itself, replacing the avatar: a
  // photo chosen before it is dropped, so Continue doesn't upload over it.
  const handleAvatarBuilt = useCallback(() => stageAvatarFile(null), [stageAvatarFile]);

  const handleUsernameBlur = useCallback(async () => {
    const candidate = handle.trim();
    const formatError = nameError(validateNameReason(candidate, 5), "pages.identitySetup.usernameLabel");
    if (formatError) {
      setFieldErrors((current) => ({ ...current, handle: formatError }));
      return;
    }
    try {
      const { data } = await api.get<{ available: boolean; message?: string }>(
        "/auth/me/username-available",
        { params: { name: candidate } },
      );
      if (!data.available) {
        setFieldErrors((current) => ({
          ...current,
          // Server text wins when present — it is often the only actionable detail.
          handle: data.message ?? formatMessage({ id: "pages.identitySetup.usernameTaken" }),
        }));
      }
    } catch {
      // Best-effort precheck; a failure here must not block the user — submit validates.
    }
  }, [handle, formatMessage, nameError]);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    setFieldErrors({});

    const displayNameError = nameError(validateDisplayName(displayName), "pages.identitySetup.displayNameLabel");
    const handleError = nameError(validateNameReason(handle, 5), "pages.identitySetup.usernameLabel");
    if (displayNameError || handleError) {
      setFieldErrors({
        displayName: displayNameError ?? undefined,
        handle: handleError ?? undefined,
      });
      return;
    }
    if (avatarError) return;

    try {
      setAvatarError("");
      await completeOnboardingProfile(handle.trim(), displayName.trim(), avatarFile);
    } catch (error) {
      if (identitySetupError(error).onboardingStep === "avatar") {
        setAvatarUploadFailed(true);
        setAvatarError(avatarUploadErrorMessage(error));
      } else {
        setError(authServerErrorMessage(error, formatMessage({ id: "pages.identitySetup.finishError" }), formatMessage));
      }
    }
  };

  if (!user) return null;

  const providerLabel = provider === "google"
    ? "Google"
    : provider === "github"
      ? "GitHub"
      : provider === "apple"
        ? "Apple"
        : null;
  // Stryker disable next-line StringLiteral: the label only affects validation copy; pin visibility depends on valid/invalid.

  return (
    <OnboardingCreateShell
      showSessionFooter={!previewMode}
      previewTestId="identity-preview-pane"
      preview={
        <IdentityImpactPreview
          avatarPreviewUrl={avatarPreviewUrl}
          persistedAvatarUrl={user.avatarUrl}
          displayName={displayName}
          handle={handle}
          safeOnly={avatarUploadFailed}
        />
      }
    >
      <>
        <div>
          {/* The session line lives in the shell's footer, with every other page's. */}
          <AuthPageIntro
            title={formatMessage({
              id: providerLabel ? "pages.identitySetup.titleConfirm" : "pages.identitySetup.titleSetup",
            })}
          />
        </div>

        {error ? <Banner intent="warning">{error}</Banner> : null}

        <form onSubmit={handleSubmit} className="stack-y-4 md:pointer-fine:stack-y-3" noValidate>
              <FormField label={formatMessage({ id: "pages.identitySetup.usernameLabel" })} error={fieldErrors.handle} htmlFor="identity-handle">
                {/* The `@` is a fixed prefix of the same control (DS rf-inputgroup),
                    not a coloured block of its own. */}
                <InputGroup className="w-full">
                  <InputGroupAddon.Text variant="container">@</InputGroupAddon.Text>
                  <InputGroupInput
                    id="identity-handle"
                    name="username"
                    type="text"
                    value={handle}
                    onChange={handleHandleChange}
                    onBlur={handleUsernameBlur}
                    placeholder={formatMessage({ id: "pages.identitySetup.previewSampleHandle" })}
                    autoComplete="username"
                    data-invalid={fieldErrors.handle ? true : undefined}
                    required
                  />
                </InputGroup>
                <p className="mt-1.5 text-caption text-foreground-hint">
                  {formatMessage({ id: "pages.identitySetup.usernameHelper" })}
                </p>
              </FormField>

              <FormField label={formatMessage({ id: "pages.identitySetup.displayNameLabel" })} error={fieldErrors.displayName} htmlFor="identity-display-name">
                <Input
                  id="identity-display-name"
                  name="name"
                  type="text"
                  value={displayName}
                  // Stryker disable next-line BlockStatement: validation-clear behavior is covered; the empty-handler mutant hangs the focused runner.
                  onChange={handleDisplayNameChange}
                  onBlur={handleDisplayNameBlur}
                  placeholder={formatMessage({ id: "pages.identitySetup.displayNamePlaceholder" })}
                  autoComplete="name"
                  required
                />
                <p className="mt-1.5 text-caption text-foreground-hint">
                  {formatMessage({ id: "pages.identitySetup.displayNameHelper" })}
                </p>
              </FormField>

              <div>
                <div className="mb-1.5 text-footnote font-semibold text-foreground-muted">
                  {formatMessage({ id: "pages.identitySetup.avatarLabel" })}
                </div>
                <div>
                  <div className="flex items-center gap-3">
                    {/* The avatar is the way to change it (pencil veil → Upload a
                        photo / Build an avatar). A chosen photo uploads with
                        Continue; a built one is saved by the builder. */}
                    <HumanAvatarEditMenu
                      testId="identity-avatar-edit"
                      context="account-tile"
                      avatarUrl={user.avatarUrl}
                      busy={loading && avatarFile !== null}
                      onUpload={stageAvatarFile}
                      onBuilt={handleAvatarBuilt}
                      avatar={(
                        <PreviewAvatar
                          avatarPreviewUrl={avatarPreviewUrl}
                          persistedAvatarUrl={user.avatarUrl}
                          safeOnly={avatarUploadFailed}
                          size={56}
                        />
                      )}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-caption text-foreground-hint">
                        {formatMessage({
                          id: provider
                            ? "pages.identitySetup.avatarOauthHelper"
                            : "pages.identitySetup.avatarDefaultHelper",
                        })}
                      </p>
                    </div>
                  </div>
                  {avatarError ? <p className="mt-2 text-caption font-semibold text-warning-strong" role="alert">{avatarError}</p> : null}
                </div>
              </div>

              <Button
                type="submit"
                disabled={loading}
                size="xl"
                variant="accent"
                className="w-full"
              >
                {formatMessage({
                  id: loading ? "pages.identitySetup.saving" : "pages.identitySetup.submit",
                })}
              </Button>
        </form>
      </>
    </OnboardingCreateShell>
  );
}
