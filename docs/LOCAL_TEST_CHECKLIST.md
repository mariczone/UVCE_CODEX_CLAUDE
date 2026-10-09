# Local test checklist — UVCE Milestone 0–2

รายการเดียวจบสำหรับรันบนเครื่องตัวเอง ทำตามลำดับ 0 → 4 ได้เลย (รวมประมาณ 45–60 นาที ส่วนใหญ่เป็นเวลารอ benchmark)

ทุกอย่างในข้อ 1 ผ่านแล้วใน cloud container (ผลจริงอยู่ใน [`UVCE_MILESTONE_1_2_REPORT.md`](UVCE_MILESTONE_1_2_REPORT.md))
สิ่งที่ยังต้องใช้เครื่องคุณมีแค่สามอย่าง:

1. ยืนยันว่า checkout ใหม่บนเครื่องคุณผ่านเหมือนกัน
2. **benchmark บน GPU จริง** — container ไม่มี GPU ตัวเลขทั้งหมดที่มีตอนนี้มาจาก SwiftShader ซึ่งเป็น software rasterizer
3. ตรวจด้วยตาในเบราว์เซอร์จริง

## 0. เตรียมเครื่อง (ทำครั้งเดียว)

| ต้องมี | ตรวจด้วยคำสั่ง | ค่าที่ควรได้ |
|---|---|---|
| Node.js ≥ 22.18 (แนะนำ 22.22.0 ตาม `.nvmrc`) | `node --version` | `v22.22.0` หรือ 22.x ที่ ≥ 22.18 |
| pnpm 10 | `corepack enable` แล้ว `pnpm --version` | `10.28.0` |
| Python 3 + Pillow (ใช้เฉพาะ `pnpm fixtures:legacy:validate`) | `python3 -c "import PIL; print(PIL.__version__)"` | เลขเวอร์ชันใดก็ได้ (Windows ใช้ `python` หรือ `py` แทน `python3`) |

```bash
git fetch origin claude/nifty-thompson-7t015u
git checkout claude/nifty-thompson-7t015u
git pull
pnpm install --frozen-lockfile
pnpm exec playwright install chromium   # ครั้งแรกเท่านั้น: Chromium ของ Playwright 1.56.1 (build 1194)
```

## 1. Automated tests (ไม่ต้องใช้ GPU) — copy ทั้งก้อนไปรันได้เลย

```bash
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm fixtures:legacy:validate
```

| คำสั่ง | ผลที่ควรได้ | เวลาโดยประมาณ |
|---|---|---|
| `pnpm typecheck` | ไม่มี output และ exit code 0 | ~10 วินาที |
| `pnpm test` | `Test Files  10 passed (10)` และ `Tests  94 passed (94)` | ~20 วินาที |
| `pnpm test:e2e` | build ก่อน แล้วขึ้น `22 passed` และมีบรรทัด `[storm] 2400 slot changes: ... binding violations 0 ...` | ~1 นาที |
| `pnpm fixtures:legacy:validate` | `PASS: 15 assets, 8 directions, 8 frames, 8 RGBA compositing goldens` | ไม่กี่วินาที |

หมายเหตุ

- `test:e2e` บังคับใช้ SwiftShader โดยตั้งใจ (ดู `playwright.config.ts`) ผล parity จึงต้องเหมือนใน cloud ทุก pixel ไม่ว่าเครื่องจะมี GPU รุ่นไหน ถ้าข้อนี้ fail แปลว่ามีอะไรผิดจริง ไม่ใช่เพราะ GPU ต่างกัน
- ถ้าพอร์ต 4173 ถูกใช้อยู่ e2e จะ start ไม่ได้ ให้ปิดโปรแกรมที่ใช้พอร์ตนั้นก่อน (`pnpm preview` ที่เปิดค้างไว้ก็นับ)
- ถ้า `playwright install` ดาวน์โหลดไม่ได้ ให้ส่ง error กลับมา (อย่าอัปเกรด Playwright เอง เพราะเวอร์ชันถูก pin ให้ตรงกับ Chromium build 1194)
- Windows: script `fixtures:legacy:validate` เรียก `python3` ซึ่งบางเครื่องไม่มี ให้รัน `python tools/validate_fixture_assets.py assets/fixtures` (หรือ `py ...`) แทนได้เลย ผลต้องเหมือนกัน

## 2. Benchmark บน GPU จริง (เป็นสิ่งเดียวที่ทำใน cloud ไม่ได้)

