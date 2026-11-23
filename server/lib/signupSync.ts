import { createHmac, randomUUID } from 'node:crypto';
import type { RahhalaConfig } from '../config.ts';
import type { RahhalaDb } from '../db-core.ts';

// Only metadata created by the signup route is sent, never account secrets.
export async function syncSignupOutbox(db: RahhalaDb, config: RahhalaConfig): Promise<number> {
  if (!config.signupWebhookUrl || !config.signupWebhookSecret) return 0;
  const url = new URL(config.signupWebhookUrl);
  if (url.protocol !== 'https:' || url.hostname !== 'script.google.com' || !url.pathname.endsWith('/exec')) throw new Error('Invalid signup webhook');
  const now = Date.now();
  const rows = db.prepare('SELECT id,payload,attempts FROM signup_outbox WHERE synced_at IS NULL AND next_attempt_at<=? ORDER BY created_at LIMIT 20').all(now) as Array<{id:string;payload:string;attempts:number}>;
  if (!rows.length) return 0;
  const payload = JSON.stringify(rows.map(r => JSON.parse(r.payload)));
  const timestamp = String(now), nonce = randomUUID();
  const signature = createHmac('sha256',config.signupWebhookSecret).update(timestamp+'\n'+nonce+'\n'+payload).digest('hex');
  try {
    const response = await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({timestamp,nonce,payload,signature}),signal:AbortSignal.timeout(20000),redirect:'follow'});
    const result = await response.json() as {ok?:boolean;eventIds?:string[]};
    const ack = new Set(result.eventIds);
    if (!response.ok || !result.ok || !rows.every(r=>ack.has(r.id))) throw new Error('Signup sync not acknowledged');
    db.transaction(()=>{for(const row of rows)db.prepare('UPDATE signup_outbox SET synced_at=?,payload=? WHERE id=? AND synced_at IS NULL').run(Date.now(),'{}',row.id);})();
    return rows.length;
  } catch {
    for (const row of rows) db.prepare('UPDATE signup_outbox SET attempts=attempts+1,next_attempt_at=? WHERE id=?').run(now+Math.min(3600000,30000*2**Math.min(row.attempts,7)),row.id);
    return 0;
  }
}
