import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * Casing rules (stdrc, 2026-07-12):
 *
 *   - **Buttons are Title Case** — anywhere, dialog or page. "Create Server",
 *     "Create Agent", "Let's Go", "Finish Setup".
 *   - **Text links are sentence case** — "Log out", "Later". They read as prose
 *     inside a sentence, not as a control you press.
 *
 * The line is the control, not the surface. An earlier draft split it by dialog vs
 * page and fell apart immediately: ServerSelector.tsx had "Create server" AND
 * "+ Create New Server" in one file, for the same action.
 */
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("dialog buttons and context-menu items are Title Case", () => {
  const createAgent = read("src/components/agent/CreateAgentDialog.tsx");
  const sidebar = read("src/components/layout/Sidebar.tsx");
  const setupStep = read("src/components/onboarding/ServerSetupComputerRuntimeStep.tsx");
  const handoff = read("src/components/onboarding/ServerSetupHandoffStep.tsx");
  // Sidebar + handoff button copy now lives in the layout i18n catalog, so the
  // casing rule is enforced on the en source-of-truth values, not on the JSX.
  const enCatalog = read("src/i18n/messages/en.ts");

  // Create Agent dialog: title + submit label.
  assert.match(createAgent, /id: "agent\.create\.dialogTitle"/);
  assert.match(createAgent, /id: "agent\.create\.dialogTitleExternal"/);
  assert.match(createAgent, /id: "agent\.create\.dialogTitleOnboarding"/);
  assert.match(enCatalog, /"agent\.create\.dialogTitle": "Create Agent"/);
  assert.match(enCatalog, /"agent\.create\.dialogTitleExternal": "Create External Agent"/);
  assert.match(enCatalog, /"agent\.create\.dialogTitleOnboarding": "Create Onboarding Agent"/);

  // The sidebar's add-agent action menu (ids in the JSX, Title Case in the en catalog).
  assert.match(sidebar, /formatMessage\(\{ id: "layout\.sidebar\.createAgent" \}\)/);
  assert.match(sidebar, /formatMessage\(\{ id: "layout\.sidebar\.createExternalAgent" \}\)/);
  assert.match(enCatalog, /"layout\.sidebar\.createAgent": "Create Agent"/);
  assert.match(enCatalog, /"layout\.sidebar\.createExternalAgent": "Create External Agent"/);

  // Setup-gate modal.
  assert.match(handoff, /formatMessage\(\{ id: "layout\.onboarding\.letsGo" \}\)/);
  assert.match(enCatalog, /"layout\.onboarding\.letsGo": "Let's Go"/);

  // The sentence-case slips this test exists to catch.
  for (const [name, source] of [
    ["CreateAgentDialog", createAgent],
    ["Sidebar", sidebar],
    ["ServerSetupComputerRuntimeStep", setupStep],
  ] as const) {
    assert.doesNotMatch(
      source,
      /"Create agent"|"Create external agent"|Open settings/,
      `${name} slipped back to sentence case`,
    );
  }
});

test("page-level form buttons are Title Case too, not just dialogs", () => {
  // The create-server page sat on "Create server" while the very same file said
  // "+ Create New Server" for the same action. One rule now covers both.
  const serverSelector = read("src/components/auth/ServerSelector.tsx");
  const enCatalog = read("src/i18n/messages/en.ts");
  // ServerSelector migrated to react-intl, so its button copy is no longer in the
  // JSX. Same treatment as Sidebar/handoff above: the id is pinned at the call
  // site, and the CASING is enforced on the en catalog, which is now the
  // source of truth for the rule.
  assert.match(serverSelector, /id: "pages\.serverSelector\.createServerAction"/);
  assert.match(enCatalog, /"pages\.serverSelector\.createServerAction": "Create Server"/);
  assert.match(serverSelector, /id: "pages\.serverSelector\.createNewServerAction"/);
  assert.match(enCatalog, /"pages\.serverSelector\.createNewServerAction": "\+ Create New Server"/);

  // The sentence-case slip this file exists to catch, checked on the catalog.
  // The two HEADINGS stay sentence case on purpose — the rule is about controls,
  // not every string — so they are asserted explicitly rather than caught by a
  // blanket "no lowercase create" pattern that would flag them.
  assert.doesNotMatch(enCatalog, /"pages\.serverSelector\.createServerAction": "Create server"/);
  assert.match(enCatalog, /"pages\.serverSelector\.createHeadingB": "Create server"/);
  // `createHeadingA` ("Create a server") was DEAD — `title` is only read inside
  // the isFirstServer branch, so that arm could never render. Removed with
  // @AngLee's sign-off. Asserted absent so it cannot creep back as an
  // unverifiable id, and so the two headings cannot silently diverge again.
  assert.doesNotMatch(enCatalog, /pages\.serverSelector\.createHeadingA/);
});

test("the back-to-sign-in control keeps button vs link casing apart", () => {
  // ForgotPasswordPage and ResetPasswordPage each render the SAME action twice:
  // a full-width <Button> and a bottom <button> styled as a text link. Under
  // stdrc's rule those take DIFFERENT casing — Title Case for the button,
  // sentence case for the link — so they are two ids, not one.
  //
  // Neither file was covered by this test before, which is why ForgotPasswordPage
  // sat on "Back to sign in" for its BUTTON while ResetPasswordPage used
  // "Back to Sign In" for the identical control. @AngLee ruled the button case
  // (2026-08-02); this pins both halves so the pair cannot drift again, and so
  // the rule survives the copy living in the catalog rather than the JSX.
  const enCatalog = read("src/i18n/messages/en.ts");
  assert.match(enCatalog, /"auth\.backToSignIn\.button": "Back to Sign In"/);
  assert.match(enCatalog, /"auth\.backToSignIn\.link": "Back to sign in"/);

  for (const file of [
    "src/components/auth/ForgotPasswordPage.tsx",
    "src/components/auth/ResetPasswordPage.tsx",
  ]) {
    const source = read(file);
    assert.match(source, /id: "auth\.backToSignIn\.button"/, `${file}: missing the button id`);
    assert.match(source, /id: "auth\.backToSignIn\.link"/, `${file}: missing the link id`);
    // And the English must not creep back into the JSX.
    assert.doesNotMatch(source, /Back to [Ss]ign [Ii]n/, `${file}: literal back-to-sign-in is back`);
  }
});

