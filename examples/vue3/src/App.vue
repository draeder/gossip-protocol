<template>
  <div id="app">
    <header>
      <h1>🚀 Gossip Protocol Demo</h1>
      <p>Distributed message propagation using WebRTC & PartialMesh</p>
    </header>

    <main>
      <!-- Control Panel -->
      <section class="control-panel">
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
        <div class="config-row">
          <label for="replay-on-reconnect">Replay on reconnect</label>
          <input
            id="replay-on-reconnect"
            v-model.number="replayOnReconnectCount"
            :disabled="isConnecting"
            type="number"
            min="0"
            max="100"
            step="1"
            class="input config-input"
          />
        </div>
        <div class="config-grid">
          <label class="config-item" for="session-id">
            <span>Session</span>
            <input
              id="session-id"
              v-model.lazy="sessionId"
              :disabled="isConnecting"
              type="text"
              class="input config-input-wide"
            />
          </label>
          <label class="config-item" for="room-id">
            <span>Room</span>
            <input
              id="room-id"
              v-model.lazy="roomId"
              :disabled="isConnecting"
              type="text"
              class="input config-input-wide"
            />
          </label>
        </div>
        <div class="peer-limits-row">
          <label class="config-item" for="min-peers">
            <span>Min remote peers</span>
            <input
              id="min-peers"
              v-model.number.lazy="minPeers"
              :disabled="isConnecting"
              type="number"
              min="1"
              max="50"
              step="1"
              class="input config-input"
            />
          </label>
          <label class="config-item" for="max-peers">
            <span>Max remote peers</span>
            <input
              id="max-peers"
              v-model.number.lazy="maxPeers"
              :disabled="isConnecting"
              type="number"
              min="1"
              max="50"
              step="1"
              class="input config-input"
            />
          </label>
          <label class="config-item" for="max-peers-tolerance">
            <span>Tolerable (soft-max)</span>
            <input
              id="max-peers-tolerance"
              v-model.number.lazy="maxPeersTolerance"
              :disabled="isConnecting"
              type="number"
              min="0"
              max="50"
              step="1"
              class="input config-input"
            />
          </label>
        </div>
      </section>

      <!-- Stats Display -->
      <section v-if="isRunning" class="stats">
        <div class="stat-box">
          <span class="label">Client ID:</span>
          <span class="value mono" data-testid="client-id">{{ clientId }}</span>
        </div>
        <div class="stat-box">
          <span class="label">Connected Remote Peers:</span>
          <span class="value" data-testid="connected-peers">{{ connectedPeers }} / {{ maxPeers }} (+{{ toleratedConnectedPeers }})</span>
        </div>
        <div class="stat-box">
          <span class="label">Discovered Remote Peers:</span>
          <span class="value" data-testid="discovered-peers">{{ discoveredPeers }}</span>
        </div>
        <div class="stat-box">
          <span class="label">Messages Seen:</span>
          <span class="value" data-testid="messages-seen">{{ messagesSeen }}</span>
        </div>
      </section>

      <!-- Status Box -->
      <section v-if="status.show" :class="['status-box', status.type]">
        <h3>{{ status.title }}</h3>
        <p>{{ status.message }}</p>
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
                <span v-if="entry.latencyMs != null" class="latency">(~{{ formatLatency(entry.latencyMs) }})</span>
              </div>
              <div class="bubble-text">{{ entry.text }}</div>
              <div v-if="entry.hops > 0" class="bubble-hops">{{ entry.hops === 1 ? '1 hop' : entry.hops + ' hops' }}</div>
            </div>
          </div>
        </div>

        <div class="message-input">
          <input 
            ref="messageInput"
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
      clientId: '',
      connectedPeersList: [],
      discoveredPeersList: [],
      messagesSeen: 0,
      maxPeers: 5,
      minPeers: 1,
      maxHops: 32,
      replayOnReconnectCount: 3,
      sessionId: 'gossip-protocol-demo-local',
      roomId: 'gossip-protocol-demo-local',
      maxPeersTolerance: 1,
      underConnectedResetMs: 15000,
      connectionTimeoutMs: 12000,
      hadSignalingConnection: false,
      messageLog: [],
      autoScroll: true,
      restartTimer: null,
      suppressLiveRestart: false,
      statusTimer: null,
      status: {
        show: false,
        title: '',
        message: '',
        type: 'info'
      }
    };
  },
  mounted() {
    const params = new URLSearchParams(window.location.search);

    const hostScopedDefaultRoom = (() => {
      const host = (window.location.hostname || 'local').replace(/[^a-zA-Z0-9-]/g, '-');
      return `gossip-protocol-demo-${host}`;
    })();

    // Avoid global room collisions when demo is opened without explicit room/session params.
    this.sessionId = hostScopedDefaultRoom;
    this.roomId = hostScopedDefaultRoom;

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

    const sessionIdParam = params.get('sessionId');
    if (sessionIdParam) {
      this.sessionId = sessionIdParam;
    }

    const roomIdParam = params.get('room');
    if (roomIdParam) {
      this.roomId = roomIdParam;
    }

    const maxPeersToleranceRaw = params.get('maxPeersTolerance');
    if (maxPeersToleranceRaw !== null) {
      const maxPeersToleranceParam = Number(maxPeersToleranceRaw);
      if (Number.isFinite(maxPeersToleranceParam) && maxPeersToleranceParam >= 0) {
        this.maxPeersTolerance = Math.min(50, Math.floor(maxPeersToleranceParam));
      }
    }

    const tolerableOverMaxRaw = params.get('tolerableOverMax');
    if (tolerableOverMaxRaw !== null) {
      const tolerableOverMaxParam = Number(tolerableOverMaxRaw);
      if (Number.isFinite(tolerableOverMaxParam) && tolerableOverMaxParam >= 0) {
        this.maxPeersTolerance = Math.min(50, Math.floor(tolerableOverMaxParam));
      }
    }

    const maxHopsParam = Number(params.get('maxHops'));
    if (Number.isFinite(maxHopsParam) && maxHopsParam >= 1) {
      this.maxHops = Math.min(100, Math.floor(maxHopsParam));
    }

    const replayOnReconnectRaw = params.get('replayOnReconnect');
    if (replayOnReconnectRaw !== null) {
      const replayOnReconnectParam = Number(replayOnReconnectRaw);
      if (Number.isFinite(replayOnReconnectParam) && replayOnReconnectParam >= 0) {
        this.replayOnReconnectCount = Math.min(100, Math.floor(replayOnReconnectParam));
      }
    }

    this.normalizeMeshBounds();

    // Auto-start is enabled by default; disable explicitly with ?autostart=0.
    const autostart = (params.get('autostart') ?? '1').toLowerCase();
    if (autostart !== '0' && autostart !== 'false' && autostart !== 'no') {
      const autostartDelayRaw = params.get('autostartDelayMs');
      const autostartDelayMs = autostartDelayRaw !== null
        ? Math.max(0, Math.min(10_000, Math.floor(Number(autostartDelayRaw) || 0)))
        : 0;
      setTimeout(() => {
        if (!this.isRunning && !this.isConnecting) {
          this.startMesh();
        }
      }, autostartDelayMs);
    }
  },
  computed: {
    connectedPeers() {
      return this.connectedPeersList.length;
    },
    toleratedConnectedPeers() {
      return Math.max(0, this.connectedPeers - this.maxPeers);
    },
    discoveredPeers() {
      return this.discoveredPeersList.length;
    },
    chatMessages() {
      return this.messageLog.filter(e => e.type === 'sent' || e.type === 'received');
    }
  },
  watch: {
    messageLog() {
      const last = this.messageLog[this.messageLog.length - 1];
      if (!last) return;
      if ((last.type === 'sent' || last.type === 'received') && this.autoScroll) {
        this.$nextTick(() => this.scrollToBottom());
      }
    },
    sessionId() {
      this.scheduleMeshRestart('session');
    },
    roomId() {
      this.scheduleMeshRestart('room');
    },
    minPeers() {
      this.normalizeMeshBounds();
      this.scheduleMeshRestart('minPeers');
    },
    maxPeers() {
      this.normalizeMeshBounds();
      this.scheduleMeshRestart('maxPeers');
    },
    maxPeersTolerance() {
      this.maxPeersTolerance = Math.max(0, Math.min(50, Math.floor(Number(this.maxPeersTolerance) || 0)));
      this.scheduleMeshRestart('maxPeersTolerance');
    },
    replayOnReconnectCount() {
      this.replayOnReconnectCount = Math.max(0, Math.min(100, Math.floor(Number(this.replayOnReconnectCount) || 0)));
      if (this.gossip && typeof this.gossip.setReplayOnReconnectCount === 'function') {
        this.gossip.setReplayOnReconnectCount(this.replayOnReconnectCount);
      }
    }
  },
  methods: {
    normalizeMeshBounds() {
      this.maxPeers = Math.max(1, Math.min(50, Math.floor(Number(this.maxPeers) || 1)));
      this.minPeers = Math.max(1, Math.min(50, Math.floor(Number(this.minPeers) || 1)));
      if (this.minPeers > this.maxPeers) {
        this.minPeers = this.maxPeers;
      }
    },
    scheduleMeshRestart(reason) {
      if (!this.isRunning || this.isConnecting || this.suppressLiveRestart) return;
      if (this.restartTimer) {
        clearTimeout(this.restartTimer);
      }
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        this.restartMesh(reason);
      }, 250);
    },
    async restartMesh(reason = 'config-change') {
      if (!this.isRunning || this.isConnecting || this.suppressLiveRestart) return;
      this.showStatus('Applying Config', `Restarting mesh after ${reason}...`, 'connecting');
      this.stopMesh({ clearLog: false, logMessage: false });
      await this.startMesh();
      this.addLog('info', `Applied live config (${reason})`, 'System');
    },
    async startMesh() {
      try {
        this.suppressLiveRestart = true;
        this.isConnecting = true;
        this.hadSignalingConnection = false;
        this.normalizeMeshBounds();

        const effectiveSessionId = (this.roomId || this.sessionId || 'gossip-protocol-demo').trim();
        this.sessionId = effectiveSessionId;
        this.roomId = effectiveSessionId;

        this.mesh = new PartialMesh({
          signalingServer: 'wss://peer.ooo/ws',
          sessionId: effectiveSessionId,
          minPeers: this.minPeers,
          maxPeers: this.maxPeers,
          maxPeersTolerance: this.maxPeersTolerance,
          autoDiscover: true,
          autoConnect: true,
          connectionTimeoutMs: this.connectionTimeoutMs,
          maintenanceIntervalMs: 2000,
          announceIntervalMs: 1500,
          // Keep signaling active even when the tab is in the background.
          // For multi-tab local testing, pausing hidden tabs can prevent handshakes.
          pauseWhenHidden: false,
          // If the mesh stays under-connected for too long (common in flaky WebRTC automation),
          // force a full peer-connection reset to recover.
          underConnectedResetMs: this.underConnectedResetMs
        });

        this.gossip = new GossipProtocol(this.mesh, {
          maxHops: this.maxHops,
          replayOnReconnectCount: this.replayOnReconnectCount
        });

        // Mesh events
        this.mesh.on('signaling:connected', (data) => {
          this.clientId = (data.clientId || '').trim();
          this.addLog('signaling', `Connected to signaling server`, this.clientId);
          if (this.hadSignalingConnection) {
            this.showStatus('Signaling Restored', 'WebSocket reconnected after interruption.', 'success', true);
          } else {
            this.showStatus('Signaling Connected', 'Looking for peers...', 'connecting');
          }
          this.hadSignalingConnection = true;
          this.updateStats();
        });

        this.mesh.on('signaling:disconnected', () => {
          if (!this.isRunning) return;
          this.showStatus('Signaling Disconnected', 'Attempting automatic reconnect...', 'connecting');
        });

        this.mesh.on('peer:discovered', (peerId) => {
          this.addLog('discovered', `Discovered peer`, peerId);
          this.updateStats();
        });

        this.mesh.on('peer:connected', (peerId) => {
          this.addLog('connected', `Connected to peer`, peerId);
          this.updateStats();
          this.showStatus('Peer Connected', `Connected to ${peerId.slice(0, 6)}...`, 'success', true);
        });

        this.mesh.on('peer:disconnected', (peerId) => {
          this.addLog('disconnected', `Disconnected from peer`, peerId);
          this.updateStats();
          this.revertStatus();
        });

        this.mesh.on('peer:error', ({ peerId, error }) => {
          const reason = this.formatErrorMessage(error);
          this.addLog('info', `Peer connect failed (${reason})`, peerId || 'unknown');
          this.showStatus('Peer Connection Retry', `${reason}. Retrying...`, 'connecting');
          this.updateStats();
        });

        this.mesh.on('mesh:ready', () => {
          this.showStatus('Mesh Ready! 🎉', 'Minimum peers connected. Gossip protocol is active!', 'success', true);
          // Focus the message input when mesh is ready
          this.$nextTick(() => {
            const input = this.$refs.messageInput;
            if (input) input.focus();
          });
        });

        // Gossip events
        this.gossip.on('messageReceived', ({ message, local, fromPeer }) => {
          this.messagesSeen++;
          const indicator = local ? '📤' : (fromPeer ? '📥' : '📡');
          // Show original sender, not the forwarder
          const senderDisplay = message.sender ? message.sender.slice(0, 6) : (fromPeer ? fromPeer.slice(0, 6) : 'unknown');
          const source = local ? 'You' : senderDisplay;
          const hopLabel = message.hops === 1 ? 'hop' : 'hops';
          const latencyMs = (!local && Number.isFinite(message.timestamp))
            ? Math.max(0, Date.now() - Number(message.timestamp))
            : null;
          this.addLog(
            local ? 'sent' : 'received',
            `${indicator} [${message.hops} ${hopLabel}] ${message.data}`,
            source,
            message.hops,
            local,
            message.timestamp,
            latencyMs
          );
          if (this.autoScroll) this.$nextTick(() => this.scrollToBottom());
        });

        this.mesh.on('signaling:error', (error) => {
          if (this.isRunning) {
            this.showStatus('Signaling Issue', `${this.formatErrorMessage(error)}. Retrying...`, 'connecting');
            return;
          }
          this.showStatus('Error', this.formatErrorMessage(error), 'error');
        });

        this.mesh.init();
        this.clientId = this.mesh.getClientId() || '';
        this.isRunning = true;
        this.isConnecting = false;
        this.suppressLiveRestart = false;
        this.updateStats();
      } catch (error) {
        console.error('Failed to start mesh:', error);
        this.showStatus('Error', this.formatErrorMessage(error), 'error');
        this.isConnecting = false;
        this.suppressLiveRestart = false;
      }
    },

    formatErrorMessage(error) {
      if (!error) return 'Unknown error';
      if (typeof error === 'string') return error;
      if (error instanceof Error) return error.message || error.name || 'Error';

      // Browser WebSocket failures are frequently surfaced as plain Event objects.
      const eventType = typeof error.type === 'string' ? error.type : '';
      const eventTarget = error.target;
      if (eventType) {
        if (eventTarget && typeof eventTarget.readyState === 'number' && eventTarget.url) {
          return `Signaling ${eventType} (readyState=${eventTarget.readyState})`; 
        }
        return `Signaling ${eventType}`;
      }

      if (typeof error.message === 'string' && error.message) return error.message;

      try {
        return JSON.stringify(error);
      } catch {
        return String(error);
      }
    },

    stopMesh(options = {}) {
      const { clearLog = true, logMessage = true } = options;
      this.suppressLiveRestart = true;
      if (this.restartTimer) {
        clearTimeout(this.restartTimer);
        this.restartTimer = null;
      }
      if (this.mesh) {
        this.mesh.destroy();
        this.mesh = null;
      }
      if (this.gossip) {
        this.gossip.destroy();
        this.gossip = null;
      }
      this.isRunning = false;
      this.isConnecting = false;
      this.hadSignalingConnection = false;
      if (clearLog) {
        this.messageLog = [];
      }
      if (logMessage) {
        this.addLog('info', 'Mesh stopped', 'System');
      }
      this.suppressLiveRestart = false;
    },

    sendMessage() {
      if (!this.gossip || !this.messageInput.trim()) return;

      const message = this.messageInput.trim();
      this.messageInput = '';

      try {
        this.gossip.broadcast(message, {
          sender: this.clientId,
          timestamp: Date.now()
        });
      } catch (err) {
        console.error('[sendMessage] broadcast error:', err);
        this.addLog('info', `⚠️ Send error: ${err?.message ?? err}`, 'System');
      }

      if (this.connectedPeersList.length === 0) {
        this.addLog('info', '⚠️ No peers connected — message saved locally only', 'System');
        if (this.mesh && typeof this.mesh.nudgeConnectivity === 'function') {
          try {
            this.mesh.nudgeConnectivity('send-without-peers');
            setTimeout(() => {
              if (this.mesh && this.isRunning && this.connectedPeersList.length === 0 && typeof this.mesh.nudgeConnectivity === 'function') {
                this.mesh.nudgeConnectivity('send-without-peers-retry');
              }
            }, 600);
          } catch {
            // ignore
          }
        }
      }

      if (this.autoScroll) this.$nextTick(() => this.scrollToBottom());
    },

    updateStats() {
      if (this.mesh) {
        this.connectedPeersList = this.mesh.getConnectedPeers();
        this.discoveredPeersList = this.mesh.getDiscoveredPeers();
      }
    },

    addLog(type, text, sender = 'System', hops = 0, local = false, messageTimestamp = undefined, latencyMs = null) {
      const resolvedTimestamp = Number.isFinite(messageTimestamp)
        ? new Date(messageTimestamp)
        : new Date();
      this.messageLog.push({
        type,
        text,
        sender,
        hops,
        timestamp: resolvedTimestamp,
        latencyMs: Number.isFinite(latencyMs) ? Math.max(0, Math.round(latencyMs)) : null,
        local
      });

      // Keep log size reasonable for UI performance, but generous for message retention
      if (this.messageLog.length > 10000) {
        this.messageLog.shift();
      }
    },

    clearLog() {
      this.messageLog = [];
    },

    showStatus(title, message, type = 'info', autohide = false) {
      if (this.statusTimer) { clearTimeout(this.statusTimer); this.statusTimer = null; }
      this.status = { show: true, title, message, type };
      if (autohide && type !== 'error') {
        this.statusTimer = setTimeout(() => {
          this.statusTimer = null;
          this.revertStatus();
        }, 5000);
      }
    },

    revertStatus() {
      if (!this.isRunning) return;
      if (this.connectedPeersList.length > 0) {
        this.status = { show: true, title: 'Mesh Active', message: `${this.connectedPeersList.length} peer(s) connected.`, type: 'success' };
      } else if (this.hadSignalingConnection) {
        this.status = { show: true, title: 'Signaling Connected', message: 'Looking for peers. Open another tab with the same room if needed.', type: 'connecting' };
      }
    },

    formatTime(date) {
      return new Date(date).toLocaleTimeString();
    },
    formatLatency(value) {
      const ms = Number(value);
      if (!Number.isFinite(ms)) return 'n/a';
      return `${Math.max(0, Math.round(ms))}ms`;
    },
    scrollToBottom() {
      const container = this.$refs.logContainer;
      if (!container) return;
      container.scrollTop = container.scrollHeight;
    }
  },

  beforeUnmount() {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.stopMesh({ logMessage: false });
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

.config-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.config-row label {
  font-weight: 600;
  color: #333;
}

.config-input {
  width: 100px;
  flex: 0 0 auto;
}

.config-row .input.config-input {
  flex: 0 0 auto;
}

.config-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 0.75rem;
}

