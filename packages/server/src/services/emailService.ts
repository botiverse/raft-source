import { Resend } from "resend";
import {
  DISPLAY_LOCALES,
  normalizeDisplayLocale,
  sanitizeAppLocalReturnPath,
  type DisplayLocale,
} from "@botiverse/raft-shared";
import { getAppUrl } from "../config/appUrl";

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const BRAND_NAME = "Raft";
const FROM_EMAIL = process.env.FROM_EMAIL || `${BRAND_NAME} <noreply@raft.build>`;
const SLOCK_INK = "#141111";
const SLOCK_YELLOW = "#FFD440";
// Email-compatible sRGB fallback of raft-design attention-400.
const SLOCK_PINK = "#FF99C3";
const SLOCK_BODY_BG = "#FFFFFF";
const SLOCK_MUTED = "#605D5D";
// Cindy's October 29 selection: links and buttons use the same light pink.
const SLOCK_LINK = SLOCK_PINK;
const SYSTEM_FONT_FAMILY = "'Space Grotesk', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const RAFT_DISPLAY_FONT_FAMILY = "'Space Grotesk', Arial, sans-serif";
const NEWSLETTER_FOOTER_LINK = SLOCK_MUTED;
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
  /** The plain-text part, for mail that has one. */
  text?: string;
  replyTo?: string;
  from?: string;
  scheduledAt?: Date;
  idempotencyKey?: string;
  headers?: Record<string, string>;
};

export type EmailDelivery = {
  from: string;
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
  scheduledAt?: string;
  headers?: Record<string, string>;
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
    ...(options.text !== undefined ? { text: options.text } : {}),
    ...(options.replyTo ? { replyTo: options.replyTo } : {}),
    scheduledAt: options.scheduledAt?.toISOString(),
    ...(options.headers ? { headers: options.headers } : {}),
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
  personal?: boolean;
};

/**
 * The footer of an invite to an address that may have no account yet (a
 * server or external channel invite): why it arrived, and that it can be
 * ignored. The layout's default footer says the address is tied to a Raft
 * account, which is not true for a first invite (cindyz, copy review c_183cc0c7).
 * `inviterName` must already be escaped.
 */
function renderInviteFooterHtml(inviterName: string): string {
  return `
          <tr>
            <td style="padding-top: 24px; text-align: center;">
              <p class="slock-muted" style="margin: 0; color: ${SLOCK_MUTED}; font-size: 12px; line-height: 1.5;">You're receiving this because ${inviterName} invited this email address to ${BRAND_NAME}. If you weren't expecting it, you can ignore this email.</p>
            </td>
          </tr>`;
}

