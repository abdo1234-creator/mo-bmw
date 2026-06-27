/* FILE: server.js | PURPOSE: Express app wiring every REST API route for the CMS | DEPENDS ON: db.js, middleware.js, express, cors, jsonwebtoken, bcryptjs */
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const db = require('./db');
const { authenticate, upload, sanitize, rateLimitLogin, JWT_SECRET, UPLOAD_DIR } = require('./middleware');

const PORT = process.env.PORT || 3000;
const DEV_ORIGINS = ['http://localhost:3000', 'http://localhost:5500', 'http://127.0.0.1:5500', 'null'];
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim()) : [])
  .concat(DEV_ORIGINS);

const app = express();
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error('Not allowed by CORS'));
  }
}));
app.use(express.json({ limit: '1mb' }));
app.use('/uploads', express.static(UPLOAD_DIR));

// ───────────────────────── helpers ─────────────────────────
function notFound(res) { return res.status(404).json({ error: 'Not found' }); }
function badRequest(res, msg) { return res.status(400).json({ error: msg }); }
function parseJSON(value, fallback) { try { return JSON.parse(value); } catch { return fallback; } }
function rowExists(table, id) { return db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(id); }

function genRefNumber() {
  let ref;
  do {
    ref = '#MOB-' + (1000 + Math.floor(Math.random() * 9000));
  } while (db.prepare('SELECT id FROM bookings WHERE ref_number = ?').get(ref));
  return ref;
}

function csvEscape(v) {
  const s = v === null || v === undefined ? '' : String(v);
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}
function toCSV(rows, columns) {
  const header = columns.join(',');
  const lines = rows.map(r => columns.map(c => csvEscape(r[c])).join(','));
  return [header, ...lines].join('\n');
}

function modelOut(row) {
  return {
    id: row.id, name: row.name, years: row.years, img_url: row.img_url, tags: parseJSON(row.tags, []),
    series_id: row.series_id || null, series_banner_url: row.series_banner_url || null,
    sort_order: row.sort_order, created_at: row.created_at
  };
}

function activeDiscountForPart(part, discounts) {
  const now = Date.now();
  const candidates = discounts.filter(d => {
    if (!d.active) return false;
    if (d.expiry_date && new Date(d.expiry_date).getTime() < now) return false;
    if (d.applies_to === 'all_parts') return true;
    if (d.applies_to === 'category') return String(d.target_id) === String(part.category);
    if (d.applies_to === 'specific_part') return String(d.target_id) === String(part.id);
    return false;
  });
  if (!candidates.length) return null;
  return candidates[0];
}

function partOut(row, discounts, assignments) {
  const discount = activeDiscountForPart(row, discounts);
  let discountedPrice = null;
  if (discount) {
    discountedPrice = discount.type === 'percent'
      ? Math.max(0, row.price_egp * (1 - discount.value / 100))
      : Math.max(0, row.price_egp - discount.value);
    discountedPrice = Math.round(discountedPrice * 100) / 100;
  }
  return {
    id: row.id, cat: row.category, catAr: CAT_AR[row.category] || row.category,
    ar: row.name_ar, en: row.name_en, oem: row.oem,
    price_egp: row.price_egp, note: row.note, badge: row.badge,
    stock: !!row.in_stock, sort_order: row.sort_order, img_url: row.img_url || null,
    discount_id: discount ? discount.id : null,
    discounted_price_egp: discountedPrice,
    assignments: assignments || []
  };
}
const CAT_AR = { Engine: 'المحرك', Brakes: 'الفرامل', Suspension: 'التعليق', Electrical: 'الكهرباء', Tuning: 'التعديل' };

