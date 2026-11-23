import React, { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { THEMES, type ThemeId } from '../../shared/types';
import { loadProtectedImage, peekProtectedImage } from '../lib/protectedImage';
import { getInitials } from '../lib/formatters';
import { downloadProtectedAsset } from '../lib/reliableDownload';
import { Icons } from './Icons';

export function useDialogAccessibility(isOpen: boolean, onClose: () => void) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    previousFocusRef.current = document.activeElement as HTMLElement | null;

    const timer = window.setTimeout(() => {
      const container = containerRef.current;
      if (!container) return;
      const focusable = container.querySelector<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      focusable?.focus();
    }, 10);

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key === 'Tab' && containerRef.current) {
        const els = Array.from(
          containerRef.current.querySelectorAll<HTMLElement>(
            'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
          )
        );
        if (els.length === 0) return;
        const first = els[0];
        const last = els[els.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('keydown', handleKeyDown);
      previousFocusRef.current?.focus();
    };
  }, [isOpen, onClose]);

  return containerRef;
}

export function ModalShell({
  open,
  onClose,
  title,
  children,
  maxWidth = 'max-w-md',
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  maxWidth?: string;
}) {
  const ref = useDialogAccessibility(open, onClose);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-md p-0 sm:p-4"
          role="dialog"
          aria-modal="true"
          aria-label={title}
          onClick={(e) => {
            if (e.target === e.currentTarget) onClose();
          }}
        >
          <motion.div
            ref={ref}
            initial={{ opacity: 0, scale: 0.98, y: 24 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98, y: 24 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            className={`rahhala-glass-panel w-full ${maxWidth} max-h-[88dvh] sm:max-h-[90dvh] rounded-t-3xl sm:rounded-[22px] rounded-b-none sm:rounded-b-[22px] flex flex-col overflow-hidden`}
          >
            {/* Mobile bottom-sheet drag indicator */}
            <div className="sm:hidden pt-2.5 pb-0.5 flex justify-center shrink-0" aria-hidden="true">
              <span className="w-10 h-1 rounded-full bg-[var(--divider)]" />
            </div>
            <div className="flex items-center justify-between gap-3 px-5 py-3.5 sm:py-4 border-b border-[var(--divider)] shrink-0">
              <h2 className="text-base sm:text-lg font-bold text-[var(--text-primary)] truncate">
                {title}
              </h2>
              <button
                type="button"
                onClick={onClose}
                aria-label="إغلاق"
                className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-surface)] transition-colors shrink-0"
              >
                <Icons.X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-4 sm:p-5 overflow-y-auto safe-bottom-nav">{children}</div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  message,
  confirmLabel = 'تأكيد',
  destructive = false,
  busy = false,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: string;
  confirmLabel?: string;
  destructive?: boolean;
  busy?: boolean;
}) {
  return (
    <ModalShell open={open} onClose={onClose} title={title} maxWidth="max-w-sm">
      <p className="text-sm text-[var(--text-secondary)] leading-relaxed mb-6">{message}</p>
      <div className="flex items-center justify-end gap-3">
        <button
          type="button"
          onClick={onClose}
          disabled={busy}
          className="min-h-[44px] px-4 py-2 rounded-xl text-sm font-semibold bg-[var(--bg-surface)] text-[var(--text-primary)] hover:opacity-90 disabled:opacity-50"
        >
          إلغاء
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={busy}
          className={`min-h-[44px] px-5 py-2 rounded-xl text-sm font-bold transition-opacity disabled:opacity-50 ${
            destructive
              ? 'bg-[var(--error)] text-white hover:opacity-90'
              : 'bg-[var(--accent)] text-[var(--accent-fg)] hover:bg-[var(--accent-hi)]'
          }`}
        >
          {busy ? 'جاري التنفيذ...' : confirmLabel}
        </button>
      </div>
    </ModalShell>
  );
}

