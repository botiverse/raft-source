import { Resend } from "resend";
import {
  DISPLAY_LOCALES,
  normalizeDisplayLocale,
  type DisplayLocale,
} from "@botiverse/raft-shared";
import { getAppUrl } from "../config/appUrl.js";

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const BRAND_NAME = "Raft";
const FROM_EMAIL = process.env.FROM_EMAIL || `${BRAND_NAME} <noreply@raft.build>`;
const SLOCK_INK = "#141111";
const SLOCK_YELLOW = "#FFD440";
const SLOCK_PINK = "#FE7DA8";
const SLOCK_BODY_BG = "#FFFAEF";
const SLOCK_CARD_BG = "#FFFFFF";
const SLOCK_MUTED = "#6B6B6B";
const SLOCK_LINK = SLOCK_PINK;
const SYSTEM_FONT_FAMILY = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const RAFT_DISPLAY_FONT_FAMILY = "'Space Grotesk', Arial, sans-serif";
const NEWSLETTER_FOOTER_LINK = "#9A9A9A";
const PRIVACY_URL = "https://raft.build/privacy";
const NEWSLETTER_LEGAL_ADDRESS = "Botiverse, Inc. · 1111B S Governors Ave, Suite 95905, Dover, DE 19904, US";
const ONBOARDING_AGENT_DOCS_URL = "https://docs.raft.build/meet-your-onboarding-agent/";
export const MOBILE_APP_DOWNLOAD_URL = "https://app.raft.build/download";
export const DEFAULT_APP_REVIEW_NOTIFICATION_RECIPIENTS = ["august@botiverse.dev"] as const;
export const APP_ADMIN_REVIEW_URL = "https://slock-internal-app-admin.botiverse.dev/reviews";

const SIMPLE_EMAIL_ADDRESS_PATTERN = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/u;

export function parseAppReviewNotificationRecipients(raw: string | undefined | null): string[] {
  if (raw == null || raw.trim() === "") {
    return [...DEFAULT_APP_REVIEW_NOTIFICATION_RECIPIENTS];
  }

  const parsedRecipients = raw
    .split(",")
    .map((recipient) => recipient.trim().toLowerCase());

  if (parsedRecipients.some((recipient) => recipient === "")) {
    throw new Error(
      "APP_REVIEW_NOTIFICATION_RECIPIENTS must contain 1-50 comma-separated email addresses",
    );
  }

  const recipients = [...new Set(parsedRecipients)];

  if (
    recipients.length === 0
    || recipients.length > 50
    || recipients.some((recipient) => !SIMPLE_EMAIL_ADDRESS_PATTERN.test(recipient))
  ) {
    throw new Error(
      "APP_REVIEW_NOTIFICATION_RECIPIENTS must contain 1-50 comma-separated email addresses",
    );
  }

  return recipients;
}

export const APP_REVIEW_NOTIFICATION_RECIPIENTS = parseAppReviewNotificationRecipients(
  process.env.APP_REVIEW_NOTIFICATION_RECIPIENTS,
);

let resend: Resend | null = null;

function appUrl(): string {
  return getAppUrl();
}

function brandLogoUrl(): string {
  return `${appUrl()}/brand/raft-logo.png`;
}

function getResend(): Resend | null {
  if (!RESEND_API_KEY) return null;
  if (!resend) {
    resend = new Resend(RESEND_API_KEY);
  }
  return resend;
}

export function escapeHtmlText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

type SendEmailOptions = {
  replyTo?: string;
  from?: string;
  scheduledAt?: Date;
  idempotencyKey?: string;
};

export type EmailDelivery = {
  from: string;
  to: string | string[];
  subject: string;
  html: string;
  replyTo?: string;
  scheduledAt?: string;
};

let emailDeliveryObserverForTests: ((delivery: EmailDelivery) => void) | null = null;

export function __setEmailDeliveryObserverForTests(
  observer: ((delivery: EmailDelivery) => void) | null,
): void {
  emailDeliveryObserverForTests = observer;
}

async function sendEmail(
  to: string | string[],
  subject: string,
  html: string,
  options: SendEmailOptions = {},
): Promise<string | null> {
  const from = options.from ?? FROM_EMAIL;
  const delivery: EmailDelivery = {
    from,
    to,
    subject,
    html,
    ...(options.replyTo ? { replyTo: options.replyTo } : {}),
    scheduledAt: options.scheduledAt?.toISOString(),
  };
  emailDeliveryObserverForTests?.(delivery);
  const client = getResend();
  if (!client) {
    if (emailDeliveryObserverForTests) return null;
    const scheduledLine = options.scheduledAt ? `\n   Scheduled At: ${options.scheduledAt.toISOString()}` : "";
    const replyToLine = options.replyTo ? `\n   Reply-To: ${options.replyTo}` : "";
    const recipients = Array.isArray(to) ? to.join(", ") : to;
    console.log(`\n📧 [DEV EMAIL] From: ${from}${replyToLine}\n   To: ${recipients}\n   Subject: ${subject}${scheduledLine}\n   Body:\n${html}\n`);
    return null;
  }

  const { data, error } = await client.emails.send(
    delivery,
    {
      idempotencyKey: options.idempotencyKey,
    },
  );

  if (error) {
    console.error("Failed to send email:", error);
    throw new Error("Failed to send email");
  }

  return data?.id ?? null;
}

