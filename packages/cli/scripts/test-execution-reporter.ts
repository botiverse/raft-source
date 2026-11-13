import { appendFileSync } from "node:fs";

// Vitest reporter that records every test case that actually reached a result,
// one JSON line per case, so run-tests-with-manifest.ts can prove no test was
// silently dropped. The event log path comes from the runner via env.
//
// Cases are written once their module ends, walked in declaration order. The
// order in which Vitest delivers onTestCaseResult is not stable (worker task
// updates arrive batched and are reported asynchronously), so recording on
// that hook made the manifest's ordered name list flake between runs.
export default class TestExecutionReporter {
  constructor() {
    this.eventLogPath = process.env.RAFT_CLI_TEST_EVENT_LOG;
    if (!this.eventLogPath) {
      throw new Error("RAFT_CLI_TEST_EVENT_LOG must name the event log file");
    }
  }

  onTestModuleEnd(testModule) {
    for (const testCase of testModule.children.allTests()) {
      const state = testCase.result().state;
      // "pending" never reached a result; leave it out so a dropped case
      // still shows up as a count mismatch.
      if (state === "pending") continue;
      appendFileSync(this.eventLogPath, `${JSON.stringify({
        type: state === "failed" ? "test:fail" : "test:pass",
        file: testCase.module.moduleId,
        name: testCase.name,
        skip: state === "skipped" ? true : null,
      })}\n`);
    }
  }
}
