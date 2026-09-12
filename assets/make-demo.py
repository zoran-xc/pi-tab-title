#!/usr/bin/env python3
"""生成 README / pi 包画廊用的终端标签对比图（中英两版）。

跑法：python3 assets/make-demo.py
输出：assets/terminal-tabs.png（英文）、assets/terminal-tabs.zh.png（中文）
"""
from PIL import Image, ImageDraw, ImageFont
import os

W, H = 1680, 720
BG = (30, 30, 32)
PANEL = (37, 37, 40)
CHIP = (48, 48, 53)
TAB = (45, 45, 49)
TAB_ACTIVE = (30, 30, 32)
TAB_DIM = (58, 58, 62)
FG = (222, 222, 226)
DIM = (140, 140, 148)
ACCENT = (126, 196, 255)
WARN = (240, 180, 120)
GREEN = (140, 200, 140)

CJK = "/System/Library/Fonts/Hiragino Sans GB.ttc"
MONO = "/System/Library/Fonts/Menlo.ttc"

LANGS = {
    "en": {
        "out": "terminal-tabs.png",
        "title": "pi terminal tabs: before vs after",
        "subtitle": "pi-session-autoname · session titles that follow the actual work",
        "before": "Before — just the directory name; identical tabs look identical",
        "before_tabs": ["π - zeth-ai", "π - zeth-ai", "π - ymesh", "π - notes"],
        "before_note": "Two zeth-ai tabs: one fixing payments, one writing a plugin",
        "after": "After — project + what you're doing; previous titles kept in parens",
        "after_tabs": [
            "π - zeth payments (auth fix)",
            "π - ymesh indexing@ymesh",
            "π - promo post (payments → rename)",
        ],
        "after_note": "title ≤10 chars · @project only when you're not in that repo · parens = previous titles (old → new)",
        "cadence_lead": "Re-evaluates when:",
        "cadence": ["① first turn", "② back after 10+ min idle", "③ every 5 turns"],
        "fonts": {"head": (CJK, 40, 1), "sub": (CJK, 26, 1), "tab": (CJK, 26, 0),
                  "cap": (CJK, 22, 1), "mono": (MONO, 22, 0)},
    },
    "zh": {
        "out": "terminal-tabs.zh.png",
        "title": "pi 的终端标签：装插件前 vs 装插件后",
        "subtitle": "pi-session-autoname · session titles that follow the actual work",
        "before": "装上之前 —— 目录名而已，同名就看不出区别",
        "before_tabs": ["π - zeth-ai", "π - zeth-ai", "π - ymesh", "π - 笔记"],
        "before_note": "两个 zeth-ai：一个在修支付、一个在写插件，标签长得一模一样",
        "after": "装上之后 —— 项目 + 正在做的事，旧标题留在括号里",
        "after_tabs": [
            "π - zeth 支付修复 (zeth 登录排查)",
            "π - ymesh 索引优化@ymesh",
            "π - 插件发帖 (zeth 支付修复 → 插件改名)",
        ],
        "after_note": "标题 ≤10 字符；聊的不是当前目录才出现 @ymesh；括号里是之前用过的标题（旧 → 新）",
        "cadence_lead": "什么时候重新评估：",
        "cadence": ["① 首轮就起名", "② 离开超过 10 分钟再回来", "③ 连续聊满 5 轮"],
        "fonts": {"head": (CJK, 40, 1), "sub": (CJK, 26, 1), "tab": (CJK, 26, 0),
                  "cap": (CJK, 22, 1), "mono": (MONO, 22, 0)},
    },
}


def render(lang):
    s = LANGS[lang]
    fonts = {k: ImageFont.truetype(v[0], v[1], index=v[2]) for k, v in s["fonts"].items()}
    f_h1, f_h2, f_tab, f_cap, f_mono = (fonts["head"], fonts["sub"], fonts["tab"],
                                        fonts["cap"], fonts["mono"])

    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    d.text((56, 46), s["title"], font=f_h1, fill=FG)
    d.text((56, 104), s["subtitle"], font=f_cap, fill=DIM)

    def section(y, label, label_color, tabs, active=0, note=None):
        d.text((56, y), label, font=f_h2, fill=label_color)
        x, top, th = 56, y + 46, 56
        for i, text in enumerate(tabs):
            tw = d.textlength(text, font=f_tab) + 68
            is_active = i == active
            d.rounded_rectangle([x, top, x + tw, top + th], radius=10,
                                fill=TAB_ACTIVE if is_active else (TAB if label_color != WARN else TAB_DIM))
            if is_active:
                d.rounded_rectangle([x, top, x + tw, top + 3], radius=0, fill=ACCENT)
            d.text((x + 26, top + 15), text, font=f_tab, fill=FG if is_active else DIM)
            cx = x + tw - 24
            d.line([cx - 6, top + 21, cx + 6, top + 34], fill=DIM, width=2)
            d.line([cx - 6, top + 34, cx + 6, top + 21], fill=DIM, width=2)
            x += tw + 8
        if x > W - 56:
            print(f"  ⚠️  [{lang}] 标签总宽 {int(x)} 超过可用宽度 {W - 56}，右侧会被截断")
        if note:
            d.text((56, top + th + 18), note, font=f_cap, fill=DIM)
        return top + th + (56 if note else 24)

    y = section(170, s["before"], WARN, s["before_tabs"], active=3, note=s["before_note"])
    y = section(y + 40, s["after"], GREEN, s["after_tabs"], active=0, note=s["after_note"])

    cy, lead, x = y + 34, s["cadence_lead"], 56
    d.rounded_rectangle([56, cy, W - 56, cy + 62], radius=12, fill=PANEL)
    d.text((84, cy + 19), lead, font=f_cap, fill=DIM)
    x = 84 + d.textlength(lead, font=f_cap) + 6
    for c in s["cadence"]:
        cw = d.textlength(c, font=f_cap) + 36
        d.rounded_rectangle([x, cy + 12, x + cw, cy + 50], radius=8, fill=CHIP)
        d.text((x + 18, cy + 21), c, font=f_cap, fill=FG)
        x += cw + 12

    bar_y = H - 90
    d.rounded_rectangle([56, bar_y, W - 56, bar_y + 62], radius=12, fill=PANEL)
    d.text((84, bar_y + 19), "$", font=f_mono, fill=GREEN)
    d.text((116, bar_y + 17), "pi install git:github.com/zoran-xc/pi-session-autoname",
           font=f_mono, fill=FG)

    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), s["out"])
    img.save(out)
    print("已生成", out, img.size)


for lang in LANGS:
    render(lang)
