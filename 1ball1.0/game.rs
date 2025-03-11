// This module will contain game logic, including the Game struct and related functions.

use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;
use once_cell::sync::Lazy;
use serde::{Serialize, Deserialize};
use crate::ball::{Ball, BALL_WIDTH, BALL_HEIGHT};
use crate::player::{Player, ShipState, Team};
use crate::collision::{resolve_ship_collision};
use chrono::Utc;
use serde_json::json;
use warp::ws::{Message, WebSocket};
use futures::stream::SplitSink;
use futures::SinkExt;
use rand;

#[derive(Debug)]
pub struct InputState {
    pub left: bool,
    pub right: bool,
    pub up: bool,
    pub down: bool,
    pub shoot: bool,
    pub boost: bool,
    pub target_x: Option<f32>,
    pub target_y: Option<f32>,
}

impl Default for InputState {
    fn default() -> Self {
        Self {
            left: false,
            right: false,
            up: false,
            down: false,
            shoot: false,
            boost: false,
            target_x: None,
            target_y: None,
        }
    }
}

#[derive(Debug, Serialize)]
pub struct GameStateSnapshot {
    time: u64, // server timestamp in ms
    players: HashMap<u32, ShipState>,
    ball: Ball,
    team1_score: u32, // Red team score
    team2_score: u32, // Blue team score
}

pub struct Game {
    pub ball: Ball,
    pub players: HashMap<u32, Player>,
    pub clients: HashMap<u32, Arc<Mutex<SplitSink<WebSocket, Message>>>>,
    pub next_id: u32,
    pub team1_score: u32, // Red team score
    pub team2_score: u32, // Blue team score
    pub goal_cooldown: f32, // Add cooldown after a goal is scored
    pub red_team_count: u32, // Count of players in red team
    pub blue_team_count: u32, // Count of players in blue team
}

impl Game {
    pub fn new() -> Self {
        // Calculate the middle of the game area
        let game_width = 1600.0;
        let game_height = 900.0;
        let middle_x = game_width / 2.0;
        let middle_y = game_height / 2.0;
        
        Self {
            ball: Ball {
                x: middle_x,
                y: middle_y,
                vx: 0.0,
                vy: 0.0,
                active: true,
                grabbed: false,
                grab_cooldown: 0.0,
                owner: None,
                last_shooter: None,
                shot_clock: 10.0, // Initialize shot clock
            },
            players: HashMap::new(),
            clients: HashMap::new(),
            next_id: 1,
            team1_score: 0,
            team2_score: 0,
            goal_cooldown: 0.0,
            red_team_count: 0,
            blue_team_count: 0,
        }
    }
    
    // Add a method to determine which team a new player should join
    pub fn assign_team(&mut self) -> Team {
        if self.red_team_count <= self.blue_team_count {
            self.red_team_count += 1;
            Team::Red
        } else {
            self.blue_team_count += 1;
            Team::Blue
        }
    }
    
    // Update player removal to account for team counts
    pub fn remove_player(&mut self, player_id: u32) {
        if let Some(player) = self.players.get(&player_id) {
            match player.team {
                Team::Red => self.red_team_count = self.red_team_count.saturating_sub(1),
                Team::Blue => self.blue_team_count = self.blue_team_count.saturating_sub(1),
            }
        }
        self.players.remove(&player_id);
        self.clients.remove(&player_id);
    }

