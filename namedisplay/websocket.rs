// This module will handle WebSocket connections and message processing.

use warp::ws::{WebSocket, Message};
use serde_json::json;
use tokio::sync::Mutex;
use std::sync::Arc;
use crate::game::Game;
use crate::player::Player;
use crate::player::Team;
use futures::{StreamExt, SinkExt};
use serde::{Serialize, Deserialize};
use warp::Filter;

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

pub async fn handle_connection(ws: WebSocket, game: Arc<Mutex<Game>>) {
    let (tx, mut rx) = ws.split();
    let tx = Arc::new(Mutex::new(tx));

    // Get a unique player ID for this connection
    let (player_id, player_team) = {
        let mut game_lock = game.lock().await;
        let id = game_lock.next_id;
        game_lock.next_id += 1;
        
        println!("New player connected with ID: {}", id);
        
        // Assign the player to a team (red or blue)
        let team = game_lock.assign_team();
        println!("Player {} assigned to team: {:?}", id, team);
        
        // Add the player to this specific game instance
        game_lock.players.insert(id, Player::new(id, team));
        
        // Store the client's WebSocket sender
        game_lock.clients.insert(id, Arc::clone(&tx));
        
        // Log the number of players in this game instance
        println!("Game now has {} players (Red: {}, Blue: {})", 
                 game_lock.players.len(), 
                 game_lock.red_team_count, 
                 game_lock.blue_team_count);
        
        (id, team)
    };

    // Send initial player ID and team to the client
    {
        let team_str = match player_team {
            Team::Red => "red",
            Team::Blue => "blue",
        };
        
        let init_msg = json!({ 
            "type": "init",
            "your_id": player_id,
            "team": team_str
        });
        tx.lock().await.send(Message::text(init_msg.to_string())).await.unwrap();
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
                            
                            // Convert string team to enum
                            let new_team_str = team_msg.team.as_str();
                            let new_team = match new_team_str {
                                "Red" => crate::player::Team::Red,
                                "Blue" => crate::player::Team::Blue,
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
                            
                            // Only switch if it's a different team
                            if new_team != current_team {
                                // Update team counts first
                                match current_team {
                                    crate::player::Team::Red => game.red_team_count = game.red_team_count.saturating_sub(1),
                                    crate::player::Team::Blue => game.blue_team_count = game.blue_team_count.saturating_sub(1),
                                }
                                
                                // Update new team count
                                match new_team {
                                    crate::player::Team::Red => game.red_team_count += 1,
                                    crate::player::Team::Blue => game.blue_team_count += 1,
                                }
                                
                                // Now update the player's team
                                if let Some(player) = game.players.get_mut(&player_id) {
                                    player.team = new_team;
                                    println!("Player {} switched to {:?} team", player_id, new_team);
                                }
                            }
                            
                            continue;
                        }
                    }
                    
                    // Otherwise, parse as regular input.
                    match serde_json::from_str::<InputMessage>(txt) {
                        Ok(input_msg) => {
                            let mut game_lock = game.lock().await;
                            if let Some(player) = game_lock.players.get_mut(&player_id) {
                                player.input.left = input_msg.left;
                                player.input.right = input_msg.right;
                                player.input.up = input_msg.up;
                                player.input.down = input_msg.down;
                                if let Some(shoot) = input_msg.shoot {
                                    player.input.shoot = shoot;
                                }
                                if let Some(boost) = input_msg.boost {
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
    game_lock.clients.remove(&player_id);
    game_lock.players.remove(&player_id);
    println!("Player {} disconnected. Game now has {} players (Red: {}, Blue: {})", 
             player_id, 
             game_lock.players.len(),
             game_lock.red_team_count,
             game_lock.blue_team_count);
}

pub fn with_game(game: Arc<Mutex<Game>>) -> impl warp::Filter<Extract = (Arc<Mutex<Game>>,), Error = std::convert::Infallible> + Clone {
    warp::any().map(move || game.clone())
} 