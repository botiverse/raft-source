/**
 * `raft agent list --server <url>` — discovery primitive for the
 * external agent flow. Drives a device-code grant to authenticate
 * the human, then returns the agents the resulting user session has
 * credential-management authority on across that server (and any other servers the user
 * is a member of).
 *
 * The output is **agent-readable**, not human-readable: `raft` CLI is
 * for AGENTS, not direct human use (xxchan msg=3e8330a3). The calling
 * agent reads the list, asks the human via natural-language
 * conversation in its own surface (Raft DM, chat, etc.) which agent
 * to bind, then runs `raft agent login --agent <id>` with the chosen
 * id.
 *
 * Server returns `{ agents, reason, manageable_server_count }` —
 * stable machine-readable fields, no CLI-specific copy. This command
 * maps `reason` to a CLI-shaped `suggested_next_action` via
 * `describeListResult(...)`, same layer as `login.ts:describeMintError(...)`.
 * Per @xxchan #wg-self-hosted-agent msg=4acca4ce + @Hao msg=27f60c48:
 * server API must not own client-facing next-action copy.
 *
 * This command does NOT mint any `sk_agent_*` — it's strictly a read.
 * The user session it acquires is short-lived and discarded after the
 * single list call.
 */

import { writeDiagnostic } from "../../core/renderer.js";
import { formatVerificationHandoff } from "./_format.js";
import type { Command } from "commander";
import { fetch as undiciFetch } from "undici";

import {
  DeviceCodeLoginError,
  runDeviceCodeLogin,
} from "../../agentLogin/deviceAuthClient.js";
import { canInstallEnterToOpenUrl, installEnterToOpenUrl } from "../../core/browserHandoff.js";
import { defineCommand, registerCliCommand } from "../../core/command.js";
import type { CommandRuntimeOptions } from "../../core/context.js";
import { cliError } from "../../core/errors.js";
import { writeJson } from "../../core/renderer.js";

interface ManageableAgent {
  id: string;
  name: string;
  displayName: string | null;
  description: string | null;
  serverId: string;
  serverName: string | null;
}

export type ListReason = "ok" | "no_manageable_server" | "no_agents_on_manageable_servers";

interface ListResponse {
  ok: boolean;
  data?: {
    agents: ManageableAgent[];
    reason?: ListReason;
    manageable_server_count?: number;
  };
}

/**
 * Map server-side stable `reason` to CLI-shaped guidance copy. Server
 * MUST stay copy-free; this function owns the CLI's next-action text.
 * Same layer as `login.ts:describeMintError(...)`.
 */
export function describeListResult(
  reason: ListReason,
  serverUrl: string,
): string {
  switch (reason) {
    case "ok":
      return `Ask the user which agent to bind to this machine, then run \`raft agent login --server ${serverUrl} --agent <id>\` with the selected agent id.`;
    case "no_manageable_server":
      return "You are logged in but don't have `issueAgentCredentials` or creator authority for any agent on your servers. Ask a server owner or admin for access, then rerun `raft agent list`.";
    case "no_agents_on_manageable_servers":
      return "You have `issueAgentCredentials` on at least one server, but no agents exist on those servers yet. Ask the user to create an agent first (via web UI), then rerun `raft agent list`.";
  }
}

export const agentListCommand = defineCommand(
  {
    name: "list",
    description: "List Raft agents the user can mint credentials for (after a device-code login).",
    options: [
      { flags: "--server <url>", description: "Raft server base URL, e.g. https://app.raft.build" },
      { flags: "--client-name <label>", description: "Human-readable label shown on the web approval page" },
    ],
  },
  async (ctx, options: { server: string; clientName?: string }) => {
      if (!options.server?.trim()) {
        throw cliError("INVALID_ARG", "--server is required");
      }
      let userSession: { accessToken: string };
      let cleanupEnterToOpen: (() => void) | undefined;
      try {
        userSession = await runDeviceCodeLogin({
          serverUrl: options.server,
          ...(options.clientName ? { clientName: options.clientName } : {}),
          onUserAction: (action) => {
            const enterOpensBrowser = canInstallEnterToOpenUrl(ctx.io.stdin);
            writeDiagnostic(ctx.io, formatVerificationHandoff(action, { enterOpensBrowser }));
            if (enterOpensBrowser) {
              cleanupEnterToOpen = installEnterToOpenUrl({ input: ctx.io.stdin, url: action.verificationUriComplete ?? action.verificationUri });
            }
          },
        });
      } catch (err) {
        if (err instanceof DeviceCodeLoginError) {
          throw cliError(err.code, err.message, { cause: err });
        }
        throw err;
      } finally {
        cleanupEnterToOpen?.();
      }

      const res = await undiciFetch(
        `${options.server.replace(/\/+$/, "")}/api/agents/manageable`,
        {
          method: "GET",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${userSession.accessToken}`,
          },
        },
      );
      if (!res.ok) {
        let body: { code?: string; error?: string } | null = null;
        try {
          body = (await res.json()) as { code?: string; error?: string };
        } catch {
          /* fall through */
        }
        throw cliError(
          body?.code ?? `list_failed_${res.status}`,
          body?.error ?? `Failed to list manageable agents (status ${res.status}).`,
        );
      }

      const payload = (await res.json()) as ListResponse;
      const agents = payload.data?.agents ?? [];
      const reason: ListReason = payload.data?.reason
        ?? (agents.length > 0 ? "ok" : "no_agents_on_manageable_servers");
      const suggestedNextAction = describeListResult(reason, options.server);

      writeJson(ctx.io, {
        ok: true,
        data: {
          agents,
          reason,
          ...(typeof payload.data?.manageable_server_count === "number"
            ? { manageable_server_count: payload.data.manageable_server_count }
            : {}),
          suggested_next_action: suggestedNextAction,
        },
      });
  },
);

export function registerAgentListCommand(parent: Command, runtimeOptions: CommandRuntimeOptions = {}): void {
  registerCliCommand(parent, agentListCommand, runtimeOptions);
}
