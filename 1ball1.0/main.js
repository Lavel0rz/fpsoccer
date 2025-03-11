class LatencyBuffer {
  constructor(latencyMs) {
    this.latencyMs = latencyMs;
    this.buffer = [];
  }
  
  push(message) {
    const deliveryTime = Date.now() + this.latencyMs;
    this.buffer.push({ message, deliveryTime });
  }
  
  popReady() {
    const now = Date.now();
    const ready = [];
    this.buffer = this.buffer.filter(item => {
      if (item.deliveryTime <= now) {
        ready.push(item.message);
        return false;
      }
      return true;
    });
    return ready;
  }
}

class MainScene extends Phaser.Scene {
  constructor() {
    super({ key: 'MainScene' });
    // Ship and state
    this.ship = null;
    this.predictedState = { x: 400, y: 300 };
    this.serverState = { ship: { x: 400, y: 300, seq: 0 }, boost: 200 };
    this.otherShips = {};
    this.socket = null;
    this.ball = null;
    this.latestBallState = null;
    this.ballHistory = [];
    
    // Input state
    this.inputState = { 
      left: false, 
      right: false, 
      up: false, 
      down: false, 
      shoot: false, 
      boost: false 
    };
    this.inputSequence = 0;
    this.lastInputTime = 0;
    
    // For aiming
    this.aimTarget = { x: 400, y: 300 };
    
    // Player identification
    this.clientId = null;
    this.playerTeam = null;
    this.isHost = false; // Add host status flag
    
    // Game state
    this.team1Score = 0; // Red team score
    this.team2Score = 0; // Blue team score
    
    // Player movement control
    this.playerCanMove = true;
    
    // Tracking previous position for particles
    this.prevShipPos = { x: 400, y: 300 };
    
    // Reconnection handling
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.reconnectDelay = 2000;
    this.pendingReconnect = false; // Track if we have a pending reconnect
    
    // Ping tracking
    this.pingValue = 0;
    this.serverTimeOffset = 0;
    this.pingInterval = null; // For regular pings
    
    // Latency buffer for incoming messages
    this.incomingBuffer = new LatencyBuffer(0);
    
    // Particle emitter flag
    this.particleEmitterCreated = false;
    
    // Ping display.
    this.pingText = null;
    // For shot effect.
    this.shotEffectDuration = 200;
    this.shotCorrection = { x: 0, y: 0 };
    this.minDist = 20;
    // Particle effects.
    this.particles = null;
    this.emitter = null;
    this.mapObjects = [];
    // Ping measurement.
    this.lastPingSent = 0;
    this.ping = 0;
    // Graphics object for boost indicator.
    this.boostCircle = null;
    // Add reconnection tracking
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.reconnectDelay = 2000;
    
    // Add visibility change handler with improved mobile support
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        console.log('Page became visible');
        // If we have a pending reconnect, do it now
        if (this.pendingReconnect) {
          this.pendingReconnect = false;
          this.connectWebSocket();
        }
        // If connection is closed or closing, reconnect
        else if (this.socket && (this.socket.readyState === WebSocket.CLOSED || this.socket.readyState === WebSocket.CLOSING)) {
          this.connectWebSocket();
        }
        // Otherwise, send a ping to check connection
        else if (this.socket && this.socket.readyState === WebSocket.OPEN) {
          this.sendPing();
        }
      } else {
        console.log('Page hidden');
      }
    });
    
    // Add client ID tracking
    this.clientId = null;
    this.particleEmitter = null;
    this.lastInputTime = 0;
    this.pingValue = 0;
    this.team1Score = 0;
    this.team2Score = 0;
    this.playerTeam = null;
    this.particleEmitterCreated = false;
    
    // Detect mobile browser
    this.isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    if (this.isMobile) {
      console.log('Mobile browser detected');
    }
    
    // Add countdown text
    this.countdownText = null;
  }
  
  preload() {
    this.load.image('ship', 'assets/ship.png');
    this.load.image('ship_red', 'assets/ship.png');
    this.load.image('ship_blue', 'assets/ship.png');
    this.load.image('ball', 'assets/ball.png');
    this.load.image('spark', 'assets/ship_blue.png');
    this.load.json('mapData', 'assets/map_data.json');
    this.load.image('wall', 'assets/wall.png');
    this.load.image('goal', 'assets/goal.png');
    this.load.atlas('flares', 'https://labs.phaser.io/assets/particles/flares.png', 'https://labs.phaser.io/assets/particles/flares.json');
  }
  
  create() {
    // Disable context menu so right click can be used for boost.
    this.input.mouse.disableContextMenu();
    
    const mapData = this.cache.json.get('mapData');
    this.mapObjects = mapData;
    
    // Determine the middle Y position to distinguish north from south
    let minY = Infinity;
    let maxY = -Infinity;
    
    // Find the min and max Y coordinates of all goals
    mapData.forEach(obj => {
      if (obj.type === 'goal') {
        minY = Math.min(minY, obj.y);
        maxY = Math.max(maxY, obj.y + obj.height);
      }
    });
    
    // Calculate the middle Y position
    const middleY = (minY + maxY) / 2;
    
    console.log(`Goal Y range: ${minY} to ${maxY}, middle: ${middleY}`);
    
    // Create colored rectangles for goals
    const redGoalColor = 0xff0000;
    const blueGoalColor = 0x0000ff;
    
    // Create map objects with appropriate coloring
    mapData.forEach(obj => {
      let sprite;
      if (obj.type === 'wall') {
        sprite = this.add.image(obj.x + obj.width/2, obj.y + obj.height/2, 'wall')
          .setDisplaySize(obj.width, obj.height)
          .setOrigin(0.5);
      } else if (obj.type === 'goal') {
        // Instead of tinting, create colored rectangles for goals
        const isNorthGoal = obj.y < middleY;
        const goalColor = isNorthGoal ? redGoalColor : blueGoalColor;
        const teamText = isNorthGoal ? "RED" : "BLUE";
        
        console.log(`Creating ${teamText} goal at (${obj.x}, ${obj.y})`);
        
        // Create a colored rectangle for the goal
        sprite = this.add.rectangle(
          obj.x + obj.width/2, 
          obj.y + obj.height/2, 
          obj.width, 
          obj.height, 
          goalColor,
          0.5 // Alpha (semi-transparent)
        ).setOrigin(0.5);
      }
    });

    // Create a background that extends beyond the playable area
    const gameWidth = 2000;
    const gameHeight = 1200;
    const extendedWidth = gameWidth * 2;  // Increase from 1.5 to 2
    const extendedHeight = gameHeight * 2; // Increase from 1.5 to 2
    
    // Create a background grid pattern that extends beyond the map
    this.createBackgroundGrid(extendedWidth, extendedHeight);

    this.ship = this.add.sprite(400, 300, 'ship').setScale(0.09);
    this.ball = this.add.sprite(400, 400, 'ball').setScale(0.55).setOrigin(0.5);
    this.ball.setVisible(false);
    this.gravityCircle = this.add.graphics();
    
    // Create boost circle graphics
    this.boostCircle = this.add.graphics();
    
    // Create UI elements
    this.pingText = this.add.text(10, 10, "Ping: -- ms", { font: "16px Arial", fill: "#ffffff" }).setScrollFactor(0);
    
    // Create score display with multiple text objects for different colors
    const scoreY = 40;
    this.scoreLabel = this.add.text(10, scoreY, "Score: ", { font: "16px Arial", fill: "#ffffff" }).setScrollFactor(0);
    this.redScoreText = this.add.text(this.scoreLabel.x + this.scoreLabel.width, scoreY, "0", { font: "16px Arial", fill: "#ff0000" }).setScrollFactor(0);
    this.scoreSeparator = this.add.text(this.redScoreText.x + this.redScoreText.width, scoreY, " - ", { font: "16px Arial", fill: "#ffffff" }).setScrollFactor(0);
    this.blueScoreText = this.add.text(this.scoreSeparator.x + this.scoreSeparator.width, scoreY, "0", { font: "16px Arial", fill: "#0000ff" }).setScrollFactor(0);
    
    this.teamText = this.add.text(10, 70, "Team: --", { font: "16px Arial", fill: "#ffffff" }).setScrollFactor(0);
    
    // Get player display name from window object or use default
    const playerName = window.PLAYER_DISPLAY_NAME || 'You';
    
    // Add player name text above ship
    this.playerNameText = this.add.text(400, 270, playerName, 
      { fontSize: '14px', fill: '#fff', stroke: '#000', strokeThickness: 3 }
    ).setOrigin(0.5);
    
    // Try to create minimap with safety checks
    try {
      // Create minimap camera in the top right corner
      this.minimap = this.cameras.add(this.sys.game.config.width - 210, 10, 200, 150)
        .setZoom(200 / 2000)
        .setName('minimap');
      
      if (this.minimap) {
        this.minimap.setBounds(0, 0, extendedWidth, extendedHeight);
        this.minimap.setBackgroundColor(0x002244);
        
        // Delay the ignore call to ensure all elements are initialized
        this.time.delayedCall(200, () => {
          try {
            // Create an array of elements to ignore, filtering out any undefined ones
            const elementsToIgnore = [
              this.pingText, 
              this.scoreLabel, this.redScoreText, this.scoreSeparator, this.blueScoreText,
              this.teamText, 
              this.boostCircle, 
              this.playerNameText
            ].filter(element => element !== undefined);
            
            // Only call ignore if we have elements to ignore and minimap exists
            if (elementsToIgnore.length > 0 && this.minimap && typeof this.minimap.ignore === 'function') {
              this.minimap.ignore(elementsToIgnore);
            }
          } catch (error) {
            console.error('Error setting up minimap ignore:', error);
          }
        });
      }
    } catch (error) {
      console.error('Error creating minimap:', error);
    }
    
    // Set up main camera to follow the ship with improved settings
    this.cameras.main.startFollow(this.ship, true, 0.05, 0.05);
    
    // Set camera bounds to be much larger than the playable area to ensure consistent following
    // Use negative values to allow camera to move beyond all edges
    this.cameras.main.setBounds(-gameWidth/2, -gameHeight/2, extendedWidth, extendedHeight);
    
    // Add a slight offset to the camera to make the ship not perfectly centered
    this.cameras.main.followOffset.set(-50, -50);
    
    // Create particle emitter for ship movement
    this.particleEmitter = this.add.particles(0, 0, 'flares', {
      frame: 'white',
      lifespan: 50,
      angle: { min: 0, max: 360 },
      scale: { start: 0.1, end: 0, ease: 'flares' },
      speed: { min: 200, max: 300 },
      advance: 1000,
      blendMode: 'ADD'
    });
    
    // Hide and stop the emitter
    this.particleEmitter.on = false;
    
    this.prevShipPos.x = this.ship.x;
    this.prevShipPos.y = this.ship.y;
    
    // Connect to WebSocket server
    this.connectWebSocket();
    
    // Set up keyboard input
    this.input.keyboard.on('keydown', (event) => {
      const key = event.key.toLowerCase();
      this.updateInputState(key, true);
    });
    
    this.input.keyboard.on('keyup', (event) => {
      const key = event.key.toLowerCase();
      this.updateInputState(key, false);
    });
    
    // Set up mouse input for aiming and shooting
    this.input.on('pointerdown', (pointer) => {
      if (pointer.leftButtonDown()) {
        this.updateInputState('shoot', true);
      }
      if (pointer.rightButtonDown()) {
        this.updateInputState('boost', true);
      }
      
      const worldPoint = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
      this.aimTarget.x = worldPoint.x;
      this.aimTarget.y = worldPoint.y;
      this.sendInput();
    });
    
    this.input.on('pointerup', (pointer) => {
      if (!pointer.leftButtonDown()) {
        this.updateInputState('shoot', false);
      }
      if (!pointer.rightButtonDown()) {
        this.updateInputState('boost', false);
      }
    });
    
    this.input.on('pointermove', (pointer) => {
      const worldPoint = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
      this.aimTarget.x = worldPoint.x;
      this.aimTarget.y = worldPoint.y;
      if (pointer.leftButtonDown()) {
        this.sendInput();
      }
    });
    
    // Start sending ping messages every second.
    this.time.addEvent({
      delay: 1000,
      loop: true,
      callback: () => {
        this.sendPing();
      }
    });
    
    // Make the game instance accessible globally for team switching
    window.gameInstance = this;
    console.log('Game instance set to window.gameInstance');
    
    // Set up ping interval
    this.pingInterval = setInterval(() => {
      this.sendPing();
    }, 2000); // Send ping every 2 seconds
    
    // Handle window resize
    this.scale.on('resize', this.handleResize, this);
    
    // Add countdown text
    this.countdownText = this.add.text(this.cameras.main.width / 2, 100, '', {
      fontFamily: 'Arial',
      fontSize: 64,
      color: '#ffffff',
      stroke: '#000000',
      strokeThickness: 6,
      align: 'center'
    }).setOrigin(0.5).setDepth(1000).setVisible(false);
  }
  
  updateInputState(key, isDown) {
    // Map keys to input state properties
    if (key === 'w' || key === 'arrowup') {
      this.inputState.up = isDown;
    } else if (key === 's' || key === 'arrowdown') {
      this.inputState.down = isDown;
    } else if (key === 'a' || key === 'arrowleft') {
      this.inputState.left = isDown;
    } else if (key === 'd' || key === 'arrowright') {
      this.inputState.right = isDown;
    } else if (key === 'shoot') {
      this.inputState.shoot = isDown;
    } else if (key === 'boost' || key === 'shift') {
      this.inputState.boost = isDown;
    }
    
    // Send updated input to server
    this.sendInput();
  }
  
  sendInput() {
    // Only send input if player can move and socket is connected
    if (this.playerCanMove !== false && this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.inputSequence++;
      const input = {
        left: this.inputState.left,
        right: this.inputState.right,
        up: this.inputState.up,
        down: this.inputState.down,
        shoot: this.inputState.shoot,
        boost: this.inputState.boost,
        seq: this.inputSequence,
        target_x: this.aimTarget.x,
        target_y: this.aimTarget.y,
        display_name: window.PLAYER_DISPLAY_NAME || 'Player'
      };
      
      this.socket.send(JSON.stringify(input));
      this.lastInputTime = Date.now();
    }
  }
  
  sendPing() {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      const pingMsg = {
        type: "ping",
        timestamp: Date.now()
      };
      this.socket.send(JSON.stringify(pingMsg));
    }
  }
  
  connectWebSocket() {
    console.log('Attempting to connect to WebSocket...');
    
    // Update connection status if the element exists
    const connectionStatus = document.getElementById('connection-status');
    if (connectionStatus) {
      connectionStatus.textContent = 'Connecting to game server...';
      connectionStatus.className = 'connecting';
    }
    
    // Clear existing game state on reconnect
    this.otherShips = {};
    this.ballHistory = [];
    this.latestBallState = null;
    
    // Use the WebSocket URL from the game.html page if available
    const wsUrl = window.WEBSOCKET_URL || 'wss://towerup.io/ws';
    console.log('Connecting to WebSocket URL:', wsUrl);
    
    // Close existing socket if it exists
    if (this.socket && this.socket.readyState !== WebSocket.CLOSED) {
      this.socket.close();
    }
    
    this.socket = new WebSocket(wsUrl);
    
    // Set connection timeout
    const connectionTimeout = setTimeout(() => {
      if (this.socket.readyState !== WebSocket.OPEN) {
        console.error('WebSocket connection timeout');
        this.socket.close();
        
        if (connectionStatus) {
          connectionStatus.textContent = 'Connection timeout. Retrying...';
          connectionStatus.className = 'error';
        }
      }
    }, 5000);
    
    this.socket.addEventListener('open', () => {
      console.log('WebSocket connection opened successfully');
      clearTimeout(connectionTimeout);
      
      // Reset reconnection attempts on successful connection
      this.reconnectAttempts = 0;
      
      if (connectionStatus) {
        connectionStatus.textContent = 'Connected to game server';
        connectionStatus.className = 'connected';
        
        // Hide the status after a few seconds
        setTimeout(() => {
          connectionStatus.style.opacity = '0';
        }, 3000);
      }
      
      // Start sending regular pings to keep the connection alive (especially for mobile)
      if (this.pingInterval) {
        clearInterval(this.pingInterval);
      }
      this.pingInterval = setInterval(() => {
        this.sendPing();
      }, 15000); // Send a ping every 15 seconds
      
      // Send an initial ping to test the connection
      this.sendPing();
    });
    
    this.socket.addEventListener('message', (event) => {
      try {
        // Handle simple text messages
        if (event.data === 'ping') {
          this.socket.send('pong');
          return;
        }
        
        // Handle simple "connected" message
        if (event.data === 'connected') {
          console.log('Received connected confirmation from server');
          return;
        }
        
        // Try to parse as JSON
        try {
          const msg = JSON.parse(event.data);
          
          // Handle ping response
          if (msg.type === "pong" && msg.timestamp) {
            this.pingValue = Date.now() - msg.timestamp;
            if (this.pingText) {
              this.pingText.setText("Ping: " + this.pingValue + " ms");
            }
            return;
          }
          
          // Handle heartbeat message
          if (msg.type === "heartbeat") {
            // Just acknowledge receipt by sending a ping
            this.sendPing();
            return;
          }
          
          // Handle player ID assignment and host status
          if (msg.type === 'init') {
            // If we already had an ID and it's different, reload the page
            if (this.clientId && this.clientId !== msg.your_id) {
              console.log('Received new client ID, reloading...');
              window.location.reload();
              return;
            }
            
            this.clientId = msg.your_id;
            this.playerTeam = msg.team;
            this.isHost = msg.is_host;
            console.log('Assigned client ID:', this.clientId, 'Team:', this.playerTeam, 'Host:', this.isHost);
            
            // Update team text and ship color
            this.updateTeamDisplay();
            if (this.playerTeam === 'red') {
              this.ship.setTint(0xff0000);
            } else if (this.playerTeam === 'blue') {
              this.ship.setTint(0x0000ff);
            }
            
            // Show/hide reset button based on host status
            this.updateResetButtonVisibility();
            
            return;
          }
          
          // Handle error messages
          if (msg.type === 'error') {
            this.showNotification(msg.message, true);
            return;
          }
          
          // Handle goal event
          if (msg.type === "goal") {
            this.team1Score = msg.team1_score;
            this.team2Score = msg.team2_score;
            this.updateScoreDisplay();
            
            // Show goal animation with team color
            const scorerTeam = msg.scorer_team;
            this.showGoalAnimation(scorerTeam);
            return;
          }
          
          // Handle countdown message
          if (msg.type === 'countdown') {
            this.handleCountdown(msg.count);
            return;
          }
          
          // Handle game reset message
          if (msg.type === 'game_reset') {
            this.handleGameReset(msg);
            return;
          }
          
          // If we got here, it's a game state update
          this.incomingBuffer.push(event.data);
        } catch (jsonError) {
          console.log('Received non-JSON message:', event.data);
        }
      } catch (e) {
        console.error('Error handling WebSocket message:', e);
      }
    });
    
    this.socket.addEventListener('close', (event) => {
      console.log('WebSocket connection closed', event.code, event.reason);
      clearTimeout(connectionTimeout);
      
      // Clear ping interval
      if (this.pingInterval) {
        clearInterval(this.pingInterval);
        this.pingInterval = null;
      }
      
      if (connectionStatus) {
        connectionStatus.textContent = 'Connection lost. Reconnecting...';
        connectionStatus.className = 'error';
        connectionStatus.style.opacity = '1';
      }
      
      // Try to reconnect with exponential backoff
      const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
      this.reconnectAttempts++;
      
      console.log(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
      
      setTimeout(() => {
        if (document.visibilityState === 'visible') {
          this.connectWebSocket();
        } else {
          // If page is not visible, wait until it becomes visible
          this.pendingReconnect = true;
        }
      }, delay);
    });
    
    this.socket.addEventListener('error', (error) => {
      console.error('WebSocket error:', error);
      
      if (connectionStatus) {
        connectionStatus.textContent = 'Connection error. Retrying...';
        connectionStatus.className = 'error';
        connectionStatus.style.opacity = '1';
      }
    });
  }
  
  updateRemoteShips(localTime) {
    const renderTime = localTime - this.serverTimeOffset - 50;
    
    for (const id in this.otherShips) {
      const sprite = this.otherShips[id];
      if (sprite.history && sprite.history.length >= 2) {
        let older = sprite.history[0];
        let newer = sprite.history[1];
        
        for (let i = 0; i < sprite.history.length - 1; i++) {
          if (sprite.history[i].timestamp <= renderTime &&
              sprite.history[i + 1].timestamp >= renderTime) {
            older = sprite.history[i];
            newer = sprite.history[i + 1];
            break;
          }
        }
        
        const deltaT = newer.timestamp - older.timestamp;
        const t = Phaser.Math.Clamp((renderTime - older.timestamp) / deltaT, 0, 1);
        const targetX = Phaser.Math.Linear(older.x, newer.x, t);
        const targetY = Phaser.Math.Linear(older.y, newer.y, t);
        const smoothingFactor = 0.1;
        sprite.x = Phaser.Math.Linear(sprite.x, targetX, smoothingFactor);
        sprite.y = Phaser.Math.Linear(sprite.y, targetY, smoothingFactor);
        
        // Update name text position with smooth interpolation
        if (sprite.nameText) {
          sprite.nameText.x = sprite.x;
          sprite.nameText.y = sprite.y - 30;
        }
        
        // Generate particles for remote ships
        this.generateRemoteShipParticles(sprite, older, newer);
      }
      
      // Update team color if it has changed
      if (sprite.currentTeam !== sprite.team) {
        sprite.currentTeam = sprite.team;
        if (sprite.team === 'Red') {
          sprite.setTint(0xff0000); // Red tint
        } else if (sprite.team === 'Blue') {
          sprite.setTint(0x0000ff); // Blue tint
        }
        console.log(`Updated remote player ${id} team to ${sprite.team}`);
      }
    }
  }

  generateRemoteShipParticles(sprite, older, newer) {
    // Calculate the movement distance
    const distanceMoved = Phaser.Math.Distance.Between(older.x, older.y, newer.x, newer.y);

    // Only generate particles if the ship has moved significantly
    const movementThreshold = 2.5; // Example: Only emit particles if the ship has moved by 5 pixels or more
    if (distanceMoved > movementThreshold) {
        const dx = newer.x - older.x;
        const dy = newer.y - older.y;

        const direction = new Phaser.Math.Vector2(dx, dy).normalize();

        if (direction.length() > 0) {
            // Calculate the opposite direction
            const oppositeDirection = direction.clone().negate();

            // Emit particles in the opposite direction
            const particleX = sprite.x + oppositeDirection.x * 20; // Adjust the multiplier for distance
            const particleY = sprite.y + oppositeDirection.y * 20; // Adjust the multiplier for distance
            this.particleEmitter.emitParticleAt(particleX, particleY);
        }
    }
  }

  updateBall(localTime, delta) {
    if (!this.latestBallState) return;

    // Handle ball grabbing
    if (this.latestBallState.grabbed) {
      if (this.latestBallState.owner === this.clientId) {
        // If we're grabbing the ball, position it at our ship
        this.ball.x = this.predictedState.x;
        this.ball.y = this.predictedState.y;
        this.ball.setDepth(1);
        this.ball.setVisible(true);
        return;
      } else {
        // If another player is grabbing the ball, position it at their ship
        const grabbingSprite = this.otherShips[this.latestBallState.owner];
        if (grabbingSprite) {
          this.ball.x = grabbingSprite.x;
          this.ball.y = grabbingSprite.y;
          this.ball.setDepth(1);
          this.ball.setVisible(true);
          return;
        }
      }
    }

    // If the ball is not grabbed or the grabbing player is not visible,
    // use interpolation for smooth ball movement
    const launchOffset = 20;
    const baseSmoothingFactor = 0.06;  // Adaptive smoothing starts here
    const correctionFactor = 0.1;      // Occasional drift correction
    const historyLimit = 10;           // More updates for better interpolation
    const renderDelay = 150;           // Introduce a slight delay in rendering

    // Maintain a history buffer for ball positions
    if (!this.ballHistory) this.ballHistory = [];
    this.ballHistory.push({
        x: this.latestBallState.x,
        y: this.latestBallState.y,
        timestamp: localTime
    });

    // Remove old updates (keep only the last 'historyLimit' entries)
    while (this.ballHistory.length > historyLimit) {
        this.ballHistory.shift();
    }

    // Apply small client-side delay to smooth interpolation
    const renderTime = localTime - renderDelay;
    let prev = null, curr = null;

    for (let i = 0; i < this.ballHistory.length - 1; i++) {
        if (this.ballHistory[i].timestamp <= renderTime && 
            this.ballHistory[i + 1].timestamp >= renderTime) {
            prev = this.ballHistory[i];
            curr = this.ballHistory[i + 1];
            break;
        }
    }

    if (prev && curr) {
        // Time factor for interpolation
        let t = Phaser.Math.Clamp((renderTime - prev.timestamp) / (curr.timestamp - prev.timestamp), 0, 1);

        // Apply Spline Interpolation for smoother curves
        let targetX = Phaser.Math.Interpolation.CatmullRom([prev.x, curr.x], t);
        let targetY = Phaser.Math.Interpolation.CatmullRom([prev.y, curr.y], t);
        
        // Adaptive smoothing based on ball speed
        let speed = Math.sqrt((curr.x - prev.x) ** 2 + (curr.y - prev.y) ** 2);
        let dynamicSmoothing = speed < 5 ? 0.15 : baseSmoothingFactor;

        this.ball.x = Phaser.Math.Linear(this.ball.x, targetX, dynamicSmoothing);
        this.ball.y = Phaser.Math.Linear(this.ball.y, targetY, dynamicSmoothing);
        this.ball.setDepth(0);
        this.ball.setVisible(true);
    }

    // Final correction every 80ms to ensure accuracy
    this.time.delayedCall(80, () => {
        if (this.latestBallState && !this.latestBallState.grabbed) {
            this.ball.x = Phaser.Math.Linear(this.ball.x, this.latestBallState.x, correctionFactor);
            this.ball.y = Phaser.Math.Linear(this.ball.y, this.latestBallState.y, correctionFactor);
        }
    }, [], this);
  }

  generateParticles() {
    const dx = this.inputState.left - this.inputState.right;
    const dy = this.inputState.up - this.inputState.down;
    const direction = new Phaser.Math.Vector2(dx, dy).normalize();

    if (direction.length() > 0) {
      // Calculate the opposite direction
      const oppositeDirection = direction.clone().negate();

      // Emit particles in the opposite direction
      const particleX = this.ship.x - oppositeDirection.x * 20;
      const particleY = this.ship.y - oppositeDirection.y * 20;
      
      // Use the particle emitter
      if (this.particleEmitter) {
        this.particleEmitter.emitParticleAt(particleX, particleY);
      }
    }
  }

  update(time, delta) {
    const dt = delta / 1000;
    const shipSpeed = 100;
    
    // Client-side prediction - update predicted position based on input
    // Only process input if player can move (not during countdown)
    if (this.playerCanMove !== false) {
      if (this.inputState.left) { this.predictedState.x -= shipSpeed * dt; }
      if (this.inputState.right) { this.predictedState.x += shipSpeed * dt; }
      if (this.inputState.up) { this.predictedState.y -= shipSpeed * dt; }
      if (this.inputState.down) { this.predictedState.y += shipSpeed * dt; }
    }
    
    // Server reconciliation - smoothly correct client prediction errors
    let diffX = 0, diffY = 0;
    if (this.serverState.ship) {
      diffX = this.serverState.ship.x - this.predictedState.x;
      diffY = this.serverState.ship.y - this.predictedState.y;
    }
    const dist = Math.sqrt(diffX * diffX + diffY * diffY);
    const baseAlpha = 0.1;
    const impulseThreshold = 50;
    let alpha = baseAlpha;
    if (dist > impulseThreshold) { alpha = 0.02; }
    
    // Interpolate between predicted and server state
    this.predictedState.x = Phaser.Math.Linear(
      this.predictedState.x,
      this.serverState.ship ? this.serverState.ship.x : this.predictedState.x,
      alpha
    );
    this.predictedState.y = Phaser.Math.Linear(
      this.predictedState.y,
      this.serverState.ship ? this.serverState.ship.y : this.predictedState.y,
      alpha
    );
    
    // Update ship position based on predicted state
    this.ship.x = this.predictedState.x;
    this.ship.y = this.predictedState.y;
    
    // Update player name position
    if (this.playerNameText) {
      this.playerNameText.x = this.ship.x;
      this.playerNameText.y = this.ship.y - 30;
    }
    
    // Update boost circle
    this.updateBoostCircle();
    
    // Process incoming messages from server
    const messages = this.incomingBuffer.popReady();
    messages.forEach(data => {
      try {
        const msg = JSON.parse(data);
        
        // Handle ping response
        if (msg.type === "pong" && msg.timestamp) {
          this.pingValue = Date.now() - msg.timestamp;
          this.pingText.setText("Ping: " + this.pingValue + " ms");
          return;
        }
        
        // Handle player ID assignment
        if (msg.your_id !== undefined && this.clientId === null) {
          this.clientId = msg.your_id;
          console.log('Assigned player id:', this.clientId);
          return;
        }
        
        // Handle goal event
        if (msg.type === "goal") {
          this.serverState.team1_score = msg.team1_score;
          this.serverState.team2_score = msg.team2_score;
          this.updateScoreDisplay();
          
          // Show goal animation with team color
          const scorerTeam = msg.scorer_team;
          this.showGoalAnimation(scorerTeam);
          return;
        }
        
        // Handle game state update
        const serverTimestamp = msg.time;
        if (!this.serverTimeOffset && serverTimestamp) {
          this.serverTimeOffset = this.time.now - serverTimestamp;
        }
        
        // Update player positions
        if (msg.players) {
          // Update our own ship from server
          if (msg.players[this.clientId]) {
            this.serverState.ship = msg.players[this.clientId];
            this.serverState.boost = msg.players[this.clientId].boost;
            
            // Update our own name display
            if (this.playerNameText && msg.players[this.clientId].display_name) {
              this.playerNameText.setText(msg.players[this.clientId].display_name);
            }
            
            // Update ship color based on team
            if (msg.players[this.clientId].team) {
              if (msg.players[this.clientId].team === 'Red') {
                this.ship.setTint(0xff0000); // Red tint
              } else if (msg.players[this.clientId].team === 'Blue') {
                this.ship.setTint(0x0000ff); // Blue tint
              }
              
              // Update team display
              this.updateTeamDisplay(msg.players[this.clientId].team);
            }
          }
          
          // Update other ships
          for (const id in msg.players) {
            if (id == this.clientId) continue; // Skip our own ship
            
            const shipState = msg.players[id];
            if (!this.otherShips[id]) {
              // Create new ship sprite
              const sprite = this.add.sprite(shipState.x, shipState.y, 'ship')
                .setScale(0.09)
                .setOrigin(0.5);
              
              // Set ship color based on team
              if (shipState.team === 'Red') {
                sprite.setTint(0xff0000); // Red tint
              } else if (shipState.team === 'Blue') {
                sprite.setTint(0x0000ff); // Blue tint
              }
              
              // Store the current team for change detection
              sprite.team = shipState.team;
              sprite.currentTeam = shipState.team;
              
              // Add player name text above ship
              const nameText = this.add.text(shipState.x, shipState.y - 30, 
                shipState.display_name || `Player ${id}`, 
                { fontSize: '14px', fill: '#fff', stroke: '#000', strokeThickness: 3 }
              ).setOrigin(0.5);
              
              sprite.nameText = nameText;
              sprite.history = [{ x: shipState.x, y: shipState.y, timestamp: serverTimestamp }];
              this.otherShips[id] = sprite;
            } else {
              // Update existing ship
              const sprite = this.otherShips[id];
              
              // Update player name if it changed
              if (sprite.nameText) {
                sprite.nameText.setText(shipState.display_name || `Player ${id}`);
              }
              
              // Update team if it changed
              sprite.team = shipState.team;
              
              if (!sprite.history) sprite.history = [];
              sprite.history.push({ x: shipState.x, y: shipState.y, timestamp: serverTimestamp });
              if (sprite.history.length > 2) sprite.history.shift();
            }
          }
          
          // Clean up ships that are no longer in the game state
          for (const id in this.otherShips) {
            if (!msg.players[id]) {
              // Remove ship that's no longer in the game
              if (this.otherShips[id].nameText) {
                this.otherShips[id].nameText.destroy();
              }
              this.otherShips[id].destroy();
              delete this.otherShips[id];
            }
          }
        }
        
        // Update ball state
        if (msg.ball) {
          if (msg.ball.active) {
            msg.ball.timestamp = serverTimestamp;
            this.latestBallState = msg.ball;
            
            // Store ball properties for use in updateBoostCircle
            if (!this.ball) {
              this.ball = this.add.sprite(400, 300, 'ball');
              this.ball.setDepth(5);
            }
            this.ball.grabbed = msg.ball.grabbed;
            this.ball.owner = msg.ball.owner;
            
            // Debug log for ball owner
            console.log('Ball owner:', msg.ball.owner, 'Client ID:', this.clientId);
            
            if (!this.ballHistory) this.ballHistory = [];
            this.ballHistory.push(msg.ball);
            if (this.ballHistory.length > 10) this.ballHistory.shift();
            
            // Make the ball visible if it wasn't already
            if (!this.ball.visible) {
              this.ball.setVisible(true);
            }
          } else {
            this.ballHistory = [];
            this.latestBallState = null;
            
            // Hide the ball
            if (this.ball && this.ball.visible) {
              this.ball.setVisible(false);
            }
          }
        }
        
        // Update scores
        if (msg.team1_score !== undefined && msg.team2_score !== undefined) {
          this.serverState.team1_score = msg.team1_score;
          this.serverState.team2_score = msg.team2_score;
          this.updateScoreDisplay();
        }
      } catch (error) {
        console.error('Error processing message:', error);
      }
    });
    
    // Update other ships
    this.updateRemoteShips(time);
    
    // Update ball position
    this.updateBall(time, delta);
    
    // Generate particles
    this.generateParticles();
    
    // Update camera position
    this.updateCamera();
  }

  // Update the score display
  updateScoreDisplay() {
    if (this.serverState.team1_score !== undefined && this.serverState.team2_score !== undefined) {
      // Update the individual score text objects
      this.redScoreText.setText(this.serverState.team1_score.toString());
      this.blueScoreText.setText(this.serverState.team2_score.toString());
      
      // Reposition the elements to account for changing text widths
      this.scoreSeparator.x = this.redScoreText.x + this.redScoreText.width;
      this.blueScoreText.x = this.scoreSeparator.x + this.scoreSeparator.width;
    }
  }
  
  // Update the updateTeamDisplay method to handle both formats of team names
  updateTeamDisplay(team) {
    if (team) {
      // Normalize team name format (could be 'Red'/'Blue' or 'red'/'blue')
      const normalizedTeam = typeof team === 'string' ? team.toLowerCase() : team;
      const displayTeam = typeof team === 'string' ? team : (normalizedTeam === 'red' ? 'Red' : 'Blue');
      
      console.log(`Updating team display to: ${displayTeam} (normalized: ${normalizedTeam})`);
      
      this.teamText.setText(`Team: ${displayTeam}`);
      
      // Set color based on team
      const teamColor = normalizedTeam === 'red' ? '#ff0000' : '#0000ff';
      this.teamText.setStyle({ font: "16px Arial", fill: teamColor });
      
      // Store the current team
      this.playerTeam = normalizedTeam;
    }
  }
  
  // Add method to show goal animation
  showGoalAnimation(scorerTeam) {
    console.log(`Showing goal animation for team: ${scorerTeam}`);
    
    // Normalize team name
    const normalizedTeam = typeof scorerTeam === 'string' ? scorerTeam.toLowerCase() : scorerTeam;
    
    // Create a goal text that fades out
    const teamColor = normalizedTeam === 'red' ? '#ff0000' : '#0000ff';
    const opposingTeam = normalizedTeam === 'red' ? 'BLUE' : 'RED';
    const opposingColor = normalizedTeam === 'red' ? '#0000ff' : '#ff0000';
    
    // Create a background rectangle for better visibility
    const bgRect = this.add.rectangle(
      this.cameras.main.centerX,
      this.cameras.main.centerY,
      600,
      150,
      0x000000,
      0.7
    ).setScrollFactor(0).setOrigin(0.5);
    
    // Create the main goal text
    const goalText = this.add.text(
      this.cameras.main.centerX, 
      this.cameras.main.centerY - 20, 
      `GOAL!`, 
      { font: 'bold 48px Arial', fill: '#ffffff', align: 'center' }
    ).setOrigin(0.5).setScrollFactor(0);
    
    // Create the team scored text
    const teamText = this.add.text(
      this.cameras.main.centerX, 
      this.cameras.main.centerY + 30, 
      `${normalizedTeam.toUpperCase()} TEAM SCORED`, 
      { font: 'bold 32px Arial', fill: teamColor, align: 'center' }
    ).setOrigin(0.5).setScrollFactor(0);
    
    // Add a tween to make the text and background fade out
    this.tweens.add({
      targets: [bgRect, goalText, teamText],
      alpha: 0,
      y: '-=50',
      duration: 2000,
      ease: 'Power2',
      onComplete: () => {
        bgRect.destroy();
        goalText.destroy();
        teamText.destroy();
      }
    });
  }

  updateBoostCircle() {
    // Draw a circular boost indicator around the ship
    this.boostCircle.clear();
    
    // Only show the boost circle if this player has the ball
    if (this.latestBallState && this.latestBallState.grabbed && this.latestBallState.owner === this.clientId) {
      // Get boost value from server state
      let boostRatio = this.serverState.boost !== undefined ? (this.serverState.boost / 200) : 1;
      
      // Draw the circle with an arc: start at -90 deg (top)
      let startAngle = Phaser.Math.DegToRad(-90);
      let endAngle = startAngle + boostRatio * Phaser.Math.DegToRad(360);
      
      // Draw a green arc if boost is available; gray otherwise
      const boostColor = boostRatio > 0.2 ? 0x00ff00 : 0x888888;
      this.boostCircle.lineStyle(4, boostColor, 1);
      this.boostCircle.beginPath();
      this.boostCircle.arc(this.ship.x, this.ship.y, 40, startAngle, endAngle, false);
      this.boostCircle.strokePath();
    }
  }

  shutdown() {
    // Clean up WebSocket connection
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.close();
    }
    
    // Clean up ping interval
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
    }
    
    // Clean up other ships and their name texts
    for (const id in this.otherShips) {
      if (this.otherShips[id].nameText) {
        this.otherShips[id].nameText.destroy();
      }
      this.otherShips[id].destroy();
    }
    
    // Clean up player name text
    if (this.playerNameText) {
      this.playerNameText.destroy();
    }
    
    // Clean up UI elements
    if (this.scoreLabel) this.scoreLabel.destroy();
    if (this.redScoreText) this.redScoreText.destroy();
    if (this.scoreSeparator) this.scoreSeparator.destroy();
    if (this.blueScoreText) this.blueScoreText.destroy();
    
    // Remove resize listener
    this.scale.off('resize', this.handleResize, this);
    
    this.otherShips = {};
  }

  // Add team switching method
  switchTeam(team) {
    console.log(`Switching to team: ${team}`);
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      const message = {
        type: 'switch_team',
        team: team
      };
      this.socket.send(JSON.stringify(message));
      this.updateTeamDisplay(team);
    } else {
      console.error('Socket not available for team switch');
    }
  }
  
  resetGame() {
    console.log('Requesting game reset');
    if (!this.isHost) {
      this.showNotification('Only the host can reset the game', true);
      return;
    }
    
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      const message = {
        type: 'reset_game'
      };
      this.socket.send(JSON.stringify(message));
    } else {
      console.error('Socket not available for game reset');
    }
  }

  // Handle window resize
  handleResize(gameSize) {
    // Reposition minimap to top right corner with safety checks
    if (this.minimap && typeof this.minimap.x !== 'undefined') {
      try {
        this.minimap.x = gameSize.width - 210;
        this.minimap.y = 10;
      } catch (error) {
        console.error('Error repositioning minimap:', error);
      }
    }
  }

  // Add a new method to create a background grid
  createBackgroundGrid(width, height) {
    const graphics = this.add.graphics();
    
    // Set line style for the grid
    graphics.lineStyle(1, 0x333333, 0.3);
    
    // Draw vertical lines
    for (let x = 0; x <= width; x += 100) {
      graphics.moveTo(x, 0);
      graphics.lineTo(x, height);
    }
    
    // Draw horizontal lines
    for (let y = 0; y <= height; y += 100) {
      graphics.moveTo(0, y);
      graphics.lineTo(width, y);
    }
    
    // Draw the grid
    graphics.strokePath();
    
    // Set depth to ensure it's behind everything else
    graphics.setDepth(-100);
  }
  
  // Add a new method to update camera position with dynamic offset
  updateCamera() {
    if (!this.ship) return;
    
    // Use a fixed offset instead of one that changes with velocity
    const fixedOffsetX = -50;
    const fixedOffsetY = -50;
    
    // Apply the fixed offset
    this.cameras.main.followOffset.set(fixedOffsetX, fixedOffsetY);
    
    // Debug info
    if (this.debugText) {
      this.debugText.setText(
        `Ship: (${Math.round(this.ship.x)}, ${Math.round(this.ship.y)})\n` +
        `Camera: (${Math.round(this.cameras.main.scrollX)}, ${Math.round(this.cameras.main.scrollY)})\n` +
        `Offset: (${Math.round(this.cameras.main.followOffset.x)}, ${Math.round(this.cameras.main.followOffset.y)})`
      );
    }
  }

  // Add method to handle countdown
  handleCountdown(count) {
    if (count > 0) {
      // Show countdown
      this.countdownText.setText(`${count}`);
      this.countdownText.setVisible(true);
      
      // Disable player movement during countdown
      this.playerCanMove = false;
    } else {
      // Hide countdown and enable movement
      this.countdownText.setVisible(false);
      this.playerCanMove = true;
    }
  }
  
  // Add method to handle game reset
  handleGameReset(message) {
    // Update scores
    this.team1Score = message.team1_score;
    this.team2Score = message.team2_score;
    this.updateScoreDisplay();
    
    // Show reset notification
    this.showNotification('Game has been reset!', false);
  }
  
  // Add method to show notifications
  showNotification(message, isError = false) {
    // Create notification container if it doesn't exist
    if (!this.notificationContainer) {
      this.notificationContainer = this.add.container(this.cameras.main.width / 2, 150);
      this.notificationContainer.setDepth(1000);
    }
    
    // Clear any existing notifications
    this.notificationContainer.removeAll(true);
    
    // Create background
    const bgColor = isError ? 0xff0000 : 0x00aa00;
    const bg = this.add.graphics();
    bg.fillStyle(bgColor, 0.8);
    bg.fillRoundedRect(-200, -20, 400, 40, 10);
    
    // Create text
    const text = this.add.text(0, 0, message, {
      fontFamily: 'Arial',
      fontSize: 16,
      color: '#ffffff',
      align: 'center'
    }).setOrigin(0.5);
    
    // Add to container
    this.notificationContainer.add([bg, text]);
    
    // Auto-hide after 3 seconds
    this.time.delayedCall(3000, () => {
      this.notificationContainer.removeAll(true);
    });
  }

  // Add method to update reset button visibility
  updateResetButtonVisibility() {
    const resetButton = document.getElementById('reset-game');
    if (resetButton) {
      resetButton.style.display = this.isHost ? 'block' : 'none';
      console.log(`Reset button visibility set to ${this.isHost ? 'visible' : 'hidden'}`);
    }
  }
}
  
const config = {
  type: Phaser.WEBGL,
  width: 1600,
  height: 1200,
  parent: 'game-container',
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH
  },
  physics: {
    default: 'arcade',
    arcade: { gravity: { y: 0 }, debug: false }
  },
  scene: MainScene
};
  
new Phaser.Game(config);