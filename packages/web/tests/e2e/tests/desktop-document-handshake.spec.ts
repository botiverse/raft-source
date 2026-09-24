import { expect, test } from "@playwright/test";

test.use({ storageState: { cookies: [], origins: [] } });

test("ordinary browser bundle remains a zero-native-invoke no-op", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator("#root")).toBeAttached();
  expect(
    await page.evaluate(
      () =>
        typeof (
          window as typeof window & {
            __TAURI_INTERNALS__?: unknown;
          }
        ).__TAURI_INTERNALS__,
    ),
  ).toBe("undefined");
  await expect(
    page.locator("#raft-desktop-handshake-recovery"),
  ).toHaveCount(0);
});

test("browser bundle waits for native Finished and does not re-handshake on SPA transitions", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const calls: Array<{ command: string; args: unknown }> = [];
    Object.assign(window, {
      __RAFT_DESKTOP_E2E_CALLS__: calls,
      __RAFT_DESKTOP_ENVIRONMENT__: Object.freeze({
        environmentId: "production",
        generation: 3,
        frontendOrigin: "https://app.raft.build",
        apiOrigin: "https://api.raft.build",
        socketOrigin: "https://api.raft.build",
        updateAuthority: "productionHands",
      }),
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args: Record<string, unknown>) => {
          calls.push({ command, args });
          const params = args.params as { documentGeneration: number };
          return {
            method: "desktop.handshake",
            status: "ok",
            result: {
              compatibilityState: "readyFull",
              documentGeneration: params.documentGeneration,
              environmentId: "production",
              environmentGeneration: 3,
            },
          };
        },
      },
    });
  });

  await page.goto("/");
  await expect(page.locator("#root")).toBeAttached();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as typeof window & {
              __RAFT_DESKTOP_E2E_CALLS__: unknown[];
            }
          ).__RAFT_DESKTOP_E2E_CALLS__.length,
      ),
    )
    .toBe(0);

  await page.evaluate(() => {
    const documentIdentity = Object.freeze({
      generation: 7,
      nonce: "6edbdb72-a002-4b13-b9ee-68d21ae36c34",
    });
    Object.assign(window, {
      __RAFT_DESKTOP_DOCUMENT__: documentIdentity,
    });
    window.dispatchEvent(
      new CustomEvent("raft:desktop-document-ready", {
        detail: documentIdentity,
      }),
    );
  });

  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as typeof window & {
              __RAFT_DESKTOP_E2E_CALLS__: unknown[];
            }
          ).__RAFT_DESKTOP_E2E_CALLS__.length,
      ),
    )
    .toBe(1);

  const calls = await page.evaluate(
    () =>
      (
        window as typeof window & {
          __RAFT_DESKTOP_E2E_CALLS__: Array<{
            command: string;
            args: unknown;
          }>;
        }
      ).__RAFT_DESKTOP_E2E_CALLS__,
  );
  expect(calls).toEqual([
    {
      command: "desktop_handshake",
      args: {
        params: {
          frontendReleaseId: expect.any(String),
          protocolVersion: 1,
          capabilities: ["desktop.handshake", "window.focus", "window.bindServer"],
          documentGeneration: 7,
          documentNonce: "6edbdb72-a002-4b13-b9ee-68d21ae36c34",
          environmentId: "production",
          environmentGeneration: 3,
        },
      },
    },
  ]);

  await page.evaluate(() => {
    history.pushState({}, "", "/spa-route");
    location.hash = "same-document";
  });
  await page.waitForTimeout(100);
  expect(
    await page.evaluate(
      () =>
        (
          window as typeof window & {
            __RAFT_DESKTOP_E2E_CALLS__: unknown[];
          }
        ).__RAFT_DESKTOP_E2E_CALLS__.length,
    ),
  ).toBe(1);
  await expect(
    page.locator("#raft-desktop-handshake-recovery"),
  ).toHaveCount(0);
});
