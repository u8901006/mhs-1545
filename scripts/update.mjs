import { readFile, mkdir, writeFile } from "node:fs/promises";
import https from "node:https";

const MHS_BASE = "https://sps.mohw.gov.tw/mhs";
const QUERY_PAGE_URL = `${MHS_BASE}/Home/QueryServiceOrg`;
const QUERY_JSON_URL = `${MHS_BASE}/Home/QueryServiceOrgJsonList`;
const ZHIPU_BASE_URL = "https://open.bigmodel.cn/api/coding/paas/v4";
const ZHIPU_MODELS = ["GLM-5-Turbo", "GLM-4.7", "GLM-4.7-Flash"];
const REQUEST_TIMEOUT_MS = 480_000;
const MAX_OUTPUT_TOKENS = 50_000;

const referencePath = new URL("../data/taipeupsy.html", import.meta.url);
const outputPath = new URL("../docs/index.html", import.meta.url);

function decodeResponse(buffer, contentType = "") {
  const charset = /charset=([^;]+)/i.exec(contentType)?.[1]?.trim().toLowerCase();
  const encodings = charset ? [charset, "utf-8", "big5"] : ["utf-8", "big5"];
  for (const encoding of encodings) {
    try {
      const decoded = new TextDecoder(encoding, { fatal: false }).decode(buffer);
      if (!decoded.includes("�") || encoding === encodings.at(-1)) return decoded;
    } catch {
      // Try the next decoder.
    }
  }
  return new TextDecoder().decode(buffer);
}

