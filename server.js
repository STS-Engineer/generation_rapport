/**
 * server.js — API Email avec Image en BASE64 (inline CID + attachment)
 * -------------------------------------------------------------------
 * Endpoints:
 *  - GET  /health                  (diagnostic rapide)
 *  - POST /send-email-base64       (JSON: to, subject, message?, imageBase64, imageName?)
 *
 * SMTP recommandé (Office 365) :
 *  - SMTP_HOST=smtp.office365.com
 *  - SMTP_PORT=587
 *  - SMTP_SECURE=false (STARTTLS)
 *  - SMTP_USER=boite@domaine
 *  - SMTP_PASS=motdepasse (ou mot de passe d'app si MFA)
 */

const express = require("express");
const nodemailer = require("nodemailer");
const path = require("path");

// =================== CONFIG (ENV) ===================
const PORT = process.env.PORT || 3000;

// SMTP (Nodemailer)
const SMTP_HOST = process.env.SMTP_HOST || "smtp.office365.com";
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_SECURE = String(process.env.SMTP_SECURE || "false") === "true"; // en général false sur 587
const SMTP_USER = process.env.SMTP_USER || ""; // requis si envoi via client submission
const SMTP_PASS = process.env.SMTP_PASS || ""; // idem

// Expéditeur
const EMAIL_FROM_NAME = process.env.EMAIL_FROM_NAME || "Administration STS";
const EMAIL_FROM = process.env.EMAIL_FROM || "administration.STS@avocarbon.com";

// Limites & formats
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10MB après décodage base64
const ALLOWED_EXT = [".png", ".jpg", ".jpeg", ".gif", ".webp"];

// =================== APP ===================
const app = express();
app.use(express.json({ limit: "12mb" })); // 12MB JSON pour compenser le gonflement base64

// =================== UTILS ===================
const validateEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim());

const escapeHtml = (str) =>
  String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

const detectMimeFromMagicBytes = (buf) => {
  if (!buf || buf.length < 12) return { mime: "application/octet-stream", ok: false };

  // PNG
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) {
    return { mime: "image/png", ok: true };
  }
  // JPEG
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) {
    return { mime: "image/jpeg", ok: true };
  }
  // GIF
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return { mime: "image/gif", ok: true };
  }
  // WebP: "RIFF....WEBP"
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) {
    return { mime: "image/webp", ok: true };
  }
  return { mime: "application/octet-stream", ok: false };
};

const extFromMime = (mime) => {
  switch (mime) {
    case "image/png": return ".png";
    case "image/jpeg": return ".jpg";
    case "image/gif": return ".gif";
    case "image/webp": return ".webp";
    default: return "";
  }
};

const sanitizeFileName = (name, fallbackExt) => {
  let base = String(name || "").trim();
  if (!base) base = `image${fallbackExt || ".png"}`;
  base = base.replace(/[^a-zA-Z0-9._-]/g, "_");
  // éviter les noms sans extension
  if (!path.extname(base)) base += fallbackExt || ".png";
  return base;
};

const stripDataUrlPrefix = (b64) => {
  const idx = String(b64).indexOf("base64,");
  return idx >= 0 ? String(b64).slice(idx + "base64,".length) : String(b64);
};

// =================== SMTP TRANSPORT ===================
const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: SMTP_SECURE, // false pour 587 (STARTTLS)
  auth: SMTP_USER && SMTP_PASS ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
  tls: { rejectUnauthorized: false }, // utile si certs d'entreprise
});

// =================== ROUTES ===================

// Health
app.get("/health", async (req, res) => {
  res.json({
    success: true,
    smtpHost: SMTP_HOST,
    smtpPort: SMTP_PORT,
    smtpAuth: Boolean(SMTP_USER && SMTP_PASS),
    maxImageBytes: MAX_IMAGE_BYTES,
    allowedExtensions: ALLOWED_EXT,
  });
});

