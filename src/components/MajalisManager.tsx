import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AppPublicConfig,
  AuthUser,
  MajalisChatMessageRecord,
  MajalisParticipantInfo,
  MajalisParticipationMode,
  MajalisRoomSummary,
  MajalisTimerPhase,
  MajalisTimerState,
  SubjectRecord,
} from '../../shared/types';
import { useWebSocket, type WsServerEvent } from '../hooks/useWebSocket';
import { ApiError, apiRequest } from '../lib/api';
import { Icons } from './Icons';
import { Avatar, ConfirmDialog, EmptyState, ErrorRetryPanel, ModalShell } from './UI';

interface PeerMedia extends MajalisParticipantInfo {
  stream: MediaStream | null;
}

const DEFAULT_TIMER: MajalisTimerState = {
  phase: 'focus',
  durationMs: 25 * 60_000,
  remainingMs: 25 * 60_000,
  running: false,
  startedAt: null,
  updatedByName: null,
};

const TIMER_PHASE_LABELS: Record<MajalisTimerPhase, string> = {
  focus: 'تركيز ٢٥ د',
  review: 'مراجعة ٤٥ د',
  break: 'استراحة ٥ د',
};

function formatCountdownMs(ms: number): string {
  const totalSecs = Math.max(0, Math.ceil(ms / 1000));
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function formatMessageTime(ts: number): string {
  return new Intl.DateTimeFormat('ar-EG', {
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(ts));
}

function modeLabel(mode: MajalisParticipationMode): string {
  if (mode === 'media') return 'صوت وصورة';
  if (mode === 'audio') return 'صوت فقط';
  return 'مستمع';
}

export interface MajalisController {
  rooms: MajalisRoomSummary[];
  roomsLoading: boolean;
  roomsError: string | null;
  subjects: SubjectRecord[];
  activeRoom: MajalisRoomSummary | null;
  activeRoomId: string | null;
  joined: boolean;
  joining: boolean;
  wsConnected: boolean;
  mode: MajalisParticipationMode;
  permissionNotice: string | null;
  micMuted: boolean;
  camOff: boolean;
  screenSharing: boolean;
  handRaised: boolean;
  localStream: MediaStream | null;
  peers: PeerMedia[];
  timer: MajalisTimerState;
  remainingMs: number;
  messages: MajalisChatMessageRecord[];
  messagesLoading: boolean;
  wakeLockActive: boolean;
  refreshRooms: () => Promise<void>;
  createRoom: (payload: { title: string; subjectId: string | null }) => Promise<MajalisRoomSummary>;
  deleteRoom: (roomId: string) => Promise<void>;
  joinMeeting: (roomId?: string, options?: { listenerOnly?: boolean }) => Promise<void>;
  leaveMeeting: () => void;
  toggleMic: () => Promise<void>;
  toggleCam: () => Promise<void>;
  toggleScreenShare: () => Promise<void>;
  toggleHandRaise: () => void;
  switchToListener: () => void;
  upgradeMedia: (wantVideo?: boolean) => Promise<void>;
  controlTimer: (action: 'start' | 'pause' | 'reset' | 'preset', phase?: MajalisTimerPhase) => Promise<void>;
  sendRoomMessage: (body: string) => Promise<void>;
  dismissNotice: () => void;
  openExternalTab: () => void;
}

export function useMajalisController(
  config: AppPublicConfig,
  user: AuthUser | null,
  isViewVisible: boolean,
  onToast: (msg: string, isError?: boolean) => void
): MajalisController {
  const [rooms, setRooms] = useState<MajalisRoomSummary[]>([]);
  const [roomsLoading, setRoomsLoading] = useState(false);
  const [roomsError, setRoomsError] = useState<string | null>(null);
  const [subjects, setSubjects] = useState<SubjectRecord[]>([]);

  const [activeRoomId, setActiveRoomId] = useState<string | null>(null);
  const [joined, setJoined] = useState(false);
  const [joining, setJoining] = useState(false);
  const [mode, setMode] = useState<MajalisParticipationMode>('listener');
  const [permissionNotice, setPermissionNotice] = useState<string | null>(null);
  const [micMuted, setMicMuted] = useState(true);
  const [camOff, setCamOff] = useState(true);
  const [screenSharing, setScreenSharing] = useState(false);
  const [handRaised, setHandRaised] = useState(false);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [peers, setPeers] = useState<PeerMedia[]>([]);
  const [timer, setTimer] = useState<MajalisTimerState>(DEFAULT_TIMER);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [messages, setMessages] = useState<MajalisChatMessageRecord[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [wakeLockActive, setWakeLockActive] = useState(false);

  const localStreamRef = useRef<MediaStream | null>(null);
  const cameraTrackBeforeShareRef = useRef<MediaStreamTrack | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const peerConnectionsRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const pendingIceRef = useRef<Map<string, RTCIceCandidateInit[]>>(new Map());
  const makingOfferRef = useRef<Map<string, boolean>>(new Map());
  const wakeLockRef = useRef<{ release: () => Promise<void> } | null>(null);
  const sendJsonRef = useRef<(payload: unknown) => boolean>(() => false);
  const joinedRef = useRef(false);
  const activeRoomIdRef = useRef<string | null>(null);
  const modeRef = useRef<MajalisParticipationMode>('listener');
  const micMutedRef = useRef(true);
  const camOffRef = useRef(true);

  joinedRef.current = joined;
  activeRoomIdRef.current = activeRoomId;
  modeRef.current = mode;
  micMutedRef.current = micMuted;
  camOffRef.current = camOff;

  const loadRooms = useCallback(async (background = false) => {
    if (!user) return;
    if (!background) {
      setRoomsLoading(true);
      setRoomsError(null);
    }
    try {
      const res = await apiRequest<{ rooms: MajalisRoomSummary[] }>('/api/majalis/rooms', {
        background,
      });
      setRooms(res.rooms);
    } catch (err) {
      if (!background) {
        setRoomsError(err instanceof ApiError ? err.message : 'تعذر تحميل مجالس المذاكرة');
      }
    } finally {
      if (!background) {
        setRoomsLoading(false);
      }
    }
  }, [user]);

  const loadSubjects = useCallback(async () => {
    if (!user) return;
    try {
      const res = await apiRequest<{ subjects: SubjectRecord[] }>('/api/resources/subjects', {
        background: true,
      });
      setSubjects(res.subjects);
    } catch {
      // Optional for custom room tag
    }
  }, [user]);

  const loadRoomMessages = useCallback(async (roomId: string) => {
    setMessagesLoading(true);
    try {
      const res = await apiRequest<{ messages: MajalisChatMessageRecord[] }>(
        `/api/majalis/rooms/${encodeURIComponent(roomId)}/messages`
      );
      setMessages(res.messages);
    } catch {
      setMessages([]);
    } finally {
      setMessagesLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!user) return;
    if (isViewVisible || joined) {
      void loadRooms(rooms.length > 0);
      void loadSubjects();
    }
  }, [user, isViewVisible, joined, loadRooms, loadSubjects, rooms.length]);

  // Live countdown ticker when synchronized timer is running
  useEffect(() => {
    if (!timer.running) return;
    setNowTick(Date.now());
    const id = window.setInterval(() => setNowTick(Date.now()), 500);
    return () => window.clearInterval(id);
  }, [timer.running]);

  const remainingMs = useMemo(() => {
    if (!timer.running || timer.startedAt === null) return timer.remainingMs;
    const elapsed = Math.max(0, nowTick - timer.startedAt);
    return Math.max(0, timer.remainingMs - elapsed);
  }, [timer, nowTick]);

  const cleanupMediaAndPeers = useCallback(() => {
    for (const pc of peerConnectionsRef.current.values()) {
      pc.close();
    }
    peerConnectionsRef.current.clear();
    pendingIceRef.current.clear();
    makingOfferRef.current.clear();
    setPeers([]);

    screenStreamRef.current?.getTracks().forEach((t) => t.stop());
    screenStreamRef.current = null;
    cameraTrackBeforeShareRef.current = null;

    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    localStreamRef.current = null;
    setLocalStream(null);
    setScreenSharing(false);
    setHandRaised(false);

    if (wakeLockRef.current) {
      wakeLockRef.current.release().catch(() => {});
      wakeLockRef.current = null;
    }
    setWakeLockActive(false);
  }, []);

  const syncLocalTracksToPeer = useCallback((pc: RTCPeerConnection, isInitiator: boolean) => {
    const stream = localStreamRef.current;
    const senders = pc.getSenders();
    const audioTrack = stream?.getAudioTracks()[0] ?? null;
    const videoTrack = stream?.getVideoTracks()[0] ?? null;

    const existingAudioSender = senders.find((s) => s.track?.kind === 'audio');
    if (audioTrack) {
      if (existingAudioSender) {
        void existingAudioSender.replaceTrack(audioTrack).catch(() => {});
      } else {
        pc.addTrack(audioTrack, stream!);
      }
    } else if (isInitiator && !pc.getTransceivers().some((t) => t.receiver.track?.kind === 'audio')) {
      try {
        pc.addTransceiver('audio', { direction: 'recvonly' });
      } catch {
        // Ignore if transceiver already negotiated
      }
    }

    const existingVideoSender = senders.find((s) => s.track?.kind === 'video');
    if (videoTrack) {
      if (existingVideoSender) {
        void existingVideoSender.replaceTrack(videoTrack).catch(() => {});
      } else {
        pc.addTrack(videoTrack, stream!);
      }
    } else if (isInitiator && !pc.getTransceivers().some((t) => t.receiver.track?.kind === 'video')) {
      try {
        pc.addTransceiver('video', { direction: 'recvonly' });
      } catch {
        // Ignore if transceiver already negotiated
      }
    }
  }, []);

  const createPeerConnection = useCallback(
    (remoteUserId: string, remoteName: string, isInitiator = false) => {
      const existing = peerConnectionsRef.current.get(remoteUserId);
      if (existing) return existing;

      const pc = new RTCPeerConnection({
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
        ],
      });

      syncLocalTracksToPeer(pc, isInitiator);

      pc.onicecandidate = (ev) => {
        if (ev.candidate) {
          sendJsonRef.current({
            type: 'majalis:signal',
            targetUserId: remoteUserId,
            signal: { candidate: ev.candidate },
          });
        }
      };

      pc.oniceconnectionstatechange = () => {
        if (pc.iceConnectionState === 'failed' && typeof pc.restartIce === 'function') {
          try {
            pc.restartIce();
          } catch {
            // ignore
          }
        }
      };

      pc.ontrack = (ev) => {
        const stream = ev.streams[0] ?? new MediaStream([ev.track]);
        setPeers((prev) =>
          prev.some((p) => p.userId === remoteUserId)
            ? prev.map((p) => (p.userId === remoteUserId ? { ...p, stream } : p))
            : [
                ...prev,
                {
                  userId: remoteUserId,
                  displayName: remoteName,
                  avatarAssetId: null,
                  mode: 'media',
                  micMuted: false,
                  camOff: true,
                  screenSharing: false,
                  handRaised: false,
                  joinedAt: Date.now(),
                  stream,
                },
              ]
        );
      };

      peerConnectionsRef.current.set(remoteUserId, pc);
      return pc;
    },
    [syncLocalTracksToPeer]
  );

  const renegotiateWithPeer = useCallback(async (remoteUserId: string, pc: RTCPeerConnection) => {
    try {
      makingOfferRef.current.set(remoteUserId, true);
      const offer = await pc.createOffer();
      if (pc.signalingState !== 'stable') return;
      await pc.setLocalDescription(offer);
      sendJsonRef.current({
        type: 'majalis:signal',
        targetUserId: remoteUserId,
        signal: { sdp: pc.localDescription },
      });
    } catch {
      // Ignore transient signaling race
    } finally {
      makingOfferRef.current.set(remoteUserId, false);
    }
  }, []);

  const mergeParticipantsWithStreams = useCallback(
    (serverList: MajalisParticipantInfo[]) => {
      const remoteOnly = serverList.filter((p) => p.userId !== user?.id);
      setPeers((prev) => {
        const streamById = new Map(prev.map((p) => [p.userId, p.stream]));
        return remoteOnly.map((p) => ({
          ...p,
          stream: streamById.get(p.userId) ?? null,
        }));
      });
    },
    [user?.id]
  );

  const handleWsEvent = useCallback(
    async (ev: WsServerEvent) => {
      if (ev.type === 'majalis:lobby_updated' && Array.isArray(ev.rooms)) {
        setRooms(ev.rooms as MajalisRoomSummary[]);
        return;
      }

      if (!joinedRef.current) return;
      const currentRoom = activeRoomIdRef.current;
      if (ev.roomId && currentRoom && String(ev.roomId) !== currentRoom) {
        return;
      }

      if (ev.type === 'majalis:peers' && Array.isArray(ev.peers)) {
        const peerList = ev.peers as MajalisParticipantInfo[];
        mergeParticipantsWithStreams(peerList);
        if (ev.timer) {
          setTimer(ev.timer as MajalisTimerState);
        }
        if (config.meetingMode === 'builtin') {
          for (const p of peerList) {
            const pc = createPeerConnection(p.userId, p.displayName, true);
            await renegotiateWithPeer(p.userId, pc);
          }
        }
        return;
      }

      if (ev.type === 'majalis:room_state') {
        if (Array.isArray(ev.participants)) {
          mergeParticipantsWithStreams(ev.participants as MajalisParticipantInfo[]);
        }
        if (ev.timer) {
          setTimer(ev.timer as MajalisTimerState);
        }
        return;
      }

      if (ev.type === 'majalis:timer_updated' && ev.timer) {
        setTimer(ev.timer as MajalisTimerState);
        return;
      }

      if (ev.type === 'majalis:chat_message' && ev.message) {
        const incoming = ev.message as MajalisChatMessageRecord;
        setMessages((prev) =>
          prev.some((m) => m.id === incoming.id) ? prev : [...prev, incoming]
        );
        return;
      }

      if (ev.type === 'majalis:peer_joined') {
        const info = (ev.participant as MajalisParticipantInfo | undefined) ?? {
          userId: String(ev.userId),
          displayName: String(ev.displayName || 'زميل'),
          avatarAssetId: null,
          mode: 'listener' as const,
          micMuted: true,
          camOff: true,
          screenSharing: false,
          handRaised: false,
          joinedAt: Date.now(),
        };
        if (info.userId === user?.id) return;
        setPeers((prev) =>
          prev.some((p) => p.userId === info.userId)
            ? prev.map((p) => (p.userId === info.userId ? { ...p, ...info } : p))
            : [...prev, { ...info, stream: null }]
        );
        return;
      }

      if (ev.type === 'majalis:peer_left') {
        const uId = String(ev.userId);
        peerConnectionsRef.current.get(uId)?.close();
        peerConnectionsRef.current.delete(uId);
        pendingIceRef.current.delete(uId);
        makingOfferRef.current.delete(uId);
        setPeers((prev) => prev.filter((p) => p.userId !== uId));
        return;
      }

      if (ev.type === 'majalis:signal' && config.meetingMode === 'builtin') {
        const fromId = String(ev.fromUserId);
        const fromName = String(ev.fromDisplayName || 'زميل');
        const sig = ev.signal as { sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit };
        const pc = createPeerConnection(fromId, fromName, false);
        const polite = Boolean(user && user.id.localeCompare(fromId) < 0);

        if (sig.sdp) {
          const offerCollision =
            sig.sdp.type === 'offer' &&
            (Boolean(makingOfferRef.current.get(fromId)) || pc.signalingState !== 'stable');
          if (offerCollision && !polite) {
            return;
          }

          await pc.setRemoteDescription(new RTCSessionDescription(sig.sdp));

          const queued = pendingIceRef.current.get(fromId) ?? [];
          if (queued.length > 0) {
            pendingIceRef.current.delete(fromId);
            for (const cand of queued) {
              await pc.addIceCandidate(new RTCIceCandidate(cand)).catch(() => {});
            }
          }

          if (sig.sdp.type === 'offer') {
            syncLocalTracksToPeer(pc, false);
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            sendJsonRef.current({
              type: 'majalis:signal',
              targetUserId: fromId,
              signal: { sdp: pc.localDescription },
            });
          }
        } else if (sig.candidate) {
          if (!pc.remoteDescription) {
            const list = pendingIceRef.current.get(fromId) ?? [];
            list.push(sig.candidate);
            pendingIceRef.current.set(fromId, list);
          } else {
            await pc.addIceCandidate(new RTCIceCandidate(sig.candidate)).catch(() => {});
          }
        }
      }
    },
    [
      config.meetingMode,
      createPeerConnection,
      mergeParticipantsWithStreams,
      renegotiateWithPeer,
      syncLocalTracksToPeer,
      user,
    ]
  );

  const wsEnabled =
    Boolean(user) && (isViewVisible || joined) && config.meetingMode !== 'unconfigured';
  const { connected: wsConnected, sendJson } = useWebSocket(wsEnabled, handleWsEvent);
  sendJsonRef.current = sendJson;

  // Send majalis:join ONLY once the WebSocket connection is genuinely OPEN (also re-joins on reconnect)
  useEffect(() => {
    if (wsConnected && joined && activeRoomId) {
      sendJson({
        type: 'majalis:join',
        roomId: activeRoomId,
        mode: modeRef.current,
        micMuted: micMutedRef.current,
        camOff: camOffRef.current,
      });
    }
  }, [wsConnected, joined, activeRoomId, sendJson]);

  const requestWakeLock = useCallback(async () => {
    try {
      const nav = navigator as unknown as {
        wakeLock?: { request: (t: string) => Promise<{ release: () => Promise<void> }> };
      };
      if (nav.wakeLock && !wakeLockRef.current) {
        const lock = await nav.wakeLock.request('screen');
        wakeLockRef.current = lock;
        setWakeLockActive(true);
      }
    } catch {
      setWakeLockActive(false);
    }
  }, []);

  const joinMeeting = useCallback(
    async (roomId?: string, options?: { listenerOnly?: boolean }) => {
      if (config.meetingMode === 'unconfigured') {
        setPermissionNotice('لم يقم المشرف بضبط مزود مجلس المذاكرة بعد.');
        onToast('مجلس المذاكرة غير مُفعّل حالياً في إعدادات الإدارة', true);
        return;
      }

      const targetRoomId = roomId || rooms[0]?.id || 'room_general_hall';
      const existingRoom = rooms.find((r) => r.id === targetRoomId);
      if (existingRoom) {
        setTimer(existingRoom.timer);
      }

      setPermissionNotice(null);
      setJoining(true);

      if (config.meetingMode === 'external') {
        if (!config.meetingExternalUrl) {
          setPermissionNotice('رابط مزود الاجتماعات الخارجي غير مضبوط.');
          setJoining(false);
          return;
        }
        setActiveRoomId(targetRoomId);
        setMode('listener');
        setMicMuted(true);
        setCamOff(true);
        setJoined(true);
        setJoining(false);
        void loadRoomMessages(targetRoomId);
        return;
      }

      if (options?.listenerOnly || !navigator.mediaDevices?.getUserMedia) {
        const reason = !navigator.mediaDevices?.getUserMedia
          ? 'المتصفح الحالي لا يدعم تشغيل الكاميرا والميكروفون مباشرة، تم دخولك بوضع المستمع والمشاركة النصية.'
          : null;
        setMode('listener');
        setMicMuted(true);
        setCamOff(true);
        setLocalStream(null);
        localStreamRef.current = null;
        setPermissionNotice(reason);
        setActiveRoomId(targetRoomId);
        setJoined(true);
        setJoining(false);
        void loadRoomMessages(targetRoomId);
        void requestWakeLock();
        onToast('انضممت للمجلس بوضع المستمع والمشاركة النصية');
        return;
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
        localStreamRef.current = stream;
        setLocalStream(stream);
        setMode('media');
        setMicMuted(false);
        setCamOff(false);
        setActiveRoomId(targetRoomId);
        setJoined(true);
        void requestWakeLock();
      } catch {
        // Attempt audio-only fallback, then seamless Listener Mode fallback (never block entry)
        try {
          const audioOnly = await navigator.mediaDevices.getUserMedia({ audio: true });
          localStreamRef.current = audioOnly;
          setLocalStream(audioOnly);
          setMode('audio');
          setMicMuted(false);
          setCamOff(true);
          setActiveRoomId(targetRoomId);
          setJoined(true);
          onToast('تم الانضمام بالصوت فقط لعدم توفر الكاميرا');
          void requestWakeLock();
        } catch {
          localStreamRef.current = null;
          setLocalStream(null);
          setMode('listener');
          setMicMuted(true);
          setCamOff(true);
          setPermissionNotice(
            'تم دخول المجلس تلقائياً بوضع المستمع والمشاركة النصية لعدم توفر إذن الميكروفون أو الكاميرا.'
          );
          setActiveRoomId(targetRoomId);
          setJoined(true);
          onToast('تم دخول المجلس بوضع المستمع والمشاركة النصية');
          void requestWakeLock();
        }
      } finally {
        setJoining(false);
        void loadRoomMessages(targetRoomId);
      }
    },
    [config.meetingExternalUrl, config.meetingMode, loadRoomMessages, onToast, requestWakeLock, rooms]
  );

  const leaveMeeting = useCallback(() => {
    if (joinedRef.current) {
      sendJson({ type: 'majalis:leave' });
    }
    cleanupMediaAndPeers();
    setJoined(false);
    setActiveRoomId(null);
    setMessages([]);
    setPermissionNotice(null);
    void loadRooms(true);
  }, [cleanupMediaAndPeers, loadRooms, sendJson]);

  const upgradeMedia = useCallback(
    async (wantVideo = false) => {
      if (!navigator.mediaDevices?.getUserMedia) {
        onToast('المتصفح الحالي لا يدعم الوصول للميكروفون أو الكاميرا', true);
        return;
      }

      try {
        const constraints = wantVideo ? { audio: true, video: true } : { audio: true };
        const stream = await navigator.mediaDevices.getUserMedia(constraints);

        localStreamRef.current?.getTracks().forEach((t) => t.stop());
        localStreamRef.current = stream;
        setLocalStream(stream);

        const hasVideo = stream.getVideoTracks().length > 0;
        const nextMode: MajalisParticipationMode = hasVideo ? 'media' : 'audio';
        setMode(nextMode);
        setMicMuted(false);
        setCamOff(!hasVideo);
        setPermissionNotice(null);

        for (const [remoteId, pc] of peerConnectionsRef.current.entries()) {
          syncLocalTracksToPeer(pc, true);
          await renegotiateWithPeer(remoteId, pc);
        }

        sendJson({
          type: 'majalis:state',
          mode: nextMode,
          micMuted: false,
          camOff: !hasVideo,
        });
        onToast(hasVideo ? 'تم تفعيل الصوت والكاميرا' : 'تم تفعيل الميكروفون');
      } catch {
        onToast('تعذر الوصول للميكروفون أو الكاميرا من إعدادات المتصفح', true);
      }
    },
    [onToast, renegotiateWithPeer, sendJson, syncLocalTracksToPeer]
  );

  const switchToListener = useCallback(() => {
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    localStreamRef.current = null;
    setLocalStream(null);
    setScreenSharing(false);
    setMode('listener');
    setMicMuted(true);
    setCamOff(true);

    for (const pc of peerConnectionsRef.current.values()) {
      for (const sender of pc.getSenders()) {
        if (sender.track) {
          void sender.replaceTrack(null).catch(() => {});
        }
      }
    }

    sendJson({
      type: 'majalis:state',
      mode: 'listener',
      micMuted: true,
      camOff: true,
      screenSharing: false,
    });
    onToast('تحولت إلى وضع المستمع الهادئ');
  }, [onToast, sendJson]);

  const toggleMic = useCallback(async () => {
    const stream = localStreamRef.current;
    if (!stream || stream.getAudioTracks().length === 0) {
      await upgradeMedia(false);
      return;
    }
    const nextMuted = !micMutedRef.current;
    stream.getAudioTracks().forEach((t) => {
      t.enabled = !nextMuted;
    });
    setMicMuted(nextMuted);
    sendJson({ type: 'majalis:state', micMuted: nextMuted });
  }, [sendJson, upgradeMedia]);

  const toggleCam = useCallback(async () => {
    const stream = localStreamRef.current;
    if (!stream || stream.getVideoTracks().length === 0) {
      await upgradeMedia(true);
      return;
    }
    const nextOff = !camOffRef.current;
    stream.getVideoTracks().forEach((t) => {
      t.enabled = !nextOff;
    });
    setCamOff(nextOff);
    const nextMode: MajalisParticipationMode = nextOff ? 'audio' : 'media';
    setMode(nextMode);
    sendJson({ type: 'majalis:state', camOff: nextOff, mode: nextMode });
  }, [sendJson, upgradeMedia]);

  const stopScreenShareInternal = useCallback(async () => {
    screenStreamRef.current?.getTracks().forEach((t) => t.stop());
    screenStreamRef.current = null;

    const prevCam = cameraTrackBeforeShareRef.current;
    cameraTrackBeforeShareRef.current = null;

    const currentLocal = localStreamRef.current;
    if (currentLocal) {
      currentLocal.getVideoTracks().forEach((t) => currentLocal.removeTrack(t));
      if (prevCam && prevCam.readyState === 'live') {
        currentLocal.addTrack(prevCam);
        setLocalStream(new MediaStream(currentLocal.getTracks()));
        for (const pc of peerConnectionsRef.current.values()) {
          const videoSender = pc.getSenders().find((s) => s.track?.kind === 'video');
          if (videoSender) {
            await videoSender.replaceTrack(prevCam).catch(() => {});
          }
        }
        setCamOff(!prevCam.enabled);
      } else {
        setLocalStream(
          currentLocal.getAudioTracks().length > 0
            ? new MediaStream(currentLocal.getAudioTracks())
            : null
        );
        for (const pc of peerConnectionsRef.current.values()) {
          const videoSender = pc.getSenders().find((s) => s.track?.kind === 'video');
          if (videoSender) {
            await videoSender.replaceTrack(null).catch(() => {});
          }
        }
        setCamOff(true);
      }
    }

    setScreenSharing(false);
    sendJson({ type: 'majalis:state', screenSharing: false });
  }, [sendJson]);

  const toggleScreenShare = useCallback(async () => {
    if (screenSharing) {
      await stopScreenShareInternal();
      return;
    }
    if (!navigator.mediaDevices?.getDisplayMedia) {
      onToast('مشاركة الشاشة غير مدعومة في هذا المتصفح', true);
      return;
    }
    try {
      const displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const screenTrack = displayStream.getVideoTracks()[0];
      if (!screenTrack) return;

      screenStreamRef.current = displayStream;
      const currentLocal = localStreamRef.current ?? new MediaStream();
      const existingCam = currentLocal.getVideoTracks()[0] ?? null;
      if (existingCam) {
        cameraTrackBeforeShareRef.current = existingCam;
        currentLocal.removeTrack(existingCam);
      }
      currentLocal.addTrack(screenTrack);
      localStreamRef.current = currentLocal;
      setLocalStream(new MediaStream(currentLocal.getTracks()));
      setScreenSharing(true);
      setCamOff(false);

      screenTrack.onended = () => {
        void stopScreenShareInternal();
      };

      for (const [remoteId, pc] of peerConnectionsRef.current.entries()) {
        const videoSender = pc.getSenders().find((s) => s.track?.kind === 'video');
        if (videoSender) {
          await videoSender.replaceTrack(screenTrack).catch(() => {});
        } else {
          pc.addTrack(screenTrack, currentLocal);
          await renegotiateWithPeer(remoteId, pc);
        }
      }

      sendJson({ type: 'majalis:state', screenSharing: true, camOff: false });
    } catch {
      onToast('تم إلغاء مشاركة الشاشة أو تعذر بدء البث', true);
    }
  }, [onToast, renegotiateWithPeer, screenSharing, sendJson, stopScreenShareInternal]);

  const toggleHandRaise = useCallback(() => {
    const next = !handRaised;
    setHandRaised(next);
    sendJson({ type: 'majalis:state', handRaised: next });
  }, [handRaised, sendJson]);

  const controlTimer = useCallback(
    async (action: 'start' | 'pause' | 'reset' | 'preset', phase?: MajalisTimerPhase) => {
      const rId = activeRoomIdRef.current;
      if (!rId) return;
      const sent = sendJson({ type: 'majalis:timer', action, phase });
      if (!sent) {
        try {
          const res = await apiRequest<{ timer: MajalisTimerState }>(
            `/api/majalis/rooms/${encodeURIComponent(rId)}/timer`,
            { method: 'POST', body: { action, phase } }
          );
          setTimer(res.timer);
        } catch (err) {
          onToast(err instanceof ApiError ? err.message : 'تعذر تحديث المؤقت الجماعي', true);
        }
      }
    },
    [onToast, sendJson]
  );

  const sendRoomMessage = useCallback(
    async (body: string) => {
      const rId = activeRoomIdRef.current;
      const trimmed = body.trim();
      if (!rId || !trimmed) return;
      const sent = sendJson({ type: 'majalis:chat', body: trimmed });
      if (!sent) {
        const res = await apiRequest<{ message: MajalisChatMessageRecord }>(
          `/api/majalis/rooms/${encodeURIComponent(rId)}/messages`,
          { method: 'POST', body: { body: trimmed } }
        );
        setMessages((prev) =>
          prev.some((m) => m.id === res.message.id) ? prev : [...prev, res.message]
        );
      }
    },
    [sendJson]
  );

  const createRoom = useCallback(
    async (payload: { title: string; subjectId: string | null }) => {
      const res = await apiRequest<{ room: MajalisRoomSummary }>('/api/majalis/rooms', {
        method: 'POST',
        body: payload,
      });
      setRooms((prev) =>
        prev.some((r) => r.id === res.room.id) ? prev : [...prev, res.room]
      );
      return res.room;
    },
    []
  );

  const deleteRoom = useCallback(async (roomId: string) => {
    await apiRequest(`/api/majalis/rooms/${encodeURIComponent(roomId)}`, {
      method: 'DELETE',
    });
    setRooms((prev) => prev.filter((r) => r.id !== roomId));
  }, []);

  const openExternalTab = useCallback(() => {
    if (config.meetingMode === 'external' && config.meetingExternalUrl) {
      window.open(config.meetingExternalUrl, '_blank', 'noopener,noreferrer');
    } else {
      onToast('المجلس المدمج يعمل مباشرة داخل هذه الصفحة بالصوت والفيديو والمؤقت والمحادثة.');
    }
  }, [config.meetingExternalUrl, config.meetingMode, onToast]);

  useEffect(() => {
    return () => {
      cleanupMediaAndPeers();
    };
  }, [cleanupMediaAndPeers]);

  const activeRoom = useMemo(
    () => rooms.find((r) => r.id === activeRoomId) ?? null,
    [rooms, activeRoomId]
  );

  return {
    rooms,
    roomsLoading,
    roomsError,
    subjects,
    activeRoom,
    activeRoomId,
    joined,
    joining,
    wsConnected,
    mode,
    permissionNotice,
    micMuted,
    camOff,
    screenSharing,
    handRaised,
    localStream,
    peers,
    timer,
    remainingMs,
    messages,
    messagesLoading,
    wakeLockActive,
    refreshRooms: () => loadRooms(false),
    createRoom,
    deleteRoom,
    joinMeeting,
    leaveMeeting,
    toggleMic,
    toggleCam,
    toggleScreenShare,
    toggleHandRaise,
    switchToListener,
    upgradeMedia,
    controlTimer,
    sendRoomMessage,
    dismissNotice: () => setPermissionNotice(null),
    openExternalTab,
  };
}

function PeerAudioTrack({ stream }: { stream: MediaStream }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.srcObject = stream;
    }
  }, [stream]);

  return <audio ref={audioRef} autoPlay playsInline className="hidden" />;
}

