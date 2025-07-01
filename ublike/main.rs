mod game;
mod player;
mod ball;
mod collision;
mod websocket;
mod lobby;
// mod webrtc_signaling; // Removed - WebTransport doesn't need complex signaling
mod dual_connection;
mod webtransport_relay;

use warp::Filter;
use tokio::sync::Mutex;
use std::sync::Arc;
use crate::game::GLOBAL_GAME;
use crate::lobby::LOBBY_MANAGER;
use crate::websocket::{handle_connection, handle_fast_connection, with_game};
use crate::dual_connection::DualConnectionManager;
// use crate::webrtc_datachannel::WebRTCDataChannelManager; // Removed - using WebTransport instead
use once_cell::sync::Lazy;

// Global dual connection manager
static DUAL_CONNECTION_MANAGER: Lazy<Arc<DualConnectionManager>> = Lazy::new(|| {
    println!("Initializing Dual Connection Manager...");
    Arc::new(DualConnectionManager::new())
});

// WebRTC DataChannel manager removed - WebTransport provides ultra-low latency instead

#[tokio::main]
async fn main() {
    println!("Loaded map objects: {:?}", *crate::game::MAP_OBJECTS);
    println!("Starting server with single port configuration (8080)");
    
    // Create routes for both the lobby server and the default game server
    
    // Default game server route (for backward compatibility)
    let game_ws_route = warp::path("ws")
        .and(warp::ws())
        .and(with_game(GLOBAL_GAME.clone()))
        .and(with_dual_manager(&DUAL_CONNECTION_MANAGER))
        .map(|ws: warp::ws::Ws, game: Arc<Mutex<crate::game::Game>>, dual_mgr: Arc<DualConnectionManager>| {
            println!("Default game connection request received");
            ws.on_upgrade(move |socket| handle_connection(socket, game, dual_mgr))
        });
    
    // Fast channel route for low-latency data
    let fast_ws_route = warp::path("fast")
        .and(warp::ws())
        .and(with_game(GLOBAL_GAME.clone()))
        .and(with_dual_manager(&DUAL_CONNECTION_MANAGER))
        .map(|ws: warp::ws::Ws, game: Arc<Mutex<crate::game::Game>>, dual_mgr: Arc<DualConnectionManager>| {
            println!("Fast channel route matched - upgrading WebSocket connection");
            ws.on_upgrade(move |socket| handle_fast_connection(socket, game, dual_mgr))
        });
    
    // Game-specific route with game ID in the path
    let game_specific_route = warp::path!("game" / String / "ws")
        .and(warp::ws())
        .and(with_lobby(LOBBY_MANAGER.clone()))
        .and(with_dual_manager(&DUAL_CONNECTION_MANAGER))
        .map(|game_id: String, ws: warp::ws::Ws, lobby: Arc<Mutex<crate::lobby::LobbyManager>>, dual_mgr: Arc<DualConnectionManager>| {
            println!("Game-specific connection request for game ID: {}", game_id);
            ws.on_upgrade(move |socket| {
                // Find the game instance for this game ID
                async move {
                    println!("WebSocket connection upgraded for game ID: {}", game_id);
                    let game_instance = {
                        let lobby = lobby.lock().await;
                        println!("Available games: {:?}", lobby.games.keys().collect::<Vec<_>>());
                        match lobby.games.get(&game_id) {
                            Some(instance) => {
                                println!("Found game instance for ID: {}", game_id);
                                instance.game.clone()
                            }
                            None => {
                                // If game not found, log an error
                                println!("ERROR: Game ID {} not found", game_id);
                                // Return the global game as a fallback
                                GLOBAL_GAME.clone()
                            }
                        }
                    };
                    
                    // Use the specific game instance for this connection
                    handle_connection(socket, game_instance, dual_mgr).await
                }
            })
        });
    
    // Lobby server route
    let lobby_ws_route = warp::path("lobby")
        .and(warp::ws())
        .and(with_lobby(LOBBY_MANAGER.clone()))
        .map(|ws: warp::ws::Ws, lobby: Arc<Mutex<crate::lobby::LobbyManager>>| {
            ws.on_upgrade(move |socket| crate::lobby::handle_lobby_connection(socket, lobby))
        });
    
    // WebTransport endpoint route (HTTP/3 endpoint simulation)
    let webtransport_route = warp::path("webtransport")
        .and(warp::get())
        .map(|| {
            println!("WebTransport endpoint accessed - simulating WebTransport support");
            warp::reply::with_status(
                "WebTransport endpoint ready (simulated)",
                warp::http::StatusCode::OK
            )
        });
    
    // Combine routes
    let routes = game_ws_route
        .or(fast_ws_route)
        .or(game_specific_route)
        .or(lobby_ws_route)
        .or(webtransport_route)
        .with(warp::cors().allow_any_origin());
    
    println!("WebSocket server listening on ws://0.0.0.0:8080");
    println!("Fast channel route available at ws://0.0.0.0:8080/fast");
    println!("Lobby server available at ws://0.0.0.0:8080/lobby");
    println!("Game-specific endpoints available at ws://0.0.0.0:8080/game/{{GAME_ID}}/ws");
    println!("WebTransport ultra-low latency server starting on https://0.0.0.0:8443");
    
    // Start the main game loop for the default game instance in a separate task
    tokio::spawn(async {
        // Wait a bit to ensure the server is up
        tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;
        crate::game::game_update_loop(DUAL_CONNECTION_MANAGER.clone()).await;
    });
    
    // Start a periodic task to clean up empty games (only for lobby-managed games)
    let lobby_for_cleanup = LOBBY_MANAGER.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(tokio::time::Duration::from_secs(300)).await; // Reduced frequency: every 5 minutes
            // println!("Running periodic cleanup task..."); // Commented out to reduce spam
            let mut lobby = lobby_for_cleanup.lock().await;
            lobby.cleanup_empty_games();
            
            // Only print debug info if there are actually games to show
            if !lobby.games.is_empty() {
                lobby.debug_print_games();
            }
        }
    });
    
    // WebRTC cleanup tasks removed - WebTransport handles connection management internally
    
    // Start WebTransport Relay Server for ultra-low latency (inspired by snek game)
    tokio::spawn(async move {
        let mut webtransport_relay = crate::webtransport_relay::WebTransportRelay::new(8443);
        
        if let Err(e) = webtransport_relay.start().await {
            eprintln!("❌ Failed to start WebTransport Relay: {}", e);
            println!("⚠️ WebTransport relay failed, continuing with WebSocket only");
        }
    });
    
    warp::serve(routes)
        .run(([0, 0, 0, 0], 8080))
        .await;
}

// Helper function to provide the lobby manager to the WebSocket handler
pub fn with_lobby(lobby: Arc<Mutex<crate::lobby::LobbyManager>>) -> impl warp::Filter<Extract = (Arc<Mutex<crate::lobby::LobbyManager>>,), Error = std::convert::Infallible> + Clone {
    warp::any().map(move || lobby.clone())
}

// Helper function to provide the dual connection manager to the WebSocket handler
pub fn with_dual_manager(dual_mgr: &'static Arc<DualConnectionManager>) -> impl warp::Filter<Extract = (Arc<DualConnectionManager>,), Error = std::convert::Infallible> + Clone {
    warp::any().map(move || dual_mgr.clone())
}

// WebRTC DataChannel manager helper removed - WebTransport integrated into dual connection manager