// Fast Channel Manager - Establishes low-latency connection to server
class FastChannelManager {
  constructor(scene) {
    this.scene = scene;
    this.fastSocket = null;
    this.isConnected = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    
    // Message types that should use fast channel
    this.fastMessageTypes = new Set([
      'input',           // Player input
      'position_update', // Position updates
      'ball_position',   // Ball position
      'projectile_update' // Projectile updates
    ]);
  }
  
  async initialize() {
    if (!this.scene.clientId) {
      console.log('Fast channel: Waiting for client ID...');
      setTimeout(() => this.initialize(), 1000);
      return;
    }
    
    await this.connectFastChannel();
  }
  
  async connectFastChannel() {
    if (this.fastSocket && this.fastSocket.readyState === WebSocket.OPEN) {
      return; // Already connected
    }
    
    const serverUrl = this.getServerUrl();
    const fastUrl = serverUrl.replace('ws://', 'ws://').replace('wss://', 'wss://').replace('/ws', '/fast');
    
    console.log('Connecting fast channel to:', fastUrl);
    
    try {
      this.fastSocket = new WebSocket(fastUrl);
      
      this.fastSocket.onopen = () => {
        console.log('Fast channel connected - sending handshake for client:', this.scene.clientId);
        this.isConnected = true;
        this.reconnectAttempts = 0;
        
        // Send handshake with client ID
        const handshake = {
          type: 'fast_handshake',
          client_id: this.scene.clientId
        };
        console.log('Sending fast channel handshake:', JSON.stringify(handshake));
        this.fastSocket.send(JSON.stringify(handshake));
      };
      
      this.fastSocket.onmessage = (event) => {
        // Fast channel typically doesn't receive messages
        // All game state comes through reliable channel
        console.log('Fast channel received:', event.data);
      };
      
      this.fastSocket.onclose = (event) => {
        console.log('Fast channel closed:', event.code, event.reason);
        this.isConnected = false;
        this.attemptReconnect();
      };
      
      this.fastSocket.onerror = (error) => {
        console.error('Fast channel error:', error);
        this.isConnected = false;
      };
      
    } catch (error) {
      console.error('Failed to create fast channel:', error);
      this.attemptReconnect();
    }
  }
  
  attemptReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.log('Fast channel: Max reconnect attempts reached - disabling fast channel (using WebSocket fallback)');
      this.isConnected = false;
      return;
    }
    
    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 10000);
    
    console.log(`Fast channel: Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
    setTimeout(() => {
      this.connectFastChannel();
    }, delay);
  }
  
  getServerUrl() {
    // Extract server URL from main WebSocket connection
    if (this.scene.socket && this.scene.socket.url) {
      return this.scene.socket.url;
    }
    
    // Fallback to current configuration
    const isSecure = window.location.protocol === 'https:';
    const protocol = isSecure ? 'wss:' : 'ws:';
    const host = window.location.hostname === 'localhost' ? 'localhost:8080' : 'towerup.io';
    return `${protocol}//${host}/ws`;
  }
  
  sendFastMessage(message) {
    console.log('sendFastMessage called:', {
      isConnected: this.isConnected,
      hasSocket: !!this.fastSocket,
      readyState: this.fastSocket ? this.fastSocket.readyState : 'NO_SOCKET',
      messageType: message.type
    });
    
    if (this.isConnected && this.fastSocket && this.fastSocket.readyState === WebSocket.OPEN) {
      try {
        console.log('Actually sending fast message:', message.type);
        this.fastSocket.send(JSON.stringify(message));
        return true;
      } catch (error) {
        console.error('Failed to send fast message:', error);
        return false;
      }
    }
    console.log('sendFastMessage: Cannot send - channel not ready');
    return false;
  }
  
  shouldUseFastChannel(messageType) {
    return this.fastMessageTypes.has(messageType) && this.isConnected;
  }
  
  // Enhanced send method that chooses the right channel
  sendMessage(message) {
    // Debug logging for input messages
    if (message.type === 'input') {
      console.log('FastChannelManager: Processing input message - connected:', this.isConnected, 'type:', message.type);
      console.log('FastChannelManager: shouldUseFastChannel:', this.shouldUseFastChannel(message.type));
      console.log('FastChannelManager: input message:', JSON.stringify(message));
    }
    
    if (this.shouldUseFastChannel(message.type)) {
      // Try fast channel first
      console.log('FastChannelManager: Attempting to send via fast channel:', message.type);
      if (this.sendFastMessage(message)) {
        if (message.type === 'input') {
          console.log('FastChannelManager: Input sent via fast channel successfully');
        }
        return true;
      }
      // Only log fallback message if we haven't already reached max attempts
      if (this.reconnectAttempts < this.maxReconnectAttempts) {
        console.log('Fast channel failed, falling back to reliable channel');
      }
    }
    
    // Fallback to reliable WebSocket
    if (this.scene.socket && this.scene.socket.readyState === WebSocket.OPEN) {
      if (message.type === 'input') {
        console.log('FastChannelManager: Sending input via reliable channel fallback');
      }
      this.scene.socket.send(JSON.stringify(message));
      return true;
    }
    
    return false;
  }
  
  cleanup() {
    if (this.fastSocket) {
      this.fastSocket.close();
      this.fastSocket = null;
    }
    this.isConnected = false;
  }
  
  getStatus() {
    const maxAttemptsReached = this.reconnectAttempts >= this.maxReconnectAttempts;
    return {
      connected: this.isConnected,
      readyState: this.fastSocket ? this.fastSocket.readyState : -1,
      reconnectAttempts: this.reconnectAttempts,
      disabled: maxAttemptsReached,
      status: maxAttemptsReached ? 'disabled' : (this.isConnected ? 'connected' : 'connecting')
    };
  }
}

// Export for use in main game
window.FastChannelManager = FastChannelManager; 