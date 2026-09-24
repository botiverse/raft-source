import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  getEnvironmentLabelMessageId,
  getPreviewEnvironmentDetails,
  getSlockdevSeedCommand,
  shouldAutoDismissSlockdevAnnouncement,
  shouldAutoLoginSlockdev,
  clearSlockdevManualLogout,
  hasSlockdevManualLogout,
  markSlockdevManualLogout,
} from "../src/utils/devMode";

test("getEnvironmentLabelMessageId maps supported deployment modes to catalog ids", () => {
  assert.equal(getEnvironmentLabelMessageId("slockdev"), "env.badge.dev");
  assert.equal(getEnvironmentLabelMessageId("staging"), "env.badge.staging");
  assert.equal(getEnvironmentLabelMessageId("web-preview"), "env.badge.webPreview");
  assert.equal(getEnvironmentLabelMessageId("release-qa"), "env.badge.releaseQa");
  assert.equal(getEnvironmentLabelMessageId("production"), null);
  assert.equal(getEnvironmentLabelMessageId(undefined), null);
});

test("getPreviewEnvironmentDetails exposes branch, short SHA, and data target", () => {
  assert.equal(getPreviewEnvironmentDetails({}), null);
  assert.equal(getPreviewEnvironmentDetails({
    branch: "feature/dark-mode",
    commitSha: "3636b0b7398103fda29bf4a58841f4aeff394bcd",
    apiTarget: "prod",
  }), "feature/dark-mode · 3636b0b7 · PROD DATA");
});

test("shouldAutoLoginSlockdev is gated to an empty slockdev login screen", () => {
  const base = {
    deploymentEnv: "slockdev",
    initialized: true,
    attempted: false,
    hasUser: false,
    hasStoredSession: false,
    authView: "login" as const,
    authCallback: null,
    resetToken: null,
    inviteToken: null,
  };

  assert.equal(shouldAutoLoginSlockdev(base), true);
  assert.equal(shouldAutoLoginSlockdev({ ...base, deploymentEnv: "staging" }), false);
  assert.equal(shouldAutoLoginSlockdev({ ...base, attempted: true }), false);
  assert.equal(shouldAutoLoginSlockdev({ ...base, hasUser: true }), false);
  assert.equal(shouldAutoLoginSlockdev({ ...base, hasStoredSession: true }), false);
  assert.equal(shouldAutoLoginSlockdev({ ...base, authView: "register" }), false);
  assert.equal(shouldAutoLoginSlockdev({ ...base, authCallback: "social" }), false);
  assert.equal(shouldAutoLoginSlockdev({ ...base, resetToken: "reset-token" }), false);
  assert.equal(shouldAutoLoginSlockdev({ ...base, inviteToken: "invite-token" }), false);
});

test("getSlockdevSeedCommand includes the slockdev environment name", () => {
  assert.equal(getSlockdevSeedCommand("preview-a"), "./raftdev seed preview-a");
  assert.equal(getSlockdevSeedCommand(""), "./raftdev seed <env>");
});

test("shouldAutoDismissSlockdevAnnouncement is gated to slockdev", () => {
  assert.equal(shouldAutoDismissSlockdevAnnouncement("slockdev"), true);
  assert.equal(shouldAutoDismissSlockdevAnnouncement("staging"), false);
  assert.equal(shouldAutoDismissSlockdevAnnouncement("production"), false);
  assert.equal(shouldAutoDismissSlockdevAnnouncement(undefined), false);
});

test("slockdev start passes preview descriptions into the web dev tools", () => {
  // The repo-root ./raftdev launches scripts/dev/raftdev.ts, where
  // preview-description handling lives.
  const slockdevSource = readFileSync(new URL("../../../scripts/dev/raftdev.ts", import.meta.url), "utf8");
  const appSource = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const viteEnvSource = readFileSync(new URL("../src/vite-env.d.ts", import.meta.url), "utf8");

  assert.match(slockdevSource, /--description <text>/);
  assert.match(slockdevSource, /VITE_SLOCKDEV_PREVIEW_DESCRIPTION/);
  assert.match(slockdevSource, /VITE_SLOCKDEV_EMAIL/);
  assert.match(appSource, /VITE_SLOCKDEV_PREVIEW_DESCRIPTION/);
  assert.match(appSource, /Preview description/);
  assert.match(appSource, /<details[\s\S]+title=\{previewDescription\}/);
  assert.match(viteEnvSource, /VITE_SLOCKDEV_PREVIEW_DESCRIPTION\?: string/);
  assert.match(viteEnvSource, /VITE_SLOCKDEV_EMAIL\?: string/);
});

