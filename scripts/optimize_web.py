"""Shrink what the browser downloads on first load (run after build_world).

- Terrain colour + normal chunks: JPEG -> WebP (about 47% smaller at the same visual quality).
- 2 m height grid: Uint16 -> row-wise deltas (Int16) + gzip (about 42% smaller); the browser
  decompresses with the built-in DecompressionStream and integrates the deltas back.

Lossless for heights (the deltas are exact). world.json is updated to point at the new files.
"""
import gzip
import json
from pathlib import Path

import numpy as np
from PIL import Image

WORLD = Path(__file__).resolve().parent.parent / "data" / "processed" / "world"


def main():
    meta = json.loads((WORLD / "world.json").read_text())
    before = after = 0
    for jpg in sorted((WORLD / "chunks").glob("*.jpg")):
        webp = jpg.with_suffix(".webp")
        q = 90 if jpg.name.startswith("n") else 82  # normal maps keep a little more precision
        Image.open(jpg).save(webp, "WEBP", quality=q, method=6)
        before += jpg.stat().st_size
        after += webp.stat().st_size
        jpg.unlink()
    meta["chunkExt"] = "webp"

    h = meta["height"]
    src = WORLD / Path(h["file"]).name
    if src.suffix == ".bin":
        raw = np.fromfile(src, dtype="<u2").astype(np.int32).reshape(h["rows"], h["cols"])
        delta = np.diff(raw, axis=1, prepend=0).astype("<i2")  # first column = absolute value
        # int16 wraps; the decoder accumulates mod 2^16 into a Uint16Array, which undoes the wrap exactly
        assert ((np.cumsum(delta.astype(np.int64), axis=1) % 65536) == raw).all(), "delta round-trip failed"
        out = WORLD / "height.delta.gz"
        out.write_bytes(gzip.compress(delta.tobytes(), 9))
        before += src.stat().st_size
        after += out.stat().st_size
        src.unlink()
        h["file"] = "world/height.delta.gz"
        h["encoding"] = "row-delta-int16-gzip"
    (WORLD / "world.json").write_text(json.dumps(meta, indent=1))
    print(f"optimized: {before / 1e6:.1f} MB -> {after / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
