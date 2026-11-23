// DOM nodes never go to node:assert as values (tests/assertionNullCompareGuard.test.ts).
// artin: the people in an Artifact's "N viewing" list open that person, by the app's rule for a person (the
// share host's useOpenPerson, core's coreArtifactShareHost):
// - inside the server's layout, the profile panel, as a message's avatar or a mention opens it (the profile
//   store: an agent on the reader's first tab, `ordered-first`; a person with no tab intent), and the list closes;
// - the viewer's own "You" row opens their own profile, as their avatar in a message does;
// - on the Artifact's own page (`/artifacts/<id>`, no panel there), the profile's address;
// - nobody behind the actor (`gone`: a deleted account) is plain text, not a button.
import assert from "node:assert/strict";
import "./helpers/domSetup";
import { act } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { asArtifactId } from "@botiverse/raft-shared";
import type { ArtifactActor, ArtifactPresence as Presence, ArtifactViewerData } from "@botiverse/raft-shared";

import { TestIntlProvider } from "./helpers/intl";
import { ArtifactPresence } from "../src/apps/artifacts/ArtifactPresence";
import { ArtifactCommentsProvider } from "../src/apps/artifacts/ArtifactCommentsContext";
import { setArtifactShareHost } from "../src/apps/artifacts/artifactShareHost";
import { fakeArtifactSource } from "../src/apps/artifacts/fakeArtifactSource";
import { coreArtifactShareHost } from "../src/components/message/artifactShareHost";
import { useProfileStore } from "../src/store/profileStore";
import { useServerStore } from "../src/store/serverStore";

const ID = asArtifactId("pt_fake-bundle-report");
const ACME = { id: "server-acme", slug: "acme", name: "Acme" };
const kirby: ArtifactActor & { type: "agent" } = { type: "agent", id: "agent-kirby", name: "kirby", displayName: "Kirby", avatarUrl: null };
const ann: ArtifactActor = { type: "user", id: "user-ann", name: "ann", displayName: "Ann", avatarUrl: null };
const deleted: ArtifactActor = { type: "user", id: "user-gone", name: "", displayName: "", avatarUrl: null, gone: "deleted" };

const presence: Presence = {
  viewing: [{ actor: kirby, state: "reading", path: null, since: new Date().toISOString() }],
  readCurrentVersion: [
    { actor: ann, at: new Date(Date.now() - 60_000).toISOString() },
    { actor: deleted, at: new Date(Date.now() - 120_000).toISOString() },
  ],
  readOtherVersion: [],
};

let viewerData: ArtifactViewerData;

beforeAll(async () => {
  const result = await fakeArtifactSource.viewer({ id: ID, version: null });
  if (result.status !== "ok") throw new Error("the fake Artifact didn't open");
  viewerData = result.data;
});

beforeEach(() => {
  setArtifactShareHost(coreArtifactShareHost);
  useServerStore.setState({ current: { ...ACME, role: "member" } as never });
  useProfileStore.getState().closeProfile();
});

afterEach(() => {
  cleanup();
  setArtifactShareHost(null);
  useProfileStore.getState().closeProfile();
});

function Where() {
  const location = useLocation();
  return <output data-testid="where">{location.pathname}</output>;
}

function mount(path: string) {
  render(
    <TestIntlProvider>
      <MemoryRouter initialEntries={[path]}>
        <ArtifactCommentsProvider data={viewerData}>
          <ArtifactPresence presence={presence} />
        </ArtifactCommentsProvider>
        <Where />
      </MemoryRouter>
    </TestIntlProvider>,
  );
}

async function openList() {
  fireEvent.click(screen.getByTestId("artifact-presence"));
  return screen.findByTestId("artifact-presence-list");
}

function rowNamed(list: HTMLElement, name: string): HTMLElement {
  const row = within(list).getAllByTestId("artifact-presence-row").find((r) => within(r).getByTestId("artifact-presence-name").textContent === name);
  if (!row) throw new Error(`no row named ${name}`);
  return row;
}

test("an agent's row opens its profile panel, as a mention does, and closes the list", async () => {
  mount("/s/acme/channel/c1");
  const list = await openList();
  const button = within(rowNamed(list, "Kirby")).getByRole("button");
  await act(async () => { fireEvent.click(button); });
  const profile = useProfileStore.getState();
  assert.equal(profile.profileType, "agent");
  assert.equal(profile.profileId, kirby.id);
  assert.equal(profile.defaultAgentTabIntent, "ordered-first", "the reader's first tab, as a message's avatar opens it");
  await waitFor(() => assert.ok(screen.queryByTestId("artifact-presence-list") === null, "the list closes"));
  assert.equal(screen.getByTestId("where").textContent, "/s/acme/channel/c1", "the panel opens beside: no navigation");
});

test("a person's row opens their profile panel; the viewer's own row opens their own", async () => {
  mount("/s/acme/artifacts/pt_fake-bundle-report");
  let list = await openList();
  await act(async () => { fireEvent.click(within(rowNamed(list, "Ann")).getByRole("button")); });
  assert.equal(useProfileStore.getState().profileType, "human");
  assert.equal(useProfileStore.getState().profileId, ann.id);

  useProfileStore.getState().closeProfile();
  list = await openList();
  // The viewer's row is "You" (artifacts.presence.you).
  const you = within(list).getAllByTestId("artifact-presence-row").find((r) => within(r).queryByText("You"));
  if (!you) throw new Error("no You row");
  await act(async () => { fireEvent.click(within(you).getByRole("button")); });
  assert.equal(useProfileStore.getState().profileType, "human");
  assert.equal(useProfileStore.getState().profileId, viewerData.viewer.id);
});

test("on the Artifact's own page (no panel there) a row goes to the profile's address", async () => {
  mount(`/artifacts/${ID}`);
  const list = await openList();
  await act(async () => { fireEvent.click(within(rowNamed(list, "Kirby")).getByRole("button")); });
  await waitFor(() => assert.equal(screen.getByTestId("where").textContent, `/s/acme/agent/${kirby.id}`));
  assert.equal(useProfileStore.getState().profileType, null);
});

test("a row with nobody behind it (a deleted account) is plain text; so is every row when the host opens no one", async () => {
  mount("/s/acme/channel/c1");
  let list = await openList();
  const rows = within(list).getAllByTestId("artifact-presence-row");
  assert.equal(rows.length, 4, "Kirby, You, Ann and the deleted account");
  assert.equal(within(list).getAllByTestId("artifact-presence-open").length, 3);
  const gone = rows.find((r) => within(r).getByTestId("artifact-presence-name").textContent === "");
  if (!gone) throw new Error("no deleted row");
  assert.ok(within(gone).queryByRole("button") === null, "no button for a deleted account");

  cleanup();
  setArtifactShareHost(null);
  mount("/s/acme/channel/c1");
  list = await openList();
  assert.equal(within(list).queryAllByTestId("artifact-presence-open").length, 0);
});
