use warp::Filter;
use futures::{StreamExt, SinkExt};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::time::{sleep, Duration};
use tokio::sync::Mutex;
use once_cell::sync::Lazy;
use std::sync::Arc;

#[derive(Debug, Default)]
struct InputState {
    left: bool,
    right: bool,
    up: bool,
    down: bool,
}

#[derive(Debug)]
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
}

#[derive(Debug, Serialize)]
struct GameState {
    ship: ShipState,
    ball: Ball,
}

/// When shooting, the client includes target coordinates.
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

// Global persistent state for the ball.
static GLOBAL_BALL: Lazy<Arc<Mutex<Ball>>> = Lazy::new(|| {
    Arc::new(Mutex::new(Ball {
        x: 400.0,
        y: 300.0,
        vx: 0.0,
        vy: 0.0,
        active: true,
    }))
});

#[tokio::main]
async fn main() {
    // Spawn a global update loop for ball physics.
    tokio::spawn(async {
        let fixed_dt = 0.1; // 100ms update interval
        let game_width: f32 = 800.0;
        let game_height: f32 = 600.0;
        loop {
            {
                let mut ball = GLOBAL_BALL.lock().await;
                if ball.active {
                    ball.x += ball.vx * fixed_dt;
                    ball.y += ball.vy * fixed_dt;
                    if ball.x <= 0.0 || ball.x >= game_width {
                        ball.vx = -ball.vx;
                        ball.x = ball.x.clamp(0.0, game_width);
                    }
                    if ball.y <= 0.0 || ball.y >= game_height {
                        ball.vy = -ball.vy;
                        ball.y = ball.y.clamp(0.0, game_height);
                    }
                }
            }
            sleep(Duration::from_millis((fixed_dt * 1000.0) as u64)).await;
        }
    });

    // WebSocket route.
    let ws_route = warp::path("ws")
        .and(warp::ws())
        .map(|ws: warp::ws::Ws| ws.on_upgrade(handle_websocket));
    let routes = ws_route.with(warp::cors().allow_any_origin());

    println!("WebSocket server listening on ws://localhost:8080/ws");
    warp::serve(routes)
        .run(([127, 0, 0, 1], 8080))
        .await;
}

async fn handle_websocket(ws: warp::ws::WebSocket) {
    // For each connection, create a new ship state (local, non-persistent).
    let local_ship = Arc::new(Mutex::new(Ship { x: 400.0, y: 300.0 }));
    let (tx, mut rx) = ws.split();
    let tx = Arc::new(Mutex::new(tx));
    let input_state = Arc::new(Mutex::new(InputState::default()));
    let last_seq = Arc::new(Mutex::new(0u32));

    // Use the persistent global ball.
    let ball = GLOBAL_BALL.clone();

    // Spawn a loop to update the local ship's movement based on input.
    let ship_for_movement = local_ship.clone();
    let input_state_for_movement = input_state.clone();
    tokio::spawn(async move {
        let fixed_dt = 0.1;
        let ship_speed = 100.0;
        let game_width: f32 = 800.0;
        let game_height: f32 = 600.0;
        loop {
            {
                let input = input_state_for_movement.lock().await;
                let mut ship = ship_for_movement.lock().await;
                if input.left {
                    ship.x -= ship_speed * fixed_dt;
                }
                if input.right {
                    ship.x += ship_speed * fixed_dt;
                }
                if input.up {
                    ship.y -= ship_speed * fixed_dt;
                }
                if input.down {
                    ship.y += ship_speed * fixed_dt;
                }
                ship.x = ship.x.clamp(0.0, game_width);
                ship.y = ship.y.clamp(0.0, game_height);
            }
            sleep(Duration::from_millis((fixed_dt * 1000.0) as u64)).await;
        }
    });

    // Spawn a loop to broadcast the game state (local ship and global ball) to the client.
    let ship_for_update = local_ship.clone();
    let ball_for_update = ball.clone();
    let tx_clone = Arc::clone(&tx);
    let last_seq_clone = Arc::clone(&last_seq);
    tokio::spawn(async move {
        let fixed_dt = 0.1;
        loop {
            let ship_state = {
                let ship = ship_for_update.lock().await;
                let seq = *last_seq_clone.lock().await;
                ShipState { x: ship.x, y: ship.y, seq }
            };
            let ball_state = {
                let ball = ball_for_update.lock().await;
                ball.clone()
            };
            let state = json!(GameState { ship: ship_state, ball: ball_state });
            if let Err(e) = tx_clone.lock().await.send(warp::ws::Message::text(state.to_string())).await {
                eprintln!("Error sending state: {:?}", e);
                break;
            }
            sleep(Duration::from_millis((fixed_dt * 1000.0) as u64)).await;
        }
    });

    // Process incoming messages from this client.
    while let Some(result) = rx.next().await {
        match result {
            Ok(msg) => {
                if msg.is_text() {
                    let txt = msg.to_str().unwrap_or("");
                    match serde_json::from_str::<InputMessage>(txt) {
                        Ok(input_msg) => {
                            {
                                let mut input = input_state.lock().await;
                                input.left = input_msg.left;
                                input.right = input_msg.right;
                                input.up = input_msg.up;
                                input.down = input_msg.down;
                            }
                            {
                                let mut seq_lock = last_seq.lock().await;
                                if input_msg.seq > *seq_lock {
                                    *seq_lock = input_msg.seq;
                                }
                            }
                            // Handle shooting input: update the persistent ball.
                            if let Some(shoot) = input_msg.shoot {
                                if shoot {
                                    if let (Some(target_x), Some(target_y)) = (input_msg.target_x, input_msg.target_y) {
                                        let mut ball = ball.lock().await;
                                        let ship = local_ship.lock().await;
                                        let dx = target_x - ship.x;
                                        let dy = target_y - ship.y;
                                        let mag = (dx * dx + dy * dy).sqrt();
                                        let ball_speed = 300.0;
                                        if mag > 0.0 {
                                            ball.vx = dx / mag * ball_speed;
                                            ball.vy = dy / mag * ball_speed;
                                        }
                                        // Start the ball at the ship's position.
                                        ball.x = ship.x;
                                        ball.y = ship.y;
                                        ball.active = true;
                                    }
                                }
                            }
                            println!("Processed input seq {}: {:?}", input_msg.seq, input_msg);
                        },
                        Err(e) => eprintln!("Failed to parse input: {:?}", e),
                    }
                } else if msg.is_close() {
                    println!("Client disconnected.");
                    break;
                }
            },
            Err(e) => {
                eprintln!("WebSocket error: {:?}", e);
                break;
            }
        }
    }
}
