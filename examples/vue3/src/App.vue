<template>
  <div id="app">
    <header>
      <h1>🚀 Gossip Protocol Demo</h1>
      <p>Distributed message propagation using WebRTC & PartialMesh</p>
    </header>

    <main>
      <!-- Control Panel -->
      <section class="control-panel">
        <div class="config-grid">
          <label class="field">
            <span class="field-label">Server</span>
            <input
              v-model.trim="signalingServer"
              :disabled="isRunning || isConnecting"
              class="input"
              data-testid="signaling-server"
              placeholder="wss://peer.ooo/ws"
            />
          </label>

          <label class="field">
            <span class="field-label">Network Name</span>
            <input
              v-model.trim="networkName"
              :disabled="isRunning || isConnecting"
              class="input"
              data-testid="network-name"
              placeholder="gossip"
            />
          </label>

          <label class="field">
            <span class="field-label">Room / Session ID</span>
            <input
              v-model.trim="roomSessionId"
              :disabled="isRunning || isConnecting"
              class="input"
              data-testid="room-session-id"
              placeholder="my-room"
            />
          </label>

          <label class="field field-number">
            <span class="field-label">Min Peers</span>
            <input
              v-model.number="minPeers"
              @input="onPeerBoundsInput"
              type="number"
              min="1"
              max="50"
              :disabled="isRunning || isConnecting"
              class="input"
              data-testid="min-peers"
            />
          </label>

          <label class="field field-number">
            <span class="field-label">Max Peers</span>
            <input
              v-model.number="maxPeers"
              @input="onPeerBoundsInput"
              type="number"
              min="1"
              max="50"
              :disabled="isRunning || isConnecting"
              class="input"
              data-testid="max-peers"
            />
          </label>

          <label class="field field-topology">
            <span class="field-label">Topology</span>
            <select
              v-model="topology"
              @change="onTopologyChange"
              :disabled="isConnecting"
              class="input"
              data-testid="topology"
            >
              <option value="token-ring">Token Ring (target 2, tolerant 1)</option>
              <option value="star">Star (1-20)</option>
              <option value="partial-mesh">Partial Mesh (2-5)</option>
              <option value="dense-mesh">Dense Mesh (3-10)</option>
              <option value="custom">Custom</option>
            </select>
          </label>
        </div>

        <p class="effective-session">
          Effective Session: <span class="mono">{{ effectiveSessionId }}</span>
        </p>

        <div class="button-group">
          <button 
            @click="startMesh" 
            :disabled="isRunning || isConnecting"
            class="btn btn-primary"
            data-testid="start-mesh"
          >
            {{ isConnecting ? 'Connecting...' : 'Start Mesh' }}
          </button>
          <button 
            @click="stopMesh" 
            :disabled="!isRunning"
            class="btn btn-danger"
            data-testid="stop-mesh"
          >
            Stop Mesh
          </button>
        </div>

        <div class="status-field" :class="`status-${status.type}`" data-testid="status-message">
          {{ status.message || 'Idle' }}
        </div>
      </section>

      <!-- Stats Display -->
      <section v-if="isRunning" class="stats">
        <div class="stat-box">
          <span class="label">Client ID:</span>
          <span class="value mono" data-testid="client-id">{{ clientId }}</span>
        </div>
        <div class="stat-box">
          <span class="label">Connected Peers:</span>
          <span class="value" data-testid="connected-peers">{{ connectedPeers }} / {{ maxPeers }}</span>
        </div>
        <div class="stat-box">
          <span class="label">Discovered Peers:</span>
          <span class="value" data-testid="discovered-peers">{{ discoveredPeers }}</span>
        </div>
        <div class="stat-box">
          <span class="label">Messages Seen:</span>
          <span class="value" data-testid="messages-seen">{{ messagesSeen }}</span>
        </div>
      </section>

      <!-- Peer Network Visualization -->
      <section v-if="isRunning" class="network-viz">
        <h3>📊 Network Graph</h3>
        <div class="peers-container">
          <div class="peer self">
            <div class="peer-id">{{ clientId.slice(0, 6) }}</div>
            <div class="peer-label">You</div>
          </div>
          <div v-for="peerId in connectedPeersList" :key="peerId" class="peer connected">
            <div class="peer-id">{{ peerId.slice(0, 6) }}</div>
            <div class="peer-label">Peer</div>
          </div>
        </div>
      </section>

      <!-- Chat -->
      <section class="chat" v-if="isRunning">
        <h3>💬 Chat</h3>
        <div class="log-controls">
          <button @click="clearLog" class="btn btn-small">Clear</button>
          <label>
            <input v-model="autoScroll" type="checkbox" />
            Auto-scroll
          </label>
        </div>
        <div ref="logContainer" class="log-container chat-container">
          <div 
            v-for="(entry, idx) in chatMessages" 
            :key="idx"
            :class="['log-entry', entry.type, { local: entry.local }]"
          >
            <div class="bubble" :class="entry.local ? 'me' : 'peer'">
              <div class="bubble-meta">
                <span class="sender">{{ entry.local ? 'You' : entry.sender.slice(0, 6) }}</span>
                <span class="timestamp">{{ formatTime(entry.timestamp) }}</span>
              </div>
              <div class="bubble-text">{{ entry.text }}</div>
              <div v-if="entry.hops > 0" class="bubble-hops">{{ entry.hops === 1 ? '1 hop' : entry.hops + ' hops' }}</div>
            </div>
          </div>
        </div>

        <div class="message-input">
          <input 
            v-model="messageInput" 
            @keyup.enter="sendMessage"
            :disabled="!isRunning"
            placeholder="Type a message..."
            class="input"
          />
          <button 
            @click="sendMessage" 
            :disabled="!isRunning || !messageInput.trim()"
            class="btn btn-secondary"
          >
            Send
          </button>
        </div>
      </section>

      <!-- Diagnostics -->
      <section class="chat diagnostics" v-if="isRunning">
        <h3>🛠 Diagnostics</h3>
        <div ref="diagLogContainer" class="log-container diag-container" data-testid="diag-log">
          <div
            v-for="(entry, idx) in diagnosticMessages"
            :key="`diag-${idx}`"
            class="diag-entry"
          >
            <span class="diag-time">{{ formatTime(entry.timestamp) }}</span>
            <span class="diag-sender">{{ entry.sender }}</span>
            <span class="diag-text">{{ entry.text }}</span>
          </div>
          <div v-if="diagnosticMessages.length === 0" class="diag-empty">No diagnostics yet</div>
        </div>
      </section>

      <!-- Direct Messages -->
      <section class="chat dm-section" v-if="isRunning">
        <h3>📩 Direct Message</h3>
        <div class="dm-input-row">
          <select v-model="dmTarget" class="input dm-select" data-testid="dm-target">
            <option value="" disabled>{{ globalPeersList.length ? 'Select peer…' : 'Waiting for peers…' }}</option>
            <option v-for="p in globalPeersList" :key="p" :value="p">{{ p.slice(0,8) }}…</option>
          </select>
          <input
            v-model="dmInput"
            @keyup.enter="sendDm"
            :disabled="!dmTarget"
            placeholder="Private message…"
            class="input dm-text"
            data-testid="dm-input"
          />
          <button
            @click="sendDm"
            :disabled="!dmTarget || !dmInput.trim()"
            class="btn btn-dm"
            data-testid="dm-send"
          >
            Send DM
          </button>
        </div>
        <div ref="dmLogContainer" class="log-container chat-container dm-log">
          <div v-for="(entry, idx) in dmMessages" :key="idx" class="log-entry">
            <div class="bubble" :class="entry.local ? 'dm-me' : 'dm-peer'">
              <div class="bubble-meta">
                <span class="sender">{{ entry.local ? `You → ${entry.to.slice(0,6)}` : `${entry.from.slice(0,6)} → You` }}</span>
                <span class="timestamp">{{ formatTime(entry.timestamp) }}</span>
              </div>
              <div class="bubble-text">{{ entry.text }}</div>
            </div>
          </div>
        </div>
      </section>
    </main>
  </div>
