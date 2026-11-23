import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useUpdateBlocker } from '../hooks/useSilentPWAUpdate';
import {
  ROLE_LABELS,
  type AuthUser,
  type MediaGalleryItem,
  type PublicMember,
  type UserRole,
} from '../../shared/types';
import { ApiError, apiRequest } from '../lib/api';
import { formatFullDate } from '../lib/formatters';
import { Icons } from './Icons';
import {
  Avatar,
  ConfirmDialog,
  EmptyState,
  ErrorRetryPanel,
  ModalShell,
  ProtectedImage,
} from './UI';

export function MembersAndMediaModal({
  open,
  onClose,
  currentUser,
  onOpenImage,
  onToast,
}: {
  open: boolean;
  onClose: () => void;
  currentUser: AuthUser;
  onOpenImage: (item: { assetId: string; filename: string; caption?: string; byteSize?: number }) => void;
  onToast: (msg: string, isError?: boolean) => void;
}) {
  const [tab, setTab] = useState<'members' | 'media'>('members');
  const [members, setMembers] = useState<PublicMember[]>([]);
  const [membersLoading, setMembersLoading] = useState(false);
  const [membersError, setMembersError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const [media, setMedia] = useState<MediaGalleryItem[]>([]);
  const [mediaLoading, setMediaLoading] = useState(false);
  const [mediaError, setMediaError] = useState<string | null>(null);

  const [selectedMember, setSelectedMember] = useState<PublicMember | null>(null);
  const [adminEmailEdit, setAdminEmailEdit] = useState('');
  const [issuedRecovery,setIssuedRecovery]=useState<string|null>(null);
  useUpdateBlocker(Boolean(issuedRecovery));
  const [adminTempPass, setAdminTempPass] = useState('');
  const [mutedIds, setMutedIds] = useState<Set<string>>(new Set());
  const [actionBusy, setActionBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<PublicMember | null>(null);
  const [confirmResetPass, setConfirmResetPass] = useState(false);

  const loadMutedMembers = useCallback(async () => {
    if (currentUser.role === 'member') return;
    try {
      const res = await apiRequest<{ mutedMemberIds?: string[] }>('/api/chat/settings', {
        background: true,
      });
      setMutedIds(new Set(res.mutedMemberIds || []));
    } catch {
      // ignore
    }
  }, [currentUser.role]);

  const loadMembers = useCallback(async () => {
    setMembersLoading(true);
    setMembersError(null);
    try {
      const res = await apiRequest<{ members: PublicMember[] }>('/api/members');
      setMembers(res.members);
    } catch (err) {
      setMembersError(err instanceof ApiError ? err.message : 'تعذر تحميل قائمة الأعضاء');
    } finally {
      setMembersLoading(false);
    }
  }, []);

  const loadMedia = useCallback(async () => {
    setMediaLoading(true);
    setMediaError(null);
    try {
      const res = await apiRequest<{ items: MediaGalleryItem[] }>('/api/assets/media');
      setMedia(res.items);
    } catch (err) {
      setMediaError(err instanceof ApiError ? err.message : 'تعذر تحميل الوسائط');
    } finally {
      setMediaLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void loadMembers();
    void loadMedia();
    void loadMutedMembers();
  }, [open, loadMembers, loadMedia, loadMutedMembers]);

  const filteredMembers = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return members;
    return members.filter(
      (m) => m.displayName.toLowerCase().includes(q) || m.username.toLowerCase().includes(q)
    );
  }, [members, search]);

  const openProfile = async (m: PublicMember) => {
    setSelectedMember(m);
    setAdminEmailEdit(m.privateEmail || '');
    setAdminTempPass('');
    try {
      const res = await apiRequest<{ member: PublicMember }>(
        `/api/members/${encodeURIComponent(m.id)}`
      );
      setSelectedMember(res.member);
      setAdminEmailEdit(res.member.privateEmail || '');
    } catch {
      // keep summary
    }
  };

  const canChangeRole = (target: PublicMember) =>
    (currentUser.role === 'admin' || currentUser.role === 'owner') &&
    target.id !== currentUser.id &&
    target.role !== 'owner';

  const canRemoveTarget = (target: PublicMember) => {
    if (target.id === currentUser.id || target.role === 'owner') return false;
    if (currentUser.role === 'owner') return true;
    if (currentUser.role === 'admin') return target.role === 'member';
    return false;
  };

  useEffect(()=>setIssuedRecovery(null),[selectedMember?.id]);
  const canManageRecovery = (target: PublicMember) => canRemoveTarget(target);

  const handleToggleMuteChat = async (target: PublicMember) => {
    const currentlyMuted = mutedIds.has(target.id);
    setActionBusy(true);
    try {
      if (currentlyMuted) {
        await apiRequest(`/api/chat/members/${encodeURIComponent(target.id)}/mute`, {
          method: 'DELETE',
        });
        setMutedIds((prev) => {
          const next = new Set(prev);
          next.delete(target.id);
          return next;
        });
        onToast(`تم إلغاء كتم ${target.displayName} في المحادثة`);
      } else {
        await apiRequest(`/api/chat/members/${encodeURIComponent(target.id)}/mute`, {
          method: 'POST',
          body: { hours: 0 },
        });
        setMutedIds((prev) => {
          const next = new Set(prev);
          next.add(target.id);
          return next;
        });
        onToast(`تم كتم ${target.displayName} عن الإرسال في المحادثة`);
      }
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'تعذر تحديث حالة الكتم', true);
    } finally {
      setActionBusy(false);
    }
  };

  const handleToggleRole = async (target: PublicMember) => {
    const nextRole: UserRole = target.role === 'admin' ? 'member' : 'admin';
    setActionBusy(true);
    try {
      await apiRequest(`/api/admin/members/${encodeURIComponent(target.id)}/role`, {
        method: 'POST',
        body: { role: nextRole },
      });
      onToast(`تم تحديث دور ${target.displayName} إلى ${ROLE_LABELS[nextRole]}`);
      await loadMembers();
      setSelectedMember((prev) => (prev ? { ...prev, role: nextRole } : null));
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'تعذر تغيير الدور', true);
    } finally {
      setActionBusy(false);
    }
  };

  const handleSaveTargetEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedMember) return;
    setActionBusy(true);
    try {
      await apiRequest(`/api/admin/members/${encodeURIComponent(selectedMember.id)}/email`, {
        method: 'PATCH',
        body: { email: adminEmailEdit },
      });
      onToast('تم تحديث البريد الإلكتروني السري للحساب');
      await loadMembers();
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'تعذر تحديث البريد', true);
    } finally {
      setActionBusy(false);
    }
  };

  const handleResetPassword = async () => {
    if (!selectedMember) return;
    setActionBusy(true);
    try {
      await apiRequest(
        `/api/admin/members/${encodeURIComponent(selectedMember.id)}/reset-password`,
        {
          method: 'POST',
          body: { temporaryPassword: adminTempPass },
        }
      );
      onToast(`تم تعيين كلمة مرور مؤقتة لحساب ${selectedMember.displayName} وإنهاء جميع جلساته`);
      setAdminTempPass('');
      setConfirmResetPass(false);
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'تعذر إعادة تعيين كلمة المرور', true);
    } finally {
      setActionBusy(false);
    }
  };

  const handleRemoveMember = async () => {
    if (!confirmRemove) return;
    setActionBusy(true);
    try {
      await apiRequest(`/api/admin/members/${encodeURIComponent(confirmRemove.id)}`, {
        method: 'DELETE',
      });
      onToast(`تمت إزالة ${confirmRemove.displayName} من الدفعة`);
      setConfirmRemove(null);
      setSelectedMember(null);
      await loadMembers();
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'تعذر إزالة العضو', true);
    } finally {
      setActionBusy(false);
    }
  };

  return (
    <>
      <ModalShell
        open={open}
        onClose={onClose}
        title="الأعضاء والوسائط"
        maxWidth="max-w-2xl"
      >
        <div className="flex items-center gap-1 p-1 rounded-xl bg-[var(--bg-surface)] mb-4">
          <button
            type="button"
            onClick={() => setTab('members')}
            className={`flex-1 min-h-[42px] rounded-lg text-sm font-bold transition-colors ${
              tab === 'members'
                ? 'bg-[var(--bg-card)] text-[var(--accent)] shadow-xs'
                : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            }`}
          >
            الأعضاء ({members.length})
          </button>
          <button
            type="button"
            onClick={() => setTab('media')}
            className={`flex-1 min-h-[42px] rounded-lg text-sm font-bold transition-colors ${
              tab === 'media'
                ? 'bg-[var(--bg-card)] text-[var(--accent)] shadow-xs'
                : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            }`}
          >
            الوسائط ({media.length})
          </button>
        </div>

        {tab === 'members' ? (
          <div className="space-y-4">
            <div className="relative">
              <Icons.Search className="w-4 h-4 text-[var(--text-secondary)] absolute right-3.5 top-1/2 -translate-y-1/2" />
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="ابحث بالاسم أو اسم المستخدم…"
                className="rahhala-input w-full pr-10 pl-3.5 py-2"
              />
            </div>

            {membersLoading ? (
              <div className="space-y-2.5">
                {[1, 2, 3].map((k) => (
                  <div key={k} className="h-16 rounded-xl bg-[var(--bg-surface)] animate-pulse" />
                ))}
              </div>
            ) : membersError ? (
              <ErrorRetryPanel message={membersError} onRetry={loadMembers} />
            ) : filteredMembers.length === 0 ? (
              <EmptyState icon={<Icons.Users className="w-6 h-6" />} title="لا يوجد أعضاء مطابقون" />
            ) : (
              <div className="divide-y divide-[var(--divider)]">
                {filteredMembers.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => openProfile(m)}
                    className="w-full py-3 px-2 flex items-center justify-between gap-3 text-right hover:bg-[var(--bg-surface)] rounded-xl transition-colors"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <Avatar name={m.displayName} assetId={m.avatarAssetId} />
                      <div className="min-w-0">
                        <div className="font-bold text-sm text-[var(--text-primary)] truncate">
                          {m.displayName}
                        </div>
                        <div className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
                          <span dir="ltr">@{m.username}</span>
                          <span aria-hidden="true">·</span>
                          <span className={m.role !== 'member' ? 'text-[var(--accent)] font-semibold' : ''}>
                            {ROLE_LABELS[m.role]}
                          </span>
                          {mutedIds.has(m.id) && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span className="text-[var(--error)] font-semibold">مكتوم</span>
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                    <Icons.ChevronLeft className="w-4 h-4 text-[var(--text-secondary)] shrink-0" />
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : mediaLoading ? (
          <div className="grid grid-cols-3 gap-2.5">
            {[1, 2, 3, 4, 5, 6].map((k) => (
              <div key={k} className="aspect-square rounded-xl bg-[var(--bg-surface)] animate-pulse" />
            ))}
          </div>
        ) : mediaError ? (
          <ErrorRetryPanel message={mediaError} onRetry={loadMedia} />
        ) : media.length === 0 ? (
          <EmptyState
            icon={<Icons.Image className="w-6 h-6" />}
            title="لا توجد صور متاحة بعد"
            subtitle="تظهر هنا الصور المشاركة في القنوات المتاحة لك."
          />
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
            {media.map((item) => (
              <button
                key={item.assetId}
                type="button"
                onClick={() =>
                  onOpenImage({
                    assetId: item.assetId,
                    filename: item.filename,
                    caption: `${item.senderName}`,
                    byteSize: item.byteSize,
                  })
                }
                className="aspect-square rounded-xl overflow-hidden border border-[var(--divider)] bg-[var(--bg-surface)] hover:border-[var(--accent)] transition-colors"
              >
                <ProtectedImage
                  assetId={item.assetId}
                  alt={item.filename}
                  className="w-full h-full object-cover"
                />
              </button>
            ))}
          </div>
        )}
      </ModalShell>

      {/* Public Profile & Admin Tools Modal */}
      <ModalShell
        open={Boolean(selectedMember)}
        onClose={() => setSelectedMember(null)}
        title="ملف العضو"
        maxWidth="max-w-md"
      >
        {selectedMember && (
          <div className="space-y-5">
            <div className="flex items-center gap-4">
              <Avatar name={selectedMember.displayName} assetId={selectedMember.avatarAssetId} size="lg" />
              <div className="min-w-0">
                <h3 className="text-lg font-extrabold text-[var(--text-primary)] truncate">
                  {selectedMember.displayName}
                </h3>
                <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--text-secondary)] mt-0.5">
                  <span dir="ltr">@{selectedMember.username}</span>
                  <span aria-hidden="true">·</span>
                  <span className="font-bold text-[var(--accent)]">
                    {ROLE_LABELS[selectedMember.role]}
                  </span>
                </div>
              </div>
            </div>

            {selectedMember.bio && (
              <p className="text-sm text-[var(--text-primary)] bg-[var(--bg-surface)] p-3.5 rounded-xl border border-[var(--divider)]">
                {selectedMember.bio}
              </p>
            )}

            <div className="grid grid-cols-2 gap-3 text-xs">
              <div className="p-3 rounded-xl bg-[var(--bg-surface)] border border-[var(--divider)]">
                <div className="text-[var(--text-secondary)]">تاريخ الانضمام</div>
                <div className="font-bold text-[var(--text-primary)] mt-1">
                  {formatFullDate(selectedMember.createdAt)}
                </div>
              </div>
              <div className="p-3 rounded-xl bg-[var(--bg-surface)] border border-[var(--divider)]">
                <div className="text-[var(--text-secondary)]">عدد الرسائل</div>
                <div className="font-bold text-[var(--text-primary)] mt-1 tabular-nums">
                  {selectedMember.messageCount}
                </div>
              </div>
            </div>

            {canChangeRole(selectedMember) && (
              <div className="pt-4 border-t border-[var(--divider)] space-y-4">
                <div className="text-xs font-bold text-[var(--accent)]">أدوات الإدارة</div>

                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={actionBusy}
                    onClick={() => handleToggleRole(selectedMember)}
                    className="min-h-[44px] px-4 py-2 rounded-xl bg-[var(--bg-surface)] border border-[var(--divider)] text-xs font-bold text-[var(--text-primary)] hover:border-[var(--accent)]"
                  >
                    {selectedMember.role === 'admin' ? 'خفض إلى عضو' : 'ترقية إلى مشرف'}
                  </button>

                  {canRemoveTarget(selectedMember) && (
                    <>
                      <button
                        type="button"
                        disabled={actionBusy}
                        onClick={() => handleToggleMuteChat(selectedMember)}
                        className={`min-h-[44px] px-4 py-2 rounded-xl border text-xs font-bold flex items-center gap-1.5 ${
                          mutedIds.has(selectedMember.id)
                            ? 'bg-[var(--accent-soft)] border-[var(--accent)]/40 text-[var(--accent)]'
                            : 'bg-[var(--bg-surface)] border-[var(--divider)] text-[var(--text-primary)] hover:border-[var(--accent)]'
                        }`}
                      >
                        {mutedIds.has(selectedMember.id) ? (
                          <>
                            <Icons.Volume2 className="w-3.5 h-3.5" />
                            <span>إلغاء كتم المحادثة</span>
                          </>
                        ) : (
                          <>
                            <Icons.VolumeX className="w-3.5 h-3.5" />
                            <span>كتم في المحادثة</span>
                          </>
                        )}
                      </button>

                      <button
                        type="button"
                        disabled={actionBusy}
                        onClick={() => setConfirmRemove(selectedMember)}
                        className="min-h-[44px] px-4 py-2 rounded-xl bg-[var(--error-soft)] text-[var(--error)] text-xs font-bold"
                      >
                        إزالة من الدفعة
                      </button>
                    </>
                  )}
                </div>

                {canManageRecovery(selectedMember) && (
                  <>
                    <form hidden onSubmit={handleSaveTargetEmail} className="space-y-2">
                      <label className="block text-xs font-semibold text-[var(--text-secondary)]">
                        البريد الإلكتروني السري (للإدارة فقط)
                      </label>
                      <div className="flex gap-2">
                        <input
                          type="email"
                          dir="ltr"
                          required
                          value={adminEmailEdit}
                          onChange={(e) => setAdminEmailEdit(e.target.value)}
                          className="rahhala-input flex-1 px-3 py-2 text-left text-sm"
                        />
                        <button
                          type="submit"
                          disabled={actionBusy}
                          className="min-h-[44px] px-4 rounded-xl bg-[var(--bg-surface)] border border-[var(--divider)] text-xs font-bold"
                        >
                          حفظ
                        </button>
                      </div>
                    </form>

                    {currentUser.role==='owner'&&selectedMember.role==='member'&&<div className="space-y-2 border border-[var(--divider)] rounded-xl p-3"><button type="button" disabled={actionBusy} className="min-h-[44px] text-sm font-bold text-[var(--accent)]" onClick={async()=>{if(!window.confirm('إصدار كود جديد يُلغي الكود السابق ويسجل خروج العضو من كل الأجهزة. متابعة؟'))return;setActionBusy(true);try{const r=await apiRequest<{recoveryCode:string}>(`/api/admin/members/${encodeURIComponent(selectedMember.id)}/recovery-code`,{method:'POST',body:{}});setIssuedRecovery(r.recoveryCode);}catch(e){onToast(e instanceof Error?e.message:'تعذر إصدار الكود',true);}finally{setActionBusy(false);}}}>إصدار كود استرجاع جديد</button>{issuedRecovery&&<><p className="text-xs text-[var(--text-secondary)]">يظهر مرة واحدة. سلّمه للعضو بشكل خاص.</p><code dir="ltr" className="block select-all break-all text-sm">{issuedRecovery}</code></>}</div>}
                    <div className="space-y-2">
                      <label className="block text-xs font-semibold text-[var(--text-secondary)]">
                        تعيين كلمة مرور مؤقتة (يُلغي جميع جلسات العضو فورًا)
                      </label>
                      <div className="flex gap-2">
                        <input
                          type="password"
                          minLength={6}
                          maxLength={100}
                          value={adminTempPass}
                          onChange={(e) => setAdminTempPass(e.target.value)}
                          placeholder="٦ أحرف على الأقل"
                          className="rahhala-input flex-1 px-3 py-2 text-sm"
                        />
                        <button
                          type="button"
                          disabled={actionBusy || adminTempPass.length < 6}
                          onClick={() => setConfirmResetPass(true)}
                          className="min-h-[44px] px-4 rounded-xl bg-[var(--accent)] text-[var(--accent-fg)] text-xs font-bold disabled:opacity-50"
                        >
                          إعادة تعيين
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </ModalShell>

      <ConfirmDialog
        open={Boolean(confirmRemove)}
        onClose={() => setConfirmRemove(null)}
        onConfirm={handleRemoveMember}
        title="إزالة عضو من الدفعة"
        message={`هل تريد إزالة "${confirmRemove?.displayName}"؟ سيتم إنهاء جميع جلساته فورًا وحذف بياناته الخاصة مع الإبقاء على الرسائل السابقة باسم عضو سابق.`}
        confirmLabel="إزالة العضو"
        destructive
        busy={actionBusy}
      />

      <ConfirmDialog
        open={confirmResetPass}
        onClose={() => setConfirmResetPass(false)}
        onConfirm={handleResetPassword}
        title="تعيين كلمة مرور مؤقتة"
        message={`سيتم تغيير كلمة مرور "${selectedMember?.displayName}" (@${selectedMember?.username}) وإنهاء جميع جلساته النشطة. سلّم له كلمة المرور المؤقتة بشكل خاص.`}
        confirmLabel="تأكيد التغيير"
        destructive
        busy={actionBusy}
      />
    </>
  );
}
