# Email API – code corrigé (Express/Nodemailer) & OpenAPI

> ✅ Ce document contient **le code corrigé** et **le fichier OpenAPI**. Copiez-collez tel quel.

---

## `server.js`

```javascript
require('dotenv').config();
const express = require('express');
const nodemailer = require('nodemailer');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { pipeline } = require('stream');
const util = require('util');
const streamPipeline = util.promisify(pipeline);

const app = express();
const PORT = Number(process.env.PORT) || 3000;

/* ========================= CONFIG ========================= */
// IMPORTANT : utilisez des variables d'environnement en production
const SMTP_HOST = process.env.SMTP_HOST || 'smtp.office365.com';
const SMTP_PORT = Number(process.env.SMTP_PORT) || 587; // 587 (STARTTLS) recommandé pour O365
const SMTP_SECURE = String(process.env.SMTP_SECURE || 'false') === 'true'; // false pour STARTTLS
const SMTP_USER = process.env.SMTP_USER || undefined; // ex: no-reply@avocarbon.com
const SMTP_PASS = process.env.SMTP_PASS || undefined;
const EMAIL_FROM_NAME = process.env.EMAIL_FROM_NAME || 'Administration STS';
const EMAIL_FROM = process.env.EMAIL_FROM || 'administration.STS@avocarbon.com';

// URL publique de votre serveur Azure (sans slash final)
const RAW_PUBLIC_URL = process.env.PUBLIC_SERVER_URL || 'https://pdf-api.azurewebsites.net';
const PUBLIC_SERVER_URL = RAW_PUBLIC_URL.replace(/\/$/, '');
const PUBLIC_HOSTNAME = (() => { try { return new URL(PUBLIC_SERVER_URL).hostname; } catch { return null; }})();
if (!PUBLIC_HOSTNAME) {
  throw new Error('PUBLIC_SERVER_URL invalide. Exemple: https://pdf-api.azurewebsites.net');
}

// Créer le dossier images s'il n'existe pas
const imagesDir = path.join(__dirname, 'images');
if (!fs.existsSync(imagesDir)) {
  fs.mkdirSync(imagesDir, { recursive: true });
  console.log('Dossier images créé');
}

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Servir les images publiquement (cache long, pas d'ETag)
app.use('/images', express.static(imagesDir, { maxAge: '1y', etag: false }));

// Configuration Multer
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, imagesDir),
  filename: (_req, file, cb) => {
    const timestamp = Date.now();
    const randomNum = Math.round(Math.random() * 1e9);
    const ext = (path.extname(file.originalname) || '.png').toLowerCase();
    cb(null, `img-${timestamp}-${randomNum}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
  fileFilter: (_req, file, cb) => {
    const allowed = /^(image\/(jpeg|png|gif|webp))$/i;
    if (allowed.test(file.mimetype)) return cb(null, true);
    cb(new Error('Seules les images sont autorisées (jpeg, jpg, png, gif, webp)'));
  }
});

// Transporteur SMTP (Office 365 par défaut). Supporte aussi SMTP sans auth si nécessaire.
const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: SMTP_SECURE, // true = SMTPS (465), false = STARTTLS
  auth: SMTP_USER && SMTP_PASS ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
  tls: { rejectUnauthorized: false }
});

transporter.verify().then(() => {
  console.log('✅ Transport SMTP prêt');
}).catch(err => {
  console.warn('⚠️  Vérification SMTP échouée:', err.message);
});

