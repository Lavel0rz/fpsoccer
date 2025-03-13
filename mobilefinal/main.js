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
    
    // Mobile controls
    this.isMobile = false;
    this.joystick = null;
    this.shootButton = null;
    this.boostButton = null;
    
    // Movement direction
    this.targetDirection = { x: 0, y: 0 };
    this.movementDirection = { x: 0, y: 0 };
    this.turnSpeed = 0.2; // How quickly the ship turns towards the target direction
    
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
    
    // Create container for projectiles
    this.projectiles = {};
    this.latestGameState = null;
    
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
    this.isMobile = this.detectMobile();
    if (this.isMobile) {
      console.log('Mobile browser detected');
    }
    
    // Add countdown text
    this.countdownText = null;
    
    // Mobile controls
    this.joystick = null;
    this.shootButton = null;
    this.boostButton = null;
  }
  
  // Detect if we're on a mobile device
  detectMobile() {
    return (
      navigator.userAgent.match(/Android/i) ||
      navigator.userAgent.match(/webOS/i) ||
      navigator.userAgent.match(/iPhone/i) ||
      navigator.userAgent.match(/iPad/i) ||
      navigator.userAgent.match(/iPod/i) ||
      navigator.userAgent.match(/BlackBerry/i) ||
      navigator.userAgent.match(/Windows Phone/i)
    );
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
    
    // Get current game size
    const width = this.scale.width;
    const height = this.scale.height;
    console.log(`Initial game size: ${width} x ${height}`);
    
    // Add resize event listener
    this.scale.on('resize', this.handleResize, this);
    
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
    
    // Add rocket cooldown indicator above player name
    this.rocketCooldownGraphics = this.add.graphics();
    this.rocketReadyText = this.add.text(400, 250, "🚀", 
      { fontSize: '16px' }
    ).setOrigin(0.5).setVisible(false);
    
    // Try to create minimap with safety checks
    try {
      // Create minimap camera in the top right corner with size based on screen dimensions
      const minimapWidth = Math.min(200, this.scale.width * 0.2);
      const minimapHeight = Math.min(150, this.scale.height * 0.2);
      
      this.minimap = this.cameras.add(this.scale.width - minimapWidth - 10, 10, minimapWidth, minimapHeight)
        .setZoom(minimapWidth / 2000)
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
    
    // Set up input handling based on device type
    if (this.isMobile) {
      this.setupMobileControls();
    } else {
      this.setupDesktopControls();
    }
    
    // Add controller support for all devices
    this.setupControllerSupport();
    
    // Make the game instance accessible globally for team switching
    window.gameInstance = this;
    console.log('Game instance set to window.gameInstance');
    
    // Set up ping interval - shorter for mobile
    this.pingInterval = setInterval(() => {
      this.sendPing();
    }, this.isMobile ? 1000 : 2000); // Send ping every 1 second on mobile, 2 seconds on desktop
    
    // Handle window resize
    this.scale.on('resize', this.handleResize, this);
    
    // Add countdown text
    this.countdownText = this.add.text(this.scale.width / 2, 100, '', {
      fontFamily: 'Arial',
      fontSize: Math.min(64, this.scale.width * 0.05),
      color: '#ffffff',
      stroke: '#000000',
      strokeThickness: 6,
      align: 'center'
    }).setOrigin(0.5).setDepth(1000).setScrollFactor(0).setVisible(false);
    
    // Add direction indicator
    this.directionIndicator = this.add.graphics();
    this.directionIndicator.lineStyle(3, 0xffffff, 0.8);
    this.directionIndicator.beginPath();
    this.directionIndicator.moveTo(0, 0);
    this.directionIndicator.lineTo(40, 0);
    this.directionIndicator.closePath();
    this.directionIndicator.strokePath();
  }
  
  setupDesktopControls() {
    // Set up keyboard input
    this.input.keyboard.on('keydown', (event) => {
      this.updateInputState(event.key, true);
    });
    
    this.input.keyboard.on('keyup', (event) => {
      this.updateInputState(event.key, false);
    });
    
    // Handle space bar for shooting
    this.input.keyboard.on('keydown-SPACE', () => {
      console.log('Space bar pressed - shooting');
      this.inputState.shoot = true;
      this.sendInput();
      // Reset shoot flag after a short delay
      setTimeout(() => {
        this.inputState.shoot = false;
        // Send updated input state with shoot set to false
        this.sendInput();
      }, 100);
    });
    
    // Add mouse click for shooting as well
    this.input.on('pointerdown', (pointer) => {
      if (pointer.leftButtonDown()) {
        console.log('Left mouse button pressed - shooting');
        this.inputState.shoot = true;
        this.sendInput();
        // Reset shoot flag after a short delay
        setTimeout(() => {
          this.inputState.shoot = false;
          // Send updated input state with shoot set to false
          this.sendInput();
        }, 100);
      } else if (pointer.rightButtonDown()) {
        console.log('Right mouse button pressed - firing projectile');
        this.inputState.boost = true;
        this.sendInput();
        
        // Show visual feedback for projectile firing
        this.showNotification("Firing projectile!", false);
        
        // Reset boost flag after a short delay
        setTimeout(() => {
          this.inputState.boost = false;
          // Send updated input state with boost set to false
          this.sendInput();
        }, 100);
      }
    });
    
    // Track mouse movement to update aim direction
    this.input.on('pointermove', (pointer) => {
      // Convert pointer position to world coordinates
      const worldPoint = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
      
      // Update aim target to mouse position
      this.aimTarget.x = worldPoint.x;
      this.aimTarget.y = worldPoint.y;
      
      // Calculate direction from ship to mouse cursor
      const dx = worldPoint.x - this.ship.x;
      const dy = worldPoint.y - this.ship.y;
      const mag = Math.sqrt(dx * dx + dy * dy);
      
      // Update movement direction for aiming if the mouse is far enough from the ship
      if (mag > 10) {
        this.movementDirection.x = dx / mag;
        this.movementDirection.y = dy / mag;
        
        // Send updated input with new aim target
        this.sendInput();
      }
    });
  }
  
  setupMobileControls() {
    console.log('Setting up mobile controls');
    
    // Get screen dimensions
    const width = this.scale.width;
    const height = this.scale.height;
    
    // Create a container for the joystick that will stay fixed to the camera
    this.joystickContainer = this.add.container(0, 0);
    this.joystickContainer.setScrollFactor(0);
    this.joystickContainer.setDepth(1000);
    
    // Create base and thumb for joystick - half the original size
    const baseRadius = 40; // Reduced from 80
    const thumbRadius = 20; // Reduced from 40
    this.joystickBase = this.add.circle(0, 0, baseRadius, 0x888888, 0.5);
    this.joystickThumb = this.add.circle(0, 0, thumbRadius, 0xcccccc, 0.8);
    
    // Add to container
    this.joystickContainer.add(this.joystickBase);
    this.joystickContainer.add(this.joystickThumb);
    
    // Hide initially
    this.joystickContainer.setVisible(false);
    
    // Track joystick state
    this.joystickActive = false;
    this.joystickTouchId = null;
    this.joystickStartX = 0;
    this.joystickStartY = 0;
    this.joystickForce = 0;
    this.joystickForceX = 0;
    this.joystickForceY = 0;
    this.joystickMaxDistance = baseRadius;
    
    // Calculate button positions based on screen size - make them even smaller
    const buttonSize = Math.min(20, Math.max(12, width * 0.025)); // Even smaller buttons
    const buttonPadding = Math.min(70, Math.max(30, height * 0.07)); // Keep same padding
    
    // Create a boost button for projectile firing - fixed position with more separation
    this.boostButton = this.add.circle(
      width - buttonPadding,
      height - (buttonPadding * 3.5), // Increased vertical separation
      buttonSize,
      0xff9900,
      0.8
    );
    this.boostButton.setScrollFactor(0); // Keep fixed on screen
    this.boostButton.setDepth(1000); // Ensure it's on top
    this.boostButton.setInteractive();
    
    // Use direct event listeners instead of Phaser's event system
    this.boostButton.on('pointerdown', () => {
      console.log('Boost button pressed - firing projectile');
      this.inputState.boost = true;
      this.sendInput();
      
      // Show visual feedback for projectile firing
      this.showNotification("Firing projectile!", false);
    });
    
    this.boostButton.on('pointerout', () => {
      if (this.inputState.boost) {
        this.inputState.boost = false;
        this.sendInput();
      }
    });
    
    this.boostButton.on('pointerup', () => {
      if (this.inputState.boost) {
        this.inputState.boost = false;
        this.sendInput();
      }
    });
    
    // Add text to the boost button
    const boostText = this.add.text(
      width - buttonPadding,
      height - (buttonPadding * 3.5), // Match the button position
      'FIRE',
      { fontSize: Math.max(6, Math.min(10, width * 0.006)), color: '#ffffff' } // Smaller font
    ).setOrigin(0.5);
    boostText.setScrollFactor(0); // Keep fixed on screen
    boostText.setDepth(1001); // Ensure it's on top of the button
    
    // Create a shoot button - fixed position with horizontal separation
    this.shootButton = this.add.circle(
      width - (buttonPadding * 2.5), // Horizontal separation
      height - buttonPadding,
      buttonSize,
      0xff0000,
      0.8
    );
    this.shootButton.setScrollFactor(0); // Keep fixed on screen
    this.shootButton.setDepth(1000); // Ensure it's on top
    this.shootButton.setInteractive();
    
    // Use direct event listeners instead of Phaser's event system
    this.shootButton.on('pointerdown', () => {
      console.log('Shoot button pressed');
      this.inputState.shoot = true;
      this.sendInput();
      // Reset shoot flag after a short delay
      setTimeout(() => {
        this.inputState.shoot = false;
        this.sendInput();
      }, 100);
    });
    
    // Add text to the shoot button
    const shootText = this.add.text(
      width - (buttonPadding * 2.5), // Match the button position
      height - buttonPadding,
      'SHOOT',
      { fontSize: Math.max(6, Math.min(10, width * 0.006)), color: '#ffffff' } // Smaller font
    ).setOrigin(0.5);
    shootText.setScrollFactor(0); // Keep fixed on screen
    shootText.setDepth(1001); // Ensure it's on top of the button
    
    // COMPLETELY SEPARATE JOYSTICK HANDLING
    // Create a dedicated input zone for the left side of the screen for joystick
    const leftHalfZone = this.add.zone(0, 0, width / 2, height);
    leftHalfZone.setOrigin(0, 0);
    leftHalfZone.setScrollFactor(0);
    leftHalfZone.setInteractive();
    
    // Enable multi-touch
    this.input.addPointer(3); // Support up to 4 touches (default is 2)
    
    // Handle joystick creation on left side
    leftHalfZone.on('pointerdown', (pointer) => {
      if (!this.joystickActive) {
        console.log('Left side touched - creating joystick at', pointer.x, pointer.y);
        
        // Set joystick position to exact touch position in screen coordinates
        this.joystickStartX = pointer.x;
        this.joystickStartY = pointer.y;
        
        // Position the joystick container
        this.joystickContainer.setPosition(this.joystickStartX, this.joystickStartY);
        this.joystickThumb.setPosition(0, 0); // Center thumb on base
        
        // Make joystick visible
        this.joystickContainer.setVisible(true);
        
        // Track this touch for future updates
        this.joystickTouchId = pointer.id;
        this.joystickActive = true;
      }
    });
    
    // Handle pointer move to update joystick position - use global input manager
    this.input.on('pointermove', (pointer) => {
      if (this.joystickActive && pointer.id === this.joystickTouchId) {
        // Calculate the distance from the start position
        const dx = pointer.x - this.joystickStartX;
        const dy = pointer.y - this.joystickStartY;
        const distance = Math.sqrt(dx * dx + dy * dy);
        
        // Calculate the direction and force
        this.joystickForceX = dx / this.joystickMaxDistance;
        this.joystickForceY = dy / this.joystickMaxDistance;
        this.joystickForce = Math.min(distance / this.joystickMaxDistance, 1);
        
        // Limit the thumb position to the max distance
        let thumbX = dx;
        let thumbY = dy;
        
        if (distance > this.joystickMaxDistance) {
          const angle = Math.atan2(dy, dx);
          thumbX = Math.cos(angle) * this.joystickMaxDistance;
          thumbY = Math.sin(angle) * this.joystickMaxDistance;
        }
        
        // Update thumb position
        this.joystickThumb.setPosition(thumbX, thumbY);
        
        // Update input state based on joystick position
        this.updateJoystickInput();
      }
    });
    
    // Handle pointer up to hide joystick - use global input manager
    this.input.on('pointerup', (pointer) => {
      if (this.joystickActive && pointer.id === this.joystickTouchId) {
        console.log('Joystick touch released');
        this.joystickContainer.setVisible(false);
        this.joystickActive = false;
        this.joystickTouchId = null;
        this.joystickForce = 0;
        this.joystickForceX = 0;
        this.joystickForceY = 0;
        
        // Reset movement input state when joystick is released
        // BUT PRESERVE BOOST AND SHOOT STATE
        const currentBoost = this.inputState.boost;
        const currentShoot = this.inputState.shoot;
        
        this.inputState.left = false;
        this.inputState.right = false;
        this.inputState.up = false;
        this.inputState.down = false;
        
        // Restore boost and shoot states
        this.inputState.boost = currentBoost;
        this.inputState.shoot = currentShoot;
        
        this.sendInput();
      }
    });
    
    // Handle pointer cancel to hide joystick - use global input manager
    this.input.on('pointercancel', (pointer) => {
      if (this.joystickActive && pointer.id === this.joystickTouchId) {
        console.log('Joystick touch cancelled');
        this.joystickContainer.setVisible(false);
        this.joystickActive = false;
        this.joystickTouchId = null;
        this.joystickForce = 0;
        this.joystickForceX = 0;
        this.joystickForceY = 0;
        
        // Reset movement input state when joystick is released
        // BUT PRESERVE BOOST AND SHOOT STATE
        const currentBoost = this.inputState.boost;
        const currentShoot = this.inputState.shoot;
        
        this.inputState.left = false;
        this.inputState.right = false;
        this.inputState.up = false;
        this.inputState.down = false;
        
        // Restore boost and shoot states
        this.inputState.boost = currentBoost;
        this.inputState.shoot = currentShoot;
        
        this.sendInput();
      }
    });
  }
  
  // Helper method to update input state based on joystick position
  updateJoystickInput() {
    if (!this.joystickActive || this.joystickForce < 0.1) {
      return;
    }
    
    // Save current boost and shoot states
    const currentBoost = this.inputState.boost;
    const currentShoot = this.inputState.shoot;
    
    // Reset all directions first
    this.inputState.left = false;
    this.inputState.right = false;
    this.inputState.up = false;
    this.inputState.down = false;
    
    // Set input state based on joystick direction
    if (this.joystickForceX < -0.3) this.inputState.left = true;
    if (this.joystickForceX > 0.3) this.inputState.right = true;
    if (this.joystickForceY < -0.3) this.inputState.up = true;
    if (this.joystickForceY > 0.3) this.inputState.down = true;
    
    // Restore boost and shoot states
    this.inputState.boost = currentBoost;
    this.inputState.shoot = currentShoot;
    
    // Update target direction for movement
    this.targetDirection.x = this.joystickForceX;
    this.targetDirection.y = this.joystickForceY;
    
    // Send input to server
    this.sendInput();
  }
  
  updateInputState(key, isDown) {
    // Convert key to lowercase for case-insensitive comparison
    const lowerKey = key.toLowerCase();
    
    // Movement controls
    if (lowerKey === 'a' || lowerKey === 'arrowleft') {
      this.inputState.left = isDown;
    } else if (lowerKey === 'd' || lowerKey === 'arrowright') {
      this.inputState.right = isDown;
    } else if (lowerKey === 'w' || lowerKey === 'arrowup') {
      this.inputState.up = isDown;
    } else if (lowerKey === 's' || lowerKey === 'arrowdown') {
      this.inputState.down = isDown;
    } else if (lowerKey === 'shift') {
      this.inputState.boost = isDown;
    } else if (lowerKey === ' ' || lowerKey === 'space') {
      // Space key for shooting - handled separately in keydown-SPACE event
      // But we'll include it here as a fallback
      console.log('Space key detected in updateInputState');
      if (isDown) {
        this.inputState.shoot = true;
        // Reset shoot state after a short delay
        setTimeout(() => {
          this.inputState.shoot = false;
        }, 100);
      }
    }
    
    // Send input update to server
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.sendInput();
    }
  }
  
  sendInput() {
    // Only send input if player can move and socket is connected
    if (this.playerCanMove !== false && this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.inputSequence++;
      
      // Calculate aim target based on movement direction
      const aimDistance = 100;
      const targetX = this.aimTarget ? this.aimTarget.x : this.ship.x + this.movementDirection.x * aimDistance;
      const targetY = this.aimTarget ? this.aimTarget.y : this.ship.y + this.movementDirection.y * aimDistance;
      
      // Log shooting state for debugging
      if (this.inputState.shoot) {
        console.log('Sending shoot command to server');
      }
      
      // Log boost state for debugging
      if (this.inputState.boost) {
        console.log('Sending boost command to server for projectile firing');
      }
      
      const input = {
        type: 'input',
        left: this.inputState.left,
        right: this.inputState.right,
        up: this.inputState.up,
        down: this.inputState.down,
        shoot: this.inputState.shoot,
        boost: this.inputState.boost,
        seq: this.inputSequence,
        target_x: targetX,
        target_y: targetY,
        display_name: window.PLAYER_DISPLAY_NAME || 'Player'
      };
      
      // Add joystick data for mobile users
      if (this.isMobile && this.joystickActive && this.joystickForce > 0) {
        input.joystick = {
          force: this.joystickForce,
          forceX: this.joystickForceX,
          forceY: this.joystickForceY,
          angle: Math.atan2(this.joystickForceY, this.joystickForceX)
        };
      }
      
      // Log the input message for debugging
      console.log('Sending input:', JSON.stringify(input));
      
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
      }, this.isMobile ? 2000 : 15000); // Send a ping every 2 seconds on mobile, 15 seconds on desktop
      
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
          
          // Handle shoot message
          if (msg.type === 'shoot') {
            // Play shoot sound or animation
            this.playShootEffect(msg.player_id);
            return;
          }
          
          // Handle auto-shoot message
          if (msg.type === 'auto_shoot') {
            // Play auto-shoot sound or animation
            this.playShootEffect(msg.player_id);
            return;
          }
          
          // Handle ball knocked loose message
          if (msg.type === 'ball_knocked') {
            // Play ball knocked loose effect
            this.playBallKnockedEffect(msg.player_id);
            return;
          }
          
          // Handle projectile fired message
          if (msg.type === 'projectile_fired') {
            // Play projectile fired effect
            this.playProjectileFiredEffect(msg.player_id);
            return;
          }
          
          // Handle explosion message
          if (msg.type === 'explosion') {
            // Play explosion effect
            this.playExplosionEffect(msg.x, msg.y, msg.radius, msg.player_id);
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
    console.log(`Updating remote ships at render time ${renderTime}`);
    
    for (const id in this.otherShips) {
      if (id == this.clientId) continue;
      
      const sprite = this.otherShips[id];
      console.log(`Processing ship for player ${id}:`, sprite);
      
      if (!sprite.history || sprite.history.length < 2) {
        console.log(`Ship for player ${id} has insufficient history:`, sprite.history);
        continue;
      }
      
      // Find the two closest states in history
      let older = null;
      let newer = null;
      for (let i = 0; i < sprite.history.length; i++) {
        const state = sprite.history[i];
        if (state.timestamp <= renderTime) {
          older = state;
        } else {
          newer = state;
          break;
        }
      }
      
      if (!older) older = sprite.history[0];
      if (!newer) newer = sprite.history[sprite.history.length - 1];
      
      console.log(`Interpolating ship for player ${id} between:`, older, newer);
      
      // Interpolate between the two states
      const alpha = newer.timestamp === older.timestamp ? 0 : (renderTime - older.timestamp) / (newer.timestamp - older.timestamp);
      const x = Phaser.Math.Linear(older.x, newer.x, alpha);
      const y = Phaser.Math.Linear(older.y, newer.y, alpha);
      
      // Update sprite position
      sprite.x = x;
      sprite.y = y;
      
      // Calculate movement direction for rotation
      const dx = newer.x - older.x;
      const dy = newer.y - older.y;
      if (dx !== 0 || dy !== 0) {
        const angle = Math.atan2(dy, dx);
        sprite.rotation = angle;
      }
      
      // Generate particles if moving
      this.generateRemoteShipParticles(sprite, older, newer);
      
      // Update name position
      if (sprite.nameText) {
        sprite.nameText.x = x;
        sprite.nameText.y = y - 30;
      }
      
      // Update rocket cooldown indicator for other ships
      if (sprite.rocketCooldownGraphics && sprite.rocketReadyText) {
        this.updateRemoteRocketCooldown(sprite, sprite.history[sprite.history.length - 1]);
      }
    }
  }

  generateRemoteShipParticles(sprite, older, newer) {
    // Calculate the movement distance
    const distanceMoved = Phaser.Math.Distance.Between(older.x, older.y, newer.x, newer.y);

    // Only generate particles if the ship has moved significantly
    const movementThreshold = 2.5;
    if (distanceMoved > movementThreshold) {
        const dx = newer.x - older.x;
        const dy = newer.y - older.y;

        const direction = new Phaser.Math.Vector2(dx, dy).normalize();

        if (direction.length() > 0) {
            // Calculate the opposite direction
            const oppositeDirection = direction.clone().negate();

            // Emit particles in the opposite direction
            const particleX = sprite.x + oppositeDirection.x * 20;
            const particleY = sprite.y + oppositeDirection.y * 20;
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
    
    // Only process input if player can move (not during countdown)
    if (this.playerCanMove !== false) {
      // Calculate target direction based on input
      this.targetDirection.x = 0;
      this.targetDirection.y = 0;
      
      let targetLength = 0;
      
      if (this.isMobile) {
        // Joystick input is now handled in updateJoystickInput method
        // No need to process it here
      } else {
        // Use keyboard input for desktop
        if (this.inputState.left) this.targetDirection.x -= 1;
        if (this.inputState.right) this.targetDirection.x += 1;
        if (this.inputState.up) this.targetDirection.y -= 1;
        if (this.inputState.down) this.targetDirection.y += 1;
        
        // Normalize target direction if it's not zero
        targetLength = Math.sqrt(this.targetDirection.x * this.targetDirection.x + this.targetDirection.y * this.targetDirection.y);
        if (targetLength > 0) {
          this.targetDirection.x /= targetLength;
          this.targetDirection.y /= targetLength;
        }
      }
      
      // For desktop, we don't update the movement direction from keyboard input
      // since it's now controlled by the mouse position
      if (this.isMobile) {
        // Gradually turn towards the target direction (for mobile only)
        if (targetLength > 0) {
          // Interpolate current direction towards target direction
          this.movementDirection.x = Phaser.Math.Linear(this.movementDirection.x, this.targetDirection.x, this.turnSpeed);
          this.movementDirection.y = Phaser.Math.Linear(this.movementDirection.y, this.targetDirection.y, this.turnSpeed);
          
          // Normalize the movement direction
          const moveLength = Math.sqrt(this.movementDirection.x * this.movementDirection.x + this.movementDirection.y * this.movementDirection.y);
          if (moveLength > 0) {
            this.movementDirection.x /= moveLength;
            this.movementDirection.y /= moveLength;
          }
          
          // Update aim target to be in the direction of movement
          const aimDistance = 100; // How far ahead to aim
          this.aimTarget.x = this.ship.x + this.movementDirection.x * aimDistance;
          this.aimTarget.y = this.ship.y + this.movementDirection.y * aimDistance;
        } else {
          // If no input, gradually slow down
          this.movementDirection.x *= 0.95;
          this.movementDirection.y *= 0.95;
        }
      }
      
      // Update predicted position based on movement direction
      this.predictedState.x += this.targetDirection.x * shipSpeed * dt;
      this.predictedState.y += this.targetDirection.y * shipSpeed * dt;
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
    
    // Update ship rotation to match aim direction
    if (this.movementDirection.x !== 0 || this.movementDirection.y !== 0) {
      const angle = Math.atan2(this.movementDirection.y, this.movementDirection.x);
      this.ship.rotation = angle;
    }
    
    // Update direction indicator
    this.directionIndicator.clear();
    this.directionIndicator.lineStyle(3, 0xffffff, 0.8);
    this.directionIndicator.beginPath();
    this.directionIndicator.moveTo(this.ship.x, this.ship.y);
    this.directionIndicator.lineTo(
      this.ship.x + this.movementDirection.x * 40,
      this.ship.y + this.movementDirection.y * 40
    );
    this.directionIndicator.closePath();
    this.directionIndicator.strokePath();
    
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
        
        // Store the latest game state for projectiles
        this.latestGameState = msg;
        
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
            console.log(`Updating ship for player ${id}:`, shipState);
            
            if (!this.otherShips[id]) {
              console.log(`Creating new ship for player ${id}`);
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
              
              // Add rocket cooldown indicator for other ships
              sprite.rocketCooldownGraphics = this.add.graphics();
              sprite.rocketReadyText = this.add.text(shipState.x, shipState.y - 50, "🚀", 
                { fontSize: '16px' }
              ).setOrigin(0.5).setVisible(false);
            } else {
              // Update existing ship
              const sprite = this.otherShips[id];
              
              // Update player name if it changed
              if (sprite.nameText) {
                sprite.nameText.setText(shipState.display_name || `Player ${id}`);
              }
              
              // Update team if it changed
              if (sprite.team !== shipState.team) {
                sprite.team = shipState.team;
                
                // Update ship color based on team
                if (shipState.team === 'Red') {
                  sprite.setTint(0xff0000); // Red tint
                } else if (shipState.team === 'Blue') {
                  sprite.setTint(0x0000ff); // Blue tint
                }
              }
              
              // Update ship history for interpolation
              if (!sprite.history) sprite.history = [];
              sprite.history.push({ x: shipState.x, y: shipState.y, timestamp: serverTimestamp });
              
              // Keep history limited to prevent memory issues
              while (sprite.history.length > 10) {
                sprite.history.shift();
              }
            }
          }
          
          // Clean up ships that are no longer in the game state
          for (const id in this.otherShips) {
            if (!msg.players[id]) {
              // Remove ship that's no longer in the game
              if (this.otherShips[id].nameText) {
                this.otherShips[id].nameText.destroy();
              }
              
              // Clean up rocket cooldown graphics and text
              if (this.otherShips[id].rocketCooldownGraphics) {
                this.otherShips[id].rocketCooldownGraphics.destroy();
              }
              if (this.otherShips[id].rocketReadyText) {
                // Stop any active tween before destroying
                if (this.otherShips[id].rocketReadyTween && this.otherShips[id].rocketReadyTween.isPlaying()) {
                  this.otherShips[id].rocketReadyTween.stop();
                }
                this.otherShips[id].rocketReadyText.destroy();
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
    
    // Update projectiles
    this.updateProjectiles(time, delta);
    
    // Generate particles
    this.generateParticles();
    
    // Update camera position
    this.updateCamera();
    
    // Update controller input
    this.updateControllerInput();
    
    // Update rocket cooldown indicator
    this.updateRocketCooldown();
  }

  // Add method to play projectile fired effect
  playProjectileFiredEffect(playerId) {
    // Find the ship that fired the projectile
    let firingShip;
    if (playerId === this.clientId) {
      firingShip = this.ship;
    } else if (this.otherShips[playerId]) {
      firingShip = this.otherShips[playerId];
    }
    
    if (!firingShip) return;
    
    // Create a muzzle flash effect
    const flash = this.add.circle(firingShip.x, firingShip.y, 15, 0xffff00, 0.8);
    flash.setDepth(10);
    
    // Fade out and destroy
    this.tweens.add({
      targets: flash,
      alpha: 0,
      duration: 200,
      onComplete: () => {
        flash.destroy();
      }
    });
    
    // Add some particles for the firing effect
    if (this.particleEmitter) {
      for (let i = 0; i < 10; i++) {
        // Emit particles in the direction of firing
        const angle = Math.random() * Math.PI * 0.5 - Math.PI * 0.25;
        const distance = 20 + Math.random() * 10;
        
        // Use the ship's rotation to determine the base direction
        const baseAngle = firingShip.rotation;
        const x = firingShip.x + Math.cos(baseAngle + angle) * distance;
        const y = firingShip.y + Math.sin(baseAngle + angle) * distance;
        
        this.particleEmitter.emitParticleAt(x, y);
      }
    }
  }
  
  // Add method to handle explosions
  playExplosionEffect(x, y, radius, playerId) {
    // Create explosion flash
    const flash = this.add.circle(x, y, radius, 0xff6600, 0.6);
    flash.setDepth(10);
    
    // Fade out and destroy
    this.tweens.add({
      targets: flash,
      alpha: 0,
      scale: 1.5,
      duration: 500,
      onComplete: () => {
        flash.destroy();
      }
    });
    
    // Add explosion particles
    if (this.particleEmitter) {
      // Configure emitter for explosion
      const originalTint = this.particleEmitter.tint;
      this.particleEmitter.setTint(0xff6600);
      
      // Emit particles in all directions
      for (let i = 0; i < 50; i++) {
        const angle = Math.random() * Math.PI * 2;
        const distance = Math.random() * radius * 0.8;
        const x2 = x + Math.cos(angle) * distance;
        const y2 = y + Math.sin(angle) * distance;
        
        this.particleEmitter.emitParticleAt(x2, y2);
      }
      
      // Reset emitter tint
      setTimeout(() => {
        this.particleEmitter.setTint(originalTint);
      }, 100);
    }
    
    // Screen shake effect
    this.cameras.main.shake(200, 0.01);
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
  
  // Add method to update projectiles
  updateProjectiles(time, delta) {
    // If we don't have a game state with projectiles, return
    if (!this.latestGameState || !this.latestGameState.projectiles) {
      return;
    }
    
    // Track existing projectile IDs to remove stale ones
    const currentProjectileIds = new Set();
    
    // Process projectiles from the latest game state
    this.latestGameState.projectiles.forEach(projectile => {
      currentProjectileIds.add(projectile.id);
      
      // Create or update projectile sprite
      if (!this.projectiles[projectile.id]) {
        // Create new projectile sprite
        const sprite = this.add.sprite(projectile.x, projectile.y, 'ball');
        sprite.setScale(0.3); // Make projectiles smaller than the ball
        sprite.setTint(0xff9900); // Give projectiles a distinct color
        sprite.setDepth(5); // Above ships but below UI
        
        // Add a glow effect
        const glow = this.add.circle(projectile.x, projectile.y, 10, 0xff9900, 0.5);
        glow.setDepth(4);
        
        // Store both sprite and glow
        this.projectiles[projectile.id] = {
          sprite,
          glow,
          trailPoints: [], // For trail effect
          lastX: projectile.x,
          lastY: projectile.y,
          vx: projectile.vx || 0,
          vy: projectile.vy || 0,
          lastUpdateTime: time,
          history: [{ x: projectile.x, y: projectile.y, vx: projectile.vx, vy: projectile.vy, timestamp: time }]
        };
      }
      
      // Update existing projectile
      const proj = this.projectiles[projectile.id];
      
      // Store velocity for prediction
      proj.vx = projectile.vx || proj.vx;
      proj.vy = projectile.vy || proj.vy;
      
      // Add to history for interpolation
      proj.history.push({ 
        x: projectile.x, 
        y: projectile.y, 
        vx: projectile.vx, 
        vy: projectile.vy, 
        timestamp: time 
      });
      
      // Keep history limited to prevent memory issues
      if (proj.history.length > 10) {
        proj.history.shift();
      }
      
      // Calculate interpolated position
      const timeSinceLastUpdate = time - proj.lastUpdateTime;
      const renderDelay = 50; // Small delay for smoother interpolation
      const renderTime = time - renderDelay;
      
      // Find the two closest states in history for interpolation
      let prev = null, next = null;
      for (let i = 0; i < proj.history.length - 1; i++) {
        if (proj.history[i].timestamp <= renderTime && 
            proj.history[i + 1].timestamp >= renderTime) {
          prev = proj.history[i];
          next = proj.history[i + 1];
          break;
        }
      }
      
      let targetX, targetY;
      
      if (prev && next) {
        // Interpolate between the two states
        const t = (renderTime - prev.timestamp) / (next.timestamp - prev.timestamp);
        targetX = Phaser.Math.Linear(prev.x, next.x, t);
        targetY = Phaser.Math.Linear(prev.y, next.y, t);
      } else if (proj.history.length > 0) {
        // Use the latest known position and apply velocity-based prediction
        const latest = proj.history[proj.history.length - 1];
        const predictionTime = time - latest.timestamp;
        targetX = latest.x + (proj.vx * predictionTime / 1000);
        targetY = latest.y + (proj.vy * predictionTime / 1000);
      } else {
        // Fallback to server position
        targetX = projectile.x;
        targetY = projectile.y;
      }
      
      // Apply smooth movement (lerp) to the sprite position
      const smoothingFactor = 0.3; // Adjust for desired smoothness
      proj.sprite.x = Phaser.Math.Linear(proj.sprite.x, targetX, smoothingFactor);
      proj.sprite.y = Phaser.Math.Linear(proj.sprite.y, targetY, smoothingFactor);
      proj.glow.x = proj.sprite.x;
      proj.glow.y = proj.sprite.y;
      
      // Calculate rotation based on velocity
      if (proj.vx !== 0 || proj.vy !== 0) {
        proj.sprite.rotation = Math.atan2(proj.vy, proj.vx);
      }
      
      // Add trail effect
      if (delta > 0) {
        // Add current position to trail
        proj.trailPoints.push({ x: proj.sprite.x, y: proj.sprite.y, alpha: 1 });
        
        // Limit trail length
        if (proj.trailPoints.length > 10) {
          proj.trailPoints.shift();
        }
        
        // Fade out trail points
        proj.trailPoints.forEach((point, index) => {
          point.alpha -= 0.1 * (delta / 16);
          if (point.alpha < 0) point.alpha = 0;
        });
        
        // Remove fully faded points
        proj.trailPoints = proj.trailPoints.filter(point => point.alpha > 0);
        
        // Draw trail
        if (proj.trail) {
          proj.trail.destroy();
        }
        
        if (proj.trailPoints.length > 1) {
          const graphics = this.add.graphics();
          graphics.setDepth(3);
          
          // Draw trail as a gradient line with smoother curves
          if (proj.trailPoints.length >= 3) {
            graphics.lineStyle(3, 0xff9900, 0.7);
            graphics.beginPath();
            graphics.moveTo(proj.trailPoints[0].x, proj.trailPoints[0].y);
            
            // Use curve interpolation for smoother trail
            for (let i = 1; i < proj.trailPoints.length - 1; i++) {
              const p1 = proj.trailPoints[i];
              const p2 = proj.trailPoints[i + 1];
              const alpha = p1.alpha * 0.7;
              
              graphics.lineStyle(3 * alpha, 0xff9900, alpha);
              graphics.lineTo(p1.x, p1.y);
            }
            
            graphics.lineTo(
              proj.trailPoints[proj.trailPoints.length - 1].x, 
              proj.trailPoints[proj.trailPoints.length - 1].y
            );
            graphics.strokePath();
          } else {
            // Fallback to simple line if not enough points for curve
            for (let i = 0; i < proj.trailPoints.length - 1; i++) {
              const p1 = proj.trailPoints[i];
              const p2 = proj.trailPoints[i + 1];
              const alpha = p1.alpha * 0.5;
              
              graphics.lineStyle(3 * alpha, 0xff9900, alpha);
              graphics.lineBetween(p1.x, p1.y, p2.x, p2.y);
            }
          }
          
          proj.trail = graphics;
        }
      }
      
      // Store last position and update time
      proj.lastX = proj.sprite.x;
      proj.lastY = proj.sprite.y;
      proj.lastUpdateTime = time;
    });
    
    // Remove projectiles that are no longer in the game state
    Object.keys(this.projectiles).forEach(id => {
      if (!currentProjectileIds.has(parseInt(id))) {
        // Clean up projectile sprites
        if (this.projectiles[id].sprite) {
          this.projectiles[id].sprite.destroy();
        }
        if (this.projectiles[id].glow) {
          this.projectiles[id].glow.destroy();
        }
        if (this.projectiles[id].trail) {
          this.projectiles[id].trail.destroy();
        }
        delete this.projectiles[id];
      }
    });
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
      
      // Clean up rocket cooldown indicators
      if (this.otherShips[id].rocketCooldownGraphics) {
        this.otherShips[id].rocketCooldownGraphics.destroy();
      }
      if (this.otherShips[id].rocketReadyText) {
        // Stop any active tween before destroying
        if (this.otherShips[id].rocketReadyTween && this.otherShips[id].rocketReadyTween.isPlaying()) {
          this.otherShips[id].rocketReadyTween.stop();
        }
        this.otherShips[id].rocketReadyText.destroy();
      }
      
      this.otherShips[id].destroy();
    }
    
    // Clean up player name text
    if (this.playerNameText) {
      this.playerNameText.destroy();
    }
    
    // Clean up player's rocket cooldown indicators
    if (this.rocketCooldownGraphics) {
      this.rocketCooldownGraphics.destroy();
    }
    if (this.rocketReadyText) {
      if (this.rocketReadyTween && this.rocketReadyTween.isPlaying()) {
        this.rocketReadyTween.stop();
      }
      this.rocketReadyText.destroy();
    }
    
    // Clean up UI elements
    if (this.scoreLabel) this.scoreLabel.destroy();
    if (this.redScoreText) this.redScoreText.destroy();
    if (this.scoreSeparator) this.scoreSeparator.destroy();
    if (this.blueScoreText) this.blueScoreText.destroy();
    
    // Remove resize listener
    this.scale.off('resize', this.handleResize, this);
    
    this.otherShips = {};
    
    // Clean up controller event listeners
    window.removeEventListener('gamepadconnected', this.handleGamepadConnected);
    window.removeEventListener('gamepaddisconnected', this.handleGamepadDisconnected);
    
    // Reset controller state
    this.controllers = {};
    this.controllerConnected = false;
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
    console.log(`Game resized to: ${gameSize.width} x ${gameSize.height}`);
    
    // Update camera bounds to match the new game size
    if (this.cameras && this.cameras.main) {
      // Keep the same world bounds but update the camera view
      this.cameras.main.setSize(gameSize.width, gameSize.height);
    }
    
    // Reset joystick if active
    if (this.isMobile && this.joystickActive) {
      this.joystickContainer.setVisible(false);
      this.joystickActive = false;
      this.joystickTouchId = null;
      this.joystickForce = 0;
      this.joystickForceX = 0;
      this.joystickForceY = 0;
      
      // Reset input state
      this.inputState.left = false;
      this.inputState.right = false;
      this.inputState.up = false;
      this.inputState.down = false;
      this.sendInput();
    }
    
    // Reposition minimap to top right corner with safety checks
    if (this.minimap && typeof this.minimap.x !== 'undefined') {
      try {
        // Position minimap in top right, with some padding
        const minimapWidth = Math.min(200, gameSize.width * 0.2);
        const minimapHeight = Math.min(150, gameSize.height * 0.2);
        
        this.minimap.setSize(minimapWidth, minimapHeight);
        this.minimap.setPosition(gameSize.width - minimapWidth - 10, 10);
        this.minimap.setZoom(minimapWidth / 2000); // Adjust zoom based on minimap size
      } catch (error) {
        console.error('Error repositioning minimap:', error);
      }
    }
    
    // Reposition UI elements
    if (this.pingText) {
      this.pingText.setScrollFactor(0);
      this.pingText.setPosition(10, 10);
    }
    
    if (this.scoreLabel) {
      const scoreY = 40;
      this.scoreLabel.setScrollFactor(0);
      this.scoreLabel.setPosition(10, scoreY);
      
      if (this.redScoreText) {
        this.redScoreText.setScrollFactor(0);
        this.redScoreText.setPosition(this.scoreLabel.x + this.scoreLabel.width, scoreY);
      }
      
      if (this.scoreSeparator) {
        this.scoreSeparator.setScrollFactor(0);
        this.scoreSeparator.setPosition(this.redScoreText.x + this.redScoreText.width, scoreY);
      }
      
      if (this.blueScoreText) {
        this.blueScoreText.setScrollFactor(0);
        this.blueScoreText.setPosition(this.scoreSeparator.x + this.scoreSeparator.width, scoreY);
      }
    }
    
    if (this.teamText) {
      this.teamText.setScrollFactor(0);
      this.teamText.setPosition(10, 70);
    }
    
    // Reposition countdown text to center of screen
    if (this.countdownText) {
      this.countdownText.setScrollFactor(0);
      this.countdownText.setPosition(gameSize.width / 2, 100);
      this.countdownText.setFontSize(Math.min(64, gameSize.width * 0.05));
    }

    // Reposition mobile controls if they exist
    if (this.isMobile) {
      try {
        // Scale button sizes based on screen size
        const buttonSize = Math.min(60, Math.max(40, gameSize.width * 0.08));
        const buttonPadding = Math.min(80, Math.max(40, gameSize.height * 0.08));
        
        if (this.shootButton) {
          // Position shoot button at bottom right
          this.shootButton.x = gameSize.width - buttonPadding;
          this.shootButton.y = gameSize.height - buttonPadding;
          this.shootButton.setRadius(buttonSize);
          
          // Find and update the shoot button text
          const shootText = this.children.list.find(child => 
            child.type === 'Text' && child.text === 'SHOOT'
          );
          if (shootText) {
            shootText.x = gameSize.width - buttonPadding;
            shootText.y = gameSize.height - buttonPadding;
            shootText.setFontSize(Math.max(14, Math.min(20, gameSize.width * 0.015)));
            shootText.setScrollFactor(0); // Ensure it stays fixed on screen
          }
        }
        
        if (this.boostButton) {
          // Position boost button above shoot button
          this.boostButton.x = gameSize.width - buttonPadding;
          this.boostButton.y = gameSize.height - (buttonPadding * 2.5);
          this.boostButton.setRadius(buttonSize);
          
          // Find and update the boost button text
          const boostText = this.children.list.find(child => 
            child.type === 'Text' && child.text === 'FIRE'
          );
          if (boostText) {
            boostText.x = gameSize.width - buttonPadding;
            boostText.y = gameSize.height - (buttonPadding * 2.5);
            boostText.setFontSize(Math.max(14, Math.min(20, gameSize.width * 0.015)));
            boostText.setScrollFactor(0); // Ensure it stays fixed on screen
          }
        }
      } catch (error) {
        console.error('Error repositioning mobile controls:', error);
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

  // Add method to play shoot effect
  playShootEffect(playerId) {
    // Find the ship that shot
    let shooterShip;
    if (playerId === this.clientId) {
      shooterShip = this.ship;
    } else if (this.otherShips[playerId]) {
      shooterShip = this.otherShips[playerId];
    }
    
    if (!shooterShip) return;
    
    // Create a flash effect
    const flash = this.add.circle(shooterShip.x, shooterShip.y, 30, 0xffffff, 0.8);
    flash.setDepth(10);
    
    // Fade out and destroy
    this.tweens.add({
      targets: flash,
      alpha: 0,
      duration: 200,
      onComplete: () => {
        flash.destroy();
      }
    });
    
    // Add some particles in the direction the ship is facing
    if (this.particleEmitter) {
      const angle = shooterShip.rotation;
      const dirX = Math.cos(angle);
      const dirY = Math.sin(angle);
      
      for (let i = 0; i < 10; i++) {
        this.particleEmitter.emitParticleAt(
          shooterShip.x + dirX * 30,
          shooterShip.y + dirY * 30
        );
      }
    }
  }

  // Add method to play ball knocked effect
  playBallKnockedEffect(playerId) {
    // Find the ship that had the ball knocked loose
    let knockedShip;
    if (playerId === this.clientId) {
      knockedShip = this.ship;
    } else if (this.otherShips[playerId]) {
      knockedShip = this.otherShips[playerId];
    }
    
    if (!knockedShip) return;
    
    // Create a flash effect
    const flash = this.add.circle(knockedShip.x, knockedShip.y, 40, 0xff0000, 0.6);
    flash.setDepth(10);
    
    // Fade out and destroy
    this.tweens.add({
      targets: flash,
      alpha: 0,
      duration: 300,
      onComplete: () => {
        flash.destroy();
      }
    });
    
    // Add some particles to show the ball being knocked loose
    if (this.particleEmitter) {
      for (let i = 0; i < 20; i++) {
        // Emit particles in random directions
        const angle = Math.random() * Math.PI * 2;
        const distance = 30 + Math.random() * 20;
        const x = knockedShip.x + Math.cos(angle) * distance;
        const y = knockedShip.y + Math.sin(angle) * distance;
        
        this.particleEmitter.emitParticleAt(x, y);
      }
    }
    
    // Show a text notification
    const text = this.add.text(
      knockedShip.x, 
      knockedShip.y - 60, 
      'BALL KNOCKED LOOSE!', 
      { 
        fontFamily: 'Arial', 
        fontSize: 16, 
        color: '#ffffff',
        stroke: '#000000',
        strokeThickness: 3
      }
    ).setOrigin(0.5);
    
    // Animate the text upward and fade it out
    this.tweens.add({
      targets: text,
      y: text.y - 30,
      alpha: 0,
      duration: 1000,
      onComplete: () => {
        text.destroy();
      }
    });
  }

  setupControllerSupport() {
    console.log('Setting up controller support');
    
    // Initialize controller variables
    this.controllers = {};
    this.controllerConnected = false;
    
    // Create bound event handlers so we can remove them later
    this.handleGamepadConnected = (event) => {
      console.log(`Controller connected: ${event.gamepad.id}`);
      this.controllers[event.gamepad.index] = event.gamepad;
      this.controllerConnected = true;
      
      // Show notification when controller connects
      this.showNotification('Controller connected!', false);
    };
    
    this.handleGamepadDisconnected = (event) => {
      console.log(`Controller disconnected: ${event.gamepad.id}`);
      delete this.controllers[event.gamepad.index];
      
      // Check if any controllers are still connected
      this.controllerConnected = Object.keys(this.controllers).length > 0;
      
      // Reset input state when controller disconnects to prevent stuck inputs
      if (!this.controllerConnected) {
        this.inputState.left = false;
        this.inputState.right = false;
        this.inputState.up = false;
        this.inputState.down = false;
        this.inputState.boost = false;
        this.sendInput();
        
        // Show notification when controller disconnects
        this.showNotification('Controller disconnected', false);
      }
    };
    
    // Add event listeners for controller connection/disconnection
    window.addEventListener('gamepadconnected', this.handleGamepadConnected);
    window.addEventListener('gamepaddisconnected', this.handleGamepadDisconnected);
  }
  
  updateControllerInput() {
    // Skip if no controllers are connected
    if (!this.controllerConnected) return;
    
    // Get all connected gamepads
    const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
    
    // Process each connected gamepad
    for (const gamepad of gamepads) {
      if (!gamepad) continue;
      
      // Debug log controller info (only once per second)
      if (!this.lastControllerDebugTime || Date.now() - this.lastControllerDebugTime > 1000) {
        console.log(`Controller: ${gamepad.id}`);
        console.log(`Buttons: ${gamepad.buttons.length}, Axes: ${gamepad.axes.length}`);
        
        // Log all button states
        gamepad.buttons.forEach((button, index) => {
          if (button.pressed || button.value > 0.1) {
            console.log(`Button ${index}: pressed=${button.pressed}, value=${button.value}`);
          }
        });
        
        // Log all axes values
        gamepad.axes.forEach((axis, index) => {
          if (Math.abs(axis) > 0.1) {
            console.log(`Axis ${index}: ${axis}`);
          }
        });
        
        this.lastControllerDebugTime = Date.now();
      }
      
      // Store previous input state to detect changes
      const prevInputState = { ...this.inputState };
      
      // Left stick for movement (axes 0 and 1)
      const leftStickDeadzone = 0.2;
      const leftX = Math.abs(gamepad.axes[0]) > leftStickDeadzone ? gamepad.axes[0] : 0;
      const leftY = Math.abs(gamepad.axes[1]) > leftStickDeadzone ? gamepad.axes[1] : 0;
      
      // D-pad for movement (buttons 12-15)
      const dpadUp = gamepad.buttons[12] ? gamepad.buttons[12].pressed : false;
      const dpadDown = gamepad.buttons[13] ? gamepad.buttons[13].pressed : false;
      const dpadLeft = gamepad.buttons[14] ? gamepad.buttons[14].pressed : false;
      const dpadRight = gamepad.buttons[15] ? gamepad.buttons[15].pressed : false;
      
      // Update movement based on left stick and d-pad
      this.inputState.left = leftX < -leftStickDeadzone || dpadLeft;
      this.inputState.right = leftX > leftStickDeadzone || dpadRight;
      this.inputState.up = leftY < -leftStickDeadzone || dpadUp;
      this.inputState.down = leftY > leftStickDeadzone || dpadDown;
      
      // Check multiple possible trigger button indices for 8BitDo controllers
      // Left trigger could be 6, 4, or 8 depending on the controller mapping
      const leftTriggerOptions = [6, 4, 8, 10];
      let leftTriggerValue = 0;
      
      for (const buttonIndex of leftTriggerOptions) {
        if (gamepad.buttons[buttonIndex] && gamepad.buttons[buttonIndex].value > leftTriggerValue) {
          leftTriggerValue = gamepad.buttons[buttonIndex].value;
        }
      }
      
      // Also check for L button (typically button 4 or 6)
      const shootPressed = leftTriggerValue > 0.5 || gamepad.buttons[0].pressed;
      
      // Handle shooting with debounce
      if (shootPressed && !this.controllerShootPressed) {
        this.controllerShootPressed = true;
        this.inputState.shoot = true;
        this.sendInput();
        
        // Reset shoot flag after a short delay
        setTimeout(() => {
          this.inputState.shoot = false;
          this.sendInput();
        }, 100);
      } else if (!shootPressed) {
        this.controllerShootPressed = false;
      }
      
      // Check multiple possible trigger button indices for 8BitDo controllers
      // Right trigger could be 7, 5, or 9 depending on the controller mapping
      const rightTriggerOptions = [7, 5, 9, 11];
      let rightTriggerValue = 0;
      
      for (const buttonIndex of rightTriggerOptions) {
        if (gamepad.buttons[buttonIndex] && gamepad.buttons[buttonIndex].value > rightTriggerValue) {
          rightTriggerValue = gamepad.buttons[buttonIndex].value;
        }
      }
      
      // Also check for R button (typically button 5 or 7)
      const boostPressed = rightTriggerValue > 0.5 || gamepad.buttons[1].pressed;
      
      // Handle boost with debounce
      if (boostPressed && !this.controllerBoostPressed) {
        this.controllerBoostPressed = true;
        this.inputState.boost = true;
        this.sendInput();
        
        // Show visual feedback for projectile firing
        this.showNotification("Firing projectile!", false);
      } else if (!boostPressed && this.controllerBoostPressed) {
        this.controllerBoostPressed = false;
        this.inputState.boost = false;
        this.sendInput();
      }
      
      // Reset game with Start button (button 9) if player is host
      const startPressed = gamepad.buttons[9] ? gamepad.buttons[9].pressed : false;
      if (startPressed && !this.controllerStartPressed && this.isHost) {
        this.controllerStartPressed = true;
        this.resetGame();
      } else if (!startPressed) {
        this.controllerStartPressed = false;
      }
      
      // Send input if it changed
      if (
        prevInputState.left !== this.inputState.left ||
        prevInputState.right !== this.inputState.right ||
        prevInputState.up !== this.inputState.up ||
        prevInputState.down !== this.inputState.down ||
        prevInputState.boost !== this.inputState.boost
      ) {
        this.sendInput();
      }
      
      // Use right stick for aiming if available
      const rightStickDeadzone = 0.2;
      const rightX = Math.abs(gamepad.axes[2]) > rightStickDeadzone ? gamepad.axes[2] : 0;
      const rightY = Math.abs(gamepad.axes[3]) > rightStickDeadzone ? gamepad.axes[3] : 0;
      
      if (rightX !== 0 || rightY !== 0) {
        // Update aim target based on right stick
        this.aimTarget.x = this.ship.x + rightX * 200;
        this.aimTarget.y = this.ship.y + rightY * 200;
        
        // Update movement direction for aiming
        const mag = Math.sqrt(rightX * rightX + rightY * rightY);
        if (mag > 0) {
          this.movementDirection.x = rightX / mag;
          this.movementDirection.y = rightY / mag;
        }
        
        // Send updated input with new aim target
        this.sendInput();
      }
    }
  }
  
  // Add method to update rocket cooldown indicator
  updateRocketCooldown() {
    // Clear previous graphics
    this.rocketCooldownGraphics.clear();
    
    // Get rocket cooldown from server state
    const rocketCooldown = this.serverState.ship && this.serverState.ship.rocket_cooldown !== undefined 
      ? this.serverState.ship.rocket_cooldown 
      : 0;
    
    // Calculate cooldown ratio (0 to 1, where 0 is ready)
    const cooldownRatio = Math.min(rocketCooldown / 5.0, 1.0);
    
    if (cooldownRatio <= 0) {
      // Rocket is ready - show the rocket emoji
      if (this.rocketReadyText) {
        this.rocketReadyText.setVisible(true);
        this.rocketReadyText.x = this.ship.x;
        this.rocketReadyText.y = this.ship.y - 50;
        
        // Add a pulsing effect to the rocket emoji
        if (!this.rocketReadyTween || !this.rocketReadyTween.isPlaying()) {
          this.rocketReadyTween = this.tweens.add({
            targets: this.rocketReadyText,
            scale: { from: 1, to: 1.3 },
            alpha: { from: 0.7, to: 1 },
            duration: 800,
            yoyo: true,
            repeat: -1
          });
        }
      }
    } else {
      // Rocket is on cooldown - hide the emoji and show the cooldown circle
      if (this.rocketReadyText) {
        this.rocketReadyText.setVisible(false);
        if (this.rocketReadyTween && this.rocketReadyTween.isPlaying()) {
          this.rocketReadyTween.stop();
        }
      }
      
      // Draw cooldown circle
      const radius = 10;
      const startAngle = -Math.PI / 2; // Start at top
      const endAngle = startAngle + (1 - cooldownRatio) * Math.PI * 2; // Fill based on cooldown
      
      // Draw background circle (gray)
      this.rocketCooldownGraphics.lineStyle(2, 0x666666, 0.5);
      this.rocketCooldownGraphics.beginPath();
      this.rocketCooldownGraphics.arc(this.ship.x, this.ship.y - 50, radius, 0, Math.PI * 2);
      this.rocketCooldownGraphics.strokePath();
      
      // Draw filled portion (orange)
      if (cooldownRatio < 1) {
        this.rocketCooldownGraphics.lineStyle(3, 0xff9900, 0.8);
        this.rocketCooldownGraphics.beginPath();
        this.rocketCooldownGraphics.arc(this.ship.x, this.ship.y - 50, radius, startAngle, endAngle);
        this.rocketCooldownGraphics.strokePath();
      }
    }
  }
  
  // Add method to update rocket cooldown for other ships
  updateRemoteRocketCooldown(sprite, shipState) {
    // Clear previous graphics
    sprite.rocketCooldownGraphics.clear();
    
    // Get rocket cooldown from the latest game state
    let rocketCooldown = 0;
    if (this.latestGameState && this.latestGameState.players) {
      // Find the player ID for this sprite
      const playerId = Object.keys(this.otherShips).find(id => this.otherShips[id] === sprite);
      if (playerId && this.latestGameState.players[playerId]) {
        rocketCooldown = this.latestGameState.players[playerId].rocket_cooldown || 0;
      }
    }
    
    // Calculate cooldown ratio (0 to 1, where 0 is ready)
    const cooldownRatio = Math.min(rocketCooldown / 5.0, 1.0);
    
    if (cooldownRatio <= 0) {
      // Rocket is ready - show the rocket emoji
      if (sprite.rocketReadyText) {
        sprite.rocketReadyText.setVisible(true);
        sprite.rocketReadyText.x = sprite.x;
        sprite.rocketReadyText.y = sprite.y - 50;
        
        // Add a pulsing effect to the rocket emoji if not already pulsing
        if (!sprite.rocketReadyTween || !sprite.rocketReadyTween.isPlaying()) {
          sprite.rocketReadyTween = this.tweens.add({
            targets: sprite.rocketReadyText,
            scale: { from: 1, to: 1.3 },
            alpha: { from: 0.7, to: 1 },
            duration: 800,
            yoyo: true,
            repeat: -1
          });
        }
      }
    } else {
      // Rocket is on cooldown - hide the emoji and show the cooldown circle
      if (sprite.rocketReadyText) {
        sprite.rocketReadyText.setVisible(false);
        if (sprite.rocketReadyTween && sprite.rocketReadyTween.isPlaying()) {
          sprite.rocketReadyTween.stop();
        }
      }
      
      // Draw cooldown circle
      const radius = 10;
      const startAngle = -Math.PI / 2; // Start at top
      const endAngle = startAngle + (1 - cooldownRatio) * Math.PI * 2; // Fill based on cooldown
      
      // Draw background circle (gray)
      sprite.rocketCooldownGraphics.lineStyle(2, 0x666666, 0.5);
      sprite.rocketCooldownGraphics.beginPath();
      sprite.rocketCooldownGraphics.arc(sprite.x, sprite.y - 50, radius, 0, Math.PI * 2);
      sprite.rocketCooldownGraphics.strokePath();
      
      // Draw filled portion (orange)
      if (cooldownRatio < 1) {
        sprite.rocketCooldownGraphics.lineStyle(3, 0xff9900, 0.8);
        sprite.rocketCooldownGraphics.beginPath();
        sprite.rocketCooldownGraphics.arc(sprite.x, sprite.y - 50, radius, startAngle, endAngle);
        sprite.rocketCooldownGraphics.strokePath();
      }
    }
  }
}
  
const config = {
  type: Phaser.WEBGL,
  width: 1600,
  height: 1200,
  parent: 'game-container',
  scale: {
    mode: Phaser.Scale.RESIZE,  // Change to RESIZE for better adaptability
    autoCenter: Phaser.Scale.CENTER_BOTH,
    width: 1600,
    height: 1200,
    min: {
      width: 320,
      height: 240
    },
    max: {
      width: 4000,
      height: 3000
    },
    expandParent: true,
    fullscreenTarget: 'game-container'
  },
  physics: {
    default: 'arcade',
    arcade: { gravity: { y: 0 }, debug: false }
  },
  dom: {
    createContainer: true
  },
  plugins: {
    global: [
      {
        key: 'rexVirtualJoystick',
        plugin: rexvirtualjoystickplugin,
        start: true
      }
    ]
  },
  scene: MainScene
};
  
// Add fullscreen button for mobile
if (/Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)) {
  // Create fullscreen button after game loads
  window.addEventListener('DOMContentLoaded', () => {
    const fullscreenBtn = document.createElement('button');
    fullscreenBtn.innerHTML = '📱 Fullscreen';
    fullscreenBtn.style.position = 'absolute';
    fullscreenBtn.style.bottom = '10px';
    fullscreenBtn.style.right = '10px';
    fullscreenBtn.style.zIndex = '1000';
    fullscreenBtn.style.padding = '10px';
    fullscreenBtn.style.backgroundColor = '#4CAF50';
    fullscreenBtn.style.color = 'white';
    fullscreenBtn.style.border = 'none';
    fullscreenBtn.style.borderRadius = '5px';
    fullscreenBtn.style.fontSize = '16px';
    
    fullscreenBtn.addEventListener('click', () => {
      if (game.scale.isFullscreen) {
        game.scale.stopFullscreen();
      } else {
        game.scale.startFullscreen();
      }
    });
    
    document.getElementById('game-container').appendChild(fullscreenBtn);
  });
}

const game = new Phaser.Game(config);