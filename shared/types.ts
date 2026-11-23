export type UserRole = 'member' | 'admin' | 'owner';
export type ApprovalStatus = 'pending' | 'approved';
export type HistoryRequestStatus = 'pending' | 'approved' | 'rejected';
export type ChannelId = 'announcements' | 'questions' | 'general';
export type MaterialKind = 'pdf' | 'video' | 'doc' | 'drive' | 'telegram' | 'link';
export type AssetKind = 'image' | 'pdf' | 'audio' | 'office' | 'avatar';
export type ThemeId = 'dark' | 'light' | 'sepia' | 'warm-night';

export const CHANNELS: ReadonlyArray<{ id: ChannelId; label: string; description: string }> = [
  { id: 'announcements', label: 'إعلانات', description: 'إعلانات الدفعة الرسمية من المشرفين والمالك' },
  { id: 'questions', label: 'أسئلة', description: 'استفسارات المواد والمذاكرة بين الطلاب' },
  { id: 'general', label: 'عام', description: 'المناقشة العامة لأعضاء الدفعة' },
] as const;

export const THEMES: ReadonlyArray<{ id: ThemeId; label: string; description: string }> = [
  { id: 'dark', label: 'داكن', description: 'كحلي هادئ وذهبي دافئ' },
  { id: 'light', label: 'فاتح', description: 'نهاري مشرق وواضح' },
  { id: 'sepia', label: 'سيبيا', description: 'ورقي مريح للقراءة الطويلة' },
  { id: 'warm-night', label: 'ليلي دافئ', description: 'ليلي دافئ مريح للعين' },
] as const;

export const ROLE_LABELS: Record<UserRole, string> = {
  owner: 'مالك',
  admin: 'مشرف',
  member: 'عضو',
};

