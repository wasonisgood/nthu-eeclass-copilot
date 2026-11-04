"use strict";

// 圖書館自動登入（半自動）：
// 1) https://www.lib.nthu.edu.tw/ 首頁若顯示「登入」，自動導向登入頁
// 2) https://idm.nthu.ust.edu.tw/ 登入頁若有已儲存的圖書館帳密，自動填入帳號與密碼；
//    驗證碼以 library-captcha.js（IDM 專用模型）辨識後自動送出；驗證碼錯誤時自動重試 1 次（同 eeclass）。
//    辨識失敗或次數用盡時，游標移到驗證碼欄位交給使用者輸入。
// 登入過程以卡片動畫顯示（風格同 eeclass 自動驗證），卡片取代登入表單的位置，原表單隱藏但保留在 DOM 中。
(function libraryAutologin(globalScope) {
    const LIB_HOST = "www.lib.nthu.edu.tw";
    const IDM_HOST = "idm.nthu.ust.edu.tw";
    const REDIRECT_KEY = "library_autologin_redirect_at";
    const REDIRECT_COOLDOWN_MS = 30000;
    // 與 eeclass（content.js 的 MAX_CAPTCHA_AUTO_RETRIES）一致：
    // 頁面出現驗證碼相關錯誤時自動重試，最多 1 次；頁面無錯誤時清除計數；非驗證碼錯誤不重試。
    const RETRY_KEY = "library_autologin_captcha_retry_count";
    const MAX_CAPTCHA_AUTO_RETRIES = 1;
    // 自動送出後記錄時間；若 60 秒內重新載入同一登入頁且偵測不到錯誤，視為送出失敗，不再自動送出（防止無限循環）
    const PENDING_KEY = "library_autologin_submit_pending_at";
    const PENDING_WINDOW_MS = 60000;
    const NOTICE_ID = "library-autologin-notice";
    const OVERLAY_ID = "library-autologin-overlay";
    const CARD_ID = "library-autologin-card";
    const STYLE_ID = "library-autologin-style";

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

    function sessionRemove(key) {
        try {
            globalScope.sessionStorage.removeItem(key);
        }
        catch {
            // sessionStorage 不可用時略過
        }
    }

    // 與 content.js 的 getPageErrorText 相同用途：收集頁面上的紅字錯誤訊息
    function getIdmPageErrorText() {
        // IDM 驗證碼錯誤實際是 <p class="text-danger-center">，所以用 [class*="text-danger"] 做子字串比對
        const selectors = "label[style*='color:red'], label[style*='color: red'], .errorlist, .errornote, .alert-danger, [class*='text-danger'], .error";
        const messages = [];
        document.querySelectorAll(selectors).forEach((el) => {
            const text = (el.textContent ?? "").trim();
            if (text !== "") {
                messages.push(text);
            }
        });
        return messages.join(" ");
    }

    function isCaptchaRelatedError(errorText) {
        return /驗證碼|captcha|security\s*code|verification/i.test(errorText);
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

    // ---- 登入動畫卡片（樣式沿用 content.js 的 eeclass 等待畫面：紫色上邊框、spinner、進度條、驗證碼 shimmer） ----

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
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft JhengHei", sans-serif;
            }
            #${CARD_ID} {
                width: 320px;
                max-width: calc(100vw - 32px);
                box-sizing: border-box;
                margin: 0;
                padding: 24px 22px 18px;
                background: #ffffff;
                border: 1px solid #dcdcdc;
                border-top: 3px solid #7f1084;
                border-radius: 6px;
                box-shadow: 0 6px 20px rgba(0, 0, 0, 0.07);
                text-align: center;
                color: #222222;
                font-family: inherit;
            }
            #${CARD_ID} .lib-autologin-title {
                margin: 0;
                font-size: 18px;
                font-weight: 700;
                letter-spacing: 0.02em;
                color: #222222;
            }
            #${CARD_ID} .lib-autologin-subtitle {
                margin: 4px 0 18px;
                font-size: 12px;
                color: #666666;
            }
            #${CARD_ID} .lib-autologin-spinner-wrap {
                display: flex;
                align-items: center;
                justify-content: center;
                margin: 6px 0 16px;
            }
            #${CARD_ID} .lib-autologin-spinner {
                width: 28px;
                height: 28px;
                border: 2.5px solid #ece3ee;
                border-top-color: #7f1084;
                border-radius: 50%;
                animation: lib-autologin-spin 0.75s linear infinite;
            }
            #${CARD_ID} .lib-autologin-status {
                margin: 0 0 6px;
                font-size: 14px;
                font-weight: 600;
                color: #7f1084;
            }
            #${CARD_ID} .lib-autologin-detail {
                margin: 0 0 14px;
                font-size: 12px;
                color: #666666;
                min-height: 18px;
            }
            #${CARD_ID} .lib-autologin-progress {
                width: 100%;
                height: 4px;
                background: #f0f0f0;
                border-radius: 2px;
                overflow: hidden;
                margin-bottom: 14px;
            }
            #${CARD_ID} .lib-autologin-progress-bar {
                height: 100%;
                width: 0;
                background: #7f1084;
                border-radius: 2px;
                transition: width 200ms ease;
            }
            #${CARD_ID} .lib-autologin-cancel {
                appearance: none;
                background: transparent;
                border: 1px solid #d0d0d0;
                border-radius: 4px;
                padding: 5px 12px;
                font-size: 12px;
                font-family: inherit;
                color: #555555;
                cursor: pointer;
                transition: border-color 120ms ease, color 120ms ease, background-color 120ms ease;
            }
            #${CARD_ID} .lib-autologin-cancel:hover {
                border-color: #7f1084;
                color: #7f1084;
                background-color: #faf6fb;
            }
            #checkNum[aria-busy="true"] {
                color: transparent !important;
                caret-color: transparent;
                border-color: #7f1084 !important;
                background:
                    linear-gradient(
                        100deg,
                        rgba(127, 16, 132, 0) 20%,
                        rgba(127, 16, 132, 0.08) 50%,
                        rgba(127, 16, 132, 0) 80%
                    ),
                    #faf8fb !important;
                background-size: 200% 100%, 100% 100%;
                animation: lib-autologin-shimmer 1s linear infinite;
            }
            @keyframes lib-autologin-spin {
                to { transform: rotate(360deg); }
            }
            @keyframes lib-autologin-shimmer {
                from { background-position: 180% 0, 0 0; }
                to { background-position: -20% 0, 0 0; }
            }
        `;
        (document.head ?? document.documentElement).append(style);
    }

    // 使用者按「切換為手動操作」後，後續自動步驟全部停止
    let userCancelled = false;
    let waitCard = null; // { overlay, card }

    // 全屏遮罩（規格同 content.js 的 eeclass 等待畫面：fixed inset 0、最高 z-index、白色 94% 底）
    function showWaitCard(form, status, detail, progress) {
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
                <h2 class="lib-autologin-title">國立清華大學圖書館</h2>
                <p class="lib-autologin-subtitle">System Login Service · 自動登入中</p>
                <div class="lib-autologin-spinner-wrap">
                    <div class="lib-autologin-spinner"></div>
                </div>
                <p class="lib-autologin-status"></p>
                <p class="lib-autologin-detail"></p>
                <div class="lib-autologin-progress">
                    <div class="lib-autologin-progress-bar"></div>
                </div>
                <button type="button" class="lib-autologin-cancel">切換為手動操作</button>
            `;
            card.querySelector(".lib-autologin-cancel").addEventListener("click", () => {
                userCancelled = true;
                hideWaitCard();
            });
            overlay.append(card);
            (document.body ?? document.documentElement).append(overlay);
            waitCard = { overlay, card };
        }
        waitCard.card.querySelector(".lib-autologin-status").textContent = status;
        waitCard.card.querySelector(".lib-autologin-detail").textContent = detail;
        waitCard.card.querySelector(".lib-autologin-progress-bar").style.width = `${progress}%`;
    }

    function hideWaitCard() {
        if (!waitCard) {
            return;
        }
        waitCard.overlay.remove();
        waitCard = null;
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

    // IDM 登入頁：自動填入帳號與密碼，驗證碼本機辨識後自動送出
    async function handleIdmLogin() {
        const form = document.getElementById("form1");
        // 頁面上 id="id_username" / "id_password" 同時有 <label> 與 <input>，getElementById 會拿到 <label>，
        // 必須用 input 元素本身查詢，否則值會寫到 label 上、表單欄位仍是空的。
        const userInput = form?.querySelector('input[name="username"]');
        const passInput = form?.querySelector('input[name="password"]');
        const captchaInput = form?.querySelector('input[name="captcha_value"]');
        if (!form || !userInput || !passInput || !captchaInput) {
            return;
        }

        // 頁面錯誤判斷與 eeclass 一致：無錯誤→清除計數；驗證碼錯誤→在上限內重試；其他錯誤→不自動送出
        const pendingAt = Number(sessionGet(PENDING_KEY) || 0);
        sessionRemove(PENDING_KEY);
        let pageError = getIdmPageErrorText();
        if (pageError === "" && pendingAt && Date.now() - pendingAt < PENDING_WINDOW_MS) {
            pageError = "登入未完成，驗證碼或帳密可能有誤";
        }
        const retryCount = pageError === "" ? 0 : Number(sessionGet(RETRY_KEY) || 0);
        if (pageError === "") {
            sessionRemove(RETRY_KEY);
        }
        else if (!isCaptchaRelatedError(pageError)) {
            showNotice(form, `登入失敗：${pageError}`);
            return;
        }
        else if (retryCount >= MAX_CAPTCHA_AUTO_RETRIES) {
            showNotice(form, "驗證碼錯誤，已達自動重試上限，請手動輸入驗證碼後按 Login。");
            return;
        }

        showWaitCard(
            form,
            pageError === "" ? "正在讀取已儲存的帳密…" : "驗證碼錯誤，正在自動重試…",
            pageError === "" ? "" : `重試 ${retryCount + 1}/${MAX_CAPTCHA_AUTO_RETRIES}`,
            20
        );
        const creds = await requestLibraryCredentials();
        if (!creds || creds.autoLogin === false) {
            hideWaitCard();
            return;
        }
        if (creds.locked) {
            hideWaitCard();
            showNotice(form, "圖書館帳密已加密，請先到 eeclass Copilot 設定頁解鎖自訂金鑰。");
            return;
        }
        if (!creds.id || !creds.password) {
            hideWaitCard();
            return;
        }

        showWaitCard(form, "正在填入帳號與密碼…", "", 40);
        const userOk = await ensureFilled(userInput, creds.id);
        const passOk = await ensureFilled(passInput, creds.password);
        console.info("[library-autologin] 帳號/密碼填入結果", { userOk, passOk });
        if (userCancelled) {
            return;
        }
        if (!userOk || !passOk) {
            hideWaitCard();
            showNotice(form, `自動填入失敗（帳號${userOk ? "✓" : "✗"}　密碼${passOk ? "✓" : "✗"}），請手動輸入後按 Login。`);
            return;
        }

        // 本機辨識驗證碼（library-captcha.js，獨立於 eeclass 的 decaptcha）；失敗或次數用盡就交給使用者
        const captchaImage = document.getElementById("captcha_img");
        if (globalScope.LIBRARY_CAPTCHA && captchaImage) {
            showWaitCard(form, "辨識驗證碼中…", "辨識完成後會自動送出登入", 65);
            captchaInput.setAttribute("aria-busy", "true");
            let answer = "";
            try {
                await waitForImage(captchaImage);
                answer = globalScope.LIBRARY_CAPTCHA.predictDigits(captchaImage);
            }
            catch {
                // 辨識失敗：退回手動輸入
            }
            finally {
                captchaInput.removeAttribute("aria-busy");
            }
            if (userCancelled) {
                return;
            }
            if (/^\d{4}$/.test(answer)) {
                if (pageError !== "") {
                    sessionSet(RETRY_KEY, retryCount + 1);
                }
                sessionSet(PENDING_KEY, Date.now());
                setInputValue(captchaInput, answer);
                showWaitCard(form, "驗證完成，正在登入圖書館…", "即將自動跳轉", 100);
                globalScope.setTimeout(() => {
                    if (userCancelled) {
                        return;
                    }
                    if (typeof form.requestSubmit === "function") {
                        form.requestSubmit();
                    }
                    else {
                        form.submit();
                    }
                }, 120);
                return;
            }
        }
        hideWaitCard();
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
