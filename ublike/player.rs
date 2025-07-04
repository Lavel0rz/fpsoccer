// This module will contain player-related structures and logic.

use serde::Serialize;
use crate::game::InputState;
use crate::game::MAP_OBJECTS;
use rand;

// Define team enum
#[derive(Debug, Serialize, Clone, Copy, PartialEq)]
pub enum Team {
    #[serde(rename = "Red")]
    Red,
    #[serde(rename = "Blue")]
    Blue,
    #[serde(rename = "Yellow")]
    Yellow,
    #[serde(rename = "Green")]
    Green,
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
    pub fuel: f32,
    pub team: Team,
    pub display_name: String,
    pub rocket_cooldown: f32,
}

#[derive(Debug)]
pub struct Player {
    pub id: u32,
    pub ship: Ship,
    pub input: InputState,
    pub last_seq: u32,
    pub velocity: (f32, f32),
    pub shoot_cooldown: f32,
    pub grab_cooldown: f32,
    pub fuel: f32,
    pub team: Team,
    pub display_name: String,
    pub is_host: bool,
    pub rocket_cooldown: f32,
    pub pending_shot_id: Option<u32>,
}

impl Player {
    pub fn new(id: u32, team: Team, display_name: String) -> Self {
        // Calculate the middle point between goals
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

        // Set spawn position based on team
        let spawn_pos = match team {
            Team::Red => {
                // Position red team players near the ball, slightly to the left
                (middle_x - 150.0, middle_y + (rand::random::<f32>() - 0.5) * 100.0)
            },
            Team::Blue => {
                // Position blue team players near the ball, slightly to the right
                (middle_x + 150.0, middle_y + (rand::random::<f32>() - 0.5) * 100.0)
            },
            Team::Yellow => {
                // Position yellow team players near the ball, slightly to the right
                (middle_x + 150.0, middle_y + (rand::random::<f32>() - 0.5) * 100.0)
            },
            Team::Green => {
                // Position green team players near the ball, slightly to the left
                (middle_x - 150.0, middle_y + (rand::random::<f32>() - 0.5) * 100.0)
            },
        };

        Self {
            id,
            ship: Ship { x: spawn_pos.0, y: spawn_pos.1 },
            input: InputState::default(),
            last_seq: 0,
            velocity: (0.0, 0.0),
            shoot_cooldown: 0.0,
            grab_cooldown: 0.0,
            fuel: 200.0,
            team,
            display_name,
            is_host: false,
            rocket_cooldown: 0.0,
            pending_shot_id: None,
        }
    }
    
    pub fn set_display_name(&mut self, name: String) {
        if !name.is_empty() {
            self.display_name = name;
        }
    }

    pub fn use_boost(&mut self, amount: f32) -> bool {
        if self.fuel >= amount {
            self.fuel -= amount;
            true
        } else {
            false
        }
    }

    pub fn regenerate_fuel(&mut self, amount: f32) {
        self.fuel = (self.fuel + amount).min(200.0);
    }
}

// Placeholder for player logic 