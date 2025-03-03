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
use tokio_rustls::{TlsAcceptor, rustls::{self, Certificate, PrivateKey, ServerConfig}};
use hyper::{service::make_service_fn, Server};
use hyper::server::conn::AddrIncoming;
use rustls::server::NoClientAuth; // Impo

#[derive(Deserialize, Debug)]
struct MapObject {
    #[serde(rename = "type")]
    obj_type: String, // e.g., "wall" or "goal"
    x: f32,
    y: f32,
    width: f32,
    height: f32,
}

// Load the map_data.json file at compile time.
static MAP_OBJECTS: Lazy<Vec<MapObject>> = Lazy::new(|| {
    let json_str = include_str!("../map_data.json");
    serde_json::from_str(json_str).expect("Failed to parse map_data.json")
});


// --- Ping Message Types ---
#[derive(Serialize, Deserialize)]
#[serde(tag = "type")]
enum PingMessage {
    #[serde(rename = "ping")]
    Ping { timestamp: u64 },
    #[serde(rename = "pong")]
    Pong { timestamp: u64 },
}
// --- Game Definitions ---
#[derive(Debug, Default)]
struct InputState {
    left: bool,
    right: bool,
    up: bool,
    down: bool,
    shoot: bool,
    boost: bool,
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
    boost: f32,
}

#[derive(Debug, Serialize, Clone)]
struct Ball {
    x: f32,
    y: f32,
    vx: f32,
    vy: f32,
    active: bool,
    grabbed: bool,
    grab_cooldown: f32,
    owner: Option<u32>,
}

#[derive(Debug)]
struct Player {
    id: u32,
    ship: Ship,
    input: InputState,
    last_seq: u32,
    velocity: (f32, f32),
    shoot_cooldown: f32,
    boost: f32,
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
    boost: Option<bool>,
    target_x: Option<f32>,
    target_y: Option<f32>,
}

// --- Collision Helper Functions and Constants ---

// AABB collision check (used for players, etc.)
fn aabb_collision(x1: f32, y1: f32, w1: f32, h1: f32, x2: f32, y2: f32, w2: f32, h2: f32) -> bool {
    x1 < x2 + w2 && x1 + w1 > x2 &&
    y1 < y2 + h2 && y1 + h1 > y2
}

const SHIP_WIDTH: f32 = 40.0;
const SHIP_HEIGHT: f32 = 40.0;

// For rectangular ball collisions.
const BALL_WIDTH: f32 = 20.0;
const BALL_HEIGHT: f32 = 20.0;

const WALL_COLLISION_INSET: f32 = 5.0;

/// Resolves a rectangular collision for the ball.
/// The wall's effective collision bounds are inset by WALL_COLLISION_INSET.
fn resolve_rect_collision(ball: &mut Ball, wall: &MapObject) {
    let ball_left = ball.x - BALL_WIDTH / 2.0;
    let ball_right = ball.x + BALL_WIDTH / 2.0;
    let ball_top = ball.y - BALL_HEIGHT / 2.0;
    let ball_bottom = ball.y + BALL_HEIGHT / 2.0;
    
    let wall_left = wall.x + WALL_COLLISION_INSET;
    let wall_right = wall.x + wall.width - WALL_COLLISION_INSET;
    let wall_top = wall.y + WALL_COLLISION_INSET;
    let wall_bottom = wall.y + wall.height - WALL_COLLISION_INSET;
    
    let overlap_x = if ball_right > wall_left && ball_left < wall_right {
        let overlap_left = ball_right - wall_left;
        let overlap_right = wall_right - ball_left;
        overlap_left.min(overlap_right)
    } else { 0.0 };
    
    let overlap_y = if ball_bottom > wall_top && ball_top < wall_bottom {
        let overlap_top = ball_bottom - wall_top;
        let overlap_bottom = wall_bottom - ball_top;
        overlap_top.min(overlap_bottom)
    } else { 0.0 };
    
    if overlap_x > 0.0 && overlap_y > 0.0 {
        if overlap_x < overlap_y {
            if ball.x < wall.x {
                ball.x -= overlap_x;
            } else {
                ball.x += overlap_x;
            }
            ball.vx = -ball.vx;
        } else {
            if ball.y < wall.y {
                ball.y -= overlap_y;
            } else {
                ball.y += overlap_y;
            }
            ball.vy = -ball.vy;
        }
    }
}

