use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;
use warp::ws::{Message, WebSocket};
use futures::{StreamExt};
use futures::SinkExt;
use warp::Filter;
use serde::{Deserialize, Serialize};
use once_cell::sync::Lazy;
use tokio::sync::mpsc;
use crate::game::{Game};

// Structure to represent a game instance
pub struct GameInstance {
    pub id: String,
    pub name: String,
    pub host_id: String,
    pub game: Arc<Mutex<Game>>,
    pub player_count: usize,
    pub max_players: usize,
    pub is_public: bool,
    pub port: Option<u16>,
}

// Structure to manage all game instances
pub struct LobbyManager {
    pub games: HashMap<String, GameInstance>,
    pub next_game_id: u32,
    pub clients: HashMap<String, Arc<Mutex<mpsc::UnboundedSender<Result<Message, warp::Error>>>>>,
}

// Message types for lobby communication
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum LobbyMessage {
    #[serde(rename = "create_game")]
    CreateGame {
        name: String,
        max_players: usize,
        is_public: bool,
        #[serde(default)]
        display_name: String,
    },
    #[serde(rename = "join_game")]
    JoinGame {
        game_id: String,
        #[serde(default)]
        display_name: String,
    },
    #[serde(rename = "list_games")]
    ListGames,
    #[serde(rename = "game_list")]
    GameList {
        games: Vec<GameInfo>,
    },
    #[serde(rename = "game_created")]
    GameCreated {
        game_id: String,
        port: u16,
    },
    #[serde(rename = "game_joined")]
    GameJoined {
        game_id: String,
        port: u16,
    },
    #[serde(rename = "error")]
    Error {
        message: String,
    },
    #[serde(rename = "ping")]
    Ping {
        timestamp: u64,
    },
    #[serde(rename = "pong")]
    Pong {
        timestamp: u64,
    },
    #[serde(rename = "heartbeat")]
    Heartbeat,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct GameInfo {
    pub id: String,
    pub name: String,
    pub player_count: usize,
    pub max_players: usize,
    pub is_public: bool,
}

impl LobbyManager {
    pub fn new() -> Self {
        Self {
            games: HashMap::new(),
            next_game_id: 1,
            clients: HashMap::new(),
        }
    }

    // Create a new game instance
    pub fn create_game(&mut self, name: String, max_players: usize, is_public: bool, host_id: String) -> String {
        let game_id = format!("game_{}", self.next_game_id);
        self.next_game_id += 1;

        println!("Creating new game: id={}, name={}, max_players={}, is_public={}", 
                 game_id, name, max_players, is_public);

        let game_instance = GameInstance {
            id: game_id.clone(),
            name,
            host_id,
            game: Arc::new(Mutex::new(Game::new())),
            player_count: 0,
            max_players,
            is_public,
            port: None,
        };

        self.games.insert(game_id.clone(), game_instance);
        
        // Log the current games
        println!("Current games: {}", self.games.keys().cloned().collect::<Vec<String>>().join(", "));
        
        game_id
    }

    // List available games
    pub fn list_games(&self) -> Vec<GameInfo> {
        let games = self.games.values()
            .filter(|game| game.is_public)
            .map(|game| GameInfo {
                id: game.id.clone(),
                name: game.name.clone(),
                player_count: game.player_count,
                max_players: game.max_players,
                is_public: game.is_public,
            })
            .collect::<Vec<GameInfo>>();
            
        println!("Listing games: found {} public games", games.len());
        for game in &games {
            println!("  - Game: id={}, name={}, players={}/{}", 
                     game.id, game.name, game.player_count, game.max_players);
        }
        
        games
    }

    pub fn join_game(&mut self, game_id: &str, _player_id: &str) -> Result<Arc<Mutex<Game>>, String> {
        println!("Attempting to join game: {}", game_id);
        
        if let Some(game) = self.games.get_mut(game_id) {
            if game.player_count >= game.max_players {
                println!("Game {} is full", game_id);
                return Err("Game is full".to_string());
            }
            
            game.player_count += 1;
            println!("Joined game {}: player count now {}/{}", 
                     game_id, game.player_count, game.max_players);
            Ok(game.game.clone())
        } else {
            println!("Game {} not found", game_id);
            println!("Available games: {}", self.games.keys().cloned().collect::<Vec<String>>().join(", "));
            Err("Game not found".to_string())
        }
    }

    // Remove a game instance
    pub fn remove_game(&mut self, game_id: &str) {
        println!("Removing game with ID: {}", game_id);
        self.games.remove(game_id);
    }
    
    // Check for and remove empty games
    pub fn cleanup_empty_games(&mut self) {
        let empty_games: Vec<String> = self.games.iter()
            .filter(|(_, instance)| {
                if let Ok(game) = instance.game.try_lock() {
                    return game.players.is_empty();
                }
                false
            })
            .map(|(id, _)| id.clone())
            .collect();

        for game_id in empty_games {
            println!("Cleanup: Removing empty game with ID: {}", game_id);
            self.games.remove(&game_id);
        }
        
        // Also clean up any disconnected clients
        let disconnected_clients: Vec<String> = self.clients.iter()
            .filter(|(_, client)| {
                if let Ok(sender) = client.try_lock() {
                    return sender.is_closed();
                }
                true
            })
            .map(|(id, _)| id.clone())
            .collect();

        for client_id in disconnected_clients {
            println!("Cleanup: Removing disconnected client: {}", client_id);
            self.clients.remove(&client_id);
        }
        
        // Print resource usage after cleanup
        self.debug_print_resources();
    }

    // Debug method to print all game instances
    pub fn debug_print_games(&self) {
        println!("=== DEBUG: Current Game Instances ===");
        if self.games.is_empty() {
            println!("No game instances available");
        } else {
            for (id, game) in &self.games {
                println!("Game ID: {}, Name: {}, Players: {}/{}, Public: {}", 
                         id, game.name, game.player_count, game.max_players, game.is_public);
            }
        }
        println!("===================================");
    }

    // Add debug method to print resource usage
    pub fn debug_print_resources(&self) {
        println!("=== Resource Usage Report ===");
        println!("Active Games: {}", self.games.len());
        println!("Active Clients: {}", self.clients.len());
        
        // Print details of each game
        for (id, game) in &self.games {
            println!("Game {}: Players={}, Max={}, Public={}", 
                id, game.player_count, game.max_players, game.is_public);
        }
        println!("===========================");
    }
}

// Global lobby manager
pub static LOBBY_MANAGER: Lazy<Arc<Mutex<LobbyManager>>> = Lazy::new(|| {
    Arc::new(Mutex::new(LobbyManager::new()))
});

// Handle a new lobby connection
pub async fn handle_lobby_connection(ws: WebSocket, lobby: Arc<Mutex<LobbyManager>>) {
    let (ws_tx, mut ws_rx) = ws.split();
    
    // Generate a unique client ID
    let client_id = uuid::Uuid::new_v4().to_string();
    
    // Create a channel for sending messages to the client
    let (tx, mut rx) = mpsc::unbounded_channel();
    
    // Store the sender in the lobby manager
    {
        let mut lobby = lobby.lock().await;
        lobby.clients.insert(client_id.clone(), Arc::new(Mutex::new(tx)));
    }
    
    // Task to forward messages from the channel to the WebSocket
    let mut ws_tx = ws_tx;
    tokio::task::spawn(async move {
        while let Some(message) = rx.recv().await {
            if let Ok(msg) = message {
                if let Err(e) = ws_tx.send(msg).await {
                    eprintln!("Error sending message to client: {:?}", e);
                    break;
                }
            } else {
                break;
            }
        }
    });
    
    // Process incoming messages
    while let Some(result) = ws_rx.next().await {
        match result {
            Ok(msg) => {
                if let Ok(text) = msg.to_str() {
                    if let Ok(lobby_msg) = serde_json::from_str::<LobbyMessage>(text) {
                        process_lobby_message(lobby_msg, &client_id, lobby.clone()).await;
                    }
                }
            }
            Err(e) => {
                eprintln!("WebSocket error: {:?}", e);
                break;
            }
        }
    }
    
    // Remove client when disconnected
    {
        let mut lobby = lobby.lock().await;
        lobby.clients.remove(&client_id);
    }
}

// Process lobby messages
async fn process_lobby_message(message: LobbyMessage, client_id: &str, lobby: Arc<Mutex<LobbyManager>>) {
    match message {
        LobbyMessage::CreateGame { name, max_players, is_public, display_name } => {
            println!("Client {} is creating a game: {}", client_id, name);
            
            // Find an available port
            let port = find_available_port().await;
            
            let game_id = {
                let mut lobby_guard = lobby.lock().await;
                lobby_guard.create_game(name, max_players, is_public, client_id.to_string())
            };
            
            // Create a new game instance
            let game = {
                let lobby_guard = lobby.lock().await;
                if let Some(game_instance) = lobby_guard.games.get(&game_id) {
                    game_instance.game.clone()
                } else {
                    eprintln!("Failed to get game instance after creation");
                    return;
                }
            };
            
            // Set the display name for the host player
            {
                let mut game_lock = game.lock().await;
                for (_, player) in game_lock.players.iter_mut() {
                    player.set_display_name(display_name.clone());
                    break; // Only set for the first player (host)
                }
            }
            
            // Update the port in the game instance
            {
                let mut lobby_guard = lobby.lock().await;
                if let Some(game_instance) = lobby_guard.games.get_mut(&game_id) {
                    game_instance.port = Some(port);
                }
            }
            
            // Start the game server
            tokio::spawn(game_server(port, game.clone()));
            
            // Start the game update loop
            tokio::spawn(game_update_loop_for_instance(game));
            
            // Send the game created message back to the client
            send_to_client(
                client_id,
                LobbyMessage::GameCreated {
                    game_id: game_id.clone(),
                    port,
                },
                lobby.clone(),
            )
            .await;
            
            // Debug print the games
            {
                let lobby_guard = lobby.lock().await;
                lobby_guard.debug_print_games();
            }
        }
        LobbyMessage::JoinGame { game_id, display_name } => {
            println!("Client {} is joining game: {}", client_id, game_id);
            
            let join_result = {
                let mut lobby_guard = lobby.lock().await;
                lobby_guard.join_game(&game_id, client_id)
            };
            
            match join_result {
                Ok(game) => {
                    // Set the display name for the joining player
                    {
                        let mut game_lock = game.lock().await;
                        for (_, player) in game_lock.players.iter_mut() {
                            if player.display_name == format!("Player {}", player.id) {
                                player.set_display_name(display_name.clone());
                                break;
                            }
                        }
                    }
                    
                    // Get the port for the game
                    let port = {
                        let lobby_guard = lobby.lock().await;
                        if let Some(game_instance) = lobby_guard.games.get(&game_id) {
                            game_instance.port.unwrap_or(8081) // Default to 8081 if no port is set
                        } else {
                            eprintln!("Failed to get game instance after joining");
                            return;
                        }
                    };
                    
                    // Send the game joined message back to the client
                    send_to_client(
                        client_id,
                        LobbyMessage::GameJoined {
                            game_id: game_id.clone(),
                            port,
                        },
                        lobby.clone(),
                    )
                    .await;
                    
                    // Debug print the games
                    {
                        let lobby_guard = lobby.lock().await;
                        lobby_guard.debug_print_games();
                    }
                }
                Err(e) => {
                    // Send an error message back to the client
                    send_to_client(
                        client_id,
                        LobbyMessage::Error {
                            message: e,
                        },
                        lobby.clone(),
                    )
                    .await;
                }
            }
        },
        LobbyMessage::ListGames => {
            let games = {
                let lobby = lobby.lock().await;
                lobby.list_games()
            };
            
            send_to_client(
                client_id,
                LobbyMessage::GameList { games },
                lobby.clone()
            ).await;
        },
        _ => {}
    }
}

// Send a message to a specific client
async fn send_to_client(client_id: &str, message: LobbyMessage, lobby: Arc<Mutex<LobbyManager>>) {
    let clients = {
        let lobby = lobby.lock().await;
        lobby.clients.clone()
    };
    
    if let Some(client) = clients.get(client_id) {
        if let Ok(json) = serde_json::to_string(&message) {
            let _ = client.lock().await.send(Ok(Message::text(json)));
        }
    }
}

// Run a game update loop for a specific game instance
pub async fn game_update_loop_for_instance(game: Arc<Mutex<Game>>) {
    println!("Starting game instance update loop");
    
    // Start the game update loop in a separate task
    let game_for_loop = game.clone();
    tokio::spawn(async move {
        println!("Game update loop started");
        let fixed_dt = 0.2; // Increased from 0.1 to 0.2
        let sub_steps = 3; // Reduced from 5 to 3
        let _sub_dt = fixed_dt / sub_steps as f32;
        let game_width = 2000.0;
        let game_height = 1200.0;
        
        // Counter for periodic cleanup checks
        let mut cleanup_counter = 0;
        let mut last_update = std::time::Instant::now();
        
        loop {
            {
                let mut game = game_for_loop.lock().await;
                
                // Only update if there are active players
                if !game.players.is_empty() {
                    game.update(fixed_dt, game_width, game_height);
                }
                
                // Check if the game is empty
                if game.players.is_empty() {
                    println!("Game is empty");
                }
            }
            
            // Periodically check for empty games in the lobby manager
            cleanup_counter += 1;
            if cleanup_counter >= 200 { // Increased from 100 to 200 (check every ~20 seconds)
                cleanup_counter = 0;
                if let Ok(mut lobby) = LOBBY_MANAGER.try_lock() {
                    lobby.cleanup_empty_games();
                }
            }
            
            // Adaptive sleep based on actual update time
            let elapsed = last_update.elapsed();
            let sleep_time = if elapsed < std::time::Duration::from_millis((fixed_dt * 1000.0) as u64) {
                std::time::Duration::from_millis((fixed_dt * 1000.0) as u64) - elapsed
            } else {
                std::time::Duration::from_millis(1)
            };
            
            tokio::time::sleep(sleep_time).await;
            last_update = std::time::Instant::now();
        }
    });
}

// Helper function to provide the game instance to the WebSocket handler
pub fn with_game_instance(game: Arc<Mutex<Game>>) -> impl warp::Filter<Extract = (Arc<Mutex<Game>>,), Error = std::convert::Infallible> + Clone {
    warp::any().map(move || game.clone())
}

// Helper function to find an available port
async fn find_available_port() -> u16 {
    // For simplicity, we'll use a fixed port for now
    // In a production environment, you would want to dynamically find an available port
    8080
}

// Helper function to start a game server on a specific port
async fn game_server(_port: u16, _game: Arc<Mutex<crate::game::Game>>) {
    // In a real implementation, this would start a new server on the specified port
    // For now, we'll just log that we would start a server
    println!("Would start game server on port {}", _port);
    // We don't actually need to do anything here since we're using a single server for all games
} 