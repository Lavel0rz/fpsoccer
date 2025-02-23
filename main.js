class MainScene extends Phaser.Scene {
  constructor() {
    super({ key: 'MainScene' });
    this.ship = null;
    this.ball = null;
    this.socket = null;
    this.latestBallState = null;
    this.inputState = { left: false, right: false, up: false, down: false, shoot: false };
    this.serverState = { ship: { x: 400, y: 300, seq: 0 } };
    this.predictedState = { x: 400, y: 300 };
    this.ballHistory = [];
    this.inputSequence = 0;
    this.playerId = null; // Will be set by the server.
  }
  
  preload() {
    this.load.image('ship', 'assets/ship.png');
    this.load.image('ball', 'assets/ball.png');
  }
  
  create() {
    this.ship = this.add.sprite(400, 300, 'ship');
    this.ship.setScale(0.5);
    this.ship.setOrigin(0.5, 0.5);
    
    this.ball = this.add.sprite(400, 400, 'ball');
    this.ball.setScale(0.5);
    this.ball.setOrigin(0.5, 0.5);
    this.ball.setVisible(false);
    
    this.gravityCircle = this.add.graphics();
    
    this.connectWebSocket();
  
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
        // If the message assigns our player ID, store it.
        if (state.your_id !== undefined && this.playerId === null) {
          this.playerId = state.your_id;
          console.log('Assigned player id:', this.playerId);
          return;
        }
        if (state.players && this.playerId !== null) {
          // Update authoritative ship state for this client.
          if (state.players[this.playerId]) {
            this.serverState.ship = state.players[this.playerId];
          }
        }
        // Handle ball state.
        if (state.ball && state.ball.active) {
          state.ball.timestamp = this.time.now;
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
  
    this.gravityCircle.clear();
    this.gravityCircle.lineStyle(2, 0xff0000, 1);
    this.gravityCircle.strokeCircle(this.ship.x, this.ship.y, 40);
  
    if (this.latestBallState && this.latestBallState.grabbed) {
      this.ball.x = Phaser.Math.Linear(this.ball.x, this.ship.x, 0.3);
      this.ball.y = Phaser.Math.Linear(this.ball.y, this.ship.y, 0.3);
      this.ball.setDepth(1);
      this.ball.setVisible(true);
    } else if (this.ballHistory.length > 0) {
      const interpolationDelay = 100;
      const renderTimestamp = time - interpolationDelay;
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
