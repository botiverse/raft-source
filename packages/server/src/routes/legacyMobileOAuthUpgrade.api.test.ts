import { tokenForHuman } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";

import argon2 from "argon2";
import { eq } from "drizzle-orm";
import { openTestApp } from "../test/integration/app";
import { getDb } from "../db/index";
import { users } from "../db/schema";
import type { Request, Response } from "express";
import { CURRENT_PRIVACY_VERSION, CURRENT_TERMS_VERSION } from "@botiverse/raft-shared";
import { createFeatureFlag, createFeatureFlagRule } from "../services/featureFlagService";
import {
  APP_UPDATE_REQUIRED_CODE,
  LEGACY_APP_PRIVACY_VERSION,
  LEGACY_MOBILE_OAUTH_UPGRADE_REQUIRED_FLAG,
  appUpdateRequiredMessage,
  isOutdatedLegacyPrivacyVersion,
  registerUpdateRequiredMessage,
  rejectLegacyPrivacyVersionRegister,
} from "../services/legacyMobileOAuthUpgrade";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

const EN = "This version of Raft is no longer supported. Download the latest version at app.raft.build/download, then sign in.";
const ZH_CN = "当前版本过旧，请访问 app.raft.build/download 下载最新版 Raft 后再登录。";
const JA = "このバージョンの Raft はサポートが終了しました。app.raft.build/download から最新版をダウンロードしてログインしてください。";

// What the 1.14.x and older apps send to the native sign-in routes.
const START_BODY = {
  provider: "google",
  mode: "login",
  platform: "android",
  appEnv: "dev",
  returnUri: "raft://oauth/callback",
  codeChallenge: "a".repeat(43),
  codeChallengeMethod: "S256",
};
const REGISTER_EN = "Please refresh the page, or download the latest Raft at app.raft.build/download, to sign up.";
const REGISTER_ZH_CN = "请刷新页面，或访问 app.raft.build/download 下载最新版 Raft 后再注册。";
const REGISTER_JA = "ページを再読み込みするか、app.raft.build/download から最新版の Raft をダウンロードしてから登録してください。";

function registerBody(email: string, privacyVersion: string) {
  return { email, password: "password123", acceptTerms: true, termsVersion: CURRENT_TERMS_VERSION, privacyVersion };
}

const COMPLETE_BODY = { code: "handoff-code", codeVerifier: "b".repeat(43), platform: "android" };

