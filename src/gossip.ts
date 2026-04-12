export type GossipProtocolOptions = {
  /** Maximum number of re-propagation hops for a message. */
  maxHops?: number;
  /** Maximum hops for a direct/routed message before it is dropped. Default 20. */
  maxDirectHops?: number;
};

export type GossipMessage = {
  id: string;
  timestamp: number;
  hops: number;
  maxHops: number;
  sender: string | null;
  data: unknown;
  metadata: Record<string, unknown>;
  type: 'gossip';
};

export type DirectMessage = {
  id: string;
  type: 'direct';
  from: string;
  to: string;
  data: unknown;
  hops: number;
  maxHops: number;
  timestamp: number;
};

export type GossipStats = {
  totalMessagesTracked: number;
  recentMessages: Array<{
    id: string;
    timestamp: number;
    sender: string | null;
    hops: number;
    age: number;
  }>;
  connectedPeers: number;
  discoveredPeers: number;
};

interface MeshLike {
  on(event: 'peer:data', handler: (data: { peerId: string; data: any }) => void): void;
  on(event: 'peer:connected' | 'peer:disconnected', handler: (peerId: string) => void): void;
  getClientId(): string | null;
  getConnectedPeers(): string[];
  getDiscoveredPeers(): string[];
  getGlobalPeers(): string[];
  send(peerId: string, data: string | ArrayBuffer | ArrayBufferView): void;
}

type GossipEvents = {
  messageReceived: (data: { message: GossipMessage; local: boolean; fromPeer?: string }) => void;
  peerConnected: (data: { peerId: string }) => void;
  peerDisconnected: (data: { peerId: string }) => void;
  directMessageReceived: (data: { message: DirectMessage }) => void;
};

/**
 * GossipProtocol
 *
 * A small, application-level gossip/epidemic message propagation helper.
 *
 * - De-duplicates messages by `id`
 * - Re-broadcasts unseen messages to connected peers until `maxHops`
 */
export class GossipProtocol {
  private mesh: MeshLike;
  private messageLog: Map<string, { timestamp: number; sender: string | null; hops: number }> = new Map();
  private maxHops: number;
  private maxDirectHops: number;
  private seenDirectIds: Set<string> = new Set();
  private callbacks: Partial<Record<keyof GossipEvents, Set<Function>>> = {};
  private peers: Map<string, { connected: boolean; timestamp: number }> = new Map();

  constructor(mesh: MeshLike, options: GossipProtocolOptions = {}) {
    this.mesh = mesh;
    this.maxHops = options.maxHops ?? 5;
    this.maxDirectHops = options.maxDirectHops ?? 20;
    this.setupMeshListeners();
  }

  private setupMeshListeners(): void {
    this.mesh.on('peer:data', ({ peerId, data }) => {
      const parsed = this.tryParseGossipMessage(data);
      if (!parsed) return;
      if (parsed.type === 'direct') {
        this.handleIncomingDirect(parsed as unknown as DirectMessage, peerId);
      } else {
        this.handleIncomingMessage(parsed, peerId);
      }
    });

    this.mesh.on('peer:connected', (peerId) => {
      this.peers.set(peerId, { connected: true, timestamp: Date.now() });
      this.emit('peerConnected', { peerId });
    });

    this.mesh.on('peer:disconnected', (peerId) => {
      this.peers.delete(peerId);
      this.emit('peerDisconnected', { peerId });
    });
  }

  /**
   * Broadcast an application payload using gossip-style re-propagation.
   */
  broadcast(data: unknown, metadata: Record<string, unknown> = {}): string {
    const sender = this.mesh.getClientId();
    const connected = this.mesh.getConnectedPeers();
    const global = this.mesh.getGlobalPeers?.() ?? connected;
    const networkSize = Math.max(connected.length, global.length, 1);
    const fanOut = Math.max(2, Math.ceil(Math.log2(networkSize + 1)));

    const message: GossipMessage = {
      id: this.generateMessageId(sender),
      timestamp: Date.now(),
      hops: 0,
      maxHops: Math.max(this.maxHops, Math.ceil(Math.log2(networkSize + 1)) * 2),
      sender,
      data,
      metadata,
      type: 'gossip'
    };

    this.messageLog.set(message.id, {
      timestamp: message.timestamp,
      sender: message.sender,
      hops: 0
    });

    this.propagate(message, fanOut);
    this.emit('messageReceived', { message, local: true });

    return message.id;
  }

