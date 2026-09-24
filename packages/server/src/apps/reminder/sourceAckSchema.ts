import { randomUUID } from "node:crypto";
import { check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { agents, reminders, servers } from "../../db/schema.js";

export const reminderSourceAckEvents = pgTable("reminder_events", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  reminderId: uuid("reminder_id").notNull().references(() => reminders.id, { onDelete: "cascade" }),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  ownerAgentId: uuid("owner_agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  actorType: text("actor_type", { enum: ["agent", "human", "system"] }).notNull(),
  actorId: uuid("actor_id"),
  eventType: text("event_type", { enum: ["scheduled", "fired", "snoozed", "updated", "canceled"] }).notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  nextFireAt: timestamp("next_fire_at", { withTimezone: true }),
  metadata: jsonb("metadata"),
});

export const reminderSourceAcknowledgements = pgTable("reminder_source_acknowledgements", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  ownerAgentId: uuid("owner_agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  reminderId: uuid("reminder_id").notNull().references(() => reminders.id, { onDelete: "cascade" }),
  sourceVersion: integer("source_version").notNull(),
  sourceEventId: uuid("source_event_id").notNull().references(() => reminderSourceAckEvents.id, { onDelete: "cascade" }),
  acknowledgedByAgentId: uuid("acknowledged_by_agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  ackAttemptId: uuid("ack_attempt_id").notNull(),
  acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("idx_reminder_source_acks_exact_unique").on(t.serverId, t.ownerAgentId, t.reminderId, t.sourceVersion),
  index("idx_reminder_source_acks_attempt").on(t.ackAttemptId),
  check("reminder_source_acks_source_version_positive", sql`${t.sourceVersion} > 0`),
]);
