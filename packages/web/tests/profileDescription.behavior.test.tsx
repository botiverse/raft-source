// DOM nodes never go to node:assert as values (tests/assertionNullCompareGuard.test.ts).
// A profile description's Artifact link (the author row, the hover card) is
// drawn as the message body's chip with the Artifact's title once its summary
// answers, and as a short "Artifact" chip (never the address) while it loads
// or when the viewer can't see it (artin).
import assert from "node:assert/strict";
import "./helpers/domSetup";
import { act } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { TooltipProvider } from "@botiverse/raft-ui";
import { WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import type { ArtifactCard, ArtifactReference } from "@botiverse/raft-shared";

import { TestIntlProvider } from "./helpers/intl";
import { setArtifactSourceForTests } from "../src/apps/artifacts/artifactSource";
import { fakeArtifactSource } from "../src/apps/artifacts/fakeArtifactSource";
import type { ArtifactLinkTarget } from "../src/apps/artifacts/artifactLinks";
import { ProfileDescription } from "../src/components/message/ProfileDescription";
import { setServerFeatureFlagForTests } from "../src/store/serverFeatureFlags";
import { useServerStore } from "../src/store/serverStore";

const SERVER = "server-desc";
const ADDRESS = "https://app.raft.build/artifacts/TUCt9hmScMEdBpHaTXatxr";
const OTHER = "https://github.com/botiverse/slock";
const DESCRIPTION = `Stamp 负责人。工作清单：${ADDRESS}，代码：${OTHER}`;
const TITLE = "Stamp 工作清单";

let answer: (target: ArtifactLinkTarget) => ArtifactReference | null = () => null;

function cardOf(target: ArtifactLinkTarget): ArtifactCard {
  return {
    id: target.id, url: ADDRESS, title: TITLE, description: null, kind: "markdown",
    facts: { sizeBytes: 100, fileCount: 1 }, preview: { kind: "none" }, version: 1, pinned: false, latestVersion: 1,
    author: { kind: "agent", name: "edgar", displayName: "Edgar" } as ArtifactCard["author"],
    createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z", commentCount: 0, home: { kind: "server" },
  };
}

function mount() {
  return render(
    <TestIntlProvider>
      <MemoryRouter>
        <TooltipProvider>
          <ProfileDescription text={DESCRIPTION}>{(content) => <span data-testid="description">{content}</span>}</ProfileDescription>
        </TooltipProvider>
      </MemoryRouter>
    </TestIntlProvider>,
  );
}

beforeEach(() => {
  useServerStore.setState({ current: { id: SERVER, slug: "desc", name: "Desc" } } as never);
  act(() => setServerFeatureFlagForTests(SERVER, WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, true));
  setArtifactSourceForTests({
    ...fakeArtifactSource,
    async getMessageArtifactRefs(inText) {
      return inText.map((target) => answer(target) ?? ({ status: "unavailable" } as unknown as ArtifactReference));
    },
  });
});

afterEach(() => {
  cleanup();
  setArtifactSourceForTests(null);
});

test("an Artifact link shows its title chip once its summary answers, and other links stay as written", async () => {
  answer = (target) => ({ status: "ok", card: cardOf(target) });
  mount();
  const description = screen.getByTestId("description");
  await waitFor(() => assert.equal(description.querySelector('[data-app-link-chip="object"]') !== null, true));
  assert.equal(description.textContent?.includes(TITLE), true);
  assert.equal(description.textContent?.includes(ADDRESS), false);
  assert.equal(description.textContent?.includes(OTHER), true);
  assert.equal(description.textContent?.startsWith("Stamp 负责人。工作清单："), true);
});

test("an Artifact the viewer can't see is a gray Artifact chip, never its address", async () => {
  answer = () => null;
  mount();
  const description = screen.getByTestId("description");
  await waitFor(() => assert.equal(description.querySelector('[data-description-artifact="unavailable"]') !== null, true));
  assert.equal(description.textContent?.includes("Artifact"), true);
  assert.equal(description.textContent?.includes(ADDRESS), false);
  assert.equal(description.querySelector('[data-app-link-chip="object"]') !== null, false);
});

test("with Artifacts off the description is the author's text", () => {
  act(() => setServerFeatureFlagForTests(SERVER, WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, false));
  mount();
  assert.equal(screen.getByTestId("description").textContent, DESCRIPTION);
});

// The description's own tooltip (the text with the title for the address).
const TOOLTIP_WORDS = `Stamp 负责人。工作清单：${TITLE}，代码：${OTHER}`;
const tooltipShown = () => screen.queryAllByText(TOOLTIP_WORDS).length > 0;
const pause = (ms: number) => act(() => new Promise((resolve) => setTimeout(resolve, ms)));

async function mountResolved() {
  answer = (target) => ({ status: "ok", card: cardOf(target) });
  mount();
  const description = screen.getByTestId("description");
  await waitFor(() => assert.equal(description.querySelector('[data-app-link-chip="object"]') !== null, true));
  return { description, chip: description.querySelector<HTMLElement>('[data-app-link-chip="object"]')! };
}

test("keyboard focus on a chip opens its hover card, never the description's tooltip on top", async () => {
  const { description, chip } = await mountResolved();
  // Control: focus on the description itself opens its tooltip.
  description.tabIndex = 0;
  act(() => description.focus());
  fireEvent.focus(description);
  await waitFor(() => assert.equal(tooltipShown(), true));
  act(() => description.blur());
  fireEvent.blur(description);
  await waitFor(() => assert.equal(tooltipShown(), false));

  act(() => chip.focus());
  fireEvent.focus(chip);
  await pause(800);
  assert.equal(tooltipShown(), false);
});

test("a deleted Artifact's chip carries the author's link for share images", async () => {
  answer = () => ({ status: "deleted", title: "Old list", deletedBy: { kind: "agent", name: "edgar", displayName: "Edgar" }, deletedAt: "2026-11-01T00:00:00.000Z" } as unknown as ArtifactReference);
  mount();
  const description = screen.getByTestId("description");
  await waitFor(() => assert.equal(description.querySelector('[data-app-link-chip="deleted"]') !== null, true));
  const chip = description.querySelector('[data-app-link-chip="deleted"]');
  assert.equal(chip?.getAttribute("data-select-screenshot-author-link"), ADDRESS);
  assert.equal(description.textContent?.includes("Old list"), true);
});
