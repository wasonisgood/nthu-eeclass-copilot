"use strict";

// 清華通用驗證碼自動填入（所有 *.nthu.edu.tw / *.nthu.ust.edu.tw 子網域）。
// 規則：
// 1) 只在「登入表單」中作用：同一個 form（或整頁）內要有 input[type=password]。
// 2) 只辨識已知版型的驗證碼圖片（見 captcha-kit.js），未知版型不處理。
// 3) 只填「空白」或「仍是本模組自動填入的舊值」的欄位，不覆蓋使用者輸入。
// 4) 絕不送出表單；不需要儲存帳號密碼，手動輸入密碼時就會觸發。
// 5) 三個典型情境（校務系統登入頁、圖書館 IDM、校務 OAuth）由各自的專用腳本完整處理，這裡直接略過。
(function nthuCaptchaAutofill(globalScope) {
    const { document, location } = globalScope;
    if (!globalScope.NTHU_CAPTCHA_KIT || !document) {
        return;
    }

    function isTypicalScenarioPage() {
        const host = location.hostname.toLowerCase();
        const path = location.pathname;
        if (host === "www.ccxp.nthu.edu.tw" && /^\/ccxp\/INQUIRE\//i.test(path)) {
            return true;
        }
        return host === "idm.nthu.ust.edu.tw" || host === "oauth.ccxp.nthu.edu.tw";
    }

    if (isTypicalScenarioPage()) {
        return;
    }

    const CAPTCHA_FIELD_PATTERN = /captcha|passwd2|驗證碼|verif|security[_ -]?code/i;
    // 記錄每個圖片最近一次處理的 src，避免同一張圖重複辨識
    const handledSrcByImage = new WeakMap();
    // 記錄本模組自動填入的值，圖片刷新後若欄位仍是這個值就允許覆寫
    const autoFilledValueByField = new WeakMap();

    function isFillableTextInput(el) {
        const type = (el.type || "text").toLowerCase();
        return ["text", "number", "tel", ""].includes(type) && !el.disabled && !el.readOnly;
    }

    function findCaptchaField(scope, image) {
        const inputs = [...scope.querySelectorAll("input")].filter(isFillableTextInput);
        const named = inputs.find((el) => {
            const label = el.getAttribute("aria-label") ?? "";
            return CAPTCHA_FIELD_PATTERN.test(`${el.name} ${el.id} ${el.placeholder} ${label}`);
        });
        if (named) {
            return named;
        }
        // 沒有明確名稱時，取圖片之後（文件順序）的第一個文字欄位
        return inputs.find((el) => Boolean(image.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)) ?? null;
    }

    function setInputValue(input, value) {
        const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value");
        if (desc && typeof desc.set === "function") {
            desc.set.call(input, value);
        }
        else {
            input.value = value;
        }
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
    }

    async function tryFillImage(image) {
        const src = image.getAttribute("src") ?? "";
        if (src === "" || handledSrcByImage.get(image) === src) {
            return;
        }
        const form = image.closest("form");
        const scope = form ?? document;
        if (!scope.querySelector('input[type="password"]')) {
            return;
        }
        const field = findCaptchaField(scope, image);
        if (!field) {
            return;
        }
        const current = field.value.trim();
        const ownValue = autoFilledValueByField.get(field);
        if (current !== "" && current !== ownValue) {
            return;
        }
        handledSrcByImage.set(image, src);
        const result = await globalScope.NTHU_CAPTCHA_KIT.recognize(image);
        if (!result) {
            // 辨識失敗：清除紀錄，之後的密碼輸入事件會再試一次
            handledSrcByImage.delete(image);
            return;
        }
        // 辨識期間使用者可能已手動輸入或圖片已刷新，此時不再填
        const nowValue = field.value.trim();
        if ((nowValue !== "" && nowValue !== ownValue) || (image.getAttribute("src") ?? "") !== src) {
            return;
        }
        setInputValue(field, result.answer);
        autoFilledValueByField.set(field, result.answer);
    }

    function scanAll() {
        document.querySelectorAll("img").forEach((img) => {
            if (globalScope.NTHU_CAPTCHA_KIT.matchProfileId(img)) {
                tryFillImage(img).catch(() => {});
            }
        });
    }

    let scanTimer = null;
    function scheduleScan(delayMs = 300) {
        clearTimeout(scanTimer);
        scanTimer = setTimeout(scanAll, delayMs);
    }

    // 使用者開始輸入密碼（或瀏覽器自動帶入密碼）時觸發
    document.addEventListener("input", (event) => {
        if (event.target instanceof globalScope.HTMLInputElement && event.target.type === "password") {
            scheduleScan(200);
        }
    }, true);
    document.addEventListener("change", (event) => {
        if (event.target instanceof globalScope.HTMLInputElement && event.target.type === "password") {
            scheduleScan(200);
        }
    }, true);

    // 圖片載入完成（含驗證碼刷新）時觸發
    document.addEventListener("load", (event) => {
        if (event.target instanceof globalScope.HTMLImageElement) {
            scheduleScan(100);
        }
    }, true);

    // 動態插入的登入表單
    const observer = new MutationObserver(() => scheduleScan(400));
    observer.observe(document.documentElement, { childList: true, subtree: true });

    scheduleScan(500);
})(globalThis);