// ── Email Templates ──

type EmailLayoutOptions = {
  footerHtml?: string;
  fontFamily?: string;
  headHtml?: string;
  preheader?: string;
};

/** Wraps email content in a branded layout */
export function renderEmailLayout(content: string, options: EmailLayoutOptions = {}): string {
  const fontFamily = options.fontFamily ?? SYSTEM_FONT_FAMILY;
  const headHtml = options.headHtml ?? "";
  const preheader = options.preheader
    ? `<div style="display: none; max-height: 0; overflow: hidden; opacity: 0; color: transparent;">${escapeHtmlText(options.preheader)}</div>`
    : "";
  const footerHtml = options.footerHtml ?? `
          <tr>
            <td style="padding-top: 24px; text-align: center;">
              <p class="slock-muted" style="margin: 0; color: ${SLOCK_MUTED}; font-size: 12px; line-height: 1.5;">You're receiving this because this email is tied to your ${BRAND_NAME} account.</p>
            </td>
          </tr>`;

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  ${headHtml}
  <style>
    /*
      Match the newsletter dark-mode strategy: do not force the body/card into
      light colors, because Gmail iOS may invert text while preserving locked
      backgrounds. Only the brand bar keeps the yellow gradient so the logo
      remains legible under Gmail's natural dark transform.
    */
    body, .slock-shell { background-color: ${SLOCK_BODY_BG}; color: ${SLOCK_INK}; }
    .slock-email-bar { background-color: ${SLOCK_YELLOW}; background-image: linear-gradient(${SLOCK_YELLOW}, ${SLOCK_YELLOW}); color: ${SLOCK_INK}; }
    .slock-card, .slock-content { background-color: ${SLOCK_CARD_BG}; color: ${SLOCK_INK}; }
    .slock-content strong { color: inherit; }
    .slock-button { background-color: ${SLOCK_YELLOW}; color: ${SLOCK_INK}; }
    .slock-link { color: ${SLOCK_LINK}; }
    .slock-muted { color: ${SLOCK_MUTED}; }
  </style>
</head>
<body class="slock-shell" style="margin: 0; padding: 0; background-color: ${SLOCK_BODY_BG}; color: ${SLOCK_INK}; font-family: ${fontFamily};">
  ${preheader}
  <table class="slock-shell" role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color: ${SLOCK_BODY_BG}; color: ${SLOCK_INK}; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width: 480px; width: 100%;">
          <!-- Card -->
          <tr>
            <td class="slock-card" style="background-color: ${SLOCK_CARD_BG}; color: ${SLOCK_INK}; border: 2px solid ${SLOCK_INK}; box-shadow: 4px 4px 0 ${SLOCK_INK}; padding: 0;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td class="slock-email-bar" style="background-color: ${SLOCK_YELLOW}; background-image: linear-gradient(${SLOCK_YELLOW}, ${SLOCK_YELLOW}); color: ${SLOCK_INK}; border-bottom: 2px solid ${SLOCK_INK}; padding: 16px 24px; text-align: center;">
                    <img class="slock-brand" src="${brandLogoUrl()}" width="162" height="40" alt="${BRAND_NAME}" style="display: block; margin: 0 auto; border: 0; outline: none; text-decoration: none;">
                  </td>
                </tr>
                <tr>
                  <td class="slock-content" style="background-color: ${SLOCK_CARD_BG}; color: ${SLOCK_INK}; padding: 32px 24px;">
                    ${content}
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <!-- Footer -->
          ${footerHtml}
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/** Generates a neo-brutalism CTA button */
function emailButton(
  href: string,
  label: string,
  options: {
    backgroundColor?: string;
    fontFamily?: string;
    fontSize?: number;
    padding?: string;
    shadowOffset?: number;
  } = {},
): string {
  const safeHref = escapeHtmlText(href);
  const safeLabel = escapeHtmlText(label);
  const backgroundColor = options.backgroundColor ?? SLOCK_YELLOW;
  const fontFamily = options.fontFamily ?? SYSTEM_FONT_FAMILY;
  const fontSize = options.fontSize ?? 15;
  const padding = options.padding ?? "12px 28px";
  const shadowOffset = options.shadowOffset ?? 4;
  return `
<div style="margin: 24px 0;">
  <a class="slock-button" href="${safeHref}" target="_blank" style="display: inline-block; background-color: ${backgroundColor}; color: ${SLOCK_INK}; font-family: ${fontFamily}; font-size: ${fontSize}px; font-weight: bold; text-decoration: none; padding: ${padding}; border: 2px solid ${SLOCK_INK}; box-shadow: ${shadowOffset}px ${shadowOffset}px 0 ${SLOCK_INK}; letter-spacing: 0.5px;">${safeLabel}</a>
</div>`;
}

function feedbackCommunityUrl(): string {
  return process.env.FEEDBACK_RECEIPT_COMMUNITY_URL || "https://app.raft.build/join/2ygbinDD9pvXuySuJrSEjg";
}

function feedbackReceiptFromEmail(): string {
  return process.env.FEEDBACK_RECEIPT_FROM_EMAIL || `Cindy at ${BRAND_NAME} <cindy@raft.build>`;
}

export function isFeedbackReportReceiptEmailEnabled(): boolean {
  return process.env.FEEDBACK_RECEIPT_EMAIL_ENABLED === "true";
}

export function renderFeedbackReportReceiptEmailHtml(input: {
  recipientName?: string | null;
  locale?: string | null;
} = {}): string {
  const communityUrl = feedbackCommunityUrl();
  const recipientName = input.recipientName?.trim() ? escapeHtmlText(input.recipientName.trim()) : null;
  const greeting = recipientName
    ? `<p style="margin: 0 0 8px 0; color: ${SLOCK_INK}; font-size: 15px; line-height: 1.5;">Hi ${recipientName},</p>`
    : "";

  return renderEmailLayout(`
    <h1 style="margin: 0 0 16px 0; color: ${SLOCK_INK}; font-size: 22px; font-weight: bold;">We got your feedback 🙏</h1>
    ${greeting}
    <p style="margin: 0 0 8px 0; color: ${SLOCK_INK}; font-size: 15px; line-height: 1.5;">Thanks for sending this our way — your report came through and it's with our team. We'll follow up.</p>
    <p style="margin: 0; color: ${SLOCK_INK}; font-size: 15px; line-height: 1.5;">Have a question or want to reach us? Come say hi in our community.</p>
    ${emailButton(communityUrl, "Join the Raft community")}
    <p class="slock-muted" style="margin: 0 0 16px 0; color: ${SLOCK_MUTED}; font-size: 13px; line-height: 1.5;">Or copy this link: <a class="slock-link" href="${communityUrl}" style="color: ${SLOCK_LINK}; word-break: break-all;">${communityUrl}</a></p>
    <p style="margin: 0; color: ${SLOCK_INK}; font-size: 15px; line-height: 1.5;">Thanks for helping make ${BRAND_NAME} better.</p>
    <p style="margin: 24px 0 0 0; color: ${SLOCK_INK}; font-size: 15px; line-height: 1.5;">— Cindy &amp; the ${BRAND_NAME} team</p>
  `);
}

export async function sendFeedbackReportReceiptEmail(
  to: string,
  input: {
    recipientName?: string | null;
    locale?: string | null;
  } = {},
): Promise<void> {
  const html = renderFeedbackReportReceiptEmailHtml(input);
  await sendEmail(to, "We got your feedback 🙏", html, {
    from: feedbackReceiptFromEmail(),
  });
}

export type AppReviewRequestEmailInput = {
  requestKind: "publish" | "offline";
  appName: string;
  clientKey: string;
  description: string | null;
  homepageUrl: string | null;
  category: string;
  allowedScopes: string[] | null;
};

function safeAppReviewHomepageUrl(value: string | null): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (
      (parsed.protocol !== "https:" && parsed.protocol !== "http:")
      || parsed.username
      || parsed.password
    ) {
      return null;
    }
    parsed.search = "";
    parsed.hash = "";
    return escapeHtmlText(parsed.toString());
  } catch {
    return null;
  }
}

