// Example integration for hybrid WebRTC + WebSocket networking
// This shows how to modify your existing MainScene to use both transports

class HybridNetworkingExample {
  
  // Modified create() method for your MainScene
  static integrateIntoMainScene(scene) {
    
    // Add WebRTC manager to your scene
    scene.webrtcManager = new window.WebRTCManager(scene);
    
    // Modified connectToGameServer method
    scene.connectToGameServer = function() {
      // Keep existing WebSocket connection logic
      this.socket = new WebSocket(window.WEBSOCKET_URL);
      
      this.socket.onopen = () => {
        console.log('WebSocket connected');
        
        // Initialize WebRTC after WebSocket is established
        if (this.webrtcManager) {
          this.webrtcManager.initialize();
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
        
        // Use hybrid networking
        if (this.webrtcManager) {
          this.webrtcManager.sendMessage(input);
        } else {
          // Fallback to WebSocket
          this.socket.send(JSON.stringify(input));
        }
      }
    };
    
    // Add methods to handle peer-to-peer messages
    scene.handlePeerInput = function(fromPeer, message) {
      // Handle input from other players for better prediction
      console.log(`Received input from peer ${fromPeer}:`, message);
      
      // You could use this for client-side prediction of other players
      // This gives you their input slightly before the server processes it
    };
    
    scene.handlePeerPosition = function(fromPeer, message) {
      // Handle position updates from peers
      console.log(`Received position from peer ${fromPeer}:`, message);
      
      // Use for smoother interpolation of other players
      if (this.otherShips[fromPeer]) {
        this.otherShips[fromPeer].peerPosition = {
          x: message.x,
          y: message.y,
          timestamp: message.timestamp
        };
      }
    };
    
    scene.handleBallPosition = function(fromPeer, message) {
      // Handle ball position from peers (if using P2P ball physics)
      console.log(`Received ball position from peer ${fromPeer}:`, message);
      
      // Could be used for ball prediction between server updates
    };
    
    scene.handleProjectileUpdate = function(fromPeer, message) {
      // Handle projectile updates from peers
      console.log(`Received projectile from peer ${fromPeer}:`, message);
      
      // Projectiles benefit greatly from low-latency updates
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
    
    // Add periodic position broadcasting via WebRTC
    scene.startPositionBroadcasting = function() {
      if (this.positionBroadcastInterval) {
        clearInterval(this.positionBroadcastInterval);
      }
      
      this.positionBroadcastInterval = setInterval(() => {
        if (this.webrtcManager && this.ship) {
          const positionUpdate = {
            type: 'position_update',
            x: this.ship.x,
            y: this.ship.y,
            rotation: this.ship.rotation,
            timestamp: Date.now(),
            playerId: this.clientId
          };
          
          this.webrtcManager.sendWebRTCMessage(positionUpdate);
        }
      }, 50); // Send position updates every 50ms via WebRTC
    };
    
    // Enhanced cleanup method
    const originalShutdown = scene.shutdown;
    scene.shutdown = function() {
      console.log('Shutting down hybrid networking...');
      
      if (this.positionBroadcastInterval) {
        clearInterval(this.positionBroadcastInterval);
      }
      
      if (this.webrtcManager) {
        this.webrtcManager.cleanup();
      }
      
      // Call original shutdown
      if (originalShutdown) {
        originalShutdown.call(this);
      }
    };
    
    // Add networking stats display
    scene.updateNetworkingStats = function() {
      if (this.webrtcManager) {
        const stats = this.webrtcManager.getStats();
        
        if (this.networkStatsText) {
          this.networkStatsText.setText(
            `WebRTC: ${stats.activeChannels}/${stats.peerCount} peers\n` +
            `WebSocket: ${this.socket?.readyState === WebSocket.OPEN ? 'Connected' : 'Disconnected'}`
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