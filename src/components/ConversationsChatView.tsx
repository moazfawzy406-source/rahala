import {useUpdateBlocker} from '../hooks/useSilentPWAUpdate';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CHANNELS,
  ROLE_LABELS,
  type AuthUser,
  type ChannelId,
  type ChatFontSize,
  type ChatMessage,
  type ChatWallpaperId,
  type ConversationMessage,
  type ConversationSummary,
  type DisappearingHours,
  type GroupChatSettings,
  type HistoryRequestRecord,
  type MessageReceiptDetail,
  type UserChatSettings,
} from '../../shared/types';
import { useWebSocket, type WsServerEvent } from '../hooks/useWebSocket';
import { ApiError, apiRequest, fetchAssetAccessUrl, uploadAssetBinary } from '../lib/api';
import {
  formatByteSize,
  formatClockTime,
  formatDateTime,
  formatDaySeparator,
  formatDurationSeconds,
  getDayKey,
  renderLinkifiedText,
} from '../lib/formatters';
import { resizeImageForUpload } from '../lib/imageResize';
import { downloadProtectedAsset } from '../lib/reliableDownload';
import { Icons } from './Icons';
import {
  Avatar,
  ChatMessagesSkeleton,
  ConfirmDialog,
  EmptyState,
  ErrorRetryPanel,
  ModalShell,
  ProtectedImage,
} from './UI';
import {
  CustomGroupInfoModal,
  EncryptionInfoModal,
  NewDmModal,
  NewGroupModal,
} from './WhatsAppChatModals';

type AnyThreadMessage = ChatMessage | ConversationMessage;

type ActiveThread =
  | { kind: 'channel'; channel: ChannelId }
  | { kind: 'conversation'; conversationId: string };

type ChatListFilter = 'all' | 'unread' | 'dm' | 'group' | 'community';

const EMOJI_CATEGORIES: Array<{ id: string; label: string; items: string[] }> = [
  { id: 'faces', label: 'وجوه', items: ['😊', '😄', '😅', '🤔', '🫡', '😌', '🤲', '😮'] },
  { id: 'gestures', label: 'إشارات', items: ['👍', '👏', '🤝', '☝️', '✍️', '✅', '💯', '🔥'] },
  { id: 'hearts', label: 'قلوب', items: ['❤️', '💛', '💚', '🤍', '🌟', '✨', '🌸', '🕊️'] },
  { id: 'study', label: 'دراسة', items: ['📚', '📖', '📝', '🖋️', '🎓', '🗂️', '📑', '🔍'] },
  { id: 'objects', label: 'أشياء', items: ['☕', '🍵', '⏰', '📌', '💡', '🎧', '💻', '🕌'] },
];

const QUICK_REACTIONS = ['👍', '❤️', '😂', '🤲', '📚', '🔥'];
const STICKER_EMOJIS = ['📚', '🎓', '👍', '❤️', '🤲', '✨', '📝', '☕', '🌟', '👏', '💡', '🕌'];
const MAX_VOICE_SECONDS = 15 * 60;
const MAX_CHAT_UPLOAD_BYTES = Number(import.meta.env.VITE_MAX_UPLOAD_BYTES || 2_000_000);

const DEFAULT_USER_SETTINGS: UserChatSettings = {
  wallpaper: 'default',
  fontSize: 'medium',
  enterToSend: true,
  readReceiptsEnabled: true,
  chatSoundsEnabled: true,
};

const DEFAULT_GROUP_SETTINGS: GroupChatSettings = {
  groupName: 'مجتمع رَحّالَة',
  groupDescription: 'ملتقى طلاب الدفعة لتبادل الملخصات والأسئلة والمناقشات العلمية.',
  groupRules: 'الاحترام المتبادل، والالتزام بموضوع القناة، وعدم نشر روابط غير موثوقة.',
  chatLocked: false,
  editInfoPolicy: 'mods',
  allowMedia: true,
  allowReactions: true,
  disappearingHours: 0,
  pinnedMessages: {
    announcements: null,
    questions: null,
    general: null,
  },
};

const WALLPAPER_OPTIONS: Array<{
  id: ChatWallpaperId;
  label: string;
  previewClass: string;
}> = [
  { id: 'default', label: 'افتراضي', previewClass: 'bg-[var(--bg-surface)]' },
  { id: 'islamic-geo', label: 'زخرفة هندسية', previewClass: 'bg-[var(--bg-card)] chat-wallpaper-islamic-geo' },
  { id: 'midnight', label: 'سكون الليل', previewClass: 'bg-[#101C2C] chat-wallpaper-midnight' },
  { id: 'warm-parchment', label: 'ورق دافئ', previewClass: 'bg-[#2C2419] chat-wallpaper-warm-parchment' },
  { id: 'emerald', label: 'زمردي هادئ', previewClass: 'bg-[#102822] chat-wallpaper-emerald' },
];

const FONT_SIZE_OPTIONS: Array<{ id: ChatFontSize; label: string; textClass: string }> = [
  { id: 'small', label: 'صغير', textClass: 'text-xs leading-relaxed' },
  { id: 'medium', label: 'متوسط', textClass: 'text-sm leading-relaxed' },
  { id: 'large', label: 'كبير', textClass: 'text-base leading-relaxed' },
];

const DISAPPEARING_OPTIONS: Array<{ hours: DisappearingHours; label: string }> = [
  { hours: 0, label: 'معطّلة' },
  { hours: 24, label: '٢٤ ساعة' },
  { hours: 168, label: '٧ أيام' },
  { hours: 720, label: '٣٠ يومًا' },
];

function formatSidebarTime(ts: number): string {
  const now = new Date();
  const d = new Date(ts);
  if (getDayKey(ts) === getDayKey(now.getTime())) {
    return formatClockTime(ts);
  }
  const yest = new Date(now);
  yest.setDate(now.getDate() - 1);
  if (getDayKey(ts) === getDayKey(yest.getTime())) {
    return 'أمس';
  }
  return new Intl.DateTimeFormat('ar-EG', { month: 'short', day: 'numeric' }).format(d);
}

function playChatPing() {
  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(660, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.08);
    gain.gain.setValueAtTime(0.05, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.14);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.15);
    window.setTimeout(() => {
      void ctx.close().catch(() => {});
    }, 250);
  } catch {
    // ignore audio restrictions
  }
}

function VoiceMessagePlayer({ assetId }: { assetId: string }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const togglePlay = async () => {
    setErr(null);
    if (!src) {
      setLoading(true);
      try {
        const freshUrl = await fetchAssetAccessUrl(assetId);
        setSrc(freshUrl);
        window.setTimeout(() => {
          audioRef.current?.play().catch(() => setErr('تعذر تشغيل الصوت'));
        }, 40);
      } catch (e) {
        setErr(e instanceof Error ? e.message : 'تعذر تحميل الصوت');
      } finally {
        setLoading(false);
      }
      return;
    }

    const el = audioRef.current;
    if (!el) return;
    if (playing) {
      el.pause();
    } else {
      el.play().catch(() => setErr('تعذر تشغيل الصوت'));
    }
  };

  return (
    <div className="mt-1.5 p-2.5 rounded-xl bg-black/15 border border-[var(--divider)] min-w-[210px] max-w-[280px]">
      <div className="flex items-center gap-2.5">
        <button
          type="button"
          onClick={togglePlay}
          disabled={loading}
          aria-label={playing ? 'إيقاف الرسالة الصوتية' : 'تشغيل الرسالة الصوتية'}
          className="min-h-[40px] min-w-[40px] rounded-full bg-[var(--accent)] text-[var(--accent-fg)] flex items-center justify-center shrink-0 disabled:opacity-60"
        >
          {playing ? <Icons.Pause className="w-4 h-4" /> : <Icons.Play className="w-4 h-4" />}
        </button>

        <div className="flex-1 min-w-0">
          <div className="h-1.5 rounded-full bg-white/15 overflow-hidden">
            <div
              className="h-full bg-[var(--accent)] transition-all"
              style={{
                width: duration > 0 ? `${Math.min(100, (currentTime / duration) * 100)}%` : '0%',
              }}
            />
          </div>
          <div className="flex justify-between text-[11px] text-[var(--text-secondary)] mt-1 tabular-nums">
            <span>{formatDurationSeconds(currentTime)}</span>
            <span>{duration > 0 ? formatDurationSeconds(duration) : 'تسجيل صوتي'}</span>
          </div>
        </div>
      </div>

      {err && <p className="text-[11px] text-[var(--error)] mt-1">{err}</p>}

      {src && (
        <audio
          ref={audioRef}
          src={src}
          preload="metadata"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => {
            setPlaying(false);
            setCurrentTime(0);
          }}
          onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
          onLoadedMetadata={(e) => setDuration(e.currentTarget.duration || 0)}
          onError={() => {
            setPlaying(false);
            setErr('انتهى رابط الصوت، اضغط للتشغيل مجددًا');
            setSrc(null);
          }}
          className="hidden"
        />
      )}
    </div>
  );
}

function FileAttachmentCard({
  assetId,
  filename,
  byteSize,
}: {
  assetId: string;
  filename: string;
  byteSize: number;
}) {
  const [downloading, setDownloading] = useState(false);
  const [fallbackUrl, setFallbackUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      if (fallbackUrl) URL.revokeObjectURL(fallbackUrl);
    };
  }, [fallbackUrl]);

  const handleDownload = async () => {
    setDownloading(true);
    setError(null);
    try {
      if (fallbackUrl) URL.revokeObjectURL(fallbackUrl);
      const res = await downloadProtectedAsset(assetId, filename, byteSize);
      setFallbackUrl(res.objectUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'فشل تحميل الملف');
    } finally {
      setDownloading(false);
    }
  };

  const ext = (filename.split('.').pop() || 'FILE').toUpperCase().slice(0, 5);
  const extColorClass =
    ext === 'PDF'
      ? 'bg-[var(--error-soft)] text-[var(--error)] border-[var(--error)]/25'
      : ext === 'DOC' || ext === 'DOCX'
      ? 'bg-sky-500/15 text-sky-400 border-sky-400/25'
      : ext === 'XLS' || ext === 'XLSX'
      ? 'bg-[var(--success-soft)] text-[var(--success)] border-[var(--success)]/25'
      : 'bg-[var(--accent-soft)] text-[var(--accent)] border-[var(--accent)]/25';

  return (
    <div className="mt-1.5 p-3 rounded-xl bg-black/15 border border-[var(--divider)] max-w-xs space-y-2">
      <div className="flex items-start gap-2.5">
        <div
          className={`w-10 h-10 rounded-xl border flex flex-col items-center justify-center shrink-0 ${extColorClass}`}
        >
          <span className="text-[10px] font-extrabold tracking-tight leading-none">{ext}</span>
        </div>
        <div className="min-w-0 flex-1">
          <div dir="ltr" className="text-xs font-bold text-[var(--text-primary)] truncate text-left">
            {filename}
          </div>
          <div className="text-xs text-[var(--text-secondary)] tabular-nums">
            {formatByteSize(byteSize)}
          </div>
        </div>
      </div>

      {error && <div className="text-xs text-[var(--error)]">{error}</div>}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={handleDownload}
          disabled={downloading}
          className="min-h-[38px] px-3 py-1.5 rounded-lg bg-[var(--accent)] text-[var(--accent-fg)] text-xs font-bold flex items-center gap-1.5 disabled:opacity-60"
        >
          <Icons.Download className="w-3.5 h-3.5" />
          <span>{downloading ? 'جاري التحميل...' : error ? 'إعادة المحاولة' : 'تحميل'}</span>
        </button>

        {fallbackUrl && (
          <a
            href={fallbackUrl}
            download={filename}
            className="min-h-[38px] px-3 py-1.5 rounded-lg bg-[var(--success-soft)] text-[var(--success)] border border-[var(--success)]/30 text-xs font-bold flex items-center gap-1.5"
          >
            <Icons.Download className="w-3.5 h-3.5" />
            <span>حفظ الملف</span>
          </a>
        )}
      </div>
    </div>
  );
}