// Utilitaire : échapper HTML (sécurité XSS si on réinjecte sujet/message)
function escapeHtml(text = '') {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
  return String(text).replace(/[&<>"']/g, (m) => map[m]);
}

// Utilitaire : télécharger une image depuis une URL (même origine uniquement) avec garde-fous
async function downloadImageSameOrigin(imageUrl, filepath, { timeoutMs = 15000, maxBytes = 50 * 1024 * 1024 } = {}) {
  const urlObj = new URL(imageUrl);

  // ✅ Empêche l’SSRF : uniquement le même domaine que PUBLIC_SERVER_URL
  if (urlObj.hostname !== PUBLIC_HOSTNAME) {
    throw new Error(`imageUrl doit appartenir au domaine autorisé: ${PUBLIC_HOSTNAME}`);
  }
  if (!/^https?:$/.test(urlObj.protocol)) {
    throw new Error('Protocole invalide');
  }

  const client = urlObj.protocol === 'https:' ? https : http;

  await new Promise((resolve, reject) => {
    const req = client.get(
      {
        hostname: urlObj.hostname,
        path: urlObj.pathname + (urlObj.search || ''),
        protocol: urlObj.protocol,
        headers: { 'User-Agent': 'Mozilla/5.0' }
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          // Refuse les redirections vers d’autres domaines
          try {
            const redir = new URL(res.headers.location, imageUrl);
            if (redir.hostname !== PUBLIC_HOSTNAME) return reject(new Error('Redirection externe interdite'));
            // Relance simple :
            return downloadImageSameOrigin(redir.toString(), filepath, { timeoutMs, maxBytes }).then(resolve).catch(reject);
          } catch (e) { return reject(e); }
        }

        if (res.statusCode !== 200) return reject(new Error(`Échec du téléchargement: ${res.statusCode}`));

        const ct = (res.headers['content-type'] || '').toLowerCase();
        if (!/^image\/(png|jpeg|jpg|gif|webp)/.test(ct)) {
          return reject(new Error(`Type de contenu non supporté: ${ct || 'inconnu'}`));
        }

        const file = fs.createWriteStream(filepath);
        let received = 0;
        res.on('data', (chunk) => {
          received += chunk.length;
          if (received > maxBytes) {
            req.destroy(new Error('Fichier trop volumineux'));
          }
        });

        streamPipeline(res, file).then(resolve).catch(reject);
      }
    );

    req.setTimeout(timeoutMs, () => req.destroy(new Error('Timeout téléchargement image')));
    req.on('error', (err) => {
      try { fs.unlinkSync(filepath); } catch {}
      reject(err);
    });
  });
}

/* ========================= ROUTES ========================= */
app.get('/', (_req, res) => {
  res.json({
    message: 'API Email avec Images Publiques',
    version: '3.3.0',
    serverUrl: PUBLIC_SERVER_URL,
    endpoints: {
      uploadImage: 'POST /upload-image',
      sendEmail: 'POST /send-email-with-image',
      uploadAndSend: 'POST /upload-and-send-email',
      listImages: 'GET /list-images',
      health: 'GET /health'
    }
  });
});

app.get('/health', (_req, res) => {
  res.json({ success: true, status: 'Service actif', timestamp: new Date().toISOString() });
});

// 1) Upload image => retourne URL publique
app.post('/upload-image', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: "Aucune image n'a été reçue" });

    const { filename, size, path: filePath } = req.file;
    if (size < 100) {
      try { fs.unlinkSync(filePath); } catch {}
      return res.status(400).json({ success: false, error: `Image trop petite (${size} octets)` });
    }

    const publicImageUrl = `${PUBLIC_SERVER_URL}/images/${filename}`;
    res.json({ success: true, message: 'Image uploadée et hébergée avec succès', data: { filename, size, publicUrl: publicImageUrl, timestamp: new Date().toISOString() } });
  } catch (error) {
    console.error('❌ Erreur upload:', error);
    if (req.file?.path) { try { fs.unlinkSync(req.file.path); } catch {} }
    res.status(500).json({ success: false, error: "Erreur lors de l'upload de l'image", details: error.message });
  }
});