</template>

<script>
import { PartialMesh } from 'gossip-protocol';
import { GossipProtocol } from 'gossip-protocol';

export default {
  name: 'GossipDemo',
  data() {
    return {
      mesh: null,
      gossip: null,
      isRunning: false,
      isConnecting: false,
      messageInput: '',
      dmInput: '',
      dmTarget: '',
      clientId: '',
      connectedPeersList: [],
      discoveredPeersList: [],
      globalPeersList: [],
      dmLog: [],
      messagesSeen: 0,
      maxPeers: 5,
      minPeers: 2,
      topology: 'token-ring',
      networkName: 'gossip',
      roomSessionId: '',
      signalingServer: 'wss://peer.ooo/ws',
      messageLog: [],
      autoScroll: true,
      status: {
        title: '',
        message: '',
        type: 'info'
      },
      uiStateKey: 'gossip-protocol:ui-state',
      debugMonitorTimer: null,
      debugLastByPeer: {}
    };
  },
  mounted() {
    window.__app = this;
    const params = new URLSearchParams(window.location.search);

    // ==== IMPORTANT: URL params take ABSOLUTE priority for test isolation ====
    // Check for explicit sessionId param FIRST (before any localStorage fallback)
    const sessionIdParam = params.get('sessionId') || params.get('roomSessionId') || params.get('room');
    const hasExplicitSessionId = sessionIdParam != null;

    // Parse all other URL params
    const topologyParam = (params.get('topology') || '').trim().toLowerCase();
    if (this.isKnownTopology(topologyParam)) {
      this.topology = topologyParam;
    }

    const hasMaxPeersParam = params.get('maxPeers') != null;
    const hasMinPeersParam = params.get('minPeers') != null;

    if (!hasMaxPeersParam && !hasMinPeersParam) {
      this.applyTopologyPreset(this.topology);
    }

    // Only use localStorage sessionId if NO explicit URL param was provided
    // This ensures test URLs (with __test_* sessionIds) are never overridden
    if (hasExplicitSessionId) {
      this.roomSessionId = sessionIdParam;
    } else {
      const storageKey = 'gossip-protocol:room-session-id';
      const ensureLocalRoomSessionId = () => {
        try {
          const existing = localStorage.getItem(storageKey);
          if (existing && existing.trim()) return existing.trim();
          const generated = `gp-${Math.random().toString(36).slice(2, 10)}`;
          localStorage.setItem(storageKey, generated);
          return generated;
        } catch {
          return `gp-${Math.random().toString(36).slice(2, 10)}`;
        }
      };
      this.roomSessionId = ensureLocalRoomSessionId();
    }

    const maxPeersParam = Number(params.get('maxPeers'));
    if (Number.isFinite(maxPeersParam) && maxPeersParam >= 1) {
      this.maxPeers = Math.min(50, Math.floor(maxPeersParam));
    }

    const minPeersParam = Number(params.get('minPeers'));
    if (Number.isFinite(minPeersParam) && minPeersParam >= 1) {
      this.minPeers = Math.min(50, Math.floor(minPeersParam));
    }

    if (this.minPeers > this.maxPeers) {
      this.minPeers = this.maxPeers;
    }

    this.reconcileTopologyWithPeerBounds();

    const networkNameParam = params.get('networkName') || params.get('network');
    if (networkNameParam) {
      this.networkName = networkNameParam;
    }

    const signalingServerParam = params.get('signalingServer') || params.get('signalUrl');
    if (signalingServerParam) {
      this.signalingServer = signalingServerParam;
    }

    const autostart = (params.get('autostart') || '1').toLowerCase();
    if (autostart === '1' || autostart === 'true' || autostart === 'yes') {
      this.startMesh();
    }

    this.loadUiState();
  },
  computed: {
    effectiveSessionId() {
      const network = String(this.networkName || '').trim();
      const room = String(this.roomSessionId || '').trim();

      if (network && room) return `${network}:${room}`;
      return network || room || 'default';
    },
    connectedPeers() {
      return this.connectedPeersList.length;
    },
    discoveredPeers() {
      return this.discoveredPeersList.length;
    },
    chatMessages() {
      return this.messageLog.filter(e => e.type === 'sent' || e.type === 'received');
    },
    diagnosticMessages() {
      return this.messageLog.filter(e => e.type !== 'sent' && e.type !== 'received');
    },
    dmMessages() {
      return this.dmLog;
    }
  },
  watch: {
    messageLog() {
      const last = this.messageLog[this.messageLog.length - 1];
      if (!last) return;
      if ((last.type === 'sent' || last.type === 'received') && this.autoScroll) {
        this.$nextTick(() => this.scrollToBottom());
      }
      if ((last.type !== 'sent' && last.type !== 'received') && this.autoScroll) {
        this.$nextTick(() => this.scrollDiagToBottom());
      }
    }
  },
  methods: {
    topologyPresetBounds(topology) {
      switch (topology) {
        case 'token-ring':
          // Keep ring behavior as the default target while allowing 2-node sessions.
          return { minPeers: 1, maxPeers: 2 };
        case 'star':
          return { minPeers: 1, maxPeers: 20 };
        case 'partial-mesh':
          return { minPeers: 2, maxPeers: 5 };
        case 'dense-mesh':
          return { minPeers: 3, maxPeers: 10 };
        default:
          return null;
      }
    },

    isKnownTopology(topology) {
      return ['token-ring', 'star', 'partial-mesh', 'dense-mesh', 'custom'].includes(topology);
    },

    normalizePeerBounds(minPeers, maxPeers) {
      const normalizedMin = Math.max(1, Math.min(50, Number(minPeers) || 1));
      const normalizedMax = Math.max(1, Math.min(50, Number(maxPeers) || 1));
      return {
        minPeers: Math.min(normalizedMin, normalizedMax),
        maxPeers: Math.max(normalizedMin, normalizedMax)
      };
    },

    applyTopologyPreset(topology) {
      const bounds = this.topologyPresetBounds(topology);
      if (!bounds) return;
      const normalized = this.normalizePeerBounds(bounds.minPeers, bounds.maxPeers);
      this.minPeers = normalized.minPeers;
      this.maxPeers = normalized.maxPeers;
    },

    reconcileTopologyWithPeerBounds() {
      const normalized = this.normalizePeerBounds(this.minPeers, this.maxPeers);
      this.minPeers = normalized.minPeers;
      this.maxPeers = normalized.maxPeers;

      const presets = ['token-ring', 'star', 'partial-mesh', 'dense-mesh'];
      for (const name of presets) {
        const bounds = this.topologyPresetBounds(name);
        if (!bounds) continue;
        if (bounds.minPeers === this.minPeers && bounds.maxPeers === this.maxPeers) {
          this.topology = name;
          return;
        }
      }

      this.topology = 'custom';
    },

    onTopologyChange() {
      const shouldRestart = this.isRunning && !this.isConnecting;
      if (this.topology !== 'custom') {
        this.applyTopologyPreset(this.topology);
      }
      if (shouldRestart) {
        this.restartMeshForTopologyChange();
      }
    },

    async restartMeshForTopologyChange() {
      if (this.isConnecting) return;
      this.showStatus('Reconfiguring...', 'Applying topology and restarting mesh...', 'connecting');
      this.stopMesh();
      await this.startMesh();
    },

    onPeerBoundsInput() {
      this.reconcileTopologyWithPeerBounds();
    },

    async startMesh() {
      try {
        const normalized = this.normalizePeerBounds(this.minPeers, this.maxPeers);
        this.minPeers = normalized.minPeers;
        this.maxPeers = normalized.maxPeers;
        this.reconcileTopologyWithPeerBounds();
        this.networkName = String(this.networkName || '').trim();
        this.roomSessionId = String(this.roomSessionId || '').trim();
        this.signalingServer = String(this.signalingServer || '').trim() || 'wss://peer.ooo/ws';
        this.updateUrlState();

        try {
          localStorage.setItem('gossip-protocol:room-session-id', this.roomSessionId || `gp-${Math.random().toString(36).slice(2, 10)}`);
          if (!this.roomSessionId) {
            this.roomSessionId = localStorage.getItem('gossip-protocol:room-session-id') || '';
          }
        } catch {
          // ignore storage errors
        }

        this.updateUrlState();

        this.isConnecting = true;
        this.showStatus('Connecting...', 'Initializing PartialMesh with Gossip Protocol...', 'connecting');

        this.mesh = new PartialMesh({
          signalingServer: this.signalingServer,
          sessionId: this.effectiveSessionId,
          minPeers: this.minPeers,
          maxPeers: this.maxPeers,
          autoDiscover: true,
          autoConnect: true,
          // Helps highest-lexicographic peers (often Chrome in mixed-browser sessions)
          // avoid indefinite non-initiator wait when all discovered peers are smaller IDs.
          nonInitiatorFallbackDialMs: 8_000,
          underConnectedResetMs: 20_000
        });

        this.gossip = new GossipProtocol(this.mesh);
        // Runtime inspection hook for debugging in dev tools / automation.
        window.__mesh = this.mesh;
        window.__gossip = this.gossip;

        // Mesh events
        this.mesh.on('signaling:connected', (data) => {
          this.clientId = (data.clientId || '').trim();
          this.addLog('signaling', `Connected to signaling server`, this.clientId);
          this.updateStats();
        });

        this.mesh.on('peer:discovered', (peerId) => {
          this.addLog('discovered', `Discovered peer`, peerId);
          this.updateStats();
        });

        this.mesh.on('signaling:connected', () => {
          this.addLog(
            'info',
            `Discovery snapshot: discovered=${this.mesh.getDiscoveredPeers().length}, connected=${this.mesh.getConnectedPeers().length}`,
            'debug'
          );
        });

        this.mesh.on('peer:connected', (peerId) => {
          this.addLog('connected', `Connected to peer`, peerId);
          this.updateStats();
        });

        this.mesh.on('peer:disconnected', (peerId) => {
          this.addLog('disconnected', `Disconnected from peer`, peerId);
          this.updateStats();
        });

        this.mesh.on('peer:error', ({ peerId, error }) => {
          const message = String(error?.message || error || 'unknown error');
          this.addLog('info', `Peer error: ${message}`, peerId || 'peer');
          this.updateStats();
        });

        this.mesh.on('peer:discovered', (peerId) => {
          const self = String(this.mesh?.getClientId?.() || '').trim();
          const initiator = self && peerId ? self < peerId : false;
          this.addLog('info', `Dial role -> ${initiator ? 'initiator' : 'non-initiator(wait)'}`, peerId || 'debug');
        });

        this.mesh.on('mesh:membership', () => {
          this.updateStats();
        });

        this.mesh.on('mesh:ready', () => {
          this.addLog('info', 'Gossip reached ready state', 'System');
        });

        // Gossip events
        this.gossip.on('messageReceived', ({ message, local, fromPeer }) => {
          this.messagesSeen++;
          const indicator = local ? '📤' : (fromPeer ? '📥' : '📡');
          const source = local ? 'You' : fromPeer.slice(0, 6);
          const hopLabel = message.hops === 1 ? 'hop' : 'hops';
          this.addLog(
            local ? 'sent' : 'received',
            `${indicator} [${message.hops} ${hopLabel}] ${message.data}`,
            source,
            message.hops,
            local
          );
          if (this.autoScroll) this.$nextTick(() => this.scrollToBottom());
        });

        this.mesh.on('signaling:error', (error) => {
          this.showStatus('Error', `${error.message || error}`, 'error');
        });

        this.mesh.on('signaling:log', ({ message }) => {
          this.addLog('info', message, 'freertc');
        });

        this.gossip.on('directMessageReceived', ({ message }) => {
          this.dmLog.push({
            local: false,
            from: message.from,
            to: message.to,
            text: String(message.data),
            timestamp: new Date(message.timestamp),
          });
          this.saveUiState();
          this.$nextTick(() => this.scrollDmToBottom());
        });

        await this.mesh.init();
        this.isRunning = true;
        this.isConnecting = false;
        this.updateStats();
        this.startDebugMonitor();

        // Best-effort warning only; do not hard-fail startup on transient signaling slowness.
        setTimeout(() => {
          if (this.isRunning && !this.clientId) {
            this.showStatus('Connecting...', `Still waiting on signaling server (${this.signalingServer})`, 'connecting');
          }
        }, 12_000);
      } catch (error) {
        console.error('Failed to start mesh:', error);
        this.showStatus('Error', error.message || String(error), 'error');
        this.isRunning = false;
        this.isConnecting = false;
      }
    },

    stopMesh() {
      this.stopDebugMonitor();
      if (this.mesh) {
        this.mesh.destroy();
        this.mesh = null;
      }
      if (this.gossip) {
        this.gossip.destroy();
        this.gossip = null;
      }
      this.isRunning = false;
      this.messageLog = [];
      this.dmLog = [];
      this.dmTarget = '';
      this.dmInput = '';
      this.globalPeersList = [];
      this.saveUiState();
      this.addLog('info', 'Mesh stopped', 'System');
      this.showStatus('Idle', 'Idle', 'info');
    },

    sendMessage() {
      if (!this.gossip || !this.messageInput.trim()) return;

      const message = this.messageInput.trim();
      this.messageInput = '';

      this.gossip.broadcast(message, {
        sender: this.clientId,
        timestamp: Date.now()
      });
      if (this.autoScroll) this.$nextTick(() => this.scrollToBottom());
    },

    sendDm() {
      if (!this.gossip || !this.dmInput.trim()) return;
      const self = String(this.mesh?.getClientId?.() || this.clientId || '').trim();
      const target = String(this.dmTarget || '').trim();
      if (!target || (self && target === self)) {
        this.addLog('info', 'Select a valid peer target for DM', 'System');
        return;
      }

      const text = this.dmInput.trim();
      this.dmInput = '';
      const id = this.gossip.sendDirect(target, text);
      if (!id) {
        this.addLog('info', 'DM failed: local peer ID is not ready yet', 'System');
        return;
      }
      this.dmLog.push({
        local: true,
        from: self || this.clientId,
        to: target,
        text,
        timestamp: new Date(),
      });
      this.saveUiState();
      this.$nextTick(() => this.scrollDmToBottom());
    },

    updateStats() {
      if (this.mesh) {
        const meshClientId = String(this.mesh.getClientId?.() || this.clientId || '').trim();
        if (meshClientId) {
          this.clientId = meshClientId;
        }

        this.connectedPeersList = this.mesh.getConnectedPeers();
        this.discoveredPeersList = this.mesh.getDiscoveredPeers();
        const global = this.mesh.getGlobalPeers ? this.mesh.getGlobalPeers() : [];
        const self = meshClientId;
        this.globalPeersList = [...new Set([
          ...global,
          ...this.connectedPeersList,
          ...this.discoveredPeersList,
        ])].filter(p => p && p !== self);

        // Keep DM target valid as the membership view converges.
        if (!this.globalPeersList.includes(this.dmTarget) || this.dmTarget === self) {
          this.dmTarget = this.globalPeersList[0] || '';
        }

        this.saveUiState();
      }

      this.syncGossipStatus();
    },

    requiredConnectedPeersForGossip() {
      return this.maxPeers <= 1 ? 1 : 2;
    },

    syncGossipStatus() {
      if (!this.isRunning) return;
      if (this.status.type === 'error') return;

      const connected = this.connectedPeersList.length;
      const required = this.requiredConnectedPeersForGossip();

      if (connected >= required) {
        this.showStatus('Ready', `Gossip OK (${connected}/${required} connected)`, 'success');
      } else {
        this.showStatus('Connecting', `Waiting for peers (${connected}/${required} connected)`, 'connecting');
      }
    },

    addLog(type, text, sender = 'System', hops = 0, local = false) {
      const entry = {
        type,
        text,
        sender,
        hops,
        timestamp: new Date(),
        local
      };

      this.messageLog.push(entry);

      if (import.meta.env.DEV) {
        // Mirror all app logs to browser console for rapid debugging.
        // eslint-disable-next-line no-console
        console.log(`[mesh:${type}] ${sender} ${text}`);
      }

      // Keep log size manageable
      if (this.messageLog.length > 100) {
        this.messageLog.shift();
      }
    },

    clearLog() {
      this.messageLog = [];
    },

    showStatus(title, message, type = 'info') {
      this.status = { title, message, type };
    },


    startDebugMonitor() {
      this.stopDebugMonitor();
      this.debugLastByPeer = {};

      this.debugMonitorTimer = setInterval(() => {
        try {
          const rawClient = this.mesh?.signalingClient?.client;
          const connections = rawClient?.mesh?.connections;
          if (!connections || typeof connections.entries !== 'function') return;

          for (const [peerId, entry] of connections.entries()) {
            const snapshot = {
              mesh: String(entry?.state || ''),
              pc: String(entry?.connection?.connectionState || ''),
              ice: String(entry?.connection?.iceConnectionState || ''),
              signaling: String(entry?.connection?.signalingState || ''),
              dc: String(entry?.channel?.readyState || '')
            };

            const previous = this.debugLastByPeer[peerId];
            const changed = !previous ||
              previous.mesh !== snapshot.mesh ||
              previous.pc !== snapshot.pc ||
              previous.ice !== snapshot.ice ||
              previous.signaling !== snapshot.signaling ||
              previous.dc !== snapshot.dc;

            if (changed) {
              this.debugLastByPeer[peerId] = snapshot;
              this.addLog(
                'info',
                `conn(mesh=${snapshot.mesh || '-'}, pc=${snapshot.pc || '-'}, ice=${snapshot.ice || '-'}, sig=${snapshot.signaling || '-'}, dc=${snapshot.dc || '-'})`,
                peerId
              );
            }
          }
        } catch {
          // ignore debug monitor failures
        }
      }, 500);
    },

    stopDebugMonitor() {
      if (this.debugMonitorTimer) {
        clearInterval(this.debugMonitorTimer);
        this.debugMonitorTimer = null;
      }
      this.debugLastByPeer = {};
    },

    updateUrlState() {
      try {
        const url = new URL(window.location.href);
        // Preserve original query params to avoid disturbing tests or manual URL state
        const originalParams = new URLSearchParams(window.location.search);
        
        // Update only the configuration params; preserve any explicitly provided sessionId
        url.searchParams.set('topology', this.topology);
        url.searchParams.set('minPeers', String(this.minPeers));
        url.searchParams.set('maxPeers', String(this.maxPeers));
        if (this.networkName) url.searchParams.set('networkName', this.networkName);
        
        // Only sync sessionId to URL if it wasn't explicitly provided in the original URL
        // This prevents tests' __test_* sessionIds from being modified
        const hadExplicitSessionId = originalParams.has('sessionId') || originalParams.has('roomSessionId') || originalParams.has('room');
        if (hadExplicitSessionId) {
          // Keep original sessionId param as-is
          url.searchParams.set('sessionId', originalParams.get('sessionId') || originalParams.get('roomSessionId') || originalParams.get('room'));
        } else if (this.roomSessionId) {
          // Update sessionId only if no explicit one was provided originally
          url.searchParams.set('sessionId', this.roomSessionId);
        }
        
        window.history.replaceState({}, '', url.toString());
      } catch {
        // ignore URL state errors
      }
    },

    formatTime(date) {
      return new Date(date).toLocaleTimeString();
    },
    scrollToBottom() {
      const container = this.$refs.logContainer;
      if (!container) return;
      container.scrollTop = container.scrollHeight;
    },

    scrollDmToBottom() {
      const container = this.$refs.dmLogContainer;
      if (!container) return;
      container.scrollTop = container.scrollHeight;
    },

    scrollDiagToBottom() {
      const container = this.$refs.diagLogContainer;
      if (!container) return;
      container.scrollTop = container.scrollHeight;
    },

    saveUiState() {
      try {
        sessionStorage.setItem(this.uiStateKey, JSON.stringify({
          dmTarget: this.dmTarget || '',
          dmLog: this.dmLog.slice(-100)
        }));
      } catch {
        // ignore storage failures
      }
    },

    loadUiState() {
      try {
        const raw = sessionStorage.getItem(this.uiStateKey);
        if (!raw) return;
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed.dmLog)) {
          this.dmLog = parsed.dmLog;
        }
        if (typeof parsed.dmTarget === 'string') {
          this.dmTarget = parsed.dmTarget;
        }
      } catch {
        // ignore storage failures
      }
    },
  },

  beforeUnmount() {
    this.stopDebugMonitor();
    this.stopMesh();
  }
};
</script>

