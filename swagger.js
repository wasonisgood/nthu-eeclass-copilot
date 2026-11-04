/**
 * NTHU eeclass Copilot - Swagger UI 擴充套件端驅動腳本
 * 符合 Manifest V3 CSP 規範：無行內腳本、無行內事件處理器
 */

"use strict";

(function () {
  let currentRole = "assistant";
  let currentConsentToken = "";

  // 與 Chrome 擴充套件內部通訊埠 (Port) 或 Background 進行通訊
  async function callExtensionApiServer(method, path, headers = {}, body = null) {
    if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
      return new Promise((resolve) => {
        chrome.runtime.sendMessage({
          type: "EECLASS_API_CALL",
          request: { method, path, headers, body }
        }, (response) => {
          if (chrome.runtime.lastError || !response) {
            // 若 background 尚未回應，嘗試透過 global dispatcher
            if (window.EECLASS_EXTENSION_SERVER) {
              window.EECLASS_EXTENSION_SERVER.dispatchApiRequest({ method, path, headers, body }).then(resolve);
            } else {
              resolve({ status: 500, body: { error: chrome.runtime.lastError?.message || "未收到擴充套件伺服器回應" } });
            }
          } else {
            resolve(response);
          }
        });
      });
    }

    // 非 extension context 時的 Fallback
    if (window.EECLASS_EXTENSION_SERVER) {
      return window.EECLASS_EXTENSION_SERVER.dispatchApiRequest({ method, path, headers, body });
    }

    return { status: 500, body: { error: "未連接到擴充套件通訊埠" } };
  }

  function initSwaggerApp() {
    // 1. 處理圖片載入失敗 fallback (符合 CSP，不使用行內 onerror)
    const logoImg = document.querySelector(".brand-logo");
    if (logoImg) {
      logoImg.addEventListener("error", function () {
        this.src = "data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>🎓</text></svg>";
      });
    }

    // 2. 載入預編譯之 OpenAPI Spec 物件
    const spec = window.EECLASS_OPENAPI_SPEC;
    if (!spec) {
      console.error("[Swagger App] 找不到 window.EECLASS_OPENAPI_SPEC 規格物件");
      return;
    }

    // 3. 初始化 SwaggerUIBundle
    const ui = SwaggerUIBundle({
      spec: spec,
      dom_id: "#swagger-ui",
      deepLinking: true,
      presets: [
        SwaggerUIBundle.presets.apis,
        SwaggerUIStandalonePreset
      ],
      layout: "BaseLayout",
      showMutatedRequest: true,
      requestInterceptor: (req) => {
        req.headers = req.headers || {};
        req.headers["X-User-Role"] = currentRole;
        if (currentConsentToken) {
          req.headers["X-Consent-Token"] = currentConsentToken;
        }
        return req;
      },
      // 攔截 Swagger HTTP 請求，將所有端點經由 Extension Port 通訊埠分發
      fn: {
        fetch: async (urlOrReq, options = {}) => {
          let requestUrl = "";
          let reqOptions = {};

          if (typeof urlOrReq === "string") {
            requestUrl = urlOrReq;
            reqOptions = options || {};
          } else if (urlOrReq && typeof urlOrReq === "object") {
            requestUrl = urlOrReq.url || "";
            reqOptions = urlOrReq;
          }

          // 執行 Swagger UI 傳入的 requestInterceptor（供 Swagger UI 內部 dispatch setMutatedRequest，以確保 LiveResponse 取得有效請求結構）
          if (typeof reqOptions.requestInterceptor === "function") {
            try {
              const intercepted = await reqOptions.requestInterceptor(reqOptions);
              if (intercepted && typeof intercepted === "object") {
                reqOptions = intercepted;
              }
            } catch (err) {
              console.warn("[Swagger UI] requestInterceptor error:", err);
            }
          }

          let path = requestUrl;
          try {
            const urlObj = new URL(requestUrl, window.location.href);
            path = urlObj.pathname + urlObj.search;
          } catch (e) {
            path = requestUrl;
          }

          const method = (reqOptions.method || "GET").toUpperCase();
          let body = reqOptions.body;
          if (body && typeof body === "string") {
            try {
              body = JSON.parse(body);
            } catch (e) {
              // 保留字串
            }
          }

          const headers = Object.assign({}, reqOptions.headers || {});
          headers["X-User-Role"] = currentRole;
          if (currentConsentToken) {
            headers["X-Consent-Token"] = currentConsentToken;
          }

          // 經由擴充套件內部伺服器或通訊埠分發
          let resData;
          try {
            resData = await callExtensionApiServer(method, path, headers, body);
          } catch (err) {
            resData = {
              status: 500,
              body: { error: err.message || "擴充套件通訊異常" }
            };
          }

          if (!resData || typeof resData !== "object") {
            resData = { status: 200, body: {} };
          }

          const statusCode = Number(resData.status) || 200;
          const responseBody = resData.body !== undefined ? resData.body : {};
          const jsonText = typeof responseBody === "string" ? responseBody : JSON.stringify(responseBody, null, 2);

          // 必須回傳 Plain Object（不能回傳原生 Response 實例，因 Swagger-UI reducer 會執行 res.headers = ...，原生 Response 之 headers 為唯讀 getter 會引發 TypeError）
          let resObj = {
            ok: statusCode >= 200 && statusCode < 300,
            status: statusCode,
            statusText: statusCode === 200 ? "OK" : ("HTTP " + statusCode),
            url: requestUrl || path,
            headers: {
              "content-type": "application/json; charset=utf-8",
              "access-control-allow-origin": "*"
            },
            text: jsonText,
            data: jsonText,
            body: responseBody,
            obj: responseBody
          };

          if (typeof reqOptions.responseInterceptor === "function") {
            try {
              resObj = (await reqOptions.responseInterceptor(resObj)) || resObj;
            } catch (err) {
              console.warn("[Swagger UI] responseInterceptor error:", err);
            }
          }

          return resObj;
        }
      }
    });

    window.ui = ui;

    // 4. 角色切換監聽
    const roleBtns = document.querySelectorAll(".role-pill-btn");
    roleBtns.forEach((btn) => {
      btn.addEventListener("click", () => {
        roleBtns.forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        currentRole = btn.dataset.role;
        console.log(`[RBAC] 已切換目前模擬角色為: ${currentRole}`);
      });
    });

    // 5. UI 許可對話框邏輯
    const modal = document.getElementById("consent-modal");
    const openBtn = document.getElementById("trigger-consent-btn");
    const closeBtn = document.getElementById("close-consent-btn");
    const cancelBtn = document.getElementById("cancel-consent-btn");
    const confirmBtn = document.getElementById("confirm-consent-btn");
    const tokenResult = document.getElementById("consent-token-result");
    const tokenText = document.getElementById("consent-token-text");

    if (openBtn && modal) {
      openBtn.addEventListener("click", () => {
        if (tokenResult) tokenResult.style.display = "none";
        modal.hidden = false;
      });
    }

    const hideModal = () => {
      if (modal) modal.hidden = true;
    };

    if (closeBtn) closeBtn.addEventListener("click", hideModal);
    if (cancelBtn) cancelBtn.addEventListener("click", hideModal);

    if (confirmBtn) {
      confirmBtn.addEventListener("click", async () => {
        const actionEl = document.getElementById("consent-action-select");
        const targetIdEl = document.getElementById("consent-target-id");
        const reasonEl = document.getElementById("consent-reason");

        const action = actionEl ? actionEl.value : "delete_homework";
        const targetId = targetIdEl ? targetIdEl.value.trim() : "";
        const reason = reasonEl ? reasonEl.value.trim() : "";

        try {
          const resData = await callExtensionApiServer("POST", "/api/v1/auth/consent/request", {
            "Content-Type": "application/json"
          }, { action, targetType: "homework", targetId, reason });

          const data = resData.body;
          currentConsentToken = data.consentToken;

          if (tokenText) tokenText.textContent = data.consentToken;
          if (tokenResult) tokenResult.style.display = "block";

          // 自動套用至 Swagger Authorize
          if (ui && ui.preauthorizeApiKey) {
            ui.preauthorizeApiKey("ConsentTokenAuth", data.consentToken);
            ui.preauthorizeApiKey("RoleAuth", currentRole);
          }

          setTimeout(() => {
            hideModal();
          }, 400);
        } catch (e) {
          console.error("核發失敗:", e);
        }
      });
    }
  }

  // 確保 DOM 載入後執行
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initSwaggerApp);
  } else {
    initSwaggerApp();
  }
})();
