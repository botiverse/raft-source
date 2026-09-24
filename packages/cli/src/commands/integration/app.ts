// `raft integration app prepare register` — agent prepares a third-party app
// registration action card for server commit. Every
// agent can self-register; this command never embeds a
// client secret in the prepared card.

import type { Command } from "commander";
import { basename, extname } from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";
import {
  OAUTH_CLIENT_CATEGORIES,
  canonicalizeOAuthClientCategory,
  type AgentApiIntegrationAppPrepareResponse,
  type AgentApiOwnedIntegrationApp,
  type OAuthClientCategory,
} from "@botiverse/raft-shared";

import { defineCommand, registerCliCommand } from "../../core/command.js";
import type { CommandContext, CommandRuntimeOptions } from "../../core/context.js";
import { cliError } from "../../core/errors.js";
import { writeJson, writeText, NL, adoptCliReplyText } from "../../core/renderer.js";
import { createAgentApiSurfaceClient } from "../../agentApiPath.js";
import {
  projectActionPrepareReceipt,
  projectAppListReceipt,
  projectAppLogoReceipt,
  projectAppManageReceipt,
  projectAppPrepareReceipt,
  projectAppRotateSecretToFileReceipt,
  projectAppStatusReceipt,
  projectAppTransferOwnerReceipt,
  projectAppUpdateReceipt,
} from "./appReceipts.js";
import {
  closePrivateSecretSink,
  preparePrivateSecretSink,
  writePrivateSecretSink,
} from "./privateSecretSink.js";

const MAX_APP_LOGO_BYTES = 5 * 1024 * 1024;
const APP_LOGO_MIME_BY_EXTENSION: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

interface AppPrepareOptions {
  name?: string;
  clientKey?: string;
  redirectUrl?: string;
  appUrl?: string;
  homepageUrl?: string;
  description?: string;
  category?: string;
  agentManifestUrl?: string;
  scope?: string[];
  scopes?: string[];
  unsafeDemoUrlOverride?: boolean;
  target: string;
  json?: boolean;
}

function normalizeScopes(raw: string[] | undefined): string[] | undefined {
  if (!raw || raw.length === 0) return undefined;
  const scopes = Array.from(new Set(
    raw.flatMap((value) => value.split(","))
      .map((value) => value.trim())
      .filter(Boolean),
  )).sort();
  if (scopes.length === 0) {
    throw cliError("INVALID_ARG", "--scope must include at least one non-empty scope");
  }
  return scopes;
}

function requiredTrimmed(value: string | undefined, flag: string): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) throw cliError("INVALID_ARG", `${flag} is required`);
  return trimmed;
}

