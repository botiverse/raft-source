/**
 * Raft-recommended MCP Apps. Authority: the `mcp_app_templates` table (0416), maintained by
 * Raft App admin; `config/mcpAppTemplates.json` remains the migration seed and the fallback
 * when the table is unreadable. `MCP_APP_TEMPLATES_PATH` points at a replacement fallback file.
 * Served by `GET /api/mcp/app-templates` (active rows only); clients hold no list of their own.
 * A template's endpoint and auth kind belong to Raft.
 */
import { readFileSync } from "node:fs";
import { asc } from "drizzle-orm";
import { MANAGED_MCP_OAUTH_CLIENT_MODES, OAUTH_CLIENT_CATEGORIES } from "@botiverse/raft-shared";
import { z } from "zod";
import { getDb } from "../db/index";
import { mcpAppTemplates } from "../db/schema";
import { ManagedMcpGatewayError, validateManagedMcpEndpoint } from "./managedMcpGateway";

const templateSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/u),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(500),
  homepageUrl: z.url({ protocol: /^https$/u }),
  logoUrl: z.url({ protocol: /^https$/u }).nullable(),
  category: z.enum(OAUTH_CLIENT_CATEGORIES),
  endpointUrl: z.url({ protocol: /^https$/u }),
  authKind: z.enum(["none", "headers", "oauth"]),
  // Optional in the bundled JSON; every row carries it (default "either").
  oauthClientMode: z.enum(MANAGED_MCP_OAUTH_CLIENT_MODES).default("either"),
}).strict();

// The bundled JSON can mark a template retired, so the fallback (an unreadable table) hides the same
// templates the admin retired instead of offering them again.
const templateFileEntrySchema = templateSchema.extend({ status: z.enum(["active", "retired"]).default("active") }).strict();

const templatesFileSchema = z.object({
  templates: z.array(templateFileEntrySchema).refine(
    (templates) => new Set(templates.map((template) => template.key)).size === templates.length,
    "template keys must be unique",
  ),
}).strict();

export type McpAppTemplate = z.infer<typeof templateSchema> & { maintainedByRaft: true };
type McpAppTemplateMetadata = Pick<McpAppTemplate, "key" | "logoUrl" | "oauthClientMode">;

type TemplateEntry = { template: McpAppTemplate; active: boolean; selectable: boolean };
const loggedInvalidEndpoints = new Set<string>();

// The catalog can contain old administrator-owned rows. Reject an endpoint the
// gateway would reject before recommending it or using it for a new App, but
// retain unrelated metadata for existing Apps.
function isSelectableTemplate(template: McpAppTemplate): boolean {
  try {
    validateManagedMcpEndpoint(template.endpointUrl);
    // Report a later regression again after an administrator fixes this row.
    loggedInvalidEndpoints.delete(template.key);
    return true;
  } catch (error) {
    if (!(error instanceof ManagedMcpGatewayError)) throw error;
    return false;
  }
}

function logUnselectableTemplate(key: string): void {
  // Never log an endpoint: even its query can contain sensitive information.
  if (loggedInvalidEndpoints.has(key)) return;
  loggedInvalidEndpoints.add(key);
  console.error(`[MCP] skipping recommended-app template with an invalid endpoint: ${key}`);
}

function templateMetadata(template: McpAppTemplate): McpAppTemplateMetadata {
  return { key: template.key, logoUrl: template.logoUrl, oauthClientMode: template.oauthClientMode };
}

let cachedJson: TemplateEntry[] | null = null;

function parseMcpAppTemplateEntries(raw: unknown): TemplateEntry[] {
  return templatesFileSchema.parse(raw).templates.map(({ status, ...fields }) => {
    const template = { ...fields, maintainedByRaft: true as const };
    return { template, active: status === "active", selectable: isSelectableTemplate(template) };
  });
}

/** Every template in a bundled-format file, retired ones included. */
export function parseMcpAppTemplates(raw: unknown): McpAppTemplate[] {
  return parseMcpAppTemplateEntries(raw).filter((entry) => {
    if (!entry.selectable) logUnselectableTemplate(entry.template.key);
    return entry.selectable;
  }).map((entry) => entry.template);
}

function bundledEntries(): TemplateEntry[] {
  if (!cachedJson) {
    const path = process.env.MCP_APP_TEMPLATES_PATH?.trim() || new URL("../config/mcpAppTemplates.json", import.meta.url);
    cachedJson = parseMcpAppTemplateEntries(JSON.parse(readFileSync(path, "utf8")));
  }
  return cachedJson;
}

/** The bundled JSON's active templates: seed source and last-resort fallback. */
export function getBundledMcpAppTemplates(): McpAppTemplate[] {
  return bundledEntries().filter((entry) => {
    if (entry.active && !entry.selectable) logUnselectableTemplate(entry.template.key);
    return entry.active && entry.selectable;
  }).map((entry) => entry.template);
}

