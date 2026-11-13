

// Pointer-down blur prevention for composer buttons (Android Chrome can
// collapse the keyboard on pointer-down blur before the click runs). Pure
// handlers — module scope so they are never recreated per render.
export const preventSendButtonPointerDownBlur = (e: React.PointerEvent<HTMLButtonElement>) => {
  // Android Chrome can collapse the keyboard on the pointer-down blur before
  // the submit click runs, shifting the visual viewport and swallowing the
  // first tap. Keep focus stable; the following click still submits.
  e.preventDefault();
};
export const preventToolbarButtonPointerDownBlur = (e: React.PointerEvent<HTMLButtonElement>) => {
  // Toolbar buttons sit beside the textarea. Preserve focus through
  // pointerdown so Android Chrome does not collapse the keyboard before the
  // button click opens the picker or toggles composer state.
  e.preventDefault();
};
export const preventTaskTogglePointerDownBlur = (e: React.PointerEvent<HTMLElement>) => {
  // Keep the composer focused while toggling task mode; the following click
  // still toggles the checkbox without sending.
  e.preventDefault();
};
