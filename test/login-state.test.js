// 驗證登入狀態判斷規則（login-state.js）。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
vm.runInThisContext(fs.readFileSync(path.join(__dirname, "..", "login-state.js"), "utf8"), { filename: "login-state.js" });

const { STATES, classify, TARGETS } = globalThis.NTHU_LOGIN_STATE;
const ccxp = TARGETS.find((t) => t.id === "ccxp");
const eeclass = TARGETS.find((t) => t.id === "eeclass");

const cases = [
    {
        name: "被導回校務登入首頁 -> 未登入",
        input: { finalUrl: "https://www.ccxp.nthu.edu.tw/ccxp/INQUIRE/index.php?lang=chinese", status: 200, html: "<html>帳號</html>" },
        target: ccxp,
        expect: STATES.LOGGED_OUT,
    },
    {
        name: "頁面含密碼欄位 -> 未登入",
        input: { finalUrl: "https://idm.nthu.ust.edu.tw/x/", status: 200, html: '<input type="password" name="p">' },
        target: TARGETS.find((t) => t.id === "idm"),
        expect: STATES.LOGGED_OUT,
    },
    {
        name: "eeclass 首頁含登入連結 -> 未登入",
        input: { finalUrl: "https://eeclass.nthu.edu.tw/", status: 200, html: '<a href="/service/oauthRedir">登入</a>' },
        target: eeclass,
        expect: STATES.LOGGED_OUT,
    },
    {
        name: "校務系統未登入（session is interrupted 且跳回首頁）-> 未登入",
        input: {
            finalUrl: "https://www.ccxp.nthu.edu.tw/ccxp/INQUIRE/select_entry.php",
            status: 200,
            html: "session is interrupted!<br><script>window.top.location='/ccxp/INQUIRE/';</script>",
        },
        target: ccxp,
        expect: STATES.LOGGED_OUT,
    },
    {
        name: "正常頁面、無登入表單 -> 已登入",
        input: { finalUrl: "https://www.ccxp.nthu.edu.tw/ccxp/INQUIRE/select_entry.php", status: 200, html: "<html>選擇身分</html>" },
        target: ccxp,
        expect: STATES.LOGGED_IN,
    },
    {
        name: "HTTP 500 -> 無法判斷",
        input: { finalUrl: "https://www.ccxp.nthu.edu.tw/x", status: 500, html: "" },
        target: ccxp,
        expect: STATES.UNKNOWN,
    },
];

for (const c of cases) {
    const result = classify(c.input, c.target);
    assert.equal(result.state, c.expect, `${c.name}：實際 ${result.state}（${result.reason}）`);
}

console.log(`login-state: ${cases.length}/${cases.length} 判斷案例通過`);