  /**
   * Propagate a message to all currently-connected peers.
   */
  propagate(message: GossipMessage, fanOut?: number): void {
    let connectedPeers = this.mesh.getConnectedPeers();

    if (fanOut !== undefined && fanOut < connectedPeers.length) {
      // Random subset of size fanOut — shuffle then slice
      const shuffled = connectedPeers.slice();
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      connectedPeers = shuffled.slice(0, fanOut);
    }

    for (const peerId of connectedPeers) {
      if (peerId === message.sender) continue;

      const forwarded: GossipMessage = {
        ...message,
        hops: message.hops + 1
      };

      try {
        this.mesh.send(peerId, JSON.stringify(forwarded));
      } catch {
        // best-effort
      }
    }
  }

  /**
   * Handle an incoming message from the mesh.
   */
  handleIncomingMessage(message: GossipMessage, fromPeerId: string): void {
    const alreadySeen = this.messageLog.has(message.id);
    if (alreadySeen) return;

    this.messageLog.set(message.id, {
      timestamp: Date.now(),
      sender: message.sender,
      hops: message.hops
    });

    this.emit('messageReceived', { message, local: false, fromPeer: fromPeerId });

    if (message.hops < message.maxHops) {
      const connected = this.mesh.getConnectedPeers();
      const global = this.mesh.getGlobalPeers?.() ?? connected;
      const networkSize = Math.max(connected.length, global.length, 1);
      const fanOut = Math.max(2, Math.ceil(Math.log2(networkSize + 1)));
      this.propagate(message, fanOut);
    }
  }

  // ─── Direct / XOR-routed messaging ───────────────────────────────────────

  /**
   * XOR distance between two hex-encoded peer IDs.
   * Returns a BigInt (lower = closer).
   */
  private xorDistance(a: string, b: string): bigint {
    // Strip hyphens (UUID format) and compare hex segments
    const ha = a.replace(/-/g, '').toLowerCase().slice(0, 16).padEnd(16, '0');
    const hb = b.replace(/-/g, '').toLowerCase().slice(0, 16).padEnd(16, '0');
    return BigInt('0x' + ha) ^ BigInt('0x' + hb);
  }

  /**
   * Pick the connected peer closest (by XOR distance) to target.
   * Falls back to any connected peer if IDs can't be compared.
   */
  private closestPeerTo(target: string, exclude?: string): string | null {
    const connected = this.mesh.getConnectedPeers().filter(p => p !== exclude);
    if (connected.length === 0) return null;
    let best: string | null = null;
    let bestDist = BigInt('0xFFFFFFFFFFFFFFFF');
    for (const p of connected) {
      try {
        const d = this.xorDistance(p, target);
        if (d < bestDist) { bestDist = d; best = p; }
      } catch {
        if (!best) best = p;
      }
    }
    return best;
  }

  /**
   * Send a direct message to a specific peer, routed through the mesh via XOR distance.
   * Delivers even if there is no direct connection to the target.
   */
  sendDirect(targetPeerId: string, data: unknown): string | null {
    const from = this.mesh.getClientId();
    if (!from) return null;

    const message: DirectMessage = {
      id: this.generateMessageId(from),
      type: 'direct',
      from,
      to: targetPeerId,
      data,
      hops: 0,
      maxHops: this.maxDirectHops,
      timestamp: Date.now(),
    };

    this.seenDirectIds.add(message.id);
    this.routeDirect(message, null);
    return message.id;
  }

