import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import {
  __setEmailDeliveryObserverForTests,
  APP_ADMIN_REVIEW_URL,
  MOBILE_APP_EMAIL_COPY,
  MOBILE_APP_EMAIL_LOCALES,
  MOBILE_APP_DOWNLOAD_URL,
  type EmailDelivery,
  isFeedbackReportReceiptEmailEnabled,
  parseAppReviewNotificationRecipients,
  renderAppReviewRequestEmailHtml,
  renderFeedbackReportReceiptEmailHtml,
  renderInviteEmailHtml,
  renderJointChannelInviteEmailHtml,
  renderMobileAppDownloadEmailHtml,
  renderOnboardingDayOneCheckInEmailHtml,
  renderOnboardingWelcomeEmailHtml,
  renderPasswordResetEmailHtml,
  renderVerificationEmailHtml,
  sendAppReviewRequestEmail,
  sendMobileAppDownloadEmail,
  sendInviteEmail,
  sendOnboardingDayOneCheckInEmail,
  sendOnboardingWelcomeEmail,
  sendPasswordResetEmail,
  sendVerificationEmail,
} from "./emailService.js";

const LOGO_URL = "http://localhost:5173/brand/raft-logo.png";

afterEach(() => {
  __setEmailDeliveryObserverForTests(null);
});

function captureEmailDeliveries(): EmailDelivery[] {
  const deliveries: EmailDelivery[] = [];
  __setEmailDeliveryObserverForTests((delivery) => deliveries.push(delivery));
  return deliveries;
}

function renderAllTemplates(): string[] {
  return [
    renderVerificationEmailHtml("Avery", "verify-token"),
    renderPasswordResetEmailHtml("Avery", "reset-token"),
    renderInviteEmailHtml("Cindy", "Raft HQ", "invite-token"),
    renderFeedbackReportReceiptEmailHtml({ recipientName: "Avery", locale: "en-US" }),
    renderAppReviewRequestEmailHtml({
      requestKind: "publish",
      appName: "Example App",
      clientKey: "example-app",
      description: "Example description",
      homepageUrl: "https://example.com",
      category: "Productivity & Collaboration",
      allowedScopes: ["openid", "profile"],
    }),
    renderJointChannelInviteEmailHtml({
      recipientName: "Avery",
      inviterName: "Cindy",
      fromServerName: "Botiverse",
      toServerName: "Target",
      toServerSlug: "target",
      channelName: "partners",
      inviteId: "joint-invite-id",
    }),
    renderMobileAppDownloadEmailHtml(),
  ];
}

function renderDefaultFooterTemplates(): string[] {
  return [
    renderVerificationEmailHtml("Avery", "verify-token"),
    renderPasswordResetEmailHtml("Avery", "reset-token"),
    renderInviteEmailHtml("Cindy", "Raft HQ", "invite-token"),
    renderFeedbackReportReceiptEmailHtml({ recipientName: "Avery", locale: "en-US" }),
    renderAppReviewRequestEmailHtml({
      requestKind: "publish",
      appName: "Example App",
      clientKey: "example-app",
      description: "Example description",
      homepageUrl: "https://example.com",
      category: "Productivity & Collaboration",
      allowedScopes: ["openid", "profile"],
    }),
    renderJointChannelInviteEmailHtml({
      recipientName: "Avery",
      inviterName: "Cindy",
      fromServerName: "Botiverse",
      toServerName: "Target",
      toServerSlug: "target",
      channelName: "partners",
      inviteId: "joint-invite-id",
    }),
    renderMobileAppDownloadEmailHtml(),
  ];
}

function renderButtonTemplates(): string[] {
  return [
    renderVerificationEmailHtml("Avery", "verify-token"),
    renderPasswordResetEmailHtml("Avery", "reset-token"),
    renderInviteEmailHtml("Cindy", "Raft HQ", "invite-token"),
    renderFeedbackReportReceiptEmailHtml({ recipientName: "Avery", locale: "en-US" }),
    renderAppReviewRequestEmailHtml({
      requestKind: "publish",
      appName: "Example App",
      clientKey: "example-app",
      description: "Example description",
      homepageUrl: "https://example.com",
      category: "Productivity & Collaboration",
      allowedScopes: ["openid", "profile"],
    }),
    renderJointChannelInviteEmailHtml({
      recipientName: "Avery",
      inviterName: "Cindy",
      fromServerName: "Botiverse",
      toServerName: "Target",
      toServerSlug: "target",
      channelName: "partners",
      inviteId: "joint-invite-id",
    }),
  ];
}