function optionalTrimmed(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

function optionalCategory(value: string | undefined): OAuthClientCategory | undefined {
  if (value === undefined) return undefined;
  const category = canonicalizeOAuthClientCategory(value.trim());
  if (!category) {
    throw cliError("INVALID_ARG", `--category must be one of: ${OAUTH_CLIENT_CATEGORIES.join(", ")}`);
  }
  return category;
}

function formatAppPrepare(data: AgentApiIntegrationAppPrepareResponse): string {
  const lines = [
    `Integration app ${data.mode} card prepared`,
    `client key: ${data.action.clientKey ?? "auto-generated on commit"}`,
    `card: ${data.actionCardMessageId}`,
    `target: ${data.target}`,
  ];
  if (data.action.name) lines.push(`name: ${data.action.name}`);
  if (data.action.category) lines.push(`category: ${data.action.category}`);
  if (data.action.homepageUrl) lines.push(`app URL: ${data.action.homepageUrl}`);
  if (data.action.returnUrl) lines.push(`redirect URL: ${data.action.returnUrl}`);
  if (data.action.agentManifestUrl) lines.push(`agent manifest: ${data.action.agentManifestUrl}`);
  if (data.action.scopes) lines.push(`scopes: ${data.action.scopes.length > 0 ? data.action.scopes.join(", ") : "-"}`);
  if (data.action.unsafeDemoUrlOverride) lines.push("unsafe demo URL override: requested");
  lines.push("capability: every agent can self-register an app; App Admin is not involved");
  if (data.mode === "register") lines.push("owner: the requesting agent (you) becomes the app owner and can rotate, update, or transfer it after commit");
  lines.push("next: submit the action card for server commit");
  if (data.mode === "register") {
    lines.push("secret: after human commit, the requesting owner agent receives the initial secret once through a private transient notice; it is never stored in the card or chat history");
    lines.push("recovery: only if that handoff is lost, use `raft integration app rotate-secret --client <client-key-from-receipt> --output <new-private-path>`; the replacement secret is written only to that new private file and invalidates the previous one");
  }
  return lines.join("\n");
}

async function prepareApp(
  mode: "register" | "update",
  ctx: CommandContext,
  opts: AppPrepareOptions,
): Promise<void> {
  const target = requiredTrimmed(opts.target, "--target");
  const scopes = normalizeScopes([...(opts.scope ?? []), ...(opts.scopes ?? [])]);
  const agentContext = ctx.loadAgentContext();
  const client = ctx.createApiClient(agentContext);
  const commonBody = {
    target,
    name: optionalTrimmed(opts.name),
    description: optionalTrimmed(opts.description),
    category: optionalCategory(opts.category),
    homepageUrl: optionalTrimmed(opts.homepageUrl) ?? optionalTrimmed(opts.appUrl),
    returnUrl: optionalTrimmed(opts.redirectUrl),
    agentManifestUrl: optionalTrimmed(opts.agentManifestUrl),
    scopes,
    unsafeDemoUrlOverride: opts.unsafeDemoUrlOverride === true,
  };
  const body = mode === "update"
    ? { ...commonBody, mode: "update" as const, clientKey: requiredTrimmed(opts.clientKey, "--client-key") }
    : { ...commonBody, mode: "register" as const, clientKey: optionalTrimmed(opts.clientKey) };
  if (body.mode === "register") {
    requiredTrimmed(body.name, "--name");
    requiredTrimmed(body.returnUrl, "--redirect-url");
  }

  const res = await createAgentApiSurfaceClient(client).integrations.prepareApp(body);
  if (!res.ok || !res.data) {
    const code = res.status >= 500 ? "SERVER_5XX" : "INTEGRATION_APP_PREPARE_FAILED";
    throw cliError(code, res.error ?? `HTTP ${res.status}`);
  }
  const receipt = projectAppPrepareReceipt(res.data);
  if (opts.json) {
    writeJson(ctx.io, { ok: true, data: receipt });
    return;
  }
  writeText(ctx.io, adoptCliReplyText(formatAppPrepare(receipt)), NL);
}

interface AppRotateSecretOptions {
  client: string;
  output?: string;
  json?: boolean;
}

function formatAppRotateSecret(data: ReturnType<typeof projectAppRotateSecretToFileReceipt>): string {
  return [
    `Integration app secret regenerated for ${data.clientName} (${data.clientKey})`,
    `secret file: ${data.secretSink.path}`,
    `mode: ${data.secretSink.mode}`,
    `path policy: ${data.secretSink.selection}; keep it out of Web/static/shared surfaces`,
    `path binding: ${data.secretSink.binding}`,
    `secret disclosure: ${data.secretDisclosure}`,
    `next: ${data.next}`,
  ].join("\n");
}

async function rotateAppSecret(
  ctx: CommandContext,
  opts: AppRotateSecretOptions,
): Promise<void> {
  const clientKey = requiredTrimmed(opts.client, "--client");
  const agentContext = ctx.loadAgentContext();
  const client = ctx.createApiClient(agentContext);
  const sink = preparePrivateSecretSink(opts.output);

  let res;
  try {
    res = await createAgentApiSurfaceClient(client).integrations.rotateAppSecret({ clientKey });
  } catch (error) {
    closePrivateSecretSink(sink);
    throw cliError(
      "INTEGRATION_APP_ROTATE_SECRET_FAILED",
      `app secret rotation request failed before any secret was written; the empty private sink remains at ${sink.filePath}, so remove it before retrying`,
      { cause: error },
    );
  }
  if (!res.ok || !res.data) {
    closePrivateSecretSink(sink);
    const code = res.status >= 500 ? "SERVER_5XX" : "INTEGRATION_APP_ROTATE_SECRET_FAILED";
    throw cliError(
      code,
      `app secret rotation failed (HTTP ${res.status}); no secret was written, but the empty private sink remains at ${sink.filePath}, so remove it before retrying`,
    );
  }
  writePrivateSecretSink(sink, res.data.clientSecret);
  const receipt = projectAppRotateSecretToFileReceipt(res.data, {
    path: sink.filePath,
    mode: "0600",
    created: true,
    containsSecret: true,
    selection: "agent-selected",
    binding: "caller-managed-after-return",
  });
  if (opts.json) {
    writeJson(ctx.io, { ok: true, data: receipt });
    return;
  }
  writeText(ctx.io, adoptCliReplyText(formatAppRotateSecret(receipt)), NL);
}

export const integrationAppRotateSecretCommand = defineCommand(
  {
    name: "rotate-secret",
    description: "Regenerate an app client secret into a newly-created private local file",
    options: [
      { flags: "--client <key>", description: "App client key / OAuth client_id" },
      { flags: "--output <new-private-path>", description: "Agent-selected non-public path; a new mode-0600 file is created and existing paths are rejected" },
      { flags: "--json", description: "Emit machine-readable JSON" },
    ],
  },
  async (ctx, opts: AppRotateSecretOptions) => rotateAppSecret(ctx, opts),
);

interface AppTransferOwnerOptions {
  client: string;
  toAgent: string;
  json?: boolean;
}

async function transferAppOwner(ctx: CommandContext, opts: AppTransferOwnerOptions): Promise<void> {
  const clientKey = requiredTrimmed(opts.client, "--client");
  const targetAgent = requiredTrimmed(opts.toAgent, "--to-agent");
  const agentContext = ctx.loadAgentContext();
  const client = ctx.createApiClient(agentContext);
  const res = await createAgentApiSurfaceClient(client).integrations.transferAppOwner({ clientKey, targetAgent });
  if (!res.ok || !res.data) {
    const code = res.status >= 500 ? "SERVER_5XX" : "INTEGRATION_APP_TRANSFER_OWNER_FAILED";
    throw cliError(code, res.error ?? `HTTP ${res.status}`);
  }
  const receipt = projectAppTransferOwnerReceipt(res.data);
  if (opts.json) {
    writeJson(ctx.io, { ok: true, data: receipt });
    return;
  }
  const outcome = receipt.ownershipOutcome === "transferred"
    ? `transferred to @${receipt.ownerAgentName}`
    : `is already owned by @${receipt.ownerAgentName}; no ownership change was needed`;
  writeText(ctx.io, adoptCliReplyText([
    `Integration app ${receipt.clientName} (${receipt.clientKey}) ${outcome}`,
    `audit event: ${receipt.auditEventId}`,
    "",
  ].join("\n")));
}

export const integrationAppTransferOwnerCommand = defineCommand(
  {
    name: "transfer-owner",
    description: "Transfer an app you own or administer to another agent on the same server",
    options: [
      { flags: "--client <key>", description: "App client key / OAuth client_id" },
      { flags: "--to-agent <name>", description: "New owner agent name" },
      { flags: "--json", description: "Emit machine-readable JSON" },
    ],
  },
  async (ctx, opts: AppTransferOwnerOptions) => transferAppOwner(ctx, opts),
);

interface AppUpdateOptions {
  client: string;
  name?: string;
  description?: string;
  category?: string;
  homepageUrl?: string;
  redirectUrl?: string;
  agentManifestUrl?: string;
  scope?: string[];
  scopes?: string[];
  clearScopes?: boolean;
  unsafeDemoUrlOverride?: boolean;
  json?: boolean;
}

async function updateApp(ctx: CommandContext, opts: AppUpdateOptions): Promise<void> {
  const clientKey = requiredTrimmed(opts.client, "--client");
  const category = optionalCategory(opts.category);
  if (opts.redirectUrl !== undefined && !opts.redirectUrl.trim()) {
    throw cliError("INVALID_ARG", "--redirect-url cannot be empty; OAuth apps must keep a registered callback URL");
  }
  if (opts.clearScopes && ((opts.scope?.length ?? 0) > 0 || (opts.scopes?.length ?? 0) > 0)) {
    throw cliError("INVALID_ARG", "--clear-scopes cannot be combined with --scope/--scopes");
  }
  const scopes = opts.clearScopes ? [] : normalizeScopes([...(opts.scope ?? []), ...(opts.scopes ?? [])]);
  const body = {
    clientKey,
    name: opts.name === undefined ? undefined : opts.name.trim(),
    description: opts.description === undefined ? undefined : opts.description.trim(),
    category,
    homepageUrl: opts.homepageUrl === undefined ? undefined : opts.homepageUrl.trim(),
    returnUrl: opts.redirectUrl === undefined ? undefined : opts.redirectUrl.trim(),
    agentManifestUrl: opts.agentManifestUrl === undefined ? undefined : opts.agentManifestUrl.trim(),
    scopes,
    unsafeDemoUrlOverride: opts.unsafeDemoUrlOverride === true,
  };
  if (body.name !== undefined && !body.name) throw cliError("INVALID_ARG", "--name must not be empty");
  const agentContext = ctx.loadAgentContext();
  const client = ctx.createApiClient(agentContext);
  const res = await createAgentApiSurfaceClient(client).integrations.updateApp(body);
  if (!res.ok || !res.data) {
    const code = res.status >= 500 ? "SERVER_5XX" : "INTEGRATION_APP_UPDATE_FAILED";
    throw cliError(code, res.error ?? `HTTP ${res.status}`);
  }
  const receipt = projectAppUpdateReceipt(res.data);
  if (opts.json) {
    writeJson(ctx.io, { ok: true, data: receipt });
    return;
  }
  writeText(ctx.io, adoptCliReplyText(`Integration app ${receipt.clientName} (${receipt.clientKey}) updated: ${receipt.updatedFields.join(", ")}\n`));
}

export const integrationAppUpdateCommand = defineCommand(
  {
    name: "update",
    description: "Update an app you own or administer without human approval",
    options: [
      { flags: "--client <key>", description: "App client key / OAuth client_id" },
      { flags: "--name <name>", description: "New app display name" },
      { flags: "--description <text>", description: "New description; pass an empty value to clear" },
      {
        flags: "--category <category>",
        description: `New Connected App category: ${OAUTH_CLIENT_CATEGORIES.join(", ")}`,
      },
      { flags: "--homepage-url <url>", description: "New homepage URL; pass an empty value to clear" },
      { flags: "--redirect-url <url>", description: "New OAuth redirect URL; cannot be cleared" },
      { flags: "--agent-manifest-url <url>", description: "New agent manifest URL; pass an empty value to clear" },
      {
        flags: "--scope <scope>",
        description: "Allowed scope; can be repeated or comma-separated",
        parse: (value: string, previous: string[] = []) => { previous.push(value); return previous; },
      },
      { flags: "--clear-scopes", description: "Clear the app-specific allowed scope list" },
      { flags: "--unsafe-demo-url-override", description: "Allow explicit localhost/private demo URLs" },
      { flags: "--json", description: "Emit machine-readable JSON" },
    ],
  },
  async (ctx, opts: AppUpdateOptions) => updateApp(ctx, opts),
);

type AppManageAction =
  | "share_link_get"
  | "share_link_create"
  | "share_link_revoke"
  | "request_publish"
  | "request_unpublish"
  | "clear_logo"
  | "delete";

interface AppManageOptions {
  client: string;
  expiresDays?: string;
  json?: boolean;
}

async function manageApp(
  ctx: CommandContext,
  opts: AppManageOptions,
  action: AppManageAction,
): Promise<void> {
  const clientKey = requiredTrimmed(opts.client, "--client");
  let expiresInDays: number | undefined;
  if (opts.expiresDays !== undefined) {
    expiresInDays = Number(opts.expiresDays);
    if (!Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 365) {
      throw cliError("INVALID_ARG", "--expires-days must be an integer from 1 to 365");
    }
  }
  const agentContext = ctx.loadAgentContext();
  const client = ctx.createApiClient(agentContext);
  const res = await createAgentApiSurfaceClient(client).integrations.manageApp({
    clientKey,
    action,
    expiresInDays,
  });
  if (!res.ok || !res.data) {
    const code = res.status >= 500 ? "SERVER_5XX" : "INTEGRATION_APP_MANAGE_FAILED";
    throw cliError(code, res.error ?? `HTTP ${res.status}`);
  }
  const receipt = projectAppManageReceipt(res.data);
  if (action === "share_link_create" && (!receipt.shareUrl || !receipt.link)) {
    throw cliError(
      "INTEGRATION_APP_MANAGE_FAILED",
      "Server response did not include the one-time private share URL",
    );
  }
  if (opts.json) {
    writeJson(ctx.io, { ok: true, data: receipt });
    return;
  }
  if (action === "share_link_create") {
    writeText(ctx.io, adoptCliReplyText([
      `Private share link created for ${receipt.clientName} (${receipt.clientKey})`,
      `URL: ${receipt.shareUrl}`,
      `expires: ${receipt.link?.expiresAt ?? "never"}`,
      "The URL contains a credential-like token; share it only with intended server admins.",
      "",
    ].join("\n")));
    return;
  }
  if (action === "share_link_get") {
    writeText(ctx.io, adoptCliReplyText(receipt.link
      ? `Active private share link for ${receipt.clientName} expires ${receipt.link.expiresAt ?? "never"}; regenerate it to receive a usable URL.\n`
      : `No active private share link for ${receipt.clientName} (${receipt.clientKey}).\n`));
    return;
  }
  const labels: Record<Exclude<AppManageAction, "share_link_create" | "share_link_get">, string> = {
    share_link_revoke: "Private share link revoked",
    request_publish: `Marketplace review requested (${receipt.publishStatus})`,
    request_unpublish: `Marketplace removal requested (${receipt.publishStatus})`,
    clear_logo: "App logo reset",
    delete: "Integration app deleted",
  };
  writeText(ctx.io, adoptCliReplyText(`${labels[action]} for ${receipt.clientName} (${receipt.clientKey})\n`));
}

function appManageCommand(
  name: string,
  description: string,
  action: AppManageAction,
  extraOptions: Array<{ flags: string; description: string }> = [],
) {
  return defineCommand(
    {
      name,
      description,
      options: [
        { flags: "--client <key>", description: "App client key / OAuth client_id" },
        ...extraOptions,
        { flags: "--json", description: "Emit machine-readable JSON" },
      ],
    },
    async (ctx, opts: AppManageOptions) => manageApp(ctx, opts, action),
  );
}

export const integrationAppShareLinkStatusCommand = appManageCommand(
  "share-link-status",
  "Show active private share-link metadata without revealing its token",
  "share_link_get",
);
export const integrationAppShareLinkCreateCommand = appManageCommand(
  "share-link",
  "Create or regenerate a private app share link",
  "share_link_create",
  [{ flags: "--expires-days <days>", description: "Link lifetime from 1 to 365 days (default 30)" }],
);
export const integrationAppShareLinkRevokeCommand = appManageCommand(
  "revoke-share-link",
  "Revoke the active private app share link",
  "share_link_revoke",
);
export const integrationAppRequestPublishCommand = appManageCommand(
  "request-publish",
  "Request Marketplace review for an app",
  "request_publish",
);
export const integrationAppRequestUnpublishCommand = appManageCommand(
  "request-unpublish",
  "Request Marketplace removal review for a published app",
  "request_unpublish",
);
export const integrationAppClearLogoCommand = appManageCommand(
  "clear-logo",
  "Reset an app logo to its generated fallback",
  "clear_logo",
);
export const integrationAppDeleteCommand = appManageCommand(
  "delete",
  "Delete an unpublished app and revoke its active grants",
  "delete",
);

interface AppLogoOptions {
  client: string;
  file: string;
  json?: boolean;
}

export const integrationAppLogoCommand = defineCommand(
  {
    name: "logo",
    description: "Upload or replace an app logo",
    options: [
      { flags: "--client <key>", description: "App client key / OAuth client_id" },
      { flags: "--file <path>", description: "JPEG, PNG, GIF, or WebP logo up to 5 MB" },
      { flags: "--json", description: "Emit machine-readable JSON" },
    ],
  },
  async (ctx, opts: AppLogoOptions) => {
    const clientKey = requiredTrimmed(opts.client, "--client");
    const filePath = requiredTrimmed(opts.file, "--file");
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      throw cliError("INVALID_ARG", `Logo file not found: ${filePath}`);
    }
    const size = statSync(filePath).size;
    if (size > MAX_APP_LOGO_BYTES) {
      throw cliError("INVALID_ARG", "Logo file must be 5 MB or smaller");
    }
    const mimeType = APP_LOGO_MIME_BY_EXTENSION[extname(filePath).toLowerCase()];
    if (!mimeType) {
      throw cliError("INVALID_ARG", "Logo must be JPEG, PNG, GIF, or WebP");
    }
    const form = new FormData();
    form.append("clientKey", clientKey);
    form.append("avatar", new Blob([Uint8Array.from(readFileSync(filePath))], { type: mimeType }), basename(filePath));
    const agentContext = ctx.loadAgentContext();
    const client = ctx.createApiClient(agentContext);
    const res = await createAgentApiSurfaceClient(client).integrations.updateAppLogo(form);
    if (!res.ok || !res.data) {
      const code = res.status >= 500 ? "SERVER_5XX" : "INTEGRATION_APP_LOGO_FAILED";
      throw cliError(code, res.error ?? `HTTP ${res.status}`);
    }
    const receipt = projectAppLogoReceipt(res.data);
    if (opts.json) {
      writeJson(ctx.io, { ok: true, data: receipt });
      return;
    }
    writeText(ctx.io, adoptCliReplyText(`App logo updated for ${receipt.clientName} (${receipt.clientKey}): ${receipt.logoUrl}\n`));
  },
);

