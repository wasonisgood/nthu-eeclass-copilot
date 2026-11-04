"use strict";

// 驗證瀏覽器端的校務系統驗證碼推論（ccxp-captcha.js）與訓練時的標註答案一致。
// 測試資料：test/fixtures/ccxp-captcha-samples.json（由 Python 以 PIL 雙線性縮放到 128×48 後的 RGB 像素）。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

function loadScript(relativePath) {
    const source = fs.readFileSync(path.join(ROOT, relativePath), "utf8");
    vm.runInThisContext(source, { filename: relativePath });
}

loadScript("ccxp-captcha-model.js");
loadScript("ccxp-captcha.js");

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "ccxp-captcha-samples.json"), "utf8"));
const { width, height, samples } = fixture;
const model = globalThis.CCXP_CAPTCHA_MODEL;
const kit = globalThis.CCXP_CAPTCHA;

assert.ok(model && Array.isArray(model.ops), "CCXP_CAPTCHA_MODEL 應已載入");
assert.equal(model.input.width, width);
assert.equal(model.input.height, height);

// 與 imageToTensor 相同的正規化：RGB -> CHW，值為 (v/255 - 0.5) / 0.5
function rgbToTensor(rgb) {
    const plane = width * height;
    const data = new Float32Array(3 * plane);
    for (let i = 0; i < plane; i++) {
        for (let c = 0; c < 3; c++) {
            data[c * plane + i] = (rgb[i * 3 + c] / 255 - 0.5) / 0.5;
        }
    }
    return { data, c: 3, h: height, w: width };
}

let passed = 0;
for (const sample of samples) {
    const rgb = Buffer.from(sample.rgb_base64, "base64");
    assert.equal(rgb.length, width * height * 3, `${sample.name} 像素長度錯誤`);
    const output = kit.forward(model, rgbToTensor(rgb));
    const answer = kit.ctcGreedyDecode(output, model.output.classes, model.output.steps);
    assert.equal(answer, sample.label, `${sample.name} 預測 ${answer}，標註 ${sample.label}`);
    passed++;
}

console.log(`ccxp-captcha: ${passed}/${samples.length} 樣本與標註一致`);
