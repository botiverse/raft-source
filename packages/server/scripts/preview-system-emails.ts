// Render synthetic examples only. No provider call or send entry point is used.
// node --import @oxc-node/core/register scripts/preview-system-emails.ts <output-dir>
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import * as email from "../src/services/emailService";
import { renderPaidWelcomeEmailHtml, renderPaidCheckInEmailHtml } from "../src/services/paidEmailTemplates";

const output = process.argv[2];
if (!output) throw new Error("Pass an output directory for synthetic email previews");
mkdirSync(output, { recursive: true });
const examples: Array<{ id: string; label: string; html: string; note?: string }> = [
  { id: "verification", label: "验证邮箱", html: email.renderVerificationEmailHtml("Martin", "preview-token", "/artifacts/preview") },
  { id: "password-reset", label: "重置密码", html: email.renderPasswordResetEmailHtml("Martin", "preview-token") },
  { id: "server-invite", label: "Server 邀请", html: email.renderInviteEmailHtml("Martin", "Launch team", "preview-token") },
  { id: "joint-invite", label: "Joint Channel 邀请", html: email.renderJointChannelInviteEmailHtml({ recipientName: "Martin", inviterName: "Bugen", fromServerName: "Partners", toServerName: "Launch team", toServerSlug: "preview", channelName: "launch-week", inviteId: "preview-invite" }) },
  { id: "onboarding-welcome", label: "Onboarding · 欢迎", html: email.renderOnboardingWelcomeEmailHtml({ recipientName: "Martin" }) },
  { id: "onboarding-day-one", label: "Onboarding · 次日回访", html: email.renderOnboardingDayOneCheckInEmailHtml({ recipientName: "Martin" }) },
  { id: "paid-welcome", label: "付费 · 欢迎", html: renderPaidWelcomeEmailHtml(), note: "已加入历史记录／文件空间分开说明的文案；准备稿，尚未写入 Resend。" },
  { id: "paid-checkin", label: "付费 · 第 35 天回访", html: renderPaidCheckInEmailHtml(), note: "保留使用了一段时间的开场和 talk 预约链接；准备稿，尚未写入 Resend。" },
];
for (const event of ["approved", "agent_credential", "computer_attach"] as const) {
  const label = { approved: "设备登录", agent_credential: "创建 Agent 凭据", computer_attach: "连接电脑" }[event];
  examples.push({ id: `device-${event}`, label: `安全通知 · ${label}`, html: email.renderDeviceLoginEmailHtml("Martin", event, { requestedAt: new Date("2026-10-29T10:00:00Z"), requester: { ip: "192.0.2.1", location: "Example location" }, target: { label: "Computer", value: "Preview computer" } }, "preview-revoke-token") });
}
for (const requestKind of ["publish", "offline"] as const) {
  examples.push({ id: `app-${requestKind}`, label: `应用审核 · ${requestKind === "publish" ? "上架" : "下架"}`, html: email.renderAppReviewRequestEmailHtml({ requestKind, appName: "Launch Notes", clientKey: "preview-client", description: "A shared place for launch notes.", homepageUrl: "https://example.com", category: "Productivity & Collaboration", allowedScopes: ["openid", "profile"] }) });
}
for (const locale of email.MOBILE_APP_EMAIL_LOCALES) {
  examples.push({ id: `mobile-${locale}`, label: `移动端通知 · ${locale}`, html: email.renderMobileAppDownloadEmailHtml(locale, "https://example.com/unsubscribe?token=preview"), note: "仅调整已有模板，不改变活动启停状态。" });
}
examples.push({ id: "long-name", label: "长名称与中文", html: email.renderInviteEmailHtml("名字很长的协作伙伴与团队".repeat(4), "A".repeat(180), "preview-long-token") });
for (const item of examples) writeFileSync(resolve(output, `${item.id}.html`), item.html);
writeFileSync(resolve(output, "manifest.json"), JSON.stringify(examples, null, 2));
console.log(`Rendered ${examples.length} synthetic examples; no email sent.`);
