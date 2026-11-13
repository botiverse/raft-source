/**
 * The landing pages and the signed-out steps after sign-in, as App.tsx renders
 * them: each its own chunk, off the first download (landingPages.ts, which
 * main.tsx uses to start the one the address names at boot). App.tsx renders
 * each under `Landing` (components/auth/AuthBootstrapStatus.tsx).
 */
import { lazyPanel } from "../boot/deferredUi";
import {
  loadAccountDeletionCancelLinkPage,
  loadAccountIdentitySetupPage,
  loadAgentConnectionCallbackPage,
  loadAppLoginPage,
  loadAppSumoRedemptionPage,
  loadAppSumoServerCreationPage,
  loadChineseCommunityPage,
  loadDeviceLoginPage,
  loadDeviceLoginRevokePage,
  loadEmailVerificationPage,
  loadExternalInviteLandingPage,
  loadExternalInvitePage,
  loadForgotPasswordPage,
  loadHumanLoginSetupPage,
  loadIntegrationInvitePage,
  loadInviteAcceptPage,
  loadMobileDownloadChooserPage,
  loadRegisterPage,
  loadResetPasswordPage,
  loadSecondFactorRecoveryLinkPage,
  loadServerConnectRequestPage,
  loadSocialAuthCallbackPage,
  loadSsoAuthCallbackPage,
} from "./landingPages";

export const MobileDownloadChooserPage = lazyPanel(loadMobileDownloadChooserPage);
export const ChineseCommunityPage = lazyPanel(loadChineseCommunityPage);
export const AppSumoRedemptionPage = lazyPanel(loadAppSumoRedemptionPage);
export const AppSumoServerCreationPage = lazyPanel(loadAppSumoServerCreationPage);
export const DeviceLoginPage = lazyPanel(loadDeviceLoginPage);
export const DeviceLoginRevokePage = lazyPanel(loadDeviceLoginRevokePage);
export const SecondFactorRecoveryLinkPage = lazyPanel(loadSecondFactorRecoveryLinkPage);
export const AppLoginPage = lazyPanel(loadAppLoginPage);
export const HumanLoginSetupPage = lazyPanel(loadHumanLoginSetupPage);
export const IntegrationInvitePage = lazyPanel(loadIntegrationInvitePage);
export const ExternalInvitePage = lazyPanel(loadExternalInvitePage);
export const ExternalInviteLandingPage = lazyPanel(loadExternalInviteLandingPage);
export const ServerConnectRequestPage = lazyPanel(loadServerConnectRequestPage);
export const AgentConnectionCallbackPage = lazyPanel(loadAgentConnectionCallbackPage);
export const RegisterPage = lazyPanel(loadRegisterPage);
export const AccountIdentitySetupPage = lazyPanel(loadAccountIdentitySetupPage);
export const ForgotPasswordPage = lazyPanel(loadForgotPasswordPage);
export const ResetPasswordPage = lazyPanel(loadResetPasswordPage);
export const EmailVerificationPage = lazyPanel(loadEmailVerificationPage);
export const InviteAcceptPage = lazyPanel(loadInviteAcceptPage);
export const SocialAuthCallbackPage = lazyPanel(loadSocialAuthCallbackPage);
export const SsoAuthCallbackPage = lazyPanel(loadSsoAuthCallbackPage);
export const AccountDeletionCancelLinkPage = lazyPanel(loadAccountDeletionCancelLinkPage);
// Dev-only: a static import would still take its imports into the startup chunk.
export const AccountBootstrapPreviewPage = lazyPanel(() => import("./AccountBootstrapPreviewPage"));
