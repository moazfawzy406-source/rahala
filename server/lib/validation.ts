import { z } from 'zod';

export const USERNAME_REGEX = /^[a-z0-9._]{3,30}$/;

export function normalizeUsername(raw: string): string {
  return raw.trim().toLowerCase();
}

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export const displayNameSchema = z
  .string()
  .trim()
  .min(2, 'الاسم لازم يكون حرفين على الأقل')
  .max(60, 'الاسم بحد أقصى ٦٠ حرفًا');

export const usernameSchema = z
  .string()
  .transform(normalizeUsername)
  .refine(
    (v) => USERNAME_REGEX.test(v),
    'اسم المستخدم لازم يكون من ٣ لـ ٣٠ حرفًا، باستخدام حروف إنجليزية وأرقام والنقطة (.) والشرطة السفلية (_) فقط'
  );

export const emailSchema = z
  .string()
  .trim()
  .max(120, 'البريد الإلكتروني بحد أقصى ١٢٠ حرفًا')
  .transform(normalizeEmail)
  .refine((v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), 'اكتب بريد إلكتروني صحيح');

export const passwordSchema = z
  .string()
  .min(6, 'كلمة المرور لازم تكون ٦ أحرف على الأقل')
  .max(100, 'كلمة المرور بحد أقصى ١٠٠ حرف');

export const bioSchema = z
  .string()
  .trim()
  .max(160, 'النبذة التعريفية بحد أقصى ١٦٠ حرفًا');

export function isSafeHttpUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }
    if (!parsed.hostname || parsed.hostname.length > 253) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export const safeUrlSchema = z
  .string()
  .trim()
  .min(8, 'اكتب رابطًا صحيحًا يبدأ بـ https:// أو http://')
  .max(2000, 'الرابط طويل جدًا')
  .refine(isSafeHttpUrl, 'الرابط غير مسموح به — لازم يبدأ بـ https:// أو http:// فقط');

export function sanitizeFilename(rawName: string, fallbackExt = ''): string {
  const cleaned = rawName
    .replace(/[\u0000-\u001F\u007F\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  const base = cleaned.slice(0, 140) || `file${fallbackExt}`;
  if (fallbackExt && !base.toLowerCase().endsWith(fallbackExt.toLowerCase())) {
    return `${base}${fallbackExt}`;
  }
  return base;
}

export function buildContentDisposition(filename: string, inline = false): string {
  const disposition = inline ? 'inline' : 'attachment';
  const asciiFallback = filename
    .replace(/[^\x20-\x7E]/g, '_')
    .replace(/["\\;]/g, '_')
    .trim() || 'download';
  const encoded = encodeURIComponent(filename).replace(
    /['()*!]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return `${disposition}; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}
