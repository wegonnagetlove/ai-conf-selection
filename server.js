"use strict";
/*
 * Сервер страницы отбора докладов. Без внешних зависимостей (Node.js 22+).
 *
 * Переменные окружения:
 *   PORT            порт (задаёт платформа)
 *   EXPERTS         эксперты и их коды входа: "Иванов И.И.=код1; Петрова А.А.=код2"
 *                   (разделитель ";" или перевод строки). Префикс "*" перед именем даёт права администратора
 *                   (оператора), префикс "#6" или "#6,7" делает человека куратором этих секций.
 *   SESSION_SECRET  длинная случайная строка для подписи cookie
 *   GITHUB_TOKEN    fine-grained токен с правом Contents: Read and write на репозиторий
 *   GITHUB_REPO     владелец/репозиторий, по умолчанию wegonnagetlove/ai-conf-selection
 *   MARKS_BRANCH    ветка для хранения отметок, по умолчанию marks
 *   MARKS_PATH      файл с отметками в этой ветке, по умолчанию marks.json
 */
const http = require("node:http");
const { programDocx, zip } = require("./program");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
const SITE = path.join(ROOT, "site");
// PDF тезисов: files/<номер заявки>-<1|2>.pdf, отдаются только вошедшим экспертам
const FILES = path.join(ROOT, "files");
const SECRET = process.env.SESSION_SECRET || "";
const GH_TOKEN = process.env.GITHUB_TOKEN || "";
const GH_REPO = process.env.GITHUB_REPO || "wegonnagetlove/ai-conf-selection";
const MARKS_BRANCH = process.env.MARKS_BRANCH || "marks";
const MARKS_PATH = process.env.MARKS_PATH || "marks.json";
const LOCAL_MARKS = path.join(ROOT, ".marks.local.json");
const SESSION_DAYS = 30;

