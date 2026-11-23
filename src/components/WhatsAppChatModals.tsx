import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ROLE_LABELS,
  type AuthUser,
  type ConversationMemberInfo,
  type ConversationSummary,
  type DisappearingHours,
  type PublicMember,
} from '../../shared/types';
import { ApiError, apiRequest } from '../lib/api';
import { Icons } from './Icons';
import { Avatar, ConfirmDialog, ModalShell } from './UI';

const DISAPPEARING_CHOICES: Array<{ hours: DisappearingHours; label: string }> = [
  { hours: 0, label: 'معطّلة' },
  { hours: 24, label: '٢٤ ساعة' },
  { hours: 168, label: '٧ أيام' },
  { hours: 720, label: '٣٠ يومًا' },
];

export function formatSafetyFingerprintBlocks(fingerprint: string): string[] {
  const digits = fingerprint.replace(/\s+/g, '');
  const blocks: string[] = [];
  for (let i = 0; i < digits.length; i += 5) {
    blocks.push(digits.slice(i, i + 5));
  }
  return blocks;
}

export function NewDmModal({
  open,
  onClose,
  currentUser,
  onConversationReady,
  onToast,
}: {
  open: boolean;
  onClose: () => void;
  currentUser: AuthUser;
  onConversationReady: (conv: ConversationSummary) => void;
  onToast: (msg: string, isError?: boolean) => void;
}) {
  const [members, setMembers] = useState<PublicMember[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [startingUserId, setStartingUserId] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setLoading(true);
    apiRequest<{ members: PublicMember[] }>('/api/members')
      .then((res) => {
        setMembers(res.members.filter((m) => m.id !== currentUser.id));
      })
      .catch((err) => {
        onToast(err instanceof ApiError ? err.message : 'تعذر تحميل قائمة الأعضاء', true);
      })
      .finally(() => setLoading(false));
  }, [currentUser.id, onToast, open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return members;
    return members.filter(
      (m) =>
        m.displayName.toLowerCase().includes(q) || m.username.toLowerCase().includes(q)
    );
  }, [members, query]);

  const startDm = async (targetUserId: string) => {
    if (startingUserId) return;
    setStartingUserId(targetUserId);
    try {
      const res = await apiRequest<{ conversation: ConversationSummary }>(
        '/api/chat/conversations/dm',
        {
          method: 'POST',
          body: { targetUserId },
        }
      );
      onConversationReady(res.conversation);
      onClose();
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'تعذر فتح المحادثة الخاصة', true);
    } finally {
      setStartingUserId(null);
    }
  };

  return (
    <ModalShell open={open} onClose={onClose} title="محادثة خاصة جديدة" maxWidth="max-w-md">
      <div className="space-y-3">
        <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-[var(--success-soft)] border border-[var(--success)]/25 text-xs text-[var(--text-primary)]">
          <Icons.Lock className="w-4 h-4 text-[var(--success)] shrink-0" />
          <span>المحادثات الخاصة بين الأعضاء مشفرة بتشفير AES-256-GCM ومقصورة على الطرفين فقط.</span>
        </div>

        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="ابحث باسم العضو أو @اسم_المستخدم…"
          className="rahhala-input w-full px-3.5 py-2.5 text-sm"
        />

        <div className="max-h-[52vh] overflow-y-auto divide-y divide-[var(--divider)] rounded-2xl border border-[var(--divider)] bg-[var(--bg-surface)]">
          {loading ? (
            <div className="py-8 text-center text-sm text-[var(--text-secondary)]">
              جاري تحميل الأعضاء…
            </div>
          ) : filtered.length === 0 ? (
            <div className="py-8 text-center text-sm text-[var(--text-secondary)]">
              لا يوجد أعضاء مطابقون لبحثك
            </div>
          ) : (
            filtered.map((m) => (
              <button
                key={m.id}
                type="button"
                disabled={Boolean(startingUserId)}
                onClick={() => void startDm(m.id)}
                className="w-full px-3.5 py-3 flex items-center justify-between gap-3 text-right hover:bg-[var(--bg-card)] transition-colors disabled:opacity-60"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <Avatar name={m.displayName} assetId={m.avatarAssetId} size="md" />
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-sm font-bold text-[var(--text-primary)] truncate">
                        {m.displayName}
                      </span>
                      {m.role !== 'member' && (
                        <span className="text-[11px] font-semibold text-[var(--accent)]">
                          · {ROLE_LABELS[m.role]}
                        </span>
                      )}
                    </div>
                    <div dir="ltr" className="text-xs text-[var(--text-secondary)] truncate text-right">
                      @{m.username}
                    </div>
                  </div>
                </div>
                <span className="text-xs font-bold text-[var(--accent)] shrink-0 whitespace-nowrap">
                  {startingUserId === m.id ? 'جاري الفتح…' : 'مراسلة'}
                </span>
              </button>
            ))
          )}
        </div>
      </div>
    </ModalShell>
  );
}

