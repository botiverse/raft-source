#!/usr/bin/env python3
"""Regenerate the Raft Computer Desktop app icons from the Raft brand mark.

One-off dev tool (run manually when the brand mark changes), NOT part of the
build. Requires Pillow + macOS `iconutil`:

    python3 -m venv /tmp/iconvenv && /tmp/iconvenv/bin/pip install Pillow
    /tmp/iconvenv/bin/python apps/raft-computer-app/scripts/generate-app-icons.py

Outputs (committed):
    assets/icon.icns  — macOS app icon. Apple-HIG: the Raft mark on a yellow
                        rounded-rect "card" with ~10% padding + a subtle shadow
                        on a transparent 1024 canvas (Big Sur grid).
    assets/icon.ico   — Windows app icon. Full-bleed square (Windows does not
                        inset/round like macOS).

Source: the square Raft mark shared with the webapp PWA icon.
"""
import os
import subprocess
import tempfile
from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.dirname(HERE)
REPO = os.path.dirname(os.path.dirname(APP))
SRC = os.path.join(REPO, "packages/web/public/android-chrome-512x512.png")
ASSETS = os.path.join(APP, "assets")

CANVAS, BODY = 1024, 824
MARGIN = (CANVAS - BODY) // 2          # 100
RADIUS = 185                           # ~0.2237 * 824 (macOS continuous corner)

src = Image.open(SRC).convert("RGBA")

# --- macOS: rounded-rect card + padding + subtle shadow ---
card = src.resize((BODY, BODY), Image.LANCZOS)
mask = Image.new("L", (BODY, BODY), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, BODY - 1, BODY - 1], radius=RADIUS, fill=255)
card.putalpha(mask)

canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
shadow = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
sh_mask = Image.new("L", (BODY, BODY), 0)
ImageDraw.Draw(sh_mask).rounded_rectangle([0, 0, BODY - 1, BODY - 1], radius=RADIUS, fill=90)
shadow.paste((0, 0, 0, 90), (MARGIN, MARGIN + 16), sh_mask)
canvas = Image.alpha_composite(canvas, shadow.filter(ImageFilter.GaussianBlur(18)))
canvas.paste(card, (MARGIN, MARGIN), card)

with tempfile.TemporaryDirectory() as iconset:
    iconset = os.path.join(iconset, "AppIcon.iconset")
    os.makedirs(iconset)
    for s in (16, 32, 64, 128, 256, 512):
        canvas.resize((s, s), Image.LANCZOS).save(f"{iconset}/icon_{s}x{s}.png")
        canvas.resize((s * 2, s * 2), Image.LANCZOS).save(f"{iconset}/icon_{s}x{s}@2x.png")
    subprocess.run(["iconutil", "-c", "icns", iconset, "-o", os.path.join(ASSETS, "icon.icns")], check=True)
print("wrote", os.path.join(ASSETS, "icon.icns"))

# --- Windows: full-bleed square ---
src.save(os.path.join(ASSETS, "icon.ico"),
         sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print("wrote", os.path.join(ASSETS, "icon.ico"))
