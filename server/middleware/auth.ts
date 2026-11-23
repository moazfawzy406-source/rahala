import type { NextFunction, Request, Response } from 'express';
import type { RahhalaConfig } from '../config.ts';
import type { RahhalaDb } from '../db.ts';
import { sha256Hex } from '../lib/crypto.ts';
import type { AuthUser, UserRole } from '../../shared/types.ts';

export const SESSION_COOKIE_NAME = 'rahhala_sid';

export interface AuthenticatedRequest extends Request {
  authUser?: AuthUser;
  authSessionId?: string;
}

export function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!cookieHeader) return result;
  const parts = cookieHeader.split(';');
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) {
      try {
        result[k] = decodeURIComponent(v);
      } catch {
        result[k] = v;
      }
    }
  }
  return result;
}

export function extractSessionToken(req: {
  headers: { cookie?: string; authorization?: string };
}): string | undefined {
  const cookies = parseCookies(req.headers.cookie);
  if (cookies[SESSION_COOKIE_NAME]) {
    return cookies[SESSION_COOKIE_NAME];
  }
  const authHeader = req.headers.authorization;
  if (typeof authHeader === 'string' && authHeader.toLowerCase().startsWith('bearer ')) {
    const token = authHeader.slice(7).trim();
    if (token) return token;
  }
  return undefined;
}

export function setSessionCookie(req: Request, res: Response, rawToken: string, maxAgeMs: number): void {
  const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.cookie(SESSION_COOKIE_NAME, rawToken, {
    httpOnly: true,
    sameSite: isHttps ? 'none' : 'lax',
    secure: isHttps,
    path: '/',
    maxAge: maxAgeMs,
  });
}

export function clearSessionCookie(req: Request, res: Response): void {
  const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.clearCookie(SESSION_COOKIE_NAME, {
    httpOnly: true,
    sameSite: isHttps ? 'none' : 'lax',
    secure: isHttps,
    path: '/',
  });
}

export function mapUserRow(row: {
  id: string;
  display_name: string;
  username: string;
  role: UserRole;
  approval_status: 'pending' | 'approved';
  history_granted: number;
  bio: string;
  avatar_asset_id: string | null;
  created_at: number;
  updated_at: number;
}): AuthUser {
  return {
    id: row.id,
    displayName: row.display_name,
    username: row.username,
    role: row.role,
    approvalStatus: row.approval_status,
    historyGranted: Boolean(row.history_granted),
    bio: row.bio,
    avatarAssetId: row.avatar_asset_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface SessionCheckResult {
  user: AuthUser;
  sessionId: string;
}

export function resolveActiveSession(
  db: RahhalaDb,
  config: RahhalaConfig,
  rawToken: string | undefined,
  options: { touchActivity: boolean }
): { ok: true; data: SessionCheckResult } | { ok: false; code: string; message: string } {
  if (!rawToken) {
    return { ok: false, code: 'NO_SESSION', message: 'يلزم تسجيل الدخول للمتابعة' };
  }

  const tokenHash = sha256Hex(rawToken);
  const now = Date.now();

  const session = db
    .prepare(
      `SELECT id, user_id, last_activity_at, expires_at, revoked_at
       FROM sessions
       WHERE token_hash = ?`
    )
    .get(tokenHash) as
    | {
        id: string;
        user_id: string;
        last_activity_at: number;
        expires_at: number;
        revoked_at: number | null;
      }
    | undefined;

  if (!session || session.revoked_at !== null) {
    return { ok: false, code: 'SESSION_REVOKED', message: 'انتهت صلاحية الجلسة، سجل دخول من جديد' };
  }

  if (now > session.expires_at || now - session.last_activity_at > config.sessionIdleMs) {
    db.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(
      now,
      session.id
    );
    return {
      ok: false,
      code: 'SESSION_IDLE_EXPIRED',
      message: 'انتهت صلاحية الجلسة بعد فترة طويلة من عدم الاستخدام، سجل دخول من جديد',
    };
  }

  const userRow = db
    .prepare(
      `SELECT id, display_name, username, role, approval_status, history_granted, bio, avatar_asset_id, created_at, updated_at
       FROM users
       WHERE id = ?`
    )
    .get(session.user_id) as
    | {
        id: string;
        display_name: string;
        username: string;
        role: UserRole;
        approval_status: 'pending' | 'approved';
        history_granted: number;
        bio: string;
        avatar_asset_id: string | null;
        created_at: number;
        updated_at: number;
      }
    | undefined;

  if (!userRow) {
    return { ok: false, code: 'USER_NOT_FOUND', message: 'الحساب غير موجود' };
  }

  if (userRow.approval_status !== 'approved') {
    return { ok: false, code: 'PENDING_APPROVAL', message: 'حسابك بانتظار موافقة المشرف' };
  }

  if (options.touchActivity) {
    const newExpiry = now + config.sessionIdleMs;
    db.prepare('UPDATE sessions SET last_activity_at = ?, expires_at = ? WHERE id = ?').run(
      now,
      newExpiry,
      session.id
    );
  }

  return {
    ok: true,
    data: {
      user: mapUserRow(userRow),
      sessionId: session.id,
    },
  };
}

export function createAuthMiddleware(db: RahhalaDb, config: RahhalaConfig) {
  function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
    const rawToken = extractSessionToken(req);
    const isBackground = req.query.background === '1' || req.headers['x-rahhala-background'] === '1';

    const resolved = resolveActiveSession(db, config, rawToken, {
      touchActivity: !isBackground,
    });

    if (!resolved.ok) {
      clearSessionCookie(req, res);
      res.status(401).json({ error: resolved.message, code: resolved.code });
      return;
    }

    // Renew both the server lease and persistent browser cookie on active use.
    // Background polling does not keep an abandoned session alive.
    if (!isBackground && rawToken) setSessionCookie(req, res, rawToken, config.sessionIdleMs);
    req.authUser = resolved.data.user;
    req.authSessionId = resolved.data.sessionId;
    next();
  }

  function requireAdminOrOwner(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
    if (!req.authUser) {
      res.status(401).json({ error: 'يلزم تسجيل الدخول' });
      return;
    }
    if (req.authUser.role !== 'admin' && req.authUser.role !== 'owner') {
      res.status(403).json({ error: 'هذا الإجراء متاح للمشرفين والمالك فقط' });
      return;
    }
    next();
  }

  function requireOwner(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
    if (!req.authUser) {
      res.status(401).json({ error: 'يلزم تسجيل الدخول' });
      return;
    }
    if (req.authUser.role !== 'owner') {
      res.status(403).json({ error: 'هذا الإجراء متاح لمالك المنصة فقط' });
      return;
    }
    next();
  }

  return { requireAuth, requireAdminOrOwner, requireOwner };
}

export function csrfProtectionMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    next();
    return;
  }
  const hasCsrfHeader = req.headers['x-rahhala-csrf'] === '1' || req.headers['x-requested-with'] === 'XMLHttpRequest';
  if (!hasCsrfHeader) {
    res.status(403).json({ error: 'طلب غير مصرح به (تحقق الأمان مفقود)' });
    return;
  }
  next();
}