export interface AuthUser {
  id: string;
  displayName: string;
  username: string;
  role: UserRole;
  approvalStatus: ApprovalStatus;
  historyGranted: boolean;
  bio: string;
  avatarAssetId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface SessionInfo {
  id: string;
  deviceLabel: string;
  createdAt: number;
  lastActivityAt: number;
  expiresAt: number;
  isCurrent: boolean;
}

export interface PublicMember {
  id: string;
  displayName: string;
  username: string;
  role: UserRole;
  bio: string;
  avatarAssetId: string | null;
  createdAt: number;
  messageCount: number;
  historyGranted?: boolean;
  privateEmail?: string;
}

export interface SubjectRecord {
  id: string;
  name: string;
  accentColor: string;
  iconName: string;
  sortOrder: number;
  createdAt: number;
  materialCount: number;
  sectionCount: number;
}

export interface SectionRecord {
  id: string;
  subjectId: string;
  label: string;
  sortOrder: number;
  materials: MaterialRecord[];
}

export interface MaterialRecord {
  id: string;
  subjectId: string;
  sectionId: string;
  title: string;
  kind: MaterialKind;
  url: string;
  note: string;
  creatorId: string | null;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

export interface ReplyPreview {
  id: string;
  senderName: string;
  excerpt: string;
  unavailable: boolean;
}

export interface ReactionSummary {
  emoji: string;
  count: number;
  reactedByMe: boolean;
}

export interface MessageAttachment {
  assetId: string;
  kind: AssetKind;
  mime: string;
  filename: string;
  byteSize: number;
}

export type ReceiptStatus = 'sent' | 'delivered' | 'read';

export interface ChatMessage {
  id: number;
  channel: ChannelId;
  senderId: string | null;
  senderName: string;
  senderUsername: string | null;
  senderRole: UserRole | null;
  senderAvatarAssetId: string | null;
  body: string;
  replyTo: ReplyPreview | null;
  audioAttachment: MessageAttachment | null;
  fileAttachment: MessageAttachment | null;
  createdAt: number;
  editedAt: number | null;
  deletedAt: number | null;
  reactions: ReactionSummary[];
  receiptStatus: ReceiptStatus | null;
  starredByMe?: boolean;
  canDeleteForEveryone: boolean;
  canEdit: boolean;
  canViewInfo: boolean;
}

export type ChatWallpaperId = 'default' | 'islamic-geo' | 'midnight' | 'warm-parchment' | 'emerald';
export type ChatFontSize = 'small' | 'medium' | 'large';
export type DisappearingHours = 0 | 24 | 168 | 720;

export interface UserChatSettings {
  wallpaper: ChatWallpaperId;
  fontSize: ChatFontSize;
  enterToSend: boolean;
  readReceiptsEnabled: boolean;
  chatSoundsEnabled: boolean;
}

export interface PinnedMessageSummary {
  id: number;
  channel: ChannelId;
  senderName: string;
  excerpt: string;
  createdAt: number;
}

export interface GroupChatSettings {
  groupName: string;
  groupDescription: string;
  groupRules: string;
  chatLocked: boolean;
  editInfoPolicy: 'mods' | 'owner';
  allowMedia: boolean;
  allowReactions: boolean;
  disappearingHours: DisappearingHours;
  pinnedMessages: Record<ChannelId, PinnedMessageSummary | null>;
}

export interface MessageReceiptDetail {
  recipientId: string;
  displayName: string;
  username: string;
  deliveredAt: number | null;
  readAt: number | null;
}

export interface HistoryRequestRecord {
  id: string;
  userId: string;
  displayName?: string;
  username?: string;
  status: HistoryRequestStatus;
  createdAt: number;
  decidedById: string | null;
  decidedAt: number | null;
}

export interface PendingUserRecord {
  id: string;
  displayName: string;
  username: string;
  email: string;
  createdAt: number;
}

export interface IceServerEntry {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export type MajalisAccessType = 'open' | 'knock';
export type MajalisLayoutMode = 'spotlight' | 'grid';

export interface AppPublicConfig {
  brandName: string;
  tagline: string;
  institutionSubtitle: string;
  chatLocked: boolean;
  meetingMode: 'builtin' | 'external' | 'unconfigured';
  meetingExternalUrl: string;
  defaultRoomAccessType: MajalisAccessType;
  iceServers: IceServerEntry[];
  emailRecoveryEnabled: boolean;
  previewDemoEnabled: boolean;
}

export interface MediaGalleryItem {
  assetId: string;
  messageId: number;
  channel: ChannelId;
  filename: string;
  mime: string;
  byteSize: number;
  senderName: string;
  createdAt: number;
}

export type ReminderStatus = 'active' | 'triggered' | 'completed';

export interface StudyReminderRecord {
  id: string;
  subjectId: string | null;
  subjectName: string;
  note: string;
  remindAt: number;
  durationMinutes: number;
  status: ReminderStatus;
  createdAt: number;
  updatedAt: number;
}

export type AlertToneId =
  | 'chime'
  | 'warm-bell'
  | 'crystal'
  | 'pulse'
  | 'gentle-oud'
  | 'silent';

export const SUBJECT_GENERAL_KEY = '_general';

export const ALERT_TONES: ReadonlyArray<{
  id: AlertToneId;
  label: string;
  description: string;
}> = [
  { id: 'chime', label: 'رنين ثلاثي', description: 'نغمة صاعدة متناغمة (افتراضي)' },
  { id: 'warm-bell', label: 'جرس دافئ', description: 'رنة جرس هادئة برنين دافئ' },
  { id: 'crystal', label: 'نغمة بلورية', description: 'نغمة عالية وواضحة للتركيز' },
  { id: 'pulse', label: 'نبضة مزدوجة', description: 'تنبيه سريع على نبضتين' },
  { id: 'gentle-oud', label: 'وتر هادئ', description: 'نغمة دافئة منخفضة الحدة' },
  { id: 'silent', label: 'صامت (مرئي فقط)', description: 'تنبيه بصري داخل الموقع دون صوت' },
] as const;

export const SUBJECT_COLOR_PALETTE: ReadonlyArray<{
  hex: string;
  label: string;
}> = [
  { hex: '#E3B23C', label: 'ذهبي دافئ' },
  { hex: '#5FBF8F', label: 'زمردي' },
  { hex: '#6AA7E8', label: 'أزرق سماوي' },
  { hex: '#D9825B', label: 'مرجاني دافئ' },
  { hex: '#A580EA', label: 'بنفسجي هادئ' },
  { hex: '#E06C88', label: 'وردي ياقوتي' },
  { hex: '#3BA8A0', label: 'فيروزي' },
  { hex: '#6E84E5', label: 'نيلي' },
] as const;

export interface SubjectAlertPreference {
  subjectId: string;
  accentColor: string;
  toneId: AlertToneId;
  updatedAt: number;
}

export interface StudyChallengeParticipant {
  userId: string;
  displayName: string;
  username: string;
  avatarAssetId: string | null;
  loggedMinutes: number;
  reminderMinutes: number;
  totalMinutes: number;
  progressPercent: number;
  joinedAt: number;
  updatedAt: number;
  isCurrentUser: boolean;
}

export interface StudyChallengeRecord {
  id: string;
  creatorId: string | null;
  creatorName: string;
  subjectId: string | null;
  subjectName: string;
  subjectColor: string;
  title: string;
  description: string;
  targetHours: number;
  targetMinutes: number;
  endsAt: number;
  createdAt: number;
  updatedAt: number;
  participantCount: number;
  joinedByMe: boolean;
  myMinutes: number;
  myProgressPercent: number;
  canDelete: boolean;
  participants: StudyChallengeParticipant[];
}

export interface ChallengeStudyLogRecord {
  id: string;
  challengeId: string;
  challengeTitle: string;
  subjectId: string | null;
  subjectName: string;
  minutes: number;
  loggedAt: number;
}

export type MajalisParticipationMode = 'media' | 'audio' | 'listener';
export type MajalisTimerPhase = 'focus' | 'review' | 'break';

export interface MajalisParticipantInfo {
  userId: string;
  displayName: string;
  avatarAssetId: string | null;
  mode: MajalisParticipationMode;
  micMuted: boolean;
  camOff: boolean;
  screenSharing: boolean;
  handRaised: boolean;
  joinedAt: number;
}

export interface MajalisTimerState {
  phase: MajalisTimerPhase;
  durationMs: number;
  remainingMs: number;
  running: boolean;
  startedAt: number | null;
  updatedByName: string | null;
}

export interface MajalisRoomSettings {
  accessType: MajalisAccessType;
  roomLocked: boolean;
  allowMic: boolean;
  allowCam: boolean;
  allowScreenShare: boolean;
  allowChat: boolean;
  muteOnEntry: boolean;
}

export interface MajalisKnockRequest {
  userId: string;
  displayName: string;
  avatarAssetId: string | null;
  mode: MajalisParticipationMode;
  requestedAt: number;
}

export interface MajalisReactionEvent {
  id: string;
  userId: string;
  displayName: string;
  emoji: string;
  createdAt: number;
}

export interface MajalisRoomSummary {
  id: string;
  title: string;
  subjectId: string | null;
  subjectName: string;
  subjectColor: string;
  creatorId: string | null;
  creatorName: string;
  isDefault: boolean;
  createdAt: number;
  activeCount: number;
  participants: MajalisParticipantInfo[];
  timer: MajalisTimerState;
  settings: MajalisRoomSettings;
  spotlightUserId: string | null;
}

export interface MajalisChatMessageRecord {
  id: string;
  roomId: string;
  userId: string | null;
  senderName: string;
  avatarAssetId: string | null;
  body: string;
  createdAt: number;
}
