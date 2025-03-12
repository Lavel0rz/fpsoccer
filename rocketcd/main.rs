mod game;
mod player;
mod ball;
mod collision;
mod websocket;
mod lobby;

use warp::Filter;
use tokio::sync::Mutex;
use std::sync::Arc;
use crate::game::GLOBAL_GAME;
use crate::lobby::LOBBY_MANAGER;
use crate::websocket::{handle_connection, with_game};

#[tokio::main]
async fn main() {
    println!("Loaded map objects: {:?}", *crate::game::MAP_OBJECTS);
    println!("Starting server with single port configuration (8080)");
    
    // Create routes for both the lobby server and the default game server
    
    // Default game server route (for backward compatibility)
    let game_ws_route = warp::path("ws")
        .and(warp::ws())
        .and(with_game(GLOBAL_GAME.clone()))
        .map(|ws: warp::ws::Ws, game: Arc<Mutex<crate::game::Game>>| {
            println!("Default game connection request received");
            ws.on_upgrade(move |socket| handle_connection(socket, game))
        });
    
    // Game-specific route with game ID in the path
    let game_specific_route = warp::path!("game" / String / "ws")
        .and(warp::ws())
        .and(with_lobby(LOBBY_MANAGER.clone()))
        .map(|game_id: String, ws: warp::ws::Ws, lobby: Arc<Mutex<crate::lobby::LobbyManager>>| {
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
                    handle_connection(socket, game_instance).await
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
    
    // Combine routes
    let routes = game_ws_route
        .or(game_specific_route)
        .or(lobby_ws_route)
        .with(warp::cors().allow_any_origin());
    
    println!("WebSocket server listening on ws://0.0.0.0:8080");
    println!("Lobby server available at ws://0.0.0.0:8080/lobby");
    println!("Game-specific endpoints available at ws://0.0.0.0:8080/game/{{GAME_ID}}/ws");
    
    // Start the main game loop for the default game instance in a separate task
    tokio::spawn(async {
        // Wait a bit to ensure the server is up
        tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;
        crate::game::game_update_loop().await;
    });
    
    // Start a periodic task to clean up empty games
    let lobby_for_cleanup = LOBBY_MANAGER.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(tokio::time::Duration::from_secs(30)).await;
            println!("Running periodic cleanup task...");
            let mut lobby = lobby_for_cleanup.lock().await;
            lobby.cleanup_empty_games();
            
            // Debug print all games
            lobby.debug_print_games();
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
