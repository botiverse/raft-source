// The SettingsPanel half of this contract moved to mounted-DOM assertions in
// billingSummary.behavior.test.tsx. The mounted tests pin the
// rendered plan card, seat usage, pricing controls, permission gates, and the
// checkout/portal/cancel endpoint calls. Covered elsewhere and deliberately not
// re-asserted here:
// - the plan -> feature-id mapping in billingControls.ts
//   (billingPartnerPlan.behavior.test.tsx, against the pure functions),
// - the catalog WORDING, incl. the zh seat-coverage sentence and the trial
//   sentence (billingTrialAndCheckout.i18n.test.ts,
//   billingPlanPresentation.i18n.test.ts), and the mounted trial notice with
//   mocked time (settingsRuntimeContracts.behavior.test.tsx),
// - the billing loading skeleton (settingsRuntimeContracts.behavior.test.tsx),
// - the member billing-tab boundary, which is routing — members redirect away
//   before PlanSection mounts (settingsRuntimeContracts.behavior.test.tsx),
// - the seat-update preview/confirm flow
//   (billingConfirmComposition.behavior.test.tsx).
// What remains here is either bytes-are-contract copy or wiring that a mounted
// render cannot see (paywall placement in other dialogs, server-side services).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");

function read(path: string) {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

test("billing copy that is itself the contract stays byte-pinned at its source", () => {
  // PLAN_CONFIG priceCadence is display copy consumed outside the web billing
  // surface; there is no web mount that renders it.
  const shared = read("../shared/src/index.ts");
  assert.match(shared, /\/ seat \/ month/);

  // The view-billing notice inside BillingTabContent is defense in depth: tab
  // routing (canOpenSettingsTab) already redirects members away from billing,
  // so no mounted path reaches it. Keep the copy pinned at the source.
  const settings = read("src/components/settings/SettingsPanel.tsx");
  assert.match(settings, /billing\.onlyServerOwnersAndAdminsCanViewBilling/);
});

test("agent creation dialog uses billing capacity gates instead of stale plan-only limits", () => {
  const dialog = read("src/components/agent/CreateAgentDialog.tsx");
  assert.match(dialog, /loadBilling\(\)/);
  assert.match(dialog, /getBillingCapacityLimitState/);
  assert.match(dialog, /getBillingCapacityLimitLabel/);
  assert.match(dialog, /getBillingUsage\(0, agents\.length\)/);
  assert.match(dialog, /agentCapacityLimitState\.reached/);
  assert.doesNotMatch(dialog, /PRO_AGENT_SEAT_FRACTION/);
  assert.doesNotMatch(dialog, /billing\.usage\.universalSeats \+/);
  assert.match(dialog, /limitLabel = getBillingCapacityLimitLabel\("agent", agentCapacityLimitState\.limitType\)/);
  assert.match(dialog, /nav\.toSettings\("billing"\)/);
});

test("limit and joint-channel paywalls route users to billing", () => {
  const createAgentDialog = read("src/components/agent/CreateAgentDialog.tsx");
  // Was `<Banner intent="warning" className="font-bold">`, the hand-rolled local
  // Banner. This dialog moved to raft-ui's Banner (PR #7052) because the local one
  // is built from raw utilities that the elegant patch layer cannot reach, so it
  // rendered identically in both themes. What this test is for — the capacity
  // paywall states its message and routes to billing — is unchanged; only the
  // component spelling moved. Pinned to `status="warning"` plus the message id
  // rather than the exact prop string, so a future className tweak does not read
  // as "the paywall disappeared".
  assert.match(
    createAgentDialog,
    /<Banner status="warning"[\s\S]*?agent\.create\.capacityReached/,
  );

  const inviteDialog = read("src/components/member/InviteHumanDialog.tsx");
  assert.match(inviteDialog, /isBillingGateError/);
  assert.match(inviteDialog, /getBillingCapacityLimitState/);
  assert.match(inviteDialog, /formatBillingCapacityLimitMessage/);
  assert.match(inviteDialog, /formatBillingCapacityLimitMessage\(\s*"human",\s*humanCapacityLimitState,\s*billing\.displayName,\s*formatMessage\(\{ id: "member\.invite\.upgradeForMore" \}\),\s*\)/);
  assert.match(inviteDialog, /getBillingUsage\(humanCount, 0\)/);
  assert.doesNotMatch(inviteDialog, /universalSeatUsage \+ 1/);
  assert.match(inviteDialog, /humanSeatLimitReached && \([\s\S]*<Banner intent="warning" className="font-bold">/);
  assert.match(inviteDialog, /nav\.toSettings\("billing"\)/);

  const jointDialog = read("src/components/channel/CreateJointChannelDialog.tsx");
  assert.match(jointDialog, /requires the Pro plan/);
  assert.match(jointDialog, /nav\.toSettings\("billing"\)/);

  const channelDialog = read("src/components/channel/CreateChannelDialog.tsx");
  // Anchored on the catalog id, not display copy: the sentence became an ICU
  // message with {used}/{max}/{plan} arguments when channel.create.* was
  // migrated. The contract is about the paywall Banner existing, not its wording.
  const limitIdx = channelDialog.indexOf("channel.create.limitReached");
  assert.ok(limitIdx >= 0, "channel limit paywall anchor not found");
  assert.match(channelDialog, /<Banner intent="warning" className="font-bold">[\s\S]*channel\.create\.limitReached/);
  assert.match(channelDialog, /nav\.toSettings\("billing"\)/);

  const machineDialog = read("src/components/machine/AddMachineDialog.tsx");
  const machineLimitIdIndex = machineDialog.indexOf("machine.add.limitReached");
  assert.ok(machineLimitIdIndex >= 0, "AddMachineDialog should resolve its limit banner through the catalog");
  assert.match(machineDialog, /<Banner intent="warning" className="mb-4 font-bold">[\s\S]*machine\.add\.limitReached/);
  assert.match(machineDialog, /nav\.toSettings\("billing"\)/);

  const chatPanel = read("src/components/message/ChatPanel.tsx");
  assert.match(chatPanel, /const billing = useServerStore\(\(s\) => s\.billing\)/);
  assert.match(chatPanel, /const plan = \(billing\?\.plan \|\| currentServer\?\.plan \|\| "free"\) as ServerPlan/);
  assert.match(chatPanel, /const maxChannels = getEffectiveLimits\(plan\)\.maxChannels/);
  assert.match(chatPanel, /channel\.jointBillingLocked === true/);
  assert.doesNotMatch(chatPanel, /channel\.type === "joint" && !canUseProBillingFeatures\(plan\)/);
  // ChatPanel migrated to react-intl (B2a): the paywall copy now resolves through
  // the message.chatPanel.* catalog, but the billing-route wiring is unchanged.
  assert.match(chatPanel, /<Banner intent="warning" density="sm"[\s\S]*message\.chatPanel\.historyLimit/);
  assert.match(chatPanel, /message\.chatPanel\.historyLimit/);
  assert.match(chatPanel, /<Banner intent="warning" className="justify-center text-center font-bold">[\s\S]*message\.chatPanel\.jointLocked/);
  assert.match(chatPanel, /message\.chatPanel\.viewBilling/);
  assert.match(chatPanel, /message\.chatPanel\.readOnlyQuota/);
  assert.match(chatPanel, /nav\.toSettings\("billing"\)/);

  const threadPanel = read("src/components/message/ThreadPanel.tsx");
  assert.match(threadPanel, /parentChannel\.jointBillingLocked === true/);
  assert.doesNotMatch(threadPanel, /canUseProBillingFeatures/);
  assert.match(threadPanel, /<Banner intent="warning" className="justify-center text-center font-bold">[\s\S]*message\.chatPanel\.jointLocked/);

  const notifications = read("src/components/layout/useSystemNotifications.tsx");
  assert.match(notifications, /layout\.systemNotifications\.planDowngradeTitle/);
  assert.match(notifications, /getFinitePlanLimitExcess\(liveAgents\.length, limits\.maxAgents\)/);
  assert.match(notifications, /getFinitePlanLimitExcess\(machines\.length, limits\.maxMachines\)/);
  assert.match(notifications, /nav\.toSettings\("billing"\)/);

  const settings = read("src/components/settings/SettingsPanel.tsx");
  assert.match(settings, /getFinitePlanLimitExcess\(agentCount, limits\.maxAgents\)/);
  assert.match(settings, /getFinitePlanLimitExcess\(machineCount, limits\.maxMachines\)/);
  assert.match(settings, /settings\.preJoinAgreement\.sectionLabel/);
  assert.match(settings, /settings\.admins\.sectionLabel/);
  assert.doesNotMatch(settings, /function isBillingGateError/);
  assert.doesNotMatch(settings, /Pre-join agreements requires the Pro plan/);
  assert.doesNotMatch(settings, /Admin roles requires the Pro plan/);

  const serversRoute = read("../server/src/routes/servers.ts");
  assert.doesNotMatch(serversRoute, /requireTeamBillingFeature\(getDb\(\), req\.params\.id, "Pre-join agreements"\)/);
  assert.doesNotMatch(serversRoute, /requireTeamBillingFeature\(getDb\(\), req\.params\.id, "Admin roles"\)/);

  const humanDetail = read("src/components/member/HumanDetailPanel.tsx");
  assert.doesNotMatch(humanDetail, /function isBillingGateError/);
  assert.doesNotMatch(humanDetail, /nav\.toSettings\("billing"\)[\s\S]*roleError/);

  const messageInput = read("src/components/message/MessageInput.tsx");
  assert.match(messageInput, /Monthly file upload quota exceeded/);
  assert.match(messageInput, /<Banner intent="warning" density="sm" className="font-bold">[\s\S]*billingUploadQuotaError/);
  assert.match(messageInput, /message\.composer\.viewBilling/);
  assert.match(messageInput, /nav\.toSettings\("billing"\)/);

  const quotaService = read("../server/src/services/fileUploadQuotaService.ts");
  assert.match(quotaService, /Monthly file upload quota exceeded\. Free includes 100 MB of file uploads per month; upgrade to Pro for higher file upload limits\./);
  assert.match(quotaService, /billingUrl/);
  assert.match(quotaService, /suggestedNextAction/);
  assert.match(quotaService, /\/s\/\$\{encodeURIComponent\(server\.slug\)\}\/settings\/billing/);
  const attachmentsRoute = read("../server/src/routes/attachments.ts");
  assert.match(attachmentsRoute, /buildFileUploadQuotaExceededResponse\(req\.serverId!, err\)/);
  const internalRoute = read("../server/src/routes/internal.ts");
  assert.match(internalRoute, /buildFileUploadQuotaExceededResponse\(req\.serverId!, err\)/);

  const sidebar = read("src/components/layout/Sidebar.tsx");
  assert.doesNotMatch(sidebar, /server\?\.slug === "botiverse"/);
  assert.match(sidebar, /const canCreateJointChannel = capabilities\.federateChannels/);
});

test("server billing gates reuse shared capacity-unit helpers", () => {
  const shared = read("../shared/src/index.ts");
  assert.match(shared, /getBillingCapacityLimitState/);
  assert.match(shared, /PRO_AGENT_SEAT_FRACTION/);
  assert.match(shared, /kind === "human" \? 1 : PRO_AGENT_SEAT_FRACTION/);
  assert.match(shared, /formatBillingCapacityLimitMessage/);

  const planService = read("../server/src/services/planService.ts");
  assert.match(planService, /getBillingCapacityLimitState\(entitlement\.capacity, usage, "human"\)/);
  assert.match(planService, /getBillingCapacityLimitState\(entitlement\.capacity, usage, "agent"\)/);
  assert.match(planService, /formatBillingCapacityLimitMessage\("agent"/);
  assert.doesNotMatch(planService, /usage\.universalSeats \+ PRO_AGENT_SEAT_FRACTION/);

  const inviteService = read("../server/src/services/inviteService.ts");
  assert.match(inviteService, /getBillingCapacityLimitState\(entitlement\.capacity, usage, "human"\)/);
  assert.match(inviteService, /formatBillingCapacityLimitMessage\("human"/);
  assert.doesNotMatch(inviteService, /usage\.universalSeats \+ 1/);
});
