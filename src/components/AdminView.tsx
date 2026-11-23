import React, { useCallback, useEffect, useState } from 'react';
import type {
  AppPublicConfig,
  AuthUser,
  HistoryRequestRecord,
  MaterialKind,
  PendingUserRecord,
  SectionRecord,
  SubjectRecord,
} from '../../shared/types';
import { ApiError, apiRequest, getAuthRequestHeaders } from '../lib/api';
import { formatDateTime, MATERIAL_KIND_LABELS } from '../lib/formatters';
import { Icons } from './Icons';
import { ErrorRetryPanel } from './UI';

export function AdminView({
  user,
  config,
  onConfigUpdated,
  onResourcesUpdated,
  onToast,
  onRequestsBadgeChange,
}: {
  user: AuthUser;
  config: AppPublicConfig;
  onConfigUpdated: () => void;
  onResourcesUpdated: () => void;
  onToast: (msg: string, isError?: boolean) => void;
  onRequestsBadgeChange: (count: number) => void;
}) {
  const [openAcc, setOpenAcc] = useState<string>('registrations');
  const [pendingUsers, setPendingUsers] = useState<PendingUserRecord[]>([]);
  const [pendingHistory, setPendingHistory] = useState<HistoryRequestRecord[]>([]);
  const [reqLoading, setReqLoading] = useState(true);
  const [reqError, setReqError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Subjects & sections for resource forms
  const [subjects, setSubjects] = useState<SubjectRecord[]>([]);
  const [sections, setSections] = useState<SectionRecord[]>([]);

  // Form 1: إضافة مادة (adding a resource link inside an existing subject)
  const [matSubjectId, setMatSubjectId] = useState('');
  const [matSectionId, setMatSectionId] = useState('');
  const [matTitle, setMatTitle] = useState('');
  const [matUrl, setMatUrl] = useState('');
  const [matKind, setMatKind] = useState<MaterialKind>('pdf');
  const [matNote, setMatNote] = useState('');
  const [matBusy, setMatBusy] = useState(false);

  // Form 2: إضافة مادة دراسية جديدة
  const [newSubName, setNewSubName] = useState('');
  const [newSubColor, setNewSubColor] = useState('#E3B23C');
  const [newSubIcon, setNewSubIcon] = useState<'book-open' | 'feather' | 'scroll' | 'landmark' | 'compass' | 'layers'>('book-open');
  const [subBusy, setSubBusy] = useState(false);

  // Form 3: إضافة قسم لمادة
  const [secSubjectId, setSecSubjectId] = useState('');
  const [secLabel, setSecLabel] = useState('');
  const [secBusy, setSecBusy] = useState(false);

  // Settings form
  const [instSubtitle, setInstSubtitle] = useState(config.institutionSubtitle);
  const [meetingMode, setMeetingMode] = useState<'builtin' | 'external' | 'unconfigured'>(
    config.meetingMode
  );
  const [meetingUrl, setMeetingUrl] = useState(config.meetingExternalUrl);
  const [defaultRoomAccess, setDefaultRoomAccess] = useState<'open' | 'knock'>(
    config.defaultRoomAccessType || 'open'
  );
  const existingTurn = config.iceServers?.find((s) => {
    const first = Array.isArray(s.urls) ? s.urls[0] : s.urls;
    return typeof first === 'string' && /^turns?:/i.test(first);
  });
  const [turnUrl, setTurnUrl] = useState(
    existingTurn ? (Array.isArray(existingTurn.urls) ? existingTurn.urls[0] : existingTurn.urls) : ''
  );
  const [turnUsername, setTurnUsername] = useState(existingTurn?.username || '');
  const [turnCredential, setTurnCredential] = useState(existingTurn?.credential || '');
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [archiveBusy, setArchiveBusy] = useState(false);

  useEffect(() => {
    setInstSubtitle(config.institutionSubtitle);
    setMeetingMode(config.meetingMode);
    setMeetingUrl(config.meetingExternalUrl);
    setDefaultRoomAccess(config.defaultRoomAccessType || 'open');
    const turnEntry = config.iceServers?.find((s) => {
      const first = Array.isArray(s.urls) ? s.urls[0] : s.urls;
      return typeof first === 'string' && /^turns?:/i.test(first);
    });
    setTurnUrl(
      turnEntry ? (Array.isArray(turnEntry.urls) ? turnEntry.urls[0] : turnEntry.urls) : ''
    );
    setTurnUsername(turnEntry?.username || '');
    setTurnCredential(turnEntry?.credential || '');
  }, [config]);

  const loadRequests = useCallback(async () => {
    setReqLoading(true);
    setReqError(null);
    try {
      const res = await apiRequest<{
        pendingUsers: PendingUserRecord[];
        pendingHistory: HistoryRequestRecord[];
        totalPendingCount: number;
      }>('/api/admin/requests');
      setPendingUsers(res.pendingUsers);
      setPendingHistory(res.pendingHistory);
      onRequestsBadgeChange(res.totalPendingCount);
    } catch (err) {
      setReqError(err instanceof ApiError ? err.message : 'تعذر تحميل الطلبات');
    } finally {
      setReqLoading(false);
    }
  }, [onRequestsBadgeChange]);

  const loadSubjectsList = useCallback(async () => {
    try {
      const res = await apiRequest<{ subjects: SubjectRecord[] }>('/api/resources/subjects');
      setSubjects(res.subjects);
      if (res.subjects.length > 0) {
        setMatSubjectId((cur) => cur || res.subjects[0].id);
        setSecSubjectId((cur) => cur || res.subjects[0].id);
      }
    } catch {
      // handled in UI
    }
  }, []);

  useEffect(() => {
    void loadRequests();
    void loadSubjectsList();
  }, [loadRequests, loadSubjectsList]);

  useEffect(() => {
    if (!matSubjectId) {
      setSections([]);
      setMatSectionId('');
      return;
    }
    apiRequest<{ sections: SectionRecord[] }>(
      `/api/resources/subjects/${encodeURIComponent(matSubjectId)}`
    )
      .then((res) => {
        setSections(res.sections);
        setMatSectionId(res.sections[0]?.id || '');
      })
      .catch(() => {
        setSections([]);
        setMatSectionId('');
      });
  }, [matSubjectId]);

  const handleRegistrationDecision = async (id: string, approve: boolean) => {
    setBusyId(id);
    try {
      await apiRequest(
        `/api/admin/registrations/${encodeURIComponent(id)}/${approve ? 'approve' : 'reject'}`,
        { method: 'POST' }
      );
      onToast(approve ? 'تمت الموافقة على انضمام الطالب' : 'تم رفض وحذف الطلب');
      await loadRequests();
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'تعذر تنفيذ القرار', true);
    } finally {
      setBusyId(null);
    }
  };

  const handleHistoryDecision = async (id: string, decision: 'approved' | 'rejected') => {
    setBusyId(id);
    try {
      await apiRequest(`/api/admin/history-requests/${encodeURIComponent(id)}/decide`, {
        method: 'POST',
        body: { decision },
      });
      onToast(decision === 'approved' ? 'تم منح صلاحية الرسائل القديمة' : 'تم رفض الطلب');
      await loadRequests();
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'تعذر تنفيذ القرار', true);
    } finally {
      setBusyId(null);
    }
  };

  const handleAddMaterial = async (e: React.FormEvent) => {
    e.preventDefault();
    setMatBusy(true);
    try {
      await apiRequest('/api/resources/materials', {
        method: 'POST',
        body: {
          subjectId: matSubjectId,
          sectionId: matSectionId,
          title: matTitle,
          kind: matKind,
          url: matUrl,
          note: matNote,
        },
      });
      setMatTitle('');
      setMatUrl('');
      setMatNote('');
      onResourcesUpdated();
      onToast('تمت إضافة المحتوى في أعلى القسم بنجاح');
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'تعذر إضافة المحتوى', true);
    } finally {
      setMatBusy(false);
    }
  };

  const handleAddSubject = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubBusy(true);
    try {
      await apiRequest('/api/resources/subjects', {
        method: 'POST',
        body: {
          name: newSubName,
          accentColor: newSubColor,
          iconName: newSubIcon,
        },
      });
      setNewSubName('');
      await loadSubjectsList();
      onResourcesUpdated();
      onToast('تم إنشاء المادة الدراسية الجديدة مع أقسامها الافتراضية');
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'تعذر إنشاء المادة', true);
    } finally {
      setSubBusy(false);
    }
  };

  const handleAddSection = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!secSubjectId) return;
    setSecBusy(true);
    try {
      await apiRequest(`/api/resources/subjects/${encodeURIComponent(secSubjectId)}/sections`, {
        method: 'POST',
        body: { label: secLabel },
      });
      setSecLabel('');
      if (secSubjectId === matSubjectId) {
        const res = await apiRequest<{ sections: SectionRecord[] }>(
          `/api/resources/subjects/${encodeURIComponent(matSubjectId)}`
        );
        setSections(res.sections);
      }
      onResourcesUpdated();
      onToast('تمت إضافة القسم للمادة');
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'تعذر إضافة القسم', true);
    } finally {
      setSecBusy(false);
    }
  };

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    setSettingsBusy(true);
    try {
      const iceServers = [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        ...(turnUrl.trim()
          ? [
              {
                urls: turnUrl.trim(),
                ...(turnUsername.trim() ? { username: turnUsername.trim() } : {}),
                ...(turnCredential.trim() ? { credential: turnCredential.trim() } : {}),
              },
            ]
          : []),
      ];

      await apiRequest('/api/admin/settings', {
        method: 'PATCH',
        body: {
          institutionSubtitle: instSubtitle,
          meetingMode,
          meetingProviderUrl: meetingMode === 'external' ? meetingUrl : '',
          defaultRoomAccessType: defaultRoomAccess,
          iceServers,
        },
      });
      onConfigUpdated();
      onToast('تم حفظ إعدادات المنصة ومجلس المذاكرة');
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'تعذر حفظ الإعدادات', true);
    } finally {
      setSettingsBusy(false);
    }
  };

  const handleDownloadArchive = async () => {
    setArchiveBusy(true);
    try {
      const res = await fetch('/api/admin/export-archive', {
        credentials: 'include',
        headers: getAuthRequestHeaders(),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'تعذر تجهيز الأرشيف');
      }
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      if (!ct.includes('zip')) {
        throw new Error('استجابة غير صالحة بدلًا من ملف الأرشيف');
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'rahhala-source-sanitized.zip';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
      onToast('تم تحميل نسخة الكود المنقّاة بنجاح');
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'فشل تحميل الأرشيف', true);
    } finally {
      setArchiveBusy(false);
    }
  };

  const AccordionItem = ({
    id,
    title,
    badge,
    children,
  }: {
    id: string;
    title: string;
    badge?: number;
    children: React.ReactNode;
  }) => {
    const isOpen = openAcc === id;
    return (
      <section className="rahhala-card overflow-hidden">
        <button
          type="button"
          aria-expanded={isOpen}
          onClick={() => setOpenAcc(isOpen ? '' : id)}
          className="w-full min-h-[56px] px-5 py-3.5 flex items-center justify-between gap-3 text-right hover:bg-[var(--bg-surface)]/50 transition-colors"
        >
          <div className="flex items-center gap-2.5">
            <span className="font-extrabold text-sm sm:text-base text-[var(--text-primary)]">
              {title}
            </span>
            {typeof badge === 'number' && badge > 0 && (
              <span className="text-xs font-extrabold text-[var(--accent)] tabular-nums">
                ({badge})
              </span>
            )}
          </div>
          <Icons.ChevronDown
            className={`w-5 h-5 text-[var(--text-secondary)] transition-transform ${
              isOpen ? 'rotate-180' : ''
            }`}
          />
        </button>
        {isOpen && (
          <div className="p-5 border-t border-[var(--divider)]">{children}</div>
        )}
      </section>
    );
  };

  return (
    <div className="space-y-4 max-w-3xl mx-auto">
      <div className="px-1">
        <h1 className="text-xl font-extrabold text-[var(--text-primary)]">لوحة الإدارة</h1>
        <p className="text-xs text-[var(--text-secondary)] mt-0.5">
          إدارة طلبات الانضمام، صلاحيات الرسائل القديمة، والمواد الدراسية.
        </p>
      </div>

      {/* 1. طلبات الانضمام */}
      <AccordionItem id="registrations" title="طلبات الانضمام" badge={pendingUsers.length}>
        {reqLoading ? (
          <div className="h-20 rounded-xl bg-[var(--bg-surface)] animate-pulse" />
        ) : reqError ? (
          <ErrorRetryPanel message={reqError} onRetry={loadRequests} />
        ) : pendingUsers.length === 0 ? (
          <p className="text-sm text-[var(--text-secondary)] text-center py-3">
            لا توجد طلبات جديدة
          </p>
        ) : (
          <div className="divide-y divide-[var(--divider)]">
            {pendingUsers.map((u) => (
              <div
                key={u.id}
                className="py-3 first:pt-0 last:pb-0 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
              >
                <div>
                  <div className="font-bold text-sm text-[var(--text-primary)]">{u.displayName}</div>
                  <div className="text-xs text-[var(--text-secondary)] flex flex-wrap gap-2 mt-0.5">
                    <span dir="ltr">@{u.username}</span>
                    <span>·</span>
                    <span dir="ltr">{u.email}</span>
                    <span>·</span>
                    <span>{formatDateTime(u.createdAt)}</span>
                  </div>
                </div>
                <div className="flex gap-2 shrink-0">
                  <button
                    type="button"
                    disabled={busyId === u.id}
                    onClick={() => handleRegistrationDecision(u.id, true)}
                    className="min-h-[40px] px-4 rounded-xl bg-[var(--accent)] text-[var(--accent-fg)] text-xs font-bold"
                  >
                    قبول
                  </button>
                  <button
                    type="button"
                    disabled={busyId === u.id}
                    onClick={() => handleRegistrationDecision(u.id, false)}
                    className="min-h-[40px] px-4 rounded-xl bg-[var(--error-soft)] text-[var(--error)] text-xs font-bold"
                  >
                    رفض
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </AccordionItem>

      {/* 2. طلبات الرسائل القديمة */}
      <AccordionItem id="history" title="طلبات الرسائل القديمة" badge={pendingHistory.length}>
        {reqLoading ? (
          <div className="h-20 rounded-xl bg-[var(--bg-surface)] animate-pulse" />
        ) : reqError ? (
          <ErrorRetryPanel message={reqError} onRetry={loadRequests} />
        ) : pendingHistory.length === 0 ? (
          <p className="text-sm text-[var(--text-secondary)] text-center py-3">
            لا توجد طلبات جديدة
          </p>
        ) : (
          <div className="divide-y divide-[var(--divider)]">
            {pendingHistory.map((h) => (
              <div
                key={h.id}
                className="py-3 first:pt-0 last:pb-0 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
              >
                <div>
                  <div className="font-bold text-sm text-[var(--text-primary)]">
                    {h.displayName}
                  </div>
                  <div className="text-xs text-[var(--text-secondary)]">
                    <span dir="ltr">@{h.username}</span> · {formatDateTime(h.createdAt)}
                  </div>
                </div>
                <div className="flex gap-2 shrink-0">
                  <button
                    type="button"
                    disabled={busyId === h.id}
                    onClick={() => handleHistoryDecision(h.id, 'approved')}
                    className="min-h-[40px] px-4 rounded-xl bg-[var(--accent)] text-[var(--accent-fg)] text-xs font-bold"
                  >
                    قبول
                  </button>
                  <button
                    type="button"
                    disabled={busyId === h.id}
                    onClick={() => handleHistoryDecision(h.id, 'rejected')}
                    className="min-h-[40px] px-4 rounded-xl bg-[var(--error-soft)] text-[var(--error)] text-xs font-bold"
                  >
                    رفض
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </AccordionItem>

      {/* 3. إضافة مادة (إضافة رابط محتوى داخل مادة موجودة) */}
      <AccordionItem id="add-material" title="إضافة مادة">
        <p className="text-xs text-[var(--text-secondary)] mb-4">
          هنا بتضيف رابط ملخص أو محاضرة أو مرجع جوه مادة دراسية موجودة بالفعل (لإنشاء مادة دراسية جديدة استخدم القسم التالي).
        </p>
        <form onSubmit={handleAddMaterial} className="space-y-3.5">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-bold text-[var(--text-secondary)] mb-1">
                المادة
              </label>
              <select
                value={matSubjectId}
                onChange={(e) => setMatSubjectId(e.target.value)}
                required
                className="rahhala-input w-full px-3 py-2"
              >
                {subjects.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-bold text-[var(--text-secondary)] mb-1">
                القسم
              </label>
              <select
                value={matSectionId}
                onChange={(e) => setMatSectionId(e.target.value)}
                required
                className="rahhala-input w-full px-3 py-2"
              >
                {sections.map((sec) => (
                  <option key={sec.id} value={sec.id}>
                    {sec.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-bold text-[var(--text-secondary)] mb-1">
                العنوان
              </label>
              <input
                type="text"
                required
                value={matTitle}
                onChange={(e) => setMatTitle(e.target.value)}
                placeholder="مثال: ملخص المحاضرة الثالثة"
                className="rahhala-input w-full px-3.5 py-2"
              />
            </div>
            <div>
              <label className="block text-xs font-bold text-[var(--text-secondary)] mb-1">
                نوع المحتوى
              </label>
              <select
                value={matKind}
                onChange={(e) => setMatKind(e.target.value as MaterialKind)}
                className="rahhala-input w-full px-3 py-2"
              >
                {Object.entries(MATERIAL_KIND_LABELS).map(([k, label]) => (
                  <option key={k} value={k}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-xs font-bold text-[var(--text-secondary)] mb-1">
              الرابط
            </label>
            <input
              type="url"
              dir="ltr"
              required
              value={matUrl}
              onChange={(e) => setMatUrl(e.target.value)}
              placeholder="https://..."
              className="rahhala-input w-full px-3.5 py-2 text-left"
            />
          </div>

          <div>
            <label className="block text-xs font-bold text-[var(--text-secondary)] mb-1">
              ملاحظة (اختياري)
            </label>
            <input
              type="text"
              value={matNote}
              onChange={(e) => setMatNote(e.target.value)}
              placeholder="أي توضيح للطلاب…"
              className="rahhala-input w-full px-3.5 py-2"
            />
          </div>

          <button
            type="submit"
            disabled={matBusy || !matSubjectId || !matSectionId}
            className="min-h-[44px] px-5 rounded-xl bg-[var(--accent)] text-[var(--accent-fg)] text-sm font-bold disabled:opacity-60"
          >
            {matBusy ? 'جاري الإضافة...' : 'إضافة المحتوى'}
          </button>
        </form>
      </AccordionItem>

      {/* 4. إضافة مادة دراسية جديدة */}
      <AccordionItem id="add-subject" title="إضافة مادة دراسية جديدة">
        <form onSubmit={handleAddSubject} className="space-y-3.5">
          <div>
            <label className="block text-xs font-bold text-[var(--text-secondary)] mb-1">
              اسم المادة الدراسية
            </label>
            <input
              type="text"
              required
              value={newSubName}
              onChange={(e) => setNewSubName(e.target.value)}
              placeholder="مثال: العقيدة الإسلامية"
              className="rahhala-input w-full px-3.5 py-2"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-bold text-[var(--text-secondary)] mb-1">
                اللون المميز
              </label>
              <input
                type="color"
                value={newSubColor}
                onChange={(e) => setNewSubColor(e.target.value)}
                className="h-11 w-full rounded-xl bg-[var(--bg-surface)] border border-[var(--divider)] p-1 cursor-pointer"
              />
            </div>
            <div>
              <label className="block text-xs font-bold text-[var(--text-secondary)] mb-1">
                الأيقونة
              </label>
              <select
                value={newSubIcon}
                onChange={(e) => setNewSubIcon(e.target.value as typeof newSubIcon)}
                className="rahhala-input w-full px-3 py-2"
              >
                <option value="book-open">كتاب مفتوح</option>
                <option value="feather">قلم / بلاغة</option>
                <option value="scroll">مخطوطة</option>
                <option value="landmark">تاريخ / مؤسسة</option>
                <option value="compass">توجيه / رحلة</option>
                <option value="layers">أقسام متعددة</option>
              </select>
            </div>
          </div>

          <button
            type="submit"
            disabled={subBusy}
            className="min-h-[44px] px-5 rounded-xl bg-[var(--accent)] text-[var(--accent-fg)] text-sm font-bold disabled:opacity-60"
          >
            {subBusy ? 'جاري الإنشاء...' : 'إنشاء المادة الدراسية'}
          </button>
        </form>
      </AccordionItem>

      {/* 5. إضافة قسم لمادة */}
      <AccordionItem id="add-section" title="إضافة قسم لمادة">
        <form onSubmit={handleAddSection} className="space-y-3.5">
          <div>
            <label className="block text-xs font-bold text-[var(--text-secondary)] mb-1">
              المادة الدراسية
            </label>
            <select
              value={secSubjectId}
              onChange={(e) => setSecSubjectId(e.target.value)}
              required
              className="rahhala-input w-full px-3 py-2"
            >
              {subjects.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-bold text-[var(--text-secondary)] mb-1">
              اسم القسم الجديد
            </label>
            <input
              type="text"
              required
              value={secLabel}
              onChange={(e) => setSecLabel(e.target.value)}
              placeholder="مثال: امتحانات سابقة أو تسجيلات"
              className="rahhala-input w-full px-3.5 py-2"
            />
          </div>
          <button
            type="submit"
            disabled={secBusy || !secSubjectId}
            className="min-h-[44px] px-5 rounded-xl bg-[var(--accent)] text-[var(--accent-fg)] text-sm font-bold disabled:opacity-60"
          >
            {secBusy ? 'جاري الإضافة...' : 'إضافة القسم'}
          </button>
        </form>
      </AccordionItem>

      {/* 6. إعدادات الهوية ومجلس المذاكرة */}
      <AccordionItem id="settings" title="إعدادات المنصة ومجلس المذاكرة">
        <form onSubmit={handleSaveSettings} className="space-y-3.5">
          <div>
            <label className="block text-xs font-bold text-[var(--text-secondary)] mb-1">
              العنوان الفرعي للمؤسسة (اختياري)
            </label>
            <input
              type="text"
              value={instSubtitle}
              onChange={(e) => setInstSubtitle(e.target.value)}
              placeholder="كلية الدعوة الإسلامية - الأزهر الشريف"
              className="rahhala-input w-full px-3.5 py-2"
            />
          </div>
          <div>
            <label className="block text-xs font-bold text-[var(--text-secondary)] mb-1">
              وضع مجلس المذاكرة
            </label>
            <select
              value={meetingMode}
              onChange={(e) => setMeetingMode(e.target.value as typeof meetingMode)}
              className="rahhala-input w-full px-3 py-2"
            >
              <option value="builtin">مجلس مدمج حقيقي (غرفة تحضير، صوت، فيديو، شاشة، وضوابط مضيف)</option>
              <option value="external">مزود اجتماعات خارجي مخصص (مثل Google Meet أو Jitsi)</option>
              <option value="unconfigured">غير مُعَد / معطّل مؤقتًا</option>
            </select>
          </div>

          {meetingMode === 'builtin' && (
            <div className="space-y-3.5 p-3.5 rounded-xl bg-[var(--bg-surface)] border border-[var(--divider)]">
              <div>
                <label className="block text-xs font-bold text-[var(--text-secondary)] mb-1">
                  سياسة الدخول الافتراضية للمجالس الجديدة
                </label>
                <select
                  value={defaultRoomAccess}
                  onChange={(e) => setDefaultRoomAccess(e.target.value as 'open' | 'knock')}
                  className="rahhala-input w-full px-3 py-2"
                >
                  <option value="open">مفتوح — يدخل الطلاب الموثقون مباشرة</option>
                  <option value="knock">موثوق (قاعة انتظار) — يطلب الطالب الإذن ويقبله المضيف</option>
                </select>
              </div>

              <div className="pt-2 border-t border-[var(--divider)] space-y-2.5">
                <div className="text-xs font-bold text-[var(--text-primary)]">
                  خادم TURN إضافي للشبكات المقيدة (اختياري)
                </div>
                <p className="text-[11px] text-[var(--text-secondary)] leading-relaxed">
                  يعمل البث عبر Google STUN تلقائياً. أضف خادم TURN إذا كان الطلاب يتصلون عبر شبكات جامعية أو بيانات هاتف مقيدة.
                </p>
                <input
                  type="text"
                  dir="ltr"
                  value={turnUrl}
                  onChange={(e) => setTurnUrl(e.target.value)}
                  placeholder="turn:global.relay.metered.ca:80"
                  className="rahhala-input w-full px-3 py-2 text-left text-xs"
                />
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  <input
                    type="text"
                    dir="ltr"
                    value={turnUsername}
                    onChange={(e) => setTurnUsername(e.target.value)}
                    placeholder="TURN Username (اختياري)"
                    className="rahhala-input w-full px-3 py-2 text-left text-xs"
                  />
                  <input
                    type="password"
                    dir="ltr"
                    value={turnCredential}
                    onChange={(e) => setTurnCredential(e.target.value)}
                    placeholder="TURN Credential (اختياري)"
                    className="rahhala-input w-full px-3 py-2 text-left text-xs"
                  />
                </div>
              </div>
            </div>
          )}

          {meetingMode === 'external' && (
            <div>
              <label className="block text-xs font-bold text-[var(--text-secondary)] mb-1">
                رابط غرفة المزود الخارجي
              </label>
              <input
                type="url"
                dir="ltr"
                value={meetingUrl}
                onChange={(e) => setMeetingUrl(e.target.value)}
                placeholder="https://meet.google.com/xxx-xxxx-xxx"
                className="rahhala-input w-full px-3.5 py-2 text-left"
              />
            </div>
          )}
          <button
            type="submit"
            disabled={settingsBusy}
            className="min-h-[44px] px-5 rounded-xl bg-[var(--accent)] text-[var(--accent-fg)] text-sm font-bold disabled:opacity-60"
          >
            {settingsBusy ? 'جاري الحفظ...' : 'حفظ الإعدادات'}
          </button>
        </form>
      </AccordionItem>

      {/* 7. Owner-only sanitized source archive export */}
      {user.role === 'owner' && (
        <AccordionItem id="archive" title="كود التطبيق / تحميل الأرشيف (للمالك فقط)">
          <p className="text-xs text-[var(--text-secondary)] mb-3 leading-relaxed">
            تحميل نسخة منقّاة من الكود المصدري للتطبيق خالية تمامًا من قاعدة البيانات والملفات المرفوعة ومتغيرات البيئة والأسرار.
          </p>
          <button
            type="button"
            disabled={archiveBusy}
            onClick={handleDownloadArchive}
            className="min-h-[44px] px-5 rounded-xl bg-[var(--bg-surface)] border border-[var(--accent)] text-[var(--accent)] text-sm font-bold inline-flex items-center gap-2 hover:bg-[var(--accent-soft)] disabled:opacity-60"
          >
            <Icons.Download className="w-4 h-4" />
            <span>{archiveBusy ? 'جاري تجهيز الأرشيف...' : 'تحميل أرشيف الكود (ZIP)'}</span>
          </button>
        </AccordionItem>
      )}
    </div>
  );
}
