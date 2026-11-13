import { createHmac, timingSafeEqual } from "node:crypto";
import type Stripe from "stripe";
// Owner-reviewed copy and layout, synchronized from the disabled Resend template.
// No provider configuration, publication or sending occurs when imported.
const PAID_WELCOME_HTML = "\n<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n  <meta charset=\"utf-8\">\n  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">\n  \n  <style>\n    /*\n      Match the newsletter dark-mode strategy: do not force the body/card into\n      light colors, because Gmail iOS may invert text while preserving locked\n      backgrounds. Only the brand bar keeps the yellow gradient so the logo\n      remains legible under Gmail's natural dark transform.\n    */\n    body, .slock-shell { background-color: #FFFAEF; color: #141111; }\n    .slock-email-bar { background-color: #FFD440; background-image: linear-gradient(#FFD440, #FFD440); color: #141111; }\n    .slock-card, .slock-content { background-color: #FFFFFF; color: #141111; }\n    .slock-content strong { color: inherit; }\n    .slock-button { background-color: #FFD440; color: #141111; }\n    .slock-link { color: #FE7DA8; }\n    .slock-muted { color: #6B6B6B; }\n  </style>\n</head>\n<body class=\"slock-shell\" style=\"margin: 0; padding: 0; background-color: #FFFAEF; color: #141111; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;\">\n  <div style=\"display: none; max-height: 0; overflow: hidden; opacity: 0; color: transparent;\">More chat history and file storage, plus Joint Channels and agent migration.</div>\n  <table class=\"slock-shell\" role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" style=\"background-color: #FFFAEF; color: #141111; padding: 40px 20px;\">\n    <tr>\n      <td align=\"center\">\n        <table role=\"presentation\" width=\"480\" cellpadding=\"0\" cellspacing=\"0\" style=\"max-width: 480px; width: 100%;\">\n          <!-- Card -->\n          <tr>\n            <td class=\"slock-card\" style=\"background-color: #FFFFFF; color: #141111; border: 2px solid #141111; box-shadow: 4px 4px 0 #141111; padding: 0;\">\n              <table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\">\n                <tr>\n                  <td class=\"slock-email-bar\" style=\"background-color: #FFD440; background-image: linear-gradient(#FFD440, #FFD440); color: #141111; border-bottom: 2px solid #141111; padding: 16px 24px; text-align: center;\">\n                    <img class=\"slock-brand\" src=\"https://app.raft.build/brand/raft-logo.png\" width=\"162\" height=\"40\" alt=\"Raft\" style=\"display: block; margin: 0 auto; border: 0; outline: none; text-decoration: none;\">\n                  </td>\n                </tr>\n                <tr>\n                  <td class=\"slock-content\" style=\"background-color: #FFFFFF; color: #141111; padding: 32px 24px;\">\n                    \n<h1 style=\"margin:0 0 16px;color:#141111;font-size:22px;font-weight:bold;\">Welcome to Raft Pro!</h1>\n<p style=\"margin:0 0 16px;font-size:15px;line-height:1.6;\">Thanks for joining us on Pro! Here are a few ways to make the most of your upgrade:</p>\n<ul style=\"margin:20px 0;padding-left:20px;font-size:15px;line-height:1.6;\"><li><strong>More room to create:</strong> unlimited message history, files up to 200 MB each, and no monthly upload cap for your Server.</li></ul>\n<p style=\"margin:20px 0 0;font-size:15px;line-height:1.6;\">And there’s more to explore with your Pro plan:</p>\n<h2 style=\"margin:24px 0 8px;font-size:18px;line-height:1.4;\">Let your agents team up</h2>\n<p style=\"margin:0 0 12px;font-size:15px;line-height:1.6;\">Make collaboration with partners easier by letting your agents and theirs work together in a <a class=\"slock-link\" href=\"https://docs.raft.build/features/messaging/joint-channels/\" style=\"color:#FE7DA8;text-decoration:underline;\">Joint Channel</a>. Both teams can bring their people and agents into the same conversation, while keeping their own Servers.</p>\n<h2 style=\"margin:24px 0 8px;font-size:18px;line-height:1.4;\">Give your agent the right home</h2>\n<p style=\"margin:0 0 12px;font-size:15px;line-height:1.6;\">Move your agent to the connected computer best suited to its work, with its workspace and saved memory coming along. <a class=\"slock-link\" href=\"https://docs.raft.build/features/server/computers/#move-an-agent-to-another-computer\" style=\"color:#FE7DA8;text-decoration:underline;\">Agent migration</a> lets you choose where it runs as your needs change, without setting up a new agent.</p>\n<p style=\"margin:20px 0 0;font-size:15px;line-height:1.6;\">Ready to give them a go? Jump into Raft and try one with your team.</p>\n\n<div style=\"margin: 24px 0;\">\n  <a class=\"slock-button\" href=\"https://app.raft.build\" target=\"_blank\" style=\"display: inline-block; background-color: #FFD440; color: #141111; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 15px; font-weight: bold; text-decoration: none; padding: 12px 28px; border: 2px solid #141111; box-shadow: 4px 4px 0 #141111; letter-spacing: 0.5px;\">Open Raft</a>\n</div><p style=\"margin:0;font-size:15px;line-height:1.6;\">Happy building,<br>The Raft team</p>\n                  </td>\n                </tr>\n              </table>\n            </td>\n          </tr>\n          <!-- Footer -->\n          \n          <tr>\n            <td style=\"padding-top: 24px; text-align: center;\">\n              <p class=\"slock-footer-links\" style=\"font-size:10px;line-height:1.5;color:#9A9A9A;margin:0;text-align:center;\"><a href=\"https://raft.build/privacy\" style=\"color:#9A9A9A;text-decoration:underline;\">Privacy Policy</a> · <span style=\"color:#9A9A9A;text-decoration:none;\">Botiverse, Inc. · 1111B S Governors Ave, Suite 95905, Dover, DE 19904, US</span> · <a href=\"{{{RESEND_UNSUBSCRIBE_URL}}}\" style=\"color:#9A9A9A;text-decoration:underline;\">Unsubscribe</a></p>\n            </td>\n          </tr>\n        </table>\n      </td>\n    </tr>\n  </table>\n<!-- raft-paid-receipt:{{{PAID_RECEIPT}}} -->\n</body>\n</html>\n";

export type PaidJourneyId = string & {
  readonly __paidJourneyId: unique symbol;
};
export type PaidReceiptMarker = string & {
  readonly __paidReceiptMarker: unique symbol;
};
export type PaidEmailKind = "welcome" | "checkin";
export type PaidInvoiceId = string & {
  readonly __paidInvoiceId: unique symbol;
};
export type PaidInvoicePaymentId = string & {
  readonly __paidInvoicePaymentId: unique symbol;
};
export type PaidChargeId = string & { readonly __paidChargeId: unique symbol };
export function paidInvoiceId(value: string): PaidInvoiceId {
  if (!/^in_[\w-]{1,240}$/.test(value)) throw new Error("INVALID_PAID_INVOICE");
  return value as PaidInvoiceId;
}
export function paidInvoicePaymentId(value: string): PaidInvoicePaymentId {
  if (!/^inpay_[\w-]{1,240}$/.test(value))
    throw new Error("INVALID_PAID_ALLOCATION");
  return value as PaidInvoicePaymentId;
}
export function paidChargeId(value: string): PaidChargeId {
  if (!/^ch_[\w-]{1,240}$/.test(value)) throw new Error("INVALID_PAID_CHARGE");
  return value as PaidChargeId;
}
export type PaidCashEvidence = {
  invoiceId: PaidInvoiceId;
  paymentId: PaidInvoicePaymentId;
  chargeId: PaidChargeId;
  amount: number;
  paidAt: Date;
};

const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export function paidJourneyId(value: string): PaidJourneyId {
  if (!UUID.test(value)) throw new Error("INVALID_PAID_JOURNEY");
  return value as PaidJourneyId;
}
function id(value: string | { id: string } | null | undefined) {
  return typeof value === "string" ? value : value?.id;
}

// An invoice marked paid, positive invoice total, Pro entitlement or a manual
// payment record is NOT cash proof. Bind the allocation to a successful,
// captured charge and the same customer/currency/livemode. Refund state is not
// an eligibility policy: current paid counts follow the subscription projection.
export function paidCashEvidence(
  invoice: Stripe.Invoice,
  payment: Stripe.InvoicePayment,
  charge: Stripe.Charge,
): PaidCashEvidence | null {
  if (
    invoice.status !== "paid" ||
    !invoice.id ||
    payment.status !== "paid" ||
    id(payment.invoice) !== invoice.id ||
    !Number.isSafeInteger(payment.amount_paid) ||
    !payment.amount_paid ||
    payment.amount_paid <= 0 ||
    !Number.isSafeInteger(payment.status_transitions.paid_at) ||
    !payment.status_transitions.paid_at ||
    payment.status_transitions.paid_at <= 0 ||
    payment.currency !== invoice.currency ||
    charge.currency !== invoice.currency ||
    payment.livemode !== invoice.livemode ||
    charge.livemode !== invoice.livemode ||
    !charge.paid ||
    !charge.captured ||
    charge.status !== "succeeded" ||
    !Number.isSafeInteger(charge.amount_captured) ||
    charge.amount_captured < payment.amount_paid ||
    !id(invoice.customer) ||
    id(charge.customer) !== id(invoice.customer)
  )
    return null;
  const bound =
    payment.payment.type === "charge"
      ? id(payment.payment.charge) === charge.id
      : payment.payment.type === "payment_intent" &&
        Boolean(id(payment.payment.payment_intent)) &&
        id(payment.payment.payment_intent) === id(charge.payment_intent);
  if (!bound) return null;
  return {
    invoiceId: paidInvoiceId(invoice.id),
    paymentId: paidInvoicePaymentId(payment.id),
    chargeId: paidChargeId(charge.id),
    amount: payment.amount_paid,
    paidAt: new Date(payment.status_transitions.paid_at * 1000),
  };
}

// A receipt token refers to a random, durable journey, never an email address,
// User UUID or payment metadata. Both templates render the exact marker in HTML.
// A verified email.sent callback retrieves THAT email ID from Resend, then
// resolves only a valid marker against the durable journey. No subject/address
// matching and no trusting a webhook's custom metadata as Raft identity.
export function paidReceiptMarker(
  secret: string,
  journey: PaidJourneyId,
  kind: PaidEmailKind,
): PaidReceiptMarker {
  if (Buffer.byteLength(secret) < 32)
    throw new Error("PAID_RECEIPT_SECRET_UNAVAILABLE");
  const value = `v1.${journey}.${kind}`;
  return `${value}.${createHmac("sha256", secret).update(`raft-paid-email-marker\n${value}`).digest("hex")}` as PaidReceiptMarker;
}
export function paidReceiptMarkerFromHtml(
  secret: string,
  html: string,
): { journeyId: PaidJourneyId; kind: PaidEmailKind } | null {
  if (Buffer.byteLength(secret) < 32 || Buffer.byteLength(html) > 1_048_576)
    return null;
  const matches = [...html.matchAll(/<!-- raft-paid-receipt:([^\s<>]+) -->/g)];
  if (matches.length !== 1) return null;
  const parts = matches[0][1].split(".");
  if (
    parts.length !== 4 ||
    parts[0] !== "v1" ||
    !UUID.test(parts[1]) ||
    !["welcome", "checkin"].includes(parts[2]) ||
    !/^[a-f0-9]{64}$/.test(parts[3])
  )
    return null;
  const journeyId = paidJourneyId(parts[1]),
    kind = parts[2] as PaidEmailKind;
  const expected = paidReceiptMarker(secret, journeyId, kind).split(".")[3];
  if (
    !timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(parts[3], "hex"))
  )
    return null;
  return { journeyId, kind };
}

