import assert from "node:assert/strict";
import {
  __setEmailDeliveryObserverForTests,
  APP_ADMIN_REVIEW_URL,
  MOBILE_APP_EMAIL_COPY,
  MOBILE_APP_EMAIL_LOCALES,
  MOBILE_APP_DOWNLOAD_URL,
  type EmailDelivery,
  parseAppReviewNotificationRecipients,
  renderAppReviewRequestEmailHtml,
  renderDeviceLoginEmailHtml,
  renderAccountDeletionEmail,
  renderSubscriptionEndingAfterDeletionEmail,
  renderExternalChannelInviteEmailHtml,
  renderExternalConnectResultEmailHtml,
  renderInviteEmailHtml,
  renderJointChannelInviteEmailHtml,
  renderMobileAppDownloadEmailHtml,
  renderOnboardingDayOneCheckInEmailHtml,
  renderOnboardingWelcomeEmailHtml,
  renderPasswordResetEmailHtml,
  renderSecondFactorBackupCodeUsedEmail,
  renderSecondFactorSignInLockedEmail,
  renderServerConnectApprovalEmailHtml,
  renderVerificationEmailHtml,
  verificationEmailUrl,
  sendAppReviewRequestEmail,
  sendMobileAppDownloadEmail,
  sendInviteEmail,
  sendOnboardingDayOneCheckInEmail,
  sendOnboardingWelcomeEmail,
  sendPasswordResetEmail,
  sendVerificationEmail,
} from "./emailService";

const LOGO_URL = "http://localhost:5173/brand/raft-logo.png";
const MOBILE_APP_UNSUBSCRIBE_URL =
  "https://api.raft.test/api/email/mobile-app/unsubscribe?token=test-token";

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
    renderMobileAppDownloadEmailHtml(undefined, MOBILE_APP_UNSUBSCRIBE_URL),
  ];
}

function renderDefaultFooterTemplates(): string[] {
  return [
    renderVerificationEmailHtml("Avery", "verify-token"),
    renderPasswordResetEmailHtml("Avery", "reset-token"),
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
    renderMobileAppDownloadEmailHtml(undefined, MOBILE_APP_UNSUBSCRIBE_URL),
  ];
}

