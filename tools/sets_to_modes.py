#!/usr/bin/env python3
"""把 Fusion 選取集（匯出時產生的 nkca_sets.json）同步到 config/modes.json 的隱藏清單。

用法：python3 tools/sets_to_modes.py ~/Documents/NKCA_data/nkca_sets.json

對應：
  MODE_A_CanopyHall_hide   → groups.canopyHide（樹冠大廳模式要隱藏的物件）
  MODE_B_BanyanPlaza_hide  → groups.plazaHide（榕樹廣場模式要隱藏的物件）
  AboveGround_hide         → groups.aboveGround（B1／B2 地下停車場模式要隱藏的物件）
  B1_hide                  → groups.b1Level（B1 樓層物件，B2 模式時隱藏）
  OH_2F/3F/4F_hide         → groups.oh2F／oh3F／oh4F（歌劇院樓層：看較低樓層時隱藏上方樓層）
選取集 ARCHIVE 的物件不會匯出（見 fusion_export_glb.py）。
在 Fusion 裡把新畫的室內物件加入（或移出）這兩個選取集，重新匯出後跑這支就好。
modes.json 其他內容（模式名稱、exclude、說明）不動。會列出新增／移除的物件名稱。
"""
import json, sys, os

MAP = {'MODE_A_CanopyHall_hide': 'canopyHide', 'MODE_B_BanyanPlaza_hide': 'plazaHide',
       'AboveGround_hide': 'aboveGround',   # 地下停車場模式（B1、B2）隱藏的地面以上物件
       'B1_hide': 'b1Level',                # B1 樓層本身（B2 模式時隱藏）
       'OH_2F_hide': 'oh2F', 'OH_3F_hide': 'oh3F', 'OH_4F_hide': 'oh4F'}   # 歌劇院各樓層
src = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser('~/Documents/NKCA_data/nkca_sets.json')
dst = os.path.join(os.path.dirname(__file__), '..', 'config', 'modes.json')

sets = json.load(open(src, encoding='utf8'))
modes = json.load(open(dst, encoding='utf8'))
groups = modes.setdefault('groups', {})
for s, g in MAP.items():
    if s not in sets:
        print(f'略過：nkca_sets.json 裡沒有選取集 {s}')
        continue
    new = ['=' + n for n in sorted(set(sets[s]))]
    old = groups.get(g, [])
    add = sorted(set(new) - set(old)); rem = sorted(set(old) - set(new))
    groups[g] = new
    print(f'{g}：{len(new)} 個物件（新增 {len(add)}、移除 {len(rem)}）')
    for n in add: print('  +', n[1:])
    for n in rem: print('  -', n[1:])
with open(dst, 'w', encoding='utf8') as f:
    json.dump(modes, f, ensure_ascii=False, indent=1)
    f.write('\n')
print('已寫入', os.path.normpath(dst))
