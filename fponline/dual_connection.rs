// Dual Connection Manager - Handles both reliable (WebSocket) and fast (UDP-like) connections
use serde::{Serialize, Deserialize};
use tokio::sync::Mutex;
use std::sync::Arc;
use std::collections::HashMap;
use warp::ws::{WebSocket, Message};
use futures::{SinkExt, stream::SplitSink};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum MessageType {
    // Fast messages (UDP-like behavior)
    #[serde(rename = "input")]
    Input,
    #[serde(rename = "position_update")]
    PositionUpdate,
    #[serde(rename = "ball_position")]
    BallPosition,
    #[serde(rename = "projectile_update")]
    ProjectileUpdate,
    
    // Reliable messages (TCP-like behavior)
    #[serde(rename = "goal")]
    Goal,
    #[serde(rename = "team_switch")]
    TeamSwitch,
    #[serde(rename = "game_reset")]
    GameReset,
    #[serde(rename = "player_join")]
    PlayerJoin,
    #[serde(rename = "player_leave")]
    PlayerLeave,
    #[serde(rename = "game_state")]
    GameState,
    #[serde(rename = "auto_shoot")]
    AutoShoot,
    #[serde(rename = "projectile_fired")]
    ProjectileFired,
    #[serde(rename = "ball_shot")]
    BallShot,
    #[serde(rename = "ball_knocked")]
    BallKnocked,
    #[serde(rename = "explosion")]
    Explosion,
    #[serde(rename = "countdown")]
    Countdown,
}

pub struct DualConnection {
    pub client_id: u32,
    pub reliable_channel: Arc<Mutex<SplitSink<WebSocket, Message>>>,
    pub fast_channel: Option<Arc<Mutex<SplitSink<WebSocket, Message>>>>,
    pub last_fast_message_time: std::time::Instant,
}

impl DualConnection {
    pub fn new(client_id: u32, reliable_ws: Arc<Mutex<SplitSink<WebSocket, Message>>>) -> Self {
        Self {
            client_id,
            reliable_channel: reliable_ws,
            fast_channel: None,
            last_fast_message_time: std::time::Instant::now(),
        }
    }
    
    pub fn add_fast_channel(&mut self, fast_ws: SplitSink<WebSocket, Message>) {
        self.fast_channel = Some(Arc::new(Mutex::new(fast_ws)));
        println!("Fast channel established for client {}", self.client_id);
    }
    
    pub async fn send_message(&self, message_type: &MessageType, data: serde_json::Value) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let message_str = data.to_string();
        
        match message_type {
            MessageType::Input | MessageType::PositionUpdate | MessageType::BallPosition | MessageType::ProjectileUpdate => {
                // Send via fast channel if available, otherwise fallback to reliable
                if let Some(fast_channel) = &self.fast_channel {
                    let mut channel = fast_channel.lock().await;
                    if let Err(_) = channel.send(Message::text(message_str.clone())).await {
                        // Fast channel failed, fallback to reliable
                        println!("Fast channel failed for client {}, using reliable fallback", self.client_id);
                        let mut reliable = self.reliable_channel.lock().await;
                        reliable.send(Message::text(message_str)).await?;
                    }
                } else {
                    // No fast channel, use reliable
                    let mut reliable = self.reliable_channel.lock().await;
                    reliable.send(Message::text(message_str)).await?;
                }
            }
            _ => {
                // Always use reliable channel for important messages
                let mut reliable = self.reliable_channel.lock().await;
                reliable.send(Message::text(message_str)).await?;
            }
        }
        
        Ok(())
    }
    
    pub fn has_fast_channel(&self) -> bool {
        self.fast_channel.is_some()
    }
}

pub struct DualConnectionManager {
    connections: Arc<Mutex<HashMap<u32, DualConnection>>>,
}

impl DualConnectionManager {
    pub fn new() -> Self {
        Self {
            connections: Arc::new(Mutex::new(HashMap::new())),
        }
    }
    
    pub async fn add_reliable_connection(&self, client_id: u32, ws: Arc<Mutex<SplitSink<WebSocket, Message>>>) {
        let connection = DualConnection::new(client_id, ws);
        self.connections.lock().await.insert(client_id, connection);
        println!("Reliable connection established for client {}", client_id);
    }
    
    pub async fn add_fast_connection(&self, client_id: u32, ws: SplitSink<WebSocket, Message>) {
        let mut connections = self.connections.lock().await;
        if let Some(connection) = connections.get_mut(&client_id) {
            connection.add_fast_channel(ws);
        } else {
            println!("Warning: Fast connection for client {} but no reliable connection found", client_id);
        }
    }
    
    pub async fn broadcast_message(&self, message_type: MessageType, data: serde_json::Value, exclude_client: Option<u32>) {
        let connections = self.connections.lock().await;
        
        for (client_id, connection) in connections.iter() {
            if Some(*client_id) == exclude_client {
                continue;
            }
            
            // Clone the data for each client
            if let Err(e) = connection.send_message(&message_type, data.clone()).await {
                println!("Failed to send message to client {}: {:?}", client_id, e);
            }
        }
    }
    
    pub async fn send_to_client(&self, client_id: u32, message_type: MessageType, data: serde_json::Value) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let connections = self.connections.lock().await;
        if let Some(connection) = connections.get(&client_id) {
            connection.send_message(&message_type, data).await?;
        }
        Ok(())
    }
    
    pub async fn remove_client(&self, client_id: u32) {
        self.connections.lock().await.remove(&client_id);
        println!("Removed all connections for client {}", client_id);
    }
    
    pub async fn get_stats(&self) -> (usize, usize) {
        let connections = self.connections.lock().await;
        let total_clients = connections.len();
        let fast_clients = connections.values().filter(|c| c.has_fast_channel()).count();
        (total_clients, fast_clients)
    }
} 