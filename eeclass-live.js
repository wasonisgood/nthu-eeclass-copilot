/**
 * NTHU eeclass Copilot - 真實 eeclass 資料層（Service Worker 與 options 頁共用）
 *
 * 所有資料都直接由登入中的 eeclass 頁面讀取，不回填任何預設值。
 * 讀取失敗時回傳錯誤（error 欄位），不會假裝成功。
 *
 * 兩層介面：
 *   1. 資源索引 getCourseResources(courseId)：列出課程內所有可取用的資源（作業、測驗、公告、教材），只含標題與 ID，不含內容。
 *   2. 單項取用 getResource(courseId, kind, id)：依資源種類與 ID 讀取完整內容（設定、說明、附件、名單等）。
 *
 * 路徑與選擇器來源：「助教、老師要開發的功能及開發必要指引／總論」已在頁面上確認的結構。
 * 解析以正規表示式為主，不依賴 DOMParser，可在 Service Worker 執行。
 */

(function initEeclassLive(globalScope) {
    "use strict";

    const BASE = "https://eeclass.nthu.edu.tw";
    const RESOURCE_KINDS = ["homework", "exam", "bulletin", "material"];

    class LoginRequiredError extends Error {
        constructor(path) {
            super(`eeclass 尚未登入或工作階段已過期（${path}）`);
            this.name = "LoginRequiredError";
        }
    }

    function decodeEntities(s) {
        return String(s || "")
            .replace(/&nbsp;/g, " ")
            .replace(/&amp;/g, "&")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&quot;/g, '"')
            .replace(/&#0?39;/g, "'")
            .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)));
    }

    function strip(html) {
        return decodeEntities(String(html || "")
            .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
            .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
            .replace(/<br\s*\/?>/gi, "\n")
            .replace(/<[^>]+>/g, " "))
            .replace(/[ \t\f\v ]+/g, " ")
            .replace(/\s*\n\s*/g, "\n")
            .trim();
    }

    function absUrl(href) {
        try { return new URL(href, BASE).href; } catch (e) { return ""; }
    }

    async function getHtml(path, init) {
        let status;
        let html;
        if (globalScope.EeclassTransport) {
            const r = await globalScope.EeclassTransport.request(path, init || {});
            status = r.status;
            html = r.html;
        } else {
            const resp = await fetch(BASE + path, { credentials: "include", redirect: "follow", ...(init || {}) });
            status = resp.status;
            html = await resp.text();
        }
        if (globalScope.EeclassCourseScan && globalScope.EeclassCourseScan.isLoginPage(html)) {
            throw new LoginRequiredError(path);
        }
        if (status >= 400) {
            throw new Error(`eeclass 回應 HTTP ${status}（${path}）`);
        }
        return html;
    }

    function tableRows(html) {
        return String(html || "").match(/<tr[\s\S]*?<\/tr>/gi) || [];
    }

    function cellTexts(row) {
        return (row.match(/<td[\s\S]*?<\/td>/gi) || []).map(strip);
    }

    /** dt/dd 成對欄位（作業、測驗詳細頁的設定區） */
    function definitionPairs(html) {
        const out = {};
        const re = /<dt[^>]*>([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/gi;
        let m;
        while ((m = re.exec(String(html || ""))) !== null) {
            const key = strip(m[1]);
            if (key && !(key in out)) out[key] = strip(m[2]);
        }
        return out;
    }

    function fileLinks(html) {
        const files = [];
        const re = /<a[^>]*href=["']([^"']*\/(?:filedownload|download)\/[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
        let m;
        while ((m = re.exec(String(html || ""))) !== null) {
            files.push({ name: strip(m[2]) || "附件", url: absUrl(decodeEntities(m[1])) });
        }
        return files;
    }

    function dates(text) {
        return (String(text || "").match(/\d{4}[-/]\d{2}[-/]\d{2}(?:\s+\d{2}:\d{2})?/g) || []);
    }

    function pageTitle(html, fallback) {
        const h = String(html || "").match(/<h[1-3][^>]*class=["'][^"']*(?:title|Title)[^"']*["'][^>]*>([\s\S]*?)<\/h[1-3]>/i)
            || String(html || "").match(/fs-banner-courseTitle[^>]*>([\s\S]*?)<\/(?:h1|h2|div|span|a|p)>/i)
            || String(html || "").match(/<title>([\s\S]*?)<\/title>/i);
        const t = h ? strip(h[1]) : "";
        return t || fallback || "";
    }

    // ---------- 作業 ----------

    async function listHomeworks(courseId) {
        const html = await getHtml(`/course/homeworkList/${courseId}`);
        const items = [];
        const seen = new Set();
        for (const row of tableRows(html)) {
            const link = row.match(/href=["'](?:https?:\/\/eeclass\.nthu\.edu\.tw)?\/course\/homework\/(\d+)["'][^>]*>([\s\S]*?)<\/a>/i);
            if (!link) continue;
            const id = parseInt(link[1], 10);
            if (seen.has(id)) continue;
            seen.add(id);
            const text = strip(row);
            const frac = text.match(/(\d+)\s*\/\s*(\d+)/);
            const d = dates(text);
            items.push({
                kind: "homework",
                id,
                title: strip(link[2]),
                submittedCount: frac ? parseInt(frac[1], 10) : null,
                gradedCount: frac ? parseInt(frac[2], 10) : null,
                openAt: d[0] || null,
                deadline: d[1] || null,
                url: `${BASE}/course/homework/${id}`
            });
        }
        return items;
    }

    async function getHomeworkDetail(homeworkId) {
        const html = await getHtml(`/course/homework/${homeworkId}`);
        const settings = definitionPairs(html);
        const attachments = fileLinks(html);
        return {
            kind: "homework",
            id: Number(homeworkId),
            title: pageTitle(html, `作業 #${homeworkId}`),
            settings,
            attachments,
            url: `${BASE}/course/homework/${homeworkId}`
        };
    }

    async function listHomeworkSubmissions(homeworkId) {
        const html = await getHtml(`/homework/submitList/${homeworkId}`);
        const items = [];
        for (const row of tableRows(html)) {
            const link = row.match(/href=["'][^"']*\/homework\/report\/(\d+)["']/i);
            if (!link) continue;
            const cells = cellTexts(row);
            const titleCell = (row.match(/<a[^>]*href=["'][^"']*\/homework\/report\/\d+["'][^>]*>([\s\S]*?)<\/a>/i) || [])[1];
            const label = titleCell ? strip(titleCell) : "";
            const scoreInput = row.match(/class=["'][^"']*scoreInput[^"']*["'][^>]*value=["']([^"']*)["']/i)
                || row.match(/value=["']([^"']*)["'][^>]*class=["'][^"']*scoreInput/i);
            const scoreView = (row.match(/class=["'][^"']*scoreView[^"']*["'][^>]*>([\s\S]*?)<\/a>/i) || [])[1];
            items.push({
                kind: "submission",
                reportId: parseInt(link[1], 10),
                studentLabel: label.split("_")[0] || cells[2] || "",
                submittedAt: dates(cells.join(" "))[0] || null,
                score: scoreInput ? scoreInput[1] : (scoreView ? strip(scoreView) : null)
            });
        }
        return items;
    }

    // ---------- 測驗 ----------

    async function listExams(courseId) {
        const html = await getHtml(`/course/examList/${courseId}`);
        const items = [];
        const seen = new Set();
        for (const row of tableRows(html)) {
            const link = row.match(/href=["'](?:https?:\/\/eeclass\.nthu\.edu\.tw)?\/course\/exam\/(\d+)["'][^>]*>([\s\S]*?)<\/a>/i);
            if (!link) continue;
            const id = parseInt(link[1], 10);
            if (seen.has(id)) continue;
            seen.add(id);
            const kexam = row.match(/\/kexam\/(\d+)\//i);
            const testedMatch = strip(row).match(/已測驗\s*[:：]?\s*(\d+)/);
            const d = dates(strip(row));
            items.push({
                kind: "exam",
                id,
                title: strip(link[2]),
                testedCount: testedMatch ? parseInt(testedMatch[1], 10) : null,
                kexamId: kexam ? parseInt(kexam[1], 10) : null,
                startAt: d[0] || null,
                endAt: d[1] || null,
                url: `${BASE}/course/exam/${id}`
            });
        }
        return items;
    }

    async function getExamDetail(examId) {
        const html = await getHtml(`/course/exam/${examId}`);
        return {
            kind: "exam",
            id: Number(examId),
            title: pageTitle(html, `測驗 #${examId}`),
            settings: definitionPairs(html),
            url: `${BASE}/course/exam/${examId}`
        };
    }

    // ---------- 公告 ----------

    async function listBulletins(courseId) {
        const html = await getHtml(`/course/bulletin/${courseId}`);
        const items = [];
        const seen = new Set();
        for (const row of tableRows(html)) {
            const titleLink = row.match(/<a[^>]*class=["'][^"']*fs-bulletin-item[^"']*["'][^>]*>([\s\S]*?)<\/a>/i);
            if (!titleLink) continue;
            const idMatch = row.match(/\/bulletin\/editContent\/(\d+)\//i) || row.match(/\/bulletin\/(\d+)/i);
            const id = idMatch ? parseInt(idMatch[1], 10) : null;
            if (id === null || seen.has(id)) continue;
            seen.add(id);
            const cells = cellTexts(row);
            items.push({
                kind: "bulletin",
                id,
                num: cells[0] || null,
                title: strip(titleLink[1]),
                date: dates(cells.join(" "))[0] || null,
                isTopMost: /fa-thumbtack|HOT|置頂/.test(row),
                url: `${BASE}/bulletin/editContent/${id}/`
            });
        }
        return items;
    }

    /** 公告內容：讀取編輯表單的既有值（唯讀，不送出） */
    async function getBulletinDetail(bulletinId) {
        const html = await getHtml(`/bulletin/editContent/${bulletinId}/`);
        const val = (name) => {
            const m = html.match(new RegExp(`<input[^>]*name=["']${name}["'][^>]*value=["']([^"']*)["']`, "i"))
                || html.match(new RegExp(`<input[^>]*value=["']([^"']*)["'][^>]*name=["']${name}["']`, "i"));
            return m ? decodeEntities(m[1]) : null;
        };
        const content = (html.match(/<textarea[^>]*name=["']content["'][^>]*>([\s\S]*?)<\/textarea>/i) || [])[1];
        return {
            kind: "bulletin",
            id: Number(bulletinId),
            title: val("title"),
            periodStart: val("period_start"),
            periodEnd: val("period_end"),
            content: content ? strip(content) : null,
            attachments: fileLinks(html),
            url: `${BASE}/bulletin/editContent/${bulletinId}/`
        };
    }

    // ---------- 教材 ----------

    async function listMaterials(courseId) {
        const html = await getHtml(`/course/material/${courseId}`);
        const items = [];
        const seen = new Set();
        for (const f of fileLinks(html)) {
            if (seen.has(f.url)) continue;
            seen.add(f.url);
            items.push({ kind: "material", id: f.url, title: f.name, url: f.url });
        }
        return items;
    }

    // ---------- 資源索引與單項取用 ----------

    /**
     * 列出課程所有資源（只含清單，不含內容）。
     * 任何一類讀取失敗會記在 errors，其他類別照常回傳。
     */
    async function getCourseResources(courseId, kinds) {
        const want = (Array.isArray(kinds) && kinds.length ? kinds : RESOURCE_KINDS)
            .filter(k => RESOURCE_KINDS.includes(k));
        const loaders = {
            homework: () => listHomeworks(courseId),
            exam: () => listExams(courseId),
            bulletin: () => listBulletins(courseId),
            material: () => listMaterials(courseId)
        };
        const resources = [];
        const errors = {};
        for (const k of want) {
            try {
                resources.push(...await loaders[k]());
            } catch (e) {
                if (e.name === "LoginRequiredError") throw e;
                errors[k] = e.message;
            }
        }
        return { courseId: Number(courseId), kinds: want, count: resources.length, resources, errors };
    }

    /** 依種類讀取單一資源的完整內容 */
    async function getResource(courseId, kind, id) {
        switch (kind) {
            case "homework": {
                const detail = await getHomeworkDetail(id);
                detail.submissions = await listHomeworkSubmissions(id);
                return detail;
            }
            case "exam":
                return getExamDetail(id);
            case "bulletin":
                return getBulletinDetail(id);
            case "material": {
                // 教材的 id 即檔案網址；只回傳檔案中繼資料，檔案內容由 persistCourse 另行下載
                return { kind: "material", id, url: id, courseId: Number(courseId) };
            }
            default:
                throw new Error(`不支援的資源種類：${kind}`);
        }
    }

    /**
     * 將課程快照（索引＋各資源內容）回傳給 Bridge 持久化。
     * 教材檔案若小於 maxFileBytes 會以 base64 一併傳回，供 MCP 直接讀取。
     */
    async function buildCourseSnapshot(courseId, opts) {
        const options = opts || {};
        const maxItems = options.maxItemsPerKind || 50;
        const maxFileBytes = options.maxFileBytes || 5 * 1024 * 1024;
        const index = await getCourseResources(courseId, options.kinds);
        const items = [];
        const kindCount = {};
        for (const r of index.resources) {
            kindCount[r.kind] = (kindCount[r.kind] || 0) + 1;
            if (kindCount[r.kind] > maxItems) continue;
            try {
                const detail = r.kind === "material" ? { ...r } : await getResource(courseId, r.kind, r.id);
                if (r.kind === "material" && options.includeFiles) {
                    const file = await downloadFile(r.url, maxFileBytes);
                    Object.assign(detail, file);
                }
                items.push(detail);
            } catch (e) {
                if (e.name === "LoginRequiredError") throw e;
                items.push({ kind: r.kind, id: r.id, error: e.message });
            }
        }
        const identity = await globalScope.EeclassCourseScan.parseSidebar(
            await getHtml(`/course/${courseId}`), courseId
        );
        return {
            courseId: Number(courseId),
            courseCode: identity.courseCode,
            courseName: identity.courseName,
            currentUserIdentity: identity.currentUserIdentity,
            generatedAt: new Date().toISOString(),
            index: index.resources,
            indexErrors: index.errors,
            items
        };
    }

    async function downloadFile(url, maxBytes) {
        let status;
        let contentType;
        let size;
        let base64;
        if (globalScope.EeclassTransport) {
            const r = await globalScope.EeclassTransport.requestBinary(url);
            status = r.status; contentType = r.contentType; size = r.size; base64 = r.base64;
        } else {
            const resp = await fetch(url, { credentials: "include" });
            status = resp.status;
            contentType = resp.headers.get("content-type");
            const buf = new Uint8Array(await resp.arrayBuffer());
            size = buf.byteLength;
            let binary = "";
            for (let i = 0; i < buf.length; i += 0x8000) binary += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
            base64 = btoa(binary);
        }
        if (status >= 400) return { fileError: `HTTP ${status}` };
        if (size > maxBytes) return { fileSkipped: `檔案 ${size} bytes 超過上限 ${maxBytes}` };
        return { contentType: contentType || "application/octet-stream", sizeBytes: size, contentBase64: base64 };
    }

    // ---------- 側欄 ----------

    async function getCourseSidebar(courseId) {
        const html = await getHtml(`/course/${courseId}`);
        return globalScope.EeclassCourseScan.parseSidebar(html, Number(courseId));
    }

    // ---------- 表單與寫入 ----------

    function attrOf(tag, name) {
        const m = String(tag).match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*["']([^"']*)["']`, "i"));
        return m ? decodeEntities(m[1]) : null;
    }

    /**
     * 解析含指定欄位的 <form>：回傳 action、method 與目前欄位值（含隱藏欄位與 anticsrf）。
     * boxes 保存所有勾選框（name/value/checked），供依 value 設定。
     */
    function parseForm(html, mustContain) {
        const forms = String(html || "").match(/<form[\s\S]*?<\/form>/gi) || [];
        const form = forms.find(f => mustContain.test(f)) || (mustContain.test(html) ? html : null);
        if (!form) return null;
        const open = (form.match(/<form[^>]*>/i) || [""])[0];
        const fields = {};
        const boxes = [];
        for (const tag of form.match(/<input[^>]*>/gi) || []) {
            const name = attrOf(tag, "name");
            if (!name) continue;
            const type = (attrOf(tag, "type") || "text").toLowerCase();
            if (["file", "submit", "button", "reset"].includes(type)) continue;
            if (type === "checkbox" || type === "radio") {
                const checked = /(?:^|\s)checked(?:\s|>|=|$)/i.test(tag);
                const value = attrOf(tag, "value") || "on";
                boxes.push({ name, value, type, checked });
                if (checked) fields[name] = value;
                continue;
            }
            fields[name] = attrOf(tag, "value") || "";
        }
        for (const tag of form.match(/<textarea[\s\S]*?<\/textarea>/gi) || []) {
            const name = attrOf(tag, "name");
            if (name) fields[name] = decodeEntities(tag.replace(/^<textarea[^>]*>/i, "").replace(/<\/textarea>$/i, ""));
        }
        for (const tag of form.match(/<select[\s\S]*?<\/select>/gi) || []) {
            const name = attrOf(tag, "name");
            if (!name) continue;
            const sel = tag.match(/<option[^>]*selected[^>]*value=["']([^"']*)["']/i)
                || tag.match(/<option[^>]*value=["']([^"']*)["'][^>]*selected/i);
            fields[name] = sel ? decodeEntities(sel[1]) : "";
        }
        return {
            action: absUrl(attrOf(open, "action") || ""),
            method: (attrOf(open, "method") || "POST").toUpperCase(),
            fields,
            boxes
        };
    }

    function setBox(form, value, on) {
        for (const b of form.boxes.filter(b => b.value === value)) {
            if (on) form.fields[b.name] = b.value;
            else delete form.fields[b.name];
        }
    }

    async function submitForm(form, extra) {
        const body = new URLSearchParams();
        const all = { ...form.fields, ...(extra || {}) };
        for (const [k, v] of Object.entries(all)) {
            if (v === undefined || v === null) continue;
            body.append(k, String(v));
        }
        let status;
        let url;
        let text;
        if (globalScope.EeclassTransport) {
            const u = new URL(form.action);
            const r = await globalScope.EeclassTransport.request(u.pathname + u.search, {
                method: form.method,
                body: body.toString(),
                headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", "X-Requested-With": "XMLHttpRequest" }
            });
            status = r.status; url = r.url; text = r.html;
        } else {
            const resp = await fetch(form.action, {
                method: form.method, body, credentials: "include", redirect: "follow",
                headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", "X-Requested-With": "XMLHttpRequest" }
            });
            status = resp.status; url = resp.url; text = await resp.text();
        }
        if (globalScope.EeclassCourseScan.isLoginPage(text)) throw new LoginRequiredError(form.action);
        if (status >= 400) throw new Error(`eeclass 回應 HTTP ${status}（${form.action}）`);
        return { status, url, responsePreview: strip(text).slice(0, 300) };
    }

    function todayIso() {
        return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
    }

    /** 新增公告：開啟新增表單（/bulletin/editContent/0/），填入後送出 */
    async function createBulletin(courseId, input) {
        const form = parseForm(await getHtml(`/bulletin/editContent/0/`), /name=["']title["']/i);
        if (!form) throw new Error("找不到公告表單（/bulletin/editContent/0/）");
        form.fields.title = input.title;
        form.fields.content = input.content || "";
        form.fields.period_start = input.periodStart || todayIso();
        if (input.periodEnd) form.fields.period_end = input.periodEnd;
        setBox(form, "topMost", !!input.topMost);
        setBox(form, "draft", !!input.draft);
        const result = await submitForm(form, {});
        return { action: "create_bulletin", courseId: Number(courseId), ...result };
    }

    /** 編輯公告：讀取既有表單，只覆寫有提供的欄位 */
    async function updateBulletin(courseId, bulletinId, input) {
        const form = parseForm(await getHtml(`/bulletin/editContent/${bulletinId}/`), /name=["']title["']/i);
        if (!form) throw new Error(`找不到公告 #${bulletinId} 的編輯表單`);
        if (input.title !== undefined) form.fields.title = input.title;
        if (input.content !== undefined) form.fields.content = input.content;
        if (input.periodStart !== undefined) form.fields.period_start = input.periodStart;
        if (input.periodEnd !== undefined) form.fields.period_end = input.periodEnd;
        if (input.topMost !== undefined) setBox(form, "topMost", !!input.topMost);
        if (input.draft !== undefined) setBox(form, "draft", !!input.draft);
        const result = await submitForm(form, {});
        return { action: "update_bulletin", courseId: Number(courseId), bulletinId: Number(bulletinId), ...result };
    }

    /** 刪除公告：送出列表操作選單中的刪除端點（/ajax/sys.app.bulletin/del/） */
    async function deleteBulletin(courseId, bulletinId) {
        const form = { action: absUrl("/ajax/sys.app.bulletin/del/"), method: "POST", fields: {} };
        const result = await submitForm(form, { courseId: String(courseId), bulletinId: String(bulletinId) });
        return { action: "delete_bulletin", courseId: Number(courseId), bulletinId: Number(bulletinId), ...result };
    }

    /** 寄信通知：送出 /ajax/sys.app.bulletin/setNotifyMessage/，對象為所有成員（含老師及助教） */
    async function sendBulletinNotify(courseId, bulletinId) {
        const form = { action: absUrl("/ajax/sys.app.bulletin/setNotifyMessage/"), method: "POST", fields: {} };
        const result = await submitForm(form, { courseId: String(courseId), bulletinId: String(bulletinId), sendEmailCourseAllUser: "1" });
        return { action: "send_bulletin_notify", courseId: Number(courseId), bulletinId: Number(bulletinId), ...result };
    }

    /** 刪除測驗：送出 /ajax/sys.pages.course_examList/deleteExamMsg/ */
    async function deleteExam(courseId, examId) {
        const form = { action: absUrl("/ajax/sys.pages.course_examList/deleteExamMsg/"), method: "POST", fields: {} };
        const result = await submitForm(form, { courseId: String(courseId), examId: String(examId) });
        return { action: "delete_exam", courseId: Number(courseId), examId: Number(examId), ...result };
    }

    // ---------- 未交名單（作業） ----------

    async function listUnsubmitted(homeworkId) {
        const html = await getHtml(`/homework/noSubmitList/${homeworkId}`);
        const students = [];
        const seen = new Set();
        for (const row of tableRows(html)) {
            const id = (strip(row).match(/\b(\d{9})\b/) || [])[1];
            if (!id || seen.has(id)) continue;
            seen.add(id);
            const cells = cellTexts(row);
            const nameCell = cells.find(c => c.includes(id)) || "";
            const name = nameCell.replace(id, "").replace(/[()（）\s]+/g, " ").trim();
            students.push({ studentId: id, name: name || null });
        }
        return students;
    }

    // ---------- 測驗作答紀錄 ----------

    /** 找出測驗在名單頁（帶 key 的 membersRecord 網址）的路徑 */
    async function findExamMembersPath(courseId, examId) {
        const html = await getHtml(`/course/examList/${courseId}`);
        for (const row of tableRows(html)) {
            if (!new RegExp(`/course/exam/${examId}(?!\\d)`).test(row)) continue;
            const m = row.match(/href=["']([^"']*\/kexam\/\d+\/membersRecord[^"']*)["']/i);
            if (m) return new URL(decodeEntities(m[1]), BASE).pathname + new URL(decodeEntities(m[1]), BASE).search;
        }
        throw new Error(`找不到測驗 #${examId} 的作答名單連結（可能尚無人作答）`);
    }

    /** 由名單頁找出某筆作答紀錄的完整路徑（含 key） */
    async function resolveExamRecordPath(courseId, examId, recordId) {
        const membersPath = await findExamMembersPath(courseId, examId);
        const html = await getHtml(membersPath);
        const m = html.match(new RegExp(`href=["']([^"']*recordID=${recordId}(?!\\d)[^"']*)["']`, "i"));
        if (!m) throw new Error(`名單中找不到作答紀錄 ${recordId}`);
        const u = new URL(decodeEntities(m[1]), BASE);
        return { membersPath, recordPath: u.pathname + u.search };
    }

    function parseExamRecord(html) {
        const header = {
            name: strip((html.match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i) || [])[1] || "") || null,
            total: (strip(html).match(/(\d+)\s*\/\s*(\d+)/) || []).slice(1).map(Number)
        };
        const parts = html.split(/(?=<div[^>]*class=["'][^"']*kques-item)/i).slice(1);
        const questions = parts.map((b, i) => {
            const essay = /scoreShow/.test(b);
            const questionId = (b.match(/name=["'](essay_audit\d+)["']/i) || [])[1] || null;
            const questionText = strip((b.match(/<div[^>]*class=["'][^"']*\bquestion\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i) || [])[1] || "");
            const explaination = strip((b.match(/<div[^>]*class=["'][^"']*explaination[^"']*["'][^>]*>([\s\S]*?)<\/div>/i) || [])[1] || "");
            const fullScore = Number((strip((b.match(/<div[^>]*class=["'][^"']*\bscore\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i) || [])[1] || "")).match(/\d+/)?.[0] || NaN);
            const scoreText = strip((b.match(/scoreShow[\s\S]*?<\/div>/i) || [""])[0]);
            if (essay) {
                const answer = strip((b.match(/essay-answer-area[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i) || b.match(/essay-answer-area[^>]*>([\s\S]*?)<\/div>/i) || [])[1] || "");
                const score = (scoreText.match(/分數[:：]?\s*(\d+)/) || scoreText.match(/(\d+)/) || [])[1];
                return { index: i + 1, type: "essay", questionId, question: questionText, studentAnswer: answer, explaination, fullScore, score: score ? Number(score) : null, comment: scoreText.replace(/^.*?說明[:：]?/, "").trim() || null };
            }
            const checked = b.match(/<input[^>]*type=["']radio["'][^>]*checked[^>]*>/i);
            const chosen = checked ? (checked[0].match(/value=["']([^"']*)["']/i) || [])[1] : null;
            const correct = (strip(b).match(/正確答案[:：]\s*(\S+)/) || [])[1] || null;
            return { index: i + 1, type: "choice", question: questionText, studentAnswer: chosen, correctAnswer: correct, fullScore, score: null };
        });
        return { ...header, questions };
    }

    async function getExamRecordDetail(courseId, examId, recordId) {
        const { recordPath } = await resolveExamRecordPath(courseId, examId, recordId);
        const html = await getHtml(recordPath);
        return { courseId: Number(courseId), examId: Number(examId), recordId: Number(recordId), ...parseExamRecord(html) };
    }

    /** 測驗作答名單路徑（刪除作答紀錄用） */
    async function resolveMembersPath(courseId, examId) {
        return findExamMembersPath(courseId, examId);
    }

    globalScope.EeclassLive = {
        RESOURCE_KINDS,
        LoginRequiredError,
        listHomeworks,
        getHomeworkDetail,
        listHomeworkSubmissions,
        listExams,
        getExamDetail,
        listBulletins,
        getBulletinDetail,
        listMaterials,
        getCourseResources,
        getResource,
        buildCourseSnapshot,
        getCourseSidebar,
        createBulletin,
        updateBulletin,
        deleteBulletin,
        sendBulletinNotify,
        deleteExam,
        listUnsubmitted,
        resolveExamRecordPath,
        resolveMembersPath,
        getExamRecordDetail,
        parseExamRecord
    };
})(typeof self !== "undefined" ? self : globalThis);
