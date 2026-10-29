# YouTube Watch Party

เว็บดู YouTube พร้อมกันที่รันจาก Python process เดียว ใช้ FastAPI เสิร์ฟหน้าเว็บและ WebSocket ส่วนวิดีโอโหลดตรงจาก YouTube ไปยังแต่ละอุปกรณ์ จึงไม่กินแบนด์วิดท์วิดีโอของเครื่องเซิร์ฟเวอร์

## ความสามารถ

- สร้างห้องด้วยรหัส 3 ตัว และเก็บสิทธิ์ Host ไว้ใน URL fragment/session storage
- Host เลือกวิดีโอและควบคุม play, pause, seek จาก YouTube player จริง
- NTP-style clock calibration, heartbeat และ drift correction สองระดับ (playback rate/seek)
- ซิงก์แน่นแต่ไม่กระตุก: ผู้ชมเทียบกับตำแหน่งจริงของ Host (ผ่าน P2P หรือ server relay ทุก 250ms)
  - คลาดเล็กน้อย (>70ms) แก้ด้วยการเร่ง/หน่วงความเร็ว 1.05x/0.95x (คลาด ≥0.4s ใช้ 1.1x/0.9x) ซึ่งมองไม่เห็นและไม่ต้อง buffer
    (YouTube embed รับความเร็วทีละ 0.05 แม้ไม่อยู่ในรายการ getAvailablePlaybackRates; ถ้าเครื่องไหนไม่รับจะถอยไปใช้ seek)
  - seek เฉพาะคลาดมาก (≥1.5s นาน 1s) หรือเริ่มเล่นช้ากว่า Host ≥0.5s; seek เผื่อเวลา buffer ที่เรียนรู้ไว้
  - ถ้า seek แล้วไม่ตรง (เครื่อง/เน็ตตามไม่ทัน) เว้นระยะครั้งถัดไปเป็นสองเท่า (สูงสุด 1 นาที)
  - วัดจริงด้วย Chromium 2 หน้า: ปกติห่าง Host ±15ms; ดันให้คลาด 1s แก้ด้วย 1.1x ใน ~10s โดยไม่ seek
  - โหมดต่อเครื่อง: อัตโนมัติ (สมดุล), ลื่นไหล (เริ่มแก้ที่ 150ms, ความเร็วไม่เกิน 5%), แม่นยำ (เริ่มแก้ที่ 40ms)
  - Host ลากแถบเวลา: ส่ง SEEK ครั้งเดียวเมื่อหยุดลาก 0.4 วินาที
- reconnect อัตโนมัติ และกลับจากการสลับแอป/แท็บ: เทียบนาฬิกาใหม่ แต่ไม่กระโดดเวลาถ้ายังตรงกันอยู่
- คิววิดีโอของห้อง: เล่นเลย/เพิ่มเข้าคิว, เลื่อนลำดับ, สุ่ม, ข้าม, ลบ, เล่นคลิปถัดไปอัตโนมัติเมื่อจบ
- นำเข้า YouTube playlist (สูงสุด 200 คลิปต่อครั้ง, คิวสูงสุด 300) ผ่าน yt-dlp พร้อมชื่อคลิปและความยาว
- คลิปที่ embed ไม่ได้ (error 5/100/101/150) ถูกข้ามอัตโนมัติเมื่อมีคิวต่อ
- Host เปิดให้ผู้ชมเพิ่มคลิปเข้าคิวได้ (ปิดไว้เป็นค่าเริ่มต้น)
- แสดง QR Code สำหรับลิงก์ Viewer โดยไม่เปิดเผย Host token
- ตรวจ Origin ของ WebSocket และไม่บันทึก Host token ลง log
- แจ้งข้อผิดพลาด YouTube แบบเจาะจง และให้ Host ส่งสถานะ embed error ไปทั้งห้อง

> ห้องและสถานะทั้งหมดอยู่ในหน่วยความจำ ต้องรัน Uvicorn 1 worker ต่อ instance การ restart จะล้างห้องของ instance นั้น สำหรับหลาย instance มีชุดแบ่งห้องตามรหัสใน [คู่มือ deployment](deploy/README.md)

## เริ่มใช้งานบน Windows

