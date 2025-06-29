// WebRTC Signaling Server Integration
// This handles the signaling needed for WebRTC peer connections

class WebRTCSignalingManager {
  constructor(gameServer) {
    this.gameServer = gameServer;
    this.peerConnections = new Map(); // Track which peers are connected to which
    this.pendingOffers = new Map(); // Track pending offers
  }
  
  handleWebRTCMessage(ws, message) {
    const { type, fromPeer, toPeer, signalType, signalData, clientId } = message;
    
    switch (type) {
      case 'request_webrtc_peers':
        this.handlePeerListRequest(ws, clientId);
        break;
        
      case 'webrtc_signaling':
        this.handleSignaling(ws, fromPeer, toPeer, signalType, signalData);
        break;
        
      default:
        console.log('Unknown WebRTC message type:', type);
    }
  }
  
  handlePeerListRequest(ws, clientId) {
    // Get list of all connected clients except the requester
    const allClients = Array.from(this.gameServer.clients.keys())
      .filter(id => id !== clientId);
    
    console.log(`Sending peer list to ${clientId}:`, allClients);
    
    // Send peer list to the requesting client
    this.sendToClient(ws, {
      type: 'webrtc_signaling',
      fromPeer: 'server',
      toPeer: clientId,
      signalType: 'peer_list',
      signalData: allClients
    });
  }
  
  handleSignaling(ws, fromPeer, toPeer, signalType, signalData) {
    console.log(`WebRTC signaling: ${fromPeer} -> ${toPeer} (${signalType})`);
    
    // Find the target peer's WebSocket connection
    const targetWs = this.findClientWebSocket(toPeer);
    
    if (!targetWs) {
      console.log(`Target peer ${toPeer} not found for signaling`);
      return;
    }
    
    // Forward the signaling message to the target peer
    this.sendToClient(targetWs, {
      type: 'webrtc_signaling',
      fromPeer: fromPeer,
      toPeer: toPeer,
      signalType: signalType,
      signalData: signalData
    });
    
    // Track peer connections
    if (signalType === 'offer') {
      this.pendingOffers.set(`${fromPeer}-${toPeer}`, {
        from: fromPeer,
        to: toPeer,
        timestamp: Date.now()
      });
    } else if (signalType === 'answer') {
      const offerKey = `${toPeer}-${fromPeer}`;
      if (this.pendingOffers.has(offerKey)) {
        this.pendingOffers.delete(offerKey);
        
        // Track successful connection
        this.trackPeerConnection(fromPeer, toPeer);
      }
    }
  }
  
  trackPeerConnection(peer1, peer2) {
    const connectionKey = `${peer1}-${peer2}`;
    this.peerConnections.set(connectionKey, {
      peer1,
      peer2,
      established: Date.now()
    });
    
    console.log(`WebRTC connection established: ${peer1} <-> ${peer2}`);
  }
  
  findClientWebSocket(clientId) {
    // This needs to be adapted to your existing server structure
    // Assuming you have a way to map client IDs to WebSocket connections
    return this.gameServer.clients.get(clientId);
  }
  
  sendToClient(ws, message) {
    if (ws && ws.readyState === 1) { // WebSocket.OPEN
      ws.send(JSON.stringify(message));
    }
  }
  
  handleClientDisconnect(clientId) {
    console.log(`Cleaning up WebRTC connections for ${clientId}`);
    
    // Remove pending offers
    const keysToDelete = [];
    for (const [key, offer] of this.pendingOffers) {
      if (offer.from === clientId || offer.to === clientId) {
        keysToDelete.push(key);
      }
    }
    keysToDelete.forEach(key => this.pendingOffers.delete(key));
    
    // Remove peer connections
    for (const [key, connection] of this.peerConnections) {
      if (connection.peer1 === clientId || connection.peer2 === clientId) {
        this.peerConnections.delete(key);
      }
    }
    
    // Notify other clients that this peer is gone
    this.notifyPeerDisconnection(clientId);
  }
  
  notifyPeerDisconnection(disconnectedPeer) {
    const message = {
      type: 'webrtc_signaling',
      fromPeer: 'server',
      toPeer: 'all',
      signalType: 'peer_disconnected',
      signalData: { peerId: disconnectedPeer }
    };
    
    // Send to all connected clients
    for (const [clientId, ws] of this.gameServer.clients) {
      if (clientId !== disconnectedPeer) {
        this.sendToClient(ws, message);
      }
    }
  }
  