export function ProtectedImage({
  assetId,
  alt,
  className = '',
  onClick,
}: {
  assetId: string;
  alt: string;
  className?: string;
  onClick?: () => void;
}) {
  const [src, setSrc] = useState<string | null>(() => peekProtectedImage(assetId));
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    setFailed(false);
    setSrc(peekProtectedImage(assetId));
    loadProtectedImage(assetId)
      .then((url) => {
        if (active) setSrc(url);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [assetId]);

  if (failed) {
    return (
      <div
        className={`flex flex-col items-center justify-center gap-1.5 bg-[var(--bg-surface)] text-[var(--text-secondary)] p-4 rounded-xl border border-[var(--divider)] ${className}`}
      >
        <Icons.Image className="w-6 h-6 opacity-70" />
        <span className="text-xs">تعذر تحميل الصورة</span>
      </div>
    );
  }

  if (!src) {
    return (
      <div
        className={`animate-pulse bg-[var(--bg-surface)] rounded-xl ${className}`}
        aria-label="جاري تحميل الصورة"
      />
    );
  }

  return (
    <img
      src={src}
      alt={alt}
      referrerPolicy="no-referrer"
      onClick={onClick}
      onError={() => setFailed(true)}
      decoding="async"
      className={className}
    />
  );
}

export function Avatar({
  name,
  assetId,
  size = 'md',
}: {
  name: string;
  assetId?: string | null;
  size?: 'sm' | 'md' | 'lg';
}) {
  const dims =
    size === 'lg' ? 'w-16 h-16 text-lg' : size === 'sm' ? 'w-8 h-8 text-xs' : 'w-10 h-10 text-sm';

  if (assetId) {
    return (
      <div className={`${dims} rounded-full overflow-hidden shrink-0 border border-[var(--divider)] bg-[var(--bg-surface)]`}>
        <ProtectedImage assetId={assetId} alt={name} className="w-full h-full object-cover" />
      </div>
    );
  }

  return (
    <div
      className={`${dims} rounded-full shrink-0 flex items-center justify-center font-bold bg-[var(--accent-soft)] text-[var(--accent)] border border-[var(--divider)] select-none`}
      aria-hidden="true"
    >
      {getInitials(name)}
    </div>
  );
}

export function ImageViewerModal({
  item,
  onClose,
}: {
  item: { assetId: string; filename: string; caption?: string; byteSize?: number } | null;
  onClose: () => void;
}) {
  const [downloading, setDownloading] = useState(false);
  const [fallbackUrl, setFallbackUrl] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const ref = useDialogAccessibility(Boolean(item), onClose);

  useEffect(() => {
    setErrorMsg(null);
    setDownloading(false);
    return () => {
      if (fallbackUrl) URL.revokeObjectURL(fallbackUrl);
    };
  }, [item, fallbackUrl]);

  if (!item) return null;

  const handleDownload = async () => {
    setDownloading(true);
    setErrorMsg(null);
    try {
      const res = await downloadProtectedAsset(item.assetId, item.filename, item.byteSize);
      setFallbackUrl(res.objectUrl);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'تعذر تحميل الصورة');
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-black/90 backdrop-blur-xs"
      role="dialog"
      aria-modal="true"
      aria-label="عارض الصور"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        className="flex flex-col h-full w-full max-w-5xl mx-auto p-4"
      >
        <div className="flex items-center justify-between gap-3 py-2 text-white">
          <button
            type="button"
            onClick={onClose}
            aria-label="إغلاق العارض"
            className="min-h-[44px] min-w-[44px] px-3 rounded-xl bg-white/10 hover:bg-white/20 flex items-center gap-2 text-sm font-semibold"
          >
            <Icons.X className="w-5 h-5" />
            <span>إغلاق</span>
          </button>

          <span dir="ltr" className="text-xs text-white/80 truncate max-w-[45vw]">
            {item.filename}
          </span>

          <div className="flex items-center gap-2">
            {fallbackUrl && (
              <a
                href={fallbackUrl}
                download={item.filename}
                className="min-h-[44px] px-4 rounded-xl bg-[var(--success)] text-white text-sm font-bold flex items-center gap-2"
              >
                <Icons.Download className="w-4 h-4" />
                <span>حفظ الملف</span>
              </a>
            )}
            <button
              type="button"
              onClick={handleDownload}
              disabled={downloading}
              className="min-h-[44px] px-4 rounded-xl bg-[var(--accent)] text-[var(--accent-fg)] text-sm font-bold flex items-center gap-2 disabled:opacity-60"
            >
              <Icons.Download className="w-4 h-4" />
              <span>{downloading ? 'جاري التحميل...' : 'تحميل'}</span>
            </button>
          </div>
        </div>

        {errorMsg && (
          <div className="mx-auto mb-2 px-4 py-2 rounded-xl bg-[var(--error)] text-white text-sm">
            {errorMsg}
          </div>
        )}

        <div className="flex-1 min-h-0 flex items-center justify-center p-2">
          <ProtectedImage
            assetId={item.assetId}
            alt={item.caption || item.filename}
            className="max-h-full max-w-full object-contain rounded-xl"
          />
        </div>

        {item.caption && (
          <p className="text-center text-sm text-white/90 py-3 max-w-2xl mx-auto">
            {item.caption}
          </p>
        )}
      </div>
    </div>
  );
}

export function ThemeModal({
  open,
  onClose,
  currentTheme,
  onSelectTheme,
}: {
  open: boolean;
  onClose: () => void;
  currentTheme: ThemeId;
  onSelectTheme: (t: ThemeId) => void;
}) {
  const previews: Record<ThemeId, { bg: string; card: string; accent: string }> = {
    dark: { bg: '#0C1622', card: '#14263C', accent: '#E3B23C' },
    light: { bg: '#F4F6F9', card: '#FFFFFF', accent: '#9A6B0A' },
    sepia: { bg: '#F2E9D5', card: '#FAF3E1', accent: '#8A5E1B' },
    'warm-night': { bg: '#1F1A15', card: '#2C251D', accent: '#E3B23C' },
  };

  return (
    <ModalShell open={open} onClose={onClose} title="مظهر التطبيق" maxWidth="max-w-md">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {THEMES.map((t) => {
          const active = currentTheme === t.id;
          const swatch = previews[t.id];
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => {
                onSelectTheme(t.id);
                onClose();
              }}
              className={`min-h-[76px] p-4 rounded-2xl border text-right flex items-center justify-between gap-3 transition-colors ${
                active
                  ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
                  : 'border-[var(--divider)] bg-[var(--bg-surface)] hover:border-[var(--accent)]'
              }`}
            >
              <div>
                <div className="font-bold text-sm text-[var(--text-primary)]">{t.label}</div>
                <div className="text-xs text-[var(--text-secondary)] mt-0.5">{t.description}</div>
              </div>
              <div
                className="w-10 h-10 rounded-xl shrink-0 border border-black/15 flex items-center justify-center"
                style={{ backgroundColor: swatch.bg }}
                aria-hidden="true"
              >
                <span
                  className="w-4 h-4 rounded-full"
                  style={{ backgroundColor: swatch.accent }}
                />
              </div>
            </button>
          );
        })}
      </div>
    </ModalShell>
  );
}

