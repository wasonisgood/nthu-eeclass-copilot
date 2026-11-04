"use strict";

// 清華驗證碼共用核心（可重用於所有 *.nthu.edu.tw 與 *.nthu.ust.edu.tw 子網域）。
// 只負責「依圖片判斷是哪一種驗證碼、用對應模型辨識」，不負責找欄位、不負責送出。
// 三套模型各自獨立，這裡只做統一的呼叫介面：
//   nthu-ccxp-6   校務資訊系統登入頁（auth_img.php，6 位數字）      -> ccxp-captcha.js（CCXP_CAPTCHA）
//   nthu-idm-4    圖書館 IDM 登入頁（/captcha/image/…，4 位數字）    -> library-captcha.js（LIBRARY_CAPTCHA）
//   nthu-oauth-4  eeclass / 校務 OAuth（captchaimg.php，4 位數字）   -> decaptcha.js（EECLASS_DECAPTCHA）
// 無法對應到已知版型的驗證碼一律回傳 null，不嘗試辨識（避免誤填其他表單的驗證碼）。
(function captchaKitRuntime(globalScope) {
    const PROFILES = {
        "nthu-ccxp-6": {
            digits: 6,
            srcPattern: /auth_img\.php/i,
            isReady: () => Boolean(globalScope.CCXP_CAPTCHA && globalScope.CCXP_CAPTCHA_MODEL),
            recognize: (image) => globalScope.CCXP_CAPTCHA.predictDigits(image),
        },
        "nthu-idm-4": {
            digits: 4,
            srcPattern: /\/captcha\/image\//i,
            isReady: () => Boolean(globalScope.LIBRARY_CAPTCHA && globalScope.LIBRARY_CAPTCHA_MODEL),
            recognize: (image) => globalScope.LIBRARY_CAPTCHA.predictDigits(image),
        },
        "nthu-oauth-4": {
            digits: 4,
            srcPattern: /captchaimg\.php/i,
            isReady: () => Boolean(globalScope.EECLASS_DECAPTCHA && typeof globalScope.EECLASS_DECAPTCHA.predictDigits === "function"),
            recognize: (image) => globalScope.EECLASS_DECAPTCHA.predictDigits(image),
        },
    };

    // 依圖片網址判斷版型；找不到就回傳 null
    function matchProfileId(image) {
        const src = (image?.getAttribute?.("src") ?? image?.src ?? "").trim();
        if (src === "") {
            return null;
        }
        for (const [id, profile] of Object.entries(PROFILES)) {
            if (profile.srcPattern.test(src)) {
                return id;
            }
        }
        return null;
    }

    // 辨識；成功回傳 { profileId, answer }，失敗或位數不符回傳 null（呼叫端就不要填）
    async function recognize(image, profileId = matchProfileId(image)) {
        const profile = profileId ? PROFILES[profileId] : null;
        if (!profile || !profile.isReady()) {
            return null;
        }
        if (!image.complete || image.naturalWidth <= 0) {
            return null;
        }
        try {
            const raw = await profile.recognize(image);
            const answer = String(raw ?? "").trim();
            if (!new RegExp(`^\\d{${profile.digits}}$`).test(answer)) {
                return null;
            }
            return { profileId, answer };
        }
        catch {
            return null;
        }
    }

    globalScope.NTHU_CAPTCHA_KIT = { PROFILES, matchProfileId, recognize };
})(globalThis);
