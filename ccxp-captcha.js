"use strict";

// 校務資訊系統（www.ccxp.nthu.edu.tw）登入驗證碼辨識：純 JavaScript 推論，讀取 ccxp-captcha-model.js 的權重。
// 與 eeclass 的 decaptcha.js、圖書館的 library-captcha.js 完全獨立，互不影響。
// 模型由 tools/ccxp-captcha/train.py 訓練與匯出；輸出為 CTC（blank=0，數字 0~9 對應類別 1~10），以貪婪解碼還原 6 位數字。
(function ccxpCaptchaRuntime(globalScope) {
    function getModel() {
        const model = globalScope.CCXP_CAPTCHA_MODEL;
        if (!model || !Array.isArray(model.ops)) {
            throw new Error("ccxp captcha model is not loaded");
        }
        return model;
    }

    // 與訓練時的前處理一致：RGB 三通道 -> 縮放到 W×H -> 正規化到 [-1, 1]，輸出為 CHW 排列
    function imageToTensor(image, width, height) {
        const canvas = globalScope.document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        context.imageSmoothingEnabled = true;
        context.drawImage(image, 0, 0, width, height);
        const rgba = context.getImageData(0, 0, width, height).data;
        const plane = width * height;
        const tensor = new Float32Array(3 * plane);
        for (let i = 0; i < plane; i++) {
            tensor[i] = (rgba[i * 4] / 255 - 0.5) / 0.5;
            tensor[plane + i] = (rgba[i * 4 + 1] / 255 - 0.5) / 0.5;
            tensor[2 * plane + i] = (rgba[i * 4 + 2] / 255 - 0.5) / 0.5;
        }
        return { data: tensor, c: 3, h: height, w: width };
    }

    function conv(input, op) {
        const { out, kh, kw, padH, padW, weight, bias } = op;
        const outH = input.h + 2 * padH - kh + 1;
        const outW = input.w + 2 * padW - kw + 1;
        const result = new Float32Array(out * outH * outW);
        for (let oc = 0; oc < out; oc++) {
            const b = bias[oc];
            for (let oy = 0; oy < outH; oy++) {
                for (let ox = 0; ox < outW; ox++) {
                    let sum = b;
                    for (let ic = 0; ic < input.c; ic++) {
                        for (let ky = 0; ky < kh; ky++) {
                            const iy = oy + ky - padH;
                            if (iy < 0 || iy >= input.h) {
                                continue;
                            }
                            for (let kx = 0; kx < kw; kx++) {
                                const ix = ox + kx - padW;
                                if (ix < 0 || ix >= input.w) {
                                    continue;
                                }
                                const wIndex = ((oc * input.c + ic) * kh + ky) * kw + kx;
                                sum += weight[wIndex] * input.data[(ic * input.h + iy) * input.w + ix];
                            }
                        }
                    }
                    result[(oc * outH + oy) * outW + ox] = sum;
                }
            }
        }
        return { data: result, c: out, h: outH, w: outW };
    }

    function relu(input) {
        const data = input.data;
        for (let i = 0; i < data.length; i++) {
            if (data[i] < 0) {
                data[i] = 0;
            }
        }
        return input;
    }

    function maxpool(input, op) {
        const { kh, kw, sh, sw } = op;
        const outH = Math.floor((input.h - kh) / sh) + 1;
        const outW = Math.floor((input.w - kw) / sw) + 1;
        const result = new Float32Array(input.c * outH * outW);
        for (let c = 0; c < input.c; c++) {
            for (let oy = 0; oy < outH; oy++) {
                for (let ox = 0; ox < outW; ox++) {
                    let best = -Infinity;
                    for (let ky = 0; ky < kh; ky++) {
                        for (let kx = 0; kx < kw; kx++) {
                            const v = input.data[(c * input.h + oy * sh + ky) * input.w + ox * sw + kx];
                            if (v > best) {
                                best = v;
                            }
                        }
                    }
                    result[(c * outH + oy) * outW + ox] = best;
                }
            }
        }
        return { data: result, c: input.c, h: outH, w: outW };
    }

    function forward(model, input) {
        let x = input;
        for (const op of model.ops) {
            if (op.op === "conv") {
                x = conv(x, op);
            }
            else if (op.op === "relu") {
                x = relu(x);
            }
            else if (op.op === "maxpool") {
                x = maxpool(x, op);
            }
            else {
                throw new Error(`unknown op ${op.op}`);
            }
        }
        return x;
    }

    // CTC 貪婪解碼：每個時間步取 argmax，合併連續相同類別，去除 blank
    function ctcGreedyDecode(output, classes, steps) {
        if (output.c !== classes || output.h !== 1 || output.w !== steps) {
            throw new Error(`unexpected output shape ${output.c}x${output.h}x${output.w}`);
        }
        let answer = "";
        let prev = 0;
        for (let t = 0; t < steps; t++) {
            let best = 0;
            let bestValue = -Infinity;
            for (let cls = 0; cls < classes; cls++) {
                const v = output.data[cls * steps + t];
                if (v > bestValue) {
                    bestValue = v;
                    best = cls;
                }
            }
            if (best !== prev && best !== 0) {
                answer += String(best - 1);
            }
            prev = best;
        }
        return answer;
    }

    // 回傳辨識出的數字字串（期望 6 位）；呼叫端應自行檢查長度，不足時不應自動送出
    function predictDigits(image) {
        const model = getModel();
        const { width, height } = model.input;
        const output = forward(model, imageToTensor(image, width, height));
        return ctcGreedyDecode(output, model.output.classes, model.output.steps);
    }

    globalScope.CCXP_CAPTCHA = { predictDigits, imageToTensor, forward, ctcGreedyDecode };
})(globalThis);
