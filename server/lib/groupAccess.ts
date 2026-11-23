import type { RahhalaDb } from '../db.ts';
export function groupMember(db: RahhalaDb, groupId: string, userId: string): any {
  return db.prepare("SELECT gm.* FROM chat_group_members gm JOIN chat_groups g ON g.id=gm.group_id WHERE gm.group_id=? AND gm.user_id=? AND gm.status='approved' AND g.archived_at IS NULL").get(groupId,userId);
}
export function groupMessageVisible(db: RahhalaDb, messageId: number, userId: string): any {
  return db.prepare("SELECT m.* FROM group_messages m JOIN chat_group_members gm ON gm.group_id=m.group_id JOIN chat_groups g ON g.id=m.group_id WHERE m.id=? AND gm.user_id=? AND gm.status='approved' AND m.created_at>=gm.history_from AND m.deleted_at IS NULL AND g.archived_at IS NULL AND NOT EXISTS(SELECT 1 FROM group_message_hides h WHERE h.message_id=m.id AND h.user_id=?)").get(messageId,userId,userId);
}
