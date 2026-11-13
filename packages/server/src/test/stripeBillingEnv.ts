// Billing configured for a test file: agent upgrade cards are offered and
// prepared only where it is (no billing, no purchase card; Warden on #14428).
// Placeholder values: nothing here reaches Stripe.

const STRIPE_BILLING_TEST_ENV = {
  STRIPE_BILLING_ENABLED: "true",
  STRIPE_SECRET_KEY: "sk_test_upgrade_cards",
  STRIPE_WEBHOOK_SECRET: "whsec_upgrade_cards",
  STRIPE_PRO_SEAT_MONTHLY_PRICE_ID: "price_upgrade_cards_monthly",
  STRIPE_PRO_SEAT_ANNUAL_PRICE_ID: "price_upgrade_cards_annual",
} as const;

type StripeBillingEnvKey = keyof typeof STRIPE_BILLING_TEST_ENV;

/** Sets the Stripe billing env before each test of the calling file and restores it after. */
export function useStripeBillingConfigured(): void {
  let saved: Partial<Record<StripeBillingEnvKey, string | undefined>> = {};
  beforeEach(() => {
    saved = {};
    for (const [key, value] of Object.entries(STRIPE_BILLING_TEST_ENV) as [StripeBillingEnvKey, string][]) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }
  });
  afterEach(() => {
    for (const key of Object.keys(STRIPE_BILLING_TEST_ENV) as StripeBillingEnvKey[]) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

/** Clears the Stripe billing flag for one test body (inside useStripeBillingConfigured). */
export function withoutStripeBilling<T>(run: () => Promise<T>): Promise<T> {
  const saved = process.env.STRIPE_BILLING_ENABLED;
  delete process.env.STRIPE_BILLING_ENABLED;
  return run().finally(() => {
    if (saved === undefined) delete process.env.STRIPE_BILLING_ENABLED;
    else process.env.STRIPE_BILLING_ENABLED = saved;
  });
}
