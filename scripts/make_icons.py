"""生成同行 PWA 的图标与社交分享图。

用法：python scripts/make_icons.py
依赖：Pillow, numpy
"""

from __future__ import annotations

import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
ICONS = ROOT / "public" / "icons"
ICONS.mkdir(parents=True, exist_ok=True)

INK = (11, 27, 34)
INK_LIGHT = (23, 55, 65)
CREAM = (247, 242, 232)
CORAL = (255, 106, 77)
MINT = (158, 216, 197)
TEAL = (30, 107, 92)
FONT_BOLD = "C:/Windows/Fonts/msyhbd.ttc"
FONT_REGULAR = "C:/Windows/Fonts/msyh.ttc"


def cubic(p0, p1, p2, p3, steps=100):
    points = []
    for index in range(steps + 1):
        t = index / steps
        mt = 1 - t
        x = mt**3 * p0[0] + 3 * mt**2 * t * p1[0] + 3 * mt * t**2 * p2[0] + t**3 * p3[0]
        y = mt**3 * p0[1] + 3 * mt**2 * t * p1[1] + 3 * mt * t**2 * p2[1] + t**3 * p3[1]
        points.append((x, y))
    return points


def make_background(size: int) -> Image.Image:
    y, x = np.mgrid[0:size, 0:size].astype(np.float32)
    cx, cy = size * 0.34, size * 0.28
    distance = np.sqrt((x - cx) ** 2 + (y - cy) ** 2) / (size * 0.95)
    glow = np.clip(1 - distance, 0, 1) ** 1.7
    base = np.array(INK, dtype=np.float32)
    light = np.array(INK_LIGHT, dtype=np.float32)
    rgb = base[None, None, :] + (light - base)[None, None, :] * glow[..., None]
    image = Image.fromarray(np.uint8(np.clip(rgb, 0, 255)), "RGB").convert("RGBA")
    return image


def draw_icon(size: int = 1024) -> Image.Image:
    scale = 2
    canvas_size = size * scale
    image = make_background(canvas_size)
    draw = ImageDraw.Draw(image, "RGBA")

    # 细腻的等高线，像一张被折叠过的地图。
    center = canvas_size / 2
    for index, radius in enumerate((300, 372, 444, 516)):
        offset = (index % 2) * 18
        box = (
            center - radius - offset,
            center - radius - offset,
            center + radius + offset,
            center + radius + offset,
        )
        draw.arc(box, start=202 + index * 11, end=338 + index * 11, fill=(158, 216, 197, 22), width=3 * scale)

    # 两个位置点之间的路径。
    path = cubic(
        (0.35 * canvas_size, 0.355 * canvas_size),
        (0.43 * canvas_size, 0.40 * canvas_size),
        (0.54 * canvas_size, 0.54 * canvas_size),
        (0.66 * canvas_size, 0.645 * canvas_size),
        steps=90,
    )
    for index in range(0, len(path) - 1, 3):
        draw.line((path[index], path[index + 1]), fill=(247, 242, 232, 42), width=5 * scale)
    for index in range(8, len(path) - 4, 14):
        x, y = path[index]
        r = 4 * scale
        draw.ellipse((x - r, y - r, x + r, y + r), fill=(247, 242, 232, 205))

    # 珊瑚色：你。
    x1, y1 = 0.35 * canvas_size, 0.355 * canvas_size
    for radius, alpha, width in ((0.112, 40, 3), (0.09, 58, 3)):
        draw.ellipse(
            (
                x1 - radius * canvas_size,
                y1 - radius * canvas_size,
                x1 + radius * canvas_size,
                y1 + radius * canvas_size,
            ),
            outline=(255, 106, 77, alpha),
            width=width * scale,
        )
    r = 0.071 * canvas_size
    draw.ellipse((x1 - r, y1 - r, x1 + r, y1 + r), fill=(255, 106, 77, 255))
    draw.ellipse(
        (x1 - r + 7 * scale, y1 - r + 7 * scale, x1 + r - 7 * scale, y1 + r - 7 * scale),
        outline=(247, 242, 232, 255),
        width=9 * scale,
    )
    inner = 0.013 * canvas_size
    draw.ellipse((x1 - inner, y1 - inner, x1 + inner, y1 + inner), fill=(255, 247, 241, 255))

    # 薄荷色：TA。
    x2, y2 = 0.66 * canvas_size, 0.645 * canvas_size
    r = 0.071 * canvas_size
    draw.ellipse(
        (x2 - r, y2 - r, x2 + r, y2 + r),
        fill=(11, 27, 34, 255),
        outline=(158, 216, 197, 255),
        width=13 * scale,
    )
    inner = 0.026 * canvas_size
    draw.ellipse((x2 - inner, y2 - inner, x2 + inner, y2 + inner), fill=(158, 216, 197, 255))
    draw.ellipse(
        (x2 - 0.096 * canvas_size, y2 - 0.096 * canvas_size, x2 + 0.096 * canvas_size, y2 + 0.096 * canvas_size),
        outline=(158, 216, 197, 38),
        width=3 * scale,
    )

    # 右下角一颗很小的星，作为视觉停顿。
    sx, sy = 0.78 * canvas_size, 0.31 * canvas_size
    sr = 5 * scale
    draw.ellipse((sx - sr, sy - sr, sx + sr, sy + sr), fill=(247, 242, 232, 180))

    return image.resize((size, size), Image.Resampling.LANCZOS)


