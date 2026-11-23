import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { RahhalaConfig } from '../config.ts';
import { getOrCreateSigningSecret, type RahhalaDb } from '../db.ts';
import {
  decryptMessageBody,
  deriveConversationMasterKey,
  encryptMessageBody,
  generateConversationKey,
  unwrapConversationKey,
} from '../lib/crypto.ts';
import { type AuthenticatedRequest, createAuthMiddleware } from '../middleware/auth.ts';
import type { RealtimeHub } from '../ws.ts';
import type {
  ConversationKind,
  ConversationMemberInfo,
  ConversationMemberRole,
  ConversationMessage,
  ConversationPinnedSummary,
  ConversationSummary,
  DisappearingHours,
  MessageAttachment,
  MessageReceiptDetail,
  ReactionSummary,
  ReceiptStatus,
  ReplyPreview,
  UserRole,
} from '../../shared/types.ts';

const DELETE_FOR_ALL_LIMIT_MS = 48 * 60 * 60 * 1000;

interface ConversationRow {
  id: string;
  kind: ConversationKind;
  title: string;
  description: string;
  creator_id: string | null;
  wrapped_key: string;
  key_fingerprint: string;
  only_admins_send: number;
  disappearing_hours: number;
  pinned_message_id: number | null;
  created_at: number;
  updated_at: number;
}

interface RawConvMessageRow {
  id: number;
  conversation_id: string;
  sender_id: string | null;
  sender_name_snapshot: string;
  sender_display_name: string | null;
  sender_username: string | null;
  sender_role: UserRole | null;
  sender_avatar_asset_id: string | null;
  cipher_body: string;
  reply_to_id: number | null;
  audio_asset_id: string | null;
  file_asset_id: string | null;
  filename_snapshot: string | null;
  created_at: number;
  edited_at: number | null;
  deleted_at: number | null;
}

