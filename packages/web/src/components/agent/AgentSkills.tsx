import { Badge, Button, Card, InlineCode, PanelScrollViewport, TextLink, ScrollArea } from "@botiverse/raft-ui";
import { useState, useEffect, useCallback } from "react";
import { ChevronDown, ChevronRight, Globe, FolderOpen, RefreshCw } from "lucide-react";
import { useIntl } from "react-intl";
import apiClient from "../../api/client";
import type { SkillInfo } from "@botiverse/raft-shared";
import SectionHeader from "../ui/SectionHeader";

interface SkillsData {
  global: SkillInfo[];
  workspace: SkillInfo[];
  /**
   * Additive (older servers send none: ok). stale: the Computer did not answer
   * in time and this is its last list; unavailable: no list in time.
   */
  state: "ok" | "stale" | "unavailable";
}

function parseSkillsData(payload: unknown): SkillsData {
  const body = payload && typeof payload === "object" ? payload as Partial<Record<keyof SkillsData, unknown>> : {};
  return {
    global: Array.isArray(body.global) ? body.global as SkillInfo[] : [],
    workspace: Array.isArray(body.workspace) ? body.workspace as SkillInfo[] : [],
    state: body.state === "stale" || body.state === "unavailable" ? body.state : "ok",
  };
}

const EMPTY_SKILLS: SkillInfo[] = [];

/**
 * One line per skill (name, `/command` badge, truncated description); clicking
 * expands the full description. Agents commonly carry dozens of skills, and the
 * old one-card-per-skill layout ran to several screens (xxchan, 2026-10-15).
 */
function SkillRow({ skill }: { skill: SkillInfo }) {
  const [open, setOpen] = useState(false);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="block w-full px-3 py-2 text-left hover:bg-fill-subtle"
      >
        <span className="flex min-w-0 items-center gap-2">
          <Chevron size={14} className="shrink-0 text-foreground-hint" />
          <span className="shrink-0 text-callout font-semibold text-foreground">{skill.displayName}</span>
          {skill.userInvocable && (
            <Badge appearance="outline" className="shrink-0">
              /{skill.name}
            </Badge>
          )}
          {!open && skill.description && (
            <span className="truncate text-caption text-foreground-muted">{skill.description}</span>
          )}
        </span>
        {open && skill.description && (
          <span className="mt-1 block pl-[22px] text-caption text-foreground-muted">{skill.description}</span>
        )}
      </button>
    </li>
  );
}

function groupByPath(skills: SkillInfo[]): Map<string, SkillInfo[]> {
  const groups = new Map<string, SkillInfo[]>();
  for (const skill of skills) {
    const key = skill.sourcePath || "unknown";
    const list = groups.get(key) || [];
    list.push(skill);
    groups.set(key, list);
  }
  return groups;
}

function PathGroup({ path, skills }: { path: string; skills: SkillInfo[] }) {
  return (
    <div>
      <div className="mb-2 flex min-w-0 items-center gap-2">
        <InlineCode className="min-w-0 text-mono-meta text-foreground-hint">{path}</InlineCode>
        <span className="shrink-0 font-mono text-mono-meta text-foreground-hint">({skills.length})</span>
      </div>
      {/* Fixed-height box that scrolls on its own, so a long list does not
          stretch the profile page (about ten rows visible). The Card is the
          frame (max height, border, rounded clip); the rows scroll in a
          raft-ui ScrollArea that fills it. Each row is a button, so the area
          is no tab stop; it sits in the profile's scroller, so a scroll at
          its end carries on to the page. */}
      <Card data-testid="agent-skills-list" className="max-h-80">
        <ScrollArea tabIndex={-1} overscroll="auto" className="min-h-0 flex-1">
          <ul className="rule-y rule-line-hairline">
            {skills.map((skill) => (
              <SkillRow key={skill.name} skill={skill} />
            ))}
          </ul>
        </ScrollArea>
      </Card>
    </div>
  );
}

