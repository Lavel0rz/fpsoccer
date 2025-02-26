class MainScene extends Phaser.Scene {
  constructor() {
    super({ key: 'MainScene' });
    // Your own ship and prediction state.
    this.ship = null;
    this.predictedState = { x: 400, y: 300 };
    this.serverState = { ship: { x: 400, y: 300, seq: 0 } };
    // Dictionary for other players' ships.
    // Each remote ship sprite will have a history array added to it.
    this.otherShips = {}; 
    this.socket = null;
    this.ball = null;
    this.latestBallState = null;
    // Buffer for ball snapshots.
    this.ballHistory = [];
    // Input state now includes boost.
    this.inputState = { left: false, right: false, up: false, down: false, shoot: false, boost: false };
    this.inputSequence = 0;
    this.playerId = null; // Assigned by server.
    // Offset to align server timestamp with local time.
    this.serverTimeOffset = 0; 
  }
  
  preload() {
    this.load.image('ship', 'assets/ship.png');
    this.load.image('ball', 'assets/ball.png');
  }
  
  create() {
    // Create your own ship.
    this.ship = this.add.sprite(400, 300, 'ship').setScale(0.5).setOrigin(0.5, 0.5);
    // Create ball sprite.
    this.ball = this.add.sprite(400, 400, 'ball').setScale(0.5).setOrigin(0.5, 0.5);
    this.ball.setVisible(false);
    this.gravityCircle = this.add.graphics();
    this.connectWebSocket();
  
    // Keyboard input.
    // Use WASD for movement and Shift for boost.
    this.input.keyboard.on('keydown', (event) => {
      const key = event.key.toLowerCase();
      if (["w", "a", "s", "d", "shift"].includes(key)) {
        this.updateInputState(event.key, true);
      }
    });
    this.input.keyboard.on('keyup', (event) => {
      const key = event.key.toLowerCase();
      if (["w", "a", "s", "d", "shift"].includes(key)) {
        this.updateInputState(event.key, false);
      }
    });
  
    // Mouse input for shooting.
    this.input.on('pointerdown', (pointer) => {
      if (pointer.leftButtonDown()) {
        this.inputState.shoot = true;
        this.sendInput(pointer.worldX, pointer.worldY);
      }
    });
    this.input.on('pointerup', () => {
      this.inputState.shoot = false;
      this.sendInput();
    });
  }
  
  updateInputState(key, isDown) {
    // Normalize key to lowercase.
    key = key.toLowerCase();
    if (key === 'w') {
      this.inputState.up = isDown;
    }
    if (key === 's') {
      this.inputState.down = isDown;
    }
    if (key === 'a') {
      this.inputState.left = isDown;
    }
    if (key === 'd') {
      this.inputState.right = isDown;
    }
    if (key === 'shift') {
      this.inputState.boost = isDown;
    }
    this.sendInput();
  }
  
  sendInput(targetX, targetY) {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      const input = {
        seq: this.inputSequence,
        left: this.inputState.left,
        right: this.inputState.right,
        up: this.inputState.up,
        down: this.inputState.down,
        shoot: this.inputState.shoot,
        boost: this.inputState.boost,
        target_x: targetX !== undefined ? targetX : null,
        target_y: targetY !== undefined ? targetY : null
      };
      setTimeout(() => {
        this.socket.send(JSON.stringify(input));
      }, 100); // 100ms delay before sending the input
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
        // Assign your player ID.
        if (state.your_id !== undefined && this.playerId === null) {
          this.playerId = state.your_id;
          console.log('Assigned player id:', this.playerId);
          return;
        }
        // Server timestamp in ms.
        const serverTimestamp = state.time;
        // Set offset on first snapshot.
        if (!this.serverTimeOffset && serverTimestamp) {
          this.serverTimeOffset = this.time.now - serverTimestamp;
        }
  
        // Update players.
        if (state.players) {
          if (state.players[this.playerId]) {
            this.serverState.ship = state.players[this.playerId];
          }
          for (const id in state.players) {
            if (parseInt(id) === this.playerId) continue;
            const shipState = state.players[id];
            if (!this.otherShips[id]) {
              const sprite = this.add.sprite(shipState.x, shipState.y, 'ship').setScale(0.5).setOrigin(0.5, 0.5);
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
        // Update ball history.
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
  
  // Update remote ships using history for interpolation/extrapolation.
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
  
  // Update ball using its history.
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
    const alpha = 0.075;
    this.predictedState.x = Phaser.Math.Linear(this.predictedState.x, this.serverState.ship.x, alpha);
    this.predictedState.y = Phaser.Math.Linear(this.predictedState.y, this.serverState.ship.y, alpha);
    this.ship.x = this.predictedState.x;
    this.ship.y = this.predictedState.y;
    
    this.gravityCircle.clear();
    this.gravityCircle.lineStyle(2, 0xff0000, 1);
    this.gravityCircle.strokeCircle(this.ship.x, this.ship.y, 15);
    
    this.updateRemoteShips(time);
    
    if (this.latestBallState && this.latestBallState.grabbed) {
      let targetX, targetY;
      if (this.latestBallState.owner === this.playerId) {
        targetX = this.ship.x;
        targetY = this.ship.y;
      } else if (this.otherShips[this.latestBallState.owner]) {
        targetX = this.otherShips[this.latestBallState.owner].x;
        targetY = this.otherShips[this.latestBallState.owner].y;
      } else {
        targetX = this.latestBallState.x;
        targetY = this.latestBallState.y;
      }
      this.ball.x = targetX;
      this.ball.y = targetY;
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
}
  
const config = {
  type: Phaser.AUTO,
  width: 800,
  height: 600,
  physics: {
    default: 'arcade',
    arcade: { gravity: { y: 0 }, debug: false }
  },
  scene: MainScene
};
  
new Phaser.Game(config);