export function NewGroupModal({
  open,
  onClose,
  currentUser,
  onGroupCreated,
  onToast,
}: {
  open: boolean;
  onClose: () => void;
  currentUser: AuthUser;
  onGroupCreated: (conv: ConversationSummary) => void;
  onToast: (msg: string, isError?: boolean) => void;
}) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [members, setMembers] = useState<PublicMember[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTitle('');
    setDescription('');
    setSelectedIds([]);
    setSearch('');
    setLoading(true);
    apiRequest<{ members: PublicMember[] }>('/api/members')
      .then((res) => setMembers(res.members.filter((m) => m.id !== currentUser.id)))
      .catch((err) =>
        onToast(err instanceof ApiError ? err.message : 'تعذر تحميل قائمة الأعضاء', true)
      )
      .finally(() => setLoading(false));
  }, [currentUser.id, onToast, open]);

  const filteredMembers = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return members;
    return members.filter(
      (m) =>
        m.displayName.toLowerCase().includes(q) || m.username.toLowerCase().includes(q)
    );
  }, [members, search]);

  const toggleMember = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (title.trim().length < 2) {
      onToast('اكتب اسمًا للمجموعة لا يقل عن حرفين', true);
      return;
    }
    if (selectedIds.length === 0) {
      onToast('اختر عضوًا واحدًا على الأقل لإضافته إلى المجموعة', true);
      return;
    }
    setCreating(true);
    try {
      const res = await apiRequest<{ conversation: ConversationSummary }>(
        '/api/chat/conversations/groups',
        {
          method: 'POST',
          body: {
            title: title.trim(),
            description: description.trim(),
            memberIds: selectedIds,
          },
        }
      );
      onToast('تم إنشاء المجموعة المشفرة بنجاح');
      onGroupCreated(res.conversation);
      onClose();
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'تعذر إنشاء المجموعة', true);
    } finally {
      setCreating(false);
    }
  };

  return (
    <ModalShell open={open} onClose={onClose} title="إنشاء مجموعة مشفرة جديدة" maxWidth="max-w-md">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-xs font-bold text-[var(--text-secondary)] mb-1">
            اسم المجموعة
          </label>
          <input
            type="text"
            required
            minLength={2}
            maxLength={60}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="مثال: مجموعة مراجعة الفقه"
            className="rahhala-input w-full px-3.5 py-2.5 text-sm"
          />
        </div>

        <div>
          <label className="block text-xs font-bold text-[var(--text-secondary)] mb-1">
            وصف المجموعة (اختياري)
          </label>
          <textarea
            rows={2}
            maxLength={240}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="نبذة مختصرة عن هدف المجموعة…"
            className="rahhala-input w-full px-3.5 py-2 text-sm resize-none"
          />
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="font-bold text-[var(--text-secondary)]">اختر أعضاء المجموعة</span>
            <span className="font-bold text-[var(--accent)] tabular-nums">
              المختارون: {selectedIds.length}
            </span>
          </div>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="ابحث عن عضو لإضافته…"
            className="rahhala-input w-full px-3 py-2 text-xs"
          />

          <div className="max-h-48 overflow-y-auto divide-y divide-[var(--divider)] rounded-2xl border border-[var(--divider)] bg-[var(--bg-surface)]">
            {loading ? (
              <div className="py-6 text-center text-xs text-[var(--text-secondary)]">
                جاري تحميل الأعضاء…
              </div>
            ) : filteredMembers.length === 0 ? (
              <div className="py-6 text-center text-xs text-[var(--text-secondary)]">
                لا يوجد أعضاء مطابقون
              </div>
            ) : (
              filteredMembers.map((m) => {
                const checked = selectedIds.includes(m.id);
                return (
                  <label
                    key={m.id}
                    className="px-3 py-2.5 flex items-center justify-between gap-2.5 cursor-pointer hover:bg-[var(--bg-card)] transition-colors"
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <Avatar name={m.displayName} assetId={m.avatarAssetId} size="sm" />
                      <div className="min-w-0">
                        <div className="text-xs font-bold text-[var(--text-primary)] truncate">
                          {m.displayName}
                        </div>
                        <div dir="ltr" className="text-[11px] text-[var(--text-secondary)] truncate text-right">
                          @{m.username}
                        </div>
                      </div>
                    </div>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleMember(m.id)}
                      className="w-5 h-5 accent-[var(--accent)] shrink-0"
                    />
                  </label>
                );
              })
            )}
          </div>
        </div>

        <button
          type="submit"
          disabled={creating || title.trim().length < 2 || selectedIds.length === 0}
          className="min-h-[44px] w-full rounded-xl bg-[var(--accent)] text-[var(--accent-fg)] text-sm font-bold disabled:opacity-50"
        >
          {creating ? 'جاري إنشاء المجموعة…' : `إنشاء المجموعة (${selectedIds.length + 1} أعضاء)`}
        </button>
      </form>
    </ModalShell>
  );
}

