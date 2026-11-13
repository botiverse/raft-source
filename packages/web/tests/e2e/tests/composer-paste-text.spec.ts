import { expect, test } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";
import { loginViaApi } from "../fixtures/auth";
import { waitForSeedState } from "../fixtures/seedState";
import type { PlaywrightSeedState } from "../fixtures/seedState";

// Task #777 (Typeless users lose dictated sentences): Chrome inserts a paste
// by reading the clipboard a second time after the paste event. Typeless
// pastes, then puts the old clipboard back; when that lands between the two
// reads, Chrome inserts nothing (the user's trace: a paste with text, a
// beforeinput with null data, no input). The composer now inserts the paste
// event's own text, so the browser's second read no longer matters.
//
// A paste event dispatched from script is exactly the failing case: it
// carries the text, and the browser inserts nothing after it.

async function dismissOwnerOnboarding(
  request: APIRequestContext,
  seedState: PlaywrightSeedState,
  accessToken: string,
) {
  const response = await request.patch(
    `${seedState.urls.api}/api/servers/${seedState.server.id}/onboarding-settings`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "X-Server-Id": seedState.server.id,
      },
      data: { setupModalReminderOptOut: true },
    },
  );
  if (!response.ok()) {
    throw new Error(
      `Failed to opt out of onboarding modal: ${response.status()} ${response.statusText()}`,
    );
  }
}

async function openComposer(page: Page, request: APIRequestContext) {
  const seedState = await waitForSeedState();
  const login = await loginViaApi(request, seedState);
  await dismissOwnerOnboarding(request, seedState, login.accessToken);
  await page.goto(`/s/${seedState.server.slug}/channel/${seedState.channel.id}`);
  await expect(page.getByTestId("message-scroller")).toBeVisible();
  const box = page.getByTestId("composer-textarea");
  await expect(box).toBeVisible();
  return box;
}

/** A paste the browser itself will not insert: only the composer can. */
async function pasteWithoutBrowserInsert(page: Page, text: string) {
  await page.getByTestId("composer-textarea").evaluate((field, value) => {
    const data = new DataTransfer();
    data.setData("text/plain", value);
    field.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }));
  }, text);
}

test.describe("composer text paste", () => {
  test("a dictated sentence goes in even when the browser's own insert never happens", async ({ page, request }) => {
    const box = await openComposer(page, request);
    await box.click();
    await page.keyboard.type("Hello ");

    await pasteWithoutBrowserInsert(page, "first sentence.\r\n");
    await expect(box).toHaveValue("Hello first sentence.\n");

    // The second dictation without sending or clicking: the user's lost case.
    await pasteWithoutBrowserInsert(page, "Second sentence.");
    await expect(box).toHaveValue("Hello first sentence.\nSecond sentence.");

    // It is a normal edit: the caret follows it, and undo takes each paste
    // back as its own step, apart from what was typed around it, as it does
    // for a native paste.
    await page.keyboard.type("!");
    await expect(box).toHaveValue("Hello first sentence.\nSecond sentence.!");
    await page.keyboard.press("ControlOrMeta+z");
    await expect(box).toHaveValue("Hello first sentence.\nSecond sentence.");
    await page.keyboard.press("ControlOrMeta+z");
    await expect(box).toHaveValue("Hello first sentence.\n");
    await page.keyboard.press("ControlOrMeta+z");
    await expect(box).toHaveValue("Hello ");
    await page.keyboard.press("ControlOrMeta+Shift+z");
    await expect(box).toHaveValue("Hello first sentence.\n");

    // Send sends what is in the box.

    await page.keyboard.press("Enter");
    await expect(page.getByTestId("message-scroller")).toContainText("Hello first sentence.");
    await expect(box).toHaveValue("");
  });

  test("a real ⌘V puts the text in once, in place of the selection", async ({ page, request, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const box = await openComposer(page, request);
    await box.click();
    await page.keyboard.type("keep REPLACE keep");
    await box.evaluate((field: HTMLTextAreaElement) => field.setSelectionRange(5, 12));
    await page.evaluate(() => navigator.clipboard.writeText("once"));

    await page.keyboard.press("ControlOrMeta+v");
    await expect(box).toHaveValue("keep once keep");
    await page.keyboard.press("ControlOrMeta+z");
    await expect(box).toHaveValue("keep REPLACE keep");
  });

  test("a paste longer than the box allows is cut to fit, never inside a character", async ({ page, request }) => {
    const box = await openComposer(page, request);
    await box.click();
    await page.keyboard.type("abc");
    await box.evaluate((field: HTMLTextAreaElement) => field.setAttribute("maxlength", "8"));
    // An emoji is two code units: cutting inside it would leave half a character.
    const tooLong = "defg\u{1F600}xyz";

    await pasteWithoutBrowserInsert(page, tooLong);
    await expect(box).toHaveValue("abcdefg");

    // The same where the browser refuses insertText and the composer writes
    // the text itself: maxlength does not clip that write, the composer does.
    await box.evaluate((field: HTMLTextAreaElement) => {
      field.value = "abc";
      field.setSelectionRange(3, 3);
      document.execCommand = () => false;
    });
    await pasteWithoutBrowserInsert(page, tooLong);
    await expect(box).toHaveValue("abcdefg");
  });

  test("where the browser refuses insertText, the paste still counts as input: @ opens the picker, Send sends", async ({ page, request }) => {
    const box = await openComposer(page, request);
    await page.evaluate(() => {
      document.execCommand = () => false;
    });
    await box.click();

    await pasteWithoutBrowserInsert(page, "fallback sentence @");
    await expect(box).toHaveValue("fallback sentence @");
    await expect(page.getByTestId("mention-autocomplete-popover")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.getByTestId("mention-autocomplete-popover")).toHaveCount(0);
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("message-scroller")).toContainText("fallback sentence @");
    await expect(box).toHaveValue("");
  });
});
