# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow==12.0.0"]
# ///
"""Regenerate the TIFF fixtures: `uv run generate.py` from this directory.

Also needs libtiff's `tiffcp` and `tiffset` on the PATH (`brew install libtiff`).
Pillow writes most of these through libtiff already; the tools are for what Pillow
has no switch for — Group 3 2D, fill bits, bit-reversed fill order, tiles, and
editing a tag in place.

Every fixture is the same 70x50 picture, so the Rust tests assert one set of
expectations against all of them: a dark square over x 16..48, y 12..36 on a light
ground, and, on the colour ones, a green marker in the top-left 8x8 so a rotation or
a mirror is visible. 70x50 rather than a power of two so 16px tiles need padding.

Also writes the demo's `drawing.tif`, a two-page Group 4 "scan" whose first sheet is
larger than the default decode cap, so the demo exercises the downsampling path.
"""

import shutil
import subprocess
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).parent
DEMO = HERE.parents[3] / "apps" / "demo" / "public"
W, H = 70, 50
SQUARE = (16, 12, 47, 35)


def bilevel(square_at=SQUARE) -> Image.Image:
    im = Image.new("1", (W, H), 1)
    ImageDraw.Draw(im).rectangle(square_at, fill=0)
    return im


def colour(mode: str, ground, ink, marker) -> Image.Image:
    im = Image.new(mode, (W, H), ground)
    d = ImageDraw.Draw(im)
    d.rectangle(SQUARE, fill=ink)
    if marker is not None:
        d.rectangle((0, 0, 7, 7), fill=marker)
    return im


def tool(*args: str) -> None:
    subprocess.run(args, check=True)


def derive(src: str, dst: str, *flags: str) -> None:
    tool("tiffcp", *flags, str(HERE / src), str(HERE / dst))


def retag(src: str, dst: str, tag: int, value: int, directory: int = 0) -> None:
    shutil.copy(HERE / src, HERE / dst)
    tool("tiffset", "-d", str(directory), "-s", str(tag), str(value), str(HERE / dst))


# Bilevel, every CCITT flavour a TIFF can carry.
bilevel().save(HERE / "g4.tif", compression="group4", dpi=(300, 300))
bilevel().save(HERE / "mh.tif", compression="tiff_ccitt")
derive("g4.tif", "g3-1d.tif", "-c", "g3:1d")
derive("g4.tif", "g3-2d.tif", "-c", "g3:2d")
derive("g4.tif", "g3-fill.tif", "-c", "g3:2d:fill")
derive("g4.tif", "g4-lsb.tif", "-c", "g4", "-f", "lsb2msb")
# Seven-row strips, so the last one is short.
derive("g4.tif", "g4-strips.tif", "-c", "g4", "-r", "7")
# Pillow writes min-is-black; flipping the tag in place flips the picture.
retag("g4.tif", "g4-inverted.tif", 262, 0)
# A resolution in centimetres: 118.11 px/cm is 300 dpi.
bilevel().save(
    HERE / "g4-cm.tif",
    compression="group4",
    tiffinfo={282: 118.11, 283: 118.11, 296: 3},
)
derive("g4.tif", "bigtiff.tif", "-8")

# Three pages, the nth with n squares' worth of ink, then a reduced-resolution
# thumbnail as a fourth directory, which is not a page.
pages = [bilevel((8, 8, 8 + 12 * (n + 1), 20)) for n in range(3)]
thumb = bilevel().resize((35, 25))
pages[0].save(
    HERE / "multipage.tif",
    compression="group4",
    save_all=True,
    append_images=[*pages[1:], thumb],
)
tool("tiffset", "-d", "3", "-s", "254", "1", str(HERE / "multipage.tif"))

# Continuous tone.
BLUE, RED, GREEN = (30, 60, 200), (220, 20, 20), (0, 200, 0)
colour("RGB", BLUE, RED, GREEN).save(HERE / "rgb-lzw.tif", compression="tiff_lzw")
derive("rgb-lzw.tif", "rgb-predictor.tif", "-c", "lzw:2")
derive("rgb-lzw.tif", "tiled.tif", "-c", "lzw", "-t", "-w", "16", "-l", "16")
colour("RGB", BLUE, RED, GREEN).save(HERE / "jpeg.tif", compression="tiff_jpeg")
# What a scanner writes: libtiff's default for JPEG is YCbCr, subsampled 2x2.
derive("rgb-lzw.tif", "jpeg-ycbcr.tif", "-c", "jpeg")
colour("RGBA", (0, 0, 0, 0), RED + (255,), GREEN + (255,)).save(
    HERE / "rgba.tif", compression="tiff_adobe_deflate"
)
colour("L", 200, 50, None).save(HERE / "gray-deflate.tif", compression="tiff_adobe_deflate")
colour("I;16", 51400, 12850, None).save(HERE / "gray16.tif")
colour("CMYK", (255, 0, 0, 0), (0, 255, 255, 0), None).save(HERE / "cmyk.tif")
palette = colour("RGB", BLUE, RED, GREEN).quantize(colors=4)
palette.save(HERE / "palette.tif", compression="packbits")
# Orientation 6: stored on its side, shown turned a quarter clockwise.
retag("rgb-lzw.tif", "orient6.tif", 274, 6)


def drawing(width: int, height: int, title: str) -> Image.Image:
    """A line drawing with a border, a grid of bays, a few circles and a title block."""
    im = Image.new("1", (width, height), 1)
    d = ImageDraw.Draw(im)
    m = width // 40
    d.rectangle((m, m, width - m, height - m), outline=0, width=max(4, width // 1500))
    bays, rows = 8, 5
    x0, y0, x1, y1 = m * 3, m * 3, width - m * 3, height - m * 6
    for i in range(bays + 1):
        x = x0 + (x1 - x0) * i // bays
        d.line((x, y0, x, y1), fill=0, width=3)
        r = m // 2
        d.ellipse((x - r, y0 - 2 * r - 10, x + r, y0 - 10), outline=0, width=3)
    for j in range(rows + 1):
        y = y0 + (y1 - y0) * j // rows
        d.line((x0, y, x1, y), fill=0, width=3)
    for i in range(bays):
        for j in range(rows):
            cx = x0 + (x1 - x0) * (2 * i + 1) // (2 * bays)
            cy = y0 + (y1 - y0) * (2 * j + 1) // (2 * rows)
            d.rectangle((cx - 12, cy - 12, cx + 12, cy + 12), fill=0)
    font = ImageFont.load_default(size=max(24, height // 40))
    tb = (width - m - width // 4, height - m - m * 4, width - m, height - m)
    d.rectangle(tb, outline=0, width=4)
    d.text((tb[0] + m // 2, tb[1] + m // 2), title, fill=0, font=font)
    d.text((tb[0] + m // 2, tb[1] + m * 2), "SCALE 1:100  ·  SHEET OF 2", fill=0, font=font)
    return im


if DEMO.is_dir():
    # 36x24in at 200 dpi: 34.6 MP, twice the default cap.
    first = drawing(7200, 4800, "S-101  FOUNDATION PLAN")
    second = drawing(3300, 2550, "S-102  DETAILS")
    first.save(
        DEMO / "drawing.tif",
        compression="group4",
        dpi=(200, 200),
        save_all=True,
        append_images=[second],
    )
