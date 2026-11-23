import {it,expect,afterEach} from 'vitest';
import {createRahhalaApp} from '../server/app.ts';
import {loadConfig} from '../server/config.ts';
import {generateOpaqueToken,hashPassword,sha256Hex} from '../server/lib/crypto.ts';
let ctx:any;
afterEach(async()=>{if(ctx)await ctx.close();});
it('uses a 90 day sliding lease, renews cookies on use, not on polling, and still expires/revokes',async()=>{
 const duration=90*86400000;expect(loadConfig().sessionIdleMs).toBe(duration);
 ctx=createRahhalaApp({dbPath:':memory:',previewDemoEnabled:false});await new Promise<void>(r=>ctx.httpServer.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+ctx.httpServer.address().port,now=Date.now(),token=generateOpaqueToken();
 ctx.db.prepare("INSERT INTO users(id,display_name,username,email,password_hash,role,approval_status,history_granted,bio,created_at,updated_at) VALUES('student','Synthetic Student','synthetic.student','synthetic@invalid.test',?,'member','approved',0,'',?,?)").run(hashPassword('SyntheticPass123!'),now,now);
 ctx.db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?,?,NULL)').run('session','student',sha256Hex(token),'Test',now-3*86400000,now-3*86400000,now+86400000);
 const get=(bg=false)=>fetch(base+'/api/auth/me'+(bg?'?background=1':''),{headers:{Cookie:'rahhala_sid='+token}});
 const r=await get();expect(r.status).toBe(200);expect(r.headers.get('set-cookie')).toContain('Max-Age=7776000');const touched=ctx.db.prepare("SELECT * FROM sessions WHERE id='session'").get();expect(touched.expires_at).toBeGreaterThanOrEqual(now+duration);expect(touched.last_activity_at).toBeGreaterThanOrEqual(now);
 const poll=await get(true);expect(poll.status).toBe(200);expect(poll.headers.get('set-cookie')).toBeNull();expect(ctx.db.prepare("SELECT last_activity_at FROM sessions WHERE id='session'").get().last_activity_at).toBe(touched.last_activity_at);
 ctx.db.prepare("UPDATE sessions SET revoked_at=? WHERE id='session'").run(now);expect((await get()).status).toBe(401);
 // Expired sessions stay expired, even when a policy changes.
 ctx.db.prepare("UPDATE sessions SET revoked_at=NULL,last_activity_at=?,expires_at=? WHERE id='session'").run(now-duration-1000,now-1000);const expired=await get();expect(expired.status).toBe(401);expect((await expired.json()).code).toBe('SESSION_IDLE_EXPIRED');expect(ctx.db.prepare("SELECT revoked_at FROM sessions WHERE id='session'").get().revoked_at).not.toBeNull();
});
