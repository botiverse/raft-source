import { expect, test } from "vitest";
import { buildCliSystemPrompt, type SystemPromptOptions } from "./systemPrompt.js";
import { promptConfig } from "../testing/promptFixture.js";

const options: SystemPromptOptions = {
  extraCriticalRules: [],
};

test("display-name fallback preserves the independent mention handle", () => {
  for (const displayName of ["Display Sentinel", ""]) {
    const prompt = buildCliSystemPrompt(promptConfig({ name: "handle-sentinel", displayName }), options);
    expect(prompt).toContain(`You are "${displayName || "handle-sentinel"}"`);
    expect(prompt).toContain("`@handle-sentinel`");
    expect(prompt).not.toContain("`@Display Sentinel`");
  }
});

test("role and runtime context are optional and do not bleed between agents", () => {
  const populated = buildCliSystemPrompt(promptConfig({
    description: "role-sentinel",
    runtimeContext: {
      agentId: "agent-sentinel", serverId: "server-sentinel", machineId: "computer-sentinel",
      machineName: "name-sentinel", machineHostname: "host-sentinel", machineOs: "os-sentinel",
      daemonVersion: "version-sentinel", workspacePath: "/workspace-sentinel",
    },
  }), options);
  for (const value of ["role-sentinel", "agent-sentinel", "server-sentinel", "computer-sentinel",
    "name-sentinel", "host-sentinel", "os-sentinel", "version-sentinel", "/workspace-sentinel"]) {
    expect(populated).toContain(value);
  }

  const empty = buildCliSystemPrompt(promptConfig(), options);
  expect(empty).not.toContain("sentinel");
  expect(empty).not.toContain("## Current Runtime Context");
  expect(empty).not.toContain("## Initial role");

  const roleOnly = buildCliSystemPrompt(promptConfig({ description: "role-sentinel" }), options);
  expect(roleOnly).toContain("role-sentinel");
  expect(roleOnly).not.toContain("## Current Runtime Context");
  const contextOnly = buildCliSystemPrompt(promptConfig({
    runtimeContext: { agentId: "agent-1", serverId: "server-1", machineId: "computer-1" },
  }), options);
  expect(contextOnly).toContain("computer-1");
  expect(contextOnly).not.toContain("- Role:");
});

test.each([
  { machineName: "computer-name", machineId: "computer-id", label: "computer-name (computer-id)" },
  { machineName: "computer-name", machineId: null, label: "computer-name" },
  { machineName: null, machineId: "computer-id", label: "computer-id" },
])("computer label falls back with $machineName / $machineId", ({ machineName, machineId, label }) => {
  const prompt = buildCliSystemPrompt(promptConfig({
    runtimeContext: { agentId: "agent-1", serverId: "server-1", machineId, machineName },
  }), options);
  expect(prompt.split("\n").filter((line) => line.startsWith("- Computer:"))).toEqual([`- Computer: ${label}`]);
});

test("release notices are rendered; retired migration controls never enter standing instructions", () => {
  const release = buildCliSystemPrompt(promptConfig({
    runtimeProfileControl: { kind: "daemon_release_notice", key: "release-1", message: "release-sentinel" },
  }), options);
  expect(release.split("release-sentinel")).toHaveLength(2);
  const migration = buildCliSystemPrompt(promptConfig({
    runtimeProfileControl: { kind: "migration", key: "migration-1", message: "migration-sentinel" },
  }), options);
  expect(migration).toBe(buildCliSystemPrompt(promptConfig(), options));
});
