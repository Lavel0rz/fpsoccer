import pygame
import json

# Pygame setup
pygame.init()
WIDTH, HEIGHT = 2000, 1200
GRID_SIZE = 10  # Size of each grid cell
screen = pygame.display.set_mode((WIDTH, HEIGHT))
pygame.display.set_caption("Map Editor")

# Colors
BACKGROUND_COLOR = (30, 30, 30)
GRID_COLOR = (50, 50, 50)
WALL_COLOR = (200, 0, 0)
GOAL_COLOR = (0, 200, 0)

# List to store placed objects
# Each object is a dict: {'type': 'wall'/'goal', 'rect': pygame.Rect}
objects = []

# Currently selected tool (either 'wall' or 'goal')
current_tool = 'wall'

def draw_grid():
    for x in range(0, WIDTH, GRID_SIZE):
        pygame.draw.line(screen, GRID_COLOR, (x, 0), (x, HEIGHT))
    for y in range(0, HEIGHT, GRID_SIZE):
        pygame.draw.line(screen, GRID_COLOR, (0, y), (WIDTH, y))

def draw_objects():
    for obj in objects:
        color = WALL_COLOR if obj['type'] == 'wall' else GOAL_COLOR
        pygame.draw.rect(screen, color, obj['rect'])

def export_map(filename="map_data.json"):
    # Convert pygame.Rect to a dict
    export_data = []
    for obj in objects:
        rect = obj['rect']
        export_data.append({
            'type': obj['type'],
            'x': rect.x,
            'y': rect.y,
            'width': rect.width,
            'height': rect.height
        })
    with open(filename, "w") as f:
        json.dump(export_data, f, indent=4)
    print("Map exported to", filename)

running = True
clock = pygame.time.Clock()

while running:
    clock.tick(60)
    screen.fill(BACKGROUND_COLOR)
    draw_grid()
    draw_objects()

    for event in pygame.event.get():
        if event.type == pygame.QUIT:
            running = False

        # Switch tool with keys: W for wall, G for goal
        if event.type == pygame.KEYDOWN:
            if event.key == pygame.K_w:
                current_tool = 'wall'
            elif event.key == pygame.K_g:
                current_tool = 'goal'
            elif event.key == pygame.K_s:
                # Export map data when pressing 'S'
                export_map()

        # On mouse click, add object at the nearest grid cell
        if event.type == pygame.MOUSEBUTTONDOWN:
            x, y = event.pos
            # Snap to grid
            grid_x = (x // GRID_SIZE) * GRID_SIZE
            grid_y = (y // GRID_SIZE) * GRID_SIZE
            rect = pygame.Rect(grid_x, grid_y, GRID_SIZE, GRID_SIZE)
            objects.append({'type': current_tool, 'rect': rect})

    pygame.display.flip()

pygame.quit()
