import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type {
  ChallengeStudyLogRecord,
  StudyReminderRecord,
  SubjectRecord,
} from '../../shared/types';
import { ApiError, apiRequest } from '../lib/api';
import { Icons } from './Icons';
import { StudyChallengesSection } from './StudyChallengesSection';
import { EmptyState, ErrorRetryPanel } from './UI';

type TimeRange = 'weekly' | 'monthly';
type MetricView = 'both' | 'minutes' | 'rate';
type PeakMetricView = 'minutes' | 'sessions';

const DAY_MS = 86_400_000;

interface SubjectProgressRow {
  id: string;
  name: string;
  accentColor: string;
  totalReminders: number;
  completedReminders: number;
  activeReminders: number;
  completedMinutes: number;
  plannedMinutes: number;
  completionRate: number;
}

interface HabitBucketRow {
  key: string;
  label: string;
  rangeLabel: string;
  startMs: number;
  endMs: number;
  completedMinutes: number;
  completedCount: number;
  totalCount: number;
  completionRate: number;
}

interface PeakHourRow {
  hour: number;
  shortLabel: string;
  hourRangeLabel: string;
  totalMinutes: number;
  reminderMinutes: number;
  challengeMinutes: number;
  sessionCount: number;
  reminderSessions: number;
  challengeSessions: number;
}

function formatArabicHourShort(hour: number): string {
  if (hour === 0) return '12 ص';
  if (hour < 12) return `${hour} ص`;
  if (hour === 12) return '12 م';
  return `${hour - 12} م`;
}

function formatArabicHourRange(hour: number): string {
  const next = (hour + 1) % 24;
  return `${formatArabicHourShort(hour)} – ${formatArabicHourShort(next)}`;
}

function startOfLocalDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function endOfLocalDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

function formatDurationMinutes(minutes: number): string {
  if (minutes <= 0) return '0 دقيقة';
  if (minutes < 60) return `${minutes} دقيقة`;
  const hrs = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return rem === 0 ? `${hrs} ساعة` : `${hrs} س ${rem} د`;
}

function formatShortNumericDate(ts: number): string {
  const d = new Date(ts);
  return `${d.getDate()}/${d.getMonth() + 1}`;
}

function formatArabicDate(ts: number): string {
  return new Intl.DateTimeFormat('ar-EG', {
    day: 'numeric',
    month: 'short',
  }).format(new Date(ts));
}

function formatArabicWeekday(ts: number): string {
  return new Intl.DateTimeFormat('ar-EG', {
    weekday: 'short',
  }).format(new Date(ts));
}

function SubjectChartTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: SubjectProgressRow }>;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const row = payload[0].payload;

  return (
    <div className="rahhala-glass-panel px-4 py-3 text-right min-w-[205px] shadow-xl">
      <div className="font-extrabold text-sm text-[var(--text-primary)] mb-2 border-b border-[var(--divider)] pb-1.5">
        {row.name}
      </div>
      <div className="space-y-1.5 text-xs tabular-nums">
        <div className="flex items-center justify-between gap-4">
          <span className="text-[var(--text-secondary)]">وقت المذاكرة المنجز</span>
          <span className="font-bold text-[var(--accent)]">
            {formatDurationMinutes(row.completedMinutes)}
          </span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="text-[var(--text-secondary)]">نسبة الإنجاز</span>
          <span className="font-bold text-[var(--success)]">{row.completionRate}%</span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="text-[var(--text-secondary)]">الجلسات المكتملة</span>
          <span className="font-semibold text-[var(--text-primary)]">
            {row.completedReminders} / {row.totalReminders}
          </span>
        </div>
      </div>
    </div>
  );
}

function HabitChartTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: HabitBucketRow }>;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const bucket = payload[0].payload;

  return (
    <div className="rahhala-glass-panel px-4 py-3 text-right min-w-[210px] shadow-xl">
      <div className="font-extrabold text-sm text-[var(--text-primary)] mb-2 border-b border-[var(--divider)] pb-1.5">
        {bucket.rangeLabel}
      </div>
      <div className="space-y-1.5 text-xs tabular-nums">
        <div className="flex items-center justify-between gap-4">
          <span className="text-[var(--text-secondary)]">وقت المذاكرة المنجز</span>
          <span className="font-bold text-[var(--accent)]">
            {formatDurationMinutes(bucket.completedMinutes)}
          </span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="text-[var(--text-secondary)]">الجلسات المكتملة</span>
          <span className="font-bold text-[var(--success)]">
            {bucket.completedCount} / {bucket.totalCount}
          </span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="text-[var(--text-secondary)]">معدل الالتزام</span>
          <span className="font-semibold text-[var(--text-primary)]">
            {bucket.completionRate}%
          </span>
        </div>
      </div>
    </div>
  );
}

function PeakHoursTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: PeakHourRow }>;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const row = payload[0].payload;

  return (
    <div className="rahhala-glass-panel px-4 py-3 text-right min-w-[220px] shadow-xl">
      <div className="font-extrabold text-sm text-[var(--text-primary)] mb-2 border-b border-[var(--divider)] pb-1.5 tabular-nums">
        {row.hourRangeLabel}
      </div>
      <div className="space-y-1.5 text-xs tabular-nums">
        <div className="flex items-center justify-between gap-4">
          <span className="text-[var(--text-secondary)]">إجمالي المذاكرة</span>
          <span className="font-bold text-[var(--accent)]">
            {formatDurationMinutes(row.totalMinutes)}
          </span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="text-[var(--text-secondary)]">التذكيرات المكتملة</span>
          <span className="font-semibold text-[var(--text-primary)]">
            {formatDurationMinutes(row.reminderMinutes)} ({row.reminderSessions})
          </span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="text-[var(--text-secondary)]">جلسات التحديات</span>
          <span className="font-semibold text-[var(--success)]">
            {formatDurationMinutes(row.challengeMinutes)} ({row.challengeSessions})
          </span>
        </div>
        <div className="flex items-center justify-between gap-4 pt-1 border-t border-[var(--divider)]">
          <span className="text-[var(--text-secondary)]">إجمالي الجلسات</span>
          <span className="font-bold text-[var(--text-primary)]">{row.sessionCount} جلسة</span>
        </div>
      </div>
    </div>
  );
}

