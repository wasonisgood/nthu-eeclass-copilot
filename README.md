# NTHU eeclass Copilot｜清大數位學習與校務全能助手

![Manifest V3](https://img.shields.io/badge/Manifest-V3-9F5FA5?style=flat-square)
![Version](https://img.shields.io/badge/Version-1.4.0-9F5FA5?style=flat-square)
![Security](https://img.shields.io/badge/Crypto-AES--GCM--256%20%2B%20PBKDF2-15803d?style=flat-square)
![License](https://img.shields.io/badge/License-MIT-blue?style=flat-square)

**NTHU eeclass Copilot** 是專為國立清華大學數位學習平台 (`eeclass.nthu.edu.tw`) 與校務資訊系統 OAuth (`oauth.ccxp.nthu.edu.tw`) 打造的全方位智慧瀏覽器擴充功能。  
全方位整合 **本地端深度學習 4 位數驗證碼自動辨識登入**、**Google 日曆作業與事件即時雙向差異同步**、**課程教材單元分類與指定本機目錄自動同步**、**助教 (TA) 模組化工作台**，以及 **本機硬體隔離金鑰加密保險箱**。

---

## ✨ 功能總覽

### 1. 清大 OAuth 驗證碼自動辨識與無感登入 (`oauth.ccxp.nthu.edu.tw`)
- **純本地端 CNN + Attention 模型推論**：無須連接外部伺服器，於瀏覽器本地即時完成 4 位數驗證碼圖片辨識。
- **系統風格等待轉場畫面**：自動填充與驗證期間渲染清大紫系統風格遮罩，避免畫面閃爍。
- **跨校選修與防鎖定保護**：完整支援校外選修學生（學校代碼 + 身分證字號）自動帶入；若遇帳密錯誤或驗證失敗，自動中止重試以防帳號鎖定。

### 2. Google 日曆作業與事件自動同步 (`calendar-sync.js` / `calendar-content.js`)
- **完整時間區間擷取（開放繳交 → 繳交期限）**：
  - 於「最近事件 (`/dashboard/latestEvent`)」、「作業列表 (`/course/homeworkList/*`)」或「作業詳情頁 (`/course/homework/*`)」自動解析每筆作業的 **開放繳交時間（開始）**、**繳交期限（結束）**、**作業類型**、**允許遲交**、**成績比重**、**評分方式** 與 **說明附件**。
- **作業繳交連結直達**：
  - 自動將作業繳交頁面網址嵌入 Google 日曆事件的 `location`、`source` 與內文首行，在手機或電腦日曆點擊即可直接開啟繳交頁面。
- **三階段合理提醒與 Email 通知**：
  - 預設配置截止前 **提前 1 天 (24 小時)**、**提前 3 小時**、**提前 1 小時** 彈出通知，並支援開啟截止前 Email 信件提醒。
- **內容異動即時偵測與更新 (`contentHash`)**：
  - 透過事件指紋比對與 `MutationObserver` 即時監聽，當授課教師延長繳交期限、調整開放時間或修改作業說明時，自動透過 Google Calendar API `PUT` 原地更新日曆事件，絕不產生重複事件。
- **三種日曆歸檔模式 + 個別課程獨立指派**：
  1. **所有課程一起加入同一個日曆**：自動建立並歸檔至 `NTHU eeclass 課程事件`。
  2. **各課程分別建立獨立日曆**：依課程名稱自動建立 `[eeclass] <課程名稱>` 獨立日曆。
  3. **加入使用者既有日曆**：自動載入 Google 帳號內所有可寫入之既有日曆供選取。
  4. **個別課程日曆指派表**：支援針對單一或多門特定課程覆寫歸檔目標（例如將指定幾門課放同一個日曆、特定重課獨立一個日曆），切換時舊事件會自動遷移至新目標日曆。

### 3. 課程教材自動分類與本機目錄同步 (`course-downloader.js`)
- **按鈕式本機資料夾綁定 (`showDirectoryPicker`)**：
  - 全面移除繁瑣的路徑文字輸入，直接點擊 **「選擇資料夾」** 按鈕即可透過系統原生對話框指定本機任意存放資料夾。
- **更新目錄時自動檢查可存性 (`verifyDirectoryWritable`)**：
  - 選取或更新預設目錄時，系統會自動執行讀寫權限確認與隱藏暫存檔實測寫入驗證，確保目標非唯讀或受保護目錄後才予以儲存。
- **預設目錄與子資料夾自動建立**：
  - 未額外綁定本機資料夾時，預設存放於 **系統「下載 (Downloads)」/ `eeclass_教材`**，並依 `<課程名稱>/<單元名稱>/<檔案名稱>` 自動遞迴建立不存在的資料夾。
- **進入課程自動同步 & 保留個別下載**：
  - 支援進入課程頁面時自動比對並背景下載新上架教材。
  - 保留原單一附件點擊下載方式，並在附件旁提供 **「存入指定目錄」** 按鈕（按住 `Shift` 點擊可另選單次存放資料夾）。

### 4. 即時同步與下載進度面板 (Live Progress HUD)
- 於 `eeclass.nthu.edu.tw` 全站右下角常駐浮動工具列，以及擴充功能 Popup / 側邊設定面板頂部，提供即時同步的 **進度百分比 (`0%~100%`)**、**目前處理項目名稱** 與 **近期完成紀錄清單**。

### 5. 雙視圖設定面板與助教 (TA) 擴充架構 (`options.html` / `options.js`)
- **精簡短選單 (`Popup`) + 側邊分割視窗 (`Side Panel / Split Window`)**：
  - 點擊工具列圖示顯示高頻率設定短選單；點擊「在側邊分割視窗開啟完整設定」可開啟 Chrome 原生右側邊欄或自動將瀏覽器與設定視窗左右並排。
- **全自動即時儲存**：
  - 所有開關、下拉選單與資料夾選擇皆於點擊瞬間自動儲存；僅需打字時間的帳號密碼採用獨立加密儲存按鈕。
- **助教專區 (TA) 模組化設定**：
  - 預留「作業與批改」、「成績與名單」、「教材與公告」助教設定分頁。

---

## 🔒 資安與隱私保護架構 (`crypto-vault.js`)

1. **零明文落盤 (`AES-GCM-256`)**：
   - 學號密碼 (`password`) 與身分證字號 (`cid`) 皆經 Web Crypto API `AES-GCM` (256-bit) 搭配隨機 96-bit IV 加密後才存入 `chrome.storage.local`，本機硬碟絕不留存明文密碼。
2. **硬體/沙盒隔離不可匯出金鑰 (`extractable: false`)**：
   - 預設解密金鑰為 `extractable: false` 之 `CryptoKey` 物件，隔離儲存於擴充功能專屬來源 (`chrome-extension://`) 的 IndexedDB 中，任何網頁端腳本皆無法匯出或讀取原始金鑰位元組。
3. **最小權限來源驗證 (`isTrustedOauthSender`)**：
   - 背景服務嚴格校驗訊息發送端之 `sender.id`、`frameId === 0` 與完整網址，僅允許 `https://oauth.ccxp.nthu.edu.tw/v*/authorize.php` 請求解密登入憑證。
4. **進階自訂主密碼 (`PBKDF2-HMAC-SHA256`)**：
   - 於「進階資安與自訂金鑰」分頁支援設定自訂主密碼，採用 210,000 次 `PBKDF2-SHA256` 迭代與 128-bit 隨機 Salt 衍生金鑰，解鎖狀態僅駐留於瀏覽器純記憶體 (`chrome.storage.session`)，關閉瀏覽器即自動銷毀。

---

## 🚀 安裝方式

1. 下載或 Clone 本專案至本機：
   ```bash
   git clone https://github.com/wasonisgood/nthu-eeclass-copilot.git
   cd nthu-eeclass-copilot
   ```
2. 開啟 Chrome / Edge / Brave 瀏覽器，前往擴充功能管理頁面：
   ```text
   chrome://extensions/
   ```
3. 開啟右上角的 **「開發人員模式 (Developer mode)」**。
4. 點擊左上角 **「載入未封裝項目 (Load unpacked)」**，選擇本專案根目錄即可完成安裝。

---

## 📅 Google 日曆授權設定指南

因本機載入之未封裝擴充功能需綁定 OAuth 憑證方能呼叫 Google Calendar API，請於擴充功能 **「完整設定 → Google 日曆與事件 → 授權參數設定」** 中擇一設定：

### 方式 A：建立個人 Google Cloud OAuth Client ID（推薦，設定一次永久有效）
1. 在擴充功能「授權參數設定」點擊 **「複製導向網址」**（格式為 `https://<您的擴充功能ID>.chromiumapp.org/`）。
2. 前往 [Google Cloud Console](https://console.cloud.google.com/)：
   - 於 **「API 和服務 → 程式庫」** 搜尋並啟用 **Google Calendar API**。
   - 於 **「OAuth 同意畫面」** 設定為「外部 (External)」，並在 **「測試使用者 (Test users)」** 加入您的 Google 信箱。
   - 於 **「憑證 → 建立憑證 → OAuth 用戶端 ID」** 選擇 **「網頁應用程式 (Web application)」**，將步驟 1 複製的導向網址貼入 **「已授權的重新導向 URI」**。
3. 複製產生的 **用戶端 ID (`xxxx.apps.googleusercontent.com`)** 貼回擴充功能，點擊 **「索取 Google 日曆授權」** 即可完成連結。

### 方式 B：使用 OAuth Playground 快速體驗（免建專案，1 分鐘完成）
1. 前往 [Google OAuth 2.0 Playground](https://developers.google.com/oauthplayground/)。
2. 於 Step 1 勾選 **Google Calendar API v3** 下的 `https://www.googleapis.com/auth/calendar`，點擊 **Authorize APIs**。
3. 於 Step 2 點擊 **Exchange authorization code for tokens**，複製產生的 **`Access token` (`ya29....`)**。
4. 貼入擴充功能「授權參數設定」下方的 Token 欄位並點擊 **「驗證並綁定 Token」** 即可立即同步。

---

## 📁 專案結構

| 檔案路徑 | 說明 |
| :--- | :--- |
| [`manifest.json`](manifest.json) | Chrome Extension Manifest V3 設定檔 |
| [`background.js`](background.js) | 背景 Service Worker：OAuth 來源驗證、檔案下載佇列、本機目錄寫入與日曆訊息中樞 |
| [`crypto-vault.js`](crypto-vault.js) | WebCrypto `AES-GCM-256` 與 `PBKDF2-SHA256` 憑證加密保險箱模組 |
| [`decaptcha.js`](decaptcha.js) | 4 位數驗證碼影像前處理與 CNN + Attention 推論引擎 |
| [`decaptcha.model.js`](decaptcha.model.js) | 驗證碼辨識神經網路權重模型 (Base64 Float32) |
| [`content.js`](content.js) | 清大 OAuth 登入頁驗證碼辨識、自動填充與系統風格等待畫面渲染 |
| [`course-downloader.js`](course-downloader.js) | eeclass 課程教材掃描、單元分類下載、資料夾可存性檢查與右下角即時進度 HUD |
| [`course-downloader.css`](course-downloader.css) | 課程頁浮動工具列、即時進度面板與日曆同步狀態標籤樣式 |
| [`calendar-sync.js`](calendar-sync.js) | Google Calendar API v3 同步引擎：多日曆歸檔路由、`contentHash` 差異比對與背景巡檢 |
| [`calendar-content.js`](calendar-content.js) | eeclass 最近事件與作業詳情頁面解析、DOM 異動監聽與即時日曆更新觸發器 |
| [`options.html`](options.html) | 雙模式設定面板（Popup 高頻短選單 + 側邊分割完整設定介面） |
| [`options.css`](options.css) | 貼合原系統 (`ccxpLite`) 設計規範之樣式表 |
| [`options.js`](options.js) | 設定面板即時自動儲存、目錄可存性測試、Google 日曆課程指派與助教專區控制器 |
| [`assets/`](assets/) | 擴充功能圖示資源 (`16x16`、`32x32`、`48x48`、`128x128`) |

---

## 🛠️ 開發與語法檢查

執行全專案 JavaScript 語法檢查：

```bash
npm run check
```

## 📄 授權條款

本專案採用 [MIT License](LICENSE) 授權。
