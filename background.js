"use strict";

importScripts("crypto-vault.js", "calendar-sync.js", "eeclass-extension-server.js", "eeclass-transport.js", "course-scan.js", "eeclass-live.js", "eeclass-ui.js", "mcp-bridge-client.js");

const { EECLASS_CRYPTO_VAULT, EECLASS_CALENDAR_SYNC } = globalThis;

const IDB_NAME = "eeclassDownloaderDB";
const IDB_STORE = "directoryHandles";
const IDB_HANDLE_KEY = "boundLocalDirectory";
const DEFAULT_SUBFOLDER = "eeclass_教材";
const MAX_SEGMENT_LENGTH = 100;
const LIVE_PROGRESS_KEY = "eeclassLiveProgress";
const STUDENT_CONFIG_KEY = "eeclassStudentConfig";

// 供 chrome.downloads.onDeterminingFilename 同步查詢之快取與佇列
const pendingDownloadsById = new Map();
const pendingDownloadsByUrl = new Map();
const recentClickContextByUrl = new Map();
let activeSequentialTaskMeta = null;
let lastClickedContext = null;
let latestEeclassPageContext = null;
let cachedStudentConfig = {
    enableDownloaderUI: true,
    targetDirectory: DEFAULT_SUBFOLDER,
    useLocalFsHandle: false,
    boundFolderName: "",
    interceptSingleDownload: true,
    conflictAction: "uniquify",
};

function refreshCachedStudentConfig() {
    if (!chrome.storage?.local) {
        return;
    }
    chrome.storage.local.get([STUDENT_CONFIG_KEY], (res) => {
        if (res?.[STUDENT_CONFIG_KEY]) {
            cachedStudentConfig = {
                ...cachedStudentConfig,
                ...res[STUDENT_CONFIG_KEY],
            };
        }
    });
}
refreshCachedStudentConfig();

if (chrome.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === "local" && changes[STUDENT_CONFIG_KEY]?.newValue) {
            cachedStudentConfig = {
                ...cachedStudentConfig,
                ...changes[STUDENT_CONFIG_KEY].newValue,
            };
        }
    });
}

async function updateLiveProgress(patch) {
    try {
        const res = await chrome.storage.local.get([LIVE_PROGRESS_KEY]);
        const prev = res?.[LIVE_PROGRESS_KEY] || {
            active: false,
            type: "idle", // "idle" | "download" | "calendar"
            title: "目前無進行中任務",
            detail: "",
            current: 0,
            total: 0,
            percent: 0,
            updatedAt: Date.now(),
            recentLogs: [],
        };
        const nextLogs = Array.isArray(patch.appendLog)
            ? [...patch.appendLog, ...(prev.recentLogs || [])].slice(0, 12)
            : patch.appendLog
                ? [patch.appendLog, ...(prev.recentLogs || [])].slice(0, 12)
                : (prev.recentLogs || []);

        const current = patch.current ?? prev.current ?? 0;
        const total = patch.total ?? prev.total ?? 0;
        const percent = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : (patch.percent ?? 0);

        const next = {
            ...prev,
            ...patch,
            current,
            total,
            percent,
            updatedAt: Date.now(),
            recentLogs: nextLogs,
        };
        delete next.appendLog;
        await chrome.storage.local.set({ [LIVE_PROGRESS_KEY]: next });
        return next;
    }
    catch {
        return null;
    }
}

async function reinjectOpenEeclassTabs() {
    if (!chrome.scripting || !chrome.tabs) {
        return;
    }
    try {
        const tabs = await chrome.tabs.query({ url: "https://eeclass.nthu.edu.tw/*" });
        for (const tab of tabs) {
            if (!tab.id) {
                continue;
            }
            chrome.scripting.insertCSS({
                target: { tabId: tab.id },
                files: ["course-downloader.css"],
            }).catch(() => undefined);
            chrome.scripting.executeScript({
                target: { tabId: tab.id },
                files: ["course-downloader.js", "calendar-content.js"],
            }).catch(() => undefined);
        }
    }
    catch {
        // Ignore
    }
}

chrome.runtime.onInstalled.addListener(() => {
    EECLASS_CRYPTO_VAULT?.migratePlaintextAuthConfigIfNeeded().catch(() => undefined);
    EECLASS_CALENDAR_SYNC?.setupPeriodicSyncAlarm().catch(() => undefined);
    reinjectOpenEeclassTabs().catch(() => undefined);
});

chrome.runtime.onStartup.addListener(() => {
    EECLASS_CRYPTO_VAULT?.migratePlaintextAuthConfigIfNeeded().catch(() => undefined);
    EECLASS_CALENDAR_SYNC?.setupPeriodicSyncAlarm().catch(() => undefined);
});

