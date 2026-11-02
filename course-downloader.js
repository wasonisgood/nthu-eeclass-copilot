"use strict";

(function initEeclassCourseDownloader() {
    const STUDENT_CONFIG_KEY = "eeclassStudentConfig";
    const SYNCED_URLS_KEY = "eeclassSyncedUrls";
    const LIVE_PROGRESS_KEY = "eeclassLiveProgress";
    const IDB_NAME = "eeclassDownloaderDB";
    const IDB_STORE = "directoryHandles";
    const IDB_HANDLE_KEY = "boundLocalDirectory";
    const DEFAULT_SUBFOLDER = "eeclass_教材";

    const MAX_SEGMENT_LENGTH = 100;
    const FETCH_CONCURRENCY = 4;

    const DEFAULT_STUDENT_CONFIG = {
        enableDownloaderUI: true,
        targetDirectory: DEFAULT_SUBFOLDER,
        useLocalFsHandle: false,
        handleOrigin: "default",
        boundFolderName: "",
        autoSyncCourseFiles: false,
        showInlineDirDownloadBtn: true,
        interceptSingleDownload: false,
        conflictAction: "uniquify",
    };

    let currentConfig = { ...DEFAULT_STUDENT_CONFIG };
    let cachedDirHandle = null;
    let userPinnedHudOpen = false;
    let autoHideHudTimer = null;

    function pushLiveProgress(patch) {
        try {
            chrome.runtime.sendMessage({ action: "update_live_progress", patch });
        }
        catch {
            // Ignore
        }
    }

    function getStudentConfig() {
        return new Promise((resolve) => {
            if (typeof chrome === "undefined" || !chrome.storage?.local) {
                resolve({ ...DEFAULT_STUDENT_CONFIG });
                return;
            }
            chrome.storage.local.get([STUDENT_CONFIG_KEY], (res) => {
                resolve({ ...DEFAULT_STUDENT_CONFIG, ...(res?.[STUDENT_CONFIG_KEY] ?? {}) });
            });
        });
    }

    function saveStudentConfig(partial) {
        currentConfig = { ...currentConfig, ...partial };
        return new Promise((resolve) => {
            if (typeof chrome === "undefined" || !chrome.storage?.local) {
                resolve();
                return;
            }
            chrome.storage.local.set({ [STUDENT_CONFIG_KEY]: currentConfig }, () => resolve());
        });
    }

    function getSyncedUrlsMap() {
        return new Promise((resolve) => {
            if (typeof chrome === "undefined" || !chrome.storage?.local) {
                resolve({});
                return;
            }
            chrome.storage.local.get([SYNCED_URLS_KEY], (res) => {
                resolve(res?.[SYNCED_URLS_KEY] ?? {});
            });
        });
    }

    function markUrlsAsSynced(urls) {
        if (!Array.isArray(urls) || urls.length === 0) {
            return Promise.resolve();
        }
        return new Promise((resolve) => {
            getSyncedUrlsMap().then((map) => {
                const now = Date.now();
                for (const url of urls) {
                    map[url] = now;
                }
                chrome.storage.local.set({ [SYNCED_URLS_KEY]: map }, () => resolve());
            });
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

    async function loadSavedDirectoryHandle() {
        try {
            const db = await openHandleDB();
            return await new Promise((resolve) => {
                const tx = db.transaction(IDB_STORE, "readonly");
                const req = tx.objectStore(IDB_STORE).get(IDB_HANDLE_KEY);
                req.onsuccess = () => resolve(req.result ?? null);
                req.onerror = () => resolve(null);
            });
        }
        catch {
            return null;
        }
    }

    async function saveDirectoryHandle(handle) {
        const db = await openHandleDB();
        return await new Promise((resolve, reject) => {
            const tx = db.transaction(IDB_STORE, "readwrite");
            tx.objectStore(IDB_STORE).put(handle, IDB_HANDLE_KEY);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    /**
     * 實際測試資料夾是否可建立與寫入檔案（寫入測試暫存檔並立即刪除）
     */
    async function verifyDirectoryWritable(dirHandle, allowPrompt = false) {
        if (!dirHandle || typeof dirHandle.queryPermission !== "function") {
            return { ok: false, permission: "none", reason: "尚未選擇資料夾" };
        }
        try {
            let perm = await dirHandle.queryPermission({ mode: "readwrite" });
            if (perm !== "granted" && allowPrompt && typeof dirHandle.requestPermission === "function") {
                perm = await dirHandle.requestPermission({ mode: "readwrite" });
            }
            if (perm !== "granted") {
                return {
                    ok: false,
                    permission: perm,
                    reason: perm === "prompt" ? "尚未授權資料夾讀寫權限" : "資料夾讀寫權限遭拒",
                };
            }
            const probeName = `.eeclass_write_probe_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.tmp`;
            const fileHandle = await dirHandle.getFileHandle(probeName, { create: true });
            const writable = await fileHandle.createWritable();
            await writable.write(new Blob(["ok"], { type: "text/plain" }));
            await writable.close();
            await dirHandle.removeEntry(probeName);
            return { ok: true, permission: "granted", folderName: dirHandle.name };
        }
        catch (err) {
            return {
                ok: false,
                permission: "error",
                reason: err?.name === "NotFoundError"
                    ? "原選定的資料夾已被移動或刪除"
                    : "該資料夾無法寫入（可能為唯讀或受系統保護目錄）",
            };
        }
    }

    async function pickAndBindLocalDirectory() {
        if (typeof window.showDirectoryPicker !== "function") {
            return null;
        }
        try {
            const handle = await window.showDirectoryPicker({ mode: "readwrite" });
            const check = await verifyDirectoryWritable(handle, true);
            if (!check.ok) {
                alert(`無法將預設目錄更新為「${handle.name}」：\n${check.reason}\n請選擇其他可寫入的資料夾。`);
                return null;
            }
            cachedDirHandle = handle;
            await saveDirectoryHandle(handle);
            await saveStudentConfig({
                useLocalFsHandle: true,
                handleOrigin: "page",
                boundFolderName: handle.name,
                targetDirectory: handle.name,
            });
            return handle;
        }
        catch (err) {
            if (err?.name !== "AbortError") {
                console.error("選擇資料夾失敗：", err);
            }
            return null;
        }
    }

    async function ensureWritablePageDirectoryHandle(allowPrompt = false) {
        if (!currentConfig.useLocalFsHandle) {
            return null;
        }
        if (!cachedDirHandle) {
            cachedDirHandle = await loadSavedDirectoryHandle();
        }
        if (!cachedDirHandle) {
            return null;
        }
        const check = await verifyDirectoryWritable(cachedDirHandle, allowPrompt);
        return check.ok ? cachedDirHandle : null;
    }

    function checkExtensionDirStatus() {
        return new Promise((resolve) => {
            chrome.runtime.sendMessage({ action: "check_extension_dir_status" }, (resp) => {
                if (chrome.runtime.lastError || !resp) {
                    resolve({ hasHandle: false, writable: false });
                    return;
                }
                resolve(resp);
            });
        });
    }

    function sanitizePath(name) {
        let s = String(name || "")
            .replace(/[\\/:*?"<>|~]/g, "_")
            .replace(/\s+/g, " ")
            .trim();
        if (s.length > MAX_SEGMENT_LENGTH) {
            s = s.slice(0, MAX_SEGMENT_LENGTH).trim();
        }
        return s.replace(/[. ]+$/, "") || "untitled";
    }

    function getCourseName() {
        const titleElem = document.querySelector(".fs-banner-title .text, .fs-banner-title");
        if (titleElem) {
            return sanitizePath(titleElem.innerText);
        }
        return "eeclass_Course";
    }

    function cleanText(elem) {
        const cloned = elem.cloneNode(true);
        cloned.querySelectorAll(".font-icon, .fs-hint, .eeclass-inline-dl-btn").forEach((e) => e.remove());
        return cloned.textContent.replace(/\s+/g, " ").trim();
    }

    function getSectionTitle(groupNode) {
        if (!groupNode) {
            return "未分類單元";
        }
        const titleElem = groupNode.querySelector(":scope > .header .node-title");
        return titleElem ? sanitizePath(cleanText(titleElem)) : "未分類單元";
    }

    function resolveSectionForLink(a) {
        const group = a.closest(".xtree-node.type-group") ||
            a.closest(".xtree-node")?.parentElement?.closest(".xtree-node.type-group");
        if (group) {
            return getSectionTitle(group);
        }
        const mediaHeader = document.querySelector("#xbox-inline .fs-panel-header h3, .fs-page-header h2, .breadcrumb li.active");
        if (mediaHeader) {
            return sanitizePath(cleanText(mediaHeader));
        }
        return "課程附件";
    }

    function isFileDownloadLink(a) {
        return /\/(filedownload|download)\/\d+/.test(a.getAttribute("href") || "");
    }

    function isMediaPageLink(a) {
        try {
            return /^\/media\/[^/]+\/\d+/.test(new URL(a.href, location.origin).pathname);
        }
        catch {
            return false;
        }
    }

    function collectFromCoursePage() {
        const direct = [];
        const pages = [];
        const tree = document.querySelector("#content_xtree");

        if (tree) {
            tree.querySelectorAll(".xtree-node").forEach((node) => {
                const group = node.classList.contains("type-group")
                    ? node
                    : node.parentElement.closest(".xtree-node.type-group");
                const section = getSectionTitle(group);
                const header = node.querySelector(":scope > .header");
                if (!header) {
                    return;
                }

                if (node.classList.contains("type-group")) {
                    header.querySelectorAll(".description a[href]").forEach((a) => {
                        if (isFileDownloadLink(a)) {
                            direct.push({ a, section });
                        }
                    });
                    return;
                }

                header.querySelectorAll(".node-title a[href]").forEach((a) => {
                    if (isFileDownloadLink(a)) {
                        direct.push({ a, section });
                    }
                    else if (isMediaPageLink(a)) {
                        pages.push({ url: a.href, title: cleanText(a), section });
                    }
                });
            });
        }
        else {
            const root = document.querySelector("#fs-content") || document.body;
            root.querySelectorAll("a[href]").forEach((a) => {
                if (isFileDownloadLink(a)) {
                    direct.push({ a, section: resolveSectionForLink(a) });
                }
                else if (isMediaPageLink(a)) {
                    pages.push({ url: a.href, title: cleanText(a), section: "未分類單元" });
                }
            });
        }

        return { direct, pages };
    }

    async function fetchAttachments(page) {
        const resp = await fetch(page.url, { credentials: "include" });
        if (!resp.ok) {
            throw new Error(`HTTP ${resp.status}`);
        }
        const doc = new DOMParser().parseFromString(await resp.text(), "text/html");
        const root = doc.querySelector("#xbox-inline") || doc.querySelector("#fs-media-content") || doc.body;
        const results = [];
        root.querySelectorAll("a[href]").forEach((a) => {
            if (!isFileDownloadLink(a)) {
                return;
            }
            results.push({
                url: new URL(a.getAttribute("href"), page.url).href,
                name: cleanText(a),
            });
        });
        return results;
    }

    async function runWithConcurrency(items, limit, worker) {
        let index = 0;
        const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
            while (index < items.length) {
                const i = index++;
                await worker(items[i], i);
            }
        });
        await Promise.all(runners);
    }

    async function parseCourseFiles(onProgress) {
        const courseName = getCourseName();
        const { direct, pages } = collectFromCoursePage();
        const tasks = [];
        const seen = new Set();
        const failed = [];

        const addTask = (url, name, section) => {
            if (seen.has(url)) {
                return;
            }
            seen.add(url);
            const cleanSection = sanitizePath(section || "未分類單元");
            const cleanName = sanitizePath(name || "downloaded_file");
            tasks.push({
                url,
                courseName,
                section: cleanSection,
                fileName: cleanName,
                path: `${courseName}/${cleanSection}/${cleanName}`,
            });
        };

        direct.forEach(({ a, section }) => addTask(a.href, cleanText(a), section));

        const uniquePages = [...new Map(pages.map((p) => [p.url, p])).values()];
        let done = 0;
        await runWithConcurrency(uniquePages, FETCH_CONCURRENCY, async (page) => {
            try {
                const attachments = await fetchAttachments(page);
                attachments.forEach((f) => addTask(f.url, f.name, page.section));
            }
            catch (err) {
                console.error("讀取教材頁面失敗：", page.url, err);
                failed.push(page.title || page.url);
            }
            if (typeof onProgress === "function") {
                onProgress(++done, uniquePages.length);
            }
        });

        return { tasks, failed };
    }

    function extractFilenameFromHeader(contentDisposition, fallbackName) {
        if (!contentDisposition) {
            return fallbackName;
        }
        const utf8Match = /filename\*=UTF-8''([^;\r\n]+)/i.exec(contentDisposition);
        if (utf8Match?.[1]) {
            try {
                return sanitizePath(decodeURIComponent(utf8Match[1].replace(/["']/g, "")));
            }
            catch {
                // Ignore
            }
        }
        const plainMatch = /filename="?([^";\r\n]+)"?/i.exec(contentDisposition);
        if (plainMatch?.[1]) {
            try {
                return sanitizePath(decodeURIComponent(plainMatch[1]));
            }
            catch {
                return sanitizePath(plainMatch[1]);
            }
        }
        return fallbackName;
    }

    function ensureExtensionFromServerFilename(preferredName, serverName) {
        if (!serverName) {
            return preferredName;
        }
        const serverDot = serverName.lastIndexOf(".");
        if (serverDot <= 0) {
            return preferredName;
        }
        const ext = serverName.slice(serverDot);
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

    async function writeTasksToDirectoryHandle(dirHandle, tasks, onItemProgress, flatInPickedDir = false) {
        let completed = 0;
        const succeededUrls = [];
        const conflictAction = currentConfig.conflictAction || "uniquify";

        pushLiveProgress({
            active: true,
            type: "download",
            title: `正在寫入「${dirHandle.name}」(0/${tasks.length})`,
            detail: tasks[0]?.fileName || "",
            current: 0,
            total: tasks.length,
        });

        for (const task of tasks) {
            pushLiveProgress({
                active: true,
                type: "download",
                title: `正在寫入「${dirHandle.name}」(${completed + 1}/${tasks.length})`,
                detail: `${task.courseName || ""} / ${task.fileName}`,
                current: completed,
                total: tasks.length,
            });
            try {
                let targetDir = dirHandle;
                if (!flatInPickedDir) {
                    const courseDir = await dirHandle.getDirectoryHandle(task.courseName, { create: true });
                    targetDir = await courseDir.getDirectoryHandle(task.section, { create: true });
                }
                const resp = await fetch(task.url, { credentials: "include" });
                if (!resp.ok) {
                    throw new Error(`HTTP ${resp.status}`);
                }
                const serverName = extractFilenameFromHeader(
                    resp.headers.get("content-disposition"),
                    task.fileName
                );
                const normalizedName = sanitizePath(ensureExtensionFromServerFilename(task.fileName, serverName));
                const finalFileName = await resolveUniqueFileName(targetDir, normalizedName, conflictAction);

                const fileHandle = await targetDir.getFileHandle(finalFileName, { create: true });
                const writable = await fileHandle.createWritable();
                const blob = await resp.blob();
                await writable.write(blob);
                await writable.close();
                succeededUrls.push(task.url);
                await markUrlsAsSynced([task.url]);
            }
            catch (err) {
                console.error("寫入本機資料夾失敗：", task, err);
            }
            completed++;
            if (typeof onItemProgress === "function") {
                onItemProgress(completed, tasks.length);
            }
        }

        pushLiveProgress({
            active: false,
            type: "download",
            title: `✓ 已儲存 ${succeededUrls.length}/${tasks.length} 份教材至「${dirHandle.name}」`,
            detail: "所有檔案寫入完成",
            current: tasks.length,
            total: tasks.length,
            percent: 100,
            appendLog: {
                time: Date.now(),
                kind: "download",
                text: `已寫入 ${succeededUrls.length} 份教材至「${dirHandle.name}」`,
            },
        });

        return succeededUrls;
    }

    async function executeDownloadTasks(tasks, options = {}) {
        const { allowPrompt = false, onStatusUpdate, customDirHandle } = options;

        if (customDirHandle) {
            if (typeof onStatusUpdate === "function") {
                onStatusUpdate(`正在寫入「${customDirHandle.name}」(0/${tasks.length})...`);
            }
            await writeTasksToDirectoryHandle(
                customDirHandle,
                tasks,
                (done, total) => {
                    if (typeof onStatusUpdate === "function") {
                        onStatusUpdate(`正在寫入「${customDirHandle.name}」(${done}/${total})...`);
                    }
                },
                true
            );
            return { mode: "local_handle", folderName: customDirHandle.name };
        }

        if (currentConfig.useLocalFsHandle && currentConfig.handleOrigin === "extension") {
            const extStatus = await checkExtensionDirStatus();
            if (extStatus.writable) {
                if (typeof onStatusUpdate === "function") {
                    onStatusUpdate(`正在寫入「${extStatus.folderName || currentConfig.boundFolderName}」(${tasks.length} 份)...`);
                }
                const bgResult = await new Promise((resolve) => {
                    chrome.runtime.sendMessage(
                        {
                            action: "download_files",
                            tasks,
                            useLocalFsHandle: true,
                            targetDirectory: currentConfig.boundFolderName || DEFAULT_SUBFOLDER,
                            conflictAction: currentConfig.conflictAction || "uniquify",
                        },
                        (res) => resolve(res || { succeededUrls: [] })
                    );
                });
                await markUrlsAsSynced(bgResult.succeededUrls || []);
                return {
                    mode: bgResult.mode || "extension_handle",
                    folderName: bgResult.folderName || currentConfig.boundFolderName,
                };
            }
        }

        const pageDirHandle = await ensureWritablePageDirectoryHandle(allowPrompt);
        if (pageDirHandle) {
            if (typeof onStatusUpdate === "function") {
                onStatusUpdate(`正在寫入「${pageDirHandle.name}」(0/${tasks.length})...`);
            }
            await writeTasksToDirectoryHandle(
                pageDirHandle,
                tasks,
                (done, total) => {
                    if (typeof onStatusUpdate === "function") {
                        onStatusUpdate(`正在寫入「${pageDirHandle.name}」(${done}/${total})...`);
                    }
                },
                false
            );
            return { mode: "local_handle", folderName: pageDirHandle.name };
        }

        const targetDirectory = currentConfig.useLocalFsHandle
            ? (currentConfig.boundFolderName || DEFAULT_SUBFOLDER)
            : (currentConfig.targetDirectory || DEFAULT_SUBFOLDER);

        const bgResult = await new Promise((resolve) => {
            chrome.runtime.sendMessage(
                {
                    action: "download_files",
                    tasks,
                    useLocalFsHandle: Boolean(currentConfig.useLocalFsHandle),
                    targetDirectory,
                    conflictAction: currentConfig.conflictAction || "uniquify",
                },
                (res) => resolve(res || { succeededUrls: [] })
            );
        });
        await markUrlsAsSynced(bgResult.succeededUrls || []);
        return {
            mode: bgResult.mode || "chrome_downloads",
            folderName: bgResult.folderName || `系統「下載」/${DEFAULT_SUBFOLDER}`,
        };
    }

    async function downloadSingleAttachmentLink(a, options = {}) {
        const courseName = getCourseName();
        const section = sanitizePath(resolveSectionForLink(a));
        const fileName = sanitizePath(cleanText(a) || "downloaded_file");
        const task = {
            url: a.href,
            courseName,
            section,
            fileName,
            path: `${courseName}/${section}/${fileName}`,
        };
        return await executeDownloadTasks([task], {
            allowPrompt: true,
            customDirHandle: options.customDirHandle,
        });
    }

    function decorateIndividualDownloadLinks(root = document) {
        const links = root.querySelectorAll("a[href]");
        links.forEach((a) => {
            if (!isFileDownloadLink(a) || a.dataset.eeclassSingleBound === "true") {
                return;
            }
            a.dataset.eeclassSingleBound = "true";

            a.addEventListener("click", (event) => {
                if (!currentConfig.interceptSingleDownload || event.altKey || event.ctrlKey || event.metaKey) {
                    return;
                }
                event.preventDefault();
                event.stopPropagation();
                downloadSingleAttachmentLink(a);
            });

            if (currentConfig.showInlineDirDownloadBtn) {
                const inlineBtn = document.createElement("button");
                inlineBtn.type = "button";
                inlineBtn.className = "eeclass-inline-dl-btn";
                const folderName = getTargetFolderDisplayLabel();
                inlineBtn.title = `存入「${folderName}」（不存在時自動建立；按住 Shift 點擊可另選其他資料夾）`;
                inlineBtn.textContent = "存入指定目錄";

                inlineBtn.addEventListener("click", async (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    let customDirHandle = null;
                    if (event.shiftKey && typeof window.showDirectoryPicker === "function") {
                        try {
                            const picked = await window.showDirectoryPicker({ mode: "readwrite" });
                            const check = await verifyDirectoryWritable(picked, true);
                            if (!check.ok) {
                                alert(`所選資料夾「${picked.name}」無法寫入：\n${check.reason}`);
                                return;
                            }
                            customDirHandle = picked;
                        }
                        catch {
                            return;
                        }
                    }
                    inlineBtn.disabled = true;
                    inlineBtn.textContent = "儲存中...";
                    try {
                        await downloadSingleAttachmentLink(a, { customDirHandle });
                        inlineBtn.textContent = "已存入";
                    }
                    catch {
                        inlineBtn.textContent = "失敗";
                    }
                    setTimeout(() => {
                        inlineBtn.disabled = false;
                        inlineBtn.textContent = "存入指定目錄";
                    }, 1600);
                });

                a.insertAdjacentElement("afterend", inlineBtn);
            }
        });
    }

    function updateInlineButtonsVisibility() {
        const buttons = document.querySelectorAll(".eeclass-inline-dl-btn");
        buttons.forEach((btn) => {
            btn.style.display = currentConfig.showInlineDirDownloadBtn ? "inline-flex" : "none";
            btn.title = `存入「${getTargetFolderDisplayLabel()}」（不存在時自動建立；按住 Shift 點擊可另選其他資料夾）`;
        });
        if (currentConfig.showInlineDirDownloadBtn) {
            decorateIndividualDownloadLinks(document);
        }
    }

    function getTargetFolderDisplayLabel() {
        if (currentConfig.useLocalFsHandle && currentConfig.boundFolderName) {
            return currentConfig.boundFolderName;
        }
        return `下載/${currentConfig.targetDirectory || DEFAULT_SUBFOLDER}`;
    }

    async function runAutoSyncIfNeeded(statusBadge) {
        if (!currentConfig.autoSyncCourseFiles) {
            return;
        }
        if (!/^\/course\//.test(location.pathname)) {
            return;
        }
        if (statusBadge) {
            statusBadge.hidden = false;
            statusBadge.textContent = "正在檢查課程新教材...";
        }
        try {
            const [{ tasks }, syncedMap] = await Promise.all([
                parseCourseFiles(),
                getSyncedUrlsMap(),
            ]);
            const unsyncedTasks = tasks.filter((t) => !syncedMap[t.url]);
            if (unsyncedTasks.length === 0) {
                if (statusBadge) {
                    statusBadge.textContent = `教材已為最新 (${tasks.length} 份)`;
                    setTimeout(() => {
                        statusBadge.hidden = true;
                    }, 3000);
                }
                return;
            }
            if (statusBadge) {
                statusBadge.textContent = `發現 ${unsyncedTasks.length} 份新教材，同步中...`;
            }
            const res = await executeDownloadTasks(unsyncedTasks, {
                allowPrompt: false,
                onStatusUpdate: (msg) => {
                    if (statusBadge) {
                        statusBadge.textContent = msg;
                    }
                },
            });
            if (statusBadge) {
                statusBadge.textContent = `已自動同步 ${unsyncedTasks.length} 份教材至「${res.folderName}」`;
                setTimeout(() => {
                    statusBadge.hidden = true;
                }, 4500);
            }
        }
        catch (err) {
            console.error("自動同步教材失敗：", err);
            if (statusBadge) {
                statusBadge.textContent = "自動同步失敗";
            }
        }
    }

    function renderHudWithProgress(progressState) {
        const hud = document.getElementById("eeclass-live-hud");
        const progressBtn = document.getElementById("eeclass-dl-progress-btn");
        if (!hud || !progressState) {
            return;
        }

        const dot = hud.querySelector(".eeclass-hud-dot");
        const titleEl = hud.querySelector(".eeclass-hud-title-text");
        const detailEl = hud.querySelector(".eeclass-hud-detail");
        const fillEl = hud.querySelector(".eeclass-hud-bar-fill");
        const logsEl = hud.querySelector(".eeclass-hud-logs");

        const isActive = Boolean(progressState.active);
        if (dot) {
            dot.dataset.active = isActive ? "true" : "false";
        }
        if (titleEl) {
            titleEl.textContent = progressState.title || (isActive ? "正在處理同步任務..." : "目前無進行中同步");
        }
        if (detailEl) {
            const timeStr = progressState.updatedAt
                ? new Date(progressState.updatedAt).toLocaleTimeString("zh-TW", { hour12: false })
                : "";
            detailEl.textContent = progressState.detail
                ? progressState.detail
                : timeStr
                    ? `最後更新時間：${timeStr}`
                    : "隨時點擊「進度」可檢視最新同步紀錄";
        }
        if (fillEl) {
            fillEl.style.width = `${progressState.percent ?? (isActive ? 25 : 100)}%`;
        }
        if (progressBtn) {
            progressBtn.textContent = isActive
                ? `同步中 ${progressState.percent || 0}%`
                : "同步進度";
        }

        if (logsEl) {
            const logs = Array.isArray(progressState.recentLogs) ? progressState.recentLogs : [];
            if (logs.length === 0) {
                logsEl.hidden = true;
            }
            else {
                logsEl.hidden = false;
                logsEl.innerHTML = "";
                for (const item of logs.slice(0, 5)) {
                    const row = document.createElement("div");
                    row.className = "eeclass-hud-log-item";
                    const t = item.time
                        ? new Date(item.time).toLocaleTimeString("zh-TW", { hour12: false })
                        : "";
                    row.innerHTML = `<span>${item.text || ""}</span><span>${t}</span>`;
                    logsEl.appendChild(row);
                }
            }
        }

        // 當有任務正在進行時自動展開進度面板；完成後若非使用者手動釘選則 5 秒後收合
        if (isActive) {
            hud.hidden = false;
            if (autoHideHudTimer) {
                clearTimeout(autoHideHudTimer);
                autoHideHudTimer = null;
            }
        }
        else if (!userPinnedHudOpen && !hud.hidden) {
            if (autoHideHudTimer) {
                clearTimeout(autoHideHudTimer);
            }
            autoHideHudTimer = setTimeout(() => {
                if (!userPinnedHudOpen) {
                    hud.hidden = true;
                }
            }, 5000);
        }
    }

    function injectDownloaderWidget() {
        let container = document.getElementById("eeclass-dl-widget");
        if (!currentConfig.enableDownloaderUI) {
            if (container) {
                container.remove();
            }
            return;
        }
        if (container) {
            const dirInfo = container.querySelector(".eeclass-dl-dir-label");
            if (dirInfo) {
                dirInfo.textContent = getTargetFolderDisplayLabel();
            }
            return;
        }

        container = document.createElement("div");
        container.id = "eeclass-dl-widget";

        // 即時進度面板 (Live Progress HUD)
        const hud = document.createElement("div");
        hud.id = "eeclass-live-hud";
        hud.className = "eeclass-live-hud";
        hud.hidden = true;
        hud.innerHTML = `
          <div class="eeclass-hud-header">
            <div class="eeclass-hud-title">
              <span class="eeclass-hud-dot" data-active="false"></span>
              <span class="eeclass-hud-title-text">目前無進行中同步</span>
            </div>
            <button type="button" class="eeclass-hud-close" title="隱藏進度面板">&times;</button>
          </div>
          <div class="eeclass-hud-detail">等待同步或下載任務...</div>
          <div class="eeclass-hud-bar-track">
            <div class="eeclass-hud-bar-fill"></div>
          </div>
          <div class="eeclass-hud-logs" hidden></div>
        `;
        hud.querySelector(".eeclass-hud-close")?.addEventListener("click", () => {
            userPinnedHudOpen = false;
            hud.hidden = true;
        });

        const statusBadge = document.createElement("div");
        statusBadge.className = "eeclass-dl-status-badge";
        statusBadge.hidden = true;

        const bar = document.createElement("div");
        bar.className = "eeclass-dl-bar";

        const isCourseOrMediaPage = /^\/(course|media)\//.test(location.pathname);

        const mainBtn = document.createElement("button");
        mainBtn.id = "eeclass-dl-btn";
        mainBtn.type = "button";
        const defaultLabel = isCourseOrMediaPage ? "依單元下載所有檔案" : "同步最近事件至日曆";
        mainBtn.textContent = defaultLabel;

        const dirBtn = document.createElement("button");
        dirBtn.type = "button";
        dirBtn.className = "eeclass-dl-dir-btn";
        dirBtn.title = "點擊選擇並檢查可寫入之本機資料夾";
        dirBtn.innerHTML = `<span class="eeclass-dl-dir-label">${getTargetFolderDisplayLabel()}</span>`;

        const progressBtn = document.createElement("button");
        progressBtn.id = "eeclass-dl-progress-btn";
        progressBtn.type = "button";
        progressBtn.className = "eeclass-dl-progress-btn";
        progressBtn.title = "點擊查看目前同步與下載進度";
        progressBtn.textContent = "同步進度";

        const splitSettingsBtn = document.createElement("button");
        splitSettingsBtn.type = "button";
        splitSettingsBtn.className = "eeclass-dl-settings-btn";
        splitSettingsBtn.title = "在側邊分割視窗開啟完整設定";
        splitSettingsBtn.setAttribute("aria-label", "開啟側邊設定");
        splitSettingsBtn.innerHTML = `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="1.75" y="2.25" width="12.5" height="11.5" rx="2"/><line x1="9.5" y1="2.5" x2="9.5" y2="13.5"/></svg>`;

        dirBtn.addEventListener("click", async () => {
            const handle = await pickAndBindLocalDirectory();
            if (handle) {
                const dirLabel = dirBtn.querySelector(".eeclass-dl-dir-label");
                if (dirLabel) {
                    dirLabel.textContent = handle.name;
                }
                updateInlineButtonsVisibility();
            }
        });

        progressBtn.addEventListener("click", () => {
            userPinnedHudOpen = hud.hidden;
            hud.hidden = !hud.hidden;
            if (!hud.hidden) {
                chrome.storage.local.get([LIVE_PROGRESS_KEY], (res) => {
                    if (res?.[LIVE_PROGRESS_KEY]) {
                        renderHudWithProgress(res[LIVE_PROGRESS_KEY]);
                    }
                });
            }
        });

        splitSettingsBtn.addEventListener("click", () => {
            chrome.runtime.sendMessage({ action: "open_split_settings" });
        });

        mainBtn.addEventListener("click", async () => {
            if (!isCourseOrMediaPage) {
                // 在 /dashboard 或非課程頁點擊時，直接執行背景最近事件與作業詳情同步至 Google 日曆
                mainBtn.disabled = true;
                mainBtn.textContent = "同步日曆中...";
                userPinnedHudOpen = true;
                hud.hidden = false;
                chrome.runtime.sendMessage(
                    {
                        action: "calendar_sync_now_from_background",
                        forceUpdate: true,
                        interactiveAuth: true,
                    },
                    (res) => {
                        mainBtn.disabled = false;
                        mainBtn.textContent = res?.ok ? "✓ 日曆已同步" : "請先授權日曆";
                        setTimeout(() => {
                            mainBtn.textContent = defaultLabel;
                        }, 3000);
                    }
                );
                return;
            }

            mainBtn.disabled = true;
            mainBtn.textContent = "掃描中...";
            userPinnedHudOpen = true;
            hud.hidden = false;
            pushLiveProgress({
                active: true,
                type: "download",
                title: "正在掃描課程教材頁面...",
                detail: getCourseName(),
                current: 0,
                total: 1,
            });

            let result;
            try {
                result = await parseCourseFiles((done, total) => {
                    mainBtn.textContent = `讀取教材頁面 ${done}/${total}...`;
                    pushLiveProgress({
                        active: true,
                        type: "download",
                        title: `正在掃描課程教材頁面 (${done}/${total})`,
                        detail: getCourseName(),
                        current: done,
                        total,
                    });
                });
            }
            catch (err) {
                console.error(err);
                alert("掃描失敗：" + err.message);
                mainBtn.disabled = false;
                mainBtn.textContent = defaultLabel;
                return;
            }

            const { tasks, failed } = result;
            const failNote = failed.length ? `\n（有 ${failed.length} 個教材頁面讀取失敗，詳見 Console）` : "";

            if (tasks.length === 0) {
                pushLiveProgress({
                    active: false,
                    type: "download",
                    title: "此頁面未偵測到可下載教材檔案",
                    detail: "",
                    current: 0,
                    total: 0,
                });
                alert("此頁面未偵測到任何檔案下載連結！" + failNote);
                mainBtn.disabled = false;
                mainBtn.textContent = defaultLabel;
                return;
            }

            const targetDesc = getTargetFolderDisplayLabel();
            if (!confirm(`偵測到 ${tasks.length} 個檔案，是否依照單元分類下載至「${targetDesc}」？\n（若子目錄不存在將自動建立）${failNote}`)) {
                pushLiveProgress({
                    active: false,
                    type: "download",
                    title: "已取消下載",
                    detail: "",
                    current: 0,
                    total: 0,
                });
                mainBtn.disabled = false;
                mainBtn.textContent = defaultLabel;
                return;
            }

            mainBtn.textContent = `下載處理中 (${tasks.length} 個)...`;
            try {
                await executeDownloadTasks(tasks, {
                    allowPrompt: true,
                    onStatusUpdate: (msg) => {
                        mainBtn.textContent = msg;
                    },
                });
                mainBtn.disabled = false;
                mainBtn.textContent = "下載完成";
                setTimeout(() => {
                    mainBtn.textContent = defaultLabel;
                }, 3000);
            }
            catch (err) {
                console.error(err);
                mainBtn.disabled = false;
                mainBtn.textContent = defaultLabel;
            }
        });

        bar.appendChild(mainBtn);
        bar.appendChild(dirBtn);
        bar.appendChild(progressBtn);
        bar.appendChild(splitSettingsBtn);
        container.appendChild(hud);
        container.appendChild(statusBadge);
        container.appendChild(bar);
        document.body.appendChild(container);

        chrome.storage.local.get([LIVE_PROGRESS_KEY], (res) => {
            if (res?.[LIVE_PROGRESS_KEY]) {
                renderHudWithProgress(res[LIVE_PROGRESS_KEY]);
            }
        });

        runAutoSyncIfNeeded(statusBadge);
    }

    async function bootstrap() {
        currentConfig = await getStudentConfig();
        decorateIndividualDownloadLinks(document);
        injectDownloaderWidget();

        const observer = new MutationObserver(() => {
            decorateIndividualDownloadLinks(document);
        });
        if (document.body) {
            observer.observe(document.body, { childList: true, subtree: true });
        }

        if (typeof chrome !== "undefined" && chrome.storage?.onChanged) {
            chrome.storage.onChanged.addListener((changes, areaName) => {
                if (areaName === "local") {
                    if (changes[STUDENT_CONFIG_KEY]) {
                        currentConfig = {
                            ...DEFAULT_STUDENT_CONFIG,
                            ...(changes[STUDENT_CONFIG_KEY].newValue ?? {}),
                        };
                        updateInlineButtonsVisibility();
                        injectDownloaderWidget();
                    }
                    if (changes[LIVE_PROGRESS_KEY]?.newValue) {
                        renderHudWithProgress(changes[LIVE_PROGRESS_KEY].newValue);
                    }
                }
            });
        }
    }

    bootstrap();
})();
