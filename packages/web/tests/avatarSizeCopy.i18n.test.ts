import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

import { en as enMessages } from "../src/i18n/messages/en";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";
import * as avatarUpload from "../src/utils/avatarUpload";

// The avatar size error was a shared util that RETURNED an English sentence:
//
//   getAvatarFileSizeError(file): string | null   // "Avatar image must be 5 MB or smaller"
//
// Four surfaces rendered its value. Three of them (SettingsPanel twice,
// AgentDetailPanel) were already counted as migrated, and showed English on
// every oversized file — without containing one English literal for a scanner
// to find, because the sentence was built one module away.
//
// This pins the shape of the fix, not just the instances: the English source is
// GONE, so the next caller cannot reach for it.

const en = enMessages as Record<string, string>;
const zh = zhMessages as Record<string, string>;
const SRC = resolve(import.meta.dirname, "..", "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== "node_modules") walk(p, out);
    } else if (/\.tsx?$/.test(name) && !/\.d\.ts$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}
const FILES = walk(SRC);

test("the English-returning helper no longer exists", () => {
  // Deleted, not deprecated. A deprecated helper that still compiles is one
  // autocomplete away from being used again, and its return value renders.
  assert.equal("getAvatarFileSizeError" in avatarUpload, false);
  assert.equal("PROFILE_AVATAR_TOO_LARGE_MESSAGE" in avatarUpload, false);
  assert.equal(typeof avatarUpload.isAvatarFileTooLarge, "function");
  assert.equal(typeof avatarUpload.isAvatarTooLargeError, "function");
});

test("the size sentence exists exactly once, as a catalog message", () => {
  assert.equal(en["avatar.tooLarge"], "Avatar image must be {maxLabel} or smaller");
  assert.match(zh["avatar.tooLarge"], /\{maxLabel\}/);
  // The page-scoped duplicate is gone. HumanDetailPanel had its own id saying
  // the same thing in both languages; converging removes a row rather than
  // adding the eighth "same English, different id" receipt.
  assert.equal(en["member.detail.avatarTooLarge"], undefined,
    "the page-scoped duplicate is back — converge on avatar.tooLarge");
  // Scoped to AVATAR size copy. `settings.about.feedbackError.attachmentTooLarge`
  // ("Each screenshot must be 10 MB or smaller.") shares the sentence frame but
  // is a different limit on a different surface — folding it in here would make
  // this guard fire on unrelated work, which is how a guard gets loosened until
  // it proves nothing.
  const sizeIds = Object.keys(en).filter((id) => /avatar/i.test(id) && /or smaller/.test(en[id]));
  assert.deepEqual(sizeIds, ["avatar.tooLarge"], "a second avatar size sentence appeared");
});

test("every surface that checks size renders the shared id", () => {
  const callers = FILES.filter((f) => /isAvatarFileTooLarge/.test(readFileSync(f, "utf8")));
  // SettingsPanel x1 file, AgentDetailPanel, HumanDetailPanel,
  // AccountIdentitySetupPage, authStore, and the util itself.
  assert.ok(callers.length >= 5, `expected the known call sites, found ${callers.length}`);
  for (const f of callers) {
    const src = readFileSync(f, "utf8");
    if (/store\/authStore\.ts$/.test(f) || /utils\/avatarUpload\.ts$/.test(f)) {
      // Neither can reach the catalog. The store throws a CODE; the util owns it.
      assert.match(src, /AVATAR_TOO_LARGE_CODE/, `${f} should use the code, not a sentence`);
      continue;
    }
    assert.match(src, /id: "avatar\.tooLarge"/, `${f} checks size but renders something else`);
  }
});

test("the store throws a code, and no surface renders that code raw", () => {
  const store = readFileSync(join(SRC, "store", "authStore.ts"), "utf8");
  assert.match(store, /throw new Error\(AVATAR_TOO_LARGE_CODE\)/);
  assert.equal((store.match(/throw new Error\(AVATAR_TOO_LARGE_CODE\)/g) ?? []).length, 2);
  // Every catch that could receive the code must map it before falling back to
  // the generic upload-failure text — otherwise the user sees the raw string
  // "AVATAR_TOO_LARGE", which is WORSE than the English this change removed.
  //
  // The list is DERIVED, not written down. The first version named SettingsPanel
  // and AgentDetailPanel explicitly and passed while two other files leaked the
  // code: @Wug found AccountIdentitySetupPage, and deriving the rule turned up
  // HumanDetailPanel as well. A hand-listed guard is only ever as complete as
  // the moment someone typed it, and it reports success either way.
  //
  // The real rule: avatarUploadApiErrorMessage returns error.message, so ANY
  // file calling it can surface the code and must map it first.
  const genericPathCallers = FILES.filter(
    (f) => /avatarUploadApiErrorMessage\(/.test(readFileSync(f, "utf8"))
      && !/utils[/\\]avatarUpload\.ts$/.test(f),
  );
  assert.ok(genericPathCallers.length >= 4, `expected the known consumers, found ${genericPathCallers.length}`);
  for (const f of genericPathCallers) {
    assert.match(
      readFileSync(f, "utf8"), /isAvatarTooLargeError\(/,
      `${f} can receive AVATAR_TOO_LARGE via avatarUploadApiErrorMessage but never maps it`,
    );
  }
  assert.equal(avatarUpload.isAvatarTooLargeError(new Error(avatarUpload.AVATAR_TOO_LARGE_CODE)), true);
  assert.equal(avatarUpload.isAvatarTooLargeError(new Error("something else")), false);
  assert.equal(avatarUpload.isAvatarTooLargeError("not an error"), false);
});
