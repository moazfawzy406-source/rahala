import { useCallback, useEffect, useRef, useState } from 'react';
import { apiRequest } from '../lib/api';

export interface WsServerEvent {
  type: string;
  [key: string]: unknown;
}

export function useWebSocket(
  enabled: boolean,
  onEvent: (event: WsServerEvent) => void
) {
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  const sendJson = useCallback((payload: unknown) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
      return true;
    }
    return false;
  }, []);

  useEffect(() => {
    if (!enabled) {
      wsRef.current?.close();
      wsRef.current = null;
      setConnected(false);
      return;
    }

    let cancelled = false;
    let retryTimer: number | null = null;
    let retryDelay = 1000;

    async function connect() {
      if (cancelled) return;
      try {
        const { ticket } = await apiRequest<{ ticket: string }>('/api/auth/ws-ticket', {
          background: true,
        });
        if (cancelled) return;

        const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = new WebSocket(`${proto}//${window.location.host}/ws?ticket=${encodeURIComponent(ticket)}`);
        wsRef.current = ws;

        ws.onopen = () => {
          if (cancelled) {
            ws.close();
            return;
          }
          retryDelay = 1000;
          setConnected(true);
        };

        ws.onmessage = (ev) => {
          try {
            const parsed = JSON.parse(String(ev.data)) as WsServerEvent;
            onEventRef.current(parsed);
          } catch {
            // ignore malformed event
          }
        };

        ws.onclose = () => {
          setConnected(false);
          if (wsRef.current === ws) {
            wsRef.current = null;
          }
          if (!cancelled) {
            const delay = document.visibilityState === 'hidden' ? 8000 : retryDelay;
            retryDelay = Math.min(15000, retryDelay * 2);
            retryTimer = window.setTimeout(connect, delay);
          }
        };

        ws.onerror = () => {
          ws.close();
        };
      } catch {
        if (!cancelled) {
          retryTimer = window.setTimeout(connect, Math.min(15000, retryDelay));
          retryDelay = Math.min(15000, retryDelay * 2);
        }
      }
    }

    void connect();

    return () => {
      cancelled = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      wsRef.current?.close();
      wsRef.current = null;
      setConnected(false);
    };
  }, [enabled]);

  return { connected, sendJson };
}