function getAssignmentsForParts(partIds) {
  if (!partIds.length) return {};
  const placeholders = partIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT pa.*, m.name AS model_name
    FROM part_assignments pa
    LEFT JOIN models m ON m.id = pa.model_id
    WHERE pa.part_id IN (${placeholders})
  `).all(...partIds);
  const map = {};
  rows.forEach(r => {
    if (!map[r.part_id]) map[r.part_id] = [];
    map[r.part_id].push({ id: r.id, series_id: r.series_id, model_id: r.model_id, model_name: r.model_name, engine_code: r.engine_code });
  });
  return map;
}
function assignmentsForOnePart(partId) {
  return (getAssignmentsForParts([Number(partId)])[Number(partId)]) || [];
}

// ════════════════════════ AUTH ════════════════════════
app.post('/api/auth/login', rateLimitLogin, (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return badRequest(res, 'Username and password required');
  const user = db.prepare('SELECT * FROM admin_users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  const expiresIn = 8 * 60 * 60;
  const token = jwt.sign({ sub: user.id, username: user.username }, JWT_SECRET, { expiresIn });
  res.json({ token, expiresAt: Date.now() + expiresIn * 1000 });
});

app.put('/api/auth/change-password', authenticate, sanitize, (req, res) => {
  const { current_password, new_password } = req.body || {};
  if (!current_password || !new_password) return badRequest(res, 'Both passwords required');
  const strong = /^(?=.*[A-Z])(?=.*[0-9]).{8,}$/;
  if (!strong.test(new_password)) return badRequest(res, 'New password must be at least 8 characters with 1 uppercase letter and 1 number');
  const user = db.prepare('SELECT * FROM admin_users WHERE id = ?').get(req.adminId);
  if (!user || !bcrypt.compareSync(current_password, user.password_hash)) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }
  const hash = bcrypt.hashSync(new_password, 12);
  db.prepare('UPDATE admin_users SET password_hash = ? WHERE id = ?').run(hash, user.id);
  res.json({ ok: true });
});

// ════════════════════════ MODELS ════════════════════════
app.get('/api/models', (req, res) => {
  const { series_id } = req.query;
  let sql = 'SELECT * FROM models';
  const params = [];
  if (series_id) { sql += ' WHERE series_id = ?'; params.push(series_id); }
  sql += ' ORDER BY sort_order ASC, id ASC';
  const rows = db.prepare(sql).all(...params);
  res.json(rows.map(modelOut));
});

app.post('/api/models', authenticate, sanitize, (req, res) => {
  const { name, years, img_url, tags, series_id, series_banner_url } = req.body || {};
  if (!name) return badRequest(res, 'name is required');
  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), -1) m FROM models').get().m;
  const info = db.prepare('INSERT INTO models (name, years, img_url, tags, series_id, series_banner_url, sort_order) VALUES (?,?,?,?,?,?,?)')
    .run(name, years || '', img_url || '', JSON.stringify(Array.isArray(tags) ? tags : []), series_id || null, series_banner_url || null, maxOrder + 1);
  res.status(201).json(modelOut(db.prepare('SELECT * FROM models WHERE id = ?').get(info.lastInsertRowid)));
});

app.put('/api/models/:id', authenticate, sanitize, (req, res) => {
  if (!rowExists('models', req.params.id)) return notFound(res);
  const existing = db.prepare('SELECT * FROM models WHERE id = ?').get(req.params.id);
  const { name, years, img_url, tags, series_id, series_banner_url } = req.body || {};
  db.prepare('UPDATE models SET name=?, years=?, img_url=?, tags=?, series_id=?, series_banner_url=? WHERE id=?').run(
    name ?? existing.name, years ?? existing.years, img_url ?? existing.img_url,
    JSON.stringify(Array.isArray(tags) ? tags : parseJSON(existing.tags, [])),
    series_id !== undefined ? (series_id || null) : existing.series_id,
    series_banner_url !== undefined ? (series_banner_url || null) : existing.series_banner_url,
    req.params.id
  );
  res.json(modelOut(db.prepare('SELECT * FROM models WHERE id = ?').get(req.params.id)));
});

app.delete('/api/models/:id', authenticate, (req, res) => {
  if (!rowExists('models', req.params.id)) return notFound(res);
  db.prepare('DELETE FROM models WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.put('/api/models/reorder', authenticate, (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids)) return badRequest(res, 'ids array required');
  const stmt = db.prepare('UPDATE models SET sort_order = ? WHERE id = ?');
  const tx = db.transaction(list => list.forEach((id, i) => stmt.run(i, id)));
  tx(ids);
  res.json({ ok: true });
});

// ════════════════════════ PARTS ════════════════════════
app.get('/api/parts', (req, res) => {
  const { category, search, page = 1, limit = 20, series_id, model_id, engine_code } = req.query;
  let sql = 'SELECT * FROM parts WHERE 1=1';
  const params = [];
  if (category && category !== 'All') { sql += ' AND category = ?'; params.push(category); }
  if (search) {
    sql += ' AND (name_ar LIKE ? OR name_en LIKE ? OR oem LIKE ?)';
    const like = `%${search}%`;
    params.push(like, like, like);
  }
  if (series_id) {
    sql += ` AND (
      NOT EXISTS (SELECT 1 FROM part_assignments WHERE part_id = parts.id)
      OR EXISTS (
        SELECT 1 FROM part_assignments
        WHERE part_id = parts.id
          AND series_id = ?
          AND (model_id IS NULL OR model_id = ?)
          AND (engine_code IS NULL OR engine_code = ?)
      )
    )`;
    params.push(series_id, model_id ? Number(model_id) : null, engine_code || null);
  }
  const all = db.prepare(sql).all(...params);
  const discounts = db.prepare('SELECT * FROM discounts').all();
  const p = Math.max(1, parseInt(page) || 1);
  const l = Math.max(1, Math.min(100, parseInt(limit) || 20));
  const start = (p - 1) * l;
  const pageRows = all.slice(start, start + l);
  const assignmentsMap = getAssignmentsForParts(pageRows.map(r => r.id));
  res.json({ total: all.length, page: p, limit: l, items: pageRows.map(r => partOut(r, discounts, assignmentsMap[r.id])) });
});

app.post('/api/parts', authenticate, sanitize, (req, res) => {
  const b = req.body || {};
  if (!b.ar || !b.cat) return badRequest(res, 'ar and cat are required');
  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), -1) m FROM parts').get().m;
  const info = db.prepare(`INSERT INTO parts (name_ar, name_en, category, oem, price_egp, note, badge, in_stock, img_url, sort_order)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    b.ar, b.en || '', b.cat, b.oem || '', Number(b.price_egp) || 0, b.note || '', b.badge || 'oem',
    b.stock === false ? 0 : 1, b.img_url || null, maxOrder + 1
  );
  const discounts = db.prepare('SELECT * FROM discounts').all();
  res.status(201).json(partOut(db.prepare('SELECT * FROM parts WHERE id = ?').get(info.lastInsertRowid), discounts, []));
});

