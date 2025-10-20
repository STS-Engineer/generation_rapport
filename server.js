// server.js
"use strict";

const express = require("express");
const nodemailer = require("nodemailer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

/* ========================= CONFIGURATION ========================= */
// Si tu as un relais interne (port 25 sans auth), garde ces valeurs.
// Sinon, configure un compte O365 (port 587, STARTTLS) via variables d'env.
const SMTP_HOST = process.env.SMTP_HOST || "avocarbon-com.mail.protection.outlook.com";
const SMTP_PORT = Number(process.env.SMTP_PORT || 25);
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";
const SMTP_SECURE = SMTP_PORT === 465; // vrai si SSL implicite

const EMAIL_FROM_NAME = process.env.EMAIL_FROM_NAME || "Administration STS";
const EMAIL_FROM = process.env.EMAIL_FROM || "administration.STS@avocarbon.com";

// Limites (défense basique)
const MAX_JSON_SIZE = "150mb";
const MAX_CHUNK_CHARS = 50000;
const MAX_FINAL_IMAGE_BYTES = 50 * 1024 * 1024; // 50 Mo
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// Dossier images
const imagesDir = path.join(__dirname, "images");
if (!fs.existsSync(imagesDir)) {
  fs.mkdirSync(imagesDir, { recursive: true });
  console.log("✅ Dossier images créé");
}

/* ========================= MIDDLEWARE ========================= */
app.use(express.json({ limit: MAX_JSON_SIZE }));
app.use(express.urlencoded({ extended: true, limit: MAX_JSON_SIZE, parameterLimit: 100000 }));
app.use("/images", express.static(imagesDir));

/* ========================= SMTP TRANSPORT ========================= */
let transporter;
if (SMTP_USER && SMTP_PASS) {
  // Mode authentifié (recommandé pour O365: smtp.office365.com:587)
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
    tls: { rejectUnauthorized: false }
  });
  console.log("✉️  SMTP: mode AUTH activé");
} else {
  // Mode relais sans auth (ton paramétrage actuel)
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: false,
    tls: { rejectUnauthorized: false }
  });
  console.log("✉️  SMTP: mode RELAY (sans auth)");
}

/* ========================= UTILS ========================= */
const mimeTypes = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
};

function guessMime(ext) {
  return mimeTypes[ext.toLowerCase()] || "image/jpeg";
}

function isLikelyDataUrl(b64) {
  return /^data:.*;base64,/.test(b64);
}

function cleanBase64(b64) {
  // Supprimer les sauts de ligne et l’en-tête data: si présent
  let s = String(b64).replace(/\r?\n/g, "");
  if (isLikelyDataUrl(s)) s = s.split(",", 2)[1];
  return s;
}

function looksValidBase64(s) {
  // Vérif rapide (pas infaillible) pour signaler les erreurs évidentes
  return /^[A-Za-z0-9+/=]*$/.test(s);
}

function stableUploadId({ uploadId, to, imageName, totalChunks }) {
  if (uploadId) return String(uploadId);
  const key = `${to}::${imageName}::${totalChunks}`;
  return crypto.createHash("sha256").update(key).digest("hex").slice(0, 16);
}

/* ========================= SESSIONS CHUNKS ========================= */
const sessions = Object.create(null);

function getSession(id) {
  return sessions[id];
}

function ensureSession(id, meta) {
  if (!sessions[id]) {
    sessions[id] = {
      chunks: [],
      receivedCount: 0,
      createdAt: Date.now(),
      ...meta,
    };
  }
  return sessions[id];
}

function dropSession(id) {
  delete sessions[id];
}

function allChunksPresent(session) {
  // Compte strict des positions remplies (évite les “trous” dans le tableau sparse)
  const n = session.totalChunks;
  let count = 0;
  for (let i = 0; i < n; i++) {
    if (typeof session.chunks[i] === "string") count++;
  }
  return count === n;
}

// Nettoyage périodique des sessions expirées/inactives
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of Object.entries(sessions)) {
    if (now - s.createdAt > SESSION_TTL_MS) {
      console.warn(`🧹 Session expirée supprimée: ${id}`);
      dropSession(id);
    }
  }
}, CLEANUP_INTERVAL_MS);

/* ========================= ROUTES ========================= */
// GET /
app.get("/", (req, res) => {
  res.json({
    message: "✅ API Email avec Base64 - Serveur actif",
    version: "6.0.0",
    method: "Base64 Encoding/Decoding (single ou chunked)",
    endpoint: "POST /send-email-base64",
    parameters: {
      to: "majed.messai@avocarbon.com",
      subject: "mejed",
      message: "mejed123",
      image: "base64 complet (option A)",
      imageChunks: "chunk base64 ≤ 50000 chars (option B)",
      imageName: "nom du fichier (ex: aa.jpg)",
      chunkIndex: "0-based",
      totalChunks: "entier >= 1",
      uploadId: "(optionnel) identifiant stable de l’upload",
    },
    status: "Running"
  });
});