function safeEmailSubjectText(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
}

export function renderAppReviewRequestEmailHtml(input: AppReviewRequestEmailInput): string {
  const requestLabel = input.requestKind === "publish" ? "Public marketplace" : "Marketplace offline";
  const safeName = escapeHtmlText(input.appName);
  const safeClientKey = escapeHtmlText(input.clientKey);
  const safeDescription = input.description?.trim()
    ? escapeHtmlText(input.description.trim())
    : "No description provided.";
  const safeCategory = escapeHtmlText(input.category);
  const safeHomepageUrl = safeAppReviewHomepageUrl(input.homepageUrl);
  const safeScopes = input.allowedScopes?.length
    ? input.allowedScopes.map((scope) => escapeHtmlText(scope)).join(", ")
    : "None declared";

  return renderEmailLayout(`
    <h1 style="margin: 0 0 16px 0; color: ${SLOCK_INK}; font-size: 22px; font-weight: bold;">App review requested</h1>
    <p style="margin: 0 0 16px 0; color: ${SLOCK_INK}; font-size: 15px; line-height: 1.5;">A developer requested <strong>${requestLabel.toLowerCase()}</strong> review for an app.</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin: 0 0 16px 0; border-collapse: collapse;">
      <tr><td style="padding: 4px 8px 4px 0; color: ${SLOCK_MUTED}; font-size: 13px; vertical-align: top;">Request</td><td style="padding: 4px 0; color: ${SLOCK_INK}; font-size: 13px;"><strong>${requestLabel}</strong></td></tr>
      <tr><td style="padding: 4px 8px 4px 0; color: ${SLOCK_MUTED}; font-size: 13px; vertical-align: top;">App</td><td style="padding: 4px 0; color: ${SLOCK_INK}; font-size: 13px;"><strong>${safeName}</strong></td></tr>
      <tr><td style="padding: 4px 8px 4px 0; color: ${SLOCK_MUTED}; font-size: 13px; vertical-align: top;">Client key</td><td style="padding: 4px 0; color: ${SLOCK_INK}; font-size: 13px; word-break: break-all;">${safeClientKey}</td></tr>
      <tr><td style="padding: 4px 8px 4px 0; color: ${SLOCK_MUTED}; font-size: 13px; vertical-align: top;">Category</td><td style="padding: 4px 0; color: ${SLOCK_INK}; font-size: 13px;">${safeCategory}</td></tr>
      <tr><td style="padding: 4px 8px 4px 0; color: ${SLOCK_MUTED}; font-size: 13px; vertical-align: top;">Description</td><td style="padding: 4px 0; color: ${SLOCK_INK}; font-size: 13px;">${safeDescription}</td></tr>
      <tr><td style="padding: 4px 8px 4px 0; color: ${SLOCK_MUTED}; font-size: 13px; vertical-align: top;">Scopes</td><td style="padding: 4px 0; color: ${SLOCK_INK}; font-size: 13px; word-break: break-word;">${safeScopes}</td></tr>
      ${safeHomepageUrl ? `<tr><td style="padding: 4px 8px 4px 0; color: ${SLOCK_MUTED}; font-size: 13px; vertical-align: top;">Homepage</td><td style="padding: 4px 0; color: ${SLOCK_INK}; font-size: 13px; word-break: break-all;"><a class="slock-link" href="${safeHomepageUrl}" style="color: ${SLOCK_LINK};">${safeHomepageUrl}</a></td></tr>` : ""}
    </table>
    ${emailButton(APP_ADMIN_REVIEW_URL, "Open App Admin")}
    <p class="slock-muted" style="margin: 0; color: ${SLOCK_MUTED}; font-size: 13px; line-height: 1.5;">Or copy this link: <a class="slock-link" href="${APP_ADMIN_REVIEW_URL}" style="color: ${SLOCK_LINK}; word-break: break-all;">${APP_ADMIN_REVIEW_URL}</a></p>
  `);
}

