import { Router } from 'express';
import { z } from 'zod';
import type { RahhalaConfig } from '../config.ts';
import { getSetting, setSetting, type RahhalaDb } from '../db.ts';
import { canViewerAccessMessage, getHistoryCutoff } from '../lib/historyAccess.ts';
import { type AuthenticatedRequest, createAuthMiddleware } from '../middleware/auth.ts';
import type { RealtimeHub } from '../ws.ts';
import type {
  ChannelId,
  ChatMessage,
  MessageAttachment,
  ReactionSummary,
  ReceiptStatus,
  ReplyPreview,
  UserRole,
} from '../../shared/types.ts';

const CHANNEL_ENUM = ['announcements', 'questions', 'general'] as const;
const DELETE_FOR_ALL_LIMIT_MS = 48 * 60 * 60 * 1000; // 48 hours

interface RawMessageRow {
  id: number;
  channel: ChannelId;
  sender_id: string | null;
  sender_name_snapshot: string;
  sender_display_name: string | null;
  sender_username: string | null;
  sender_role: UserRole | null;
  sender_avatar_asset_id: string | null;
  body: string;
  reply_to_id: number | null;
  audio_asset_id: string | null;
  file_asset_id: string | null;
  filename_snapshot: string | null;
  created_at: number;
  edited_at: number | null;
  deleted_at: number | null;
}

