import { useEffect, useId, useRef, useState } from "react";
import type { ChangeEvent, FormEvent, ReactNode } from "react";
import { useIntl } from "react-intl";
import { validateNameReason } from "@botiverse/raft-shared";
import type { NameValidationReason } from "@botiverse/raft-shared";
import { Camera, Hash } from "lucide-react";
import { useAuthStore } from "../../store/authStore";
import type { User } from "../../store/authStore";
import type { MessageId } from "../../i18n/messages";
import api from "../../api/client";
import GravatarAvatar from "../member/GravatarAvatar";
import Banner from "../ui/Banner";
import Button from "../ui/Button";
import FormField from "../ui/FormField";
import { AuthPageIntro } from "./AuthPageFrame";
import OnboardingCreateShell from "./OnboardingCreateShell";
import { authServerErrorMessage } from "./authErrors";
import { avatarUploadApiErrorMessage, isAvatarFileTooLarge, isAvatarTooLargeError, PROFILE_AVATAR_ACCEPT } from "../../utils/avatarUpload";
import { formatNameValidationError } from "../../i18n/nameValidation";

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
  gravatarHash,
  email,
  safeOnly,
  size,
  iconSize,
}: {
  avatarPreviewUrl: string | null;
  persistedAvatarUrl: string | null;
  gravatarHash: string | null;
  email: string | null;
  safeOnly: boolean;
  size: number;
  iconSize: number;
}) {
  const src = !safeOnly && avatarPreviewUrl ? avatarPreviewUrl : persistedAvatarUrl;
  if (src) return <img src={src} alt="" className="h-full w-full object-cover" />;
  // The app's human default avatar: Gravatar when the account has one, otherwise
  // a User icon on the lavender placeholder background (same look as AvatarSlot
  // type="human"). Sized to its container so all avatars stay consistent.
  return (
    <div className="flex h-full w-full items-center justify-center bg-brutal-lavender text-black">
      <GravatarAvatar gravatarHash={gravatarHash} email={email} size={size} iconSize={iconSize} />
    </div>
  );
}

