import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ALERT_TONES,
  SUBJECT_GENERAL_KEY,
  type AlertToneId,
  type AuthUser,
  type SubjectAlertPreference,
} from '../../shared/types';
import { ApiError, apiRequest } from '../lib/api';

const DEFAULT_COLOR = '#E3B23C';
const DEFAULT_TONE: AlertToneId = 'chime';

export function getToneLabel(toneId: AlertToneId): string {
  return ALERT_TONES.find((t) => t.id === toneId)?.label ?? 'رنين ثلاثي';
}

export function useSubjectPreferences(
  user: AuthUser | null,
  onToast: (msg: string, isError?: boolean) => void
) {
  const [preferences, setPreferences] = useState<SubjectAlertPreference[]>([]);
  const [loading, setLoading] = useState(false);

  const loadPreferences = useCallback(async () => {
    if (!user) {
      setPreferences([]);
      return;
    }
    setLoading(true);
    try {
      const res = await apiRequest<{ preferences: SubjectAlertPreference[] }>(
        '/api/reminders/preferences',
        { background: true }
      );
      setPreferences(res.preferences);
    } catch {
      // keep defaults if background load fails
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    void loadPreferences();
  }, [loadPreferences]);

  const preferencesMap = useMemo(() => {
    const map: Record<string, SubjectAlertPreference> = {};
    for (const pref of preferences) {
      map[pref.subjectId] = pref;
    }
    return map;
  }, [preferences]);

  const getSubjectColor = useCallback(
    (subjectId: string | null | undefined, fallbackColor?: string): string => {
      const key = subjectId || SUBJECT_GENERAL_KEY;
      return preferencesMap[key]?.accentColor || fallbackColor || DEFAULT_COLOR;
    },
    [preferencesMap]
  );

  const getSubjectTone = useCallback(
    (subjectId: string | null | undefined): AlertToneId => {
      const key = subjectId || SUBJECT_GENERAL_KEY;
      return preferencesMap[key]?.toneId || DEFAULT_TONE;
    },
    [preferencesMap]
  );

  const savePreference = useCallback(
    async (
      subjectId: string,
      input: { accentColor: string; toneId: AlertToneId },
      subjectLabel?: string
    ): Promise<boolean> => {
      const optimistic: SubjectAlertPreference = {
        subjectId,
        accentColor: input.accentColor.toUpperCase(),
        toneId: input.toneId,
        updatedAt: Date.now(),
      };
      setPreferences((prev) => {
        const filtered = prev.filter((p) => p.subjectId !== subjectId);
        return [optimistic, ...filtered];
      });

      try {
        const res = await apiRequest<{ preference: SubjectAlertPreference }>(
          `/api/reminders/preferences/${encodeURIComponent(subjectId)}`,
          {
            method: 'PUT',
            body: input,
          }
        );
        setPreferences((prev) => {
          const filtered = prev.filter((p) => p.subjectId !== subjectId);
          return [res.preference, ...filtered];
        });
        if (subjectLabel) {
          onToast(`تم حفظ تخصيص تنبيهات «${subjectLabel}»`);
        }
        return true;
      } catch (err) {
        await loadPreferences();
        onToast(err instanceof ApiError ? err.message : 'تعذر حفظ تخصيص المادة', true);
        return false;
      }
    },
    [loadPreferences, onToast]
  );

  const resetPreference = useCallback(
    async (subjectId: string, subjectLabel?: string): Promise<boolean> => {
      setPreferences((prev) => prev.filter((p) => p.subjectId !== subjectId));
      try {
        await apiRequest(`/api/reminders/preferences/${encodeURIComponent(subjectId)}`, {
          method: 'DELETE',
        });
        if (subjectLabel) {
          onToast(`تمت استعادة الإعداد الافتراضي لمادة «${subjectLabel}»`);
        }
        return true;
      } catch (err) {
        await loadPreferences();
        onToast(err instanceof ApiError ? err.message : 'تعذر استعادة الإعداد الافتراضي', true);
        return false;
      }
    },
    [loadPreferences, onToast]
  );

  return {
    preferences,
    preferencesMap,
    loading,
    loadPreferences,
    savePreference,
    resetPreference,
    getSubjectColor,
    getSubjectTone,
  };
}
