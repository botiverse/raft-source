import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");
const read = (path: string) => readFileSync(resolve(repoRoot, path), "utf8");

test("agent detail diagnostic text cannot squeeze identity or actions", () => {
  const source = read("src/components/agent/AgentDetailPanel.tsx");

  assert.match(source, /<div className="flex min-w-0 items-center gap-1\.5">/);
  assert.match(source, /const activityText = showDetail\s*\?\s*formatActivityText\(\s*formatMessage,\s*displayState\.activity,\s*displayState\.activityDetail,\s*displayState\.activityDetailKind,\s*\)\s*:\s*formatActivityText\(formatMessage, displayState\.activity, ""\);/);
  assert.match(source, /<span className="min-w-0 truncate text-sm text-black\/60 font-mono" title=\{activityText\}>/);
  assert.match(source, /title=\{agent\.displayName \|\| agent\.name\}/);
  assert.match(source, /subtitle=\{agent\.description && !isDeleted \? agent\.description : undefined\}/);
  assert.match(source, /titleClickProps=\{\{ title: agent\.displayName \|\| agent\.name \}\}/);
  assert.match(source, /titleSuffix=\{\s*isDeleted \? \(/);
  assert.match(source, /<span className="min-w-0 flex-1 truncate text-sm font-bold text-black" title=\{startError\}>/);
  assert.match(source, /const hasRuntimeError = activityState\?\.activity === "error" \|\| Boolean\(agent\.lastRuntimeError\);/);
  assert.match(source, /const activityErrorText = runtimeErrorKind\s*\?\s*formatMessage\(\{ id: RUNTIME_ERROR_LABEL_ID\[runtimeErrorKind\] \}\)\s*:\s*hasRuntimeError\s*\?\s*formatActivityText\(formatMessage, "error", rawRuntimeError\)\s*:\s*formatMessage\(\{ id: "activity\.status\.agentErrorFallback" \}\)/);
  assert.match(source, /const diagnosticErrorMessage = hasRuntimeError && canViewPrivateAgentSurfaces/);
  assert.match(source, /<span className="min-w-0 flex-1 line-clamp-2 break-words text-sm font-bold leading-snug text-black" title=\{canViewPrivateAgentSurfaces \? activityErrorText : activityFallbackErrorText\}>/);
  assert.match(source, /<div className="flex shrink-0 flex-wrap items-center justify-end gap-x-3 gap-y-1">/);
  assert.match(source, /<div className="min-w-0 flex-1">\s*<div className="flex min-w-0 items-center gap-2">\s*<div className="min-w-0 truncate text-lg font-bold leading-tight text-black" title=\{agent\.displayName \|\| agent\.name\}>\{agent\.displayName \|\| agent\.name\}<\/div>\s*\{!agent\.deletedAt && <AgentStatusBadge agentId=\{agent\.id\} fallbackStatus=\{agent\.status\} showDetail=\{canViewPrivateAgentSurfaces\} externalStatus=\{isExternalAgent \? panelExternalStatus : undefined\} \/>}/);
  assert.match(source, /<div className="truncate text-sm text-black\/50 font-mono" title=\{`@\$\{agent\.name\}`\}>@\{agent\.name\}<\/div>/);
});

test("activity log status rows contain long error details inside a shrinkable lane", () => {
  const source = read("src/components/agent/AgentActivityLog.tsx");

  assert.match(source, /<span className="min-w-0 flex-1 text-sm text-black">/);
  // The shrinkable lane is the resilience invariant: the secondary detail
  // stays wrapped in `ml-1.5 break-words text-black/60` inside the
  // `min-w-0 flex-1` parent. Inner content now routes through <RefText>
  // (activity ref linkification, task #266) but the lane is unchanged.
  assert.match(
    source,
    /<span className="ml-1\.5 break-words text-black\/60">\s*<RefText text=\{secondary\} \/>\s*<\/span>/,
  );
  assert.match(source, /<div className="min-w-0 flex-1 text-sm">/);
});

test("adjacent identity headers keep names shrinkable and status/action affordances fixed", () => {
  const chatPanel = read("src/components/message/ChatPanel.tsx");
  const machinePanel = read("src/components/machine/MachineDetailPanel.tsx");
  const humanPanel = read("src/components/member/HumanDetailPanel.tsx");

  assert.match(chatPanel, /<span className="min-w-0 truncate text-sm text-black\/60 font-mono" title=\{activityText\}>/);
  assert.match(chatPanel, /<span className="min-w-0 (?:flex-1 )?truncate font-bold text-black text-base leading-tight" title=\{displayName\}>\{displayName\}<\/span>/);
  assert.match(chatPanel, /title=\{isRegularChannel \? channel\.name : undefined\}/);
  assert.match(chatPanel, /const channelSubtitle =\s*isRegularChannel\s*\?\s*channel\.description \|\| undefined\s*:\s*undefined;/);
  assert.match(chatPanel, /subtitle=\{channelSubtitle\}/);

  assert.match(machinePanel, /<div className="min-w-0 truncate text-lg font-bold leading-tight text-black" title=\{machine\.name\}>\{machine\.name\}<\/div>/);
  assert.match(machinePanel, /<div className="truncate text-sm text-black\/50 font-mono" title=\{machine\.hostname\}>\{machine\.hostname\}<\/div>/);
  assert.match(machinePanel, /<span\s+className="hidden max-w-\[min\(32rem,42vw\)\] truncate align-middle text-xs font-mono text-black\/50 sm:inline-block"\s+title=\{activityText\}\s*>/);

  const humanNameHeaderIdx = humanPanel.search(
    /<div\s+className="min-w-0 truncate text-lg font-bold leading-tight text-black"\s+title=\{human\.displayName \|\| human\.name\}\s*>\s*\{human\.displayName \|\| human\.name\}\s*<\/div>/,
  );
  assert.ok(humanNameHeaderIdx >= 0, "human profile shrinkable name header anchor not found");
  assert.match(humanPanel, /className="inline-flex shrink-0 items-center px-1\.5 py-0\.5 text-\[10px\] font-bold uppercase border border-black bg-gray-300 text-black\/60"/);
});