ก่อนรัน: ปิดแอปหนักๆ ทั้งหมด ถ้าเป็น laptop ให้เสียบสายชาร์จและตั้ง power mode เป็น performance แล้วอย่าใช้เครื่องระหว่างรัน
ให้แทน `<date>` ด้วยวันที่ (เช่น `2026-10-12`) และ `<gpu>` ด้วยชื่อสั้นๆ ของ GPU (เช่น `rtx3060` หรือ `m2pro`)

```bash
pnpm build
pnpm bench:baseline -- --gpu --out docs/benchmark-results/gpu/<date>-<gpu>
pnpm bench:baseline -- --gpu --query "&mips=0" --out docs/benchmark-results/gpu/<date>-<gpu>-nomips
pnpm bench:stages -- --gpu --out docs/benchmark-results/gpu/<date>-<gpu>/stages.json
```

| คำสั่ง | ได้อะไร | เวลา |
|---|---|---|
| `bench:baseline --gpu` | `summary.json`, `summary.csv` และ `scene-1/20/100/300.png` สำหรับฉาก 1/20/100/300 ตัว | ~5 นาที |
| `bench:baseline --gpu --query "&mips=0"` | ชุดเดียวกันแต่ปิด mip chain เพื่อวัดว่า mipmap มีต้นทุนบน GPU จริงเท่าไร | ~5 นาที |
| `bench:stages --gpu` | เวลาแยกตามขั้น (pump / world / prepare / submit / raster) ทั้งแบบเต็มจอและแบบ scissor 1 px | ~5–10 นาที |

**สิ่งที่ต้องเช็คหลังรัน (สำคัญมาก):** เปิด `summary.json` แล้วดู `environment.glRenderer`
หรือดูบรรทัด `[bench:stages] GL renderer: ...` ใน terminal

- ถ้ามีชื่อ GPU จริง (เช่น `ANGLE (NVIDIA ...)`, `Apple M2 ...`, `Intel(R) Iris ...`) แปลว่าใช้ได้
- ถ้ามีคำว่า `SwiftShader` แปลว่า headless Chromium ไม่ได้ใช้ GPU ให้รันใหม่โดยเพิ่ม `--headed` (จะมีหน้าต่าง browser เด้งขึ้นมา ปล่อยไว้อย่าไปยุ่งกับมัน)

ข้อนี้ไม่บังคับ: ถ้าอยากเทียบกับ M0 บน GPU เดียวกัน ให้ build M0 แยกไว้อีก folder แล้วรันแบบ A/B

```bash
git worktree add ../uvce-m0 3db7a20
(cd ../uvce-m0 && pnpm install --frozen-lockfile && pnpm build)
pnpm bench:stages -- --gpu --compare ../uvce-m0/dist --out docs/benchmark-results/gpu/<date>-<gpu>/stages-vs-m0.json
```

## 3. ตรวจด้วยตาในเบราว์เซอร์ (~10–15 นาที)

```bash
pnpm dev     # สร้าง fixtures + assets ก่อน (~5 วินาที) แล้วเปิด http://localhost:5173
```

ใช้ Chrome หรือ Edge (เป็นตัวหลักที่ทดสอบไว้) ติ๊กแต่ละข้อแล้วจดข้อที่ผิดไว้

