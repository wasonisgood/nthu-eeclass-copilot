/**
 * NTHU eeclass Copilot - Chrome 擴充功能與 MCP 實體通訊長輪詢客戶端 (Live Bridge Client)
 * 
 * 核心職責：
 * 1. 於擴充套件背景 (Background Service Worker) 週期性向本地 MCP Bridge (127.0.0.1:3001) 長輪詢接收指令。
 * 2. 接收到 MCP 工具呼叫後，使用擴充套件所擁有的真實 Cookie 與 host_permissions 直接向真實 eeclass 伺服器發送 fetch 請求：
 *    - 抓取真實課程清單（區分助教/老師 vs 學生身分）
 *    - 抓取真實側欄資訊（老師、助教名單與當前身分）
 *    - 抓取真實作業清單與繳交人數
 *    - 抓取真實測驗清單
 *    - 抓取真實公告清單
 *    - 抓取真實學生作業繳交清冊
 * 3. 將真實資料即時 POST 回報至 Bridge，讓 Claude Desktop 取得 100% 真實數據！
 */

(function initMcpBridgeClient(globalScope) {
    "use strict";

    const BRIDGE_POLL_URL = "http://127.0.0.1:3001/extension/poll";
    const BRIDGE_REPLY_URL = "http://127.0.0.1:3001/extension/reply";
    const EECLASS_BASE = "https://eeclass.nthu.edu.tw";

    let isPolling = false;
    let pollFailCount = 0;

    /**
     * 清理 HTML 標籤取得純文字
     */
    function stripHtml(html) {
        return (html || "")
            .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
            .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
            .replace(/<[^>]+>/g, " ")
            .replace(/&nbsp;/g, " ")
            .replace(/&amp;/g, "&")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&#039;/g, "'")
            .replace(/&quot;/g, '"')
            .replace(/\s+/g, " ")
            .trim();
    }

    /**
     * 1. 從真實 eeclass 抓取所有修課與授課清單並劃分身分
     *    委由 course-scan.js 逐一讀取課程頁側欄「身份」欄位判斷，無法確認者不列入權限。
     */
    async function fetchLiveCourses() {
        try {
            const scan = await globalScope.EeclassCourseScan.scanCourses();
            if (!scan.loggedIn) {
                return { loggedIn: false, message: scan.message };
            }
            return {
                loggedIn: true,
                totalCourses: scan.allCourses.length,
                teachingCourses: scan.teachingCourses,
                studentCourses: scan.studentCourses,
                unverifiedCourses: scan.unverifiedCourses,
                allCourses: scan.allCourses
            };
        } catch (e) {
            return {
                loggedIn: false,
                error: e.message,
                message: `連線真實 eeclass 失敗：${e.message}`
            };
        }
    }

    /** 執行真實讀取；登入失效或網路錯誤以 error 回傳，不回填資料 */
    async function runLive(fn) {
        try {
            return await fn();
        } catch (e) {
            return { error: e.message, errorType: e.name || "Error", loggedIn: e.name === "LoginRequiredError" ? false : undefined };
        }
    }

    async function liveSidebar(courseId) {
        const html = (await globalScope.EeclassTransport.request(`/course/${courseId}`, {})).html;
        return globalScope.EeclassCourseScan.parseSidebar(html, Number(courseId));
    }

    /**
     * 長輪詢處理分發核心
     */
    // 登入狀態偵錯：在擴充功能的 service worker 內，用瀏覽器既有的 cookie 探測三個系統（不回傳 cookie 值）
    async function runLoginProbe(params = {}) {
        const { classify, TARGETS } = globalScope.NTHU_LOGIN_STATE;
        const results = [];
        // 指定 urls 時做臨時探測：未登入標記取所有系統的聯集，方便比對候選網址
        const adhocUrls = Array.isArray(params.urls) ? params.urls.slice(0, 10).map(String) : [];
        const targets = adhocUrls.length
            ? adhocUrls.map((u) => ({
                id: "adhoc",
                label: "臨時探測",
                probeUrl: u,
                loginUrlPatterns: TARGETS.flatMap((t) => t.loginUrlPatterns),
                loggedOutMarkers: TARGETS.flatMap((t) => t.loggedOutMarkers),
                cookieDomains: [],
            }))
            : TARGETS;
        // 安全規則：校務系統 select_entry.php 不能被擴充功能直接請求（沒有有效權杖的請求會被系統登出）
        const isForbiddenCcxpUrl = (u) => /select_entry\.php/i.test(String(u ?? ""));
        for (const target of targets) {
            const probeUrl = target.probeUrl;
            if (isForbiddenCcxpUrl(probeUrl)) {
                results.push({ id: target.id, label: target.label, probeUrl, state: "UNKNOWN", reason: "已停用：select_entry.php 不能被擴充功能請求（會觸發登出）", finalUrl: "", status: 0 });
                continue;
            }
            try {
                const resp = await fetch(probeUrl, { credentials: "include", redirect: "follow", cache: "no-store" });
                const html = (await resp.text()).slice(0, 200000);
                const verdict = classify({ finalUrl: resp.url, status: resp.status, html }, target);
                // 偵錯用的頁面文字摘要：標籤去除，連續數字（學號等）遮罩，避免把個人資料完整回傳
                const snippet = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").replace(/\d{3,}/g, "###").trim().slice(0, 300);
                results.push({ id: target.id, label: target.label, probeUrl, ...verdict, finalUrl: resp.url, status: resp.status, snippet });
            }
            catch (error) {
                results.push({ id: target.id, label: target.label, probeUrl: target.probeUrl, state: "UNKNOWN", reason: String(error?.message ?? error), finalUrl: "", status: 0 });
            }
        }
        const cookies = {};
        for (const domain of [...new Set(TARGETS.flatMap((t) => t.cookieDomains))]) {
            const list = await chrome.cookies.getAll({ domain });
            cookies[domain] = list.map((c) => ({ name: c.name, secure: c.secure, httpOnly: c.httpOnly, session: c.session, sameSite: c.sameSite, path: c.path }));
        }
        return { results, cookies, checkedAt: new Date().toISOString() };
    }

    async function handleIncomingCommand(cmd) {
        const { callId, action, params = {} } = cmd;
        let result = null;

        console.log(`[MCP Bridge Client] 正在向真實 eeclass 執行指令 [${action}]:`, params);

        switch (action) {
            case "open_extension_wizard":
            case "open_wizard":
                if (chrome?.tabs?.create) {
                    const sessionParam = params.session ? `&session=${encodeURIComponent(params.session)}` : "";
                    const callerParam = params.caller ? `&caller=${encodeURIComponent(params.caller)}` : "";
                    const wizardTab = await chrome.tabs.create({
                        url: chrome.runtime.getURL(`options.html?mode=full&wizard=1${sessionParam}${callerParam}`)
                    });
                    result = {
                        opened: true,
                        tabId: wizardTab.id,
                        url: wizardTab.url
                    };
                } else {
                    result = { opened: false, error: "chrome.tabs API not available" };
                }
                break;

            case "check_setup_status":
                let authCheck = false;
                try {
                    const res = await chrome.storage.local.get(["eeclassAuthConfig"]);
                    authCheck = Boolean(res?.eeclassAuthConfig?.id);
                } catch (e) {}
                result = {
                    installed: true,
                    extensionId: chrome.runtime.id,
                    hasCredentials: authCheck,
                    wizardUrl: chrome.runtime.getURL("options.html?mode=full&wizard=1")
                };
                break;

            case "get_live_courses":
            case "wake_and_bootstrap_eeclass":
            case "get_classified_courses":
                result = await fetchLiveCourses();
                break;

            case "get_course_sidebar_info":
                result = await runLive(() => liveSidebar(params.courseId));
                break;

            case "list_course_resources":
                result = await runLive(() => globalScope.EeclassLive.getCourseResources(params.courseId, params.kinds));
                break;

            case "get_course_resource":
                result = await runLive(() => globalScope.EeclassLive.getResource(params.courseId, params.kind, params.id));
                break;

            case "list_homeworks":
                result = await runLive(() => globalScope.EeclassLive.listHomeworks(params.courseId).then(items => ({ courseId: Number(params.courseId), count: items.length, homeworks: items })));
                break;

            case "list_exams":
                result = await runLive(() => globalScope.EeclassLive.listExams(params.courseId).then(items => ({ courseId: Number(params.courseId), count: items.length, exams: items })));
                break;

            case "list_bulletins":
                result = await runLive(() => globalScope.EeclassLive.listBulletins(params.courseId).then(items => ({ courseId: Number(params.courseId), count: items.length, bulletins: items })));
                break;

            case "get_homework_detail":
                result = await runLive(() => globalScope.EeclassLive.getResource(params.courseId, "homework", params.homeworkId));
                break;

            case "list_homework_submissions":
                result = await runLive(() => globalScope.EeclassLive.listHomeworkSubmissions(params.homeworkId).then(items => ({ homeworkId: Number(params.homeworkId), count: items.length, submissions: items })));
                break;

            case "get_exam_detail":
                result = await runLive(() => globalScope.EeclassLive.getExamDetail(params.examId));
                break;

            case "persist_course_snapshot":
                result = await runLive(async () => {
                    const snapshot = await globalScope.EeclassLive.buildCourseSnapshot(params.courseId, params);
                    const resp = await fetch("http://127.0.0.1:3001/extension/persist", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify(snapshot)
                    });
                    const saved = await resp.json();
                    return { ...saved, courseId: snapshot.courseId, itemCount: snapshot.items.length };
                });
                break;

            case "create_bulletin":
                result = await runLive(() => globalScope.EeclassLive.createBulletin(params.courseId, params));
                break;

            case "update_bulletin":
                result = await runLive(() => globalScope.EeclassLive.updateBulletin(params.courseId, params.bulletinId, params));
                break;

            case "delete_bulletin":
                result = await runLive(() => globalScope.EeclassLive.deleteBulletin(params.courseId, params.bulletinId));
                break;

            case "send_bulletin_notify":
                result = await runLive(() => globalScope.EeclassLive.sendBulletinNotify(params.courseId, params.bulletinId));
                break;

            case "delete_exam":
                result = await runLive(() => globalScope.EeclassLive.deleteExam(params.courseId, params.examId));
                break;

            case "create_homework":
                result = await runLive(() => globalScope.EeclassUi.createPersonalHomework(params.courseId, params));
                break;

            case "delete_homework":
                result = await runLive(() => globalScope.EeclassUi.deleteHomework(params.courseId, params.homeworkId));
                break;

            case "audit_homework_submission":
                result = await runLive(() => globalScope.EeclassUi.auditHomework(params.reportId, params));
                break;

            case "reject_homework_submission":
                result = await runLive(() => globalScope.EeclassUi.rejectHomework(params.reportId, params.reason));
                break;

            case "package_download_homework":
                result = await runLive(() => globalScope.EeclassUi.downloadHomeworkPackage(params.homeworkId, { action: "package" }));
                break;

            case "export_homework_submissions":
                result = await runLive(() => globalScope.EeclassUi.downloadHomeworkPackage(params.homeworkId, { action: "export", mode: params.mode, reportIds: params.reportIds }));
                break;

            case "list_unsubmitted_students":
                result = await runLive(() => globalScope.EeclassLive.listUnsubmitted(params.homeworkId).then(students => ({ homeworkId: Number(params.homeworkId), count: students.length, students })));
                break;

            case "get_exam_record_detail":
                result = await runLive(() => globalScope.EeclassLive.getExamRecordDetail(params.courseId, params.examId, params.recordId));
                break;

            case "audit_essay_question":
                result = await runLive(async () => {
                    const { recordPath } = await globalScope.EeclassLive.resolveExamRecordPath(params.courseId, params.examId, params.recordId);
                    return globalScope.EeclassUi.auditEssay(recordPath, params);
                });
                break;

            case "delete_student_exam_attempt":
                result = await runLive(async () => {
                    const membersPath = await globalScope.EeclassLive.resolveMembersPath(params.courseId, params.examId);
                    return globalScope.EeclassUi.deleteAttemptAt(membersPath, params.examId, params.recordId);
                });
                break;

            case "copy_homework":
                result = await runLive(async () => {
                    const src = await globalScope.EeclassLive.getResource(params.courseId, "homework", params.sourceHomeworkId);
                    const s = src.settings || {};
                    const mapPct = (v) => (String(v || "").match(/\d+/) || ["0"])[0];
                    const auditMode = /評分表/.test(s["評分方式"] || "") ? "2" : "1";
                    const gradeSearch = /結束後/.test(s["成績查詢"] || "") ? "1" : "2";
                    const view = /截止後/.test(s["作業觀摩"] || "") ? "3" : (/開放/.test(s["作業觀摩"] || "") && !/不開放/.test(s["作業觀摩"] || "") ? "1" : "2");
                    return globalScope.EeclassUi.createPersonalHomework(params.courseId, {
                        title: params.newTitle,
                        description: (src.settings && src.settings["說明"]) || "",
                        startDate: params.newStartDate,
                        deadline: params.newDeadline,
                        allowDelay: /是/.test(s["允許遲交"] || ""),
                        weight: mapPct(s["成績比重"]),
                        auditMode,
                        gradeSearch,
                        view,
                        draft: false
                    });
                });
                break;

            case "copy_bulletin":
                result = await runLive(async () => {
                    const src = await globalScope.EeclassLive.getBulletinDetail(params.sourceBulletinId);
                    return globalScope.EeclassLive.createBulletin(params.courseId, { title: params.newTitle, content: src.content || "", topMost: !!params.topMost });
                });
                break;

            case "api_call":
                result = await runLive(() => globalThis.EECLASS_EXTENSION_SERVER.dispatchApiRequest(params.request));
                break;

            case "login_probe":
                result = await runLoginProbe(params);
                break;
            default:
                result = { error: `擴充功能不支援的指令：${action}` };
                break;
        }

        // 回報真實結果至 Bridge
        try {
            await fetch(BRIDGE_REPLY_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    callId,
                    action,
                    result,
                    extensionId: chrome?.runtime?.id || "nthu-eeclass-copilot",
                    timestamp: Date.now()
                })
            });
        } catch (err) {
            console.error(`[MCP Bridge Client] 回報執行結果失敗:`, err);
        }
    }

    async function sendExtensionHeartbeat() {
        if (!chrome?.runtime?.id) return;
        let hasCreds = false;
        try {
            const res = await chrome.storage.local.get(["eeclassAuthConfig"]);
            hasCreds = Boolean(res?.eeclassAuthConfig?.id && (res?.eeclassAuthConfig?.password || res?.eeclassAuthConfig?.cipherText));
        } catch (e) {}

        try {
            await fetch("http://127.0.0.1:3001/extension/ack", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    installed: true,
                    extensionId: chrome.runtime.id,
                    version: "1.4.0",
                    wizardUrl: chrome.runtime.getURL("options.html?mode=full&wizard=1"),
                    optionsUrl: chrome.runtime.getURL("options.html?mode=full"),
                    hasCredentials: hasCreds,
                    timestamp: Date.now()
                })
            });
        } catch (e) {}
    }

    /**
     * 啟動長輪詢迴圈
     */
    async function startLongPolling() {
        if (isPolling) return;
        isPolling = true;

        await sendExtensionHeartbeat();
        setInterval(sendExtensionHeartbeat, 45000);

        while (isPolling) {
            try {
                const resp = await fetch(BRIDGE_POLL_URL, {
                    method: "GET",
                    headers: { "Content-Type": "application/json" }
                });

                if (resp.ok) {
                    pollFailCount = 0;
                    const data = await resp.json();
                    if (data && data.hasCommand && data.command) {
                        await handleIncomingCommand(data.command);
                    }
                } else {
                    pollFailCount++;
                }
            } catch (e) {
                pollFailCount++;
                // 若 Bridge 未啟動，暫緩重試 (指數退避)
                const delayMs = Math.min(10000, 2000 * Math.pow(1.5, Math.min(pollFailCount, 5)));
                await new Promise(r => setTimeout(r, delayMs));
            }

            // 保持小間隔避免吃滿 CPU
            await new Promise(r => setTimeout(r, 600));
        }
    }

    // 啟動監聽
    startLongPolling();

    globalScope.EECLASS_MCP_CLIENT = {
        fetchLiveCourses,
        getCourseResources: (courseId, kinds) => globalScope.EeclassLive.getCourseResources(courseId, kinds),
        getResource: (courseId, kind, id) => globalScope.EeclassLive.getResource(courseId, kind, id)
    };
})(typeof self !== "undefined" ? self : globalThis);