function isTrustedOauthSender(sender) {
    if (!sender || sender.id !== chrome.runtime.id || sender.frameId !== 0) {
        return false;
    }
    const rawUrl = sender.url || sender.tab?.url || "";
    try {
        const parsed = new URL(rawUrl);
        return (
            parsed.protocol === "https:" &&
            parsed.hostname.toLowerCase() === "oauth.ccxp.nthu.edu.tw" &&
            /^\/v\d+(?:\.\d+)?\/authorize\.php$/i.test(parsed.pathname)
        );
    }
    catch {
        return false;
    }
}

// 圖書館自動登入只允許圖書館網站與校務 IDM 登入頁的頂層框架取得帳密
function isTrustedLibrarySender(sender) {
    if (!sender || sender.id !== chrome.runtime.id || sender.frameId !== 0) {
        return false;
    }
    try {
        const parsed = new URL(sender.url || sender.tab?.url || "");
        const host = parsed.hostname.toLowerCase();
        return parsed.protocol === "https:" &&
            (host === "www.lib.nthu.edu.tw" || host === "idm.nthu.ust.edu.tw");
    }
    catch {
        return false;
    }
}

function sanitizeSegment(name) {
    let s = String(name || "")
        .replace(/[\x00-\x1f\x7f-\x9f\u200b-\u200f\ufeff]/g, "")
        .replace(/[\\/:*?"<>|~]/g, "_")
        .replace(/\s+/g, " ")
        .trim();
    if (s.length > MAX_SEGMENT_LENGTH) {
        s = s.slice(0, MAX_SEGMENT_LENGTH).trim();
    }
    return s.replace(/^[. ]+|[. ]+$/g, "") || "untitled";
}

function sanitizeRelativeDirectory(dirPath) {
    if (!dirPath || typeof dirPath !== "string") {
        return DEFAULT_SUBFOLDER;
    }
    const cleaned = dirPath
        .split(/[\\/]+/)
        .map((segment) => sanitizeSegment(segment))
        .filter(Boolean)
        .join("/");
    return cleaned || DEFAULT_SUBFOLDER;
}

/**
 * 組合 chrome.downloads.download 與 onDeterminingFilename 使用的相對路徑。
 * Chrome 會自動在系統預設「下載 (Downloads)」資料夾下建立不存在的資料夾（如 eeclass_教材/課程名/周次單元名/檔案）。
 */
function buildFinalDownloadPath(rawPath, targetDirectory) {
    const cleanTargetDir = sanitizeRelativeDirectory(targetDirectory || DEFAULT_SUBFOLDER);
    const cleanRawPath = String(rawPath || "downloaded_file")
        .split(/[\\/]+/)
        .map((segment) => sanitizeSegment(segment))
        .filter(Boolean)
        .join("/");

    return cleanTargetDir ? `${cleanTargetDir}/${cleanRawPath}` : cleanRawPath;
}

function normalizeUrlKey(rawUrl) {
    if (!rawUrl || typeof rawUrl !== "string") {
        return "";
    }
    try {
        const u = new URL(rawUrl, "https://eeclass.nthu.edu.tw");
        u.hash = "";
        return u.href;
    }
    catch {
        return String(rawUrl).trim();
    }
}

function isGenericFileTitle(name) {
    const cleaned = String(name || "").trim();
    if (!cleaned) {
        return true;
    }
    return /^(下載|檔案下載|下載檔案|下載附件|附件下載|附件|課程附件|點擊下載|download|downloaded_file|file|attachment|untitled)$/i.test(cleaned);
}

function resolveFinalFileName(preferredName, serverName) {
    const cleanServer = serverName
        ? sanitizeSegment(String(serverName).split(/[\\/]+/).pop() || "")
        : "";
    const cleanPreferred = preferredName
        ? sanitizeSegment(String(preferredName).split(/[\\/]+/).pop() || "")
        : "";

    if (!cleanPreferred || isGenericFileTitle(cleanPreferred)) {
        return cleanServer || "downloaded_file";
    }
    if (!cleanServer || isGenericFileTitle(cleanServer)) {
        return cleanPreferred;
    }
    return sanitizeSegment(ensureExtension(cleanPreferred, cleanServer));
}

function enqueuePendingDownload(meta) {
    const key = normalizeUrlKey(meta.url);
    if (!key) {
        return;
    }
    const list = pendingDownloadsByUrl.get(key) || [];
    list.push(meta);
    pendingDownloadsByUrl.set(key, list);
}

function claimPendingDownloadByUrl(rawUrl) {
    const key = normalizeUrlKey(rawUrl);
    if (!key) {
        return null;
    }
    const list = pendingDownloadsByUrl.get(key);
    if (!Array.isArray(list) || list.length === 0) {
        return null;
    }
    while (list.length > 0) {
        const item = list.shift();
        if (list.length === 0) {
            pendingDownloadsByUrl.delete(key);
        }
        if (item && !item.claimed) {
            item.claimed = true;
            return item;
        }
    }
    return null;
}

function isEeclassUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== "string") {
        return false;
    }
    try {
        const u = new URL(rawUrl);
        return u.hostname.toLowerCase().endsWith("eeclass.nthu.edu.tw");
    }
    catch {
        return false;
    }
}

