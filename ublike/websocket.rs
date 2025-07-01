// This module will handle WebSocket connections and message processing.

use warp::ws::{WebSocket, Message};
use serde_json::json;
use tokio::sync::Mutex;
use std::sync::Arc;
use crate::game::Game;
use crate::player::Player;
use crate::player::Team;
// use crate::webrtc_signaling::{WebRTCSignalingManager, is_webrtc_message, parse_webrtc_message}; // Removed - WebTransport used instead
use crate::dual_connection::{DualConnectionManager, MessageType};
// use crate::webrtc_datachannel::{WebRTCDataChannelManager, is_datachannel_signaling, is_datachannel_input}; // Removed - WebTransport used instead
use futures::{StreamExt, SinkExt};
use serde::{Serialize, Deserialize};
use warp::Filter;
// use once_cell::sync::Lazy; // Unused import removed
use chrono;

// WebRTC signaling manager removed - WebTransport handles signaling internally

#[derive(Deserialize, Debug)]
pub struct InputMessage {
    pub left: bool,
    pub right: bool,
    pub up: bool,
    pub down: bool,
    pub seq: u32,
    pub shoot: Option<bool>,
    pub boost: Option<bool>,
    pub target_x: Option<f32>,
    pub target_y: Option<f32>,
    #[serde(default)]
    pub display_name: String,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "type")]
enum PingMessage {
    #[serde(rename = "ping")]
    Ping { timestamp: u64 },
    #[serde(rename = "pong")]
    Pong { timestamp: u64 },
}

// Add a new message type for team switching
#[derive(Deserialize, Debug)]
struct TeamSwitchMessage {
    #[serde(rename = "type")]
    message_type: String,
    team: String,
}

#[derive(Deserialize, Debug)]
struct ReliableShootMessage {
    #[serde(rename = "type")]
    message_type: String,
    shot_id: u32,
    timestamp: u64,
    target_x: f32,
    target_y: f32,
    seq: u32,
}

