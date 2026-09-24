import assert from "node:assert/strict";
import { test } from "vitest";
import { emitPlatformScopedUserEvent, socketClientKindRoom } from "./platformScope.js";

function createIoRecorder() {
  const events: { room: string; event: string; payload: unknown }[] = [];
  const io = {
    to(room: string) {
      return {
        emit(event: string, payload: unknown) {
          events.push({ room, event, payload });
        },
      };
    },
  };
  return { io: io as never, events };
}

test("notification:push is declaration-filtered to mobile clientKind rooms", () => {
  const { io, events } = createIoRecorder();

  emitPlatformScopedUserEvent(io, "user-1", "notification:push", { messageId: "msg-1" });

  assert.deepEqual(events, [
    {
      room: socketClientKindRoom("user-1", "mobile"),
      event: "notification:push",
      payload: { messageId: "msg-1" },
    },
  ]);
  assert.equal(
    events.some((event) => event.room === "user:user-1"),
    false,
    "unfiltered user-room emission would deliver notification:push to web sockets too",
  );
  assert.equal(
    events.some((event) => event.room === socketClientKindRoom("user-1", "web")),
    false,
    "web clientKind sockets must not receive mobile-scoped notification:push",
  );
});

test("events without platformScope keep the existing all-platform user-room behavior", () => {
  const { io, events } = createIoRecorder();

  emitPlatformScopedUserEvent(io, "user-1", "message:new", { messageId: "msg-1" });

  assert.deepEqual(events, [
    {
      room: "user:user-1",
      event: "message:new",
      payload: { messageId: "msg-1" },
    },
  ]);
});
