/**
 * NTHU eeclass Copilot - eeclass 請求傳輸層
 *
 * 擴充功能頁面（Service Worker、options 頁）直接 fetch eeclass 時，Cookie 不一定會隨請求送出，
 * 會被 eeclass 當成未登入。這裡改為在 eeclass 分頁內執行 fetch，請求即為該分頁的第一方請求，
 * 與使用者在分頁中操作時完全相同。
 *
 * 分頁選擇：
 *   1. 優先使用已開啟且位於 eeclass 網域的分頁（不切換、不導向）。
 *   2. 沒有時建立一個背景分頁，並在整個工作階段重複使用。
 *
 * 在 Node 測試環境（沒有 chrome.scripting）會退回直接 fetch。
 */

(function initEeclassTransport(globalScope) {
    "use strict";

    const BASE = "https://eeclass.nthu.edu.tw";
    let helperTabId = null;

    function hasChromeTabs() {
        return typeof chrome !== "undefined" && chrome.tabs && chrome.scripting;
    }

    function waitTabComplete(tabId, timeout = 30000) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                chrome.tabs.onUpdated.removeListener(listener);
                reject(new Error("eeclass 分頁載入逾時"));
            }, timeout);
            const listener = (id, info) => {
                if (id === tabId && info.status === "complete") {
                    clearTimeout(timer);
                    chrome.tabs.onUpdated.removeListener(listener);
                    resolve();
                }
            };
            chrome.tabs.onUpdated.addListener(listener);
            chrome.tabs.get(tabId, (tab) => {
                if (tab && tab.status === "complete") {
                    clearTimeout(timer);
                    chrome.tabs.onUpdated.removeListener(listener);
                    resolve();
                }
            });
        });
    }

    async function ensureEclassTabId() {
        const tabs = await chrome.tabs.query({ url: BASE + "/*" });
        const usable = tabs.find(t => t.status === "complete") || tabs[0];
        if (usable) return usable.id;

        if (helperTabId !== null) {
            try {
                const t = await chrome.tabs.get(helperTabId);
                if (t) return helperTabId;
            } catch (e) {
                helperTabId = null;
            }
        }
        const tab = await chrome.tabs.create({ url: BASE + "/", active: false });
        helperTabId = tab.id;
        await waitTabComplete(tab.id);
        return tab.id;
    }

    /** 在 eeclass 分頁內執行（注入函式）：同源 fetch，回傳狀態與 HTML */
    async function pageRequest(path, init) {
        try {
            const opts = {
                method: (init && init.method) || "GET",
                credentials: "include",
                redirect: "follow",
                headers: (init && init.headers) || undefined,
                body: (init && init.body) || undefined
            };
            const resp = await fetch(path, opts);
            if (init && init.binary) {
                const buf = new Uint8Array(await resp.arrayBuffer());
                let bin = "";
                const chunk = 0x8000;
                for (let i = 0; i < buf.length; i += chunk) {
                    bin += String.fromCharCode.apply(null, buf.subarray(i, i + chunk));
                }
                return { status: resp.status, url: resp.url, contentType: resp.headers.get("content-type"), size: buf.byteLength, base64: btoa(bin) };
            }
            return { status: resp.status, url: resp.url, html: await resp.text() };
        } catch (e) {
            return { error: e.message || String(e) };
        }
    }

    /**
     * 發出 eeclass 請求。
     * @param {string} path  以 / 開頭的路徑（例如 /home.php）或完整網址
     * @param {{method?:string, body?:string, headers?:object}} init
     * @returns {Promise<{status:number, url:string, html:string}>}
     */
    async function request(path, init) {
        const rel = /^https?:\/\//i.test(path) ? new URL(path).pathname + new URL(path).search : path;
        if (!hasChromeTabs()) {
            const resp = await fetch(BASE + rel, { credentials: "include", redirect: "follow", ...(init || {}) });
            return { status: resp.status, url: resp.url, html: await resp.text() };
        }
        const tabId = await ensureEclassTabId();
        const [injection] = await chrome.scripting.executeScript({
            target: { tabId },
            func: pageRequest,
            args: [rel, init || {}]
        });
        const result = injection && injection.result;
        if (!result) throw new Error("無法在 eeclass 分頁執行請求（分頁可能已關閉）");
        if (result.error) throw new Error(result.error);
        return result;
    }

    /** 下載二進位檔（例如教材）：回傳 base64 */
    async function requestBinary(path) {
        return request(path, { binary: true });
    }

    globalScope.EeclassTransport = { request, requestBinary, BASE };
})(typeof self !== "undefined" ? self : (typeof window !== "undefined" ? window : globalThis));
