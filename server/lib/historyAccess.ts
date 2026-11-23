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