| # | เปิด / ทำ | ที่ต้องเห็น |
|---|---|---|
| 1 | หน้าแรก แล้วลากเมาส์หมุนกล้องรอบ hero | sprite เปลี่ยนมุมตามกล้อง (หมุนไปด้านหลังต้องเห็น sprite ด้านหลัง ไม่ใช่ด้านหน้าเดิม) ภาพไม่กระพริบ ไม่มีขอบสีแปลกๆ รอบ sprite |
| 2 | ปุ่มทิศ N…NW, `clip` idle/walk, `auto-turn` | หันครบ 8 ทิศ เดินแล้วหมวก อาวุธ และผมตามจังหวะเดิน (ตาม socket) |
| 3 | เปลี่ยน hair / hat / armor / weapon ทุกตัว รวมถึง `none` | เปลี่ยนทันที ชั้นอื่นไม่หายหรือกระพริบ ส่วน **Source pages** แสดงเฉพาะหน้าที่ใช้อยู่ และ refs / fetched นับขึ้นตามจริง |
| 4 | Layers: ติ๊กออกทีละชั้น | ชั้นนั้นหายจากทุกตัว ติ๊กกลับแล้วกลับมาเหมือนเดิม |
| 5 | Debug overlay: foot pivots, hero sockets, layer boxes + order, painter rank | จุด pivot อยู่ที่เท้า socket อยู่ที่หัว/มือ/หลัง ลำดับเลขเรียงตามที่วาด |
| 6 | ปุ่มจำนวน 1 / 2 / 20 / 100 / 300 | ตัวที่ใกล้กล้องกว่าวาดทับตัวที่ไกลกว่าเสมอ กำแพง เสา และซุ้มบังตัวละครถูกต้อง ช่อง Stats มีตัวเลข draw calls และ CPU update/submit |
| 7 | ดูบรรทัดบนสุดของ panel (`WebGL2 · ...`) และบรรทัด `GPU timer` ใน Stats | บรรทัดบนสุดต้องเป็นชื่อ GPU จริง ไม่ใช่ `SwiftShader` ส่วน `GPU timer` ควรขึ้น `(device)` หรือ `n/a` (บางเบราว์เซอร์ซ่อน timer extension ซึ่งถือว่าปกติ) ถ้าขึ้น `(SOFTWARE rasterizer)` แปลว่าเบราว์เซอร์ไม่ได้ใช้ GPU ให้แจ้งมาพร้อมรุ่นเบราว์เซอร์ |
| 8 | ปุ่ม **simulate GPU context loss (1 s)** | ฉากดำไปประมาณ 1 วินาทีแล้วกลับมาเหมือนเดิม Stats ขึ้น `context losses 1` และตัวเลข `fetches` ต้องไม่เพิ่ม (กู้จาก copy ในหน่วยความจำ ไม่โหลดใหม่จากเน็ต) |
| 9 | `http://localhost:5173/?budgetMiB=1` แล้วสลับ hat ไปมา เช่น hat_01 → hat_02 → hat_01 | ทุกครั้งที่สลับ `evictions` เพิ่ม 1 (หมวกที่ถอดถูกปล่อยจาก GPU) พอสลับกลับ `reloads` เพิ่ม 1 ใน Source pages หน้านั้นขึ้น `evicted 1×` และมีข้อความ `OVER BUDGET: pinned set too large` (ถูกต้อง เพราะ 1 MiB เล็กกว่าชุดที่กำลังแสดง) และ**ต้องไม่มีเฟรมไหนแสดงหมวกผิดใบ** |
| 10 | `?scene=parity&variant=crossing&paused=1&t=400` เทียบกับ `&t=2000` | t=400: hero อยู่หลัง NPC (NPC ทับ) / t=2000: hero เดินผ่านมาข้างหน้าแล้ว hero ทับ NPC |
| 11 | `?scene=parity&variant=arch` | hero ยืนหลังซุ้ม: คานบังช่วงหัว/หมวก และเสาบังด้านข้าง ส่วนตัวที่สองซึ่งยืนหน้าซุ้มไม่ถูกบังเลย |
| 12 | `?scene=parity&variant=glass` | ส่วนของ hero ที่อยู่หลังกระจกเป็นสีฟ้าโปร่งครึ่งหนึ่ง ส่วนตัวที่สองซึ่งอยู่หน้ากระจกเป็นสีปกติ ไม่ถูกย้อม |
| 13 | `?count=300` เทียบกับ `?count=300&mips=0` แล้ว zoom ออกไกลสุดและหมุนกล้องช้าๆ | แบบมี mip (ค่า default) ตัวเล็กๆ ไกลๆ ควรสั่นหรือแตกเป็นจุดน้อยกว่า (อาจดูนุ่มลงนิดหน่อย ซึ่งปกติ) และ**ไม่มีสีของชิ้นอื่นซึมมาที่ขอบ** ถ้าเห็นสีซึมคือ mip bleed ให้ capture หน้าจอมา |
| 14 | DevTools → Console | ไม่มี error สีแดงตลอดการทดสอบข้างบน |

## 4. ส่งอะไรกลับมา

1. ผลของข้อ 1: ถ้าผ่านหมดพิมพ์มาแค่ "ข้อ 1 ผ่านหมด" ก็พอ ถ้ามีข้อไหน fail ให้ copy output ส่วนที่ fail มาทั้งก้อน
2. folder `docs/benchmark-results/gpu/...` ทั้งหมดจากข้อ 2 จะ commit + push ขึ้น branch นี้ หรือ zip มาก็ได้
3. รุ่นของ GPU / CPU / OS / เบราว์เซอร์ (ส่วนใหญ่มีอยู่ใน `summary.json` อยู่แล้ว)
4. ข้อในข้อ 3 ที่ผิด พร้อม URL และภาพหน้าจอ

ได้ผลชุดนี้แล้ว ผมจะเขียนรายงาน GPU baseline ให้ (ปิด M1 ได้ครบ) และใช้เป็นตัวตั้งก่อนเริ่ม Milestone 3 (batching / shader composition)
