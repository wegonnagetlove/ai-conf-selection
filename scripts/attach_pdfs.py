#!/usr/bin/env python3
"""Раскладывает PDF тезисов по докладам: files/<номер заявки>-<1|2>.pdf и отметка pdf в sections.json.

Источник: архив confhub («Сформировать архив» на странице заявок мероприятия 10771) или папка
с файлами. Номер заявки ищется в пути и имени файла; если у автора два доклада, файл
сопоставляется с докладом по совпадению слов названия с текстом первых страниц PDF.
Документы Word (.doc, .docx, .rtf, .odt) переводятся в PDF через LibreOffice.

    python3 scripts/attach_pdfs.py путь/к/архиву.zip      # или путь/к/папке
    python3 scripts/attach_pdfs.py --map 1815415-1=путь/к/файлу.pdf   # вручную
"""
import json
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SECTIONS = ROOT / "site" / "data" / "sections.json"
FILES = ROOT / "files"
DOCS = {".pdf", ".doc", ".docx", ".rtf", ".odt"}


def words(t):
    return {w for w in re.findall(r"[a-zа-яё0-9]{4,}", (t or "").lower().replace("ё", "е"))}


def pdf_text(p, pages=2):
    try:
        return subprocess.run(["pdftotext", "-l", str(pages), str(p), "-"], capture_output=True, text=True, timeout=60).stdout
    except Exception:
        return ""


def pdf_pages(p):
    try:
        out = subprocess.run(["pdfinfo", str(p)], capture_output=True, text=True, timeout=30).stdout
        m = re.search(r"Pages:\s+(\d+)", out)
        return int(m.group(1)) if m else None
    except Exception:
        return None


def to_pdf(src, tmp):
    if src.suffix.lower() == ".pdf":
        return src
    subprocess.run(["soffice", "--headless", "--convert-to", "pdf", "--outdir", str(tmp), str(src)],
                   capture_output=True, timeout=180)
    out = Path(tmp) / (src.stem + ".pdf")
    return out if out.exists() else None


def collect(src, tmp):
    src = Path(src)
    if src.is_file() and src.suffix.lower() == ".zip":
        root = Path(tmp) / "unzip"
        with zipfile.ZipFile(src) as z:
            for info in z.infolist():
                # имена в архивах из Windows часто в cp866
                name = info.filename
                if not info.flag_bits & 0x800:
                    try:
                        name = name.encode("cp437").decode("cp866")
                    except Exception:
                        pass
                target = root / name
                if info.is_dir():
                    continue
                target.parent.mkdir(parents=True, exist_ok=True)
                with z.open(info) as f, open(target, "wb") as o:
                    shutil.copyfileobj(f, o)
        src = root
    files = [p for p in src.rglob("*") if p.is_file() and p.suffix.lower() in DOCS]
    nested = [p for p in src.rglob("*.zip")] if src.is_dir() else []
    for z in nested:
        files += collect(z, tempfile.mkdtemp(dir=tmp))
    return files


def main():
    sections = json.loads(SECTIONS.read_text(encoding="utf-8"))
    reports = {r["key"]: r for s in sections for r in s["reports"]}
    by_rid = {}
    for r in reports.values():
        by_rid.setdefault(r["rid"], []).append(r)
    FILES.mkdir(exist_ok=True)
    tmp = tempfile.mkdtemp()
    manual, sources = {}, []
    args = sys.argv[1:]
    while args:
        a = args.pop(0)
        if a == "--map":
            k, v = args.pop(0).split("=", 1)
            manual[k] = Path(v)
        else:
            sources.append(a)

    assigned, unmatched = {}, []
    for k, f in manual.items():
        assigned[k] = f
    for src in sources:
        files = collect(src, tmp)
        print(f"{src}: документов {len(files)}")
        per_rid = {}
        for f in files:
            rel = str(f)
            rids = [rid for rid in by_rid if re.search(rf"(?<!\d){rid}(?!\d)", rel)]
            if not rids:
                unmatched.append(f)
                continue
            per_rid.setdefault(max(rids, key=len), []).append(f)
        for rid, fs in per_rid.items():
            reps = sorted(by_rid[rid], key=lambda r: r["n"])
            pdfs = [p for p in (to_pdf(f, tmp) for f in fs) if p]
            if len(reps) == 1:
                best = max(pdfs, key=lambda p: len(words(reps[0]["title"]) & words(pdf_text(p))))
                assigned.setdefault(reps[0]["key"], best)
                continue
            # два доклада: каждому файл с наибольшим совпадением слов названия
            free = list(pdfs)
            for r in sorted(reps, key=lambda r: -len(words(r["title"]))):
                if not free:
                    break
                best = max(free, key=lambda p: len(words(r["title"]) & words(pdf_text(p))))
                assigned.setdefault(r["key"], best)
                free.remove(best)

    for key, f in assigned.items():
        f = to_pdf(Path(f), tmp) if Path(f).suffix.lower() != ".pdf" else Path(f)
        if not f:
            print(f"не удалось перевести в PDF: {key}")
            continue
        shutil.copyfile(f, FILES / f"{key}.pdf")

    n = 0
    for r in reports.values():
        p = FILES / f"{r['key']}.pdf"
        if p.exists():
            r["pdf"] = True
            r["pages"] = pdf_pages(p)
            n += 1
        else:
            r.pop("pdf", None)
            r.pop("pages", None)
    SECTIONS.write_text(json.dumps(sections, ensure_ascii=False, indent=1), encoding="utf-8")
    missing = [k for k in reports if not (FILES / f"{k}.pdf").exists()]
    print(f"с PDF: {n} из {len(reports)}")
    if unmatched:
        print("файлы без номера заявки (разложить через --map):")
        for f in unmatched:
            print("  ", f)
    if missing:
        print("доклады без PDF:", ", ".join(missing))


if __name__ == "__main__":
    main()
