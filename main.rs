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
use chrono::Utc;

#[derive(Debug, Default)]
struct InputState {
    left: bool,
    right: bool,
    up: bool,
    down: bool,
    shoot: bool,
    boost: bool, // New field: true if boost (shift) is held.
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
    boost: f32, // Current boost meter (for display)
}

#[derive(Debug, Serialize, Clone)]
struct Ball {
    x: f32,
    y: f32,
    vx: f32,
    vy: f32,
    active: bool,
    grabbed: bool,
    // Renamed from shot_cooldown to grab_cooldown to indicate its use for ball grabbing collisions.
    grab_cooldown: f32,
    owner: Option<u32>,
}

#[derive(Debug)]
struct Player {
    id: u32,
    ship: Ship,
    input: InputState,
    last_seq: u32,
    velocity: (f32, f32), // For acceleration
    shoot_cooldown: f32,  // Individual shooting cooldown.
    boost: f32,           // Boost meter, max 200.
}

#[derive(Debug, Serialize)]
struct GameStateSnapshot {
    time: u64, // server timestamp in ms
    players: HashMap<u32, ShipState>,
    ball: Ball,
}

struct Game {
    ball: Ball,
    players: HashMap<u32, Player>,
    // Each client's sender is stored as an Arc<Mutex<SplitSink<WebSocket, Message>>>
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
                grab_cooldown: 0.0,
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
    boost: Option<bool>, // New field for boost input.
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

            // Decrement ball grab cooldown.
            if game.ball.grab_cooldown > 0.0 {
                game.ball.grab_cooldown -= fixed_dt;
                if game.ball.grab_cooldown < 0.0 { game.ball.grab_cooldown = 0.0; }
            }

            // Decrement each player's shoot cooldown.
            for player in game.players.values_mut() {
                if player.shoot_cooldown > 0.0 {
                    player.shoot_cooldown -= fixed_dt;
                    if player.shoot_cooldown < 0.0 {
                        player.shoot_cooldown = 0.0;
                    }
                }
            }

            // Regenerate boost for each player when not boosting.
            for player in game.players.values_mut() {
                if !player.input.boost && player.boost < 200.0 {
                    // Regenerate 10 units per second.
                    player.boost += 10.0 * fixed_dt;
                    if player.boost > 200.0 {
                        player.boost = 200.0;
                    }
                }
            }

            // Extract ball state.
            let ball_grabbed = game.ball.grabbed;
            let ball_owner = game.ball.owner;

            // --- Update players' ships with acceleration ---
            for player in game.players.values_mut() {
                // If the ship is holding the ball, move 10% slower.
                let slowdown = if ball_grabbed && ball_owner == Some(player.id) { 0.9 } else { 1.0 };

                // Boost multiplier: if boost is active and there is boost meter available,
                // apply extra acceleration. For example, multiplier 2.0.
                let boost_multiplier = if player.input.boost && player.boost > 0.0 { 2.0 } else { 1.0 };
                // Drain boost if active.
                if player.input.boost && player.boost > 0.0 {
                    // Consume 20 units per second.
                    player.boost -= 40.0 * fixed_dt;
                    if player.boost < 0.0 { player.boost = 0.0; }
                }

                let acceleration = 200.0 * slowdown * boost_multiplier;
                let max_speed = 100.0 * slowdown * boost_multiplier;

                let mut ax = 0.0;
                let mut ay = 0.0;
                if player.input.left { ax -= acceleration; }
                if player.input.right { ax += acceleration; }
                if player.input.up { ay -= acceleration; }
                if player.input.down { ay += acceleration; }

                player.velocity.0 += ax * fixed_dt;
                player.velocity.1 += ay * fixed_dt;

                let friction = 0.8;
                player.velocity.0 *= friction;
                player.velocity.1 *= friction;

                let speed = (player.velocity.0.powi(2) + player.velocity.1.powi(2)).sqrt();
                if speed > max_speed {
                    let scale = max_speed / speed;
                    player.velocity.0 *= scale;
                    player.velocity.1 *= scale;
                }

                player.ship.x += player.velocity.0 * fixed_dt;
                player.ship.y += player.velocity.1 * fixed_dt;

                player.ship.x = player.ship.x.clamp(0.0, game_width);
                player.ship.y = player.ship.y.clamp(0.0, game_height);
            }
            
            // --- Ship Collision Detection and Resolution ---
            {
                let collision_radius = 20.0;
                let player_ids: Vec<u32> = game.players.keys().cloned().collect();
                let mut adjustments: HashMap<u32, (f32, f32)> = HashMap::new();

                for i in 0..player_ids.len() {
                    for j in (i + 1)..player_ids.len() {
                        let id_i = player_ids[i];
                        let id_j = player_ids[j];
                        let (xi, yi) = (game.players[&id_i].ship.x, game.players[&id_i].ship.y);
                        let (xj, yj) = (game.players[&id_j].ship.x, game.players[&id_j].ship.y);
                        let dx = xi - xj;
                        let dy = yi - yj;
                        let dist = (dx * dx + dy * dy).sqrt();

                        if dist < collision_radius * 2.0 {
                            let overlap = collision_radius * 2.0 - dist;
                            let (nx, ny) = if dist > 0.0 { (dx / dist, dy / dist) } else { (1.0, 0.0) };
                            let adjustment = (nx * overlap / 2.0, ny * overlap / 2.0);
                            
                            adjustments.entry(id_i).and_modify(|e| { e.0 += adjustment.0; e.1 += adjustment.1; }).or_insert(adjustment);
                            adjustments.entry(id_j).and_modify(|e| { e.0 -= adjustment.0; e.1 -= adjustment.1; }).or_insert((-adjustment.0, -adjustment.1));

                            // On collision, if the ball is held by one of these players,
                            // drop it and set a grab cooldown of 0.5 seconds.
                            if game.ball.grabbed {
                                if let Some(owner_id) = game.ball.owner {
                                    if owner_id == id_i || owner_id == id_j {
                                        if let Some((x, y)) = game.players.get(&owner_id).map(|p| (p.ship.x, p.ship.y)) {
                                            game.ball.x = x;
                                            game.ball.y = y;
                                        }
                                        game.ball.grabbed = false;
                                        game.ball.owner = None;
                                        game.ball.grab_cooldown = 0.5;
                                    }
                                }
                            }
                        }
                    }
                }
                for (id, (dx, dy)) in adjustments {
                    if let Some(player) = game.players.get_mut(&id) {
                        player.ship.x += dx;
                        player.ship.y += dy;
                    }
                }
            }
            
