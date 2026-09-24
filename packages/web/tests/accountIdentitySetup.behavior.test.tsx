import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import "./helpers/domSetup";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
// The page now calls useIntl(), so every mount needs the intl context. Using the
// shared helper rather than a local IntlProvider keeps these tests resolving
// messages exactly the way production does (same catalogs, same en overlay).
import { renderWithIntl as render } from "./helpers/intl";
import AccountIdentitySetupPage from "../src/components/auth/AccountIdentitySetupPage";
import { useAuthStore } from "../src/store/authStore";
import type { User } from "../src/store/authStore";
import { MAX_PROFILE_AVATAR_BYTES } from "../src/utils/avatarUpload";
import { en } from "../src/i18n/messages/en";

const initialAuthState = useAuthStore.getInitialState();

function user(overrides: Partial<User> = {}): User {
  return {
    id: "user-1",
    email: "cindy@example.com",
    gravatarHash: "hash",
    name: "pending_1234567890abcdef",
    displayName: null,
    description: null,
    avatarUrl: null,
    emailVerified: true,
    profileSetupCompletedAt: null,
    profileSetupSuggestedHandle: null,
    profileSetupProvider: null,
    preferredLanguage: null,
    preferredTimezone: null,
    autoTranslationEnabled: false,
    preferredTranslationMode: "manual",
    preferredTranslationDisplay: "translated",
    preferredTimeFormat: null,
    preferredMessageBodyFontSize: null,
    referralSource: null,
    referralSourceOther: null,
    referralSourceSkippedAt: null,
    ...overrides,
  };
}

function installBlobUrlMock() {
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  URL.createObjectURL = (() => "blob:identity-avatar") as typeof URL.createObjectURL;
  URL.revokeObjectURL = (() => undefined) as typeof URL.revokeObjectURL;
  return () => {
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
  };
}

afterEach(() => {
  cleanup();
  useAuthStore.setState(initialAuthState, true);
});

test("verified password users get identity previews for channel and profile impact", () => {
  useAuthStore.setState({ user: user(), loading: false });
  const { container } = render(<AccountIdentitySetupPage />);

  // The session line moved into the shell's shared footer: "Signed in as x. Log out".
  // It names the ACCOUNT by email (#177). Here identity setup has not run, so `name` is still
  // the internal `pending_<hex>` reservation — which must never be shown back to the person we
  // are asking to choose a handle.
  assert.ok(document.body.textContent?.includes("Signed in as cindy@example.com."));
  assert.ok(!document.body.textContent?.includes("pending_"), "the internal placeholder must never render");
  assert.ok(screen.getByRole("heading", { name: "Set up your account" }));
  const handleInput = screen.getByLabelText("Username") as HTMLInputElement;
  const displayNameInput = screen.getByLabelText("Display name") as HTMLInputElement;
  assert.equal(handleInput.value, "");
  assert.equal(displayNameInput.value, "");
  assert.equal(handleInput.placeholder, "alexchen");
  assert.equal(displayNameInput.placeholder, "Alex Chen");
  assert.ok(
    Boolean(handleInput.compareDocumentPosition(displayNameInput) & Node.DOCUMENT_POSITION_FOLLOWING),
    "Username must be presented before the softer display name field",
  );
  assert.ok(screen.getByText("Your unique name for @mentions and links. It can't be changed later."));
  assert.ok(screen.getByText("A default is picked for you."));
  assert.equal(screen.queryByText(/Step \d/i), null);
  assert.equal(screen.queryByText(/choose carefully/i), null);
  assert.equal(screen.queryByText("Suggested"), null);
  assert.equal(screen.queryByRole("button", { name: /Keep @/ }), null);
  assert.equal(screen.queryByText("John"), null);
  // The identity page renders inside OnboardingCreateShell now, so it HAS the
  // shared preview aside (and the shell's Log out link brings hover styles with
  // it). Both used to be asserted absent, back when this page owned its own frame.
  assert.ok(container.querySelector("aside"));
  const previewPane = screen.getByTestId("identity-preview-pane");
  assert.ok(previewPane.className.includes("bg-brutal-cream"));
  assert.ok(previewPane.innerHTML.includes("radial-gradient"));
  assert.ok(screen.getByTestId("identity-impact-preview"));
  assert.ok(screen.getByTestId("identity-channel-preview"));
  assert.ok(screen.getByTestId("identity-profile-preview"));
  assert.ok(screen.getByTestId("identity-channel-preview").className.includes("onboarding-identity-card-enter"));
  assert.ok(screen.getByTestId("identity-profile-preview").className.includes("onboarding-identity-card-enter"));
  assert.ok(screen.getByTestId("identity-preview-cardzone").className.includes("pb-24"));
  assert.equal(screen.getByTestId("identity-profile-preview").closest("[data-testid='identity-preview-cardzone']") !== null, true);
  assert.equal(screen.queryByTestId("identity-preview-captions"), null);
  assert.equal(screen.queryByText("In a channel message"), null);
  assert.equal(screen.queryByText("In a profile card"), null);
  assert.ok(screen.getByText("Maya"));
  assert.ok(screen.getByText("pricing"));
  assert.equal(screen.getAllByText("@alexchen").length, 2);
  assert.equal(screen.getByTestId("identity-user-message-name").textContent, "Alex Chen");
  assert.equal(screen.getByTestId("identity-profile-name").textContent, "Alex Chen");
  assert.equal(screen.getByTestId("identity-profile-handle").textContent, "@alexchen");
  assert.equal(screen.queryByText("Your display name and profile picture are what everyone sees on your messages."), null);
  assert.equal(screen.queryByText("Click anyone's name or avatar and this is what you'll see — your @handle lives here."), null);
});

