import assert from "node:assert/strict";
import "./helpers/domSetup";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import api from "../src/api/client";
import type { ExternalInviteTracker } from "../src/analytics/externalInvites";
import { ExternalInviteSteps } from "../src/components/channel/ExternalInviteSteps";
import type { ExternalInvitePreview } from "../src/components/channel/externalInvites";
import { TestIntlProvider } from "./helpers/intl";

// Invite People Outside's review: a member of the Server is added directly,
// and with "Invite to connect their server" (checked by default) also sent an
// ordinary invite, so they can connect a server of theirs. Unchecked, they are
// only added. A member already in the channel has the checkbox too: checked,
// they are only sent the invite; the channel's own Guest has none.
const CHANNEL_ID = "channel-1";
const OUTSIDER = "lena@contoso.com";
const MEMBERS = ["sam@acme.com", "raj@acme.com"];
const PREVIEW: ExternalInvitePreview = { valid: [OUTSIDER], duplicates: [], invalid: [], alreadyPending: [], alreadyMembers: MEMBERS, slotsLeft: 28 };
const IN_CHANNEL_MEMBER = "kim@acme.com";
const OWN_GUEST = "vendor@contoso.com";
const IN_CHANNEL_PREVIEW: ExternalInvitePreview = {
  valid: [], duplicates: [], invalid: [], alreadyPending: [], alreadyMembers: [],
  alreadyInChannel: [IN_CHANNEL_MEMBER, OWN_GUEST], alreadyInChannelMembers: [IN_CHANNEL_MEMBER], guestsElsewhere: [], slotsLeft: 28,
};
const LABEL = /Invite to connect their server/;

const tracker: ExternalInviteTracker = {
  opened: () => undefined,
  reviewed: () => undefined,
  backToInput: () => undefined,
  sendSucceeded: () => undefined,
  sendFailed: () => undefined,
  closed: () => undefined,
} as unknown as ExternalInviteTracker;

function setup(preview: ExternalInvitePreview = PREVIEW) {
  vi.spyOn(api, "get").mockImplementation(async () => ({ data: { invites: [], slotsLeft: 28 } }));
  const post = vi.spyOn(api, "post").mockImplementation(async (url: string) => {
    if (url === `/channels/${CHANNEL_ID}/external-invites/preview`) return { data: preview };
    if (url === `/channels/${CHANNEL_ID}/external-invites`) {
      return { data: { sent: [], added: MEMBERS, skipped: { duplicates: [], invalid: [], alreadyPending: [], alreadyMembers: [] } } };
    }
    throw new Error(`unexpected POST ${url}`);
  });
  const onSent = vi.fn();
  render(
    <TestIntlProvider>
      <ExternalInviteSteps
        channelId={CHANNEL_ID}
        serverName="Acme"
        willBecomePrivate={false}
        dismissLabel="Cancel"
        onDismiss={() => undefined}
        onSent={onSent}
        tracker={tracker}
      />
    </TestIntlProvider>,
  );
  return { post, onSent };
}

async function review(emails: string[] = [OUTSIDER, ...MEMBERS]) {
  fireEvent.change(screen.getByTestId("external-invite-emails"), { target: { value: emails.join("\n") } });
  fireEvent.click(screen.getByTestId("external-invite-next"));
  await screen.findByTestId("external-invite-review");
}

