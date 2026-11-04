/**
 * NTHU eeclass Copilot - 真實課程身分掃描（options 精靈與 MCP Bridge 共用）
 *
 * 資料來源（依「助教、老師要開發的功能及開發必要指引／總論」已確認的頁面結構）：
 *   1. 「我的課程」列表：每個 `a[href="/course/數字"]` 為課程 ID，括號內為課程代碼。
 *   2. 課程頁側欄 `div.mod_course-courseSidebar`：「老師:」「助教:」「身份:」
 *      （「身份」只在有特殊身份時出現，例如助教；一般修課學生沒有此欄）。
 *
 * 本檔不使用 DOMParser，改以正規表示式解析，可同時在 options 頁面與 Service Worker 執行。
 * 無法從課程頁確認身分的課程會放入 unverifiedCourses，不會被猜測為助教或學生。
 */

(function initEeclassCourseScan(globalScope) {
    "use strict";

    const EECLASS_BASE = "https://eeclass.nthu.edu.tw";
    const COURSE_LINK_SOURCE = "<a\\b[^>]*href=[\"'](?:https:\\/\\/eeclass\\.nthu\\.edu\\.tw)?\\/course\\/(\\d+)[\"'][^>]*>([\\s\\S]*?)<\\/a>";
    const CONCURRENCY = 4;

    function stripTags(html) {
        return String(html || "")
            .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
            .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
            .replace(/<[^>]+>/g, " ")
            .replace(/&nbsp;/g, " ")
            .replace(/&amp;/g, "&")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&#039;|&#39;/g, "'")
            .replace(/&quot;/g, '"')
            .replace(/\s+/g, " ")
            .trim();
    }

    /** 是否為登入／OAuth 頁面（未登入時 eeclass 會導向這裡） */
    function isLoginPage(html) {
        const src = String(html || "");
        return /oauth\.ccxp\.nthu\.edu\.tw|id=["']captcha|captchaimg|請輸入密碼/i.test(src);
    }

    /** 「我的課程」或首頁是否看得到已登入的內容 */
    function isLoggedInHtml(html) {
        if (!html || isLoginPage(html)) return false;
        return /我的課程|登出|logout/i.test(html) || parseCourseLinks(html).length > 0;
    }

    /** 解析「我的課程」列表中的課程連結（去除重複） */
    function parseCourseLinks(html) {
        const src = String(html || "");
        const re = new RegExp(COURSE_LINK_SOURCE, "gi");
        const seen = new Set();
        const links = [];
        let m;
        while ((m = re.exec(src)) !== null) {
            const courseId = parseInt(m[1], 10);
            if (!courseId || seen.has(courseId)) continue;
            seen.add(courseId);

            const inner = m[2];
            const text = stripTags(inner);
            const codeMatch =
                inner.match(/fs-banner-extInfo[^>]*>\s*\(([^)]+)\)/i) ||
                text.match(/\(([0-9]{3,6}[A-Z0-9]{3,})\)/i) ||
                text.match(/代碼[:：]\s*([A-Za-z0-9_-]+)/);
            const courseCode = codeMatch ? codeMatch[1].trim() : "";
            const courseName = text.replace(/\([^)]*\)/g, "").replace(/代碼[:：].*$/, "").trim();

            links.push({ courseId, courseCode, courseName });
        }
        return links;
    }

    function splitNames(raw) {
        return String(raw || "")
            .split(/[,、\s]+/)
            .map(s => s.trim())
            .filter(Boolean);
    }

    /** 解析課程頁側欄（div.mod_course-courseSidebar） */
    function parseSidebar(html, courseId) {
        const src = String(html || "");
        const start = src.search(/mod_course-courseSidebar|course-sidebar/);
        const segment = start >= 0 ? src.slice(start, start + 6000) : "";
        const text = stripTags(segment);

        const identityMatch = text.match(/身份[:：]\s*(\S+)/);
        const identity = identityMatch ? identityMatch[1] : "";
        const teacherMatch = text.match(/老師[:：]\s*(.{1,120}?)(?=\s(?:助教|身份)[:：]|$)/);
        const taMatch = text.match(/助教[:：]\s*(.{1,120}?)(?=\s(?:老師|身份)[:：]|$)/);

        const bannerMatch = src.match(/fs-banner-extInfo[^>]*>\s*\(([^)]+)\)/i);
        const titleMatch = src.match(/fs-banner-courseTitle[^>]*>([\s\S]*?)<\/(?:h1|h2|div|span|a|p)>/i);
        const pageTitleMatch = src.match(/<title>([\s\S]*?)<\/title>/i);

        return {
            courseId,
            courseCode: bannerMatch ? bannerMatch[1].trim() : "",
            courseName: titleMatch ? stripTags(titleMatch[1]) : (pageTitleMatch ? stripTags(pageTitleMatch[1]).split(/\s[-|｜]\s/)[0] : ""),
            teachers: teacherMatch ? splitNames(teacherMatch[1]) : [],
            assistants: taMatch ? splitNames(taMatch[1]) : [],
            currentUserIdentity: identity,
            isTeacher: /老師|教師/.test(identity),
            isTA: /助教/.test(identity)
        };
    }

    async function fetchText(url) {
        if (globalScope.EeclassTransport) {
            const r = await globalScope.EeclassTransport.request(url, {});
            return { url, status: r.status, html: r.html };
        }
        const resp = await fetch(url, { credentials: "include" });
        const html = await resp.text();
        return { url, status: resp.status, html };
    }

    /**
     * 掃描目前登入帳號的所有課程並分類。
     * @returns {Promise<{loggedIn:boolean, message?:string, teachingCourses:Array, studentCourses:Array, unverifiedCourses:Array, allCourses:Array}>}
     */
    async function scanCourses(options) {
        const onProgress = (options && options.onProgress) || (() => {});

        let home = await fetchText(`${EECLASS_BASE}/home.php`);
        if (!isLoggedInHtml(home.html)) {
            const dash = await fetchText(`${EECLASS_BASE}/dashboard`);
            if (isLoggedInHtml(dash.html)) home = dash;
        }
        if (!isLoggedInHtml(home.html)) {
            return {
                loggedIn: false,
                message: "eeclass 尚未登入。請先在 Chrome 中開啟 eeclass 並完成登入後再掃描。",
                teachingCourses: [],
                studentCourses: [],
                unverifiedCourses: [],
                allCourses: []
            };
        }

        const links = parseCourseLinks(home.html);
        const entries = [];

        for (let i = 0; i < links.length; i += CONCURRENCY) {
            const batch = links.slice(i, i + CONCURRENCY);
            const settled = await Promise.all(batch.map(async link => {
                try {
                    const page = await fetchText(`${EECLASS_BASE}/course/${link.courseId}`);
                    if (isLoginPage(page.html)) {
                        return { ...link, role: "unverified", reason: "課程頁要求重新登入" };
                    }
                    const sb = parseSidebar(page.html, link.courseId);
                    return buildEntry(link, sb);
                } catch (e) {
                    return { ...link, role: "unverified", reason: e.message || String(e) };
                }
            }));
            entries.push(...settled);
            onProgress(Math.min(i + CONCURRENCY, links.length), links.length);
        }

        const teachingCourses = entries.filter(e => e.role === "teacher" || e.role === "assistant");
        const studentCourses = entries.filter(e => e.role === "student");
        const unverifiedCourses = entries.filter(e => e.role === "unverified");

        return {
            loggedIn: true,
            teachingCourses,
            studentCourses,
            unverifiedCourses,
            allCourses: entries
        };
    }

    function buildEntry(link, sb) {
        const courseCode = link.courseCode || sb.courseCode || `CRS${link.courseId}`;
        const courseName = link.courseName || sb.courseName || `課程 #${link.courseId}`;

        if (sb.isTeacher) {
            return {
                courseId: link.courseId, courseCode, courseName,
                role: "teacher", identityLabel: "授課教師", isTeaching: true,
                permissions: "作業CRUD / 批改 / 測驗 / 公告"
            };
        }
        if (sb.isTA) {
            return {
                courseId: link.courseId, courseCode, courseName,
                role: "assistant", identityLabel: "助教", isTeaching: true,
                permissions: "作業CRUD / 批改 / 測驗 / 公告"
            };
        }
        return {
            courseId: link.courseId, courseCode, courseName,
            role: "student", identityLabel: "學生", isTeaching: false,
            permissions: "瀏覽 / 繳交"
        };
    }

    globalScope.EeclassCourseScan = {
        scanCourses,
        parseCourseLinks,
        parseSidebar,
        isLoggedInHtml,
        isLoginPage
    };
})(typeof self !== "undefined" ? self : (typeof window !== "undefined" ? window : globalThis));
