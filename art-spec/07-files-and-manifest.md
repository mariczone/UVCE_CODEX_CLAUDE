# 07 · โครงสร้างไฟล์และ manifest

## วางไฟล์ไว้ที่ไหน

แนะนำให้วางไว้ที่ `art-input/<ชื่อตัวละคร>/` ที่ root ของ repo (เช่น `art-input/knight/`) แล้วบอกผม
ข้างในใช้โครงสร้างแบบนี้:

```text
art-input/knight/
├─ source-manifest.json              ← คำอธิบายทุกไฟล์ (ผมเขียนให้ได้ ดูด้านล่าง)
├─ body_base/
│  ├─ body/
│  │  ├─ idle/S/000.png … 007.png    ← 8 ทิศ × 8 เฟรม
│  │  ├─ idle/SE/000.png …
│  │  └─ walk/<DIR>/000.png … 007.png
│  └─ arm_front/
│     ├─ idle/SE/000.png …           ← ไม่มี S และ N
│     └─ walk/<DIR>/…
├─ head_base/head/static/S.png, SE.png, E.png, NE.png, N.png, NW.png, W.png, SW.png
├─ hair_01/hair_back/static/<DIR>.png        ← 8 ทิศ
├─ hair_01/hair_front/static/<DIR>.png       ← S SE E SW W
├─ armor_01/armor/static/<DIR>.png
├─ hat_01/hat/static/<DIR>.png
└─ weapon_01/weapon/static/<DIR>.png
```

## กฎการตั้งชื่อ

- **id ของ item** (ชื่อโฟลเดอร์ระดับแรก): ตัวพิมพ์เล็ก `a-z 0-9 _ -` ขึ้นต้นด้วยตัวอักษรหรือตัวเลข เช่น `armor_04`, `hat_wizard`
- **ชื่อ layer** ต้องตรงกับ 03 ทุกตัวอักษร: `body`, `arm_front`, `head`, `hair_back`, `hair_front`, `armor`, `hat`, `weapon`
- **ทิศ** ใช้ตัวพิมพ์ใหญ่: `N NE E SE S SW W NW`
- **เลขเฟรม** 3 หลักเริ่มจาก 0: `000.png` … `007.png`
- path ห้ามมีช่องว่าง ภาษาไทย หรืออักขระพิเศษ (compiler บังคับรูปแบบ `[A-Za-z0-9_-]` ต่อส่วน)
- **ถ้าอยากดูผลในแอปทันทีโดยไม่ต้องแก้โค้ด:** ใช้ id เดียวกับตัวต้นแบบ (`body_base`, `head_base`, `hair_01`, `armor_01`, `hat_01`, `weapon_01`) เพราะ hero ในแอปผูกกับ id พวกนี้ ส่วน crowd ใช้ item ทุกชิ้นตาม slot อยู่แล้ว

## ไฟล์ source-manifest.json

manifest บอก compiler ว่าแต่ละไฟล์คือชิ้นอะไร ทิศไหน เฟรมไหน และ socket อยู่ตรงไหน
ตัวอย่างที่ **ผ่าน validator จริง** อยู่ที่ `templates/source-manifest.example.json` (6 item, ทิศ S และ SE)

**ไม่ต้องเขียน manifest เองก็ได้:** ส่งแค่ไฟล์ภาพตามโครงสร้างข้างบน พร้อมตาราง socket (ด้านล่าง) ผมจะสร้าง manifest ให้

### โครงสร้างหลัก

```json
{
  "schemaVersion": "uvce-source-manifest-v1",
  "rigs":  [ /* rig humanoid_2d_v1: ผ้าใบ, foot pivot, layers, slots, socket ท่าพัก, ลำดับชั้นต่อทิศ */ ],
  "clips": [ /* idle และ walk: เวลาต่อเฟรม */ ],
  "items": [ /* หนึ่ง entry ต่อ item */ ],
  "aliases": {}
}
```

### item แบบภาพนิ่ง (เช่นหมวก)

```json
{
  "id": "hat_01", "version": "1", "slot": "hat", "rigProfileId": "humanoid_2d_v1",
  "displayName": "Hat 1 (straw)", "filter": "linear",
  "parts": [{
    "layer": "hat", "attach": "head_top", "representation": "FRAME", "allowMirror": false,
    "static": {
      "S":  { "file": "hat_01/hat/static/S.png",  "anchor": { "x": 128, "y": 47 } },
      "SE": { "file": "hat_01/hat/static/SE.png", "anchor": { "x": 130, "y": 47 } }
    }
  }]
}
```

- `anchor` = จุดบนผ้าใบของภาพนี้ที่ต้องวางลงบน socket = **ตำแหน่ง socket ที่ชิ้นนี้เกาะ ในท่าพักของทิศนั้น** (ตารางใน 03)
- ถ้าวาดทับท่าพักพอดี anchor ก็คือค่าในตารางนั้นเลย ไม่ต้องวัดเอง

### item แบบเคลื่อนไหว (body)

```json
{
  "id": "body_base", "version": "1", "slot": "body", "rigProfileId": "humanoid_2d_v1",
  "displayName": "Base body", "filter": "linear", "atlasGroup": "core",
  "parts": [{
    "layer": "body", "attach": "root", "representation": "FRAME", "allowMirror": false,
    "clips": {
      "walk": {
        "SE": [
          { "file": "body_base/body/walk/SE/000.png",
            "sockets": { "head_top": { "x": 130, "y": 46 }, "neck": { "x": 129, "y": 103 }, "chest": { "x": 127, "y": 131 },
                         "right_hand": { "x": 103, "y": 149 }, "left_hand": { "x": 149, "y": 147 }, "back": { "x": 120, "y": 117 } } }
          /* … ต่ออีก 7 เฟรม รวม 8 */
        ]
      }
    }
  }]
}
```

- body เกาะ `root` จึง**ไม่ต้องมี anchor** (ใช้ foot pivot เอง)
- **ทุกเฟรม** ของ body ต้องมี `sockets` ครบ 6 จุด ส่วน `arm_front` อยู่ใน item เดียวกันแต่**ไม่มี sockets**
- ค่าทุกตัวเป็น**จำนวนเต็ม** (pixel)

## ส่งตำแหน่ง socket แบบง่าย (ถ้าไม่เขียน manifest เอง)

ส่งไฟล์ `sockets.csv` หนึ่งไฟล์ หนึ่งบรรทัดต่อเฟรมของ body:

```csv
clip,direction,frame,head_top_x,head_top_y,neck_x,neck_y,chest_x,chest_y,right_hand_x,right_hand_y,left_hand_x,left_hand_y,back_x,back_y
idle,S,0,128,47,128,104,128,132,97,150,159,150,128,118
idle,S,1,128,48,128,105,128,133,97,151,159,151,128,119
walk,SE,0,130,46,129,103,127,131,103,149,149,147,120,117
```

- รวม 8 ทิศ × 16 เฟรม = 128 บรรทัด แถว `idle,<DIR>,0` ทั้ง 8 แถวจะกลายเป็นตำแหน่งท่าพักของ rig
- อ่านพิกัดได้จากโปรแกรมวาด (ตำแหน่งเมาส์บนผ้าใบ 256² มุมซ้ายบน = 0,0)
- ถ้าสะดวกกว่า วาดจุดสี socket (สีตามตารางใน 03) เป็น layer แยกแล้วส่งมา ผมเขียนตัวอ่านจุดให้ได้ แจ้งก่อน
