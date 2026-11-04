"use strict";

// 登入狀態偵錯頁的邏輯：探測、顯示結果、列出 cookie 名稱。
// 判斷規則在 login-state.js（classify），這裡只負責發請求與畫面。
(function loginProbeUi(globalScope) {
    const { STATES, classify, TARGETS } = globalScope.NTHU_LOGIN_STATE;
    const rowsEl = document.getElementById("rows");
    const cookiesEl = document.getElementById("cookies");

    const SNIFF_BYTES = 200000; // 只讀前 200KB 做判斷，避免大頁面拖慢偵錯

    async function probe(target, url) {
        try {
            const response = await fetch(url, { credentials: "include", redirect: "follow", cache: "no-store" });
            const reader = response.body?.getReader();
            let received = 0;
            const chunks = [];
            if (reader) {
                while (received < SNIFF_BYTES) {
                    const { value, done } = await reader.read();
                    if (done) {
                        break;
                    }
                    chunks.push(value);
                    received += value.length;
                }
                reader.cancel().catch(() => {});
            }
            const html = new TextDecoder("utf-8").decode(concat(chunks));
            const result = classify({ finalUrl: response.url, status: response.status, html }, target);
            return { ...result, finalUrl: response.url, status: response.status };
        }
        catch (error) {
            return { state: STATES.UNKNOWN, reason: `請求失敗：${error?.message ?? error}`, finalUrl: "", status: 0 };
        }
    }

    function concat(chunks) {
        const total = chunks.reduce((sum, c) => sum + c.length, 0);
        const out = new Uint8Array(total);
        let offset = 0;
        for (const c of chunks) {
            out.set(c, offset);
            offset += c.length;
        }
        return out;
    }

    function renderRow(target) {
        const tr = document.createElement("tr");
        tr.dataset.id = target.id;

        const nameTd = document.createElement("td");
        nameTd.textContent = target.label;

        const urlTd = document.createElement("td");
        const input = document.createElement("input");
        input.type = "text";
        input.value = target.probeUrl;
        urlTd.append(input);

        const btnTd = document.createElement("td");
        const btn = document.createElement("button");
        btn.textContent = "探測";
        btn.addEventListener("click", () => runOne(tr, target, input.value.trim(), btn));
        btnTd.append(btn);

        const stateTd = document.createElement("td");
        stateTd.className = "state muted";
        stateTd.textContent = "未探測";

        const detailTd = document.createElement("td");
        detailTd.className = "muted";
        detailTd.textContent = "—";

        tr.append(nameTd, urlTd, btnTd, stateTd, detailTd);
        return tr;
    }

    async function runOne(tr, target, url, btn) {
        btn.disabled = true;
        const stateTd = tr.children[3];
        const detailTd = tr.children[4];
        stateTd.className = "state muted";
        stateTd.textContent = "探測中…";
        const result = await probe(target, url);
        stateTd.className = `state ${result.state}`;
        stateTd.textContent = result.state;
        detailTd.className = "";
        detailTd.textContent = `${result.reason}｜HTTP ${result.status || "—"}｜最終網址：${result.finalUrl || "—"}`;
        btn.disabled = false;
    }

    document.getElementById("probeAll").addEventListener("click", () => {
        for (const tr of rowsEl.querySelectorAll("tr")) {
            const target = TARGETS.find((t) => t.id === tr.dataset.id);
            const url = tr.children[1].querySelector("input").value.trim();
            runOne(tr, target, url, tr.children[2].querySelector("button"));
        }
    });

    document.getElementById("listCookies").addEventListener("click", async () => {
        if (!globalScope.chrome?.cookies) {
            cookiesEl.textContent = "此環境沒有 chrome.cookies（需要 cookies 權限）。";
            return;
        }
        const lines = [];
        const domains = [...new Set(TARGETS.flatMap((t) => t.cookieDomains))];
        for (const domain of domains) {
            const cookies = await globalScope.chrome.cookies.getAll({ domain });
            lines.push(`■ ${domain}（${cookies.length} 個）`);
            for (const c of cookies) {
                const attrs = [
                    c.secure ? "Secure" : "",
                    c.httpOnly ? "HttpOnly" : "",
                    c.session ? "會話cookie" : `到期 ${new Date(c.expirationDate * 1000).toLocaleString()}`,
                    `SameSite=${c.sameSite}`,
                ].filter(Boolean).join("，");
                lines.push(`   ${c.name}  [${attrs}]  path=${c.path}`);
            }
        }
        cookiesEl.className = "";
        cookiesEl.textContent = lines.join("\n") || "沒有 cookie。";
    });

    for (const target of TARGETS) {
        rowsEl.append(renderRow(target));
    }
})(globalThis);
