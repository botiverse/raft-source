import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act } from "react";
import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react";
import { TestIntlProvider } from "./helpers/intl";
const render: typeof rtlRender = (ui, options) => rtlRender(ui, { wrapper: TestIntlProvider, ...options });
import { MemoryRouter } from "react-router-dom";
import api from "../src/api/client";
import MessageInput, { clearDraftPendingFilesForTests } from "../src/components/message/MessageInput";
import { resetAttachmentUploadLimitForTests } from "../src/utils/attachmentUploadLimit";
import { useAuthStore } from "../src/store/authStore";
import { useChannelStore } from "../src/store/channelStore";
import { useMessageStore } from "../src/store/messageStore";
import { useServerStore } from "../src/store/serverStore";

const CHANNEL_ID = "channel-server-owned-limit";
const originalApiGet = api.get;
const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

/**
 * The composer must take its ceiling from the server and nothing else.
 *
 * Every case here puts the store on the **Pro** plan while the server serves a
 * *lower* effective ceiling — which is the real production shape, because the
 * legacy transport caps at `min(plan, threshold, 90 MiB)`. Any implementation
 * that reads the plan instead of the served value passes files it should reject
 * and prints the wrong number, which is exactly the defect these tests exist to
 * prevent from returning.
 */

const SERVED_LIMIT_BYTES = 90 * 1024 * 1024;

function setupStores() {
  useAuthStore.setState({
    user: {
      id: "user-1",
      email: "user-1@example.com",
      gravatarHash: "",
      name: "user-1",
      displayName: "User 1",
      description: null,
      avatarUrl: null,
      emailVerified: true,
      preferredLanguage: null,
      preferredTimezone: null,
      autoTranslationEnabled: false,
      preferredTranslationMode: "manual" as const,
      preferredTranslationDisplay: "translated" as const,
      preferredTimeFormat: null,
      preferredMessageBodyFontSize: null,
      referralSource: null,
      referralSourceOther: null,
      referralSourceSkippedAt: null,
    },
  } as never);
  useServerStore.setState({
    current: {
      id: "server-1",
      name: "Server",
      slug: "server",
      ownerId: "user-1",
      onboardingAgentId: null,
      hideHumansFromMembers: false,
      // Deliberately the most generous plan: if the composer ever consults the
      // plan again, these tests go red.
      plan: "pro",
      planDowngradedAt: null,
      role: "owner",
      createdAt: "2026-07-09T00:00:00.000Z",
    },
    members: [],
  } as never);
  useChannelStore.setState({
    channels: [{
      id: CHANNEL_ID,
      serverId: "server-1",
      name: "general",
      type: "regular",
      description: null,
      archived: false,
      archivedAt: null,
      archivedBy: null,
      isDefault: false,
      createdAt: "2026-07-09T00:00:00.000Z",
    }],
    dmChannels: [],
  } as never);
  useMessageStore.setState({
    drafts: {},
    channelMessages: { [CHANNEL_ID]: [] },
    currentChannelId: CHANNEL_ID,
    messages: [],
    sendMessage: async () => ({ messageId: "message-1", pendingMentionActions: [], unresolvedMentionHandles: [] }),
  } as never);
}

function stubApi(capability: { maxBytes: number } | Error) {
  const state = { capability };
  api.get = (async (url: string) => {
    if (url === "/attachments/upload-capabilities") {
      if (state.capability instanceof Error) throw state.capability;
      return { data: { directUploadEnabled: false, directUploadThresholdBytes: null, sessionExpiresInSeconds: null, ...state.capability } };
    }
    return { data: { agents: [], humans: [] } };
  }) as typeof api.get;
  return state;
}

function deferCapability() {
  type CapabilityResponse = {
    data: {
      directUploadEnabled: false;
      directUploadThresholdBytes: null;
      sessionExpiresInSeconds: null;
      maxBytes: number;
    };
  };
  let finish: (value: CapabilityResponse) => void = () => {};
  api.get = (async (url: string) => {
    if (url === "/attachments/upload-capabilities") {
      return await new Promise<CapabilityResponse>((resolve) => {
        finish = resolve;
      });
    }
    return { data: { agents: [], humans: [] } };
  }) as typeof api.get;
  return (maxBytes = SERVED_LIMIT_BYTES) => finish({
    data: {
      directUploadEnabled: false,
      directUploadThresholdBytes: null,
      sessionExpiresInSeconds: null,
      maxBytes,
    },
  });
}