interface AppQueryOptions {
  card?: string;
  client?: string;
  json?: boolean;
}

function formatAppStatus(app: AgentApiOwnedIntegrationApp): string {
  const lines = [
    `state: ${app.state}`,
    `name: ${app.name}`,
    `description: ${app.description ?? "-"}`,
    `app type: ${app.appType ?? "-"}`,
    `enabled: ${app.enabled === null || app.enabled === undefined ? "-" : app.enabled ? "yes" : "no"}`,
    ...(app.card ? [`card: ${app.card}`] : []),
    ...(app.clientKey ? [`client key: ${app.clientKey}`] : []),
    `created: ${app.createdAt}`,
    `updated: ${app.updatedAt ?? "-"}`,
    `homepage URL: ${app.homepageUrl ?? "-"}`,
    `callback URL: ${app.callbackUrl ?? "-"}`,
    `agent manifest URL: ${app.agentManifestUrl ?? "-"}`,
    `scopes: ${app.scopes.length > 0 ? app.scopes.join(", ") : "-"}`,
    `category: ${app.category ?? "-"}`,
    `data access: ${app.dataAccessSummary ?? "-"}`,
    `authority: ${app.authority ?? "-"}`,
    `publish status: ${app.publishStatus ?? "-"}`,
    `logo: ${app.logoUrl ?? "-"}`,
  ];
  if (app.recoveryCommand) {
    lines.push(`recovery: lost the secret? Run \`${app.recoveryCommand}\`; it writes a replacement only to a new private file and invalidates the previous secret`);
    lines.push("secret handling: choose a path outside Web/static/shared surfaces, pass that file directly to the authorized secret store, then remove it; the path is caller-managed after return and secret bytes are not disclosed through stdout/JSON, Raft messages or chat, logs, receipts, history, or Raft/server persistence outside the selected private file");
  }
  if (app.state === "committed" && app.clientKey) {
    lines.push(`update redirect: raft integration app update --client ${app.clientKey} --redirect-url <https-callback-url>`);
    lines.push(`transfer ownership: raft integration app transfer-owner --client ${app.clientKey} --to-agent <handle>`);
  } else if (app.state === "card_pending") {
    lines.push("next: ask a human owner/admin to commit the registration card");
  }
  return lines.join("\n");
}

