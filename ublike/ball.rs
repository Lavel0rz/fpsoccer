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
}

impl Ball {
    pub fn update_position(&mut self, sub_dt: f32, game_width: f32, game_height: f32) {
        if self.active && !self.grabbed {
            self.x += self.vx * sub_dt;
            self.y += self.vy * sub_dt;
            let friction = 0.992;
            self.vx *= friction;
            self.vy *= friction;

            if self.x - BALL_WIDTH / 2.0 <= 0.0 || self.x + BALL_WIDTH / 2.0 >= game_width {
                self.vx = -self.vx;
                self.x = self.x.clamp(BALL_WIDTH / 2.0, game_width - BALL_WIDTH / 2.0);
            }
            if self.y - BALL_HEIGHT / 2.0 <= 0.0 || self.y + BALL_HEIGHT / 2.0 >= game_height {
                self.vy = -self.vy;
                self.y = self.y.clamp(BALL_HEIGHT / 2.0, game_height - BALL_HEIGHT / 2.0);
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