const AGENT_LOGIN_INVENTORY_LABELS = {
  inventory: {
    registered_agent_login_integrations: "Raft Agent Login integration inventory",
  },
  includes: {
    built_in_raft_apps: "built-in Raft apps",
    registered_services: "installed registered Agent Login services",
    active_agent_logins: "this Agent's active logins",
  },
  excludes: {
    runtime_tools: "runtime tools",
    server_managed_mcp_tools: "Server-managed MCP tools",
    computer_local_tools: "Computer-local tools",
    browser_sessions: "browser sessions",
    arbitrary_clis: "arbitrary CLIs",
  },
  absenceMeans: {
    not_listed_in_this_inventory: 'only "not listed in this inventory"',
  },
} as const;

type InventoryId = keyof typeof AGENT_LOGIN_INVENTORY_LABELS.inventory;
type IncludedCapability = keyof typeof AGENT_LOGIN_INVENTORY_LABELS.includes;
type ExcludedCapability = keyof typeof AGENT_LOGIN_INVENTORY_LABELS.excludes;
type AbsenceMeaning = keyof typeof AGENT_LOGIN_INVENTORY_LABELS.absenceMeans;

export interface AgentLoginIntegrationInventoryScope {
  inventory: InventoryId;
  includes: readonly [IncludedCapability, ...IncludedCapability[]];
  excludes: readonly [ExcludedCapability, ...ExcludedCapability[]];
  absenceMeans: AbsenceMeaning;
}

export const AGENT_LOGIN_INTEGRATION_INVENTORY_MANUAL_DOC_ID = "integration" as const;

export const AGENT_LOGIN_INTEGRATION_INVENTORY_SCOPE = {
  inventory: "registered_agent_login_integrations",
  includes: ["built_in_raft_apps", "registered_services", "active_agent_logins"],
  excludes: [
    "runtime_tools",
    "server_managed_mcp_tools",
    "computer_local_tools",
    "browser_sessions",
    "arbitrary_clis",
  ],
  absenceMeans: "not_listed_in_this_inventory",
} as const satisfies AgentLoginIntegrationInventoryScope;

function formatList(
  items: readonly [string, ...string[]],
  conjunction: "and" | "or",
): string {
  if (items.length === 1) return items[0]!;
  if (items.length === 2) return `${items[0]} ${conjunction} ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, ${conjunction} ${items.at(-1)}`;
}

function renderLabels<T extends string>(
  items: readonly [T, ...T[]],
  labels: Readonly<Record<T, string>>,
): [string, ...string[]] {
  const [first, ...rest] = items;
  return [labels[first], ...rest.map((item) => labels[item])];
}

function renderExcludedLabels(
  excluded: AgentLoginIntegrationInventoryScope["excludes"],
): [string, ...string[]] {
  const includesRuntimeTools = excluded.includes("runtime_tools");
  const includesServerManagedMcp = excluded.includes("server_managed_mcp_tools");
  const labels = excluded.flatMap((item) => {
    if (item === "server_managed_mcp_tools" && includesRuntimeTools) return [];
    if (item === "runtime_tools" && includesServerManagedMcp) {
      return ["runtime tools (including Server-managed MCP)"];
    }
    return [AGENT_LOGIN_INVENTORY_LABELS.excludes[item]];
  });

  return labels as [string, ...string[]];
}

export function projectAgentLoginIntegrationInventory(
  scope: AgentLoginIntegrationInventoryScope,
) {
  const included = renderLabels(scope.includes, AGENT_LOGIN_INVENTORY_LABELS.includes);
  const excluded = renderExcludedLabels(scope.excludes);

  return {
    observationScope: scope,
    copy: {
      heading: AGENT_LOGIN_INVENTORY_LABELS.inventory[scope.inventory],
      scope: `Scope: this command lists only ${formatList(included, "and")}.`,
      exclusion: `Not your runtime capability inventory: it does not list ${formatList(excluded, "or")}.`,
      boundary: `Interpretation: absence below means ${AGENT_LOGIN_INVENTORY_LABELS.absenceMeans[scope.absenceMeans]}; it is not evidence that the provider, data, or capability is unavailable through another surface.`,
      reference: `Canonical inventory map: \`raft manual get ${AGENT_LOGIN_INTEGRATION_INVENTORY_MANUAL_DOC_ID}\` (stable doc_id \`${AGENT_LOGIN_INTEGRATION_INVENTORY_MANUAL_DOC_ID}\`; supply the required intent and reason).`,
    },
  } as const;
}

export type AgentLoginIntegrationInventoryProjection = ReturnType<
  typeof projectAgentLoginIntegrationInventory
>;

export const AGENT_LOGIN_INTEGRATION_INVENTORY_PROJECTION =
  projectAgentLoginIntegrationInventory(AGENT_LOGIN_INTEGRATION_INVENTORY_SCOPE);
