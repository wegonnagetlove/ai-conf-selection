#!/usr/bin/env python3
"""Синхронизация с порталом «Ломоносов» (confhub, мероприятие 10771).

1. Скачивает последнюю выгрузку заявок (ссылка из «Списка фоновых задач»; выгрузку
   нужно предварительно сформировать кнопкой «Экспортировать в XLS»).
2. Пересобирает site/data/sections.json (parse.py + build.py).
3. Для каждого доклада берёт имя файла тезисов из выгрузки (колонки 30 и 34) и, если файла
   ещё нет на сайте или автор загрузил новый (имя файла изменилось), скачивает его,
   переводит в PDF и кладёт в files/<ключ>.pdf. Сопоставление «доклад → имя файла»
   хранится в site/data/thesis_files.json.

    python3 scripts/sync_confhub.py [--export URL]
"""
import json
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FILES = ROOT / "files"
SECTIONS = ROOT / "site" / "data" / "sections.json"
MAP = ROOT / "site" / "data" / "thesis_files.json"
CHANGES = ROOT / "site" / "data" / "changes.json"
BASE = "https://confhub.ru"
EXPORT = BASE + "/tmp/request_list_event_10771_85c7a44daccbf912f5c22101a53ebdc1.zip"
UA = {"User-Agent": "Mozilla/5.0 (ai-conf-selection sync)"}


def get(url, dest):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=120) as r, open(dest, "wb") as f:
        shutil.copyfileobj(r, f)


def norm_text(p):
    try:
        t = subprocess.run(["pdftotext", str(p), "-"], capture_output=True, text=True, timeout=60).stdout
    except Exception:
        return ""
    return re.sub(r"\W+", " ", t.lower().replace("ё", "е")).strip()