export function ErrorRetryPanel({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="rahhala-card p-6 text-center max-w-md mx-auto my-6">
      <div className="w-11 h-11 rounded-full bg-[var(--error-soft)] text-[var(--error)] flex items-center justify-center mx-auto mb-3">
        <Icons.AlertCircle className="w-5 h-5" />
      </div>
      <p className="text-sm font-semibold text-[var(--text-primary)] mb-4">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="min-h-[44px] px-5 py-2 rounded-xl bg-[var(--accent)] text-[var(--accent-fg)] text-sm font-bold inline-flex items-center gap-2 hover:bg-[var(--accent-hi)]"
      >
        <Icons.Refresh className="w-4 h-4" />
        <span>إعادة المحاولة</span>
      </button>
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  subtitle,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
}) {
  return (
    <div className="rahhala-card p-8 text-center">
      <div className="w-12 h-12 rounded-2xl bg-[var(--bg-surface)] text-[var(--accent)] flex items-center justify-center mx-auto mb-3">
        {icon}
      </div>
      <p className="font-bold text-sm text-[var(--text-primary)]">{title}</p>
      {subtitle && <p className="text-xs text-[var(--text-secondary)] mt-1.5">{subtitle}</p>}
    </div>
  );
}

export function SubjectGridSkeleton() {
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3.5" aria-hidden="true">
      {[1, 2, 3, 4].map((k) => (
        <div
          key={k}
          className="rahhala-card p-4 sm:p-5 min-h-[144px] flex flex-col justify-between animate-pulse"
        >
          <div className="flex items-start justify-between">
            <div className="w-11 h-11 rounded-2xl bg-[var(--bg-surface)]" />
            <div className="w-4 h-4 rounded bg-[var(--bg-surface)]" />
          </div>
          <div className="space-y-2 mt-4">
            <div className="h-4 w-3/4 rounded-md bg-[var(--bg-surface)]" />
            <div className="h-3 w-1/2 rounded-md bg-[var(--bg-surface)]/70" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function ChatMessagesSkeleton() {
  return (
    <div className="space-y-4 animate-pulse" aria-hidden="true">
      {[
        { own: false, w: 'w-3/5' },
        { own: true, w: 'w-2/3' },
        { own: false, w: 'w-1/2' },
        { own: true, w: 'w-3/4' },
      ].map((row, idx) => (
        <div key={idx} className={`flex items-end gap-2 ${row.own ? 'justify-start' : 'justify-end'}`}>
          {!row.own && <div className="w-8 h-8 rounded-full bg-[var(--bg-surface)] shrink-0" />}
          <div className={`${row.w} rounded-2xl p-3.5 bg-[var(--bg-surface)] space-y-2`}>
            <div className="h-3 w-24 rounded bg-[var(--bg-card)]" />
            <div className="h-3.5 w-full rounded bg-[var(--bg-card)]/80" />
            <div className="h-3 w-16 rounded bg-[var(--bg-card)]/60 mr-auto" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function DashboardSkeleton() {
  return (
    <div className="space-y-6 animate-pulse" aria-hidden="true">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="rahhala-card p-5 space-y-4">
          <div className="flex justify-between">
            <div className="space-y-2">
              <div className="h-4 w-40 rounded bg-[var(--bg-surface)]" />
              <div className="h-3 w-56 rounded bg-[var(--bg-surface)]/70" />
            </div>
            <div className="h-9 w-28 rounded-xl bg-[var(--bg-surface)]" />
          </div>
          <div className="h-[260px] rounded-2xl bg-[var(--bg-surface)]/65" />
        </div>
        <div className="rahhala-card p-5 space-y-4">
          <div className="space-y-2">
            <div className="h-4 w-36 rounded bg-[var(--bg-surface)]" />
            <div className="h-3 w-48 rounded bg-[var(--bg-surface)]/70" />
          </div>
          <div className="h-[260px] rounded-2xl bg-[var(--bg-surface)]/65" />
        </div>
      </div>
      <div className="rahhala-card p-5 space-y-3">
        <div className="h-4 w-44 rounded bg-[var(--bg-surface)]" />
        <div className="h-[280px] rounded-2xl bg-[var(--bg-surface)]/65" />
      </div>
    </div>
  );
}
