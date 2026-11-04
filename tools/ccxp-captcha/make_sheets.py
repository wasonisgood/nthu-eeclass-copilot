"""把校務系統（CCXP）登入驗證碼排成放大拼圖，方便目視標註。

用法：python make_sheets.py <raw目錄> <輸出目錄> [每張拼圖的數量]
每張拼圖 3 欄，圖片放大 4 倍，左上角標示檔名編號。
"""
import os
import sys

from PIL import Image, ImageDraw

SCALE = 4
COLS = 3


def main():
    raw_dir, out_dir = sys.argv[1], sys.argv[2]
    per_sheet = int(sys.argv[3]) if len(sys.argv) > 3 else 12
    os.makedirs(out_dir, exist_ok=True)
    files = sorted(f for f in os.listdir(raw_dir) if f.endswith(".png"))
    for sheet_idx in range(0, len(files), per_sheet):
        chunk = files[sheet_idx:sheet_idx + per_sheet]
        cell_w, cell_h = 113 * SCALE + 12, 36 * SCALE + 26
        rows = (len(chunk) + COLS - 1) // COLS
        sheet = Image.new("RGB", (COLS * cell_w, rows * cell_h), "white")
        draw = ImageDraw.Draw(sheet)
        for i, name in enumerate(chunk):
            img = Image.open(os.path.join(raw_dir, name)).convert("RGB")
            img = img.resize((img.width * SCALE, img.height * SCALE), Image.LANCZOS)
            x = (i % COLS) * cell_w + 6
            y = (i // COLS) * cell_h + 20
            sheet.paste(img, (x, y))
            draw.text((x, y - 16), name.replace(".png", ""), fill="red")
        out_path = os.path.join(out_dir, f"sheet_{sheet_idx // per_sheet + 1:02d}.png")
        sheet.save(out_path)
        print(out_path, ",".join(n.replace(".png", "") for n in chunk))


if __name__ == "__main__":
    main()