<style scoped>
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

#app {
  min-height: 100vh;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  color: #333;
}

header {
  background: rgba(255, 255, 255, 0.95);
  padding: 2rem;
  text-align: center;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);
}

header h1 {
  font-size: 2.5rem;
  margin-bottom: 0.5rem;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  background-clip: text;
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
}

header p {
  color: #666;
  font-size: 1.1rem;
}

main {
  max-width: 1200px;
  margin: 2rem auto;
  padding: 0 1rem;
}

section {
  background: white;
  border-radius: 12px;
  padding: 2rem;
  margin-bottom: 2rem;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
}

/* Control Panel */
.control-panel {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.config-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 0.85rem;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.field-topology {
  min-width: 280px;
}

.field-topology .input {
  min-width: 280px;
}

.field-label {
  font-size: 0.82rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #4a4a4a;
}

.field-number .input {
  text-align: center;
}

.effective-session {
  color: #4a4a4a;
  font-size: 0.9rem;
}

.effective-session .mono {
  font-family: 'Monaco', 'Courier New', monospace;
  font-weight: 700;
  color: #3f51b5;
}

.button-group {
  display: flex;
  gap: 1rem;
  flex-wrap: wrap;
}

.message-input {
  display: flex;
  gap: 1rem;
  width: 100%;
  align-items: stretch;
}

.input {
  padding: 0.75rem 1rem;
  border: 2px solid #e0e0e0;
  border-radius: 8px;
  font-size: 1rem;
  transition: border-color 0.3s;
}

.message-input .input {
  flex: 1;
  min-width: 0;
}

.message-input .btn {
  flex: 0 0 120px;
}

.diagnostics {
  border-top: 4px solid #2f6fec;
}

.diag-container {
  max-height: 260px;
  overflow: auto;
  background: #0f172a;
  color: #d1e3ff;
  border: 1px solid #1e293b;
}

.diag-entry {
  display: grid;
  grid-template-columns: 90px 120px 1fr;
  gap: 0.5rem;
  padding: 0.35rem 0.5rem;
  font-family: 'Monaco', 'Courier New', monospace;
  font-size: 0.82rem;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

.diag-time {
  color: #8ec5ff;
}

.diag-sender {
  color: #b0f2c2;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.diag-text {
  color: #e5e7eb;
  word-break: break-word;
}

.diag-empty {
  padding: 0.6rem;
  color: #94a3b8;
  font-size: 0.85rem;
}

.input:focus {
  outline: none;
  border-color: #667eea;
}

.input:disabled {
  background: #f5f5f5;
  color: #999;
}

/* Buttons */
.btn {
  padding: 0.75rem 1.5rem;
  border: none;
  border-radius: 8px;
  font-size: 1rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.3s;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.btn:hover:not(:disabled) {
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-primary {
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: white;
}

.btn-secondary {
  background: linear-gradient(135deg, #00c896 0%, #00a876 100%);
  color: white;
}

.btn-danger {
  background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);
  color: white;
}

.btn-small {
  padding: 0.5rem 1rem;
  font-size: 0.9rem;
}

/* Stats */
.stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
  gap: 1rem;
}

.stat-box {
  display: flex;
  justify-content: space-between;
  padding: 1rem;
  background: #f8f9fa;
  border-left: 4px solid #667eea;
  border-radius: 8px;
}

.stat-box .label {
  font-weight: 600;
  color: #333;
}

.stat-box .value {
  font-weight: 700;
  color: #667eea;
  font-size: 1.2rem;
}

.stat-box .mono {
  font-family: 'Monaco', 'Courier New', monospace;
  font-size: 0.9rem;
  word-break: break-all;
}

/* Inline status field */
.status-field {
  border: 1px solid #d6d9de;
  border-radius: 8px;
  padding: 0.55rem 0.7rem;
  font-size: 0.92rem;
  color: #3e4a59;
  background: #f8fafc;
  min-height: 2.2rem;
  display: flex;
  align-items: center;
}

.status-field.status-connecting {
  color: #0f4c81;
  background: #edf5ff;
  border-color: #c6dfff;
}

.status-field.status-success {
  color: #165b3d;
  background: #effaf3;
  border-color: #bfe6cd;
}

.status-field.status-error {
  color: #8b1d1d;
  background: #fff1f1;
  border-color: #f1c3c3;
}

/* Network Visualization */
.network-viz {
  text-align: center;
}

.network-viz h3 {
  margin-bottom: 1rem;
}

.peers-container {
  display: flex;
  justify-content: center;
  flex-wrap: wrap;
  gap: 2rem;
}

.peer {
  width: 100px;
  height: 100px;
  border-radius: 50%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  font-weight: 600;
  transition: all 0.3s;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
}

.peer.self {
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: white;
  font-size: 1.1rem;
}

.peer.connected {
  background: linear-gradient(135deg, #00c896 0%, #00a876 100%);
  color: white;
  animation: pulse 2s infinite;
}

@keyframes pulse {
  0%, 100% {
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  }
  50% {
    box-shadow: 0 0 20px rgba(0, 200, 150, 0.5);
  }
}

.peer-id {
  font-family: 'Monaco', 'Courier New', monospace;
  font-size: 0.9rem;
  opacity: 0.9;
}

.peer-label {
  font-size: 0.8rem;
  opacity: 0.7;
}

/* Chat */
.chat h3 {
  margin-bottom: 1rem;
}

.log-controls {
  display: flex;
  gap: 1rem;
  align-items: center;
  margin-bottom: 1rem;
}

.log-controls label {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.9rem;
}

.log-container {
  height: 300px;
  max-height: 50vh;
  overflow-y: auto;
  overflow-x: hidden;
  background: #f8f9fa;
  border-radius: 8px;
  padding: 1rem;
  border: 1px solid #e0e0e0;
  scroll-behavior: smooth;
}

.chat-container {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding-right: 6px; /* space for scrollbar */
}

.log-entry {
  display: flex;
}

.log-entry.signaling {
  background: #e3f2fd;
  color: #1976d2;
}

.log-entry.discovered {
  background: #fff3e0;
  color: #e65100;
}

.log-entry.connected {
  background: #e8f5e9;
  color: #2e7d32;
}

.log-entry.disconnected {
  background: #fce4ec;
  color: #c2185b;
}

.bubble {
  display: inline-block;
  max-width: 100%;
  width: fit-content;
  padding: 0.6rem 0.8rem;
  border-radius: 12px;
  box-shadow: 0 2px 6px rgba(0,0,0,0.08);
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: anywhere;
}

.bubble.me {
  margin-left: auto;
  background: #16a34a !important; /* green */
  color: #ffffff !important;
  border-bottom-right-radius: 4px;
  border: 1px solid #0f7a36;
}

.bubble.peer {
  margin-right: auto;
  background: #dbeafe !important; /* light blue */
  color: #1e3a8a !important;
  border-bottom-left-radius: 4px;
  border: 1px solid #bfdbfe;
}

.bubble.dm-me {
  margin-left: auto;
  background: #4f46e5 !important;
  color: #fff !important;
  border-bottom-right-radius: 4px;
  border: 1px solid #3730a3;
}

.bubble.dm-peer {
  margin-right: auto;
  background: #fdf4ff !important;
  color: #6b21a8 !important;
  border-bottom-left-radius: 4px;
  border: 1px solid #e9d5ff;
}

.dm-section {
  border-top: 3px solid #e9d5ff;
}

.dm-input-row {
  display: flex;
  gap: 0.75rem;
  width: 100%;
  align-items: stretch;
  margin-bottom: 0.75rem;
}

.dm-select {
  flex: 0 0 160px;
  cursor: pointer;
}

.dm-text {
  flex: 1;
  min-width: 0;
}

.btn-dm {
  flex: 0 0 120px;
  background: linear-gradient(135deg, #7c3aed 0%, #4f46e5 100%);
  color: white;
  border: none;
  border-radius: 8px;
  font-size: 1rem;
  font-weight: 600;
  cursor: pointer;
  padding: 0.75rem 1rem;
  transition: all 0.3s;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.btn-dm:hover:not(:disabled) {
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(79, 70, 229, 0.4);
}

.btn-dm:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.dm-log {
  height: 180px;
  max-height: 30vh;
}

/* Ensure the chat section itself clips any inner overflow */
.chat {
  overflow: hidden;
}

.bubble-meta {
  display: flex;
  gap: 0.5rem;
  font-size: 0.75rem;
  opacity: 0.8;
}

.bubble-text {
  margin-top: 0.25rem;
  word-break: break-word;
}

.bubble-hops {
  margin-top: 0.25rem;
  font-size: 0.75rem;
  opacity: 0.7;
}
/* legacy message log helpers no longer used in chat bubbles */

/* Responsive */
@media (max-width: 768px) {
  header h1 {
    font-size: 1.8rem;
  }

  .message-input {
    flex-direction: column;
  }

  .stats {
    grid-template-columns: 1fr;
  }

  .peers-container {
    gap: 1rem;
  }

  .peer {
    width: 80px;
    height: 80px;
    font-size: 0.9rem;
  }

  .field-topology,
  .field-topology .input {
    min-width: 0;
    width: 100%;
  }
}
</style>
