#!/usr/bin/env tsx
import { createHash, randomBytes } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import pg from "pg";
import * as schema from "../src/db/schema.js";
import { resolveAgentManifestUrl } from "../src/services/oauthService.js";

type Options = {
  clientId: string;
  name: string;
  serverId: string;
  createdByUserId: string;
  description: string | null;
  homepageUrl: string | null;
  returnUrl: string | null;
  agentManifestUrl: string | null;
  rotateSecret: boolean;
};

function usage() {
  console.error([
    "Usage:",
    "  DATABASE_URL=... tsx scripts/upsert-built-in-oauth-client.ts \\",
    "    --client-id slock-survey \\",
    "    --name \"Slock Survey\" \\",
    "    --server-id <platform-server-uuid> \\",
    "    --created-by-user-id <slock-owner-user-uuid> \\",
    "    --homepage-url https://survey.example.com \\",
    "    --return-url https://survey.example.com/login/slock/callback",
    "",
    "Options:",
    "  --description <text>",
    "  --agent-manifest-url <https-url>",
    "  --rotate-secret  Rotate an existing client's secret and print the new value once.",
    "",
    "This is an operator script for Slock first-party built-in apps. It does not",
    "create third-party marketplace listings or server-local private apps.",
  ].join("\n"));
}

function readRequired(args: string[], index: number, flag: string): string {
  const value = args[index + 1]?.trim();
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parseArgs(argv: string[]): Options {
  const options: Partial<Options> = {
    description: null,
    homepageUrl: null,
    returnUrl: null,
    agentManifestUrl: null,
    rotateSecret: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--client-id") {
      options.clientId = readRequired(argv, i, arg);
      i++;
      continue;
    }
    if (arg === "--name") {
      options.name = readRequired(argv, i, arg);
      i++;
      continue;
    }
    if (arg === "--server-id") {
      options.serverId = readRequired(argv, i, arg);
      i++;
      continue;
    }
    if (arg === "--created-by-user-id") {
      options.createdByUserId = readRequired(argv, i, arg);
      i++;
      continue;
    }
    if (arg === "--description") {
      options.description = readRequired(argv, i, arg);
      i++;
      continue;
    }
    if (arg === "--homepage-url") {
      options.homepageUrl = readRequired(argv, i, arg);
      i++;
      continue;
    }
    if (arg === "--return-url") {
      options.returnUrl = readRequired(argv, i, arg);
      i++;
      continue;
    }
    if (arg === "--agent-manifest-url") {
      options.agentManifestUrl = readRequired(argv, i, arg);
      i++;
      continue;
    }
    if (arg === "--rotate-secret") {
      options.rotateSecret = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!options.clientId || !options.name || !options.serverId || !options.createdByUserId) {
    usage();
    throw new Error("--client-id, --name, --server-id, and --created-by-user-id are required");
  }

  return options as Options;
}

function hashSecret(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function generateSecret() {
  return `raft_secret_${randomBytes(24).toString("hex")}`;
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    usage();
    throw new Error("DATABASE_URL is required");
  }

  const options = parseArgs(process.argv.slice(2));
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  const db = drizzle(pool, { schema });

  try {
    const [existing] = await db
      .select({
        id: schema.oauthClients.id,
        clientId: schema.oauthClients.clientId,
      })
      .from(schema.oauthClients)
      .where(eq(schema.oauthClients.clientId, options.clientId))
      .limit(1);

    const agentManifestUrl = resolveAgentManifestUrl({
      agentManifestUrl: options.agentManifestUrl,
      homepageUrl: options.homepageUrl,
      returnUrl: options.returnUrl,
    });

    if (existing) {
      const nextSecret = options.rotateSecret ? generateSecret() : null;
      const [updated] = await db
        .update(schema.oauthClients)
        .set({
          serverId: options.serverId,
          createdByUserId: options.createdByUserId,
          appType: "slock_builtin",
          name: options.name,
          description: options.description,
          homepageUrl: options.homepageUrl,
          returnUrl: options.returnUrl,
          agentManifestUrl,
          ...(nextSecret ? { clientSecretHash: hashSecret(nextSecret) } : {}),
          updatedAt: new Date(),
        })
        .where(eq(schema.oauthClients.id, existing.id))
        .returning({
          id: schema.oauthClients.id,
          clientId: schema.oauthClients.clientId,
          appType: schema.oauthClients.appType,
          name: schema.oauthClients.name,
          returnUrl: schema.oauthClients.returnUrl,
        });

      console.log(JSON.stringify({
        action: "updated",
        client: updated,
        rotatedSecret: Boolean(nextSecret),
        ...(nextSecret ? { clientSecret: nextSecret } : {}),
      }, null, 2));
      return;
    }

    const clientSecret = generateSecret();
    const [created] = await db
      .insert(schema.oauthClients)
      .values({
        serverId: options.serverId,
        createdByUserId: options.createdByUserId,
        clientId: options.clientId,
        clientSecretHash: hashSecret(clientSecret),
        appType: "slock_builtin",
        name: options.name,
        description: options.description,
        homepageUrl: options.homepageUrl,
        returnUrl: options.returnUrl,
        agentManifestUrl,
      })
      .returning({
        id: schema.oauthClients.id,
        clientId: schema.oauthClients.clientId,
        appType: schema.oauthClients.appType,
        name: schema.oauthClients.name,
        returnUrl: schema.oauthClients.returnUrl,
      });

    console.log(JSON.stringify({
      action: "created",
      client: created,
      clientSecret,
    }, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
