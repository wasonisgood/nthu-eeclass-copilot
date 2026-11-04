"use strict";

// elearn（https://elearn.nthu.edu.tw/）未登入時，自動點開 Moodle 的 OAuth 登入入口（/auth/oauth2/login.php），
// 之後由 oauth.ccxp.nthu.edu.tw 的既有自動登入流程（content.js）接手，完成後回到 elearn。
// 判斷未登入的方式：頁面上有指向 elearn 本身的登入入口連結（登入後 Moodle 不會顯示此連結）。
// 防護：1 小時內最多自動嘗試 2 次；若驗證失敗又被導回，超過次數就停止，避免反覆嘗試導致帳號被鎖。
(function elearnHomeAutologin(globalScope) {
    const HOST = "elearn.nthu.edu.tw";
    const ATTEMPTS_KEY = "elearn_oauth_autologin_attempts";
    const WINDOW_MS = 60 * 60 * 1000;
    const MAX_ATTEMPTS = 2;

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
            // sessionStorage 不可用時略過防護記錄
        }
    }

    const loginLink = document.querySelector('a[href*="/auth/oauth2/login.php"]');
    if (!loginLink) {
        return;
    }

    let target;
    try {
        target = new URL(loginLink.href, globalScope.location.href);
    }
    catch {
        return;
    }
    if (target.protocol !== "https:" || target.hostname.toLowerCase() !== HOST) {
        return;
    }

    let attempts = [];
    try {
        attempts = JSON.parse(sessionGet(ATTEMPTS_KEY) || "[]").filter((t) => Date.now() - t < WINDOW_MS);
    }
    catch {
        attempts = [];
    }
    if (attempts.length >= MAX_ATTEMPTS) {
        console.warn("[elearn-autologin] 1 小時內自動嘗試已達上限，請手動登入");
        return;
    }

    attempts.push(Date.now());
    sessionSet(ATTEMPTS_KEY, JSON.stringify(attempts));
    globalScope.location.href = target.href;
})(globalThis);
