import SimplePeer from 'simple-peer/simplepeer.min.js';
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
  private uniwrtcClient: any = null;
  private discoveredPeers: Set<string> = new Set();
  private clientId: string | null = null;
  private eventHandlers: Map<keyof PartialMeshEvents, Set<Function>> = new Map();
  private connecting: Set<string> = new Set();
  private connectionTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private maintenanceTimer: ReturnType<typeof setInterval> | null = null;
  private underConnectedSinceMs: number | null = null;
  private lastHardResetAtMs: number = 0;

  constructor(config: PartialMeshConfig = {}) {
    this.config = {
      minPeers: config.minPeers ?? 2,
      maxPeers: config.maxPeers ?? 10,
      signalingServer: config.signalingServer ?? 'wss://signal.peer.ooo',
      sessionId: config.sessionId ?? 'default-session',
      autoDiscover: config.autoDiscover ?? true,
      autoConnect: config.autoConnect ?? true,
      iceServers: config.iceServers ?? [
        { urls: 'stun:stun.l.google.com:19302' }
      ],
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
      'mesh:ready'
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
    // Dynamically import UniWRTC client
    const { default: UniWRTCClient } = await import('uniwrtc/client-browser.js');

    // UniWRTC's Cloudflare deployment (signal.peer.ooo) uses a Worker route that upgrades
    // WebSocket connections on `/ws` and routes by `?room=`.
    // Expected form: `wss://signal.peer.ooo/ws?room=<sessionId>`
    let signalingUrl = this.config.signalingServer;
    if (signalingUrl.includes('signal.peer.ooo')) {
      const url = new URL(signalingUrl);

      // Normalize scheme to ws/wss if user provided http/https.
      if (url.protocol === 'https:') url.protocol = 'wss:';
      if (url.protocol === 'http:') url.protocol = 'ws:';

      // Normalize path to /ws (Cloudflare Worker expects this endpoint).
      const normalizedPath = url.pathname.replace(/\/+$/, '');
      if (normalizedPath === '' || normalizedPath === '/') {
        url.pathname = '/ws';
      } else if (normalizedPath !== '/ws') {
        // If a different path was supplied, prefer /ws for signal.peer.ooo.
        url.pathname = '/ws';
      }

      // Ensure room param exists.
      if (!url.searchParams.get('room')) {
        url.searchParams.set('room', this.config.sessionId);
      }

      signalingUrl = url.toString();
    }

    this.uniwrtcClient = new UniWRTCClient(signalingUrl, {
      autoReconnect: true,
      reconnectDelay: 3000
    });

    // Set up UniWRTC event handlers
    this.uniwrtcClient.on('connected', (data: { clientId: string }) => {
      const rawClientId = data?.clientId;
      this.clientId = this.normalizePeerId(rawClientId);
      this.emit('signaling:connected', { clientId: this.clientId, rawClientId });
      
      if (this.config.autoDiscover) {
        this.uniwrtcClient.joinSession(this.config.sessionId);
      }

      if (this.config.autoConnect) {
        this.startMaintenanceLoop();
      }
    });

    this.uniwrtcClient.on('disconnected', () => {
      this.emit('signaling:disconnected');
    });

    this.uniwrtcClient.on('joined', (data: { sessionId: string; clients: string[] }) => {
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

    this.uniwrtcClient.on('peer-joined', (data: { peerId: string }) => {
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

    this.uniwrtcClient.on('peer-left', (data: { peerId: string }) => {
      const peerId = this.normalizePeerId(data.peerId);
      if (!peerId) return;
      this.discoveredPeers.delete(peerId);
      this.removePeer(peerId, true);
    });

    this.uniwrtcClient.on('offer', async (data: { peerId: string; offer: RTCSessionDescriptionInit }) => {
      await this.handleOffer(data.peerId, data.offer);
    });

    this.uniwrtcClient.on('answer', async (data: { peerId: string; answer: RTCSessionDescriptionInit }) => {
      await this.handleAnswer(data.peerId, data.answer);
    });

    this.uniwrtcClient.on('ice-candidate', async (data: { peerId: string; candidate: RTCIceCandidateInit }) => {
      await this.handleIceCandidate(data.peerId, data.candidate);
    });

    this.uniwrtcClient.on('error', (error: any) => {
      this.emit('signaling:error', error);
    });

    // Connect to the signaling server
    await this.uniwrtcClient.connect();
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

    // Re-announce/join to refresh discovery state in the signaling layer.
    try {
      if (this.uniwrtcClient && this.config.sessionId) {
        this.uniwrtcClient.joinSession(this.config.sessionId);
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
   * Handle incoming WebRTC offer
   */
  private async handleOffer(peerId: string, offer: RTCSessionDescriptionInit): Promise<void> {
    const selfId = this.normalizePeerId(this.clientId);
    const normalizedPeerId = this.normalizePeerId(peerId);
    if (!normalizedPeerId || normalizedPeerId === selfId) return;

    let peerConnection = this.peers.get(normalizedPeerId);

    // If both sides tried to initiate at once, prefer accepting the remote offer.
    // Simple-peer can get stuck if an initiator receives an offer while negotiating.
    if (peerConnection?.initiator) {
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
      // Create peer connection as non-initiator
      peerConnection = this.createPeerConnection(normalizedPeerId, false);
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
    const existingTimer = this.connectionTimers.get(peerId);
    if (existingTimer) clearTimeout(existingTimer);

    const timer = setTimeout(() => {
      const current = this.peers.get(peerId);
      if (!current || current.connected) return;
      if (current.peer.destroyed) return;

      this.connecting.delete(peerId);
      this.emit('peer:error', { peerId, error: new Error('Connection timeout') });
      try {
        current.peer.destroy();
      } catch {
        // ignore
      }
      this.removePeer(peerId);
    }, this.config.connectionTimeoutMs);

    this.connectionTimers.set(peerId, timer);

    peer.on('signal', (signal: any) => {
      // Send signal through UniWRTC
      if (signal.type === 'offer') {
        this.uniwrtcClient.sendOffer(signal, peerId);
      } else if (signal.type === 'answer') {
        this.uniwrtcClient.sendAnswer(signal, peerId);
      } else if (signal.candidate) {
        this.uniwrtcClient.sendIceCandidate(signal.candidate, peerId);
      }
    });

    peer.on('connect', () => {
      peerConnection.connected = true;
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
      this.connecting.delete(peerId);
      const t = this.connectionTimers.get(peerId);
      if (t) {
        clearTimeout(t);
        this.connectionTimers.delete(peerId);
      }
      this.removePeer(peerId);
    });

    peer.on('error', (err: any) => {
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
   * Maintain the target number of peer connections
   */
  private maintainPeerConnections(): void {
    const currentPeerCount = this.peers.size;
    const connectingCount = this.connecting.size;
    const totalInProgress = currentPeerCount + connectingCount;

    if (totalInProgress < this.config.minPeers) {
      // Need more connections
      const needed = this.config.minPeers - totalInProgress;
      const available = Array.from(this.discoveredPeers).filter(
        peerId => !this.peers.has(peerId) && !this.connecting.has(peerId)
      );

      if (available.length === 0) return;

      // Avoid all peers picking the same "first" discovered peer by rotating the list.
      // This reduces thundering-herd behavior and improves overall convergence.
      const selfId = this.normalizePeerId(this.clientId);
      const sorted = available.slice().sort();
      let offset = 0;
      if (selfId) {
        let hash = 0;
        for (let i = 0; i < selfId.length; i++) {
          hash = (hash * 31 + selfId.charCodeAt(i)) >>> 0;
        }
        offset = sorted.length ? hash % sorted.length : 0;
      }

      for (let i = 0; i < Math.min(needed, sorted.length); i++) {
        const peerId = sorted[(offset + i) % sorted.length];
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
    if (!normalizedPeerId ||
        this.peers.has(normalizedPeerId) || 
        this.connecting.has(normalizedPeerId) || 
        normalizedPeerId === selfId) {
      return;
    }

    if (this.peers.size >= this.config.maxPeers) {
      console.warn('Max peers reached, cannot connect to more peers');
      return;
    }

    // Deterministic initiator selection prevents both sides from creating offers.
    // If clientId isn't known yet (should be rare here), default to initiating.
    const initiator = selfId ? selfId < normalizedPeerId : true;

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
    this.underConnectedSinceMs = null;
    this.lastHardResetAtMs = 0;

    // Disconnect from signaling server
    if (this.uniwrtcClient) {
      this.uniwrtcClient.disconnect();
      this.uniwrtcClient = null;
    }
  }
}

export default PartialMesh;

export { GossipProtocol } from './gossip.js';
export type { GossipMessage, GossipProtocolOptions, GossipStats } from './gossip.js';