test("OAuth identity setup prefills provider values without field-level source notes", () => {
  useAuthStore.setState({
    user: user({
      displayName: "Cindy Rui",
      avatarUrl: "https://example.test/google-avatar.png",
      profileSetupSuggestedHandle: "cindyrui2",
      profileSetupProvider: "google",
    }),
    loading: false,
  });
  const { container } = render(<AccountIdentitySetupPage />);

  assert.ok(document.body.textContent?.includes("Signed in as cindy@example.com."));
  assert.ok(screen.getByRole("heading", { name: "Confirm your identity" }));
  const handleInput = screen.getByLabelText("Username") as HTMLInputElement;
  const displayNameInput = screen.getByLabelText("Display name") as HTMLInputElement;
  assert.equal(handleInput.value, "cindyrui2");
  assert.equal(displayNameInput.value, "Cindy Rui");
  assert.ok(
    Boolean(handleInput.compareDocumentPosition(displayNameInput) & Node.DOCUMENT_POSITION_FOLLOWING),
    "Username must stay first for OAuth setup too",
  );
  assert.ok(screen.getByText("Change it anytime."));
  assert.equal(screen.queryByText(/From Google/i), null);
  assert.equal(screen.queryByText("Suggested"), null);
  assert.equal(screen.queryByRole("button", { name: /Choose something else/i }), null);
  assert.ok(container.querySelector('img[src="https://example.test/google-avatar.png"]'));
  assert.equal(screen.queryByText("John"), null);
  assert.ok(container.querySelector("aside"));
  assert.ok(screen.getByTestId("identity-channel-preview"));
  assert.ok(screen.getByTestId("identity-profile-preview"));
  assert.ok(screen.getByText("Maya"));
  assert.ok(screen.getAllByText("Cindy Rui").length >= 2);
  assert.equal(screen.getAllByText("@cindyrui2").length, 2);
  assert.equal(screen.getByTestId("identity-profile-handle").textContent, "@cindyrui2");
});

test("GitHub identity setup keeps GitHub-specific confirmation copy", () => {
  useAuthStore.setState({
    user: user({
      displayName: "Cindy Rui",
      avatarUrl: "https://example.test/github-avatar.png",
      profileSetupSuggestedHandle: "cindyrui3",
      profileSetupProvider: "github",
    }),
    loading: false,
  });
  render(<AccountIdentitySetupPage />);

  assert.ok(document.body.textContent?.includes("Signed in as cindy@example.com."));
  assert.ok(screen.getByRole("heading", { name: "Confirm your identity" }));
  assert.equal((screen.getByLabelText("Username") as HTMLInputElement).value, "cindyrui3");
});

