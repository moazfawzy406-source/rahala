import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as archiverNs from 'archiver';
import { z } from 'zod';

const ZipArchiveCtor = (
  archiverNs as unknown as {
    ZipArchive: new (opts?: { zlib?: { level: number } }) => archiverNs.Archiver;
  }
).ZipArchive;
import type { RahhalaConfig } from '../config.ts';
import { setSetting, type RahhalaDb } from '../db.ts';
import { hashPassword } from '../lib/crypto.ts';
import { emailSchema, isSafeHttpUrl, passwordSchema } from '../lib/validation.ts';
import { type AuthenticatedRequest, createAuthMiddleware } from '../middleware/auth.ts';
import type { RealtimeHub } from '../ws.ts';
import type { UserRole } from '../../shared/types.ts';

function writeAudit(
  db: RahhalaDb,
  actorId: string,
  action: string,
  targetId: string | null,
  metadata: Record<string, string | number | boolean> = {}
): void {
  db.prepare(
    'INSERT INTO admin_audits (id, actor_id, action, target_id, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(`aud_${randomUUID().slice(0, 12)}`, actorId, action, targetId, JSON.stringify(metadata), Date.now());
}

export function createAdminRouter(
  db: RahhalaDb,
  config: RahhalaConfig,
  hub: RealtimeHub
): Router {
  const router = Router();
  const { requireAuth, requireAdminOrOwner, requireOwner } = createAuthMiddleware(db, config);

  router.get('/admin/requests', requireAuth, requireAdminOrOwner, (_req, res) => {
    const pendingUsers = db
      .prepare(
        `SELECT id, display_name, username, email, created_at
         FROM users
         WHERE approval_status = 'pending'
         ORDER BY created_at ASC`
      )
      .all() as Array<{
      id: string;
      display_name: string;
      username: string;
      email: string;
      created_at: number;
    }>;

    const pendingHistory = db
      .prepare(
        `SELECT hr.id, hr.user_id, u.display_name, u.username, hr.status, hr.created_at
         FROM history_requests hr
         JOIN users u ON u.id = hr.user_id
         WHERE hr.status = 'pending' AND u.approval_status = 'approved'
         ORDER BY hr.created_at ASC`
      )
      .all() as Array<{
      id: string;
      user_id: string;
      display_name: string;
      username: string;
      status: 'pending';
      created_at: number;
    }>;

    res.json({
      pendingUsers: pendingUsers.map((u) => ({
        id: u.id,
        displayName: u.display_name,
        username: u.username,
        email: u.email,
        createdAt: u.created_at,
      })),
      pendingHistory: pendingHistory.map((h) => ({
        id: h.id,
        userId: h.user_id,
        displayName: h.display_name,
        username: h.username,
        status: h.status,
        createdAt: h.created_at,
        decidedById: null,
        decidedAt: null,
      })),
      totalPendingCount: pendingUsers.length + pendingHistory.length,
    });
  });

  // Approve pending registration (does NOT auto-grant historical chat access!)
  router.post(
    '/admin/registrations/:id/approve',
    requireAuth,
    requireAdminOrOwner,
    (req: AuthenticatedRequest, res) => {
      const targetId = String(req.params.id);
      const target = db
        .prepare("SELECT id, approval_status FROM users WHERE id = ? AND approval_status = 'pending'")
        .get(targetId) as { id: string } | undefined;

      if (!target) {
        res.status(404).json({ error: 'طلب الانضمام غير موجود' });
        return;
      }

      const now = Date.now();
      db.prepare(
        "UPDATE users SET approval_status = 'approved', history_granted = 0, updated_at = ? WHERE id = ?"
      ).run(now, targetId);

      writeAudit(db, req.authUser!.id, 'registration_approved', targetId);
      res.json({ ok: true });
    }
  );

  // Reject pending registration (removes pending account safely)
  router.post(
    '/admin/registrations/:id/reject',
    requireAuth,
    requireAdminOrOwner,
    (req: AuthenticatedRequest, res) => {
      const targetId = String(req.params.id);
      const target = db
        .prepare("SELECT id FROM users WHERE id = ? AND approval_status = 'pending'")
        .get(targetId) as { id: string } | undefined;

      if (!target) {
        res.status(404).json({ error: 'طلب الانضمام غير موجود' });
        return;
      }

      db.prepare("DELETE FROM users WHERE id = ? AND approval_status = 'pending'").run(targetId);
      writeAudit(db, req.authUser!.id, 'registration_rejected', targetId);
      res.json({ ok: true });
    }
  );

  router.post(
    '/admin/history-requests/:id/decide',
    requireAuth,
    requireAdminOrOwner,
    (req: AuthenticatedRequest, res) => {
      const reqId = String(req.params.id);
      const decision = req.body?.decision === 'approved' ? 'approved' : req.body?.decision === 'rejected' ? 'rejected' : null;
      if (!decision) {
        res.status(400).json({ error: 'قرار غير صالح' });
        return;
      }

      const hr = db
        .prepare("SELECT id, user_id FROM history_requests WHERE id = ? AND status = 'pending'")
        .get(reqId) as { id: string; user_id: string } | undefined;

      if (!hr) {
        res.status(404).json({ error: 'طلب الوصول للرسائل القديمة غير موجود' });
        return;
      }

      const now = Date.now();
      const tx = db.transaction(() => {
        db.prepare(
          'UPDATE history_requests SET status = ?, decided_by_id = ?, decided_at = ? WHERE id = ?'
        ).run(decision, req.authUser!.id, now, reqId);
        if (decision === 'approved') {
          db.prepare('UPDATE users SET history_granted = 1, updated_at = ? WHERE id = ?').run(
            now,
            hr.user_id
          );
        }
        writeAudit(db, req.authUser!.id, `history_${decision}`, hr.user_id);
      });
      tx();

      hub.notifyUserUpdated(hr.user_id);
      res.json({ ok: true });
    }
  );

  // Promote/demote non-owner between member and admin (cannot change own role or owner!)
  router.post(
    '/admin/members/:id/role',
    requireAuth,
    requireAdminOrOwner,
    (req: AuthenticatedRequest, res) => {
      const targetId = String(req.params.id);
      const nextRole = req.body?.role;
      if (nextRole !== 'member' && nextRole !== 'admin') {
        res.status(400).json({ error: 'الدور المسموح هو عضو أو مشرف فقط' });
        return;
      }

      if (targetId === req.authUser!.id) {
        res.status(403).json({ error: 'لا يمكنك تغيير دورك بنفسك' });
        return;
      }

      const target = db
        .prepare("SELECT id, role FROM users WHERE id = ? AND approval_status = 'approved'")
        .get(targetId) as { id: string; role: UserRole } | undefined;

      if (!target) {
        res.status(404).json({ error: 'العضو غير موجود' });
        return;
      }

      if (target.role === 'owner') {
        res.status(403).json({ error: 'لا يمكن تغيير دور مالك المنصة' });
        return;
      }

      db.prepare('UPDATE users SET role = ?, updated_at = ? WHERE id = ?').run(
        nextRole,
        Date.now(),
        targetId
      );
      writeAudit(db, req.authUser!.id, 'role_changed', targetId, { role: nextRole });
      hub.notifyUserUpdated(targetId);
      res.json({ ok: true });
    }
  );

  // Remove member: admin removes ordinary member; ONLY owner removes admin; never self or owner
  router.delete(
    '/admin/members/:id',
    requireAuth,
    requireAdminOrOwner,
    (req: AuthenticatedRequest, res) => {
      const targetId = String(req.params.id);
      const actor = req.authUser!;

      if (targetId === actor.id) {
        res.status(403).json({ error: 'لا يمكنك إزالة حسابك بنفسك' });
        return;
      }

      const target = db
        .prepare('SELECT id, role, avatar_asset_id FROM users WHERE id = ?')
        .get(targetId) as { id: string; role: UserRole; avatar_asset_id: string | null } | undefined;

      if (!target) {
        res.status(404).json({ error: 'العضو غير موجود' });
        return;
      }

      if (target.role === 'owner') {
        res.status(403).json({ error: 'حساب مالك المنصة محمي ولا يمكن إزالته' });
        return;
      }

      if (target.role === 'admin' && actor.role !== 'owner') {
        res.status(403).json({ error: 'إزالة مشرف متاحة لمالك المنصة فقط' });
        return;
      }

      const tx = db.transaction(() => {
        // Preserve existing chat messages safely with neutral former-member identity
        db.prepare(
          "UPDATE messages SET sender_id = NULL, sender_name_snapshot = 'عضو سابق' WHERE sender_id = ?"
        ).run(targetId);
        // Clean private user records & sessions (FK cascade also handles sessions/hides/reactions/receipts)
        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(targetId);
        db.prepare('DELETE FROM users WHERE id = ?').run(targetId);
        if (target.avatar_asset_id) {
          db.prepare('DELETE FROM assets WHERE id = ?').run(target.avatar_asset_id);
        }
        writeAudit(db, actor.id, 'member_removed', targetId, { priorRole: target.role });
      });
      tx();

      hub.notifyUserSessionsRevoked(targetId);
      res.json({ ok: true });
    }
  );

  // Privately update target email (admin for member; owner for admin/member; never owner)
  router.patch(
    '/admin/members/:id/email',
    requireAuth,
    requireAdminOrOwner,
    (req: AuthenticatedRequest, res) => {
      const targetId = String(req.params.id);
      const actor = req.authUser!;
      const parsed = emailSchema.safeParse(req.body?.email);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0]?.message || 'بريد غير صالح' });
        return;
      }

      const target = db
        .prepare('SELECT id, role FROM users WHERE id = ?')
        .get(targetId) as { id: string; role: UserRole } | undefined;
      if (!target) {
        res.status(404).json({ error: 'العضو غير موجود' });
        return;
      }

      if (target.role === 'owner') {
        res.status(403).json({ error: 'لا يمكن تعديل بريد المالك من هنا' });
        return;
      }
      if (target.role === 'admin' && actor.role !== 'owner') {
        res.status(403).json({ error: 'تعديل بيانات المشرف متاح للمالك فقط' });
        return;
      }

      db.prepare('UPDATE users SET email = ?, updated_at = ? WHERE id = ?').run(
        parsed.data,
        Date.now(),
        targetId
      );
      writeAudit(db, actor.id, 'member_email_updated', targetId);
      res.json({ ok: true });
    }
  );

  // Administrative temporary password reset (admin for member; owner for admin/member; never owner)
  router.post(
    '/admin/members/:id/reset-password',
    requireAuth,
    requireAdminOrOwner,
    (req: AuthenticatedRequest, res) => {
      const targetId = String(req.params.id);
      const actor = req.authUser!;
      const parsed = passwordSchema.safeParse(req.body?.temporaryPassword);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0]?.message || 'كلمة المرور غير صالحة' });
        return;
      }

      const target = db
        .prepare('SELECT id, role FROM users WHERE id = ?')
        .get(targetId) as { id: string; role: UserRole } | undefined;
      if (!target) {
        res.status(404).json({ error: 'العضو غير موجود' });
        return;
      }

      if (target.role === 'owner') {
        res.status(403).json({ error: 'لا يمكن إعادة تعيين كلمة مرور مالك المنصة عبر حساب آخر' });
        return;
      }
      if (target.role === 'admin' && actor.role !== 'owner') {
        res.status(403).json({ error: 'إعادة تعيين كلمة مرور مشرف متاحة للمالك فقط' });
        return;
      }

      const now = Date.now();
      const newHash = hashPassword(parsed.data);

      const tx = db.transaction(() => {
        db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(
          newHash,
          now,
          targetId
        );
        // Revoke ALL target sessions immediately
        db.prepare(
          'UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL'
        ).run(now, targetId);
        // Never log plaintext password!
        writeAudit(db, actor.id, 'member_password_reset', targetId);
      });
      tx();

      hub.notifyUserSessionsRevoked(targetId);
      res.json({ ok: true });
    }
  );

  // Configurable branding & meeting provider settings (admin/owner)
  router.patch(
    '/admin/settings',
    requireAuth,
    requireAdminOrOwner,
    (req: AuthenticatedRequest, res) => {
      const iceEntrySchema = z.object({
        urls: z.union([
          z.string().trim().min(5).max(300),
          z.array(z.string().trim().min(5).max(300)).min(1).max(6),
        ]),
        username: z.string().trim().max(200).optional(),
        credential: z.string().trim().max(200).optional(),
      });
      const schema = z.object({
        institutionSubtitle: z.string().trim().max(120).optional(),
        meetingProviderUrl: z.string().trim().max(500).optional(),
        meetingMode: z.enum(['builtin', 'external', 'unconfigured']).optional(),
        defaultRoomAccessType: z.enum(['open', 'knock']).optional(),
        iceServers: z.array(iceEntrySchema).max(10).optional(),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'إعدادات غير صالحة' });
        return;
      }

      if (parsed.data.institutionSubtitle !== undefined) {
        setSetting(db, 'institution_subtitle', parsed.data.institutionSubtitle);
      }

      if (parsed.data.meetingMode !== undefined) {
        setSetting(db, 'meeting_mode', parsed.data.meetingMode);
        if (parsed.data.meetingMode !== 'external') {
          setSetting(db, 'meeting_provider_url', '');
        }
      }

      if (parsed.data.meetingProviderUrl !== undefined) {
        const url = parsed.data.meetingProviderUrl;
        if (url !== '' && !isSafeHttpUrl(url)) {
          res.status(400).json({ error: 'رابط مزود الاجتماعات لازم يبدأ بـ https:// أو http://' });
          return;
        }
        if (parsed.data.meetingMode === undefined || parsed.data.meetingMode === 'external') {
          setSetting(db, 'meeting_provider_url', url);
        }
      }

      if (parsed.data.defaultRoomAccessType !== undefined) {
        setSetting(db, 'default_room_access_type', parsed.data.defaultRoomAccessType);
      }

      if (parsed.data.iceServers !== undefined) {
        for (const entry of parsed.data.iceServers) {
          const urlsList = Array.isArray(entry.urls) ? entry.urls : [entry.urls];
          for (const u of urlsList) {
            if (!/^(stuns?|turns?):/i.test(u)) {
              res.status(400).json({ error: 'خوادم WebRTC لازم تبدأ بـ stun: أو stuns: أو turn: أو turns:' });
              return;
            }
          }
        }
        setSetting(
          db,
          'ice_servers_json',
          parsed.data.iceServers.length > 0 ? JSON.stringify(parsed.data.iceServers) : ''
        );
      }

      writeAudit(db, req.authUser!.id, 'settings_updated', null);
      res.json({ ok: true });
    }
  );

  // Owner-only sanitized source archive export (excludes secrets, DB, uploads, logs, node_modules, dist)
  router.get('/admin/export-archive', requireAuth, requireOwner, (_req, res) => {
    const rootDir = process.cwd();
    const excludeTopDirs = new Set([
      'node_modules',
      'dist',
      'data',
      '.git',
      '.next',
      '.aistudio',
      'coverage',
      'logs',
    ]);
    const excludeFilePatterns = [
      /^\.env/i,
      /\.db(-wal|-shm)?$/i,
      /\.sqlite$/i,
      /\.log$/i,
      /\.pem$/i,
      /\.key$/i,
    ];

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="rahhala-source-sanitized.zip"');
    res.setHeader('Cache-Control', 'private, no-store');

    const archive = new ZipArchiveCtor({ zlib: { level: 6 } });
    archive.on('error', () => {
      if (!res.headersSent) {
        res.status(500).json({ error: 'تعذر تجهيز الأرشيف' });
      }
    });
    archive.pipe(res);

    function walk(currentDir: string, relBase: string): void {
      const entries = fs.readdirSync(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        const relPath = relBase ? `${relBase}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (excludeTopDirs.has(entry.name)) continue;
          walk(path.join(currentDir, entry.name), relPath);
        } else if (entry.isFile()) {
          if (excludeFilePatterns.some((rx) => rx.test(entry.name))) continue;
          archive.file(path.join(currentDir, entry.name), { name: relPath });
        }
      }
    }

    walk(rootDir, '');
    void archive.finalize();
  });

  return router;
}
