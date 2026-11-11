import sys, json, xml.etree.ElementTree as ET
ns={'ss':'urn:schemas-microsoft-com:office:spreadsheet'}
t=ET.parse(sys.argv[1]).getroot()
rows=[]
for r in t.iter('{%s}Row'%ns['ss']):
    row=[]
    for c in r.findall('ss:Cell',ns):
        idx=c.get('{%s}Index'%ns['ss'])
        if idx:
            while len(row)<int(idx)-1: row.append('')
        d=c.find('ss:Data',ns)
        row.append(''.join(d.itertext()).strip() if d is not None else '')
    rows.append(row)
json.dump(rows,open('rows.json','w'),ensure_ascii=False)
h=rows[0]; print(len(rows)-1,'rows'); 
for i,x in enumerate(h): print(i,x)
