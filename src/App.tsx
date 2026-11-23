import React, { Suspense, lazy, useCallback, useEffect, useState } from 'react';
import { AnimatePresence, MotionConfig, motion } from 'motion/react';
import {
  ROLE_LABELS,
  type AppPublicConfig,
  type AuthUser,
  type ChannelId,
} from '../shared/types';
import { AccountView } from './components/AccountView';
import { AdminView } from './components/AdminView';
import { AuthScreens } from './components/AuthScreens';
import { ChatView } from './components/ChatView';
import { HomeAndSubjects } from './components/HomeAndSubjects';
import { Icons, RahhalaBookMark } from './components/Icons';

const DashboardView = lazy(() =>
  import('./components/DashboardView').then((mod) => ({ default: mod.DashboardView }))
);
import {
  FloatingMajalisPanel,
  MajalisAudioBridge,
  MajalisView,
  useMajalisController,
} from './components/MajalisManager';
import { MembersAndMediaModal } from './components/MembersAndMediaModal';
import { PWAInstallButton, PWAStatusBanners } from './components/PWAInstallButton';
import { StudyAlarmBanner, StudyRemindersModal } from './components/StudyReminders';
import {
  Avatar,
  ErrorRetryPanel,
  ImageViewerModal,
  ThemeModal,
} from './components/UI';
import { useOnlineStatus } from './hooks/useOnlineStatus';
import { useStudyReminders } from './hooks/useStudyReminders';
import { useSubjectPreferences } from './hooks/useSubjectPreferences';
import { useTheme } from './hooks/useTheme';
import { ApiError, apiRequest, setStoredSessionToken, setUnauthorizedHandler } from './lib/api';

type NavTab = 'subjects' | 'dashboard' | 'majalis' | 'chat' | 'admin' | 'account';

const DEFAULT_CONFIG: AppPublicConfig = {
  brandName: 'رَحّالَة',
  tagline: 'كل ما تحتاجه لدراستك في مكان واحد',
  institutionSubtitle: 'كلية الدعوة الإسلامية - الأزهر الشريف',
  chatLocked: false,
  meetingMode: 'builtin',
  meetingExternalUrl: '',
  defaultRoomAccessType: 'open',
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
  emailRecoveryEnabled: false,
  previewDemoEnabled: false,
};

