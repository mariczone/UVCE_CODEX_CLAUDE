#!/usr/bin/env python3
"""Validate the UVCE fixture output; requires Pillow. Read-only."""
from pathlib import Path
import json
import sys
from PIL import Image

DIRECTIONS = ("N", "NE", "E", "SE", "S", "SW", "W", "NW")
root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("assets/fixtures")
manifest = json.loads((root / "fixture-manifest.json").read_text(encoding="utf-8"))
assert manifest["directions"] == list(DIRECTIONS)
assert manifest["footPivot"] == {"x": 128, "y": 228}
assert manifest["canonicalCanvas"] == {"width": 256, "height": 256}
assert manifest["clips"]["idle"]["frameCount"] == 8

for asset_id in manifest["assetIds"]:
    for direction in DIRECTIONS:
        for frame in range(8):
            img_path = root / asset_id / direction / f"frame_{frame:03}.png"
            assert img_path.is_file(), f"Missing frame: {img_path}"
            with Image.open(img_path) as image:
                assert image.mode == "RGBA" and image.size == (256, 256), img_path

for direction in DIRECTIONS:
    composited = Image.new("RGBA", (256, 256), (0, 0, 0, 0))
    for asset_id in manifest["drawOrderByDirection"][direction]:
        with Image.open(root / asset_id / direction / "frame_000.png") as layer:
            composited = Image.alpha_composite(composited, layer)
    with Image.open(root / "_reference" / f"{direction}_frame_000.png") as golden:
        assert composited.tobytes() == golden.tobytes(), f"Visual golden mismatch {direction}"

print(f"PASS: {len(manifest['assetIds'])} assets, 8 directions, 8 frames, 8 RGBA compositing goldens")
