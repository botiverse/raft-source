import { createRequire } from "node:module";
import {
  afterAll,
  afterEach as vitestAfterEach,
  beforeAll,
  beforeEach as vitestBeforeEach,
  describe,
  expect,
  test as vitestTest,
} from "vitest";
import type {
  RunnerTestCase,
  TaskContext,
  TestContext as VitestTestContext,
} from "vitest";

const nativeTest = createRequire(import.meta.url)("node:test") as typeof import("node:test");
const nativeMock = nativeTest.mock;

type Cleanup = () => void | Promise<void>;

interface NodeTestCompatContext {
  assert: {
    snapshot: (value: unknown, message?: string) => void;
  };
  mock: typeof nativeMock;
  after: (fn: Cleanup) => void;
}

type VitestRuntimeContext = TaskContext<RunnerTestCase> & VitestTestContext;

export type TestContext = VitestRuntimeContext & NodeTestCompatContext;

type TestRegistrar = (...args: unknown[]) => unknown;

function withNodeContext(context: VitestRuntimeContext): TestContext {
  return Object.assign(context, {
    assert: {
      snapshot: (value: unknown, message?: string) => expect(value).toMatchSnapshot(message),
    },
    mock: nativeMock,
    after: (fn: Cleanup) => context.onTestFinished(async () => fn()),
  });
}

function wrapTest(api: TestRegistrar) {
  return (...rawArgs: unknown[]) => {
    const args = [...rawArgs];
    const callbackIndex = args.length - 1;
    const callback = args[callbackIndex];
    if (typeof callback === "function") {
      args[callbackIndex] = (context: VitestRuntimeContext) => callback(withNodeContext(context));
    }
    return api(...args);
  };
}

const test = Object.assign(
  wrapTest(vitestTest as unknown as TestRegistrar),
  {
    after: afterAll,
    afterEach: vitestAfterEach,
    before: beforeAll,
    beforeEach: vitestBeforeEach,
  },
);

// Node's per-test MockTracker restores automatically. The tracker exposed by
// node:test outside its runner is process-scoped, so restore it at the same
// boundary while Vitest reuses worker processes across files.
vitestAfterEach(() => {
  nativeMock.timers.reset();
  nativeMock.restoreAll();
});

const it = test;
const after = afterAll;
const afterEach = vitestAfterEach;
const before = beforeAll;
const beforeEach = vitestBeforeEach;

export { after, afterEach, before, beforeEach, describe, it, nativeMock as mock, test };
export default test;
