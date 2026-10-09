# 06 · รูปแบบไฟล์ภาพ

## ข้อบังคับ (compiler ตรวจ ถ้าผิดจะ build ไม่ผ่าน)

| ข้อ | ค่า | error ถ้าผิด |
|---|---|---|
| ชนิดไฟล์ | PNG | `png.decode` |
| ความลึกสี | **8 bit ต่อช่อง** (ไม่ใช่ 16 bit) | `png.depth` |
| ช่องสี | **RGBA** (มี alpha จริง ไม่ใช่ RGB บนพื้นสีขาวหรือดำ) | `png.no-alpha` |
| ขนาด | **256 × 256** พอดี | `png.size` |
| เนื้อหา | ต้องมี pixel ที่มองเห็นอย่างน้อย 1 จุด (ภาพว่างเปล่าห้ามส่ง ให้ละไฟล์นั้นแทน) | `png.blank` |
| ขอบผ้าใบ | ห้ามมีพื้นหลัง: ถ้าขอบผ้าใบไม่โปร่งใสเกินครึ่ง จะถือว่าติด matte | `png.matte` |
| ขอบผ้าใบ (เตือน) | มี pixel ไม่โปร่งใสแตะขอบ | `png.touches-border` (warning) |

## สีและความโปร่งใส

- **สี:** sRGB (export แบบ "sRGB" หรือ "Web"). engine ไม่แปลงสี ค่าในไฟล์คือค่าที่แสดง
- **alpha แบบ straight (ไม่ premultiply):** ค่า RGB คือสีจริงของ pixel ไม่ได้คูณ alpha ไว้ก่อน (export PNG ปกติจากโปรแกรมทั่วไปเป็นแบบนี้อยู่แล้ว)
- **ขอบนุ่ม (anti-aliasing):** ทำได้และควรทำ ขอบที่ alpha ไล่จาก 255 ลง 0 ราว 1–2 px ทำให้ภาพเนียนเมื่อย่อ
- **ห้ามขอบเป็นสีขาวหรือดำ (halo):** pixel ขอบที่โปร่งแสงครึ่งหนึ่งต้องมีสีของวัตถุ ไม่ใช่สีพื้นหลังเดิม อาการนี้มักเกิดเมื่อลบพื้นขาวด้วย magic wand หรือ export จากภาพที่ flatten บนพื้นขาวมาแล้ว
- **ส่วนโปร่งแสงตั้งใจ:** ทำได้ เช่นกระบังหน้า ผ้าบาง แก้ว (alpha 30–80%) engine ซ้อนชั้นแบบ alpha ถูกต้องทุกโหมด
- **ห้ามใช้ blend mode พิเศษ:** multiply, screen, add หรือ glow ไม่มีผลใน engine ทุกอย่างต้อง flatten เป็นสีปกติต่อ layer ก่อน export

## สไตล์และการกรองภาพ

| สไตล์ | ตั้งค่า `filter` | หมายเหตุ |
|---|---|---|
| ภาพวาดหรือ HD cutout (ขอบเนียน) | `linear` (ค่าตัวต้นแบบ) | ย่อแล้วเนียน มี mipmap สำหรับตัวที่อยู่ไกล |
| pixel art จริง (1 pixel = 1 จุดคม) | `nearest` | ห้ามมี anti-aliasing ที่ขอบ ต้องวาดที่สเกลจริง 1:1 |

บอกผมว่าจะใช้สไตล์ไหน ทุก item ในกลุ่ม atlas เดียวกันต้องใช้ค่าเดียวกัน

## สิ่งที่ห้ามติดมาในไฟล์

- พื้นหลัง กรอบ ลายน้ำ ลายเซ็น ข้อความ
- เส้นนำทางจาก `templates/` (ต้องปิดก่อน export)
- เงาบนพื้น (engine วาดให้เอง)
- ชิ้นของ layer อื่น เช่นมือติดมาในภาพอาวุธ หรือผมติดมาในภาพหัว (ยกเว้นตามที่ 05 อนุญาต)
- ICC profile แปลกๆ หรือ color space อื่น (เช่น Display P3 / Adobe RGB) ให้แปลงเป็น sRGB ก่อน

## เคล็ดลับ export (โปรแกรมทั่วไป)

- **Photoshop:** Export As → PNG, Transparency ✔, Convert to sRGB ✔, ขนาด 100%, ไม่ trim
- **Krita / Clip Studio:** export PNG 8-bit RGBA, ไม่ crop to content
- **Aseprite (pixel art):** export ขนาด 1:1 ไม่ scale
- **Blender (render เป็นภาพ):** Film → Transparent ✔, RGBA 8-bit, Color Management = Standard (ไม่ใช่ Filmic/AgX), กล้อง orthographic ที่ให้สเกล 128 px = 1 m และ foot pivot ตรง (128, 228)
