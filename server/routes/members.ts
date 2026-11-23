import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import type { RahhalaConfig } from '../config.ts';
import type { RahhalaDb } from '../db.ts';
import { type AuthenticatedRequest, createAuthMiddleware } from '../middleware/auth.ts';
import type { PublicMember, UserRole } from '../../shared/types.ts';

function canViewerManageTargetEmail(viewerRole: UserRole, targetRole: UserRole): boolean {
  if (viewerRole === 'owner') return targetRole !== 'owner';
  if (viewerRole === 'admin') return targetRole === 'member';
  return false;
}

export function createMembersRouter(db: RahhalaDb, config: RahhalaConfig): Router {
  const router = Router();
  const { requireAuth } = createAuthMiddleware(db, config);

  router.get('/members', requireAuth, (req: AuthenticatedRequest, res) => {
    const q = String(req.query.q || '').trim().toLowerCase();
    const viewer = req.authUser!;

    const rows = db
      .prepare(
        `SELECT u.id, u.display_name, u.username, u.email, u.role, u.history_granted, u.bio, u.avatar_asset_id, u.created_at,
                (SELECT COUNT(*) FROM messages m WHERE m.sender_id = u.id AND m.deleted_at IS NULL) AS message_count
         FROM users u
         WHERE u.approval_status = 'approved'
         ORDER BY CASE u.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END ASC, u.created_at ASC`
      )
      .all() as Array<{
      id: string;
      display_name: string;
      username: string;
      email: string;
      role: UserRole;
      history_granted: number;
      bio: string;
      avatar_asset_id: string | null;
      created_at: number;
      message_count: number;
    }>;

    const filtered = q
      ? rows.filter(
          (r) =>
            r.display_name.toLowerCase().includes(q) || r.username.toLowerCase().includes(q)
        )
      : rows;

    const members: PublicMember[] = filtered.map((r) => {
      const base: PublicMember = {
        id: r.id,
        displayName: r.display_name,
        username: r.username,
        role: r.role,
        bio: r.bio,
        avatarAssetId: r.avatar_asset_id,
        createdAt: r.created_at,
        messageCount: r.message_count,
      };
      if (viewer.role === 'admin' || viewer.role === 'owner') {
        base.historyGranted = Boolean(r.history_granted);
      }
      if (canViewerManageTargetEmail(viewer.role, r.role)) {
        base.privateEmail = r.email;
      }
      return base;
    });

    res.json({ members });
  });

  router.get('/members/history-request/mine', requireAuth, (req: AuthenticatedRequest, res) => {
    const user = req.authUser!;
    if (user.role === 'owner' || user.role === 'admin' || user.historyGranted) {
      res.json({ historyGranted: true, request: null });
      return;
    }

    const row = db
      .prepare(
        'SELECT id, user_id, status, created_at, decided_by_id, decided_at FROM history_requests WHERE user_id = ?'
      )
      .get(user.id) as
      | {
          id: string;
          user_id: string;
          status: 'pending' | 'approved' | 'rejected';
          created_at: number;
          decided_by_id: string | null;
          decided_at: number | null;
        }
      | undefined;

    res.json({
      historyGranted: false,
      request: row
        ? {
            id: row.id,
            userId: row.user_id,
            status: row.status,
            createdAt: row.created_at,
            decidedById: row.decided_by_id,
            decidedAt: row.decided_at,
          }
        : null,
    });
  });

  router.post('/members/history-request', requireAuth, (req: AuthenticatedRequest, res) => {
    const user = req.authUser!;
    if (user.role === 'owner' || user.role === 'admin' || user.historyGranted) {
      res.status(400).json({ error: 'صلاحية الرسائل القديمة مفعّلة لديك بالفعل' });
      return;
    }

    const existing = db
      .prepare('SELECT id, status FROM history_requests WHERE user_id = ?')
      .get(user.id) as { id: string; status: string } | undefined;

    if (existing && existing.status === 'pending') {
      res.status(409).json({ error: 'لديك طلب قيد المراجعة بالفعل' });
      return;
    }

    const now = Date.now();
    const id = existing?.id || `hreq_${randomUUID().slice(0, 10)}`;
    if (existing) {
      db.prepare(
        `UPDATE history_requests
         SET status = 'pending', created_at = ?, decided_by_id = NULL, decided_at = NULL
         WHERE id = ?`
      ).run(now, id);
    } else {
      db.prepare(
        `INSERT INTO history_requests (id, user_id, status, created_at, decided_by_id, decided_at)
         VALUES (?, ?, 'pending', ?, NULL, NULL)`
      ).run(id, user.id, now);
    }

    res.status(201).json({
      request: {
        id,
        userId: user.id,
        status: 'pending',
        createdAt: now,
        decidedById: null,
        decidedAt: null,
      },
    });
  });

  router.get('/members/:id', requireAuth, (req: AuthenticatedRequest, res) => {
    const targetId = String(req.params.id);
    const viewer = req.authUser!;

    const r = db
      .prepare(
        `SELECT u.id, u.display_name, u.username, u.email, u.role, u.history_granted, u.bio, u.avatar_asset_id, u.created_at,
                (SELECT COUNT(*) FROM messages m WHERE m.sender_id = u.id AND m.deleted_at IS NULL) AS message_count
         FROM users u
         WHERE u.id = ? AND u.approval_status = 'approved'`
      )
      .get(targetId) as
      | {
          id: string;
          display_name: string;
          username: string;
          email: string;
          role: UserRole;
          history_granted: number;
          bio: string;
          avatar_asset_id: string | null;
          created_at: number;
          message_count: number;
        }
      | undefined;

    if (!r) {
      res.status(404).json({ error: 'العضو غير موجود' });
      return;
    }

    const member: PublicMember = {
      id: r.id,
      displayName: r.display_name,
      username: r.username,
      role: r.role,
      bio: r.bio,
      avatarAssetId: r.avatar_asset_id,
      createdAt: r.created_at,
      messageCount: r.message_count,
    };

    if (viewer.role === 'admin' || viewer.role === 'owner') {
      member.historyGranted = Boolean(r.history_granted);
    }
    if (canViewerManageTargetEmail(viewer.role, r.role)) {
      member.privateEmail = r.email;
    }

    res.json({ member });
  });

  return router;
}