  getStats() {
    return {
      peerConnections: this.peerConnections.size,
      pendingOffers: this.pendingOffers.size,
      connections: Array.from(this.peerConnections.values())
    };
  }
  
  // Clean up old pending offers (call this periodically)
  cleanupOldOffers() {
    const now = Date.now();
    const timeout = 30000; // 30 seconds
    
    const keysToDelete = [];
    for (const [key, offer] of this.pendingOffers) {
      if (now - offer.timestamp > timeout) {
        keysToDelete.push(key);
      }
    }
    
    keysToDelete.forEach(key => {
      console.log(`Cleaning up old offer: ${key}`);
      this.pendingOffers.delete(key);
    });
  }
}

// Example integration with your existing game server
class IntegratedGameServer {
  constructor() {
    this.clients = new Map();
    this.webrtcManager = new WebRTCSignalingManager(this);
    
    // Clean up old WebRTC offers every 30 seconds
    setInterval(() => {
      this.webrtcManager.cleanupOldOffers();
    }, 30000);
  }
  
  handleClientMessage(ws, clientId, message) {
    // Check if this is a WebRTC signaling message
    if (message.type === 'request_webrtc_peers' || message.type === 'webrtc_signaling') {
      this.webrtcManager.handleWebRTCMessage(ws, message);
      return;
    }
    
    // Handle regular game messages
    this.handleGameMessage(ws, clientId, message);
  }
  
  handleGameMessage(ws, clientId, message) {
    // Your existing game logic here
    console.log(`Game message from ${clientId}:`, message.type);
    
    // Example: Handle input messages
    if (message.type === 'input') {
      // Process input and broadcast to other clients
      this.broadcastToOthers(clientId, {
        type: 'player_update',
        playerId: clientId,
        ...message
      });
    }
  }
  
  handleClientDisconnect(clientId) {
    console.log(`Client ${clientId} disconnected`);
    
    // Clean up WebRTC connections
    this.webrtcManager.handleClientDisconnect(clientId);
    
    // Your existing disconnect logic
    this.clients.delete(clientId);
    
    // Notify other clients
    this.broadcastToAll({
      type: 'player_left',
      playerId: clientId
    });
  }
  
  broadcastToOthers(senderId, message) {
    for (const [clientId, ws] of this.clients) {
      if (clientId !== senderId) {
        this.sendToClient(ws, message);
      }
    }
  }
  
  broadcastToAll(message) {
    for (const [clientId, ws] of this.clients) {
      this.sendToClient(ws, message);
    }
  }
  
  sendToClient(ws, message) {
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify(message));
    }
  }
  
  getServerStats() {
    return {
      connectedClients: this.clients.size,
      webrtc: this.webrtcManager.getStats()
    };
  }
}

// Example WebSocket server setup
function createWebRTCEnabledServer(port = 8080) {
  const WebSocket = require('ws');
  const gameServer = new IntegratedGameServer();
  
  const wss = new WebSocket.Server({ port });
  
  wss.on('connection', (ws) => {
    const clientId = generateClientId();
    console.log(`Client ${clientId} connected`);
    
    gameServer.clients.set(clientId, ws);
    
    // Send initial connection message
    ws.send(JSON.stringify({
      type: 'init',
      your_id: clientId,
      server_time: Date.now()
    }));
    
    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data);
        gameServer.handleClientMessage(ws, clientId, message);
      } catch (e) {
        console.error('Invalid message format:', e);
      }
    });
    
    ws.on('close', () => {
      gameServer.handleClientDisconnect(clientId);
    });
    
    ws.on('error', (error) => {
      console.error(`WebSocket error for client ${clientId}:`, error);
      gameServer.handleClientDisconnect(clientId);
    });
  });
  
  console.log(`WebRTC-enabled game server listening on port ${port}`);
  return { wss, gameServer };
}

function generateClientId() {
  return Math.random().toString(36).substr(2, 9);
}

module.exports = {
  WebRTCSignalingManager,
  IntegratedGameServer,
  createWebRTCEnabledServer
};

// Usage example:
// const { createWebRTCEnabledServer } = require('./webrtc-signaling');
// const { wss, gameServer } = createWebRTCEnabledServer(8080); 