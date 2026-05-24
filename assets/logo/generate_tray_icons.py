#!/usr/bin/env python3
"""Generate tray icons for each agent state.

Color specs are sourced from hub_state_colors.html in this directory.
To update: edit the `states` array in that file, then re-run this script.

Usage:
    python3 assets/logo/generate_tray_icons.py

Output:
  packages/agent-gui/src-tauri/icons/tray/{state}.png      — Win/Linux (dark bg)
  packages/agent-gui/src-tauri/icons/tray/mac/{state}.png  — macOS (transparent bg)
"""

import re
import sys
from pathlib import Path
from PIL import Image, ImageDraw

SCRIPT_DIR  = Path(__file__).parent
REPO_ROOT   = SCRIPT_DIR.parent.parent
SPEC_FILE   = SCRIPT_DIR / "hub_state_colors.html"
OUT_DIR     = REPO_ROOT / "packages/agent-gui/src-tauri/icons/tray"
MAC_OUT_DIR = OUT_DIR / "mac"

# Maps the color-label in hub_state_colors.html to the tray icon filename.
# Order must stay consistent with AgentState in config.rs.
LABEL_TO_STATE = {
    "blue":   ["connected"],
    "yellow": ["connecting"],
    "grey":   ["disconnected", "unconfigured"],
    "red":    ["error"],
}

RENDER_SCALE = 4   # render at 4× then downsample for anti-aliasing
FINAL_SIZE   = 32  # px

# ── Graph geometry — all coords in the 32×32 px space ────────────────────────
# Matches the favicon SVG layout.  Edit here; both icon variants pick this up.

OUTER_NODES = [        # (x, y) — left, top-left, top-right, right, bottom-right, bottom-left
    ( 5, 17),
    (12,  5),
    (24,  7),
    (28, 16),
    (24, 25),
    (13, 28),
]
HUB = (18, 16)         # (x, y)

RING = [               # (x1, y1, x2, y2) — perimeter edges
    ( 5, 17, 12,  5),
    (12,  5, 24,  7),
    (24,  7, 28, 16),
    (28, 16, 24, 25),
    (24, 25, 13, 28),
    (13, 28,  5, 17),
]
SPOKES = [             # (x1, y1, x2, y2) — outer node → hub
    ( 5, 17, 18, 16),
    (12,  5, 18, 16),
    (28, 16, 18, 16),
    (13, 28, 18, 16),
]
OUTER_RADII = [2.0, 2.0, 1.5, 2.5, 1.5, 2.0]  # r per node, same order as OUTER_NODES
HUB_R_OUTER = 6    # r of the colored hub ring
HUB_R_INNER = 3.5  # r of the center status dot

LINE_WIDTH = max(2, round(1.4 * RENDER_SCALE * 0.7))


# ── Helpers ───────────────────────────────────────────────────────────────────

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



def draw_graph(d: ImageDraw.ImageDraw, line_color: tuple, node_color: tuple) -> None:
    """Draw edges and outer nodes onto d using the shared geometry constants."""
    s = RENDER_SCALE
    for x1, y1, x2, y2 in RING + SPOKES:
        d.line([(x1*s, y1*s), (x2*s, y2*s)], fill=line_color, width=LINE_WIDTH)
    for (nx, ny), r in zip(OUTER_NODES, OUTER_RADII):
        rs = r * s
        d.ellipse([(nx*s - rs, ny*s - rs), (nx*s + rs, ny*s + rs)], fill=node_color)


def draw_hub(d: ImageDraw.ImageDraw, outer_hex: str, inner_hex: str) -> None:
    """Draw the two-tone hub circle onto d."""
    hx, hy = HUB[0] * RENDER_SCALE, HUB[1] * RENDER_SCALE
    for r, color in ((HUB_R_OUTER, hex_rgba(outer_hex)), (HUB_R_INNER, hex_rgba(inner_hex))):
        rs = r * RENDER_SCALE
        d.ellipse([(hx - rs, hy - rs), (hx + rs, hy + rs)], fill=color)


def render(img: Image.Image) -> Image.Image:
    return img.resize((FINAL_SIZE, FINAL_SIZE), Image.LANCZOS)


# ── Icon variants ─────────────────────────────────────────────────────────────

def make_icon(outer_hex: str, inner_hex: str) -> Image.Image:
    """Win/Linux: transparent background, teal graph, colored hub."""
    s = FINAL_SIZE * RENDER_SCALE
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    draw_graph(d, hex_rgba("#5DCAA5"), hex_rgba("#9FE1CB"))
    draw_hub(d, outer_hex, inner_hex)
    return render(img)


def make_mac_icon(outer_hex: str, inner_hex: str) -> Image.Image:
    """macOS: transparent background, monochrome graph, colored hub.

    Graph elements are black at partial opacity so they read clearly against
    the light menu bar.  The hub keeps its full state color — macOS template
    rendering would discard that color, so icon_as_template is left off.
    """
    s = FINAL_SIZE * RENDER_SCALE
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    draw_graph(d,
               line_color=(0, 0, 0, int(255 * 0.55)),   # black 55%
               node_color=(0, 0, 0, int(255 * 0.65)))   # black 65%
    draw_hub(d, outer_hex, inner_hex)
    return render(img)


# ── Entry point ───────────────────────────────────────────────────────────────

def main():
    html = SPEC_FILE.read_text()
    rows = parse_states(html)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    MAC_OUT_DIR.mkdir(parents=True, exist_ok=True)

    generated = []
    for label, outer, inner in rows:
        states = LABEL_TO_STATE.get(label)
        if states is None:
            print(f"  skip unknown label '{label}'")
            continue
        icon     = make_icon(outer, inner)
        mac_icon = make_mac_icon(outer, inner)
        for state in states:
            icon.save(OUT_DIR / f"{state}.png", "PNG")
            mac_icon.save(MAC_OUT_DIR / f"{state}.png", "PNG")
            generated.append(f"  {state}.png  ({label}: outer={outer} inner={inner})")

    print("Generated tray icons (standard + mac):")
    for line in generated:
        print(line)


if __name__ == "__main__":
    main()
