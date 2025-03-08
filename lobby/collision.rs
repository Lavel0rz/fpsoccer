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
        if overlap_x < overlap_y {
            if ball.x < wall.x {
                ball.x -= overlap_x;
            } else {
                ball.x += overlap_x;
            }
            ball.vx = -ball.vx;
        } else {
            if ball.y < wall.y {
                ball.y -= overlap_y;
            } else {
                ball.y += overlap_y;
            }
            ball.vy = -ball.vy;
        }
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