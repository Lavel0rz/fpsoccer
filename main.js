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
    // Boost display.
    this.boostText = null;
    this.boostBar = null;
    // For shot effect.
    this.shotEffectDuration = 200;
    this.shotCorrection = { x: 0, y: 0 };
    // Minimum distance from ship to consider for a valid shot vector.
    this.minDist = 20;

    // For particle effects.
    this.particles = null;
    this.emitter = null;
    // Store previous position to compute movement direction.
    this.prevShipPos = { x: 400, y: 300 };

    // Store map objects loaded from JSON.
    this.mapObjects = [];
  }
  
  preload() {
    // Load game assets.
    this.load.image('ship', 'assets/ship.png');
    this.load.image('ball', 'assets/ball.png');
    this.load.image('spark', 'assets/ship_blue.png');
    // Load map JSON data.
    this.load.json('mapData', 'assets/map_data.json');
    // Optionally, load an asset for a wall.
    this.load.image('wall', 'assets/wall.png');
    // If you have a goal asset:
    this.load.image('goal', 'assets/goal.png');
  }
  
  create() {
    // Render map objects from JSON.
    const mapData = this.cache.json.get('mapData');
    // Save for later use if needed.
    this.mapObjects = mapData;
    // For each object in the map, add a sprite or graphic.
    mapData.forEach(obj => {
      let sprite;
      if (obj.type === 'wall') {
        // Here we use an image asset for walls.
        sprite = this.add.image(obj.x + obj.width/2, obj.y + obj.height/2, 'wall')
          .setDisplaySize(obj.width, obj.height)
          .setOrigin(0.5);
      } else if (obj.type === 'goal') {
        sprite = this.add.image(obj.x + obj.width/2, obj.y + obj.height/2, 'goal')
          .setDisplaySize(obj.width, obj.height)
          .setOrigin(0.5);
      }
      // Optionally, you could add the sprite to a static group for collisions.
    });

    // Create ship and ball.
    this.ship = this.add.sprite(400, 300, 'ship').setScale(0.5).setOrigin(0.5);
    this.ball = this.add.sprite(400, 400, 'ball').setScale(0.5).setOrigin(0.5);
    this.ball.setVisible(false);
    this.gravityCircle = this.add.graphics();
    
    // Create boost meter.
    this.boostText = this.add.text(10, 10, "Boost: 200", { font: "16px Arial", fill: "#ffffff" }).setScrollFactor(0);
    this.boostBar = this.add.graphics().setScrollFactor(0);
    
    // Minimap.
    this.minimap = this.cameras.add(1300, 10, 200, 150).setZoom(200 / 2000).setName('minimap');
    this.minimap.setBounds(0, 0, 2000, 1200);
    this.minimap.setBackgroundColor(0x002244);
    this.minimap.ignore([this.boostText, this.boostBar]);
    
    // Follow ship.
    this.cameras.main.startFollow(this.ship);
    this.cameras.main.setBounds(0, 0, 2000, 1200);
    
    // Create particle emitter for exhaust.
    this.particles = this.add.particles('spark', {
      lifespan: 300,
      speed: { min: 50, max: 100 },
      scale: { start: 0.5, end: 0 },
      blendMode: 'ADD',
      frequency: 50
    });
    this.particles.startFollow(this.ship);
    
    // Save initial ship position.
    this.prevShipPos.x = this.ship.x;
    this.prevShipPos.y = this.ship.y;
    
    this.connectWebSocket();
    
    // Keyboard input.
    this.input.keyboard.on('keydown-F', () => {
      if (this.scale.isFullscreen) {
        this.scale.stopFullscreen();
      } else {
        this.scale.startFullscreen();
      }
    });
    this.input.keyboard.on('keydown', (event) => {
      const key = event.key.toLowerCase();
      if (["w", "a", "s", "d", "shift"].includes(key)) {
        this.updateInputState(key, true);
      }
    });
    this.input.keyboard.on('keyup', (event) => {
      const key = event.key.toLowerCase();
      if (["w", "a", "s", "d", "shift"].includes(key)) {
        this.updateInputState(key, false);
      }
    });
    
    // Mouse input.
    this.input.on('pointerdown', (pointer) => {
      if (pointer.leftButtonDown()) {
        this.inputState.shoot = true;
        const worldPoint = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
        this.aimTarget.x = worldPoint.x;
        this.aimTarget.y = worldPoint.y;
        this.sendInput();
      }
    });
    this.input.on('pointerup', () => {
      this.inputState.shoot = false;
      this.sendInput();
    });
    this.input.on('pointermove', (pointer) => {
      const worldPoint = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
      this.aimTarget.x = worldPoint.x;
      this.aimTarget.y = worldPoint.y;
      if (pointer.leftButtonDown()) {
        this.sendInput();
      }
    });
  }
  
  updateInputState(key, isDown) {
    if (key === 'w') this.inputState.up = isDown;
    if (key === 's') this.inputState.down = isDown;
    if (key === 'a') this.inputState.left = isDown;
    if (key === 'd') this.inputState.right = isDown;
    if (key === 'shift') this.inputState.boost = isDown;
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
  
  connectWebSocket() {
    this.socket = new WebSocket('ws://localhost:8080/ws');
    this.socket.addEventListener('open', () => {
      console.log('WebSocket connection opened.');
    });
    this.socket.addEventListener('message', (event) => {
      try {
        const state = JSON.parse(event.data);
        if (state.your_id !== undefined && this.playerId === null) {
          this.playerId = state.your_id;
          console.log('Assigned player id:', this.playerId);
          return;
        }
        const serverTimestamp = state.time;
        if (!this.serverTimeOffset && serverTimestamp) {
          this.serverTimeOffset = this.time.now - serverTimestamp;
        }
        if (state.players) {
          if (state.players[this.playerId]) {
            this.serverState.ship = state.players[this.playerId];
            this.serverState.boost = state.players[this.playerId].boost;
          }
          for (const id in state.players) {
            if (parseInt(id) === this.playerId) continue;
            const shipState = state.players[id];
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
            if (!state.players[id]) {
              this.otherShips[id].destroy();
              delete this.otherShips[id];
            }
          }
        }
        if (state.ball && state.ball.active) {
          state.ball.timestamp = serverTimestamp;
          this.latestBallState = state.ball;
          this.ballHistory.push(state.ball);
          if (this.ballHistory.length > 10) this.ballHistory.shift();
        } else {
          this.ballHistory = [];
          this.latestBallState = null;
        }
      } catch (e) {
        console.error('Failed to parse server message:', e);
      }
    });
    this.socket.addEventListener('close', () => {
      console.log('WebSocket connection closed.');
    });
    this.socket.addEventListener('error', (error) => {
      console.error('WebSocket error:', error);
    });
  }
  
  updateRemoteShips(localTime) {
    const renderTime = localTime - this.serverTimeOffset;
    for (const id in this.otherShips) {
      const sprite = this.otherShips[id];
      if (sprite.history && sprite.history.length >= 2) {
        const [older, newer] = sprite.history;
        const deltaT = newer.timestamp - older.timestamp;
        if (renderTime <= newer.timestamp) {
          const t = (renderTime - older.timestamp) / deltaT;
          sprite.x = Phaser.Math.Linear(older.x, newer.x, t);
          sprite.y = Phaser.Math.Linear(older.y, newer.y, t);
        } else {
          let extraTime = renderTime - newer.timestamp;
          extraTime = Math.min(extraTime, 100);
          const vx = (newer.x - older.x) / deltaT;
          const vy = (newer.y - older.y) / deltaT;
          sprite.x = newer.x + vx * extraTime;
          sprite.y = newer.y + vy * extraTime;
        }
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
        if (this.ballHistory[i].timestamp <= renderTime && this.ballHistory[i + 1].timestamp >= renderTime) {
          older = this.ballHistory[i];
          newer = this.ballHistory[i + 1];
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
    const alpha = 0.065;
    this.predictedState.x = Phaser.Math.Linear(this.predictedState.x, this.serverState.ship ? this.serverState.ship.x : this.predictedState.x, alpha);
    this.predictedState.y = Phaser.Math.Linear(this.predictedState.y, this.serverState.ship ? this.serverState.ship.y : this.predictedState.y, alpha);
    this.ship.x = this.predictedState.x;
    this.ship.y = this.predictedState.y;
    
    this.gravityCircle.clear();
    this.gravityCircle.lineStyle(2, 0xff0000, 1);
    this.gravityCircle.strokeCircle(this.ship.x, this.ship.y, 15);
    
    if (this.serverState.boost !== undefined) {
      this.boostText.setText("Boost: " + Math.round(this.serverState.boost));
      this.boostBar.clear();
      this.boostBar.fillStyle(0x666666, 1);
      this.boostBar.fillRect(10, 30, 200, 10);
      this.boostBar.fillStyle(0x00ff00, 1);
      let boostWidth = (this.serverState.boost / 200) * 200;
      this.boostBar.fillRect(10, 30, boostWidth, 10);
    }
    
    this.updateRemoteShips(time);
    
    let moveX = this.ship.x - this.prevShipPos.x;
    let moveY = this.ship.y - this.prevShipPos.y;
    let moveMag = Math.sqrt(moveX * moveX + moveY * moveY);
    this.prevShipPos.x = this.ship.x;
    this.prevShipPos.y = this.ship.y;
    let exhaustAngle = 180;
    if (moveMag > 0.1) {
      exhaustAngle = Phaser.Math.RadToDeg(Math.atan2(moveY, moveX)) + 180;
    }
    
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
  type: Phaser.AUTO,
  width: 1600,
  height: 1200,
  physics: {
    default: 'arcade',
    arcade: { gravity: { y: 0 }, debug: false }
  },
  scene: MainScene
};
  
new Phaser.Game(config);
