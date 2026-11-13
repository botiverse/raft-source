// [wiring] AgentConfig.enabledApps reaches the CLI guide builder as the Server
// sent it; an older Server's config (no enabledApps) builds the guide from the
// booleans alone, exactly as before. The guide's rendering of the list is
// raftCliGuideFirstPartyApps.test.ts's.
import type { BuildRaftCliGuideSectionsOptions } from "./raftCliGuide";
import { buildCliSystemPrompt } from "./systemPrompt";
import { promptConfig } from "../testing/promptFixture";

const captured = vi.hoisted(() => [] as BuildRaftCliGuideSectionsOptions[]);

vi.mock("./raftCliGuide", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./raftCliGuide")>();
  return {
    ...actual,
    buildRaftCliGuideSections: (options: BuildRaftCliGuideSectionsOptions) => {
      captured.push(options);
      return actual.buildRaftCliGuideSections(options);
    },
  };
});

function guideOptions(config: Parameters<typeof promptConfig>[0]): BuildRaftCliGuideSectionsOptions {
  captured.length = 0;
  buildCliSystemPrompt(promptConfig(config), { extraCriticalRules: [] });
  expect(captured).toHaveLength(1);
  return captured[0]!;
}

test("enabledApps present: the guide gets the Server's list, beside the booleans", () => {
  const options = guideOptions({ enabledApps: ["future-app", "artifacts"], reminderApp: true });
  expect(options.enabledApps).toEqual(["future-app", "artifacts"]);
  expect(options.reminderApp).toBe(true);
  expect(options.vaultApp).toBe(false);
});

test("enabledApps absent (older Server): no apps, and the booleans still drive the Reminder and Vault text", () => {
  const options = guideOptions({ reminderApp: true, vaultApp: true });
  expect(options.enabledApps).toEqual([]);
  expect(options.reminderApp).toBe(true);
  expect(options.vaultApp).toBe(true);

  const older = buildCliSystemPrompt(promptConfig({ reminderApp: true, vaultApp: true }), { extraCriticalRules: [] });
  expect(older).toContain("Reminders on this Server live in the Reminder app.");
  expect(older).toContain("ask for access through the Vault app");
  expect(buildCliSystemPrompt(promptConfig({ reminderApp: true, vaultApp: true, enabledApps: [] }), { extraCriticalRules: [] })).toBe(older);
});
