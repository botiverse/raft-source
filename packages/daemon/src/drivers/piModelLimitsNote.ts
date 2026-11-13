import type { ModelLimits } from "@botiverse/raft-shared";
import type { ResourceLoader } from "@earendil-works/pi-coding-agent";
import { axSurface } from "../agentRuntimeInput";

export interface DefaultModelLimitsNoteInput {
  /** The Pi model-registry provider the session's model is registered under (e.g. `openai` for an OpenAI-compatible gateway). */
  providerId: string;
  /** The model id as registered, which is the key Pi's `modelOverrides` matches. */
  modelId: string;
  modelLimits: ModelLimits;
  /** Where the agent writes the file, as it can reach it from its workspace. */
  modelsJsonPath: string;
}

const formatTokens = (value: number): string => `${value.toLocaleString("en-US")} tokens`;

/**
 * A Built-in custom model whose context window or max output is Raft's
 * default (`raft_default`): only humans see the web warning, so the agent is
 * told which values are defaults and how it can declare the real ones. Pi
 * applies a `modelOverrides` entry of `<agentDir>/models.json` over the model
 * Raft registers; the file is read when the session's services are built, at
 * the agent's next start (a rotation reuses them), and configureBuiltIn*CustomModel
 * report such a value as `catalog`. Null when no value is a default. The ids
 * are the registry's, never a base URL, key or env value.
 */
export const formatBuiltInDefaultModelLimitsNote = axSurface(
  "Built-in Pi standing-prompt section when the session's model runs with Raft's default context window and/or max output: names the default values and how to declare the real ones in .builtin-runtime/models.json (modelOverrides), effective from the agent's next start.",
  (input: DefaultModelLimitsNoteInput): string | null => {
    const { contextWindow, maxTokens } = input.modelLimits;
    const defaults: Array<{ key: "contextWindow" | "maxTokens"; label: string; value: number }> = [];
    if (contextWindow.source === "raft_default") defaults.push({ key: "contextWindow", label: "context window", value: contextWindow.value });
    if (maxTokens.source === "raft_default") defaults.push({ key: "maxTokens", label: "max output", value: maxTokens.value });
    if (defaults.length === 0) return null;
    const values = defaults.map((field) => `${field.label} ${formatTokens(field.value)}`).join(" and ");
    // Built line by line rather than JSON.stringify + replace, so a model id
    // that happens to read `<tokens>` stays a quoted key. Ids go through
    // JSON.stringify: quotes and line breaks in them are escaped.
    const fields = defaults.map((field) => `${JSON.stringify(field.key)}: <tokens>`).join(", ");
    const example = [
      "{",
      "  \"providers\": {",
      `    ${JSON.stringify(input.providerId)}: {`,
      "      \"modelOverrides\": {",
      `        ${JSON.stringify(input.modelId)}: { ${fields} }`,
      "      }",
      "    }",
      "  }",
      "}",
    ].join("\n");
    const one = defaults.length === 1;
    return [
      "## Model limits",
      "",
      `Raft does not know ${one ? "this limit" : "these limits"} of your model, so it uses ${one ? "a default" : "defaults"}: ${values}. ${one ? "This is not the model's real limit" : "These are not the model's real limits"}.`,
      `If you know the real ${one ? "value" : "values"} (from the provider's documentation), write ${one ? "it" : "them"} to \`${input.modelsJsonPath}\` in your workspace, merging into the file if it exists:`,
      "",
      "```json",
      example,
      "```",
      "",
      "- Keep the file valid JSON: Pi ignores an invalid models.json entirely, all of its settings, not only these.",
      "- A value there also overrides the Context window or Max output tokens your owner sets in your agent settings.",
      "- It applies the next time you are started (a restart from your page in Raft, or a restart of your Computer), not in this session.",
      "",
      "If you are not sure of the values, ask your owner instead of guessing; they can also set them in your agent settings.",
    ].join("\n");
  },
  {
    examples: [
      {
        title: "both values are Raft defaults (OpenAI-compatible gateway)",
        args: [{
          providerId: "openai",
          modelId: "my-model",
          modelLimits: { contextWindow: { value: 200_000, source: "raft_default" }, maxTokens: { value: 8192, source: "raft_default" } },
          modelsJsonPath: ".builtin-runtime/models.json",
        }],
      },
      {
        title: "only max output is a Raft default (typed OpenRouter model)",
        args: [{
          providerId: "openrouter",
          modelId: "vendor/new-model",
          modelLimits: { contextWindow: { value: 131_072, source: "gateway" }, maxTokens: { value: 8192, source: "raft_default" } },
          modelsJsonPath: ".builtin-runtime/models.json",
        }],
      },
    ],
  },
);

/**
 * The session's resource loader with `section` after its system prompt. Pi's
 * loader resolves `systemPromptOverride` when the session services are built,
 * before the model is registered; the session reads `getSystemPrompt()` when
 * it is created, so a section that depends on the registered model goes here.
 */
export function withSystemPromptSection(loader: ResourceLoader, section: string): ResourceLoader {
  return {
    getExtensions: () => loader.getExtensions(),
    getSkills: () => loader.getSkills(),
    getPrompts: () => loader.getPrompts(),
    getThemes: () => loader.getThemes(),
    getAgentsFiles: () => loader.getAgentsFiles(),
    getSystemPrompt: () => {
      const base = loader.getSystemPrompt();
      return base ? `${base}\n\n${section}` : section;
    },
    getSystemPromptSource: () => loader.getSystemPromptSource(),
    getAppendSystemPrompt: () => loader.getAppendSystemPrompt(),
    getAppendSystemPromptSources: () => loader.getAppendSystemPromptSources(),
    extendResources: (paths) => loader.extendResources(paths),
    reload: (options) => loader.reload(options),
  };
}