export function createConversationsRouter(
  db: RahhalaDb,
  config: RahhalaConfig,
  hub: RealtimeHub
): Router {
  const router = Router();
  const { requireAuth } = createAuthMiddleware(db, config);
  const masterKey = deriveConversationMasterKey(getOrCreateSigningSecret(db));

  function decryptSafely(
    cipherBody: string,
    convKey: Buffer,
    conversationId: string,
    senderId: string | null
  ): string {
    if (!cipherBody) return '';
    try {
      return decryptMessageBody(cipherBody, convKey, `${conversationId}:${senderId ?? 'anon'}`);
    } catch {
      return '';
    }
  }

  function getMemberRow(conversationId: string, userId: string) {
    return db
      .prepare(
        `SELECT role, highest_read_message_id, muted_notifications, cleared_before_at, joined_at
         FROM conversation_members
         WHERE conversation_id = ? AND user_id = ?`
      )
      .get(conversationId, userId) as
      | {
          role: ConversationMemberRole;
          highest_read_message_id: number;
          muted_notifications: number;
          cleared_before_at: number;
          joined_at: number;
        }
      | undefined;
  }

  function getConversationRow(conversationId: string): ConversationRow | undefined {
    return db
      .prepare('SELECT * FROM conversations WHERE id = ?')
      .get(conversationId) as ConversationRow | undefined;
  }

  function getEffectiveConvCutoff(conv: ConversationRow, clearedBeforeAt: number): number {
    const disCut =
      conv.disappearing_hours > 0 ? Date.now() - conv.disappearing_hours * 3_600_000 : 0;
    return Math.max(clearedBeforeAt, disCut);
  }

  function readViewerReadReceiptsEnabled(userId: string): boolean {
    const row = db
      .prepare('SELECT read_receipts_enabled FROM user_chat_settings WHERE user_id = ?')
      .get(userId) as { read_receipts_enabled: number } | undefined;
    return row ? Boolean(row.read_receipts_enabled) : true;
  }

  function readPinnedSummary(
    conv: ConversationRow,
    convKey: Buffer,
    cutoff: number,
    viewerId: string
  ): ConversationPinnedSummary | null {
    if (!conv.pinned_message_id) return null;
    const row = db
      .prepare(
        `SELECT cm.id, cm.sender_id, COALESCE(u.display_name, cm.sender_name_snapshot) AS sender_name,
                cm.cipher_body, cm.audio_asset_id, cm.filename_snapshot, cm.created_at, cm.deleted_at
         FROM conversation_messages cm
         LEFT JOIN users u ON u.id = cm.sender_id
         WHERE cm.id = ? AND cm.conversation_id = ?`
      )
      .get(conv.pinned_message_id, conv.id) as
      | {
          id: number;
          sender_id: string | null;
          sender_name: string;
          cipher_body: string;
          audio_asset_id: string | null;
          filename_snapshot: string | null;
          created_at: number;
          deleted_at: number | null;
        }
      | undefined;
    if (!row || row.deleted_at !== null || row.created_at < cutoff) return null;
    const hidden = db
      .prepare('SELECT 1 FROM conversation_message_hides WHERE user_id = ? AND message_id = ?')
      .get(viewerId, row.id);
    if (hidden) return null;

    const plain = decryptSafely(row.cipher_body, convKey, conv.id, row.sender_id).trim();
    const excerpt =
      plain || (row.audio_asset_id ? 'رسالة صوتية' : row.filename_snapshot || 'مرفق');
    return {
      id: row.id,
      senderName: row.sender_name || 'عضو',
      excerpt: excerpt.slice(0, 140),
      createdAt: row.created_at,
    };
  }

  function hydrateConversationMessages(
    rows: RawConvMessageRow[],
    conv: ConversationRow,
    convKey: Buffer,
    viewerId: string,
    myRole: ConversationMemberRole,
    cutoff: number
  ): ConversationMessage[] {
    if (rows.length === 0) return [];
    const now = Date.now();
    const msgIds = rows.map((r) => r.id);
    const placeholders = msgIds.map(() => '?').join(',');

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

    const reactionRows = db
      .prepare(
        `SELECT message_id, user_id, emoji
         FROM conversation_reactions
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
      if (r.user_id === viewerId) entry.mine = true;
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

    const replyIds = Array.from(
      new Set(rows.map((r) => r.reply_to_id).filter((id): id is number => id !== null))
    );
    const replyMap = new Map<number, ReplyPreview>();
    if (replyIds.length > 0) {
      const rRows = db
        .prepare(
          `SELECT cm.id, cm.sender_id, cm.sender_name_snapshot, u.display_name AS current_name,
                  cm.cipher_body, cm.created_at, cm.deleted_at,
                  cm.audio_asset_id, cm.file_asset_id, cm.filename_snapshot
           FROM conversation_messages cm
           LEFT JOIN users u ON u.id = cm.sender_id
           WHERE cm.id IN (${replyIds.map(() => '?').join(',')})`
        )
        .all(...replyIds) as Array<{
        id: number;
        sender_id: string | null;
        sender_name_snapshot: string;
        current_name: string | null;
        cipher_body: string;
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
              `SELECT message_id FROM conversation_message_hides
               WHERE user_id = ? AND message_id IN (${replyIds.map(() => '?').join(',')})`
            )
            .all(viewerId, ...replyIds) as Array<{ message_id: number }>
        ).map((x) => x.message_id)
      );

      for (const rr of rRows) {
        const inaccessible =
          rr.deleted_at !== null || rr.created_at < cutoff || hiddenReplySet.has(rr.id);
        if (inaccessible) {
          replyMap.set(rr.id, {
            id: String(rr.id),
            senderName: 'رسالة غير متاحة',
            excerpt: rr.deleted_at !== null ? 'تم حذف هذه الرسالة' : 'رسالة غير متوفرة',
            unavailable: true,
          });
        } else {
          const plain = decryptSafely(rr.cipher_body, convKey, conv.id, rr.sender_id).trim();
          const textPreview =
            plain || (rr.audio_asset_id ? 'رسالة صوتية' : rr.filename_snapshot || 'مرفق');
          replyMap.set(rr.id, {
            id: String(rr.id),
            senderName: rr.current_name || rr.sender_name_snapshot,
            excerpt: textPreview.slice(0, 120),
            unavailable: false,
          });
        }
      }
    }

    const starredRows = db
      .prepare(
        `SELECT message_id FROM conversation_starred
         WHERE user_id = ? AND message_id IN (${placeholders})`
      )
      .all(viewerId, ...msgIds) as Array<{ message_id: number }>;
    const starredSet = new Set(starredRows.map((x) => x.message_id));
    const readReceiptsEnabled = readViewerReadReceiptsEnabled(viewerId);

    const receiptSummary = new Map<number, ReceiptStatus>();
    const ownMsgIds = rows
      .filter((r) => r.sender_id === viewerId && r.deleted_at === null)
      .map((r) => r.id);
    if (ownMsgIds.length > 0) {
      const recRows = db
        .prepare(
          `SELECT message_id,
                  MAX(CASE WHEN read_at IS NOT NULL THEN 1 ELSE 0 END) AS any_read,
                  MAX(CASE WHEN delivered_at IS NOT NULL THEN 1 ELSE 0 END) AS any_delivered
           FROM conversation_receipts
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
        if (stat?.any_read && readReceiptsEnabled) receiptSummary.set(id, 'read');
        else if (stat?.any_read || stat?.any_delivered) receiptSummary.set(id, 'delivered');
        else receiptSummary.set(id, 'sent');
      }
    }

    return rows.map((r) => {
      const isDeleted = r.deleted_at !== null;
      const isOwn = r.sender_id === viewerId;
      const within48h = now - r.created_at < DELETE_FOR_ALL_LIMIT_MS;
      const isGroupAdmin = conv.kind === 'group' && myRole === 'admin';
      const canDeleteForEveryone =
        !isDeleted && ((isOwn && within48h) || isGroupAdmin);

      return {
        id: r.id,
        conversationId: r.conversation_id,
        senderId: r.sender_id,
        senderName: r.sender_display_name || r.sender_name_snapshot || 'عضو سابق',
        senderUsername: r.sender_username,
        senderRole: r.sender_role,
        senderAvatarAssetId: r.sender_avatar_asset_id,
        body: isDeleted
          ? ''
          : decryptSafely(r.cipher_body, convKey, conv.id, r.sender_id),
        encrypted: true,
        replyTo: !isDeleted && r.reply_to_id ? replyMap.get(r.reply_to_id) ?? null : null,
        audioAttachment:
          !isDeleted && r.audio_asset_id ? assetMap.get(r.audio_asset_id) ?? null : null,
        fileAttachment:
          !isDeleted && r.file_asset_id ? assetMap.get(r.file_asset_id) ?? null : null,
        createdAt: r.created_at,
        editedAt: isDeleted ? null : r.edited_at,
        deletedAt: r.deleted_at,
        reactions: isDeleted ? [] : reactionsByMsg.get(r.id) ?? [],
        receiptStatus: !isDeleted && isOwn ? receiptSummary.get(r.id) ?? 'sent' : null,
        starredByMe: !isDeleted && starredSet.has(r.id),
        canDeleteForEveryone,
        canEdit: !isDeleted && isOwn,
        canViewInfo: !isDeleted && (isOwn || isGroupAdmin),
      };
    });
  }

  function buildConversationSummary(
    conv: ConversationRow,
    viewerId: string,
    memberRow: {
      role: ConversationMemberRole;
      highest_read_message_id: number;
      muted_notifications: number;
      cleared_before_at: number;
    }
  ): ConversationSummary {
    const convKey = unwrapConversationKey(conv.wrapped_key, masterKey, conv.id);
    const cutoff = getEffectiveConvCutoff(conv, memberRow.cleared_before_at);
    const readReceiptsEnabled = readViewerReadReceiptsEnabled(viewerId);

    const memberCount = (
      db
        .prepare('SELECT COUNT(*) AS cnt FROM conversation_members WHERE conversation_id = ?')
        .get(conv.id) as { cnt: number }
    ).cnt;

    let peer: ConversationSummary['peer'] = null;
    if (conv.kind === 'dm') {
      const peerRow = db
        .prepare(
          `SELECT u.id, u.display_name, u.username, u.role, u.avatar_asset_id, u.bio
           FROM conversation_members cm
           JOIN users u ON u.id = cm.user_id
           WHERE cm.conversation_id = ? AND cm.user_id != ?
           LIMIT 1`
        )
        .get(conv.id, viewerId) as
        | {
            id: string;
            display_name: string;
            username: string;
            role: UserRole;
            avatar_asset_id: string | null;
            bio: string;
          }
        | undefined;
      if (peerRow) {
        peer = {
          id: peerRow.id,
          displayName: peerRow.display_name,
          username: peerRow.username,
          role: peerRow.role,
          avatarAssetId: peerRow.avatar_asset_id,
          bio: peerRow.bio,
        };
      }
    }

    const lastMsg = db
      .prepare(
        `SELECT cm.id, cm.sender_id, COALESCE(u.display_name, cm.sender_name_snapshot) AS sender_name,
                cm.cipher_body, cm.audio_asset_id, cm.file_asset_id, cm.filename_snapshot,
                cm.created_at, cm.deleted_at
         FROM conversation_messages cm
         LEFT JOIN users u ON u.id = cm.sender_id
         WHERE cm.conversation_id = ?
           AND cm.created_at >= ?
           AND NOT EXISTS (
             SELECT 1 FROM conversation_message_hides h
             WHERE h.user_id = ? AND h.message_id = cm.id
           )
         ORDER BY cm.id DESC
         LIMIT 1`
      )
      .get(conv.id, cutoff, viewerId) as
      | {
          id: number;
          sender_id: string | null;
          sender_name: string;
          cipher_body: string;
          audio_asset_id: string | null;
          file_asset_id: string | null;
          filename_snapshot: string | null;
          created_at: number;
          deleted_at: number | null;
        }
      | undefined;

    let lastMessagePreview =
      conv.kind === 'dm'
        ? 'محادثة مشفرة · ابدأ بإرسال رسالة'
        : 'مجموعة مشفرة · تم الإنشاء حديثًا';
    let lastMessageAt = conv.updated_at;
    let lastMessageSenderName: string | null = null;
    let lastMessageIsMine = false;
    let lastMessageReceiptStatus: ReceiptStatus | null = null;

    if (lastMsg) {
      lastMessageAt = lastMsg.created_at;
      lastMessageSenderName = lastMsg.sender_name || 'عضو';
      lastMessageIsMine = lastMsg.sender_id === viewerId;
      if (lastMsg.deleted_at !== null) {
        lastMessagePreview = 'تم حذف هذه الرسالة';
      } else {
        const plain = decryptSafely(
          lastMsg.cipher_body,
          convKey,
          conv.id,
          lastMsg.sender_id
        ).trim();
        lastMessagePreview =
          plain ||
          (lastMsg.audio_asset_id
            ? '🎤 رسالة صوتية'
            : lastMsg.filename_snapshot
            ? `📎 ${lastMsg.filename_snapshot}`
            : '📎 مرفق');
        if (lastMessageIsMine) {
          const stat = db
            .prepare(
              `SELECT MAX(CASE WHEN read_at IS NOT NULL THEN 1 ELSE 0 END) AS any_read,
                      MAX(CASE WHEN delivered_at IS NOT NULL THEN 1 ELSE 0 END) AS any_delivered
               FROM conversation_receipts
               WHERE message_id = ?`
            )
            .get(lastMsg.id) as { any_read: number; any_delivered: number } | undefined;
          if (stat?.any_read && readReceiptsEnabled) lastMessageReceiptStatus = 'read';
          else if (stat?.any_read || stat?.any_delivered) lastMessageReceiptStatus = 'delivered';
          else lastMessageReceiptStatus = 'sent';
        }
      }
    }

    const unreadCount = (
      db
        .prepare(
          `SELECT COUNT(*) AS cnt
           FROM conversation_messages cm
           WHERE cm.conversation_id = ?
             AND cm.id > ?
             AND cm.created_at >= ?
             AND cm.deleted_at IS NULL
             AND (cm.sender_id IS NULL OR cm.sender_id != ?)
             AND NOT EXISTS (
               SELECT 1 FROM conversation_message_hides h
               WHERE h.user_id = ? AND h.message_id = cm.id
             )`
        )
        .get(conv.id, memberRow.highest_read_message_id, cutoff, viewerId, viewerId) as {
        cnt: number;
      }
    ).cnt;

    const disappearingHours: DisappearingHours =
      conv.disappearing_hours === 24 ||
      conv.disappearing_hours === 168 ||
      conv.disappearing_hours === 720
        ? conv.disappearing_hours
        : 0;

    return {
      id: conv.id,
      kind: conv.kind,
      title: conv.kind === 'dm' ? peer?.displayName || 'محادثة خاصة' : conv.title,
      description: conv.description,
      encrypted: true,
      keyFingerprint: conv.key_fingerprint,
      peer,
      memberCount,
      myRole: memberRow.role,
      onlyAdminsSend: Boolean(conv.only_admins_send),
      disappearingHours,
      mutedNotifications: Boolean(memberRow.muted_notifications),
      pinnedMessage: readPinnedSummary(conv, convKey, cutoff, viewerId),
      lastMessagePreview: lastMessagePreview.slice(0, 120),
      lastMessageAt,
      lastMessageSenderName,
      lastMessageIsMine,
      lastMessageReceiptStatus,
      unreadCount,
      createdAt: conv.created_at,
      updatedAt: conv.updated_at,
    };
  }

  function getConversationMemberIds(conversationId: string): string[] {
    return (
      db
        .prepare('SELECT user_id FROM conversation_members WHERE conversation_id = ?')
        .all(conversationId) as Array<{ user_id: string }>
    ).map((r) => r.user_id);
  }

  // List all DMs and Custom Groups for current user
  router.get('/chat/conversations', requireAuth, (req: AuthenticatedRequest, res) => {
    const viewer = req.authUser!;
    const rows = db
      .prepare(
        `SELECT c.*, mem.role AS my_role, mem.highest_read_message_id,
                mem.muted_notifications, mem.cleared_before_at
         FROM conversation_members mem
         JOIN conversations c ON c.id = mem.conversation_id
         WHERE mem.user_id = ?
         ORDER BY c.updated_at DESC`
      )
      .all(viewer.id) as Array<
      ConversationRow & {
        my_role: ConversationMemberRole;
        highest_read_message_id: number;
        muted_notifications: number;
        cleared_before_at: number;
      }
    >;

    const conversations = rows.map((r) =>
      buildConversationSummary(r, viewer.id, {
        role: r.my_role,
        highest_read_message_id: r.highest_read_message_id,
        muted_notifications: r.muted_notifications,
        cleared_before_at: r.cleared_before_at,
      })
    );
    conversations.sort((a, b) => b.lastMessageAt - a.lastMessageAt);
    res.json({ conversations });
  });

  // Start or get canonical 1-to-1 encrypted DM between two approved members
  router.post('/chat/conversations/dm', requireAuth, (req: AuthenticatedRequest, res) => {
    const viewer = req.authUser!;
    const targetUserId = String(req.body?.targetUserId || '').trim();
    if (!targetUserId || targetUserId === viewer.id) {
      res.status(400).json({ error: 'اختر عضوًا آخر لبدء المحادثة الخاصة' });
      return;
    }

    const peer = db
      .prepare("SELECT id, approval_status FROM users WHERE id = ? AND approval_status = 'approved'")
      .get(targetUserId) as { id: string; approval_status: string } | undefined;
    if (!peer) {
      res.status(404).json({ error: 'العضو غير موجود أو غير مفعل بعد' });
      return;
    }

    const pair = [viewer.id, targetUserId].sort();
    const convId = `dm:${pair[0]}:${pair[1]}`;
    let conv = getConversationRow(convId);

    if (!conv) {
      const now = Date.now();
      const { wrappedKey, fingerprint } = generateConversationKey(masterKey, convId);
      const tx = db.transaction(() => {
        db.prepare(
          `INSERT INTO conversations (id, kind, title, description, creator_id, wrapped_key, key_fingerprint, created_at, updated_at)
           VALUES (?, 'dm', '', '', ?, ?, ?, ?, ?)`
        ).run(convId, viewer.id, wrappedKey, fingerprint, now, now);

        const insMem = db.prepare(
          `INSERT INTO conversation_members (conversation_id, user_id, role, joined_at)
           VALUES (?, ?, 'member', ?)`
        );
        insMem.run(convId, pair[0], now);
        insMem.run(convId, pair[1], now);
      });
      tx();
      conv = getConversationRow(convId)!;
      hub.broadcastConversationListUpdated([viewer.id, targetUserId]);
    } else {
      // Ensure both members exist in case one somehow isn't linked
      const mem = getMemberRow(convId, viewer.id);
      if (!mem) {
        db.prepare(
          `INSERT OR IGNORE INTO conversation_members (conversation_id, user_id, role, joined_at)
           VALUES (?, ?, 'member', ?)`
        ).run(convId, viewer.id, Date.now());
      }
    }

    const memRow = getMemberRow(convId, viewer.id)!;
    res.status(201).json({
      conversation: buildConversationSummary(conv, viewer.id, memRow),
    });
  });

  // Create a custom WhatsApp-style encrypted group (any approved member can create!)
  router.post('/chat/conversations/groups', requireAuth, (req: AuthenticatedRequest, res) => {
    const schema = z.object({
      title: z.string().trim().min(2, 'اسم المجموعة يجب أن يكون حرفين على الأقل').max(60),
      description: z.string().trim().max(240).optional().default(''),
      memberIds: z.array(z.string().min(1)).max(100).optional().default([]),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'بيانات المجموعة غير صالحة' });
      return;
    }

    const viewer = req.authUser!;
    const { title, description, memberIds } = parsed.data;

    const uniqueOthers = Array.from(new Set(memberIds.filter((id) => id && id !== viewer.id)));
    if (uniqueOthers.length === 0) {
      res.status(400).json({ error: 'اختر عضوًا واحدًا على الأقل لإضافته إلى المجموعة' });
      return;
    }

    const approvedRows = db
      .prepare(
        `SELECT id FROM users
         WHERE approval_status = 'approved'
           AND id IN (${uniqueOthers.map(() => '?').join(',')})`
      )
      .all(...uniqueOthers) as Array<{ id: string }>;
    const validOthers = approvedRows.map((r) => r.id);
    if (validOthers.length === 0) {
      res.status(400).json({ error: 'لم يتم العثور على أعضاء مفعلين من الاختيار' });
      return;
    }

    const convId = `grp_${randomUUID().slice(0, 12)}`;
    const now = Date.now();
    const { wrappedKey, fingerprint } = generateConversationKey(masterKey, convId);

    const tx = db.transaction(() => {
      db.prepare(
        `INSERT INTO conversations (id, kind, title, description, creator_id, wrapped_key, key_fingerprint, created_at, updated_at)
         VALUES (?, 'group', ?, ?, ?, ?, ?, ?, ?)`
      ).run(convId, title, description, viewer.id, wrappedKey, fingerprint, now, now);

      const insMem = db.prepare(
        `INSERT INTO conversation_members (conversation_id, user_id, role, joined_at)
         VALUES (?, ?, ?, ?)`
      );
      insMem.run(convId, viewer.id, 'admin', now);
      for (const uid of validOthers) {
        insMem.run(convId, uid, 'member', now);
      }
    });
    tx();

    const conv = getConversationRow(convId)!;
    const memRow = getMemberRow(convId, viewer.id)!;
    hub.broadcastConversationListUpdated([viewer.id, ...validOthers]);
    res.status(201).json({
      conversation: buildConversationSummary(conv, viewer.id, memRow),
    });
  });

  // Get starred messages across all user's encrypted DMs & groups
  router.get('/chat/conversations/starred/all', requireAuth, (req: AuthenticatedRequest, res) => {
    const viewer = req.authUser!;
    const rows = db
      .prepare(
        `SELECT cm.id, cm.conversation_id, cm.sender_id, cm.sender_name_snapshot,
                u.display_name AS sender_display_name, u.username AS sender_username,
                u.role AS sender_role, u.avatar_asset_id AS sender_avatar_asset_id,
                cm.cipher_body, cm.reply_to_id, cm.audio_asset_id, cm.file_asset_id,
                cm.filename_snapshot, cm.created_at, cm.edited_at, cm.deleted_at,
                mem.role AS my_role, mem.cleared_before_at
         FROM conversation_starred cs
         JOIN conversation_messages cm ON cm.id = cs.message_id
         JOIN conversation_members mem
           ON mem.conversation_id = cm.conversation_id AND mem.user_id = ?
         JOIN conversations c ON c.id = cm.conversation_id
         LEFT JOIN users u ON u.id = cm.sender_id
         WHERE cs.user_id = ?
           AND cm.deleted_at IS NULL
           AND cm.created_at >= mem.cleared_before_at
           AND (c.disappearing_hours <= 0 OR cm.created_at >= (? - c.disappearing_hours * 3600000))
           AND NOT EXISTS (
             SELECT 1 FROM conversation_message_hides h
             WHERE h.user_id = ? AND h.message_id = cm.id
           )
         ORDER BY cs.starred_at DESC
         LIMIT 60`
      )
      .all(viewer.id, viewer.id, Date.now(), viewer.id) as Array<
      RawConvMessageRow & { my_role: ConversationMemberRole; cleared_before_at: number }
    >;

    const byConv = new Map<string, ConversationRow>();
    const results: ConversationMessage[] = [];
    for (const r of rows) {
      let conv = byConv.get(r.conversation_id);
      if (!conv) {
        conv = getConversationRow(r.conversation_id);
        if (!conv) continue;
        byConv.set(r.conversation_id, conv);
      }
      const convKey = unwrapConversationKey(conv.wrapped_key, masterKey, conv.id);
      const cutoff = getEffectiveConvCutoff(conv, r.cleared_before_at);
      results.push(...hydrateConversationMessages([r], conv, convKey, viewer.id, r.my_role, cutoff));
    }

    res.json({ messages: results });
  });

  // Detailed conversation info + members list
  router.get('/chat/conversations/:id', requireAuth, (req: AuthenticatedRequest, res) => {
    const convId = String(req.params.id);
    const viewer = req.authUser!;
    const mem = getMemberRow(convId, viewer.id);
    const conv = getConversationRow(convId);
    if (!conv || !mem) {
      res.status(403).json({ error: 'لا يمكنك الوصول لهذه المحادثة' });
      return;
    }

    const memberRows = db
      .prepare(
        `SELECT cm.user_id, cm.role, cm.joined_at,
                u.display_name, u.username, u.role AS user_role, u.avatar_asset_id
         FROM conversation_members cm
         JOIN users u ON u.id = cm.user_id
         WHERE cm.conversation_id = ?
         ORDER BY CASE WHEN cm.role = 'admin' THEN 0 ELSE 1 END, cm.joined_at ASC`
      )
      .all(convId) as Array<{
      user_id: string;
      role: ConversationMemberRole;
      joined_at: number;
      display_name: string;
      username: string;
      user_role: UserRole;
      avatar_asset_id: string | null;
    }>;

    const members: ConversationMemberInfo[] = memberRows.map((r) => ({
      userId: r.user_id,
      displayName: r.display_name,
      username: r.username,
      userRole: r.user_role,
      avatarAssetId: r.avatar_asset_id,
      role: r.role,
      joinedAt: r.joined_at,
    }));

    res.json({
      conversation: buildConversationSummary(conv, viewer.id, mem),
      members,
    });
  });

  // Update group settings (title, description, onlyAdminsSend, disappearingHours)
  router.patch('/chat/conversations/:id', requireAuth, (req: AuthenticatedRequest, res) => {
    const convId = String(req.params.id);
    const viewer = req.authUser!;
    const conv = getConversationRow(convId);
    const mem = getMemberRow(convId, viewer.id);
    if (!conv || !mem) {
      res.status(403).json({ error: 'لا يمكنك الوصول لهذه المحادثة' });
      return;
    }

    const schema = z.object({
      title: z.string().trim().min(2).max(60).optional(),
      description: z.string().trim().max(240).optional(),
      onlyAdminsSend: z.boolean().optional(),
      disappearingHours: z.union([z.literal(0), z.literal(24), z.literal(168), z.literal(720)]).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'إعدادات المجموعة غير صالحة' });
      return;
    }

    if (conv.kind === 'group' && mem.role !== 'admin') {
      res.status(403).json({ error: 'تعديل إعدادات المجموعة متاح لمشرفي المجموعة فقط' });
      return;
    }

    if (conv.kind === 'dm' && (parsed.data.title !== undefined || parsed.data.description !== undefined || parsed.data.onlyAdminsSend !== undefined)) {
      res.status(400).json({ error: 'لا يمكن تعديل اسم أو وصف المحادثة الخاصة' });
      return;
    }

    const nextTitle = parsed.data.title ?? conv.title;
    const nextDesc = parsed.data.description ?? conv.description;
    const nextOnlyAdmins =
      parsed.data.onlyAdminsSend !== undefined
        ? parsed.data.onlyAdminsSend
          ? 1
          : 0
        : conv.only_admins_send;
    const nextDis = parsed.data.disappearingHours ?? conv.disappearing_hours;

    db.prepare(
      `UPDATE conversations
       SET title = ?, description = ?, only_admins_send = ?, disappearing_hours = ?, updated_at = ?
       WHERE id = ?`
    ).run(nextTitle, nextDesc, nextOnlyAdmins, nextDis, Date.now(), convId);

    const updatedConv = getConversationRow(convId)!;
    hub.broadcastConversationListUpdated(getConversationMemberIds(convId));
    res.json({ conversation: buildConversationSummary(updatedConv, viewer.id, mem) });
  });

  // Add members to a group (group admin only)
  router.post('/chat/conversations/:id/members', requireAuth, (req: AuthenticatedRequest, res) => {
    const convId = String(req.params.id);
    const viewer = req.authUser!;
    const conv = getConversationRow(convId);
    const mem = getMemberRow(convId, viewer.id);
    if (!conv || !mem || conv.kind !== 'group') {
      res.status(404).json({ error: 'المجموعة غير موجودة' });
      return;
    }
    if (mem.role !== 'admin') {
      res.status(403).json({ error: 'إضافة الأعضاء متاحة لمشرفي المجموعة فقط' });
      return;
    }

    const userIds = Array.isArray(req.body?.userIds)
      ? (req.body.userIds as unknown[]).map((x) => String(x)).filter(Boolean)
      : [];
    if (userIds.length === 0) {
      res.status(400).json({ error: 'اختر عضوًا واحدًا على الأقل' });
      return;
    }

    const approved = db
      .prepare(
        `SELECT id FROM users WHERE approval_status = 'approved' AND id IN (${userIds.map(() => '?').join(',')})`
      )
      .all(...userIds) as Array<{ id: string }>;

    const now = Date.now();
    const ins = db.prepare(
      `INSERT OR IGNORE INTO conversation_members (conversation_id, user_id, role, joined_at)
       VALUES (?, ?, 'member', ?)`
    );
    const tx = db.transaction(() => {
      for (const r of approved) {
        ins.run(convId, r.id, now);
      }
      db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, convId);
    });
    tx();

    hub.broadcastConversationListUpdated(getConversationMemberIds(convId));
    res.json({ ok: true, addedCount: approved.length });
  });

  // Remove member or leave group
  router.delete(
    '/chat/conversations/:id/members/:userId',
    requireAuth,
    (req: AuthenticatedRequest, res) => {
      const convId = String(req.params.id);
      const targetUserId = String(req.params.userId);
      const viewer = req.authUser!;
      const conv = getConversationRow(convId);
      const mem = getMemberRow(convId, viewer.id);
      if (!conv || !mem || conv.kind !== 'group') {
        res.status(404).json({ error: 'المجموعة غير موجودة' });
        return;
      }

      if (targetUserId !== viewer.id && mem.role !== 'admin') {
        res.status(403).json({ error: 'إزالة الأعضاء متاحة لمشرفي المجموعة فقط' });
        return;
      }

      const prevMembers = getConversationMemberIds(convId);
      const tx = db.transaction(() => {
        db.prepare('DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?').run(
          convId,
          targetUserId
        );

        const remaining = db
          .prepare(
            'SELECT user_id, role FROM conversation_members WHERE conversation_id = ? ORDER BY joined_at ASC'
          )
          .all(convId) as Array<{ user_id: string; role: ConversationMemberRole }>;

        if (remaining.length === 0) {
          db.prepare('DELETE FROM conversations WHERE id = ?').run(convId);
        } else if (!remaining.some((m) => m.role === 'admin')) {
          db.prepare(
            "UPDATE conversation_members SET role = 'admin' WHERE conversation_id = ? AND user_id = ?"
          ).run(convId, remaining[0].user_id);
        }
      });
      tx();

      hub.broadcastConversationListUpdated(prevMembers);
      res.json({ ok: true });
    }
  );

  // Promote / demote group member role
  router.patch(
    '/chat/conversations/:id/members/:userId/role',
    requireAuth,
    (req: AuthenticatedRequest, res) => {
      const convId = String(req.params.id);
      const targetUserId = String(req.params.userId);
      const nextRole = req.body?.role === 'admin' ? 'admin' : req.body?.role === 'member' ? 'member' : null;
      const viewer = req.authUser!;
      const conv = getConversationRow(convId);
      const mem = getMemberRow(convId, viewer.id);

      if (!conv || !mem || conv.kind !== 'group' || !nextRole) {
        res.status(400).json({ error: 'طلب غير صالح' });
        return;
      }
      if (mem.role !== 'admin') {
        res.status(403).json({ error: 'إدارة صلاحيات المجموعة متاحة لمشرفي المجموعة فقط' });
        return;
      }

      db.prepare(
        'UPDATE conversation_members SET role = ? WHERE conversation_id = ? AND user_id = ?'
      ).run(nextRole, convId, targetUserId);
      hub.broadcastConversationListUpdated(getConversationMemberIds(convId));
      res.json({ ok: true });
    }
  );

  // Mute / Unmute notifications for this conversation
  router.post('/chat/conversations/:id/mute', requireAuth, (req: AuthenticatedRequest, res) => {
    const convId = String(req.params.id);
    const viewer = req.authUser!;
    const mem = getMemberRow(convId, viewer.id);
    if (!mem) {
      res.status(403).json({ error: 'لا يمكنك الوصول لهذه المحادثة' });
      return;
    }
    const muted = Boolean(req.body?.muted);
    db.prepare(
      'UPDATE conversation_members SET muted_notifications = ? WHERE conversation_id = ? AND user_id = ?'
    ).run(muted ? 1 : 0, convId, viewer.id);
    res.json({ muted });
  });

  // Clear conversation history for current user only
  router.post(
    '/chat/conversations/:id/clear-for-me',
    requireAuth,
    (req: AuthenticatedRequest, res) => {
      const convId = String(req.params.id);
      const viewer = req.authUser!;
      const mem = getMemberRow(convId, viewer.id);
      if (!mem) {
        res.status(403).json({ error: 'لا يمكنك الوصول لهذه المحادثة' });
        return;
      }
      db.prepare(
        'UPDATE conversation_members SET cleared_before_at = ? WHERE conversation_id = ? AND user_id = ?'
      ).run(Date.now(), convId, viewer.id);
      res.json({ ok: true });
    }
  );

  // Fetch decrypted messages in a conversation (strictly member-only!)
  router.get('/chat/conversations/:id/messages', requireAuth, (req: AuthenticatedRequest, res) => {
    const convId = String(req.params.id);
    const viewer = req.authUser!;
    const conv = getConversationRow(convId);
    const mem = getMemberRow(convId, viewer.id);
    if (!conv || !mem) {
      res.status(403).json({ error: 'هذه المحادثة خاصة بأعضائها فقط' });
      return;
    }

    const convKey = unwrapConversationKey(conv.wrapped_key, masterKey, conv.id);
    const cutoff = getEffectiveConvCutoff(conv, mem.cleared_before_at);
    const limit = Math.min(80, Math.max(1, Number(req.query.limit) || 50));
    const beforeId = req.query.beforeId ? Number(req.query.beforeId) : null;
    const afterId = req.query.afterId ? Number(req.query.afterId) : null;

    let rows: RawConvMessageRow[];
    let hasMore = false;

    if (afterId !== null && Number.isFinite(afterId)) {
      rows = db
        .prepare(
          `SELECT cm.id, cm.conversation_id, cm.sender_id, cm.sender_name_snapshot,
                  u.display_name AS sender_display_name, u.username AS sender_username,
                  u.role AS sender_role, u.avatar_asset_id AS sender_avatar_asset_id,
                  cm.cipher_body, cm.reply_to_id, cm.audio_asset_id, cm.file_asset_id,
                  cm.filename_snapshot, cm.created_at, cm.edited_at, cm.deleted_at
           FROM conversation_messages cm
           LEFT JOIN users u ON u.id = cm.sender_id
           WHERE cm.conversation_id = ?
             AND cm.created_at >= ?
             AND cm.id > ?
             AND NOT EXISTS (
               SELECT 1 FROM conversation_message_hides h
               WHERE h.user_id = ? AND h.message_id = cm.id
             )
           ORDER BY cm.id ASC
           LIMIT ?`
        )
        .all(convId, cutoff, afterId, viewer.id, limit) as RawConvMessageRow[];
    } else if (beforeId !== null && Number.isFinite(beforeId)) {
      const fetched = db
        .prepare(
          `SELECT cm.id, cm.conversation_id, cm.sender_id, cm.sender_name_snapshot,
                  u.display_name AS sender_display_name, u.username AS sender_username,
                  u.role AS sender_role, u.avatar_asset_id AS sender_avatar_asset_id,
                  cm.cipher_body, cm.reply_to_id, cm.audio_asset_id, cm.file_asset_id,
                  cm.filename_snapshot, cm.created_at, cm.edited_at, cm.deleted_at
           FROM conversation_messages cm
           LEFT JOIN users u ON u.id = cm.sender_id
           WHERE cm.conversation_id = ?
             AND cm.created_at >= ?
             AND cm.id < ?
             AND NOT EXISTS (
               SELECT 1 FROM conversation_message_hides h
               WHERE h.user_id = ? AND h.message_id = cm.id
             )
           ORDER BY cm.id DESC
           LIMIT ?`
        )
        .all(convId, cutoff, beforeId, viewer.id, limit + 1) as RawConvMessageRow[];
      hasMore = fetched.length > limit;
      rows = fetched.slice(0, limit).reverse();
    } else {
      const fetched = db
        .prepare(
          `SELECT cm.id, cm.conversation_id, cm.sender_id, cm.sender_name_snapshot,
                  u.display_name AS sender_display_name, u.username AS sender_username,
                  u.role AS sender_role, u.avatar_asset_id AS sender_avatar_asset_id,
                  cm.cipher_body, cm.reply_to_id, cm.audio_asset_id, cm.file_asset_id,
                  cm.filename_snapshot, cm.created_at, cm.edited_at, cm.deleted_at
           FROM conversation_messages cm
           LEFT JOIN users u ON u.id = cm.sender_id
           WHERE cm.conversation_id = ?
             AND cm.created_at >= ?
             AND NOT EXISTS (
               SELECT 1 FROM conversation_message_hides h
               WHERE h.user_id = ? AND h.message_id = cm.id
             )
           ORDER BY cm.id DESC
           LIMIT ?`
        )
        .all(convId, cutoff, viewer.id, limit + 1) as RawConvMessageRow[];
      hasMore = fetched.length > limit;
      rows = fetched.slice(0, limit).reverse();
    }

    const now = Date.now();
    const otherIds = rows
      .filter((r) => r.sender_id && r.sender_id !== viewer.id && r.deleted_at === null)
      .map((r) => r.id);
    if (otherIds.length > 0) {
      const insDeliv = db.prepare(
        `INSERT INTO conversation_receipts (message_id, recipient_id, delivered_at, read_at)
         VALUES (?, ?, ?, NULL)
         ON CONFLICT(message_id, recipient_id) DO UPDATE SET
           delivered_at = COALESCE(conversation_receipts.delivered_at, excluded.delivered_at)`
      );
      const tx = db.transaction(() => {
        for (const id of otherIds) {
          insDeliv.run(id, viewer.id, now);
        }
      });
      tx();
    }

    res.json({
      messages: hydrateConversationMessages(rows, conv, convKey, viewer.id, mem.role, cutoff),
      hasMore,
    });
  });

  // Send encrypted message to DM or Group
  const sendConvMsgSchema = z.object({
    body: z.string().max(2000, 'الرسالة بحد أقصى ٢٠٠٠ حرف').optional().default(''),
    replyToId: z.number().int().positive().nullable().optional(),
    audioAssetId: z.string().min(1).nullable().optional(),
    fileAssetId: z.string().min(1).nullable().optional(),
    idempotencyKey: z.string().min(4).max(80).optional(),
  });

  router.post('/chat/conversations/:id/messages', requireAuth, (req: AuthenticatedRequest, res) => {
    const convId = String(req.params.id);
    const viewer = req.authUser!;
    const conv = getConversationRow(convId);
    const mem = getMemberRow(convId, viewer.id);
    if (!conv || !mem) {
      res.status(403).json({ error: 'لا يمكنك الإرسال في هذه المحادثة' });
      return;
    }

    if (conv.kind === 'group' && Boolean(conv.only_admins_send) && mem.role !== 'admin') {
      res.status(403).json({ error: 'الإرسال في هذه المجموعة متاح لمشرفي المجموعة فقط' });
      return;
    }

    const parsed = sendConvMsgSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'محتوى الرسالة غير صالح' });
      return;
    }

    const { replyToId, audioAssetId, fileAssetId, idempotencyKey } = parsed.data;
    const body = parsed.data.body.trim();
    if (!body && !audioAssetId && !fileAssetId) {
      res.status(400).json({ error: 'اكتب رسالة أو أرفق ملفًا أو تسجيلًا صوتيًا' });
      return;
    }

    const convKey = unwrapConversationKey(conv.wrapped_key, masterKey, conv.id);
    const cutoff = getEffectiveConvCutoff(conv, mem.cleared_before_at);

    if (idempotencyKey) {
      const dup = db
        .prepare(
          `SELECT cm.id, cm.conversation_id, cm.sender_id, cm.sender_name_snapshot,
                  u.display_name AS sender_display_name, u.username AS sender_username,
                  u.role AS sender_role, u.avatar_asset_id AS sender_avatar_asset_id,
                  cm.cipher_body, cm.reply_to_id, cm.audio_asset_id, cm.file_asset_id,
                  cm.filename_snapshot, cm.created_at, cm.edited_at, cm.deleted_at
           FROM conversation_messages cm
           LEFT JOIN users u ON u.id = cm.sender_id
           WHERE cm.sender_id = ? AND cm.conversation_id = ? AND cm.idempotency_key = ?`
        )
        .get(viewer.id, convId, idempotencyKey) as RawConvMessageRow | undefined;
      if (dup) {
        res.json({
          message: hydrateConversationMessages([dup], conv, convKey, viewer.id, mem.role, cutoff)[0],
          deduplicated: true,
        });
        return;
      }
    }

    let validReplyToId: number | null = null;
    if (replyToId) {
      const target = db
        .prepare(
          'SELECT id, conversation_id, created_at, deleted_at FROM conversation_messages WHERE id = ?'
        )
        .get(replyToId) as
        | { id: number; conversation_id: string; created_at: number; deleted_at: number | null }
        | undefined;
      if (
        !target ||
        target.conversation_id !== convId ||
        target.deleted_at !== null ||
        target.created_at < cutoff
      ) {
        res.status(400).json({ error: 'الرسالة المراد الرد عليها غير متاحة' });
        return;
      }
      validReplyToId = target.id;
    }

    let filenameSnapshot: string | null = null;
    if (audioAssetId) {
      const a = db
        .prepare(
          "SELECT id, kind, original_safe_name FROM assets WHERE id = ? AND binding_type = 'pending' AND uploader_id = ?"
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
          "SELECT id, kind, original_safe_name FROM assets WHERE id = ? AND binding_type = 'pending' AND uploader_id = ?"
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

    const cipherBody = body
      ? encryptMessageBody(body, convKey, `${convId}:${viewer.id}`)
      : '';

    const now = Date.now();
    const tx = db.transaction(() => {
      const info = db
        .prepare(
          `INSERT INTO conversation_messages
             (conversation_id, sender_id, sender_name_snapshot, cipher_body, reply_to_id, audio_asset_id, file_asset_id, filename_snapshot, idempotency_key, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          convId,
          viewer.id,
          viewer.displayName,
          cipherBody,
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
        ).run(`conv:${newId}`, audioAssetId);
      }
      if (fileAssetId) {
        db.prepare(
          "UPDATE assets SET binding_type = 'chat_file', binding_id = ? WHERE id = ?"
        ).run(`conv:${newId}`, fileAssetId);
      }

      db.prepare(
        `UPDATE conversation_members
         SET highest_read_message_id = MAX(highest_read_message_id, ?)
         WHERE conversation_id = ? AND user_id = ?`
      ).run(newId, convId, viewer.id);

      db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, convId);
      return newId;
    });

    const newMsgId = tx();
    const inserted = db
      .prepare(
        `SELECT cm.id, cm.conversation_id, cm.sender_id, cm.sender_name_snapshot,
                u.display_name AS sender_display_name, u.username AS sender_username,
                u.role AS sender_role, u.avatar_asset_id AS sender_avatar_asset_id,
                cm.cipher_body, cm.reply_to_id, cm.audio_asset_id, cm.file_asset_id,
                cm.filename_snapshot, cm.created_at, cm.edited_at, cm.deleted_at
         FROM conversation_messages cm
         LEFT JOIN users u ON u.id = cm.sender_id
         WHERE cm.id = ?`
      )
      .get(newMsgId) as RawConvMessageRow;

    hub.broadcastConversationMessageCreated(convId, newMsgId, viewer.id);
    res.status(201).json({
      message: hydrateConversationMessages([inserted], conv, convKey, viewer.id, mem.role, cutoff)[0],
    });
  });

  // Edit own encrypted message
  router.patch(
    '/chat/conversations/messages/:msgId',
    requireAuth,
    (req: AuthenticatedRequest, res) => {
      const msgId = Number(req.params.msgId);
      const body = String(req.body?.body || '').trim();
      if (!body || body.length > 2000) {
        res.status(400).json({ error: 'النص لازم يكون بين ١ و ٢٠٠٠ حرف' });
        return;
      }

      const viewer = req.authUser!;
      const existing = db
        .prepare(
          'SELECT id, conversation_id, sender_id, deleted_at FROM conversation_messages WHERE id = ?'
        )
        .get(msgId) as
        | { id: number; conversation_id: string; sender_id: string | null; deleted_at: number | null }
        | undefined;

      if (!existing || existing.deleted_at !== null) {
        res.status(404).json({ error: 'الرسالة غير موجودة أو تم حذفها' });
        return;
      }
      const mem = getMemberRow(existing.conversation_id, viewer.id);
      const conv = getConversationRow(existing.conversation_id);
      if (!mem || !conv || existing.sender_id !== viewer.id) {
        res.status(403).json({ error: 'يمكنك تعديل رسائلك فقط' });
        return;
      }

      const convKey = unwrapConversationKey(conv.wrapped_key, masterKey, conv.id);
      const nextCipher = encryptMessageBody(body, convKey, `${conv.id}:${viewer.id}`);
      const now = Date.now();
      db.prepare('UPDATE conversation_messages SET cipher_body = ?, edited_at = ? WHERE id = ?').run(
        nextCipher,
        now,
        msgId
      );

      hub.broadcastConversationMessageUpdated(conv.id, msgId);
      res.json({ ok: true, editedAt: now });
    }
  );

  // Delete for everyone in a DM/Group
  router.delete(
    '/chat/conversations/messages/:msgId',
    requireAuth,
    (req: AuthenticatedRequest, res) => {
      const msgId = Number(req.params.msgId);
      const viewer = req.authUser!;
      const msg = db
        .prepare(
          'SELECT id, conversation_id, sender_id, audio_asset_id, file_asset_id, created_at, deleted_at FROM conversation_messages WHERE id = ?'
        )
        .get(msgId) as
        | {
            id: number;
            conversation_id: string;
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

      const conv = getConversationRow(msg.conversation_id);
      const mem = getMemberRow(msg.conversation_id, viewer.id);
      if (!conv || !mem) {
        res.status(403).json({ error: 'لا تملك صلاحية الوصول لهذه الرسالة' });
        return;
      }

      const isOwn = msg.sender_id === viewer.id;
      const isGroupAdmin = conv.kind === 'group' && mem.role === 'admin';
      const within48h = Date.now() - msg.created_at < DELETE_FOR_ALL_LIMIT_MS;

      if (!isGroupAdmin && (!isOwn || !within48h)) {
        res.status(403).json({ error: 'لا تملك صلاحية حذف هذه الرسالة عند الكل' });
        return;
      }

      const now = Date.now();
      const tx = db.transaction(() => {
        db.prepare(
          `UPDATE conversation_messages
           SET cipher_body = '', audio_asset_id = NULL, file_asset_id = NULL, filename_snapshot = NULL,
               deleted_at = ?, deleted_by_id = ?
           WHERE id = ?`
        ).run(now, viewer.id, msgId);
        db.prepare('DELETE FROM conversation_reactions WHERE message_id = ?').run(msgId);
        db.prepare('DELETE FROM conversation_starred WHERE message_id = ?').run(msgId);
        if (msg.audio_asset_id) db.prepare('DELETE FROM assets WHERE id = ?').run(msg.audio_asset_id);
        if (msg.file_asset_id) db.prepare('DELETE FROM assets WHERE id = ?').run(msg.file_asset_id);
        if (conv.pinned_message_id === msgId) {
          db.prepare('UPDATE conversations SET pinned_message_id = NULL WHERE id = ?').run(conv.id);
        }
      });
      tx();

      hub.broadcastConversationMessageUpdated(conv.id, msgId);
      res.json({ ok: true, deletedAt: now });
    }
  );

  // Hide message for current user only
  router.post(
    '/chat/conversations/messages/:msgId/hide',
    requireAuth,
    (req: AuthenticatedRequest, res) => {
      const msgId = Number(req.params.msgId);
      const viewer = req.authUser!;
      const msg = db
        .prepare('SELECT id, conversation_id FROM conversation_messages WHERE id = ?')
        .get(msgId) as { id: number; conversation_id: string } | undefined;
      if (!msg || !getMemberRow(msg.conversation_id, viewer.id)) {
        res.status(403).json({ error: 'لا يمكنك إخفاء هذه الرسالة' });
        return;
      }
      db.prepare(
        `INSERT INTO conversation_message_hides (user_id, message_id, hidden_at)
         VALUES (?, ?, ?) ON CONFLICT(user_id, message_id) DO NOTHING`
      ).run(viewer.id, msgId, Date.now());
      res.json({ ok: true });
    }
  );

  // React to encrypted conversation message
  router.post(
    '/chat/conversations/messages/:msgId/react',
    requireAuth,
    (req: AuthenticatedRequest, res) => {
      const msgId = Number(req.params.msgId);
      const emoji = String(req.body?.emoji || '').trim();
      if (!emoji || emoji.length > 16) {
        res.status(400).json({ error: 'تفاعل غير صالح' });
        return;
      }
      const viewer = req.authUser!;
      const msg = db
        .prepare('SELECT id, conversation_id, deleted_at FROM conversation_messages WHERE id = ?')
        .get(msgId) as { id: number; conversation_id: string; deleted_at: number | null } | undefined;
      if (!msg || msg.deleted_at !== null || !getMemberRow(msg.conversation_id, viewer.id)) {
        res.status(403).json({ error: 'لا يمكنك التفاعل مع هذه الرسالة' });
        return;
      }

      const existing = db
        .prepare('SELECT emoji FROM conversation_reactions WHERE user_id = ? AND message_id = ?')
        .get(viewer.id, msgId) as { emoji: string } | undefined;
      if (existing && existing.emoji === emoji) {
        db.prepare('DELETE FROM conversation_reactions WHERE user_id = ? AND message_id = ?').run(
          viewer.id,
          msgId
        );
      } else {
        db.prepare(
          `INSERT INTO conversation_reactions (user_id, message_id, emoji, created_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(user_id, message_id) DO UPDATE SET emoji = excluded.emoji`
        ).run(viewer.id, msgId, emoji, Date.now());
      }

      hub.broadcastConversationReactionUpdated(msg.conversation_id, msgId);
      res.json({ ok: true });
    }
  );

  // Star / unstar conversation message
  router.post(
    '/chat/conversations/messages/:msgId/star',
    requireAuth,
    (req: AuthenticatedRequest, res) => {
      const msgId = Number(req.params.msgId);
      const viewer = req.authUser!;
      const msg = db
        .prepare('SELECT id, conversation_id, deleted_at FROM conversation_messages WHERE id = ?')
        .get(msgId) as { id: number; conversation_id: string; deleted_at: number | null } | undefined;
      if (!msg || msg.deleted_at !== null || !getMemberRow(msg.conversation_id, viewer.id)) {
        res.status(403).json({ error: 'لا يمكنك تمييز هذه الرسالة' });
        return;
      }
      db.prepare(
        `INSERT INTO conversation_starred (user_id, message_id, starred_at)
         VALUES (?, ?, ?) ON CONFLICT(user_id, message_id) DO NOTHING`
      ).run(viewer.id, msgId, Date.now());
      res.json({ starred: true });
    }
  );

  router.delete(
    '/chat/conversations/messages/:msgId/star',
    requireAuth,
    (req: AuthenticatedRequest, res) => {
      const msgId = Number(req.params.msgId);
      db.prepare('DELETE FROM conversation_starred WHERE user_id = ? AND message_id = ?').run(
        req.authUser!.id,
        msgId
      );
      res.json({ starred: false });
    }
  );

  // Pin / Unpin message inside DM or Group
  router.post('/chat/conversations/:id/pin', requireAuth, (req: AuthenticatedRequest, res) => {
    const convId = String(req.params.id);
    const msgId = Number(req.body?.messageId);
    const viewer = req.authUser!;
    const conv = getConversationRow(convId);
    const mem = getMemberRow(convId, viewer.id);
    if (!conv || !mem) {
      res.status(403).json({ error: 'غير مصرح' });
      return;
    }
    if (conv.kind === 'group' && mem.role !== 'admin') {
      res.status(403).json({ error: 'تثبيت الرسائل متاح لمشرفي المجموعة فقط' });
      return;
    }
    const msg = db
      .prepare('SELECT id, deleted_at FROM conversation_messages WHERE id = ? AND conversation_id = ?')
      .get(msgId, convId) as { id: number; deleted_at: number | null } | undefined;
    if (!msg || msg.deleted_at !== null) {
      res.status(404).json({ error: 'الرسالة غير موجودة' });
      return;
    }
    db.prepare('UPDATE conversations SET pinned_message_id = ? WHERE id = ?').run(msgId, convId);
    hub.broadcastConversationListUpdated(getConversationMemberIds(convId));
    res.json({ ok: true });
  });

  router.delete('/chat/conversations/:id/pin', requireAuth, (req: AuthenticatedRequest, res) => {
    const convId = String(req.params.id);
    const viewer = req.authUser!;
    const conv = getConversationRow(convId);
    const mem = getMemberRow(convId, viewer.id);
    if (!conv || !mem) {
      res.status(403).json({ error: 'غير مصرح' });
      return;
    }
    if (conv.kind === 'group' && mem.role !== 'admin') {
      res.status(403).json({ error: 'إلغاء التثبيت متاح لمشرفي المجموعة فقط' });
      return;
    }
    db.prepare('UPDATE conversations SET pinned_message_id = NULL WHERE id = ?').run(convId);
    hub.broadcastConversationListUpdated(getConversationMemberIds(convId));
    res.json({ ok: true });
  });

  // Mark messages read in DM/Group
  router.post('/chat/conversations/:id/read', requireAuth, (req: AuthenticatedRequest, res) => {
    const convId = String(req.params.id);
    const highestMessageId = Number(req.body?.highestMessageId);
    const viewer = req.authUser!;
    const conv = getConversationRow(convId);
    const mem = getMemberRow(convId, viewer.id);
    if (!conv || !mem || !Number.isFinite(highestMessageId)) {
      res.status(400).json({ error: 'بيانات القراءة غير صالحة' });
      return;
    }

    const cutoff = getEffectiveConvCutoff(conv, mem.cleared_before_at);
    const readable = db
      .prepare(
        `SELECT id, sender_id FROM conversation_messages
         WHERE conversation_id = ? AND id <= ? AND created_at >= ? AND deleted_at IS NULL
         ORDER BY id DESC LIMIT 60`
      )
      .all(convId, highestMessageId, cutoff) as Array<{ id: number; sender_id: string | null }>;

    const maxId = readable.length > 0 ? readable[0].id : 0;
    const now = Date.now();
    const readReceiptsEnabled = readViewerReadReceiptsEnabled(viewer.id);

    if (maxId > 0) {
      const tx = db.transaction(() => {
        db.prepare(
          `UPDATE conversation_members
           SET highest_read_message_id = MAX(highest_read_message_id, ?)
           WHERE conversation_id = ? AND user_id = ?`
        ).run(maxId, convId, viewer.id);

        const upsert = db.prepare(
          `INSERT INTO conversation_receipts (message_id, recipient_id, delivered_at, read_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(message_id, recipient_id) DO UPDATE SET
             delivered_at = COALESCE(conversation_receipts.delivered_at, excluded.delivered_at),
             read_at = COALESCE(conversation_receipts.read_at, excluded.read_at)`
        );
        for (const m of readable) {
          if (m.sender_id && m.sender_id !== viewer.id) {
            upsert.run(m.id, viewer.id, now, readReceiptsEnabled ? now : null);
          }
        }
      });
      tx();

      if (readReceiptsEnabled) {
        for (const m of readable) {
          if (m.sender_id && m.sender_id !== viewer.id) {
            hub.broadcastConversationReceiptUpdated(m.sender_id, convId, m.id);
          }
        }
      }
    }

    res.json({ ok: true });
  });

  // Delivery/Read receipt info for a message
  router.get(
    '/chat/conversations/messages/:msgId/info',
    requireAuth,
    (req: AuthenticatedRequest, res) => {
      const msgId = Number(req.params.msgId);
      const viewer = req.authUser!;
      const msg = db
        .prepare(
          'SELECT id, conversation_id, sender_id, deleted_at FROM conversation_messages WHERE id = ?'
        )
        .get(msgId) as
        | { id: number; conversation_id: string; sender_id: string | null; deleted_at: number | null }
        | undefined;
      if (!msg || msg.deleted_at !== null) {
        res.status(404).json({ error: 'الرسالة غير موجودة' });
        return;
      }
      const mem = getMemberRow(msg.conversation_id, viewer.id);
      const conv = getConversationRow(msg.conversation_id);
      if (!mem || !conv || (msg.sender_id !== viewer.id && !(conv.kind === 'group' && mem.role === 'admin'))) {
        res.status(403).json({ error: 'تفاصيل القراءة متاحة لصاحب الرسالة فقط' });
        return;
      }

      const rows = db
        .prepare(
          `SELECT r.recipient_id, u.display_name, u.username, r.delivered_at, r.read_at
           FROM conversation_receipts r
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

      const receipts: MessageReceiptDetail[] = rows.map((r) => ({
        recipientId: r.recipient_id,
        displayName: r.display_name,
        username: r.username,
        deliveredAt: r.delivered_at,
        readAt: r.read_at,
      }));
      res.json({ receipts });
    }
  );

  // Search decrypted messages inside a conversation
  router.get('/chat/conversations/:id/search', requireAuth, (req: AuthenticatedRequest, res) => {
    const convId = String(req.params.id);
    const q = String(req.query.q || '').trim().toLowerCase();
    const viewer = req.authUser!;
    const conv = getConversationRow(convId);
    const mem = getMemberRow(convId, viewer.id);
    if (!conv || !mem) {
      res.status(403).json({ error: 'غير مصرح' });
      return;
    }
    if (!q) {
      res.json({ messages: [] });
      return;
    }

    const convKey = unwrapConversationKey(conv.wrapped_key, masterKey, conv.id);
    const cutoff = getEffectiveConvCutoff(conv, mem.cleared_before_at);
    const rows = db
      .prepare(
        `SELECT cm.id, cm.conversation_id, cm.sender_id, cm.sender_name_snapshot,
                u.display_name AS sender_display_name, u.username AS sender_username,
                u.role AS sender_role, u.avatar_asset_id AS sender_avatar_asset_id,
                cm.cipher_body, cm.reply_to_id, cm.audio_asset_id, cm.file_asset_id,
                cm.filename_snapshot, cm.created_at, cm.edited_at, cm.deleted_at
         FROM conversation_messages cm
         LEFT JOIN users u ON u.id = cm.sender_id
         WHERE cm.conversation_id = ?
           AND cm.created_at >= ?
           AND cm.deleted_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM conversation_message_hides h
             WHERE h.user_id = ? AND h.message_id = cm.id
           )
         ORDER BY cm.id DESC
         LIMIT 250`
      )
      .all(convId, cutoff, viewer.id) as RawConvMessageRow[];

    const hydrated = hydrateConversationMessages(rows, conv, convKey, viewer.id, mem.role, cutoff);
    const matches = hydrated
      .filter(
        (m) =>
          m.body.toLowerCase().includes(q) ||
          (m.fileAttachment?.filename.toLowerCase().includes(q) ?? false)
      )
      .slice(0, 40);

    res.json({ messages: matches });
  });

  // Export decrypted conversation transcript
  router.get('/chat/conversations/:id/export', requireAuth, (req: AuthenticatedRequest, res) => {
    const convId = String(req.params.id);
    const viewer = req.authUser!;
    const conv = getConversationRow(convId);
    const mem = getMemberRow(convId, viewer.id);
    if (!conv || !mem) {
      res.status(403).json({ error: 'غير مصرح' });
      return;
    }

    const convKey = unwrapConversationKey(conv.wrapped_key, masterKey, conv.id);
    const cutoff = getEffectiveConvCutoff(conv, mem.cleared_before_at);
    const rows = db
      .prepare(
        `SELECT cm.id, cm.conversation_id, cm.sender_id, cm.sender_name_snapshot,
                u.display_name AS sender_display_name, u.username AS sender_username,
                u.role AS sender_role, u.avatar_asset_id AS sender_avatar_asset_id,
                cm.cipher_body, cm.reply_to_id, cm.audio_asset_id, cm.file_asset_id,
                cm.filename_snapshot, cm.created_at, cm.edited_at, cm.deleted_at
         FROM conversation_messages cm
         LEFT JOIN users u ON u.id = cm.sender_id
         WHERE cm.conversation_id = ?
           AND cm.created_at >= ?
           AND cm.deleted_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM conversation_message_hides h
             WHERE h.user_id = ? AND h.message_id = cm.id
           )
         ORDER BY cm.id ASC
         LIMIT 500`
      )
      .all(convId, cutoff, viewer.id) as RawConvMessageRow[];

    const lines = rows.map((r) => {
      const ts = new Date(r.created_at).toLocaleString('ar-EG');
      const sender = r.sender_display_name || r.sender_name_snapshot || 'عضو';
      const plain = decryptSafely(r.cipher_body, convKey, conv.id, r.sender_id).trim();
      const content =
        plain ||
        (r.audio_asset_id ? '[رسالة صوتية]' : r.filename_snapshot ? `[ملف: ${r.filename_snapshot}]` : '');
      return `[${ts}] ${sender}: ${content}`;
    });

    res.json({
      filename: `rahhala-encrypted-chat.txt`,
      text: lines.join('\n'),
    });
  });

  return router;
}
