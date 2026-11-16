"use strict";
/*
 * Программа секций в Word (.docx) по шаблону из инструкции куратора.
 * Без внешних зависимостей: документ собирается из XML и упаковывается в zip вручную.
 */
const zlib = require("node:zlib");

// предварительная сетка центральной площадки из инструкции куратора
const GRID = { 1: "10:30–11:50", 2: "10:30–11:50", 3: "12:30–13:50", 4: "12:30–13:50", 5: "14:50–16:10", 6: "14:50–16:10", 7: "16:50–18:10", 8: "16:50–18:10", 9: "16:50–18:10" };
const DATE = "8 декабря 2026";
const TIMING = "Тайминг доклада с презентацией: 7 минут (до 3 минут на вопросы)";

const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const lines = (s) => String(s || "").split(/\r?\n/).map((x) => x.replace(/^[\s•\-–—]+/, "").trim()).filter(Boolean);

function run(text, o = {}) {
  const pr = (o.b ? "<w:b/><w:bCs/>" : "") + (o.i ? "<w:i/><w:iCs/>" : "");
  return `<w:r>${pr ? "<w:rPr>" + pr + "</w:rPr>" : ""}<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
}
function para(runs, o = {}) {
  const ppr = [];
  if (o.center) ppr.push('<w:jc w:val="center"/>');
  if (o.ind) ppr.push(`<w:ind w:left="${o.ind}"${o.hang ? ` w:hanging="${o.hang}"` : ""}/>`);
  ppr.push(`<w:spacing w:before="${o.before || 0}" w:after="${o.after == null ? 60 : o.after}"/>`);
  if (o.keep) ppr.push("<w:keepNext/>");
  if (o.pageBreak) ppr.push("<w:pageBreakBefore/>");
  return `<w:p><w:pPr>${ppr.join("")}</w:pPr>${Array.isArray(runs) ? runs.join("") : runs}</w:p>`;
}

function statusText(r) {
  const lv = String(r.level || "").trim();
  if (!lv) return "";
  if (/^Абитуриент/.test(lv)) return "школьник";
  return lv.replace(/^(\S+)/, (w) => w.toLowerCase());
}
function online(r, d) {
  if (d === "oral_on") return true;
  if (d === "oral_off" || d === "poster") return false;
  return /Докладчик \(дистанционно\)/.test(r.fmt || "") && !/Докладчик \(очно/.test(r.fmt || "");
}
function speaker(r, d) {
  const who = [r.name, ...(r.coauthors || [])].filter(Boolean).join(", ");
  const parts = [who, statusText(r), r.faculty, r.org].map((x) => String(x || "").trim()).filter(Boolean);
  return parts.join(", ") + (online(r, d) ? " (онлайн)" : "");
}

// порядок: сохранённый куратором, затем остальные по числу голосов «Выбран»
// так же сортирует панель куратора на сайте, поэтому порядок в файле совпадает с экраном
function ordered(list, order, votes) {
  const pos = new Map((order || []).map((k, i) => [k, i]));
  const idx = new Map(list.map((r, i) => [r.key, i]));
  return list.slice().sort((a, b) => {
    const pa = pos.has(a.key) ? pos.get(a.key) : 1e6, pb = pos.has(b.key) ? pos.get(b.key) : 1e6;
    return pa - pb || (votes[b.key] || 0) - (votes[a.key] || 0) || idx.get(a.key) - idx.get(b.key);
  });
}

function sectionXml(s, state, first) {
  const dec = state.decisions || {};
  const info = (state.secinfo || {})[String(s.num)] || {};
  const order = ((state.order || {})[String(s.num)] || {}).keys || [];
  const votes = {};
  for (const e of Object.values(state.experts || {})) for (const [k, p] of Object.entries(e.picks || {})) if (p && p.s === "yes") votes[k] = (votes[k] || 0) + 1;
  const d = (r) => (dec[r.key] || {}).d;
  const reps = s.reports || [];
  const oral = ordered(reps.filter((r) => d(r) === "oral_off" || d(r) === "oral_on"), order, votes);
  const poster = ordered(reps.filter((r) => d(r) === "poster"), order, votes);

  const out = [];
  const time = info.time || GRID[s.num] || "время уточняется";
  out.push(para(run(`${DATE}, ${time}`), { pageBreak: !first }));
  out.push(para(run(TIMING)));
  out.push(para(run(`Секция «${s.name}»`, { b: true }), { before: 120 }));
  out.push(para(run(info.hall || (s.num > 9 ? s.site : "Зал уточняется"))));
  out.push(para(run("Модератор:", { b: true }), { before: 120, keep: true }));
  (lines(info.moderator).length ? lines(info.moderator) : ["(указать)"]).forEach((x) => out.push(para(run(x), { ind: 360 })));
  out.push(para(run("Эксперты:", { b: true }), { before: 120, keep: true }));
  (lines(info.experts).length ? lines(info.experts) : ["(указать)"]).forEach((x) => out.push(para(run(x), { ind: 360 })));

  let n = 0;
  const block = (title, list) => {
    if (!list.length) return;
    out.push(para(run(title, { b: true }), { before: 160, keep: true }));
    list.forEach((r) => {
      n++;
      out.push(para([run(n + ".\t"), run(speaker(r, d(r)))], { ind: 425, hang: 425, after: 0, keep: true }));
      out.push(para(run(r.title || "", { i: true }), { ind: 425, after: 100 }));
    });
  };
  block("Доклады устные:", oral);
  block("Доклады постерные:", poster);
  if (!oral.length && !poster.length) out.push(para(run("Решения по докладам секции ещё не приняты.", { i: true }), { before: 160 }));
  return out.join("");
}

function documentXml(secs, state) {
  const body = secs.map((s, i) => sectionXml(s, state, i === 0)).join("");
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' + body +
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="850" w:bottom="1134" w:left="1418" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>' +
    "</w:body></w:document>";
}
const STYLES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr>' +
  '<w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman" w:eastAsia="Times New Roman"/><w:sz w:val="24"/><w:szCs w:val="24"/><w:lang w:val="ru-RU"/>' +
  '</w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="60" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>' +
  '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>';
const CT = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>';
const RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';
const DOC_RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>';

/* ---------- zip ---------- */
const CRC = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
function crc32(buf) { let c = -1; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function zip(files) {
  const local = [], central = []; let offset = 0;
  for (const [name, content] of files) {
    const nameBuf = Buffer.from(name, "utf8"), data = Buffer.from(content, "utf8");
    const comp = zlib.deflateRawSync(data), crc = crc32(data);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(8, 8);
    h.writeUInt32LE(0, 10); h.writeUInt32LE(crc, 14); h.writeUInt32LE(comp.length, 18); h.writeUInt32LE(data.length, 22);
    h.writeUInt16LE(nameBuf.length, 26); h.writeUInt16LE(0, 28);
    local.push(h, nameBuf, comp);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(8, 10);
    c.writeUInt32LE(0, 12); c.writeUInt32LE(crc, 16); c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(nameBuf.length, 28); c.writeUInt32LE(offset, 42);
    central.push(c, nameBuf);
    offset += h.length + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cd, end]);
}

function programDocx(secs, state) {
  return zip([
    ["[Content_Types].xml", CT],
    ["_rels/.rels", RELS],
    ["word/document.xml", documentXml(secs, state)],
    ["word/_rels/document.xml.rels", DOC_RELS],
    ["word/styles.xml", STYLES],
  ]);
}

module.exports = { programDocx, GRID };
