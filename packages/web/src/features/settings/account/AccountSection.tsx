import { Badge, Button, Input, ListRow, ListRowBody, ListRowDescription, ListRowGroup, ListRowTitle } from "@botiverse/raft-ui";
import { useCallback, useId, useState, useEffect, useMemo, useRef } from "react";
import type { ChangeEvent, FormEvent } from "react";
import { Check, ChevronDown, Plug, User, Shield } from "lucide-react";
import { useAuthStore } from "../../../store/authStore";
import ConfirmDialog from "../../../components/ConfirmDialog";
import Banner from "../../../components/ui/Banner";
import api from "../../../api/client";
import {
  cancelDesktopOAuthAttempt,
  describeDesktopSignInFailure,
  getDesktopAuth,
  providerErrorCodeFromFailure,
  runDesktopAccountLink,
  useDesktopOAuthWaiting,
} from "../../../utils/desktopOAuth";
import { useIntl } from "react-intl";
import {
  avatarUploadApiErrorMessage,
  isAvatarFileTooLarge,
  isAvatarTooLargeError,
} from "../../../utils/avatarUpload";
import SectionHeader from "../../../components/ui/SectionHeader";
import FormField from "../../../components/ui/FormField";
import { HumanAvatarEditMenu } from "../../../components/member/HumanAvatarEditMenu";
import { PrefixedInput } from "../../../components/ui/SlugInput";
import { useAuthProviders } from "../../../hooks/useAuthProviders";
import type { AuthProvider, SocialAuthProviderId } from "../../../hooks/useAuthProviders";
import SettingsProfileCard from "../../../components/settings/SettingsProfileCard";
import { ProviderAccountRow } from "../../../components/settings/ProviderAccountRow";
import PasskeysSection from "../../../components/settings/PasskeysSection";
import TwoStepVerificationSection from "../../../components/settings/TwoStepVerificationSection";
import { isSecondFactorStepUpCancelled, withSecondFactorStepUp } from "../../../components/settings/secondFactorStepUp";
import { AccountSignOutSection } from "./AccountSignOutSection";
import { AppLoginsSection } from "./AppLoginsSection";
import { DeleteAccountSection } from "./DeleteAccountSection";
import { UsageDataSettingsCard } from "../../../components/settings/UsageDataSettings";

