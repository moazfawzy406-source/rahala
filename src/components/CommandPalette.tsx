import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import type { MaterialSearchResult, SubjectRecord } from '../../shared/types';
import { apiRequest } from '../lib/api';
import { MATERIAL_KIND_LABELS } from '../lib/formatters';
import { Icons, SubjectIcon } from './Icons';
import { ModalShell } from './UI';

export type CommandNavTab = 'subjects' | 'dashboard' | 'majalis' | 'chat' | 'admin' | 'account';

interface PaletteItem {
  id: string;
  group: 'تنقل' | 'مواد' | 'محتوى ودروس' | 'إجراءات';
  title: string;
  subtitle?: string;
  shortcut?: string;
  icon: React.ReactNode;
  onSelect: () => void;
}

export function CommandPalette({
  open,
  onClose,
  isAdminOrOwner,
  onNavigateTab,
  onSelectSubject,
  onOpenReminders,
  onOpenThemeModal,
  onOpenShortcuts,
}: {
  open: boolean;
  onClose: () => void;
  isAdminOrOwner: boolean;
  onNavigateTab: (tab: CommandNavTab) => void;
  onSelectSubject: (subjectId: string | null) => void;
  onOpenReminders: () => void;
  onOpenThemeModal: () => void;
  onOpenShortcuts: () => void;
}) {
  const [query, setQuery] = useState('');
  const [subjects, setSubjects] = useState<SubjectRecord[]>([]);
  const [materials, setMaterials] = useState<MaterialSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setMaterials([]);
    setActiveIndex(0);
    const t = window.setTimeout(() => inputRef.current?.focus(), 20);
    apiRequest<{ subjects?: SubjectRecord[] }>('/api/resources/subjects', { background: true })
      .then((res) => setSubjects(Array.isArray(res?.subjects) ? res.subjects : []))
      .catch(() => {});
    return () => window.clearTimeout(t);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const trimmed = query.trim();
    if (!trimmed) {
      setMaterials([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const timer = window.setTimeout(() => {
      apiRequest<{ results?: MaterialSearchResult[] }>(
        `/api/resources/search?q=${encodeURIComponent(trimmed)}`,
        { background: true }
      )
        .then((res) => setMaterials(Array.isArray(res?.results) ? res.results : []))
        .catch(() => setMaterials([]))
        .finally(() => setSearching(false));
    }, 180);
    return () => window.clearTimeout(timer);
  }, [open, query]);

  const items = useMemo<PaletteItem[]>(() => {
    const q = query.trim().toLowerCase();

    const navList: PaletteItem[] = [
      {
        id: 'nav-subjects',
        group: 'تنقل',
        title: 'المواد الدراسية والرئيسية',
        subtitle: 'تصفح المواد والملخصات والروابط',
        shortcut: '1',
        icon: <Icons.BookOpen className="w-4 h-4 text-[var(--accent)]" />,
        onSelect: () => {
          onSelectSubject(null);
          onNavigateTab('subjects');
          onClose();
        },
      },
      {
        id: 'nav-dashboard',
        group: 'تنقل',
        title: 'لوحة الإنجاز والتحديات',
        subtitle: 'ساعات المذاكرة، أوقات الذروة، والتحديات الجماعية',
        shortcut: '2',
        icon: <Icons.BarChart className="w-4 h-4 text-[var(--accent)]" />,
        onSelect: () => {
          onNavigateTab('dashboard');
          onClose();
        },
      },
      {
        id: 'nav-majalis',
        group: 'تنقل',
        title: 'مجالس المذاكرة',
        subtitle: 'غرف الصوت والفيديو والمذاكرة المشتركة',
        shortcut: '3',
        icon: <Icons.Video className="w-4 h-4 text-[var(--accent)]" />,
        onSelect: () => {
          onNavigateTab('majalis');
          onClose();
        },
      },
      {
        id: 'nav-chat',
        group: 'تنقل',
        title: 'محادثة الدفعة',
        subtitle: 'الإعلانات، الأسئلة، والدردشة العامة',
        shortcut: '4',
        icon: <Icons.MessageSquare className="w-4 h-4 text-[var(--accent)]" />,
        onSelect: () => {
          onNavigateTab('chat');
          onClose();
        },
      },
      ...(isAdminOrOwner
        ? [
            {
              id: 'nav-admin',
              group: 'تنقل' as const,
              title: 'لوحة الإدارة',
              subtitle: 'طلبات الانضمام، المواد، وإعدادات المنصة',
              icon: <Icons.Shield className="w-4 h-4 text-[var(--accent)]" />,
              onSelect: () => {
                onNavigateTab('admin');
                onClose();
              },
            },
          ]
        : []),
      {
        id: 'nav-account',
        group: 'تنقل',
        title: 'حسابي وتخصيص التنبيهات',
        subtitle: 'الملف الشخصي، الأمان، وألوان ونغمات المواد',
        icon: <Icons.User className="w-4 h-4 text-[var(--accent)]" />,
        onSelect: () => {
          onNavigateTab('account');
          onClose();
        },
      },
    ];

    const actionList: PaletteItem[] = [
      {
        id: 'act-reminder',
        group: 'إجراءات',
        title: 'ضبط منبه مذاكرة جديد',
        subtitle: 'جدولة جلسة مذاكرة مع تنبيه مخصص للمادة',
        icon: <Icons.AlarmClock className="w-4 h-4 text-[var(--accent)]" />,
        onSelect: () => {
          onClose();
          onOpenReminders();
        },
      },
      {
        id: 'act-theme',
        group: 'إجراءات',
        title: 'تغيير مظهر التطبيق',
        subtitle: 'الوضع الليلي، النهاري، الورقي الدافئ، أو السكون',
        icon: <Icons.Palette className="w-4 h-4 text-[var(--accent)]" />,
        onSelect: () => {
          onClose();
          onOpenThemeModal();
        },
      },
      {
        id: 'act-shortcuts',
        group: 'إجراءات',
        title: 'اختصارات لوحة المفاتيح',
        subtitle: 'عرض كل الاختصارات السريعة للمنصة والمجالس',
        shortcut: '?',
        icon: <Icons.Info className="w-4 h-4 text-[var(--accent)]" />,
        onSelect: () => {
          onClose();
          onOpenShortcuts();
        },
      },
    ];

    const subjectItems: PaletteItem[] = subjects
      .filter((s) => !q || s.name.toLowerCase().includes(q))
      .map((s) => ({
        id: `subj-${s.id}`,
        group: 'مواد',
        title: s.name,
        subtitle: `${s.materialCount} محتوى · ${s.sectionCount} أقسام`,
        icon: <SubjectIcon name={s.iconName} className="w-4 h-4" />,
        onSelect: () => {
          onNavigateTab('subjects');
          onSelectSubject(s.id);
          onClose();
        },
      }));

    const materialItems: PaletteItem[] = materials.map((m) => ({
      id: `mat-${m.id}`,
      group: 'محتوى ودروس',
      title: m.title,
      subtitle: `${m.subjectName} · ${m.sectionLabel} · ${MATERIAL_KIND_LABELS[m.kind]}`,
      icon: <Icons.FileText className="w-4 h-4 text-[var(--accent)]" />,
      onSelect: () => {
        onNavigateTab('subjects');
        onSelectSubject(m.subjectId);
        onClose();
      },
    }));

    const filteredNav = q
      ? navList.filter(
          (item) =>
            item.title.toLowerCase().includes(q) ||
            (item.subtitle && item.subtitle.toLowerCase().includes(q))
        )
      : navList;

    const filteredActions = q
      ? actionList.filter(
          (item) =>
            item.title.toLowerCase().includes(q) ||
            (item.subtitle && item.subtitle.toLowerCase().includes(q))
        )
      : actionList;

    return [...materialItems, ...subjectItems, ...filteredNav, ...filteredActions];
  }, [
    query,
    subjects,
    materials,
    isAdminOrOwner,
    onNavigateTab,
    onSelectSubject,
    onClose,
    onOpenReminders,
    onOpenThemeModal,
    onOpenShortcuts,
  ]);

  useEffect(() => {
    setActiveIndex(0);
  }, [items.length, query]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((idx) => (items.length === 0 ? 0 : (idx + 1) % items.length));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((idx) => (items.length === 0 ? 0 : (idx - 1 + items.length) % items.length));
    } else if (e.key === 'Enter' && items[activeIndex]) {
      e.preventDefault();
      items[activeIndex].onSelect();
    }
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.14 }}
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 backdrop-blur-sm p-3 sm:pt-20"
          role="dialog"
          aria-modal="true"
          aria-label="البحث والأوامر السريعة"
          onClick={(e) => {
            if (e.target === e.currentTarget) onClose();
          }}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.97, y: -8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: -8 }}
            transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
            onKeyDown={handleKeyDown}
            className="rahhala-glass-panel w-full max-w-xl overflow-hidden shadow-2xl"
          >
            <div className="flex items-center gap-2.5 px-4 py-3 border-b border-[var(--divider)]">
              <Icons.Search className="w-5 h-5 text-[var(--accent)] shrink-0" />
              <input
                ref={inputRef}
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="ابحث عن مادة، ملخص، محاضرة، أو انتقل لقسم…"
                className="flex-1 bg-transparent text-sm sm:text-base text-[var(--text-primary)] placeholder:text-[var(--text-secondary)] focus:outline-none min-h-[36px]"
              />
              {searching && (
                <span className="text-xs text-[var(--text-secondary)] shrink-0">جاري البحث…</span>
              )}
              <button
                type="button"
                onClick={onClose}
                className="px-2 py-1 rounded-lg bg-[var(--bg-surface)] text-xs font-bold text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              >
                Esc
              </button>
            </div>

            <div className="max-h-[62dvh] overflow-y-auto p-2 space-y-1">
              {items.length === 0 ? (
                <div className="py-10 text-center text-sm text-[var(--text-secondary)]">
                  لا توجد نتائج مطابقة لـ «{query}»
                </div>
              ) : (
                items.map((item, idx) => {
                  const isActive = idx === activeIndex;
                  const showGroup = idx === 0 || items[idx - 1].group !== item.group;
                  return (
                    <React.Fragment key={item.id}>
                      {showGroup && (
                        <div className="px-3 pt-2 pb-1 text-xs font-bold text-[var(--text-secondary)]">
                          {item.group}
                        </div>
                      )}
                      <button
                        type="button"
                        onMouseEnter={() => setActiveIndex(idx)}
                        onClick={item.onSelect}
                        className={`w-full min-h-[46px] px-3 py-2 rounded-xl flex items-center justify-between gap-3 text-right transition-colors ${
                          isActive
                            ? 'bg-[var(--accent-soft)] text-[var(--text-primary)]'
                            : 'hover:bg-[var(--bg-surface)]/70 text-[var(--text-primary)]'
                        }`}
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <span className="w-8 h-8 rounded-lg bg-[var(--bg-surface)] border border-[var(--divider)] flex items-center justify-center shrink-0">
                            {item.icon}
                          </span>
                          <div className="min-w-0">
                            <div className="text-sm font-bold truncate">{item.title}</div>
                            {item.subtitle && (
                              <div className="text-xs text-[var(--text-secondary)] truncate">
                                {item.subtitle}
                              </div>
                            )}
                          </div>
                        </div>
                        {item.shortcut ? (
                          <kbd
                            dir="ltr"
                            className="px-2 py-0.5 rounded-md bg-[var(--bg-surface)] border border-[var(--divider)] text-xs font-bold text-[var(--text-secondary)] shrink-0"
                          >
                            {item.shortcut}
                          </kbd>
                        ) : (
                          <Icons.ChevronLeft className="w-4 h-4 text-[var(--text-secondary)] shrink-0" />
                        )}
                      </button>
                    </React.Fragment>
                  );
                })
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export function KeyboardShortcutsModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const shortcuts = [
    { keys: 'Ctrl / ⌘ + K', desc: 'فتح البحث الشامل والأوامر السريعة' },
    { keys: '?', desc: 'عرض اختصارات لوحة المفاتيح' },
    { keys: 'M', desc: 'كتم أو فتح الميكروفون داخل المجلس' },
    { keys: 'V', desc: 'إغلاق أو تشغيل الكاميرا داخل المجلس' },
    { keys: 'H', desc: 'رفع أو خفض اليد داخل المجلس' },
    { keys: 'Esc', desc: 'إغلاق النوافذ والقوائم المنبثقة' },
  ];

  return (
    <ModalShell open={open} onClose={onClose} title="اختصارات لوحة المفاتيح" maxWidth="max-w-md">
      <div className="divide-y divide-[var(--divider)]">
        {shortcuts.map((s) => (
          <div key={s.keys} className="py-3 first:pt-1 last:pb-1 flex items-center justify-between gap-3">
            <span className="text-sm font-semibold text-[var(--text-primary)]">{s.desc}</span>
            <kbd
              dir="ltr"
              className="px-2.5 py-1 rounded-lg bg-[var(--bg-surface)] border border-[var(--divider)] text-xs font-bold text-[var(--accent)] shrink-0"
            >
              {s.keys}
            </kbd>
          </div>
        ))}
      </div>
    </ModalShell>
  );
}
