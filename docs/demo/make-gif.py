"""Render docs/demo/demo.gif from the real output of docs/demo/demo.sh. Needs Pillow."""
import subprocess, re, sys
from PIL import Image, ImageDraw, ImageFont

FONT = "/usr/share/fonts/noto/NotoSansMono-Regular.ttf"
BG, FG, DIM, PROMPT, OK, ERR, BAR = "#0d1117", "#e6edf3", "#7d8590", "#7ee787", "#79c0ff", "#ffa198", "#161b22"
W, H, PAD, LH, FS = 880, 330, 22, 26, 17
font = ImageFont.truetype(FONT, FS)
out = subprocess.run(["sh", "docs/demo/demo.sh"], capture_output=True, text=True, check=True).stdout.splitlines()

script = []  # (kind, text)
script.append(("cmd", "sh docs/demo/demo.sh"))
for line in out:
    if line.startswith("$ "):
        script.append(("cmd", line[2:]))
    else:
        script.append(("err" if line.startswith("Argument") else "out", line))

def frame(lines, cursor=True):
    im = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(im)
    d.rectangle([0, 0, W, 34], fill=BAR)
    for i, c in enumerate(("#ff5f56", "#ffbd2e", "#27c93f")):
        d.ellipse([16 + i * 22, 11, 28 + i * 22, 23], fill=c)
    d.text((W // 2, 17), "acctmux: one endpoint, two accounts", font=font, fill=DIM, anchor="mm")
    y = 34 + PAD
    for kind, text in lines[-12:]:
        if kind == "cmd":
            d.text((PAD, y), "$", font=font, fill=PROMPT)
            d.text((PAD + 22, y), text, font=font, fill=FG)
        else:
            d.text((PAD, y), text, font=font, fill=ERR if kind == "err" else OK if text.startswith("{") else FG)
        y += LH
    if cursor:
        d.rectangle([PAD + 22 + (font.getlength(lines[-1][1]) if lines and lines[-1][0] == "cmd" else 0), y - LH + 3, PAD + 33 + (font.getlength(lines[-1][1]) if lines and lines[-1][0] == "cmd" else 0), y - 4], fill=FG)
    return im

frames, durs, shown = [], [], []
for kind, text in script:
    if kind == "cmd":
        step = max(1, len(text) // 14)
        for i in range(step, len(text) + step, step):
            frames.append(frame(shown + [("cmd", text[:i])])); durs.append(60)
        shown.append(("cmd", text))
        frames.append(frame(shown, cursor=False)); durs.append(450)
    else:
        shown.append((kind, text))
        frames.append(frame(shown, cursor=False)); durs.append(1100 if kind != "out" or text.startswith("profile") else 800)
durs[-1] = 4000
frames[0].save("docs/demo/demo.gif", save_all=True, append_images=frames[1:], duration=durs, loop=0, optimize=True)
print(len(frames), "frames")
