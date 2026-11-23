import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { motion } from 'motion/react';
import type { StudyChallengeRecord, SubjectRecord } from '../../shared/types';
import { useWebSocket } from '../hooks/useWebSocket';
import { ApiError, apiRequest } from '../lib/api';
import { Icons } from './Icons';
import { Avatar, ConfirmDialog, EmptyState, ErrorRetryPanel, ModalShell } from './UI';

type ChallengeFilter = 'active' | 'mine' | 'ended';

function formatChallengeMinutes(minutes: number): string {
  if (minutes <= 0) return '0 د';
  if (minutes < 60) return `${minutes} د`;
  const hrs = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return rem === 0 ? `${hrs} س` : `${hrs} س ${rem} د`;
}

function formatRemainingChallengeTime(endsAt: number): string {
  const diff = endsAt - Date.now();
  if (diff <= 0) return 'منتهي';
  const days = Math.floor(diff / 86_400_000);
  if (days >= 1) return `متبقي ${days} ${days === 1 ? 'يوم' : days === 2 ? 'يومان' : days <= 10 ? 'أيام' : 'يوماً'}`;
  const hours = Math.max(1, Math.ceil(diff / 3_600_000));
  return `متبقي ${hours} ${hours === 1 ? 'ساعة' : hours === 2 ? 'ساعتان' : hours <= 10 ? 'ساعات' : 'ساعة'}`;
}