/**
 * 關鍵修復：註冊 chrome.downloads.onDeterminingFilename
 * 1. 當瀏覽器安裝其他具備 onDeterminingFilename 的擴充功能或伺服器回傳 Content-Disposition 時，
 *    單純傳給 chrome.downloads.download 的 filename 參數會被 Chrome 忽略，導致直接落入預設下載根目錄。
 * 2. 透過在 onDeterminingFilename 同步呼叫 suggest({ filename })，可強制保留「eeclass_教材/課程名稱/周次單元/檔名.副檔名」子資料夾結構，
 *    同時自動取得伺服器 Content-Disposition 提供的真實副檔名。
 * 3. 若使用者直接在 eeclass 頁面上點擊檔案下載連結，亦能自動歸檔至對應課程與周次資料夾。
 */
if (chrome.downloads?.onDeterminingFilename) {
    chrome.downloads.onDeterminingFilename.addListener((downloadItem, suggest) => {
        try {
            let meta = pendingDownloadsById.get(downloadItem.id) || null;
            if (meta) {
                meta.claimed = true;
                pendingDownloadsById.delete(downloadItem.id);
            }

            if (!meta) {
                meta =
                    claimPendingDownloadByUrl(downloadItem.originalUrl) ||
                    claimPendingDownloadByUrl(downloadItem.url) ||
                    claimPendingDownloadByUrl(downloadItem.finalUrl);
            }

            if (!meta && downloadItem.byExtensionId === chrome.runtime.id && activeSequentialTaskMeta) {
                meta = activeSequentialTaskMeta;
            }

            // 若為使用者在 eeclass 頁面直接觸發的瀏覽器原生下載（例如點擊連結或 iframe 觸發下載）
            if (
                !meta &&
                (isEeclassUrl(downloadItem.url) ||
                    isEeclassUrl(downloadItem.originalUrl) ||
                    isEeclassUrl(downloadItem.finalUrl) ||
                    isEeclassUrl(downloadItem.referrer))
            ) {
                const now = Date.now();
                const urlCandidates = [
                    normalizeUrlKey(downloadItem.originalUrl),
                    normalizeUrlKey(downloadItem.url),
                    normalizeUrlKey(downloadItem.finalUrl),
                ].filter(Boolean);

                for (const uKey of urlCandidates) {
                    const clickMeta = recentClickContextByUrl.get(uKey);
                    if (clickMeta && now - clickMeta.time < 60_000) {
                        if (clickMeta.bypassArchive) {
                            suggest();
                            return;
                        }
                        meta = clickMeta;
                        break;
                    }
                }

                if (!meta && lastClickedContext && now - lastClickedContext.time < 20_000) {
                    if (lastClickedContext.bypassArchive) {
                        suggest();
                        return;
                    }
                    meta = lastClickedContext;
                }

                if (!meta && cachedStudentConfig.interceptSingleDownload !== false && latestEeclassPageContext) {
                    meta = latestEeclassPageContext;
                }
            }

            if (!meta) {
                suggest();
                return;
            }

            const rawTarget = meta.targetDirectory || cachedStudentConfig.targetDirectory || DEFAULT_SUBFOLDER;
            const targetDir = sanitizeRelativeDirectory(
                /^(downloads|下載)$/i.test(String(rawTarget).trim()) ? DEFAULT_SUBFOLDER : rawTarget
            );
            const courseName = sanitizeSegment(meta.courseName || "eeclass_Course");
            const section = sanitizeSegment(meta.section || "未分類單元");
            const finalFileName = resolveFinalFileName(meta.fileName, downloadItem.filename);
            const finalPath = buildFinalDownloadPath(`${courseName}/${section}/${finalFileName}`, targetDir);
            const conflictAction =
                meta.conflictAction === "overwrite" || meta.conflictAction === "prompt"
                    ? meta.conflictAction
                    : "uniquify";

            suggest({
                filename: finalPath,
                conflictAction,
            });
        }
        catch (err) {
            console.error("onDeterminingFilename 處理失敗：", err);
            suggest();
        }
    });
}

function openHandleDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(IDB_NAME, 1);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(IDB_STORE)) {
                db.createObjectStore(IDB_STORE);
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function loadExtensionDirHandle(storeKey = IDB_HANDLE_KEY) {
    try {
        const db = await openHandleDB();
        return await new Promise((resolve) => {
            const tx = db.transaction(IDB_STORE, "readonly");
            const req = tx.objectStore(IDB_STORE).get(storeKey);
            req.onsuccess = () => resolve(req.result ?? null);
            req.onerror = () => resolve(null);
        });
    }
    catch {
        return null;
    }
}

/**
 * 實際測試資料夾 Handle 是否具備寫入與建立檔案能力（寫入測試暫存檔後立即移除）
 */
async function verifyHandleWritable(dirHandle) {
    if (!dirHandle || typeof dirHandle.queryPermission !== "function") {
        return { ok: false, permission: "none", reason: "尚未選擇資料夾" };
    }
    try {
        const perm = await dirHandle.queryPermission({ mode: "readwrite" });
        if (perm !== "granted") {
            return {
                ok: false,
                permission: perm,
                folderName: dirHandle.name,
                reason: perm === "prompt" ? "需重新授權資料夾讀寫權限" : "資料夾讀寫權限遭拒",
            };
        }
        const probeName = `.eeclass_write_probe_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.tmp`;
        const fileHandle = await dirHandle.getFileHandle(probeName, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(new Blob(["ok"], { type: "text/plain" }));
        await writable.close();
        await dirHandle.removeEntry(probeName);
        return {
            ok: true,
            permission: "granted",
            folderName: dirHandle.name,
        };
    }
    catch (err) {
        return {
            ok: false,
            permission: "error",
            folderName: dirHandle?.name || "",
            reason: err?.message || "目標資料夾無法寫入（可能已被移除、唯讀或受系統保護）",
        };
    }
}

async function getVerifiedExtensionDirHandle(storeKey = IDB_HANDLE_KEY) {
    const handle = await loadExtensionDirHandle(storeKey);
    if (!handle) {
        return null;
    }
    const check = await verifyHandleWritable(handle);
    return check.ok ? handle : null;
}

function extractFilenameFromHeader(contentDisposition, fallbackName) {
    if (!contentDisposition) {
        return fallbackName;
    }
    const utf8Match = /filename\*=UTF-8''([^;\r\n]+)/i.exec(contentDisposition);
    if (utf8Match?.[1]) {
        try {
            return sanitizeSegment(decodeURIComponent(utf8Match[1].replace(/["']/g, "")));
        }
        catch {
            // Ignore
        }
    }
    const plainMatch = /filename="?([^";\r\n]+)"?/i.exec(contentDisposition);
    if (plainMatch?.[1]) {
        try {
            return sanitizeSegment(decodeURIComponent(plainMatch[1]));
        }
        catch {
            return sanitizeSegment(plainMatch[1]);
        }
    }
    return fallbackName;
}

function ensureExtension(preferredName, serverName) {
    if (!serverName) {
        return preferredName;
    }
    const dot = serverName.lastIndexOf(".");
    if (dot <= 0) {
        return preferredName;
    }
    const ext = serverName.slice(dot);
    if (preferredName.toLowerCase().endsWith(ext.toLowerCase())) {
        return preferredName;
    }
    return `${preferredName}${ext}`;
}

async function resolveUniqueFileName(dirHandle, desiredName, conflictAction) {
    if (conflictAction === "overwrite") {
        return desiredName;
    }
    const dotIndex = desiredName.lastIndexOf(".");
    const base = dotIndex > 0 ? desiredName.slice(0, dotIndex) : desiredName;
    const ext = dotIndex > 0 ? desiredName.slice(dotIndex) : "";

    let candidate = desiredName;
    let counter = 1;
    while (counter < 500) {
        try {
            await dirHandle.getFileHandle(candidate, { create: false });
            candidate = `${base} (${counter})${ext}`;
            counter++;
        }
        catch (err) {
            if (err?.name === "NotFoundError") {
                return candidate;
            }
            return candidate;
        }
    }
    return candidate;
}

async function writeTaskToHandle(dirHandle, task, conflictAction = "uniquify") {
    const courseSeg = sanitizeSegment(task.courseName || "eeclass_Course");
    const sectionSeg = sanitizeSegment(task.section || "未分類單元");
    const pathSegments = String(task.path || `${courseSeg}/${sectionSeg}/${task.fileName || "downloaded_file"}`)
        .split(/[\\/]+/)
        .map((s) => sanitizeSegment(s))
        .filter(Boolean);
    const rawFileName = pathSegments.pop() || sanitizeSegment(task.fileName || "downloaded_file");
    const folderSegments = pathSegments.length >= 2 ? pathSegments : [courseSeg, sectionSeg];

    let currentDir = dirHandle;
    // 若使用者選擇的是系統根目錄（如 Downloads / 下載 / 桌面），自動在其下建立 eeclass_教材 子資料夾
    if (/^(downloads|下載|desktop|桌面|documents|文件)$/i.test(String(dirHandle.name || "").trim())) {
        currentDir = await currentDir.getDirectoryHandle(DEFAULT_SUBFOLDER, { create: true });
    }
    for (const seg of folderSegments) {
        currentDir = await currentDir.getDirectoryHandle(seg, { create: true });
    }

    const resp = await fetch(task.url, { credentials: "include" });
    if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}`);
    }
    if (
        resp.url &&
        (resp.url.includes("oauth.ccxp.nthu.edu.tw") || /\/sys\/login/i.test(resp.url))
    ) {
        throw new Error("登入狀態已過期，請重新整理 eeclass 頁面");
    }

    const serverName = extractFilenameFromHeader(
        resp.headers.get("content-disposition"),
        rawFileName
    );
    const normalizedName = resolveFinalFileName(rawFileName, serverName);
    const finalFileName = await resolveUniqueFileName(currentDir, normalizedName, conflictAction);

    const fileHandle = await currentDir.getFileHandle(finalFileName, { create: true });
    const writable = await fileHandle.createWritable();
    const blob = await resp.blob();
    await writable.write(blob);
    await writable.close();
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request?.action === "request_oauth_credentials") {
        if (!isTrustedOauthSender(sender)) {
            sendResponse({ status: "forbidden" });
            return false;
        }
        EECLASS_CRYPTO_VAULT.loadDecryptedAuthConfig(request.pin ?? "")
            .then((authConfig) => {
                sendResponse({ status: "ok", authConfig });
            })
            .catch(() => {
                sendResponse({ status: "error" });
            });
        return true;
    }

    if (request?.action === "request_library_credentials") {
        if (!isTrustedLibrarySender(sender)) {
            sendResponse({ status: "forbidden" });
            return false;
        }
        EECLASS_CRYPTO_VAULT.loadDecryptedLibraryAuthConfig(request.pin ?? "")
            .then((authConfig) => {
                sendResponse({ status: "ok", authConfig });
            })
            .catch(() => {
                sendResponse({ status: "error" });
            });
        return true;
    }

    if (request?.action === "update_live_progress") {
        updateLiveProgress(request.patch || {})
            .then((state) => sendResponse({ ok: true, state }))
            .catch(() => sendResponse({ ok: false }));
        return true;
    }

    if (request?.action === "check_extension_dir_status") {
        const storeKey = request.storeKey || IDB_HANDLE_KEY;
        loadExtensionDirHandle(storeKey)
            .then(async (handle) => {
                if (!handle) {
                    sendResponse({
                        hasHandle: false,
                        writable: false,
                        permission: "none",
                        reason: "尚未綁定本機資料夾",
                    });
                    return;
                }
                const check = await verifyHandleWritable(handle);
                sendResponse({
                    hasHandle: true,
                    writable: check.ok,
                    permission: check.permission,
                    folderName: handle.name,
                    reason: check.reason || "",
                });
            })
            .catch((err) => {
                sendResponse({
                    hasHandle: false,
                    writable: false,
                    permission: "error",
                    reason: err?.message || "檢查目錄失敗",
                });
            });
        return true;
    }

    // ==================== Google Calendar 授權與同步訊息處理 ====================
    if (request?.action === "calendar_get_status") {
        Promise.all([
            EECLASS_CALENDAR_SYNC.getCalendarConfig(),
            EECLASS_CALENDAR_SYNC.getCalendarAuth(),
            EECLASS_CALENDAR_SYNC.listUserCalendars(Boolean(request.forceRefreshCalendars)),
            EECLASS_CALENDAR_SYNC.getKnownCourses(),
            EECLASS_CALENDAR_SYNC.getSyncMap(),
        ])
            .then(([config, auth, calendars, courses, syncMap]) => {
                const isAuthorized = Boolean(auth?.accessToken && auth.expiresAt > Date.now());
                sendResponse({
                    ok: true,
                    config,
                    authorized: isAuthorized,
                    userEmail: auth?.userEmail || "",
                    redirectUri: chrome.identity?.getRedirectURL ? chrome.identity.getRedirectURL() : "",
                    calendars,
                    courses,
                    syncMap,
                });
            })
            .catch((err) => {
                sendResponse({ ok: false, error: err?.message || "無法讀取日曆狀態" });
            });
        return true;
    }

    if (request?.action === "calendar_oauth_connect") {
        (async () => {
            if (request.oauthClientId !== undefined) {
                await EECLASS_CALENDAR_SYNC.saveCalendarConfig({
                    oauthClientId: String(request.oauthClientId || "").trim(),
                });
            }
            const tokenRes = await EECLASS_CALENDAR_SYNC.getValidAccessToken(true);
            if (!tokenRes.ok) {
                sendResponse(tokenRes);
                return;
            }
            const calendars = await EECLASS_CALENDAR_SYNC.listUserCalendars(true);
            // 授權成功後，自動將目前已快取或背景可抓取的事件同步至 Google 日曆
            const syncRes = await EECLASS_CALENDAR_SYNC.resyncAllStoredEvents();
            sendResponse({
                ok: true,
                userEmail: tokenRes.userEmail,
                calendars,
                syncRes,
            });
        })().catch((err) => {
            sendResponse({ ok: false, error: err?.message || "Google 授權失敗" });
        });
        return true;
    }

    if (request?.action === "calendar_bind_manual_token") {
        EECLASS_CALENDAR_SYNC.bindManualAccessToken(request.accessToken || "")
            .then(async (res) => {
                if (res.ok) {
                    await EECLASS_CALENDAR_SYNC.resyncAllStoredEvents();
                }
                sendResponse(res);
            })
            .catch((err) => {
                sendResponse({ ok: false, error: err?.message || "驗證 Token 失敗" });
            });
        return true;
    }

    if (request?.action === "calendar_oauth_disconnect") {
        EECLASS_CALENDAR_SYNC.disconnectGoogleCalendar()
            .then((res) => sendResponse(res))
            .catch((err) => sendResponse({ ok: false, error: err?.message }));
        return true;
    }

    if (request?.action === "calendar_sync_events") {
        const events = Array.isArray(request.events) ? request.events : [];
        (async () => {
            await updateLiveProgress({
                active: true,
                type: "calendar",
                title: `正在同步 Google 日曆 (共 ${events.length} 筆事件)...`,
                detail: events[0]?.title || "",
                current: 0,
                total: events.length,
            });
            const res = await EECLASS_CALENDAR_SYNC.syncEventsToGoogleCalendar(events, {
                forceUpdate: Boolean(request.forceUpdate),
                interactiveAuth: Boolean(request.interactiveAuth),
            });
            if (res.ok) {
                await updateLiveProgress({
                    active: false,
                    type: "calendar",
                    title: `✓ 日曆同步完成（新增 ${res.createdCount} / 更新 ${res.updatedCount} / 最新 ${res.unchangedCount}）`,
                    detail: `共處理 ${events.length} 筆課程事件`,
                    current: events.length,
                    total: events.length,
                    percent: 100,
                    appendLog: {
                        time: Date.now(),
                        kind: "calendar",
                        text: `日曆同步：新增 ${res.createdCount}、更新 ${res.updatedCount}、無變動 ${res.unchangedCount}`,
                    },
                });
            }
            else {
                await updateLiveProgress({
                    active: false,
                    type: "calendar",
                    title: res.authorized === false ? "日曆待授權（已記錄事件）" : `日曆同步未完成：${res.error || ""}`,
                    detail: "",
                    current: 0,
                    total: events.length,
                });
            }
            sendResponse(res);
        })().catch((err) => {
            sendResponse({ ok: false, error: err?.message || "同步日曆失敗" });
        });
        return true;
    }

    if (request?.action === "calendar_sync_now_from_background") {
        (async () => {
            await updateLiveProgress({
                active: true,
                type: "calendar",
                title: "正在從 eeclass 抓取最近事件與作業詳情...",
                detail: "讀取開放繳交時間、截止期限與作業連結",
                current: 1,
                total: 2,
            });
            const res = await EECLASS_CALENDAR_SYNC.fetchAndSyncLatestEventsFromBackground({
                forceUpdate: Boolean(request.forceUpdate),
                interactiveAuth: Boolean(request.interactiveAuth),
                resyncStoredIfEmpty: true,
            });
            if (res.ok) {
                await updateLiveProgress({
                    active: false,
                    type: "calendar",
                    title: `✓ 日曆同步完成（新增 ${res.createdCount} / 更新 ${res.updatedCount} / 最新 ${res.unchangedCount}）`,
                    detail: "",
                    current: 2,
                    total: 2,
                    percent: 100,
                    appendLog: {
                        time: Date.now(),
                        kind: "calendar",
                        text: `背景同步日曆：新增 ${res.createdCount}、更新 ${res.updatedCount}`,
                    },
                });
            }
            else {
                await updateLiveProgress({
                    active: false,
                    type: "calendar",
                    title: `日曆同步提示：${res.error || "尚未授權"}`,
                    detail: "",
                    current: 0,
                    total: 0,
                });
            }
            sendResponse(res);
        })().catch((err) => {
            sendResponse({ ok: false, error: err?.message || "背景同步失敗" });
        });
        return true;
    }

    if (request?.action === "calendar_resync_all") {
        EECLASS_CALENDAR_SYNC.resyncAllStoredEvents()
            .then((res) => sendResponse(res))
            .catch((err) => sendResponse({ ok: false, error: err?.message || "重同步失敗" }));
        return true;
    }

    if (request?.action === "open_split_settings") {
        const senderWinId = sender?.tab?.windowId;
        const sectionParam = request.section ? `&section=${encodeURIComponent(request.section)}` : "";
        if (chrome.sidePanel?.open && senderWinId !== undefined) {
            chrome.sidePanel
                .open({ windowId: senderWinId })
                .then(() => sendResponse({ status: "sidepanel_opened" }))
                .catch(() => {
                    openSplitPopupFallback(sectionParam);
                    sendResponse({ status: "window_opened" });
                });
            return true;
        }
        openSplitPopupFallback(sectionParam);
        sendResponse({ status: "window_opened" });
        return false;
    }

    if (request?.action === "register_download_context") {
        const ctx = request.context || {};
        const entry = {
            url: ctx.url || "",
            courseName: sanitizeSegment(ctx.courseName || "eeclass_Course"),
            section: sanitizeSegment(ctx.section || "未分類單元"),
            fileName: ctx.fileName ? sanitizeSegment(ctx.fileName) : "",
            targetDirectory: ctx.targetDirectory || cachedStudentConfig.targetDirectory || DEFAULT_SUBFOLDER,
            conflictAction: ctx.conflictAction || cachedStudentConfig.conflictAction || "uniquify",
            bypassArchive: Boolean(ctx.bypassArchive),
            time: Date.now(),
        };
        const uKey = normalizeUrlKey(entry.url);
        if (uKey) {
            recentClickContextByUrl.set(uKey, entry);
        }
        lastClickedContext = entry;
        sendResponse({ ok: true });
        return false;
    }

    if (request?.action === "register_page_context") {
        const ctx = request.context || {};
        latestEeclassPageContext = {
            courseName: sanitizeSegment(ctx.courseName || "eeclass_Course"),
            section: sanitizeSegment(ctx.section || "未分類單元"),
            fileName: "",
            targetDirectory: ctx.targetDirectory || cachedStudentConfig.targetDirectory || DEFAULT_SUBFOLDER,
            conflictAction: ctx.conflictAction || cachedStudentConfig.conflictAction || "uniquify",
            time: Date.now(),
        };
        sendResponse({ ok: true });
        return false;
    }

    if (request?.action === "download_files") {
        const tasks = Array.isArray(request.tasks) ? request.tasks : [];
        const targetDirectory = request.targetDirectory || DEFAULT_SUBFOLDER;
        const useLocalFsHandle = Boolean(request.useLocalFsHandle);
        const conflictAction = request.conflictAction || "uniquify";

        downloadQueue(tasks, {
            targetDirectory,
            useLocalFsHandle,
            conflictAction,
        })
            .then((summary) => {
                sendResponse({ status: "completed", ...summary });
            })
            .catch((err) => {
                sendResponse({
                    status: "error",
                    message: err?.message || "下載發生錯誤",
                    succeededUrls: [],
                });
            });
        return true;
    }

    return false;
});

function openSplitPopupFallback(extraQuery = "") {
    chrome.windows.getAll({ populate: false, windowTypes: ["normal"] }, (normalWins) => {
        const refWin = normalWins?.find((w) => w.focused) || normalWins?.[0] || null;
        const width = 560;
        const height = refWin?.height ?? 780;
        const left = refWin?.left !== undefined && refWin?.width !== undefined
            ? Math.max(0, refWin.left + refWin.width - width)
            : 220;
        const top = refWin?.top ?? 60;
        chrome.windows.create({
            url: chrome.runtime.getURL(`options.html?mode=split${extraQuery}`),
            type: "popup",
            width,
            height,
            left,
            top,
        });
    });
}

async function downloadQueue(tasks, options = {}) {
    const {
        targetDirectory = DEFAULT_SUBFOLDER,
        useLocalFsHandle = false,
        conflictAction = "uniquify",
    } = options;

    const extDirHandle = useLocalFsHandle
        ? await getVerifiedExtensionDirHandle(IDB_HANDLE_KEY)
        : null;

    const succeededUrls = [];
    const failedUrls = [];
    let usedMode = extDirHandle ? "extension_handle" : "chrome_downloads";
    let fallbackToDefaultSubfolder = false;

    if (useLocalFsHandle && !extDirHandle) {
        fallbackToDefaultSubfolder = true;
    }

    const rawSubfolder = fallbackToDefaultSubfolder
        ? DEFAULT_SUBFOLDER
        : (targetDirectory || DEFAULT_SUBFOLDER);
    const effectiveDownloadSubfolder = /^(downloads|下載)$/i.test(String(rawSubfolder).trim())
        ? DEFAULT_SUBFOLDER
        : rawSubfolder;

    const destLabel = extDirHandle && !fallbackToDefaultSubfolder
        ? extDirHandle.name
        : `系統「下載」/${effectiveDownloadSubfolder}`;

    await updateLiveProgress({
        active: true,
        type: "download",
        title: `正在下載教材至「${destLabel}」(0/${tasks.length})`,
        detail: tasks[0]?.fileName || "",
        current: 0,
        total: tasks.length,
    });

    for (let i = 0; i < tasks.length; i++) {
        const task = tasks[i];
        const courseSeg = sanitizeSegment(task.courseName || "eeclass_Course");
        const sectionSeg = sanitizeSegment(task.section || "未分類單元");
        const fileSeg = sanitizeSegment(task.fileName || "downloaded_file");
        const normalizedTaskPath = `${courseSeg}/${sectionSeg}/${fileSeg}`;

        await updateLiveProgress({
            active: true,
            type: "download",
            title: `正在儲存教材 (${i + 1}/${tasks.length})`,
            detail: `${courseSeg} / ${sectionSeg} / ${fileSeg}`,
            current: i,
            total: tasks.length,
        });

        if (extDirHandle) {
            try {
                await writeTaskToHandle(
                    extDirHandle,
                    {
                        ...task,
                        courseName: courseSeg,
                        section: sectionSeg,
                        fileName: fileSeg,
                        path: normalizedTaskPath,
                    },
                    conflictAction
                );
                succeededUrls.push(task.url);
                continue;
            }
            catch (err) {
                console.warn("寫入綁定本機資料夾失敗，改由系統下載目錄建立：", err);
                usedMode = "chrome_downloads";
                fallbackToDefaultSubfolder = true;
            }
        }

        const subDir = fallbackToDefaultSubfolder ? DEFAULT_SUBFOLDER : effectiveDownloadSubfolder;
        const filename = buildFinalDownloadPath(normalizedTaskPath, subDir);
        const taskMeta = {
            url: task.url,
            courseName: courseSeg,
            section: sectionSeg,
            fileName: fileSeg,
            path: normalizedTaskPath,
            targetDirectory: subDir,
            conflictAction,
            claimed: false,
            createdAt: Date.now(),
        };

        enqueuePendingDownload(taskMeta);
        activeSequentialTaskMeta = taskMeta;

        try {
            const ok = await new Promise((resolve) => {
                chrome.downloads.download(
                    {
                        url: task.url,
                        filename,
                        conflictAction,
                        saveAs: false,
                    },
                    (downloadId) => {
                        if (chrome.runtime.lastError || !downloadId) {
                            console.error("下載失敗：", filename, chrome.runtime.lastError?.message);
                            taskMeta.claimed = true;
                            resolve(false);
                            return;
                        }
                        if (!taskMeta.claimed) {
                            pendingDownloadsById.set(downloadId, taskMeta);
                        }
                        resolve(true);
                    }
                );
            });
            if (ok) {
                succeededUrls.push(task.url);
            }
            else {
                failedUrls.push(task.url);
            }
            await new Promise((resolve) => setTimeout(resolve, 260));
        }
        catch (err) {
            console.error("下載失敗：", task, err);
            taskMeta.claimed = true;
            failedUrls.push(task.url);
        }
        finally {
            if (activeSequentialTaskMeta === taskMeta) {
                activeSequentialTaskMeta = null;
            }
        }
    }

    await updateLiveProgress({
        active: false,
        type: "download",
        title: `✓ 已下載 ${succeededUrls.length}/${tasks.length} 份教材至「${destLabel}」`,
        detail: failedUrls.length > 0 ? `失敗 ${failedUrls.length} 份` : "所有檔案已歸檔完成",
        current: tasks.length,
        total: tasks.length,
        percent: 100,
        appendLog: {
            time: Date.now(),
            kind: "download",
            text: `已儲存 ${succeededUrls.length} 份教材至「${destLabel}」`,
        },
    });

    return {
        mode: usedMode,
        fallbackToDefaultSubfolder,
        folderName: destLabel,
        succeededUrls,
        failedUrls,
    };
}