    pub fn update(&mut self, fixed_dt: f32, game_width: f32, game_height: f32) {
        // Update cooldowns
        if self.ball.grab_cooldown > 0.0 {
            self.ball.grab_cooldown -= fixed_dt;
            if self.ball.grab_cooldown < 0.0 { self.ball.grab_cooldown = 0.0; }
        }
        
        // Update goal cooldown
        if self.goal_cooldown > 0.0 {
            self.goal_cooldown -= fixed_dt;
            if self.goal_cooldown < 0.0 { self.goal_cooldown = 0.0; }
        }
        
        // Update shot clock if ball is grabbed
        if self.ball.grabbed {
            self.ball.shot_clock -= fixed_dt;
            
            // Update the shot clock display in the player's boost field
            if let Some(owner_id) = self.ball.owner {
                if let Some(player) = self.players.get_mut(&owner_id) {
                    // Scale the shot clock to 0-200 range for the boost UI
                    player.boost = (self.ball.shot_clock / 10.0) * 200.0;
                }
            }
            
            if self.ball.shot_clock <= 0.0 {
                // Auto-shoot when shot clock expires
                if let Some(owner_id) = self.ball.owner {
                    if let Some(player) = self.players.get(&owner_id) {
                        let target_x = player.input.target_x.unwrap_or(player.ship.x + 100.0).clamp(0.0, game_width);
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

                        let ship_mass = 1.0;
                        let ball_mass = 0.5;
                        let base_shot_force = 1400.0;
                        let dt = fixed_dt;

                        let aim_norm = (dx / mag, dy / mag);
                        let impulse_base = (aim_norm.0 * base_shot_force * dt, aim_norm.1 * base_shot_force * dt);
                        let additional_impulse = (player.velocity.0 * dt, player.velocity.1 * dt);
                        let total_impulse = (impulse_base.0 + additional_impulse.0, impulse_base.1 + additional_impulse.1);

                        let (ship_x, ship_y) = (player.ship.x, player.ship.y);

                        self.ball.vx = total_impulse.0 / ball_mass;
                        self.ball.vy = total_impulse.1 / ball_mass;
                        self.ball.x = ship_x;
                        self.ball.y = ship_y;

                        self.ball.grab_cooldown = 0.5;

                        if let Some(player_mut) = self.players.get_mut(&owner_id) {
                            let recoil_factor = 1.0;
                            player_mut.velocity.0 -= (total_impulse.0 / ship_mass) * recoil_factor;
                            player_mut.velocity.1 -= (total_impulse.1 / ship_mass) * recoil_factor;
                            player_mut.shoot_cooldown = 0.25;
                        }

                        self.ball.release(owner_id);
                        
                        // Send a message to all clients about the auto-shoot
                        let auto_shoot_event = json!({
                            "type": "auto_shoot",
                            "player_id": owner_id
                        });
                        
                        let auto_shoot_str = auto_shoot_event.to_string();
                        for (_id, sender) in self.clients.iter_mut() {
                            let msg = auto_shoot_str.clone();
                            let sender = Arc::clone(sender);
                            tokio::spawn(async move {
                                let _ = sender.lock().await.send(Message::text(msg)).await;
                            });
                        }
                    }
                }
            }
        }
        
        for player in self.players.values_mut() {
            if player.shoot_cooldown > 0.0 {
                player.shoot_cooldown -= fixed_dt;
                if player.shoot_cooldown < 0.0 { player.shoot_cooldown = 0.0; }
            }
        }

        // Update players' ships
        let ball_grabbed = self.ball.grabbed;
        let ball_owner = self.ball.owner;
        for player in self.players.values_mut() {
            let slowdown = if ball_grabbed && ball_owner == Some(player.id) { 0.8 } else { 1.0 };
            let acceleration = 200.0 * slowdown;
            let max_speed = 100.0 * slowdown;
            let mut ax: f32 = 0.0;
            let mut ay: f32 = 0.0;
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

        // Ship-Wall Collision Resolution
        for player in self.players.values_mut() {
            for wall in crate::game::MAP_OBJECTS.iter().filter(|w| w.obj_type == "wall") {
                resolve_ship_collision(&mut player.ship, &mut player.velocity, wall);
            }
        }

        // Process shooting using impulse
        if self.ball.grabbed {
            if let Some(owner_id) = self.ball.owner {
                if let Some(player) = self.players.get(&owner_id) {
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

                        let ship_mass = 1.0;
                        let ball_mass = 0.5;
                        let base_shot_force = 1400.0;
                        let dt = fixed_dt;

                        let aim_norm = (dx / mag, dy / mag);
                        let impulse_base = (aim_norm.0 * base_shot_force * dt, aim_norm.1 * base_shot_force * dt);
                        let additional_impulse = (player.velocity.0 * dt, player.velocity.1 * dt);
                        let total_impulse = (impulse_base.0 + additional_impulse.0, impulse_base.1 + additional_impulse.1);

                        let (ship_x, ship_y) = (player.ship.x, player.ship.y);

                        self.ball.vx = total_impulse.0 / ball_mass;
                        self.ball.vy = total_impulse.1 / ball_mass;
                        self.ball.x = ship_x;
                        self.ball.y = ship_y;

                        self.ball.grab_cooldown = 0.5;

                        if let Some(player_mut) = self.players.get_mut(&owner_id) {
                            let recoil_factor = 1.0;
                            player_mut.velocity.0 -= (total_impulse.0 / ship_mass) * recoil_factor;
                            player_mut.velocity.1 -= (total_impulse.1 / ship_mass) * recoil_factor;
                            player_mut.shoot_cooldown = 0.25;
                            player_mut.input.shoot = false;
                        }

                        self.ball.release(owner_id);
                    }
                }
            }
        }

        // Player-Player Collision Resolution
        let collision_radius = 20.0;
        let player_ids: Vec<u32> = self.players.keys().cloned().collect();
        let mut adjustments: HashMap<u32, (f32, f32)> = HashMap::new();
        for i in 0..player_ids.len() {
            for j in (i + 1)..player_ids.len() {
                let id_i = player_ids[i];
                let id_j = player_ids[j];
                let (xi, yi) = (self.players[&id_i].ship.x, self.players[&id_i].ship.y);
                let (xj, yj) = (self.players[&id_j].ship.x, self.players[&id_j].ship.y);
                let dx = xi - xj;
                let dy = yi - yj;
                let dist = (dx * dx + dy * dy).sqrt();
                if dist < collision_radius * 2.0 {
                    let overlap = collision_radius * 2.0 - dist;
                    let (nx, ny) = if dist > 0.0 { (dx / dist, dy / dist) } else { (1.0, 0.0) };
                    let adjustment = (nx * overlap / 2.0, ny * overlap / 2.0);
                    adjustments.entry(id_i).and_modify(|e| { e.0 += adjustment.0; e.1 += adjustment.1; }).or_insert(adjustment);
                    adjustments.entry(id_j).and_modify(|e| { e.0 -= adjustment.0; e.1 -= adjustment.1; }).or_insert((-adjustment.0, -adjustment.1));

                    if self.ball.grabbed {
                        if let Some(owner_id) = self.ball.owner {
                            if owner_id == id_i || owner_id == id_j {
                                if let Some((x, y)) = self.players.get(&owner_id).map(|p| (p.ship.x, p.ship.y)) {
                                    self.ball.x = x;
                                    self.ball.y = y;
                                }
                                self.ball.grabbed = false;
                                self.ball.owner = None;
                                self.ball.grab_cooldown = 0.5;
                                self.ball.last_shooter = None;
                            }
                        }
                    }
                }
            }
        }
        for (id, (dx, dy)) in adjustments {
            if let Some(player) = self.players.get_mut(&id) {
                player.ship.x += dx;
                player.ship.y += dy;
            }
        }

        // Sub-Stepped Ball Physics
        let sub_steps = 5;
        let sub_dt = fixed_dt / sub_steps as f32;
        for _ in 0..sub_steps {
            self.ball.update_position(sub_dt, game_width, game_height);
            // Ball-Wall Collision
            let mut iterations = 0;
            let max_iterations = 5;
            loop {
                let mut collision_occurred = false;
                for wall in crate::game::MAP_OBJECTS.iter().filter(|w| w.obj_type == "wall") {
                    let ball_left = self.ball.x - BALL_WIDTH / 2.0;
                    let ball_right = self.ball.x + BALL_WIDTH / 2.0;
                    let ball_top = self.ball.y - BALL_HEIGHT / 2.0;
                    let ball_bottom = self.ball.y + BALL_HEIGHT / 2.0;

                    if ball_right > wall.x && ball_left < wall.x + wall.width &&
                       ball_bottom > wall.y && ball_top < wall.y + wall.height {
                        crate::collision::resolve_rect_collision(&mut self.ball, wall);
                        collision_occurred = true;
                    }
                }
                iterations += 1;
                if !collision_occurred || iterations >= max_iterations {
                    break;
                }
            }
            
            // Check for goal collision if not in cooldown
            if self.goal_cooldown <= 0.0 && !self.ball.grabbed {
                self.check_goal_collision(game_width, game_height);
            }
        }

        // Process ball grabbing
        if !self.ball.grabbed && self.ball.grab_cooldown == 0.0 {
            let mut closest_id: Option<u32> = None;
            let mut closest_dist2: f32 = f32::MAX;
            let mut new_x = 0.0;
            let mut new_y = 0.0;
            let current_ball_x = self.ball.x;
            let current_ball_y = self.ball.y;

            for player in self.players.values() {
                // Skip the player who just shot the ball if they're in cooldown
                if self.ball.last_shooter == Some(player.id) && self.ball.grab_cooldown > 0.0 {
                    continue;
                }
                
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
            if let Some(player_id) = closest_id {
                self.ball.grab(player_id, new_x, new_y);
            }
        }

        // Build and broadcast game state
        let now = Utc::now().timestamp_millis() as u64;
        let mut players_snapshot = HashMap::new();
        for (id, player) in self.players.iter() {
            players_snapshot.insert(*id, ShipState {
                x: player.ship.x,
                y: player.ship.y,
                seq: player.last_seq,
                boost: player.boost,
                team: player.team,
                display_name: player.display_name.clone(),
            });
        }
        let snapshot = json!(GameStateSnapshot {
            time: now,
            players: players_snapshot,
            ball: self.ball.clone(),
            team1_score: self.team1_score,
            team2_score: self.team2_score,
        });
        let snapshot_str = snapshot.to_string();
        for (_id, sender) in self.clients.iter_mut() {
            let msg = snapshot_str.clone();
            let sender = Arc::clone(sender);
            tokio::spawn(async move {
                tokio::time::sleep(tokio::time::Duration::from_millis(0)).await;
                let _ = sender.lock().await.send(Message::text(msg)).await;
            });
        }
    }
    
    // Add a new method to check for goal collisions
    fn check_goal_collision(&mut self, _game_width: f32, _game_height: f32) {
        let ball_left = self.ball.x - BALL_WIDTH / 2.0;
        let ball_right = self.ball.x + BALL_WIDTH / 2.0;
        let ball_top = self.ball.y - BALL_HEIGHT / 2.0;
        let ball_bottom = self.ball.y + BALL_HEIGHT / 2.0;
        
        // Determine the middle Y position to distinguish north from south goals
        let mut min_y = f32::INFINITY;
        let mut max_y = f32::NEG_INFINITY;
        let mut min_x = f32::INFINITY;
        let mut max_x = f32::NEG_INFINITY;
        
        // Find the min and max coordinates of all goals
        for goal in crate::game::MAP_OBJECTS.iter().filter(|obj| obj.obj_type == "goal") {
            min_y = min_y.min(goal.y);
            max_y = max_y.max(goal.y + goal.height);
            min_x = min_x.min(goal.x);
            max_x = max_x.max(goal.x + goal.width);
        }
        
        // Calculate the middle position
        let middle_y = (min_y + max_y) / 2.0;
        let middle_x = (min_x + max_x) / 2.0;
        
        println!("Ball position: ({}, {})", self.ball.x, self.ball.y);
        println!("Goal Y range: {} to {}, middle: {}", min_y, max_y, middle_y);
        
        // Check if ball is in a goal area
        for goal in crate::game::MAP_OBJECTS.iter().filter(|obj| obj.obj_type == "goal") {
            // Debug log goal position
            println!("Checking goal at ({}, {}), size: {}x{}", goal.x, goal.y, goal.width, goal.height);
            
            if ball_right > goal.x && ball_left < goal.x + goal.width &&
               ball_bottom > goal.y && ball_top < goal.y + goal.height {
                
                println!("Ball entered goal at ({}, {})", goal.x, goal.y);
                
                // Determine which team scored based on goal position
                // North goals (y < middle_y) are Red team's goals, South goals are Blue team's goals
                if goal.y < middle_y {
                    // Ball in north (Red) goal - Blue team scores
                    self.team2_score += 1;
                    println!("Blue team scored! Score: Red {} - Blue {}", self.team1_score, self.team2_score);
                } else {
                    // Ball in south (Blue) goal - Red team scores
                    self.team1_score += 1;
                    println!("Red team scored! Score: Red {} - Blue {}", self.team1_score, self.team2_score);
                }
                
                // Reset ball position to exact middle between goals
                self.ball.x = middle_x;
                self.ball.y = middle_y;
                self.ball.vx = 0.0;
                self.ball.vy = 0.0;
                self.ball.grabbed = false;
                self.ball.owner = None;
                self.ball.last_shooter = None;
                
                // Set cooldown to prevent immediate scoring after reset
                self.goal_cooldown = 2.0;
                
                // Send a goal event to all clients
                let goal_event = json!({
                    "type": "goal",
                    "team1_score": self.team1_score,
                    "team2_score": self.team2_score,
                    "scorer_team": if goal.y < middle_y { "blue" } else { "red" }
                });
                
                let goal_str = goal_event.to_string();
                for (_id, sender) in self.clients.iter_mut() {
                    let msg = goal_str.clone();
                    let sender = Arc::clone(sender);
                    tokio::spawn(async move {
                        let _ = sender.lock().await.send(Message::text(msg)).await;
                    });
                }
                
                // Only count one goal at a time
                break;
            }
        }
    }

    fn create_snapshot(&self) -> GameStateSnapshot {
        let mut players = HashMap::new();
        for (id, player) in &self.players {
            players.insert(*id, ShipState {
                x: player.ship.x,
                y: player.ship.y,
                seq: player.last_seq,
                boost: player.boost,
                team: player.team,
                display_name: player.display_name.clone(),
            });
        }
        
        GameStateSnapshot {
            time: chrono::Utc::now().timestamp_millis() as u64,
            players,
            ball: self.ball.clone(),
            team1_score: self.team1_score,
            team2_score: self.team2_score,
        }
    }
    
    // Add a method to reset the game
    pub fn reset_game(&mut self) {
        // Reset scores
        self.team1_score = 0;
        self.team2_score = 0;
        
        // Calculate the middle of the game area
        let game_width = 2000.0;
        let game_height = 1200.0;
        
        // Find the min and max coordinates of all goals to determine the middle point
        // This reuses the same logic as in check_goal_collision
        let mut min_y = f32::INFINITY;
        let mut max_y = f32::NEG_INFINITY;
        let mut min_x = f32::INFINITY;
        let mut max_x = f32::NEG_INFINITY;
        
        // Find the min and max coordinates of all goals
        for goal in crate::game::MAP_OBJECTS.iter().filter(|obj| obj.obj_type == "goal") {
            min_y = min_y.min(goal.y);
            max_y = max_y.max(goal.y + goal.height);
            min_x = min_x.min(goal.x);
            max_x = max_x.max(goal.x + goal.width);
        }
        
        // Calculate the middle position between goals
        let middle_x = (min_x + max_x) / 2.0;
        let middle_y = (min_y + max_y) / 2.0;
        
        // Reset ball position to the middle between goals
        self.ball.x = middle_x;
        self.ball.y = middle_y;
        self.ball.vx = 0.0;
        self.ball.vy = 0.0;
        self.ball.grabbed = false;
        self.ball.owner = None;
        self.ball.last_shooter = None;
        self.ball.shot_clock = 10.0;
        
        // Reset player positions based on team - closer to the ball
        for (_, player) in self.players.iter_mut() {
            match player.team {
                crate::player::Team::Red => {
                    // Position red team players near the ball, slightly to the left
                    player.ship.x = middle_x - 150.0;
                    player.ship.y = middle_y + (rand::random::<f32>() - 0.5) * 100.0;
                },
                crate::player::Team::Blue => {
                    // Position blue team players near the ball, slightly to the right
                    player.ship.x = middle_x + 150.0;
                    player.ship.y = middle_y + (rand::random::<f32>() - 0.5) * 100.0;
                }
            }
            // Reset player velocity
            player.velocity = (0.0, 0.0);
        }
        
        // Set goal cooldown to prevent immediate scoring
        self.goal_cooldown = 5.0;
        
        // Notify all clients about the reset
        let reset_event = serde_json::json!({
            "type": "game_reset",
            "team1_score": self.team1_score,
            "team2_score": self.team2_score
        });
        
        let reset_str = reset_event.to_string();
        for (_id, sender) in self.clients.iter_mut() {
            let msg = reset_str.clone();
            let sender = Arc::clone(sender);
            tokio::spawn(async move {
                let _ = sender.lock().await.send(Message::text(msg)).await;
            });
        }
        
        // Start countdown
        self.start_countdown();
    }
    
    // Add a method to start the countdown
    pub fn start_countdown(&self) {
        let clients = self.clients.clone();
        
        // Spawn a task to handle the countdown
        tokio::spawn(async move {
            for count in (1..=5).rev() {
                // Send countdown message to all clients
                let countdown_event = serde_json::json!({
                    "type": "countdown",
                    "count": count
                });
                
                let countdown_str = countdown_event.to_string();
                for (_id, sender) in clients.iter() {
                    let msg = countdown_str.clone();
                    let sender = Arc::clone(sender);
                    tokio::spawn(async move {
                        let _ = sender.lock().await.send(Message::text(msg)).await;
                    });
                }
                
                // Wait 1 second
                tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;
            }
            
            // Send final countdown message (0) to indicate game start
            let start_event = serde_json::json!({
                "type": "countdown",
                "count": 0
            });
            
            let start_str = start_event.to_string();
            for (_id, sender) in clients.iter() {
                let msg = start_str.clone();
                let sender = Arc::clone(sender);
                tokio::spawn(async move {
                    let _ = sender.lock().await.send(Message::text(msg)).await;
                });
            }
        });
    }
}

pub static GLOBAL_GAME: Lazy<Arc<Mutex<Game>>> = Lazy::new(|| Arc::new(Mutex::new(Game::new())));

pub async fn game_update_loop() {
    let fixed_dt = 0.1;
    let sub_steps = 5;
    let _sub_dt = fixed_dt / sub_steps as f32;
    let game_width = 2000.0;
    let game_height = 1200.0;
    loop {
        {
            let mut game = GLOBAL_GAME.lock().await;
            game.update(fixed_dt, game_width, game_height);
        }
        tokio::time::sleep(tokio::time::Duration::from_millis((fixed_dt * 700.0) as u64)).await;
    }
}

// Load the map_data.json file at compile time.
pub static MAP_OBJECTS: Lazy<Vec<MapObject>> = Lazy::new(|| {
    let json_str = include_str!("../map_data.json");
    serde_json::from_str(json_str).expect("Failed to parse map_data.json")
});

#[derive(Deserialize, Debug)]
pub struct MapObject {
    #[serde(rename = "type")]
    pub obj_type: String, // e.g., "wall" or "goal"
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
} 