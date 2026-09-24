#!/usr/bin/env tsx
//
// Read-only inventory of live Computer attachments whose attaching user does
// NOT currently hold the manageMachines capability (owner/admin) on the
// attachment's server — i.e. the rows that became possible only because the
// attach endpoint historically gated on membership instead of role
// (#wg-raft-computer, tygg 2026-06-05). The role gate now blocks NEW such
// attaches; this script surfaces the existing backlog so a human can decide
// keep vs revoke. SELECT-only: it never mutates and never prints key material.
//
// "online" = the linked machine (daemons row) sent a heartbeat in the last 5
// minutes — revoking such a row would kick a currently-running Computer
// offline, so the report flags them explicitly.
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import pg from "pg";
import * as schema from "../src/db/schema.js";

type CliOptions = {
  serverId?: string;
  json: boolean;
};

type NonAdminAttachmentRow = {
  computerId: string;
  computerName: string;
  serverId: string;
  serverSlug: string;
  attachedByUserId: string | null;
  attacherEmail: string | null;
  attacherRole: string | null; // 'member' | null (no longer a member)
  machineId: string | null;
  machineOnline: boolean;
  lastHeartbeat: string | null;
  createdAt: string;
};

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--server-id" && argv[i + 1]) {
      options.serverId = argv[++i];
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function usage() {
  console.error(
    [
      "Usage:",
      "  DATABASE_URL=... tsx scripts/audit-nonadmin-computer-attachments.ts [--server-id <uuid>] [--json]",
      "",
      "Lists live (non-revoked) Computer attachments whose attaching user is",
      "currently a plain member (or no longer a member) of the attachment's",
      "server — the backlog the manageMachines attach gate does NOT retro-revoke.",
      "",
      "Options:",
      "  --server-id <id>  Restrict the audit to a single server",
      "  --json            Print machine-readable JSON instead of a text report",
    ].join("\n"),
  );
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    usage();
    throw new Error("DATABASE_URL is required");
  }

  const options = parseArgs(process.argv.slice(2));
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 5 });
  const db = drizzle(pool, { schema });

  try {
    const scopeWhere = options.serverId
      ? sql`AND c.server_id = ${options.serverId}`
      : sql``;

    // A row qualifies when the attacher's CURRENT role on the attachment's
    // server is 'member', or they have no membership row at all (left the
    // server / attachedByUserId went null). owner/admin attachments are the
    // legitimate ones and are excluded.
    const rows = await db.execute<NonAdminAttachmentRow>(sql`
      SELECT
        c.id::text                                            AS "computerId",
        c.name                                                AS "computerName",
        c.server_id::text                                     AS "serverId",
        s.slug                                                AS "serverSlug",
        c.attached_by_user_id::text                           AS "attachedByUserId",
        u.email                                               AS "attacherEmail",
        sm.role                                               AS "attacherRole",
        c.machine_id::text                                    AS "machineId",
        (d.last_heartbeat IS NOT NULL
          AND d.last_heartbeat > now() - interval '5 minutes') AS "machineOnline",
        d.last_heartbeat::text                                AS "lastHeartbeat",
        c.created_at::text                                    AS "createdAt"
      FROM computers c
      JOIN servers s ON s.id = c.server_id
      LEFT JOIN users u ON u.id = c.attached_by_user_id
      LEFT JOIN server_members sm
        ON sm.server_id = c.server_id AND sm.user_id = c.attached_by_user_id
      LEFT JOIN daemons d ON d.id = c.machine_id
      WHERE c.revoked_at IS NULL
        AND s.deleted_at IS NULL
        AND (sm.role IS NULL OR sm.role = 'member')
        ${scopeWhere}
      ORDER BY "machineOnline" DESC, c.created_at ASC
    `);

    if (options.json) {
      console.log(JSON.stringify(rows.rows, null, 2));
      return;
    }

    if (rows.rows.length === 0) {
      console.error("No non-admin Computer attachments found. Backlog is clean.");
      return;
    }

    const online = rows.rows.filter((r) => r.machineOnline).length;
    const orphan = rows.rows.filter((r) => r.attacherRole === null).length;
    console.error(
      `Found ${rows.rows.length} live non-admin Computer attachment(s): ` +
        `${online} currently ONLINE (revoke would kick offline), ` +
        `${orphan} attacher no-longer-a-member.\n`,
    );
    for (const r of rows.rows) {
      const roleLabel = r.attacherRole ?? "(not a member)";
      const onlineLabel = r.machineOnline ? "ONLINE" : "offline";
      console.error(
        `  [${onlineLabel}] computer=${r.computerId} "${r.computerName}" ` +
          `server=${r.serverSlug} attacher=${r.attacherEmail ?? r.attachedByUserId ?? "(null)"} ` +
          `role=${roleLabel} lastHeartbeat=${r.lastHeartbeat ?? "never"} attachedAt=${r.createdAt}`,
      );
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
