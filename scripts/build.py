import json,re,collections
rows=json.load(open('rows.json')); d=rows[1:]; H=[str(x).lower() for x in rows[0]]
g=lambda r,i: (r[i] if len(r)>i else '').strip()
NAMES={1:'ИИ в медицине и здравоохранении',2:'ИИ в точных и технических науках: разработка и валидация методов',3:'ИИ в науках о жизни и науках о Земле',4:'ИИ для медиа и креативных индустрий',5:'ИИ в лингвистике и переводе',6:'Право, судебная экспертиза и этика ИИ',7:'Человек и ИИ: социологические, психологические и философские аспекты',8:'Педагогические технологии и подготовка кадров в эпоху ИИ',9:'ИИ-инструменты сопровождения учебной и научной деятельности',10:'ИИ в инженерии: прикладные решения',11:'ИИ в цифровой экономике',12:'ИИ в автоматизации производства: машиностроение и сельское хозяйство',13:'ИИ в химии'}
SITES={10:'Саранск, МГУ имени Н.П. Огарёва',11:'Самара, СГЭУ',12:'Тамбов, ТГТУ',13:'Санкт-Петербург, ИТМО'}
def secnum(s):
    m=re.match(r'\s*(\d+)\.',s); return int(m.group(1)) if m else None
ids={g(r,0) for r in d}
co=collections.defaultdict(list)
for r in d:
    if g(r,6).startswith('Соавтор'): co[g(r,4)].append(g(r,3))
# возраст на день конференции (08.12.2026): в sections.json пишется только признак over35, сама дата рождения не попадает
import datetime
DOB=next((i for i,x in enumerate(H) if 'рожд' in x),None)
def over35(r):
    if DOB is None: return None
    m=re.search(r'(\d{1,2})[./-](\d{1,2})[./-](\d{4})|(\d{4})-(\d{2})-(\d{2})',g(r,DOB))
    if not m: return None
    dd,mm,yy=(m.group(1),m.group(2),m.group(3)) if m.group(1) else (m.group(6),m.group(5),m.group(4))
    try: b=datetime.date(int(yy),int(mm),int(dd))
    except ValueError: return None
    c=datetime.date(2026,12,8); age=c.year-b.year-((c.month,c.day)<(b.month,b.day))
    return age>35
def snt(x): return '' if x.lower() in ('-','нет','нет.','no','') else x
reports=[]
for r in d:
    if not g(r,27): continue
    base=dict(rid=g(r,0), name=g(r,3), org=g(r,21) or g(r,15), faculty=g(r,16), level=g(r,18),
              city=g(r,13), fmt=g(r,22), over35=over35(r), sno=snt(g(r,26)), problem=g(r,35), coauthors=co.get(g(r,0),[]))
    reports.append(dict(base, key=g(r,0)+'-1', sec=secnum(g(r,27)), kind=g(r,28), title=g(r,29), n=1))
    if g(r,31) and g(r,33):
        reports.append(dict(base, key=g(r,0)+'-2', sec=secnum(g(r,31)), kind=g(r,32), title=g(r,33), n=2))
listeners=[dict(rid=g(r,0),name=g(r,3),org=g(r,21) or g(r,15),level=g(r,18),city=g(r,13),fmt=g(r,23) or g(r,22)) for r in d if g(r,6)=='Участник-слушатель форума']
missing=[p for p in co if p not in ids]
print('reports',len(reports),'listeners',len(listeners),'parents missing',missing)
print(collections.Counter(x['sec'] for x in reports))
secs=[dict(num=n,name=NAMES[n],site=SITES.get(n,'Центральная площадка, МГУ'),reports=[x for x in reports if x['sec']==n]) for n in NAMES]
json.dump(secs,open('site/data/sections.json','w'),ensure_ascii=False,indent=1)
for s in secs: print(s['num'], len(json.dumps(s,ensure_ascii=False).encode()))
# отметки PDF тезисов (files/<ключ>.pdf) сохраняются при пересборке
import subprocess, sys as _s
subprocess.run([_s.executable, str(__import__('pathlib').Path(__file__).with_name('attach_pdfs.py'))])
subprocess.run([_s.executable, str(__import__('pathlib').Path(__file__).with_name('measure.py'))])
