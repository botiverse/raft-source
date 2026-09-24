import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

import * as presentation from "../src/lib/oauthScopePresentation";
import { OAUTH_SCOPE_PRESENTATION, scopeGroupLabelId } from "../src/lib/oauthScopePresentation";
import { en as enMessages } from "../src/i18n/messages/en";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";

// Task #34. `oauthScopePresentation.ts` held English scope descriptions imported
// by THREE surfaces: the OAuth consent screen, Connected Apps in Settings, and
// ActionCard. Each could migrate, scan clean, and still render English.
//
// This one matters more than a settings label. The consent screen is where a
// person decides what an app may do with their account, and the load-bearing
// text is the NEGATIVE-capability copy — "this app cannot…". Leaving that
// English meant a zh user granting access from a description they cannot read.

const en = enMessages as Record<string, string>;
const zh = zhMessages as Record<string, string>;
const SRC = resolve(import.meta.dirname, "..", "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name) && !/\.d\.ts$/.test(name)) out.push(p);
  }
  return out;
}
const FILES = walk(SRC);
const strip = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");

test("the presentation table holds ids and no sentences", () => {
  for (const [scope, detail] of Object.entries(OAUTH_SCOPE_PRESENTATION)) {
    assert.match(detail.copyId, /^oauth\.scope\./, `${scope}: copyId is not a catalog id`);
    assert.ok(en[detail.copyId], `${detail.copyId} missing from en`);
    assert.ok(zh[detail.copyId], `${detail.copyId} missing from zh`);
    assert.notEqual(en[detail.copyId], zh[detail.copyId], `${detail.copyId} was never translated`);
    // The struct must not carry raw text alongside the id.
    assert.equal("copy" in detail, false, `${scope} still has a literal copy field`);
    assert.equal("label" in detail, false, `${scope} still has the dead label field`);
  }
});

test("the dead label field stayed deleted", () => {
  // `label` existed on all five entries and was rendered by NONE of the three
  // surfaces. Migrating it would have minted five catalog rows and five
  // translation tasks for text no user can reach. Deleted instead — if a
  // surface ever needs a short label, it should mint one then.
  assert.equal(Object.keys(en).filter((k) => /^oauth\.scope\..*\.label$/.test(k)).length, 0);
});