export default function App() {
  const { theme, setTheme } = useTheme();
  const isOnline = useOnlineStatus();

  const [config, setConfig] = useState<AppPublicConfig>(DEFAULT_CONFIG);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [bootLoading, setBootLoading] = useState(true);
  const [bootError, setBootError] = useState<string | null>(null);
  const [authNotice, setAuthNotice] = useState<string | null>(null);

  const [activeTab, setActiveTab] = useState<NavTab>('subjects');
  const [selectedSubjectId, setSelectedSubjectId] = useState<string | null>(null);
  const [resourcesRefreshKey, setResourcesRefreshKey] = useState(0);

  const [unreadCounts, setUnreadCounts] = useState<Record<ChannelId, number>>({
    announcements: 0,
    questions: 0,
    general: 0,
  });
  const [unreadTotal, setUnreadTotal] = useState(0);
  const [adminPendingCount, setAdminPendingCount] = useState(0);

  const [themeModalOpen, setThemeModalOpen] = useState(false);
  const [membersModalOpen, setMembersModalOpen] = useState(false);
  const [remindersModalOpen, setRemindersModalOpen] = useState(false);
  const [reminderSubjectId, setReminderSubjectId] = useState<string | null>(null);
  const [focusAlertSettings, setFocusAlertSettings] = useState(false);
  const [viewerImage, setViewerImage] = useState<{
    assetId: string;
    filename: string;
    caption?: string;
    byteSize?: number;
  } | null>(null);

  const [toast, setToast] = useState<{ msg: string; isError: boolean } | null>(null);

  const showToast = useCallback((msg: string, isError = false) => {
    setToast({ msg, isError });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 4000);
    return () => window.clearTimeout(id);
  }, [toast]);

  const forceLogoutWithMessage = useCallback((message: string) => {
    setStoredSessionToken(null);
    setUser(null);
    setSelectedSubjectId(null);
    setActiveTab('subjects');
    setAuthNotice(message);
  }, []);

  useEffect(() => {
    setUnauthorizedHandler((msg) => {
      forceLogoutWithMessage(msg);
    });
    return () => setUnauthorizedHandler(null);
  }, [forceLogoutWithMessage]);

  const loadPublicConfig = useCallback(async () => {
    try {
      const cfg = await apiRequest<AppPublicConfig>('/api/config', {
        skipUnauthorizedHandler: true,
      });
      setConfig(cfg);
    } catch {
      // keep fallback config
    }
  }, []);

  const bootstrapSession = useCallback(async () => {
    setBootLoading(true);
    setBootError(null);
    try {
      const [cfgRes, meRes] = await Promise.all([
        apiRequest<AppPublicConfig>('/api/config', { skipUnauthorizedHandler: true }),
        apiRequest<{ user: AuthUser }>('/api/auth/me', { skipUnauthorizedHandler: true }).catch(
          (err) => {
            if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
              return null;
            }
            throw err;
          }
        ),
      ]);
      setConfig(cfgRes);
      setUser(meRes ? meRes.user : null);
    } catch (err) {
      setBootError(err instanceof ApiError ? err.message : 'تعذر الاتصال بالخادم');
    } finally {
      setBootLoading(false);
    }
  }, []);

  useEffect(() => {
    void bootstrapSession();
  }, [bootstrapSession]);

  const refreshUnread = useCallback(async () => {
    if (!user) return;
    try {
      const res = await apiRequest<{
        counts: Record<ChannelId, number>;
        total: number;
      }>('/api/chat/unread', { background: true });
      setUnreadCounts(res.counts);
      setUnreadTotal(res.total);
    } catch {
      // ignore background error
    }
  }, [user]);

  const refreshAdminBadge = useCallback(async () => {
    if (!user || (user.role !== 'admin' && user.role !== 'owner')) {
      setAdminPendingCount(0);
      return;
    }
    try {
      const res = await apiRequest<{ totalPendingCount: number }>('/api/admin/requests', {
        background: true,
      });
      setAdminPendingCount(res.totalPendingCount);
    } catch {
      // ignore
    }
  }, [user]);

  const refreshCurrentUser = useCallback(async () => {
    try {
      const res = await apiRequest<{ user: AuthUser }>('/api/auth/me', { background: true });
      setUser(res.user);
    } catch {
      // handled by unauthorized callback if expired
    }
  }, []);

  useEffect(() => {
    if (!user) return;
    void refreshUnread();
    void refreshAdminBadge();
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        void refreshUnread();
        void refreshAdminBadge();
      }
    }, 30_000);
    return () => window.clearInterval(id);
  }, [user, refreshUnread, refreshAdminBadge]);

  const majalisController = useMajalisController(config, user, activeTab === 'majalis', showToast);
  const subjectPreferences = useSubjectPreferences(user, showToast);
  const studyReminders = useStudyReminders(user, showToast, subjectPreferences.getSubjectTone);

  const [pendingInviteRoomId, setPendingInviteRoomId] = useState<string | null>(() => {
    try {
      return new URLSearchParams(window.location.search).get('majlis')?.trim() || null;
    } catch {
      return null;
    }
  });

  useEffect(() => {
    if (!user || !pendingInviteRoomId) return;
    setActiveTab('majalis');
    const matched = majalisController.rooms.find((r) => r.id === pendingInviteRoomId);
    if (matched) {
      setPendingInviteRoomId(null);
      try {
        const nextUrl = new URL(window.location.href);
        nextUrl.searchParams.delete('majlis');
        window.history.replaceState({}, '', nextUrl.pathname + nextUrl.search);
      } catch {
        // ignore URL cleanup error
      }
      if (!majalisController.joined) {
        void majalisController.openPreJoin(matched.id);
      }
    }
  }, [user, pendingInviteRoomId, majalisController]);

  const openRemindersForSubject = useCallback((subjectId?: string | null) => {
    setReminderSubjectId(subjectId ?? null);
    setRemindersModalOpen(true);
  }, []);

  const openAlertSettings = useCallback(() => {
    setFocusAlertSettings(true);
    setActiveTab('account');
  }, []);

  // Clean up meeting media on logout
  const handleLoggedOut = useCallback(() => {
    if (majalisController.joined) {
      majalisController.leaveMeeting();
    }
    setStoredSessionToken(null);
    setUser(null);
    setSelectedSubjectId(null);
    setActiveTab('subjects');
    setAuthNotice(null);
  }, [majalisController]);

  const isAdminOrOwner = user?.role === 'admin' || user?.role === 'owner';

  // Ensure non-admins cannot remain on admin tab if demoted immediately
  useEffect(() => {
    if (user && !isAdminOrOwner && activeTab === 'admin') {
      setActiveTab('subjects');
    }
  }, [user, isAdminOrOwner, activeTab]);

  if (bootLoading) {
    return (
      <MotionConfig reducedMotion="user">
        <div className="min-h-dvh flex items-center justify-center p-6">
          <div className="text-center space-y-3">
            <div className="w-12 h-12 rounded-2xl bg-[var(--accent-soft)] text-[var(--accent)] flex items-center justify-center mx-auto animate-pulse">
              <RahhalaBookMark className="w-7 h-7" />
            </div>
            <p className="text-sm font-bold text-[var(--text-secondary)]">جاري تحميل رَحّالَة…</p>
          </div>
        </div>
      </MotionConfig>
    );
  }

  if (bootError) {
    return (
      <MotionConfig reducedMotion="user">
        <div className="min-h-dvh flex items-center justify-center p-4">
          <ErrorRetryPanel message={bootError} onRetry={bootstrapSession} />
        </div>
      </MotionConfig>
    );
  }

  if (!user) {
    return (
      <MotionConfig reducedMotion="user">
        <PWAStatusBanners isOnline={isOnline} />
        <AuthScreens
          config={config}
          initialNotice={authNotice}
          onAuthenticated={(authedUser) => {
            setAuthNotice(null);
            setUser(authedUser);
            setActiveTab('subjects');
          }}
          onOpenThemeModal={() => setThemeModalOpen(true)}
        />
        <ThemeModal
          open={themeModalOpen}
          onClose={() => setThemeModalOpen(false)}
          currentTheme={theme}
          onSelectTheme={setTheme}
        />
      </MotionConfig>
    );
  }

  const navItems: Array<{
    id: NavTab;
    label: string;
    mobileLabel?: string;
    icon: React.ReactNode;
    badge?: number;
  }> = [
    { id: 'subjects', label: 'المواد', icon: <Icons.BookOpen className="w-5 h-5" /> },
    {
      id: 'dashboard',
      label: 'لوحة الإنجاز',
      mobileLabel: 'الإنجاز',
      icon: <Icons.BarChart className="w-5 h-5" />,
    },
    { id: 'majalis', label: 'مجالس', icon: <Icons.Video className="w-5 h-5" /> },
    {
      id: 'chat',
      label: 'المحادثة',
      icon: <Icons.MessageSquare className="w-5 h-5" />,
      badge: unreadTotal,
    },
    ...(isAdminOrOwner
      ? [
          {
            id: 'admin' as const,
            label: 'الإدارة',
            icon: <Icons.Shield className="w-5 h-5" />,
            badge: adminPendingCount,
          },
        ]
      : []),
    { id: 'account', label: 'حسابي', icon: <Icons.User className="w-5 h-5" /> },
  ];

  const handleNavClick = (tab: NavTab) => {
    if (tab === 'subjects' && activeTab === 'subjects' && selectedSubjectId) {
      setSelectedSubjectId(null);
    }
    setActiveTab(tab);
  };

  const reminderBadgeCount =
    studyReminders.dueAlerts.length + studyReminders.activeReminders.length;

  return (
    <MotionConfig reducedMotion="user">
      <div className="min-h-dvh flex flex-col text-[var(--text-primary)]">
        <PWAStatusBanners isOnline={isOnline} />

        {/* In-App Study Alarm Banner */}
        <StudyAlarmBanner
          alerts={studyReminders.dueAlerts}
          getSubjectColor={subjectPreferences.getSubjectColor}
          getSubjectTone={subjectPreferences.getSubjectTone}
          onOpenSubject={(sid) => {
            setActiveTab('subjects');
            setSelectedSubjectId(sid);
          }}
          onSnooze={studyReminders.snoozeReminder}
          onComplete={studyReminders.completeReminder}
        />

        {/* Top Header */}
        <header className="sticky top-0 z-30 h-14 border-b border-[var(--glass-border)] bg-[var(--bg-nav)] backdrop-blur-xl px-3 sm:px-6 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2.5 min-w-0">
            {activeTab === 'subjects' && selectedSubjectId && (
              <button
                type="button"
                onClick={() => setSelectedSubjectId(null)}
                aria-label="رجوع"
                className="min-h-[40px] min-w-[40px] rounded-xl rahhala-glass-pill flex items-center justify-center md:hidden"
              >
                <Icons.ArrowRight className="w-4 h-4" />
              </button>
            )}
            <div className="w-9 h-9 rounded-xl bg-[var(--accent-soft)] text-[var(--accent)] flex items-center justify-center shrink-0 border border-[var(--glass-border)]">
              <RahhalaBookMark className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <div className="text-base font-extrabold text-[var(--accent)] leading-none truncate">
                {config.brandName}
              </div>
              {config.institutionSubtitle && (
                <div className="text-[11px] text-[var(--text-secondary)] truncate mt-0.5 hidden sm:block">
                  {config.institutionSubtitle}
                </div>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <PWAInstallButton />

            <button
              type="button"
              onClick={() => openRemindersForSubject(selectedSubjectId)}
              aria-label="منبه المذاكرة"
              className={`relative min-h-[40px] px-2.5 rounded-xl rahhala-glass-pill text-[var(--text-primary)] flex items-center justify-center gap-1.5 hover:border-[var(--accent)] transition-colors ${
                studyReminders.dueAlerts.length > 0 ? 'border-[var(--accent)] text-[var(--accent)]' : ''
              }`}
            >
              <Icons.AlarmClock className="w-4 h-4 text-[var(--accent)]" />
              {reminderBadgeCount > 0 && (
                <span className="text-xs font-extrabold text-[var(--accent)] tabular-nums">
                  {reminderBadgeCount}
                </span>
              )}
            </button>

            <button
              type="button"
              onClick={() => setThemeModalOpen(true)}
              aria-label="تغيير المظهر"
              className="min-h-[40px] min-w-[40px] rounded-xl rahhala-glass-pill text-[var(--text-primary)] flex items-center justify-center hover:border-[var(--accent)] transition-colors"
            >
              <Icons.Palette className="w-4 h-4" />
            </button>

            <button
              type="button"
              onClick={() => setActiveTab('account')}
              aria-label="فتح حسابي"
              className="min-h-[40px] pl-3 pr-1.5 py-1 rounded-xl rahhala-glass-pill hover:border-[var(--accent)] flex items-center gap-2 max-w-[160px] transition-colors"
            >
              <Avatar name={user.displayName} assetId={user.avatarAssetId} size="sm" />
              <div className="text-right min-w-0 hidden sm:block">
                <div className="text-xs font-bold text-[var(--text-primary)] truncate">
                  {user.displayName}
                </div>
                <div className="text-[10px] text-[var(--accent)] leading-none">
                  {ROLE_LABELS[user.role]}
                </div>
              </div>
            </button>
          </div>
        </header>

        {/* Main Shell: Desktop RTL Sidebar + Content */}
        <div className="flex-1 flex min-h-0">
          <aside
            aria-label="التنقل الرئيسي"
            className="hidden md:flex flex-col w-60 shrink-0 border-l border-[var(--glass-border)] bg-[var(--glass-bg)] backdrop-blur-xl p-3 gap-1.5"
          >
            {navItems.map((item) => {
              const active = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => handleNavClick(item.id)}
                  className={`relative min-h-[46px] px-3.5 rounded-xl flex items-center justify-between gap-2 text-sm font-bold transition-colors ${
                    active
                      ? 'text-[var(--accent)]'
                      : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-surface)]/50'
                  }`}
                >
                  {active && (
                    <motion.span
                      layoutId="desktop-nav-active"
                      transition={{ type: 'spring', stiffness: 420, damping: 34 }}
                      className="absolute inset-0 rounded-xl bg-[var(--accent-soft)] border border-[var(--accent)]/30"
                      aria-hidden="true"
                    />
                  )}
                  <span className="relative z-10 flex items-center gap-3">
                    {item.icon}
                    <span>{item.label}</span>
                  </span>
                  {typeof item.badge === 'number' && item.badge > 0 && (
                    <span className="relative z-10 text-xs font-extrabold text-[var(--accent)] tabular-nums">
                      {item.badge}
                    </span>
                  )}
                </button>
              );
            })}
          </aside>

          <main
            className={`flex-1 min-w-0 px-3 sm:px-6 py-4 sm:py-6 max-w-6xl mx-auto w-full ${
              activeTab === 'chat' ? 'pb-16 md:pb-6' : 'pb-24 md:pb-6'
            }`}
          >
            <AnimatePresence mode="wait">
              <motion.div
                key={activeTab === 'subjects' ? `subjects-${selectedSubjectId ?? 'home'}` : activeTab}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
              >
                {activeTab === 'subjects' && (
                  <HomeAndSubjects
                    user={user}
                    selectedSubjectId={selectedSubjectId}
                    onSelectSubject={setSelectedSubjectId}
                    onNavigateTab={setActiveTab}
                    refreshTrigger={resourcesRefreshKey}
                    unreadChatCount={unreadTotal}
                    nextReminder={studyReminders.nextReminder}
                    activeReminderCount={studyReminders.activeReminders.length}
                    nowTick={studyReminders.nowTick}
                    getSubjectColor={subjectPreferences.getSubjectColor}
                    onOpenReminders={openRemindersForSubject}
                    onToast={showToast}
                  />
                )}

                {activeTab === 'dashboard' && (
                  <Suspense
                    fallback={
                      <div className="rounded-2xl rahhala-glass-panel p-8 text-center text-sm font-bold text-[var(--text-secondary)]">
                        جاري تحميل لوحة الإنجاز…
                      </div>
                    }
                  >
                    <DashboardView
                      reminders={studyReminders.reminders}
                      remindersLoading={studyReminders.loading}
                      getSubjectColor={subjectPreferences.getSubjectColor}
                      onOpenReminders={openRemindersForSubject}
                      onOpenSubject={(sid) => {
                        setActiveTab('subjects');
                        setSelectedSubjectId(sid);
                      }}
                      onToast={showToast}
                    />
                  </Suspense>
                )}

                {activeTab === 'majalis' && (
                  <MajalisView
                    config={config}
                    user={user}
                    controller={majalisController}
                    onToast={showToast}
                  />
                )}

                {activeTab === 'chat' && (
                  <ChatView
                    user={user}
                    unreadByChannel={unreadCounts}
                    onUnreadRefresh={refreshUnread}
                    onOpenMembersAndMedia={() => setMembersModalOpen(true)}
                    onOpenImage={setViewerImage}
                    onToast={showToast}
                    onUserRefresh={refreshCurrentUser}
                    onForceLogout={forceLogoutWithMessage}
                  />
                )}

                {activeTab === 'admin' && isAdminOrOwner && (
                  <AdminView
                    user={user}
                    config={config}
                    onConfigUpdated={loadPublicConfig}
                    onResourcesUpdated={() => setResourcesRefreshKey((k) => k + 1)}
                    onToast={showToast}
                    onRequestsBadgeChange={setAdminPendingCount}
                  />
                )}

                {activeTab === 'account' && (
                  <AccountView
                    user={user}
                    onUserUpdated={setUser}
                    onLoggedOut={handleLoggedOut}
                    onToast={showToast}
                    preferencesMap={subjectPreferences.preferencesMap}
                    onSaveSubjectPreference={subjectPreferences.savePreference}
                    onResetSubjectPreference={subjectPreferences.resetPreference}
                    focusAlertSettings={focusAlertSettings}
                    onFocusHandled={() => setFocusAlertSettings(false)}
                  />
                )}
              </motion.div>
            </AnimatePresence>
          </main>
        </div>

        {/* Mobile Bottom Navigation */}
        <nav
          aria-label="التنقل السفلي"
          className="md:hidden fixed bottom-0 left-0 right-0 z-30 border-t border-[var(--glass-border)] bg-[var(--bg-nav)] backdrop-blur-xl safe-bottom-nav"
        >
        <div
          className="grid items-center h-14 px-1"
          style={{ gridTemplateColumns: `repeat(${navItems.length}, minmax(0, 1fr))` }}
        >
          {navItems.map((item) => {
            const active = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => handleNavClick(item.id)}
                className={`relative min-h-[44px] flex flex-col items-center justify-center gap-0.5 rounded-xl transition-colors ${
                  active ? 'text-[var(--accent)]' : 'text-[var(--text-secondary)]'
                }`}
              >
                <div className="relative">
                  {item.icon}
                  {typeof item.badge === 'number' && item.badge > 0 && (
                    <span className="absolute -top-1.5 -left-2.5 min-w-[16px] h-4 px-1 rounded-full bg-[var(--accent)] text-[var(--accent-fg)] text-[10px] font-extrabold flex items-center justify-center tabular-nums">
                      {item.badge > 99 ? '99+' : item.badge}
                    </span>
                  )}
                </div>
                <span className="text-[10px] sm:text-[11px] font-bold leading-none whitespace-nowrap">
                  {item.mobileLabel || item.label}
                </span>
              </button>
            );
          })}
        </div>
      </nav>

      {/* Always-mounted remote audio bridge so Majalis audio continues across tabs & listener mode */}
      <MajalisAudioBridge controller={majalisController} />

      {/* Minimized Floating Majalis Panel when browsing other tabs */}
      {activeTab !== 'majalis' && (
        <FloatingMajalisPanel
          controller={majalisController}
          onExpand={() => setActiveTab('majalis')}
        />
      )}

        {/* Toast Feedback */}
        <AnimatePresence>
          {toast && (
            <motion.div
              initial={{ opacity: 0, y: 12, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 10, scale: 0.96 }}
              transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
              role="status"
              className={`fixed bottom-20 md:bottom-6 left-1/2 -translate-x-1/2 z-50 px-4 py-2.5 rounded-xl text-xs sm:text-sm font-bold shadow-xl border max-w-[90vw] text-center backdrop-blur-xl ${
                toast.isError
                  ? 'bg-[var(--error)] text-white border-transparent'
                  : 'rahhala-glass-panel text-[var(--text-primary)] border-[var(--accent)]/40'
              }`}
            >
              {toast.msg}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Modals */}
        <StudyRemindersModal
          open={remindersModalOpen}
          onClose={() => setRemindersModalOpen(false)}
          initialSubjectId={reminderSubjectId}
          reminders={studyReminders.reminders}
          nowTick={studyReminders.nowTick}
          getSubjectColor={subjectPreferences.getSubjectColor}
          getSubjectTone={subjectPreferences.getSubjectTone}
          onOpenSettings={openAlertSettings}
          onCreate={studyReminders.createReminder}
          onSnooze={studyReminders.snoozeReminder}
          onComplete={studyReminders.completeReminder}
          onDelete={studyReminders.deleteReminder}
          onOpenSubject={(sid) => {
            setActiveTab('subjects');
            setSelectedSubjectId(sid);
          }}
        />

        <ThemeModal
          open={themeModalOpen}
          onClose={() => setThemeModalOpen(false)}
          currentTheme={theme}
          onSelectTheme={setTheme}
        />

        <MembersAndMediaModal
          open={membersModalOpen}
          onClose={() => setMembersModalOpen(false)}
          currentUser={user}
          onOpenImage={setViewerImage}
          onToast={showToast}
        />

        <ImageViewerModal item={viewerImage} onClose={() => setViewerImage(null)} />
      </div>
    </MotionConfig>
  );
}
