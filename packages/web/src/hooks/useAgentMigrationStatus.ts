import { useCallback, useEffect, useReducer, useRef } from "react";
import api from "../api/client";
import { getSocket } from "../api/socket";
import {
  EMPTY_AGENT_MIGRATION_READ_MODEL,
  applyAgentMigrationSnapshot,
  createAgentMigrationRealtimeSync,
} from "../store/agentMigrationRealtime";
import type {
  AgentMigrationReadModel,
  AgentMigrationRealtimeSync,
  AgentMigrationStatusResponse,
} from "../store/agentMigrationRealtime";

function migrationStatusError(error: unknown): { code?: string; message?: string } {
  const value = error as {
    response?: { data?: { error?: string; code?: string } };
    message?: string;
  } | null;
  return {
    code: value?.response?.data?.code,
    message: value?.response?.data?.error ?? value?.message,
  };
}

type MigrationHookState<T> = {
  agentId: string;
  model: AgentMigrationReadModel;
  error: T | null;
};

type MigrationHookAction<T> =
  | { type: "snapshot"; agentId: string; snapshot: AgentMigrationStatusResponse }
  | { type: "error"; agentId: string; error: T }
  | { type: "healthy"; agentId: string };

function migrationHookReducer<T>(
  state: MigrationHookState<T>,
  action: MigrationHookAction<T>,
): MigrationHookState<T> {
  const model = state.agentId === action.agentId
    ? state.model
    : EMPTY_AGENT_MIGRATION_READ_MODEL;
  if (action.type === "snapshot") {
    return {
      agentId: action.agentId,
      model: applyAgentMigrationSnapshot(action.snapshot),
      error: null,
    };
  }
  if (action.type === "error") {
    return { agentId: action.agentId, model, error: action.error };
  }
  return state.agentId === action.agentId && state.error
    ? { ...state, error: null }
    : state;
}

export function useAgentMigrationStatus<T>(options: {
  agentId: string;
  enabled: boolean;
  presentError: (error: { code?: string; message?: string }) => T;
}) {
  const { agentId, enabled, presentError } = options;
  const [state, dispatch] = useReducer(migrationHookReducer<T>, {
    agentId,
    model: EMPTY_AGENT_MIGRATION_READ_MODEL,
    error: null,
  });
  const syncRef = useRef<AgentMigrationRealtimeSync | null>(null);
  const model = enabled && state.agentId === agentId
    ? state.model
    : EMPTY_AGENT_MIGRATION_READ_MODEL;
  const error = enabled && state.agentId === agentId ? state.error : null;

  const refresh = useCallback(async () => {
    await syncRef.current?.refreshLatestMigration();
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const socket = getSocket();
    const sync = createAgentMigrationRealtimeSync({
      agentId,
      socket,
      readLatestMigration: async () => {
        const { data } = await api.get<AgentMigrationStatusResponse>(`/agents/${agentId}/migration`);
        return data;
      },
      applySnapshot: (snapshot) => dispatch({ type: "snapshot", agentId, snapshot }),
      onError: (nextError) => dispatch({
        type: "error",
        agentId,
        error: presentError(migrationStatusError(nextError)),
      }),
      onHealthy: () => dispatch({ type: "healthy", agentId }),
    });
    syncRef.current = sync;
    sync.start();
    return () => {
      sync.stop();
      if (syncRef.current === sync) syncRef.current = null;
    };
  }, [agentId, enabled, presentError]);

  return { model, error, refresh };
}