// 2) Envoyer email avec image (référence via URL publique même origine)
app.post('/send-email-with-image', async (req, res) => {
  try {
    const { to, subject, message, imageUrl } = req.body || {};

    if (!to || !subject || !message) return res.status(400).json({ success: false, error: 'Les champs "to", "subject" et "message" sont requis' });
    if (!imageUrl || !/^https?:\/\//.test(imageUrl)) return res.status(400).json({ success: false, error: 'Le champ "imageUrl" est requis et doit être une URL valide' });

    // Téléchargement sécurisé (même domaine)
    const timestamp = Date.now();
    const randomNum = Math.round(Math.random() * 1e9);
    const tempFilename = `temp-${timestamp}-${randomNum}.bin`;
    const tempPath = path.join(imagesDir, tempFilename);

    await downloadImageSameOrigin(imageUrl, tempPath);

    const imageBuffer = fs.readFileSync(tempPath);
    const imageSize = imageBuffer.length;
    if (imageSize < 100) {
      try { fs.unlinkSync(tempPath); } catch {}
      return res.status(400).json({ success: false, error: `Image invalide ou trop petite (${imageSize} octets)` });
    }

    // Détermine le type MIME à partir de l'extension de l'URL, fallback image/png
    const extLower = (path.extname(new URL(imageUrl).pathname) || '.png').toLowerCase();
    const mimeTypes = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
    const mimeType = mimeTypes[extLower] || 'image/png';

    const html = `
      <div style="font-family: Arial, sans-serif; padding: 20px; background: #f5f5f5;">
        <div style="background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
          <h2 style="color: #333; margin-top: 0;">${escapeHtml(subject)}</h2>
          <p style="font-size: 14px; line-height: 1.6; color: #555; white-space: pre-line;">${escapeHtml(message)}</p>
          <hr style="border: none; border-top: 1px solid #ddd; margin: 20px 0;">
          <div style="margin: 20px 0; text-align: center;">
            <p style="font-weight: bold; margin-bottom: 15px; color: #333;">Pièce jointe :</p>
            <img src="cid:imageContent@email" alt="Image" style="max-width: 100%; height: auto; display: block; border: 2px solid #ddd; border-radius: 4px; padding: 5px; background: #f9f9f9;">
          </div>
          <p style="font-size: 12px; color: #999; margin-top: 20px; border-top: 1px solid #eee; padding-top: 10px;">
            Message envoyé par Administration STS
          </p>
        </div>
      </div>`;

    const mailOptions = {
      from: `"${EMAIL_FROM_NAME}" <${EMAIL_FROM}>`,
      to,
      subject,
      html,
      attachments: [
        { filename: path.basename(new URL(imageUrl).pathname) || 'image', content: imageBuffer, contentType: mimeType, cid: 'imageContent@email', contentDisposition: 'inline' }
      ]
    };

    const info = await transporter.sendMail(mailOptions);

    try { fs.unlinkSync(tempPath); } catch {}

    res.json({ success: true, message: 'Email envoyé avec succès', data: { messageId: info.messageId, recipient: to, imageUrl, imageSize, timestamp: new Date().toISOString() } });
  } catch (error) {
    console.error('❌ Erreur send-email-with-image:', error);
    res.status(500).json({ success: false, error: "Erreur lors de l'envoi de l'email", details: error.message });
  }
});

// 3) Route combinée : upload + envoyer email
app.post('/upload-and-send-email', upload.single('image'), async (req, res) => {
  try {
    const { to, subject, message } = req.body || {};

    if (!to || !subject || !message) {
      if (req.file?.path) { try { fs.unlinkSync(req.file.path); } catch {} }
      return res.status(400).json({ success: false, error: 'Les champs "to", "subject" et "message" sont requis' });
    }
    if (!req.file) return res.status(400).json({ success: false, error: "Aucune image n'a été reçue" });

    const { filename, size, path: filePath } = req.file;
    if (size < 100) {
      try { fs.unlinkSync(filePath); } catch {}
      return res.status(400).json({ success: false, error: `Image trop petite (${size} octets)` });
    }

    const publicImageUrl = `${PUBLIC_SERVER_URL}/images/${filename}`;
    const ext = path.extname(filename).toLowerCase();
    const mimeTypes = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
    const mimeType = mimeTypes[ext] || 'image/png';
    const imageBuffer = fs.readFileSync(filePath);

    const html = `
      <div style="font-family: Arial, sans-serif; padding: 20px; background: #f5f5f5;">
        <div style="background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
          <h2 style="color: #333; margin-top: 0;">${escapeHtml(subject)}</h2>
          <p style="font-size: 14px; line-height: 1.6; color: #555; white-space: pre-line;">${escapeHtml(message)}</p>
          <hr style="border: none; border-top: 1px solid #ddd; margin: 20px 0;">
          <div style="margin: 20px 0; text-align: center;">
            <p style="font-weight: bold; margin-bottom: 15px; color: #333;">Pièce jointe :</p>
            <img src="cid:imageContent@email" alt="Image" style="max-width: 100%; height: auto; display: block; border: 2px solid #ddd; border-radius: 4px; padding: 5px; background: #f9f9f9;">
          </div>
          <p style="font-size: 12px; color: #999; margin-top: 20px; border-top: 1px solid #eee; padding-top: 10px;">
            Message envoyé par Administration STS
          </p>
        </div>
      </div>`;

    const mailOptions = {
      from: `"${EMAIL_FROM_NAME}" <${EMAIL_FROM}>`,
      to,
      subject,
      html,
      attachments: [
        { filename, content: imageBuffer, contentType: mimeType, cid: 'imageContent@email', contentDisposition: 'inline' }
      ]
    };

    const info = await transporter.sendMail(mailOptions);

    res.json({ success: true, message: 'Image uploadée et email envoyé avec succès', data: { messageId: info.messageId, filename, publicUrl: publicImageUrl, imageSize: size, recipient: to, timestamp: new Date().toISOString() } });
  } catch (error) {
    console.error('❌ Erreur upload-and-send-email:', error);
    if (req.file?.path) { try { fs.unlinkSync(req.file.path); } catch {} }
    res.status(500).json({ success: false, error: "Erreur lors de l'upload/envoi", details: error.message });
  }
});

// 4) Lister les images hébergées
app.get('/list-images', (_req, res) => {
  try {
    const files = fs.readdirSync(imagesDir);
    const images = files
      .filter((f) => ['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(path.extname(f).toLowerCase()))
      .map((file) => ({ filename: file, url: `${PUBLIC_SERVER_URL}/images/${file}`, path: `/images/${file}` }));

    res.json({ success: true, count: images.length, serverUrl: PUBLIC_SERVER_URL, images });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Erreur lors de la lecture des images', details: error.message });
  }
});

// Gestion des erreurs Multer et générales
app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ success: false, error: 'Le fichier est trop volumineux (max 50MB)' });
    }
    return res.status(400).json({ success: false, error: `Erreur upload: ${error.message}` });
  }
  res.status(500).json({ success: false, error: error.message || 'Erreur serveur' });
});

