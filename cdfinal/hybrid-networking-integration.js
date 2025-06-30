// Hybrid Fast Channel + WebSocket networking integration
// This shows how to modify your existing MainScene to use dual connections

class HybridNetworkingExample {
  
  // Modified create() method for your MainScene
  static integrateIntoMainScene(scene) {
    
    // Add Fast Channel manager to your scene (instead of WebRTC)
    if (window.FastChannelManager) {
      scene.fastChannelManager = new window.FastChannelManager(scene);
    }
    
    // Modified connectToGameServer method
    scene.connectToGameServer = function() {
      // Keep existing WebSocket connection logic
      this.socket = new WebSocket(window.WEBSOCKET_URL);
      
      this.socket.onopen = () => {
        console.log('WebSocket connected');
        
        // Initialize Fast Channel after WebSocket is established
        if (this.fastChannelManager) {
          this.fastChannelManager.initialize();
        }
      };
      
      // Keep existing WebSocket message handlers but add WebRTC routing
      this.socket.addEventListener('message', (event) => {
        try {
          const msg = JSON.parse(event.data);
          
          // Handle WebRTC signaling via WebSocket
          if (msg.type === 'webrtc_signaling') {
            // Let WebRTC manager handle this
            return;
          }
          
          // Handle regular game messages
          this.handleGameMessage(msg);
          
        } catch (e) {
          console.error('Error handling WebSocket message:', e);
        }
      });
    };
    
    // Enhanced sendInput method that uses hybrid networking
    scene.sendInput = function() {
      if (this.playerCanMove !== false && this.socket && this.socket.readyState === WebSocket.OPEN) {
        this.inputSequence++;
        
        const input = {
          type: 'input',
          left: this.inputState.left,
          right: this.inputState.right,
          up: this.inputState.up,
          down: this.inputState.down,
          shoot: this.inputState.shoot,
          boost: this.inputState.boost,
          seq: this.inputSequence,
          target_x: this.aimTarget?.x || this.ship.x,
          target_y: this.aimTarget?.y || this.ship.y,
          display_name: window.PLAYER_DISPLAY_NAME || 'Player',
          timestamp: Date.now()
        };
        
        // Use hybrid networking - fast channel for input
        if (this.fastChannelManager) {
          this.fastChannelManager.sendMessage(input);
        } else {
          // Fallback to WebSocket
          this.socket.send(JSON.stringify(input));
        }
      }
    };
    
    // Fast channel system is server-centric, so no peer-to-peer handling needed
    // All fast messages go through the server via the fast channel
    scene.handleFastChannelMessage = function(message) {
      // Handle fast messages received from server
      console.log('Received fast channel message:', message);
      
      // Fast messages are handled by the server and sent back through regular game state
      // The benefit is in the reduced latency for sending to the server
    };
    
    // Modified team switching to use reliable WebSocket
    scene.switchTeam = function(team) {
      console.log(`Switching to team: ${team}`);
      if (this.socket && this.socket.readyState === WebSocket.OPEN) {
        const message = {
          type: 'switch_team',
          team: team
        };
        
        // Always use WebSocket for reliable team changes
        this.socket.send(JSON.stringify(message));
      }
    };
    
    // Add periodic position updates via Fast Channel (optional - input already contains position)
    scene.startPositionBroadcasting = function() {
      if (this.positionBroadcastInterval) {
        clearInterval(this.positionBroadcastInterval);
      }
      
      // Note: Usually not needed since input messages already contain position
      // But can be useful for high-frequency position-only updates
      this.positionBroadcastInterval = setInterval(() => {
        if (this.fastChannelManager && this.ship) {
          const positionUpdate = {
            type: 'position_update',
            x: this.ship.x,
            y: this.ship.y,
            rotation: this.ship.rotation,
            timestamp: Date.now(),
            playerId: this.clientId
          };
          
          this.fastChannelManager.sendMessage(positionUpdate);
        }
      }, 33); // Send position updates every 33ms (30fps) via Fast Channel
    };
    
    // Enhanced cleanup method
    const originalShutdown = scene.shutdown;
    scene.shutdown = function() {
      console.log('Shutting down hybrid networking...');
      
      if (this.positionBroadcastInterval) {
        clearInterval(this.positionBroadcastInterval);
      }
      
      if (this.fastChannelManager) {
        this.fastChannelManager.cleanup();
      }
      
      // Call original shutdown
      if (originalShutdown) {
        originalShutdown.call(this);
      }
    };
    
    // Add networking stats display
    scene.updateNetworkingStats = function() {
      if (this.fastChannelManager) {
        const stats = this.fastChannelManager.getStatus();
        
        if (this.networkStatsText) {
          this.networkStatsText.setText(
            `Fast Channel: ${stats.connected ? 'Connected' : 'Disconnected'}\n` +
            `WebSocket: ${this.socket?.readyState === WebSocket.OPEN ? 'Connected' : 'Disconnected'}\n` +
            `Reconnect Attempts: ${stats.reconnectAttempts}`
          );
        } else {
          // Create stats display
          this.networkStatsText = this.add.text(10, 100, '', { 
            font: "12px Arial", 
            fill: "#ffffff" 
          }).setScrollFactor(0);
        }
      }
    };
    
    return scene;
  }
  
  // Performance comparison helper
  static measureLatency(scene) {
    let webrtcLatencies = [];
    let websocketLatencies = [];
    
    // Measure WebRTC latency
    const measureWebRTC = () => {
      const start = performance.now();
      
      if (scene.webrtcManager) {
        scene.webrtcManager.sendWebRTCMessage({
          type: 'ping_test',
          timestamp: start
        });
      }
    };
    
    // Measure WebSocket latency  
    const measureWebSocket = () => {
      const start = performance.now();
      
      if (scene.socket && scene.socket.readyState === WebSocket.OPEN) {
        scene.socket.send(JSON.stringify({
          type: 'ping_test',
          timestamp: start
        }));
      }
    };
    
    return {
      startWebRTCTest: measureWebRTC,
      startWebSocketTest: measureWebSocket,
      getResults: () => ({
        webrtc: {
          average: webrtcLatencies.reduce((a, b) => a + b, 0) / webrtcLatencies.length,
          samples: webrtcLatencies.length
        },
        websocket: {
          average: websocketLatencies.reduce((a, b) => a + b, 0) / websocketLatencies.length,
          samples: websocketLatencies.length
        }
      })
    };
  }
}

// Usage example:
// In your MainScene.create() method, add:
// HybridNetworkingExample.integrateIntoMainScene(this);

window.HybridNetworkingExample = HybridNetworkingExample; 