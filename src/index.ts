import SimplePeer from 'simple-peer';
import type { Instance as SimplePeerInstance } from 'simple-peer';

export interface PartialMeshConfig {
  /**
   * Minimum number of peers to maintain connections with
   */
  minPeers?: number;
  
  /**
   * Maximum number of peers to maintain connections with
   */
  maxPeers?: number;

  /**
   * Soft-max overflow allowance above maxPeers.
   * Example: maxPeers=5 and maxPeersTolerance=2 allows up to 7 connected peers
   * before trimming starts.
   */
  maxPeersTolerance?: number;
  
  /**
   * UniWRTC signaling server URL
   */
  signalingServer?: string;
  
  /**
   * Session/room ID for peer discovery
   */
  sessionId?: string;
  
  /**
   * Automatically discover peers through the signaling server
   */
  autoDiscover?: boolean;
  
  /**
   * Automatically connect to discovered peers
   */
  autoConnect?: boolean;

  // Intentionally minimal config surface.
  
  /**
   * ICE servers configuration for STUN/TURN
   */
  iceServers?: RTCIceServer[];

  /**
   * How long to wait for a peer connection to reach 'connect' before retrying.
   * Helps avoid peers getting stuck in 'connecting' indefinitely.
   */
  connectionTimeoutMs?: number;

  /**
   * Periodic maintenance interval for autoConnect.
    * When set, the mesh will periodically attempt to converge to the desired connection count.
   */
  maintenanceIntervalMs?: number;

  /**
   * If set (>0), perform a hard reset of all peer connections when the mesh remains
   * under-connected (connectedPeers < minPeers) for this long while there are enough
   * discovered peers available to connect to.
   *
   * This helps recover from rare stuck negotiation/ICE states in some browsers.
   */
  underConnectedResetMs?: number;

  /**
   * How often to re-announce and re-discover on the signaling server (ms).
   * Lower values speed up peer discovery but increase CPU/network load.
   * Default: 3000.
   */
  announceIntervalMs?: number;

  /**
   * Debounce announce messages triggered by offer/answer/ICE signal bursts.
   * Reduces CPU/network overhead during negotiation.
   */
  debounceSignalAnnounce?: boolean;

  /**
   * Debounce delay for signal-triggered announce messages.
   */
  announceDebounceMs?: number;

  /**
   * Timeout for establishing signaling websocket connection (ms).
   * If exceeded, the socket is closed and reconnect backoff is applied.
   */
  signalingConnectTimeoutMs?: number;

  /**
   * Automatically reconnect signaling websocket when it closes unexpectedly.
   */
  signalingAutoReconnect?: boolean;

  /**
   * Base delay for signaling reconnect backoff (ms).
   */
  signalingReconnectBaseMs?: number;

  /**
   * Max delay for signaling reconnect backoff (ms).
   */
  signalingReconnectMaxMs?: number;

  /**
   * Pause signaling polling and reconnect attempts while tab is hidden.
   */
  pauseWhenHidden?: boolean;
}

export interface PeerConnection {
  id: string;
  peer: SimplePeerInstance;
  connected: boolean;
  initiator: boolean;
}

export type PartialMeshEvents = {
  'signaling:connected': (data: { clientId: string; rawClientId?: string }) => void;
  'signaling:disconnected': () => void;
  'signaling:error': (error: any) => void;
  'peer:connected': (peerId: string) => void;
  'peer:disconnected': (peerId: string) => void;
  'peer:data': (data: { peerId: string; data: any }) => void;
  'peer:error': (data: { peerId: string; error: any }) => void;
  'peer:discovered': (peerId: string) => void;
  'mesh:ready': () => void;
};

/**
 * PartialMesh - WebRTC peer-to-peer partial mesh networking library
 * 
 * Uses UniWRTC for signaling and maintains a configurable number of peer connections.
 */
export class PartialMesh {
  private config: Required<PartialMeshConfig>;
  private peers: Map<string, PeerConnection> = new Map();
  private ws: WebSocket | null = null;
  private announceTimer: ReturnType<typeof setInterval> | null = null;
  private instanceId: string | null = null;
  private peerSessionIds: Map<string, string> = new Map();
  private discoveredPeers: Set<string> = new Set();
  private clientId: string | null = null;
  private eventHandlers: Map<keyof PartialMeshEvents, Set<Function>> = new Map();
  private connecting: Set<string> = new Set();
  private connectionTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private maintenanceTimer: ReturnType<typeof setInterval> | null = null;
  private underConnectedSinceMs: number | null = null;
  private lastHardResetAtMs: number = 0;
  private announceDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts: number = 0;
  private signalingUrl: string | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private initialConnectTimer: ReturnType<typeof setTimeout> | null = null;
  private hasSignalingConnectedOnce: boolean = false;
  private destroyed: boolean = false;
  private lifecycleListenersBound: boolean = false;
  private peerReconnectState: Map<string, { attempts: number; nextAttemptAtMs: number }> = new Map();
  private readonly handleVisibilityChange = (): void => {
    if (typeof document !== 'undefined') {
      if (document.visibilityState === 'visible') {
        // Tab became visible: reset clocks and recover connections
        this.resetConnectionTimers();
        this.underConnectedSinceMs = null;
        this.recoverSignaling('visibility');
        if (this.config.autoConnect) {
          this.maintainPeerConnections();
        }
      } else {
        // Don't accumulate under-connected wall-clock time while hidden.
        // Browser background throttling can make this look like persistent failure.
        this.underConnectedSinceMs = null;
      }
      // Don't hard reset on hide — aggressive timers keep connections alive in background tabs
    }
  };
  private readonly handleOnline = (): void => {
    this.recoverSignaling('online');
  };
  private readonly handlePageShow = (): void => {
    // pageshow fires on initial load too; avoid racing initial connect with
    // an immediate recovery attempt.
    if (!this.hasSignalingConnectedOnce) return;
    this.recoverSignaling('pageshow');
  };