async function listApps(ctx: CommandContext, opts: AppQueryOptions): Promise<void> {
  const agentContext = ctx.loadAgentContext();
  const client = ctx.createApiClient(agentContext);
  const res = await createAgentApiSurfaceClient(client).integrations.listApps();
  if (!res.ok || !res.data) {
    const code = res.status >= 500 ? "SERVER_5XX" : "INTEGRATION_APP_LIST_FAILED";
    throw cliError(code, res.error ?? `HTTP ${res.status}`);
  }
  const receipt = projectAppListReceipt(res.data);
  if (opts.json) {
    writeJson(ctx.io, { ok: true, data: receipt });
    return;
  }
  if (receipt.apps.length === 0) {
    writeText(ctx.io, adoptCliReplyText([
      "No pending registration cards or currently manageable apps.",
      "If an existing app is missing, this agent is not its owner or a server admin; ask the current owner or a server admin to transfer it with `raft integration app transfer-owner --client <client-key> --to-agent <handle>`.",
      "",
    ].join("\n")));
    return;
  }
  writeText(ctx.io, adoptCliReplyText([
    receipt.apps.map(formatAppStatus).join("\n\n"),
    "",
    "Only apps this agent may manage are shown. If another existing app is absent, ask its current owner or a server admin to transfer it, then rerun this command.",
    "",
  ].join("\n")));
}

