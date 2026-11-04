"use strict";

// eeclass 首頁（https://eeclass.nthu.edu.tw/）未登入時，自動導向 eeclass 的登入入口（/service/oauthRedir），
// 之後由 oauth.ccxp.nthu.edu.tw 的既有自動登入流程接手。
(function eeclassHomeAutologin(globalScope) {
    const REDIRECT_KEY = "eeclass_home_autologin_redirect_at";
    const REDIRECT_COOLDOWN_MS = 30000;

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

    if (location.pathname !== "/" && location.pathname !== "") {
        return;
    }

    const loginLink = document.querySelector('a[href*="/service/oauthRedir"]');
    if (!loginLink) {
        return;
    }

    const lastRedirect = Number(sessionGet(REDIRECT_KEY) || 0);
    if (Date.now() - lastRedirect < REDIRECT_COOLDOWN_MS) {
        return;
    }

    sessionSet(REDIRECT_KEY, Date.now());
    location.href = loginLink.href;
})(globalThis);
