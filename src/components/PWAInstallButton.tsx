import React, { useState } from 'react';
import { usePWAInstall } from '../hooks/usePWAInstall';
import { Icons } from './Icons';
import { ModalShell } from './UI';

export function PWAInstallButton() {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showIOSGuide, setShowIOSGuide] = useState(false);

  if (isInstalled) return null;

  if (isInstallable) {
    return (
      <button
        type="button"
        onClick={install}
        className="min-h-[40px] px-3 rounded-xl bg-[var(--accent-soft)] border border-[var(--accent)]/30 text-[var(--accent)] text-xs font-bold flex items-center gap-1.5 whitespace-nowrap shrink-0"
      >
        <Icons.Download className="w-3.5 h-3.5" />
        <span>تثبيت التطبيق</span>
      </button>
    );
  }

  if (isIOS) {
    return (
      <>
        <button
          type="button"
          onClick={() => setShowIOSGuide(true)}
          className="min-h-[40px] px-3 rounded-xl bg-[var(--bg-surface)] border border-[var(--divider)] text-[var(--text-primary)] text-xs font-semibold flex items-center gap-1.5 whitespace-nowrap shrink-0"
        >
          <Icons.Download className="w-3.5 h-3.5" />
          <span>تثبيت</span>
        </button>

        <ModalShell
          open={showIOSGuide}
          onClose={() => setShowIOSGuide(false)}
          title="تثبيت رَحّالَة على آيفون وآيباد"
          maxWidth="max-w-sm"
        >
          <ol className="space-y-2.5 text-sm text-[var(--text-primary)] list-decimal list-inside">
            <li>افتح قائمة المشاركة (Share) من شريط Safari بالأسفل.</li>
            <li>اختر «إضافة إلى الشاشة الرئيسية» (Add to Home Screen).</li>
            <li>اضغط «إضافة» لتشغيل رَحّالَة كتطبيق مستقل.</li>
          </ol>
        </ModalShell>
      </>
    );
  }

  return null;
}

export function PWAStatusBanners({ isOnline }: { isOnline: boolean }) {

  return (
    <>
      {!isOnline && (
        <div
          role="status"
          className="bg-[var(--error-soft)] border-b border-[var(--error)]/30 text-[var(--error)] px-4 py-2 text-xs font-bold text-center"
        >
          أنت غير متصل بالإنترنت حاليًا — لا يمكن إرسال الرسائل أو تعديل البيانات حتى عودة الاتصال.
        </div>
      )}


    </>
  );
}
