# 圖片資料夾

把圖片用下列「固定檔名」上傳到這個資料夾，網頁重新整理後就會自動貼到模型上（檔名大小寫要一致）。

| 檔名 | 位置 |
|---|---|
| `led_se.jpg` | 東南角落地玻璃內的 LED 電視 |
| `led_nw.jpg` | 西北角落地玻璃內的 LED 電視 |
| `led_oh_n.jpg` | 歌劇院北側玻璃內的 LED 電視 |
| `stage_oh.jpg` | 歌劇院鏡框式舞台 |
| `stage_ph.jpg` | 戲劇院鏡框式舞台 |
| `parking_B1.png` | B1 地下停車場平面圖（電梯按 B1 時彈出） |
| `parking_B2.png` | B2 地下停車場平面圖（電梯按 B2 時彈出） |

LED 與舞台的貼圖位置在 `config/screens.json`，填好四個角點座標並把 `enabled` 改成 `true` 才會顯示。
