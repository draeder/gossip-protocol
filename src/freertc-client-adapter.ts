import { createSignalingClient } from 'freertc/demo/src/utils/signalingClient.js';

type Handler = (...args: any[]) => void;

class Emitter {
  private handlers = new Map<string, Set<Handler>>();

  on(event: string, handler: Handler): void {
    const set = this.handlers.get(event) ?? new Set<Handler>();
    set.add(handler);
    this.handlers.set(event, set);
  }

  emit(event: string, ...args: any[]): void {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const handler of set) {
      try {
        handler(...args);
      } catch {
        // ignore listener errors
      }
    }
  }
}

export class FreeRTCClientAdapter {
  private readonly signalUrl: string;
  private readonly networkId: string;
  private readonly peerId: string;
  private readonly emitter = new Emitter();
  private readonly knownPeers = new Set<string>();
  private client: any = null;
  private joinedOnce = false;
  private connectedEmitted = false;
  private announcePulseTimer: ReturnType<typeof setInterval> | null = null;

  constructor(signalUrl: string, options?: { networkId?: string; peerId?: string }) {
    this.signalUrl = signalUrl;
    this.networkId = options?.networkId ?? 'default-session';
    this.peerId = options?.peerId ?? (globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2));
  }

  on(event: string, handler: Handler): void {
    this.emitter.on(event, handler);
  }

  connect(): void {
    if (this.client) return;
    this.connectedEmitted = false;

    this.client = createSignalingClient({
      peerId: this.peerId,
      networkId: this.networkId,
      signalUrl: this.signalUrl,
      autoConnect: false,
      onRegistered: () => {
        this.emitConnectedOnce();
      },
      onStatusChange: (status: string) => {
        if (status === 'connected') {
          // WebSocket is open; emit early so callers can show client id/status.
          this.emitConnectedOnce();
        }
        if (status === 'registered') {
          this.emitConnectedOnce();
        }
        if (status.startsWith('disconnected')) {
          this.emitter.emit('disconnected');
        }
      },
      onBootstrap: (candidates: Array<{ peerId: string }>) => {
        const nextPeers = new Set(
          candidates
            .map((c) => String(c?.peerId ?? '').trim())
            .filter((id) => id && id !== this.peerId)
        );

        const peerList = Array.from(nextPeers);

        if (!this.joinedOnce) {
          this.joinedOnce = true;
          this.emitter.emit('joined', { sessionId: this.networkId, clients: peerList });
        }

        for (const peerId of peerList) {
          if (!this.knownPeers.has(peerId)) {
            this.emitter.emit('peer-joined', { peerId });
          }
        }

        for (const peerId of this.knownPeers) {
          if (!nextPeers.has(peerId)) {
            this.emitter.emit('peer-left', { peerId });
          }
        }

        this.knownPeers.clear();
        for (const peerId of nextPeers) {
          this.knownPeers.add(peerId);
        }
      },
      onConnectionStateChange: ({ peerId, state }: { peerId: string; state: string }) => {
        if (state === 'connected') {
          // Wait for the data channel to open before signalling up.
          // On slower/contended environments this can take several seconds.
          const maxRetries = 600; // 30s @ 50ms intervals
          const checkChannelOpen = (retries = 0) => {
            const entry = this.client?.mesh?.connections?.get(peerId);
            if (!entry) return; // connection removed — skip
            const entryState = entry.state;
            if (entryState === 'failed' || entryState === 'closed' || entryState === 'dead') return;
            if (entry.channel?.readyState === 'open') {
              this.emitter.emit('rtc:connected', { peerId });
            } else if (retries < maxRetries) {
              setTimeout(() => checkChannelOpen(retries + 1), 50);
            } else {
              // Fallback: connection reached 'connected' but channel open was not observed in time.
              this.emitter.emit('rtc:connected', { peerId });
            }
          };
          setTimeout(() => checkChannelOpen(0), 0);
        } else if (state === 'failed' || state === 'closed') {
          this.emitter.emit('rtc:disconnected', { peerId });
        }
      },
      onDataMessage: ({ peerId, data }: { peerId: string; data: any }) => {
        this.emitter.emit('rtc:data', { peerId, data });
      },
    });

    this.client.connect();
    this.startAnnouncePulse();
  }

  private startAnnouncePulse(): void {
    if (this.announcePulseTimer) return;
    this.announcePulseTimer = setInterval(() => {
      if (!this.client) return;
      try {
        // peer.ooo may queue directed relay messages and release them on announce.
        // Pulse announce/discover so offer/answer delivery does not stall for long intervals.
        this.client.advertise?.();
        this.client.requestBootstrap?.();
      } catch {
        // ignore pulse errors
      }
    }, 2_000);
  }

  private stopAnnouncePulse(): void {
    if (!this.announcePulseTimer) return;
    clearInterval(this.announcePulseTimer);
    this.announcePulseTimer = null;
  }

  private emitConnectedOnce(): void {
    if (this.connectedEmitted) return;
    this.connectedEmitted = true;
    const rawClientId = this.client?.peerId;
    const clientId = String(rawClientId ?? this.peerId ?? '').trim();
    this.emitter.emit('connected', { clientId });
  }

  disconnect(): void {
    this.stopAnnouncePulse();
    if (!this.client) return;
    this.client.disconnect();
    this.client = null;
    this.connectedEmitted = false;
    this.joinedOnce = false;
    this.knownPeers.clear();
  }

  joinSession(sessionId: string): void {
    // FreeRTC client uses networkId set at construction; bootstrap refreshes discovery.
    if (sessionId && sessionId !== this.networkId) {
      this.emitter.emit('error', new Error('FreeRTC adapter does not support changing networkId after initialization'));
      return;
    }
    this.requestBootstrapWhenReady(0);
  }

  private requestBootstrapWhenReady(attempt: number): void {
    if (!this.client) return;
    if (this.client.isRegistered) {
      // Let FreeRTC exclude this peer by default.
      this.client.requestBootstrap();
      return;
    }

    // Registration can lag socket-open by a moment; retry discovery briefly.
    if (attempt < 30) {
      setTimeout(() => this.requestBootstrapWhenReady(attempt + 1), 300);
    }
  }

  async initiateConnection(peerId: string, iceServers?: RTCIceServer[] | null): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    await this.client.initiateConnection(peerId, iceServers ?? null);
  }

  closeConnection(peerId: string): void {
    if (!this.client) return;
    const entry = this.client.mesh?.connections?.get(peerId);
    if (!entry) return;
    try { entry.channel?.close(); } catch { /* ignore */ }
    try { entry.connection?.close(); } catch { /* ignore */ }
  }

  send(peerId: string, data: string | ArrayBuffer | ArrayBufferView): void {
    if (!this.client) throw new Error('Not connected');
    this.client.sendData(data, peerId);
  }

  broadcast(data: string | ArrayBuffer | ArrayBufferView): void {
    if (!this.client) return;
    for (const [, entry] of (this.client.mesh?.connections ?? new Map()).entries()) {
      if (entry.channel?.readyState === 'open') {
        try { entry.channel.send(data); } catch { /* ignore individual send errors */ }
      }
    }
  }
}

export default FreeRTCClientAdapter;
