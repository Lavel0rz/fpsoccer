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
use crate::dual_connection::{MessageType};

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

#[derive(Debug, Clone, Serialize)]
pub struct Projectile {
    pub id: u32,
    pub x: f32,
    pub y: f32,
    pub vx: f32,
    pub vy: f32,
    pub owner_id: u32,
    pub lifetime: f32,  // Time in seconds before explosion
    pub active: bool,
}

impl Projectile {
    pub fn new(id: u32, x: f32, y: f32, vx: f32, vy: f32, owner_id: u32) -> Self {
        Self {
            id,
            x,
            y,
            vx,
            vy,
            owner_id,
            lifetime: 2.0,  // 2 seconds before auto-explosion
            active: true,
        }
    }
    
    pub fn update_position(&mut self, dt: f32) {
        self.x += self.vx * dt;
        self.y += self.vy * dt;
        self.lifetime -= dt;
        
        // Deactivate if lifetime is up
        if self.lifetime <= 0.0 {
            self.active = false;
        }
    }
}

#[derive(Debug, Serialize)]
pub struct GameStateSnapshot {
    time: u64, // server timestamp in ms
    players: HashMap<u32, ShipState>,
    ball: Ball,
    projectiles: Vec<Projectile>, // Add projectiles to the game state
    team1_score: u32, // Red team score
    team2_score: u32, // Blue team score
    team3_score: u32, // Yellow team score
    team4_score: u32, // Green team score
}