/* ========================= FONCTION: décoder & envoyer ========================= */
async function decodeAndSendEmail(base64String, imageName, to, subject, message) {
  // 1) Clean + validations simples
  const clean = cleanBase64(base64String);
  if (!clean) throw new Error("Base64 vide.");
  if (!looksValidBase64(clean)) throw new Error("Base64 invalide (caractères non autorisés).");

  // 2) Décodage
  const imageBuffer = Buffer.from(clean, "base64");
  if (!imageBuffer || imageBuffer.length === 0) {
    throw new Error("Décodage base64 -> buffer vide.");
  }
  if (imageBuffer.length > MAX_FINAL_IMAGE_BYTES) {
    throw new Error(`Image trop volumineuse (${imageBuffer.length} bytes) > ${MAX_FINAL_IMAGE_BYTES} bytes`);
  }

  // 3) Fichier
  const ext = path.extname(imageName || "").toLowerCase() || ".jpg";
  const mimeType = guessMime(ext);
  const filename = `image_${Date.now()}_${Math.round(Math.random() * 1e9)}${ext}`;
  const filepath = path.join(imagesDir, filename);
  fs.writeFileSync(filepath, imageBuffer);

  // 4) HTML
  const htmlContent = `
    <html>
      <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
      <body style="font-family: Arial, sans-serif; margin:0; padding:0; background:#f9f9f9;">
        <div style="padding:20px; max-width:600px; margin:0 auto;">
          <div style="border-bottom:3px solid #007bff; padding:15px; margin-bottom:20px; background:#fff; border-radius:8px;">
            <h2 style="color:#333; margin:0; font-size:24px;">${String(subject || "").slice(0, 200)}</h2>
          </div>
          <div style="background:#fff; padding:20px; border-radius:8px; margin-bottom:20px;">
            <p style="font-size:15px; line-height:1.8; color:#555; margin:0;">${String(message || "").slice(0, 4000)}</p>
          </div>
          <div style="background:#fff; padding:20px; border-radius:8px; margin-bottom:20px; border:1px solid #ddd;">
            <p style="font-size:14px; color:#666; margin:0;">📎 <strong>Image jointe:</strong> ${filename}</p>
          </div>
          <div style="border-top:2px solid #eee; padding-top:15px; margin-top:30px; text-align:center; background:#fff; padding:15px; border-radius:8px;">
            <p style="font-size:12px; color:#999; margin:0;">📧 Email envoyé via API Administration STS<br>⏰ ${new Date().toLocaleString("fr-FR")}</p>
          </div>
        </div>
      </body>
    </html>
  `;

  // 5) Mail
  const mailOptions = {
    from: `"${EMAIL_FROM_NAME}" <${EMAIL_FROM}>`,
    to: to,
    subject: subject,
    html: htmlContent,
    attachments: [
      { filename, content: imageBuffer, contentType: mimeType }
    ],
  };

  const info = await transporter.sendMail(mailOptions);

  return {
    success: true,
    messageId: info.messageId,
    image: {
      filename,
      size: imageBuffer.length,
      type: mimeType,
      path: `/images/${filename}`,
    },
    recipient: to,
    timestamp: new Date().toISOString(),
  };
}

