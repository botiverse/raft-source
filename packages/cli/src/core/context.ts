import { ApiClient } from "../client.js";
import {
  AgentBootstrapError,
  loadAgentContext,
  type AgentContext,
} from "../auth/env.js";
import type { CliIo } from "./io.js";
import { defaultCliIo } from "./io.js";
import { CliError, type CliErrorCode } from "./errors.js";

export interface CommandContext {
  io: CliIo;
  env: NodeJS.ProcessEnv;
  loadAgentContext(): AgentContext;
  createApiClient(agentContext: AgentContext): ApiClient;
}

export interface CommandRuntimeOptions {
  io?: CliIo;
  env?: NodeJS.ProcessEnv;
  loadAgentContext?: (env?: NodeJS.ProcessEnv) => AgentContext;
  createApiClient?: (agentContext: AgentContext) => ApiClient;
}

function bootstrapSuggestedNextAction(code: string): string | undefined {
  switch (code) {
    case "MISSING_AGENT_ID":
    case "MISSING_SERVER_URL":
    case "MISSING_TOKEN":
      return "Use a Raft profile with `raft --profile <slug> ...`; create one with `raft agent login --server <server-url> --agent <agent-id> --profile-slug <slug>`.";
    case "PROFILE_FILE_UNREADABLE":
    case "PROFILE_FILE_INVALID":
      return "Check the selected Raft profile, or recreate it with `raft agent login --server <server-url> --agent <agent-id> --profile-slug <slug>`.";
    case "TOKEN_FILE_UNREADABLE":
    case "TOKEN_FILE_EMPTY":
      return "Check the daemon-injected token file, or restart the Raft daemon so it can inject a fresh credential.";
    case "MISSING_AGENT_PROXY_URL":
    case "MISSING_AGENT_PROXY_TOKEN":
    case "MULTIPLE_AGENT_PROXY_TOKENS":
      return "Restart the Raft daemon so it can inject a complete local proxy environment, or remove the partial proxy env vars before retrying.";
    default:
      return undefined;
  }
}

export function createCommandContext(options: CommandRuntimeOptions = {}): CommandContext {
  const io = options.io ?? defaultCliIo();
  const env = options.env ?? process.env;
  const loadContext = options.loadAgentContext ?? loadAgentContext;
  const createApiClient = options.createApiClient ?? ((agentContext: AgentContext) => new ApiClient(agentContext));
  return {
    io,
    env,
    loadAgentContext() {
      try {
        return loadContext(env);
      } catch (err) {
        if (err instanceof AgentBootstrapError) {
          throw new CliError({
            code: err.code as CliErrorCode,
            message: err.message,
            cause: err,
            suggestedNextAction: bootstrapSuggestedNextAction(err.code),
          });
        }
        throw err;
      }
    },
    createApiClient,
  };
}
