/**
 * NTHU eeclass Copilot - 授權許可確認互動邏輯 (Consent Interactive Logic)
 * 嚴格遵循 CSP (Content Security Policy)：無 inline script，全面採用 addEventListener 與模組化通訊
 */

(function initConsentView() {
    "use strict";

    const BRIDGE_BASE_URL = "http://127.0.0.1:3001";
    const urlParams = new URLSearchParams(window.location.search);
    const requestId = urlParams.get("requestId") || "";

    // DOM 元素快取
    const loadingState = document.getElementById("loading-state");
    const emptyState = document.getElementById("empty-state");
    const requestContent = document.getElementById("request-content");
    const successState = document.getElementById("success-state");
    const emptyTitle = document.getElementById("empty-title");
    const emptyDesc = document.getElementById("empty-desc");

    const courseNameDisplay = document.getElementById("course-name-display");
    const courseCodeDisplay = document.getElementById("course-code-display");
    const courseIdDisplay = document.getElementById("course-id-display");
    const roleBadge = document.getElementById("role-badge");
    const roleWarningBox = document.getElementById("role-warning-box");
    const roleWarningText = document.getElementById("role-warning-text");

    const actionCodeBadge = document.getElementById("action-code-badge");
    const actionTitleDisplay = document.getElementById("action-title-display");
    const actionDescDisplay = document.getElementById("action-desc-display");

    const payloadCountBadge = document.getElementById("payload-count-badge");
    const payloadTbody = document.getElementById("payload-tbody");
    const rememberCourseName = document.getElementById("remember-course-name");

    const btnReject = document.getElementById("btn-reject");
    const btnAllowOnce = document.getElementById("btn-allow-once");
    const btnAllowPermanent = document.getElementById("btn-allow-permanent");
    const btnCloseWindow = document.getElementById("btn-close-window");

    const decisionModeBadge = document.getElementById("decision-mode-badge");
    const tokenPreview = document.getElementById("token-preview");

    let currentRequestData = null;

    /**
     * 欄位名稱對照表（將英文 key 轉為易讀的中文字眼）
     */
    const FIELD_LABELS = {
        title: "作業／公告標題",
        homeworkId: "目標作業編號",
        examId: "目標測驗編號",
        bulletinId: "目標公告編號",
        studentId: "學生學號",
        studentName: "學生姓名",
        score: "評定分數",
        maxScore: "滿分基準",
        suggestedScore: "建議給分",
        feedback: "批改評語",
        feedbackHtml: "富文字評語內容",
        studentAnswer: "學生作答檢視",
        deadline: "繳交截止時間",
        startDate: "開放起始時間",
        weight: "佔總成績比重 (%)",
        isGroup: "是否為分組作業",
        allowDelay: "是否允許遲交",
        isTopMost: "是否置頂發布",
        notifyMessage: "發布通知信",
        isNotifyMail: "是否發送全體廣播通知信",
        reason: "退回／操作理由",
        targetDirectory: "本機存放目錄",
        fileTypes: "同步檔案類型",
        onlyNewFiles: "僅下載新檔案",
        csvRowsCount: "批次匯入筆數"
    };

    /**
     * 取得請求詳細資訊
     */
    async function fetchRequestDetails() {
        if (!requestId) {
            showEmpty("無效的許可請求", "網址缺少必要的請求識別碼 (requestId)。");
            return;
        }

        try {
            // 優先嘗試向本地 Bridge (127.0.0.1:3001) 取得待處理請求
            const res = await fetch(`${BRIDGE_BASE_URL}/extension/consent/pending?requestId=${encodeURIComponent(requestId)}`, {
                headers: { "Content-Type": "application/json" }
            });

            if (!res.ok) {
                throw new Error(`伺服器回應狀態碼：${res.status}`);
            }

            const data = await res.json();
            if (!data || !data.request) {
                throw new Error("查無此請求識別碼");
            }

            currentRequestData = data.request;
            renderRequest(currentRequestData);
        } catch (e) {
            // 若向 Bridge 查詢失敗，嘗試向 Chrome Extension Background Service Worker 查詢
            if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
                chrome.runtime.sendMessage({ action: "GET_CONSENT_REQUEST", requestId }, (response) => {
                    if (response?.request) {
                        currentRequestData = response.request;
                        renderRequest(currentRequestData);
                    } else {
                        showEmpty("無法取得授權請求", `無法連線至通訊橋接埠或背景工作行程：${e.message}`);
                    }
                });
            } else {
                showEmpty("無法取得授權請求", `通訊失敗：${e.message}。請確認 Claude Desktop 與 Extension Bridge 正常執行。`);
            }
        }
    }

    /**
     * 渲染請求資料
     */
    function renderRequest(req) {
        loadingState.hidden = true;
        emptyState.hidden = true;
        requestContent.hidden = false;

        // 課程資訊
        courseNameDisplay.textContent = req.courseName || `課程 ${req.courseId}`;
        courseCodeDisplay.textContent = req.courseCode || "無課程代碼";
        courseIdDisplay.textContent = req.courseId || "-";
        rememberCourseName.textContent = req.courseName || "本課程";

        // 身分 Badge
        const isTeaching = req.userRole === "teacher" || req.userRole === "assistant";
        roleBadge.textContent = req.userIdentityLabel || (isTeaching ? "助教身分" : "學生身分");
        roleBadge.style.background = isTeaching ? "#70146e" : "#0284c7";

        // 身分警告（若一般學生嘗試使用助教功能）
        if (req.roleWarning) {
            roleWarningBox.hidden = false;
            roleWarningText.textContent = req.roleWarning;
            btnAllowOnce.disabled = true;
            btnAllowPermanent.disabled = true;
            btnAllowOnce.style.opacity = "0.5";
            btnAllowPermanent.style.opacity = "0.5";
        } else {
            roleWarningBox.hidden = true;
        }

        // 動作資訊
        actionCodeBadge.textContent = req.action || "custom:action";
        actionTitleDisplay.textContent = req.actionTitle || "操作授權確認";
        actionDescDisplay.textContent = req.actionDescription || "即將對系統執行變更或資料讀取。";

        // Payload 明細渲染
        renderPayloadTable(req.payload || {});
    }

    /**
     * 渲染 Payload 表格
     */
    function renderPayloadTable(payload) {
        payloadTbody.innerHTML = "";
        const keys = Object.keys(payload);
        payloadCountBadge.textContent = `${keys.length} 項資料`;

        if (keys.length === 0) {
            const tr = document.createElement("tr");
            tr.innerHTML = `<td colspan="2" style="text-align: center; color: #9ca3af; padding: 12px;">無特殊參數或僅為單純觸發</td>`;
            payloadTbody.appendChild(tr);
            return;
        }

        keys.forEach(key => {
            const val = payload[key];
            const tr = document.createElement("tr");

            const labelTd = document.createElement("td");
            labelTd.className = "field-name";
            labelTd.textContent = FIELD_LABELS[key] || key;

            const valueTd = document.createElement("td");
            valueTd.className = "field-value";

            if (typeof val === "boolean") {
                valueTd.innerHTML = val 
                    ? `<strong style="color: #15803d;">✓ 是 / 開啟</strong>` 
                    : `<span style="color: #6b7280;">✕ 否 / 關閉</span>`;
            } else if (typeof val === "object" && val !== null) {
                valueTd.innerHTML = `<pre class="field-value-rich">${escapeHtml(JSON.stringify(val, null, 2))}</pre>`;
            } else if (typeof val === "string" && (val.includes("<p>") || val.includes("<br>"))) {
                valueTd.innerHTML = `<div class="field-value-rich">${val}</div>`;
            } else {
                valueTd.textContent = String(val ?? "-");
            }

            tr.appendChild(labelTd);
            tr.appendChild(valueTd);
            payloadTbody.appendChild(tr);
        });
    }

    /**
     * 提交使用者決策
     */
    async function submitDecision(decision) {
        setButtonsBusy(true);

        const payload = {
            requestId,
            decision, // 'one_time' | 'permanent' | 'reject'
            timestamp: Date.now()
        };

        try {
            // 向 Bridge 提交決策
            const res = await fetch(`${BRIDGE_BASE_URL}/extension/consent/decision`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
            });

            if (!res.ok) {
                const errData = await res.json().catch(() => ({}));
                throw new Error(errData.error || `HTTP ${res.status}`);
            }

            const result = await res.json();
            showSuccess(decision, result.token);
        } catch (e) {
            // 若向 Bridge 提交失敗，嘗試向 Extension Background 提交
            if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
                chrome.runtime.sendMessage({ action: "RESOLVE_CONSENT_DECISION", payload }, (response) => {
                    if (response?.success) {
                        showSuccess(decision, response.token);
                    } else {
                        alert(`提交授權決策失敗：${e.message}`);
                        setButtonsBusy(false);
                    }
                });
            } else {
                alert(`提交授權決策失敗：${e.message}`);
                setButtonsBusy(false);
            }
        }
    }

    function setButtonsBusy(isBusy) {
        btnReject.disabled = isBusy;
        btnAllowOnce.disabled = isBusy;
        btnAllowPermanent.disabled = isBusy;
    }

    function showEmpty(title, desc) {
        loadingState.hidden = true;
        requestContent.hidden = true;
        successState.hidden = true;
        emptyState.hidden = false;
        if (title) emptyTitle.textContent = title;
        if (desc) emptyDesc.textContent = desc;
    }

    function showSuccess(mode, token) {
        requestContent.hidden = true;
        successState.hidden = false;

        const isReject = mode === "reject";
        const successTitle = document.getElementById("success-title");
        const successDesc = document.getElementById("success-desc");

        if (isReject) {
            successTitle.textContent = "操作授權已被拒絕";
            successTitle.style.color = "#b91c1c";
            successDesc.textContent = "已通知 Claude Desktop 終止本次操作，系統未做任何資料變更。";
            decisionModeBadge.textContent = "已拒絕";
            decisionModeBadge.style.color = "#b91c1c";
            decisionModeBadge.style.background = "#fee2e2";
            decisionModeBadge.style.borderColor = "#fca5a5";
            tokenPreview.textContent = "未簽發任何權杖";
        } else {
            successTitle.textContent = "操作許可已成功核發！";
            successTitle.style.color = "#15803d";
            successDesc.textContent = "已成功回傳確認權杖至 Claude Desktop 與擴充套件，程序正在接續執行。";
            decisionModeBadge.textContent = mode === "permanent" ? "永久許可" : "單次許可";
            decisionModeBadge.style.color = "#15803d";
            decisionModeBadge.style.background = "#dcfce7";
            decisionModeBadge.style.borderColor = "#bbf7d0";
            tokenPreview.textContent = token ? `權杖：${token.slice(0, 10)}...` : "權杖已加密送達";
        }

        // 3 秒後自動嘗試關閉視窗（若為獨立彈出視窗）
        setTimeout(() => {
            if (window.opener || window.history.length <= 1) {
                window.close();
            }
        }, 3500);
    }

    function escapeHtml(str) {
        return str
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    // 事件監聽綁定
    btnReject.addEventListener("click", () => submitDecision("reject"));
    btnAllowOnce.addEventListener("click", () => submitDecision("one_time"));
    btnAllowPermanent.addEventListener("click", () => submitDecision("permanent"));
    btnCloseWindow.addEventListener("click", () => {
        window.close();
    });

    // 啟動資料抓取
    fetchRequestDetails();
})();
