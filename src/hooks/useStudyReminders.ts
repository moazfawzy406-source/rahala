import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AlertToneId, AuthUser, StudyReminderRecord } from '../../shared/types';
import { playAlertTone } from '../lib/alertAudio';
import { ApiError, apiRequest } from '../lib/api';

export function formatRemainingCountdown(targetMs: number, nowMs: number): string {
  const diff = Math.max(0, targetMs - nowMs);
  const totalSec = Math.floor(diff / 1000);
  if (totalSec === 0) return 'الآن';

  const days = Math.floor(totalSec / 86_400);
  const hours = Math.floor((totalSec % 86_400) / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;

  if (days > 0) return `بعد ${days} ي ${hours} س`;
  if (hours > 0) return `${hours}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export function useStudyReminders(
  user: AuthUser | null,
  onToast: (msg: string, isError?: boolean) => void,
  getSubjectTone?: (subjectId: string | null | undefined) => AlertToneId
) {
  const [reminders, setReminders] = useState<StudyReminderRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const triggeredIdsRef = useRef<Set<string>>(new Set());

  const loadReminders = useCallback(async () => {
    if (!user) {
      setReminders([]);
      return;
    }
    setLoading(true);
    try {
      const res = await apiRequest<{ reminders: StudyReminderRecord[] }>('/api/reminders', {
        background: true,
      });
      setReminders(res.reminders);
    } catch {
      // ignore initial/background fetch error
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    triggeredIdsRef.current.clear();
    void loadReminders();
  }, [loadReminders]);

  const activeReminders = useMemo(
    () => reminders.filter((r) => r.status === 'active').sort((a, b) => a.remindAt - b.remindAt),
    [reminders]
  );

  const dueAlerts = useMemo(
    () => reminders.filter((r) => r.status === 'triggered'),
    [reminders]
  );

  const nextReminder = activeReminders[0] ?? null;

  // Tick every second when at least one active reminder exists so countdown & trigger are instant
  useEffect(() => {
    if (!user || activeReminders.length === 0) return;
    setNowTick(Date.now());
    const id = window.setInterval(() => {
      setNowTick(Date.now());
    }, 1000);
    return () => window.clearInterval(id);
  }, [user, activeReminders.length]);

  // Detect any active reminder whose remindAt has arrived
  useEffect(() => {
    if (!user) return;
    const dueNow = activeReminders.filter(
      (r) => r.remindAt <= nowTick && !triggeredIdsRef.current.has(r.id)
    );
    if (dueNow.length === 0) return;

    dueNow.forEach((rem) => {
      triggeredIdsRef.current.add(rem.id);
    });

    const primaryTone = getSubjectTone ? getSubjectTone(dueNow[0]?.subjectId) : 'chime';
    playAlertTone(primaryTone);

    setReminders((prev) =>
      prev.map((item) =>
        dueNow.some((d) => d.id === item.id) ? { ...item, status: 'triggered' } : item
      )
    );

    void Promise.all(
      dueNow.map((rem) =>
        apiRequest(`/api/reminders/${encodeURIComponent(rem.id)}`, {
          method: 'PATCH',
          body: { status: 'triggered' },
          background: true,
        }).catch(() => {})
      )
    );
  }, [user, activeReminders, nowTick, getSubjectTone]);

  const createReminder = useCallback(
    async (input: {
      subjectId: string | null;
      subjectName?: string;
      note?: string;
      delayMinutes?: number;
      remindAt?: number;
    }): Promise<boolean> => {
      try {
        const res = await apiRequest<{ reminder: StudyReminderRecord }>('/api/reminders', {
          method: 'POST',
          body: input,
        });
        setReminders((prev) => [res.reminder, ...prev]);
        onToast(`تم ضبط منبه المذاكرة لمادة «${res.reminder.subjectName}»`);
        return true;
      } catch (err) {
        onToast(err instanceof ApiError ? err.message : 'تعذر ضبط المنبه', true);
        return false;
      }
    },
    [onToast]
  );

  const snoozeReminder = useCallback(
    async (id: string, minutes = 10) => {
      triggeredIdsRef.current.delete(id);
      try {
        const res = await apiRequest<{ reminder: StudyReminderRecord }>(
          `/api/reminders/${encodeURIComponent(id)}`,
          {
            method: 'PATCH',
            body: { snoozeMinutes: minutes },
          }
        );
        setReminders((prev) => prev.map((r) => (r.id === id ? res.reminder : r)));
        onToast(`تم تأجيل التذكير لمدة ${minutes} دقائق`);
      } catch (err) {
        onToast(err instanceof ApiError ? err.message : 'تعذر تأجيل التذكير', true);
      }
    },
    [onToast]
  );

  const completeReminder = useCallback(
    async (id: string) => {
      triggeredIdsRef.current.delete(id);
      try {
        const res = await apiRequest<{ reminder: StudyReminderRecord }>(
          `/api/reminders/${encodeURIComponent(id)}`,
          {
            method: 'PATCH',
            body: { status: 'completed' },
          }
        );
        setReminders((prev) => prev.map((r) => (r.id === id ? res.reminder : r)));
      } catch (err) {
        onToast(err instanceof ApiError ? err.message : 'تعذر تحديث التذكير', true);
      }
    },
    [onToast]
  );

  const deleteReminder = useCallback(
    async (id: string) => {
      triggeredIdsRef.current.delete(id);
      try {
        await apiRequest(`/api/reminders/${encodeURIComponent(id)}`, {
          method: 'DELETE',
        });
        setReminders((prev) => prev.filter((r) => r.id !== id));
      } catch (err) {
        onToast(err instanceof ApiError ? err.message : 'تعذر حذف التذكير', true);
      }
    },
    [onToast]
  );

  return {
    reminders,
    activeReminders,
    dueAlerts,
    nextReminder,
    nowTick,
    loading,
    loadReminders,
    createReminder,
    snoozeReminder,
    completeReminder,
    deleteReminder,
  };
}
