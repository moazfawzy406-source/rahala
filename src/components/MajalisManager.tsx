import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AppPublicConfig,
  AuthUser,
  MajalisAccessType,
  MajalisChatMessageRecord,
  MajalisKnockRequest,
  MajalisLayoutMode,
  MajalisParticipantInfo,
  MajalisParticipationMode,
  MajalisReactionEvent,
  MajalisRoomSettings,
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

const DEFAULT_ROOM_SETTINGS: MajalisRoomSettings = {
  accessType: 'open',
  roomLocked: false,
  allowMic: true,
  allowCam: true,
  allowScreenShare: true,
  allowChat: true,
  muteOnEntry: false,
};

const TIMER_PHASE_LABELS: Record<MajalisTimerPhase, string> = {
  focus: 'تركيز ٢٥ د',
  review: 'مراجعة ٤٥ د',
  break: 'استراحة ٥ د',
};

const QUICK_REACTIONS = ['👍', '👏', '❤️', '🔥', '💡', '🎉'] as const;

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

function useStreamAudioLevel(stream: MediaStream | null, active: boolean): number {
  const [level, setLevel] = useState(0);

  useEffect(() => {
    if (!stream || !active || stream.getAudioTracks().length === 0) {
      setLevel(0);
      return;
    }

    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;

    let rafId = 0;
    let closed = false;
    let ctx: AudioContext | null = null;

    try {
      ctx = new AudioCtx();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);

      const sample = () => {
        if (closed) return;
        analyser.getByteFrequencyData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
          sum += data[i];
        }
        const avg = sum / data.length;
        const pct = Math.min(100, Math.round((avg / 64) * 100));
        setLevel(pct);
        rafId = window.requestAnimationFrame(sample);
      };
      rafId = window.requestAnimationFrame(sample);
    } catch {
      setLevel(0);
    }

    return () => {
      closed = true;
      if (rafId) window.cancelAnimationFrame(rafId);
      if (ctx && ctx.state !== 'closed') {
        void ctx.close().catch(() => {});
      }
    };
  }, [stream, active]);

  return level;
}

export interface MajalisController {
  rooms: MajalisRoomSummary[];
  roomsLoading: boolean;
  roomsError: string | null;
  subjects: SubjectRecord[];
  activeRoom: MajalisRoomSummary | null;
  activeRoomId: string | null;
  preJoinRoom: MajalisRoomSummary | null;
  preJoinStream: MediaStream | null;
  preJoinMicOn: boolean;
  preJoinCamOn: boolean;
  preJoinNotice: string | null;
  preJoinMicLevel: number;
  knockStatus: 'idle' | 'pending' | 'rejected';
  knockMessage: string | null;
  devices: {
    audioInputs: MediaDeviceInfo[];
    videoInputs: MediaDeviceInfo[];
    audioOutputs: MediaDeviceInfo[];
  };
  selectedAudioInputId: string;
  selectedVideoInputId: string;
  selectedAudioOutputId: string;
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
  localMicLevel: number;
  peers: PeerMedia[];
  timer: MajalisTimerState;
  remainingMs: number;
  messages: MajalisChatMessageRecord[];
  messagesLoading: boolean;
  wakeLockActive: boolean;
  knockQueue: MajalisKnockRequest[];
  reactions: MajalisReactionEvent[];
  isHost: boolean;
  refreshRooms: () => Promise<void>;
  refreshDevices: () => Promise<void>;
  createRoom: (payload: {
    title: string;
    subjectId: string | null;
    accessType?: MajalisAccessType;
    allowScreenShare?: boolean;
    allowChat?: boolean;
    muteOnEntry?: boolean;
  }) => Promise<MajalisRoomSummary>;
  deleteRoom: (roomId: string) => Promise<void>;
  openPreJoin: (roomId: string) => Promise<void>;
  closePreJoin: () => void;
  togglePreJoinMic: () => Promise<void>;
  togglePreJoinCam: () => Promise<void>;
  selectAudioInput: (deviceId: string) => Promise<void>;
  selectVideoInput: (deviceId: string) => Promise<void>;
  selectAudioOutput: (deviceId: string) => void;
  joinFromPreJoin: (options?: { listenerOnly?: boolean }) => Promise<void>;
  cancelKnock: () => void;
  joinMeeting: (roomId?: string, options?: { listenerOnly?: boolean }) => Promise<void>;
  leaveMeeting: () => void;
  endMeetingForAll: () => Promise<void>;
  toggleMic: () => Promise<void>;
  toggleCam: () => Promise<void>;
  toggleScreenShare: () => Promise<void>;
  toggleHandRaise: () => void;
  switchToListener: () => void;
  upgradeMedia: (wantVideo?: boolean) => Promise<void>;
  controlTimer: (action: 'start' | 'pause' | 'reset' | 'preset', phase?: MajalisTimerPhase) => Promise<void>;
  sendRoomMessage: (body: string) => Promise<void>;
  updateRoomSettings: (roomId: string, patch: Partial<MajalisRoomSettings>) => Promise<void>;
  decideKnock: (targetUserId: string, approve: boolean) => void;
  hostAction: (
    action: 'mute_all' | 'mute_user' | 'kick_user' | 'spotlight_user' | 'lower_all_hands' | 'end_meeting',
    targetUserId?: string | null
  ) => void;
  sendReaction: (emoji: string) => void;
  copyInviteLink: (roomId: string) => void;
  dismissNotice: () => void;
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

  const [preJoinRoomId, setPreJoinRoomId] = useState<string | null>(null);
  const [preJoinStream, setPreJoinStream] = useState<MediaStream | null>(null);
  const [preJoinMicOn, setPreJoinMicOn] = useState(true);
  const [preJoinCamOn, setPreJoinCamOn] = useState(true);
  const [preJoinNotice, setPreJoinNotice] = useState<string | null>(null);

  const [knockStatus, setKnockStatus] = useState<'idle' | 'pending' | 'rejected'>('idle');
  const [knockMessage, setKnockMessage] = useState<string | null>(null);
  const [knockQueue, setKnockQueue] = useState<MajalisKnockRequest[]>([]);
  const [reactions, setReactions] = useState<MajalisReactionEvent[]>([]);

  const [devices, setDevices] = useState<{
    audioInputs: MediaDeviceInfo[];
    videoInputs: MediaDeviceInfo[];
    audioOutputs: MediaDeviceInfo[];
  }>({ audioInputs: [], videoInputs: [], audioOutputs: [] });
  const [selectedAudioInputId, setSelectedAudioInputId] = useState('');
  const [selectedVideoInputId, setSelectedVideoInputId] = useState('');
  const [selectedAudioOutputId, setSelectedAudioOutputId] = useState('');

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

  const preJoinStreamRef = useRef<MediaStream | null>(null);
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
  const preJoinRoomIdRef = useRef<string | null>(null);
  const modeRef = useRef<MajalisParticipationMode>('listener');
  const micMutedRef = useRef(true);
  const camOffRef = useRef(true);
  const pendingJoinIntentRef = useRef<{
    roomId: string;
    listenerOnly: boolean;
    stream: MediaStream | null;
    micOn: boolean;
    camOn: boolean;
  } | null>(null);

  joinedRef.current = joined;
  activeRoomIdRef.current = activeRoomId;
  preJoinRoomIdRef.current = preJoinRoomId;
  modeRef.current = mode;
  micMutedRef.current = micMuted;
  camOffRef.current = camOff;

  const preJoinMicLevel = useStreamAudioLevel(
    preJoinStream,
    Boolean(preJoinRoomId && !joined && preJoinMicOn)
  );
  const localMicLevel = useStreamAudioLevel(
    localStream,
    Boolean(joined && !micMuted && mode !== 'listener')
  );

