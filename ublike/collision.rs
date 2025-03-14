// This module will contain collision detection and resolution functions.

use crate::ball::Ball;
use crate::player::Ship;
use crate::game::MapObject;

pub const SHIP_WIDTH: f32 = 40.0;
pub const SHIP_HEIGHT: f32 = 40.0;
pub const BALL_WIDTH: f32 = 20.0;
pub const BALL_HEIGHT: f32 = 20.0;
pub const WALL_COLLISION_INSET: f32 = 5.0;

pub fn aabb_collision(x1: f32, y1: f32, w1: f32, h1: f32, x2: f32, y2: f32, w2: f32, h2: f32) -> bool {
    x1 < x2 + w2 && x1 + w1 > x2 &&
    y1 < y2 + h2 && y1 + h1 > y2
}

pub fn resolve_rect_collision(ball: &mut Ball, wall: &MapObject) {
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
        // Calculate ball speed for velocity dampening
        let ball_speed = (ball.vx * ball.vx + ball.vy * ball.vy).sqrt();
        
        // Apply a velocity dampening factor based on speed
        // Higher speeds get more dampening to prevent excessive bouncing
        let dampening_factor = if ball_speed > 300.0 {
            0.8 // More dampening for very fast balls
        } else if ball_speed > 150.0 {
            0.9 // Medium dampening for moderately fast balls
        } else {
            0.95 // Minimal dampening for slow balls
        };
        
        // Add a small buffer to prevent the ball from getting stuck in walls
        let buffer = 1.0;
        
        if overlap_x < overlap_y {
            // Horizontal collision
            if ball.x < wall.x {
                ball.x = wall_left - BALL_WIDTH / 2.0 - buffer;
            } else {
                ball.x = wall_right + BALL_WIDTH / 2.0 + buffer;
            }
            // Reverse and dampen horizontal velocity
            ball.vx = -ball.vx * dampening_factor;
        } else {
            // Vertical collision
            if ball.y < wall.y {
                ball.y = wall_top - BALL_HEIGHT / 2.0 - buffer;
            } else {
                ball.y = wall_bottom + BALL_HEIGHT / 2.0 + buffer;
            }
            // Reverse and dampen vertical velocity
            ball.vy = -ball.vy * dampening_factor;
        }
        
        // Log collision for debugging
        println!("Ball collided with wall at ({}, {}), new velocity: ({}, {})", 
                 ball.x, ball.y, ball.vx, ball.vy);
    }
}

pub fn resolve_ship_collision(ship: &mut Ship, velocity: &mut (f32, f32), wall: &MapObject) {
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

// Placeholder for collision logic 

// Function to check if a line intersects with a rectangle
pub fn line_intersects_rect(
    line_x1: f32, line_y1: f32, 
    line_x2: f32, line_y2: f32,
    rect_x: f32, rect_y: f32, 
    rect_width: f32, rect_height: f32
) -> bool {
    // Check if the line intersects with any of the rectangle's edges
    let rect_x2 = rect_x + rect_width;
    let rect_y2 = rect_y + rect_height;
    
    // Check if the line intersects with the left edge
    if line_intersects_segment(
        line_x1, line_y1, line_x2, line_y2,
        rect_x, rect_y, rect_x, rect_y2
    ) {
        return true;
    }
    
    // Check if the line intersects with the right edge
    if line_intersects_segment(
        line_x1, line_y1, line_x2, line_y2,
        rect_x2, rect_y, rect_x2, rect_y2
    ) {
        return true;
    }
    
    // Check if the line intersects with the top edge
    if line_intersects_segment(
        line_x1, line_y1, line_x2, line_y2,
        rect_x, rect_y, rect_x2, rect_y
    ) {
        return true;
    }
    
    // Check if the line intersects with the bottom edge
    if line_intersects_segment(
        line_x1, line_y1, line_x2, line_y2,
        rect_x, rect_y2, rect_x2, rect_y2
    ) {
        return true;
    }
    
    // Check if one of the line endpoints is inside the rectangle
    if point_in_rect(line_x1, line_y1, rect_x, rect_y, rect_width, rect_height) ||
       point_in_rect(line_x2, line_y2, rect_x, rect_y, rect_width, rect_height) {
        return true;
    }
    
    false
}

// Helper function to check if a point is inside a rectangle
fn point_in_rect(
    point_x: f32, point_y: f32,
    rect_x: f32, rect_y: f32,
    rect_width: f32, rect_height: f32
) -> bool {
    point_x >= rect_x && point_x <= rect_x + rect_width &&
    point_y >= rect_y && point_y <= rect_y + rect_height
}

// Helper function to check if two line segments intersect
fn line_intersects_segment(
    line1_x1: f32, line1_y1: f32, 
    line1_x2: f32, line1_y2: f32,
    line2_x1: f32, line2_y1: f32, 
    line2_x2: f32, line2_y2: f32
) -> bool {
    // Calculate the direction of the lines
    let uA = ((line2_x2 - line2_x1) * (line1_y1 - line2_y1) - 
              (line2_y2 - line2_y1) * (line1_x1 - line2_x1)) /
             ((line2_y2 - line2_y1) * (line1_x2 - line1_x1) - 
              (line2_x2 - line2_x1) * (line1_y2 - line1_y1));
              
    let uB = ((line1_x2 - line1_x1) * (line1_y1 - line2_y1) - 
              (line1_y2 - line1_y1) * (line1_x1 - line2_x1)) /
             ((line2_y2 - line2_y1) * (line1_x2 - line1_x1) - 
              (line2_x2 - line2_x1) * (line1_y2 - line1_y1));
    
    // If uA and uB are between 0-1, lines are colliding
    (uA >= 0.0 && uA <= 1.0) && (uB >= 0.0 && uB <= 1.0)
} 