"""Generates the FauxCode icon: dark rounded square, electric bolt, faint braces.
Outputs icon.ico (multi-res) plus PNGs for the Tauri scaffold."""

from PIL import Image, ImageDraw, ImageFont

S = 1024
BG = (23, 25, 38, 255)        # deep slate, darker than any editor theme
BOLT = (59, 158, 255, 255)    # electric blue
BOLT_EDGE = (28, 106, 189, 255)
BRACE = (86, 99, 128, 255)    # subtle slate braces

img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# rounded dark tile
d.rounded_rectangle((40, 40, S - 40, S - 40), radius=190, fill=BG)

# faint braces, hugging the edges
try:
    font = ImageFont.truetype("C:/Windows/Fonts/consolab.ttf", 560)
except OSError:
    font = ImageFont.truetype("C:/Windows/Fonts/arialbd.ttf", 520)
d.text((S * 0.245, S * 0.50), "{", font=font, fill=BRACE, anchor="mm")
d.text((S * 0.755, S * 0.50), "}", font=font, fill=BRACE, anchor="mm")

# the bolt (drawn last, on top)
def pts(coords):
    return [(x * S, y * S) for x, y in coords]

bolt = pts([
    (0.585, 0.150),
    (0.360, 0.545),
    (0.492, 0.545),
    (0.415, 0.850),
    (0.660, 0.440),
    (0.523, 0.440),
])
d.polygon(bolt, fill=BOLT, outline=BOLT_EDGE, width=10)

# exports
img.save("icon_1024.png")
for size in (256, 128, 32):
    img.resize((size, size), Image.LANCZOS).save(f"icon_{size}.png")
img.save("icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print("icon.ico + PNGs written")