pub struct Game {
    pub ball: Ball,
    pub players: HashMap<u32, Player>,
    pub clients: HashMap<u32, Arc<Mutex<SplitSink<WebSocket, Message>>>>,
    pub next_id: u32,
    pub team1_score: u32, // Red team score
    pub team2_score: u32, // Blue team score
    pub team3_score: u32, // Yellow team score  
    pub team4_score: u32, // Green team score
    pub goal_cooldown: f32, // Add cooldown after a goal is scored
    pub red_team_count: u32, // Count of players in red team
    pub blue_team_count: u32, // Count of players in blue team
    pub yellow_team_count: u32, // Count of players in yellow team
    pub green_team_count: u32, // Count of players in green team
    pub projectiles: Vec<Projectile>, // Add projectiles list
    pub next_projectile_id: u32, // Track projectile IDs
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
                pickup_cooldown: 0.0, // Initialize pickup cooldown
                exclusive_team: None, // No team restriction initially
            },
            players: HashMap::new(),
            clients: HashMap::new(),
            next_id: 1,
            team1_score: 0,
            team2_score: 0,
            team3_score: 0,
            team4_score: 0,
            goal_cooldown: 0.0,
            red_team_count: 0,
            blue_team_count: 0,
            yellow_team_count: 0,
            green_team_count: 0,
            projectiles: Vec::new(),
            next_projectile_id: 1,
        }
    }
    
    // Add a method to determine which team a new player should join
    pub fn assign_team(&mut self) -> Team {
        // For corner defense mode: limit to 1 player per team
        let max_players_per_team = 1;
        
        let team_counts = [
            (Team::Red, self.red_team_count),
            (Team::Blue, self.blue_team_count),
            (Team::Yellow, self.yellow_team_count),
            (Team::Green, self.green_team_count),
        ];
        
        // Find team with lowest count that hasn't reached the limit
        let available_teams: Vec<_> = team_counts.iter()
            .filter(|(_, count)| *count < max_players_per_team)
            .collect();
        
        if available_teams.is_empty() {
            // All teams are full, assign to Red as fallback (should not happen in corner defense)
            println!("Warning: All teams are full, assigning to Red team");
            return Team::Red;
        }
        
        // Find team with lowest count among available teams
        let (team, _) = available_teams.iter()
            .min_by_key(|(_, count)| *count)
            .map(|(team, _)| (*team, 0u32))
            .unwrap_or((Team::Red, 0u32));
        
        // Increment the appropriate counter
        match team {
            Team::Red => self.red_team_count += 1,
            Team::Blue => self.blue_team_count += 1,
            Team::Yellow => self.yellow_team_count += 1,
            Team::Green => self.green_team_count += 1,
        }
        
        team
    }
    
    // Add method to check if a team can accept new players
    pub fn can_join_team(&self, team: Team) -> bool {
        let max_players_per_team = 1; // For corner defense mode
        
        let current_count = match team {
            Team::Red => self.red_team_count,
            Team::Blue => self.blue_team_count,
            Team::Yellow => self.yellow_team_count,
            Team::Green => self.green_team_count,
        };
        
        let can_join = current_count < max_players_per_team;
        
        println!("can_join_team check: {:?} team has {} players (max: {}), can join: {}", 
                 team, current_count, max_players_per_team, can_join);
        
        // Also count actual players in this team for verification
        let actual_count = self.players.values()
            .filter(|player| player.team == team)
            .count();
        
        println!("Verification: {:?} team actually has {} players in game", team, actual_count);
        
        if current_count as usize != actual_count {
            println!("WARNING: Team count mismatch! Stored count: {}, Actual count: {}", 
                     current_count, actual_count);
        }
        
        can_join
    }
    
    // Add method to recalculate team counts from actual players (to fix any sync issues)
    pub fn recalculate_team_counts(&mut self) {
        // Reset all counts
        self.red_team_count = 0;
        self.blue_team_count = 0;
        self.yellow_team_count = 0;
        self.green_team_count = 0;
        
        // Count players by team
        for (_, player) in &self.players {
            match player.team {
                Team::Red => self.red_team_count += 1,
                Team::Blue => self.blue_team_count += 1,
                Team::Yellow => self.yellow_team_count += 1,
                Team::Green => self.green_team_count += 1,
            }
        }
        
        println!("Recalculated team counts - Red: {}, Blue: {}, Yellow: {}, Green: {}", 
                 self.red_team_count, self.blue_team_count, self.yellow_team_count, self.green_team_count);
    }
    
    // Update player removal to account for team counts
    pub fn remove_player(&mut self, player_id: u32) {
        if let Some(player) = self.players.get(&player_id) {
            match player.team {
                Team::Red => self.red_team_count = self.red_team_count.saturating_sub(1),
                Team::Blue => self.blue_team_count = self.blue_team_count.saturating_sub(1),
                Team::Yellow => self.yellow_team_count = self.yellow_team_count.saturating_sub(1),
                Team::Green => self.green_team_count = self.green_team_count.saturating_sub(1),
            }
        }
        self.players.remove(&player_id);
        self.clients.remove(&player_id);
    }

    // Helper function to broadcast event messages to all players
    fn broadcast_event(&self, dual_mgr: Option<&'static crate::dual_connection::DualConnectionManager>, message_type: MessageType, data: serde_json::Value) {
        if let Some(mgr) = dual_mgr {
            for &client_id in self.players.keys() {
                let msg_type = message_type.clone();
                let msg_data = data.clone();
                tokio::spawn(async move {
                    let _ = mgr.send_to_client(client_id, msg_type, msg_data).await;
                });
            }
        }
    }

    pub fn update(&mut self, fixed_dt: f32, game_width: f32, game_height: f32, dual_mgr: Option<&'static crate::dual_connection::DualConnectionManager>) {
        // Update cooldowns (remove ball grab cooldown update)
        // Update goal cooldown
        if self.goal_cooldown > 0.0 {
            self.goal_cooldown -= fixed_dt;
            if self.goal_cooldown < 0.0 { self.goal_cooldown = 0.0; }
        }
        
        // Update ball pickup cooldown
        if self.ball.pickup_cooldown > 0.0 {
            self.ball.pickup_cooldown -= fixed_dt;
            if self.ball.pickup_cooldown < 0.0 { 
                self.ball.pickup_cooldown = 0.0;
                if let Some(ref team) = self.ball.exclusive_team {
                    println!("Ball glow ended - now only {} team can grab it", team);
                }
                // Keep team restriction active even after cooldown expires
                // It will only be cleared when the ball is grabbed by the exclusive team
            }
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
            
            // Add rocket cooldown update
            if player.rocket_cooldown > 0.0 {
                player.rocket_cooldown -= fixed_dt;
                if player.rocket_cooldown < 0.0 { player.rocket_cooldown = 0.0; }
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
                        
                        // Cap the ball's maximum velocity to prevent tunneling
                        let max_ball_speed = 500.0;
                        let current_speed = (self.ball.vx * self.ball.vx + self.ball.vy * self.ball.vy).sqrt();
                        if current_speed > max_ball_speed {
                            let scale_factor = max_ball_speed / current_speed;
                            self.ball.vx *= scale_factor;
                            self.ball.vy *= scale_factor;
                            println!("Capped ball velocity after shot: speed was {:.2}, now {:.2}", current_speed, max_ball_speed);
                        }
                        
                        // Calculate normalized direction vector for ball positioning
                        let dir_mag = (self.ball.vx * self.ball.vx + self.ball.vy * self.ball.vy).sqrt();
                        let dir_x = if dir_mag > 0.0 { self.ball.vx / dir_mag } else { 0.0 };
                        let dir_y = if dir_mag > 0.0 { self.ball.vy / dir_mag } else { 0.0 };
                        
                        // Use the helper function to position the ball safely
                        self.position_ball_after_shot(ship_x, ship_y, dir_x, dir_y);

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
                        
                        self.broadcast_event(dual_mgr, MessageType::AutoShoot, auto_shoot_event);
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
        let mut events_to_broadcast = Vec::new();
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
            
            // Handle projectile firing with boost button (using rocket_cooldown)
            if player.input.boost && player.rocket_cooldown <= 0.0 {
                println!("Player {} is attempting to fire a rocket. Cooldown: {}", player.id, player.rocket_cooldown);
                
                // Get aim direction from target coordinates (like ball shooting)
                let mut dx = 0.0;
                let mut dy = -1.0; // Default upward direction
                let mut mag = 1.0;
                
                // Use target coordinates for direction
                if let (Some(target_x), Some(target_y)) = (player.input.target_x, player.input.target_y) {
                    dx = target_x - player.ship.x;
                    dy = target_y - player.ship.y;
                    mag = (dx * dx + dy * dy).sqrt();
                    println!("Using target coordinates for rocket direction: ({}, {}), magnitude: {}", dx, dy, mag);
                } else {
                    println!("No target coordinates, using default upward direction for rocket");
                }
                
                if mag > 0.0 {
                    // Normalize direction
                    let dir_x = dx / mag;
                    let dir_y = dy / mag;
                    
                    // Calculate projectile velocity (constant speed)
                    let projectile_speed = 125.0;
                    let vx = dir_x * projectile_speed;
                    let vy = dir_y * projectile_speed;
                    
                    // Add a portion of player's velocity to projectile
                    let total_vx = vx + player.velocity.0 * 0.5;
                    let total_vy = vy + player.velocity.1 * 0.5;
                    
                    // Position the projectile just outside the ship's radius
                    let ship_radius = 20.0;
                    let projectile_radius = 5.0;
                    let offset = ship_radius + projectile_radius + 5.0;
                    
                    let projectile_x = player.ship.x + dir_x * offset;
                    let projectile_y = player.ship.y + dir_y * offset;
                    
                    // Create and add the projectile
                    let projectile = Projectile::new(
                        self.next_projectile_id,
                        projectile_x,
                        projectile_y,
                        total_vx,
                        total_vy,
                        player.id
                    );
                    
                    self.projectiles.push(projectile);
                    self.next_projectile_id += 1;
                    
                    // Apply rocket cooldown
                    player.rocket_cooldown = 8.0; // Increased from 0.5 to 8.0 seconds
                    
                    // Reset the boost flag to prevent continuous firing
                    player.input.boost = false;
                    println!("Reset boost flag for player {}", player.id);
                    
                    // Apply recoil to the player
                    let recoil_factor = 0.3;
                    player.velocity.0 -= dir_x * projectile_speed * recoil_factor;
                    player.velocity.1 -= dir_y * projectile_speed * recoil_factor;
                    
                    // Collect event to broadcast after mutable borrow ends
                    let projectile_event = json!({
                        "type": "projectile_fired",
                        "player_id": player.id
                    });
                    
                    events_to_broadcast.push((MessageType::ProjectileFired, projectile_event));
                }
            }
        }
        
        // Broadcast collected events after mutable borrow ends
        for (msg_type, event_data) in events_to_broadcast {
            self.broadcast_event(dual_mgr, msg_type, event_data);
        }

        // Ship-Wall Collision Resolution
        for player in self.players.values_mut() {
            for wall in crate::game::MAP_OBJECTS.iter().filter(|w| w.obj_type == "wall") {
                resolve_ship_collision(&mut player.ship, &mut player.velocity, wall);
            }
        }

        // Process shooting using impulse - now based on target coordinates (like old rocket shooting)
        if self.ball.grabbed {
            if let Some(owner_id) = self.ball.owner {
                if let Some(player) = self.players.get(&owner_id) {
                    // Log player's shoot state and cooldown
                    println!("Player {} shoot state: {}, cooldown: {}", owner_id, player.input.shoot, player.shoot_cooldown);
                    
                    if player.input.shoot && player.shoot_cooldown <= 0.0 {
                        println!("Player {} is shooting the ball!", owner_id);
                        
                        // Get aim direction from target coordinates (like the old rocket shooting)
                        let mut dx = 0.0;
                        let mut dy = -1.0; // Default upward direction
                        let mut mag = 1.0;
                        
                        // Use target coordinates for direction
                        if let (Some(target_x), Some(target_y)) = (player.input.target_x, player.input.target_y) {
                            dx = target_x - player.ship.x;
                            dy = target_y - player.ship.y;
                            mag = (dx * dx + dy * dy).sqrt();
                            println!("Using target coordinates for ball direction: ({}, {}), magnitude: {}", dx, dy, mag);
                        } else {
                            // If no target coordinates, default to shooting upward
                            println!("Using default upward direction for ball");
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
                        
                        // Cap the ball's maximum velocity to prevent tunneling
                        let max_ball_speed = 500.0;
                        let current_speed = (self.ball.vx * self.ball.vx + self.ball.vy * self.ball.vy).sqrt();
                        if current_speed > max_ball_speed {
                            let scale_factor = max_ball_speed / current_speed;
                            self.ball.vx *= scale_factor;
                            self.ball.vy *= scale_factor;
                            println!("Capped ball velocity after shot: speed was {:.2}, now {:.2}", current_speed, max_ball_speed);
                        }
                        
                        // Calculate normalized direction vector for ball positioning
                        let dir_mag = (self.ball.vx * self.ball.vx + self.ball.vy * self.ball.vy).sqrt();
                        let dir_x = if dir_mag > 0.0 { self.ball.vx / dir_mag } else { 0.0 };
                        let dir_y = if dir_mag > 0.0 { self.ball.vy / dir_mag } else { 0.0 };
                        
                        // Use the helper function to position the ball safely
                        self.position_ball_after_shot(ship_x, ship_y, dir_x, dir_y);

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
                        
                        self.broadcast_event(dual_mgr, MessageType::BallShot, shoot_event);
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
                                
                                // Apply longer grab cooldown to the player who had the ball
                                // and a shorter cooldown to the other player to make it easier to steal
                                if let Some(player) = self.players.get_mut(&id_i) {
                                    if owner_id == id_i {
                                        // Longer cooldown for the player who had the ball
                                        player.grab_cooldown = 0.8; // Increased from 0.3
                                    } else {
                                        // Shorter cooldown for the player who didn't have the ball
                                        player.grab_cooldown = 0.1; // Decreased from 0.3
                                    }
                                }
                                if let Some(player) = self.players.get_mut(&id_j) {
                                    if owner_id == id_j {
                                        // Longer cooldown for the player who had the ball
                                        player.grab_cooldown = 0.8; // Increased from 0.3
                                    } else {
                                        // Shorter cooldown for the player who didn't have the ball
                                        player.grab_cooldown = 0.1; // Decreased from 0.3
                                    }
                                }
                                
                                self.ball.last_shooter = None;
                                
                                // Send a message to all clients about the ball being knocked loose
                                let knock_event = json!({
                                    "type": "ball_knocked",
                                    "player_id": owner_id
                                });
                                
                                self.broadcast_event(dual_mgr, MessageType::BallKnocked, knock_event);
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
        let sub_steps = 10;
        
        // Increase sub-steps if ball is moving very fast to prevent tunneling
        let ball_speed = (self.ball.vx * self.ball.vx + self.ball.vy * self.ball.vy).sqrt();
        let max_safe_speed = 300.0; // Threshold for increasing sub-steps
        
        // Adaptively increase sub-steps based on ball speed
        let adaptive_sub_steps = if ball_speed > max_safe_speed {
            // Calculate how many more sub-steps we need based on speed
            let speed_ratio = ball_speed / max_safe_speed;
            let additional_steps = (speed_ratio * 10.0).ceil() as i32;
            println!("Ball moving fast ({:.2}), increasing sub-steps to {}", ball_speed, sub_steps + additional_steps);
            sub_steps + additional_steps
        } else {
            sub_steps
        };
        
        let sub_dt = fixed_dt / adaptive_sub_steps as f32;
        for _ in 0..adaptive_sub_steps {
            self.ball.update_position(sub_dt, game_width, game_height);
            
            // Check for ball grabbing during each sub-step
            if !self.ball.grabbed {
                let ship_radius = 20.0;
                let ball_radius = 10.0;
                let grab_radius = ship_radius + ball_radius; // Removed the +5.0 buffer to make grab radius match ship size
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
                    
                    // Check if ball is in pickup cooldown
                    if self.ball.pickup_cooldown > 0.0 {
                        continue; // No one can pick up the ball during cooldown (reduced logging)
                    }
                    
                    // Check if ball has team restriction
                    if let Some(ref exclusive_team) = self.ball.exclusive_team {
                        let player_team_str = format!("{:?}", player.team);
                        if player_team_str != *exclusive_team {
                            // Only log when someone tries to grab but can't (reduced spam)
                            continue; // Only the exclusive team can pick up the ball
                        } else {
                            println!("Player {} ({} team) can grab ball (exclusive access)", 
                                player.id, player_team_str);
                        }
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
                    if let Some(player) = self.players.get(&player_id) {
                        println!("Ball grabbed by player {} ({:?} team)", player_id, player.team);
                    }
                    self.ball.grab(player_id, new_x, new_y);
                    
                    // Clear exclusive team restriction when ball is successfully grabbed (this will reset ball color on client)
                    self.ball.exclusive_team = None;
                    
                    break; // Exit the sub-step loop early since the ball is now grabbed
                }
            }
            
            // Ball-Wall Collision
            let mut iterations = 0;
            let max_iterations = 5;
            
            // Store the ball's previous position for ray-casting
            let prev_x = self.ball.x - self.ball.vx * sub_dt;
            let prev_y = self.ball.y - self.ball.vy * sub_dt;
            
            loop {
                let mut collision_occurred = false;
                for wall in crate::game::MAP_OBJECTS.iter().filter(|w| w.obj_type == "wall") {
                    let ball_left = self.ball.x - BALL_WIDTH / 2.0;
                    let ball_right = self.ball.x + BALL_WIDTH / 2.0;
                    let ball_top = self.ball.y - BALL_HEIGHT / 2.0;
                    let ball_bottom = self.ball.y + BALL_HEIGHT / 2.0;

                    // Standard AABB collision check
                    let aabb_collision = ball_right > wall.x && ball_left < wall.x + wall.width &&
                                         ball_bottom > wall.y && ball_top < wall.y + wall.height;
                    
                    // For fast-moving balls, also check if the ball's path intersects with the wall
                    let ray_collision = if !aabb_collision && (self.ball.vx * self.ball.vx + self.ball.vy * self.ball.vy) > 90000.0 {
                        // Check if the line from prev position to current position intersects with the wall
                        crate::collision::line_intersects_rect(
                            prev_x, prev_y, 
                            self.ball.x, self.ball.y,
                            wall.x, wall.y, wall.width, wall.height
                        )
                    } else {
                        false
                    };
                    
                    if aabb_collision || ray_collision {
                        if ray_collision {
                            println!("Ray-casting detected collision with wall that AABB missed!");
                        }
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
                self.check_goal_collision(game_width, game_height, dual_mgr);
            }
        }

        // Update projectiles
        let mut projectiles_to_explode: Vec<usize> = Vec::new();
        
        // First update positions and check for lifetime expiration
        for (i, projectile) in self.projectiles.iter_mut().enumerate() {
            if projectile.active {
                projectile.update_position(fixed_dt);
                
                // Check if projectile is out of bounds
                if projectile.x < 0.0 || projectile.x > game_width || 
                   projectile.y < 0.0 || projectile.y > game_height {
                    projectile.active = false;
                }
                
                // Check if lifetime expired
                if projectile.lifetime <= 0.0 {
                    projectiles_to_explode.push(i);
                }
            }
        }
        
        // Check for projectile collisions with walls
        for (i, projectile) in self.projectiles.iter_mut().enumerate() {
            if !projectile.active || projectiles_to_explode.contains(&i) {
                continue;
            }
            
            for wall in crate::game::MAP_OBJECTS.iter().filter(|w| w.obj_type == "wall") {
                let projectile_radius = 5.0;
                let projectile_left = projectile.x - projectile_radius;
                let projectile_right = projectile.x + projectile_radius;
                let projectile_top = projectile.y - projectile_radius;
                let projectile_bottom = projectile.y + projectile_radius;
                
                if projectile_right > wall.x && projectile_left < wall.x + wall.width &&
                   projectile_bottom > wall.y && projectile_top < wall.y + wall.height {
                    projectiles_to_explode.push(i);
                    break;
                }
            }
        }
        
        // Check for projectile collisions with players
        for (i, projectile) in self.projectiles.iter().enumerate() {
            if !projectile.active || projectiles_to_explode.contains(&i) {
                continue;
            }
            
            for (player_id, player) in self.players.iter() {
                // Skip collision with the projectile owner
                if *player_id == projectile.owner_id {
                    continue;
                }
                
                let dx = player.ship.x - projectile.x;
                let dy = player.ship.y - projectile.y;
                let dist_squared = dx * dx + dy * dy;
                
                let collision_radius = 20.0 + 5.0; // Ship radius + projectile radius
                if dist_squared < collision_radius * collision_radius {
                    projectiles_to_explode.push(i);
                    break;
                }
            }
        }
        
        // Check for projectile collisions with the ball
        for (i, projectile) in self.projectiles.iter().enumerate() {
            if !projectile.active || projectiles_to_explode.contains(&i) {
                continue;
            }
            
            let dx = self.ball.x - projectile.x;
            let dy = self.ball.y - projectile.y;
            let dist_squared = dx * dx + dy * dy;
            
            let collision_radius = 10.0 + 5.0; // Ball radius + projectile radius
            if dist_squared < collision_radius * collision_radius {
                projectiles_to_explode.push(i);
            }
        }
        
        // Process explosions
        for &index in projectiles_to_explode.iter() {
            if index < self.projectiles.len() {
                let projectile = &self.projectiles[index];
                self.create_explosion(projectile.x, projectile.y, projectile.owner_id, dual_mgr);
                self.projectiles[index].active = false;
            }
        }
        
        // Remove inactive projectiles
        self.projectiles.retain(|p| p.active);

        // Note: Game state broadcasting is now handled by the game loop via DualConnectionManager
    }
    
    // Add a method to check for goal collisions
    fn check_goal_collision(&mut self, _game_width: f32, _game_height: f32, dual_mgr: Option<&'static crate::dual_connection::DualConnectionManager>) {
        let ball_left = self.ball.x - BALL_WIDTH / 2.0;
        let ball_right = self.ball.x + BALL_WIDTH / 2.0;
        let ball_top = self.ball.y - BALL_HEIGHT / 2.0;
        let ball_bottom = self.ball.y + BALL_HEIGHT / 2.0;
        
        // Debug: Log ball bounds (commented out to reduce spam)
        // println!("Ball bounds: left={:.1}, right={:.1}, top={:.1}, bottom={:.1}", ball_left, ball_right, ball_top, ball_bottom);
        
        // Determine the middle Y position to distinguish north from south goals
        let mut min_y = f32::INFINITY;
        let mut max_y = f32::NEG_INFINITY;
        let mut min_x = f32::INFINITY;
        let mut max_x = f32::NEG_INFINITY;
        
        // Find the min and max coordinates of all goals
        for goal in crate::game::MAP_OBJECTS.iter().filter(|obj| obj.obj_type.starts_with("goal_")) {
            min_y = min_y.min(goal.y);
            max_y = max_y.max(goal.y + goal.height);
            min_x = min_x.min(goal.x);
            max_x = max_x.max(goal.x + goal.width);
        }
        
        // Calculate the middle position
        let middle_y = (min_y + max_y) / 2.0;
        let middle_x = (min_x + max_x) / 2.0;
        
        // println!("Ball position: ({}, {})", self.ball.x, self.ball.y);
        // println!("Goal Y range: {} to {}, middle: {}", min_y, max_y, middle_y);
        
        // Check if ball is in a goal area
        if self.goal_cooldown <= 0.0 {
            for goal in crate::game::MAP_OBJECTS.iter().filter(|obj| obj.obj_type.starts_with("goal_")) {
                // Add debug print for each goal (commented out to reduce spam)
                // println!("Checking goal: type={}, x={}, y={}, w={}, h={}", goal.obj_type, goal.x, goal.y, goal.width, goal.height);
                // Add a small margin to the collision check
                let margin = 1.0;
                if ball_right >= goal.x - margin && ball_left <= goal.x + goal.width + margin &&
                   ball_bottom >= goal.y - margin && ball_top <= goal.y + goal.height + margin {
                    println!("GOAL SCORED! Ball hit {} goal", goal.obj_type);
                    
                    // Determine which team was scored on based on the goal type
                    let scored_on_team = match goal.obj_type.as_str() {
                        "goal_red" => Team::Red,      // Red goal hit = Red team scored on
                        "goal_blue" => Team::Blue,    // Blue goal hit = Blue team scored on  
                        "goal_yellow" => Team::Yellow, // Yellow goal hit = Yellow team scored on
                        "goal_green" => Team::Green,  // Green goal hit = Green team scored on
                        _ => continue, // Skip if not a valid goal type
                    };
                    
                    // Get the player who scored (last shooter)
                    let scorer_name = if let Some(shooter_id) = self.ball.last_shooter {
                        if let Some(player) = self.players.get(&shooter_id) {
                            player.display_name.clone()
                        } else {
                            "Unknown Player".to_string()
                        }
                    } else {
                        "Unknown Player".to_string()
                    };
                    
                    // Update scores based on which team was scored on (they lose a point in this context, but we track goals scored against them)
                    // In corner defense, when your goal is hit, the other teams get points
                    // For simplicity, we'll just increment a general score counter
                    match scored_on_team {
                        Team::Red => self.team1_score += 1,      // Point scored against red
                        Team::Blue => self.team2_score += 1,     // Point scored against blue
                        Team::Yellow => self.team3_score += 1,   // Point scored against yellow
                        Team::Green => self.team4_score += 1,    // Point scored against green
                    }
                    
                    // Reset ball position and state
                    self.ball.x = middle_x;
                    self.ball.y = middle_y;
                    self.ball.vx = 0.0;
                    self.ball.vy = 0.0;
                    self.ball.grabbed = false;
                    self.ball.owner = None;
                    self.ball.grab_cooldown = 0.5;
                    self.goal_cooldown = 2.0;
                    
                    // Set pickup cooldown and team restriction
                    self.ball.pickup_cooldown = 3.0; // 3 second cooldown
                    self.ball.exclusive_team = Some(format!("{:?}", scored_on_team)); // Team that was scored on gets exclusive pickup
                    
                    println!("Ball glowing for 3s, then exclusive to {:?} team", scored_on_team);
                    
                    // Send goal event to all clients
                    let goal_event = json!({
                        "type": "goal",
                        "scored_on_team": format!("{:?}", scored_on_team),
                        "scorer_name": scorer_name,
                        "team1_score": self.team1_score,
                        "team2_score": self.team2_score,
                        "team3_score": self.team3_score,
                        "team4_score": self.team4_score,
                        "ball_exclusive_team": format!("{:?}", scored_on_team)
                    });
                    
                    println!("Sending goal message to {} clients", self.players.len());
                    self.broadcast_event(dual_mgr, MessageType::Goal, goal_event);
                    
                    break;
                }
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
                rocket_cooldown: player.rocket_cooldown,
            });
        }
        
        GameStateSnapshot {
            time: chrono::Utc::now().timestamp_millis() as u64,
            players,
            ball: self.ball.clone(),
            projectiles: self.projectiles.clone(),
            team1_score: self.team1_score,
            team2_score: self.team2_score,
            team3_score: self.team3_score,
            team4_score: self.team4_score,
        }
    }
    
    // Add a method to reset the game
    pub fn reset_game(&mut self, dual_mgr: Option<&'static crate::dual_connection::DualConnectionManager>) {
        // Reset scores
        self.team1_score = 0;
        self.team2_score = 0;
        self.team3_score = 0;
        self.team4_score = 0;
        
        // Find the min and max coordinates of all goals to determine the middle point
        // This reuses the same logic as in check_goal_collision
        let mut min_y = f32::INFINITY;
        let mut max_y = f32::NEG_INFINITY;
        let mut min_x = f32::INFINITY;
        let mut max_x = f32::NEG_INFINITY;
        
        // Find the min and max coordinates of all goals
        for goal in crate::game::MAP_OBJECTS.iter().filter(|obj| obj.obj_type.starts_with("goal")) {
            min_y = min_y.min(goal.y);
            max_y = max_y.max(goal.y + goal.height);
            min_x = min_x.min(goal.x);
            max_x = max_x.max(goal.x + goal.width);
        }
        
        // Calculate the middle position between goals
        let middle_x = (min_x + max_x) / 2.0;
        let middle_y = (min_y + max_y) / 2.0;
        
        println!("RESET: Goal bounds - min_x: {}, max_x: {}, min_y: {}, max_y: {}", min_x, max_x, min_y, max_y);
        println!("RESET: Calculated middle position: ({}, {})", middle_x, middle_y);
        
        // Reset ball position to the middle between goals
        self.ball.x = middle_x;
        self.ball.y = middle_y;
        self.ball.vx = 0.0;
        self.ball.vy = 0.0;
        self.ball.grabbed = false;
        self.ball.owner = None;
        self.ball.last_shooter = None;
        self.ball.shot_clock = 10.0;
        self.ball.pickup_cooldown = 0.0;
        self.ball.exclusive_team = None;
        
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
                },
                crate::player::Team::Yellow => {
                    // Position yellow team players near the ball, slightly to the right
                    player.ship.x = middle_x + 150.0;
                    player.ship.y = middle_y + (rand::random::<f32>() - 0.5) * 100.0;
                },
                crate::player::Team::Green => {
                    // Position green team players near the ball, slightly to the left
                    player.ship.x = middle_x - 150.0;
                    player.ship.y = middle_y + (rand::random::<f32>() - 0.5) * 100.0;
                },
            }
            // Reset player velocity
            player.velocity = (0.0, 0.0);
            
            // BUGFIX: Reset sequence number to allow input after reset
            player.last_seq = 0;
        }
        
        // Set goal cooldown to prevent immediate scoring
        self.goal_cooldown = 5.0;
        
        // Notify all clients about the reset
        let reset_event = serde_json::json!({
            "type": "game_reset",
            "team1_score": self.team1_score,
            "team2_score": self.team2_score,
            "team3_score": self.team3_score,
            "team4_score": self.team4_score
        });
        
        self.broadcast_event(dual_mgr, MessageType::GameReset, reset_event);
        
        // Start countdown
        self.start_countdown(dual_mgr);
        
        // Clear all projectiles
        self.projectiles.clear();
    }
    
    // Add a method to start the countdown
    pub fn start_countdown(&self, dual_mgr: Option<&'static crate::dual_connection::DualConnectionManager>) {
        // Get player IDs to broadcast to
        let player_ids: Vec<u32> = self.players.keys().cloned().collect();
        
        // Spawn a task to handle the countdown
        if let Some(mgr) = dual_mgr {
            tokio::spawn(async move {
                for count in (1..=5).rev() {
                    // Send countdown message to all clients
                    let countdown_event = serde_json::json!({
                        "type": "countdown",
                        "count": count
                    });
                    
                    // Broadcast to all players
                    for &client_id in &player_ids {
                        let _ = mgr.send_to_client(client_id, MessageType::Countdown, countdown_event.clone()).await;
                    }
                    
                    // Wait 1 second
                    tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;
                }
                
                // Send final countdown message (0) to indicate game start
                let start_event = serde_json::json!({
                    "type": "countdown",
                    "count": 0
                });
                
                // Broadcast game start to all players
                for &client_id in &player_ids {
                    let _ = mgr.send_to_client(client_id, MessageType::Countdown, start_event.clone()).await;
                }
            });
        }
    }

    // Add a method to create an explosion effect
    fn create_explosion(&mut self, x: f32, y: f32, owner_id: u32, dual_mgr: Option<&'static crate::dual_connection::DualConnectionManager>) {
        // Define explosion parameters
        let explosion_radius = 100.0;
        let explosion_force = 300.0;
        
        // Apply knockback to players in range
        let mut events_to_broadcast = Vec::new();
        for (player_id, player) in self.players.iter_mut() {
            let dx = player.ship.x - x;
            let dy = player.ship.y - y;
            let dist = (dx * dx + dy * dy).sqrt();
            
            if dist < explosion_radius {
                // Calculate normalized direction away from explosion
                let dir_x = if dist > 0.0 { dx / dist } else { 1.0 };
                let dir_y = if dist > 0.0 { dy / dist } else { 0.0 };
                
                // Calculate force based on distance (stronger closer to center)
                let force_multiplier = 1.0 - (dist / explosion_radius);
                let force_x = dir_x * explosion_force * force_multiplier;
                let force_y = dir_y * explosion_force * force_multiplier;
                
                // Apply impulse to player
                player.velocity.0 += force_x;
                player.velocity.1 += force_y;
                
                // If this player has the ball, they lose it
                if self.ball.grabbed && self.ball.owner == Some(*player_id) {
                    self.ball.grabbed = false;
                    self.ball.owner = None;
                    self.ball.x = player.ship.x;
                    self.ball.y = player.ship.y;
                    
                    // Apply impulse to the ball in the same direction
                    self.ball.vx = force_x * 1.5;
                    self.ball.vy = force_y * 1.5;
                    
                    // Apply grab cooldown
                    player.grab_cooldown = 0.5;
                    
                    // Collect event to broadcast after mutable borrow ends  
                    let knock_event = json!({
                        "type": "ball_knocked",
                        "player_id": *player_id
                    });
                    
                    events_to_broadcast.push((MessageType::BallKnocked, knock_event));
                }
            }
        }
        
        // Broadcast collected events after mutable borrow ends
        for (msg_type, event_data) in events_to_broadcast {
            self.broadcast_event(dual_mgr, msg_type, event_data);
        }
        
        // Apply knockback to the ball if it's not grabbed
        if !self.ball.grabbed {
            let dx = self.ball.x - x;
            let dy = self.ball.y - y;
            let dist = (dx * dx + dy * dy).sqrt();
            
            if dist < explosion_radius {
                // Calculate normalized direction away from explosion
                let dir_x = if dist > 0.0 { dx / dist } else { 1.0 };
                let dir_y = if dist > 0.0 { dy / dist } else { 0.0 };
                
                // Calculate force based on distance (stronger closer to center)
                let force_multiplier = 1.0 - (dist / explosion_radius);
                let force_x = dir_x * explosion_force * force_multiplier * 2.0; // Stronger effect on ball
                let force_y = dir_y * explosion_force * force_multiplier * 2.0;
                
                // Apply impulse to ball
                self.ball.vx += force_x;
                self.ball.vy += force_y;
                
                // Cap the ball's maximum velocity to prevent tunneling
                let max_ball_speed = 500.0;
                let current_speed = (self.ball.vx * self.ball.vx + self.ball.vy * self.ball.vy).sqrt();
                if current_speed > max_ball_speed {
                    let scale_factor = max_ball_speed / current_speed;
                    self.ball.vx *= scale_factor;
                    self.ball.vy *= scale_factor;
                    println!("Capped ball velocity after explosion: speed was {:.2}, now {:.2}", current_speed, max_ball_speed);
                }
            }
        }
        
        // Send explosion event to all clients
        let explosion_event = json!({
            "type": "explosion",
            "x": x,
            "y": y,
            "radius": explosion_radius,
            "player_id": owner_id
        });
        
        self.broadcast_event(dual_mgr, MessageType::Explosion, explosion_event);
    }

    // Helper function to safely position the ball after shooting
    fn position_ball_after_shot(&mut self, ship_x: f32, ship_y: f32, dir_x: f32, dir_y: f32) {
        // Position the ball just outside the ship's radius to prevent immediate recapture
        // But use a smaller offset to reduce the chance of tunneling through walls
        let ship_radius = 20.0;
        let ball_radius = 10.0;
        let offset = ship_radius + ball_radius + 5.0; // Reduced from 15.0 to 5.0
        
        // Calculate new ball position
        let new_ball_x = ship_x + dir_x * offset;
        let new_ball_y = ship_y + dir_y * offset;
        
        // Check if the new position would put the ball inside a wall
        let mut inside_wall = false;
        for wall in crate::game::MAP_OBJECTS.iter().filter(|w| w.obj_type == "wall") {
            let ball_left = new_ball_x - BALL_WIDTH / 2.0;
            let ball_right = new_ball_x + BALL_WIDTH / 2.0;
            let ball_top = new_ball_y - BALL_HEIGHT / 2.0;
            let ball_bottom = new_ball_y + BALL_HEIGHT / 2.0;
            
            if ball_right > wall.x && ball_left < wall.x + wall.width &&
               ball_bottom > wall.y && ball_top < wall.y + wall.height {
                inside_wall = true;
                println!("WARNING: Ball would be positioned inside a wall after shooting. Adjusting position.");
                break;
            }
            
            // Also check if the path from ship to new ball position intersects with a wall
            if crate::collision::line_intersects_rect(
                ship_x, ship_y,
                new_ball_x, new_ball_y,
                wall.x, wall.y, wall.width, wall.height
            ) {
                inside_wall = true;
                println!("WARNING: Ball path would intersect a wall after shooting. Adjusting position.");
                break;
            }
        }
        
        if inside_wall {
            // If the new position would put the ball inside a wall, keep it at the ship's position
            // and let the physics system handle the collision in the next update
            self.ball.x = ship_x;
            self.ball.y = ship_y;
            println!("Ball positioned at ship center due to wall proximity");
        } else {
            // Otherwise, use the calculated position
            self.ball.x = new_ball_x;
            self.ball.y = new_ball_y;
        }
    }
}

pub static GLOBAL_GAME: Lazy<Arc<Mutex<Game>>> = Lazy::new(|| Arc::new(Mutex::new(Game::new())));

pub async fn game_update_loop(dual_mgr: &'static crate::dual_connection::DualConnectionManager) {
    let fixed_dt = 0.1;
    let sub_steps = 10;
    let _sub_dt = fixed_dt / sub_steps as f32;
    let game_width = 2000.0;
    let game_height = 1200.0;
    loop {
        {
            let mut game = GLOBAL_GAME.lock().await;
            game.update(fixed_dt, game_width, game_height, Some(dual_mgr));
            
            // Send state updates via DualConnectionManager
            let snapshot = game.create_snapshot();
            let snapshot_json = serde_json::to_value(&snapshot).unwrap_or(serde_json::Value::Null);
            
            // Get all connected client IDs and broadcast state
            for &client_id in game.players.keys() {
                let _ = dual_mgr.send_to_client(client_id, MessageType::GameState, snapshot_json.clone()).await;
            }
        }
        tokio::time::sleep(tokio::time::Duration::from_millis((fixed_dt * 700.0) as u64)).await;
    }
}

// Load the map_data.json file at compile time.
pub static MAP_OBJECTS: Lazy<Vec<MapObject>> = Lazy::new(|| {
    let json_str = include_str!("../cornerdefense.json");
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