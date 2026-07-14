"""
AI撤回保存器 - 图标生成脚本
生成 16/32/48/128 四种尺寸的 PNG 图标。
设计：红色圆角方形背景 + 白色盾牌 + 盾牌内红色撤回箭头(↺)。
"""
import os
import math
from PIL import Image, ImageDraw

OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "icons")
OUT_DIR = os.path.normpath(OUT_DIR)
os.makedirs(OUT_DIR, exist_ok=True)

W, H = 128, 128

def draw_icon(size):
    s = size
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # 1. 红色圆角方形背景（带竖向渐变）
    r = int(s * 0.22)
    # 绘制渐变背景：逐行填充
    for y in range(s):
        t = y / s
        # 从亮红 #f0606a 渐变到深红 #c83838
        r0 = int(240 - (240 - 200) * t)
        g0 = int(96 - (96 - 56) * t)
        b0 = int(106 - (106 - 56) * t)
        d.line([(0, y), (s, y)], fill=(r0, g0, b0, 255))
    # 用圆角蒙版裁剪
    mask = Image.new("L", (s, s), 0)
    md = ImageDraw.Draw(mask)
    md.rounded_rectangle([0, 0, s - 1, s - 1], radius=r, fill=255)
    bg = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    bg.paste(img, (0, 0), mask)
    img = bg
    d = ImageDraw.Draw(img)

    # 2. 白色盾牌（多边形）
    cx = s / 2
    top = s * 0.20
    bottom = s * 0.82
    half = s * 0.27
    shield = [
        (cx, top),                 # 顶
        (cx + half, top + s * 0.06),  # 右上
        (cx + half, top + s * 0.36),  # 右中
        (cx, bottom),             # 底尖
        (cx - half, top + s * 0.36),
        (cx - half, top + s * 0.06),
    ]
    d.polygon(shield, fill=(255, 255, 255, 255))

    # 3. 盾牌内红色撤回箭头 ↺
    # 画一个环形弧 + 箭头头部
    arc_box = [cx - s * 0.135, top + s * 0.22, cx + s * 0.135, top + s * 0.49]
    red = (220, 70, 70, 255)
    lw = max(2, int(s * 0.045))
    d.arc(arc_box, start=30, end=330, fill=red, width=lw)
    # 箭头头部（小三角）
    # 弧末端约在 330°，即左下方
    a = math.radians(330)
    ex = cx + (s * 0.135) * math.cos(a)
    ey = (top + s * 0.355) + (s * 0.135) * math.sin(a)
    tri = [
        (ex, ey),
        (ex - s * 0.06, ey - s * 0.02),
        (ex - s * 0.02, ey + s * 0.07),
    ]
    d.polygon(tri, fill=red)

    return img


for sz in (16, 32, 48, 128):
    icon = draw_icon(sz)
    path = os.path.join(OUT_DIR, f"icon{sz}.png")
    icon.save(path, "PNG")
    print(f"已生成 {path} ({sz}x{sz})")

print("图标生成完成")
