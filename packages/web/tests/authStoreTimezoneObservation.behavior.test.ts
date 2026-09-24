import assert from "node:assert/strict";
import test from "node:test";
import "./helpers/domSetup";
import api from "../src/api/client";
import { useAuthStore } from "../src/store/authStore";
import type { User } from "../src/store/authStore";
import { detectBrowserTimezone } from "../src/utils/timeFormatting";

const initialAuthState = useAuthStore.getInitialState();

function user(overrides: Partial<User> = {}): User {
  return {
    id: "timezone-user",
    email: "timezone@example.com",
    gravatarHash: "hash",
    name: "timezone-user",
    displayName: "Timezone User",
    description: null,
    avatarUrl: null,
    emailVerified: true,
    preferredLanguage: null,
    preferredTimezone: null,
    firstObservedTimezone: null,
    firstObservedTimezoneAt: null,
    lastObservedTimezone: null,
    lastObservedTimezoneAt: null,
    autoTranslationEnabled: false,
    preferredTranslationMode: "off",
    preferredTranslationDisplay: "translated",
    preferredTimeFormat: null,
    preferredMessageBodyFontSize: null,
    referralSource: null,
    referralSourceOther: null,
    referralSourceSkippedAt: null,
    ...overrides,
  };
}

async function settleObservation() {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

test.afterEach(async () => {
  await settleObservation();
  localStorage.clear();
  useAuthStore.setState(initialAuthState, true);
});

test("login records browser timezone once without blocking authentication", async (t) => {
  const browserTimezone = detectBrowserTimezone();
  assert.ok(browserTimezone);
  const calls: Array<{ url: string; body: unknown }> = [];
  const observedAt = "2026-07-17T07:50:00.000Z";

  t.mock.method(api, "post", async (url: string, body?: unknown) => {
    calls.push({ url, body });
    if (url === "/auth/login") {
      return { data: { user: user(), accessToken: "access", refreshToken: "refresh" } };
    }
    if (url === "/auth/me/timezone-observation") {
      return {
        data: {
          firstObservedTimezone: browserTimezone,
          firstObservedTimezoneAt: observedAt,
          lastObservedTimezone: browserTimezone,
          lastObservedTimezoneAt: observedAt,
        },
      };
    }
    throw new Error(`unexpected POST ${url}`);
  });

  await useAuthStore.getState().login("timezone@example.com", "password123");
  assert.equal(useAuthStore.getState().initialized, true);
  await settleObservation();

  assert.deepEqual(calls, [
    { url: "/auth/login", body: { email: "timezone@example.com", password: "password123" } },
    { url: "/auth/me/timezone-observation", body: { timezone: browserTimezone } },
  ]);
  assert.equal(useAuthStore.getState().user?.firstObservedTimezone, browserTimezone);
  assert.equal(useAuthStore.getState().user?.firstObservedTimezoneAt, observedAt);
  assert.equal(useAuthStore.getState().user?.lastObservedTimezone, browserTimezone);
  assert.equal(useAuthStore.getState().user?.lastObservedTimezoneAt, observedAt);
});

test("auth restore progressively fills a missing observation", async (t) => {
  const browserTimezone = detectBrowserTimezone();
  assert.ok(browserTimezone);
  const urls: string[] = [];
  useAuthStore.setState({ accessToken: "stored-access", refreshToken: "stored-refresh" });

  t.mock.method(api, "get", async (url: string) => {
    assert.equal(url, "/auth/me");
    return { data: user() };
  });
  t.mock.method(api, "post", async (url: string, body?: unknown) => {
    urls.push(url);
    assert.deepEqual(body, { timezone: browserTimezone });
    return {
      data: {
        firstObservedTimezone: browserTimezone,
        firstObservedTimezoneAt: "2026-07-17T07:51:00.000Z",
        lastObservedTimezone: browserTimezone,
        lastObservedTimezoneAt: "2026-07-17T07:51:00.000Z",
      },
    };
  });

  await useAuthStore.getState().loadUser();
  await settleObservation();

  assert.deepEqual(urls, ["/auth/me/timezone-observation"]);
  assert.equal(useAuthStore.getState().user?.firstObservedTimezone, browserTimezone);
  assert.equal(useAuthStore.getState().user?.lastObservedTimezone, browserTimezone);
});

test("existing first observation still reports latest while unsupported server state does not", async (t) => {
  let observationCalls = 0;
  t.mock.method(api, "post", async (url: string) => {
    if (url === "/auth/login") {
      return {
        data: {
          user: user({
            firstObservedTimezone: "Europe/Paris",
            firstObservedTimezoneAt: "2026-07-10T07:51:00.000Z",
            lastObservedTimezone: "Europe/Paris",
            lastObservedTimezoneAt: "2026-07-10T07:51:00.000Z",
          }),
          accessToken: "access",
          refreshToken: "refresh",
        },
      };
    }
    observationCalls += 1;
    assert.equal(url, "/auth/me/timezone-observation");
    return {
      data: {
        firstObservedTimezone: "Europe/Paris",
        firstObservedTimezoneAt: "2026-07-10T07:51:00.000Z",
        lastObservedTimezone: "Asia/Shanghai",
        lastObservedTimezoneAt: "2026-07-17T07:51:00.000Z",
      },
    };
  });

  await useAuthStore.getState().login("timezone@example.com", "password123");
  await settleObservation();
  assert.equal(observationCalls, 1);
  assert.equal(useAuthStore.getState().user?.firstObservedTimezone, "Europe/Paris");
  assert.equal(useAuthStore.getState().user?.lastObservedTimezone, "Asia/Shanghai");

  t.mock.restoreAll();
  useAuthStore.setState(initialAuthState, true);
  observationCalls = 0;
  t.mock.method(api, "post", async (url: string) => {
    if (url === "/auth/login") {
      const olderUser = user();
      delete olderUser.firstObservedTimezone;
      delete olderUser.firstObservedTimezoneAt;
      delete olderUser.lastObservedTimezone;
      delete olderUser.lastObservedTimezoneAt;
      return { data: { user: olderUser, accessToken: "access", refreshToken: "refresh" } };
    }
    observationCalls += 1;
    throw new Error(`unexpected POST ${url}`);
  });

  await useAuthStore.getState().login("timezone@example.com", "password123");
  await settleObservation();
  assert.equal(observationCalls, 0);
});

test("first-only endpoint response from an older server does not break auth or invent last state", async (t) => {
  const browserTimezone = detectBrowserTimezone();
  assert.ok(browserTimezone);
  const firstAt = "2026-07-10T07:51:00.000Z";

  t.mock.method(api, "post", async (url: string) => {
    if (url === "/auth/login") {
      const olderUser = user({
        firstObservedTimezone: "Europe/Paris",
        firstObservedTimezoneAt: firstAt,
      });
      delete olderUser.lastObservedTimezone;
      delete olderUser.lastObservedTimezoneAt;
      return { data: { user: olderUser, accessToken: "access", refreshToken: "refresh" } };
    }
    assert.equal(url, "/auth/me/timezone-observation");
    return {
      data: {
        firstObservedTimezone: "Europe/Paris",
        firstObservedTimezoneAt: firstAt,
      },
    };
  });

  await useAuthStore.getState().login("timezone@example.com", "password123");
  await settleObservation();

  assert.equal(useAuthStore.getState().initialized, true);
  assert.equal(useAuthStore.getState().user?.firstObservedTimezone, "Europe/Paris");
  assert.equal(useAuthStore.getState().user?.lastObservedTimezone, undefined);
  assert.equal(useAuthStore.getState().user?.lastObservedTimezoneAt, undefined);
});

test("browser timezone detection failure does not block login or report", async (t) => {
  let observationCalls = 0;
  t.mock.method(Intl, "DateTimeFormat", () => {
    throw new Error("timezone unavailable");
  });
  t.mock.method(api, "post", async (url: string) => {
    if (url === "/auth/login") {
      return { data: { user: user(), accessToken: "access", refreshToken: "refresh" } };
    }
    observationCalls += 1;
    throw new Error(`unexpected POST ${url}`);
  });

  await useAuthStore.getState().login("timezone@example.com", "password123");
  await settleObservation();

  assert.equal(useAuthStore.getState().initialized, true);
  assert.equal(observationCalls, 0);
});

test("missing browser timezone does not emit an observation request", async (t) => {
  let observationCalls = 0;
  t.mock.method(Intl, "DateTimeFormat", () => ({
    resolvedOptions: () => ({ timeZone: undefined }),
  }) as Intl.DateTimeFormat);
  t.mock.method(api, "post", async (url: string) => {
    if (url === "/auth/login") {
      return { data: { user: user(), accessToken: "access", refreshToken: "refresh" } };
    }
    observationCalls += 1;
    throw new Error(`unexpected POST ${url}`);
  });

  await useAuthStore.getState().login("timezone@example.com", "password123");
  await settleObservation();

  assert.equal(useAuthStore.getState().initialized, true);
  assert.equal(observationCalls, 0);
});

test("observation failure is isolated from login and can retry on later restore", async (t) => {
  let observationAttempts = 0;
  t.mock.method(api, "post", async (url: string) => {
    if (url === "/auth/login") {
      return { data: { user: user(), accessToken: "access", refreshToken: "refresh" } };
    }
    observationAttempts += 1;
    throw new Error("analytics endpoint unavailable");
  });

  await useAuthStore.getState().login("timezone@example.com", "password123");
  await settleObservation();
  assert.equal(useAuthStore.getState().initialized, true);
  assert.equal(useAuthStore.getState().user?.firstObservedTimezone, null);
  assert.equal(useAuthStore.getState().user?.lastObservedTimezone, null);
  assert.equal(observationAttempts, 1);

  t.mock.method(api, "get", async () => ({ data: user() }));
  await useAuthStore.getState().loadUser();
  await settleObservation();
  assert.equal(observationAttempts, 2);
});

test("late observation response cannot restore a logged-out user", async (t) => {
  let resolveObservation!: (value: unknown) => void;
  const observation = new Promise((resolve) => {
    resolveObservation = resolve;
  });

  t.mock.method(api, "post", async (url: string) => {
    if (url === "/auth/login") {
      return { data: { user: user(), accessToken: "access", refreshToken: "refresh" } };
    }
    if (url === "/auth/me/timezone-observation") return observation;
    if (url === "/auth/logout") return { data: {} };
    throw new Error(`unexpected POST ${url}`);
  });

  await useAuthStore.getState().login("timezone@example.com", "password123");
  useAuthStore.getState().logout();
  resolveObservation({
    data: {
      firstObservedTimezone: "UTC",
      firstObservedTimezoneAt: "2026-07-17T07:52:00.000Z",
      lastObservedTimezone: "UTC",
      lastObservedTimezoneAt: "2026-07-17T07:52:00.000Z",
    },
  });
  await settleObservation();

  assert.equal(useAuthStore.getState().user, null);
});

test("late observation response cannot overwrite a different authenticated user", async (t) => {
  let resolveObservation!: (value: unknown) => void;
  const observation = new Promise((resolve) => {
    resolveObservation = resolve;
  });

  t.mock.method(api, "post", async (url: string) => {
    if (url === "/auth/login") {
      return { data: { user: user(), accessToken: "access", refreshToken: "refresh" } };
    }
    if (url === "/auth/me/timezone-observation") return observation;
    throw new Error(`unexpected POST ${url}`);
  });

  await useAuthStore.getState().login("timezone@example.com", "password123");
  const otherUser = user({ id: "other-user", email: "other@example.com" });
  useAuthStore.setState({ user: otherUser });
  resolveObservation({
    data: {
      firstObservedTimezone: "UTC",
      firstObservedTimezoneAt: "2026-07-17T07:53:00.000Z",
      lastObservedTimezone: "UTC",
      lastObservedTimezoneAt: "2026-07-17T07:53:00.000Z",
    },
  });
  await settleObservation();

  assert.deepEqual(useAuthStore.getState().user, otherUser);
});
