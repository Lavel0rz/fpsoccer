use warp::Filter;
use futures::{StreamExt, SinkExt};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::time::{sleep, Duration};
use tokio::sync::Mutex;
use once_cell::sync::Lazy;
use std::sync::Arc;
use std::collections::HashMap;
use warp::ws::{WebSocket, Message};
use futures::stream::SplitSink;

#[derive(Debug, Default)]
struct InputState {
    left: bool,
    right: bool,
    up: bool,
    down: bool,
    shoot: bool,
    target_x: Option<f32>,
    target_y: Option<f32>,
}

#[derive(Debug, Serialize, Clone)]
struct Ship {
    x: f32,
    y: f32,
}

#[derive(Debug, Serialize)]
struct ShipState {
    x: f32,
    y: f32,
    seq: u32,
}

#[derive(Debug, Serialize, Clone)]
struct Ball {
    x: f32,
    y: f32,
    vx: f32,
    vy: f32,
    active: bool,
    grabbed: bool,
    shot_cooldown: f32,
    owner: Option<u32>,
}

#[derive(Debug)]
struct Player {
    id: u32,
    ship: Ship,
    input: InputState,
    last_seq: u32,
}

#[derive(Debug, Serialize)]
struct GameStateSnapshot {
    players: HashMap<u32, ShipState>,
    ball: Ball,
}

struct Game {
    ball: Ball,
    players: HashMap<u32, Player>,
    // Store each client's sender as an Arc<Mutex<SplitSink<WebSocket, Message>>>
    clients: HashMap<u32, Arc<Mutex<SplitSink<WebSocket, Message>>>>,
    next_id: u32,
}

impl Game {
    fn new() -> Self {
        Self {
            ball: Ball {
                x: 400.0,
                y: 300.0,
                vx: 0.0,
                vy: 0.0,
                active: true,
                grabbed: false,
                shot_cooldown: 0.0,
                owner: None,
            },
            players: HashMap::new(),
            clients: HashMap::new(),
            next_id: 1,
        }
    }
}

static GLOBAL_GAME: Lazy<Arc<Mutex<Game>>> = Lazy::new(|| Arc::new(Mutex::new(Game::new())));

#[derive(Debug, Deserialize)]
struct InputMessage {
    seq: u32,
    left: bool,
    right: bool,
    up: bool,
    down: bool,
    shoot: Option<bool>,
    target_x: Option<f32>,
    target_y: Option<f32>,
}

#[tokio::main]
async fn main() {
    // Start the centralized game loop.
    let _game_loop = tokio::spawn(game_update_loop());
    
    // Set up the WebSocket route.
    let ws_route = warp::path("ws")
        .and(warp::ws())
        .and(with_game(GLOBAL_GAME.clone()))
        .map(|ws: warp::ws::Ws, game: Arc<Mutex<Game>>| {
            ws.on_upgrade(move |socket| handle_connection(socket, game))
        });
    let routes = ws_route.with(warp::cors().allow_any_origin());
    
    println!("WebSocket server listening on ws://localhost:8080/ws");
    warp::serve(routes).run(([127, 0, 0, 1], 8080)).await;
}

fn with_game(game: Arc<Mutex<Game>>) -> impl warp::Filter<Extract = (Arc<Mutex<Game>>,), Error = std::convert::Infallible> + Clone {
    warp::any().map(move || game.clone())
}

