"""訓練校務資訊系統（CCXP）登入驗證碼辨識模型，並匯出成瀏覽器可執行的 JSON 與 JS。

用法：
  python train.py --holdout 0.2     # 切出驗證集，報告準確率
  python train.py --all             # 全部標註資料訓練，匯出最終模型

輸入：tools/ccxp-captcha/raw/*.png 與 labels.txt（每行「檔名 答案」，答案為 6 位數字）
輸出：tools/ccxp-captcha/model/ccxp-captcha-model.json
      ccxp-captcha-model.js（專案根目錄，擴充功能載入用）

模型只用 Conv / BatchNorm（匯出時融合進卷積）/ ReLU / MaxPool，
輸出為 CTC（blank=0，數字 0~9 對應類別 1~10），因此擴充功能可用純 JavaScript 重現推論。
驗證碼的字元位置不固定、帶有彩色干擾線與符號，所以用 CTC 而非固定位置分類頭。
"""
import argparse
import json
import math
import os
import random

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
RAW_DIR = os.path.join(HERE, "raw")
LABELS = os.path.join(HERE, "labels.txt")  # 每行：檔名 答案，例如 "0001 211929"
MODEL_DIR = os.path.join(HERE, "model")
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
MODEL_OUT = os.path.join(MODEL_DIR, "ccxp-captcha-model.json")

IN_W, IN_H = 128, 48
DIGITS = 6
NUM_CLASSES = 11  # 0 = CTC blank，1..10 = 數字 0..9
STEPS = IN_W // 4  # 寬度經兩次 2x 池化後為 32 個時間步


def load_dataset(labels):
    names = sorted(labels.keys())
    xs, ys = [], []
    for name in names:
        img = Image.open(os.path.join(RAW_DIR, f"{name}.png")).convert("RGB")
        img = img.resize((IN_W, IN_H), Image.BILINEAR)
        xs.append(np.asarray(img, dtype=np.float32).transpose(2, 0, 1) / 255.0)
        ys.append([int(c) + 1 for c in labels[name]])
    x = torch.tensor(np.stack(xs))  # (N, 3, H, W)
    return names, x, ys


def conv_bn(cin, cout, k=3, pad=1):
    return [nn.Conv2d(cin, cout, k, padding=pad, bias=False), nn.BatchNorm2d(cout), nn.ReLU(inplace=True)]


def build_model(base=32):
    b = base
    layers = []
    # 輸入 3x48x128（RGB）
    layers += conv_bn(3, b) + conv_bn(b, b) + [nn.MaxPool2d(2)]                  # b x 24 x 64
    layers += conv_bn(b, 2 * b) + conv_bn(2 * b, 2 * b) + [nn.MaxPool2d(2)]      # 2b x 12 x 32
    layers += conv_bn(2 * b, 4 * b) + conv_bn(4 * b, 4 * b) + [nn.MaxPool2d((2, 1))]  # 4b x 6 x 32
    layers += conv_bn(4 * b, 4 * b) + [nn.MaxPool2d((2, 1))]                     # 4b x 3 x 32
    layers += conv_bn(4 * b, 4 * b, k=(3, 3), pad=(0, 1))                        # 4b x 1 x 32
    layers += [nn.Conv2d(4 * b, NUM_CLASSES, 1)]                                 # 11 x 1 x 32
    return nn.Sequential(*layers)


def augment(x):
    b = x.shape[0]
    angle = (torch.rand(b) * 2 - 1) * math.radians(8)
    scale_x = 0.9 + torch.rand(b) * 0.2
    scale_y = scale_x * (0.9 + torch.rand(b) * 0.2)
    tx = (torch.rand(b) * 2 - 1) * 0.08
    ty = (torch.rand(b) * 2 - 1) * 0.12
    cos, sin = torch.cos(angle), torch.sin(angle)
    theta = torch.stack([
        torch.stack([cos / scale_x, -sin / scale_x, tx], dim=1),
        torch.stack([sin / scale_y, cos / scale_y, ty], dim=1),
    ], dim=1)
    grid = F.affine_grid(theta, x.shape, align_corners=False)
    out = F.grid_sample(x, grid, padding_mode="border", align_corners=False)
    # 隨機交換 RGB 通道：干擾線與數字的顏色不固定，讓模型不依賴顏色
    for i in range(b):
        if random.random() < 0.5:
            out[i] = out[i][torch.randperm(3)]
    contrast = 0.7 + torch.rand(b, 1, 1, 1) * 0.6
    bright = (torch.rand(b, 1, 1, 1) * 2 - 1) * 0.1
    out = (out - 0.5) * contrast + 0.5 + bright
    out = out + torch.randn_like(out) * 0.03
    return out.clamp(0, 1)


def normalize(x):
    return (x - 0.5) / 0.5


def forward_logits(model, x):
    """回傳形狀 (T, B, C) 的 logits，供 CTC 使用。"""
    out = model(x).squeeze(2)          # (B, C, T)
    return out.permute(2, 0, 1)        # (T, B, C)


def greedy_decode(logits_btc):
    """logits_btc: (B, T, C)。CTC 貪婪解碼：逐步取 argmax、合併重複、去除 blank。"""
    results = []
    best = logits_btc.argmax(-1)
    for seq in best.tolist():
        out, prev = [], 0
        for c in seq:
            if c != prev and c != 0:
                out.append(str(c - 1))
            prev = c
        results.append("".join(out))
    return results


def predict(model, x):
    model.eval()
    with torch.no_grad():
        logits = forward_logits(model, normalize(x))  # (T, B, C)
    return greedy_decode(logits.permute(1, 0, 2))


