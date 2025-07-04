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
    
    // Initialize game state
    this.clientId = null;
    this.otherShips = {};
    this.ballHistory = [];
    this.latestBallState = null;
    this.serverTimeOffset = null;
    this.pingValue = 0;
    this.playerCanMove = true;
    this.isMobile = false;
    this.isHost = false;
    this.playerTeam = null;
    this.team1Score = 0;
    this.team2Score = 0;
    this.team3Score = 0; // Yellow
    this.team4Score = 0; // Green
    this.reconnectAttempts = 0;
    this.connectionAttempt = 0;
    this.isConnecting = false; // Track if we're currently connecting
    this.connectionEstablished = false; // Track if we've successfully connected
    
    // Manual rotation tracking for mobile
    this.manualRotation = false;
    this.manualRotationTime = 0;
    
    // Input state
    this.inputState = {
      left: false,
      right: false,
      up: false,
      down: false,
      shoot: false,
      boost: false
    };
    
    // Ship and state
    this.ship = null;
    this.predictedState = { x: 400, y: 300 };
    this.serverState = { ship: { x: 400, y: 300, seq: 0 }, boost: 200 };
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
    this.movementDirection = { x: 1, y: 0 }; // Default direction (pointing east/right)
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
      }
    });
    
    // Add client ID tracking
    this.clientId = null;
    this.particleEmitter = null;
    this.lastInputTime = 0;
    this.pingValue = 0;
    this.team1Score = 0;
    this.team2Score = 0;
    this.team3Score = 0; // Yellow
    this.team4Score = 0; // Green
    this.playerTeam = null;
    this.particleEmitterCreated = false;
    
    // Detect mobile browser
    this.isMobile = this.detectMobile();
    if (this.isMobile) {
      // Log detection info for debugging
      console.log('Mobile browser detected');
    }
    
    // Add countdown text
    this.countdownText = null;
    
    // Mobile controls
    this.joystick = null;
    this.shootButton = null;
    this.boostButton = null;
    
    this.createTeamPieMenu = () => {
      // ... code ...
    };

    this.nextSequence = 0;
    this.lastPingTime = 0;
    this.pingInterval = 1000; // 1 second
    this.lastInputTime = 0;
    
    // Store current mouse world position for accurate shooting
    this.currentMouseWorldPos = { x: 400, y: 300 }; // Initialize to center of screen

    // Initialize team scores
    this.team1Score = 0;
  }
  
  // Detect if we're on a mobile device
  detectMobile() {
    // Check if the device has touch capabilities
    const hasTouchCapabilities = (
      'ontouchstart' in window || 
      navigator.maxTouchPoints > 0 || 
      navigator.msMaxTouchPoints > 0
    );
    
    // Log detection info for debugging
    console.log('Device detection:', {
      hasTouchCapabilities,
      maxTouchPoints: navigator.maxTouchPoints || 0,
      msMaxTouchPoints: navigator.msMaxTouchPoints || 0,
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      screenSize: `${window.innerWidth}x${window.innerHeight}`
    });
    
    // If the device has touch capabilities, use mobile controls
    return hasTouchCapabilities;
  }
  
  preload() {
    this.load.image('ship', 'assets/ship.png');
    this.load.image('ship_red', 'assets/ship.png');
    this.load.image('ship_blue', 'assets/ship.png');
    this.load.image('ball', 'assets/ball.png');
    this.load.image('spark', 'assets/ship_blue.png');
    this.load.image('cannon', 'assets/cannon.png'); // Add cannon sprite
    this.load.json('mapData', 'assets/soccer.json');
    this.load.image('wall', 'assets/wall.png');
    this.load.image('goal', 'assets/goal.png');
    this.load.atlas('flares', 'https://labs.phaser.io/assets/particles/flares.png', 'https://labs.phaser.io/assets/particles/flares.json');
    
    // Load ship.png as a single sprite image
    this.load.image('ship', 'assets/ship.png');
    
    // Load goal sound
    this.load.audio('goalSound', 'assets/goalsound.mp3');
    
    // Load shooting sound
    this.load.audio('shootSound', 'assets/shootingball.mp3');
    
    // Load rocket launch sound
    this.load.audio('rocketSound', 'assets/rocketlaunch.mp3');
    
    // Load explosion sound
    this.load.audio('explosionSound', 'assets/explosion.mp3');
    
    // Add load event listeners for debugging
    this.load.on('filecomplete-audio-goalSound', () => {
      console.log('✅ Goal sound loaded successfully!');
    });
    
    this.load.on('filecomplete-audio-shootSound', () => {
      console.log('✅ Shoot sound loaded successfully!');
    });
    
    this.load.on('filecomplete-audio-rocketSound', () => {
      console.log('✅ Rocket sound loaded successfully!');
    });
    
    this.load.on('filecomplete-audio-explosionSound', () => {
      console.log('✅ Explosion sound loaded successfully!');
    });
    
    this.load.on('loaderror', (file) => {
      if (file.key === 'goalSound') {
        console.error('❌ Failed to load goal sound:', file.src);
      } else if (file.key === 'shootSound') {
        console.error('❌ Failed to load shoot sound:', file.src);
      } else if (file.key === 'rocketSound') {
        console.error('❌ Failed to load rocket sound:', file.src);
      } else if (file.key === 'explosionSound') {
        console.error('❌ Failed to load explosion sound:', file.src);
      }
    });
  }
  
  // Helper function to detect soccer map (no Yellow/Green goals)
  detectSoccerMap(mapData) {
    if (!mapData) return false;
    
    // Check if there are any Yellow or Green goals
    const hasYellowGoals = mapData.some(obj => obj.type === 'goal_yellow');
    const hasGreenGoals = mapData.some(obj => obj.type === 'goal_green');
    
    // Soccer map = no Yellow or Green goals
    const isSoccer = !hasYellowGoals && !hasGreenGoals;
    console.log(`Map detection: Yellow goals: ${hasYellowGoals}, Green goals: ${hasGreenGoals}, Is soccer: ${isSoccer}`);
    
    return isSoccer;
  }

  // Helper function to hide Yellow and Green team buttons on soccer map
  hideYellowGreenTeamButtons() {
    console.log('Hiding Yellow and Green team buttons for soccer map');
    
    // Hide buttons in game.html
    const yellowButton = document.getElementById('join-yellow-team');
    const greenButton = document.getElementById('join-green-team');
    
    if (yellowButton) {
      yellowButton.style.display = 'none';
      console.log('Hidden Yellow team button');
    }
    
    if (greenButton) {
      greenButton.style.display = 'none';
      console.log('Hidden Green team button');
    }
    
    // Hide buttons in index.html if they exist
    const teamButtons = document.querySelectorAll('.team-yellow, .team-green');
    teamButtons.forEach(button => {
      button.style.display = 'none';
    });
  }

  // Ship animations removed - using single ship.png sprite
  
  create() {
    // Disable context menu so right click can be used for boost.
    this.input.mouse.disableContextMenu();
    
    // Get the current game size
    const gameSize = this.scale.gameSize;
    console.log(`Game size: ${gameSize.width}x${gameSize.height}`);
    
    // Check if we're on a mobile device and log it
    this.isMobile = this.detectMobile();
    console.log(`Device detected as ${this.isMobile ? 'mobile/touch' : 'desktop'}`);
    
    // Add resize event listener
    this.scale.on('resize', this.handleResize, this);
    
    // Background removed for testing purposes
    // this.backgroundGrid = this.createBackgroundGrid(6000, 6200);
    
    const mapData = this.cache.json.get('mapData');
    this.mapObjects = mapData;
    
    // Determine the current map name (for cornerdefense auto-shooting)
    this.currentMapName = 'soccer'; // Now using corner.json 
    this.isCornerDefenseMap = this.currentMapName === 'cornerdefense';
    
    // Detect if this is soccer map (no Yellow/Green goals)
    this.isSoccerMap = this.detectSoccerMap(mapData);
    console.log(`Current map: ${this.currentMapName}, Soccer map: ${this.isSoccerMap}, Server-side auto-shooting enabled: ${this.isCornerDefenseMap}`);
    
    // Hide Yellow and Green team buttons if on soccer map
    if (this.isSoccerMap) {
      this.hideYellowGreenTeamButtons();
    }
    
    // Auto-shooting state (client-side disabled for cornerdefense - server handles it)
    this.autoShootCooldown = 0;
    this.lastAutoShootTime = 0;
    this.useServerAutoShooting = true; // Use server-side auto-shooting for max speed
    
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
    const goalColors = {
      'goal_red': 0xff0000,
      'goal_blue': 0x0000ff,
      'goal_yellow': 0xffdc00,
      'goal_green': 0x00c800,
      'goal': 0xffffff // fallback for old maps
    };

    mapData.forEach(obj => {
      let sprite;
      if (obj.type === 'wall') {
        // Make walls significantly bigger to match server collision
        const wallPadding = 6; // Increased from 2 to 6 pixels on each side
        // Render walls as gray rectangles instead of image sprites
        sprite = this.add.rectangle(
          obj.x + obj.width/2, 
          obj.y + obj.height/2, 
          obj.width + wallPadding * 2, 
          obj.height + wallPadding * 2, 
          0x666666 // Dark gray color
        ).setOrigin(0.5);
      } else if (obj.type.startsWith('goal')) {
        const color = goalColors[obj.type] || 0xffffff;
        sprite = this.add.rectangle(
          obj.x + obj.width/2,
          obj.y + obj.height/2,
          obj.width,
          obj.height,
          color,
          0.5
        ).setOrigin(0.5);
      }
    });

    // Create a background that extends beyond the playable area
    const gameWidth = 2000;
    const gameHeight = 1200;
    const extendedWidth = gameWidth * 3;  // Increase from 1.5 to 2
    const extendedHeight = gameHeight * 3; // Increase from 1.5 to 2
    
    // Background removed for testing purposes
    // this.createBackgroundGrid(extendedWidth, extendedHeight);

    this.ship = this.add.sprite(400, 300, 'ship').setScale(0.1);
    this.ship.setDepth(10);
    
    // Add cannon sprite to the ship
    this.cannon = this.add.sprite(this.ship.x, this.ship.y, 'cannon');
    this.cannon.setScale(0.25);  // Match the scale with other ships' cannons
    this.cannon.setDepth(11);    // Above the ship
    this.cannon.setOrigin(0.3, 0.5); // Position it at the front of the ship
    
    // Initialize cannon position
    this.updateCannonPosition();
    
    this.ball = this.add.sprite(400, 400, 'ball').setScale(0.75).setOrigin(0.5);
    this.ball.setVisible(false);
    this.gravityCircle = this.add.graphics();
    
    // Create boost circle graphics
    this.boostCircle = this.add.graphics();
    
    // Create UI elements - hide debug info for mobile
    if (!this.isMobile) {
      this.pingText = this.add.text(10, 10, "Ping: -- ms", { font: "16px Arial", fill: "#ffffff" }).setScrollFactor(0);
      this.teamText = this.add.text(10, 70, "Team: --", { font: "16px Arial", fill: "#ffffff" }).setScrollFactor(0);
    } else {
      // For mobile, create hidden elements to avoid null reference errors
      this.pingText = this.add.text(10, 10, "", { font: "16px Arial", fill: "#ffffff" }).setScrollFactor(0).setVisible(false);
      this.teamText = this.add.text(10, 70, "", { font: "16px Arial", fill: "#ffffff" }).setScrollFactor(0).setVisible(false);
    }
    
    // Create score display with multiple text objects for different colors - hide for mobile since we use pie chart
    const scoreY = 40;
    this.scoreLabel = this.add.text(10, scoreY, "Score: ", { font: "16px Arial", fill: "#ffffff" }).setScrollFactor(0).setVisible(!this.isMobile);
    this.redScoreText = this.add.text(this.scoreLabel.x + this.scoreLabel.width, scoreY, "0", { font: "16px Arial", fill: "#ff0000" }).setScrollFactor(0).setVisible(!this.isMobile);
    this.scoreSeparator = this.add.text(this.redScoreText.x + this.redScoreText.width, scoreY, " - ", { font: "16px Arial", fill: "#ffffff" }).setScrollFactor(0).setVisible(!this.isMobile);
    this.blueScoreText = this.add.text(this.scoreSeparator.x + this.scoreSeparator.width, scoreY, "0", { font: "16px Arial", fill: "#0000ff" }).setScrollFactor(0).setVisible(!this.isMobile);
    
    // Initialize team scores for 4-team support
    this.team1Score = 0;
    this.team2Score = 0;
    this.team3Score = 0;
    this.team4Score = 0;
    
    // Create initial score pie chart
    this.createScorePieChart();
    
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
              this.playerNameText,
              this.scorePieChart, this.scorePieTitle
            ].filter(element => element !== undefined);
            
            // Also ignore score pie text elements if they exist
            if (this.scorePieTexts) {
              elementsToIgnore.push(...this.scorePieTexts.filter(element => element !== undefined));
            }
            
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
    
    // Close any existing socket before creating a new one
    if (window.gameSocket && window.gameSocket.readyState !== WebSocket.CLOSED) {
        console.log('Closing existing game socket');
        window.gameSocket.close();
    }
    
    // Reset connection tracking
    window.activeConnections = window.activeConnections || 0;
    
    // Connect immediately without delay
    this.connectionAttempt = 1;
    this.isConnecting = false;
    this.connectionEstablished = false;
    
    // Connect immediately
    this.connectToGameServer();
  }
  
  connectToGameServer() {
    // Prevent multiple simultaneous connection attempts
    if (this.isConnecting) {
        console.log('Already attempting to connect, skipping this attempt');
        return;
    }
    
    // If we're already connected, don't try to connect again
    if (this.connectionEstablished && this.socket && this.socket.readyState === WebSocket.OPEN) {
        console.log('Already connected, skipping connection attempt');
        return;
    }
    
    this.isConnecting = true;
    console.log(`Game server connection attempt #${this.connectionAttempt} (Active connections: ${window.activeConnections})`);
    
    // Close any existing socket before creating a new one
    if (window.gameSocket && window.gameSocket.readyState !== WebSocket.CLOSED) {
        console.log('Closing existing game socket');
        window.gameSocket.close();
        window.gameSocket = null;
    }
    
    // Clean up any existing socket
    if (this.socket) {
        if (this.socket.readyState !== WebSocket.CLOSED) {
            console.log('Closing existing socket');
            this.socket.close();
        }
        this.socket = null;
    }
    
    // Increment active connections counter
    window.activeConnections++;
    console.log(`Incremented active connections to ${window.activeConnections}`);
    
    // Connect to the WebSocket server
    try {
        // Simple WebSocket connection (exactly like working version)
        console.log('🔌 Connecting to WebSocket server:', window.WEBSOCKET_URL);
        this.socket = new WebSocket(window.WEBSOCKET_URL);
        window.gameSocket = this.socket; // Store reference for cleanup
        
        // Set up connection timeout
        if (this.connectionTimeout) {
            clearTimeout(this.connectionTimeout);
        }
        
        this.connectionTimeout = setTimeout(() => {
            if (this.socket && this.socket.readyState !== WebSocket.OPEN) {
                console.error(`Game socket connection timeout on attempt #${this.connectionAttempt}`);
                
                // Clean up this connection attempt
                this.cleanupConnection();
                
                // Retry with exponential backoff
                const retryDelay = Math.min(1000 * Math.pow(1.5, this.connectionAttempt), 10000);
                console.log(`Will retry in ${retryDelay/1000} seconds (attempt #${this.connectionAttempt + 1})`);
                
                this.connectionAttempt++;
                this.isConnecting = false;
                
                this.connectionTimeout = setTimeout(() => {
                    this.connectToGameServer();
                }, retryDelay);
                
                this.showConnectionError(`Connection attempt #${this.connectionAttempt-1} timed out. Retrying...`);
            }
        }, 5000 + (this.connectionAttempt * 1000)); // Increase timeout for later attempts
        
        this.socket.onopen = () => {
            console.log(`Connected to game server on attempt #${this.connectionAttempt}`);
            clearTimeout(this.connectionTimeout);
            
            // Mark as connected
            this.connectionEstablished = true;
            this.isConnecting = false;
            
            // Reset connection attempt counter
            this.connectionAttempt = 1;
            
            // Set up ping interval to keep connection alive
            if (this.pingInterval) {
                clearInterval(this.pingInterval);
            }
            
            this.pingInterval = setInterval(() => {
                if (this.socket && this.socket.readyState === WebSocket.OPEN) {
                    this.socket.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }));
                }
            }, this.isMobile ? 1000 : 2000);
            
            // Reset reconnection attempts on successful connection
            this.reconnectAttempts = 0;
            
            // Update connection status if the function exists
            if (typeof updateConnectionStatus === 'function') {
              updateConnectionStatus('connected', 'Connected to game server');
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
        };
        
        this.socket.onclose = (event) => {
            console.log(`WebSocket connection closed on attempt #${this.connectionAttempt}:`, event.code, event.reason);
            
            // Clean up this connection
            this.cleanupConnection();
            
            // Only retry if this wasn't a clean close and we haven't established a new connection
            if (event.code !== 1000 && event.code !== 1001 && !this.connectionEstablished) {
                // Retry with exponential backoff
                const retryDelay = Math.min(1000 * Math.pow(1.5, this.connectionAttempt), 10000);
                console.log(`Will retry in ${retryDelay/1000} seconds (attempt #${this.connectionAttempt + 1})`);
                
                this.connectionAttempt++;
                
                // Don't retry if we've tried too many times
                if (this.connectionAttempt > 5) {
                    console.log('Too many connection attempts, giving up');
                    this.showConnectionError('Could not connect after multiple attempts. Please refresh the page.');
                    return;
                }
                
                this.connectionTimeout = setTimeout(() => {
                    this.isConnecting = false;
                    this.connectToGameServer();
                }, retryDelay);
                
                this.showConnectionError(`Connection closed. Retrying in ${Math.round(retryDelay/1000)} seconds...`);
            } else {
                this.showConnectionError('Connection closed. Please refresh the page to reconnect.');
            }
        };
        
        this.socket.onerror = (error) => {
            console.error(`WebSocket error on attempt #${this.connectionAttempt}:`, error);
            // Error handling is done in the onclose handler
        };
        
        this.socket.addEventListener('message', (event) => {
          try {
            // Debug: Log ALL incoming data
            console.log('🔌 Raw WebSocket data received:', event.data);
            
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
              
              // Log all received messages for debugging (remove later)
              if (msg.type) {
                console.log('📨 Received message type:', msg.type, msg);
              }
              
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
                console.log('🆔 Assigned client ID:', this.clientId, 'Team:', this.playerTeam, 'Host:', this.isHost);
                console.log('🔗 Connection established, should receive goal messages for client ID:', this.clientId);
                
                // WebTransport integration commented out - using dual WebSocket approach
                // Note: WebTransport will be re-enabled when API compatibility issues are resolved
                console.log('🔌 Using dual WebSocket approach for enhanced performance');
                
                // Update team text and ship color
                this.updateTeamDisplay();
                if (this.playerTeam === 'red') {
                  this.ship.setTint(0xff0000);
                } else if (this.playerTeam === 'blue') {
                  this.ship.setTint(0x0000ff);
                } else if (this.playerTeam === 'yellow') {
                  this.ship.setTint(0xffdc00);
                } else if (this.playerTeam === 'green') {
                  this.ship.setTint(0x00c800);
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
                console.log("🎯 GOAL EVENT RECEIVED (First Handler):", msg);
                console.log("🎯 Goal event details:", {
                  type: msg.type,
                  team1_score: msg.team1_score,
                  team2_score: msg.team2_score,
                  scored_on_team: msg.scored_on_team,
                  scorer_name: msg.scorer_name
                });
                this.team1Score = msg.team1_score;
                this.team2Score = msg.team2_score;
                this.team3Score = msg.team3_score || 0;
                this.team4Score = msg.team4_score || 0;
                this.updateScoreDisplay();
                
                // Show goal message with scorer name
                if (msg.scored_on_team) {
                  const goalColor = msg.scored_on_team.toLowerCase();
                  const scorerName = msg.scorer_name || "Unknown Player";
                  const notificationMessage = `${scorerName} scored on ${goalColor} goal! ${msg.scored_on_team} team gets exclusive ball access.`;
                  console.log("SHOWING GOAL NOTIFICATION:", notificationMessage);
                  this.showNotification(notificationMessage, false);
                  
                  // Play goal sound - back to working approach
                  try {
                    console.log('🎵 Playing goal sound for real goal...');
                    // Use the approach that was working - call testGoalSound directly
                    if (window.testGoalSound) {
                      window.testGoalSound();
                      console.log('✅ Called working testGoalSound for real goal');
                    } else {
                      console.error('❌ testGoalSound not available, trying new method');
                      this.playGoalSound();
                    }
                  } catch (soundError) {
                    console.error('❌ Goal sound error:', soundError);
                  }
                }
                
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
                
                // Handle enhanced projectile data if available
                if (msg.projectile) {
                  console.log('🚀 Received enhanced projectile data:', msg.projectile);
                  this.handleFastProjectileCreation(msg.projectile);
                }
                return;
              }
              
              // Handle fast projectile position updates
              if (msg.type === 'projectile_positions') {
                console.log('⚡ Received fast projectile positions update:', msg.projectiles);
                this.handleFastProjectileUpdates(msg.projectiles);
                return;
              }
              
              // Handle explosion message
              if (msg.type === 'explosion') {
                // Play explosion effect (check for enhanced rocket collision explosions)
                const isEnhanced = msg.enhanced === true;
                console.log(`💥 Received explosion event - Enhanced: ${isEnhanced}, Radius: ${msg.radius}`);
                this.playExplosionEffect(msg.x, msg.y, msg.radius, msg.player_id, isEnhanced);
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
        
            // Initialize audio volume controls
    this.audioVolumes = {
      goal: 0.8,        // Goal sound volume
      shoot: 0.3,       // Ball shooting sound volume  
      rocket: 0.9,      // Rocket launch sound volume
      explosion: 0.3    // Explosion sound volume
    };
    
    // Initialize audio on first user interaction
    this.initializeAudio();
    } catch (error) {
        console.error('Error creating WebSocket:', error);
        this.cleanupConnection();
        
        // Retry after a delay
        setTimeout(() => {
            this.isConnecting = false;
            this.connectToGameServer();
        }, 2000);
    }
  }
  
  // Helper method to clean up connection resources
  cleanupConnection() {
    // Clear timeouts and intervals
    if (this.connectionTimeout) {
        clearTimeout(this.connectionTimeout);
        this.connectionTimeout = null;
    }
    
    if (this.pingInterval) {
        clearInterval(this.pingInterval);
        this.pingInterval = null;
    }
    
    // Decrement active connections counter
    if (window.activeConnections > 0) {
        window.activeConnections--;
        console.log(`Decremented active connections to ${window.activeConnections}`);
    }
    
    // Reset connection state
    this.isConnecting = false;
  }
  
  // Initialize audio system - required for browser audio policies
  initializeAudio() {
    console.log('🔊 Initializing audio system...');
    
    // Add a one-time click listener to enable audio
    const enableAudio = () => {
      console.log('🎵 User interaction detected, enabling audio...');
      
      if (this.sound && this.sound.context) {
        if (this.sound.context.state === 'suspended') {
          this.sound.context.resume().then(() => {
            console.log('✅ Audio context resumed and ready!');
          }).catch(err => {
            console.error('❌ Failed to resume audio context:', err);
          });
        } else {
          console.log('✅ Audio context already running!');
        }
      }
      
      // Remove the listener after first use
      document.removeEventListener('click', enableAudio);
      document.removeEventListener('keydown', enableAudio);
      document.removeEventListener('touchstart', enableAudio);
    };
    
    // Listen for any user interaction to enable audio
    document.addEventListener('click', enableAudio);
    document.addEventListener('keydown', enableAudio);
    document.addEventListener('touchstart', enableAudio);
    
    // Make test function available globally - back to working version
    window.testGoalSound = () => {
      console.log('🧪 Testing goal sound...');
      const gameInstance = window.gameInstance;
      console.log('Audio context state:', gameInstance?.sound?.context?.state);
      console.log('Sound manager exists:', !!gameInstance?.sound);
      console.log('Goal sound exists:', !!gameInstance?.sound?.get('goalSound'));
      
      // ALWAYS force resume audio context first
      if (gameInstance?.sound?.context) {
        console.log('🔄 Force resuming audio context for test...');
        return gameInstance.sound.context.resume().then(() => {
          console.log('✅ Audio context resumed for test, new state:', gameInstance.sound.context.state);
          const testSound = gameInstance.sound.play('goalSound', { volume: gameInstance.audioVolumes.goal });
          console.log('Test sound object:', testSound);
          return testSound;
        }).catch(err => {
          console.error('❌ Failed to resume audio context for test:', err);
          // Try anyway
          const testSound = gameInstance.sound.play('goalSound', { volume: gameInstance.audioVolumes.goal });
          console.log('Test sound object (after error):', testSound);
          return testSound;
        });
      } else if (gameInstance?.sound && gameInstance.sound.get('goalSound')) {
        const testSound = gameInstance.sound.play('goalSound', { volume: gameInstance.audioVolumes.goal });
        console.log('Test sound object (no context):', testSound);
        console.log('Audio context state after play:', gameInstance?.sound?.context?.state);
        return testSound;
      } else {
        console.error('Goal sound not available for testing');
        return null;
      }
    };
    
    // Add test function for shoot sound
    window.testShootSound = () => {
      console.log('🧪 Testing shoot sound...');
      const gameInstance = window.gameInstance;
      console.log('Audio context state:', gameInstance?.sound?.context?.state);
      console.log('Sound manager exists:', !!gameInstance?.sound);
      console.log('Shoot sound exists:', !!gameInstance?.sound?.get('shootSound'));
      
      // ALWAYS force resume audio context first
      if (gameInstance?.sound?.context) {
        console.log('🔄 Force resuming audio context for shoot test...');
        return gameInstance.sound.context.resume().then(() => {
          console.log('✅ Audio context resumed for shoot test, new state:', gameInstance.sound.context.state);
          const testSound = gameInstance.sound.play('shootSound', { volume: gameInstance.audioVolumes.shoot });
          console.log('Test shoot sound object:', testSound);
          return testSound;
        }).catch(err => {
          console.error('❌ Failed to resume audio context for shoot test:', err);
          // Try anyway
          const testSound = gameInstance.sound.play('shootSound', { volume: gameInstance.audioVolumes.shoot });
          console.log('Test shoot sound object (after error):', testSound);
          return testSound;
        });
      } else if (gameInstance?.sound && gameInstance.sound.get('shootSound')) {
        const testSound = gameInstance.sound.play('shootSound', { volume: gameInstance.audioVolumes.shoot });
        console.log('Test shoot sound object (no context):', testSound);
        console.log('Audio context state after play:', gameInstance?.sound?.context?.state);
        return testSound;
      } else {
        console.error('Shoot sound not available for testing');
        return null;
      }
    };
    
    // Add test function for rocket sound
    window.testRocketSound = () => {
      console.log('🧪 Testing rocket sound...');
      const gameInstance = window.gameInstance;
      console.log('Audio context state:', gameInstance?.sound?.context?.state);
      console.log('Sound manager exists:', !!gameInstance?.sound);
      console.log('Rocket sound exists:', !!gameInstance?.sound?.get('rocketSound'));
      
      // ALWAYS force resume audio context first
      if (gameInstance?.sound?.context) {
        console.log('🔄 Force resuming audio context for rocket test...');
        return gameInstance.sound.context.resume().then(() => {
          console.log('✅ Audio context resumed for rocket test, new state:', gameInstance.sound.context.state);
          const testSound = gameInstance.sound.play('rocketSound', { volume: gameInstance.audioVolumes.rocket });
          console.log('Test rocket sound object:', testSound);
          return testSound;
        }).catch(err => {
          console.error('❌ Failed to resume audio context for rocket test:', err);
          // Try anyway
          const testSound = gameInstance.sound.play('rocketSound', { volume: gameInstance.audioVolumes.rocket });
          console.log('Test rocket sound object (after error):', testSound);
          return testSound;
        });
      } else if (gameInstance?.sound && gameInstance.sound.get('rocketSound')) {
        const testSound = gameInstance.sound.play('rocketSound', { volume: gameInstance.audioVolumes.rocket });
        console.log('Test rocket sound object (no context):', testSound);
        console.log('Audio context state after play:', gameInstance?.sound?.context?.state);
        return testSound;
      } else {
        console.error('Rocket sound not available for testing');
        return null;
      }
    };
    
    // Add test function for explosion sound
    window.testExplosionSound = () => {
      console.log('🧪 Testing explosion sound...');
      const gameInstance = window.gameInstance;
      console.log('Audio context state:', gameInstance?.sound?.context?.state);
      console.log('Sound manager exists:', !!gameInstance?.sound);
      console.log('Explosion sound exists:', !!gameInstance?.sound?.get('explosionSound'));
      
      // ALWAYS force resume audio context first
      if (gameInstance?.sound?.context) {
        console.log('🔄 Force resuming audio context for explosion test...');
        return gameInstance.sound.context.resume().then(() => {
          console.log('✅ Audio context resumed for explosion test, new state:', gameInstance.sound.context.state);
          const testSound = gameInstance.sound.play('explosionSound', { volume: gameInstance.audioVolumes.explosion });
          console.log('Test explosion sound object:', testSound);
          return testSound;
        }).catch(err => {
          console.error('❌ Failed to resume audio context for explosion test:', err);
          // Try anyway
          const testSound = gameInstance.sound.play('explosionSound', { volume: gameInstance.audioVolumes.explosion });
          console.log('Test explosion sound object (after error):', testSound);
          return testSound;
        });
      } else if (gameInstance?.sound && gameInstance.sound.get('explosionSound')) {
        const testSound = gameInstance.sound.play('explosionSound', { volume: gameInstance.audioVolumes.explosion });
        console.log('Test explosion sound object (no context):', testSound);
        console.log('Audio context state after play:', gameInstance?.sound?.context?.state);
        return testSound;
      } else {
        console.error('Explosion sound not available for testing');
        return null;
      }
    };
    
          console.log('💡 To test goal sound manually, type: window.testGoalSound()');
      console.log('💡 To test shoot sound manually, type: window.testShootSound()');
      console.log('💡 To test rocket sound manually, type: window.testRocketSound()');
      console.log('💡 To test explosion sound manually, type: window.testExplosionSound()');
      console.log('💡 To enable audio manually, type: window.enableAudio()');
      console.log('💡 To test goal event manually, type: window.testGoalEvent()');
      console.log('🔊 VOLUME CONTROLS:');
      console.log('💡 Set goal volume: window.setGoalVolume(0.5)');
      console.log('💡 Set shoot volume: window.setShootVolume(0.3)');
      console.log('💡 Set rocket volume: window.setRocketVolume(0.5)');
      console.log('💡 Set explosion volume: window.setExplosionVolume(0.6)');
      console.log('💡 Set all volumes: window.setAllVolumes(0.4)');
      console.log('💡 Show current volumes: window.showVolumes()');
    
    // Add manual goal event test - FIXED: Using regular function to preserve `this` context
    window.testGoalEvent = function() {
      console.log('🧪 Testing goal event handler manually...');
      const gameInstance = window.gameInstance; // Get the game instance explicitly
      const fakeGoalMsg = {
        type: "goal",
        scored_on_team: "Red",
        scorer_name: "Test Player",
        team1_score: 1,
        team2_score: 0,
        team3_score: 0,
        team4_score: 0
      };
      
      console.log('📨 Simulating goal message:', fakeGoalMsg);
      console.log('🎮 Game instance:', !!gameInstance);
      console.log('🎵 Sound manager:', !!gameInstance?.sound);
      
      // Call the goal handler directly
      try {
        gameInstance.team1Score = fakeGoalMsg.team1_score;
        gameInstance.team2Score = fakeGoalMsg.team2_score;
        gameInstance.team3Score = fakeGoalMsg.team3_score || 0;
        gameInstance.team4Score = fakeGoalMsg.team4_score || 0;
        gameInstance.updateScoreDisplay();
        
        // Test the sound part
        if (fakeGoalMsg.scored_on_team) {
          const goalColor = fakeGoalMsg.scored_on_team.toLowerCase();
          const scorerName = fakeGoalMsg.scorer_name || "Unknown Player";
          const notificationMessage = `${scorerName} scored on ${goalColor} goal! ${fakeGoalMsg.scored_on_team} team gets exclusive ball access.`;
          console.log("SHOWING GOAL NOTIFICATION:", notificationMessage);
          gameInstance.showNotification(notificationMessage, false);
          
          // Play goal sound - back to working approach
          try {
            console.log('🎵 Playing goal sound for test goal event...');
            if (window.testGoalSound) {
              window.testGoalSound();
              console.log('✅ Called working testGoalSound for test goal event');
            } else {
              console.error('❌ testGoalSound not available');
            }
          } catch (soundError) {
            console.error('❌ Goal sound error in test:', soundError);
          }
        }
        
        console.log('✅ Manual goal event test completed');
        return true;
      } catch (error) {
        console.error('❌ Manual goal event test failed:', error);
        return false;
      }
    };
    
    // Add manual audio enabler
    window.enableAudio = () => {
      console.log('🎵 Manually enabling audio...');
      if (this.sound?.context) {
        console.log('Current audio context state:', this.sound.context.state);
        if (this.sound.context.state === 'suspended') {
          return this.sound.context.resume().then(() => {
            console.log('✅ Audio context manually resumed!');
            console.log('New audio context state:', this.sound.context.state);
            return true;
          }).catch(err => {
            console.error('❌ Failed to manually resume audio context:', err);
            return false;
          });
        } else {
          console.log('✅ Audio context already running!');
          return Promise.resolve(true);
        }
      } else {
        console.error('❌ No audio context available');
        return Promise.resolve(false);
      }
    };
    
    // Add volume control functions
    window.setGoalVolume = (volume) => {
      const gameInstance = window.gameInstance;
      if (gameInstance && gameInstance.audioVolumes) {
        const newVolume = Math.max(0, Math.min(1, volume)); // Clamp between 0 and 1
        gameInstance.audioVolumes.goal = newVolume;
        console.log(`🎯 Goal volume set to: ${newVolume}`);
        return newVolume;
      } else {
        console.error('❌ Game instance not available');
        return null;
      }
    };
    
    window.setShootVolume = (volume) => {
      const gameInstance = window.gameInstance;
      if (gameInstance && gameInstance.audioVolumes) {
        const newVolume = Math.max(0, Math.min(1, volume)); // Clamp between 0 and 1
        gameInstance.audioVolumes.shoot = newVolume;
        console.log(`🏀 Shoot volume set to: ${newVolume}`);
        return newVolume;
      } else {
        console.error('❌ Game instance not available');
        return null;
      }
    };
    
    window.setRocketVolume = (volume) => {
      const gameInstance = window.gameInstance;
      if (gameInstance && gameInstance.audioVolumes) {
        const newVolume = Math.max(0, Math.min(1, volume)); // Clamp between 0 and 1
        gameInstance.audioVolumes.rocket = newVolume;
        console.log(`🚀 Rocket volume set to: ${newVolume}`);
        return newVolume;
      } else {
        console.error('❌ Game instance not available');
        return null;
      }
    };
    
    window.setExplosionVolume = (volume) => {
      const gameInstance = window.gameInstance;
      if (gameInstance && gameInstance.audioVolumes) {
        const newVolume = Math.max(0, Math.min(1, volume)); // Clamp between 0 and 1
        gameInstance.audioVolumes.explosion = newVolume;
        console.log(`💥 Explosion volume set to: ${newVolume}`);
        return newVolume;
      } else {
        console.error('❌ Game instance not available');
        return null;
      }
    };
    
    window.showVolumes = () => {
      const gameInstance = window.gameInstance;
      if (gameInstance && gameInstance.audioVolumes) {
        console.log('🔊 Current Audio Volumes:');
        console.log(`🎯 Goal: ${gameInstance.audioVolumes.goal}`);
        console.log(`🏀 Shoot: ${gameInstance.audioVolumes.shoot}`);
        console.log(`🚀 Rocket: ${gameInstance.audioVolumes.rocket}`);
        console.log(`💥 Explosion: ${gameInstance.audioVolumes.explosion}`);
        return gameInstance.audioVolumes;
      } else {
        console.error('❌ Game instance not available');
        return null;
      }
    };
    
    window.setAllVolumes = (volume) => {
      const gameInstance = window.gameInstance;
      if (gameInstance && gameInstance.audioVolumes) {
        const newVolume = Math.max(0, Math.min(1, volume)); // Clamp between 0 and 1
        gameInstance.audioVolumes.goal = newVolume;
        gameInstance.audioVolumes.shoot = newVolume;
        gameInstance.audioVolumes.rocket = newVolume;
        gameInstance.audioVolumes.explosion = newVolume;
        console.log(`🔊 All volumes set to: ${newVolume}`);
        window.showVolumes(); // Show the new volumes
        return newVolume;
      } else {
        console.error('❌ Game instance not available');
        return null;
      }
    };
  }
  
  // Clean goal sound method - uses the working approach
  playGoalSound() {
    console.log('🎯 GOAL! Playing goal sound...');
    
    // Use the approach that works - get game instance explicitly
    const gameInstance = window.gameInstance || this;
    
    if (gameInstance?.sound?.context) {
      console.log('🔄 Resuming audio context for goal...');
      gameInstance.sound.context.resume().then(() => {
        console.log('✅ Audio context resumed, playing goal sound');
        if (gameInstance.sound && gameInstance.sound.get('goalSound')) {
          const goalSound = gameInstance.sound.play('goalSound', { 
            volume: gameInstance.audioVolumes.goal,
            detune: 0,
            rate: 1
          });
          console.log('🔊 Goal sound played successfully at volume:', gameInstance.audioVolumes.goal);
        } else {
          console.warn('⚠️ Goal sound not available');
        }
      }).catch(err => {
        console.error('❌ Failed to resume audio context:', err);
        // Try playing anyway
        if (gameInstance.sound && gameInstance.sound.get('goalSound')) {
          gameInstance.sound.play('goalSound', { volume: gameInstance.audioVolumes.goal });
        }
      });
    } else {
      console.error('❌ No audio context available for goal sound');
    }
  }
  
  // Clean shoot sound method - uses the same working approach
  playShootSound() {
    console.log('🏀 SHOOT! Playing shoot sound...');
    
    // Use the approach that works - get game instance explicitly
    const gameInstance = window.gameInstance || this;
    
    if (gameInstance?.sound?.context) {
      console.log('🔄 Resuming audio context for shoot...');
      gameInstance.sound.context.resume().then(() => {
        console.log('✅ Audio context resumed, playing shoot sound');
        if (gameInstance.sound && gameInstance.sound.get('shootSound')) {
          const shootSound = gameInstance.sound.play('shootSound', { 
            volume: gameInstance.audioVolumes.shoot,
            detune: 0,
            rate: 1
          });
          console.log('🔊 Shoot sound played successfully at volume:', gameInstance.audioVolumes.shoot);
        } else {
          console.warn('⚠️ Shoot sound not available');
        }
      }).catch(err => {
        console.error('❌ Failed to resume audio context:', err);
        // Try playing anyway
        if (gameInstance.sound && gameInstance.sound.get('shootSound')) {
          gameInstance.sound.play('shootSound', { volume: gameInstance.audioVolumes.shoot });
        }
      });
    } else {
      console.error('❌ No audio context available for shoot sound');
    }
  }
  
  // Clean rocket sound method - uses the same working approach
  playRocketSound() {
    console.log('🚀 ROCKET! Playing rocket launch sound...');
    
    // Use the approach that works - get game instance explicitly
    const gameInstance = window.gameInstance || this;
    
    if (gameInstance?.sound?.context) {
      console.log('🔄 Resuming audio context for rocket...');
      gameInstance.sound.context.resume().then(() => {
        console.log('✅ Audio context resumed, playing rocket sound');
        if (gameInstance.sound && gameInstance.sound.get('rocketSound')) {
          const rocketSound = gameInstance.sound.play('rocketSound', { 
            volume: gameInstance.audioVolumes.rocket,
            detune: 0,
            rate: 1
          });
          console.log('🔊 Rocket sound played successfully at volume:', gameInstance.audioVolumes.rocket);
        } else {
          console.warn('⚠️ Rocket sound not available');
        }
      }).catch(err => {
        console.error('❌ Failed to resume audio context:', err);
        // Try playing anyway
        if (gameInstance.sound && gameInstance.sound.get('rocketSound')) {
          gameInstance.sound.play('rocketSound', { volume: gameInstance.audioVolumes.rocket });
        }
      });
    } else {
      console.error('❌ No audio context available for rocket sound');
    }
  }
  
  // Clean explosion sound method - uses the same working approach
  playExplosionSound() {
    console.log('💥 BOOM! Playing explosion sound...');
    
    // Use the approach that works - get game instance explicitly
    const gameInstance = window.gameInstance || this;
    
    if (gameInstance?.sound?.context) {
      console.log('🔄 Resuming audio context for explosion...');
      gameInstance.sound.context.resume().then(() => {
        console.log('✅ Audio context resumed, playing explosion sound');
        if (gameInstance.sound && gameInstance.sound.get('explosionSound')) {
          const explosionSound = gameInstance.sound.play('explosionSound', { 
            volume: gameInstance.audioVolumes.explosion,
            detune: 0,
            rate: 1
          });
          console.log('🔊 Explosion sound played successfully at volume:', gameInstance.audioVolumes.explosion);
        } else {
          console.warn('⚠️ Explosion sound not available');
        }
      }).catch(err => {
        console.error('❌ Failed to resume audio context:', err);
        // Try playing anyway
        if (gameInstance.sound && gameInstance.sound.get('explosionSound')) {
          gameInstance.sound.play('explosionSound', { volume: gameInstance.audioVolumes.explosion });
        }
      });
    } else {
      console.error('❌ No audio context available for explosion sound');
    }
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
      // Skip manual shooting for cornerdefense map (auto-shooting enabled)
      if (this.isCornerDefenseMap) {
        console.log('Manual shooting disabled for cornerdefense map (auto-shooting active)');
        return;
      }
      
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
        // Skip manual shooting for cornerdefense map (auto-shooting enabled)
        if (this.isCornerDefenseMap) {
          console.log('Manual shooting disabled for cornerdefense map (auto-shooting active)');
          return;
        }
        
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
        // this.showNotification("Firing projectile!", false);
        
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
      
      // For cornerdefense map, log mouse tracking for server auto-shooting
      if (this.isCornerDefenseMap && this.useServerAutoShooting) {
        console.log('Mouse tracking for server auto-shoot:', worldPoint.x.toFixed(1), worldPoint.y.toFixed(1));
      }
    });
  }
  
  setupMobileControls() {
    console.log('🎮 Setting up dual-joystick mobile controls');
    
    // Get screen dimensions
    const width = this.scale.width;
    const height = this.scale.height;
    console.log('📱 Screen dimensions:', width, 'x', height);
    
    // Joystick dimensions
    const baseRadius = 50;
    const thumbRadius = 25;
    
    // === LEFT JOYSTICK (MOVEMENT) ===
    this.leftJoystickContainer = this.add.container(0, 0);
    this.leftJoystickContainer.setScrollFactor(0);
    this.leftJoystickContainer.setDepth(1000);
    
    this.leftJoystickBase = this.add.circle(0, 0, baseRadius, 0x444444, 0.6);
    this.leftJoystickThumb = this.add.circle(0, 0, thumbRadius, 0x888888, 0.8);
    
    this.leftJoystickContainer.add([this.leftJoystickBase, this.leftJoystickThumb]);
    this.leftJoystickContainer.setVisible(false);
    
    // Left joystick state
    this.leftJoystickActive = false;
    this.leftJoystickTouchId = null;
    this.leftJoystickStartX = 0;
    this.leftJoystickStartY = 0;
    this.leftJoystickForceX = 0;
    this.leftJoystickForceY = 0;
    this.leftJoystickMaxDistance = baseRadius;
    
    // Touch-to-aim system - no right joystick needed
    
    // Add label for movement joystick
    this.leftJoystickLabel = this.add.text(0, 0, 'MOVE', {
      fontSize: '12px',
      color: '#ffffff',
      stroke: '#000000',
      strokeThickness: 2
    }).setOrigin(0.5).setScrollFactor(0).setDepth(1001).setVisible(false);
    
    // Add touch instruction text
    this.touchInstructionText = this.add.text(width * 0.75, height - 80, 'Touch anywhere\nto aim & shoot', {
      fontSize: '12px',
      color: '#ffffff',
      stroke: '#000000',
      strokeThickness: 1,
      align: 'center'
    }).setOrigin(0.5).setScrollFactor(0).setDepth(1001);
    
    // Enable multi-touch
    this.input.addPointer(3); // Support up to 4 touches
    
    // === POINTER DOWN HANDLER ===
    this.input.on('pointerdown', (pointer) => {
      const leftSide = pointer.x < width / 2;
      
      // LEFT SIDE - Movement joystick
      if (leftSide && !this.leftJoystickActive) {
        console.log('🕹️ Left joystick activated at', pointer.x, pointer.y, 'touchID:', pointer.id);
        
        this.leftJoystickStartX = pointer.x;
        this.leftJoystickStartY = pointer.y;
        this.leftJoystickContainer.setPosition(this.leftJoystickStartX, this.leftJoystickStartY);
        this.leftJoystickThumb.setPosition(0, 0);
        this.leftJoystickContainer.setVisible(true);
        
        // Position label
        this.leftJoystickLabel.setPosition(this.leftJoystickStartX, this.leftJoystickStartY - 70);
        this.leftJoystickLabel.setVisible(true);
        
        this.leftJoystickTouchId = pointer.id;
        this.leftJoystickActive = true;
        console.log('✅ Left joystick ready');
        return;
      }
      
      // ANYWHERE ELSE - Touch to aim and shoot (cannon barely moves with ship)
      console.log('🎯 Touch to aim and shoot at', pointer.x, pointer.y);
      this.handleTouchAimAndShoot(pointer);
      
      // Touch handled by touch-to-aim system
    });
    
    // === POINTER MOVE HANDLER ===
    this.input.on('pointermove', (pointer) => {
      // Update left joystick
      if (this.leftJoystickActive && pointer.id === this.leftJoystickTouchId) {
        this.updateLeftJoystick(pointer);
      }
      
      // For non-joystick touches, update aim as they drag
      if (!this.leftJoystickActive || pointer.id !== this.leftJoystickTouchId) {
        this.updateTouchAim(pointer);
      }
    });
    
    // === POINTER UP HANDLER ===
    this.input.on('pointerup', (pointer) => {
      // Release left joystick
      if (this.leftJoystickActive && pointer.id === this.leftJoystickTouchId) {
        console.log('Left joystick released');
        this.leftJoystickContainer.setVisible(false);
        this.leftJoystickLabel.setVisible(false);
        this.leftJoystickActive = false;
        this.leftJoystickTouchId = null;
        this.leftJoystickForceX = 0;
        this.leftJoystickForceY = 0;
        
        // Reset movement input
        this.inputState.left = false;
        this.inputState.right = false;
        this.inputState.up = false;
        this.inputState.down = false;
        this.sendInput();
      }
    });
    
    // === POINTER CANCEL HANDLER ===
    this.input.on('pointercancel', (pointer) => {
      // Same as pointerup but for cancelled touches
      if (this.leftJoystickActive && pointer.id === this.leftJoystickTouchId) {
        this.leftJoystickContainer.setVisible(false);
        this.leftJoystickLabel.setVisible(false);
        this.leftJoystickActive = false;
        this.leftJoystickTouchId = null;
        this.leftJoystickForceX = 0;
        this.leftJoystickForceY = 0;
        
        this.inputState.left = false;
        this.inputState.right = false;
        this.inputState.up = false;
        this.inputState.down = false;
        this.sendInput();
      }
    });
  }
  
  // Helper method to update left joystick (movement)
  updateLeftJoystick(pointer) {
    const dx = pointer.x - this.leftJoystickStartX;
    const dy = pointer.y - this.leftJoystickStartY;
    const distance = Math.sqrt(dx * dx + dy * dy);
    
    this.leftJoystickForceX = dx / this.leftJoystickMaxDistance;
    this.leftJoystickForceY = dy / this.leftJoystickMaxDistance;
    
    // Limit thumb position
    let thumbX = dx;
    let thumbY = dy;
    
    if (distance > this.leftJoystickMaxDistance) {
      const angle = Math.atan2(dy, dx);
      thumbX = Math.cos(angle) * this.leftJoystickMaxDistance;
      thumbY = Math.sin(angle) * this.leftJoystickMaxDistance;
    }
    
    this.leftJoystickThumb.setPosition(thumbX, thumbY);
    
    // D-PAD STYLE: Convert analog input to discrete digital directions
    // Reset all directions first
    this.inputState.left = false;
    this.inputState.right = false;
    this.inputState.up = false;
    this.inputState.down = false;
    
    // Only activate if joystick moved significantly (deadzone)
    if (distance > 15) {
      // Use stricter thresholds for more digital/discrete feel (like WASD)
      if (this.leftJoystickForceX < -0.4) this.inputState.left = true;
      if (this.leftJoystickForceX > 0.4) this.inputState.right = true;
      if (this.leftJoystickForceY < -0.4) this.inputState.up = true;
      if (this.leftJoystickForceY > 0.4) this.inputState.down = true;
      
      // For visual feedback, snap thumb to discrete positions (8-directional)
      const angle = Math.atan2(dy, dx);
      const discreteAngle = Math.round(angle / (Math.PI / 4)) * (Math.PI / 4); // Snap to 8 directions
      const snapDistance = Math.min(distance, this.leftJoystickMaxDistance * 0.8);
      
      this.leftJoystickThumb.setPosition(
        Math.cos(discreteAngle) * snapDistance,
        Math.sin(discreteAngle) * snapDistance
      );
    }
    
    // PURE MOVEMENT - ship moves but cannon stays independent
    // Do NOT update cannon position here - it's controlled by touch aim only
    this.sendInput();
  }
  
  // Helper method to handle touch-to-aim and shoot
  handleTouchAimAndShoot(pointer) {
    console.log('🎯 Touch to aim and shoot at', pointer.x, pointer.y);
    
    // Convert touch position to world coordinates
    const worldPoint = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
    
    // Update aim target - this only affects the cannon, NOT the ship movement
    if (!this.aimTarget) {
      this.aimTarget = { x: 0, y: 0 };
    }
    this.aimTarget.x = worldPoint.x;
    this.aimTarget.y = worldPoint.y;
    
    // Update cannon position to aim at touch point
    this.updateCannonPosition();
    
    // Shoot immediately
    this.inputState.shoot = true;
    this.sendInput();
    
    // Reset shoot flag after delay
    setTimeout(() => {
      this.inputState.shoot = false;
      this.sendInput();
    }, 100);
    
    console.log('✅ Aimed at world position:', worldPoint.x.toFixed(1), worldPoint.y.toFixed(1));
  }
  
  // Helper method to update aim target during touch drag
  updateTouchAim(pointer) {
    // Convert touch position to world coordinates
    const worldPoint = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
    
    // Update aim target - this only affects the cannon, NOT the ship movement
    if (!this.aimTarget) {
      this.aimTarget = { x: 0, y: 0 };
    }
    this.aimTarget.x = worldPoint.x;
    this.aimTarget.y = worldPoint.y;
    
    // Update cannon position to aim at touch point
    this.updateCannonPosition();
  }
  
  // Helper method to update input state based on joystick position
  updateJoystickInput() {
    // DISABLED: This method is for the old single joystick system
    // We now use dual joysticks with updateLeftJoystick() and updateRightJoystick()
    return;
    
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
    
    // Convert joystick input to discrete 4-direction movement (same as desktop)
    const movementDirection = {
      x: this.joystickForceX,
      y: this.joystickForceY
    };
    
    // Use the same discrete direction system as desktop
    const discreteDirection = this.getDirectionFromVector(movementDirection);
    const discreteDirectionVector = this.getDirectionVector(discreteDirection);
    
    // Update movement direction to discrete values (consistent with desktop)
    this.movementDirection.x = discreteDirectionVector.x;
    this.movementDirection.y = discreteDirectionVector.y;
    
    // Update target direction for consistent behavior
    this.targetDirection.x = discreteDirectionVector.x;
    this.targetDirection.y = discreteDirectionVector.y;
    
    // Update ship animation using the same system as desktop (4-direction sprites)
    if (this.joystickForce > 0.1) {
      this.updateShipAnimation(this.ship, discreteDirectionVector, true);
      
      // Update cannon position based on discrete direction (not rotation)
      this.updateCannonPosition();
    }
    
    // Send input to server
    this.sendInput();
  }
  
  // Update current mouse world position for accurate shooting
  updateMouseWorldPosition() {
    // Always try to get current mouse position, even if activePointer is null
    let screenX, screenY;
    
    if (this.input.activePointer) {
      screenX = this.input.activePointer.x;
      screenY = this.input.activePointer.y;
    } else if (this.input.mousePointer) {
      screenX = this.input.mousePointer.x;
      screenY = this.input.mousePointer.y;
    } else {
      // Use last known screen coordinates if available
      screenX = this.lastScreenMousePos ? this.lastScreenMousePos.x : this.scale.width / 2;
      screenY = this.lastScreenMousePos ? this.lastScreenMousePos.y : this.scale.height / 2;
    }
    
    // Store screen coordinates for future use
    this.lastScreenMousePos = { x: screenX, y: screenY };
    
    // Calculate world coordinates manually using camera position
    // This ensures coordinates update even when mouse doesn't move but camera does
    const camera = this.cameras.main;
    const worldX = screenX + camera.scrollX;
    const worldY = screenY + camera.scrollY;
    
    // Store the manually calculated world position
    this.currentMouseWorldPos.x = worldX;
    this.currentMouseWorldPos.y = worldY;
    
    // For cornerdefense auto-shooting, continuously update aim target
    // This fixes the camera movement issue where mouse stays in same screen position but world coords change
    if (this.isCornerDefenseMap && this.useServerAutoShooting) {
      this.aimTarget.x = worldX;
      this.aimTarget.y = worldY;
    }
    
    // Debug logging (remove later)
    if (Math.random() < 0.01) { // Log 1% of the time to avoid spam
      console.log('Mouse screen:', screenX, screenY);
      console.log('Mouse world (manual):', worldX.toFixed(1), worldY.toFixed(1));
      console.log('Camera scroll:', camera.scrollX.toFixed(1), camera.scrollY.toFixed(1));
      console.log('Ship pos:', this.ship ? this.ship.x.toFixed(1) : 'N/A', this.ship ? this.ship.y.toFixed(1) : 'N/A');
    }
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
      
      // Use the continuously updated mouse world position for accurate shooting
      let targetX = this.ship.x;
      let targetY = this.ship.y;
      
      if (this.isMobile && this.aimTarget && this.aimTarget.x !== undefined && this.aimTarget.y !== undefined) {
        // Use aimTarget for mobile devices
        targetX = this.aimTarget.x;
        targetY = this.aimTarget.y;
      } else if (this.input.activePointer) {
        // Calculate world coordinates manually to handle camera movement
        const screenX = this.input.activePointer.x;
        const screenY = this.input.activePointer.y;
        const camera = this.cameras.main;
        targetX = screenX + camera.scrollX;
        targetY = screenY + camera.scrollY;
      } else {
        // Fallback to stored position
        targetX = this.currentMouseWorldPos.x;
        targetY = this.currentMouseWorldPos.y;
      }
      
      // Log shooting state for debugging
      if (this.inputState.shoot) {
        console.log('=== SHOOTING DEBUG ===');
        console.log('Ship position:', this.ship.x.toFixed(1), this.ship.y.toFixed(1));
        console.log('Target position:', targetX.toFixed(1), targetY.toFixed(1));
        if (this.input.activePointer) {
          console.log('Mouse screen pos:', this.input.activePointer.x, this.input.activePointer.y);
          console.log('Mouse world pos:', this.input.activePointer.worldX.toFixed(1), this.input.activePointer.worldY.toFixed(1));
        }
        console.log('Camera scroll:', this.cameras.main.scrollX.toFixed(1), this.cameras.main.scrollY.toFixed(1));
        const dx = targetX - this.ship.x;
        const dy = targetY - this.ship.y;
        console.log('Shot direction:', dx.toFixed(1), dy.toFixed(1));
        console.log('Shot angle (degrees):', (Math.atan2(dy, dx) * 180 / Math.PI).toFixed(1));
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
      
      // Debug logging for cornerdefense auto-shooting
      if (this.isCornerDefenseMap && this.useServerAutoShooting && this.latestBallState && this.latestBallState.grabbed && this.latestBallState.owner === this.clientId) {
        console.log('📡 SENDING TARGET to server:', targetX.toFixed(1), targetY.toFixed(1), 'ship:', this.ship.x.toFixed(1), this.ship.y.toFixed(1));
      }
      
      // Using dual WebSocket approach for enhanced performance
      // WebTransport integration temporarily disabled pending API compatibility fixes
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
  
  updateRemoteShips(time) {
    for (const id in this.otherShips) {
      const sprite = this.otherShips[id];
      if (sprite.history && sprite.history.length >= 2) {
        // Use the two most recent positions for simple interpolation
        const prev = sprite.history[sprite.history.length - 2];
        const curr = sprite.history[sprite.history.length - 1];
        
        // Simple fixed smoothing factor for consistent movement
        const smoothingFactor = 0.1;
        
        // Apply smoothing
        sprite.x = Phaser.Math.Linear(sprite.x, curr.x, smoothingFactor);
        sprite.y = Phaser.Math.Linear(sprite.y, curr.y, smoothingFactor);

        // Calculate movement direction for animation
        const dx = curr.x - prev.x;
        const dy = curr.y - prev.y;
        
        if (dx !== 0 || dy !== 0) {
          // Update ship animation based on movement direction
          this.updateShipAnimation(sprite, { x: dx, y: dy }, true);
        } else {
          // Animation disabled - using single ship.png sprite
        }
        
        // Update cannon position and rotation based on animation
        if (sprite.cannon) {
          // Get cannon position based on ship's current animation direction
          const direction = this.getCannonPosition(sprite);
          
          // Position the cannon in front of the ship based on direction
          const cannonDistance = 24; // Distance from ship center to cannon position
          sprite.cannon.x = sprite.x + direction.x * cannonDistance;
          sprite.cannon.y = sprite.y + direction.y * cannonDistance;
          
          // Calculate rotation angle for the cannon
          const angle = Math.atan2(direction.y, direction.x);
          sprite.cannon.rotation = angle;
          
          // Make the cannon more visible when rocket is ready
          if (curr.rocket_cooldown === 0) {
            sprite.cannon.setTint(0xffff00); // Yellow tint when ready
          } else {
            sprite.cannon.clearTint();
          }
        }
        
        // Generate particles for remote ships - only if moving significantly
        const distanceMoved = Phaser.Math.Distance.Between(prev.x, prev.y, curr.x, curr.y);
        if (distanceMoved > 3) {
          this.generateRemoteShipParticles(sprite, prev, curr);
        }
        
        // Update name position
        if (sprite.nameText) {
          sprite.nameText.x = sprite.x;
          sprite.nameText.y = sprite.y - 30;
        }
        
        // Update rocket cooldown indicator
        if (sprite.rocketCooldownGraphics && curr.rocket_cooldown !== undefined) {
          this.updateRemoteRocketCooldown(sprite, curr);
        }
      }
      
      // Limit history size to improve performance
      if (sprite.history && sprite.history.length > 5) {
        // Keep only the 5 most recent positions
        sprite.history = sprite.history.slice(-5);
      }
    }
  }

  generateRemoteShipParticles(sprite, older, newer) {
    // We already checked the distance threshold in the calling method
    // Just calculate direction and emit particles
    const dx = newer.x - older.x;
    const dy = newer.y - older.y;
    
    // Skip normalization for better performance - just use the raw direction
    const length = Math.sqrt(dx * dx + dy * dy);
    if (length > 0) {
      // Calculate the opposite direction
      const oppositeX = -dx / length;
      const oppositeY = -dy / length;
      
      // Emit particles in the opposite direction
      const particleX = sprite.x + oppositeX * 20;
      const particleY = sprite.y + oppositeY * 20;
      
      // Emit fewer particles for better performance
      if (Math.random() < 0.7) { // Only emit particles 70% of the time
        this.particleEmitter.emitParticleAt(particleX, particleY);
      }
    }
  }

  updateBall(time, delta) {
    if (!this.latestBallState || !this.ball) return;

    // Handle ball pickup cooldown and team exclusive access
    if (this.latestBallState.pickup_cooldown > 0) {
      // During cooldown: Make the ball glow cyan
      const glowIntensity = Math.sin(time * 0.01) * 0.5 + 0.5; // Oscillates between 0 and 1
      const baseColor = 0xffffff; // White
      const glowColor = 0x00ffff; // Cyan glow
      
      // Interpolate between base color and glow color
      const r = Math.floor(255 * (1 - glowIntensity) + (glowColor >> 16 & 0xff) * glowIntensity);
      const g = Math.floor(255 * (1 - glowIntensity) + (glowColor >> 8 & 0xff) * glowIntensity);
      const b = Math.floor(255 * (1 - glowIntensity) + (glowColor & 0xff) * glowIntensity);
      
      const finalColor = (r << 16) | (g << 8) | b;
      this.ball.setTint(finalColor);
      
      // Also make the ball slightly larger during cooldown
      const scale = 1.0 + glowIntensity * 0.2; // Scale between 1.0 and 1.2
      this.ball.setScale(scale);
    } else if (this.latestBallState.exclusive_team) {
      // After cooldown: Set ball color to match exclusive team
      const teamColors = {
        'Red': 0xff0000,
        'Blue': 0x0078ff,
        'Yellow': 0xffdc00,
        'Green': 0x00c800
      };
      
      const teamColor = teamColors[this.latestBallState.exclusive_team] || 0xffffff;
      this.ball.setTint(teamColor);
      this.ball.setScale(0.75);
    } else {
      // Normal state: Reset ball appearance
      this.ball.clearTint();
      this.ball.setScale(0.75);
    }

    // Handle ball grabbing
    if (this.latestBallState.grabbed) {
      if (this.latestBallState.owner === this.clientId) {
        // If we're grabbing the ball, position it in front of our character
        const ballOffset = this.getBallOffsetPosition(this.ship);
        this.ball.x = this.predictedState.x + ballOffset.x;
        this.ball.y = this.predictedState.y + ballOffset.y;
        this.ball.setDepth(20); // Highest depth to render on top of everything
        this.ball.setVisible(true);
        
        // Make the ship with the ball render on top of other ships
        this.ship.setDepth(14); // Higher than normal ships
        if (this.cannon) {
          this.cannon.setDepth(15); // Above the ship but below the ball
        }
        return;
      } else {
        // If another player is grabbing the ball, position it in front of their character
        const grabbingSprite = this.otherShips[this.latestBallState.owner];
        if (grabbingSprite) {
          const ballOffset = this.getBallOffsetPosition(grabbingSprite);
          this.ball.x = grabbingSprite.x + ballOffset.x;
          this.ball.y = grabbingSprite.y + ballOffset.y;
          this.ball.setDepth(20); // Highest depth to render on top of everything
          this.ball.setVisible(true);
          
          // Make the ship with the ball render on top of other ships
          grabbingSprite.setDepth(14); // Higher than normal ships
          if (grabbingSprite.cannon) {
            grabbingSprite.cannon.setDepth(15); // Above the ship but below the ball
          }
          return;
        }
      }
    }

    // If the ball is not grabbed or the grabbing player is not visible,
    // use simple interpolation for smooth ball movement
    
    // Maintain a history buffer for ball positions - but keep it small
    if (!this.ballHistory) this.ballHistory = [];
    
    // Add current state to history including velocity for bounce detection
    this.ballHistory.push({
      x: this.latestBallState.x,
      y: this.latestBallState.y,
      vx: this.latestBallState.vx || 0,
      vy: this.latestBallState.vy || 0,
      timestamp: time
    });
    
    // Keep only the last 5 entries - smaller history for better performance
    const historyLimit = 5;
    while (this.ballHistory.length > historyLimit) {
      this.ballHistory.shift();
    }
    
    // Use a simple approach - just interpolate between the last two positions
    if (this.ballHistory.length >= 2) {
      const prev = this.ballHistory[this.ballHistory.length - 2];
      const curr = this.ballHistory[this.ballHistory.length - 1];
      
      // Check for velocity direction change (indicates a bounce happened)
      const prevVx = prev.vx || 0;
      const prevVy = prev.vy || 0;
      const currVx = curr.vx || 0;
      const currVy = curr.vy || 0;
      
      const velocityChangeX = Math.abs(currVx - prevVx);
      const velocityChangeY = Math.abs(currVy - prevVy);
      const significantBounce = velocityChangeX > 60 || velocityChangeY > 60; // Higher threshold for subtlety
      
      if (significantBounce) {
        // SUBTLE RETROACTIVE POSITIONING - blend toward wall edge gently
        const ballRadius = 10;
        let adjustedX = curr.x;
        let adjustedY = curr.y;
        
        // Find the closest wall and position ball exactly at its edge
        if (this.mapObjects) {
          let closestObject = null;
          let minDistance = Infinity;
          
          this.mapObjects.forEach(obj => {
            if (obj.type !== 'wall' && !obj.type.startsWith('goal')) return;
            
            // Calculate distance to this object
            const objLeft = obj.x;
            const objRight = obj.x + obj.width;
            const objTop = obj.y;
            const objBottom = obj.y + obj.height;
            
            // Find closest point on object to ball
            const closestX = Math.max(objLeft, Math.min(curr.x, objRight));
            const closestY = Math.max(objTop, Math.min(curr.y, objBottom));
            
            const distance = Math.sqrt((curr.x - closestX) ** 2 + (curr.y - closestY) ** 2);
            
            if (distance < minDistance) {
              minDistance = distance;
              closestObject = { obj, closestX, closestY };
            }
          });
          
          // If we found a close object, blend toward edge instead of snapping
          if (closestObject && minDistance < 25) { // Slightly smaller radius for subtlety
            const obj = closestObject.obj;
            const objLeft = obj.x;
            const objRight = obj.x + obj.width;
            const objTop = obj.y;
            const objBottom = obj.y + obj.height;
            
            // Calculate ideal position
            let idealX = curr.x;
            let idealY = curr.y;
            
            if (obj.type.startsWith('goal')) {
              // Goals: Position ball slightly inside for smooth entry
              if (Math.abs(curr.x - objLeft) < Math.abs(curr.x - objRight)) {
                idealX = objLeft + ballRadius * 0.7; // Slightly inside left edge
              } else {
                idealX = objRight - ballRadius * 0.7; // Slightly inside right edge  
              }
              
              if (Math.abs(curr.y - objTop) < Math.abs(curr.y - objBottom)) {
                idealY = objTop + ballRadius * 0.7; // Slightly inside top edge
              } else {
                idealY = objBottom - ballRadius * 0.7; // Slightly inside bottom edge
              }
            } else {
              // Walls: Position ball outside (bouncing off)
              if (Math.abs(curr.x - objLeft) < Math.abs(curr.x - objRight)) {
                idealX = objLeft + ballRadius; // Closer to left side
              } else {
                idealX = objRight - ballRadius; // Closer to right side  
              }
              
              if (Math.abs(curr.y - objTop) < Math.abs(curr.y - objBottom)) {
                idealY = objTop + ballRadius; // Closer to top side
              } else {
                idealY = objBottom - ballRadius; // Closer to bottom side
              }
            }
            
            // Blend toward ideal position instead of snapping
            const blendFactor = obj.type.startsWith('goal') ? 0.5 : 0.6; // Gentler for goals
            adjustedX = Phaser.Math.Linear(curr.x, idealX, blendFactor);
            adjustedY = Phaser.Math.Linear(curr.y, idealY, blendFactor);
          }
        }
        
        this.ball.x = adjustedX;
        this.ball.y = adjustedY;
        
        // Less frequent logging
        if (Math.random() < 0.2) {
          console.log(`Subtle bounce adjustment: (${adjustedX.toFixed(1)}, ${adjustedY.toFixed(1)})`);
        }
      } else {
        // Normal smooth movement with PREDICTIVE COLLISION DETECTION
        const smoothingFactor = 0.1;
        
        // Calculate where ball will be in next few frames
        const prediction = this.predictBallMovement(curr, 5); // Predict further ahead (5 frames)
        
        if (prediction.willCollide) {
          // Very subtle approach to collision point - barely noticeable
          const collisionSmoothingFactor = prediction.isGoal ? 0.12 : 0.15; // Slightly gentler for goals
          this.ball.x = Phaser.Math.Linear(this.ball.x, prediction.collisionPoint.x, collisionSmoothingFactor);
          this.ball.y = Phaser.Math.Linear(this.ball.y, prediction.collisionPoint.y, collisionSmoothingFactor);
          
          // Only log occasionally to reduce console spam
          if (Math.random() < 0.1) {
            const objectType = prediction.isGoal ? 'goal' : 'wall';
            console.log(`Subtle ${objectType} prediction: (${prediction.collisionPoint.x.toFixed(1)}, ${prediction.collisionPoint.y.toFixed(1)})`);
          }
        } else {
          // Slightly faster normal interpolation for smoother overall movement
          const smoothingFactor = 0.12; // Slightly increased from 0.1
          this.ball.x = Phaser.Math.Linear(this.ball.x, curr.x, smoothingFactor);
          this.ball.y = Phaser.Math.Linear(this.ball.y, curr.y, smoothingFactor);
        }
      }
      
      // Enhanced wall bouncing visual feedback
      this.updateBallWallInteraction(prev, curr);
      
      this.ball.setDepth(16); // Set higher than players and cannons (cannons are at 15) so ball renders on top during collisions
      this.ball.setVisible(true);
    } else {
      // If we don't have enough history, just use the latest position
      this.ball.x = this.latestBallState.x;
      this.ball.y = this.latestBallState.y;
      this.ball.setDepth(16); // Set higher than players and cannons so ball renders on top during collisions
      this.ball.setVisible(true);
    }
  }

  // Advanced predictive collision detection
  predictBallMovement(ballState, framesAhead) {
    if (!this.mapObjects) {
      return { willCollide: false };
    }
    
    const ballRadius = 10;
    const dt = 1/60; // Assume 60fps
    
    // Simulate ball movement for multiple frames
    let simX = ballState.x;
    let simY = ballState.y;
    let simVx = ballState.vx || 0;
    let simVy = ballState.vy || 0;
    
    // Only predict for balls moving at reasonable speed to avoid jitter
    const speed = Math.sqrt(simVx * simVx + simVy * simVy);
    if (speed < 20) return { willCollide: false }; // Ignore very slow balls
    
    for (let frame = 0; frame < framesAhead; frame++) {
      // Simulate one frame of movement
      const nextX = simX + simVx * dt;
      const nextY = simY + simVy * dt;
      
      // Apply friction
      simVx *= 0.998;
      simVy *= 0.998;
      
      // Check for wall AND goal collision on this simulated frame
      for (const obj of this.mapObjects) {
        if (obj.type !== 'wall' && !obj.type.startsWith('goal')) continue;
        
        // Ray-cast from current position to next position
        const collision = this.raycastToObject(simX, simY, nextX, nextY, ballRadius, obj);
        
        if (collision.hit) {
          // Only return prediction if collision is close enough to matter
          if (frame <= 3) { // Only very imminent collisions
            return {
              willCollide: true,
              collisionPoint: collision.point,
              framesUntilCollision: frame,
              objectHit: obj,
              isGoal: obj.type.startsWith('goal')
            };
          }
        }
      }
      
      // Update simulated position
      simX = nextX;
      simY = nextY;
      
      // Boundary check
      if (simX < ballRadius || simX > 2000 - ballRadius) simVx = -simVx;
      if (simY < ballRadius || simY > 1200 - ballRadius) simVy = -simVy;
    }
    
    return { willCollide: false };
  }

  // Ray-casting collision detection for walls and goals
  raycastToObject(startX, startY, endX, endY, ballRadius, obj) {
    // Different buffer for goals vs walls
    const buffer = obj.type.startsWith('goal') ? 1 : 2; // Smaller buffer for goals
    
    // Expand object by ball radius with slight buffer for smoother prediction
    const objLeft = obj.x - ballRadius - buffer;
    const objRight = obj.x + obj.width + ballRadius + buffer;
    const objTop = obj.y - ballRadius - buffer;
    const objBottom = obj.y + obj.height + ballRadius + buffer;
    
    // Check if ray intersects with expanded object bounds
    const intersection = this.lineRectIntersection(
      startX, startY, endX, endY,
      objLeft, objTop, objRight - objLeft, objBottom - objTop
    );
    
    if (intersection.intersects) {
      // Calculate exact collision point where ball center would be
      let collisionX = intersection.x;
      let collisionY = intersection.y;
      
      // For goals, position ball at the edge (entering goal)
      // For walls, position ball outside (bouncing off)
      if (obj.type.startsWith('goal')) {
        // Goals: Position ball just at the goal edge for smooth entry
        if (Math.abs(collisionX - obj.x) < ballRadius) {
          collisionX = obj.x + ballRadius * 0.5; // Slightly inside left edge
        } else if (Math.abs(collisionX - (obj.x + obj.width)) < ballRadius) {
          collisionX = obj.x + obj.width - ballRadius * 0.5; // Slightly inside right edge
        }
        
        if (Math.abs(collisionY - obj.y) < ballRadius) {
          collisionY = obj.y + ballRadius * 0.5; // Slightly inside top edge
        } else if (Math.abs(collisionY - (obj.y + obj.height)) < ballRadius) {
          collisionY = obj.y + obj.height - ballRadius * 0.5; // Slightly inside bottom edge
        }
      } else {
        // Walls: Position ball outside (original behavior)
        if (Math.abs(collisionX - obj.x) < ballRadius) {
          collisionX = obj.x + ballRadius; // Hit left side
        } else if (Math.abs(collisionX - (obj.x + obj.width)) < ballRadius) {
          collisionX = obj.x + obj.width - ballRadius; // Hit right side
        }
        
        if (Math.abs(collisionY - obj.y) < ballRadius) {
          collisionY = obj.y + ballRadius; // Hit top side
        } else if (Math.abs(collisionY - (obj.y + obj.height)) < ballRadius) {
          collisionY = obj.y + obj.height - ballRadius; // Hit bottom side
        }
      }
      
      return {
        hit: true,
        point: { x: collisionX, y: collisionY },
        object: obj
      };
    }
    
    return { hit: false };
  }

  // Enhanced wall bouncing visual feedback with client-side prediction
  updateBallWallInteraction(prev, curr) {
    if (!prev || !curr) return;
    
    // Initialize bounce state if needed
    if (!this.lastBouncePositions) this.lastBouncePositions = new Set();
    
    // CLIENT-SIDE COLLISION PREDICTION for better WiFi experience
    const ballRadius = 10;
    const predictedBounce = this.predictWallCollision(
      this.ball.x, this.ball.y, 
      curr.vx || 0, curr.vy || 0, 
      ballRadius
    );
    
    if (predictedBounce.willCollide) {
      // Snap ball to collision point for accurate bounces
      this.ball.x = predictedBounce.collisionPoint.x;
      this.ball.y = predictedBounce.collisionPoint.y;
    }
    
    // Check proximity to walls and adjust ball appearance
    const wallProximity = this.getWallProximity(curr.x, curr.y);
    if (wallProximity.distance < 30) {
      this.adjustBallForWallProximity(wallProximity);
    } else {
      if (!this.latestBallState.pickup_cooldown && !this.latestBallState.exclusive_team) {
        this.ball.setScale(0.75);
      }
    }
  }

  // Client-side wall collision prediction for realistic bounce timing
  predictWallCollision(ballX, ballY, velocityX, velocityY, ballRadius) {
    if (!this.mapObjects) {
      return { willCollide: false };
    }

    const speed = Math.sqrt(velocityX * velocityX + velocityY * velocityY);
    
    // For high speeds, disable client prediction - let server handle it
    if (speed > 150) {
      return { willCollide: false };
    }
    
    if (speed < 10) {
      return { willCollide: false };
    }

    // Use exact ball radius for precise contact, but allow slight penetration
    const collisionRadius = ballRadius * 0.85; // Slightly smaller to allow penetration
    
    let closestCollision = null;

    // Check collision with each wall - only for slower balls
    this.mapObjects.forEach(wall => {
      if (wall.type !== 'wall') return;
      
      // Use exact wall bounds
      const wallLeft = wall.x;
      const wallRight = wall.x + wall.width;
      const wallTop = wall.y;
      const wallBottom = wall.y + wall.height;
      
      // Check if ball is touching or overlapping the wall with penetration allowance
      const touchingLeft = Math.abs(ballX - collisionRadius - wallLeft) <= 2;
      const touchingRight = Math.abs(ballX + collisionRadius - wallRight) <= 2;
      const touchingTop = Math.abs(ballY - collisionRadius - wallTop) <= 2;
      const touchingBottom = Math.abs(ballY + collisionRadius - wallBottom) <= 2;
      
      const overlappingX = ballX + collisionRadius > wallLeft && ballX - collisionRadius < wallRight;
      const overlappingY = ballY + collisionRadius > wallTop && ballY - collisionRadius < wallBottom;

      // Only trigger on direct contact with slight penetration
      if ((touchingLeft || touchingRight) && overlappingY) {
        // Position ball to penetrate wall slightly (3 pixels inside)
        const penetration = 3;
        const collisionX = touchingLeft ? 
          wallLeft + collisionRadius - penetration : 
          wallRight - collisionRadius + penetration;
        closestCollision = {
          collisionPoint: { x: collisionX, y: ballY },
          bounceVelocity: { x: -velocityX * 0.9, y: velocityY }
        };
        return; // Exit forEach early
      } 
      else if ((touchingTop || touchingBottom) && overlappingX) {
        // Position ball to penetrate wall slightly (3 pixels inside)
        const penetration = 3;
        const collisionY = touchingTop ? 
          wallTop + collisionRadius - penetration : 
          wallBottom - collisionRadius + penetration;
        closestCollision = {
          collisionPoint: { x: ballX, y: collisionY },
          bounceVelocity: { x: velocityX, y: -velocityY * 0.9 }
        };
        return; // Exit forEach early
      }
    });
    
    // Return collision only if we found direct contact
    if (closestCollision) {
      return {
        willCollide: true,
        collisionPoint: closestCollision.collisionPoint,
        bounceVelocity: closestCollision.bounceVelocity
      };
    }
    
    return { willCollide: false };
  }

  // Helper method for line-rectangle intersection
  lineRectIntersection(x1, y1, x2, y2, rectX, rectY, rectW, rectH) {
    // Simple line-rectangle intersection check
    const dx = x2 - x1;
    const dy = y2 - y1;
    
    // Check if line crosses any of the rectangle edges
    const left = rectX;
    const right = rectX + rectW;
    const top = rectY;
    const bottom = rectY + rectH;
    
    // Find intersections with each edge
    let closestIntersection = null;
    let minT = Infinity;
    
    // Left edge
    if (dx !== 0) {
      const t = (left - x1) / dx;
      if (t >= 0 && t <= 1) {
        const y = y1 + t * dy;
        if (y >= top && y <= bottom && t < minT) {
          minT = t;
          closestIntersection = { x: left, y: y };
        }
      }
    }
    
    // Right edge
    if (dx !== 0) {
      const t = (right - x1) / dx;
      if (t >= 0 && t <= 1) {
        const y = y1 + t * dy;
        if (y >= top && y <= bottom && t < minT) {
          minT = t;
          closestIntersection = { x: right, y: y };
        }
      }
    }
    
    // Top edge
    if (dy !== 0) {
      const t = (top - y1) / dy;
      if (t >= 0 && t <= 1) {
        const x = x1 + t * dx;
        if (x >= left && x <= right && t < minT) {
          minT = t;
          closestIntersection = { x: x, y: top };
        }
      }
    }
    
    // Bottom edge
    if (dy !== 0) {
      const t = (bottom - y1) / dy;
      if (t >= 0 && t <= 1) {
        const x = x1 + t * dx;
        if (x >= left && x <= right && t < minT) {
          minT = t;
          closestIntersection = { x: x, y: bottom };
        }
      }
    }
    
    if (closestIntersection) {
      return {
        intersects: true,
        x: closestIntersection.x,
        y: closestIntersection.y
      };
    }
    
    return { intersects: false };
  }
  
  createBounceEffect(x, y, vx, vy) {
    // Create a smaller flash effect at bounce location
    const bounceFlash = this.add.circle(x, y, 8, 0xffffff, 0.5); // Reduced size and opacity
    bounceFlash.setDepth(17); // Above the ball
    
    // Faster, smaller fade out
    this.tweens.add({
      targets: bounceFlash,
      alpha: 0,
      scale: 0.2,
      duration: 100, // Faster fade
      onComplete: () => bounceFlash.destroy()
    });
    
    // Add fewer, smaller particle effects in the bounce direction
    if (this.particleEmitter) {
      // Emit particles in the direction opposite to the ball's movement
      const particleAngle = Math.atan2(-vy, -vx);
      for (let i = 0; i < 5; i++) { // Reduced number of particles
        const spread = 0.3; // Reduced spread
        const angle = particleAngle + (Math.random() - 0.5) * spread;
        const distance = 10 + Math.random() * 8; // Reduced distance
        
        this.particleEmitter.emitParticleAt(
          x + Math.cos(angle) * distance,
          y + Math.sin(angle) * distance
        );
      }
    }
    
    // Smaller ball pulse
    this.ball.setScale(0.85);
    this.tweens.add({
      targets: this.ball,
      scaleX: 0.75,
      scaleY: 0.75,
      duration: 80, // Faster animation
      ease: 'Back.easeOut'
    });
  }
  
  getWallProximity(x, y) {
    let minDistance = Infinity;
    let closestWallNormal = { x: 0, y: 0 };
    
    // Check distance to map walls
    if (this.mapObjects) {
      this.mapObjects.forEach(obj => {
        if (obj.type === 'wall') {
          // Calculate distance to wall rectangle
          const wallLeft = obj.x;
          const wallRight = obj.x + obj.width;
          const wallTop = obj.y;
          const wallBottom = obj.y + obj.height;
          
          // Find closest point on wall to ball
          const closestX = Math.max(wallLeft, Math.min(x, wallRight));
          const closestY = Math.max(wallTop, Math.min(y, wallBottom));
          
          const distance = Math.sqrt((x - closestX) ** 2 + (y - closestY) ** 2);
          
          if (distance < minDistance) {
            minDistance = distance;
            
            // Calculate normal vector pointing away from wall
            if (x < wallLeft) closestWallNormal = { x: -1, y: 0 };
            else if (x > wallRight) closestWallNormal = { x: 1, y: 0 };
            else if (y < wallTop) closestWallNormal = { x: 0, y: -1 };
            else if (y > wallBottom) closestWallNormal = { x: 0, y: 1 };
          }
        }
      });
    }
    
    return { distance: minDistance, normal: closestWallNormal };
  }
  
  adjustBallForWallProximity(wallProximity) {
    const { distance, normal } = wallProximity;
    
    // Calculate compression effect based on proximity
    const maxProximity = 30;
    const compressionFactor = Math.max(0, (maxProximity - distance) / maxProximity);
    
    // Slightly squish the ball toward the wall and stretch it away
    const baseScale = 0.75;
    const squishAmount = compressionFactor * 0.15; // Maximum 15% compression
    
    let scaleX = baseScale;
    let scaleY = baseScale;
    
    // Compress in the direction of the wall normal
    if (Math.abs(normal.x) > Math.abs(normal.y)) {
      // Horizontal wall - compress horizontally, stretch vertically
      scaleX = baseScale - squishAmount;
      scaleY = baseScale + squishAmount * 0.5;
    } else {
      // Vertical wall - compress vertically, stretch horizontally  
      scaleX = baseScale + squishAmount * 0.5;
      scaleY = baseScale - squishAmount;
    }
    
    this.ball.setScale(scaleX, scaleY);
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
    const shipSpeed = 120; // Increased from 100 to 120 (20% faster) to match server
    
    // Handle auto-shooting for cornerdefense map
    if (this.isCornerDefenseMap && !this.useServerAutoShooting) {
      // Only use client-side auto-shooting if server-side is disabled
      this.handleAutoShooting(time, delta);
    }
    
    // Only process input if player can move (not during countdown)
    if (this.playerCanMove !== false) {
      // Calculate target direction based on input - direct, no smoothing
      this.targetDirection.x = 0;
      this.targetDirection.y = 0;
      
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
        const targetLength = Math.sqrt(this.targetDirection.x * this.targetDirection.x + this.targetDirection.y * this.targetDirection.y);
        if (targetLength > 0) {
          this.targetDirection.x /= targetLength;
          this.targetDirection.y /= targetLength;
        }
      }
      
      // For desktop, we don't update the movement direction from keyboard input
      // since it's now controlled by the mouse position
      if (this.isMobile) {
        // For mobile, use direct joystick input without smoothing
        if (this.targetDirection.x !== 0 || this.targetDirection.y !== 0) {
          this.movementDirection.x = this.targetDirection.x;
          this.movementDirection.y = this.targetDirection.y;
          
          // DO NOT update aim target based on movement - cannon is independent
          // Aim target is only controlled by touch-to-aim system
        } else {
          // If no input, stop immediately
          this.movementDirection.x = 0;
          this.movementDirection.y = 0;
        }
      }
    }
    
    // Use target direction directly for movement - no smoothing/easing
    const moveDirection = { x: this.targetDirection.x, y: this.targetDirection.y };
    
    // Update predicted position based on direct input direction
    if (moveDirection.x !== 0 || moveDirection.y !== 0) {
      this.predictedState.x += moveDirection.x * shipSpeed * dt;
      this.predictedState.y += moveDirection.y * shipSpeed * dt;
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
    
    // Update ship animation based on movement direction
    if (!this.isMobile && (moveDirection.x !== 0 || moveDirection.y !== 0)) {
      // Update ship animation based on movement direction
      this.updateShipAnimation(this.ship, moveDirection, true);
      
      // Update cannon position after animation change
      this.updateCannonPosition();
    } else if (this.isMobile) {
      // For mobile, only update animation if we haven't manually set it recently
      // or if we're using the joystick
      const manualRotationTimeout = 500; // Keep manual rotation for 500ms
      const useManualRotation = this.manualRotation && 
                               (Date.now() - this.manualRotationTime < manualRotationTimeout);
      
      if (!useManualRotation && this.movementDirection.x !== 0 && this.movementDirection.y !== 0) {
        // Update ship animation based on movement direction
        this.updateShipAnimation(this.ship, this.movementDirection, true);
        
        // DO NOT update cannon position based on ship movement for mobile
        // Cannon is controlled by touch-to-aim system only
      }
    } else if (this.movementDirection.x !== 0 || this.movementDirection.y !== 0) {
      // Update ship animation based on movement direction
      this.updateShipAnimation(this.ship, this.movementDirection, true);
      
      // Update cannon position after animation change
      this.updateCannonPosition();
    } else {
      // Animation disabled - using single ship.png sprite
    }
    
    // Update cannon position and rotation to match the ship
    this.updateCannonPosition();
    
    // Update direction indicator if it exists
    if (this.directionIndicator) {
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
    }
    
    // Update player name position
    if (this.playerNameText) {
      this.playerNameText.x = this.ship.x;
      this.playerNameText.y = this.ship.y - 30;
    }
    
    // Update rocket cooldown indicator position
    if (this.rocketCooldownGraphics) {
      this.updateRocketCooldown();
    }
    
    // Update rocket ready text position
    if (this.rocketReadyText) {
      this.rocketReadyText.x = this.ship.x;
      this.rocketReadyText.y = this.ship.y - 50;
    }
    
    // Update boost circle
    if (this.boostCircle) {
      this.updateBoostCircle();
    }
    
    // Process incoming messages
    this.processIncomingMessages();
    
    // Update remote ships - use the Phaser time parameter for smooth interpolation
    this.updateRemoteShips(time);
    
    // Update ball position
    this.updateBall(time, delta);
    
    // Update projectiles
    this.updateProjectiles(time, delta);
    
    // Update controller input
    this.updateControllerInput();
    
    // Update joystick input for mobile
    if (this.isMobile && this.joystick) {
      this.updateJoystickInput();
    }
    
    // Update mouse world position every frame to handle camera movement
    // This ensures auto-shooting targets stay accurate as camera follows the ship
    this.updateMouseWorldPosition();
    
    // For cornerdefense auto-shooting, send input at a reasonable rate
    // This ensures server has current mouse target position without overwhelming bandwidth
    if (this.isCornerDefenseMap && this.useServerAutoShooting && this.ship) {
      // Initialize throttling variables if not exists
      if (!this.autoShootInputThrottle) {
        this.autoShootInputThrottle = {
          lastSentTime: 0,
          lastSentTarget: { x: 0, y: 0 },
          sendInterval: 50 // Send every 50ms (20 FPS) instead of every frame (60 FPS)
        };
      }
      
      const now = Date.now();
      const timeSinceLastSent = now - this.autoShootInputThrottle.lastSentTime;
      
      // Check if target position has changed significantly
      const targetChanged = Math.abs(this.currentMouseWorldPos.x - this.autoShootInputThrottle.lastSentTarget.x) > 5 ||
                           Math.abs(this.currentMouseWorldPos.y - this.autoShootInputThrottle.lastSentTarget.y) > 5;
      
      // Send input if enough time has passed OR if target changed significantly
      if (timeSinceLastSent >= this.autoShootInputThrottle.sendInterval || targetChanged) {
        this.sendInput();
        this.autoShootInputThrottle.lastSentTime = now;
        this.autoShootInputThrottle.lastSentTarget.x = this.currentMouseWorldPos.x;
        this.autoShootInputThrottle.lastSentTarget.y = this.currentMouseWorldPos.y;
      }
    }
    
    // Mouse position is now calculated directly when shooting for better accuracy
    
    // Generate particles based on ship movement
    this.generateParticles();
    
    // Update camera position
    this.updateCamera();
    
    // Always update cannon position at the end of the update method
    this.updateCannonPosition();
    
    // Send input to server
    this.sendInput();
  }

  handleAutoShooting(time, delta) {
    // CLIENT-SIDE AUTO-SHOOTING (Fallback when server-side is disabled)
    // Note: For cornerdefense map, server-side auto-shooting is preferred for maximum speed
    
    // Only auto-shoot if we have the ball
    if (!this.latestBallState || !this.latestBallState.grabbed || !this.latestBallState.owner) {
      console.log('Client auto-shooting: No ball state or ball not grabbed');
      return;
    }
    
    // Check if we are the ball owner
    if (this.latestBallState.owner !== this.clientId) {
      console.log('Client auto-shooting: Not ball owner', this.latestBallState.owner, 'vs', this.clientId);
      return;
    }
    
    // Update auto-shooting cooldown
    if (this.autoShootCooldown > 0) {
      this.autoShootCooldown -= delta / 1000;
      return;
    }
    
    // Ensure we have valid mouse/aim target
    if (!this.aimTarget || !this.ship) {
      console.log('Client auto-shooting: No aim target or ship');
      return;
    }
    
    // Calculate distance to mouse pointer
    const dx = this.aimTarget.x - this.ship.x;
    const dy = this.aimTarget.y - this.ship.y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    
    // Only auto-shoot if mouse is far enough away (avoids accidental shots)
    if (distance < 30) { // Reduced from 50 to 30 for more sensitive shooting
      console.log('Client auto-shooting: Mouse too close to ship', distance);
      return;
    }
    
    // Auto-shoot at the current mouse position
    console.log('🔥 CLIENT AUTO-SHOOTING at mouse position:', this.aimTarget.x.toFixed(1), this.aimTarget.y.toFixed(1), 'distance:', distance.toFixed(1));
    
    // Set shoot flag
    this.inputState.shoot = true;
    this.sendInput();
    
    // Reset shoot flag after a very short delay for ultra-responsive shooting
    setTimeout(() => {
      this.inputState.shoot = false;
      this.sendInput();
    }, 16); // Just one frame at 60fps for immediate response
    
    // Set ultra-short cooldown for maximum responsiveness
    this.autoShootCooldown = 0.005;
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
    
    // Play rocket launch sound - using the working approach
    try {
      console.log('🎵 Playing rocket launch sound for projectile by player:', playerId);
      if (window.testRocketSound) {
        window.testRocketSound();
        console.log('✅ Called working testRocketSound for real rocket launch');
      } else {
        console.error('❌ testRocketSound not available, trying method');
        this.playRocketSound();
      }
    } catch (soundError) {
      console.error('❌ Rocket launch sound error:', soundError);
    }
    
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
  playExplosionEffect(x, y, radius, playerId, enhanced = false) {
    // Play explosion sound - using the working approach
    try {
      const explosionType = enhanced ? '💥💥 ENHANCED ROCKET COLLISION' : '💥 Regular';
      console.log(`🎵 Playing explosion sound (${explosionType}) at:`, x.toFixed(1), y.toFixed(1), 'radius:', radius, 'player:', playerId);
      
      if (window.testExplosionSound) {
        window.testExplosionSound();
        console.log('✅ Called working testExplosionSound for explosion');
      } else {
        console.error('❌ testExplosionSound not available, trying method');
        this.playExplosionSound();
      }
    } catch (soundError) {
      console.error('❌ Explosion sound error:', soundError);
    }
    
    if (enhanced) {
      // Enhanced explosion for rocket collisions - BIGGER AND MORE DRAMATIC!
      console.log('🚀💥💥 Creating ENHANCED rocket collision explosion visual!');
      
      // Multiple explosion rings for enhanced effect
      const colors = [0xff6600, 0xff0000, 0xffff00, 0xffffff];
      const scales = [1.0, 1.3, 1.6, 2.0];
      
      colors.forEach((color, i) => {
        setTimeout(() => {
          const flash = this.add.circle(x, y, radius * 0.8, color, 0.7 - i * 0.15);
          flash.setDepth(10 + i);
          
          this.tweens.add({
            targets: flash,
            alpha: 0,
            scale: scales[i],
            duration: 700 + i * 100,
            ease: 'Power2.easeOut',
            onComplete: () => {
              flash.destroy();
            }
          });
        }, i * 50);
      });
      
      // Enhanced particle explosion
      if (this.particleEmitter) {
        const originalTint = this.particleEmitter.tint;
        
        // Multiple particle bursts with different colors
        [0xff6600, 0xff0000, 0xffff00].forEach((tint, i) => {
          setTimeout(() => {
            this.particleEmitter.setTint(tint);
            
            // More particles for enhanced explosion
            for (let j = 0; j < 80; j++) {
              const angle = Math.random() * Math.PI * 2;
              const distance = Math.random() * radius * 1.2; // Larger spread
              const x2 = x + Math.cos(angle) * distance;
              const y2 = y + Math.sin(angle) * distance;
              
              this.particleEmitter.emitParticleAt(x2, y2);
            }
          }, i * 75);
        });
        
        // Reset emitter tint
        setTimeout(() => {
          this.particleEmitter.setTint(originalTint);
        }, 300);
      }
      
      // Enhanced screen shake
      this.cameras.main.shake(400, 0.02);
      
      // Enhanced explosion text effect
      const explosionText = this.add.text(x, y - 50, '💥💥 ROCKET COLLISION! 💥💥', {
        fontFamily: 'Arial',
        fontSize: 20,
        color: '#ffff00',
        stroke: '#ff0000',
        strokeThickness: 3,
        align: 'center'
      }).setOrigin(0.5).setDepth(1000);
      
      // Animate the text
      this.tweens.add({
        targets: explosionText,
        y: explosionText.y - 40,
        alpha: 0,
        scale: 1.5,
        duration: 1500,
        ease: 'Power2.easeOut',
        onComplete: () => {
          explosionText.destroy();
        }
      });
      
    } else {
      // Regular explosion
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
  }
  
  // Update the score display
  updateScoreDisplay() {
    // Update scores from server state
    if (this.serverState.team1_score !== undefined) this.team1Score = this.serverState.team1_score;
    if (this.serverState.team2_score !== undefined) this.team2Score = this.serverState.team2_score;
    if (this.serverState.team3_score !== undefined) this.team3Score = this.serverState.team3_score;
    if (this.serverState.team4_score !== undefined) this.team4Score = this.serverState.team4_score;
    
    // Create/update the score pie chart at the top center
    this.createScorePieChart();
    
    // Hide legacy score display (completely hidden for mobile, normal visibility for desktop)
    if (this.scoreLabel) this.scoreLabel.setVisible(!this.isMobile);
    if (this.redScoreText) this.redScoreText.setVisible(!this.isMobile);
    if (this.scoreSeparator) this.scoreSeparator.setVisible(!this.isMobile);
    if (this.blueScoreText) this.blueScoreText.setVisible(!this.isMobile);
  }
  
  // Handle fast projectile creation through fast channel
  handleFastProjectileCreation(projectileData) {
    const projectile = projectileData;
    
    // Create projectile sprite immediately for instant visibility
    if (!this.projectiles[projectile.id]) {
      console.log('⚡ Creating fast projectile:', projectile.id);
      
      // Create new projectile sprite
      const sprite = this.add.sprite(projectile.x, projectile.y, 'ball');
      sprite.setScale(0.3); // Make projectiles smaller than the ball
      sprite.setTint(0xff9900); // Give projectiles a distinct color
      sprite.setDepth(100);
      
      // Add glow effect
      const glow = this.add.circle(projectile.x, projectile.y, 10, 0xff9900, 0.5);
      glow.setDepth(95);
      
      // Create trail effect
      const trail = this.add.graphics();
      
             this.projectiles[projectile.id] = {
         sprite: sprite,
         glow: glow,
         trail: trail,
         trailPoints: [], // For trail effect compatibility
         lastX: projectile.x,
         lastY: projectile.y,
         vx: projectile.vx || 0,
         vy: projectile.vy || 0,
         lifetime: projectile.lifetime,
         lastUpdateTime: Date.now(),
         history: [{ x: projectile.x, y: projectile.y, vx: projectile.vx, vy: projectile.vy, timestamp: Date.now() }]
       };
    }
  }
  
  // Handle fast projectile position updates through fast channel
  handleFastProjectileUpdates(projectilesData) {
    if (!projectilesData || !Array.isArray(projectilesData)) {
      return;
    }
    
    projectilesData.forEach(projectile => {
      if (this.projectiles[projectile.id]) {
        const proj = this.projectiles[projectile.id];
        
        // Update target position and velocity for smooth interpolation (don't snap immediately)
        proj.vx = projectile.vx || proj.vx;
        proj.vy = projectile.vy || proj.vy;
        proj.lifetime = projectile.lifetime;
        
        // Ensure history array exists (safety check)
        if (!proj.history) {
          proj.history = [];
        }
        
        // Add to history for smooth interpolation
        proj.history.push({
          x: projectile.x,
          y: projectile.y,
          vx: projectile.vx,
          vy: projectile.vy,
          timestamp: Date.now()
        });
        
        // Keep only recent history (last 3 positions for smooth interpolation)
        if (proj.history.length > 3) {
          proj.history.shift();
        }
        
        // Remove if lifetime expired
        if (projectile.lifetime <= 0) {
          this.removeProjectile(projectile.id);
        }
      } else {
        // Create projectile if it doesn't exist (in case we missed the creation message)
        this.handleFastProjectileCreation(projectile);
      }
    });
  }
  
  // Helper method to remove projectiles
  removeProjectile(projectileId) {
    if (this.projectiles[projectileId]) {
      console.log('🗑️ Removing projectile:', projectileId);
      
      // Clean up sprites
      if (this.projectiles[projectileId].sprite) {
        this.projectiles[projectileId].sprite.destroy();
      }
      if (this.projectiles[projectileId].glow) {
        this.projectiles[projectileId].glow.destroy();
      }
      if (this.projectiles[projectileId].trail) {
        this.projectiles[projectileId].trail.destroy();
      }
      
      delete this.projectiles[projectileId];
    }
  }
  
  // Add method to update projectiles with smooth interpolation
  updateProjectiles(time, delta) {
    // Smooth interpolation for all existing projectiles
    for (const id in this.projectiles) {
      const proj = this.projectiles[id];
      
      if (proj.history && proj.history.length >= 2) {
        // Use the two most recent positions for simple interpolation
        const prev = proj.history[proj.history.length - 2];
        const curr = proj.history[proj.history.length - 1];
        
        // Simple fixed smoothing factor for consistent movement
        const smoothingFactor = 0.2; // Slightly more responsive than ships
        
        // Apply smoothing to target position
        proj.sprite.x = Phaser.Math.Linear(proj.sprite.x, curr.x, smoothingFactor);
        proj.sprite.y = Phaser.Math.Linear(proj.sprite.y, curr.y, smoothingFactor);
        proj.glow.x = proj.sprite.x;
        proj.glow.y = proj.sprite.y;
        
        // Calculate rotation based on movement direction
        const dx = curr.x - prev.x;
        const dy = curr.y - prev.y;
        
        if (dx !== 0 || dy !== 0) {
          proj.sprite.rotation = Math.atan2(dy, dx);
        }
        
        // Add simple trail effect
        if (!proj.trailPoints) {
          proj.trailPoints = [];
        }
        
        // Add current position to trail occasionally (not every frame for performance)
        if (Math.random() < 0.3) { // 30% chance each frame
          proj.trailPoints.push({ 
            x: proj.sprite.x, 
            y: proj.sprite.y, 
            alpha: 1.0 
          });
        }
        
        // Limit trail length and fade out
        if (proj.trailPoints.length > 8) {
          proj.trailPoints.shift();
        }
        
        // Fade out trail points
        proj.trailPoints.forEach(point => {
          point.alpha -= 0.08; // Fade speed
          if (point.alpha < 0) point.alpha = 0;
        });
        
        // Remove fully faded points
        proj.trailPoints = proj.trailPoints.filter(point => point.alpha > 0.1);
        
        // Draw simple trail
        if (proj.trail) {
          proj.trail.destroy();
        }
        
        if (proj.trailPoints.length > 1) {
          const graphics = this.add.graphics();
          graphics.setDepth(95); // Just below glow
          
          for (let i = 0; i < proj.trailPoints.length - 1; i++) {
            const point = proj.trailPoints[i];
            const nextPoint = proj.trailPoints[i + 1];
            const lineWidth = 2 * point.alpha;
            const alpha = point.alpha * 0.6;
            
            graphics.lineStyle(lineWidth, 0xff9900, alpha);
            graphics.lineBetween(point.x, point.y, nextPoint.x, nextPoint.y);
          }
          
          proj.trail = graphics;
        }
      } else if (proj.history && proj.history.length === 1) {
        // Single position - just move towards it
        const target = proj.history[0];
        const smoothingFactor = 0.15;
        
        proj.sprite.x = Phaser.Math.Linear(proj.sprite.x, target.x, smoothingFactor);
        proj.sprite.y = Phaser.Math.Linear(proj.sprite.y, target.y, smoothingFactor);
        proj.glow.x = proj.sprite.x;
        proj.glow.y = proj.sprite.y;
      }
      
      // Limit history size to improve performance
      if (proj.history && proj.history.length > 3) {
        proj.history = proj.history.slice(-3);
      }
    }
    
    // Handle projectiles from reliable channel (if any)
    if (this.latestGameState && this.latestGameState.projectiles) {
      const currentProjectileIds = new Set();
      
      // Process projectiles from the latest game state
      this.latestGameState.projectiles.forEach(projectile => {
        currentProjectileIds.add(projectile.id);
        
        // Only update if we don't already have this projectile (fast channel handles existing ones)
        if (!this.projectiles[projectile.id]) {
          this.handleFastProjectileCreation(projectile);
        }
      });
      
      // Remove projectiles that are no longer in the game state
      Object.keys(this.projectiles).forEach(id => {
        if (!currentProjectileIds.has(parseInt(id))) {
          this.removeProjectile(parseInt(id));
        }
      });
    }
  }
  
  // Update the updateTeamDisplay method to handle both formats of team names
  updateTeamDisplay(team) {
    if (team) {
      // Normalize team name format (could be 'Red'/'Blue' or 'red'/'blue')
      const normalizedTeam = typeof team === 'string' ? team.toLowerCase() : team;
      let displayTeam = typeof team === 'string' ? team : normalizedTeam;
      
      // Ensure proper capitalization
      if (normalizedTeam === 'red') displayTeam = 'Red';
      else if (normalizedTeam === 'blue') displayTeam = 'Blue'; 
      else if (normalizedTeam === 'yellow') displayTeam = 'Yellow';
      else if (normalizedTeam === 'green') displayTeam = 'Green';
      
      console.log(`Updating team display to: ${displayTeam} (normalized: ${normalizedTeam})`);
      
      this.teamText.setText(`Team: ${displayTeam}`);
      
      // Set color based on team
      let teamColor = '#ffffff';
      if (normalizedTeam === 'red') teamColor = '#ff0000';
      else if (normalizedTeam === 'blue') teamColor = '#0000ff';
      else if (normalizedTeam === 'yellow') teamColor = '#ffdc00';
      else if (normalizedTeam === 'green') teamColor = '#00c800';
      
      this.teamText.setStyle({ font: "16px Arial", fill: teamColor });
      
      // Store the current team
      this.playerTeam = normalizedTeam;
    }
  }
  
  // Add method to show goal animation
  showGoalAnimation(scorerTeam) {
    // DISABLED: This method was causing stuck UI elements
    // Goals are now shown via simple notifications instead
    console.log(`Goal animation disabled for team: ${scorerTeam}`);
    return;
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
    console.log('Game shutting down, cleaning up resources');
    
    // Clean up connection
    this.cleanupConnection();
    
    // Close socket connection
    if (this.socket && this.socket.readyState !== WebSocket.CLOSED) {
        console.log('Closing game socket on shutdown');
        this.socket.close();
        this.socket = null;
    }
    
    // Reset global connection tracking
    window.gameSocket = null;
    window.activeConnections = 0;
    
    // Remove any UI elements we created
    const errorDiv = document.getElementById('connection-error');
    if (errorDiv) {
        errorDiv.remove();
    }
    
    // Clean up WebSocket connection
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
        this.socket.close();
    }
    
    // Clear intervals
    if (this.pingInterval) {
        clearInterval(this.pingInterval);
    }
    
    // Clear any pending timeouts
    if (this.connectionTimeout) {
        clearTimeout(this.connectionTimeout);
    }
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
    
    // Reset dual joysticks if active
    if (this.isMobile) {
      // Reset left joystick
      if (this.leftJoystickActive) {
        this.leftJoystickContainer.setVisible(false);
        this.leftJoystickLabel.setVisible(false);
        this.leftJoystickActive = false;
        this.leftJoystickTouchId = null;
        this.leftJoystickForceX = 0;
        this.leftJoystickForceY = 0;
      }
      
      // Right joystick removed - using touch-to-aim system
      
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
    
    // Reposition UI elements - hide debug info for mobile
    if (this.pingText) {
      this.pingText.setScrollFactor(0);
      this.pingText.setPosition(10, 10);
      this.pingText.setVisible(!this.isMobile); // Hide ping on mobile
    }
    
    // Legacy score display - keep hidden for mobile
    if (this.scoreLabel) {
      const scoreY = 40;
      this.scoreLabel.setScrollFactor(0);
      this.scoreLabel.setPosition(10, scoreY);
      this.scoreLabel.setVisible(!this.isMobile); // Hide for mobile
      
      if (this.redScoreText) {
        this.redScoreText.setScrollFactor(0);
        this.redScoreText.setPosition(this.scoreLabel.x + this.scoreLabel.width, scoreY);
        this.redScoreText.setVisible(!this.isMobile); // Hide for mobile
      }
      
      if (this.scoreSeparator) {
        this.scoreSeparator.setScrollFactor(0);
        this.scoreSeparator.setPosition(this.redScoreText.x + this.redScoreText.width, scoreY);
        this.scoreSeparator.setVisible(!this.isMobile); // Hide for mobile
      }
      
      if (this.blueScoreText) {
        this.blueScoreText.setScrollFactor(0);
        this.blueScoreText.setPosition(this.scoreSeparator.x + this.scoreSeparator.width, scoreY);
        this.blueScoreText.setVisible(!this.isMobile); // Hide for mobile
      }
    }
    
    // Team text position is fixed and doesn't need repositioning on resize - hide for mobile
    if (this.teamText) {
      this.teamText.setScrollFactor(0); // Ensure it stays fixed to screen
      this.teamText.setVisible(!this.isMobile); // Hide team text on mobile
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
    // Empty method - background removed for testing purposes
    console.log("Background disabled for testing purposes");
    return null;
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
    this.team3Score = message.team3_score || 0;
    this.team4Score = message.team4_score || 0;
    this.updateScoreDisplay();
    
    // Reset ball state to ensure it's visible and not grabbed
    if (this.ball) {
      this.ball.grabbed = false;
      this.ball.owner = null;
      this.ball.setVisible(true);
    }
    
    // Clear ball history to prevent old positions from affecting display
    this.ballHistory = [];
    this.latestBallState = null;
    
    // WORKAROUND: Reset input sequence to sync with server
    this.inputSequence = 1;
    
    // WORKAROUND: Clear input state to prevent stuck inputs
    this.inputState = {
      left: false,
      right: false, 
      up: false,
      down: false,
      shoot: false,
      boost: false
    };
    
    // WORKAROUND: Force send a fresh input after countdown
    this.time.delayedCall(6500, () => {
      this.sendInput();
    });
    
    // Ensure player movement will be re-enabled after countdown
    // (This is a backup in case countdown messages are missed)
    this.time.delayedCall(6000, () => {
      this.playerCanMove = true;
      if (this.countdownText) {
        this.countdownText.setVisible(false);
      }
    });
    
    // Show reset notification
    this.showNotification('Game has been reset!', false);
  }
  
  // Add method to show notifications
  showNotification(message, isError = false) {
    console.log("showNotification called with message:", message);
    // Create notification container if it doesn't exist
    if (!this.notificationContainer) {
      this.notificationContainer = this.add.container(this.cameras.main.width / 2, 150);
      this.notificationContainer.setDepth(1000);
      console.log("Created notification container at:", this.cameras.main.width / 2, 150);
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
    
    // Play shoot sound - using the working approach
    try {
      console.log('🎵 Playing shoot sound for shot by player:', playerId);
      if (window.testShootSound) {
        window.testShootSound();
        console.log('✅ Called working testShootSound for real shot');
      } else {
        console.error('❌ testShootSound not available, trying method');
        this.playShootSound();
      }
    } catch (soundError) {
      console.error('❌ Shoot sound error:', soundError);
    }
    
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
        // this.showNotification("Firing projectile!", false);
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

  // Add a method to show connection errors
  showConnectionError(message) {
    // Remove any existing error message
    const existingError = document.getElementById('connection-error');
    if (existingError) {
        existingError.remove();
    }
    
    // Create error message element
    const errorDiv = document.createElement('div');
    errorDiv.id = 'connection-error';
    errorDiv.style.position = 'absolute';
    errorDiv.style.top = '50%';
    errorDiv.style.left = '50%';
    errorDiv.style.transform = 'translate(-50%, -50%)';
    errorDiv.style.backgroundColor = 'rgba(0, 0, 0, 0.8)';
    errorDiv.style.color = 'white';
    errorDiv.style.padding = '20px';
    errorDiv.style.borderRadius = '10px';
    errorDiv.style.textAlign = 'center';
    errorDiv.style.zIndex = '1000';
    errorDiv.style.maxWidth = '80%';
    
    // Add message and refresh button
    errorDiv.innerHTML = `
        <p>${message}</p>
        <button id="refresh-button" style="
            background-color: #4CAF50;
            border: none;
            color: white;
            padding: 10px 20px;
            text-align: center;
            text-decoration: none;
            display: inline-block;
            font-size: 16px;
            margin: 10px 2px;
            cursor: pointer;
            border-radius: 5px;">
            Refresh Page
        </button>
    `;
    
    // Add to document
    document.body.appendChild(errorDiv);
    
    // Add refresh button event listener
    document.getElementById('refresh-button').addEventListener('click', () => {
        window.location.reload();
    });
  }

  // Process incoming messages from the server
  processIncomingMessages() {
    // Check if incomingBuffer exists
    if (!this.incomingBuffer) return;
    
    const messages = this.incomingBuffer.popReady();
    if (!messages || messages.length === 0) return;
    
    messages.forEach(data => {
      try {
        const msg = JSON.parse(data);
        
        // Handle ping response
        if (msg.type === "pong" && msg.timestamp) {
          this.pingValue = Date.now() - msg.timestamp;
          if (this.pingText) {
            this.pingText.setText("Ping: " + this.pingValue + " ms");
          }
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
              } else if (msg.players[this.clientId].team === 'Yellow') {
                this.ship.setTint(0xffdc00); // Yellow tint
              } else if (msg.players[this.clientId].team === 'Green') {
                this.ship.setTint(0x00c800); // Green tint
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
              console.log(`Creating new ship for player ${id}`);
              // Create new ship sprite using ship.png
              const sprite = this.add.sprite(shipState.x, shipState.y, 'ship')
                .setScale(0.1)
                .setOrigin(0.5);
              
              // Set ship color based on team
              if (shipState.team === 'Red') {
                sprite.setTint(0xff0000); // Red tint
              } else if (shipState.team === 'Blue') {
                sprite.setTint(0x0000ff); // Blue tint
              } else if (shipState.team === 'Yellow') {
                sprite.setTint(0xffdc00); // Yellow tint
              } else if (shipState.team === 'Green') {
                sprite.setTint(0x00c800); // Green tint
              }
              
              // Store the current team for change detection
              sprite.team = shipState.team;
              sprite.currentTeam = shipState.team;
              
              // Add cannon to other player's ship
              const cannon = this.add.sprite(shipState.x, shipState.y, 'cannon')
                .setScale(0.25)
                .setOrigin(0.3, 0.5)
                .setDepth(6);
              sprite.cannon = cannon; // Attach cannon to ship sprite for easy reference
              
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
                } else if (shipState.team === 'Yellow') {
                  sprite.setTint(0xffdc00); // Yellow tint
                } else if (shipState.team === 'Green') {
                  sprite.setTint(0x00c800); // Green tint
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
              
              // Clean up the cannon sprite
              if (this.otherShips[id].cannon) {
                this.otherShips[id].cannon.destroy();
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
              this.ball.setDepth(16); // Set consistent with free ball depth (above players and cannons)
            }
            this.ball.grabbed = msg.ball.grabbed;
            this.ball.owner = msg.ball.owner;
            
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
        if (msg.team1_score !== undefined) this.team1Score = msg.team1_score;
        if (msg.team2_score !== undefined) this.team2Score = msg.team2_score;
        if (msg.team3_score !== undefined) this.team3Score = msg.team3_score;
        if (msg.team4_score !== undefined) this.team4Score = msg.team4_score;
      } catch (error) {
        console.error('Error processing message:', error);
      }
    });
  }

  // Helper method to update cannon position and rotation
  updateCannonPosition() {
    if (!this.cannon || !this.ship) return;
    
    // For the player's cannon, use mouse aim direction or aimTarget for mobile
    let direction = { x: 0, y: 1 }; // Default to down
    
    if (this.input.activePointer) {
      // Use Phaser 3 activePointer for mouse world coordinates
      const mouseWorldX = this.input.activePointer.worldX;
      const mouseWorldY = this.input.activePointer.worldY;
      
      // Calculate direction from ship to mouse position
      const dx = mouseWorldX - this.ship.x;
      const dy = mouseWorldY - this.ship.y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      
      if (distance > 0) {
        direction = { x: dx / distance, y: dy / distance };
      }
    } else if (this.aimTarget && this.aimTarget.x !== undefined && this.aimTarget.y !== undefined) {
      // Use aimTarget for mobile devices
      const dx = this.aimTarget.x - this.ship.x;
      const dy = this.aimTarget.y - this.ship.y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      
      if (distance > 0) {
        direction = { x: dx / distance, y: dy / distance };
      }
    } else {
      // Fallback to character direction if no mouse input or aimTarget
      direction = this.getCannonPosition(this.ship);
    }
    
    // Position the cannon in front of the ship based on direction
    const cannonDistance = 24; // Distance from ship center to cannon position
    this.cannon.x = this.ship.x + direction.x * cannonDistance;
    this.cannon.y = this.ship.y + direction.y * cannonDistance;
    
    // Calculate rotation angle for the cannon
    const angle = Math.atan2(direction.y, direction.x);
    this.cannon.rotation = angle;
    
    // Make the cannon more visible when rocket is ready
    if (this.serverState.ship && this.serverState.ship.rocket_cooldown === 0) {
      this.cannon.setTint(0xffff00); // Yellow tint when ready
    } else {
      this.cannon.clearTint();
    }
  }
  
  // Helper method to get direction from movement vector
  getDirectionFromVector(direction) {
    if (Math.abs(direction.x) > Math.abs(direction.y)) {
      return direction.x > 0 ? 'right' : 'left';
    } else {
      return direction.y > 0 ? 'down' : 'up';
    }
  }
  
  // Helper method to convert discrete direction to vector
  getDirectionVector(direction) {
    switch (direction) {
      case 'up': return { x: 0, y: -1 };
      case 'down': return { x: 0, y: 1 };
      case 'left': return { x: -1, y: 0 };
      case 'right': return { x: 1, y: 0 };
      default: return { x: 0, y: 0 };
    }
  }
  
  // Helper method to update ship animation based on movement
  updateShipAnimation(sprite, direction, isMoving = false) {
    // Animation disabled - using single ship.png sprite
    // Just store the direction for cannon positioning
    if (sprite) {
      sprite.lastDirection = direction;
    }
  }
  
  // Helper method to get cannon position based on stored direction
  getCannonPosition(sprite) {
    if (!sprite || !sprite.lastDirection) {
      return { x: 0, y: 1 }; // Default to down
    }
    
    // Use stored direction from updateShipAnimation
    const direction = sprite.lastDirection;
    
    // Normalize the direction for cannon positioning
    const length = Math.sqrt(direction.x * direction.x + direction.y * direction.y);
    if (length > 0) {
      return { x: direction.x / length, y: direction.y / length };
    }
    
    return { x: 0, y: 1 }; // Default to down
  }
  
  // Helper method to get ball offset position based on character's stored direction
  getBallOffsetPosition(sprite) {
    // Always center the ball on the ship when grabbed
    return { x: 0, y: 0 };
  }

  updateTeamDisplay(team) {
    const teamColors = {
      'Red': '#ff0000',
      'Blue': '#0078ff',
      'Yellow': '#ffdc00',
      'Green': '#00c800'
    };
    
    if (team && teamColors[team]) {
      const teamText = this.add.text(10, 10, `Team: ${team}`, {
        fontSize: '24px',
        fill: teamColors[team]
      });
      teamText.setScrollFactor(0);
      teamText.setDepth(1000);
      
      if (this.teamText) {
        this.teamText.destroy();
      }
      this.teamText = teamText;
    }
  }

  // Add method to show goal animation
  showGoalAnimation(scorerTeam) {
    // DISABLED: This method was causing stuck UI elements
    // Goals are now shown via simple notifications instead
    console.log(`Goal animation disabled for team: ${scorerTeam}`);
    return;
  }

  createScorePieChart() {
    // Clean up existing score pie chart
    if (this.scorePieChart) this.scorePieChart.destroy();
    if (this.scorePieTexts) this.scorePieTexts.forEach(t => t.destroy());
    if (this.scorePieTitle) this.scorePieTitle.destroy();
    
    // Create new score pie chart
    this.scorePieChart = this.add.graphics();
    this.scorePieTexts = [];
    
    // Position and size based on device type
    let centerX, centerY, radius;
    if (this.isMobile) {
      // Mobile: smaller chart, positioned below team buttons area
      centerX = this.cameras.main.centerX;
      centerY = 180; // Below team buttons
      radius = 25; // Much smaller for mobile
    } else {
      // Desktop: original positioning
      centerX = this.cameras.main.centerX;
      centerY = 80; // Top of screen
      radius = 50;
    }
    
    // Team data with scores - filter based on map type
    let teams = [
      { name: 'Red', color: 0xff0000, score: this.team1Score || 0 },
      { name: 'Blue', color: 0x0078ff, score: this.team2Score || 0 },
      { name: 'Yellow', color: 0xffdc00, score: this.team3Score || 0 },
      { name: 'Green', color: 0x00c800, score: this.team4Score || 0 },
    ];
    
    // Filter teams for soccer map (only Red and Blue)
    if (this.isSoccerMap) {
      teams = teams.filter(team => team.name === 'Red' || team.name === 'Blue');
      console.log('Soccer map detected - showing only Red and Blue teams in score chart');
    }
    
    // Calculate total score for proportional slices
    const totalScore = teams.reduce((sum, team) => sum + team.score, 0);
    
    // If no scores yet, show equal slices
    if (totalScore === 0) {
      const anglePer = (2 * Math.PI) / teams.length;
      teams.forEach((team, i) => {
        const startAngle = i * anglePer - Math.PI/2;
        const endAngle = startAngle + anglePer;
        
        this.scorePieChart.beginPath();
        this.scorePieChart.moveTo(centerX, centerY);
        this.scorePieChart.arc(centerX, centerY, radius, startAngle, endAngle, false);
        this.scorePieChart.closePath();
        this.scorePieChart.fillStyle(team.color, 0.8);
        this.scorePieChart.fillPath();
        this.scorePieChart.lineStyle(2, 0xffffff, 1);
        this.scorePieChart.strokePath();
        
        // Add team name and score
        const midAngle = (startAngle + endAngle) / 2;
        const textX = centerX + Math.cos(midAngle) * (radius * 0.7);
        const textY = centerY + Math.sin(midAngle) * (radius * 0.7);
        const fontSize = this.isMobile ? '8px' : '12px';
        const text = this.add.text(textX, textY, `${team.name}\n${team.score}`, {
          font: `bold ${fontSize} Arial`,
          fill: '#fff',
          align: 'center',
          stroke: '#000',
          strokeThickness: this.isMobile ? 1 : 2
        }).setOrigin(0.5).setScrollFactor(0).setDepth(1001);
        this.scorePieTexts.push(text);
      });
    } else {
      // Show proportional slices based on scores
      let currentAngle = -Math.PI/2; // Start at top
      teams.forEach((team) => {
        const proportion = team.score / totalScore;
        const sliceAngle = proportion * 2 * Math.PI;
        const endAngle = currentAngle + sliceAngle;
        
        if (sliceAngle > 0) {
          this.scorePieChart.beginPath();
          this.scorePieChart.moveTo(centerX, centerY);
          this.scorePieChart.arc(centerX, centerY, radius, currentAngle, endAngle, false);
          this.scorePieChart.closePath();
          this.scorePieChart.fillStyle(team.color, 0.8);
          this.scorePieChart.fillPath();
          this.scorePieChart.lineStyle(2, 0xffffff, 1);
          this.scorePieChart.strokePath();
          
          // Add team name and score at the middle of the slice
          const midAngle = (currentAngle + endAngle) / 2;
          const textX = centerX + Math.cos(midAngle) * (radius * 0.7);
          const textY = centerY + Math.sin(midAngle) * (radius * 0.7);
          const fontSize = this.isMobile ? '8px' : '12px';
          const text = this.add.text(textX, textY, `${team.name}\n${team.score}`, {
            font: `bold ${fontSize} Arial`,
            fill: '#fff',
            align: 'center',
            stroke: '#000',
            strokeThickness: this.isMobile ? 1 : 2
          }).setOrigin(0.5).setScrollFactor(0).setDepth(1001);
          this.scorePieTexts.push(text);
        }
        
        currentAngle = endAngle;
      });
    }
    
    // Add title - smaller for mobile or hidden
    if (this.isMobile) {
      // Mobile: smaller title or no title for cleaner look
      this.scorePieTitle = this.add.text(centerX, centerY - radius - 15, 'SCORES', {
        font: 'bold 10px Arial',
        fill: '#ffffff',
        align: 'center',
        stroke: '#000',
        strokeThickness: 1
      }).setOrigin(0.5).setScrollFactor(0).setDepth(1001);
    } else {
      // Desktop: full title
      this.scorePieTitle = this.add.text(centerX, centerY - radius - 20, 'TEAM SCORES', {
        font: 'bold 16px Arial',
        fill: '#ffffff',
        align: 'center',
        stroke: '#000',
        strokeThickness: 2
      }).setOrigin(0.5).setScrollFactor(0).setDepth(1001);
    }
    
    this.scorePieChart.setScrollFactor(0).setDepth(1000);
  }

  createTeamPieMenu() {
    if (this.teamPieMenu) this.teamPieMenu.destroy();
    if (this.teamSwitchTexts) this.teamSwitchTexts.forEach(t => t.destroy());
    if (this.teamPieHits) this.teamPieHits.forEach(h => h.destroy());
    this.teamPieMenu = this.add.graphics();
    this.teamSwitchTexts = [];
    this.teamPieHits = [];
    const centerX = 120, centerY = 120, radius = 90;
    let teams = [
      { name: 'Red', color: 0xff0000, score: this.team1Score || 0, key: 'red' },
      { name: 'Blue', color: 0x0078ff, score: this.team2Score || 0, key: 'blue' },
      { name: 'Yellow', color: 0xffdc00, score: this.team3Score || 0, key: 'yellow' },
      { name: 'Green', color: 0x00c800, score: this.team4Score || 0, key: 'green' },
    ];
    
    // Filter teams for soccer map (only Red and Blue)
    if (this.isSoccerMap) {
      teams = teams.filter(team => team.key === 'red' || team.key === 'blue');
      console.log('Soccer map detected - showing only Red and Blue teams in team menu');
    }
    const anglePer = (2 * Math.PI) / teams.length;
    teams.forEach((team, i) => {
      const startAngle = i * anglePer - Math.PI/2;
      const endAngle = startAngle + anglePer;
      this.teamPieMenu.beginPath();
      this.teamPieMenu.moveTo(centerX, centerY);
      this.teamPieMenu.arc(centerX, centerY, radius, startAngle, endAngle, false);
      this.teamPieMenu.closePath();
      this.teamPieMenu.fillStyle(team.color, this.playerTeam === team.key ? 1 : 0.7);
      this.teamPieMenu.fillPath();
      // Add team name and score text
      const midAngle = (startAngle + endAngle) / 2;
      const textX = centerX + Math.cos(midAngle) * (radius * 0.65);
      const textY = centerY + Math.sin(midAngle) * (radius * 0.65);
      const t = this.add.text(textX, textY, `${team.name}\n${team.score}`, {
        font: 'bold 18px Arial',
        fill: '#fff',
        align: 'center',
        stroke: '#000',
        strokeThickness: 3
      }).setOrigin(0.5).setDepth(1001);
      this.teamSwitchTexts.push(t);
      // Add interactive area for switching
      const hit = this.add.zone(centerX, centerY, radius*2, radius*2).setOrigin(0.5).setInteractive();
      hit.on('pointerdown', pointer => {
        // Check if pointer is in this slice
        const dx = pointer.x - centerX;
        const dy = pointer.y - centerY;
        const angle = Math.atan2(dy, dx);
        let a = angle < -Math.PI/2 ? angle + 2*Math.PI : angle;
        if (a >= startAngle && a < endAngle) {
          if (this.playerTeam !== team.key) {
            this.showTeamSwitchConfirm(team.key, team.name);
          }
        }
      });
      hit.setDepth(1000);
      this.teamPieHits.push(hit);
    });
    this.teamPieMenu.setDepth(999);
  };

  // 3. Add confirmation dialog for team switching
  showTeamSwitchConfirm(teamKey, teamName) {
    if (this.teamSwitchDialog) this.teamSwitchDialog.destroy();
    if (this.teamSwitchText) this.teamSwitchText.destroy();
    if (this.teamSwitchYes) this.teamSwitchYes.destroy();
    if (this.teamSwitchNo) this.teamSwitchNo.destroy();
    const w = 220, h = 110;
    const x = 120, y = 120;
    this.teamSwitchDialog = this.add.rectangle(x, y, w, h, 0x222222, 0.95).setOrigin(0.5).setDepth(2000);
    this.teamSwitchText = this.add.text(x, y-20, `Switch to ${teamName} team?`, {
      font: 'bold 18px Arial', fill: '#fff', align: 'center'
    }).setOrigin(0.5).setDepth(2001);
    this.teamSwitchYes = this.add.text(x-40, y+20, 'Yes', {
      font: 'bold 20px Arial', fill: '#0f0', backgroundColor: '#222', padding: { left: 10, right: 10, top: 4, bottom: 4 }
    }).setOrigin(0.5).setInteractive().setDepth(2001);
    this.teamSwitchNo = this.add.text(x+40, y+20, 'No', {
      font: 'bold 20px Arial', fill: '#f00', backgroundColor: '#222', padding: { left: 10, right: 10, top: 4, bottom: 4 }
    }).setOrigin(0.5).setInteractive().setDepth(2001);
    this.teamSwitchYes.on('pointerdown', () => {
      this.switchTeam(teamKey);
      this.hideTeamSwitchConfirm();
    });
    this.teamSwitchNo.on('pointerdown', () => {
      this.hideTeamSwitchConfirm();
    });
  };
  hideTeamSwitchConfirm() {
    if (this.teamSwitchDialog) this.teamSwitchDialog.destroy();
    if (this.teamSwitchText) this.teamSwitchText.destroy();
    if (this.teamSwitchYes) this.teamSwitchYes.destroy();
    if (this.teamSwitchNo) this.teamSwitchNo.destroy();
  };
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
  // Note: Virtual joystick plugin disabled to avoid dependency issues
  // You can enable it by including the rex virtual joystick plugin
  // plugins: {
  //   global: [
  //     {
  //       key: 'rexVirtualJoystick',
  //       plugin: rexvirtualjoystickplugin,
  //       start: true
  //     }
  //   ]
  // },
  scene: MainScene
};
  
// Fullscreen button removed for cleaner mobile UI

const game = new Phaser.Game(config);

// After the class MainScene { ... } ends

// Patch updateScoreDisplay and updateTeamDisplay to call createTeamPieMenu
const oldUpdateScoreDisplay = MainScene.prototype.updateScoreDisplay;
MainScene.prototype.updateScoreDisplay = function() {
  if (oldUpdateScoreDisplay) oldUpdateScoreDisplay.call(this);
  this.createTeamPieMenu();
};

const oldUpdateTeamDisplay = MainScene.prototype.updateTeamDisplay;
MainScene.prototype.updateTeamDisplay = function(team) {
  if (oldUpdateTeamDisplay) oldUpdateTeamDisplay.call(this, team);
  this.createTeamPieMenu();
};
