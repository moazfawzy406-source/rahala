import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { motion } from 'motion/react';
import type {
  AuthUser,
  MaterialKind,
  MaterialRecord,
  SectionRecord,
  StudyReminderRecord,
  SubjectRecord,
} from '../../shared/types';
import { formatRemainingCountdown } from '../hooks/useStudyReminders';
import { ApiError, apiRequest } from '../lib/api';
import { MATERIAL_KIND_LABELS } from '../lib/formatters';
import { Icons, SubjectIcon } from './Icons';
import { ConfirmDialog, EmptyState, ErrorRetryPanel, ModalShell } from './UI';

export function HomeAndSubjects({
  user,
  selectedSubjectId,
  onSelectSubject,
  onNavigateTab,
  refreshTrigger,
  unreadChatCount,
  nextReminder,
  activeReminderCount,
  nowTick,
  getSubjectColor,
  onOpenReminders,
  onToast,
}: {
  user: AuthUser;
  selectedSubjectId: string | null;
  onSelectSubject: (id: string | null) => void;
  onNavigateTab: (tab: 'subjects' | 'dashboard' | 'majalis' | 'chat' | 'admin' | 'account') => void;
  refreshTrigger: number;
  unreadChatCount: number;
  nextReminder: StudyReminderRecord | null;
  activeReminderCount: number;
  nowTick: number;
  getSubjectColor?: (subjectId: string | null | undefined, fallbackColor?: string) => string;
  onOpenReminders: (subjectId?: string | null) => void;
  onToast: (msg: string, isError?: boolean) => void;
}) {
  const [subjects, setSubjects] = useState<SubjectRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  // Subject detail state
  const [subjectDetail, setSubjectDetail] = useState<{
    subject: SubjectRecord;
    sections: SectionRecord[];
  } | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({});

  // Resource edit/delete/menu modals (admin/owner)
  const [editingMaterial, setEditingMaterial] = useState<MaterialRecord | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editUrl, setEditUrl] = useState('');
  const [editKind, setEditKind] = useState<MaterialKind>('link');
  const [editNote, setEditNote] = useState('');
  const [editSectionId, setEditSectionId] = useState('');
  const [editBusy, setEditBusy] = useState(false);

  const [deletingMaterial, setDeletingMaterial] = useState<MaterialRecord | null>(null);
  const [deletingSubjectConfirm, setDeletingSubjectConfirm] = useState(false);
  const [sectionToDelete, setSectionToDelete] = useState<SectionRecord | null>(null);
  const [moveSectionTargetId, setMoveSectionTargetId] = useState<string>('');
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);

  const isAdminOrOwner = user.role === 'admin' || user.role === 'owner';

  const loadSubjects = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiRequest<{ subjects: SubjectRecord[] }>('/api/resources/subjects');
      setSubjects(res.subjects);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر تحميل المواد الدراسية');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadSubjectDetail = useCallback(async (id: string) => {
    setDetailLoading(true);
    setDetailError(null);
    try {
      const res = await apiRequest<{ subject: SubjectRecord; sections: SectionRecord[] }>(
        `/api/resources/subjects/${encodeURIComponent(id)}`
      );
      setSubjectDetail(res);
    } catch (err) {
      setDetailError(err instanceof ApiError ? err.message : 'تعذر تحميل محتوى المادة');
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSubjects();
  }, [loadSubjects, refreshTrigger]);

  useEffect(() => {
    if (selectedSubjectId) {
      void loadSubjectDetail(selectedSubjectId);
    } else {
      setSubjectDetail(null);
    }
  }, [selectedSubjectId, loadSubjectDetail, refreshTrigger]);

  const filteredSubjects = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return subjects;
    return subjects.filter((s) => s.name.toLowerCase().includes(q));
  }, [subjects, search]);

  const openEditModal = (m: MaterialRecord) => {
    setOpenMenuId(null);
    setEditingMaterial(m);
    setEditTitle(m.title);
    setEditUrl(m.url);
    setEditKind(m.kind);
    setEditNote(m.note);
    setEditSectionId(m.sectionId);
  };

  const handleSaveMaterialEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingMaterial) return;
    setEditBusy(true);
    try {
      await apiRequest(`/api/resources/materials/${encodeURIComponent(editingMaterial.id)}`, {
        method: 'PATCH',
        body: {
          title: editTitle,
          url: editUrl,
          kind: editKind,
          note: editNote,
          sectionId: editSectionId,
        },
      });
      onToast('تم تحديث المحتوى بنجاح');
      setEditingMaterial(null);
      if (selectedSubjectId) await loadSubjectDetail(selectedSubjectId);
      await loadSubjects();
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'تعذر تحديث المحتوى', true);
    } finally {
      setEditBusy(false);
    }
  };

  const handleReorderMaterial = async (m: MaterialRecord, direction: 'up' | 'down') => {
    setOpenMenuId(null);
    try {
      await apiRequest(`/api/resources/materials/${encodeURIComponent(m.id)}`, {
        method: 'PATCH',
        body: { direction },
      });
      if (selectedSubjectId) await loadSubjectDetail(selectedSubjectId);
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'تعذر تغيير الترتيب', true);
    }
  };

  const handleDeleteMaterial = async () => {
    if (!deletingMaterial) return;
    setDeleteBusy(true);
    try {
      await apiRequest(`/api/resources/materials/${encodeURIComponent(deletingMaterial.id)}`, {
        method: 'DELETE',
      });
      onToast('تم حذف المحتوى');
      setDeletingMaterial(null);
      if (selectedSubjectId) await loadSubjectDetail(selectedSubjectId);
      await loadSubjects();
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'تعذر حذف المحتوى', true);
    } finally {
      setDeleteBusy(false);
    }
  };

  const handleDeleteSubject = async () => {
    if (!selectedSubjectId) return;
    setDeleteBusy(true);
    try {
      await apiRequest(`/api/resources/subjects/${encodeURIComponent(selectedSubjectId)}`, {
        method: 'DELETE',
      });
      onToast('تم حذف المادة الدراسية وجميع أقسامها ومحتواها');
      setDeletingSubjectConfirm(false);
      onSelectSubject(null);
      await loadSubjects();
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'تعذر حذف المادة', true);
    } finally {
      setDeleteBusy(false);
    }
  };

  const handleDeleteSection = async (mode: 'move' | 'cascade') => {
    if (!sectionToDelete) return;
    setDeleteBusy(true);
    try {
      await apiRequest(`/api/resources/sections/${encodeURIComponent(sectionToDelete.id)}`, {
        method: 'DELETE',
        body:
          mode === 'move' && moveSectionTargetId
            ? { moveToSectionId: moveSectionTargetId }
            : { confirmCascade: true },
      });
      onToast('تم حذف القسم');
      setSectionToDelete(null);
      setMoveSectionTargetId('');
      if (selectedSubjectId) await loadSubjectDetail(selectedSubjectId);
      await loadSubjects();
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'تعذر حذف القسم', true);
    } finally {
      setDeleteBusy(false);
    }
  };

  // SUBJECT DETAIL VIEW
  if (selectedSubjectId) {
    return (
      <div className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => onSelectSubject(null)}
              aria-label="العودة إلى المواد"
              className="min-h-[44px] min-w-[44px] rounded-xl bg-[var(--bg-card)] border border-[var(--divider)] flex items-center justify-center text-[var(--text-primary)] hover:border-[var(--accent)]"
            >
              <Icons.ArrowRight className="w-5 h-5" />
            </button>
            <div className="min-w-0">
              <h1 className="text-xl font-extrabold text-[var(--text-primary)] truncate">
                {subjectDetail?.subject.name || 'المادة الدراسية'}
              </h1>
              {subjectDetail && (
                <p className="text-xs text-[var(--text-secondary)] tabular-nums">
                  {subjectDetail.sections.length} أقسام · {subjectDetail.subject.materialCount} محتوى
                </p>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2">
            {subjectDetail && (
              <button
                type="button"
                onClick={() => onOpenReminders(subjectDetail.subject.id)}
                className="min-h-[44px] px-3.5 py-2 rounded-xl rahhala-glass-pill text-xs font-bold text-[var(--text-primary)] hover:border-[var(--accent)] flex items-center gap-1.5 transition-colors"
              >
                <Icons.AlarmClock className="w-4 h-4 text-[var(--accent)]" />
                <span>ضبط منبه</span>
              </button>
            )}

            {isAdminOrOwner && subjectDetail && (
              <>
                <button
                  type="button"
                  onClick={() => onNavigateTab('admin')}
                  className="min-h-[44px] px-4 py-2 rounded-xl bg-[var(--accent)] text-[var(--accent-fg)] text-xs font-bold flex items-center gap-1.5 hover:bg-[var(--accent-hi)]"
                >
                  <Icons.Plus className="w-4 h-4" />
                  <span>إضافة محتوى</span>
                </button>
                <button
                  type="button"
                  onClick={() => setDeletingSubjectConfirm(true)}
                  aria-label="حذف المادة الدراسية"
                  className="min-h-[44px] min-w-[44px] rounded-xl bg-[var(--error-soft)] text-[var(--error)] flex items-center justify-center hover:opacity-85"
                >
                  <Icons.Trash className="w-4 h-4" />
                </button>
              </>
            )}
          </div>
        </div>

        {detailLoading ? (
          <div className="space-y-3">
            {[1, 2, 3].map((k) => (
              <div key={k} className="rahhala-card p-5 h-28 animate-pulse" />
            ))}
          </div>
        ) : detailError ? (
          <ErrorRetryPanel message={detailError} onRetry={() => loadSubjectDetail(selectedSubjectId)} />
        ) : subjectDetail ? (
          subjectDetail.sections.length === 0 ? (
            <EmptyState
              icon={<Icons.BookOpen className="w-6 h-6" />}
              title="لا توجد أقسام في هذه المادة بعد"
              subtitle="يمكن للمشرف إضافة أقسام ومحتوى من لوحة الإدارة."
            />
          ) : (
            <div className="space-y-4">
              {subjectDetail.sections.map((section) => {
                const isCollapsed = Boolean(collapsedSections[section.id]);
                const otherSections = subjectDetail.sections.filter((s) => s.id !== section.id);
                return (
                  <section key={section.id} className="rahhala-card overflow-visible">
                    <div className="flex items-center justify-between gap-2 px-5 py-3.5 border-b border-[var(--divider)]">
                      <button
                        type="button"
                        aria-expanded={!isCollapsed}
                        onClick={() =>
                          setCollapsedSections((prev) => ({
                            ...prev,
                            [section.id]: !prev[section.id],
                          }))
                        }
                        className="flex-1 min-h-[44px] flex items-center justify-between gap-3 text-right"
                      >
                        <div className="flex items-center gap-2.5">
                          <span className="font-bold text-base text-[var(--accent)]">
                            {section.label}
                          </span>
                          <span className="text-xs text-[var(--text-secondary)] tabular-nums">
                            · {section.materials.length}
                          </span>
                        </div>
                        <Icons.ChevronDown
                          className={`w-5 h-5 text-[var(--text-secondary)] transition-transform ${
                            isCollapsed ? 'rotate-90' : ''
                          }`}
                        />
                      </button>

                      {isAdminOrOwner && (
                        <button
                          type="button"
                          onClick={() => {
                            setSectionToDelete(section);
                            setMoveSectionTargetId(otherSections[0]?.id || '');
                          }}
                          aria-label={`حذف قسم ${section.label}`}
                          className="min-h-[40px] min-w-[40px] rounded-xl text-[var(--text-secondary)] hover:text-[var(--error)] hover:bg-[var(--error-soft)] flex items-center justify-center"
                        >
                          <Icons.Trash className="w-4 h-4" />
                        </button>
                      )}
                    </div>

                    {!isCollapsed && (
                      <div className="p-4">
                        {section.materials.length === 0 ? (
                          <p className="text-sm text-[var(--text-secondary)] py-4 text-center">
                            لسه مفيش محتوى في القسم ده.
                          </p>
                        ) : (
                          <div className="divide-y divide-[var(--divider)]">
                            {section.materials.map((m, idx) => (
                              <div
                                key={m.id}
                                className="py-3.5 first:pt-1 last:pb-1 flex items-start justify-between gap-3 relative"
                              >
                                <a
                                  href={m.url}
                                  target="_blank"
                                  rel="noopener noreferrer nofollow"
                                  className="flex-1 min-w-0 group"
                                >
                                  <div className="flex items-center gap-2">
                                    <span className="font-bold text-sm text-[var(--text-primary)] group-hover:text-[var(--accent)] transition-colors break-words">
                                      {m.title}
                                    </span>
                                    <Icons.ExternalLink className="w-3.5 h-3.5 text-[var(--text-secondary)] shrink-0" />
                                  </div>
                                  <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--text-secondary)] mt-1">
                                    <span>{MATERIAL_KIND_LABELS[m.kind]}</span>
                                    {m.note && (
                                      <>
                                        <span aria-hidden="true">·</span>
                                        <span className="break-words">{m.note}</span>
                                      </>
                                    )}
                                  </div>
                                </a>

                                {isAdminOrOwner && (
                                  <div className="relative shrink-0">
                                    <button
                                      type="button"
                                      onClick={() =>
                                        setOpenMenuId((cur) => (cur === m.id ? null : m.id))
                                      }
                                      aria-label={`إدارة ${m.title}`}
                                      className="min-h-[44px] min-w-[44px] rounded-xl text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-surface)] flex items-center justify-center"
                                    >
                                      <Icons.MoreVertical className="w-4 h-4" />
                                    </button>

                                    {openMenuId === m.id && (
                                      <div className="absolute left-0 top-11 z-30 w-48 rahhala-card p-1.5 shadow-xl">
                                        <button
                                          type="button"
                                          onClick={() => openEditModal(m)}
                                          className="w-full min-h-[40px] px-3 rounded-xl text-right text-xs font-semibold text-[var(--text-primary)] hover:bg-[var(--bg-surface)] flex items-center gap-2"
                                        >
                                          <Icons.Edit className="w-4 h-4" />
                                          <span>تعديل أو نقل لقسم</span>
                                        </button>
                                        {idx > 0 && (
                                          <button
                                            type="button"
                                            onClick={() => handleReorderMaterial(m, 'up')}
                                            className="w-full min-h-[40px] px-3 rounded-xl text-right text-xs font-semibold text-[var(--text-primary)] hover:bg-[var(--bg-surface)] flex items-center gap-2"
                                          >
                                            <Icons.ArrowUp className="w-4 h-4" />
                                            <span>تحريك لأعلى</span>
                                          </button>
                                        )}
                                        {idx < section.materials.length - 1 && (
                                          <button
                                            type="button"
                                            onClick={() => handleReorderMaterial(m, 'down')}
                                            className="w-full min-h-[40px] px-3 rounded-xl text-right text-xs font-semibold text-[var(--text-primary)] hover:bg-[var(--bg-surface)] flex items-center gap-2"
                                          >
                                            <Icons.ArrowDown className="w-4 h-4" />
                                            <span>تحريك لأسفل</span>
                                          </button>
                                        )}
                                        <button
                                          type="button"
                                          onClick={() => {
                                            setOpenMenuId(null);
                                            setDeletingMaterial(m);
                                          }}
                                          className="w-full min-h-[40px] px-3 rounded-xl text-right text-xs font-semibold text-[var(--error)] hover:bg-[var(--error-soft)] flex items-center gap-2"
                                        >
                                          <Icons.Trash className="w-4 h-4" />
                                          <span>حذف المحتوى</span>
                                        </button>
                                      </div>
                                    )}
                                  </div>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </section>
                );
              })}
            </div>
          )
        ) : null}

        {/* Edit Material Modal */}
        <ModalShell
          open={Boolean(editingMaterial)}
          onClose={() => setEditingMaterial(null)}
          title="تعديل المحتوى"
        >
          <form onSubmit={handleSaveMaterialEdit} className="space-y-3.5">
            <div>
              <label className="block text-xs font-bold text-[var(--text-secondary)] mb-1">
                القسم
              </label>
              <select
                value={editSectionId}
                onChange={(e) => setEditSectionId(e.target.value)}
                className="rahhala-input w-full px-3 py-2"
              >
                {subjectDetail?.sections.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-bold text-[var(--text-secondary)] mb-1">
                العنوان
              </label>
              <input
                type="text"
                required
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                className="rahhala-input w-full px-3 py-2"
              />
            </div>
            <div>
              <label className="block text-xs font-bold text-[var(--text-secondary)] mb-1">
                نوع المحتوى
              </label>
              <select
                value={editKind}
                onChange={(e) => setEditKind(e.target.value as MaterialKind)}
                className="rahhala-input w-full px-3 py-2"
              >
                {Object.entries(MATERIAL_KIND_LABELS).map(([k, label]) => (
                  <option key={k} value={k}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-bold text-[var(--text-secondary)] mb-1">
                الرابط
              </label>
              <input
                type="url"
                dir="ltr"
                required
                value={editUrl}
                onChange={(e) => setEditUrl(e.target.value)}
                className="rahhala-input w-full px-3 py-2 text-left"
              />
            </div>
            <div>
              <label className="block text-xs font-bold text-[var(--text-secondary)] mb-1">
                ملاحظة (اختياري)
              </label>
              <input
                type="text"
                value={editNote}
                onChange={(e) => setEditNote(e.target.value)}
                className="rahhala-input w-full px-3 py-2"
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setEditingMaterial(null)}
                className="min-h-[44px] px-4 rounded-xl bg-[var(--bg-surface)] text-sm font-semibold"
              >
                إلغاء
              </button>
              <button
                type="submit"
                disabled={editBusy}
                className="min-h-[44px] px-5 rounded-xl bg-[var(--accent)] text-[var(--accent-fg)] text-sm font-bold disabled:opacity-60"
              >
                {editBusy ? 'جاري الحفظ...' : 'حفظ التعديلات'}
              </button>
            </div>
          </form>
        </ModalShell>

        <ConfirmDialog
          open={Boolean(deletingMaterial)}
          onClose={() => setDeletingMaterial(null)}
          onConfirm={handleDeleteMaterial}
          title="حذف المحتوى"
          message={`هل تريد حذف "${deletingMaterial?.title}" من هذا القسم؟`}
          confirmLabel="حذف"
          destructive
          busy={deleteBusy}
        />

        <ConfirmDialog
          open={deletingSubjectConfirm}
          onClose={() => setDeletingSubjectConfirm(false)}
          onConfirm={handleDeleteSubject}
          title="حذف المادة الدراسية"
          message={`تحذير: حذف مادة "${subjectDetail?.subject.name}" سيحذف نهائيًا جميع أقسامها وروابطها (${subjectDetail?.subject.materialCount ?? 0} محتوى).`}
          confirmLabel="حذف المادة بالكامل"
          destructive
          busy={deleteBusy}
        />

        {/* Safe Section Delete Modal (move resources or cascade confirm) */}
        <ModalShell
          open={Boolean(sectionToDelete)}
          onClose={() => setSectionToDelete(null)}
          title={`حذف قسم "${sectionToDelete?.label}"`}
          maxWidth="max-w-md"
        >
          {sectionToDelete && (
            <div className="space-y-4">
              {sectionToDelete.materials.length > 0 ? (
                <>
                  <p className="text-sm text-[var(--text-secondary)]">
                    هذا القسم يحتوي على {sectionToDelete.materials.length} روابط دراسية. يمكنك نقلها لقسم آخر قبل الحذف أو حذفها مع القسم.
                  </p>
                  {subjectDetail && subjectDetail.sections.filter((s) => s.id !== sectionToDelete.id).length > 0 && (
                    <div className="p-3.5 rounded-xl bg-[var(--bg-surface)] border border-[var(--divider)] space-y-3">
                      <label className="block text-xs font-bold text-[var(--text-primary)]">
                        نقل الروابط إلى قسم آخر ثم الحذف:
                      </label>
                      <select
                        value={moveSectionTargetId}
                        onChange={(e) => setMoveSectionTargetId(e.target.value)}
                        className="rahhala-input w-full px-3 py-2"
                      >
                        {subjectDetail.sections
                          .filter((s) => s.id !== sectionToDelete.id)
                          .map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.label}
                            </option>
                          ))}
                      </select>
                      <button
                        type="button"
                        disabled={deleteBusy || !moveSectionTargetId}
                        onClick={() => handleDeleteSection('move')}
                        className="w-full min-h-[44px] rounded-xl bg-[var(--accent)] text-[var(--accent-fg)] text-sm font-bold"
                      >
                        نقل المحتوى وحذف القسم
                      </button>
                    </div>
                  )}
                  <button
                    type="button"
                    disabled={deleteBusy}
                    onClick={() => handleDeleteSection('cascade')}
                    className="w-full min-h-[44px] rounded-xl bg-[var(--error)] text-white text-sm font-bold"
                  >
                    حذف القسم مع جميع روابطه نهائيًا
                  </button>
                </>
              ) : (
                <>
                  <p className="text-sm text-[var(--text-secondary)]">
                    القسم فارغ حاليًا. هل تريد حذفه؟
                  </p>
                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setSectionToDelete(null)}
                      className="min-h-[44px] px-4 rounded-xl bg-[var(--bg-surface)] text-sm font-semibold"
                    >
                      إلغاء
                    </button>
                    <button
                      type="button"
                      disabled={deleteBusy}
                      onClick={() => handleDeleteSection('cascade')}
                      className="min-h-[44px] px-5 rounded-xl bg-[var(--error)] text-white text-sm font-bold"
                    >
                      حذف القسم
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </ModalShell>
      </div>
    );
  }

  // HOME SCREEN
  return (
    <div className="space-y-6">
      {/* Greeting Hero Glass Card */}
      <motion.section
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
        className="rahhala-card p-5 sm:p-6 relative overflow-hidden"
      >
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -top-20 -left-20 w-56 h-56 rounded-full blur-3xl opacity-25"
          style={{ background: 'var(--accent)' }}
        />
        <div className="relative flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h1 className="text-xl sm:text-2xl font-extrabold text-[var(--text-primary)]">
              أهلًا بعودتك <span className="text-[var(--accent)]">{user.displayName}</span>
            </h1>
            <p className="text-sm text-[var(--text-secondary)] mt-1">
              كل ما تحتاجه لدراستك في مكان واحد
            </p>
          </div>
          <div className="relative w-full sm:w-72">
            <Icons.Search className="w-4 h-4 text-[var(--text-secondary)] absolute right-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="دوّر على مادة…"
              aria-label="ابحث عن مادة دراسية"
              className="rahhala-input w-full pr-10 pl-3.5 py-2"
            />
          </div>
        </div>

        {/* Four Quick Actions */}
        <div className="relative grid grid-cols-2 sm:grid-cols-4 gap-3 mt-5">
          <motion.button
            type="button"
            whileHover={{ y: -2 }}
            whileTap={{ scale: 0.98 }}
            transition={{ duration: 0.15 }}
            onClick={() => onOpenReminders(null)}
            className="min-h-[56px] px-3.5 py-3 rounded-2xl bg-[var(--bg-surface)]/80 backdrop-blur-sm border border-[var(--divider)] hover:border-[var(--accent)] flex items-center justify-between gap-2 text-right transition-colors"
          >
            <span className="flex items-center gap-2.5 min-w-0">
              <Icons.AlarmClock className="w-5 h-5 text-[var(--accent)] shrink-0" />
              <span className="text-xs sm:text-sm font-bold text-[var(--text-primary)] truncate">
                منبه المذاكرة
              </span>
            </span>
            {activeReminderCount > 0 && (
              <span className="text-xs font-extrabold text-[var(--accent)] tabular-nums shrink-0">
                {activeReminderCount}
              </span>
            )}
          </motion.button>

          <motion.button
            type="button"
            whileHover={{ y: -2 }}
            whileTap={{ scale: 0.98 }}
            transition={{ duration: 0.15 }}
            onClick={() => onNavigateTab('chat')}
            className="min-h-[56px] px-3.5 py-3 rounded-2xl bg-[var(--bg-surface)]/80 backdrop-blur-sm border border-[var(--divider)] hover:border-[var(--accent)] flex items-center justify-between gap-2 text-right transition-colors"
          >
            <span className="flex items-center gap-2.5">
              <Icons.MessageSquare className="w-5 h-5 text-[var(--accent)] shrink-0" />
              <span className="text-xs sm:text-sm font-bold text-[var(--text-primary)]">
                المحادثة
              </span>
            </span>
            {unreadChatCount > 0 && (
              <span className="text-xs font-extrabold text-[var(--accent)] tabular-nums">
                {unreadChatCount}
              </span>
            )}
          </motion.button>

          <motion.button
            type="button"
            whileHover={{ y: -2 }}
            whileTap={{ scale: 0.98 }}
            transition={{ duration: 0.15 }}
            onClick={() => onNavigateTab('majalis')}
            className="min-h-[56px] px-3.5 py-3 rounded-2xl bg-[var(--bg-surface)]/80 backdrop-blur-sm border border-[var(--divider)] hover:border-[var(--accent)] flex items-center gap-2.5 text-right transition-colors"
          >
            <Icons.Video className="w-5 h-5 text-[var(--accent)] shrink-0" />
            <span className="text-xs sm:text-sm font-bold text-[var(--text-primary)]">
              مجالس المذاكرة
            </span>
          </motion.button>

          <motion.button
            type="button"
            whileHover={{ y: -2 }}
            whileTap={{ scale: 0.98 }}
            transition={{ duration: 0.15 }}
            onClick={() => onNavigateTab('account')}
            className="min-h-[56px] px-3.5 py-3 rounded-2xl bg-[var(--bg-surface)]/80 backdrop-blur-sm border border-[var(--divider)] hover:border-[var(--accent)] flex items-center gap-2.5 text-right transition-colors"
          >
            <Icons.User className="w-5 h-5 text-[var(--accent)] shrink-0" />
            <span className="text-xs sm:text-sm font-bold text-[var(--text-primary)]">
              حسابي
            </span>
          </motion.button>
        </div>

        {/* Upcoming Study Reminder Strip */}
        <div className="relative mt-4 pt-3.5 border-t border-[var(--divider)] flex flex-wrap items-center justify-between gap-2 text-xs">
          {nextReminder ? (
            <>
              <div className="flex items-center gap-2 min-w-0">
                <span
                  className="w-2.5 h-2.5 rounded-full shrink-0"
                  style={{
                    backgroundColor: getSubjectColor
                      ? getSubjectColor(nextReminder.subjectId)
                      : 'var(--accent)',
                  }}
                  aria-hidden="true"
                />
                <span className="text-[var(--text-secondary)]">المنبه القادم:</span>
                <span className="font-bold text-[var(--text-primary)] truncate">
                  {nextReminder.subjectName}
                </span>
                <span aria-hidden="true" className="text-[var(--text-secondary)]">·</span>
                <span className="font-extrabold text-[var(--accent)] tabular-nums">
                  {formatRemainingCountdown(nextReminder.remindAt, nowTick)}
                </span>
              </div>
              <button
                type="button"
                onClick={() => onOpenReminders(nextReminder.subjectId)}
                className="font-bold text-[var(--accent)] hover:underline whitespace-nowrap"
              >
                إدارة التذكيرات
              </button>
            </>
          ) : (
            <>
              <div className="flex items-center gap-2 text-[var(--text-secondary)]">
                <Icons.Clock className="w-4 h-4 text-[var(--accent)] shrink-0" />
                <span>اضبط منبهاً لمادة معينة ليتم تنبيهك داخل الموقع في موعد المذاكرة.</span>
              </div>
              <button
                type="button"
                onClick={() => onOpenReminders(null)}
                className="font-bold text-[var(--accent)] hover:underline whitespace-nowrap"
              >
                + ضبط منبه جديد
              </button>
            </>
          )}
        </div>
      </motion.section>

      {/* Subjects Grid */}
      <section aria-labelledby="subjects-grid-heading">
        <div className="flex items-center justify-between mb-3 px-1">
          <h2
            id="subjects-grid-heading"
            className="text-base font-extrabold text-[var(--text-primary)]"
          >
            المواد الدراسية
          </h2>
          <span className="text-xs font-semibold text-[var(--text-secondary)] tabular-nums">
            {filteredSubjects.length} مادة
          </span>
        </div>

        {loading ? (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3.5">
            {[1, 2, 3, 4].map((k) => (
              <div key={k} className="rahhala-card h-36 animate-pulse" />
            ))}
          </div>
        ) : error ? (
          <ErrorRetryPanel message={error} onRetry={loadSubjects} />
        ) : filteredSubjects.length === 0 ? (
          <EmptyState
            icon={<Icons.Search className="w-6 h-6" />}
            title={search.trim() ? 'مفيش مادة بالاسم ده' : 'لا توجد مواد مضافة بعد'}
            subtitle={search.trim() ? 'جرّب كلمة بحث تانية' : 'سيضيف المشرف المواد قريبًا'}
          />
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3.5">
            {filteredSubjects.map((s, idx) => {
              const cardColor = getSubjectColor ? getSubjectColor(s.id, s.accentColor) : s.accentColor;
              return (
              <motion.button
                key={s.id}
                type="button"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                whileHover={{ y: -3 }}
                whileTap={{ scale: 0.985 }}
                transition={{
                  duration: 0.2,
                  delay: Math.min(idx * 0.035, 0.21),
                  ease: [0.16, 1, 0.3, 1],
                }}
                onClick={() => onSelectSubject(s.id)}
                className="rahhala-card relative overflow-hidden p-4 sm:p-5 text-right flex flex-col justify-between min-h-[140px] hover:border-[var(--accent)] group"
              >
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute -top-8 -left-8 w-24 h-24 rounded-full blur-2xl opacity-15 group-hover:opacity-30 transition-opacity"
                  style={{ backgroundColor: cardColor }}
                />
                <div className="relative flex items-start justify-between gap-2 w-full">
                  <div
                    className="w-11 h-11 rounded-2xl flex items-center justify-center shrink-0 border border-white/10"
                    style={{
                      backgroundColor: `${cardColor}24`,
                      color: cardColor,
                    }}
                  >
                    <SubjectIcon name={s.iconName} className="w-5 h-5" />
                  </div>
                  <Icons.ChevronLeft className="w-4 h-4 text-[var(--text-secondary)] group-hover:text-[var(--accent)] group-hover:-translate-x-0.5 transition-transform mt-1" />
                </div>

                <div className="relative mt-4">
                  <div className="font-bold text-sm sm:text-base text-[var(--text-primary)] line-clamp-2">
                    {s.name}
                  </div>
                  <div className="text-xs text-[var(--text-secondary)] mt-1 tabular-nums">
                    {s.materialCount} محتوى · {s.sectionCount} أقسام
                  </div>
                </div>
              </motion.button>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
