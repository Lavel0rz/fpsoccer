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
    
    // Game state
    this.team1Score = 0; // Red team score
    this.team2Score = 0; // Blue team score
    
    // Tracking previous position for particles
    this.prevShipPos = { x: 400, y: 300 };
    
    // Reconnection handling
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.reconnectDelay = 2000;
    
    // Ping tracking
    this.pingValue = 0;
    this.serverTimeOffset = 0;
    
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
    // Add visibility change handler
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && 
          (!this.socket || this.socket.readyState !== WebSocket.OPEN)) {
        this.connectWebSocket();
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

    this.ship = this.add.sprite(400, 300, 'ship').setScale(0.09).setOrigin(0.5);
    this.ball = this.add.sprite(400, 400, 'ball').setScale(0.55).setOrigin(0.5);
    this.ball.setVisible(false);
    this.gravityCircle = this.add.graphics();
    
    // Create boost circle graphics
    this.boostCircle = this.add.graphics();
    
    // Create ping text
    this.pingText = this.add.text(10, 10, "Ping: -- ms", { font: "16px Arial", fill: "#ffffff" }).setScrollFactor(0);
    
    // Add score text
    this.scoreText = this.add.text(10, 40, "Score: Red 0 - Blue 0", { font: "16px Arial", fill: "#ffffff" }).setScrollFactor(0);
    
    // Add team text
    this.teamText = this.add.text(10, 70, "Team: --", { font: "16px Arial", fill: "#ffffff" }).setScrollFactor(0);
    
    this.minimap = this.cameras.add(1300, 10, 200, 150)
      .setZoom(200 / 2000)
      .setName('minimap');
    this.minimap.setBounds(0, 0, 2000, 1200);
    this.minimap.setBackgroundColor(0x002244);
    this.minimap.ignore([this.pingText, this.scoreText, this.teamText, this.boostCircle]);
    
    this.cameras.main.startFollow(this.ship, true, 0.1, 0.1);
    this.cameras.main.setBounds(0, 0, 6000, 6200);
    
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
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      const input = {
        seq: this.inputSequence,
        left: this.inputState.left,
        right: this.inputState.right,
        up: this.inputState.up,
        down: this.inputState.down,
        shoot: this.inputState.shoot,
        boost: this.inputState.boost,
        target_x: this.aimTarget.x,
        target_y: this.aimTarget.y
      };
      this.socket.send(JSON.stringify(input));
      this.inputSequence++;
    }
  }
  
  sendPing() {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.lastPingSent = Date.now();
      const pingMsg = { type: "ping", timestamp: this.lastPingSent };
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
      
      // Send a ping to test the connection
      this.socket.send(JSON.stringify({ type: "ping", timestamp: Date.now() }));
      console.log('Sent ping to server');
    });
    
    this.socket.addEventListener('message', (event) => {
      try {
        // Handle ping messages
        if (event.data === 'ping') {
          this.socket.send('pong');
          return;
        }
        
        const msg = JSON.parse(event.data);
        
        // Handle initialization message
        if (msg.type === "init") {
          // If we already had an ID and it's different, reload the page
          if (this.clientId && this.clientId !== msg.your_id) {
            console.log('Received new client ID, reloading...');
            window.location.reload();
            return;
          }
          this.clientId = msg.your_id;
          this.playerTeam = msg.team;
          console.log('Assigned client ID:', this.clientId, 'Team:', this.playerTeam);
          
          // Update team text and ship color
          this.updateTeamDisplay();
          if (this.playerTeam === 'red') {
            this.ship.setTint(0xff0000);
          } else if (this.playerTeam === 'blue') {
            this.ship.setTint(0x0000ff);
          }
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
        
        this.incomingBuffer.push(event.data);
      } catch (e) {
        console.error('Failed to parse server message:', e);
      }
    });
    
    this.socket.addEventListener('close', () => {
      console.log('WebSocket connection closed');
      clearTimeout(connectionTimeout);
      
      if (connectionStatus) {
        connectionStatus.textContent = 'Connection lost. Reconnecting...';
        connectionStatus.className = 'error';
        connectionStatus.style.opacity = '1';
      }
      
      // Try to reconnect with exponential backoff
      const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
      this.reconnectAttempts++;
      
      setTimeout(() => {
        if (document.visibilityState === 'visible') {
          this.connectWebSocket();
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

        // Generate particles for remote ships
        this.generateRemoteShipParticles(sprite, older, newer);
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
    if (this.inputState.left) { this.predictedState.x -= shipSpeed * dt; }
    if (this.inputState.right) { this.predictedState.x += shipSpeed * dt; }
    if (this.inputState.up) { this.predictedState.y -= shipSpeed * dt; }
    if (this.inputState.down) { this.predictedState.y += shipSpeed * dt; }
    
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
              
              sprite.history = [{ x: shipState.x, y: shipState.y, timestamp: serverTimestamp }];
              this.otherShips[id] = sprite;
            } else {
              // Update existing ship
              const sprite = this.otherShips[id];
              if (!sprite.history) sprite.history = [];
              sprite.history.push({ x: shipState.x, y: shipState.y, timestamp: serverTimestamp });
              if (sprite.history.length > 2) sprite.history.shift();
            }
          }
          
          // Remove ships that are no longer in the game
          for (const id in this.otherShips) {
            if (!msg.players[id]) {
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
            if (this.ball.visible) {
              this.ball.setVisible(false);
            }
          }
        }
        
        // Update scores
        if (msg.team1_score !== undefined && msg.team2_score !== undefined) {
          this.team1Score = msg.team1_score;
          this.team2Score = msg.team2_score;
          this.updateScoreDisplay();
        }
      } catch (e) {
        console.error('Failed to parse server message:', e);
      }
    });
    
    // Update other ships
    this.updateRemoteShips(time);
    
    // Handle ball rendering based on state
    if (this.latestBallState && this.latestBallState.grabbed) {
      if (this.latestBallState.owner === this.clientId) {
        // If we're grabbing the ball, position it at our ship
        this.ball.x = this.predictedState.x;
        this.ball.y = this.predictedState.y;
        this.ball.setDepth(1);
        this.ball.setVisible(true);
      } else {
        // If another player is grabbing the ball, position it at their ship
        const grabbingSprite = this.otherShips[this.latestBallState.owner];
        if (grabbingSprite) {
          this.ball.x = grabbingSprite.x;
          this.ball.y = grabbingSprite.y;
          this.ball.setDepth(1);
          this.ball.setVisible(true);
        } else if (this.ballHistory.length > 0) {
          // If we can't find the grabbing player, update the ball normally
          this.updateBall(time, delta);
          this.ball.setDepth(0);
          this.ball.setVisible(true);
        } else {
          this.ball.setVisible(false);
        }
      }
    } else if (this.latestBallState) {
      // Normal ball update
      this.updateBall(time, delta);
    }
    
    // Generate particles for player ship if moving
    if (this.inputState.left || this.inputState.right || this.inputState.up || this.inputState.down) {
      this.generateParticles();
    }
    
    // Update aim target based on mouse position
    const pointer = this.input.activePointer;
    const worldPoint = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
    
    // Only update and send if the aim target has changed significantly
    const aimDiffX = Math.abs(this.aimTarget.x - worldPoint.x);
    const aimDiffY = Math.abs(this.aimTarget.y - worldPoint.y);
    if (aimDiffX > 5 || aimDiffY > 5) {
      this.aimTarget.x = worldPoint.x;
      this.aimTarget.y = worldPoint.y;
      this.sendInput();
    }
  }

  // Add method to update score display
  updateScoreDisplay() {
    this.scoreText.setText(`Score: Red ${this.team1Score} - Blue ${this.team2Score}`);
  }
  
  // Add method to update team display
  updateTeamDisplay() {
    if (this.playerTeam) {
      const teamColor = this.playerTeam === 'red' ? '#ff0000' : '#0000ff';
      this.teamText.setText(`Team: ${this.playerTeam.toUpperCase()}`);
      this.teamText.setStyle({ font: "16px Arial", fill: teamColor });
    }
  }
  
  // Add method to show goal animation
  showGoalAnimation(scorerTeam) {
    // Create a goal text that fades out
    const teamColor = scorerTeam === 'red' ? '#ff0000' : '#0000ff';
    const opposingTeam = scorerTeam === 'red' ? 'BLUE' : 'RED';
    const opposingColor = scorerTeam === 'red' ? '#0000ff' : '#ff0000';
    
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
      `${scorerTeam.toUpperCase()} TEAM SCORED`, 
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