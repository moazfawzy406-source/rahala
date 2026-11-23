import { syncSignupOutbox } from '../server/lib/signupSync.ts';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import sourceArchive from './source-archive.json';
import { resolveActiveSession, extractSessionToken } from '../server/middleware/auth.ts';
import { hashPassword, sha256Hex } from '../server/lib/crypto.ts';
import { usernameSchema, displayNameSchema, emailSchema, passwordSchema } from '../server/lib/validation.ts';
import { DurableObject } from 'cloudflare:workers';
import { httpServerHandler } from 'cloudflare:node';
import { createRahhalaCore } from '../server/app-core.ts';
import { setupWebSocketHub } from '../server/ws.ts';
import { migrateDatabase } from '../server/db-core.ts';
import { SqliteAdapter } from './sqlite.ts';
import { WebSocket as SocketBridge } from './ws-shim.ts';

export class RahalaApp extends DurableObject<any> {
  app: ReturnType<typeof createRahhalaCore>;
  handler: any;
  lastState = '';
  sockets = new Map<globalThis.WebSocket, SocketBridge>();
  constructor(ctx: any, env: any) {
    super(ctx,env);
    const db = new SqliteAdapter(ctx.storage);
    migrateDatabase(db as any);
    this.app = createRahhalaCore({ isProduction: true, previewDemoEnabled: false, openRegistration:env.OPEN_REGISTRATION==='true',turnstileSiteKey:env.TURNSTILE_SITE_KEY,turnstileSecret:env.TURNSTILE_SECRET,signupWebhookUrl:env.SIGNUP_WEBHOOK_URL,signupWebhookSecret:env.SIGNUP_WEBHOOK_SECRET, maxUploadBytes: 2_000_000, maxVoiceBytes: 2_000_000, maxAvatarBytes: 500_000, maxStoredAssetBytes: 300_000_000, maxUserStoredAssetBytes: 10_000_000 }, { db: db as any, setupHub: setupWebSocketHub });
    this.handler = httpServerHandler(this.app.httpServer as any);
    this.app.hub.importState?.(ctx.storage.sql.exec("SELECT value FROM app_settings WHERE key = '_realtime_state'").toArray().map((r:any)=>JSON.parse(r.value))[0]);
    for (const raw of ctx.getWebSockets()) {
      const bridge = new SocketBridge(raw); this.sockets.set(raw,bridge);
      this.app.hub.restoreClient?.(bridge,raw.deserializeAttachment());
    }
  }
  persist() {
    for (const {ws,meta} of this.app.hub.clientsState?.() ?? []) ws.raw.serializeAttachment(meta);
    const value = JSON.stringify(this.app.hub.exportState?.() ?? {});
    if(value === this.lastState) return;
    this.lastState = value;
    this.app.db.prepare("INSERT INTO app_settings(key,value,updated_at) VALUES('_realtime_state',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").run(value,Date.now());
  }
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/api/admin/export-archive') {
      const session=resolveActiveSession(this.app.db,this.app.config,extractSessionToken({headers:Object.fromEntries(request.headers)}),{touchActivity:false});
      if(!session.ok) return Response.json({error:'يلزم تسجيل الدخول'},{status:401});
      if(session.data.user.role!=='owner') return Response.json({error:'متاح للمالك فقط'},{status:403});
      return new Response(Buffer.from(sourceArchive.base64,'base64'),{headers:{'Content-Type':'application/zip','Content-Disposition':'attachment; filename="rahala-source.zip"','Cache-Control':'private, no-store'}});
    }
    if (url.pathname === '/bootstrap-owner/reset') {
      const supplied=request.headers.get('X-Rahala-Operator-Token') ?? '';
      if(request.headers.get('X-Rahala-Operator-Authorized')!=='1' || !supplied) return new Response('Not found',{status:404});
      if(request.method!=='POST') return new Response('Method not allowed',{status:405});
      if(Number(request.headers.get('Content-Length')||0)>4096) return new Response('Too large',{status:413});
      const body:any=await request.json();const pass=passwordSchema.safeParse(body.password);
      if(!pass.success) return new Response('Invalid password',{status:400});
      const owner:any=this.app.db.prepare("SELECT id,username FROM users WHERE role='owner'").get();
      if(!owner || owner.username!==body.username) return new Response('Owner mismatch',{status:409});
      const fingerprint=sha256Hex(supplied);
      if(this.app.db.prepare("SELECT 1 FROM app_settings WHERE key=?").get('_recovery_used_'+fingerprint)) return new Response('Recovery token already used',{status:409});
      const hash=hashPassword(pass.data),now=Date.now();
      this.app.db.transaction(()=>{
        this.app.db.prepare('UPDATE users SET password_hash=?,updated_at=? WHERE id=?').run(hash,now,owner.id);
        this.app.db.prepare('UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL').run(now,owner.id);
        this.app.db.prepare('INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?)').run('_recovery_used_'+fingerprint,'used',now);
        this.app.db.prepare('DELETE FROM auth_attempts').run();
      })();
      this.app.hub.notifyUserSessionsRevoked(owner.id);
      return Response.json({ok:true});
    }
    if (url.pathname === '/bootstrap-owner') {
      if(request.headers.get('X-Rahala-Operator-Authorized')!=='1') return new Response('Not found',{status:404});
      if(request.method !== 'POST') return new Response('Method not allowed',{status:405});
      if(this.app.db.prepare("SELECT id FROM users WHERE role='owner'").get()) return new Response('Owner already exists',{status:409});
      if(Number(request.headers.get('Content-Length')||0)>4096) return new Response('Too large',{status:413});
      const body:any = await request.json();
      const u=usernameSchema.safeParse(body.username), n=displayNameSchema.safeParse(body.name), e=emailSchema.safeParse(body.email ?? `${body.username}@no-email.invalid`), p=passwordSchema.safeParse(body.password);
      if(!u.success||!n.success||!e.success||!p.success) return new Response('Invalid owner details',{status:400});
      const now=Date.now();
      this.app.db.prepare("INSERT INTO users(id,display_name,username,email,password_hash,role,approval_status,history_granted,bio,avatar_asset_id,created_at,updated_at) VALUES(?,?,?,?,?,'owner','approved',1,'',NULL,?,?)").run('usr_'+randomUUID(),n.data,u.data,e.data,hashPassword(p.data),now,now);
      return Response.json({ok:true});
    }
    if (url.pathname === '/ws') {
      const origin=request.headers.get('Origin');
      if(origin && origin!==url.origin) return new Response('Origin not allowed',{status:403});
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('WebSocket required',{status:426});
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      const bridge = new SocketBridge(pair[1]);
      let rejected = false;
      this.app.httpServer.emit('upgrade',{url: url.pathname+url.search, headers:Object.fromEntries(request.headers), __socket:bridge},{write(){rejected=true},destroy(){rejected=true}},null);
      if(rejected) { pair[1].close(4001,'Unauthorized'); return new Response('Unauthorized',{status:401}); }
      this.sockets.set(pair[1],bridge); this.persist();
      return new Response(null,{status:101,webSocket:pair[0]});
    }
    const response = await this.handler.fetch(request,this.env,this.ctx);
    this.persist();
    if(this.app.config.signupWebhookUrl&&this.app.config.signupWebhookSecret){const row=this.app.db.prepare('SELECT min(next_attempt_at) due FROM signup_outbox WHERE synced_at IS NULL').get() as any;if(row?.due!==null&&row?.due!==undefined&&!await this.ctx.storage.getAlarm())await this.ctx.storage.setAlarm(Math.max(Date.now()+1000,row.due));}
    return response;
  }
  async alarm(){
    await syncSignupOutbox(this.app.db,this.app.config);
    const row=this.app.db.prepare('SELECT min(next_attempt_at) due FROM signup_outbox WHERE synced_at IS NULL').get() as any;
    if(row?.due!==null&&row?.due!==undefined&&this.app.config.signupWebhookUrl&&this.app.config.signupWebhookSecret)await this.ctx.storage.setAlarm(Math.max(Date.now()+1000,row.due));
  }
  webSocketMessage(raw: globalThis.WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== 'string' || message.length > 64_000) { raw.close(1009,'Message too large'); return; }
    let parsed:any;
    try { parsed=JSON.parse(message); } catch { return; }
    if(!parsed || typeof parsed!=='object' || Array.isArray(parsed) || typeof parsed.type!=='string') return;
    if(parsed.channel && !['general','announcements','questions'].includes(parsed.channel)) return;
    if(parsed.action && !['start','pause','reset','preset','admit','deny','mute','unmute','remove','spotlight','unspotlight'].includes(parsed.action)) {
      // Per-feature handlers validate their other action names; only timer enum is restricted here.
      if(parsed.type==='majalis:timer') return;
    }
    this.sockets.get(raw)?.emit('message',Buffer.from(message)); this.persist();
  }
  webSocketClose(raw: globalThis.WebSocket, code: number, reason: string) {
    this.sockets.get(raw)?.emit('close'); this.sockets.delete(raw); this.persist();
    try { raw.close(code===1006 ? 1000 : code,reason); } catch {}
  }
  webSocketError(raw: globalThis.WebSocket) { this.webSocketClose(raw,1011,'Connection error'); }
}
export default {
  async fetch(request: Request, env: any) {
    const path = new URL(request.url).pathname;
    if (path.startsWith('/api/') || path === '/ws' || path.startsWith('/bootstrap-owner')) {
      const headers=new Headers(request.headers);
      headers.delete('X-Rahala-Operator-Authorized');
      headers.delete('X-Rahala-Operator-Token');
      if(path.startsWith('/bootstrap-owner')) {
        const expected=path==='/bootstrap-owner/reset'?env.OWNER_RECOVERY_TOKEN:env.OWNER_BOOTSTRAP_TOKEN;
        const supplied=request.headers.get('Authorization')?.replace(/^Bearer /,'') ?? '';
        if(!expected || supplied.length!==expected.length || !timingSafeEqual(Buffer.from(supplied),Buffer.from(expected))) return new Response('Not found',{status:404});
        headers.set('X-Rahala-Operator-Authorized','1');
        headers.set('X-Rahala-Operator-Token',supplied);
        headers.delete('Authorization');
      }
      headers.delete('forwarded'); headers.delete('x-real-ip');
      headers.set('x-forwarded-for',request.headers.get('CF-Connecting-IP') || '127.0.0.1');
      headers.set('x-forwarded-proto',new URL(request.url).protocol==='https:'?'https':'http');
      return env.RAHALA.get(env.RAHALA.idFromName('cohort')).fetch(new Request(request,{headers}));
    }
    return env.ASSETS.fetch(request);
  },
};
