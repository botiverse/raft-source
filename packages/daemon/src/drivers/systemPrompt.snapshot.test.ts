import { applyPatch, createTwoFilesPatch } from "diff";
import { getDriver } from "./index";
import { buildCliSystemPrompt } from "./systemPrompt";
import { promptConfig } from "../testing/promptFixture";

// Store shared copy once and lossless unified diffs for each real driver's output.
// These detect copy changes, not whether a model follows the instructions.
// Local runs update snapshots; review and commit the diff. CI only checks.
function commonPrompt(): string {
  return buildCliSystemPrompt(promptConfig(), {
    extraCriticalRules: [],
  });
}

async function expectVariant(name: string, prompt: string): Promise<void> {
  const common = commonPrompt();
  const patch = createTwoFilesPatch("common.md", `${name}.md`, common, prompt, undefined, undefined, { context: 0 });
  // Prove that no bytes were lost when replacing the full snapshot with a diff.
  expect(applyPatch(common, patch)).toBe(prompt);
  await expect(patch).toMatchFileSnapshot(`./__snapshots__/systemPrompt/${name}.patch`);
}

test("shared standing instructions", async () => {
  await expect(commonPrompt()).toMatchFileSnapshot("./__snapshots__/systemPrompt/common.md");
});

test.each([
  "claude", "codex", "grok", "copilot", "cursor",
  "gemini", "kimi", "kimi-sdk", "opencode", "pi", "builtin",
])("%s standing prompt (POSIX)", async (runtime) => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  try {
    Object.defineProperty(process, "platform", { value: "linux" });
    const prompt = getDriver(runtime).buildSystemPrompt(promptConfig({ runtime }), "agent-1");
    await expectVariant(runtime, prompt);
  } finally {
    Object.defineProperty(process, "platform", platform);
  }
});

test.each(["pi", "builtin"])("%s standing prompt (PowerShell)", async (runtime) => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  try {
    Object.defineProperty(process, "platform", { value: "win32" });
    const prompt = getDriver(runtime).buildSystemPrompt(promptConfig({ runtime }), "agent-1");
    await expectVariant(`${runtime}.windows`, prompt);
  } finally {
    Object.defineProperty(process, "platform", platform);
  }
});

test("configured role, context and release notice output", async () => {
  const prompt = buildCliSystemPrompt(promptConfig({
    description: "Help maintain the documentation",
    runtimeContext: {
      agentId: "agent-1",
      serverId: "server-1",
      machineId: "computer-1",
      machineName: "Example Computer",
      machineHostname: "example-host",
      machineOs: "linux x64",
      daemonVersion: "1.0.0",
      workspacePath: "/example/workspace",
    },
    runtimeProfileControl: {
      kind: "daemon_release_notice",
      key: "release-1",
      message: "Daemon updated from 1.0.0 to 1.0.1.",
    },
  }), {
    extraCriticalRules: ["- Example runtime restriction."],
  });
  await expectVariant("configured", prompt);
});

test("Artifacts app on: its commands in entry 6, no entry of its own, artifact-share out of the installed apps", async () => {
  const prompt = buildCliSystemPrompt(promptConfig({
    enabledApps: ["artifacts"],
    installedApps: [
      { name: "Raft Artifacts", description: "Versioned pages with comments.", whenToUse: "Publish a page that gets feedback.", service: "artifact-share" },
      { name: "Sentinel", description: "Watches deploys.", whenToUse: "Check a deploy.", service: "sentinel-abc" },
    ],
  }), {
    extraCriticalRules: [],
  });
  await expectVariant("artifacts-app", prompt);
});