export function EncryptionInfoModal({
  open,
  onClose,
  conversation,
  onToast,
}: {
  open: boolean;
  onClose: () => void;
  conversation: ConversationSummary | null;
  onToast: (msg: string, isError?: boolean) => void;
}) {
  if (!conversation) return null;
  const blocks = formatSafetyFingerprintBlocks(conversation.keyFingerprint);

  return (
    <ModalShell open={open} onClose={onClose} title="التحقق من تشفير المحادثة" maxWidth="max-w-md">
      <div className="space-y-4">
        <div className="p-4 rounded-2xl bg-[var(--success-soft)] border border-[var(--success)]/30 flex items-start gap-3">
          <div className="w-10 h-10 rounded-xl bg-[var(--success)]/20 text-[var(--success)] flex items-center justify-center shrink-0">
            <Icons.ShieldCheck className="w-5 h-5" />
          </div>
          <div className="space-y-1 text-xs leading-relaxed text-[var(--text-primary)]">
            <div className="font-extrabold text-sm">حماية موثقة بتشفير AES-256-GCM</div>
            <p className="text-[var(--text-secondary)]">
              تمتلك هذه المحادثة مفتاح تشفير مستقلاً (256-bit) ومغلفًا عبر اشتقاق HKDF-SHA256،
              ويتم التحقق من سلامة كل رسالة ومنع وصول غير الأعضاء في الرسائل والمرفقات والبحث.
            </p>
          </div>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-[var(--text-secondary)]">
              رمز الأمان الخاص بالمحادثة (٦٠ رقمًا)
            </span>
            <button
              type="button"
              onClick={() => {
                navigator.clipboard?.writeText(blocks.join(' ')).catch(() => {});
                onToast('تم نسخ رمز الأمان');
              }}
              className="min-h-[34px] px-2.5 rounded-lg bg-[var(--bg-surface)] border border-[var(--divider)] text-xs font-bold text-[var(--accent)] flex items-center gap-1"
            >
              <Icons.Copy className="w-3.5 h-3.5" />
              <span>نسخ</span>
            </button>
          </div>

          <div
            dir="ltr"
            className="grid grid-cols-4 gap-2 p-3.5 rounded-2xl bg-[var(--bg-surface)] border border-[var(--divider)] font-mono text-sm font-bold text-[var(--text-primary)] text-center tabular-nums"
          >
            {blocks.map((block, idx) => (
              <span key={idx} className="py-1 rounded-lg bg-[var(--bg-card)]/60">
                {block}
              </span>
            ))}
          </div>
        </div>
      </div>
    </ModalShell>
  );
}