export function paidLifecycleAutomation(
  welcomeTemplate: string,
  checkinTemplate: string,
) {
  if (!UUID.test(welcomeTemplate) || !UUID.test(checkinTemplate))
    throw new Error("INVALID_PAID_TEMPLATE");
  return {
    name: "Raft first-paid welcome and 35-day check-in",
    status: "disabled",
    steps: [
      {
        key: "start",
        type: "trigger",
        config: { event_name: "raft.first_paid" },
      },
      {
        key: "once",
        type: "condition",
        config: {
          type: "rule",
          field: "contact.properties.paid_journey_started",
          operator: "neq",
          value: 1,
        },
      },
      {
        key: "mark",
        type: "contact_update",
        config: { properties: { paid_journey_started: 1 } },
      },
      {
        key: "welcome",
        type: "send_email",
        config: {
          template: {
            id: welcomeTemplate,
            variables: { PAID_RECEIPT: { var: "event.welcome_receipt" } },
          },
          from: "Raft <notifications@raft.build>",
          reply_to: "contact@raft.build",
        },
      },
      { key: "wait", type: "delay", config: { duration: "35 days" } },
      {
        key: "paid",
        type: "condition",
        config: {
          type: "rule",
          field: "contact.properties.paid_server_count",
          operator: "gt",
          value: 0,
        },
      },
      {
        key: "checkin",
        type: "send_email",
        config: {
          template: {
            id: checkinTemplate,
            variables: { PAID_RECEIPT: { var: "event.checkin_receipt" } },
          },
          from: "Raft <notifications@raft.build>",
          reply_to: "contact@raft.build",
        },
      },
    ],
    connections: [
      { from: "start", to: "once" },
      { from: "once", to: "mark", type: "condition_met" },
      { from: "mark", to: "welcome" },
      { from: "welcome", to: "wait" },
      { from: "wait", to: "paid" },
      { from: "paid", to: "checkin", type: "condition_met" },
    ],
  };
}

export const PAID_LIFECYCLE_TEMPLATES = {
  welcome: {
    name: "Raft paid welcome",
    subject: "Welcome to Raft Pro",
    variables: [{ key: "PAID_RECEIPT", type: "string" }],
    html: PAID_WELCOME_HTML,
  },
  checkin: {
    name: "Raft paid 30-day check-in",
    subject: "How is Raft working for you?",
    variables: [{ key: "PAID_RECEIPT", type: "string" }],
    html: '<p>You have been using a paid Raft workspace for about a month. How is it going?</p><p>What has been useful, and what would make collaboration with your team and agents easier? Reply to this email with any feedback or questions.</p><p><a href="{{{RESEND_UNSUBSCRIBE_URL}}}">Unsubscribe</a></p><!-- raft-paid-receipt:{{{PAID_RECEIPT}}} -->',
  },
} as const;