function IdentityImpactPreview({
  avatarPreviewUrl,
  persistedAvatarUrl,
  displayName,
  handle,
  gravatarHash,
  email,
  safeOnly,
}: {
  avatarPreviewUrl: string | null;
  persistedAvatarUrl: string | null;
  displayName: string;
  handle: string;
  gravatarHash: string | null;
  email: string | null;
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
      className="relative z-10 min-h-[520px] w-full max-w-[640px] p-4 sm:p-6"
      data-testid="identity-impact-preview"
    >
      <div className="relative flex h-full min-h-[460px] items-center justify-center">
        <div className="w-[min(100%,520px)]">
          <div className="relative pb-24" data-testid="identity-preview-cardzone">
            <section
              className="onboarding-identity-card-enter relative z-10 w-[min(92%,480px)] rotate-[-1deg] overflow-hidden border-2 border-black bg-white shadow-brutal-lg [--identity-card-rotate:-1deg]"
              data-testid="identity-channel-preview"
            >
              <header className="flex h-12 items-center gap-2 border-b-2 border-black bg-white px-4">
                <span className="flex size-7 items-center justify-center border-2 border-black bg-soft-signal">
                  <Hash size={15} />
                </span>
                <span className="truncate text-sm font-black">
                  {formatMessage({ id: "pages.identitySetup.previewChannel" })}
                </span>
              </header>
              <div className="space-y-4 p-4">
                <div className="flex items-start gap-2.5">
                  <div className="mt-px flex size-7 shrink-0 items-center justify-center border-2 border-black bg-brutal-lavender/70 text-[11px] font-black">
                    M
                  </div>
                  <div className="min-w-0">
                    <div className="text-xs font-bold text-black">
                      {formatMessage({ id: "pages.identitySetup.previewSenderName" })}
                    </div>
                    <div className="mt-0.5 text-xs leading-5 text-black/80" data-testid="identity-seeded-message-copy">
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
                              className="onboarding-identity-pop inline-block rounded-sm bg-soft-signal px-1 font-bold text-black"
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
                    className="onboarding-identity-pop mt-px size-7 shrink-0 overflow-hidden border-2 border-black"
                    data-testid="identity-user-message-avatar"
                  >
                    <PreviewAvatar
                      avatarPreviewUrl={avatarPreviewUrl}
                      persistedAvatarUrl={persistedAvatarUrl}
                      gravatarHash={gravatarHash}
                      email={email}
                      safeOnly={safeOnly}
                      size={28}
                      iconSize={14}
                    />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
                      <span
                        key={`${previewDisplayName}:message-name`}
                        className="onboarding-identity-pop inline-block max-w-full truncate text-xs font-bold text-black"
                        data-testid="identity-user-message-name"
                      >
                        {previewDisplayName}
                      </span>
                      <span className="font-mono text-[9.5px] font-bold uppercase text-black/35">
                        {formatMessage({ id: "pages.identitySetup.previewTimestamp" })}
                      </span>
                    </div>
                    <p className="mt-0.5 text-xs leading-5 text-black/80">
                      {formatMessage({ id: "pages.identitySetup.previewReply" })}
                    </p>
                  </div>
                </div>
              </div>
            </section>

            <section
              className="onboarding-identity-card-enter absolute bottom-2 right-0 z-20 w-[min(78%,360px)] rotate-[2deg] border-2 border-black bg-white p-4 shadow-brutal-lg [--identity-card-delay:80ms] [--identity-card-rotate:2deg]"
              data-testid="identity-profile-preview"
            >
              <div className="flex items-start gap-3">
                <div
                  key={`${previewDisplayName}:${previewAvatarKey}:profile-avatar`}
                  className="onboarding-identity-pop size-14 shrink-0 overflow-hidden border-2 border-black"
                  data-testid="identity-profile-avatar"
                >
                  <PreviewAvatar
                    avatarPreviewUrl={avatarPreviewUrl}
                    persistedAvatarUrl={persistedAvatarUrl}
                    gravatarHash={gravatarHash}
                    email={email}
                    safeOnly={safeOnly}
                    size={56}
                    iconSize={26}
                  />
                </div>
                <div className="min-w-0 flex-1">
                  <div
                    key={`${previewDisplayName}:profile-name`}
                    className="onboarding-identity-pop truncate text-base font-black"
                    data-testid="identity-profile-name"
                  >
                    {previewDisplayName}
                  </div>
                  <div className="font-mono text-xs font-bold text-black/50" data-testid="identity-profile-handle">
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
  const avatarInputId = useId();
  const avatarInputRef = useRef<HTMLInputElement | null>(null);
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

  const nameError = (reason: NameValidationReason | null, label: MessageId) =>
    formatNameValidationError(reason, label, formatMessage);
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

  const handleAvatarChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
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
      event.currentTarget.value = "";
      return;
    }
    setAvatarFile(file);
    setAvatarPreviewUrl((current) => {
      if (current) URL.revokeObjectURL(current);
      return file ? URL.createObjectURL(file) : null;
    });
  };

  // Validate the display name on blur (not just on Continue) so format errors
  // surface as soon as the user leaves the field.
  const handleDisplayNameBlur = () => {
    setFieldErrors((current) => ({
      ...current,
      displayName: nameError(validateDisplayName(displayName), "pages.identitySetup.displayNameLabel") ?? undefined,
    }));
  };

  // On-blur username validation: run the hard-constraint (format) check FIRST
  // and surface it immediately; only if the format is valid do we hit the
  // uniqueness precheck. Both run on blur, not just on Continue. The uniqueness
  // call is advisory — completeProfile still enforces it authoritatively.
  const handleUsernameBlur = async () => {
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
  };

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
          gravatarHash={user.gravatarHash}
          email={user.email}
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

        {error ? <Banner intent="warning" className="font-bold">{error}</Banner> : null}

        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
              <FormField label={formatMessage({ id: "pages.identitySetup.usernameLabel" })} labelStyle="plain" error={fieldErrors.handle} htmlFor="identity-handle">
                <div className="flex border-2 border-black bg-white shadow-brutal-sm transition-shadow duration-100 focus-within:shadow-brutal">
                  <span className="flex items-center border-r-2 border-black bg-soft-signal px-3 font-mono text-base font-bold text-black/60">@</span>
                  <input
                    id="identity-handle"
                    name="username"
                    type="text"
                    value={handle}
                    onChange={(event) => {
                      const nextHandle = event.target.value.replace(/^@+/, "");
                      setHandle(nextHandle);
                      // Mirror into the display name until the user takes it over.
                      if (!displayNameEdited) {
                        setDisplayName(nextHandle);
                        setFieldErrors((current) => ({ ...current, displayName: undefined }));
                      }
                      setFieldErrors((current) => ({ ...current, handle: undefined }));
                    }}
                    onBlur={() => void handleUsernameBlur()}
                    className="min-w-0 flex-1 p-2 text-base focus:outline-none"
                    placeholder={formatMessage({ id: "pages.identitySetup.previewSampleHandle" })}
                    autoComplete="username"
                    required
                  />
                </div>
                <p className="mt-1 text-xs text-black/55">
                  {formatMessage({ id: "pages.identitySetup.usernameHelper" })}
                </p>
              </FormField>

              <FormField label={formatMessage({ id: "pages.identitySetup.displayNameLabel" })} labelStyle="plain" error={fieldErrors.displayName} htmlFor="identity-display-name">
                <input
                  id="identity-display-name"
                  name="name"
                  type="text"
                  value={displayName}
                  // Stryker disable next-line BlockStatement: validation-clear behavior is covered; the empty-handler mutant hangs the focused runner.
                  onChange={(event) => {
                    setDisplayName(event.target.value);
                    // Manual edit detaches the display name from the username mirror.
                    setDisplayNameEdited(true);
                    setFieldErrors((current) => ({ ...current, displayName: undefined }));
                  }}
                  onBlur={handleDisplayNameBlur}
                  className="w-full border-2 border-black p-2 text-base shadow-brutal-sm focus:shadow-brutal focus:outline-none"
                  placeholder={formatMessage({ id: "pages.identitySetup.displayNamePlaceholder" })}
                  autoComplete="name"
                  required
                />
                <p className="mt-1 text-xs text-black/50">
                  {formatMessage({ id: "pages.identitySetup.displayNameHelper" })}
                </p>
              </FormField>

              <div>
                <div className="mb-1 text-sm font-bold text-black">
                  {formatMessage({ id: "pages.identitySetup.avatarLabel" })}
                </div>
                <div>
                  <div className="flex items-center gap-3">
                    <div className="size-14 shrink-0 overflow-hidden border-2 border-black shadow-brutal-sm">
                      <PreviewAvatar
                        avatarPreviewUrl={avatarPreviewUrl}
                        persistedAvatarUrl={user.avatarUrl}
                        gravatarHash={user.gravatarHash}
                        email={user.email}
                        safeOnly={avatarUploadFailed}
                        size={56}
                        iconSize={26}
                      />
                    </div>
                    <div className="min-w-0 flex-1">
                      <button
                        type="button"
                        className="btn-brutal-sm inline-flex items-center gap-1.5 bg-white px-3 py-1.5 text-sm disabled:opacity-50"
                        disabled={loading}
                        // Stryker disable next-line OptionalChaining: the visible button and hidden file input mount together; this stays defensive for ref timing.
                        onClick={() => avatarInputRef.current?.click()}
                      >
                        <Camera size={15} />
                        {formatMessage({
                          id: loading && avatarFile
                            ? "pages.identitySetup.avatarUploading"
                            : "pages.identitySetup.avatarCta",
                        })}
                      </button>
                      <input
                        ref={avatarInputRef}
                        id={avatarInputId}
                        type="file"
                        accept={PROFILE_AVATAR_ACCEPT}
                        className="sr-only"
                        onChange={handleAvatarChange}
                      />
                      <p className="mt-1 text-xs text-black/50">
                        {formatMessage({
                          id: provider
                            ? "pages.identitySetup.avatarOauthHelper"
                            : "pages.identitySetup.avatarDefaultHelper",
                        })}
                      </p>
                    </div>
                  </div>
                  {avatarError ? <p className="mt-2 text-xs font-bold text-brutal-red" role="alert">{avatarError}</p> : null}
                </div>
              </div>

              <Button
                type="submit"
                disabled={loading}
                size="lg"
                tone="pink"
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
