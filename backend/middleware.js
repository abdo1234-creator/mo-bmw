/* FILE: middleware.js | PURPOSE: JWT auth, file upload, input sanitization, login rate limiting | DEPENDS ON: jsonwebtoken, multer, uuid, express-rate-limit */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const rateLimit = require('express-rate-limit');

const JWT_SECRET = process.env.JWT_SECRET || (() => {
  console.warn('[WARN] JWT_SECRET is not set in .env — using an insecure development-only default. Set JWT_SECRET before deploying.');
  return 'dev-only-insecure-secret-change-me';
})();

function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.adminId = payload.sub;
    next();
  } catch {
    return res.status(401).json({ error: 'Unauthorized' });
  }
}

const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp'];
const EXT_BY_MIME = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = EXT_BY_MIME[file.mimetype] || path.extname(file.originalname) || '';
    cb(null, `${crypto.randomUUID()}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024, files: 10 },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MIME.includes(file.mimetype)) {
      return cb(new Error('INVALID_FILE_TYPE'));
    }
    cb(null, true);
  }
});

function stripHtml(value) {
  return value.replace(/<[^>]*>/g, '');
}

function sanitizeValue(value, maxLen) {
  if (typeof value === 'string') {
    if (value.length > maxLen) throw new Error('STRING_TOO_LONG');
    return stripHtml(value);
  }
  if (Array.isArray(value)) {
    return value.map(v => sanitizeValue(v, maxLen));
  }
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) out[k] = sanitizeValue(value[k], maxLen);
    return out;
  }
  return value;
}

function sanitize(req, res, next) {
  if (!req.body || typeof req.body !== 'object') return next();
  const maxLen = req.body && req.body.issue_description !== undefined ? 5000 : 2000;
  try {
    req.body = sanitizeValue(req.body, maxLen);
    next();
  } catch {
    res.status(400).json({ error: 'One or more fields exceed the maximum allowed length' });
  }
}

const rateLimitLogin = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please try again later.' }
});

module.exports = { authenticate, upload, sanitize, rateLimitLogin, JWT_SECRET, UPLOAD_DIR };
