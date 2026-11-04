/**
 * NTHU eeclass Copilot - 擴充套件內建 Swagger 操控伺服器與通訊埠 (In-Extension Server & Port Hub)
 * 
 * 核心設計：
 * 1. 擺脫外部 Node.js 伺服器依賴，直接在 Chrome Extension (Service Worker / Extension Context) 內部充當 Server。
 * 2. 開放並監聽長連接通訊埠 (Port)：
 *    - 內部 Port：chrome.runtime.onConnect (名稱：EECLASS_SWAGGER_PORT)
 *    - 外部 Web/Script 埠：chrome.runtime.onConnectExternal
 *    - 訊息通道：chrome.runtime.onMessage / onMessageExternal
 * 3. 實作 RBAC 權限分類鑑權 (X-User-Role) 與 高危險操作之使用者 UI 許可驗證 (X-Consent-Token)。
 * 4. 嚴格執行業務安全規則：
 *    - 作業刪除僅限未有繳交者 (submittedCount === 0)，已有繳交者回傳 409 Conflict
 *    - 測驗刪除僅限未有作答者 (testedCount === 0)，已有作答者回傳 409 Conflict
 *    - 全體寄信通知需經 UI 二次確認許可 (broadcast_email)
 */

(function (global) {
  "use strict";

  const Roles = {
    TEACHER: "teacher",
    ASSISTANT: "assistant",
    STUDENT: "student",
    GUEST: "guest"
  };

  const Permissions = {
    COURSE_READ: "course:read",
    COURSE_MANAGE: "course:manage",
    HOMEWORK_READ: "homework:read",
    HOMEWORK_WRITE: "homework:write",
    HOMEWORK_DELETE: "homework:delete",
    HOMEWORK_AUDIT: "homework:audit",
    HOMEWORK_EXPORT: "homework:export",
    EXAM_READ: "exam:read",
    EXAM_WRITE: "exam:write",
    EXAM_DELETE: "exam:delete",
    EXAM_AUDIT: "exam:audit",
    BULLETIN_READ: "bulletin:read",
    BULLETIN_WRITE: "bulletin:write",
    BULLETIN_DELETE: "bulletin:delete",
    BULLETIN_NOTIFY: "bulletin:notify"
  };

  const RolePermissionsMap = {
    [Roles.TEACHER]: Object.values(Permissions),
    [Roles.ASSISTANT]: Object.values(Permissions),
    [Roles.STUDENT]: [
      Permissions.COURSE_READ,
      Permissions.HOMEWORK_READ,
      Permissions.EXAM_READ,
      Permissions.BULLETIN_READ
    ],
    [Roles.GUEST]: [
      Permissions.COURSE_READ,
      Permissions.BULLETIN_READ
    ]
  };

  // 許可權杖存放池
  const activeConsents = new Map();


  /**
   * 權限驗證輔助函式
   */
  function assertPermission(role, permission) {
    const perms = RolePermissionsMap[role] || [];
    if (!perms.includes(permission)) {
      const err = new Error(`[Permission Denied] 角色 "${role}" 未具備 "${permission}" 權限`);
      err.statusCode = 403;
      err.code = "ERR_PERMISSION_DENIED";
      throw err;
    }
  }

  function grantConsent(action, targetId, reason = "") {
    const token = "cst_" + Math.random().toString(36).substring(2, 11) + Date.now().toString(36);
    const expiresAt = Date.now() + 300 * 1000;
    const consent = { token, action, targetId: String(targetId), reason, expiresAt };
    activeConsents.set(token, consent);
    return consent;
  }

  function verifyAndConsumeConsent(token, requiredAction, targetId) {
    if (!token) {
      const err = new Error(`[UI Consent Required] 操作 ${requiredAction} 為重大變更，需攜帶使用者 UI 許可權杖 (X-Consent-Token)！`);
      err.statusCode = 403;
      err.code = "ERR_UI_CONSENT_REQUIRED";
      throw err;
    }
    const c = activeConsents.get(token);
    if (!c || Date.now() > c.expiresAt || c.action !== requiredAction || String(c.targetId) !== String(targetId)) {
      const err = new Error(`[Invalid Consent Token] 許可權杖不存在、已過期或與目標動作不符`);
      err.statusCode = 403;
      err.code = "ERR_INVALID_CONSENT";
      throw err;
    }
    activeConsents.delete(token); // 單次使用防重放
    return true;
  }

  /**
   * 擴充套件核心 API 分發器 (Request Router)
   * 所有資料都由 EeclassLive / EeclassCourseScan 向登入中的 eeclass 讀取或送出，不使用任何預設資料。
   */
  async function dispatchApiRequest(req) {
    const { method = "GET", path = "/", headers = {}, body = null } = req;
    const normalizedMethod = method.toUpperCase();
    const role = headers["X-User-Role"] || headers["x-user-role"] || Roles.ASSISTANT;
    const consentToken = headers["X-Consent-Token"] || headers["x-consent-token"] || "";

    const urlObj = new URL(path, "https://eeclass.extension.local");
    const pathname = urlObj.pathname.replace(/^\/api\/v1/, "");
    const live = globalThis.EeclassLive;
    const scan = globalThis.EeclassCourseScan;

    try {
      // 1. 權限資訊（角色由呼叫端宣告，身分由 eeclass 課程頁實際判定）
      if (pathname === "/auth/permissions" && normalizedMethod === "GET") {
        const courses = await scan.scanCourses();
        return {
          status: 200,
          body: {
            loggedIn: courses.loggedIn,
            systemRole: role,
            teachingCoursesCount: courses.teachingCourses.length,
            allowedActions: RolePermissionsMap[role] || []
          }
        };
      }

      // 2. UI 許可權杖申請
      if (pathname === "/auth/consent/request" && normalizedMethod === "POST") {
        const { action, targetId, reason } = body || {};
        const consent = grantConsent(action, targetId, reason);
        return {
          status: 200,
          body: {
            consentToken: consent.token,
            expiresAt: new Date(consent.expiresAt).toISOString(),
            action: consent.action,
            targetId: consent.targetId,
            message: "使用者 UI 許可核發成功"
          }
        };
      }

      // 3. 基礎模組：真實課程清單與身分分類
      if (pathname === "/courses/teaching" && normalizedMethod === "GET") {
        const courses = await scan.scanCourses();
        if (!courses.loggedIn) return { status: 401, body: { error: courses.message } };
        return { status: 200, body: courses.teachingCourses };
      }

      const sidebarMatch = pathname.match(/^\/courses\/(\d+)\/sidebar$/);
      if (sidebarMatch && normalizedMethod === "GET") {
        return { status: 200, body: await live.getCourseSidebar(sidebarMatch[1]) };
      }

      // 4. 作業模組：真實列表
      const hwListMatch = pathname.match(/^\/courses\/(\d+)\/homeworks$/);
      if (hwListMatch && normalizedMethod === "GET") {
        return { status: 200, body: await live.listHomeworks(hwListMatch[1]) };
      }

      // 5. 作業模組：新增（尚未取得 eeclass 作業新增的表單端點，明確回報未支援，不假裝成功）
      if (hwListMatch && normalizedMethod === "POST") {
        assertPermission(role, Permissions.HOMEWORK_WRITE);
        return { status: 501, body: { error: "作業新增的 eeclass 端點尚未串接", code: "ERR_NOT_IMPLEMENTED" } };
      }

      // 6. 作業模組：刪除（僅限未有繳交者 submittedCount === 0，依真實列表判斷）
      const hwDeleteMatch = pathname.match(/^\/courses\/(\d+)\/homeworks\/(\d+)$/);
      if (hwDeleteMatch && normalizedMethod === "DELETE") {
        const [, courseId, hwIdStr] = hwDeleteMatch;
        const hwId = parseInt(hwIdStr, 10);
        const list = await live.listHomeworks(courseId);
        const target = list.find(h => h.id === hwId);
        if (!target) return { status: 404, body: { error: `找不到 ID 為 ${hwId} 的作業` } };

        assertPermission(role, Permissions.HOMEWORK_DELETE);
        if (target.submittedCount > 0) {
          return {
            status: 409,
            body: {
              error: `[Conflict] 作業已有 ${target.submittedCount} 位學生繳交，依規定禁止刪除`,
              code: "ERR_HOMEWORK_HAS_SUBMISSIONS",
              submittedCount: target.submittedCount
            }
          };
        }
        verifyAndConsumeConsent(consentToken, "delete_homework", hwId);
        return { status: 501, body: { error: "作業刪除的 eeclass 端點尚未串接", code: "ERR_NOT_IMPLEMENTED" } };
      }

      // 7. 測驗模組：真實列表
      const examListMatch = pathname.match(/^\/courses\/(\d+)\/exams$/);
      if (examListMatch && normalizedMethod === "GET") {
        return { status: 200, body: await live.listExams(examListMatch[1]) };
      }

      // 8. 測驗模組：刪除（僅限未有作答者 testedCount === 0）
      const examDeleteMatch = pathname.match(/^\/courses\/(\d+)\/exams\/(\d+)$/);
      if (examDeleteMatch && normalizedMethod === "DELETE") {
        const [, courseId, examIdStr] = examDeleteMatch;
        const examId = parseInt(examIdStr, 10);
        const list = await live.listExams(courseId);
        const target = list.find(e => e.id === examId);
        if (!target) return { status: 404, body: { error: `找不到 ID 為 ${examId} 的測驗` } };

        assertPermission(role, Permissions.EXAM_DELETE);
        if ((target.testedCount || 0) > 0) {
          return {
            status: 409,
            body: {
              error: `[Conflict] 測驗已有 ${target.testedCount} 位學生完成作答，依規定禁止刪除`,
              code: "ERR_EXAM_HAS_SUBMISSIONS",
              testedCount: target.testedCount
            }
          };
        }
        verifyAndConsumeConsent(consentToken, "delete_exam", examId);
        return { status: 200, body: await live.deleteExam(courseId, examId) };
      }

      // 9. 公告模組：真實列表
      const bulletinListMatch = pathname.match(/^\/courses\/(\d+)\/bulletins$/);
      if (bulletinListMatch && normalizedMethod === "GET") {
        return { status: 200, body: await live.listBulletins(bulletinListMatch[1]) };
      }

      // 9-1. 公告模組：新增
      if (bulletinListMatch && normalizedMethod === "POST") {
        assertPermission(role, Permissions.BULLETIN_WRITE);
        if (!body || !body.title) return { status: 400, body: { error: "缺少公告標題 title" } };
        return { status: 201, body: await live.createBulletin(bulletinListMatch[1], body) };
      }

      // 9-2. 公告模組：編輯 / 刪除
      const bulletinItemMatch = pathname.match(/^\/courses\/(\d+)\/bulletins\/(\d+)$/);
      if (bulletinItemMatch && normalizedMethod === "PATCH") {
        assertPermission(role, Permissions.BULLETIN_WRITE);
        const [, courseId, bid] = bulletinItemMatch;
        return { status: 200, body: await live.updateBulletin(courseId, bid, body || {}) };
      }
      if (bulletinItemMatch && normalizedMethod === "DELETE") {
        const [, courseId, bid] = bulletinItemMatch;
        assertPermission(role, Permissions.BULLETIN_DELETE);
        verifyAndConsumeConsent(consentToken, "delete_bulletin", bid);
        return { status: 200, body: await live.deleteBulletin(courseId, bid) };
      }

      // 10. 公告模組：全體寄信通知（需 UI 許可）
      const notifyMatch = pathname.match(/^\/courses\/(\d+)\/bulletins\/(\d+)\/notify$/);
      if (notifyMatch && normalizedMethod === "POST") {
        const [, courseId, bid] = notifyMatch;
        assertPermission(role, Permissions.BULLETIN_NOTIFY);
        verifyAndConsumeConsent(consentToken, "broadcast_email", bid);
        return { status: 200, body: await live.sendBulletinNotify(courseId, bid) };
      }

      return {
        status: 404,
        body: { error: `未找到對應的 API 端點: ${normalizedMethod} ${pathname}` }
      };
    } catch (e) {
      if (e && e.name === "LoginRequiredError") {
        return { status: 401, body: { error: e.message, code: "ERR_NOT_LOGGED_IN" } };
      }
      return {
        status: e.statusCode || 500,
        body: { error: e.message, code: e.code }
      };
    }
  }

  /**
   * 初始化 Chrome 擴充套件 Port 通訊埠服務器
   */
  function initExtensionServer() {
    if (typeof chrome === "undefined" || !chrome.runtime) {
      console.log("[eeclass Extension Server] 非 Chrome 擴充套件環境，跳過 runtime 監聽器綁定。");
      return;
    }

    // 1. 長連接通訊埠監聽（內部 Port）
    chrome.runtime.onConnect.addListener(port => {
      if (port.name === "EECLASS_SWAGGER_PORT" || port.name === "EECLASS_COPILOT_SERVER") {
        port.onMessage.addListener(async msg => {
          if (msg && msg.type === "EECLASS_API_CALL") {
            const result = await dispatchApiRequest(msg.request);
            port.postMessage({ id: msg.id, response: result });
          }
        });
      }
    });

    // 2. 外部長連接通訊埠監聽（供外部頁面或腳本連接）
    if (chrome.runtime.onConnectExternal) {
      chrome.runtime.onConnectExternal.addListener(port => {
        if (port.name === "EECLASS_SWAGGER_PORT") {
          port.onMessage.addListener(async msg => {
            if (msg && msg.type === "EECLASS_API_CALL") {
              const result = await dispatchApiRequest(msg.request);
              port.postMessage({ id: msg.id, response: result });
            }
          });
        }
      });
    }

    // 3. 一次性訊息監聽
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg && msg.type === "EECLASS_API_CALL") {
        dispatchApiRequest(msg.request).then(res => {
          sendResponse(res);
        });
        return true; // 非同步回應
      }
    });

    // 4. 外部一次性訊息監聽
    if (chrome.runtime.onMessageExternal) {
      chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
        if (msg && msg.type === "EECLASS_API_CALL") {
          dispatchApiRequest(msg.request).then(res => {
            sendResponse(res);
          });
          return true;
        }
      });
    }

    console.log("[eeclass Extension Server] 擴充套件伺服器通訊埠 (EECLASS_SWAGGER_PORT) 已就緒！");
  }

  // 匯出至全域
  const serverModule = {
    Roles,
    Permissions,
    grantConsent,
    verifyAndConsumeConsent,
    dispatchApiRequest,
    initExtensionServer
  };

  global.EECLASS_EXTENSION_SERVER = serverModule;

  // 自動在擴充套件載入時初始化通訊埠
  initExtensionServer();

})(typeof globalThis !== "undefined" ? globalThis : this);
