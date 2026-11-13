import assert from 'node:assert/strict';
import { and, eq } from 'drizzle-orm';
import { createApiTest } from '../test/integration/apiTest';
import { getDb } from '../db/index';
import { channelHumans } from '../db/schema';
import { seedBoundGuest } from '../test/guestFixture';
import { createMessage } from '../services/messageService';
import { getFollowedThreads } from '../services/channelService';
import { seedThreadFixture, headers, recordTestInboxFact } from './channels.api.fixtures';
const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });
test('review: revoked Guest thread must disappear from Activity', async ({app}) => {
 const f = await seedThreadFixture(app.baseUrl);
 // The follower is a Guest of the thread's parent channel, its one channel (#wg-rbac:#15).
 await seedBoundGuest({serverId:f.serverId,userId:f.followerId,channelId:f.parentChannelId});
 const reply = await createMessage(f.threadId,'user',f.ownerId,'secret-review-thread-reply');
 await recordTestInboxFact({serverId:f.serverId,receiverId:f.followerId,kind:'thread',sourceChannelId:f.threadId,message:reply});
 const h = headers(f.followerToken,f.serverId);
 const read = async (path:string) => { const r=await fetch(`${app.baseUrl}/api/${path}`,{headers:h}); return {status:r.status,body:await r.json()}; };
 const directBefore=await read(`messages/channel/${f.threadId}`);
 assert.equal(directBefore.status,200,'same direct endpoint must work before revocation');
 const before=await read('channels/inbox?filter=all');
 assert.equal(before.status,200);
 assert.ok(JSON.stringify(before.body).includes(f.threadId),'positive control must contain followed thread');
 // Removed from its channel: the Guest's access ends.
 await getDb().delete(channelHumans).where(and(eq(channelHumans.channelId,f.parentChannelId),eq(channelHumans.userId,f.followerId)));
 const transactionVisibleThreads = await getDb().transaction((executor) => getFollowedThreads(
  f.serverId,
  f.followerId,
  undefined,
  { executor },
 ));
 assert.ok(
  !transactionVisibleThreads.some((thread) => thread.threadChannelId === f.threadId),
  'caller-owned transaction must retain Guest revocation while filtering followed threads',
 );
 const direct=await read(`messages/channel/${f.threadId}`);
 const newSend=await fetch(`${app.baseUrl}/api/messages`,{method:'POST',headers:headers(f.ownerToken,f.serverId),body:JSON.stringify({channelId:f.threadId,content:'new-secret-after-guest-revocation'})});
 assert.equal(newSend.status,200, JSON.stringify(await newSend.json()));
 const all=await read('channels/inbox?filter=all');
 const unread=await read('channels/inbox?filter=unread');
 assert.equal(direct.status,403,'direct read denied after revocation');
 assert.equal(all.status,200);
 assert.ok(!JSON.stringify(all.body).includes(f.threadId),'inaccessible thread must not remain in Activities');
 assert.equal(unread.status,200);
 assert.ok(!JSON.stringify(unread.body).includes(f.threadId),'inaccessible thread must not remain in Unread');
});
