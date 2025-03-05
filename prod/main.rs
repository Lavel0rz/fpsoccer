mod game;
mod player;
mod ball;
mod collision;
mod websocket;

use warp::Filter;
use tokio::sync::Mutex;
use std::sync::Arc;
use crate::game::GLOBAL_GAME;
use crate::websocket::{handle_connection, with_game};

#[tokio::main]
async fn main() {
    println!("Loaded map objects: {:?}", *crate::game::MAP_OBJECTS);
    let _game_loop = tokio::spawn(crate::game::game_update_loop());
    
    let ws_route = warp::path("ws")
        .and(warp::ws())
        .and(with_game(GLOBAL_GAME.clone()))
        .map(|ws: warp::ws::Ws, game: Arc<Mutex<crate::game::Game>>| {
            ws.on_upgrade(move |socket| handle_connection(socket, game))
        });

    // Allow connections from any origin since we're behind Nginx
    let routes = ws_route.with(warp::cors().allow_any_origin());
    
    println!("WebSocket server listening on ws://0.0.0.0:8080");
    warp::serve(routes)
        .run(([0, 0, 0, 0], 8080))
        .await;
}