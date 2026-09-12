#!/usr/bin/env python3
"""生成 README / pi 包画廊用的动画 GIF（中英两版）。

一条循环演示三件事：发第一条消息就起名 → 新会话又是 zeth-ai → 聊别的项目标 @ymesh
→ 话题迁移改名、旧标题进括号。

跑法：python3 assets/make-demo-gif.py
输出：assets/demo.gif（英文）、assets/demo.zh.gif（中文）
"""
from PIL import Image, ImageDraw, ImageFont
import os

W, H = 900, 296
BG = (30, 30, 32)
TAB = (45, 45, 49)
TAB_ACTIVE = (30, 30, 32)
TAB_DIM = (58, 58, 62)
FG = (222, 222, 226)
DIM = (140, 140, 148)
ACCENT = (126, 196, 255)
GREEN = (140, 200, 140)

CJK = "/System/Library/Fonts/Hiragino Sans GB.ttc"
STEP_MS = 1100

L = {
    "en": {
        "out": "demo.gif",
        "title": "pi session titles that keep up with the work",
        "steps": [
            (["π - zeth-ai"], 0, "A new session — pi only knows the directory"),
            (["π - zeth payments"], 0, "You send the first message → named immediately"),
            (["π - zeth payments", "π - zeth-ai"], 1, "Another session: identical tab again"),
            (["π - zeth payments", "π - ymesh indexing@ymesh"], 1, "Talking about another repo → @ymesh"),
            (["π - zeth API timeout (zeth payments)", "π - ymesh indexing@ymesh"], 0, "Topic moved → renamed, old title kept in parens"),
            (["π - zeth API timeout (zeth payments)", "π - ymesh indexing@ymesh"], 0, "≤10 chars · only conclusions go to the model · previous titles never lost"),
        ],
    },
    "zh": {
        "out": "demo.zh.gif",
        "title": "pi 的会话标题，跟着你实际在做的事走",
        "steps": [
            (["π - zeth-ai"], 0, "新开会话 —— pi 只知道目录名"),
            (["π - zeth 支付修复"], 0, "你发出第一条消息 → 立刻起名"),
            (["π - zeth 支付修复", "π - zeth-ai"], 1, "再开一个会话：又是同一个标签"),
            (["π - zeth 支付修复", "π - ymesh 索引优化@ymesh"], 1, "聊的是别的项目 → 标出 @ymesh"),
            (["π - zeth API超时 (zeth 支付修复)", "π - ymesh 索引优化@ymesh"], 0, "话题迁移 → 改名，旧标题留在括号里"),
            (["π - zeth API超时 (zeth 支付修复)", "π - ymesh 索引优化@ymesh"], 0, "≤10 字符 · 只把结论喂给模型 · 旧标题永不丢"),
        ],
    },
}


def draw_frame(s, tabs, active, caption, fonts):
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    f_title, f_tab, f_cap = fonts["title"], fonts["tab"], fonts["cap"]

    d.text((36, 30), s["title"], font=f_title, fill=FG)

    y, th = 92, 46
    x = 36
    for i, text in enumerate(tabs):
        tw = d.textlength(text, font=f_tab) + 54
        is_active = i == active
        d.rounded_rectangle([x, y, x + tw, y + th], radius=8,
                            fill=TAB_ACTIVE if is_active else TAB)
        if is_active:
            d.rounded_rectangle([x, y, x + tw, y + 3], radius=0, fill=ACCENT)
        d.text((x + 20, y + 11), text, font=f_tab, fill=FG if is_active else DIM)
        cx = x + tw - 20
        d.line([cx - 5, y + 17, cx + 5, y + 29], fill=DIM, width=2)
        d.line([cx - 5, y + 29, cx + 5, y + 17], fill=DIM, width=2)
        x += tw + 6

    # 说明文字条（固定在底部，避免跳动）
    d.rounded_rectangle([36, H - 92, W - 36, H - 32], radius=10, fill=(37, 37, 40))
    d.text((58, H - 74), caption, font=f_cap, fill=GREEN)
    return img


for lang, s in L.items():
    fonts = {
        "title": ImageFont.truetype(CJK, 26, index=1),
        "tab": ImageFont.truetype(CJK, 22),
        "cap": ImageFont.truetype(CJK, 20, index=1),
    }
    frames = [draw_frame(s, tabs, active, cap, fonts) for tabs, active, cap in s["steps"]]
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), s["out"])
    frames[0].save(out, save_all=True, append_images=frames[1:], duration=STEP_MS, loop=0)
    size = os.path.getsize(out) // 1024
    print(f"已生成 {out}  {len(frames)} 帧  {size} KB")
