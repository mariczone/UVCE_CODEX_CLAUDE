#!/usr/bin/env python3
"""Generate tiny, deterministic RGBA modular sprites for UVCE engine tests.

Usage:
    python -m pip install Pillow
    python tools/generate_fixture_assets.py [output_folder]

This deliberately produces SYNTHETIC TEST ART, never production-ready game artwork.
All layers use a 256x256 canonical canvas, with foot pivot (128, 228).
"""

from __future__ import annotations

import hashlib
import json
import math
import sys
from pathlib import Path

from PIL import Image, ImageDraw

WIDTH = HEIGHT = 256
FPS = 8
FRAMES = 8
DIRECTIONS = ("N", "NE", "E", "SE", "S", "SW", "W", "NW")
FOOT_PIVOT = {"x": 128, "y": 228}
ASSETS = (
    "body", "head", "hair_back_01", "hair_front_01",
    "hair_back_02", "hair_front_02", "armor_01", "armor_02", "armor_03",
    "hat_01", "hat_02", "hat_03", "weapon_01", "weapon_02", "weapon_03"
)
PALETTE = {
    "body": "#938d7d", "head": "#e9b99d", "hair": "#5b4058",
    "eyes": "#352d39", "outline": "#392e43"
}


def rgba(s: str, alpha: int = 255):
    return (*tuple(int(s[i:i+2], 16) for i in (1, 3, 5)), alpha)


def new_canvas():
    return Image.new("RGBA", (WIDTH, HEIGHT), (0, 0, 0, 0))


def draw_part(name: str, direction: str, frame: int) -> Image.Image:
    image = new_canvas()
    d = ImageDraw.Draw(image)
    # Tiny bounded idle motion. Feet never move for this fixture.
    bounce = int(round(2 * math.sin(2 * math.pi * frame / FRAMES)))
    front_view = direction not in ("N", "NE", "NW")
    side_shift = {"N": 0, "NE": -3, "E": -7, "SE": -3,
                  "S": 0, "SW": 3, "W": 7, "NW": 3}[direction]
    cx = 128 + side_shift
    o = rgba(PALETTE["outline"])

    if name == "body":
        d.polygon([(cx-25, 104+bounce), (cx+25, 104+bounce),
                   (cx+23, 169), (cx-23, 169)],
                  fill=rgba(PALETTE["body"]), outline=o, width=2)
        d.polygon([(cx-18, 163), (cx-2, 163), (cx-5, 220), (cx-22, 220)],
                  fill=rgba("#6f736f"), outline=o)
        d.polygon([(cx+2, 163), (cx+18, 163), (cx+22, 220), (cx+5, 220)],
                  fill=rgba("#6f736f"), outline=o)
        d.rectangle((cx-27, 219, cx-5, 228), fill=rgba("#433c46"))
        d.rectangle((cx+5, 219, cx+27, 228), fill=rgba("#433c46"))
        d.line([(cx-22, 112+bounce), (cx-37, 140+bounce), (cx-33, 149+bounce)],
               fill=rgba("#c6977c"), width=12)
        d.line([(cx+22, 112+bounce), (cx+40, 137+bounce), (cx+35, 147+bounce)],
               fill=rgba("#c6977c"), width=12)
    elif name == "head":
        d.ellipse((cx-24, 47+bounce, cx+24, 98+bounce),
                  fill=rgba(PALETTE["head"]), outline=o, width=2)
        if front_view:
            eye_dx = {"S": 0, "SE": 4, "SW": -4, "E": 5, "W": -5}.get(direction, 0)
            for e in (-8, 8):
                d.ellipse((cx+e+eye_dx-2, 69+bounce, cx+e+eye_dx+2, 73+bounce),
                          fill=rgba(PALETTE["eyes"]))
    elif name.startswith("hair_back_"):
        color = "#76516c" if name.endswith("02") else PALETTE["hair"]
        d.ellipse((cx-30, 38+bounce, cx+30, 118+bounce), fill=rgba(color), outline=o, width=2)
    elif name.startswith("hair_front_"):
        color = "#916582" if name.endswith("02") else "#4a344e"
        d.pieslice((cx-26, 33+bounce, cx+26, 84+bounce), 180, 350,
                   fill=rgba(color), outline=o, width=2)
        d.polygon([(cx-22, 54+bounce), (cx-9, 79+bounce), (cx+4, 52+bounce)],
                  fill=rgba(color))
    elif name.startswith("armor_"):
        idx = int(name.rsplit("_", 1)[1])
        fill = ("#51798b", "#a37351", "#677f5d")[idx-1]
        d.polygon([(cx-26, 105+bounce), (cx+26, 105+bounce),
                   (cx+24, 166), (cx-24, 166)], fill=rgba(fill), outline=o, width=2)
        d.line([(cx, 105+bounce), (cx, 165)], fill=rgba("#d6c29d"), width=3)
        d.rectangle((cx-25, 146, cx+25, 153), fill=rgba("#58434e"))
    elif name.startswith("hat_"):
        idx = int(name.rsplit("_", 1)[1])
        fill = ("#926a40", "#7c5c98", "#4d826d")[idx-1]
        if idx == 1:
            d.polygon([(cx-34, 53+bounce), (cx-24, 29+bounce), (cx+23, 29+bounce),
                       (cx+34, 53+bounce)], fill=rgba(fill), outline=o, width=2)
            d.line([(cx-40, 54+bounce), (cx+40, 54+bounce)], fill=o, width=5)
        elif idx == 2:
            d.polygon([(cx-23, 52+bounce), (cx-8, 18+bounce), (cx+8, 18+bounce),
                       (cx+24, 52+bounce)], fill=rgba(fill), outline=o, width=2)
        else:
            d.arc((cx-26, 23+bounce, cx+26, 75+bounce), 185, 355, fill=rgba(fill), width=14)
            d.ellipse((cx-7, 11+bounce, cx+7, 25+bounce), fill=rgba(fill))
    elif name.startswith("weapon_"):
        idx = int(name.rsplit("_", 1)[1])
        x = cx+38
        if idx == 1:
            d.line([(x, 142+bounce), (x+13, 67+bounce)], fill=rgba("#c3d6df"), width=8)
            d.line([(x-7, 124+bounce), (x+12, 128+bounce)], fill=rgba("#8b6a42"), width=6)
        elif idx == 2:
            d.line([(x, 142+bounce), (x+10, 72+bounce)], fill=rgba("#7f6549"), width=6)
            d.ellipse((x-2, 60+bounce, x+24, 90+bounce), fill=rgba("#c4a364"), outline=o, width=2)
        else:
            d.line([(x, 142+bounce), (x+10, 65+bounce)], fill=rgba("#a6a8b5"), width=7)
            d.line([(x-8, 123+bounce), (x+12, 129+bounce)], fill=rgba("#96544b"), width=6)
    else:
        raise ValueError(f"Unknown part: {name}")

    return image