  private routeDirect(message: DirectMessage, fromPeerId: string | null): void {
    const self = this.mesh.getClientId();

    // We are the destination
    if (message.to === self) {
      this.emit('directMessageReceived', { message });
      return;
    }

    // Is target directly connected? Short-circuit.
    const connected = this.mesh.getConnectedPeers();
    if (connected.includes(message.to)) {
      try {
        this.mesh.send(message.to, JSON.stringify({ ...message, hops: message.hops + 1 }));
      } catch { /* best-effort */ }
      return;
    }

    if (message.hops >= message.maxHops) return;

    // XOR-route to closest connected peer (excluding the peer we got it from)
    const next = this.closestPeerTo(message.to, fromPeerId ?? undefined);
    if (!next) return;

    try {
      this.mesh.send(next, JSON.stringify({ ...message, hops: message.hops + 1 }));
    } catch { /* best-effort */ }
  }

  private handleIncomingDirect(message: DirectMessage, fromPeerId: string): void {
    if (this.seenDirectIds.has(message.id)) return;
    this.seenDirectIds.add(message.id);
    this.routeDirect(message, fromPeerId);
  }

  getStats(): GossipStats {
    const now = Date.now();
    const messages = Array.from(this.messageLog.entries()).map(([id, info]) => ({
      id,
      timestamp: info.timestamp,
      sender: info.sender,
      hops: info.hops,
      age: now - info.timestamp
    }));

    return {
      totalMessagesTracked: this.messageLog.size,
      recentMessages: messages.filter((m) => m.age < 60_000),
      connectedPeers: this.mesh.getConnectedPeers().length,
      discoveredPeers: this.mesh.getDiscoveredPeers().length
    };
  }

  cleanup(maxAgeMs: number = 10 * 60_000): void {
    const now = Date.now();
    for (const [id, info] of this.messageLog.entries()) {
      if (now - info.timestamp > maxAgeMs) {
        this.messageLog.delete(id);
      }
    }
  }

  on<K extends keyof GossipEvents>(event: K, callback: GossipEvents[K]): void {
    const existing = this.callbacks[event];
    if (existing) {
      existing.add(callback);
      return;
    }
    this.callbacks[event] = new Set([callback]);
  }

  off<K extends keyof GossipEvents>(event: K, callback: GossipEvents[K]): void {
    const existing = this.callbacks[event];
    if (!existing) return;
    existing.delete(callback);
  }

  destroy(): void {
    this.messageLog.clear();
    this.peers.clear();
    this.seenDirectIds.clear();
    this.callbacks = {};
  }

  private emit<K extends keyof GossipEvents>(event: K, data: Parameters<GossipEvents[K]>[0]): void {
    const cbs = this.callbacks[event];
    if (!cbs) return;
    for (const cb of cbs) {
      try {
        (cb as any)(data);
      } catch {
        // ignore
      }
    }
  }

  private tryParseGossipMessage(raw: any): GossipMessage | DirectMessage | null {
    const toEnvelope = (value: any): any | null => {
      if (!value) return null;
      if (typeof value === 'object' && typeof value.id === 'string' && typeof value.type === 'string') {
        return value;
      }

      let text: string;
      if (typeof value === 'string') {
        text = value;
      } else if (value instanceof ArrayBuffer) {
        text = new TextDecoder().decode(new Uint8Array(value));
      } else if (ArrayBuffer.isView(value)) {
        text = new TextDecoder().decode(value as Uint8Array);
      } else if (typeof value?.toString === 'function') {
        text = value.toString();
      } else {
        return null;
      }

      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    };

    const parsed = toEnvelope(raw);
    if (!parsed || typeof parsed !== 'object' || typeof parsed.id !== 'string') return null;

    if (parsed.type === 'gossip') {
      return parsed as GossipMessage;
    }

    if (parsed.type === 'direct' && typeof parsed.from === 'string' && typeof parsed.to === 'string') {
      return parsed as DirectMessage;
    }

    return null;
  }

  private generateMessageId(sender: string | null): string {
    const safeSender = (sender ?? 'unknown').toString();
    return `${safeSender}-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  }
}
