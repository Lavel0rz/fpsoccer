// Dual Connection Manager - Handles both reliable (WebSocket) and fast (UDP-like) connections
use serde::{Serialize, Deserialize};
use tokio::sync::Mutex;
use std::sync::Arc;
use std::collections::HashMap;
use warp::ws::{WebSocket, Message};
use futures::{SinkExt, stream::SplitSink};
use bytes::Bytes;

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

// WebTransport channel for ultra-low latency critical data
pub struct WebTransportChannel {
    pub send_stream: Arc<Mutex<wtransport::SendStream>>,
}

pub struct DualConnection {
    pub client_id: u32,
    pub reliable_channel: Arc<Mutex<SplitSink<WebSocket, Message>>>,
    pub fast_channel: Option<Arc<Mutex<SplitSink<WebSocket, Message>>>>, // Legacy WebSocket fast channel
    pub webtransport_channel: Option<WebTransportChannel>, // Ultra-low latency WebTransport
    pub last_fast_message_time: std::time::Instant,
}

impl DualConnection {
    pub fn new(client_id: u32, reliable_ws: Arc<Mutex<SplitSink<WebSocket, Message>>>) -> Self {
        Self {
            client_id,
            reliable_channel: reliable_ws,
            fast_channel: None,
            webtransport_channel: None,
            last_fast_message_time: std::time::Instant::now(),
        }
    }
    
    pub fn add_fast_channel(&mut self, fast_ws: SplitSink<WebSocket, Message>) {
        self.fast_channel = Some(Arc::new(Mutex::new(fast_ws)));
        println!("Fast channel established for client {}", self.client_id);
    }
    
    pub fn add_webtransport_channel(&mut self, send_stream: wtransport::SendStream) {
        self.webtransport_channel = Some(WebTransportChannel {
            send_stream: Arc::new(Mutex::new(send_stream)),
        });
        println!("⚡ WebTransport ultra-low latency channel established for client {}", self.client_id);
    }
    
    pub async fn send_message(&self, message_type: &MessageType, data: serde_json::Value) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let message_str = data.to_string();
        
        match message_type {
            // CRITICAL DATA: Use WebTransport for ultra-low latency (5-15ms)
            MessageType::Input | MessageType::PositionUpdate | MessageType::BallPosition | MessageType::ProjectileUpdate => {
                // Priority 1: WebTransport (ultra-low latency)
                if let Some(wt_channel) = &self.webtransport_channel {
                    let bytes = Bytes::from(message_str.clone());
                    let mut stream = wt_channel.send_stream.lock().await;
                    match stream.write_all(&bytes).await {
                        Ok(_) => {
                            // Successfully sent via WebTransport
                            return Ok(());
                        }
                        Err(_) => {
                            println!("⚠️ WebTransport failed for client {}, trying fast channel fallback", self.client_id);
                        }
                    }
                }
                
                // Priority 2: Fast WebSocket channel (if available)
                if let Some(fast_channel) = &self.fast_channel {
                    let mut channel = fast_channel.lock().await;
                    if let Err(_) = channel.send(Message::text(message_str.clone())).await {
                        println!("Fast channel failed for client {}, using reliable fallback", self.client_id);
                    } else {
                        return Ok(());
                    }
                }
                
                // Priority 3: Reliable WebSocket (final fallback)
                let mut reliable = self.reliable_channel.lock().await;
                reliable.send(Message::text(message_str)).await?;
            }
            _ => {
                // NON-CRITICAL DATA: Always use reliable WebSocket for safety
                let mut reliable = self.reliable_channel.lock().await;
                reliable.send(Message::text(message_str)).await?;
            }
        }
        
        Ok(())
    }
    
    pub fn has_fast_channel(&self) -> bool {
        self.fast_channel.is_some()
    }
    
    pub fn has_webtransport_channel(&self) -> bool {
        self.webtransport_channel.is_some()
    }
    
    pub fn get_connection_type(&self) -> &'static str {
        if self.webtransport_channel.is_some() {
            "WebTransport + WebSocket"
        } else if self.fast_channel.is_some() {
            "Dual WebSocket"
        } else {
            "WebSocket Only"
        }
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
    
    pub async fn add_webtransport_connection(&self, client_id: u32, send_stream: wtransport::SendStream) {
        let mut connections = self.connections.lock().await;
        if let Some(connection) = connections.get_mut(&client_id) {
            connection.add_webtransport_channel(send_stream);
            println!("🚀 Client {} upgraded to WebTransport ultra-low latency!", client_id);
        } else {
            println!("Warning: WebTransport connection for client {} but no reliable connection found", client_id);
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