  constructor(config: PartialMeshConfig = {}) {
    this.config = {
      minPeers: config.minPeers ?? 2,
      maxPeers: config.maxPeers ?? 10,
      maxPeersTolerance: Math.max(0, Math.floor(config.maxPeersTolerance ?? 1)),
      signalingServer: config.signalingServer ?? 'wss://peer.ooo/ws',
      sessionId: config.sessionId ?? 'default-session',
      autoDiscover: config.autoDiscover ?? true,
      autoConnect: config.autoConnect ?? true,
      iceServers: config.iceServers ?? [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun.cloudflare.com:3478' }
      ],
      connectionTimeoutMs: config.connectionTimeoutMs ?? 12_000,
      maintenanceIntervalMs: config.maintenanceIntervalMs ?? 2_000,
      underConnectedResetMs: config.underConnectedResetMs ?? 0,
      announceIntervalMs: config.announceIntervalMs ?? 1_000,
      debounceSignalAnnounce: config.debounceSignalAnnounce ?? true,
      announceDebounceMs: config.announceDebounceMs ?? 150,
      signalingConnectTimeoutMs: config.signalingConnectTimeoutMs ?? 8_000,
      signalingAutoReconnect: config.signalingAutoReconnect ?? true,
      signalingReconnectBaseMs: config.signalingReconnectBaseMs ?? 2_500,
      signalingReconnectMaxMs: config.signalingReconnectMaxMs ?? 30_000,
      pauseWhenHidden: config.pauseWhenHidden ?? false
    };

    // Initialize event handler maps
    const events: (keyof PartialMeshEvents)[] = [
      'signaling:connected',
      'signaling:disconnected',
      'signaling:error',
      'peer:connected',
      'peer:disconnected',
      'peer:data',
      'peer:error',
      'peer:discovered',
      'mesh:ready'
    ];
    events.forEach(event => this.eventHandlers.set(event, new Set()));
  }

  private normalizePeerId(peerId: string | null | undefined): string {
    return (peerId ?? '').trim();
  }

  private isConnectablePeerId(peerId: string, selfId: string): boolean {
    if (!peerId || peerId === selfId) return false;
    // Signaling system identifiers are not dialable WebRTC peers.
    if (peerId === 'bootstrap-relay') return false;
    return true;
  }

  // ─── PSP helpers ────────────────────────────────────────────────────────────

  private generateId(prefix = ''): string {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
    return prefix ? `${prefix}-${hex}` : hex;
  }

  private getOrCreateClientId(): string {
    const fallback = this.generateId();
    if (typeof window === 'undefined' || typeof window.sessionStorage === 'undefined') {
      return fallback;
    }

    const key = `partialmesh:clientId:${this.config.sessionId}`;
    try {
      const existing = (window.sessionStorage.getItem(key) ?? '').trim();
      if (existing) return existing;
      window.sessionStorage.setItem(key, fallback);
      return fallback;
    } catch {
      return fallback;
    }
  }