export async function sendAppReviewRequestEmail(
  input: AppReviewRequestEmailInput,
  options: Pick<SendEmailOptions, "idempotencyKey"> = {},
): Promise<string | null> {
  const requestLabel = input.requestKind === "publish" ? "Public review" : "Offline review";
  const safeName = safeEmailSubjectText(input.appName) || "Unnamed app";
  return sendEmail(
    APP_REVIEW_NOTIFICATION_RECIPIENTS,
    `${requestLabel} requested: ${safeName} — ${BRAND_NAME}`,
    renderAppReviewRequestEmailHtml(input),
    options,
  );
}

function onboardingReplyToEmail(): string {
  return process.env.ONBOARDING_EMAIL_REPLY_TO || "contact@raft.build";
}

function onboardingEmailFromEmail(): string {
  return process.env.ONBOARDING_EMAIL_FROM_EMAIL || `RC from ${BRAND_NAME} <rc@raft.build>`;
}

function onboardingBookingUrl(): string | null {
  const value = process.env.ONBOARDING_EMAIL_BOOKING_URL?.trim();
  return value || null;
}

function onboardingGreeting(recipientName?: string | null): string {
  const trimmed = recipientName?.trim();
  return trimmed ? `Hi ${escapeHtmlText(trimmed)},` : "Hi there,";
}

