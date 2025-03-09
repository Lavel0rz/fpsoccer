// This module will contain player-related structures and logic.

use serde::Serialize;
use crate::game::InputState;

// Define team enum
#[derive(Debug, Serialize, Clone, Copy, PartialEq)]
pub enum Team {
    Red,
    Blue,
}

#[derive(Debug, Serialize, Clone)]
pub struct Ship {
    pub x: f32,
    pub y: f32,
}

#[derive(Debug, Serialize)]
pub struct ShipState {
    pub x: f32,
    pub y: f32,
    pub seq: u32,
    pub boost: f32,
    pub team: Team,
    pub display_name: String,
}

#[derive(Debug)]
pub struct Player {
    pub id: u32,
    pub ship: Ship,
    pub input: InputState,
    pub last_seq: u32,
    pub velocity: (f32, f32),
    pub shoot_cooldown: f32,
    pub boost: f32,
    pub team: Team,
    pub display_name: String,
}

impl Player {
    pub fn new(id: u32, team: Team) -> Self {
        Self {
            id,
            ship: Ship { x: 400.0, y: 300.0 },
            input: InputState::default(),
            last_seq: 0,
            velocity: (0.0, 0.0),
            shoot_cooldown: 0.0,
            boost: 0.0,
            team,
            display_name: format!("Player {}", id),
        }
    }
    
    pub fn set_display_name(&mut self, name: String) {
        if !name.is_empty() {
            self.display_name = name;
        }
    }
}

// Placeholder for player logic 