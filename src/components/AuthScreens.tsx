import React, { useState } from 'react';
import { motion } from 'motion/react';
import type { AppPublicConfig, AuthUser } from '../../shared/types';
import { ApiError, apiRequest, setStoredSessionToken } from '../lib/api';
import { Icons, RahhalaBookMark } from './Icons';

export function AuthScreens({
  config,
  initialNotice,
  onAuthenticated,
  onOpenThemeModal,
}: {
  config: AppPublicConfig;
  initialNotice: string | null;
  onAuthenticated: (user: AuthUser) => void;
  onOpenThemeModal: () => void;
}) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [notice, setNotice] = useState<string | null>(initialNotice);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Login fields
  const [loginUsername, setLoginUsername] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [showLoginPass, setShowLoginPass] = useState(false);

  // Register fields
  const [regName, setRegName] = useState('');
  const [regUsername, setRegUsername] = useState('');
  const [regEmail, setRegEmail] = useState('');
  const [regPassword, setRegPassword] = useState('');
  const [regConfirm, setRegConfirm] = useState('');
  const [showRegPass, setShowRegPass] = useState(false);
  const [pendingCreated, setPendingCreated] = useState(false);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const res = await apiRequest<{ user: AuthUser; sessionToken?: string }>('/api/auth/login', {
        method: 'POST',
        body: { username: loginUsername, password: loginPassword },
        skipUnauthorizedHandler: true,
      });
      setStoredSessionToken(res.sessionToken ?? null);
      onAuthenticated(res.user);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر تسجيل الدخول');
    } finally {
      setBusy(false);
    }
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);
    if (regPassword !== regConfirm) {
      setError('كلمتا المرور غير متطابقتين');
      return;
    }
    setBusy(true);
    try {
      const res = await apiRequest<{ message: string }>('/api/auth/register', {
        method: 'POST',
        body: {
          displayName: regName,
          username: regUsername,
          email: regEmail,
          password: regPassword,
          confirmPassword: regConfirm,
        },
        skipUnauthorizedHandler: true,
      });
      setPendingCreated(true);
      setNotice(res.message);
      setRegPassword('');
      setRegConfirm('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر إنشاء الحساب');
    } finally {
      setBusy(false);
    }
  };

  const handlePreviewLogin = async (demoUsername: string) => {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const res = await apiRequest<{ user: AuthUser; sessionToken?: string }>('/api/auth/preview-login', {
        method: 'POST',
        body: { username: demoUsername },
        skipUnauthorizedHandler: true,
      });
      setStoredSessionToken(res.sessionToken ?? null);
      onAuthenticated(res.user);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر الدخول بوضع المعاينة');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-dvh flex flex-col justify-center px-4 py-8">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
        className="w-full max-w-md mx-auto"
      >
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-2xl bg-[var(--accent-soft)] text-[var(--accent)] flex items-center justify-center border border-[var(--divider)]">
              <RahhalaBookMark className="w-6 h-6" />
            </div>
            <div>
              <h1 className="text-2xl font-extrabold text-[var(--accent)] leading-tight">
                {config.brandName}
              </h1>
              {config.institutionSubtitle && (
                <p className="text-xs text-[var(--text-secondary)]">
                  {config.institutionSubtitle}
                </p>
              )}
            </div>
          </div>

          <button
            type="button"
            onClick={onOpenThemeModal}
            aria-label="تغيير المظهر"
            className="min-h-[44px] min-w-[44px] rounded-xl bg-[var(--bg-card)] border border-[var(--divider)] text-[var(--text-primary)] flex items-center justify-center hover:border-[var(--accent)]"
          >
            <Icons.Palette className="w-5 h-5" />
          </button>
        </div>

        <div className="rahhala-card p-6">
          <div className="mb-5">
            <h2 className="text-lg font-bold text-[var(--text-primary)]">
              {mode === 'login' ? 'تسجيل الدخول' : 'إنشاء حساب طالب'}
            </h2>
            <p className="text-xs text-[var(--text-secondary)] mt-1">{config.tagline}</p>
          </div>

          {notice && (
            <div
              role="status"
              className="mb-4 p-3.5 rounded-xl bg-[var(--success-soft)] border border-[var(--success)]/30 text-[var(--text-primary)] text-sm flex items-start gap-2.5"
            >
              <Icons.UserCheck className="w-5 h-5 text-[var(--success)] shrink-0 mt-0.5" />
              <span>{notice}</span>
            </div>
          )}

          {error && (
            <div
              role="alert"
              className="mb-4 p-3.5 rounded-xl bg-[var(--error-soft)] border border-[var(--error)]/30 text-[var(--error)] text-sm font-medium flex items-start gap-2.5"
            >
              <Icons.AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {mode === 'login' ? (
            <form onSubmit={handleLogin} className="space-y-4">
              <div>
                <label
                  htmlFor="login-username"
                  className="block text-sm font-semibold text-[var(--text-primary)] mb-1.5"
                >
                  اسم المستخدم
                </label>
                <input
                  id="login-username"
                  name="username"
                  type="text"
                  dir="ltr"
                  autoComplete="username"
                  autoCapitalize="none"
                  required
                  value={loginUsername}
                  onChange={(e) => setLoginUsername(e.target.value)}
                  placeholder="username"
                  className="rahhala-input w-full px-3.5 py-2.5 text-left"
                />
              </div>

              <div>
                <label
                  htmlFor="login-password"
                  className="block text-sm font-semibold text-[var(--text-primary)] mb-1.5"
                >
                  كلمة المرور
                </label>
                <div className="relative">
                  <input
                    id="login-password"
                    name="password"
                    type={showLoginPass ? 'text' : 'password'}
                    autoComplete="current-password"
                    required
                    value={loginPassword}
                    onChange={(e) => setLoginPassword(e.target.value)}
                    placeholder="••••••"
                    className="rahhala-input w-full px-3.5 py-2.5 pl-12"
                  />
                  <button
                    type="button"
                    onClick={() => setShowLoginPass((v) => !v)}
                    aria-label={showLoginPass ? 'إخفاء كلمة المرور' : 'إظهار كلمة المرور'}
                    className="absolute left-1 top-1/2 -translate-y-1/2 min-h-[40px] min-w-[40px] flex items-center justify-center text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                  >
                    {showLoginPass ? <Icons.EyeOff className="w-4 h-4" /> : <Icons.Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              <button
                type="submit"
                disabled={busy}
                className="w-full min-h-[46px] rounded-xl bg-[var(--accent)] text-[var(--accent-fg)] font-bold text-sm hover:bg-[var(--accent-hi)] transition-colors disabled:opacity-60"
              >
                {busy ? 'جاري التحقق...' : 'دخول'}
              </button>

              <p className="text-xs text-[var(--text-secondary)] text-center leading-relaxed pt-1">
                لو نسيت كلمة المرور، كلم المشرف لاستعادة الدخول.
              </p>

              <div className="pt-3 border-t border-[var(--divider)] text-center">
                <button
                  type="button"
                  onClick={() => {
                    setError(null);
                    setNotice(null);
                    setPendingCreated(false);
                    setMode('register');
                  }}
                  className="min-h-[44px] px-3 text-sm font-semibold text-[var(--accent)] hover:underline"
                >
                  أول مرة هنا؟ إنشاء حساب
                </button>
              </div>
            </form>
          ) : pendingCreated ? (
            <div className="space-y-4 text-center py-2">
              <p className="text-sm text-[var(--text-primary)] font-semibold">
                حسابك بانتظار موافقة المشرف.
              </p>
              <p className="text-xs text-[var(--text-secondary)]">
                أول ما المشرف يوافق على طلب انضمامك هتقدر تدخل باستخدام اسم المستخدم وكلمة المرور.
              </p>
              <button
                type="button"
                onClick={() => {
                  setPendingCreated(false);
                  setMode('login');
                }}
                className="w-full min-h-[44px] rounded-xl bg-[var(--accent)] text-[var(--accent-fg)] font-bold text-sm"
              >
                العودة لتسجيل الدخول
              </button>
            </div>
          ) : (
            <form onSubmit={handleRegister} className="space-y-3.5">
              <div>
                <label
                  htmlFor="reg-name"
                  className="block text-sm font-semibold text-[var(--text-primary)] mb-1"
                >
                  الاسم بالكامل
                </label>
                <input
                  id="reg-name"
                  type="text"
                  autoComplete="name"
                  required
                  minLength={2}
                  maxLength={60}
                  value={regName}
                  onChange={(e) => setRegName(e.target.value)}
                  placeholder="مثال: أحمد محمود حسن"
                  className="rahhala-input w-full px-3.5 py-2.5"
                />
              </div>

              <div>
                <label
                  htmlFor="reg-username"
                  className="block text-sm font-semibold text-[var(--text-primary)] mb-1"
                >
                  اسم المستخدم
                </label>
                <input
                  id="reg-username"
                  type="text"
                  dir="ltr"
                  autoComplete="username"
                  autoCapitalize="none"
                  required
                  minLength={3}
                  maxLength={30}
                  value={regUsername}
                  onChange={(e) => setRegUsername(e.target.value)}
                  placeholder="ahmed.mahmoud"
                  className="rahhala-input w-full px-3.5 py-2.5 text-left"
                />
                <p className="text-xs text-[var(--text-secondary)] mt-1">
                  من ٣ لـ ٣٠ حرفًا، بحروف إنجليزية صغيرة وأرقام والنقطة (.) والشرطة السفلية (_) فقط — ويُستخدم لتسجيل الدخول.
                </p>
              </div>

              <div>
                <label
                  htmlFor="reg-email"
                  className="block text-sm font-semibold text-[var(--text-primary)] mb-1"
                >
                  الإيميل
                </label>
                <input
                  id="reg-email"
                  type="email"
                  dir="ltr"
                  autoComplete="email"
                  required
                  maxLength={120}
                  value={regEmail}
                  onChange={(e) => setRegEmail(e.target.value)}
                  placeholder="student@example.com"
                  className="rahhala-input w-full px-3.5 py-2.5 text-left"
                />
                <p className="text-xs text-[var(--text-secondary)] mt-1">
                  يُحفظ سرًا لدى الإدارة فقط ولا يظهر لباقي الطلاب.
                </p>
              </div>

              <div>
                <label
                  htmlFor="reg-pass"
                  className="block text-sm font-semibold text-[var(--text-primary)] mb-1"
                >
                  كلمة المرور
                </label>
                <div className="relative">
                  <input
                    id="reg-pass"
                    type={showRegPass ? 'text' : 'password'}
                    autoComplete="new-password"
                    required
                    minLength={6}
                    maxLength={100}
                    value={regPassword}
                    onChange={(e) => setRegPassword(e.target.value)}
                    placeholder="٦ أحرف على الأقل"
                    className="rahhala-input w-full px-3.5 py-2.5 pl-12"
                  />
                  <button
                    type="button"
                    onClick={() => setShowRegPass((v) => !v)}
                    aria-label={showRegPass ? 'إخفاء كلمة المرور' : 'إظهار كلمة المرور'}
                    className="absolute left-1 top-1/2 -translate-y-1/2 min-h-[40px] min-w-[40px] flex items-center justify-center text-[var(--text-secondary)]"
                  >
                    {showRegPass ? <Icons.EyeOff className="w-4 h-4" /> : <Icons.Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              <div>
                <label
                  htmlFor="reg-confirm"
                  className="block text-sm font-semibold text-[var(--text-primary)] mb-1"
                >
                  تأكيد كلمة المرور
                </label>
                <input
                  id="reg-confirm"
                  type={showRegPass ? 'text' : 'password'}
                  autoComplete="new-password"
                  required
                  minLength={6}
                  maxLength={100}
                  value={regConfirm}
                  onChange={(e) => setRegConfirm(e.target.value)}
                  placeholder="أعد كتابة كلمة المرور"
                  className="rahhala-input w-full px-3.5 py-2.5"
                />
              </div>

              <button
                type="submit"
                disabled={busy}
                className="w-full min-h-[46px] rounded-xl bg-[var(--accent)] text-[var(--accent-fg)] font-bold text-sm hover:bg-[var(--accent-hi)] transition-colors disabled:opacity-60"
              >
                {busy ? 'جاري إرسال الطلب...' : 'إنشاء حساب'}
              </button>

              <div className="pt-3 border-t border-[var(--divider)] text-center">
                <button
                  type="button"
                  onClick={() => {
                    setError(null);
                    setNotice(null);
                    setMode('login');
                  }}
                  className="min-h-[44px] px-3 text-sm font-semibold text-[var(--accent)] hover:underline"
                >
                  عندك حساب بالفعل؟ تسجيل الدخول
                </button>
              </div>
            </form>
          )}
        </div>

        {config.previewDemoEnabled && (
          <div className="mt-5 rahhala-card p-4 border-dashed">
            <div className="text-xs font-bold text-[var(--accent)] mb-1">
              معاينة محلية تجريبية (بيئة التطوير فقط)
            </div>
            <p className="text-xs text-[var(--text-secondary)] mb-3">
              حسابات وهمية للمعاينة السريعة — غير مفعّلة في بيئة الإنتاج:
            </p>
            <div className="grid grid-cols-3 gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => handlePreviewLogin('tareq.owner')}
                className="min-h-[44px] px-2 py-2 rounded-xl bg-[var(--bg-surface)] text-xs font-semibold text-[var(--text-primary)] hover:border-[var(--accent)] border border-[var(--divider)]"
              >
                مالك تجريبي
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => handlePreviewLogin('salma.admin')}
                className="min-h-[44px] px-2 py-2 rounded-xl bg-[var(--bg-surface)] text-xs font-semibold text-[var(--text-primary)] hover:border-[var(--accent)] border border-[var(--divider)]"
              >
                مشرف تجريبي
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => handlePreviewLogin('youssef.member')}
                className="min-h-[44px] px-2 py-2 rounded-xl bg-[var(--bg-surface)] text-xs font-semibold text-[var(--text-primary)] hover:border-[var(--accent)] border border-[var(--divider)]"
              >
                عضو تجريبي
              </button>
            </div>
          </div>
        )}
      </motion.div>
    </div>
  );
}
