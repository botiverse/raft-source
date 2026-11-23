import assert from "node:assert/strict";
import { cleanup, fireEvent, screen } from "@testing-library/react";

import { AttachmentChipBody } from "../src/features/composer/AttachmentChipBody";
import { UploadFailureBanner } from "../src/features/composer/UploadFailureBanner";
import { renderWithIntl } from "./helpers/intl";

afterEach(cleanup);

// #triage:db62c967: with the text box focused, removing an attached image must
// not take the focus. Remove goes away with its chip, so focus it took would
// drop to the page. The press keeps the focus where it is (its mousedown's
// default, which is what moves the focus, is prevented); the click removes.
test("pressing an attachment's Remove keeps the focus in the text box and removes the file", () => {
  const removed: string[] = [];
  renderWithIntl(
    <div>
      <textarea aria-label="Message" />
      <AttachmentChipBody
        id="pending-1"
        preview={null}
        fileName="photo.png"
        mimeType="image/png"
        uploadStatus="ready"
        uploadProgress={100}
        attachmentId="att-1"
        listeners={undefined}
        onRemove={(id) => removed.push(id)}
        onPreviewError={() => {}}
      />
    </div>,
  );
  const textBox = screen.getByLabelText("Message");
  textBox.focus();
  const remove = screen.getByRole("button", { name: "Remove photo.png" });

  const notPrevented = fireEvent.mouseDown(remove);
  assert.equal(notPrevented, false, "Remove's mousedown is prevented, so the press does not move the focus");
  fireEvent.click(remove);

  assert.deepEqual(removed, ["pending-1"]);
  // A sanity check only: jsdom moves no focus on mousedown, so the mousedown
  // assertion above is the one that catches the regression.
  assert.ok(document.activeElement === textBox, "the text box keeps the focus");
});

// #triage:#507: a failed upload's banner goes away with every one of its
// buttons (Remove and Retry with Retry, the × without), so none of their
// presses may take the focus. Its text still selects normally.
test.each([
  { canRetry: true, buttons: ["Remove photo.png", "Retry uploading photo.png"] },
  { canRetry: false, buttons: ["Remove photo.png"] },
])("pressing a failed-upload banner button keeps the focus (canRetry=$canRetry)", ({ canRetry, buttons }) => {
  const removed: string[] = [];
  const retried: string[] = [];
  renderWithIntl(
    <div>
      <textarea aria-label="Message" />
      <UploadFailureBanner
        fileId="pending-1"
        fileName="photo.png"
        error="Network error"
        progress={0}
        canRetry={canRetry}
        onRetry={(id) => retried.push(id)}
        onRemove={(id) => removed.push(id)}
      />
    </div>,
  );
  const textBox = screen.getByLabelText("Message");
  textBox.focus();
  for (const name of buttons) {
    const button = screen.getByRole("button", { name });
    // A real press usually lands on the button's icon, not the button itself.
    const pressed = button.querySelector("svg") ?? button;
    assert.equal(fireEvent.mouseDown(pressed), false, `${name}: the press does not move the focus`);
    fireEvent.click(button);
  }
  assert.equal(fireEvent.mouseDown(screen.getByText("Network error")), true, "pressing the banner's text is left alone");
  assert.deepEqual(removed, ["pending-1"]);
  assert.deepEqual(retried, canRetry ? ["pending-1"] : []);
  // A sanity check only: jsdom moves no focus on mousedown, so the mousedown
  // assertions above are the ones that catch the regression.
  assert.ok(document.activeElement === textBox, "the text box keeps the focus");
});