export function createChatRouter(
  db: RahhalaDb,
  config: RahhalaConfig,
  hub: RealtimeHub
): Router {
  const router = Router();
  const { requireAuth, requireAdminOrOwner, requireOwner } = createAuthMiddleware(db, config);

  function hydrateMessages(rows: RawMessageRow[], viewer: NonNullable<AuthenticatedRequest['authUser']>): ChatMessage[] {
    if (rows.length === 0) return [];
    const now = Date.now();
    const cutoff = getHistoryCutoff(viewer);
    const msgIds = rows.map((r) => r.id);
    const placeholders = msgIds.map(() => '?').join(',');

    // Batch fetch assets
    const assetIds = new Set<string>();
    for (const r of rows) {
      if (!r.deleted_at) {
        if (r.audio_asset_id) assetIds.add(r.audio_asset_id);
        if (r.file_asset_id) assetIds.add(r.file_asset_id);
      }
    }
    const assetMap = new Map<string, MessageAttachment>();
    if (assetIds.size > 0) {
      const aIds = Array.from(assetIds);
      const aRows = db
        .prepare(
          `SELECT id, kind, detected_mime, original_safe_name, byte_size
           FROM assets WHERE id IN (${aIds.map(() => '?').join(',')})`
        )
        .all(...aIds) as Array<{
        id: string;
        kind: MessageAttachment['kind'];
        detected_mime: string;
        original_safe_name: string;
        byte_size: number;
      }>;
      for (const a of aRows) {
        assetMap.set(a.id, {
          assetId: a.id,
          kind: a.kind,
          mime: a.detected_mime,
          filename: a.original_safe_name,
          byteSize: a.byte_size,
        });
      }
    }

    // Batch fetch reactions
    const reactionRows = db
      .prepare(
        `SELECT message_id, user_id, emoji
         FROM reactions
         WHERE message_id IN (${placeholders})`
      )
      .all(...msgIds) as Array<{ message_id: number; user_id: string; emoji: string }>;

    const reactionsByMsg = new Map<number, ReactionSummary[]>();
    const tempCounts = new Map<number, Map<string, { count: number; mine: boolean }>>();
    for (const r of reactionRows) {
      let msgMap = tempCounts.get(r.message_id);
      if (!msgMap) {
        msgMap = new Map();
        tempCounts.set(r.message_id, msgMap);
      }
      const entry = msgMap.get(r.emoji) ?? { count: 0, mine: false };
      entry.count++;
      if (r.user_id === viewer.id) entry.mine = true;
      msgMap.set(r.emoji, entry);
    }
    for (const [mId, map] of tempCounts.entries()) {
      reactionsByMsg.set(
        mId,
        Array.from(map.entries()).map(([emoji, info]) => ({
          emoji,
          count: info.count,
          reactedByMe: info.mine,
        }))
      );
    }

    // Batch fetch reply targets safely (respecting deleted, hidden, and history cutoff!)
    const replyIds = Array.from(
      new Set(rows.map((r) => r.reply_to_id).filter((id): id is number => id !== null))
    );
    const replyMap = new Map<number, ReplyPreview>();
    if (replyIds.length > 0) {
      const rRows = db
        .prepare(
          `SELECT m.id, m.sender_name_snapshot, u.display_name AS current_name, m.body, m.created_at, m.deleted_at,
                  m.audio_asset_id, m.file_asset_id, m.filename_snapshot
           FROM messages m
           LEFT JOIN users u ON u.id = m.sender_id
           WHERE m.id IN (${replyIds.map(() => '?').join(',')})`
        )
        .all(...replyIds) as Array<{
        id: number;
        sender_name_snapshot: string;
        current_name: string | null;
        body: string;
        created_at: number;
        deleted_at: number | null;
        audio_asset_id: string | null;
        file_asset_id: string | null;
        filename_snapshot: string | null;
      }>;

      const hiddenReplySet = new Set<number>(
        (
          db
            .prepare(
              `SELECT message_id FROM message_hides WHERE user_id = ? AND message_id IN (${replyIds
                .map(() => '?')
                .join(',')})`
            )
            .all(viewer.id, ...replyIds) as Array<{ message_id: number }>
        ).map((x) => x.message_id)
      );

      for (const rr of rRows) {
        const inaccessible =
          rr.deleted_at !== null || rr.created_at < cutoff || hiddenReplySet.has(rr.id);
        if (inaccessible) {
          replyMap.set(rr.id, {
            id: String(rr.id),
            senderName: 'رسالة غير متاحة',
            excerpt: rr.deleted_at !== null ? 'تم حذف هذه الرسالة' : 'رسالة خارج نطاق الصلاحية',
            unavailable: true,
          });
        } else {
          const textPreview =
            rr.body.trim() ||
            (rr.audio_asset_id ? 'رسالة صوتية' : rr.filename_snapshot || 'مرفق');
          replyMap.set(rr.id, {
            id: String(rr.id),
            senderName: rr.current_name || rr.sender_name_snapshot,
            excerpt: textPreview.slice(0, 120),
            unavailable: false,
          });
        }
      }
    }

    // Batch fetch receipts summary for own messages (or admin/owner)
    const receiptSummary = new Map<number, ReceiptStatus>();
    const ownMsgIds = rows
      .filter((r) => r.sender_id === viewer.id && r.deleted_at === null)
      .map((r) => r.id);
    if (ownMsgIds.length > 0) {
      const recRows = db
        .prepare(
          `SELECT message_id,
                  MAX(CASE WHEN read_at IS NOT NULL THEN 1 ELSE 0 END) AS any_read,
                  MAX(CASE WHEN delivered_at IS NOT NULL THEN 1 ELSE 0 END) AS any_delivered
           FROM receipts
           WHERE message_id IN (${ownMsgIds.map(() => '?').join(',')})
           GROUP BY message_id`
        )
        .all(...ownMsgIds) as Array<{
        message_id: number;
        any_read: number;
        any_delivered: number;
      }>;
      const recMap = new Map(recRows.map((x) => [x.message_id, x]));
      for (const id of ownMsgIds) {
        const stat = recMap.get(id);
        if (stat?.any_read) receiptSummary.set(id, 'read');
        else if (stat?.any_delivered) receiptSummary.set(id, 'delivered');
        else receiptSummary.set(id, 'sent');
      }
    }

    return rows.map((r) => {
      const isDeleted = r.deleted_at !== null;
      const isOwn = r.sender_id === viewer.id;
      const within48h = now - r.created_at < DELETE_FOR_ALL_LIMIT_MS;
      const isMod = viewer.role === 'admin' || viewer.role === 'owner';

      // Parity rule: 48-hour limit still applies to an admin's OWN message when using ordinary delete!
      const canDeleteForEveryone = !isDeleted && (isOwn ? within48h : isMod);

      return {
        id: r.id,
        channel: r.channel,
        senderId: r.sender_id,
        senderName: r.sender_display_name || r.sender_name_snapshot || 'عضو سابق',
        senderUsername: r.sender_username,
        senderRole: r.sender_role,
        senderAvatarAssetId: r.sender_avatar_asset_id,
        body: isDeleted ? '' : r.body,
        replyTo: !isDeleted && r.reply_to_id ? replyMap.get(r.reply_to_id) ?? null : null,
        audioAttachment: !isDeleted && r.audio_asset_id ? assetMap.get(r.audio_asset_id) ?? null : null,
        fileAttachment: !isDeleted && r.file_asset_id ? assetMap.get(r.file_asset_id) ?? null : null,
        createdAt: r.created_at,
        editedAt: isDeleted ? null : r.edited_at,
        deletedAt: r.deleted_at,
        reactions: isDeleted ? [] : reactionsByMsg.get(r.id) ?? [],
        receiptStatus: !isDeleted && isOwn ? receiptSummary.get(r.id) ?? 'sent' : null,
        canDeleteForEveryone,
        canEdit: !isDeleted && isOwn,
        canViewInfo: !isDeleted && (isOwn || isMod),
      };
    });
  }

  // Get recent or paginated messages in a channel
  router.get('/chat/messages', requireAuth, (req: AuthenticatedRequest, res) => {
    const channelParam = String(req.query.channel || 'general');
    if (!CHANNEL_ENUM.includes(channelParam as ChannelId)) {
      res.status(400).json({ error: 'القناة غير معروفة' });
      return;
    }
    const channel = channelParam as ChannelId;
    const viewer = req.authUser!;
    const cutoff = getHistoryCutoff(viewer);
    const limit = Math.min(80, Math.max(1, Number(req.query.limit) || 50));
    const beforeId = req.query.beforeId ? Number(req.query.beforeId) : null;
    const afterId = req.query.afterId ? Number(req.query.afterId) : null;

    let rows: RawMessageRow[];
    let hasMore = false;

    if (afterId !== null && Number.isFinite(afterId)) {
      rows = db
        .prepare(
          `SELECT m.id, m.channel, m.sender_id, m.sender_name_snapshot,
                  u.display_name AS sender_display_name, u.username AS sender_username,
                  u.role AS sender_role, u.avatar_asset_id AS sender_avatar_asset_id,
                  m.body, m.reply_to_id, m.audio_asset_id, m.file_asset_id, m.filename_snapshot,
                  m.created_at, m.edited_at, m.deleted_at
           FROM messages m
           LEFT JOIN users u ON u.id = m.sender_id
           WHERE m.channel = ?
             AND m.created_at >= ?
             AND m.id > ?
             AND NOT EXISTS (SELECT 1 FROM message_hides mh WHERE mh.user_id = ? AND mh.message_id = m.id)
           ORDER BY m.id ASC
           LIMIT ?`
        )
        .all(channel, cutoff, afterId, viewer.id, limit) as RawMessageRow[];
    } else if (beforeId !== null && Number.isFinite(beforeId)) {
      const fetched = db
        .prepare(
          `SELECT m.id, m.channel, m.sender_id, m.sender_name_snapshot,
                  u.display_name AS sender_display_name, u.username AS sender_username,
                  u.role AS sender_role, u.avatar_asset_id AS sender_avatar_asset_id,
                  m.body, m.reply_to_id, m.audio_asset_id, m.file_asset_id, m.filename_snapshot,
                  m.created_at, m.edited_at, m.deleted_at
           FROM messages m
           LEFT JOIN users u ON u.id = m.sender_id
           WHERE m.channel = ?
             AND m.created_at >= ?
             AND m.id < ?
             AND NOT EXISTS (SELECT 1 FROM message_hides mh WHERE mh.user_id = ? AND mh.message_id = m.id)
           ORDER BY m.id DESC
           LIMIT ?`
        )
        .all(channel, cutoff, beforeId, viewer.id, limit + 1) as RawMessageRow[];
      hasMore = fetched.length > limit;
      rows = fetched.slice(0, limit).reverse();
    } else {
      const fetched = db
        .prepare(
          `SELECT m.id, m.channel, m.sender_id, m.sender_name_snapshot,
                  u.display_name AS sender_display_name, u.username AS sender_username,
                  u.role AS sender_role, u.avatar_asset_id AS sender_avatar_asset_id,
                  m.body, m.reply_to_id, m.audio_asset_id, m.file_asset_id, m.filename_snapshot,
                  m.created_at, m.edited_at, m.deleted_at
           FROM messages m
           LEFT JOIN users u ON u.id = m.sender_id
           WHERE m.channel = ?
             AND m.created_at >= ?
             AND NOT EXISTS (SELECT 1 FROM message_hides mh WHERE mh.user_id = ? AND mh.message_id = m.id)
           ORDER BY m.id DESC
           LIMIT ?`
        )
        .all(channel, cutoff, viewer.id, limit + 1) as RawMessageRow[];
      hasMore = fetched.length > limit;
      rows = fetched.slice(0, limit).reverse();
    }

    // Mark fetched non-deleted messages from others as delivered
    const now = Date.now();
    const otherIds = rows
      .filter((r) => r.sender_id && r.sender_id !== viewer.id && r.deleted_at === null)
      .map((r) => r.id);
    if (otherIds.length > 0) {
      const insDeliv = db.prepare(
        `INSERT INTO receipts (message_id, recipient_id, delivered_at, read_at)
         VALUES (?, ?, ?, NULL)
         ON CONFLICT(message_id, recipient_id) DO UPDATE SET
           delivered_at = COALESCE(receipts.delivered_at, excluded.delivered_at)`
      );
      const tx = db.transaction(() => {
        for (const id of otherIds) {
          insDeliv.run(id, viewer.id, now);
        }
      });
      tx();
    }

    const activeTypers = db
      .prepare(
        `SELECT t.user_id, u.display_name
         FROM typing_states t
         JOIN users u ON u.id = t.user_id
         WHERE t.channel = ? AND t.user_id != ? AND t.last_activity_at >= ?`
      )
      .all(channel, viewer.id, now - 6000) as Array<{ user_id: string; display_name: string }>;

    res.json({
      messages: hydrateMessages(rows, viewer),
      hasMore,
      chatLocked: getSetting(db, 'chat_locked', 'false') === 'true',
      typingUsers: activeTypers.map((t) => ({ userId: t.user_id, displayName: t.display_name })),
    });
  });

  // Search messages strictly enforcing history access, hidden, and deleted rules
  router.get('/chat/search', requireAuth, (req: AuthenticatedRequest, res) => {
    const q = String(req.query.q || '').trim();
    if (!q) {
      res.json({ messages: [] });
      return;
    }
    const channelParam = req.query.channel ? String(req.query.channel) : null;
    if (channelParam && !CHANNEL_ENUM.includes(channelParam as ChannelId)) {
      res.status(400).json({ error: 'القناة غير معروفة' });
      return;
    }
    const viewer = req.authUser!;
    const cutoff = getHistoryCutoff(viewer);
    const pattern = `%${q.replace(/[%_]/g, '\\$&')}%`;

    const rows = db
      .prepare(
        `SELECT m.id, m.channel, m.sender_id, m.sender_name_snapshot,
                u.display_name AS sender_display_name, u.username AS sender_username,
                u.role AS sender_role, u.avatar_asset_id AS sender_avatar_asset_id,
                m.body, m.reply_to_id, m.audio_asset_id, m.file_asset_id, m.filename_snapshot,
                m.created_at, m.edited_at, m.deleted_at
         FROM messages m
         LEFT JOIN users u ON u.id = m.sender_id
         WHERE m.deleted_at IS NULL
           AND m.created_at >= ?
           ${channelParam ? 'AND m.channel = ?' : ''}
           AND NOT EXISTS (SELECT 1 FROM message_hides mh WHERE mh.user_id = ? AND mh.message_id = m.id)
           AND (m.body LIKE ? ESCAPE '\\' OR COALESCE(m.filename_snapshot, '') LIKE ? ESCAPE '\\')
         ORDER BY m.id DESC
         LIMIT 40`
      )
      .all(
        ...(channelParam
          ? [cutoff, channelParam, viewer.id, pattern, pattern]
          : [cutoff, viewer.id, pattern, pattern])
      ) as RawMessageRow[];

    res.json({ messages: hydrateMessages(rows, viewer) });
  });

  router.get('/chat/unread', requireAuth, (req: AuthenticatedRequest, res) => {
    const viewer = req.authUser!;
    const cutoff = getHistoryCutoff(viewer);

    const counts: Record<ChannelId, number> = {
      announcements: 0,
      questions: 0,
      general: 0,
    };

    for (const ch of CHANNEL_ENUM) {
      const readRow = db
        .prepare(
          'SELECT highest_read_message_id FROM channel_reads WHERE user_id = ? AND channel = ?'
        )
        .get(viewer.id, ch) as { highest_read_message_id: number } | undefined;
      const lastReadId = readRow?.highest_read_message_id ?? 0;

      const row = db
        .prepare(
          `SELECT COUNT(*) AS cnt
           FROM messages m
           WHERE m.channel = ?
             AND m.id > ?
             AND m.created_at >= ?
             AND m.deleted_at IS NULL
             AND (m.sender_id IS NULL OR m.sender_id != ?)
             AND NOT EXISTS (SELECT 1 FROM message_hides mh WHERE mh.user_id = ? AND mh.message_id = m.id)`
        )
        .get(ch, lastReadId, cutoff, viewer.id, viewer.id) as { cnt: number };
      counts[ch] = row.cnt;
    }

    const total = counts.announcements + counts.questions + counts.general;
    res.json({ counts, total });
  });

  const sendMessageSchema = z.object({
    channel: z.enum(CHANNEL_ENUM),
    body: z.string().max(2000, 'الرسالة بحد أقصى ٢٠٠٠ حرف').optional().default(''),
    replyToId: z.number().int().positive().nullable().optional(),
    audioAssetId: z.string().min(1).nullable().optional(),
    fileAssetId: z.string().min(1).nullable().optional(),
    idempotencyKey: z.string().min(4).max(80).optional(),
  });

  router.post('/chat/messages', requireAuth, (req: AuthenticatedRequest, res) => {
    const parsed = sendMessageSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'محتوى الرسالة غير صالح' });
      return;
    }

    const viewer = req.authUser!;
    const { channel, replyToId, audioAssetId, fileAssetId, idempotencyKey } = parsed.data;
    const body = parsed.data.body.trim();

    if (channel === 'announcements' && viewer.role === 'member') {
      res.status(403).json({ error: 'النشر في قناة الإعلانات متاح للمشرفين والمالك فقط' });
      return;
    }

    const chatLocked = getSetting(db, 'chat_locked', 'false') === 'true';
    if (chatLocked && viewer.role === 'member') {
      res.status(403).json({ error: 'المحادثة مقفولة حاليًا بواسطة الإدارة' });
      return;
    }

    if (!body && !audioAssetId && !fileAssetId) {
      res.status(400).json({ error: 'اكتب رسالة أو أرفق ملفًا أو تسجيلًا صوتيًا' });
      return;
    }

    // Idempotency check so retries never create duplicates
    if (idempotencyKey) {
      const dup = db
        .prepare(
          `SELECT m.id, m.channel, m.sender_id, m.sender_name_snapshot,
                  u.display_name AS sender_display_name, u.username AS sender_username,
                  u.role AS sender_role, u.avatar_asset_id AS sender_avatar_asset_id,
                  m.body, m.reply_to_id, m.audio_asset_id, m.file_asset_id, m.filename_snapshot,
                  m.created_at, m.edited_at, m.deleted_at
           FROM messages m
           LEFT JOIN users u ON u.id = m.sender_id
           WHERE m.sender_id = ? AND m.channel = ? AND m.idempotency_key = ?`
        )
        .get(viewer.id, channel, idempotencyKey) as RawMessageRow | undefined;
      if (dup) {
        res.json({ message: hydrateMessages([dup], viewer)[0], deduplicated: true });
        return;
      }
    }

    // Verify reply target belongs to same channel & is accessible
    let validReplyToId: number | null = null;
    if (replyToId) {
      const target = db
        .prepare('SELECT id, channel, created_at, deleted_at FROM messages WHERE id = ?')
        .get(replyToId) as
        | { id: number; channel: string; created_at: number; deleted_at: number | null }
        | undefined;
      if (!target || target.channel !== channel || !canViewerAccessMessage(db, viewer, target)) {
        res.status(400).json({ error: 'الرسالة المراد الرد عليها غير متاحة' });
        return;
      }
      validReplyToId = target.id;
    }

    // Enforce upload ownership & single-use pending binding
    let filenameSnapshot: string | null = null;
    if (audioAssetId) {
      const a = db
        .prepare(
          "SELECT id, uploader_id, kind, binding_type, original_safe_name FROM assets WHERE id = ? AND binding_type = 'pending' AND uploader_id = ?"
        )
        .get(audioAssetId, viewer.id) as
        | { id: string; kind: string; original_safe_name: string }
        | undefined;
      if (!a || a.kind !== 'audio') {
        res.status(403).json({ error: 'التسجيل الصوتي غير صالح أو غير مملوك لك' });
        return;
      }
      filenameSnapshot = a.original_safe_name;
    }

    if (fileAssetId) {
      const f = db
        .prepare(
          "SELECT id, uploader_id, kind, binding_type, original_safe_name FROM assets WHERE id = ? AND binding_type = 'pending' AND uploader_id = ?"
        )
        .get(fileAssetId, viewer.id) as
        | { id: string; kind: string; original_safe_name: string }
        | undefined;
      if (!f || f.kind === 'avatar') {
        res.status(403).json({ error: 'الملف المرفق غير صالح أو غير مملوك لك' });
        return;
      }
      filenameSnapshot = f.original_safe_name;
    }

    const now = Date.now();
    const tx = db.transaction(() => {
      const info = db
        .prepare(
          `INSERT INTO messages (channel, sender_id, sender_name_snapshot, body, reply_to_id, audio_asset_id, file_asset_id, filename_snapshot, idempotency_key, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          channel,
          viewer.id,
          viewer.displayName,
          body,
          validReplyToId,
          audioAssetId ?? null,
          fileAssetId ?? null,
          filenameSnapshot,
          idempotencyKey ?? null,
          now
        );

      const newId = Number(info.lastInsertRowid);

      if (audioAssetId) {
        db.prepare(
          "UPDATE assets SET binding_type = 'chat_audio', binding_id = ? WHERE id = ?"
        ).run(String(newId), audioAssetId);
      }
      if (fileAssetId) {
        db.prepare(
          "UPDATE assets SET binding_type = 'chat_file', binding_id = ? WHERE id = ?"
        ).run(String(newId), fileAssetId);
      }

      // Advance sender's own read position on this channel
      db.prepare(
        `INSERT INTO channel_reads (user_id, channel, highest_read_message_id, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id, channel) DO UPDATE SET
           highest_read_message_id = MAX(channel_reads.highest_read_message_id, excluded.highest_read_message_id),
           updated_at = excluded.updated_at`
      ).run(viewer.id, channel, newId, now);

      // Clear typing state
      db.prepare('DELETE FROM typing_states WHERE user_id = ? AND channel = ?').run(
        viewer.id,
        channel
      );

      return newId;
    });

    const newMsgId = tx();
    const inserted = db
      .prepare(
        `SELECT m.id, m.channel, m.sender_id, m.sender_name_snapshot,
                u.display_name AS sender_display_name, u.username AS sender_username,
                u.role AS sender_role, u.avatar_asset_id AS sender_avatar_asset_id,
                m.body, m.reply_to_id, m.audio_asset_id, m.file_asset_id, m.filename_snapshot,
                m.created_at, m.edited_at, m.deleted_at
         FROM messages m
         LEFT JOIN users u ON u.id = m.sender_id
         WHERE m.id = ?`
      )
      .get(newMsgId) as RawMessageRow;

    hub.broadcastMessageCreated(newMsgId, channel);
    res.status(201).json({ message: hydrateMessages([inserted], viewer)[0] });
  });

  // Edit own non-deleted text message
  router.patch('/chat/messages/:id', requireAuth, (req: AuthenticatedRequest, res) => {
    const msgId = Number(req.params.id);
    const body = String(req.body?.body || '').trim();
    if (!body || body.length > 2000) {
      res.status(400).json({ error: 'النص لازم يكون بين ١ و ٢٠٠٠ حرف' });
      return;
    }

    const existing = db
      .prepare('SELECT id, channel, sender_id, deleted_at FROM messages WHERE id = ?')
      .get(msgId) as
      | { id: number; channel: ChannelId; sender_id: string | null; deleted_at: number | null }
      | undefined;

    if (!existing || existing.deleted_at !== null) {
      res.status(404).json({ error: 'الرسالة غير موجودة أو تم حذفها' });
      return;
    }

    if (existing.sender_id !== req.authUser!.id) {
      res.status(403).json({ error: 'يمكنك تعديل رسائلك فقط' });
      return;
    }

    const now = Date.now();
    db.prepare('UPDATE messages SET body = ?, edited_at = ? WHERE id = ?').run(body, now, msgId);
    hub.broadcastMessageUpdated(msgId, existing.channel);
    res.json({ ok: true, editedAt: now });
  });

  // Hide message for current user only (حذف عندي)
  router.post('/chat/messages/:id/hide', requireAuth, (req: AuthenticatedRequest, res) => {
    const msgId = Number(req.params.id);
    const msg = db
      .prepare('SELECT id, created_at, deleted_at FROM messages WHERE id = ?')
      .get(msgId) as { id: number; created_at: number; deleted_at: number | null } | undefined;

    if (!msg) {
      res.status(404).json({ error: 'الرسالة غير موجودة' });
      return;
    }
    const cutoff = getHistoryCutoff(req.authUser!);
    if (msg.created_at < cutoff) {
      res.status(403).json({ error: 'الرسالة خارج نطاق صلاحيتك' });
      return;
    }

    db.prepare(
      `INSERT INTO message_hides (user_id, message_id, hidden_at)
       VALUES (?, ?, ?)
       ON CONFLICT(user_id, message_id) DO NOTHING`
    ).run(req.authUser!.id, msgId, Date.now());

    res.json({ ok: true });
  });

  // Delete for everyone (حذف عند الكل - creates tombstone & removes attachment/reaction access)
  router.delete('/chat/messages/:id', requireAuth, (req: AuthenticatedRequest, res) => {
    const msgId = Number(req.params.id);
    const viewer = req.authUser!;
    const msg = db
      .prepare(
        'SELECT id, channel, sender_id, audio_asset_id, file_asset_id, created_at, deleted_at FROM messages WHERE id = ?'
      )
      .get(msgId) as
      | {
          id: number;
          channel: ChannelId;
          sender_id: string | null;
          audio_asset_id: string | null;
          file_asset_id: string | null;
          created_at: number;
          deleted_at: number | null;
        }
      | undefined;

    if (!msg || msg.deleted_at !== null) {
      res.status(404).json({ error: 'الرسالة غير موجودة أو محذوفة بالفعل' });
      return;
    }

    const isOwn = msg.sender_id === viewer.id;
    const isMod = viewer.role === 'admin' || viewer.role === 'owner';
    const within48h = Date.now() - msg.created_at < DELETE_FOR_ALL_LIMIT_MS;

    if (isOwn) {
      if (!within48h) {
        res.status(403).json({ error: 'انتهت مهلة الـ ٤٨ ساعة المسموح بها لحذف رسالتك عند الكل' });
        return;
      }
    } else if (!isMod) {
      res.status(403).json({ error: 'لا تملك صلاحية حذف رسائل الآخرين عند الكل' });
      return;
    }

    const now = Date.now();
    const tx = db.transaction(() => {
      db.prepare(
        `UPDATE messages
         SET body = '', audio_asset_id = NULL, file_asset_id = NULL, filename_snapshot = NULL,
             deleted_at = ?, deleted_by_id = ?
         WHERE id = ?`
      ).run(now, viewer.id, msgId);

      db.prepare('DELETE FROM reactions WHERE message_id = ?').run(msgId);
      if (msg.audio_asset_id) {
        db.prepare('DELETE FROM assets WHERE id = ?').run(msg.audio_asset_id);
      }
      if (msg.file_asset_id) {
        db.prepare('DELETE FROM assets WHERE id = ?').run(msg.file_asset_id);
      }
    });
    tx();

    hub.broadcastMessageUpdated(msgId, msg.channel);
    res.json({ ok: true, deletedAt: now });
  });

  // Owner-only final removal (حذف نهائي - no tombstone)
  router.delete(
    '/chat/messages/:id/purge',
    requireAuth,
    requireOwner,
    (req: AuthenticatedRequest, res) => {
      const msgId = Number(req.params.id);
      const msg = db
        .prepare('SELECT id, channel, audio_asset_id, file_asset_id FROM messages WHERE id = ?')
        .get(msgId) as
        | {
            id: number;
            channel: ChannelId;
            audio_asset_id: string | null;
            file_asset_id: string | null;
          }
        | undefined;

      if (!msg) {
        res.status(404).json({ error: 'الرسالة غير موجودة' });
        return;
      }

      const tx = db.transaction(() => {
        db.prepare('DELETE FROM messages WHERE id = ?').run(msgId);
        if (msg.audio_asset_id) db.prepare('DELETE FROM assets WHERE id = ?').run(msg.audio_asset_id);
        if (msg.file_asset_id) db.prepare('DELETE FROM assets WHERE id = ?').run(msg.file_asset_id);
      });
      tx();

      hub.broadcastMessageRemoved(msgId, msg.channel);
      res.json({ ok: true });
    }
  );

  // React to message (one reaction per user per message; tapping same removes)
  router.post('/chat/messages/:id/react', requireAuth, (req: AuthenticatedRequest, res) => {
    const msgId = Number(req.params.id);
    const emoji = String(req.body?.emoji || '').trim();
    if (!emoji || emoji.length > 16) {
      res.status(400).json({ error: 'تفاعل غير صالح' });
      return;
    }

    const msg = db
      .prepare('SELECT id, channel, created_at, deleted_at FROM messages WHERE id = ?')
      .get(msgId) as
      | { id: number; channel: ChannelId; created_at: number; deleted_at: number | null }
      | undefined;

    if (!msg || !canViewerAccessMessage(db, req.authUser!, msg)) {
      res.status(403).json({ error: 'لا يمكنك التفاعل مع هذه الرسالة' });
      return;
    }

    const existing = db
      .prepare('SELECT emoji FROM reactions WHERE user_id = ? AND message_id = ?')
      .get(req.authUser!.id, msgId) as { emoji: string } | undefined;

    const now = Date.now();
    if (existing && existing.emoji === emoji) {
      db.prepare('DELETE FROM reactions WHERE user_id = ? AND message_id = ?').run(
        req.authUser!.id,
        msgId
      );
    } else {
      db.prepare(
        `INSERT INTO reactions (user_id, message_id, emoji, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id, message_id) DO UPDATE SET
           emoji = excluded.emoji, updated_at = excluded.updated_at`
      ).run(req.authUser!.id, msgId, emoji, now, now);
    }

    hub.broadcastReactionUpdated(msgId, msg.channel);
    res.json({ ok: true });
  });

  // Mark messages read when channel is visible and messages are actually viewed
  router.post('/chat/read', requireAuth, (req: AuthenticatedRequest, res) => {
    const channelParam = String(req.body?.channel || '');
    const highestMessageId = Number(req.body?.highestMessageId);
    if (!CHANNEL_ENUM.includes(channelParam as ChannelId) || !Number.isFinite(highestMessageId)) {
      res.status(400).json({ error: 'بيانات القراءة غير صالحة' });
      return;
    }

    const viewer = req.authUser!;
    const cutoff = getHistoryCutoff(viewer);
    const channel = channelParam as ChannelId;
    const now = Date.now();

    const readableMsgs = db
      .prepare(
        `SELECT id, sender_id FROM messages
         WHERE channel = ?
           AND id <= ?
           AND created_at >= ?
           AND deleted_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM message_hides mh WHERE mh.user_id = ? AND mh.message_id = messages.id)
         ORDER BY id DESC
         LIMIT 60`
      )
      .all(channel, highestMessageId, cutoff, viewer.id) as Array<{
      id: number;
      sender_id: string | null;
    }>;

    const maxAccessibleId = readableMsgs.length > 0 ? readableMsgs[0].id : 0;
    if (maxAccessibleId > 0) {
      const tx = db.transaction(() => {
        db.prepare(
          `INSERT INTO channel_reads (user_id, channel, highest_read_message_id, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(user_id, channel) DO UPDATE SET
             highest_read_message_id = MAX(channel_reads.highest_read_message_id, excluded.highest_read_message_id),
             updated_at = excluded.updated_at`
        ).run(viewer.id, channel, maxAccessibleId, now);

        const upsertReceipt = db.prepare(
          `INSERT INTO receipts (message_id, recipient_id, delivered_at, read_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(message_id, recipient_id) DO UPDATE SET
             delivered_at = COALESCE(receipts.delivered_at, excluded.delivered_at),
             read_at = COALESCE(receipts.read_at, excluded.read_at)`
        );
        for (const m of readableMsgs) {
          if (m.sender_id && m.sender_id !== viewer.id) {
            upsertReceipt.run(m.id, viewer.id, now, now);
          }
        }
      });
      tx();

      for (const m of readableMsgs) {
        if (m.sender_id && m.sender_id !== viewer.id) {
          hub.broadcastReceiptUpdated(m.sender_id, m.id);
        }
      }
    }

    res.json({ ok: true });
  });

  // Message delivery/read receipt details (sender or admin/owner only, obeying history access)
  router.get('/chat/messages/:id/info', requireAuth, (req: AuthenticatedRequest, res) => {
    const msgId = Number(req.params.id);
    const viewer = req.authUser!;
    const msg = db
      .prepare('SELECT id, sender_id, created_at, deleted_at FROM messages WHERE id = ?')
      .get(msgId) as
      | { id: number; sender_id: string | null; created_at: number; deleted_at: number | null }
      | undefined;

    if (!msg || !canViewerAccessMessage(db, viewer, msg)) {
      res.status(403).json({ error: 'لا يمكن عرض تفاصيل هذه الرسالة' });
      return;
    }

    const isMod = viewer.role === 'admin' || viewer.role === 'owner';
    if (msg.sender_id !== viewer.id && !isMod) {
      res.status(403).json({ error: 'تفاصيل القراءة متاحة لصاحب الرسالة أو المشرفين فقط' });
      return;
    }

    const rows = db
      .prepare(
        `SELECT r.recipient_id, u.display_name, u.username, r.delivered_at, r.read_at
         FROM receipts r
         JOIN users u ON u.id = r.recipient_id
         WHERE r.message_id = ?
         ORDER BY COALESCE(r.read_at, 0) DESC, COALESCE(r.delivered_at, 0) DESC`
      )
      .all(msgId) as Array<{
      recipient_id: string;
      display_name: string;
      username: string;
      delivered_at: number | null;
      read_at: number | null;
    }>;

    res.json({
      receipts: rows.map((r) => ({
        recipientId: r.recipient_id,
        displayName: r.display_name,
        username: r.username,
        deliveredAt: r.delivered_at,
        readAt: r.read_at,
      })),
    });
  });

  router.post('/chat/lock', requireAuth, requireAdminOrOwner, (req, res) => {
    const locked = Boolean(req.body?.locked);
    setSetting(db, 'chat_locked', locked ? 'true' : 'false');
    hub.broadcastChatLockChanged(locked);
    res.json({ chatLocked: locked });
  });

  return router;
}