async function getAppStatus(ctx: CommandContext, opts: AppQueryOptions): Promise<void> {
  const card = optionalTrimmed(opts.card);
  const clientKey = optionalTrimmed(opts.client);
  if (Boolean(card) === Boolean(clientKey)) {
    throw cliError("INVALID_ARG", "Exactly one of --card or --client is required");
  }
  const agentContext = ctx.loadAgentContext();
  const client = ctx.createApiClient(agentContext);
  const res = await createAgentApiSurfaceClient(client).integrations.getAppStatus({ card, client: clientKey });
  if (!res.ok || !res.data) {
    const code = res.status >= 500 ? "SERVER_5XX" : "INTEGRATION_APP_STATUS_FAILED";
    throw cliError(code, res.error ?? `HTTP ${res.status}`);
  }
  const receipt = projectAppStatusReceipt(res.data);
  if (opts.json) {
    writeJson(ctx.io, { ok: true, data: receipt });
    return;
  }
  writeText(ctx.io, adoptCliReplyText(formatAppStatus(receipt.app)), NL);
}

export const integrationAppListCommand = defineCommand(
  {
    name: "list",
    description: "List pending registrations and apps you may manage; server admins see all server-owned apps",
    options: [{ flags: "--json", description: "Emit machine-readable JSON" }],
  },
  async (ctx, opts: AppQueryOptions) => listApps(ctx, opts),
);