/** Wraps email content in a branded layout */
export function renderEmailLayout(content: string, options: EmailLayoutOptions = {}): string {
  const fontFamily = options.fontFamily ?? SYSTEM_FONT_FAMILY;
  const personal = options.personal ?? false;
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
  <meta name="color-scheme" content="light dark">
  ${headHtml}
  <style>
    body, .slock-shell { background-color: ${SLOCK_BODY_BG}; color: ${SLOCK_INK}; }
    .slock-content { background-color: ${SLOCK_BODY_BG}; color: ${SLOCK_INK}; }
    .slock-content { overflow-wrap: anywhere; word-break: break-word; }
    .slock-content strong { color: inherit; }
    .slock-content h1 { line-height: 28px; }
    .slock-link { color: ${SLOCK_LINK}; text-decoration: underline; }
    .slock-muted, .slock-footer-links { color: ${SLOCK_MUTED}; }
    .slock-footer-links a, .slock-footer-links span { color: ${NEWSLETTER_FOOTER_LINK}; }
    a[x-apple-data-detectors] { color: inherit !important; }
    @media (max-width: 480px) {
      .slock-outer { padding: 24px 16px !important; }
      .slock-content { padding: 0 !important; }
    }
    /* Opt-in dark mode where supported; inline light styles remain usable when
       a mail client strips this sheet. No forced light body/text gradients. */
    @media (prefers-color-scheme: dark) {
      body, .slock-shell { background-color: #1B1B19 !important; color: #E5E5E2 !important; }
      .slock-content { background-color: #1B1B19 !important; color: #E5E5E2 !important; }
      .slock-content p, .slock-content h1, .slock-content h2, .slock-content li, .slock-content td { color: #E5E5E2 !important; }
      .slock-muted, .slock-content .slock-muted, .slock-footer-links, .slock-footer-links a, .slock-footer-links span { color: #C4C4C1 !important; }
      .slock-link { color: ${SLOCK_LINK} !important; }
      .slock-button { background-color: ${SLOCK_PINK} !important; color: ${SLOCK_INK} !important; border-color: ${SLOCK_INK} !important; outline: 1px solid #E5E5E2; }
    }
  </style>
</head>
<body class="slock-shell" style="margin: 0; padding: 0; background-color: ${SLOCK_BODY_BG}; color: ${SLOCK_INK}; font-family: ${fontFamily};">
  ${preheader}
  <table class="slock-shell slock-outer" role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color: ${SLOCK_BODY_BG}; color: ${SLOCK_INK}; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table role="presentation" width="520" cellpadding="0" cellspacing="0" style="max-width: 520px; width: 100%; table-layout: fixed;">
          ${personal ? "" : `
          <tr>
            <td style="padding-bottom: 28px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr><td class="slock-email-bar" align="center" style="background-color: ${SLOCK_YELLOW}; background-image: linear-gradient(${SLOCK_YELLOW}, ${SLOCK_YELLOW}); color: ${SLOCK_INK}; padding: 30px 24px; border-radius: 6px; text-align: center;">
                  <img class="slock-brand" src="${brandLogoUrl()}" width="114" height="28" alt="${BRAND_NAME}" style="display: block; margin: 0 auto; border: 0; outline: none; text-decoration: none;">
                </td></tr>
              </table>
            </td>
          </tr>`}
          <tr>
            <td class="${personal ? "slock-content slock-personal" : "slock-content"}" style="background-color: ${SLOCK_BODY_BG}; color: ${SLOCK_INK}; padding: 0; font-size: 16px; line-height: 24px; overflow-wrap: anywhere; word-break: break-word;">
              ${content}
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

/** Email-safe primary Button: attention fill, ink edge, no shadow. */
export function renderEmailButton(
  href: string,
  label: string,
  options: {
    backgroundColor?: string;
    fontFamily?: string;
    fontSize?: number;
    padding?: string;
  } = {},
): string {
  const safeHref = escapeHtmlText(href);
  const safeLabel = escapeHtmlText(label);
  const backgroundColor = options.backgroundColor ?? SLOCK_PINK;
  const fontFamily = options.fontFamily ?? SYSTEM_FONT_FAMILY;
  const fontSize = options.fontSize ?? 15;
  const padding = options.padding ?? "10px 18px";
  return `
<div style="margin: 24px 0;">
  <a class="slock-button" href="${safeHref}" target="_blank" style="display: inline-block; background-color: ${backgroundColor}; background-image: linear-gradient(${backgroundColor}, ${backgroundColor}); color: ${SLOCK_INK}; font-family: ${fontFamily}; font-size: ${fontSize}px; font-weight: 600; text-decoration: none; padding: ${padding}; border: 1px solid ${SLOCK_INK}; border-radius: 6px; line-height: 22px; text-align: center; max-width: 100%; box-sizing: border-box;">${safeLabel}</a>
</div>`;
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
    <p style="margin: 0 0 16px 0; color: ${SLOCK_INK}; font-size: 16px; line-height: 1.5;">A developer requested <strong>${requestLabel.toLowerCase()}</strong> review for an app.</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin: 0 0 16px 0; border-collapse: collapse;">
      <tr><td style="padding: 4px 8px 4px 0; color: ${SLOCK_MUTED}; font-size: 16px; vertical-align: top;">Request</td><td style="padding: 4px 0; color: ${SLOCK_INK}; font-size: 16px;"><strong>${requestLabel}</strong></td></tr>
      <tr><td style="padding: 4px 8px 4px 0; color: ${SLOCK_MUTED}; font-size: 16px; vertical-align: top;">App</td><td style="padding: 4px 0; color: ${SLOCK_INK}; font-size: 16px;"><strong>${safeName}</strong></td></tr>
      <tr><td style="padding: 4px 8px 4px 0; color: ${SLOCK_MUTED}; font-size: 16px; vertical-align: top;">Client key</td><td style="padding: 4px 0; color: ${SLOCK_INK}; font-size: 16px; word-break: break-all;">${safeClientKey}</td></tr>
      <tr><td style="padding: 4px 8px 4px 0; color: ${SLOCK_MUTED}; font-size: 16px; vertical-align: top;">Category</td><td style="padding: 4px 0; color: ${SLOCK_INK}; font-size: 16px;">${safeCategory}</td></tr>
      <tr><td style="padding: 4px 8px 4px 0; color: ${SLOCK_MUTED}; font-size: 16px; vertical-align: top;">Description</td><td style="padding: 4px 0; color: ${SLOCK_INK}; font-size: 16px;">${safeDescription}</td></tr>
      <tr><td style="padding: 4px 8px 4px 0; color: ${SLOCK_MUTED}; font-size: 16px; vertical-align: top;">Scopes</td><td style="padding: 4px 0; color: ${SLOCK_INK}; font-size: 16px; word-break: break-word;">${safeScopes}</td></tr>
      ${safeHomepageUrl ? `<tr><td style="padding: 4px 8px 4px 0; color: ${SLOCK_MUTED}; font-size: 16px; vertical-align: top;">Homepage</td><td style="padding: 4px 0; color: ${SLOCK_INK}; font-size: 16px; word-break: break-all;"><a class="slock-link" href="${safeHomepageUrl}" style="color: ${SLOCK_LINK};">${safeHomepageUrl}</a></td></tr>` : ""}
    </table>
    ${renderEmailButton(APP_ADMIN_REVIEW_URL, "Open App Admin")}
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
  return process.env.ONBOARDING_EMAIL_FROM_EMAIL || `Richard from ${BRAND_NAME} <richard@raft.build>`;
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
  const bookingUrl = onboardingBookingUrl() || "https://cal.com/raft-build/quick-chat-about-raft";
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
              <p class="slock-footer-links" style="font-size:12px;line-height:1.5;color:${NEWSLETTER_FOOTER_LINK};margin:0;text-align:center;"><a href="${privacyUrl}" style="color:${NEWSLETTER_FOOTER_LINK};text-decoration:underline;">Privacy Policy</a> · <span style="color:${NEWSLETTER_FOOTER_LINK};text-decoration:none;">${legalAddress}</span></p>
            </td>
          </tr>`;
}

function renderOnboardingEmailLayout(content: string): string {
  return renderEmailLayout(content, {
    personal: true,
    footerHtml: renderNewsletterStyleFooter(),
  });
}

export function renderOnboardingWelcomeEmailHtml(input: {
  recipientName?: string | null;
} = {}): string {
  const greeting = onboardingGreeting(input.recipientName);
  const bookingLink = onboardingBookingLink();

  return renderOnboardingEmailLayout(`
    <p style="margin: 0 0 8px 0; color: ${SLOCK_INK}; font-size: 16px; line-height: 1.5;">${greeting}</p>
    <p style="margin: 0 0 12px 0; color: ${SLOCK_INK}; font-size: 16px; line-height: 1.5;">Glad to have you here on ${BRAND_NAME}. Thanks for giving it a try.</p>
    <p style="margin: 0 0 12px 0; color: ${SLOCK_INK}; font-size: 16px; line-height: 1.5;">${BRAND_NAME} is a shared workspace that puts your agents in team mode, so the team grows with you as your work scales.</p>
    <p style="margin: 0 0 12px 0; color: ${SLOCK_INK}; font-size: 16px; line-height: 1.5;">Best way to feel it: spin up your first agent and hand it something real &mdash; ${onboardingAgentDocsLink()}.</p>
    <p style="margin: 0 0 12px 0; color: ${SLOCK_INK}; font-size: 16px; line-height: 1.5;">Have any thoughts or feedback about the product? Grab 30 minutes with me ${bookingLink}.</p>
    <p style="margin: 0 0 24px 0; color: ${SLOCK_INK}; font-size: 16px; line-height: 1.5;">Or just reply to this. I read every one.</p>
    <p style="margin: 0; color: ${SLOCK_INK}; font-size: 16px; line-height: 1.5;">Richard<br>Founder of ${BRAND_NAME}</p>
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
    <p style="margin: 0 0 8px 0; color: ${SLOCK_INK}; font-size: 16px; line-height: 1.5;">${greeting}</p>
    <p style="margin: 0 0 12px 0; color: ${SLOCK_INK}; font-size: 16px; line-height: 1.5;">Hope you're settling in. How's it going with ${BRAND_NAME} so far?</p>
    <p style="margin: 0 0 12px 0; color: ${SLOCK_INK}; font-size: 16px; line-height: 1.5;">Getting your agent team set up the way you want can take some figuring out, and I'd rather help early than leave you stuck.</p>
    <p style="margin: 0 0 24px 0; color: ${SLOCK_INK}; font-size: 16px; line-height: 1.5;">If anything's been confusing or hasn't worked how you expected, just reply and tell us. Or grab 30 minutes ${bookingLink}.</p>
    <p style="margin: 0; color: ${SLOCK_INK}; font-size: 16px; line-height: 1.5;">Richard<br>Founder of ${BRAND_NAME}</p>
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
  unsubscribe: string;
  unsubscribePage: {
    htmlLang: string;
    confirmationTitle: string;
    confirmationHeading: string;
    confirmationBody: string;
    submit: string;
    successTitle: string;
    successHeading: string;
    successBody: string;
    invalidTitle: string;
    invalidHeading: string;
    invalidBody: string;
    failureTitle: string;
    failureHeading: string;
    failureBody: string;
  };
};

export const MOBILE_APP_EMAIL_COPY = {
  en: {
    subject: "Take Raft with you",
    preheader: "Raft is on Google Play and the App Store.",
    headline: "Check in on your agents from anywhere",
    body: "See what your agents are doing, answer questions, and approve the next step from your phone, wherever you are.",
    cta: "Get the mobile app",
    platformNote: "Android on Google Play or as a download, iOS on the App Store.",
    accountFooter: "You're receiving this because this email is tied to your Raft account.",
    unsubscribe: "Unsubscribe from mobile-app emails",
    unsubscribePage: {
      htmlLang: "en",
      confirmationTitle: "Unsubscribe from Raft mobile-app emails",
      confirmationHeading: "Unsubscribe from mobile-app emails?",
      confirmationBody: "Raft will stop sending you emails about the mobile app.",
      submit: "Unsubscribe",
      successTitle: "Unsubscribed",
      successHeading: "You are unsubscribed.",
      successBody: "Raft will no longer send you mobile-app emails.",
      invalidTitle: "Invalid unsubscribe link",
      invalidHeading: "This unsubscribe link is invalid.",
      invalidBody: "Please use the link from the original Raft email.",
      failureTitle: "Unsubscribe temporarily unavailable",
      failureHeading: "We couldn't finish your unsubscribe this time.",
      failureBody: "Please try again in a moment — the link still works.",
    },
  },
  es: {
    subject: "Lleva Raft contigo",
    preheader: "Raft ya está en Google Play y el App Store.",
    headline: "Revisa a tus agentes desde cualquier lugar",
    body: "Mira qué están haciendo tus agentes, responde preguntas y aprueba el siguiente paso desde tu teléfono, estés donde estés.",
    cta: "Obtener la app móvil",
    platformNote: "Android en Google Play o como descarga, iOS en el App Store.",
    accountFooter: "Recibes este correo porque esta dirección está vinculada a tu cuenta de Raft.",
    unsubscribe: "Dejar de recibir correos sobre la app móvil",
    unsubscribePage: {
      htmlLang: "es",
      confirmationTitle: "Dejar de recibir correos de Raft sobre la app móvil",
      confirmationHeading: "¿Dejar de recibir correos sobre la app móvil?",
      confirmationBody: "Raft dejará de enviarte correos sobre la app móvil.",
      submit: "Darme de baja",
      successTitle: "Baja completada",
      successHeading: "Te diste de baja.",
      successBody: "Raft ya no te enviará correos sobre la app móvil.",
      invalidTitle: "Enlace de baja no válido",
      invalidHeading: "Este enlace de baja no es válido.",
      invalidBody: "Usa el enlace del correo original de Raft.",
      failureTitle: "La baja no está disponible por ahora",
      failureHeading: "Esta vez no pudimos completar tu baja.",
      failureBody: "Inténtalo de nuevo en un momento; el enlace sigue funcionando.",
    },
  },
  "pt-br": {
    subject: "Leve o Raft com você",
    preheader: "O Raft já está no Google Play e na App Store.",
    headline: "Acompanhe seus agentes de qualquer lugar",
    body: "Veja o que seus agentes estão fazendo, responda perguntas e aprove o próximo passo pelo celular, onde quer que você esteja.",
    cta: "Baixar o app",
    platformNote: "Android no Google Play ou para baixar, iOS na App Store.",
    accountFooter: "Você está recebendo este e-mail porque este endereço está vinculado à sua conta do Raft.",
    unsubscribe: "Cancelar a inscrição nos e-mails sobre o app",
    unsubscribePage: {
      htmlLang: "pt-BR",
      confirmationTitle: "Cancelar a inscrição nos e-mails do Raft sobre o app",
      confirmationHeading: "Cancelar a inscrição nos e-mails sobre o app?",
      confirmationBody: "O Raft deixará de enviar e-mails sobre o app para você.",
      submit: "Cancelar inscrição",
      successTitle: "Inscrição cancelada",
      successHeading: "Sua inscrição foi cancelada.",
      successBody: "O Raft não enviará mais e-mails sobre o app para você.",
      invalidTitle: "Link de cancelamento inválido",
      invalidHeading: "Este link de cancelamento é inválido.",
      invalidBody: "Use o link do e-mail original do Raft.",
      failureTitle: "Cancelamento temporariamente indisponível",
      failureHeading: "Não foi possível concluir o cancelamento desta vez.",
      failureBody: "Tente novamente em instantes; o link continua válido.",
    },
  },
  ru: {
    subject: "Raft всегда под рукой",
    preheader: "Raft уже в Google Play и App Store.",
    headline: "Следите за агентами откуда угодно",
    body: "Смотрите, чем заняты ваши агенты, отвечайте на вопросы и одобряйте следующий шаг прямо с телефона, где бы вы ни были.",
    cta: "Скачать мобильное приложение",
    platformNote: "Android — в Google Play или по прямой ссылке, iOS — в App Store.",
    accountFooter: "Вы получили это письмо, потому что этот адрес электронной почты привязан к вашему аккаунту Raft.",
    unsubscribe: "Отписаться от писем о мобильном приложении",
    unsubscribePage: {
      htmlLang: "ru",
      confirmationTitle: "Отписаться от писем Raft о мобильном приложении",
      confirmationHeading: "Отписаться от писем о мобильном приложении?",
      confirmationBody: "Raft перестанет присылать вам письма о мобильном приложении.",
      submit: "Отписаться",
      successTitle: "Подписка отменена",
      successHeading: "Вы отписались.",
      successBody: "Raft больше не будет присылать вам письма о мобильном приложении.",
      invalidTitle: "Недействительная ссылка для отписки",
      invalidHeading: "Эта ссылка для отписки недействительна.",
      invalidBody: "Воспользуйтесь ссылкой из исходного письма Raft.",
      failureTitle: "Отписка временно недоступна",
      failureHeading: "Не удалось завершить отписку.",
      failureBody: "Попробуйте ещё раз чуть позже — ссылка по-прежнему действует.",
    },
  },
  "zh-cn": {
    subject: "带上 Raft，随时查看",
    preheader: "Raft 已在 Google Play 和 App Store 上线。",
    headline: "随时随地查看你的 Agent",
    body: "无论身在何处，你都可以用手机查看 Agent 正在做什么、回答问题，并批准下一步操作。",
    cta: "获取移动端应用",
    platformNote: "Android 版可在 Google Play 获取或直接下载，iOS 版可在 App Store 下载。",
    accountFooter: "你会收到这封邮件，是因为它与你的 Raft 账户相关。",
    unsubscribe: "退订移动端应用邮件",
    unsubscribePage: {
      htmlLang: "zh-CN",
      confirmationTitle: "退订 Raft 移动端应用邮件",
      confirmationHeading: "要退订移动端应用邮件吗？",
      confirmationBody: "Raft 将不再向你发送关于移动端应用的邮件。",
      submit: "退订",
      successTitle: "已退订",
      successHeading: "你已退订。",
      successBody: "Raft 不会再向你发送移动端应用邮件。",
      invalidTitle: "退订链接无效",
      invalidHeading: "这个退订链接无效。",
      invalidBody: "请使用 Raft 原始邮件中的链接。",
      failureTitle: "暂时无法退订",
      failureHeading: "这次没能完成退订。",
      failureBody: "请稍后再试，链接仍然有效。",
    },
  },
  ja: {
    subject: "Raft をいつでも手元に",
    preheader: "Raft が Google Play と App Store で入手できるようになりました。",
    headline: "どこからでもエージェントの様子を確認",
    body: "外出先でも、スマートフォンからエージェントの作業状況を確認し、質問に答え、次のステップを承認できます。",
    cta: "モバイルアプリを入手",
    platformNote: "Android 版は Google Play で入手するかダウンロード、iOS 版は App Store で入手できます。",
    accountFooter: "このメールは、お使いの Raft アカウントのメールアドレス宛てにお送りしています。",
    unsubscribe: "モバイルアプリに関するメールの配信を停止",
    unsubscribePage: {
      htmlLang: "ja",
      confirmationTitle: "Raft モバイルアプリのメール配信停止",
      confirmationHeading: "モバイルアプリに関するメールの配信を停止しますか？",
      confirmationBody: "Raft からモバイルアプリに関するメールが届かなくなります。",
      submit: "配信を停止",
      successTitle: "配信を停止しました",
      successHeading: "配信を停止しました。",
      successBody: "今後、Raft からモバイルアプリに関するメールは届きません。",
      invalidTitle: "無効な配信停止リンク",
      invalidHeading: "この配信停止リンクは無効です。",
      invalidBody: "Raft から届いた元のメールのリンクを使用してください。",
      failureTitle: "配信停止を一時的に利用できません",
      failureHeading: "配信停止を完了できませんでした。",
      failureBody: "しばらくしてからもう一度お試しください。リンクは引き続き有効です。",
    },
  },
  ko: {
    subject: "휴대폰에서도 Raft를 사용해 보세요",
    preheader: "Raft를 Google Play와 App Store에서 받을 수 있어요.",
    headline: "어디서나 에이전트의 상황을 확인하세요",
    body: "어디에 있든 휴대폰으로 에이전트가 무엇을 하고 있는지 확인하고, 질문에 답하고, 다음 단계를 승인할 수 있어요.",
    cta: "모바일 앱 받기",
    platformNote: "Android 앱은 Google Play에서 받거나 직접 다운로드하고, iOS 앱은 App Store에서 받으세요.",
    accountFooter: "Raft 계정에 연결된 이메일 주소라서 이 이메일을 받으셨어요.",
    unsubscribe: "모바일 앱 관련 이메일 수신 거부",
    unsubscribePage: {
      htmlLang: "ko",
      confirmationTitle: "Raft 모바일 앱 이메일 수신 거부",
      confirmationHeading: "모바일 앱 관련 이메일을 그만 받을까요?",
      confirmationBody: "Raft에서 더 이상 모바일 앱 관련 이메일을 보내지 않아요.",
      submit: "수신 거부",
      successTitle: "수신 거부 완료",
      successHeading: "수신 거부가 완료됐어요.",
      successBody: "앞으로 Raft에서 모바일 앱 관련 이메일을 보내지 않아요.",
      invalidTitle: "유효하지 않은 수신 거부 링크",
      invalidHeading: "이 수신 거부 링크는 유효하지 않아요.",
      invalidBody: "Raft에서 받은 원래 이메일의 링크를 사용해 주세요.",
      failureTitle: "지금은 수신 거부를 할 수 없어요",
      failureHeading: "이번에는 수신 거부를 완료하지 못했어요.",
      failureBody: "잠시 후 다시 시도해 주세요. 링크는 계속 유효해요.",
    },
  },
  "zh-tw": {
    subject: "帶著 Raft，隨時查看",
    preheader: "Raft 已在 Google Play 和 App Store 上架。",
    headline: "隨時隨地查看你的 Agent",
    body: "無論身在何處，你都能用手機查看 Agent 正在做什麼、回答問題，並核准下一步。",
    cta: "下載行動應用程式",
    platformNote: "Android 版可在 Google Play 取得或直接下載，iOS 版可在 App Store 下載。",
    accountFooter: "你會收到這封郵件，是因為這個電子郵件地址與你的 Raft 帳號相關聯。",
    unsubscribe: "取消訂閱行動應用程式郵件",
    unsubscribePage: {
      htmlLang: "zh-TW",
      confirmationTitle: "取消訂閱 Raft 行動應用程式郵件",
      confirmationHeading: "要取消訂閱行動應用程式郵件嗎？",
      confirmationBody: "Raft 將不再寄送關於行動應用程式的郵件給你。",
      submit: "取消訂閱",
      successTitle: "已取消訂閱",
      successHeading: "你已取消訂閱。",
      successBody: "Raft 不會再寄送行動應用程式郵件給你。",
      invalidTitle: "取消訂閱連結無效",
      invalidHeading: "這個取消訂閱連結無效。",
      invalidBody: "請使用 Raft 原始郵件中的連結。",
      failureTitle: "暫時無法取消訂閱",
      failureHeading: "這次沒能完成取消訂閱。",
      failureBody: "請稍後再試，連結仍然有效。",
    },
  },
} satisfies Record<DisplayLocale, MobileAppEmailCopy>;

export const MOBILE_APP_EMAIL_LOCALES = DISPLAY_LOCALES;

export function mobileAppEmailCopy(locale?: string | null): MobileAppEmailCopy {
  return MOBILE_APP_EMAIL_COPY[normalizeDisplayLocale(locale) ?? "en"];
}

export function renderMobileAppDownloadEmailHtml(
  locale: string | null | undefined,
  unsubscribeUrl: string,
): string {
  const copy = mobileAppEmailCopy(locale);
  const safeUnsubscribeUrl = escapeHtmlText(unsubscribeUrl);
  return renderEmailLayout(`
    <h1 style="margin: 0 0 16px 0; color: ${SLOCK_INK}; font-family: ${RAFT_DISPLAY_FONT_FAMILY}; font-size: 22px; line-height: 28px; font-weight: 700;">${copy.headline}</h1>
    <p style="margin: 0; color: ${SLOCK_INK}; font-family: ${RAFT_DISPLAY_FONT_FAMILY}; font-size: 16px; line-height: 1.5;">${copy.body}</p>
    ${renderEmailButton(MOBILE_APP_DOWNLOAD_URL, copy.cta, {
      backgroundColor: SLOCK_PINK,
      fontFamily: RAFT_DISPLAY_FONT_FAMILY,
    })}
    <p class="slock-muted" style="margin: -12px 0 0 0; color: ${SLOCK_MUTED}; font-family: ${RAFT_DISPLAY_FONT_FAMILY}; font-size: 12px; line-height: 1.5;">${copy.platformNote}</p>
  `, {
    fontFamily: RAFT_DISPLAY_FONT_FAMILY,
    headHtml: '<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&display=swap" rel="stylesheet">',
    preheader: copy.preheader,
    footerHtml: `
      <tr>
        <td style="padding-top: 24px; text-align: center;">
          <p class="slock-muted slock-footer-links" style="margin: 0; color: ${SLOCK_MUTED}; font-size: 12px; line-height: 1.5;">${copy.accountFooter}<br><a href="${safeUnsubscribeUrl}" style="color:${SLOCK_MUTED};text-decoration:underline;">${copy.unsubscribe}</a></p>
        </td>
      </tr>`,
  });
}

export async function sendMobileAppDownloadEmail(
  to: string,
  options: Pick<SendEmailOptions, "idempotencyKey" | "scheduledAt"> & {
    locale?: string | null;
    unsubscribeUrl: string;
  },
): Promise<string | null> {
  const copy = mobileAppEmailCopy(options.locale);
  return sendEmail(to, copy.subject, renderMobileAppDownloadEmailHtml(options.locale, options.unsubscribeUrl), {
    from: mobileAppEmailFromEmail(),
    replyTo: mobileAppEmailReplyToEmail(),
    idempotencyKey: options.idempotencyKey,
    scheduledAt: options.scheduledAt,
    headers: {
      "List-Unsubscribe": `<${options.unsubscribeUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
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

/**
 * The verification link: `/?verify=<token>`, plus `&returnTo=<path>` when the
 * person signed up from a page they want to land back on (an Artifact link).
 * `returnTo` is client-supplied: only an app-local path survives
 * (sanitizeAppLocalReturnPath); anything else is dropped and the link lands on `/`.
 */
export function verificationEmailUrl(token: string, returnTo?: unknown): string {
  const params = new URLSearchParams({ verify: token });
  const path = sanitizeAppLocalReturnPath(returnTo);
  if (path !== "/") params.set("returnTo", path);
  return `${appUrl()}?${params.toString()}`;
}

export function renderVerificationEmailHtml(rawName: string, token: string, returnTo?: string): string {
  const rawUrl = verificationEmailUrl(token, returnTo);
  // The copy link lands in an attribute and in text: escaped for both (its `&`). emailButton escapes its own.
  const url = escapeHtmlText(rawUrl);
  // Display names are user-chosen and land in HTML text context below.
  const name = escapeHtmlText(rawName);
  return renderEmailLayout(`
    <h1 style="margin: 0 0 16px 0; color: ${SLOCK_INK}; font-size: 22px; font-weight: bold;">Verify your email</h1>
    <p style="margin: 0 0 8px 0; color: ${SLOCK_INK}; font-size: 16px; line-height: 1.5;">Hey ${name},</p>
    <p style="margin: 0; color: ${SLOCK_INK}; font-size: 16px; line-height: 1.5;">Click the button below to verify your email address:</p>
    ${renderEmailButton(rawUrl, "Verify Email")}
    <p class="slock-muted" style="margin: 0 0 4px 0; color: ${SLOCK_MUTED}; font-size: 13px; line-height: 1.5;">Or copy this link: <a class="slock-link" href="${url}" style="color: ${SLOCK_LINK}; word-break: break-all;">${url}</a></p>
    <p class="slock-muted" style="margin: 0 0 4px 0; color: ${SLOCK_MUTED}; font-size: 13px;">This link expires in 24 hours.</p>
    <p class="slock-muted" style="margin: 0; color: ${SLOCK_MUTED}; font-size: 13px; line-height: 1.5;">If you didn't create a ${BRAND_NAME} account, you can safely ignore this email.</p>
  `);
}

export async function sendVerificationEmail(to: string, name: string, token: string, returnTo?: string): Promise<void> {
  const html = renderVerificationEmailHtml(name, token, returnTo);
  await sendEmail(to, `Verify your email — ${BRAND_NAME}`, html);
}

export function renderPasswordResetEmailHtml(rawName: string, token: string): string {
  const url = `${appUrl()}?reset=${token}`;
  // Same as the verification template: user-chosen name in HTML text context.
  const name = escapeHtmlText(rawName);
  return renderEmailLayout(`
    <h1 style="margin: 0 0 16px 0; color: ${SLOCK_INK}; font-size: 22px; font-weight: bold;">Reset your password</h1>
    <p style="margin: 0 0 8px 0; color: ${SLOCK_INK}; font-size: 16px; line-height: 1.5;">Hey ${name},</p>
    <p style="margin: 0; color: ${SLOCK_INK}; font-size: 16px; line-height: 1.5;">Someone requested a password reset for your account. Click the button below to set a new password:</p>
    ${renderEmailButton(url, "Reset Password")}
    <p class="slock-muted" style="margin: 0 0 4px 0; color: ${SLOCK_MUTED}; font-size: 13px; line-height: 1.5;">Or copy this link: <a class="slock-link" href="${url}" style="color: ${SLOCK_LINK}; word-break: break-all;">${url}</a></p>
    <p class="slock-muted" style="margin: 0; color: ${SLOCK_MUTED}; font-size: 13px;">This link expires in 1 hour. If you didn't request this, you can safely ignore it.</p>
  `);
}

export async function sendPasswordResetEmail(to: string, name: string, token: string): Promise<void> {
  const html = renderPasswordResetEmailHtml(name, token);
  await sendEmail(to, `Reset your password — ${BRAND_NAME}`, html);
}

export type DeviceLoginEmailDetails = {
  requestedAt: Date;
  requester: { ip: string | null; location: string | null };
  /** What a device session acted on (part C notices): "Agent: …", "Server: …". */
  target?: { label: string; value: string };
};

export type DeviceLoginEmailEvent = "approved" | "agent_credential" | "computer_attach";

/** The page a revoke link opens (App.tsx `?revoke_device_login=`); it asks for a click, so mail scanners that open links revoke nothing. */
export function deviceLoginRevokeUrl(token: string): string {
  return `${appUrl()}?${new URLSearchParams({ revoke_device_login: token }).toString()}`;
}

const DEVICE_LOGIN_EMAIL_COPY: Record<DeviceLoginEmailEvent, { subject: string; heading: string; lead: string }> = {
  approved: {
    subject: `New device login to your ${BRAND_NAME} account`,
    heading: "You approved a device login",
    lead: "You just approved a device login for your account. The program that started it can now act for you in Raft Computer and the raft CLI.",
  },
  agent_credential: {
    subject: `A device login created an agent credential — ${BRAND_NAME}`,
    heading: "A device login created an agent credential",
    lead: "A program you let sign in with a device login just created a new credential for one of your agents.",
  },
  computer_attach: {
    subject: `A device login attached a computer — ${BRAND_NAME}`,
    heading: "A device login attached a computer",
    lead: "A program you let sign in with a device login just attached a computer to one of your servers.",
  },
};

export function renderDeviceLoginEmailHtml(
  rawName: string,
  event: DeviceLoginEmailEvent,
  details: DeviceLoginEmailDetails,
  revokeToken: string,
): string {
  const copy = DEVICE_LOGIN_EMAIL_COPY[event];
  const rawUrl = deviceLoginRevokeUrl(revokeToken);
  const url = escapeHtmlText(rawUrl);
  const name = escapeHtmlText(rawName);
  // No program name: the requester picks it, and mail clients turn
  // domain-like text into links, so a name like "confirm at evil.example"
  // would arrive as a link in a mail from Raft. The approval page showed it.
  const from = [details.requester.ip, details.requester.location].filter(Boolean).join(" · ");
  const row = (label: string, value: string) =>
    `<p style="margin: 0 0 4px 0; color: ${SLOCK_INK}; font-size: 16px; line-height: 1.5;"><strong>${label}:</strong> ${value}</p>`;
  return renderEmailLayout(`
    <h1 style="margin: 0 0 16px 0; color: ${SLOCK_INK}; font-size: 22px; font-weight: bold;">${copy.heading}</h1>
    <p style="margin: 0 0 8px 0; color: ${SLOCK_INK}; font-size: 16px; line-height: 1.5;">Hey ${name},</p>
    <p style="margin: 0 0 12px 0; color: ${SLOCK_INK}; font-size: 16px; line-height: 1.5;">${copy.lead}</p>
    ${details.target ? row(escapeHtmlText(details.target.label), escapeHtmlText(details.target.value)) : ""}
    ${row("Login started", escapeHtmlText(details.requestedAt.toUTCString()))}
    ${row("From", from ? escapeHtmlText(from) : "Can't be determined")}
    <p style="margin: 12px 0 0 0; color: ${SLOCK_INK}; font-size: 16px; line-height: 1.5;">If you didn't start this login yourself, or someone asked you to approve it, revoke it now: this signs that program out, and the agent credentials and computer connections it set up stop working.</p>
    ${renderEmailButton(rawUrl, "Revoke This Login")}
    <p style="margin: 0 0 12px 0; color: ${SLOCK_INK}; font-size: 16px; line-height: 1.5;">Then change or reset your password. That signs you out everywhere, and the computers and agent credentials any device login set up stop working too, so you'll log in on yours again. Also check your agents' credentials and your computers for any you don't recognise.</p>
    <p class="slock-muted" style="margin: 0 0 4px 0; color: ${SLOCK_MUTED}; font-size: 13px; line-height: 1.5;">Or copy this link: <a class="slock-link" href="${url}" style="color: ${SLOCK_LINK}; word-break: break-all;">${url}</a></p>
    <p class="slock-muted" style="margin: 0; color: ${SLOCK_MUTED}; font-size: 13px; line-height: 1.5;">The link works once and expires in 24 hours. If this was you, you don't need to do anything.</p>
  `);
}

export async function sendDeviceLoginEmail(
  to: string,
  name: string,
  event: DeviceLoginEmailEvent,
  details: DeviceLoginEmailDetails,
  revokeToken: string,
): Promise<void> {
  const html = renderDeviceLoginEmailHtml(name, event, details, revokeToken);
  await sendEmail(to, DEVICE_LOGIN_EMAIL_COPY[event].subject, html);
}

export type DeviceGrantEmailEvent = "computer_attach" | "agent_key";

export type DeviceGrantEmailDetails = {
  /** As the requesting machine named itself (sanitized). */
  machineName: string | null;
  serverName: string;
  serverSlug: string;
  /** agent_key: the agent the key is for. */
  agentName: string | null;
  requestedAt: Date;
  requester: { ip: string | null; location: string | null };
  /**
   * computer_attach: the raw `dvcr_*` token of that Computer's one-time revoke
   * link. Without one (it couldn't be issued) the email points at the
   * Computers page instead.
   */
  computerRevokeToken?: string | null;
};

/**
 * A requester-chosen name as mail may show it: escaped, with a zero-width
 * space after each `.`, `:`, `/` and `@`, so mail clients don't turn a name
 * like "confirm at evil.example" into a link in a mail from Raft.
 */
function requesterChosenMailText(raw: string): string {
  return escapeHtmlText(raw).replace(/([.:/@])/g, "$1\u200B");
}

/**
 * What a one-time device-login grant just did, to the person who approved it
 * (device-auth design v2 §3.1 step 6). An attach carries a one-time link that
 * revokes that Computer only (its key and its agents' keys); it opens the same
 * click-to-revoke page as a device login's revoke link.
 */
export function renderDeviceGrantEmailHtml(rawName: string, event: DeviceGrantEmailEvent, details: DeviceGrantEmailDetails): string {
  const name = escapeHtmlText(rawName);
  const serverName = escapeHtmlText(details.serverName);
  const machine = details.machineName ? requesterChosenMailText(details.machineName) : "a machine";
  const agent = details.agentName ? escapeHtmlText(details.agentName) : "an agent";
  const revokeToken = event === "computer_attach" ? details.computerRevokeToken ?? null : null;
  const rawUrl = revokeToken
    ? deviceLoginRevokeUrl(revokeToken)
    : event === "computer_attach"
      ? `${appUrl()}/s/${encodeURIComponent(details.serverSlug)}/computers`
      : `${appUrl()}/s/${encodeURIComponent(details.serverSlug)}`;
  const url = escapeHtmlText(rawUrl);
  const from = [details.requester.ip, details.requester.location].filter(Boolean).join(" · ");
  const row = (label: string, value: string) =>
    `<p style="margin: 0 0 4px 0; color: ${SLOCK_INK}; font-size: 16px; line-height: 1.5;"><strong>${label}:</strong> ${value}</p>`;
  const heading = event === "computer_attach"
    ? `You added ${machine} to ${serverName}`
    : `You gave ${agent} a key`;
  const lead = event === "computer_attach"
    ? `You approved a device login that added ${machine} to the server <strong>${serverName}</strong>. That machine now has its own key for this server only; it can't act for your account anywhere else.`
    : `You approved a device login that gave a program a key for the agent <strong>${agent}</strong> on <strong>${serverName}</strong>. The key acts as that agent only, not as you.`;
  const undo = revokeToken
    ? "If you didn't do this, or someone asked you to approve it, revoke this machine now: that revokes its key and its agents' keys, and disconnects it. Your other computers are not affected. Then change or reset your password."
    : event === "computer_attach"
      ? "If you didn't do this, or someone asked you to approve it, remove the machine from the server's Computers page now: that revokes its key and its agents' keys. Then change or reset your password."
      : "If you didn't do this, or someone asked you to approve it, revoke the key in the agent's credentials now. Then change or reset your password.";
  return renderEmailLayout(`
    <h1 style="margin: 0 0 16px 0; color: ${SLOCK_INK}; font-size: 22px; font-weight: bold;">${heading}</h1>
    <p style="margin: 0 0 8px 0; color: ${SLOCK_INK}; font-size: 16px; line-height: 1.5;">Hey ${name},</p>
    <p style="margin: 0 0 12px 0; color: ${SLOCK_INK}; font-size: 16px; line-height: 1.5;">${lead}</p>
    ${event === "computer_attach" ? row("Machine", machine) : row("Agent", agent)}
    ${row("Server", serverName)}
    ${row("Login started", escapeHtmlText(details.requestedAt.toUTCString()))}
    ${row("From", from ? escapeHtmlText(from) : "Can't be determined")}
    <p style="margin: 12px 0 0 0; color: ${SLOCK_INK}; font-size: 16px; line-height: 1.5;">${undo}</p>
    ${renderEmailButton(rawUrl, revokeToken ? "Revoke This Machine" : event === "computer_attach" ? "Open Computers" : "Open Server")}
    <p class="slock-muted" style="margin: 0 0 4px 0; color: ${SLOCK_MUTED}; font-size: 13px; line-height: 1.5;">Or copy this link: <a class="slock-link" href="${url}" style="color: ${SLOCK_LINK}; word-break: break-all;">${url}</a></p>
    <p class="slock-muted" style="margin: 0; color: ${SLOCK_MUTED}; font-size: 13px; line-height: 1.5;">${revokeToken ? "The link works once and expires in 24 hours. " : ""}If this was you, you don't need to do anything.</p>
  `);
}

export async function sendDeviceGrantEmail(
  to: string,
  name: string,
  event: DeviceGrantEmailEvent,
  details: DeviceGrantEmailDetails,
): Promise<void> {
  const subject = event === "computer_attach"
    ? `You added a machine to ${details.serverName} — ${BRAND_NAME}`
    : `You gave an agent a key — ${BRAND_NAME}`;
  await sendEmail(to, subject, renderDeviceGrantEmailHtml(name, event, details));
}

/**
 * The cascade triggers that mail a security-revoke notice: every
 * ApproverSessionRevokeTrigger but `account_deletion_requested`, whose own
 * email (sendAccountDeletionEmail) already says what was turned off.
 */
export type SecurityRevokeEmailTrigger = "password_change" | "password_reset" | "account_retired" | "second_factor_recovered" | "device_login_revoked" | "repair";

export type SecurityRevokeEmailServer = { name: string; slug: string };

export type SecurityRevokeEmailDetails = {
  trigger: SecurityRevokeEmailTrigger;
  /** Computers disconnected: Computer keys revoked and legacy machine keys discarded. */
  computers: number;
  /** Agent keys revoked. */
  keys: number;
  /** The servers they were on, each linked to its Computers page. */
  servers: SecurityRevokeEmailServer[];
};

const SECURITY_REVOKE_LEAD: Record<SecurityRevokeEmailTrigger, string> = {
  password_change: "Your password was just changed, so your other sign-ins were signed out, and what they had set up was turned off. What you set up from the sign-in you changed it from keeps working.",
  password_reset: "Your password was just reset, so every sign-in was signed out, and what they had set up was turned off.",
  account_retired: "Your account was closed, so what its sign-ins had set up was turned off.",
  second_factor_recovered: "Two-step verification on your account was just reset, so every other sign-in was signed out, and what they had set up was turned off.",
  device_login_revoked: "You revoked a device login, so what it had set up was turned off.",
  repair: "After a recent password change or reset, a two-step verification reset, or a revoked device login, what your signed-out sessions had set up was turned off.",
};

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** The Computers page of a server: where its machines are managed (there is no page for all of a person's machines and keys yet). */
function serverComputersUrl(slug: string): string {
  return `${appUrl()}/s/${encodeURIComponent(slug)}/computers`;
}

export function securityRevokeEmailSubject(details: SecurityRevokeEmailDetails): string {
  const parts = [
    details.computers > 0 ? plural(details.computers, "computer disconnected", "computers disconnected") : null,
    details.keys > 0 ? plural(details.keys, "agent key revoked", "agent keys revoked") : null,
  ].filter(Boolean);
  return `${parts.join(", ")} — ${BRAND_NAME}`;
}

/** One email for one cascade (securityRevokeNotice.ts): counts, never one row per machine. */
export function renderSecurityRevokeEmail(rawName: string, details: SecurityRevokeEmailDetails): { html: string; text: string } {
  const name = escapeHtmlText(rawName);
  const rawUrl = details.servers.length > 0 ? serverComputersUrl(details.servers[0]!.slug) : appUrl();
  const url = escapeHtmlText(rawUrl);
  const counts = [
    details.computers > 0 ? plural(details.computers, "computer was disconnected", "computers were disconnected") : null,
    details.keys > 0 ? plural(details.keys, "agent key was revoked", "agent keys were revoked") : null,
  ].filter((line): line is string => Boolean(line));
  const again = "If you set these up yourself, set them up again: attach the computer again with raft-computer login, and create a new key from the agent's credentials. If you didn't, there is nothing more to do: they no longer work.";
  const paragraph = (inner: string, margin = "0 0 12px 0") =>
    `<p style="margin: ${margin}; color: ${SLOCK_INK}; font-size: 16px; line-height: 1.5;">${inner}</p>`;
  const serverLinks = details.servers.map((server) => {
    const link = escapeHtmlText(serverComputersUrl(server.slug));
    return `<li style="margin: 0 0 4px 0;"><a class="slock-link" href="${link}" style="color: ${SLOCK_LINK};">${escapeHtmlText(server.name)}</a></li>`;
  }).join("");
  const html = renderEmailLayout(`
    <h1 style="margin: 0 0 16px 0; color: ${SLOCK_INK}; font-size: 22px; font-weight: bold;">Computers and keys were turned off</h1>
    ${paragraph(`Hey ${name},`, "0 0 8px 0")}
    ${paragraph(escapeHtmlText(SECURITY_REVOKE_LEAD[details.trigger]))}
    <ul style="margin: 0 0 12px 0; padding-left: 20px; color: ${SLOCK_INK}; font-size: 16px; line-height: 1.5;">${counts.map((line) => `<li>${escapeHtmlText(line)}</li>`).join("")}</ul>
    ${details.servers.length > 0 ? `${paragraph("On these servers' Computers pages:", "0 0 4px 0")}<ul style="margin: 0 0 12px 0; padding-left: 20px; font-size: 16px; line-height: 1.5;">${serverLinks}</ul>` : ""}
    ${paragraph(escapeHtmlText(again))}
    ${renderEmailButton(rawUrl, "Open Computers")}
    <p class="slock-muted" style="margin: 0; color: ${SLOCK_MUTED}; font-size: 13px; line-height: 1.5;">Or copy this link: <a class="slock-link" href="${url}" style="color: ${SLOCK_LINK}; word-break: break-all;">${url}</a></p>
  `);
  const text = [
    `Hey ${rawName},`,
    "",
    SECURITY_REVOKE_LEAD[details.trigger],
    "",
    ...counts.map((line) => `- ${line}`),
    "",
    ...(details.servers.length > 0
      ? ["On these servers' Computers pages:", ...details.servers.map((server) => `- ${server.name}: ${serverComputersUrl(server.slug)}`), ""]
      : []),
    again,
    "",
    `Open Computers: ${rawUrl}`,
  ].join("\n");
  return { html, text };
}

export async function sendSecurityRevokeEmail(to: string, name: string, details: SecurityRevokeEmailDetails): Promise<void> {
  const { html, text } = renderSecurityRevokeEmail(name, details);
  await sendEmail(to, securityRevokeEmailSubject(details), html, { text });
}

/** A change to the person's two-step verification (design §5: every factor change is mailed). */
export type SecondFactorChangeEmailEvent =
  | "totp_added"
  | "enabled"
  | "disabled"
  | "backup_codes_regenerated"
  | "passkey_added"
  | "passkey_removed"
  | "passkey_counter_regressed";

const SECOND_FACTOR_CHANGE_EMAIL_COPY: Record<SecondFactorChangeEmailEvent, { subject: string; heading: string; lead: string }> = {
  totp_added: {
    subject: `An authenticator app was added to your ${BRAND_NAME} account`,
    heading: "An authenticator app was added",
    lead: "An authenticator app was just set up for two-step verification on your account.",
  },
  enabled: {
    subject: `Two-step verification is on — ${BRAND_NAME}`,
    heading: "Two-step verification is on",
    lead: "Two-step verification was just turned on for your account. Your other web sign-ins were signed out; your computers stay connected.",
  },
  disabled: {
    subject: `Two-step verification was turned off — ${BRAND_NAME}`,
    heading: "Two-step verification was turned off",
    lead: "Two-step verification was just turned off for your account. Its authenticator app and backup codes were removed.",
  },
  backup_codes_regenerated: {
    subject: `New backup codes for your ${BRAND_NAME} account`,
    heading: "New backup codes were created",
    lead: "A new set of backup codes was just created for your account. The earlier codes no longer work.",
  },
  passkey_added: {
    subject: `A passkey was added to your ${BRAND_NAME} account`,
    heading: "A passkey was added",
    lead: "A passkey was just added to your account.",
  },
  passkey_removed: {
    subject: `A passkey was removed from your ${BRAND_NAME} account`,
    heading: "A passkey was removed",
    lead: "A passkey was just removed from your account. It can no longer be used to verify it's you.",
  },
  passkey_counter_regressed: {
    subject: `Check the passkeys on your ${BRAND_NAME} account`,
    heading: "One of your passkeys looked unusual",
    lead: "One of your passkeys was just used, but its security counter did not go up as expected. This can mean the passkey was copied. The sign-in was allowed; if you don't recognise it, remove that passkey.",
  },
};

export function renderSecondFactorChangeEmail(rawName: string, event: SecondFactorChangeEmailEvent): { html: string; text: string } {
  const copy = SECOND_FACTOR_CHANGE_EMAIL_COPY[event];
  const name = escapeHtmlText(rawName);
  const advice = "If this wasn't you, change your password now: that signs you out everywhere.";
  const paragraph = (inner: string, margin = "0 0 12px 0") =>
    `<p style="margin: ${margin}; color: ${SLOCK_INK}; font-size: 16px; line-height: 1.5;">${inner}</p>`;
  const html = renderEmailLayout(`
    <h1 style="margin: 0 0 16px 0; color: ${SLOCK_INK}; font-size: 22px; font-weight: bold;">${copy.heading}</h1>
    ${paragraph(`Hey ${name},`, "0 0 8px 0")}
    ${paragraph(escapeHtmlText(copy.lead))}
    ${paragraph(escapeHtmlText(advice), "0")}
  `);
  const text = [`Hey ${rawName},`, "", copy.lead, "", advice].join("\n");
  return { html, text };
}

export async function sendSecondFactorChangeEmail(to: string, name: string, event: SecondFactorChangeEmailEvent): Promise<void> {
  const { html, text } = renderSecondFactorChangeEmail(name, event);
  await sendEmail(to, SECOND_FACTOR_CHANGE_EMAIL_COPY[event].subject, html, { text });
}

/** Where a backup code answered a second step (secondFactor/backupCodes.ts BackupCodeUseContext). */
export type SecondFactorBackupCodeUsedEmailContext = "sign_in" | "step_up" | "totp_setup" | "disable";

/** At or below this many codes left, the email asks for a new set. */
export const BACKUP_CODES_LOW = 2;

export function renderSecondFactorBackupCodeUsedEmail(
  rawName: string,
  input: { context: SecondFactorBackupCodeUsedEmailContext; remaining: number },
): { subject: string; html: string; text: string } {
  const subject = `A backup code was used on your ${BRAND_NAME} account`;
  const lead = input.context === "sign_in"
    ? "A backup code was just used to sign in to your account."
    : "A backup code was just used to confirm it's you on your account.";
  const left = input.context === "disable"
    ? "Two-step verification was turned off with it, so your other backup codes were removed."
    : input.remaining === 0
      ? "You have no backup codes left. Create a new set in Settings so you can still sign in if you lose your authenticator app or passkey."
      : `You have ${input.remaining} backup ${input.remaining === 1 ? "code" : "codes"} left.${input.remaining <= BACKUP_CODES_LOW ? " Create a new set in Settings soon." : ""}`;
  const advice = input.context === "disable"
    ? "If this wasn't you, change your password now (that signs you out everywhere), then turn two-step verification back on."
    : "If this wasn't you, change your password now (that signs you out everywhere) and create new backup codes, which stops the old ones from working.";
  const name = escapeHtmlText(rawName);
  const paragraph = (inner: string, margin = "0 0 12px 0") =>
    `<p style="margin: ${margin}; color: ${SLOCK_INK}; font-size: 16px; line-height: 1.5;">${inner}</p>`;
  const html = renderEmailLayout(`
    <h1 style="margin: 0 0 16px 0; color: ${SLOCK_INK}; font-size: 22px; font-weight: bold;">A backup code was used</h1>
    ${paragraph(`Hey ${name},`, "0 0 8px 0")}
    ${paragraph(escapeHtmlText(lead))}
    ${paragraph(escapeHtmlText(left))}
    ${paragraph(escapeHtmlText(advice), "0")}
  `);
  const text = [`Hey ${rawName},`, "", lead, "", left, "", advice].join("\n");
  return { subject, html, text };
}

export async function sendSecondFactorBackupCodeUsedEmail(
  to: string,
  name: string,
  input: { context: SecondFactorBackupCodeUsedEmailContext; remaining: number },
): Promise<void> {
  const { subject, html, text } = renderSecondFactorBackupCodeUsedEmail(name, input);
  await sendEmail(to, subject, html, { text });
}

// ── Account deletion (services/accountDeletion) ──

/** The day an account deletion takes effect, as the emails print it (UTC). */
export function formatAccountDeletionDate(at: Date): string {
  return `${at.toLocaleDateString("en-US", { timeZone: "UTC", year: "numeric", month: "long", day: "numeric" })} (UTC)`;
}

/** The page the "requested" email's cancel link opens (`?cancel_account_deletion=`); it asks for a click, so mail scanners cancel nothing. */
export function accountDeletionCancelUrl(token: string): string {
  return `${appUrl()}/?${new URLSearchParams({ cancel_account_deletion: token }).toString()}`;
}

export type AccountDeletionEmailEvent =
  /** `cancelToken`: the raw one-time token of the link that cancels this request without signing in (services/accountDeletion/requests.ts). */
  | { kind: "requested"; scheduledFor: Date; paidServersEnding?: { name: string; periodEnd: Date | null }[]; subscriptionCancellationUnconfirmed?: boolean; cancelToken?: string }
  | { kind: "cancelled"; subscriptionsToTurnBackOn?: string[]; subscriptionNotResumed?: boolean; subscriptionRestorationUnknown?: boolean; anotherDeletionPending?: boolean }
  | { kind: "email_code"; code: string; expiresInMinutes: number }
  | { kind: "deleted" };

function accountDeletionEmailCopy(event: AccountDeletionEmailEvent): { subject: string; heading: string; lines: string[]; advice: string } {
  switch (event.kind) {
    case "requested":
      return {
        subject: `Your ${BRAND_NAME} account will be deleted on ${formatAccountDeletionDate(event.scheduledFor)}`,
        heading: "Your account is scheduled for deletion",
        lines: [
          `Someone signed in to your account asked to delete it. It will be deleted on ${formatAccountDeletionDate(event.scheduledFor)}.`,
          "Until then, you can sign in and cancel the deletion. Every sign-in was signed out, your computers were disconnected, your agent keys were revoked, and your agents were stopped.",
          ...(event.subscriptionCancellationUnconfirmed
            ? ["We could not confirm cancellation of subscription renewal. To check your subscription, cancel account deletion first, then open Plan & Billing."] : []),
          ...(event.paidServersEnding ?? []).map((server) => event.subscriptionCancellationUnconfirmed
            ? `You pay for ${server.name}: check this subscription in Plan & Billing after cancelling account deletion.`
            : `You pay for ${server.name}: its subscription was scheduled to end with the current period. Its new owner can subscribe again.`),
        ],
        advice: "If this wasn't you, sign in now and cancel the deletion, then change your password.",
      };
    case "cancelled":
      return {
        subject: event.anotherDeletionPending ? "An earlier account deletion request was cancelled" : `Your ${BRAND_NAME} account will not be deleted`,
        heading: "Account deletion cancelled",
        lines: [
          event.anotherDeletionPending
            ? "An earlier deletion request was cancelled. A newer deletion request is still scheduled: sign in to review it."
            : "The deletion of your account was just cancelled. Your account works as before.",
          "Your agents stay stopped and your computers stay disconnected: start the agents again and attach the computers again with raft-computer login when you need them.",
          ...(event.subscriptionRestorationUnknown
            ? ["We could not confirm your subscription's renewal status. Check Plan & Billing before making another subscription change."] : []),
          ...((event.subscriptionsToTurnBackOn ?? []).length > 0
            ? [`The subscription of ${event.subscriptionsToTurnBackOn!.join(", ")} was not automatically restored. Go to that server's Plan & Billing to subscribe again.`]
            : event.subscriptionNotResumed ? ["A subscription was not automatically restored. Go to Plan & Billing to subscribe again."] : []),
        ],
        advice: "If this wasn't you, change your password now: that signs you out everywhere.",
      };
    case "deleted":
      return {
        subject: `Your ${BRAND_NAME} account has been deleted`,
        heading: "Your account has been deleted",
        lines: [
          `Your ${BRAND_NAME} account was deleted, as was asked when the deletion was scheduled. Your profile, sign-in methods and personal settings are gone, and this email address is free to use for a new account.`,
          "Messages you sent stay in their conversations, shown as from \"Deleted user\".",
        ],
        advice: "This is the last email about this account.",
      };
    case "email_code":
      return {
        subject: `Someone asked to delete your ${BRAND_NAME} account`,
        heading: "Someone asked to delete your account",
        lines: [
          "Someone signed in to your account asked to delete it. To confirm the deletion, enter this code:",
          event.code,
          `The code works once and expires in ${event.expiresInMinutes} minutes.`,
        ],
        advice: "If this wasn't you, don't share this code with anyone: without it the account will not be deleted.",
      };
  }
}

export function renderAccountDeletionEmail(rawName: string, event: AccountDeletionEmailEvent): { subject: string; html: string; text: string } {
  const copy = accountDeletionEmailCopy(event);
  const name = escapeHtmlText(rawName);
  const url = appUrl();
  const cancelUrl = event.kind === "requested" && event.cancelToken ? accountDeletionCancelUrl(event.cancelToken) : null;
  const paragraph = (inner: string, margin = "0 0 12px 0") =>
    `<p style="margin: ${margin}; color: ${SLOCK_INK}; font-size: 16px; line-height: 1.5;">${inner}</p>`;
  const body = copy.lines.map((line) => event.kind === "email_code" && line === event.code
    ? `<p style="margin: 0 0 12px 0; color: ${SLOCK_INK}; font-size: 28px; font-weight: bold; letter-spacing: 4px;">${escapeHtmlText(line)}</p>`
    : paragraph(escapeHtmlText(line))).join("");
  const html = renderEmailLayout(`
    <h1 style="margin: 0 0 16px 0; color: ${SLOCK_INK}; font-size: 22px; font-weight: bold;">${copy.heading}</h1>
    ${paragraph(`Hey ${name},`, "0 0 8px 0")}
    ${body}
    ${event.kind === "requested" ? renderEmailButton(url, "Sign in to cancel") : ""}
    ${cancelUrl ? paragraph(`Changed your mind? <a class="slock-link" href="${escapeHtmlText(cancelUrl)}" style="color: ${SLOCK_LINK};">Cancel the deletion</a> without signing in. The link works once.`) : ""}
    ${paragraph(escapeHtmlText(copy.advice), "0")}
  `);
  const text = [
    `Hey ${rawName},`,
    "",
    ...copy.lines.flatMap((line) => [line, ""]),
    ...(event.kind === "requested" ? [`Sign in to cancel: ${url}`, ""] : []),
    ...(cancelUrl ? [`Changed your mind? Cancel the deletion without signing in (the link works once): ${cancelUrl}`, ""] : []),
    copy.advice,
  ].join("\n");
  return { subject: copy.subject, html, text };
}

export async function sendAccountDeletionEmail(to: string, name: string, event: AccountDeletionEmailEvent): Promise<void> {
  const { subject, html, text } = renderAccountDeletionEmail(name, event);
  await sendEmail(to, subject, html, { text });
}

// ── Two-step verification recovery (services/secondFactor/recovery.ts) ──

/** The page the confirm link opens (`?second_factor_recovery=`); it asks for a click, so mail scanners confirm nothing. */
export function secondFactorRecoveryConfirmUrl(token: string): string {
  return `${appUrl()}?${new URLSearchParams({ second_factor_recovery: token }).toString()}`;
}

/** The page the cancel link opens (`?cancel_second_factor_recovery=`); it asks for a click too. */
export function secondFactorRecoveryCancelUrl(token: string): string {
  return `${appUrl()}?${new URLSearchParams({ cancel_second_factor_recovery: token }).toString()}`;
}

export type SecondFactorRecoveryEmailEvent =
  | { kind: "link"; token: string; expiresInMinutes: number }
  | { kind: "started"; eligibleAt: Date; cancelToken: string; firstFactorRequired: "set_password" | null }
  | { kind: "ready"; finishBy: Date; firstFactorRequired: "set_password" | null }
  | { kind: "cancelled"; by: "user" | "token" | "auto_factor" }
  | { kind: "completed" };

/** A recovery email's time, as printed (UTC, to the minute). */
export function formatSecondFactorRecoveryTime(at: Date): string {
  return `${at.toLocaleString("en-US", { timeZone: "UTC", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" })} (UTC)`;
}

const SET_PASSWORD_FIRST = "Your account has no password and no connected sign-in method, so first set a password with \"Forgot password\" on the sign-in page, then sign in with it.";

function secondFactorRecoveryEmailCopy(event: SecondFactorRecoveryEmailEvent): {
  subject: string;
  heading: string;
  lines: string[];
  button: { url: string; label: string } | null;
  advice: string;
} {
  switch (event.kind) {
    case "link":
      return {
        subject: `Reset two-step verification on your ${BRAND_NAME} account?`,
        heading: "Reset two-step verification?",
        lines: [
          "Someone asked to reset two-step verification on your account because they can't use their authenticator app, passkeys or backup codes.",
          `To start, open this link. It works once and expires in ${event.expiresInMinutes} minutes. The reset then waits 72 hours before it can be finished, and every signed-in device is told about it.`,
        ],
        button: { url: secondFactorRecoveryConfirmUrl(event.token), label: "Start the reset" },
        advice: "If this wasn't you, ignore this email: nothing changes without the link.",
      };
    case "started":
      return {
        subject: `Someone asked to reset two-step verification on your ${BRAND_NAME} account`,
        heading: "Two-step verification reset requested",
        lines: [
          "Someone asked to reset two-step verification on your account. If nobody cancels it, it can be finished after "
            + `${formatSecondFactorRecoveryTime(event.eligibleAt)} by signing in with your password or a connected sign-in method; that removes your authenticator app, passkeys and backup codes and signs out every other sign-in.`,
          ...(event.firstFactorRequired === "set_password" ? [SET_PASSWORD_FIRST] : []),
          "Using your authenticator app, a passkey or a backup code anywhere before then cancels it, and so does the button below.",
        ],
        button: { url: secondFactorRecoveryCancelUrl(event.cancelToken), label: "Cancel the reset" },
        advice: "If this wasn't you, cancel it now and change your password.",
      };
    case "ready":
      return {
        subject: `You can finish resetting two-step verification — ${BRAND_NAME}`,
        heading: "The reset can be finished",
        lines: [
          `The 72-hour wait is over. Sign in with your password or a connected sign-in method and choose to reset two-step verification at the second step. This works until ${formatSecondFactorRecoveryTime(event.finishBy)}.`,
          ...(event.firstFactorRequired === "set_password" ? [SET_PASSWORD_FIRST] : []),
        ],
        button: { url: appUrl(), label: "Sign in" },
        advice: "If this wasn't you, cancel it now with the link in the first email about this reset, or sign in and cancel it, then change your password.",
      };
    case "cancelled":
      return {
        subject: `The two-step verification reset was cancelled — ${BRAND_NAME}`,
        heading: "Reset cancelled",
        lines: [
          event.by === "auto_factor"
            ? "Your authenticator app, a passkey or a backup code was just used on your account, so the request to reset two-step verification was cancelled."
            : "The request to reset two-step verification on your account was just cancelled. Two-step verification stays on, as it was.",
        ],
        button: null,
        advice: "If someone else asked for the reset, change your password now: that signs you out everywhere.",
      };
    case "completed":
      return {
        subject: `Two-step verification was reset — ${BRAND_NAME}`,
        heading: "Two-step verification was reset",
        lines: [
          "The reset of two-step verification on your account was just finished. Your authenticator app, passkeys and backup codes were removed, two-step verification is off, and every other sign-in was signed out.",
          "Turn two-step verification on again in your account settings.",
        ],
        button: null,
        advice: "If this wasn't you, reset your password now and contact support.",
      };
  }
}

export function renderSecondFactorRecoveryEmail(rawName: string, event: SecondFactorRecoveryEmailEvent): { subject: string; html: string; text: string } {
  const copy = secondFactorRecoveryEmailCopy(event);
  const name = escapeHtmlText(rawName);
  const paragraph = (inner: string, margin = "0 0 12px 0") =>
    `<p style="margin: ${margin}; color: ${SLOCK_INK}; font-size: 16px; line-height: 1.5;">${inner}</p>`;
  const link = copy.button ? escapeHtmlText(copy.button.url) : null;
  const html = renderEmailLayout(`
    <h1 style="margin: 0 0 16px 0; color: ${SLOCK_INK}; font-size: 22px; font-weight: bold;">${copy.heading}</h1>
    ${paragraph(`Hey ${name},`, "0 0 8px 0")}
    ${copy.lines.map((line) => paragraph(escapeHtmlText(line))).join("")}
    ${copy.button ? renderEmailButton(copy.button.url, copy.button.label) : ""}
    ${link ? `<p class="slock-muted" style="margin: 0 0 12px 0; color: ${SLOCK_MUTED}; font-size: 13px; line-height: 1.5;">Or copy this link: <a class="slock-link" href="${link}" style="color: ${SLOCK_LINK}; word-break: break-all;">${link}</a></p>` : ""}
    ${paragraph(escapeHtmlText(copy.advice), "0")}
  `);
  const text = [
    `Hey ${rawName},`,
    "",
    ...copy.lines.flatMap((line) => [line, ""]),
    ...(copy.button ? [`${copy.button.label}: ${copy.button.url}`, ""] : []),
    copy.advice,
  ].join("\n");
  return { subject: copy.subject, html, text };
}

export async function sendSecondFactorRecoveryEmail(to: string, name: string, event: SecondFactorRecoveryEmailEvent): Promise<void> {
  const { subject, html, text } = renderSecondFactorRecoveryEmail(name, event);
  await sendEmail(to, subject, html, { text });
}

/**
 * A server's owner deleted their account and the cleanup made this person
 * its owner (services/accountDeletion/cleanup.ts): the earliest-joined admin,
 * else the earliest-joined member.
 */
export function renderServerOwnershipHandedOverEmail(rawName: string, server: { name: string; slug: string }): { subject: string; html: string; text: string } {
  const name = escapeHtmlText(rawName);
  const serverName = escapeHtmlText(server.name);
  const url = `${appUrl()}/s/${encodeURIComponent(server.slug)}/`;
  const subject = `You are now the owner of ${server.name} on ${BRAND_NAME}`;
  const lines = [
    `The owner of ${server.name} deleted their ${BRAND_NAME} account. You were its longest-standing admin (or, with no admin, its longest-standing member), so you are now its owner.`,
    "As owner you manage its members, billing and settings. You can make someone else owner from the server's member settings.",
  ];
  const paragraph = (inner: string) => `<p style="margin: 0 0 12px 0; color: ${SLOCK_INK}; font-size: 16px; line-height: 1.5;">${inner}</p>`;
  const html = renderEmailLayout(`
    <h1 style="margin: 0 0 16px 0; color: ${SLOCK_INK}; font-size: 22px; font-weight: bold;">You are now the owner of ${serverName}</h1>
    ${paragraph(`Hey ${name},`)}
    ${lines.map((line) => paragraph(escapeHtmlText(line))).join("")}
    ${renderEmailButton(url, "Open the server")}
  `);
  const text = [`Hey ${rawName},`, "", ...lines.flatMap((line) => [line, ""]), `Open the server: ${url}`].join("\n");
  return { subject, html, text };
}

export async function sendServerOwnershipHandedOverEmail(to: string, name: string, server: { name: string; slug: string }): Promise<void> {
  const { subject, html, text } = renderServerOwnershipHandedOverEmail(name, server);
  await sendEmail(to, subject, html, { text });
}

/**
 * A server owner or admin moved an old Raft daemon another member had added
 * over to a Computer (services/computerAdoptionService.ts,
 * `computer.legacy_adopted_by_other`): told once to that member, if they are
 * still in the server.
 */
export function renderLegacyMachineMovedEmail(rawName: string, input: { machineName: string; movedByName: string; server: { name: string; slug: string } }): { subject: string; html: string; text: string } {
  const subject = `${input.movedByName} moved your machine ${input.machineName} to a ${BRAND_NAME} Computer`;
  const lines = [
    `${input.movedByName} moved ${input.machineName}, a machine you added to ${input.server.name}, over to a ${BRAND_NAME} Computer. Its old daemon key no longer works.`,
    `If you did not expect this, ask an admin of ${input.server.name}.`,
  ];
  const url = `${appUrl()}/s/${encodeURIComponent(input.server.slug)}/computers`;
  const paragraph = (inner: string) => `<p style="margin: 0 0 12px 0; color: ${SLOCK_INK}; font-size: 16px; line-height: 1.5;">${inner}</p>`;
  const html = renderEmailLayout(`
    <h1 style="margin: 0 0 16px 0; color: ${SLOCK_INK}; font-size: 22px; font-weight: bold;">${escapeHtmlText(subject)}</h1>
    ${paragraph(`Hey ${escapeHtmlText(rawName)},`)}
    ${lines.map((line) => paragraph(escapeHtmlText(line))).join("")}
    ${renderEmailButton(url, "Open Computers")}
  `);
  const text = [`Hey ${rawName},`, "", ...lines.flatMap((line) => [line, ""]), `Open Computers: ${url}`].join("\n");
  return { subject, html, text };
}

/**
 * A server owner or admin set up, again, a Computer this person had attached
 * (POST /api/computer/adopt-legacy resuming it): its key was replaced, so the
 * copy this person connected no longer works. Told once per replacement.
 */
export function renderComputerKeyReplacedByOtherEmail(rawName: string, input: { computerName: string; replacedByName: string; server: { name: string; slug: string } }): { subject: string; html: string; text: string } {
  const subject = `${input.replacedByName} replaced the key of your Computer ${input.computerName}`;
  const lines = [
    `${input.replacedByName} set up ${input.computerName} again on ${input.server.name}. It is a Computer you connected; its key was replaced, so it no longer connects with the key you set it up with.`,
    `If you did not expect this, ask an admin of ${input.server.name}.`,
  ];
  const url = `${appUrl()}/s/${encodeURIComponent(input.server.slug)}/computers`;
  const paragraph = (inner: string) => `<p style="margin: 0 0 12px 0; color: ${SLOCK_INK}; font-size: 16px; line-height: 1.5;">${inner}</p>`;
  const html = renderEmailLayout(`
    <h1 style="margin: 0 0 16px 0; color: ${SLOCK_INK}; font-size: 22px; font-weight: bold;">${escapeHtmlText(subject)}</h1>
    ${paragraph(`Hey ${escapeHtmlText(rawName)},`)}
    ${lines.map((line) => paragraph(escapeHtmlText(line))).join("")}
    ${renderEmailButton(url, "Open Computers")}
  `);
  const text = [`Hey ${rawName},`, "", ...lines.flatMap((line) => [line, ""]), `Open Computers: ${url}`].join("\n");
  return { subject, html, text };
}

export async function sendComputerKeyReplacedByOtherEmail(to: string, name: string, input: { computerName: string; replacedByName: string; server: { name: string; slug: string } }): Promise<void> {
  const { subject, html, text } = renderComputerKeyReplacedByOtherEmail(name, input);
  await sendEmail(to, subject, html, { text });
}

export async function sendLegacyMachineMovedEmail(to: string, name: string, input: { machineName: string; movedByName: string; server: { name: string; slug: string } }): Promise<void> {
  const { subject, html, text } = renderLegacyMachineMovedEmail(name, input);
  await sendEmail(to, subject, html, { text });
}

/** A payer deleted their account. Cached cancellation state is not a current
 * provider confirmation: ask the owner to check billing before changing it. */
export function renderSubscriptionEndingAfterDeletionEmail(rawName: string, input: { deletedName: string; server: { name: string; slug: string } }): { subject: string; html: string; text: string } {
  const subject = `Check the subscription for ${input.server.name}`;
  const lines = [
    `${input.deletedName} paid for ${input.server.name} and deleted their ${BRAND_NAME} account.`,
    "Check this subscription's current status in Plan & Billing before making changes.",
  ];
  const url = `${appUrl()}/s/${encodeURIComponent(input.server.slug)}/settings/billing`;
  const paragraph = (inner: string) => `<p style="margin: 0 0 12px 0; color: ${SLOCK_INK}; font-size: 16px; line-height: 1.5;">${inner}</p>`;
  const html = renderEmailLayout(`
    <h1 style="margin: 0 0 16px 0; color: ${SLOCK_INK}; font-size: 22px; font-weight: bold;">${escapeHtmlText(subject)}</h1>
    ${paragraph(`Hey ${escapeHtmlText(rawName)},`)}
    ${lines.map((line) => paragraph(escapeHtmlText(line))).join("")}
    ${renderEmailButton(url, "Open Plan & Billing")}
  `);
  const text = [`Hey ${rawName},`, "", ...lines.flatMap((line) => [line, ""]), `Open Plan & Billing: ${url}`].join("\n");
  return { subject, html, text };
}

export async function sendSubscriptionEndingAfterDeletionEmail(to: string, name: string, input: { deletedName: string; server: { name: string; slug: string } }): Promise<void> {
  const { subject, html, text } = renderSubscriptionEndingAfterDeletionEmail(name, input);
  await sendEmail(to, subject, html, { text });
}

/** Mirrors the `prepaid_pro_reminders.kind` enum (schema.ts); inserting a kind there checks they agree. */
export type PrepaidProReminderKind = "ends_in_7_days" | "ends_in_1_day" | "ended";
export type PrepaidProReminderEmail = {
  kind: PrepaidProReminderKind;
  server: { name: string; slug: string };
  /** End of the paid time; `ended` also says when the grace days run out (by date: it may go out any time in them). */
  endsAt: Date;
  graceEndsAt: Date;
  /** The owner's display language: Chinese gets Chinese, anything else English. */
  locale?: string | null;
};

type PrepaidReminderCopy = { subject: string; heading: string; greeting: string; lines: string[]; button: string };

function prepaidReminderCopy(rawName: string, input: PrepaidProReminderEmail): PrepaidReminderCopy {
  const locale = normalizeDisplayLocale(input.locale);
  const server = input.server.name;
  if (locale === "zh-cn" || locale === "zh-tw") {
    const tw = locale === "zh-tw";
    const date = (at: Date) => `${at.toLocaleDateString(tw ? "zh-TW" : "zh-CN", { timeZone: "UTC", year: "numeric", month: "long", day: "numeric" })}（UTC）`;
    const settings = tw ? "在伺服器的方案與帳單頁續費" : "在服务器的套餐与账单页续费";
    const subject = input.kind === "ended"
      ? `${server} 的 Pro 已到期`
      : input.kind === "ends_in_1_day"
        ? (tw ? `${server} 的 Pro 將在一天內到期` : `${server} 的 Pro 将在一天内到期`)
        : (tw ? `${server} 的 Pro 將於 ${date(input.endsAt)}到期` : `${server} 的 Pro 将于 ${date(input.endsAt)}到期`);
    const lines = input.kind === "ended"
      ? [tw
        ? `${server} 的預付 Pro 已於 ${date(input.endsAt)}到期，可以繼續用到 ${date(input.graceEndsAt)}；之後伺服器會降回免費版。`
        : `${server} 的预付 Pro 已于 ${date(input.endsAt)}到期，可以继续用到 ${date(input.graceEndsAt)}；之后服务器会降回免费版。`,
      tw ? `${settings}，即可繼續使用 Pro。` : `${settings}，即可继续使用 Pro。`]
      : [tw
        ? `${server} 的 Pro 是用支付寶一次性付款的，不會自動續費，將於 ${date(input.endsAt)}到期。`
        : `${server} 的 Pro 是用支付宝一次性付款的，不会自动续费，将于 ${date(input.endsAt)}到期。`,
      tw ? `${settings}，就能不間斷地使用 Pro；新的時長從目前的到期日開始算。` : `${settings}，就能不间断地使用 Pro；新的时长从当前的到期日开始算。`];
    return { subject, heading: subject, greeting: `${rawName}，你好：`, lines, button: tw ? "續費 Pro" : "续费 Pro" };
  }
  const date = (at: Date) => formatAccountDeletionDate(at);
  const subject = input.kind === "ended"
    ? `Pro for ${server} has ended`
    : input.kind === "ends_in_1_day" ? `Pro for ${server} ends within a day` : `Pro for ${server} ends on ${date(input.endsAt)}`;
  const lines = input.kind === "ended"
    ? [`Prepaid Pro for ${server} ended on ${date(input.endsAt)}. It stays on until ${date(input.graceEndsAt)}; after that the server moves to Free.`,
      "Renew from the server's billing settings to keep Pro."]
    : [`Pro for ${server} was paid once with Alipay and doesn't renew on its own. It ends on ${date(input.endsAt)}.`,
      "Renew from the server's billing settings to keep Pro without a break; the new time starts where the current one ends."];
  return { subject, heading: subject, greeting: `Hey ${rawName},`, lines, button: "Renew Pro" };
}

/**
 * Prepaid Pro (task #19, docs/billing/prepaid-pro.md) does not renew, so each
 * of its owners hears 7 days and 1 day before it ends, and when it ends (the
 * grace days). Sent once each by the hourly reminder job (prepaidProReminders.ts).
 */
export function renderPrepaidProReminderEmail(rawName: string, input: PrepaidProReminderEmail): { subject: string; html: string; text: string } {
  const copy = prepaidReminderCopy(rawName, input);
  const url = `${appUrl()}/s/${encodeURIComponent(input.server.slug)}/settings/billing`;
  const paragraph = (inner: string) => `<p style="margin: 0 0 12px 0; color: ${SLOCK_INK}; font-size: 16px; line-height: 1.5;">${inner}</p>`;
  const html = renderEmailLayout(`
    <h1 style="margin: 0 0 16px 0; color: ${SLOCK_INK}; font-size: 22px; font-weight: bold;">${escapeHtmlText(copy.heading)}</h1>
    ${paragraph(escapeHtmlText(copy.greeting))}
    ${copy.lines.map((line) => paragraph(escapeHtmlText(line))).join("")}
    ${renderEmailButton(url, copy.button)}
  `);
  const text = [copy.greeting, "", ...copy.lines.flatMap((line) => [line, ""]), `${copy.button}: ${url}`].join("\n");
  return { subject: copy.subject, html, text };
}

/** Returns the provider's email id, if any. `idempotencyKey` makes a retried send a no-op at the provider. */
export async function sendPrepaidProReminderEmail(to: string, name: string, input: PrepaidProReminderEmail, idempotencyKey: string): Promise<string | null> {
  const { subject, html, text } = renderPrepaidProReminderEmail(name, input);
  return sendEmail(to, subject, html, { text, idempotencyKey });
}

export type AgentsHandedOverEmail = {
  /** The deleted person's name, read before the account was scrubbed. */
  deletedName: string;
  agents: { name: string; server: { name: string; slug: string }; machineCleared: boolean; hosted: boolean }[];
};

/**
 * Someone deleted their account and the cleanup handed the agents they
 * created to this person, the owner of each agent's server
 * (services/accountDeletion/cleanup.ts). The agents are stopped; an agent that
 * ran on the deleted person's own Computer needs a Computer again and its local
 * workspace there did not come along.
 */
export function renderAgentsHandedOverEmail(rawName: string, input: AgentsHandedOverEmail): { subject: string; html: string; text: string } {
  const count = input.agents.length;
  const subject = count === 1
    ? `${input.deletedName}'s agent ${input.agents[0]!.name} is now yours on ${BRAND_NAME}`
    : `${input.deletedName}'s ${count} agents are now yours on ${BRAND_NAME}`;
  const lead = `${input.deletedName} deleted their ${BRAND_NAME} account. You own the server${new Set(input.agents.map((a) => a.server.slug)).size === 1 ? "" : "s"} their agents were in, so ${count === 1 ? "this agent is" : "these agents are"} yours now. ${count === 1 ? "It is" : "They are"} stopped and won't run until you start ${count === 1 ? "it" : "them"}; memory and workspace kept on ${BRAND_NAME} are unchanged.`;
  const agentLine = (agent: AgentsHandedOverEmail["agents"][number]) => [
    `${agent.name} (${agent.server.name})`,
    agent.machineCleared ? `ran on ${input.deletedName}'s own Computer: choose one of your Computers when you start it; files it kept on that Computer did not come along` : null,
    agent.hosted ? "hosted by " + BRAND_NAME + ": start it, or delete it from its page if you don't need it" : null,
  ].filter(Boolean).join(" — ");
  const closing = "You can start, edit or delete each agent from its page.";
  const servers = [...new Map(input.agents.map((a) => [a.server.slug, a.server])).values()];
  const url = `${appUrl()}/s/${encodeURIComponent(servers[0]!.slug)}/`;
  const paragraph = (inner: string) => `<p style="margin: 0 0 12px 0; color: ${SLOCK_INK}; font-size: 16px; line-height: 1.5;">${inner}</p>`;
  const html = renderEmailLayout(`
    <h1 style="margin: 0 0 16px 0; color: ${SLOCK_INK}; font-size: 22px; font-weight: bold;">${escapeHtmlText(subject.replace(` on ${BRAND_NAME}`, ""))}</h1>
    ${paragraph(`Hey ${escapeHtmlText(rawName)},`)}
    ${paragraph(escapeHtmlText(lead))}
    <ul style="margin: 0 0 12px 0; padding-left: 20px; color: ${SLOCK_INK}; font-size: 16px; line-height: 1.5;">${input.agents.map((agent) => `<li>${escapeHtmlText(agentLine(agent))}</li>`).join("")}</ul>
    ${paragraph(escapeHtmlText(closing))}
    ${renderEmailButton(url, "Open the server")}
  `);
  const text = [`Hey ${rawName},`, "", lead, "", ...input.agents.map((agent) => `- ${agentLine(agent)}`), "", closing, "", `Open the server: ${url}`].join("\n");
  return { subject, html, text };
}

export async function sendAgentsHandedOverEmail(to: string, name: string, input: AgentsHandedOverEmail): Promise<void> {
  if (input.agents.length === 0) return;
  const { subject, html, text } = renderAgentsHandedOverEmail(name, input);
  await sendEmail(to, subject, html, { text });
}

/**
 * Deletes a Resend contact (by id or email address), so the provider keeps no
 * record of a deleted account. A contact that is already gone counts as
 * deleted. Without a Resend key (development, tests) there is nothing to
 * delete. Throws on any other failure: the caller retries later.
 */
export async function deleteResendContact(contact: { id: string } | { email: string }): Promise<void> {
  const client = getResend();
  if (!client) return;
  const { error } = await client.contacts.remove("id" in contact ? { id: contact.id } : { email: contact.email });
  if (error && error.statusCode !== 404 && error.name !== "not_found") {
    throw new Error(`Failed to delete the Resend contact: ${error.name}`);
  }
}

/**
 * The per-person second-step lock started (services/secondFactor/signIn.ts):
 * someone had the password (or the provider sign-in) and then got the
 * second step wrong too often. Points at changing the password.
 */
/** The web sign-in page opened on "Forgot password" (packages/web FORGOT_PASSWORD_PATH). */
export function forgotPasswordUrl(): string {
  return `${appUrl()}/forgot-password`;
}

export function renderSecondFactorSignInLockedEmail(rawName: string, lockedMinutes: number): { subject: string; html: string; text: string } {
  const subject = `Someone tried to sign in to your ${BRAND_NAME} account`;
  const lead = `Someone signed in with your password and reached the second step, then entered too many wrong codes. Signing in with a code is paused for ${lockedMinutes} minutes.`;
  const advice = "If this wasn't you, someone knows your password: change it now. Changing it signs you out everywhere.";
  const url = appUrl();
  const resetUrl = forgotPasswordUrl();
  const name = escapeHtmlText(rawName);
  const paragraph = (inner: string, margin = "0 0 12px 0") =>
    `<p style="margin: ${margin}; color: ${SLOCK_INK}; font-size: 16px; line-height: 1.5;">${inner}</p>`;
  const html = renderEmailLayout(`
    <h1 style="margin: 0 0 16px 0; color: ${SLOCK_INK}; font-size: 22px; font-weight: bold;">Someone reached your second sign-in step</h1>
    ${paragraph(`Hey ${name},`, "0 0 8px 0")}
    ${paragraph(escapeHtmlText(lead))}
    ${paragraph(escapeHtmlText(advice), "0")}
    ${renderEmailButton(url, "Change your password")}
    <p class="slock-muted" style="margin: 0; color: ${SLOCK_MUTED}; font-size: 13px; line-height: 1.5;">Not signed in anywhere? <a class="slock-link" href="${resetUrl}" style="color: ${SLOCK_LINK}; word-break: break-all;">Reset your password</a> by email: ${resetUrl}</p>
  `);
  const text = [
    `Hey ${rawName},`, "", lead, "", advice, "",
    `Change your password: ${url}`,
    `Not signed in anywhere? Reset your password by email: ${resetUrl}`,
  ].join("\n");
  return { subject, html, text };
}

export async function sendSecondFactorSignInLockedEmail(to: string, name: string, lockedMinutes: number): Promise<void> {
  const { subject, html, text } = renderSecondFactorSignInLockedEmail(name, lockedMinutes);
  await sendEmail(to, subject, html, { text });
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
    <p style="margin: 0 0 8px 0; color: ${SLOCK_INK}; font-size: 16px; line-height: 1.5;"><strong>${inviterName}</strong> invited you to join <strong>${serverName}</strong> on ${BRAND_NAME}.</p>
    <p style="margin: 0; color: ${SLOCK_INK}; font-size: 16px; line-height: 1.5;">${BRAND_NAME} is where humans and AI agents collaborate in real-time.</p>
    ${renderEmailButton(url, "Accept invite")}
    <p class="slock-muted" style="margin: 0 0 4px 0; color: ${SLOCK_MUTED}; font-size: 13px; line-height: 1.5;">Or copy this link: <a class="slock-link" href="${url}" style="color: ${SLOCK_LINK}; word-break: break-all;">${url}</a></p>
    <p class="slock-muted" style="margin: 0; color: ${SLOCK_MUTED}; font-size: 13px;">This invite expires in 7 days.</p>
  `, { footerHtml: renderInviteFooterHtml(inviterName) });
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

export type ExternalChannelInviteEmailInput = {
  inviterName: string;
  channelName: string;
  serverName: string;
  token: string;
  expiresInDays: number;
};

/** Where an external channel invite's link lands (the accept page ships with P2a-2). */
export function externalChannelInviteUrl(token: string): string {
  return `${appUrl()}/external-invite/${encodeURIComponent(token)}`;
}

export function externalChannelInviteSubject(input: Pick<ExternalChannelInviteEmailInput, "inviterName" | "channelName" | "serverName">): string {
  return `${input.inviterName} invited you to #${input.channelName} in ${input.serverName} on ${BRAND_NAME}`;
}

export function renderExternalChannelInviteEmailHtml(input: ExternalChannelInviteEmailInput): string {
  const url = externalChannelInviteUrl(input.token);
  // Inviter, channel and server names are all user-chosen: escape each.
  const inviterName = escapeHtmlText(input.inviterName);
  const channelName = escapeHtmlText(input.channelName);
  const serverName = escapeHtmlText(input.serverName);
  return renderEmailLayout(`
    <h1 style="margin: 0 0 16px 0; color: ${SLOCK_INK}; font-size: 22px; font-weight: bold;">You're invited!</h1>
    <p style="margin: 0 0 8px 0; color: ${SLOCK_INK}; font-size: 16px; line-height: 1.5;"><strong>${inviterName}</strong> invited you to <strong>#${channelName}</strong> in <strong>${serverName}</strong> on ${BRAND_NAME}.</p>
    <p style="margin: 0 0 8px 0; color: ${SLOCK_INK}; font-size: 16px; line-height: 1.5;">Join on your own as a guest to work with ${serverName}, or connect a server you're in to bring in your teammates and agents.</p>
    <p style="margin: 0; color: ${SLOCK_INK}; font-size: 16px; line-height: 1.5;">${BRAND_NAME} is where humans and AI agents collaborate in real-time.</p>
    ${renderEmailButton(url, "Accept invite")}
    <p class="slock-muted" style="margin: 0 0 4px 0; color: ${SLOCK_MUTED}; font-size: 13px; line-height: 1.5;">Or copy this link: <a class="slock-link" href="${url}" style="color: ${SLOCK_LINK}; word-break: break-all;">${url}</a></p>
    <p class="slock-muted" style="margin: 0; color: ${SLOCK_MUTED}; font-size: 13px;">This invite expires in ${input.expiresInDays} days.</p>
  `, { footerHtml: renderInviteFooterHtml(inviterName) });
}

export async function sendExternalChannelInviteEmail(to: string, input: ExternalChannelInviteEmailInput): Promise<void> {
  await sendEmail(to, externalChannelInviteSubject(input), renderExternalChannelInviteEmailHtml(input));
}

export type ServerConnectApprovalEmailInput = {
  /** Whom the email greets: the owner or admin asked. */
  approverName: string;
  requesterName: string;
  targetServerName: string;
  channelName: string;
  hostServerName: string;
  requestId: string;
  /** When the request ends: with the invite it came from. */
  expiresAt: Date;
};

/** Where an approver reviews a request to connect their server to an external channel (#wg-rbac:#16, P2a-3). */
export function serverConnectRequestUrl(requestId: string): string {
  return `${appUrl()}/server-connect-requests/${encodeURIComponent(requestId)}`;
}

export function renderServerConnectApprovalEmailHtml(input: ServerConnectApprovalEmailInput): string {
  const url = serverConnectRequestUrl(input.requestId);
  const requesterName = escapeHtmlText(input.requesterName);
  const targetServerName = escapeHtmlText(input.targetServerName);
  const channelName = escapeHtmlText(input.channelName);
  const hostServerName = escapeHtmlText(input.hostServerName);
  const approverName = escapeHtmlText(input.approverName);
  // Design v5 B3 (b3_email). The request runs until the invite does: the date it ends (UTC, as account deletion prints its dates).
  return renderEmailLayout(`
    <h1 style="margin: 0 0 16px 0; color: ${SLOCK_INK}; font-size: 22px; font-weight: bold;">Approve connecting ${targetServerName}</h1>
    <p style="margin: 0 0 8px 0; color: ${SLOCK_INK}; font-size: 16px; line-height: 1.5;">Hey ${approverName},</p>
    <p style="margin: 0; color: ${SLOCK_INK}; font-size: 16px; line-height: 1.5;"><strong>${requesterName}</strong> wants to connect <strong>${targetServerName}</strong> to <strong>#${channelName}</strong>, an external channel in <strong>${hostServerName}</strong>. As a ${targetServerName} admin, you can approve or decline.</p>
    ${renderEmailButton(url, "Review request")}
    <p class="slock-muted" style="margin: 0 0 4px 0; color: ${SLOCK_MUTED}; font-size: 13px; line-height: 1.5;">Or copy this link: <a class="slock-link" href="${url}" style="color: ${SLOCK_LINK}; word-break: break-all;">${url}</a></p>
    <p class="slock-muted" style="margin: 0; color: ${SLOCK_MUTED}; font-size: 13px;">The request ends with the invite on ${formatAccountDeletionDate(input.expiresAt)}.</p>
  `);
}

export async function sendServerConnectApprovalEmail(to: string, input: ServerConnectApprovalEmailInput): Promise<void> {
  await sendEmail(to, `${input.requesterName} asks to connect ${input.targetServerName} to #${input.channelName} — ${BRAND_NAME}`, renderServerConnectApprovalEmailHtml(input));
}

/** What became of connecting a server with an external invite, told to the invitee. */
export type ExternalConnectOutcome = "approved" | "rejected" | "cancelled" | "failed";

export type ExternalConnectResultEmailInput = {
  outcome: ExternalConnectOutcome;
  targetServerName: string;
  channelName: string;
  hostServerName: string;
};

const EXTERNAL_CONNECT_RESULT_COPY: Record<ExternalConnectOutcome, { subject: (input: ExternalConnectResultEmailInput) => string; title: string; body: (input: { target: string; channel: string; host: string }) => string }> = {
  approved: {
    subject: (input) => `${input.targetServerName} is connecting to #${input.channelName}`,
    title: "Request approved",
    body: ({ target, channel, host }) => `Your request was approved: <strong>${target}</strong> is being connected to <strong>#${channel}</strong> in <strong>${host}</strong>. You'll find the channel in ${target} once it's ready.`,
  },
  rejected: {
    subject: (input) => `Your request to connect ${input.targetServerName} to #${input.channelName} was declined`,
    title: "Request declined",
    body: ({ target, channel }) => `Your request to connect <strong>${target}</strong> to <strong>#${channel}</strong> was declined. Your invite is still open: open the link in your invite email to choose another way to join.`,
  },
  cancelled: {
    subject: (input) => `Your request to connect ${input.targetServerName} to #${input.channelName} was canceled`,
    title: "Request canceled",
    body: ({ target, channel }) => `Your request to connect <strong>${target}</strong> to <strong>#${channel}</strong> can no longer be approved by the person you asked. Your invite is still open: open the link in your invite email to ask someone else or choose another way to join.`,
  },
  failed: {
    subject: (input) => `${input.targetServerName} couldn't be connected to #${input.channelName}`,
    title: "Couldn't connect",
    body: ({ target, channel }) => `<strong>${target}</strong> couldn't be connected to <strong>#${channel}</strong>. Your invite is still open: open the link in your invite email to try again, or choose another way to join.`,
  },
};

export function renderExternalConnectResultEmailHtml(input: ExternalConnectResultEmailInput): string {
  const copy = EXTERNAL_CONNECT_RESULT_COPY[input.outcome];
  // Server and channel names are user-chosen: escape each.
  const body = copy.body({
    target: escapeHtmlText(input.targetServerName),
    channel: escapeHtmlText(input.channelName),
    host: escapeHtmlText(input.hostServerName),
  });
  return renderEmailLayout(`
    <h1 style="margin: 0 0 16px 0; color: ${SLOCK_INK}; font-size: 22px; font-weight: bold;">${copy.title}</h1>
    <p style="margin: 0; color: ${SLOCK_INK}; font-size: 16px; line-height: 1.5;">${body}</p>
  `);
}

export async function sendExternalConnectResultEmail(to: string, input: ExternalConnectResultEmailInput): Promise<void> {
  await sendEmail(to, `${EXTERNAL_CONNECT_RESULT_COPY[input.outcome].subject(input)} — ${BRAND_NAME}`, renderExternalConnectResultEmailHtml(input));
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
    <p style="margin: 0 0 8px 0; color: ${SLOCK_INK}; font-size: 16px; line-height: 1.5;">Hey ${recipientName},</p>
    <p style="margin: 0 0 8px 0; color: ${SLOCK_INK}; font-size: 16px; line-height: 1.5;"><strong>${inviterName}</strong> invited you to join <strong>#${channelName}</strong> with <strong>${fromServerName}</strong> from <strong>${toServerName}</strong>.</p>
    <p style="margin: 0; color: ${SLOCK_INK}; font-size: 16px; line-height: 1.5;">Open this link while signed in as a ${toServerName} admin to accept the invite.</p>
    ${renderEmailButton(url, "Accept Invite")}
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

/**
 * An existing account was linked to a Server's SSO connection
 * (rfcs/083-server-sso.md §5.3): from now on that company's identity provider
 * can sign this person in. The person's one signal that it happened.
 */
export function renderSsoIdentityLinkedEmail(rawName: string, input: { connectionName: string }): { subject: string; html: string; text: string } {
  const subject = `Your ${BRAND_NAME} account was linked to ${input.connectionName} single sign-on`;
  const lead = `You just signed in to ${BRAND_NAME} with ${input.connectionName} single sign-on, so your account is now linked to it. From now on, ${input.connectionName} can sign you in to this account.`;
  const advice = "If this wasn't you, change your password now (that signs you out everywhere) and tell the admins of the server that uses this sign-on.";
  const name = escapeHtmlText(rawName);
  const paragraph = (inner: string, margin = "0 0 12px 0") =>
    `<p style="margin: ${margin}; color: ${SLOCK_INK}; font-size: 16px; line-height: 1.5;">${inner}</p>`;
  const html = renderEmailLayout(`
    <h1 style="margin: 0 0 16px 0; color: ${SLOCK_INK}; font-size: 22px; font-weight: bold;">Your account was linked to single sign-on</h1>
    ${paragraph(`Hey ${name},`, "0 0 8px 0")}
    ${paragraph(escapeHtmlText(lead))}
    ${paragraph(escapeHtmlText(advice), "0")}
  `);
  const text = [`Hey ${rawName},`, "", lead, "", advice].join("\n");
  return { subject, html, text };
}

export async function sendSsoIdentityLinkedEmail(to: string, name: string, input: { connectionName: string }): Promise<void> {
  const { subject, html, text } = renderSsoIdentityLinkedEmail(name, input);
  await sendEmail(to, subject, html, { text });
}

export type SsoDomainNoticeKind = "lookup_failing" | "unverified";

/**
 * A Server's SSO domain needs its admins (rfcs/083-server-sso.md §5.5): its
 * DNS record could not be read for a day, or it was confirmed gone and the
 * domain no longer signs anyone up, links or auto-joins.
 */
export function renderSsoDomainNoticeEmail(rawName: string, input: { kind: SsoDomainNoticeKind; serverName: string; domain: string }): { subject: string; html: string; text: string } {
  const subject = input.kind === "unverified"
    ? `${input.domain} is no longer verified for single sign-on on ${input.serverName}`
    : `${BRAND_NAME} can't check ${input.domain} for single sign-on on ${input.serverName}`;
  const lead = input.kind === "unverified"
    ? `The DNS record that proves ${input.domain} belongs to ${input.serverName} is gone, so single sign-on no longer creates, links or adds accounts for that domain. People already linked keep signing in while the connection is on.`
    : `For the last day, ${BRAND_NAME} could not read the DNS record that proves ${input.domain} belongs to ${input.serverName}. Nothing has changed yet: after 7 days of failed lookups the domain stops counting as verified.`;
  const advice = input.kind === "unverified"
    ? "To restore it, publish the TXT record shown in the server's SSO settings again and verify the domain."
    : "Check that the TXT record shown in the server's SSO settings is still published and that your DNS answers.";
  const name = escapeHtmlText(rawName);
  const paragraph = (inner: string, margin = "0 0 12px 0") =>
    `<p style="margin: ${margin}; color: ${SLOCK_INK}; font-size: 16px; line-height: 1.5;">${inner}</p>`;
  const html = renderEmailLayout(`
    <h1 style="margin: 0 0 16px 0; color: ${SLOCK_INK}; font-size: 22px; font-weight: bold;">${escapeHtmlText(subject)}</h1>
    ${paragraph(`Hey ${name},`, "0 0 8px 0")}
    ${paragraph(escapeHtmlText(lead))}
    ${paragraph(escapeHtmlText(advice), "0")}
  `);
  const text = [`Hey ${rawName},`, "", lead, "", advice].join("\n");
  return { subject, html, text };
}

export async function sendSsoDomainNoticeEmail(to: string, name: string, input: { kind: SsoDomainNoticeKind; serverName: string; domain: string }): Promise<void> {
  const { subject, html, text } = renderSsoDomainNoticeEmail(name, input);
  await sendEmail(to, subject, html, { text });
}
