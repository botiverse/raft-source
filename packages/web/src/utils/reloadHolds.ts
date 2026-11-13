// What surfaces tell the automatic reload onto a new Web release
// (utils/reloadSafety, utils/webVersionCheck): work they hold, and what they
// put away right before it. No store imports, so a component (the message
// list, an action-card form) can use it without pulling the stores in.

// Work only a mounted component can see (a composer's picked or uploading
// attachments, As task or picked mentions; a form filled
// in that nothing keeps; env vars being edited): it holds the page while it
// has some, and lets go after.
let holds = 0;

/** Whether any surface holds the page now. */
export function hasReloadHolds(): boolean {
  return holds > 0;
}

/** Marks work in progress that a reload would lose; call the returned function once it is gone. */
export function holdReload(): () => void {
  holds += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds -= 1;
  };
}

// What a mounted surface puts away right before this tab reloads itself (the
// message list's spot, messageTimelineShared scroll memory), so the reloaded
// page opens where the person was.
const beforeReload = new Set<() => void>();

/** Runs `save` right before this tab reloads itself onto a new Web release; returns its removal. */
export function onBeforeReload(save: () => void): () => void {
  beforeReload.add(save);
  return () => {
    beforeReload.delete(save);
  };
}

/** Runs every surface's `save` (one failing does not stop the others). */
export function runBeforeReload(): void {
  for (const save of beforeReload) {
    try {
      save();
    } catch {
      // One surface's spot is not worth the others'.
    }
  }
}
