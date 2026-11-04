"use strict";

(function bootstrapEeclassCaptchaAutofill(globalScope) {
    const STORAGE_KEY = "eeclassAuthConfig";
    const RETRY_SESSION_KEY = "eeclass_oauth_captcha_retry_count";
    const MAX_CAPTCHA_AUTO_RETRIES = 1;

    const CAPTCHA_BIND_ATTEMPT_LIMIT = 40;
    const CAPTCHA_BIND_RETRY_DELAY_MS = 250;
    const CAPTCHA_INPUT_SELECTOR = "input#captcha_code, input[name='captcha']";
    const CAPTCHA_IMAGE_SELECTOR = "img#captcha_image, img[src*='captchaimg.php'], img[alt='CAPTCHA Image']";

    const OVERLAY_STYLE_ID = "eeclass-oauth-waiting-style";
    const OVERLAY_ROOT_ID = "eeclass-oauth-waiting-overlay";

    const captchaAutofillStateByDocument = new WeakMap();
    const captchaAttachmentByDocument = new WeakMap();

    function isOauthAuthorizePage(targetDocument) {
        return (
            targetDocument.location.hostname.toLowerCase() === "oauth.ccxp.nthu.edu.tw" &&
            /\/v\d+(?:\.\d+)?\/authorize\.php$/i.test(targetDocument.location.pathname)
        );
    }

    function ensureWaitingStyles(targetDocument) {
        if (targetDocument.getElementById(OVERLAY_STYLE_ID)) {
            return;
        }
        const style = targetDocument.createElement("style");
        style.id = OVERLAY_STYLE_ID;
        style.textContent = `
            #${OVERLAY_ROOT_ID} {
                position: fixed;
                inset: 0;
                z-index: 2147483647;
                display: flex;
                align-items: center;
                justify-content: center;
                background-color: rgba(255, 255, 255, 0.94);
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft JhengHei", sans-serif;
                color: #222222;
                opacity: 1;
                transition: opacity 180ms ease;
            }
            #${OVERLAY_ROOT_ID}[data-hidden="true"] {
                opacity: 0;
                pointer-events: none;
            }
            .eeclass-wait-card {
                width: 320px;
                max-width: calc(100vw - 32px);
                background: #ffffff;
                border: 1px solid #dcdcdc;
                border-top: 3px solid #7f1084;
                border-radius: 6px;
                padding: 24px 22px 18px;
                box-shadow: 0 6px 20px rgba(0, 0, 0, 0.07);
                text-align: center;
                box-sizing: border-box;
            }
            .eeclass-wait-title {
                margin: 0;
                font-size: 18px;
                font-weight: 700;
                color: #222222;
                letter-spacing: 0.02em;
            }
            .eeclass-wait-subtitle {
                margin: 4px 0 18px;
                font-size: 12px;
                color: #666666;
            }
            .eeclass-wait-spinner-wrap {
                display: flex;
                align-items: center;
                justify-content: center;
                margin: 6px 0 16px;
            }
            .eeclass-wait-spinner {
                width: 28px;
                height: 28px;
                border: 2.5px solid #ece3ee;
                border-top-color: #7f1084;
                border-radius: 50%;
                animation: eeclass-wait-spin 0.75s linear infinite;
            }
            .eeclass-wait-status {
                margin: 0 0 6px;
                font-size: 14px;
                font-weight: 600;
                color: #7f1084;
            }
            .eeclass-wait-detail {
                margin: 0 0 14px;
                font-size: 12px;
                color: #666666;
                min-height: 18px;
            }
            .eeclass-wait-progress {
                width: 100%;
                height: 4px;
                background: #f0f0f0;
                border-radius: 2px;
                overflow: hidden;
                margin-bottom: 14px;
            }
            .eeclass-wait-progress-bar {
                height: 100%;
                width: 35%;
                background: #7f1084;
                border-radius: 2px;
                transition: width 200ms ease, background-color 200ms ease;
            }
            .eeclass-wait-pin-box {
                display: flex;
                gap: 6px;
                margin-bottom: 12px;
            }
            .eeclass-wait-pin-box[hidden] {
                display: none !important;
            }
            .eeclass-wait-pin-input {
                flex: 1;
                padding: 5px 8px;
                font-size: 12.5px;
                border: 1px solid #d0d7de;
                border-radius: 4px;
                outline: none;
            }
            .eeclass-wait-pin-input:focus {
                border-color: #7f1084;
            }
            .eeclass-wait-pin-btn {
                padding: 5px 10px;
                font-size: 12px;
                font-weight: 600;
                color: #ffffff;
                background-color: #7f1084;
                border: 1px solid #7f1084;
                border-radius: 4px;
                cursor: pointer;
            }
            .eeclass-wait-cancel {
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
            .eeclass-wait-cancel:hover {
                border-color: #7f1084;
                color: #7f1084;
                background-color: #faf6fb;
            }
            input#captcha_code[aria-busy="true"],
            input[name="captcha"][aria-busy="true"] {
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
                animation: eeclass-captcha-shimmer 1s linear infinite;
            }
            @keyframes eeclass-wait-spin {
                to { transform: rotate(360deg); }
            }
            @keyframes eeclass-captcha-shimmer {
                from { background-position: 180% 0, 0 0; }
                to { background-position: -20% 0, 0 0; }
            }
        `;
        (targetDocument.head ?? targetDocument.documentElement)?.append(style);
    }

    function showWaitingOverlay(targetDocument, statusText, detailText, progressPercent = 40, options = {}) {
        ensureWaitingStyles(targetDocument);
        let overlay = targetDocument.getElementById(OVERLAY_ROOT_ID);
        if (overlay?.dataset.userCancelled === "true") {
            return;
        }
        if (!overlay) {
            overlay = targetDocument.createElement("div");
            overlay.id = OVERLAY_ROOT_ID;
            overlay.setAttribute("role", "status");
            overlay.setAttribute("aria-live", "polite");
            overlay.innerHTML = `
                <div class="eeclass-wait-card">
                    <h2 class="eeclass-wait-title">eeclass 數位學習平台</h2>
                    <p class="eeclass-wait-subtitle">清華大學校務資訊系統自動驗證中</p>
                    <div class="eeclass-wait-spinner-wrap">
                        <div class="eeclass-wait-spinner"></div>
                    </div>
                    <p class="eeclass-wait-status"></p>
                    <p class="eeclass-wait-detail"></p>
                    <div class="eeclass-wait-pin-box" hidden>
                        <input type="password" class="eeclass-wait-pin-input" placeholder="請輸入解鎖主密碼 / PIN">
                        <button type="button" class="eeclass-wait-pin-btn">解鎖登入</button>
                    </div>
                    <div class="eeclass-wait-progress">
                        <div class="eeclass-wait-progress-bar"></div>
                    </div>
                    <button type="button" class="eeclass-wait-cancel">切換為手動操作</button>
                </div>
            `;
            const cancelBtn = overlay.querySelector(".eeclass-wait-cancel");
            cancelBtn?.addEventListener("click", () => {
                overlay.dataset.userCancelled = "true";
                hideWaitingOverlay(targetDocument, true);
                if (typeof options.onCancel === "function") {
                    options.onCancel();
                }
            });
            (targetDocument.body ?? targetDocument.documentElement)?.append(overlay);
        }
        overlay.removeAttribute("data-hidden");
        const statusEl = overlay.querySelector(".eeclass-wait-status");
        const detailEl = overlay.querySelector(".eeclass-wait-detail");
        const progressBar = overlay.querySelector(".eeclass-wait-progress-bar");
        const pinBox = overlay.querySelector(".eeclass-wait-pin-box");
        const pinInput = overlay.querySelector(".eeclass-wait-pin-input");
        const pinBtn = overlay.querySelector(".eeclass-wait-pin-btn");

        if (statusEl && statusText) {
            statusEl.textContent = statusText;
        }
        if (detailEl && detailText !== undefined) {
            detailEl.textContent = detailText;
        }
        if (progressBar && typeof progressPercent === "number") {
            progressBar.style.width = `${Math.min(100, Math.max(10, progressPercent))}%`;
        }
        if (pinBox) {
            pinBox.hidden = !options.requirePin;
            if (options.requirePin && pinInput && pinBtn) {
                pinBtn.onclick = () => {
                    if (typeof options.onPinSubmit === "function") {
                        options.onPinSubmit(pinInput.value);
                    }
                };
                pinInput.onkeydown = (ev) => {
                    if (ev.key === "Enter") {
                        ev.preventDefault();
                        pinBtn.click();
                    }
                };
                globalScope.setTimeout(() => pinInput.focus(), 50);
            }
        }
    }

    function hideWaitingOverlay(targetDocument, immediate = false) {
        const overlay = targetDocument.getElementById(OVERLAY_ROOT_ID);
        if (!overlay) {
            return;
        }
        overlay.dataset.hidden = "true";
        const delay = immediate ? 0 : 200;
        globalScope.setTimeout(() => {
            if (overlay.dataset.hidden === "true") {
                overlay.remove();
            }
        }, delay);
    }

    function isExtensionValid() {
        try {
            return Boolean(typeof chrome !== "undefined" && chrome?.runtime && Boolean(chrome.runtime.id));
        }
        catch {
            return false;
        }
    }

    function requestDecryptedCredentials(pin = "") {
        return new Promise((resolve) => {
            if (!isExtensionValid() || !chrome.runtime?.sendMessage) {
                resolve({});
                return;
            }
            try {
                chrome.runtime.sendMessage(
                    { action: "request_oauth_credentials", pin },
                    (response) => {
                        if (chrome.runtime.lastError || response?.status !== "ok") {
                            resolve({});
                            return;
                        }
                        resolve(response.authConfig ?? {});
                    }
                );
            }
            catch {
                resolve({});
            }
        });
    }

    function getPageErrorText(targetDocument) {
        const errorLabels = targetDocument.querySelectorAll("label[style*='color:red'], label[style*='color: red']");
        const messages = [];
        for (const label of errorLabels) {
            const text = (label.textContent ?? "").trim();
            if (text !== "") {
                messages.push(text);
            }
        }
        return messages.join(" ");
    }

    function isCaptchaRelatedError(errorText) {
        if (!errorText) {
            return false;
        }
        return /驗證碼|captcha|security\s*code/i.test(errorText);
    }

    function setInputValue(input, value) {
        if (!input || typeof value !== "string") {
            return;
        }
        if (input.value !== value) {
            input.value = value;
            if (typeof input.setCustomValidity === "function") {
                input.setCustomValidity("");
            }
            input.dispatchEvent(new Event("input", { bubbles: true }));
            input.dispatchEvent(new Event("change", { bubbles: true }));
        }
    }

    function applyStoredCredentialsToForm(targetDocument, form, config) {
        if (!form || !config) {
            return false;
        }
        const idInput = form.querySelector("input#id, input[name='id']");
        const passwordInput = form.querySelector("input#password, input[name='password']");
        const crossSchoolCheckbox = form.querySelector("input#cross-school, input[name='cross-school']");
        const schoolSelect = form.querySelector("select#school, select[name='school']");
        const cidInput = form.querySelector("input[name='cid']");
        const keepCheckbox = form.querySelector("input[name='keep'][type='checkbox']");

        if (keepCheckbox && typeof config.keep === "boolean" && keepCheckbox.checked !== config.keep) {
            keepCheckbox.checked = config.keep;
            keepCheckbox.dispatchEvent(new Event("change", { bubbles: true }));
        }

        if (crossSchoolCheckbox && typeof config.crossSchool === "boolean") {
            if (crossSchoolCheckbox.checked !== config.crossSchool) {
                crossSchoolCheckbox.checked = config.crossSchool;
                crossSchoolCheckbox.dispatchEvent(new Event("change", { bubbles: true }));
            }
            if (config.crossSchool) {
                if (schoolSelect && config.school) {
                    schoolSelect.value = config.school;
                    schoolSelect.dispatchEvent(new Event("change", { bubbles: true }));
                }
                if (cidInput && config.cid) {
                    setInputValue(cidInput, config.cid);
                }
            }
        }

        if (idInput && config.id) {
            setInputValue(idInput, config.id);
        }
        if (passwordInput && config.password) {
            setInputValue(passwordInput, config.password);
        }

        const hasId = Boolean(idInput && idInput.value.trim() !== "");
        const hasPassword = Boolean(passwordInput && passwordInput.value !== "");
        if (crossSchoolCheckbox?.checked) {
            const hasSchool = Boolean(schoolSelect && schoolSelect.value !== "");
            const hasCid = Boolean(cidInput && cidInput.value.trim() !== "");
            return hasId && hasPassword && hasSchool && hasCid;
        }
        return hasId && hasPassword;
    }

    function canAutoSubmitOnCurrentPage(targetDocument) {
        const errorText = getPageErrorText(targetDocument);
        if (errorText === "") {
            try {
                globalScope.sessionStorage?.removeItem(RETRY_SESSION_KEY);
            }
            catch {
                // Ignore sessionStorage errors
            }
            return true;
        }
        if (!isCaptchaRelatedError(errorText)) {
            return false;
        }
        try {
            const retryCount = Number.parseInt(globalScope.sessionStorage?.getItem(RETRY_SESSION_KEY) ?? "0", 10) || 0;
            if (retryCount >= MAX_CAPTCHA_AUTO_RETRIES) {
                return false;
            }
            globalScope.sessionStorage?.setItem(RETRY_SESSION_KEY, String(retryCount + 1));
            return true;
        }
        catch {
            return false;
        }
    }

    function submitOauthLoginForm(targetDocument, form) {
        const overlay = targetDocument.getElementById(OVERLAY_ROOT_ID);
        if (overlay?.dataset.userCancelled === "true") {
            return;
        }
        if (!form || form.dataset.eeclassAutoSubmitted === "true") {
            return;
        }
        form.dataset.eeclassAutoSubmitted = "true";

        showWaitingOverlay(
            targetDocument,
            "驗證完成，正在登入系統...",
            "即將自動跳轉至 eeclass 數位學習平台",
            100,
            {
                onCancel: () => {
                    delete form.dataset.eeclassAutoSubmitted;
                },
            }
        );

        const submitButton =
            form.querySelector("button.btn-login[type='submit'][name='action'][value='login']") ??
            form.querySelector("button[type='submit'], input[type='submit']");

        globalScope.setTimeout(() => {
            if (targetDocument.getElementById(OVERLAY_ROOT_ID)?.dataset.userCancelled === "true") {
                return;
            }
            if (typeof form.requestSubmit === "function") {
                if (submitButton) {
                    form.requestSubmit(submitButton);
                }
                else {
                    form.requestSubmit();
                }
            }
            else if (submitButton && typeof submitButton.click === "function") {
                submitButton.click();
            }
            else {
                form.submit();
            }
        }, 120);
    }

    async function maybeFillCredentialsAndSubmit(targetDocument, state, options = {}) {
        const form = state?.input?.form;
        if (!form) {
            hideWaitingOverlay(targetDocument);
            return;
        }
        const config = await requestDecryptedCredentials(options.pin ?? "");

        if (config.locked) {
            if (config.id) {
                const idInput = form.querySelector("input#id, input[name='id']");
                if (idInput) {
                    setInputValue(idInput, config.id);
                }
            }
            showWaitingOverlay(
                targetDocument,
                "加密金庫尚未解鎖",
                config.decryptError ? "主密碼錯誤，請重新輸入" : "此帳號已啟用主密碼 (PBKDF2) 加密保護",
                70,
                {
                    requirePin: true,
                    onPinSubmit: (enteredPin) => {
                        maybeFillCredentialsAndSubmit(targetDocument, state, {
                            ...options,
                            pin: enteredPin,
                        });
                    },
                }
            );
            return;
        }

        const credentialsReady = applyStoredCredentialsToForm(targetDocument, form, config);
        const captchaValue = (state.input?.value ?? "").trim();
        const captchaReady = /^\d{4}$/.test(captchaValue);

        if (!credentialsReady || !captchaReady || config.autoLogin === false) {
            showWaitingOverlay(
                targetDocument,
                "已完成驗證碼自動填充",
                captchaReady ? `辨識結果：${captchaValue}` : "請確認欄位後登入",
                100
            );
            globalScope.setTimeout(() => {
                hideWaitingOverlay(targetDocument);
            }, 260);
            return;
        }
        if (!options.ignoreErrorCheck && !canAutoSubmitOnCurrentPage(targetDocument)) {
            hideWaitingOverlay(targetDocument, true);
            return;
        }
        submitOauthLoginForm(targetDocument, form);
    }

    function resolveCaptchaField(rootNode) {
        const input = rootNode.querySelector(CAPTCHA_INPUT_SELECTOR);
        if (!input) {
            return undefined;
        }
        const scope = input.closest("form") ?? rootNode;
        const image = scope.querySelector(CAPTCHA_IMAGE_SELECTOR) ?? rootNode.querySelector(CAPTCHA_IMAGE_SELECTOR);
        const mediaRow = image?.parentElement;
        if (!image || !mediaRow) {
            return undefined;
        }
        return {
            input,
            image,
            mediaRow,
            scope,
        };
    }

    function getCaptchaRequestSource(captchaImage, targetDocument) {
        const rawSource = (captchaImage?.getAttribute("src") ?? "").trim();
        if (rawSource === "") {
            return "";
        }
        try {
            return new URL(rawSource, targetDocument.location.href).toString();
        }
        catch {
            return rawSource;
        }
    }

    async function waitForCaptchaImageLoad(image) {
        if (image.complete && image.naturalWidth > 0 && image.naturalHeight > 0) {
            return image;
        }
        await new Promise((resolve, reject) => {
            const cleanup = () => {
                image.removeEventListener("load", handleLoad);
                image.removeEventListener("error", handleError);
            };
            const handleLoad = () => {
                cleanup();
                resolve();
            };
            const handleError = () => {
                cleanup();
                reject(new Error("captcha-image-load-failed"));
            };
            image.addEventListener("load", handleLoad, { once: true });
            image.addEventListener("error", handleError, { once: true });
        });
        if (image.naturalWidth <= 0 || image.naturalHeight <= 0) {
            throw new Error("captcha-image-size-unavailable");
        }
        return image;
    }

    async function predictCaptchaFromImage(image) {
        const predictor = globalScope.EECLASS_DECAPTCHA ?? globalScope.CCXP_LITE?.oauthDecaptcha;
        if (!predictor || typeof predictor.predictDigits !== "function") {
            return "";
        }
        const loadedImage = await waitForCaptchaImageLoad(image);
        const answer = await predictor.predictDigits(loadedImage);
        return answer.trim();
    }

    async function requestCaptchaAnswerForCurrentImage(state, captchaSrc) {
        if (state.cachedSrc === captchaSrc && state.cachedAnswer !== "") {
            return state.cachedAnswer;
        }
        if (state.pendingSrc === captchaSrc && state.pendingRequest !== undefined) {
            return await state.pendingRequest;
        }
        const request = predictCaptchaFromImage(state.image)
            .then((answer) => {
                if (answer !== "") {
                    state.cachedSrc = captchaSrc;
                    state.cachedAnswer = answer;
                }
                return answer;
            })
            .finally(() => {
                if (state.pendingSrc === captchaSrc) {
                    state.pendingSrc = "";
                    state.pendingRequest = undefined;
                }
            });
        state.pendingSrc = captchaSrc;
        state.pendingRequest = request;
        return await request;
    }

    function setCaptchaLoadingState(state, isLoading) {
        if (!state?.input) {
            return;
        }
        state.input.setAttribute("aria-busy", isLoading ? "true" : "false");
    }

    function fallbackToManualCaptchaEntry(targetDocument, state, captchaSrc) {
        if (!state) {
            return;
        }
        state.lastRequestedSrc = "";
        state.failedSrc = captchaSrc;
        state.requestToken++;
        setCaptchaLoadingState(state, false);
        state.input.removeAttribute("aria-busy");
        hideWaitingOverlay(targetDocument, true);
    }

    function autofillCaptchaInput(targetDocument, captchaImage, state) {
        ensureWaitingStyles(targetDocument);

        const pageError = getPageErrorText(targetDocument);
        const shouldShowOverlay = pageError === "" || isCaptchaRelatedError(pageError);

        if (shouldShowOverlay) {
            showWaitingOverlay(
                targetDocument,
                "正在辨識驗證碼並解密登入資訊...",
                "正在讀取驗證碼影像與加密憑證",
                45
            );
        }

        if (state?.input?.form) {
            requestDecryptedCredentials().then((config) => {
                if (!config.locked) {
                    applyStoredCredentialsToForm(targetDocument, state.input.form, config);
                }
            });
        }

        const captchaSrc = getCaptchaRequestSource(captchaImage, targetDocument);
        if (captchaSrc === "" || state.lastRequestedSrc === captchaSrc || state.failedSrc === captchaSrc) {
            return;
        }
        state.lastRequestedSrc = captchaSrc;
        state.requestToken++;
        const { requestToken } = state;
        setCaptchaLoadingState(state, true);

        requestCaptchaAnswerForCurrentImage(state, captchaSrc)
            .then(async (answer) => {
                if (requestToken !== state.requestToken || answer === "") {
                    hideWaitingOverlay(targetDocument);
                    return;
                }
                const resolvedInput = state.input;
                setInputValue(resolvedInput, answer);
                state.failedSrc = "";
                setCaptchaLoadingState(state, false);

                if (shouldShowOverlay) {
                    showWaitingOverlay(
                        targetDocument,
                        "正在填入驗證碼與帳號資訊...",
                        `驗證碼辨識完成 (${answer})`,
                        80
                    );
                }
                await maybeFillCredentialsAndSubmit(targetDocument, state);
            })
            .catch(() => {
                if (requestToken === state.requestToken) {
                    fallbackToManualCaptchaEntry(targetDocument, state, captchaSrc);
                }
            });
    }

    function primeCaptchaAutofill(targetDocument, state) {
        if (!state) {
            return;
        }
        const captchaSrc = getCaptchaRequestSource(state.image, targetDocument);
        if (captchaSrc === "") {
            return;
        }
        setCaptchaLoadingState(state, true);
        requestCaptchaAnswerForCurrentImage(state, captchaSrc).catch(() => {
            fallbackToManualCaptchaEntry(targetDocument, state, captchaSrc);
        });
    }

    function syncCaptchaAutofillState(targetDocument, state, rootNode) {
        const previousImage = state.image;
        const latestField = resolveCaptchaField(rootNode);
        if (!latestField) {
            return state;
        }
        state.input = latestField.input;
        state.image = latestField.image;
        state.mediaRow = latestField.mediaRow;
        state.scope = latestField.scope;
        if (state.image !== previousImage) {
            state.image.addEventListener("load", () => {
                autofillCaptchaInput(targetDocument, state.image, state);
            });
        }
        return state;
    }

    function getOrCreateCaptchaState(targetDocument, rootNode) {
        const existingState = captchaAutofillStateByDocument.get(targetDocument);
        if (existingState) {
            syncCaptchaAutofillState(targetDocument, existingState, rootNode);
            return existingState;
        }
        const captchaField = resolveCaptchaField(rootNode);
        if (!captchaField) {
            return undefined;
        }
        const state = {
            ...captchaField,
            lastRequestedSrc: "",
            requestToken: 0,
            pendingRequest: undefined,
            pendingSrc: "",
            failedSrc: "",
            cachedAnswer: "",
            cachedSrc: "",
        };
        captchaAutofillStateByDocument.set(targetDocument, state);
        primeCaptchaAutofill(targetDocument, state);
        return state;
    }

    function enableCaptchaAutofill(targetDocument, rootNode, existingState) {
        const state = existingState ?? getOrCreateCaptchaState(targetDocument, rootNode);
        const form = state?.input.form;
        if (!form || form.dataset.eeclassCaptchaAutofillBound === "true" || !state) {
            return;
        }
        const triggerAutofill = () => {
            syncCaptchaAutofillState(targetDocument, state, rootNode);
            autofillCaptchaInput(targetDocument, state.image, state);
        };
        state.image.addEventListener("load", triggerAutofill);
        const observer = new MutationObserver((mutations) => {
            const shouldRefresh = mutations.some((mutation) => {
                if (mutation.type === "attributes" && mutation.attributeName === "src") {
                    return true;
                }
                if (mutation.type !== "childList") {
                    return false;
                }
                return (
                    [...mutation.addedNodes, ...mutation.removedNodes].some(
                        (node) => node instanceof HTMLImageElement
                    ) || mutation.target instanceof HTMLImageElement
                );
            });
            if (shouldRefresh) {
                triggerAutofill();
            }
        });
        observer.observe(state.mediaRow, {
            attributes: true,
            childList: true,
            subtree: true,
            attributeFilter: ["src"],
        });
        triggerAutofill();
        globalScope.requestAnimationFrame(triggerAutofill);
        globalScope.setTimeout(triggerAutofill, 0);
        form.dataset.eeclassCaptchaAutofillBound = "true";

        if (typeof chrome !== "undefined" && chrome.storage?.onChanged) {
            try {
                chrome.storage.onChanged.addListener((changes, areaName) => {
                    if (!isExtensionValid()) {
                        return;
                    }
                    if (areaName === "local" && changes[STORAGE_KEY]) {
                        const existingOverlay = targetDocument.getElementById(OVERLAY_ROOT_ID);
                        if (existingOverlay) {
                            delete existingOverlay.dataset.userCancelled;
                        }
                        delete form.dataset.eeclassAutoSubmitted;
                        maybeFillCredentialsAndSubmit(targetDocument, state, { ignoreErrorCheck: true });
                    }
                });
            }
            catch {
                // Ignore
            }
        }
    }

    function attachCaptchaAutofill(targetDocument) {
        const existingAttachment = captchaAttachmentByDocument.get(targetDocument);
        if (existingAttachment) {
            return existingAttachment.cleanup;
        }
        let bindAttempts = 0;
        let retryTimerId;
        let zeroDelayTimerId;
        let animationFrameId;
        let stopped = false;

        const isAutofillBound = () =>
            targetDocument.querySelector(CAPTCHA_INPUT_SELECTOR)?.form?.dataset.eeclassCaptchaAutofillBound === "true";

        const observer = new MutationObserver(() => {
            if (!isExtensionValid()) {
                observer.disconnect();
                return;
            }
            if (!tryBindAutofill()) {
                scheduleRetry();
            }
        });

        const cleanup = () => {
            if (stopped) {
                return;
            }
            stopped = true;
            if (retryTimerId !== undefined) {
                globalScope.clearTimeout(retryTimerId);
                retryTimerId = undefined;
            }
            if (zeroDelayTimerId !== undefined) {
                globalScope.clearTimeout(zeroDelayTimerId);
                zeroDelayTimerId = undefined;
            }
            if (animationFrameId !== undefined) {
                globalScope.cancelAnimationFrame(animationFrameId);
                animationFrameId = undefined;
            }
            targetDocument.removeEventListener("DOMContentLoaded", bindAutofill);
            observer.disconnect();
        };

        captchaAttachmentByDocument.set(targetDocument, { cleanup });

        function tryBindAutofill() {
            if (stopped || isAutofillBound()) {
                cleanup();
                return true;
            }
            const state = getOrCreateCaptchaState(targetDocument, targetDocument);
            if (!state) {
                return false;
            }
            enableCaptchaAutofill(targetDocument, targetDocument, state);
            if (isAutofillBound()) {
                cleanup();
                return true;
            }
            return false;
        }

        function scheduleRetry() {
            if (stopped || retryTimerId !== undefined) {
                return;
            }
            if (bindAttempts >= CAPTCHA_BIND_ATTEMPT_LIMIT) {
                cleanup();
                return;
            }
            retryTimerId = globalScope.setTimeout(() => {
                retryTimerId = undefined;
                bindAutofill();
            }, CAPTCHA_BIND_RETRY_DELAY_MS);
        }

        function bindAutofill() {
            if (stopped) {
                return;
            }
            bindAttempts++;
            if (!tryBindAutofill()) {
                scheduleRetry();
            }
        }

        if (targetDocument.documentElement) {
            observer.observe(targetDocument.documentElement, {
                childList: true,
                subtree: true,
            });
        }
        animationFrameId = globalScope.requestAnimationFrame(bindAutofill);
        zeroDelayTimerId = globalScope.setTimeout(bindAutofill, 0);
        if (targetDocument.readyState === "loading") {
            targetDocument.addEventListener("DOMContentLoaded", bindAutofill, { once: true });
        }
        else {
            bindAutofill();
        }
        return cleanup;
    }

    globalScope.EECLASS_DECAPTCHA ??= {};
    globalScope.EECLASS_DECAPTCHA.attachCaptchaAutofill = attachCaptchaAutofill;

    const targetDocument = globalScope.document;
    if (targetDocument && isOauthAuthorizePage(targetDocument)) {
        attachCaptchaAutofill(targetDocument);
    }
})(globalThis);