// Exported for the sub-batch-A i18n DOM smoke test: renders the Account section
// in isolation.
export function AccountSection({
  initialError,
  passwordChangeIntent = false,
}: {
  initialError?: string;
  passwordChangeIntent?: boolean;
} = {}) {
  const { formatMessage } = useIntl();
  const user = useAuthStore((s) => s.user);
  const updateProfile = useAuthStore((s) => s.updateProfile);
  const uploadAvatar = useAuthStore((s) => s.uploadAvatar);
  const { providers } = useAuthProviders();
  const signOutHeadingRef = useRef<HTMLDivElement | null>(null);

  const [displayName, setDisplayName] = useState(user?.displayName || "");
  const [savedDisplayName, setSavedDisplayName] = useState(user?.displayName || "");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(initialError ?? "");
  const [linkedIdentities, setLinkedIdentities] = useState<Record<string, { providerEmail: string | null }>>({});
  const [passwordConfigured, setPasswordConfigured] = useState<boolean | null>(null);
  const [linkingProviderId, setLinkingProviderId] = useState<SocialAuthProviderId | null>(null);
  // The latest Connect click: an earlier one (superseded on desktop) must not reset its state.
  const linkRequestRef = useRef(0);
  const desktopOAuthWaiting = useDesktopOAuthWaiting();
  const [pendingDisconnectProvider, setPendingDisconnectProvider] = useState<AuthProvider | null>(null);
  const [passwordSetupLoading, setPasswordSetupLoading] = useState(false);
  const [passwordSetupError, setPasswordSetupError] = useState("");
  const [passwordSetupEmailSent, setPasswordSetupEmailSent] = useState(false);
  const [passwordSetupSentForProvider, setPasswordSetupSentForProvider] = useState<AuthProvider | null>(null);
  const [avatarSaving, setAvatarSaving] = useState(false);
  const [avatarError, setAvatarError] = useState("");

  // Password change
  const [showPasswordChange, setShowPasswordChange] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [passwordSaved, setPasswordSaved] = useState(false);

  // User-scoped form re-sync (NOT server-scoped, so the future
  // SettingsPanel key-remount-by-server follow-up doesn't cover this).
  // Same FP family as Cluster 2/3 form-reset effects.
  // oxlint-disable-next-line react-doctor/no-cascading-set-state
  useEffect(() => {
    const nextDisplayName = user?.displayName || "";
    // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change
    setDisplayName(nextDisplayName);
    // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change
    setSavedDisplayName(nextDisplayName);
    // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change
    setSaved(false);
  }, [user?.id, user?.displayName]);

  useEffect(() => {
    let cancelled = false;

    async function loadIdentities() {
      try {
        const { data } = await api.get("/auth/identities");
        if (cancelled) return;
        const next: Record<string, { providerEmail: string | null }> = {};
        for (const identity of data.identities ?? []) {
          if (identity?.provider) {
            next[identity.provider] = { providerEmail: identity.providerEmail ?? null };
          }
        }
        setLinkedIdentities(next);
        setPasswordConfigured(data.passwordConfigured === true);
      } catch {
        if (!cancelled) {
          setLinkedIdentities({});
          setPasswordConfigured(null);
        }
      }
    }

    void loadIdentities();

    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  const visibleProviders = useMemo(
    () => providers.filter((provider) => provider.enabled || !!linkedIdentities[provider.id]),
    [linkedIdentities, providers],
  );
  const linkedProviderLabels = visibleProviders
    .filter((provider) => !!linkedIdentities[provider.id])
    .map((provider) => provider.label)
    .join(", ");
  const linkedIdentityCount = Object.keys(linkedIdentities).length;
  const passwordFormOpen = passwordChangeIntent || showPasswordChange;
  const passwordFormId = useId();
  const togglePasswordChange = useCallback(() => setShowPasswordChange((open) => !open), []);
  const pendingDisconnectRequiresPassword = !!pendingDisconnectProvider
    && linkedIdentityCount === 1
    && passwordConfigured === false;

  const applyAuthMethods = useCallback((data: {
    identities?: Array<{ provider?: string; providerEmail?: string | null }>;
    passwordConfigured?: boolean;
  }) => {
    const next: Record<string, { providerEmail: string | null }> = {};
    for (const identity of data.identities ?? []) {
      if (identity.provider) {
        next[identity.provider] = { providerEmail: identity.providerEmail ?? null };
      }
    }
    setLinkedIdentities(next);
    setPasswordConfigured(data.passwordConfigured === true);
  }, []);

  const handleConnectProvider = useCallback(async (provider: AuthProvider) => {
    const request = ++linkRequestRef.current;
    const current = () => linkRequestRef.current === request;
    setError("");
    setLinkingProviderId(provider.id);
    try {
      // Raft Desktop links through the loopback flow (the system browser that
      // finishes the provider leg lacks this session's state cookie).
      if (getDesktopAuth()) {
        // false: superseded by another Connect, or cancelled: nothing to say.
        const linked = await runDesktopAccountLink(provider.id, (start) => withSecondFactorStepUp(start, "signInMethod"));
        if (linked) {
          const { data: methods } = await api.get("/auth/identities");
          applyAuthMethods(methods);
        }
        if (current()) setLinkingProviderId(null);
        return;
      }
      // With two-step verification on, the step-up comes before leaving for the provider.
      const { data } = await withSecondFactorStepUp(() => api.post(`/auth/${provider.id}/link/start`, {
        returnTo: `${window.location.pathname}${window.location.search}`,
      }), "signInMethod");
      window.location.href = data.url;
    } catch (err: any) {
      if (!current()) return;
      // Closed "Verify it's you": nothing happened, nothing to say.
      if (isSecondFactorStepUpCancelled(err)) {
        setLinkingProviderId(null);
        return;
      }
      // A desktop loopback failure has no HTTP response; the provider leg's
      // reason (oauth_provider_error:<code>) still says what happened.
      setError(err.response?.data?.error
        || (!err?.response && providerErrorCodeFromFailure(err) ? describeDesktopSignInFailure(err, provider.label, formatMessage) : "")
        || formatMessage({ id: "settings.account.failedConnectProvider" }, { label: provider.label }));
      setLinkingProviderId(null);
    }
  }, [applyAuthMethods, formatMessage]);

  const handleRequestDisconnectProvider = useCallback((provider: AuthProvider) => {
    setPasswordSetupError("");
    setPasswordSetupSentForProvider(null);
    setPendingDisconnectProvider(provider);
  }, []);

  const handleDisconnectProvider = useCallback(async (provider: AuthProvider) => {
    try {
      const { data } = await withSecondFactorStepUp(() => api.delete(`/auth/identities/${provider.id}`), "signInMethod");
      applyAuthMethods(data);
      setPendingDisconnectProvider(null);
    } catch (err: unknown) {
      // Closed "Verify it's you": the confirmation closes, nothing changed, nothing to say.
      if (isSecondFactorStepUpCancelled(err)) return;
      const axiosError = err as { response?: { data?: { code?: string } } };
      if (axiosError.response?.data?.code === "PASSWORD_CREDENTIAL_REQUIRED") {
        try {
          const { data } = await api.get("/auth/identities");
          applyAuthMethods(data);
        } catch {
          setPasswordConfigured(false);
        }
      }
      throw err;
    }
  }, [applyAuthMethods]);

  const userEmail = user?.email;
  const handleSendPasswordSetup = useCallback(async (provider?: AuthProvider) => {
    setPasswordSetupError("");
    setPasswordSetupLoading(true);
    try {
      await api.post("/auth/forgot-password", { email: userEmail });
      setPasswordSetupEmailSent(true);
      setPasswordSetupSentForProvider(provider ?? null);
      setPendingDisconnectProvider(null);
    } catch (err: unknown) {
      const axiosError = err as { response?: { data?: { error?: string } } };
      setPasswordSetupError(axiosError.response?.data?.error || formatMessage({ id: "settings.account.failedSendPasswordSetup" }));
      if (provider) throw err;
    } finally {
      setPasswordSetupLoading(false);
    }
  }, [formatMessage, userEmail]);

  const handleSetPasswordByEmail = useCallback(() => {
    void handleSendPasswordSetup();
  }, [handleSendPasswordSetup]);

  const handleConfirmDisconnect = useCallback(() => {
    if (!pendingDisconnectProvider) return;
    return pendingDisconnectRequiresPassword
      ? handleSendPasswordSetup(pendingDisconnectProvider)
      : handleDisconnectProvider(pendingDisconnectProvider);
  }, [handleDisconnectProvider, handleSendPasswordSetup, pendingDisconnectProvider, pendingDisconnectRequiresPassword]);

  const handleCloseDisconnect = useCallback(() => setPendingDisconnectProvider(null), []);

  const handleDisplayNameChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    setDisplayName(e.target.value);
    setSaved(false);
  }, []);

  const handleCurrentPasswordChange = useCallback((e: ChangeEvent<HTMLInputElement>) => setCurrentPassword(e.target.value), []);
  const handleNewPasswordChange = useCallback((e: ChangeEvent<HTMLInputElement>) => setNewPassword(e.target.value), []);
  const handleConfirmPasswordChange = useCallback((e: ChangeEvent<HTMLInputElement>) => setConfirmPassword(e.target.value), []);

  const handleSaveProfile = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setSaving(true);
    setSaved(false);
    try {
      await updateProfile({ displayName });
      setSavedDisplayName(displayName);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err: any) {
      setError(err.response?.data?.error || formatMessage({ id: "settings.account.failedUpdateProfile" }));
    } finally {
      setSaving(false);
    }
  };

  const profileDirty = displayName !== savedDisplayName;

  const handleUploadAvatar = useCallback(async (file: File) => {
    if (isAvatarFileTooLarge(file)) {
      setAvatarError(formatMessage({ id: "avatar.tooLarge" }, { maxLabel: formatMessage({ id: "common.fileSize.maxLabel5mb" }) }));
      return;
    }
    setAvatarError("");
    setAvatarSaving(true);
    try {
      await uploadAvatar(file);
    } catch (err: any) {
      setAvatarError(isAvatarTooLargeError(err)
        ? formatMessage({ id: "avatar.tooLarge" }, { maxLabel: formatMessage({ id: "common.fileSize.maxLabel5mb" }) })
        : avatarUploadApiErrorMessage(err, formatMessage({ id: "settings.account.failedUploadAvatar" })));
    } finally {
      setAvatarSaving(false);
    }
  }, [formatMessage, uploadAvatar]);

  const clearAvatarError = useCallback(() => setAvatarError(""), []);

  const handleChangePassword = async (e: FormEvent) => {
    e.preventDefault();
    setPasswordError("");

    if (newPassword.length < 8) {
      setPasswordError(formatMessage({ id: "settings.account.newPasswordTooShort" }));
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError(formatMessage({ id: "settings.account.passwordsDoNotMatch" }));
      return;
    }

    setSaving(true);
    setPasswordSaved(false);
    try {
      await withSecondFactorStepUp(() => updateProfile({ currentPassword, newPassword }), "signInMethod");
      setPasswordSaved(true);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setTimeout(() => setPasswordSaved(false), 2000);
    } catch (err: any) {
      // Closed "Verify it's you": the form stays as it was, nothing to say.
      if (isSecondFactorStepUpCancelled(err)) return;
      setPasswordError(err.response?.data?.error || formatMessage({ id: "settings.account.failedChangePassword" }));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="mb-6">
        <SectionHeader
          className="mb-3"
          icon={<User size={16} />}
          label={formatMessage({ id: "settings.account.sectionLabel" })}
        />

        <SettingsProfileCard
          testId="account-profile-card"
          title={user?.displayName || user?.name || formatMessage({ id: "settings.account.sectionLabel" })}
          subtitle={user?.name ? `@${user.name}` : ""}
          avatar={
            <HumanAvatarEditMenu
              testId="account-avatar-edit"
              context="profile-tile"
              avatarUrl={user?.avatarUrl}
              busy={avatarSaving}
              onUpload={handleUploadAvatar}
              onBuilt={clearAvatarError}
            />
          }
        >
          {avatarError ? (
            <p className="text-caption text-danger-strong" role="alert">{avatarError}</p>
          ) : null}
          {/* Profile form */}
          <form onSubmit={handleSaveProfile} className="stack-y-3">
            <FormField id="display-name" label={formatMessage({ id: "settings.account.displayNameLabel" })} size="compact">
              <Input
                data-testid="account-profile-display-name-input"
                type="text"
                value={displayName}
                onChange={handleDisplayNameChange}
              />
            </FormField>
            <FormField id="username" label={formatMessage({ id: "settings.account.usernameLabel" })} size="compact">
              <PrefixedInput
                data-testid="account-profile-username-input"
                type="text"
                value={user?.name ?? ""}
                readOnly
                aria-readonly="true"
                tabIndex={-1}
                prefix="@"
                className="border-line-hairline bg-fill-muted shadow-none focus-within:shadow-none"
                inputClassName="cursor-default text-foreground-muted"
              />
            </FormField>
            <FormField id="email" label={formatMessage({ id: "settings.account.emailLabel" })} size="compact">
              <div className="flex items-center gap-2">
                <span className="min-w-0 truncate font-mono text-mono-code text-foreground">{user?.email}</span>
                {user?.emailVerified ? (
                  <Badge variant="success" appearance="soft">
                    <Shield size={10} /> {formatMessage({ id: "settings.account.verified" })}
                  </Badge>
                ) : (
                  <Badge variant="warning" appearance="soft">
                    {formatMessage({ id: "settings.account.unverified" })}
                  </Badge>
                )}
              </div>
            </FormField>

          {error && (
            <Banner intent="warning" density="sm">{error}</Banner>
          )}

            <Button
              type="submit"
              disabled={!profileDirty || saving}
              size="md"
              variant="accent"
            >
              {saving ? formatMessage({ id: "settings.common.saving" }) : saved ? (
                <><Check size={14} /> {formatMessage({ id: "settings.common.saved" })}</>
              ) : formatMessage({ id: "settings.account.saveProfile" })}
            </Button>
          </form>
        </SettingsProfileCard>

        {/* Password credential: settings rows under the profile card (DS Forms › A
            setting's row; cindyz, #proj-raft-ui:#220). Change password is a row that
            opens its form in a row of its own right under it. */}
        <ListRowGroup id="password" className="@container mt-3" data-testid="account-password-rows">
          {passwordChangeIntent && passwordConfigured === null ? (
            <ListRow variant="plain" interactive={false}>
              <ListRowBody>
                <ListRowDescription wrap role="status">
                  {formatMessage({ id: "settings.account.loadingSignInMethods" })}
                </ListRowDescription>
              </ListRowBody>
            </ListRow>
          ) : passwordChangeIntent && passwordConfigured === false ? (
            <ListRow variant="plain" interactive={false} data-testid="password-managed-by-provider">
              <ListRowBody>
                <ListRowTitle>{formatMessage({ id: "settings.account.passwordManagedTitle" })}</ListRowTitle>
                <ListRowDescription wrap>
                  {formatMessage(
                    { id: "settings.account.passwordManagedDescription" },
                    {
                      providers: linkedProviderLabels
                        || formatMessage({ id: "settings.account.connectedSignInProvider" }),
                    },
                  )}
                </ListRowDescription>
              </ListRowBody>
            </ListRow>
          ) : passwordConfigured === false ? (
            <ListRow variant="plain" interactive={false} className="@max-lg:flex-wrap">
              <ListRowBody>
                <ListRowTitle>{formatMessage({ id: "settings.account.setPassword" })}</ListRowTitle>
                <ListRowDescription wrap>{formatMessage({ id: "settings.account.setPasswordDescription" })}</ListRowDescription>
                {passwordSetupError && (
                  <Banner intent="warning" density="sm" className="mt-2">{passwordSetupError}</Banner>
                )}
                {passwordSetupEmailSent && !passwordSetupSentForProvider && (
                  <Banner intent="success" density="sm" className="mt-2">
                    {formatMessage({ id: "settings.account.passwordSetupEmailSent" })}
                  </Banner>
                )}
              </ListRowBody>
              {/* Where the row is narrow (under 32rem of its own width) the button goes under the text. */}
              <div className="shrink-0 @max-lg:basis-full">
                <Button
                  variant="accent" size="md"
                  type="button"
                  onClick={handleSetPasswordByEmail}
                  disabled={passwordSetupLoading}
                >
                  {passwordSetupLoading
                    ? formatMessage({ id: "settings.account.sendingSetupEmail" })
                    : formatMessage({ id: "settings.account.setPasswordByEmail" })}
                </Button>
              </div>
            </ListRow>
          ) : (
            // A disclosure, not a way to another page: ChevronDown, turned over while
            // the form is open (ListRowChevron is the "goes to a page" arrow).
            <ListRow
              variant="plain"
              onClick={togglePasswordChange}
              aria-expanded={passwordFormOpen}
              aria-controls={passwordFormOpen ? passwordFormId : undefined}
              data-testid="account-change-password-toggle"
            >
              <ListRowBody>
                <ListRowTitle>{formatMessage({ id: "settings.account.changePassword" })}</ListRowTitle>
              </ListRowBody>
              <span aria-hidden="true" className="flex shrink-0 items-center justify-center text-foreground-hint [&>svg]:size-5">
                <ChevronDown className={`transition-transform ${passwordFormOpen ? "rotate-180" : ""}`} />
              </span>
            </ListRow>
          )}

          {(!passwordChangeIntent || passwordConfigured === true) && passwordFormOpen && (
            <ListRow
              variant="plain"
              interactive={false}
              id={passwordFormId}
              role="region"
              aria-label={formatMessage({ id: "settings.account.changePassword" })}
              data-testid="account-password-form-row"
            >
              <ListRowBody render={<div />}>
                <form onSubmit={handleChangePassword} className="stack-y-3">
                  <FormField label={formatMessage({ id: "settings.account.currentPassword" })} size="compact">
                    <Input
                      type="password"
                      name="current-password"
                      autoComplete="current-password"
                      aria-label={formatMessage({ id: "settings.account.currentPassword" })}
                      value={currentPassword}
                      onChange={handleCurrentPasswordChange}
                      className="w-full"
                      required
                    />
                  </FormField>
                  <FormField label={formatMessage({ id: "settings.account.newPassword" })} size="compact">
                    <Input
                      type="password"
                      name="new-password"
                      autoComplete="new-password"
                      aria-label={formatMessage({ id: "settings.account.newPassword" })}
                      value={newPassword}
                      onChange={handleNewPasswordChange}
                      className="w-full"
                      placeholder={formatMessage({ id: "settings.account.minCharsPlaceholder" })}
                      required
                    />
                  </FormField>
                  <FormField label={formatMessage({ id: "settings.account.confirmPassword" })} size="compact">
                    <Input
                      type="password"
                      name="confirm-password"
                      autoComplete="new-password"
                      aria-label={formatMessage({ id: "settings.account.confirmPassword" })}
                      value={confirmPassword}
                      onChange={handleConfirmPasswordChange}
                      className="w-full"
                      required
                    />
                  </FormField>

                  <Banner intent="info" density="sm">{formatMessage({ id: "settings.account.deviceLoginNotice" })}</Banner>

                  {passwordError && (
                    <Banner intent="warning" density="sm">{passwordError}</Banner>
                  )}

                  {passwordSaved && (
                    <Banner intent="success" density="sm" role="status">{formatMessage({ id: "settings.account.passwordUpdated" })}</Banner>
                  )}

                  <Button
                    variant="accent" size="md"
                    type="submit"
                    disabled={saving}
                  >
                    {saving ? formatMessage({ id: "settings.account.updating" }) : formatMessage({ id: "settings.account.changePassword" })}
                  </Button>
                </form>
              </ListRowBody>
            </ListRow>
          )}
        </ListRowGroup>
      </div>

      {visibleProviders.length > 0 && (
        // Connected accounts: a section of their own, one row per provider.
        <div className="mb-6" data-testid="account-connected-accounts">
          <SectionHeader
            className="mb-3"
            icon={<Plug size={16} />}
            label={formatMessage({ id: "settings.account.connectedAccounts" })}
          />
          <ListRowGroup>
            {visibleProviders.map((provider) => (
              <ProviderAccountRow
                key={provider.id}
                provider={provider}
                identity={linkedIdentities[provider.id]}
                linking={linkingProviderId === provider.id}
                onCancelLinking={desktopOAuthWaiting?.kind === "link" && desktopOAuthWaiting.provider === provider.id ? cancelDesktopOAuthAttempt : undefined}
                onConnect={handleConnectProvider}
                onRequestDisconnect={handleRequestDisconnectProvider}
              />
            ))}
          </ListRowGroup>
          {passwordSetupSentForProvider && (
            <Banner intent="success" density="sm" className="mt-3">
              {formatMessage(
                { id: "settings.account.passwordSetupSentForProvider" },
                { label: passwordSetupSentForProvider.label },
              )}
            </Banner>
          )}
        </div>
      )}

      {pendingDisconnectProvider && (
        <ConfirmDialog
          title={formatMessage(
            {
              id: pendingDisconnectRequiresPassword
                ? "settings.account.passwordRequiredTitle"
                : "settings.account.disconnectTitle",
            },
            { label: pendingDisconnectProvider.label },
          )}
          message={formatMessage(
            {
              id: pendingDisconnectRequiresPassword
                ? "settings.account.passwordRequiredMessage"
                : "settings.account.disconnectMessage",
            },
            { label: pendingDisconnectProvider.label },
          )}
          confirmLabel={formatMessage({
            id: pendingDisconnectRequiresPassword
              ? "settings.account.sendSetupEmail"
              : "settings.account.disconnect",
          })}
          loadingLabel={formatMessage({
            id: pendingDisconnectRequiresPassword
              ? "settings.account.sendingSetupEmail"
              : "settings.account.disconnecting",
          })}
          confirmVariant={pendingDisconnectRequiresPassword
            ? "accent"
            : undefined}
          chromeLocale="active"
          onConfirm={handleConfirmDisconnect}
          onClose={handleCloseDisconnect}
        />
      )}

      {/* Passkeys and Two-step verification (#triage:#135, design D2): after
          the Account card and before Session, so Sign Out stays last. */}
      <PasskeysSection passwordConfigured={passwordConfigured} />
      <TwoStepVerificationSection passwordConfigured={passwordConfigured} />

      {/* Apps signed in to with the Raft account (RFC 079 phase 3a, design
          §4.2): nothing renders while the list is empty. Revoking the last
          one moves focus to the next section's heading. */}
      <AppLoginsSection emptiedFocus={signOutHeadingRef} />

      {/* Share usage data: its own section, before Session, so Delete Account
          stays last on the page. */}
      <UsageDataSettingsCard />

      {/* Sign out — sibling section so it gets its own mb-6 spacing and
          renders at the same indent level as Account / Browser / Server. */}
      <AccountSignOutSection headingRef={signOutHeadingRef} />

      {/* Delete Account (#triage:c3d9bd7c): the danger zone, last on the page. */}
      <DeleteAccountSection />
    </>
  );
}
