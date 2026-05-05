export type GossipProtocolOptions = {
  /** Maximum number of re-propagation hops for a message. */
  maxHops?: number;
  /** Number of recent messages to replay to a peer on reconnect (0 disables replay). */
  replayOnReconnectCount?: number;
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
  send(peerId: string, data: string | Buffer | ArrayBuffer): void;
}

type GossipEvents = {
  messageReceived: (data: { message: GossipMessage; local: boolean; fromPeer?: string }) => void;
  peerConnected: (data: { peerId: string }) => void;
  peerDisconnected: (data: { peerId: string }) => void;
};

/**
 * GossipProtocol
 *
 * A small, application-level gossip/epidemic message propagation helper.
 *
 * - De-duplicates messages by `id`
 * - Re-broadcasts unseen messages to connected peers until `maxHops`
 * - Messages are kept indefinitely (never auto-deleted)
 */
export class GossipProtocol {
  private mesh: MeshLike;
  private messageLog: Map<string, { timestamp: number; sender: string | null; hops: number }> = new Map();
  private messageStore: Map<string, GossipMessage> = new Map();
  private maxHops: number;
  private callbacks: Partial<Record<keyof GossipEvents, Set<Function>>> = {};
  private peers: Map<string, { connected: boolean; timestamp: number }> = new Map();
  private replayCount: number;
  private replayTimers: Map<string, ReturnType<typeof setTimeout>[]> = new Map();
  private opportunisticTimers: Map<string, ReturnType<typeof setTimeout>[]> = new Map();
  private sendRetryTimers: Map<string, ReturnType<typeof setTimeout>[]> = new Map();

  constructor(mesh: MeshLike, options: GossipProtocolOptions = {}) {
    this.mesh = mesh;
    // Default to high hop count to ensure saturation in partial meshes.
    // With maxPeers=10 and partial topology, need ~log2(peers)*2 hops to reach everyone.
    // Set conservatively high (32) to leave internet-style TTL headroom.
    this.maxHops = options.maxHops ?? 32;
    this.replayCount = this.normalizeReplayCount(options.replayOnReconnectCount);
    this.setupMeshListeners();
  }

  private setupMeshListeners(): void {
    this.mesh.on('peer:data', ({ peerId, data }) => {
      const parsed = this.tryParseGossipMessage(data);
      if (!parsed) return;
      this.handleIncomingMessage(parsed, peerId);
    });

    this.mesh.on('peer:connected', (peerId) => {
      this.peers.set(peerId, { connected: true, timestamp: Date.now() });
      this.scheduleReplayBurst(peerId);
      this.emit('peerConnected', { peerId });
    });

    this.mesh.on('peer:disconnected', (peerId) => {
      this.clearReplayTimers(peerId);
      this.peers.delete(peerId);
      this.emit('peerDisconnected', { peerId });
    });
  }

