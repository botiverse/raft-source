/**
 * Executable, machine-readable onboarding contract.
 *
 * This is deliberately a product state machine, not a mirror of React component state.
 * Browsers render server facts; they do not invent progress. Every state and transition
 * names an executable test that protects the behavior, and the companion contract test
 * fails when an evidence file or test name disappears.
 */

export type OnboardingStateId =
  | "A0_AUTH_ENTRY"
  | "A1_EMAIL_VERIFY"
  | "A2_IDENTITY_REQUIRED"
  | "A3_INVITE_ACCEPT"
  | "A4_SERVER_SELECT_CREATE"
  | "A5_OWNER_GATE"
  | "A6_MEMBER_BYPASS"
  | "S0_CONNECT"
  | "S1_OFFLINE_RECOVERY"
  | "S2_RUNTIME_CHECK"
  | "S3_RUNTIME_MISSING"
  | "S4_READY"
  | "S5_MEET_CINDY"
  | "R0_RESET_CONFIRM"
  | "R1_RESETTING"
  | "P0_CINDY_COLD"
  | "P1_SURVEY"
  | "P2_HANDOFF"
  | "N0_NORMAL_ONLINE"
  | "N1_NORMAL_OFFLINE"
  | "L0_LEGACY_DEFERRED";

export type OnboardingExternalEventId =
  | "TAB_OR_BROWSER_CLOSE"
  | "SESSION_CLEAR_OR_LOGOUT"
  | "DEVICE_OR_BROWSER_CHANGE"
  | "COMPUTER_OFFLINE"
  | "COMPUTER_ONLINE"
  | "NETWORK_OR_API_FAILURE"
  | "DIRECT_API_AGENT_CREATE"
  | "DIRECT_API_SETUP_COMPLETE"
  | "DIRECT_API_RESET"
  | "DUPLICATE_REQUEST"
  | "CREATE_AGENT_RESET_RACE"
  | "AGENT_DELETED"
  | "NON_OWNER_ENTRY"
  | "GRANDFATHERED_COMPLETE"
  | "LEGACY_DEFERRED_ROW"
  | "SERVER_PROCESS_RESTART";

export type OnboardingEvidenceLayer = "api" | "database" | "dom" | "e2e" | "source";

export interface OnboardingEvidence {
  id: string;
  layer: OnboardingEvidenceLayer;
  file: string;
  testName: string;
}

export interface OnboardingStateContract {
  id: OnboardingStateId;
  phase: "account" | "setup" | "post_setup" | "normal" | "legacy";
  invariant: string;
  evidence: readonly string[];
}

export interface OnboardingTransitionContract {
  id: string;
  from: OnboardingStateId;
  to: OnboardingStateId | "ORIGIN" | "NORMAL_APP";
  trigger: string;
  evidence: readonly string[];
}

export interface OnboardingExternalEventContract {
  id: OnboardingExternalEventId;
  invariant: string;
  evidence: readonly string[];
}

