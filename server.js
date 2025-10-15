// server.js
const express = require('express');
const nodemailer = require('nodemailer');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

/* ========================= CONFIG ========================= */
const SMTP_HOST = "avocarbon-com.mail.protection.outlook.com";
const SMTP_PORT = 25;
const EMAIL_FROM_NAME = "Administration STS";
const EMAIL_FROM = "administration.STS@avocarbon.com";
const MIN_IMAGE_SIZE = 1024; // bytes (1KB) – protège contre les payloads tronquées

/* ========================= FS ========================= */
const imagesDir = path.join(__dirname, 'images');
if (!fs.existsSync(imagesDir)) fs.mkdirSync(imagesDir, { recursive: true });

/* ========================= MIDDLEWARE ========================= */
// Global – utile pour les autres routes
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

/* ========================= MULTER (multipart) ========================= */
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, imagesDir),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${Math.round(Math.random()*1e9)}${path.extname(file.originalname)}`)
});
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /jpeg|jpg|png|gif|bmp|webp/.test(file.mimetype);
    ok ? cb(null, true) : cb(new Error('Format non supporté'));
  }
});

/* ========================= SMTP ========================= */
const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: false,
  tls: { rejectUnauthorized: false }
});
transporter.verify(err => {
  if (err) console.log('✗ SMTP Error:', err.message);
  else console.log('✓ SMTP Ready');
});

/* ========================= HELPERS ========================= */
function normalizeBase64Payload(raw) {
  if (!raw || typeof raw !== 'string') throw new Error('Payload Base64 manquante');
  let b64 = raw.trim();

  // Extraire dataURL si présente
  if (b64.startsWith('data:')) {
    const m = b64.match(/^data:([^;]+);base64,(.*)$/);
    if (m) b64 = m[2];
  } else if (b64.includes('base64,')) {
    b64 = b64.split('base64,').pop();
  }

  // Si URL-encodé (%xx), décoder
  if (/%[0-9A-Fa-f]{2}/.test(b64)) {
    try { b64 = decodeURIComponent(b64); } catch { /* ignore */ }
  }

  // x-www-form-urlencoded : espaces → '+'
  b64 = b64.replace(/ /g, '+');

  // base64url → base64 standard
  b64 = b64.replace(/-/g, '+').replace(/_/g, '/');

  // Nettoyage doux : CR/LF/TAB
  b64 = b64.replace(/[\r\n\t]/g, '');

  // Retirer les caractères non base64 restants (tolérant)
  b64 = b64.replace(/[^A-Za-z0-9+/=]/g, '');

  // Padding
  const mod = b64.length % 4;
  if (mod === 2) b64 += '==';
  else if (mod === 3) b64 += '=';
  else if (mod === 1) throw new Error('Base64 invalide (longueur %4 == 1)');

  return b64;
}

function sniffImageType(buffer) {
  const m = buffer.slice(0, 8);
  if (m[0] === 0x89 && m[1] === 0x50 && m[2] === 0x4E && m[3] === 0x47) return { type: 'image/png', ext: '.png' };
  if (m[0] === 0xFF && m[1] === 0xD8 && m[2] === 0xFF) return { type: 'image/jpeg', ext: '.jpg' };
  if (m[0] === 0x47 && m[1] === 0x49 && m[2] === 0x46) return { type: 'image/gif', ext: '.gif' };
  if (m[0] === 0x42 && m[1] === 0x4D) return { type: 'image/bmp', ext: '.bmp' };
  return { type: 'unknown', ext: '.bin' };
}

function decodeAndSaveImage(base64String, filename) {
  // Log utile au debug
  console.log('\n--- DÉCODAGE IMAGE ---');
  console.log(`Input length: ${base64String?.length ?? 0} chars`);

  const b64 = normalizeBase64Payload(base64String);
  const estBytes = Math.floor((b64.replace(/=+$/, '').length * 3) / 4);
  console.log(`Normalized length: ${b64.length} chars (≈${estBytes} bytes attendus)`);

  const buffer = Buffer.from(b64, 'base64');
  console.log(`Buffer size: ${buffer.length} bytes`);
  console.log('Hex head:', buffer.slice(0, 12).toString('hex'));

  if (buffer.length < MIN_IMAGE_SIZE) {
    throw new Error(`Image corrompue/tronquée (taille ${buffer.length} bytes < ${MIN_IMAGE_SIZE})`);
  }

  const sniff = sniffImageType(buffer);
  let finalFilename = (filename || `image_${Date.now()}`).replace(/\.[^.]+$/, '') + sniff.ext;
  const filepath = path.join(imagesDir, finalFilename);
  fs.writeFileSync(filepath, buffer);

  console.log(`✓ Saved: ${finalFilename} (${sniff.type})\n`);
  return { filepath, buffer, filename: finalFilename, mimeType: sniff.type, size: buffer.length };
}

/* ========================= ROUTES ========================= */
app.get('/', (_req, res) => {
  res.json({
    status: 'online',
    version: '4.3 - PJ fiable',
    endpoints: {
      'POST /send-email-base64': 'Email avec image en Base64 (JSON uniquement)',
      'POST /send-email-with-image': 'Email avec upload fichier (multipart)',
      'POST /test-decode': 'Tester le décodage local',
      'GET /images': 'Lister les images sauvegardées'
    }
  });
});

app.post('/test-decode', (req, res) => {
  try {
    const { imageBase64, testName } = req.body;
    if (!imageBase64) return res.status(400).json({ error: 'imageBase64 requis' });

    const result = decodeAndSaveImage(imageBase64, (testName || `test_${Date.now()}`) + '.png');
    res.json({
      success: true,
      message: 'Image décodée avec succès',
      data: {
        filename: result.filename,
        size: result.size,
        mimeType: result.mimeType,
        path: `/images/${result.filename}`
      }
    });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

// ==== Envoi avec Base64 en JSON (recommandé si tu ne peux pas faire multipart) ====
app.post('/send-email-base64', express.json({ limit: '100mb' }), async (req, res) => {
  try {
    const { to, subject, message, imageBase64, imageName } = req.body;

    if (!to || !subject || !message) {
      return res.status(400).json({ success: false, error: 'Champs "to", "subject" et "message" requis' });
    }
    if (!imageBase64) {
      return res.status(400).json({ success: false, error: 'Champ "imageBase64" requis' });
    }

    const img = decodeAndSaveImage(imageBase64, imageName || `image_${Date.now()}.jpg`);
    if (img.size < MIN_IMAGE_SIZE) throw new Error('Pièce jointe trop petite : payload invalide');

    const contentType = img.mimeType !== 'unknown' ? img.mimeType : 'application/octet-stream';

    const info = await transporter.sendMail({
      from: `"${EMAIL_FROM_NAME}" <${EMAIL_FROM}>`,
      to,
      subject,
      html: `
        <p style="font-family:Segoe UI,Arial,sans-serif"> ${message}</p>
        <p style="font-family:Segoe UI,Arial,sans-serif">
          <strong>Image jointe :</strong> ${img.filename} — ${(img.size/1024).toFixed(1)} KB
        </p>`,
      attachments: [{ filename: img.filename, content: img.buffer, contentType }]
    });

    res.json({
      success: true,
      message: 'Email envoyé avec succès',
      data: {
        messageId: info.messageId,
        image: { filename: img.filename, size: img.size, type: contentType, path: img.filepath },
        recipient: to,
        timestamp: new Date().toISOString()
      }
    });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

// ==== Envoi avec upload de fichier (multipart) – meilleur pour éviter tout problème Base64 ====
app.post('/send-email-with-image', upload.single('image'), async (req, res) => {
  try {
    const { to, subject, message } = req.body;
    if (!to || !subject || !message || !req.file) {
      return res.status(400).json({ success: false, error: 'Champs manquants' });
    }

    const buf = fs.readFileSync(req.file.path);
    if (buf.length < MIN_IMAGE_SIZE) throw new Error('Fichier trop petit (probablement corrompu)');

    const ext = path.extname(req.file.filename).toLowerCase();
    const mime = {
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.gif': 'image/gif', '.bmp': 'image/bmp', '.webp': 'image/webp'
    }[ext] || 'application/octet-stream';

    const info = await transporter.sendMail({
      from: `"${EMAIL_FROM_NAME}" <${EMAIL_FROM}>`,
      to,
      subject,
      html: `<p style="font-family:Segoe UI,Arial,sans-serif">${message}</p>
             <p style="font-family:Segoe UI,Arial,sans-serif"><strong>Image jointe :</strong> ${req.file.filename}</p>`,
      attachments: [{ filename: req.file.filename, content: buf, contentType: mime }]
    });

    res.json({ success: true, messageId: info.messageId, filename: req.file.filename });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

// Liste des images sauvegardées
app.get('/images', (_req, res) => {
  try {
    const files = fs.readdirSync(imagesDir).filter(f => /\.(jpg|jpeg|png|gif|bmp|webp)$/i.test(f));
    res.json({
      success: true,
      count: files.length,
      images: files.map(name => {
        const s = fs.statSync(path.join(imagesDir, name));
        return { name, size: s.size, created: s.birthtime };
      })
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Gestion erreurs multer / génériques
app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) return res.status(400).json({ error: err.message });
  res.status(500).json({ error: err.message });
});

/* ========================= START ========================= */
app.listen(PORT, () => {
  console.log('========================================');
  console.log('🚀 Email API v4.3 - PJ fiable');
  console.log(`📡 Port: ${PORT}`);
  console.log(`📧 SMTP: ${SMTP_HOST}:${SMTP_PORT}`);
  console.log(`📁 Images: ${imagesDir}`);
  console.log('========================================\n');
});
