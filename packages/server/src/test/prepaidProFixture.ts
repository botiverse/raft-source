import { randomUUID } from "node:crypto";
import type { DatabaseExecutor } from "../db/index";
import { prepaidProPurchases } from "../db/schema";

// Prepaid fixtures exercise the stored-purchase reader, not a mocked plan switch.
export async function seedPrepaidPurchase(db: DatabaseExecutor, input: {
  serverId: string;
  startsAt: Date;
  endsAt: Date;
  kind?: "period" | "seats";
  months?: 1 | 12 | null;
  seatQuantity?: number;
  status?: "paid" | "refunded" | "conflict";
  userId?: string | null;
}): Promise<string> {
  const kind = input.kind ?? "period";
  const status = input.status ?? "paid";
  const [row] = await db.insert(prepaidProPurchases).values({
    serverId: input.serverId,
    kind,
    months: kind === "period" ? (input.months ?? 1) : null,
    seatQuantity: input.seatQuantity ?? 2,
    startsAt: input.startsAt,
    endsAt: input.endsAt,
    status,
    conflictReason: status === "conflict" ? "paid_source" : null,
    stripeCheckoutSessionId: `cs_test_${randomUUID()}`,
    amountTotal: 2000,
    currency: "usd",
    purchasedByUserId: input.userId ?? null,
  }).returning({ id: prepaidProPurchases.id });
  return row.id;
}