def train(model, x, ys, epochs, lr, seed):
    torch.manual_seed(seed)
    random.seed(seed)
    opt = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=1e-4)
    batch = 16
    steps_per_epoch = max(1, math.ceil(len(x) / batch))
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=lr, total_steps=epochs * steps_per_epoch)
    ctc = nn.CTCLoss(blank=0, zero_infinity=True)
    for epoch in range(epochs):
        model.train()
        perm = torch.randperm(len(x))
        total = 0.0
        for i in range(0, len(x), batch):
            idx = perm[i:i + batch].tolist()
            xb = normalize(augment(x[idx]))
            targets = torch.tensor([t for j in idx for t in ys[j]], dtype=torch.long)
            target_lengths = torch.tensor([len(ys[j]) for j in idx], dtype=torch.long)
            log_probs = F.log_softmax(forward_logits(model, xb), dim=-1)
            input_lengths = torch.full((len(idx),), log_probs.shape[0], dtype=torch.long)
            loss = ctc(log_probs, targets, input_lengths, target_lengths)
            opt.zero_grad()
            loss.backward()
            opt.step()
            sched.step()
            total += loss.item() * len(idx)
        if (epoch + 1) % 25 == 0:
            print(f"epoch {epoch + 1}/{epochs} loss {total / len(x):.4f}", flush=True)
    return model


def accuracy(model, x, ys):
    preds = predict(model, x)
    truth = ["".join(str(t - 1) for t in y) for y in ys]
    seq = float(np.mean([p == t for p, t in zip(preds, truth)]))
    digit = float(np.mean([sum(a == b for a, b in zip(p.ljust(DIGITS, "?"), t)) / DIGITS
                           for p, t in zip(preds, truth)]))
    return seq, digit


def export(model, path):
    model.eval()
    ops = []
    mods = list(model)
    i = 0
    while i < len(mods):
        m = mods[i]
        if isinstance(m, nn.Conv2d):
            w = m.weight.detach().clone()
            b = m.bias.detach().clone() if m.bias is not None else torch.zeros(m.out_channels)
            nxt = mods[i + 1] if i + 1 < len(mods) else None
            if isinstance(nxt, nn.BatchNorm2d):
                scale = nxt.weight.detach() / torch.sqrt(nxt.running_var + nxt.eps)
                w = w * scale.view(-1, 1, 1, 1)
                b = (b - nxt.running_mean) * scale + nxt.bias.detach()
                i += 1
            ops.append({
                "op": "conv",
                "out": m.out_channels,
                "in": m.in_channels,
                "kh": m.kernel_size[0],
                "kw": m.kernel_size[1],
                "padH": m.padding[0],
                "padW": m.padding[1],
                "weight": [round(v, 5) for v in w.reshape(-1).tolist()],
                "bias": [round(v, 5) for v in b.reshape(-1).tolist()],
            })
        elif isinstance(m, nn.ReLU):
            ops.append({"op": "relu"})
        elif isinstance(m, nn.MaxPool2d):
            k = m.kernel_size if isinstance(m.kernel_size, tuple) else (m.kernel_size, m.kernel_size)
            s = m.stride if isinstance(m.stride, tuple) else (m.stride, m.stride)
            ops.append({"op": "maxpool", "kh": k[0], "kw": k[1], "sh": s[0], "sw": s[1]})
        else:
            raise ValueError(f"unsupported layer {m}")
        i += 1
    doc = {
        "name": "nthu-ccxp-captcha",
        "input": {"width": IN_W, "height": IN_H, "channels": 3, "mean": 0.5, "std": 0.5},
        "digits": DIGITS,
        "output": {"classes": NUM_CLASSES, "blank": 0, "steps": STEPS},
        "ops": ops,
    }
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(doc, f)
    print("exported", path, os.path.getsize(path), "bytes")
    # 擴充功能載入用：與圖書館的 LIBRARY_CAPTCHA_MODEL、eeclass 的 decaptcha 分開的全域變數
    js_path = os.path.join(ROOT, "ccxp-captcha-model.js")
    with open(js_path, "w", encoding="utf-8") as f:
        f.write("// 由 tools/ccxp-captcha/train.py 產生，請勿手動編輯\n")
        f.write("globalThis.CCXP_CAPTCHA_MODEL = ")
        json.dump(doc, f)
        f.write(";\n")
    print("exported", js_path, os.path.getsize(js_path), "bytes")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--holdout", type=float, default=0.2)
    parser.add_argument("--all", action="store_true")
    parser.add_argument("--epochs", type=int, default=250)
    parser.add_argument("--lr", type=float, default=2e-3)
    parser.add_argument("--seed", type=int, default=1)
    args = parser.parse_args()

    labels = {}
    with open(LABELS, encoding="utf-8") as f:
        for line in f:
            parts = line.split()
            if len(parts) == 2 and len(parts[1]) == DIGITS and parts[1].isdigit():
                labels[parts[0]] = parts[1]
    names, x, ys = load_dataset(labels)
    print("labeled samples:", len(names))

    if args.all:
        model = train(build_model(), x, ys, args.epochs, args.lr, args.seed)
        seq, dig = accuracy(model, x, ys)
        print(f"train-set sequence acc {seq:.3f} digit acc {dig:.3f}")
        export(model, MODEL_OUT)
        return

    rng = np.random.default_rng(args.seed)
    order = rng.permutation(len(names))
    n_val = int(len(names) * args.holdout)
    val_idx, tr_idx = order[:n_val], order[n_val:]
    model = train(build_model(), x[tr_idx], [ys[i] for i in tr_idx], args.epochs, args.lr, args.seed)
    seq, dig = accuracy(model, x[val_idx], [ys[i] for i in val_idx])
    print(f"holdout n={n_val}: sequence acc {seq:.3f} digit acc {dig:.3f}")


if __name__ == "__main__":
    main()