            // --- Update ball physics ---
            if game.ball.active && !game.ball.grabbed {
                game.ball.x += game.ball.vx * fixed_dt;
                game.ball.y += game.ball.vy * fixed_dt;
                let friction = 0.98;
                game.ball.vx *= friction;
                game.ball.vy *= friction;
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
                if !game.ball.grabbed && game.ball.grab_cooldown == 0.0 {
                    let mut closest_id: Option<u32> = None;
                    let mut closest_dist2: f32 = f32::MAX;
                    let mut new_x = 0.0;
                    let mut new_y = 0.0;
                    for player in game.players.values() {
                        let dx = player.ship.x - game.ball.x;
                        let dy = player.ship.y - game.ball.y;
                        let dist2 = dx * dx + dy * dy;
                        if dist2 < (20.0 * 20.0) && dist2 < closest_dist2 {
                            closest_dist2 = dist2;
                            closest_id = Some(player.id);
                            new_x = player.ship.x;
                            new_y = player.ship.y;
                        }
                    }
                    if let Some(_id) = closest_id {
                        game.ball.grabbed = true;
                        game.ball.owner = closest_id;
                        game.ball.vx = 0.0;
                        game.ball.vy = 0.0;
                        game.ball.x = new_x;
                        game.ball.y = new_y;
                    }
                }
            }
            
            // --- Process shooting ---
            let shoot_update = if game.ball.grabbed {
                if let Some(owner_id) = game.ball.owner {
                    if let Some(player) = game.players.get(&owner_id) {
                        // Only allow shooting if the player's shoot cooldown is 0.
                        if player.input.shoot && player.shoot_cooldown <= 0.0 {
                            let target_x = player.input.target_x.unwrap_or(player.ship.x);
                            let target_y = player.input.target_y.unwrap_or(player.ship.y);
                            let mut dx = target_x - player.ship.x;
                            let mut dy = target_y - player.ship.y;
                            let mut mag = (dx * dx + dy * dy).sqrt();
                            let ball_speed = 300.0;
                            if mag <= 0.0 {
                                dx = 0.0;
                                dy = -1.0;
                                mag = 1.0;
                            }
                            // Adjust aim based on ship velocity.
                            let inaccuracy = 0.3;
                            let vel_mag = (player.velocity.0.powi(2) + player.velocity.1.powi(2)).sqrt();
                            if vel_mag > 0.0 {
                                let aim_norm = (dx / mag, dy / mag);
                                let vel_norm = (player.velocity.0 / vel_mag, player.velocity.1 / vel_mag);
                                let alignment = aim_norm.0 * vel_norm.0 + aim_norm.1 * vel_norm.1;
                                let error_factor = 1.0 - alignment.max(0.0);
                                dx += player.velocity.0 * inaccuracy * error_factor;
                                dy += player.velocity.1 * inaccuracy * error_factor;
                                mag = (dx * dx + dy * dy).sqrt();
                            }
                            Some((dx, dy, mag, ball_speed, owner_id))
                        } else {
                            None
                        }
                    } else {
                        None
                    }
                } else {
                    None
                }
            } else {
                None
            };
            if let Some((dx, dy, mag, ball_speed, owner_id)) = shoot_update {
                game.ball.vx = dx / mag * ball_speed;
                game.ball.vy = dy / mag * ball_speed;
                let new_pos = if let Some(player) = game.players.get(&owner_id) {
                    (player.ship.x, player.ship.y)
                } else {
                    (game.ball.x, game.ball.y)
                };
                game.ball.x = new_pos.0;
                game.ball.y = new_pos.1;
                game.ball.grabbed = false;
                game.ball.owner = None;
                // Set shoot cooldown for the shooter only.
                if let Some(player) = game.players.get_mut(&owner_id) {
                    let recoil_factor = 2.0; // Increased recoil for stronger pushback.
                    player.velocity.0 -= (dx / mag) * recoil_factor;
                    player.velocity.1 -= (dy / mag) * recoil_factor;
                    player.shoot_cooldown = 0.25;
                    player.input.shoot = false;
                }
            }
            
            // --- Build snapshot with server timestamp ---
            let now = Utc::now().timestamp_millis() as u64;
            let mut players_snapshot = HashMap::new();
            for (id, player) in game.players.iter() {
                players_snapshot.insert(*id, ShipState {
                    x: player.ship.x,
                    y: player.ship.y,
                    seq: player.last_seq,
                    boost: player.boost, // Include boost meter for display.
                });
            }
            let snapshot = json!(GameStateSnapshot {
                time: now,
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
            velocity: (0.0, 0.0),
            shoot_cooldown: 0.0,
            boost: 200.0, // New player starts with full boost.
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
                                if let Some(boost) = input_msg.boost {
                                    player.input.boost = boost;
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