/// Resolves a rectangular collision for a ship.
/// The ship is treated as an AABB centered at ship.x, ship.y with dimensions SHIP_WIDTH and SHIP_HEIGHT.
/// When a collision is detected, the ship is pushed out along the axis of minimal penetration and
/// the corresponding velocity component is zeroed.
fn resolve_ship_collision(ship: &mut Ship, velocity: &mut (f32, f32), wall: &MapObject) {
    let ship_left = ship.x - SHIP_WIDTH / 2.0;
    let ship_right = ship.x + SHIP_WIDTH / 2.0;
    let ship_top = ship.y - SHIP_HEIGHT / 2.0;
    let ship_bottom = ship.y + SHIP_HEIGHT / 2.0;
    
    let wall_left = wall.x;
    let wall_right = wall.x + wall.width;
    let wall_top = wall.y;
    let wall_bottom = wall.y + wall.height;
    
    if ship_right > wall_left && ship_left < wall_right &&
       ship_bottom > wall_top && ship_top < wall_bottom {
        
        let overlap_x = if ship_right - wall_left < wall_right - ship_left {
            ship_right - wall_left
        } else {
            wall_right - ship_left
        };
        let overlap_y = if ship_bottom - wall_top < wall_bottom - ship_top {
            ship_bottom - wall_top
        } else {
            wall_bottom - ship_top
        };
        
        // Resolve along the axis of minimal penetration.
        if overlap_x < overlap_y {
            if ship.x < wall.x {
                ship.x -= overlap_x;
            } else {
                ship.x += overlap_x;
            }
            velocity.0 = 0.0;
        } else {
            if ship.y < wall.y {
                ship.y -= overlap_y;
            } else {
                ship.y += overlap_y;
            }
            velocity.1 = 0.0;
        }
    }
}
#[tokio::main]
async fn main() {
    println!("Loaded map objects: {:?}", *MAP_OBJECTS);
    let _game_loop = tokio::spawn(game_update_loop());
    
    let ws_route = warp::path("ws")
        .and(warp::ws())
        .and(with_game(GLOBAL_GAME.clone()))
        .map(|ws: warp::ws::Ws, game: Arc<Mutex<Game>>| {
            ws.on_upgrade(move |socket| handle_connection(socket, game))
        });

    // Allow connections from any origin since we're behind Nginx
    let routes = ws_route.with(warp::cors().allow_any_origin());
    
    println!("WebSocket server listening on ws://0.0.0.0:8080");
    warp::serve(routes)
        .run(([0, 0, 0, 0], 8080))
        .await;
}

fn with_game(game: Arc<Mutex<Game>>) -> impl warp::Filter<Extract = (Arc<Mutex<Game>>,), Error = std::convert::Infallible> + Clone {
    warp::any().map(move || game.clone())
}

