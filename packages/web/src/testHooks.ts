// E2E test hooks — exposed on `window.__SLOCK_E2E__` ONLY when the bundle is
// built with `VITE_E2E=true` (the Playwright e2e build). Production / CF Pages
// builds omit the flag, so this object is never attached and the imports below
// add no runtime behavior beyond what the app already bundles.
//
// Why this exists: the e2e suite previously reached into app internals via
// `page.evaluate(() => import("/src/store/messageStore.ts"))`, which only works
// against the Vite *dev* server (it serves `/src/*` modules over HTTP). Once the
// e2e webServer switched to `vite preview` (built static `/assets/*.js`, to kill
// the dynamic-import-reject flake under the ECONNRESET storm), those `/src`
// imports 404. Exposing the needed APIs through an explicit, build-gated hook is
// both preview-compatible and a cleaner contract than coupling specs to source
// module paths.
import { useMessageStore } from "./store/messageStore";
import { captureSelectedMessages } from "./utils/selectScreenshot";

declare global {
  interface Window {
    __SLOCK_E2E__?: {
      loadMessages: (channelId: string) => Promise<void>;
      captureSelectedMessages: typeof captureSelectedMessages;
    };
  }
}

if (import.meta.env.VITE_E2E === "true") {
  // `loadMessages` is wrapped rather than exposing the store getState() surface,
  // so specs can refresh messages without reaching setState / other store ops.
  window.__SLOCK_E2E__ = {
    loadMessages: (channelId) => useMessageStore.getState().loadMessages(channelId),
    captureSelectedMessages,
  };
}