export function ConversationsChatView({
  user,
  unreadByChannel,
  onUnreadRefresh,
  onOpenMembersAndMedia,
  onOpenImage,
  onToast,
  onUserRefresh,
  onForceLogout,
}: {
  user: AuthUser;
  unreadByChannel: Record<ChannelId, number>;
  onUnreadRefresh: () => void;
  onOpenMembersAndMedia: () => void;
  onOpenImage: (item: { assetId: string; filename: string; caption?: string; byteSize?: number }) => void;
  onToast: (msg: string, isError?: boolean) => void;
  onUserRefresh: () => void;
  onForceLogout: (msg: string) => void;
}) {
  // Unified Thread Selection (Community Channels + Encrypted DMs & Custom Groups)
  const [activeThread, setActiveThread] = useState<ActiveThread>({
    kind: 'channel',
    channel: 'general',
  });
  const [mobilePane, setMobilePane] = useState<'list' | 'chat'>('list');

  // Private DMs & Custom Groups List
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [conversationsLoading, setConversationsLoading] = useState(true);
  const [listSearch, setListSearch] = useState('');
  const [listFilter, setListFilter] = useState<ChatListFilter>('all');

  // Thread messages state
  const [messages, setMessages] = useState<AnyThreadMessage[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chatLocked, setChatLocked] = useState(false);
  const [typingUsers, setTypingUsers] = useState<Array<{ userId: string; displayName: string }>>([]);

  // History access state (public community channels only)
  const [historyState, setHistoryState] = useState<{
    historyGranted: boolean;
    request: HistoryRequestRecord | null;
  } | null>(null);
  const [historyBusy, setHistoryBusy] = useState(false);

  // Composer state
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [replyTo, setReplyTo] = useState<AnyThreadMessage | null>(null);
  const [editingMsg, setEditingMsg] = useState<AnyThreadMessage | null>(null);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [emojiTab, setEmojiTab] = useState<'emojis' | 'stickers'>('emojis');
  const [emojiCategory, setEmojiCategory] = useState('faces');

  // Voice recording state
  const [recording, setRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const recordChunksRef = useRef<Blob[]>([]);
  const recordTimerRef = useRef<number | null>(null);
  const recordCancelledRef = useRef(false);

  // Thread Search state
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<AnyThreadMessage[] | null>(null);
  const [searching, setSearching] = useState(false);

  // Scroll state
  const listRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const [nearBottom, setNearBottom] = useState(true);
  const [showNewMessagesJump, setShowNewMessagesJump] = useState(false);
  const pendingIdempotencyRef = useRef<string | null>(null);
  const lastTypingSentRef = useRef(0);
  const longPressTimerRef = useRef<number | null>(null);

  // Action menus & modals
  const [actionMsg, setActionMsg] = useState<AnyThreadMessage | null>(null);
  const [deleteAllTarget, setDeleteAllTarget] = useState<AnyThreadMessage | null>(null);
  const [purgeTarget, setPurgeTarget] = useState<ChatMessage | null>(null);
  const [infoTarget, setInfoTarget] = useState<AnyThreadMessage | null>(null);
  const [infoReceipts, setInfoReceipts] = useState<MessageReceiptDetail[] | null>(null);
  const [infoLoading, setInfoLoading] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);

  // WhatsApp-style personal & community settings
  const [userSettings, setUserSettings] = useState<UserChatSettings>(DEFAULT_USER_SETTINGS);
  const [groupSettings, setGroupSettings] = useState<GroupChatSettings>(DEFAULT_GROUP_SETTINGS);
  const [isMutedInChat, setIsMutedInChat] = useState(false);
  const [uploadingFileName, setUploadingFileName] = useState<string | null>(null);
  const [dragOverFiles, setDragOverFiles] = useState(false);
  const [highlightedMessageId, setHighlightedMessageId] = useState<number | null>(null);

  const [chatSettingsOpen, setChatSettingsOpen] = useState(false);
  const [chatSettingsTab, setChatSettingsTab] = useState<'prefs' | 'starred'>('prefs');
  const [starredItems, setStarredItems] = useState<
    Array<{ msg: AnyThreadMessage; sourceLabel: string }>
  >([]);
  const [starredLoading, setStarredLoading] = useState(false);
  const [clearChannelConfirmOpen, setClearChannelConfirmOpen] = useState(false);

  const [groupSettingsOpen, setGroupSettingsOpen] = useState(false);
  const [groupNameDraft, setGroupNameDraft] = useState(DEFAULT_GROUP_SETTINGS.groupName);
  const [groupDescDraft, setGroupDescDraft] = useState(DEFAULT_GROUP_SETTINGS.groupDescription);
  const [groupRulesDraft, setGroupRulesDraft] = useState(DEFAULT_GROUP_SETTINGS.groupRules);
  const [savingGroupSettings, setSavingGroupSettings] = useState(false);

  const [wipeMode, setWipeMode] = useState<'channel' | 'all' | null>(null);
  const [wipeConfirmText, setWipeConfirmText] = useState('');
  const [wipeBusy, setWipeBusy] = useState(false);

  // New WhatsApp DM / Custom Group / Encryption Modals
  const [newDmOpen, setNewDmOpen] = useState(false);
  const [newGroupOpen, setNewGroupOpen] = useState(false);
  const [customConvInfoOpen, setCustomConvInfoOpen] = useState(false);
  const [encryptionModalOpen, setEncryptionModalOpen] = useState(false);
  const [convMenuOpen, setConvMenuOpen] = useState(false);

  const isAdminOrOwner = user.role === 'admin' || user.role === 'owner';
  const activeConversation = useMemo(() => {
    if (activeThread.kind !== 'conversation') return null;
    return conversations.find((c) => c.id === activeThread.conversationId) ?? null;
  }, [activeThread, conversations]);

  const activeChannelId: ChannelId | null =
    activeThread.kind === 'channel' ? activeThread.channel : null;

  const canEditGroupInfo =
    user.role === 'owner' || (user.role === 'admin' && groupSettings.editInfoPolicy === 'mods');

  const canSendInThread = useMemo(() => {
    if (activeThread.kind === 'conversation') {
      if (!activeConversation) return false;
      if (
        activeConversation.kind === 'group' &&
        activeConversation.onlyAdminsSend &&
        activeConversation.myRole !== 'admin'
      ) {
        return false;
      }
      return true;
    }
    if (activeThread.channel === 'announcements') return isAdminOrOwner;
    if (chatLocked) return isAdminOrOwner;
    if (isMutedInChat && !isAdminOrOwner) return false;
    return true;
  }, [activeConversation, activeThread, chatLocked, isAdminOrOwner, isMutedInChat]);

  const canReactInThread = useMemo(() => {
    if (activeThread.kind === 'conversation') return true;
    return groupSettings.allowReactions || isAdminOrOwner;
  }, [activeThread.kind, groupSettings.allowReactions, isAdminOrOwner]);

  const canSendMediaInThread = useMemo(() => {
    if (activeThread.kind === 'conversation') return true;
    return groupSettings.allowMedia || isAdminOrOwner;
  }, [activeThread.kind, groupSettings.allowMedia, isAdminOrOwner]);

  const messageTextSizeClass = useMemo(() => {
    return (
      FONT_SIZE_OPTIONS.find((f) => f.id === userSettings.fontSize)?.textClass ??
      'text-sm leading-relaxed'
    );
  }, [userSettings.fontSize]);

  const currentPinned = useMemo(() => {
    if (activeThread.kind === 'channel') {
      return groupSettings.pinnedMessages[activeThread.channel];
    }
    return activeConversation?.pinnedMessage ?? null;
  }, [activeConversation?.pinnedMessage, activeThread, groupSettings.pinnedMessages]);

  const canPinInThread = useMemo(() => {
    if (activeThread.kind === 'channel') return isAdminOrOwner;
    if (!activeConversation) return false;
    if (activeConversation.kind === 'dm') return true;
    return activeConversation.myRole === 'admin';
  }, [activeConversation, activeThread.kind, isAdminOrOwner]);

  const scrollToBottom = useCallback((smooth = false) => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTo({
      top: el.scrollHeight,
      behavior: smooth ? 'smooth' : 'auto',
    });
    setShowNewMessagesJump(false);
    setNearBottom(true);
  }, []);

  const loadConversations = useCallback(async (isInitial = false) => {
    if (isInitial) setConversationsLoading(true);
    try {
      const res = await apiRequest<{ conversations: ConversationSummary[] }>(
        '/api/chat/conversations',
        { background: !isInitial }
      );
      setConversations(res.conversations);
    } catch {
      // keep existing conversations
    } finally {
      if (isInitial) setConversationsLoading(false);
    }
  }, []);

  const activeThreadKey=activeThread.kind==='channel'?'channel:'+activeThread.channel:'conversation:'+activeThread.conversationId;
  const activeThreadKeyRef=useRef(activeThreadKey);activeThreadKeyRef.current=activeThreadKey;
  const threadKey=(thread:ActiveThread)=>thread.kind==='channel'?'channel:'+thread.channel:'conversation:'+thread.conversationId;
  const markThreadVisibleRead = useCallback(
    async (msgs: AnyThreadMessage[], thread: ActiveThread) => {
      if (document.visibilityState !== 'visible'||threadKey(thread)!==activeThreadKeyRef.current||(mobilePane!=='chat'&&window.innerWidth<768)) return;
      const box=listRef.current?.getBoundingClientRect();if(!box)return;
      const nonDeleted = msgs.filter(m=>{if(m.deletedAt!==null)return false;const node=listRef.current?.querySelector(`[data-conv-message-id="${m.id}"]`);if(!node)return false;const r=node.getBoundingClientRect();return r.height>0&&Math.max(0,Math.min(r.bottom,box.bottom)-Math.max(r.top,box.top))/r.height>=0.6;});
      if (nonDeleted.length === 0) return;
      const maxId = nonDeleted[nonDeleted.length - 1].id;
      try {
        if (thread.kind === 'channel') {
          await apiRequest('/api/chat/read', {
            method: 'POST',
            body: { channel: thread.channel, highestMessageId: maxId },
            background: true,
          });
        } else {
          await apiRequest(`/api/chat/conversations/${thread.conversationId}/read`, {
            method: 'POST',
            body: { highestMessageId: maxId,messageIds:nonDeleted.map(m=>m.id) },
            background: true,
          });
          setConversations((prev) =>
            prev.map((c) =>
              c.id === thread.conversationId ? { ...c, unreadCount: 0 } : c
            )
          );
        }
        onUnreadRefresh();
      } catch {
        // ignore transient read sync failures
      }
    },
    [onUnreadRefresh,mobilePane]
  );

  const loadActiveThread = useCallback(
    async (thread: ActiveThread, isInitial = true) => {
      if (isInitial) {
        setLoading(true);
        setError(null);
      }
      try {
        if (thread.kind === 'channel') {
          const res = await apiRequest<{
            messages: ChatMessage[];
            hasMore: boolean;
            chatLocked: boolean;
            typingUsers: Array<{ userId: string; displayName: string }>;
          }>(`/api/chat/messages?channel=${thread.channel}&limit=50`);
          if(threadKey(thread)!==activeThreadKeyRef.current)return;
          setMessages(res.messages);
          setHasMore(res.hasMore);
          setChatLocked(res.chatLocked);
          setTypingUsers(res.typingUsers);
          if (isInitial) {
            window.setTimeout(() => scrollToBottom(false), 30);
          }
          void markThreadVisibleRead(res.messages, thread);
        } else {
          const res = await apiRequest<{
            messages: ConversationMessage[];
            hasMore: boolean;
          }>(`/api/chat/conversations/${thread.conversationId}/messages?limit=50`);
          if(threadKey(thread)!==activeThreadKeyRef.current)return;
          setMessages(res.messages);
          setHasMore(res.hasMore);
          if (isInitial) {
            setTypingUsers([]);
            window.setTimeout(() => scrollToBottom(false), 30);
          }
          void markThreadVisibleRead(res.messages, thread);
        }
      } catch (err) {
        if (isInitial) {
          setError(err instanceof ApiError ? err.message : 'تعذر تحميل رسائل المحادثة');
        }
      } finally {
        if (isInitial) setLoading(false);
      }
    },
    [markThreadVisibleRead, scrollToBottom]
  );

  const loadHistoryStatus = useCallback(async () => {
    if (isAdminOrOwner || user.historyGranted) {
      setHistoryState({ historyGranted: true, request: null });
      return;
    }
    try {
      const res = await apiRequest<{
        historyGranted: boolean;
        request: HistoryRequestRecord | null;
      }>('/api/members/history-request/mine');
      setHistoryState(res);
    } catch {
      // ignore
    }
  }, [isAdminOrOwner, user.historyGranted]);

  const loadChatSettings = useCallback(async () => {
    try {
      const res = await apiRequest<{
        userSettings: UserChatSettings;
        groupSettings: GroupChatSettings;
        isMutedInChat: boolean;
      }>('/api/chat/settings', { background: true });
      setUserSettings(res.userSettings);
      setGroupSettings(res.groupSettings);
      setChatLocked(res.groupSettings.chatLocked);
      setIsMutedInChat(res.isMutedInChat);
    } catch {
      // keep existing settings
    }
  }, []);

  const loadStarredMessages = useCallback(async () => {
    setStarredLoading(true);
    try {
      const [chanRes, convRes] = await Promise.all([
        apiRequest<{ messages: ChatMessage[] }>('/api/chat/starred'),
        apiRequest<{ messages: ConversationMessage[] }>('/api/chat/conversations/starred/all'),
      ]);
      const convTitleMap = new Map(conversations.map((c) => [c.id, c.title]));
      const items: Array<{ msg: AnyThreadMessage; sourceLabel: string }> = [
        ...chanRes.messages.map((m) => ({
          msg: m,
          sourceLabel:
            CHANNELS.find((c) => c.id === m.channel)?.label ?? 'مجتمع الدفعة',
        })),
        ...convRes.messages.map((m) => ({
          msg: m,
          sourceLabel: convTitleMap.get(m.conversationId) ?? 'محادثة مشفرة',
        })),
      ];
      items.sort((a, b) => b.msg.createdAt - a.msg.createdAt);
      setStarredItems(items);
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'تعذر تحميل الرسائل المميزة بنجمة', true);
    } finally {
      setStarredLoading(false);
    }
  }, [conversations, onToast]);

  useEffect(() => {
    void loadChatSettings();
    void loadConversations(true);
  }, [loadChatSettings, loadConversations]);

  useEffect(() => {
    setConvMenuOpen(false);
    void loadActiveThread(activeThread, true);
    if (activeThread.kind === 'channel') {
      void loadHistoryStatus();
    }
  }, [activeThread, loadActiveThread, loadHistoryStatus]);

  // Real-time incremental sync on WS events / polling fallback
  const syncIncremental = useCallback(async () => {
    const lastId = messages.length > 0 ? messages[messages.length - 1].id : 0;
    try {
      if (activeThread.kind === 'channel') {
        const res = await apiRequest<{
          messages: ChatMessage[];
          chatLocked: boolean;
          typingUsers: Array<{ userId: string; displayName: string }>;
        }>(`/api/chat/messages?channel=${activeThread.channel}&afterId=${lastId}`, {
          background: true,
        });
        if(threadKey(activeThread)!==activeThreadKeyRef.current)return;
        setChatLocked(res.chatLocked);
        setTypingUsers(res.typingUsers);
        if(threadKey(activeThread)!==activeThreadKeyRef.current)return;
        if (res.messages.length > 0) {
          setMessages((prev) => {
            const map = new Map(prev.map((m) => [m.id, m]));
            for (const m of res.messages) map.set(m.id, m);
            return Array.from(map.values()).sort((a, b) => a.id - b.id);
          });
          if (nearBottom) {
            window.setTimeout(() => scrollToBottom(true), 20);
          } else {
            setShowNewMessagesJump(true);
          }
          void markThreadVisibleRead(res.messages, activeThread);
        }
      } else {
        const res = await apiRequest<{ messages: ConversationMessage[] }>(
          `/api/chat/conversations/${activeThread.conversationId}/messages?afterId=${lastId}`,
          { background: true }
        );
        if(threadKey(activeThread)!==activeThreadKeyRef.current)return;
        if (res.messages.length > 0) {
          setMessages((prev) => {
            const map = new Map(prev.map((m) => [m.id, m]));
            for (const m of res.messages) map.set(m.id, m);
            return Array.from(map.values()).sort((a, b) => a.id - b.id);
          });
          if (nearBottom) {
            window.setTimeout(() => scrollToBottom(true), 20);
          } else {
            setShowNewMessagesJump(true);
          }
          void markThreadVisibleRead(res.messages, activeThread);
        }
      }
      onUnreadRefresh();
    } catch {
      // ignore background sync failures
    }
  }, [activeThread, markThreadVisibleRead, messages, nearBottom, onUnreadRefresh, scrollToBottom]);

  const refreshVisibleMessagesInPlace = useCallback(
    async (thread: ActiveThread) => {
      const count = Math.max(50, messages.length);
      try {
        if (thread.kind === 'channel') {
          const res = await apiRequest<{ messages: ChatMessage[] }>(
            `/api/chat/messages?channel=${thread.channel}&limit=${count}`,
            { background: true }
          );
          if(threadKey(thread)!==activeThreadKeyRef.current)return;
          setMessages((prev) => {
            const updatedMap = new Map(res.messages.map((m) => [m.id, m]));
            return prev.map((old) => updatedMap.get(old.id) ?? old);
          });
        } else {
          const res = await apiRequest<{ messages: ConversationMessage[] }>(
            `/api/chat/conversations/${thread.conversationId}/messages?limit=${count}`,
            { background: true }
          );
          if(threadKey(thread)!==activeThreadKeyRef.current)return;
          setMessages((prev) => {
            const updatedMap = new Map(res.messages.map((m) => [m.id, m]));
            return prev.map((old) => updatedMap.get(old.id) ?? old);
          });
        }
      } catch {
        // ignore transient errors
      }
    },
    [messages.length]
  );

  const handleWsEvent = useCallback(
    (ev: WsServerEvent) => {
      if (ev.type === 'session:revoked') {
        onForceLogout('تم إنهاء هذه الجلسة، سجل دخول من جديد');
        return;
      }
      if (ev.type === 'user:updated') {
        onUserRefresh();
        void loadHistoryStatus();
        void loadChatSettings();
        return;
      }
      if (ev.type === 'chat:lock_changed') {
        setChatLocked(Boolean(ev.locked));
        void loadChatSettings();
        return;
      }
      if (ev.type === 'chat:group_settings_updated') {
        void loadChatSettings();
        return;
      }
      if (ev.type === 'chat:channel_wiped') {
        if (
          activeThread.kind === 'channel' &&
          (ev.channel === 'all' || ev.channel === activeThread.channel)
        ) {
          setMessages([]);
          setSearchResults(null);
          setHasMore(false);
          onToast('تم تنفيذ المحو الكامل لرسائل المحادثة بواسطة المالك');
        }
        onUnreadRefresh();
        void loadChatSettings();
        return;
      }

      // Conversation list updates (DMs / custom groups created, renamed, member changes)
      if (ev.type === 'conv:list_updated') {
        void loadConversations(false);
        onUnreadRefresh();
        return;
      }

      // Encrypted DM & custom group message events
      if (
        ev.type === 'conv:message_created' ||
        ev.type === 'conv:message_updated' ||
        ev.type === 'conv:reaction_updated'
      ) {
        const convId = String(ev.conversationId || '');
        void loadConversations(false);
        onUnreadRefresh();

        if (activeThread.kind === 'conversation' && activeThread.conversationId === convId) {
          if (ev.type === 'conv:message_created') {
            if (
              userSettings.chatSoundsEnabled &&
              !activeConversation?.mutedNotifications &&
              ev.senderId !== user.id &&
              document.visibilityState === 'visible'
            ) {
              playChatPing();
            }
            void syncIncremental();
          } else {
            void refreshVisibleMessagesInPlace(activeThread);
          }
        } else if (ev.type === 'conv:message_created' && ev.senderId !== user.id) {
          const senderConv = conversations.find((c) => c.id === convId);
          if (
            userSettings.chatSoundsEnabled &&
            !senderConv?.mutedNotifications &&
            document.visibilityState === 'visible'
          ) {
            playChatPing();
          }
        }
        return;
      }

      if (ev.type === 'conv:message_removed') {
        const convId = String(ev.conversationId || '');
        const remId = Number(ev.messageId);
        void loadConversations(false);
        if (activeThread.kind === 'conversation' && activeThread.conversationId === convId) {
          setMessages((prev) => prev.filter((m) => m.id !== remId));
        }
        return;
      }

      if (ev.type === 'conv:receipt_updated') {
        const convId = String(ev.conversationId || '');
        if (activeThread.kind === 'conversation' && activeThread.conversationId === convId) {
          void refreshVisibleMessagesInPlace(activeThread);
        }
        void loadConversations(false);
        return;
      }

      if (ev.type === 'conv:typing_updated') {
        const convId = String(ev.conversationId || '');
        if (activeThread.kind === 'conversation' && activeThread.conversationId === convId) {
          const uId = String(ev.userId);
          const dName = String(ev.displayName || '');
          const active = Boolean(ev.active);
          setTypingUsers((prev) => {
            const without = prev.filter((t) => t.userId !== uId);
            return active ? [...without, { userId: uId, displayName: dName }] : without;
          });
        }
        return;
      }

      // Community channel events
      if (
        ev.type === 'typing:updated' &&
        activeThread.kind === 'channel' &&
        ev.channel === activeThread.channel
      ) {
        const uId = String(ev.userId);
        const dName = String(ev.displayName || '');
        const active = Boolean(ev.active);
        setTypingUsers((prev) => {
          const without = prev.filter((t) => t.userId !== uId);
          return active ? [...without, { userId: uId, displayName: dName }] : without;
        });
        return;
      }

      if (
        (ev.type === 'message:created' ||
          ev.type === 'message:updated' ||
          ev.type === 'reaction:updated') &&
        activeThread.kind === 'channel' &&
        ev.channel === activeThread.channel
      ) {
        if (ev.type === 'message:created') {
          if (userSettings.chatSoundsEnabled && document.visibilityState === 'visible') {
            playChatPing();
          }
          void syncIncremental();
        } else {
          void refreshVisibleMessagesInPlace(activeThread);
        }
        return;
      }

      if (
        ev.type === 'message:created' &&
        (activeThread.kind !== 'channel' || ev.channel !== activeThread.channel)
      ) {
        onUnreadRefresh();
      }

      if (
        ev.type === 'message:removed' &&
        activeThread.kind === 'channel' &&
        ev.channel === activeThread.channel
      ) {
        const remId = Number(ev.messageId);
        setMessages((prev) => prev.filter((m) => m.id !== remId));
        return;
      }

      if (ev.type === 'receipt:updated' && activeThread.kind === 'channel') {
        void refreshVisibleMessagesInPlace(activeThread);
      }
    },
    [
      activeConversation?.mutedNotifications,
      activeThread,
      conversations,
      loadChatSettings,
      loadConversations,
      loadHistoryStatus,
      onForceLogout,
      onToast,
      onUnreadRefresh,
      onUserRefresh,
      refreshVisibleMessagesInPlace,
      syncIncremental,
      user.id,
      userSettings.chatSoundsEnabled,
    ]
  );

  useUpdateBlocker(Boolean(draft.trim()||recording||sending));
  const { sendJson, connected } = useWebSocket(true, handleWsEvent);

  // Adaptive background polling fallback when tab is visible
  useEffect(() => {
    const intervalMs = 60_000;
    const id = window.setInterval(() => {
      if (!connected && document.visibilityState === 'visible') {
        void syncIncremental();
        void loadConversations(false);
      }
    }, intervalMs);
    return () => window.clearInterval(id);
  }, [connected,loadConversations, syncIncremental]);

  useEffect(()=>{const el=listRef.current;if(!el)return;const mark=()=>void markThreadVisibleRead(messages,activeThread);const id=window.setTimeout(mark,150);el.addEventListener('scroll',mark,{passive:true});return()=>{clearTimeout(id);el.removeEventListener('scroll',mark);};},[messages,activeThread,markThreadVisibleRead]);
  // Mark visible messages read when tab becomes visible again
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'visible' && messages.length > 0) {
        void markThreadVisibleRead(messages, activeThread);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [activeThread, markThreadVisibleRead, messages]);

  const selectChannelThread = (ch: ChannelId) => {
    setActiveThread({ kind: 'channel', channel: ch });
    setSearchResults(null);
    setSearchOpen(false);
    setSearchQuery('');
    setReplyTo(null);
    setEditingMsg(null);
    setMobilePane('chat');
  };

  const selectConversationThread = (convId: string) => {
    setActiveThread({ kind: 'conversation', conversationId: convId });
    setSearchResults(null);
    setSearchOpen(false);
    setSearchQuery('');
    setReplyTo(null);
    setEditingMsg(null);
    setMobilePane('chat');
  };

  const handleOpenOrStartDmWithUser = async (targetUserId: string) => {
    if (!targetUserId || targetUserId === user.id) return;
    try {
      const res = await apiRequest<{ conversation: ConversationSummary }>(
        '/api/chat/conversations/dm',
        {
          method: 'POST',
          body: { targetUserId },
        }
      );
      setConversations((prev) => {
        const rest = prev.filter((c) => c.id !== res.conversation.id);
        return [res.conversation, ...rest];
      });
      selectConversationThread(res.conversation.id);
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'تعذر فتح المحادثة الخاصة', true);
    }
  };

  const handleLoadOlder = async () => {
    if (messages.length === 0 || loadingMore) return;
    const container = listRef.current;
    const prevScrollHeight = container?.scrollHeight ?? 0;
    const prevScrollTop = container?.scrollTop ?? 0;

    setLoadingMore(true);
    try {
      const oldestId = messages[0].id;
      const endpoint =
        activeThread.kind === 'channel'
          ? `/api/chat/messages?channel=${activeThread.channel}&beforeId=${oldestId}&limit=50`
          : `/api/chat/conversations/${activeThread.conversationId}/messages?beforeId=${oldestId}&limit=50`;
      const res = await apiRequest<{ messages: AnyThreadMessage[]; hasMore: boolean }>(endpoint);
      setHasMore(res.hasMore);
      if (res.messages.length > 0) {
        setMessages((prev) => [...res.messages, ...prev]);
        window.requestAnimationFrame(() => {
          if (container) {
            const delta = container.scrollHeight - prevScrollHeight;
            container.scrollTop = prevScrollTop + delta;
          }
        });
      }
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'تعذر تحميل الرسائل الأقدم', true);
    } finally {
      setLoadingMore(false);
    }
  };

  const handleScroll = () => {
    const el = listRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const isNear = distanceFromBottom < 90;
    setNearBottom(isNear);
    if (isNear) {
      setShowNewMessagesJump(false);
    }
  };

  const emitTyping = (active: boolean) => {
    const now = Date.now();
    if (active && now - lastTypingSentRef.current < 2500) return;
    lastTypingSentRef.current = now;
    if (activeThread.kind === 'channel') {
      sendJson({ type: 'typing', channel: activeThread.channel, active });
    } else {
      sendJson({
        type: 'conv:typing',
        conversationId: activeThread.conversationId,
        active,
      });
    }
  };

  const handleSendTextOrEdit = async () => {
    const trimmed = draft.trim();
    if (!trimmed || sending) return;

    if (editingMsg) {
      setSending(true);
      try {
        const patchUrl =
          activeThread.kind === 'channel'
            ? `/api/chat/messages/${editingMsg.id}`
            : `/api/chat/conversations/messages/${editingMsg.id}`;
        await apiRequest(patchUrl, {
          method: 'PATCH',
          body: { body: trimmed },
        });
        setMessages((prev) =>
          prev.map((m) => (m.id === editingMsg.id ? { ...m, body: trimmed, editedAt: Date.now() } : m))
        );
        setEditingMsg(null);
        setDraft('');
        if (activeThread.kind === 'conversation') void loadConversations(false);
      } catch (err) {
        onToast(err instanceof ApiError ? err.message : 'تعذر تعديل الرسالة', true);
      } finally {
        setSending(false);
      }
      return;
    }

    if (!canSendInThread) return;
    const idemp =
      pendingIdempotencyRef.current ||
      `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    pendingIdempotencyRef.current = idemp;
    setSending(true);
    emitTyping(false);

    try {
      const postUrl =
        activeThread.kind === 'channel'
          ? '/api/chat/messages'
          : `/api/chat/conversations/${activeThread.conversationId}/messages`;
      const payload =
        activeThread.kind === 'channel'
          ? {
              channel: activeThread.channel,
              body: trimmed,
              replyToId: replyTo?.id ?? null,
              idempotencyKey: idemp,
            }
          : {
              body: trimmed,
              replyToId: replyTo?.id ?? null,
              idempotencyKey: idemp,
            };

      const res = await apiRequest<{ message: AnyThreadMessage }>(postUrl, {
        method: 'POST',
        body: payload,
      });
      pendingIdempotencyRef.current = null;
      setDraft('');
      setReplyTo(null);
      setShowEmojiPicker(false);
      setMessages((prev) =>
        prev.some((m) => m.id === res.message.id) ? prev : [...prev, res.message]
      );
      if (activeThread.kind === 'conversation') void loadConversations(false);
      if (userSettings.chatSoundsEnabled) playChatPing();
      window.setTimeout(() => scrollToBottom(true), 20);
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'تعذر إرسال الرسالة، حاول مجددًا', true);
    } finally {
      setSending(false);
    }
  };

  const handleSendSticker = async (emoji: string) => {
    if (!canSendInThread || sending) return;
    setSending(true);
    try {
      const postUrl =
        activeThread.kind === 'channel'
          ? '/api/chat/messages'
          : `/api/chat/conversations/${activeThread.conversationId}/messages`;
      const payload =
        activeThread.kind === 'channel'
          ? {
              channel: activeThread.channel,
              body: emoji,
              replyToId: replyTo?.id ?? null,
              idempotencyKey: `stk_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            }
          : {
              body: emoji,
              replyToId: replyTo?.id ?? null,
              idempotencyKey: `stk_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            };
      const res = await apiRequest<{ message: AnyThreadMessage }>(postUrl, {
        method: 'POST',
        body: payload,
      });
      setReplyTo(null);
      setShowEmojiPicker(false);
      setMessages((prev) =>
        prev.some((m) => m.id === res.message.id) ? prev : [...prev, res.message]
      );
      if (activeThread.kind === 'conversation') void loadConversations(false);
      if (userSettings.chatSoundsEnabled) playChatPing();
      window.setTimeout(() => scrollToBottom(true), 20);
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'تعذر الإرسال', true);
    } finally {
      setSending(false);
    }
  };

  const handleUploadAndSendFile = async (file: File, isImageMode: boolean) => {
    if (!canSendInThread || sending) return;
    if (!canSendMediaInThread) {
      onToast('إرسال الملفات والوسائط معطل حاليًا في إعدادات الجروب', true);
      return;
    }

    const lowerName = file.name.toLowerCase();
    const isPdfFile = file.type === 'application/pdf' || lowerName.endsWith('.pdf');
    const shouldResizeAsImage =
      !isPdfFile &&
      (file.type.startsWith('image/') ||
        (isImageMode && /\.(png|jpe?g|webp|gif)$/i.test(lowerName)));

    setSending(true);
    setUploadingFileName(file.name);
    try {
      let uploadBlob: Blob = file;
      let uploadName = file.name;
      if (shouldResizeAsImage) {
        const resized = await resizeImageForUpload(file, 1600, 0.85);
        uploadBlob = resized.blob;
        uploadName = resized.filename;
      }

      if (uploadBlob.size > MAX_CHAT_UPLOAD_BYTES) {
        onToast('حجم الملف يتجاوز الحد الأقصى المسموح به (٢٥ ميجابايت)', true);
        return;
      }

      const uploaded = await uploadAssetBinary(uploadBlob, uploadName, 'chat_file');
      const postUrl =
        activeThread.kind === 'channel'
          ? '/api/chat/messages'
          : `/api/chat/conversations/${activeThread.conversationId}/messages`;
      const payload =
        activeThread.kind === 'channel'
          ? {
              channel: activeThread.channel,
              body: draft.trim(),
              replyToId: replyTo?.id ?? null,
              fileAssetId: uploaded.assetId,
              idempotencyKey: `fil_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            }
          : {
              body: draft.trim(),
              replyToId: replyTo?.id ?? null,
              fileAssetId: uploaded.assetId,
              idempotencyKey: `fil_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            };

      const res = await apiRequest<{ message: AnyThreadMessage }>(postUrl, {
        method: 'POST',
        body: payload,
      });
      setDraft('');
      setReplyTo(null);
      setMessages((prev) =>
        prev.some((m) => m.id === res.message.id) ? prev : [...prev, res.message]
      );
      if (activeThread.kind === 'conversation') void loadConversations(false);
      if (userSettings.chatSoundsEnabled) playChatPing();
      window.setTimeout(() => scrollToBottom(true), 20);
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'تعذر رفع أو إرسال الملف', true);
    } finally {
      setUploadingFileName(null);
      setSending(false);
    }
  };

  const stopRecordingTracks = () => {
    mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
    mediaStreamRef.current = null;
    if (recordTimerRef.current !== null) {
      window.clearInterval(recordTimerRef.current);
      recordTimerRef.current = null;
    }
  };

  const startVoiceRecording = async () => {
    if (!canSendInThread || recording) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      onToast('المتصفح لا يدعم تسجيل الصوت مباشرة', true);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;
      recordChunksRef.current = [];
      recordCancelledRef.current = false;

      const mime = MediaRecorder.isTypeSupported('audio/webm')
        ? 'audio/webm'
        : MediaRecorder.isTypeSupported('audio/ogg')
        ? 'audio/ogg'
        : '';
      const recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (ev) => {
        if (ev.data.size > 0) recordChunksRef.current.push(ev.data);
      };

      recorder.onstop = async () => {
        stopRecordingTracks();
        setRecording(false);
        if (recordCancelledRef.current) return;

        const blob = new Blob(recordChunksRef.current, {
          type: recorder.mimeType || 'audio/webm',
        });
        if (blob.size === 0) return;
        if (blob.size > Math.min(12_000_000,MAX_CHAT_UPLOAD_BYTES)) {
          onToast('حجم التسجيل الصوتي يتجاوز ١٢ ميجابايت', true);
          return;
        }
        setSending(true);
        try {
          const ext = (recorder.mimeType || '').includes('ogg') ? '.ogg' : '.webm';
          const uploaded = await uploadAssetBinary(blob, `voice_${Date.now()}${ext}`, 'chat_audio');
          const postUrl =
            activeThread.kind === 'channel'
              ? '/api/chat/messages'
              : `/api/chat/conversations/${activeThread.conversationId}/messages`;
          const payload =
            activeThread.kind === 'channel'
              ? {
                  channel: activeThread.channel,
                  body: '',
                  replyToId: replyTo?.id ?? null,
                  audioAssetId: uploaded.assetId,
                  idempotencyKey: `aud_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                }
              : {
                  body: '',
                  replyToId: replyTo?.id ?? null,
                  audioAssetId: uploaded.assetId,
                  idempotencyKey: `aud_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                };
          const res = await apiRequest<{ message: AnyThreadMessage }>(postUrl, {
            method: 'POST',
            body: payload,
          });
          setReplyTo(null);
          setMessages((prev) =>
            prev.some((m) => m.id === res.message.id) ? prev : [...prev, res.message]
          );
          if (activeThread.kind === 'conversation') void loadConversations(false);
          window.setTimeout(() => scrollToBottom(true), 20);
        } catch (err) {
          onToast(err instanceof ApiError ? err.message : 'تعذر إرسال التسجيل الصوتي', true);
        } finally {
          setSending(false);
        }
      };

      recorder.start(250);
      setRecording(true);
      setRecordSeconds(0);
      recordTimerRef.current = window.setInterval(() => {
        setRecordSeconds((prev) => {
          const next = prev + 1;
          if (next >= MAX_VOICE_SECONDS) {
            onToast('تم بلوغ الحد الأقصى للتسجيل (١٥ دقيقة) وسيتم الإرسال الآن');
            mediaRecorderRef.current?.stop();
          }
          return next;
        });
      }, 1000);
    } catch {
      stopRecordingTracks();
      onToast('تم رفض إذن الميكروفون أو تعذر الوصول إليه', true);
    }
  };

  useEffect(() => {
    return () => {
      recordCancelledRef.current = true;
      if (mediaRecorderRef.current?.state === 'recording') {
        mediaRecorderRef.current.stop();
      }
      stopRecordingTracks();
    };
  }, []);

  const insertEmojiAtCaret = (emoji: string) => {
    const el = textareaRef.current;
    if (!el) {
      setDraft((prev) => prev + emoji);
      return;
    }
    const start = el.selectionStart ?? draft.length;
    const end = el.selectionEnd ?? draft.length;
    const next = draft.slice(0, start) + emoji + draft.slice(end);
    setDraft(next);
    window.requestAnimationFrame(() => {
      el.focus();
      const pos = start + emoji.length;
      el.setSelectionRange(pos, pos);
    });
  };

  const handleReact = async (msg: AnyThreadMessage, emoji: string) => {
    setActionMsg(null);
    if (!canReactInThread) {
      onToast('التفاعلات معطلة حاليًا في إعدادات الجروب', true);
      return;
    }
    try {
      const reactUrl =
        'conversationId' in msg
          ? `/api/chat/conversations/messages/${msg.id}/react`
          : `/api/chat/messages/${msg.id}/react`;
      await apiRequest(reactUrl, {
        method: 'POST',
        body: { emoji },
      });
      await refreshVisibleMessagesInPlace(activeThread);
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'تعذر تسجيل التفاعل', true);
    }
  };

  const handleToggleStar = async (msg: AnyThreadMessage) => {
    setActionMsg(null);
    const nextStarred = !msg.starredByMe;
    try {
      const starUrl =
        'conversationId' in msg
          ? `/api/chat/conversations/messages/${msg.id}/star`
          : `/api/chat/messages/${msg.id}/star`;
      await apiRequest(starUrl, {
        method: nextStarred ? 'POST' : 'DELETE',
      });
      setMessages((prev) =>
        prev.map((m) => (m.id === msg.id ? { ...m, starredByMe: nextStarred } : m))
      );
      onToast(nextStarred ? 'تم تمييز الرسالة بنجمة' : 'تمت إزالة النجمة عن الرسالة');
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'تعذر تحديث النجمة', true);
    }
  };

  const handleTogglePin = async (msg: AnyThreadMessage) => {
    setActionMsg(null);
    const isCurrentlyPinned = currentPinned?.id === msg.id;
    try {
      if (activeThread.kind === 'channel') {
        const res = isCurrentlyPinned
          ? await apiRequest<{ groupSettings: GroupChatSettings }>(
              `/api/chat/pins/${activeThread.channel}`,
              { method: 'DELETE' }
            )
          : await apiRequest<{ groupSettings: GroupChatSettings }>(
              `/api/chat/messages/${msg.id}/pin`,
              { method: 'POST' }
            );
        setGroupSettings(res.groupSettings);
      } else {
        if (isCurrentlyPinned) {
          await apiRequest(`/api/chat/conversations/${activeThread.conversationId}/pin`, {
            method: 'DELETE',
          });
        } else {
          await apiRequest(`/api/chat/conversations/${activeThread.conversationId}/pin`, {
            method: 'POST',
            body: { messageId: msg.id },
          });
        }
        await loadConversations(false);
      }
      onToast(isCurrentlyPinned ? 'تم إلغاء تثبيت الرسالة' : 'تم تثبيت الرسالة في أعلى المحادثة');
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'تعذر تحديث التثبيت', true);
    }
  };

  const handleUnpinThread = async () => {
    try {
      if (activeThread.kind === 'channel') {
        const res = await apiRequest<{ groupSettings: GroupChatSettings }>(
          `/api/chat/pins/${activeThread.channel}`,
          { method: 'DELETE' }
        );
        setGroupSettings(res.groupSettings);
      } else {
        await apiRequest(`/api/chat/conversations/${activeThread.conversationId}/pin`, {
          method: 'DELETE',
        });
        await loadConversations(false);
      }
      onToast('تم إلغاء تثبيت الرسالة');
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'تعذر إلغاء التثبيت', true);
    }
  };

  const jumpToPinnedMessage = () => {
    if (!currentPinned) return;
    const el = document.getElementById(`chat-msg-${currentPinned.id}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setHighlightedMessageId(currentPinned.id);
      window.setTimeout(() => setHighlightedMessageId(null), 1800);
    } else {
      onToast(`الرسالة المثبتة (${currentPinned.senderName}): ${currentPinned.excerpt}`);
    }
  };

  const handleHideForMe = async (msg: AnyThreadMessage) => {
    setActionMsg(null);
    try {
      const hideUrl =
        'conversationId' in msg
          ? `/api/chat/conversations/messages/${msg.id}/hide`
          : `/api/chat/messages/${msg.id}/hide`;
      await apiRequest(hideUrl, { method: 'POST' });
      setMessages((prev) => prev.filter((m) => m.id !== msg.id));
      if ('conversationId' in msg) void loadConversations(false);
      onToast('تم إخفاء الرسالة من عندك فقط');
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'تعذر إخفاء الرسالة', true);
    }
  };

  const handleDeleteForEveryone = async () => {
    if (!deleteAllTarget) return;
    setActionBusy(true);
    try {
      const delUrl =
        'conversationId' in deleteAllTarget
          ? `/api/chat/conversations/messages/${deleteAllTarget.id}`
          : `/api/chat/messages/${deleteAllTarget.id}`;
      await apiRequest(delUrl, { method: 'DELETE' });
      setMessages((prev) =>
        prev.map((m) =>
          m.id === deleteAllTarget.id
            ? {
                ...m,
                body: '',
                audioAttachment: null,
                fileAttachment: null,
                reactions: [],
                starredByMe: false,
                deletedAt: Date.now(),
              }
            : m
        )
      );
      setDeleteAllTarget(null);
      if ('conversationId' in deleteAllTarget) void loadConversations(false);
      else void loadChatSettings();
      onToast('تم حذف الرسالة عند الجميع');
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'تعذر حذف الرسالة', true);
    } finally {
      setActionBusy(false);
    }
  };

  const handleOwnerPurge = async () => {
    if (!purgeTarget) return;
    setActionBusy(true);
    try {
      await apiRequest(`/api/chat/messages/${purgeTarget.id}/purge`, { method: 'DELETE' });
      setMessages((prev) => prev.filter((m) => m.id !== purgeTarget.id));
      setPurgeTarget(null);
      void loadChatSettings();
      onToast('تم المحو الكامل للرسالة من المحادثة وقاعدة البيانات');
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'تعذر إزالة الرسالة', true);
    } finally {
      setActionBusy(false);
    }
  };

  const handleOpenMessageInfo = async (msg: AnyThreadMessage) => {
    setActionMsg(null);
    setInfoTarget(msg);
    setInfoLoading(true);
    setInfoReceipts(null);
    try {
      const infoUrl =
        'conversationId' in msg
          ? `/api/chat/conversations/messages/${msg.id}/info`
          : `/api/chat/messages/${msg.id}/info`;
      const res = await apiRequest<{ receipts: MessageReceiptDetail[] }>(infoUrl);
      setInfoReceipts(res.receipts);
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'تعذر تحميل تفاصيل القراءة', true);
      setInfoTarget(null);
    } finally {
      setInfoLoading(false);
    }
  };

  const handleToggleLock = async () => {
    try {
      const res = await apiRequest<{ chatLocked: boolean }>('/api/chat/lock', {
        method: 'POST',
        body: { locked: !chatLocked },
      });
      setChatLocked(res.chatLocked);
      setGroupSettings((prev) => ({ ...prev, chatLocked: res.chatLocked }));
      onToast(res.chatLocked ? 'تم قفل المحادثة على الأعضاء' : 'تم فتح المحادثة للجميع');
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'تعذر تغيير حالة المحادثة', true);
    }
  };

  const handleUpdateUserSettings = async (patch: Partial<UserChatSettings>) => {
    const optimistic = { ...userSettings, ...patch };
    setUserSettings(optimistic);
    try {
      const res = await apiRequest<{ userSettings: UserChatSettings }>('/api/chat/settings/me', {
        method: 'PUT',
        body: patch,
      });
      setUserSettings(res.userSettings);
      if (patch.readReceiptsEnabled !== undefined) {
        void loadActiveThread(activeThread, false);
      }
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'تعذر حفظ إعدادات المحادثة', true);
      void loadChatSettings();
    }
  };

  const handleUpdateGroupSettings = async (
    patch: Partial<{
      groupName: string;
      groupDescription: string;
      groupRules: string;
      chatLocked: boolean;
      editInfoPolicy: 'mods' | 'owner';
      allowMedia: boolean;
      allowReactions: boolean;
      disappearingHours: DisappearingHours;
    }>
  ) => {
    setSavingGroupSettings(true);
    try {
      const res = await apiRequest<{ groupSettings: GroupChatSettings }>(
        '/api/chat/settings/group',
        { method: 'PATCH', body: patch }
      );
      setGroupSettings(res.groupSettings);
      setChatLocked(res.groupSettings.chatLocked);
      if (patch.disappearingHours !== undefined && activeThread.kind === 'channel') {
        void loadActiveThread(activeThread, false);
      }
      onToast('تم تحديث إعدادات الجروب');
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'تعذر تحديث إعدادات الجروب', true);
    } finally {
      setSavingGroupSettings(false);
    }
  };

  const handleClearChannelForMe = async () => {
    if (activeThread.kind !== 'channel') return;
    setActionBusy(true);
    try {
      await apiRequest(`/api/chat/channels/${activeThread.channel}/clear-for-me`, {
        method: 'POST',
      });
      setMessages([]);
      setSearchResults(null);
      setClearChannelConfirmOpen(false);
      setChatSettingsOpen(false);
      onUnreadRefresh();
      onToast('تم مسح رسائل هذه القناة من شاشتك فقط');
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'تعذر مسح المحادثة', true);
    } finally {
      setActionBusy(false);
    }
  };

  const handleExportTxt = async (targetConvId?: string) => {
    try {
      const exportUrl = targetConvId
        ? `/api/chat/conversations/${targetConvId}/export`
        : activeThread.kind === 'conversation'
        ? `/api/chat/conversations/${activeThread.conversationId}/export`
        : `/api/chat/channels/${activeThread.channel}/export`;
      const res = await apiRequest<{ filename: string; text: string }>(exportUrl);
      const blob = new Blob(['\uFEFF' + res.text], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = res.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      onToast('تم تصدير سجل المحادثة بصيغة نصية');
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'تعذر تصدير المحادثة', true);
    }
  };

  const handleToggleConvMute = async (conv: ConversationSummary) => {
    setConvMenuOpen(false);
    try {
      const nextMuted = !conv.mutedNotifications;
      await apiRequest(`/api/chat/conversations/${conv.id}/mute`, {
        method: 'POST',
        body: { muted: nextMuted },
      });
      setConversations((prev) =>
        prev.map((c) => (c.id === conv.id ? { ...c, mutedNotifications: nextMuted } : c))
      );
      onToast(nextMuted ? 'تم كتم إشعارات المحادثة' : 'تم تفعيل إشعارات المحادثة');
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'تعذر تحديث الإشعارات', true);
    }
  };

  const handleExecuteCompleteWipe = async () => {
    if (!wipeMode || wipeConfirmText.trim() !== 'محو') return;
    const ch = activeChannelId ?? 'general';
    setWipeBusy(true);
    try {
      if (wipeMode === 'channel') {
        await apiRequest(`/api/chat/channels/${ch}/wipe`, { method: 'POST' });
        onToast('تم المحو الكامل لرسائل القناة الحالية من القاعدة لدى الجميع');
      } else {
        await apiRequest('/api/chat/wipe-all', { method: 'POST' });
        onToast('تم المحو الكامل لجميع قنوات المجتمع من القاعدة لدى الجميع');
      }
      if (activeThread.kind === 'channel') {
        setMessages([]);
        setSearchResults(null);
      }
      setWipeMode(null);
      setWipeConfirmText('');
      setGroupSettingsOpen(false);
      onUnreadRefresh();
      void loadChatSettings();
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'تعذر تنفيذ المحو الكامل', true);
    } finally {
      setWipeBusy(false);
    }
  };

  const handleSearchSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchQuery.trim()) return;
    setSearching(true);
    try {
      const url =
        activeThread.kind === 'channel'
          ? `/api/chat/search?channel=${activeThread.channel}&q=${encodeURIComponent(searchQuery.trim())}`
          : `/api/chat/conversations/${activeThread.conversationId}/search?q=${encodeURIComponent(
              searchQuery.trim()
            )}`;
      const res = await apiRequest<{ messages: AnyThreadMessage[] }>(url);
      setSearchResults(res.messages);
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'تعذر البحث', true);
    } finally {
      setSearching(false);
    }
  };

  const handleRequestHistory = async () => {
    setHistoryBusy(true);
    try {
      const res = await apiRequest<{ request: HistoryRequestRecord }>(
        '/api/members/history-request',
        { method: 'POST' }
      );
      setHistoryState({ historyGranted: false, request: res.request });
      onToast('تم إرسال طلب الوصول للرسائل القديمة إلى المشرف');
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'تعذر إرسال الطلب', true);
    } finally {
      setHistoryBusy(false);
    }
  };

  const renderReceiptIcon = (status: AnyThreadMessage['receiptStatus']) => {
    if (!status) return null;
    if (status === 'read') {
      return (
        <span aria-label="مقروءة" title="مقروءة" className="text-[var(--accent-hi)] inline-flex">
          <Icons.CheckCheck className="w-3.5 h-3.5" />
        </span>
      );
    }
    if (status === 'delivered') {
      return (
        <span aria-label="تم التسليم" title="تم التسليم" className="text-[var(--text-secondary)] inline-flex">
          <Icons.CheckCheck className="w-3.5 h-3.5" />
        </span>
      );
    }
    return (
      <span aria-label="تم الإرسال" title="تم الإرسال" className="text-[var(--text-secondary)] inline-flex">
        <Icons.Check className="w-3.5 h-3.5" />
      </span>
    );
  };

  // Filtered Sidebar List Items (Encrypted DMs/Groups + Community Channels)
  const searchTerm = listSearch.trim().toLowerCase();
  const filteredConversations = useMemo(() => {
    return conversations.filter((c) => {
      if (listFilter === 'community') return false;
      if (listFilter === 'dm' && c.kind !== 'dm') return false;
      if (listFilter === 'group' && c.kind !== 'group') return false;
      if (listFilter === 'unread' && c.unreadCount === 0) return false;
      if (!searchTerm) return true;
      return (
        c.title.toLowerCase().includes(searchTerm) ||
        (c.peer?.username.toLowerCase().includes(searchTerm) ?? false) ||
        c.lastMessagePreview.toLowerCase().includes(searchTerm)
      );
    });
  }, [conversations, listFilter, searchTerm]);

  const filteredChannels = useMemo(() => {
    return CHANNELS.filter((ch) => {
      if (listFilter === 'dm' || listFilter === 'group') return false;
      if (listFilter === 'unread' && (unreadByChannel[ch.id] || 0) === 0) return false;
      if (!searchTerm) return true;
      return (
        ch.label.toLowerCase().includes(searchTerm) ||
        ch.description.toLowerCase().includes(searchTerm)
      );
    });
  }, [listFilter, searchTerm, unreadByChannel]);

  const totalDmUnread = useMemo(
    () => conversations.reduce((sum, c) => sum + (c.unreadCount || 0), 0),
    [conversations]
  );

  return (
    <div className="grid grid-cols-1 md:grid-cols-[330px_minmax(0,1fr)] lg:grid-cols-[350px_minmax(0,1fr)] h-full min-h-0 rahhala-card overflow-hidden">
      {/* Unified WhatsApp-Style Chats List Sidebar (Full-width on mobile when mobilePane==='list') */}
      <aside
        aria-label="قائمة الدردشات والقنوات"
        className={`${
          mobilePane === 'list' ? 'flex' : 'hidden md:flex'
        } flex-col border-e border-[var(--divider)] bg-[var(--bg-surface)]/45 min-h-0`}
      >
        {/* Top WhatsApp Inbox Header */}
        <div className="p-3 border-b border-[var(--divider)] bg-[var(--bg-card)]/90 space-y-2.5 shrink-0">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2.5 min-w-0">
              <Avatar name={user.displayName} assetId={user.avatarAssetId} size="sm" />
              <div className="min-w-0">
                <h2 className="text-sm font-extrabold text-[var(--text-primary)] truncate">
                  الدردشات
                </h2>
                <div className="text-[11px] text-[var(--success)] font-semibold flex items-center gap-1">
                  <Icons.Lock className="w-3 h-3 shrink-0" />
                  <span className="truncate">رسائل مشفرة وآمنة</span>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-1 shrink-0">
              <button
                type="button"
                onClick={() => setNewDmOpen(true)}
                title="محادثة خاصة جديدة"
                aria-label="محادثة خاصة جديدة"
                className="min-h-[38px] px-2.5 rounded-xl bg-[var(--accent)] text-[var(--accent-fg)] text-xs font-bold flex items-center gap-1 whitespace-nowrap hover:bg-[var(--accent-hi)]"
              >
                <Icons.Plus className="w-3.5 h-3.5" />
                <span>خاصة</span>
              </button>

              <button
                type="button"
                onClick={() => setNewGroupOpen(true)}
                title="إنشاء مجموعة جديدة"
                aria-label="إنشاء مجموعة جديدة"
                className="min-h-[38px] px-2.5 rounded-xl bg-[var(--bg-surface)] border border-[var(--divider)] text-[var(--text-primary)] text-xs font-bold flex items-center gap-1 whitespace-nowrap hover:border-[var(--accent)]"
              >
                <Icons.Users className="w-3.5 h-3.5 text-[var(--accent)]" />
                <span>مجموعة</span>
              </button>
            </div>
          </div>

          {/* Search box */}
          <div className="relative">
            <input
              type="search"
              value={listSearch}
              onChange={(e) => setListSearch(e.target.value)}
              placeholder="ابحث في الدردشات أو ابدأ محادثة…"
              className="rahhala-input w-full pe-9 ps-3 py-2 text-xs"
            />
            <span className="absolute end-3 top-1/2 -translate-y-1/2 text-[var(--text-secondary)] pointer-events-none">
              <Icons.Search className="w-3.5 h-3.5" />
            </span>
          </div>

          {/* WhatsApp-style Filter Bar */}
          <div className="flex items-center gap-1 overflow-x-auto pb-0.5">
            {(
              [
                { id: 'all', label: 'الكل' },
                { id: 'unread', label: 'غير مقروء' },
                { id: 'dm', label: 'خاص' },
                { id: 'group', label: 'مجموعات' },
                { id: 'community', label: 'المجتمع' },
              ] as Array<{ id: ChatListFilter; label: string }>
            ).map((f) => {
              const active = listFilter === f.id;
              return (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setListFilter(f.id)}
                  className={`min-h-[32px] px-2.5 rounded-lg text-[11px] font-bold whitespace-nowrap shrink-0 transition-colors ${
                    active
                      ? 'bg-[var(--accent-soft)] text-[var(--accent)] border border-[var(--accent)]/35'
                      : 'bg-[var(--bg-surface)] text-[var(--text-secondary)] border border-transparent hover:text-[var(--text-primary)]'
                  }`}
                >
                  {f.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Chats & Channels List Body */}
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {/* Private DMs & Custom Encrypted Groups */}
          {(listFilter !== 'community') && (
            <>
              <div className="px-2 py-1 flex items-center justify-between text-[11px] font-bold text-[var(--text-secondary)]">
                <span>المحادثات الخاصة والمجموعات</span>
                {totalDmUnread > 0 && (
                  <span className="text-[var(--accent)] tabular-nums">{totalDmUnread} غير مقروء</span>
                )}
              </div>

              {conversationsLoading && conversations.length === 0 ? (
                <div className="px-3 py-4 text-xs text-[var(--text-secondary)]">
                  جاري تحميل المحادثات…
                </div>
              ) : filteredConversations.length === 0 ? (
                <div className="p-3 rounded-xl bg-[var(--bg-card)]/50 border border-[var(--divider)] text-center space-y-2 mb-2">
                  <p className="text-xs text-[var(--text-secondary)]">
                    {conversations.length === 0
                      ? 'لا توجد محادثات خاصة أو مجموعات بعد.'
                      : 'لا توجد محادثات مطابقة للتصفية.'}
                  </p>
                  {conversations.length === 0 && (
                    <div className="flex items-center justify-center gap-2">
                      <button
                        type="button"
                        onClick={() => setNewDmOpen(true)}
                        className="min-h-[34px] px-3 rounded-lg bg-[var(--accent)] text-[var(--accent-fg)] text-[11px] font-bold"
                      >
                        ابدأ محادثة خاصة
                      </button>
                      <button
                        type="button"
                        onClick={() => setNewGroupOpen(true)}
                        className="min-h-[34px] px-3 rounded-lg bg-[var(--bg-surface)] border border-[var(--divider)] text-[var(--text-primary)] text-[11px] font-bold"
                      >
                        إنشاء مجموعة
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                filteredConversations.map((conv) => {
                  const isActive =
                    activeThread.kind === 'conversation' &&
                    activeThread.conversationId === conv.id;
                  return (
                    <button
                      key={conv.id}
                      type="button"
                      onClick={() => selectConversationThread(conv.id)}
                      className={`w-full p-2.5 rounded-xl text-right flex items-center gap-2.5 transition-colors ${
                        isActive
                          ? 'bg-[var(--accent-soft)] border border-[var(--accent)]/35'
                          : 'hover:bg-[var(--bg-card)]/75 border border-transparent'
                      }`}
                    >
                      {conv.kind === 'group' ? (
                        <div className="w-10 h-10 rounded-full bg-[var(--accent-soft)] text-[var(--accent)] border border-[var(--accent)]/30 flex items-center justify-center shrink-0">
                          <Icons.Users className="w-4 h-4" />
                        </div>
                      ) : (
                        <Avatar
                          name={conv.peer?.displayName || conv.title}
                          assetId={conv.peer?.avatarAssetId}
                          size="md"
                        />
                      )}

                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-1 min-w-0">
                            <span
                              className={`text-sm font-bold truncate ${
                                isActive ? 'text-[var(--accent)]' : 'text-[var(--text-primary)]'
                              }`}
                            >
                              {conv.title}
                            </span>
                            <Icons.Lock
                              className="w-3 h-3 text-[var(--success)] shrink-0"
                              aria-hidden="true"
                            />
                          </div>
                          <span className="text-[11px] text-[var(--text-secondary)] tabular-nums shrink-0">
                            {formatSidebarTime(conv.lastMessageAt)}
                          </span>
                        </div>

                        <div className="flex items-center justify-between gap-2 mt-0.5">
                          <div className="flex items-center gap-1 min-w-0 text-xs text-[var(--text-secondary)]">
                            {conv.lastMessageIsMine &&
                              renderReceiptIcon(conv.lastMessageReceiptStatus)}
                            <span className="truncate">
                              {conv.kind === 'group' &&
                              conv.lastMessageSenderName &&
                              !conv.lastMessageIsMine
                                ? `${conv.lastMessageSenderName}: ${conv.lastMessagePreview}`
                                : conv.lastMessagePreview}
                            </span>
                          </div>
                          <div className="flex items-center gap-1 shrink-0">
                            {conv.mutedNotifications && (
                              <Icons.VolumeX className="w-3.5 h-3.5 text-[var(--text-secondary)]" />
                            )}
                            {conv.unreadCount > 0 && (
                              <span className="min-w-[20px] h-5 px-1.5 rounded-full bg-[var(--accent)] text-[var(--accent-fg)] text-[11px] font-extrabold flex items-center justify-center tabular-nums">
                                {conv.unreadCount}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    </button>
                  );
                })
              )}
            </>
          )}

          {/* Community Public Channels */}
          {filteredChannels.length > 0 && (
            <>
              <div className="px-2 pt-2 pb-1 flex items-center justify-between text-[11px] font-bold text-[var(--text-secondary)]">
                <span>{groupSettings.groupName}</span>
                <button
                  type="button"
                  onClick={() => {
                    setGroupNameDraft(groupSettings.groupName);
                    setGroupDescDraft(groupSettings.groupDescription);
                    setGroupRulesDraft(groupSettings.groupRules);
                    setGroupSettingsOpen(true);
                  }}
                  className="text-[var(--accent)] hover:underline"
                >
                  إعدادات المجتمع
                </button>
              </div>
              {filteredChannels.map((ch) => {
                const active =
                  activeThread.kind === 'channel' && activeThread.channel === ch.id;
                const unread = unreadByChannel[ch.id] || 0;
                return (
                  <button
                    key={ch.id}
                    type="button"
                    onClick={() => selectChannelThread(ch.id)}
                    className={`w-full p-2.5 rounded-xl text-right flex items-center justify-between gap-2.5 transition-colors ${
                      active
                        ? 'bg-[var(--accent-soft)] border border-[var(--accent)]/35'
                        : 'hover:bg-[var(--bg-card)]/75 border border-transparent'
                    }`}
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <div
                        className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 border ${
                          active
                            ? 'bg-[var(--accent)] text-[var(--accent-fg)] border-[var(--accent)]'
                            : 'bg-[var(--bg-card)] text-[var(--accent)] border-[var(--divider)]'
                        }`}
                      >
                        <Icons.MessageSquare className="w-4 h-4" />
                      </div>
                      <div className="min-w-0">
                        <div
                          className={`text-sm font-bold truncate ${
                            active ? 'text-[var(--accent)]' : 'text-[var(--text-primary)]'
                          }`}
                        >
                          {ch.label}
                        </div>
                        <div className="text-xs text-[var(--text-secondary)] truncate">
                          {ch.description}
                        </div>
                      </div>
                    </div>
                    {unread > 0 && (
                      <span className="min-w-[20px] h-5 px-1.5 rounded-full bg-[var(--accent)] text-[var(--accent-fg)] text-[11px] font-extrabold flex items-center justify-center tabular-nums shrink-0">
                        {unread}
                      </span>
                    )}
                  </button>
                );
              })}
            </>
          )}
        </div>

        {/* Sidebar Footer Quick Tools */}
        <div className="p-2 border-t border-[var(--divider)] bg-[var(--bg-card)]/80 grid grid-cols-3 gap-1 shrink-0">
          <button
            type="button"
            onClick={() => {
              setChatSettingsTab('starred');
              void loadStarredMessages();
              setChatSettingsOpen(true);
            }}
            className="min-h-[38px] px-2 rounded-xl hover:bg-[var(--bg-surface)] text-[11px] font-bold text-[var(--text-primary)] flex items-center justify-center gap-1 whitespace-nowrap"
          >
            <Icons.Star className="w-3.5 h-3.5 text-[var(--accent)] shrink-0" />
            <span>المميزة</span>
          </button>
          <button
            type="button"
            onClick={onOpenMembersAndMedia}
            className="min-h-[38px] px-2 rounded-xl hover:bg-[var(--bg-surface)] text-[11px] font-bold text-[var(--text-primary)] flex items-center justify-center gap-1 whitespace-nowrap"
          >
            <Icons.Users className="w-3.5 h-3.5 text-[var(--accent)] shrink-0" />
            <span>الأعضاء</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setChatSettingsTab('prefs');
              setChatSettingsOpen(true);
            }}
            className="min-h-[38px] px-2 rounded-xl hover:bg-[var(--bg-surface)] text-[11px] font-bold text-[var(--text-primary)] flex items-center justify-center gap-1 whitespace-nowrap"
          >
            <Icons.Sliders className="w-3.5 h-3.5 text-[var(--accent)] shrink-0" />
            <span>الإعدادات</span>
          </button>
        </div>
      </aside>

      {/* Active Chat Column (Full-width on mobile when mobilePane==='chat') */}
      <div
        className={`${
          mobilePane === 'chat' ? 'flex' : 'hidden md:flex'
        } flex-col min-h-0 min-w-0`}
      >
        {/* Active Chat Header */}
        <div className="shrink-0 border-b border-[var(--divider)] bg-[var(--bg-card)] px-3 sm:px-4 py-2.5 space-y-2.5 relative">
          <div className="flex items-center justify-between gap-2">
            {/* Right Side: Back Button (mobile) + Avatar/Title/Status */}
            <div className="flex items-center gap-2 min-w-0 flex-1">
              <button
                type="button"
                onClick={() => setMobilePane('list')}
                aria-label="العودة لقائمة الدردشات"
                className="md:hidden min-h-[40px] min-w-[40px] rounded-xl bg-[var(--bg-surface)] border border-[var(--divider)] text-[var(--text-primary)] flex items-center justify-center shrink-0"
              >
                <Icons.ArrowRight className="w-4 h-4" />
              </button>

              {activeThread.kind === 'conversation' && activeConversation ? (
                <button
                  type="button"
                  onClick={() => setCustomConvInfoOpen(true)}
                  className="flex items-center gap-2.5 min-w-0 text-right group"
                >
                  {activeConversation.kind === 'group' ? (
                    <div className="w-10 h-10 rounded-full bg-[var(--accent-soft)] text-[var(--accent)] border border-[var(--accent)]/30 flex items-center justify-center shrink-0">
                      <Icons.Users className="w-5 h-5" />
                    </div>
                  ) : (
                    <Avatar
                      name={activeConversation.peer?.displayName || activeConversation.title}
                      assetId={activeConversation.peer?.avatarAssetId}
                      size="md"
                    />
                  )}
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <h2 className="text-sm font-extrabold text-[var(--text-primary)] truncate group-hover:text-[var(--accent)] transition-colors">
                        {activeConversation.title}
                      </h2>
                      <Icons.Lock className="w-3.5 h-3.5 text-[var(--success)] shrink-0" />
                    </div>
                    <div className="text-xs text-[var(--text-secondary)] truncate flex items-center gap-1.5">
                      {typingUsers.length > 0 ? (
                        <span className="text-[var(--accent)] font-bold">
                          {typingUsers.map((t) => t.displayName).join('، ')} يكتب الآن…
                        </span>
                      ) : activeConversation.kind === 'dm' ? (
                        <span>
                          محادثة مشفرة · اضغط لمعلومات الطرف الآخر
                        </span>
                      ) : (
                        <span className="tabular-nums">
                          {activeConversation.memberCount} أعضاء · اضغط لإدارة المجموعة
                        </span>
                      )}
                      {activeConversation.disappearingHours > 0 && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="text-[var(--accent)] font-semibold">
                            اختفاء (
                            {
                              DISAPPEARING_OPTIONS.find(
                                (d) => d.hours === activeConversation.disappearingHours
                              )?.label
                            }
                            )
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setGroupNameDraft(groupSettings.groupName);
                    setGroupDescDraft(groupSettings.groupDescription);
                    setGroupRulesDraft(groupSettings.groupRules);
                    setGroupSettingsOpen(true);
                  }}
                  className="flex items-center gap-2.5 min-w-0 text-right group"
                >
                  <div className="w-10 h-10 rounded-full bg-[var(--accent-soft)] text-[var(--accent)] border border-[var(--accent)]/30 flex items-center justify-center shrink-0">
                    <Icons.MessageSquare className="w-5 h-5" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <h2 className="text-sm font-extrabold text-[var(--text-primary)] truncate group-hover:text-[var(--accent)] transition-colors">
                        {CHANNELS.find((c) => c.id === activeChannelId)?.label} —{' '}
                        {groupSettings.groupName}
                      </h2>
                    </div>
                    <div className="text-xs text-[var(--text-secondary)] truncate">
                      {typingUsers.length > 0 ? (
                        <span className="text-[var(--accent)] font-bold">
                          {typingUsers.map((t) => t.displayName).join('، ')} يكتب الآن…
                        </span>
                      ) : (
                        CHANNELS.find((c) => c.id === activeChannelId)?.description
                      )}
                    </div>
                  </div>
                </button>
              )}
            </div>

            {/* Left Side Action Buttons */}
            <div className="flex items-center gap-1.5 shrink-0">
              {activeThread.kind === 'conversation' && activeConversation ? (
                <>
                  <button
                    type="button"
                    onClick={() => setEncryptionModalOpen(true)}
                    aria-label="التحقق من التشفير"
                    title="معلومات تشفير التخزين"
                    className="min-h-[40px] px-2.5 rounded-xl bg-[var(--success-soft)] border border-[var(--success)]/30 text-[var(--success)] text-xs font-bold flex items-center gap-1.5 whitespace-nowrap"
                  >
                    <Icons.ShieldCheck className="w-4 h-4 shrink-0" />
                    <span className="hidden lg:inline">تشفير موثق</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setSearchOpen((v) => !v);
                      setSearchResults(null);
                    }}
                    aria-label="بحث في المحادثة"
                    className="min-h-[40px] min-w-[40px] rounded-xl bg-[var(--bg-surface)] border border-[var(--divider)] text-[var(--text-primary)] flex items-center justify-center hover:border-[var(--accent)]"
                  >
                    <Icons.Search className="w-4 h-4" />
                  </button>

                  <button
                    type="button"
                    onClick={() => setConvMenuOpen((v) => !v)}
                    aria-label="خيارات المحادثة"
                    className="min-h-[40px] min-w-[40px] rounded-xl bg-[var(--bg-surface)] border border-[var(--divider)] text-[var(--text-primary)] flex items-center justify-center hover:border-[var(--accent)]"
                  >
                    <Icons.MoreVertical className="w-4 h-4" />
                  </button>
                </>
              ) : (
                <>
                  {isAdminOrOwner && (
                    <button
                      type="button"
                      onClick={handleToggleLock}
                      className={`min-h-[40px] px-2.5 sm:px-3 rounded-xl border text-xs font-bold flex items-center gap-1.5 whitespace-nowrap ${
                        chatLocked
                          ? 'bg-[var(--error-soft)] border-[var(--error)]/40 text-[var(--error)]'
                          : 'bg-[var(--bg-surface)] border-[var(--divider)] text-[var(--text-primary)]'
                      }`}
                    >
                      {chatLocked ? (
                        <Icons.Lock className="w-3.5 h-3.5" />
                      ) : (
                        <Icons.Unlock className="w-3.5 h-3.5" />
                      )}
                      <span className="hidden sm:inline">
                        {chatLocked ? 'المحادثة مقفولة' : 'المحادثة مفتوحة'}
                      </span>
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={() => {
                      setSearchOpen((v) => !v);
                      setSearchResults(null);
                    }}
                    aria-label="بحث في المحادثة"
                    className="min-h-[40px] min-w-[40px] rounded-xl bg-[var(--bg-surface)] border border-[var(--divider)] text-[var(--text-primary)] flex items-center justify-center hover:border-[var(--accent)]"
                  >
                    <Icons.Search className="w-4 h-4" />
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setGroupNameDraft(groupSettings.groupName);
                      setGroupDescDraft(groupSettings.groupDescription);
                      setGroupRulesDraft(groupSettings.groupRules);
                      setGroupSettingsOpen(true);
                    }}
                    aria-label="إعدادات الجروب"
                    className="min-h-[40px] min-w-[40px] sm:px-3 rounded-xl bg-[var(--bg-surface)] border border-[var(--divider)] text-[var(--text-primary)] text-xs font-bold flex items-center justify-center gap-1.5 hover:border-[var(--accent)] whitespace-nowrap"
                  >
                    <Icons.Settings className="w-4 h-4 text-[var(--accent)]" />
                    <span className="hidden lg:inline">إعدادات الجروب</span>
                  </button>
                </>
              )}
            </div>
          </div>

          {/* Conversation Options Dropdown Menu */}
          {convMenuOpen && activeThread.kind === 'conversation' && activeConversation && (
            <div className="absolute end-3 top-14 z-30 w-56 rounded-2xl bg-[var(--bg-elevated)] border border-[var(--divider)] shadow-xl p-1.5 space-y-1">
              <button
                type="button"
                onClick={() => {
                  setConvMenuOpen(false);
                  setCustomConvInfoOpen(true);
                }}
                className="w-full min-h-[40px] px-3 rounded-xl hover:bg-[var(--bg-surface)] text-xs font-bold text-[var(--text-primary)] flex items-center gap-2 text-right"
              >
                <Icons.Info className="w-4 h-4 text-[var(--accent)]" />
                <span>
                  {activeConversation.kind === 'group' ? 'معلومات المجموعة والأعضاء' : 'معلومات المحادثة'}
                </span>
              </button>

              <button
                type="button"
                onClick={() => {
                  setConvMenuOpen(false);
                  setEncryptionModalOpen(true);
                }}
                className="w-full min-h-[40px] px-3 rounded-xl hover:bg-[var(--bg-surface)] text-xs font-bold text-[var(--text-primary)] flex items-center gap-2 text-right"
              >
                <Icons.ShieldCheck className="w-4 h-4 text-[var(--success)]" />
                <span>التحقق من التشفير</span>
              </button>

              <button
                type="button"
                onClick={() => void handleToggleConvMute(activeConversation)}
                className="w-full min-h-[40px] px-3 rounded-xl hover:bg-[var(--bg-surface)] text-xs font-bold text-[var(--text-primary)] flex items-center gap-2 text-right"
              >
                {activeConversation.mutedNotifications ? (
                  <>
                    <Icons.Bell className="w-4 h-4 text-[var(--accent)]" />
                    <span>تفعيل الإشعارات</span>
                  </>
                ) : (
                  <>
                    <Icons.VolumeX className="w-4 h-4 text-[var(--text-secondary)]" />
                    <span>كتم الإشعارات</span>
                  </>
                )}
              </button>

              <button
                type="button"
                onClick={() => {
                  setConvMenuOpen(false);
                  void handleExportTxt(activeConversation.id);
                }}
                className="w-full min-h-[40px] px-3 rounded-xl hover:bg-[var(--bg-surface)] text-xs font-bold text-[var(--text-primary)] flex items-center gap-2 text-right"
              >
                <Icons.Download className="w-4 h-4 text-[var(--accent)]" />
                <span>تصدير المحادثة (.txt)</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  setConvMenuOpen(false);
                  setChatSettingsTab('prefs');
                  setChatSettingsOpen(true);
                }}
                className="w-full min-h-[40px] px-3 rounded-xl hover:bg-[var(--bg-surface)] text-xs font-bold text-[var(--text-primary)] flex items-center gap-2 text-right"
              >
                <Icons.Sliders className="w-4 h-4 text-[var(--accent)]" />
                <span>الخلفية وحجم الخط</span>
              </button>
            </div>
          )}

          {/* Pinned Message Banner (WhatsApp-style) */}
          {currentPinned && (
            <div className="px-3 py-2 rounded-xl bg-[var(--bg-surface)] border border-[var(--accent)]/35 flex items-center justify-between gap-2 text-xs">
              <button
                type="button"
                onClick={jumpToPinnedMessage}
                className="flex items-center gap-2 min-w-0 flex-1 text-right"
              >
                <Icons.Pin className="w-3.5 h-3.5 text-[var(--accent)] shrink-0" />
                <div className="min-w-0">
                  <span className="font-bold text-[var(--accent)] ml-1.5">
                    رسالة مثبتة ({currentPinned.senderName}):
                  </span>
                  <span className="text-[var(--text-primary)] truncate">
                    {currentPinned.excerpt}
                  </span>
                </div>
              </button>
              {canPinInThread && (
                <button
                  type="button"
                  onClick={handleUnpinThread}
                  aria-label="إلغاء تثبيت الرسالة"
                  className="min-h-[32px] min-w-[32px] rounded-lg flex items-center justify-center text-[var(--text-secondary)] hover:text-[var(--error)] shrink-0"
                >
                  <Icons.PinOff className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          )}

          {searchOpen && (
            <form onSubmit={handleSearchSubmit} className="flex gap-2">
              <input
                type="search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="ابحث في رسائل هذه المحادثة…"
                className="rahhala-input flex-1 px-3 py-1.5 text-sm"
              />
              <button
                type="submit"
                disabled={searching}
                className="min-h-[42px] px-4 rounded-xl bg-[var(--accent)] text-[var(--accent-fg)] text-xs font-bold"
              >
                {searching ? 'جاري البحث...' : 'بحث'}
              </button>
              {searchResults !== null && (
                <button
                  type="button"
                  onClick={() => {
                    setSearchResults(null);
                    setSearchQuery('');
                  }}
                  className="min-h-[42px] px-3 rounded-xl bg-[var(--bg-surface)] text-xs font-semibold"
                >
                  مسح
                </button>
              )}
            </form>
          )}

          {/* History access banner for newer members (public channels only) */}
          {activeThread.kind === 'channel' && historyState && !historyState.historyGranted && (
            <div className="p-2.5 rounded-xl bg-[var(--accent-soft)] border border-[var(--accent)]/25 flex flex-wrap items-center justify-between gap-2 text-xs">
              <span className="text-[var(--text-primary)]">
                {historyState.request?.status === 'pending'
                  ? 'طلب الوصول للرسائل القديمة قيد مراجعة المشرف.'
                  : historyState.request?.status === 'rejected'
                  ? 'تم رفض طلبك السابق للوصول للرسائل القديمة. يمكنك إعادة الطلب.'
                  : 'ترى حاليًا الرسائل من وقت انضمامك فقط. لمتابعة الرسائل الأقدم اطلب الإذن.'}
              </span>
              {historyState.request?.status !== 'pending' && (
                <button
                  type="button"
                  disabled={historyBusy}
                  onClick={handleRequestHistory}
                  className="min-h-[36px] px-3 py-1 rounded-lg bg-[var(--accent)] text-[var(--accent-fg)] font-bold"
                >
                  {historyBusy ? 'جاري الإرسال...' : 'طلب الرسائل القديمة'}
                </button>
              )}
            </div>
          )}
        </div>

        {/* Messages List (with Chat Wallpaper + Drag & Drop File Upload) */}
        <div
          ref={listRef}
          onScroll={handleScroll}
          onClick={() => {
            if (convMenuOpen) setConvMenuOpen(false);
          }}
          onDragOver={(e) => {
            if (e.dataTransfer?.types?.includes('Files') && canSendInThread) {
              e.preventDefault();
              setDragOverFiles(true);
            }
          }}
          onDragLeave={() => setDragOverFiles(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOverFiles(false);
            const dropped = e.dataTransfer?.files?.[0];
            if (dropped && canSendInThread) {
              void handleUploadAndSendFile(dropped, false);
            }
          }}
          className={`flex-1 min-h-0 overflow-y-auto px-3 sm:px-5 py-4 space-y-3 relative chat-wallpaper-${userSettings.wallpaper}`}
        >
          {dragOverFiles && (
            <div className="sticky top-2 z-20 p-4 rounded-2xl bg-[var(--glass-elevated)] border-2 border-dashed border-[var(--accent)] text-center text-sm font-bold text-[var(--accent)]">
              أفلت ملف PDF أو الصورة أو المستند هنا لإرساله في المحادثة
            </div>
          )}

          {/* Authentic WhatsApp Top-of-Thread Encryption Notice inside Private DMs & Custom Groups */}
          {activeThread.kind === 'conversation' && activeConversation && searchResults === null && (
            <div className="flex justify-center pb-1">
              <button
                type="button"
                onClick={() => setEncryptionModalOpen(true)}
                className="max-w-md px-3.5 py-2 rounded-xl bg-[var(--success-soft)] border border-[var(--success)]/25 text-[11px] font-semibold text-[var(--text-primary)] flex items-center gap-2 text-center hover:border-[var(--success)]/50 transition-colors"
              >
                <Icons.Lock className="w-3.5 h-3.5 text-[var(--success)] shrink-0" />
                <span>
                  نصوص الرسائل مشفرة عند التخزين على الخادم، وليست بتشفير من طرف لطرف. المرفقات تخضع لصلاحيات الأعضاء.
                  اضغط للتحقق.
                </span>
              </button>
            </div>
          )}

          {searchResults !== null ? (
            <div className="space-y-3">
              <div className="text-xs font-bold text-[var(--accent)]">
                نتائج البحث ({searchResults.length})
              </div>
              {searchResults.length === 0 ? (
                <EmptyState icon={<Icons.Search className="w-6 h-6" />} title="لا توجد نتائج مطابقة" />
              ) : (
                searchResults.map((m) => (
                  <div
                    key={m.id}
                    className="p-3.5 rounded-2xl bg-[var(--bg-surface)] border border-[var(--divider)]"
                  >
                    <div className="flex items-center justify-between text-xs text-[var(--text-secondary)] mb-1">
                      <span className="font-bold text-[var(--text-primary)]">{m.senderName}</span>
                      <span className="tabular-nums">{formatDateTime(m.createdAt)}</span>
                    </div>
                    <p className="text-sm whitespace-pre-wrap break-words">
                      {renderLinkifiedText(m.body)}
                    </p>
                  </div>
                ))
              )}
            </div>
          ) : loading ? (
            <ChatMessagesSkeleton />
          ) : error ? (
            <ErrorRetryPanel message={error} onRetry={() => loadActiveThread(activeThread, true)} />
          ) : messages.length === 0 ? (
            <EmptyState
              icon={
                activeThread.kind === 'conversation' ? (
                  <Icons.Lock className="w-6 h-6 text-[var(--success)]" />
                ) : (
                  <Icons.MessageSquare className="w-6 h-6" />
                )
              }
              title={
                activeThread.kind === 'conversation'
                  ? 'لا توجد رسائل بعد في هذه المحادثة المشفرة'
                  : 'لا توجد رسائل في هذه القناة بعد'
              }
              subtitle={
                activeThread.kind === 'conversation'
                  ? 'أرسل أول رسالة الآن ليتم تشفيرها وحفظها بأمان لأعضاء هذه المحادثة.'
                  : CHANNELS.find((c) => c.id === activeChannelId)?.description
              }
            />
          ) : (
            <>
              {hasMore && (
                <div className="text-center pb-2">
                  <button
                    type="button"
                    disabled={loadingMore}
                    onClick={handleLoadOlder}
                    className="min-h-[40px] px-4 py-1.5 rounded-xl bg-[var(--bg-surface)] border border-[var(--divider)] text-xs font-bold text-[var(--accent)] hover:border-[var(--accent)]"
                  >
                    {loadingMore ? 'جاري التحميل...' : 'تحميل رسائل أقدم'}
                  </button>
                </div>
              )}

              {messages.map((msg, index) => {
                const prevMsg = index > 0 ? messages[index - 1] : null;
                const showDateSep =
                  !prevMsg || getDayKey(prevMsg.createdAt) !== getDayKey(msg.createdAt);
                const isOwn = msg.senderId === user.id;
                const isDeleted = msg.deletedAt !== null;

                return (
                  <React.Fragment key={`${activeThread.kind}:${msg.id}`}>
                    {showDateSep && (
                      <div className="flex justify-center my-2">
                        <span className="px-3 py-1 rounded-lg bg-[var(--bg-surface)] border border-[var(--divider)] text-[11px] font-semibold text-[var(--text-secondary)]">
                          {formatDaySeparator(msg.createdAt)}
                        </span>
                      </div>
                    )}

                    <div
                      data-conv-message-id={msg.id} className={`flex items-end gap-2 ${isOwn ? 'justify-start' : 'justify-end'}`}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setActionMsg(msg);
                      }}
                      onTouchStart={() => {
                        longPressTimerRef.current = window.setTimeout(() => {
                          setActionMsg(msg);
                        }, 500);
                      }}
                      onTouchEnd={() => {
                        if (longPressTimerRef.current !== null) {
                          window.clearTimeout(longPressTimerRef.current);
                          longPressTimerRef.current = null;
                        }
                      }}
                    >
                      {!isOwn && (
                        <Avatar
                          name={msg.senderName}
                          assetId={msg.senderAvatarAssetId}
                          size="sm"
                        />
                      )}

                      <div
                        id={`chat-msg-${msg.id}`}
                        className={`max-w-[85%] sm:max-w-[72%] rounded-2xl px-3.5 py-2.5 border transition-colors ${
                          isOwn
                            ? 'rounded-se-sm bg-[var(--bubble-own)]'
                            : 'rounded-ss-sm bg-[var(--bubble-other)]'
                        } ${
                          highlightedMessageId === msg.id
                            ? 'border-[var(--accent)] ring-2 ring-[var(--accent-soft)]'
                            : 'border-[var(--divider)]'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-3 mb-1">
                          <div className="flex items-center gap-1.5 min-w-0">
                            {msg.senderId && !isOwn ? (
                              <button
                                type="button"
                                onClick={() => void handleOpenOrStartDmWithUser(msg.senderId!)}
                                title={`بدء محادثة خاصة مع ${msg.senderName}`}
                                className="text-xs font-bold text-[var(--accent)] hover:underline truncate"
                              >
                                {msg.senderName}
                              </button>
                            ) : (
                              <span className="text-xs font-bold text-[var(--accent)] truncate">
                                {msg.senderName}
                              </span>
                            )}
                            {msg.senderRole && msg.senderRole !== 'member' && (
                              <span className="text-[11px] text-[var(--text-secondary)]">
                                · {ROLE_LABELS[msg.senderRole]}
                              </span>
                            )}
                          </div>

                          <button
                            type="button"
                            onClick={() => setActionMsg(msg)}
                            aria-label="خيارات الرسالة"
                            className="min-h-[28px] min-w-[28px] rounded-lg text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-black/10 flex items-center justify-center shrink-0"
                          >
                            <Icons.MoreVertical className="w-3.5 h-3.5" />
                          </button>
                        </div>

                        {/* Reply excerpt */}
                        {msg.replyTo && !isDeleted && (
                          <div className="mb-2 px-2.5 py-1.5 rounded-xl bg-black/15 border-r-2 border-[var(--accent)] text-xs">
                            <div className="font-bold text-[var(--accent)]">
                              {msg.replyTo.senderName}
                            </div>
                            <div className="text-[var(--text-secondary)] truncate">
                              {msg.replyTo.excerpt}
                            </div>
                          </div>
                        )}

                        {isDeleted ? (
                          <p className="text-xs italic text-[var(--text-secondary)]">
                            تم حذف هذه الرسالة
                          </p>
                        ) : (
                          <>
                            {msg.body && (
                              <p
                                className={`${messageTextSizeClass} text-[var(--text-primary)] whitespace-pre-wrap break-words`}
                              >
                                {renderLinkifiedText(msg.body)}
                              </p>
                            )}

                            {msg.fileAttachment &&
                              (msg.fileAttachment.kind === 'image' ? (
                                <button
                                  type="button"
                                  onClick={() =>
                                    onOpenImage({
                                      assetId: msg.fileAttachment!.assetId,
                                      filename: msg.fileAttachment!.filename,
                                      caption: msg.body || msg.senderName,
                                      byteSize: msg.fileAttachment!.byteSize,
                                    })
                                  }
                                  className="mt-2 block rounded-xl overflow-hidden border border-[var(--divider)] max-w-[260px]"
                                >
                                  <ProtectedImage
                                    assetId={msg.fileAttachment.assetId}
                                    alt={msg.fileAttachment.filename}
                                    className="max-h-64 w-auto object-cover"
                                  />
                                </button>
                              ) : (
                                <FileAttachmentCard
                                  assetId={msg.fileAttachment.assetId}
                                  filename={msg.fileAttachment.filename}
                                  byteSize={msg.fileAttachment.byteSize}
                                />
                              ))}

                            {msg.audioAttachment && (
                              <VoiceMessagePlayer assetId={msg.audioAttachment.assetId} />
                            )}
                          </>
                        )}

                        {/* Reactions */}
                        {!isDeleted && msg.reactions.length > 0 && (
                          <div className="flex flex-wrap gap-1.5 mt-2">
                            {msg.reactions.map((r) => (
                              <button
                                key={r.emoji}
                                type="button"
                                disabled={!canReactInThread}
                                onClick={() => handleReact(msg, r.emoji)}
                                className={`min-h-[28px] px-2 py-0.5 rounded-lg text-xs border flex items-center gap-1 tabular-nums ${
                                  r.reactedByMe
                                    ? 'bg-[var(--accent-soft)] border-[var(--accent)] text-[var(--text-primary)] font-bold'
                                    : 'bg-black/15 border-[var(--divider)] text-[var(--text-secondary)]'
                                }`}
                              >
                                <span>{r.emoji}</span>
                                <span>{r.count}</span>
                              </button>
                            ))}
                          </div>
                        )}

                        <div className="flex items-center justify-end gap-1.5 mt-1.5 text-[11px] text-[var(--text-secondary)] tabular-nums">
                          {msg.starredByMe && !isDeleted && (
                            <span
                              aria-label="رسالة مميزة بنجمة"
                              title="مميزة بنجمة"
                              className="text-[var(--accent)] inline-flex"
                            >
                              <Icons.Star className="w-3 h-3 fill-current" />
                            </span>
                          )}
                          {msg.editedAt && <span>معدّلة ·</span>}
                          <span>{formatClockTime(msg.createdAt)}</span>
                          {renderReceiptIcon(msg.receiptStatus)}
                        </div>
                      </div>
                    </div>
                  </React.Fragment>
                );
              })}
            </>
          )}

          {(showNewMessagesJump || (!nearBottom && messages.length > 4)) && (
            <button
              type="button"
              onClick={() => scrollToBottom(true)}
              aria-label={
                showNewMessagesJump ? 'الانتقال إلى الرسائل الجديدة' : 'النزول لأسفل المحادثة'
              }
              className="sticky bottom-2 mx-auto flex items-center gap-1.5 px-4 min-h-[40px] rounded-full bg-[var(--accent)] text-[var(--accent-fg)] text-xs font-bold shadow-lg"
            >
              <Icons.ArrowDown className="w-3.5 h-3.5" />
              <span>{showNewMessagesJump ? 'رسائل جديدة' : 'النزول للأسفل'}</span>
            </button>
          )}
        </div>

        {/* Typing Indicator */}
        {typingUsers.length > 0 && (
          <div className="px-4 py-1 text-xs text-[var(--accent)] bg-[var(--bg-card)] border-t border-[var(--divider)]">
            {typingUsers.map((t) => t.displayName).join('، ')} يكتب الآن…
          </div>
        )}

        {/* Reply / Edit Bar */}
        {(replyTo || editingMsg) && (
          <div className="px-4 py-2 bg-[var(--bg-surface)] border-t border-[var(--divider)] flex items-center justify-between gap-3 text-xs">
            <div className="min-w-0">
              <div className="font-bold text-[var(--accent)]">
                {editingMsg ? 'تعديل رسالتك' : `الرد على ${replyTo?.senderName}`}
              </div>
              <div className="text-[var(--text-secondary)] truncate">
                {editingMsg ? editingMsg.body : replyTo?.body || 'مرفق'}
              </div>
            </div>
            <button
              type="button"
              onClick={() => {
                setReplyTo(null);
                setEditingMsg(null);
                if (editingMsg) setDraft('');
              }}
              aria-label="إلغاء"
              className="min-h-[36px] min-w-[36px] rounded-lg flex items-center justify-center text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            >
              <Icons.X className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* Emoji / Sticker Picker Drawer */}
        {showEmojiPicker && canSendInThread && (
          <div className="border-t border-[var(--divider)] bg-[var(--bg-elevated)] p-3 space-y-2.5 max-h-60 overflow-y-auto">
            <div className="flex items-center justify-between gap-2">
              <div className="flex gap-1 p-0.5 rounded-lg bg-[var(--bg-surface)]">
                <button
                  type="button"
                  onClick={() => setEmojiTab('emojis')}
                  className={`px-3 py-1.5 rounded-md text-xs font-bold ${
                    emojiTab === 'emojis'
                      ? 'bg-[var(--accent)] text-[var(--accent-fg)]'
                      : 'text-[var(--text-secondary)]'
                  }`}
                >
                  إيموجي
                </button>
                <button
                  type="button"
                  onClick={() => setEmojiTab('stickers')}
                  className={`px-3 py-1.5 rounded-md text-xs font-bold ${
                    emojiTab === 'stickers'
                      ? 'bg-[var(--accent)] text-[var(--accent-fg)]'
                      : 'text-[var(--text-secondary)]'
                  }`}
                >
                  ستيكرز
                </button>
              </div>
              <button
                type="button"
                onClick={() => setShowEmojiPicker(false)}
                aria-label="إغلاق لوحة الرموز"
                className="min-h-[36px] min-w-[36px] flex items-center justify-center text-[var(--text-secondary)]"
              >
                <Icons.X className="w-4 h-4" />
              </button>
            </div>

            {emojiTab === 'emojis' ? (
              <>
                <div className="flex flex-wrap gap-1">
                  {EMOJI_CATEGORIES.map((cat) => (
                    <button
                      key={cat.id}
                      type="button"
                      onClick={() => setEmojiCategory(cat.id)}
                      className={`px-2.5 py-1 rounded-lg text-xs font-semibold ${
                        emojiCategory === cat.id
                          ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                          : 'text-[var(--text-secondary)]'
                      }`}
                    >
                      {cat.label}
                    </button>
                  ))}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {EMOJI_CATEGORIES.find((c) => c.id === emojiCategory)?.items.map((em) => (
                    <button
                      key={em}
                      type="button"
                      onClick={() => insertEmojiAtCaret(em)}
                      className="w-10 h-10 rounded-xl hover:bg-[var(--bg-surface)] text-xl flex items-center justify-center"
                    >
                      {em}
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <div>
                <p className="text-[11px] text-[var(--text-secondary)] mb-2">
                  رموز تعبيرية كبيرة تُرسل كرسالة مستقلة في المحادثة الحالية:
                </p>
                <div className="grid grid-cols-6 gap-2">
                  {STICKER_EMOJIS.map((st) => (
                    <button
                      key={st}
                      type="button"
                      onClick={() => handleSendSticker(st)}
                      className="h-12 rounded-xl bg-[var(--bg-surface)] hover:border-[var(--accent)] border border-[var(--divider)] text-2xl flex items-center justify-center"
                    >
                      {st}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Composer */}
        <div className="shrink-0 border-t border-[var(--divider)] bg-[var(--bg-card)] p-2.5 sm:p-3 space-y-2">
          {uploadingFileName && (
            <div className="px-3 py-1.5 rounded-xl bg-[var(--accent-soft)] border border-[var(--accent)]/30 text-xs font-semibold text-[var(--accent)] flex items-center justify-between gap-2">
              <span className="truncate">جاري رفع وإرسال: {uploadingFileName}</span>
              <span className="shrink-0 tabular-nums">يرجى الانتظار…</span>
            </div>
          )}

          {!canSendInThread && !editingMsg ? (
            <div className="min-h-[44px] px-4 py-2.5 rounded-xl bg-[var(--bg-surface)] text-xs font-semibold text-[var(--text-secondary)] text-center flex items-center justify-center gap-2">
              {isMutedInChat && activeThread.kind === 'channel' && !isAdminOrOwner ? (
                <Icons.VolumeX className="w-4 h-4 text-[var(--error)] shrink-0" />
              ) : (
                <Icons.Lock className="w-4 h-4 text-[var(--accent)] shrink-0" />
              )}
              <span>
                {activeThread.kind === 'conversation'
                  ? 'الإرسال في هذه المجموعة مقصور على مشرفي المجموعة فقط.'
                  : activeChannelId === 'announcements'
                  ? 'قناة الإعلانات للقراءة فقط — النشر متاح للمشرفين والمالك.'
                  : isMutedInChat && !isAdminOrOwner
                  ? 'تم كتمك عن الإرسال في المحادثة بواسطة الإدارة.'
                  : 'المحادثة مقفولة حاليًا بواسطة الإدارة.'}
              </span>
            </div>
          ) : recording ? (
            <div className="flex items-center justify-between gap-3 px-3 py-2 rounded-xl bg-[var(--error-soft)] border border-[var(--error)]/30">
              <div className="flex items-center gap-2.5">
                <span className="w-2.5 h-2.5 rounded-full bg-[var(--error)]" />
                <span className="text-sm font-bold text-[var(--text-primary)] tabular-nums">
                  جاري التسجيل {formatDurationSeconds(recordSeconds)} / 15:00
                </span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    recordCancelledRef.current = true;
                    mediaRecorderRef.current?.stop();
                  }}
                  className="min-h-[40px] px-3 rounded-xl bg-[var(--bg-card)] text-xs font-bold text-[var(--error)]"
                >
                  إلغاء
                </button>
                <button
                  type="button"
                  onClick={() => mediaRecorderRef.current?.stop()}
                  className="min-h-[40px] px-4 rounded-xl bg-[var(--accent)] text-[var(--accent-fg)] text-xs font-bold flex items-center gap-1.5"
                >
                  <Icons.Send className="w-3.5 h-3.5" />
                  <span>إرسال</span>
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-end gap-1.5 sm:gap-2">
              <input
                ref={imageInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (file) void handleUploadAndSendFile(file, true);
                }}
              />
              <input
                ref={fileInputRef}
                type="file"
                accept="application/pdf,.pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,image/*,audio/*"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (file) void handleUploadAndSendFile(file, false);
                }}
              />

              <button
                type="button"
                onClick={() => setShowEmojiPicker((v) => !v)}
                aria-label="إيموجي وستيكرز"
                className="min-h-[44px] min-w-[44px] rounded-xl bg-[var(--bg-surface)] text-[var(--text-secondary)] hover:text-[var(--accent)] flex items-center justify-center shrink-0"
              >
                <Icons.Smile className="w-5 h-5" />
              </button>

              {!editingMsg && canSendMediaInThread && (
                <>
                  <button
                    type="button"
                    disabled={sending}
                    onClick={() => fileInputRef.current?.click()}
                    aria-label="إرفاق ملف أو PDF"
                    title="إرفاق ملف (PDF / Word / PowerPoint / صورة)"
                    className="min-h-[44px] min-w-[44px] rounded-xl bg-[var(--bg-surface)] text-[var(--text-secondary)] hover:text-[var(--accent)] flex items-center justify-center shrink-0 disabled:opacity-50"
                  >
                    <Icons.Paperclip className="w-5 h-5" />
                  </button>
                  {!draft.trim() && (
                    <button
                      type="button"
                      disabled={sending}
                      onClick={() => imageInputRef.current?.click()}
                      aria-label="إرسال صورة"
                      className="min-h-[44px] min-w-[44px] rounded-xl bg-[var(--bg-surface)] text-[var(--text-secondary)] hover:text-[var(--accent)] flex items-center justify-center shrink-0 disabled:opacity-50"
                    >
                      <Icons.Image className="w-5 h-5" />
                    </button>
                  )}
                </>
              )}

              <textarea
                ref={textareaRef}
                rows={1}
                maxLength={2000}
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value);
                  if (!editingMsg && e.target.value.trim()) {
                    emitTyping(true);
                  }
                }}
                onKeyDown={(e) => {
                  const isMobileWidth = window.innerWidth < 768;
                  if (
                    userSettings.enterToSend &&
                    e.key === 'Enter' &&
                    !e.shiftKey &&
                    !e.nativeEvent.isComposing &&
                    !isMobileWidth
                  ) {
                    e.preventDefault();
                    void handleSendTextOrEdit();
                  }
                }}
                placeholder={
                  editingMsg
                    ? 'عدّل نص الرسالة…'
                    : activeThread.kind === 'conversation'
                    ? 'اكتب رسالة مشفرة…'
                    : 'اكتب رسالتك هنا…'
                }
                aria-label="نص الرسالة"
                className="rahhala-input flex-1 px-3.5 py-2.5 resize-none max-h-32 leading-snug"
              />

              {draft.trim() || editingMsg ? (
                <button
                  type="button"
                  disabled={sending || !draft.trim()}
                  onClick={handleSendTextOrEdit}
                  aria-label={editingMsg ? 'حفظ التعديل' : 'إرسال'}
                  className="min-h-[44px] min-w-[44px] px-3.5 rounded-xl bg-[var(--accent)] text-[var(--accent-fg)] font-bold flex items-center justify-center shrink-0 disabled:opacity-50"
                >
                  <Icons.Send className="w-5 h-5" />
                </button>
              ) : (
                <button
                  type="button"
                  disabled={sending || !canSendMediaInThread}
                  onClick={startVoiceRecording}
                  aria-label="تسجيل رسالة صوتية"
                  className="min-h-[44px] min-w-[44px] rounded-xl bg-[var(--accent)] text-[var(--accent-fg)] flex items-center justify-center shrink-0 disabled:opacity-50"
                >
                  <Icons.Mic className="w-5 h-5" />
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Message Actions Modal */}
      <ModalShell
        open={Boolean(actionMsg)}
        onClose={() => setActionMsg(null)}
        title="إجراءات الرسالة"
        maxWidth="max-w-sm"
      >
        {actionMsg && (
          <div className="space-y-3">
            {actionMsg.deletedAt === null && (
              <>
                {canReactInThread && (
                  <div className="flex items-center justify-between gap-1 p-2 rounded-xl bg-[var(--bg-surface)]">
                    {QUICK_REACTIONS.map((em) => (
                      <button
                        key={em}
                        type="button"
                        onClick={() => handleReact(actionMsg, em)}
                        className="min-h-[40px] min-w-[40px] rounded-lg hover:bg-black/15 text-xl flex items-center justify-center"
                      >
                        {em}
                      </button>
                    ))}
                  </div>
                )}

                {canSendInThread && (
                  <button
                    type="button"
                    onClick={() => {
                      setReplyTo(actionMsg);
                      setEditingMsg(null);
                      setActionMsg(null);
                      textareaRef.current?.focus();
                    }}
                    className="w-full min-h-[44px] px-3.5 rounded-xl bg-[var(--bg-surface)] text-sm font-semibold flex items-center gap-2.5"
                  >
                    <Icons.Reply className="w-4 h-4 text-[var(--accent)]" />
                    <span>رد على الرسالة</span>
                  </button>
                )}

                {actionMsg.senderId && actionMsg.senderId !== user.id && (
                  <button
                    type="button"
                    onClick={() => {
                      const targetId = actionMsg.senderId!;
                      setActionMsg(null);
                      void handleOpenOrStartDmWithUser(targetId);
                    }}
                    className="w-full min-h-[44px] px-3.5 rounded-xl bg-[var(--bg-surface)] text-sm font-semibold flex items-center gap-2.5"
                  >
                    <Icons.Lock className="w-4 h-4 text-[var(--success)]" />
                    <span>محادثة خاصة مع {actionMsg.senderName}</span>
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => handleToggleStar(actionMsg)}
                  className="w-full min-h-[44px] px-3.5 rounded-xl bg-[var(--bg-surface)] text-sm font-semibold flex items-center gap-2.5"
                >
                  <Icons.Star
                    className={`w-4 h-4 text-[var(--accent)] ${
                      actionMsg.starredByMe ? 'fill-current' : ''
                    }`}
                  />
                  <span>{actionMsg.starredByMe ? 'إزالة النجمة' : 'تمييز بنجمة'}</span>
                </button>

                {canPinInThread && (
                  <button
                    type="button"
                    onClick={() => handleTogglePin(actionMsg)}
                    className="w-full min-h-[44px] px-3.5 rounded-xl bg-[var(--bg-surface)] text-sm font-semibold flex items-center gap-2.5"
                  >
                    <Icons.Pin className="w-4 h-4 text-[var(--accent)]" />
                    <span>
                      {currentPinned?.id === actionMsg.id
                        ? 'إلغاء تثبيت الرسالة'
                        : 'تثبيت الرسالة في أعلى المحادثة'}
                    </span>
                  </button>
                )}

                {actionMsg.body && (
                  <button
                    type="button"
                    onClick={() => {
                      navigator.clipboard?.writeText(actionMsg.body).catch(() => {});
                      setActionMsg(null);
                      onToast('تم نسخ النص');
                    }}
                    className="w-full min-h-[44px] px-3.5 rounded-xl bg-[var(--bg-surface)] text-sm font-semibold flex items-center gap-2.5"
                  >
                    <Icons.Copy className="w-4 h-4 text-[var(--accent)]" />
                    <span>نسخ النص</span>
                  </button>
                )}

                {actionMsg.canEdit && actionMsg.body && (
                  <button
                    type="button"
                    onClick={() => {
                      setEditingMsg(actionMsg);
                      setReplyTo(null);
                      setDraft(actionMsg.body);
                      setActionMsg(null);
                      textareaRef.current?.focus();
                    }}
                    className="w-full min-h-[44px] px-3.5 rounded-xl bg-[var(--bg-surface)] text-sm font-semibold flex items-center gap-2.5"
                  >
                    <Icons.Edit className="w-4 h-4 text-[var(--accent)]" />
                    <span>تعديل النص</span>
                  </button>
                )}

                {actionMsg.canViewInfo && (
                  <button
                    type="button"
                    onClick={() => handleOpenMessageInfo(actionMsg)}
                    className="w-full min-h-[44px] px-3.5 rounded-xl bg-[var(--bg-surface)] text-sm font-semibold flex items-center gap-2.5"
                  >
                    <Icons.Info className="w-4 h-4 text-[var(--accent)]" />
                    <span>معلومات الرسالة والقراءة</span>
                  </button>
                )}
              </>
            )}

            <button
              type="button"
              onClick={() => handleHideForMe(actionMsg)}
              className="w-full min-h-[44px] px-3.5 rounded-xl bg-[var(--bg-surface)] text-sm font-semibold flex items-center gap-2.5"
            >
              <Icons.EyeOff className="w-4 h-4 text-[var(--text-secondary)]" />
              <span>حذف عندي (إخفاء من شاشتي فقط)</span>
            </button>

            {actionMsg.canDeleteForEveryone && (
              <button
                type="button"
                onClick={() => {
                  setDeleteAllTarget(actionMsg);
                  setActionMsg(null);
                }}
                className="w-full min-h-[44px] px-3.5 rounded-xl bg-[var(--error-soft)] text-[var(--error)] text-sm font-bold flex items-center gap-2.5"
              >
                <Icons.Trash className="w-4 h-4" />
                <span>حذف عند الكل</span>
              </button>
            )}

            {user.role === 'owner' && !('conversationId' in actionMsg) && (
              <button
                type="button"
                onClick={() => {
                  setPurgeTarget(actionMsg);
                  setActionMsg(null);
                }}
                className="w-full min-h-[44px] px-3.5 rounded-xl bg-[var(--error)] text-white text-sm font-bold flex items-center gap-2.5"
              >
                <Icons.Trash className="w-4 h-4" />
                <span>محو كامل من القاعدة (للمالك فقط)</span>
              </button>
            )}
          </div>
        )}
      </ModalShell>

      <ConfirmDialog
        open={Boolean(deleteAllTarget)}
        onClose={() => setDeleteAllTarget(null)}
        onConfirm={handleDeleteForEveryone}
        title="حذف الرسالة عند الكل"
        message="سيتم استبدال الرسالة بعبارة (تم حذف هذه الرسالة) وإزالة مرفقاتها وتفاعلاتها لدى جميع الأعضاء."
        confirmLabel="حذف عند الكل"
        destructive
        busy={actionBusy}
      />

      <ConfirmDialog
        open={Boolean(purgeTarget)}
        onClose={() => setPurgeTarget(null)}
        onConfirm={handleOwnerPurge}
        title="محو كامل للرسالة"
        message="سيتم مسح هذه الرسالة ومرفقاتها من قاعدة البيانات بالكامل دون ترك أثر (تم حذف هذه الرسالة) لدى جميع الأعضاء."
        confirmLabel="تأكيد المحو الكامل"
        destructive
        busy={actionBusy}
      />

      {/* WhatsApp-Style Personal Chat Settings Modal */}
      <ModalShell
        open={chatSettingsOpen}
        onClose={() => setChatSettingsOpen(false)}
        title="إعدادات المحادثة"
        maxWidth="max-w-lg"
      >
        <div className="space-y-4">
          <div className="flex gap-1 p-1 rounded-xl bg-[var(--bg-surface)]">
            <button
              type="button"
              onClick={() => setChatSettingsTab('prefs')}
              className={`flex-1 min-h-[40px] rounded-lg text-xs sm:text-sm font-bold ${
                chatSettingsTab === 'prefs'
                  ? 'bg-[var(--bg-card)] text-[var(--accent)] shadow-xs'
                  : 'text-[var(--text-secondary)]'
              }`}
            >
              المظهر والتفضيلات
            </button>
            <button
              type="button"
              onClick={() => {
                setChatSettingsTab('starred');
                void loadStarredMessages();
              }}
              className={`flex-1 min-h-[40px] rounded-lg text-xs sm:text-sm font-bold ${
                chatSettingsTab === 'starred'
                  ? 'bg-[var(--bg-card)] text-[var(--accent)] shadow-xs'
                  : 'text-[var(--text-secondary)]'
              }`}
            >
              الرسائل المميزة بنجمة
            </button>
          </div>

          {chatSettingsTab === 'prefs' ? (
            <div className="space-y-4">
              <div className="space-y-2">
                <div className="text-xs font-bold text-[var(--text-secondary)] flex items-center gap-1.5">
                  <Icons.Sparkles className="w-3.5 h-3.5 text-[var(--accent)]" />
                  <span>خلفية المحادثة</span>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {WALLPAPER_OPTIONS.map((wp) => {
                    const active = userSettings.wallpaper === wp.id;
                    return (
                      <button
                        key={wp.id}
                        type="button"
                        onClick={() => void handleUpdateUserSettings({ wallpaper: wp.id })}
                        className={`p-2.5 rounded-xl border text-right transition-colors min-h-[58px] flex flex-col justify-between ${
                          active
                            ? 'border-[var(--accent)] ring-1 ring-[var(--accent)]'
                            : 'border-[var(--divider)] hover:border-[var(--accent)]/60'
                        } ${wp.previewClass}`}
                      >
                        <span className="text-xs font-bold text-[var(--text-primary)]">{wp.label}</span>
                        {active && (
                          <span className="text-[11px] font-bold text-[var(--accent)]">مفعّلة</span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="space-y-2">
                <div className="text-xs font-bold text-[var(--text-secondary)] flex items-center gap-1.5">
                  <Icons.Type className="w-3.5 h-3.5 text-[var(--accent)]" />
                  <span>حجم خط الرسائل</span>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  {FONT_SIZE_OPTIONS.map((fs) => {
                    const active = userSettings.fontSize === fs.id;
                    return (
                      <button
                        key={fs.id}
                        type="button"
                        onClick={() => void handleUpdateUserSettings({ fontSize: fs.id })}
                        className={`min-h-[44px] rounded-xl border text-xs font-bold ${
                          active
                            ? 'bg-[var(--accent-soft)] border-[var(--accent)] text-[var(--accent)]'
                            : 'bg-[var(--bg-surface)] border-[var(--divider)] text-[var(--text-primary)]'
                        }`}
                      >
                        {fs.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="divide-y divide-[var(--divider)] rounded-2xl bg-[var(--bg-surface)] border border-[var(--divider)] px-3.5">
                <label className="py-3 flex items-center justify-between gap-3 cursor-pointer">
                  <div>
                    <div className="text-sm font-bold text-[var(--text-primary)]">
                      مؤشرات قراءة الرسائل
                    </div>
                    <div className="text-xs text-[var(--text-secondary)]">
                      إظهار واستقبال حالة القراءة (الصحّين الملونين)
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    checked={userSettings.readReceiptsEnabled}
                    onChange={(e) =>
                      void handleUpdateUserSettings({ readReceiptsEnabled: e.target.checked })
                    }
                    className="w-5 h-5 accent-[var(--accent)]"
                  />
                </label>

                <label className="py-3 flex items-center justify-between gap-3 cursor-pointer">
                  <div>
                    <div className="text-sm font-bold text-[var(--text-primary)]">أصوات المحادثة</div>
                    <div className="text-xs text-[var(--text-secondary)]">
                      نغمة خفيفة عند إرسال أو استقبال رسالة جديدة
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    checked={userSettings.chatSoundsEnabled}
                    onChange={(e) =>
                      void handleUpdateUserSettings({ chatSoundsEnabled: e.target.checked })
                    }
                    className="w-5 h-5 accent-[var(--accent)]"
                  />
                </label>

                <label className="py-3 flex items-center justify-between gap-3 cursor-pointer">
                  <div>
                    <div className="text-sm font-bold text-[var(--text-primary)]">
                      مفتاح Enter للإرسال
                    </div>
                    <div className="text-xs text-[var(--text-secondary)]">
                      إرسال الرسالة بضغطة Enter على سطح المكتب
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    checked={userSettings.enterToSend}
                    onChange={(e) =>
                      void handleUpdateUserSettings({ enterToSend: e.target.checked })
                    }
                    className="w-5 h-5 accent-[var(--accent)]"
                  />
                </label>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => void handleExportTxt()}
                  className="min-h-[44px] px-3.5 rounded-xl bg-[var(--bg-surface)] border border-[var(--divider)] text-xs font-bold text-[var(--text-primary)] flex items-center justify-center gap-2 hover:border-[var(--accent)]"
                >
                  <Icons.Download className="w-4 h-4 text-[var(--accent)]" />
                  <span>تصدير المحادثة الحالية (.txt)</span>
                </button>

                {activeThread.kind === 'channel' && (
                  <button
                    type="button"
                    onClick={() => setClearChannelConfirmOpen(true)}
                    className="min-h-[44px] px-3.5 rounded-xl bg-[var(--error-soft)] border border-[var(--error)]/30 text-xs font-bold text-[var(--error)] flex items-center justify-center gap-2"
                  >
                    <Icons.EyeOff className="w-4 h-4" />
                    <span>مسح القناة عندي</span>
                  </button>
                )}
              </div>
            </div>
          ) : starredLoading ? (
            <div className="py-8 text-center text-sm text-[var(--text-secondary)]">
              جاري تحميل الرسائل المميزة…
            </div>
          ) : starredItems.length === 0 ? (
            <EmptyState
              icon={<Icons.Star className="w-6 h-6" />}
              title="لا توجد رسائل مميزة بنجمة"
              subtitle="اضغط على خيارات أي رسالة واختر تمييز بنجمة للرجوع إليها بسرعة."
            />
          ) : (
            <div className="space-y-2.5 max-h-[55vh] overflow-y-auto">
              {starredItems.map(({ msg: sm, sourceLabel }) => (
                <div
                  key={`${'conversationId' in sm ? sm.conversationId : sm.channel}:${sm.id}`}
                  className="p-3 rounded-xl bg-[var(--bg-surface)] border border-[var(--divider)] space-y-1.5"
                >
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="font-bold text-[var(--accent)] truncate">
                        {sm.senderName}
                      </span>
                      <span className="text-[11px] text-[var(--text-secondary)] truncate">
                        · {sourceLabel}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-[var(--text-secondary)] tabular-nums">
                        {formatDateTime(sm.createdAt)}
                      </span>
                      <button
                        type="button"
                        onClick={async () => {
                          await handleToggleStar(sm);
                          setStarredItems((prev) => prev.filter((x) => x.msg.id !== sm.id));
                        }}
                        aria-label="إزالة النجمة"
                        className="text-[var(--accent)] hover:text-[var(--error)]"
                      >
                        <Icons.Star className="w-4 h-4 fill-current" />
                      </button>
                    </div>
                  </div>
                  <p className="text-sm text-[var(--text-primary)] whitespace-pre-wrap break-words">
                    {sm.body ||
                      (sm.audioAttachment ? 'رسالة صوتية' : sm.fileAttachment?.filename || 'مرفق')}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      </ModalShell>

      {/* Community Group Info & Settings Modal */}
      <ModalShell
        open={groupSettingsOpen}
        onClose={() => setGroupSettingsOpen(false)}
        title="معلومات وإعدادات المجتمع"
        maxWidth="max-w-lg"
      >
        <div className="space-y-5">
          {canEditGroupInfo ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void handleUpdateGroupSettings({
                  groupName: groupNameDraft,
                  groupDescription: groupDescDraft,
                  groupRules: groupRulesDraft,
                });
              }}
              className="space-y-3"
            >
              <div>
                <label className="block text-xs font-bold text-[var(--text-secondary)] mb-1">
                  اسم المجتمع
                </label>
                <input
                  type="text"
                  required
                  minLength={2}
                  maxLength={60}
                  value={groupNameDraft}
                  onChange={(e) => setGroupNameDraft(e.target.value)}
                  className="rahhala-input w-full px-3 py-2 text-sm"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-[var(--text-secondary)] mb-1">
                  وصف المجتمع
                </label>
                <textarea
                  rows={2}
                  maxLength={300}
                  value={groupDescDraft}
                  onChange={(e) => setGroupDescDraft(e.target.value)}
                  className="rahhala-input w-full px-3 py-2 text-sm resize-none"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-[var(--text-secondary)] mb-1">
                  قوانين وضوابط المجتمع
                </label>
                <textarea
                  rows={2}
                  maxLength={400}
                  value={groupRulesDraft}
                  onChange={(e) => setGroupRulesDraft(e.target.value)}
                  className="rahhala-input w-full px-3 py-2 text-sm resize-none"
                />
              </div>

              <button
                type="submit"
                disabled={savingGroupSettings}
                className="min-h-[44px] w-full rounded-xl bg-[var(--accent)] text-[var(--accent-fg)] text-sm font-bold disabled:opacity-60"
              >
                {savingGroupSettings ? 'جاري الحفظ…' : 'حفظ معلومات المجتمع'}
              </button>
            </form>
          ) : (
            <div className="space-y-3">
              <div className="p-3.5 rounded-xl bg-[var(--bg-surface)] border border-[var(--divider)]">
                <div className="text-xs text-[var(--text-secondary)]">اسم المجتمع</div>
                <div className="text-base font-extrabold text-[var(--text-primary)] mt-0.5">
                  {groupSettings.groupName}
                </div>
              </div>
              <div className="p-3.5 rounded-xl bg-[var(--bg-surface)] border border-[var(--divider)]">
                <div className="text-xs text-[var(--text-secondary)]">الوصف</div>
                <p className="text-sm text-[var(--text-primary)] mt-1 whitespace-pre-wrap">
                  {groupSettings.groupDescription}
                </p>
              </div>
              <div className="p-3.5 rounded-xl bg-[var(--bg-surface)] border border-[var(--divider)]">
                <div className="text-xs text-[var(--text-secondary)]">قوانين المجتمع</div>
                <p className="text-sm text-[var(--text-primary)] mt-1 whitespace-pre-wrap">
                  {groupSettings.groupRules}
                </p>
              </div>
            </div>
          )}

          {isAdminOrOwner && (
            <div className="space-y-3 pt-3 border-t border-[var(--divider)]">
              <div className="text-xs font-bold text-[var(--accent)]">صلاحيات وإعدادات الإشراف</div>

              <div className="divide-y divide-[var(--divider)] rounded-2xl bg-[var(--bg-surface)] border border-[var(--divider)] px-3.5">
                <label className="py-3 flex items-center justify-between gap-3 cursor-pointer">
                  <div>
                    <div className="text-sm font-bold text-[var(--text-primary)]">
                      قفل الإرسال للأعضاء
                    </div>
                    <div className="text-xs text-[var(--text-secondary)]">
                      السماح للمشرفين والمالك فقط بالإرسال في القنوات
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    checked={groupSettings.chatLocked}
                    onChange={(e) =>
                      void handleUpdateGroupSettings({ chatLocked: e.target.checked })
                    }
                    className="w-5 h-5 accent-[var(--accent)]"
                  />
                </label>

                <label className="py-3 flex items-center justify-between gap-3 cursor-pointer">
                  <div>
                    <div className="text-sm font-bold text-[var(--text-primary)]">
                      السماح بالملفات والوسائط
                    </div>
                    <div className="text-xs text-[var(--text-secondary)]">
                      إرسال صور وملفات PDF ومستندات وصوتيات للأعضاء
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    checked={groupSettings.allowMedia}
                    onChange={(e) =>
                      void handleUpdateGroupSettings({ allowMedia: e.target.checked })
                    }
                    className="w-5 h-5 accent-[var(--accent)]"
                  />
                </label>

                <label className="py-3 flex items-center justify-between gap-3 cursor-pointer">
                  <div>
                    <div className="text-sm font-bold text-[var(--text-primary)]">
                      السماح بالتفاعلات
                    </div>
                    <div className="text-xs text-[var(--text-secondary)]">
                      تفاعل الأعضاء بالرموز التعبيرية على الرسائل
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    checked={groupSettings.allowReactions}
                    onChange={(e) =>
                      void handleUpdateGroupSettings({ allowReactions: e.target.checked })
                    }
                    className="w-5 h-5 accent-[var(--accent)]"
                  />
                </label>
              </div>

              <div className="space-y-1.5">
                <label className="block text-xs font-bold text-[var(--text-secondary)]">
                  الرسائل ذاتية الاختفاء (تُخفي الرسائل الأقدم تلقائيًا)
                </label>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {DISAPPEARING_OPTIONS.map((opt) => {
                    const active = groupSettings.disappearingHours === opt.hours;
                    return (
                      <button
                        key={opt.hours}
                        type="button"
                        onClick={() =>
                          void handleUpdateGroupSettings({ disappearingHours: opt.hours })
                        }
                        className={`min-h-[42px] rounded-xl border text-xs font-bold ${
                          active
                            ? 'bg-[var(--accent-soft)] border-[var(--accent)] text-[var(--accent)]'
                            : 'bg-[var(--bg-surface)] border-[var(--divider)] text-[var(--text-primary)]'
                        }`}
                      >
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              {user.role === 'owner' && (
                <div className="space-y-1.5">
                  <label className="block text-xs font-bold text-[var(--text-secondary)]">
                    من يملك تعديل معلومات المجتمع؟
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => void handleUpdateGroupSettings({ editInfoPolicy: 'mods' })}
                      className={`min-h-[42px] rounded-xl border text-xs font-bold ${
                        groupSettings.editInfoPolicy === 'mods'
                          ? 'bg-[var(--accent-soft)] border-[var(--accent)] text-[var(--accent)]'
                          : 'bg-[var(--bg-surface)] border-[var(--divider)] text-[var(--text-primary)]'
                      }`}
                    >
                      المشرفون والمالك
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleUpdateGroupSettings({ editInfoPolicy: 'owner' })}
                      className={`min-h-[42px] rounded-xl border text-xs font-bold ${
                        groupSettings.editInfoPolicy === 'owner'
                          ? 'bg-[var(--accent-soft)] border-[var(--accent)] text-[var(--accent)]'
                          : 'bg-[var(--bg-surface)] border-[var(--divider)] text-[var(--text-primary)]'
                      }`}
                    >
                      المالك فقط
                    </button>
                  </div>
                </div>
              )}

              <button
                type="button"
                onClick={() => {
                  setGroupSettingsOpen(false);
                  onOpenMembersAndMedia();
                }}
                className="min-h-[44px] w-full rounded-xl bg-[var(--bg-surface)] border border-[var(--divider)] text-xs font-bold text-[var(--text-primary)] flex items-center justify-center gap-2 hover:border-[var(--accent)]"
              >
                <Icons.Users className="w-4 h-4 text-[var(--accent)]" />
                <span>إدارة الأعضاء وكتم الإرسال</span>
              </button>
            </div>
          )}

          {user.role === 'owner' && (
            <div className="space-y-2.5 pt-3 border-t border-[var(--error)]/30">
              <div className="text-xs font-extrabold text-[var(--error)] flex items-center gap-1.5">
                <Icons.AlertCircle className="w-4 h-4" />
                <span>خاصية المحو الكامل (صلاحية المالك فقط)</span>
              </div>
              <p className="text-xs text-[var(--text-secondary)]">
                يمسح جميع الرسائل والملفات المرفقة والتفاعلات من قنوات المجتمع نهائيًا عند الجميع.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setWipeConfirmText('');
                    setWipeMode('channel');
                  }}
                  className="min-h-[44px] px-3 rounded-xl bg-[var(--error-soft)] border border-[var(--error)]/40 text-xs font-bold text-[var(--error)]"
                >
                  المحو الكامل لقناة{' '}
                  {CHANNELS.find((c) => c.id === (activeChannelId ?? 'general'))?.label}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setWipeConfirmText('');
                    setWipeMode('all');
                  }}
                  className="min-h-[44px] px-3 rounded-xl bg-[var(--error)] text-white text-xs font-bold"
                >
                  المحو الكامل لجميع القنوات
                </button>
              </div>
            </div>
          )}
        </div>
      </ModalShell>

      <ConfirmDialog
        open={clearChannelConfirmOpen}
        onClose={() => setClearChannelConfirmOpen(false)}
        onConfirm={handleClearChannelForMe}
        title="مسح الدردشة عندي"
        message="سيتم إخفاء جميع الرسائل الحالية في هذه القناة من شاشتك فقط، ولن تتأثر لدى باقي الأعضاء."
        confirmLabel="مسح من شاشتي"
        destructive
        busy={actionBusy}
      />

      {/* Owner Double-Confirmation Complete Wipe Modal */}
      <ModalShell
        open={wipeMode !== null}
        onClose={() => {
          if (!wipeBusy) {
            setWipeMode(null);
            setWipeConfirmText('');
          }
        }}
        title={
          wipeMode === 'all' ? 'تأكيد المحو الكامل لجميع القنوات' : 'تأكيد المحو الكامل للقناة'
        }
        maxWidth="max-w-sm"
      >
        <div className="space-y-4">
          <p className="text-sm text-[var(--text-primary)] leading-relaxed">
            {wipeMode === 'all'
              ? 'سيتم مسح جميع الرسائل والملفات والتسجيلات الصوتية في كل القنوات العامة (إعلانات، أسئلة، عام) من قاعدة البيانات نهائيًا ولا يمكن التراجع.'
              : `سيتم مسح جميع الرسائل والمرفقات في قناة "${
                  CHANNELS.find((c) => c.id === (activeChannelId ?? 'general'))?.label
                }" من قاعدة البيانات نهائيًا ولا يمكن التراجع.`}
          </p>

          <div>
            <label className="block text-xs font-bold text-[var(--text-secondary)] mb-1.5">
              اكتب كلمة <span className="text-[var(--error)]">محو</span> للتأكيد:
            </label>
            <input
              type="text"
              value={wipeConfirmText}
              onChange={(e) => setWipeConfirmText(e.target.value)}
              placeholder="محو"
              className="rahhala-input w-full px-3 py-2 text-sm"
            />
          </div>

          <div className="flex gap-2 justify-end">
            <button
              type="button"
              disabled={wipeBusy}
              onClick={() => {
                setWipeMode(null);
                setWipeConfirmText('');
              }}
              className="min-h-[44px] px-4 rounded-xl bg-[var(--bg-surface)] text-xs font-bold"
            >
              إلغاء
            </button>
            <button
              type="button"
              disabled={wipeBusy || wipeConfirmText.trim() !== 'محو'}
              onClick={handleExecuteCompleteWipe}
              className="min-h-[44px] px-4 rounded-xl bg-[var(--error)] text-white text-xs font-bold disabled:opacity-45"
            >
              {wipeBusy ? 'جاري المحو…' : 'تنفيذ المحو الكامل'}
            </button>
          </div>
        </div>
      </ModalShell>

      {/* Message Delivery / Read Info Modal */}
      <ModalShell
        open={Boolean(infoTarget)}
        onClose={() => setInfoTarget(null)}
        title="تفاصيل التسليم والقراءة"
        maxWidth="max-w-md"
      >
        {infoLoading ? (
          <div className="py-6 text-center text-sm text-[var(--text-secondary)]">
            جاري تحميل البيانات…
          </div>
        ) : !infoReceipts || infoReceipts.length === 0 ? (
          <p className="text-sm text-[var(--text-secondary)] py-4 text-center">
            لم تُسجل قراءة أو استلام من أعضاء آخرين بعد.
          </p>
        ) : (
          <div className="divide-y divide-[var(--divider)]">
            {infoReceipts.map((r) => (
              <div key={r.recipientId} className="py-2.5 flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-bold text-[var(--text-primary)]">
                    {r.displayName}
                  </div>
                  <div dir="ltr" className="text-xs text-[var(--text-secondary)]">
                    @{r.username}
                  </div>
                </div>
                <div className="text-left text-xs text-[var(--text-secondary)] space-y-0.5 tabular-nums">
                  {r.readAt ? (
                    <div className="text-[var(--accent)] font-semibold">
                      قُرئت: {formatDateTime(r.readAt)}
                    </div>
                  ) : r.deliveredAt ? (
                    <div>وُصلت: {formatDateTime(r.deliveredAt)}</div>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        )}
      </ModalShell>

      {/* New Encrypted Direct Chat Modal */}
      <NewDmModal
        open={newDmOpen}
        onClose={() => setNewDmOpen(false)}
        currentUser={user}
        onConversationReady={(conv) => {
          setConversations((prev) => {
            const rest = prev.filter((c) => c.id !== conv.id);
            return [conv, ...rest];
          });
          selectConversationThread(conv.id);
        }}
        onToast={onToast}
      />

      {/* New Encrypted Custom Group Modal */}
      <NewGroupModal
        open={newGroupOpen}
        onClose={() => setNewGroupOpen(false)}
        currentUser={user}
        onGroupCreated={(conv) => {
          setConversations((prev) => [conv, ...prev.filter((c) => c.id !== conv.id)]);
          selectConversationThread(conv.id);
        }}
        onToast={onToast}
      />

      {/* Custom Group / DM Info & Member Management Modal */}
      <CustomGroupInfoModal
        open={customConvInfoOpen}
        onClose={() => setCustomConvInfoOpen(false)}
        conversation={activeConversation}
        currentUser={user}
        onOpenEncryption={() => {
          setCustomConvInfoOpen(false);
          setEncryptionModalOpen(true);
        }}
        onConversationUpdated={(updated) => {
          setConversations((prev) =>
            prev.map((c) => (c.id === updated.id ? updated : c))
          );
        }}
        onConversationLeft={(convId) => {
          setConversations((prev) => prev.filter((c) => c.id !== convId));
          selectChannelThread('general');
          onUnreadRefresh();
        }}
        onClearedForMe={(convId) => {
          if (
            activeThread.kind === 'conversation' &&
            activeThread.conversationId === convId
          ) {
            setMessages([]);
            setSearchResults(null);
          }
          void loadConversations(false);
          onUnreadRefresh();
        }}
        onExportTxt={(convId) => void handleExportTxt(convId)}
        onToast={onToast}
      />

      {/* AES-256-GCM Encryption Verification Modal */}
      <EncryptionInfoModal
        open={encryptionModalOpen}
        onClose={() => setEncryptionModalOpen(false)}
        conversation={activeConversation}
        onToast={onToast}
      />
    </div>
  );
}
