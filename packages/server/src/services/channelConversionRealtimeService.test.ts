import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import type { Server as SocketServer } from "socket.io";
import { getDb } from "../db/index";
import { actionCards, channelConversionJobs } from "../db/schema";
import { dbTest } from "../test/integration/dbTest";
import { emitActionCardMessageUpdated } from "./actionCardsService";
import { emitChannelConversionCardUpdates } from "./channelConversionRealtimeService";

vi.mock("./actionCardsService", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./actionCardsService")>()),
  emitActionCardMessageUpdated: vi.fn(async () => {}),
}));

const io = {} as SocketServer;

function emittedIds(): string[] {
  return vi.mocked(emitActionCardMessageUpdated).mock.calls.map(([, row]) => row.id).sort();
}

dbTest("conversion card replay: a finished or unrestored failed job replays its own cards, a canceled or restored one its source scope", async ({ seed }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const source = await seed.channel({ server, members: [owner] });
  const bound = await seed.message({ channel: source, author: owner, content: "bound card" });
  const unbound = await seed.message({ channel: source, author: owner, content: "unbound card" });
  const [job] = await getDb().insert(channelConversionJobs).values({
    serverId: server.id,
    sourceChannelId: source.id,
    sourceChannelType: "channel",
    status: "done",
  }).returning({ id: channelConversionJobs.id });
  for (const [message, conversionJobId] of [[bound, job!.id], [unbound, null]] as const) {
    await getDb().insert(actionCards).values({
      serverId: server.id,
      messageId: message.id,
      requesterUserId: owner.id,
      actionType: "channel:create",
      payload: {},
      conversionJobId,
    });
  }

  vi.mocked(emitActionCardMessageUpdated).mockClear();
  await emitChannelConversionCardUpdates(io, job!.id);
  assert.deepEqual(emittedIds(), [bound.id]);

  await getDb().update(channelConversionJobs).set({ status: "failed" }).where(eq(channelConversionJobs.id, job!.id));
  vi.mocked(emitActionCardMessageUpdated).mockClear();
  await emitChannelConversionCardUpdates(io, job!.id);
  assert.deepEqual(emittedIds(), [bound.id]);

  await getDb().update(channelConversionJobs).set({ progress: { rollbackState: "restored" } }).where(eq(channelConversionJobs.id, job!.id));
  vi.mocked(emitActionCardMessageUpdated).mockClear();
  await emitChannelConversionCardUpdates(io, job!.id);
  assert.deepEqual(emittedIds(), [bound.id, unbound.id].sort());

  await getDb().update(channelConversionJobs).set({ status: "canceled", progress: {} }).where(eq(channelConversionJobs.id, job!.id));
  vi.mocked(emitActionCardMessageUpdated).mockClear();
  await emitChannelConversionCardUpdates(io, job!.id);
  assert.deepEqual(emittedIds(), [bound.id, unbound.id].sort());

  vi.mocked(emitActionCardMessageUpdated).mockClear();
  await emitChannelConversionCardUpdates(io, "00000000-0000-4000-8000-000000000000");
  assert.deepEqual(emittedIds(), []);
});
