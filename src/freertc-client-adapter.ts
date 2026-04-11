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

    this.client = createSignalingClient({
      peerId: this.peerId,
      networkId: this.networkId,
      signalUrl: this.signalUrl,
      autoConnect: false,
      onStatusChange: (status: string) => {
        if (status === 'registered') {
          this.emitter.emit('connected', { clientId: this.peerId });
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
          // Wait for the data channel to be open before signalling up.
          // RTCPeerConnection reaches 'connected' slightly before the DataChannel fires 'open'.
          const checkChannelOpen = (retries = 0) => {
            const entry = this.client?.mesh?.connections?.get(peerId);
            if (!entry) return; // connection removed — skip
            const entryState = entry.state;
            if (entryState === 'failed' || entryState === 'closed' || entryState === 'dead') return;
            if (entry.channel?.readyState === 'open') {
              this.emitter.emit('rtc:connected', { peerId });
            } else if (retries < 40) {
              setTimeout(() => checkChannelOpen(retries + 1), 50);
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
  }

  disconnect(): void {
    if (!this.client) return;
    this.client.disconnect();
    this.client = null;
    this.joinedOnce = false;
    this.knownPeers.clear();
  }

  joinSession(sessionId: string): void {
    // FreeRTC client uses networkId set at construction; bootstrap refreshes discovery.
    if (sessionId && sessionId !== this.networkId) {
      this.emitter.emit('error', new Error('FreeRTC adapter does not support changing networkId after initialization'));
      return;
    }
    this.client?.requestBootstrap([]);
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
