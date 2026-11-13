// The tab's one navigation, to the ticket, as an outcome: never a thrown value. A browser's
// navigation error says the URL it failed on (puppeteer's "net::ERR_… at <url>",
// "Navigation timeout … exceeded", a `cause`, a stack), so nothing of the error is kept but its
// kind (report.ts errorClassOf). Puppeteer-free, so the tests drive it (browser.ts passes
// `page.goto` and puppeteer's TimeoutError check).
import type { OpenResult } from "./checkPage";
import { errorClassOf } from "./report";

export async function openWith(goto: () => Promise<{ status(): number } | null>, isTimeout: (error: unknown) => boolean): Promise<OpenResult> {
  try {
    const response = await goto();
    return { kind: "loaded", status: response === null ? null : response.status() };
  } catch (error) {
    let timeout = false;
    try {
      timeout = isTimeout(error);
    } catch {
      timeout = false;
    }
    if (timeout) return { kind: "timeout" };
    const errorClass = errorClassOf(error, "navigation_failed");
    return errorClass === "timeout" ? { kind: "timeout" } : { kind: "error", errorClass };
  }
}
