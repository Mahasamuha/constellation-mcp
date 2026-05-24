#!/usr/bin/env python3
"""Generate tray icons for each agent state.

Color specs are sourced from hub_state_colors.html in this directory.
To update: edit the `states` array in that file, then re-run this script.

Usage:
    python3 assets/logo/generate_tray_icons.py

Output: packages/agent-gui/src-tauri/icons/tray/{state}.png (32x32 RGBA PNG)
"""

import re
import sys
from pathlib import Path
from PIL import Image, ImageDraw

SCRIPT_DIR = Path(__file__).parent
REPO_ROOT = SCRIPT_DIR.parent.parent
SPEC_FILE = SCRIPT_DIR / "hub_state_colors.html"
OUT_DIR = REPO_ROOT / "packages/agent-gui/src-tauri/icons/tray"

# Maps the color-label in hub_state_colors.html to the tray icon filename.
# Order must stay consistent with AgentState in config.rs.
LABEL_TO_STATE = {
    "blue":  ["connected"],
    "yellow": ["connecting"],
    "grey":   ["disconnected", "unconfigured"],
    "red":    ["error"],
}

RENDER_SCALE = 4   # render at 4× then downsample for anti-aliasing
FINAL_SIZE   = 32  # px


def parse_states(html: str) -> list[tuple[str, str, str]]:
    """Return [(label, outer_hex, inner_hex), ...] from the JS STATES array."""
    match = re.search(r"const STATES\s*=\s*\[(.*?)\];", html, re.S)
    if not match:
        sys.exit(f"ERROR: could not find 'const STATES = [...]' in {SPEC_FILE}")
    rows = re.findall(
        r"\{\s*label:\s*'(\w+)',\s*outer:\s*'(#[0-9A-Fa-f]{6})',\s*inner:\s*'(#[0-9A-Fa-f]{6})'",
        match.group(1),
    )
    if not rows:
        sys.exit("ERROR: no states parsed — check STATES format in hub_state_colors.html")
    return rows


def hex_rgba(h: str, a: int = 255) -> tuple:
    h = h.lstrip("#")
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), a)


def blend_over(fg_rgb, alpha: float, bg=(4, 52, 44)) -> tuple:
    return (
        int(fg_rgb[0] * alpha + bg[0] * (1 - alpha)),
        int(fg_rgb[1] * alpha + bg[1] * (1 - alpha)),
        int(fg_rgb[2] * alpha + bg[2] * (1 - alpha)),
        255,
    )


def make_icon(outer_hex: str, inner_hex: str) -> Image.Image:
    s = FINAL_SIZE * RENDER_SCALE
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # Background
    d.rounded_rectangle([(0, 0), (s - 1, s - 1)], radius=7 * RENDER_SCALE, fill=hex_rgba("#04342C"))

    # Geometry from the 32px favicon SVG — all coords in the 32×32 px space
    outer_nodes = [        # (x, y) — left, top-left, top-right, right, bottom-right, bottom-left
        ( 5, 17),
        (12,  5),
        (24,  7),
        (28, 16),
        (24, 25),
        (13, 28),
    ]
    hub = (18, 16)         # (x, y)
    ring = [               # (x1, y1, x2, y2) — perimeter edges
        ( 5, 17, 12,  5),
        (12,  5, 24,  7),
        (24,  7, 28, 16),
        (28, 16, 24, 25),
        (24, 25, 13, 28),
        (13, 28,  5, 17),
    ]
    spokes = [             # (x1, y1, x2, y2) — outer node → hub
        ( 5, 17, 18, 16),
        (12,  5, 18, 16),
        (28, 16, 18, 16),
        (13, 28, 18, 16),
    ]
    outer_radii = [2.0, 2.0, 1.5, 2.5, 1.5, 2.0]  # r per node, same order as outer_nodes
    hub_r_outer = 6   # r of the colored hub ring
    hub_r_inner = 3.5   # r of the center status dot

    line_color = blend_over(hex_rgba("#5DCAA5")[:3], 0.7)
    lw = max(2, round(1.4 * RENDER_SCALE * 0.7))

    for x1, y1, x2, y2 in ring + spokes:
        d.line([(x1 * RENDER_SCALE, y1 * RENDER_SCALE), (x2 * RENDER_SCALE, y2 * RENDER_SCALE)],
               fill=line_color, width=lw)

    node_color = hex_rgba("#9FE1CB")
    for (nx, ny), r in zip(outer_nodes, outer_radii):
        rs = r * RENDER_SCALE
        d.ellipse([(nx*RENDER_SCALE - rs, ny*RENDER_SCALE - rs),
                   (nx*RENDER_SCALE + rs, ny*RENDER_SCALE + rs)], fill=node_color)

    hx, hy = hub[0] * RENDER_SCALE, hub[1] * RENDER_SCALE
    for r, color in ((hub_r_outer, hex_rgba(outer_hex)), (hub_r_inner, hex_rgba(inner_hex))):
        rs = r * RENDER_SCALE
        d.ellipse([(hx - rs, hy - rs), (hx + rs, hy + rs)], fill=color)

    return img.resize((FINAL_SIZE, FINAL_SIZE), Image.LANCZOS)


def main():
    html = SPEC_FILE.read_text()
    rows = parse_states(html)
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    generated = []
    for label, outer, inner in rows:
        states = LABEL_TO_STATE.get(label)
        if states is None:
            print(f"  skip unknown label '{label}'")
            continue
        icon = make_icon(outer, inner)
        for state in states:
            path = OUT_DIR / f"{state}.png"
            icon.save(path, "PNG")
            generated.append(f"  {state}.png  ({label}: outer={outer} inner={inner})")

    print("Generated tray icons:")
    for line in generated:
        print(line)


if __name__ == "__main__":
    main()
