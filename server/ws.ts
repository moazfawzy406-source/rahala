import type { Server as HttpServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import type { RahhalaConfig } from './config.ts';
import type { RahhalaDb } from './db.ts';
import { getOrCreateSigningSecret } from './db.ts';
import { verifyShortToken } from './lib/crypto.ts';
import { canViewerAccessMessage } from './lib/historyAccess.ts';
import {
  extractSessionToken,
  resolveActiveSession,
} from './middleware/auth.ts';
import { randomUUID } from 'node:crypto';
import type {
  ChannelId,
  MajalisChatMessageRecord,
  MajalisParticipantInfo,
  MajalisParticipationMode,
  MajalisRoomSummary,
  MajalisTimerPhase,
  MajalisTimerState,
} from '../shared/types.ts';

const MAJALIS_TIMER_DURATIONS: Record<MajalisTimerPhase, number> = {
  focus: 25 * 60_000,
  review: 45 * 60_000,
  break: 5 * 60_000,
};

interface ClientMeta {
  ws: WebSocket;
  userId: string;
  sessionId: string;
  displayName: string;
  avatarAssetId: string | null;
  inMajalis: boolean;
  majalisRoomId: string | null;
  majalisMode: MajalisParticipationMode;
  micMuted: boolean;
  camOff: boolean;
  screenSharing: boolean;
  handRaised: boolean;
  majalisJoinedAt: number;
}

export interface RealtimeHub {
  broadcastMessageCreated: (messageId: number, channel: ChannelId) => void;
  broadcastMessageUpdated: (messageId: number, channel: ChannelId) => void;
  broadcastMessageRemoved: (messageId: number, channel: ChannelId) => void;
  broadcastReactionUpdated: (messageId: number, channel: ChannelId) => void;
  broadcastReceiptUpdated: (senderId: string, messageId: number) => void;
  broadcastTyping: (channel: ChannelId, userId: string, displayName: string, active: boolean) => void;
  broadcastChatLockChanged: (locked: boolean) => void;
  broadcastChallengesUpdated: () => void;
  getMajalisRoomsSnapshot: () => MajalisRoomSummary[];
  broadcastMajalisLobbyUpdated: () => void;
  broadcastMajalisRoomChat: (roomId: string, message: MajalisChatMessageRecord) => void;
  controlMajalisRoomTimer: (
    roomId: string,
    actorName: string,
    action: 'start' | 'pause' | 'reset' | 'preset',
    phase?: MajalisTimerPhase
  ) => MajalisTimerState | null;
  notifySessionRevoked: (sessionId: string) => void;
  notifyUserSessionsRevoked: (userId: string, exceptSessionId?: string) => void;
  notifyUserUpdated: (userId: string) => void;
  close: () => void;
}

export function setupWebSocketHub(
  server: HttpServer,
  db: RahhalaDb,
  config: RahhalaConfig
): RealtimeHub {
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set<ClientMeta>();
  const roomTimers = new Map<string, MajalisTimerState>();
  const signingSecret = getOrCreateSigningSecret(db);
  let isClosed = false;

  function defaultTimerState(phase: MajalisTimerPhase = 'focus'): MajalisTimerState {
    const durationMs = MAJALIS_TIMER_DURATIONS[phase];
    return {
      phase,
      durationMs,
      remainingMs: durationMs,
      running: false,
      startedAt: null,
      updatedByName: null,
    };
  }

  function resolveEffectiveTimer(roomId: string): MajalisTimerState {
    const raw = roomTimers.get(roomId) ?? defaultTimerState();
    if (!roomTimers.has(roomId)) {
      roomTimers.set(roomId, raw);
    }
    if (!raw.running || raw.startedAt === null) {
      return raw;
    }
    const elapsed = Math.max(0, Date.now() - raw.startedAt);
    const left = Math.max(0, raw.remainingMs - elapsed);
    if (left === 0) {
      const finished: MajalisTimerState = {
        ...raw,
        remainingMs: 0,
        running: false,
        startedAt: null,
      };
      roomTimers.set(roomId, finished);
      return finished;
    }
    return {
      ...raw,
      remainingMs: left,
    };
  }

  function getParticipantsForRoom(roomId: string): MajalisParticipantInfo[] {
    const byUser = new Map<string, MajalisParticipantInfo>();
    for (const c of clients) {
      if (c.inMajalis && c.majalisRoomId === roomId) {
        byUser.set(c.userId, {
          userId: c.userId,
          displayName: c.displayName,
          avatarAssetId: c.avatarAssetId,
          mode: c.majalisMode,
          micMuted: c.micMuted,
          camOff: c.camOff,
          screenSharing: c.screenSharing,
          handRaised: c.handRaised,
          joinedAt: c.majalisJoinedAt,
        });
      }
    }
    return Array.from(byUser.values()).sort((a, b) => a.joinedAt - b.joinedAt);
  }

  function getMajalisRoomsSnapshot(): MajalisRoomSummary[] {
    if (isClosed || !db.open) return [];
    const rows = db
      .prepare(
        `SELECT r.id, r.title, r.subject_id, r.subject_name_snapshot, s.accent_color AS subject_accent_color,
                r.creator_id, r.creator_name_snapshot, r.is_default, r.created_at
         FROM majalis_rooms r
         LEFT JOIN subjects s ON s.id = r.subject_id
         ORDER BY r.is_default DESC, r.created_at ASC`
      )
      .all() as Array<{
      id: string;
      title: string;
      subject_id: string | null;
      subject_name_snapshot: string;
      subject_accent_color: string | null;
      creator_id: string | null;
      creator_name_snapshot: string;
      is_default: number;
      created_at: number;
    }>;

    return rows.map((r) => {
      const participants = getParticipantsForRoom(r.id);
      return {
        id: r.id,
        title: r.title,
        subjectId: r.subject_id,
        subjectName: r.subject_name_snapshot,
        subjectColor: r.subject_accent_color || '#E3B23C',
        creatorId: r.creator_id,
        creatorName: r.creator_name_snapshot,
        isDefault: Boolean(r.is_default),
        createdAt: r.created_at,
        activeCount: participants.length,
        participants,
        timer: resolveEffectiveTimer(r.id),
      };
    });
  }

  server.on('upgrade', (request, socket, head) => {
    const urlStr = request.url || '';
    if (!urlStr.startsWith('/ws')) {
      return; // Let Vite or other handlers handle non-/ws upgrades
    }

    const url = new URL(urlStr, 'http://localhost');
    const ticket = url.searchParams.get('ticket');
    const fallbackSessionToken = extractSessionToken(request);

    let authedUserId: string | null = null;
    let authedSessionId: string | null = null;
    let authedDisplayName = '';
    let authedAvatarAssetId: string | null = null;

    if (ticket) {
      const verified = verifyShortToken<{ userId: string; sessionId: string; kind: string }>(
        ticket,
        signingSecret
      );
      if (verified && verified.kind === 'ws') {
        const s = db
          .prepare(
            `SELECT s.id, s.user_id, s.revoked_at, s.last_activity_at, s.expires_at,
                    u.display_name, u.avatar_asset_id, u.approval_status
             FROM sessions s
             JOIN users u ON u.id = s.user_id
             WHERE s.id = ? AND s.user_id = ?`
          )
          .get(verified.sessionId, verified.userId) as
          | {
              id: string;
              user_id: string;
              revoked_at: number | null;
              last_activity_at: number;
              expires_at: number;
              display_name: string;
              avatar_asset_id: string | null;
              approval_status: string;
            }
          | undefined;
        const now = Date.now();
        if (
          s &&
          s.revoked_at === null &&
          s.approval_status === 'approved' &&
          now <= s.expires_at &&
          now - s.last_activity_at <= config.sessionIdleMs
        ) {
          authedUserId = s.user_id;
          authedSessionId = s.id;
          authedDisplayName = s.display_name;
          authedAvatarAssetId = s.avatar_asset_id;
        }
      }
    } else if (fallbackSessionToken) {
      const resolved = resolveActiveSession(db, config, fallbackSessionToken, { touchActivity: false });
      if (resolved.ok) {
        authedUserId = resolved.data.user.id;
        authedSessionId = resolved.data.sessionId;
        authedDisplayName = resolved.data.user.displayName;
        authedAvatarAssetId = resolved.data.user.avatarAssetId;
      }
    }

    if (!authedUserId || !authedSessionId) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      const meta: ClientMeta = {
        ws,
        userId: authedUserId!,
        sessionId: authedSessionId!,
        displayName: authedDisplayName,
        avatarAssetId: authedAvatarAssetId,
        inMajalis: false,
        majalisRoomId: null,
        majalisMode: 'listener',
        micMuted: true,
        camOff: true,
        screenSharing: false,
        handRaised: false,
        majalisJoinedAt: 0,
      };
      clients.add(meta);
      wss.emit('connection', ws, request, meta);
    });
  });

  function sendJsonSafe(target: WebSocket, payload: unknown): void {
    if (target.readyState === WebSocket.OPEN) {
      target.send(JSON.stringify(payload));
    }
  }

  function broadcastLobbyState(): void {
    if (isClosed || !db.open) return;
    const rooms = getMajalisRoomsSnapshot();
    for (const client of clients) {
      sendJsonSafe(client.ws, { type: 'majalis:lobby_updated', rooms });
    }
  }

  function broadcastRoomState(roomId: string): void {
    const participants = getParticipantsForRoom(roomId);
    const timer = resolveEffectiveTimer(roomId);
    for (const client of clients) {
      if (client.inMajalis && client.majalisRoomId === roomId) {
        sendJsonSafe(client.ws, {
          type: 'majalis:room_state',
          roomId,
          participants,
          timer,
        });
      }
    }
  }

  function leaveCurrentMajalisRoom(meta: ClientMeta): void {
    if (!meta.inMajalis || !meta.majalisRoomId) return;
    const leftRoomId = meta.majalisRoomId;
    meta.inMajalis = false;
    meta.majalisRoomId = null;
    meta.screenSharing = false;
    meta.handRaised = false;

    const stillInRoomSameUser = Array.from(clients).some(
      (c) => c.inMajalis && c.majalisRoomId === leftRoomId && c.userId === meta.userId
    );
    if (!stillInRoomSameUser) {
      for (const client of clients) {
        if (client.inMajalis && client.majalisRoomId === leftRoomId && client.userId !== meta.userId) {
          sendJsonSafe(client.ws, {
            type: 'majalis:peer_left',
            roomId: leftRoomId,
            userId: meta.userId,
          });
        }
      }
    }

    broadcastRoomState(leftRoomId);
    broadcastLobbyState();
  }

  function controlRoomTimer(
    roomId: string,
    actorName: string,
    action: 'start' | 'pause' | 'reset' | 'preset',
    phase?: MajalisTimerPhase
  ): MajalisTimerState | null {
    const roomExists = db.prepare('SELECT 1 FROM majalis_rooms WHERE id = ?').get(roomId);
    if (!roomExists) return null;

    const now = Date.now();
    const current = resolveEffectiveTimer(roomId);
    let next: MajalisTimerState = { ...current, updatedByName: actorName };

    if (action === 'preset' && phase && phase in MAJALIS_TIMER_DURATIONS) {
      const dur = MAJALIS_TIMER_DURATIONS[phase];
      next = {
        phase,
        durationMs: dur,
        remainingMs: dur,
        running: false,
        startedAt: null,
        updatedByName: actorName,
      };
    } else if (action === 'start') {
      const rem = current.remainingMs > 0 ? current.remainingMs : current.durationMs;
      next = {
        ...current,
        remainingMs: rem,
        running: true,
        startedAt: now,
        updatedByName: actorName,
      };
    } else if (action === 'pause') {
      next = {
        ...current,
        running: false,
        startedAt: null,
        updatedByName: actorName,
      };
    } else if (action === 'reset') {
      next = {
        ...current,
        remainingMs: current.durationMs,
        running: false,
        startedAt: null,
        updatedByName: actorName,
      };
    }

    roomTimers.set(roomId, next);
    for (const client of clients) {
      if (client.inMajalis && client.majalisRoomId === roomId) {
        sendJsonSafe(client.ws, {
          type: 'majalis:timer_updated',
          roomId,
          timer: next,
        });
      }
    }
    broadcastRoomState(roomId);
    broadcastLobbyState();
    return next;
  }

  wss.on('connection', (ws: WebSocket, _req: unknown, meta: ClientMeta) => {
    sendJsonSafe(ws, { type: 'connected', userId: meta.userId });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as {
          type?: string;
          channel?: ChannelId;
          active?: boolean;
          targetUserId?: string;
          roomId?: string;
          mode?: MajalisParticipationMode;
          micMuted?: boolean;
          camOff?: boolean;
          screenSharing?: boolean;
          handRaised?: boolean;
          action?: 'start' | 'pause' | 'reset' | 'preset';
          phase?: MajalisTimerPhase;
          body?: string;
          signal?: unknown;
        };

        // Revalidate session/approval before acting
        const userRow = db
          .prepare('SELECT display_name, avatar_asset_id, role, approval_status FROM users WHERE id = ?')
          .get(meta.userId) as
          | {
              display_name: string;
              avatar_asset_id: string | null;
              role: string;
              approval_status: string;
            }
          | undefined;
        const sessionRow = db
          .prepare('SELECT revoked_at, last_activity_at, expires_at FROM sessions WHERE id = ?')
          .get(meta.sessionId) as
          | { revoked_at: number | null; last_activity_at: number; expires_at: number }
          | undefined;
        const now = Date.now();
        if (
          !userRow ||
          userRow.approval_status !== 'approved' ||
          !sessionRow ||
          sessionRow.revoked_at !== null ||
          now > sessionRow.expires_at ||
          now - sessionRow.last_activity_at > config.sessionIdleMs
        ) {
          sendJsonSafe(ws, { type: 'session:revoked' });
          ws.close(4001, 'Unauthorized');
          return;
        }
        meta.displayName = userRow.display_name;
        meta.avatarAssetId = userRow.avatar_asset_id;

        if (msg.type === 'typing' && msg.channel) {
          if (msg.channel === 'announcements' && userRow.role === 'member') return;
          if (msg.active) {
            db.prepare(
              `INSERT INTO typing_states (user_id, channel, last_activity_at)
               VALUES (?, ?, ?)
               ON CONFLICT(user_id, channel) DO UPDATE SET last_activity_at = excluded.last_activity_at`
            ).run(meta.userId, msg.channel, now);
          } else {
            db.prepare('DELETE FROM typing_states WHERE user_id = ? AND channel = ?').run(
              meta.userId,
              msg.channel
            );
          }
          for (const client of clients) {
            if (client.userId !== meta.userId) {
              sendJsonSafe(client.ws, {
                type: 'typing:updated',
                channel: msg.channel,
                userId: meta.userId,
                displayName: meta.displayName,
                active: Boolean(msg.active),
              });
            }
          }
          return;
        }

        // Majalis Multi-Room Join, Presence, WebRTC Signaling, Timer & Chat
        if (msg.type === 'majalis:join') {
          let targetRoomId = String(msg.roomId || '').trim();
          if (targetRoomId) {
            const exists = db.prepare('SELECT 1 FROM majalis_rooms WHERE id = ?').get(targetRoomId);
            if (!exists) targetRoomId = '';
          }
          if (!targetRoomId) {
            const fallbackRoom = db
              .prepare('SELECT id FROM majalis_rooms ORDER BY is_default DESC, created_at ASC LIMIT 1')
              .get() as { id: string } | undefined;
            if (!fallbackRoom) return;
            targetRoomId = fallbackRoom.id;
          }

          if (meta.inMajalis && meta.majalisRoomId !== targetRoomId) {
            leaveCurrentMajalisRoom(meta);
          }

          const mode: MajalisParticipationMode =
            msg.mode === 'media' || msg.mode === 'audio' || msg.mode === 'listener'
              ? msg.mode
              : 'listener';

          meta.inMajalis = true;
          meta.majalisRoomId = targetRoomId;
          meta.majalisMode = mode;
          meta.micMuted = typeof msg.micMuted === 'boolean' ? msg.micMuted : mode === 'listener';
          meta.camOff = typeof msg.camOff === 'boolean' ? msg.camOff : mode !== 'media';
          meta.screenSharing = false;
          meta.handRaised = false;
          meta.majalisJoinedAt = now;

          const peers = getParticipantsForRoom(targetRoomId).filter(
            (p) => p.userId !== meta.userId
          );

          sendJsonSafe(ws, {
            type: 'majalis:peers',
            roomId: targetRoomId,
            peers,
            timer: resolveEffectiveTimer(targetRoomId),
          });

          const selfInfo: MajalisParticipantInfo = {
            userId: meta.userId,
            displayName: meta.displayName,
            avatarAssetId: meta.avatarAssetId,
            mode: meta.majalisMode,
            micMuted: meta.micMuted,
            camOff: meta.camOff,
            screenSharing: meta.screenSharing,
            handRaised: meta.handRaised,
            joinedAt: meta.majalisJoinedAt,
          };

          for (const client of clients) {
            if (client.inMajalis && client.majalisRoomId === targetRoomId && client.userId !== meta.userId) {
              sendJsonSafe(client.ws, {
                type: 'majalis:peer_joined',
                roomId: targetRoomId,
                participant: selfInfo,
                userId: meta.userId,
                displayName: meta.displayName,
              });
            }
          }

          broadcastRoomState(targetRoomId);
          broadcastLobbyState();
          return;
        }

        if (msg.type === 'majalis:leave') {
          leaveCurrentMajalisRoom(meta);
          return;
        }

        if (msg.type === 'majalis:state' && meta.inMajalis && meta.majalisRoomId) {
          if (msg.mode === 'media' || msg.mode === 'audio' || msg.mode === 'listener') {
            meta.majalisMode = msg.mode;
          }
          if (typeof msg.micMuted === 'boolean') meta.micMuted = msg.micMuted;
          if (typeof msg.camOff === 'boolean') meta.camOff = msg.camOff;
          if (typeof msg.screenSharing === 'boolean') meta.screenSharing = msg.screenSharing;
          if (typeof msg.handRaised === 'boolean') meta.handRaised = msg.handRaised;

          broadcastRoomState(meta.majalisRoomId);
          broadcastLobbyState();
          return;
        }

        if (msg.type === 'majalis:timer' && meta.inMajalis && meta.majalisRoomId && msg.action) {
          controlRoomTimer(meta.majalisRoomId, meta.displayName, msg.action, msg.phase);
          return;
        }

        if (msg.type === 'majalis:chat' && meta.inMajalis && meta.majalisRoomId) {
          const text = String(msg.body || '').trim();
          if (!text || text.length > 500) return;

          const chatMsg: MajalisChatMessageRecord = {
            id: `mmsg_${randomUUID()}`,
            roomId: meta.majalisRoomId,
            userId: meta.userId,
            senderName: meta.displayName,
            avatarAssetId: meta.avatarAssetId,
            body: text,
            createdAt: now,
          };

          db.prepare(
            `INSERT INTO majalis_messages (id, room_id, user_id, sender_name_snapshot, avatar_asset_id, body, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          ).run(
            chatMsg.id,
            chatMsg.roomId,
            chatMsg.userId,
            chatMsg.senderName,
            chatMsg.avatarAssetId,
            chatMsg.body,
            chatMsg.createdAt
          );

          for (const client of clients) {
            if (client.inMajalis && client.majalisRoomId === meta.majalisRoomId) {
              sendJsonSafe(client.ws, {
                type: 'majalis:chat_message',
                roomId: meta.majalisRoomId,
                message: chatMsg,
              });
            }
          }
          return;
        }

        if (msg.type === 'majalis:signal' && meta.inMajalis && meta.majalisRoomId && msg.targetUserId && msg.signal) {
          for (const client of clients) {
            if (
              client.inMajalis &&
              client.majalisRoomId === meta.majalisRoomId &&
              client.userId === msg.targetUserId
            ) {
              sendJsonSafe(client.ws, {
                type: 'majalis:signal',
                roomId: meta.majalisRoomId,
                fromUserId: meta.userId,
                fromDisplayName: meta.displayName,
                signal: msg.signal,
              });
            }
          }
          return;
        }
      } catch {
        // Ignore malformed WS payloads
      }
    });

    ws.on('close', () => {
      const wasInMajalis = meta.inMajalis;
      const prevRoomId = meta.majalisRoomId;
      clients.delete(meta);
      if (isClosed) return;
      if (wasInMajalis && prevRoomId) {
        meta.inMajalis = false;
        meta.majalisRoomId = null;
        const stillInRoomSameUser = Array.from(clients).some(
          (c) => c.inMajalis && c.majalisRoomId === prevRoomId && c.userId === meta.userId
        );
        if (!stillInRoomSameUser) {
          for (const client of clients) {
            if (client.inMajalis && client.majalisRoomId === prevRoomId && client.userId !== meta.userId) {
              sendJsonSafe(client.ws, {
                type: 'majalis:peer_left',
                roomId: prevRoomId,
                userId: meta.userId,
              });
            }
          }
        }
        broadcastRoomState(prevRoomId);
        broadcastLobbyState();
      }
    });
  });

  function sendToClient(client: ClientMeta, payload: unknown): void {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify(payload));
    }
  }

  function getViewerForClient(userId: string) {
    const row = db
      .prepare('SELECT id, role, approval_status, history_granted, created_at FROM users WHERE id = ?')
      .get(userId) as
      | {
          id: string;
          role: 'member' | 'admin' | 'owner';
          approval_status: string;
          history_granted: number;
          created_at: number;
        }
      | undefined;
    if (!row || row.approval_status !== 'approved') return null;
    return {
      id: row.id,
      role: row.role,
      approvalStatus: row.approval_status,
      historyGranted: Boolean(row.history_granted),
      createdAt: row.created_at,
    };
  }

  return {
    broadcastMessageCreated(messageId, channel) {
      const msgRow = db
        .prepare('SELECT id, created_at, deleted_at FROM messages WHERE id = ?')
        .get(messageId) as { id: number; created_at: number; deleted_at: number | null } | undefined;
      if (!msgRow) return;
      for (const client of clients) {
        const viewer = getViewerForClient(client.userId);
        if (viewer && canViewerAccessMessage(db, viewer, msgRow)) {
          sendToClient(client, { type: 'message:created', messageId, channel });
        }
      }
    },
    broadcastMessageUpdated(messageId, channel) {
      for (const client of clients) {
        const viewer = getViewerForClient(client.userId);
        if (!viewer) continue;
        // Even tombstone updates should only notify users allowed in that time range
        const msgRow = db
          .prepare('SELECT id, created_at FROM messages WHERE id = ?')
          .get(messageId) as { id: number; created_at: number } | undefined;
        if (!msgRow) continue;
        const cutoff = viewer.role === 'owner' || viewer.role === 'admin' || viewer.historyGranted ? 0 : viewer.createdAt;
        if (msgRow.created_at >= cutoff) {
          sendToClient(client, { type: 'message:updated', messageId, channel });
        }
      }
    },
    broadcastMessageRemoved(messageId, channel) {
      for (const client of clients) {
        sendToClient(client, { type: 'message:removed', messageId, channel });
      }
    },
    broadcastReactionUpdated(messageId, channel) {
      const msgRow = db
        .prepare('SELECT id, created_at, deleted_at FROM messages WHERE id = ?')
        .get(messageId) as { id: number; created_at: number; deleted_at: number | null } | undefined;
      if (!msgRow) return;
      for (const client of clients) {
        const viewer = getViewerForClient(client.userId);
        if (viewer && canViewerAccessMessage(db, viewer, msgRow)) {
          sendToClient(client, { type: 'reaction:updated', messageId, channel });
        }
      }
    },
    broadcastReceiptUpdated(senderId, messageId) {
      for (const client of clients) {
        if (client.userId === senderId) {
          sendToClient(client, { type: 'receipt:updated', messageId });
        } else {
          const viewer = getViewerForClient(client.userId);
          if (viewer && (viewer.role === 'admin' || viewer.role === 'owner')) {
            sendToClient(client, { type: 'receipt:updated', messageId });
          }
        }
      }
    },
    broadcastTyping(channel, userId, displayName, active) {
      for (const client of clients) {
        if (client.userId !== userId) {
          sendToClient(client, { type: 'typing:updated', channel, userId, displayName, active });
        }
      }
    },
    broadcastChatLockChanged(locked) {
      for (const client of clients) {
        sendToClient(client, { type: 'chat:lock_changed', locked });
      }
    },
    broadcastChallengesUpdated() {
      for (const client of clients) {
        sendToClient(client, { type: 'challenges:updated' });
      }
    },
    getMajalisRoomsSnapshot() {
      return getMajalisRoomsSnapshot();
    },
    broadcastMajalisLobbyUpdated() {
      broadcastLobbyState();
    },
    broadcastMajalisRoomChat(roomId, message) {
      for (const client of clients) {
        if (client.inMajalis && client.majalisRoomId === roomId) {
          sendToClient(client, {
            type: 'majalis:chat_message',
            roomId,
            message,
          });
        }
      }
    },
    controlMajalisRoomTimer(roomId, actorName, action, phase) {
      return controlRoomTimer(roomId, actorName, action, phase);
    },
    notifySessionRevoked(sessionId) {
      for (const client of clients) {
        if (client.sessionId === sessionId) {
          sendToClient(client, { type: 'session:revoked' });
          client.ws.close(4001, 'Session revoked');
        }
      }
    },
    notifyUserSessionsRevoked(userId, exceptSessionId) {
      for (const client of clients) {
        if (client.userId === userId && client.sessionId !== exceptSessionId) {
          sendToClient(client, { type: 'session:revoked' });
          client.ws.close(4001, 'Session revoked');
        }
      }
    },
    notifyUserUpdated(userId) {
      for (const client of clients) {
        if (client.userId === userId) {
          sendToClient(client, { type: 'user:updated' });
        }
      }
    },
    close() {
      isClosed = true;
      for (const client of clients) {
        client.ws.close();
      }
      wss.close();
    },
  };
}