export const ONBOARDING_EVIDENCE = [
  { id: "register-shell", layer: "dom", file: "packages/web/tests/registerPageOnboarding.behavior.test.tsx", testName: "create account is a standalone credential page without identity fields or wizard chrome" },
  { id: "email-verify", layer: "api", file: "packages/server/src/services/userService.onboardingEmailJourney.test.ts", testName: "email verification enqueues onboarding welcome after marking the user verified" },
  { id: "identity-cas", layer: "api", file: "packages/server/src/routes/identitySetup.api.test.ts", testName: "identity setup creates a pending account, gates business writes, and completes with CAS replay semantics" },
  { id: "invite-agreement", layer: "api", file: "packages/server/src/routes/serverAgreements.api.test.ts", testName: "invite acceptance requires current agreement and writes membership audit atomically" },
  { id: "first-server", layer: "dom", file: "packages/web/tests/serverSelectorFirstServer.behavior.test.tsx", testName: "Screen A creates the server with the edited values" },
  { id: "owner-member-gate", layer: "api", file: "packages/server/src/services/serverSetupStateService.test.ts", testName: "actor-aware resolver hides setup from agents and non-managers" },
  { id: "setup-projection", layer: "api", file: "packages/server/src/services/serverSetupStateService.test.ts", testName: "projection names live blockers without changing the durable phase" },
  { id: "runtime-projection", layer: "api", file: "packages/server/src/services/serverSetupStateService.test.ts", testName: "the projection carries the runtime verdict, so the browser never has to guess it" },
  { id: "computer-connect", layer: "dom", file: "packages/web/tests/serverSetupComputerRuntime.behavior.test.tsx", testName: "fresh connect renders split install and setup commands with independent copy actions" },
  { id: "computer-offline", layer: "dom", file: "packages/web/tests/serverSetupComputerRuntime.behavior.test.tsx", testName: "a computer that is merely offline gets the START command, not install+setup again" },
  { id: "runtime-checking", layer: "dom", file: "packages/web/tests/serverSetupComputerRuntime.behavior.test.tsx", testName: "checking is not a verdict: a stale store cannot render a failure the server never issued" },
  { id: "runtime-missing", layer: "dom", file: "packages/web/tests/serverSetupComputerRuntime.behavior.test.tsx", testName: "a computer that answers with nothing usable prints a failure line, it does not spin forever" },
  { id: "runtime-ready", layer: "dom", file: "packages/web/tests/serverSetupComputerRuntime.behavior.test.tsx", testName: "the server's verdict enables Next even when the store has not caught up" },
  { id: "meet-cindy-reset", layer: "dom", file: "packages/web/tests/serverSetupGateRefetchFailure.behavior.test.tsx", testName: "Start over on Meet Cindy is the only clickable copy and opens the confirm dialog" },
  { id: "offline-reset-cancel", layer: "dom", file: "packages/web/tests/serverSetupGateRefetchFailure.behavior.test.tsx", testName: "Start over from S1 offline recovery requires confirmation and cancel stays on S1" },
  { id: "reset-atomic", layer: "database", file: "packages/server/src/services/serverSetupReset.test.ts", testName: "reset is atomic when rewinding setup fails after computers were revoked" },
  { id: "reset-success", layer: "database", file: "packages/server/src/services/serverSetupReset.test.ts", testName: "reset revokes the stranded computers and rewinds setup to the start" },
  { id: "create-reset-race", layer: "database", file: "packages/server/src/services/serverSetupReset.test.ts", testName: "concurrent agent create and reset serialize to one of two complete outcomes" },
  { id: "create-checkpoint", layer: "api", file: "packages/server/src/routes/agents.api.test.ts", testName: "creating an agent records the owner's setup as complete — the ordinary path is a real path" },
  { id: "complete-terminal", layer: "api", file: "packages/server/src/services/serverSetupStateService.test.ts", testName: "complete is terminal and idempotent even when live facts later fail" },
  { id: "post-setup-order", layer: "dom", file: "packages/web/tests/accountSignupSurvey.test.ts", testName: "the survey is asked after Cindy is created and before the handoff" },
  { id: "survey-persisted", layer: "dom", file: "packages/web/tests/accountSignupSurvey.test.ts", testName: "the handoff screen is answered by the server alone, with no session-local memory" },
  { id: "handoff-briefs", layer: "dom", file: "packages/web/tests/accountSignupSurvey.test.ts", testName: "the handoff just says Let's Go, and is what briefs Cindy" },
  { id: "owner-complete-normal", layer: "dom", file: "packages/web/tests/serverSetupPreviewContract.test.ts", testName: "production Screen B consumes the frozen projection contract without client-derived readiness" },
  { id: "offline-brief-retry", layer: "api", file: "packages/server/src/services/onboardingBriefingOnActivation.test.ts", testName: "a computer coming back briefs the onboarding agent — no HTTP route, no wake-up event" },
  { id: "owner-facts-rehydrate", layer: "api", file: "packages/server/src/services/onboardingBriefingOnActivation.test.ts", testName: "the owner facts go over on EVERY wake — even long after onboarding finished" },
  { id: "legacy-deferred", layer: "dom", file: "packages/web/tests/serverSetupSettingsReopen.behavior.test.tsx", testName: "Finish setup durably starts deferred setup before returning to the server" },
  { id: "grandfathered", layer: "database", file: "packages/server/src/db/onboardingSetupBackfill.test.ts", testName: "0157 backfill: agent-having server → members complete+grandfathered; agentless stays not_started" },
  { id: "last-good-read", layer: "dom", file: "packages/web/tests/serverSetupGateRefetchFailure.behavior.test.tsx", testName: "a revision bump whose refetch FAILS does not erase the server's truth" },
  { id: "first-read-fail-closed", layer: "dom", file: "packages/web/tests/serverSetupGateRefetchFailure.behavior.test.tsx", testName: "a FIRST read that fails renders nothing — no legacy modal, no fabricated screen" },
  { id: "mandatory-setup-e2e", layer: "e2e", file: "packages/web/tests/e2e/tests/onboarding-wizard.spec.ts", testName: "setup P0 remains mandatory when legacy opt-out state is stored" },
  { id: "grandfathered-e2e", layer: "e2e", file: "packages/web/tests/e2e/tests/onboarding-wizard.spec.ts", testName: "grandfathered owner is not pulled into legacy referral after referral reset" },
  { id: "member-e2e", layer: "e2e", file: "packages/web/tests/e2e/tests/onboarding-wizard.spec.ts", testName: "invited member is not pulled into the removed legacy referral wizard" },
  { id: "agent-delete-terminal", layer: "database", file: "packages/server/src/services/serverSetupReset.test.ts", testName: "reset REFUSES on a server whose official onboarding agent was deleted — what happened, happened" },
] as const satisfies readonly OnboardingEvidence[];

