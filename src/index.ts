import FreeRTCClientAdapter from './freertc-client-adapter.js';

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
    * FreeRTC signaling server URL
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
   * ICE servers configuration for STUN/TURN.
   * Set to null to use FreeRTC defaults.
   */
  iceServers?: RTCIceServer[] | null;

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
}

export interface PeerConnection {
  id: string;
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
  'mesh:membership': (peers: string[]) => void;
};

/**
 * PartialMesh - WebRTC peer-to-peer partial mesh networking library
 * 
 * Uses FreeRTC for signaling and maintains a configurable number of peer connections.
 */
export class PartialMesh {
  private config: Required<PartialMeshConfig>;
  private peers: Map<string, PeerConnection> = new Map();
  private signalingClient: any = null;
  private discoveredPeers: Set<string> = new Set();
  private clientId: string | null = null;
  private eventHandlers: Map<keyof PartialMeshEvents, Set<Function>> = new Map();
  private connecting: Set<string> = new Set();
  private connectionTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private maintenanceTimer: ReturnType<typeof setInterval> | null = null;
  private underConnectedSinceMs: number | null = null;
  private lastHardResetAtMs: number = 0;
  private lastDiscoveryRefreshAtMs: number = 0;
  private dialFailureCount: Map<string, number> = new Map();
  private dialBackoffUntilMs: Map<string, number> = new Map();
  /** Converged global peer membership — populated via in-band membership gossip. */
  private globalPeers: Set<string> = new Set();

  constructor(config: PartialMeshConfig = {}) {
    this.config = {
      minPeers: config.minPeers ?? 2,
      maxPeers: config.maxPeers ?? 10,
      signalingServer: config.signalingServer ?? 'wss://peer.ooo/ws',
      sessionId: config.sessionId ?? 'default-session',
      autoDiscover: config.autoDiscover ?? true,
      autoConnect: config.autoConnect ?? true,
      // Prefer FreeRTC's richer built-in ICE profile by default.
      iceServers: config.iceServers ?? null,
      connectionTimeoutMs: config.connectionTimeoutMs ?? 25_000,
      maintenanceIntervalMs: config.maintenanceIntervalMs ?? 2_000,
      underConnectedResetMs: config.underConnectedResetMs ?? 0
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
      'mesh:ready',
      'mesh:membership'
    ];
    events.forEach(event => this.eventHandlers.set(event, new Set()));
  }

  private normalizePeerId(peerId: string | null | undefined): string {
    return (peerId ?? '').trim();
  }

