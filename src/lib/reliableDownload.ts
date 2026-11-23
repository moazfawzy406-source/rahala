import { fetchAssetAccessUrl } from './api';

export interface ReliableDownloadResult {
  objectUrl: string;
  filename: string;
  byteSize: number;
  mime: string;
}

const TIMEOUT_MS = 45_000;

export async function downloadProtectedAsset(
  assetId: string,
  expectedFilename: string,
  expectedByteSize?: number,
  externalSignal?: AbortSignal
): Promise<ReliableDownloadResult> {
  let retriedOnce = false;

  async function attempt(): Promise<ReliableDownloadResult> {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), TIMEOUT_MS);
    const onExternalAbort = () => controller.abort();
    externalSignal?.addEventListener('abort', onExternalAbort);

    try {
      const url = await fetchAssetAccessUrl(assetId, { download: true });
      const res = await fetch(url, {
        method: 'GET',
        credentials: 'include',
        signal: controller.signal,
      });

      if ((res.status === 401 || res.status === 403) && !retriedOnce) {
        retriedOnce = true;
        return attempt();
      }

      if (!res.ok) {
        let serverMessage = 'تعذر تحميل الملف من الخادم';
        const ct = res.headers.get('content-type') || '';
        if (ct.includes('application/json')) {
          const json = await res.json().catch(() => null);
          if (json && typeof json.error === 'string') {
            serverMessage = json.error;
          }
        }
        throw new Error(serverMessage);
      }

      const contentType = (res.headers.get('content-type') || '').toLowerCase();
      // Never save a JSON or HTML error response under a document filename!
      if (contentType.includes('application/json') || contentType.includes('text/html')) {
        throw new Error('استجابة غير صالحة بدلًا من الملف المطلوب، أعد المحاولة');
      }

      const headerLen = res.headers.get('content-length');
      const declaredSize = headerLen ? Number(headerLen) : expectedByteSize ?? null;

      const buffer = await res.arrayBuffer();
      if (buffer.byteLength === 0) {
        throw new Error('وصل الملف فارغًا، أعد المحاولة');
      }
      if (declaredSize && Number.isFinite(declaredSize) && buffer.byteLength !== declaredSize) {
        throw new Error('انقطع التحميل قبل اكتمال حجم الملف، أعد المحاولة');
      }

      const blob = new Blob([buffer], { type: contentType || 'application/octet-stream' });
      const objectUrl = URL.createObjectURL(blob);

      // Trigger browser download while also returning objectUrl for visible fallback ("حفظ الملف")
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = expectedFilename;
      anchor.rel = 'noopener';
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);

      return {
        objectUrl,
        filename: expectedFilename,
        byteSize: buffer.byteLength,
        mime: contentType,
      };
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new Error('انتهت مهلة التحميل أو تم إلغاؤه');
      }
      throw err instanceof Error ? err : new Error('فشل تحميل الملف');
    } finally {
      window.clearTimeout(timer);
      externalSignal?.removeEventListener('abort', onExternalAbort);
    }
  }

  return attempt();
}
