import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CHANNELS,
  ROLE_LABELS,
  type AuthUser,
  type ChannelId,
  type ChatMessage,
  type HistoryRequestRecord,
  type MessageReceiptDetail,
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

const QUICK_REACTIONS = ['👍', '❤️', '😂', '🤲', '📚', '🔥'];
const STICKER_EMOJIS = ['📚', '🎓', '👍', '❤️', '🤲', '✨', '📝', '☕', '🌟', '👏', '💡', '🕌'];
const MAX_VOICE_SECONDS = 15 * 60; // 15 minutes

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

  return (
    <div className="mt-1.5 p-3 rounded-xl bg-black/15 border border-[var(--divider)] max-w-xs space-y-2">
      <div className="flex items-start gap-2.5">
        <div className="w-9 h-9 rounded-lg bg-[var(--accent-soft)] text-[var(--accent)] flex items-center justify-center shrink-0">
          <Icons.FileText className="w-4 h-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div dir="ltr" className="text-xs font-bold text-[var(--text-primary)] truncate text-left">
            {filename}
          </div>
          <div className="text-[11px] text-[var(--text-secondary)] tabular-nums">
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
  const longPressTimerRef = useRef<number | null>(null);

  // Action menus & modals
  const [actionMsg, setActionMsg] = useState<ChatMessage | null>(null);
  const [deleteAllTarget, setDeleteAllTarget] = useState<ChatMessage | null>(null);
  const [purgeTarget, setPurgeTarget] = useState<ChatMessage | null>(null);
  const [infoTarget, setInfoTarget] = useState<ChatMessage | null>(null);
  const [infoReceipts, setInfoReceipts] = useState<MessageReceiptDetail[] | null>(null);
  const [infoLoading, setInfoLoading] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);

  const isAdminOrOwner = user.role === 'admin' || user.role === 'owner';
  const canSendInChannel = useMemo(() => {
    if (channel === 'announcements') return isAdminOrOwner;
    if (chatLocked) return isAdminOrOwner;
    return true;
  }, [channel, chatLocked, isAdminOrOwner]);

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
        return;
      }
      if (ev.type === 'chat:lock_changed') {
        setChatLocked(Boolean(ev.locked));
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
      loadHistoryStatus,
      messages.length,
      onForceLogout,
      onUnreadRefresh,
      onUserRefresh,
      syncIncremental,
    ]
  );

  const { sendJson } = useWebSocket(true, handleWsEvent);

  // Adaptive background polling fallback when tab is visible
  useEffect(() => {
    const intervalMs = document.visibilityState === 'visible' ? 12_000 : 45_000;
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        void syncIncremental();
      }
    }, intervalMs);
    return () => window.clearInterval(id);
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
      window.setTimeout(() => scrollToBottom(true), 20);
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'تعذر الإرسال', true);
    } finally {
      setSending(false);
    }
  };

  const handleUploadAndSendFile = async (file: File, isImageMode: boolean) => {
    if (!canSendInChannel || sending) return;
    setSending(true);
    try {
      let uploadBlob: Blob = file;
      let uploadName = file.name;
      if (isImageMode || file.type.startsWith('image/')) {
        const resized = await resizeImageForUpload(file, 1600, 0.85);
        uploadBlob = resized.blob;
        uploadName = resized.filename;
      }

      if (uploadBlob.size > 15_000_000) {
        onToast('حجم الملف يتجاوز الحد الأقصى المسموح به (١٥ ميجابايت)', true);
        setSending(false);
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
      window.setTimeout(() => scrollToBottom(true), 20);
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'تعذر رفع أو إرسال الملف', true);
    } finally {
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
        if (blob.size > 12_000_000) {
          onToast('حجم التسجيل الصوتي يتجاوز ١٢ ميجابايت', true);
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
                deletedAt: Date.now(),
              }
            : m
        )
      );
      setDeleteAllTarget(null);
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
      onToast('تمت إزالة الرسالة نهائيًا من المحادثة');
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
      onToast(res.chatLocked ? 'تم قفل المحادثة على الأعضاء' : 'تم فتح المحادثة للجميع');
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'تعذر تغيير حالة المحادثة', true);
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

  return (
    <div className="flex flex-col h-[calc(100dvh-136px)] md:h-[calc(100dvh-96px)] max-h-[calc(100dvh-136px)] md:max-h-[calc(100dvh-96px)] rahhala-card overflow-hidden">
      {/* Chat Header & Channel Tabs */}
      <div className="shrink-0 border-b border-[var(--divider)] bg-[var(--bg-card)] px-3 sm:px-4 py-2.5 space-y-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1 p-1 rounded-xl bg-[var(--bg-surface)]">
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
                  className={`min-h-[38px] px-3 sm:px-4 rounded-lg text-xs sm:text-sm font-bold flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 ${
                    active
                      ? 'bg-[var(--accent)] text-[var(--accent-fg)]'
                      : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                  }`}
                >
                  <span>{ch.label}</span>
                  {unread > 0 && (
                    <span
                      className={`text-[11px] font-extrabold tabular-nums ${
                        active ? 'text-[var(--accent-fg)]' : 'text-[var(--accent)]'
                      }`}
                    >
                      ({unread})
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          <div className="flex items-center gap-1.5">
            {isAdminOrOwner && (
              <button
                type="button"
                onClick={handleToggleLock}
                className={`min-h-[40px] px-3 rounded-xl border text-xs font-bold flex items-center gap-1.5 ${
                  chatLocked
                    ? 'bg-[var(--error-soft)] border-[var(--error)]/40 text-[var(--error)]'
                    : 'bg-[var(--bg-surface)] border-[var(--divider)] text-[var(--text-primary)]'
                }`}
              >
                {chatLocked ? <Icons.Lock className="w-3.5 h-3.5" /> : <Icons.Unlock className="w-3.5 h-3.5" />}
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
              onClick={onOpenMembersAndMedia}
              className="min-h-[40px] px-3 rounded-xl bg-[var(--bg-surface)] border border-[var(--divider)] text-[var(--text-primary)] text-xs font-bold flex items-center gap-1.5 hover:border-[var(--accent)] whitespace-nowrap"
            >
              <Icons.Users className="w-4 h-4 text-[var(--accent)]" />
              <span className="hidden sm:inline">الأعضاء والوسائط</span>
            </button>
          </div>
        </div>

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

      {/* Messages List */}
      <div
        ref={listRef}
        onScroll={handleScroll}
        className="flex-1 min-h-0 overflow-y-auto px-3 sm:px-5 py-4 space-y-3 relative"
      >
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
          <div className="space-y-3">
            {[1, 2, 3, 4].map((k) => (
              <div key={k} className="h-16 rounded-2xl bg-[var(--bg-surface)] animate-pulse w-3/4" />
            ))}
          </div>
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
                    className={`flex items-end gap-2 ${isOwn ? 'justify-start' : 'justify-end'}`}
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
                      <Avatar name={msg.senderName} assetId={msg.senderAvatarAssetId} size="sm" />
                    )}

                    <div
                      className={`max-w-[85%] sm:max-w-[72%] rounded-2xl px-3.5 py-2.5 border border-[var(--divider)] ${
                        isOwn ? 'bg-[var(--bubble-own)]' : 'bg-[var(--bubble-other)]'
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
                            <p className="text-sm text-[var(--text-primary)] whitespace-pre-wrap break-words leading-relaxed">
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

        {showNewMessagesJump && (
          <button
            type="button"
            onClick={() => scrollToBottom(true)}
            className="sticky bottom-2 mx-auto flex items-center gap-1.5 px-4 min-h-[40px] rounded-full bg-[var(--accent)] text-[var(--accent-fg)] text-xs font-bold shadow-lg"
          >
            <Icons.ArrowDown className="w-3.5 h-3.5" />
            <span>رسايل جديدة</span>
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

      {/* Composer */}
      <div className="shrink-0 border-t border-[var(--divider)] bg-[var(--bg-card)] p-2.5 sm:p-3">
        {!canSendInChannel && !editingMsg ? (
          <div className="min-h-[44px] px-4 py-2.5 rounded-xl bg-[var(--bg-surface)] text-xs font-semibold text-[var(--text-secondary)] text-center flex items-center justify-center gap-2">
            <Icons.Lock className="w-4 h-4 text-[var(--accent)] shrink-0" />
            <span>
              {channel === 'announcements'
                ? 'قناة الإعلانات للقراءة فقط — النشر متاح للمشرفين والمالك.'
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
              accept=".pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,image/*,audio/*"
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

            {!draft.trim() && !editingMsg && (
              <>
                <button
                  type="button"
                  disabled={sending}
                  onClick={() => fileInputRef.current?.click()}
                  aria-label="إرفاق ملف"
                  className="min-h-[44px] min-w-[44px] rounded-xl bg-[var(--bg-surface)] text-[var(--text-secondary)] hover:text-[var(--accent)] flex items-center justify-center shrink-0"
                >
                  <Icons.Paperclip className="w-5 h-5" />
                </button>
                <button
                  type="button"
                  disabled={sending}
                  onClick={() => imageInputRef.current?.click()}
                  aria-label="إرسال صورة"
                  className="min-h-[44px] min-w-[44px] rounded-xl bg-[var(--bg-surface)] text-[var(--text-secondary)] hover:text-[var(--accent)] flex items-center justify-center shrink-0"
                >
                  <Icons.Image className="w-5 h-5" />
                </button>
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
                disabled={sending}
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
                <span>حذف نهائي (للمالك فقط)</span>
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
        title="حذف نهائي من المحادثة"
        message="سيتم إزالة هذه الرسالة من سجل المحادثة الظاهر دون ترك أثر (تم الحذف). هذا الإجراء يزيلها من المحادثة الحالية فقط ولا يعد بحذف النسخ الاحتياطية الخارجية إن وُجدت."
        confirmLabel="حذف نهائي"
        destructive
        busy={actionBusy}
      />

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
