"use strict";

// 圖書館自動登入（半自動）：
// 1) https://www.lib.nthu.edu.tw/ 首頁若顯示「登入」，自動導向登入頁
// 2) https://idm.nthu.ust.edu.tw/ 登入頁若有已儲存的圖書館帳密，自動填入帳號與密碼；
//    驗證碼以 library-captcha.js（IDM 專用模型）辨識後自動送出，最多 3 次。
//    辨識失敗或次數用盡時，游標移到驗證碼欄位交給使用者輸入。
(function libraryAutologin(globalScope) {
    const LIB_HOST = "www.lib.nthu.edu.tw";
    const IDM_HOST = "idm.nthu.ust.edu.tw";
    const REDIRECT_KEY = "library_autologin_redirect_at";
    const REDIRECT_COOLDOWN_MS = 30000;
    const CAPTCHA_ATTEMPT_KEY = "library_autologin_captcha_attempts";
    // 自動送出的上限；先設為 1，避免錯誤重試造成帳號被鎖。確認流程正常後再調高。
    const MAX_CAPTCHA_ATTEMPTS = 1;
    const NOTICE_ID = "library-autologin-notice";

    function sessionGet(key) {
        try {
            return globalScope.sessionStorage.getItem(key);
        }
        catch {
            return null;
        }
    }

    function sessionSet(key, value) {
        try {
            globalScope.sessionStorage.setItem(key, String(value));
        }
        catch {
            // sessionStorage 不可用時略過防迴圈記錄
        }
    }

    function recentlyRedirected() {
        const at = Number(sessionGet(REDIRECT_KEY) || 0);
        return Date.now() - at < REDIRECT_COOLDOWN_MS;
    }

    function requestLibraryCredentials() {
        return new Promise((resolve) => {
            try {
                chrome.runtime.sendMessage({ action: "request_library_credentials" }, (resp) => {
                    if (chrome.runtime.lastError) {
                        resolve(null);
                        return;
                    }
                    resolve(resp?.status === "ok" ? resp.authConfig : null);
                });
            }
            catch {
                resolve(null);
            }
        });
    }

    // 用原生 value setter 寫入，避免被頁面框架包裝的 setter 覆蓋；並派送 input/change 事件
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

    // 寫入後確認欄位真的有值；頁面腳本若清空欄位會重試
    async function ensureFilled(input, value, tries = 8) {
        for (let i = 0; i < tries; i++) {
            if (input.value !== value) {
                setInputValue(input, value);
            }
            await new Promise((resolve) => setTimeout(resolve, 150));
            if (input.value === value) {
                return true;
            }
        }
        return input.value === value;
    }

    function showNotice(anchor, text) {
        const existing = document.getElementById(NOTICE_ID);
        if (existing) {
            existing.textContent = text;
            return;
        }
        const notice = document.createElement("div");
        notice.id = NOTICE_ID;
        notice.textContent = text;
        notice.style.cssText = "margin:8px 0;padding:8px 12px;border-radius:6px;" +
            "background:#eef6ff;border:1px solid #9cc3ff;color:#1d4f91;font-size:14px;";
        anchor.parentNode?.insertBefore(notice, anchor);
    }

    // 首頁：未登入（有「登入」連結）就導向登入頁
    function handleLibraryHome() {
        if (location.pathname !== "/" && location.pathname !== "/index.html") {
            return;
        }
        const loginLink = Array.from(document.querySelectorAll(".top-links a")).find((a) =>
            /登入/.test(a.textContent) && /primo|suprimaExtLogin|idm/i.test(a.getAttribute("href") || "")
        );
        if (!loginLink || recentlyRedirected()) {
            return;
        }
        sessionSet(REDIRECT_KEY, Date.now());
        location.href = loginLink.href;
    }

    // IDM 登入頁：自動填入帳號與密碼，驗證碼交給使用者
    async function handleIdmLogin() {
        const form = document.getElementById("form1");
        const userInput = document.getElementById("id_username");
        const passInput = document.getElementById("id_password");
        const captchaInput = document.getElementById("checkNum");
        if (!form || !userInput || !passInput || !captchaInput) {
            return;
        }

        const creds = await requestLibraryCredentials();
        if (!creds || creds.autoLogin === false) {
            return;
        }
        if (creds.locked) {
            showNotice(form, "圖書館帳密已加密，請先到 eeclass Copilot 設定頁解鎖自訂金鑰。");
            return;
        }
        if (!creds.id || !creds.password) {
            return;
        }

        const userOk = await ensureFilled(userInput, creds.id);
        const passOk = await ensureFilled(passInput, creds.password);
        console.info("[library-autologin] 帳號/密碼填入結果", { userOk, passOk });
        showNotice(form, `自動填入狀態：帳號${userOk ? "✓" : "✗"}　密碼${passOk ? "✓" : "✗"}`);
        if (!userOk || !passOk) {
            showNotice(form, `自動填入失敗（帳號${userOk ? "✓" : "✗"}　密碼${passOk ? "✓" : "✗"}），請手動輸入後按 Login。`);
            return;
        }

        // 本機辨識驗證碼（library-captcha.js，獨立於 eeclass 的 decaptcha）；失敗或次數用盡就交給使用者
        const captchaImage = document.getElementById("captcha_img");
        const attempts = Number(sessionGet(CAPTCHA_ATTEMPT_KEY) || 0);
        if (globalScope.LIBRARY_CAPTCHA && captchaImage && attempts < MAX_CAPTCHA_ATTEMPTS) {
            try {
                await waitForImage(captchaImage);
                const answer = globalScope.LIBRARY_CAPTCHA.predictDigits(captchaImage);
                if (/^\d{4}$/.test(answer)) {
                    sessionSet(CAPTCHA_ATTEMPT_KEY, attempts + 1);
                    setInputValue(captchaInput, answer);
                    showNotice(form, "已自動填入帳號、密碼與驗證碼，正在登入…");
                    if (typeof form.requestSubmit === "function") {
                        form.requestSubmit();
                    }
                    else {
                        form.submit();
                    }
                    return;
                }
            }
            catch {
                // 辨識失敗：退回手動輸入
            }
        }
        showNotice(form, "已自動填入圖書館帳密，請輸入下方驗證碼後按 Login。");
        captchaInput.focus();
    }

    function waitForImage(image, timeoutMs = 8000) {
        if (image.complete && image.naturalWidth > 0) {
            return Promise.resolve(image);
        }
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("captcha-timeout")), timeoutMs);
            image.addEventListener("load", () => {
                clearTimeout(timer);
                resolve(image);
            }, { once: true });
            image.addEventListener("error", () => {
                clearTimeout(timer);
                reject(new Error("captcha-load-failed"));
            }, { once: true });
        });
    }

    if (location.hostname === LIB_HOST) {
        handleLibraryHome();
    }
    else if (location.hostname === IDM_HOST) {
        handleIdmLogin();
    }
})(globalThis);