export const integrationAppStatusCommand = defineCommand(
  {
    name: "status",
    description: "Show one registration card or currently manageable app",
    options: [
      { flags: "--card <message-id>", description: "Registration card message id (full or 8-character prefix)" },
      { flags: "--client <key>", description: "App client key / OAuth client_id" },
      { flags: "--json", description: "Emit machine-readable JSON" },
    ],
  },
  async (ctx, opts: AppQueryOptions) => getAppStatus(ctx, opts),
);

interface AppRecoverOwnerOptions {
  client: string;
  toAgent: string;
  target: string;
  json?: boolean;
}

async function prepareRecoverOwner(ctx: CommandContext, opts: AppRecoverOwnerOptions): Promise<void> {
  const clientKey = requiredTrimmed(opts.client, "--client");
  const targetAgent = requiredTrimmed(opts.toAgent, "--to-agent");
  const target = requiredTrimmed(opts.target, "--target");
  const agentContext = ctx.loadAgentContext();
  const client = ctx.createApiClient(agentContext);
  const res = await createAgentApiSurfaceClient(client).actions.prepare({
    target,
    action: {
      type: "integration:recover_app_owner",
      clientKey,
      targetAgent,
      draftHint: `Admin recovery for orphaned or retired-owner app ${clientKey}. Execution must fail while an active owner exists.`,
    },
  });
  if (!res.ok || !res.data) {
    const code = res.status >= 500 ? "SERVER_5XX" : "INTEGRATION_APP_RECOVER_OWNER_PREPARE_FAILED";
    throw cliError(code, res.error ?? `HTTP ${res.status}`);
  }
  const receipt = projectActionPrepareReceipt(res.data);
  if (opts.json) {
    writeJson(ctx.io, { ok: true, data: receipt });
    return;
  }
  writeText(ctx.io, adoptCliReplyText(`Admin recovery card prepared for ${clientKey} → @${targetAgent}: ${receipt.messageId}\n`));
}

