// server.js
const express = require('express');
const nodemailer = require('nodemailer');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

/* ========================= CONFIG FIXE ========================= */
const SMTP_HOST = "avocarbon-com.mail.protection.outlook.com";
const SMTP_PORT = 25;
const EMAIL_FROM_NAME = "Administration STS";
const EMAIL_FROM = "administration.STS@avocarbon.com";

// Créer le dossier images
const imagesDir = path.join(__dirname, 'images');
if (!fs.existsSync(imagesDir)) fs.mkdirSync(imagesDir, { recursive: true });

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

/* ========================= MULTER ========================= */
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, imagesDir),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|bmp|webp/;
    const ok = allowed.test(path.extname(file.originalname).toLowerCase()) && allowed.test(file.mimetype);
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
// Normalisation Base64 (gère %xx, +, base64url, CR/LF, padding)
function normalizeBase64Payload(raw) {
  if (!raw || typeof raw !== 'string') throw new Error('Payload Base64 manquante');
  let b64 = raw.trim();

  // Extraire dataURL si présent
  if (b64.startsWith('data:')) {
    const m = b64.match(/^data:([^;]+);base64,(.*)$/);
    if (m) b64 = m[2];
  } else if (b64.includes('base64,')) {
    b64 = b64.split('base64,').pop();
  }

  // Si on a encore du %xx (url-encoded), décoder
  if (/%[0-9A-Fa-f]{2}/.test(b64)) {
    try { b64 = decodeURIComponent(b64); } catch (_) { /* ignore */ }
  }

  // Forms urlencoded : espaces => '+'
  b64 = b64.replace(/ /g, '+');

  // base64url -> base64
  b64 = b64.replace(/-/g, '+').replace(/_/g, '/');

  // Retirer CR/LF/TAB
  b64 = b64.replace(/[\r\n\t]/g, '');

  // Nettoyage final (tolérant)
  b64 = b64.replace(/[^A-Za-z0-9+/=]/g, '');

  // Padding
  const mod = b64.length % 4;
  if (mod === 2) b64 += '==';
  else if (mod === 3) b64 += '=';
  else if (mod === 1) throw new Error('Base64 invalide (longueur %4 == 1)');

  return b64;
}

// Détection type via magic number
function sniffImageType(buffer) {
  const m = buffer.slice(0, 8);
  if (m[0] === 0x89 && m[1] === 0x50 && m[2] === 0x4E && m[3] === 0x47) return { type: 'image/png', ext: '.png' };
  if (m[0] === 0xFF && m[1] === 0xD8 && m[2] === 0xFF) return { type: 'image/jpeg', ext: '.jpg' };
  if (m[0] === 0x47 && m[1] === 0x49 && m[2] === 0x46) return { type: 'image/gif', ext: '.gif' };
  if (m[0] === 0x42 && m[1] === 0x4D) return { type: 'image/bmp', ext: '.bmp' };
  return { type: 'unknown', ext: '.bin' };
}

// Décodage & sauvegarde robuste
function decodeAndSaveImage(base64String, filename) {
  try {
    console.log('\n--- DÉCODAGE IMAGE ---');
    console.log(`Input length: ${base64String?.length ?? 0} chars`);

    const b64 = normalizeBase64Payload(base64String);
    const estBytes = Math.floor((b64.replace(/=+$/, '').length * 3) / 4);
    console.log(`Normalized length: ${b64.length} chars (≈${estBytes} bytes attendus)`);

    const buffer = Buffer.from(b64, 'base64');
    console.log(`Buffer size: ${buffer.length} bytes`);
    console.log('Hex head:', buffer.slice(0, 12).toString('hex'));

    // Garde-fou : si < 1KB, on considère la payload corrompue/tronquée
    if (buffer.length < 1024) {
      throw new Error(`Image corrompue ou tronquée (taille ${buffer.length} bytes)`);
    }

    const sniff = sniffImageType(buffer);
    console.log(`Detected type: ${sniff.type}`);

    let finalFilename = (filename || `image_${Date.now()}`).replace(/\.[^.]+$/, '') + sniff.ext;
    const filepath = path.join(imagesDir, finalFilename);
    fs.writeFileSync(filepath, buffer);
    console.log(`✓ Saved: ${finalFilename}`);
    console.log('-------------------\n');

    return { filepath, buffer, filename: finalFilename, mimeType: sniff.type, size: buffer.length };
  } catch (err) {
    console.error('✗ Decode error:', err.message);
    throw new Error(`Décodage échoué: ${err.message}`);
  }
}

