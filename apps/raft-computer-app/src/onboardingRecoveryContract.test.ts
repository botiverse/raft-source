import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("onboarding sign-in flow does not classify post-login workspace failures as sign-in", async () => {
  const source = await readFile(new URL("./onboarding/App.tsx", import.meta.url), "utf8");
  const signInSource = source.slice(
    source.indexOf("const handleSignIn"),
    source.indexOf("const handleSelectWorkspace"),
  );
  const loginTryBlock = signInSource.match(/try\s*{([\s\S]*?)\n    } catch/)?.[1] ?? "";
  assert.match(
    signInSource,
    /try\s*{[\s\S]*await window\.onboardingApi\.login\(\);[\s\S]*signedIn = true;[\s\S]*\} catch/,
  );
  assert.match(signInSource, /if \(!signedIn\) return;\s*await continueAfterSignIn\(setStep, false, actionId\);/);
  assert.doesNotMatch(loginTryBlock, /continueAfterSignIn|loadWorkspaces|loadExistingServerTarget/);
});

test("onboarding recovery card receives message/code/actionId and exposes copy diagnostics", async () => {
  const appSource = await readFile(new URL("./onboarding/App.tsx", import.meta.url), "utf8");
  const recoverySource = await readFile(new URL("./onboarding/Recovery.tsx", import.meta.url), "utf8");
  assert.match(appSource, /message=\{step\.message\}/);
  assert.match(appSource, /errorCode=\{step\.errorCode\}/);
  assert.match(appSource, /actionId=\{step\.actionId\}/);
  assert.match(recoverySource, /Copy diagnostics/);
  assert.match(recoverySource, /buildRecoveryDiagnostics/);
  assert.match(recoverySource, /copyText\(diagnostics\)/);
});
