import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type Stripe from "stripe";
import {
  paidCashEvidence,
  paidJourneyId,
  paidLifecycleAutomation,
  PAID_LIFECYCLE_TEMPLATES,
  paidReceiptMarker,
  paidReceiptMarkerFromHtml,
} from "./paidLifecycleContracts";

test("offline assets match the reviewed welcome and unchanged check-in; migration uses the actual docs anchor", () => {
  const rendered = JSON.parse(execFileSync(process.execPath, [
    fileURLToPath(new URL("../../../../scripts/render-paid-lifecycle-assets.mjs", import.meta.url)),
  ], { encoding: "utf8" }));
  assert.deepEqual(rendered.templates, PAID_LIFECYCLE_TEMPLATES,
    "the documented offline Node entrypoint must emit the same deployable assets");
  const { welcome, checkin } = PAID_LIFECYCLE_TEMPLATES;
  assert.equal(welcome.subject, "Welcome to Raft Pro");
  assert.equal(createHash("sha256").update(welcome.html).digest("hex"),
    "88e3ab4fdc7f08622f24fe3ac3b411a9e071ef4bdc915868519fe8080d96f862");
  assert.ok(welcome.html.includes("https://docs.raft.build/features/server/computers/#move-an-agent-to-another-computer"));
  assert.equal(createHash("sha256").update(checkin.html).digest("hex"),
    "3a641c52225a0c7a4c79a2f98054978afb6661801ee6eba4025c18a28008f163");
});

const invoice = {
  id: "in_synthetic",
  status: "paid",
  amount_paid: 500,
  currency: "usd",
  customer: "cus_synthetic",
  livemode: false,
} as Stripe.Invoice;
const payment = {
  id: "inpay_synthetic",
  invoice: "in_synthetic",
  status: "paid",
  amount_paid: 500,
  currency: "usd",
  livemode: false,
  status_transitions: { paid_at: 1791550000 },
  payment: { type: "payment_intent", payment_intent: "pi_synthetic" },
} as Stripe.InvoicePayment;
const charge = {
  id: "ch_synthetic",
  status: "succeeded",
  paid: true,
  captured: true,
  refunded: false,
  amount_refunded: 0,
  amount_captured: 500,
  currency: "usd",
  customer: "cus_synthetic",
  livemode: false,
  payment_intent: "pi_synthetic",
} as Stripe.Charge;

test("real positive captured invoice allocation qualifies; invoice flags, credit/manual records, mismatches do not; refunds do not revoke the historical payment", () => {
  assert.deepEqual(paidCashEvidence(invoice, payment, charge), {
    invoiceId: "in_synthetic",
    paymentId: "inpay_synthetic",
    chargeId: "ch_synthetic",
    amount: 500,
    paidAt: new Date(1791550000000),
  });
  for (const patch of [
    { status: "open" },
    { amount_paid: 0 },
    { amount_paid: null },
    { invoice: "in_other" },
    { currency: "eur" },
    { livemode: true },
    { payment: { type: "payment_record", payment_record: "pyr_synthetic" } },
    { payment: { type: "payment_intent" } },
  ])
    assert.equal(
      paidCashEvidence(
        invoice,
        { ...payment, ...patch } as Stripe.InvoicePayment,
        charge,
      ),
      null,
    );
  for (const patch of [
    { paid: false },
    { captured: false },
    { status: "failed" },
    { amount_captured: 499 },
    { customer: "cus_other" },
    { currency: "eur" },
    { livemode: true },
    { payment_intent: "pi_other" },
  ])
    assert.equal(
      paidCashEvidence(invoice, payment, {
        ...charge,
        ...patch,
      } as Stripe.Charge),
      null,
    );
  for (const patch of [
    { refunded: true, amount_refunded: 500 },
    { amount_refunded: 1 },
  ])
    assert.deepEqual(
      paidCashEvidence(invoice, payment, { ...charge, ...patch }),
      paidCashEvidence(invoice, payment, charge),
    );
  assert.equal(
    paidCashEvidence({ ...invoice, status: "open" }, payment, charge),
    null,
  );
  assert.equal(
    paidCashEvidence(
      invoice,
      { ...payment, payment: { type: "charge", charge: "ch_synthetic" } },
      charge,
    )?.amount,
    500,
  );
});

test("only one authenticated journey/step marker can bind an email; guessed subjects, addresses or ambiguous markers cannot", () => {
  const secret = "synthetic-marker-key-not-used-outside-tests";
  const journey = paidJourneyId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  for (const kind of ["welcome", "checkin"] as const) {
    const marker = paidReceiptMarker(secret, journey, kind),
      html = `<!-- raft-paid-receipt:${marker} -->`;
    assert.deepEqual(paidReceiptMarkerFromHtml(secret, html), {
      journeyId: journey,
      kind,
    });
    assert.equal(
      paidReceiptMarkerFromHtml(
        "other-synthetic-marker-key-with-enough-bytes",
        html,
      ),
      null,
    );
    assert.equal(
      paidReceiptMarkerFromHtml(secret, html.replace("aaaaaaaa", "bbbbbbbb")),
      null,
    );
    assert.equal(paidReceiptMarkerFromHtml(secret, html + html), null);
    assert.equal(
      paidReceiptMarkerFromHtml(
        secret,
        html.replace(kind, kind === "welcome" ? "checkin" : "welcome"),
      ),
      null,
    );
  }
  assert.equal(
    paidReceiptMarkerFromHtml(
      secret,
      "<p>Paid welcome synthetic@example.test</p>",
    ),
    null,
  );
  assert.equal(paidReceiptMarkerFromHtml(secret, "x".repeat(1_048_577)), null);
  assert.throws(() => paidJourneyId("not-a-durable-id"));
  assert.throws(() => paidReceiptMarker("short", journey, "welcome"));
});

test("disabled Automation welcomes immediately, checks current paid count after 35 days, and does not mirror or overwrite unsubscribe preferences", () => {
  const plan = paidLifecycleAutomation(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  );
  assert.equal(plan.status, "disabled");
  assert.deepEqual(plan.steps.find((s) => s.key === "wait")?.config, {
    duration: "35 days",
  });
  assert.deepEqual(plan.steps.find((s) => s.key === "paid")?.config, {
    type: "rule",
    field: "contact.properties.paid_server_count",
    operator: "gt",
    value: 0,
  });
  assert.deepEqual(
    plan.connections.filter((c) => c.type === "condition_met"),
    [
      { from: "once", to: "mark", type: "condition_met" },
      { from: "paid", to: "checkin", type: "condition_met" },
    ],
  );
  assert.equal(JSON.stringify(plan).includes("unsubscribed"), false);
  for (const template of Object.values(PAID_LIFECYCLE_TEMPLATES)) {
    assert.ok(template.html.includes("{{{RESEND_UNSUBSCRIBE_URL}}}"));
    assert.ok(
      template.html.includes("<!-- raft-paid-receipt:{{{PAID_RECEIPT}}} -->"),
    );
  }
  assert.throws(() =>
    paidLifecycleAutomation("guessed-template", "also-guessed"),
  );
});
