const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8080;
const JWT_SECRET = process.env.JWT_SECRET || 'krujum-tutor-secret-2024';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(rateLimit({ windowMs: 60 * 1000, max: 200 }));

const allowedOrigins = [
  'http://localhost:3000',
  'https://krujumtutor.com',
  process.env.FRONTEND_URL,
].filter(Boolean);

app.use(cors({ origin: allowedOrigins, credentials: true }));
app.use(express.static(path.join(__dirname, 'public')));

const auth = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid token' }); }
};

const adminOnly = (req, res, next) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
};

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR UNIQUE NOT NULL,
      password VARCHAR NOT NULL,
      role VARCHAR DEFAULT 'staff',
      name VARCHAR,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS students (
      id SERIAL PRIMARY KEY,
      student_code VARCHAR UNIQUE NOT NULL,
      name VARCHAR NOT NULL,
      nickname VARCHAR,
      birth_date DATE,
      phone VARCHAR,
      parent_name VARCHAR,
      parent_phone VARCHAR,
      address TEXT,
      status VARCHAR DEFAULT 'active',
      note TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS courses (
      id SERIAL PRIMARY KEY,
      course_code VARCHAR UNIQUE NOT NULL,
      name VARCHAR NOT NULL,
      subject VARCHAR,
      level VARCHAR,
      teacher VARCHAR,
      price DECIMAL(10,2) DEFAULT 0,
      sessions_total INTEGER DEFAULT 0,
      schedule VARCHAR,
      status VARCHAR DEFAULT 'active',
      note TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS enrollments (
      id SERIAL PRIMARY KEY,
      student_id INTEGER REFERENCES students(id),
      course_id INTEGER REFERENCES courses(id),
      enrolled_at TIMESTAMP DEFAULT NOW(),
      sessions_used INTEGER DEFAULT 0,
      status VARCHAR DEFAULT 'active',
      note TEXT,
      UNIQUE(student_id, course_id)
    );
    CREATE TABLE IF NOT EXISTS payments (
      id SERIAL PRIMARY KEY,
      student_id INTEGER REFERENCES students(id),
      course_id INTEGER REFERENCES courses(id),
      amount DECIMAL(10,2) NOT NULL,
      paid_at TIMESTAMP DEFAULT NOW(),
      method VARCHAR DEFAULT 'cash',
      status VARCHAR DEFAULT 'paid',
      note VARCHAR,
      recorded_by VARCHAR
    );
    CREATE TABLE IF NOT EXISTS attendances (
      id SERIAL PRIMARY KEY,
      enrollment_id INTEGER REFERENCES enrollments(id),
      student_id INTEGER,
      registration_id INTEGER REFERENCES registrations(id),
      course_id INTEGER,
      attended_at TIMESTAMP DEFAULT NOW(),
      status VARCHAR DEFAULT 'present',
      note VARCHAR,
      recorded_by VARCHAR
    );
    ALTER TABLE attendances ADD COLUMN IF NOT EXISTS registration_id INTEGER REFERENCES registrations(id);
    CREATE TABLE IF NOT EXISTS registrations (
      id SERIAL PRIMARY KEY,
      name VARCHAR NOT NULL,
      nickname VARCHAR,
      grade VARCHAR,
      parent_name VARCHAR,
      parent_phone VARCHAR,
      pay_status VARCHAR DEFAULT 'unpaid',
      amount DECIMAL(10,2) DEFAULT 0,
      paid_amount DECIMAL(10,2) DEFAULT 0,
      remaining DECIMAL(10,2) DEFAULT 0,
      paid_at TIMESTAMP,
      pay_method VARCHAR DEFAULT 'cash',
      slip_url VARCHAR,
      months TEXT[],
      note TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );

    -- เพิ่ม column ถ้ายังไม่มี (สำหรับ database เก่า)
    ALTER TABLE registrations ADD COLUMN IF NOT EXISTS paid_amount DECIMAL(10,2) DEFAULT 0;
    ALTER TABLE registrations ADD COLUMN IF NOT EXISTS remaining DECIMAL(10,2) DEFAULT 0;
    ALTER TABLE registrations ADD COLUMN IF NOT EXISTS paid_at TIMESTAMP;
    ALTER TABLE registrations ADD COLUMN IF NOT EXISTS pay_method VARCHAR DEFAULT 'cash';
    ALTER TABLE registrations ADD COLUMN IF NOT EXISTS slip_url VARCHAR;

  `);

  const exists = await pool.query(`SELECT id FROM users WHERE username = 'admin'`);
  if (exists.rows.length === 0) {
    const hash = await bcrypt.hash('admin1234', 10);
    await pool.query(`INSERT INTO users (username, password, role, name) VALUES ('admin', $1, 'admin', 'ผู้ดูแลระบบ')`, [hash]);
  }
  console.log('✅ Database initialized');
}

// AUTH
app.post('/api/login', rateLimit({ windowMs: 60000, max: 10 }), async (req, res) => {
  try {
    const { username, password } = req.body;
    const result = await pool.query(`SELECT * FROM users WHERE username = $1`, [username]);
    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(password, user.password)))
      return res.status(401).json({ error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
    const token = jwt.sign({ id: user.id, username: user.username, role: user.role, name: user.name }, JWT_SECRET, { expiresIn: '8h' });
    res.json({ token, user: { id: user.id, username: user.username, role: user.role, name: user.name } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// SUMMARY
app.get('/api/summary', auth, async (req, res) => {
  try {
    const [students, regs, regsMonth, payments] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM students WHERE status = 'active'`),
      pool.query(`SELECT COUNT(*) FROM registrations`),
      pool.query(`SELECT COUNT(*) FROM registrations WHERE $1 = ANY(months)`, [new Date().toISOString().slice(0, 7)]),
      pool.query(`SELECT COALESCE(SUM(amount),0) as total FROM payments WHERE DATE_TRUNC('month', paid_at) = DATE_TRUNC('month', NOW())`),
    ]);
    res.json({
      active_students: +students.rows[0].count,
      total_registrations: +regs.rows[0].count,
      monthly_registrations: +regsMonth.rows[0].count,
      monthly_income: +payments.rows[0].total,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// INIT — โหลดทุกอย่างครั้งเดียว
app.get('/api/init', auth, async (req, res) => {
  try {
    const todayStr = new Date().toISOString().slice(0, 10);
    const currentMonth = new Date().toISOString().slice(0, 7);

    const [registrations, summary, attendancesToday] = await Promise.all([
      // ดึงนักเรียนที่ลงทะเบียนเดือนปัจจุบัน
      pool.query(`
        SELECT *, array_length(months, 1) as month_count
        FROM registrations
        WHERE $1 = ANY(months)
        ORDER BY created_at DESC
      `, [currentMonth]),
      pool.query(`
        SELECT
          (SELECT COUNT(*) FROM registrations WHERE $1 = ANY(months)) as monthly_students,
          (SELECT COALESCE(SUM(amount),0) FROM registrations WHERE $1 = ANY(months) AND pay_status = 'paid') as monthly_income,
          (SELECT COUNT(*) FROM registrations WHERE $1 = ANY(months) AND pay_status = 'paid') as paid_count,
          (SELECT COUNT(*) FROM registrations WHERE $1 = ANY(months) AND pay_status = 'unpaid') as unpaid_count
      `, [currentMonth]),
      pool.query(`SELECT student_id FROM attendances WHERE DATE(attended_at) = $1`, [todayStr]),
    ]);

    res.json({
      registrations: registrations.rows,
      summary: summary.rows[0],
      attendancesToday: attendancesToday.rows,
      currentMonth,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


app.get('/api/registrations', auth, async (req, res) => {
  try {
    const { search = '', pay_status = '', month, page = 1, limit = 50 } = req.query;
    const offset = (page - 1) * limit;
    let where = []; let params = [];

    if (search) {
      params.push(`%${search}%`);
      where.push(`(r.name ILIKE $${params.length} OR r.nickname ILIKE $${params.length})`);
    }
    if (pay_status) {
      params.push(pay_status);
      where.push(`r.pay_status = $${params.length}`);
    }

    const filterMonth = month || new Date().toISOString().slice(0, 7);
    if (filterMonth) {
      params.push(filterMonth);
      where.push(`$${params.length} = ANY(r.months)`);
    }

    const whereStr = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const countRes = await pool.query(`SELECT COUNT(*), COALESCE(SUM(r.amount),0) as total_amount FROM registrations r ${whereStr}`, params);
    params.push(limit, offset);
    const data = await pool.query(
      `SELECT r.*, array_length(r.months, 1) as month_count FROM registrations r ${whereStr} ORDER BY r.created_at DESC LIMIT $${params.length-1} OFFSET $${params.length}`,
      params
    );
    res.json({ data: data.rows, total: +countRes.rows[0].count, total_amount: +countRes.rows[0].total_amount, page: +page, limit: +limit });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/registrations', auth, async (req, res) => {
  try {
    const { name, nickname, grade, parent_name, parent_phone, pay_status, amount, months, note } = req.body;
    const safeAmount = Math.round(parseFloat(amount || 0));
    const r = await pool.query(
      `INSERT INTO registrations (name, nickname, grade, parent_name, parent_phone, pay_status, amount, paid_amount, remaining, months, note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [name, nickname, grade, parent_name, parent_phone, pay_status || 'unpaid', safeAmount, 0, safeAmount, months || [], note]
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/registrations/:id/pay', auth, async (req, res) => {
  try {
    const { paid_amount, pay_method, slip_url, note } = req.body;
    const reg = await pool.query(`SELECT * FROM registrations WHERE id=$1`, [req.params.id]);
    if (!reg.rows[0]) return res.status(404).json({ error: 'ไม่พบข้อมูล' });

    const r = reg.rows[0];
    const originalAmount = Math.round(parseFloat(r.amount || 0));
    const prevPaid = Math.round(parseFloat(r.paid_amount || 0));
    const newPayment = Math.round(parseFloat(paid_amount || 0));

    if (newPayment <= 0) return res.status(400).json({ error: 'จำนวนเงินต้องมากกว่า 0' });

    const totalPaid = prevPaid + newPayment;
    const remaining = Math.max(originalAmount - totalPaid, 0);
    const pay_status = remaining === 0 ? 'paid' : 'partial';

    const updated = await pool.query(
      `UPDATE registrations SET paid_amount=$1, remaining=$2, pay_status=$3, paid_at=NOW(), pay_method=$4, slip_url=$5, note=COALESCE($6, note) WHERE id=$7 RETURNING *`,
      [totalPaid, remaining, pay_status, pay_method || 'cash', slip_url || null, note || null, req.params.id]
    );
    res.json(updated.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});


app.put('/api/registrations/:id', auth, async (req, res) => {
  try {
    const { name, nickname, grade, parent_name, parent_phone, pay_status, amount, months, note } = req.body;
    const safeAmount = Math.round(parseFloat(amount || 0));

    // ดึง paid_amount เดิมมา recalculate remaining
    const existing = await pool.query(`SELECT paid_amount FROM registrations WHERE id=$1`, [req.params.id]);
    const prevPaid = Math.round(parseFloat(existing.rows[0]?.paid_amount || 0));
    const newRemaining = Math.max(safeAmount - prevPaid, 0);
    const newPayStatus = pay_status || (newRemaining === 0 && prevPaid > 0 ? 'paid' : prevPaid > 0 ? 'partial' : 'unpaid');

    const r = await pool.query(
      `UPDATE registrations SET name=$1, nickname=$2, grade=$3, parent_name=$4, parent_phone=$5, pay_status=$6, amount=$7, remaining=$8, months=$9, note=$10 WHERE id=$11 RETURNING *`,
      [name, nickname, grade, parent_name, parent_phone, newPayStatus, safeAmount, newRemaining, months, note, req.params.id]
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/registrations/:id', auth, adminOnly, async (req, res) => {
  try {
    await pool.query(`DELETE FROM registrations WHERE id=$1`, [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// STUDENTS
app.get('/api/students', auth, async (req, res) => {
  try {
    const { search = '', status = '', page = 1, limit = 40 } = req.query;
    const offset = (page - 1) * limit;
    let where = []; let params = [];
    if (search) { params.push(`%${search}%`); where.push(`(s.name ILIKE $${params.length} OR s.nickname ILIKE $${params.length} OR s.student_code ILIKE $${params.length})`); }
    if (status) { params.push(status); where.push(`s.status = $${params.length}`); }
    const whereStr = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const countRes = await pool.query(`SELECT COUNT(*) FROM students s ${whereStr}`, params);
    params.push(limit, offset);
    const data = await pool.query(`SELECT s.* FROM students s ${whereStr} ORDER BY s.created_at DESC LIMIT $${params.length-1} OFFSET $${params.length}`, params);
    res.json({ data: data.rows, total: +countRes.rows[0].count, page: +page, limit: +limit });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/students', auth, adminOnly, async (req, res) => {
  try {
    const { student_code, name, nickname, birth_date, phone, parent_name, parent_phone, address, note } = req.body;
    const r = await pool.query(`INSERT INTO students (student_code, name, nickname, birth_date, phone, parent_name, parent_phone, address, note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [student_code, name, nickname, birth_date || null, phone, parent_name, parent_phone, address, note]);
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/students/:id', auth, adminOnly, async (req, res) => {
  try {
    const { name, nickname, birth_date, phone, parent_name, parent_phone, address, status, note } = req.body;
    const r = await pool.query(`UPDATE students SET name=$1, nickname=$2, birth_date=$3, phone=$4, parent_name=$5, parent_phone=$6, address=$7, status=$8, note=$9 WHERE id=$10 RETURNING *`, [name, nickname, birth_date || null, phone, parent_name, parent_phone, address, status, note, req.params.id]);
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/students/:id', auth, adminOnly, async (req, res) => {
  try { await pool.query(`DELETE FROM students WHERE id=$1`, [req.params.id]); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// COURSES
app.get('/api/courses', auth, async (req, res) => {
  try {
    const { search = '', status = '', page = 1, limit = 40 } = req.query;
    const offset = (page - 1) * limit;
    let where = []; let params = [];
    if (search) { params.push(`%${search}%`); where.push(`(c.name ILIKE $${params.length} OR c.course_code ILIKE $${params.length})`); }
    if (status) { params.push(status); where.push(`c.status = $${params.length}`); }
    const whereStr = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const countRes = await pool.query(`SELECT COUNT(*) FROM courses c ${whereStr}`, params);
    params.push(limit, offset);
    const data = await pool.query(`SELECT c.* FROM courses c ${whereStr} ORDER BY c.created_at DESC LIMIT $${params.length-1} OFFSET $${params.length}`, params);
    res.json({ data: data.rows, total: +countRes.rows[0].count, page: +page, limit: +limit });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/courses', auth, adminOnly, async (req, res) => {
  try {
    const { course_code, name, subject, level, teacher, price, sessions_total, schedule, note } = req.body;
    const r = await pool.query(`INSERT INTO courses (course_code, name, subject, level, teacher, price, sessions_total, schedule, note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [course_code, name, subject, level, teacher, price || 0, sessions_total || 0, schedule, note]);
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/courses/:id', auth, adminOnly, async (req, res) => {
  try {
    const { name, subject, level, teacher, price, sessions_total, schedule, status, note } = req.body;
    const r = await pool.query(`UPDATE courses SET name=$1, subject=$2, level=$3, teacher=$4, price=$5, sessions_total=$6, schedule=$7, status=$8, note=$9 WHERE id=$10 RETURNING *`, [name, subject, level, teacher, price, sessions_total, schedule, status, note, req.params.id]);
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/courses/:id', auth, adminOnly, async (req, res) => {
  try { await pool.query(`DELETE FROM courses WHERE id=$1`, [req.params.id]); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ENROLLMENTS
app.get('/api/enrollments', auth, async (req, res) => {
  try {
    const { student_id, course_id, status = '', page = 1, limit = 40 } = req.query;
    const offset = (page - 1) * limit;
    let where = []; let params = [];
    if (student_id) { params.push(student_id); where.push(`e.student_id = $${params.length}`); }
    if (course_id) { params.push(course_id); where.push(`e.course_id = $${params.length}`); }
    if (status) { params.push(status); where.push(`e.status = $${params.length}`); }
    const whereStr = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const countRes = await pool.query(`SELECT COUNT(*) FROM enrollments e ${whereStr}`, params);
    params.push(limit, offset);
    const data = await pool.query(`SELECT e.*, s.name as student_name, s.student_code, s.nickname, c.name as course_name, c.course_code, c.subject, c.sessions_total, c.price FROM enrollments e JOIN students s ON e.student_id = s.id JOIN courses c ON e.course_id = c.id ${whereStr} ORDER BY e.enrolled_at DESC LIMIT $${params.length-1} OFFSET $${params.length}`, params);
    res.json({ data: data.rows, total: +countRes.rows[0].count, page: +page, limit: +limit });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/enrollments', auth, adminOnly, async (req, res) => {
  try {
    const { student_id, course_id, note } = req.body;
    const r = await pool.query(`INSERT INTO enrollments (student_id, course_id, note) VALUES ($1,$2,$3) ON CONFLICT (student_id, course_id) DO NOTHING RETURNING *`, [student_id, course_id, note]);
    res.json(r.rows[0] || { error: 'ลงทะเบียนแล้ว' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/enrollments/:id', auth, adminOnly, async (req, res) => {
  try {
    const { status, sessions_used, note } = req.body;
    const r = await pool.query(`UPDATE enrollments SET status=$1, sessions_used=$2, note=$3 WHERE id=$4 RETURNING *`, [status, sessions_used, note, req.params.id]);
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/enrollments/:id', auth, adminOnly, async (req, res) => {
  try { await pool.query(`DELETE FROM enrollments WHERE id=$1`, [req.params.id]); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// PAYMENTS
app.get('/api/payments', auth, async (req, res) => {
  try {
    const { student_id, month, page = 1, limit = 30 } = req.query;
    const offset = (page - 1) * limit;
    let where = []; let params = [];
    if (student_id) { params.push(student_id); where.push(`p.student_id = $${params.length}`); }
    if (month) { params.push(month); where.push(`TO_CHAR(p.paid_at, 'YYYY-MM') = $${params.length}`); }
    const whereStr = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const countRes = await pool.query(`SELECT COUNT(*), COALESCE(SUM(amount),0) as total FROM payments p ${whereStr}`, params);
    params.push(limit, offset);
    const data = await pool.query(`SELECT p.*, s.name as student_name FROM payments p JOIN students s ON p.student_id = s.id ${whereStr} ORDER BY p.paid_at DESC LIMIT $${params.length-1} OFFSET $${params.length}`, params);
    res.json({ data: data.rows, total: +countRes.rows[0].count, sum: +countRes.rows[0].total, page: +page, limit: +limit });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/payments', auth, async (req, res) => {
  try {
    const { student_id, course_id, amount, method, note } = req.body;
    const r = await pool.query(`INSERT INTO payments (student_id, course_id, amount, method, note, recorded_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [student_id, course_id || null, amount, method || 'cash', note, req.user.name || req.user.username]);
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/payments/:id', auth, adminOnly, async (req, res) => {
  try { await pool.query(`DELETE FROM payments WHERE id=$1`, [req.params.id]); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ATTENDANCES
app.get('/api/attendances', auth, async (req, res) => {
  try {
    const { registration_id, date, page = 1, limit = 50 } = req.query;
    const offset = (page - 1) * limit;
    let where = []; let params = [];
    if (registration_id) { params.push(registration_id); where.push(`a.registration_id = $${params.length}`); }
    if (date) { params.push(date); where.push(`DATE(a.attended_at) = $${params.length}`); }
    const whereStr = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const countRes = await pool.query(`SELECT COUNT(*) FROM attendances a ${whereStr}`, params);
    params.push(limit, offset);
    const data = await pool.query(
      `SELECT a.*, r.name as student_name, r.nickname
       FROM attendances a
       LEFT JOIN registrations r ON a.registration_id = r.id
       ${whereStr} ORDER BY a.attended_at DESC LIMIT $${params.length-1} OFFSET $${params.length}`,
      params
    );
    res.json({ data: data.rows, total: +countRes.rows[0].count, page: +page, limit: +limit });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/attendances', auth, async (req, res) => {
  try {
    const { registration_id, student_id, course_id, status, note } = req.body;
    const r = await pool.query(
      `INSERT INTO attendances (registration_id, student_id, course_id, status, note, recorded_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [registration_id || null, student_id || null, course_id || null, status || 'present', note, req.user.name || req.user.username]
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/attendances/:id', auth, adminOnly, async (req, res) => {
  try {
    const att = await pool.query(`SELECT * FROM attendances WHERE id=$1`, [req.params.id]);
    if (att.rows[0]?.enrollment_id && att.rows[0]?.status !== 'absent') {
      await pool.query(`UPDATE enrollments SET sessions_used = GREATEST(sessions_used - 1, 0) WHERE id = $1`, [att.rows[0].enrollment_id]);
    }
    await pool.query(`DELETE FROM attendances WHERE id=$1`, [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// USERS
app.get('/api/users', auth, adminOnly, async (req, res) => {
  try {
    const r = await pool.query(`SELECT id, username, role, name, created_at FROM users ORDER BY created_at`);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/users', auth, adminOnly, async (req, res) => {
  try {
    const { username, password, role, name } = req.body;
    const hash = await bcrypt.hash(password, 10);
    const r = await pool.query(`INSERT INTO users (username, password, role, name) VALUES ($1,$2,$3,$4) RETURNING id, username, role, name`, [username, hash, role || 'staff', name]);
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/users/:id', auth, adminOnly, async (req, res) => {
  try { await pool.query(`DELETE FROM users WHERE id=$1 AND username != 'admin'`, [req.params.id]); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/users/:id/password', auth, async (req, res) => {
  try {
    const { old_password, new_password } = req.body;
    const userRes = await pool.query(`SELECT * FROM users WHERE id=$1`, [req.params.id]);
    const user = userRes.rows[0];
    if (!user || !(await bcrypt.compare(old_password, user.password)))
      return res.status(401).json({ error: 'รหัสผ่านเดิมไม่ถูกต้อง' });
    const hash = await bcrypt.hash(new_password, 10);
    await pool.query(`UPDATE users SET password=$1 WHERE id=$2`, [hash, req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

initDB().then(() => {
  app.listen(PORT, () => console.log(`🚀 Krujum Tutor API running on port ${PORT}`));
});
