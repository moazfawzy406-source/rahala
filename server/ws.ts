import type { Server as HttpServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import type { RahhalaConfig } from './config.ts';
import type { RahhalaDb } from './db.ts';
import { getOrCreateSigningSecret } from './db-core.ts';
import { verifyShortToken } from './lib/crypto.ts';
import { canViewerAccessMessage } from './lib/historyAccess.ts';
import {
  extractSessionToken,
  resolveActiveSession,
} from './middleware/auth.ts';
import { randomUUID } from 'node:crypto';
import type {
  ChannelId,
  MajalisAccessType,
  MajalisChatMessageRecord,
  MajalisKnockRequest,
  MajalisParticipantInfo,
  MajalisParticipationMode,
  MajalisReactionEvent,
  MajalisRoomSettings,
  MajalisRoomSummary,
  MajalisTimerPhase,
  MajalisTimerState,
  UserRole,
} from '../shared/types.ts';

const MAJALIS_TIMER_DURATIONS: Record<MajalisTimerPhase, number> = {
  focus: 25 * 60_000,
  review: 45 * 60_000,
  break: 5 * 60_000,
};

const ALLOWED_MEETING_REACTIONS = new Set(['👍', '👏', '❤️', '🔥', '💡', '🎉']);

interface ClientMeta {
  ws: WebSocket;
  userId: string;
  userRole: UserRole;
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

interface RoomSettingsRow {
  id: string;
  creator_id: string | null;
  access_type: MajalisAccessType;
  room_locked: number;
  allow_mic: number;
  allow_cam: number;
  allow_screen_share: number;
  allow_chat: number;
  mute_on_entry: number;
}

export interface RealtimeHub {
  notifyGroupUpdated: (groupId:string) => void;
  notifyGroupMembership: (userId:string) => void;
  broadcastAdminRequestsUpdated?: () => void;
  exportState?: () => any;
  importState?: (s: any) => void;
  restoreClient?: (ws: any, meta: any) => void;
  clientsState?: () => Array<{ws: any;meta: any}>;
  broadcastMessageCreated: (messageId: number, channel: ChannelId) => void;
  broadcastMessageUpdated: (messageId: number, channel: ChannelId) => void;
  broadcastMessageRemoved: (messageId: number, channel: ChannelId) => void;
  broadcastReactionUpdated: (messageId: number, channel: ChannelId) => void;
  broadcastReceiptUpdated: (senderId: string, messageId: number) => void;
  broadcastTyping: (channel: ChannelId, userId: string, displayName: string, active: boolean) => void;
  broadcastChatLockChanged: (locked: boolean) => void;
  broadcastGroupSettingsUpdated: () => void;
  broadcastChannelWiped: (channel: ChannelId | 'all') => void;
  broadcastConversationListUpdated: (userIds: string[]) => void;
  broadcastConversationMessageCreated: (conversationId: string, messageId: number, senderId: string) => void;
  broadcastConversationMessageUpdated: (conversationId: string, messageId: number) => void;
  broadcastConversationMessageRemoved: (conversationId: string, messageId: number) => void;
  broadcastConversationReactionUpdated: (conversationId: string, messageId: number) => void;
  broadcastConversationReceiptUpdated: (senderId: string, conversationId: string, messageId: number) => void;
  broadcastChallengesUpdated: () => void;
  getMajalisRoomsSnapshot: () => MajalisRoomSummary[];
  broadcastMajalisLobbyUpdated: () => void;
  applyMajalisRoomSettings: (roomId: string, settings: MajalisRoomSettings) => void;
  endMajalisMeetingForAll: (roomId: string, actorName: string) => void;
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
  const roomKnocks = new Map<string, Map<string, MajalisKnockRequest>>();
  const roomAdmittedUsers = new Map<string, Set<string>>();
  const roomSpotlights = new Map<string, string | null>();
  const signingSecret = getOrCreateSigningSecret(db);
  let isClosed = false;

  function mapRoomSettings(row: RoomSettingsRow): MajalisRoomSettings {
    return {
      accessType: row.access_type === 'knock' ? 'knock' : 'open',
      roomLocked: Boolean(row.room_locked),
      allowMic: Boolean(row.allow_mic),
      allowCam: Boolean(row.allow_cam),
      allowScreenShare: Boolean(row.allow_screen_share),
      allowChat: Boolean(row.allow_chat),
      muteOnEntry: Boolean(row.mute_on_entry),
    };
  }

  function getRoomRow(roomId: string): RoomSettingsRow | undefined {
    if (isClosed || !db.open) return undefined;
    return db
      .prepare(
        `SELECT id, creator_id, access_type, room_locked, allow_mic, allow_cam, allow_screen_share, allow_chat, mute_on_entry
         FROM majalis_rooms WHERE id = ?`
      )
      .get(roomId) as RoomSettingsRow | undefined;
  }

  function isRoomHost(room: { creator_id: string | null }, userId: string, userRole: UserRole): boolean {
    if (userRole === 'owner' || userRole === 'admin') return true;
    return Boolean(room.creator_id && room.creator_id === userId);
  }

  function getKnockQueue(roomId: string): MajalisKnockRequest[] {
    const map = roomKnocks.get(roomId);
    if (!map) return [];
    return Array.from(map.values()).sort((a, b) => a.requestedAt - b.requestedAt);
  }

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
                r.creator_id, r.creator_name_snapshot, r.is_default, r.created_at,
                r.access_type, r.room_locked, r.allow_mic, r.allow_cam, r.allow_screen_share, r.allow_chat, r.mute_on_entry
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
      access_type: MajalisAccessType;
      room_locked: number;
      allow_mic: number;
      allow_cam: number;
      allow_screen_share: number;
      allow_chat: number;
      mute_on_entry: number;
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
        settings: mapRoomSettings(r),
        spotlightUserId: roomSpotlights.get(r.id) ?? null,
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
    let authedUserRole: UserRole = 'member';
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
                    u.display_name, u.avatar_asset_id, u.approval_status, u.role
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
              role: UserRole;
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
          authedUserRole = s.role;
          authedSessionId = s.id;
          authedDisplayName = s.display_name;
          authedAvatarAssetId = s.avatar_asset_id;
        }
      }
    } else if (fallbackSessionToken) {
      const resolved = resolveActiveSession(db, config, fallbackSessionToken, { touchActivity: false });
      if (resolved.ok) {
        authedUserId = resolved.data.user.id;
        authedUserRole = resolved.data.user.role;
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
        userRole: authedUserRole,
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

  function broadcastKnockQueue(roomId: string): void {
    const roomRow = getRoomRow(roomId);
    if (!roomRow) return;
    const queue = getKnockQueue(roomId);
    for (const client of clients) {
      if (
        (client.inMajalis && client.majalisRoomId === roomId && isRoomHost(roomRow, client.userId, client.userRole)) ||
        (roomRow.creator_id === client.userId)
      ) {
        sendJsonSafe(client.ws, {
          type: 'majalis:knock_queue',
          roomId,
          queue,
        });
      }
    }
  }

  function broadcastRoomState(roomId: string): void {
    const participants = getParticipantsForRoom(roomId);
    const timer = resolveEffectiveTimer(roomId);
    const roomRow = getRoomRow(roomId);
    const settings = roomRow ? mapRoomSettings(roomRow) : undefined;
    const spotlightUserId = roomSpotlights.get(roomId) ?? null;

    for (const client of clients) {
      if (client.inMajalis && client.majalisRoomId === roomId) {
        sendJsonSafe(client.ws, {
          type: 'majalis:room_state',
          roomId,
          participants,
          timer,
          settings,
          spotlightUserId,
        });
      }
    }
  }

  function enforceSettingsOnRoomParticipants(roomId: string, settings: MajalisRoomSettings): void {
    const roomRow = getRoomRow(roomId);
    if (!roomRow) return;

    for (const client of clients) {
      if (!client.inMajalis || client.majalisRoomId !== roomId) continue;
      if (isRoomHost(roomRow, client.userId, client.userRole)) continue;

      if (!settings.allowMic && !client.micMuted) {
        client.micMuted = true;
        sendJsonSafe(client.ws, {
          type: 'majalis:force_mute',
          roomId,
          reason: 'أوقف المضيف صلاحية التحدث بالميكروفون.',
        });
      }
      if (!settings.allowCam && !client.camOff) {
        client.camOff = true;
        if (client.majalisMode === 'media') {
          client.majalisMode = 'audio';
        }
        sendJsonSafe(client.ws, {
          type: 'majalis:force_cam_off',
          roomId,
          reason: 'أوقف المضيف صلاحية تشغيل الكاميرا.',
        });
      }
      if (!settings.allowScreenShare && client.screenSharing) {
        client.screenSharing = false;
        sendJsonSafe(client.ws, {
          type: 'majalis:force_stop_share',
          roomId,
          reason: 'أوقف المضيف صلاحية مشاركة الشاشة.',
        });
      }
    }

    for (const client of clients) {
      if (client.inMajalis && client.majalisRoomId === roomId) {
        sendJsonSafe(client.ws, {
          type: 'majalis:settings_updated',
          roomId,
          settings,
        });
      }
    }

    broadcastRoomState(roomId);
    broadcastLobbyState();
  }

  function endMeetingForAllInternal(roomId: string, actorName: string): void {
    roomKnocks.delete(roomId);
    roomAdmittedUsers.delete(roomId);
    roomSpotlights.delete(roomId);

    for (const client of clients) {
      if (client.inMajalis && client.majalisRoomId === roomId) {
        client.inMajalis = false;
        client.majalisRoomId = null;
        client.screenSharing = false;
        client.handRaised = false;
        sendJsonSafe(client.ws, {
          type: 'majalis:ended',
          roomId,
          byName: actorName,
          message: `تم إنهاء المجلس للجميع بواسطة ${actorName}.`,
        });
      }
    }
    broadcastLobbyState();
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
      if (roomSpotlights.get(leftRoomId) === meta.userId) {
        roomSpotlights.set(leftRoomId, null);
      }
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
          conversationId?: string;
          active?: boolean;
          targetUserId?: string;
          roomId?: string;
          mode?: MajalisParticipationMode;
          micMuted?: boolean;
          camOff?: boolean;
          screenSharing?: boolean;
          handRaised?: boolean;
          approve?: boolean;
          emoji?: string;
          action?: string;
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
              role: UserRole;
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
        meta.userRole = userRow.role;

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

        if (msg.type === 'conv:typing' && msg.conversationId) {
          const convId = String(msg.conversationId);
          const isMember = db
            .prepare('SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?')
            .get(convId, meta.userId);
          if (!isMember) return;
          const memberIds = new Set(
            (
              db
                .prepare('SELECT user_id FROM conversation_members WHERE conversation_id = ?')
                .all(convId) as Array<{ user_id: string }>
            ).map((r) => r.user_id)
          );
          for (const client of clients) {
            if (client.userId !== meta.userId && memberIds.has(client.userId)) {
              sendJsonSafe(client.ws, {
                type: 'conv:typing_updated',
                conversationId: convId,
                userId: meta.userId,
                displayName: meta.displayName,
                active: Boolean(msg.active),
              });
            }
          }
          return;
        }

        // Majalis Multi-Room Join, Knock Queue, Host Controls, WebRTC Signaling, Timer & Chat
        if (msg.type === 'majalis:join') {
          let targetRoomId = String(msg.roomId || '').trim();
          let roomRow = targetRoomId ? getRoomRow(targetRoomId) : undefined;
          if (!roomRow) {
            const fallbackRoom = db
              .prepare('SELECT id FROM majalis_rooms ORDER BY is_default DESC, created_at ASC LIMIT 1')
              .get() as { id: string } | undefined;
            if (!fallbackRoom) return;
            targetRoomId = fallbackRoom.id;
            roomRow = getRoomRow(targetRoomId);
          }
          if (!roomRow) return;

          const settings = mapRoomSettings(roomRow);
          const host = isRoomHost(roomRow, meta.userId, meta.userRole);
          const mode: MajalisParticipationMode =
            msg.mode === 'media' || msg.mode === 'audio' || msg.mode === 'listener'
              ? msg.mode
              : 'listener';

          // Google Meet Room Lock check
          if (settings.roomLocked && !host) {
            sendJsonSafe(ws, {
              type: 'majalis:join_rejected',
              roomId: targetRoomId,
              reason: 'locked',
              message: 'المجلس مقفول حالياً من قِبل المضيف.',
            });
            return;
          }

          // Google Meet Knock / Waiting Queue check
          if (
            settings.accessType === 'knock' &&
            !host &&
            !roomAdmittedUsers.get(targetRoomId)?.has(meta.userId)
          ) {
            let queueMap = roomKnocks.get(targetRoomId);
            if (!queueMap) {
              queueMap = new Map();
              roomKnocks.set(targetRoomId, queueMap);
            }
            queueMap.set(meta.userId, {
              userId: meta.userId,
              displayName: meta.displayName,
              avatarAssetId: meta.avatarAssetId,
              mode,
              requestedAt: now,
            });
            sendJsonSafe(ws, {
              type: 'majalis:knock_pending',
              roomId: targetRoomId,
            });
            broadcastKnockQueue(targetRoomId);
            return;
          }

          if (meta.inMajalis && meta.majalisRoomId !== targetRoomId) {
            leaveCurrentMajalisRoom(meta);
          }

          // Remove from knock queue if somehow still there
          roomKnocks.get(targetRoomId)?.delete(meta.userId);

          let effectiveMicMuted =
            typeof msg.micMuted === 'boolean' ? msg.micMuted : mode === 'listener';
          let effectiveCamOff =
            typeof msg.camOff === 'boolean' ? msg.camOff : mode !== 'media';
          let effectiveMode = mode;

          if (!host) {
            if (settings.muteOnEntry || !settings.allowMic) {
              effectiveMicMuted = true;
            }
            if (!settings.allowCam) {
              effectiveCamOff = true;
              if (effectiveMode === 'media') {
                effectiveMode = 'audio';
              }
            }
            if (!settings.allowMic && !settings.allowCam) {
              effectiveMode = 'listener';
            }
          }

          meta.inMajalis = true;
          meta.majalisRoomId = targetRoomId;
          meta.majalisMode = effectiveMode;
          meta.micMuted = effectiveMicMuted;
          meta.camOff = effectiveCamOff;
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
            settings,
            spotlightUserId: roomSpotlights.get(targetRoomId) ?? null,
            knockQueue: host ? getKnockQueue(targetRoomId) : [],
            enforcedMicMuted: !host && (settings.muteOnEntry || !settings.allowMic),
            enforcedCamOff: !host && !settings.allowCam,
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

        if (msg.type === 'majalis:knock_cancel' && msg.roomId) {
          const rId = String(msg.roomId);
          roomKnocks.get(rId)?.delete(meta.userId);
          broadcastKnockQueue(rId);
          return;
        }

        if (msg.type === 'majalis:knock_decide' && msg.roomId && msg.targetUserId) {
          const rId = String(msg.roomId);
          const roomRow = getRoomRow(rId);
          if (!roomRow || !isRoomHost(roomRow, meta.userId, meta.userRole)) return;

          const targetId = String(msg.targetUserId);
          roomKnocks.get(rId)?.delete(targetId);

          if (msg.approve) {
            let admitted = roomAdmittedUsers.get(rId);
            if (!admitted) {
              admitted = new Set();
              roomAdmittedUsers.set(rId, admitted);
            }
            admitted.add(targetId);
            for (const client of clients) {
              if (client.userId === targetId) {
                sendJsonSafe(client.ws, {
                  type: 'majalis:knock_admitted',
                  roomId: rId,
                });
              }
            }
          } else {
            for (const client of clients) {
              if (client.userId === targetId) {
                sendJsonSafe(client.ws, {
                  type: 'majalis:join_rejected',
                  roomId: rId,
                  reason: 'denied',
                  message: 'لم يوافق المضيف على طلب الانضمام للمجلس.',
                });
              }
            }
          }
          broadcastKnockQueue(rId);
          return;
        }

        if (msg.type === 'majalis:leave') {
          leaveCurrentMajalisRoom(meta);
          return;
        }

        if (msg.type === 'majalis:state' && meta.inMajalis && meta.majalisRoomId) {
          const roomRow = getRoomRow(meta.majalisRoomId);
          const settings = roomRow ? mapRoomSettings(roomRow) : null;
          const host = roomRow ? isRoomHost(roomRow, meta.userId, meta.userRole) : false;

          if (msg.mode === 'media' || msg.mode === 'audio' || msg.mode === 'listener') {
            meta.majalisMode = msg.mode;
          }
          if (typeof msg.micMuted === 'boolean') {
            if (!host && settings && !settings.allowMic && msg.micMuted === false) {
              meta.micMuted = true;
              sendJsonSafe(ws, {
                type: 'majalis:force_mute',
                roomId: meta.majalisRoomId,
                reason: 'الميكروفون معطّل للمشاركين من إعدادات المضيف.',
              });
            } else {
              meta.micMuted = msg.micMuted;
            }
          }
          if (typeof msg.camOff === 'boolean') {
            if (!host && settings && !settings.allowCam && msg.camOff === false) {
              meta.camOff = true;
              sendJsonSafe(ws, {
                type: 'majalis:force_cam_off',
                roomId: meta.majalisRoomId,
                reason: 'الكاميرا معطّلة للمشاركين من إعدادات المضيف.',
              });
            } else {
              meta.camOff = msg.camOff;
            }
          }
          if (typeof msg.screenSharing === 'boolean') {
            if (!host && settings && !settings.allowScreenShare && msg.screenSharing === true) {
              meta.screenSharing = false;
              sendJsonSafe(ws, {
                type: 'majalis:force_stop_share',
                roomId: meta.majalisRoomId,
                reason: 'مشاركة الشاشة معطّلة من إعدادات المضيف.',
              });
            } else {
              meta.screenSharing = msg.screenSharing;
            }
          }
          if (typeof msg.handRaised === 'boolean') meta.handRaised = msg.handRaised;

          broadcastRoomState(meta.majalisRoomId);
          broadcastLobbyState();
          return;
        }

        if (msg.type === 'majalis:host_action' && meta.inMajalis && meta.majalisRoomId && msg.action) {
          const rId = meta.majalisRoomId;
          const roomRow = getRoomRow(rId);
          if (!roomRow || !isRoomHost(roomRow, meta.userId, meta.userRole)) return;

          if (msg.action === 'mute_all') {
            for (const client of clients) {
              if (
                client.inMajalis &&
                client.majalisRoomId === rId &&
                !isRoomHost(roomRow, client.userId, client.userRole)
              ) {
                client.micMuted = true;
                sendJsonSafe(client.ws, {
                  type: 'majalis:force_mute',
                  roomId: rId,
                  reason: `قام ${meta.displayName} بكتم صوت الجميع.`,
                });
              }
            }
            broadcastRoomState(rId);
            broadcastLobbyState();
            return;
          }

          if (msg.action === 'mute_user' && msg.targetUserId) {
            const targetId = String(msg.targetUserId);
            for (const client of clients) {
              if (client.inMajalis && client.majalisRoomId === rId && client.userId === targetId) {
                client.micMuted = true;
                sendJsonSafe(client.ws, {
                  type: 'majalis:force_mute',
                  roomId: rId,
                  reason: `قام ${meta.displayName} بكتم الميكروفون لديك.`,
                });
              }
            }
            broadcastRoomState(rId);
            broadcastLobbyState();
            return;
          }

          if (msg.action === 'lower_all_hands') {
            for (const client of clients) {
              if (client.inMajalis && client.majalisRoomId === rId) {
                client.handRaised = false;
              }
            }
            broadcastRoomState(rId);
            return;
          }

          if (msg.action === 'spotlight_user') {
            const nextSpot = msg.targetUserId ? String(msg.targetUserId) : null;
            roomSpotlights.set(rId, nextSpot);
            broadcastRoomState(rId);
            broadcastLobbyState();
            return;
          }

          if (msg.action === 'kick_user' && msg.targetUserId) {
            const targetId = String(msg.targetUserId);
            if (targetId === meta.userId) return;
            roomAdmittedUsers.get(rId)?.delete(targetId);
            roomKnocks.get(rId)?.delete(targetId);
            for (const client of clients) {
              if (client.inMajalis && client.majalisRoomId === rId && client.userId === targetId) {
                client.inMajalis = false;
                client.majalisRoomId = null;
                client.screenSharing = false;
                client.handRaised = false;
                sendJsonSafe(client.ws, {
                  type: 'majalis:kicked',
                  roomId: rId,
                  message: `تم إبعادك من المجلس بواسطة ${meta.displayName}.`,
                });
              } else if (client.inMajalis && client.majalisRoomId === rId && client.userId !== targetId) {
                sendJsonSafe(client.ws, {
                  type: 'majalis:peer_left',
                  roomId: rId,
                  userId: targetId,
                });
              }
            }
            if (roomSpotlights.get(rId) === targetId) {
              roomSpotlights.set(rId, null);
            }
            broadcastRoomState(rId);
            broadcastLobbyState();
            return;
          }

          if (msg.action === 'end_meeting') {
            endMeetingForAllInternal(rId, meta.displayName);
            return;
          }
        }

        if (msg.type === 'majalis:reaction' && meta.inMajalis && meta.majalisRoomId && msg.emoji) {
          const emoji = String(msg.emoji).trim();
          if (!ALLOWED_MEETING_REACTIONS.has(emoji)) return;
          const ev: MajalisReactionEvent = {
            id: `mrx_${randomUUID().slice(0, 8)}`,
            userId: meta.userId,
            displayName: meta.displayName,
            emoji,
            createdAt: now,
          };
          for (const client of clients) {
            if (client.inMajalis && client.majalisRoomId === meta.majalisRoomId) {
              sendJsonSafe(client.ws, {
                type: 'majalis:reaction',
                roomId: meta.majalisRoomId,
                reaction: ev,
              });
            }
          }
          return;
        }

        if (msg.type === 'majalis:timer' && meta.inMajalis && meta.majalisRoomId && msg.action) {
          if (
            msg.action === 'start' ||
            msg.action === 'pause' ||
            msg.action === 'reset' ||
            msg.action === 'preset'
          ) {
            controlRoomTimer(meta.majalisRoomId, meta.displayName, msg.action, msg.phase);
          }
          return;
        }

        if (msg.type === 'majalis:chat' && meta.inMajalis && meta.majalisRoomId) {
          const roomRow = getRoomRow(meta.majalisRoomId);
          if (roomRow) {
            const settings = mapRoomSettings(roomRow);
            const host = isRoomHost(roomRow, meta.userId, meta.userRole);
            if (!host && !settings.allowChat) {
              sendJsonSafe(ws, {
                type: 'majalis:error',
                roomId: meta.majalisRoomId,
                message: 'تم إيقاف الدردشة في هذا المجلس من قِبل المضيف.',
              });
              return;
            }
          }

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

      // Clean any pending knock requests from this disconnected user
      for (const [rId, queueMap] of roomKnocks.entries()) {
        if (queueMap.delete(meta.userId)) {
          broadcastKnockQueue(rId);
        }
      }

      if (wasInMajalis && prevRoomId) {
        meta.inMajalis = false;
        meta.majalisRoomId = null;
        const stillInRoomSameUser = Array.from(clients).some(
          (c) => c.inMajalis && c.majalisRoomId === prevRoomId && c.userId === meta.userId
        );
        if (!stillInRoomSameUser) {
          if (roomSpotlights.get(prevRoomId) === meta.userId) {
            roomSpotlights.set(prevRoomId, null);
          }
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
    notifyGroupUpdated(groupId) {for(const c of clients){if(getViewerForClient(c.userId)?.approvalStatus==='approved'&&db.prepare("SELECT 1 FROM chat_group_members WHERE group_id=? AND user_id=? AND status='approved'").get(groupId,c.userId))sendToClient(c,{type:'group:updated',groupId});}},
    notifyGroupMembership(userId) {for(const c of clients){if(c.userId===userId)sendToClient(c,{type:'group:membership'});}},
    broadcastAdminRequestsUpdated() { for(const c of clients) { const v=getViewerForClient(c.userId); if(v && (v.role==='admin'||v.role==='owner')) sendToClient(c,{type:'admin:requests_updated'}); } },
    exportState() {
      return { timers: [...roomTimers], knocks: [...roomKnocks].map(([k,v])=>[k,[...v]]), admitted: [...roomAdmittedUsers].map(([k,v])=>[k,[...v]]), spotlights: [...roomSpotlights] };
    },
    importState(s: any) {
      for (const [k,v] of s?.timers ?? []) roomTimers.set(k,v);
      for (const [k,v] of s?.knocks ?? []) roomKnocks.set(k,new Map(v));
      for (const [k,v] of s?.admitted ?? []) roomAdmittedUsers.set(k,new Set(v));
      for (const [k,v] of s?.spotlights ?? []) roomSpotlights.set(k,v);
    },
    restoreClient(ws: any, meta: any) {
      const restored = { ...meta, ws }; clients.add(restored); wss.emit('connection',ws,null,restored);
    },
    clientsState() { return [...clients].map(({ ws, ...meta })=>({ ws, meta })); },
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
    broadcastGroupSettingsUpdated() {
      for (const client of clients) {
        sendToClient(client, { type: 'chat:group_settings_updated' });
      }
    },
    broadcastChannelWiped(channel) {
      for (const client of clients) {
        sendToClient(client, { type: 'chat:channel_wiped', channel });
      }
    },
    broadcastConversationListUpdated(userIds) {
      const targetSet = new Set(userIds);
      for (const client of clients) {
        if (targetSet.has(client.userId)) {
          sendToClient(client, { type: 'conv:list_updated' });
        }
      }
    },
    broadcastConversationMessageCreated(conversationId, messageId, senderId) {
      if (isClosed || !db.open) return;
      const memberIds = new Set(
        (
          db
            .prepare('SELECT user_id FROM conversation_members WHERE conversation_id = ?')
            .all(conversationId) as Array<{ user_id: string }>
        ).map((r) => r.user_id)
      );
      for (const client of clients) {
        if (memberIds.has(client.userId)) {
          sendToClient(client, {
            type: 'conv:message_created',
            conversationId,
            messageId,
            senderId,
          });
        }
      }
    },
    broadcastConversationMessageUpdated(conversationId, messageId) {
      if (isClosed || !db.open) return;
      const memberIds = new Set(
        (
          db
            .prepare('SELECT user_id FROM conversation_members WHERE conversation_id = ?')
            .all(conversationId) as Array<{ user_id: string }>
        ).map((r) => r.user_id)
      );
      for (const client of clients) {
        if (memberIds.has(client.userId)) {
          sendToClient(client, {
            type: 'conv:message_updated',
            conversationId,
            messageId,
          });
        }
      }
    },
    broadcastConversationMessageRemoved(conversationId, messageId) {
      if (isClosed || !db.open) return;
      const memberIds = new Set(
        (
          db
            .prepare('SELECT user_id FROM conversation_members WHERE conversation_id = ?')
            .all(conversationId) as Array<{ user_id: string }>
        ).map((r) => r.user_id)
      );
      for (const client of clients) {
        if (memberIds.has(client.userId)) {
          sendToClient(client, {
            type: 'conv:message_removed',
            conversationId,
            messageId,
          });
        }
      }
    },
    broadcastConversationReactionUpdated(conversationId, messageId) {
      if (isClosed || !db.open) return;
      const memberIds = new Set(
        (
          db
            .prepare('SELECT user_id FROM conversation_members WHERE conversation_id = ?')
            .all(conversationId) as Array<{ user_id: string }>
        ).map((r) => r.user_id)
      );
      for (const client of clients) {
        if (memberIds.has(client.userId)) {
          sendToClient(client, {
            type: 'conv:reaction_updated',
            conversationId,
            messageId,
          });
        }
      }
    },
    broadcastConversationReceiptUpdated(senderId, conversationId, messageId) {
      for (const client of clients) {
        if (client.userId === senderId) {
          sendToClient(client, {
            type: 'conv:receipt_updated',
            conversationId,
            messageId,
          });
        }
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
    applyMajalisRoomSettings(roomId, settings) {
      enforceSettingsOnRoomParticipants(roomId, settings);
    },
    endMajalisMeetingForAll(roomId, actorName) {
      endMeetingForAllInternal(roomId, actorName);
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
