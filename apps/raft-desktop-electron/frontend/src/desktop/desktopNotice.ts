// Imperative desktop notices (error/info/warning/success toasts) for desktop-only
// flows that run outside React — e.g. the OAuth renderer half, which otherwise
// fails silently to the console.
//
// It's backed by the app's shared top-center toast surface (forwardToast is just
// that manager instance; the "forward" name is incidental, and its provider is
// already mounted in the desktop tree — main.tsx's ForwardToastProvider). Aliased
// here so call sites read as desktop notices and we can swap the backing surface
// later without touching them.
import { forwardToast } from "@web/components/message/forwardToast";

export const desktopNotice = forwardToast;
