import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { MajalisChatMessageRecord, MajalisRoomSettings } from '../../shared/types.ts';
import type { RahhalaConfig } from '../config.ts';
import { getSetting, type RahhalaDb } from '../db.ts';
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
    accessType: z.enum(['open', 'knock']).optional(),
    allowScreenShare: z.boolean().optional(),
    allowChat: z.boolean().optional(),
    muteOnEntry: z.boolean().optional(),
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

    const defaultAccess =
      getSetting(db, 'default_room_access_type', 'open') === 'knock' ? 'knock' : 'open';
    const accessType = parsed.data.accessType ?? defaultAccess;
    const allowScreenShare = parsed.data.allowScreenShare ?? true;
    const allowChat = parsed.data.allowChat ?? true;
    const muteOnEntry = parsed.data.muteOnEntry ?? false;

    const id = `room_${randomUUID()}`;
    const now = Date.now();

    db.prepare(
      `INSERT INTO majalis_rooms (
         id, title, subject_id, subject_name_snapshot, creator_id, creator_name_snapshot, is_default, created_at,
         access_type, room_locked, allow_mic, allow_cam, allow_screen_share, allow_chat, mute_on_entry
       ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, 0, 1, 1, ?, ?, ?)`
    ).run(
      id,
      parsed.data.title,
      resolvedSubjectId,
      resolvedSubjectName,
      req.authUser!.id,
      req.authUser!.displayName,
      now,
      accessType,
      allowScreenShare ? 1 : 0,
      allowChat ? 1 : 0,
      muteOnEntry ? 1 : 0
    );

    hub.broadcastMajalisLobbyUpdated();
    const room = hub.getMajalisRoomsSnapshot().find((r) => r.id === id);
    res.status(201).json({ room });
  });

  const updateRoomSettingsSchema = z.object({
    accessType: z.enum(['open', 'knock']).optional(),
    roomLocked: z.boolean().optional(),
    allowMic: z.boolean().optional(),
    allowCam: z.boolean().optional(),
    allowScreenShare: z.boolean().optional(),
    allowChat: z.boolean().optional(),
    muteOnEntry: z.boolean().optional(),
  });

  router.patch('/majalis/rooms/:id/settings', requireAuth, (req: AuthenticatedRequest, res) => {
    const roomId = String(req.params.id || '').trim();
    const existing = db
      .prepare(
        `SELECT id, creator_id, access_type, room_locked, allow_mic, allow_cam, allow_screen_share, allow_chat, mute_on_entry
         FROM majalis_rooms WHERE id = ?`
      )
      .get(roomId) as
      | {
          id: string;
          creator_id: string | null;
          access_type: 'open' | 'knock';
          room_locked: number;
          allow_mic: number;
          allow_cam: number;
          allow_screen_share: number;
          allow_chat: number;
          mute_on_entry: number;
        }
      | undefined;

    if (!existing) {
      res.status(404).json({ error: 'المجلس غير موجود' });
      return;
    }

    const isHost =
      req.authUser!.role === 'owner' ||
      req.authUser!.role === 'admin' ||
      (existing.creator_id !== null && existing.creator_id === req.authUser!.id);
    if (!isHost) {
      res.status(403).json({ error: 'إعدادات المجلس متاحة لمضيف المجلس أو المشرفين فقط' });
      return;
    }

    const parsed = updateRoomSettingsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'إعدادات المجلس غير صالحة' });
      return;
    }

    const nextSettings: MajalisRoomSettings = {
      accessType: parsed.data.accessType ?? existing.access_type,
      roomLocked: parsed.data.roomLocked ?? Boolean(existing.room_locked),
      allowMic: parsed.data.allowMic ?? Boolean(existing.allow_mic),
      allowCam: parsed.data.allowCam ?? Boolean(existing.allow_cam),
      allowScreenShare: parsed.data.allowScreenShare ?? Boolean(existing.allow_screen_share),
      allowChat: parsed.data.allowChat ?? Boolean(existing.allow_chat),
      muteOnEntry: parsed.data.muteOnEntry ?? Boolean(existing.mute_on_entry),
    };

    db.prepare(
      `UPDATE majalis_rooms
       SET access_type = ?, room_locked = ?, allow_mic = ?, allow_cam = ?, allow_screen_share = ?, allow_chat = ?, mute_on_entry = ?
       WHERE id = ?`
    ).run(
      nextSettings.accessType,
      nextSettings.roomLocked ? 1 : 0,
      nextSettings.allowMic ? 1 : 0,
      nextSettings.allowCam ? 1 : 0,
      nextSettings.allowScreenShare ? 1 : 0,
      nextSettings.allowChat ? 1 : 0,
      nextSettings.muteOnEntry ? 1 : 0,
      roomId
    );

    hub.applyMajalisRoomSettings(roomId, nextSettings);
    const room = hub.getMajalisRoomsSnapshot().find((r) => r.id === roomId);
    res.json({ settings: nextSettings, room });
  });

  router.post('/majalis/rooms/:id/end', requireAuth, (req: AuthenticatedRequest, res) => {
    const roomId = String(req.params.id || '').trim();
    const existing = db
      .prepare('SELECT id, creator_id FROM majalis_rooms WHERE id = ?')
      .get(roomId) as { id: string; creator_id: string | null } | undefined;

    if (!existing) {
      res.status(404).json({ error: 'المجلس غير موجود' });
      return;
    }

    const isHost =
      req.authUser!.role === 'owner' ||
      req.authUser!.role === 'admin' ||
      (existing.creator_id !== null && existing.creator_id === req.authUser!.id);
    if (!isHost) {
      res.status(403).json({ error: 'إنهاء المجلس للجميع متاح للمضيف أو المشرفين فقط' });
      return;
    }

    hub.endMajalisMeetingForAll(roomId, req.authUser!.displayName);
    res.json({ ok: true });
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

    hub.endMajalisMeetingForAll(roomId, req.authUser!.displayName);
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
    const roomRow = db
      .prepare('SELECT id, creator_id, allow_chat FROM majalis_rooms WHERE id = ?')
      .get(roomId) as { id: string; creator_id: string | null; allow_chat: number } | undefined;
    if (!roomRow) {
      res.status(404).json({ error: 'المجلس غير موجود' });
      return;
    }

    const isHost =
      req.authUser!.role === 'owner' ||
      req.authUser!.role === 'admin' ||
      (roomRow.creator_id !== null && roomRow.creator_id === req.authUser!.id);
    if (!isHost && !roomRow.allow_chat) {
      res.status(403).json({ error: 'تم إيقاف الدردشة في هذا المجلس من قِبل المضيف' });
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