const templateColumns = {
  key: mcpAppTemplates.key,
  name: mcpAppTemplates.name,
  description: mcpAppTemplates.description,
  homepageUrl: mcpAppTemplates.homepageUrl,
  logoUrl: mcpAppTemplates.logoUrl,
  category: mcpAppTemplates.category,
  endpointUrl: mcpAppTemplates.endpointUrl,
  authKind: mcpAppTemplates.authKind,
  oauthClientMode: mcpAppTemplates.oauthClientMode,
  status: mcpAppTemplates.status,
  createdAt: mcpAppTemplates.createdAt,
} as const;

type TemplateRow = { status: string; createdAt: Date } & Record<Exclude<keyof typeof templateColumns, "status" | "createdAt">, unknown>;

/** All catalog rows, validated one at a time: one bad row cannot hide a good catalog. */
async function readAllTemplateRows(): Promise<{ row: McpAppTemplate; active: boolean; selectable: boolean; createdAt: Date }[] | null> {
  try {
    const rows = (await getDb()
      .select(templateColumns)
      .from(mcpAppTemplates)
      // Catalog order is insertion order (the seed's Notion-then-Linear), matching the bundled
      // JSON so admin edits don't reshuffle the list clients display.
      .orderBy(asc(mcpAppTemplates.createdAt))) as TemplateRow[];
    const parsed: { row: McpAppTemplate; active: boolean; selectable: boolean; createdAt: Date }[] = [];
    for (const { status, createdAt, ...fields } of rows) {
      // One malformed row must not hide a whole catalog (a bad admin write is recoverable by a
      // follow-up edit): skip it loudly rather than falling back to the bundled JSON.
      try {
        const template = { ...templateSchema.parse(fields), maintainedByRaft: true as const };
        parsed.push({ row: template, active: status === "active", selectable: isSelectableTemplate(template), createdAt });
      } catch {
        const key = typeof fields.key === "string" && /^[a-z][a-z0-9-]{0,62}$/u.test(fields.key) ? fields.key : "(invalid key)";
        console.error(`[MCP] skipping invalid recommended-app template row ${key}`);
      }
    }
    return parsed;
  } catch {
    console.error("[MCP] recommended-app template read failed; serving bundled fallback");
    return null;
  }
}

/** Active recommended-App templates from the DB; falls back to the bundled JSON on any read failure. */
export async function listMcpAppTemplates(): Promise<McpAppTemplate[]> {
  return (await listMcpAppTemplatesWithCreatedAt()).map((entry) => entry.template);
}

/**
 * listMcpAppTemplates with when each template joined the catalog (the Marketplace's publish time).
 * The bundled fallback has no times: `createdAt` is null there.
 */
export async function listMcpAppTemplatesWithCreatedAt(): Promise<{ template: McpAppTemplate; createdAt: Date | null }[]> {
  const all = await readAllTemplateRows();
  if (!all) return getBundledMcpAppTemplates().map((template) => ({ template, createdAt: null }));
  return all.filter((entry) => {
    if (entry.active && !entry.selectable) logUnselectableTemplate(entry.row.key);
    return entry.active && entry.selectable;
  }).map((entry) => ({ template: entry.row, createdAt: entry.createdAt }));
}

export async function findMcpAppTemplate(key: string): Promise<McpAppTemplateMetadata | null> {
  const all = await readAllTemplateRows();
  if (!all) {
    const entry = bundledEntries().find((candidate) => candidate.template.key === key);
    return entry ? templateMetadata(entry.template) : null;
  }
  // Retired rows are still resolved: an App created while the template was active keeps its
  // templateKey and logo; the template just stops being offered to new Apps (listMcpAppTemplates).
  const entry = all.find((candidate) => candidate.row.key === key);
  return entry ? templateMetadata(entry.row) : null;
}

/**
 * The catalog row only, never the bundled fallback: "unavailable" when the catalog cannot be read.
 * For an admin-set rule (the OAuth client mode) that the bundled default would quietly loosen.
 */
export async function findMcpAppTemplateRow(key: string): Promise<McpAppTemplateMetadata | null | "unavailable"> {
  const all = await readAllTemplateRows();
  if (!all) return "unavailable";
  const entry = all.find((candidate) => candidate.row.key === key);
  return entry ? templateMetadata(entry.row) : null;
}

/**
 * Active-only lookup for the paths that build something new from a template (creating an App,
 * resolving a managed provider's endpoint): a retired template must not mint another App. Existing
 * Apps' templateKey/logo still resolve through findMcpAppTemplate above.
 */
export async function findActiveMcpAppTemplate(key: string): Promise<McpAppTemplate | null> {
  const all = await readAllTemplateRows();
  if (!all) return getBundledMcpAppTemplates().find((template) => template.key === key) ?? null;
  const entry = all.find((candidate) => candidate.row.key === key);
  if (entry?.active && !entry.selectable) logUnselectableTemplate(entry.row.key);
  return entry?.active && entry.selectable ? entry.row : null;
}

export function __resetMcpAppTemplatesForTests(): void {
  cachedJson = null;
  loggedInvalidEndpoints.clear();
}
