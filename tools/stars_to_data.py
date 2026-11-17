# 真實星空：肉眼可見（6 等以內）的恆星 → model/stars.bin
#
# 資料：tools/data/stars.6.json（d3-celestial 套件的 data/stars.6.json，BSD-3-Clause；原始資料為 ESA Hipparcos 星表），
#   GeoJSON：coordinates = [赤經（度，-180～180）, 赤緯（度）]，properties.mag 星等、bv 色指數（B−V）。
# 檔案格式：'NKST'、數量，每顆 [赤經 × 100（int16，度）、赤緯 × 100（int16，度）、(星等 + 2) × 20（uint8）、B−V × 50（int8）]
# 網頁（js/env.js）依高雄經緯度與當下時間（恆星時）把赤道座標轉成天空中的位置，星空會隨時間轉動。
# 用法：python3 tools/stars_to_data.py
import json, os, struct
ROOT = os.path.join(os.path.dirname(__file__), '..')
d = json.load(open(os.path.join(ROOT, 'tools/data/stars.6.json'), encoding='utf-8'))
rows = []
for f in d['features']:
    ra, dec = f['geometry']['coordinates']; p = f['properties']
    try: bv = float(p.get('bv') or 0.6)
    except ValueError: bv = 0.6
    rows.append((round(ra * 100), round(dec * 100), max(0, min(255, round((p['mag'] + 2) * 20))), max(-127, min(127, round(bv * 50)))))
rows.sort(key=lambda r: r[2])                       # 亮的在前
out = bytearray(b'NKST') + struct.pack('<I', len(rows))
for r in rows: out += struct.pack('<hhBb', *r)
open(os.path.join(ROOT, 'model/stars.bin'), 'wb').write(out)
print('stars', len(rows), len(out), 'bytes')
