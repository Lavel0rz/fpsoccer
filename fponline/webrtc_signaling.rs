// WebRTC Signaling Module for Rust Server
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use tokio::sync::Mutex;
use std::sync::Arc;
use warp::ws::Message;
use futures::SinkExt;
use futures::stream::SplitSink;
use warp::ws::WebSocket;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebRTCSignalingMessage {
    #[serde(rename = "type")]
    pub message_type: String,
    #[serde(rename = "fromPeer")]
    pub from_peer: Option<u32>,
    #[serde(rename = "toPeer")]
    pub to_peer: Option<u32>,
    #[serde(rename = "signalType")]
    pub signal_type: Option<String>,
    #[serde(rename = "signalData")]
    pub signal_data: Option<Value>,
    #[serde(rename = "clientId")]
    pub client_id: Option<u32>,
}

#[derive(Debug, Clone)]
pub struct PeerConnection {
    pub peer1: u32,
    pub peer2: u32,
    pub established: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Clone)]
pub struct PendingOffer {
    pub from: u32,
    pub to: u32,
    pub timestamp: chrono::DateTime<chrono::Utc>,
}

pub struct WebRTCSignalingManager {
    pub peer_connections: Arc<Mutex<HashMap<String, PeerConnection>>>,
    pub pending_offers: Arc<Mutex<HashMap<String, PendingOffer>>>,
}