export const ONBOARDING_STATES = [
  { id: "A0_AUTH_ENTRY", phase: "account", invariant: "Login, registration, and invite entry collect credentials only; failure stays on the entry surface.", evidence: ["register-shell"] },
  { id: "A1_EMAIL_VERIFY", phase: "account", invariant: "Password accounts must establish verified email before business surfaces unlock.", evidence: ["email-verify"] },
  { id: "A2_IDENTITY_REQUIRED", phase: "account", invariant: "A unique handle and non-placeholder display identity are durable account facts, not browser stamps.", evidence: ["identity-cas"] },
  { id: "A3_INVITE_ACCEPT", phase: "account", invariant: "Invite acceptance is agreement-aware and enters the invited server rather than a stale active server.", evidence: ["invite-agreement"] },
  { id: "A4_SERVER_SELECT_CREATE", phase: "account", invariant: "Users select an existing server or atomically create the first server before server-scoped onboarding.", evidence: ["first-server"] },
  { id: "A5_OWNER_GATE", phase: "account", invariant: "Only the owner sees server setup; unknown projection renders no fabricated gate.", evidence: ["owner-member-gate", "mandatory-setup-e2e"] },
  { id: "A6_MEMBER_BYPASS", phase: "account", invariant: "A non-owner enters the normal app regardless of the owner's setup progress.", evidence: ["owner-member-gate", "member-e2e"] },
  { id: "S0_CONNECT", phase: "setup", invariant: "No connected Computer means install/setup instructions, disabled Next, and no bypass.", evidence: ["computer-connect", "mandatory-setup-e2e"] },
  { id: "S1_OFFLINE_RECOVERY", phase: "setup", invariant: "A known offline Computer is named and recovered; Start over is confirmation-gated.", evidence: ["computer-offline", "offline-reset-cancel"] },
  { id: "S2_RUNTIME_CHECK", phase: "setup", invariant: "Checking or unknown runtime verdict is progress, never fabricated failure or readiness.", evidence: ["runtime-checking", "runtime-projection"] },
  { id: "S3_RUNTIME_MISSING", phase: "setup", invariant: "A server-declared unusable runtime shows remediation while setup remains blocked.", evidence: ["runtime-missing"] },
  { id: "S4_READY", phase: "setup", invariant: "Only a server-declared ready runtime enables Next.", evidence: ["runtime-ready"] },
  { id: "S5_MEET_CINDY", phase: "setup", invariant: "Cindy configuration remains pre-checkpoint; Create establishes it and Start over first confirms.", evidence: ["meet-cindy-reset", "create-checkpoint"] },
  { id: "R0_RESET_CONFIRM", phase: "setup", invariant: "Cancel returns to the exact origin; only Confirm may call reset.", evidence: ["meet-cindy-reset", "offline-reset-cancel"] },
  { id: "R1_RESETTING", phase: "setup", invariant: "Computer revocation and setup rewind are one atomic transaction serialized with Agent creation.", evidence: ["reset-success", "reset-atomic", "create-reset-race"] },
  { id: "P0_CINDY_COLD", phase: "post_setup", invariant: "The Agent exists and setup is permanently complete, but no work starts before handoff.", evidence: ["create-checkpoint", "post-setup-order"] },
  { id: "P1_SURVEY", phase: "post_setup", invariant: "Owner role and referral persist before handoff; failed writes remain pending.", evidence: ["post-setup-order", "survey-persisted"] },
  { id: "P2_HANDOFF", phase: "post_setup", invariant: "Let's Go durably acknowledges handoff, then triggers ordinary Agent work without reviving setup.", evidence: ["handoff-briefs", "survey-persisted"] },
  { id: "N0_NORMAL_ONLINE", phase: "normal", invariant: "Online Cindy follows ordinary durable messaging and rehydrates owner context each session.", evidence: ["handoff-briefs", "owner-facts-rehydrate"] },
  { id: "N1_NORMAL_OFFLINE", phase: "normal", invariant: "Messages remain durable while offline and normal activation resumes them; onboarding never reopens.", evidence: ["offline-brief-retry", "owner-facts-rehydrate"] },
  { id: "L0_LEGACY_DEFERRED", phase: "legacy", invariant: "Only historical rows may be deferred; they can resume but no v2 writer may create new deferred state.", evidence: ["legacy-deferred"] },
] as const satisfies readonly OnboardingStateContract[];