  /**
   * Initialize and connect to the signaling server
   */
  async init(): Promise<void> {
    // Let FreeRTC client manage query params such as networkId.
    const url = new URL(this.config.signalingServer);
    if (url.protocol === 'https:') url.protocol = 'wss:';
    if (url.protocol === 'http:') url.protocol = 'ws:';
    const signalingUrl = url.toString();

    this.signalingClient = new FreeRTCClientAdapter(signalingUrl, {
      networkId: this.config.sessionId,
      peerId: globalThis.crypto?.randomUUID?.() ?? undefined
    });

    // Set up signaling event handlers
    this.signalingClient.on('connected', (data: { clientId: string }) => {
      const rawClientId = data?.clientId;
      this.clientId = this.normalizePeerId(rawClientId);
      this.emit('signaling:connected', { clientId: this.clientId, rawClientId });
      
      if (this.config.autoDiscover) {
        this.signalingClient.joinSession(this.config.sessionId);
      }

      if (this.config.autoConnect) {
        this.startMaintenanceLoop();
      }
    });

    this.signalingClient.on('disconnected', () => {
      this.emit('signaling:disconnected');
    });

    this.signalingClient.on('joined', (data: { sessionId: string; clients: string[] }) => {
      // Add existing peers to discovered list
      const selfId = this.normalizePeerId(this.clientId);
      data.clients.forEach((rawPeerId: string) => {
        const peerId = this.normalizePeerId(rawPeerId);
        if (peerId && peerId !== selfId) {
          this.discoveredPeers.add(peerId);
          this.emit('peer:discovered', peerId);
        }
      });

      if (this.config.autoConnect) {
        this.maintainPeerConnections();
      }
    });

    this.signalingClient.on('peer-joined', (data: { peerId: string }) => {
      const selfId = this.normalizePeerId(this.clientId);
      const peerId = this.normalizePeerId(data.peerId);
      if (peerId && peerId !== selfId) {
        this.discoveredPeers.add(peerId);
        this.emit('peer:discovered', peerId);
        
        if (this.config.autoConnect) {
          this.maintainPeerConnections();
        }
      }
    });

    this.signalingClient.on('peer-left', (data: { peerId: string }) => {
      const peerId = this.normalizePeerId(data.peerId);
      if (!peerId) return;
      this.removeFromGlobalMembership(peerId);
      this.discoveredPeers.delete(peerId);
      this.dialFailureCount.delete(peerId);
      this.dialBackoffUntilMs.delete(peerId);
      this.removePeer(peerId, true);
    });

    this.signalingClient.on('rtc:connected', (data: { peerId: string }) => {
      const peerId = this.normalizePeerId(data.peerId);
      if (!peerId) return;
      let peerConnection = this.peers.get(peerId);
      if (!peerConnection) {
        // Inbound connection — FreeRTC accepted and fully established without us initiating.
        peerConnection = { id: peerId, connected: false, initiator: false };
        this.peers.set(peerId, peerConnection);
      }
      if (peerConnection.connected) return; // guard against duplicate events
      const t = this.connectionTimers.get(peerId);
      if (t) {
        clearTimeout(t);
        this.connectionTimers.delete(peerId);
      }
      peerConnection.connected = true;
      this.connecting.delete(peerId);
      this.noteDialSuccess(peerId);
      this.emit('peer:connected', peerId);

      if (this.config.autoConnect) {
        this.maintainPeerConnections();
      }

      if (this.getConnectedPeers().length >= this.config.minPeers) {
        this.emit('mesh:ready');
      }

      // Announce our current global peer knowledge to the new peer
      this.sendMembership(peerId);
    });

    this.signalingClient.on('rtc:disconnected', (data: { peerId: string }) => {
      const peerId = this.normalizePeerId(data.peerId);
      if (!peerId) return;
      // FreeRTC already closed the connection; clean up tracking state only.
      const peerConnection = this.peers.get(peerId);
      if (peerConnection) {
        const t = this.connectionTimers.get(peerId);
        if (t) {
          clearTimeout(t);
          this.connectionTimers.delete(peerId);
        }
        this.peers.delete(peerId);
        this.connecting.delete(peerId);
        this.emit('peer:disconnected', peerId);
        if (this.config.autoConnect) {
          this.maintainPeerConnections();
        }
      }
    });

    this.signalingClient.on('rtc:data', (data: { peerId: string; data: any }) => {
      const msg = this.tryParseMembership(data.data);
      if (msg) {
        this.mergeMembership(msg.peers, data.peerId);
      } else {
        this.emit('peer:data', data);
      }
    });

    this.signalingClient.on('error', (error: any) => {
      this.emit('signaling:error', error);
    });

    // Connect to the signaling server
    this.signalingClient.connect();
  }

  private startMaintenanceLoop(): void {
    if (this.maintenanceTimer) return;
    if (!this.config.maintenanceIntervalMs || this.config.maintenanceIntervalMs <= 0) return;

    this.maintenanceTimer = setInterval(() => {
      try {
        this.maybeRefreshDiscovery();
        this.maintainPeerConnections();
        this.maybeHardResetUnderConnected();
      } catch {
        // ignore
      }
    }, this.config.maintenanceIntervalMs);
  }