impl WebRTCSignalingManager {
    pub fn new() -> Self {
        Self {
            peer_connections: Arc::new(Mutex::new(HashMap::new())),
            pending_offers: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn handle_webrtc_message(
        &self,
        message: &WebRTCSignalingMessage,
        player_id: u32,
        clients: &HashMap<u32, Arc<Mutex<SplitSink<WebSocket, Message>>>>,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        match message.message_type.as_str() {
            "request_webrtc_peers" => {
                self.handle_peer_list_request(player_id, clients).await?;
            }
            "webrtc_signaling" => {
                if let (Some(from_peer), Some(to_peer), Some(signal_type), Some(signal_data)) = (
                    message.from_peer,
                    message.to_peer,
                    &message.signal_type,
                    &message.signal_data,
                ) {
                    self.handle_signaling(from_peer, to_peer, signal_type, signal_data, clients)
                        .await?;
                }
            }
            _ => {
                println!("Unknown WebRTC message type: {}", message.message_type);
            }
        }
        Ok(())
    }

    async fn handle_peer_list_request(
        &self,
        requesting_player: u32,
        clients: &HashMap<u32, Arc<Mutex<SplitSink<WebSocket, Message>>>>,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        // Get list of all connected clients except the requester
        let peer_list: Vec<u32> = clients
            .keys()
            .filter(|&&id| id != requesting_player)
            .copied()
            .collect();

        println!("Sending peer list to {}: {:?}", requesting_player, peer_list);

        // Send peer list to the requesting client
        if let Some(client_ws) = clients.get(&requesting_player) {
            let response = json!({
                "type": "webrtc_signaling",
                "fromPeer": "server",
                "toPeer": requesting_player,
                "signalType": "peer_list",
                "signalData": peer_list
            });

            let mut ws = client_ws.lock().await;
            ws.send(Message::text(response.to_string())).await?;
        }

        Ok(())
    }

    async fn handle_signaling(
        &self,
        from_peer: u32,
        to_peer: u32,
        signal_type: &str,
        signal_data: &Value,
        clients: &HashMap<u32, Arc<Mutex<SplitSink<WebSocket, Message>>>>,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        println!(
            "WebRTC signaling: {} -> {} ({})",
            from_peer, to_peer, signal_type
        );

        // Find the target peer's WebSocket connection
        if let Some(target_ws) = clients.get(&to_peer) {
            // Forward the signaling message to the target peer
            let forward_message = json!({
                "type": "webrtc_signaling",
                "fromPeer": from_peer,
                "toPeer": to_peer,
                "signalType": signal_type,
                "signalData": signal_data
            });

            let mut ws = target_ws.lock().await;
            ws.send(Message::text(forward_message.to_string())).await?;

            // Track peer connections
            match signal_type {
                "offer" => {
                    let offer_key = format!("{}-{}", from_peer, to_peer);
                    let pending_offer = PendingOffer {
                        from: from_peer,
                        to: to_peer,
                        timestamp: chrono::Utc::now(),
                    };
                    self.pending_offers
                        .lock()
                        .await
                        .insert(offer_key, pending_offer);
                }
                "answer" => {
                    let offer_key = format!("{}-{}", to_peer, from_peer);
                    if self.pending_offers.lock().await.remove(&offer_key).is_some() {
                        // Track successful connection
                        self.track_peer_connection(from_peer, to_peer).await;
                    }
                }
                _ => {}
            }
        } else {
            println!("Target peer {} not found for signaling", to_peer);
        }

        Ok(())
    }

    async fn track_peer_connection(&self, peer1: u32, peer2: u32) {
        let connection_key = format!("{}-{}", peer1, peer2);
        let connection = PeerConnection {
            peer1,
            peer2,
            established: chrono::Utc::now(),
        };

        self.peer_connections
            .lock()
            .await
            .insert(connection_key, connection);

        println!("WebRTC connection established: {} <-> {}", peer1, peer2);
    }

    pub async fn handle_client_disconnect(&self, client_id: u32, clients: &HashMap<u32, Arc<Mutex<SplitSink<WebSocket, Message>>>>) {
        println!("Cleaning up WebRTC connections for {}", client_id);

        // Remove pending offers
        let mut pending_offers = self.pending_offers.lock().await;
        pending_offers.retain(|_, offer| offer.from != client_id && offer.to != client_id);

        // Remove peer connections
        let mut peer_connections = self.peer_connections.lock().await;
        peer_connections.retain(|_, connection| {
            connection.peer1 != client_id && connection.peer2 != client_id
        });

        // Notify other clients that this peer is gone
        self.notify_peer_disconnection(client_id, clients).await;
    }

    async fn notify_peer_disconnection(&self, disconnected_peer: u32, clients: &HashMap<u32, Arc<Mutex<SplitSink<WebSocket, Message>>>>) {
        let message = json!({
            "type": "webrtc_signaling",
            "fromPeer": "server",
            "toPeer": "all",
            "signalType": "peer_disconnected",
            "signalData": { "peerId": disconnected_peer }
        });

        // Send to all connected clients
        for (&client_id, client_ws) in clients {
            if client_id != disconnected_peer {
                if let Ok(mut ws) = client_ws.try_lock() {
                    let _ = ws.send(Message::text(message.to_string())).await;
                }
            }
        }
    }

    pub async fn cleanup_old_offers(&self) {
        let now = chrono::Utc::now();
        let timeout = chrono::Duration::seconds(30);

        let mut pending_offers = self.pending_offers.lock().await;
        let initial_count = pending_offers.len();
        
        pending_offers.retain(|key, offer| {
            let should_keep = now.signed_duration_since(offer.timestamp) <= timeout;
            if !should_keep {
                println!("Cleaning up old offer: {}", key);
            }
            should_keep
        });

        let removed_count = initial_count - pending_offers.len();
        if removed_count > 0 {
            println!("Cleaned up {} old WebRTC offers", removed_count);
        }
    }

    pub async fn get_stats(&self) -> (usize, usize) {
        let peer_connections_count = self.peer_connections.lock().await.len();
        let pending_offers_count = self.pending_offers.lock().await.len();
        (peer_connections_count, pending_offers_count)
    }
}

// Helper function to check if a message is a WebRTC signaling message
pub fn is_webrtc_message(text: &str) -> bool {
    text.contains("\"type\":\"request_webrtc_peers\"") 
        || text.contains("\"type\":\"webrtc_signaling\"")
        || text.contains("\"type\": \"request_webrtc_peers\"")
        || text.contains("\"type\": \"webrtc_signaling\"")
}

// Helper function to parse WebRTC signaling message
pub fn parse_webrtc_message(text: &str) -> Result<WebRTCSignalingMessage, serde_json::Error> {
    serde_json::from_str(text)
} 