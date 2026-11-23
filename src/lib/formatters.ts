import React from 'react';
import type { MaterialKind } from '../../shared/types';

export function formatClockTime(ts: number): string {
  return new Intl.DateTimeFormat('ar-EG', {
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(ts));
}

export function formatFullDate(ts: number): string {
  return new Intl.DateTimeFormat('ar-EG', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(new Date(ts));
}

export function formatDateTime(ts: number): string {
  return new Intl.DateTimeFormat('ar-EG', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(ts));
}

export function getDayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

export function formatDaySeparator(ts: number): string {
  const now = new Date();
  const target = new Date(ts);
  const todayKey = getDayKey(now.getTime());
  const yest = new Date(now);
  yest.setDate(now.getDate() - 1);
  const yesterdayKey = getDayKey(yest.getTime());
  const targetKey = getDayKey(target.getTime());

  if (targetKey === todayKey) return 'اليوم';
  if (targetKey === yesterdayKey) return 'أمس';
  return formatFullDate(ts);
}

export function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} بايت`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} ك.ب`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} م.ب`;
}

export function formatDurationSeconds(sec: number): string {
  const total = Math.max(0, Math.floor(sec));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export const MATERIAL_KIND_LABELS: Record<MaterialKind, string> = {
  pdf: 'ملف PDF',
  video: 'فيديو',
  doc: 'مستند',
  drive: 'درايف',
  telegram: 'تليجرام',
  link: 'رابط ويب',
};

/**
 * Safely linkifies http/https URLs into React elements without ever using dangerouslySetInnerHTML.
 */
export function renderLinkifiedText(text: string): React.ReactNode[] {
  const urlRegex = /(https?:\/\/[^\s<>"{}|\\^`[\]]+)/gi;
  const parts = text.split(urlRegex);
  return parts.map((part, idx) => {
    if (idx % 2 === 1 && /^https?:\/\//i.test(part)) {
      return React.createElement(
        'a',
        {
          key: idx,
          href: part,
          target: '_blank',
          rel: 'noopener noreferrer nofollow',
          dir: 'ltr',
          className:
            'underline underline-offset-4 break-all text-[var(--accent-hi)] hover:opacity-85 inline-block',
        },
        part
      );
    }
    return React.createElement(React.Fragment, { key: idx }, part);
  });
}

export function getInitials(name: string): string {
  const clean = name.trim();
  if (!clean) return '؟';
  const words = clean.split(/\s+/);
  if (words.length >= 2) {
    return `${words[0][0] || ''}${words[1][0] || ''}`;
  }
  return clean.slice(0, 2);
}
