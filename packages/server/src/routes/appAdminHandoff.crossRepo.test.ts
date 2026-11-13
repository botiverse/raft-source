import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '../db/index';
import { oauthClients, oauthAgentAutoGrantBlocks } from '../db/schema';
import { createAgent } from '../services/agentService';
import { mintAgentCredential } from '../services/agentCredentialService';
import { approveAccessRequest, createOAuthClient } from '../services/oauthService';
import { createApiTest } from '../test/integration/apiTest';

const test = createApiTest();
test.skipIf(!process.env.APP_ADMIN_WORKER_ENTRY)('actual CLI, Worker and issuer complete a bound v1 login, and replay fails', async ({app,seed}) => {
 const {default: worker} = await import(process.env.APP_ADMIN_WORKER_ENTRY!);
 const { ApiClient }=await import('../../../cli/src/client');
 const { createCommandContext }=await import('../../../cli/src/core/context');
 const { integrationLoginCommand }=await import('../../../cli/src/commands/integration/login');
 const { setCanonicalFetchImplForTests }=await import('../../../cli/src/proxy');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'cardy-handoff-e2e-'));
 const owner=await seed.human(); const server=await seed.server({owner});
 const {client,clientSecret}=await createOAuthClient({serverId:server.id,createdByUserId:owner.id,clientId:'slock-internal-app-admin',name:'Admin fixture',returnUrl:'https://admin.test/auth/callback'});
 await getDb().update(oauthClients).set({agentHandoffProtocol:'v1'}).where(eq(oauthClients.id,client.id));
 const agent=await createAgent(server.id,`e2e-${randomUUID().slice(0,8)}`,{runtime:'codex'});
 await getDb().insert(oauthAgentAutoGrantBlocks).values({agentId:agent.id,clientId:client.id,serverId:server.id,blockedByUserId:owner.id});
 const {apiKey}=await mintAgentCredential({agentId:agent.id,scopes:['read','send'],name:'test',issuedVia:'computer',createdByUserId:null});
 const realFetch=globalThis.fetch;
 globalThis.fetch=async (input,init) => {
   const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);
   if (url.origin==='https://issuer.test') {
     url.protocol='http:'; const actual=new URL(app.baseUrl); url.host=actual.host;
     return realFetch(url,init);
   }
   return realFetch(input,init);
 };
 const env={APP_ADMIN_PUBLIC_ORIGIN:'https://admin.test',SLOCK_SERVER_ORIGIN:'https://issuer.test',SLOCK_CLIENT_ID:client.clientId,SLOCK_CLIENT_SECRET:clientSecret,APP_ADMIN_SESSION_SECRET:'synthetic-session-key-0123456789abcdef',SLOCK_ALLOWED_SERVER_IDS:server.id};
 let sentCode=''; let sentVerifier='';
 const previous=setCanonicalFetchImplForTests(async(input,init)=>{
   const request=new Request(input as string,init as RequestInit);
   if (new URL(request.url).pathname==='/auth/agent/complete') {
     const payload=await request.clone().json() as {code:string;verifier:string}; sentCode=payload.code; sentVerifier=payload.verifier;
     const attack=await worker.fetch(new Request('https://admin.test/auth/agent/complete',{method:'POST',headers:{'content-type':'application/json','x-raft-agent-handoff':'v1'},body:JSON.stringify({code:sentCode,verifier:'Z'.repeat(43)})}),env);
     assert.equal(attack.status,401,'another reader cannot redeem first with the public ID');
   }
   return worker.fetch(request,env);
 });
 const output:string[]=[];
 const agentContext={agentId:agent.id,serverId:null,serverUrl:app.baseUrl,token:apiKey,clientMode:'self-hosted-runner' as const,secretSource:'profile-credential-file' as const,activeCapabilities:null,profileCredentialPath:path.join(root,'credential.json')};
 const ctx=createCommandContext({io:{stdout:{write:(v)=>{output.push(String(v));return true}},stderr:{write:(v)=>{output.push(String(v));return true}}},env:{HOME:root} as NodeJS.ProcessEnv,loadAgentContext:()=>agentContext,createApiClient:()=>new ApiClient(agentContext)});
 try {
  await integrationLoginCommand.handler(ctx,{service:client.clientId,json:true});
  const pending=JSON.parse(output.join('')).data;
  assert.equal(pending.status,'approval_required');
  assert.ok(pending.requestId); assert.equal(sentCode,'');
  const files=fs.readdirSync(path.join(root,'integrations')).filter(name=>name.startsWith('.handoff-'));
  assert.equal(files.length,1);
  assert.equal(fs.statSync(path.join(root,'integrations',files[0]!)).mode & 0o777,0o600);
  await approveAccessRequest({serverId:server.id,requestId:pending.requestId,resolvedByUserId:owner.id,remember:false});
  output.length=0;
  await integrationLoginCommand.handler(ctx,{service:client.clientId,json:true});
  assert.equal(JSON.parse(output.join('')).data.session.authentication,'verified');
  assert.equal(fs.existsSync(path.join(root,'integrations',files[0]!)),false);
  assert.equal(sentCode,pending.requestId, 'the approved request was resumed, not replaced');
  assert.ok(sentCode);
  const cookie=JSON.parse(fs.readFileSync(path.join(root,'integrations',`${client.clientId}.json`),'utf8'));
  assert.equal(cookie.handoff.agentId,agent.id); assert.equal(cookie.handoff.serverId,server.id);
  const replay=await worker.fetch(new Request('https://admin.test/auth/agent/complete',{method:'POST',headers:{'content-type':'application/json','x-raft-agent-handoff':'v1'},body:JSON.stringify({code:sentCode,verifier:sentVerifier})}),env);
  assert.equal(replay.status,401);
 } finally {globalThis.fetch=realFetch; setCanonicalFetchImplForTests(previous); fs.rmSync(root,{recursive:true,force:true});}
});
