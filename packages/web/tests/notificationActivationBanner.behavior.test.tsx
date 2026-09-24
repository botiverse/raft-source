import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import "./helpers/domSetup";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import api from "../src/api/client";
import NotificationActivationBanner, {
  isNotificationActivationComposerEligible,
  NOTIFICATION_ACTIVATION_DISMISSED_SESSION_KEY,
} from "../src/components/message/NotificationActivationBanner";
import { TestIntlProvider } from "./helpers/intl";

const originalApiGet = api.get;
const originalApiPost = api.post;
const originalNotification = Object.getOwnPropertyDescriptor(globalThis, "Notification");
const originalWindowNotification = Object.getOwnPropertyDescriptor(window, "Notification");
const originalPushManager = Object.getOwnPropertyDescriptor(window, "PushManager");
const originalServiceWorker = Object.getOwnPropertyDescriptor(navigator, "serviceWorker");

let permission: NotificationPermission;
let nativeResult: NotificationPermission;
let subscribed: boolean;
let serverConfigured: boolean;
let apiPosts: Array<{ url: string; body: unknown }>;

const subscription = {
  endpoint: "https://push.example/subscription",
  toJSON: () => ({
    endpoint: "https://push.example/subscription",
    keys: { p256dh: "p256dh", auth: "auth" },
  }),
  unsubscribe: async () => true,
};

const registration = {
  update: async () => {},
  pushManager: {
    getSubscription: async () => subscribed ? subscription : null,
    subscribe: async () => {
      subscribed = true;
      return subscription;
    },
  },
};

function installPushEnvironment() {
  const notification = {
    get permission() {
      return permission;
    },
    requestPermission: async () => {
      permission = nativeResult;
      return nativeResult;
    },
  };
  Object.defineProperty(globalThis, "Notification", {
    configurable: true,
    value: notification,
  });
  Object.defineProperty(window, "Notification", {
    configurable: true,
    value: notification,
  });
  Object.defineProperty(window, "PushManager", {
    configurable: true,
    value: class PushManager {},
  });
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: {
      getRegistration: async () => registration,
      register: async () => registration,
    },
  });
}

function restoreProperty(
  target: object,
  key: PropertyKey,
  descriptor: PropertyDescriptor | undefined,
) {
  if (descriptor) Object.defineProperty(target, key, descriptor);
  else Reflect.deleteProperty(target, key);
}

function renderBanner(placement: "desktop" | "mobile" = "desktop", locale: "en" | "zh-cn" = "en") {
  return render(
    <TestIntlProvider locale={locale}>
      <MemoryRouter>
        <NotificationActivationBanner placement={placement} />
      </MemoryRouter>
    </TestIntlProvider>,
  );
}

beforeEach(() => {
  permission = "default";
  nativeResult = "granted";
  subscribed = false;
  serverConfigured = true;
  apiPosts = [];
  window.sessionStorage.clear();
  installPushEnvironment();
  api.get = (async (url: string) => {
    if (url === "/push/vapid-key") {
      return { data: { publicKey: serverConfigured ? "AQ" : null } };
    }
    throw new Error(`Unexpected GET ${url}`);
  }) as typeof api.get;
  api.post = (async (url: string, body?: unknown) => {
    apiPosts.push({ url, body });
    return { data: {} };
  }) as typeof api.post;
});

afterEach(() => {
  cleanup();
  api.get = originalApiGet;
  api.post = originalApiPost;
  restoreProperty(globalThis, "Notification", originalNotification);
  restoreProperty(window, "Notification", originalWindowNotification);
  restoreProperty(window, "PushManager", originalPushManager);
  restoreProperty(navigator, "serviceWorker", originalServiceWorker);
  window.sessionStorage.clear();
});