test("text links are sentence case, not Title Case", () => {
  // A text link reads as part of a sentence ("Signed in as x. Log out"), so Title
  // Case would look like a control that had wandered into the prose.
  const shell = read("src/components/auth/OnboardingCreateShell.tsx");
  const setupStep = read("src/components/onboarding/ServerSetupComputerRuntimeStep.tsx");
  const enCatalog = read("src/i18n/messages/en.ts");
  assert.match(shell, /pages\.serverSelector\.logOut/);
  assert.doesNotMatch(shell, /Log Out/);
  assert.match(enCatalog, /"pages\.serverSelector\.logOut": "Log out"/);
  // The bypass link is gone (a half-built server is finished or thrown away), so the text
  // link on this screen is now the rollback. Same rule: sentence case, reads as prose.
  assert.match(setupStep, /<TextLink[\s\S]*?id: "onboarding\.computerRuntime\.startOver"/);
  // Sentence case, asserted where the text now lives. The Title Case form must
  // not appear in the catalog either.
  assert.match(enCatalog, /"onboarding\.computerRuntime\.startOver": "Start over"/);
  assert.doesNotMatch(setupStep, /Start Over/);
});

test("the onboarding flow raises no toasts at all", () => {
  // stdrc, 2026-07-13: "整个 onboarding 流程一定不要弹 Toast". A toast is a notification
  // about something that happened somewhere else; everything in this flow happens right
  // where the user is looking, so it can say so in place — the copy button becomes a
  // tick, a failure becomes the banner at the top of the step.
  for (const path of [
    "src/components/onboarding/ServerSetupProjectionGate.tsx",
    "src/components/onboarding/ServerSetupComputerRuntimeStep.tsx",
    "src/components/onboarding/ServerSetupSurveyStep.tsx",
    "src/components/onboarding/ServerSetupHandoffStep.tsx",
  ]) {
    assert.doesNotMatch(read(path), /\btoast\.(success|error|info|warning)\(/, `${path} raises a toast`);
  }
});

test("onboarding modals carry the same shadow as every other dialog, and Create Cindy can be closed outside the gate", () => {
  // stdrc, 2026-07-13: the onboarding modals were on shadow-brutal-lg (6px) while every
  // other dialog (`card-brutal`) is on shadow-brutal (4px) — a different depth for no
  // reason. And Create Cindy, opened from the members panel, had no way out at all: no X,
  // and no Later (that only exists inside the setup gate).
  for (const path of [
    "src/components/onboarding/ServerSetupComputerRuntimeStep.tsx",
    "src/components/onboarding/ServerSetupSurveyStep.tsx",
    "src/components/onboarding/ServerSetupHandoffStep.tsx",
    "src/components/agent/CreateAgentDialog.tsx",
  ]) {
    assert.doesNotMatch(
      read(path),
      /border-2 border-black bg-white shadow-brutal-lg/,
      `${path} uses a deeper shadow than a normal dialog`,
    );
  }

  const createAgent = read("src/components/agent/CreateAgentDialog.tsx");
  // Both gate-owned shells ("step" browser Modal, "page" client standalone)
  // are mandatory and must not show the X close button; only the ordinary
  // "modal" dialog keeps it.
  assert.match(createAgent, /onboardingShell !== "modal" \? null : \([\s\S]*aria-label=\{formatMessage\(\{ id: "common\.close" \}\)\}/);
});

test("the setup gate cannot be escaped, and the only way out is to finish or start over", () => {
  // stdrc, 2026-07-13: "onboarding 过程中一定不能 esc 关闭弹窗".
  //
  // "Later" is gone entirely (2026-07-14). A bypass leaves a half-built server that can never
  // tell its owner they are done; the rollback leaves nothing behind. The resume bar stays —
  // rows in the database still hold `deferred`, and those owners still need a route back in.
  const modal = read("src/components/Modal.tsx");
  assert.match(modal, /if \(!closeOnEscape\) return;/);

  const gate = read("src/components/onboarding/ServerSetupProjectionGate.tsx");
  assert.doesNotMatch(gate, /<Modal onClose=\{\(\) => undefined\} layer=\{1\}>/, "every gate modal opts out of Escape");
  assert.match(gate, /server-setup-resume-bar/);
  assert.match(gate, /transitionServerSetup\(serverId, "start"\)/);

  // No bypass anywhere: finish, or roll back and start again.
  //
  // This is a PRODUCT constraint, not a copy check, so the English literal is
  // only a marker for it. That string is in the catalog now
  // (`agent.create.setupMyself`), so a bypass button re-added today would be
  // written as `formatMessage({ id: … })` and carry no literal — this guard would
  // stay green while the bypass shipped. The id is forbidden alongside it.
  //
  // The file IS migrated now (the note above predicted this), so the rollback is
  // asserted by its id; the literal would be vacuous.
  const step = read("src/components/onboarding/ServerSetupComputerRuntimeStep.tsx");
  assert.doesNotMatch(step, /I'll set this up myself/);
  assert.doesNotMatch(step, /agent\.create\.setupMyself/);
  assert.match(step, /id: "onboarding\.computerRuntime\.startOver"/);
});