async function fetchText(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
  try {
    let response;
    try {
      response = await fetch(url, { ...options, signal: controller.signal });
    } catch (error) {
      if (error?.cause?.code !== "UNABLE_TO_VERIFY_LEAF_SIGNATURE" || new URL(url).hostname !== "sps.mohw.gov.tw") {
        throw error;
      }
      return await fetchTextWithAllowlistedTlsFallback(url, options);
    }
    const buffer = await response.arrayBuffer();
    const text = decodeResponse(buffer, response.headers.get("content-type") ?? "");
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} from ${url}: ${text.slice(0, 300)}`);
    }
    return { text, headers: response.headers };
  } finally {
    clearTimeout(timeout);
  }
}

function fetchTextWithAllowlistedTlsFallback(url, options = {}) {
  const target = new URL(url);
  if (target.hostname !== "sps.mohw.gov.tw") throw new Error(`TLS fallback refused for ${target.hostname}`);
  return new Promise((resolve, reject) => {
    const body = options.body?.toString?.() ?? options.body;
    const request = https.request({
      method: options.method ?? "GET",
      hostname: target.hostname,
      path: `${target.pathname}${target.search}`,
      headers: options.headers,
      rejectUnauthorized: false,
      timeout: options.timeoutMs ?? 30_000
    }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => {
        const buffer = Buffer.concat(chunks);
        const text = decodeResponse(buffer, response.headers["content-type"] ?? "");
        if ((response.statusCode ?? 500) >= 400) {
          reject(new Error(`HTTP ${response.statusCode} from ${url}: ${text.slice(0, 300)}`));
          return;
        }
        const headerMap = new Map(Object.entries(response.headers).map(([key, value]) => [key.toLowerCase(), Array.isArray(value) ? value.join(", ") : value ?? ""]));
        resolve({
          text,
          headers: {
            get: key => headerMap.get(key.toLowerCase()) ?? null,
            getSetCookie: () => Array.isArray(response.headers["set-cookie"]) ? response.headers["set-cookie"] : []
          }
        });
      });
    });
    request.on("error", reject);
    request.on("timeout", () => request.destroy(new Error(`Request timed out: ${url}`)));
    if (body) request.write(body);
    request.end();
  });
}

function extractToken(html) {
  const token = /name=["']__RequestVerificationToken["'][^>]*value=["']([^"']+)["']/i.exec(html)?.[1];
  if (!token) throw new Error("Could not find MOHW request verification token");
  return token;
}

function parseCookies(headers) {
  return headers.getSetCookie?.().map(cookie => cookie.split(";")[0]).join("; ") ?? "";
}

function stripTags(value) {
  return String(value ?? "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeName(value) {
  return stripTags(value)
    .replace(/[\s　]/g, "")
    .replace(/[()（）【】\[\]「」『』]/g, "")
    .replace(/身心科|精神科|診所|醫院|心理治療所|心理諮商所/g, "");
}

async function scrapeMhsClinics() {
  const queryPage = await fetchText(QUERY_PAGE_URL);
  const token = extractToken(queryPage.text);
  const cookie = parseCookies(queryPage.headers);
  const body = new URLSearchParams({
    __RequestVerificationToken: token,
    county: "1",
    orgName: "",
    haveServiceCount: "1",
    NowPage: "1",
    PageSize: "1000",
    FirstSearch: "true",
    sortCol: "",
    sortMode: ""
  });

  const { text } = await fetchText(QUERY_JSON_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
      "cookie": cookie,
      "origin": MHS_BASE,
      "referer": QUERY_PAGE_URL,
      "x-requested-with": "XMLHttpRequest"
    },
    body
  });

  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed.rows)) throw new Error("MOHW response did not contain rows");

  return parsed.rows.map(row => ({
    name: stripTags(row.orgName),
    address: stripTags(row.address),
    phone: stripTags(row.phone),
    selfPayFee: stripTags(row.payDetail) || "未提供",
    thisWeekCount: Number(row.thisWeekCount ?? 0),
    nextWeekCount: Number(row.nextWeekCount ?? 0),
    next2WeekCount: Number(row.next2WeekCount ?? 0),
    next3WeekCount: Number(row.next3WeekCount ?? 0),
    availableSlots: Number(row.in4WeekTotleCount ?? 0),
    sourceUpdatedAt: stripTags(row.editDate),
    teleconsultation: stripTags(row.strTeleconsultation)
  })).filter(clinic => clinic.name && clinic.availableSlots > 0);
}

async function readReferenceNames() {
  const html = await readFile(referencePath, "utf8");
  const plain = stripTags(html);
  const candidates = new Set();
  for (const match of plain.matchAll(/[\u4e00-\u9fffA-Za-z0-9（）()]{2,40}(?:診所|身心科|精神科|心理諮商所|心理治療所|醫院)/g)) {
    candidates.add(match[0].trim());
  }
  return { plain, names: [...candidates] };
}

function localReferenceFilter(clinics, reference) {
  return clinics.filter(clinic => {
    if (reference.plain.includes(clinic.name)) return true;
    const clinicNorm = normalizeName(clinic.name);
    if (!clinicNorm || clinicNorm.length < 2) return false;
    return reference.names.some(name => {
      const referenceNorm = normalizeName(name);
      return referenceNorm.includes(clinicNorm) || clinicNorm.includes(referenceNorm);
    });
  });
}

function extractJson(text) {
  const cleaned = text
    .replace(/```(?:json)?/gi, "")
    .replace(/```/g, "")
    .trim();
  const start = cleaned.search(/[\[{]/);
  if (start < 0) throw new Error("No JSON object or array found in GLM response");
  const open = cleaned[start];
  const close = open === "[" ? "]" : "}";
  const end = cleaned.lastIndexOf(close);
  if (end < start) throw new Error("Incomplete JSON in GLM response");
  const candidate = cleaned
    .slice(start, end + 1)
    .replace(/,\s*([}\]])/g, "$1");
  return JSON.parse(candidate);
}

function validateFilteredClinics(value, sourceClinics) {
  const array = Array.isArray(value) ? value : value?.clinics;
  if (!Array.isArray(array)) throw new Error("GLM JSON did not return an array");
  const byName = new Map(sourceClinics.map(clinic => [clinic.name, clinic]));
  return array.map(item => {
    const source = byName.get(stripTags(item.name));
    if (!source) return null;
    return {
      ...source,
      availableSlots: Number(item.availableSlots ?? source.availableSlots),
      selfPayFee: stripTags(item.selfPayFee ?? source.selfPayFee) || source.selfPayFee
    };
  }).filter(Boolean);
}

async function callZhipu(model, clinics, referenceNames) {
  const apiKey = process.env.ZHIPU_API_KEY;
  if (!apiKey) throw new Error("ZHIPU_API_KEY is not set");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${ZHIPU_BASE_URL}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "authorization": `Bearer ${apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model,
        max_tokens: MAX_OUTPUT_TOKENS,
        temperature: 0,
        messages: [
          {
            role: "system",
            content: "你是資料清洗器。只輸出合法 JSON，不要 Markdown，不要解釋。任務：從衛福部名單中，只保留參考診所名單中有出現或可明確對應的診所。"
          },
          {
            role: "user",
            content: JSON.stringify({
              output_schema: [{ name: "string", availableSlots: "number", selfPayFee: "string" }],
              source_clinics: clinics.map(({ name, availableSlots, selfPayFee }) => ({ name, availableSlots, selfPayFee })),
              reference_clinic_names: referenceNames
            })
          }
        ]
      })
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Zhipu ${model} HTTP ${response.status}: ${text.slice(0, 500)}`);
    const payload = JSON.parse(text);
    return payload.choices?.[0]?.message?.content ?? text;
  } finally {
    clearTimeout(timeout);
  }
}

async function filterWithZhipu(clinics, reference) {
  const localFallback = localReferenceFilter(clinics, reference);
  for (const model of ZHIPU_MODELS) {
    try {
      const content = await callZhipu(model, clinics, reference.names);
      const parsed = extractJson(content);
      const filtered = validateFilteredClinics(parsed, clinics);
      if (filtered.length > 0) return { clinics: filtered, model, usedFallback: false };
    } catch (error) {
      console.warn(`[warn] ${model} failed: ${error.message}`);
    }
  }
  return { clinics: localFallback, model: "local-reference-filter", usedFallback: true };
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderHtml(clinics, metadata) {
  const totalSlots = clinics.reduce((sum, clinic) => sum + clinic.availableSlots, 0);
  const generatedAt = new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei",
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date());
  const rows = clinics
    .sort((a, b) => b.availableSlots - a.availableSlots || a.name.localeCompare(b.name, "zh-Hant"))
    .map(clinic => `
      <li class="clinic-card">
        <div>
          <h2>${escapeHtml(clinic.name)}</h2>
          <p class="meta">衛福部更新：${escapeHtml(clinic.sourceUpdatedAt || "未提供")}</p>
        </div>
        <div class="slot">${escapeHtml(clinic.availableSlots)}<span>名額</span></div>
        <dl>
          <div><dt>自付費用</dt><dd>${escapeHtml(clinic.selfPayFee)}</dd></div>
          <div><dt>本週</dt><dd>${escapeHtml(clinic.thisWeekCount)}</dd></div>
          <div><dt>下週</dt><dd>${escapeHtml(clinic.nextWeekCount)}</dd></div>
          <div><dt>再下週</dt><dd>${escapeHtml(clinic.next2WeekCount)}</dd></div>
          <div><dt>第 4 週</dt><dd>${escapeHtml(clinic.next3WeekCount)}</dd></div>
        </dl>
      </li>`).join("\n");

  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>台北市心理諮商合作機構尚有名額清單</title>
<meta name="description" content="每週自動更新台北市心理諮商合作機構尚有名額診所名單、名額數量與自付費用。">
<style>
:root { --bg: #f6f1e8; --surface: #fffaf2; --line: #d8c5ab; --text: #2b2118; --muted: #766453; --accent: #8c4f2b; --accent-soft: #ead2bf; }
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
body { background: radial-gradient(circle at top, #fff6ea 0, var(--bg) 55%, #ead8c6 100%); color: var(--text); font-family: "Noto Sans TC", "PingFang TC", "Helvetica Neue", Arial, sans-serif; min-height: 100vh; line-height: 1.75; }
.container { max-width: 760px; margin: 0 auto; padding: 72px 24px; }
.logo { font-size: 44px; text-align: center; margin-bottom: 14px; }
h1 { text-align: center; font-size: clamp(24px, 5vw, 34px); color: var(--text); margin-bottom: 8px; letter-spacing: .04em; }
.subtitle { text-align: center; color: var(--accent); font-size: 15px; margin-bottom: 14px; }
.count { text-align: center; color: var(--muted); font-size: 13px; margin-bottom: 32px; }
.stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 30px; }
.stat { background: rgba(255, 250, 242, .86); border: 1px solid var(--line); border-radius: 16px; padding: 18px 14px; text-align: center; box-shadow: 0 18px 50px rgba(82, 55, 33, .08); }
.stat strong { display: block; font-size: 28px; color: var(--accent); line-height: 1.1; }
.stat span { color: var(--muted); font-size: 13px; }
.notice { background: var(--accent-soft); border: 1px solid var(--line); border-radius: 14px; padding: 14px 18px; color: var(--muted); font-size: 14px; margin-bottom: 24px; }
ul { list-style: none; display: grid; gap: 12px; }
.clinic-card { background: var(--surface); border: 1px solid var(--line); border-radius: 18px; padding: 20px; display: grid; grid-template-columns: 1fr auto; gap: 16px; box-shadow: 0 12px 34px rgba(82, 55, 33, .07); }
.clinic-card h2 { font-size: 19px; margin-bottom: 4px; }
.meta { color: var(--muted); font-size: 13px; }
.slot { min-width: 82px; align-self: start; border-radius: 999px; background: var(--accent); color: #fffaf2; text-align: center; padding: 9px 12px; font-size: 24px; font-weight: 700; }
.slot span { display: block; font-size: 12px; font-weight: 400; }
dl { grid-column: 1 / -1; display: grid; grid-template-columns: repeat(5, 1fr); gap: 8px; }
dl div { border-top: 1px solid var(--line); padding-top: 10px; }
dt { color: var(--muted); font-size: 12px; }
dd { font-size: 14px; }
footer { margin-top: 56px; text-align: center; font-size: 12px; color: var(--muted); }
footer a { color: var(--muted); text-decoration: none; border-bottom: 1px dotted var(--muted); margin: 0 4px; }
footer a:hover { color: var(--accent); border-color: var(--accent); }
@media (max-width: 640px) { .container { padding: 48px 16px; } .stats { grid-template-columns: 1fr; } .clinic-card { grid-template-columns: 1fr; } .slot { width: 100%; } dl { grid-template-columns: repeat(2, 1fr); } }
</style>
</head>
<body>
<main class="container">
  <div class="logo">🧠</div>
  <h1>台北市心理諮商合作機構尚有名額清單</h1>
  <p class="subtitle">每週一 01:00 自動更新 · 僅保留參考頁有填寫的診所</p>
  <p class="count">產生時間：${escapeHtml(generatedAt)} · 過濾模型：${escapeHtml(metadata.model)}</p>
  <section class="stats" aria-label="統計">
    <div class="stat"><strong>${escapeHtml(clinics.length)}</strong><span>符合診所</span></div>
    <div class="stat"><strong>${escapeHtml(totalSlots)}</strong><span>四週總名額</span></div>
    <div class="stat"><strong>${metadata.usedFallback ? "本地" : "AI"}</strong><span>過濾方式</span></div>
  </section>
  <p class="notice">資料來源為衛福部心理健康支持方案合作機構查詢。名額會變動，實際預約與費用請以各機構公告為準。</p>
  <ul>${rows || "<li class=\"notice\">目前沒有符合條件的診所。</li>"}</ul>
  <footer>
    <p><a href="https://www.leepsyclinic.com/">李政洋身心診所首頁</a> · <a href="https://blog.leepsyclinic.com/">訂閱電子報</a> · <a href="https://buymeacoffee.com/CYlee">Buy me a coffee</a></p>
    <p>Powered by MOHW + Zhipu AI · <a href="https://github.com/u8901006/mhs-1545">GitHub</a></p>
  </footer>
</main>
</body>
</html>`;
}

async function main() {
  const [clinics, reference] = await Promise.all([scrapeMhsClinics(), readReferenceNames()]);
  const filtered = await filterWithZhipu(clinics, reference);
  await mkdir(new URL("../docs/", import.meta.url), { recursive: true });
  await writeFile(outputPath, renderHtml(filtered.clinics, filtered), "utf8");
  console.log(JSON.stringify({ scraped: clinics.length, rendered: filtered.clinics.length, model: filtered.model, usedFallback: filtered.usedFallback }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