  /**
   * Broadcast an application payload using gossip-style re-propagation.
   */
  broadcast(data: unknown, metadata: Record<string, unknown> = {}): string {
    const sender = this.mesh.getClientId();

    const message: GossipMessage = {
      id: this.generateMessageId(sender),
      timestamp: Date.now(),
      hops: 0,
      maxHops: this.maxHops,
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
    this.messageStore.set(message.id, message);

    const sent = this.propagate(message);
    if (sent === 0) {
      this.scheduleOpportunisticPropagation(message.id);
    }
    this.emit('messageReceived', { message, local: true });

    return message.id;
  }

  /**
   * Propagate a message to all currently-connected peers.
   */
  propagate(message: GossipMessage): number {
    const connectedPeers = this.mesh.getConnectedPeers();
    let sentCount = 0;

    for (const peerId of connectedPeers) {
      if (peerId === message.sender) continue;

      const forwarded: GossipMessage = {
        ...message,
        hops: message.hops + 1
      };

      if (this.sendToPeerWithRetry(peerId, forwarded)) {
        sentCount += 1;
      }
    }

    return sentCount;
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
    this.messageStore.set(message.id, message);

    this.emit('messageReceived', { message, local: false, fromPeer: fromPeerId });

    if (message.hops < message.maxHops) {
      this.propagate(message);
    }
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

  /**
   * [Deprecated] Messages are now kept indefinitely.
   * This method is retained for backwards compatibility but is a no-op.
   */
  cleanup(maxAgeMs: number = 10 * 60_000): void {
    // Messages are kept indefinitely; no cleanup performed.
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
    for (const timers of this.replayTimers.values()) {
      for (const t of timers) clearTimeout(t);
    }
    this.replayTimers.clear();

    for (const timers of this.opportunisticTimers.values()) {
      for (const t of timers) clearTimeout(t);
    }
    this.opportunisticTimers.clear();

    for (const timers of this.sendRetryTimers.values()) {
      for (const t of timers) clearTimeout(t);
    }
    this.sendRetryTimers.clear();

    this.messageLog.clear();
    this.messageStore.clear();
    this.peers.clear();
    this.callbacks = {};
  }

  /**
   * Update replay count at runtime without restarting the mesh.
   */
  setReplayOnReconnectCount(count: number): void {
    this.replayCount = this.normalizeReplayCount(count);
  }

  private scheduleReplayBurst(peerId: string): void {
    if (!peerId || this.replayCount <= 0) return;

    // Send replay immediately and then retry briefly to survive transient
    // post-connect timing races observed in some browser WebRTC stacks.
    const delaysMs = [0, 120, 500];
    const timers: ReturnType<typeof setTimeout>[] = [];

    for (const delayMs of delaysMs) {
      const timer = setTimeout(() => {
        const peerState = this.peers.get(peerId);
        if (!peerState?.connected) return;
        this.replayRecentMessagesToPeer(peerId);
      }, delayMs);
      timers.push(timer);
    }

    this.clearReplayTimers(peerId);
    this.replayTimers.set(peerId, timers);
  }

  private scheduleOpportunisticPropagation(messageId: string): void {
    if (!messageId) return;

    // Bounded short retry window for fresh local messages that were created while
    // temporarily disconnected from peers. This avoids multi-second delays without
    // creating unbounded timer fanout.
    const delaysMs = [120, 300, 650, 1100, 1700];
    const timers: ReturnType<typeof setTimeout>[] = [];

    const clear = () => {
      const existing = this.opportunisticTimers.get(messageId);
      if (!existing) return;
      for (const t of existing) clearTimeout(t);
      this.opportunisticTimers.delete(messageId);
    };

    for (const delayMs of delaysMs) {
      const timer = setTimeout(() => {
        const message = this.messageStore.get(messageId);
        if (!message) {
          clear();
          return;
        }

        const sent = this.propagate(message);
        if (sent > 0) {
          clear();
        }
      }, delayMs);
      timers.push(timer);
    }

    const existing = this.opportunisticTimers.get(messageId);
    if (existing) {
      for (const t of existing) clearTimeout(t);
    }
    this.opportunisticTimers.set(messageId, timers);
  }

  private sendToPeerWithRetry(peerId: string, payload: GossipMessage): boolean {
    const key = `${payload.id}:${peerId}`;
    try {
      this.mesh.send(peerId, JSON.stringify(payload));
      this.clearSendRetryTimers(key);
      return true;
    } catch (err) {
      // A transient close race can fail a send even when peer looked connected.
      // Retry a couple of times quickly to avoid waiting for reconnect replay.
      this.scheduleSendRetry(key, peerId, payload);
      try { console.warn('[GossipProtocol] send failed, retrying:', peerId, err); } catch { /* ignore */ }
      return false;
    }
  }

  private scheduleSendRetry(key: string, peerId: string, payload: GossipMessage): void {
    if (this.sendRetryTimers.has(key)) return;

    const delaysMs = [80, 220];
    const timers: ReturnType<typeof setTimeout>[] = [];

    for (let i = 0; i < delaysMs.length; i++) {
      const timer = setTimeout(() => {
        const stillConnected = this.mesh.getConnectedPeers().includes(peerId);
        if (!stillConnected) {
          this.clearSendRetryTimers(key);
          return;
        }

        try {
          this.mesh.send(peerId, JSON.stringify(payload));
          this.clearSendRetryTimers(key);
        } catch {
          if (i === delaysMs.length - 1) {
            this.clearSendRetryTimers(key);
          }
        }
      }, delaysMs[i]);
      timers.push(timer);
    }

    this.sendRetryTimers.set(key, timers);
  }

  private clearSendRetryTimers(key: string): void {
    const timers = this.sendRetryTimers.get(key);
    if (!timers) return;
    for (const t of timers) clearTimeout(t);
    this.sendRetryTimers.delete(key);
  }

  private clearReplayTimers(peerId: string): void {
    const timers = this.replayTimers.get(peerId);
    if (!timers) return;
    for (const t of timers) clearTimeout(t);
    this.replayTimers.delete(peerId);
  }

  private replayRecentMessagesToPeer(peerId: string): void {
    if (!peerId) return;
    if (this.replayCount <= 0) return;

    const recent = Array.from(this.messageStore.values())
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, this.replayCount)
      .reverse();

    for (const message of recent) {
      const replayMessage: GossipMessage = {
        ...message,
        // Replayed messages must be eligible for propagation in the current topology.
        // Reusing a high historical hop-count can block spread after reconnect.
        hops: 0
      };

      try {
        this.mesh.send(peerId, JSON.stringify(replayMessage));
      } catch (err) {
        try { console.warn('[GossipProtocol] replay to peer failed, skipping:', peerId, err); } catch { /* ignore */ }
        break;
      }
    }
  }

  private normalizeReplayCount(value: number | undefined): number {
    if (!Number.isFinite(value)) return 3;
    return Math.max(0, Math.floor(value as number));
  }

  private emit<K extends keyof GossipEvents>(event: K, data: Parameters<GossipEvents[K]>[0]): void {
    const cbs = this.callbacks[event];
    if (!cbs) return;
    for (const cb of cbs) {
      try {
        (cb as any)(data);
      } catch (err) {
        // Surface errors so they are visible in the browser console.
        // Silent swallowing makes gossip appear broken with no diagnostic.
        try { console.error('[GossipProtocol] event handler error:', err); } catch { /* ignore */ }
      }
    }
  }

  private tryParseGossipMessage(raw: any): GossipMessage | null {
    let text: string;

    if (typeof raw === 'string') {
      text = raw;
    } else if (raw && typeof raw.toString === 'function') {
      text = raw.toString();
    } else if (raw instanceof ArrayBuffer) {
      text = new TextDecoder().decode(new Uint8Array(raw));
    } else if (raw && raw.buffer instanceof ArrayBuffer) {
      text = new TextDecoder().decode(raw);
    } else {
      return null;
    }

    try {
      const parsed = JSON.parse(text);
      if (!parsed || parsed.type !== 'gossip' || typeof parsed.id !== 'string') return null;
      return parsed as GossipMessage;
    } catch {
      return null;
    }
  }

  private generateMessageId(sender: string | null): string {
    const safeSender = (sender ?? 'unknown').toString();
    return `${safeSender}-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  }
}
