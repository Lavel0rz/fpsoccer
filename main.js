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
  }
  
  preload() {
    this.load.image('ship', 'assets/ship.png');
    this.load.image('ball', 'assets/ball.png');
    this.load.image('spark', 'assets/ship_blue.png');
    this.load.json('mapData', 'assets/map_data.json');
    this.load.image('wall', 'assets/wall.png');
    this.load.image('goal', 'assets/goal.png');
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
    
    this.cameras.main.startFollow(this.ship);
    this.cameras.main.setBounds(0, 0, 2000, 1200);
    
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
    this.socket = new WebSocket('ws://localhost:8080/ws');
    this.socket.addEventListener('open', () => {
      console.log('WebSocket connection opened.');
    });
    this.socket.addEventListener('message', (event) => {
      this.incomingBuffer.push(event.data);
    });
    this.socket.addEventListener('close', () => {
      console.log('WebSocket connection closed.');
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
  
  updateBall(localTime) {
    const renderDelay = 100;
    const renderTime = localTime - this.serverTimeOffset - renderDelay;
    if (this.ballHistory.length >= 2) {
      let older = null;
      let newer = null;
      for (let i = 0; i < this.ballHistory.length - 1; i++) {
        if (this.ballHistory[i].timestamp <= renderTime &&
            this.ballHistory[i+1].timestamp >= renderTime) {
          older = this.ballHistory[i];
          newer = this.ballHistory[i+1];
          break;
        }
      }
      let targetX, targetY;
      if (!older || !newer) {
        older = this.ballHistory[this.ballHistory.length - 2];
        newer = this.ballHistory[this.ballHistory.length - 1];
        let extraTime = renderTime - newer.timestamp;
        extraTime = Math.min(extraTime, 100);
        const deltaT = newer.timestamp - older.timestamp;
        const vx = (newer.x - older.x) / deltaT;
        const vy = (newer.y - older.y) / deltaT;
        targetX = newer.x + vx * extraTime;
        targetY = newer.y + vy * extraTime;
      } else {
        const deltaT = newer.timestamp - older.timestamp;
        const t = (renderTime - older.timestamp) / deltaT;
        targetX = Phaser.Math.Linear(older.x, newer.x, t);
        targetY = Phaser.Math.Linear(older.y, newer.y, t);
      }
      this.ball.x = Phaser.Math.Linear(this.ball.x, targetX, 0.1);
      this.ball.y = Phaser.Math.Linear(this.ball.y, targetY, 0.1);
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
    
    //this.gravityCircle.clear();
    //this.gravityCircle.lineStyle(2, 0xff0000, 1);
    //this.gravityCircle.strokeCircle(this.ship.x, this.ship.y, 15);
    
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
        this.ball.x = this.ship.x;
        this.ball.y = this.ship.y;
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
      if (mag < this.minDist) {
        const angle = Phaser.Math.Angle.Between(this.ship.x, this.ship.y, worldPoint.x, worldPoint.y);
        dx = Math.cos(angle) * this.minDist;
        dy = Math.sin(angle) * this.minDist;
        mag = this.minDist;
      }
      const shotOffset = 25;
      const shotX = this.ship.x + (dx / mag) * (shotOffset + this.shotCorrection.x);
      const shotY = this.ship.y + (dy / mag) * (shotOffset + this.shotCorrection.y);
      this.ball.x = shotX;
      this.ball.y = shotY;
      this.ball.setDepth(1);
      this.ball.setVisible(true);
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
