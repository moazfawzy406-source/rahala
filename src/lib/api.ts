export class ApiError extends Error {
  status: number;
  code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

let onUnauthorizedCallback: ((message: string) => void) | null = null;
const SESSION_STORAGE_KEY = 'rahhala_session_token';
let memorySessionToken: string | null = null;

export function getStoredSessionToken(): string | null {
  if (memorySessionToken) return memorySessionToken;
  try {
    const stored = window.sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (stored) {
      memorySessionToken = stored;
      return stored;
    }
  } catch {
    // Ignore restricted storage
  }
  return null;
}

export function setStoredSessionToken(token: string | null): void {
  memorySessionToken = token;
  try {
    if (token) {
      window.sessionStorage.setItem(SESSION_STORAGE_KEY, token);
    } else {
      window.sessionStorage.removeItem(SESSION_STORAGE_KEY);
    }
  } catch {
    // Ignore restricted storage
  }
}

export function getAuthRequestHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'X-Rahhala-CSRF': '1',
  };
  const token = getStoredSessionToken();
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return headers;
}

export function setUnauthorizedHandler(cb: ((message: string) => void) | null): void {
  onUnauthorizedCallback = cb;
}

export async function apiRequest<T>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    background?: boolean;
    signal?: AbortSignal;
    skipUnauthorizedHandler?: boolean;
  } = {}
): Promise<T> {
  const method = options.method ?? 'GET';
  const url = options.background
    ? `${path}${path.includes('?') ? '&' : '?'}background=1`
    : path;

  const headers: Record<string, string> = getAuthRequestHeaders();
  if (options.background) {
    headers['X-Rahhala-Background'] = '1';
  }
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(url, {
    method,
    credentials: 'include',
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    signal: options.signal,
  });

  const contentType = res.headers.get('content-type') || '';
  const isJson = contentType.toLowerCase().includes('application/json');
  const data = isJson ? await res.json().catch(() => null) : null;

  if (!res.ok) {
    const errMsg =
      typeof data?.error === 'string' && data.error
        ? data.error
        : 'تعذر إتمام الطلب، حاول مرة أخرى';
    if (res.status === 401 && !options.skipUnauthorizedHandler) {
      setStoredSessionToken(null);
      if (onUnauthorizedCallback) {
        onUnauthorizedCallback(errMsg);
      }
    }
    throw new ApiError(errMsg, res.status, typeof data?.code === 'string' ? data.code : undefined);
  }

  if (res.status === 204) {
    return {} as T;
  }

  if (!isJson || data === null || typeof data !== 'object') {
    throw new ApiError('تعذر قراءة استجابة الخادم، أعد المحاولة', res.status || 502);
  }

  return data as T;
}

export async function uploadAssetBinary(
  blob: Blob,
  filename: string,
  purpose: 'chat_file' | 'chat_audio' | 'avatar',
  signal?: AbortSignal
): Promise<{
  assetId: string;
  kind: 'image' | 'pdf' | 'audio' | 'office' | 'avatar';
  mime: string;
  filename: string;
  byteSize: number;
}> {
  const res = await fetch('/api/assets/upload', {
    method: 'POST',
    credentials: 'include',
    headers: {
      ...getAuthRequestHeaders(),
      'X-Rahhala-Purpose': purpose,
      'X-Rahhala-Filename': encodeURIComponent(filename),
      'Content-Type': 'application/octet-stream',
    },
    body: blob,
    signal,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) {
      setStoredSessionToken(null);
      if (onUnauthorizedCallback) {
        onUnauthorizedCallback(data?.error || 'انتهت الجلسة');
      }
    }
    throw new ApiError(
      data?.error || 'تعذر رفع الملف، تأكد من النوع والحجم',
      res.status
    );
  }
  return data.asset;
}

export async function fetchAssetAccessUrl(
  assetId: string,
  options: { download?: boolean } = {}
): Promise<string> {
  const res = await apiRequest<{ token: string }>(`/api/assets/${encodeURIComponent(assetId)}/access-token`, {
    method: 'POST',
  });
  const params = new URLSearchParams({ token: res.token });
  if (options.download) params.set('download', '1');
  return `/api/assets/${encodeURIComponent(assetId)}/content?${params.toString()}`;
}