function SkillSubSection({ label, icon: Icon, skills, emptyText }: {
  label: string;
  icon: typeof Globe;
  skills: SkillInfo[];
  emptyText: string;
}) {
  const groups = groupByPath(skills);

  return (
    <div>
      <div className="mb-2 flex items-center gap-1.5">
        <Icon size={14} className="shrink-0 text-foreground-muted" />
        <span className="text-footnote font-semibold text-foreground-muted">
          {label}
        </span>
        <span className="font-mono text-mono-meta text-foreground-hint">({skills.length})</span>
      </div>
      {skills.length > 0 ? (
        <div className="stack-y-4">
          {[...groups.entries()].map(([path, pathSkills]) => (
            <PathGroup key={path} path={path} skills={pathSkills} />
          ))}
        </div>
      ) : (
        <p className="text-caption text-foreground-hint">{emptyText}</p>
      )}
    </div>
  );
}

export default function AgentSkills({ agentId, embedded }: { agentId: string; embedded?: boolean }) {
  const { formatMessage } = useIntl();
  const [data, setData] = useState<SkillsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const fetchSkills = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      const res = await apiClient.get<unknown>(`/agents/${agentId}/skills`);
      setData(parseSkillsData(res.data));
    } catch {
      // The server's error text is English diagnostics, never shown as copy.
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  // Async-loader pattern: `loading` is a transient async-fetch indicator, not
  // prop-derived state. Same FP family as AgentDetailPanel L228.
  useEffect(() => {
    // oxlint-disable-next-line react-doctor/no-derived-state
    fetchSkills();
  }, [fetchSkills]);

  if (loading) {
    return (
      <div className={embedded ? "px-(--surface-inset) py-4" : "flex flex-1 items-center justify-center bg-layer-canvas"}>
        <span className="text-callout text-foreground-hint">{formatMessage({ id: "agent.skills.loading" })}</span>
      </div>
    );
  }

  const unavailable = !failed && data?.state === "unavailable";
  if (failed || unavailable) {
    return (
      <div className={embedded ? "px-(--surface-inset) py-4 flex flex-col items-center gap-3" : "flex flex-1 flex-col items-center justify-center gap-3 bg-layer-canvas"}>
        <span className="text-footnote font-semibold text-warning-strong" data-testid="agent-skills-error">
          {formatMessage({ id: unavailable ? "agent.skills.unavailable" : "agent.skills.loadFailed" })}
        </span>
        <Button variant="outline" size="md" onClick={fetchSkills}>
          <RefreshCw size={16} />
          {formatMessage({ id: "agent.skills.retry" })}
        </Button>
      </div>
    );
  }

  const totalSkills = (data?.global?.length || 0) + (data?.workspace?.length || 0);

  const body = (
    <div className="px-(--surface-inset) py-4">
      {/* Same header + count format as the other profile sections; when there
          are no skills at all, the header's 0 is the whole section. */}
      <SectionHeader
        className={totalSkills > 0 || data?.state === "stale" ? "mb-3" : undefined}
        label={formatMessage({ id: "agent.skills.heading" })}
        count={totalSkills}
      />
      {data?.state === "stale" && (
        <p
          className="mb-3 border-l border-line-hairline pl-2 text-caption text-foreground-muted"
          data-testid="agent-skills-stale"
        >
          {formatMessage({ id: "agent.skills.stale" })}
          {" "}
          <TextLink variant="strong" type="button" onClick={fetchSkills}>
            {formatMessage({ id: "agent.skills.retry" })}
          </TextLink>
        </p>
      )}
      {totalSkills > 0 && (
      <div className="stack-y-4">
        <SkillSubSection
          label={formatMessage({ id: "agent.skills.global" })}
          icon={Globe}
          skills={data?.global || EMPTY_SKILLS}
          emptyText={formatMessage({ id: "agent.skills.globalEmpty" })}
        />
        <SkillSubSection
          label={formatMessage({ id: "agent.skills.workspace" })}
          icon={FolderOpen}
          skills={data?.workspace || EMPTY_SKILLS}
          emptyText={formatMessage({ id: "agent.skills.workspaceEmpty" })}
        />
      </div>
      )}
    </div>
  );

  // Embedded in the profile, it scrolls with the profile; on its own it is the
  // panel's one scroller (raft-ui PanelScrollViewport).
  return embedded ? <div>{body}</div> : <PanelScrollViewport className="flex-1 bg-layer-canvas">{body}</PanelScrollViewport>;
}
