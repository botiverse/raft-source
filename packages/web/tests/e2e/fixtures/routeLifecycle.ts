import type { Page } from "@playwright/test";

type RoutablePage = Pick<Page, "unrouteAll">;

export async function settlePageRoutes(
  page: RoutablePage,
  releaseHeldRoutes?: () => void,
): Promise<void> {
  releaseHeldRoutes?.();
  await page.unrouteAll({ behavior: "wait" });
}

export async function withPageRoutes<T>(
  page: RoutablePage,
  run: () => Promise<T>,
  releaseHeldRoutes?: () => void,
): Promise<T> {
  let runFailed = false;
  let runError: unknown;
  try {
    return await run();
  } catch (error) {
    runFailed = true;
    runError = error;
    throw error;
  } finally {
    try {
      await settlePageRoutes(page, releaseHeldRoutes);
    } catch (routeError) {
      if (runFailed) {
        throw new AggregateError(
          [runError, routeError],
          "Test body and route cleanup both failed",
        );
      }
      throw routeError;
    }
  }
}