.peer-limits-row {
  display: grid;
  grid-template-columns: repeat(3, minmax(150px, 1fr));
  gap: 0.75rem;
}

.config-item {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  font-size: 0.9rem;
  font-weight: 600;
}

.config-input-wide {
  width: 100%;
}


.button-group {
  display: flex;
  gap: 1rem;
  flex-wrap: wrap;
}

.message-input {
  display: flex;
  gap: 1rem;
}

.input {
  flex: 1;
  padding: 0.75rem 1rem;
  border: 2px solid #e0e0e0;
  border-radius: 8px;
  font-size: 1rem;
  transition: border-color 0.3s;
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

/* Status Box */
.status-box {
  border-radius: 12px;
  padding: 1.5rem;
  margin-bottom: 1rem;
  border-left: 4px solid;
}

.status-box.connecting {
  background: #e3f2fd;
  border-left-color: #2196f3;
  color: #1976d2;
}

.status-box.success {
  background: #e8f5e9;
  border-left-color: #4caf50;
  color: #2e7d32;
}

.status-box.error {
  background: #ffebee;
  border-left-color: #f44336;
  color: #c62828;
}

.status-box h3 {
  margin-bottom: 0.5rem;
  font-size: 1.2rem;
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

.latency {
  opacity: 0.75;
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

  .peer-limits-row {
    grid-template-columns: 1fr;
  }
}
</style>
