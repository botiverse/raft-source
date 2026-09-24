import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import "./helpers/domSetup";
import { Suspense } from "react";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import {
  DEFAULT_COPY_FEEDBACK_TIMEOUT_MS,
  useCopyText,
} from "../src/hooks/useCopyText";
import type {
  CopyTextDependencies,
} from "../src/hooks/useCopyText";
import { copyTextToClipboard } from "../src/utils/selectMarkdown";

afterEach(cleanup);

function fakeDependencies() {
  let nextHandle = 1;
  const copiedTexts: string[] = [];
  const pending = new Map<number, { callback: () => void; delayMs: number }>();
  const cleared: number[] = [];
  const dependencies: CopyTextDependencies = {
    async copyText(text) {
      copiedTexts.push(text);
    },
    scheduleReset(callback, delayMs) {
      const handle = nextHandle;
      nextHandle += 1;
      pending.set(handle, { callback, delayMs });
      return handle;
    },
    clearReset(handle) {
      const numericHandle = Number(handle);
      cleared.push(numericHandle);
      pending.delete(numericHandle);
    },
  };
  const fire = (handle: number) => {
    const task = pending.get(handle);
    assert.ok(task, `missing pending copy reset ${handle}`);
    pending.delete(handle);
    task.callback();
  };
  return { cleared, copiedTexts, dependencies, fire, pending };
}

test("text copy shares one restartable, identity-bound lifecycle", async () => {
  const fake = fakeDependencies();
  const hook = renderHook(
    ({ resetKey, timeoutMs }) => useCopyText({ resetKey, timeoutMs }, fake.dependencies),
    { initialProps: { resetKey: "alpha", timeoutMs: DEFAULT_COPY_FEEDBACK_TIMEOUT_MS } },
  );

  assert.equal(hook.result.current.copied, false);
  await act(async () => {
    await hook.result.current.copyText("first");
  });
  assert.equal(hook.result.current.copied, true);
  assert.deepEqual(fake.copiedTexts, ["first"]);
  assert.equal(fake.pending.get(1)?.delayMs, DEFAULT_COPY_FEEDBACK_TIMEOUT_MS);

  await act(async () => {
    await hook.result.current.copyText("second");
  });
  assert.deepEqual(fake.cleared, [1], "repeat copy must replace the old reset");
  assert.deepEqual(fake.copiedTexts, ["first", "second"]);
  assert.equal(fake.pending.has(1), false);
  assert.equal(fake.pending.get(2)?.delayMs, DEFAULT_COPY_FEEDBACK_TIMEOUT_MS);

  act(() => fake.fire(2));
  assert.equal(hook.result.current.copied, false);

  await act(async () => {
    await hook.result.current.copyText("third");
  });
  hook.rerender({ resetKey: "beta", timeoutMs: 2_000 });
  assert.equal(hook.result.current.copied, false, "new identity must not inherit copied feedback");
  assert.deepEqual(fake.cleared, [1, 3]);

  await act(async () => {
    await hook.result.current.copyText("diagnostic");
  });
  assert.equal(fake.pending.get(4)?.delayMs, 2_000, "callers retain their existing feedback duration");
  hook.unmount();
  assert.deepEqual(fake.cleared, [1, 3, 4], "unmount must clear the pending reset");
  assert.equal(fake.pending.size, 0);
});

test("failed text copy clears feedback and does not schedule a reset", async () => {
  const fake = fakeDependencies();
  fake.dependencies.copyText = async () => {
    throw new Error("denied");
  };
  const hook = renderHook(() => useCopyText({ resetKey: "source" }, fake.dependencies));

  await assert.rejects(async () => {
    await act(async () => {
      await hook.result.current.copyText("source");
    });
  }, /denied/);
  assert.equal(hook.result.current.copied, false);
  assert.equal(fake.pending.size, 0);
});

test("clipboard pending disables duplicate writes and always unlocks on a result", async () => {
  const fake = fakeDependencies();
  let resolveCopy: (() => void) | null = null;
  let rejectCopy: ((error: Error) => void) | null = null;
  fake.dependencies.copyText = (text) => {
    fake.copiedTexts.push(text);
    return new Promise<void>((resolve, reject) => {
      resolveCopy = resolve;
      rejectCopy = reject;
    });
  };
  const hook = renderHook(() => useCopyText({ resetKey: "source" }, fake.dependencies));

  let firstCopy: Promise<void> | null = null;
  act(() => {
    firstCopy = hook.result.current.copyText("first");
  });
  assert.equal(hook.result.current.pending, true);
  await act(async () => {
    await hook.result.current.copyText("duplicate");
  });
  assert.deepEqual(fake.copiedTexts, ["first"], "pending copy must reject a second clipboard write");
  assert.equal(hook.result.current.pending, true);

  await act(async () => {
    resolveCopy?.();
    await firstCopy;
  });
  assert.equal(hook.result.current.pending, false, "success must restore the copy control");
  assert.equal(hook.result.current.copied, true);

  let failedCopy: Promise<void> | null = null;
  act(() => {
    failedCopy = hook.result.current.copyText("failed");
  });
  assert.equal(hook.result.current.pending, true);
  let copyError: unknown = null;
  await act(async () => {
    rejectCopy?.(new Error("denied"));
    try {
      await failedCopy;
    } catch (error) {
      copyError = error;
    }
  });
  assert.match(String(copyError), /denied/);
  assert.equal(hook.result.current.pending, false, "failure must restore the copy control");
  assert.equal(hook.result.current.copied, false);
});

test("an aborted resetKey render cannot cancel the committed identity reset", async () => {
  const fake = fakeDependencies();
  const suspended = new Promise<never>(() => {});

  function CopyHarness({ resetKey, suspend }: { resetKey: string; suspend: boolean }) {
    const controller = useCopyText({ resetKey }, fake.dependencies);
    if (suspend) throw suspended;
    return (
      <button type="button" onClick={() => void controller.copyText(resetKey)}>
        {controller.copied ? "Copied" : `Copy ${resetKey}`}
      </button>
    );
  }

  const view = render(
    <Suspense fallback={<div>Loading</div>}>
      <CopyHarness resetKey="alpha" suspend={false} />
    </Suspense>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Copy alpha" }));
  await waitFor(() => assert.ok(screen.getByRole("button", { name: "Copied" })));
  assert.equal(fake.pending.has(1), true);

  view.rerender(
    <Suspense fallback={<div>Loading</div>}>
      <CopyHarness resetKey="beta" suspend />
    </Suspense>,
  );
  assert.deepEqual(fake.cleared, [], "an uncommitted identity must not clear committed work");
  assert.equal(fake.pending.has(1), true);

  view.rerender(
    <Suspense fallback={<div>Loading</div>}>
      <CopyHarness resetKey="alpha" suspend={false} />
    </Suspense>,
  );
  act(() => fake.fire(1));
  assert.ok(screen.getByRole("button", { name: "Copy alpha" }));
});

test("clipboard fallback rejects execCommand false and removes its textarea", async () => {
  const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  const originalExecCommand = document.execCommand;
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
  document.execCommand = () => false;

  try {
    await assert.rejects(copyTextToClipboard("source"), /rejected the clipboard copy command/);
    assert.equal(document.querySelector("textarea"), null);
  } finally {
    if (clipboardDescriptor) Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
    else Reflect.deleteProperty(navigator, "clipboard");
    document.execCommand = originalExecCommand;
  }
});
