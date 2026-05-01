# ครูจุ๋มเขาสวนกวางติวเตอร์ - ระบบจัดการโรงเรียนกวดวิชา

## โครงสร้างโปรเจกต์

```
tutor-app/         ← Frontend (React)
├── public/
│   └── index.html
├── src/
│   ├── App.jsx    ← UI ทั้งหมด
│   └── api.js     ← ฟังก์ชัน call API
└── package.json

tutor-backend/     ← Backend (Node.js)
├── server.js      ← Express server + API routes
├── public/        ← React build (copy มาจาก tutor-app/build)
└── package.json
```

---

## Database Schema

| ตาราง | คำอธิบาย |
|-------|----------|
| users | ผู้ใช้งานระบบ |
| students | ข้อมูลนักเรียน |
| courses | คอร์ส/วิชาที่เปิดสอน |
| enrollments | การลงทะเบียนเรียน (นักเรียน ↔ คอร์ส) |
| payments | รายการชำระเงิน |
| attendances | บันทึกการเข้าเรียน |

---

## API Routes

### Auth
```
POST /api/login
```

### Students
```
GET    /api/students          (search, status, page, limit)
POST   /api/students          [admin]
PUT    /api/students/:id      [admin]
DELETE /api/students/:id      [admin]
```

### Courses
```
GET    /api/courses           (search, status, page, limit)
POST   /api/courses           [admin]
PUT    /api/courses/:id       [admin]
DELETE /api/courses/:id       [admin]
```

### Enrollments
```
GET    /api/enrollments       (student_id, course_id, status, page)
POST   /api/enrollments       [admin]
PUT    /api/enrollments/:id   [admin]
DELETE /api/enrollments/:id   [admin]
```

### Payments
```
GET    /api/payments          (student_id, course_id, month, page)
POST   /api/payments
DELETE /api/payments/:id      [admin]
```

### Attendances
```
GET    /api/attendances       (course_id, student_id, date, page)
POST   /api/attendances
DELETE /api/attendances/:id   [admin]
```

### Summary
```
GET    /api/summary
```

---

## Environment Variables (Railway)

```env
DATABASE_URL=postgresql://...
JWT_SECRET=krujum-tutor-secret-2024
PORT=8080
FRONTEND_URL=https://krujumtutor.com
```

---

## ขั้นตอน Deploy (เหมือนระบบสต็อกเดิม)

### ทุกครั้งที่อัปเดตโค้ด

```bash
# 1. แก้ไขโค้ดใน tutor-app/src/

# 2. Build frontend
cd tutor-app
npm run build

# 3. Copy build ไปที่ backend
rm -rf ../tutor-backend/public/*
cp -r build/* ../tutor-backend/public/

# 4. Push ขึ้น GitHub
# → Railway deploy อัตโนมัติ รอ 1-2 นาที
```

### ครั้งแรก (Setup)

```bash
# Backend
cd tutor-backend
npm install

# Frontend
cd tutor-app
npm install
```

---

## Default Login

```
username: admin
password: admin1234
```

⚠️ **เปลี่ยนรหัสผ่านหลัง login ครั้งแรกด้วย!**

---

## สิทธิ์การใช้งาน

| ฟีเจอร์ | Admin | Staff |
|---------|-------|-------|
| เช็คชื่อ / บันทึกชำระเงิน | ✅ | ✅ |
| ดูข้อมูลนักเรียน / คอร์ส | ✅ | ✅ |
| เพิ่ม/แก้ไข/ลบนักเรียน | ✅ | ❌ |
| เพิ่ม/แก้ไข/ลบคอร์ส | ✅ | ❌ |
| จัดการลงทะเบียน | ✅ | ❌ |
| ลบรายการชำระเงิน | ✅ | ❌ |
| จัดการผู้ใช้ | ✅ | ❌ |

---

## Frontend Features

- ✅ Login ด้วย JWT (8 ชั่วโมง)
- ✅ Dashboard: สรุปภาพรวม 5 การ์ด
- ✅ นักเรียน: ค้นหา, กรองสถานะ, Pagination
- ✅ คอร์ส: จัดการคอร์สทั้งหมด
- ✅ ลงทะเบียน: เชื่อม นักเรียน ↔ คอร์ส
- ✅ เช็คชื่อ: กรองตามวัน, นับครั้งอัตโนมัติ
- ✅ ชำระเงิน: กรองตามเดือน, สรุปยอดรวม
- ✅ Responsive (Mobile Card / Desktop Table)
- ✅ Toast notification
