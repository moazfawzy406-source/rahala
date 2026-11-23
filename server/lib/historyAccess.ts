import type { RahhalaDb } from '../db.ts';
import type { UserRole } from '../../shared/types.ts';

export interface AuthViewer {
  id: string;
  role: UserRole;
  approvalStatus: string;
  historyGranted: boolean;
  createdAt: number;
}

/**
 * Single authoritative history-access cutoff rule:
 * - Admin and Owner always have full history access (cutoff = 0).
 * - Member with historyGranted === true has full history access (cutoff = 0).
 * - Newly approved member without historyGranted can only access messages created >= user.createdAt.
 */
export function getHistoryCutoff(viewer: AuthViewer): number {
  if (viewer.role === 'owner' || viewer.role === 'admin' || viewer.historyGranted) {
    return 0;
  }
  return viewer.createdAt;
}

export function canViewerAccessMessage(
  db: RahhalaDb,
  viewer: AuthViewer,
  messageRow: { id: number; created_at: number; deleted_at: number | null }
): boolean {
  if (viewer.approvalStatus !== 'approved') return false;
  if (messageRow.deleted_at !== null) return false;
  const cutoff = getHistoryCutoff(viewer);
  if (messageRow.created_at < cutoff) return false;

  const hidden = db
    .prepare('SELECT 1 FROM message_hides WHERE user_id = ? AND message_id = ?')
    .get(viewer.id, messageRow.id);
  if (hidden) return false;

  return true;
}

export function canViewerAccessAsset(
  db: RahhalaDb,
  viewer: AuthViewer,
  assetRow: {
    id: string;
    uploader_id: string | null;
    binding_type: string;
    binding_id: string | null;
  }
): boolean {
  if (viewer.approvalStatus !== 'approved') return false;

  if (assetRow.binding_type === 'avatar') {
    return true;
  }

  if (assetRow.binding_type === 'pending') {
    return assetRow.uploader_id === viewer.id;
  }

  if (assetRow.binding_type === 'chat_file' || assetRow.binding_type === 'chat_audio') {
    if (assetRow.binding_id?.startsWith('conv:')) {
      const convMsgId = Number(assetRow.binding_id.slice(5));
      if (!Number.isFinite(convMsgId)) return false;
      const msg = db
        .prepare(
          `SELECT cm.id, cm.conversation_id, cm.created_at, cm.deleted_at,
                  mem.cleared_before_at, c.disappearing_hours
           FROM conversation_messages cm
           JOIN conversation_members mem
             ON mem.conversation_id = cm.conversation_id AND mem.user_id = ?
           JOIN conversations c
             ON c.id = cm.conversation_id
           WHERE cm.id = ?`
        )
        .get(viewer.id, convMsgId) as
        | {
            id: number;
            conversation_id: string;
            created_at: number;
            deleted_at: number | null;
            cleared_before_at: number;
            disappearing_hours: number;
          }
        | undefined;
      if (!msg || msg.deleted_at !== null) return false;
      if (msg.created_at < msg.cleared_before_at) return false;
      if (
        msg.disappearing_hours > 0 &&
        msg.created_at < Date.now() - msg.disappearing_hours * 3_600_000
      ) {
        return false;
      }
      const hidden = db
        .prepare('SELECT 1 FROM conversation_message_hides WHERE user_id = ? AND message_id = ?')
        .get(viewer.id, msg.id);
      if (hidden) return false;
      return true;
    }

    const msgId = Number(assetRow.binding_id);
    if (!Number.isFinite(msgId)) return false;
    const msg = db
      .prepare('SELECT id, created_at, deleted_at FROM messages WHERE id = ?')
      .get(msgId) as { id: number; created_at: number; deleted_at: number | null } | undefined;
    if (!msg) return false;
    return canViewerAccessMessage(db, viewer, msg);
  }

  return false;
}