function post(baseUrl: string, path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${baseUrl}/api/auth${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function turnOnForMobile() {
  await createFeatureFlag({ key: LEGACY_MOBILE_OAUTH_UPGRADE_REQUIRED_FLAG, randomizationUnit: "user", defaultEnabled: false });
  await createFeatureFlagRule({
    flagKey: LEGACY_MOBILE_OAUTH_UPGRADE_REQUIRED_FLAG,
    stage: "platform",
    decision: "allow",
    values: ["mobile"],
  });
}

async function signedInToken() {
  const [user] = await getDb().insert(users).values({
    email: "legacy-oauth-link@slock.test",
    name: "legacy-oauth-link",
    passwordHash: await argon2.hash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return tokenForHuman(user.email);
}

test("app update message follows Accept-Language: zh-CN, ja, else English", () => {
  assert.equal(appUpdateRequiredMessage(undefined), EN);
  assert.equal(appUpdateRequiredMessage("zh-CN,zh;q=0.9"), ZH_CN);
  assert.equal(appUpdateRequiredMessage("ja-JP"), JA);
  assert.equal(appUpdateRequiredMessage("fr-FR,en;q=0.5"), EN);
});

test("legacy mobile OAuth sign-in: flag off leaves start and complete unchanged", async () => {
  const { baseUrl, close } = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    for (const [path, body] of [["/mobile/oauth/start", START_BODY], ["/mobile/oauth/complete", COMPLETE_BODY]] as const) {
      const response = await post(baseUrl, path, body);
      const json = (await response.json()) as { code?: string };
      assert.notEqual(response.status, 426, path);
      assert.notEqual(json.code, APP_UPDATE_REQUIRED_CODE, path);
    }
  } finally {
    await close();
  }
});

test("legacy mobile OAuth sign-in: flag on answers 426 APP_UPDATE_REQUIRED on start and complete", async () => {
  const { baseUrl, close } = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    await turnOnForMobile();
    for (const [path, body] of [["/mobile/oauth/start", START_BODY], ["/mobile/oauth/complete", COMPLETE_BODY]] as const) {
      const english = await post(baseUrl, path, body);
      assert.equal(english.status, 426, path);
      assert.deepEqual(await english.json(), { error: EN, message: EN, code: APP_UPDATE_REQUIRED_CODE }, path);

      const chinese = await post(baseUrl, path, body, { "Accept-Language": "zh-CN" });
      assert.equal(chinese.status, 426, path);
      assert.deepEqual(await chinese.json(), { error: ZH_CN, message: ZH_CN, code: APP_UPDATE_REQUIRED_CODE }, path);
      assert.match(chinese.headers.get("vary") ?? "", /Accept-Language/i, path);

      // Even a malformed body gets the upgrade answer, before any other validation.
      const malformed = await post(baseUrl, path, { pendingLinkToken: 42 });
      assert.equal(malformed.status, 426, path);
    }
  } finally {
    await close();
  }
});

test("legacy mobile OAuth sign-in: flag on leaves provider linking and register alone", async () => {
  const { baseUrl, close } = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    await turnOnForMobile();
    const authorization = { Authorization: `Bearer ${await signedInToken()}` };
    for (const [path, body] of [
      ["/mobile/oauth/google/link/start", { returnUri: "raft://oauth/callback", codeChallenge: "a".repeat(43), codeChallengeMethod: "S256" }],
      ["/mobile/oauth/google/link/complete", { code: "link-code", codeVerifier: "b".repeat(43) }],
    ] as const) {
      const response = await post(baseUrl, path, body, authorization);
      const json = (await response.json()) as { code?: string };
      assert.notEqual(response.status, 426, path);
      assert.notEqual(json.code, APP_UPDATE_REQUIRED_CODE, path);
    }
    const register = await post(baseUrl, "/register", { email: "legacy-register@slock.test", password: "password123" });
    assert.notEqual(register.status, 426);
  } finally {
    await close();
  }
});

test("register update message follows Accept-Language: zh-CN, ja, else English", () => {
  assert.equal(registerUpdateRequiredMessage(undefined), REGISTER_EN);
  assert.equal(registerUpdateRequiredMessage("zh-CN,zh;q=0.9"), REGISTER_ZH_CN);
  assert.equal(registerUpdateRequiredMessage("ja-JP"), REGISTER_JA);
});

test("legacy privacy version is outdated only once the server's current version is newer", () => {
  assert.equal(LEGACY_APP_PRIVACY_VERSION, "2026-05-12");
  assert.equal(isOutdatedLegacyPrivacyVersion("2026-05-12", "2026-10-14"), true);
  assert.equal(isOutdatedLegacyPrivacyVersion("2026-05-12", "2026-05-12"), false);
  assert.equal(isOutdatedLegacyPrivacyVersion("2026-10-14", "2026-10-14"), false);
  assert.equal(isOutdatedLegacyPrivacyVersion(undefined, "2026-10-14"), false);
});

test("legacy register: flag on while the server's current privacy version is still 2026-05-12 blocks nothing", async () => {
  const req = {
    body: registerBody("legacy-register-same@slock.test", "2026-05-12"),
    get: () => undefined,
  } as unknown as Request;
  const res = new Proxy({}, { get: () => { throw new Error("response must not be touched"); } }) as Response;
  let evaluated = false;
  const blocked = await rejectLegacyPrivacyVersionRegister(req, res, {
    currentPrivacyVersion: "2026-05-12",
    evaluateFlag: (async () => { evaluated = true; return { enabled: true }; }) as never,
  });
  assert.equal(blocked, false);
  assert.equal(evaluated, false);
});

test("legacy register: flag off leaves the previous privacy version unchanged", async () => {
  const { baseUrl, close } = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    const response = await post(baseUrl, "/register", registerBody("legacy-register-off@slock.test", LEGACY_APP_PRIVACY_VERSION));
    assert.equal(response.status, 200, await response.clone().text());
  } finally {
    await close();
  }
});

test("legacy register: flag on answers 426 APP_UPDATE_REQUIRED for the previous privacy version", async () => {
  assert.ok(CURRENT_PRIVACY_VERSION > LEGACY_APP_PRIVACY_VERSION, "staging's current privacy version is newer than the legacy one");
  const { baseUrl, close } = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    await turnOnForMobile();
    const body = registerBody("legacy-register-on@slock.test", LEGACY_APP_PRIVACY_VERSION);

    const english = await post(baseUrl, "/register", body);
    assert.equal(english.status, 426);
    assert.deepEqual(await english.json(), { error: REGISTER_EN, message: REGISTER_EN, code: APP_UPDATE_REQUIRED_CODE });

    const chinese = await post(baseUrl, "/register", body, { "Accept-Language": "zh-CN" });
    assert.equal(chinese.status, 426);
    assert.deepEqual(await chinese.json(), { error: REGISTER_ZH_CN, message: REGISTER_ZH_CN, code: APP_UPDATE_REQUIRED_CODE });
    assert.match(chinese.headers.get("vary") ?? "", /Accept-Language/i);

    // Checked before body validation: a short password still gets the upgrade answer.
    const invalid = await post(baseUrl, "/register", { ...body, password: "short" });
    assert.equal(invalid.status, 426);

    // Nothing was created.
    const [created] = await getDb().select().from(users).where(eq(users.email, body.email));
    assert.equal(created, undefined);
  } finally {
    await close();
  }
});

test("legacy register: flag on leaves the current privacy version unchanged", async () => {
  const { baseUrl, close } = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    await turnOnForMobile();
    const response = await post(baseUrl, "/register", registerBody("legacy-register-current@slock.test", CURRENT_PRIVACY_VERSION));
    assert.equal(response.status, 200, await response.clone().text());
  } finally {
    await close();
  }
});