/**
 * Always-mounted remote audio player so participants remain audible when cameras are off
 * OR when the user navigates to another tab with the floating panel open.
 */
export function MajalisAudioBridge({ controller }: { controller: MajalisController }) {
  if (!controller.joined) return null;
  return (
    <div aria-hidden="true" className="hidden">
      {controller.peers
        .filter((p) => p.stream && p.stream.getAudioTracks().length > 0)
        .map((p) => (
          <PeerAudioTrack key={p.userId} stream={p.stream!} />
        ))}
    </div>
  );
}

function VideoStreamTile({
  stream,
  label,
  avatarAssetId,
  mode,
  micMuted,
  camOff,
  screenSharing,
  handRaised,
  isSelf = false,
}: {
  stream: MediaStream | null;
  label: string;
  avatarAssetId?: string | null;
  mode: MajalisParticipationMode;
  micMuted: boolean;
  camOff: boolean;
  screenSharing: boolean;
  handRaised: boolean;
  isSelf?: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hasEnabledVideo = Boolean(
    stream &&
      !camOff &&
      stream.getVideoTracks().some((t) => t.readyState === 'live' && t.enabled)
  );

  useEffect(() => {
    if (videoRef.current && stream && hasEnabledVideo) {
      videoRef.current.srcObject = stream;
    }
  }, [stream, hasEnabledVideo]);

  return (
    <div
      className={`relative rounded-2xl overflow-hidden bg-[var(--bg-surface)] border aspect-video flex items-center justify-center transition-colors ${
        handRaised ? 'border-[var(--accent)]' : 'border-[var(--divider)]'
      }`}
    >
      {hasEnabledVideo ? (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className={`w-full h-full ${screenSharing ? 'object-contain bg-black' : 'object-cover'}`}
        />
      ) : (
        <div className="flex flex-col items-center gap-2.5 text-center px-3">
          <Avatar name={label} assetId={avatarAssetId} size="lg" />
          <div className="space-y-0.5">
            <div className="text-xs font-extrabold text-[var(--text-primary)]">{label}</div>
            <div className="text-[11px] text-[var(--text-secondary)]">
              {mode === 'listener'
                ? 'وضع المستمع'
                : micMuted
                ? 'الميكروفون مكتوم'
                : 'متصل بالصوت'}
            </div>
          </div>
        </div>
      )}

      {/* Subtle status scrim */}
      <div className="absolute inset-x-0 bottom-0 px-3 py-2 bg-gradient-to-t from-black/75 via-black/35 to-transparent flex items-center justify-between gap-2 text-white">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-xs font-bold truncate">
            {label}
            {isSelf ? ' (أنت)' : ''}
          </span>
          {screenSharing && (
            <span className="text-[10px] font-semibold text-amber-300 shrink-0">
              · مشاركة شاشة
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {handRaised && (
            <span
              title="يرفع يده"
              className="w-6 h-6 rounded-lg bg-[var(--accent)] text-[var(--accent-fg)] flex items-center justify-center"
            >
              <Icons.Hand className="w-3.5 h-3.5" />
            </span>
          )}
          {mode === 'listener' ? (
            <span
              title="مستمع"
              className="w-6 h-6 rounded-lg bg-white/15 text-white flex items-center justify-center"
            >
              <Icons.Headphones className="w-3.5 h-3.5" />
            </span>
          ) : micMuted ? (
            <span
              title="الميكروفون مكتوم"
              className="w-6 h-6 rounded-lg bg-[var(--error)]/90 text-white flex items-center justify-center"
            >
              <Icons.MicOff className="w-3.5 h-3.5" />
            </span>
          ) : (
            <span
              title="الميكروفون مفتوح"
              className="w-6 h-6 rounded-lg bg-[var(--success)]/90 text-white flex items-center justify-center"
            >
              <Icons.Mic className="w-3.5 h-3.5" />
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

export function MajalisView({
  config,
  user,
  controller,
  onToast,
}: {
  config: AppPublicConfig;
  user: AuthUser;
  controller: MajalisController;
  onToast: (msg: string, isError?: boolean) => void;
}) {
  const [createOpen, setCreateOpen] = useState(false);
  const [newRoomTitle, setNewRoomTitle] = useState('');
  const [newRoomSubjectId, setNewRoomSubjectId] = useState('');
  const [createBusy, setCreateBusy] = useState(false);
  const [roomToDelete, setRoomToDelete] = useState<MajalisRoomSummary | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const [chatInput, setChatInput] = useState('');
  const [chatBusy, setChatBusy] = useState(false);
  const chatBottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [controller.messages.length]);

  const handleCreateRoom = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreateBusy(true);
    try {
      const created = await controller.createRoom({
        title: newRoomTitle.trim(),
        subjectId: newRoomSubjectId || null,
      });
      setCreateOpen(false);
      setNewRoomTitle('');
      setNewRoomSubjectId('');
      onToast(`تم إنشاء مجلس «${created.title}»`);
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'تعذر إنشاء المجلس', true);
    } finally {
      setCreateBusy(false);
    }
  };

  const handleConfirmDeleteRoom = async () => {
    if (!roomToDelete) return;
    setDeleteBusy(true);
    try {
      await controller.deleteRoom(roomToDelete.id);
      setRoomToDelete(null);
      onToast('تم حذف المجلس');
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'تعذر حذف المجلس', true);
    } finally {
      setDeleteBusy(false);
    }
  };

  const handleSendChat = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = chatInput.trim();
    if (!trimmed || chatBusy) return;
    setChatBusy(true);
    try {
      await controller.sendRoomMessage(trimmed);
      setChatInput('');
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'تعذر إرسال الرسالة', true);
    } finally {
      setChatBusy(false);
    }
  };

  // LOBBY VIEW (before joining any room)
  if (!controller.joined) {
    return (
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl sm:text-2xl font-extrabold text-[var(--text-primary)]">
              مجالس المذاكرة الجماعية
            </h1>
            <p className="text-xs sm:text-sm text-[var(--text-secondary)] mt-0.5">
              اختر مجلساً للانضمام بالصوت والصورة أو بوضع المستمع الهادئ مع المؤقت الجماعي والمحادثة الفورية
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void controller.refreshRooms()}
              className="min-h-[42px] px-3.5 rounded-xl rahhala-glass-pill text-xs font-bold text-[var(--text-primary)] hover:border-[var(--accent)] flex items-center gap-1.5 whitespace-nowrap"
            >
              <Icons.Refresh className="w-4 h-4" />
              <span>تحديث</span>
            </button>

            <button
              type="button"
              onClick={() => setCreateOpen(true)}
              className="min-h-[42px] px-4 rounded-xl bg-[var(--accent)] text-[var(--accent-fg)] text-xs sm:text-sm font-bold flex items-center gap-1.5 hover:bg-[var(--accent-hi)] whitespace-nowrap"
            >
              <Icons.Plus className="w-4 h-4" />
              <span>إنشاء مجلس جديد</span>
            </button>
          </div>
        </div>

        {config.meetingMode === 'unconfigured' && (
          <div className="rahhala-card p-4 text-xs text-[var(--text-secondary)]">
            وضع المجالس معطّل مؤقتاً من إعدادات الإدارة. يمكن للمشرف تفعيل الوضع المدمج أو إضافة رابط خارجي من لوحة الإدارة.
          </div>
        )}

        {controller.permissionNotice && (
          <div
            role="status"
            className="rahhala-card p-4 flex items-center justify-between gap-3 border-[var(--accent)]/40 text-xs font-semibold text-[var(--text-primary)]"
          >
            <span>{controller.permissionNotice}</span>
            <button
              type="button"
              onClick={controller.dismissNotice}
              aria-label="إخفاء التنبيه"
              className="min-h-[34px] min-w-[34px] rounded-lg hover:bg-[var(--bg-surface)] flex items-center justify-center"
            >
              <Icons.X className="w-4 h-4" />
            </button>
          </div>
        )}

        {controller.roomsLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {[1, 2, 3].map((k) => (
              <div key={k} className="rahhala-card h-52 animate-pulse" />
            ))}
          </div>
        ) : controller.roomsError ? (
          <div className="rahhala-card p-6">
            <ErrorRetryPanel message={controller.roomsError} onRetry={controller.refreshRooms} />
          </div>
        ) : controller.rooms.length === 0 ? (
          <div className="rahhala-card p-8">
            <EmptyState
              icon={<Icons.Video className="w-6 h-6" />}
              title="لا توجد مجالس متاحة حالياً"
              subtitle="أنشئ مجلس مذاكرة جديداً وابدأ جلسة جماعية مع زملائك."
            />
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {controller.rooms.map((room) => {
              const isModerator = user.role === 'admin' || user.role === 'owner';
              const canDelete = !room.isDefault && (isModerator || room.creatorId === user.id);

              return (
                <article
                  key={room.id}
                  className="rahhala-card p-5 flex flex-col justify-between gap-4"
                >
                  <div className="space-y-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 space-y-1">
                        <div className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
                          <span
                            className="w-2.5 h-2.5 rounded-full shrink-0"
                            style={{ backgroundColor: room.subjectColor }}
                            aria-hidden="true"
                          />
                          <span className="font-bold text-[var(--text-primary)] truncate">
                            {room.subjectName}
                          </span>
                          <span aria-hidden="true">·</span>
                          <span className="tabular-nums shrink-0">
                            {room.activeCount > 0 ? `${room.activeCount} متصل` : 'هادئ'}
                          </span>
                        </div>
                        <h2 className="text-base font-extrabold text-[var(--text-primary)] leading-snug">
                          {room.title}
                        </h2>
                      </div>

                      {canDelete && (
                        <button
                          type="button"
                          onClick={() => setRoomToDelete(room)}
                          aria-label={`حذف مجلس ${room.title}`}
                          className="min-h-[36px] min-w-[36px] rounded-xl bg-[var(--bg-surface)] text-[var(--text-secondary)] hover:text-[var(--error)] hover:bg-[var(--error-soft)] flex items-center justify-center shrink-0"
                        >
                          <Icons.Trash className="w-4 h-4" />
                        </button>
                      )}
                    </div>

                    <div className="flex items-center justify-between gap-2 text-xs text-[var(--text-secondary)] pt-2 border-t border-[var(--divider)] tabular-nums">
                      <span>{TIMER_PHASE_LABELS[room.timer.phase]}</span>
                      <span className="font-bold text-[var(--text-primary)]">
                        {room.timer.running ? 'المؤقت يعمل' : formatCountdownMs(room.timer.remainingMs)}
                      </span>
                    </div>

                    {room.participants.length > 0 && (
                      <div className="flex items-center gap-1.5 pt-1">
                        <div className="flex -space-x-2 space-x-reverse">
                          {room.participants.slice(0, 4).map((p) => (
                            <Avatar
                              key={p.userId}
                              name={p.displayName}
                              assetId={p.avatarAssetId}
                              size="sm"
                            />
                          ))}
                        </div>
                        <span className="text-[11px] text-[var(--text-secondary)] truncate">
                          {room.participants.map((p) => p.displayName).slice(0, 2).join('، ')}
                          {room.participants.length > 2 ? ` +${room.participants.length - 2}` : ''}
                        </span>
                      </div>
                    )}
                  </div>

                  <div className="flex flex-col sm:flex-row gap-2 pt-1">
                    <button
                      type="button"
                      disabled={controller.joining || config.meetingMode === 'unconfigured'}
                      onClick={() => void controller.joinMeeting(room.id)}
                      className="flex-1 min-h-[44px] px-4 rounded-xl bg-[var(--accent)] text-[var(--accent-fg)] text-xs sm:text-sm font-bold flex items-center justify-center gap-1.5 hover:bg-[var(--accent-hi)] disabled:opacity-50 whitespace-nowrap"
                    >
                      <Icons.Video className="w-4 h-4" />
                      <span>{controller.joining ? 'جاري الدخول...' : 'انضم للمجلس'}</span>
                    </button>

                    <button
                      type="button"
                      disabled={controller.joining || config.meetingMode === 'unconfigured'}
                      onClick={() => void controller.joinMeeting(room.id, { listenerOnly: true })}
                      className="min-h-[44px] px-3.5 rounded-xl bg-[var(--bg-surface)] border border-[var(--divider)] hover:border-[var(--accent)] text-xs font-bold text-[var(--text-primary)] flex items-center justify-center gap-1.5 disabled:opacity-50 whitespace-nowrap"
                    >
                      <Icons.Headphones className="w-4 h-4 text-[var(--accent)]" />
                      <span>مستمع</span>
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        )}

        {/* Create Custom Room Modal */}
        <ModalShell
          open={createOpen}
          onClose={() => setCreateOpen(false)}
          title="إنشاء مجلس مذاكرة جديد"
          maxWidth="max-w-md"
        >
          <form onSubmit={handleCreateRoom} className="space-y-4">
            <div>
              <label
                htmlFor="majalis-room-title"
                className="block text-xs font-bold text-[var(--text-secondary)] mb-1.5"
              >
                اسم المجلس أو موضوع المذاكرة
              </label>
              <input
                id="majalis-room-title"
                type="text"
                required
                minLength={3}
                maxLength={60}
                value={newRoomTitle}
                onChange={(e) => setNewRoomTitle(e.target.value)}
                placeholder="مثال: مراجعة الفصل الثالث في البلاغة"
                className="rahhala-input w-full px-3.5 py-2 text-sm"
              />
            </div>

            <div>
              <label
                htmlFor="majalis-room-subject"
                className="block text-xs font-bold text-[var(--text-secondary)] mb-1.5"
              >
                المادة المرتبطة (اختياري)
              </label>
              <select
                id="majalis-room-subject"
                value={newRoomSubjectId}
                onChange={(e) => setNewRoomSubjectId(e.target.value)}
                className="rahhala-input w-full px-3.5 py-2 text-sm"
              >
                <option value="">مذاكرة جماعية عامة</option>
                {controller.subjects.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>

            <button
              type="submit"
              disabled={createBusy}
              className="w-full min-h-[46px] rounded-xl bg-[var(--accent)] text-[var(--accent-fg)] font-bold text-sm hover:bg-[var(--accent-hi)] disabled:opacity-60"
            >
              {createBusy ? 'جاري الإنشاء...' : 'فتح المجلس للدفعة'}
            </button>
          </form>
        </ModalShell>

        <ConfirmDialog
          open={Boolean(roomToDelete)}
          onClose={() => setRoomToDelete(null)}
          onConfirm={handleConfirmDeleteRoom}
          title="حذف مجلس المذاكرة"
          message={`هل تريد حذف مجلس «${roomToDelete?.title ?? ''}»؟`}
          confirmLabel="حذف المجلس"
          destructive
          busy={deleteBusy}
        />
      </div>
    );
  }

  // ACTIVE ROOM VIEW
  const totalParticipants = controller.peers.length + 1;
  const phaseDurations: MajalisTimerPhase[] = ['focus', 'review', 'break'];

  return (
    <div className="space-y-4">
      {/* Room Header & Media Controls */}
      <div className="rahhala-card p-4 flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--text-secondary)]">
            <span className="font-bold text-[var(--accent)]">
              {controller.activeRoom?.subjectName || 'مذاكرة جماعية'}
            </span>
            <span aria-hidden="true">·</span>
            <span className="tabular-nums">{totalParticipants} مشارك</span>
            <span aria-hidden="true">·</span>
            <span>{modeLabel(controller.mode)}</span>
            {!controller.wsConnected && (
              <>
                <span aria-hidden="true">·</span>
                <span className="text-[var(--error)] font-semibold">جاري إعادة الاتصال…</span>
              </>
            )}
          </div>
          <h1 className="text-lg font-extrabold text-[var(--text-primary)] truncate mt-0.5">
            {controller.activeRoom?.title || 'مجلس المذاكرة النشط'}
          </h1>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {config.meetingMode === 'builtin' && (
            <>
              <button
                type="button"
                onClick={() => void controller.toggleMic()}
                className={`min-h-[42px] px-3.5 rounded-xl border text-xs font-bold flex items-center gap-1.5 whitespace-nowrap ${
                  controller.mode === 'listener' || controller.micMuted
                    ? 'bg-[var(--bg-surface)] border-[var(--divider)] text-[var(--text-primary)] hover:border-[var(--accent)]'
                    : 'bg-[var(--success-soft)] border-[var(--success)]/40 text-[var(--success)]'
                }`}
              >
                {controller.mode === 'listener' || controller.micMuted ? (
                  <Icons.MicOff className="w-4 h-4" />
                ) : (
                  <Icons.Mic className="w-4 h-4" />
                )}
                <span>
                  {controller.mode === 'listener'
                    ? 'تفعيل الميكروفون'
                    : controller.micMuted
                    ? 'فتح الميكروفون'
                    : 'كتم الميكروفون'}
                </span>
              </button>

              <button
                type="button"
                onClick={() => void controller.toggleCam()}
                className={`min-h-[42px] px-3.5 rounded-xl border text-xs font-bold flex items-center gap-1.5 whitespace-nowrap ${
                  controller.camOff
                    ? 'bg-[var(--bg-surface)] border-[var(--divider)] text-[var(--text-primary)] hover:border-[var(--accent)]'
                    : 'bg-[var(--accent-soft)] border-[var(--accent)]/40 text-[var(--accent)]'
                }`}
              >
                {controller.camOff ? (
                  <Icons.VideoOff className="w-4 h-4" />
                ) : (
                  <Icons.Video className="w-4 h-4" />
                )}
                <span>{controller.camOff ? 'تشغيل الكاميرا' : 'إغلاق الكاميرا'}</span>
              </button>

              <button
                type="button"
                onClick={() => void controller.toggleScreenShare()}
                className={`min-h-[42px] px-3.5 rounded-xl border text-xs font-bold flex items-center gap-1.5 whitespace-nowrap ${
                  controller.screenSharing
                    ? 'bg-[var(--accent-soft)] border-[var(--accent)] text-[var(--accent)]'
                    : 'bg-[var(--bg-surface)] border-[var(--divider)] text-[var(--text-primary)] hover:border-[var(--accent)]'
                }`}
              >
                <Icons.Monitor className="w-4 h-4" />
                <span>{controller.screenSharing ? 'إيقاف الشاشة' : 'مشاركة الشاشة'}</span>
              </button>

              {controller.mode !== 'listener' && (
                <button
                  type="button"
                  onClick={controller.switchToListener}
                  className="min-h-[42px] px-3 rounded-xl bg-[var(--bg-surface)] border border-[var(--divider)] hover:border-[var(--accent)] text-xs font-semibold text-[var(--text-secondary)] flex items-center gap-1.5 whitespace-nowrap"
                >
                  <Icons.Headphones className="w-4 h-4" />
                  <span>وضع المستمع</span>
                </button>
              )}
            </>
          )}

          <button
            type="button"
            onClick={controller.toggleHandRaise}
            className={`min-h-[42px] px-3.5 rounded-xl border text-xs font-bold flex items-center gap-1.5 whitespace-nowrap ${
              controller.handRaised
                ? 'bg-[var(--accent)] text-[var(--accent-fg)] border-transparent'
                : 'bg-[var(--bg-surface)] border-[var(--divider)] text-[var(--text-primary)] hover:border-[var(--accent)]'
            }`}
          >
            <Icons.Hand className="w-4 h-4" />
            <span>{controller.handRaised ? 'خفض اليد' : 'رفع اليد'}</span>
          </button>

          {config.meetingMode === 'external' && config.meetingExternalUrl && (
            <button
              type="button"
              onClick={controller.openExternalTab}
              className="min-h-[42px] px-3.5 rounded-xl bg-[var(--bg-surface)] border border-[var(--divider)] text-xs font-bold flex items-center gap-1.5 whitespace-nowrap"
            >
              <Icons.ExternalLink className="w-4 h-4" />
              <span>افتح في نافذة</span>
            </button>
          )}

          <button
            type="button"
            onClick={controller.leaveMeeting}
            className="min-h-[42px] px-4 rounded-xl bg-[var(--error)] text-white text-xs font-bold whitespace-nowrap"
          >
            مغادرة المجلس
          </button>
        </div>
      </div>

      {/* Non-blocking Listener Fallback Notice */}
      {controller.permissionNotice && (
        <div
          role="status"
          className="rahhala-card px-4 py-3 flex flex-wrap items-center justify-between gap-3 border-[var(--accent)]/40 text-xs"
        >
          <div className="flex items-center gap-2 text-[var(--text-primary)] font-semibold">
            <Icons.Headphones className="w-4 h-4 text-[var(--accent)] shrink-0" />
            <span>{controller.permissionNotice}</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void controller.upgradeMedia(false)}
              className="min-h-[34px] px-3 rounded-lg bg-[var(--accent-soft)] text-[var(--accent)] font-bold hover:opacity-90 whitespace-nowrap"
            >
              إعادة محاولة الميكروفون
            </button>
            <button
              type="button"
              onClick={controller.dismissNotice}
              aria-label="إغلاق الملاحظة"
              className="min-h-[34px] min-w-[34px] rounded-lg hover:bg-[var(--bg-surface)] flex items-center justify-center text-[var(--text-secondary)]"
            >
              <Icons.X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Workspace Split: Main Media Stage + Companion Study Timer & Live Chat */}
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_340px] gap-4 items-start">
        {/* Left/Main Stage */}
        <div className="space-y-4 min-w-0">
          {config.meetingMode === 'external' && config.meetingExternalUrl ? (
            <div className="rahhala-card overflow-hidden h-[62dvh]">
              <iframe
                src={config.meetingExternalUrl}
                title="مجلس المذاكرة"
                allow="camera; microphone; fullscreen; display-capture"
                className="w-full h-full border-0"
              />
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
              <VideoStreamTile
                stream={controller.localStream}
                label={user.displayName}
                avatarAssetId={user.avatarAssetId}
                mode={controller.mode}
                micMuted={controller.micMuted}
                camOff={controller.camOff}
                screenSharing={controller.screenSharing}
                handRaised={controller.handRaised}
                isSelf
              />
              {controller.peers.map((p) => (
                <VideoStreamTile
                  key={p.userId}
                  stream={p.stream}
                  label={p.displayName}
                  avatarAssetId={p.avatarAssetId}
                  mode={p.mode}
                  micMuted={p.micMuted}
                  camOff={p.camOff}
                  screenSharing={p.screenSharing}
                  handRaised={p.handRaised}
                />
              ))}
            </div>
          )}
        </div>

        {/* Right Companion Panel: Synchronized Pomodoro Timer + Live Room Chat */}
        <div className="space-y-4">
          {/* Synchronized Group Timer */}
          <section className="rahhala-card p-4 space-y-3.5">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-extrabold text-[var(--text-primary)] flex items-center gap-2">
                <Icons.Clock className="w-4 h-4 text-[var(--accent)]" />
                <span>المؤقت الجماعي المتزامن</span>
              </h2>
              <span className="text-[11px] font-bold text-[var(--text-secondary)]">
                {controller.timer.running ? 'يعمل للجميع' : 'متوقف'}
              </span>
            </div>

            <div className="grid grid-cols-3 gap-1.5">
              {phaseDurations.map((ph) => {
                const active = controller.timer.phase === ph;
                return (
                  <button
                    key={ph}
                    type="button"
                    onClick={() => void controller.controlTimer('preset', ph)}
                    className={`min-h-[34px] px-2 rounded-xl text-[11px] font-bold border transition-colors whitespace-nowrap ${
                      active
                        ? 'bg-[var(--accent-soft)] border-[var(--accent)] text-[var(--accent)]'
                        : 'bg-[var(--bg-surface)] border-[var(--divider)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                    }`}
                  >
                    {TIMER_PHASE_LABELS[ph]}
                  </button>
                );
              })}
            </div>

            <div className="py-2 text-center">
              <div className="text-4xl font-extrabold tracking-tight text-[var(--text-primary)] tabular-nums">
                {formatCountdownMs(controller.remainingMs)}
              </div>
              {controller.timer.updatedByName && (
                <div className="text-[11px] text-[var(--text-secondary)] mt-1">
                  آخر تحكم: {controller.timer.updatedByName}
                </div>
              )}
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() =>
                  void controller.controlTimer(controller.timer.running ? 'pause' : 'start')
                }
                className="flex-1 min-h-[42px] px-4 rounded-xl bg-[var(--accent)] text-[var(--accent-fg)] text-xs font-bold flex items-center justify-center gap-1.5 hover:bg-[var(--accent-hi)]"
              >
                {controller.timer.running ? (
                  <>
                    <Icons.Pause className="w-4 h-4" />
                    <span>إيقاف مؤقت</span>
                  </>
                ) : (
                  <>
                    <Icons.Play className="w-4 h-4" />
                    <span>بدء الجلسة للجميع</span>
                  </>
                )}
              </button>

              <button
                type="button"
                onClick={() => void controller.controlTimer('reset')}
                aria-label="إعادة ضبط المؤقت"
                className="min-h-[42px] min-w-[42px] rounded-xl bg-[var(--bg-surface)] border border-[var(--divider)] hover:border-[var(--accent)] text-[var(--text-primary)] flex items-center justify-center"
              >
                <Icons.RotateCcw className="w-4 h-4" />
              </button>
            </div>
          </section>

          {/* Live Room Chat */}
          <section className="rahhala-card p-4 flex flex-col h-[360px]">
            <div className="flex items-center justify-between gap-2 pb-2.5 border-b border-[var(--divider)]">
              <h2 className="text-sm font-extrabold text-[var(--text-primary)] flex items-center gap-2">
                <Icons.MessageSquare className="w-4 h-4 text-[var(--accent)]" />
                <span>محادثة المجلس</span>
              </h2>
              <span className="text-[11px] text-[var(--text-secondary)] tabular-nums">
                {controller.messages.length} رسالة
              </span>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto py-3 space-y-2.5">
              {controller.messagesLoading ? (
                <div className="text-xs text-[var(--text-secondary)] text-center py-6">
                  جاري تحميل المحادثة…
                </div>
              ) : controller.messages.length === 0 ? (
                <div className="text-xs text-[var(--text-secondary)] text-center py-6">
                  لا توجد رسائل بعد. شارك زملاءك سؤالاً أو خطة مذاكرة.
                </div>
              ) : (
                controller.messages.map((m) => {
                  const isOwn = m.userId === user.id;
                  return (
                    <div
                      key={m.id}
                      className={`p-2.5 rounded-xl border text-xs space-y-1 ${
                        isOwn
                          ? 'bg-[var(--accent-soft)] border-[var(--accent)]/25'
                          : 'bg-[var(--bg-surface)] border-[var(--divider)]'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2 text-[11px]">
                        <span className="font-bold text-[var(--text-primary)] truncate">
                          {m.senderName}
                        </span>
                        <span className="text-[var(--text-secondary)] tabular-nums shrink-0">
                          {formatMessageTime(m.createdAt)}
                        </span>
                      </div>
                      <p className="text-[var(--text-primary)] leading-relaxed break-words">
                        {m.body}
                      </p>
                    </div>
                  );
                })
              )}
              <div ref={chatBottomRef} />
            </div>

            <form onSubmit={handleSendChat} className="pt-2 border-t border-[var(--divider)] flex gap-2">
              <input
                type="text"
                maxLength={500}
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                placeholder="اكتب رسالة داخل المجلس…"
                aria-label="رسالة داخل المجلس"
                className="rahhala-input flex-1 min-h-[42px] px-3 py-1.5 text-xs sm:text-sm"
              />
              <button
                type="submit"
                disabled={chatBusy || !chatInput.trim()}
                aria-label="إرسال رسالة"
                className="min-h-[42px] min-w-[42px] rounded-xl bg-[var(--accent)] text-[var(--accent-fg)] flex items-center justify-center disabled:opacity-50"
              >
                <Icons.Send className="w-4 h-4" />
              </button>
            </form>
          </section>
        </div>
      </div>
    </div>
  );
}

export function FloatingMajalisPanel({
  controller,
  onExpand,
}: {
  controller: MajalisController;
  onExpand: () => void;
}) {
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const dragStartRef = useRef<{ px: number; py: number; ox: number; oy: number } | null>(null);

  if (!controller.joined) return null;

  return (
    <div
      style={{ transform: `translate3d(${offset.x}px, ${offset.y}px, 0)` }}
      className="fixed z-40 top-16 left-3 sm:left-6 w-68 rahhala-card p-3 shadow-2xl border border-[var(--accent)]/40"
    >
      <div
        onPointerDown={(e) => {
          dragStartRef.current = {
            px: e.clientX,
            py: e.clientY,
            ox: offset.x,
            oy: offset.y,
          };
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (!dragStartRef.current) return;
          const dx = e.clientX - dragStartRef.current.px;
          const dy = e.clientY - dragStartRef.current.py;
          setOffset({
            x: Math.max(-160, Math.min(220, dragStartRef.current.ox + dx)),
            y: Math.max(-40, Math.min(240, dragStartRef.current.oy + dy)),
          });
        }}
        onPointerUp={() => {
          dragStartRef.current = null;
        }}
        className="flex items-center justify-between gap-2 cursor-move select-none pb-2 border-b border-[var(--divider)]"
      >
        <div className="flex items-center gap-2 text-xs font-bold text-[var(--accent)] min-w-0">
          <Icons.Video className="w-4 h-4 shrink-0" />
          <span className="truncate">
            {controller.activeRoom?.title || 'مجلس المذاكرة'}
          </span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={onExpand}
            aria-label="توسيع مجلس المذاكرة"
            className="min-h-[32px] min-w-[32px] rounded-lg bg-[var(--bg-surface)] flex items-center justify-center text-[var(--text-primary)]"
          >
            <Icons.Maximize className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={controller.leaveMeeting}
            aria-label="مغادرة المجلس"
            className="min-h-[32px] min-w-[32px] rounded-lg bg-[var(--error-soft)] text-[var(--error)] flex items-center justify-center"
          >
            <Icons.X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <div className="flex items-center justify-between gap-2 pt-2">
        <div className="text-[11px] text-[var(--text-secondary)] tabular-nums">
          <span>المشاركون: {controller.peers.length + 1}</span>
          <span aria-hidden="true"> · </span>
          <span className="font-bold text-[var(--text-primary)]">
            {formatCountdownMs(controller.remainingMs)}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => void controller.toggleMic()}
            aria-label={controller.micMuted ? 'فتح الميكروفون' : 'كتم الميكروفون'}
            className="min-h-[34px] min-w-[34px] rounded-lg bg-[var(--bg-surface)] flex items-center justify-center text-[var(--text-primary)]"
          >
            {controller.mode === 'listener' || controller.micMuted ? (
              <Icons.MicOff className="w-3.5 h-3.5 text-[var(--error)]" />
            ) : (
              <Icons.Mic className="w-3.5 h-3.5 text-[var(--success)]" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