export const integrationAppPrepareRecoverOwnerCommand = defineCommand(
  {
    name: "recover-owner",
    description: "Prepare a human owner/admin recovery card for an orphaned or retired-owner app",
    options: [
      { flags: "--client <key>", description: "App client key / OAuth client_id" },
      { flags: "--to-agent <name>", description: "Replacement owner agent name" },
      { flags: "--target <target>", description: "Channel/DM/thread for the recovery card" },
      { flags: "--json", description: "Emit machine-readable JSON" },
    ],
  },
  async (ctx, opts: AppRecoverOwnerOptions) => prepareRecoverOwner(ctx, opts),
);

const sharedOptions = [
  { flags: "--client-key <key>", description: "Stable app client key / OAuth client_id to reserve or update; register defaults to server-generated" },
  { flags: "--name <name>", description: "App display name" },
  { flags: "--redirect-url <url>", description: "OAuth redirect/callback URL" },
  { flags: "--app-url <url>", description: "App homepage URL" },
  { flags: "--homepage-url <url>", description: "App homepage URL (alias-friendly explicit name)" },
  { flags: "--description <text>", description: "App description" },
  {
    flags: "--category <category>",
    description: `Connected App category: ${OAUTH_CLIENT_CATEGORIES.join(", ")}`,
  },
  { flags: "--agent-manifest-url <url>", description: "Optional agent behavior manifest URL" },
  {
    flags: "--scope <scope>",
    description: "Requested/displayed scope; can be repeated or comma-separated",
    parse: (value: string, previous: string[] = []) => {
      previous.push(value);
      return previous;
    },
  },
  {
    flags: "--scopes <scopes>",
    description: "Requested/displayed scopes; alias for --scope, comma-separated",
    parse: (value: string, previous: string[] = []) => {
      previous.push(value);
      return previous;
    },
  },
  { flags: "--unsafe-demo-url-override", description: "Explicitly mark localhost/private URL use as an unsafe demo override" },
  { flags: "--target <target>", description: "Channel/DM/thread target to post the human action card" },
  { flags: "--json", description: "Emit machine-readable JSON" },
];

