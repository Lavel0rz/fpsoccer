// This module will contain ball-related structures and logic.

use serde::Serialize;

#[derive(Debug, Serialize, Clone)]
pub struct Ball {
    pub x: f32,
    pub y: f32,
    pub vx: f32,
    pub vy: f32,
    pub active: bool,
    pub grabbed: bool,
    pub grab_cooldown: f32,
    pub owner: Option<u32>,
    pub last_shooter: Option<u32>,
    pub shot_clock: f32,
    pub pickup_cooldown: f32, // Time before ball can be picked up after goal
    pub exclusive_team: Option<String>, // Team that can exclusively pick up the ball (after goal)
}

impl Ball {
    pub fn update_position(&mut self, sub_dt: f32, game_width: f32, game_height: f32) {
        if self.active && !self.grabbed {
            // Calculate current speed for potential velocity capping
            let current_speed = (self.vx * self.vx + self.vy * self.vy).sqrt();
            
            // Cap maximum velocity to prevent tunneling
            let max_safe_speed = 500.0;
            if current_speed > max_safe_speed {
                let scale_factor = max_safe_speed / current_speed;
                self.vx *= scale_factor;
                self.vy *= scale_factor;
                println!("Capped ball velocity in update_position: speed was {:.2}, now {:.2}", current_speed, max_safe_speed);
            }
            
            // Store previous position for debugging
            let prev_x = self.x;
            let prev_y = self.y;
            
            // Update position
            self.x += self.vx * sub_dt;
            self.y += self.vy * sub_dt;
            
            // Apply friction
            let friction = 0.998;
            self.vx *= friction;
            self.vy *= friction;

            // Handle boundary collisions
            if self.x - BALL_WIDTH / 2.0 <= 0.0 || self.x + BALL_WIDTH / 2.0 >= game_width {
                self.vx = -self.vx;
                self.x = self.x.clamp(BALL_WIDTH / 2.0, game_width - BALL_WIDTH / 2.0);
            }
            if self.y - BALL_HEIGHT / 2.0 <= 0.0 || self.y + BALL_HEIGHT / 2.0 >= game_height {
                self.vy = -self.vy;
                self.y = self.y.clamp(BALL_HEIGHT / 2.0, game_height - BALL_HEIGHT / 2.0);
            }
            
            // Log significant movements for debugging
            let distance_moved = ((self.x - prev_x).powi(2) + (self.y - prev_y).powi(2)).sqrt();
            if distance_moved > 20.0 {
                println!("Ball moved significantly: from ({:.1}, {:.1}) to ({:.1}, {:.1}), distance: {:.1}", 
                         prev_x, prev_y, self.x, self.y, distance_moved);
            }
        }
    }

    pub fn grab(&mut self, player_id: u32, player_x: f32, player_y: f32) {
        self.grabbed = true;
        self.owner = Some(player_id);
        self.vx = 0.0;
        self.vy = 0.0;
        self.x = player_x;
        self.y = player_y;
        self.shot_clock = 10.0;
    }

    pub fn release(&mut self, shooter_id: u32) {
        self.grabbed = false;
        self.last_shooter = Some(shooter_id);
        self.owner = None;
        self.shot_clock = 10.0;
    }
}

// Constants for ball dimensions
pub const BALL_WIDTH: f32 = 20.0;
pub const BALL_HEIGHT: f32 = 20.0;

// Ball physics and collision logic will be implemented here.

// Placeholder for ball logic