/**
 * NTHU eeclass Copilot - 頁面操作層（Service Worker 使用）
 *
 * 部分操作（作業新增刪除、批改、退回重寫、打包下載、匯出、測驗紀錄刪除）在指引中只記錄了
 * 按鈕位置與表單欄位，沒有 HTTP 端點。這裡在使用者已登入的 eeclass 分頁中執行相同的按鈕與表單
 * 操作（與手動點擊相同），因此 session 與權限都由 eeclass 頁面本身處理。
 *
 * 流程：chrome.tabs 開啟頁面 → chrome.scripting 注入操作函式 → 等待結果 → 關閉分頁。
 * 下載（zip / 匯出檔）透過 chrome.downloads 取得實際存放的檔案路徑。
 */

(function initEeclassUi(globalScope) {
    "use strict";

    const BASE = "https://eeclass.nthu.edu.tw";

    // ---------- 頁面內輔助函式（每個分頁只注入一次） ----------

    function installPageHelpers() {
        if (window.__eeclassUi) return true;
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const waitFor = async (fn, timeout = 15000) => {
            const end = Date.now() + timeout;
            while (Date.now() < end) {
                try {
                    const v = fn();
                    if (v) return v;
                } catch (e) { /* 等待中的元素尚未出現 */ }
                await sleep(200);
            }
            return null;
        };
        const textOf = (el) => (el.textContent || "").replace(/\s+/g, " ").trim();
        const findByText = (root, selector, text, exact = true) => {
            return Array.from(root.querySelectorAll(selector)).find(el => {
                const t = textOf(el);
                return exact ? t === text : t.includes(text);
            }) || null;
        };
        const visibleModal = (root = document) => {
            const modals = Array.from(root.querySelectorAll(".modal"));
            return modals.reverse().find(m => m.offsetParent !== null || m.classList.contains("in") || m.classList.contains("show")) || null;
        };
        const setValue = (el, value) => {
            if (!el) throw new Error("找不到欄位");
            el.focus();
            el.value = value == null ? "" : String(value);
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
            el.blur();
        };
        const setRadio = (root, name, value) => {
            const el = root.querySelector(`input[type=radio][name="${name}"][value="${value}"]`);
            if (!el) throw new Error(`找不到單選欄位 ${name}=${value}`);
            el.checked = true;
            el.click();
        };
        const setCheck = (el, on) => {
            if (!el) throw new Error("找不到勾選框");
            if (el.checked !== !!on) el.click();
        };
        window.__eeclassUi = { sleep, waitFor, textOf, findByText, visibleModal, setValue, setRadio, setCheck };
        return true;
    }

    // ---------- 分頁管理 ----------

    function waitTabComplete(tabId, timeout = 30000) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                chrome.tabs.onUpdated.removeListener(listener);
                reject(new Error("頁面載入逾時"));
            }, timeout);
            const listener = (id, info) => {
                if (id === tabId && info.status === "complete") {
                    clearTimeout(timer);
                    chrome.tabs.onUpdated.removeListener(listener);
                    resolve();
                }
            };
            chrome.tabs.onUpdated.addListener(listener);
        });
    }

    async function runOnPage(path, fn, args, opts = {}) {
        const tab = await chrome.tabs.create({ url: BASE + path, active: false });
        try {
            await waitTabComplete(tab.id);
            await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: installPageHelpers });
            const [injection] = await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                func: fn,
                args: args || []
            });
            const result = injection ? injection.result : null;
            if (result && result.loginRequired) {
                const err = new Error("eeclass 尚未登入或工作階段已過期");
                err.name = "LoginRequiredError";
                throw err;
            }
            if (result && result.error) throw new Error(result.error);
            return result;
        } finally {
            if (!opts.keepOpen) chrome.tabs.remove(tab.id).catch(() => {});
        }
    }

    /** 等待下一個由 eeclass 頁面觸發的下載完成，回傳實際檔案路徑 */
    function waitForDownload(timeout = 90000) {
        return new Promise((resolve, reject) => {
            let downloadId = null;
            const timer = setTimeout(() => {
                cleanup();
                reject(new Error("等待下載逾時（請確認 eeclass 頁面有觸發下載）"));
            }, timeout);
            const cleanup = () => {
                clearTimeout(timer);
                chrome.downloads.onCreated.removeListener(onCreated);
                chrome.downloads.onChanged.removeListener(onChanged);
            };
            const onCreated = (item) => {
                const fromEclass = (item.url || "").includes("eeclass.nthu.edu.tw") || (item.referrer || "").includes("eeclass.nthu.edu.tw");
                if (downloadId === null && fromEclass) downloadId = item.id;
            };
            const onChanged = (delta) => {
                if (delta.id !== downloadId || !delta.state) return;
                if (delta.state.current === "complete") {
                    chrome.downloads.search({ id: downloadId }, (items) => {
                        cleanup();
                        const item = items && items[0];
                        if (!item) return reject(new Error("下載紀錄不存在"));
                        resolve({
                            filename: item.filename,
                            fileSize: item.fileSize,
                            mime: item.mime,
                            sourceUrl: item.url
                        });
                    });
                } else if (delta.state.current === "interrupted") {
                    cleanup();
                    reject(new Error("下載中斷"));
                }
            };
            chrome.downloads.onCreated.addListener(onCreated);
            chrome.downloads.onChanged.addListener(onChanged);
        });
    }

    // ---------- 頁面操作（函式會被序列化注入到 eeclass 分頁） ----------

    async function pageCreatePersonalHomework(p) {
        const ui = window.__eeclassUi;
        const addBtn = await ui.waitFor(() => Array.from(document.querySelectorAll("span.text")).find(s => ui.textOf(s) === "新增"));
        if (!addBtn) return { error: "找不到「新增」按鈕" };
        addBtn.closest("a").click();

        const typeBtn = await ui.waitFor(() => {
            const modal = ui.visibleModal();
            if (!modal) return null;
            return ui.findByText(modal, "a,button,label,div", "個人作業", false);
        });
        if (!typeBtn) return { error: "找不到「個人作業」類型選項" };
        typeBtn.click();

        const frame = await ui.waitFor(() => {
            const f = document.querySelector("iframe");
            return f && f.contentDocument && f.contentDocument.querySelector("input[name=title]") ? f : null;
        }, 20000);
        if (!frame) return { error: "作業表單未載入" };
        const d = frame.contentDocument;

        ui.setValue(d.querySelector("input[name=title]"), p.title);
        if (p.description) ui.setValue(d.querySelector("textarea[name=description]"), p.description);
        const [sd, st] = p.startDate.split(" ");
        const [dd, dt] = p.deadline.split(" ");
        ui.setValue(d.querySelector("#homeworkStartTime_date"), sd);
        ui.setValue(d.querySelector("#homeworkStartTime_time"), st || "00:00");
        ui.setValue(d.querySelector("#homeworkDeadline_date"), dd);
        ui.setValue(d.querySelector("#homeworkDeadline_time"), dt || "23:59");
        ui.setRadio(d, "allowDelay", p.allowDelay ? "1" : "2");
        ui.setValue(d.querySelector("input[name=weight]"), p.weight);
        ui.setRadio(d, "auditMode", p.auditMode || "1");
        ui.setRadio(d, "gradeSearch", p.gradeSearch || "2");
        ui.setRadio(d, "view", p.view || "2");
        ui.setCheck(d.querySelector("input[type=checkbox][value='1']"), !!p.draft);

        const submit = await ui.waitFor(() => Array.from(d.querySelectorAll("button[type=submit]")).find(b => ui.textOf(b) === "確定"));
        if (!submit) return { error: "找不到表單「確定」按鈕" };
        submit.click();
        await ui.sleep(1500);
        return { submitted: true };
    }

    async function pageDeleteHomework(p) {
        const ui = window.__eeclassUi;
        const link = await ui.waitFor(() => document.querySelector(`a[href$="/course/homework/${p.homeworkId}"]`));
        if (!link) return { error: `列表中找不到作業 #${p.homeworkId}` };
        const row = link.closest("tr");
        const del = await ui.waitFor(() => ui.findByText(row, "a", "刪除", false));
        if (!del) return { error: "找不到「刪除」選項" };
        del.click();
        const confirmBtn = await ui.waitFor(() => {
            const m = ui.visibleModal();
            return m ? Array.from(m.querySelectorAll("button,a")).find(b => ["確定", "刪除"].includes(ui.textOf(b))) : null;
        });
        if (!confirmBtn) return { error: "找不到刪除確認按鈕" };
        confirmBtn.click();
        await ui.sleep(1500);
        return { deleted: true };
    }

    async function pageAuditHomework(p) {
        const ui = window.__eeclassUi;
        const score = await ui.waitFor(() => document.querySelector("input[name=auditScore]"));
        if (!score) return { error: "找不到分數欄位（input[name=auditScore]）" };
        ui.setValue(score, p.auditScore);
        const form = score.closest("form") || document;
        const boxes = Array.from(form.querySelectorAll("input[type=checkbox][value='1']"));
        if (boxes[0]) ui.setCheck(boxes[0], !!p.isModelStudent);
        if (boxes[1]) ui.setCheck(boxes[1], !!p.sendEmailNotification);
        const editor = await ui.waitFor(() => document.querySelector("iframe.rte-editable"));
        if (!editor) return { error: "找不到評語編輯器" };
        editor.contentDocument.body.innerHTML = p.commentHtml || "";
        await ui.sleep(300);
        const submit = document.querySelector("button.submitAudit");
        if (!submit) return { error: "找不到送出按鈕（button.submitAudit）" };
        submit.click();
        await ui.sleep(1500);
        return { submitted: true };
    }

    async function pageRejectHomework(p) {
        const ui = window.__eeclassUi;
        const btn = await ui.waitFor(() => Array.from(document.querySelectorAll("a.btn-primary")).find(a => ui.textOf(a) === "退回重寫"));
        if (!btn) return { error: "找不到「退回重寫」按鈕" };
        btn.click();
        const modal = await ui.waitFor(() => {
            const m = ui.visibleModal();
            return m && m.querySelector("textarea") ? m : null;
        }, 5000);
        if (modal) {
            ui.setValue(modal.querySelector("textarea"), p.reason);
            const ok = Array.from(modal.querySelectorAll("button,a")).find(b => ["確定", "送出", "退回"].includes(ui.textOf(b)));
            if (!ok) return { error: "找不到退回確認按鈕" };
            ok.click();
        }
        await ui.sleep(1500);
        return { rejected: true, reasonFilled: !!modal };
    }

    async function pageSelectAndExport(p) {
        const ui = window.__eeclassUi;
        if (p.mode === "selected" && Array.isArray(p.reportIds)) {
            const want = new Set(p.reportIds.map(String));
            for (const row of Array.from(document.querySelectorAll("tr"))) {
                const a = row.querySelector("a[href*='/homework/report/']");
                if (!a) continue;
                const id = (a.getAttribute("href").match(/\/homework\/report\/(\d+)/) || [])[1];
                const box = row.querySelector("td.col-control input[type=checkbox]");
                if (box) ui.setCheck(box, want.has(id));
            }
        }
        if (p.action === "export") {
            const toggle = await ui.waitFor(() => Array.from(document.querySelectorAll("button")).find(b => ui.textOf(b) === "匯出"));
            if (!toggle) return { error: "找不到「匯出」按鈕" };
            toggle.click();
            const item = await ui.waitFor(() => Array.from(document.querySelectorAll("a,li,button")).find(e => ui.textOf(e) === (p.mode === "selected" ? "已選擇" : "全部")));
            if (!item) return { error: "找不到匯出選項" };
            item.click();
            return { clicked: true, action: "export", mode: p.mode };
        }
        const pack = await ui.waitFor(() => Array.from(document.querySelectorAll("button")).find(b => ui.textOf(b) === "打包下載"));
        if (!pack) return { error: "找不到「打包下載」按鈕" };
        pack.click();
        return { clicked: true, action: "package" };
    }

    async function pageDeleteAttempt(p) {
        const ui = window.__eeclassUi;
        const link = await ui.waitFor(() => document.querySelector(`a[href*="recordID=${p.recordId}"]`));
        if (!link) return { error: `名單中找不到作答紀錄 ${p.recordId}` };
        const row = link.closest("tr");
        const del = await ui.waitFor(() => row.querySelector("a.js-delete"));
        if (!del) return { error: "找不到刪除按鈕（a.js-delete）" };
        del.click();
        const confirmBtn = await ui.waitFor(() => {
            const m = ui.visibleModal();
            return m ? Array.from(m.querySelectorAll("button,a")).find(b => ["確定", "刪除"].includes(ui.textOf(b))) : null;
        });
        if (!confirmBtn) return { error: "找不到刪除確認按鈕" };
        confirmBtn.click();
        await ui.sleep(1500);
        return { deleted: true, recordId: p.recordId };
    }

    async function pageAuditEssay(p) {
        const ui = window.__eeclassUi;
        const textarea = await ui.waitFor(() => document.querySelector(`textarea[name="${p.questionId}"]`));
        if (!textarea) return { error: `找不到問答題欄位 ${p.questionId}` };
        const block = textarea.closest(".kques-item");
        const edit = ui.findByText(block, "a", "修改", true);
        if (!edit) return { error: "找不到「修改」按鈕（此題可能已被鎖定或為選擇題）" };
        edit.click();
        const area = await ui.waitFor(() => {
            const a = block.querySelector(".auditEditArea");
            return a && a.offsetParent !== null ? a : null;
        });
        if (!area) return { error: "評分編輯區未展開" };
        ui.setValue(area.querySelector("input[type=text]"), p.score);
        const editor = block.querySelector("iframe.rte-editable");
        if (editor) editor.contentDocument.body.innerHTML = p.commentHtml || "";
        textarea.value = p.commentHtml || "";
        const send = ui.findByText(area, "a.btn-primary", "送出", true) || ui.findByText(area, "a", "送出", true);
        if (!send) return { error: "找不到「送出」按鈕" };
        send.click();
        await ui.sleep(1500);
        return { submitted: true, questionId: p.questionId };
    }

    // ---------- 對外 API ----------

    async function createPersonalHomework(courseId, p) {
        const r = await runOnPage(`/course/homeworkList/${courseId}`, pageCreatePersonalHomework, [p]);
        return { action: "create_homework", courseId: Number(courseId), ...r };
    }

    async function deleteHomework(courseId, homeworkId) {
        const r = await runOnPage(`/course/homeworkList/${courseId}`, pageDeleteHomework, [{ homeworkId }]);
        return { action: "delete_homework", courseId: Number(courseId), homeworkId: Number(homeworkId), ...r };
    }

    async function auditHomework(reportId, p) {
        const r = await runOnPage(`/homework/report/${reportId}`, pageAuditHomework, [p]);
        return { action: "audit_homework_submission", reportId: Number(reportId), ...r };
    }

    async function rejectHomework(reportId, reason) {
        const r = await runOnPage(`/homework/report/${reportId}`, pageRejectHomework, [{ reason }]);
        return { action: "reject_homework_submission", reportId: Number(reportId), ...r };
    }

    /**
     * 打包下載（mode 未指定）或匯出（action=export，mode=all|selected）。
     * 回傳瀏覽器實際儲存的檔案路徑。
     */
    async function downloadHomeworkPackage(homeworkId, opts) {
        const o = opts || {};
        const path = `/homework/submitList/${homeworkId}`;
        const tab = await chrome.tabs.create({ url: BASE + path, active: false });
        try {
            await waitTabComplete(tab.id);
            await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: installPageHelpers });
            const pending = waitForDownload(90000);
            const [injection] = await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                func: pageSelectAndExport,
                args: [{ action: o.action || "package", mode: o.mode || "all", reportIds: o.reportIds || [] }]
            });
            if (!injection || !injection.result || injection.result.error) {
                throw new Error((injection && injection.result && injection.result.error) || "頁面操作失敗");
            }
            const file = await pending;
            return { action: o.action || "package", homeworkId: Number(homeworkId), mode: o.mode || "all", ...file };
        } finally {
            chrome.tabs.remove(tab.id).catch(() => {});
        }
    }

    async function deleteAttemptAt(membersPath, examId, recordId) {
        const r = await runOnPage(membersPath, pageDeleteAttempt, [{ recordId }]);
        return { action: "delete_student_exam_attempt", examId: Number(examId), recordId: Number(recordId), ...r };
    }

    async function auditEssay(recordPath, p) {
        const r = await runOnPage(recordPath, pageAuditEssay, [p]);
        return { action: "audit_essay_question", ...r };
    }

    globalScope.EeclassUi = {
        createPersonalHomework,
        deleteHomework,
        auditHomework,
        rejectHomework,
        downloadHomeworkPackage,
        deleteAttemptAt,
        auditEssay,
        runOnPage
    };
})(typeof self !== "undefined" ? self : globalThis);