export function CustomGroupInfoModal({
  open,
  onClose,
  conversation,
  currentUser,
  onOpenEncryption,
  onConversationUpdated,
  onConversationLeft,
  onClearedForMe,
  onExportTxt,
  onToast,
}: {
  open: boolean;
  onClose: () => void;
  conversation: ConversationSummary | null;
  currentUser: AuthUser;
  onOpenEncryption: () => void;
  onConversationUpdated: (updated: ConversationSummary) => void;
  onConversationLeft: (convId: string) => void;
  onClearedForMe: (convId: string) => void;
  onExportTxt: (convId: string) => void;
  onToast: (msg: string, isError?: boolean) => void;
}) {
  const [detailConv, setDetailConv] = useState<ConversationSummary | null>(conversation);
  const [members, setMembers] = useState<ConversationMemberInfo[]>([]);
  const [loading, setLoading] = useState(false);

  const [titleDraft, setTitleDraft] = useState('');
  const [descDraft, setDescDraft] = useState('');
  const [savingMeta, setSavingMeta] = useState(false);

  const [showAddPicker, setShowAddPicker] = useState(false);
  const [allMembers, setAllMembers] = useState<PublicMember[]>([]);
  const [addSearch, setAddSearch] = useState('');
  const [addingUserId, setAddingUserId] = useState<string | null>(null);
  const [busyMemberId, setBusyMemberId] = useState<string | null>(null);

  const [confirmClearOpen, setConfirmClearOpen] = useState(false);
  const [confirmLeaveOpen, setConfirmLeaveOpen] = useState(false);
  const [confirmBusy, setConfirmBusy] = useState(false);

  const loadDetails = useCallback(async () => {
    if (!conversation) return;
    setLoading(true);
    try {
      const res = await apiRequest<{
        conversation: ConversationSummary;
        members: ConversationMemberInfo[];
      }>(`/api/chat/conversations/${conversation.id}`);
      setDetailConv(res.conversation);
      setMembers(res.members);
      setTitleDraft(res.conversation.title);
      setDescDraft(res.conversation.description);
      onConversationUpdated(res.conversation);
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'تعذر تحميل معلومات المحادثة', true);
    } finally {
      setLoading(false);
    }
  }, [conversation, onConversationUpdated, onToast]);

  useEffect(() => {
    if (!open || !conversation) return;
    setDetailConv(conversation);
    setTitleDraft(conversation.title);
    setDescDraft(conversation.description);
    setShowAddPicker(false);
    setAddSearch('');
    void loadDetails();
  }, [conversation, loadDetails, open]);

  if (!conversation) return null;
  const activeConv = detailConv || conversation;
  const isGroup = activeConv.kind === 'group';
  const isGroupAdmin = isGroup && activeConv.myRole === 'admin';

  const openAddMembersPicker = async () => {
    setShowAddPicker((v) => !v);
    if (allMembers.length > 0) return;
    try {
      const res = await apiRequest<{ members: PublicMember[] }>('/api/members');
      setAllMembers(res.members);
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'تعذر تحميل الأعضاء', true);
    }
  };

  const existingIds = new Set(members.map((m) => m.userId));
  const addableMembers = allMembers.filter((m) => {
    if (existingIds.has(m.id)) return false;
    const q = addSearch.trim().toLowerCase();
    if (!q) return true;
    return m.displayName.toLowerCase().includes(q) || m.username.toLowerCase().includes(q);
  });

  const handlePatchSettings = async (
    patch: Partial<{
      title: string;
      description: string;
      onlyAdminsSend: boolean;
      disappearingHours: DisappearingHours;
    }>
  ) => {
    setSavingMeta(true);
    try {
      const res = await apiRequest<{ conversation: ConversationSummary }>(
        `/api/chat/conversations/${activeConv.id}`,
        { method: 'PATCH', body: patch }
      );
      setDetailConv(res.conversation);
      onConversationUpdated(res.conversation);
      onToast('تم تحديث إعدادات المحادثة');
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'تعذر تحديث الإعدادات', true);
    } finally {
      setSavingMeta(false);
    }
  };

  const handleToggleMute = async () => {
    try {
      const nextMuted = !activeConv.mutedNotifications;
      await apiRequest(`/api/chat/conversations/${activeConv.id}/mute`, {
        method: 'POST',
        body: { muted: nextMuted },
      });
      const updated = { ...activeConv, mutedNotifications: nextMuted };
      setDetailConv(updated);
      onConversationUpdated(updated);
      onToast(nextMuted ? 'تم كتم إشعارات المحادثة' : 'تم تفعيل إشعارات المحادثة');
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'تعذر تحديث الإشعارات', true);
    }
  };

  const handleAddSingleMember = async (userId: string) => {
    setAddingUserId(userId);
    try {
      await apiRequest(`/api/chat/conversations/${activeConv.id}/members`, {
        method: 'POST',
        body: { userIds: [userId] },
      });
      onToast('تمت إضافة العضو إلى المجموعة');
      await loadDetails();
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'تعذر إضافة العضو', true);
    } finally {
      setAddingUserId(null);
    }
  };

  const handleToggleAdminRole = async (m: ConversationMemberInfo) => {
    setBusyMemberId(m.userId);
    const nextRole = m.role === 'admin' ? 'member' : 'admin';
    try {
      await apiRequest(`/api/chat/conversations/${activeConv.id}/members/${m.userId}/role`, {
        method: 'PATCH',
        body: { role: nextRole },
      });
      await loadDetails();
      onToast(nextRole === 'admin' ? 'تمت ترقية العضو لمشرف مجموعة' : 'تم سحب صلاحية إشراف المجموعة');
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'تعذر تغيير الدور', true);
    } finally {
      setBusyMemberId(null);
    }
  };

  const handleRemoveMember = async (targetId: string) => {
    setBusyMemberId(targetId);
    try {
      await apiRequest(`/api/chat/conversations/${activeConv.id}/members/${targetId}`, {
        method: 'DELETE',
      });
      onToast('تمت إزالة العضو من المجموعة');
      await loadDetails();
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'تعذر إزالة العضو', true);
    } finally {
      setBusyMemberId(null);
    }
  };

  const handleLeaveGroup = async () => {
    setConfirmBusy(true);
    try {
      await apiRequest(`/api/chat/conversations/${activeConv.id}/members/${currentUser.id}`, {
        method: 'DELETE',
      });
      setConfirmLeaveOpen(false);
      onConversationLeft(activeConv.id);
      onClose();
      onToast('تمت مغادرة المجموعة');
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'تعذر مغادرة المجموعة', true);
    } finally {
      setConfirmBusy(false);
    }
  };

  const handleClearForMe = async () => {
    setConfirmBusy(true);
    try {
      await apiRequest(`/api/chat/conversations/${activeConv.id}/clear-for-me`, {
        method: 'POST',
      });
      setConfirmClearOpen(false);
      onClearedForMe(activeConv.id);
      onClose();
      onToast('تم مسح سجل المحادثة من شاشتك فقط');
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'تعذر مسح المحادثة', true);
    } finally {
      setConfirmBusy(false);
    }
  };

  return (
    <>
      <ModalShell
        open={open}
        onClose={onClose}
        title={isGroup ? 'معلومات وإعدادات المجموعة' : 'معلومات المحادثة الخاصة'}
        maxWidth="max-w-lg"
      >
        <div className="space-y-5">
          {/* Header Identity */}
          <div className="flex items-center gap-3.5 p-3.5 rounded-2xl bg-[var(--bg-surface)] border border-[var(--divider)]">
            {isGroup ? (
              <div className="w-14 h-14 rounded-full bg-[var(--accent-soft)] text-[var(--accent)] border border-[var(--accent)]/30 flex items-center justify-center shrink-0">
                <Icons.Users className="w-6 h-6" />
              </div>
            ) : (
              <Avatar
                name={activeConv.peer?.displayName || activeConv.title}
                assetId={activeConv.peer?.avatarAssetId}
                size="lg"
              />
            )}
            <div className="min-w-0 flex-1">
              <div className="text-base font-extrabold text-[var(--text-primary)] truncate">
                {activeConv.title}
              </div>
              {activeConv.peer ? (
                <div dir="ltr" className="text-xs text-[var(--text-secondary)] truncate text-right">
                  @{activeConv.peer.username}
                </div>
              ) : (
                <div className="text-xs text-[var(--text-secondary)] tabular-nums">
                  مجموعة مشفرة · {activeConv.memberCount} أعضاء
                </div>
              )}
              {activeConv.peer?.bio && (
                <p className="text-xs text-[var(--text-secondary)] mt-1 line-clamp-2">
                  {activeConv.peer.bio}
                </p>
              )}
            </div>
          </div>

          {/* Encryption Card */}
          <button
            type="button"
            onClick={onOpenEncryption}
            className="w-full p-3.5 rounded-2xl bg-[var(--success-soft)] border border-[var(--success)]/30 flex items-center justify-between gap-3 text-right hover:opacity-95 transition-opacity"
          >
            <div className="flex items-center gap-3 min-w-0">
              <Icons.ShieldCheck className="w-5 h-5 text-[var(--success)] shrink-0" />
              <div className="min-w-0">
                <div className="text-xs font-extrabold text-[var(--text-primary)]">
                  التشفير والأمان
                </div>
                <div className="text-[11px] text-[var(--text-secondary)]">
                  الرسائل والملفات مشفرة بـ AES-256-GCM · اضغط للتحقق من رمز الأمان
                </div>
              </div>
            </div>
            <Icons.ChevronLeft className="w-4 h-4 text-[var(--success)] shrink-0" />
          </button>

          {/* Group Edit Form (Group Admin only) */}
          {isGroup && isGroupAdmin ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void handlePatchSettings({
                  title: titleDraft.trim(),
                  description: descDraft.trim(),
                });
              }}
              className="space-y-3"
            >
              <div>
                <label className="block text-xs font-bold text-[var(--text-secondary)] mb-1">
                  اسم المجموعة
                </label>
                <input
                  type="text"
                  required
                  minLength={2}
                  maxLength={60}
                  value={titleDraft}
                  onChange={(e) => setTitleDraft(e.target.value)}
                  className="rahhala-input w-full px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-[var(--text-secondary)] mb-1">
                  وصف المجموعة
                </label>
                <textarea
                  rows={2}
                  maxLength={240}
                  value={descDraft}
                  onChange={(e) => setDescDraft(e.target.value)}
                  className="rahhala-input w-full px-3 py-2 text-sm resize-none"
                />
              </div>
              <button
                type="submit"
                disabled={savingMeta}
                className="min-h-[42px] w-full rounded-xl bg-[var(--accent)] text-[var(--accent-fg)] text-xs font-bold disabled:opacity-60"
              >
                {savingMeta ? 'جاري الحفظ…' : 'حفظ بيانات المجموعة'}
              </button>
            </form>
          ) : (
            isGroup &&
            activeConv.description && (
              <div className="p-3.5 rounded-xl bg-[var(--bg-surface)] border border-[var(--divider)]">
                <div className="text-xs text-[var(--text-secondary)]">وصف المجموعة</div>
                <p className="text-sm text-[var(--text-primary)] mt-1 whitespace-pre-wrap">
                  {activeConv.description}
                </p>
              </div>
            )
          )}

          {/* Disappearing Messages + Only Admins Send */}
          {(!isGroup || isGroupAdmin) && (
            <div className="space-y-3 pt-2 border-t border-[var(--divider)]">
              {isGroup && isGroupAdmin && (
                <label className="p-3 rounded-xl bg-[var(--bg-surface)] border border-[var(--divider)] flex items-center justify-between gap-3 cursor-pointer">
                  <div>
                    <div className="text-sm font-bold text-[var(--text-primary)]">
                      الإرسال لمشرفي المجموعة فقط
                    </div>
                    <div className="text-xs text-[var(--text-secondary)]">
                      تقييد إرسال الرسائل والملفات لمديري المجموعة فقط
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    checked={activeConv.onlyAdminsSend}
                    onChange={(e) =>
                      void handlePatchSettings({ onlyAdminsSend: e.target.checked })
                    }
                    className="w-5 h-5 accent-[var(--accent)]"
                  />
                </label>
              )}

              <div className="space-y-1.5">
                <div className="text-xs font-bold text-[var(--text-secondary)]">
                  الرسائل ذاتية الاختفاء
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {DISAPPEARING_CHOICES.map((opt) => {
                    const active = activeConv.disappearingHours === opt.hours;
                    return (
                      <button
                        key={opt.hours}
                        type="button"
                        onClick={() =>
                          void handlePatchSettings({ disappearingHours: opt.hours })
                        }
                        className={`min-h-[40px] rounded-xl border text-xs font-bold ${
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
            </div>
          )}

          {/* Group Members Section */}
          {isGroup && (
            <div className="space-y-2.5 pt-2 border-t border-[var(--divider)]">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-bold text-[var(--text-secondary)] tabular-nums">
                  أعضاء المجموعة ({members.length})
                </span>
                {isGroupAdmin && (
                  <button
                    type="button"
                    onClick={() => void openAddMembersPicker()}
                    className="min-h-[36px] px-3 rounded-xl bg-[var(--accent-soft)] text-[var(--accent)] text-xs font-bold flex items-center gap-1.5"
                  >
                    <Icons.UserPlus className="w-3.5 h-3.5" />
                    <span>{showAddPicker ? 'إغلاق الإضافة' : 'إضافة أعضاء'}</span>
                  </button>
                )}
              </div>

              {showAddPicker && isGroupAdmin && (
                <div className="p-3 rounded-2xl bg-[var(--bg-surface)] border border-[var(--accent)]/35 space-y-2">
                  <input
                    type="search"
                    value={addSearch}
                    onChange={(e) => setAddSearch(e.target.value)}
                    placeholder="ابحث لإضافة عضو للمجموعة…"
                    className="rahhala-input w-full px-3 py-1.5 text-xs"
                  />
                  <div className="max-h-36 overflow-y-auto divide-y divide-[var(--divider)]">
                    {addableMembers.length === 0 ? (
                      <div className="py-3 text-center text-xs text-[var(--text-secondary)]">
                        لا يوجد أعضاء متاحون للإضافة
                      </div>
                    ) : (
                      addableMembers.map((m) => (
                        <div key={m.id} className="py-2 flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2 min-w-0">
                            <Avatar name={m.displayName} assetId={m.avatarAssetId} size="sm" />
                            <span className="text-xs font-bold text-[var(--text-primary)] truncate">
                              {m.displayName}
                            </span>
                          </div>
                          <button
                            type="button"
                            disabled={addingUserId === m.id}
                            onClick={() => void handleAddSingleMember(m.id)}
                            className="min-h-[32px] px-2.5 rounded-lg bg-[var(--accent)] text-[var(--accent-fg)] text-xs font-bold shrink-0 disabled:opacity-50"
                          >
                            {addingUserId === m.id ? '…' : 'إضافة'}
                          </button>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              )}

              <div className="max-h-56 overflow-y-auto divide-y divide-[var(--divider)] rounded-2xl border border-[var(--divider)] bg-[var(--bg-surface)]">
                {loading && members.length === 0 ? (
                  <div className="py-6 text-center text-xs text-[var(--text-secondary)]">
                    جاري تحميل الأعضاء…
                  </div>
                ) : (
                  members.map((m) => {
                    const isSelf = m.userId === currentUser.id;
                    return (
                      <div key={m.userId} className="px-3 py-2.5 flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2.5 min-w-0">
                          <Avatar name={m.displayName} assetId={m.avatarAssetId} size="sm" />
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span className="text-xs font-bold text-[var(--text-primary)] truncate">
                                {m.displayName} {isSelf ? '(أنت)' : ''}
                              </span>
                              {m.role === 'admin' && (
                                <span className="text-[10px] font-extrabold text-[var(--accent)]">
                                  · مشرف المجموعة
                                </span>
                              )}
                            </div>
                            <div dir="ltr" className="text-[11px] text-[var(--text-secondary)] truncate text-right">
                              @{m.username}
                            </div>
                          </div>
                        </div>

                        {isGroupAdmin && !isSelf && (
                          <div className="flex items-center gap-1 shrink-0">
                            <button
                              type="button"
                              disabled={busyMemberId === m.userId}
                              onClick={() => void handleToggleAdminRole(m)}
                              className="min-h-[32px] px-2 rounded-lg bg-[var(--bg-card)] border border-[var(--divider)] text-[11px] font-bold text-[var(--text-primary)] hover:border-[var(--accent)]"
                            >
                              {m.role === 'admin' ? 'إلغاء الإشراف' : 'ترقية لمشرف'}
                            </button>
                            <button
                              type="button"
                              disabled={busyMemberId === m.userId}
                              onClick={() => void handleRemoveMember(m.userId)}
                              aria-label="إزالة العضو"
                              className="min-h-[32px] min-w-[32px] rounded-lg bg-[var(--error-soft)] text-[var(--error)] flex items-center justify-center"
                            >
                              <Icons.UserX className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          )}

          {/* Bottom User Actions */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-2 border-t border-[var(--divider)]">
            <button
              type="button"
              onClick={() => void handleToggleMute()}
              className="min-h-[42px] px-3 rounded-xl bg-[var(--bg-surface)] border border-[var(--divider)] text-xs font-bold text-[var(--text-primary)] flex items-center justify-center gap-2 hover:border-[var(--accent)]"
            >
              {activeConv.mutedNotifications ? (
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
              onClick={() => onExportTxt(activeConv.id)}
              className="min-h-[42px] px-3 rounded-xl bg-[var(--bg-surface)] border border-[var(--divider)] text-xs font-bold text-[var(--text-primary)] flex items-center justify-center gap-2 hover:border-[var(--accent)]"
            >
              <Icons.Download className="w-4 h-4 text-[var(--accent)]" />
              <span>تصدير المحادثة (.txt)</span>
            </button>

            <button
              type="button"
              onClick={() => setConfirmClearOpen(true)}
              className="min-h-[42px] px-3 rounded-xl bg-[var(--error-soft)] border border-[var(--error)]/30 text-xs font-bold text-[var(--error)] flex items-center justify-center gap-2"
            >
              <Icons.EyeOff className="w-4 h-4" />
              <span>مسح الدردشة عندي</span>
            </button>

            {isGroup && (
              <button
                type="button"
                onClick={() => setConfirmLeaveOpen(true)}
                className="min-h-[42px] px-3 rounded-xl bg-[var(--error)] text-white text-xs font-bold flex items-center justify-center gap-2"
              >
                <Icons.LogOut className="w-4 h-4" />
                <span>مغادرة المجموعة</span>
              </button>
            )}
          </div>
        </div>
      </ModalShell>

      <ConfirmDialog
        open={confirmClearOpen}
        onClose={() => setConfirmClearOpen(false)}
        onConfirm={handleClearForMe}
        title="مسح الدردشة عندي"
        message="سيتم إخفاء جميع الرسائل الحالية في هذه المحادثة من شاشتك فقط، ولن تتأثر لدى باقي الأعضاء."
        confirmLabel="مسح من شاشتي"
        destructive
        busy={confirmBusy}
      />

      <ConfirmDialog
        open={confirmLeaveOpen}
        onClose={() => setConfirmLeaveOpen(false)}
        onConfirm={handleLeaveGroup}
        title="مغادرة المجموعة"
        message="هل تريد مغادرة هذه المجموعة؟ لن تتمكن من إرسال أو قراءة رسائلها الجديدة بعد المغادرة إلا إذا أضافك مشرف مجددًا."
        confirmLabel="مغادرة"
        destructive
        busy={confirmBusy}
      />
    </>
  );
}
