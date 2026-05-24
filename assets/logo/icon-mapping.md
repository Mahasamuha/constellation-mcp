# Icon Mapping: assets/logo → packages/agent-gui/src-tauri/icons

## Strategy

All app icons are generated via `tauri icon <source>` from a single 1024×1024 PNG.
The source PNG is rasterized from `constellation-icon-512.svg` with the macOS
rounded-square background enabled (see note below).

Tray icons are already generated programmatically by `generate_tray_icons.py`
using the same constellation graph geometry — no change needed for those.

---

## Source preparation

| Step | Action |
|------|--------|
| 1 | Add `<rect width="512" height="512" rx="114" fill="#888780"/>` as the first child of `constellation-icon-512.svg` (macOS-style rounded-square background) |
| 2 | Rasterize to `icon-source-1024.png` at 1024×1024 via `rsvg-convert -w 1024 -h 1024 constellation-icon-512.svg -o icon-source-1024.png` |
| 3 | Run `npx tauri icon icon-source-1024.png` from the repo root — Tauri auto-generates all targets below |
| 4 | Delete the temp `icon-source-1024.png` |

---

## Generated targets

All files below are output by `tauri icon`. No manual per-file handling needed.

| Target file | Size | Notes |
|-------------|------|-------|
| `icons/icon.png` | 512×512 | Main app icon |
| `icons/icon.icns` | multi-res | macOS bundle icon |
| `icons/icon.ico` | multi-res | Windows bundle icon |
| `icons/32x32.png` | 32×32 | |
| `icons/128x128.png` | 128×128 | |
| `icons/128x128@2x.png` | 256×256 | |
| `icons/Square30x30Logo.png` | 30×30 | Windows Store |
| `icons/Square44x44Logo.png` | 44×44 | Windows Store |
| `icons/Square71x71Logo.png` | 71×71 | Windows Store |
| `icons/Square89x89Logo.png` | 89×89 | Windows Store |
| `icons/Square107x107Logo.png` | 107×107 | Windows Store |
| `icons/Square142x142Logo.png` | 142×142 | Windows Store |
| `icons/Square150x150Logo.png` | 150×150 | Windows Store |
| `icons/Square284x284Logo.png` | 284×284 | Windows Store |
| `icons/Square310x310Logo.png` | 310×310 | Windows Store |
| `icons/StoreLogo.png` | 50×50 | Windows Store |

---

## Tray icons (no change)

| File | How generated |
|------|--------------|
| `icons/tray/*.png` | `python3 assets/logo/generate_tray_icons.py` |
| `icons/tray/mac/*.png` | same script |

These already use the constellation graph geometry from the SVGs. Re-run the
script only if state colors need updating.

---

## Dependency

`rsvg-convert` is required for step 2:
- macOS: `brew install librsvg`
- Ubuntu: `sudo apt-get install librsvg2-bin`
