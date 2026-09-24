import { describe, expect, it, vi } from "vitest";
import { settlePageRoutes, withPageRoutes } from "./e2e/fixtures/routeLifecycle";

describe("e2e route lifecycle", () => {
  function routePage(unrouteAll: (options?: {
    behavior?: "default" | "wait" | "ignoreErrors";
  }) => Promise<void>) {
    return { unrouteAll: vi.fn(unrouteAll) };
  }

  it("releases held handlers before waiting and preserves route errors", async () => {
    const routeError = new Error("route handler failed");
    let released = false;
    const page = routePage(async (options) => {
      expect(released).toBe(true);
      expect(options).toEqual({ behavior: "wait" });
      throw routeError;
    });

    await expect(settlePageRoutes(page, () => {
      released = true;
    })).rejects.toBe(routeError);
    expect(page.unrouteAll).toHaveBeenCalledOnce();
  });

  it("settles routes after normal completion", async () => {
    let released = false;
    const page = routePage(async (options) => {
      expect(released).toBe(true);
      expect(options).toEqual({ behavior: "wait" });
    });

    await expect(withPageRoutes(page, async () => "done", () => {
      released = true;
    })).resolves.toBe("done");
    expect(page.unrouteAll).toHaveBeenCalledOnce();
  });

  it("settles routes after a test-body failure without replacing that failure", async () => {
    const testError = new Error("product assertion failed");
    let released = false;
    const page = routePage(async (options) => {
      expect(released).toBe(true);
      expect(options).toEqual({ behavior: "wait" });
    });

    await expect(withPageRoutes(page, async () => {
      throw testError;
    }, () => {
      released = true;
    })).rejects.toBe(testError);
    expect(page.unrouteAll).toHaveBeenCalledOnce();
  });

  it("preserves both failures when the test body and route cleanup fail", async () => {
    const testError = new Error("product assertion failed");
    const routeError = new Error("route handler failed");
    const page = routePage(async () => {
      throw routeError;
    });

    const failure = await withPageRoutes(page, async () => {
      throw testError;
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([testError, routeError]);
  });
});