def main():
    export = EXPORT
    old = {r["key"]: dict(r, sec=sec["num"]) for sec in json.loads(SECTIONS.read_text(encoding="utf-8"))
           for r in sec["reports"]} if SECTIONS.exists() else {}
    if "--export" in sys.argv:
        export = sys.argv[sys.argv.index("--export") + 1]
    tmp = Path(tempfile.mkdtemp())
    get(export, tmp / "export.zip")
    with zipfile.ZipFile(tmp / "export.zip") as z:
        xls = [n for n in z.namelist() if n.lower().endswith(".xls")][0]
        z.extract(xls, tmp)
    subprocess.run([sys.executable, str(ROOT / "scripts" / "parse.py"), str(tmp / xls)], cwd=ROOT, check=True,
                   stdout=subprocess.DEVNULL)
    b = subprocess.run([sys.executable, str(ROOT / "scripts" / "build.py")], cwd=ROOT, check=True, capture_output=True, text=True)
    print("\n".join(x for x in b.stdout.splitlines() if x.startswith(("columns", "headers"))))

    sections = json.loads(SECTIONS.read_text(encoding="utf-8"))
    keys = {r["key"] for s in sections for r in s["reports"]}
    rows = json.loads((ROOT / "rows.json").read_text(encoding="utf-8"))
    wanted = {}
    for r in rows[1:]:
        for col, n in ((30, 1), (34, 2)):
            name = (r[col] if len(r) > col else "").strip()
            key = f"{r[0]}-{n}"
            if name and key in keys and re.fullmatch(r"[\w.-]+", name):
                wanted[key] = name

    # второй доклад с тем же названием, что и первый, и без своего файла: тезисы общие
    titles = {r["key"]: r["title"].strip().lower() for s in sections for r in s["reports"]}
    for k in keys:
        if k.endswith("-2") and k not in wanted:
            k1 = k[:-2] + "-1"
            if k1 in wanted and titles.get(k) == titles.get(k1):
                wanted[k] = wanted[k1]

    known = json.loads(MAP.read_text(encoding="utf-8")) if MAP.exists() else {}
    todo = {k: v for k, v in wanted.items() if known.get(k) != v or not (FILES / f"{k}.pdf").exists()}
    dl = tmp / "dl"
    out = tmp / "pdf"
    dl.mkdir()
    out.mkdir()
    failed = []
    src_by_key = {}
    for k, name in sorted(todo.items()):
        ext = Path(name).suffix.lower()
        dest = dl / f"{k}{ext}"
        try:
            get(f"{BASE}/file/uploaded/10771/{name}", dest)
            src_by_key[k] = dest
        except Exception as e:
            failed.append(f"{k}: не скачан ({e})")
    # одним вызовом LibreOffice переводим все не-PDF в PDF
    conv = [str(p) for p in src_by_key.values() if p.suffix.lower() != ".pdf"]
    for i in range(0, len(conv), 40):
        subprocess.run(["soffice", "--headless", "--convert-to", "pdf", "--outdir", str(out), *conv[i:i + 40]],
                       capture_output=True, timeout=1800)
    FILES.mkdir(exist_ok=True)
    added, replaced, same = [], [], []
    for k, src in src_by_key.items():
        pdf = src if src.suffix.lower() == ".pdf" else out / f"{k}.pdf"
        if not pdf.exists():
            failed.append(f"{k}: не удалось перевести в PDF")
            continue
        target = FILES / f"{k}.pdf"
        if target.exists():
            # файл уже был: заменяем, только если изменилось содержание
            if norm_text(target) == norm_text(pdf):
                same.append(k)
            else:
                shutil.copyfile(pdf, target)
                replaced.append(k)
        else:
            shutil.copyfile(pdf, target)
            added.append(k)
        known[k] = todo[k]
    for k in list(known):
        if k not in keys:
            known.pop(k)
    MAP.write_text(json.dumps(dict(sorted(known.items())), ensure_ascii=False, indent=1), encoding="utf-8")
    # отметки pdf и число страниц
    subprocess.run([sys.executable, str(ROOT / "scripts" / "attach_pdfs.py")], cwd=ROOT, check=True)

    # журнал изменений: что поменялось в заявках с прошлой синхронизации
    new = {r["key"]: dict(r, sec=sec["num"]) for sec in json.loads(SECTIONS.read_text(encoding="utf-8"))
           for r in sec["reports"]}
    labels = {"sec": "секция", "title": "название", "kind": "форма доклада", "fmt": "формат участия",
              "problem": "проблема", "name": "ФИО", "org": "организация", "level": "уровень",
              "coauthors": "соавторы", "city": "город", "faculty": "факультет", "sno": "СНО"}
    stamp = __import__("datetime").datetime.now(__import__("zoneinfo").ZoneInfo("Europe/Moscow")).strftime("%Y-%m-%d %H:%M")
    entries = []
    if old:
        for k, r in new.items():
            if k not in old:
                entries.append({"key": k, "type": "added", "sec": r["sec"], "name": r["name"]})
                continue
            f = [labels[x] for x in labels if old[k].get(x) != r.get(x)]
            if k in replaced:
                f.append("файл тезисов")
            if f:
                e = {"key": k, "type": "changed", "sec": r["sec"], "name": r["name"], "fields": f}
                if old[k].get("sec") != r["sec"]:
                    e["from_sec"] = old[k].get("sec")
                if old[k].get("title") != r.get("title"):
                    e["old_title"] = old[k].get("title")
                entries.append(e)
        for k, r in old.items():
            if k not in new:
                entries.append({"key": k, "type": "removed", "sec": r["sec"], "name": r["name"]})
    for k in added:
        if not any(e["key"] == k for e in entries):
            entries.append({"key": k, "type": "changed", "sec": new[k]["sec"], "name": new[k]["name"], "fields": ["файл тезисов"]})
    if entries:
        log = json.loads(CHANGES.read_text(encoding="utf-8")) if CHANGES.exists() else []
        log = [dict(e, at=stamp) for e in entries] + log
        CHANGES.write_text(json.dumps(log, ensure_ascii=False, indent=1), encoding="utf-8")
    ch = [e for e in entries if e["type"] == "changed"]

    late_p = ROOT / "site" / "data" / "late.json"
    late = json.loads(late_p.read_text(encoding="utf-8")) if late_p.exists() else []
    no_file = sorted(k for k in keys if k not in wanted)
    total = len(keys)
    with_pdf = sum(1 for k in keys if (FILES / f"{k}.pdf").exists())
    lines = [
        f"Докладов: {total}, с PDF тезисов: {with_pdf}",
        f"Новых PDF: {len(added)}" + (f" ({', '.join(added)})" if added else ""),
        f"Заменено (автор загрузил новую версию): {len(replaced)}" + (f" ({', '.join(replaced)})" if replaced else ""),
        f"Проверено без изменений: {len(same)}",
        f"Без файла на портале: {len(no_file)}" + (f" ({', '.join(no_file)})" if no_file else ""),
    ] + [f"Не добавлены, поданы после дедлайна 20.11: {len(late)}" + "".join(f"\n  {x['rid']} (секция {x['sec']}, {x['name']})" for x in late)
    ] + [f"Изменено в заявках: {len(ch)}" + ("".join(f"\n  {e['key']} (секция {e['sec']}, {e['name']}): {', '.join(e['fields'])}" for e in ch))] + failed
    print("\n".join(lines))
    summary = Path(__import__("os").environ.get("GITHUB_STEP_SUMMARY", "/dev/null"))
    with open(summary, "a", encoding="utf-8") as f:
        f.write("\n".join("- " + x for x in lines) + "\n")


if __name__ == "__main__":
    main()
