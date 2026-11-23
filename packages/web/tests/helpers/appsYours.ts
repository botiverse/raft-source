import assert from "node:assert/strict";
import { fireEvent, screen, waitFor } from "@testing-library/react";

/** Yours, the scope the Apps page opens on: selects it and returns its list. */
export async function openYours(): Promise<HTMLElement> {
  fireEvent.click(await screen.findByTestId("connected-apps-tab-yours"));
  return screen.findByTestId("connected-apps-yours-tab");
}

/** The cover button of an App's card under Yours (the card opens what the App's row opened). */
export function yoursCard(yours: HTMLElement, name?: string): HTMLElement {
  const cards = Array.from(yours.querySelectorAll<HTMLElement>("[data-app-card-open]"));
  const named = name === undefined ? cards : cards.filter((card) => card.getAttribute("aria-label") === name);
  assert.equal(named.length, 1, `expected one card${name ? ` named ${name}` : ""}, got: ${cards.map((card) => card.getAttribute("aria-label")).join(", ")}`);
  return named[0]!;
}

/**
 * Opens the editor of an App built here from Yours' cards. A card has no
 * Edit button: an App this Server hasn't installed opens its editor from the
 * card itself; one it has installed opens its installed detail, whose Edit
 * opens the editor.
 */
export async function openOwnAppEditor(name?: string): Promise<HTMLElement> {
  const yours = await openYours();
  await waitFor(() => assert.ok(yours.querySelector("[data-app-card-open]"), "Yours has no card yet"));
  fireEvent.click(yoursCard(yours, name));
  await waitFor(() => assert.ok(
    screen.queryByTestId("connected-app-editor") ?? screen.queryByTestId("connected-app-installed-edit"),
    "the card opened neither the editor nor an installed detail with Edit",
  ));
  const edit = screen.queryByTestId("connected-app-installed-edit");
  if (edit) fireEvent.click(edit);
  return screen.findByTestId("connected-app-editor");
}