test("every consumer formats the id — none renders the struct field raw", () => {
  // Derived, not hand-listed: any file reading the table can leak. A written-out
  // list passes green while an unlisted consumer renders a raw id, which is the
  // failure mode that made the avatar-size guard useless in #5842.
  const consumers = FILES.filter(
    (f) => /OAUTH_SCOPE_PRESENTATION\[/.test(readFileSync(f, "utf8"))
      && !/lib[/\\]oauthScopePresentation\.ts$/.test(f),
  );
  assert.ok(consumers.length >= 3, `expected the three surfaces, found ${consumers.length}`);
  for (const f of consumers) {
    const src = strip(readFileSync(f, "utf8"));
    assert.doesNotMatch(src, /\{\s*detail\.copyId\s*\}/, `${f} renders the id itself, not its message`);
    assert.doesNotMatch(src, /title=\{detail\.copyId\}/, `${f} puts a raw id in a tooltip`);
    assert.match(src, /formatMessage\(\{ id: detail\.copyId \}\)/, `${f} never formats the copy`);
  }
});

test("the group-label and negative-capability helpers return ids", () => {
  assert.equal(scopeGroupLabelId("identity"), "oauth.scopeGroup.identity");
  assert.equal(scopeGroupLabelId("agent_messaging"), "oauth.scopeGroup.agentMessaging");
  assert.equal("scopeGroupLabel" in presentation, false, "the English-returning helper is back");
  assert.equal("AGENT_INBOUND_NEGATIVE_CAPABILITY_COPY" in presentation, false);
  assert.equal("AGENT_INBOUND_CANNOT_SUMMARY_COPY" in presentation, false);
  for (const id of [presentation.AGENT_INBOUND_NEGATIVE_CAPABILITY_ID, presentation.AGENT_INBOUND_CANNOT_SUMMARY_ID]) {
    assert.ok(en[id] && zh[id], `${id} missing a catalog entry`);
  }
});

test("the negative-capability copy keeps every capability it denies", () => {
  // This is the sentence a user reads before granting access. A translation that
  // drops one clause silently widens what the app appears allowed to do, and
  // nothing else in the suite would notice.
  const enText = en[presentation.AGENT_INBOUND_NEGATIVE_CAPABILITY_ID];
  const zhText = zh[presentation.AGENT_INBOUND_NEGATIVE_CAPABILITY_ID];
  for (const clause of ["send chat as you", "speak as the agent", "read your messages", "take actions for you"]) {
    assert.ok(enText.includes(clause), `en dropped: ${clause}`);
  }
  // Four denials in both languages, separated the same way.
  assert.equal(enText.split("·").length, 4);
  assert.equal(zhText.split("·").length, 4, "zh lost or merged a denied capability");
  assert.ok(zhText.includes("只能"), "zh lost the 'it can ONLY' restriction");

  const enSummary = en[presentation.AGENT_INBOUND_CANNOT_SUMMARY_ID];
  const zhSummary = zh[presentation.AGENT_INBOUND_CANNOT_SUMMARY_ID];
  assert.equal(enSummary.split(",").length, 4);
  // Counting SEPARATORS is wrong for Chinese: the standard enumeration is
  // "A、B、C，或D", so a correct four-item list splits into three on 、. The
  // first version of this assertion failed on well-formed zh, which would have
  // pushed me to mangle the punctuation to satisfy the test. What actually
  // matters is that no denied capability went missing, so check meaning.
  for (const concept of ["发消息", "发言", "读取消息", "执行操作"]) {
    assert.ok(zhSummary.includes(concept), `zh summary dropped: ${concept}`);
  }
});

test("the consent notice is ONE message, not two sentences concatenated", () => {
  // Was `Agent messaging requires Raft Agent Login. {SUMMARY}` glued together in
  // JSX, so a translation could not reorder or merge them.
  const consent = strip(readFileSync(join(SRC, "components", "oauth", "RequestedScopeConsent.tsx"), "utf8"));
  assert.match(consent, /id: "oauth\.consent\.agentLoginRequiredNotice"/);
  assert.doesNotMatch(consent, /Agent messaging requires/);
  assert.match(en["oauth.consent.agentLoginRequiredNotice"], /^Agent messaging requires Raft Agent Login\. /);
  assert.ok(zh["oauth.consent.agentLoginRequiredNotice"].includes("Agent Login"));
});

test("the consent screen has no English left", () => {
  const consent = strip(readFileSync(join(SRC, "components", "oauth", "RequestedScopeConsent.tsx"), "utf8"));
  for (const dead of [
    /"Requested access"/, />\s*Requested access/, /No recognized Raft scopes/,
    /Unrecognized scopes/, /These scopes are the exact capabilities/,
    /Recognized capabilities are shown below/,
  ]) {
    assert.doesNotMatch(consent, dead, `English still present: ${dead}`);
  }
  // The three intro states are separate ids, not one string with conditional
  // fragments — clause order differs by language.
  for (const id of [
    "oauth.consent.introIdentityOnly",
    "oauth.consent.introAgentMessaging",
    "oauth.consent.introUnrecognized",
  ]) {
    assert.ok(en[id] && zh[id], `${id} missing`);
    assert.match(consent, new RegExp(`"${id.replace(/\./g, "\\.")}"`), `${id} unused`);
  }
});

test("zh follows the vocabulary rulings", () => {
  for (const id of Object.keys(en).filter((k) => k.startsWith("oauth."))) {
    assert.ok(!zh[id].includes("……"), `${id} uses a double ellipsis`);
    assert.ok(!zh[id].includes("..."), `${id} uses ASCII dots`);
  }
});