def make_maskable(source: Image.Image) -> Image.Image:
    # 图形主体已经位于中心 80% 安全区，直接使用完整背景，避免出现内嵌方块。
    return source.copy()


def rounded_mask(image: Image.Image, radius_ratio: float = 0.22) -> Image.Image:
    size = image.size[0]
    mask = Image.new("L", (size, size), 0)
    draw = ImageDraw.Draw(mask)
    radius = int(size * radius_ratio)
    draw.rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    result = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    result.paste(image, (0, 0), mask)
    return result


def get_font(path: str, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(path, size=size, index=0)


def make_cover(icon: Image.Image) -> Image.Image:
    width, height = 1200, 630
    canvas = Image.new("RGB", (width, height), CREAM)
    draw = ImageDraw.Draw(canvas)

    # 暖色纸张与柔和光晕。
    glow = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    glow_draw = ImageDraw.Draw(glow)
    for radius in range(540, 20, -18):
        alpha = int(2 + (540 - radius) * 0.018)
        glow_draw.ellipse((850 - radius, 80 - radius, 850 + radius, 80 + radius), fill=(158, 216, 197, alpha))
    canvas = Image.alpha_composite(canvas.convert("RGBA"), glow).convert("RGB")
    draw = ImageDraw.Draw(canvas)

    # 等高线。
    for index, radius in enumerate((250, 310, 370, 430, 490)):
        box = (880 - radius, 300 - radius, 880 + radius, 300 + radius)
        draw.arc(box, start=190 + index * 8, end=348 + index * 8, fill=(30, 107, 92, 22), width=2)

    card = rounded_mask(icon, 0.22)
    card = card.resize((238, 238), Image.Resampling.LANCZOS)
    canvas.paste(card, (86, 92), card)

    font_eyebrow = get_font(FONT_BOLD, 19)
    font_title = get_font(FONT_BOLD, 61)
    font_body = get_font(FONT_REGULAR, 23)
    font_brand = get_font(FONT_BOLD, 25)

    draw.text((354, 107), "TONGXING · LIVE TOGETHER", font=font_eyebrow, fill=(95, 114, 118))
    draw.text((348, 154), "让彼此，", font=font_title, fill=INK)
    draw.text((348, 228), "始终在同一张", font=font_title, fill=INK)
    draw.text((348, 302), "地图上。", font=font_title, fill=TEAL)
    draw.text((352, 402), "两个人的实时定位，创建房间就能用。", font=font_body, fill=(40, 67, 75))
    draw.text((352, 446), "iOS / Android · 添加到主屏幕", font=font_body, fill=(95, 114, 118))

    draw.line((352, 518, 1110, 518), fill=(11, 27, 34, 36), width=1)
    draw.text((352, 544), "同行", font=font_brand, fill=INK)
    draw.ellipse((410, 560, 417, 567), fill=CORAL)
    draw.text((438, 545), "A SMALL PLACE FOR TWO", font=get_font(FONT_BOLD, 14), fill=(95, 114, 118))

    return canvas


def main() -> None:
    icon_1024 = draw_icon(1024)
    icon_1024.save(ICONS / "icon-1024.png", optimize=True)

    for size in (512, 192, 180, 32):
        resized = icon_1024.resize((size, size), Image.Resampling.LANCZOS)
        name = "apple-touch-icon.png" if size == 180 else f"icon-{size}.png"
        if size == 32:
            name = "favicon-32.png"
        resized.save(ICONS / name, optimize=True)

    icon_1024.save(ICONS / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)])

    maskable = make_maskable(icon_1024).resize((512, 512), Image.Resampling.LANCZOS)
    maskable.save(ICONS / "icon-maskable-512.png", optimize=True)

    cover = make_cover(icon_1024)
    cover.save(ICONS / "og-cover.png", optimize=True)

    print("icons written to", ICONS)


if __name__ == "__main__":
    main()
