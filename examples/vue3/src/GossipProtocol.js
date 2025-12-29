/**
 * Gossip Protocol Implementation
 * A simple gossip/epidemic protocol for propagating data through a peer network
 */

export class GossipProtocol {
  constructor(mesh, options = {}) {
    this.mesh = mesh;
    this.messageLog = new Map(); // Track seen messages to prevent re-propagation
    this.maxHops = options.maxHops || 5;
    this.callbacks = {};
    this.peers = new Map(); // Track peer information
    
    // Set up mesh event listeners
    this.setupMeshListeners();
  }

  setupMeshListeners() {
    this.mesh.on('peer:data', ({ peerId, data }) => {
      try {
        const message = JSON.parse(data.toString());
        this.handleIncomingMessage(message, peerId);
      } catch (e) {
        console.error('Failed to parse incoming message:', e);
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
   * Broadcast data to all connected peers using gossip protocol
   */
  broadcast(data, metadata = {}) {
    const message = {
      id: this.generateMessageId(),
      timestamp: Date.now(),
      hops: 0,
      maxHops: this.maxHops,
      sender: this.mesh.getClientId(),
      data: data,
      metadata: metadata,
      type: 'gossip'
    };

    // Store in log to track this message
    this.messageLog.set(message.id, {
      timestamp: message.timestamp,
      sender: message.sender,
      hops: 0
    });

    // Send to all connected peers
    this.propagate(message);

    // Emit local event
    this.emit('messageReceived', { message, local: true });

    return message.id;
  }

  /**
   * Propagate message to connected peers
   */
  propagate(message) {
    const connectedPeers = this.mesh.getConnectedPeers();
    
    connectedPeers.forEach(peerId => {
      // Don't send back to sender
      if (peerId !== message.sender) {
        const forwardedMessage = {
          ...message,
          hops: message.hops + 1
        };

        try {
          this.mesh.send(peerId, JSON.stringify(forwardedMessage));
        } catch (e) {
          console.error(`Failed to send message to ${peerId}:`, e);
        }
      }
    });
  }

  /**
   * Handle incoming gossip message
   */
  handleIncomingMessage(message, peerId) {
    // Check if we've already seen this message
    const messageKey = message.id;
    const alreadySeen = this.messageLog.has(messageKey);

    if (!alreadySeen) {
      // First time seeing this message
      this.messageLog.set(messageKey, {
        timestamp: Date.now(),
        sender: message.sender,
        hops: message.hops
      });

      // Emit event for application
      this.emit('messageReceived', { message, local: false, fromPeer: peerId });

      // Continue propagation if within hop limit
      if (message.hops < message.maxHops) {
        this.propagate(message);
      }
    }
  }

  /**
   * Get statistics about message propagation
   */
  getStats() {
    const now = Date.now();
    const messages = Array.from(this.messageLog.entries()).map(([id, info]) => ({
      id,
      ...info,
      age: now - info.timestamp
    }));

    return {
      totalMessagesTracked: this.messageLog.size,
      recentMessages: messages.filter(m => m.age < 60000), // Last minute
      connectedPeers: this.mesh.getConnectedPeers().length,
      discoveredPeers: this.mesh.getDiscoveredPeers().length
    };
  }

  /**
   * Clean up old message entries
   */
  cleanup(maxAge = 600000) { // 10 minutes default
    const now = Date.now();
    for (const [id, info] of this.messageLog.entries()) {
      if (now - info.timestamp > maxAge) {
        this.messageLog.delete(id);
      }
    }
  }

  /**
   * Event emitter
   */
  on(event, callback) {
    if (!this.callbacks[event]) {
      this.callbacks[event] = [];
    }
    this.callbacks[event].push(callback);
  }

  off(event, callback) {
    if (this.callbacks[event]) {
      this.callbacks[event] = this.callbacks[event].filter(cb => cb !== callback);
    }
  }

  emit(event, data) {
    if (this.callbacks[event]) {
      this.callbacks[event].forEach(cb => cb(data));
    }
  }

  /**
   * Generate unique message ID
   */
  generateMessageId() {
    return `${this.mesh.getClientId()}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Destroy and clean up
   */
  destroy() {
    this.messageLog.clear();
    this.peers.clear();
    this.callbacks = {};
  }
}
