import { completionBindingCookie, socialCompletionBinding } from "../../services/completionBrowserBinding";

/**
 * The Cookie header the browser that got a web social completion code sends
 * with POST /api/auth/:provider/complete (the binding its callback left).
 * For tests that mint a completion without going through the callback.
 */
export function socialCompletionCookie(provider: string, code: string): string {
  return completionBindingCookie(socialCompletionBinding(provider), code, 60).split(";")[0]!;
}