test("slockdev wires Report Issue to the local trace worker", () => {
  const slockdevSource = readFileSync(new URL("../../../scripts/dev/raftdev.ts", import.meta.url), "utf8");
  const traceWorkerPackage = readFileSync(new URL("../../../packages/trace-upload-worker/package.json", import.meta.url), "utf8");
  const agentDetailSource = readFileSync(new URL("../src/components/agent/AgentDetailPanel.tsx", import.meta.url), "utf8");
  const reportDialogSource = readFileSync(new URL("../src/components/agent/ReportIssueDialog.tsx", import.meta.url), "utf8");

  assert.match(slockdevSource, /VITE_FEEDBACK_EXPORT_URL/);
  assert.match(slockdevSource, /TRACE_WEB_CORS_ORIGIN/);
  assert.match(slockdevSource, /smoke-feedback-report\.ts/);
  assert.match(slockdevSource, /script feedback-report/);
  assert.match(traceWorkerPackage, /--var TRACE_WEB_CORS_ORIGIN/);
  assert.match(traceWorkerPackage, /--var DEPLOYMENT_ENV/);
  assert.match(agentDetailSource, /VITE_FEEDBACK_EXPORT_URL/);
  assert.match(agentDetailSource, /id: "agent\.reportIssue\.title"/);
  assert.match(reportDialogSource, /id: "agent\.reportIssue\.uploaded"/);
  assert.match(reportDialogSource, /id: "agent\.reportIssue\.reportReference"/);
  assert.match(reportDialogSource, /\/feedback\/\$\{report\.id\}\/transcript/);
  assert.doesNotMatch(reportDialogSource, /sessionId/);
  const submittedReportType = /type SubmittedReport = \{[\s\S]*?\};/.exec(reportDialogSource)?.[0] ?? "";
  const copyReportReference = /const handleCopyReportReference[\s\S]*?setReportRefCopied\(true\);\n  \};/.exec(reportDialogSource)?.[0] ?? "";
  assert.match(submittedReportType, /reportId/);
  assert.match(submittedReportType, /issueDescription/);
  assert.match(copyReportReference, /artifactId/);
  assert.match(copyReportReference, /issueDescription/);
  assert.doesNotMatch(submittedReportType, /expiresAt/);
  assert.doesNotMatch(copyReportReference, /expiresAt/);
});

test("an explicit logout beats the dev auto-login, and signing in again retires it", () => {
  // stdrc, 2026-07-13: "log out 得真的 log out". Clicking Log out mid-onboarding handed
  // you straight back to the seeded dev account — the one thing logging out must prevent.
  const store = new Map<string, string>();
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  };

  assert.equal(hasSlockdevManualLogout(storage), false);
  markSlockdevManualLogout(storage);
  assert.equal(hasSlockdevManualLogout(storage), true);
  clearSlockdevManualLogout(storage);
  assert.equal(hasSlockdevManualLogout(storage), false);

  // Storage being unavailable must not break auth: the auto-login is a convenience.
  const broken = {
    getItem: () => { throw new Error("blocked"); },
    setItem: () => { throw new Error("blocked"); },
    removeItem: () => { throw new Error("blocked"); },
  };
  markSlockdevManualLogout(broken);
  assert.equal(hasSlockdevManualLogout(broken), false);

  // And the gate itself reads it: logout is checked before every other condition.
  const source = readFileSync(new URL("../src/utils/devMode.ts", import.meta.url), "utf8");
  assert.match(source, /if \(hasSlockdevManualLogout\(\)\) return false;/);
  const authStore = readFileSync(new URL("../src/store/authStore.ts", import.meta.url), "utf8");
  assert.match(authStore, /markSlockdevManualLogout\(\)/);
  assert.match(authStore, /clearSlockdevManualLogout\(\)/);
});