test("identity setup sends the visible handle and uploads a selected avatar first", async () => {
  const restoreBlobUrl = installBlobUrlMock();
  const calls: unknown[][] = [];
  useAuthStore.setState({
    user: user(),
    loading: false,
    completeOnboardingProfile: async (...args: unknown[]) => {
      calls.push(args);
    },
  } as never);
  const { container } = render(<AccountIdentitySetupPage />);

  fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Cindy Rui" } });
  fireEvent.change(screen.getByLabelText("Username"), { target: { value: "cindyrui" } });
  const avatarFile = new File(["avatar"], "avatar.png", { type: "image/png" });
  const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]');
  assert.ok(fileInput);
  fireEvent.change(fileInput, { target: { files: [avatarFile] } });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));

  await waitFor(() => assert.equal(calls.length, 1));
  assert.equal(calls[0][0], "cindyrui");
  assert.equal(calls[0][1], "Cindy Rui");
  assert.equal(calls[0][2], avatarFile);
  restoreBlobUrl();
});

test("identity setup rejects oversized avatars before submit", () => {
  useAuthStore.setState({
    user: user(),
    loading: false,
    completeOnboardingProfile: async () => {
      throw new Error("completeOnboardingProfile should not be called for an oversized avatar");
    },
  } as never);
  const { container } = render(<AccountIdentitySetupPage />);
  const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]');
  assert.ok(fileInput);

  const avatarFile = new File([new Uint8Array(MAX_PROFILE_AVATAR_BYTES + 1)], "huge.png", { type: "image/png" });
  fireEvent.change(fileInput, { target: { files: [avatarFile] } });
  fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Cindy Rui" } });
  fireEvent.change(screen.getByLabelText("Username"), { target: { value: "cindyrui" } });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));

  // Was the PROFILE_AVATAR_TOO_LARGE_MESSAGE constant, which no longer exists —
  // it WAS the English source this change deletes. The property is unchanged:
  // the alert still shows the size sentence. It just comes from the catalog now.
  assert.ok(screen.getByRole("alert").textContent?.includes(
    en["avatar.tooLarge"].replace("{maxLabel}", en["common.fileSize.maxLabel5mb"]),
  ));
});

test("handle edits strip only leading at-signs and clear only the handle validation error", async () => {
  useAuthStore.setState({
    user: user(),
    loading: false,
    completeOnboardingProfile: async () => undefined,
  } as never);
  render(<AccountIdentitySetupPage />);

  fireEvent.click(screen.getByRole("button", { name: "Continue" }));

  assert.ok(await screen.findByText("Display name is required"));
  assert.ok(screen.getByText("Username is required"));

  const handleInput = screen.getByLabelText("Username") as HTMLInputElement;
  fireEvent.change(handleInput, { target: { value: "@@cindyrui" } });

  assert.equal(handleInput.value, "cindyrui");
  assert.equal(screen.queryByText("Username is required"), null);
  // The username mirrors into an untouched display name, so that error clears with it.
  assert.equal((screen.getByLabelText("Display name") as HTMLInputElement).value, "cindyrui");
  assert.equal(screen.queryByText("Display name is required"), null);
  // The in-field "confirmed" pin is gone: the field validates on blur, and a lime
  // tick inside the input was a second, quieter status channel saying the same thing.
  assert.equal(screen.queryByTestId("identity-handle-confirm-pin"), null);

  fireEvent.change(handleInput, { target: { value: "cindy@rui" } });

  assert.equal(handleInput.value, "cindy@rui");
});