async fn game_update_loop() {
    let fixed_dt = 0.1;
    let sub_steps = 5;
    let sub_dt = fixed_dt / sub_steps as f32;
    let game_width = 2000.0;
    let game_height = 1200.0;
    loop {
        {
            let mut game = GLOBAL_GAME.lock().await;
            
            // Update cooldowns.
            if game.ball.grab_cooldown > 0.0 {
                game.ball.grab_cooldown -= fixed_dt;
                if game.ball.grab_cooldown < 0.0 { game.ball.grab_cooldown = 0.0; }
            }
            for player in game.players.values_mut() {
                if player.shoot_cooldown > 0.0 {
                    player.shoot_cooldown -= fixed_dt;
                    if player.shoot_cooldown < 0.0 { player.shoot_cooldown = 0.0; }
                }
            }
            for player in game.players.values_mut() {
                if !player.input.boost && player.boost < 200.0 {
                    player.boost += 10.0 * fixed_dt;
                    if player.boost > 200.0 { player.boost = 200.0; }
                }
            }
            
            // --- Update players' ships ---
            let ball_grabbed = game.ball.grabbed;
            let ball_owner = game.ball.owner;
            for player in game.players.values_mut() {
                let slowdown = if ball_grabbed && ball_owner == Some(player.id) { 0.8 } else { 1.0 };
                let boost_multiplier = if player.input.boost && player.boost > 0.0 { 2.0 } else { 1.0 };
                if player.input.boost && player.boost > 0.0 {
                    player.boost -= 40.0 * fixed_dt;
                    if player.boost < 0.0 { player.boost = 0.0; }
                }
                let acceleration = 200.0 * slowdown * boost_multiplier;
                let max_speed = 100.0 * slowdown * boost_multiplier;
                let mut ax: f32 = 0.0;
                let mut ay: f32 = 0.0;
                if player.input.left { ax -= acceleration; }
                if player.input.right { ax += acceleration; }
                if player.input.up { ay -= acceleration; }
                if player.input.down { ay += acceleration; }
                
                if ax.abs() > acceleration * 1.5 || ay.abs() > acceleration * 1.5 {
                    eprintln!("Suspicious acceleration from player {}: ax={}, ay={}", player.id, ax, ay);
                }
                
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
            
            // --- Ship-Wall Collision Resolution ---
            // For each player ship, resolve collisions against every wall.
            for player in game.players.values_mut() {
                for wall in MAP_OBJECTS.iter().filter(|w| w.obj_type == "wall") {
                    resolve_ship_collision(&mut player.ship, &mut player.velocity, wall);
                }
            }
            
            // --- Player-Player Collision Resolution ---
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
            
            // --- Sub-Stepped Ball Physics and Improved Rectangular Wall Collision ---
            {
                for _ in 0..sub_steps {
                    if game.ball.active && !game.ball.grabbed {
                        game.ball.x += game.ball.vx * sub_dt;
                        game.ball.y += game.ball.vy * sub_dt;
                        let friction = 0.989;
                        game.ball.vx *= friction;
                        game.ball.vy *= friction;
                        
                        if game.ball.x - BALL_WIDTH / 2.0 <= 0.0 || game.ball.x + BALL_WIDTH / 2.0 >= game_width {
                            game.ball.vx = -game.ball.vx;
                            game.ball.x = game.ball.x.clamp(BALL_WIDTH / 2.0, game_width - BALL_WIDTH / 2.0);
                        }
                        if game.ball.y - BALL_HEIGHT / 2.0 <= 0.0 || game.ball.y + BALL_HEIGHT / 2.0 >= game_height {
                            game.ball.vy = -game.ball.vy;
                            game.ball.y = game.ball.y.clamp(BALL_HEIGHT / 2.0, game_height - BALL_HEIGHT / 2.0);
                        }
                    }
                    
                    let mut iterations = 0;
                    let max_iterations = 5;
                    loop {
                        let mut collision_occurred = false;
                        for wall in MAP_OBJECTS.iter().filter(|w| w.obj_type == "wall") {
                            let ball_left = game.ball.x - BALL_WIDTH / 2.0;
                            let ball_right = game.ball.x + BALL_WIDTH / 2.0;
                            let ball_top = game.ball.y - BALL_HEIGHT / 2.0;
                            let ball_bottom = game.ball.y + BALL_HEIGHT / 2.0;
                            
                            if ball_right > wall.x && ball_left < wall.x + wall.width &&
                               ball_bottom > wall.y && ball_top < wall.y + wall.height {
                                resolve_rect_collision(&mut game.ball, wall);
                                collision_occurred = true;
                            }
                        }
                        iterations += 1;
                        if !collision_occurred || iterations >= max_iterations {
                            break;
                        }
                    }
                }
            }
            
            // --- Process ball grabbing ---
            {
                if !game.ball.grabbed && game.ball.grab_cooldown == 0.0 {
                    let mut closest_id: Option<u32> = None;
                    let mut closest_dist2: f32 = f32::MAX;
                    let mut new_x = 0.0;
                    let mut new_y = 0.0;
                    let current_ball_x = game.ball.x;
                    let current_ball_y = game.ball.y;
                    
                    for player in game.players.values() {
                        let dx = player.ship.x - current_ball_x;
                        let dy = player.ship.y - current_ball_y;
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
            
            // --- Process shooting using impulse ---
            if game.ball.grabbed {
                if let Some(owner_id) = game.ball.owner {
                    if let Some(player) = game.players.get(&owner_id) {
                        if player.input.shoot && player.shoot_cooldown <= 0.0 {
                            let target_x = player.input.target_x.unwrap_or(player.ship.x).clamp(0.0, game_width);
                            let target_y = player.input.target_y.unwrap_or(player.ship.y).clamp(0.0, game_height);
                            
                            let mut dx = target_x - player.ship.x;
                            let mut dy = target_y - player.ship.y;
                            let mut mag = (dx * dx + dy * dy).sqrt();
                            
                            if mag < 1.0 {
                                dx = 0.0;
                                dy = -1.0;
                                mag = 1.0;
                            }
                            
                            let max_allowed = 500.0;
                            if mag > max_allowed {
                                let scale = max_allowed / mag;
                                dx *= scale;
                                dy *= scale;
                                mag = max_allowed;
                            }
                            
                            if mag > max_allowed * 0.9 {
                                eprintln!("Player {} shooting with near-max impulse: mag={}", owner_id, mag);
                            }
                            
                            let ship_mass = 1.0;
                            let ball_mass = 0.5;
                            let base_shot_force = 1400.0;
                            let dt = fixed_dt;
                            
                            let aim_norm = (dx / mag, dy / mag);
                            let impulse_base = (aim_norm.0 * base_shot_force * dt, aim_norm.1 * base_shot_force * dt);
                            let additional_impulse = (player.velocity.0 * dt, player.velocity.1 * dt);
                            let total_impulse = (impulse_base.0 + additional_impulse.0, impulse_base.1 + additional_impulse.1);
                            
                            let (ship_x, ship_y) = (player.ship.x, player.ship.y);
                            
                            game.ball.vx = total_impulse.0 / ball_mass;
                            game.ball.vy = total_impulse.1 / ball_mass;
                            game.ball.x = ship_x;
                            game.ball.y = ship_y;
                            
                            game.ball.grab_cooldown = 0.5;
                            
                            if let Some(player_mut) = game.players.get_mut(&owner_id) {
                                let recoil_factor = 1.0;
                                player_mut.velocity.0 -= (total_impulse.0 / ship_mass) * recoil_factor;
                                player_mut.velocity.1 -= (total_impulse.1 / ship_mass) * recoil_factor;
                                player_mut.shoot_cooldown = 0.25;
                                player_mut.input.shoot = false;
                            }
                            
                            game.ball.grabbed = false;
                            game.ball.owner = None;
                        }
                    }
                }
            }
            
            // --- Build and broadcast game state ---
            let now = Utc::now().timestamp_millis() as u64;
            let mut players_snapshot = HashMap::new();
            for (id, player) in game.players.iter() {
                players_snapshot.insert(*id, ShipState {
                    x: player.ship.x,
                    y: player.ship.y,
                    seq: player.last_seq,
                    boost: player.boost,
                });
            }
            let snapshot = json!(GameStateSnapshot {
                time: now,
                players: players_snapshot,
                ball: game.ball.clone(),
            });
            let snapshot_str = snapshot.to_string();
            // For each client, spawn a task to delay sending the snapshot by 50ms.
            for (_id, sender) in game.clients.iter_mut() {
                let msg = snapshot_str.clone();
                let sender = Arc::clone(sender);
                tokio::spawn(async move {
                    sleep(Duration::from_millis(0)).await;
                    let _ = sender.lock().await.send(Message::text(msg)).await;
                });
            }
        }
        sleep(Duration::from_millis((fixed_dt * 700.0) as u64)).await;
    }
}

async fn handle_connection(ws: WebSocket, game: Arc<Mutex<Game>>) {
    let (tx, mut rx) = ws.split();
    let tx = Arc::new(Mutex::new(tx));

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
            boost: 200.0,
        });
        game_lock.clients.insert(id, Arc::clone(&tx));
        id
    };

    println!("New player connected: {}", player_id);

    {
        let init_msg = json!({ "your_id": player_id });
        let _ = tx.lock().await.send(Message::text(init_msg.to_string())).await;
    }

    while let Some(result) = rx.next().await {
        match result {
            Ok(msg) => {
                if msg.is_text() {
                    let txt = msg.to_str().unwrap_or("");
                    // Check for ping messages.
                    if let Ok(ping_msg) = serde_json::from_str::<PingMessage>(txt) {
                        match ping_msg {
                            PingMessage::Ping { timestamp } => {
                                // Respond immediately with a pong.
                                let pong = PingMessage::Pong { timestamp };
                                let pong_text = serde_json::to_string(&pong).unwrap();
                                let _ = tx.lock().await.send(Message::text(pong_text)).await;
                                continue;
                            }
                            _ => {}
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
                                if input_msg.seq > player.last_seq {
                                    player.last_seq = input_msg.seq;
                                }
                            }
                        },
                        Err(e) => eprintln!("Failed to parse input from player {}: {:?}", player_id, e),
                    }
                } else if msg.is_close() {
                    // Handle ball state reset on disconnect
                    let mut game_lock = game.lock().await;
                    if let Some(player) = game_lock.players.remove(&player_id) {
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
                eprintln!("WebSocket error for player {}: {:?}", player_id, e);
                break;
            }
        }
    }
    let mut game_lock = game.lock().await;
    game_lock.clients.remove(&player_id);
    println!("Player {} disconnected.", player_id);
}

async fn broadcast_snapshot(clients: &HashMap<u32, Arc<Mutex<SplitSink<WebSocket, Message>>>>, snapshot: GameStateSnapshot) {
    let snapshot_str = json!(snapshot).to_string();
    for (_id, sender) in clients.iter() {
        let msg = snapshot_str.clone();
        let sender = Arc::clone(sender);
        tokio::spawn(async move {
            let _ = sender.lock().await.send(Message::text(msg)).await;
        });
    }
}