/* ========================= ROUTES ========================= */
// Santé
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    version: '4.2 - Base64 hardened',
    endpoints: {
      'POST /send-email-base64': 'Envoyer email avec image base64 (JSON recommandé)',
      'POST /send-email-with-image': 'Upload fichier (multipart)',
      'GET /images': 'Liste images',
      'POST /test-decode': 'Tester décodage seul'
    }
  });
});

// Test décodage
app.post('/test-decode', (req, res) => {
  try {
    const { imageBase64, testName } = req.body;
    if (!imageBase64) return res.status(400).json({ error: 'imageBase64 requis' });

    const filename = (testName || `test_${Date.now()}`) + '.png';
    const result = decodeAndSaveImage(imageBase64, filename);

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
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Envoi email (Base64 en JSON)
app.post('/send-email-base64', async (req, res) => {
  try {
    const { to, subject, message, imageBase64, imageName } = req.body;

    console.log('\n========== NEW EMAIL REQUEST ==========');
    console.log(`To: ${to}`);
    console.log(`Subject: ${subject}`);

    if (!to || !subject || !message) {
      return res.status(400).json({ success: false, error: 'Champs "to", "subject" et "message" requis' });
    }
    if (!imageBase64) return res.status(400).json({ success: false, error: 'Champ "imageBase64" requis' });

    const baseFilename = imageName || `image_${Date.now()}.jpg`;
    const imageData = decodeAndSaveImage(imageBase64, baseFilename);

    // Garde-fou : ne pas envoyer une PJ trop petite
    if (imageData.size < 1024) {
      throw new Error('Pièce jointe trop petite : payload Base64 invalide (vérifier encodage côté client)');
    }

    const detectedMime = imageData.mimeType !== 'unknown' ? imageData.mimeType : 'application/octet-stream';

    const mailOptions = {
      from: `"${EMAIL_FROM_NAME}" <${EMAIL_FROM}>`,
      to,
      subject,
      html: `
        <!DOCTYPE html>
        <html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
        <body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;background-color:#f5f5f5;">
          <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f5f5f5;padding:20px;">
            <tr><td align="center">
              <table width="600" cellpadding="0" cellspacing="0" border="0" style="background-color:white;border-radius:12px;overflow:hidden;box-shadow:0 4px 12px rgba(0,0,0,0.1);">
                <tr>
                  <td style="background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);padding:40px 30px;text-align:center;">
                    <h1 style="color:white;margin:0;font-size:32px;font-weight:700;letter-spacing:-0.5px;">${subject}</h1>
                  </td>
                </tr>
                <tr>
                  <td style="padding:40px 35px;">
                    <p style="font-size:16px;line-height:1.8;color:#333;margin:0 0 30px 0;white-space:pre-wrap;">${message}</p>
                    <div style="background:linear-gradient(135deg,#667eea15 0%,#764ba215 100%);border-left:5px solid #667eea;padding:25px;border-radius:8px;margin:30px 0;">
                      <table width="100%" cellpadding="0" cellspacing="0">
                        <tr>
                          <td width="60" valign="top">
                            <div style="width:50px;height:50px;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);border-radius:50%;display:flex;align-items:center;justify-content:center;">
                              <span style="font-size:24px;color:white;">📎</span>
                            </div>
                          </td>
                          <td valign="top">
                            <h3 style="margin:0 0 8px 0;font-size:18px;color:#333;font-weight:600;">Image jointe</h3>
                            <p style="margin:0 0 8px 0;font-size:14px;color:#666;line-height:1.6;">L'image est disponible en pièce jointe de cet email.</p>
                            <p style="margin:0;font-size:13px;color:#999;">
                              <strong>Fichier :</strong> ${imageData.filename}<br>
                              <strong>Taille :</strong> ${(imageData.size / 1024).toFixed(1)} KB<br>
                              <strong>Type :</strong> ${detectedMime}
                            </p>
                          </td>
                        </tr>
                      </table>
                    </div>
                    <div style="background-color:#fffbea;border:1px solid #ffeaa7;border-radius:6px;padding:15px;margin-top:25px;">
                      <p style="margin:0;font-size:13px;color:#7f6e00;line-height:1.5;">💡 <strong>Astuce :</strong> Cliquez sur la pièce jointe ci-dessus pour ouvrir l'image.</p>
                    </div>
                  </td>
                </tr>
                <tr>
                  <td style="background-color:#fafafa;padding:25px 35px;border-top:1px solid #e0e0e0;" align="center">
                    <p style="margin:0;font-size:13px;color:#666;font-weight:600;">Administration STS</p>
                    <p style="margin:5px 0 0 0;font-size:12px;color:#999;">${
                      new Date().toLocaleDateString('fr-FR', { weekday:'long', year:'numeric', month:'long', day:'numeric' })
                    }</p>
                  </td>
                </tr>
              </table>
            </td></tr>
          </table>
        </body></html>
      `,
      attachments: [{
        filename: imageData.filename,
        content: imageData.buffer,
        contentType: detectedMime
      }]
    };

    console.log('Sending email...');
    const info = await transporter.sendMail(mailOptions);
    console.log('✓ EMAIL SENT', `Message ID: ${info.messageId}`);

    res.json({
      success: true,
      message: 'Email envoyé avec succès',
      data: {
        messageId: info.messageId,
        image: { filename: imageData.filename, size: imageData.size, type: detectedMime, path: imageData.filepath },
        recipient: to,
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('✗ ERROR:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Envoi email via upload de fichier (multipart/form-data)
app.post('/send-email-with-image', upload.single('image'), async (req, res) => {
  try {
    const { to, subject, message } = req.body;
    if (!to || !subject || !message || !req.file) {
      return res.status(400).json({ success: false, error: 'Champs manquants' });
    }

    const imageBuffer = fs.readFileSync(req.file.path);
    const ext = path.extname(req.file.filename).toLowerCase();
    const mimeTypes = {
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.gif': 'image/gif', '.bmp': 'image/bmp', '.webp': 'image/webp'
    };

    const info = await transporter.sendMail({
      from: `"${EMAIL_FROM_NAME}" <${EMAIL_FROM}>`,
      to, subject,
      html: `<p>${message}</p><p><strong>Image jointe : ${req.file.filename}</strong></p>`,
      attachments: [{ filename: req.file.filename, content: imageBuffer, contentType: mimeTypes[ext] || 'application/octet-stream' }]
    });

    res.json({ success: true, messageId: info.messageId, filename: req.file.filename });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Liste images
app.get('/images', (req, res) => {
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
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Erreurs
app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) return res.status(400).json({ error: error.message });
  res.status(500).json({ error: error.message });
});

// Démarrer
app.listen(PORT, () => {
  console.log('========================================');
  console.log('🚀 Email API v4.2 - Base64 hardened');
  console.log(`📡 Port: ${PORT}`);
  console.log(`📧 SMTP: ${SMTP_HOST}:${SMTP_PORT}`);
  console.log(`📁 Images: ${imagesDir}`);
  console.log('========================================\n');
});
