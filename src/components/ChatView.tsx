import {useUpdateBlocker} from '../hooks/useSilentPWAUpdate';
import { GroupsView } from './GroupsView';
import { createPortal } from 'react-dom';
import { ConversationsChatView } from './ConversationsChatView';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CHANNELS,
  ROLE_LABELS,
  type AuthUser,
  type ChannelId,
  type ChatFontSize,
  type ChatMessage,
  type ChatWallpaperId,
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

const EMOJI_CATEGORIES: Array<{ id: string; label: string; items: string[] }> = [
  { id: 'faces', label: 'وجوه', items: ['😊', '😄', '😅', '🤔', '🫡', '😌', '🤲', '😮'] },
  { id: 'gestures', label: 'إشارات', items: ['👍', '👏', '🤝', '☝️', '✍️', '✅', '💯', '🔥'] },
  { id: 'hearts', label: 'قلوب', items: ['❤️', '💛', '💚', '🤍', '🌟', '✨', '🌸', '🕊️'] },
  { id: 'study', label: 'دراسة', items: ['📚', '📖', '📝', '🖋️', '🎓', '🗂️', '📑', '🔍'] },
  { id: 'objects', label: 'أشياء', items: ['☕', '🍵', '⏰', '📌', '💡', '🎧', '💻', '🕌'] },
];

const QUICK_REACTIONS = ['👍', '❤️', '😂', '👏', '😊', '✅'];
const STICKER_EMOJIS = ['📚', '🎓', '👍', '❤️', '🤲', '✨', '📝', '☕', '🌟', '👏', '💡', '🕌'];
const MAX_VOICE_SECONDS = 15 * 60; // 15 minutes
const MAX_CHAT_UPLOAD_BYTES = Number(import.meta.env.VITE_MAX_UPLOAD_BYTES || 25_000_000);

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

