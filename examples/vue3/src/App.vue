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
    </main>
  </div>
</template>

<script>
import { PartialMesh } from 'partialmesh';
import { GossipProtocol } from './GossipProtocol.js';

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
      topology: 'partial',
      sessionId: 'gossip-protocol-demo',
      messageLog: [],
      autoScroll: true,
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

    const topologyParam = (params.get('topology') || '').toLowerCase();
    if (topologyParam === 'ring' || topologyParam === 'token-ring' || topologyParam === 'tokenring') {
      this.topology = 'ring';
    } else if (topologyParam === 'partial') {
      this.topology = 'partial';
    }

    const sessionIdParam = params.get('sessionId');
    if (sessionIdParam) {
      this.sessionId = sessionIdParam;
    }

    const autostart = (params.get('autostart') || '').toLowerCase();
    if (autostart === '1' || autostart === 'true' || autostart === 'yes') {
      this.startMesh();
    }
  },
  computed: {
    connectedPeers() {
      return this.connectedPeersList.length;
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
    }
  },
  methods: {
    async startMesh() {
      try {
        this.isConnecting = true;
        this.showStatus('Connecting...', 'Initializing PartialMesh with Gossip Protocol...', 'connecting');

        this.mesh = new PartialMesh({
          signalingServer: 'wss://signal.peer.ooo',
          sessionId: this.sessionId,
          minPeers: this.minPeers,
          maxPeers: this.maxPeers,
          topology: this.topology,
          autoDiscover: true,
          autoConnect: true,
          // If the mesh stays under-connected for too long (common in flaky WebRTC automation),
          // force a full peer-connection reset to recover.
          underConnectedResetMs: 30_000
        });

        this.gossip = new GossipProtocol(this.mesh);

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

        this.mesh.on('peer:connected', (peerId) => {
          this.addLog('connected', `Connected to peer`, peerId);
          this.updateStats();
          this.showStatus('Peer Connected', `Connected to ${peerId.slice(0, 6)}...`, 'success');
        });

        this.mesh.on('peer:disconnected', (peerId) => {
          this.addLog('disconnected', `Disconnected from peer`, peerId);
          this.updateStats();
        });

        this.mesh.on('mesh:ready', () => {
          this.showStatus('Mesh Ready! 🎉', 'Minimum peers connected. Gossip protocol is active!', 'success');
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

        await this.mesh.init();
        this.isRunning = true;
        this.isConnecting = false;
        this.updateStats();
      } catch (error) {
        console.error('Failed to start mesh:', error);
        this.showStatus('Error', error.message, 'error');
        this.isConnecting = false;
      }
    },

    stopMesh() {
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
      this.addLog('info', 'Mesh stopped', 'System');
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

    updateStats() {
      if (this.mesh) {
        this.connectedPeersList = this.mesh.getConnectedPeers();
        this.discoveredPeersList = this.mesh.getDiscoveredPeers();
      }
    },

    addLog(type, text, sender = 'System', hops = 0, local = false) {
      this.messageLog.push({
        type,
        text,
        sender,
        hops,
        timestamp: new Date(),
        local
      });

      // Keep log size manageable
      if (this.messageLog.length > 100) {
        this.messageLog.shift();
      }
    },

    clearLog() {
      this.messageLog = [];
    },

    showStatus(title, message, type = 'info') {
      this.status = { show: true, title, message, type };
      if (type !== 'error') {
        setTimeout(() => {
          this.status.show = false;
        }, 5000);
      }
    },

    formatTime(date) {
      return new Date(date).toLocaleTimeString();
    },
    scrollToBottom() {
      const container = this.$refs.logContainer;
      if (!container) return;
      container.scrollTop = container.scrollHeight;
    }
  },

  beforeUnmount() {
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
}
</style>