pub async fn handle_connection(ws: WebSocket, game: Arc<Mutex<Game>>, dual_mgr: Arc<DualConnectionManager>) {
    let (tx, mut rx) = ws.split();
    let tx = Arc::new(Mutex::new(tx));

    // Get a unique player ID for this connection
    let (player_id, player_team, is_host) = {
        let mut game_lock = game.lock().await;
        let id = game_lock.next_id;
        game_lock.next_id += 1;
        
        println!("New reliable connection for player ID: {}", id);
        
        // Assign the player to a team (red or blue)
        let team = game_lock.assign_team();
        println!("Player {} assigned to team: {:?}", id, team);
        
        // Determine if this player should be the host (first player)
        let is_host = game_lock.players.is_empty();
        println!("Player {} is host: {}", id, is_host);
        
        // Add the player to this specific game instance
        let display_name = format!("Player_{}", id);
        let mut player = Player::new(id, team, display_name);
        player.is_host = is_host; // Set host status
        game_lock.players.insert(id, player);
        
        // Note: We no longer store WebSocket senders directly in game.clients
        // The dual connection manager handles all connections
        
        // Log the number of players in this game instance
        println!("Game now has {} players (Red: {}, Blue: {}, Yellow: {}, Green: {})", 
                 game_lock.players.len(), 
                 game_lock.red_team_count, 
                 game_lock.blue_team_count,
                 game_lock.yellow_team_count,
                 game_lock.green_team_count);
        
        (id, team, is_host)
    };
    
    // Add reliable connection to dual connection manager  
    dual_mgr.add_reliable_connection(player_id, Arc::clone(&tx)).await;

    // Send initial player ID, team, and host status to the client
    {
        let team_str = match player_team {
            Team::Red => "red",
            Team::Blue => "blue",
            Team::Yellow => "yellow",
            Team::Green => "green",
        };
        
        let init_msg = json!({ 
            "type": "init",
            "your_id": player_id,
            "team": team_str,
            "is_host": is_host
        });
        
        // Send via dual connection manager (reliable channel)
        let _ = dual_mgr.send_to_client(player_id, MessageType::PlayerJoin, init_msg).await;
    }

    while let Some(result) = rx.next().await {
        match result {
            Ok(msg) => {
                if msg.is_text() {
                    let txt = msg.to_str().unwrap_or_default();
                    
                    // Check for simple ping messages
                    if txt == "ping" {
                        // Simple ping-pong for connection testing
                        if let Err(e) = tx.lock().await.send(Message::text("pong")).await {
                            eprintln!("Error sending pong to player {}: {:?}", player_id, e);
                        }
                        continue;
                    }
                    
                    // Try to parse as ping message
                    if let Ok(ping_msg) = serde_json::from_str::<PingMessage>(txt) {
                        match ping_msg {
                            PingMessage::Ping { timestamp } => {
                                // Respond immediately with a pong.
                                let pong = PingMessage::Pong { timestamp };
                                let pong_text = serde_json::to_string(&pong).unwrap();
                                tx.lock().await.send(Message::text(pong_text)).await.unwrap();
                                continue;
                            }
                            _ => {}
                        }
                        continue;
                    }
                    
                    // Try to parse as team switch message
                    if let Ok(team_msg) = serde_json::from_str::<TeamSwitchMessage>(txt) {
                        if team_msg.message_type == "switch_team" {
                            println!("Received team switch request from player {}: {:?}", player_id, team_msg.team);
                            
                            let mut game = game.lock().await;
                            
                            // Debug: Print current team counts
                            println!("Current team counts - Red: {}, Blue: {}, Yellow: {}, Green: {}", 
                                     game.red_team_count, game.blue_team_count, game.yellow_team_count, game.green_team_count);
                            
                            // Convert string team to enum
                            let new_team_str = team_msg.team.as_str();
                            let new_team = match new_team_str {
                                "Red" => crate::player::Team::Red,
                                "Blue" => crate::player::Team::Blue,
                                "Yellow" => crate::player::Team::Yellow,
                                "Green" => crate::player::Team::Green,
                                _ => {
                                    // Invalid team, skip processing
                                    continue;
                                }
                            };
                            
                            // Get current player team before modifying
                            let current_team = match game.players.get(&player_id) {
                                Some(player) => player.team,
                                None => continue, // Player not found
                            };
                            
                            println!("Player {} wants to switch from {:?} to {:?}", player_id, current_team, new_team);
                            
                            // Only switch if it's a different team
                            if new_team != current_team {
                                // Recalculate team counts to ensure they're accurate
                                game.recalculate_team_counts();
                                
                                // Check if the new team can accept players
                                let can_join = game.can_join_team(new_team);
                                println!("Can player {} join {:?} team? {}", player_id, new_team, can_join);
                                
                                if !can_join {
                                    println!("Player {} cannot switch to {:?} team - team is full", player_id, new_team);
                                    
                                    // Send error message to client
                                    let error_msg = json!({
                                        "type": "error",
                                        "message": format!("{:?} team is full", new_team)
                                    });
                                    tx.lock().await.send(Message::text(error_msg.to_string())).await.unwrap();
                                    continue;
                                }
                                
                                // Update team counts first - subtract from current team
                                match current_team {
                                    crate::player::Team::Red => {
                                        game.red_team_count = game.red_team_count.saturating_sub(1);
                                        println!("Decremented red team count to {}", game.red_team_count);
                                    },
                                    crate::player::Team::Blue => {
                                        game.blue_team_count = game.blue_team_count.saturating_sub(1);
                                        println!("Decremented blue team count to {}", game.blue_team_count);
                                    },
                                    crate::player::Team::Yellow => {
                                        game.yellow_team_count = game.yellow_team_count.saturating_sub(1);
                                        println!("Decremented yellow team count to {}", game.yellow_team_count);
                                    },
                                    crate::player::Team::Green => {
                                        game.green_team_count = game.green_team_count.saturating_sub(1);
                                        println!("Decremented green team count to {}", game.green_team_count);
                                    },
                                }
                                
                                // Update new team count - add to new team
                                match new_team {
                                    crate::player::Team::Red => {
                                        game.red_team_count += 1;
                                        println!("Incremented red team count to {}", game.red_team_count);
                                    },
                                    crate::player::Team::Blue => {
                                        game.blue_team_count += 1;
                                        println!("Incremented blue team count to {}", game.blue_team_count);
                                    },
                                    crate::player::Team::Yellow => {
                                        game.yellow_team_count += 1;
                                        println!("Incremented yellow team count to {}", game.yellow_team_count);
                                    },
                                    crate::player::Team::Green => {
                                        game.green_team_count += 1;
                                        println!("Incremented green team count to {}", game.green_team_count);
                                    },
                                }
                                
                                // Now update the player's team
                                if let Some(player) = game.players.get_mut(&player_id) {
                                    player.team = new_team;
                                    println!("Player {} successfully switched to {:?} team", player_id, new_team);
                                    println!("Updated team counts - Red: {}, Blue: {}, Yellow: {}, Green: {}", 
                                             game.red_team_count, game.blue_team_count, game.yellow_team_count, game.green_team_count);
                                }
                            } else {
                                println!("Player {} is already on {:?} team, no switch needed", player_id, current_team);
                            }
                            
                            continue;
                        }
                    }
                    
                    // WebRTC message processing removed - WebTransport handles ultra-low latency input instead
                    
                    // Check for reset game message
                    if txt.contains("\"type\":\"reset_game\"") || txt.contains("\"type\": \"reset_game\"") {
                        println!("Received reset game request from player {}", player_id);
                        
                        // Check if the player is the host
                        let is_player_host = {
                            let game_lock = game.lock().await;
                            match game_lock.players.get(&player_id) {
                                Some(player) => player.is_host,
                                None => false
                            }
                        };
                        
                        if is_player_host {
                            println!("Player {} is host, processing reset game request", player_id);
                            let mut game_lock = game.lock().await;
                            game_lock.reset_game(Some(dual_mgr.clone()));
                        } else {
                            println!("Player {} is not host, ignoring reset game request", player_id);
                            // Optionally send a message back to the client that they don't have permission
                            let error_msg = json!({
                                "type": "error",
                                "message": "Only the host can reset the game"
                            });
                            tx.lock().await.send(Message::text(error_msg.to_string())).await.unwrap();
                        }
                        
                        continue;
                    }
                    
                    // Handle reliable shoot commands
                    if txt.contains("\"type\":\"reliable_shoot\"") {
                        match serde_json::from_str::<ReliableShootMessage>(txt) {
                            Ok(shoot_msg) => {
                                println!("Received reliable shoot command from player {}: shot_id={}, target=({}, {})", 
                                         player_id, shoot_msg.shot_id, shoot_msg.target_x, shoot_msg.target_y);
                                
                                let mut game_lock = game.lock().await;
                                let mut ack_success = false;
                                let mut ack_reason = "unknown_error";
                                
                                // Check ball conditions first (before mutable borrow)
                                let ball_available = game_lock.ball.grabbed && game_lock.ball.owner == Some(player_id);
                                
                                if let Some(player) = game_lock.players.get_mut(&player_id) {
                                    // Validate shot conditions
                                    if player.shoot_cooldown > 0.0 {
                                        ack_reason = "cooldown_active";
                                    } else if !ball_available {
                                        ack_reason = "no_ball";
                                    } else {
                                        // Valid shot - process immediately
                                        player.input.shoot = true;
                                        player.input.target_x = Some(shoot_msg.target_x);
                                        player.input.target_y = Some(shoot_msg.target_y);
                                        player.last_seq = shoot_msg.seq;
                                        
                                        // Store shot ID for tracking
                                        player.pending_shot_id = Some(shoot_msg.shot_id);
                                        
                                        ack_success = true;
                                        ack_reason = "accepted";
                                        
                                        println!("Reliable shoot accepted for player {}, shot_id={}", player_id, shoot_msg.shot_id);
                                    }
                                }
                                
                                // Send immediate acknowledgment
                                let ack_response = json!({
                                    "type": "shoot_ack",
                                    "shot_id": shoot_msg.shot_id,
                                    "success": ack_success,
                                    "reason": ack_reason,
                                    "timestamp": chrono::Utc::now().timestamp_millis() as u64
                                });
                                
                                if let Err(e) = tx.lock().await.send(Message::text(ack_response.to_string())).await {
                                    eprintln!("Error sending shoot ack to player {}: {:?}", player_id, e);
                                }
                            }
                            Err(e) => {
                                eprintln!("Error parsing reliable shoot message from player {}: {:?}", player_id, e);
                            }
                        }
                        continue;
                    }
                    
                    // Otherwise, parse as regular input.
                    match serde_json::from_str::<InputMessage>(txt) {
                        Ok(input_msg) => {
                            let mut game_lock = game.lock().await;
                            if let Some(player) = game_lock.players.get_mut(&player_id) {
                                // Debug: Log input processing
                                if input_msg.left || input_msg.right || input_msg.up || input_msg.down {
                                    println!("Server received movement input from player {}: left={}, right={}, up={}, down={}, seq={}", 
                                             player_id, input_msg.left, input_msg.right, input_msg.up, input_msg.down, input_msg.seq);
                                }
                                
                                player.input.left = input_msg.left;
                                player.input.right = input_msg.right;
                                player.input.up = input_msg.up;
                                player.input.down = input_msg.down;
                                if let Some(shoot) = input_msg.shoot {
                                    // Log when a shoot command is received
                                    if shoot {
                                        println!("Player {} is shooting", player_id);
                                    }
                                    player.input.shoot = shoot;
                                }
                                if let Some(boost) = input_msg.boost {
                                    // Log when a boost/projectile command is received
                                    if boost {
                                        println!("Player {} is firing a projectile. Current cooldown: {}", player_id, player.rocket_cooldown);
                                    } else {
                                        // println!("Player {} released boost button", player_id); // Commented out to reduce spam
                                    }
                                    player.input.boost = boost;
                                }
                                player.input.target_x = input_msg.target_x;
                                player.input.target_y = input_msg.target_y;
                                
                                // Update player display name if provided
                                if !input_msg.display_name.is_empty() {
                                    player.set_display_name(input_msg.display_name.clone());
                                }
                                
                                if input_msg.seq > player.last_seq {
                                    player.last_seq = input_msg.seq;
                                } else {
                                    println!("Server REJECTED input from player {}: received seq {} <= last_seq {}", 
                                             player_id, input_msg.seq, player.last_seq);
                                }
                            }
                        },
                        Err(e) => println!("Failed to parse input: {:?}", e),
                    }
                } else if msg.is_close() {
                    // Handle ball state reset on disconnect
                    let mut game_lock = game.lock().await;
                    if let Some(_player) = game_lock.players.remove(&player_id) {
                        if game_lock.ball.grabbed && game_lock.ball.owner == Some(player_id) {
                            // Reset ball state
                            game_lock.ball.grabbed = false;
                            game_lock.ball.owner = None;
                            game_lock.ball.grab_cooldown = 0.5; // Optional cooldown after dropping
                        }
                    }
                    break;
                }
            },
            Err(e) => {
                eprintln!("Error receiving message from player {}: {:?}", player_id, e);
                break;
            }
        }
    }
    
    let mut game_lock = game.lock().await;
    
    // WebRTC cleanup removed - WebTransport connections managed by dual connection manager
    
    game_lock.clients.remove(&player_id);
    
    // Remove player and update team counts
    if let Some(player) = game_lock.players.remove(&player_id) {
        // Decrement team count for the player's team
        match player.team {
            crate::player::Team::Red => game_lock.red_team_count = game_lock.red_team_count.saturating_sub(1),
            crate::player::Team::Blue => game_lock.blue_team_count = game_lock.blue_team_count.saturating_sub(1),
            crate::player::Team::Yellow => game_lock.yellow_team_count = game_lock.yellow_team_count.saturating_sub(1),
            crate::player::Team::Green => game_lock.green_team_count = game_lock.green_team_count.saturating_sub(1),
        }
        println!("Player {} (team: {:?}) disconnected", player_id, player.team);
    }
    
    // Recalculate team counts to ensure they're accurate
    game_lock.recalculate_team_counts();
    
    println!("Player {} disconnected. Game now has {} players (Red: {}, Blue: {}, Yellow: {}, Green: {})", 
             player_id, 
             game_lock.players.len(),
             game_lock.red_team_count,
             game_lock.blue_team_count,
             game_lock.yellow_team_count,
             game_lock.green_team_count);
}

