"use strict";

// 圖書館（IDM）驗證碼辨識：純 JavaScript 推論，讀取 library-captcha-model.js 的權重。
// 與 eeclass 的 decaptcha.js 完全獨立，互不影響。
// 模型由 tools/library-captcha/train.py 訓練與匯出。
(function libraryCaptchaRuntime(globalScope) {
    const DIGITS = 4;

    function getModel() {
        const model = globalScope.LIBRARY_CAPTCHA_MODEL;
        if (!model || !Array.isArray(model.ops)) {
            throw new Error("library captcha model is not loaded");
        }
        return model;
    }

    // 與訓練時的前處理一致：灰階（ITU-R 601 亮度）-> 縮放到 W×H -> 正規化到 [-1, 1]
    function imageToTensor(image, width, height) {
        const canvas = globalScope.document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        context.imageSmoothingEnabled = true;
        context.drawImage(image, 0, 0, width, height);
        const rgba = context.getImageData(0, 0, width, height).data;
        const tensor = new Float32Array(width * height);
        for (let i = 0; i < width * height; i++) {
            const r = rgba[i * 4];
            const g = rgba[i * 4 + 1];
            const b = rgba[i * 4 + 2];
            const gray = (r * 299 + g * 587 + b * 114) / 1000 / 255;
            tensor[i] = (gray - 0.5) / 0.5;
        }
        return { data: tensor, c: 1, h: height, w: width };
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

    // 回傳 4 位數字字串；模型輸出形狀為 (10 類, 1, 4 位置)
    function predictDigits(image) {
        const model = getModel();
        const { width, height } = model.input;
        const output = forward(model, imageToTensor(image, width, height));
        if (output.c !== 10 || output.h !== 1 || output.w !== DIGITS) {
            throw new Error(`unexpected output shape ${output.c}x${output.h}x${output.w}`);
        }
        let answer = "";
        for (let pos = 0; pos < DIGITS; pos++) {
            let best = 0;
            for (let cls = 1; cls < 10; cls++) {
                if (output.data[cls * DIGITS + pos] > output.data[best * DIGITS + pos]) {
                    best = cls;
                }
            }
            answer += String(best);
        }
        return answer;
    }

    globalScope.LIBRARY_CAPTCHA = { predictDigits, imageToTensor, forward };
})(globalThis);
