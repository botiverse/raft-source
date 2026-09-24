import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { afterEach } from "node:test";
import "./helpers/domSetup";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { createElement } from "react";

import AccountIdentitySetupPage from "../src/components/auth/AccountIdentitySetupPage";
import ServerCreatePreview from "../src/components/auth/ServerCreatePreview";
import { en } from "../src/i18n/messages/en";
import { zhCn } from "../src/i18n/messages/zh-cn";
import type { User } from "../src/store/authStore";
import { renderWithIntl, TestIntlProvider } from "./helpers/intl";

const enMessages = en as Record<string, string>;
const zhMessages = zhCn as Record<string, string>;
const cssSource = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");

afterEach(cleanup);

const previewUser: User = {
  id: "motion-user",
  email: "motion@example.com",
  name: "",
  displayName: "",
  avatarUrl: null,
  gravatarHash: null,
  emailVerified: true,
  profileSetupProvider: null,
  profileSetupSuggestedHandle: null,
} as User;

test("Screen A preview pop targets stay tied to the live server-name and URL preview", () => {
  const rendered = renderWithIntl(
    createElement(ServerCreatePreview, { serverName: "Alpha Team", serverSlug: "alpha-team" }),
    { locale: "en" },
  );

  const firstBadge = screen.getByTestId("server-preview-sidebar-badge");
  const firstSlug = screen.getByTestId("server-preview-address-slug");
  assert.match(firstBadge.className, /onboarding-preview-pop/);
  assert.match(firstSlug.className, /onboarding-preview-pop/);
  assert.equal(firstBadge.textContent, "Alpha Team");
  assert.equal(firstSlug.textContent, "alpha-team");
  assert.match(screen.getByText("I am getting Alpha Team ready.").className, /onboarding-live-message/);

  rendered.rerender(
    createElement(
      TestIntlProvider,
      { locale: "en" },
      createElement(ServerCreatePreview, { serverName: "Beta Team", serverSlug: "beta-team" }),
    ),
  );
  assert.equal(screen.getByTestId("server-preview-sidebar-badge").textContent, "Beta Team");
  assert.equal(screen.getByTestId("server-preview-address-slug").textContent, "beta-team");
  assert.match(screen.getByText("I am getting Beta Team ready.").className, /onboarding-live-message/);
  assert.notEqual(screen.getByTestId("server-preview-sidebar-badge"), firstBadge);
  assert.notEqual(screen.getByTestId("server-preview-address-slug"), firstSlug);
  assert.match(enMessages["onboarding.serverPreview.agentPreparing"], /\{serverName\}/);
  assert.match(zhMessages["onboarding.serverPreview.agentPreparing"], /\{serverName\}/);
  assert.match(cssSource, /@keyframes onboarding-preview-pop/);
  assert.match(cssSource, /@keyframes onboarding-live-message/);
});

test("Screen 0 identity gives username feedback as errors only, with no positive confirm pin", () => {
  renderWithIntl(createElement(AccountIdentitySetupPage, {
    previewUser,
    onPreviewComplete: async () => {},
  }), { locale: "en" });

  assert.equal(screen.queryByTestId("identity-handle-confirm-pin"), null);
  assert.equal(screen.queryByLabelText("@handle confirmed"), null);
  const form = screen.getByRole("button", { name: "Continue" }).closest("form");
  assert.ok(form);
  fireEvent.submit(form);
  assert.equal(screen.getAllByRole("alert").length, 2);
});

test("Screen 0 identity preview motion stays attached to live preview fields", () => {
  renderWithIntl(createElement(AccountIdentitySetupPage, {
    previewUser,
    onPreviewComplete: async () => {},
  }), { locale: "en" });

  const firstMention = screen.getByTestId("identity-seeded-mention");
  assert.match(firstMention.className, /onboarding-identity-pop/);
  assert.match(screen.getByTestId("identity-user-message-avatar").className, /onboarding-identity-pop/);
  const profile = screen.getByTestId("identity-profile-preview");
  assert.match(profile.className, /onboarding-identity-card-enter/);
  assert.match(profile.className, /\[--identity-card-delay:80ms\]/);

  fireEvent.change(screen.getByLabelText("Username"), { target: { value: "motion-handle" } });
  const nextMention = screen.getByTestId("identity-seeded-mention");
  assert.equal(nextMention.textContent, "@motion-handle");
  assert.notEqual(nextMention, firstMention, "the live handle key must replay the mention pop");
  assert.match(cssSource, /@keyframes onboarding-identity-pop[\s\S]*scale\(1\.16\)/);
  assert.match(cssSource, /\.onboarding-identity-pop[\s\S]*300ms cubic-bezier\(0\.2, 0, 0\.2, 1\)/);
  assert.match(cssSource, /@keyframes onboarding-identity-card-enter[\s\S]*scale\(1\.04\)/);
  assert.match(cssSource, /\.onboarding-identity-card-enter[\s\S]*240ms cubic-bezier\(0\.2, 0, 0\.2, 1\) both/);
  assert.match(cssSource, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.onboarding-identity-pop/);
  assert.match(cssSource, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.onboarding-identity-card-enter/);
});
