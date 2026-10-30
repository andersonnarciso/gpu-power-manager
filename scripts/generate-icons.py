#!/usr/bin/env python3
"""Gera os ícones do aplicativo.

O glifo é o símbolo universal de "energia" (o botão de liga/desliga) sobre o
fundo grafite do app, com o verde-limão como cor de destaque.

Uso:
    python3 scripts/generate-icons.py
"""

from __future__ import annotations

import os
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "resources", "icons")

GRAPHITE_TOP = (27, 31, 36)
GRAPHITE_BOTTOM = (10, 11, 13)
LIME = (163, 230, 53)
LIME_SOFT = (217, 249, 157)

SIZES = (16, 32, 48, 64, 128, 256, 512)

SS = 4  # fator de superamostragem para o antialiasing


def rounded_gradient(size: int) -> Image.Image:
    """Fundo grafite com um leve gradiente vertical e cantos arredondados."""
    w = h = size
    top = Image.new("RGBA", (w, h), GRAPHITE_TOP + (255,))
    bottom = Image.new("RGBA", (w, h), GRAPHITE_BOTTOM + (255,))
    gradient = Image.new("RGBA", (1, h))
    for y in range(h):
        t = y / max(1, h - 1)
        gradient.putpixel(
            (0, y),
            (
                int(GRAPHITE_TOP[0] + (GRAPHITE_BOTTOM[0] - GRAPHITE_TOP[0]) * t),
                int(GRAPHITE_TOP[1] + (GRAPHITE_BOTTOM[1] - GRAPHITE_TOP[1]) * t),
                int(GRAPHITE_TOP[2] + (GRAPHITE_BOTTOM[2] - GRAPHITE_TOP[2]) * t),
                255,
            ),
        )
    gradient = gradient.resize((w, h))

    mask = Image.new("L", (w, h), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, w - 1, h - 1), radius=int(size * 0.22), fill=255)
    top.paste(gradient, (0, 0), mask)
    return top


def draw_power(canvas: Image.Image) -> None:
    """Desenha o símbolo de energia (anel aberto no topo + haste)."""
    w, h = canvas.size
    draw = ImageDraw.Draw(canvas)

    cx = w * 0.5
    cy = h * 0.54
    radius = w * 0.255
    stroke = max(2, int(w * 0.068))

    # Anel aberto no topo: de 300° até 600° (sentido horário) deixa a
    # abertura entre 240° e 300°, ou seja, em cima.
    box = (cx - radius, cy - radius, cx + radius, cy + radius)
    draw.arc(box, start=300, end=600, fill=LIME, width=stroke)

    # Haste vertical.
    bar_top = h * 0.185
    bar_bottom = cy - radius * 0.08
    draw.line((cx, bar_top, cx, bar_bottom), fill=LIME_SOFT, width=stroke)

    # Extremidades arredondadas.
    r = stroke / 2
    for cy_pos in (bar_top, bar_bottom):
        draw.ellipse((cx - r, cy_pos - r, cx + r, cy_pos + r), fill=LIME_SOFT)


def build(size: int) -> Image.Image:
    big = rounded_gradient(size * SS)
    draw_power(big)
    return big.resize((size, size), Image.LANCZOS)


def main() -> None:
    os.makedirs(OUT_DIR, exist_ok=True)
    for size in SIZES:
        image = build(size)
        image.save(os.path.join(OUT_DIR, f"{size}x{size}.png"))
        if size == 512:
            image.save(os.path.join(OUT_DIR, "icon.png"))
    print(f"Ícones gerados em {OUT_DIR}: {', '.join(str(s) for s in SIZES)}")


if __name__ == "__main__":
    main()
