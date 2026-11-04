"use strict";

(function initOptionsApp() {
    // 錯誤橫幅：頁面任何未處理的例外都會顯示在畫面頂端，避免整頁空白卻看不出原因
    function showFatalBanner(message) {
        try {
            let bar = document.getElementById("fatal-error-banner");
            if (!bar) {
                bar = document.createElement("div");
                bar.id = "fatal-error-banner";
                bar.setAttribute("role", "alert");
                bar.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:99999;background:#b91c1c;color:#fff;font:13px/1.5 sans-serif;padding:10px 14px;white-space:pre-wrap;word-break:break-all;";
                (document.body || document.documentElement).appendChild(bar);
            }
            bar.textContent = "頁面發生錯誤（請回報此訊息）：\n" + message;
        } catch (e) { /* 橫幅本身失敗時不再處理 */ }
    }
    window.addEventListener("error", (e) => {
        showFatalBanner(`${e.message || "未知錯誤"}\n${e.filename || ""}:${e.lineno || 0}`);
    });
    window.addEventListener("unhandledrejection", (e) => {
        const r = e.reason;
        showFatalBanner(`${(r && (r.message || r.name)) || String(r)}\n${(r && r.stack) ? r.stack.split("\n").slice(0, 3).join("\n") : ""}`);
    });

    const AUTH_STORAGE_KEY = "eeclassAuthConfig";
    const STUDENT_CONFIG_KEY = "eeclassStudentConfig";
    const TA_CONFIG_KEY = "eeclassTaConfig";
    const SYNCED_URLS_KEY = "eeclassSyncedUrls";
    const CALENDAR_CONFIG_KEY = "eeclassCalendarConfig";
    const LIVE_PROGRESS_KEY = "eeclassLiveProgress";

    const IDB_NAME = "eeclassDownloaderDB";
    const IDB_STORE = "directoryHandles";
    const IDB_HANDLE_KEY = "boundLocalDirectory";
    const DEFAULT_SUBFOLDER = "eeclass_教材";

    const vaultApi = globalThis.EECLASS_CRYPTO_VAULT;

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

    /**
     * 助教功能設定註冊表 (所有開關與選單皆即時自動儲存)
     */
    const TA_MODULE_GROUPS = [
        {
            id: "ta-homework",
            title: "作業與批改",
            description: "管理學生作業批次下載與批改輔助工具。",
            fields: [
                {
                    key: "enableHomeworkBatchHelper",
                    type: "switch",
                    label: "啟用作業批改列表快速工具列",
                    sub: "於助教作業檢視頁面顯示批次下載與狀態篩選列",
                    defaultValue: false,
                },
                {
                    key: "highlightLateSubmissions",
                    type: "switch",
                    label: "醒目提示遲交與未交學生",
                    sub: "於作業繳交名單中自動標示遲交與未繳狀態",
                    defaultValue: true,
                },
                {
                    key: "homeworkFolderButton",
                    type: "folder_picker",
                    label: "學生作業批次存放資料夾",
                    subKey: "homeworkBoundFolderName",
                    defaultSub: "預設目錄：系統「下載」/ eeclass_TA_作業（不存在時自動建立）",
                },
            ],
        },
        {
            id: "ta-grading",
            title: "成績與名單",
            description: "成績冊匯入/匯出格式轉換與修課名單同步設定。",
            fields: [
                {
                    key: "enableGradeCsvImporter",
                    type: "switch",
                    label: "啟用成績頁面 Excel / CSV 批次貼上填入",
                    sub: "支援直接從試算表複製學號與成績貼入 eeclass 評分欄",
                    defaultValue: false,
                },
                {
                    key: "gradeExportEncoding",
                    type: "select",
                    label: "名單與成績匯出預設編碼",
                    sub: "相容 Excel 直接開啟不亂碼",
                    options: [
                        { value: "utf8-bom", label: "UTF-8 (含 BOM)" },
                        { value: "utf8", label: "UTF-8 (標準)" },
                    ],
                    defaultValue: "utf8-bom",
                },
            ],
        },
        {
            id: "ta-publishing",
            title: "教材與公告",
            description: "助教上傳教材、發布公告與討論區管理預設行為。",
            fields: [
                {
                    key: "defaultAttachmentDownloadable",
                    type: "switch",
                    label: "新增教材時預設勾選「開放學生下載附件」",
                    sub: "省去每次上傳講義時手動勾選開放下載的步驟",
                    defaultValue: true,
                },
                {
                    key: "defaultAnnouncementNotifyMail",
                    type: "switch",
                    label: "張貼課程公告時預設勾選「同時發送 Email 通知」",
                    sub: "發布重要課程公告時自動啟用全班信件通知",
                    defaultValue: false,
                },
            ],
        },
    ];

    function getDefaultTaConfig() {
        const defaults = {
            homeworkBoundFolderName: "",
        };
        for (const group of TA_MODULE_GROUPS) {
            for (const field of group.fields) {
                if (field.defaultValue !== undefined) {
                    defaults[field.key] = field.defaultValue;
                }
            }
        }
        return defaults;
    }

    // 判斷目前開啟模式：popup (短選單) vs sidepanel / split / full (完整分割設定) vs wizard (首次設定精靈)
    const params = new URLSearchParams(location.search);
    const viewMode = params.get("mode") || "popup";
    const isWizardMode = params.get("wizard") === "1" || viewMode === "wizard";
    document.body.dataset.viewMode = isWizardMode ? "wizard" : viewMode;

    const compactShell = document.getElementById("compact-shell");
    const fullShell = document.getElementById("full-shell");
    const wizardShell = document.getElementById("wizard-shell");

    if (isWizardMode && wizardShell) {
        compactShell.hidden = true;
        fullShell.hidden = true;
        wizardShell.hidden = false;
        initExtensionWizard();
    }
    else if (viewMode === "popup") {
        compactShell.hidden = false;
        fullShell.hidden = true;
        if (wizardShell) wizardShell.hidden = true;
    }
    else {
        compactShell.hidden = true;
        fullShell.hidden = false;
        if (wizardShell) wizardShell.hidden = true;
    }

    // 自動儲存與狀態提示膠囊
    let toastTimer;
    function flashAutoSave(text = "已自動儲存", tone = "normal", durationMs = 2200) {
        const pill = viewMode === "popup"
            ? document.getElementById("compact-toast")
            : document.getElementById("full-toast");
        if (!pill) {
            return;
        }
        pill.textContent = text;
        if (tone === "normal") {
            delete pill.dataset.tone;
        }
        else {
            pill.dataset.tone = tone;
        }
        pill.hidden = false;
        if (toastTimer !== undefined) {
            clearTimeout(toastTimer);
        }
        toastTimer = setTimeout(() => {
            pill.hidden = true;
        }, durationMs);
    }

    // IndexedDB 存取選定的本機資料夾 Handle
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

    async function loadDirectoryHandleFromIDB(key = IDB_HANDLE_KEY) {
        try {
            const db = await openHandleDB();
            return await new Promise((resolve) => {
                const tx = db.transaction(IDB_STORE, "readonly");
                const req = tx.objectStore(IDB_STORE).get(key);
                req.onsuccess = () => resolve(req.result ?? null);
                req.onerror = () => resolve(null);
            });
        }
        catch {
            return null;
        }
    }

    async function saveDirectoryHandleToIDB(key, handle) {
        const db = await openHandleDB();
        return await new Promise((resolve, reject) => {
            const tx = db.transaction(IDB_STORE, "readwrite");
            tx.objectStore(IDB_STORE).put(handle, key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    async function removeDirectoryHandleFromIDB(key = IDB_HANDLE_KEY) {
        try {
            const db = await openHandleDB();
            await new Promise((resolve) => {
                const tx = db.transaction(IDB_STORE, "readwrite");
                tx.objectStore(IDB_STORE).delete(key);
                tx.oncomplete = () => resolve();
                tx.onerror = () => resolve();
            });
        }
        catch {
            // Ignore
        }
    }

    /**
     * 檢查所選或已存目錄是否真正可寫入（含權限確認 + 建立暫存檔實際寫入與清除測試）
     */
    async function verifyDirectoryWritable(dirHandle, allowRequestPrompt = false) {
        if (!dirHandle || typeof dirHandle.queryPermission !== "function") {
            return {
                ok: false,
                permission: "none",
                reason: "尚未綁定本機資料夾",
            };
        }
        try {
            let perm = await dirHandle.queryPermission({ mode: "readwrite" });
            if (perm !== "granted" && allowRequestPrompt && typeof dirHandle.requestPermission === "function") {
                perm = await dirHandle.requestPermission({ mode: "readwrite" });
            }
            if (perm !== "granted") {
                return {
                    ok: false,
                    permission: perm,
                    folderName: dirHandle.name,
                    reason: perm === "prompt"
                        ? "需點擊授權以允許寫入此資料夾"
                        : "未獲得資料夾讀寫權限",
                };
            }

            // 實際建立測試檔並寫入位元組，確認作業系統層級並非唯讀或受保護目錄，測試後立即刪除
            const probeName = `.eeclass_write_probe_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.tmp`;
            const fileHandle = await dirHandle.getFileHandle(probeName, { create: true });
            const writable = await fileHandle.createWritable();
            await writable.write(new Blob(["eeclass-write-check"], { type: "text/plain" }));
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
                reason: err?.name === "NotFoundError"
                    ? "原資料夾已被移動或刪除"
                    : "該目錄無法寫入（可能為唯讀或系統受保護資料夾）",
            };
        }
    }

    /**
     * 選擇資料夾並立即執行可存性寫入測試，通過才儲存
     */
    async function pickAndVerifyFolder(storeKey = IDB_HANDLE_KEY) {
        if (typeof window.showDirectoryPicker !== "function") {
            flashAutoSave("此瀏覽器環境不支援資料夾選擇器", "error", 3000);
            return null;
        }
        try {
            const handle = await window.showDirectoryPicker({ mode: "readwrite" });
            flashAutoSave("正在檢查目錄是否可存...", "normal", 2000);
            const check = await verifyDirectoryWritable(handle, true);
            if (!check.ok) {
                flashAutoSave(`❌ 無法儲存至「${handle.name}」：${check.reason}`, "error", 4000);
                return { ok: false, handle, check };
            }
            await saveDirectoryHandleToIDB(storeKey, handle);
            return { ok: true, handle, check };
        }
        catch (err) {
            if (err?.name !== "AbortError") {
                flashAutoSave(`❌ 選擇資料夾失敗：${err?.message || "未知錯誤"}`, "error", 3500);
            }
            return null;
        }
    }

    // 狀態快取
    let authState = {
        autoLogin: true,
        keep: false,
        id: "",
        password: "",
        crossSchool: false,
        school: "",
        cid: "",
        vaultMode: "device_key",
        locked: false,
    };
    let studentState = { ...DEFAULT_STUDENT_CONFIG };
    let taState = getDefaultTaConfig();
    let folderHealthState = {
        status: "default", // "default" | "ok" | "warn" | "error"
        message: "",
    };

    function updateFolderDisplayUI() {
        const defaultShortText = `預設：系統「下載」/ ${DEFAULT_SUBFOLDER}（自動建立）`;
        const defaultFullText = `預設目錄：系統「下載」/ ${DEFAULT_SUBFOLDER}（不存在時自動於「下載」資料夾建立）`;

        document.querySelectorAll("[data-folder-display]").forEach((el) => {
            const isCompact = Boolean(el.closest("#compact-shell"));
            if (!studentState.useLocalFsHandle || !studentState.boundFolderName) {
                el.textContent = isCompact ? defaultShortText : defaultFullText;
                delete el.dataset.status;
                return;
            }

            if (folderHealthState.message) {
                el.textContent = folderHealthState.message;
                if (folderHealthState.status && folderHealthState.status !== "default") {
                    el.dataset.status = folderHealthState.status;
                }
                else {
                    delete el.dataset.status;
                }
            }
            else {
                el.textContent = `已選資料夾：${studentState.boundFolderName}（子目錄不存在時自動建立）`;
                el.dataset.status = "ok";
            }
        });

        const resetFolderBtn = document.getElementById("reset-folder-btn");
        if (resetFolderBtn) {
            resetFolderBtn.hidden = !studentState.boundFolderName;
        }

        document.querySelectorAll(".folder-verify-trigger").forEach((btn) => {
            btn.hidden = !studentState.boundFolderName;
        });
    }

    /**
     * 檢查目前已設定之教材目錄是否可寫入（不依賴是否已開啟 eeclass 頁面）
     */
    async function checkCurrentStudentFolderWritable(allowRequestPrompt = false) {
        if (!studentState.useLocalFsHandle || !studentState.boundFolderName) {
            folderHealthState = { status: "default", message: "" };
            updateFolderDisplayUI();
            return { ok: true, isDefault: true };
        }

        const handle = await loadDirectoryHandleFromIDB(IDB_HANDLE_KEY);
        if (!handle) {
            if (studentState.handleOrigin === "page") {
                folderHealthState = {
                    status: "ok",
                    message: `已於課程頁綁定：${studentState.boundFolderName}（可點「選擇資料夾」改由設定面板直接管理）`,
                };
                updateFolderDisplayUI();
                return { ok: true, isPageHandle: true };
            }
            folderHealthState = {
                status: "warn",
                message: `⚠️ 找不到「${studentState.boundFolderName}」授權紀錄，將自動建立於系統「下載」/ ${DEFAULT_SUBFOLDER}`,
            };
            updateFolderDisplayUI();
            return { ok: false, reason: "找不到目錄授權紀錄" };
        }

        const check = await verifyDirectoryWritable(handle, allowRequestPrompt);
        if (check.ok) {
            folderHealthState = {
                status: "ok",
                message: `✓ 已驗證可寫入：${handle.name}（子目錄不存在時自動建立）`,
            };
            updateFolderDisplayUI();
            return { ok: true, folderName: handle.name };
        }

        if (check.permission === "prompt") {
            folderHealthState = {
                status: "warn",
                message: `⚠️ 已選資料夾：${handle.name}（請點「檢查可存性」恢復寫入授權）`,
            };
        }
        else {
            folderHealthState = {
                status: "error",
                message: `❌ 「${handle.name}」無法寫入：${check.reason}（下載時將自動退回系統「下載」/ ${DEFAULT_SUBFOLDER}）`,
            };
        }
        updateFolderDisplayUI();
        return check;
    }

    // 同步畫面上的所有 Switch 與資料夾名稱
    function syncAllControlsToDOM() {
        // 1. 登入相關 Switch (autoLogin, keep, crossSchool)
        document.querySelectorAll("[data-sync-key]").forEach((btn) => {
            const key = btn.dataset.syncKey;
            btn.setAttribute("aria-checked", authState[key] ? "true" : "false");
        });

        // 2. 學生下載相關 Switch
        document.querySelectorAll("[data-student-key]").forEach((btn) => {
            const key = btn.dataset.studentKey;
            btn.setAttribute("aria-checked", studentState[key] ? "true" : "false");
        });

        // 3. 學生下載 Select
        const conflictSelect = document.getElementById("conflictAction");
        if (conflictSelect) {
            conflictSelect.value = studentState.conflictAction || "uniquify";
        }

        // 4. 資料夾名稱與狀態顯示
        updateFolderDisplayUI();

        // 5. 帳號摘要與校外選修展開
        const compactSummary = document.getElementById("compact-account-summary");
        if (compactSummary) {
            compactSummary.textContent = authState.id
                ? `已設定帳號：${authState.id}`
                : "尚未設定學號密碼（僅自動填驗證碼）";
        }
        const compactEditBtn = document.getElementById("compact-edit-account-btn");
        if (compactEditBtn) {
            compactEditBtn.textContent = authState.id ? "修改帳密" : "設定帳密";
        }

        const crossFields = document.getElementById("cross-school-fields");
        if (crossFields) {
            crossFields.hidden = !authState.crossSchool;
        }
    }

    // 綁定所有即時自動儲存的登入 Switch (autoLogin / keep / crossSchool)
    document.querySelectorAll("[data-sync-key]").forEach((btn) => {
        btn.addEventListener("click", async () => {
            const key = btn.dataset.syncKey;
            const nextVal = btn.getAttribute("aria-checked") !== "true";
            authState[key] = nextVal;
            syncAllControlsToDOM();

            const res = await chrome.storage.local.get([AUTH_STORAGE_KEY]);
            const rawRecord = res?.[AUTH_STORAGE_KEY] ?? {};
            rawRecord[key] = nextVal;
            await chrome.storage.local.set({ [AUTH_STORAGE_KEY]: rawRecord });
            flashAutoSave();
        });
    });

    // 綁定所有即時自動儲存的學生功能 Switch
    document.querySelectorAll("[data-student-key]").forEach((btn) => {
        btn.addEventListener("click", async () => {
            const key = btn.dataset.studentKey;
            const nextVal = btn.getAttribute("aria-checked") !== "true";
            studentState[key] = nextVal;
            syncAllControlsToDOM();
            await chrome.storage.local.set({ [STUDENT_CONFIG_KEY]: studentState });
            flashAutoSave();
        });
    });

    // 綁定學生功能 Select 即時自動儲存
    const conflictActionSelect = document.getElementById("conflictAction");
    conflictActionSelect?.addEventListener("change", async () => {
        studentState.conflictAction = conflictActionSelect.value;
        await chrome.storage.local.set({ [STUDENT_CONFIG_KEY]: studentState });
        flashAutoSave();
    });

    // 綁定「選擇資料夾」按鈕（選取後立即檢查是否可寫入）
    document.querySelectorAll(".folder-pick-trigger").forEach((btn) => {
        btn.addEventListener("click", async () => {
            const picked = await pickAndVerifyFolder(IDB_HANDLE_KEY);
            if (!picked) {
                return;
            }
            if (!picked.ok) {
                folderHealthState = {
                    status: "error",
                    message: `❌ 所選「${picked.handle?.name || ""}」無法寫入：${picked.check?.reason || "權限不足"}（已保留原設定）`,
                };
                updateFolderDisplayUI();
                return;
            }
            const { handle } = picked;
            studentState.useLocalFsHandle = true;
            studentState.handleOrigin = "extension";
            studentState.boundFolderName = handle.name;
            studentState.targetDirectory = handle.name;
            folderHealthState = {
                status: "ok",
                message: `✓ 已驗證可寫入：${handle.name}（子目錄不存在時自動建立）`,
            };
            syncAllControlsToDOM();
            await chrome.storage.local.set({ [STUDENT_CONFIG_KEY]: studentState });
            flashAutoSave(`✓ 已驗證可存並設定：${handle.name}`);
        });
    });

    // 綁定「檢查可存性」按鈕（使用者可隨時手動觸發寫入測試與授權修復）
    document.querySelectorAll(".folder-verify-trigger").forEach((btn) => {
        btn.addEventListener("click", async () => {
            const res = await checkCurrentStudentFolderWritable(true);
            if (res.ok) {
                flashAutoSave(`✓ 目錄可正常寫入`);
            }
            else {
                flashAutoSave(`❌ 目錄無法寫入：${res.reason || "請重新選擇資料夾"}`, "error", 3500);
            }
        });
    });

    const resetFolderBtn = document.getElementById("reset-folder-btn");
    resetFolderBtn?.addEventListener("click", async () => {
        await removeDirectoryHandleFromIDB(IDB_HANDLE_KEY);
        studentState.useLocalFsHandle = false;
        studentState.handleOrigin = "default";
        studentState.boundFolderName = "";
        studentState.targetDirectory = DEFAULT_SUBFOLDER;
        folderHealthState = { status: "default", message: "" };
        syncAllControlsToDOM();
        await chrome.storage.local.set({ [STUDENT_CONFIG_KEY]: studentState });
        flashAutoSave(`已恢復預設：系統「下載」/ ${DEFAULT_SUBFOLDER}`);
    });

    // 短選單：展開/收合帳密編輯區
    const compactEditAccountBtn = document.getElementById("compact-edit-account-btn");
    const compactCredForm = document.getElementById("compact-cred-form");
    const compactCancelCredBtn = document.getElementById("compact-cancel-cred");
    const compactIdInput = document.getElementById("compact-id");
    const compactPasswordInput = document.getElementById("compact-password");

    compactEditAccountBtn?.addEventListener("click", () => {
        compactCredForm.hidden = !compactCredForm.hidden;
        if (!compactCredForm.hidden) {
            compactIdInput.value = authState.id || "";
            compactPasswordInput.value = authState.password || "";
            compactIdInput.focus();
        }
    });

    compactCancelCredBtn?.addEventListener("click", () => {
        compactCredForm.hidden = true;
    });

    compactCredForm?.addEventListener("submit", async (ev) => {
        ev.preventDefault();
        authState.id = compactIdInput.value.trim();
        authState.password = compactPasswordInput.value;
        await vaultApi?.saveAuthConfigSecurely({
            ...authState,
            masterPin: "",
        });
        compactCredForm.hidden = true;
        syncAllControlsToDOM();
        flashAutoSave("已加密儲存帳密");
    });

    // 開啟側邊分割視窗模式按鈕（不依賴是否已開啟 eeclass，防呆處理所有視窗型態）
    async function openSplitViewMode(forceSideBySideWindow = false) {
        const normalWindows = await new Promise((resolve) => {
            chrome.windows.getAll({ populate: false, windowTypes: ["normal"] }, (wins) => {
                resolve(wins || []);
            });
        });
        const targetNormalWin = normalWindows.find((w) => w.focused) || normalWindows[0] || null;

        if (!forceSideBySideWindow && chrome.sidePanel?.open && targetNormalWin?.id !== undefined) {
            try {
                await chrome.sidePanel.open({ windowId: targetNormalWin.id });
                if (viewMode === "popup") {
                    window.close();
                }
                return;
            }
            catch {
                // Fallback to side-by-side split window below
            }
        }

        // 左右分割並排視窗模式：將主瀏覽器視窗置於左側 66%，設定視窗並排於右側 34%
        const availW = window.screen.availWidth || 1440;
        const availH = window.screen.availHeight || 900;
        const splitW = Math.max(460, Math.round(availW * 0.34));
        const mainW = availW - splitW;

        const currentWin = await new Promise((resolve) => {
            chrome.windows.getCurrent((w) => resolve(w || null));
        });

        // 從完整設定頁按下：不切割原視窗，只開一個獨立並排設定視窗，並關閉原設定頁，避免同時出現兩個設定頁
        if (viewMode !== "popup") {
            chrome.windows.create({
                url: chrome.runtime.getURL("options.html?mode=split"),
                type: "popup",
                left: mainW,
                top: 0,
                width: splitW,
                height: availH,
            });
            const selfTab = await new Promise((resolve) => {
                chrome.tabs.getCurrent((t) => resolve(t || null));
            });
            if (selfTab?.id !== undefined) {
                chrome.tabs.remove(selfTab.id);
            }
            return;
        }

        if (targetNormalWin?.id !== undefined) {
            chrome.windows.update(targetNormalWin.id, {
                state: "normal",
                left: 0,
                top: 0,
                width: mainW,
                height: availH,
            });
        }

        if (currentWin?.type === "normal") {
            chrome.windows.create({
                url: chrome.runtime.getURL("options.html?mode=split"),
                type: "popup",
                left: mainW,
                top: 0,
                width: splitW,
                height: availH,
            });
            if (viewMode === "popup") {
                window.close();
            }
        }
        else if (currentWin?.id !== undefined) {
            chrome.windows.update(currentWin.id, {
                state: "normal",
                left: mainW,
                top: 0,
                width: splitW,
                height: availH,
            });
        }
    }

    document.getElementById("open-split-view-btn")?.addEventListener("click", () => {
        openSplitViewMode(false);
    });

    document.getElementById("dock-split-window-btn")?.addEventListener("click", () => {
        openSplitViewMode(true);
    });

    function openSwaggerWindow() {
        if (typeof chrome !== "undefined" && chrome.tabs?.create) {
            chrome.tabs.create({ url: chrome.runtime.getURL("swagger.html") });
        } else {
            window.open("swagger.html", "_blank");
        }
    }
    document.getElementById("open-swagger-view-btn")?.addEventListener("click", openSwaggerWindow);
    document.getElementById("full-open-swagger-btn")?.addEventListener("click", openSwaggerWindow);

    // 完整模式左側導覽切換
    const navItems = document.querySelectorAll(".nav-item");
    const sectionTitleEl = document.getElementById("current-section-title");

    function switchSection(sectionId, titleText) {
        navItems.forEach((btn) => {
            btn.classList.toggle("active", btn.dataset.section === sectionId);
        });
        document.querySelectorAll("[data-section-panel]").forEach((panel) => {
            const match = panel.dataset.sectionPanel === sectionId;
            panel.hidden = !match;
            panel.classList.toggle("active", match);
        });
        if (sectionTitleEl && titleText) {
            sectionTitleEl.textContent = titleText;
        }
    }

    navItems.forEach((btn) => {
        btn.addEventListener("click", () => {
            switchSection(btn.dataset.section, btn.textContent.trim());
        });
    });

    // 完整模式：帳密設定卡處理
    const fullCredForm = document.getElementById("full-cred-form");
    const idInput = document.getElementById("id");
    const passwordInput = document.getElementById("password");
    const togglePasswordBtn = document.getElementById("toggle-password");
    const schoolSelect = document.getElementById("school");
    const cidInput = document.getElementById("cid");
    const clearAuthBtn = document.getElementById("clear-auth-btn");
    const securityBadge = document.getElementById("security-badge");
    const vaultLockedBanner = document.getElementById("vault-locked-banner");
    const unlockPinInput = document.getElementById("unlock-pin-input");
    const unlockPinBtn = document.getElementById("unlock-pin-btn");
    const lockSessionBtn = document.getElementById("lock-session-btn");
    const masterPinInput = document.getElementById("masterPin");
    const advancedPinForm = document.getElementById("advanced-pin-form");

    togglePasswordBtn?.addEventListener("click", () => {
        const isPwd = passwordInput.type === "password";
        passwordInput.type = isPwd ? "text" : "password";
        cidInput.type = isPwd ? "text" : "password";
        togglePasswordBtn.textContent = isPwd ? "隱藏密碼" : "顯示密碼";
    });

    schoolSelect?.addEventListener("change", () => {
        if (!authState.crossSchool || !schoolSelect.value) {
            return;
        }
        const rawId = idInput.value.trim();
        if (!rawId) {
            return;
        }
        const dashIndex = rawId.indexOf("-");
        if (dashIndex >= 0 && dashIndex <= 4) {
            idInput.value = `${schoolSelect.value}-${rawId.slice(dashIndex + 1)}`;
        }
        else if (dashIndex === -1) {
            idInput.value = `${schoolSelect.value}-${rawId}`;
        }
    });

    fullCredForm?.addEventListener("submit", async (ev) => {
        ev.preventDefault();
        authState.id = idInput.value.trim();
        authState.password = passwordInput.value;
        authState.school = schoolSelect.value;
        authState.cid = cidInput.value.trim();

        await vaultApi?.saveAuthConfigSecurely({
            ...authState,
            masterPin: masterPinInput?.value ?? "",
        });
        await refreshAuthFromVault(masterPinInput?.value ?? "");
        flashAutoSave("已加密儲存帳密");
    });

    clearAuthBtn?.addEventListener("click", async () => {
        idInput.value = "";
        passwordInput.value = "";
        schoolSelect.value = "";
        cidInput.value = "";
        if (masterPinInput) {
            masterPinInput.value = "";
        }
        authState.id = "";
        authState.password = "";
        authState.school = "";
        authState.cid = "";

        await vaultApi?.saveAuthConfigSecurely({
            ...authState,
            masterPin: "",
        });
        await refreshAuthFromVault("");
        flashAutoSave("已清除帳密");
    });

    // 圖書館自動登入：與 eeclass 帳密分開，獨立加密儲存
    const libraryForm = document.getElementById("library-cred-form");
    const libraryIdInput = document.getElementById("library-id");
    const libraryPasswordInput = document.getElementById("library-password");
    const librarySwitch = document.getElementById("library-autologin-switch");
    const libraryStatus = document.getElementById("library-status");
    const libraryClearBtn = document.getElementById("library-clear-btn");
    let libraryAutoLogin = true;

    async function refreshLibraryCredentialUI() {
        if (!vaultApi || !libraryForm) {
            return;
        }
        const cfg = await vaultApi.loadDecryptedLibraryAuthConfig("").catch(() => null);
        if (!cfg) {
            return;
        }
        libraryAutoLogin = cfg.autoLogin !== false;
        libraryIdInput.value = cfg.id || "";
        librarySwitch?.setAttribute("aria-checked", String(libraryAutoLogin));
        if (cfg.locked) {
            libraryStatus.textContent = "已加密儲存，需先解鎖自訂金鑰才能使用";
        }
        else if (cfg.password) {
            libraryStatus.textContent = "已加密儲存圖書館帳密";
        }
        else {
            libraryStatus.textContent = cfg.id ? "已儲存帳號，尚未儲存密碼" : "尚未設定圖書館帳密";
        }
    }

    librarySwitch?.addEventListener("click", async () => {
        libraryAutoLogin = librarySwitch.getAttribute("aria-checked") !== "true";
        librarySwitch.setAttribute("aria-checked", String(libraryAutoLogin));
        const res = await chrome.storage.local.get([vaultApi.LIBRARY_AUTH_STORAGE_KEY]);
        const rawRecord = res?.[vaultApi.LIBRARY_AUTH_STORAGE_KEY] ?? {};
        rawRecord.autoLogin = libraryAutoLogin;
        await chrome.storage.local.set({ [vaultApi.LIBRARY_AUTH_STORAGE_KEY]: rawRecord });
        flashAutoSave();
    });

    libraryForm?.addEventListener("submit", async (ev) => {
        ev.preventDefault();
        if (!vaultApi) {
            return;
        }
        const id = libraryIdInput.value.trim();
        const typedPassword = libraryPasswordInput.value;
        const existing = await vaultApi.loadDecryptedLibraryAuthConfig("").catch(() => ({}));
        if (!typedPassword && existing.locked) {
            flashAutoSave("請先解鎖自訂金鑰，或重新輸入密碼");
            return;
        }
        await vaultApi.saveLibraryAuthSecurely({
            id,
            password: typedPassword || existing.password || "",
            autoLogin: libraryAutoLogin,
            masterPin: masterPinInput?.value ?? "",
        });
        libraryPasswordInput.value = "";
        await refreshLibraryCredentialUI();
        flashAutoSave("已加密儲存圖書館帳密");
    });

    libraryClearBtn?.addEventListener("click", async () => {
        libraryIdInput.value = "";
        libraryPasswordInput.value = "";
        await vaultApi?.saveLibraryAuthSecurely({
            id: "",
            password: "",
            autoLogin: libraryAutoLogin,
            masterPin: "",
        });
        await refreshLibraryCredentialUI();
        flashAutoSave("已清除圖書館帳密");
    });

    // 進階資安：自訂加密金鑰表單
    advancedPinForm?.addEventListener("submit", async (ev) => {
        ev.preventDefault();
        const pin = masterPinInput.value.trim();
        await vaultApi?.saveAuthConfigSecurely({
            ...authState,
            id: idInput.value.trim() || authState.id,
            password: passwordInput.value || authState.password,
            school: schoolSelect.value || authState.school,
            cid: cidInput.value.trim() || authState.cid,
            masterPin: pin,
        });
        await refreshAuthFromVault(pin);
        flashAutoSave(pin ? "已啟用自訂 PBKDF2 金鑰" : "已恢復預設自動金鑰");
    });

    unlockPinBtn?.addEventListener("click", async () => {
        const pin = unlockPinInput.value;
        if (!pin) {
            return;
        }
        const loaded = await refreshAuthFromVault(pin);
        if (loaded?.locked || loaded?.decryptError) {
            flashAutoSave("金鑰不正確", "error");
        }
        else {
            if (masterPinInput) {
                masterPinInput.value = pin;
            }
            unlockPinInput.value = "";
            flashAutoSave("已解鎖帳密");
        }
    });

    lockSessionBtn?.addEventListener("click", async () => {
        await vaultApi?.clearSessionPinKey();
        if (masterPinInput) {
            masterPinInput.value = "";
        }
        await refreshAuthFromVault("");
        flashAutoSave("已鎖定記憶體金鑰");
    });

    // 重置已同步教材紀錄
    const syncedCountLabel = document.getElementById("synced-count-label");
    document.getElementById("clear-sync-btn")?.addEventListener("click", async () => {
        await chrome.storage.local.set({ [SYNCED_URLS_KEY]: {} });
        if (syncedCountLabel) {
            syncedCountLabel.textContent = "目前已記錄 0 筆教材";
        }
        flashAutoSave("已重置同步紀錄");
    });

    // ==================== 即時同步進度顯示 (Popup 與完整設定面板同步顯示) ====================
    function renderLiveProgressCards(progress) {
        if (!progress) {
            return;
        }
        const isActive = Boolean(progress.active);
        const pct = progress.percent ?? (isActive ? 25 : 100);
        const timeStr = progress.updatedAt
            ? new Date(progress.updatedAt).toLocaleTimeString("zh-TW", { hour12: false })
            : "";

        document.querySelectorAll("[data-progress-dot]").forEach((el) => {
            el.dataset.active = isActive ? "true" : "false";
        });
        document.querySelectorAll("[data-progress-title]").forEach((el) => {
            el.textContent = progress.title || "目前無進行中同步任務";
        });
        document.querySelectorAll("[data-progress-pct]").forEach((el) => {
            el.textContent = isActive ? `${pct}%` : (timeStr ? `更新於 ${timeStr}` : "");
        });
        document.querySelectorAll("[data-progress-detail]").forEach((el) => {
            const latestLog = progress.recentLogs?.[0]?.text || "";
            el.textContent = progress.detail || latestLog || "進入課程或最近事件頁面時將自動顯示即時進度";
        });
        document.querySelectorAll("[data-progress-fill]").forEach((el) => {
            el.style.width = `${pct}%`;
        });
    }

    // ==================== Google 日曆與事件設定控制 ====================
    let calendarState = {
        config: {
            autoSyncCalendar: true,
            routingMode: "unified_auto",
            selectedExistingCalendarId: "primary",
            courseCalendarOverrides: {},
            eventSpanMode: "start_to_due_with_deadline_alert",
            reminder1Minutes: 1440,
            reminder2Minutes: 180,
            reminder3Minutes: 60,
            enableEmailReminder: false,
            oauthClientId: "",
        },
        authorized: false,
        userEmail: "",
        redirectUri: "",
        calendars: [],
        courses: {},
        syncMap: {},
    };

    function syncCalendarControlsToDOM() {
        const cfg = calendarState.config || {};

        // 1. 日曆相關 Switch (autoSyncCalendar, enableEmailReminder)
        document.querySelectorAll("[data-cal-key]").forEach((btn) => {
            const key = btn.dataset.calKey;
            btn.setAttribute("aria-checked", cfg[key] ? "true" : "false");
        });

        // 2. 授權狀態顯示
        const compactCalSummary = document.getElementById("compact-cal-summary");
        const compactCalBtn = document.getElementById("compact-cal-action-btn");
        const authBadge = document.getElementById("cal-auth-badge");
        const accountSub = document.getElementById("cal-account-sub");
        const connectBtn = document.getElementById("cal-connect-btn");
        const disconnectBtn = document.getElementById("cal-disconnect-btn");
        const redirectInput = document.getElementById("cal-redirect-uri");
        const clientIdInput = document.getElementById("cal-client-id");

        const eventCount = Object.keys(calendarState.syncMap || {}).length;

        if (compactCalSummary) {
            compactCalSummary.textContent = calendarState.authorized
                ? `✓ 已連結 (${eventCount} 筆事件已記錄)`
                : `尚未連結日曆（已擷取 ${eventCount} 筆事件）`;
        }
        if (compactCalBtn) {
            compactCalBtn.textContent = calendarState.authorized ? "立即同步" : "連結日曆";
        }
        if (authBadge) {
            authBadge.textContent = calendarState.authorized
                ? `✓ 已授權：${calendarState.userEmail || "Google 日曆"}`
                : "尚未授權";
        }
        if (accountSub) {
            accountSub.textContent = calendarState.authorized
                ? `已連結帳號：${calendarState.userEmail || "Google 帳號"}｜作業開始至截止時間與繳交連結將自動同步更新`
                : "授權後將自動同步 eeclass 最近事件與作業開始/截止時間、合理提醒及繳交連結";
        }
        if (connectBtn) {
            connectBtn.textContent = calendarState.authorized ? "重新授權 Google 日曆" : "索取 Google 日曆授權";
        }
        if (disconnectBtn) {
            disconnectBtn.hidden = !calendarState.authorized;
        }
        if (redirectInput && calendarState.redirectUri) {
            redirectInput.value = calendarState.redirectUri;
        }
        if (clientIdInput && document.activeElement !== clientIdInput) {
            clientIdInput.value = cfg.oauthClientId || "";
        }

        // 3. 歸檔模式與既有日曆選單
        const routingSelect = document.getElementById("cal-routing-mode");
        const existingRow = document.getElementById("existing-cal-row");
        const existingSelect = document.getElementById("cal-existing-select");

        if (routingSelect) {
            routingSelect.value = cfg.routingMode || "unified_auto";
        }
        if (existingRow) {
            existingRow.hidden = cfg.routingMode !== "existing_calendar";
        }
        if (existingSelect) {
            const cals = calendarState.calendars?.length
                ? calendarState.calendars
                : [{ id: "primary", summary: "主日曆 (Primary)" }];
            existingSelect.innerHTML = "";
            for (const c of cals) {
                const opt = document.createElement("option");
                opt.value = c.id;
                opt.textContent = c.summary;
                existingSelect.appendChild(opt);
            }
            existingSelect.value = cfg.selectedExistingCalendarId || "primary";
        }

        // 4. 事件時間區間與提醒選單
        const spanSelect = document.getElementById("cal-span-mode");
        const r1Select = document.getElementById("cal-reminder-1");
        const r2Select = document.getElementById("cal-reminder-2");
        const r3Select = document.getElementById("cal-reminder-3");
        if (spanSelect) spanSelect.value = cfg.eventSpanMode || "start_to_due_with_deadline_alert";
        if (r1Select) r1Select.value = String(cfg.reminder1Minutes ?? 1440);
        if (r2Select) r2Select.value = String(cfg.reminder2Minutes ?? 180);
        if (r3Select) r3Select.value = String(cfg.reminder3Minutes ?? 60);

        // 5. 渲染個別課程日曆指派表
        renderCourseCalendarOverrides();

        // 6. 渲染已擷取與同步之課程事件列表
        renderSyncedCalendarEvents();
    }

    function renderCourseCalendarOverrides() {
        const container = document.getElementById("course-overrides-list");
        if (!container) {
            return;
        }
        const courses = Object.values(calendarState.courses || {});
        if (courses.length === 0) {
            container.innerHTML = `<div class="setting-sub">尚未偵測到課程（進入 eeclass「最近事件」或任一課程頁面後將自動列出所有課程）</div>`;
            return;
        }

        container.innerHTML = "";
        const cals = calendarState.calendars || [];
        const overrides = calendarState.config?.courseCalendarOverrides || {};

        for (const course of courses) {
            const row = document.createElement("div");
            row.className = "course-override-row";

            const copy = document.createElement("div");
            copy.className = "setting-copy";
            const title = document.createElement("span");
            title.className = "setting-label";
            title.textContent = course.courseName;
            const sub = document.createElement("span");
            sub.className = "setting-sub";
            sub.textContent = `課程代碼：${course.courseCode || course.courseId}`;
            copy.appendChild(title);
            copy.appendChild(sub);

            const sel = document.createElement("select");
            sel.className = "ccxp-select select-compact";
            sel.style.minWidth = "210px";

            const baseOptions = [
                { value: "follow_global", label: "跟隨全域預設模式" },
                { value: "unified", label: "加入共用日曆 (NTHU eeclass 課程事件)" },
                { value: "per_course", label: "為此課程建立獨立專屬日曆" },
            ];
            for (const o of baseOptions) {
                const opt = document.createElement("option");
                opt.value = o.value;
                opt.textContent = o.label;
                sel.appendChild(opt);
            }
            for (const cal of cals) {
                const opt = document.createElement("option");
                opt.value = `existing:${cal.id}`;
                opt.textContent = `既有日曆：${cal.summary}`;
                sel.appendChild(opt);
            }

            const currentOverride = overrides[course.courseId];
            if (!currentOverride || currentOverride.mode === "follow_global") {
                sel.value = "follow_global";
            }
            else if (currentOverride.mode === "existing" && currentOverride.calendarId) {
                sel.value = `existing:${currentOverride.calendarId}`;
            }
            else {
                sel.value = currentOverride.mode;
            }

            sel.addEventListener("change", async () => {
                const val = sel.value;
                const nextOverrides = { ...(calendarState.config.courseCalendarOverrides || {}) };
                if (val === "follow_global") {
                    delete nextOverrides[course.courseId];
                }
                else if (val.startsWith("existing:")) {
                    nextOverrides[course.courseId] = {
                        mode: "existing",
                        calendarId: val.slice("existing:".length),
                    };
                }
                else {
                    nextOverrides[course.courseId] = { mode: val };
                }
                await saveCalendarConfigPatch({ courseCalendarOverrides: nextOverrides }, true);
            });

            row.appendChild(copy);
            row.appendChild(sel);
            container.appendChild(row);
        }
    }

    function renderSyncedCalendarEvents() {
        const countBadge = document.getElementById("cal-events-count");
        const listEl = document.getElementById("cal-events-list");
        if (!listEl) {
            return;
        }
        const events = Object.values(calendarState.syncMap || {}).sort((a, b) =>
            String(a.dueTime || "").localeCompare(String(b.dueTime || ""))
        );
        if (countBadge) {
            countBadge.textContent = `${events.length} 筆事件`;
        }
        if (events.length === 0) {
            listEl.innerHTML = `<div class="setting-sub">尚無已記錄事件。可點擊上方「立即從 eeclass 同步」或瀏覽 eeclass 最近事件頁面。</div>`;
            return;
        }

        listEl.innerHTML = "";
        for (const ev of events) {
            const item = document.createElement("div");
            item.className = "synced-event-item";

            const meta = document.createElement("div");
            meta.className = "synced-event-meta";
            const title = document.createElement("div");
            title.className = "synced-event-title";
            title.textContent = ev.title || "未命名事件";

            const sub = document.createElement("div");
            sub.className = "synced-event-sub";
            const startLabel = ev.startTime ? `開放：${ev.startTime} → ` : "";
            const syncMark = ev.googleEventId ? "✓ 已同步至日曆" : "待授權同步";
            sub.textContent = `${ev.courseName || ""}｜${startLabel}期限：${ev.dueTime || ""} (${syncMark})`;

            meta.appendChild(title);
            meta.appendChild(sub);

            const links = document.createElement("div");
            links.className = "synced-event-links";

            if (ev.url) {
                const hwLink = document.createElement("a");
                hwLink.className = "pill-btn";
                hwLink.href = ev.url;
                hwLink.target = "_blank";
                hwLink.rel = "noopener noreferrer";
                hwLink.textContent = "作業繳交頁";
                links.appendChild(hwLink);
            }
            if (ev.htmlLink) {
                const calLink = document.createElement("a");
                calLink.className = "pill-btn";
                calLink.href = ev.htmlLink;
                calLink.target = "_blank";
                calLink.rel = "noopener noreferrer";
                calLink.textContent = "開啟日曆";
                links.appendChild(calLink);
            }

            item.appendChild(meta);
            item.appendChild(links);
            listEl.appendChild(item);
        }
    }

    async function saveCalendarConfigPatch(patch, triggerResync = false) {
        calendarState.config = {
            ...calendarState.config,
            ...patch,
        };
        syncCalendarControlsToDOM();
        await chrome.storage.local.set({ [CALENDAR_CONFIG_KEY]: calendarState.config });
        flashAutoSave();
        if (triggerResync && calendarState.authorized) {
            chrome.runtime.sendMessage({ action: "calendar_resync_all" }, () => {
                refreshCalendarStatus(false);
            });
        }
    }

    function refreshCalendarStatus(forceRefreshCalendars = false) {
        return new Promise((resolve) => {
            chrome.runtime.sendMessage(
                { action: "calendar_get_status", forceRefreshCalendars },
                (res) => {
                    if (res?.ok) {
                        calendarState = {
                            ...calendarState,
                            ...res,
                        };
                        syncCalendarControlsToDOM();
                    }
                    resolve(res);
                }
            );
        });
    }

    // 綁定日曆開關 (autoSyncCalendar, enableEmailReminder)
    document.querySelectorAll("[data-cal-key]").forEach((btn) => {
        btn.addEventListener("click", async () => {
            const key = btn.dataset.calKey;
            const nextVal = btn.getAttribute("aria-checked") !== "true";
            await saveCalendarConfigPatch({ [key]: nextVal }, key === "enableEmailReminder");
        });
    });

    document.getElementById("cal-routing-mode")?.addEventListener("change", (ev) => {
        saveCalendarConfigPatch({ routingMode: ev.target.value }, true);
    });

    document.getElementById("cal-existing-select")?.addEventListener("change", (ev) => {
        saveCalendarConfigPatch({ selectedExistingCalendarId: ev.target.value }, true);
    });

    document.getElementById("cal-span-mode")?.addEventListener("change", (ev) => {
        saveCalendarConfigPatch({ eventSpanMode: ev.target.value }, true);
    });

    document.getElementById("cal-reminder-1")?.addEventListener("change", (ev) => {
        saveCalendarConfigPatch({ reminder1Minutes: Number(ev.target.value) }, true);
    });

    document.getElementById("cal-reminder-2")?.addEventListener("change", (ev) => {
        saveCalendarConfigPatch({ reminder2Minutes: Number(ev.target.value) }, true);
    });

    document.getElementById("cal-reminder-3")?.addEventListener("change", (ev) => {
        saveCalendarConfigPatch({ reminder3Minutes: Number(ev.target.value) }, true);
    });

    document.getElementById("cal-toggle-setup-btn")?.addEventListener("click", () => {
        const drawer = document.getElementById("cal-setup-drawer");
        if (drawer) {
            drawer.hidden = !drawer.hidden;
        }
    });

    document.getElementById("copy-redirect-uri-btn")?.addEventListener("click", async () => {
        const uri = calendarState.redirectUri || "";
        if (uri && navigator.clipboard) {
            await navigator.clipboard.writeText(uri);
            flashAutoSave("已複製專屬導向網址");
        }
    });

    document.getElementById("cal-client-id")?.addEventListener("change", (ev) => {
        saveCalendarConfigPatch({ oauthClientId: ev.target.value.trim() }, false);
    });

    document.getElementById("cal-bind-token-btn")?.addEventListener("click", () => {
        const tokenInput = document.getElementById("cal-manual-token");
        const rawToken = tokenInput?.value.trim() || "";
        if (!rawToken) {
            flashAutoSave("請輸入 Google OAuth Access Token", "warn");
            return;
        }
        flashAutoSave("正在驗證 Token 並同步日曆...", "normal", 3000);
        chrome.runtime.sendMessage(
            { action: "calendar_bind_manual_token", accessToken: rawToken },
            async (res) => {
                if (res?.ok) {
                    if (tokenInput) tokenInput.value = "";
                    const drawer = document.getElementById("cal-setup-drawer");
                    if (drawer) drawer.hidden = true;
                    await refreshCalendarStatus(true);
                    flashAutoSave(`✓ 已成功綁定 Google 日曆 (${res.userEmail || ""})`);
                }
                else {
                    flashAutoSave(`❌ 綁定失敗：${res?.error || "無效 Token"}`, "error", 3500);
                }
            }
        );
    });

    async function handleConnectOrSyncCalendar() {
        const clientIdInput = document.getElementById("cal-client-id");
        const oauthClientId = clientIdInput?.value.trim() || calendarState.config?.oauthClientId || "";

        flashAutoSave("正在連接 Google 日曆...", "normal", 3000);
        chrome.runtime.sendMessage(
            { action: "calendar_oauth_connect", oauthClientId },
            async (res) => {
                if (res?.ok) {
                    await refreshCalendarStatus(true);
                    flashAutoSave(`✓ 已連結 Google 日曆並完成同步`);
                }
                else {
                    const drawer = document.getElementById("cal-setup-drawer");
                    if (drawer && res?.needsClientId) {
                        drawer.hidden = false;
                    }
                    if (viewMode === "popup" && res?.needsClientId) {
                        openSplitViewMode(false);
                        return;
                    }
                    flashAutoSave(`⚠️ ${res?.error || "請先設定 OAuth Client ID 或授權 Token"}`, "warn", 4000);
                }
            }
        );
    }

    document.getElementById("cal-connect-btn")?.addEventListener("click", handleConnectOrSyncCalendar);

    document.getElementById("compact-cal-action-btn")?.addEventListener("click", () => {
        if (calendarState.authorized) {
            flashAutoSave("正在同步最新事件至日曆...");
            chrome.runtime.sendMessage(
                { action: "calendar_sync_now_from_background", forceUpdate: false, interactiveAuth: false },
                async (res) => {
                    await refreshCalendarStatus(false);
                    flashAutoSave(res?.ok ? "✓ Google 日曆已更新" : `⚠️ ${res?.error || "同步失敗"}`);
                }
            );
        }
        else {
            handleConnectOrSyncCalendar();
        }
    });

    document.getElementById("cal-disconnect-btn")?.addEventListener("click", () => {
        chrome.runtime.sendMessage({ action: "calendar_oauth_disconnect" }, async () => {
            await refreshCalendarStatus(false);
            flashAutoSave("已解除 Google 日曆連結");
        });
    });

    document.getElementById("cal-sync-now-btn")?.addEventListener("click", () => {
        flashAutoSave("正在從 eeclass 抓取事件並更新日曆...", "normal", 3500);
        chrome.runtime.sendMessage(
            { action: "calendar_sync_now_from_background", forceUpdate: true, interactiveAuth: true },
            async (res) => {
                await refreshCalendarStatus(false);
                if (res?.ok) {
                    flashAutoSave(`✓ 同步完成（新增 ${res.createdCount} / 更新 ${res.updatedCount}）`);
                }
                else {
                    flashAutoSave(`⚠️ ${res?.error || "請先確認已登入 eeclass 及完成日曆授權"}`, "warn", 3500);
                }
            }
        );
    });

    document.getElementById("cal-refresh-list-btn")?.addEventListener("click", async () => {
        await refreshCalendarStatus(true);
        flashAutoSave("已重新載入日曆清單");
    });

    // 初始化助教專區控制項事件與 DOM 同步
    function initTaControls() {
        document.querySelectorAll("[data-ta-key]").forEach((sw) => {
            sw.addEventListener("click", async () => {
                const key = sw.dataset.taKey;
                const next = sw.getAttribute("aria-checked") !== "true";
                sw.setAttribute("aria-checked", next ? "true" : "false");
                taState[key] = next;
                await chrome.storage.local.set({ [TA_CONFIG_KEY]: taState });
                flashAutoSave();
            });
        });

        document.querySelectorAll("[data-ta-select]").forEach((sel) => {
            sel.addEventListener("change", async () => {
                const key = sel.dataset.taSelect;
                taState[key] = sel.value;
                await chrome.storage.local.set({ [TA_CONFIG_KEY]: taState });
                flashAutoSave();
            });
        });

        document.querySelectorAll(".ta-folder-pick-trigger").forEach((btn) => {
            btn.addEventListener("click", async () => {
                const fieldKey = btn.dataset.taField;
                const subKey = btn.dataset.taSub;
                const picked = await pickAndVerifyFolder(`ta_${fieldKey}`);
                if (!picked) {
                    return;
                }
                const displayEl = document.querySelector(`[data-ta-folder-display="${subKey}"]`);
                if (!picked.ok) {
                    if (displayEl) {
                        displayEl.textContent = `❌ 所選「${picked.handle?.name || ""}」無法寫入：${picked.check?.reason || "權限不足"}`;
                        displayEl.dataset.status = "error";
                    }
                    return;
                }
                taState[subKey] = picked.handle.name;
                if (displayEl) {
                    displayEl.textContent = `✓ 已驗證可寫入：${picked.handle.name}（子目錄不存在時自動建立）`;
                    displayEl.dataset.status = "ok";
                }
                await chrome.storage.local.set({ [TA_CONFIG_KEY]: taState });
                flashAutoSave(`✓ 已驗證可存：${picked.handle.name}`);
            });
        });
    }

    function syncTaControlsToDOM() {
        document.querySelectorAll("[data-ta-key]").forEach((sw) => {
            const key = sw.dataset.taKey;
            sw.setAttribute("aria-checked", taState[key] ? "true" : "false");
        });

        document.querySelectorAll("[data-ta-select]").forEach((sel) => {
            const key = sel.dataset.taSelect;
            if (taState[key] !== undefined) {
                sel.value = taState[key];
            }
        });

        document.querySelectorAll("[data-ta-folder-display]").forEach((el) => {
            const subKey = el.dataset.taFolderDisplay;
            const savedFolder = taState[subKey];
            if (savedFolder) {
                el.textContent = `✓ 已驗證可寫入：${savedFolder}（子目錄不存在時自動建立）`;
                el.dataset.status = "ok";
            }
        });
    }

    async function refreshAuthFromVault(pin = "") {
        if (!vaultApi) {
            return null;
        }
        const loaded = await vaultApi.loadDecryptedAuthConfig(pin);
        authState = { ...authState, ...loaded };

        if (idInput) {
            idInput.value = authState.id || "";
        }
        if (schoolSelect) {
            schoolSelect.value = authState.school || "";
        }
        if (!authState.locked) {
            if (passwordInput) {
                passwordInput.value = authState.password || "";
            }
            if (cidInput) {
                cidInput.value = authState.cid || "";
            }
        }
        else {
            if (passwordInput) {
                passwordInput.value = "";
            }
            if (cidInput) {
                cidInput.value = "";
            }
        }

        if (securityBadge) {
            securityBadge.textContent = authState.vaultMode === "pbkdf2_pin"
                ? (authState.locked ? "PBKDF2 金鑰已鎖定" : "PBKDF2 金鑰保護中")
                : "AES-GCM-256 加密保護";
        }
        if (vaultLockedBanner) {
            vaultLockedBanner.hidden = !authState.locked;
        }
        if (lockSessionBtn) {
            lockSessionBtn.hidden = authState.vaultMode !== "pbkdf2_pin" || Boolean(authState.locked);
        }

        syncAllControlsToDOM();
        return loaded;
    }

    // 初始化載入（自動檢查已設定資料夾是否仍可寫入，並載入日曆狀態與即時進度）
    async function bootstrap() {
        const targetSection = params.get("section");
        if (targetSection) {
            const targetBtn = document.querySelector(`.nav-item[data-section="${targetSection}"]`);
            switchSection(targetSection, targetBtn?.textContent.trim() || "Google 日曆與事件");
        }

        // 每個初始化步驟獨立執行：某一步失敗（例如保險箱讀取）不會讓日曆、課程設定等區塊整個空白
        const tryStep = async (label, fn) => {
            try {
                return await fn();
            } catch (e) {
                console.error(`[options] ${label} 失敗：`, e);
                return null;
            }
        };

        await tryStep("讀取帳號保險箱", () => refreshAuthFromVault(""));
        await tryStep("載入日曆狀態", () => refreshCalendarStatus(false));
        await tryStep("載入圖書館帳密", () => refreshLibraryCredentialUI());

        chrome.storage.local.get(
            [STUDENT_CONFIG_KEY, TA_CONFIG_KEY, SYNCED_URLS_KEY, LIVE_PROGRESS_KEY],
            async (res) => {
                studentState = {
                    ...DEFAULT_STUDENT_CONFIG,
                    ...(res?.[STUDENT_CONFIG_KEY] ?? {}),
                };
                taState = {
                    ...getDefaultTaConfig(),
                    ...(res?.[TA_CONFIG_KEY] ?? {}),
                };
                const syncedCount = Object.keys(res?.[SYNCED_URLS_KEY] ?? {}).length;
                if (syncedCountLabel) {
                    syncedCountLabel.textContent = `目前已記錄 ${syncedCount} 筆教材`;
                }
                if (res?.[LIVE_PROGRESS_KEY]) {
                    renderLiveProgressCards(res[LIVE_PROGRESS_KEY]);
                }
                await tryStep("初始化教師設定", () => { initTaControls(); syncTaControlsToDOM(); });
                await tryStep("同步控制項", () => syncAllControlsToDOM());
                await tryStep("檢查資料夾權限", () => checkCurrentStudentFolderWritable(false));
            }
        );

        if (chrome.storage?.onChanged) {
            chrome.storage.onChanged.addListener((changes, area) => {
                if (area === "local") {
                    if (changes[LIVE_PROGRESS_KEY]?.newValue) {
                        renderLiveProgressCards(changes[LIVE_PROGRESS_KEY].newValue);
                    }
                    if (changes[TA_CONFIG_KEY]?.newValue) {
                        taState = { ...taState, ...changes[TA_CONFIG_KEY].newValue };
                        syncTaControlsToDOM();
                    }
                    if (changes.eeclassCalendarSyncMap || changes.eeclassKnownCourses) {
                        refreshCalendarStatus(false);
                    }
                }
            });
        }
    }

    function initExtensionWizard() {
        const wizardShell = document.getElementById("wizard-shell");
        if (!wizardShell) return;

        const sessionId = params.get("session") || "mcp_" + Date.now();
        const caller = params.get("caller") || "Claude Desktop MCP";

        const originText = document.getElementById("wizard-origin-text");
        if (originText) originText.textContent = `${caller} 連線`;

        const receiptCaller = document.getElementById("w-receipt-caller");
        const receiptSession = document.getElementById("w-receipt-session");
        if (receiptCaller) receiptCaller.textContent = caller;
        if (receiptSession) receiptSession.textContent = sessionId;

        let scannedCourses = {
            teachingCourses: [],
            studentCourses: []
        };

        function setStep(stepNum) {
            for (let i = 1; i <= 4; i++) {
                const item = document.getElementById(`w-step-item-${i}`);
                const panel = document.getElementById(`w-panel-${i}`);
                const conn = document.getElementById(`w-step-conn-${i}`);
                if (panel) {
                    panel.hidden = (i !== stepNum);
                    panel.classList.toggle("active", i === stepNum);
                }
                if (item) {
                    item.classList.toggle("active", i === stepNum);
                    if (i < stepNum) {
                        item.classList.add("completed");
                    } else if (i > stepNum) {
                        item.classList.remove("completed");
                    }
                }
                if (conn) {
                    conn.classList.toggle("completed", i < stepNum);
                }
            }
        }

        function isEeclassLoggedIn(html) {
            if (!html || typeof html !== "string") return false;
            if (html.includes("oauth.ccxp.nthu.edu.tw") || html.includes("校務資訊系統") || html.includes("請輸入密碼") || html.includes("captchaimg")) {
                return false;
            }
            const hasMyCourses = html.includes("我的課程");
            const hasLogout = html.includes("登出") || html.includes("logout");
            const hasCourseLinks = /href=["'](?:\/course\/|https:\/\/eeclass\.nthu\.edu\.tw\/course\/)\d+["']/i.test(html);
            return Boolean(hasMyCourses || hasLogout || hasCourseLinks);
        }

        // 1. 自動檢測是否已有儲存之帳密，若已有設定則直接前進步驟二實作登入
        let loginPollTimer = null;

        async function checkExistingCredentialsAndAutoAdvance() {
            let auth = null;
            let rawAuth = null;
            try {
                const raw = await chrome.storage?.local?.get(["eeclassAuthConfig"]);
                rawAuth = raw?.eeclassAuthConfig;
                auth = await vaultApi?.loadDecryptedAuthConfig("").catch(() => null);
            } catch (e) {}

            const hasStoredCredentials = Boolean(
                (auth?.id && (auth?.password || auth?.vaultMode !== "none")) ||
                (rawAuth?.id && (rawAuth?.password || rawAuth?.vault || rawAuth?.cipherText))
            );

            const savedId = auth?.id || rawAuth?.id;
            if (savedId) {
                const wId = document.getElementById("w-id");
                if (wId) wId.value = savedId;
            }

            if (hasStoredCredentials) {
                const msg = document.getElementById("w-cred-msg");
                if (msg) {
                    msg.textContent = `✓ 已於本機保險箱偵測到儲存之校務憑證（學號：${savedId || "已加密"}），自動前進實體登入！`;
                    msg.style.color = "#10b981";
                }
                setTimeout(() => {
                    setStep(2);
                    executeLiveLoginVerification(true);
                }, 400);
            }
        }
        checkExistingCredentialsAndAutoAdvance();

        // 密碼顯示切換
        const togglePwdBtn = document.getElementById("w-toggle-pwd");
        const pwdInput = document.getElementById("w-password");
        togglePwdBtn?.addEventListener("click", () => {
            const isPwd = pwdInput.type === "password";
            pwdInput.type = isPwd ? "text" : "password";
            togglePwdBtn.textContent = isPwd ? "隱藏密碼" : "顯示密碼";
        });

        // 步驟一：儲存帳密
        const credForm = document.getElementById("w-cred-form");
        credForm?.addEventListener("submit", async (e) => {
            e.preventDefault();
            const id = document.getElementById("w-id")?.value.trim();
            const password = document.getElementById("w-password")?.value;
            const msg = document.getElementById("w-cred-msg");

            if (!id || !password) {
                if (msg) msg.textContent = "請輸入學號與密碼";
                return;
            }

            if (vaultApi) {
                await vaultApi.storeEncryptedAuthConfig({ id, password, autoLogin: true });
            }

            if (msg) {
                msg.textContent = "✓ 憑證已透過 AES-GCM 安全加密儲存！";
                msg.style.color = "#10b981";
            }

            setTimeout(() => {
                setStep(2);
                executeLiveLoginVerification(true);
            }, 400);
        });

        // 步驟二：連線與實作登入測試
        document.getElementById("w-prev-to-1")?.addEventListener("click", () => {
            if (loginPollTimer) clearInterval(loginPollTimer);
            setStep(1);
        });

        /**
         * 開啟 eeclass 首頁，點「校務資訊系統登入」進入 OAuth，
         * 完成後由 OAuth 頁的自動登入（content.js）回到 eeclass。
         */
        async function openEclassLoginEntry() {
            if (!(chrome && chrome.tabs && chrome.tabs.create)) {
                window.open("https://eeclass.nthu.edu.tw", "_blank");
                return { opened: true, clicked: false };
            }
            const tab = await chrome.tabs.create({ url: "https://eeclass.nthu.edu.tw/", active: true });
            await new Promise((resolve) => {
                const done = (id, info) => {
                    if (id === tab.id && info.status === "complete") {
                        chrome.tabs.onUpdated.removeListener(done);
                        resolve();
                    }
                };
                chrome.tabs.onUpdated.addListener(done);
                setTimeout(() => { chrome.tabs.onUpdated.removeListener(done); resolve(); }, 30000);
            });
            try {
                const [inj] = await chrome.scripting.executeScript({
                    target: { tabId: tab.id },
                    func: function clickSchoolLoginEntry() {
                        return new Promise((resolve) => {
                            const norm = (s) => (s || "").replace(/\s+/g, "");
                            const find = () => {
                                const els = Array.from(document.querySelectorAll("a, button"));
                                return els.find(el => (el.getAttribute("href") || "").includes("oauth.ccxp.nthu.edu.tw"))
                                    || els.find(el => /校務(資訊)?系統登入/.test(norm(el.textContent)));
                            };
                            let tries = 0;
                            const timer = setInterval(() => {
                                const el = find();
                                tries++;
                                if (el) {
                                    clearInterval(timer);
                                    el.click();
                                    resolve({ clicked: true, text: norm(el.textContent).slice(0, 20) });
                                } else if (tries > 60) {
                                    clearInterval(timer);
                                    resolve({ clicked: false, reason: "找不到校務資訊系統登入按鈕（可能已在 OAuth 登入頁）" });
                                }
                            }, 200);
                        });
                    }
                });
                return { opened: true, ...(inj && inj.result ? inj.result : { clicked: false }) };
            } catch (e) {
                return { opened: true, clicked: false, error: e.message };
            }
        }

        const btnOpenEeclass = document.getElementById("w-btn-open-eeclass");
        btnOpenEeclass?.addEventListener("click", () => { openEclassLoginEntry(); });

        const btnDoLogin = document.getElementById("w-btn-do-login");
        btnDoLogin?.addEventListener("click", () => {
            executeLiveLoginVerification(true);
        });

        async function executeLiveLoginVerification(autoOpenIfLoggedOut = true) {
            const headline = document.getElementById("w-login-headline");
            const detail = document.getElementById("w-login-detail");
            const dot = document.getElementById("w-login-dot");
            const badge = document.getElementById("w-login-badge");

            if (headline) headline.textContent = "正在向 eeclass 伺服器探測登入工作階段...";
            if (dot) dot.className = "pulse-indicator";

            let isLoggedIn = false;
            try {
                const text = (await globalThis.EeclassTransport.request("/home.php", {})).html;
                isLoggedIn = isEeclassLoggedIn(text);
            } catch (e) {
                isLoggedIn = false;
            }

            if (isLoggedIn) {
                if (dot) dot.className = "pulse-indicator success";
                if (headline) headline.textContent = "✓ 已確認 eeclass 登入工作階段有效！";
                if (detail) detail.textContent = "擴充套件已成功與 eeclass 建立連線，即將為您掃描真實課程身分。";
                if (badge) {
                    badge.textContent = "已連線登入";
                    badge.className = "badge-pill";
                }

                setTimeout(() => {
                    setStep(3);
                    triggerCourseScan();
                }, 800);
                return;
            }

            // 尚未登入！打開真正的 Chrome 分頁進入 eeclass
            if (dot) dot.className = "pulse-indicator active";
            if (headline) headline.textContent = "正在為您開啟 eeclass 分頁進行自動登入...";
            if (detail) detail.textContent = "已為您在 Chrome 開啟 eeclass 頁面。進入 OAuth 時外掛將自動透過 CNN 辨識驗證碼並登入。本頁面正即時監聽登入完成狀態...";
            if (badge) {
                badge.textContent = "開啟登入中";
                badge.className = "badge-pill";
            }

            try {
                await openEclassLoginEntry();
            } catch (e) {
                window.open("https://eeclass.nthu.edu.tw", "_blank");
            }

            // 啟動輪詢監聽登入完成 (每 1.8 秒檢查一次，最多 45 秒)
            if (loginPollTimer) clearInterval(loginPollTimer);
            let pollCount = 0;
            loginPollTimer = setInterval(async () => {
                pollCount++;
                try {
                    const text = (await globalThis.EeclassTransport.request("/home.php", {})).html;
                    if (isEeclassLoggedIn(text)) {
                        clearInterval(loginPollTimer);
                        loginPollTimer = null;

                        if (dot) dot.className = "pulse-indicator success";
                        if (headline) headline.textContent = "✓ eeclass 實體登入成功！";
                        if (detail) detail.textContent = "已完成實體登入驗證，正在為您掃描並劃分所有真實課程身分...";
                        if (badge) {
                            badge.textContent = "已連線登入";
                            badge.className = "badge-pill";
                        }

                        setTimeout(() => {
                            setStep(3);
                            triggerCourseScan();
                        }, 800);
                    }
                } catch (e) {}

                if (pollCount > 60) {
                    clearInterval(loginPollTimer);
                    loginPollTimer = null;
                    if (headline) headline.textContent = "登入等待逾時，請手動確認";
                    if (detail) detail.textContent = "請確認剛開啟的 eeclass 分頁是否已完成登入，完成後點擊「驗證登入狀態」。";
                    if (badge) {
                        badge.textContent = "等待手動確認";
                        badge.className = "badge-pill";
                    }
                }
            }, 1800);
        }

        // 步驟三：掃描真實課程權限
        document.getElementById("w-prev-to-2")?.addEventListener("click", () => setStep(2));
        const btnScanCourses = document.getElementById("w-btn-scan-courses");
        const btnConfirmCourses = document.getElementById("w-btn-confirm-courses");

        async function triggerCourseScan() {
            const headline = document.getElementById("w-scan-headline");
            const dot = document.getElementById("w-scan-dot");
            const container = document.getElementById("w-courses-container");
            const teachingTable = document.getElementById("w-teaching-table");
            const studentTable = document.getElementById("w-student-table");

            if (headline) headline.textContent = "正在自 eeclass 掃描真實課程清單並劃分身分...";

            scannedCourses.teachingCourses = [];
            scannedCourses.studentCourses = [];

            let scan = null;
            try {
                scan = await globalThis.EeclassCourseScan.scanCourses({
                    onProgress: (done, total) => {
                        if (headline) headline.textContent = `正在逐一檢視課程身分（${done}/${total}）...`;
                    }
                });
            } catch (e) {
                if (headline) headline.textContent = `連線 eeclass 失敗：${e.message}`;
                return;
            }

            try {
                if (!scan.loggedIn) {
                    if (headline) headline.textContent = "尚未偵測到 eeclass 登入狀態";
                    if (dot) dot.className = "pulse-indicator";
                    if (container) {
                        container.hidden = false;
                        container.innerHTML = `
                            <div style="padding: 24px; text-align: center; color: #6b7280; background: #f9fafb; border: 1px dashed #d1d5db; border-radius: 6px; margin: 16px 0;">
                                <p style="font-size: 14px; font-weight: 600; color: #374151; margin-bottom: 6px;">${scan.message}</p>
                                <p style="font-size: 13px; margin-bottom: 14px;">請在 Chrome 中完成 eeclass 登入後，回到此頁重新掃描。</p>
                                <button type="button" class="pill-btn" id="w-btn-retry-login" style="margin-right: 8px;">在新分頁開啟 eeclass 登入</button>
                                <button type="button" class="primary-btn" id="w-btn-retry-scan">重新掃描課程清單</button>
                            </div>
                        `;
                        document.getElementById("w-btn-retry-login")?.addEventListener("click", () => {
                            openEclassLoginEntry();
                        });
                        document.getElementById("w-btn-retry-scan")?.addEventListener("click", triggerCourseScan);
                    }
                    if (btnScanCourses) btnScanCourses.hidden = false;
                    if (btnConfirmCourses) btnConfirmCourses.hidden = true;
                    return;
                }

                scannedCourses.teachingCourses = scan.teachingCourses;
                scannedCourses.studentCourses = scan.studentCourses;
                const found = scan.allCourses;

                if (found.length === 0) {
                    if (headline) headline.textContent = "⚠️ 未能自 eeclass 解析到課程清單";
                    if (dot) dot.className = "pulse-indicator";
                    if (container) {
                        container.hidden = false;
                        container.innerHTML = `
                            <div style="padding: 24px; text-align: center; color: #6b7280; background: #f9fafb; border: 1px dashed #d1d5db; border-radius: 6px; margin: 16px 0;">
                                <p style="font-size: 14px; font-weight: 600; color: #374151; margin-bottom: 6px;">尚未在 eeclass 抓取到任何課程</p>
                                <p style="font-size: 13px; margin-bottom: 14px;">請確認剛開啟的 eeclass 分頁是否已成功登入並進入「我的課程」主頁。</p>
                                <button type="button" class="pill-btn" id="w-btn-retry-login" style="margin-right: 8px;">在新分頁開啟 eeclass 登入</button>
                                <button type="button" class="primary-btn" id="w-btn-retry-scan">重新掃描課程清單</button>
                            </div>
                        `;
                        document.getElementById("w-btn-retry-login")?.addEventListener("click", () => {
                            openEclassLoginEntry();
                        });
                        document.getElementById("w-btn-retry-scan")?.addEventListener("click", triggerCourseScan);
                    }
                    if (btnScanCourses) btnScanCourses.hidden = false;
                    if (btnConfirmCourses) btnConfirmCourses.hidden = true;
                    return;
                }
            } catch (e) {
                if (headline) headline.textContent = `連線 eeclass 失敗：${e.message}`;
                return;
            }

            // 渲染真實課程表格
            if (teachingTable) {
                teachingTable.innerHTML = scannedCourses.teachingCourses.length > 0 ? `<table>
                    <thead><tr><th>課程 ID</th><th>課程代號</th><th>課程名稱</th><th>身分角色</th><th>授權權限</th></tr></thead>
                    <tbody>${scannedCourses.teachingCourses.map(c => `<tr>
                        <td><code>${c.courseId}</code></td>
                        <td>${c.courseCode}</td>
                        <td><strong>${c.courseName}</strong></td>
                        <td><span class="badge-pill" style="color:#9F5FA5;background:rgba(159,95,165,0.12)">${c.identityLabel}</span></td>
                        <td>${c.permissions}</td>
                    </tr>`).join("")}</tbody>
                </table>` : `<p style="font-size: 13px; color: #6b7280; padding: 10px 0;">目前無所屬之助教或教師課程</p>`;
            }

            if (studentTable) {
                studentTable.innerHTML = scannedCourses.studentCourses.length > 0 ? `<table>
                    <thead><tr><th>課程 ID</th><th>課程代號</th><th>課程名稱</th><th>身分角色</th><th>授權權限</th></tr></thead>
                    <tbody>${scannedCourses.studentCourses.map(c => `<tr>
                        <td><code>${c.courseId}</code></td>
                        <td>${c.courseCode}</td>
                        <td>${c.courseName}</td>
                        <td><span class="badge-pill">${c.identityLabel}</span></td>
                        <td>${c.permissions}</td>
                    </tr>`).join("")}</tbody>
                </table>` : `<p style="font-size: 13px; color: #6b7280; padding: 10px 0;">目前無修課學生課程</p>`;
            }

            const teachingCount = document.getElementById("w-teaching-count");
            const studentCount = document.getElementById("w-student-count");
            if (teachingCount) teachingCount.textContent = `${scannedCourses.teachingCourses.length} 門課程`;
            if (studentCount) studentCount.textContent = `${scannedCourses.studentCourses.length} 門課程`;

            if (container) container.hidden = false;
            const total = scannedCourses.teachingCourses.length + scannedCourses.studentCourses.length;
            const unverifiedCount = scan.unverifiedCourses.length;
            if (headline) headline.textContent = `✓ 掃描完成！共識別 ${total} 門真實課程（助教/教師 ${scannedCourses.teachingCourses.length} 門，學生 ${scannedCourses.studentCourses.length} 門）${unverifiedCount ? `；另有 ${unverifiedCount} 門無法確認身分，未納入權限` : ""}`;
            if (dot) dot.className = "pulse-indicator success";

            if (btnScanCourses) btnScanCourses.hidden = true;
            if (btnConfirmCourses) {
                btnConfirmCourses.hidden = false;
                btnConfirmCourses.disabled = false;
            }
        }

        btnScanCourses?.addEventListener("click", triggerCourseScan);

        // 步驟四：確認並同步回傳 MCP
        btnConfirmCourses?.addEventListener("click", async () => {
            const receiptTeaching = document.getElementById("w-receipt-teaching");
            const receiptStudent = document.getElementById("w-receipt-student");
            const receiptStatus = document.getElementById("w-receipt-status");

            if (receiptTeaching) receiptTeaching.textContent = `已識別 ${scannedCourses.teachingCourses.length} 門`;
            if (receiptStudent) receiptStudent.textContent = `已識別 ${scannedCourses.studentCourses.length} 門`;

            // 將結果回傳給 MCP Bridge (127.0.0.1:3001)
            try {
                await fetch("http://127.0.0.1:3001/extension/setup-complete", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        sessionId,
                        caller,
                        success: true,
                        teachingCourses: scannedCourses.teachingCourses,
                        studentCourses: scannedCourses.studentCourses,
                        timestamp: Date.now()
                    })
                });
                if (receiptStatus) {
                    receiptStatus.textContent = "✓ 活體資料已成功同步至 Claude Desktop MCP！";
                    receiptStatus.className = "receipt-val val-success";
                }
            } catch (err) {
                if (receiptStatus) {
                    receiptStatus.textContent = "✓ 本機身分已就緒（Bridge 背景連線）";
                }
            }

            setStep(4);
        });

        // 關閉精靈分頁
        document.getElementById("w-btn-close-wizard")?.addEventListener("click", () => {
            window.close();
        });
    }

    bootstrap();
})();
