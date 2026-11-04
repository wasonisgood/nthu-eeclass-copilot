"use strict";

// 登入狀態判斷（純函式，不碰 DOM 與 chrome API，方便 Node 測試）。
// 輸入：探測網址的最終 URL、HTTP 狀態碼、回應 HTML，以及該系統的目標設定。
// 判斷規則：
//   1) HTTP 狀態不是 2xx/3xx -> UNKNOWN（無法判斷）
//   2) 最終網址符合登入頁樣式 -> LOGGED_OUT（被轉到登入頁）
//   3) HTML 含登入表單（type=password）或已知的未登入標記 -> LOGGED_OUT
//   4) 其餘情況 -> LOGGED_IN
// 注意：LOGGED_IN 只代表「沒有被導向登入頁，也沒有登入表單」，仍建議搭配 cookie 檢查。
(function loginStateRuntime(globalScope) {
    const STATES = Object.freeze({
        LOGGED_IN: "LOGGED_IN",
        LOGGED_OUT: "LOGGED_OUT",
        UNKNOWN: "UNKNOWN",
    });

    function matchesAny(patterns, text) {
        return (patterns ?? []).some((pattern) => {
            const regex = pattern instanceof RegExp ? pattern : new RegExp(pattern, "i");
            return regex.test(text ?? "");
        });
    }

    function classify({ finalUrl = "", status = 0, html = "" } = {}, target = {}) {
        if (!(status >= 200 && status < 400)) {
            return { state: STATES.UNKNOWN, reason: `HTTP ${status || "無回應"}` };
        }
        if (matchesAny(target.loginUrlPatterns, finalUrl)) {
            return { state: STATES.LOGGED_OUT, reason: "被導向登入頁（網址符合登入頁樣式）" };
        }
        if (/type=["']password["']/i.test(html)) {
            return { state: STATES.LOGGED_OUT, reason: "頁面含密碼欄位（登入表單）" };
        }
        if (matchesAny(target.loggedOutMarkers, html)) {
            return { state: STATES.LOGGED_OUT, reason: "頁面含未登入標記（例如登入連結）" };
        }
        return { state: STATES.LOGGED_IN, reason: "未被導向登入頁，且沒有登入表單或未登入標記" };
    }

    // 三個系統的探測目標（探測網址可在偵錯頁面中改）
    const TARGETS = [
        {
            id: "ccxp",
            label: "校務資訊系統",
            probeUrl: "https://www.ccxp.nthu.edu.tw/ccxp/INQUIRE/select_entry.php",
            loginUrlPatterns: [/\/ccxp\/INQUIRE\/(index\.php)?(\?.*)?$/i],
            // 未登入時 select_entry.php 仍回 200，內容只有「session is interrupted!」並以 JS 跳回登入首頁
            loggedOutMarkers: [
                /name=["']passwd2["']/i,
                /session is interrupted/i,
                /window\.top\.location\s*=\s*['"]\/ccxp\/INQUIRE\/?['"]/i,
            ],
            cookieDomains: ["www.ccxp.nthu.edu.tw"],
        },
        {
            id: "idm",
            label: "圖書館 IDM",
            probeUrl: "https://idm.nthu.ust.edu.tw/patron/886UST_NTHU/update_profile/",
            loginUrlPatterns: [/saml2\/login|\/sso\//i],
            loggedOutMarkers: [],
            cookieDomains: ["idm.nthu.ust.edu.tw"],
        },
        {
            id: "eeclass",
            label: "eeclass",
            probeUrl: "https://eeclass.nthu.edu.tw/",
            loginUrlPatterns: [/oauth\.ccxp\.nthu\.edu\.tw|\/sys\/login/i],
            loggedOutMarkers: [/\/service\/oauthRedir/i],
            cookieDomains: ["eeclass.nthu.edu.tw", "oauth.ccxp.nthu.edu.tw"],
        },
    ];

    globalScope.NTHU_LOGIN_STATE = { STATES, classify, TARGETS };
})(globalThis);
