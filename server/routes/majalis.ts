import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { MajalisChatMessageRecord } from '../../shared/types.ts';
import type { RahhalaConfig } from '../config.ts';
import type { RahhalaDb } from '../db.ts';
import { type AuthenticatedRequest, createAuthMiddleware } from '../middleware/auth.ts';
import type { RealtimeHub } from '../ws.ts';

export function createMajalisRouter(
  db: RahhalaDb,
  config: RahhalaConfig,
  hub: RealtimeHub
): Router {
  const router = Router();
  const { requireAuth } = createAuthMiddleware(db, config);

  router.get('/majalis/rooms', requireAuth, (_req: AuthenticatedRequest, res) => {
    const rooms = hub.getMajalisRoomsSnapshot();
    res.json({ rooms });
  });

  const createRoomSchema = z.object({
    title: z
      .string()
      .trim()
      .min(3, 'اكتب اسمًا واضحًا للمجلس (٣ أحرف على الأقل)')
      .max(60, 'اسم المجلس طويل جدًا (بحد أقصى ٦٠ حرفًا)'),
    subjectId: z.string().trim().min(1).max(80).nullable().optional(),
  });

  router.post('/majalis/rooms', requireAuth, (req: AuthenticatedRequest, res) => {
    const parsed = createRoomSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'بيانات المجلس غير صالحة' });
      return;
    }

    const totalRooms = (
      db.prepare('SELECT COUNT(*) AS cnt FROM majalis_rooms').get() as { cnt: number }
    ).cnt;
    if (totalRooms >= 30) {
      res.status(400).json({ error: 'تم الوصول للحد الأقصى لعدد مجالس المذاكرة' });
      return;
    }

    let resolvedSubjectId: string | null = null;
    let resolvedSubjectName = 'مذاكرة جماعية';

    if (parsed.data.subjectId) {
      const subj = db
        .prepare('SELECT id, name FROM subjects WHERE id = ?')
        .get(parsed.data.subjectId) as { id: string; name: string } | undefined;
      if (!subj) {
        res.status(404).json({ error: 'المادة المختارة غير موجودة' });
        return;
      }
      resolvedSubjectId = subj.id;
      resolvedSubjectName = subj.name;
    }

    const id = `room_${randomUUID()}`;
    const now = Date.now();

    db.prepare(
      `INSERT INTO majalis_rooms (
         id, title, subject_id, subject_name_snapshot, creator_id, creator_name_snapshot, is_default, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, 0, ?)`
    ).run(
      id,
      parsed.data.title,
      resolvedSubjectId,
      resolvedSubjectName,
      req.authUser!.id,
      req.authUser!.displayName,
      now
    );

    hub.broadcastMajalisLobbyUpdated();
    const room = hub.getMajalisRoomsSnapshot().find((r) => r.id === id);
    res.status(201).json({ room });
  });

  router.delete('/majalis/rooms/:id', requireAuth, (req: AuthenticatedRequest, res) => {
    const roomId = String(req.params.id || '').trim();
    const existing = db
      .prepare('SELECT id, creator_id, is_default FROM majalis_rooms WHERE id = ?')
      .get(roomId) as { id: string; creator_id: string | null; is_default: number } | undefined;

    if (!existing) {
      res.status(404).json({ error: 'المجلس غير موجود' });
      return;
    }
    if (existing.is_default) {
      res.status(400).json({ error: 'لا يمكن حذف المجالس الأساسية الدائمة' });
      return;
    }

    const isModerator = req.authUser!.role === 'admin' || req.authUser!.role === 'owner';
    if (!isModerator && existing.creator_id !== req.authUser!.id) {
      res.status(403).json({ error: 'يمكن لمنشئ المجلس أو المشرف فقط حذفه' });
      return;
    }

    db.prepare('DELETE FROM majalis_rooms WHERE id = ?').run(roomId);
    hub.broadcastMajalisLobbyUpdated();
    res.json({ ok: true });
  });

  router.get('/majalis/rooms/:id/messages', requireAuth, (req: AuthenticatedRequest, res) => {
    const roomId = String(req.params.id || '').trim();
    const roomExists = db.prepare('SELECT 1 FROM majalis_rooms WHERE id = ?').get(roomId);
    if (!roomExists) {
      res.status(404).json({ error: 'المجلس غير موجود' });
      return;
    }

    const rows = db
      .prepare(
        `SELECT id, room_id, user_id, sender_name_snapshot, avatar_asset_id, body, created_at
         FROM majalis_messages
         WHERE room_id = ?
         ORDER BY created_at DESC
         LIMIT 60`
      )
      .all(roomId) as Array<{
      id: string;
      room_id: string;
      user_id: string | null;
      sender_name_snapshot: string;
      avatar_asset_id: string | null;
      body: string;
      created_at: number;
    }>;

    const messages: MajalisChatMessageRecord[] = rows.reverse().map((r) => ({
      id: r.id,
      roomId: r.room_id,
      userId: r.user_id,
      senderName: r.sender_name_snapshot,
      avatarAssetId: r.avatar_asset_id,
      body: r.body,
      createdAt: r.created_at,
    }));

    res.json({ messages });
  });

  const messageSchema = z.object({
    body: z
      .string()
      .trim()
      .min(1, 'اكتب رسالة قبل الإرسال')
      .max(500, 'الرسالة طويلة جدًا (بحد أقصى ٥٠٠ حرف)'),
  });

  router.post('/majalis/rooms/:id/messages', requireAuth, (req: AuthenticatedRequest, res) => {
    const roomId = String(req.params.id || '').trim();
    const roomExists = db.prepare('SELECT 1 FROM majalis_rooms WHERE id = ?').get(roomId);
    if (!roomExists) {
      res.status(404).json({ error: 'المجلس غير موجود' });
      return;
    }

    const parsed = messageSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'الرسالة غير صالحة' });
      return;
    }

    const msg: MajalisChatMessageRecord = {
      id: `mmsg_${randomUUID()}`,
      roomId,
      userId: req.authUser!.id,
      senderName: req.authUser!.displayName,
      avatarAssetId: req.authUser!.avatarAssetId,
      body: parsed.data.body,
      createdAt: Date.now(),
    };

    db.prepare(
      `INSERT INTO majalis_messages (id, room_id, user_id, sender_name_snapshot, avatar_asset_id, body, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(msg.id, msg.roomId, msg.userId, msg.senderName, msg.avatarAssetId, msg.body, msg.createdAt);

    hub.broadcastMajalisRoomChat(roomId, msg);
    res.status(201).json({ message: msg });
  });

  const timerSchema = z.object({
    action: z.enum(['start', 'pause', 'reset', 'preset']),
    phase: z.enum(['focus', 'review', 'break']).optional(),
  });

  router.post('/majalis/rooms/:id/timer', requireAuth, (req: AuthenticatedRequest, res) => {
    const roomId = String(req.params.id || '').trim();
    const parsed = timerSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'أمر المؤقت غير صالح' });
      return;
    }

    const timer = hub.controlMajalisRoomTimer(
      roomId,
      req.authUser!.displayName,
      parsed.data.action,
      parsed.data.phase
    );
    if (!timer) {
      res.status(404).json({ error: 'المجلس غير موجود' });
      return;
    }

    res.json({ timer });
  });

  return router;
}
