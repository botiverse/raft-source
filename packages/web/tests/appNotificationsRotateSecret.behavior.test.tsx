import "./helpers/domSetup";

import assert from "node:assert/strict";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useCallback, useState } from "react";
import { DeveloperAppNotifications } from "../src/components/settings/AppNotificationsControls";
import type { AppNotificationSelection, AppNotificationsDeveloperState } from "../src/components/settings/AppNotificationsControls";
import { TestIntlProvider } from "./helpers/intl";
import api from "../src/api/client";

// Raft DS › Forms, "When a change takes effect": rotating the webhook signing
// secret makes the one the app holds stop working, so Rotate Secret asks first,
// as Regenerate client secret does, and only the confirmation's button rotates it.

const originalGet = api.get;
const originalPost = api.post;

afterEach(() => {
  cleanup();
  api.get = originalGet;
  api.post = originalPost;
});

const STATE: AppNotificationsDeveloperState = {
  request_revision: 1,
  current_revision_id: "revision-1",
  current_groups: [],
  current_events: [],
  pending_revision: null,
  webhook: { endpoint_url: "https://alerts.example.com/raft", config_revision: 3, enabled: true, previous_valid_until: null, updated_at: "2026-10-01T00:00:00.000Z" },
};

const NO_SELECTION: AppNotificationSelection = { groups: [], events: [] };

function Harness() {
  const [state, setState] = useState(STATE);
  const handleChange = useCallback(() => undefined, []);
  const handleError = useCallback(() => undefined, []);
  return (
    <DeveloperAppNotifications
      embedded
      clientId="client-1"
      value={NO_SELECTION}
      onChange={handleChange}
      state={state}
      loading={false}
      onStateChange={setState}
      onError={handleError}
    />
  );
}

function stubServer() {
  const rotations: string[] = [];
  api.get = (async () => ({ data: STATE })) as typeof api.get;
  api.post = (async (url: string) => {
    rotations.push(url);
    return { data: { signing_secret: "whsec-new-once" } };
  }) as typeof api.post;
  return rotations;
}

test("Rotate Secret asks first: Cancel rotates nothing; confirming rotates and shows the new secret once", async () => {
  const rotations = stubServer();
  render(<TestIntlProvider locale="en"><Harness /></TestIntlProvider>);

  fireEvent.click(await screen.findByTestId("app-notifications-rotate-secret"));
  const dialog = await screen.findByRole("dialog", { name: "Rotate signing secret?" });
  assert.ok(dialog.textContent?.includes("The current signing secret will stop working immediately"));
  assert.deepEqual(rotations, [], "nothing rotates before the confirmation");

  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => assert.ok(screen.queryByTestId("app-notifications-rotate-secret-confirm") === null));
  assert.deepEqual(rotations, [], "Cancel rotates nothing");
  assert.ok(screen.queryByTestId("app-notifications-secret-reveal") === null);

  fireEvent.click(screen.getByTestId("app-notifications-rotate-secret"));
  fireEvent.click(await screen.findByTestId("app-notifications-rotate-secret-confirm"));
  await waitFor(() => assert.deepEqual(rotations, ["/integrations/clients/client-1/app-notifications/webhook/rotate-secret"]));
  await waitFor(() => assert.ok(screen.getByTestId("app-notifications-secret").textContent?.includes("whsec-new-once")));
  // The banner says it is shown once (its title); the secret is data under it, not in the banner's message.
  assert.ok(!screen.getByTestId("app-notifications-secret-reveal").textContent?.includes("whsec-new-once"), "not inside the banner");
  assert.ok(screen.getByTestId("app-notifications-secret-value").textContent?.includes("whsec-new-once"));
  await waitFor(() => assert.ok(screen.queryByTestId("app-notifications-rotate-secret-confirm") === null, "the confirmation closes"));
});
