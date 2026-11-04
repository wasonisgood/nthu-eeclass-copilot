"use strict";

/**
 * NTHU eeclass 頁面端事件擷取與即時 Google 日曆同步腳本
 * 支援頁面：
 * 1. https://eeclass.nthu.edu.tw/dashboard/latestEvent (最近事件總覽表 + 自動抓取各作業詳細頁之開放繳交時間與說明)
 * 2. https://eeclass.nthu.edu.tw/course/homework/<id> (單一作業詳細頁面即時解析與異動偵測更新)
 * 3. https://eeclass.nthu.edu.tw/course/homeworkList/<courseId> (單一課程作業列表批次解析與同步)
 */
(function initEeclassCalendarContent() {
    const CALENDAR_CONFIG_KEY = "eeclassCalendarConfig";
    const FETCH_CONCURRENCY = 4;

    function isExtensionValid() {
        try {
            return Boolean(typeof chrome !== "undefined" && chrome?.runtime && Boolean(chrome.runtime.id));
        }
        catch {
            return false;
        }
    }

    function cleanText(node) {
        if (!node) {
            return "";
        }
        const clone = node.cloneNode(true);
        clone.querySelectorAll(".font-icon, .fs-iconfont, .eeclass-cal-row-badge, .eeclass-inline-dl-btn").forEach((el) => el.remove());
        return clone.textContent.replace(/\s+/g, " ").trim();
    }

    function parseHomeworkDetailDocument(doc, pageUrl) {
        const hwIdMatch = /\/course\/homework\/(\d+)/.exec(pageUrl);
        const key = hwIdMatch ? `homework:${hwIdMatch[1]}` : `event:${new URL(pageUrl, location.origin).pathname}`;

        const bannerLink = doc.querySelector(".fs-banner-title a[href*='/course/']");
        const bannerTitleEl = doc.querySelector(".fs-banner-title .text, .fs-banner-title");
        const bannerExtEl = doc.querySelector(".fs-banner-extInfo");

        let courseId = "general";
        if (bannerLink) {
            const m = /\/course\/(\d+)/.exec(bannerLink.getAttribute("href") || "");
            if (m?.[1]) {
                courseId = m[1];
            }
        }
        else {
            const bodyClass = doc.body?.className || "";
            const m = /body-course-(\d+)/.exec(bodyClass);
            if (m?.[1]) {
                courseId = m[1];
            }
        }

        const courseName = bannerLink ? cleanText(bannerLink) : cleanText(bannerTitleEl);
        const courseCode = bannerExtEl
            ? cleanText(bannerExtEl).replace(/^[()（）]+|[()（）]+$/g, "")
            : "";

        const titleEl = doc.querySelector(".app-course_homework-show .fs-page-header h2 .title, .fs-page-header h2 .title");
        const title = cleanText(titleEl);

        const meta = {};
        const dl = doc.querySelector(".app-course_homework-show .fs-description dl.dl-horizontal, .fs-description dl.dl-horizontal");
        if (dl) {
            const dts = dl.querySelectorAll("dt");
            dts.forEach((dt) => {
                const dd = dt.nextElementSibling;
                if (dd && dd.tagName.toLowerCase() === "dd") {
                    meta[cleanText(dt)] = cleanText(dd);
                }
            });
        }

        // 擷取作業說明文字與附件連結（若有）
        const extraBlocks = [];
        doc.querySelectorAll(".app-course_homework-show .fs-text-block, .app-course_homework-show .fs-block-body").forEach((b) => {
            const txt = cleanText(b);
            if (txt) {
                extraBlocks.push(txt);
            }
        });
        const attachmentLinks = [];
        doc.querySelectorAll(".app-course_homework-show a[href]").forEach((a) => {
            const href = a.getAttribute("href") || "";
            if (/\/(filedownload|download)\/\d+/.test(href)) {
                const absUrl = new URL(href, pageUrl).href;
                attachmentLinks.push(`📎 ${cleanText(a) || "作業附件"}：${absUrl}`);
            }
        });

        const description = [...extraBlocks, ...attachmentLinks].filter(Boolean).join("\n");

        return {
            key,
            url: new URL(pageUrl, location.origin).href,
            title,
            courseId,
            courseName,
            courseCode,
            eventType: meta["類型"] || "作業",
            startTime: meta["開放繳交"] || meta["開始時間"] || meta["開放時間"] || "",
            dueTime: meta["繳交期限"] || meta["截止時間"] || meta["結束時間"] || "",
            allowLate: meta["允許遲交"] || "",
            weight: meta["成績比重"] || "",
            gradingMethod: meta["評分方式"] || "",
            submittedStatus: meta["繳交狀態"] || (meta["已繳交"] ? `已繳交：${meta["已繳交"]}` : ""),
            description,
        };
    }

    async function fetchHomeworkDetail(url) {
        const resp = await fetch(url, { credentials: "include" });
        if (!resp.ok) {
            throw new Error(`HTTP ${resp.status}`);
        }
        const html = await resp.text();
        const doc = new DOMParser().parseFromString(html, "text/html");
        return parseHomeworkDetailDocument(doc, url);
    }

    async function runWithConcurrency(items, limit, worker) {
        let idx = 0;
        const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
            while (idx < items.length) {
                const current = idx++;
                await worker(items[current], current);
            }
        });
        await Promise.all(runners);
    }

    /**
     * 解析 /dashboard/latestEvent 頁面上的 #recentEventTable，並自動背景補齊每筆作業的「開放繳交」與詳細欄位
     */
    async function collectEventsFromLatestEventPage() {
        const table = document.getElementById("recentEventTable");
        if (!table) {
            return [];
        }

        const rows = Array.from(table.querySelectorAll("tbody tr"));
        const rawList = [];

        for (const tr of rows) {
            const tds = tr.querySelectorAll("td");
            if (tds.length < 3) {
                continue;
            }
            const eventLink = tds[0].querySelector("a[href]");
            const courseLink = tds[1].querySelector("a[href]");
            const dateDiv = tds[2].querySelector("[title]") || tds[2];

            if (!eventLink) {
                continue;
            }
            const rawHref = eventLink.getAttribute("href") || "";
            const fullUrl = new URL(rawHref, location.origin).href;
            const title = cleanText(eventLink);

            let courseId = "general";
            if (courseLink) {
                const m = /\/course\/(\d+)/.exec(courseLink.getAttribute("href") || "");
                if (m?.[1]) {
                    courseId = m[1];
                }
            }
            const courseName = courseLink ? cleanText(courseLink) : cleanText(tds[1]);
            const dueTime = (dateDiv.getAttribute?.("title") || cleanText(dateDiv)).trim();

            const hwIdMatch = /\/course\/homework\/(\d+)/.exec(rawHref);
            const key = hwIdMatch ? `homework:${hwIdMatch[1]}` : `event:${rawHref}`;

            tr.dataset.eeclassEventKey = key;

            if (title && dueTime) {
                rawList.push({
                    key,
                    title,
                    url: fullUrl,
                    courseId,
                    courseName,
                    dueTime,
                });
            }
        }

        // 並行抓取作業詳細頁面，補齊「開放繳交（開始時間）」、比重、允許遲交與作業說明
        const enriched = new Array(rawList.length);
        await runWithConcurrency(rawList, FETCH_CONCURRENCY, async (item, i) => {
            if (/\/course\/homework\/\d+/.test(item.url)) {
                try {
                    const detail = await fetchHomeworkDetail(item.url);
                    enriched[i] = {
                        ...item,
                        ...detail,
                        title: detail.title || item.title,
                        courseId: detail.courseId && detail.courseId !== "general" ? detail.courseId : item.courseId,
                        courseName: detail.courseName || item.courseName,
                        // 若表格有秒數或詳細頁有精確分鐘，優先使用詳細頁的繳交期限，若無則用表格時間
                        dueTime: detail.dueTime || item.dueTime,
                    };
                    return;
                }
                catch {
                    // Fallback to basic row item
                }
            }
            enriched[i] = item;
        });

        return enriched.filter(Boolean);
    }

    /**
     * 解析 /course/homeworkList/<courseId> 課程作業列表頁
     */
    async function collectEventsFromCourseHomeworkListPage() {
        const links = Array.from(document.querySelectorAll("#fs-content a[href*='/course/homework/']"));
        const uniqueUrls = [...new Set(links.map((a) => new URL(a.getAttribute("href"), location.origin).href))];
        if (uniqueUrls.length === 0) {
            return [];
        }

        const results = [];
        await runWithConcurrency(uniqueUrls, FETCH_CONCURRENCY, async (url) => {
            try {
                const detail = await fetchHomeworkDetail(url);
                if (detail.title && detail.dueTime) {
                    results.push(detail);
                }
            }
            catch {
                // Ignore
            }
        });

        links.forEach((a) => {
            const m = /\/course\/homework\/(\d+)/.exec(a.getAttribute("href") || "");
            if (m?.[1]) {
                const tr = a.closest("tr");
                if (tr) {
                    tr.dataset.eeclassEventKey = `homework:${m[1]}`;
                }
            }
        });

        return results;
    }

    function updateTableRowBadges(syncResults = {}) {
        const rows = document.querySelectorAll("tr[data-eeclass-event-key]");
        rows.forEach((tr) => {
            const key = tr.dataset.eeclassEventKey;
            const res = syncResults[key];
            if (!res) {
                return;
            }
            const firstTd = tr.querySelector("td");
            if (!firstTd) {
                return;
            }
            let badge = firstTd.querySelector(".eeclass-cal-row-badge");
            if (!badge) {
                badge = document.createElement("a");
                badge.className = "eeclass-cal-row-badge";
                badge.target = "_blank";
                badge.rel = "noopener noreferrer";
                const container = firstTd.querySelector(".sm-text-overflow") || firstTd;
                container.appendChild(badge);
            }
            if (res.status === "created") {
                badge.textContent = "✓ 新增至日曆";
                badge.dataset.state = "ok";
            }
            else if (res.status === "updated") {
                badge.textContent = "↻ 日曆已更新";
                badge.dataset.state = "updated";
            }
            else if (res.status === "unchanged") {
                badge.textContent = "✓ 已同步日曆";
                badge.dataset.state = "ok";
            }
            else {
                badge.textContent = "同步失敗";
                badge.dataset.state = "error";
            }
            if (res.htmlLink) {
                badge.href = res.htmlLink;
                badge.title = "點擊在 Google 日曆檢視此作業事件";
            }
            else {
                badge.removeAttribute("href");
            }
        });
    }

    function injectHeaderToolbar(onManualSyncClick) {
        const headerContainer = document.querySelector("#fs-content .fs-page-header h2");
        if (!headerContainer || headerContainer.querySelector(".eeclass-cal-toolbar")) {
            return headerContainer?.querySelector(".eeclass-cal-toolbar") || null;
        }

        const toolbar = document.createElement("div");
        toolbar.className = "eeclass-cal-toolbar";

        const statusPill = document.createElement("span");
        statusPill.className = "eeclass-cal-status-pill";
        statusPill.textContent = "準備檢查日曆同步...";

        const syncBtn = document.createElement("button");
        syncBtn.type = "button";
        syncBtn.className = "eeclass-cal-action-btn";
        syncBtn.textContent = "同步 Google 日曆";

        const settingsBtn = document.createElement("button");
        settingsBtn.type = "button";
        settingsBtn.className = "eeclass-cal-settings-btn";
        settingsBtn.textContent = "日曆設定";
        settingsBtn.title = "開啟 Google 日曆同步與課程歸檔設定";

        syncBtn.addEventListener("click", () => {
            onManualSyncClick(statusPill, syncBtn);
        });

        settingsBtn.addEventListener("click", () => {
            if (!isExtensionValid()) {
                alert("擴充功能已重新載入，請重新整理（F5）網頁後再試。");
                return;
            }
            try {
                chrome.runtime.sendMessage({
                    action: "open_split_settings",
                    section: "student-calendar",
                });
            }
            catch {
                // Ignore
            }
        });

        toolbar.appendChild(statusPill);
        toolbar.appendChild(syncBtn);
        toolbar.appendChild(settingsBtn);
        headerContainer.appendChild(toolbar);

        return { toolbar, statusPill, syncBtn };
    }

    async function performSyncOnCurrentPage(options = {}) {
        const { forceUpdate = false, interactiveAuth = false, statusPill, syncBtn } = options;
        if (syncBtn) {
            syncBtn.disabled = true;
        }
        if (statusPill) {
            statusPill.textContent = "正在解析事件與開始/截止時間...";
            statusPill.dataset.tone = "info";
        }

        try {
            let events = [];
            if (/^\/dashboard\/latestEvent/.test(location.pathname)) {
                events = await collectEventsFromLatestEventPage();
            }
            else if (/^\/course\/homework\/\d+/.test(location.pathname)) {
                const detail = parseHomeworkDetailDocument(document, location.href);
                if (detail.title && detail.dueTime) {
                    events = [detail];
                }
            }
            else if (/^\/course\/homeworkList\/\d+/.test(location.pathname)) {
                events = await collectEventsFromCourseHomeworkListPage();
            }

            if (events.length === 0) {
                if (statusPill) {
                    statusPill.textContent = "此頁面無待同步事件";
                    statusPill.dataset.tone = "muted";
                }
                if (syncBtn) {
                    syncBtn.disabled = false;
                }
                return;
            }

            if (statusPill) {
                statusPill.textContent = `正在同步 ${events.length} 筆事件至 Google 日曆...`;
            }

            const resp = await new Promise((resolve) => {
                if (!isExtensionValid()) {
                    resolve({ ok: false, error: "擴充功能已重新載入，請重新整理（F5）網頁" });
                    return;
                }
                try {
                    chrome.runtime.sendMessage(
                        {
                            action: "calendar_sync_events",
                            events,
                            forceUpdate,
                            interactiveAuth,
                        },
                        (res) => resolve(res || { ok: false, error: "背景服務未回應" })
                    );
                }
                catch {
                    resolve({ ok: false, error: "擴充功能已重新載入" });
                }
            });

            if (!resp.ok) {
                if (statusPill) {
                    statusPill.textContent = resp.authorized === false
                        ? `已擷取 ${events.length} 筆事件（請點「日曆設定」授權 Google 日曆）`
                        : `日曆同步失敗：${resp.error || "未知錯誤"}`;
                    statusPill.dataset.tone = "warn";
                }
                if (syncBtn && resp.authorized === false) {
                    syncBtn.textContent = "授權並同步日曆";
                }
            }
            else {
                updateTableRowBadges(resp.results || {});
                const totalChanged = (resp.createdCount || 0) + (resp.updatedCount || 0);
                if (statusPill) {
                    statusPill.textContent = totalChanged > 0
                        ? `✓ 已同步 Google 日曆（新增 ${resp.createdCount} / 更新 ${resp.updatedCount} / 最新 ${resp.unchangedCount}）`
                        : `✓ Google 日曆已為最新 (${events.length} 筆事件)`;
                    statusPill.dataset.tone = "ok";
                }
                if (syncBtn) {
                    syncBtn.textContent = "立即更新日曆";
                }
            }
        }
        catch (err) {
            if (statusPill) {
                statusPill.textContent = `解析失敗：${err?.message || "未知錯誤"}`;
                statusPill.dataset.tone = "error";
            }
        }
        finally {
            if (syncBtn) {
                syncBtn.disabled = false;
            }
        }
    }

    async function bootstrap() {
        const isTargetPage =
            /^\/dashboard\/latestEvent/.test(location.pathname) ||
            /^\/course\/homework\/\d+/.test(location.pathname) ||
            /^\/course\/homeworkList\/\d+/.test(location.pathname);

        if (!isTargetPage) {
            return;
        }

        const ui = injectHeaderToolbar((statusPill, syncBtn) => {
            performSyncOnCurrentPage({
                forceUpdate: true,
                interactiveAuth: true,
                statusPill,
                syncBtn,
            });
        });

        if (isExtensionValid() && chrome.storage?.local) {
            try {
                chrome.storage.local.get([CALENDAR_CONFIG_KEY], (res) => {
                    if (chrome.runtime?.lastError) return;
                    const config = res?.[CALENDAR_CONFIG_KEY] || { autoSyncCalendar: true };
                    if (config.autoSyncCalendar !== false) {
                        performSyncOnCurrentPage({
                            forceUpdate: false,
                            interactiveAuth: false,
                            statusPill: ui?.statusPill,
                            syncBtn: ui?.syncBtn,
                        });
                    }
                    else if (ui?.statusPill) {
                        ui.statusPill.textContent = "自動同步已關閉（可手動點擊同步）";
                    }
                });
            }
            catch {
                // Ignore
            }
        }

        // 在作業詳細頁監視 DOM 內容變化，若教師或系統動態更新期限或內容，立即觸發差異同步
        if (/^\/course\/homework\/\d+/.test(location.pathname)) {
            const contentRoot = document.querySelector(".app-course_homework-show");
            if (contentRoot) {
                let debounceTimer;
                const observer = new MutationObserver(() => {
                    if (!isExtensionValid()) {
                        observer.disconnect();
                        return;
                    }
                    if (debounceTimer) {
                        clearTimeout(debounceTimer);
                    }
                    debounceTimer = setTimeout(() => {
                        performSyncOnCurrentPage({
                            forceUpdate: false,
                            interactiveAuth: false,
                            statusPill: ui?.statusPill,
                            syncBtn: ui?.syncBtn,
                        });
                    }, 1200);
                });
                observer.observe(contentRoot, {
                    childList: true,
                    subtree: true,
                    characterData: true,
                });
            }
        }
    }

    bootstrap();
})();
