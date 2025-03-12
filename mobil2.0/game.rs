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
        // Update cooldowns (remove ball grab cooldown update)
        // Update goal cooldown
        if self.goal_cooldown > 0.0 {
            self.goal_cooldown -= fixed_dt;
            if self.goal_cooldown < 0.0 { self.goal_cooldown = 0.0; }
        }
        
        // Update player cooldowns
        for player in self.players.values_mut() {
            if player.shoot_cooldown > 0.0 {
                player.shoot_cooldown -= fixed_dt;
                if player.shoot_cooldown < 0.0 { player.shoot_cooldown = 0.0; }
            }
            
            if player.grab_cooldown > 0.0 {
                player.grab_cooldown -= fixed_dt;
                if player.grab_cooldown < 0.0 { player.grab_cooldown = 0.0; }
            }
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
                        // Use the player's velocity direction for auto-shooting
                        let mut dx = player.velocity.0;
                        let mut dy = player.velocity.1;
                        let mut mag = (dx * dx + dy * dy).sqrt();
                        
                        // If player is not moving, use the target coordinates as fallback
                        if mag < 1.0 {
                            if let (Some(target_x), Some(target_y)) = (player.input.target_x, player.input.target_y) {
                                dx = target_x - player.ship.x;
                                dy = target_y - player.ship.y;
                                mag = (dx * dx + dy * dy).sqrt();
                            }
                            
                            // If still no direction, default to shooting upward
                            if mag < 1.0 {
                                dx = 0.0;
                                dy = -1.0;
                                mag = 1.0;
                            }
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
                        let base_shot_force = 800.0;
                        let dt = fixed_dt;

                        let aim_norm = (dx / mag, dy / mag);
                        let impulse_base = (aim_norm.0 * base_shot_force * dt, aim_norm.1 * base_shot_force * dt);
                        let additional_impulse = (player.velocity.0 * dt, player.velocity.1 * dt);
                        let total_impulse = (impulse_base.0 + additional_impulse.0, impulse_base.1 + additional_impulse.1);

                        let (ship_x, ship_y) = (player.ship.x, player.ship.y);

                        self.ball.vx = total_impulse.0 / ball_mass;
                        self.ball.vy = total_impulse.1 / ball_mass;
                        
                        // Calculate normalized direction vector for ball positioning
                        let dir_mag = (self.ball.vx * self.ball.vx + self.ball.vy * self.ball.vy).sqrt();
                        let dir_x = if dir_mag > 0.0 { self.ball.vx / dir_mag } else { 0.0 };
                        let dir_y = if dir_mag > 0.0 { self.ball.vy / dir_mag } else { 0.0 };
                        
                        // Position the ball just outside the ship's radius to prevent immediate recapture
                        let ship_radius = 20.0;
                        let ball_radius = 10.0;
                        let offset = ship_radius + ball_radius + 15.0; // Increased buffer for safety
                        
                        self.ball.x = ship_x + dir_x * offset;
                        self.ball.y = ship_y + dir_y * offset;

                        // Set the last shooter and apply cooldown to prevent immediate grabbing
                        self.ball.last_shooter = Some(owner_id);
                        // Apply grab cooldown only to the shooter
                        if let Some(player_mut) = self.players.get_mut(&owner_id) {
                            player_mut.grab_cooldown = 0.3; // Increased to prevent tunneling through ships
                            let recoil_factor = 1.0;
                            player_mut.velocity.0 -= (total_impulse.0 / ship_mass) * recoil_factor;
                            player_mut.velocity.1 -= (total_impulse.1 / ship_mass) * recoil_factor;
                            player_mut.shoot_cooldown = 0.25;
                            // Reset the shoot flag to prevent continuous shooting
                            player_mut.input.shoot = false;
                            println!("Reset shoot flag for player {}", owner_id);
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
            
            // Calculate movement direction from input
            let mut dx: f32 = 0.0;
            let mut dy: f32 = 0.0;
            if player.input.left { dx -= 1.0; }
            if player.input.right { dx += 1.0; }
            if player.input.up { dy -= 1.0; }
            if player.input.down { dy += 1.0; }
            
            // Normalize direction if needed
            let mag = (dx * dx + dy * dy).sqrt();
            if mag > 0.0 {
                dx /= mag;
                dy /= mag;
            }
            
            // Apply acceleration in the input direction
            let ax = dx * acceleration;
            let ay = dy * acceleration;
            
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

        // Process shooting using impulse - now based on movement direction
        if self.ball.grabbed {
            if let Some(owner_id) = self.ball.owner {
                if let Some(player) = self.players.get(&owner_id) {
                    // Log player's shoot state and cooldown
                    println!("Player {} shoot state: {}, cooldown: {}", owner_id, player.input.shoot, player.shoot_cooldown);
                    
                    if player.input.shoot && player.shoot_cooldown <= 0.0 {
                        println!("Player {} is shooting the ball!", owner_id);
                        
                        // Use the player's velocity direction for shooting
                        let mut dx = player.velocity.0;
                        let mut dy = player.velocity.1;
                        let mut mag = (dx * dx + dy * dy).sqrt();
                        
                        println!("Shooting direction: ({}, {}), magnitude: {}", dx, dy, mag);
                        
                        // If player is not moving, use the target coordinates as fallback
                        if mag < 1.0 {
                            if let (Some(target_x), Some(target_y)) = (player.input.target_x, player.input.target_y) {
                                dx = target_x - player.ship.x;
                                dy = target_y - player.ship.y;
                                mag = (dx * dx + dy * dy).sqrt();
                                println!("Using target coordinates for direction: ({}, {}), magnitude: {}", dx, dy, mag);
                            }
                            
                            // If still no direction, default to shooting upward
                            if mag < 1.0 {
                                dx = 0.0;
                                dy = -1.0;
                                mag = 1.0;
                                println!("Using default upward direction");
                            }
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
                        let base_shot_force = 800.0;
                        let dt = fixed_dt;

                        let aim_norm = (dx / mag, dy / mag);
                        let impulse_base = (aim_norm.0 * base_shot_force * dt, aim_norm.1 * base_shot_force * dt);
                        let additional_impulse = (player.velocity.0 * dt, player.velocity.1 * dt);
                        let total_impulse = (impulse_base.0 + additional_impulse.0, impulse_base.1 + additional_impulse.1);

                        let (ship_x, ship_y) = (player.ship.x, player.ship.y);

                        self.ball.vx = total_impulse.0 / ball_mass;
                        self.ball.vy = total_impulse.1 / ball_mass;
                        
                        // Calculate normalized direction vector for ball positioning
                        let dir_mag = (self.ball.vx * self.ball.vx + self.ball.vy * self.ball.vy).sqrt();
                        let dir_x = if dir_mag > 0.0 { self.ball.vx / dir_mag } else { 0.0 };
                        let dir_y = if dir_mag > 0.0 { self.ball.vy / dir_mag } else { 0.0 };
                        
                        // Position the ball just outside the ship's radius to prevent immediate recapture
                        let ship_radius = 20.0;
                        let ball_radius = 10.0;
                        let offset = ship_radius + ball_radius + 15.0; // Increased buffer for safety
                        
                        self.ball.x = ship_x + dir_x * offset;
                        self.ball.y = ship_y + dir_y * offset;

                        // Set the last shooter and apply cooldown to prevent immediate grabbing
                        self.ball.last_shooter = Some(owner_id);
                        // Apply grab cooldown only to the shooter
                        if let Some(player_mut) = self.players.get_mut(&owner_id) {
                            player_mut.grab_cooldown = 0.3; // Increased to prevent tunneling through ships
                            let recoil_factor = 1.0;
                            player_mut.velocity.0 -= (total_impulse.0 / ship_mass) * recoil_factor;
                            player_mut.velocity.1 -= (total_impulse.1 / ship_mass) * recoil_factor;
                            player_mut.shoot_cooldown = 0.25;
                            // Reset the shoot flag to prevent continuous shooting
                            player_mut.input.shoot = false;
                            println!("Reset shoot flag for player {}", owner_id);
                        }

                        self.ball.release(owner_id);
                        
                        // Send a message to all clients about the shot
                        let shoot_event = json!({
                            "type": "shoot",
                            "player_id": owner_id
                        });
                        
                        let shoot_str = shoot_event.to_string();
                        for (_id, sender) in self.clients.iter_mut() {
                            let msg = shoot_str.clone();
                            let sender = Arc::clone(sender);
                            tokio::spawn(async move {
                                let _ = sender.lock().await.send(Message::text(msg)).await;
                            });
                        }
                    }
                }
            }
        }

        // Player-Player Collision Resolution
        let collision_radius = 20.0;
        let player_ids: Vec<u32> = self.players.keys().cloned().collect();
        let mut adjustments: HashMap<u32, (f32, f32)> = HashMap::new();
        let mut velocity_changes: HashMap<u32, (f32, f32)> = HashMap::new();
        
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
                    // Calculate collision normal
                    let overlap = collision_radius * 2.0 - dist;
                    let (nx, ny) = if dist > 0.0 { (dx / dist, dy / dist) } else { (1.0, 0.0) };
                    
                    // Increase the collision force by using a multiplier
                    let collision_force = 1.5; // Increase this value for more bumpiness
                    let adjustment = (nx * overlap / 2.0 * collision_force, ny * overlap / 2.0 * collision_force);
                    
                    // Apply position adjustments
                    adjustments.entry(id_i).and_modify(|e| { e.0 += adjustment.0; e.1 += adjustment.1; }).or_insert(adjustment);
                    adjustments.entry(id_j).and_modify(|e| { e.0 -= adjustment.0; e.1 -= adjustment.1; }).or_insert((-adjustment.0, -adjustment.1));
                    
                    // Get player velocities
                    let (vxi, vyi) = self.players[&id_i].velocity;
                    let (vxj, vyj) = self.players[&id_j].velocity;
                    
                    // Calculate relative velocity
                    let rvx = vxi - vxj;
                    let rvy = vyi - vyj;
                    
                    // Calculate velocity along the normal
                    let velocity_along_normal = rvx * nx + rvy * ny;
                    
                    // Only resolve if objects are moving toward each other
                    if velocity_along_normal < 0.0 {
                        // Calculate restitution (bounciness)
                        let restitution = 0.6; // Higher values make collisions more bouncy
                        
                        // Calculate impulse scalar
                        let impulse_scalar = -(1.0 + restitution) * velocity_along_normal;
                        
                        // Apply impulse to velocities
                        let impulse_x = impulse_scalar * nx;
                        let impulse_y = impulse_scalar * ny;
                        
                        // Store velocity changes
                        velocity_changes.entry(id_i).and_modify(|e| { e.0 += impulse_x; e.1 += impulse_y; }).or_insert((impulse_x, impulse_y));
                        velocity_changes.entry(id_j).and_modify(|e| { e.0 -= impulse_x; e.1 -= impulse_y; }).or_insert((-impulse_x, -impulse_y));
                    }

                    if self.ball.grabbed {
                        if let Some(owner_id) = self.ball.owner {
                            if owner_id == id_i || owner_id == id_j {
                                if let Some((x, y)) = self.players.get(&owner_id).map(|p| (p.ship.x, p.ship.y)) {
                                    self.ball.x = x;
                                    self.ball.y = y;
                                }
                                self.ball.grabbed = false;
                                self.ball.owner = None;
                                
                                // Apply grab cooldown to both colliding players
                                if let Some(player) = self.players.get_mut(&id_i) {
                                    player.grab_cooldown = 0.3;
                                }
                                if let Some(player) = self.players.get_mut(&id_j) {
                                    player.grab_cooldown = 0.3;
                                }
                                
                                self.ball.last_shooter = None;
                            }
                        }
                    }
                }
            }
        }
        
        // Apply position adjustments
        for (id, (dx, dy)) in adjustments {
            if let Some(player) = self.players.get_mut(&id) {
                player.ship.x += dx;
                player.ship.y += dy;
            }
        }
        
        // Apply velocity changes
        for (id, (dvx, dvy)) in velocity_changes {
            if let Some(player) = self.players.get_mut(&id) {
                player.velocity.0 += dvx;
                player.velocity.1 += dvy;
            }
        }

        // Sub-Stepped Ball Physics
        let sub_steps = 5;
        let sub_dt = fixed_dt / sub_steps as f32;
        for _ in 0..sub_steps {
            self.ball.update_position(sub_dt, game_width, game_height);
            
            // Check for ball grabbing during each sub-step
            if !self.ball.grabbed {
                let ship_radius = 20.0;
                let ball_radius = 10.0;
                let grab_radius = ship_radius + ball_radius + 5.0; // Reduced grab radius to prevent grabbing through obstacles
                let grab_radius_squared = grab_radius * grab_radius;
                
                let mut closest_id: Option<u32> = None;
                let mut closest_dist2: f32 = f32::MAX;
                let mut new_x = 0.0;
                let mut new_y = 0.0;
                
                for player in self.players.values() {
                    // Skip players who are on cooldown
                    if player.grab_cooldown > 0.0 {
                        continue;
                    }
                    
                    let dx = player.ship.x - self.ball.x;
                    let dy = player.ship.y - self.ball.y;
                    let dist2 = dx * dx + dy * dy;
                    
                    // Check for line of sight to prevent grabbing through walls
                    let mut can_grab = true;
                    for wall in crate::game::MAP_OBJECTS.iter().filter(|w| w.obj_type == "wall") {
                        if crate::collision::line_intersects_rect(
                            self.ball.x, self.ball.y, 
                            player.ship.x, player.ship.y,
                            wall.x, wall.y, wall.width, wall.height
                        ) {
                            can_grab = false;
                            break;
                        }
                    }
                    
                    if can_grab && dist2 < grab_radius_squared && dist2 < closest_dist2 {
                        closest_dist2 = dist2;
                        closest_id = Some(player.id);
                        new_x = player.ship.x;
                        new_y = player.ship.y;
                    }
                }
                
                if let Some(player_id) = closest_id {
                    println!("Ball grabbed during physics sub-step!");
                    self.ball.grab(player_id, new_x, new_y);
                    break; // Exit the sub-step loop early since the ball is now grabbed
                }
            }
            
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