// Send email (base64)
app.post("/send-email-base64", async (req, res) => {
  try {
    const { to, subject, message, imageBase64, imageName } = req.body || {};

    // Validations
    if (!to || !subject || !imageBase64) {
      return res.status(400).json({
        success: false,
        error: "Champs requis: 'to', 'subject', 'imageBase64'. 'message' est optionnel."
      });
    }
    if (!validateEmail(to)) {
      return res.status(400).json({
        success: false,
        error: "Format d'email invalide pour 'to'."
      });
    }

    // Décodage base64
    const raw = stripDataUrlPrefix(imageBase64);
    let buffer;
    try {
      buffer = Buffer.from(raw.replace(/\s/g, ""), "base64");
    } catch {
      return res.status(400).json({ success: false, error: "imageBase64 invalide (décodage échoué)." });
    }

    if (!buffer || buffer.length < 100) {
      return res.status(400).json({ success: false, error: "Image trop petite ou invalide." });
    }
    if (buffer.length > MAX_IMAGE_BYTES) {
      return res.status(400).json({ success: false, error: `Image trop volumineuse (>${MAX_IMAGE_BYTES} octets).` });
    }

    // Déterminer MIME via magic bytes
    const { mime, ok } = detectMimeFromMagicBytes(buffer);
    if (!ok) {
      return res.status(400).json({ success: false, error: "Type d'image non reconnu ou non autorisé." });
    }

    // Vérifier extension (si fournie), ou en déduire une
    const extFromDetected = extFromMime(mime);
    const safeName = sanitizeFileName(imageName, extFromDetected);
    const ext = path.extname(safeName).toLowerCase();
    if (!ALLOWED_EXT.includes(ext)) {
      return res.status(400).json({ success: false, error: "Extension d'image non autorisée (PNG/JPG/JPEG/GIF/WebP)." });
    }

    // HTML (préserve les retours à la ligne)
    const html = `
      <div style="font-family: Arial, sans-serif; padding: 16px;">
        <h2 style="color:#333;">${escapeHtml(subject)}</h2>
        <p style="white-space: pre-line; font-size:14px; line-height:1.6;">${escapeHtml(message || "")}</p>
        <div style="margin-top:16px;">
          <p style="font-weight:bold; margin:8px 0;">Image inline :</p>
          <img src="cid:imgcid@inline" alt="Image" style="max-width:100%; height:auto; display:block; border:1px solid #ddd; border-radius:6px; padding:4px; background:#fafafa;">
        </div>
        <p style="color:#777; font-size:12px; margin-top:12px;">Si l'image ne s'affiche pas, vérifiez la pièce jointe.</p>
      </div>
    `;

    // Envoi email
    const info = await transporter.sendMail({
      from: `"${EMAIL_FROM_NAME}" <${EMAIL_FROM}>`,
      to,
      subject,
      html,
      attachments: [
        {
          filename: safeName,
          content: buffer,
          contentType: mime,
          cid: "imgcid@inline",
          contentDisposition: "inline",
        },
        {
          filename: safeName,
          content: buffer,
          contentType: mime,
          contentDisposition: "attachment",
        },
      ],
    });

    return res.json({
      success: true,
      message: "Email envoyé avec succès",
      data: {
        messageId: info.messageId,
        recipient: to,
        imageSize: buffer.length,
        imageName: safeName,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (err) {
    console.error("Erreur /send-email-base64:", err);
    return res.status(500).json({
      success: false,
      error: "Erreur serveur lors de l'envoi de l'email",
      details: err?.message || String(err),
    });
  }
});

// Global error handler (sécurité)
app.use((err, req, res, next) => {
  console.error("Global error:", err);
  res.status(500).json({ success: false, error: err?.message || "Erreur serveur" });
});

// Start
app.listen(PORT, () => {
  console.log("========================================");
  console.log(`🚀 Serveur démarré sur le port ${PORT}`);
  console.log(`📧 SMTP: ${SMTP_HOST}:${SMTP_PORT} (secure=${SMTP_SECURE}) auth=${Boolean(SMTP_USER && SMTP_PASS)}`);
  console.log(`📦 Max image bytes: ${MAX_IMAGE_BYTES}, Types: ${ALLOWED_EXT.join(", ")}`);
  console.log("========================================");
});
