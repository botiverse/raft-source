// BILLING MIGRATION BASELINE — the migration-target ids still in use (45 of the
// 49 migrated) frozen as an id-keyed manifest (migration baseline / approved
// copy), per @铁根/@Wug's successor contract (2026-08-03).
//
// The legacy entries whose English source no longer exists in the en catalog
// are intentionally NOT here: they have no value in the current catalog, no
// active billing id, and no callsite. They are:
//   - 14 from the retired "Add seats" flow;
//   - 25 from the old Plan & Billing page, retired by #12097;
//   - billing.gracePeriodExpired, billing.planDowngraded and
//     billing.theGracePeriodHasEndedExcessAgentsHaveBeenSt, from the old
//     downgrade notice (#proj-commercial task #3);
//   - billing.finalTrialPeriod, from the free-trial banner, gone with the trial
//     that ended 2026-06-23 (#proj-commercial task #21).
// An intentional future copy change MAY edit this fixture, but the PR must
// state copy-owner review.
//
// THE EXPECTED ID SET IS INDEPENDENT OF THIS FIXTURE — it is hardcoded in
// billingCatalogEquivalence.test.ts. Deleting an id AND its fixture entry
// together still goes RED, because the expected set still names it.

import type { MessageId } from "../../src/i18n/messages/en";

export const BILLING_MIGRATION_BASELINE: Record<MessageId, { en: string; zh: string }> = {
  "billing.100MbFileUploadsMonth": { en: "100 MB file uploads/month", zh: "每月 100 MB 文件上传" },
  "billing.30DaysOfMessageHistory": { en: "30 days of message history", zh: "30 天消息历史" },
  "billing.agentReminders": { en: "Agent reminders", zh: "Agent 提醒" },
  "billing.agents": { en: "Agents", zh: "Agent" },
  "billing.agentsOnYourOwnComputers": { en: "Agents on your own computers", zh: "在自己的电脑上运行 Agent" },
  "billing.basicObservability": { en: "Basic observability", zh: "基础可观测性" },
  "billing.billing": { en: "Billing", zh: "账单" },
  "billing.billingInterval": { en: "Billing interval", zh: "账单周期" },
  "billing.cancelSubscription": { en: "Cancel subscription", zh: "取消订阅" },
  "billing.cancelTheWholeProSubscriptionAtTheEndOfTheCu": { en: "Cancel the whole Pro subscription at the end of the current billing period. The server keeps Pro capacity until the cancellation date, then returns to Free.", zh: "在当前账单周期结束时取消整个 Pro 订阅。服务器会保留 Pro 容量直到取消日期，之后恢复为免费版。" },
  "billing.canceling": { en: "Canceling", zh: "正在取消" },
  "billing.channels": { en: "Channels", zh: "频道" },
  "billing.everythingInFree": { en: "Everything in Free", zh: "包含免费版的全部功能" },
  "billing.everythingWithoutAnyLimitations": { en: "Everything without any limitations", zh: "全部功能且不设限制" },
  "billing.failedToCancelSubscription": { en: "Failed to cancel subscription", zh: "无法取消订阅" },
  "billing.failedToOpenBillingPortal": { en: "Failed to open billing portal", zh: "无法打开账单门户" },
  "billing.failedToUpdateSeats": { en: "Failed to update seats", zh: "无法更新席位" },
  "billing.fileUploads": { en: "File uploads", zh: "文件上传" },
  "billing.forBuildersAndTeamsScalingAgentCollaboration": { en: "For builders and teams scaling agent collaboration.", zh: "适合扩大 Agent 协作规模的构建者和团队。" },
  "billing.founder": { en: "Founder", zh: "创始成员版" },
  "billing.free": { en: "Free", zh: "免费版" },
  "billing.grandfatheredUnlimitedAccess": { en: "Grandfathered unlimited access.", zh: "保留的无限制访问权限。" },
  "billing.higherFileUploadLimits": { en: "Higher file upload limits", zh: "更高的文件上传额度" },
  "billing.humans": { en: "Humans", zh: "人类" },
  "billing.managePlan": { en: "Manage plan", zh: "管理套餐" },
  "billing.messageHistory": { en: "Message history", zh: "消息历史" },
  "billing.monthly": { en: "Monthly", zh: "按月" },
  "billing.moreProfessionalFeaturesComingSoon": { en: "More professional features coming soon", zh: "更多专业功能即将推出" },
  "billing.onlyServerOwnersAndAdminsCanViewBilling": { en: "Only server owners and admins can view billing.", zh: "只有服务器所有者和管理员可以查看账单。" },
  "billing.onlyServerOwnersCanChangeBilling": { en: "Only server owners can change billing.", zh: "只有服务器所有者可以更改账单。" },
  "billing.opening": { en: "Opening...", zh: "正在打开…" },
  "billing.paidPlansAreNotAvailableYet": { en: "Paid plans are not available yet.", zh: "付费套餐暂不可用。" },
  "billing.partner": { en: "Partner", zh: "合作伙伴版" },
  "billing.partnerAccessForTestingAndSponsoredUse": { en: "Partner access for testing and sponsored use.", zh: "用于测试和赞助协作的合作伙伴访问权限。" },
  "billing.planBilling": { en: "Plan & billing", zh: "套餐与账单" },
  "billing.pro": { en: "Pro", zh: "Pro" },
  "billing.raftFeaturesEnabledForPartnerTestingAndSponsor": { en: "Raft features enabled for partner testing and sponsored collaboration", zh: "为合作伙伴测试和赞助协作启用 Raft 功能" },
  "billing.seat": { en: "Seat", zh: "席位" },
  "billing.startBuildingWithAgents": { en: "Start building with agents.", zh: "开始与 Agent 一起构建。" },
  "billing.subscriptionCancellationScheduledForTheEndOf": { en: "Subscription cancellation scheduled for the end of the current billing period.", zh: "订阅已安排在当前账单周期结束时取消。" },
  "billing.subscriptionReactivatedYourCurrentProSeatCap": { en: "Subscription reactivated. Your current Pro seat capacity stays active.", zh: "订阅已重新激活，当前 Pro 席位容量继续生效。" },
  "billing.tasks": { en: "Tasks", zh: "任务" },
  "billing.unlimitedMessageHistory": { en: "Unlimited message history", zh: "无限消息历史" },
  "billing.upgradeToPro": { en: "Upgrade to Pro", zh: "升级到 Pro" },
  "billing.yearly": { en: "Yearly", zh: "按年" },

};
