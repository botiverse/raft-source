import { describe, expect, it } from "vitest";

import type { Task } from "../src/store/taskStore";
import { getTaskStatusOptions } from "../src/components/task/taskStatusUi";

function optionIds(fields: Partial<Task>, taskV2: boolean) {
  const task = { status: "in_progress", isLegacy: false, ...fields } as Task;
  return getTaskStatusOptions(task, undefined, false, taskV2).map((option) => option.id);
}

describe("getTaskStatusOptions: in_review is retired for task v2", () => {
  it("is not offered on a server with task v2 on", () => {
    expect(optionIds({}, true)).toEqual(["backlog", "todo", "in_progress", "done", "closed"]);
  });

  it("stays the current option of a task still in it", () => {
    expect(optionIds({ status: "in_review" }, true)).toContain("in_review");
  });

  it("is offered as before on a legacy task and with task v2 off", () => {
    expect(optionIds({ isLegacy: true }, true)).toContain("in_review");
    expect(optionIds({}, false)).toContain("in_review");
  });
});

describe("getTaskStatusOptions: backlog is task v2 only, by the predicate that retires in_review", () => {
  it("is offered on a server with task v2 on, first, from any status", () => {
    expect(optionIds({ status: "todo" }, true)[0]).toBe("backlog");
    expect(optionIds({ status: "done" }, true)).toContain("backlog");
    expect(optionIds({ status: "in_review" }, true)).toContain("backlog");
  });

  it("is offered on a task made the v2 way with the flag off", () => {
    expect(optionIds({ conversationChannelId: "conversation-1" }, false)).toContain("backlog");
  });

  it("is not offered on a pre-v2 task with the flag off, nor on a legacy task", () => {
    expect(optionIds({}, false)).not.toContain("backlog");
    expect(optionIds({ isLegacy: true }, true)).not.toContain("backlog");
  });

  it("stays the current option of a task already in it", () => {
    expect(optionIds({ status: "backlog" }, false)).toContain("backlog");
  });
});