export function checkRateLimit(
  db: RahhalaDb,
  bucketKey: string,
  maxAttempts: number,
  windowMs: number,
  lockDurationMs: number
): { allowed: boolean; retryAfterMs: number } {
  const now = Date.now();
  // Prune expired rate-limit entries periodically (bounded storage)
  db.prepare('DELETE FROM auth_attempts WHERE expires_at < ?').run(now);

  const keyHash = sha256Hex(bucketKey);
  const row = db
    .prepare('SELECT attempts, window_start, locked_until, expires_at FROM auth_attempts WHERE key_hash = ?')
    .get(keyHash) as
    | { attempts: number; window_start: number; locked_until: number | null; expires_at: number }
    | undefined;

  if (!row) {
    return { allowed: true, retryAfterMs: 0 };
  }

  if (row.locked_until !== null && row.locked_until > now) {
    return { allowed: false, retryAfterMs: row.locked_until - now };
  }

  if (now - row.window_start > windowMs) {
    db.prepare('DELETE FROM auth_attempts WHERE key_hash = ?').run(keyHash);
    return { allowed: true, retryAfterMs: 0 };
  }

  if (row.attempts >= maxAttempts) {
    const lockedUntil = now + lockDurationMs;
    db.prepare('UPDATE auth_attempts SET locked_until = ?, expires_at = ? WHERE key_hash = ?').run(
      lockedUntil,
      lockedUntil + windowMs,
      keyHash
    );
    return { allowed: false, retryAfterMs: lockDurationMs };
  }

  return { allowed: true, retryAfterMs: 0 };
}

export function recordFailedAttempt(
  db: RahhalaDb,
  bucketKey: string,
  maxAttempts: number,
  windowMs: number,
  lockDurationMs: number
): { locked: boolean; retryAfterMs: number } {
  const now = Date.now();
  const keyHash = sha256Hex(bucketKey);
  const row = db
    .prepare('SELECT attempts, window_start, locked_until FROM auth_attempts WHERE key_hash = ?')
    .get(keyHash) as { attempts: number; window_start: number; locked_until: number | null } | undefined;

  if (!row || now - row.window_start > windowMs) {
    const attempts = 1;
    const lockedUntil = attempts >= maxAttempts ? now + lockDurationMs : null;
    db.prepare(
      `INSERT INTO auth_attempts (key_hash, attempts, window_start, locked_until, expires_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(key_hash) DO UPDATE SET
         attempts = excluded.attempts,
         window_start = excluded.window_start,
         locked_until = excluded.locked_until,
         expires_at = excluded.expires_at`
    ).run(keyHash, attempts, now, lockedUntil, (lockedUntil ?? now) + windowMs);
    return { locked: lockedUntil !== null, retryAfterMs: lockedUntil ? lockDurationMs : 0 };
  }

  const nextAttempts = row.attempts + 1;
  const lockedUntil = nextAttempts >= maxAttempts ? now + lockDurationMs : null;
  db.prepare(
    'UPDATE auth_attempts SET attempts = ?, locked_until = ?, expires_at = ? WHERE key_hash = ?'
  ).run(nextAttempts, lockedUntil, (lockedUntil ?? now) + windowMs, keyHash);

  return { locked: lockedUntil !== null, retryAfterMs: lockedUntil ? lockDurationMs : 0 };
}

export function clearRateLimit(db: RahhalaDb, bucketKey: string): void {
  const keyHash = sha256Hex(bucketKey);
  db.prepare('DELETE FROM auth_attempts WHERE key_hash = ?').run(keyHash);
}