async fn game_update_loop() {
    let fixed_dt = 0.1;
    let game_width = 800.0;
    let game_height = 600.0;
    loop {
        {
            let mut game = GLOBAL_GAME.lock().await;
            // --- Update players' ships ---
            for player in game.players.values_mut() {
                let ship_speed = 100.0;
                if player.input.left { player.ship.x -= ship_speed * fixed_dt; }
                if player.input.right { player.ship.x += ship_speed * fixed_dt; }
                if player.input.up { player.ship.y -= ship_speed * fixed_dt; }
                if player.input.down { player.ship.y += ship_speed * fixed_dt; }
                player.ship.x = player.ship.x.clamp(0.0, game_width);
                player.ship.y = player.ship.y.clamp(0.0, game_height);
            }
            // --- Update ball physics ---
            if game.ball.shot_cooldown > 0.0 {
                game.ball.shot_cooldown -= fixed_dt;
                if game.ball.shot_cooldown < 0.0 { game.ball.shot_cooldown = 0.0; }
            }
            if game.ball.active && !game.ball.grabbed {
                game.ball.x += game.ball.vx * fixed_dt;
                game.ball.y += game.ball.vy * fixed_dt;
                if game.ball.x <= 0.0 || game.ball.x >= game_width {
                    game.ball.vx = -game.ball.vx;
                    game.ball.x = game.ball.x.clamp(0.0, game_width);
                }
                if game.ball.y <= 0.0 || game.ball.y >= game_height {
                    game.ball.vy = -game.ball.vy;
                    game.ball.y = game.ball.y.clamp(0.0, game_height);
                }
            }
            // --- Process ball grabbing ---
            {
                let mut grab_update: Option<(bool, Option<u32>, f32, f32)> = None;
                if !game.ball.grabbed && game.ball.shot_cooldown == 0.0 {
                    // Iterate immutably over players.
                    for player in game.players.values() {
                        let dx = player.ship.x - game.ball.x;
                        let dy = player.ship.y - game.ball.y;
                        if dx * dx + dy * dy < (40.0 * 40.0) {
                            grab_update = Some((true, Some(player.id), player.ship.x, player.ship.y));
                            break;
                        }
                    }
                }
                if let Some((grabbed, owner, new_x, new_y)) = grab_update {
                    game.ball.grabbed = grabbed;
                    game.ball.owner = owner;
                    game.ball.vx = 0.0;
                    game.ball.vy = 0.0;
                    game.ball.x = new_x;
                    game.ball.y = new_y;
                }
            }
            // --- Process shooting ---
            let shoot_update = {
                let ball_grabbed = game.ball.grabbed;
                let ball_owner = game.ball.owner;
                let mut update: Option<(f32, f32, f32, f32, u32)> = None;
                // Iterate immutably to decide shooting parameters.
                for player in game.players.values() {
                    if player.input.shoot {
                        if ball_grabbed && ball_owner == Some(player.id) {
                            let target_x = player.input.target_x.unwrap_or(player.ship.x);
                            let target_y = player.input.target_y.unwrap_or(player.ship.y);
                            let dx = target_x - player.ship.x;
                            let dy = target_y - player.ship.y;
                            let mag = (dx * dx + dy * dy).sqrt();
                            let ball_speed = 300.0;
                            if mag > 0.0 {
                                update = Some((dx, dy, mag, ball_speed, player.id));
                            }
                        }
                    }
                }
                // Now, clear the shoot flag for all players.
                for player in game.players.values_mut() {
                    player.input.shoot = false;
                }
                update
            };
            if let Some((dx, dy, mag, ball_speed, owner_id)) = shoot_update {
                game.ball.vx = dx / mag * ball_speed;
                game.ball.vy = dy / mag * ball_speed;
                // Extract the player's ship position without holding an immutable borrow.
                let (new_x, new_y) = {
                    if let Some(player) = game.players.get(&owner_id) {
                        (player.ship.x, player.ship.y)
                    } else {
                        (game.ball.x, game.ball.y)
                    }
                };
                game.ball.x = new_x;
                game.ball.y = new_y;
                game.ball.grabbed = false;
                game.ball.owner = None;
                game.ball.shot_cooldown = 0.5;
            }
            // --- Build snapshot ---
            let mut players_snapshot = HashMap::new();
            for (id, player) in game.players.iter() {
                players_snapshot.insert(*id, ShipState { x: player.ship.x, y: player.ship.y, seq: player.last_seq });
            }
            let snapshot = json!(GameStateSnapshot {
                players: players_snapshot,
                ball: game.ball.clone(),
            });
            // --- Broadcast snapshot ---
            for (_id, sender) in game.clients.iter_mut() {
                let _ = sender.lock().await.send(Message::text(snapshot.to_string())).await;
            }
        }
        sleep(Duration::from_millis((fixed_dt * 1000.0) as u64)).await;
    }
}

async fn handle_connection(ws: WebSocket, game: Arc<Mutex<Game>>) {
    let (tx, mut rx) = ws.split();
    let tx = Arc::new(Mutex::new(tx));

    // Register new player.
    let player_id = {
        let mut game_lock = game.lock().await;
        let id = game_lock.next_id;
        game_lock.next_id += 1;
        game_lock.players.insert(id, Player {
            id,
            ship: Ship { x: 400.0, y: 300.0 },
            input: InputState::default(),
            last_seq: 0,
        });
        game_lock.clients.insert(id, Arc::clone(&tx));
        id
    };

    println!("New player connected: {}", player_id);

    // Send initial message with player id.
    {
        let init_msg = json!({ "your_id": player_id });
        let _ = tx.lock().await.send(Message::text(init_msg.to_string())).await;
    }

    // Process incoming messages.
    while let Some(result) = rx.next().await {
        match result {
            Ok(msg) => {
                if msg.is_text() {
                    let txt = msg.to_str().unwrap_or("");
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
                                player.input.target_x = input_msg.target_x;
                                player.input.target_y = input_msg.target_y;
                                if input_msg.seq > player.last_seq {
                                    player.last_seq = input_msg.seq;
                                }
                            }
                        },
                        Err(e) => eprintln!("Failed to parse input from player {}: {:?}", player_id, e),
                    }
                } else if msg.is_close() {
                    break;
                }
            },
            Err(e) => {
                eprintln!("WebSocket error for player {}: {:?}", player_id, e);
                break;
            }
        }
    }

    // Clean up on disconnect.
    let mut game_lock = game.lock().await;
    game_lock.players.remove(&player_id);
    game_lock.clients.remove(&player_id);
    println!("Player {} disconnected.", player_id);
}