export const ONBOARDING_TRANSITIONS = [
  { id: "auth.register.needs_verification", from: "A0_AUTH_ENTRY", to: "A1_EMAIL_VERIFY", trigger: "password registration", evidence: ["register-shell", "email-verify"] },
  { id: "auth.verified.needs_identity", from: "A1_EMAIL_VERIFY", to: "A2_IDENTITY_REQUIRED", trigger: "email verified", evidence: ["email-verify", "identity-cas"] },
  { id: "auth.oauth.needs_identity", from: "A0_AUTH_ENTRY", to: "A2_IDENTITY_REQUIRED", trigger: "OAuth login without complete identity", evidence: ["identity-cas"] },
  { id: "auth.invite.resume", from: "A0_AUTH_ENTRY", to: "A3_INVITE_ACCEPT", trigger: "authenticated invite link", evidence: ["invite-agreement"] },
  { id: "identity.invite.resume", from: "A2_IDENTITY_REQUIRED", to: "A3_INVITE_ACCEPT", trigger: "identity completed with pending invite", evidence: ["identity-cas", "invite-agreement"] },
  { id: "identity.server_select", from: "A2_IDENTITY_REQUIRED", to: "A4_SERVER_SELECT_CREATE", trigger: "identity completed without invite", evidence: ["identity-cas", "first-server"] },
  { id: "invite.member_bypass", from: "A3_INVITE_ACCEPT", to: "A6_MEMBER_BYPASS", trigger: "invite accepted", evidence: ["invite-agreement", "member-e2e"] },
  { id: "server.owner_gate", from: "A4_SERVER_SELECT_CREATE", to: "A5_OWNER_GATE", trigger: "owner opens or creates server", evidence: ["first-server", "mandatory-setup-e2e"] },
  { id: "server.member_bypass", from: "A4_SERVER_SELECT_CREATE", to: "A6_MEMBER_BYPASS", trigger: "member opens server", evidence: ["owner-member-gate"] },
  { id: "owner.new_server.connect", from: "A5_OWNER_GATE", to: "S0_CONNECT", trigger: "setup projection is not_started", evidence: ["setup-projection", "mandatory-setup-e2e"] },
  { id: "owner.legacy.resume", from: "A5_OWNER_GATE", to: "L0_LEGACY_DEFERRED", trigger: "legacy deferred row", evidence: ["legacy-deferred"] },
  { id: "owner.post_setup.survey", from: "A5_OWNER_GATE", to: "P1_SURVEY", trigger: "setup complete and survey pending", evidence: ["post-setup-order"] },
  { id: "owner.post_setup.handoff", from: "A5_OWNER_GATE", to: "P2_HANDOFF", trigger: "survey done and handoff pending", evidence: ["survey-persisted"] },
  { id: "owner.complete.normal_app", from: "A5_OWNER_GATE", to: "NORMAL_APP", trigger: "setup complete, survey complete, and handoff acknowledged", evidence: ["owner-complete-normal", "complete-terminal"] },
  { id: "member.normal_app", from: "A6_MEMBER_BYPASS", to: "NORMAL_APP", trigger: "insufficient_permission projection", evidence: ["owner-member-gate", "member-e2e"] },
  { id: "setup.connect.offline", from: "S0_CONNECT", to: "S1_OFFLINE_RECOVERY", trigger: "connected Computer is offline", evidence: ["computer-offline", "setup-projection"] },
  { id: "setup.connect.online", from: "S0_CONNECT", to: "S2_RUNTIME_CHECK", trigger: "Computer connects", evidence: ["computer-connect", "runtime-checking"] },
  { id: "setup.offline.online", from: "S1_OFFLINE_RECOVERY", to: "S2_RUNTIME_CHECK", trigger: "Computer comes online", evidence: ["computer-offline", "runtime-checking"] },
  { id: "setup.offline.reset_confirm", from: "S1_OFFLINE_RECOVERY", to: "R0_RESET_CONFIRM", trigger: "Start over", evidence: ["offline-reset-cancel"] },
  { id: "setup.check.offline", from: "S2_RUNTIME_CHECK", to: "S1_OFFLINE_RECOVERY", trigger: "Computer goes offline", evidence: ["computer-offline"] },
  { id: "setup.check.missing", from: "S2_RUNTIME_CHECK", to: "S3_RUNTIME_MISSING", trigger: "runtime verdict is not_ready or error", evidence: ["runtime-missing", "runtime-projection"] },
  { id: "setup.check.ready", from: "S2_RUNTIME_CHECK", to: "S4_READY", trigger: "runtime verdict is ready", evidence: ["runtime-ready", "runtime-projection"] },
  { id: "setup.missing.offline", from: "S3_RUNTIME_MISSING", to: "S1_OFFLINE_RECOVERY", trigger: "Computer goes offline", evidence: ["computer-offline"] },
  { id: "setup.missing.ready", from: "S3_RUNTIME_MISSING", to: "S4_READY", trigger: "runtime becomes ready", evidence: ["runtime-ready"] },
  { id: "setup.ready.offline", from: "S4_READY", to: "S1_OFFLINE_RECOVERY", trigger: "Computer goes offline", evidence: ["computer-offline"] },
  { id: "setup.ready.meet_cindy", from: "S4_READY", to: "S5_MEET_CINDY", trigger: "Next", evidence: ["runtime-ready", "meet-cindy-reset"] },
  { id: "setup.meet_cindy.reset_confirm", from: "S5_MEET_CINDY", to: "R0_RESET_CONFIRM", trigger: "Start over", evidence: ["meet-cindy-reset"] },
  { id: "setup.meet_cindy.checkpoint", from: "S5_MEET_CINDY", to: "P0_CINDY_COLD", trigger: "Create Cindy succeeds", evidence: ["create-checkpoint"] },
  { id: "reset.cancel", from: "R0_RESET_CONFIRM", to: "ORIGIN", trigger: "Cancel", evidence: ["offline-reset-cancel"] },
  { id: "reset.confirm", from: "R0_RESET_CONFIRM", to: "R1_RESETTING", trigger: "Confirm", evidence: ["reset-success", "reset-atomic"] },
  { id: "reset.success", from: "R1_RESETTING", to: "S0_CONNECT", trigger: "atomic reset commits", evidence: ["reset-success"] },
  { id: "post_setup.survey", from: "P0_CINDY_COLD", to: "P1_SURVEY", trigger: "survey pending", evidence: ["post-setup-order"] },
  { id: "post_setup.handoff", from: "P0_CINDY_COLD", to: "P2_HANDOFF", trigger: "survey complete and handoff pending", evidence: ["post-setup-order", "survey-persisted"] },
  { id: "survey.handoff", from: "P1_SURVEY", to: "P2_HANDOFF", trigger: "survey persists", evidence: ["survey-persisted"] },
  { id: "handoff.online", from: "P2_HANDOFF", to: "N0_NORMAL_ONLINE", trigger: "Let's Go with Cindy online", evidence: ["handoff-briefs"] },
  { id: "handoff.offline", from: "P2_HANDOFF", to: "N1_NORMAL_OFFLINE", trigger: "Let's Go with Cindy offline", evidence: ["handoff-briefs", "offline-brief-retry"] },
  { id: "normal.online.offline", from: "N0_NORMAL_ONLINE", to: "N1_NORMAL_OFFLINE", trigger: "Computer goes offline", evidence: ["offline-brief-retry"] },
  { id: "normal.offline.online", from: "N1_NORMAL_OFFLINE", to: "N0_NORMAL_ONLINE", trigger: "Computer comes online", evidence: ["offline-brief-retry", "owner-facts-rehydrate"] },
  { id: "legacy.resume.connect", from: "L0_LEGACY_DEFERRED", to: "S0_CONNECT", trigger: "Finish setup without connected Computer", evidence: ["legacy-deferred"] },
  { id: "legacy.resume.offline", from: "L0_LEGACY_DEFERRED", to: "S1_OFFLINE_RECOVERY", trigger: "Finish setup with offline Computer", evidence: ["legacy-deferred", "computer-offline"] },
  { id: "legacy.resume.runtime", from: "L0_LEGACY_DEFERRED", to: "S2_RUNTIME_CHECK", trigger: "Finish setup with online Computer", evidence: ["legacy-deferred", "runtime-checking"] },
] as const satisfies readonly OnboardingTransitionContract[];