pub fn with_game(game: Arc<Mutex<Game>>) -> impl warp::Filter<Extract = (Arc<Mutex<Game>>,), Error = std::convert::Infallible> + Clone {
    warp::any().map(move || game.clone())
}

// WebTransport-optimized connection handling
// Handle fast channel connections (for low-latency data)
pub async fn handle_fast_connection(ws: WebSocket, game: Arc<Mutex<Game>>, dual_mgr: Arc<DualConnectionManager>) {
    println!("Fast channel connection request received - handler called");
    let (tx, mut rx) = ws.split();
    
    // Wait for client to identify themselves
    println!("Waiting for fast channel handshake...");
    if let Some(result) = rx.next().await {
        if let Ok(msg) = result {
            if msg.is_text() {
                let txt = msg.to_str().unwrap_or_default();
                
                // Parse client ID from handshake message
                if let Ok(handshake) = serde_json::from_str::<serde_json::Value>(txt) {
                    if let Some(client_id) = handshake.get("client_id").and_then(|v| v.as_u64()) {
                        let client_id = client_id as u32;
                        println!("Fast channel handshake from client {}", client_id);
                        
                        // Add fast connection to dual connection manager
                        dual_mgr.add_fast_connection(client_id, tx).await;
                        
                        // Process fast channel messages
                        while let Some(result) = rx.next().await {
                            match result {
                                Ok(msg) => {
                                    if msg.is_text() {
                                        let txt = msg.to_str().unwrap_or_default();
                                        println!("Fast channel received ANY message from client {}: {}", client_id, txt);
                                        
                                        // Parse and process input messages
                                        if let Ok(input_msg) = serde_json::from_str::<InputMessage>(txt) {
                                            // Process input immediately with game state
                                            let mut game_state = game.lock().await;
                                            if let Some(player) = game_state.players.get_mut(&client_id) {
                                                player.input.left = input_msg.left;
                                                player.input.right = input_msg.right;
                                                player.input.up = input_msg.up;
                                                player.input.down = input_msg.down;
                                                player.input.boost = input_msg.boost.unwrap_or(false);
                                                player.input.target_x = input_msg.target_x;
                                                player.input.target_y = input_msg.target_y;
                                                player.input.shoot = input_msg.shoot.unwrap_or(false);
                                            }
                                        } else {
                                            println!("Fast channel received non-input message from client {}: {}", client_id, txt);
                                        }
                                    }
                                }
                                Err(e) => {
                                    println!("Fast channel error for client {}: {:?}", client_id, e);
                                    break;
                                }
                            }
                        }
                        
                        println!("Fast channel disconnected for client {}", client_id);
                        return;
                    }
                }
                
                println!("Invalid fast channel handshake: {}", txt);
            }
        }
    }
    
    println!("Fast channel connection failed - no valid handshake");
}

// WebRTC cleanup function removed - WebTransport handles connection management internally 