export const integrationAppPrepareRegisterCommand = defineCommand(
  {
    name: "register",
    description: "Self-register a third-party app by preparing its server commit card; you become the app owner",
    options: sharedOptions,
  },
  async (ctx, opts: AppPrepareOptions) => prepareApp("register", ctx, opts),
);

export function registerIntegrationAppCommands(parent: Command, runtimeOptions: CommandRuntimeOptions = {}): void {
  const appCmd = parent.command("app").description("Register and manage third-party apps you own or administer");
  const prepareCmd = appCmd.command("prepare").description("Prepare app registration and owner-recovery action cards");
  registerCliCommand(prepareCmd, integrationAppPrepareRegisterCommand, runtimeOptions);
  registerCliCommand(prepareCmd, integrationAppPrepareRecoverOwnerCommand, runtimeOptions);
  registerCliCommand(appCmd, integrationAppRotateSecretCommand, runtimeOptions);
  registerCliCommand(appCmd, integrationAppTransferOwnerCommand, runtimeOptions);
  registerCliCommand(appCmd, integrationAppUpdateCommand, runtimeOptions);
  registerCliCommand(appCmd, integrationAppLogoCommand, runtimeOptions);
  registerCliCommand(appCmd, integrationAppClearLogoCommand, runtimeOptions);
  registerCliCommand(appCmd, integrationAppShareLinkCreateCommand, runtimeOptions);
  registerCliCommand(appCmd, integrationAppShareLinkStatusCommand, runtimeOptions);
  registerCliCommand(appCmd, integrationAppShareLinkRevokeCommand, runtimeOptions);
  registerCliCommand(appCmd, integrationAppRequestPublishCommand, runtimeOptions);
  registerCliCommand(appCmd, integrationAppRequestUnpublishCommand, runtimeOptions);
  registerCliCommand(appCmd, integrationAppDeleteCommand, runtimeOptions);
  registerCliCommand(appCmd, integrationAppListCommand, runtimeOptions);
  registerCliCommand(appCmd, integrationAppStatusCommand, runtimeOptions);
}
