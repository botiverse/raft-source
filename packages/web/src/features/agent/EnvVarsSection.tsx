import { Button, TextLink } from "@botiverse/raft-ui";
import Tooltip from "../../components/ui/Tooltip";
import { useState, useCallback, useEffect } from "react";
import { useIntl } from "react-intl";
import { Pencil, Plus } from "lucide-react";
import { useAgentStore } from "../../store/agentStore";
import type { Agent } from "../../store/agentStore";
import SectionEyebrow from "../../components/ui/SectionEyebrow";
import { EnvVarEntryRow } from "../../components/agent/EnvVarEntryRow";
import type { EnvVarEntry } from "../../components/agent/EnvVarEntryRow";
import { INFO_ICON_BUTTON_CLASS } from "./agentDetailClassNames";
import { holdReload } from "../../utils/reloadHolds";

// Editable environment variables section
export function EnvVarsSection({ agent, canManageAgent }: { agent: Agent; canManageAgent: boolean }) {
  const { formatMessage } = useIntl();
  const updateAgent = useAgentStore((s) => s.updateAgent);
  const [editing, setEditing] = useState(false);
  const [entries, setEntries] = useState<EnvVarEntry[]>([]);
  // Being edited (not saved anywhere until Save): no silent reload onto a new Web version (utils/reloadSafety).
  useEffect(() => (editing ? holdReload() : undefined), [editing]);

  const envVars = agent.envVars;
  const hasVars = envVars && Object.keys(envVars).length > 0;

  const startEditing = () => {
    setEntries(
      envVars
        ? Object.entries(envVars).map(([key, value]) => ({ key, value }))
        : []
    );
    setEditing(true);
  };

  const handleSave = useCallback(async () => {
    const newVars: Record<string, string> = {};
    for (const entry of entries) {
      const k = entry.key.trim();
      if (k) newVars[k] = entry.value;
    }
    await updateAgent(agent.id, {
      envVars: Object.keys(newVars).length > 0 ? newVars : null,
    });
    setEditing(false);
  }, [entries, updateAgent, agent.id]);
  const cancelEditing = useCallback(() => setEditing(false), []);
  const addEntry = useCallback(() => setEntries((current) => [...current, { key: "", value: "" }]), []);
  const updateEntry = useCallback((index: number, patch: Partial<EnvVarEntry>) => {
    setEntries((current) => current.map((entry, j) => (j === index ? { ...entry, ...patch } : entry)));
  }, []);
  const removeEntry = useCallback((index: number) => {
    setEntries((current) => current.filter((_, j) => j !== index));
  }, []);

  if (!hasVars && !canManageAgent) return null;

  return (
    <div className="w-full">
      <div className="flex items-center gap-2 mb-1">
        <SectionEyebrow as="div">
          {formatMessage({ id: "agent.runtimeConfig.envVars" })}
        </SectionEyebrow>
        {canManageAgent && !editing && (
          <Tooltip content={formatMessage({ id: "agent.detail.editEnvironmentVariables" })}>
            <button
              type="button"
              aria-label={formatMessage({ id: "agent.detail.editEnvironmentVariables" })}
              onClick={startEditing}
              className={INFO_ICON_BUTTON_CLASS}
            >
              <Pencil size={14} />
            </button>
          </Tooltip>
        )}
      </div>
      {editing ? (
        <div className="stack-y-2">
          {entries.map((entry, i) => (
            <EnvVarEntryRow key={i} index={i} entry={entry} onChange={updateEntry} onRemove={removeEntry} />
          ))}
          <div className="flex items-center gap-2">
            <TextLink
              onClick={addEntry}
              className="flex items-center gap-1 text-footnote"
            >
              <Plus size={14} />
              {formatMessage({ id: "agent.runtimeConfig.addVariable" })}
            </TextLink>
          </div>
          <div className="flex items-center gap-1.5">
            <Button variant="ghost" size="md"
              onClick={cancelEditing}
            >
              {formatMessage({ id: "common.confirm.cancel" })}
            </Button>
            <Button variant="accent" size="md"
              onClick={handleSave}
            >
              {formatMessage({ id: "machine.detail.save" })}
            </Button>
          </div>
        </div>
      ) : hasVars ? (
        <div className="flex flex-wrap gap-2">
          {Object.entries(envVars!).map(([key, value]) => (
            <Tooltip key={key} content={`${key}=${value}`}>
            <span
              className="inline-block rounded-sticker bg-fill-muted px-1.5 py-0.5 font-mono text-mono-meta text-foreground"
            >
              {key}=<span className="text-foreground-hint">{"•".repeat(Math.min(value.length, 8))}</span>
            </span>
            </Tooltip>
          ))}
        </div>
      ) : (
        <p className="text-caption text-foreground-hint">
          {formatMessage({ id: "agent.detail.noEnvironmentVariables" })}
        </p>
      )}
    </div>
  );
}