function onboardingBookingLink(): string {
  const bookingUrl = onboardingBookingUrl() || "https://cal.com/stdrc/quick-chat";
  return `<a class="slock-link" href="${escapeHtmlText(bookingUrl)}" style="color: ${SLOCK_LINK}; text-decoration: underline;">here</a>`;
}

function onboardingAgentDocsLink(): string {
  return `<a class="slock-link" href="${ONBOARDING_AGENT_DOCS_URL}" style="color: ${SLOCK_LINK}; text-decoration: underline;">here's a short guide</a>`;
}

function renderNewsletterStyleFooter(): string {
  const privacyUrl = escapeHtmlText(PRIVACY_URL);
  const legalAddress = escapeHtmlText(NEWSLETTER_LEGAL_ADDRESS);

  // Onboarding welcome/day-1 are relationship emails, not marketing: no unsubscribe.
  return `
          <tr>
            <td style="padding-top: 24px; text-align: center;">
              <p class="slock-footer-links" style="font-size:10px;line-height:1.5;color:${NEWSLETTER_FOOTER_LINK};margin:0;text-align:center;"><a href="${privacyUrl}" style="color:${NEWSLETTER_FOOTER_LINK};text-decoration:underline;">Privacy Policy</a> · <span style="color:${NEWSLETTER_FOOTER_LINK};text-decoration:none;">${legalAddress}</span></p>
            </td>
          </tr>`;
}

