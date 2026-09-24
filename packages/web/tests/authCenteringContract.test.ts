import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { en } from "../src/i18n/messages/en";

const enMessages = en as Record<string, string>;
const repoRoot = resolve(import.meta.dirname, "..");

test("auth frame uses the same yellow top bar language as the mobile app", () => {
  const source = readFileSync(
    resolve(repoRoot, "src/components/brand/AuthBrandShell.tsx"),
    "utf8",
  );

  assert.match(
    source,
    /AUTH_BRAND_SHELL_CLASS =\s+"min-h-0 flex-1 overflow-y-auto bg-white font-display safe-top safe-bottom"/,
  );
  assert.match(source, /AUTH_BRAND_STACK_CLASS =\s+"flex min-h-full w-full flex-col"/);
  assert.match(source, /AUTH_BRAND_TOP_BAR_CLASS =/);
  assert.match(
    source,
    /flex h-panel-header shrink-0 items-center border-b-2 border-black bg-soft-signal px-4/,
  );
  assert.match(source, /import RaftBrandLockup from "\.\/RaftBrandLockup";/);
  // #123: force-dark brand-bar mechanism (cell B, verified on real Blink). The bar
  // itself must NOT opt out of browser auto/force-dark — under force-dark it darkens
  // to a dark brand bar (product goal: no bright-yellow bar in dark). Only the logo
  // subtree opts out via `color-scheme: only light`, which stops auto-dark from
  // inverting the SVG wordmark into an illegible smear and keeps its glyphs legible
  // on the dark bar. The opt-out must stay scoped to the logo: the bar class and the
  // shell class carry NO color-scheme (bar/content/body stay dark-capable, i.e. not a
  // full-surface force-light), and the bar keeps the default logo asset.
  assert.match(source, /<RaftBrandLockup className="h-5 w-auto \[color-scheme:only_light\]" \/>/);
  assert.doesNotMatch(source, /AUTH_BRAND_TOP_BAR_CLASS =\s+"[^"]*color-scheme/);
  assert.doesNotMatch(source, /AUTH_BRAND_SHELL_CLASS =\s+"[^"]*color-scheme/);
  assert.doesNotMatch(source, /raft-logo-mono-light/);
  assert.doesNotMatch(source, /bg-black|text-soft-signal/);
  assert.doesNotMatch(source, /WHERE HUMANS AND AI AGENTS COLLABORATE/);
  assert.ok(
    source.indexOf("<AuthBrandTopBar />") < source.indexOf("<div className={`w-full ${maxWidthClass}`}>"),
    "brand header must render before the centered form content",
  );
  assert.doesNotMatch(source, /absolute left-|pointer-events-none|top-4|fixed|justify-center">\s*<RaftBrandLockup/);
  assert.doesNotMatch(source, /pt-24|sm:pt-16|-translate-y|translate-y-0/);
});

test("AuthPageFrame delegates to the shared centered card frame", () => {
  const source = readFileSync(
    resolve(repoRoot, "src/components/auth/AuthPageFrame.tsx"),
    "utf8",
  );

  assert.match(source, /export \{ default, AuthBrandIntro as AuthPageIntro \} from "\.\.\/brand\/AuthBrandShell";/);
  assert.doesNotMatch(source, /absolute left-|pointer-events-none|top-4/);
});

test("shared auth brand shell provides the Sign In intro primitive", () => {
  const source = readFileSync(
    resolve(repoRoot, "src/components/brand/AuthBrandShell.tsx"),
    "utf8",
  );

  assert.match(source, /export function AuthBrandIntro/);
  assert.match(source, /src="\/brand\/raft-icon.svg"/);
  assert.match(source, /className="mx-auto mb-4 size-9"/);
  assert.doesNotMatch(source, /prefers-color-scheme:dark/);
  assert.match(source, /<h1 className="text-xl font-bold">\{title\}<\/h1>/);
});