/* ========================= ROUTE: envoi base64 (single ou chunked) ========================= */
app.post("/send-email-base64", async (req, res) => {
  try {
    const {
      to,
      subject,
      message,
      image,            // (option A) base64 complet
      imageChunks,      // (option B) un chunk
      imageName,
      chunkIndex,
      totalChunks,
      uploadId          // (optionnel) identifiant stable côté client
    } = req.body || {};

    // Sanity checks communs
    if (!to || !subject || !message || !imageName) {
      return res.status(400).json({
        success: false,
        error: "Paramètres manquants: to, subject, message, imageName requis"
      });
    }

    // === CAS A: base64 complet ===
    if (image && !imageChunks) {
      console.log("📦 Mode: Single (image complet)");
      const result = await decodeAndSendEmail(image, imageName, to, subject, message);
      return res.json({ success: true, message: "Email envoyé avec succès", data: result });
    }

    // === CAS B: chunked ===
    if (typeof imageChunks === "string") {
      // validations chunks
      if (!Number.isInteger(chunkIndex) || chunkIndex < 0) {
        return res.status(400).json({ success: false, error: "chunkIndex invalide (entier >= 0)" });
      }
      if (!Number.isInteger(totalChunks) || totalChunks < 1) {
        return res.status(400).json({ success: false, error: "totalChunks invalide (entier >= 1)" });
      }
      if (imageChunks.length === 0 || imageChunks.length > MAX_CHUNK_CHARS) {
        return res.status(400).json({
          success: false,
          error: `imageChunks doit être une chaîne (1..${MAX_CHUNK_CHARS} caractères)`
        });
      }

      const sid = stableUploadId({ uploadId, to, imageName, totalChunks });
      const session = ensureSession(sid, { to, subject, message, imageName, totalChunks });

      // Cohérence inter-appels
      if (session.totalChunks !== totalChunks) {
        return res.status(400).json({ success: false, error: "Conflit: totalChunks incohérent avec la session" });
      }

      // Stockage à l’index
      session.chunks[chunkIndex] = imageChunks;
      session.receivedCount = (session.receivedCount || 0) + 1;
      session.createdAt = Date.now(); // “touch” pour éviter l’expiration active

      console.log(`✅ Chunk ${chunkIndex + 1}/${totalChunks} reçu (sid=${sid})`);

      // Vérifier si on a tout
      if (allChunksPresent(session)) {
        console.log("🔗 Tous les chunks présents — reconstruction…");
        const joined = session.chunks.join("");

        // Sécurité: bornes complètes
        if (joined.length > MAX_CHUNK_CHARS * totalChunks) {
          dropSession(sid);
          return res.status(400).json({
            success: false,
            error: "Base64 reconstitué trop volumineux"
          });
        }

        try {
          const result = await decodeAndSendEmail(joined, session.imageName, session.to, session.subject, session.message);
          dropSession(sid);
          return res.json({
            success: true,
            message: "Email envoyé avec succès (après reconstruction)",
            data: result
          });
        } catch (e) {
          dropSession(sid);
          throw e;
        }
      }

      return res.json({
        success: true,
        message: `Chunk ${chunkIndex + 1}/${totalChunks} reçu. En attente des autres chunks...`,
        chunkReceived: chunkIndex + 1,
        totalChunks,
        uploadId: sid
      });
    }

    // Rien d’exploitable
    return res.status(400).json({
      success: false,
      error: 'Envoyez soit "image" complet, soit "imageChunks" avec chunkIndex et totalChunks'
    });

  } catch (error) {
    console.error("❌ ERREUR /send-email-base64:", error);
    res.status(500).json({
      success: false,
      error: "Erreur lors de l'envoi de l'email",
      details: error.message
    });
  }
});

/* ========================= ROUTE: Lister les images ========================= */
app.get("/images-list", (req, res) => {
  try {
    const files = fs.readdirSync(imagesDir);
    const images = files.filter((file) => {
      const ext = path.extname(file).toLowerCase();
      return [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"].includes(ext);
    });

    const imageDetails = images.map((file) => {
      const filepath = path.join(imagesDir, file);
      const stats = fs.statSync(filepath);
      return {
        name: file,
        size: stats.size,
        sizeKB: (stats.size / 1024).toFixed(2),
        sizeMB: (stats.size / (1024 * 1024)).toFixed(2),
        created: stats.birthtime
      };
    });

    const totalSize = imageDetails.reduce((sum, img) => sum + img.size, 0);

    res.json({
      success: true,
      count: images.length,
      totalSize,
      totalSizeKB: (totalSize / 1024).toFixed(2),
      totalSizeMB: (totalSize / (1024 * 1024)).toFixed(2),
      images: imageDetails
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: "Erreur lors de la lecture des images",
      details: error.message
    });
  }
});

/* ========================= ERREUR GLOBALE ========================= */
app.use((error, req, res, next) => {
  console.error("🚨 Middleware erreur:", error);
  res.status(500).json({ success: false, error: error.message || "Erreur serveur" });
});

/* ========================= DÉMARRER ========================= */
app.listen(PORT, () => {
  console.log("========================================");
  console.log("🚀 SERVEUR DÉMARRÉ AVEC SUCCÈS!");
  console.log("========================================");
  console.log(`📍 Port: ${PORT}`);
  console.log(`✉️  SMTP: ${SMTP_HOST}:${SMTP_PORT} ${SMTP_USER ? "(AUTH)" : "(RELAY)"}`);
  console.log(`📁 Dossier images: ${imagesDir}`);
  console.log(`✉️  Email FROM: ${EMAIL_FROM}`);
  console.log("");
  console.log("🔗 ENDPOINTS:");
  console.log("   1. GET  /             - Vérifier l'état");
  console.log("   2. POST /send-email-base64 - Envoyer email (single ou chunked)");
  console.log("   3. GET  /images-list  - Lister les images");
  console.log("");
});