app.put('/api/parts/:id', authenticate, sanitize, (req, res) => {
  const existing = db.prepare('SELECT * FROM parts WHERE id = ?').get(req.params.id);
  if (!existing) return notFound(res);
  const b = req.body || {};
  db.prepare(`UPDATE parts SET name_ar=?, name_en=?, category=?, oem=?, price_egp=?, note=?, badge=?, in_stock=?, img_url=? WHERE id=?`).run(
    b.ar ?? existing.name_ar, b.en ?? existing.name_en, b.cat ?? existing.category, b.oem ?? existing.oem,
    b.price_egp !== undefined ? Number(b.price_egp) : existing.price_egp, b.note ?? existing.note,
    b.badge ?? existing.badge, b.stock !== undefined ? (b.stock ? 1 : 0) : existing.in_stock,
    b.img_url !== undefined ? b.img_url : existing.img_url, req.params.id
  );
  const discounts = db.prepare('SELECT * FROM discounts').all();
  res.json(partOut(db.prepare('SELECT * FROM parts WHERE id = ?').get(req.params.id), discounts, assignmentsForOnePart(req.params.id)));
});

app.delete('/api/parts/:id', authenticate, (req, res) => {
  if (!rowExists('parts', req.params.id)) return notFound(res);
  db.prepare('DELETE FROM parts WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/parts/bulk-price', authenticate, (req, res) => {
  const { ids, type, value } = req.body || {};
  if (!Array.isArray(ids) || !ids.length || !['percent', 'fixed'].includes(type) || typeof value !== 'number') {
    return badRequest(res, 'ids[], type (percent|fixed) and numeric value are required');
  }
  const get = db.prepare('SELECT * FROM parts WHERE id = ?');
  const update = db.prepare('UPDATE parts SET price_egp = ? WHERE id = ?');
  const tx = db.transaction(list => {
    list.forEach(id => {
      const part = get.get(id);
      if (!part) return;
      const newPrice = type === 'percent' ? part.price_egp * (1 + value / 100) : part.price_egp + value;
      update.run(Math.max(0, Math.round(newPrice * 100) / 100), id);
    });
  });
  tx(ids);
  res.json({ ok: true, updated: ids.length });
});

// ── Part assignments (series / model / engine scoping) ──
app.get('/api/parts/:id/assignments', authenticate, (req, res) => {
  if (!rowExists('parts', req.params.id)) return notFound(res);
  res.json(assignmentsForOnePart(req.params.id));
});

app.post('/api/parts/:id/assignments', authenticate, sanitize, (req, res) => {
  if (!rowExists('parts', req.params.id)) return notFound(res);
  const { series_id, model_id, engine_code } = req.body || {};
  if (!series_id) return badRequest(res, 'series_id is required');
  try {
    const info = db.prepare('INSERT INTO part_assignments (part_id, series_id, model_id, engine_code) VALUES (?,?,?,?)')
      .run(req.params.id, series_id, model_id || null, engine_code || null);
    res.status(201).json({ id: info.lastInsertRowid, part_id: Number(req.params.id), series_id, model_id: model_id || null, engine_code: engine_code || null });
  } catch {
    res.status(409).json({ error: 'This assignment already exists' });
  }
});

app.delete('/api/parts/:id/assignments/:assignmentId', authenticate, (req, res) => {
  const row = db.prepare('SELECT id FROM part_assignments WHERE id = ? AND part_id = ?').get(req.params.assignmentId, req.params.id);
  if (!row) return notFound(res);
  db.prepare('DELETE FROM part_assignments WHERE id = ?').run(req.params.assignmentId);
  res.json({ ok: true });
});

app.put('/api/parts/:id/assignments/replace', authenticate, sanitize, (req, res) => {
  if (!rowExists('parts', req.params.id)) return notFound(res);
  const { assignments } = req.body || {};
  if (!Array.isArray(assignments)) return badRequest(res, 'assignments array is required');
  const tx = db.transaction(list => {
    db.prepare('DELETE FROM part_assignments WHERE part_id = ?').run(req.params.id);
    const ins = db.prepare('INSERT INTO part_assignments (part_id, series_id, model_id, engine_code) VALUES (?,?,?,?)');
    list.forEach(a => {
      if (!a || !a.series_id) return;
      ins.run(req.params.id, a.series_id, a.model_id || null, a.engine_code || null);
    });
  });
  tx(assignments);
  res.json(assignmentsForOnePart(req.params.id));
});

// ════════════════════════ DISCOUNTS ════════════════════════
app.get('/api/discounts', (req, res) => {
  res.json(db.prepare('SELECT * FROM discounts ORDER BY id DESC').all());
});

app.post('/api/discounts', authenticate, sanitize, (req, res) => {
  const b = req.body || {};
  if (!b.label || !['percent', 'fixed'].includes(b.type) || typeof b.value !== 'number' ||
      !['all_parts', 'category', 'specific_part', 'booking'].includes(b.applies_to)) {
    return badRequest(res, 'label, type, value and applies_to are required');
  }
  const info = db.prepare(`INSERT INTO discounts (label, type, value, applies_to, target_id, expiry_date, active)
    VALUES (?,?,?,?,?,?,?)`).run(
    b.label, b.type, b.value, b.applies_to, b.target_id ?? null, b.expiry_date ?? null, b.active === false ? 0 : 1
  );
  res.status(201).json(db.prepare('SELECT * FROM discounts WHERE id = ?').get(info.lastInsertRowid));
});

app.put('/api/discounts/:id', authenticate, sanitize, (req, res) => {
  const existing = db.prepare('SELECT * FROM discounts WHERE id = ?').get(req.params.id);
  if (!existing) return notFound(res);
  const b = req.body || {};
  db.prepare(`UPDATE discounts SET label=?, type=?, value=?, applies_to=?, target_id=?, expiry_date=?, active=? WHERE id=?`).run(
    b.label ?? existing.label, b.type ?? existing.type, b.value ?? existing.value, b.applies_to ?? existing.applies_to,
    b.target_id !== undefined ? b.target_id : existing.target_id, b.expiry_date !== undefined ? b.expiry_date : existing.expiry_date,
    b.active !== undefined ? (b.active ? 1 : 0) : existing.active, req.params.id
  );
  res.json(db.prepare('SELECT * FROM discounts WHERE id = ?').get(req.params.id));
});

app.delete('/api/discounts/:id', authenticate, (req, res) => {
  if (!rowExists('discounts', req.params.id)) return notFound(res);
  db.prepare('DELETE FROM discounts WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ════════════════════════ TESTIMONIALS ════════════════════════
app.get('/api/testimonials', (req, res) => {
  const { visible } = req.query;
  let rows;
  if (visible === 'true') rows = db.prepare('SELECT * FROM testimonials WHERE visible = 1 ORDER BY id DESC').all();
  else if (visible === 'false') rows = db.prepare('SELECT * FROM testimonials WHERE visible = 0 ORDER BY id DESC').all();
  else rows = db.prepare('SELECT * FROM testimonials ORDER BY id DESC').all();
  res.json(rows);
});

app.post('/api/testimonials', authenticate, sanitize, (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.quote) return badRequest(res, 'name and quote are required');
  const info = db.prepare('INSERT INTO testimonials (name, city, car, stars, quote, visible) VALUES (?,?,?,?,?,?)').run(
    b.name, b.city || '', b.car || '', Number(b.stars) || 5, b.quote, b.visible === false ? 0 : 1
  );
  res.status(201).json(db.prepare('SELECT * FROM testimonials WHERE id = ?').get(info.lastInsertRowid));
});

app.put('/api/testimonials/:id', authenticate, sanitize, (req, res) => {
  const existing = db.prepare('SELECT * FROM testimonials WHERE id = ?').get(req.params.id);
  if (!existing) return notFound(res);
  const b = req.body || {};
  db.prepare('UPDATE testimonials SET name=?, city=?, car=?, stars=?, quote=?, visible=? WHERE id=?').run(
    b.name ?? existing.name, b.city ?? existing.city, b.car ?? existing.car,
    b.stars !== undefined ? Number(b.stars) : existing.stars, b.quote ?? existing.quote,
    b.visible !== undefined ? (b.visible ? 1 : 0) : existing.visible, req.params.id
  );
  res.json(db.prepare('SELECT * FROM testimonials WHERE id = ?').get(req.params.id));
});

app.delete('/api/testimonials/:id', authenticate, (req, res) => {
  if (!rowExists('testimonials', req.params.id)) return notFound(res);
  db.prepare('DELETE FROM testimonials WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ════════════════════════ EVENTS ════════════════════════
app.get('/api/events', (req, res) => {
  const { upcoming } = req.query;
  let sql = 'SELECT * FROM events WHERE visible = 1';
  if (upcoming === 'true') sql += ' AND is_upcoming = 1';
  else if (upcoming === 'false') sql += ' AND is_upcoming = 0';
  sql += ' ORDER BY sort_order ASC, id ASC';
  res.json(db.prepare(sql).all());
});

app.post('/api/events', authenticate, sanitize, (req, res) => {
  const b = req.body || {};
  if (!b.name) return badRequest(res, 'name is required');
  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), -1) m FROM events').get().m;
  const info = db.prepare(`INSERT INTO events (name, event_type, badge_class, event_date, event_time, location, price_egp, total_spots, remaining_spots, image_url, is_upcoming, visible, sort_order)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    b.name, b.event_type || '', b.badge_class || '', b.event_date || '', b.event_time || '', b.location || '',
    Number(b.price_egp) || 0, Number(b.total_spots) || 0, Number(b.remaining_spots) || 0, b.image_url || null,
    b.is_upcoming === false ? 0 : 1, b.visible === false ? 0 : 1, maxOrder + 1
  );
  res.status(201).json(db.prepare('SELECT * FROM events WHERE id = ?').get(info.lastInsertRowid));
});

app.put('/api/events/:id', authenticate, sanitize, (req, res) => {
  const existing = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
  if (!existing) return notFound(res);
  const b = req.body || {};
  db.prepare(`UPDATE events SET name=?, event_type=?, badge_class=?, event_date=?, event_time=?, location=?, price_egp=?, total_spots=?, remaining_spots=?, image_url=?, is_upcoming=?, visible=? WHERE id=?`).run(
    b.name ?? existing.name, b.event_type ?? existing.event_type, b.badge_class ?? existing.badge_class,
    b.event_date ?? existing.event_date, b.event_time ?? existing.event_time, b.location ?? existing.location,
    b.price_egp !== undefined ? Number(b.price_egp) : existing.price_egp,
    b.total_spots !== undefined ? Number(b.total_spots) : existing.total_spots,
    b.remaining_spots !== undefined ? Number(b.remaining_spots) : existing.remaining_spots,
    b.image_url !== undefined ? b.image_url : existing.image_url,
    b.is_upcoming !== undefined ? (b.is_upcoming ? 1 : 0) : existing.is_upcoming,
    b.visible !== undefined ? (b.visible ? 1 : 0) : existing.visible, req.params.id
  );
  res.json(db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id));
});

app.delete('/api/events/:id', authenticate, (req, res) => {
  if (!rowExists('events', req.params.id)) return notFound(res);
  db.prepare('DELETE FROM events WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ════════════════════════ BOOKINGS ════════════════════════
const PHONE_RE = /^01[0-9]{9}$/;

app.get('/api/bookings', authenticate, (req, res) => {
  const { status, payment_status, service_type, from, to, page = 1, limit = 20 } = req.query;
  let sql = 'SELECT * FROM bookings WHERE 1=1';
  const params = [];
  if (status) { sql += ' AND status = ?'; params.push(status); }
  if (payment_status) { sql += ' AND payment_status = ?'; params.push(payment_status); }
  if (service_type) { sql += ' AND service_type = ?'; params.push(service_type); }
  if (from) { sql += ' AND created_at >= ?'; params.push(from); }
  if (to) { sql += ' AND created_at <= ?'; params.push(to); }
  sql += ' ORDER BY created_at DESC';
  const all = db.prepare(sql).all(...params);
  const p = Math.max(1, parseInt(page) || 1);
  const l = Math.max(1, Math.min(100, parseInt(limit) || 20));
  const start = (p - 1) * l;
  res.json({ total: all.length, page: p, limit: l, items: all.slice(start, start + l) });
});

app.post('/api/bookings', sanitize, (req, res) => {
  const b = req.body || {};
  if (!b.service_type || !['quick', 'full', 'tuning', 'pickup'].includes(b.service_type)) {
    return badRequest(res, 'Valid service_type is required');
  }
  if (!b.customer_phone || !PHONE_RE.test(b.customer_phone)) {
    return badRequest(res, 'A valid Egyptian phone number is required (01XXXXXXXXX)');
  }
  if (!b.car_model) return badRequest(res, 'car_model is required');
  if (b.service_type === 'pickup' && !b.address) return badRequest(res, 'address is required for pickup bookings');
  if (b.service_type === 'tuning' && !b.tuning_stage) return badRequest(res, 'tuning_stage is required for tuning bookings');
  if (b.payment_method && !['cash', 'bank', 'wallet'].includes(b.payment_method)) {
    return badRequest(res, 'Invalid payment_method');
  }

  const ref = genRefNumber();
  const paymentStatus = b.payment_method ? 'pending' : null;
  const info = db.prepare(`INSERT INTO bookings (ref_number, service_type, customer_phone, customer_email, car_model, slot_datetime, issue_description, address, delivery_range, status, payment_method, payment_status, payment_screenshot_url, tuning_stage)
    VALUES (?,?,?,?,?,?,?,?,?,'pending',?,?,?,?)`).run(
    ref, b.service_type, b.customer_phone, b.customer_email || '', b.car_model, b.slot_datetime || '',
    b.issue_description || '', b.address || '', b.delivery_range || '',
    b.payment_method || null, paymentStatus, b.payment_screenshot_url || null, b.tuning_stage || null
  );
  res.status(201).json(db.prepare('SELECT * FROM bookings WHERE id = ?').get(info.lastInsertRowid));
});

app.put('/api/bookings/:id', authenticate, sanitize, (req, res) => {
  const existing = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);
  if (!existing) return notFound(res);
  const b = req.body || {};
  if (b.status && !['pending', 'confirmed', 'cancelled'].includes(b.status)) return badRequest(res, 'Invalid status');
  if (b.payment_status && !['pending', 'confirmed', 'rejected'].includes(b.payment_status)) {
    return badRequest(res, 'Invalid payment_status');
  }
  const nextPaymentStatus = b.payment_status !== undefined ? b.payment_status : existing.payment_status;
  const paymentConfirmedAt = nextPaymentStatus === 'confirmed' && existing.payment_status !== 'confirmed'
    ? new Date().toISOString()
    : (nextPaymentStatus === 'confirmed' ? existing.payment_confirmed_at : null);
  db.prepare('UPDATE bookings SET status=?, admin_notes=?, payment_status=?, payment_admin_note=?, agreed_amount=?, payment_confirmed_at=? WHERE id=?').run(
    b.status ?? existing.status,
    b.admin_notes !== undefined ? b.admin_notes : existing.admin_notes,
    nextPaymentStatus,
    b.payment_admin_note !== undefined ? b.payment_admin_note : existing.payment_admin_note,
    b.agreed_amount !== undefined ? b.agreed_amount : existing.agreed_amount,
    paymentConfirmedAt,
    req.params.id
  );
  res.json(db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id));
});

app.delete('/api/bookings/:id', authenticate, (req, res) => {
  if (!rowExists('bookings', req.params.id)) return notFound(res);
  db.prepare('DELETE FROM bookings WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/bookings/export', authenticate, (req, res) => {
  const rows = db.prepare('SELECT * FROM bookings ORDER BY created_at DESC').all();
  const csv = toCSV(rows, ['id', 'ref_number', 'service_type', 'tuning_stage', 'customer_phone', 'customer_email', 'car_model', 'slot_datetime', 'issue_description', 'address', 'delivery_range', 'status', 'payment_method', 'payment_status', 'agreed_amount', 'admin_notes', 'created_at']);
  res.setHeader('Content-Disposition', 'attachment; filename="bookings.csv"');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.send(csv);
});

app.get('/api/bookings/customer/:phone', (req, res) => {
  const phone = String(req.params.phone || '').trim();
  const rows = db.prepare(`SELECT ref_number, service_type, car_model, slot_datetime, status, created_at, issue_description, payment_status, agreed_amount, tuning_stage
    FROM bookings WHERE customer_phone = ? ORDER BY created_at DESC`).all(phone);
  res.json(rows);
});

// ════════════════════════ SPARE PARTS ORDERS ════════════════════════
function genOrderRefNumber() {
  let ref;
  do {
    ref = '#ORD-' + (1000 + Math.floor(Math.random() * 9000));
  } while (db.prepare('SELECT id FROM orders WHERE ref_number = ?').get(ref));
  return ref;
}

function attachOrderItems(order) {
  order.items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id);
  return order;
}

app.get('/api/orders', authenticate, (req, res) => {
  const { status, payment_status, from, to, page = 1, limit = 20 } = req.query;
  let sql = 'SELECT * FROM orders WHERE 1=1';
  const params = [];
  if (status) { sql += ' AND status = ?'; params.push(status); }
  if (payment_status) { sql += ' AND payment_status = ?'; params.push(payment_status); }
  if (from) { sql += ' AND created_at >= ?'; params.push(from); }
  if (to) { sql += ' AND created_at <= ?'; params.push(to); }
  sql += ' ORDER BY created_at DESC';
  const all = db.prepare(sql).all(...params);
  const p = Math.max(1, parseInt(page) || 1);
  const l = Math.max(1, Math.min(100, parseInt(limit) || 20));
  const start = (p - 1) * l;
  const pageItems = all.slice(start, start + l).map(attachOrderItems);
  res.json({ total: all.length, page: p, limit: l, items: pageItems });
});

app.post('/api/orders', sanitize, (req, res) => {
  const b = req.body || {};
  if (!b.customer_phone || !PHONE_RE.test(b.customer_phone)) {
    return badRequest(res, 'A valid Egyptian phone number is required (01XXXXXXXXX)');
  }
  if (!Array.isArray(b.items) || !b.items.length) return badRequest(res, 'At least one item is required');
  if (!b.delivery_address) return badRequest(res, 'delivery_address is required');
  if (b.payment_method && !['cash', 'bank', 'wallet'].includes(b.payment_method)) {
    return badRequest(res, 'Invalid payment_method');
  }
  for (const it of b.items) {
    if (!it.name || typeof it.price !== 'number' || it.price < 0 || !Number.isInteger(it.qty) || it.qty < 1) {
      return badRequest(res, 'Invalid item in cart');
    }
  }
  const total = b.items.reduce((sum, it) => sum + it.price * it.qty, 0);
  const ref = genOrderRefNumber();
  const paymentStatus = b.payment_method ? 'pending' : null;

  const insertOrder = db.prepare(`INSERT INTO orders (ref_number, customer_phone, customer_email, customer_name, delivery_address, delivery_range, status, payment_method, payment_status, payment_screenshot_url, total_amount)
    VALUES (?,?,?,?,?,?,'pending',?,?,?,?)`);
  const insertItem = db.prepare('INSERT INTO order_items (order_id, part_id, part_name, part_oem, unit_price, quantity) VALUES (?,?,?,?,?,?)');
  const tx = db.transaction(() => {
    const info = insertOrder.run(
      ref, b.customer_phone, b.customer_email || '', b.customer_name || '', b.delivery_address, b.delivery_range || '',
      b.payment_method || null, paymentStatus, b.payment_screenshot_url || null, total
    );
    const orderId = info.lastInsertRowid;
    b.items.forEach(it => insertItem.run(orderId, it.part_id || null, it.name, it.oem || '', it.price, it.qty));
    return orderId;
  });
  const orderId = tx();
  res.status(201).json(attachOrderItems(db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId)));
});

app.put('/api/orders/:id', authenticate, sanitize, (req, res) => {
  const existing = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!existing) return notFound(res);
  const b = req.body || {};
  if (b.status && !['pending', 'confirmed', 'cancelled'].includes(b.status)) return badRequest(res, 'Invalid status');
  if (b.payment_status && !['pending', 'confirmed', 'rejected'].includes(b.payment_status)) {
    return badRequest(res, 'Invalid payment_status');
  }
  const nextPaymentStatus = b.payment_status !== undefined ? b.payment_status : existing.payment_status;
  const paymentConfirmedAt = nextPaymentStatus === 'confirmed' && existing.payment_status !== 'confirmed'
    ? new Date().toISOString()
    : (nextPaymentStatus === 'confirmed' ? existing.payment_confirmed_at : null);
  db.prepare('UPDATE orders SET status=?, admin_notes=?, payment_status=?, payment_admin_note=?, agreed_amount=?, payment_confirmed_at=? WHERE id=?').run(
    b.status ?? existing.status,
    b.admin_notes !== undefined ? b.admin_notes : existing.admin_notes,
    nextPaymentStatus,
    b.payment_admin_note !== undefined ? b.payment_admin_note : existing.payment_admin_note,
    b.agreed_amount !== undefined ? b.agreed_amount : existing.agreed_amount,
    paymentConfirmedAt,
    req.params.id
  );
  res.json(attachOrderItems(db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id)));
});

app.delete('/api/orders/:id', authenticate, (req, res) => {
  if (!rowExists('orders', req.params.id)) return notFound(res);
  db.prepare('DELETE FROM orders WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/orders/export', authenticate, (req, res) => {
  const rows = db.prepare('SELECT * FROM orders ORDER BY created_at DESC').all();
  const csv = toCSV(rows, ['id', 'ref_number', 'customer_phone', 'customer_email', 'customer_name', 'delivery_address', 'delivery_range', 'status', 'payment_method', 'payment_status', 'agreed_amount', 'total_amount', 'admin_notes', 'created_at']);
  res.setHeader('Content-Disposition', 'attachment; filename="orders.csv"');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.send(csv);
});

app.get('/api/orders/customer/:phone', (req, res) => {
  const phone = String(req.params.phone || '').trim();
  const rows = db.prepare(`SELECT id, ref_number, status, payment_method, payment_status, agreed_amount, total_amount, created_at
    FROM orders WHERE customer_phone = ? ORDER BY created_at DESC`).all(phone);
  const itemsStmt = db.prepare('SELECT part_name, part_oem, unit_price, quantity FROM order_items WHERE order_id = ?');
  rows.forEach(o => { o.items = itemsStmt.all(o.id); delete o.id; });
  res.json(rows);
});

// ════════════════════════ SERVICE CONFIG ════════════════════════
const VALID_CFG_KEYS = ['quick_service', 'full_service', 'tuning_stages', 'tuning_slots', 'pickup_tiers', 'pickup_slots', 'catalog_series', 'catalog_engine_map'];

app.get('/api/service-config/:key', (req, res) => {
  const row = db.prepare('SELECT value FROM service_config WHERE key = ?').get(req.params.key);
  if (!row) return notFound(res);
  res.json({ value: parseJSON(row.value, null) });
});

app.put('/api/service-config/:key', authenticate, (req, res) => {
  if (!VALID_CFG_KEYS.includes(req.params.key)) return badRequest(res, 'Unknown config key');
  const { value } = req.body || {};
  if (value === undefined) return badRequest(res, 'value is required');
  db.prepare('INSERT INTO service_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(req.params.key, JSON.stringify(value));
  res.json({ key: req.params.key, value });
});

// ════════════════════════ SITE SETTINGS ════════════════════════
app.get('/api/settings', (req, res) => {
  const rows = db.prepare('SELECT key, value FROM site_settings').all();
  const out = {};
  rows.forEach(r => { out[r.key] = r.value; });
  res.json(out);
});

app.put('/api/settings', authenticate, sanitize, (req, res) => {
  const { key, value } = req.body || {};
  if (!key) return badRequest(res, 'key is required');
  db.prepare('INSERT INTO site_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value ?? ''));
  res.json({ key, value });
});

app.put('/api/settings/batch', authenticate, sanitize, (req, res) => {
  const { settings } = req.body || {};
  if (!settings || typeof settings !== 'object') return badRequest(res, 'settings object is required');
  const stmt = db.prepare('INSERT INTO site_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  const tx = db.transaction(entries => entries.forEach(([k, v]) => stmt.run(k, String(v ?? ''))));
  tx(Object.entries(settings));
  res.json({ ok: true });
});

// ════════════════════════ MEDIA ════════════════════════
app.post('/api/media/upload', authenticate, (req, res) => {
  upload.array('files', 10)(req, res, err => {
    if (err) {
      if (err.message === 'INVALID_FILE_TYPE') return badRequest(res, 'Only JPEG/PNG/WebP images allowed');
      return badRequest(res, err.message || 'Upload failed');
    }
    const files = req.files || [];
    if (!files.length) return badRequest(res, 'No files uploaded');
    const entity_type = req.body.entity_type ? String(req.body.entity_type).replace(/<[^>]*>/g, '').slice(0, 100) : null;
    const entity_id = req.body.entity_id ? String(req.body.entity_id).replace(/<[^>]*>/g, '').slice(0, 100) : null;
    const insert = db.prepare('INSERT INTO media (uuid_name, original_name, mime_type, size_bytes, entity_type, entity_id) VALUES (?,?,?,?,?,?)');
    const results = files.map(f => {
      const info = insert.run(f.filename, f.originalname, f.mimetype, f.size, entity_type, entity_id);
      return { id: info.lastInsertRowid, url: `/uploads/${f.filename}`, original_name: f.originalname, size: f.size };
    });
    res.status(201).json(results);
  });
});

app.delete('/api/media/:id', authenticate, (req, res) => {
  const row = db.prepare('SELECT * FROM media WHERE id = ?').get(req.params.id);
  if (!row) return notFound(res);
  const filePath = path.join(UPLOAD_DIR, row.uuid_name);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  db.prepare('DELETE FROM media WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ════════════════════════ PAYMENT SCREENSHOT UPLOAD (public — customer booking flow) ════════════════════════
app.post('/api/uploads/payment-screenshot', (req, res) => {
  upload.single('file')(req, res, err => {
    if (err) {
      if (err.message === 'INVALID_FILE_TYPE') return badRequest(res, 'Only JPEG/PNG/WebP images allowed');
      return badRequest(res, err.message || 'Upload failed');
    }
    if (!req.file) return badRequest(res, 'No file uploaded');
    res.status(201).json({ url: `/uploads/${req.file.filename}` });
  });
});

app.get('/api/media', authenticate, (req, res) => {
  const { entity_type, entity_id } = req.query;
  let sql = 'SELECT * FROM media WHERE 1=1';
  const params = [];
  if (entity_type) { sql += ' AND entity_type = ?'; params.push(entity_type); }
  if (entity_id) { sql += ' AND entity_id = ?'; params.push(entity_id); }
  sql += ' ORDER BY uploaded_at DESC';
  res.json(db.prepare(sql).all(...params).map(r => ({ ...r, url: `/uploads/${r.uuid_name}` })));
});

// ════════════════════════ NEWSLETTER ════════════════════════
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

app.post('/api/newsletter', sanitize, (req, res) => {
  const { email } = req.body || {};
  if (!email || !EMAIL_RE.test(email)) return badRequest(res, 'A valid email is required');
  try {
    db.prepare('INSERT INTO newsletter (email) VALUES (?)').run(email.toLowerCase().trim());
  } catch {
    // duplicate email — ignore silently, still report success
  }
  res.status(201).json({ ok: true });
});

app.get('/api/newsletter', authenticate, (req, res) => {
  res.json(db.prepare('SELECT * FROM newsletter ORDER BY subscribed_at DESC').all());
});

app.delete('/api/newsletter/:id', authenticate, (req, res) => {
  if (!rowExists('newsletter', req.params.id)) return notFound(res);
  db.prepare('DELETE FROM newsletter WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/newsletter/export', authenticate, (req, res) => {
  const rows = db.prepare('SELECT * FROM newsletter ORDER BY subscribed_at DESC').all();
  const csv = toCSV(rows, ['id', 'email', 'subscribed_at']);
  res.setHeader('Content-Disposition', 'attachment; filename="newsletter.csv"');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.send(csv);
});

// ════════════════════════ CUSTOMERS (VIN) ════════════════════════
const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/;

function customerPublicOut(row) {
  return {
    vin: row.vin,
    customer_name: row.customer_name || null,
    customer_phone: row.customer_phone || null,
    car_model: row.car_model,
    total_spent_egp: row.total_spent_egp,
    car_status: row.car_status,
    last_service_date: row.last_service_date
  };
}

app.get('/api/customers/vin/:vin', (req, res) => {
  const vin = String(req.params.vin || '').toUpperCase().trim();
  const row = db.prepare('SELECT * FROM customers WHERE vin = ?').get(vin);
  if (!row) return res.status(404).json({ error: 'Customer not found' });
  res.json(customerPublicOut(row));
});

app.get('/api/customers', authenticate, (req, res) => {
  res.json(db.prepare('SELECT * FROM customers ORDER BY created_at DESC').all());
});

app.post('/api/customers', authenticate, sanitize, (req, res) => {
  const b = req.body || {};
  const vin = String(b.vin || '').toUpperCase().trim();
  if (!VIN_RE.test(vin)) return badRequest(res, 'VIN must be exactly 17 characters (no I, O, or Q)');
  if (b.car_status && !['ready', 'in_service'].includes(b.car_status)) return badRequest(res, 'Invalid car_status');
  const total = Number(b.total_spent_egp) || 0;
  if (total < 0) return badRequest(res, 'total_spent_egp must be >= 0');
  if (db.prepare('SELECT id FROM customers WHERE vin = ?').get(vin)) {
    return res.status(409).json({ error: 'A customer with this VIN already exists' });
  }
  const info = db.prepare(`INSERT INTO customers (vin, customer_name, customer_phone, car_model, total_spent_egp, car_status, last_service_date, notes)
    VALUES (?,?,?,?,?,?,?,?)`).run(
    vin, b.customer_name || null, b.customer_phone || null, b.car_model || '', total, b.car_status || 'ready', b.last_service_date || null, b.notes || ''
  );
  res.status(201).json(db.prepare('SELECT * FROM customers WHERE id = ?').get(info.lastInsertRowid));
});

app.put('/api/customers/:id', authenticate, sanitize, (req, res) => {
  const existing = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
  if (!existing) return notFound(res);
  const b = req.body || {};
  if (b.car_status && !['ready', 'in_service'].includes(b.car_status)) return badRequest(res, 'Invalid car_status');
  if (b.total_spent_egp !== undefined && Number(b.total_spent_egp) < 0) return badRequest(res, 'total_spent_egp must be >= 0');
  db.prepare(`UPDATE customers SET customer_name=?, customer_phone=?, car_model=?, total_spent_egp=?, car_status=?, last_service_date=?, notes=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(
    b.customer_name !== undefined ? (b.customer_name || null) : existing.customer_name,
    b.customer_phone !== undefined ? (b.customer_phone || null) : existing.customer_phone,
    b.car_model ?? existing.car_model,
    b.total_spent_egp !== undefined ? Number(b.total_spent_egp) : existing.total_spent_egp,
    b.car_status ?? existing.car_status,
    b.last_service_date !== undefined ? b.last_service_date : existing.last_service_date,
    b.notes ?? existing.notes,
    req.params.id
  );
  res.json(db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id));
});

app.delete('/api/customers/:id', authenticate, (req, res) => {
  if (!rowExists('customers', req.params.id)) return notFound(res);
  db.prepare('DELETE FROM customers WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/customers/export', authenticate, (req, res) => {
  const rows = db.prepare('SELECT * FROM customers ORDER BY created_at DESC').all();
  const csv = toCSV(rows, ['id', 'vin', 'car_model', 'total_spent_egp', 'car_status', 'last_service_date', 'notes', 'created_at', 'updated_at']);
  res.setHeader('Content-Disposition', 'attachment; filename="customers.csv"');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.send(csv);
});

// ════════════════════════ DASHBOARD ════════════════════════
app.get('/api/dashboard/stats', authenticate, (req, res) => {
  const models_count = db.prepare('SELECT COUNT(*) c FROM models').get().c;
  const parts_count = db.prepare('SELECT COUNT(*) c FROM parts').get().c;
  const bookings_total = db.prepare('SELECT COUNT(*) c FROM bookings').get().c;
  const bookings_pending = db.prepare("SELECT COUNT(*) c FROM bookings WHERE status = 'pending'").get().c;
  const events_upcoming = db.prepare('SELECT COUNT(*) c FROM events WHERE is_upcoming = 1 AND visible = 1').get().c;
  const newsletter_count = db.prepare('SELECT COUNT(*) c FROM newsletter').get().c;
  const recent_bookings = db.prepare('SELECT * FROM bookings ORDER BY created_at DESC LIMIT 10').all();
  res.json({ models_count, parts_count, bookings_total, bookings_pending, events_upcoming, newsletter_count, recent_bookings });
});

// ════════════════════════ ERROR HANDLING ════════════════════════
app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`MO BY AHMED MAHMOUD backend running on http://localhost:${PORT}`);
});