ต้องมี Python 3.11+ และ [uv](https://docs.astral.sh/uv/) ใน PATH

```bat
setup.bat
start.bat
```

จากนั้นเปิด `http://localhost:3055` ถ้าจะทดสอบจากมือถือใน Wi-Fi เดียวกัน ให้เปิด `http://IP-ของ-PC:3055` และอนุญาตพอร์ต 3055 ใน Windows Firewall เฉพาะเครือข่าย Private ที่ไว้ใจ

## เริ่มใช้งานบน Linux/macOS

```bash
chmod +x setup.sh run.sh
./setup.sh
./run.sh
```

## เปิดผ่าน Cloudflare Tunnel

เปิด backend ด้วย `start.bat` ก่อน แล้วเปิดอีก terminal หนึ่ง

Quick Tunnel (URL เปลี่ยนเมื่อเริ่มใหม่):

```bat
start-tunnel.bat
```

Named Tunnel (URL คงที่และเหมาะกับการใช้งานประจำ):

```bat
cloudflared tunnel login
cloudflared tunnel create watchparty
cloudflared tunnel route dns watchparty watch.example.com
start-named-tunnel.bat watchparty
```

ตั้ง ingress ของ Named Tunnel ให้ชี้ hostname ไปยัง `http://localhost:3055` ในไฟล์ config ของ cloudflared หรือหน้า Cloudflare Zero Trust ก่อนสั่ง run ตัวอย่างอยู่ใน `cloudflared-config.example.yml`

`start-named-tunnel.bat` บังคับใช้ QUIC ถ้าเครือข่ายบล็อก UDP port 7844 ให้เปลี่ยน `--protocol quic` เป็น `--protocol auto` เพื่อให้ cloudflared fallback ไป HTTP/2 ได้ ส่วน Quick Tunnel ใช้ค่า `auto` อยู่แล้ว

หากจำเป็นต้องยอมรับ Origin เพิ่มเติม ให้กำหนดเป็นรายการคั่นด้วย comma ก่อนเปิด backend:

```powershell
$env:WATCHPARTY_ALLOWED_ORIGINS = "https://watch.example.com"
./start.bat
```

โดยปกติไม่ต้องตั้งค่านี้ เพราะระบบอนุญาต Origin ที่มี hostname เดียวกับหน้าเว็บอยู่แล้ว

## Logging และ health check

เหตุการณ์สำคัญถูกเขียนลง `watchparty.log` และหมุนไฟล์อัตโนมัติเมื่อถึง 2MB โดยเก็บไฟล์ย้อนหลัง 3 ชุด ครอบคลุมการสร้าง/หมดอายุของห้อง, จำนวน connection และ peak, disconnect, input error และ YouTube embed error แต่ไม่บันทึก Host token หรือลิงก์ที่ผู้ใช้กรอก

เปลี่ยนตำแหน่ง log หรือปิด file logging ได้ด้วย environment variable:

```powershell
$env:WATCHPARTY_LOG_FILE = "D:\logs\watchparty.log"  # เปลี่ยนตำแหน่ง
$env:WATCHPARTY_LOG_FILE = ""                         # ปิด file logging
```

ตรวจว่า process ยังตอบสนอง (`/health/metrics` แสดงจำนวน connection, ข้อมูลค้างในคิว และจำนวนเครื่องที่ส่งช้าจนถูกตัด โดยไม่เปิดเผย Host token):

```powershell
Invoke-RestMethod http://127.0.0.1:3055/health
```

## ทดสอบ

```powershell
.\.venv\Scripts\python.exe -m pytest -q
```

ทดสอบ fan-out และ clock projection ด้วย client จำลองหลายตัว (ต้องเปิดเซิร์ฟเวอร์อยู่):

```powershell
.\.venv\Scripts\python.exe tools\precision_probe.py --url http://127.0.0.1:3055 --clients 12
```

ผลจาก probe เป็นการวัด WebSocket/timeline ไม่ใช่การวัด buffering ภายใน YouTube player จริง จึงควรทดสอบซ้ำบนมือถือหลายเครื่องและคนละเครือข่ายก่อนใช้งานจริง

จำลอง 10 ห้อง ห้องละ 5 clients พร้อมกัน:

```powershell
.\.venv\Scripts\python.exe tools\load_probe.py --url http://127.0.0.1:3055 --rooms 10 --clients-per-room 5
```

เพิ่ม `--receive-jitter-ms 80` เพื่อจำลองความเหลื่อมของเวลารับข้อความสูงสุด 80ms ระหว่าง clients ในแต่ละห้อง

## การตัดสินใจด้าน latency

- ใช้ optimistic playback อยู่แล้ว: เครื่อง Host ตอบสนองจาก YouTube control ทันทีโดยไม่รอ server acknowledgement
- client คำนวณ expected timeline เองทุก 50ms จาก monotonic anchor จึงไม่ต้อง round-trip สำหรับ drift correction
- ทุกข้อความหลัง HELLO ผ่าน writer เดียวต่อ connection; WELCOME ต้องส่งสำเร็จก่อนเริ่มรับ broadcast
- broadcast เข้าคิวแต่ละเครื่องโดยไม่รอเครื่องที่เน็ตช้า และ encode JSON เพียงครั้งเดียวต่อ broadcast
- คิวจำกัด 32 ข้อความ/256 KiB, รวม heartbeat ที่ยังไม่ส่งเหลือสถานะล่าสุด และตัด connection ที่ส่งเกิน 1 วินาทีหรือมีข้อความรอส่งเกิน 1 วินาที เพื่อให้ reconnect รับ snapshot ปัจจุบัน
- CLOCK_PONG แซง telemetry ที่ยังไม่ส่งและประทับเวลาก่อนส่งจริง; heartbeat ปรับช่วงตามขนาดของแต่ละห้อง
- ใช้ WebRTC DataChannel ส่งคำสั่งจาก Host โดยตรงและเทียบตำแหน่งสำหรับห้องไม่เกิน 8 connections; ใช้ WebSocket ต่อเนื่องเป็นเส้นทางหลัก และปิด P2P เมื่อห้องใหญ่ขึ้น
- P2P ใช้ ICE ภายในเครือข่ายโดยไม่มี TURN/STUN ภายนอก จึงอาจต่อไม่ได้เมื่อ AP แยก clients หรืออยู่คนละ NAT; ระบบยังซิงก์ผ่าน server ได้
- ลด telemetry ของผู้ชมเหลือประมาณ 1 ครั้ง/วินาที และ 1 ครั้ง/2 วินาทีเมื่อพักวิดีโอหรือซ่อนแท็บ; ข้าม telemetry เมื่อ WebSocket มีข้อมูลรอส่ง
- จำกัดคำขอแก้เวลาด้วย seek แบบเพิ่มเวลารอ 1.5–12 วินาทีเมื่อแก้แล้วไม่ตรง และคืน playback rate เป็น 1x เมื่อ buffering/ซ่อนแท็บ
- reconnect และการเทียบนาฬิกามี jitter เพื่อลดการส่งคำขอพร้อมกัน; เริ่มเล่นได้จาก clock reply แรกที่ใช้ได้
- ไม่เพิ่ม MessagePack เพราะ control payload มีขนาดเล็กมากและการลด serialization ไม่ได้ลด propagation RTT อย่างมีนัยสำคัญ แต่จะเพิ่ม protocol/bundle ที่ต้องดูแลสองฝั่ง
- ไม่ตั้ง `TCP_NODELAY` เอง เพราะ Python asyncio เปิดค่านี้ให้ TCP connections โดยปริยายอยู่แล้ว
- Uvicorn เลือก event loop/HTTP implementation แบบ `auto`; บน Windows จะไม่บังคับ `uvloop` ซึ่งไม่รองรับแพลตฟอร์มนี้

YouTube เป็นผู้ควบคุมคุณภาพภาพและ buffer ภายใน iframe เอง: `setPlaybackQuality` ไม่ทำงานแล้วตาม [เอกสาร YouTube](https://developers.google.com/youtube/iframe_api_revision_history#october-24,-2019) จึงไม่สามารถรับประกัน ping ของเครือข่ายหรือความหน่วงของภาพด้วยโค้ดฝั่งนี้เพียงอย่างเดียว ค่า Server RTT ในหน้าเว็บเป็นเวลารับส่งข้อความควบคุม ไม่ใช่ glass-to-glass video latency

ผลการทดสอบและข้อจำกัดอยู่ใน [รายงานการวัด](artifacts/latency-report.md)

## โครงสร้างหลัก

```text
main.py                         FastAPI routes, WebSocket และ lifecycle
managers/room_manager.py        ห้อง สิทธิ์ Host heartbeat และ broadcast
managers/sync.py                timeline, drift filter และ cohort metrics
managers/youtube.py             ตรวจและแยก YouTube video ID
static/js/sync-clock.js         เทียบนาฬิกา client/server
static/js/youtube-player.js     YouTube IFrame controller และ drift correction
static/js/app.js                UI, WebSocket, reconnect และ telemetry
templates/                      หน้าแรกและหน้าห้อง
tools/precision_probe.py        ตัววัดหลาย WebSocket clients
tools/load_probe.py             ตัววัดหลายห้องพร้อมกัน
```

## Requirements

Python 3.11+ (tests run on 3.12; the WebSocket tests hang on Python 3.10). The Dockerfile uses `python:3.12-slim`.

## License

MIT — see [LICENSE](LICENSE).