function sentBody(post: ReturnType<typeof setup>["post"]): Record<string, unknown> {
  const call = post.mock.calls.find(([url]) => url === `/channels/${CHANNEL_ID}/external-invites`);
  assert.ok(call, "the send went out");
  return call[1] as Record<string, unknown>;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test("each member row says they are added directly and has Invite to connect, checked; the invite row has none; sending invites every checked member", async () => {
  const { post, onSent } = setup();
  await review();
  const rows = screen.getAllByTestId("external-invite-review-row");
  const memberRows = rows.filter((row) => MEMBERS.some((email) => row.textContent?.includes(email)));
  assert.equal(memberRows.length, 2);
  for (const row of memberRows) {
    assert.match(row.textContent ?? "", /Already in Acme · added directly/);
    assert.doesNotMatch(row.textContent ?? "", /no invite/, "the checkbox, not the status, says whether they are invited");
    assert.match(row.textContent ?? "", LABEL);
  }
  const outsiderRow = rows.find((row) => row.textContent?.includes(OUTSIDER));
  assert.ok(outsiderRow && !LABEL.test(outsiderRow.textContent ?? ""), "only a member's row has the checkbox");
  const boxes = screen.getAllByTestId("external-invite-connect-member");
  assert.deepEqual(boxes.map((box) => box.getAttribute("aria-checked")), ["true", "true"], "checked by default");

  await act(async () => {
    fireEvent.click(screen.getByTestId("external-invite-send"));
  });
  await waitFor(() => assert.equal(onSent.mock.calls.length, 1));
  assert.deepEqual(sentBody(post), { emails: [OUTSIDER, ...MEMBERS], connectInviteMemberEmails: MEMBERS });
});

test("an unchecked member is only added: left out of connectInviteMemberEmails, still in the send; unchecking all sends none", async () => {
  const { post, onSent } = setup();
  await review();
  const [first, second] = screen.getAllByTestId("external-invite-connect-member");
  fireEvent.click(second!);
  assert.equal(second!.getAttribute("aria-checked"), "false");
  assert.equal(first!.getAttribute("aria-checked"), "true");

  await act(async () => {
    fireEvent.click(screen.getByTestId("external-invite-send"));
  });
  await waitFor(() => assert.equal(onSent.mock.calls.length, 1));
  assert.deepEqual(sentBody(post), { emails: [OUTSIDER, ...MEMBERS], connectInviteMemberEmails: [MEMBERS[0]] });

  cleanup();
  post.mockClear();
  const again = setup();
  await review();
  for (const box of screen.getAllByTestId("external-invite-connect-member")) fireEvent.click(box);
  await act(async () => {
    fireEvent.click(screen.getByTestId("external-invite-send"));
  });
  await waitFor(() => assert.equal(again.onSent.mock.calls.length, 1));
  assert.deepEqual(sentBody(again.post), { emails: [OUTSIDER, ...MEMBERS] }, "no member invited: the field is left out");
});

test("a member already in the channel has Invite to connect their server, checked, and no \"no invite\"; sending invites them only; the channel's own Guest has no checkbox", async () => {
  const { post, onSent } = setup(IN_CHANNEL_PREVIEW);
  await review([IN_CHANNEL_MEMBER, OWN_GUEST]);
  const rows = screen.getAllByTestId("external-invite-review-row");
  const memberRow = rows.find((row) => row.textContent?.includes(IN_CHANNEL_MEMBER));
  const guestRow = rows.find((row) => row.textContent?.includes(OWN_GUEST));
  assert.ok(memberRow && guestRow);
  assert.match(memberRow.textContent ?? "", /Already in this channel/);
  assert.doesNotMatch(memberRow.textContent ?? "", /no invite/, "the checkbox, not the status, says whether they are invited");
  assert.match(memberRow.textContent ?? "", LABEL);
  assert.match(guestRow.textContent ?? "", /Already in this channel · no invite/);
  assert.doesNotMatch(guestRow.textContent ?? "", LABEL);
  const [box] = screen.getAllByTestId("external-invite-connect-member");
  assert.equal(box!.getAttribute("aria-checked"), "true", "checked by default");
  assert.ok(screen.queryByTestId("external-invite-nothing-to-send") === null, "an invite to send");

  await act(async () => {
    fireEvent.click(screen.getByTestId("external-invite-send"));
  });
  await waitFor(() => assert.equal(onSent.mock.calls.length, 1));
  assert.deepEqual(sentBody(post), { emails: [IN_CHANNEL_MEMBER], connectInviteMemberEmails: [IN_CHANNEL_MEMBER] });
});

test("unchecked, a member already in the channel leaves nothing to send", async () => {
  const { post } = setup(IN_CHANNEL_PREVIEW);
  await review([IN_CHANNEL_MEMBER, OWN_GUEST]);
  const [box] = screen.getAllByTestId("external-invite-connect-member");
  fireEvent.click(box!);
  assert.equal(box!.getAttribute("aria-checked"), "false");
  assert.ok(screen.getByTestId("external-invite-nothing-to-send"));
  assert.equal((screen.getByTestId("external-invite-send") as HTMLButtonElement).disabled, true);
  await act(async () => {
    fireEvent.click(screen.getByTestId("external-invite-send"));
  });
  assert.equal(post.mock.calls.some(([url]) => url === `/channels/${CHANNEL_ID}/external-invites`), false, "no send");
});
