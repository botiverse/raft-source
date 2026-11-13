// Production-artifact regression: run after build:feedback. Only synthetic data.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
const root = resolve('dist');
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const file = resolve(root, '.' + url.pathname + (url.pathname.endsWith('/') ? 'index.html' : ''));
  if (!file.startsWith(root + '/')) { res.writeHead(403).end(); return; }
  try { const body = await readFile(file); res.setHeader('Content-Type', ({'.js':'text/javascript','.css':'text/css','.html':'text/html'})[extname(file)] ?? 'application/octet-stream'); res.end(body); }
  catch { res.writeHead(404).end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const apiOrigin = process.env.FEEDBACK_TEST_API_ORIGIN ?? origin;
const browser = await chromium.launch();
try {
  for (const [theme,mode] of [['brutal','light'],['elegant','light'],['elegant','dark']]) {
    const page = await browser.newPage({viewport:{width:390,height:844}});
    await page.addInitScript(({theme,mode,apiOrigin})=>{window.__events=[];window.RaftFeedback={version:'raft-feedback-v1',session:{accountId:'synthetic',sessionGeneration:1,webViewGeneration:1,accessToken:'synthetic-token',apiOrigin,clientKind:'android',clientVersion:'1',locale:'en',theme,mode},emit:(event,binding)=>window.__events.push({event,binding})};},{theme,mode,apiOrigin});
    let postCount=0;const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/api/product-feedback**',async r=>{
      assert.equal(r.request().headers()['x-raft-client-kind'],'android');
      if(r.request().method()==='POST') {postCount++; await r.fulfill({status:401,json:{code:'auth_required'}});return;}
      await r.fulfill({json:{tickets:[{id:'fixture',kind:'feedback',status:'open',message:'A long synthetic feedback title that must wrap inside a narrow phone screen '+ 'x'.repeat(100),created_at:1700000000000,updated_at:1700000000000,unread:false,unread_count:0,attachment_count:0,comment_count:0}],next_cursor:null,unread_total:0}});
    });
    await page.goto(origin+'/feedback/');
    await page.locator('.hands-feedback-ticket-row').waitFor();
    const bounds=await page.locator('.hands-feedback-ticket-row').boundingBox();assert(bounds.x+ bounds.width<=390);
    await page.getByRole('button',{name:'New feedback',exact:true}).click();
    const text=page.locator('textarea');await text.fill('Synthetic draft survives native auth refresh');
    await page.evaluate(()=>{window.RaftFeedback.session.accessToken='rotated-token';window.dispatchEvent(new Event('raft:feedback-session-updated'));});
    await text.waitFor();assert.equal(await text.inputValue(),'Synthetic draft survives native auth refresh');
    await page.getByRole('button',{name:'Send feedback',exact:true}).click();
    await page.waitForFunction(()=>window.__events.some(x=>x.event==='auth-required'));
    assert.equal(await text.inputValue(),'Synthetic draft survives native auth refresh');assert.equal(postCount,1);
    const overlayStyle = await page.locator('.feedback-auth-status').evaluate(el => { const c=document.createElement('canvas');c.width=c.height=1;const ctx=c.getContext('2d');ctx.fillStyle=getComputedStyle(el).backgroundColor;ctx.fillRect(0,0,1,1);return {background:getComputedStyle(el).backgroundColor,color:getComputedStyle(el).color,rgba:Array.from(ctx.getImageData(0,0,1,1).data)}; });
    assert.equal(overlayStyle.rgba[3],255);assert.notEqual(overlayStyle.background, overlayStyle.color);
    await page.evaluate(()=>{window.RaftFeedback.session.accessToken='refreshed-token';window.dispatchEvent(new Event('raft:feedback-session-updated'));});
    await page.getByRole('button',{name:'Send feedback',exact:true}).waitFor();assert.equal(await text.inputValue(),'Synthetic draft survives native auth refresh');
    await page.getByRole('alert').getByText('Your draft is kept. After signing in, submit again when ready.', {exact:true}).waitFor();
    assert.equal(await page.getByText('Your feedback session expired. Reopen feedback and try again.', {exact:true}).count(),0);
    assert.equal(await page.evaluate(()=>window.__events.filter(x=>x.event==='ready').length),1);
    assert.deepEqual(errors,[]);console.log(`${theme}/${mode}: long card fits; refresh and 401 preserve draft; no retry`);await page.close();
  }
  // Opened from a feedback:submit card: its draft prefilled and editable, sent as the card's
  // submission from its server, then its ticket; a draft that cannot be read opens the page as usual.
  const card = '11111111-1111-4111-8111-111111111111', cardServer = '22222222-2222-4222-8222-222222222222', ticket = '33333333-3333-4333-8333-333333333333';
  for (const readable of [true, false]) {
    const page = await browser.newPage({viewport:{width:390,height:844}});
    await page.addInitScript(({apiOrigin})=>{window.RaftFeedback={version:'raft-feedback-v1',session:{accountId:'synthetic',sessionGeneration:1,webViewGeneration:1,accessToken:'synthetic-token',apiOrigin,clientKind:'android',clientVersion:'1',locale:'en',theme:'raft',mode:'light'},emit:()=>{}};},{apiOrigin});
    const posts=[];const paths=[];const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/api/product-feedback**',async r=>{
      const request=r.request();const path=new URL(request.url()).pathname;paths.push(path);
      assert.equal(request.headers()['x-raft-client-kind'],'android');
      if(path===`/api/product-feedback/action-card/${card}`){
        assert.equal(request.headers()['x-server-id'],cardServer);
        if(readable) await r.fulfill({json:{message_id:card,feedback_type:'idea',message:'Synthetic agent draft',confirmation_version:2}});
        else await r.fulfill({status:404,json:{error:'Feedback card unavailable',code:'feedback_card_unavailable'}});
        return;
      }
      if(request.method()==='POST'){posts.push({headers:request.headers(),body:request.postData()});await r.fulfill({status:201,json:{id:ticket,status:'open',reference:null,attachments:0,action_card:{message_id:card,metadata:{}}}});return;}
      const synthetic={id:ticket,kind:'feedback',status:'open',closure_reason:null,duplicate_of_ticket_id:null,message:'Synthetic edited draft',created_at:1700000000000,updated_at:1700000000000,unread:false,unread_count:0,attachment_count:0,comment_count:0};
      if(path===`/api/product-feedback/tickets/${ticket}`){await r.fulfill({json:{ticket:synthetic,comments:[],attachments:[],next_comment_cursor:null,unread_total:0}});return;}
      await r.fulfill({json:{tickets:[],next_cursor:null,unread_total:0}});
    });
    await page.goto(`${origin}/feedback/?actionCard=${card}&server=${cardServer}`);
    if (readable) {
      const text=page.getByRole('textbox',{name:'Feedback',exact:true});
      await text.waitFor();assert.equal(await text.inputValue(),'Synthetic agent draft');
      await text.fill('Synthetic edited draft');
      await page.getByRole('button',{name:'Submit',exact:true}).click();
      await page.getByRole('heading',{name:'Synthetic edited draft',exact:true}).waitFor();
      assert.equal(posts.length,1);
      const [post]=posts;
      assert.equal(post.headers['x-server-id'],cardServer);
      for (const [field,value] of [['action_card_message_id',card],['expected_confirmation_version','2'],['type','idea'],['message','Synthetic edited draft']]) assert.match(post.body,new RegExp(`name="${field}"\\r\\n\\r\\n${value}\\r\\n`),field);
      assert.ok(paths.includes(`/api/product-feedback/tickets/${ticket}`),'the workspace opens on the new ticket');
      console.log('action card: draft prefilled, sent as the card from its server, ticket opened');
    } else {
      await page.getByRole('button',{name:'New feedback',exact:true}).waitFor();
      assert.equal(await page.getByRole('textbox',{name:'Feedback',exact:true}).count(),0);assert.equal(posts.length,0);
      console.log('unreadable action card: the ordinary page');
    }
    assert.deepEqual(errors,[]);await page.close();
  }
  // Opened on one ticket (?ticket=<id>, a done feedback card's "View in Settings"): its detail, or
  // the not-available state for a ticket this person cannot read; Back is the list either way.
  // An id the ticket route cannot open (here an uppercase UUID, which the app accepts) is the list,
  // with no ticket request.
  const linked = '44444444-4444-4444-8444-444444444444', unreadable = '55555555-5555-4555-8555-555555555555', listed = '66666666-6666-4666-8666-666666666666';
  for (const [link, expected] of [[linked,'detail'],[unreadable,'not available'],['AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE','list']]) {
    const page = await browser.newPage({viewport:{width:390,height:844}});
    await page.addInitScript(({apiOrigin})=>{window.RaftFeedback={version:'raft-feedback-v1',session:{accountId:'synthetic',sessionGeneration:1,webViewGeneration:1,accessToken:'synthetic-token',apiOrigin,clientKind:'android',clientVersion:'1',locale:'en',theme:'raft',mode:'light'},emit:()=>{}};},{apiOrigin});
    const paths=[];const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/api/product-feedback**',async r=>{
      const path=new URL(r.request().url()).pathname;paths.push(path);
      const summary=(id,message)=>({id,kind:'feedback',status:'open',closure_reason:null,duplicate_of_ticket_id:null,message,created_at:1700000000000,updated_at:1700000000000,unread:false,unread_count:0,attachment_count:0,comment_count:0});
      if(path===`/api/product-feedback/tickets/${linked}`){await r.fulfill({json:{ticket:summary(linked,'Synthetic linked ticket'),comments:[],attachments:[],next_comment_cursor:null,unread_total:0}});return;}
      if(path.startsWith('/api/product-feedback/tickets/')){await r.fulfill({status:404,json:{error:'Feedback ticket not found',code:'feedback_not_found'}});return;}
      await r.fulfill({json:{tickets:[summary(listed,'Synthetic listed ticket')],next_cursor:null,unread_total:0}});
    });
    await page.goto(`${origin}/feedback/?embed=raft-settings-v1&shell=host&ticket=${link}`);
    const row=page.locator('.hands-feedback-ticket-row');
    if (expected === 'list') {
      await row.waitFor();
      assert.equal(paths.some(path=>path.startsWith('/api/product-feedback/tickets/')),false,'no ticket request for an id the route cannot open');
    } else {
      if (expected === 'detail') await page.getByRole('heading',{name:'Synthetic linked ticket',exact:true}).waitFor();
      else await page.getByText('This feedback ticket is no longer available.',{exact:true}).waitFor();
      assert.ok(paths.includes(`/api/product-feedback/tickets/${link}`),'the workspace opens on the linked ticket');
      await row.waitFor({state:'attached'});assert.equal(await row.isVisible(),false,'the list stays behind the ticket');
      await page.getByRole('button',{name:'Back',exact:true}).click();
      await row.waitFor();
    }
    assert.equal(await row.textContent().then(text=>text.includes('Synthetic listed ticket')),true);
    assert.deepEqual(errors,[]);console.log(`ticket link (${expected}): ${expected === 'list' ? 'the list' : 'opened on it, Back is the list'}`);await page.close();
  }
  const missing = await browser.newPage({locale: 'zh-CN', colorScheme: 'dark'});
  let requests = 0;
  await missing.route('**/api/**', r => { requests++; return r.abort(); });
  await missing.goto(origin + '/feedback/');
  await missing.getByText('请从 Raft App 打开反馈页。', {exact: true}).waitFor();
  assert.equal(requests, 0);
  const style = await missing.locator('.feedback-host-status').evaluate(el => {const c=document.createElement('canvas');c.width=c.height=1;const ctx=c.getContext('2d');ctx.fillStyle=getComputedStyle(el).backgroundColor;ctx.fillRect(0,0,1,1);return {padding:getComputedStyle(el).paddingTop,rgba:Array.from(ctx.getImageData(0,0,1,1).data)};});
  assert.equal(style.padding, '24px');assert.equal(style.rgba[3],255);assert(style.rgba.slice(0,3).every(channel=>channel<128));
  console.log('missing host: localized, themed, no API');await missing.close();
} finally {await browser.close(); await new Promise(done=>server.close(done));}
