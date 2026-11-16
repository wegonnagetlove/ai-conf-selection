#!/usr/bin/env python3
"""Считает знаки с пробелами в тезисах (files/<ключ>.pdf) и пишет поле chars в sections.json.

Лимит конференции 5000 знаков с пробелами вместе со списком литературы. Подсчёт по тексту PDF
приблизительный (переносы и колонтитулы), поэтому на сайте он показан как «≈».
"""
import json
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SECTIONS = ROOT / "site" / "data" / "sections.json"
FILES = ROOT / "files"


def chars(p):
    try:
        t = subprocess.run(["pdftotext", "-enc", "UTF-8", str(p), "-"], capture_output=True, text=True, timeout=60).stdout
    except Exception:
        return None
    t = re.sub(r"-\n(?=[а-яёa-z])", "", t)          # переносы слов
    t = re.sub(r"[ \t ]+", " ", t)
    t = re.sub(r"\s*\n\s*", " ", t).strip()
    return len(t) or None


secs = json.loads(SECTIONS.read_text(encoding="utf-8"))
n = 0
for s in secs:
    for r in s["reports"]:
        f = FILES / (r["key"] + ".pdf")
        if f.exists():
            c = chars(f)
            if c:
                r["chars"] = c
                n += 1
        else:
            r.pop("chars", None)
SECTIONS.write_text(json.dumps(secs, ensure_ascii=False, indent=1), encoding="utf-8")
print("знаков посчитано:", n)