// `resolveChannelId` keeps accepted files in the "queued" state instead of
// starting a real upload. These tests are about the selection gate, and letting
// an upload start would drag in the legacy 60s idle timer.
function mountComposer() {
  const view = render(
    <MemoryRouter>
      <MessageInput
        channelId={CHANNEL_ID}
        channelName="#general"
        variant="full"
        resolveChannelId={async () => CHANNEL_ID}
      />
    </MemoryRouter>,
  );
  const fileInput = view.container.querySelector('input[type="file"][accept]') as HTMLInputElement;
  assert.ok(fileInput, "media picker input should render");
  return { view, fileInput };
}

function bigFile(size: number, name = "big.png", type = "image/png") {
  const file = new File(["x"], name, { type });
  Object.defineProperty(file, "size", { value: size });
  return file;
}

// Accepted-file cases deliberately use a non-image type. An accepted image gets
// an object-URL preview and a dimension read, which never settles against a
// stubbed blob URL under jsdom and leaves the run hanging — noise that has
// nothing to do with the ceiling being tested.
function acceptableFile(name: string) {
  return bigFile(1024, name, "text/plain");
}

afterEach(() => {
  cleanup();
  // Pending attachments persist as drafts across mounts; without this an
  // accepted file leaks into the next test and starts a real upload there.
  clearDraftPendingFilesForTests();
  api.get = originalApiGet;
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
  resetAttachmentUploadLimitForTests();
});

test("rejection copy states the served ceiling, not the plan ceiling", async () => {
  setupStores();
  stubApi({ maxBytes: SERVED_LIMIT_BYTES });
  const { fileInput } = mountComposer();

  await act(async () => {
    fireEvent.change(fileInput, { target: { files: [bigFile(190 * 1024 * 1024)] } });
  });

  // 190MB under a Pro plan limit of 200MB would have been accepted by the old
  // client-computed check, then failed later as a bare "Upload failed".
  await waitFor(() => {
    assert.ok(
      screen.getByText(/Max 90MB per file\. Current largest file is 190\.0MB\./),
      "composer must quote the served 90MB ceiling",
    );
  });
});

test("a file within the served ceiling is still accepted", async () => {
  setupStores();
  stubApi({ maxBytes: SERVED_LIMIT_BYTES });
  URL.createObjectURL = () => "blob:preview";
  URL.revokeObjectURL = () => {};
  const { fileInput } = mountComposer();

  await act(async () => {
    fireEvent.change(fileInput, { target: { files: [acceptableFile("small.txt")] } });
  });

  // Guards the other direction: the fix must not simply refuse everything.
  // The chip may then fail to upload (no upload stub here); acceptance into the
  // composer is the property under test, and the Remove control only exists for
  // a file that was accepted.
  await waitFor(() => screen.getByRole("button", { name: "Remove small.txt" }));
});

test("an unavailable ceiling refuses the file and says so", async () => {
  setupStores();
  stubApi(new Error("capabilities unreachable"));
  const { fileInput } = mountComposer();

  await act(async () => {
    fireEvent.change(fileInput, { target: { files: [acceptableFile("small.txt")] } });
  });

  await waitFor(() => {
    assert.ok(
      screen.getByText("The upload size limit could not be checked. Try again in a moment."),
      "composer must report the unknown ceiling rather than guessing one",
    );
  });
  assert.equal(
    screen.queryByRole("button", { name: "Remove small.txt" }),
    null,
    "no file may attach under an unknown ceiling",
  );
});

test("picked files survive the picker resetting the input before the ceiling resolves", async () => {
  // Regression guard for an ordering hazard introduced by awaiting the server
  // ceiling: the change handler clears `input.value` as soon as it returns, and
  // a browser empties the live FileList when it does. Reading the FileList
  // after the await would therefore drop every picked file. jsdom does not
  // model that coupling, so this test installs it explicitly.
  setupStores();
  stubApi({ maxBytes: SERVED_LIMIT_BYTES });
  URL.createObjectURL = () => "blob:preview";
  URL.revokeObjectURL = () => {};
  const { fileInput } = mountComposer();

  // The browser empties the *same* FileList object the handler already passed
  // along, so this must clear in place. Swapping in a fresh empty array would
  // leave the original reference intact and the test would pass even against
  // the unfixed ordering.
  const live: File[] = [acceptableFile("picked.txt")];
  Object.defineProperty(fileInput, "files", { get: () => live, configurable: true });
  Object.defineProperty(fileInput, "value", {
    get: () => "",
    set: () => { live.length = 0; },
    configurable: true,
  });

  await act(async () => {
    fireEvent.change(fileInput);
  });

  await waitFor(() => screen.getByRole("button", { name: "Remove picked.txt" }));
});