/* ---------- эксперты ---------- */
function parseExperts(raw) {
  const out = new Map();
  let text = String(raw || "").trim().replace(/^EXPERTS\s*=\s*/i, "").replace(/^["'«]+|["'»]+$/g, "");
  text.split(/[;\n]+/).forEach((line) => {
    line = line.trim().replace(/^["'«]+|["'»]+$/g, "");
    if (!line) return;
    const i = line.lastIndexOf("=");
    // строка без «=» считается кодом администратора с именем «Админ»
    let name = i < 0 ? "*Админ" : line.slice(0, i).trim();
    const code = (i < 0 ? line : line.slice(i + 1)).trim();
    if (!name) name = "*Админ";
    if (code.length < 4) { console.warn("EXPERTS: пропущена запись «" + name + "»: код короче 4 символов"); return; }
    // префиксы в любом порядке: "*" администратор (оператор), "#6,7" куратор секций 6 и 7
    let admin = false, observer = false; const secs = []; let reviewSecs = [];
    for (;;) {
      name = name.trim();
      if (name.startsWith("*")) { admin = true; name = name.slice(1); continue; }
      if (name.startsWith("!")) { observer = true; name = name.slice(1); continue; }
      const helper = /^\+\s*(\d{1,2}(?:\s*,\s*\d{1,2})*)/.exec(name);
      if (helper) { reviewSecs = helper[1].split(",").map(Number); name = name.slice(helper[0].length); continue; }
      const m = /^#\s*(\d{1,2}(?:\s*,\s*\d{1,2})*)/.exec(name);
      if (m) { m[1].split(",").forEach((x) => secs.push(Number(x))); name = name.slice(m[0].length); continue; }
      break;
    }
    name = name.trim() || "Админ";
    // Совместимость с уже внесённой настройкой EXPERTS, где трое пользователей были без префикса роли.
    // После переноса на префиксы +11 и ! эти исключения можно удалить.
    if (!admin && !observer && !secs.length && !reviewSecs.length) {
      if (name === "Игнатова Валерия Александровна") reviewSecs = [11];
      if (name === "Толчина Мария Сергеевна" || name === "Бутылкина Ксения Дмитриевна") observer = true;
    }
    const id = "e" + crypto.createHash("sha256").update(name).digest("hex").slice(0, 12);
    // наблюдатель с секциями («!#4 Иванова») только смотрит эти секции: права куратора ему не даются
    let viewSecs = [...new Set([...secs, ...reviewSecs])];
    const curSecs = observer ? [] : secs;
    out.set(code, { id, name, admin, secs: curSecs, observer, reviewSecs, viewSecs });
  });
  return out;
}
const EXPERTS = parseExperts(process.env.EXPERTS);
const EXPERTS_BY_ID = new Map([...EXPERTS.values()].map((e) => [e.id, e]));

function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function findExpert(code) {
  let found = null;
  for (const [c, e] of EXPERTS) if (safeEqual(c, code)) found = e;
  return found;
}

/* ---------- сессии ---------- */
function sign(v) { return crypto.createHmac("sha256", SECRET).update(v).digest("base64url"); }
function makeSession(id) {
  const exp = Date.now() + SESSION_DAYS * 864e5;
  const v = id + "." + exp;
  return v + "." + sign(v);
}
function readSession(req) {
  const m = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie || "");
  if (!m || !SECRET) return null;
  const parts = decodeURIComponent(m[1]).split(".");
  if (parts.length !== 3) return null;
  const v = parts[0] + "." + parts[1];
  if (!safeEqual(sign(v), parts[2])) return null;
  if (Number(parts[1]) < Date.now()) return null;
  return EXPERTS_BY_ID.get(parts[0]) || null;
}
function cookie(res, value, maxAge) {
  res.setHeader("Set-Cookie", `sid=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`);
}

/* ---------- ограничение попыток входа ---------- */
// считаются только неудачные попытки: удачные входы экспертов из одной сети не блокируют друг друга
const attempts = new Map();
function attemptsOf(ip) {
  const now = Date.now(), a = attempts.get(ip) || { n: 0, t: now };
  if (now - a.t > 15 * 60e3) { a.n = 0; a.t = now; }
  attempts.set(ip, a);
  return a;
}
function tooMany(ip) { return attemptsOf(ip).n >= 20; }
function failed(ip) { attemptsOf(ip).n++; }

/* ---------- отметки ---------- */
// state.experts[id] = { name, picks: { "<заявка>-<1|2>": { s: "yes"|"maybe"|"no"|null, c: "", t: ms } } }
// state.decisions["<заявка>-<1|2>"] = { d, rev, note, by, t }  решение куратора (rev: дано время на доработку до 01.12)
// state.order["<секция>"] = { keys: [...], t }                         порядок докладов в программе
// state.secinfo["<секция>"] = { time, hall, moderator, experts, t }     шапка программы секции
let state = { experts: {}, decisions: {}, order: {}, secinfo: {} };
let version = 0;
let remoteSha = null;
let dirty = false, saving = false, saveTimer = null;
const STATUSES = new Set(["yes", "maybe", "no"]);
// решения куратора = статусы заявки на портале «Ломоносов» (перечень согласован 16.11.2026)
// без решения заявка остаётся в статусе «Новая»
const NEW_STATUS = "Новая";
const DECISIONS = {
  review: "На рассмотрении",
  oral_off: "Принята: устный доклад (очно)",
  oral_on: "Принята: устный доклад (онлайн)",
  poster: "Принята: постер (только для очных)",
  listen_off: "Принята: очный участник-слушатель",
  listen_on: "Принята: онлайн участник-слушатель",
  reject: "Отклонена",
};
const KEY_RE = /^\d{1,12}-[12]$/;
const clip = (x, n) => String(x == null ? "" : x).slice(0, n);

function mergeInto(base, other) {
  for (const [id, ex] of Object.entries((other && other.experts) || {})) {
    if (!ex || typeof ex !== "object") continue;
    const cur = base.experts[id] || (base.experts[id] = { name: String(ex.name || ""), picks: {} });
    if (ex.name) cur.name = String(ex.name);
    for (const [k, p] of Object.entries(ex.picks || {})) {
      if (!p || typeof p.t !== "number") continue;
      const mine = cur.picks[k];
      if (!mine || p.t > mine.t) cur.picks[k] = { s: STATUSES.has(p.s) ? p.s : null, c: String(p.c || "").slice(0, 1000), t: p.t };
    }
  }
  base.decisions = base.decisions || {}; base.order = base.order || {}; base.secinfo = base.secinfo || {};
  for (const [k, v] of Object.entries((other && other.decisions) || {})) {
    if (!KEY_RE.test(k) || !v || typeof v.t !== "number") continue;
    if (!base.decisions[k] || v.t > base.decisions[k].t) base.decisions[k] = cleanDecision(v, v.by, v.t);
  }
  for (const [k, v] of Object.entries((other && other.order) || {})) {
    if (!v || typeof v.t !== "number" || !Array.isArray(v.keys)) continue;
    if (!base.order[k] || v.t > base.order[k].t) base.order[k] = { keys: v.keys.filter((x) => KEY_RE.test(String(x))).slice(0, 200), t: v.t };
  }
  for (const [k, v] of Object.entries((other && other.secinfo) || {})) {
    if (!v || typeof v.t !== "number") continue;
    if (!base.secinfo[k] || v.t > base.secinfo[k].t) base.secinfo[k] = cleanSecinfo(v, v.t);
  }
  return base;
}

function cleanDecision(b, by, t) {
  let d = b.d, rev = !!b.rev;
  // старый статус «Требуется доработка» убран: такие заявки переходят в «На рассмотрении» с пометкой о доработке
  if (d === "revise") { d = "review"; rev = true; }
  return {
    d: Object.prototype.hasOwnProperty.call(DECISIONS, d) ? d : null,
    rev, note: clip(b.note, 1000), by: clip(by, 40), t,
  };
}
function cleanSecinfo(b, t) {
  return { time: clip(b.time, 60), hall: clip(b.hall, 200), moderator: clip(b.moderator, 1500), experts: clip(b.experts, 3000), t };
}

const GH_API = "https://api.github.com/repos/" + GH_REPO;
async function gh(pathname, opts = {}) {
  const r = await fetch(GH_API + pathname, {
    ...opts,
    headers: { Authorization: "Bearer " + GH_TOKEN, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "ai-conf-selection", ...(opts.headers || {}) },
  });
  const text = await r.text();
  let body = null; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: r.status, body };
}
async function ensureBranch() {
  const b = await gh("/branches/" + encodeURIComponent(MARKS_BRANCH));
  if (b.status === 200) return;
  const repo = await gh("");
  const def = repo.body && repo.body.default_branch || "main";
  const head = await gh("/git/ref/heads/" + encodeURIComponent(def));
  if (head.status !== 200) throw new Error("не удалось прочитать ветку " + def + ": " + head.status);
  const c = await gh("/git/refs", { method: "POST", body: JSON.stringify({ ref: "refs/heads/" + MARKS_BRANCH, sha: head.body.object.sha }) });
  if (c.status !== 201 && c.status !== 422) throw new Error("не удалось создать ветку " + MARKS_BRANCH + ": " + c.status);
}
async function fetchRemote() {
  const r = await gh("/contents/" + MARKS_PATH + "?ref=" + encodeURIComponent(MARKS_BRANCH));
  if (r.status === 404) { remoteSha = null; return { experts: {} }; }
  if (r.status !== 200) throw new Error("чтение отметок: " + r.status);
  remoteSha = r.body.sha;
  return JSON.parse(Buffer.from(r.body.content, "base64").toString("utf8"));
}
async function loadMarks() {
  if (GH_TOKEN) {
    await ensureBranch();
    state = mergeInto({ experts: {}, decisions: {}, order: {}, secinfo: {} }, await fetchRemote());
  } else {
    console.warn("GITHUB_TOKEN не задан: отметки хранятся только в памяти и локальном файле и пропадут при перезапуске");
    try { state = mergeInto({ experts: {}, decisions: {}, order: {}, secinfo: {} }, JSON.parse(fs.readFileSync(LOCAL_MARKS, "utf8"))); } catch {}
  }
  version++;
}
function scheduleSave() {
  dirty = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 2000);
}
async function save() {
  if (!dirty) return;
  if (saving) { scheduleSave(); return; }
  saving = true; dirty = false;
  try {
    if (!GH_TOKEN) { fs.writeFileSync(LOCAL_MARKS, JSON.stringify(state)); return; }
    for (let attempt = 0; attempt < 4; attempt++) {
      const content = Buffer.from(JSON.stringify(state, null, 1)).toString("base64");
      const body = { message: "Отметки и решения " + new Date().toISOString().slice(0, 16).replace("T", " "), content, branch: MARKS_BRANCH };
      if (remoteSha) body.sha = remoteSha;
      const r = await gh("/contents/" + MARKS_PATH, { method: "PUT", body: JSON.stringify(body) });
      if (r.status === 200 || r.status === 201) { remoteSha = r.body.content.sha; return; }
      if (r.status === 409 || r.status === 422) { mergeInto(state, await fetchRemote()); version++; continue; }
      throw new Error("запись отметок: " + r.status + " " + JSON.stringify(r.body).slice(0, 200));
    }
    throw new Error("запись отметок: не удалось после повторов");
  } catch (e) {
    console.error(e.message); dirty = true;
    clearTimeout(saveTimer); saveTimer = setTimeout(save, 15000);
  } finally { saving = false; }
}
// периодически подтягиваем изменения, записанные другими репликами
setInterval(async () => {
  if (!GH_TOKEN || dirty || saving) return;
  try { const before = JSON.stringify(state); mergeInto(state, await fetchRemote()); if (JSON.stringify(state) !== before) version++; } catch (e) { console.error(e.message); }
}, 60e3).unref();
// при остановке дожидаемся текущей записи и сохраняем несохранённое, иначе последние отметки теряются
async function shutdown() {
  clearTimeout(saveTimer);
  try {
    for (let i = 0; i < 50 && saving; i++) await new Promise((r) => setTimeout(r, 200));
    await save();
  } finally { process.exit(0); }
}
process.on("SIGTERM", shutdown); process.on("SIGINT", shutdown);

/* ---------- HTTP ---------- */
function send(res, status, body, type) {
  res.writeHead(status, { "Content-Type": type || "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function readBody(req, limit = 20000) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > limit) { reject(new Error("too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); } catch { reject(new Error("bad json")); } });
    req.on("error", reject);
  });
}
function file(name) { return fs.readFileSync(path.join(SITE, name)); }
let sectionsCache = null;
function sections() { return sectionsCache || (sectionsCache = file("data/sections.json")); }
let reportIndex = null;
function reports() {
  if (reportIndex) return reportIndex;
  reportIndex = new Map();
  try { for (const s of JSON.parse(sections())) for (const r of s.reports || []) reportIndex.set(r.key, { ...r, sec: s.num, secName: s.name }); } catch {}
  return reportIndex;
}
// «Петрухина Полина Игоревна» и «Петрухина П.И.» дают один ключ «петрухина пи»
function personKey(n) {
  const w = String(n || "").replace(/ё/gi, "е").replace(/[.,]/g, " ").trim().split(/\s+/).filter(Boolean);
  if (!w.length) return "";
  return (w[0] + " " + w.slice(1, 3).map((x) => x[0]).join("")).toLowerCase();
}
function conflict(me, r) {
  const k = personKey(me.name);
  return !!k && [r.name, ...(r.coauthors || [])].some((n) => personKey(n) === k);
}
// какие секции видит пользователь: оператор все, остальные только свои (куратор, помощник, наблюдатель)
function canSee(me, sec) { return !!me.admin || (me.viewSecs || []).includes(Number(sec)); }
let sectionsByUser = new Map();
function sectionsFor(me) {
  if (me.admin) return sections();
  if (!sectionsByUser.has(me.id)) sectionsByUser.set(me.id, JSON.stringify(JSON.parse(sections()).filter((s) => canSee(me, s.num))));
  return sectionsByUser.get(me.id);
}
function canDecide(me, r) { return !!r && (me.admin || (me.secs || []).includes(r.sec)); }
function canReview(me, r) {
  if (!r || me.observer) return false;
  if (me.admin) return true;
  return canSee(me, r.sec);
}