  private sendPsp(type: string, body: any, to: string | null = null, sessionId: string | null = null): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const envelope = {
      psp_version: '1.0',
      type,
      network: this.config.sessionId,
      from: this.clientId,
      to,
      session_id: sessionId,
      message_id: this.generateId('msg'),
      timestamp: Date.now(),
      ttl_ms: 30000,
      body
    };
    this.ws.send(JSON.stringify(envelope));
  }

  private sendAnnounce(): void {
    const hardMaxPeers = this.getHardMaxPeers();
    this.sendPsp('announce', {
      instance_id: this.instanceId,
      roles: ['peer'],
      capabilities: { trickle_ice: true, restart_ice: false, datachannel: true, media: false },
      hints: {
        max_peers: hardMaxPeers,
        connected_peers: this.getConnectedPeers().length,
        wants_peers: this.peers.size < hardMaxPeers
      }
    });
  }

  private getHardMaxPeers(): number {
    return this.config.maxPeers + this.config.maxPeersTolerance;
  }

  /**
   * Debounced version of sendAnnounce. Collapses rapid bursts of ICE signals into
   * a single announce, preventing CPU spikes during WebRTC negotiation.
   */
  private debouncedAnnounce(): void {
    const debounceMs = Number.isFinite(this.config.announceDebounceMs)
      ? Math.max(0, Math.floor(this.config.announceDebounceMs))
      : 150;

    if (!this.config.debounceSignalAnnounce || debounceMs <= 0) {
      if (this.announceDebounceTimer) {
        clearTimeout(this.announceDebounceTimer);
        this.announceDebounceTimer = null;
      }
      this.sendAnnounce();
      return;
    }

    if (this.announceDebounceTimer) clearTimeout(this.announceDebounceTimer);
    this.announceDebounceTimer = setTimeout(() => {
      this.announceDebounceTimer = null;
      this.sendAnnounce();
    }, debounceMs);
  }

  private sendDiscover(): void {
    // Ask for maxPeers plus a logarithmic slack set to absorb churn/failed dials
    // without scaling discovery load linearly with mesh size.
    const maxPeers = Math.max(1, this.config.maxPeers);
    const logSlack = Math.ceil(10 * Math.log2(maxPeers + 1));
    const limit = Math.max(8, Math.min(5000, maxPeers + logSlack));
    this.sendPsp('discover', { want_roles: ['peer'], limit });
  }

  private isPausedByVisibility(): boolean {
    if (!this.config.pauseWhenHidden) return false;
    if (typeof document === 'undefined') return false;
    return document.visibilityState === 'hidden';
  }

  private isDocumentHidden(): boolean {
    if (typeof document === 'undefined') return false;
    return document.visibilityState === 'hidden';
  }

  private armConnectionTimeout(peerId: string): void {
    const existing = this.connectionTimers.get(peerId);
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      const current = this.peers.get(peerId);
      if (!current || current.connected) return;
      if (current.peer.destroyed) return;

      // Browser timer throttling in background tabs can delay/cluster callbacks.
      // Defer timeout enforcement until the tab is visible again to avoid churn.
      if (this.isDocumentHidden()) {
        this.armConnectionTimeout(peerId);
        return;
      }

      this.connecting.delete(peerId);
      this.notePeerConnectFailure(peerId);
      this.emit('peer:error', { peerId, error: new Error('Connection timeout') });
      try {
        current.peer.destroy();
      } catch {
        // ignore
      }
      this.removePeer(peerId);
    }, this.config.connectionTimeoutMs);

    this.connectionTimers.set(peerId, timer);
  }

  private bindLifecycleListeners(): void {
    if (this.lifecycleListenersBound) return;
    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.handleOnline);
      window.addEventListener('pageshow', this.handlePageShow);
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.handleVisibilityChange);
    }
    this.lifecycleListenersBound = true;
  }

  private unbindLifecycleListeners(): void {
    if (!this.lifecycleListenersBound) return;
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.handleOnline);
      window.removeEventListener('pageshow', this.handlePageShow);
    }
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    }
    this.lifecycleListenersBound = false;
  }

  private getSignalingState(): number {
    return this.ws ? this.ws.readyState : WebSocket.CLOSED;
  }

  private isSignalingOpen(): boolean {
    return this.getSignalingState() === WebSocket.OPEN;
  }

  /**
   * Restart connection timeout timers for all in-flight (not yet connected) peers.
   * Called on tab wakeup so timers that fired during suspension don't falsely tear
   * down connections that are still negotiating.
   */
  private resetConnectionTimers(): void {
    for (const [peerId, t] of Array.from(this.connectionTimers.entries())) {
      const pc = this.peers.get(peerId);
      if (!pc || pc.connected) {
        // Already connected or gone — timer is stale, clean it up.
        clearTimeout(t);
        this.connectionTimers.delete(peerId);
        continue;
      }
      // Restart timeout with the full budget from now.
      this.armConnectionTimeout(peerId);
    }
  }

  private notePeerConnectFailure(peerId: string): void {
    const prev = this.peerReconnectState.get(peerId);
    const attempts = (prev?.attempts ?? 0) + 1;
    // Retry faster while under-connected, slower once mesh is healthy.
    const underConnected = this.getConnectedPeers().length < this.config.minPeers;
    const base = underConnected ? 250 : 1_000;
    const max = underConnected ? 2_000 : 30_000;
    const delay = Math.min(max, base * Math.pow(2, Math.min(attempts - 1, 6)));
    this.peerReconnectState.set(peerId, {
      attempts,
      nextAttemptAtMs: Date.now() + delay
    });
  }

  private clearPeerConnectFailure(peerId: string): void {
    this.peerReconnectState.delete(peerId);
  }

  private canAttemptPeerConnect(peerId: string): boolean {
    const state = this.peerReconnectState.get(peerId);
    if (!state) return true;
    return Date.now() >= state.nextAttemptAtMs;
  }

  private deferPeerReconnect(peerId: string, delayMs: number): void {
    if (!peerId) return;
    const delay = Math.max(0, Math.floor(delayMs));
    const prev = this.peerReconnectState.get(peerId);
    const attempts = Math.max(1, prev?.attempts ?? 0);
    this.peerReconnectState.set(peerId, {
      attempts,
      nextAttemptAtMs: Date.now() + delay
    });
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private startAnnounceLoop(): void {
    if (!this.config.autoDiscover) return;
    if (this.announceTimer) clearInterval(this.announceTimer);
    this.announceTimer = setInterval(() => {
      this.sendAnnounce();
      this.sendDiscover();
    }, this.config.announceIntervalMs);
  }

  private stopAnnounceLoop(): void {
    if (!this.announceTimer) return;
    clearInterval(this.announceTimer);
    this.announceTimer = null;
  }

  private startHeartbeat(socket: WebSocket): void {
    this.stopHeartbeat();
    // Send a keepalive announce every 20 s so the server doesn't close the idle connection.
    // Most WebSocket proxies / servers have a 30–60 s idle timeout.
    this.heartbeatTimer = setInterval(() => {
      if (socket.readyState !== WebSocket.OPEN) {
        this.stopHeartbeat();
        return;
      }
      try { this.sendAnnounce(); } catch { /* ignore */ }
    }, 20_000);
  }

  private stopHeartbeat(): void {
    if (!this.heartbeatTimer) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private scheduleReconnect(reason: string): void {
    if (this.destroyed || !this.config.signalingAutoReconnect) return;
    if (this.reconnectTimer) return;

    const base = Math.max(250, this.config.signalingReconnectBaseMs);
    const max = Math.max(base, this.config.signalingReconnectMaxMs);
    const attempt = this.reconnectAttempts;
    const jitterFactor = 0.8 + Math.random() * 0.4;
    const delay = Math.floor(Math.min(max, base * Math.pow(2, Math.min(attempt, 8)) * jitterFactor));

    this.reconnectAttempts = attempt + 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectSignaling();
    }, delay);

    try {
      // eslint-disable-next-line no-console
      console.warn(`[PartialMesh] scheduling signaling reconnect in ${delay}ms (${reason})`);
    } catch {
      // ignore
    }
  }

  private recoverSignaling(reason: string): void {
    if (this.destroyed || !this.config.signalingAutoReconnect) return;
    if (this.isPausedByVisibility()) return;
    const state = this.getSignalingState();
    if (state === WebSocket.OPEN || state === WebSocket.CONNECTING) return;

    this.clearReconnectTimer();
    this.reconnectAttempts = 0;
    this.connectSignaling();

    try {
      // eslint-disable-next-line no-console
      console.warn(`[PartialMesh] attempting signaling recovery (${reason})`);
    } catch {
      // ignore
    }
  }

  private connectSignaling(): void {
    if (this.destroyed || !this.signalingUrl) return;

    const state = this.getSignalingState();
    if (state === WebSocket.OPEN || state === WebSocket.CONNECTING) return;

    const socket = new WebSocket(this.signalingUrl);
    this.ws = socket;
    let opened = false;
    const openTimeout = setTimeout(() => {
      if (opened) return;
      if (this.ws !== socket) return;
      if (socket.readyState === WebSocket.CONNECTING) {
        try { socket.close(); } catch { /* ignore */ }
      }
    }, Math.max(1_000, this.config.signalingConnectTimeoutMs));

    socket.onopen = () => {
      opened = true;
      clearTimeout(openTimeout);
      this.reconnectAttempts = 0;
      this.hasSignalingConnectedOnce = true;
      this.clearReconnectTimer();
      this.emit('signaling:connected', { clientId: this.clientId! });

      // Any peer handshakes that were in-flight when the WS was down are dead.
      // Clear them so maintainPeerConnections can retry immediately.
      for (const peerId of Array.from(this.connecting)) {
        const pc = this.peers.get(peerId);
        if (pc && !pc.connected) {
          try { pc.peer.destroy(); } catch { /* ignore */ }
          this.peers.delete(peerId);
        }
        this.connecting.delete(peerId);
      }

      this.sendAnnounce();
      this.sendDiscover();
      this.startAnnounceLoop();

      if (this.config.autoConnect) {
        this.startMaintenanceLoop();
        this.maintainPeerConnections();
      }
      // Clear per-peer backoff state so all discovered peers can be retried
      // immediately after a signaling reconnect (new WS = fresh network conditions).
      this.peerReconnectState.clear();

      // Send a periodic keepalive announce so the server doesn't close the idle WS.
      this.startHeartbeat(socket);
    };

    socket.onmessage = (event: MessageEvent) => {
      try {
        this.handlePspMessage(JSON.parse(event.data as string));
      } catch {
        // ignore malformed messages
      }
    };

    socket.onclose = () => {
      clearTimeout(openTimeout);
      if (this.ws === socket) this.ws = null;
      this.stopAnnounceLoop();
      this.emit('signaling:disconnected');

      this.stopHeartbeat();
      this.scheduleReconnect('close');
    };

    socket.onerror = (errorEvent: Event) => {
      const ws = errorEvent.target as WebSocket | null;
      const message = ws
        ? `WebSocket signaling error (readyState=${ws.readyState})`
        : 'WebSocket signaling error';
      const error = new Error(message);
      this.emit('signaling:error', error);

      // Some browser/network stacks surface websocket failures as error without
      // a reliable close callback. Ensure reconnect is always scheduled.
      if (this.ws === socket && socket.readyState === WebSocket.CONNECTING) {
        try { socket.close(); } catch { /* ignore */ }
        // If the browser never delivers close(), force cleanup so future
        // connectSignaling() calls are not blocked by a stale CONNECTING socket.
        setTimeout(() => {
          if (this.ws !== socket) return;
          if (socket.readyState === WebSocket.CONNECTING) {
            try { socket.close(); } catch { /* ignore */ }
            this.ws = null;
            this.scheduleReconnect('error-timeout');
          }
        }, 1_000);
      }
      this.scheduleReconnect('error');

    };
  }

  private handlePspMessage(msg: any): void {
    if (!msg || !msg.type) return;
    // Reject messages not for our network
    if (msg.network && msg.network !== this.config.sessionId) return;

    const selfId = this.normalizePeerId(this.clientId);
    const fromId = this.normalizePeerId(msg.from);

    switch (msg.type) {
      case 'announce': {
        if (!this.isConnectablePeerId(fromId, selfId)) break;
        if (!this.discoveredPeers.has(fromId)) {
          this.discoveredPeers.add(fromId);
          // Clear backoff when we see a fresh announcement; network conditions may have improved
          this.clearPeerConnectFailure(fromId);
          this.emit('peer:discovered', fromId);
          if (this.config.autoConnect) this.maintainPeerConnections();
        }
        break;
      }
      case 'peer_list': {
        const peers: any[] = msg.body?.peers ?? [];
        peers.forEach((p: any) => {
          const peerId = this.normalizePeerId(p.peer_id);
          if (this.isConnectablePeerId(peerId, selfId) && !this.discoveredPeers.has(peerId)) {
            this.discoveredPeers.add(peerId);
            // Clear backoff when we discover a peer; network conditions may have improved
            this.clearPeerConnectFailure(peerId);
            this.emit('peer:discovered', peerId);
          }
        });
        if (peers.length > 0 && this.config.autoConnect) this.maintainPeerConnections();
        break;
      }
      case 'withdraw':
      case 'bye': {
        if (!fromId || fromId === selfId) break;
        this.discoveredPeers.delete(fromId);
        this.removePeer(fromId, true);
        break;
      }
      case 'offer': {
        if (!fromId || fromId === selfId) break;
        const sessionId = msg.session_id;
        if (sessionId) this.peerSessionIds.set(fromId, sessionId);
        this.handleOffer(fromId, { type: 'offer', sdp: msg.body?.sdp });
        // Do NOT announce here: announcing after receiving a signal creates a feedback
        // cascade (receive → announce → server delivers more → receive → ...) that spins
        // at 150ms intervals and pegs CPU. The periodic 1-second timer handles polling.
        break;
      }
      case 'answer': {
        if (!fromId || fromId === selfId) break;
        this.handleAnswer(fromId, { type: 'answer', sdp: msg.body?.sdp });
        break;
      }
      case 'ice_candidate': {
        if (!fromId || fromId === selfId) break;
        this.handleIceCandidate(fromId, msg.body?.candidate);
        break;
      }
      case 'error': {
        // ignore relay errors (e.g. unknown_peer for stale sessions)
        break;
      }
    }
  }

  // ─── Init ────────────────────────────────────────────────────────────────────

  /**
   * Initialize and connect to the signaling server
   */
  init(): void {
    this.destroyed = false;
    this.bindLifecycleListeners();

    // Keep identity stable across reloads in the same tab/session so one tab
    // does not temporarily appear as multiple peers.
    this.clientId = this.getOrCreateClientId();
    this.instanceId = this.generateId('inst');

    // Normalize scheme: https→wss, http→ws.
    const rawUrl = this.config.signalingServer;
    this.signalingUrl = rawUrl.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');

    // Fire-and-forget: WebSocket connects in the background.
    // Keep jitter small so startup latency stays low while still reducing
    // synchronized connect bursts across many tabs.
    // Track status via signaling:connected / signaling:disconnected events.
    if (this.initialConnectTimer) {
      clearTimeout(this.initialConnectTimer);
      this.initialConnectTimer = null;
    }
    const initialJitterMs = Math.floor(Math.random() * 200);
    this.initialConnectTimer = setTimeout(() => {
      this.initialConnectTimer = null;
      this.connectSignaling();
    }, initialJitterMs);
  }

  private startMaintenanceLoop(): void {
    if (this.maintenanceTimer) return;
    if (!this.config.maintenanceIntervalMs || this.config.maintenanceIntervalMs <= 0) return;

    this.maintenanceTimer = setInterval(() => {
      try {
        this.maintainPeerConnections();
        this.maybeHardResetUnderConnected();
      } catch {
        // ignore
      }
    }, this.config.maintenanceIntervalMs);
  }

  private maybeHardResetUnderConnected(): void {
    const thresholdMs = this.config.underConnectedResetMs;
    if (!thresholdMs || thresholdMs <= 0) return;

    // Hidden tabs are heavily throttled and may appear falsely under-connected.
    // Don't schedule hard resets while hidden.
    if (this.isDocumentHidden()) {
      this.underConnectedSinceMs = null;
      return;
    }

    const connected = this.getConnectedPeers().length;
    const hasEnoughCandidates = this.discoveredPeers.size >= this.config.minPeers;
    const underConnected = connected < this.config.minPeers && hasEnoughCandidates;

    const now = Date.now();

    if (!underConnected) {
      this.underConnectedSinceMs = null;
      return;
    }

    if (this.underConnectedSinceMs == null) {
      this.underConnectedSinceMs = now;
      return;
    }

    // Avoid repeated rapid resets if the environment is genuinely unable to connect.
    if (now - this.underConnectedSinceMs < thresholdMs) return;
    if (now - this.lastHardResetAtMs < thresholdMs) return;

    this.hardReset('under-connected');
  }

  /**
   * Hard reset peer connections (keeps signaling + discovered peers).
   * Useful for recovering from rare stuck negotiation/ICE states.
   */
  public hardReset(reason: string = 'manual'): void {
    this.lastHardResetAtMs = Date.now();
    this.underConnectedSinceMs = null;

    for (const t of this.connectionTimers.values()) {
      clearTimeout(t);
    }
    this.connectionTimers.clear();

    for (const peerConnection of this.peers.values()) {
      try {
        if (!peerConnection.peer.destroyed) peerConnection.peer.destroy();
      } catch {
        // ignore
      }
    }

    this.peers.clear();
    this.connecting.clear();

    // Clear peer reconnect backoff state so we can immediately retry after reset
    this.peerReconnectState.clear();

    // Re-announce to refresh discovery state in the signaling layer.
    try {
      this.sendAnnounce();
      this.sendDiscover();
    } catch {
      // ignore
    }

    if (this.config.autoConnect) {
      try {
        this.maintainPeerConnections();
      } catch {
        // ignore
      }
    }

    // Best-effort debug signal.
    try {
      // eslint-disable-next-line no-console
      console.warn(`[PartialMesh] hardReset(${reason}) clientId=${this.clientId ?? ''} discovered=${this.discoveredPeers.size}`);
    } catch {
      // ignore
    }
  }

  /**
   * Handle incoming WebRTC offer
   */
  private async handleOffer(peerId: string, offer: RTCSessionDescriptionInit): Promise<void> {
    const selfId = this.normalizePeerId(this.clientId);
    const normalizedPeerId = this.normalizePeerId(peerId);
    if (!normalizedPeerId || normalizedPeerId === selfId) return;

    let peerConnection = this.peers.get(normalizedPeerId);

    // Soft max admission control for new inbound peers.
    if (!peerConnection) {
      if (!this.canAttemptPeerConnect(normalizedPeerId)) {
        return;
      }
      const hardMaxPeers = this.getHardMaxPeers();
      if (this.getConnectedPeers().length + this.connecting.size >= hardMaxPeers) {
        return;
      }
    }

    // If both sides initiated simultaneously (offer glare), resolve deterministically:
    // smaller ID remains initiator; larger ID accepts remote offer and becomes responder.
    // This avoids the broken state where both peers switch to responder and then reject answers.
    if (peerConnection?.initiator) {
      const keepLocalInitiator = !!selfId && selfId < normalizedPeerId;
      if (keepLocalInitiator) {
        // Ignore remote offer: our local offer is canonical for this pair.
        return;
      }
      try {
        peerConnection.peer.destroy();
      } catch {
        // ignore
      }
      // Ensure timers/state are cleaned up.
      this.removePeer(normalizedPeerId, false);
      peerConnection = undefined;
    }

    if (!peerConnection) {
      // Create responder when offer arrives.
      peerConnection = this.createPeerConnection(normalizedPeerId, false);
    } else {
      // Start/restart timeout when a fresh offer is received.
      this.armConnectionTimeout(normalizedPeerId);
    }

    try {
      peerConnection.peer.signal(offer);
    } catch (err) {
      console.error(`Error signaling offer from peer ${peerId}:`, err);
    }
  }

  /**
   * Handle incoming WebRTC answer
   */
  private async handleAnswer(peerId: string, answer: RTCSessionDescriptionInit): Promise<void> {
    const selfId = this.normalizePeerId(this.clientId);
    const normalizedPeerId = this.normalizePeerId(peerId);
    if (!normalizedPeerId || normalizedPeerId === selfId) return;

    const peerConnection = this.peers.get(normalizedPeerId);

    // If we don't have a connection for this peer yet, ignore.
    if (!peerConnection) return;

    try {
      peerConnection.peer.signal(answer);
    } catch (err) {
      console.error(`Error signaling answer from peer ${peerId}:`, err);
    }
  }

  /**
   * Handle incoming ICE candidate
   */
  private async handleIceCandidate(peerId: string, candidate: any): Promise<void> {
    const selfId = this.normalizePeerId(this.clientId);
    const normalizedPeerId = this.normalizePeerId(peerId);
    if (!normalizedPeerId || normalizedPeerId === selfId) return;

    const peerConnection = this.peers.get(normalizedPeerId);

    if (peerConnection) {
      try {
        peerConnection.peer.signal({ type: 'candidate', candidate: candidate });
      } catch (err) {
        console.error(`Error adding ICE candidate from peer ${peerId}:`, err);
      }
    }
  }

  /**
   * Create a new peer connection
   */
  private createPeerConnection(peerId: string, initiator: boolean): PeerConnection {
    const peer = new SimplePeer({
      initiator,
      trickle: true,
      config: {
        iceServers: this.config.iceServers
      }
    });

    const peerConnection: PeerConnection = {
      id: peerId,
      peer,
      connected: false,
      initiator
    };

    // If a connection stalls (no 'connect' / 'error' / 'close'), tear it down and retry.
    this.armConnectionTimeout(peerId);

    peer.on('signal', (signal: any) => {
      // Send signal through PSP
      const sessionId = this.peerSessionIds.get(peerId) ?? this.generateId('sess');
      this.peerSessionIds.set(peerId, sessionId);
      if (signal.type === 'offer') {
        this.sendPsp('offer', { sdp: signal.sdp, trickle_ice: true }, peerId, sessionId);
      } else if (signal.type === 'answer') {
        this.sendPsp('answer', { sdp: signal.sdp, trickle_ice: true }, peerId, sessionId);
      } else if (signal.candidate) {
        this.sendPsp('ice_candidate', { candidate: signal.candidate }, peerId, sessionId);
      }
      // Debounced re-announce so rapid ICE bursts don't generate one announce per candidate
      this.debouncedAnnounce();
    });

    peer.on('connect', () => {
      peerConnection.connected = true;
      this.clearPeerConnectFailure(peerId);
      this.connecting.delete(peerId);
      const t = this.connectionTimers.get(peerId);
      if (t) {
        clearTimeout(t);
        this.connectionTimers.delete(peerId);
      }
      this.emit('peer:connected', peerId);

      if (this.config.autoConnect) {
        this.maintainPeerConnections();
      }
      
      // Check if we've reached minimum peers
      if (this.getConnectedPeers().length >= this.config.minPeers) {
        this.emit('mesh:ready');
      }
    });

    peer.on('data', (data: any) => {
      this.emit('peer:data', { peerId, data });
    });

    peer.on('close', () => {
      // Only penalise if we never reached 'connected' — a clean disconnect of a
      // healthy peer should not block future reconnects with backoff.
      if (!peerConnection.connected) this.notePeerConnectFailure(peerId);
      this.connecting.delete(peerId);
      const t = this.connectionTimers.get(peerId);
      if (t) {
        clearTimeout(t);
        this.connectionTimers.delete(peerId);
      }
      this.removePeer(peerId);
    });

    peer.on('error', (err: any) => {
      if (!peerConnection.connected) this.notePeerConnectFailure(peerId);
      this.connecting.delete(peerId);
      const t = this.connectionTimers.get(peerId);
      if (t) {
        clearTimeout(t);
        this.connectionTimers.delete(peerId);
      }
      this.emit('peer:error', { peerId, error: err });
      this.removePeer(peerId);
    });

    this.peers.set(peerId, peerConnection);
    return peerConnection;
  }

  /**
   * Compute XOR distance between two hex peer IDs.
   * Returns a hex string that sorts lexicographically by distance (smaller = closer).
   */
  private xorDistance(a: string, b: string): string {
    const len = Math.max(a.length, b.length);
    const hexA = a.padStart(len, '0');
    const hexB = b.padStart(len, '0');
    let result = '';
    for (let i = 0; i < len; i += 2) {
      const byteA = parseInt(hexA.slice(i, i + 2), 16) || 0;
      const byteB = parseInt(hexB.slice(i, i + 2), 16) || 0;
      result += (byteA ^ byteB).toString(16).padStart(2, '0');
    }
    return result;
  }

  /**
   * Maintain the target number of peer connections.
   * Candidates are ranked by XOR distance from self so the mesh naturally
   * organises into a Kademlia-like topology — nearby peers connect first.
   */
  private maintainPeerConnections(): void {
    const signalingOpen = this.isSignalingOpen();

    const selfId = this.normalizePeerId(this.clientId);
    const currentPeerCount = this.getConnectedPeers().length;
    const connectingCount = this.connecting.size;
    const totalInProgress = currentPeerCount + connectingCount;

    if (totalInProgress < this.config.maxPeers) {
      if (!signalingOpen) return;
      // Need more connections — fill up to maxPeers, not just minPeers,
      // so that later-joining peers can always get connections from already-connected ones.
      const needed = this.config.maxPeers - totalInProgress;
      const available = Array.from(this.discoveredPeers).filter(
        peerId => !this.peers.has(peerId) && !this.connecting.has(peerId) && this.canAttemptPeerConnect(peerId)
      );

      if (available.length === 0) return;

      // Sort by XOR distance from self — connect to nearest peers first.
      const sorted = selfId
        ? available.slice().sort((a, b) => {
            const da = this.xorDistance(selfId, a);
            const db = this.xorDistance(selfId, b);
            return da < db ? -1 : da > db ? 1 : 0;
          })
        : available.slice().sort();

      for (let i = 0; i < Math.min(needed, sorted.length); i++) {
        this.connectToPeer(sorted[i]);
      }
    } else if (currentPeerCount > this.config.maxPeers) {
      // Rebalance back to maxPeers (the clean target).
      // maxPeersTolerance absorbs short inbound spikes, but the periodic
      // maintenance pass should still converge back to maxPeers.
      const toDrop = currentPeerCount - this.config.maxPeers;
      const peerIds = selfId
        ? this.getConnectedPeers().slice().sort((a, b) => {
            const da = this.xorDistance(selfId, a);
            const db = this.xorDistance(selfId, b);
            return da > db ? -1 : da < db ? 1 : 0; // descending: farthest first
          })
        : this.getConnectedPeers();

      for (let i = 0; i < toDrop; i++) {
        const peerId = peerIds[i];
        // Prevent immediate reconnect thrash after overflow trimming.
        this.deferPeerReconnect(peerId, 5000);
        this.disconnectFromPeer(peerId);
      }
    }
  }

  /**
   * Connect to a specific peer
   */
  public connectToPeer(peerId: string): void {
    const selfId = this.normalizePeerId(this.clientId);
    const normalizedPeerId = this.normalizePeerId(peerId);
    if (!this.isSignalingOpen() ||
        !normalizedPeerId ||
        this.peers.has(normalizedPeerId) ||
        this.connecting.has(normalizedPeerId) ||
        normalizedPeerId === selfId ||
        !this.canAttemptPeerConnect(normalizedPeerId)) {
      return;
    }

    if (this.getConnectedPeers().length + this.connecting.size >= this.getHardMaxPeers()) {
      console.warn('Hard max peers reached, cannot connect to more peers');
      return;
    }

    // Deterministic initiator selection: smaller ID always initiates.
    const initiator = selfId ? selfId < normalizedPeerId : true;
    if (!initiator) return;

    this.connecting.add(normalizedPeerId);
    this.createPeerConnection(normalizedPeerId, true);
  }

  /**
   * Trigger an immediate best-effort connectivity pass.
   * Useful when application traffic is queued but no peers are currently connected.
   */
  public nudgeConnectivity(reason: string = 'manual'): void {
    if (this.destroyed) return;
    if (!this.isSignalingOpen()) return;
    try {
      this.sendAnnounce();
      this.sendDiscover();
    } catch {
      // ignore
    }
    if (this.config.autoConnect) {
      try {
        this.maintainPeerConnections();
      } catch {
        // ignore
      }
    }
    try {
      console.warn(`[PartialMesh] nudgeConnectivity(${reason}) connected=${this.getConnectedPeers().length} discovered=${this.discoveredPeers.size}`);
    } catch {
      // ignore
    }
  }

  /**
   * Disconnect from a specific peer
   */
  public disconnectFromPeer(peerId: string): void {
    const normalizedPeerId = this.normalizePeerId(peerId);
    if (!normalizedPeerId) return;
    // Use the same teardown path as close/error to ensure timers and reconnection logic stay consistent.
    this.removePeer(normalizedPeerId, false);
  }

  /**
   * Remove a peer connection
   */
  private removePeer(peerId: string, forgetDiscovered: boolean = false): void {
    const peerConnection = this.peers.get(peerId);
    if (peerConnection) {
      const t = this.connectionTimers.get(peerId);
      if (t) {
        clearTimeout(t);
        this.connectionTimers.delete(peerId);
      }
      if (!peerConnection.peer.destroyed) {
        peerConnection.peer.destroy();
      }
      this.peers.delete(peerId);
      this.connecting.delete(peerId);
      // Do NOT forget discovered peers on disconnect/close/error.
      // A peer can still be present in the signaling session and should remain eligible for reconnection.
      if (forgetDiscovered) {
        this.discoveredPeers.delete(peerId);
      }
      this.emit('peer:disconnected', peerId);
      
      // Try to maintain minimum peer count
      if (this.config.autoConnect) {
        this.maintainPeerConnections();
      }
    }
  }

  /**
   * Send data to a specific peer
   */
  public send(peerId: string, data: string | Buffer | ArrayBuffer): void {
    const peerConnection = this.peers.get(peerId);
    if (peerConnection && peerConnection.connected) {
      peerConnection.peer.send(data);
    } else {
      throw new Error(`Peer ${peerId} is not connected`);
    }
  }

  /**
   * Broadcast data to all connected peers
   */
  public broadcast(data: string | Buffer | ArrayBuffer): void {
    this.peers.forEach((peerConnection) => {
      if (peerConnection.connected) {
        peerConnection.peer.send(data);
      }
    });
  }

  /**
   * Get list of connected peer IDs
   */
  public getConnectedPeers(): string[] {
    return Array.from(this.peers.values())
      .filter(pc => pc.connected)
      .map(pc => pc.id);
  }

  /**
   * Get list of discovered peer IDs
   */
  public getDiscoveredPeers(): string[] {
    return Array.from(this.discoveredPeers);
  }

  /**
   * Get current peer count
   */
  public getPeerCount(): number {
    return this.peers.size;
  }

  /**
   * Get this client's ID
   */
  public getClientId(): string | null {
    return this.clientId;
  }

  /**
   * Register an event handler
   */
  public on<K extends keyof PartialMeshEvents>(event: K, handler: PartialMeshEvents[K]): void {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      handlers.add(handler);
    }
  }

  /**
   * Unregister an event handler
   */
  public off<K extends keyof PartialMeshEvents>(event: K, handler: PartialMeshEvents[K]): void {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      handlers.delete(handler);
    }
  }

  /**
   * Emit an event
   */
  private emit<K extends keyof PartialMeshEvents>(event: K, ...args: any[]): void {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      handlers.forEach(handler => {
        try {
          (handler as any)(...args);
        } catch (err) {
          console.error(`Error in event handler for ${event}:`, err);
        }
      });
    }
  }

  /**
   * Disconnect from all peers and close signaling connection
   */
  public destroy(): void {
    this.destroyed = true;
    this.unbindLifecycleListeners();
    this.stopHeartbeat();
    this.clearReconnectTimer();
    this.reconnectAttempts = 0;
    this.hasSignalingConnectedOnce = false;

    if (this.initialConnectTimer) {
      clearTimeout(this.initialConnectTimer);
      this.initialConnectTimer = null;
    }

    if (this.maintenanceTimer) {
      clearInterval(this.maintenanceTimer);
      this.maintenanceTimer = null;
    }

    for (const t of this.connectionTimers.values()) {
      clearTimeout(t);
    }
    this.connectionTimers.clear();

    // Close all peer connections
    this.peers.forEach((peerConnection) => {
      if (!peerConnection.peer.destroyed) {
        peerConnection.peer.destroy();
      }
    });
    this.peers.clear();
    this.connecting.clear();
    this.discoveredPeers.clear();
    this.clientId = null;
    this.instanceId = null;
    this.peerSessionIds.clear();
    this.peerReconnectState.clear();
    this.signalingUrl = null;
    this.underConnectedSinceMs = null;
    this.lastHardResetAtMs = 0;

    // Stop periodic announce
    if (this.announceDebounceTimer) {
      clearTimeout(this.announceDebounceTimer);
      this.announceDebounceTimer = null;
    }
    this.stopAnnounceLoop();

    // Disconnect from signaling server
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
  }
}

export default PartialMesh;

export { GossipProtocol } from './gossip.js';
export type { GossipMessage, GossipProtocolOptions, GossipStats } from './gossip.js';
