class MainScene extends Phaser.Scene {
  constructor() {
    super({ key: 'MainScene' });
    // Your own ship and prediction state.
    this.ship = null;
    this.predictedState = { x: 400, y: 300 };
    this.serverState = { ship: { x: 400, y: 300, seq: 0 } };
    // Dictionary for other players' ships.
    this.otherShips = {};
    this.socket = null;
    this.ball = null;
    this.latestBallState = null;
    this.ballHistory = [];
    this.inputState = { left: false, right: false, up: false, down: false, shoot: false };
    this.inputSequence = 0;
    this.playerId = null; // Assigned by server.
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
    this.input.keyboard.on('keydown', (event) => {
      if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
        this.updateInputState(event.key, true);
      }
    });
    this.input.keyboard.on('keyup', (event) => {
      if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
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
    let changed = false;
    if (key === 'ArrowLeft' && this.inputState.left !== isDown) {
      this.inputState.left = isDown;
      changed = true;
    }
    if (key === 'ArrowRight' && this.inputState.right !== isDown) {
      this.inputState.right = isDown;
      changed = true;
    }
    if (key === 'ArrowUp' && this.inputState.up !== isDown) {
      this.inputState.up = isDown;
      changed = true;
    }
    if (key === 'ArrowDown' && this.inputState.down !== isDown) {
      this.inputState.down = isDown;
      changed = true;
    }
    if (changed) {
      this.sendInput();
    }
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
        target_x: targetX !== undefined ? targetX : null,
        target_y: targetY !== undefined ? targetY : null
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
        // Assign your player ID.
        if (state.your_id !== undefined && this.playerId === null) {
          this.playerId = state.your_id;
          console.log('Assigned player id:', this.playerId);
          return;
        }
        // Use server timestamp for interpolation.
        const serverTimestamp = state.time;
  
        if (state.players) {
          // Update your own ship state.
          if (state.players[this.playerId]) {
            this.serverState.ship = state.players[this.playerId];
          }
          // Update other players.
          for (const id in state.players) {
            if (parseInt(id) === this.playerId) continue;
            const shipState = state.players[id];
            if (!this.otherShips[id]) {
              this.otherShips[id] = this.add.sprite(shipState.x, shipState.y, 'ship').setScale(0.5).setOrigin(0.5, 0.5);
            } else {
              const sprite = this.otherShips[id];
              sprite.x = Phaser.Math.Linear(sprite.x, shipState.x, 0.1);
              sprite.y = Phaser.Math.Linear(sprite.y, shipState.y, 0.1);
            }
          }
          // Remove sprites for players no longer in state.
          for (const id in this.otherShips) {
            if (!state.players[id]) {
              this.otherShips[id].destroy();
              delete this.otherShips[id];
            }
          }
        }
        // Handle ball state using server timestamp.
        if (state.ball && state.ball.active) {
          state.ball.timestamp = serverTimestamp;
          this.latestBallState = state.ball;
          this.ballHistory.push(state.ball);
          if (this.ballHistory.length > 2) {
            this.ballHistory.shift();
          }
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
  
  update(time, delta) {
    // --- Update your own ship with prediction & reconciliation ---
    const dt = delta / 1000;
    const shipSpeed = 100;
    if (this.inputState.left) {
      this.predictedState.x -= shipSpeed * dt;
    }
    if (this.inputState.right) {
      this.predictedState.x += shipSpeed * dt;
    }
    if (this.inputState.up) {
      this.predictedState.y -= shipSpeed * dt;
    }
    if (this.inputState.down) {
      this.predictedState.y += shipSpeed * dt;
    }
    const alpha = 0.05;
    this.predictedState.x = Phaser.Math.Linear(this.predictedState.x, this.serverState.ship.x, alpha);
    this.predictedState.y = Phaser.Math.Linear(this.predictedState.y, this.serverState.ship.y, alpha);
    this.ship.x = this.predictedState.x;
    this.ship.y = this.predictedState.y;
  
    // Draw gravity circle around your ship.
    this.gravityCircle.clear();
    this.gravityCircle.lineStyle(2, 0xff0000, 1);
    this.gravityCircle.strokeCircle(this.ship.x, this.ship.y, 40);
  
    // --- Update ball rendering ---
    if (this.latestBallState && this.latestBallState.grabbed) {
      // If the ball is grabbed, interpolate toward the owning ship.
      if (this.latestBallState.owner === this.playerId) {
        this.ball.x = Phaser.Math.Linear(this.ball.x, this.ship.x, 0.3);
        this.ball.y = Phaser.Math.Linear(this.ball.y, this.ship.y, 0.3);
      } else if (this.otherShips[this.latestBallState.owner]) {
        const otherShip = this.otherShips[this.latestBallState.owner];
        this.ball.x = Phaser.Math.Linear(this.ball.x, otherShip.x, 0.3);
        this.ball.y = Phaser.Math.Linear(this.ball.y, otherShip.y, 0.3);
      }
      this.ball.setDepth(1);
      this.ball.setVisible(true);
    } else if (this.ballHistory.length > 0) {
      const interpolationDelay = 100; // ms
      const renderTimestamp = this.latestBallState ? this.latestBallState.timestamp - interpolationDelay : time;
      let older = null;
      let newer = null;
      for (let i = 0; i < this.ballHistory.length - 1; i++) {
        if (this.ballHistory[i].timestamp <= renderTimestamp && this.ballHistory[i + 1].timestamp >= renderTimestamp) {
          older = this.ballHistory[i];
          newer = this.ballHistory[i + 1];
          break;
        }
      }
      if (older && newer) {
        const t = (renderTimestamp - older.timestamp) / (newer.timestamp - older.timestamp);
        this.ball.x = Phaser.Math.Linear(older.x, newer.x, t);
        this.ball.y = Phaser.Math.Linear(older.y, newer.y, t);
      } else {
        const latest = this.ballHistory[this.ballHistory.length - 1];
        this.ball.x = latest.x;
        this.ball.y = latest.y;
      }
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