function playChatPing() {
  try {
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
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
        // Wait for audio element mount & play explicitly on user click
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

export function ChatView({
  user,
  unreadByChannel,
  onUnreadRefresh,
  onOpenMembersAndMedia,
  onOpenImage,
  onToast,
  onUserRefresh,
  onForceLogout,
  onCloseChat,
}: {
  user: AuthUser;
  unreadByChannel: Record<ChannelId, number>;
  onCloseChat: () => void;
  onUnreadRefresh: () => void;
  onOpenMembersAndMedia: () => void;
  onOpenImage: (item: { assetId: string; filename: string; caption?: string; byteSize?: number }) => void;
  onToast: (msg: string, isError?: boolean) => void;
  onUserRefresh: () => void;
  onForceLogout: (msg: string) => void;
}) {
  const [privateChatsOpen,setPrivateChatsOpen]=useState(false);
  const [groupsOpen,setGroupsOpen]=useState(false);
  const [channel, setChannel] = useState<ChannelId>('general');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chatLocked, setChatLocked] = useState(false);
  const [typingUsers, setTypingUsers] = useState<Array<{ userId: string; displayName: string }>>([]);

  // History access state for members without full history
  const [historyState, setHistoryState] = useState<{
    historyGranted: boolean;
    request: HistoryRequestRecord | null;
  } | null>(null);
  const [historyBusy, setHistoryBusy] = useState(false);

  // Composer state
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const [editingMsg, setEditingMsg] = useState<ChatMessage | null>(null);
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

  // Search state
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<ChatMessage[] | null>(null);
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
  const swipeStartRef=useRef<{x:number;y:number}|null>(null);
  const longPressTimerRef = useRef<number | null>(null);

  // Action menus & modals
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [forwardOpen, setForwardOpen] = useState(false);
  const [selectionDelete, setSelectionDelete] = useState<'hide'|'delete'|null>(null);
  const [selectionBusy,setSelectionBusy] = useState(false);
  const [forwardBusy, setForwardBusy] = useState(false);
  const forwardRequestKey = useRef('');
  const [chatMenuOpen,setChatMenuOpen]=useState(false);
  const [menuPoint,setMenuPoint]=useState({x:16,y:80});
  const cancelLongPress=()=>{if(longPressTimerRef.current!==null){window.clearTimeout(longPressTimerRef.current);longPressTimerRef.current=null;}};
  const showChatMenu=(x:number,y:number)=>{setActionMsg(null);setMenuPoint({x,y});setChatMenuOpen(true);};
  useEffect(()=>{const close=(e:KeyboardEvent)=>{if(e.key==='Escape'){setActionMsg(null);setChatMenuOpen(false);}};window.addEventListener('keydown',close);return()=>window.removeEventListener('keydown',close);},[]);
  const [actionMsg, setActionMsg] = useState<ChatMessage | null>(null);
  useEffect(()=>{if(!chatMenuOpen)return;const timer=window.setTimeout(()=>document.querySelector<HTMLElement>('[role="menu"][aria-label="إجراءات المحادثة"] button')?.focus(),0);return()=>window.clearTimeout(timer);},[chatMenuOpen]);
  const [deleteAllTarget, setDeleteAllTarget] = useState<ChatMessage | null>(null);
  const [purgeTarget, setPurgeTarget] = useState<ChatMessage | null>(null);
  const [infoTarget, setInfoTarget] = useState<ChatMessage | null>(null);
  const [infoReceipts, setInfoReceipts] = useState<MessageReceiptDetail[] | null>(null);
  const [infoLoading, setInfoLoading] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);

  // WhatsApp-style personal & group settings
  const [userSettings, setUserSettings] = useState<UserChatSettings>(DEFAULT_USER_SETTINGS);
  const [groupSettings, setGroupSettings] = useState<GroupChatSettings>(DEFAULT_GROUP_SETTINGS);
  const [isMutedInChat, setIsMutedInChat] = useState(false);
  const [uploadingFileName, setUploadingFileName] = useState<string | null>(null);
  useUpdateBlocker(recording||sending||Boolean(uploadingFileName)||Boolean(draft.trim()));
  const [dragOverFiles, setDragOverFiles] = useState(false);
  const [highlightedMessageId, setHighlightedMessageId] = useState<number | null>(null);

  const [chatSettingsOpen, setChatSettingsOpen] = useState(false);
  const [chatSettingsTab, setChatSettingsTab] = useState<'prefs' | 'starred'>('prefs');
  const [starredMessages, setStarredMessages] = useState<ChatMessage[]>([]);
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

  const isAdminOrOwner = user.role === 'admin' || user.role === 'owner';
  const canEditGroupInfo =
    user.role === 'owner' || (user.role === 'admin' && groupSettings.editInfoPolicy === 'mods');

  const canSendInChannel = useMemo(() => {
    if (channel === 'announcements') return isAdminOrOwner;
    if (chatLocked) return isAdminOrOwner;
    if (isMutedInChat && !isAdminOrOwner) return false;
    return true;
  }, [channel, chatLocked, isAdminOrOwner, isMutedInChat]);

  const messageTextSizeClass = useMemo(() => {
    return (
      FONT_SIZE_OPTIONS.find((f) => f.id === userSettings.fontSize)?.textClass ??
      'text-sm leading-relaxed'
    );
  }, [userSettings.fontSize]);

  const currentPinned = groupSettings.pinnedMessages[channel];

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

  const markChannelVisibleRead = useCallback(
    async (msgs: ChatMessage[], targetChannel: ChannelId) => {
      if (document.visibilityState !== 'visible') return;
      const nonDeleted = msgs.filter((m) => m.deletedAt === null);
      if (nonDeleted.length === 0) return;
      const maxId = nonDeleted[nonDeleted.length - 1].id;
      try {
        await apiRequest('/api/chat/read', {
          method: 'POST',
          body: { channel: targetChannel, highestMessageId: maxId },
          background: true,
        });
        onUnreadRefresh();
      } catch {
        // ignore transient read sync failures
      }
    },
    [onUnreadRefresh]
  );

  const loadChannel = useCallback(
    async (targetChannel: ChannelId, isInitial = true) => {
      if (isInitial) {
        setLoading(true);
        setError(null);
      }
      try {
        const res = await apiRequest<{
          messages: ChatMessage[];
          hasMore: boolean;
          chatLocked: boolean;
          typingUsers: Array<{ userId: string; displayName: string }>;
        }>(`/api/chat/messages?channel=${targetChannel}&limit=50`);
        setMessages(res.messages);
        setHasMore(res.hasMore);
        setChatLocked(res.chatLocked);
        setTypingUsers(res.typingUsers);
        if (isInitial) {
          window.setTimeout(() => scrollToBottom(false), 30);
        }
        void markChannelVisibleRead(res.messages, targetChannel);
      } catch (err) {
        if (isInitial) {
          setError(err instanceof ApiError ? err.message : 'تعذر تحميل رسائل القناة');
        }
      } finally {
        if (isInitial) setLoading(false);
      }
    },
    [markChannelVisibleRead, scrollToBottom]
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
      const res = await apiRequest<{ messages: ChatMessage[] }>('/api/chat/starred');
      setStarredMessages(res.messages);
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'تعذر تحميل الرسائل المميزة بنجمة', true);
    } finally {
      setStarredLoading(false);
    }
  }, [onToast]);

  useEffect(() => {
    void loadChatSettings();
  }, [loadChatSettings]);

  useEffect(() => {
    void loadChannel(channel, true);
    void loadHistoryStatus();
  }, [channel, loadChannel, loadHistoryStatus]);

  // Real-time incremental sync on WS events
  const syncIncremental = useCallback(async () => {
    const lastId = messages.length > 0 ? messages[messages.length - 1].id : 0;
    try {
      const res = await apiRequest<{
        messages: ChatMessage[];
        chatLocked: boolean;
        typingUsers: Array<{ userId: string; displayName: string }>;
      }>(`/api/chat/messages?channel=${channel}&afterId=${lastId}`, { background: true });
      setChatLocked(res.chatLocked);
      setTypingUsers(res.typingUsers);
      if (res.messages.length > 0) {
        setMessages((prev) => {
          const map = new Map(prev.map((m) => [m.id, m]));
          for (const m of res.messages) {
            map.set(m.id, m);
          }
          return Array.from(map.values()).sort((a, b) => a.id - b.id);
        });
        if (nearBottom) {
          window.setTimeout(() => scrollToBottom(true), 20);
        } else {
          setShowNewMessagesJump(true);
        }
        void markChannelVisibleRead(res.messages, channel);
      }
      onUnreadRefresh();
    } catch {
      // ignore background sync failures
    }
  }, [channel, markChannelVisibleRead, messages, nearBottom, onUnreadRefresh, scrollToBottom]);

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
        if (ev.channel === 'all' || ev.channel === channel) {
          setMessages([]);
          setSearchResults(null);
          setHasMore(false);
          onToast('تم تنفيذ المحو الكامل لرسائل المحادثة بواسطة المالك');
        }
        onUnreadRefresh();
        void loadChatSettings();
        return;
      }
      if (ev.type === 'typing:updated' && ev.channel === channel) {
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
        ev.channel === channel
      ) {
        if (ev.type === 'message:created') {
          if (userSettings.chatSoundsEnabled && document.visibilityState === 'visible') {
            playChatPing();
          }
          void syncIncremental();
        } else {
          // Re-fetch visible window to reflect edits, tombstones, or reactions accurately
          void apiRequest<{ messages: ChatMessage[] }>(
            `/api/chat/messages?channel=${channel}&limit=${Math.max(50, messages.length)}`,
            { background: true }
          )
            .then((res) => {
              setMessages((prev) => {
                const updatedMap = new Map(res.messages.map((m) => [m.id, m]));
                return prev.map((old) => updatedMap.get(old.id) ?? old);
              });
            })
            .catch(() => {});
        }
        return;
      }
      if (ev.type === 'message:created' && ev.channel !== channel) {
        onUnreadRefresh();
      }
      if (ev.type === 'message:removed' && ev.channel === channel) {
        const remId = Number(ev.messageId);
        setMessages((prev) => prev.filter((m) => m.id !== remId));
        return;
      }
      if (ev.type === 'receipt:updated') {
        void apiRequest<{ messages: ChatMessage[] }>(
          `/api/chat/messages?channel=${channel}&limit=${Math.max(50, messages.length)}`,
          { background: true }
        )
          .then((res) => {
            setMessages((prev) => {
              const updatedMap = new Map(res.messages.map((m) => [m.id, m]));
              return prev.map((old) => updatedMap.get(old.id) ?? old);
            });
          })
          .catch(() => {});
      }
    },
    [
      channel,
      loadChatSettings,
      loadHistoryStatus,
      messages.length,
      onForceLogout,
      onToast,
      onUnreadRefresh,
      onUserRefresh,
      syncIncremental,
      userSettings.chatSoundsEnabled,
    ]
  );

  const { sendJson } = useWebSocket(!privateChatsOpen, handleWsEvent);

  // Realtime events and explicit visibility refresh replace quota-heavy HTTP polling.
  useEffect(() => {
    const refresh = () => { if(document.visibilityState === 'visible') void syncIncremental(); };
    document.addEventListener('visibilitychange',refresh);
    return () => document.removeEventListener('visibilitychange',refresh);
  }, [syncIncremental]);

  // Mark visible messages read when tab becomes visible again
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'visible' && messages.length > 0) {
        void markChannelVisibleRead(messages, channel);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [channel, markChannelVisibleRead, messages]);

  const handleLoadOlder = async () => {
    if (messages.length === 0 || loadingMore) return;
    const container = listRef.current;
    const prevScrollHeight = container?.scrollHeight ?? 0;
    const prevScrollTop = container?.scrollTop ?? 0;

    setLoadingMore(true);
    try {
      const oldestId = messages[0].id;
      const res = await apiRequest<{ messages: ChatMessage[]; hasMore: boolean }>(
        `/api/chat/messages?channel=${channel}&beforeId=${oldestId}&limit=50`
      );
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
    sendJson({ type: 'typing', channel, active });
  };

  const handleSendTextOrEdit = async () => {
    const trimmed = draft.trim();
    if (!trimmed || sending) return;

    if (editingMsg) {
      setSending(true);
      try {
        await apiRequest(`/api/chat/messages/${editingMsg.id}`, {
          method: 'PATCH',
          body: { body: trimmed },
        });
        setMessages((prev) =>
          prev.map((m) => (m.id === editingMsg.id ? { ...m, body: trimmed, editedAt: Date.now() } : m))
        );
        setEditingMsg(null);
        setDraft('');
      } catch (err) {
        onToast(err instanceof ApiError ? err.message : 'تعذر تعديل الرسالة', true);
      } finally {
        setSending(false);
      }
      return;
    }

    if (!canSendInChannel) return;
    const idemp = pendingIdempotencyRef.current || `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    pendingIdempotencyRef.current = idemp;
    setSending(true);
    emitTyping(false);

    try {
      const res = await apiRequest<{ message: ChatMessage }>('/api/chat/messages', {
        method: 'POST',
        body: {
          channel,
          body: trimmed,
          replyToId: replyTo?.id ?? null,
          idempotencyKey: idemp,
        },
      });
      pendingIdempotencyRef.current = null;
      setDraft('');
      setReplyTo(null);
      setShowEmojiPicker(false);
      setMessages((prev) => {
        if (prev.some((m) => m.id === res.message.id)) return prev;
        return [...prev, res.message];
      });
      if (userSettings.chatSoundsEnabled) playChatPing();
      window.setTimeout(() => scrollToBottom(true), 20);
    } catch (err) {
      // Preserve draft text on recoverable error!
      onToast(err instanceof ApiError ? err.message : 'تعذر إرسال الرسالة، حاول مجددًا', true);
    } finally {
      setSending(false);
    }
  };

  const handleSendSticker = async (emoji: string) => {
    if (!canSendInChannel || sending) return;
    setSending(true);
    try {
      const res = await apiRequest<{ message: ChatMessage }>('/api/chat/messages', {
        method: 'POST',
        body: {
          channel,
          body: emoji,
          replyToId: replyTo?.id ?? null,
          idempotencyKey: `stk_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        },
      });
      setReplyTo(null);
      setShowEmojiPicker(false);
      setMessages((prev) =>
        prev.some((m) => m.id === res.message.id) ? prev : [...prev, res.message]
      );
      if (userSettings.chatSoundsEnabled) playChatPing();
      window.setTimeout(() => scrollToBottom(true), 20);
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'تعذر الإرسال', true);
    } finally {
      setSending(false);
    }
  };

  const handleUploadAndSendFile = async (file: File, isImageMode: boolean) => {
    if (!canSendInChannel || sending) return;
    if (!groupSettings.allowMedia && !isAdminOrOwner) {
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
        onToast(`حجم الملف يتجاوز الحد المسموح (${MAX_CHAT_UPLOAD_BYTES / 1_000_000} MB)`, true);
        return;
      }

      const uploaded = await uploadAssetBinary(uploadBlob, uploadName, 'chat_file');
      const res = await apiRequest<{ message: ChatMessage }>('/api/chat/messages', {
        method: 'POST',
        body: {
          channel,
          body: draft.trim(),
          replyToId: replyTo?.id ?? null,
          fileAssetId: uploaded.assetId,
          idempotencyKey: `fil_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        },
      });
      setDraft('');
      setReplyTo(null);
      setMessages((prev) =>
        prev.some((m) => m.id === res.message.id) ? prev : [...prev, res.message]
      );
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
    if (!canSendInChannel || recording) return;
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
        if (blob.size > Math.min(12_000_000, MAX_CHAT_UPLOAD_BYTES)) {
          onToast(`حجم التسجيل الصوتي يتجاوز الحد (${Math.min(12_000_000,MAX_CHAT_UPLOAD_BYTES)/1_000_000} MB)`, true);
          return;
        }
        setSending(true);
        try {
          const ext = (recorder.mimeType || '').includes('ogg') ? '.ogg' : '.webm';
          const uploaded = await uploadAssetBinary(blob, `voice_${Date.now()}${ext}`, 'chat_audio');
          const res = await apiRequest<{ message: ChatMessage }>('/api/chat/messages', {
            method: 'POST',
            body: {
              channel,
              body: '',
              replyToId: replyTo?.id ?? null,
              audioAssetId: uploaded.assetId,
              idempotencyKey: `aud_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            },
          });
          setReplyTo(null);
          setMessages((prev) =>
            prev.some((m) => m.id === res.message.id) ? prev : [...prev, res.message]
          );
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

  const handleReact = async (msg: ChatMessage, emoji: string) => {
    setActionMsg(null);
    if (!groupSettings.allowReactions && !isAdminOrOwner) {
      onToast('التفاعلات معطلة حاليًا في إعدادات الجروب', true);
      return;
    }
    try {
      await apiRequest(`/api/chat/messages/${msg.id}/react`, {
        method: 'POST',
        body: { emoji },
      });
      // Optimistic reload of reactions via incremental check
      const res = await apiRequest<{ messages: ChatMessage[] }>(
        `/api/chat/messages?channel=${channel}&limit=${Math.max(50, messages.length)}`,
        { background: true }
      );
      setMessages(res.messages);
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'تعذر تسجيل التفاعل', true);
    }
  };

  const handleToggleStar = async (msg: ChatMessage) => {
    setActionMsg(null);
    const nextStarred = !msg.starredByMe;
    try {
      await apiRequest(`/api/chat/messages/${msg.id}/star`, {
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

  const handleTogglePin = async (msg: ChatMessage) => {
    setActionMsg(null);
    const isCurrentlyPinned = currentPinned?.id === msg.id;
    try {
      const res = isCurrentlyPinned
        ? await apiRequest<{ groupSettings: GroupChatSettings }>(`/api/chat/pins/${channel}`, {
            method: 'DELETE',
          })
        : await apiRequest<{ groupSettings: GroupChatSettings }>(`/api/chat/messages/${msg.id}/pin`, {
            method: 'POST',
          });
      setGroupSettings(res.groupSettings);
      onToast(isCurrentlyPinned ? 'تم إلغاء تثبيت الرسالة' : 'تم تثبيت الرسالة في أعلى القناة');
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'تعذر تحديث التثبيت', true);
    }
  };

  const handleUnpinChannel = async () => {
    try {
      const res = await apiRequest<{ groupSettings: GroupChatSettings }>(`/api/chat/pins/${channel}`, {
        method: 'DELETE',
      });
      setGroupSettings(res.groupSettings);
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

  const handleHideForMe = async (msg: ChatMessage) => {
    setActionMsg(null);
    try {
      await apiRequest(`/api/chat/messages/${msg.id}/hide`, { method: 'POST' });
      setMessages((prev) => prev.filter((m) => m.id !== msg.id));
      onToast('تم إخفاء الرسالة من عندك فقط');
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'تعذر إخفاء الرسالة', true);
    }
  };

  const handleDeleteForEveryone = async () => {
    if (!deleteAllTarget) return;
    setActionBusy(true);
    try {
      await apiRequest(`/api/chat/messages/${deleteAllTarget.id}`, { method: 'DELETE' });
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
      void loadChatSettings();
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

  const handleOpenMessageInfo = async (msg: ChatMessage) => {
    setActionMsg(null);
    setInfoTarget(msg);
    setInfoLoading(true);
    setInfoReceipts(null);
    try {
      const res = await apiRequest<{ receipts: MessageReceiptDetail[] }>(
        `/api/chat/messages/${msg.id}/info`
      );
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
        void loadChannel(channel, false);
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
      const res = await apiRequest<{ groupSettings: GroupChatSettings }>('/api/chat/settings/group', {
        method: 'PATCH',
        body: patch,
      });
      setGroupSettings(res.groupSettings);
      setChatLocked(res.groupSettings.chatLocked);
      if (patch.disappearingHours !== undefined) {
        void loadChannel(channel, false);
      }
      onToast('تم تحديث إعدادات الجروب');
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'تعذر تحديث إعدادات الجروب', true);
    } finally {
      setSavingGroupSettings(false);
    }
  };

  const handleClearChannelForMe = async () => {
    setActionBusy(true);
    try {
      await apiRequest(`/api/chat/channels/${channel}/clear-for-me`, { method: 'POST' });
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

  const handleExportChannelTxt = async () => {
    try {
      const res = await apiRequest<{ filename: string; text: string }>(
        `/api/chat/channels/${channel}/export`
      );
      const blob = new Blob(['\uFEFF' + res.text], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = res.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      onToast('تم تصدير سجل القناة بصيغة نصية');
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'تعذر تصدير المحادثة', true);
    }
  };

  const handleExecuteCompleteWipe = async () => {
    if (!wipeMode || wipeConfirmText.trim() !== 'محو') return;
    setWipeBusy(true);
    try {
      if (wipeMode === 'channel') {
        await apiRequest(`/api/chat/channels/${channel}/wipe`, { method: 'POST' });
        onToast('تم المحو الكامل لرسائل القناة الحالية من القاعدة لدى الجميع');
      } else {
        await apiRequest('/api/chat/wipe-all', { method: 'POST' });
        onToast('تم المحو الكامل لجميع قنوات المحادثة من القاعدة لدى الجميع');
      }
      setMessages([]);
      setSearchResults(null);
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
      const res = await apiRequest<{ messages: ChatMessage[] }>(
        `/api/chat/search?channel=${channel}&q=${encodeURIComponent(searchQuery.trim())}`
      );
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

  const renderReceiptIcon = (status: ChatMessage['receiptStatus']) => {
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

  if(privateChatsOpen)return <div className="h-full min-h-0 flex flex-col"><button className="shrink-0 min-h-[40px] text-sm font-bold text-[var(--accent)]" onClick={()=>setPrivateChatsOpen(false)}>العودة للمحادثة والمجتمعات</button><div className="flex-1 min-h-0"><ConversationsChatView user={user} onToast={onToast} unreadByChannel={unreadByChannel} onUnreadRefresh={onUnreadRefresh} onOpenMembersAndMedia={onOpenMembersAndMedia} onOpenImage={onOpenImage} onUserRefresh={onUserRefresh} onForceLogout={onForceLogout}/></div></div>;
  if(groupsOpen)return <GroupsView user={user} onBack={()=>setGroupsOpen(false)} onToast={onToast}/>;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[270px_minmax(0,1fr)] h-full min-h-0 rahhala-card overflow-hidden">
      {/* Desktop WhatsApp-Style Split Sidebar */}
      <aside
        aria-label="قنوات وأدوات المحادثة"
        className="hidden lg:flex flex-col border-e border-[var(--divider)] bg-[var(--bg-surface)]/45 min-h-0"
      >
        <div className="p-3.5 border-b border-[var(--divider)]">
          <button
            type="button"
            onClick={() => {
              setGroupNameDraft(groupSettings.groupName);
              setGroupDescDraft(groupSettings.groupDescription);
              setGroupRulesDraft(groupSettings.groupRules);
              setGroupSettingsOpen(true);
            }}
            className="w-full flex items-center gap-2.5 text-right group"
          >
            <div className="w-10 h-10 rounded-xl bg-[var(--accent-soft)] text-[var(--accent)] border border-[var(--accent)]/30 flex items-center justify-center shrink-0">
              <Icons.Users className="w-5 h-5" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="font-extrabold text-sm text-[var(--text-primary)] truncate group-hover:text-[var(--accent)] transition-colors">
                {groupSettings.groupName}
              </div>
              <div className="text-xs text-[var(--text-secondary)] truncate">
                إعدادات ومعلومات الجروب
              </div>
            </div>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-2.5 space-y-1.5">
          <div className="px-2 py-1 text-xs font-bold text-[var(--text-secondary)]">القنوات</div>
          {CHANNELS.map((ch) => {
            const active = channel === ch.id;
            const unread = unreadByChannel[ch.id] || 0;
            return (
              <button
                key={ch.id}
                type="button"
                onClick={() => {
                  setChannel(ch.id);
                  setSearchResults(null);
                  setReplyTo(null);
                  setEditingMsg(null);
                }}
                className={`w-full p-3 rounded-xl text-right flex items-start justify-between gap-2 transition-colors ${
                  active
                    ? 'bg-[var(--accent-soft)] border border-[var(--accent)]/30 text-[var(--text-primary)]'
                    : 'hover:bg-[var(--bg-card)]/70 border border-transparent text-[var(--text-secondary)]'
                }`}
              >
                <div className="min-w-0">
                  <div
                    className={`text-sm font-bold truncate ${
                      active ? 'text-[var(--accent)]' : 'text-[var(--text-primary)]'
                    }`}
                  >
                    {ch.label}
                  </div>
                  <div className="text-xs text-[var(--text-secondary)] truncate mt-0.5">
                    {ch.description}
                  </div>
                </div>
                {unread > 0 && (
                  <span className="min-w-[20px] h-5 px-1.5 rounded-full bg-[var(--accent)] text-[var(--accent-fg)] text-xs font-extrabold flex items-center justify-center tabular-nums shrink-0">
                    {unread}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <div className="p-2.5 border-t border-[var(--divider)] space-y-1.5">
          <button
            type="button"
            onClick={() => {
              setChatSettingsTab('starred');
              void loadStarredMessages();
              setChatSettingsOpen(true);
            }}
            className="w-full min-h-[40px] px-3 rounded-xl hover:bg-[var(--bg-card)] text-xs font-bold text-[var(--text-primary)] flex items-center gap-2 transition-colors"
          >
            <Icons.Star className="w-4 h-4 text-[var(--accent)]" />
            <span>الرسائل المميزة بنجمة</span>
          </button>
          <button
            type="button"
            onClick={onOpenMembersAndMedia}
            className="w-full min-h-[40px] px-3 rounded-xl hover:bg-[var(--bg-card)] text-xs font-bold text-[var(--text-primary)] flex items-center gap-2 transition-colors"
          >
            <Icons.Users className="w-4 h-4 text-[var(--accent)]" />
            <span>الأعضاء والوسائط</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setChatSettingsTab('prefs');
              setChatSettingsOpen(true);
            }}
            className="w-full min-h-[40px] px-3 rounded-xl hover:bg-[var(--bg-card)] text-xs font-bold text-[var(--text-primary)] flex items-center gap-2 transition-colors"
          >
            <Icons.Sliders className="w-4 h-4 text-[var(--accent)]" />
            <span>إعدادات المحادثة</span>
          </button>
        </div>
      </aside>

      {/* Active Chat Column */}
      <div className="flex flex-col min-h-0 min-w-0">
      {/* Chat Header & Channel Tabs */}
      <div data-pinned="chat-header" className="shrink-0 relative z-10 border-b border-[var(--divider)] bg-[var(--bg-card)]">
        <div className="flex items-center gap-2 px-3 sm:px-4 py-2">
          <button type="button" onClick={()=>{setGroupNameDraft(groupSettings.groupName);setGroupDescDraft(groupSettings.groupDescription);setGroupRulesDraft(groupSettings.groupRules);setGroupSettingsOpen(true);}} aria-label="معلومات الجروب" className="flex items-center gap-2.5 min-w-0 flex-1 text-right rounded-xl min-h-[44px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]">
            <div className="w-10 h-10 rounded-full bg-[var(--accent-soft)] text-[var(--accent)] flex items-center justify-center shrink-0"><Icons.Users className="w-5 h-5" /></div>
            <div className="min-w-0">
              <h2 className="font-extrabold text-sm text-[var(--text-primary)] truncate">{groupSettings.groupName}</h2>
              <p className="text-[11px] text-[var(--text-secondary)] truncate mt-0.5">{chatLocked?'الإرسال متاح للمشرفين فقط':'مجتمع الدفعة'}{groupSettings.disappearingHours>0?' · رسائل مؤقتة':''}</p>
            </div>
          </button>
          <button type="button" aria-label="المزيد من خيارات المحادثة" aria-haspopup="menu" aria-expanded={chatMenuOpen} onClick={e=>{const r=e.currentTarget.getBoundingClientRect();showChatMenu(Math.max(12,r.right-288),r.bottom+6);}} className="w-11 h-11 rounded-full shrink-0 flex items-center justify-center text-[var(--text-primary)] hover:bg-[var(--bg-surface)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"><Icons.MoreVertical className="w-5 h-5" /></button>
        </div>
        <div role="tablist" aria-label="قنوات المحادثة" className="flex px-3 sm:px-4 gap-1 border-t border-[var(--divider)]/50">
          {CHANNELS.map(ch=>{const active=channel===ch.id,unread=unreadByChannel[ch.id]||0;return <button key={ch.id} type="button" role="tab" aria-selected={active} onClick={()=>{setSelectedIds([]);setChannel(ch.id);setSearchResults(null);setReplyTo(null);setEditingMsg(null);}} className={`flex-1 min-w-0 min-h-[43px] flex items-center justify-center gap-1.5 border-b-[3px] text-xs font-bold transition-colors ${active?'border-[var(--accent)] text-[var(--accent)]':'border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`}><span>{ch.label}</span>{unread>0&&<span className="min-w-4 h-4 px-1 rounded-full bg-[var(--accent)] text-[var(--accent-fg)] text-[10px] flex items-center justify-center">{unread}</span>}</button>;})}
        </div>
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
            {isAdminOrOwner && (
              <button
                type="button"
                onClick={handleUnpinChannel}
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
              placeholder="ابحث في رسائل القناة…"
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

        {/* History access banner for newer members */}
        {historyState && !historyState.historyGranted && (
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

      {selectedIds.length > 0 && <div className="shrink-0 flex flex-wrap items-center justify-between gap-2 p-2 bg-[var(--bg-card)] border-b border-[var(--divider)]">
        <span className="text-xs font-bold">تم تحديد {selectedIds.length} / 20</span>
        <button className="min-h-[40px] px-3 rounded-xl bg-[var(--accent)] text-[var(--accent-fg)] text-xs font-bold" onClick={() => { forwardRequestKey.current=crypto.randomUUID();setForwardOpen(true); }}>إعادة توجيه</button>
        <button className="min-h-[40px] px-3 text-xs font-bold" onClick={()=>setSelectionDelete('hide')}>حذف عندي</button>
        {selectedIds.every(id=>messages.find(m=>m.id===id)?.canDeleteForEveryone) && <button className="min-h-[40px] px-3 text-xs font-bold text-[var(--error)]" onClick={()=>setSelectionDelete('delete')}>حذف عند الكل</button>}
        <button disabled={selectionBusy} className="min-h-[40px] px-3 text-xs font-bold" onClick={async()=>{setSelectionBusy(true);try{await apiRequest('/api/chat/selection',{method:'POST',body:{messageIds:selectedIds,action:'star'}});setMessages(prev=>prev.map(m=>selectedIds.includes(m.id)?{...m,starredByMe:true}:m));setSelectedIds([]);onToast('تم تمييز الرسائل بنجمة');}catch(e){onToast(e instanceof ApiError?e.message:'تعذر التنفيذ',true);}finally{setSelectionBusy(false);}}}>نجمة</button>
        <button className="min-h-[40px] px-3 text-xs font-bold" onClick={async()=>{try{await navigator.clipboard.writeText(messages.filter(m=>selectedIds.includes(m.id)).map(m=>m.body).filter(Boolean).join('\n\n'));onToast('تم نسخ النصوص');}catch{onToast('تعذر النسخ',true);}}}>نسخ</button>
        <button className="min-h-[40px] px-3 text-xs" onClick={() => setSelectedIds([])}>إلغاء التحديد</button>
      </div>}
      {/* Messages List (with Chat Wallpaper + Drag & Drop File Upload) */}
      <div
        aria-label="رسائل المحادثة"
        ref={listRef}
        onContextMenu={e=>{e.preventDefault();showChatMenu(e.clientX,e.clientY);}}
        onTouchStart={e=>{if(e.target!==e.currentTarget)return;const t=e.touches[0];cancelLongPress();longPressTimerRef.current=window.setTimeout(()=>showChatMenu(t.clientX,t.clientY),550);}}
        onTouchEnd={cancelLongPress} onTouchMove={cancelLongPress} onTouchCancel={cancelLongPress}
        onScroll={handleScroll}
        onDragOver={(e) => {
          if (e.dataTransfer?.types?.includes('Files') && canSendInChannel) {
            e.preventDefault();
            setDragOverFiles(true);
          }
        }}
        onDragLeave={() => setDragOverFiles(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOverFiles(false);
          const dropped = e.dataTransfer?.files?.[0];
          if (dropped && canSendInChannel) {
            void handleUploadAndSendFile(dropped, false);
          }
        }}
        className={`flex-1 min-h-0 overflow-y-auto px-3 sm:px-5 py-4 space-y-3 relative chat-wallpaper-${userSettings.wallpaper}`}
      >
        {dragOverFiles && (
          <div className="sticky top-2 z-20 p-4 rounded-2xl bg-[var(--glass-elevated)] border-2 border-dashed border-[var(--accent)] text-center text-sm font-bold text-[var(--accent)]">
            أفلت ملف PDF أو الصورة أو المستند هنا لإرساله في القناة
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
                <div key={m.id} className="p-3.5 rounded-2xl bg-[var(--bg-surface)] border border-[var(--divider)]">
                  <div className="flex items-center justify-between text-xs text-[var(--text-secondary)] mb-1">
                    <span className="font-bold text-[var(--text-primary)]">{m.senderName}</span>
                    <span>{formatDateTime(m.createdAt)}</span>
                  </div>
                  <p className="text-sm whitespace-pre-wrap break-words">{renderLinkifiedText(m.body)}</p>
                </div>
              ))
            )}
          </div>
        ) : loading ? (
          <ChatMessagesSkeleton />
        ) : error ? (
          <ErrorRetryPanel message={error} onRetry={() => loadChannel(channel, true)} />
        ) : messages.length === 0 ? (
          <EmptyState
            icon={<Icons.MessageSquare className="w-6 h-6" />}
            title="لا توجد رسائل في هذه القناة بعد"
            subtitle={CHANNELS.find((c) => c.id === channel)?.description}
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
                <React.Fragment key={msg.id}>
                  {showDateSep && (
                    <div className="flex justify-center my-2">
                      <span className="px-3 py-1 rounded-lg bg-[var(--bg-surface)] border border-[var(--divider)] text-[11px] font-semibold text-[var(--text-secondary)]">
                        {formatDaySeparator(msg.createdAt)}
                      </span>
                    </div>
                  )}

                  <div
                    className={`flex items-end gap-2 ${isOwn ? 'justify-start' : 'justify-end'} ${selectedIds.includes(msg.id) ? 'bg-[var(--accent-soft)] rounded-xl' : ''}`}
                    onClick={selectedIds.length && !isDeleted ? (e) => { e.preventDefault();setSelectedIds(prev => prev.includes(msg.id) ? prev.filter(id=>id!==msg.id) : prev.length<20 ? [...prev,msg.id] : prev); } : undefined}
                    onContextMenu={(e) => {
                      e.preventDefault();e.stopPropagation();
                      setMenuPoint({x:e.clientX,y:e.clientY});setChatMenuOpen(false);setActionMsg(msg);
                    }}
                    onTouchMove={e=>{const t=e.touches[0],s=swipeStartRef.current;if(s&&(Math.abs(t.clientX-s.x)>12||Math.abs(t.clientY-s.y)>12))cancelLongPress();}} onTouchCancel={()=>{cancelLongPress();swipeStartRef.current=null;}}
                    onTouchStart={(e) => {
                      e.stopPropagation();const t=e.touches[0];swipeStartRef.current={x:t.clientX,y:t.clientY};setMenuPoint({x:t.clientX,y:t.clientY});cancelLongPress();
                      longPressTimerRef.current = window.setTimeout(() => {
                        setActionMsg(msg);
                      }, 500);
                    }}
                    onTouchEnd={e => {
                      const start=swipeStartRef.current,t=e.changedTouches[0];swipeStartRef.current=null;if(start&&Math.abs(t.clientX-start.x)>65&&Math.abs(t.clientY-start.y)<35&&canSendInChannel&&!isDeleted){setReplyTo(msg);setEditingMsg(null);setActionMsg(null);}
                      if (longPressTimerRef.current !== null) {
                        window.clearTimeout(longPressTimerRef.current);
                        longPressTimerRef.current = null;
                      }
                    }}
                  >
                    {selectedIds.length>0 && !isDeleted && <input type="checkbox" aria-label={`تحديد الرسالة ${msg.id}`} checked={selectedIds.includes(msg.id)} onClick={e=>e.stopPropagation()} onChange={()=>setSelectedIds(prev=>prev.includes(msg.id)?prev.filter(id=>id!==msg.id):prev.length<20?[...prev,msg.id]:prev)} className="self-center w-5 h-5 shrink-0" />}
                    {!isOwn && (
                      <Avatar name={msg.senderName} assetId={msg.senderAvatarAssetId} size="sm" />
                    )}

                    <div
                      id={`chat-msg-${msg.id}`}
                      className={`max-w-[85%] sm:max-w-[72%] rounded-2xl px-3.5 py-2.5 border transition-colors ${
                        isOwn ? 'rounded-se-sm bg-[var(--bubble-own)]' : 'rounded-ss-sm bg-[var(--bubble-other)]'
                      } ${
                        highlightedMessageId === msg.id
                          ? 'border-[var(--accent)] ring-2 ring-[var(--accent-soft)]'
                          : 'border-[var(--divider)]'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-3 mb-1">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span className="text-xs font-bold text-[var(--accent)] truncate">
                            {msg.senderName}
                          </span>
                          {msg.senderRole && msg.senderRole !== 'member' && (
                            <span className="text-[11px] text-[var(--text-secondary)]">
                              · {ROLE_LABELS[msg.senderRole]}
                            </span>
                          )}
                        </div>

                        <button
                          type="button"
                          onClick={e => {setMenuPoint({x:e.clientX,y:e.clientY});setChatMenuOpen(false);setActionMsg(msg);}}
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
                            <p className={`${messageTextSizeClass} text-[var(--text-primary)] whitespace-pre-wrap break-words`}>
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
                              disabled={!groupSettings.allowReactions && !isAdminOrOwner}
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
                          <span aria-label="رسالة مميزة بنجمة" title="مميزة بنجمة" className="text-[var(--accent)] inline-flex">
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
            aria-label={showNewMessagesJump ? 'الانتقال إلى الرسائل الجديدة' : 'النزول لأسفل المحادثة'}
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
      {showEmojiPicker && canSendInChannel && (
        <div className="border-t border-[var(--divider)] bg-[var(--bg-elevated)] p-3 space-y-2.5 max-h-60 overflow-y-auto">
          <div className="flex items-center justify-between gap-2">
            <div className="flex gap-1 p-0.5 rounded-lg bg-[var(--bg-surface)]">
              <button
                type="button"
                onClick={() => setEmojiTab('emojis')}
                className={`px-3 py-1.5 rounded-md text-xs font-bold ${
                  emojiTab === 'emojis' ? 'bg-[var(--accent)] text-[var(--accent-fg)]' : 'text-[var(--text-secondary)]'
                }`}
              >
                إيموجي
              </button>
              <button
                type="button"
                onClick={() => setEmojiTab('stickers')}
                className={`px-3 py-1.5 rounded-md text-xs font-bold ${
                  emojiTab === 'stickers' ? 'bg-[var(--accent)] text-[var(--accent-fg)]' : 'text-[var(--text-secondary)]'
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
                رموز تعبيرية كبيرة تُرسل كرسالة مستقلة في القناة الحالية:
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

      <ConfirmDialog open={selectionDelete!==null} onClose={()=>{if(!selectionBusy)setSelectionDelete(null);}} title={selectionDelete==='delete'?'حذف الرسائل عند الجميع؟':'حذف الرسائل عندي؟'} message={selectionDelete==='delete'?`سيتم حذف ${selectedIds.length} رسالة عند جميع الأعضاء. لن يتم حذف أي رسالة إذا كانت إحداها خارج صلاحياتك.`:`سيتم إخفاء ${selectedIds.length} رسالة من شاشتك فقط. تبقى ظاهرة للآخرين.`} confirmLabel="تأكيد الحذف" busy={selectionBusy} onConfirm={async()=>{if(!selectionDelete)return;setSelectionBusy(true);try{await apiRequest('/api/chat/selection',{method:'POST',body:{messageIds:selectedIds,action:selectionDelete}});setSelectionDelete(null);setSelectedIds([]);await loadChannel(channel,true);onToast('تم حذف الرسائل المحددة');}catch(e){onToast(e instanceof ApiError?e.message:'تعذر الحذف',true);}finally{setSelectionBusy(false);}}} />
      <ModalShell open={forwardOpen} onClose={() => {if(!forwardBusy)setForwardOpen(false);}} title="إعادة توجيه الرسائل" maxWidth="max-w-md">
        <p className="text-xs text-[var(--text-secondary)] mb-3">إرسال نسخة من {selectedIds.length} رسالة. المرفقات المنسوخة تُحسب من مساحة حسابك.</p>
        <div className="space-y-2">{CHANNELS.filter(c => c.id!=='announcements'||isAdminOrOwner).map(c=><button key={c.id} disabled={forwardBusy} className="w-full min-h-[44px] rounded-xl bg-[var(--bg-surface)] text-sm font-bold disabled:opacity-50" onClick={async()=>{
          setForwardBusy(true);try{await apiRequest('/api/chat/forward',{method:'POST',body:{messageIds:selectedIds,channel:c.id,requestKey:forwardRequestKey.current}});setForwardOpen(false);setSelectedIds([]);setChannel(c.id);await loadChannel(c.id,true);onToast('تمت إعادة التوجيه');}catch(err){onToast(err instanceof ApiError?err.message:'تعذر إعادة التوجيه',true);}finally{setForwardBusy(false);}
        }}>{forwardBusy?'جاري الإرسال…':c.label}</button>)}</div>
      </ModalShell>
      {/* Composer */}
      <div data-pinned="chat-composer" className="shrink-0 relative z-10 border-t border-[var(--divider)] bg-[var(--bg-card)] p-2.5 sm:p-3 space-y-2">
        {uploadingFileName && (
          <div className="px-3 py-1.5 rounded-xl bg-[var(--accent-soft)] border border-[var(--accent)]/30 text-xs font-semibold text-[var(--accent)] flex items-center justify-between gap-2">
            <span className="truncate">جاري رفع وإرسال: {uploadingFileName}</span>
            <span className="shrink-0 tabular-nums">يرجى الانتظار…</span>
          </div>
        )}

        {!canSendInChannel && !editingMsg ? (
          <div className="min-h-[44px] px-4 py-2.5 rounded-xl bg-[var(--bg-surface)] text-xs font-semibold text-[var(--text-secondary)] text-center flex items-center justify-center gap-2">
            {isMutedInChat && !isAdminOrOwner ? (
              <Icons.VolumeX className="w-4 h-4 text-[var(--error)] shrink-0" />
            ) : (
              <Icons.Lock className="w-4 h-4 text-[var(--accent)] shrink-0" />
            )}
            <span>
              {channel === 'announcements'
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

            {!editingMsg && (groupSettings.allowMedia || isAdminOrOwner) && (
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
              placeholder={editingMsg ? 'عدّل نص الرسالة…' : 'اكتب رسالتك هنا…'}
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
                disabled={sending || (!groupSettings.allowMedia && !isAdminOrOwner)}
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

      {/* Positioned context menus, shared by right click, long press and menu buttons. */}
      {(actionMsg || chatMenuOpen) && createPortal(
        <div className="fixed inset-0 z-[100]" onContextMenu={e=>e.preventDefault()} onClick={()=>{setActionMsg(null);setChatMenuOpen(false);}}>
          <div role="menu" aria-label={actionMsg?'إجراءات الرسالة':'إجراءات المحادثة'} dir="rtl" onClick={e=>e.stopPropagation()} onKeyDown={e=>{const buttons=Array.from(e.currentTarget.querySelectorAll('button'));const i=buttons.indexOf(document.activeElement as HTMLButtonElement);if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();buttons[(i+(e.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length]?.focus();}if(e.key==='Home'){e.preventDefault();buttons[0]?.focus();}if(e.key==='End'){e.preventDefault();buttons.at(-1)?.focus();}}} className="fixed w-[min(300px,calc(100vw-24px))] overflow-y-auto overscroll-contain rounded-2xl border border-[var(--divider)] bg-[var(--bg-card)] p-2 shadow-2xl" style={{left:Math.max(12,Math.min(menuPoint.x,window.innerWidth-312)),top:chatMenuOpen?menuPoint.y:Math.max(12,Math.min(menuPoint.y,window.innerHeight-Math.min(620,window.innerHeight-24)-12)),maxHeight:chatMenuOpen?`calc(100dvh - ${menuPoint.y+12}px)`:'min(620px,calc(100dvh - 24px))'}}>
          {chatMenuOpen && <div className="text-sm font-semibold [&_button]:min-h-[44px] [&_button]:w-full [&_button]:text-right [&_button]:px-3 [&_button]:rounded-lg [&_button:hover]:bg-[var(--bg-surface)] [&_button:focus-visible]:outline [&_button:focus-visible]:outline-2 [&_button:focus-visible]:outline-[var(--accent)]">
            <section role="group" aria-label="التنقل" className="">
              <h3 className="px-3 pt-2 pb-1 text-[10px] font-extrabold text-[var(--accent)]">التنقل</h3>
              <button onClick={()=>{setChatMenuOpen(false);setPrivateChatsOpen(true);}}>المحادثات الخاصة</button>
              <button onClick={()=>{setChatMenuOpen(false);setGroupsOpen(true);}}>المجتمعات والجروبات</button>
            </section>
            <section role="group" aria-label="أدوات المحادثة" className="border-t border-[var(--divider)] mt-1 pt-1">
              <h3 className="px-3 pt-2 pb-1 text-[10px] font-extrabold text-[var(--accent)]">أدوات المحادثة</h3>
              <button onClick={()=>{setChatMenuOpen(false);setSearchOpen(true);setSearchResults(null);}}>بحث في المحادثة</button>
              <button onClick={()=>{setChatMenuOpen(false);setChatSettingsTab('starred');void loadStarredMessages();setChatSettingsOpen(true);}}>الرسائل المميزة بنجمة</button>
              <button onClick={()=>{setChatMenuOpen(false);const first=messages.find(m=>m.deletedAt===null);if(first)setSelectedIds([first.id]);else onToast('لا توجد رسائل لتحديدها');}}>تحديد رسائل</button>
              <button onClick={()=>{setChatMenuOpen(false);void handleExportChannelTxt();}}>تصدير المحادثة كنص</button>
            </section>
            <section role="group" aria-label="الأعضاء والجروب" className="border-t border-[var(--divider)] mt-1 pt-1">
              <h3 className="px-3 pt-2 pb-1 text-[10px] font-extrabold text-[var(--accent)]">الأعضاء والجروب</h3>
              <button onClick={()=>{setChatMenuOpen(false);onOpenMembersAndMedia();}}>الأعضاء والوسائط</button>
              <button onClick={()=>{setChatMenuOpen(false);setGroupNameDraft(groupSettings.groupName);setGroupDescDraft(groupSettings.groupDescription);setGroupRulesDraft(groupSettings.groupRules);setGroupSettingsOpen(true);}}>معلومات الجروب</button>
            </section>
            <section role="group" aria-label="الإعدادات" className="border-t border-[var(--divider)] mt-1 pt-1">
              <h3 className="px-3 pt-2 pb-1 text-[10px] font-extrabold text-[var(--accent)]">الإعدادات</h3>
              <button onClick={()=>{setChatMenuOpen(false);setChatSettingsTab('prefs');setChatSettingsOpen(true);}}>خلفية وإعدادات المحادثة</button>
              <button onClick={()=>{setChatMenuOpen(false);void handleUpdateUserSettings({chatSoundsEnabled:!userSettings.chatSoundsEnabled});}}>{userSettings.chatSoundsEnabled?'كتم أصوات المحادثة':'تشغيل أصوات المحادثة'}</button>
              {isAdminOrOwner&&<button onClick={()=>{setChatMenuOpen(false);void handleToggleLock();}}>{chatLocked?'فتح المحادثة':'قفل المحادثة'}</button>}
            </section>
            <section role="group" aria-label="إجراءات إضافية" className="border-t border-[var(--divider)] mt-1 pt-1">
              <h3 className="px-3 pt-2 pb-1 text-[10px] font-extrabold text-[var(--accent)]">إجراءات إضافية</h3>
              {isAdminOrOwner && <button className="text-[var(--error)]" onClick={()=>{setChatMenuOpen(false);setClearChannelConfirmOpen(true);}}>مسح المحادثة من شاشتي فقط</button>}
              <button onClick={()=>{setChatMenuOpen(false);onCloseChat();}}>إغلاق المحادثة</button>
            </section>
          </div>}
        {actionMsg && (
          <div className="space-y-3">
            {actionMsg.deletedAt === null && <>
              <button className="w-full min-h-[44px] px-3.5 rounded-xl bg-[var(--bg-surface)] text-sm font-semibold text-right" onClick={() => {setSelectedIds([actionMsg.id]);setActionMsg(null);}}>تحديد رسائل</button>
              <button className="w-full min-h-[44px] px-3.5 rounded-xl bg-[var(--bg-surface)] text-sm font-semibold text-right" onClick={() => {setSelectedIds([actionMsg.id]);forwardRequestKey.current=crypto.randomUUID();setActionMsg(null);setForwardOpen(true);}}>إعادة توجيه</button>
            </>}
            {actionMsg.deletedAt === null && (
              <>
                {(groupSettings.allowReactions || isAdminOrOwner) && (
                  <div className="flex items-center justify-between gap-1 p-2 rounded-xl bg-[var(--bg-surface)]">
                    {QUICK_REACTIONS.map((em) => (
                      <button
                        key={em}
                        type="button"
                        onClick={() => handleReact(actionMsg, em)}
                        aria-label={({'👍':'إعجاب','❤️':'قلب','😂':'ضحك','👏':'تصفيق','😊':'ابتسامة','✅':'موافق'} as Record<string,string>)[em]}
                        className="min-h-[40px] min-w-[40px] rounded-lg hover:bg-black/15 text-[10px] font-bold flex items-center justify-center"
                      >
                        {({'👍':'إعجاب','❤️':'قلب','😂':'ضحك','👏':'تصفيق','😊':'ابتسامة','✅':'موافق'} as Record<string,string>)[em]}
                      </button>
                    ))}
                  </div>
                )}

                {canSendInChannel && (
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

                <button
                  type="button"
                  onClick={() => handleToggleStar(actionMsg)}
                  className="w-full min-h-[44px] px-3.5 rounded-xl bg-[var(--bg-surface)] text-sm font-semibold flex items-center gap-2.5"
                >
                  <Icons.Star
                    className={`w-4 h-4 text-[var(--accent)] ${actionMsg.starredByMe ? 'fill-current' : ''}`}
                  />
                  <span>{actionMsg.starredByMe ? 'إزالة النجمة' : 'تمييز بنجمة'}</span>
                </button>

                {isAdminOrOwner && (
                  <button
                    type="button"
                    onClick={() => handleTogglePin(actionMsg)}
                    className="w-full min-h-[44px] px-3.5 rounded-xl bg-[var(--bg-surface)] text-sm font-semibold flex items-center gap-2.5"
                  >
                    <Icons.Pin className="w-4 h-4 text-[var(--accent)]" />
                    <span>
                      {currentPinned?.id === actionMsg.id
                        ? 'إلغاء تثبيت الرسالة في القناة'
                        : 'تثبيت الرسالة في أعلى القناة'}
                    </span>
                  </button>
                )}

                {actionMsg.body && (
                  <button
                    type="button"
                    onClick={async () => {
                      try{await navigator.clipboard.writeText(actionMsg.body);setActionMsg(null);onToast('تم نسخ النص');}catch{onToast('تعذر نسخ النص',true);}
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

            {user.role === 'owner' && (
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
          </div>
        </div>,document.body)}

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
                    <div className="text-sm font-bold text-[var(--text-primary)]">مؤشرات قراءة الرسائل</div>
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
                    <div className="text-sm font-bold text-[var(--text-primary)]">مفتاح Enter للإرسال</div>
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
                  onClick={() => void handleExportChannelTxt()}
                  className="min-h-[44px] px-3.5 rounded-xl bg-[var(--bg-surface)] border border-[var(--divider)] text-xs font-bold text-[var(--text-primary)] flex items-center justify-center gap-2 hover:border-[var(--accent)]"
                >
                  <Icons.Download className="w-4 h-4 text-[var(--accent)]" />
                  <span>تصدير المحادثة (.txt)</span>
                </button>

                <button
                  type="button"
                  onClick={() => setClearChannelConfirmOpen(true)}
                  className="min-h-[44px] px-3.5 rounded-xl bg-[var(--error-soft)] border border-[var(--error)]/30 text-xs font-bold text-[var(--error)] flex items-center justify-center gap-2"
                >
                  <Icons.EyeOff className="w-4 h-4" />
                  <span>مسح الدردشة عندي</span>
                </button>
              </div>
            </div>
          ) : starredLoading ? (
            <div className="py-8 text-center text-sm text-[var(--text-secondary)]">
              جاري تحميل الرسائل المميزة…
            </div>
          ) : starredMessages.length === 0 ? (
            <EmptyState
              icon={<Icons.Star className="w-6 h-6" />}
              title="لا توجد رسائل مميزة بنجمة"
              subtitle="اضغط على خيارات أي رسالة واختر تمييز بنجمة للرجوع إليها بسرعة."
            />
          ) : (
            <div className="space-y-2.5 max-h-[55vh] overflow-y-auto">
              {starredMessages.map((sm) => (
                <div
                  key={sm.id}
                  className="p-3 rounded-xl bg-[var(--bg-surface)] border border-[var(--divider)] space-y-1.5"
                >
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="font-bold text-[var(--accent)]">{sm.senderName}</span>
                    <div className="flex items-center gap-2">
                      <span className="text-[var(--text-secondary)] tabular-nums">
                        {formatDateTime(sm.createdAt)}
                      </span>
                      <button
                        type="button"
                        onClick={async () => {
                          await handleToggleStar(sm);
                          setStarredMessages((prev) => prev.filter((x) => x.id !== sm.id));
                        }}
                        aria-label="إزالة النجمة"
                        className="text-[var(--accent)] hover:text-[var(--error)]"
                      >
                        <Icons.Star className="w-4 h-4 fill-current" />
                      </button>
                    </div>
                  </div>
                  <p className="text-sm text-[var(--text-primary)] whitespace-pre-wrap break-words">
                    {sm.body || (sm.audioAttachment ? 'رسالة صوتية' : sm.fileAttachment?.filename || 'مرفق')}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      </ModalShell>

      {/* WhatsApp-Style Group Info & Settings Modal */}
      <ModalShell
        open={groupSettingsOpen}
        onClose={() => setGroupSettingsOpen(false)}
        title="معلومات وإعدادات الجروب"
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
                  اسم الجروب
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
                  وصف الجروب
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
                  قوانين وضوابط المجموعة
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
                {savingGroupSettings ? 'جاري الحفظ…' : 'حفظ معلومات الجروب'}
              </button>
            </form>
          ) : (
            <div className="space-y-3">
              <div className="p-3.5 rounded-xl bg-[var(--bg-surface)] border border-[var(--divider)]">
                <div className="text-xs text-[var(--text-secondary)]">اسم الجروب</div>
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
                <div className="text-xs text-[var(--text-secondary)]">قوانين المجموعة</div>
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
                    <div className="text-sm font-bold text-[var(--text-primary)]">قفل الإرسال للأعضاء</div>
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
                    <div className="text-sm font-bold text-[var(--text-primary)]">السماح بالملفات والوسائط</div>
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
                    <div className="text-sm font-bold text-[var(--text-primary)]">السماح بالتفاعلات</div>
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
                    من يملك تعديل معلومات الجروب؟
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
                يمسح جميع الرسائل والملفات المرفقة والتفاعلات من قاعدة البيانات نهائيًا عند الجميع.
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
                  المحو الكامل لقناة {CHANNELS.find((c) => c.id === channel)?.label}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setWipeConfirmText('');
                    setWipeMode('all');
                  }}
                  className="min-h-[44px] px-3 rounded-xl bg-[var(--error)] text-white text-xs font-bold"
                >
                  المحو الكامل لجميع المحادثات
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
        title={wipeMode === 'all' ? 'تأكيد المحو الكامل لجميع المحادثات' : 'تأكيد المحو الكامل للقناة'}
        maxWidth="max-w-sm"
      >
        <div className="space-y-4">
          <p className="text-sm text-[var(--text-primary)] leading-relaxed">
            {wipeMode === 'all'
              ? 'سيتم مسح جميع الرسائل والملفات والتسجيلات الصوتية في كل القنوات (إعلانات، أسئلة، عام) من قاعدة البيانات نهائيًا ولا يمكن التراجع.'
              : `سيتم مسح جميع الرسائل والمرفقات في قناة "${CHANNELS.find((c) => c.id === channel)?.label}" من قاعدة البيانات نهائيًا ولا يمكن التراجع.`}
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
                  <div className="text-sm font-bold text-[var(--text-primary)]">{r.displayName}</div>
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
    </div>
  );
}
