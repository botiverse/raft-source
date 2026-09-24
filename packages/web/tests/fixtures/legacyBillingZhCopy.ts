// FROZEN SNAPSHOT of ZH_BILLING_COPY from src/utils/billingI18n.ts, taken at the
// commit that deleted that file (billing B2b).
//
// This is the reviewed pre-migration Chinese billing copy. It is the reference
// side of tests/billingCatalogEquivalence.test.ts, which asserts that every
// migrated `billing.*` id still renders EXACTLY this text.
//
// The equivalence check was originally scoped to die with billingI18n.ts, on the
// reasoning that a comparison needs both sides. But that would have retired the
// only mechanical guarantee that the zh copy was transferred rather than
// retranslated — permanently, and at the exact moment the original became
// unrecoverable from the working tree. Freezing the reference keeps the guard.
//
// DO NOT EDIT to make a test pass. A diff here means the catalog's Chinese no
// longer matches what was reviewed; either the change is intended (then change
// the catalog and update this with a reviewer's sign-off in the PR) or it is the
// regression this file exists to catch.
//
// EDITED ONCE, 2026-08-01, under that clause. @AngLee's vocabulary ruling
// (#proj-i18n:ea47a2f4) changed four of these strings, and the guard flagged all
// four — which is the outcome it was written for, not a false positive:
//   "Humans"        人类成员    -> 人类       (与 Agent 对举时)
//   "Opening..."    正在打开... -> 正在打开…   (ellipsis standardised to single …)
//   "Reactivating..."  ...      -> 正在重新激活…
//   "Updating..."      ...      -> 正在更新…
// Nothing else moved; the other 82 entries are byte-identical to the original
// ZH_BILLING_COPY.

export const LEGACY_ZH_BILLING_COPY: Readonly<Record<string, string>> = {
  "Plan & Billing": "套餐与账单",
  "Billing": "账单",
  "Current Plan": "当前套餐",
  "Manage Plan": "管理套餐",
  "Upgrade to Pro": "升级到 Pro",
  "Add Seats": "增加席位",
  "Included": "已包含",
  "Not included": "未包含",
  "Seat": "席位",
  "Humans": "人类",
  "Agents": "Agent",
  "Message History": "消息历史",
  "File uploads": "文件上传",
  "Unlimited": "无限制",
  "Monthly": "按月",
  "Yearly": "按年",
  "Billing interval": "账单周期",
  "Opening...": "正在打开…",
  "Billing portal": "账单门户",
  "Cancel subscription": "取消订阅",
  "See all features and compare plans": "查看全部功能并比较套餐",
  "How often do you want to be billed?": "你希望按什么周期付费？",
  "How many humans and agents do you need?": "你需要多少人类成员和 Agent？",
  "How many humans and agents do you want after this update?": "更新后你希望保留多少人类成员和 Agent？",
  "Checkout summary": "结账摘要",
  "Add seats summary": "增加席位摘要",
  "Subscription summary": "订阅摘要",
  "Requested humans": "所需人类成员",
  "Requested agents": "所需 Agent",
  "Billable seats": "计费席位",
  "Capacity": "容量",
  "New total": "新总价",
  "Added capacity": "新增容量",
  "Current total": "当前总价",
  "Cancel Subscription": "取消订阅",
  "Canceling": "正在取消",
  "Final Trial Period": "最终试用期",
  "Grace Period Expired": "宽限期已结束",
  "Plan Downgraded": "套餐已降级",
  "Founder": "创始成员版",
  "Partner": "合作伙伴版",
  "Free": "免费版",
  "Pro": "Pro",
  "Channels": "频道",
  "Tasks": "任务",
  "Agents on your own computers": "在自己的电脑上运行 Agent",
  "Agent reminders": "Agent 提醒",
  "Basic observability": "基础可观测性",
  "30 days of message history": "30 天消息历史",
  "100 MB file uploads/month": "每月 100 MB 文件上传",
  "Higher file upload limits": "更高的文件上传额度",
  "Unlimited message history": "无限消息历史",
  "Joint channels": "联合频道",
  "More professional features coming soon": "更多专业功能即将推出",
  "Everything in Free": "包含免费版的全部功能",
  "Everything without any limitations": "全部功能且不设限制",
  "Only server owners and admins can view billing.": "只有服务器所有者和管理员可以查看账单。",
  "Only server owners can change billing.": "只有服务器所有者可以更改账单。",
  "Paid plans are not available yet.": "付费套餐暂不可用。",
  "Grandfathered unlimited access.": "保留的无限制访问权限。",
  "Partner access for testing and sponsored use.": "用于测试和赞助协作的合作伙伴访问权限。",
  "Raft features enabled for partner testing and sponsored collaboration": "为合作伙伴测试和赞助协作启用 Raft 功能",
  "For builders and teams scaling agent collaboration.": "适合扩大 Agent 协作规模的构建者和团队。",
  "Start building with agents.": "开始与 Agent 一起构建。",
  "Open Stripe billing portal.": "打开 Stripe 账单门户。",
  "Cancel the whole Pro subscription at period end.": "在当前账单周期结束时取消整个 Pro 订阅。",
  "No new seats selected": "未选择新席位",
  "Reactivate subscription": "重新激活订阅",
  "Reactivate and add seats": "重新激活并增加席位",
  "Reactivating...": "正在重新激活…",
  "Updating...": "正在更新…",
  "Reactivate this Pro subscription before the current period ends.": "在当前周期结束前重新激活此 Pro 订阅。",
  "Reactivate this subscription and add seats.": "重新激活此订阅并增加席位。",
  "Add seats to the existing Pro subscription.": "为现有 Pro 订阅增加席位。",
  "Failed to start checkout": "无法开始结账",
  "Failed to open billing portal": "无法打开账单门户",
  "Failed to update seats": "无法更新席位",
  "Failed to cancel subscription": "无法取消订阅",
  "Seat update is pending Stripe payment confirmation.": "席位更新正在等待 Stripe 付款确认。",
  "Seat quantities are already up to date.": "席位数量已经是最新状态。",
  "Subscription reactivated. Your current Pro seat capacity stays active.": "订阅已重新激活，当前 Pro 席位容量继续生效。",
  "Seat update requested. Capacity will update after Stripe confirms payment.": "已请求更新席位，Stripe 确认付款后容量将更新。",
  "Subscription cancellation scheduled for the end of the current billing period.": "订阅已安排在当前账单周期结束时取消。",
  "Seat increases bill immediately after Stripe confirms payment. To reduce spend, cancel the whole subscription.": "Stripe 确认付款后，新增席位会立即计费。如需降低支出，请取消整个订阅。",
  "Cancel the whole Pro subscription at the end of the current billing period. The server keeps Pro capacity until the cancellation date, then returns to Free.": "在当前账单周期结束时取消整个 Pro 订阅。服务器会保留 Pro 容量直到取消日期，之后恢复为免费版。",
  "The grace period has ended. Excess agents have been stopped. Upgrade to reactivate them.": "宽限期已结束，超出额度的 Agent 已停止。升级套餐可重新激活它们。",
};
