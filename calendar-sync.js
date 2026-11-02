"use strict";

/**
 * NTHU eeclass -> Google Calendar 自動同步與即時差異更新引擎
 * 支援：
 * 1. Google OAuth 2.0 授權 (chrome.identity.launchWebAuthFlow / getAuthToken)
 * 2. 三種日曆歸檔模式 + 個別課程自訂目標日曆：
 *    - unified_auto: 所有課程一起加入同一個日曆 ("NTHU eeclass 課程事件")
 *    - per_course_auto: 各課程分別自動建立獨立日曆 ("[eeclass] <課程名稱>")
 *    - existing_calendar: 加入使用者指定的既有 Google 日曆
 *    - courseCalendarOverrides: 個別課程可單獨指定「共用日曆」、「各自建新日曆」或「任一既有日曆」
 * 3. 完整事件時間（開放繳交 -> 繳交期限）、合理提醒設定、作業繳交連結嵌入
 * 4. 內容異動偵測 (contentHash)，任何欄位或時間變更皆即時 PATCH 更新至 Google 日曆，若切換目標日曆自動遷移事件
 */
(function initCalendarSyncEngine(globalScope) {
    const CALENDAR_CONFIG_KEY = "eeclassCalendarConfig";
    const CALENDAR_AUTH_KEY = "eeclassCalendarAuth";
    const CALENDAR_SYNC_MAP_KEY = "eeclassCalendarSyncMap";
    const CALENDAR_COURSES_KEY = "eeclassKnownCourses";
    const CALENDAR_CACHED_LIST_KEY = "eeclassCachedGoogleCalendars";
    const ALARM_NAME = "eeclass-calendar-periodic-sync";

    const GOOGLE_CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3";
    const GOOGLE_OAUTH_SCOPE = "https://www.googleapis.com/auth/calendar";
    const UNIFIED_CALENDAR_SUMMARY = "NTHU eeclass 課程事件";
    const COURSE_CALENDAR_PREFIX = "[eeclass] ";

    const DEFAULT_CALENDAR_CONFIG = {
        autoSyncCalendar: true,
        backgroundSyncMinutes: 30,
        // "unified_auto" | "per_course_auto" | "existing_calendar"
        routingMode: "unified_auto",
        selectedExistingCalendarId: "primary",
        unifiedCalendarId: "",
        // { [courseId]: { mode: "follow_global" | "unified" | "per_course" | "existing", calendarId?: string, autoCreatedCalendarId?: string } }
        courseCalendarOverrides: {},
        // "start_to_due_with_deadline_alert" | "start_to_due_single" | "due_focus_single"
        eventSpanMode: "start_to_due_with_deadline_alert",
        reminder1Minutes: 1440, // 提前 1 天 (24 小時)
        reminder2Minutes: 180,  // 提前 3 小時
        reminder3Minutes: 60,   // 提前 1 小時
        enableEmailReminder: false,
        emailReminderMinutes: 1440,
        oauthClientId: "",
    };

    function getStorageLocal(keys) {
        return new Promise((resolve) => {
            chrome.storage.local.get(keys, (res) => resolve(res || {}));
        });
    }

    function setStorageLocal(items) {
        return new Promise((resolve) => {
            chrome.storage.local.set(items, () => resolve());
        });
    }

    async function getCalendarConfig() {
        const res = await getStorageLocal([CALENDAR_CONFIG_KEY]);
        return {
            ...DEFAULT_CALENDAR_CONFIG,
            ...(res[CALENDAR_CONFIG_KEY] || {}),
            courseCalendarOverrides: {
                ...(res[CALENDAR_CONFIG_KEY]?.courseCalendarOverrides || {}),
            },
        };
    }

    async function saveCalendarConfig(partial) {
        const current = await getCalendarConfig();
        const next = {
            ...current,
            ...partial,
            courseCalendarOverrides: {
                ...current.courseCalendarOverrides,
                ...(partial.courseCalendarOverrides || {}),
            },
        };
        await setStorageLocal({ [CALENDAR_CONFIG_KEY]: next });
        await setupPeriodicSyncAlarm(next);
        return next;
    }

    async function getCalendarAuth() {
        const res = await getStorageLocal([CALENDAR_AUTH_KEY]);
        return res[CALENDAR_AUTH_KEY] || {
            accessToken: "",
            expiresAt: 0,
            userEmail: "",
            authMethod: "",
        };
    }

    async function saveCalendarAuth(authData) {
        await setStorageLocal({ [CALENDAR_AUTH_KEY]: authData });
        return authData;
    }

    async function getSyncMap() {
        const res = await getStorageLocal([CALENDAR_SYNC_MAP_KEY]);
        return res[CALENDAR_SYNC_MAP_KEY] || {};
    }

    async function saveSyncMap(map) {
        await setStorageLocal({ [CALENDAR_SYNC_MAP_KEY]: map });
    }

    async function getKnownCourses() {
        const res = await getStorageLocal([CALENDAR_COURSES_KEY]);
        return res[CALENDAR_COURSES_KEY] || {};
    }

    async function recordKnownCourses(coursesList) {
        if (!Array.isArray(coursesList) || coursesList.length === 0) {
            return await getKnownCourses();
        }
        const courses = await getKnownCourses();
        let changed = false;
        for (const c of coursesList) {
            if (!c?.courseId || !c?.courseName) {
                continue;
            }
            const id = String(c.courseId).trim();
            if (!courses[id] || courses[id].courseName !== c.courseName || (c.courseCode && !courses[id].courseCode)) {
                courses[id] = {
                    courseId: id,
                    courseName: c.courseName.trim(),
                    courseCode: c.courseCode || courses[id]?.courseCode || "",
                    autoCalendarId: courses[id]?.autoCalendarId || "",
                    updatedAt: Date.now(),
                };
                changed = true;
            }
        }
        if (changed) {
            await setStorageLocal({ [CALENDAR_COURSES_KEY]: courses });
        }
        return courses;
    }

    /**
     * 取得有效的 Google OAuth Access Token
     * 支援：
     * 1. 已快取且未過期的 Token
     * 2. 若設定有 oauthClientId，透過 chrome.identity.launchWebAuthFlow 取得或靜默續期
     * 3. 若環境支援 chrome.identity.getAuthToken，亦可直接調用
     */
    async function getValidAccessToken(interactive = false) {
        const auth = await getCalendarAuth();
        const now = Date.now();
        if (auth.accessToken && auth.expiresAt > now + 60_000) {
            return { ok: true, token: auth.accessToken, userEmail: auth.userEmail };
        }

        const config = await getCalendarConfig();
        const clientId = (config.oauthClientId || "").trim();

        // 若有設定 OAuth Client ID，優先使用標準 launchWebAuthFlow
        if (clientId && chrome.identity?.launchWebAuthFlow) {
            const silentAttempt = await runWebAuthFlow(clientId, false);
            if (silentAttempt.ok) {
                return silentAttempt;
            }
            if (interactive) {
                return await runWebAuthFlow(clientId, true);
            }
        }

        // 嘗試使用 Chrome 內建 getAuthToken (若 manifest 設定有 oauth2)
        if (chrome.identity?.getAuthToken) {
            try {
                const tokenResult = await new Promise((resolve) => {
                    chrome.identity.getAuthToken({ interactive }, (token) => {
                        if (chrome.runtime.lastError || !token) {
                            resolve({
                                ok: false,
                                error: chrome.runtime.lastError?.message || "無法取得 Google 授權",
                            });
                            return;
                        }
                        resolve({ ok: true, token });
                    });
                });
                if (tokenResult.ok) {
                    const profile = await verifyTokenAndGetEmail(tokenResult.token);
                    const saved = await saveCalendarAuth({
                        accessToken: tokenResult.token,
                        expiresAt: Date.now() + 3500 * 1000,
                        userEmail: profile.email || "",
                        authMethod: "chrome_identity",
                    });
                    return { ok: true, token: saved.accessToken, userEmail: saved.userEmail };
                }
            }
            catch {
                // Ignore and return instructive error below
            }
        }

        return {
            ok: false,
            needsClientId: !clientId,
            redirectUri: chrome.identity?.getRedirectURL ? chrome.identity.getRedirectURL() : "",
            error: clientId
                ? "Google 日曆授權已過期，請點擊「索取 Google 日曆授權」重新授權"
                : "請先輸入 Google OAuth Client ID 或授權 Token 以啟用日曆同步",
        };
    }

    async function runWebAuthFlow(clientId, interactive) {
        try {
            const redirectUri = chrome.identity.getRedirectURL();
            const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
            authUrl.searchParams.set("client_id", clientId);
            authUrl.searchParams.set("response_type", "token");
            authUrl.searchParams.set("redirect_uri", redirectUri);
            authUrl.searchParams.set("scope", `${GOOGLE_OAUTH_SCOPE} https://www.googleapis.com/auth/userinfo.email`);
            authUrl.searchParams.set("include_granted_scopes", "true");
            authUrl.searchParams.set("prompt", interactive ? "consent" : "none");

            const responseUrl = await new Promise((resolve, reject) => {
                chrome.identity.launchWebAuthFlow(
                    {
                        url: authUrl.toString(),
                        interactive,
                    },
                    (redirectUrl) => {
                        if (chrome.runtime.lastError || !redirectUrl) {
                            reject(new Error(chrome.runtime.lastError?.message || "使用者取消或授權失敗"));
                            return;
                        }
                        resolve(redirectUrl);
                    }
                );
            });

            const hashIndex = responseUrl.indexOf("#");
            const hashParams = new URLSearchParams(hashIndex >= 0 ? responseUrl.slice(hashIndex + 1) : "");
            const accessToken = hashParams.get("access_token");
            const expiresIn = Number(hashParams.get("expires_in") || "3599");

            if (!accessToken) {
                return { ok: false, error: "回傳網址未包含 access_token" };
            }

            const profile = await verifyTokenAndGetEmail(accessToken);
            const saved = await saveCalendarAuth({
                accessToken,
                expiresAt: Date.now() + Math.max(300, expiresIn - 60) * 1000,
                userEmail: profile.email || "",
                authMethod: "web_auth_flow",
            });

            return {
                ok: true,
                token: saved.accessToken,
                userEmail: saved.userEmail,
            };
        }
        catch (err) {
            return {
                ok: false,
                error: err?.message || "Google OAuth 授權失敗",
            };
        }
    }

    async function verifyTokenAndGetEmail(accessToken) {
        try {
            const resp = await fetch("https://www.googleapis.com/oauth2/v3/tokeninfo", {
                headers: { Authorization: `Bearer ${accessToken}` },
            });
            if (resp.ok) {
                const data = await resp.json();
                return { ok: true, email: data.email || "已授權 Google 帳號", expiresIn: Number(data.expires_in || 3500) };
            }
        }
        catch {
            // Fallback to calendarList check
        }
        try {
            const calResp = await fetch(`${GOOGLE_CALENDAR_API_BASE}/users/me/calendarList/primary`, {
                headers: { Authorization: `Bearer ${accessToken}` },
            });
            if (calResp.ok) {
                const calData = await calResp.json();
                return { ok: true, email: calData.id || calData.summary || "已授權 Google 帳號", expiresIn: 3500 };
            }
        }
        catch {
            // Ignore
        }
        return { ok: false, email: "" };
    }

    async function bindManualAccessToken(rawToken) {
        const cleanToken = String(rawToken || "").trim();
        if (!cleanToken) {
            return { ok: false, error: "Token 不可為空" };
        }
        const check = await verifyTokenAndGetEmail(cleanToken);
        if (!check.ok) {
            return { ok: false, error: "此 Access Token 無效或未具備 Google Calendar 權限" };
        }
        await saveCalendarAuth({
            accessToken: cleanToken,
            expiresAt: Date.now() + (check.expiresIn || 3500) * 1000,
            userEmail: check.email || "已授權 Google 帳號",
            authMethod: "manual_token",
        });
        const calendars = await listUserCalendars(true);
        return {
            ok: true,
            userEmail: check.email,
            calendars,
        };
    }

    async function disconnectGoogleCalendar() {
        await saveCalendarAuth({
            accessToken: "",
            expiresAt: 0,
            userEmail: "",
            authMethod: "",
        });
        return { ok: true };
    }

    async function googleCalendarFetch(path, options = {}, interactiveRetry = false) {
        const tokenRes = await getValidAccessToken(interactiveRetry);
        if (!tokenRes.ok) {
            throw new Error(tokenRes.error || "尚未取得 Google 日曆授權");
        }

        const url = path.startsWith("http") ? path : `${GOOGLE_CALENDAR_API_BASE}${path}`;
        const headers = {
            Authorization: `Bearer ${tokenRes.token}`,
            "Content-Type": "application/json",
            ...(options.headers || {}),
        };

        const resp = await fetch(url, {
            ...options,
            headers,
        });

        if (resp.status === 401) {
            // Token 失效，清除快取並嘗試靜默重取一次
            const currentAuth = await getCalendarAuth();
            await saveCalendarAuth({ ...currentAuth, accessToken: "", expiresAt: 0 });
            const retryToken = await getValidAccessToken(false);
            if (retryToken.ok) {
                const retryResp = await fetch(url, {
                    ...options,
                    headers: {
                        ...headers,
                        Authorization: `Bearer ${retryToken.token}`,
                    },
                });
                return retryResp;
            }
        }

        return resp;
    }

    /**
     * 讀取使用者帳號內所有可寫入的既有 Google 日曆清單
     */
    async function listUserCalendars(forceRefresh = false) {
        if (!forceRefresh) {
            const cached = await getStorageLocal([CALENDAR_CACHED_LIST_KEY]);
            if (Array.isArray(cached[CALENDAR_CACHED_LIST_KEY]) && cached[CALENDAR_CACHED_LIST_KEY].length > 0) {
                return cached[CALENDAR_CACHED_LIST_KEY];
            }
        }
        try {
            const resp = await googleCalendarFetch("/users/me/calendarList?minAccessRole=writer");
            if (!resp.ok) {
                return [];
            }
            const data = await resp.json();
            const items = (data.items || []).map((cal) => ({
                id: cal.id,
                summary: cal.primary ? `${cal.summary} (主日曆)` : cal.summary,
                rawSummary: cal.summary || "",
                primary: Boolean(cal.primary),
                backgroundColor: cal.backgroundColor || "#9F5FA5",
            }));
            await setStorageLocal({ [CALENDAR_CACHED_LIST_KEY]: items });
            return items;
        }
        catch {
            return [];
        }
    }

    /**
     * 確保目標名稱的日曆存在（若已存在則直接重用，不存在則自動建立）
     */
    async function ensureNamedCalendarExists(summaryName, descriptionText) {
        const calendars = await listUserCalendars(true);
        const existing = calendars.find(
            (c) => c.rawSummary === summaryName || c.summary === summaryName
        );
        if (existing) {
            return existing.id;
        }

        const resp = await googleCalendarFetch("/calendars", {
            method: "POST",
            body: JSON.stringify({
                summary: summaryName,
                description: descriptionText || "由 NTHU eeclass 整合工具自動建立與同步之課程日曆",
                timeZone: "Asia/Taipei",
            }),
        });
        if (!resp.ok) {
            const errText = await resp.text();
            throw new Error(`建立日曆「${summaryName}」失敗 (${resp.status})：${errText}`);
        }
        const created = await resp.json();
        await listUserCalendars(true);
        return created.id;
    }

    /**
     * 依據全域設定與個別課程覆寫設定，決定某門課程應寫入哪一個 Google Calendar ID
     * 支援：
     * - 個別課程一起加入同一個共用日曆 ("unified_auto" / override "unified")
     * - 各課程分別建立一個獨立日曆 ("per_course_auto" / override "per_course")
     * - 加入使用者既有日曆 ("existing_calendar" / override "existing:<calendarId>")
     */
    async function resolveTargetCalendarId(event, config) {
        const courseId = String(event.courseId || "general").trim();
        const courseName = shortenCourseName(event.courseName || "eeclass 課程");
        const override = config.courseCalendarOverrides?.[courseId];

        let effectiveMode = config.routingMode || "unified_auto";
        let specificExistingCalendarId = config.selectedExistingCalendarId || "primary";

        if (override && override.mode && override.mode !== "follow_global") {
            if (override.mode === "unified") {
                effectiveMode = "unified_auto";
            }
            else if (override.mode === "per_course") {
                effectiveMode = "per_course_auto";
            }
            else if (override.mode === "existing") {
                effectiveMode = "existing_calendar";
                specificExistingCalendarId = override.calendarId || specificExistingCalendarId;
            }
        }

        if (effectiveMode === "existing_calendar") {
            return specificExistingCalendarId || "primary";
        }

        if (effectiveMode === "per_course_auto") {
            const courses = await getKnownCourses();
            const savedCalId = courses[courseId]?.autoCalendarId;
            if (savedCalId) {
                const calendars = await listUserCalendars(false);
                if (calendars.some((c) => c.id === savedCalId)) {
                    return savedCalId;
                }
            }
            const calTitle = `${COURSE_CALENDAR_PREFIX}${courseName}`;
            const createdId = await ensureNamedCalendarExists(
                calTitle,
                `國立清華大學 eeclass「${event.courseName || courseName}」課程作業與事件自動同步日曆`
            );
            courses[courseId] = {
                ...(courses[courseId] || { courseId, courseName: event.courseName || courseName }),
                autoCalendarId: createdId,
                updatedAt: Date.now(),
            };
            await setStorageLocal({ [CALENDAR_COURSES_KEY]: courses });
            return createdId;
        }

        // Default: unified_auto (所有課程集中於同一個專屬日曆)
        if (config.unifiedCalendarId) {
            const calendars = await listUserCalendars(false);
            if (calendars.some((c) => c.id === config.unifiedCalendarId)) {
                return config.unifiedCalendarId;
            }
        }
        const unifiedId = await ensureNamedCalendarExists(
            UNIFIED_CALENDAR_SUMMARY,
            "國立清華大學 eeclass 數位學習平台所有課程作業與最近事件整合日曆"
        );
        await saveCalendarConfig({ unifiedCalendarId: unifiedId });
        config.unifiedCalendarId = unifiedId;
        return unifiedId;
    }

    function shortenCourseName(rawName) {
        const cleaned = String(rawName || "").replace(/\s+/g, " ").trim();
        if (!cleaned) {
            return "eeclass 課程";
        }
        // 若同時含中英文課名，優先取中文部分以保持日曆標題清爽
        const zhMatch = /^([\u4e00-\u9fa50-9（）()－\-_、：:·\s]+?)(?:[A-Za-z]{3,}.*)?$/.exec(cleaned);
        const candidate = zhMatch?.[1]?.trim() || cleaned;
        return candidate.length > 26 ? `${candidate.slice(0, 26)}…` : candidate;
    }

    /**
     * 將 eeclass 時間字串 (如 "2026-10-31 00:00" 或 "2026-11-05 17:30:59" 或 "2026-11-05")
     * 轉換為標準 Asia/Taipei (+08:00) Date 與 RFC3339 字串
     */
    function parseEeclassDateTime(rawStr, fallbackTime = "23:59:00") {
        if (!rawStr || typeof rawStr !== "string") {
            return null;
        }
        const s = rawStr.trim().replace(/\//g, "-");
        const fullMatch = /^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})(?::(\d{2}))?/.exec(s);
        if (fullMatch) {
            const datePart = fullMatch[1];
            const hmPart = fullMatch[2];
            const secPart = fullMatch[3] || "00";
            const iso = `${datePart}T${hmPart}:${secPart}+08:00`;
            const ms = Date.parse(iso);
            return Number.isNaN(ms) ? null : { iso, ms };
        }
        const dateOnlyMatch = /^(\d{4}-\d{2}-\d{2})$/.exec(s);
        if (dateOnlyMatch) {
            const iso = `${dateOnlyMatch[1]}T${fallbackTime}+08:00`;
            const ms = Date.parse(iso);
            return Number.isNaN(ms) ? null : { iso, ms };
        }
        return null;
    }

    function formatIsoWithTaipeiOffset(ms) {
        const taipeiMs = ms + 8 * 3600 * 1000;
        const d = new Date(taipeiMs);
        const pad = (n) => String(n).padStart(2, "0");
        const yyyy = d.getUTCFullYear();
        const mm = pad(d.getUTCMonth() + 1);
        const dd = pad(d.getUTCDate());
        const hh = pad(d.getUTCHours());
        const min = pad(d.getUTCMinutes());
        const ss = pad(d.getUTCSeconds());
        return `${yyyy}-${mm}-${dd}T${hh}:${min}:${ss}+08:00`;
    }

    function buildRemindersObject(config) {
        const overrides = [];
        const seen = new Set();

        const addOverride = (method, minutes) => {
            const m = Number(minutes);
            if (!Number.isFinite(m) || m < 0 || m > 40320) {
                return;
            }
            const key = `${method}:${m}`;
            if (seen.has(key)) {
                return;
            }
            seen.add(key);
            overrides.push({ method, minutes: m });
        };

        addOverride("popup", config.reminder1Minutes ?? 1440);
        addOverride("popup", config.reminder2Minutes ?? 180);
        addOverride("popup", config.reminder3Minutes ?? 60);

        if (config.enableEmailReminder) {
            addOverride("email", config.emailReminderMinutes ?? 1440);
        }

        return {
            useDefault: false,
            overrides: overrides.slice(0, 5),
        };
    }

    function computeEventContentHash(event, config, targetCalendarId) {
        const payload = JSON.stringify({
            key: event.key,
            title: event.title || "",
            courseId: event.courseId || "",
            courseName: event.courseName || "",
            courseCode: event.courseCode || "",
            startTime: event.startTime || "",
            dueTime: event.dueTime || "",
            url: event.url || "",
            eventType: event.eventType || "",
            allowLate: event.allowLate || "",
            weight: event.weight || "",
            gradingMethod: event.gradingMethod || "",
            submittedStatus: event.submittedStatus || "",
            description: event.description || "",
            targetCalendarId,
            eventSpanMode: config.eventSpanMode || "start_to_due_with_deadline_alert",
            r1: config.reminder1Minutes,
            r2: config.reminder2Minutes,
            r3: config.reminder3Minutes,
            emailR: config.enableEmailReminder ? config.emailReminderMinutes : -1,
        });

        let hash = 2166136261;
        for (let i = 0; i < payload.length; i++) {
            hash ^= payload.charCodeAt(i);
            hash = Math.imul(hash, 16777619);
        }
        return (hash >>> 0).toString(16);
    }

    /**
     * 組裝要寫入 Google Calendar 的主事件與（選用）截止提醒事件
     */
    function buildGoogleCalendarPayloads(event, config, contentHash) {
        const shortCourse = shortenCourseName(event.courseName || "eeclass");
        const dueParsed = parseEeclassDateTime(event.dueTime, "23:59:00");
        if (!dueParsed) {
            return null;
        }
        const startParsed = parseEeclassDateTime(event.startTime, "00:00:00");

        let mainStartIso;
        let mainEndIso = dueParsed.iso;
        let needsSeparateDeadlineAlert = false;

        const spanMode = config.eventSpanMode || "start_to_due_with_deadline_alert";

        if (spanMode === "due_focus_single" || !startParsed || startParsed.ms >= dueParsed.ms) {
            // 若無開放時間或選擇截止專注時段：開始設為截止前 1 小時，結束為截止時間
            mainStartIso = formatIsoWithTaipeiOffset(dueParsed.ms - 3600 * 1000);
        }
        else {
            // 完整顯示「開放繳交（開始）→ 繳交期限（結束）」
            mainStartIso = startParsed.iso;
            // 若開放時間與截止時間相隔超過 6 小時，且模式為 start_to_due_with_deadline_alert，
            // Google Calendar 的提醒是相對於 start 觸發，因此自動附加一個截止點提醒事件以確保截止前準時響鈴
            if (
                spanMode === "start_to_due_with_deadline_alert" &&
                dueParsed.ms - startParsed.ms > 6 * 3600 * 1000
            ) {
                needsSeparateDeadlineAlert = true;
            }
        }

        const descLines = [
            `🔗 作業繳交與詳情連結：${event.url}`,
            `📚 課程名稱：${event.courseName || "eeclass 課程"}${event.courseCode ? ` (${event.courseCode})` : ""}`,
            `🕒 開放繳交（開始）：${event.startTime || "未標示（依截止前 1 小時計算）"}`,
            `⏰ 繳交期限（結束）：${event.dueTime}`,
        ];

        const metaParts = [];
        if (event.eventType) metaParts.push(`類型：${event.eventType}`);
        if (event.allowLate) metaParts.push(`允許遲交：${event.allowLate}`);
        if (event.weight) metaParts.push(`成績比重：${event.weight}`);
        if (event.gradingMethod) metaParts.push(`評分方式：${event.gradingMethod}`);
        if (metaParts.length > 0) {
            descLines.push(`📋 ${metaParts.join("｜")}`);
        }
        if (event.submittedStatus) {
            descLines.push(`📌 繳交狀況：${event.submittedStatus}`);
        }
        if (event.description) {
            descLines.push(`\n── 作業說明與附件 ──\n${event.description}`);
        }

        const fullDescription = descLines.join("\n");
        const reminders = buildRemindersObject(config);

        const mainPayload = {
            summary: `[${shortCourse}] ${event.title}`,
            location: event.url,
            description: fullDescription,
            start: {
                dateTime: mainStartIso,
                timeZone: "Asia/Taipei",
            },
            end: {
                dateTime: mainEndIso,
                timeZone: "Asia/Taipei",
            },
            source: {
                title: "前往 eeclass 作業繳交頁面",
                url: event.url,
            },
            reminders: needsSeparateDeadlineAlert
                ? {
                    useDefault: false,
                    overrides: [{ method: "popup", minutes: 10 }],
                }
                : reminders,
            extendedProperties: {
                private: {
                    eeclassEventKey: event.key,
                    eeclassRole: "main",
                    eeclassCourseId: String(event.courseId || ""),
                    eeclassContentHash: contentHash,
                },
            },
        };

        let deadlineAlertPayload = null;
        if (needsSeparateDeadlineAlert) {
            const alertStartIso = formatIsoWithTaipeiOffset(dueParsed.ms - 3600 * 1000);
            deadlineAlertPayload = {
                summary: `⏰ [截止提醒][${shortCourse}] ${event.title}`,
                location: event.url,
                description: fullDescription,
                start: {
                    dateTime: alertStartIso,
                    timeZone: "Asia/Taipei",
                },
                end: {
                    dateTime: mainEndIso,
                    timeZone: "Asia/Taipei",
                },
                source: {
                    title: "前往 eeclass 繳交作業",
                    url: event.url,
                },
                reminders,
                extendedProperties: {
                    private: {
                        eeclassEventKey: `${event.key}:deadline`,
                        eeclassRole: "deadline",
                        eeclassCourseId: String(event.courseId || ""),
                        eeclassContentHash: contentHash,
                    },
                },
            };
        }

        return { mainPayload, deadlineAlertPayload };
    }

    async function findExistingGoogleEventByKey(calendarId, eeclassKey) {
        try {
            const q = new URLSearchParams({
                privateExtendedProperty: `eeclassEventKey=${eeclassKey}`,
                showDeleted: "false",
                maxResults: "5",
            });
            const resp = await googleCalendarFetch(
                `/calendars/${encodeURIComponent(calendarId)}/events?${q.toString()}`
            );
            if (!resp.ok) {
                return null;
            }
            const data = await resp.json();
            return data.items?.[0] || null;
        }
        catch {
            return null;
        }
    }

    async function deleteGoogleEventGracefully(calendarId, googleEventId) {
        if (!calendarId || !googleEventId) {
            return;
        }
        try {
            await googleCalendarFetch(
                `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(googleEventId)}`,
                { method: "DELETE" }
            );
        }
        catch {
            // Ignore
        }
    }

    async function upsertSingleGoogleEvent(calendarId, existingEventId, eeclassKey, payload) {
        let targetEventId = existingEventId;
        if (!targetEventId) {
            const found = await findExistingGoogleEventByKey(calendarId, eeclassKey);
            if (found?.id) {
                targetEventId = found.id;
            }
        }

        if (targetEventId) {
            const putResp = await googleCalendarFetch(
                `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(targetEventId)}`,
                {
                    method: "PUT",
                    body: JSON.stringify(payload),
                }
            );
            if (putResp.ok) {
                const updated = await putResp.json();
                return { id: updated.id, htmlLink: updated.htmlLink || "", action: "updated" };
            }
            // 若原事件在 Google 日曆被使用者手動刪除 (404 / 410)，自動重新建立
            if (putResp.status !== 404 && putResp.status !== 410) {
                const errText = await putResp.text();
                throw new Error(`更新日曆事件失敗 (${putResp.status})：${errText}`);
            }
        }

        const postResp = await googleCalendarFetch(
            `/calendars/${encodeURIComponent(calendarId)}/events`,
            {
                method: "POST",
                body: JSON.stringify(payload),
            }
        );
        if (!postResp.ok) {
            const errText = await postResp.text();
            throw new Error(`建立日曆事件失敗 (${postResp.status})：${errText}`);
        }
        const created = await postResp.json();
        return { id: created.id, htmlLink: created.htmlLink || "", action: "created" };
    }

    /**
     * 核心同步與差異更新函式：
     * 將掃描到的 eeclass 事件陣列同步至 Google 日曆。
     * - 若事件內容（標題、開放繳交、繳交期限、比重、說明、提醒設定、目標日曆）有變，立即更新！
     * - 若目標日曆改變（例如使用者切換「共用日曆 / 各課獨立日曆 / 既有日曆」），自動從舊日曆移除並遷移至新日曆！
     */
    async function syncEventsToGoogleCalendar(rawEvents, options = {}) {
        const { forceUpdate = false, interactiveAuth = false } = options;
        const config = await getCalendarConfig();

        // 先將所有偵測到的課程寫入已知課程清單（即使尚未授權也能在設定面板看到課程列表）
        await recordKnownCourses(
            (rawEvents || []).map((e) => ({
                courseId: e.courseId,
                courseName: e.courseName,
                courseCode: e.courseCode,
            }))
        );

        const syncMap = await getSyncMap();

        // 先合併最新欄位至本地快取
        const mergedEvents = [];
        for (const incoming of rawEvents || []) {
            if (!incoming?.key || !incoming?.dueTime) {
                continue;
            }
            const prev = syncMap[incoming.key] || {};
            const merged = {
                ...prev,
                ...incoming,
                startTime: incoming.startTime || prev.startTime || "",
                courseCode: incoming.courseCode || prev.courseCode || "",
                eventType: incoming.eventType || prev.eventType || "",
                allowLate: incoming.allowLate || prev.allowLate || "",
                weight: incoming.weight || prev.weight || "",
                gradingMethod: incoming.gradingMethod || prev.gradingMethod || "",
                submittedStatus: incoming.submittedStatus || prev.submittedStatus || "",
                description: incoming.description || prev.description || "",
            };
            mergedEvents.push(merged);
        }

        const tokenCheck = await getValidAccessToken(interactiveAuth);
        if (!tokenCheck.ok) {
            // 先把偵測到的事件存起來，一旦使用者完成授權即可立即同步
            for (const ev of mergedEvents) {
                syncMap[ev.key] = {
                    ...(syncMap[ev.key] || {}),
                    ...ev,
                    lastSeenAt: Date.now(),
                };
            }
            await saveSyncMap(syncMap);
            return {
                ok: false,
                authorized: false,
                error: tokenCheck.error,
                pendingCount: mergedEvents.length,
            };
        }

        let createdCount = 0;
        let updatedCount = 0;
        let unchangedCount = 0;
        const results = {};

        for (const ev of mergedEvents) {
            try {
                const targetCalendarId = await resolveTargetCalendarId(ev, config);
                const newHash = computeEventContentHash(ev, config, targetCalendarId);
                const prevRecord = syncMap[ev.key];

                const calendarChanged =
                    prevRecord?.calendarId && prevRecord.calendarId !== targetCalendarId;
                const contentChanged =
                    !prevRecord?.googleEventId ||
                    prevRecord.contentHash !== newHash ||
                    calendarChanged ||
                    forceUpdate;

                if (!contentChanged) {
                    unchangedCount++;
                    results[ev.key] = {
                        status: "unchanged",
                        htmlLink: prevRecord.htmlLink || "",
                        calendarId: targetCalendarId,
                    };
                    continue;
                }

                // 若目標日曆改變，先清除舊日曆上的事件避免重複
                if (calendarChanged && prevRecord?.calendarId) {
                    await deleteGoogleEventGracefully(prevRecord.calendarId, prevRecord.googleEventId);
                    if (prevRecord.deadlineGoogleEventId) {
                        await deleteGoogleEventGracefully(prevRecord.calendarId, prevRecord.deadlineGoogleEventId);
                    }
                }

                const payloads = buildGoogleCalendarPayloads(ev, config, newHash);
                if (!payloads) {
                    continue;
                }

                const mainRes = await upsertSingleGoogleEvent(
                    targetCalendarId,
                    calendarChanged ? "" : prevRecord?.googleEventId,
                    ev.key,
                    payloads.mainPayload
                );

                let deadlineEventId = "";
                if (payloads.deadlineAlertPayload) {
                    const dlRes = await upsertSingleGoogleEvent(
                        targetCalendarId,
                        calendarChanged ? "" : prevRecord?.deadlineGoogleEventId,
                        `${ev.key}:deadline`,
                        payloads.deadlineAlertPayload
                    );
                    deadlineEventId = dlRes.id;
                }
                else if (prevRecord?.deadlineGoogleEventId) {
                    await deleteGoogleEventGracefully(
                        prevRecord.calendarId || targetCalendarId,
                        prevRecord.deadlineGoogleEventId
                    );
                }

                if (mainRes.action === "created") {
                    createdCount++;
                }
                else {
                    updatedCount++;
                }

                syncMap[ev.key] = {
                    ...ev,
                    calendarId: targetCalendarId,
                    googleEventId: mainRes.id,
                    deadlineGoogleEventId: deadlineEventId,
                    htmlLink: mainRes.htmlLink,
                    contentHash: newHash,
                    syncedAt: Date.now(),
                    lastSeenAt: Date.now(),
                };

                results[ev.key] = {
                    status: mainRes.action,
                    htmlLink: mainRes.htmlLink,
                    calendarId: targetCalendarId,
                };
            }
            catch (err) {
                console.error("同步單一事件至 Google 日曆失敗：", ev, err);
                results[ev.key] = {
                    status: "error",
                    error: err?.message || "同步失敗",
                };
            }
        }

        await saveSyncMap(syncMap);
        return {
            ok: true,
            authorized: true,
            createdCount,
            updatedCount,
            unchangedCount,
            results,
        };
    }

    /**
     * 從背景直接抓取 eeclass 最近事件與各作業詳細頁面（無須使用者手動開頁面），檢查異動並更新至 Google 日曆
     */
    async function fetchAndSyncLatestEventsFromBackground(options = {}) {
        try {
            const resp = await fetch("https://eeclass.nthu.edu.tw/dashboard/latestEvent", {
                credentials: "include",
            });
            if (!resp.ok) {
                throw new Error(`HTTP ${resp.status}`);
            }
            const html = await resp.text();
            const basicEvents = parseLatestEventsHtmlText(html);

            // 同時針對每個作業連結抓取詳細頁面（取得開放繳交開始時間、比重、說明等）
            const enrichedEvents = [];
            for (const ev of basicEvents) {
                if (ev.url && /\/course\/homework\/\d+/.test(ev.url)) {
                    try {
                        const detailResp = await fetch(ev.url, { credentials: "include" });
                        if (detailResp.ok) {
                            const detailHtml = await detailResp.text();
                            const detailData = parseHomeworkDetailHtmlText(detailHtml, ev.url);
                            enrichedEvents.push({
                                ...ev,
                                ...detailData,
                                title: detailData.title || ev.title,
                                dueTime: detailData.dueTime || ev.dueTime,
                                courseName: detailData.courseName || ev.courseName,
                                courseId: detailData.courseId || ev.courseId,
                            });
                            continue;
                        }
                    }
                    catch {
                        // Ignore and keep basic event
                    }
                }
                enrichedEvents.push(ev);
            }

            if (enrichedEvents.length === 0) {
                // 若目前沒有新抓取到事件，但本地已有紀錄，可針對既有紀錄進行重同步（例如更改設定後）
                const existingMap = await getSyncMap();
                const storedEvents = Object.values(existingMap);
                if (storedEvents.length > 0 && options.resyncStoredIfEmpty) {
                    return await syncEventsToGoogleCalendar(storedEvents, options);
                }
            }

            return await syncEventsToGoogleCalendar(enrichedEvents, options);
        }
        catch (err) {
            return {
                ok: false,
                error: err?.message || "無法從背景讀取 eeclass 最近事件（請確認已登入 eeclass）",
            };
        }
    }

    function stripHtmlTags(rawHtml) {
        return String(rawHtml || "")
            .replace(/<script[\s\S]*?<\/script>/gi, "")
            .replace(/<style[\s\S]*?<\/style>/gi, "")
            .replace(/<[^>]+>/g, " ")
            .replace(/&nbsp;/gi, " ")
            .replace(/&amp;/gi, "&")
            .replace(/&lt;/gi, "<")
            .replace(/&gt;/gi, ">")
            .replace(/\s+/g, " ")
            .trim();
    }

    /**
     * 純字串解析 /dashboard/latestEvent 的 #recentEventTable（可供 Service Worker 背景執行）
     */
    function parseLatestEventsHtmlText(html) {
        const events = [];
        const tbodyMatch = /<table[^>]*id=['"]recentEventTable['"][\s\S]*?<tbody>([\s\S]*?)<\/tbody>/i.exec(html);
        if (!tbodyMatch?.[1]) {
            return events;
        }
        const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
        let rowMatch;
        while ((rowMatch = rowRegex.exec(tbodyMatch[1])) !== null) {
            const rowHtml = rowMatch[1];
            const linkMatch = /<a[^>]*href=['"]([^'"]+)['"][^>]*>([\s\S]*?)<\/a>/i.exec(rowHtml);
            const courseMatch = /<a[^>]*href=['"]\/course\/(\d+)['"][^>]*>([\s\S]*?)<\/a>/i.exec(rowHtml);
            const dateTitleMatch = /col-date[\s\S]*?title=['"]([^'"]+)['"]/i.exec(rowHtml);
            const dateTextMatch = /col-date[^>]*>([\s\S]*?)<\/td>/i.exec(rowHtml);

            if (!linkMatch) {
                continue;
            }
            const rawHref = linkMatch[1].trim();
            const fullUrl = new URL(rawHref, "https://eeclass.nthu.edu.tw").href;
            const title = stripHtmlTags(linkMatch[2]);
            const courseId = courseMatch?.[1] || "general";
            const courseName = courseMatch ? stripHtmlTags(courseMatch[2]) : "eeclass 課程";
            const dueTime = (dateTitleMatch?.[1] || stripHtmlTags(dateTextMatch?.[1] || "")).trim();

            const hwIdMatch = /\/course\/homework\/(\d+)/.exec(rawHref);
            const key = hwIdMatch ? `homework:${hwIdMatch[1]}` : `event:${rawHref}`;

            if (title && dueTime) {
                events.push({
                    key,
                    title,
                    url: fullUrl,
                    courseId,
                    courseName,
                    dueTime,
                });
            }
        }
        return events;
    }

    /**
     * 純字串解析 /course/homework/<id> 詳細頁面（可供 Service Worker 背景執行）
     */
    function parseHomeworkDetailHtmlText(html, pageUrl) {
        const hwIdMatch = /\/course\/homework\/(\d+)/.exec(pageUrl || "");
        const key = hwIdMatch ? `homework:${hwIdMatch[1]}` : `event:${pageUrl}`;

        const courseMatch = /class=['"]fs-banner-title['"][\s\S]*?<a[^>]*href=['"]\/course\/(\d+)['"][^>]*>([\s\S]*?)<\/a>/i.exec(html);
        const courseCodeMatch = /class=['"]fs-banner-extInfo['"][^>]*>([\s\S]*?)<\/span>/i.exec(html);
        const titleMatch = /class=['"]fs-page-header[\s\S]*?<div[^>]*class=['"]title[^'"]*['"][^>]*>([\s\S]*?)<\/div>/i.exec(html);

        const meta = {};
        const dlMatch = /<dl[^>]*class=['"]dl-horizontal[^'"]*['"][^>]*>([\s\S]*?)<\/dl>/i.exec(html);
        if (dlMatch?.[1]) {
            const dtDdRegex = /<dt[^>]*>([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/gi;
            let m;
            while ((m = dtDdRegex.exec(dlMatch[1])) !== null) {
                const k = stripHtmlTags(m[1]);
                const v = stripHtmlTags(m[2]);
                if (k) {
                    meta[k] = v;
                }
            }
        }

        return {
            key,
            url: pageUrl,
            title: titleMatch ? stripHtmlTags(titleMatch[1]) : "",
            courseId: courseMatch?.[1] || "",
            courseName: courseMatch ? stripHtmlTags(courseMatch[2]) : "",
            courseCode: courseCodeMatch ? stripHtmlTags(courseCodeMatch[1]).replace(/^[()（）]+|[()（）]+$/g, "") : "",
            eventType: meta["類型"] || "",
            startTime: meta["開放繳交"] || meta["開始時間"] || meta["開放時間"] || "",
            dueTime: meta["繳交期限"] || meta["截止時間"] || meta["結束時間"] || "",
            allowLate: meta["允許遲交"] || "",
            weight: meta["成績比重"] || "",
            gradingMethod: meta["評分方式"] || "",
            submittedStatus: meta["繳交狀態"] || (meta["已繳交"] ? `已繳交人數：${meta["已繳交"]}` : ""),
        };
    }

    async function resyncAllStoredEvents() {
        const syncMap = await getSyncMap();
        const storedEvents = Object.values(syncMap);
        if (storedEvents.length === 0) {
            return await fetchAndSyncLatestEventsFromBackground({ forceUpdate: true });
        }
        return await syncEventsToGoogleCalendar(storedEvents, { forceUpdate: true });
    }

    async function setupPeriodicSyncAlarm(configInput) {
        if (!chrome.alarms) {
            return;
        }
        const config = configInput || (await getCalendarConfig());
        await chrome.alarms.clear(ALARM_NAME);
        if (config.autoSyncCalendar) {
            const periodInMinutes = Math.max(15, Number(config.backgroundSyncMinutes) || 30);
            chrome.alarms.create(ALARM_NAME, { periodInMinutes });
        }
    }

    if (chrome.alarms?.onAlarm) {
        chrome.alarms.onAlarm.addListener((alarm) => {
            if (alarm?.name === ALARM_NAME) {
                fetchAndSyncLatestEventsFromBackground({ forceUpdate: false }).catch(() => undefined);
            }
        });
    }

    globalScope.EECLASS_CALENDAR_SYNC = {
        DEFAULT_CALENDAR_CONFIG,
        getCalendarConfig,
        saveCalendarConfig,
        getCalendarAuth,
        getValidAccessToken,
        bindManualAccessToken,
        disconnectGoogleCalendar,
        listUserCalendars,
        getKnownCourses,
        getSyncMap,
        syncEventsToGoogleCalendar,
        fetchAndSyncLatestEventsFromBackground,
        resyncAllStoredEvents,
        setupPeriodicSyncAlarm,
    };
})(globalThis);
