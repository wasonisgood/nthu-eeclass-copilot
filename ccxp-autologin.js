"use strict";

// 校務資訊系統登入頁（https://www.ccxp.nthu.edu.tw/ccxp/INQUIRE/）自動登入：
// 1) 帳號與密碼沿用 eeclass 已儲存的帳密（校務系統與 eeclass 共用同一組帳密）；若 eeclass 帳密被 PIN 鎖定、未儲存或關閉自動登入，則不動作
// 2) 驗證碼以 ccxp-captcha.js（CCXP 專用模型）本機辨識；辨識結果不是 6 位數字時不送出，交給使用者輸入
// 3) 驗證碼錯誤時自動重試 1 次（與 eeclass、圖書館一致）；其他錯誤或送出後偵測不到錯誤時不再自動送出，防止無限循環
(function ccxpAutologin(globalScope) {
    const PENDING_KEY = "ccxp_autologin_submit_pending_at";
    const PENDING_WINDOW_MS = 60000;
    const RETRY_KEY = "ccxp_autologin_captcha_retry_count";
    const MAX_CAPTCHA_AUTO_RETRIES = 1;
    const DIGITS = 6;
    const NOTICE_ID = "ccxp-autologin-notice";
    const OVERLAY_ID = "ccxp-autologin-overlay";
    const CARD_ID = "ccxp-autologin-card";
    const STYLE_ID = "ccxp-autologin-style";
    // 使用者按「切換為手動操作」後，後續自動步驟全部停止
    let userCancelled = false;
    let waitCard = null; // { overlay, card }

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

    function sessionRemove(key) {
        try {
            globalScope.sessionStorage.removeItem(key);
        }
        catch {
            // 略過
        }
    }

    function requestCcxpCredentials() {
        return new Promise((resolve) => {
            try {
                chrome.runtime.sendMessage({ action: "request_ccxp_credentials" }, (resp) => {
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

    function waitForImage(img) {
        return new Promise((resolve) => {
            if (img.complete && img.naturalWidth > 0) {
                resolve(true);
                return;
            }
            img.addEventListener("load", () => resolve(true), { once: true });
            img.addEventListener("error", () => resolve(false), { once: true });
            setTimeout(() => resolve(img.complete && img.naturalWidth > 0), 5000);
        });
    }

    // 收集表單內的紅字錯誤訊息（登入錯誤會顯示在 <b style="color:red">）
    function getPageErrorText(form) {
        const messages = [];
        form.querySelectorAll("b[style*='color:red'], b[style*='color: red'], font[color='red']").forEach((el) => {
            const text = (el.textContent ?? "").trim();
            if (text !== "") {
                messages.push(text);
            }
        });
        return messages.join(" ");
    }

    function isCaptchaRelatedError(errorText) {
        return /驗證碼|captcha/i.test(errorText);
    }

    function showNotice(form, text) {
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
        form.parentNode?.insertBefore(notice, form);
    }

    // ---- 全屏登入動畫卡片（樣式沿用圖書館版：白色 94% 遮罩、紫色頂框、spinner、進度條；配色取自校務系統的 #7F1084 按鈕） ----

    function ensureCardStyles() {
        if (document.getElementById(STYLE_ID)) {
            return;
        }
        const style = document.createElement("style");
        style.id = STYLE_ID;
        style.textContent = `
            #${OVERLAY_ID} {
                position: fixed;
                inset: 0;
                z-index: 2147483647;
                display: flex;
                align-items: center;
                justify-content: center;
                background-color: rgba(255, 255, 255, 0.94);
                font-family: "Microsoft JhengHei", "PingFang TC", -apple-system, sans-serif;
            }
            #${CARD_ID} {
                width: 320px;
                max-width: calc(100vw - 32px);
                box-sizing: border-box;
                padding: 24px 22px 18px;
                background: #ffffff;
                border: 1px solid #dcdcdc;
                border-top: 3px solid #7f1084;
                border-radius: 6px;
                box-shadow: 0 6px 20px rgba(0, 0, 0, 0.07);
                text-align: center;
                color: #222222;
            }
            #${CARD_ID} .ccxp-autologin-title {
                margin: 0;
                font-size: 18px;
                font-weight: 700;
                color: #222222;
            }
            #${CARD_ID} .ccxp-autologin-subtitle {
                margin: 4px 0 18px;
                font-size: 12px;
                color: #666666;
            }
            #${CARD_ID} .ccxp-autologin-spinner-wrap {
                display: flex;
                justify-content: center;
                margin: 6px 0 16px;
            }
            #${CARD_ID} .ccxp-autologin-spinner {
                width: 28px;
                height: 28px;
                border: 2.5px solid #ece3ee;
                border-top-color: #7f1084;
                border-radius: 50%;
                animation: ccxp-autologin-spin 0.75s linear infinite;
            }
            #${CARD_ID} .ccxp-autologin-status {
                margin: 0 0 6px;
                font-size: 14px;
                font-weight: 600;
                color: #7f1084;
            }
            #${CARD_ID} .ccxp-autologin-detail {
                margin: 0 0 14px;
                font-size: 12px;
                color: #666666;
                min-height: 18px;
            }
            #${CARD_ID} .ccxp-autologin-progress {
                width: 100%;
                height: 4px;
                background: #f0f0f0;
                border-radius: 2px;
                overflow: hidden;
                margin-bottom: 14px;
            }
            #${CARD_ID} .ccxp-autologin-progress-bar {
                height: 100%;
                width: 0;
                background: #7f1084;
                border-radius: 2px;
                transition: width 200ms ease;
            }
            #${CARD_ID} .ccxp-autologin-cancel {
                appearance: none;
                background: transparent;
                border: 1px solid #d0d0d0;
                border-radius: 4px;
                padding: 5px 12px;
                font-size: 12px;
                font-family: inherit;
                color: #555555;
                cursor: pointer;
            }
            #${CARD_ID} .ccxp-autologin-cancel:hover {
                border-color: #7f1084;
                color: #7f1084;
                background-color: #faf6fb;
            }
            @keyframes ccxp-autologin-spin {
                to { transform: rotate(360deg); }
            }
        `;
        (document.head ?? document.documentElement).append(style);
    }

    function showCard(status, detail, progress) {
        if (userCancelled) {
            return;
        }
        if (!waitCard) {
            ensureCardStyles();
            const overlay = document.createElement("div");
            overlay.id = OVERLAY_ID;
            overlay.setAttribute("role", "status");
            overlay.setAttribute("aria-live", "polite");
            const card = document.createElement("div");
            card.id = CARD_ID;
            card.innerHTML = `
                <h2 class="ccxp-autologin-title">國立清華大學 校務資訊系統</h2>
                <p class="ccxp-autologin-subtitle">自動登入中</p>
                <div class="ccxp-autologin-spinner-wrap">
                    <div class="ccxp-autologin-spinner"></div>
                </div>
                <p class="ccxp-autologin-status"></p>
                <p class="ccxp-autologin-detail"></p>
                <div class="ccxp-autologin-progress">
                    <div class="ccxp-autologin-progress-bar"></div>
                </div>
                <button type="button" class="ccxp-autologin-cancel">切換為手動操作</button>
            `;
            card.querySelector(".ccxp-autologin-cancel").addEventListener("click", () => {
                userCancelled = true;
                hideCard();
            });
            overlay.append(card);
            (document.body ?? document.documentElement).append(overlay);
            waitCard = { overlay, card };
        }
        waitCard.card.querySelector(".ccxp-autologin-status").textContent = status;
        waitCard.card.querySelector(".ccxp-autologin-detail").textContent = detail;
        waitCard.card.querySelector(".ccxp-autologin-progress-bar").style.width = `${progress}%`;
    }

    function hideCard() {
        if (!waitCard) {
            return;
        }
        waitCard.overlay.remove();
        waitCard = null;
    }

    // 需要使用者介入（辨識不確定、次數用盡、載入失敗）：收起遮罩，讓使用者能操作表單
    function handOverToUser(form, text, focusTarget) {
        hideCard();
        showNotice(form, text);
        focusTarget?.focus();
    }

    async function run() {
        const form = document.forms.form1 ?? document.querySelector("form[name='form1']");
        const accountInput = form?.querySelector("input[name='account']");
        const passInput = form?.querySelector("input[name='passwd']");
        const captchaInput = form?.querySelector("input[name='passwd2']");
        const captchaImage = form?.querySelector("img[src*='auth_img.php']");
        if (!form || !accountInput || !passInput || !captchaInput || !captchaImage) {
            return;
        }

        // 防循環與驗證碼重試判斷
        const pendingAt = Number(sessionGet(PENDING_KEY) || 0);
        if (pendingAt && Date.now() - pendingAt < PENDING_WINDOW_MS) {
            const errorText = getPageErrorText(form);
            if (!isCaptchaRelatedError(errorText)) {
                // 送出後沒有驗證碼錯誤（例如帳密錯誤或其他錯誤）：停止自動送出，交給使用者
                sessionRemove(PENDING_KEY);
                sessionRemove(RETRY_KEY);
                showNotice(form, errorText ? `自動登入已停止：${errorText}` : "自動登入已停止，請手動確認。");
                return;
            }
            const retries = Number(sessionGet(RETRY_KEY) || 0);
            if (retries >= MAX_CAPTCHA_AUTO_RETRIES) {
                sessionRemove(PENDING_KEY);
                sessionRemove(RETRY_KEY);
                showNotice(form, "驗證碼自動辨識重試次數已用盡，請手動輸入驗證碼。");
                captchaInput.focus();
                return;
            }
            sessionSet(RETRY_KEY, retries + 1);
        }
        else {
            // 頁面無錯誤或為新的登入流程：清除重試計數
            sessionRemove(RETRY_KEY);
        }
        sessionRemove(PENDING_KEY);

        if (!globalScope.CCXP_CAPTCHA || !globalScope.CCXP_CAPTCHA_MODEL) {
            return;
        }

        const authConfig = await requestCcxpCredentials();
        if (!authConfig || authConfig.autoLogin === false || !authConfig.id || !authConfig.password || authConfig.locked) {
            return;
        }

        showCard("正在自動登入…", "讀取已儲存的帳密", 10);
        await ensureFilled(accountInput, authConfig.id);
        await ensureFilled(passInput, authConfig.password);
        if (userCancelled) {
            return;
        }

        showCard("辨識驗證碼中…", "載入驗證碼圖片", 40);
        const loaded = await waitForImage(captchaImage);
        if (!loaded) {
            handOverToUser(form, "驗證碼載入失敗，請手動輸入。", captchaInput);
            return;
        }

        let answer = "";
        try {
            answer = globalScope.CCXP_CAPTCHA.predictDigits(captchaImage);
        }
        catch (error) {
            console.warn("[ccxp-autologin] captcha predict failed", error);
        }
        if (answer.length !== DIGITS) {
            handOverToUser(form, "驗證碼辨識不確定，請手動輸入後按登入。", captchaInput);
            return;
        }

        showCard("填入驗證碼…", `辨識結果 ${answer}`, 70);
        await ensureFilled(captchaInput, answer);
        if (captchaInput.value !== answer) {
            handOverToUser(form, "驗證碼欄位寫入失敗，請手動輸入。", captchaInput);
            return;
        }
        if (userCancelled) {
            return;
        }

        sessionSet(PENDING_KEY, Date.now());
        showCard("送出登入中…", "請稍候，頁面將自動跳轉", 95);
        form.requestSubmit();
    }

    run().catch((error) => {
        // 發生例外時一定要收起遮罩，避免擋住頁面讓使用者無法手動操作
        hideCard();
        console.warn("[ccxp-autologin] failed", error);
    });
})(globalThis);
