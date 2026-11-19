import { describe, expect, it } from "vitest";
import {
  PRO_PREPAID_GRACE_DAYS,
  parseFfaServerPlanEntitlementInputs,
  prepaidGrantOf,
  resolveEffectiveServerBillingPlan,
  resolveServerBillingPlanSource,
} from "./serverBillingEntitlement";

describe("serverBillingEntitlement", () => {
  const NOW = new Date("2026-11-15T12:00:00.000Z");

  describe("prepaidGrantOf", () => {
    it("pins the 3-day Prepaid Pro grace window", () => {
      expect(PRO_PREPAID_GRACE_DAYS).toBe(3);
    });

    it("returns null when there are no covering periods or only future periods", () => {
      expect(prepaidGrantOf([], NOW)).toBeNull();
      expect(
        prepaidGrantOf(
          [
            {
              kind: "period",
              seatQuantity: 5,
              startsAt: "2026-11-16T00:00:00.000Z",
              endsAt: "2026-12-16T00:00:00.000Z",
            },
          ],
          NOW,
        ),
      ).toBeNull();
    });

    it("follows chained early-renewal periods and sums covering seat add-ons", () => {
      const grant = prepaidGrantOf(
        [
          {
            kind: "period",
            seatQuantity: 4,
            startsAt: "2026-11-01T00:00:00.000Z",
            endsAt: "2026-12-01T00:00:00.000Z",
          },
          {
            kind: "period",
            seatQuantity: 4,
            startsAt: "2026-12-01T00:00:00.000Z",
            endsAt: "2027-01-01T00:00:00.000Z",
          },
          {
            kind: "seats",
            seatQuantity: 2,
            startsAt: "2026-11-10T00:00:00.000Z",
            endsAt: "2027-01-01T00:00:00.000Z",
          },
        ],
        NOW,
      );
      expect(grant).toEqual({
        endsAt: "2027-01-01T00:00:00.000Z",
        graceEndsAt: "2027-01-04T00:00:00.000Z",
        inGrace: false,
        seatQuantity: 6,
      });
    });

    it("keeps Pro during the 3-day grace window and drops to null at exact graceEndsAt", () => {
      const rows = [
        {
          kind: "period" as const,
          seatQuantity: 3,
          startsAt: "2026-10-13T12:00:00.000Z",
          endsAt: "2026-11-13T12:00:00.000Z",
        },
        {
          kind: "seats" as const,
          seatQuantity: 2,
          startsAt: "2026-10-20T12:00:00.000Z",
          endsAt: "2026-11-13T12:00:00.000Z",
        },
      ];

      const inGrace = prepaidGrantOf(rows, new Date("2026-11-16T11:59:59.999Z"));
      expect(inGrace).toEqual({
        endsAt: "2026-11-13T12:00:00.000Z",
        graceEndsAt: "2026-11-16T12:00:00.000Z",
        inGrace: true,
        seatQuantity: 5,
      });

      expect(prepaidGrantOf(rows, new Date("2026-11-16T12:00:00.000Z"))).toBeNull();
    });
  });

  describe("resolveServerBillingPlanSource", () => {
    it("resolves missing or Free servers to free", () => {
      expect(resolveEffectiveServerBillingPlan(null, NOW)).toBe("free");
      expect(resolveServerBillingPlanSource({ serverPlan: "free" }, NOW)).toMatchObject({
        plan: "free",
        source: "server",
      });
    });

    it("clears stale servers.plan='pro' when a non-entitling subscription exists without AppSumo or Prepaid", () => {
      expect(
        resolveServerBillingPlanSource(
          {
            serverPlan: "pro",
            subscriptionPlan: "pro",
            subscriptionStatus: "canceled",
            hasActiveAppSumo: false,
            prepaidPurchases: [],
          },
          NOW,
        ),
      ).toMatchObject({
        plan: "free",
        source: "server",
      });
    });

    it("preserves AppSumo Pro even when an older canceled Stripe subscription row exists", () => {
      expect(
        resolveServerBillingPlanSource(
          {
            serverPlan: "pro",
            subscriptionPlan: "pro",
            subscriptionStatus: "canceled",
            hasActiveAppSumo: true,
            prepaidPurchases: [],
          },
          NOW,
        ),
      ).toMatchObject({
        plan: "pro",
        source: "appsumo",
      });
    });

    it("preserves Prepaid Pro (active or in-grace) even when an older canceled Stripe subscription row exists", () => {
      expect(
        resolveServerBillingPlanSource(
          {
            serverPlan: "free",
            subscriptionPlan: "pro",
            subscriptionStatus: "canceled",
            hasActiveAppSumo: false,
            prepaidPurchases: [
              {
                kind: "period",
                seatQuantity: 2,
                startsAt: "2026-10-13T12:00:00.000Z",
                endsAt: "2026-11-13T12:00:00.000Z",
              },
            ],
          },
          NOW,
        ),
      ).toMatchObject({
        plan: "pro",
        source: "prepaid",
      });
    });

    it("ranks appsumo > subscription > prepaid while preserving founder and partner internal plans", () => {
      const prepaidPurchases = [
        {
          kind: "period" as const,
          seatQuantity: 2,
          startsAt: "2026-11-01T00:00:00.000Z",
          endsAt: "2026-12-01T00:00:00.000Z",
        },
      ];

      expect(
        resolveServerBillingPlanSource(
          {
            serverPlan: "free",
            subscriptionPlan: "pro",
            subscriptionStatus: "past_due",
            hasActiveAppSumo: true,
            prepaidPurchases,
          },
          NOW,
        ),
      ).toMatchObject({ plan: "pro", source: "appsumo" });

      expect(
        resolveServerBillingPlanSource(
          {
            serverPlan: "free",
            subscriptionPlan: "pro",
            subscriptionStatus: "past_due",
            hasActiveAppSumo: false,
            prepaidPurchases,
          },
          NOW,
        ),
      ).toMatchObject({ plan: "pro", source: "subscription" });

      expect(
        resolveServerBillingPlanSource(
          {
            serverPlan: "free",
            subscriptionPlan: null,
            subscriptionStatus: null,
            hasActiveAppSumo: true,
            prepaidPurchases,
          },
          NOW,
        ),
      ).toMatchObject({ plan: "pro", source: "appsumo" });

      for (const internalPlan of ["founder", "partner"] as const) {
        expect(
          resolveServerBillingPlanSource(
            {
              serverPlan: internalPlan,
              subscriptionPlan: "pro",
              subscriptionStatus: "active",
              hasActiveAppSumo: true,
              prepaidPurchases,
            },
            NOW,
          ),
        ).toMatchObject({
          plan: internalPlan,
          source: "server",
          hasInternalEntitlement: true,
        });
      }
    });
  });

  describe("parseFfaServerPlanEntitlementInputs", () => {
    const validRaw = {
      server_plan: "free",
      subscription_plan: "pro",
      subscription_status: "canceled",
      has_active_appsumo: true,
      prepaid_purchases: [
        {
          kind: "period",
          seat_quantity: 5,
          starts_at: "2026-11-01T00:00:00+00:00",
          ends_at: "2026-12-01T00:00:00+00:00",
        },
      ],
    };

    it("parses null as found:false and accepts the exact non-secret JSONB contract", () => {
      expect(parseFfaServerPlanEntitlementInputs(null)).toEqual({ found: false });
      expect(parseFfaServerPlanEntitlementInputs(validRaw)).toEqual({
        found: true,
        inputs: {
          serverPlan: "free",
          subscriptionPlan: "pro",
          subscriptionStatus: "canceled",
          hasActiveAppSumo: true,
          prepaidPurchases: [
            {
              kind: "period",
              seatQuantity: 5,
              startsAt: "2026-11-01T00:00:00+00:00",
              endsAt: "2026-12-01T00:00:00+00:00",
            },
          ],
        },
      });
    });

    it("rejects any extra/secret fields or malformed values so preview fails closed", () => {
      expect(() => parseFfaServerPlanEntitlementInputs(undefined)).toThrow(TypeError);
      expect(() => parseFfaServerPlanEntitlementInputs([])).toThrow(TypeError);
      expect(() =>
        parseFfaServerPlanEntitlementInputs({
          ...validRaw,
          license_key: "00000000-0000-4000-8000-000000000001",
        }),
      ).toThrow(/unexpected field set/);
      expect(() =>
        parseFfaServerPlanEntitlementInputs({
          ...validRaw,
          tier: 2,
        }),
      ).toThrow(/unexpected field set/);
      expect(() =>
        parseFfaServerPlanEntitlementInputs({
          ...validRaw,
          server_plan: "enterprise",
        }),
      ).toThrow(/invalid server_plan/);
      expect(() =>
        parseFfaServerPlanEntitlementInputs({
          ...validRaw,
          subscription_plan: "enterprise",
        }),
      ).toThrow(/invalid subscription_plan/);
      expect(() =>
        parseFfaServerPlanEntitlementInputs({
          ...validRaw,
          has_active_appsumo: "yes",
        }),
      ).toThrow(/invalid has_active_appsumo/);
      expect(() =>
        parseFfaServerPlanEntitlementInputs({
          ...validRaw,
          prepaid_purchases: [
            {
              ...validRaw.prepaid_purchases[0],
              stripe_checkout_session_id: "cs_live_secret",
            },
          ],
        }),
      ).toThrow(/unexpected fields/);
      expect(() =>
        parseFfaServerPlanEntitlementInputs({
          ...validRaw,
          prepaid_purchases: [
            {
              ...validRaw.prepaid_purchases[0],
              seat_quantity: 0,
            },
          ],
        }),
      ).toThrow(/invalid seat_quantity/);
      expect(() =>
        parseFfaServerPlanEntitlementInputs({
          ...validRaw,
          prepaid_purchases: [
            {
              ...validRaw.prepaid_purchases[0],
              starts_at: "not-a-timestamp",
            },
          ],
        }),
      ).toThrow(/invalid starts_at/);
    });
  });
});