function renderOnboardingTemplates(): string[] {
  return [
    renderOnboardingWelcomeEmailHtml({ recipientName: "Avery" }),
    renderOnboardingDayOneCheckInEmailHtml({ recipientName: "Avery" }),
  ];
}

test("transactional email templates place the current brand lockup in the card header", () => {
  for (const html of renderAllTemplates()) {
    assert.match(html, new RegExp(`src="${LOGO_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
    assert.match(html, /width="162" height="40" alt="Raft"/);
    assert.match(html, /alt="Raft"/);
    assert.match(html, /class="slock-email-bar"/);
    assert.match(html, /class="slock-brand"/);
    assert.match(html, /class="slock-card"[^>]*padding: 0/);
    assert.match(html, /border-bottom: 2px solid #141111; padding: 16px 24px; text-align: center/);
    assert.match(html, /<td class="slock-content" style="background-color: #FFFFFF; color: #141111; padding: 32px 24px;">/);
    assert.match(html, /display: block; margin: 0 auto;/);
    assert.doesNotMatch(html, /WHERE HUMANS AND AI AGENTS COLLABORATE/);
    assert.doesNotMatch(html, />Slock<\/p>/);
    assert.ok(
      html.indexOf("class=\"slock-card\"") < html.indexOf("class=\"slock-email-bar\""),
      "brand bar should live inside the email card so header and body share one shadow",
    );
    assert.doesNotMatch(html, /class="slock-banner"/);
    assert.doesNotMatch(html, /Courier New[^>]*>Slock</);
  }

  for (const html of renderDefaultFooterTemplates()) {
    assert.match(html, /You're receiving this because this email is tied to your Raft account\./);
  }
});

test("transactional email templates match the newsletter dark-mode strategy", () => {
  for (const html of renderAllTemplates()) {
    assert.doesNotMatch(html, /<meta name="color-scheme" content="light only">/);
    assert.doesNotMatch(html, /<meta name="supported-color-schemes" content="light">/);
    assert.doesNotMatch(html, /color-scheme: light/);
    assert.doesNotMatch(html, /background-image: linear-gradient\(#FFFAEF, #FFFAEF\)/);
    assert.doesNotMatch(html, /background-image: linear-gradient\(#FFFFFF, #FFFFFF\)/);
    assert.doesNotMatch(html, /background-color: #FFFFFF !important; color: #141111 !important/);
    assert.doesNotMatch(html, /<h1 class="slock-content"/);
    assert.doesNotMatch(html, /<p class="slock-content"/);
    assert.doesNotMatch(html, /<span style="color: #141111;">/);
    assert.match(html, /class="slock-email-bar" style="background-color: #FFD440; background-image: linear-gradient\(#FFD440, #FFD440\); color: #141111;/);
    assert.match(html, /class="slock-card"/);
    assert.match(html, /class="slock-content"/);
  }

  for (const html of renderButtonTemplates()) {
    assert.match(html, /class="slock-button" href="[^"]+" target="_blank" style="display: inline-block; background-color: #FFD440; color: #141111;/);
    assert.match(html, /<a class="slock-link" href="[^"]+" style="color: #FE7DA8; word-break: break-all;">/);
    assert.match(html, /class="slock-button"/);
  }
});

test("onboarding emails use a plain founder shell instead of the transactional card", () => {
  for (const html of renderOnboardingTemplates()) {
    assert.doesNotMatch(html, /class="slock-email-bar"/);
    assert.doesNotMatch(html, /class="slock-brand"/);
    assert.doesNotMatch(html, /class="slock-card"/);
    assert.doesNotMatch(html, /class="slock-content"/);
    assert.doesNotMatch(html, /border: 2px solid #141111/);
    assert.doesNotMatch(html, /box-shadow: 4px 4px 0 #141111/);
    assert.doesNotMatch(html, /background-color: #FFD440/);
    assert.doesNotMatch(html, new RegExp(`src="${LOGO_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
    assert.match(html, /max-width: 560px; width: 100%;/);
    assert.match(html, /Privacy Policy/);
    // Onboarding welcome/day-1 are relationship emails, not marketing: no unsubscribe link.
    assert.doesNotMatch(html, /Unsubscribe/i);
    assert.doesNotMatch(html, /\{\{\{RESEND_UNSUBSCRIBE_URL\}\}\}/);
    assert.match(html, /class="slock-footer-links"/);
    assert.match(html, /a\[x-apple-data-detectors\]/);
    assert.match(html, /Botiverse, Inc\. · 1111B S Governors Ave, Suite 95905, Dover, DE 19904, US/);
    assert.doesNotMatch(html, /<hr/i);
    assert.doesNotMatch(html, /border-top/i);
  }
});

test("feedback receipt email is ack-only and points users to the community", () => {
  const html = renderFeedbackReportReceiptEmailHtml({
    recipientName: "<Avery>",
    locale: "en-US",
  });

  assert.match(html, /We got your feedback 🙏/);
  assert.match(html, /Hi &lt;Avery&gt;,/);
  assert.match(html, /your report came through and it's with our team/);
  assert.match(html, /Have a question or want to reach us\? Come say hi in our community\./);
  assert.match(html, /href="https:\/\/app\.raft\.build\/join\/2ygbinDD9pvXuySuJrSEjg"/);
  assert.match(html, />Join the Raft community</);
  assert.match(html, /Cindy &amp; the Raft team/);
  assert.doesNotMatch(html, /serverId/);
  assert.doesNotMatch(html, /reportId/);
  assert.doesNotMatch(html, /diagnostic/i);
  assert.doesNotMatch(html, /<Avery>/);
});

test("feedback receipt email stays English even when locale is Chinese", () => {
  const html = renderFeedbackReportReceiptEmailHtml({
    recipientName: "小林",
    locale: "zh-CN",
  });

  assert.match(html, /We got your feedback 🙏/);
  assert.match(html, /Hi 小林,/);
  assert.match(html, /your report came through and it's with our team/);
  assert.match(html, /href="https:\/\/app\.raft\.build\/join\/2ygbinDD9pvXuySuJrSEjg"/);
  assert.match(html, />Join the Raft community</);
  assert.match(html, /Cindy &amp; the Raft team/);
  assert.doesNotMatch(html, /收到你的反馈啦/);
  assert.doesNotMatch(html, /community-cn/);
  assert.doesNotMatch(html, /serverId/);
  assert.doesNotMatch(html, /reportId/);
  assert.doesNotMatch(html, /diagnostic/i);
});

test("feedback receipt email is disabled unless explicitly enabled", () => {
  const previous = process.env.FEEDBACK_RECEIPT_EMAIL_ENABLED;
  try {
    delete process.env.FEEDBACK_RECEIPT_EMAIL_ENABLED;
    assert.equal(isFeedbackReportReceiptEmailEnabled(), false);

    process.env.FEEDBACK_RECEIPT_EMAIL_ENABLED = "false";
    assert.equal(isFeedbackReportReceiptEmailEnabled(), false);

    process.env.FEEDBACK_RECEIPT_EMAIL_ENABLED = "true";
    assert.equal(isFeedbackReportReceiptEmailEnabled(), true);
  } finally {
    if (previous === undefined) delete process.env.FEEDBACK_RECEIPT_EMAIL_ENABLED;
    else process.env.FEEDBACK_RECEIPT_EMAIL_ENABLED = previous;
  }
});

test("app review email renders a minimal escaped app summary and the canonical App Admin URL", () => {
  const publishHtml = renderAppReviewRequestEmailHtml({
    requestKind: "publish",
    appName: "<Publish & Review>",
    clientKey: "publish-client",
    description: "<script>alert('no')</script>",
    homepageUrl: "https://example.com/app?from=email&kind=publish#private",
    category: "Productivity & Collaboration",
    allowedScopes: ["openid", "agent:event:write"],
  });
  const offlineHtml = renderAppReviewRequestEmailHtml({
    requestKind: "offline",
    appName: "Offline App",
    clientKey: "offline-client",
    description: null,
    homepageUrl: null,
    category: "Infrastructure",
    allowedScopes: null,
  });

  assert.match(publishHtml, /Public marketplace/);
  assert.match(publishHtml, /&lt;Publish &amp; Review&gt;/);
  assert.match(publishHtml, /&lt;script&gt;alert\(&#39;no&#39;\)&lt;\/script&gt;/);
  assert.match(publishHtml, /publish-client/);
  assert.match(publishHtml, /openid, agent:event:write/);
  assert.match(publishHtml, /https:\/\/example\.com\/app/);
  assert.doesNotMatch(publishHtml, /from=email|private/);
  assert.match(publishHtml, new RegExp(APP_ADMIN_REVIEW_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(publishHtml, /<script>alert/);

  assert.match(offlineHtml, /Marketplace offline/);
  assert.match(offlineHtml, /Offline App/);
  assert.match(offlineHtml, /No description provided\./);
  assert.match(offlineHtml, /None declared/);
  assert.doesNotMatch(offlineHtml, />Homepage</);
});

test("app review email omits unsafe homepage URLs", () => {
  for (const homepageUrl of [
    "javascript:alert(1)",
    "https://user:secret@example.com/app",
    "not a URL",
  ]) {
    const html = renderAppReviewRequestEmailHtml({
      requestKind: "publish",
      appName: "Safe App",
      clientKey: "safe-app",
      description: null,
      homepageUrl,
      category: "Other",
      allowedScopes: [],
    });
    assert.doesNotMatch(html, />Homepage</);
    assert.doesNotMatch(html, /secret|javascript:|not a URL/);
  }
});

test("app review recipients default safely and parse a deduplicated comma-separated list", () => {
  assert.deepEqual(parseAppReviewNotificationRecipients(undefined), ["august@botiverse.dev"]);
  assert.deepEqual(parseAppReviewNotificationRecipients("  "), ["august@botiverse.dev"]);
  assert.deepEqual(
    parseAppReviewNotificationRecipients("First@example.com, second@example.com, FIRST@example.com"),
    ["first@example.com", "second@example.com"],
  );
});

test("app review recipients fail closed for malformed, empty, or oversized configuration", () => {
  assert.throws(
    () => parseAppReviewNotificationRecipients("valid@example.com, not-an-email"),
    /must contain 1-50 comma-separated email addresses/,
  );
  assert.throws(
    () => parseAppReviewNotificationRecipients(","),
    /must contain 1-50 comma-separated email addresses/,
  );
  for (const raw of [
    "valid@example.com,,second@example.com",
    "valid@example.com,",
    ",valid@example.com",
  ]) {
    assert.throws(
      () => parseAppReviewNotificationRecipients(raw),
      /must contain 1-50 comma-separated email addresses/,
    );
  }
  assert.throws(
    () => parseAppReviewNotificationRecipients(
      Array.from({ length: 51 }, (_, index) => `reviewer-${index}@example.com`).join(","),
    ),
    /must contain 1-50 comma-separated email addresses/,
  );
});

test("app review send targets the configured recipient list and includes the requested action", async () => {
  const originalLog = console.log;
  const logs: string[] = [];
  console.log = (message?: unknown, ...optionalParams: unknown[]) => {
    logs.push([message, ...optionalParams].map(String).join(" "));
  };

  try {
    await sendAppReviewRequestEmail({
      requestKind: "offline",
      appName: "Offline App\r\nBcc: attacker@example.com",
      clientKey: "offline-client",
      description: "Remove this listing",
      homepageUrl: "https://example.com",
      category: "Infrastructure",
      allowedScopes: ["openid"],
    }, {
      idempotencyKey: "oauth-client-review:offline:test",
    });
  } finally {
    console.log = originalLog;
  }

  const devEmail = logs.join("\n");
  assert.match(devEmail, /To: august@botiverse\.dev/);
  assert.match(devEmail, /Subject: Offline review requested: Offline App Bcc: attacker@example\.com — Raft/);
  assert.doesNotMatch(devEmail, /Subject: Offline review requested: Offline App\r?\n/);
  assert.match(devEmail, /slock-internal-app-admin\.botiverse\.dev\/reviews/);
});

test("onboarding welcome email uses RC founder voice and escapes recipient text", () => {
  const html = renderOnboardingWelcomeEmailHtml({ recipientName: "<Avery>" });

  assert.match(html, /Hi &lt;Avery&gt;,/);
  assert.match(html, /Glad to have you here on Raft\. Thanks for giving it a try\./);
  assert.match(html, /puts your agents in team mode/);
  assert.match(html, /as your work scales/);
  assert.match(html, /Best way to feel it: spin up your first agent and hand it something real &mdash; <a class="slock-link" href="https:\/\/docs\.raft\.build\/meet-your-onboarding-agent\/"[^>]*>here's a short guide<\/a>\./);
  assert.doesNotMatch(html, /Here's a short guide to meet your onboarding agent:/);
  assert.doesNotMatch(html, />https:\/\/docs\.raft\.build\/meet-your-onboarding-agent\//);
  assert.doesNotMatch(html, /It'll help you set things up as you go/);
  assert.match(html, /Grab 30 minutes with me/);
  assert.match(html, /RC<br>Founder of Raft/);
  assert.doesNotMatch(html, /<Avery>/);
  assert.doesNotMatch(html, /I'm really glad/);
  assert.doesNotMatch(html, /Grab 15 minutes/);
  assert.doesNotMatch(html, />Open Raft</);
  assert.doesNotMatch(html, /Cindy/);
});

test("onboarding check-in email avoids behavior-surveillance wording", () => {
  const html = renderOnboardingDayOneCheckInEmailHtml({ recipientName: "Avery" });

  assert.match(html, /How's it going with Raft so far\?/);
  assert.match(html, /Getting your agent team set up/);
  // Plural since 2026-08-06: replies route to contact@raft.build, so the copy
  // must not promise a single person. Cindy's option C.
  assert.match(html, /just reply and tell us/);
  assert.match(html, /grab 30 minutes/);
  assert.match(html, /RC<br>Founder of Raft/);
  assert.doesNotMatch(html, /we saw/i);
  assert.doesNotMatch(html, /noticed you/i);
  assert.doesNotMatch(html, /you haven't/i);
  assert.doesNotMatch(html, /grab 15 minutes/i);
  assert.doesNotMatch(html, />Open Raft</);
});

test("onboarding day-one send uses the final spec subject", async () => {
  const originalLog = console.log;
  const logs: string[] = [];
  console.log = (message?: unknown, ...optionalParams: unknown[]) => {
    logs.push([message, ...optionalParams].map(String).join(" "));
  };

  try {
    await sendOnboardingDayOneCheckInEmail("avery@example.com", { recipientName: "Avery" });
  } finally {
    console.log = originalLog;
  }

  const devEmail = logs.join("\n");
  assert.match(devEmail, /Subject: How's it going with Raft\?/);
  assert.doesNotMatch(devEmail, /Subject: How's it going so far\?/);
});

test("mobile-app lifecycle email has one download action and no founder identity", () => {
  const html = renderMobileAppDownloadEmailHtml();
  const renderedBody = html.replace(/<style>[\s\S]*?<\/style>/g, "");

  assert.match(html, /Check in on your agents from anywhere/);
  assert.match(html, /See what your agents are doing, answer questions, and approve the next step/);
  assert.match(html, /display: none; max-height: 0;[^>]+>Android and iOS beta are both live\.<\/div>/);
  assert.match(html, /Android download, or join the iOS beta/);
  assert.match(html, />Get the mobile app<\/a>/);
  assert.match(html, /font-family: 'Space Grotesk', Arial, sans-serif; font-size: 20px/);
  assert.match(html, /font-family: 'Space Grotesk', Arial, sans-serif; font-size: 16px/);
  assert.match(html, /background-color: #FE7DA8;[^>]+font-size: 14px/);
  assert.equal((html.match(new RegExp(MOBILE_APP_DOWNLOAD_URL.replaceAll(".", "\\."), "g")) ?? []).length, 1);
  assert.doesNotMatch(html, /RC|Founder|Cindy/);
  assert.doesNotMatch(renderedBody, /App Store|Google Play/);
});

test("mobile-app lifecycle email has complete English and Simplified Chinese catalogs", () => {
  assert.deepEqual(Object.keys(MOBILE_APP_EMAIL_COPY).sort(), [...MOBILE_APP_EMAIL_LOCALES].sort());

  const chinese = renderMobileAppDownloadEmailHtml("zh-CN");
  assert.match(chinese, /随时随地查看你的 Agent/);
  assert.match(chinese, /无论身在何处，你都可以用手机查看 Agent 正在做什么、回答问题，并批准下一步操作。/);
  assert.match(chinese, />获取移动端应用<\/a>/);
  assert.match(chinese, /下载 Android 版，或加入 iOS 测试版。/);
  assert.match(chinese, /你会收到这封邮件，是因为它与你的 Raft 账户相关。/);
  assert.match(chinese, /display: none; max-height: 0;[^>]+>Android 和 iOS 测试版现已上线。<\/div>/);
  assert.doesNotMatch(chinese, /You're receiving this because this email is tied to your Raft account\./);
  assert.equal((chinese.match(new RegExp(MOBILE_APP_DOWNLOAD_URL.replaceAll(".", "\\."), "g")) ?? []).length, 1);

  const unsupportedFallback = renderMobileAppDownloadEmailHtml("fr-FR");
  assert.match(unsupportedFallback, /Check in on your agents from anywhere/);
  assert.doesNotMatch(unsupportedFallback, /随时随地/);
});

test("mobile-app lifecycle send uses the system sender, monitored reply path, and schedule", async () => {
  const deliveries = captureEmailDeliveries();
  const scheduledAt = new Date("2026-08-24T00:00:00.000Z");

  await sendMobileAppDownloadEmail("avery@example.com", {
    idempotencyKey: "mobile-app-test",
    scheduledAt,
  });

  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0]?.from, "Raft <notifications@raft.build>");
  assert.equal(deliveries[0]?.to, "avery@example.com");
  assert.equal(deliveries[0]?.replyTo, "contact@raft.build");
  assert.equal(deliveries[0]?.subject, "Take Raft with you");
  assert.equal(deliveries[0]?.scheduledAt, "2026-08-24T00:00:00.000Z");
});

test("mobile-app lifecycle send localizes the subject and falls back to English", async () => {
  const deliveries = captureEmailDeliveries();
  await sendMobileAppDownloadEmail("zh@example.com", { locale: "zh-cn" });
  await sendMobileAppDownloadEmail("fallback@example.com", { locale: "fr-FR" });

  assert.equal(deliveries[0]?.subject, "带上 Raft，随时查看");
  assert.match(deliveries[0]?.html ?? "", /获取移动端应用/);
  assert.equal(deliveries[1]?.subject, "Take Raft with you");
  assert.match(deliveries[1]?.html ?? "", /Get the mobile app/);
});

test("onboarding emails use Hi there fallback, here booking href, and newsletter footer", () => {
  const previousBookingUrl = process.env.ONBOARDING_EMAIL_BOOKING_URL;
  try {
    delete process.env.ONBOARDING_EMAIL_BOOKING_URL;
    const fallbackHtml = renderOnboardingWelcomeEmailHtml();
    assert.match(fallbackHtml, /Hi there,/);
    assert.match(fallbackHtml, /href="https:\/\/cal\.com\/stdrc\/quick-chat"[^>]*>here<\/a>/);
    assert.doesNotMatch(fallbackHtml, /Hi,/);

    process.env.ONBOARDING_EMAIL_BOOKING_URL = "https://cal.example.com/cindy?source=welcome&team=raft";
    const welcomeHtml = renderOnboardingWelcomeEmailHtml({ recipientName: "Avery" });
    const checkInHtml = renderOnboardingDayOneCheckInEmailHtml({ recipientName: "Avery" });

    for (const html of [welcomeHtml, checkInHtml]) {
      assert.match(html, /href="https:\/\/cal\.example\.com\/cindy\?source=welcome&amp;team=raft"[^>]*>here<\/a>/);
      assert.match(
        html,
        /<a href="https:\/\/raft\.build\/privacy" style="color:#9A9A9A;text-decoration:underline;">Privacy Policy<\/a> · <span style="color:#9A9A9A;text-decoration:none;">Botiverse, Inc\. · 1111B S Governors Ave, Suite 95905, Dover, DE 19904, US<\/span>/,
      );
      assert.doesNotMatch(html, /Unsubscribe/i);
      assert.doesNotMatch(html, /\{\{\{RESEND_UNSUBSCRIBE_URL\}\}\}/);
      assert.doesNotMatch(html, /margin:140px 0 0 0/);
      assert.doesNotMatch(html, /Book a time here/);
      assert.doesNotMatch(html, /book a time with Cindy/);
      assert.doesNotMatch(html, />https?:\/\/[^<]+<\/a>/);
    }
  } finally {
    if (previousBookingUrl === undefined) delete process.env.ONBOARDING_EMAIL_BOOKING_URL;
    else process.env.ONBOARDING_EMAIL_BOOKING_URL = previousBookingUrl;
  }
});

test("verification email explains what to do if the recipient did not sign up", () => {
  const html = renderVerificationEmailHtml("Avery", "verify-token");

  assert.match(html, /If you didn't create a Raft account, you can safely ignore this email\./);
  assert.doesNotMatch(html, /If you didn't create a Slock account/);
});

test("joint channel invite email uses a direct accept link instead of My invitations", () => {
  const html = renderJointChannelInviteEmailHtml({
    recipientName: "Avery",
    inviterName: "Cindy",
    fromServerName: "Botiverse",
    toServerName: "Target",
    toServerSlug: "target",
    channelName: "partners",
    inviteId: "joint-invite-id",
  });

  assert.match(html, /href="http:\/\/localhost:5173\/s\/target\?jointInvite=joint-invite-id"/);
  assert.match(html, />Accept Invite</);
  assert.doesNotMatch(html, /My invitations/);
});

test("transactional email links and brand asset use configured APP_URL", () => {
  const previousAppUrl = process.env.APP_URL;
  process.env.APP_URL = "https://chat.example.com";
  try {
    const verifyHtml = renderVerificationEmailHtml("Avery", "verify-token");
    const feedbackHtml = renderFeedbackReportReceiptEmailHtml({ recipientName: "Avery" });
    const inviteHtml = renderJointChannelInviteEmailHtml({
      recipientName: "Avery",
      inviterName: "Cindy",
      fromServerName: "Botiverse",
      toServerName: "Target",
      toServerSlug: "target",
      channelName: "partners",
      inviteId: "joint-invite-id",
    });

    assert.match(verifyHtml, /src="https:\/\/chat\.example\.com\/brand\/raft-logo\.png"/);
    assert.match(verifyHtml, /href="https:\/\/chat\.example\.com\?verify=verify-token"/);
    assert.match(feedbackHtml, /src="https:\/\/chat\.example\.com\/brand\/raft-logo\.png"/);
    assert.match(feedbackHtml, /href="https:\/\/app\.raft\.build\/join\/2ygbinDD9pvXuySuJrSEjg"/);
    assert.match(inviteHtml, /href="https:\/\/chat\.example\.com\/s\/target\?jointInvite=joint-invite-id"/);
  } finally {
    if (previousAppUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = previousAppUrl;
  }
});

test("joint channel invite email escapes user and server controlled text", () => {
  const html = renderJointChannelInviteEmailHtml({
    recipientName: "<img src=x onerror=alert(1)>",
    inviterName: "<b onclick=alert(1)>Cindy</b>",
    fromServerName: "Botiverse <script>alert(1)</script>",
    toServerName: "Target & Friends",
    toServerSlug: "target",
    channelName: "partners\"><img src=x onerror=alert(1)>",
    inviteId: "joint-invite-id",
  });

  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /&lt;b onclick=alert\(1\)&gt;Cindy&lt;\/b&gt;/);
  assert.match(html, /Botiverse &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /Target &amp; Friends/);
  assert.match(html, /partners&quot;&gt;&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<img src=x onerror=alert\(1\)>/);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.doesNotMatch(html, /<b onclick=alert\(1\)>Cindy<\/b>/);
});

test("server invite email escapes inviter and server names in HTML text context", () => {
  // The payload is the one actually observed in the 2026-08-06 canonical
  // transition feed: of 645 distinct serverName values, exactly one was
  // markup-shaped. Server names are user-chosen, so this is a live input, not a
  // hypothetical. The joint-channel template above already escaped per value;
  // this template did not, and its existing coverage only passed benign names,
  // so it stayed green while rendering `<strong><img onerror=alert(1) /></strong>`.
  const livePayload = "<img onerror=alert(1) />";
  const html = renderInviteEmailHtml(livePayload, `Acme ${livePayload}`, "invite-token");

  // Escaped marker present proves the guard was exercised, not merely that no
  // raw tag happened to appear -- a template that never rendered the value at
  // all would also show zero raw tags.
  assert.match(html, /&lt;img onerror=alert\(1\) \/&gt;/);
  assert.doesNotMatch(html, /<img onerror=alert\(1\) \/>/);

  // Each field independently: deleting either escape must fail this test, so
  // assert on both interpolation sites rather than on the document as a whole.
  assert.match(html, /<strong>&lt;img onerror=alert\(1\) \/&gt;<\/strong>/);
  assert.match(html, /<strong>Acme &lt;img onerror=alert\(1\) \/&gt;<\/strong>/);
});

test("every transactional template escapes the live feed payload in HTML text context", () => {
  // Enumerated by SINK, not by counting escapeHtmlText call sites: a prior audit
  // concluded "19 escape calls, each checked" and still missed the templates
  // that never called it at all. Each row asserts BOTH numbers — zero raw tags
  // AND at least one escaped marker — because raw=0 alone cannot distinguish
  // "the guard escaped it" from "this template never rendered the value".
  const payload = "<img onerror=alert(1) />";
  const rendered: Array<[string, string]> = [
    ["invite", renderInviteEmailHtml(payload, `Acme ${payload}`, "t")],
    ["verification", renderVerificationEmailHtml(payload, "t")],
    ["passwordReset", renderPasswordResetEmailHtml(payload, "t")],
    ["jointChannelInvite", renderJointChannelInviteEmailHtml({
      recipientName: payload, inviterName: payload, fromServerName: payload,
      toServerName: payload, toServerSlug: "s", channelName: payload, inviteId: "i",
    })],
    ["appReview", renderAppReviewRequestEmailHtml({
      requestKind: "publish", appName: payload, clientKey: "k", description: payload,
      homepageUrl: "https://example.com", category: "Productivity & Collaboration",
      allowedScopes: ["openid"],
    })],
  ];

  for (const [label, html] of rendered) {
    const raw = html.match(/<img onerror=alert\(1\) \/>/g) ?? [];
    const escaped = html.match(/&lt;img onerror=alert\(1\) \/&gt;/g) ?? [];
    assert.equal(raw.length, 0, `${label}: rendered a live tag from user-controlled text`);
    assert.ok(escaped.length > 0, `${label}: payload never reached the template, so this row proves nothing`);
  }
});

test("server invite subject stays plain text and is not HTML-encoded", async () => {
  // The subject is a plain-text channel. Applying HTML entity encoding there
  // would be a different bug -- users would see literal `&lt;` in their inbox.
  // renderInviteEmailHtml must therefore escape internally rather than mutate
  // the values sendInviteEmail also uses for the subject line.
  const deliveries = captureEmailDeliveries();
  await sendInviteEmail(
    "invitee@example.com",
    "Cindy <Founder>",
    "Raft & Friends",
    "invite-token",
  );

  assert.equal(deliveries.length, 1);
  assert.equal(
    deliveries[0]?.subject,
    "Cindy <Founder> invited you to Raft & Friends — Raft",
  );
  assert.doesNotMatch(deliveries[0]?.subject ?? "", /&lt;|&amp;/);
  assert.match(deliveries[0]?.html ?? "", /Cindy &lt;Founder&gt;/);
  assert.match(deliveries[0]?.html ?? "", /Raft &amp; Friends/);
});

test("transactional email templates do not include legacy Slock brand copy", () => {
  for (const html of renderAllTemplates()) {
    assert.doesNotMatch(html, /Slock <noreply@slock\.dev>/);
    assert.doesNotMatch(html, /raft-lockup-light/);
    assert.doesNotMatch(html, /alt="Slock"/);
    assert.doesNotMatch(html, /Slock is where humans and AI agents collaborate/);
    assert.doesNotMatch(html, /Slock account/);
  }
});

test("onboarding mail replies go to the shared inbox, and the copy promises the same thing", async () => {
  // Cindy chose option C (2026-08-06): route replies to contact@raft.build AND
  // make the promise plural. The pair matters — routing replies to a shared
  // inbox while the copy still says "tell me" promises a person and delivers a
  // queue. Assert both together so neither can regress alone.
  const previousReplyTo = process.env.ONBOARDING_EMAIL_REPLY_TO;
  delete process.env.ONBOARDING_EMAIL_REPLY_TO;
  const deliveries = captureEmailDeliveries();
  try {
    await sendOnboardingWelcomeEmail("new-user@example.com", { recipientName: "Avery" });
    await sendOnboardingDayOneCheckInEmail("new-user@example.com", { recipientName: "Avery" });
  } finally {
    if (previousReplyTo === undefined) delete process.env.ONBOARDING_EMAIL_REPLY_TO;
    else process.env.ONBOARDING_EMAIL_REPLY_TO = previousReplyTo;
  }

  assert.equal(deliveries.length, 2);
  for (const delivery of deliveries) {
    assert.equal(delivery.replyTo, "contact@raft.build");
  }
  assert.match(deliveries[1]?.html ?? "", /just reply and tell us\./);
  assert.doesNotMatch(deliveries[1]?.html ?? "", /just reply and tell me\./);
});

test("replyTo is only sent when set, so transactional mail is unchanged", async () => {
  // Verification and password-reset mail must not silently acquire a reply-to.
  const deliveries = captureEmailDeliveries();
  await sendVerificationEmail("verify@example.com", "Avery", "verify-token");
  await sendPasswordResetEmail("reset@example.com", "Avery", "reset-token");
  await sendOnboardingWelcomeEmail("welcome@example.com", { recipientName: "Avery" });

  assert.equal(deliveries.length, 3);
  assert.equal(Object.hasOwn(deliveries[0] ?? {}, "replyTo"), false);
  assert.equal(Object.hasOwn(deliveries[1] ?? {}, "replyTo"), false);
  assert.equal(deliveries[2]?.replyTo, "contact@raft.build");
});
