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
    // Ship and state.
    this.ship = null;
    this.predictedState = { x: 400, y: 300 };
    this.serverState = { ship: { x: 400, y: 300, seq: 0 } };
    this.otherShips = {};
    this.socket = null;
    this.ball = null;
    this.latestBallState = null;
    this.ballHistory = [];
    // Input state.
    this.inputState = { left: false, right: false, up: false, down: false, shoot: false, boost: false };
    this.inputSequence = 0;
    this.playerId = null;
    this.serverTimeOffset = 0;
    // For continuous aiming.
    this.aimTarget = { x: 400, y: 300 };
    // Remove the bar; we'll use a circular indicator.
    // Ping display.
    this.pingText = null;
    // For shot effect.
    this.shotEffectDuration = 200;
    this.shotCorrection = { x: 0, y: 0 };
    this.minDist = 20;
    // Particle effects.
    this.particles = null;
    this.emitter = null;
    this.prevShipPos = { x: 400, y: 300 };
    this.mapObjects = [];
    // Latency buffer for incoming messages.
    this.incomingBuffer = new LatencyBuffer(0);
    // Ping measurement.
    this.lastPingSent = 0;
    this.ping = 0;
    // Graphics object for boost indicator.
    this.boostCircle = null;
    // Add reconnection tracking
    this.reconnectAttempts = 0;
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
  }
  
  preload() {
    this.load.image('ship', 'assets/ship.png');
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
    mapData.forEach(obj => {
      let sprite;
      if (obj.type === 'wall') {
        sprite = this.add.image(obj.x + obj.width/2, obj.y + obj.height/2, 'wall')
          .setDisplaySize(obj.width, obj.height)
          .setOrigin(0.5);
      } else if (obj.type === 'goal') {
        sprite = this.add.image(obj.x + obj.width/2, obj.y + obj.height/2, 'goal')
          .setDisplaySize(obj.width, obj.height)
          .setOrigin(0.5);
      }
    });

    this.ship = this.add.sprite(400, 300, 'ship').setScale(0.7).setOrigin(0.5);
    this.ball = this.add.sprite(400, 400, 'ball').setScale(0.5).setOrigin(0.5);
    this.ball.setVisible(false);
    this.gravityCircle = this.add.graphics();
    
    // Remove boost bar and text; instead, create a graphics object for circular boost.
    this.boostCircle = this.add.graphics();
    // Also create ping text.
    this.pingText = this.add.text(10, 10, "Ping: -- ms", { font: "16px Arial", fill: "#ffffff" }).setScrollFactor(0);
    
    this.minimap = this.cameras.add(1300, 10, 200, 150)
      .setZoom(200 / 2000)
      .setName('minimap');
    this.minimap.setBounds(0, 0, 2000, 1200);
    this.minimap.setBackgroundColor(0x002244);
    this.minimap.ignore([this.pingText, this.boostCircle]);
    
    this.cameras.main.startFollow(this.ship, true, 0.1, 0.1);
    this.cameras.main.setBounds(0, 0, 6000, 6200);
    
    this.particles = this.add.particles('spark', {
      lifespan: 300,
      speed: { min: 50, max: 100 },
      scale: { start: 0.5, end: 0 },
      blendMode: 'ADD',
      frequency: 50
    });
    this.particles.startFollow(this.ship);
    
    this.prevShipPos.x = this.ship.x;
    this.prevShipPos.y = this.ship.y;
    
    this.connectWebSocket();
    
    // Keyboard input (for movement only now).
    this.input.keyboard.on('keydown-F', () => {
      if (this.scale.isFullscreen) {
        this.scale.stopFullscreen();
      } else {
        this.scale.startFullscreen();
      }
    });
    this.input.keyboard.on('keydown', (event) => {
      const key = event.key.toLowerCase();
      if (["w", "a", "s", "d"].includes(key)) {
        this.updateInputState(key, true);
      }
    });
    this.input.keyboard.on('keyup', (event) => {
      const key = event.key.toLowerCase();
      if (["w", "a", "s", "d"].includes(key)) {
        this.updateInputState(key, false);
      }
    });
    
    // Pointer events: right-click for boost, left-click for shoot.
    this.input.on('pointerdown', (pointer) => {
      if (pointer.button === 2) { // right-click for boost
        this.inputState.boost = true;
        this.sendInput();
      } else if (pointer.leftButtonDown()) {
        this.inputState.shoot = true;
        const worldPoint = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
        this.aimTarget.x = worldPoint.x;
        this.aimTarget.y = worldPoint.y;
        this.sendInput();
      }
    });
    this.input.on('pointerup', (pointer) => {
      if (pointer.button === 2) {
        this.inputState.boost = false;
        this.sendInput();
      } else if (pointer.button === 0) {
        this.inputState.shoot = false;
        this.sendInput();
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

    this.particleEmitter = this.add.particles(0, 0, 'flares', {
      frame: 'white',
      lifespan: 1500,
      angle: { min: -100, max: -80 },
      scale: { start: 0.15, end: 0, ease: 'sine.out' },
      speed: { min: 200, max: 300 },
      advance: 2000,
      blendMode: 'ADD'
    });
  }
  
  updateInputState(key, isDown) {
    if (key === 'w') this.inputState.up = isDown;
    if (key === 's') this.inputState.down = isDown;
    if (key === 'a') this.inputState.left = isDown;
    if (key === 'd') this.inputState.right = isDown;
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
    
    // Clear existing game state on reconnect
    this.otherShips = {};
    this.ballHistory = [];
    this.latestBallState = null;
    
    this.socket = new WebSocket('wss://towerup.io/ws');
    
    this.socket.addEventListener('open', () => {
      console.log('WebSocket connection opened successfully');
      // Reset reconnection attempts on successful connection
      this.reconnectAttempts = 0;
    });
    
    this.socket.addEventListener('message', (event) => {
      try {
        const msg = JSON.parse(event.data);
        
        // Handle ping messages
        if (event.data === 'ping') {
          this.socket.send('pong');
          return;
        }
        
        // Handle initialization message
        if (msg.type === "init") {
          // If we already had an ID and it's different, reload the page
          if (this.clientId && this.clientId !== msg.your_id) {
            console.log('Received new client ID, reloading...');
            window.location.reload();
            return;
          }
          this.clientId = msg.your_id;
          console.log('Assigned client ID:', this.clientId);
          return;
        }
        
        this.incomingBuffer.push(event.data);
      } catch (e) {
        console.error('Failed to parse server message:', e);
      }
    });
    
    this.socket.addEventListener('close', () => {
      console.log('WebSocket connection closed');
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
              sprite.history[i+1].timestamp >= renderTime) {
            older = sprite.history[i];
            newer = sprite.history[i+1];
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
      }
    }
  }
  
  updateBall(localTime, delta) {
    if (!this.latestBallState) return;

    const launchOffset = 20;
    const baseSmoothingFactor = 0.06;  // Adaptive smoothing starts here
    const correctionFactor = 0.1;      // Occasional drift correction
    const historyLimit = 10;            // More updates for better interpolation
    const renderDelay = 150;           // Introduce a slight delay in rendering

    let dx = this.aimTarget.x - this.ship.x;
    let dy = this.aimTarget.y - this.ship.y;
    let mag = Math.sqrt(dx * dx + dy * dy);

    if (mag > 0) {
        dx /= mag;
        dy /= mag;
    }

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
        if (this.ballHistory[i].timestamp <= renderTime && this.ballHistory[i + 1].timestamp >= renderTime) {
            prev = this.ballHistory[i];
            curr = this.ballHistory[i + 1];
            break;
        }
    }

    if (prev && curr) {
        // Time factor for interpolation
        let t = Phaser.Math.Clamp((renderTime - prev.timestamp) / (curr.timestamp - prev.timestamp), 0, 1);

        // Apply **Spline Interpolation** for smoother curves
        let targetX = Phaser.Math.Interpolation.CatmullRom([prev.x, curr.x], t);
        let targetY = Phaser.Math.Interpolation.CatmullRom([prev.y, curr.y], t);

        // Adaptive smoothing based on ball speed
        let speed = Math.sqrt((curr.x - prev.x) ** 2 + (curr.y - prev.y) ** 2);
        let dynamicSmoothing = speed < 5 ? 0.15 : baseSmoothingFactor;

        this.ball.x = Phaser.Math.Linear(this.ball.x, targetX, dynamicSmoothing);
        this.ball.y = Phaser.Math.Linear(this.ball.y, targetY, dynamicSmoothing);
    }

    // Final correction every 80ms to ensure accuracy
    this.time.delayedCall(80, () => {
        this.ball.x = Phaser.Math.Linear(this.ball.x, this.latestBallState.x, correctionFactor);
        this.ball.y = Phaser.Math.Linear(this.ball.y, this.latestBallState.y, correctionFactor);
    }, [], this);
}

  generateParticles() {
    const dx = this.inputState.right - this.inputState.left;
    const dy = this.inputState.down - this.inputState.up;
    const direction = new Phaser.Math.Vector2(dx, dy).normalize();

    if (direction.length() > 0) {
      const particleX = this.ship.x - direction.x * 20;
      const particleY = this.ship.y - direction.y * 20;
      this.particleEmitter.emitParticleAt(particleX, particleY);
    }
  }

  update(time, delta) {
    const dt = delta / 1000;
    const shipSpeed = 100;
    if (this.inputState.left) { this.predictedState.x -= shipSpeed * dt; }
    if (this.inputState.right) { this.predictedState.x += shipSpeed * dt; }
    if (this.inputState.up) { this.predictedState.y -= shipSpeed * dt; }
    if (this.inputState.down) { this.predictedState.y += shipSpeed * dt; }
    
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
    this.ship.x = this.predictedState.x;
    this.ship.y = this.predictedState.y;
    
    // Instead of a bar chart, draw a circular boost indicator around the ship.
    this.boostCircle.clear();
    // For example, the full circle represents 200 boost.
    let boostRatio = this.serverState.boost !== undefined ? (this.serverState.boost / 200) : 1;
    // Draw the circle with an arc: start at -90 deg.
    let startAngle = Phaser.Math.DegToRad(-90);
    let endAngle = startAngle + boostRatio * Phaser.Math.DegToRad(360);
    // Draw a green arc if boost is available; gray otherwise.
    this.boostCircle.lineStyle(4, 0x00ff00, 1);
    this.boostCircle.beginPath();
    this.boostCircle.arc(this.ship.x, this.ship.y, 40, startAngle, endAngle, false);
    this.boostCircle.strokePath();
    
    if (this.serverState.boost !== undefined) {
      // Optionally, hide the old boost bar.
    }
    
    const messages = this.incomingBuffer.popReady();
    messages.forEach(data => {
      try {
        const msg = JSON.parse(data);
        if (msg.type === "pong" && msg.timestamp) {
          this.ping = Date.now() - msg.timestamp;
          this.pingText.setText("Ping: " + this.ping + " ms");
          return;
        }
        if (msg.your_id !== undefined && this.playerId === null) {
          this.playerId = msg.your_id;
          console.log('Assigned player id:', this.playerId);
          return;
        }
        const serverTimestamp = msg.time;
        if (!this.serverTimeOffset && serverTimestamp) {
          this.serverTimeOffset = this.time.now - serverTimestamp;
        }
        if (msg.players) {
          if (msg.players[this.playerId]) {
            this.serverState.ship = msg.players[this.playerId];
            this.serverState.boost = msg.players[this.playerId].boost;
          }
          for (const id in msg.players) {
            if (parseInt(id) === this.playerId) continue;
            const shipState = msg.players[id];
            if (!this.otherShips[id]) {
              const sprite = this.add.sprite(shipState.x, shipState.y, 'ship')
                .setScale(0.5)
                .setOrigin(0.5);
              sprite.history = [{ x: shipState.x, y: shipState.y, timestamp: serverTimestamp }];
              this.otherShips[id] = sprite;
            } else {
              const sprite = this.otherShips[id];
              if (!sprite.history) sprite.history = [];
              sprite.history.push({ x: shipState.x, y: shipState.y, timestamp: serverTimestamp });
              if (sprite.history.length > 2) sprite.history.shift();
            }
          }
          for (const id in this.otherShips) {
            if (!msg.players[id]) {
              this.otherShips[id].destroy();
              delete this.otherShips[id];
            }
          }
        }
        if (msg.ball && msg.ball.active) {
          msg.ball.timestamp = serverTimestamp;
          this.latestBallState = msg.ball;
          this.ballHistory.push(msg.ball);
          if (this.ballHistory.length > 10) this.ballHistory.shift();
        } else {
          this.ballHistory = [];
          this.latestBallState = null;
        }
      } catch (e) {
        console.error('Failed to parse server message:', e);
      }
    });
    
    this.updateRemoteShips(time);
    
    if (this.latestBallState && this.latestBallState.grabbed) {
      if (this.latestBallState.owner === this.playerId) {
        this.ball.x = this.predictedState.x;
        this.ball.y = this.predictedState.y;
        this.ball.setDepth(1);
        this.ball.setVisible(true);
      } else {
        const grabbingSprite = this.otherShips[this.latestBallState.owner];
        if (grabbingSprite) {
          this.ball.x = grabbingSprite.x;
          this.ball.y = grabbingSprite.y;
          this.ball.setDepth(1);
          this.ball.setVisible(true);
        } else if (this.ballHistory.length > 0) {
          this.updateBall(time);
          this.ball.setDepth(0);
          this.ball.setVisible(true);
        } else {
          this.ball.setVisible(false);
        }
      }
    } else if (this.recentShot) {
      const pointer = this.input.activePointer;
      const worldPoint = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
      let dx = worldPoint.x - this.ship.x;
      let dy = worldPoint.y - this.ship.y;
      let mag = Math.sqrt(dx * dx + dy * dy);
      
      // Normalize direction
      if (mag > 0) {
          dx /= mag;
          dy /= mag;
      }

      // Calculate the launch position based on the ship's current position and velocity
      const launchOffset = 50; // Distance to offset the launch position
      const predictedX = this.ship.x + this.ship.body.velocity.x * 0.1 + dx * launchOffset;
      const predictedY = this.ship.y + this.ship.body.velocity.y * 0.1 + dy * launchOffset;

      // Set the ball's position to the predicted position of the ship
      this.ball.x = predictedX;
      this.ball.y = predictedY;
      this.ball.setDepth(1);
      this.ball.setVisible(true);
      
      // Apply a velocity to the ball based on the direction of the shot
      const ballSpeed = 600; // Adjust this value for desired speed

      // Calculate the ball's velocity based on the direction
      this.latestBallState.vx = dx * ballSpeed + this.ship.body.velocity.x;
      this.latestBallState.vy = dy * ballSpeed + this.ship.body.velocity.y;

      // Add shooting animation or effect
      this.ship.setTint(0xff0000); // Change color briefly to indicate shooting
      this.time.delayedCall(100, () => {
          this.ship.clearTint(); // Reset color after delay
      });

      // Reset recent shot flag after a short duration
      if (time - this.shotTime > this.shotEffectDuration) {
          this.recentShot = false;
      }
    } else if (this.ballHistory.length > 0) {
      this.updateBall(time);
      this.ball.setDepth(0);
      this.ball.setVisible(true);
    } else {
      this.ball.setVisible(false);
    }

    if (this.inputState.left || this.inputState.right || this.inputState.up || this.inputState.down) {
      this.generateParticles();
    }
  }
}
  
const config = {
  type: Phaser.WEBGL,
  width: 1600,
  height: 1200,
  physics: {
    default: 'arcade',
    arcade: { gravity: { y: 0 }, debug: false }
  },
  scene: MainScene
};
  
new Phaser.Game(config);
