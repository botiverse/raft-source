// `raft integration login --service <service>` — provision/reuse Raft Agent Login.

import type { Command } from "commander";

import { defineCommand, registerCliCommand } from "../../core/command";
import type { CommandRuntimeOptions } from "../../core/context";
import { cliError } from "../../core/errors";
import { writeJson, writeText, NL } from "../../core/renderer";
import { createAgentApiSurfaceClient } from "../../agentApiPath";
import { formatIntegrationLogin, formatIntegrationMcpLoginOutcome, type IntegrationLoginResponse, type IntegrationLoginOutput } from "./_format";
import { ensureIntegrationServiceSession } from "./_session";
import { agentHandoffProtocol } from "./agentHandoffDirect";
import { loginWithAgentProof } from "./agentHandoffProof";

/** The server's answers for `login` on an MCP App that are outcomes rather than errors. */
const MCP_LOGIN_OUTCOMES: Readonly<Record<string, string>> = {
  INTEGRATION_MCP_CONNECTION_REQUESTED: "mcp_connection_requested",
  INTEGRATION_MCP_TARGET_REQUIRED: "mcp_target_required",
  INTEGRATION_MCP_APP_READY: "mcp_app_ready",
};

interface LoginOptions {
  service: string;
  scope?: string[];
  target?: string;
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

function redactSuccessfulRequestId(data: IntegrationLoginOutput): IntegrationLoginOutput {
  if (data.status === "approval_required" || data.status === "install_required") return data;
  const { requestId: _requestId, ...rest } = data;
  return rest;
}

export const integrationLoginCommand = defineCommand(
  {
    name: "login",
    description: "Provision or reuse a Raft grant and establish a service session; verify identity where the protocol supports it",
    options: [
      { flags: "--service <id>", description: "Registered service id, client id, or exact service name" },
      {
        flags: "--scope <scope>",
        description: "Requested scope; can be repeated or comma-separated",
        parse: (value, previous: string[] = []) => {
          previous.push(value);
          return previous;
        },
      },
      { flags: "--target <target>", description: "Conversation target to post a human approval card when approval is required (for an MCP App: its request card for access or a connection)" },
      { flags: "--json", description: "Emit machine-readable JSON" },
    ],
  },
  async (ctx, opts: LoginOptions) => {
    const service = opts.service?.trim() ?? "";
    if (!service) {
      throw cliError("INVALID_ARG", "--service is required");
    }
    const scopes = normalizeScopes(opts.scope);

    const agentContext = ctx.loadAgentContext();
    const client = ctx.createApiClient(agentContext);
    const api = createAgentApiSurfaceClient(client);
    const flow = await loginWithAgentProof({ api, context: agentContext, env: ctx.env, body: {
      service,
      scopes,
      target: opts.target?.trim() || undefined,
    } });
    const res = flow.result;
    if (!res.ok || !res.data) {
      // An MCP App: the server answers non-2xx (so older CLIs print its message) with an errorCode
      // naming the outcome. These three are answers, not failures.
      const mcpStatus = res.errorCode ? MCP_LOGIN_OUTCOMES[res.errorCode] : undefined;
      if (mcpStatus) {
        const message = res.error ?? mcpStatus;
        if (opts.json) {
          writeJson(ctx.io, { ok: true, data: { status: mcpStatus, type: "mcp", message } });
          return;
        }
        writeText(ctx.io, formatIntegrationMcpLoginOutcome(message), NL);
        return;
      }
      const code = res.errorCode
        ?? (res.status >= 500 ? "SERVER_5XX" : "INTEGRATION_LOGIN_FAILED");
      throw cliError(code, res.error ?? `HTTP ${res.status}`);
    }

    let data: IntegrationLoginResponse = res.data;
    agentHandoffProtocol(data.agentHandoffProtocol);
    if (data.status !== "approval_required" && data.status !== "install_required" && data.service.returnUrl) {
      const session = await ensureIntegrationServiceSession({
        login: data,
        service: data.service,
        agentContext,
        env: ctx.env,
        api,
        verifier: flow.verifier,
        refresh: true,
      }).finally(() => { if (data.agentHandoffProtocol === "v1") flow.clear(); });
      data = {
        ...data,
        session: {
          status: "stored",
          authentication: session.authentication ?? "unverified",
          source: session.source,
          path: session.sessionPath,
        },
      };
    }

    const outputData = redactSuccessfulRequestId({
      ...data,
      status: data.status === "logged_in" || data.status === "already_logged_in"
        ? "grant_active"
        : data.status,
    });
    if (opts.json) {
      writeJson(ctx.io, { ok: true, data: outputData });
      return;
    }

    writeText(ctx.io, formatIntegrationLogin(outputData), NL);
  },
);

export function registerIntegrationLoginCommand(parent: Command, runtimeOptions: CommandRuntimeOptions = {}): void {
  registerCliCommand(parent, integrationLoginCommand, runtimeOptions);
}