function renderButtonTemplates(): string[] {
  return [
    renderVerificationEmailHtml("Avery", "verify-token"),
    renderPasswordResetEmailHtml("Avery", "reset-token"),
    renderInviteEmailHtml("Cindy", "Raft HQ", "invite-token"),
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

test("system emails use a flat readable Raft frame with pink actions", () => {
  for (const html of [...renderAllTemplates(), ...renderOnboardingTemplates()]) {
    assert.doesNotMatch(html, /box-shadow:/);
    assert.match(html, /font-size: 16px/);
    assert.match(html, /max-width: 520px/);
    assert.match(html, /color: #FF99C3/);
    assert.match(html, /prefers-color-scheme: dark/);
    assert.match(html, /color: #FF99C3 !important/);
    assert.doesNotMatch(html, /font-size:10px|light only/);
  }
  for (const html of renderAllTemplates()) {
    assert.ok(html.includes('src="' + LOGO_URL + '"'));
    assert.match(html, /width="114" height="28" alt="Raft"/);
    assert.match(html, /class="slock-email-bar" align="center"/);
    assert.doesNotMatch(html, /slock-card|border: 1px solid #DCDCDC|border-radius: 10px/);
  }
  for (const html of renderButtonTemplates()) {
    assert.match(html, /background-color: #FF99C3/);
    assert.match(html, /border: 1px solid #141111/);
    assert.match(html, /border-radius: 6px/);
  }
  for (const html of renderDefaultFooterTemplates()) {
    assert.match(html, /You're receiving this because this email is tied to your Raft account\./);
  }
});

test("an invite to an address that may have no account says why it came, not that the address is tied to an account", () => {
  const invites = [
    renderInviteEmailHtml("Cindy <b>", "Raft HQ", "invite-token"),
    renderExternalChannelInviteEmailHtml({ inviterName: "Cindy <b>", channelName: "partners", serverName: "Acme", token: "t", expiresInDays: 14 }),
  ];
  for (const html of invites) {
    assert.match(html, /You're receiving this because Cindy &lt;b&gt; invited this email address to Raft\. If you weren't expecting it, you can ignore this email\./);
    assert.doesNotMatch(html, /tied to your Raft account/);
    assert.doesNotMatch(html, /Cindy <b>/, "the inviter's name is escaped in the footer too");
  }
});

test("onboarding stays a personal letter with its original legal footer", () => {
  for (const html of renderOnboardingTemplates()) {
    assert.doesNotMatch(html, /class="slock-brand"|class="slock-email-bar"/);
    assert.match(html, /class="slock-content slock-personal"/);
    assert.match(html, /Privacy Policy/);
    assert.match(html, /Botiverse, Inc\. · 1111B S Governors Ave, Suite 95905, Dover, DE 19904, US/);
    assert.doesNotMatch(html, /Unsubscribe|RESEND_UNSUBSCRIBE_URL/);
    assert.doesNotMatch(html, /class="slock-button"/);
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

test("onboarding welcome email uses Richard founder voice and escapes recipient text", () => {
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
  assert.match(html, /Richard<br>Founder of Raft/);
  assert.doesNotMatch(html, /RC<br>Founder of Raft/);
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
  assert.match(html, /Richard<br>Founder of Raft/);
  assert.doesNotMatch(html, /RC<br>Founder of Raft/);
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
  const html = renderMobileAppDownloadEmailHtml(undefined, MOBILE_APP_UNSUBSCRIBE_URL);
  const renderedBody = html.replace(/<style>[\s\S]*?<\/style>/g, "");

  assert.match(html, /Check in on your agents from anywhere/);
  assert.match(html, /See what your agents are doing, answer questions, and approve the next step/);
  assert.match(html, /display: none; max-height: 0;[^>]+>Raft is on Google Play and the App Store\.<\/div>/);
  assert.match(html, /Android on Google Play or as a download, iOS on the App Store/);
  assert.match(html, />Get the mobile app<\/a>/);
  assert.match(html, /font-family: 'Space Grotesk', Arial, sans-serif; font-size: 22px/);
  assert.match(html, /font-family: 'Space Grotesk', Arial, sans-serif; font-size: 16px/);
  assert.match(html, /background-color: #FF99C3;[^>]+font-size: 15px/);
  assert.equal((html.match(new RegExp(MOBILE_APP_DOWNLOAD_URL.replaceAll(".", "\\."), "g")) ?? []).length, 1);
  assert.match(
    html,
    new RegExp(`href="${MOBILE_APP_UNSUBSCRIBE_URL.replaceAll(".", "\\.").replaceAll("?", "\\?")}"`),
  );
  assert.match(html, />Unsubscribe from mobile-app emails<\/a>/);
  assert.doesNotMatch(html, /RC|Founder|Cindy/);
  // Google Play is live since 10-27 (#triage:#96); iOS is on the App Store, so
  // the email no longer sends people to the TestFlight beta.
  assert.doesNotMatch(renderedBody, /TestFlight|iOS beta/);
});

test("mobile-app lifecycle email has complete catalogs for every display locale", () => {
  assert.deepEqual(Object.keys(MOBILE_APP_EMAIL_COPY).sort(), [...MOBILE_APP_EMAIL_LOCALES].sort());

  const chinese = renderMobileAppDownloadEmailHtml("zh-CN", MOBILE_APP_UNSUBSCRIBE_URL);
  assert.match(chinese, /随时随地查看你的 Agent/);
  assert.match(chinese, /无论身在何处，你都可以用手机查看 Agent 正在做什么、回答问题，并批准下一步操作。/);
  assert.match(chinese, />获取移动端应用<\/a>/);
  assert.match(chinese, /Android 版可在 Google Play 获取或直接下载，iOS 版可在 App Store 下载。/);
  assert.match(chinese, /你会收到这封邮件，是因为它与你的 Raft 账户相关。/);
  assert.match(chinese, />退订移动端应用邮件<\/a>/);
  assert.match(chinese, /display: none; max-height: 0;[^>]+>Raft 已在 Google Play 和 App Store 上线。<\/div>/);
  assert.doesNotMatch(chinese, /You're receiving this because this email is tied to your Raft account\./);
  assert.equal((chinese.match(new RegExp(MOBILE_APP_DOWNLOAD_URL.replaceAll(".", "\\."), "g")) ?? []).length, 1);

  const japanese = renderMobileAppDownloadEmailHtml("ja-JP", MOBILE_APP_UNSUBSCRIBE_URL);
  assert.match(japanese, /どこからでもエージェントの様子を確認/);
  assert.match(japanese, />モバイルアプリを入手<\/a>/);
  assert.match(japanese, />モバイルアプリに関するメールの配信を停止<\/a>/);
  assert.equal((japanese.match(new RegExp(MOBILE_APP_DOWNLOAD_URL.replaceAll(".", "\\."), "g")) ?? []).length, 1);

  const korean = renderMobileAppDownloadEmailHtml("ko", MOBILE_APP_UNSUBSCRIBE_URL);
  assert.match(korean, /어디서나 에이전트의 상황을 확인하세요/);
  assert.match(korean, />모바일 앱 받기<\/a>/);
  assert.match(korean, />모바일 앱 관련 이메일 수신 거부<\/a>/);
  assert.equal((korean.match(new RegExp(MOBILE_APP_DOWNLOAD_URL.replaceAll(".", "\\."), "g")) ?? []).length, 1);

  const unsupportedFallback = renderMobileAppDownloadEmailHtml("fr-FR", MOBILE_APP_UNSUBSCRIBE_URL);
  assert.match(unsupportedFallback, /Check in on your agents from anywhere/);
  assert.doesNotMatch(unsupportedFallback, /随时随地/);
});

test("mobile-app lifecycle send uses the system sender, monitored reply path, and schedule", async () => {
  const deliveries = captureEmailDeliveries();
  const scheduledAt = new Date("2026-08-24T00:00:00.000Z");

  await sendMobileAppDownloadEmail("avery@example.com", {
    idempotencyKey: "mobile-app-test",
    scheduledAt,
    unsubscribeUrl: MOBILE_APP_UNSUBSCRIBE_URL,
  });

  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0]?.from, "Raft <notifications@raft.build>");
  assert.equal(deliveries[0]?.to, "avery@example.com");
  assert.equal(deliveries[0]?.replyTo, "contact@raft.build");
  assert.equal(deliveries[0]?.subject, "Take Raft with you");
  assert.equal(deliveries[0]?.scheduledAt, "2026-08-24T00:00:00.000Z");
  assert.deepEqual(deliveries[0]?.headers, {
    "List-Unsubscribe": `<${MOBILE_APP_UNSUBSCRIBE_URL}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  });
});

test("mobile-app lifecycle send localizes the subject and falls back to English", async () => {
  const deliveries = captureEmailDeliveries();
  await sendMobileAppDownloadEmail("zh@example.com", {
    locale: "zh-cn",
    unsubscribeUrl: MOBILE_APP_UNSUBSCRIBE_URL,
  });
  await sendMobileAppDownloadEmail("fallback@example.com", {
    locale: "fr-FR",
    unsubscribeUrl: MOBILE_APP_UNSUBSCRIBE_URL,
  });

  assert.equal(deliveries[0]?.subject, "带上 Raft，随时查看");
  assert.match(deliveries[0]?.html ?? "", /获取移动端应用/);
  assert.equal(deliveries[1]?.subject, "Take Raft with you");
  assert.match(deliveries[1]?.html ?? "", /Get the mobile app/);
});

test("onboarding emails use Hi there fallback, here booking href, and newsletter footer", () => {
  const previousBookingUrl = process.env.ONBOARDING_EMAIL_BOOKING_URL;
  try {
    delete process.env.ONBOARDING_EMAIL_BOOKING_URL;
    const fallbackWelcomeHtml = renderOnboardingWelcomeEmailHtml();
    const fallbackCheckInHtml = renderOnboardingDayOneCheckInEmailHtml();
    assert.match(fallbackWelcomeHtml, /Hi there,/);
    assert.doesNotMatch(fallbackWelcomeHtml, /Hi,/);
    for (const html of [fallbackWelcomeHtml, fallbackCheckInHtml]) {
      assert.match(html, /href="https:\/\/cal\.com\/raft-build\/quick-chat-about-raft"[^>]*>here<\/a>/);
      assert.doesNotMatch(html, /cal\.com\/stdrc\/quick-chat/);
    }

    process.env.ONBOARDING_EMAIL_BOOKING_URL = "https://cal.example.com/cindy?source=welcome&team=raft";
    const welcomeHtml = renderOnboardingWelcomeEmailHtml({ recipientName: "Avery" });
    const checkInHtml = renderOnboardingDayOneCheckInEmailHtml({ recipientName: "Avery" });

    for (const html of [welcomeHtml, checkInHtml]) {
      assert.match(html, /href="https:\/\/cal\.example\.com\/cindy\?source=welcome&amp;team=raft"[^>]*>here<\/a>/);
      assert.match(
        html,
        /<a href="https:\/\/raft\.build\/privacy" style="color:#605D5D;text-decoration:underline;">Privacy Policy<\/a> · <span style="color:#605D5D;text-decoration:none;">Botiverse, Inc\. · 1111B S Governors Ave, Suite 95905, Dover, DE 19904, US<\/span>/,
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

test("verification link carries an app-local returnTo and drops anything else (#88)", () => {
  assert.equal(verificationEmailUrl("tok"), "http://localhost:5173?verify=tok");
  assert.equal(verificationEmailUrl("tok", "/"), "http://localhost:5173?verify=tok", "landing on / needs no returnTo");
  assert.equal(
    verificationEmailUrl("tok", "/artifacts/pt_abc/v/2?c=1#top"),
    "http://localhost:5173?verify=tok&returnTo=%2Fartifacts%2Fpt_abc%2Fv%2F2%3Fc%3D1%23top",
  );
  for (const hostile of ["//evil.com", "https://evil", "/\\evil", "/%5Cevil", "javascript:alert(1)", "/a\nb", 42, `/${"a".repeat(3000)}`]) {
    assert.equal(verificationEmailUrl("tok", hostile), "http://localhost:5173?verify=tok", String(hostile).slice(0, 40));
  }
  const html = renderVerificationEmailHtml("Avery", "tok", "/artifacts/pt_abc");
  assert.match(html, /href="http:\/\/localhost:5173\?verify=tok&amp;returnTo=%2Fartifacts%2Fpt_abc"/, "the & is escaped in the attribute");
  assert.doesNotMatch(html, /&amp;amp;/, "escaped once");
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

test("the external channel invite email says both ways in, and both invite emails say Accept invite", () => {
  const external = renderExternalChannelInviteEmailHtml({ inviterName: "Ada Lin", channelName: "launch", serverName: "Acme <b>", token: "t", expiresInDays: 14 });
  assert.match(external, /Join on your own as a guest to work with Acme &lt;b&gt;, or connect a server you're in to bring in your teammates and agents\./);
  assert.match(external, />Accept invite</);
  const server = renderInviteEmailHtml("Ada Lin", "Acme", "invite-token");
  assert.match(server, />Accept invite</);
  for (const html of [external, server]) assert.doesNotMatch(html, />Accept Invite</);
});

test("connect result emails: canceled in American spelling, and a failed connect offers another way in", () => {
  const input = { targetServerName: "Globex", channelName: "launch", hostServerName: "Acme" };
  const canceled = renderExternalConnectResultEmailHtml({ ...input, outcome: "cancelled" });
  assert.match(canceled, />Request canceled</);
  assert.doesNotMatch(canceled, /cancelled/);
  const failed = renderExternalConnectResultEmailHtml({ ...input, outcome: "failed" });
  assert.match(failed, /<strong>Globex<\/strong> couldn't be connected to <strong>#launch<\/strong>\. Your invite is still open: open the link in your invite email to try again, or choose another way to join\./);
});

test("server connect approval email greets the approver, names who asked for what, and says when the request ends", () => {
  const html = renderServerConnectApprovalEmailHtml({
    approverName: "Grace <Kim>",
    requesterName: "Lena Park",
    targetServerName: "Fabrikam",
    channelName: "launch-plan",
    hostServerName: "Acme",
    requestId: "3c9e",
    // Late in the day UTC: the date printed is the UTC one.
    expiresAt: new Date("2026-11-04T23:30:00.000Z"),
  });

  assert.match(html, />Approve connecting Fabrikam</);
  assert.match(html, />Hey Grace &lt;Kim&gt;,</);
  assert.match(html, /<strong>Lena Park<\/strong> wants to connect <strong>Fabrikam<\/strong> to <strong>#launch-plan<\/strong>, an external channel in <strong>Acme<\/strong>\. As a Fabrikam admin, you can approve or decline\./);
  assert.doesNotMatch(html, /Joint Channel|while signed in/);
  assert.match(html, />Review request</);
  assert.match(html, /href="http:\/\/localhost:5173\/server-connect-requests\/3c9e"/);
  assert.match(html, /The request ends with the invite on November 4, 2026 \(UTC\)\./);
});

test("transactional email links and brand asset use configured APP_URL", () => {
  const previousAppUrl = process.env.APP_URL;
  process.env.APP_URL = "https://chat.example.com";
  try {
    const verifyHtml = renderVerificationEmailHtml("Avery", "verify-token");
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

test("onboarding and transactional mail use the approved default sender identities", async () => {
  const previousOnboardingFrom = process.env.ONBOARDING_EMAIL_FROM_EMAIL;
  const previousOnboardingReplyTo = process.env.ONBOARDING_EMAIL_REPLY_TO;
  delete process.env.ONBOARDING_EMAIL_FROM_EMAIL;
  delete process.env.ONBOARDING_EMAIL_REPLY_TO;
  const deliveries = captureEmailDeliveries();

  try {
    await sendOnboardingWelcomeEmail("welcome@example.com", { recipientName: "Avery" });
    await sendOnboardingDayOneCheckInEmail("day-one@example.com", { recipientName: "Avery" });
    await sendVerificationEmail("verify@example.com", "Avery", "verify-token");
  } finally {
    if (previousOnboardingFrom === undefined) delete process.env.ONBOARDING_EMAIL_FROM_EMAIL;
    else process.env.ONBOARDING_EMAIL_FROM_EMAIL = previousOnboardingFrom;
    if (previousOnboardingReplyTo === undefined) delete process.env.ONBOARDING_EMAIL_REPLY_TO;
    else process.env.ONBOARDING_EMAIL_REPLY_TO = previousOnboardingReplyTo;
  }

  assert.equal(deliveries.length, 3);
  assert.equal(deliveries[0]?.from, "Richard from Raft <richard@raft.build>");
  assert.equal(deliveries[1]?.from, "Richard from Raft <richard@raft.build>");
  assert.equal(deliveries[0]?.replyTo, "contact@raft.build");
  assert.equal(deliveries[1]?.replyTo, "contact@raft.build");
  assert.equal(deliveries[2]?.from, "Raft <noreply@raft.build>");
  assert.equal(Object.hasOwn(deliveries[2] ?? {}, "replyTo"), false);
});

test("onboarding sender environment override remains authoritative", async () => {
  const previousOnboardingFrom = process.env.ONBOARDING_EMAIL_FROM_EMAIL;
  process.env.ONBOARDING_EMAIL_FROM_EMAIL = "Onboarding Override <onboarding-override@example.com>";
  const deliveries = captureEmailDeliveries();

  try {
    await sendOnboardingWelcomeEmail("welcome@example.com");
    await sendOnboardingDayOneCheckInEmail("day-one@example.com");
  } finally {
    if (previousOnboardingFrom === undefined) delete process.env.ONBOARDING_EMAIL_FROM_EMAIL;
    else process.env.ONBOARDING_EMAIL_FROM_EMAIL = previousOnboardingFrom;
  }

  assert.equal(deliveries.length, 2);
  assert.equal(deliveries[0]?.from, "Onboarding Override <onboarding-override@example.com>");
  assert.equal(deliveries[1]?.from, "Onboarding Override <onboarding-override@example.com>");
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

test("the device login email says what a password change also stops", () => {
  const html = renderDeviceLoginEmailHtml("Ada", "approved", { requestedAt: new Date("2026-10-29T00:00:00.000Z"), requester: { ip: null, location: null } }, "dvr_test");
  assert.match(html, /Then change or reset your password\. That signs you out everywhere, and the computers and agent credentials any device login set up stop working too/);
  assert.doesNotMatch(html, /signs every device out/);
});

test("two-step lock email links to the forgot-password page, escaped name, plain copy", () => {
  const { html, text } = renderSecondFactorSignInLockedEmail("<b>Ada</b>", 15);
  assert.match(text, /Reset your password by email: http:\/\/localhost:5173\/forgot-password$/m);
  assert.match(html, /href="http:\/\/localhost:5173\/forgot-password"/);
  assert.equal(html.includes("<b>Ada</b>"), false);
});

test("backup code used email: codes left, asks for a new set at 2 or fewer, and says so when none are left", () => {
  const many = renderSecondFactorBackupCodeUsedEmail("Ada", { context: "sign_in", remaining: 5 }).text;
  assert.match(many, /used to sign in to your account/);
  assert.match(many, /You have 5 backup codes left\.$/m);
  assert.equal(/Create a new set/.test(many), false);
  assert.match(renderSecondFactorBackupCodeUsedEmail("Ada", { context: "step_up", remaining: 1 }).text, /You have 1 backup code left\. Create a new set in Settings soon\./);
  const none = renderSecondFactorBackupCodeUsedEmail("Ada", { context: "step_up", remaining: 0 }).text;
  assert.match(none, /You have no backup codes left\. Create a new set in Settings/);
  assert.match(none, /If this wasn't you, change your password now/);
  const off = renderSecondFactorBackupCodeUsedEmail("Ada", { context: "disable", remaining: 0 }).text;
  assert.match(off, /turned off with it/);
  assert.equal(/Create a new set/.test(off), false);
});

test("account deletion distinguishes scheduled renewal cancellation from unconfirmed cancellation", () => {
  const event = { kind: "requested" as const, scheduledFor: new Date("2026-12-01T00:00:00Z"), paidServersEnding: [{ name: "Shared server", periodEnd: new Date("2099-12-10T00:00:00Z") }] };
  const confirmed = renderAccountDeletionEmail("Person", event);
  assert.match(confirmed.text, /subscription was scheduled to end with the current period/);
  assert.doesNotMatch(confirmed.text, /card is not charged again|2099/);
  const afterDeletion = renderSubscriptionEndingAfterDeletionEmail("Owner", { deletedName: "Person", server: { name: "Shared server", slug: "shared" } });
  assert.doesNotMatch(`${afterDeletion.subject} ${afterDeletion.text}`, /card is not charged again|subscription.*ends on|subscription stops on|subscribe again/);
  assert.match(afterDeletion.text, /current status in Plan & Billing before making changes/);
  const unconfirmed = renderAccountDeletionEmail("Person", { ...event, subscriptionCancellationUnconfirmed: true });
  assert.doesNotMatch(unconfirmed.text, /card is not charged again|subscription was scheduled to end/);
  assert.match(unconfirmed.text, /could not confirm cancellation of subscription renewal/i);
  assert.match(unconfirmed.text, /cancel account deletion first, then open Plan & Billing/i);
});
