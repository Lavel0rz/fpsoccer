class MainScene extends Phaser.Scene {
    constructor() {
      super({ key: 'MainScene' });
      this.ship = null;
      this.ball = null;
      this.socket = null;
      // Input state for ship movement and shooting.
      this.inputState = { left: false, right: false, up: false, down: false, shoot: false };
      // Authoritative ship state from server.
      this.serverState = { ship: { x: 400, y: 300, seq: 0 } };
      // Client's predicted state for the ship.
      this.predictedState = { x: 400, y: 400 };
      // We'll keep a history of ball updates from the server.
      this.ballHistory = [];
      this.inputSequence = 0;
    }
  
    preload() {
      this.load.image('ship', 'assets/ship.png');
      this.load.image('ball', 'assets/ball.png');
    }
  
    create() {
      this.ship = this.add.sprite(400, 300, 'ship');
      this.ship.setScale(0.5);
      this.ball = this.add.sprite(400, 400, 'ball');
      this.ball.setScale(0.5);
      this.ball.setVisible(false);
  
      this.connectWebSocket();
  
      // Listen for arrow key events.
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
  
      // Listen for pointer (mouse) events to shoot.
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
          // Update authoritative ship state.
          this.serverState.ship = state.ship;
  
          // Handle ball state from server.
          if (state.ball && state.ball.active) {
            // Attach a timestamp to the ball update.
            state.ball.timestamp = this.time.now;
            // Add the update to the history buffer.
            this.ballHistory.push(state.ball);
            // Keep only the latest two updates.
            if (this.ballHistory.length > 2) {
              this.ballHistory.shift();
            }
          } else {
            // When the ball is inactive, clear the history.
            this.ballHistory = [];
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
      // --- Ship Prediction & Reconciliation ---
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
      const alpha = 0.025;
      this.predictedState.x = Phaser.Math.Linear(this.predictedState.x, this.serverState.ship.x, alpha);
      this.predictedState.y = Phaser.Math.Linear(this.predictedState.y, this.serverState.ship.y, alpha);
      this.ship.x = this.predictedState.x;
      this.ship.y = this.predictedState.y;
  
      // --- Ball Rendering via Interpolation ---
      // Since the server is authoritative, we interpolate between recent server updates.
      if (this.ballHistory.length > 0) {
        // Use an interpolation delay (e.g., 100ms) so that we have a buffer of updates.
        const interpolationDelay = 100;
        const renderTimestamp = time - interpolationDelay;
        let older = null;
        let newer = null;
  
        // Find two ball states in our history around the renderTimestamp.
        for (let i = 0; i < this.ballHistory.length - 1; i++) {
          if (this.ballHistory[i].timestamp <= renderTimestamp && this.ballHistory[i + 1].timestamp >= renderTimestamp) {
            older = this.ballHistory[i];
            newer = this.ballHistory[i + 1];
            break;
          }
        }
  
        if (older && newer) {
          // Compute the interpolation factor between older and newer.
          const t = (renderTimestamp - older.timestamp) / (newer.timestamp - older.timestamp);
          this.ball.x = Phaser.Math.Linear(older.x, newer.x, t);
          this.ball.y = Phaser.Math.Linear(older.y, newer.y, t);
        } else {
          // If we can't interpolate, use the latest known state.
          const latest = this.ballHistory[this.ballHistory.length - 1];
          this.ball.x = latest.x;
          this.ball.y = latest.y;
        }
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
  