test("provider logos stay matched to the fixed light auth buttons", () => {
  const source = readFileSync(
    resolve(repoRoot, "src/components/icons/ProviderLogos.tsx"),
    "utf8",
  );

  assert.match(
    source,
    /providerGithubUrl[\s\S]*?className=\{`\$\{className\} shrink-0`\}/,
  );
  assert.match(
    source,
    /providerGoogleUrl[\s\S]*?className=\{`\$\{className\} shrink-0`\}/,
  );
  assert.doesNotMatch(source, /prefers-color-scheme|:invert/);
});

test("shared Raft lockup keeps dark-mode adaptation page-scoped", () => {
  const lockup = readFileSync(
    resolve(repoRoot, "src/components/brand/RaftBrandLockup.tsx"),
    "utf8",
  );
  const authShell = readFileSync(
    resolve(repoRoot, "src/components/brand/AuthBrandShell.tsx"),
    "utf8",
  );
  const onboardingShell = readFileSync(
    resolve(repoRoot, "src/components/auth/OnboardingCreateShell.tsx"),
    "utf8",
  );
  const humanLoginSetup = readFileSync(
    resolve(repoRoot, "src/pages/HumanLoginSetupPage.tsx"),
    "utf8",
  );

  assert.match(lockup, /adaptToDarkMode = false/);
  assert.match(lockup, /adaptToDarkMode \? \([\s\S]*?raft-logo-mono-light\.svg/);
  assert.doesNotMatch(authShell, /<RaftBrandLockup[^>]*adaptToDarkMode/);
  assert.doesNotMatch(onboardingShell, /<RaftBrandLockup[^>]*adaptToDarkMode/);
  assert.match(humanLoginSetup, /<RaftBrandLockup[^>]*adaptToDarkMode/);
});

test("server picker uses the same branded centered card frame", () => {
  const source = readFileSync(
    resolve(repoRoot, "src/components/auth/ServerSelector.tsx"),
    "utf8",
  );

  assert.match(source, /import CenteredCardFrame from "\.\/CenteredCardFrame";/);
  assert.match(source, /import OnboardingCreateShell from "\.\/OnboardingCreateShell";/);
  assert.equal(source.split("<CenteredCardFrame>").length - 1, 2);
  assert.equal(source.split("<OnboardingCreateShell").length - 1, 1);
  assert.doesNotMatch(source, /SERVER_SELECTOR_SHELL_CLASS|SERVER_SELECTOR_CENTER_CLASS/);
  assert.doesNotMatch(source, /items-center justify-center bg-brutal-cream font-display p-4 safe-top overflow-y-auto/);
});

test("server picker lets the shared auth shell own long-list scrolling", () => {
  const source = readFileSync(
    resolve(repoRoot, "src/components/auth/ServerSelector.tsx"),
    "utf8",
  );

  assert.match(source, /data-testid="server-selector-list"/);
  assert.doesNotMatch(source, /max-h-\[calc\(100dvh-160px\)\]/);
  assert.doesNotMatch(source, /overflow-y-auto overscroll-contain/);
  assert.match(source, /className="mb-6 space-y-2"/);
  // Primary CTA is the shared Button primitive at full-width pink (#158).
  assert.match(source, /<Button[\s\S]*?tone="pink"[\s\S]*?className="w-full"/);
  assert.match(source, /className="mt-3 text-center"/);
});

test("auth primary actions use the pink primary color", () => {
  const deviceLogin = readFileSync(
    resolve(repoRoot, "src/pages/DeviceLoginPage.tsx"),
    "utf8",
  );
  const serverSelector = readFileSync(
    resolve(repoRoot, "src/components/auth/ServerSelector.tsx"),
    "utf8",
  );

  // Button copy migrated to the `pages.deviceLogin.*` react-intl catalog; the
  // pink primary buttons now carry the message ids rather than inline English.
  assert.match(deviceLogin, /className="btn-brutal block w-full bg-brutal-pink[\s\S]*?pages\.deviceLogin\.closePage/);
  assert.match(deviceLogin, /className="btn-brutal w-full bg-brutal-pink[\s\S]*?pages\.deviceLogin\.approve/);
  assert.doesNotMatch(deviceLogin, /btn-brutal(?:[^"]*)bg-soft-signal/);
  // Re-anchored on the message id: the label migrated to
  // `pages.serverSelector.createNewServerAction`, so the literal would match
  // nothing and this structural check (pink full-width Button primitive) would
  // have gone vacuous.
  assert.match(
    serverSelector,
    /<Button[\s\S]*?tone="pink"[\s\S]*?className="w-full"[\s\S]*?pages\.serverSelector\.createNewServerAction/,
  );
});

test("centered web pages use the shared auth frame without an outer brutal card", () => {
  for (const file of [
    "LoginPage.tsx",
    "ForgotPasswordPage.tsx",
    "ResetPasswordPage.tsx",
    "InviteAcceptPage.tsx",
    "EmailVerificationPage.tsx",
    "ServerSelector.tsx",
    "SocialAuthCallbackPage.tsx",
  ]) {
    const source = readFileSync(
      resolve(repoRoot, `src/components/auth/${file}`),
      "utf8",
    );

    assert.doesNotMatch(
      source,
      /w-full border-2 border-black bg-white p-8(?: text-center| text-center text-xl font-bold)? shadow-brutal/,
      `${file} must not wrap the auth surface in a heavy card`,
    );
  }
});

test("create-account screen uses the centered auth frame without preview chrome", () => {
  const registerSource = readFileSync(
    resolve(repoRoot, "src/components/auth/RegisterPage.tsx"),
    "utf8",
  );

  assert.match(registerSource, /import AuthPageFrame, \{ AuthPageIntro \} from "\.\/AuthPageFrame";/);
  assert.match(registerSource, /<AuthPageFrame>/);
  assert.doesNotMatch(registerSource, /import OnboardingCreateShell from "\.\/OnboardingCreateShell";/);
  assert.doesNotMatch(registerSource, /AccountCreatePreview/);
  assert.doesNotMatch(registerSource, /AuthBrandTopBar|AUTH_BRAND_TOP_BAR_CLASS/);
});

test("identity setup screen uses rich static field-impact previews without hover-only profile chrome", () => {
  const identitySource = readFileSync(
    resolve(repoRoot, "src/components/auth/AccountIdentitySetupPage.tsx"),
    "utf8",
  );

  assert.match(identitySource, /import \{ AuthPageIntro \} from "\.\/AuthPageFrame";/);
  // Every onboarding page is framed by the one shared shell, so the layout, the
  // brand chrome, and the sign-out affordance cannot drift page to page.
  assert.match(identitySource, /import OnboardingCreateShell from "\.\/OnboardingCreateShell";/);
  assert.match(identitySource, /<OnboardingCreateShell/);
  assert.match(identitySource, /previewTestId="identity-preview-pane"/);
  // The shell owns the session line + sign-out; the page only says whether it
  // has a real session. Neither the email nor "Log out" is stated on the page.
  // Matched loosely on purpose: the mutation gate feeds these tests Stryker-instrumented
  // source, which rewrites every boolean expression, so a regex containing `!previewMode`
  // can never match there. The contract that matters is that the footer is driven by
  // previewMode at all.
  assert.match(identitySource, /showSessionFooter=\{[^}]*previewMode/);
  // The session footer belongs to the caller (driven by `showSessionFooter`), not
  // to this page. Both literals live in the catalog now, so a footer re-inlined
  // today would carry a message id and no English at all — the literal checks
  // below would stay green through the regression they exist for. Anchored on the
  // id SUFFIX so every namespace variant is covered
  // (`pages.humanLogin.logOut`, `pages.deviceLogin.signedInAsPrefix`, …) without
  // naming unrelated ids. Verified: this page currently references none of them.
  assert.doesNotMatch(identitySource, /Log out/);
  assert.doesNotMatch(identitySource, /"[\w.]*\.(?:logOut|logOutAction)"/);
  assert.doesNotMatch(identitySource, /Signed in as/);
  assert.doesNotMatch(identitySource, /"[\w.]*\.signedInAsPrefix"/);
  assert.doesNotMatch(identitySource, /import AuthPageFrame/);
  assert.doesNotMatch(identitySource, /<AuthPageFrame/);
  assert.doesNotMatch(identitySource, /AuthBrandTopBar|AUTH_BRAND_TOP_BAR_CLASS/);
  assert.match(identitySource, /data-testid="identity-impact-preview"/);
  assert.match(identitySource, /data-testid="identity-channel-preview"/);
  assert.match(identitySource, /data-testid="identity-profile-preview"/);
  assert.match(identitySource, /data-testid="identity-user-message-preview"/);
  // The seeded sender and channel moved into the catalog when the page was
  // migrated, so matching the SOURCE for /Maya/ would now be vacuous — it can
  // only ever fail, never prove the preview still has seeded content. Assert the
  // page wires the ids AND that the catalog still holds them.
  assert.match(identitySource, /id: "pages\.identitySetup\.previewSenderName"/);
  assert.match(identitySource, /id: "pages\.identitySetup\.previewChannel"/);
  assert.equal(enMessages["pages.identitySetup.previewSenderName"], "Maya");
  assert.equal(enMessages["pages.identitySetup.previewChannel"], "pricing");
  // The dot-grid pane belongs to the shell now, so its backdrop and its
  // desktop-only rule are asserted against the shell, not this page.
  assert.doesNotMatch(identitySource, /radial-gradient/);
  assert.match(identitySource, /rotate-\[-1deg\]/);
  assert.match(identitySource, /rotate-\[2deg\]/);
  assert.match(identitySource, /shadow-brutal-lg/);
  assert.doesNotMatch(identitySource, /data-testid="identity-preview-captions"/);
  assert.doesNotMatch(identitySource, /Your display name and profile picture are what everyone sees on your messages\./);
  assert.doesNotMatch(identitySource, /Click anyone's name or avatar/);
  assert.doesNotMatch(identitySource, /IdentityPreview|PreviewMessage|MessageAvatar/);
  assert.doesNotMatch(identitySource, /John/);
  assert.doesNotMatch(identitySource, /<aside|hover:/);
  assert.doesNotMatch(identitySource, /AccountCreatePreview/);
});

test("first-server onboarding screen uses the full-bleed shell", () => {
  const serverSelectorSource = readFileSync(
    resolve(repoRoot, "src/components/auth/ServerSelector.tsx"),
    "utf8",
  );
  const shellSource = readFileSync(
    resolve(repoRoot, "src/components/auth/OnboardingCreateShell.tsx"),
    "utf8",
  );

  assert.match(serverSelectorSource, /import OnboardingCreateShell from "\.\/OnboardingCreateShell";/);
  assert.match(serverSelectorSource, /<OnboardingCreateShell[\s\S]*preview=\{<ServerCreatePreview serverName=\{name\} serverSlug=\{slug\} \/>\}/);
  assert.match(shellSource, /ONBOARDING_CREATE_FORM_PANEL_CLASS/);
  assert.match(shellSource, /bg-white px-6 py-10 sm:px-10 lg:border-r-2 lg:border-black/);
  assert.match(shellSource, /ONBOARDING_CREATE_DOT_GRID_CLASS/);
  assert.doesNotMatch(serverSelectorSource, /<CenteredCardFrame maxWidthClass="max-w-\[1200px\]">/);
});

test("onboarding shell is responsive: yellow brand bar on mobile, in-form brand mark on desktop", () => {
  const shellSource = readFileSync(
    resolve(repoRoot, "src/components/auth/OnboardingCreateShell.tsx"),
    "utf8",
  );

  // Narrow screens read as a plain auth form page: the same yellow brand bar as
  // sign in / sign up, and no demo pane.
  assert.match(shellSource, /AUTH_BRAND_TOP_BAR_CLASS\}\s*lg:hidden/);
  assert.match(shellSource, /export function OnboardingBrandBar/);
  // Wide screens drop that bar and put the brand mark in the form column's top-left.
  assert.match(shellSource, /export function OnboardingFormBrandMark/);
  // Gate the breakpoint on a wrapper: RaftBrandLockup hardcodes `inline-flex`,
  // which would win over a `hidden` handed to it and leak the mark onto mobile.
  assert.match(shellSource, /<div className="absolute left-6 top-8 hidden sm:left-10 lg:block">/);
  // The demo pane never renders on mobile.
  assert.match(shellSource, /className="relative hidden overflow-hidden bg-brutal-cream lg:flex"/);
  // The shell is the single owner of the session line + log-out for the whole
  // flow, and both sit at the foot of the form on every page.
  assert.match(shellSource, /export function OnboardingSessionFooter/);
  assert.match(shellSource, /showSessionFooter[\s\S]{0,80}<OnboardingSessionFooter \/>/);
  assert.match(shellSource, /<SignedInAs user=\{user\}/);
  assert.match(shellSource, /pages\.serverSelector\.logOut/);
});

test("invite and email verification pages use the branded auth frame", () => {
  for (const file of ["InviteAcceptPage.tsx", "EmailVerificationPage.tsx"]) {
    const source = readFileSync(
      resolve(repoRoot, `src/components/auth/${file}`),
      "utf8",
    );

    assert.match(source, /import CenteredCardFrame from "\.\/CenteredCardFrame";/);
    assert.match(source, /<CenteredCardFrame>/);
    assert.doesNotMatch(source, /flex min-h-0 flex-1 overflow-y-auto bg-brutal-cream font-display p-4 safe-top safe-bottom/);
  }
});

test("login page follows the modern auth layout and hides social buttons unless providers are enabled", () => {
  const source = readFileSync(
    resolve(repoRoot, "src/components/auth/LoginPage.tsx"),
    "utf8",
  );

  assert.match(source, /useAuthProviders/);
  assert.match(source, /isEmbeddedBrowser/);
  assert.match(source, /<OpenInBrowserSignInGuide/);
  assert.match(source, /enabledProviders\.length > 0/);
  // `(provider) =>` vs `provider =>`: the mutation gate reformats the source it feeds us,
  // so pin the mapping, not the parentheses.
  assert.match(source, /enabledProviders[\s\S]*\.map\(\(?provider\)? =>/);
  assert.match(source, /import AuthPageFrame, \{ AuthPageIntro \} from "\.\/AuthPageFrame";/);
  assert.match(source, /import \{ CURRENT_LEGAL_ACCEPTANCE[\s\S]*\} from "@botiverse\/raft-shared";/);
  // Re-anchored: the title migrated to `pages.login.title`. The structural
  // contract (AuthPageIntro carries the page title) is what matters here.
  assert.match(source, /<AuthPageIntro title=\{formatMessage\(\{ id: "pages\.login\.title" \}\)\} \/>/);
  // The divider migrated to `pages.login.or`. Anchoring the layout contract on
  // the rendered English kept the copy as the structural marker — the exact
  // failure this guard work is removing. Now: the separator STRUCTURE (its
  // classes) plus the message id, so neither the styling nor the string can
  // silently disappear.
  assert.match(source, /uppercase tracking-widest text-black\/45"/);
  assert.match(source, /id: "pages\.login\.or"/);
  // The legal line migrated to `pages.login.legalAgreement` — ONE message with
  // <terms>/<privacy> rich-text chunks, instead of five concatenated JSX pieces.
  // Both anchors are kept: the id proves the sentence is still rendered here, and
  // the two href bindings below prove the links still point at the real URLs.
  // The English literal would now match nothing, so left as-is this assertion
  // would have passed VACUOUSLY while the legal notice disappeared entirely.
  assert.match(source, /id: "pages\.login\.legalAgreement"/);
  assert.match(source, /href=\{CURRENT_LEGAL_ACCEPTANCE\.termsUrl\}/);
  assert.match(source, /href=\{CURRENT_LEGAL_ACCEPTANCE\.privacyUrl\}/);
  assert.match(source, /className="mt-4 text-center text-xs leading-5 text-black\/60"/);
  assert.doesNotMatch(source, /SOCIAL_AUTH_PREVIEW_PROVIDERS/);
});

test("open-in-browser guide uses a light auth utility layout", () => {
  const source = readFileSync(
    resolve(repoRoot, "src/components/auth/OpenInBrowserSignInGuide.tsx"),
    "utf8",
  );

  // Re-anchored on ids: this guide's copy moved to `auth.openInBrowser.*`
  // (it is shared by LoginPage, RegisterPage and SocialAuthCallbackPage). The
  // English literals would now match nothing, so left as-is these four checks
  // would pass VACUOUSLY while the guide lost its heading, its explanation or
  // either action button.
  assert.match(source, /id: "auth\.openInBrowser\.title"/);
  assert.match(source, /id: "auth\.openInBrowser\.description"/);
  assert.match(source, /id: "auth\.openInBrowser\.openBrowser"/);
  assert.match(source, /id: "auth\.openInBrowser\.copyLink"/);
  assert.match(source, /CenteredCardBrandHeader/);
  assert.match(source, /pt-\[5vh\]/);
  assert.doesNotMatch(source, /Survey|Google sign-in|disallowed_useragent|brand-tag|shadow-brutal/);
});

test("login page exposes browser password-manager semantics on the username and password fields", () => {
  const source = readFileSync(
    resolve(repoRoot, "src/components/auth/LoginPage.tsx"),
    "utf8",
  );

  assert.match(source, /<form onSubmit=\{handleSubmit\} className="space-y-4" autoComplete="on" noValidate>/);
  // Labels migrated; the CONTRACT is that each FormField still carries its
  // error binding and htmlFor, which is what ties label to input for a
  // password manager and a screen reader.
  assert.match(
    source,
    /<FormField label=\{formatMessage\(\{ id: "pages\.login\.emailLabel" \}\)\} labelStyle="plain" error=\{fieldErrors\.email\} htmlFor="login-email">/,
  );
  assert.match(source, /id="login-email"[\s\S]*name="username"[\s\S]*type="email"[\s\S]*autoComplete="username"/);
  assert.match(
    source,
    /<FormField label=\{formatMessage\(\{ id: "pages\.login\.passwordLabel" \}\)\} labelStyle="plain" error=\{fieldErrors\.password\} htmlFor="login-password">/,
  );
  assert.match(source, /id="login-password"[\s\S]*name="password"[\s\S]*type="password"[\s\S]*autoComplete="current-password"/);
});

test("all centered auth surfaces reuse the Sign In intro layout", () => {
  for (const file of [
    "LoginPage.tsx",
    "ForgotPasswordPage.tsx",
    "ResetPasswordPage.tsx",
    "InviteAcceptPage.tsx",
    "EmailVerificationPage.tsx",
    "ServerSelector.tsx",
    "SocialAuthCallbackPage.tsx",
  ]) {
    const source = readFileSync(
      resolve(repoRoot, `src/components/auth/${file}`),
      "utf8",
    );

    assert.match(source, /AuthPageIntro/, `${file} should use the shared Sign In intro layout`);
    assert.doesNotMatch(source, /size-16 items-center justify-center border-2 border-black bg-brutal-(?:yellow|cyan|lime)/);
  }
});

test("legal acceptance checkbox uses the shared brutal checkbox primitive", () => {
  const source = readFileSync(
    resolve(repoRoot, "src/components/auth/LegalAcceptanceCheckbox.tsx"),
    "utf8",
  );

  assert.match(source, /import Checkbox from "\.\.\/ui\/Checkbox";/);
  assert.match(source, /<Checkbox\s+size="md"/);
  assert.doesNotMatch(source, /accent-brutal-pink/);
  assert.doesNotMatch(source, /<input[\s\S]{0,120}type="checkbox"/);
});

test("social auth callback error recovery uses neutral sign-in language", () => {
  const source = readFileSync(
    resolve(repoRoot, "src/components/auth/SocialAuthCallbackPage.tsx"),
    "utf8",
  );

  // The btn-brutal control here is a BUTTON, so it reuses the shared Title Case
  // id minted for the Forgot/Reset pages rather than a new page-scoped one.
  assert.match(source, /id: "auth\.backToSignIn\.button"/);
  assert.match(source, /isEmbeddedUserAgentProviderError/);
  assert.match(source, /<OpenInBrowserSignInGuide loginUrl=\{getExternalBrowserLoginUrl\(callbackParams\.returnTo\)\} \/>/);
  assert.match(source, /className="btn-brutal bg-white px-4 py-2 text-sm"/);
  assert.doesNotMatch(source, /Return to app|bg-brutal-cyan/);
});
