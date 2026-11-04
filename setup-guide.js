/**
 * NTHU eeclass MCP - 擴充套件安裝與識別引導腳本
 */

(function initSetupGuide() {
    "use strict";

    const BRIDGE_BASE_URL = "http://127.0.0.1:3001";
    let isIdentified = false;
    let cachedDetectedExt = null;

    const step1Card = document.getElementById("step-1-card");
    const step1Badge = document.getElementById("step-1-badge");
    const step2Card = document.getElementById("step-2-card");
    const step2Badge = document.getElementById("step-2-badge");
    const step3Card = document.getElementById("step-3-card");
    const step3Badge = document.getElementById("step-3-badge");

    const extStatusDot = document.getElementById("ext-status-dot");
    const extStatusTitle = document.getElementById("ext-status-title");
    const extStatusDesc = document.getElementById("ext-status-desc");
    const setupStatusText = document.getElementById("setup-status-text");

    const detectedExtBox = document.getElementById("detected-ext-box");
    const detName = document.getElementById("det-name");
    const detId = document.getElementById("det-id");
    const detProfile = document.getElementById("det-profile");
    const detPath = document.getElementById("det-path");

    const btnOpenFolder = document.getElementById("btn-open-folder");
    const btnVerifyAndLaunch = document.getElementById("btn-verify-and-launch");
    const btnLaunchWizard = document.getElementById("btn-launch-wizard");

    const extListToggle = document.getElementById("ext-list-toggle");
    const extListSummary = document.getElementById("ext-list-summary");
    const extListArrow = document.getElementById("ext-list-arrow");
    const extListBody = document.getElementById("ext-list-body");

    // 1. 開啟外掛本機目錄
    btnOpenFolder?.addEventListener("click", async () => {
        try {
            await fetch(`${BRIDGE_BASE_URL}/extension/open-folder`, { method: "POST" });
        } catch (e) {
            alert("無法自動開啟目錄，請手動前往：C:\\Users\\user\\Downloads\\式\\nthu-eeclass-copilot");
        }
    });

    // 2. 檢測擴充套件狀態
    async function checkExtensionStatus() {
        try {
            const res = await fetch(`${BRIDGE_BASE_URL}/extension/status`);
            if (res.ok) {
                const data = await res.json();
                if (data.installedOnDisk && data.detectedExtension) {
                    onExtensionIdentified(data.detectedExtension, data.extensionConnected);
                    return true;
                }
            }
        } catch (err) {}
        return false;
    }

    // 偵測到擴充功能後，自動開啟設定精靈（每個瀏覽器工作階段只做一次，避免重複開啟分頁）
    async function launchWizardOnce(ext) {
        const KEY = "eeclass_guide_wizard_launched";
        try {
            if (sessionStorage.getItem(KEY)) return;
            sessionStorage.setItem(KEY, "1");
        } catch (e) {}
        try {
            const res = await fetch(`${BRIDGE_BASE_URL}/extension/open-wizard`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ sessionId: "mcp_setup_" + Date.now(), caller: "Claude Desktop MCP" })
            });
            const data = await res.json();
            if (setupStatusText) {
                setupStatusText.textContent = data.success
                    ? "已自動開啟設定精靈，請切換至 Chrome 的精靈分頁"
                    : `無法自動開啟精靈：${data.error || "未知錯誤"}`;
            }
        } catch (e) {
            if (setupStatusText) setupStatusText.textContent = "無法連線到本機橋接服務，請確認 Claude Desktop 的 MCP 已啟動";
        }
    }

    // 3. 識別成功處理
    function onExtensionIdentified(ext, isLiveConnected = false) {
        cachedDetectedExt = ext;
        isIdentified = true;

        step1Card?.classList.remove("active");
        step1Card?.classList.add("completed");
        if (step1Badge) step1Badge.textContent = "✓";

        step2Card?.classList.remove("active");
        step2Card?.classList.add("completed");
        if (step2Badge) step2Badge.textContent = "✓";

        step3Card?.classList.add("completed");
        if (step3Badge) step3Badge.textContent = "✓";

        if (detectedExtBox) {
            detectedExtBox.style.display = "block";
            if (detName) detName.textContent = ext.name || "NTHU eeclass Copilot｜清大數位學習全能助手";
            if (detId) detId.textContent = ext.id;
            if (detProfile) detProfile.textContent = ext.profileDisplayName || ext.profile;
            if (detPath) detPath.textContent = ext.path;
        }

        if (extStatusDot) extStatusDot.className = "status-dot-pulse success";
        if (extStatusTitle) extStatusTitle.textContent = "✓ 已成功識別本機 eeclass 擴充功能！";
        if (extStatusDesc) {
            extStatusDesc.textContent = isLiveConnected
                ? "外掛背景服務處於連線中。請點擊「立即啟動全螢幕設定精靈」進入帳密加密儲存與身分劃分。"
                : `擴充套件已載入於 Chrome【${ext.profileDisplayName || ext.profile}】。點擊下方按鈕將為您在該設定檔喚醒全螢幕設定精靈。`;
        }
        if (setupStatusText) setupStatusText.textContent = "已識別本機擴充功能";

        if (btnLaunchWizard) {
            btnLaunchWizard.style.display = "inline-flex";
        }
        if (btnVerifyAndLaunch) {
            btnVerifyAndLaunch.textContent = "重新整理狀態";
        }
        launchWizardOnce(ext);
    }

    // 4. 點擊啟動全螢幕設定精靈
    btnLaunchWizard?.addEventListener("click", async () => {
        btnLaunchWizard.textContent = "正在喚醒設定精靈分頁...";
        btnLaunchWizard.disabled = true;

        try {
            await fetch(`${BRIDGE_BASE_URL}/extension/open-wizard`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    sessionId: "mcp_setup_" + Date.now(),
                    caller: "Claude Desktop MCP"
                })
            });
        } catch (e) {}

        if (cachedDetectedExt?.wizardUrl) {
            window.open(cachedDetectedExt.wizardUrl, "_blank");
        }

        setTimeout(() => {
            btnLaunchWizard.textContent = "✓ 已在 Chrome 開啟設定精靈（請切換至該分頁）";
            btnLaunchWizard.disabled = false;
        }, 800);
    });

    // 5. 點擊重新檢測
    btnVerifyAndLaunch?.addEventListener("click", async () => {
        btnVerifyAndLaunch.textContent = "正在掃描本機 Chrome...";
        btnVerifyAndLaunch.disabled = true;
        await checkExtensionStatus();
        await loadAllInstalledExtensions();
        setTimeout(() => {
            btnVerifyAndLaunch.textContent = isIdentified ? "重新整理狀態" : "重新檢測本機外掛狀態";
            btnVerifyAndLaunch.disabled = false;
        }, 600);
    });

    // 6. 載入並渲染所有 Chrome 擴充功能清單
    async function loadAllInstalledExtensions() {
        try {
            const res = await fetch(`${BRIDGE_BASE_URL}/extension/installed-list`);
            if (res.ok) {
                const data = await res.json();
                if (extListSummary) {
                    extListSummary.textContent = `檢視本機 Chrome 已安裝的所有擴充功能清單 (共 ${data.totalFound} 個，包含本專案外掛)`;
                }
                if (extListBody) {
                    extListBody.innerHTML = (data.extensions || []).map(item => `
                        <div class="ext-list-item ${item.isEeclass ? 'is-eeclass' : ''}">
                            <div>
                                <strong style="color: ${item.isEeclass ? '#9F5FA5' : '#1f2937'};">
                                    ${item.isEeclass ? '⭐ ' : ''}${item.name}
                                </strong>
                                <span style="font-size: 11px; color: #6b7280; margin-left: 6px;">[${item.profileDisplayName}]</span>
                                <div style="font-size: 11px; color: #9ca3af; margin-top: 2px;">ID: <code>${item.id}</code></div>
                            </div>
                            <span class="badge-pill" style="${item.isEeclass ? 'background:#9F5FA5;color:#fff;' : 'background:#e5e7eb;color:#4b5563;'}">
                                ${item.isEeclass ? '本專案 eeclass' : '已安裝'}
                            </span>
                        </div>
                    `).join("");
                }
            }
        } catch (e) {}
    }

    // 7. 折疊抽屜切換
    extListToggle?.addEventListener("click", () => {
        if (!extListBody) return;
        const isHidden = extListBody.style.display === "none";
        extListBody.style.display = isHidden ? "block" : "none";
        if (extListArrow) extListArrow.innerHTML = isHidden ? "&uarr;" : "&darr;";
    });

    // 初始檢測與載入清單
    checkExtensionStatus();
    loadAllInstalledExtensions();

    // 背景輪詢
    setInterval(() => {
        if (!isIdentified) {
            checkExtensionStatus();
        }
    }, 1500);
})();