  private maybeRefreshDiscovery(): void {
    if (!this.config.autoDiscover) return;

    const connected = this.getConnectedPeers().length;
    const now = Date.now();
    const underConnected = connected < this.config.minPeers;
    const hasFewCandidates = this.discoveredPeers.size < this.config.minPeers;

    if (!underConnected && !hasFewCandidates) return;
    if (now - this.lastDiscoveryRefreshAtMs < 2_000) return;

    this.lastDiscoveryRefreshAtMs = now;
    try {
      this.signalingClient?.joinSession(this.config.sessionId);
    } catch {
      // ignore
    }
  }

  private maybeHardResetUnderConnected(): void {
    const thresholdMs = this.config.underConnectedResetMs;
    if (!thresholdMs || thresholdMs <= 0) return;

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

  private isPeerBackedOff(peerId: string): boolean {
    const until = this.dialBackoffUntilMs.get(peerId) ?? 0;
    return until > Date.now();
  }

  private noteDialFailure(peerId: string): void {
    const failures = (this.dialFailureCount.get(peerId) ?? 0) + 1;
    this.dialFailureCount.set(peerId, failures);
    const backoffMs = Math.min(30_000, 1_000 * Math.pow(2, Math.min(failures, 5)));
    this.dialBackoffUntilMs.set(peerId, Date.now() + backoffMs);
  }

  private noteDialSuccess(peerId: string): void {
    this.dialFailureCount.delete(peerId);
    this.dialBackoffUntilMs.delete(peerId);
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

    for (const peerId of this.peers.keys()) {
      try {
        this.signalingClient?.closeConnection(peerId);
      } catch {
        // ignore
      }
    }

    this.peers.clear();
    this.connecting.clear();

    // Re-announce/join to refresh discovery state in the signaling layer.
    try {
      if (this.signalingClient && this.config.sessionId) {
        this.signalingClient.joinSession(this.config.sessionId);
      }
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
   * Create a new peer connection
   */
  private createPeerConnection(peerId: string, initiator: boolean): PeerConnection {
    const peerConnection: PeerConnection = {
      id: peerId,
      connected: false,
      initiator
    };

    // If a connection stalls, tear it down and retry.
    const existingTimer = this.connectionTimers.get(peerId);
    if (existingTimer) clearTimeout(existingTimer);

    const timer = setTimeout(() => {
      const current = this.peers.get(peerId);
      if (!current || current.connected) return;

      this.connecting.delete(peerId);
      this.noteDialFailure(peerId);
      this.emit('peer:error', { peerId, error: new Error('Connection timeout') });
      this.removePeer(peerId);
    }, this.config.connectionTimeoutMs);

    this.connectionTimers.set(peerId, timer);
    this.peers.set(peerId, peerConnection);

    if (initiator) {
      // FreeRTC handles the full offer/answer/ICE exchange internally.
      this.signalingClient.initiateConnection(peerId, this.config.iceServers).catch((err: any) => {
        this.connecting.delete(peerId);
        this.noteDialFailure(peerId);
        const t = this.connectionTimers.get(peerId);
        if (t) {
          clearTimeout(t);
          this.connectionTimers.delete(peerId);
        }
        this.emit('peer:error', { peerId, error: err });
        this.removePeer(peerId);
      });
    } else {
      // Discovery can be one-sided for a while: the newly joined peer often sees the
      // existing peer first, while the existing peer is not notified immediately.
      // If no inbound WebRTC state appears after a short grace period, fall back to
      // initiating from this side to avoid waiting indefinitely.
      setTimeout(() => {
        const current = this.peers.get(peerId);
        if (!current || current.connected || !this.connecting.has(peerId)) return;

        const rtcEntry = (this.signalingClient as any)?.client?.mesh?.connections?.get?.(peerId);
        if (rtcEntry) return;

        this.signalingClient.initiateConnection(peerId, this.config.iceServers).catch((err: any) => {
          this.connecting.delete(peerId);
          this.noteDialFailure(peerId);
          const t = this.connectionTimers.get(peerId);
          if (t) {
            clearTimeout(t);
            this.connectionTimers.delete(peerId);
          }
          this.emit('peer:error', { peerId, error: err });
          this.removePeer(peerId);
        });
      }, 7_000);
    }
    // Non-initiator: FreeRTC handles the incoming offer entirely on its own.
    // We'll receive an rtc:connected event when the data channel opens.

    return peerConnection;
  }

  /**
   * Maintain the target number of peer connections
   */
  private maintainPeerConnections(): void {
    const currentPeerCount = this.peers.size;
    const connectingCount = this.connecting.size;
    const totalInProgress = currentPeerCount + connectingCount;
    const allCandidates = Array.from(this.discoveredPeers).filter(
      peerId => !this.peers.has(peerId) && !this.connecting.has(peerId)
    );
    const available = allCandidates.filter(peerId => !this.isPeerBackedOff(peerId));

    const pickCandidates = (count: number): string[] => {
      if ((available.length === 0 && allCandidates.length === 0) || count <= 0) return [];

      // Avoid all peers picking the same "first" discovered peer by rotating the list.
      // This reduces thundering-herd behavior and improves overall convergence.
      const selfId = this.normalizePeerId(this.clientId);
      const source = available.length > 0 ? available : allCandidates;
      const sorted = source.slice().sort((a, b) => {
        const failA = this.dialFailureCount.get(a) ?? 0;
        const failB = this.dialFailureCount.get(b) ?? 0;
        if (failA !== failB) return failA - failB;
        return a.localeCompare(b);
      });
      let offset = 0;
      if (selfId) {
        let hash = 0;
        for (let i = 0; i < selfId.length; i++) {
          hash = (hash * 31 + selfId.charCodeAt(i)) >>> 0;
        }
        offset = sorted.length ? hash % sorted.length : 0;
      }

      const selected: string[] = [];
      for (let i = 0; i < Math.min(count, sorted.length); i++) {
        selected.push(sorted[(offset + i) % sorted.length]);
      }
      return selected;
    };

    if (totalInProgress < this.config.minPeers) {
      // Need more connections
      const needed = this.config.minPeers - totalInProgress;
      for (const peerId of pickCandidates(needed)) {
        this.connectToPeer(peerId);
      }
    } else if (totalInProgress < this.config.maxPeers && available.length > 0) {
      // Once the mesh is minimally healthy, keep adding a small number of bridge links.
      // This helps later-joining peers connect across sub-clusters instead of staying siloed.
      for (const peerId of pickCandidates(1)) {
        this.connectToPeer(peerId);
      }
    } else if (currentPeerCount > this.config.maxPeers) {
      // Too many connections, need to drop some
      const toDrop = currentPeerCount - this.config.maxPeers;
      const peerIds = Array.from(this.peers.keys());
      
      for (let i = 0; i < toDrop; i++) {
        this.disconnectFromPeer(peerIds[i]);
      }
    }
  }

  /**
   * Connect to a specific peer
   */
  public connectToPeer(peerId: string): void {
    const selfId = this.normalizePeerId(this.clientId);
    const normalizedPeerId = this.normalizePeerId(peerId);
    if (!selfId) {
      // Wait until signaling has provided a stable local ID; dialing before this
      // can make both sides choose initiator and deadlock in offer glare.
      return;
    }
    if (!normalizedPeerId ||
        this.peers.has(normalizedPeerId) || 
        this.connecting.has(normalizedPeerId) || 
        normalizedPeerId === selfId) {
      return;
    }

    if (this.isPeerBackedOff(normalizedPeerId)) {
      return;
    }

    if (this.peers.size >= this.config.maxPeers) {
      console.warn('Max peers reached, cannot connect to more peers');
      return;
    }

    // Discovery can be asymmetric (one side sees the other first).
    // Always dialing here prevents deadlock where neither side initiates.
    // Use deterministic role selection to prevent SDP glare.
    // When both peers discover each other simultaneously, only the one with the
    // lexicographically smaller ID sends an offer; the other waits for the inbound offer.
    const initiator = selfId < normalizedPeerId;

    this.connecting.add(normalizedPeerId);
    this.createPeerConnection(normalizedPeerId, initiator);
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
      this.peers.delete(peerId);
      this.connecting.delete(peerId);
      // Close the underlying FreeRTC connection (no-op if already closed).
      try {
        this.signalingClient?.closeConnection(peerId);
      } catch {
        // ignore
      }
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
  public send(peerId: string, data: string | ArrayBuffer | ArrayBufferView): void {
    const peerConnection = this.peers.get(peerId);
    if (peerConnection && peerConnection.connected) {
      this.signalingClient.send(peerId, data);
    } else {
      throw new Error(`Peer ${peerId} is not connected`);
    }
  }

  /**
   * Broadcast data to all connected peers
   */
  public broadcast(data: string | ArrayBuffer | ArrayBufferView): void {
    this.signalingClient?.broadcast(data);
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
   * Get the converged global peer set (all peers known via membership gossip).
   */
  public getGlobalPeers(): string[] {
    return Array.from(this.globalPeers);
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
    // ─── Membership gossip ────────────────────────────────────────────────────

    private sendMembership(toPeerId: string): void {
      const self = this.normalizePeerId(this.clientId);
      const all = new Set<string>(this.globalPeers);
      if (self) all.add(self);
      for (const p of this.discoveredPeers) all.add(p);
      const payload = JSON.stringify({ __membership: true, peers: Array.from(all) });
      try {
        this.signalingClient?.send(toPeerId, payload);
      } catch {
        // best-effort
      }
    }

    private tryParseMembership(raw: any): { peers: string[] } | null {
      try {
        const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (obj?.__membership === true && Array.isArray(obj.peers)) {
          return { peers: obj.peers };
        }
      } catch {
        // not a membership message
      }
      return null;
    }

    private mergeMembership(incoming: string[], fromPeerId: string): void {
      const self = this.normalizePeerId(this.clientId);
      let changed = false;
      for (const raw of incoming) {
        const id = this.normalizePeerId(raw);
        if (!id || id === self) continue;
        if (!this.globalPeers.has(id)) {
          this.globalPeers.add(id);
          changed = true;
          if (!this.discoveredPeers.has(id)) {
            this.discoveredPeers.add(id);
            this.emit('peer:discovered', id);
          }
        }
      }
      if (changed) {
        this.emit('mesh:membership', Array.from(this.globalPeers));
        for (const peerId of this.getConnectedPeers()) {
          if (peerId !== fromPeerId) {
            this.sendMembership(peerId);
          }
        }
        if (this.config.autoConnect) {
          this.maintainPeerConnections();
        }
      }
    }

    private removeFromGlobalMembership(peerId: string): void {
      const removed = this.globalPeers.delete(peerId);
      if (!removed) return;
      this.emit('mesh:membership', Array.from(this.globalPeers));
      for (const connectedPeerId of this.getConnectedPeers()) {
        if (connectedPeerId !== peerId) {
          this.sendMembership(connectedPeerId);
        }
      }
    }

  /**
   * Disconnect from all peers and close signaling connection
   */
  public destroy(): void {
    if (this.maintenanceTimer) {
      clearInterval(this.maintenanceTimer);
      this.maintenanceTimer = null;
    }

    for (const t of this.connectionTimers.values()) {
      clearTimeout(t);
    }
    this.connectionTimers.clear();

    // Close all peer connections
    for (const peerId of this.peers.keys()) {
      try {
        this.signalingClient?.closeConnection(peerId);
      } catch {
        // ignore
      }
    }
    this.peers.clear();
    this.connecting.clear();
    this.discoveredPeers.clear();
    this.clientId = null;
    this.underConnectedSinceMs = null;
    this.lastHardResetAtMs = 0;
    this.lastDiscoveryRefreshAtMs = 0;
    this.dialFailureCount.clear();
    this.dialBackoffUntilMs.clear();

    // Disconnect from signaling server
    if (this.signalingClient) {
      this.signalingClient.disconnect();
      this.signalingClient = null;
    }
  }
}

export default PartialMesh;

export { GossipProtocol } from './gossip.js';
export type { GossipMessage, GossipProtocolOptions, GossipStats } from './gossip.js';