app.listen(PORT, () => {
  console.log('========================================');
  console.log(`🚀 Serveur démarré sur le port ${PORT}`);
  console.log(`🌐 URL Publique: ${PUBLIC_SERVER_URL}`);
  console.log(`📧 SMTP: ${SMTP_HOST}:${SMTP_PORT} (secure=${SMTP_SECURE})`);
  console.log(`📁 Dossier images: ${imagesDir}`);
  console.log('\n✅ Routes disponibles:');
  console.log('   1️⃣  POST /upload-image');
  console.log('   2️⃣  POST /send-email-with-image');
  console.log('   3️⃣  POST /upload-and-send-email (COMBINÉ)');
  console.log('   📋 GET /list-images');
  console.log('   🏥 GET /health');
  console.log('========================================');
});
```

---

## `openapi.json`

```json
{
  "openapi": "3.1.0",
  "info": {
    "title": "Email API - Images Publiques Hébergées",
    "description": "API pour uploader des images et envoyer des emails avec images (même origine sécurisée)",
    "version": "3.3.0"
  },
  "servers": [
    { "url": "https://pdf-api.azurewebsites.net", "description": "Serveur Azure Production" }
  ],
  "paths": {
    "/upload-image": {
      "post": {
        "operationId": "uploadImage",
        "summary": "Uploader une image et recevoir l'URL publique",
        "description": "Étape 1: Upload de l'image, hébergement local et retour de l'URL publique",
        "requestBody": {
          "required": true,
          "content": {
            "multipart/form-data": {
              "schema": {
                "type": "object",
                "required": ["image"],
                "properties": {
                  "image": {
                    "type": "string",
                    "format": "binary",
                    "description": "Fichier image (PNG, JPG, JPEG, GIF, WebP) – max 50MB"
                  }
                }
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "Image uploadée avec succès",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "success": { "type": "boolean", "example": true },
                    "message": { "type": "string" },
                    "data": {
                      "type": "object",
                      "properties": {
                        "filename": { "type": "string", "example": "img-1698765432-123456.png" },
                        "publicUrl": { "type": "string", "example": "https://pdf-api.azurewebsites.net/images/img-1698765432-123456.png" },
                        "size": { "type": "integer", "example": 123456 },
                        "timestamp": { "type": "string", "format": "date-time" }
                      }
                    }
                  }
                }
              }
            }
          },
          "400": { "description": "Erreur – Aucune image ou format invalide" },
          "500": { "description": "Erreur serveur" }
        }
      }
    },
    "/send-email-with-image": {
      "post": {
        "operationId": "sendEmailWithImage",
        "summary": "Envoyer un email avec une image hébergée",
        "description": "Étape 2: Envoi d'un email avec l'image hébergée. L'URL doit appartenir au même domaine que le serveur pour éviter l'SSRF.",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "required": ["to", "subject", "message", "imageUrl"],
                "properties": {
                  "to": { "type": "string", "format": "email", "example": "client@example.com" },
                  "subject": { "type": "string", "example": "Votre devis" },
                  "message": { "type": "string", "example": "Veuillez trouver votre devis ci-joint" },
                  "imageUrl": { "type": "string", "example": "https://pdf-api.azurewebsites.net/images/img-1698765432-123456.png" }
                }
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "Email envoyé avec succès",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "success": { "type": "boolean", "example": true },
                    "message": { "type": "string" },
                    "data": {
                      "type": "object",
                      "properties": {
                        "messageId": { "type": "string" },
                        "recipient": { "type": "string", "format": "email" },
                        "imageUrl": { "type": "string" },
                        "imageSize": { "type": "integer" },
                        "timestamp": { "type": "string", "format": "date-time" }
                      }
                    }
                  }
                }
              }
            }
          },
          "400": { "description": "Erreur – Champs manquants / URL invalide" },
          "500": { "description": "Erreur serveur" }
        }
      }
    },
    "/upload-and-send-email": {
      "post": {
        "operationId": "uploadAndSendEmail",
        "summary": "Uploader une image PUIS envoyer l'email",
        "description": "Étape combinée: upload de l'image puis envoi immédiat par email en inline (CID)",
        "requestBody": {
          "required": true,
          "content": {
            "multipart/form-data": {
              "schema": {
                "type": "object",
                "required": ["image", "to", "subject", "message"],
                "properties": {
                  "image": { "type": "string", "format": "binary" },
                  "to": { "type": "string", "format": "email" },
                  "subject": { "type": "string" },
                  "message": { "type": "string" }
                }
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "Upload + envoi réussis",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "success": { "type": "boolean" },
                    "message": { "type": "string" },
                    "data": {
                      "type": "object",
                      "properties": {
                        "messageId": { "type": "string" },
                        "filename": { "type": "string" },
                        "publicUrl": { "type": "string" },
                        "imageSize": { "type": "integer" },
                        "recipient": { "type": "string", "format": "email" },
                        "timestamp": { "type": "string", "format": "date-time" }
                      }
                    }
                  }
                }
              }
            }
          },
          "400": { "description": "Erreur – Champs manquants / fichier invalide" },
          "500": { "description": "Erreur serveur" }
        }
      }
    },
    "/list-images": {
      "get": {
        "operationId": "listImages",
        "summary": "Lister les images hébergées",
        "description": "Retourne toutes les images actuellement hébergées",
        "responses": {
          "200": {
            "description": "Liste des images",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "success": { "type": "boolean" },
                    "count": { "type": "integer" },
                    "serverUrl": { "type": "string" },
                    "images": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "filename": { "type": "string" },
                          "url": { "type": "string" },
                          "path": { "type": "string" }
                        }
                      }
                    }
                  }
                }
              }
            }
          },
          "500": { "description": "Erreur serveur" }
        }
      }
    }
  }
}
```

---

## Variables d’environnement recommandées (`.env`)

```env
PORT=3000
PUBLIC_SERVER_URL=https://pdf-api.azurewebsites.net
# SMTP Office 365 (recommandé)
SMTP_HOST=smtp.office365.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=administration.STS@avocarbon.com
SMTP_PASS=********
EMAIL_FROM_NAME=Administration STS
EMAIL_FROM=administration.STS@avocarbon.com
```

## Notes clés

* 🔒 **Sécurité** : `/send-email-with-image` accepte uniquement des URLs d’images **hébergées par votre propre serveur** (même domaine) pour éviter l’SSRF.
* ✉️ **Office 365** : l’authentification **SMTP AUTH (587/STARTTLS)** est configurée via variables d’environnement. Si vous utilisez un *SMTP relay connector* sur port 25, laissez `SMTP_USER`/`SMTP_PASS` vides (si autorisé par votre infra).
* 🧹 **Nettoyage** : les fichiers temporaires sont supprimés après envoi.
* 🧾 **OpenAPI** : ajoute l’endpoint combiné et précise les réponses, formats et contraintes.