test("identity previews update from display name, handle, and avatar fields", () => {
  const restoreBlobUrl = installBlobUrlMock();
  useAuthStore.setState({ user: user(), loading: false });
  const { container } = render(<AccountIdentitySetupPage />);

  const initialSeededMention = screen.getByTestId("identity-seeded-mention");
  const initialMessageName = screen.getByTestId("identity-user-message-name");
  const initialProfileName = screen.getByTestId("identity-profile-name");
  const initialProfileHandle = screen.getByTestId("identity-profile-handle-value");
  fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Launch Cindy" } });
  fireEvent.change(screen.getByLabelText("Username"), { target: { value: "launchcindy" } });
  assert.notEqual(screen.getByTestId("identity-seeded-mention"), initialSeededMention);
  assert.notEqual(screen.getByTestId("identity-user-message-name"), initialMessageName);
  assert.notEqual(screen.getByTestId("identity-profile-name"), initialProfileName);
  assert.notEqual(screen.getByTestId("identity-profile-handle-value"), initialProfileHandle);
  const initialMessageAvatar = screen.getByTestId("identity-user-message-avatar");
  const initialProfileAvatar = screen.getByTestId("identity-profile-avatar");
  const avatarFile = new File(["avatar"], "avatar.png", { type: "image/png" });
  const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]');
  assert.ok(fileInput);
  fireEvent.change(fileInput, { target: { files: [avatarFile] } });

  const channelPreview = screen.getByTestId("identity-channel-preview");
  const userMessagePreview = screen.getByTestId("identity-user-message-preview");
  const profilePreview = screen.getByTestId("identity-profile-preview");
  assert.ok(within(channelPreview).getByText("Launch Cindy"));
  assert.ok(within(channelPreview).getByText("@launchcindy"));
  assert.ok(screen.getByTestId("identity-seeded-mention").className.includes("onboarding-identity-pop"));
  assert.equal(within(userMessagePreview).queryByText("@launchcindy"), null);
  assert.ok(screen.getByTestId("identity-user-message-name").className.includes("onboarding-identity-pop"));
  assert.ok(within(profilePreview).getByText("Launch Cindy"));
  assert.ok(within(profilePreview).getByText("@launchcindy"));
  assert.ok(screen.getByTestId("identity-profile-name").className.includes("onboarding-identity-pop"));
  assert.ok(screen.getByTestId("identity-profile-handle").innerHTML.includes("onboarding-identity-pop"));
  assert.notEqual(screen.getByTestId("identity-user-message-avatar"), initialMessageAvatar);
  assert.notEqual(screen.getByTestId("identity-profile-avatar"), initialProfileAvatar);
  assert.equal(channelPreview.innerHTML.includes("blob:identity-avatar"), true);
  assert.equal(profilePreview.innerHTML.includes("blob:identity-avatar"), true);
  restoreBlobUrl();
});

test("identity avatar targets remount when a selected preview replaces a persisted avatar", () => {
  const restoreBlobUrl = installBlobUrlMock();
  useAuthStore.setState({
    user: user({
      displayName: "Cindy Rui",
      avatarUrl: "https://example.test/google-avatar.png",
      profileSetupSuggestedHandle: "cindyrui2",
      profileSetupProvider: "google",
    }),
    loading: false,
  });
  const { container } = render(<AccountIdentitySetupPage />);
  const initialMessageAvatar = screen.getByTestId("identity-user-message-avatar");
  const initialProfileAvatar = screen.getByTestId("identity-profile-avatar");
  const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]');
  assert.ok(fileInput);

  fireEvent.change(fileInput, { target: { files: [new File(["avatar"], "avatar.png", { type: "image/png" })] } });

  assert.notEqual(screen.getByTestId("identity-user-message-avatar"), initialMessageAvatar);
  assert.notEqual(screen.getByTestId("identity-profile-avatar"), initialProfileAvatar);
  assert.equal(screen.getByTestId("identity-channel-preview").innerHTML.includes("blob:identity-avatar"), true);
  assert.equal(screen.getByTestId("identity-profile-preview").innerHTML.includes("blob:identity-avatar"), true);
  restoreBlobUrl();
});

