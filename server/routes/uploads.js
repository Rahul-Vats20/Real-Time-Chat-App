// routes/uploads.js - File upload handling
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// ── Storage config ────────────────────────────────────────
const UPLOAD_DIR = path.join(__dirname, '../../client/public/uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
};

const MAX_SIZE = 10 * 1024 * 1024; // 10MB

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const date = new Date();
    const subDir = path.join(UPLOAD_DIR, `${date.getFullYear()}/${date.getMonth() + 1}`);
    fs.mkdirSync(subDir, { recursive: true });
    cb(null, subDir);
  },
  filename: (req, file, cb) => {
    const ext = ALLOWED_TYPES[file.mimetype] || 'bin';
    const hash = crypto.randomBytes(12).toString('hex');
    cb(null, `${hash}.${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_SIZE },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_TYPES[file.mimetype]) {
      cb(null, true);
    } else {
      cb(new Error(`File type not allowed: ${file.mimetype}`));
    }
  },
});

// POST /api/uploads - Upload a file
router.post('/', requireAuth, upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file provided' });
  }

  const date = new Date();
  const relativePath = `/uploads/${date.getFullYear()}/${date.getMonth() + 1}/${req.file.filename}`;

  res.json({
    url: relativePath,
    filename: req.file.originalname,
    mimetype: req.file.mimetype,
    size: req.file.size,
    isImage: req.file.mimetype.startsWith('image/'),
  });
});

// Error handler for multer
router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: `File too large. Max size is ${MAX_SIZE / 1024 / 1024}MB` });
    }
  }
  res.status(400).json({ error: err.message || 'Upload failed' });
});

module.exports = router;