export function StudyChallengesSection({
  subjects,
  getSubjectColor,
  onToast,
  onActivityLogged,
  externalCreateTrigger,
  onExternalCreateHandled,
}: {
  subjects: SubjectRecord[];
  getSubjectColor?: (subjectId: string | null | undefined, fallbackColor?: string) => string;
  onToast: (msg: string, isError?: boolean) => void;
  onActivityLogged?: () => void;
  externalCreateTrigger?: number;
  onExternalCreateHandled?: () => void;
}) {
  const [challenges, setChallenges] = useState<StudyChallengeRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<ChallengeFilter>('active');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [customMinutesById, setCustomMinutesById] = useState<Record<string, string>>({});

  // Create modal state
  const [createOpen, setCreateOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [subjectId, setSubjectId] = useState<string>('');
  const [targetHours, setTargetHours] = useState<number>(6);
  const [durationDays, setDurationDays] = useState<number>(7);
  const [description, setDescription] = useState('');
  const [createBusy, setCreateBusy] = useState(false);

  // Delete confirmation
  const [challengeToDelete, setChallengeToDelete] = useState<StudyChallengeRecord | null>(null);

  const loadChallenges = useCallback(async (background = false) => {
    if (!background) {
      setLoading(true);
      setError(null);
    }
    try {
      const res = await apiRequest<{ challenges: StudyChallengeRecord[] }>('/api/challenges', {
        background,
      });
      setChallenges(res.challenges);
    } catch (err) {
      if (!background) {
        setError(err instanceof ApiError ? err.message : 'تعذر تحميل تحديات المذاكرة');
      }
    } finally {
      if (!background) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void loadChallenges(false);
  }, [loadChallenges]);

  useWebSocket(true, (event) => {
    if (event.type === 'challenges:updated') {
      void loadChallenges(true);
      onActivityLogged?.();
    }
  });

  useEffect(() => {
    if (!subjectId && subjects.length > 0) {
      setSubjectId(subjects[0].id);
    }
  }, [subjects, subjectId]);

  useEffect(() => {
    if (externalCreateTrigger && externalCreateTrigger > 0) {
      setCreateOpen(true);
      onExternalCreateHandled?.();
    }
  }, [externalCreateTrigger, onExternalCreateHandled]);

  const now = Date.now();
  const activeCount = useMemo(
    () => challenges.filter((c) => c.endsAt >= now).length,
    [challenges, now]
  );

  const visibleChallenges = useMemo(() => {
    const currentNow = Date.now();
    if (filter === 'active') return challenges.filter((c) => c.endsAt >= currentNow);
    if (filter === 'mine') return challenges.filter((c) => c.joinedByMe);
    return challenges.filter((c) => c.endsAt < currentNow);
  }, [challenges, filter]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreateBusy(true);
    try {
      const res = await apiRequest<{ challenge: StudyChallengeRecord }>('/api/challenges', {
        method: 'POST',
        body: {
          title: title.trim(),
          subjectId: subjectId || null,
          targetHours: Number(targetHours),
          durationDays: Number(durationDays),
          description: description.trim(),
        },
      });
      setChallenges((prev) => [res.challenge, ...prev]);
      setCreateOpen(false);
      setTitle('');
      setDescription('');
      setFilter('active');
      onToast(`تم إنشاء تحدي «${res.challenge.title}»`);
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'تعذر إنشاء التحدي', true);
    } finally {
      setCreateBusy(false);
    }
  };

  const replaceChallenge = (updated: StudyChallengeRecord) => {
    setChallenges((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
  };

  const handleJoin = async (id: string) => {
    setBusyId(id);
    try {
      const res = await apiRequest<{ challenge: StudyChallengeRecord }>(
        `/api/challenges/${encodeURIComponent(id)}/join`,
        { method: 'POST' }
      );
      replaceChallenge(res.challenge);
      onToast('انضممت إلى التحدي — بالتوفيق في المذاكرة');
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'تعذر الانضمام للتحدي', true);
    } finally {
      setBusyId(null);
    }
  };

  const handleLeave = async (id: string) => {
    setBusyId(id);
    try {
      const res = await apiRequest<{ challenge: StudyChallengeRecord }>(
        `/api/challenges/${encodeURIComponent(id)}/leave`,
        { method: 'POST' }
      );
      replaceChallenge(res.challenge);
      onToast('تمت مغادرة التحدي');
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'تعذر مغادرة التحدي', true);
    } finally {
      setBusyId(null);
    }
  };

  const handleAddProgress = async (id: string, minutes: number) => {
    if (!Number.isFinite(minutes) || minutes < 5) {
      onToast('أدخل ٥ دقائق على الأقل لتسجيل التقدم', true);
      return;
    }
    setBusyId(id);
    try {
      const res = await apiRequest<{ challenge: StudyChallengeRecord }>(
        `/api/challenges/${encodeURIComponent(id)}/progress`,
        {
          method: 'POST',
          body: { addMinutes: Math.round(minutes) },
        }
      );
      replaceChallenge(res.challenge);
      setCustomMinutesById((prev) => ({ ...prev, [id]: '' }));
      onActivityLogged?.();
      onToast(`تم تسجيل ${formatChallengeMinutes(Math.round(minutes))} في التحدي`);
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'تعذر تسجيل دقائق المذاكرة', true);
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async () => {
    if (!challengeToDelete) return;
    setBusyId(challengeToDelete.id);
    try {
      await apiRequest(`/api/challenges/${encodeURIComponent(challengeToDelete.id)}`, {
        method: 'DELETE',
      });
      setChallenges((prev) => prev.filter((c) => c.id !== challengeToDelete.id));
      setChallengeToDelete(null);
      onToast('تم حذف التحدي');
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'تعذر حذف التحدي', true);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section id="study-challenges" className="space-y-4">
      {/* Section Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-extrabold text-[var(--text-primary)] flex items-center gap-2">
            <Icons.Trophy className="w-5 h-5 text-[var(--accent)]" />
            <span>تحديات المذاكرة المشتركة</span>
          </h2>
          <p className="text-xs sm:text-sm text-[var(--text-secondary)] mt-0.5 tabular-nums">
            {activeCount} تحدي نشط · شارك زملاءك في أهداف ساعات المذاكرة لكل مادة
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <div
            role="group"
            aria-label="تصفية التحديات"
            className="inline-flex p-1 rounded-xl bg-[var(--bg-surface)] border border-[var(--divider)]"
          >
            {(
              [
                { id: 'active', label: 'النشطة' },
                { id: 'mine', label: 'تحدياتي' },
                { id: 'ended', label: 'المنتهية' },
              ] as const
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                aria-pressed={filter === tab.id}
                onClick={() => setFilter(tab.id)}
                className={`min-h-[36px] px-3 py-1 rounded-lg text-xs font-bold transition-colors whitespace-nowrap shrink-0 ${
                  filter === tab.id
                    ? 'bg-[var(--accent)] text-[var(--accent-fg)]'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            className="min-h-[42px] px-4 py-2 rounded-xl bg-[var(--accent)] text-[var(--accent-fg)] text-xs sm:text-sm font-bold flex items-center gap-1.5 hover:bg-[var(--accent-hi)] transition-colors whitespace-nowrap shrink-0"
          >
            <Icons.Plus className="w-4 h-4" />
            <span>إنشاء تحدي</span>
          </button>
        </div>
      </div>

      {/* Content */}
      {loading ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {[1, 2].map((k) => (
            <div key={k} className="rahhala-card h-72 animate-pulse" />
          ))}
        </div>
      ) : error ? (
        <div className="rahhala-card p-5">
          <ErrorRetryPanel message={error} onRetry={() => void loadChallenges(false)} />
        </div>
      ) : visibleChallenges.length === 0 ? (
        <div className="rahhala-card p-6 sm:p-8">
          <EmptyState
            icon={<Icons.Trophy className="w-6 h-6" />}
            title={
              filter === 'mine'
                ? 'لم تنضم إلى أي تحدي بعد'
                : filter === 'ended'
                ? 'لا توجد تحديات منتهية'
                : 'لا توجد تحديات مذاكرة نشطة حالياً'
            }
            subtitle={
              filter === 'mine'
                ? 'انضم لأحد التحديات النشطة أو أنشئ تحدياً جديداً ليدخل زملاؤك معك.'
                : 'أنشئ تحدي مذاكرة لمادة معينة وحدد عدد الساعات المستهدف ليتنافس الزملاء معاً.'
            }
          />
          <div className="mt-4 flex justify-center gap-2.5">
            {filter !== 'active' && (
              <button
                type="button"
                onClick={() => setFilter('active')}
                className="min-h-[42px] px-4 rounded-xl rahhala-glass-pill text-xs font-bold text-[var(--text-primary)] hover:border-[var(--accent)]"
              >
                عرض التحديات النشطة
              </button>
            )}
            <button
              type="button"
              onClick={() => setCreateOpen(true)}
              className="min-h-[42px] px-5 rounded-xl bg-[var(--accent)] text-[var(--accent-fg)] text-xs sm:text-sm font-bold hover:bg-[var(--accent-hi)]"
            >
              إنشاء أول تحدي
            </button>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {visibleChallenges.map((challenge) => {
            const isEnded = challenge.endsAt < Date.now();
            const cardColor = getSubjectColor
              ? getSubjectColor(challenge.subjectId, challenge.subjectColor)
              : challenge.subjectColor;
            const isBusy = busyId === challenge.id;

            return (
              <motion.article
                key={challenge.id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
                className="rahhala-card p-5 space-y-4 flex flex-col justify-between"
              >
                <div className="space-y-4">
                  {/* Card Top Meta & Actions */}
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--text-secondary)]">
                        <span
                          className="w-2.5 h-2.5 rounded-full shrink-0"
                          style={{ backgroundColor: cardColor }}
                          aria-hidden="true"
                        />
                        <span className="font-bold text-[var(--text-primary)]">
                          {challenge.subjectName}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span className="tabular-nums">
                          الهدف {formatChallengeMinutes(challenge.targetMinutes)}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span
                          className={`tabular-nums font-semibold ${
                            isEnded ? 'text-[var(--text-secondary)]' : 'text-[var(--accent)]'
                          }`}
                        >
                          {formatRemainingChallengeTime(challenge.endsAt)}
                        </span>
                      </div>

                      <h3 className="text-base font-extrabold text-[var(--text-primary)] leading-snug">
                        {challenge.title}
                      </h3>

                      {challenge.description && (
                        <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
                          {challenge.description}
                        </p>
                      )}

                      <div className="text-[11px] text-[var(--text-secondary)]">
                        أنشأه {challenge.creatorName} · {challenge.participantCount} مشارك
                      </div>
                    </div>

                    {challenge.canDelete && (
                      <button
                        type="button"
                        disabled={isBusy}
                        aria-label={`حذف تحدي ${challenge.title}`}
                        onClick={() => setChallengeToDelete(challenge)}
                        className="min-h-[36px] min-w-[36px] rounded-xl bg-[var(--bg-surface)] text-[var(--text-secondary)] hover:text-[var(--error)] hover:bg-[var(--error-soft)] flex items-center justify-center shrink-0"
                      >
                        <Icons.Trash className="w-4 h-4" />
                      </button>
                    )}
                  </div>

                  {/* Current User Progress & Quick-Log Actions */}
                  {challenge.joinedByMe ? (
                    <div className="pt-3 border-t border-[var(--divider)] space-y-3">
                      <div className="flex items-center justify-between gap-2 text-xs tabular-nums">
                        <span className="font-bold text-[var(--text-primary)]">
                          تقدمك في التحدي
                        </span>
                        <span className="font-extrabold" style={{ color: challenge.myProgressPercent >= 100 ? 'var(--success)' : cardColor }}>
                          {formatChallengeMinutes(challenge.myMinutes)} / {formatChallengeMinutes(challenge.targetMinutes)} ({challenge.myProgressPercent}%)
                        </span>
                      </div>

                      <div
                        className="w-full h-2.5 rounded-full bg-[var(--bg-surface)] overflow-hidden"
                        aria-hidden="true"
                      >
                        <div
                          className="h-full rounded-full transition-all duration-300"
                          style={{
                            width: `${challenge.myProgressPercent}%`,
                            backgroundColor:
                              challenge.myProgressPercent >= 100 ? 'var(--success)' : cardColor,
                          }}
                        />
                      </div>

                      {!isEnded && (
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex flex-wrap items-center gap-1.5">
                            {[
                              { label: '+15 د', mins: 15 },
                              { label: '+30 د', mins: 30 },
                              { label: '+1 س', mins: 60 },
                            ].map((preset) => (
                              <button
                                key={preset.mins}
                                type="button"
                                disabled={isBusy}
                                onClick={() => void handleAddProgress(challenge.id, preset.mins)}
                                className="min-h-[36px] px-2.5 rounded-xl bg-[var(--bg-surface)] border border-[var(--divider)] hover:border-[var(--accent)] text-xs font-bold text-[var(--text-primary)] tabular-nums whitespace-nowrap disabled:opacity-60"
                              >
                                {preset.label}
                              </button>
                            ))}

                            <form
                              onSubmit={(e) => {
                                e.preventDefault();
                                void handleAddProgress(
                                  challenge.id,
                                  Number(customMinutesById[challenge.id] || 0)
                                );
                              }}
                              className="flex items-center gap-1"
                            >
                              <input
                                type="number"
                                min={5}
                                max={480}
                                placeholder="دقائق"
                                aria-label="إضافة دقائق مذاكرة مخصصة"
                                value={customMinutesById[challenge.id] ?? ''}
                                onChange={(e) =>
                                  setCustomMinutesById((prev) => ({
                                    ...prev,
                                    [challenge.id]: e.target.value,
                                  }))
                                }
                                className="rahhala-input min-h-[36px] w-20 px-2.5 py-1 text-xs text-center tabular-nums"
                              />
                              <button
                                type="submit"
                                disabled={isBusy || !customMinutesById[challenge.id]}
                                className="min-h-[36px] px-2.5 rounded-xl bg-[var(--accent)] text-[var(--accent-fg)] text-xs font-bold disabled:opacity-50 whitespace-nowrap"
                              >
                                تسجيل
                              </button>
                            </form>
                          </div>

                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() => void handleLeave(challenge.id)}
                            className="min-h-[36px] px-2.5 rounded-xl text-xs font-semibold text-[var(--text-secondary)] hover:text-[var(--error)] whitespace-nowrap"
                          >
                            مغادرة
                          </button>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="pt-3 border-t border-[var(--divider)] flex items-center justify-between gap-3">
                      <span className="text-xs text-[var(--text-secondary)]">
                        {isEnded
                          ? 'انتهى هذا التحدي'
                          : 'انضم الآن لتحتسب ساعات مذاكرتك ومنبهاتك المكتملة تلقائياً'}
                      </span>
                      {!isEnded && (
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => void handleJoin(challenge.id)}
                          className="min-h-[40px] px-4 rounded-xl bg-[var(--accent)] text-[var(--accent-fg)] text-xs font-bold hover:bg-[var(--accent-hi)] whitespace-nowrap shrink-0 disabled:opacity-60"
                        >
                          انضمام للتحدي
                        </button>
                      )}
                    </div>
                  )}

                  {/* Peer Leaderboard */}
                  <div className="pt-3 border-t border-[var(--divider)] space-y-2.5">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-bold text-[var(--text-primary)]">
                        تقدم الزملاء المشاركين
                      </span>
                      <span className="text-[var(--text-secondary)] tabular-nums">
                        {challenge.participants.length} مشارك
                      </span>
                    </div>

                    {challenge.participants.length === 0 ? (
                      <p className="text-xs text-[var(--text-secondary)] py-1">
                        لا يوجد مشاركون حالياً — كن أول المنضمين.
                      </p>
                    ) : (
                      <div className="divide-y divide-[var(--divider)]">
                        {challenge.participants.map((p, idx) => (
                          <div key={p.userId} className="py-2 first:pt-0.5 last:pb-0.5 space-y-1.5">
                            <div className="flex items-center justify-between gap-2">
                              <div className="flex items-center gap-2 min-w-0">
                                <span className="text-xs font-extrabold text-[var(--text-secondary)] w-5 tabular-nums shrink-0">
                                  #{idx + 1}
                                </span>
                                <Avatar
                                  name={p.displayName}
                                  assetId={p.avatarAssetId}
                                  size="sm"
                                />
                                <span className="text-xs font-bold text-[var(--text-primary)] truncate">
                                  {p.displayName}
                                  {p.isCurrentUser ? ' (أنت)' : ''}
                                </span>
                              </div>

                              <span className="text-xs font-bold text-[var(--text-secondary)] tabular-nums shrink-0">
                                {formatChallengeMinutes(p.totalMinutes)} · {p.progressPercent}%
                              </span>
                            </div>

                            <div
                              className="w-full h-1.5 rounded-full bg-[var(--bg-surface)] overflow-hidden"
                              aria-hidden="true"
                            >
                              <div
                                className="h-full rounded-full transition-all duration-300"
                                style={{
                                  width: `${p.progressPercent}%`,
                                  backgroundColor:
                                    p.progressPercent >= 100
                                      ? 'var(--success)'
                                      : p.isCurrentUser
                                      ? cardColor
                                      : 'var(--accent)',
                                  opacity: p.isCurrentUser ? 1 : 0.8,
                                }}
                              />
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </motion.article>
            );
          })}
        </div>
      )}

      {/* Create Challenge Modal */}
      <ModalShell
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="إنشاء تحدي مذاكرة مشترك"
        maxWidth="max-w-lg"
      >
        <form onSubmit={handleCreate} className="space-y-4">
          <div>
            <label
              htmlFor="challenge-title"
              className="block text-xs font-bold text-[var(--text-secondary)] mb-1.5"
            >
              عنوان التحدي
            </label>
            <input
              id="challenge-title"
              type="text"
              required
              minLength={3}
              maxLength={80}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="مثال: ماراثون مراجعة أصول الفقه"
              className="rahhala-input w-full px-3.5 py-2 text-sm"
            />
          </div>

          <div>
            <label
              htmlFor="challenge-subject"
              className="block text-xs font-bold text-[var(--text-secondary)] mb-1.5"
            >
              المادة الدراسية
            </label>
            <select
              id="challenge-subject"
              value={subjectId}
              onChange={(e) => setSubjectId(e.target.value)}
              className="rahhala-input w-full px-3.5 py-2 text-sm"
            >
              {subjects.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
              <option value="">مذاكرة عامة</option>
            </select>
          </div>

          <div>
            <div className="flex items-center justify-between gap-2 mb-1.5">
              <label
                htmlFor="challenge-hours"
                className="text-xs font-bold text-[var(--text-secondary)]"
              >
                هدف المذاكرة (بالساعات)
              </label>
              <span className="text-xs font-extrabold text-[var(--accent)] tabular-nums">
                {targetHours} ساعات
              </span>
            </div>
            <div className="grid grid-cols-5 gap-2 mb-2">
              {[2, 4, 6, 10, 15].map((hrs) => (
                <button
                  key={hrs}
                  type="button"
                  onClick={() => setTargetHours(hrs)}
                  className={`min-h-[38px] rounded-xl text-xs font-bold border transition-colors tabular-nums ${
                    targetHours === hrs
                      ? 'bg-[var(--accent-soft)] border-[var(--accent)] text-[var(--accent)]'
                      : 'bg-[var(--bg-surface)] border-[var(--divider)] text-[var(--text-primary)] hover:border-[var(--accent)]'
                  }`}
                >
                  {hrs} س
                </button>
              ))}
            </div>
            <input
              id="challenge-hours"
              type="number"
              min={0.5}
              max={200}
              step={0.5}
              required
              value={targetHours}
              onChange={(e) => setTargetHours(Number(e.target.value))}
              className="rahhala-input w-full px-3.5 py-2 text-sm tabular-nums"
            />
          </div>

          <div>
            <span className="block text-xs font-bold text-[var(--text-secondary)] mb-1.5">
              مدة التحدي
            </span>
            <div className="grid grid-cols-4 gap-2">
              {[
                { label: '٣ أيام', days: 3 },
                { label: 'أسبوع', days: 7 },
                { label: 'أسبوعان', days: 14 },
                { label: 'شهر', days: 30 },
              ].map((opt) => (
                <button
                  key={opt.days}
                  type="button"
                  onClick={() => setDurationDays(opt.days)}
                  className={`min-h-[40px] rounded-xl text-xs font-bold border transition-colors ${
                    durationDays === opt.days
                      ? 'bg-[var(--accent-soft)] border-[var(--accent)] text-[var(--accent)]'
                      : 'bg-[var(--bg-surface)] border-[var(--divider)] text-[var(--text-primary)] hover:border-[var(--accent)]'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label
              htmlFor="challenge-desc"
              className="block text-xs font-bold text-[var(--text-secondary)] mb-1.5"
            >
              تفاصيل إضافية (اختياري)
            </label>
            <textarea
              id="challenge-desc"
              rows={2}
              maxLength={180}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="مثال: نركز على تلخيص الفصول الثلاثة الأولى وحل التدريبات."
              className="rahhala-input w-full px-3.5 py-2 text-sm resize-none"
            />
          </div>

          <button
            type="submit"
            disabled={createBusy}
            className="w-full min-h-[46px] rounded-xl bg-[var(--accent)] text-[var(--accent-fg)] font-bold text-sm hover:bg-[var(--accent-hi)] transition-colors disabled:opacity-60"
          >
            {createBusy ? 'جاري النشر...' : 'نشر التحدي للدفعة'}
          </button>
        </form>
      </ModalShell>

      <ConfirmDialog
        open={Boolean(challengeToDelete)}
        onClose={() => setChallengeToDelete(null)}
        onConfirm={handleDelete}
        title="حذف تحدي المذاكرة"
        message={`هل تريد حذف تحدي «${challengeToDelete?.title ?? ''}»؟ سيتم إزالة سجل المشاركين المرتبط به.`}
        confirmLabel="حذف التحدي"
        destructive
        busy={Boolean(busyId)}
      />
    </section>
  );
}
