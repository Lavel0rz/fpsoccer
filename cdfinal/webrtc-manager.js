class WebRTCManager {
  constructor(scene) {
    this.scene = scene;
    this.peers = new Map(); // Map of peer connections
    this.dataChannels = new Map(); // Map of data channels
    this.isHost = false;
    this.hostId = null;
    
    // Configuration for WebRTC
    this.rtcConfig = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
        // Add TURN servers for production
      ]
    };
    
    // Message types that should use WebRTC (time-sensitive)
    this.webrtcMessageTypes = new Set([
      'input',           // Player input - needs low latency
      'position_update', // Ship positions - frequent updates
      'ball_position',   // Ball position - real-time tracking
      'projectile_update' // Projectile positions - fast moving
    ]);
    
    // Message types that should use WebSocket (reliable)
    this.websocketMessageTypes = new Set([
      'goal',           // Score updates - must be reliable
      'team_switch',    // Team changes - must be reliable  
      'game_reset',     // Game state resets - must be reliable
      'player_join',    // Player management - must be reliable
      'player_leave'    // Player management - must be reliable
    ]);
  }
  
  async initialize() {
    console.log('Initializing WebRTC networking...');
    
    // Listen for WebSocket messages about WebRTC signaling
    if (this.scene.socket) {
      this.scene.socket.addEventListener('message', (event) => {
        try {
          const message = JSON.parse(event.data);
          if (message.type === 'webrtc_signaling') {
            console.log('Received WebRTC signaling message:', message);
            this.handleSignalingMessage(message);
          }
        } catch (e) {
          // Not a JSON message, ignore
        }
      });
    }

    // Wait a bit before requesting peers to ensure other players have connected
    console.log('Waiting 2 seconds before requesting WebRTC peers...');
    setTimeout(() => {
      this.requestWebRTCConnections();
    }, 2000);
    
    // Set up periodic peer discovery (retry every 10 seconds if no peers)
    this.peerDiscoveryInterval = setInterval(() => {
      if (this.dataChannels.size === 0) {
        console.log('No WebRTC peers connected, retrying...');
        this.requestWebRTCConnections();
      }
    }, 10000);
  }
  
  requestWebRTCConnections() {
    if (this.scene.socket && this.scene.socket.readyState === WebSocket.OPEN) {
      console.log('Requesting WebRTC peers from server...');
      this.scene.socket.send(JSON.stringify({
        type: 'request_webrtc_peers',
        clientId: this.scene.clientId
      }));
    } else {
      console.warn('Cannot request WebRTC peers - socket not ready');
    }
  }
  
  async handleSignalingMessage(message) {
    const { fromPeer, toPeer, signalType, signalData } = message;
    
    if (toPeer !== this.scene.clientId) return; // Not for us
    
    switch (signalType) {
      case 'offer':
        await this.handleOffer(fromPeer, signalData);
        break;
      case 'answer':
        await this.handleAnswer(fromPeer, signalData);
        break;
      case 'ice_candidate':
        await this.handleIceCandidate(fromPeer, signalData);
        break;
      case 'peer_list':
        await this.handlePeerList(signalData);
        break;
    }
  }
  
  async handlePeerList(peerList) {
    console.log('Received peer list:', peerList);
    console.log('My client ID:', this.scene.clientId);
    console.log('Current peers in manager:', Array.from(this.peers.keys()));
    
    if (!Array.isArray(peerList)) {
      console.warn('Peer list is not an array:', peerList);
      return;
    }
    
    if (peerList.length === 0) {
      console.log('No other peers to connect to');
      return;
    }
    
    // Create connections to all peers
    for (const peerId of peerList) {
      if (peerId !== this.scene.clientId && !this.peers.has(peerId)) {
        console.log(`Attempting to create peer connection to ${peerId}`);
        await this.createPeerConnection(peerId, true); // We initiate
      } else if (peerId === this.scene.clientId) {
        console.log('Skipping self in peer list');
      } else {
        console.log(`Already have connection to peer ${peerId}`);
      }
    }
  }
  
  async createPeerConnection(peerId, shouldCreateOffer = false) {
    console.log(`Creating peer connection to ${peerId}`);
    
    const peerConnection = new RTCPeerConnection(this.rtcConfig);
    this.peers.set(peerId, peerConnection);
    
    // Handle ICE candidates
    peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        this.sendSignalingMessage(peerId, 'ice_candidate', event.candidate);
      }
    };
    
    // Handle connection state changes
    peerConnection.onconnectionstatechange = () => {
      console.log(`Connection with ${peerId}: ${peerConnection.connectionState}`);
      if (peerConnection.connectionState === 'failed' || peerConnection.connectionState === 'closed') {
        this.cleanupPeer(peerId);
      }
    };
    
    // Create data channel for game data
    if (shouldCreateOffer) {
      const dataChannel = peerConnection.createDataChannel('gameData', {
        ordered: false,        // Don't wait for lost packets
        maxRetransmits: 0     // Don't retransmit lost packets
      });
      
      this.setupDataChannel(peerId, dataChannel);
      
      // Create and send offer
      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);
      this.sendSignalingMessage(peerId, 'offer', offer);
    } else {
      // Handle incoming data channel
      peerConnection.ondatachannel = (event) => {
        const dataChannel = event.channel;
        this.setupDataChannel(peerId, dataChannel);
      };
    }
  }
  
  setupDataChannel(peerId, dataChannel) {
    this.dataChannels.set(peerId, dataChannel);
    
    dataChannel.onopen = () => {
      console.log(`Data channel with ${peerId} opened`);
    };
    
    dataChannel.onclose = () => {
      console.log(`Data channel with ${peerId} closed`);
      this.dataChannels.delete(peerId);
    };
    
    dataChannel.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        this.handleWebRTCMessage(peerId, message);
      } catch (e) {
        console.error('Failed to parse WebRTC message:', e);
      }
    };
  }
  
  async handleOffer(fromPeer, offer) {
    await this.createPeerConnection(fromPeer, false);
    const peerConnection = this.peers.get(fromPeer);
    
    await peerConnection.setRemoteDescription(offer);
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    
    this.sendSignalingMessage(fromPeer, 'answer', answer);
  }
  
  async handleAnswer(fromPeer, answer) {
    const peerConnection = this.peers.get(fromPeer);
    if (peerConnection) {
      await peerConnection.setRemoteDescription(answer);
    }
  }
  
  async handleIceCandidate(fromPeer, candidate) {
    const peerConnection = this.peers.get(fromPeer);
    if (peerConnection) {
      await peerConnection.addIceCandidate(candidate);
    }
  }
  
  sendSignalingMessage(toPeer, signalType, signalData) {
    if (this.scene.socket && this.scene.socket.readyState === WebSocket.OPEN) {
      this.scene.socket.send(JSON.stringify({
        type: 'webrtc_signaling',
        fromPeer: this.scene.clientId,
        toPeer: toPeer,
        signalType: signalType,
        signalData: signalData
      }));
    }
  }
  
  // Send message via WebRTC to all connected peers
  sendWebRTCMessage(message) {
    const messageStr = JSON.stringify(message);
    
    for (const [peerId, dataChannel] of this.dataChannels) {
      if (dataChannel.readyState === 'open') {
        try {
          dataChannel.send(messageStr);
        } catch (e) {
          console.error(`Failed to send WebRTC message to ${peerId}:`, e);
        }
      }
    }
  }
  
  // Handle incoming WebRTC messages
  handleWebRTCMessage(fromPeer, message) {
    // Process time-sensitive messages received via WebRTC
    switch (message.type) {
      case 'input':
        // Handle peer input for prediction/interpolation
        this.scene.handlePeerInput(fromPeer, message);
        break;
      case 'position_update':
        // Handle peer position updates
        this.scene.handlePeerPosition(fromPeer, message);
        break;
      case 'ball_position':
        // Handle ball position updates (if using P2P ball physics)
        this.scene.handleBallPosition(fromPeer, message);
        break;
      case 'projectile_update':
        // Handle projectile updates
        this.scene.handleProjectileUpdate(fromPeer, message);
        break;
    }
  }
  
  // Determine which transport to use for a message
  shouldUseWebRTC(messageType) {
    return this.webrtcMessageTypes.has(messageType) && this.dataChannels.size > 0;
  }
  
  // Enhanced send method that chooses transport
  sendMessage(message) {
    if (this.shouldUseWebRTC(message.type)) {
      // Send via WebRTC for low latency
      this.sendWebRTCMessage(message);
    } else {
      // Send via WebSocket for reliability
      if (this.scene.socket && this.scene.socket.readyState === WebSocket.OPEN) {
        this.scene.socket.send(JSON.stringify(message));
      }
    }
  }
  
  cleanupPeer(peerId) {
    const peerConnection = this.peers.get(peerId);
    if (peerConnection) {
      peerConnection.close();
      this.peers.delete(peerId);
    }
    this.dataChannels.delete(peerId);
  }
  
  cleanup() {
    console.log('Cleaning up WebRTC connections...');
    
    // Clear intervals
    if (this.peerDiscoveryInterval) {
      clearInterval(this.peerDiscoveryInterval);
      this.peerDiscoveryInterval = null;
    }
    
    for (const [peerId, peerConnection] of this.peers) {
      peerConnection.close();
    }
    
    this.peers.clear();
    this.dataChannels.clear();
  }
  
  // Get connection statistics
  getStats() {
    return {
      peerCount: this.peers.size,
      activeChannels: Array.from(this.dataChannels.values()).filter(ch => ch.readyState === 'open').length,
      connectedPeers: Array.from(this.peers.keys())
    };
  }
}

// Export for use in main game
window.WebRTCManager = WebRTCManager; 