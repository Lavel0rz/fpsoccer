// This module will contain player-related structures and logic.

use serde::Serialize;
use crate::game::InputState;

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
}

impl Player {
    pub fn new(id: u32) -> Self {
        Self {
            id,
            ship: Ship { x: 400.0, y: 300.0 },
            input: InputState::default(),
            last_seq: 0,
            velocity: (0.0, 0.0),
            shoot_cooldown: 0.0,
            boost: 200.0,
        }
    }
}

// Placeholder for player logic 