export const ONBOARDING_EXTERNAL_EVENTS = [
  { id: "TAB_OR_BROWSER_CLOSE", invariant: "Reload derives the same setup or post-setup state from durable server facts.", evidence: ["setup-projection", "survey-persisted"] },
  { id: "SESSION_CLEAR_OR_LOGOUT", invariant: "Session loss returns to auth but never resets server progress.", evidence: ["complete-terminal", "setup-projection"] },
  { id: "DEVICE_OR_BROWSER_CHANGE", invariant: "A different client reads the same durable projection.", evidence: ["survey-persisted", "setup-projection"] },
  { id: "COMPUTER_OFFLINE", invariant: "Before checkpoint recover at S1; after checkpoint never revive setup.", evidence: ["computer-offline", "complete-terminal"] },
  { id: "COMPUTER_ONLINE", invariant: "Before checkpoint resume runtime detection; after handoff use normal agent activation.", evidence: ["runtime-checking", "offline-brief-retry"] },
  { id: "NETWORK_OR_API_FAILURE", invariant: "A failed write does not advance; a failed read preserves last-good truth or renders nothing.", evidence: ["last-good-read", "first-read-fail-closed"] },
  { id: "DIRECT_API_AGENT_CREATE", invariant: "Every agent-create path atomically establishes the checkpoint.", evidence: ["create-checkpoint"] },
  { id: "DIRECT_API_SETUP_COMPLETE", invariant: "Complete is one-way and idempotent.", evidence: ["complete-terminal"] },
  { id: "DIRECT_API_RESET", invariant: "Reset is allowed only before checkpoint and commits atomically.", evidence: ["reset-success", "reset-atomic", "complete-terminal"] },
  { id: "DUPLICATE_REQUEST", invariant: "Retries do not cross the checkpoint backwards or repeat side effects.", evidence: ["complete-terminal", "identity-cas"] },
  { id: "CREATE_AGENT_RESET_RACE", invariant: "Create and reset serialize to one complete outcome.", evidence: ["create-reset-race"] },
  { id: "AGENT_DELETED", invariant: "The official onboarding-agent checkpoint remains terminal; deletion never revives setup or reset.", evidence: ["agent-delete-terminal"] },
  { id: "NON_OWNER_ENTRY", invariant: "Members bypass owner setup and enter the normal app.", evidence: ["owner-member-gate", "member-e2e"] },
  { id: "GRANDFATHERED_COMPLETE", invariant: "Grandfathered complete remains terminal even without an Agent.", evidence: ["grandfathered", "grandfathered-e2e"] },
  { id: "LEGACY_DEFERRED_ROW", invariant: "Legacy deferred rows are readable and resumable, but new v2 rows cannot create them.", evidence: ["legacy-deferred", "grandfathered"] },
  { id: "SERVER_PROCESS_RESTART", invariant: "DB facts reconstruct setup, post-setup, and owner context after restart.", evidence: ["setup-projection", "survey-persisted", "owner-facts-rehydrate"] },
] as const satisfies readonly OnboardingExternalEventContract[];

export const ONBOARDING_STATE_MACHINE_CONTRACT = {
  schemaVersion: "onboarding-state-machine.v1",
  checkpoint: "the first successfully created Agent row",
  states: ONBOARDING_STATES,
  transitions: ONBOARDING_TRANSITIONS,
  externalEvents: ONBOARDING_EXTERNAL_EVENTS,
  evidence: ONBOARDING_EVIDENCE,
} as const;