function renderOnboardingEmailLayout(content: string): string {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    .slock-footer-links a,
    .slock-footer-links span,
    a[x-apple-data-detectors] {
      color: ${NEWSLETTER_FOOTER_LINK} !important;
      text-decoration-color: ${NEWSLETTER_FOOTER_LINK} !important;
    }
  </style>
</head>
<body style="margin: 0; padding: 0; background-color: #FFFFFF; color: ${SLOCK_INK}; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color: #FFFFFF; color: ${SLOCK_INK}; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width: 560px; width: 100%;">
          <tr>
            <td style="color: ${SLOCK_INK}; padding: 0;">
              ${content}
            </td>
          </tr>
          ${renderNewsletterStyleFooter()}
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export function renderOnboardingWelcomeEmailHtml(input: {
  recipientName?: string | null;
} = {}): string {
  const greeting = onboardingGreeting(input.recipientName);
  const bookingLink = onboardingBookingLink();

  return renderOnboardingEmailLayout(`
    <p style="margin: 0 0 8px 0; color: ${SLOCK_INK}; font-size: 15px; line-height: 1.5;">${greeting}</p>
    <p style="margin: 0 0 12px 0; color: ${SLOCK_INK}; font-size: 15px; line-height: 1.5;">Glad to have you here on ${BRAND_NAME}. Thanks for giving it a try.</p>
    <p style="margin: 0 0 12px 0; color: ${SLOCK_INK}; font-size: 15px; line-height: 1.5;">${BRAND_NAME} is a shared workspace that puts your agents in team mode, so the team grows with you as your work scales.</p>
    <p style="margin: 0 0 12px 0; color: ${SLOCK_INK}; font-size: 15px; line-height: 1.5;">Best way to feel it: spin up your first agent and hand it something real &mdash; ${onboardingAgentDocsLink()}.</p>
    <p style="margin: 0 0 12px 0; color: ${SLOCK_INK}; font-size: 15px; line-height: 1.5;">Have any thoughts or feedback about the product? Grab 30 minutes with me ${bookingLink}.</p>
    <p style="margin: 0 0 24px 0; color: ${SLOCK_INK}; font-size: 15px; line-height: 1.5;">Or just reply to this. I read every one.</p>
    <p style="margin: 0; color: ${SLOCK_INK}; font-size: 15px; line-height: 1.5;">RC<br>Founder of ${BRAND_NAME}</p>
  `);
}

export async function sendOnboardingWelcomeEmail(
  to: string,
  input: {
    recipientName?: string | null;
  } = {},
  options: Pick<SendEmailOptions, "idempotencyKey"> = {},
): Promise<string | null> {
  const html = renderOnboardingWelcomeEmailHtml(input);
  return sendEmail(to, "Welcome to Raft", html, {
    from: onboardingEmailFromEmail(),
    replyTo: onboardingReplyToEmail(),
    idempotencyKey: options.idempotencyKey,
  });
}

export function renderOnboardingDayOneCheckInEmailHtml(input: {
  recipientName?: string | null;
} = {}): string {
  const greeting = onboardingGreeting(input.recipientName);
  const bookingLink = onboardingBookingLink();

  return renderOnboardingEmailLayout(`
    <p style="margin: 0 0 8px 0; color: ${SLOCK_INK}; font-size: 15px; line-height: 1.5;">${greeting}</p>
    <p style="margin: 0 0 12px 0; color: ${SLOCK_INK}; font-size: 15px; line-height: 1.5;">Hope you're settling in. How's it going with ${BRAND_NAME} so far?</p>
    <p style="margin: 0 0 12px 0; color: ${SLOCK_INK}; font-size: 15px; line-height: 1.5;">Getting your agent team set up the way you want can take some figuring out, and I'd rather help early than leave you stuck.</p>
    <p style="margin: 0 0 24px 0; color: ${SLOCK_INK}; font-size: 15px; line-height: 1.5;">If anything's been confusing or hasn't worked how you expected, just reply and tell us. Or grab 30 minutes ${bookingLink}.</p>
    <p style="margin: 0; color: ${SLOCK_INK}; font-size: 15px; line-height: 1.5;">RC<br>Founder of ${BRAND_NAME}</p>
  `);
}

export async function sendOnboardingDayOneCheckInEmail(
  to: string,
  input: {
    recipientName?: string | null;
  } = {},
  options: Pick<SendEmailOptions, "idempotencyKey" | "scheduledAt"> = {},
): Promise<string | null> {
  const html = renderOnboardingDayOneCheckInEmailHtml(input);
  return sendEmail(to, "How's it going with Raft?", html, {
    from: onboardingEmailFromEmail(),
    replyTo: onboardingReplyToEmail(),
    idempotencyKey: options.idempotencyKey,
    scheduledAt: options.scheduledAt,
  });
}

function mobileAppEmailFromEmail(): string {
  return process.env.MOBILE_APP_EMAIL_FROM_EMAIL || `Raft <notifications@raft.build>`;
}

function mobileAppEmailReplyToEmail(): string {
  return process.env.MOBILE_APP_EMAIL_REPLY_TO || "contact@raft.build";
}

type MobileAppEmailCopy = {
  subject: string;
  preheader: string;
  headline: string;
  body: string;
  cta: string;
  platformNote: string;
  accountFooter: string;
};

export const MOBILE_APP_EMAIL_COPY = {
  en: {
    subject: "Take Raft with you",
    preheader: "Android and iOS beta are both live.",
    headline: "Check in on your agents from anywhere",
    body: "See what your agents are doing, answer questions, and approve the next step from your phone, wherever you are.",
    cta: "Get the mobile app",
    platformNote: "Android download, or join the iOS beta.",
    accountFooter: "You're receiving this because this email is tied to your Raft account.",
  },
  "zh-cn": {
    subject: "带上 Raft，随时查看",
    preheader: "Android 和 iOS 测试版现已上线。",
    headline: "随时随地查看你的 Agent",
    body: "无论身在何处，你都可以用手机查看 Agent 正在做什么、回答问题，并批准下一步操作。",
    cta: "获取移动端应用",
    platformNote: "下载 Android 版，或加入 iOS 测试版。",
    accountFooter: "你会收到这封邮件，是因为它与你的 Raft 账户相关。",
  },
} satisfies Record<DisplayLocale, MobileAppEmailCopy>;

export const MOBILE_APP_EMAIL_LOCALES = DISPLAY_LOCALES;

function mobileAppEmailCopy(locale?: string | null): MobileAppEmailCopy {
  return MOBILE_APP_EMAIL_COPY[normalizeDisplayLocale(locale) ?? "en"];
}

export function renderMobileAppDownloadEmailHtml(locale?: string | null): string {
  const copy = mobileAppEmailCopy(locale);
  return renderEmailLayout(`
    <h1 style="margin: 0 0 16px 0; color: ${SLOCK_INK}; font-family: ${RAFT_DISPLAY_FONT_FAMILY}; font-size: 20px; line-height: 1.25; font-weight: 700;">${copy.headline}</h1>
    <p style="margin: 0; color: ${SLOCK_INK}; font-family: ${RAFT_DISPLAY_FONT_FAMILY}; font-size: 16px; line-height: 1.5;">${copy.body}</p>
    ${emailButton(MOBILE_APP_DOWNLOAD_URL, copy.cta, {
      backgroundColor: SLOCK_PINK,
      fontFamily: RAFT_DISPLAY_FONT_FAMILY,
      fontSize: 14,
      padding: "10px 16px",
      shadowOffset: 2,
    })}
    <p class="slock-muted" style="margin: -12px 0 0 0; color: ${SLOCK_MUTED}; font-family: ${RAFT_DISPLAY_FONT_FAMILY}; font-size: 12px; line-height: 1.5;">${copy.platformNote}</p>
  `, {
    fontFamily: RAFT_DISPLAY_FONT_FAMILY,
    headHtml: '<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&display=swap" rel="stylesheet">',
    preheader: copy.preheader,
    footerHtml: `
      <tr>
        <td style="padding-top: 24px; text-align: center;">
          <p class="slock-muted" style="margin: 0; color: ${SLOCK_MUTED}; font-size: 12px; line-height: 1.5;">${copy.accountFooter}</p>
        </td>
      </tr>`,
  });
}

export async function sendMobileAppDownloadEmail(
  to: string,
  options: Pick<SendEmailOptions, "idempotencyKey" | "scheduledAt"> & {
    locale?: string | null;
  } = {},
): Promise<string | null> {
  const copy = mobileAppEmailCopy(options.locale);
  return sendEmail(to, copy.subject, renderMobileAppDownloadEmailHtml(options.locale), {
    from: mobileAppEmailFromEmail(),
    replyTo: mobileAppEmailReplyToEmail(),
    idempotencyKey: options.idempotencyKey,
    scheduledAt: options.scheduledAt,
  });
}

export async function cancelScheduledEmail(emailId: string): Promise<void> {
  const client = getResend();
  if (!client) {
    console.log(`\n📧 [DEV EMAIL CANCELED] ID: ${emailId}\n`);
    return;
  }

  const { error } = await client.emails.cancel(emailId);
  if (error) {
    // Bounce/complaint events can arrive after delivery. In that case there is
    // no remaining schedule to cancel, and retrying the webhook forever would
    // hide the durable local suppression state. Only suppress a cancellation
    // error when Resend itself confirms the email is no longer scheduled.
    const current = await client.emails.get(emailId);
    if (!current.error && current.data?.last_event && current.data.last_event !== "scheduled") {
      return;
    }
    throw new Error("Failed to cancel scheduled email");
  }
}

export function renderVerificationEmailHtml(rawName: string, token: string): string {
  const url = `${appUrl()}?verify=${token}`;
  // Display names are user-chosen and land in HTML text context below.
  const name = escapeHtmlText(rawName);
  return renderEmailLayout(`
    <h1 style="margin: 0 0 16px 0; color: ${SLOCK_INK}; font-size: 22px; font-weight: bold;">Verify your email</h1>
    <p style="margin: 0 0 8px 0; color: ${SLOCK_INK}; font-size: 15px; line-height: 1.5;">Hey ${name},</p>
    <p style="margin: 0; color: ${SLOCK_INK}; font-size: 15px; line-height: 1.5;">Click the button below to verify your email address:</p>
    ${emailButton(url, "Verify Email")}
    <p class="slock-muted" style="margin: 0 0 4px 0; color: ${SLOCK_MUTED}; font-size: 13px; line-height: 1.5;">Or copy this link: <a class="slock-link" href="${url}" style="color: ${SLOCK_LINK}; word-break: break-all;">${url}</a></p>
    <p class="slock-muted" style="margin: 0 0 4px 0; color: ${SLOCK_MUTED}; font-size: 13px;">This link expires in 24 hours.</p>
    <p class="slock-muted" style="margin: 0; color: ${SLOCK_MUTED}; font-size: 13px; line-height: 1.5;">If you didn't create a ${BRAND_NAME} account, you can safely ignore this email.</p>
  `);
}

export async function sendVerificationEmail(to: string, name: string, token: string): Promise<void> {
  const html = renderVerificationEmailHtml(name, token);
  await sendEmail(to, `Verify your email — ${BRAND_NAME}`, html);
}

export function renderPasswordResetEmailHtml(rawName: string, token: string): string {
  const url = `${appUrl()}?reset=${token}`;
  // Same as the verification template: user-chosen name in HTML text context.
  const name = escapeHtmlText(rawName);
  return renderEmailLayout(`
    <h1 style="margin: 0 0 16px 0; color: ${SLOCK_INK}; font-size: 22px; font-weight: bold;">Reset your password</h1>
    <p style="margin: 0 0 8px 0; color: ${SLOCK_INK}; font-size: 15px; line-height: 1.5;">Hey ${name},</p>
    <p style="margin: 0; color: ${SLOCK_INK}; font-size: 15px; line-height: 1.5;">Someone requested a password reset for your account. Click the button below to set a new password:</p>
    ${emailButton(url, "Reset Password")}
    <p class="slock-muted" style="margin: 0 0 4px 0; color: ${SLOCK_MUTED}; font-size: 13px; line-height: 1.5;">Or copy this link: <a class="slock-link" href="${url}" style="color: ${SLOCK_LINK}; word-break: break-all;">${url}</a></p>
    <p class="slock-muted" style="margin: 0; color: ${SLOCK_MUTED}; font-size: 13px;">This link expires in 1 hour. If you didn't request this, you can safely ignore it.</p>
  `);
}

export async function sendPasswordResetEmail(to: string, name: string, token: string): Promise<void> {
  const html = renderPasswordResetEmailHtml(name, token);
  await sendEmail(to, `Reset your password — ${BRAND_NAME}`, html);
}

export function renderInviteEmailHtml(
  rawInviterName: string,
  rawServerName: string,
  token: string,
): string {
  const url = `${appUrl()}?invite=${token}`;
  // Both are attacker-controllable: a server name is user-chosen, and the
  // canonical transition feed has already carried `<img onerror=...>` as a real
  // server name. They land in HTML text context here, so they need the same
  // per-value escaping renderJointChannelInviteEmailHtml already applies.
  const inviterName = escapeHtmlText(rawInviterName);
  const serverName = escapeHtmlText(rawServerName);
  return renderEmailLayout(`
    <h1 style="margin: 0 0 16px 0; color: ${SLOCK_INK}; font-size: 22px; font-weight: bold;">You're invited!</h1>
    <p style="margin: 0 0 8px 0; color: ${SLOCK_INK}; font-size: 15px; line-height: 1.5;"><strong>${inviterName}</strong> invited you to join <strong>${serverName}</strong> on ${BRAND_NAME}.</p>
    <p style="margin: 0; color: ${SLOCK_INK}; font-size: 15px; line-height: 1.5;">${BRAND_NAME} is where humans and AI agents collaborate in real-time.</p>
    ${emailButton(url, "Accept Invite")}
    <p class="slock-muted" style="margin: 0 0 4px 0; color: ${SLOCK_MUTED}; font-size: 13px; line-height: 1.5;">Or copy this link: <a class="slock-link" href="${url}" style="color: ${SLOCK_LINK}; word-break: break-all;">${url}</a></p>
    <p class="slock-muted" style="margin: 0; color: ${SLOCK_MUTED}; font-size: 13px;">This invite expires in 7 days.</p>
  `);
}

export async function sendInviteEmail(
  to: string,
  inviterName: string,
  serverName: string,
  token: string,
): Promise<void> {
  const html = renderInviteEmailHtml(inviterName, serverName, token);
  await sendEmail(to, `${inviterName} invited you to ${serverName} — ${BRAND_NAME}`, html);
}

export function renderJointChannelInviteEmailHtml(input: {
  recipientName: string;
  inviterName: string;
  fromServerName: string;
  toServerName: string;
  toServerSlug: string;
  channelName: string;
  inviteId: string;
}): string {
  const url = `${appUrl()}/s/${encodeURIComponent(input.toServerSlug)}?jointInvite=${encodeURIComponent(input.inviteId)}`;
  const recipientName = escapeHtmlText(input.recipientName);
  const inviterName = escapeHtmlText(input.inviterName);
  const fromServerName = escapeHtmlText(input.fromServerName);
  const toServerName = escapeHtmlText(input.toServerName);
  const channelName = escapeHtmlText(input.channelName);
  return renderEmailLayout(`
    <h1 style="margin: 0 0 16px 0; color: ${SLOCK_INK}; font-size: 22px; font-weight: bold;">Joint channel invite</h1>
    <p style="margin: 0 0 8px 0; color: ${SLOCK_INK}; font-size: 15px; line-height: 1.5;">Hey ${recipientName},</p>
    <p style="margin: 0 0 8px 0; color: ${SLOCK_INK}; font-size: 15px; line-height: 1.5;"><strong>${inviterName}</strong> invited you to join <strong>#${channelName}</strong> with <strong>${fromServerName}</strong> from <strong>${toServerName}</strong>.</p>
    <p style="margin: 0; color: ${SLOCK_INK}; font-size: 15px; line-height: 1.5;">Open this link while signed in as a ${toServerName} admin to accept the invite.</p>
    ${emailButton(url, "Accept Invite")}
    <p class="slock-muted" style="margin: 0 0 4px 0; color: ${SLOCK_MUTED}; font-size: 13px; line-height: 1.5;">Or copy this link: <a class="slock-link" href="${url}" style="color: ${SLOCK_LINK}; word-break: break-all;">${url}</a></p>
    <p class="slock-muted" style="margin: 0; color: ${SLOCK_MUTED}; font-size: 13px; line-height: 1.5;">After it is accepted, admins on both servers can invite their own members and agents into the joint channel.</p>
  `);
}

export async function sendJointChannelInviteEmail(
  to: string,
  input: {
    recipientName: string;
    inviterName: string;
    fromServerName: string;
    toServerName: string;
    toServerSlug: string;
    channelName: string;
    inviteId: string;
  },
): Promise<void> {
  const html = renderJointChannelInviteEmailHtml(input);
  await sendEmail(to, `${input.fromServerName} invited you to #${input.channelName} — ${BRAND_NAME}`, html);
}
