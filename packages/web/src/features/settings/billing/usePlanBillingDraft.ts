import { useState, useEffect } from "react";
import { clearBillingEntry, peekBillingEntry } from "../../../analytics/billingEntry";

// Stryker disable all: Settings billing UI wiring is covered by the billing page behavior tests and visual preview screenshots.
// What Plan & Billing is doing lives above PlanSection's loading gate, so a
// reload of billing mid-action (which can show the skeleton again) doesn't
// drop the notice, the error or an open seat dialog.
export function usePlanBillingDraft() {
  const [billingAction, setBillingAction] = useState<"portal" | "keep" | "cancel" | null>(null);
  const [billingError, setBillingError] = useState("");
  const [billingNotice, setBillingNotice] = useState("");
  const [showCancelSubscriptionConfirm, setShowCancelSubscriptionConfirm] = useState(false);
  const [seatDialog, setSeatDialog] = useState<"add" | "remove" | null>(null);
  // The paywall that opened this page, if any; taken once, so the next
  // opening from Settings does not inherit it (analytics/billingEntry.ts).
  const [billingEntry] = useState(() => peekBillingEntry());
  useEffect(() => clearBillingEntry(), []);
  return {
    billingAction, setBillingAction,
    billingError, setBillingError,
    billingNotice, setBillingNotice,
    showCancelSubscriptionConfirm, setShowCancelSubscriptionConfirm,
    seatDialog, setSeatDialog,
    billingEntry,
  };
}

// Stryker restore all