test("a pasted file renders an honest local preview before the server ceiling resolves", async () => {
  setupStores();
  const finishCapability = deferCapability();
  URL.createObjectURL = () => "blob:large-paste-preview";
  URL.revokeObjectURL = () => {};
  mountComposer();

  const textarea = screen.getByPlaceholderText("Message #general");
  const pasted = bigFile(80 * 1024 * 1024, "large-paste.png");
  fireEvent.paste(textarea, {
    clipboardData: {
      items: [{ kind: "file", getAsFile: () => pasted }],
      files: [pasted],
    },
  });

  assert.ok(
    screen.getByRole("img", { name: "large-paste.png" }),
    "the local preview must render before the capability request settles",
  );
  assert.ok(screen.getByText("Checking file…"));
  const submit = screen.getByRole("button", { name: "Checking attachments" }) as HTMLButtonElement;
  assert.equal(submit.disabled, true, "an unvalidated local file must not be sendable");

  await act(async () => {
    finishCapability();
  });

  await waitFor(() => {
    assert.equal(screen.queryByText("Checking file…"), null);
    assert.ok(screen.getByRole("button", { name: "Remove large-paste.png" }));
  });
});

test("removing a provisional pasted file prevents it from returning after validation", async () => {
  setupStores();
  const finishCapability = deferCapability();
  mountComposer();
  const removed = bigFile(80 * 1024 * 1024, "removed-before-check.txt", "text/plain");

  fireEvent.paste(screen.getByPlaceholderText("Message #general"), {
    clipboardData: {
      items: [{ kind: "file", getAsFile: () => removed }],
      files: [removed],
    },
  });
  fireEvent.click(screen.getByRole("button", { name: "Remove removed-before-check.txt" }));
  assert.equal(screen.queryByText("removed-before-check.txt"), null);

  await act(async () => {
    finishCapability(1024 * 1024);
  });

  await waitFor(() => {
    assert.equal(screen.queryByText("removed-before-check.txt"), null);
    assert.equal(screen.queryByRole("button", { name: "Remove removed-before-check.txt" }), null);
    assert.equal(screen.queryByText(/Max 1MB per file/), null, "a removed file must not surface a stale validation error");
  });
});

test("rapid selection batches reserve the ten slots in user selection order", async () => {
  setupStores();
  const finishCapability = deferCapability();
  const { fileInput } = mountComposer();
  const firstBatch = Array.from({ length: 8 }, (_, index) => acceptableFile(`first-${index}.txt`));
  const secondBatch = Array.from({ length: 8 }, (_, index) => acceptableFile(`second-${index}.txt`));

  fireEvent.change(fileInput, { target: { files: firstBatch } });
  fireEvent.change(fileInput, { target: { files: secondBatch } });
  assert.equal(screen.getAllByText("Checking file…").length, 16);

  await act(async () => {
    finishCapability();
  });

  await waitFor(() => {
    assert.equal(screen.queryAllByText("Checking file…").length, 0);
    assert.equal(screen.getAllByRole("button", { name: /^Remove (?:first|second)-/ }).length, 10);
    for (let index = 0; index < 8; index += 1) {
      assert.ok(screen.getByRole("button", { name: `Remove first-${index}.txt` }));
    }
    assert.ok(screen.getByRole("button", { name: "Remove second-0.txt" }));
    assert.ok(screen.getByRole("button", { name: "Remove second-1.txt" }));
    assert.ok(screen.getByText("Only 10 attachments per message. 6 extra files skipped."));
  });
});

test("a ceiling that drops on the same server takes effect on the next selection", async () => {
  // @Cody's blocking case. `server:plan-updated` patches the server store
  // without firing the reset registry, so a ceiling cached for the tab's
  // lifetime would keep validating against the old value. The visible symptom
  // is the original defect returning: a file accepted here, refused by the
  // upload path a moment later.
  setupStores();
  const served = stubApi({ maxBytes: 90 * 1024 * 1024 });
  const { fileInput } = mountComposer();

  await act(async () => {
    fireEvent.change(fileInput, { target: { files: [bigFile(60 * 1024 * 1024, "sixty.txt", "text/plain")] } });
  });
  await waitFor(() => screen.getByRole("button", { name: "Remove sixty.txt" }));

  // Same server, same tab, lower ceiling.
  served.capability = { maxBytes: 12 * 1024 * 1024 };

  await act(async () => {
    fireEvent.change(fileInput, { target: { files: [bigFile(20 * 1024 * 1024, "twenty.txt", "text/plain")] } });
  });

  await waitFor(() => {
    assert.ok(
      screen.getByText(/Max 12MB per file\. Current largest file is 20\.0MB\./),
      "the composer must follow the newly served ceiling, not the one it first saw",
    );
  });
  assert.equal(
    screen.queryByRole("button", { name: "Remove twenty.txt" }),
    null,
    "a file over the new ceiling must not attach",
  );
});
