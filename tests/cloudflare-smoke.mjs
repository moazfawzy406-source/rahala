import {spawn} from 'node:child_process';import{randomBytes}from'node:crypto';import fs from'node:fs';import assert from'node:assert/strict';import WebSocket from 'ws';
import { fileURLToPath } from 'node:url';
const cwd=fileURLToPath(new URL('..',import.meta.url)),token=randomBytes(32).toString('hex'),pass=randomBytes(24).toString('hex');let p;const log=fs.openSync('/tmp/cf-validation.log','w');const persist='/tmp/cf-valid-'+process.pid;
function start(){p=spawn('npx',['wrangler','dev','--ip','127.0.0.1','--port','8787','--persist-to',persist,'--var','OWNER_BOOTSTRAP_TOKEN:'+token,'--var','OWNER_RECOVERY_TOKEN:'+token],{cwd,stdio:['ignore',log,log],detached:true});}async function stop(){process.kill(-p.pid,'SIGTERM');await new Promise(r=>p.on('exit',r));}
class Client{cookie='';async req(path,body,method,extra={}){const r=await fetch('http://127.0.0.1:8787'+path,{method:method??(body?'POST':'GET'),headers:{'Content-Type':'application/json','X-Rahhala-CSRF':'1',Cookie:this.cookie,...extra},body:body?(Buffer.isBuffer(body)?body:JSON.stringify(body)):undefined});if(r.headers.get('set-cookie'))this.cookie=r.headers.get('set-cookie').split(';')[0];return{status:r.status,data:await r.json().catch(()=>null),headers:r.headers};}}
const owner=new Client(),member=new Client(),guest=new Client();let checks=0;function eq(a,b){assert.deepEqual(a,b);checks++}
try{start();for(let i=0;i<80;i++){try{await guest.req('/api/config');break}catch{await new Promise(r=>setTimeout(r,200))}}
eq((await guest.req('/bootstrap-owner',{},'POST',{'X-Rahala-Operator-Authorized':'1','X-Rahala-Operator-Token':token})).status,404);
eq((await guest.req('/bootstrap-owner/reset',{username:'test.owner',password:pass},'POST',{'X-Rahala-Operator-Authorized':'1','X-Rahala-Operator-Token':token})).status,404);
eq((await owner.req('/bootstrap-owner',{username:'test.owner',name:'Synthetic Owner',email:'test@example.invalid',password:pass},'POST',{Authorization:'Bearer '+token})).status,200);
eq((await owner.req('/api/auth/login',{username:'test.owner',password:pass})).data.user.role,'owner');
eq((await guest.req('/api/resources/subjects')).status,401);
// A historical message exists before member creation; new members must not receive it.
await owner.req('/api/chat/messages',{channel:'general',body:'OLD_PRIVATE_HISTORY'});
await new Promise(r=>setTimeout(r,15));
const subs=(await owner.req('/api/resources/subjects')).data.subjects;eq(subs.length,4);let sec=0,mat=0;for(const s of subs){const d=(await owner.req('/api/resources/subjects/'+s.id)).data;sec+=d.sections.length;for(const v of d.sections)mat+=v.materials.length}eq(sec,12);eq(mat,0);
eq((await member.req('/api/auth/register',{displayName:'Synthetic Student',username:'test.student',email:'student@example.invalid',password:pass,confirmPassword:pass})).status,201);eq((await member.req('/api/auth/login',{username:'test.student',password:pass})).status,403);
const requests=(await owner.req('/api/admin/requests')).data;console.log('request fields',Object.keys(requests));const uid=requests.pendingUsers[0].id;
eq((await owner.req('/api/admin/registrations/'+uid+'/approve',{})).status,200);eq((await member.req('/api/auth/login',{username:'test.student',password:pass})).status,200);eq((await member.req('/api/admin/requests')).status,403);
eq((await member.req('/api/chat/messages?channel=general')).data.messages.some(m=>m.body==='OLD_PRIVATE_HISTORY'),false);
eq((await member.req('/api/chat/messages',{channel:'announcements',body:'Not permitted'})).status,403);
eq((await member.req('/api/admin/members/'+(await owner.req('/api/auth/me')).data.user.id+'/reset-password',{temporaryPassword:pass})).status,403);
const badUpgrade=await fetch('http://127.0.0.1:8787/ws');eq(badUpgrade.status,426);
const ticket=(await owner.req('/api/auth/ws-ticket')).data.ticket;const ws=new WebSocket('ws://127.0.0.1:8787/ws?ticket='+encodeURIComponent(ticket));const events=[];ws.on('message',m=>events.push(JSON.parse(m)));await new Promise((r,j)=>{ws.on('open',r);ws.on('error',j)});await new Promise(r=>setTimeout(r,100));eq(events[0].type,'connected');
const msg=await owner.req('/api/chat/messages',{channel:'general',body:'Synthetic port validation'});eq(msg.status,201);
const forward=await owner.req('/api/chat/forward',{messageIds:[msg.data.message.id],channel:'questions',requestKey:'forward-test-001'});eq(forward.status,201);eq((await owner.req('/api/chat/forward',{messageIds:[msg.data.message.id],channel:'questions',requestKey:'forward-test-001'})).data.messageIds,forward.data.messageIds);eq((await member.req('/api/chat/forward',{messageIds:[msg.data.message.id],channel:'announcements',requestKey:'forward-denied-001'})).status,403);eq((await member.req('/api/chat/forward',{messageIds:[1],channel:'questions',requestKey:'forward-old-denied'})).status,403);
eq((await member.req('/api/chat/selection',{messageIds:[msg.data.message.id],action:'delete'})).status,403);eq((await owner.req('/api/chat/selection',{messageIds:forward.data.messageIds,action:'star'})).status,200);eq((await owner.req('/api/chat/selection',{messageIds:forward.data.messageIds,action:'delete'})).status,200);const hideTarget=(await owner.req('/api/chat/messages',{channel:'questions',body:'hide me'})).data.message;eq((await owner.req('/api/chat/selection',{messageIds:[hideTarget.id],action:'hide'})).status,200);

await new Promise(r=>setTimeout(r,150));eq(events.some(e=>e.type==='message:created'),true);
const pdf=Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');const up=await owner.req('/api/assets/upload',pdf,'POST',{'Content-Type':'application/octet-stream','X-Rahhala-Purpose':'chat_file','X-Rahhala-Filename':'test.pdf'});eq(up.status,201);
const a=up.data.asset.assetId;const access=await owner.req('/api/assets/'+a+'/access-token',{});eq(access.status,200);const download=await fetch('http://127.0.0.1:8787/api/assets/'+a+'/content?token='+encodeURIComponent(access.data.token));eq(download.status,200);eq(Buffer.from(await download.arrayBuffer()),pdf);
eq((await guest.req('/api/assets/'+a+'/access-token',{})).status,401);
const attached=(await owner.req('/api/chat/messages',{channel:'general',body:'forward attachment',fileAssetId:a})).data.message;const fwdFile=await owner.req('/api/chat/forward',{messageIds:[attached.id],channel:'questions',requestKey:'forward-file-001'});eq(fwdFile.status,201);const dest=(await owner.req('/api/chat/messages?channel=questions')).data.messages.find(m=>m.id===fwdFile.data.messageIds[0]);eq(Boolean(dest.fileAttachment),true);eq(dest.fileAttachment.assetId===a,false);

// Isolated communities/groups. Names are discoverable; content and assets require approved membership.
eq((await member.req('/api/communities',{name:'Denied'})).status,403);
const community=await owner.req('/api/communities',{name:'Synthetic community'});eq(community.status,201);
const g1=(await owner.req('/api/groups',{communityId:community.data.id,name:'Synthetic group A'})).data.id;
const g2=(await owner.req('/api/groups',{communityId:community.data.id,name:'Synthetic group B'})).data.id;
eq((await member.req('/api/groups/'+g1+'/messages')).status,403);
eq((await member.req('/api/groups/'+g1+'/members')).status,403);
const memberTicket=(await member.req('/api/auth/ws-ticket')).data.ticket;const memberWs=new WebSocket('ws://127.0.0.1:8787/ws?ticket='+encodeURIComponent(memberTicket));const memberEvents=[];memberWs.on('message',m=>memberEvents.push(JSON.parse(m)));await new Promise((r,j)=>{memberWs.on('open',r);memberWs.on('error',j)});
eq((await member.req('/api/groups/'+g1+'/join',{})).status,200);
eq((await member.req('/api/groups/'+g1+'/messages?q=private')).status,403);
const early=(await owner.req('/api/groups/'+g1+'/messages',{body:'GROUP_OLD_HISTORY',requestKey:'group-old-history'})).data.id;
await new Promise(r=>setTimeout(r,100));eq(memberEvents.some(e=>e.type==='group:updated'),false);
eq((await owner.req('/api/groups/'+g1+'/members/'+uid,{status:'approved'},'PATCH')).status,200);
eq((await member.req('/api/groups/'+g1+'/messages')).data.messages.some(m=>m.id===early),false);
const groupPdf=(await owner.req('/api/assets/upload',pdf,'POST',{'Content-Type':'application/octet-stream','X-Rahhala-Purpose':'chat_file','X-Rahhala-Filename':'group.pdf'})).data.asset.assetId;
const groupMsg=await owner.req('/api/groups/'+g1+'/messages',{body:'GROUP_PRIVATE_PDF',assetId:groupPdf,requestKey:'group-private-pdf'});eq(groupMsg.status,201);const groupMid=groupMsg.data.id;
eq((await owner.req('/api/chat/messages',{channel:'general',fileAssetId:groupPdf})).status,403);
eq((await member.req('/api/groups/'+g1+'/messages')).data.messages.some(m=>m.id===groupMid),true);
const beforeRemoveAccess=await member.req('/api/assets/'+groupPdf+'/access-token',{});eq(beforeRemoveAccess.status,200);
await new Promise(r=>setTimeout(r,100));eq(memberEvents.some(e=>e.type==='group:updated'&&e.groupId===g1),true);
eq((await owner.req('/api/groups/'+g1+'/messages',{body:'GROUP_PRIVATE_PDF',assetId:groupPdf,requestKey:'group-private-pdf'})).data.id,groupMid);
eq((await member.req('/api/groups/'+g1+'/messages/'+groupMid+'/action',{action:'delete'})).status,403);
eq((await member.req('/api/groups/'+g1+'/messages/'+groupMid,{body:'forged edit'},'PATCH')).status,403);
eq((await owner.req('/api/groups/'+g1+'/messages/'+groupMid,{body:'GROUP_PRIVATE_PDF edited'},'PATCH')).status,200);
eq((await member.req('/api/groups/'+g1+'/messages/'+groupMid+'/action',{action:'pin'})).status,403);
eq((await owner.req('/api/groups/'+g1+'/messages/'+groupMid+'/action',{action:'pin'})).status,200);
eq((await member.req('/api/groups/'+g1+'/messages')).data.pinned.id,groupMid);

eq((await member.req('/api/groups/'+g1+'/messages/'+groupMid+'/action',{action:'read'})).status,200);
eq((await member.req('/api/groups/'+g1+'/messages/'+groupMid+'/receipts')).status,403);
const mention=(await owner.req('/api/groups/'+g1+'/messages',{body:'Hello @test.student and @outsider',requestKey:'mention-isolated-1'})).data.id;
eq((await member.req('/api/groups/mentions')).data.mentions.some(n=>n.message_id===mention),true);
eq((await owner.req('/api/groups/mentions')).data.mentions.length,0);
eq((await member.req('/api/groups/'+g1+'/selection',{messageIds:[groupMid,mention],action:'delete'})).status,403);
eq((await owner.req('/api/groups/'+g1+'/messages')).data.messages.some(m=>m.id===mention),true);
eq((await member.req('/api/groups/'+g1+'/read-visible',{messageIds:[mention]})).data.count,1);
eq((await member.req('/api/groups/'+g1+'/read-visible',{messageIds:[mention]})).data.count,0);
eq((await owner.req('/api/groups/'+g1+'/messages/'+mention+'/receipts')).data.receipts.length,1);
eq((await member.req('/api/groups/'+g1+'/mentions/seen',{})).status,200);eq((await member.req('/api/groups/mentions')).data.mentions.length,0);
eq((await owner.req('/api/groups/'+g1+'/selection',{messageIds:[mention],action:'star'})).status,200);
eq((await owner.req('/api/groups/'+g1+'/selection',{messageIds:[mention],action:'delete'})).status,200);
eq((await member.req('/api/chat/settings/me',{readReceiptsEnabled:false},'PUT')).status,200);
const privateRead=(await owner.req('/api/groups/'+g1+'/messages',{body:'receipt disabled',requestKey:'receipt-disabled-test'})).data.id;
eq((await member.req('/api/groups/'+g1+'/messages/'+privateRead+'/action',{action:'read'})).status,200);eq((await member.req('/api/groups/'+g1+'/read-visible',{messageIds:[privateRead]})).data.disabled,true);
eq((await owner.req('/api/groups/'+g1+'/messages/'+privateRead+'/receipts')).data.receipts.length,0);

eq((await owner.req('/api/groups/'+g1+'/messages/'+groupMid+'/receipts')).data.receipts.length,1);
eq((await member.req('/api/groups/'+g2+'/forward',{messageIds:[groupMid],requestKey:'group-forward-no'})).status,403);
eq((await member.req('/api/groups/'+g2+'/messages',{body:'Denied',requestKey:'group-post-denied'})).status,403);
const gf=await owner.req('/api/groups/'+g2+'/forward',{messageIds:[groupMid],requestKey:'group-copy-pdf'});eq(gf.status,201);eq((await owner.req('/api/groups/'+g2+'/forward',{messageIds:[groupMid],requestKey:'group-copy-pdf'})).data.ids,gf.data.ids);
const groupCopy=(await owner.req('/api/groups/'+g2+'/messages')).data.messages.find(m=>m.id===gf.data.ids[0]);eq(Boolean(groupCopy.asset),true);eq(groupCopy.asset.id===groupPdf,false);
eq((await owner.req('/api/groups/'+g1+'/members/'+uid,{status:'rejected'},'PATCH')).status,200);await new Promise(r=>setTimeout(r,100));const afterRemovalCount=memberEvents.filter(e=>e.type==='group:updated').length;await owner.req('/api/groups/'+g1+'/messages',{body:'AFTER_REMOVAL_PRIVATE',requestKey:'after-removal-private'});await new Promise(r=>setTimeout(r,100));eq(memberEvents.filter(e=>e.type==='group:updated').length,afterRemovalCount);eq((await fetch('http://127.0.0.1:8787/api/assets/'+groupPdf+'/content?token='+encodeURIComponent(beforeRemoveAccess.data.token))).status,403);memberWs.close();
eq((await member.req('/api/groups/'+g1+'/messages')).status,403);eq((await member.req('/api/groups/'+g1+'/read-visible',{messageIds:[privateRead]})).status,403);eq((await member.req('/api/groups/mentions')).data.mentions.length,0);eq((await member.req('/api/assets/'+groupPdf+'/access-token',{})).status,403);eq((await member.req('/api/groups/'+g1+'/messages/'+groupMid+'/receipts')).status,403);
eq((await owner.req('/api/groups/'+g1+'/messages/'+groupMid+'/action',{action:'delete'})).status,200);eq((await owner.req('/api/assets/'+groupPdf+'/access-token',{})).status,403);eq((await owner.req('/api/assets/'+groupCopy.asset.id+'/access-token',{})).status,200);

eq((await owner.req('/api/assets/upload',Buffer.alloc(2_000_001),'POST',{'Content-Type':'application/octet-stream','X-Rahhala-Purpose':'chat_file'})).status,413);
// Pending uploads count toward the per-user cap, including the earlier PDF.
const paddedPdf=Buffer.concat([pdf.subarray(0,9),Buffer.alloc(2_000_000-pdf.length,32),pdf.subarray(9)]);
for(let i=0;i<4;i++)eq((await owner.req('/api/assets/upload',paddedPdf,'POST',{'Content-Type':'application/octet-stream','X-Rahhala-Purpose':'chat_file','X-Rahhala-Filename':'quota.pdf'})).status,201);
eq((await owner.req('/api/assets/upload',paddedPdf,'POST',{'Content-Type':'application/octet-stream','X-Rahhala-Purpose':'chat_file','X-Rahhala-Filename':'quota.pdf'})).status,413);
await new Promise(r=>setTimeout(r,16000));
ws.send(JSON.stringify({type:'majalis:join',roomId:'room_general_hall',mode:'listener'}));await new Promise(r=>setTimeout(r,150));console.log('events',events.map(e=>e.type));eq(events.some(e=>e.type==='majalis:room_state'),true);// Burst of 100 socket handshakes, no fabricated 700-user capacity claim.
const burst=await Promise.all(Array.from({length:100},()=>new Promise((resolve,reject)=>{const s=new WebSocket('ws://127.0.0.1:8787/ws?ticket='+encodeURIComponent(ticket));s.on('open',()=>resolve(s));s.on('error',reject)})));
eq(burst.length,100);for(const s of burst)s.close();
ws.close();await new Promise(r=>setTimeout(r,150));
await stop();start();for(let i=0;i<80;i++){try{if((await owner.req('/api/resources/subjects')).status===200)break}catch{}await new Promise(r=>setTimeout(r,200))}eq((await owner.req('/api/resources/subjects')).data.subjects.length,4);eq((await owner.req('/api/chat/messages?channel=general')).data.messages.some(m=>m.body==='Synthetic port validation'),true);
const resetPass=randomBytes(24).toString('hex');
eq((await owner.req('/bootstrap-owner/reset',{username:'test.owner',password:resetPass},'POST',{Authorization:'Bearer '+token})).status,200);
eq((await owner.req('/api/resources/subjects')).status,401);
eq((await owner.req('/api/auth/login',{username:'test.owner',password:pass})).status,401);
eq((await owner.req('/api/auth/login',{username:'test.owner',password:resetPass})).status,200);
eq((await owner.req('/bootstrap-owner/reset',{username:'test.owner',password:pass},'POST',{Authorization:'Bearer '+token})).status,409);
const nextMemberPass=randomBytes(24).toString('hex');
eq((await owner.req('/api/admin/members/'+uid+'/reset-password',{temporaryPassword:nextMemberPass})).status,200);
eq((await member.req('/api/resources/subjects')).status,401);
eq((await member.req('/api/auth/login',{username:'test.student',password:nextMemberPass})).status,200);
const archive=await fetch('http://127.0.0.1:8787/api/admin/export-archive',{headers:{Cookie:owner.cookie}});eq(archive.status,200);const bytes=new Uint8Array(await archive.arrayBuffer());eq(String.fromCharCode(...bytes.slice(0,2)),'PK');
const noEmail=await guest.req('/api/auth/register',{displayName:'No Email Student',username:'no.email',password:pass,confirmPassword:pass});eq(noEmail.status,201);
eq((await owner.req('/bootstrap-owner',{username:'test.owner',name:'Synthetic Owner',password:pass},'POST',{Authorization:'Bearer '+token})).status,409);
console.log('PASSED',checks);
}catch(e){console.error(e);console.error(fs.readFileSync('/tmp/cf-validation.log','utf8').slice(-5000));process.exitCode=1}finally{if(p?.exitCode===null)await stop()}
