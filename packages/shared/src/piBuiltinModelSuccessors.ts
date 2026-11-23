import removals from "./piBuiltinModels.removals.json" with { type: "json" };

type Removal = { id: string; disposition: string; replacement?: string };

const SUCCESSORS: ReadonlyMap<string, string> = new Map(
  (removals.removed as readonly Removal[])
    .filter((removal) => removal.disposition === "replaced-by" && typeof removal.replacement === "string")
    .map((removal) => [removal.id, removal.replacement as string]),
);

/**
 * The Built-in model a saved agent's retired preset model id starts on: the
 * recorded `replaced-by` successor in piBuiltinModels.removals.json, or null.
 * Agents keep the model id they were saved with, and pi-ai drops or renames
 * preset ids on upgrades; without this such an agent fails every start.
 */
export function builtInModelSuccessor(modelId: string): string | null {
  return SUCCESSORS.get(modelId) ?? null;
}
