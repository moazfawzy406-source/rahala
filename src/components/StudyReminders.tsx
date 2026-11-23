import React, { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import type { AlertToneId, StudyReminderRecord, SubjectRecord } from '../../shared/types';
import { formatRemainingCountdown } from '../hooks/useStudyReminders';
import { getToneLabel } from '../hooks/useSubjectPreferences';
import { playAlertTone } from '../lib/alertAudio';
import { apiRequest } from '../lib/api';
import { formatDateTime } from '../lib/formatters';
import { Icons } from './Icons';
import { ModalShell } from './UI';

function defaultLocalDatetimeInput(offsetMinutes = 30): string {
  const d = new Date(Date.now() + offsetMinutes * 60_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function StudyRemindersModal({
  open,
  onClose,
  initialSubjectId,
  reminders,
  nowTick,
  getSubjectColor,
  getSubjectTone,
  onOpenSettings,
  onCreate,
  onSnooze,
  onComplete,
  onDelete,
  onOpenSubject,
}: {
  open: boolean;
  onClose: () => void;
  initialSubjectId: string | null;
  reminders: StudyReminderRecord[];
  nowTick: number;
  getSubjectColor: (subjectId: string | null | undefined, fallbackColor?: string) => string;
  getSubjectTone: (subjectId: string | null | undefined) => AlertToneId;
  onOpenSettings: () => void;
  onCreate: (input: {
    subjectId: string | null;
    subjectName?: string;
    note?: string;
    delayMinutes?: number;
    remindAt?: number;
  }) => Promise<boolean>;
  onSnooze: (id: string, minutes?: number) => Promise<void>;
  onComplete: (id: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onOpenSubject: (subjectId: string) => void;
}) {
  const [subjects, setSubjects] = useState<SubjectRecord[]>([]);
  const [selectedSubjectId, setSelectedSubjectId] = useState<string>('');
  const [note, setNote] = useState('');
  const [mode, setMode] = useState<'timer' | 'clock'>('timer');
  const [delayMinutes, setDelayMinutes] = useState<number>(25);
  const [clockValue, setClockValue] = useState<string>(() => defaultLocalDatetimeInput(30));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setClockValue(defaultLocalDatetimeInput(30));
    apiRequest<{ subjects: SubjectRecord[] }>('/api/resources/subjects', { background: true })
      .then((res) => {
        setSubjects(res.subjects);
        if (initialSubjectId && res.subjects.some((s) => s.id === initialSubjectId)) {
          setSelectedSubjectId(initialSubjectId);
        } else if (!selectedSubjectId && res.subjects.length > 0) {
          setSelectedSubjectId(res.subjects[0].id);
        }
      })
      .catch(() => {});
  }, [open, initialSubjectId]);

  useEffect(() => {
    if (initialSubjectId) {
      setSelectedSubjectId(initialSubjectId);
    }
  }, [initialSubjectId]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      let ok = false;
      if (mode === 'timer') {
        ok = await onCreate({
          subjectId: selectedSubjectId || null,
          subjectName: selectedSubjectId ? undefined : 'مذاكرة عامة',
          note,
          delayMinutes: Math.max(1, Number(delayMinutes) || 25),
        });
      } else {
        const parsedTs = new Date(clockValue).getTime();
        ok = await onCreate({
          subjectId: selectedSubjectId || null,
          subjectName: selectedSubjectId ? undefined : 'مذاكرة عامة',
          note,
          remindAt: parsedTs,
        });
      }
      if (ok) {
        setNote('');
      }
    } finally {
      setBusy(false);
    }
  };

  const presets = [
    { label: '٥ د', value: 5 },
    { label: '١٥ د', value: 15 },
    { label: '٢٥ د', value: 25 },
    { label: '٤٥ د', value: 45 },
    { label: 'ساعة', value: 60 },
    { label: 'ساعتان', value: 120 },
  ];

  const activeAndDue = reminders.filter((r) => r.status !== 'completed');
  const completed = reminders.filter((r) => r.status === 'completed').slice(0, 5);

  return (
    <ModalShell open={open} onClose={onClose} title="منبه وتذكيرات المذاكرة" maxWidth="max-w-lg">
      <div className="space-y-5">
        <form onSubmit={handleCreate} className="space-y-3.5">
          <div>
            <div className="flex items-center justify-between gap-2 mb-1.5">
              <label
                htmlFor="reminder-subject"
                className="block text-xs font-bold text-[var(--text-secondary)]"
              >
                المادة الدراسية
              </label>
              <button
                type="button"
                onClick={() => {
                  onClose();
                  onOpenSettings();
                }}
                className="text-xs font-bold text-[var(--accent)] hover:underline flex items-center gap-1 whitespace-nowrap"
              >
                <Icons.Sliders className="w-3.5 h-3.5" />
                <span>تخصيص الألوان والنغمات</span>
              </button>
            </div>
            <select
              id="reminder-subject"
              value={selectedSubjectId}
              onChange={(e) => setSelectedSubjectId(e.target.value)}
              className="rahhala-input w-full px-3.5 py-2 text-sm"
            >
              {subjects.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
              <option value="">مذاكرة عامة</option>
            </select>
            {(() => {
              const selectedSubj = subjects.find((s) => s.id === selectedSubjectId);
              const previewColor = getSubjectColor(
                selectedSubjectId || null,
                selectedSubj?.accentColor
              );
              const previewTone = getSubjectTone(selectedSubjectId || null);
              return (
                <div className="mt-2 flex items-center justify-between gap-2 text-xs text-[var(--text-secondary)]">
                  <div className="flex items-center gap-2 min-w-0">
                    <span
                      className="w-3 h-3 rounded-full shrink-0"
                      style={{ backgroundColor: previewColor }}
                      aria-hidden="true"
                    />
                    <span className="truncate">
                      لون التنبيه · نغمة: {getToneLabel(previewTone)}
                    </span>
                  </div>
                  {previewTone !== 'silent' && (
                    <button
                      type="button"
                      onClick={() => playAlertTone(previewTone)}
                      className="text-xs font-bold text-[var(--text-primary)] hover:text-[var(--accent)] flex items-center gap-1 shrink-0"
                    >
                      <Icons.Volume2 className="w-3.5 h-3.5 text-[var(--accent)]" />
                      <span>معاينة</span>
                    </button>
                  )}
                </div>
              );
            })()}
          </div>

          <div>
            <label
              htmlFor="reminder-note"
              className="block text-xs font-bold text-[var(--text-secondary)] mb-1.5"
            >
              ماذا ستذاكر؟ (اختياري)
            </label>
            <input
              id="reminder-note"
              type="text"
              maxLength={140}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="مثال: مراجعة المحاضرة الأولى وحل التدريبات"
              className="rahhala-input w-full px-3.5 py-2 text-sm"
            />
          </div>

          <div>
            <div className="flex items-center justify-between gap-2 mb-2">
              <span className="text-xs font-bold text-[var(--text-secondary)]">طريقة التوقيت</span>
              <div className="inline-flex p-1 rounded-xl bg-[var(--bg-surface)] border border-[var(--divider)]">
                <button
                  type="button"
                  onClick={() => setMode('timer')}
                  className={`px-3 py-1 rounded-lg text-xs font-bold transition-colors whitespace-nowrap ${
                    mode === 'timer'
                      ? 'bg-[var(--accent)] text-[var(--accent-fg)]'
                      : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                  }`}
                >
                  مؤقت سريع
                </button>
                <button
                  type="button"
                  onClick={() => setMode('clock')}
                  className={`px-3 py-1 rounded-lg text-xs font-bold transition-colors whitespace-nowrap ${
                    mode === 'clock'
                      ? 'bg-[var(--accent)] text-[var(--accent-fg)]'
                      : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                  }`}
                >
                  توقيت محدد
                </button>
              </div>
            </div>

            {mode === 'timer' ? (
              <div className="space-y-2.5">
                <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
                  {presets.map((p) => {
                    const selected = delayMinutes === p.value;
                    return (
                      <button
                        key={p.value}
                        type="button"
                        onClick={() => setDelayMinutes(p.value)}
                        className={`min-h-[40px] rounded-xl text-xs font-bold border transition-colors tabular-nums ${
                          selected
                            ? 'bg-[var(--accent-soft)] border-[var(--accent)] text-[var(--accent)]'
                            : 'bg-[var(--bg-surface)] border-[var(--divider)] text-[var(--text-primary)] hover:border-[var(--accent)]'
                        }`}
                      >
                        {p.label}
                      </button>
                    );
                  })}
                </div>
                <div className="flex items-center gap-2">
                  <label
                    htmlFor="custom-minutes"
                    className="text-xs text-[var(--text-secondary)] shrink-0"
                  >
                    أو مدة مخصصة (بالدقائق):
                  </label>
                  <input
                    id="custom-minutes"
                    type="number"
                    min={1}
                    max={1440}
                    value={delayMinutes}
                    onChange={(e) => setDelayMinutes(Number(e.target.value))}
                    className="rahhala-input w-28 px-3 py-1.5 text-sm text-center tabular-nums"
                  />
                </div>
              </div>
            ) : (
              <input
                type="datetime-local"
                dir="ltr"
                required
                value={clockValue}
                onChange={(e) => setClockValue(e.target.value)}
                className="rahhala-input w-full px-3.5 py-2 text-sm text-left"
              />
            )}
          </div>

          <button
            type="submit"
            disabled={busy}
            className="w-full min-h-[46px] rounded-xl bg-[var(--accent)] text-[var(--accent-fg)] font-bold text-sm hover:bg-[var(--accent-hi)] transition-colors disabled:opacity-60 flex items-center justify-center gap-2"
          >
            <Icons.AlarmClock className="w-4 h-4" />
            <span>{busy ? 'جاري الحفظ...' : 'ضبط المنبه الآن'}</span>
          </button>
        </form>

        <div className="pt-4 border-t border-[var(--divider)] space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-extrabold text-[var(--text-primary)]">
              التذكيرات القادمة والنشطة
            </h3>
            <span className="text-xs text-[var(--text-secondary)] tabular-nums">
              {activeAndDue.length} منبه
            </span>
          </div>

          {activeAndDue.length === 0 ? (
            <p className="text-xs text-[var(--text-secondary)] py-3 text-center">
              لا توجد منبهات نشطة حالياً — اضبط منبهاً لمادتك ليتم تنبيهك داخل الموقع.
            </p>
          ) : (
            <div className="divide-y divide-[var(--divider)]">
              {activeAndDue.map((rem) => {
                const isDue = rem.status === 'triggered';
                const remSubject = subjects.find((s) => s.id === rem.subjectId);
                const remColor = getSubjectColor(rem.subjectId, remSubject?.accentColor);
                const remTone = getSubjectTone(rem.subjectId);
                return (
                  <div key={rem.id} className="py-3 first:pt-1 last:pb-1 flex items-center justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span
                          className="w-2.5 h-2.5 rounded-full shrink-0"
                          style={{ backgroundColor: remColor }}
                          aria-hidden="true"
                        />
                        {rem.subjectId ? (
                          <button
                            type="button"
                            onClick={() => {
                              onOpenSubject(rem.subjectId!);
                              onClose();
                            }}
                            className="font-bold text-sm text-[var(--text-primary)] hover:text-[var(--accent)] truncate text-right"
                          >
                            {rem.subjectName}
                          </button>
                        ) : (
                          <span className="font-bold text-sm text-[var(--text-primary)] truncate">
                            {rem.subjectName}
                          </span>
                        )}
                      </div>
                      {rem.note && (
                        <p className="text-xs text-[var(--text-secondary)] truncate mt-0.5">
                          {rem.note}
                        </p>
                      )}
                      <div className="text-xs text-[var(--text-secondary)] mt-1 flex flex-wrap items-center gap-1.5 tabular-nums">
                        <span
                          className="font-bold"
                          style={{ color: isDue ? remColor : 'var(--accent)' }}
                        >
                          {isDue ? 'حان موعد المذاكرة الآن' : formatRemainingCountdown(rem.remindAt, nowTick)}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span>{formatDateTime(rem.remindAt)}</span>
                        <span aria-hidden="true">·</span>
                        <span>{getToneLabel(remTone)}</span>
                      </div>
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0">
                      {isDue && (
                        <button
                          type="button"
                          onClick={() => void onSnooze(rem.id, 10)}
                          className="min-h-[38px] px-2.5 rounded-xl bg-[var(--bg-surface)] text-xs font-semibold text-[var(--text-primary)] hover:border-[var(--accent)] border border-[var(--divider)] whitespace-nowrap"
                        >
                          +١٠ د
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => void onComplete(rem.id)}
                        aria-label="تحديد كمكتمل"
                        className="min-h-[38px] min-w-[38px] rounded-xl bg-[var(--success-soft)] text-[var(--success)] flex items-center justify-center hover:opacity-90"
                      >
                        <Icons.Check className="w-4 h-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => void onDelete(rem.id)}
                        aria-label="حذف التذكير"
                        className="min-h-[38px] min-w-[38px] rounded-xl bg-[var(--bg-surface)] text-[var(--text-secondary)] hover:text-[var(--error)] hover:bg-[var(--error-soft)] flex items-center justify-center"
                      >
                        <Icons.Trash className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {completed.length > 0 && (
            <div className="pt-2 border-t border-[var(--divider)]">
              <div className="text-xs font-bold text-[var(--text-secondary)] mb-2">
                تذكيرات مكتملة مؤخراً
              </div>
              <div className="space-y-1.5">
                {completed.map((rem) => (
                  <div
                    key={rem.id}
                    className="flex items-center justify-between gap-2 text-xs text-[var(--text-secondary)] py-1"
                  >
                    <span className="truncate line-through opacity-80">
                      {rem.subjectName}
                      {rem.note ? ` · ${rem.note}` : ''}
                    </span>
                    <button
                      type="button"
                      onClick={() => void onDelete(rem.id)}
                      aria-label="حذف التذكير المكتمل"
                      className="min-h-[32px] min-w-[32px] rounded-lg hover:text-[var(--error)] flex items-center justify-center shrink-0"
                    >
                      <Icons.X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </ModalShell>
  );
}

export function StudyAlarmBanner({
  alerts,
  getSubjectColor,
  getSubjectTone,
  onOpenSubject,
  onSnooze,
  onComplete,
}: {
  alerts: StudyReminderRecord[];
  getSubjectColor: (subjectId: string | null | undefined, fallbackColor?: string) => string;
  getSubjectTone: (subjectId: string | null | undefined) => AlertToneId;
  onOpenSubject: (subjectId: string) => void;
  onSnooze: (id: string, minutes?: number) => Promise<void>;
  onComplete: (id: string) => Promise<void>;
}) {
  const [dismissed,setDismissed]=useState<Set<string>>(new Set());
  const current = alerts.find(a=>!dismissed.has(a.id));
  const dismiss=()=>{if(current)setDismissed(prev=>new Set([...prev,current.id]));};
  const alertColor = current ? getSubjectColor(current.subjectId) : '#E3B23C';
  const alertTone = current ? getSubjectTone(current.subjectId) : 'chime';

  return (
    <AnimatePresence>
      {current && (
        <motion.div
          key={current.id}
          drag="x"
          dragConstraints={{left:0,right:0}}
          dragElastic={.8}
          dragMomentum={false}
          onDragEnd={(_event,info)=>{if(Math.abs(info.offset.x)>85||(Math.abs(info.offset.x)>30&&Math.abs(info.velocity.x)>450))dismiss();}}
          initial={{ opacity: 0, y: -16, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, x: 360, scale: 0.96 }}
          transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
          role="alertdialog"
          aria-label="تنبيه موعد المذاكرة"
          className="fixed top-16 left-1/2 -translate-x-1/2 z-40 w-[min(92vw,30rem)] rahhala-glass-panel p-4 shadow-2xl overflow-hidden"
          style={{
            touchAction:'pan-y',
            borderColor: `${alertColor}77`,
            boxShadow: `0 18px 44px -12px ${alertColor}40, var(--glass-shadow)`,
          }}
        >
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -top-12 -right-12 w-36 h-36 rounded-full blur-2xl opacity-25"
            style={{ backgroundColor: alertColor }}
          />
          <div className="relative flex items-start gap-3">
            <div
              className="w-11 h-11 rounded-2xl flex items-center justify-center shrink-0 border"
              style={{
                backgroundColor: `${alertColor}24`,
                color: alertColor,
                borderColor: `${alertColor}55`,
              }}
            >
              <Icons.BellRing className="w-5 h-5" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <div className="text-xs font-bold flex items-center gap-1.5" style={{ color: alertColor }}>
                  <span>حان موعد المذاكرة</span>
                  <span aria-hidden="true">·</span>
                  <span className="text-[var(--text-secondary)] font-semibold">
                    {getToneLabel(alertTone)}
                  </span>
                  {alerts.length > 1 ? ` · (${alerts.length})` : ''}
                </div>
                <button type="button" aria-label="إخفاء التنبيه" onClick={dismiss} className="min-w-[32px] min-h-[32px] flex items-center justify-center text-[var(--text-secondary)]"><Icons.X className="w-4 h-4"/></button>
                {alertTone !== 'silent' && (
                  <button
                    type="button"
                    aria-label="إعادة تشغيل نغمة التنبيه"
                    onClick={() => playAlertTone(alertTone)}
                    className="min-h-[28px] min-w-[28px] rounded-lg flex items-center justify-center text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                  >
                    <Icons.Volume2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
              <div className="text-base font-extrabold text-[var(--text-primary)] truncate mt-0.5">
                {current.subjectName}
              </div>
              {current.note && (
                <p className="text-xs text-[var(--text-secondary)] mt-0.5 line-clamp-2">
                  {current.note}
                </p>
              )}
              <div className="flex flex-wrap items-center gap-2 mt-3">
                {current.subjectId && (
                  <button
                    type="button"
                    onClick={() => {
                      onOpenSubject(current.subjectId!);
                      void onComplete(current.id);
                    }}
                    className="min-h-[40px] px-3.5 rounded-xl text-xs font-bold transition-opacity hover:opacity-90 whitespace-nowrap"
                    style={{
                      backgroundColor: alertColor,
                      color: '#0C1622',
                    }}
                  >
                    فتح المادة الآن
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => void onSnooze(current.id, 10)}
                  className="min-h-[40px] px-3.5 rounded-xl bg-[var(--bg-surface)] border border-[var(--divider)] text-xs font-bold text-[var(--text-primary)] hover:border-[var(--accent)] transition-colors whitespace-nowrap"
                >
                  غفوة ١٠ دقائق
                </button>
                <button
                  type="button"
                  onClick={() => void onComplete(current.id)}
                  className="min-h-[40px] px-3 rounded-xl text-xs font-semibold text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors whitespace-nowrap"
                >
                  تم الإنجاز
                </button>
              </div>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