export function DashboardView({
  reminders,
  remindersLoading,
  getSubjectColor,
  onOpenReminders,
  onOpenSubject,
  onToast,
}: {
  reminders: StudyReminderRecord[];
  remindersLoading: boolean;
  getSubjectColor?: (subjectId: string | null | undefined, fallbackColor?: string) => string;
  onOpenReminders: (subjectId?: string | null) => void;
  onOpenSubject: (subjectId: string) => void;
  onToast: (msg: string, isError?: boolean) => void;
}) {
  const [subjects, setSubjects] = useState<SubjectRecord[]>([]);
  const [challengeLogs, setChallengeLogs] = useState<ChallengeStudyLogRecord[]>([]);
  const [subjectsLoading, setSubjectsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [timeRange, setTimeRange] = useState<TimeRange>('weekly');
  const [metricView, setMetricView] = useState<MetricView>('both');
  const [peakMetric, setPeakMetric] = useState<PeakMetricView>('minutes');
  const [challengeCreateTrigger, setChallengeCreateTrigger] = useState(0);

  const loadChallengeActivity = useCallback(async () => {
    try {
      const res = await apiRequest<{ logs: ChallengeStudyLogRecord[] }>(
        '/api/challenges/activity?days=35',
        { background: true }
      );
      setChallengeLogs(res.logs);
    } catch {
      // Keep existing logs silently if background refresh fails
    }
  }, []);

  const loadSubjects = useCallback(async () => {
    setSubjectsLoading(true);
    setError(null);
    try {
      const [subRes, logsRes] = await Promise.all([
        apiRequest<{ subjects: SubjectRecord[] }>('/api/resources/subjects'),
        apiRequest<{ logs: ChallengeStudyLogRecord[] }>('/api/challenges/activity?days=35').catch(
          () => ({ logs: [] as ChallengeStudyLogRecord[] })
        ),
      ]);
      setSubjects(subRes.subjects);
      setChallengeLogs(logsRes.logs);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر تحميل بيانات المواد');
    } finally {
      setSubjectsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSubjects();
  }, [loadSubjects]);

  const {
    windowLabel,
    windowDateSpan,
    windowRemindersCount,
    rows,
    habitBuckets,
    peakHours,
    summary,
  } = useMemo(() => {
    const now = Date.now();
    const todayStart = startOfLocalDay(now);
    const todayEnd = endOfLocalDay(now);
    const totalDays = timeRange === 'weekly' ? 7 : 30;
    const windowStart = todayStart - (totalDays - 1) * DAY_MS;

    const windowLabelText = timeRange === 'weekly' ? 'آخر 7 أيام' : 'آخر 30 يوماً';
    const windowSpanText = `${formatArabicDate(windowStart)} — ${formatArabicDate(todayStart)}`;

    const getEffectiveTs = (rem: StudyReminderRecord) =>
      rem.status === 'completed' && rem.remindAt > todayEnd ? rem.updatedAt : rem.remindAt;

    const windowReminders = reminders.filter((rem) => {
      const ts = getEffectiveTs(rem);
      return ts >= windowStart && ts <= todayEnd;
    });

    // 1. Build chronological habit buckets
    const buckets: HabitBucketRow[] = [];
    if (timeRange === 'weekly') {
      for (let offset = totalDays - 1; offset >= 0; offset -= 1) {
        const dayStart = todayStart - offset * DAY_MS;
        const dayEnd = endOfLocalDay(dayStart);
        const weekday = offset === 0 ? 'اليوم' : formatArabicWeekday(dayStart);
        buckets.push({
          key: `day-${dayStart}`,
          label: weekday,
          rangeLabel: `${formatArabicWeekday(dayStart)} · ${formatArabicDate(dayStart)}`,
          startMs: dayStart,
          endMs: dayEnd,
          completedMinutes: 0,
          completedCount: 0,
          totalCount: 0,
          completionRate: 0,
        });
      }
    } else {
      // 5 chronological 6-day intervals spanning all 30 rolling days
      const spanDays = 6;
      for (let i = 0; i < 5; i += 1) {
        const startMs = windowStart + i * spanDays * DAY_MS;
        const endMs = endOfLocalDay(startMs + (spanDays - 1) * DAY_MS);
        const startShort = formatShortNumericDate(startMs);
        const endShort = formatShortNumericDate(endMs);
        buckets.push({
          key: `span-${i}`,
          label: `${startShort}–${endShort}`,
          rangeLabel: `${formatArabicDate(startMs)} — ${formatArabicDate(endMs)}`,
          startMs,
          endMs,
          completedMinutes: 0,
          completedCount: 0,
          totalCount: 0,
          completionRate: 0,
        });
      }
    }

    const activeDaySet = new Set<number>();

    for (const rem of windowReminders) {
      const ts = getEffectiveTs(rem);
      const mins = Math.max(1, rem.durationMinutes || 25);
      const bucket = buckets.find((b) => ts >= b.startMs && ts <= b.endMs);
      if (bucket) {
        bucket.totalCount += 1;
        if (rem.status === 'completed') {
          bucket.completedCount += 1;
          bucket.completedMinutes += mins;
          activeDaySet.add(startOfLocalDay(ts));
        }
      }
    }

    const finalizedBuckets = buckets.map((b) => ({
      ...b,
      completionRate: b.totalCount > 0 ? Math.round((b.completedCount / b.totalCount) * 100) : 0,
    }));

    // 2. Build per-subject breakdown strictly for the active window
    const map = new Map<string, SubjectProgressRow>();

    for (const s of subjects) {
      map.set(s.id, {
        id: s.id,
        name: s.name,
        accentColor: s.accentColor,
        totalReminders: 0,
        completedReminders: 0,
        activeReminders: 0,
        completedMinutes: 0,
        plannedMinutes: 0,
        completionRate: 0,
      });
    }

    for (const rem of windowReminders) {
      const key = rem.subjectId || `snapshot:${rem.subjectName}`;
      let entry = map.get(key);
      if (!entry) {
        entry = {
          id: rem.subjectId || key,
          name: rem.subjectName,
          accentColor: '#E3B23C',
          totalReminders: 0,
          completedReminders: 0,
          activeReminders: 0,
          completedMinutes: 0,
          plannedMinutes: 0,
          completionRate: 0,
        };
        map.set(key, entry);
      }

      const mins = Math.max(1, rem.durationMinutes || 25);
      entry.totalReminders += 1;
      entry.plannedMinutes += mins;

      if (rem.status === 'completed') {
        entry.completedReminders += 1;
        entry.completedMinutes += mins;
      } else {
        entry.activeReminders += 1;
      }
    }

    const computedRows = Array.from(map.values())
      .map((entry) => ({
        ...entry,
        completionRate:
          entry.totalReminders > 0
            ? Math.round((entry.completedReminders / entry.totalReminders) * 100)
            : 0,
      }))
      .sort(
        (a, b) =>
          b.completedMinutes - a.completedMinutes ||
          b.completionRate - a.completionRate ||
          b.totalReminders - a.totalReminders
      );

    const totalCompletedMinutes = computedRows.reduce((acc, r) => acc + r.completedMinutes, 0);
    const totalCompletedCount = computedRows.reduce((acc, r) => acc + r.completedReminders, 0);
    const totalRemindersCount = computedRows.reduce((acc, r) => acc + r.totalReminders, 0);
    const overallCompletionRate =
      totalRemindersCount > 0 ? Math.round((totalCompletedCount / totalRemindersCount) * 100) : 0;
    const topSubject =
      computedRows.find((r) => r.completedMinutes > 0 || r.completedReminders > 0)?.name ?? '—';

    // 3. Build 24-hour Peak Study Hours series (Completed Reminders + Challenge Sessions)
    const hourlyBuckets: PeakHourRow[] = Array.from({ length: 24 }, (_, hour) => ({
      hour,
      shortLabel: formatArabicHourShort(hour),
      hourRangeLabel: formatArabicHourRange(hour),
      totalMinutes: 0,
      reminderMinutes: 0,
      challengeMinutes: 0,
      sessionCount: 0,
      reminderSessions: 0,
      challengeSessions: 0,
    }));

    for (const rem of windowReminders) {
      if (rem.status !== 'completed') continue;
      const ts = getEffectiveTs(rem);
      const hr = new Date(ts).getHours();
      const mins = Math.max(1, rem.durationMinutes || 25);
      const slot = hourlyBuckets[hr];
      if (slot) {
        slot.reminderMinutes += mins;
        slot.totalMinutes += mins;
        slot.reminderSessions += 1;
        slot.sessionCount += 1;
      }
    }

    const windowChallengeLogs = challengeLogs.filter(
      (log) => log.loggedAt >= windowStart && log.loggedAt <= todayEnd
    );
    for (const log of windowChallengeLogs) {
      const hr = new Date(log.loggedAt).getHours();
      const mins = Math.max(1, log.minutes);
      const slot = hourlyBuckets[hr];
      if (slot) {
        slot.challengeMinutes += mins;
        slot.totalMinutes += mins;
        slot.challengeSessions += 1;
        slot.sessionCount += 1;
      }
    }

    const totalPeakMinutes = hourlyBuckets.reduce((acc, h) => acc + h.totalMinutes, 0);
    const totalPeakSessions = hourlyBuckets.reduce((acc, h) => acc + h.sessionCount, 0);
    const bestHour = hourlyBuckets.reduce<PeakHourRow | null>((best, curr) => {
      if (curr.totalMinutes === 0 && curr.sessionCount === 0) return best;
      if (!best) return curr;
      if (curr.totalMinutes !== best.totalMinutes) {
        return curr.totalMinutes > best.totalMinutes ? curr : best;
      }
      return curr.sessionCount > best.sessionCount ? curr : best;
    }, null);

    const periodDefs = [
      { id: 'dawn', label: 'الفجر (12 ص – 5 ص)', start: 0, end: 5 },
      { id: 'morning', label: 'الصباح (6 ص – 11 ص)', start: 6, end: 11 },
      { id: 'afternoon', label: 'الظهيرة والعصر (12 م – 5 م)', start: 12, end: 17 },
      { id: 'evening', label: 'المساء والليل (6 م – 11 م)', start: 18, end: 23 },
    ];
    const periods = periodDefs.map((p) => {
      const mins = hourlyBuckets
        .filter((h) => h.hour >= p.start && h.hour <= p.end)
        .reduce((acc, h) => acc + h.totalMinutes, 0);
      const sessions = hourlyBuckets
        .filter((h) => h.hour >= p.start && h.hour <= p.end)
        .reduce((acc, h) => acc + h.sessionCount, 0);
      return {
        ...p,
        minutes: mins,
        sessions,
        sharePercent: totalPeakMinutes > 0 ? Math.round((mins / totalPeakMinutes) * 100) : 0,
      };
    });
    const bestPeriodId =
      periods.reduce((top, p) => (p.minutes > top.minutes ? p : top), periods[0])?.id ?? '';

    return {
      windowLabel: windowLabelText,
      windowDateSpan: windowSpanText,
      windowRemindersCount: windowReminders.length,
      rows: computedRows,
      habitBuckets: finalizedBuckets,
      peakHours: {
        buckets: hourlyBuckets,
        totalMinutes: totalPeakMinutes,
        totalSessions: totalPeakSessions,
        peakHour: bestHour,
        periods,
        bestPeriodId: totalPeakMinutes > 0 ? bestPeriodId : '',
      },
      summary: {
        totalCompletedMinutes,
        totalCompletedCount,
        totalRemindersCount,
        overallCompletionRate,
        activeDaysCount: activeDaySet.size,
        topSubject,
      },
    };
  }, [subjects, reminders, challengeLogs, timeRange]);

  const loading = subjectsLoading || remindersLoading;
  const hasAnyReminders = reminders.length > 0;
  const hasWindowReminders = windowRemindersCount > 0;
  const hasAnyPeakActivity = peakHours.totalMinutes > 0 || peakHours.totalSessions > 0;

  return (
    <div className="space-y-6">
      {/* Header Row + Weekly / Monthly Segmented Toggle */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-extrabold text-[var(--text-primary)]">
            لوحة إنجاز المذاكرة
          </h1>
          <div className="flex flex-wrap items-center gap-2 text-xs sm:text-sm text-[var(--text-secondary)] mt-0.5">
            <span>{windowLabel}</span>
            <span aria-hidden="true">·</span>
            <span className="tabular-nums">{windowDateSpan}</span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <div
            role="group"
            aria-label="الفترة الزمنية"
            className="inline-flex p-1 rounded-xl bg-[var(--bg-surface)] border border-[var(--divider)]"
          >
            {(
              [
                { id: 'weekly', label: 'أسبوعي (7 أيام)' },
                { id: 'monthly', label: 'شهري (30 يوماً)' },
              ] as const
            ).map((opt) => {
              const isSelected = timeRange === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  aria-pressed={isSelected}
                  onClick={() => setTimeRange(opt.id)}
                  className={`min-h-[38px] px-3.5 py-1.5 rounded-lg text-xs font-bold transition-colors whitespace-nowrap shrink-0 ${
                    isSelected
                      ? 'bg-[var(--accent)] text-[var(--accent-fg)]'
                      : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                  }`}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>

          <button
            type="button"
            onClick={() => {
              setChallengeCreateTrigger((c) => c + 1);
              document.getElementById('study-challenges')?.scrollIntoView({ behavior: 'smooth' });
            }}
            className="min-h-[44px] px-3.5 py-2 rounded-xl rahhala-glass-pill text-xs sm:text-sm font-bold text-[var(--text-primary)] hover:border-[var(--accent)] flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
          >
            <Icons.Trophy className="w-4 h-4 text-[var(--accent)]" />
            <span>تحدي جديد</span>
          </button>

          <button
            type="button"
            onClick={() => onOpenReminders(null)}
            className="min-h-[44px] px-4 py-2 rounded-xl bg-[var(--accent)] text-[var(--accent-fg)] text-xs sm:text-sm font-bold flex items-center gap-2 hover:bg-[var(--accent-hi)] transition-colors whitespace-nowrap shrink-0"
          >
            <Icons.AlarmClock className="w-4 h-4" />
            <span>ضبط منبه جديد</span>
          </button>
        </div>
      </div>

      {/* 4-Column Summary KPI Strip (Synchronized with Weekly/Monthly) */}
      <AnimatePresence mode="wait">
        <motion.section
          key={timeRange}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
          className="grid grid-cols-2 lg:grid-cols-4 gap-3.5"
          aria-label="ملخص الإنجاز"
        >
          <div className="rahhala-card p-4">
            <div className="text-xs font-semibold text-[var(--text-secondary)]">
              وقت المذاكرة المنجز
            </div>
            <div className="text-xl sm:text-2xl font-extrabold text-[var(--accent)] mt-1.5 tabular-nums">
              {formatDurationMinutes(summary.totalCompletedMinutes)}
            </div>
            <div className="text-[11px] text-[var(--text-secondary)] mt-1 tabular-nums">
              {summary.activeDaysCount} أيام مذاكرة مكتملة
            </div>
          </div>

          <div className="rahhala-card p-4">
            <div className="text-xs font-semibold text-[var(--text-secondary)]">
              معدل الإنجاز
            </div>
            <div className="text-xl sm:text-2xl font-extrabold text-[var(--success)] mt-1.5 tabular-nums">
              {summary.overallCompletionRate}%
            </div>
            <div className="text-[11px] text-[var(--text-secondary)] mt-1">
              خلال {windowLabel}
            </div>
          </div>

          <div className="rahhala-card p-4">
            <div className="text-xs font-semibold text-[var(--text-secondary)]">
              الجلسات المكتملة
            </div>
            <div className="text-xl sm:text-2xl font-extrabold text-[var(--text-primary)] mt-1.5 tabular-nums">
              {summary.totalCompletedCount} / {summary.totalRemindersCount}
            </div>
            <div className="text-[11px] text-[var(--text-secondary)] mt-1">
              منبهات الفترة المحددة
            </div>
          </div>

          <div className="rahhala-card p-4">
            <div className="text-xs font-semibold text-[var(--text-secondary)]">
              المادة الأكثر التزاماً
            </div>
            <div className="text-base sm:text-lg font-extrabold text-[var(--text-primary)] mt-2 truncate">
              {summary.topSubject}
            </div>
            <div className="text-[11px] text-[var(--text-secondary)] mt-1">
              الأعلى في {windowLabel}
            </div>
          </div>
        </motion.section>
      </AnimatePresence>

      {/* Main Charts or Loading / Error / Empty States */}
      {loading ? (
        <div className="space-y-6">
          <div className="rahhala-card p-5 sm:p-6">
            <div className="h-[320px] rounded-2xl bg-[var(--bg-surface)]/50 animate-pulse" />
          </div>
          <div className="rahhala-card p-5 sm:p-6">
            <div className="h-[320px] rounded-2xl bg-[var(--bg-surface)]/50 animate-pulse" />
          </div>
        </div>
      ) : error ? (
        <section className="rahhala-card p-5 sm:p-6">
          <ErrorRetryPanel message={error} onRetry={loadSubjects} />
        </section>
      ) : !hasWindowReminders && !hasAnyPeakActivity ? (
        <section className="rahhala-card p-5 sm:p-8">
          <EmptyState
            icon={<Icons.BarChart className="w-6 h-6" />}
            title={
              hasAnyReminders
                ? `لا توجد جلسات مذاكرة في ${windowLabel}`
                : 'لا توجد بيانات مذاكرة مكتملة بعد'
            }
            subtitle={
              hasAnyReminders && timeRange === 'weekly'
                ? 'لديك سجل مذاكرة في فترات سابقة. يمكنك استعراض العرض الشهري لمتابعة عاداتك أو ضبط منبه جديد لهذا الأسبوع.'
                : 'اضبط منبه مذاكرة لإحدى المواد وأكمل جلستك الأولى ليظهر الرسم البياني لعاداتك وتقدمك هنا.'
            }
          />
          <div className="mt-4 flex flex-wrap items-center justify-center gap-2.5">
            {hasAnyReminders && timeRange === 'weekly' && (
              <button
                type="button"
                onClick={() => setTimeRange('monthly')}
                className="min-h-[44px] px-5 py-2 rounded-xl rahhala-glass-pill text-sm font-bold text-[var(--text-primary)] hover:border-[var(--accent)] transition-colors whitespace-nowrap"
              >
                عرض آخر 30 يوماً
              </button>
            )}
            <button
              type="button"
              onClick={() => onOpenReminders(null)}
              className="min-h-[44px] px-5 py-2 rounded-xl bg-[var(--accent)] text-[var(--accent-fg)] text-sm font-bold hover:bg-[var(--accent-hi)] transition-colors whitespace-nowrap"
            >
              {hasAnyReminders ? 'ضبط منبه جديد' : 'ضبط أول منبه مذاكرة'}
            </button>
          </div>
        </section>
      ) : (
        <>
          {/* 24-Hour Peak Study Hours Smooth Recharts Curve */}
          <section className="rahhala-card p-5 sm:p-6">
            <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
              <div>
                <h2 className="text-base font-extrabold text-[var(--text-primary)] flex items-center gap-2">
                  <Icons.Clock className="w-4 h-4 text-[var(--accent)]" />
                  <span>أوقات الذروة للمذاكرة</span>
                </h2>
                <p className="text-xs text-[var(--text-secondary)] mt-0.5">
                  توزيع ساعات المذاكرة على مدار ٢٤ ساعة (التذكيرات المكتملة وجلسات التحديات) خلال {windowLabel}
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                {peakHours.peakHour && (
                  <div className="text-xs text-[var(--text-secondary)] tabular-nums">
                    <span>ساعة الذروة: </span>
                    <strong className="text-[var(--accent)] font-extrabold">
                      {peakHours.peakHour.hourRangeLabel}
                    </strong>
                    <span> · {formatDurationMinutes(peakHours.peakHour.totalMinutes)}</span>
                  </div>
                )}

                <div
                  role="group"
                  aria-label="قياس أوقات الذروة"
                  className="inline-flex p-1 rounded-xl bg-[var(--bg-surface)] border border-[var(--divider)]"
                >
                  {(
                    [
                      { id: 'minutes', label: 'الدقائق' },
                      { id: 'sessions', label: 'الجلسات' },
                    ] as const
                  ).map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      aria-pressed={peakMetric === opt.id}
                      onClick={() => setPeakMetric(opt.id)}
                      className={`min-h-[34px] px-3 py-1 rounded-lg text-xs font-bold transition-colors whitespace-nowrap shrink-0 ${
                        peakMetric === opt.id
                          ? 'bg-[var(--accent)] text-[var(--accent-fg)]'
                          : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {hasAnyPeakActivity ? (
              <>
                <div className="w-full h-[290px]" dir="ltr">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart
                      data={peakHours.buckets}
                      margin={{ top: 14, right: 16, left: 4, bottom: 8 }}
                    >
                      <defs>
                        <linearGradient id="peakStudyHoursGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="var(--accent)" stopOpacity={0.42} />
                          <stop offset="95%" stopColor="var(--accent)" stopOpacity={0.02} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid
                        stroke="var(--divider)"
                        strokeDasharray="3 3"
                        vertical={false}
                      />
                      <XAxis
                        dataKey="hour"
                        ticks={[0, 3, 6, 9, 12, 15, 18, 21]}
                        tickFormatter={(hr) => formatArabicHourShort(Number(hr))}
                        tick={{ fill: 'var(--text-secondary)', fontSize: 11, fontWeight: 600 }}
                        axisLine={{ stroke: 'var(--divider)' }}
                        tickLine={false}
                      />
                      <YAxis
                        allowDecimals={false}
                        tick={{ fill: 'var(--text-secondary)', fontSize: 11 }}
                        axisLine={false}
                        tickLine={false}
                        unit={peakMetric === 'minutes' ? ' د' : ''}
                      />
                      <Tooltip
                        cursor={{ stroke: 'var(--accent)', strokeDasharray: '3 3', strokeOpacity: 0.55 }}
                        content={<PeakHoursTooltip />}
                      />
                      {peakHours.peakHour && (
                        <ReferenceLine
                          x={peakHours.peakHour.hour}
                          stroke="var(--success)"
                          strokeDasharray="4 4"
                          strokeWidth={1.5}
                        />
                      )}
                      <Area
                        type="monotone"
                        dataKey={peakMetric === 'minutes' ? 'totalMinutes' : 'sessionCount'}
                        name={peakMetric === 'minutes' ? 'دقائق المذاكرة' : 'عدد الجلسات'}
                        stroke="var(--accent)"
                        strokeWidth={2.75}
                        fill="url(#peakStudyHoursGrad)"
                        dot={(props: { cx?: number; cy?: number; payload?: PeakHourRow }) => {
                          if (!props.cx || !props.cy || !props.payload) return <g key={`empty-${props.payload?.hour ?? Math.random()}`} />;
                          const val =
                            peakMetric === 'minutes'
                              ? props.payload.totalMinutes
                              : props.payload.sessionCount;
                          if (val <= 0) {
                            return <g key={`dot-${props.payload.hour}`} />;
                          }
                          const isPeak = peakHours.peakHour?.hour === props.payload.hour;
                          return (
                            <circle
                              key={`dot-${props.payload.hour}`}
                              cx={props.cx}
                              cy={props.cy}
                              r={isPeak ? 5 : 3}
                              fill={isPeak ? 'var(--success)' : 'var(--accent)'}
                              stroke="var(--bg-card)"
                              strokeWidth={1.5}
                            />
                          );
                        }}
                        activeDot={{ r: 6, fill: 'var(--accent)', stroke: 'var(--bg-card)', strokeWidth: 2 }}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>

                {/* 4 Time-of-Day Distribution Strip */}
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 pt-4 mt-3 border-t border-[var(--divider)]">
                  {peakHours.periods.map((p) => {
                    const isBest = p.id === peakHours.bestPeriodId;
                    return (
                      <div key={p.id} className="space-y-1">
                        <div className="text-[11px] font-semibold text-[var(--text-secondary)]">
                          {p.label}
                        </div>
                        <div className="flex items-baseline justify-between gap-2 tabular-nums">
                          <span
                            className={`text-sm font-extrabold ${
                              isBest ? 'text-[var(--accent)]' : 'text-[var(--text-primary)]'
                            }`}
                          >
                            {formatDurationMinutes(p.minutes)}
                          </span>
                          <span className="text-[11px] font-bold text-[var(--text-secondary)]">
                            {p.sharePercent}% · {p.sessions} جلسة
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            ) : (
              <div className="py-8 text-center text-xs text-[var(--text-secondary)]">
                أكمل منبه مذاكرة أو سجّل دقائق في أحد التحديات ليظهر منحنى ساعات ذروتك اليومية.
              </div>
            )}
          </section>

          {/* Chronological Study Habit Trend Chart (Weekly Daily vs Monthly Multi-Week) */}
          {hasWindowReminders && (
            <section className="rahhala-card p-5 sm:p-6">
              <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
                <div>
                  <h2 className="text-base font-extrabold text-[var(--text-primary)]">
                    عادات المذاكرة عبر الزمن
                  </h2>
                  <p className="text-xs text-[var(--text-secondary)] mt-0.5">
                    {timeRange === 'weekly'
                      ? 'الدقائق المنجزة والجلسات المكتملة يومياً خلال آخر 7 أيام'
                      : 'الدقائق المنجزة والجلسات المكتملة عبر فترات آخر 30 يوماً'}
                  </p>
                </div>
                <span className="text-xs font-bold text-[var(--text-secondary)] tabular-nums">
                  {timeRange === 'weekly' ? 'توزيع يومي · 7 أيام' : 'توزيع فترات · 30 يوماً'}
                </span>
              </div>

              <div className="w-full h-[300px]" dir="ltr">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={habitBuckets}
                    margin={{ top: 12, right: 16, left: 4, bottom: 12 }}
                    barGap={6}
                  >
                    <CartesianGrid
                      stroke="var(--divider)"
                      strokeDasharray="3 3"
                      vertical={false}
                    />
                    <XAxis
                      dataKey="label"
                      tick={{ fill: 'var(--text-secondary)', fontSize: 12, fontWeight: 600 }}
                      axisLine={{ stroke: 'var(--divider)' }}
                      tickLine={false}
                      interval={0}
                    />
                    <YAxis
                      yAxisId="minutes"
                      orientation="left"
                      allowDecimals={false}
                      tick={{ fill: 'var(--text-secondary)', fontSize: 11 }}
                      axisLine={false}
                      tickLine={false}
                      unit=" د"
                    />
                    <YAxis
                      yAxisId="sessions"
                      orientation="right"
                      allowDecimals={false}
                      tick={{ fill: 'var(--text-secondary)', fontSize: 11 }}
                      axisLine={false}
                      tickLine={false}
                    />
                    <Tooltip
                      cursor={{ fill: 'var(--accent-soft)', opacity: 0.35 }}
                      content={<HabitChartTooltip />}
                    />
                    <Legend
                      wrapperStyle={{ fontSize: '12px', paddingTop: '10px', color: 'var(--text-primary)' }}
                    />
                    <Bar
                      yAxisId="minutes"
                      dataKey="completedMinutes"
                      name="وقت المذاكرة (دقيقة)"
                      fill="var(--accent)"
                      radius={[8, 8, 0, 0]}
                      maxBarSize={36}
                    />
                    <Bar
                      yAxisId="sessions"
                      dataKey="completedCount"
                      name="الجلسات المكتملة"
                      fill="var(--success)"
                      radius={[8, 8, 0, 0]}
                      maxBarSize={36}
                    />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </section>
          )}

          {/* Per-Subject Recharts Visualization Card */}
          {hasWindowReminders && (
            <section className="rahhala-card p-5 sm:p-6">
              <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
                <div>
                  <h2 className="text-base font-extrabold text-[var(--text-primary)]">
                    تقدم المذاكرة ونسبة الإنجاز حسب المادة
                  </h2>
                  <p className="text-xs text-[var(--text-secondary)] mt-0.5">
                    مقارنة الدقائق المنجزة ومعدل إتمام التذكيرات لكل مادة خلال {windowLabel}
                  </p>
                </div>

                <div
                  role="group"
                  aria-label="تصفية العرض البياني"
                  className="inline-flex p-1 rounded-xl bg-[var(--bg-surface)] border border-[var(--divider)]"
                >
                  {(
                    [
                      { id: 'both', label: 'الكل' },
                      { id: 'minutes', label: 'الدقائق' },
                      { id: 'rate', label: 'نسبة الإنجاز' },
                    ] as const
                  ).map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      aria-pressed={metricView === tab.id}
                      onClick={() => setMetricView(tab.id)}
                      className={`min-h-[36px] px-3 py-1 rounded-lg text-xs font-bold transition-colors whitespace-nowrap shrink-0 ${
                        metricView === tab.id
                          ? 'bg-[var(--accent)] text-[var(--accent-fg)]'
                          : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                      }`}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="w-full h-[320px]" dir="ltr">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={rows}
                    margin={{ top: 12, right: 16, left: 4, bottom: 12 }}
                    barGap={8}
                  >
                    <CartesianGrid
                      stroke="var(--divider)"
                      strokeDasharray="3 3"
                      vertical={false}
                    />
                    <XAxis
                      dataKey="name"
                      tick={{ fill: 'var(--text-secondary)', fontSize: 12, fontWeight: 600 }}
                      axisLine={{ stroke: 'var(--divider)' }}
                      tickLine={false}
                      interval={0}
                    />
                    {metricView !== 'rate' && (
                      <YAxis
                        yAxisId="minutes"
                        orientation="left"
                        allowDecimals={false}
                        tick={{ fill: 'var(--text-secondary)', fontSize: 11 }}
                        axisLine={false}
                        tickLine={false}
                        unit=" د"
                      />
                    )}
                    {metricView !== 'minutes' && (
                      <YAxis
                        yAxisId="rate"
                        orientation={metricView === 'rate' ? 'left' : 'right'}
                        domain={[0, 100]}
                        allowDecimals={false}
                        tick={{ fill: 'var(--text-secondary)', fontSize: 11 }}
                        axisLine={false}
                        tickLine={false}
                        unit="%"
                      />
                    )}
                    <Tooltip
                      cursor={{ fill: 'var(--accent-soft)', opacity: 0.35 }}
                      content={<SubjectChartTooltip />}
                    />
                    <Legend
                      wrapperStyle={{ fontSize: '12px', paddingTop: '10px', color: 'var(--text-primary)' }}
                    />
                    {metricView !== 'rate' && (
                      <Bar
                        yAxisId="minutes"
                        dataKey="completedMinutes"
                        name="وقت المذاكرة (دقيقة)"
                        fill="var(--accent)"
                        radius={[8, 8, 0, 0]}
                        maxBarSize={40}
                      />
                    )}
                    {metricView !== 'minutes' && (
                      <Bar
                        yAxisId="rate"
                        dataKey="completionRate"
                        name="نسبة الإنجاز (%)"
                        fill="var(--success)"
                        radius={[8, 8, 0, 0]}
                        maxBarSize={40}
                      />
                    )}
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </section>
          )}
        </>
      )}

      {/* Per-Subject Breakdown List (Synchronized with Weekly/Monthly) */}
      {!loading && !error && hasWindowReminders && rows.length > 0 && (
        <section className="rahhala-card p-5 sm:p-6">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h2 className="text-base font-extrabold text-[var(--text-primary)]">
                تفاصيل التقدم لكل مادة
              </h2>
            </div>
            <span className="text-xs text-[var(--text-secondary)] tabular-nums">
              {windowLabel} · {rows.length} مادة
            </span>
          </div>

          <div className="divide-y divide-[var(--divider)]">
            {rows.map((row) => {
              const canOpen = subjects.some((s) => s.id === row.id);
              const rowColor = getSubjectColor
                ? getSubjectColor(canOpen ? row.id : null, row.accentColor)
                : row.accentColor;
              return (
                <div
                  key={row.id}
                  className="py-3.5 first:pt-1 last:pb-1 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                >
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <span
                          className="w-2.5 h-2.5 rounded-full shrink-0"
                          style={{ backgroundColor: rowColor }}
                          aria-hidden="true"
                        />
                        {canOpen ? (
                          <button
                            type="button"
                            onClick={() => onOpenSubject(row.id)}
                            className="font-bold text-sm text-[var(--text-primary)] hover:text-[var(--accent)] truncate text-right"
                          >
                            {row.name}
                          </button>
                        ) : (
                          <span className="font-bold text-sm text-[var(--text-primary)] truncate">
                            {row.name}
                          </span>
                        )}
                      </div>
                      <span className="text-xs text-[var(--text-secondary)] tabular-nums shrink-0">
                        {formatDurationMinutes(row.completedMinutes)} · {row.completedReminders}/{row.totalReminders} مكتمل ({row.completionRate}%)
                      </span>
                    </div>

                    <div
                      className="w-full h-2 rounded-full bg-[var(--bg-surface)] overflow-hidden"
                      aria-hidden="true"
                    >
                      <div
                        className="h-full rounded-full transition-all duration-300"
                        style={{
                          width: `${row.completionRate}%`,
                          backgroundColor: row.completionRate === 100 ? 'var(--success)' : rowColor,
                        }}
                      />
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => onOpenReminders(canOpen ? row.id : null)}
                    className="min-h-[38px] px-3 rounded-xl rahhala-glass-pill text-xs font-bold text-[var(--text-primary)] hover:border-[var(--accent)] flex items-center justify-center gap-1.5 shrink-0 whitespace-nowrap"
                  >
                    <Icons.Plus className="w-3.5 h-3.5 text-[var(--accent)]" />
                    <span>منبه</span>
                  </button>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Shared Study Challenges Section */}
      <StudyChallengesSection
        subjects={subjects}
        getSubjectColor={getSubjectColor}
        onToast={onToast}
        onActivityLogged={() => void loadChallengeActivity()}
        externalCreateTrigger={challengeCreateTrigger}
        onExternalCreateHandled={() => setChallengeCreateTrigger(0)}
      />
    </div>
  );
}