test("identity previews trim whitespace before rendering names and mentions", () => {
  useAuthStore.setState({ user: user(), loading: false });
  render(<AccountIdentitySetupPage />);

  fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "  Launch Cindy  " } });
  fireEvent.change(screen.getByLabelText("Username"), { target: { value: "  launchcindy  " } });

  assert.equal(screen.getByTestId("identity-user-message-name").textContent, "Launch Cindy");
  assert.equal(screen.getByTestId("identity-profile-name").textContent, "Launch Cindy");
  assert.equal(screen.getByTestId("identity-seeded-mention").textContent, "@launchcindy");
  assert.equal(screen.getByTestId("identity-profile-handle").textContent, "@launchcindy");
  assert.equal(
    screen.getByTestId("identity-seeded-message-copy").textContent,
    "morning — can @launchcindy take a look at the Q3 draft?",
  );
});

test("display name edits clear only the display-name validation error", async () => {
  useAuthStore.setState({
    user: user(),
    loading: false,
    completeOnboardingProfile: async () => undefined,
  } as never);
  render(<AccountIdentitySetupPage />);

  fireEvent.click(screen.getByRole("button", { name: "Continue" }));

  assert.ok(await screen.findByText("Display name is required"));
  assert.ok(screen.getByText("Username is required"));

  fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Cindy Rui" } });

  assert.equal(screen.queryByText("Display name is required"), null);
  assert.ok(screen.getByText("Username is required"));
});

test("avatar change button opens the hidden file input", () => {
  useAuthStore.setState({ user: user(), loading: false });
  const { container } = render(<AccountIdentitySetupPage />);
  const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]');
  assert.ok(fileInput);
  let clickCount = 0;
  fileInput.click = () => {
    clickCount += 1;
  };

  fireEvent.click(screen.getByRole("button", { name: "Upload" }));

  assert.equal(clickCount, 1);
});

test("avatar change button shows uploading only while a selected file is saving", async () => {
  const restoreBlobUrl = installBlobUrlMock();
  useAuthStore.setState({ user: user(), loading: false });
  const { container } = render(<AccountIdentitySetupPage />);
  const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]');
  assert.ok(fileInput);

  assert.ok(screen.getByRole("button", { name: "Upload" }));
  fireEvent.change(fileInput, { target: { files: [new File(["avatar"], "avatar.png", { type: "image/png" })] } });
  assert.ok(screen.getByRole("button", { name: "Upload" }));

  act(() => {
    useAuthStore.setState({ loading: true });
  });

  await waitFor(() => assert.ok(screen.getByRole("button", { name: "Uploading…" })));
  restoreBlobUrl();
});

test("submit button keeps explicit saving copy while identity setup is loading", () => {
  useAuthStore.setState({ user: user(), loading: true });
  render(<AccountIdentitySetupPage />);

  const submitButton = screen.getByRole("button", { name: "Saving identity…" });
  assert.equal(submitButton.getAttribute("type"), "submit");
  assert.equal((submitButton as HTMLButtonElement).disabled, true);
});

test("avatar failure keeps identity incomplete and hides the failed local preview", async () => {
  const restoreBlobUrl = installBlobUrlMock();
  useAuthStore.setState({
    user: user(),
    loading: false,
    completeOnboardingProfile: async () => {
      throw {
        onboardingStep: "avatar",
        response: { data: { error: "Only image files are allowed (JPEG, PNG, GIF, WebP)" } },
      };
    },
  } as never);
  const { container } = render(<AccountIdentitySetupPage />);

  fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Cindy Rui" } });
  fireEvent.change(screen.getByLabelText("Username"), { target: { value: "cindyrui" } });
  const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]');
  assert.ok(fileInput);
  fireEvent.change(fileInput, {
    target: { files: [new File(["bad"], "private-path.exe", { type: "application/octet-stream" })] },
  });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));

  await waitFor(() => {
    assert.ok(screen.getByText("Couldn't upload that image: Only image files are allowed (JPEG, PNG, GIF, WebP). Try another file."));
  });
  assert.equal(document.body.textContent?.includes("private-path.exe"), false);
  assert.equal(document.body.innerHTML.includes("blob:identity-avatar"), false);
  restoreBlobUrl();
});
