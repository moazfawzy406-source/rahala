import { Router } from 'express';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { RahhalaConfig } from '../config.ts';
import { getOrCreateSigningSecret, getSetting, type RahhalaDb } from '../db-core.ts';
import {
  generateOpaqueToken,
  hashPassword,
  sha256Hex,
  signShortToken,
  verifyPassword,
} from '../lib/crypto.ts';
import {
  bioSchema,
  displayNameSchema,
  emailSchema,
  isSafeHttpUrl,
  normalizeUsername,
  passwordSchema,
  usernameSchema,
} from '../lib/validation.ts';
import {
  type AuthenticatedRequest,
  checkRateLimit,
  clearRateLimit,
  clearSessionCookie,
  createAuthMiddleware,
  mapUserRow,
  recordFailedAttempt,
  setSessionCookie,
} from '../middleware/auth.ts';
import type { RealtimeHub } from '../ws.ts';

function describeDevice(userAgentHeader: string | undefined): string {
  const ua = (userAgentHeader || '').trim();
  if (!ua) return 'متصفح غير معروف';
  let os = 'جهاز غير معروف';
  if (/android/i.test(ua)) os = 'أندرويد';
  else if (/iphone|ipad|ipod/i.test(ua)) os = 'آيفون / آيباد';
  else if (/windows/i.test(ua)) os = 'ويندوز';
  else if (/mac os x|macintosh/i.test(ua)) os = 'ماك';
  else if (/linux/i.test(ua)) os = 'لينكس';

  let browser = 'متصفح ويب';
  if (/edg\//i.test(ua)) browser = 'Edge';
  else if (/chrome|crios/i.test(ua)) browser = 'Chrome';
  else if (/firefox|fxios/i.test(ua)) browser = 'Firefox';
  else if (/safari/i.test(ua)) browser = 'Safari';

  return `${browser} · ${os}`.slice(0, 80);
}

export function createAuthRouter(
  db: RahhalaDb,
  config: RahhalaConfig,
  hub: RealtimeHub
): Router {
  const router = Router();
  const { requireAuth } = createAuthMiddleware(db, config);
  const signingSecret = getOrCreateSigningSecret(db);

  const LOGIN_MAX_ATTEMPTS = 8;
  const LOGIN_WINDOW_MS = 15 * 60 * 1000;
  const LOGIN_LOCK_MS = 10 * 60 * 1000;

  const REG_MAX_ATTEMPTS = config.openRegistration ? 800 : 12;
  const REG_WINDOW_MS = 60 * 60 * 1000;
  const REG_LOCK_MS = 15 * 60 * 1000;

  router.get('/config', (_req, res) => {
    const subtitle = getSetting(db, 'institution_subtitle', config.institutionSubtitle);
    const chatLocked = getSetting(db, 'chat_locked', 'false') === 'true';
    const rawExternalUrl = getSetting(db, 'meeting_provider_url', config.meetingProviderUrl).trim();
    const safeExternalUrl = rawExternalUrl && isSafeHttpUrl(rawExternalUrl) ? rawExternalUrl : '';
    const storedMeetingMode = getSetting(db, 'meeting_mode', '').trim();
    const meetingMode: 'builtin' | 'external' | 'unconfigured' =
      storedMeetingMode === 'builtin'
        ? 'builtin'
        : storedMeetingMode === 'unconfigured'
        ? 'unconfigured'
        : storedMeetingMode === 'external'
        ? safeExternalUrl
          ? 'external'
          : 'builtin'
        : safeExternalUrl
        ? 'external'
        : 'builtin';
    const meetingExternalUrl = meetingMode === 'external' ? safeExternalUrl : '';
    const defaultRoomAccessType =
      getSetting(db, 'default_room_access_type', 'open') === 'knock' ? 'knock' : 'open';

    let iceServers: Array<{ urls: string | string[]; username?: string; credential?: string }> = [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ];
    const rawIce = getSetting(db, 'ice_servers_json', '').trim();
    if (rawIce) {
      try {
        const parsed = JSON.parse(rawIce);
        if (Array.isArray(parsed) && parsed.length > 0) {
          const valid = parsed.filter(
            (item) =>
              item &&
              typeof item === 'object' &&
              (typeof item.urls === 'string' || Array.isArray(item.urls))
          );
          if (valid.length > 0) {
            iceServers = valid;
          }
        }
      } catch {
        // Fallback to default STUN servers
      }
    }

    res.json({
      brandName: 'رَحّالَة',
      tagline: 'كل ما تحتاجه لدراستك في مكان واحد',
      institutionSubtitle: subtitle,
      chatLocked,
      meetingMode,
      meetingExternalUrl,
      defaultRoomAccessType,
      iceServers,
      emailRecoveryEnabled: false,
      openRegistration:Boolean(config.openRegistration),
      turnstileSiteKey:config.openRegistration?config.turnstileSiteKey??'':'',
      previewDemoEnabled: config.previewDemoEnabled && !config.isProduction,
    });
  });

  const registerBodySchema = z
    .object({
      displayName: displayNameSchema,
      username: usernameSchema,
      email: emailSchema.optional(),
      password: passwordSchema,
      confirmPassword: z.string(),
      turnstileToken:z.string().max(2048).optional(),
    })
    .refine((d) => d.password === d.confirmPassword, {
      message: 'كلمتا المرور غير متطابقتين',
      path: ['confirmPassword'],
    });

  router.post('/auth/register', async (req, res, next) => {
    try {
    const ipKey = `register:ip:${req.ip || 'unknown'}`;
    const rate = checkRateLimit(db, ipKey, REG_MAX_ATTEMPTS, REG_WINDOW_MS, REG_LOCK_MS);
    if (!rate.allowed) {
      res.status(429).json({
        error: 'تم تجاوز عدد محاولات التسجيل المسموح بها مؤقتًا. حاول بعد شوية.',
      });
      return;
    }

    const parsed = registerBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'بيانات التسجيل غير صحيحة' });
      return;
    }

    const usernameBucket='register:user:'+normalizeUsername(parsed.data.username);
    if(!checkRateLimit(db,usernameBucket,8,15*60000,15*60000).allowed){res.status(429).json({error:'محاولات كثيرة، حاول لاحقًا'});return;}
    recordFailedAttempt(db,usernameBucket,8,15*60000,15*60000);
    const open=Boolean(config.openRegistration);
    if(open){
      if(getSetting(db,'registration_paused','false')==='true'){res.status(503).json({error:'التسجيل متوقف مؤقتًا، حاول لاحقًا'});return;}
      if(!config.turnstileSecret||!config.turnstileSiteKey){res.status(503).json({error:'التسجيل غير متاح مؤقتًا'});return;}
      const globalKey='register:global';if(!checkRateLimit(db,globalKey,120,60000,60000).allowed){res.status(429).json({error:'التسجيل مشغول، حاول بعد دقيقة'});return;}recordFailedAttempt(db,globalKey,120,60000,60000);
      try{const response=await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({secret:config.turnstileSecret,response:parsed.data.turnstileToken??'',remoteip:req.ip??''}),signal:AbortSignal.timeout(10000)});const result=await response.json() as any;const host=req.get('host')?.split(':')[0];if(!response.ok||!result.success||result.hostname!==host||result.action!=='register'){recordFailedAttempt(db,ipKey,REG_MAX_ATTEMPTS,REG_WINDOW_MS,REG_LOCK_MS);res.status(400).json({error:'أعد التحقق الأمني ثم حاول مرة أخرى'});return;}}catch{res.status(503).json({error:'تعذر التحقق الأمني، حاول لاحقًا'});return;}
    }
    if(open&&getSetting(db,'registration_paused','false')==='true'){res.status(503).json({error:'التسجيل متوقف مؤقتًا'});return;}
    const { displayName, username, password } = parsed.data;
    const email = parsed.data.email ?? `${username}@no-email.invalid`;

    const existingUsername = db
      .prepare('SELECT id FROM users WHERE username = ?')
      .get(username);
    if (existingUsername) {
      recordFailedAttempt(db, ipKey, REG_MAX_ATTEMPTS, REG_WINDOW_MS, REG_LOCK_MS);
      res.status(409).json({ error: 'اسم المستخدم ده محجوز بالفعل، اختر اسمًا غيره' });
      return;
    }

    const existingName = db
      .prepare('SELECT id FROM users WHERE display_name = ? COLLATE NOCASE')
      .get(displayName);
    if (existingName) {
      recordFailedAttempt(db, ipKey, REG_MAX_ATTEMPTS, REG_WINDOW_MS, REG_LOCK_MS);
      res.status(409).json({ error: 'الاسم الظاهر مستخدم بالفعل، اكتب اسمك الثلاثي أو المميز' });
      return;
    }

    const now = Date.now();
    const userId = `usr_${randomUUID()}`;
    const passwordHash = hashPassword(password);

    // Existing pending accounts are unchanged; this switch applies only to newly inserted members.
    const recoveryCode=open?generateOpaqueToken(24):null;
    db.transaction(()=>{db.prepare(
      `INSERT INTO users (id, display_name, username, email, password_hash, role, approval_status, history_granted, bio, avatar_asset_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'member', ?, 0, '', NULL, ?, ?)`
    ).run(userId, displayName, username, email, passwordHash,open?'approved':'pending', now, now);
    if(recoveryCode){db.prepare('INSERT INTO account_recovery VALUES(?,?,?)').run(userId,sha256Hex(recoveryCode),now);const id='signup_'+randomUUID();db.prepare('INSERT INTO signup_outbox(id,user_id,payload,created_at) VALUES(?,?,?,?)').run(id,userId,JSON.stringify({eventId:id,userId,name:displayName,username,signupTime:new Date(now).toISOString(),recoveryEnabled:true}),now);}})();
    recordFailedAttempt(db, ipKey, REG_MAX_ATTEMPTS, REG_WINDOW_MS, REG_LOCK_MS);
    hub.broadcastAdminRequestsUpdated?.();
    res.setHeader('Cache-Control','no-store');res.status(201).json({message:open?'تم إنشاء حسابك. احفظ كود الاسترجاع ثم ادخل مباشرة.':'تم إنشاء حسابك بنجاح! حسابك بانتظار موافقة المشرف.',approvalStatus:open?'approved':'pending',...(recoveryCode?{recoveryCode}:{})});
    } catch(error){next(error);}
  });

  router.post('/auth/recover',(req,res)=>{const parsed=z.object({username:z.string().trim().min(1).max(40),recoveryCode:z.string().min(20).max(128),password:passwordSchema,confirmPassword:z.string()}).safeParse(req.body);if(!parsed.success||parsed.data.password!==parsed.data.confirmPassword){res.status(400).json({error:'تحقق من بيانات الاسترجاع وكلمتي المرور'});return;}const username=normalizeUsername(parsed.data.username),ip='recover:ip:'+(req.ip??'unknown'),key='recover:user:'+username;for(const k of [ip,key]){if(!checkRateLimit(db,k,6,15*60000,15*60000).allowed){res.status(429).json({error:'محاولات كثيرة، حاول لاحقًا'});return;}}
    for(const k of [ip,key])recordFailedAttempt(db,k,6,15*60000,15*60000);
    const user=db.prepare("SELECT u.id,u.role,r.code_hash FROM users u JOIN account_recovery r ON r.user_id=u.id WHERE u.username=? AND u.approval_status='approved' AND u.role='member'").get(username) as any;
    if(!user||!timingSafeEqual(Buffer.from(sha256Hex(parsed.data.recoveryCode.trim())),Buffer.from(user.code_hash))){res.status(400).json({error:'اسم المستخدم أو كود الاسترجاع غير صالح'});return;}
    const now=Date.now(),replacement=generateOpaqueToken(24),hash=hashPassword(parsed.data.password);
    db.transaction(()=>{const changed=db.prepare('UPDATE account_recovery SET code_hash=?,created_at=? WHERE user_id=? AND code_hash=?').run(sha256Hex(replacement),now,user.id,user.code_hash);if(changed.changes!==1)throw new Error('Recovery already used');db.prepare('UPDATE users SET password_hash=?,updated_at=? WHERE id=?').run(hash,now,user.id);db.prepare('UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL').run(now,user.id);})();hub.notifyUserSessionsRevoked(user.id);res.setHeader('Cache-Control','no-store');res.json({ok:true,recoveryCode:replacement});
  });

  router.post('/auth/recovery-code',requireAuth,(req:AuthenticatedRequest,res)=>{const bucket='recovery-rotate:'+req.authUser!.id;if(!checkRateLimit(db,bucket,5,900000,900000).allowed){res.sendStatus(429);return;}recordFailedAttempt(db,bucket,5,900000,900000);const p=z.object({password:z.string().min(1).max(256)}).safeParse(req.body);const u=req.authUser!;const row=db.prepare('SELECT password_hash FROM users WHERE id=?').get(u.id) as any;if(u.role!=='member'||!p.success||!verifyPassword(p.data.password,row.password_hash)){res.status(403).json({error:'تحقق من كلمة المرور الحالية'});return;}const code=generateOpaqueToken(24);db.prepare('INSERT INTO account_recovery VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET code_hash=excluded.code_hash,created_at=excluded.created_at').run(u.id,sha256Hex(code),Date.now());res.setHeader('Cache-Control','no-store');res.json({recoveryCode:code});});

  const loginBodySchema = z.object({
    username: z.string().trim().min(1, 'اكتب اسم المستخدم'),
    password: z.string().min(1, 'اكتب كلمة المرور'),
  });

  router.post('/auth/login', (req, res) => {
    const parsed = loginBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'بيانات الدخول ناقصة' });
      return;
    }

    const normalizedUsername = normalizeUsername(parsed.data.username);
    const userBucket = `login:user:${normalizedUsername}`;
    const ipBucket = `login:ip:${req.ip || 'unknown'}`;

    const userLimit = checkRateLimit(db, userBucket, LOGIN_MAX_ATTEMPTS, LOGIN_WINDOW_MS, LOGIN_LOCK_MS);
    const ipLimit = checkRateLimit(db, ipBucket, LOGIN_MAX_ATTEMPTS * 3, LOGIN_WINDOW_MS, LOGIN_LOCK_MS);

    if (!userLimit.allowed || !ipLimit.allowed) {
      const waitMins = Math.max(
        1,
        Math.ceil(Math.max(userLimit.retryAfterMs, ipLimit.retryAfterMs) / 60_000)
      );
      res.status(429).json({
        error: `تم قفل محاولات الدخول مؤقتًا لكثرة المحاولات الخاطئة. حاول بعد ${waitMins} دقائق.`,
      });
      return;
    }

    const userRow = db
      .prepare(
        `SELECT id, display_name, username, password_hash, role, approval_status, history_granted, bio, avatar_asset_id, created_at, updated_at
         FROM users WHERE username = ?`
      )
      .get(normalizedUsername) as
      | {
          id: string;
          display_name: string;
          username: string;
          password_hash: string;
          role: 'member' | 'admin' | 'owner';
          approval_status: 'pending' | 'approved';
          history_granted: number;
          bio: string;
          avatar_asset_id: string | null;
          created_at: number;
          updated_at: number;
        }
      | undefined;

    if (!userRow || !verifyPassword(parsed.data.password, userRow.password_hash)) {
      const attemptRes = recordFailedAttempt(
        db,
        userBucket,
        LOGIN_MAX_ATTEMPTS,
        LOGIN_WINDOW_MS,
        LOGIN_LOCK_MS
      );
      recordFailedAttempt(db, ipBucket, LOGIN_MAX_ATTEMPTS * 3, LOGIN_WINDOW_MS, LOGIN_LOCK_MS);

      if (attemptRes.locked) {
        res.status(429).json({
          error: 'تم قفل محاولات الدخول مؤقتًا لمدة ١٠ دقائق بعد ٨ محاولات غير صحيحة.',
        });
        return;
      }
      res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
      return;
    }

    if (userRow.approval_status !== 'approved') {
      res.status(403).json({
        error: 'حسابك بانتظار موافقة المشرف.',
        code: 'PENDING_APPROVAL',
      });
      return;
    }

    clearRateLimit(db, userBucket);

    const now = Date.now();
    const rawToken = generateOpaqueToken(32);
    const sessionId = `ses_${randomUUID()}`;
    const expiresAt = now + config.sessionIdleMs;
    const deviceLabel = describeDevice(req.headers['user-agent']);

    db.prepare(
      `INSERT INTO sessions (id, user_id, token_hash, device_label, created_at, last_activity_at, expires_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`
    ).run(sessionId, userRow.id, sha256Hex(rawToken), deviceLabel, now, now, expiresAt);

    setSessionCookie(req, res, rawToken, config.sessionIdleMs);
    res.json({ user: mapUserRow(userRow), sessionToken: rawToken });
  });

  // Preview/dev-only login into fictional demo accounts (strictly disabled in production)
  if (config.previewDemoEnabled && !config.isProduction) {
    router.post('/auth/preview-login', (req, res) => {
      const requested = String(req.body?.username || '').trim().toLowerCase();
      const allowedDemo = new Set(['tareq.owner', 'salma.admin', 'youssef.member']);
      if (!allowedDemo.has(requested)) {
        res.status(400).json({ error: 'حساب المعاينة غير معروف' });
        return;
      }

      const userRow = db
        .prepare(
          `SELECT id, display_name, username, role, approval_status, history_granted, bio, avatar_asset_id, created_at, updated_at
           FROM users WHERE username = ? AND approval_status = 'approved'`
        )
        .get(requested) as
        | {
            id: string;
            display_name: string;
            username: string;
            role: 'member' | 'admin' | 'owner';
            approval_status: 'pending' | 'approved';
            history_granted: number;
            bio: string;
            avatar_asset_id: string | null;
            created_at: number;
            updated_at: number;
          }
        | undefined;

      if (!userRow) {
        res.status(404).json({ error: 'حساب المعاينة غير متاح' });
        return;
      }

      const now = Date.now();
      const rawToken = generateOpaqueToken(32);
      const sessionId = `ses_${randomUUID()}`;
      const expiresAt = now + config.sessionIdleMs;
      const deviceLabel = `معاينة محلية · ${describeDevice(req.headers['user-agent'])}`;

      db.prepare(
        `INSERT INTO sessions (id, user_id, token_hash, device_label, created_at, last_activity_at, expires_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`
      ).run(sessionId, userRow.id, sha256Hex(rawToken), deviceLabel, now, now, expiresAt);

      setSessionCookie(req, res, rawToken, config.sessionIdleMs);
      res.json({ user: mapUserRow(userRow), sessionToken: rawToken });
    });
  }

  router.post('/auth/logout', requireAuth, (req: AuthenticatedRequest, res) => {
    if (req.authSessionId) {
      db.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ?').run(
        Date.now(),
        req.authSessionId
      );
      hub.notifySessionRevoked(req.authSessionId);
    }
    clearSessionCookie(req, res);
    res.json({ ok: true });
  });

  router.get('/auth/me', requireAuth, (req: AuthenticatedRequest, res) => {
    res.json({ user: req.authUser });
  });

  router.get('/auth/ws-ticket', requireAuth, (req: AuthenticatedRequest, res) => {
    const ticket = signShortToken(
      {
        kind: 'ws',
        userId: req.authUser!.id,
        sessionId: req.authSessionId!,
        exp: Date.now() + 30_000,
      },
      signingSecret
    );
    res.json({ ticket });
  });

  router.get('/auth/sessions', requireAuth, (req: AuthenticatedRequest, res) => {
    const now = Date.now();
    const rows = db
      .prepare(
        `SELECT id, device_label, created_at, last_activity_at, expires_at
         FROM sessions
         WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
         ORDER BY last_activity_at DESC`
      )
      .all(req.authUser!.id, now) as Array<{
      id: string;
      device_label: string;
      created_at: number;
      last_activity_at: number;
      expires_at: number;
    }>;

    res.json({
      sessions: rows.map((r) => ({
        id: r.id,
        deviceLabel: r.device_label,
        createdAt: r.created_at,
        lastActivityAt: r.last_activity_at,
        expiresAt: r.expires_at,
        isCurrent: r.id === req.authSessionId,
      })),
    });
  });

  router.post('/auth/sessions/:id/revoke', requireAuth, (req: AuthenticatedRequest, res) => {
    const targetId = String(req.params.id);
    const existing = db
      .prepare('SELECT id FROM sessions WHERE id = ? AND user_id = ? AND revoked_at IS NULL')
      .get(targetId, req.authUser!.id) as { id: string } | undefined;

    if (!existing) {
      res.status(404).json({ error: 'الجلسة غير موجودة' });
      return;
    }

    db.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ?').run(Date.now(), targetId);
    hub.notifySessionRevoked(targetId);

    const revokedCurrent = targetId === req.authSessionId;
    if (revokedCurrent) {
      clearSessionCookie(req, res);
    }

    res.json({ ok: true, revokedCurrent });
  });

  router.post('/auth/sessions/revoke-others', requireAuth, (req: AuthenticatedRequest, res) => {
    const now = Date.now();
    db.prepare(
      'UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND id != ? AND revoked_at IS NULL'
    ).run(now, req.authUser!.id, req.authSessionId!);

    hub.notifyUserSessionsRevoked(req.authUser!.id, req.authSessionId);
    res.json({ ok: true });
  });

  router.patch('/auth/profile', requireAuth, (req: AuthenticatedRequest, res) => {
    const bodySchema = z.object({
      displayName: displayNameSchema.optional(),
      username: usernameSchema.optional(),
      bio: bioSchema.optional(),
      avatarAssetId: z.string().nullable().optional(),
    });

    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'البيانات غير صالحة' });
      return;
    }

    const userId = req.authUser!.id;
    const now = Date.now();
    const updates: string[] = [];
    const params: unknown[] = [];

    if (parsed.data.displayName !== undefined) {
      const conflict = db
        .prepare('SELECT id FROM users WHERE display_name = ? COLLATE NOCASE AND id != ?')
        .get(parsed.data.displayName, userId);
      if (conflict) {
        res.status(409).json({ error: 'الاسم الظاهر مستخدم لعضو آخر' });
        return;
      }
      updates.push('display_name = ?');
      params.push(parsed.data.displayName);
    }

    if (parsed.data.username !== undefined) {
      if (!parsed.data.username) {
        res.status(400).json({ error: 'لا يمكن إزالة اسم المستخدم' });
        return;
      }
      const conflict = db
        .prepare('SELECT id FROM users WHERE username = ? AND id != ?')
        .get(parsed.data.username, userId);
      if (conflict) {
        res.status(409).json({ error: 'اسم المستخدم محجوز بالفعل' });
        return;
      }
      updates.push('username = ?');
      params.push(parsed.data.username);
    }

    if (parsed.data.bio !== undefined) {
      updates.push('bio = ?');
      params.push(parsed.data.bio);
    }

    if (parsed.data.avatarAssetId !== undefined) {
      if (parsed.data.avatarAssetId === null) {
        updates.push('avatar_asset_id = NULL');
      } else {
        const asset = db
          .prepare(
            "SELECT id, uploader_id, kind FROM assets WHERE id = ? AND uploader_id = ? AND kind IN ('image', 'avatar') AND NOT EXISTS(SELECT 1 FROM group_message_assets WHERE asset_id=assets.id)"
          )
          .get(parsed.data.avatarAssetId, userId) as
          | { id: string; uploader_id: string; kind: string }
          | undefined;
        if (!asset) {
          res.status(403).json({ error: 'ملف الصورة غير صالح أو غير مملوك لك' });
          return;
        }
        db.prepare(
          "UPDATE assets SET binding_type = 'avatar', binding_id = ?, kind = 'avatar' WHERE id = ?"
        ).run(userId, asset.id);
        updates.push('avatar_asset_id = ?');
        params.push(asset.id);
      }
    }

    if (updates.length === 0) {
      res.json({ user: req.authUser });
      return;
    }

    updates.push('updated_at = ?');
    params.push(now, userId);

    db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);

    const updatedRow = db
      .prepare(
        `SELECT id, display_name, username, role, approval_status, history_granted, bio, avatar_asset_id, created_at, updated_at
         FROM users WHERE id = ?`
      )
      .get(userId) as Parameters<typeof mapUserRow>[0];

    hub.notifyUserUpdated(userId);
    res.json({ user: mapUserRow(updatedRow) });
  });

  const changePasswordSchema = z
    .object({
      currentPassword: z.string().min(1, 'اكتب كلمة المرور الحالية'),
      newPassword: passwordSchema,
      confirmNewPassword: z.string(),
    })
    .refine((d) => d.newPassword === d.confirmNewPassword, {
      message: 'كلمتا المرور الجديدتان غير متطابقتين',
      path: ['confirmNewPassword'],
    });

  router.post('/auth/password', requireAuth, (req: AuthenticatedRequest, res) => {
    const parsed = changePasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'بيانات غير صالحة' });
      return;
    }

    const userId = req.authUser!.id;
    const row = db
      .prepare('SELECT password_hash FROM users WHERE id = ?')
      .get(userId) as { password_hash: string } | undefined;

    if (!row || !verifyPassword(parsed.data.currentPassword, row.password_hash)) {
      res.status(400).json({ error: 'كلمة المرور الحالية غير صحيحة' });
      return;
    }

    const now = Date.now();
    const newHash = hashPassword(parsed.data.newPassword);
    const newRawToken = generateOpaqueToken(32);
    const newExpiresAt = now + config.sessionIdleMs;

    const tx = db.transaction(() => {
      db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(
        newHash,
        now,
        userId
      );
      // Invalidate all other sessions, and rotate the current session token deliberately
      db.prepare(
        'UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND id != ? AND revoked_at IS NULL'
      ).run(now, userId, req.authSessionId!);
      db.prepare(
        'UPDATE sessions SET token_hash = ?, last_activity_at = ?, expires_at = ? WHERE id = ?'
      ).run(sha256Hex(newRawToken), now, newExpiresAt, req.authSessionId!);
    });
    tx();

    hub.notifyUserSessionsRevoked(userId, req.authSessionId);
    setSessionCookie(req, res, newRawToken, config.sessionIdleMs);
    res.json({ ok: true, message: 'تم تحديث كلمة المرور وتأمين جلساتك', sessionToken: newRawToken });
  });

  return router;
}
