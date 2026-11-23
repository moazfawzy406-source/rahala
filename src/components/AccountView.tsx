import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ALERT_TONES,
  ROLE_LABELS,
  SUBJECT_COLOR_PALETTE,
  SUBJECT_GENERAL_KEY,
  type AlertToneId,
  type AuthUser,
  type SessionInfo,
  type SubjectAlertPreference,
  type SubjectRecord,
} from '../../shared/types';
import { getToneLabel } from '../hooks/useSubjectPreferences';
import { playAlertTone } from '../lib/alertAudio';
import { ApiError, apiRequest, setStoredSessionToken, uploadAssetBinary } from '../lib/api';
import { formatDateTime, formatFullDate } from '../lib/formatters';
import { resizeImageForUpload } from '../lib/imageResize';
import { Icons, SubjectIcon } from './Icons';
import { Avatar, ConfirmDialog, ErrorRetryPanel } from './UI';

export function AccountView({
  user,
  onUserUpdated,
  onLoggedOut,
  onToast,
  preferencesMap,
  onSaveSubjectPreference,
  onResetSubjectPreference,
  focusAlertSettings,
  onFocusHandled,
}: {
  user: AuthUser;
  onUserUpdated: (user: AuthUser) => void;
  onLoggedOut: () => void;
  onToast: (msg: string, isError?: boolean) => void;
  preferencesMap: Record<string, SubjectAlertPreference>;
  onSaveSubjectPreference: (
    subjectId: string,
    input: { accentColor: string; toneId: AlertToneId },
    subjectLabel?: string
  ) => Promise<boolean>;
  onResetSubjectPreference: (subjectId: string, subjectLabel?: string) => Promise<boolean>;
  focusAlertSettings?: boolean;
  onFocusHandled?: () => void;
}) {
  const [displayName, setDisplayName] = useState(user.displayName);
  const [username, setUsername] = useState(user.username);
  const [bio, setBio] = useState(user.bio);
  const [avatarAssetId, setAvatarAssetId] = useState<string | null>(user.avatarAssetId);

  const [nameBusy, setNameBusy] = useState(false);
  const [userBusy, setUserBusy] = useState(false);
  const [profileBusy, setProfileBusy] = useState(false);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');
  const [passBusy, setPassBusy] = useState(false);

  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [sessionBusy, setSessionBusy] = useState(false);
  const [confirmRevokeOthers, setConfirmRevokeOthers] = useState(false);

  const [subjects, setSubjects] = useState<SubjectRecord[]>([]);
  const [subjectsLoading, setSubjectsLoading] = useState(true);
  const [customHexDraft, setCustomHexDraft] = useState<Record<string, string>>({});

  const avatarInputRef = useRef<HTMLInputElement | null>(null);
  const alertSettingsRef = useRef<HTMLElement | null>(null);
  const colorDebounceRef = useRef<Record<string, number>>({});

  useEffect(() => {
    setDisplayName(user.displayName);
    setUsername(user.username);
    setBio(user.bio);
    setAvatarAssetId(user.avatarAssetId);
  }, [user]);

  useEffect(() => {
    if (focusAlertSettings && alertSettingsRef.current) {
      alertSettingsRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
      onFocusHandled?.();
    }
  }, [focusAlertSettings, onFocusHandled]);

  const loadSubjectsForPrefs = useCallback(async () => {
    setSubjectsLoading(true);
    try {
      const res = await apiRequest<{ subjects: SubjectRecord[] }>('/api/resources/subjects', {
        background: true,
      });
      setSubjects(res.subjects);
    } catch {
      // keep empty list if load fails
    } finally {
      setSubjectsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSubjectsForPrefs();
  }, [loadSubjectsForPrefs]);

  useEffect(() => {
    return () => {
      Object.values(colorDebounceRef.current).forEach((timerId) => window.clearTimeout(timerId));
    };
  }, []);

  const loadSessions = useCallback(async () => {
    setSessionsLoading(true);
    setSessionsError(null);
    try {
      const res = await apiRequest<{ sessions: SessionInfo[] }>('/api/auth/sessions');
      setSessions(res.sessions);
    } catch (err) {
      setSessionsError(err instanceof ApiError ? err.message : 'تعذر تحميل الجلسات');
    } finally {
      setSessionsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  const handleSaveDisplayName = async (e: React.FormEvent) => {
    e.preventDefault();
    setNameBusy(true);
    try {
      const res = await apiRequest<{ user: AuthUser }>('/api/auth/profile', {
        method: 'PATCH',
        body: { displayName },
      });
      onUserUpdated(res.user);
      onToast('تم تحديث الاسم الظاهر بنجاح');
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'تعذر تحديث الاسم', true);
    } finally {
      setNameBusy(false);
    }
  };

  const handleSaveUsername = async (e: React.FormEvent) => {
    e.preventDefault();
    setUserBusy(true);
    try {
      const res = await apiRequest<{ user: AuthUser }>('/api/auth/profile', {
        method: 'PATCH',
        body: { username },
      });
      onUserUpdated(res.user);
      onToast('تم تحديث اسم المستخدم — احفظ الاسم الجديد لأنه يُستخدم لتسجيل الدخول');
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'تعذر تحديث اسم المستخدم', true);
    } finally {
      setUserBusy(false);
    }
  };

  const handleAvatarFileSelected = async (file: File) => {
    setProfileBusy(true);
    try {
      const resized = await resizeImageForUpload(file, 360, 0.88);
      const uploaded = await uploadAssetBinary(resized.blob, resized.filename, 'avatar');
      setAvatarAssetId(uploaded.assetId);
      const res = await apiRequest<{ user: AuthUser }>('/api/auth/profile', {
        method: 'PATCH',
        body: { avatarAssetId: uploaded.assetId, bio },
      });
      onUserUpdated(res.user);
      onToast('تم تحديث الصورة الشخصية');
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'تعذر رفع الصورة', true);
    } finally {
      setProfileBusy(false);
    }
  };

  const handleSaveBioAndAvatar = async (e: React.FormEvent) => {
    e.preventDefault();
    setProfileBusy(true);
    try {
      const res = await apiRequest<{ user: AuthUser }>('/api/auth/profile', {
        method: 'PATCH',
        body: { bio, avatarAssetId },
      });
      onUserUpdated(res.user);
      onToast('تم حفظ الصورة والبايو');
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'تعذر حفظ التعديلات', true);
    } finally {
      setProfileBusy(false);
    }
  };

  const handleRemoveAvatar = async () => {
    setProfileBusy(true);
    try {
      const res = await apiRequest<{ user: AuthUser }>('/api/auth/profile', {
        method: 'PATCH',
        body: { avatarAssetId: null },
      });
      setAvatarAssetId(null);
      onUserUpdated(res.user);
      onToast('تمت إزالة الصورة الشخصية');
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'تعذر إزالة الصورة', true);
    } finally {
      setProfileBusy(false);
    }
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword !== confirmNewPassword) {
      onToast('كلمتا المرور الجديدتان غير متطابقتين', true);
      return;
    }
    setPassBusy(true);
    try {
      const res = await apiRequest<{ message: string; sessionToken?: string }>('/api/auth/password', {
        method: 'POST',
        body: { currentPassword, newPassword, confirmNewPassword },
      });
      if (res.sessionToken) {
        setStoredSessionToken(res.sessionToken);
      }
      setCurrentPassword('');
      setNewPassword('');
      setConfirmNewPassword('');
      onToast(res.message);
      await loadSessions();
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'تعذر تغيير كلمة المرور', true);
    } finally {
      setPassBusy(false);
    }
  };

  const handleRevokeSession = async (id: string) => {
    setSessionBusy(true);
    try {
      const res = await apiRequest<{ revokedCurrent: boolean }>(
        `/api/auth/sessions/${encodeURIComponent(id)}/revoke`,
        { method: 'POST' }
      );
      if (res.revokedCurrent) {
        setStoredSessionToken(null);
        onLoggedOut();
        return;
      }
      onToast('تم إنهاء الجلسة');
      await loadSessions();
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'تعذر إنهاء الجلسة', true);
    } finally {
      setSessionBusy(false);
    }
  };

  const handleRevokeOthers = async () => {
    setSessionBusy(true);
    try {
      await apiRequest('/api/auth/sessions/revoke-others', { method: 'POST' });
      setConfirmRevokeOthers(false);
      onToast('تم تسجيل الخروج من كل الأجهزة التانية');
      await loadSessions();
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'تعذر تنفيذ الطلب', true);
    } finally {
      setSessionBusy(false);
    }
  };

  const handleLogout = async () => {
    try {
      await apiRequest('/api/auth/logout', { method: 'POST' });
    } catch {
      // clear local state regardless
    }
    setStoredSessionToken(null);
    onLoggedOut();
  };

  return (
    <div className="space-y-5 max-w-2xl mx-auto">
      {/* Identity Card */}
      <section className="rahhala-card p-5 flex items-center justify-between gap-4">
        <div className="flex items-center gap-4 min-w-0">
          <Avatar name={user.displayName} assetId={user.avatarAssetId} size="lg" />
          <div className="min-w-0">
            <h1 className="text-lg font-extrabold text-[var(--text-primary)] truncate">
              {user.displayName}
            </h1>
            <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--text-secondary)] mt-0.5">
              <span dir="ltr">@{user.username}</span>
              <span>·</span>
              <span className="font-bold text-[var(--accent)]">{ROLE_LABELS[user.role]}</span>
              <span>·</span>
              <span>انضم في {formatFullDate(user.createdAt)}</span>
            </div>
          </div>
        </div>
      </section>

      {/* إعدادات تخصيص ألوان ونغمات تنبيهات المواد */}
      <section
        id="subject-alert-settings"
        ref={alertSettingsRef}
        className="rahhala-card p-5 space-y-4"
      >
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 className="text-base font-extrabold text-[var(--text-primary)] flex items-center gap-2">
              <Icons.Sliders className="w-4 h-4 text-[var(--accent)]" />
              <span>تخصيص ألوان ونغمات تنبيهات المواد</span>
            </h2>
            <p className="text-xs text-[var(--text-secondary)] mt-1">
              اختر لوناً مميزاً ونغمة منبه خاصة لكل مادة لتمييز تنبيهاتها فوراً عند حلول موعد المذاكرة.
            </p>
          </div>
        </div>

        {subjectsLoading ? (
          <div className="space-y-3">
            {[1, 2, 3].map((k) => (
              <div key={k} className="h-24 rounded-2xl bg-[var(--bg-surface)]/50 animate-pulse" />
            ))}
          </div>
        ) : (
          <div className="divide-y divide-[var(--divider)]">
            {[
              ...subjects.map((s) => ({
                id: s.id,
                name: s.name,
                defaultColor: s.accentColor || '#E3B23C',
                iconName: s.iconName,
              })),
              {
                id: SUBJECT_GENERAL_KEY,
                name: 'مذاكرة عامة',
                defaultColor: '#E3B23C',
                iconName: 'layers',
              },
            ].map((item) => {
              const saved = preferencesMap[item.id];
              const activeColor = customHexDraft[item.id] ?? saved?.accentColor ?? item.defaultColor;
              const activeTone: AlertToneId = saved?.toneId ?? 'chime';
              const isCustomized = Boolean(saved);

              const handleSelectColor = (hex: string) => {
                setCustomHexDraft((prev) => {
                  const next = { ...prev };
                  delete next[item.id];
                  return next;
                });
                void onSaveSubjectPreference(
                  item.id,
                  { accentColor: hex, toneId: activeTone },
                  item.name
                );
              };

              const handleCustomColorDrag = (hex: string) => {
                setCustomHexDraft((prev) => ({ ...prev, [item.id]: hex }));
                if (colorDebounceRef.current[item.id]) {
                  window.clearTimeout(colorDebounceRef.current[item.id]);
                }
                colorDebounceRef.current[item.id] = window.setTimeout(() => {
                  void onSaveSubjectPreference(
                    item.id,
                    { accentColor: hex, toneId: activeTone },
                    item.name
                  );
                }, 320);
              };

              const handleToneChange = (nextTone: AlertToneId) => {
                playAlertTone(nextTone);
                void onSaveSubjectPreference(
                  item.id,
                  { accentColor: activeColor, toneId: nextTone },
                  item.name
                );
              };

              return (
                <div key={item.id} className="py-4 first:pt-1 last:pb-1 space-y-3">
                  {/* Subject Name + Active Preview Summary + Reset */}
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-3 min-w-0">
                      <div
                        className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0 border"
                        style={{
                          backgroundColor: `${activeColor}22`,
                          color: activeColor,
                          borderColor: `${activeColor}55`,
                        }}
                      >
                        <SubjectIcon name={item.iconName} className="w-5 h-5" />
                      </div>
                      <div className="min-w-0">
                        <div className="font-bold text-sm text-[var(--text-primary)] truncate">
                          {item.name}
                        </div>
                        <div className="text-xs text-[var(--text-secondary)] flex items-center gap-1.5 mt-0.5">
                          <span
                            className="inline-block w-2.5 h-2.5 rounded-full shrink-0"
                            style={{ backgroundColor: activeColor }}
                            aria-hidden="true"
                          />
                          <span>نغمة: {getToneLabel(activeTone)}</span>
                        </div>
                      </div>
                    </div>

                    {isCustomized && (
                      <button
                        type="button"
                        onClick={() => {
                          setCustomHexDraft((prev) => {
                            const next = { ...prev };
                            delete next[item.id];
                            return next;
                          });
                          void onResetSubjectPreference(item.id, item.name);
                        }}
                        className="min-h-[36px] px-2.5 rounded-xl bg-[var(--bg-surface)] border border-[var(--divider)] text-xs font-semibold text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--accent)] flex items-center gap-1.5 whitespace-nowrap"
                      >
                        <Icons.RotateCcw className="w-3.5 h-3.5" />
                        <span>افتراضي</span>
                      </button>
                    )}
                  </div>

                  {/* Color Swatches + Custom Color Picker + Tone Selector */}
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={`لون مادة ${item.name}`}>
                      {SUBJECT_COLOR_PALETTE.map((swatch) => {
                        const selected = activeColor.toUpperCase() === swatch.hex.toUpperCase();
                        return (
                          <button
                            key={swatch.hex}
                            type="button"
                            aria-label={`${swatch.label} لمادة ${item.name}`}
                            aria-pressed={selected}
                            onClick={() => handleSelectColor(swatch.hex)}
                            className={`w-8 h-8 rounded-xl flex items-center justify-center border transition-transform ${
                              selected
                                ? 'scale-105 ring-2 ring-[var(--text-primary)] ring-offset-2 ring-offset-[var(--bg-card)] border-transparent'
                                : 'border-white/15 hover:scale-105'
                            }`}
                            style={{ backgroundColor: swatch.hex }}
                          >
                            {selected && <Icons.Check className="w-4 h-4 text-[#0C1622]" />}
                          </button>
                        );
                      })}

                      <label
                        title="اختيار لون مخصص"
                        className="w-8 h-8 rounded-xl bg-[var(--bg-surface)] border border-[var(--divider)] hover:border-[var(--accent)] flex items-center justify-center cursor-pointer overflow-hidden"
                      >
                        <Icons.Palette className="w-3.5 h-3.5 text-[var(--text-secondary)] pointer-events-none" />
                        <input
                          type="color"
                          aria-label={`لون مخصص لمادة ${item.name}`}
                          value={activeColor}
                          onChange={(e) => handleCustomColorDrag(e.target.value)}
                          className="sr-only"
                        />
                      </label>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <select
                        aria-label={`نغمة تنبيه مادة ${item.name}`}
                        value={activeTone}
                        onChange={(e) => handleToneChange(e.target.value as AlertToneId)}
                        className="rahhala-input min-h-[40px] px-3 py-1.5 text-xs font-bold flex-1 sm:w-44"
                      >
                        {ALERT_TONES.map((tone) => (
                          <option key={tone.id} value={tone.id}>
                            {tone.label}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        aria-label={`معاينة نغمة مادة ${item.name}`}
                        title="معاينة النغمة"
                        onClick={() => {
                          if (activeTone === 'silent') {
                            onToast(`تنبيه مادة «${item.name}» مضبوط على الوضع الصامت (مرئي فقط)`);
                          } else {
                            playAlertTone(activeTone);
                          }
                        }}
                        className="min-h-[40px] min-w-[40px] px-3 rounded-xl rahhala-glass-pill text-xs font-bold text-[var(--text-primary)] hover:border-[var(--accent)] flex items-center justify-center gap-1.5 whitespace-nowrap"
                      >
                        <Icons.Volume2 className="w-4 h-4 text-[var(--accent)]" />
                        <span className="hidden sm:inline">تجربة</span>
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* الاسم الظاهر */}
      <section className="rahhala-card p-5">
        <h2 className="text-base font-extrabold text-[var(--text-primary)]">الاسم الظاهر</h2>
        <p className="text-xs text-[var(--text-secondary)] mt-1 mb-3">
          ده الاسم اللي بيشوفه زمايلك في المواد والمحادثة وقائمة الأعضاء.
        </p>
        <form onSubmit={handleSaveDisplayName} className="flex flex-col sm:flex-row gap-2.5">
          <input
            type="text"
            required
            minLength={2}
            maxLength={60}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            className="rahhala-input flex-1 px-3.5 py-2"
          />
          <button
            type="submit"
            disabled={nameBusy}
            className="min-h-[44px] px-5 rounded-xl bg-[var(--accent)] text-[var(--accent-fg)] text-sm font-bold disabled:opacity-60"
          >
            {nameBusy ? 'جاري الحفظ...' : 'حفظ الاسم'}
          </button>
        </form>
      </section>

      {/* اسم المستخدم */}
      <section className="rahhala-card p-5">
        <h2 className="text-base font-extrabold text-[var(--text-primary)]">اسم المستخدم</h2>
        <p className="text-xs text-[var(--text-secondary)] mt-1 mb-3">
          تذكير مهم: اسم المستخدم يُستخدم لتسجيل الدخول لحسابك — احفظ الاسم الجديد بعد التعديل.
        </p>
        <form onSubmit={handleSaveUsername} className="flex flex-col sm:flex-row gap-2.5">
          <input
            type="text"
            dir="ltr"
            required
            minLength={3}
            maxLength={30}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="rahhala-input flex-1 px-3.5 py-2 text-left"
          />
          <button
            type="submit"
            disabled={userBusy}
            className="min-h-[44px] px-5 rounded-xl bg-[var(--accent)] text-[var(--accent-fg)] text-sm font-bold disabled:opacity-60"
          >
            {userBusy ? 'جاري الحفظ...' : 'حفظ اسم المستخدم'}
          </button>
        </form>
      </section>

      {/* الصورة والبايو */}
      <section className="rahhala-card p-5 space-y-4">
        <div>
          <h2 className="text-base font-extrabold text-[var(--text-primary)]">الصورة والبايو</h2>
          <p className="text-xs text-[var(--text-secondary)] mt-1">
            صورتك الشخصية والنبذة التعريفية بتظهر لباقي الأعضاء في ملفك.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Avatar name={user.displayName} assetId={avatarAssetId} size="lg" />
          <input
            ref={avatarInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void handleAvatarFileSelected(f);
            }}
          />
          <button
            type="button"
            disabled={profileBusy}
            onClick={() => avatarInputRef.current?.click()}
            className="min-h-[42px] px-4 rounded-xl bg-[var(--bg-surface)] border border-[var(--divider)] text-xs font-bold flex items-center gap-1.5 hover:border-[var(--accent)]"
          >
            <Icons.Upload className="w-4 h-4" />
            <span>{avatarAssetId ? 'تغيير الصورة' : 'رفع صورة'}</span>
          </button>
          {avatarAssetId && (
            <button
              type="button"
              disabled={profileBusy}
              onClick={handleRemoveAvatar}
              className="min-h-[42px] px-4 rounded-xl bg-[var(--error-soft)] text-[var(--error)] text-xs font-bold"
            >
              إزالة الصورة
            </button>
          )}
        </div>

        <form onSubmit={handleSaveBioAndAvatar} className="space-y-3">
          <div>
            <div className="flex justify-between text-xs text-[var(--text-secondary)] mb-1">
              <label htmlFor="bio-input" className="font-semibold">
                البايو (بحد أقصى ١٦٠ حرفًا)
              </label>
              <span className="tabular-nums">{bio.length} / 160</span>
            </div>
            <textarea
              id="bio-input"
              rows={2}
              maxLength={160}
              value={bio}
              onChange={(e) => setBio(e.target.value)}
              placeholder="اكتب نبذة قصيرة عنك…"
              className="rahhala-input w-full px-3.5 py-2.5 resize-none"
            />
          </div>
          <button
            type="submit"
            disabled={profileBusy}
            className="min-h-[44px] px-5 rounded-xl bg-[var(--accent)] text-[var(--accent-fg)] text-sm font-bold disabled:opacity-60"
          >
            {profileBusy ? 'جاري الحفظ...' : 'حفظ الصورة والبايو'}
          </button>
        </form>
      </section>

      {/* تغيير كلمة المرور */}
      <section className="rahhala-card p-5 space-y-3.5">
        <h2 className="text-base font-extrabold text-[var(--text-primary)]">تغيير كلمة المرور</h2>
        <form onSubmit={handleChangePassword} className="space-y-3">
          <input
            type="password"
            autoComplete="current-password"
            required
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            placeholder="كلمة المرور الحالية"
            className="rahhala-input w-full px-3.5 py-2"
          />
          <input
            type="password"
            autoComplete="new-password"
            required
            minLength={6}
            maxLength={100}
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            placeholder="كلمة المرور الجديدة (٦ أحرف على الأقل)"
            className="rahhala-input w-full px-3.5 py-2"
          />
          <input
            type="password"
            autoComplete="new-password"
            required
            minLength={6}
            maxLength={100}
            value={confirmNewPassword}
            onChange={(e) => setConfirmNewPassword(e.target.value)}
            placeholder="تأكيد كلمة المرور الجديدة"
            className="rahhala-input w-full px-3.5 py-2"
          />
          <button
            type="submit"
            disabled={passBusy}
            className="min-h-[44px] px-5 rounded-xl bg-[var(--accent)] text-[var(--accent-fg)] text-sm font-bold disabled:opacity-60"
          >
            {passBusy ? 'جاري التحديث...' : 'تغيير كلمة المرور'}
          </button>
        </form>
      </section>

      {/* الأجهزة / جلسات الدخول */}
      <section className="rahhala-card p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-extrabold text-[var(--text-primary)]">
            الأجهزة وجلسات الدخول
          </h2>
          {sessions.length > 1 && (
            <button
              type="button"
              disabled={sessionBusy}
              onClick={() => setConfirmRevokeOthers(true)}
              className="min-h-[40px] px-3.5 rounded-xl bg-[var(--error-soft)] text-[var(--error)] text-xs font-bold"
            >
              تسجيل الخروج من كل الأجهزة التانية
            </button>
          )}
        </div>

        {sessionsLoading ? (
          <div className="h-20 rounded-xl bg-[var(--bg-surface)] animate-pulse" />
        ) : sessionsError ? (
          <ErrorRetryPanel message={sessionsError} onRetry={loadSessions} />
        ) : (
          <div className="divide-y divide-[var(--divider)]">
            {sessions.map((s) => (
              <div
                key={s.id}
                className="py-3 first:pt-0 last:pb-0 flex items-center justify-between gap-3"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-sm font-bold text-[var(--text-primary)]">
                    <span>{s.deviceLabel}</span>
                    {s.isCurrent && (
                      <span className="text-xs text-[var(--success)] font-bold">· الجلسة الحالية</span>
                    )}
                  </div>
                  <div className="text-xs text-[var(--text-secondary)] mt-0.5 tabular-nums">
                    بدأت: {formatDateTime(s.createdAt)} · آخر نشاط: {formatDateTime(s.lastActivityAt)}
                  </div>
                </div>
                <button
                  type="button"
                  disabled={sessionBusy}
                  onClick={() => handleRevokeSession(s.id)}
                  className="min-h-[40px] px-3.5 rounded-xl bg-[var(--bg-surface)] border border-[var(--divider)] text-xs font-bold text-[var(--error)] hover:border-[var(--error)]"
                >
                  {s.isCurrent ? 'خروج' : 'إنهاء'}
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* تسجيل الخروج */}
      <button
        type="button"
        onClick={handleLogout}
        className="w-full min-h-[48px] rounded-2xl bg-[var(--error-soft)] border border-[var(--error)]/30 text-[var(--error)] font-extrabold text-sm flex items-center justify-center gap-2 hover:opacity-90"
      >
        <Icons.LogOut className="w-4 h-4" />
        <span>تسجيل الخروج</span>
      </button>

      <ConfirmDialog
        open={confirmRevokeOthers}
        onClose={() => setConfirmRevokeOthers(false)}
        onConfirm={handleRevokeOthers}
        title="تسجيل الخروج من كل الأجهزة التانية"
        message="سيتم إنهاء جميع جلسات الدخول النشطة على الأجهزة الأخرى مع إبقاء جلستك الحالية فقط."
        confirmLabel="إنهاء الجلسات الأخرى"
        destructive
        busy={sessionBusy}
      />
    </div>
  );
}