def main() -> None:
    dest = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("assets/fixtures")
    dest.mkdir(parents=True, exist_ok=True)
    for name in ASSETS:
        for direction in DIRECTIONS:
            path = dest / name / direction
            path.mkdir(parents=True, exist_ok=True)
            for frame in range(FRAMES):
                draw_part(name, direction, frame).save(path / f"frame_{frame:03}.png", optimize=True)

    content = {
        "schemaVersion": "uvce-fixture-v1",
        "generatedBy": "tools/generate_fixture_assets.py",
        "artStatus": "synthetic-placeholder-not-for-production",
        "canonicalCanvas": {"width": WIDTH, "height": HEIGHT},
        "footPivot": FOOT_PIVOT,
        "directions": list(DIRECTIONS),
        "clips": {"idle": {"fps": FPS, "frameCount": FRAMES, "loop": True}},
        "assetIds": list(ASSETS),
        "assetPathTemplate": "{assetId}/{direction}/frame_{frame:03}.png",
        "drawOrderByDirection": {
            d: ["hair_back_01", "body", "armor_01", "head", "hair_front_01", "hat_01", "weapon_01"]
            if d in ("S", "SE", "SW", "E", "W")
            else ["hair_back_01", "weapon_01", "body", "armor_01", "head", "hair_front_01", "hat_01"]
            for d in DIRECTIONS
        },
        "notice": "All socket coordinates/artwork are synthetic. Validate real directional rigs separately."
    }
    data = json.dumps(content, indent=2, ensure_ascii=False) + "\n"
    (dest / "fixture-manifest.json").write_text(data, encoding="utf-8")

    # Goldens: composition with the fixture's exact painter-order for each direction.
    reference_dir = dest / "_reference"
    reference_dir.mkdir(parents=True, exist_ok=True)
    for direction in DIRECTIONS:
        composite = new_canvas()
        for asset_id in content["drawOrderByDirection"][direction]:
            layer = draw_part(asset_id, direction, 0)
            composite = Image.alpha_composite(composite, layer)
        composite.save(reference_dir / f"{direction}_frame_000.png", optimize=True)

    checksum = hashlib.sha256(data.encode("utf-8")).hexdigest()
    print(f"Generated {len(ASSETS) * len(DIRECTIONS) * FRAMES} PNG images in {dest}")
    print(f"Manifest SHA256: {checksum}")


if __name__ == "__main__":
    main()