test("shows final desktop and mobile copy only while permission is default", async () => {
  renderBanner("desktop");
  assert.ok(screen.getByText("Your agents keep working after you leave."));
  assert.ok(screen.getByText("Turn on notifications so you don't miss when they finish or need you."));
  assert.ok(screen.getByRole("button", { name: "Enable notifications" }));
  await waitFor(() => assert.equal(
    apiPosts.some(({ url, body }) =>
      url === "/push/prompt-events"
      && (body as { event?: string }).event === "web_push_prompt_shown"),
    true,
  ));

  cleanup();
  renderBanner("mobile");
  assert.ok(screen.getByText("Agents keep working after you leave."));
  assert.ok(screen.getByText("Get notified when they finish or need you."));

  cleanup();
  permission = "denied";
  renderBanner();
  assert.equal(screen.queryByTestId("notification-activation-banner-desktop"), null);

  cleanup();
  permission = "default";
  Reflect.deleteProperty(window, "PushManager");
  renderBanner();
  assert.equal(screen.queryByTestId("notification-activation-banner-desktop"), null);
});

test("notification activation banner follows the app locale", () => {
  renderBanner("desktop", "zh-cn");

  assert.ok(screen.getByText("离开后，你的 Agent 仍会继续工作。"));
  assert.ok(screen.getByText("开启通知，不错过它们完成或需要你处理的时刻。"));
  assert.ok(screen.getByRole("button", { name: "开启通知" }));
  assert.equal(screen.queryByText("Your agents keep working after you leave."), null);
});

test("dismiss confirmation closes on its functional animation end and persists only in sessionStorage", async () => {
  renderBanner();
  fireEvent.click(screen.getByRole("button", { name: "Hide notification reminder for this session" }));

  const confirmation = screen.getByTestId("notification-activation-dismiss-confirm");
  assert.equal(confirmation.getAttribute("aria-live"), "polite");
  assert.match(confirmation.textContent ?? "", /Hidden for now — turn on anytime in Settings › Notifications/);
  assert.ok(screen.getByRole("button", { name: "Settings › Notifications" }));
  assert.ok(confirmation.querySelector(".notification-activation-progress"));
  const dismissTimer = confirmation.querySelector(".notification-activation-dismiss-timer");
  assert.ok(dismissTimer);
  assert.equal(window.sessionStorage.getItem(NOTIFICATION_ACTIVATION_DISMISSED_SESSION_KEY), "1");
  assert.equal(window.localStorage.getItem(NOTIFICATION_ACTIVATION_DISMISSED_SESSION_KEY), null);

  // React's jsdom feature detection registers onAnimationEnd through the
  // WebKit-prefixed event name even though real browsers emit animationend.
  fireEvent(dismissTimer, new window.Event("webkitAnimationEnd", { bubbles: true }));
  await waitFor(() => assert.equal(
    screen.queryByTestId("notification-activation-dismiss-confirm"),
    null,
  ));
  assert.equal(screen.queryByTestId("notification-activation-banner-desktop"), null);
  assert.equal(window.sessionStorage.getItem(NOTIFICATION_ACTIVATION_DISMISSED_SESSION_KEY), "1");

  cleanup();
  renderBanner();
  assert.equal(screen.queryByTestId("notification-activation-banner-desktop"), null);
});

test("primary composer eligibility suppresses every excluded host state", () => {
  const base = {
    hasChannel: true,
    showComposer: true,
    readOnly: false,
    channelType: "channel",
    joined: true,
    archived: false,
    jointLocked: false,
    quotaReadOnly: false,
    selectMode: false,
  };
  assert.equal(isNotificationActivationComposerEligible(base), true);
  assert.equal(isNotificationActivationComposerEligible({ ...base, channelType: "dm", joined: undefined }), true);
  assert.equal(isNotificationActivationComposerEligible({ ...base, channelType: "thread" }), false);
  assert.equal(isNotificationActivationComposerEligible({ ...base, hasChannel: false }), false);
  assert.equal(isNotificationActivationComposerEligible({ ...base, showComposer: false }), false);
  assert.equal(isNotificationActivationComposerEligible({ ...base, readOnly: true }), false);
  assert.equal(isNotificationActivationComposerEligible({ ...base, joined: false }), false);
  assert.equal(isNotificationActivationComposerEligible({ ...base, archived: true }), false);
  assert.equal(isNotificationActivationComposerEligible({ ...base, jointLocked: true }), false);
  assert.equal(isNotificationActivationComposerEligible({ ...base, quotaReadOnly: true }), false);
  assert.equal(isNotificationActivationComposerEligible({ ...base, selectMode: true }), false);
});