function publicMarks(me) {
  const seeKey = (k) => { const r = reports().get(k); return !!r && canSee(me, r.sec); };
  const ex = {};
  for (const [id, e] of Object.entries(state.experts)) {
    const picks = {};
    for (const [k, p] of Object.entries(e.picks || {})) if (p && p.s && seeKey(k)) picks[k] = { s: p.s, c: p.c || "" };
    if (!Object.keys(picks).length && id !== me.id) continue;
    ex[id] = { name: (EXPERTS_BY_ID.get(id) || {}).name || e.name || "Эксперт", picks };
  }
  const bySec = (o) => Object.fromEntries(Object.entries(o || {}).filter(([sec]) => canSee(me, sec)));
  const decisions = Object.fromEntries(Object.entries(state.decisions || {}).filter(([k]) => seeKey(k)));
  return { version, experts: ex, decisions, order: bySec(state.order), secinfo: bySec(state.secinfo), labels: { decisions: DECISIONS, none: NEW_STATUS } };
}

const server = http.createServer(async (req, res) => {
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  // прокси платформы дописывает адрес клиента в конец X-Forwarded-For, первые элементы клиент может подделать
  const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",").pop().trim();
  try {
    if (p === "/healthz") return send(res, 200, "ok", "text/plain");
    if (p === "/favicon.ico") { res.writeHead(204); return res.end(); }
    if (p === "/robots.txt") return send(res, 200, "User-agent: *\nDisallow: /\n", "text/plain");
    if (p === "/login") return send(res, 200, file("login.html"), "text/html; charset=utf-8");
    if (p === "/api/login" && req.method === "POST") {
      if (!SECRET || !EXPERTS.size) return send(res, 503, { error: "Вход не настроен: задайте SESSION_SECRET и EXPERTS" });
      if (tooMany(ip)) return send(res, 429, { error: "Слишком много попыток. Попробуйте через 15 минут." });
      const b = await readBody(req);
      const e = findExpert(String(b.code || "").trim());
      if (!e) { failed(ip); return send(res, 401, { error: "Код не подошёл" }); }
      if (!state.experts[e.id]) state.experts[e.id] = { name: e.name, picks: {} };
      cookie(res, makeSession(e.id), SESSION_DAYS * 86400);
      return send(res, 200, { ok: true });
    }
    if (p === "/api/logout" && req.method === "POST") { cookie(res, "", 0); return send(res, 200, { ok: true }); }

    const me = readSession(req);
    if (!me) {
      if (p.startsWith("/api/")) return send(res, 401, { error: "Нужен вход" });
      res.writeHead(302, { Location: "/login", "Cache-Control": "no-store" }); return res.end();
    }
    if (p === "/" || p === "/index.html") return send(res, 200, file("index.html"), "text/html; charset=utf-8");
    if (p === "/api/me") return send(res, 200, { id: me.id, name: me.name, admin: me.admin, secs: me.secs || [], observer: !!me.observer, reviewSecs: me.reviewSecs || [], storage: GH_TOKEN ? "github" : "memory" });
    if (p === "/api/sections") return send(res, 200, sectionsFor(me));
    const pdf = p.match(/^\/files\/(\d{1,12}-[12])\.pdf$/);
    if (pdf) {
      const pr = reports().get(pdf[1]);
      if (!pr || !canSee(me, pr.sec)) return send(res, 404, { error: "Файла нет" });
      const fp = path.join(FILES, pdf[1] + ".pdf");
      if (!fs.existsSync(fp)) return send(res, 404, { error: "Файла нет" });
      res.writeHead(200, {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${pdf[1]}.pdf"`,
        "Cache-Control": "private, max-age=3600",
      });
      return fs.createReadStream(fp).pipe(res);
    }
    if (p === "/api/marks" && req.method === "GET") {
      if (url.searchParams.get("v") === String(version)) return send(res, 200, { version, same: true });
      return send(res, 200, publicMarks(me));
    }
    if (p === "/api/marks" && req.method === "PUT") {
      const b = await readBody(req);
      const key = String(b.key || "");
      if (!/^\d{1,12}-[12]$/.test(key)) return send(res, 400, { error: "bad key" });
      const r = reports().get(key);
      if (!r) return send(res, 400, { error: "Нет такого доклада" });
      if (!canReview(me, r)) return send(res, 403, { error: "У вас нет права оценивать доклады этой секции" });
      const s = b.s == null ? null : String(b.s);
      if (s !== null && !STATUSES.has(s)) return send(res, 400, { error: "bad status" });
      const ex = state.experts[me.id] || (state.experts[me.id] = { name: me.name, picks: {} });
      ex.name = me.name;
      ex.picks[key] = { s, c: s ? String(b.c || "").slice(0, 1000) : "", t: Date.now() };
      version++; scheduleSave();
      return send(res, 200, { ok: true, version });
    }
    if (p === "/api/decision" && req.method === "PUT") {
      const b = await readBody(req);
      const r = reports().get(String(b.key || ""));
      if (!r) return send(res, 400, { error: "Нет такого доклада" });
      if (!canDecide(me, r)) return send(res, 403, { error: "Решение по этой секции принимает её куратор" });
      if (conflict(me, r)) return send(res, 403, { error: "Это ваша заявка: решение по ней принимает другой член оргкомитета" });
      state.decisions[r.key] = cleanDecision(b, me.name, Date.now());
      version++; scheduleSave();
      return send(res, 200, { ok: true, version });
    }
    if (p === "/api/order" && req.method === "PUT") {
      const b = await readBody(req);
      const sec = Number(b.sec);
      if (!(me.admin || (me.secs || []).includes(sec))) return send(res, 403, { error: "Порядок секции задаёт её куратор" });
      const keys = (Array.isArray(b.keys) ? b.keys : []).map(String).filter((k) => KEY_RE.test(k) && (reports().get(k) || {}).sec === sec);
      state.order[String(sec)] = { keys, t: Date.now() };
      version++; scheduleSave();
      return send(res, 200, { ok: true, version });
    }
    if (p === "/api/secinfo" && req.method === "PUT") {
      const b = await readBody(req);
      const sec = Number(b.sec);
      if (!(me.admin || (me.secs || []).includes(sec))) return send(res, 403, { error: "Данные секции заполняет её куратор" });
      state.secinfo[String(sec)] = cleanSecinfo(b, Date.now());
      version++; scheduleSave();
      return send(res, 200, { ok: true, version });
    }
    // для оператора: программы всех секций отдельными файлами Word в одном архиве (для рассылки кураторам)
    if (p === "/api/programs.zip" && req.method === "GET") {
      if (!me.admin) return send(res, 403, { error: "Архив программ скачивает оператор" });
      const files = JSON.parse(sections()).map((s) => [
        "Программа секции " + String(s.num).padStart(2, "0") + ".docx", programDocx([s], state),
      ]);
      res.writeHead(200, {
        "Content-Type": "application/zip",
        "Content-Disposition": "attachment; filename*=UTF-8''" + encodeURIComponent("Программы секций.zip"),
        "Cache-Control": "no-store",
      });
      return res.end(zip(files));
    }
    if (p === "/api/program.docx" && req.method === "GET") {
      const want = url.searchParams.get("sec");
      const secs = JSON.parse(sections()).filter((s) => canSee(me, s.num) && (!want || want === "all" || String(s.num) === want));
      if (!secs.length) return send(res, 404, { error: "Нет такой секции" });
      const buf = programDocx(secs, state);
      const fname = want && want !== "all" ? "Программа секции " + want + ".docx" : "Программа секций.docx";
      res.writeHead(200, {
        "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Content-Disposition": "attachment; filename*=UTF-8''" + encodeURIComponent(fname),
        "Cache-Control": "no-store",
      });
      return res.end(buf);
    }
    send(res, 404, { error: "not found" });
  } catch (e) {
    console.error(e);
    send(res, 500, { error: "server error" });
  }
});

loadMarks()
  .catch((e) => console.error("Не удалось загрузить отметки:", e.message))
  .finally(() => server.listen(PORT, () => console.log("listening on " + PORT + ", экспертов: " + EXPERTS.size)));