  const refreshDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      const audioInputs = list.filter((d) => d.kind === 'audioinput');
      const videoInputs = list.filter((d) => d.kind === 'videoinput');
      const audioOutputs = list.filter((d) => d.kind === 'audiooutput');
      setDevices({ audioInputs, videoInputs, audioOutputs });
      setSelectedAudioInputId((cur) =>
        cur && audioInputs.some((d) => d.deviceId === cur) ? cur : audioInputs[0]?.deviceId || ''
      );
      setSelectedVideoInputId((cur) =>
        cur && videoInputs.some((d) => d.deviceId === cur) ? cur : videoInputs[0]?.deviceId || ''
      );
      setSelectedAudioOutputId((cur) =>
        cur && audioOutputs.some((d) => d.deviceId === cur) ? cur : audioOutputs[0]?.deviceId || ''
      );
    } catch {
      // Ignore enumerateDevices errors
    }
  }, []);

  useEffect(() => {
    const md = navigator.mediaDevices;
    if (!md?.addEventListener) return;
    const onChange = () => {
      void refreshDevices();
    };
    md.addEventListener('devicechange', onChange);
    return () => md.removeEventListener('devicechange', onChange);
  }, [refreshDevices]);

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

  const stopPreJoinStream = useCallback(() => {
    preJoinStreamRef.current?.getTracks().forEach((t) => t.stop());
    preJoinStreamRef.current = null;
    setPreJoinStream(null);
  }, []);

  const cleanupMediaAndPeers = useCallback(() => {
    for (const pc of peerConnectionsRef.current.values()) {
      pc.close();
    }
    peerConnectionsRef.current.clear();
    pendingIceRef.current.clear();
    makingOfferRef.current.clear();
    setPeers([]);
    setKnockQueue([]);
    setReactions([]);

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

      const iceServers =
        config.iceServers && config.iceServers.length > 0
          ? config.iceServers
          : [
              { urls: 'stun:stun.l.google.com:19302' },
              { urls: 'stun:stun1.l.google.com:19302' },
            ];

      const pc = new RTCPeerConnection({ iceServers });

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
    [config.iceServers, syncLocalTracksToPeer]
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

  const finalizeEnterRoom = useCallback(
    (
      roomId: string,
      stream: MediaStream | null,
      wantMicOn: boolean,
      wantCamOn: boolean,
      noticeMsg: string | null = null
    ) => {
      if (stream) {
        stream.getAudioTracks().forEach((t) => {
          t.enabled = wantMicOn;
        });
        stream.getVideoTracks().forEach((t) => {
          t.enabled = wantCamOn;
        });
      }

      const hasAudio = Boolean(stream && stream.getAudioTracks().length > 0);
      const hasVideo = Boolean(stream && stream.getVideoTracks().length > 0);
      const nextMode: MajalisParticipationMode =
        hasVideo && wantCamOn ? 'media' : hasAudio ? 'audio' : 'listener';

      localStreamRef.current = stream;
      setLocalStream(stream);
      preJoinStreamRef.current = null;
      setPreJoinStream(null);
      setPreJoinRoomId(null);

      setMode(nextMode);
      setMicMuted(!hasAudio || !wantMicOn);
      setCamOff(!hasVideo || !wantCamOn);
      setPermissionNotice(noticeMsg);
      setKnockStatus('idle');
      setKnockMessage(null);
      setActiveRoomId(roomId);
      setJoined(true);
      setJoining(false);
      void loadRoomMessages(roomId);
      void requestWakeLock();
    },
    [loadRoomMessages, requestWakeLock]
  );

  const handleWsEvent = useCallback(
    async (ev: WsServerEvent) => {
      if (ev.type === 'majalis:lobby_updated' && Array.isArray(ev.rooms)) {
        setRooms(ev.rooms as MajalisRoomSummary[]);
        return;
      }

      if (ev.type === 'majalis:knock_pending') {
        setJoining(false);
        setKnockStatus('pending');
        setKnockMessage('تم إرسال طلب الانضمام للمضيف… بانتظار السماح بالدخول.');
        return;
      }

      if (ev.type === 'majalis:knock_admitted' && ev.roomId) {
        const intent = pendingJoinIntentRef.current;
        if (intent && intent.roomId === String(ev.roomId)) {
          pendingJoinIntentRef.current = null;
          finalizeEnterRoom(
            intent.roomId,
            intent.listenerOnly ? null : intent.stream,
            intent.micOn,
            intent.camOn
          );
          onToast('وافق المضيف على دخولك المجلس!');
        }
        return;
      }

      if (ev.type === 'majalis:join_rejected') {
        pendingJoinIntentRef.current = null;
        setJoining(false);
        setKnockStatus('rejected');
        const msg = String(ev.message || 'تعذر الدخول إلى هذا المجلس.');
        setKnockMessage(msg);
        onToast(msg, true);
        return;
      }

      if (ev.type === 'majalis:knock_queue' && Array.isArray(ev.queue)) {
        const queue = ev.queue as MajalisKnockRequest[];
        setKnockQueue(queue);
        if (queue.length > 0 && joinedRef.current) {
          onToast(`طلب انضمام جديد من ${queue[queue.length - 1].displayName}`);
        }
        return;
      }

      if (!joinedRef.current) return;
      const currentRoom = activeRoomIdRef.current;
      if (ev.roomId && currentRoom && String(ev.roomId) !== currentRoom) {
        return;
      }

      if (ev.type === 'majalis:ended' || ev.type === 'majalis:kicked') {
        cleanupMediaAndPeers();
        setJoined(false);
        setActiveRoomId(null);
        setMessages([]);
        const msg = String(
          ev.message || (ev.type === 'majalis:ended' ? 'تم إنهاء المجلس للجميع.' : 'تم إبعادك من المجلس.')
        );
        setPermissionNotice(msg);
        onToast(msg, ev.type === 'majalis:kicked');
        void loadRooms(true);
        return;
      }

      if (ev.type === 'majalis:force_mute') {
        localStreamRef.current?.getAudioTracks().forEach((t) => {
          t.enabled = false;
        });
        setMicMuted(true);
        if (ev.reason) onToast(String(ev.reason), true);
        return;
      }

      if (ev.type === 'majalis:force_cam_off') {
        localStreamRef.current?.getVideoTracks().forEach((t) => {
          t.enabled = false;
        });
        setCamOff(true);
        setMode((m) => (m === 'media' ? 'audio' : m));
        if (ev.reason) onToast(String(ev.reason), true);
        return;
      }

      if (ev.type === 'majalis:force_stop_share') {
        screenStreamRef.current?.getTracks().forEach((t) => t.stop());
        screenStreamRef.current = null;
        setScreenSharing(false);
        if (ev.reason) onToast(String(ev.reason), true);
        return;
      }

      if (ev.type === 'majalis:error' && ev.message) {
        onToast(String(ev.message), true);
        return;
      }

      if (ev.type === 'majalis:settings_updated' && ev.settings && currentRoom) {
        const nextSettings = ev.settings as MajalisRoomSettings;
        setRooms((prev) =>
          prev.map((r) => (r.id === currentRoom ? { ...r, settings: nextSettings } : r))
        );
        return;
      }

      if (ev.type === 'majalis:reaction' && ev.reaction) {
        const rx = ev.reaction as MajalisReactionEvent;
        setReactions((prev) => [...prev.slice(-14), rx]);
        window.setTimeout(() => {
          setReactions((prev) => prev.filter((item) => item.id !== rx.id));
        }, 3200);
        return;
      }

      if (ev.type === 'majalis:peers' && Array.isArray(ev.peers)) {
        const peerList = ev.peers as MajalisParticipantInfo[];
        mergeParticipantsWithStreams(peerList);
        if (ev.timer) {
          setTimer(ev.timer as MajalisTimerState);
        }
        if (Array.isArray(ev.knockQueue)) {
          setKnockQueue(ev.knockQueue as MajalisKnockRequest[]);
        }
        if (ev.enforcedMicMuted) {
          localStreamRef.current?.getAudioTracks().forEach((t) => {
            t.enabled = false;
          });
          setMicMuted(true);
        }
        if (ev.enforcedCamOff) {
          localStreamRef.current?.getVideoTracks().forEach((t) => {
            t.enabled = false;
          });
          setCamOff(true);
          setMode((m) => (m === 'media' ? 'audio' : m));
        }
        if (ev.settings && currentRoom) {
          const nextSettings = ev.settings as MajalisRoomSettings;
          setRooms((prev) =>
            prev.map((r) =>
              r.id === currentRoom
                ? {
                    ...r,
                    settings: nextSettings,
                    spotlightUserId:
                      ev.spotlightUserId !== undefined
                        ? (ev.spotlightUserId as string | null)
                        : r.spotlightUserId,
                  }
                : r
            )
          );
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
        if (currentRoom && (ev.settings || ev.spotlightUserId !== undefined)) {
          setRooms((prev) =>
            prev.map((r) =>
              r.id === currentRoom
                ? {
                    ...r,
                    ...(ev.settings ? { settings: ev.settings as MajalisRoomSettings } : {}),
                    ...(ev.spotlightUserId !== undefined
                      ? { spotlightUserId: ev.spotlightUserId as string | null }
                      : {}),
                  }
                : r
            )
          );
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
      cleanupMediaAndPeers,
      config.meetingMode,
      createPeerConnection,
      finalizeEnterRoom,
      loadRooms,
      mergeParticipantsWithStreams,
      onToast,
      renegotiateWithPeer,
      syncLocalTracksToPeer,
      user,
    ]
  );

  const wsEnabled =
    Boolean(user) &&
    (isViewVisible || joined || Boolean(preJoinRoomId)) &&
    config.meetingMode !== 'unconfigured';
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

  const openPreJoin = useCallback(
    async (roomId: string) => {
      if (config.meetingMode === 'unconfigured') {
        onToast('مجلس المذاكرة غير مُفعّل حالياً في إعدادات الإدارة', true);
        return;
      }

      stopPreJoinStream();
      setPreJoinRoomId(roomId);
      setKnockStatus('idle');
      setKnockMessage(null);
      setPreJoinNotice(null);

      if (config.meetingMode === 'external' || !navigator.mediaDevices?.getUserMedia) {
        setPreJoinMicOn(false);
        setPreJoinCamOn(false);
        setPreJoinNotice(
          config.meetingMode === 'external'
            ? 'هذا المجلس مضبوط على مزود خارجي.'
            : 'المتصفح الحالي لا يدعم الوصول المباشر للكاميرا والميكروفون؛ يمكنك الدخول كمستمع.'
        );
        return;
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: selectedAudioInputId ? { deviceId: { exact: selectedAudioInputId } } : true,
          video: selectedVideoInputId ? { deviceId: { exact: selectedVideoInputId } } : true,
        });
        if (preJoinRoomIdRef.current !== roomId) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        preJoinStreamRef.current = stream;
        setPreJoinStream(stream);
        setPreJoinMicOn(true);
        setPreJoinCamOn(true);
        await refreshDevices();
      } catch {
        try {
          const audioOnly = await navigator.mediaDevices.getUserMedia({
            audio: selectedAudioInputId ? { deviceId: { exact: selectedAudioInputId } } : true,
          });
          if (preJoinRoomIdRef.current !== roomId) {
            audioOnly.getTracks().forEach((t) => t.stop());
            return;
          }
          preJoinStreamRef.current = audioOnly;
          setPreJoinStream(audioOnly);
          setPreJoinMicOn(true);
          setPreJoinCamOn(false);
          setPreJoinNotice('الكاميرا غير متاحة أو مرفوضة — تم تجهيز الميكروفون للمعاينة.');
          await refreshDevices();
        } catch {
          setPreJoinStream(null);
          preJoinStreamRef.current = null;
          setPreJoinMicOn(false);
          setPreJoinCamOn(false);
          setPreJoinNotice('تعذر الوصول للميكروفون أو الكاميرا؛ سيتم دخولك بوضع المستمع والمشاركة النصية.');
          await refreshDevices();
        }
      }
    },
    [config.meetingMode, onToast, refreshDevices, selectedAudioInputId, selectedVideoInputId, stopPreJoinStream]
  );

  const closePreJoin = useCallback(() => {
    if (knockStatus === 'pending' && preJoinRoomIdRef.current) {
      sendJson({ type: 'majalis:knock_cancel', roomId: preJoinRoomIdRef.current });
    }
    pendingJoinIntentRef.current = null;
    stopPreJoinStream();
    setPreJoinRoomId(null);
    setKnockStatus('idle');
    setKnockMessage(null);
    setPreJoinNotice(null);
  }, [knockStatus, sendJson, stopPreJoinStream]);

  const togglePreJoinMic = useCallback(async () => {
    const stream = preJoinStreamRef.current;
    if (!stream || stream.getAudioTracks().length === 0) {
      if (!navigator.mediaDevices?.getUserMedia) return;
      try {
        const audio = await navigator.mediaDevices.getUserMedia({
          audio: selectedAudioInputId ? { deviceId: { exact: selectedAudioInputId } } : true,
        });
        const nextStream = new MediaStream([
          ...(stream ? stream.getVideoTracks() : []),
          ...audio.getAudioTracks(),
        ]);
        preJoinStreamRef.current = nextStream;
        setPreJoinStream(nextStream);
        setPreJoinMicOn(true);
        await refreshDevices();
      } catch {
        onToast('تعذر تفعيل الميكروفون من المتصفح', true);
      }
      return;
    }
    const next = !preJoinMicOn;
    stream.getAudioTracks().forEach((t) => {
      t.enabled = next;
    });
    setPreJoinMicOn(next);
  }, [onToast, preJoinMicOn, refreshDevices, selectedAudioInputId]);

  const togglePreJoinCam = useCallback(async () => {
    const stream = preJoinStreamRef.current;
    if (!stream || stream.getVideoTracks().length === 0) {
      if (!navigator.mediaDevices?.getUserMedia) return;
      try {
        const vid = await navigator.mediaDevices.getUserMedia({
          video: selectedVideoInputId ? { deviceId: { exact: selectedVideoInputId } } : true,
        });
        const nextStream = new MediaStream([
          ...(stream ? stream.getAudioTracks() : []),
          ...vid.getVideoTracks(),
        ]);
        preJoinStreamRef.current = nextStream;
        setPreJoinStream(nextStream);
        setPreJoinCamOn(true);
        await refreshDevices();
      } catch {
        onToast('تعذر تشغيل الكاميرا من المتصفح', true);
      }
      return;
    }
    const next = !preJoinCamOn;
    stream.getVideoTracks().forEach((t) => {
      t.enabled = next;
    });
    setPreJoinCamOn(next);
  }, [onToast, preJoinCamOn, refreshDevices, selectedVideoInputId]);

  const replaceDeviceTrackInStreams = useCallback(
    async (kind: 'audio' | 'video', deviceId: string) => {
      if (!navigator.mediaDevices?.getUserMedia) return;
      try {
        const newMedia = await navigator.mediaDevices.getUserMedia(
          kind === 'audio' ? { audio: { deviceId: { exact: deviceId } } } : { video: { deviceId: { exact: deviceId } } }
        );
        const newTrack = kind === 'audio' ? newMedia.getAudioTracks()[0] : newMedia.getVideoTracks()[0];
        if (!newTrack) return;

        // Replace in pre-join stream if active
        if (!joinedRef.current && preJoinStreamRef.current) {
          const cur = preJoinStreamRef.current;
          const oldTracks = kind === 'audio' ? cur.getAudioTracks() : cur.getVideoTracks();
          oldTracks.forEach((t) => {
            cur.removeTrack(t);
            t.stop();
          });
          newTrack.enabled = kind === 'audio' ? preJoinMicOn : preJoinCamOn;
          cur.addTrack(newTrack);
          const refreshed = new MediaStream(cur.getTracks());
          preJoinStreamRef.current = refreshed;
          setPreJoinStream(refreshed);
          return;
        }

        // Replace in live call stream & WebRTC peer connections cleanly via replaceTrack!
        if (joinedRef.current) {
          const cur = localStreamRef.current ?? new MediaStream();
          const oldTracks = kind === 'audio' ? cur.getAudioTracks() : cur.getVideoTracks();
          oldTracks.forEach((t) => {
            cur.removeTrack(t);
            t.stop();
          });
          newTrack.enabled = kind === 'audio' ? !micMutedRef.current : !camOffRef.current;
          cur.addTrack(newTrack);
          localStreamRef.current = cur;
          setLocalStream(new MediaStream(cur.getTracks()));

          for (const [remoteId, pc] of peerConnectionsRef.current.entries()) {
            const sender = pc.getSenders().find((s) => s.track?.kind === kind);
            if (sender) {
              await sender.replaceTrack(newTrack).catch(() => {});
            } else {
              pc.addTrack(newTrack, cur);
              await renegotiateWithPeer(remoteId, pc);
            }
          }
          onToast(kind === 'audio' ? 'تم تبديل الميكروفون بنجاح' : 'تم تبديل الكاميرا بنجاح');
        }
      } catch {
        onToast('تعذر التبديل إلى الجهاز المحدد', true);
      }
    },
    [onToast, preJoinCamOn, preJoinMicOn, renegotiateWithPeer]
  );

  const selectAudioInput = useCallback(
    async (deviceId: string) => {
      setSelectedAudioInputId(deviceId);
      await replaceDeviceTrackInStreams('audio', deviceId);
    },
    [replaceDeviceTrackInStreams]
  );

  const selectVideoInput = useCallback(
    async (deviceId: string) => {
      setSelectedVideoInputId(deviceId);
      await replaceDeviceTrackInStreams('video', deviceId);
    },
    [replaceDeviceTrackInStreams]
  );

  const selectAudioOutput = useCallback(
    (deviceId: string) => {
      setSelectedAudioOutputId(deviceId);
      onToast('تم تحديث مخرج الصوت');
    },
    [onToast]
  );

  const executeJoinRoom = useCallback(
    (
      targetRoomId: string,
      stream: MediaStream | null,
      wantMicOn: boolean,
      wantCamOn: boolean,
      listenerOnly: boolean,
      noticeMsg: string | null = null
    ) => {
      const existingRoom = rooms.find((r) => r.id === targetRoomId);
      const userIsHost =
        Boolean(user && (user.role === 'owner' || user.role === 'admin' || existingRoom?.creatorId === user.id));

      if (existingRoom?.settings?.roomLocked && !userIsHost) {
        setJoining(false);
        setKnockStatus('rejected');
        const msg = 'هذا المجلس مقفول حالياً من قِبل المضيف.';
        setKnockMessage(msg);
        onToast(msg, true);
        return;
      }

      if (existingRoom?.settings?.accessType === 'knock' && !userIsHost) {
        setJoining(true);
        setKnockStatus('pending');
        setKnockMessage('بانتظار موافقة المضيف على دخولك…');
        pendingJoinIntentRef.current = {
          roomId: targetRoomId,
          listenerOnly,
          stream,
          micOn: wantMicOn,
          camOn: wantCamOn,
        };
        const reqMode: MajalisParticipationMode = listenerOnly
          ? 'listener'
          : stream?.getVideoTracks().length && wantCamOn
          ? 'media'
          : stream?.getAudioTracks().length
          ? 'audio'
          : 'listener';

        sendJson({
          type: 'majalis:join',
          roomId: targetRoomId,
          mode: reqMode,
          micMuted: listenerOnly || !wantMicOn,
          camOff: listenerOnly || !wantCamOn,
        });
        return;
      }

      finalizeEnterRoom(targetRoomId, listenerOnly ? null : stream, wantMicOn, wantCamOn, noticeMsg);
      if (listenerOnly) {
        stopPreJoinStream();
      }
    },
    [finalizeEnterRoom, onToast, rooms, sendJson, stopPreJoinStream, user]
  );

  const joinFromPreJoin = useCallback(
    async (options?: { listenerOnly?: boolean }) => {
      const targetRoomId = preJoinRoomIdRef.current || rooms[0]?.id;
      if (!targetRoomId) return;

      const existingRoom = rooms.find((r) => r.id === targetRoomId);
      if (existingRoom) {
        setTimer(existingRoom.timer);
      }

      if (config.meetingMode === 'external') {
        if (!config.meetingExternalUrl) {
          onToast('رابط مزود الاجتماعات الخارجي غير مضبوط.', true);
          return;
        }
        stopPreJoinStream();
        setPreJoinRoomId(null);
        setActiveRoomId(targetRoomId);
        setMode('listener');
        setMicMuted(true);
        setCamOff(true);
        setJoined(true);
        setJoining(false);
        void loadRoomMessages(targetRoomId);
        return;
      }

      const listenerOnly = Boolean(options?.listenerOnly);
      const stream = listenerOnly ? null : preJoinStreamRef.current;
      executeJoinRoom(
        targetRoomId,
        stream,
        listenerOnly ? false : preJoinMicOn,
        listenerOnly ? false : preJoinCamOn,
        listenerOnly,
        listenerOnly
          ? 'انضممت للمجلس بوضع المستمع الهادئ والمشاركة النصية.'
          : !stream
          ? 'تم دخول المجلس تلقائياً بوضع المستمع والمشاركة النصية لعدم توفر إذن الميكروفون أو الكاميرا.'
          : null
      );
    },
    [
      config.meetingExternalUrl,
      config.meetingMode,
      executeJoinRoom,
      loadRoomMessages,
      onToast,
      preJoinCamOn,
      preJoinMicOn,
      rooms,
      stopPreJoinStream,
    ]
  );

  const cancelKnock = useCallback(() => {
    const rId = preJoinRoomIdRef.current;
    if (rId) {
      sendJson({ type: 'majalis:knock_cancel', roomId: rId });
    }
    pendingJoinIntentRef.current = null;
    setKnockStatus('idle');
    setKnockMessage(null);
    setJoining(false);
  }, [sendJson]);

  // Direct quick-join (kept for backwards compatibility / 1-tap listener)
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
          : 'انضممت للمجلس بوضع المستمع والمشاركة النصية.';
        executeJoinRoom(targetRoomId, null, false, false, true, reason);
        return;
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
        executeJoinRoom(targetRoomId, stream, true, true, false, null);
      } catch {
        try {
          const audioOnly = await navigator.mediaDevices.getUserMedia({ audio: true });
          executeJoinRoom(
            targetRoomId,
            audioOnly,
            true,
            false,
            false,
            'تم الانضمام بالصوت فقط لعدم توفر الكاميرا.'
          );
        } catch {
          executeJoinRoom(
            targetRoomId,
            null,
            false,
            false,
            true,
            'تم دخول المجلس تلقائياً بوضع المستمع والمشاركة النصية لعدم توفر إذن الميكروفون أو الكاميرا.'
          );
        }
      }
    },
    [config.meetingExternalUrl, config.meetingMode, executeJoinRoom, loadRoomMessages, onToast, rooms]
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

  const endMeetingForAll = useCallback(async () => {
    const rId = activeRoomIdRef.current;
    if (!rId) return;
    await apiRequest(`/api/majalis/rooms/${encodeURIComponent(rId)}/end`, { method: 'POST' });
    cleanupMediaAndPeers();
    setJoined(false);
    setActiveRoomId(null);
    setMessages([]);
    setPermissionNotice(null);
    onToast('تم إنهاء المجلس للجميع');
    void loadRooms(true);
  }, [cleanupMediaAndPeers, loadRooms, onToast]);

  const activeRoom = useMemo(
    () => rooms.find((r) => r.id === activeRoomId) ?? null,
    [rooms, activeRoomId]
  );
  const preJoinRoom = useMemo(
    () => rooms.find((r) => r.id === preJoinRoomId) ?? null,
    [rooms, preJoinRoomId]
  );

  const isHost = useMemo(() => {
    if (!user || !activeRoom) return false;
    return (
      user.role === 'owner' ||
      user.role === 'admin' ||
      (activeRoom.creatorId !== null && activeRoom.creatorId === user.id)
    );
  }, [activeRoom, user]);

  const upgradeMedia = useCallback(
    async (wantVideo = false) => {
      if (!isHost && activeRoom?.settings) {
        if (!wantVideo && !activeRoom.settings.allowMic) {
          onToast('أوقف المضيف صلاحية التحدث بالميكروفون في هذا المجلس', true);
          return;
        }
        if (wantVideo && !activeRoom.settings.allowCam) {
          onToast('أوقف المضيف صلاحية تشغيل الكاميرا في هذا المجلس', true);
          return;
        }
      }

      if (!navigator.mediaDevices?.getUserMedia) {
        onToast('المتصفح الحالي لا يدعم الوصول للميكروفون أو الكاميرا', true);
        return;
      }

      try {
        const audioConstraint = selectedAudioInputId
          ? { deviceId: { exact: selectedAudioInputId } }
          : true;
        const videoConstraint = selectedVideoInputId
          ? { deviceId: { exact: selectedVideoInputId } }
          : true;
        const constraints = wantVideo
          ? { audio: audioConstraint, video: videoConstraint }
          : { audio: audioConstraint };
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
        await refreshDevices();

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
    [
      activeRoom?.settings,
      isHost,
      onToast,
      refreshDevices,
      renegotiateWithPeer,
      selectedAudioInputId,
      selectedVideoInputId,
      sendJson,
      syncLocalTracksToPeer,
    ]
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
    if (!isHost && activeRoom?.settings && !activeRoom.settings.allowMic && micMutedRef.current) {
      onToast('أوقف المضيف صلاحية التحدث بالميكروفون', true);
      return;
    }

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
  }, [activeRoom?.settings, isHost, onToast, sendJson, upgradeMedia]);

  const toggleCam = useCallback(async () => {
    if (!isHost && activeRoom?.settings && !activeRoom.settings.allowCam && camOffRef.current) {
      onToast('أوقف المضيف صلاحية تشغيل الكاميرا', true);
      return;
    }

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
  }, [activeRoom?.settings, isHost, onToast, sendJson, upgradeMedia]);

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
    if (!isHost && activeRoom?.settings && !activeRoom.settings.allowScreenShare) {
      onToast('أوقف المضيف صلاحية مشاركة الشاشة', true);
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
  }, [
    activeRoom?.settings,
    isHost,
    onToast,
    renegotiateWithPeer,
    screenSharing,
    sendJson,
    stopScreenShareInternal,
  ]);

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
    async (payload: {
      title: string;
      subjectId: string | null;
      accessType?: MajalisAccessType;
      allowScreenShare?: boolean;
      allowChat?: boolean;
      muteOnEntry?: boolean;
    }) => {
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

  const updateRoomSettings = useCallback(
    async (roomId: string, patch: Partial<MajalisRoomSettings>) => {
      const res = await apiRequest<{ settings: MajalisRoomSettings; room?: MajalisRoomSummary }>(
        `/api/majalis/rooms/${encodeURIComponent(roomId)}/settings`,
        {
          method: 'PATCH',
          body: patch,
        }
      );
      setRooms((prev) =>
        prev.map((r) => (r.id === roomId ? { ...r, settings: res.settings } : r))
      );
    },
    []
  );

  const decideKnock = useCallback(
    (targetUserId: string, approve: boolean) => {
      const rId = activeRoomIdRef.current || preJoinRoomIdRef.current;
      if (!rId) return;
      sendJson({
        type: 'majalis:knock_decide',
        roomId: rId,
        targetUserId,
        approve,
      });
      setKnockQueue((prev) => prev.filter((q) => q.userId !== targetUserId));
    },
    [sendJson]
  );

  const hostAction = useCallback(
    (
      action:
        | 'mute_all'
        | 'mute_user'
        | 'kick_user'
        | 'spotlight_user'
        | 'lower_all_hands'
        | 'end_meeting',
      targetUserId?: string | null
    ) => {
      const rId = activeRoomIdRef.current;
      if (!rId) return;
      sendJson({
        type: 'majalis:host_action',
        roomId: rId,
        action,
        targetUserId: targetUserId ?? undefined,
      });
    },
    [sendJson]
  );

  const sendReaction = useCallback(
    (emoji: string) => {
      const rId = activeRoomIdRef.current;
      if (!rId) return;
      sendJson({ type: 'majalis:reaction', roomId: rId, emoji });
    },
    [sendJson]
  );

  const copyInviteLink = useCallback(
    (roomId: string) => {
      const url = `${window.location.origin}/?majlis=${encodeURIComponent(roomId)}`;
      if (navigator.clipboard?.writeText) {
        navigator.clipboard
          .writeText(url)
          .then(() => onToast('تم نسخ رابط الدعوة المباشر للمجلس'))
          .catch(() => onToast(url));
      } else {
        onToast(url);
      }
    },
    [onToast]
  );

  useEffect(() => {
    return () => {
      stopPreJoinStream();
      cleanupMediaAndPeers();
    };
  }, [cleanupMediaAndPeers, stopPreJoinStream]);

  return {
    rooms,
    roomsLoading,
    roomsError,
    subjects,
    activeRoom,
    activeRoomId,
    preJoinRoom,
    preJoinStream,
    preJoinMicOn,
    preJoinCamOn,
    preJoinNotice,
    preJoinMicLevel,
    knockStatus,
    knockMessage,
    devices,
    selectedAudioInputId,
    selectedVideoInputId,
    selectedAudioOutputId,
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
    localMicLevel,
    peers,
    timer,
    remainingMs,
    messages,
    messagesLoading,
    wakeLockActive,
    knockQueue,
    reactions,
    isHost,
    refreshRooms: () => loadRooms(false),
    refreshDevices,
    createRoom,
    deleteRoom,
    openPreJoin,
    closePreJoin,
    togglePreJoinMic,
    togglePreJoinCam,
    selectAudioInput,
    selectVideoInput,
    selectAudioOutput,
    joinFromPreJoin,
    cancelKnock,
    joinMeeting,
    leaveMeeting,
    endMeetingForAll,
    toggleMic,
    toggleCam,
    toggleScreenShare,
    toggleHandRaise,
    switchToListener,
    upgradeMedia,
    controlTimer,
    sendRoomMessage,
    updateRoomSettings,
    decideKnock,
    hostAction,
    sendReaction,
    copyInviteLink,
    dismissNotice: () => setPermissionNotice(null),
  };
}

function PeerAudioTrack({ stream, sinkId }: { stream: MediaStream; sinkId: string }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  useEffect(() => {
    const el = audioRef.current as (HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }) | null;
    if (!el) return;
    el.srcObject = stream;
    if (sinkId && typeof el.setSinkId === 'function') {
      el.setSinkId(sinkId).catch(() => {});
    }
  }, [stream, sinkId]);

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
          <PeerAudioTrack
            key={p.userId}
            stream={p.stream!}
            sinkId={controller.selectedAudioOutputId}
          />
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
  isPinned = false,
  isHostBadge = false,
  isSelf = false,
  large = false,
  onTogglePin,
}: {
  stream: MediaStream | null;
  label: string;
  avatarAssetId?: string | null;
  mode: MajalisParticipationMode;
  micMuted: boolean;
  camOff: boolean;
  screenSharing: boolean;
  handRaised: boolean;
  isPinned?: boolean;
  isHostBadge?: boolean;
  isSelf?: boolean;
  large?: boolean;
  onTogglePin?: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const speakingLevel = useStreamAudioLevel(stream, !micMuted && mode !== 'listener');
  const isSpeaking = !micMuted && mode !== 'listener' && speakingLevel > 12;

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
      className={`group relative rounded-2xl overflow-hidden bg-[var(--bg-surface)] border aspect-video flex items-center justify-center transition-all ${
        large ? 'min-h-[260px] sm:min-h-[380px] w-full' : ''
      } ${
        isSpeaking
          ? 'border-[var(--success)] ring-2 ring-[var(--success)]/35'
          : handRaised || isPinned
          ? 'border-[var(--accent)] ring-1 ring-[var(--accent)]/30'
          : 'border-[var(--divider)]'
      }`}
    >
      {hasEnabledVideo ? (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className={`w-full h-full ${
            screenSharing
              ? 'object-contain bg-black'
              : isSelf
              ? 'object-cover scale-x-[-1]'
              : 'object-cover'
          }`}
        />
      ) : (
        <div className="flex flex-col items-center gap-2.5 text-center px-3">
          <div
            className={`rounded-full p-1 transition-all ${
              isSpeaking ? 'ring-4 ring-[var(--success)]/40' : ''
            }`}
          >
            <Avatar name={label} assetId={avatarAssetId} size="lg" />
          </div>
          <div className="space-y-0.5">
            <div className="text-xs sm:text-sm font-extrabold text-[var(--text-primary)]">{label}</div>
            <div className="text-[11px] text-[var(--text-secondary)]">
              {mode === 'listener'
                ? 'وضع المستمع'
                : micMuted
                ? 'الميكروفون مكتوم'
                : isSpeaking
                ? 'يتحدث الآن…'
                : 'متصل بالصوت'}
            </div>
          </div>
        </div>
      )}

      {/* Top Pin Button (Google Meet style hover/touch affordance) */}
      {onTogglePin && (
        <button
          type="button"
          onClick={onTogglePin}
          aria-label={isPinned ? 'إلغاء تثبيت العرض' : 'تثبيت على الشاشة الرئيسية'}
          className={`absolute top-2.5 left-2.5 min-h-[36px] min-w-[36px] px-2.5 rounded-xl backdrop-blur-md text-xs font-bold flex items-center gap-1 transition-opacity ${
            isPinned
              ? 'bg-[var(--accent)] text-[var(--accent-fg)] opacity-100'
              : 'bg-black/55 text-white opacity-90 sm:opacity-0 sm:group-hover:opacity-100 hover:bg-black/75'
          }`}
        >
          {isPinned ? <Icons.PinOff className="w-3.5 h-3.5" /> : <Icons.Pin className="w-3.5 h-3.5" />}
          <span className="hidden sm:inline">{isPinned ? 'مثبّت' : 'تثبيت'}</span>
        </button>
      )}

      {/* Subtle status scrim */}
      <div className="absolute inset-x-0 bottom-0 px-3 py-2 bg-gradient-to-t from-black/80 via-black/40 to-transparent flex items-center justify-between gap-2 text-white">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-xs font-bold truncate">
            {label}
            {isSelf ? ' (أنت)' : ''}
          </span>
          {isHostBadge && (
            <span className="text-[10px] font-bold text-amber-300 shrink-0">· المضيف</span>
          )}
          {screenSharing && (
            <span className="text-[10px] font-semibold text-amber-300 shrink-0">
              · يشارك الشاشة
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

function ToggleRow({
  label,
  description,
  checked,
  disabled = false,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="w-full min-h-[54px] px-3.5 py-2.5 rounded-xl bg-[var(--bg-surface)] border border-[var(--divider)] hover:border-[var(--accent)]/60 flex items-center justify-between gap-3 text-right transition-colors disabled:opacity-50"
    >
      <div className="min-w-0">
        <div className="text-xs sm:text-sm font-bold text-[var(--text-primary)]">{label}</div>
        <div className="text-[11px] text-[var(--text-secondary)] leading-snug mt-0.5">
          {description}
        </div>
      </div>
      <span
        aria-hidden="true"
        className={`relative w-11 h-6 rounded-full transition-colors shrink-0 ${
          checked ? 'bg-[var(--accent)]' : 'bg-[var(--divider)]'
        }`}
      >
        <span
          className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-transform ${
            checked ? 'left-1' : 'left-6'
          }`}
        />
      </span>
    </button>
  );
}

function DeviceSettingsModal({
  open,
  onClose,
  controller,
}: {
  open: boolean;
  onClose: () => void;
  controller: MajalisController;
}) {
  const activeMicLevel = controller.joined ? controller.localMicLevel : controller.preJoinMicLevel;
  return (
    <ModalShell
      open={open}
      onClose={onClose}
      title="إعدادات الصوت والصورة (الأجهزة)"
      maxWidth="max-w-md"
    >
      <div className="space-y-4">
        <div>
          <label className="block text-xs font-bold text-[var(--text-secondary)] mb-1.5">
            الميكروفون (إدخال الصوت)
          </label>
          <select
            value={controller.selectedAudioInputId}
            onChange={(e) => void controller.selectAudioInput(e.target.value)}
            className="rahhala-input w-full min-h-[44px] px-3 py-2 text-xs sm:text-sm"
          >
            {controller.devices.audioInputs.length === 0 ? (
              <option value="">الميكروفون الافتراضي</option>
            ) : (
              controller.devices.audioInputs.map((d, i) => (
                <option key={d.deviceId || i} value={d.deviceId}>
                  {d.label || `ميكروفون ${i + 1}`}
                </option>
              ))
            )}
          </select>

          <div className="mt-2 space-y-1">
            <div className="flex items-center justify-between text-[11px] text-[var(--text-secondary)]">
              <span>اختبار مستوى الصوت</span>
              <span className="tabular-nums">{activeMicLevel}%</span>
            </div>
            <div className="h-2 rounded-full bg-[var(--bg-surface)] overflow-hidden border border-[var(--divider)]">
              <div
                className="h-full bg-[var(--success)] transition-all duration-75"
                style={{ width: `${activeMicLevel}%` }}
              />
            </div>
          </div>
        </div>

        <div>
          <label className="block text-xs font-bold text-[var(--text-secondary)] mb-1.5">
            الكاميرا (إدخال الفيديو)
          </label>
          <select
            value={controller.selectedVideoInputId}
            onChange={(e) => void controller.selectVideoInput(e.target.value)}
            className="rahhala-input w-full min-h-[44px] px-3 py-2 text-xs sm:text-sm"
          >
            {controller.devices.videoInputs.length === 0 ? (
              <option value="">الكاميرا الافتراضية</option>
            ) : (
              controller.devices.videoInputs.map((d, i) => (
                <option key={d.deviceId || i} value={d.deviceId}>
                  {d.label || `كاميرا ${i + 1}`}
                </option>
              ))
            )}
          </select>
        </div>

        <div>
          <label className="block text-xs font-bold text-[var(--text-secondary)] mb-1.5">
            السماعة (مخرج الصوت)
          </label>
          <select
            value={controller.selectedAudioOutputId}
            onChange={(e) => controller.selectAudioOutput(e.target.value)}
            className="rahhala-input w-full min-h-[44px] px-3 py-2 text-xs sm:text-sm"
          >
            {controller.devices.audioOutputs.length === 0 ? (
              <option value="">سماعة النظام الافتراضية</option>
            ) : (
              controller.devices.audioOutputs.map((d, i) => (
                <option key={d.deviceId || i} value={d.deviceId}>
                  {d.label || `سماعة ${i + 1}`}
                </option>
              ))
            )}
          </select>
        </div>

        <div className="flex justify-end pt-2">
          <button
            type="button"
            onClick={onClose}
            className="min-h-[44px] px-6 rounded-xl bg-[var(--accent)] text-[var(--accent-fg)] text-sm font-bold"
          >
            تم
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

function PreJoinGreenRoom({
  user,
  config,
  controller,
  onOpenDevices,
}: {
  user: AuthUser;
  config: AppPublicConfig;
  controller: MajalisController;
  onOpenDevices: () => void;
}) {
  const room = controller.preJoinRoom!;
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hasLiveVideo = Boolean(
    controller.preJoinStream &&
      controller.preJoinCamOn &&
      controller.preJoinStream.getVideoTracks().some((t) => t.readyState === 'live' && t.enabled)
  );

  useEffect(() => {
    if (videoRef.current && controller.preJoinStream && hasLiveVideo) {
      videoRef.current.srcObject = controller.preJoinStream;
    }
  }, [controller.preJoinStream, hasLiveVideo]);

  const userIsHost =
    user.role === 'owner' ||
    user.role === 'admin' ||
    (room.creatorId !== null && room.creatorId === user.id);
  const settings = room.settings ?? DEFAULT_ROOM_SETTINGS;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          onClick={controller.closePreJoin}
          className="min-h-[44px] px-3.5 rounded-xl rahhala-glass-pill text-xs font-bold text-[var(--text-primary)] hover:border-[var(--accent)] flex items-center gap-1.5 whitespace-nowrap"
        >
          <Icons.ArrowRight className="w-4 h-4" />
          <span>العودة لقائمة المجالس</span>
        </button>

        <button
          type="button"
          onClick={() => controller.copyInviteLink(room.id)}
          className="min-h-[44px] px-3.5 rounded-xl rahhala-glass-pill text-xs font-bold text-[var(--text-primary)] hover:border-[var(--accent)] flex items-center gap-1.5 whitespace-nowrap"
        >
          <Icons.Link className="w-4 h-4 text-[var(--accent)]" />
          <span>نسخ رابط الدعوة</span>
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,0.85fr)] gap-5 items-stretch">
        {/* Camera / Mic Preview Stage (Google Meet Green Room) */}
        <section className="rahhala-card p-4 sm:p-5 flex flex-col justify-between gap-4">
          <div className="relative rounded-2xl overflow-hidden bg-[#0c1118] border border-[var(--divider)] aspect-video flex items-center justify-center">
            {hasLiveVideo ? (
              <video
                ref={videoRef}
                autoPlay
                playsInline
                muted
                className="w-full h-full object-cover scale-x-[-1]"
              />
            ) : (
              <div className="flex flex-col items-center gap-3 text-center px-4">
                <Avatar name={user.displayName} assetId={user.avatarAssetId} size="lg" />
                <div className="space-y-1">
                  <div className="text-sm font-extrabold text-white">{user.displayName}</div>
                  <div className="text-xs text-slate-300">
                    {controller.preJoinCamOn ? 'جاري تهيئة الكاميرا…' : 'الكاميرا مغلقة قبل الدخول'}
                  </div>
                </div>
              </div>
            )}

            {/* Top Left Mic Voice Level Meter */}
            <div className="absolute top-3 left-3 px-2.5 py-1.5 rounded-xl bg-black/60 backdrop-blur-md flex items-center gap-2 text-white text-[11px]">
              <Icons.Mic
                className={`w-3.5 h-3.5 ${
                  controller.preJoinMicOn ? 'text-[var(--success)]' : 'text-slate-400'
                }`}
              />
              <div className="w-16 h-1.5 rounded-full bg-white/20 overflow-hidden">
                <div
                  className="h-full bg-[var(--success)] transition-all duration-75"
                  style={{ width: `${controller.preJoinMicOn ? controller.preJoinMicLevel : 0}%` }}
                />
              </div>
            </div>

            {/* Bottom Center Pre-Join Mic/Cam Controls */}
            {config.meetingMode === 'builtin' && (
              <div className="absolute bottom-3 inset-x-0 flex items-center justify-center gap-3">
                <button
                  type="button"
                  onClick={() => void controller.togglePreJoinMic()}
                  aria-label={controller.preJoinMicOn ? 'كتم الميكروفون' : 'فتح الميكروفون'}
                  className={`min-h-[48px] min-w-[48px] px-4 rounded-full border backdrop-blur-md flex items-center justify-center gap-2 text-xs font-bold transition-colors ${
                    controller.preJoinMicOn
                      ? 'bg-black/65 border-white/25 text-white hover:bg-black/80'
                      : 'bg-[var(--error)] border-transparent text-white'
                  }`}
                >
                  {controller.preJoinMicOn ? (
                    <Icons.Mic className="w-5 h-5" />
                  ) : (
                    <Icons.MicOff className="w-5 h-5" />
                  )}
                </button>

                <button
                  type="button"
                  onClick={() => void controller.togglePreJoinCam()}
                  aria-label={controller.preJoinCamOn ? 'إغلاق الكاميرا' : 'تشغيل الكاميرا'}
                  className={`min-h-[48px] min-w-[48px] px-4 rounded-full border backdrop-blur-md flex items-center justify-center gap-2 text-xs font-bold transition-colors ${
                    controller.preJoinCamOn
                      ? 'bg-black/65 border-white/25 text-white hover:bg-black/80'
                      : 'bg-[var(--error)] border-transparent text-white'
                  }`}
                >
                  {controller.preJoinCamOn ? (
                    <Icons.Video className="w-5 h-5" />
                  ) : (
                    <Icons.VideoOff className="w-5 h-5" />
                  )}
                </button>

                <button
                  type="button"
                  onClick={onOpenDevices}
                  aria-label="إعدادات الصوت والصورة"
                  className="min-h-[48px] min-w-[48px] px-3.5 rounded-full bg-black/65 border border-white/25 text-white hover:bg-black/80 backdrop-blur-md flex items-center justify-center"
                >
                  <Icons.Sliders className="w-4 h-4" />
                </button>
              </div>
            )}
          </div>

          {controller.preJoinNotice && (
            <div className="p-3 rounded-xl bg-[var(--bg-surface)] border border-[var(--divider)] text-xs text-[var(--text-secondary)] flex items-center gap-2">
              <Icons.Info className="w-4 h-4 text-[var(--accent)] shrink-0" />
              <span>{controller.preJoinNotice}</span>
            </div>
          )}

          {/* Real Device Quick Selectors */}
          {config.meetingMode === 'builtin' && (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
              <select
                aria-label="اختيار الميكروفون"
                value={controller.selectedAudioInputId}
                onChange={(e) => void controller.selectAudioInput(e.target.value)}
                className="rahhala-input min-h-[44px] px-3 py-2 text-xs"
              >
                {controller.devices.audioInputs.length === 0 ? (
                  <option value="">الميكروفون الافتراضي</option>
                ) : (
                  controller.devices.audioInputs.map((d, i) => (
                    <option key={d.deviceId || i} value={d.deviceId}>
                      {d.label || `ميكروفون ${i + 1}`}
                    </option>
                  ))
                )}
              </select>

              <select
                aria-label="اختيار الكاميرا"
                value={controller.selectedVideoInputId}
                onChange={(e) => void controller.selectVideoInput(e.target.value)}
                className="rahhala-input min-h-[44px] px-3 py-2 text-xs"
              >
                {controller.devices.videoInputs.length === 0 ? (
                  <option value="">الكاميرا الافتراضية</option>
                ) : (
                  controller.devices.videoInputs.map((d, i) => (
                    <option key={d.deviceId || i} value={d.deviceId}>
                      {d.label || `كاميرا ${i + 1}`}
                    </option>
                  ))
                )}
              </select>

              <select
                aria-label="اختيار السماعة"
                value={controller.selectedAudioOutputId}
                onChange={(e) => controller.selectAudioOutput(e.target.value)}
                className="rahhala-input min-h-[44px] px-3 py-2 text-xs"
              >
                {controller.devices.audioOutputs.length === 0 ? (
                  <option value="">السماعة الافتراضية</option>
                ) : (
                  controller.devices.audioOutputs.map((d, i) => (
                    <option key={d.deviceId || i} value={d.deviceId}>
                      {d.label || `سماعة ${i + 1}`}
                    </option>
                  ))
                )}
              </select>
            </div>
          )}
        </section>

        {/* Right Join Card (Google Meet "Ready to join?") */}
        <section className="rahhala-card p-5 flex flex-col justify-between gap-5">
          <div className="space-y-4">
            <div className="space-y-1.5">
              <div className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
                <span
                  className="w-2.5 h-2.5 rounded-full shrink-0"
                  style={{ backgroundColor: room.subjectColor }}
                  aria-hidden="true"
                />
                <span className="font-bold text-[var(--text-primary)]">{room.subjectName}</span>
                <span>·</span>
                <span>
                  {settings.roomLocked
                    ? 'المجلس مقفول'
                    : settings.accessType === 'knock'
                    ? 'يتطلب موافقة المضيف'
                    : 'دخول مفتوح'}
                </span>
              </div>
              <h1 className="text-xl font-extrabold text-[var(--text-primary)] leading-snug">
                {room.title}
              </h1>
              <p className="text-xs text-[var(--text-secondary)]">
                بإدارة: {room.creatorName}
              </p>
            </div>

            {/* Active participants preview */}
            <div className="p-3.5 rounded-xl bg-[var(--bg-surface)] border border-[var(--divider)] space-y-2.5">
              <div className="text-xs font-bold text-[var(--text-primary)]">
                {room.participants.length > 0
                  ? `${room.participants.length} مشارك متواجد الآن في المجلس`
                  : 'لا يوجد أحد في المجلس بعد — كن أول المنضمين'}
              </div>
              {room.participants.length > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  {room.participants.slice(0, 6).map((p) => (
                    <div
                      key={p.userId}
                      className="flex items-center gap-1.5 text-xs text-[var(--text-secondary)]"
                    >
                      <Avatar name={p.displayName} assetId={p.avatarAssetId} size="sm" />
                      <span className="truncate max-w-[100px]">{p.displayName}</span>
                    </div>
                  ))}
                  {room.participants.length > 6 && (
                    <span className="text-xs font-bold text-[var(--accent)]">
                      +{room.participants.length - 6}
                    </span>
                  )}
                </div>
              )}
            </div>

            {!userIsHost && (settings.muteOnEntry || !settings.allowMic || !settings.allowCam) && (
              <div className="p-3 rounded-xl bg-[var(--accent-soft)] border border-[var(--accent)]/30 text-xs text-[var(--text-primary)] space-y-1">
                <div className="font-bold text-[var(--accent)]">سياسة هذا المجلس:</div>
                {!settings.allowMic && <div>• الميكروفون مقفل للمشاركين من المضيف.</div>}
                {settings.muteOnEntry && settings.allowMic && (
                  <div>• سيتم كتم الميكروفون تلقائياً عند الدخول.</div>
                )}
                {!settings.allowCam && <div>• الكاميرا مقفلة للمشاركين من المضيف.</div>}
              </div>
            )}

            {/* Knocking / Waiting Room State */}
            {controller.knockStatus === 'pending' && (
              <div className="p-4 rounded-2xl bg-[var(--accent-soft)] border border-[var(--accent)]/40 text-center space-y-3">
                <div className="w-12 h-12 rounded-full bg-[var(--accent)]/20 text-[var(--accent)] flex items-center justify-center mx-auto animate-pulse">
                  <Icons.ShieldCheck className="w-6 h-6" />
                </div>
                <div className="space-y-1">
                  <div className="text-sm font-extrabold text-[var(--text-primary)]">
                    بانتظار سماح المضيف بالدخول…
                  </div>
                  <p className="text-xs text-[var(--text-secondary)]">
                    سيتم إدخالك تلقائياً فور موافقة المضيف على طلبك.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={controller.cancelKnock}
                  className="min-h-[40px] px-4 rounded-xl bg-[var(--bg-surface)] border border-[var(--divider)] text-xs font-bold text-[var(--text-primary)]"
                >
                  إلغاء الطلب
                </button>
              </div>
            )}

            {controller.knockStatus === 'rejected' && controller.knockMessage && (
              <div className="p-3.5 rounded-xl bg-[var(--error-soft)] text-[var(--error)] text-xs font-bold">
                {controller.knockMessage}
              </div>
            )}
          </div>

          <div className="space-y-2.5 pt-2">
            <button
              type="button"
              disabled={
                controller.joining ||
                controller.knockStatus === 'pending' ||
                (settings.roomLocked && !userIsHost)
              }
              onClick={() => void controller.joinFromPreJoin()}
              className="w-full min-h-[48px] px-5 rounded-xl bg-[var(--accent)] text-[var(--accent-fg)] text-sm font-extrabold flex items-center justify-center gap-2 hover:bg-[var(--accent-hi)] disabled:opacity-50"
            >
              <Icons.Video className="w-4 h-4" />
              <span>
                {controller.knockStatus === 'pending'
                  ? 'في قاعة الانتظار…'
                  : settings.roomLocked && !userIsHost
                  ? 'المجلس مقفول من المضيف'
                  : settings.accessType === 'knock' && !userIsHost
                  ? 'اطلب الانضمام للمجلس'
                  : 'انضم الآن'}
              </span>
            </button>

            {config.meetingMode === 'builtin' && (
              <button
                type="button"
                disabled={
                  controller.joining ||
                  controller.knockStatus === 'pending' ||
                  (settings.roomLocked && !userIsHost)
                }
                onClick={() => void controller.joinFromPreJoin({ listenerOnly: true })}
                className="w-full min-h-[44px] px-4 rounded-xl bg-[var(--bg-surface)] border border-[var(--divider)] hover:border-[var(--accent)] text-xs sm:text-sm font-bold text-[var(--text-primary)] flex items-center justify-center gap-2 disabled:opacity-50"
              >
                <Icons.Headphones className="w-4 h-4 text-[var(--accent)]" />
                <span>الدخول بوضع المستمع والمشاركة النصية</span>
              </button>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

export function MajalisView({
  config,
  user,
  controller,
  onToast,
  theaterMode = false,
  onToggleTheaterMode,
}: {
  config: AppPublicConfig;
  user: AuthUser;
  controller: MajalisController;
  onToast: (msg: string, isError?: boolean) => void;
  theaterMode?: boolean;
  onToggleTheaterMode?: () => void;
}) {
  const [createOpen, setCreateOpen] = useState(false);
  const [newRoomTitle, setNewRoomTitle] = useState('');
  const [newRoomSubjectId, setNewRoomSubjectId] = useState('');
  const [newRoomAccess, setNewRoomAccess] = useState<MajalisAccessType>(
    config.defaultRoomAccessType || 'open'
  );
  const [newRoomAllowScreen, setNewRoomAllowScreen] = useState(true);
  const [newRoomAllowChat, setNewRoomAllowChat] = useState(true);
  const [newRoomMuteOnEntry, setNewRoomMuteOnEntry] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  const [roomToDelete, setRoomToDelete] = useState<MajalisRoomSummary | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const [layoutMode, setLayoutMode] = useState<MajalisLayoutMode>('spotlight');
  const [localPinnedId, setLocalPinnedId] = useState<string | null>(null);
  const [sidePanel, setSidePanel] = useState<'chat' | 'people' | 'host' | 'timer'>('chat');
  const [devicesModalOpen, setDevicesModalOpen] = useState(false);
  const [reactionsMenuOpen, setReactionsMenuOpen] = useState(false);
  const [leaveMenuOpen, setLeaveMenuOpen] = useState(false);
  const [settingsBusy, setSettingsBusy] = useState(false);

  const [chatInput, setChatInput] = useState('');
  const [chatBusy, setChatBusy] = useState(false);
  const chatBottomRef = useRef<HTMLDivElement | null>(null);

  // Google Meet-style keyboard shortcuts while active in a room (M mic, V cam, H hand, Esc menus/theater)
  useEffect(() => {
    if (!controller.joined) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || target?.isContentEditable) {
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === 'm' && config.meetingMode === 'builtin') {
        e.preventDefault();
        void controller.toggleMic();
      } else if (key === 'v' && config.meetingMode === 'builtin') {
        e.preventDefault();
        void controller.toggleCam();
      } else if (key === 'h') {
        e.preventDefault();
        controller.toggleHandRaise();
      } else if (e.key === 'Escape') {
        setReactionsMenuOpen(false);
        setLeaveMenuOpen(false);
        if (theaterMode && onToggleTheaterMode) {
          onToggleTheaterMode();
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [controller, config.meetingMode, theaterMode, onToggleTheaterMode]);

  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [controller.messages.length]);

  useEffect(() => {
    if (!controller.joined) {
      setLeaveMenuOpen(false);
      setReactionsMenuOpen(false);
      setLocalPinnedId(null);
    }
  }, [controller.joined]);

  const handleCreateRoom = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreateBusy(true);
    try {
      const created = await controller.createRoom({
        title: newRoomTitle.trim(),
        subjectId: newRoomSubjectId || null,
        accessType: newRoomAccess,
        allowScreenShare: newRoomAllowScreen,
        allowChat: newRoomAllowChat,
        muteOnEntry: newRoomMuteOnEntry,
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

  const handleToggleSetting = async (patch: Partial<MajalisRoomSettings>) => {
    if (!controller.activeRoom) return;
    setSettingsBusy(true);
    try {
      await controller.updateRoomSettings(controller.activeRoom.id, patch);
      onToast('تم تحديث إعدادات المجلس');
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'تعذر تحديث الإعدادات', true);
    } finally {
      setSettingsBusy(false);
    }
  };

  // PRE-JOIN GREEN ROOM VIEW
  if (!controller.joined && controller.preJoinRoom) {
    return (
      <>
        <PreJoinGreenRoom
          user={user}
          config={config}
          controller={controller}
          onOpenDevices={() => setDevicesModalOpen(true)}
        />
        <DeviceSettingsModal
          open={devicesModalOpen}
          onClose={() => setDevicesModalOpen(false)}
          controller={controller}
        />
      </>
    );
  }

  // LOBBY VIEW (before selecting or joining any room)
  if (!controller.joined) {
    return (
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="font-display text-2xl sm:text-3xl font-bold text-[var(--text-primary)] leading-tight">
              مجالس المذاكرة الجماعية
            </h1>
            <p className="text-xs sm:text-sm text-[var(--text-secondary)] mt-0.5">
              جهّز الميكروفون والكاميرا في غرفة التحضير، وادخل مجالس المذاكرة بضوابط مضيف حقيقية ومؤقت متزامن
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void controller.refreshRooms()}
              className="min-h-[44px] px-3.5 rounded-xl rahhala-glass-pill text-xs font-bold text-[var(--text-primary)] hover:border-[var(--accent)] flex items-center gap-1.5 whitespace-nowrap"
            >
              <Icons.Refresh className="w-4 h-4" />
              <span>تحديث</span>
            </button>

            <button
              type="button"
              onClick={() => {
                setNewRoomAccess(config.defaultRoomAccessType || 'open');
                setCreateOpen(true);
              }}
              className="min-h-[44px] px-4 rounded-xl bg-[var(--accent)] text-[var(--accent-fg)] text-xs sm:text-sm font-bold flex items-center gap-1.5 hover:bg-[var(--accent-hi)] whitespace-nowrap"
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
              className="min-h-[36px] min-w-[36px] rounded-lg hover:bg-[var(--bg-surface)] flex items-center justify-center"
            >
              <Icons.X className="w-4 h-4" />
            </button>
          </div>
        )}

        {controller.roomsLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {[1, 2, 3].map((k) => (
              <div key={k} className="rahhala-card h-56 animate-pulse" />
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
              const rSettings = room.settings ?? DEFAULT_ROOM_SETTINGS;

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
                        <div className="flex flex-wrap items-center gap-2 text-[11px] text-[var(--text-secondary)]">
                          {rSettings.roomLocked ? (
                            <span className="text-[var(--error)] font-bold flex items-center gap-1">
                              <Icons.Lock className="w-3 h-3" /> مقفول
                            </span>
                          ) : rSettings.accessType === 'knock' ? (
                            <span className="text-[var(--accent)] font-semibold flex items-center gap-1">
                              <Icons.ShieldCheck className="w-3 h-3" /> يتطلب موافقة
                            </span>
                          ) : (
                            <span>دخول مفتوح</span>
                          )}
                          <span>·</span>
                          <span>{room.creatorName}</span>
                        </div>
                      </div>

                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          type="button"
                          onClick={() => controller.copyInviteLink(room.id)}
                          aria-label={`نسخ رابط ${room.title}`}
                          className="min-h-[36px] min-w-[36px] rounded-xl bg-[var(--bg-surface)] text-[var(--text-secondary)] hover:text-[var(--accent)] flex items-center justify-center"
                        >
                          <Icons.Link className="w-4 h-4" />
                        </button>
                        {canDelete && (
                          <button
                            type="button"
                            onClick={() => setRoomToDelete(room)}
                            aria-label={`حذف مجلس ${room.title}`}
                            className="min-h-[36px] min-w-[36px] rounded-xl bg-[var(--bg-surface)] text-[var(--text-secondary)] hover:text-[var(--error)] hover:bg-[var(--error-soft)] flex items-center justify-center"
                          >
                            <Icons.Trash className="w-4 h-4" />
                          </button>
                        )}
                      </div>
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
                      onClick={() => void controller.openPreJoin(room.id)}
                      className="flex-1 min-h-[44px] px-4 rounded-xl bg-[var(--accent)] text-[var(--accent-fg)] text-xs sm:text-sm font-bold flex items-center justify-center gap-1.5 hover:bg-[var(--accent-hi)] disabled:opacity-50 whitespace-nowrap"
                    >
                      <Icons.Video className="w-4 h-4" />
                      <span>تحضير ودخول المجلس</span>
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

            <div>
              <label
                htmlFor="majalis-room-access"
                className="block text-xs font-bold text-[var(--text-secondary)] mb-1.5"
              >
                سياسة الوصول (مثل Google Meet)
              </label>
              <select
                id="majalis-room-access"
                value={newRoomAccess}
                onChange={(e) => setNewRoomAccess(e.target.value as MajalisAccessType)}
                className="rahhala-input w-full px-3.5 py-2 text-sm"
              >
                <option value="open">مفتوح — يدخل الأعضاء الموثقون مباشرة</option>
                <option value="knock">موثوق (قاعة انتظار) — يطلب العضو الإذن من المضيف</option>
              </select>
            </div>

            <div className="space-y-2 pt-1">
              <ToggleRow
                label="السماح بمشاركة الشاشة"
                description="تمكين المشاركين من عرض شاشاتهم أو ملفاتهم"
                checked={newRoomAllowScreen}
                onChange={setNewRoomAllowScreen}
              />
              <ToggleRow
                label="السماح بمحادثة المجلس"
                description="تمكين الرسائل النصية الجانبية أثناء الجلسة"
                checked={newRoomAllowChat}
                onChange={setNewRoomAllowChat}
              />
              <ToggleRow
                label="كتم الميكروفون عند الدخول"
                description="يدخل المشاركون بميكروفون مكتوم لتجنب الضوضاء"
                checked={newRoomMuteOnEntry}
                onChange={setNewRoomMuteOnEntry}
              />
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

  // ACTIVE GOOGLE MEET-STYLE ROOM VIEW
  const roomSettings = controller.activeRoom?.settings ?? DEFAULT_ROOM_SETTINGS;
  const totalParticipants = controller.peers.length + 1;
  const phaseDurations: MajalisTimerPhase[] = ['focus', 'review', 'break'];

  const selfTile = {
    userId: user.id,
    displayName: user.displayName,
    avatarAssetId: user.avatarAssetId,
    mode: controller.mode,
    micMuted: controller.micMuted,
    camOff: controller.camOff,
    screenSharing: controller.screenSharing,
    handRaised: controller.handRaised,
    joinedAt: 0,
    stream: controller.localStream,
    isSelf: true,
  };

  const allTiles = [
    selfTile,
    ...controller.peers.map((p) => ({ ...p, isSelf: false })),
  ];

  // Determine Spotlight / Pinned Tile: local pin > host spotlight > screen share > first peer > self
  const effectivePinId =
    localPinnedId ||
    controller.activeRoom?.spotlightUserId ||
    allTiles.find((t) => t.screenSharing)?.userId ||
    allTiles.find((t) => !t.isSelf)?.userId ||
    user.id;

  const spotlightTile =
    layoutMode === 'spotlight' && allTiles.length > 1
      ? allTiles.find((t) => t.userId === effectivePinId) ?? allTiles[0]
      : null;

  const stripTiles = spotlightTile
    ? allTiles.filter((t) => t.userId !== spotlightTile.userId)
    : allTiles;

  const canUseMic = controller.isHost || roomSettings.allowMic;
  const canUseCam = controller.isHost || roomSettings.allowCam;
  const canShareScreen = controller.isHost || roomSettings.allowScreenShare;
  const canSendChat = controller.isHost || roomSettings.allowChat;

  return (
    <div className="space-y-4">
      {/* Top Meeting Bar */}
      <div className="rahhala-card p-3.5 sm:p-4 flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--text-secondary)]">
            <span className="font-bold text-[var(--accent)]">
              {controller.activeRoom?.subjectName || 'مذاكرة جماعية'}
            </span>
            <span aria-hidden="true">·</span>
            <span className="tabular-nums">{totalParticipants} مشارك</span>
            <span aria-hidden="true">·</span>
            <span>{modeLabel(controller.mode)}</span>
            {roomSettings.roomLocked && (
              <>
                <span aria-hidden="true">·</span>
                <span className="text-[var(--error)] font-bold flex items-center gap-1">
                  <Icons.Lock className="w-3 h-3" /> مقفول
                </span>
              </>
            )}
            {!controller.wsConnected && (
              <>
                <span aria-hidden="true">·</span>
                <span className="text-[var(--error)] font-semibold">جاري إعادة الاتصال…</span>
              </>
            )}
          </div>
          <h1 className="text-base sm:text-lg font-extrabold text-[var(--text-primary)] truncate mt-0.5">
            {controller.activeRoom?.title || 'مجلس المذاكرة النشط'}
          </h1>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Synchronized Pomodoro quick badge */}
          <button
            type="button"
            onClick={() => setSidePanel('timer')}
            className="min-h-[40px] px-3 rounded-xl bg-[var(--bg-surface)] border border-[var(--divider)] hover:border-[var(--accent)] text-xs font-extrabold text-[var(--text-primary)] flex items-center gap-1.5 tabular-nums whitespace-nowrap"
          >
            <Icons.Clock className="w-4 h-4 text-[var(--accent)]" />
            <span>{formatCountdownMs(controller.remainingMs)}</span>
          </button>

          {/* Layout Switcher (Spotlight vs Grid) */}
          <button
            type="button"
            onClick={() =>
              setLayoutMode((m) => (m === 'spotlight' ? 'grid' : 'spotlight'))
            }
            className="min-h-[40px] px-3 rounded-xl bg-[var(--bg-surface)] border border-[var(--divider)] hover:border-[var(--accent)] text-xs font-bold text-[var(--text-primary)] flex items-center gap-1.5 whitespace-nowrap"
          >
            {layoutMode === 'spotlight' ? (
              <>
                <Icons.LayoutGrid className="w-4 h-4 text-[var(--accent)]" />
                <span>شبكة</span>
              </>
            ) : (
              <>
                <Icons.Columns className="w-4 h-4 text-[var(--accent)]" />
                <span>المتحدث الرئيسي</span>
              </>
            )}
          </button>

          {/* Copy Invite Link */}
          {controller.activeRoom && (
            <button
              type="button"
              onClick={() => controller.copyInviteLink(controller.activeRoom!.id)}
              className="min-h-[40px] px-3 rounded-xl bg-[var(--bg-surface)] border border-[var(--divider)] hover:border-[var(--accent)] text-xs font-bold text-[var(--text-primary)] flex items-center gap-1.5 whitespace-nowrap"
            >
              <Icons.Link className="w-4 h-4 text-[var(--accent)]" />
              <span className="hidden sm:inline">رابط الدعوة</span>
            </button>
          )}

          {/* Theater / Focus Mode Toggle */}
          {onToggleTheaterMode && (
            <button
              type="button"
              onClick={onToggleTheaterMode}
              aria-pressed={theaterMode}
              title={theaterMode ? 'إظهار قوائم المنصة' : 'وضع التركيز الكامل'}
              className={`min-h-[40px] px-3 rounded-xl border text-xs font-bold flex items-center gap-1.5 whitespace-nowrap transition-colors ${
                theaterMode
                  ? 'bg-[var(--accent)] border-transparent text-[var(--accent-fg)]'
                  : 'bg-[var(--bg-surface)] border-[var(--divider)] hover:border-[var(--accent)] text-[var(--text-primary)]'
              }`}
            >
              {theaterMode ? (
                <Icons.Minimize className="w-4 h-4" />
              ) : (
                <Icons.Maximize className="w-4 h-4 text-[var(--accent)]" />
              )}
              <span className="hidden md:inline">
                {theaterMode ? 'إظهار القوائم' : 'وضع التركيز'}
              </span>
            </button>
          )}
        </div>
      </div>

      {/* Host Real-Time Knock Request Banner (just like Google Meet Admit/Deny prompt) */}
      {controller.isHost && controller.knockQueue.length > 0 && (
        <div
          role="alert"
          className="rahhala-card p-3.5 border-[var(--accent)] bg-[var(--accent-soft)] flex flex-wrap items-center justify-between gap-3"
        >
          <div className="flex items-center gap-2.5 min-w-0">
            <Avatar
              name={controller.knockQueue[0].displayName}
              assetId={controller.knockQueue[0].avatarAssetId}
              size="sm"
            />
            <div className="min-w-0">
              <div className="text-xs sm:text-sm font-extrabold text-[var(--text-primary)] truncate">
                {controller.knockQueue[0].displayName} يطلب الانضمام إلى المجلس
              </div>
              {controller.knockQueue.length > 1 && (
                <div className="text-[11px] text-[var(--text-secondary)]">
                  ويوجد {controller.knockQueue.length - 1} طلبات أخرى في الانتظار
                </div>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => controller.decideKnock(controller.knockQueue[0].userId, false)}
              className="min-h-[40px] px-4 rounded-xl bg-[var(--bg-surface)] border border-[var(--divider)] text-xs font-bold text-[var(--error)]"
            >
              رفض
            </button>
            <button
              type="button"
              onClick={() => controller.decideKnock(controller.knockQueue[0].userId, true)}
              className="min-h-[40px] px-4 rounded-xl bg-[var(--accent)] text-[var(--accent-fg)] text-xs font-extrabold"
            >
              سماح بالدخول
            </button>
          </div>
        </div>
      )}

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
            {canUseMic && (
              <button
                type="button"
                onClick={() => void controller.upgradeMedia(false)}
                className="min-h-[36px] px-3 rounded-lg bg-[var(--accent-soft)] text-[var(--accent)] font-bold hover:opacity-90 whitespace-nowrap"
              >
                إعادة محاولة الميكروفون
              </button>
            )}
            <button
              type="button"
              onClick={controller.dismissNotice}
              aria-label="إغلاق الملاحظة"
              className="min-h-[36px] min-w-[36px] rounded-lg hover:bg-[var(--bg-surface)] flex items-center justify-center text-[var(--text-secondary)]"
            >
              <Icons.X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Workspace Split: Main Media Stage + Companion Drawer (Chat / People / Host Controls / Timer) */}
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_350px] gap-4 items-start">
        {/* Left/Main Stage with Floating Emoji Reactions */}
        <div className="relative space-y-3.5 min-w-0">
          {controller.reactions.length > 0 && (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute bottom-4 right-4 z-20 flex flex-col gap-1.5"
            >
              {controller.reactions.map((r) => (
                <div
                  key={r.id}
                  className="px-3 py-1.5 rounded-full bg-black/70 text-white text-xs font-bold flex items-center gap-1.5 shadow-lg animate-bounce"
                >
                  <span className="text-base">{r.emoji}</span>
                  <span>{r.displayName}</span>
                </div>
              ))}
            </div>
          )}

          {config.meetingMode === 'external' && config.meetingExternalUrl ? (
            <div className="rahhala-card overflow-hidden h-[60dvh] flex flex-col">
              <div className="p-2.5 bg-[var(--bg-surface)] border-b border-[var(--divider)] flex items-center justify-between gap-2 text-xs">
                <span className="text-[var(--text-secondary)] truncate">
                  بعض المزودين (مثل Google Meet) يرفضون العرض داخل إطار؛ يمكنك فتح الرابط مباشرة:
                </span>
                <a
                  href={config.meetingExternalUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="min-h-[36px] px-3 rounded-lg bg-[var(--accent)] text-[var(--accent-fg)] font-bold flex items-center gap-1.5 shrink-0 whitespace-nowrap"
                >
                  <Icons.ExternalLink className="w-3.5 h-3.5" />
                  <span>فتح الرابط</span>
                </a>
              </div>
              <iframe
                src={config.meetingExternalUrl}
                title="مجلس المذاكرة"
                allow="camera; microphone; fullscreen; display-capture"
                className="w-full flex-1 border-0"
              />
            </div>
          ) : spotlightTile ? (
            <div className="space-y-3">
              <VideoStreamTile
                stream={spotlightTile.stream}
                label={spotlightTile.displayName}
                avatarAssetId={spotlightTile.avatarAssetId}
                mode={spotlightTile.mode}
                micMuted={spotlightTile.micMuted}
                camOff={spotlightTile.camOff}
                screenSharing={spotlightTile.screenSharing}
                handRaised={spotlightTile.handRaised}
                isSelf={spotlightTile.isSelf}
                isHostBadge={controller.activeRoom?.creatorId === spotlightTile.userId}
                isPinned={localPinnedId === spotlightTile.userId || controller.activeRoom?.spotlightUserId === spotlightTile.userId}
                large
                onTogglePin={() =>
                  setLocalPinnedId((cur) =>
                    cur === spotlightTile.userId ? null : spotlightTile.userId
                  )
                }
              />
              {stripTiles.length > 0 && (
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
                  {stripTiles.map((t) => (
                    <VideoStreamTile
                      key={t.userId}
                      stream={t.stream}
                      label={t.displayName}
                      avatarAssetId={t.avatarAssetId}
                      mode={t.mode}
                      micMuted={t.micMuted}
                      camOff={t.camOff}
                      screenSharing={t.screenSharing}
                      handRaised={t.handRaised}
                      isSelf={t.isSelf}
                      isHostBadge={controller.activeRoom?.creatorId === t.userId}
                      isPinned={localPinnedId === t.userId}
                      onTogglePin={() => setLocalPinnedId(t.userId)}
                    />
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div
              className={`grid gap-3.5 ${
                allTiles.length <= 1
                  ? 'grid-cols-1'
                  : allTiles.length <= 4
                  ? 'grid-cols-1 sm:grid-cols-2'
                  : 'grid-cols-1 sm:grid-cols-2 xl:grid-cols-3'
              }`}
            >
              {allTiles.map((t) => (
                <VideoStreamTile
                  key={t.userId}
                  stream={t.stream}
                  label={t.displayName}
                  avatarAssetId={t.avatarAssetId}
                  mode={t.mode}
                  micMuted={t.micMuted}
                  camOff={t.camOff}
                  screenSharing={t.screenSharing}
                  handRaised={t.handRaised}
                  isSelf={t.isSelf}
                  isHostBadge={controller.activeRoom?.creatorId === t.userId}
                  isPinned={localPinnedId === t.userId}
                  onTogglePin={() => {
                    setLocalPinnedId(t.userId);
                    setLayoutMode('spotlight');
                  }}
                />
              ))}
            </div>
          )}

          {/* Bottom Google Meet Control Dock */}
          <div className="rahhala-card p-2.5 sm:p-3 flex flex-wrap items-center justify-center gap-2 relative">
            {config.meetingMode === 'builtin' && (
              <>
                <button
                  type="button"
                  disabled={!canUseMic}
                  onClick={() => void controller.toggleMic()}
                  className={`min-h-[44px] px-3.5 rounded-full border text-xs font-bold flex items-center gap-1.5 whitespace-nowrap disabled:opacity-45 ${
                    controller.mode === 'listener' || controller.micMuted
                      ? 'bg-[var(--error)] border-transparent text-white'
                      : 'bg-[var(--bg-surface)] border-[var(--divider)] text-[var(--text-primary)] hover:border-[var(--accent)]'
                  }`}
                >
                  {controller.mode === 'listener' || controller.micMuted ? (
                    <Icons.MicOff className="w-4 h-4" />
                  ) : (
                    <Icons.Mic className="w-4 h-4 text-[var(--success)]" />
                  )}
                  <span className="hidden sm:inline">
                    {controller.mode === 'listener'
                      ? 'تفعيل الصوت'
                      : controller.micMuted
                      ? 'فتح المايك'
                      : 'كتم المايك'}
                  </span>
                </button>

                <button
                  type="button"
                  disabled={!canUseCam}
                  onClick={() => void controller.toggleCam()}
                  className={`min-h-[44px] px-3.5 rounded-full border text-xs font-bold flex items-center gap-1.5 whitespace-nowrap disabled:opacity-45 ${
                    controller.camOff
                      ? 'bg-[var(--error)] border-transparent text-white'
                      : 'bg-[var(--bg-surface)] border-[var(--divider)] text-[var(--text-primary)] hover:border-[var(--accent)]'
                  }`}
                >
                  {controller.camOff ? (
                    <Icons.VideoOff className="w-4 h-4" />
                  ) : (
                    <Icons.Video className="w-4 h-4 text-[var(--accent)]" />
                  )}
                  <span className="hidden sm:inline">
                    {controller.camOff ? 'تشغيل الكاميرا' : 'إغلاق الكاميرا'}
                  </span>
                </button>

                <button
                  type="button"
                  disabled={!canShareScreen && !controller.screenSharing}
                  onClick={() => void controller.toggleScreenShare()}
                  className={`min-h-[44px] px-3.5 rounded-full border text-xs font-bold flex items-center gap-1.5 whitespace-nowrap disabled:opacity-45 ${
                    controller.screenSharing
                      ? 'bg-[var(--accent)] border-transparent text-[var(--accent-fg)]'
                      : 'bg-[var(--bg-surface)] border-[var(--divider)] text-[var(--text-primary)] hover:border-[var(--accent)]'
                  }`}
                >
                  <Icons.Monitor className="w-4 h-4" />
                  <span className="hidden md:inline">
                    {controller.screenSharing ? 'إيقاف المشاركة' : 'مشاركة الشاشة'}
                  </span>
                </button>
              </>
            )}

            <button
              type="button"
              onClick={controller.toggleHandRaise}
              className={`min-h-[44px] px-3.5 rounded-full border text-xs font-bold flex items-center gap-1.5 whitespace-nowrap ${
                controller.handRaised
                  ? 'bg-[var(--accent)] text-[var(--accent-fg)] border-transparent'
                  : 'bg-[var(--bg-surface)] border-[var(--divider)] text-[var(--text-primary)] hover:border-[var(--accent)]'
              }`}
            >
              <Icons.Hand className="w-4 h-4" />
              <span className="hidden md:inline">
                {controller.handRaised ? 'خفض اليد' : 'رفع اليد'}
              </span>
            </button>

            {/* Quick Reactions */}
            <div className="relative">
              <button
                type="button"
                onClick={() => setReactionsMenuOpen((o) => !o)}
                aria-label="إرسال تفاعل سريع"
                className="min-h-[44px] min-w-[44px] px-3 rounded-full bg-[var(--bg-surface)] border border-[var(--divider)] hover:border-[var(--accent)] text-[var(--text-primary)] flex items-center justify-center"
              >
                <Icons.Smile className="w-4 h-4" />
              </button>
              {reactionsMenuOpen && (
                <div className="absolute bottom-14 left-1/2 -translate-x-1/2 z-30 rahhala-card px-2 py-1.5 flex items-center gap-1 shadow-xl">
                  {QUICK_REACTIONS.map((emoji) => (
                    <button
                      key={emoji}
                      type="button"
                      onClick={() => {
                        controller.sendReaction(emoji);
                        setReactionsMenuOpen(false);
                      }}
                      className="min-h-[40px] min-w-[40px] rounded-full hover:bg-[var(--bg-surface)] text-lg flex items-center justify-center"
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {config.meetingMode === 'builtin' && (
              <button
                type="button"
                onClick={() => {
                  void controller.refreshDevices();
                  setDevicesModalOpen(true);
                }}
                aria-label="إعدادات الأجهزة والصوت"
                className="min-h-[44px] min-w-[44px] px-3 rounded-full bg-[var(--bg-surface)] border border-[var(--divider)] hover:border-[var(--accent)] text-[var(--text-primary)] flex items-center justify-center"
              >
                <Icons.Sliders className="w-4 h-4" />
              </button>
            )}

            {controller.mode !== 'listener' && config.meetingMode === 'builtin' && (
              <button
                type="button"
                onClick={controller.switchToListener}
                aria-label="التحول لوضع المستمع"
                className="min-h-[44px] px-3 rounded-full bg-[var(--bg-surface)] border border-[var(--divider)] hover:border-[var(--accent)] text-xs font-bold text-[var(--text-secondary)] flex items-center gap-1.5 whitespace-nowrap"
              >
                <Icons.Headphones className="w-4 h-4" />
                <span className="hidden lg:inline">مستمع</span>
              </button>
            )}

            {/* Leave / End Meeting for All */}
            <div className="relative">
              <button
                type="button"
                onClick={() => {
                  if (controller.isHost) {
                    setLeaveMenuOpen((o) => !o);
                  } else {
                    controller.leaveMeeting();
                  }
                }}
                aria-label="مغادرة أو إنهاء المجلس"
                className="min-h-[44px] px-4 rounded-full bg-[var(--error)] text-white text-xs font-extrabold flex items-center gap-1.5 whitespace-nowrap"
              >
                <Icons.PhoneOff className="w-4 h-4" />
                <span>{controller.isHost ? 'إنهاء / مغادرة' : 'مغادرة'}</span>
              </button>

              {controller.isHost && leaveMenuOpen && (
                <div className="absolute bottom-14 left-0 z-30 w-56 rahhala-card p-2 space-y-1.5 shadow-2xl">
                  <button
                    type="button"
                    onClick={() => {
                      setLeaveMenuOpen(false);
                      controller.leaveMeeting();
                    }}
                    className="w-full min-h-[42px] px-3 rounded-xl bg-[var(--bg-surface)] hover:border-[var(--accent)] border border-[var(--divider)] text-xs font-bold text-[var(--text-primary)] text-right"
                  >
                    مغادرة المكالمة فقط
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setLeaveMenuOpen(false);
                      void controller.endMeetingForAll();
                    }}
                    className="w-full min-h-[42px] px-3 rounded-xl bg-[var(--error)] text-white text-xs font-extrabold text-right"
                  >
                    إنهاء المجلس للجميع
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Right Google Meet Drawer: Tabs (Chat / People / Host Controls / Timer) */}
        <aside className="rahhala-card overflow-hidden flex flex-col">
          <div
            role="tablist"
            aria-label="أدوات المجلس"
            className="grid border-b border-[var(--divider)] bg-[var(--bg-surface)]/60"
            style={{
              gridTemplateColumns: `repeat(${controller.isHost ? 4 : 3}, minmax(0, 1fr))`,
            }}
          >
            <button
              type="button"
              role="tab"
              aria-selected={sidePanel === 'chat'}
              onClick={() => setSidePanel('chat')}
              className={`min-h-[44px] px-2 text-xs font-bold flex items-center justify-center gap-1 border-b-2 transition-colors ${
                sidePanel === 'chat'
                  ? 'border-[var(--accent)] text-[var(--accent)]'
                  : 'border-transparent text-[var(--text-secondary)]'
              }`}
            >
              <Icons.MessageSquare className="w-3.5 h-3.5" />
              <span>الدردشة</span>
            </button>

            <button
              type="button"
              role="tab"
              aria-selected={sidePanel === 'people'}
              onClick={() => setSidePanel('people')}
              className={`min-h-[44px] px-2 text-xs font-bold flex items-center justify-center gap-1 border-b-2 transition-colors ${
                sidePanel === 'people'
                  ? 'border-[var(--accent)] text-[var(--accent)]'
                  : 'border-transparent text-[var(--text-secondary)]'
              }`}
            >
              <Icons.Users className="w-3.5 h-3.5" />
              <span className="tabular-nums">المشاركون ({totalParticipants})</span>
            </button>

            {controller.isHost && (
              <button
                type="button"
                role="tab"
                aria-selected={sidePanel === 'host'}
                onClick={() => setSidePanel('host')}
                className={`relative min-h-[44px] px-2 text-xs font-bold flex items-center justify-center gap-1 border-b-2 transition-colors ${
                  sidePanel === 'host'
                    ? 'border-[var(--accent)] text-[var(--accent)]'
                    : 'border-transparent text-[var(--text-secondary)]'
                }`}
              >
                <Icons.ShieldCheck className="w-3.5 h-3.5" />
                <span>المضيف</span>
                {controller.knockQueue.length > 0 && (
                  <span className="text-[10px] font-extrabold text-[var(--error)] tabular-nums">
                    ({controller.knockQueue.length})
                  </span>
                )}
              </button>
            )}

            <button
              type="button"
              role="tab"
              aria-selected={sidePanel === 'timer'}
              onClick={() => setSidePanel('timer')}
              className={`min-h-[44px] px-2 text-xs font-bold flex items-center justify-center gap-1 border-b-2 transition-colors ${
                sidePanel === 'timer'
                  ? 'border-[var(--accent)] text-[var(--accent)]'
                  : 'border-transparent text-[var(--text-secondary)]'
              }`}
            >
              <Icons.Clock className="w-3.5 h-3.5" />
              <span>المؤقت</span>
            </button>
          </div>

          {/* Tab 1: Room Chat */}
          {sidePanel === 'chat' && (
            <div className="p-4 flex flex-col h-[460px]">
              <div className="flex items-center justify-between gap-2 pb-2.5 border-b border-[var(--divider)]">
                <h2 className="text-sm font-extrabold text-[var(--text-primary)]">
                  محادثة المجلس
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

              {canSendChat ? (
                <form onSubmit={handleSendChat} className="pt-2 border-t border-[var(--divider)] flex gap-2">
                  <input
                    type="text"
                    maxLength={500}
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    placeholder="اكتب رسالة داخل المجلس…"
                    aria-label="رسالة داخل المجلس"
                    className="rahhala-input flex-1 min-h-[44px] px-3 py-1.5 text-xs sm:text-sm"
                  />
                  <button
                    type="submit"
                    disabled={chatBusy || !chatInput.trim()}
                    aria-label="إرسال رسالة"
                    className="min-h-[44px] min-w-[44px] rounded-xl bg-[var(--accent)] text-[var(--accent-fg)] flex items-center justify-center disabled:opacity-50"
                  >
                    <Icons.Send className="w-4 h-4" />
                  </button>
                </form>
              ) : (
                <div className="pt-2 border-t border-[var(--divider)] text-xs text-[var(--text-secondary)] text-center py-2">
                  تم إيقاف الدردشة مؤقتاً من قِبل المضيف.
                </div>
              )}
            </div>
          )}

          {/* Tab 2: Participants List + Quick Host Moderation */}
          {sidePanel === 'people' && (
            <div className="p-4 space-y-3 max-h-[460px] overflow-y-auto">
              {controller.isHost && (
                <div className="flex flex-wrap gap-2 pb-2 border-b border-[var(--divider)]">
                  <button
                    type="button"
                    onClick={() => {
                      controller.hostAction('mute_all');
                      onToast('تم كتم صوت جميع المشاركين');
                    }}
                    className="flex-1 min-h-[40px] px-3 rounded-xl bg-[var(--bg-surface)] border border-[var(--divider)] hover:border-[var(--accent)] text-xs font-bold text-[var(--text-primary)] flex items-center justify-center gap-1.5 whitespace-nowrap"
                  >
                    <Icons.MicOff className="w-3.5 h-3.5 text-[var(--error)]" />
                    <span>كتم الكل</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => controller.hostAction('lower_all_hands')}
                    className="min-h-[40px] px-3 rounded-xl bg-[var(--bg-surface)] border border-[var(--divider)] hover:border-[var(--accent)] text-xs font-bold text-[var(--text-primary)] whitespace-nowrap"
                  >
                    خفض الأيادي
                  </button>
                </div>
              )}

              <div className="divide-y divide-[var(--divider)]">
                {allTiles.map((p) => {
                  const isSpotlit = controller.activeRoom?.spotlightUserId === p.userId;
                  return (
                    <div key={p.userId} className="py-2.5 first:pt-0 last:pb-0 flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2.5 min-w-0">
                        <Avatar name={p.displayName} assetId={p.avatarAssetId} size="sm" />
                        <div className="min-w-0">
                          <div className="text-xs font-bold text-[var(--text-primary)] truncate">
                            {p.displayName}
                            {p.isSelf ? ' (أنت)' : ''}
                          </div>
                          <div className="text-[11px] text-[var(--text-secondary)]">
                            {modeLabel(p.mode)}
                            {p.handRaised ? ' · يرفع يده' : ''}
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-1 shrink-0">
                        {p.micMuted ? (
                          <Icons.MicOff className="w-4 h-4 text-[var(--error)]" />
                        ) : (
                          <Icons.Mic className="w-4 h-4 text-[var(--success)]" />
                        )}

                        {controller.isHost && (
                          <>
                            <button
                              type="button"
                              onClick={() =>
                                controller.hostAction('spotlight_user', isSpotlit ? null : p.userId)
                              }
                              aria-label={isSpotlit ? 'إلغاء تثبيت للجميع' : 'تثبيت للجميع'}
                              className={`min-h-[34px] min-w-[34px] rounded-lg flex items-center justify-center ${
                                isSpotlit
                                  ? 'bg-[var(--accent)] text-[var(--accent-fg)]'
                                  : 'bg-[var(--bg-surface)] text-[var(--text-secondary)] hover:text-[var(--accent)]'
                              }`}
                            >
                              <Icons.Pin className="w-3.5 h-3.5" />
                            </button>

                            {!p.isSelf && !p.micMuted && (
                              <button
                                type="button"
                                onClick={() => controller.hostAction('mute_user', p.userId)}
                                aria-label={`كتم ${p.displayName}`}
                                className="min-h-[34px] min-w-[34px] rounded-lg bg-[var(--bg-surface)] text-[var(--text-secondary)] hover:text-[var(--error)] flex items-center justify-center"
                              >
                                <Icons.MicOff className="w-3.5 h-3.5" />
                              </button>
                            )}

                            {!p.isSelf && (
                              <button
                                type="button"
                                onClick={() => controller.hostAction('kick_user', p.userId)}
                                aria-label={`إبعاد ${p.displayName}`}
                                className="min-h-[34px] min-w-[34px] rounded-lg bg-[var(--error-soft)] text-[var(--error)] flex items-center justify-center"
                              >
                                <Icons.UserX className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Tab 3: Google Meet Host Controls ("ضوابط المضيف") */}
          {sidePanel === 'host' && controller.isHost && (
            <div className="p-4 space-y-4 max-h-[460px] overflow-y-auto">
              {controller.knockQueue.length > 0 && (
                <div className="space-y-2 pb-3 border-b border-[var(--divider)]">
                  <div className="text-xs font-extrabold text-[var(--accent)]">
                    طلبات الانضمام ({controller.knockQueue.length})
                  </div>
                  {controller.knockQueue.map((q) => (
                    <div
                      key={q.userId}
                      className="p-2.5 rounded-xl bg-[var(--bg-surface)] border border-[var(--divider)] flex items-center justify-between gap-2"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <Avatar name={q.displayName} assetId={q.avatarAssetId} size="sm" />
                        <span className="text-xs font-bold text-[var(--text-primary)] truncate">
                          {q.displayName}
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <button
                          type="button"
                          onClick={() => controller.decideKnock(q.userId, false)}
                          className="min-h-[34px] px-2.5 rounded-lg bg-[var(--error-soft)] text-[var(--error)] text-xs font-bold"
                        >
                          رفض
                        </button>
                        <button
                          type="button"
                          onClick={() => controller.decideKnock(q.userId, true)}
                          className="min-h-[34px] px-2.5 rounded-lg bg-[var(--accent)] text-[var(--accent-fg)] text-xs font-bold"
                        >
                          قبول
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <div className="space-y-2">
                <div className="text-xs font-extrabold text-[var(--text-primary)]">
                  إدارة الوصول إلى المجلس
                </div>
                <ToggleRow
                  label="قفل المجلس"
                  description="منع دخول أي مشارك جديد مؤقتاً"
                  checked={roomSettings.roomLocked}
                  disabled={settingsBusy}
                  onChange={(val) => void handleToggleSetting({ roomLocked: val })}
                />
                <ToggleRow
                  label="طلب الإذن قبل الدخول (قاعة انتظار)"
                  description="يحتاج المشاركون لموافقتك قبل الانضمام"
                  checked={roomSettings.accessType === 'knock'}
                  disabled={settingsBusy}
                  onChange={(val) =>
                    void handleToggleSetting({ accessType: val ? 'knock' : 'open' })
                  }
                />
              </div>

              <div className="space-y-2 pt-2 border-t border-[var(--divider)]">
                <div className="text-xs font-extrabold text-[var(--text-primary)]">
                  أذونات المشاركين
                </div>
                <ToggleRow
                  label="السماح بمشاركة الشاشة"
                  description="تمكين الطلاب من مشاركة شاشاتهم"
                  checked={roomSettings.allowScreenShare}
                  disabled={settingsBusy}
                  onChange={(val) => void handleToggleSetting({ allowScreenShare: val })}
                />
                <ToggleRow
                  label="السماح برسائل الدردشة"
                  description="تمكين كتابة الرسائل في محادثة المجلس"
                  checked={roomSettings.allowChat}
                  disabled={settingsBusy}
                  onChange={(val) => void handleToggleSetting({ allowChat: val })}
                />
                <ToggleRow
                  label="السماح بتشغيل الميكروفون"
                  description="السماح للمشاركين بفتح الميكروفون والتحدث"
                  checked={roomSettings.allowMic}
                  disabled={settingsBusy}
                  onChange={(val) => void handleToggleSetting({ allowMic: val })}
                />
                <ToggleRow
                  label="السماح بتشغيل الكاميرا"
                  description="السماح للمشاركين بتشغيل الكاميرا"
                  checked={roomSettings.allowCam}
                  disabled={settingsBusy}
                  onChange={(val) => void handleToggleSetting({ allowCam: val })}
                />
                <ToggleRow
                  label="كتم تلقائي عند الدخول"
                  description="يدخل المشاركون بميكروفون مكتوم"
                  checked={roomSettings.muteOnEntry}
                  disabled={settingsBusy}
                  onChange={(val) => void handleToggleSetting({ muteOnEntry: val })}
                />
              </div>
            </div>
          )}

          {/* Tab 4: Synchronized Group Pomodoro Timer */}
          {sidePanel === 'timer' && (
            <div className="p-4 space-y-4">
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
                      className={`min-h-[38px] px-2 rounded-xl text-[11px] font-bold border transition-colors whitespace-nowrap ${
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

              <div className="py-4 text-center">
                <div className="text-5xl font-extrabold tracking-tight text-[var(--text-primary)] tabular-nums">
                  {formatCountdownMs(controller.remainingMs)}
                </div>
                {controller.timer.updatedByName && (
                  <div className="text-[11px] text-[var(--text-secondary)] mt-2">
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
                  className="flex-1 min-h-[44px] px-4 rounded-xl bg-[var(--accent)] text-[var(--accent-fg)] text-xs font-bold flex items-center justify-center gap-1.5 hover:bg-[var(--accent-hi)]"
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
                  className="min-h-[44px] min-w-[44px] rounded-xl bg-[var(--bg-surface)] border border-[var(--divider)] hover:border-[var(--accent)] text-[var(--text-primary)] flex items-center justify-center"
                >
                  <Icons.RotateCcw className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}
        </aside>
      </div>

      <DeviceSettingsModal
        open={devicesModalOpen}
        onClose={() => setDevicesModalOpen(false)}
        controller={controller}
      />
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
            className="min-h-[34px] min-w-[34px] rounded-lg bg-[var(--bg-surface)] flex items-center justify-center text-[var(--text-primary)]"
          >
            <Icons.Maximize className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={controller.leaveMeeting}
            aria-label="مغادرة المجلس"
            className="min-h-[34px] min-w-[34px] rounded-lg bg-[var(--error-soft)] text-[var(--error)] flex items-center justify-center"
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
            className="min-h-[36px] min-w-[36px] rounded-lg bg-[var(--bg-surface)] flex items-center justify-center text-[var(--text-primary)]"
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
