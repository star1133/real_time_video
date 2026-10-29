# ใช้งานหลาย instance

ชุดนี้แบ่งห้องไปยัง Python 4 processes หลัง Nginx โดยใช้เลขตัวแรกของรหัสห้องเป็นเจ้าของ: `0xx`, `1xx`, `2xx`, `3xx` การเปิดหน้า, QR และ WebSocket ของห้องเดียวกันจะไปยัง instance เดิมเสมอ ไม่ขึ้นกับ IP หรือ cookie ของผู้ชม

```bash
docker compose up -d --build --wait
```

เปิด `http://127.0.0.1:3055` หรือให้ Cloudflare Tunnel ชี้มายังพอร์ตนี้ ต้องหยุด `start.bat`/`run.sh` เดิมก่อนถ้าใช้พอร์ตเดียวกัน ชุด Docker เปิดพอร์ตบน loopback เท่านั้น หากต้องเปิดให้ LAN ใช้ ให้แก้ port mapping ของ gateway เป็น `3055:80` และตั้ง firewall ตามเครือข่ายที่ใช้งาน

ไฟล์ [nginx.conf](nginx.conf) ปิด proxy buffering และส่ง Upgrade/Connection ตาม [เอกสาร WebSocket ของ Nginx](https://nginx.org/en/docs/http/websocket.html) ส่วน Docker รอ health check ของทุก shard ก่อนเริ่ม gateway ตาม [เอกสาร Compose](https://docs.docker.com/compose/how-tos/startup-order/)

ทุก backend ใช้ 1 worker และมีเพียง gateway ที่ publish พอร์ต Backend ใน Docker เชื่อ X-Forwarded-* จาก gateway เพื่อสร้าง URL HTTPS ถูกต้อง จึงต้องคง backend ไว้ในเครือข่ายภายใน หากใช้ reverse proxy ภายนอก ให้ตั้ง trusted proxy ตามสภาพแวดล้อมนั้น

การตรวจสถานะ:

```bash
docker compose ps
docker compose exec gateway nginx -t
docker compose exec shard0 python -c "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:3055/health/metrics').read().decode())"
```

`/health/metrics` เป็นข้อมูลต่อ instance; เรียกผ่าน gateway จะได้ instance ที่ถูกเลือกในคำขอนั้น ไม่ใช่ค่ารวมของ cluster ตัวเลข `pending_bytes`, `max_queue_delay_ms`, `expired_queues` และ `slow_clients_disconnected` ใช้ติดตามคอขวดได้

ข้อจำกัดของชุดนี้:

- รหัสห้องยังมี 3 หลักเพื่อใช้กับ UI เดิม: standalone ได้ 1,000 รหัส; 4 shards นี้ได้ 400 รหัส ห้องว่างหมดอายุหลัง 6 ชั่วโมง หาก shard ที่รับสร้างห้องเต็มจะตอบ 503 ให้ลองใหม่
- ค่า `WATCHPARTY_MAX_ROOM_CONNECTIONS` เริ่มต้น 2,000 ต่อห้อง เป็น admission limit ไม่ใช่จำนวนผู้ชมที่รับรองประสิทธิภาพ ต้องปรับจากผล load test ของเครื่องจริง
- เพิ่ม shard ได้ถึง `9` โดยเพิ่ม service, `WATCHPARTY_SHARD_ID` ที่ไม่ซ้ำ และ mapping/creation distribution ใน Nginx ต้องคง mapping เดิมตลอดอายุห้อง ห้ามเพิ่ม replicas ของ shard เดิมหรือเพิ่ม Uvicorn workers เพราะ state อยู่ในหน่วยความจำ
- ระบบกระจายโหลดข้ามห้อง ห้องเดียวอยู่บน process เดียวเสมอ จึงยังต้องวัดความจุของห้องขนาดใหญ่อย่างแยกต่างหาก
- ยังไม่มี durable room storage, การเลือก leader หรือ automatic failover; restart shard ทำให้ห้องของ shard นั้นหาย ส่วน gateway ยังเป็นจุดล้มเหลวร่วม หากต้องการ HA แบบรักษาห้องหลังเครื่องล่ม ต้องเพิ่มระบบเก็บ state และ recovery ก่อนนำไปใช้ตามข้อกำหนดนั้น

สำหรับสถานที่ที่สัญญาณแออัด ต้องวัดด้วยอุปกรณ์และ Wi-Fi จริง โดยให้ทุกเครื่องเล่นวิดีโอพร้อมกัน ติดตาม buffering และตำแหน่งภาพจริงด้วย วิดีโอ YouTube ยังโหลดแยกต่ออุปกรณ์ จึงใช้แบนด์วิดท์และ airtime ตามจำนวนผู้ชม การแบ่ง server ของคำสั่งไม่ได้ลดปริมาณวิดีโอที่ผ่าน AP

รันตัววัดคำสั่งโดยไม่ต้องเปิดวิดีโอ:

```bash
python tools/load_probe.py --url http://127.0.0.1:3055 --rooms 10 --clients-per-room 20 --commands 30
python tools/load_probe.py --url http://127.0.0.1:3055 --rooms 10 --clients-per-room 20 --commands 30 --slow-readers 2 --slow-read-ms 150
```

กรณี slow readers อาจคืน exit code 1 เพราะเครื่องที่หน่วงเกินเป้าหมาย 100ms ให้ดู `healthy_reader_delivery_latency_ms`, `missing_deliveries` และ `failed_rooms` ร่วมกัน การอ่านช้าแบบจำลองไม่ได้แทน packet loss หรือความแออัดบนคลื่นวิทยุ
