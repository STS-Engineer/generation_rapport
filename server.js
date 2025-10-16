/**
 * server.js — API Email + Images (GitHub-backed, Azure domain-safe)
 * -----------------------------------------
 * Endpoints:
 *  - POST   /upload-image              (multipart, upload -> GitHub, renvoie publicUrl = {PUBLIC_SERVER_URL}/images/{filename})
 *  - POST   /send-email-with-image     (JSON, envoie email avec imageUrl inline + attachment) [même domaine obligatoire]
 *  - POST   /upload-and-send-email     (multipart, fait upload + send en 1 étape)
 *  - GET    /list-images               (liste les fichiers image du dossier GitHub configuré)
 *  - GET    /images/:filename          (proxy lecture RAW GitHub -> même domaine)
 *  - GET    /health                    (diagnostic rapide)
 */

const express = require("express");
const nodemailer = require("nodemailer");
const multer = require("multer");
const path = require("path");
const crypto = require("crypto");
const axios = require("axios");

// =================== CONFIG (via ENV) ===================
const PORT = process.env.PORT || 3000;

// Domaine public de ce serveur (utilisé pour fabriquer des URLs sûres)
const PUBLIC_SERVER_URL = process.env.PUBLIC_SERVER_URL || "https://pdf-api.azurewebsites.net";

// GitHub (upload des images)
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;              // token PAT avec scope "repo"
const GITHUB_OWNER = process.env.GITHUB_OWNER;              // ex: "avocarbon-group"
const GITHUB_REPO  = process.env.GITHUB_REPO;               // ex: "assets-email"
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || "main";  // ex: "main"
const GITHUB_IMAGES_DIR = process.env.GITHUB_IMAGES_DIR || "images"; // dossier dans le repo
const GITHUB_COMMITTER_NAME = process.env.GITHUB_COMMITTER_NAME || "Azure Bot";
const GITHUB_COMMITTER_EMAIL = process.env.GITHUB_COMMITTER_EMAIL || "azure-bot@avocarbon.com";

// SMTP (Nodemailer)
const SMTP_HOST = process.env.SMTP_HOST || "avocarbon-com.mail.protection.outlook.com";
const SMTP_PORT = Number(process.env.SMTP_PORT || 25);
const SMTP_SECURE = false; // sur 25, généralement false (STARTTLS auto)
const SMTP_USER = process.env.SMTP_USER || ""; // si auth requise
const SMTP_PASS = process.env.SMTP_PASS || ""; // si auth requise
const EMAIL_FROM_NAME = process.env.EMAIL_FROM_NAME || "Administration STS";
const EMAIL_FROM = process.env.EMAIL_FROM || "administration.STS@avocarbon.com";

// Limites & formats acceptés
const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024; // 50MB
const ALLOWED_EXT = [".png", ".jpg", ".jpeg", ".gif", ".webp"];
const ALLOWED_MIME = ["image/png", "image/jpeg", "image/gif", "image/webp"];

// =================== APP / MIDDLEWARE ===================
const app = express();
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true, limit: "5mb" }));

// Multer (mémoire, pas de disque local)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE_BYTES },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    if (!ALLOWED_EXT.includes(ext) || !ALLOWED_MIME.includes(file.mimetype)) {
      return cb(new Error("Formats autorisés: PNG/JPG/JPEG/GIF/WebP (max 50MB)"));
    }
    cb(null, true);
  },
});

// =================== UTILS ===================
const isSameDomain = (urlStr) => {
  try {
    const u = new URL(urlStr);
    const p = new URL(PUBLIC_SERVER_URL);
    return u.host === p.host && u.protocol === p.protocol;
  } catch {
    return false;
  }
};

const validateEmail = (email) => {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim());
};

const escapeHtml = (str) =>
  String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

const guessMime = (filename) => {
  const ext = path.extname(filename).toLowerCase();
  switch (ext) {
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    default: return "application/octet-stream";
  }
};

// Chemin GitHub (raw) pour une image
const rawGithubUrl = (filename) =>
  `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/${GITHUB_BRANCH}/${GITHUB_IMAGES_DIR}/${encodeURIComponent(filename)}`;

// Proxy interne (même domaine) vers l’image GitHub
app.get("/images/:filename", async (req, res) => {
  try {
    const filename = req.params.filename;
    const url = rawGithubUrl(filename);
    const resp = await axios.get(url, { responseType: "arraybuffer" });
    res.setHeader("Content-Type", guessMime(filename));
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.send(Buffer.from(resp.data));
  } catch (err) {
    res.status(404).json({ success: false, error: "Image introuvable" });
  }
});

// =================== GITHUB API HELPERS ===================
const gh = axios.create({
  baseURL: "https://api.github.com",
  headers: {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "azure-email-image-api",
  },
});

// Upload (create) content in repo
async function uploadToGitHub(filename, buffer) {
  const ext = path.extname(filename).toLowerCase();
  if (!ALLOWED_EXT.includes(ext)) {
    throw new Error("Extension non autorisée");
  }

  const relPath = `${GITHUB_IMAGES_DIR}/${filename}`;
  const contentB64 = buffer.toString("base64");

  const { data } = await gh.put(
    `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodeURI(relPath)}`,
    {
      message: `Upload ${filename}`,
      content: contentB64,
      branch: GITHUB_BRANCH,
      committer: {
        name: GITHUB_COMMITTER_NAME,
        email: GITHUB_COMMITTER_EMAIL,
      },
    }
  );

  return {
    path: relPath,
    sha: data.content && data.content.sha,
    publicUrl: `${PUBLIC_SERVER_URL}/images/${encodeURIComponent(filename)}`, // domaine sûr !
    size: buffer.length,
  };
}

// List directory contents
async function listGitHubImages() {
  const { data } = await gh.get(
    `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodeURI(GITHUB_IMAGES_DIR)}?ref=${encodeURIComponent(GITHUB_BRANCH)}`
  );
  const files = Array.isArray(data) ? data : [];
  return files
    .filter((f) => f.type === "file")
    .filter((f) => ALLOWED_EXT.includes(path.extname(f.name).toLowerCase()))
    .map((f) => ({
      name: f.name,
      size: f.size,
      path: f.path,
      url: `${PUBLIC_SERVER_URL}/images/${encodeURIComponent(f.name)}`,
    }));
}

// =================== SMTP (Nodemailer) ===================
const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: SMTP_SECURE,
  auth: SMTP_USER && SMTP_PASS ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
  tls: { rejectUnauthorized: false },
});

// =================== ROUTES ===================

// Root
app.get("/", (req, res) => {
  res.json({
    message: "API Email + Images (GitHub-backed) active",
    endpoints: {
      uploadImage: "POST /upload-image (multipart/form-data)",
      sendEmailWithImage: "POST /send-email-with-image (JSON)",
      uploadAndSendEmail: "POST /upload-and-send-email (multipart/form-data)",
      listImages: "GET /list-images",
      imageProxy: "GET /images/:filename (proxy raw GitHub -> même domaine)",
      health: "GET /health",
    },
  });
});

// Health
app.get("/health", async (req, res) => {
  const okGithub = Boolean(GITHUB_TOKEN && GITHUB_OWNER && GITHUB_REPO);
  const okPublicUrl = Boolean(PUBLIC_SERVER_URL);
  res.json({
    success: true,
    githubConfigured: okGithub,
    publicUrlConfigured: okPublicUrl,
    smtpHost: SMTP_HOST,
    branch: GITHUB_BRANCH,
    imagesDir: GITHUB_IMAGES_DIR,
  });
});

// Upload image -> GitHub
app.post("/upload-image", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: "Champ 'image' requis (multipart/form-data)" });
    }
    if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) {
      return res.status(500).json({ success: false, error: "GitHub non configuré côté serveur" });
    }

    const ext = path.extname(req.file.originalname).toLowerCase();
    const uniqueName = `${Date.now()}-${crypto.randomInt(1e9)}${ext}`;

    const { publicUrl, size } = await uploadToGitHub(uniqueName, req.file.buffer);

    res.json({
      success: true,
      message: "Image uploadée avec succès",
      data: {
        filename: uniqueName,
        publicUrl,
        size,
      },
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Send email with existing imageUrl (must be same domain)
app.post("/send-email-with-image", async (req, res) => {
  try {
    const { to, subject, message, imageUrl } = req.body || {};
    if (!to || !subject || !message || !imageUrl) {
      return res.status(400).json({ success: false, error: "Champs requis: to, subject, message, imageUrl" });
    }
    if (!validateEmail(to)) {
      return res.status(400).json({ success: false, error: "Format d'email invalide pour 'to'" });
    }
    if (!isSameDomain(imageUrl)) {
      return res.status(400).json({
        success: false,
        error: `imageUrl doit être sur le même domaine que ${PUBLIC_SERVER_URL}. Uploade d'abord via /upload-image.`,
      });
    }

    // Télécharge l'image (depuis /images/xxx de ce serveur)
    const resp = await axios.get(imageUrl, { responseType: "arraybuffer" });
    const buffer = Buffer.from(resp.data);
    if (buffer.length < 100) {
      return res.status(400).json({ success: false, error: "Image trop petite ou invalide" });
    }

    // Devine un nom et un type
    const urlObj = new URL(imageUrl);
    const filename = path.basename(urlObj.pathname) || `image-${Date.now()}.png`;
    const mimeType = guessMime(filename);

    // Email HTML (preserve \n avec white-space: pre-line)
    const html = `
      <div style="font-family: Arial, sans-serif; padding: 16px;">
        <h2 style="color:#333;">${escapeHtml(subject)}</h2>
        <p style="white-space: pre-line; font-size:14px; line-height:1.6;">${escapeHtml(message)}</p>
        <div style="margin-top:16px;">
          <p style="font-weight:bold; margin: 8px 0;">Image inline :</p>
          <img src="cid:imgcid@inline" alt="Image" style="max-width:100%; height:auto; display:block; border:1px solid #ddd; border-radius:6px; padding:4px; background:#fafafa;">
        </div>
        <p style="color:#777; font-size:12px; margin-top:12px;">Si l'image ne s'affiche pas, vérifiez la pièce jointe.</p>
      </div>
    `;

    const info = await transporter.sendMail({
      from: `"${EMAIL_FROM_NAME}" <${EMAIL_FROM}>`,
      to,
      subject: subject,
      html,
      attachments: [
        {
          filename,
          content: buffer,
          contentType: mimeType,
          cid: "imgcid@inline",
          contentDisposition: "inline",
        },
        {
          filename,
          content: buffer,
          contentType: mimeType,
          contentDisposition: "attachment",
        },
      ],
    });

    res.json({
      success: true,
      message: "Email envoyé avec succès",
      data: {
        messageId: info.messageId,
        recipient: to,
        imageUrl,
        imageSize: buffer.length,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: "Erreur lors de l'envoi de l'email", details: err.message });
  }
});

// Upload + Send (1 étape)
app.post("/upload-and-send-email", upload.single("image"), async (req, res) => {
  try {
    const { to, subject, message } = req.body || {};
    if (!req.file) return res.status(400).json({ success: false, error: "Champ 'image' requis (multipart/form-data)" });
    if (!to || !subject || !message) {
      return res.status(400).json({ success: false, error: "Champs requis: to, subject, message" });
    }
    if (!validateEmail(to)) {
      return res.status(400).json({ success: false, error: "Format d'email invalide pour 'to'" });
    }
    if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) {
      return res.status(500).json({ success: false, error: "GitHub non configuré côté serveur" });
    }

    const ext = path.extname(req.file.originalname).toLowerCase();
    const uniqueName = `${Date.now()}-${crypto.randomInt(1e9)}${ext}`;

    // 1) Upload vers GitHub
    const { publicUrl, size } = await uploadToGitHub(uniqueName, req.file.buffer);

    // 2) Envoi d'email via l'URL (même domaine)
    const resp = await axios.get(publicUrl, { responseType: "arraybuffer" });
    const buffer = Buffer.from(resp.data);
    const mimeType = guessMime(uniqueName);

    const html = `
      <div style="font-family: Arial, sans-serif; padding: 16px;">
        <h2 style="color:#333;">${escapeHtml(subject)}</h2>
        <p style="white-space: pre-line; font-size:14px; line-height:1.6;">${escapeHtml(message)}</p>
        <div style="margin-top:16px;">
          <p style="font-weight:bold; margin: 8px 0;">Image inline :</p>
          <img src="cid:imgcid@inline" alt="Image" style="max-width:100%; height:auto; display:block; border:1px solid #ddd; border-radius:6px; padding:4px; background:#fafafa;">
        </div>
        <p style="color:#777; font-size:12px; margin-top:12px;">Si l'image ne s'affiche pas, vérifiez la pièce jointe.</p>
      </div>
    `;

    const info = await transporter.sendMail({
      from: `"${EMAIL_FROM_NAME}" <${EMAIL_FROM}>`,
      to,
      subject,
      html,
      attachments: [
        {
          filename: uniqueName,
          content: buffer,
          contentType: mimeType,
          cid: "imgcid@inline",
          contentDisposition: "inline",
        },
        {
          filename: uniqueName,
          content: buffer,
          contentType: mimeType,
          contentDisposition: "attachment",
        },
      ],
    });

    res.json({
      success: true,
      message: "Image uploadée et email envoyé avec succès",
      data: {
        messageId: info.messageId,
        recipient: to,
        imageUrl: publicUrl,
        imageSize: size,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: "Erreur upload+send", details: err.message });
  }
});

// List images
app.get("/list-images", async (req, res) => {
  try {
    if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) {
      return res.status(500).json({ success: false, error: "GitHub non configuré côté serveur" });
    }
    const items = await listGitHubImages();
    res.json({ success: true, count: items.length, images: items });
  } catch (err) {
    res.status(500).json({ success: false, error: "Erreur list-images", details: err.message });
  }
});

// Global errors
app.use((err, req, res, next) => {
  if (err && /File too large/i.test(err.message)) {
    return res.status(400).json({ success: false, error: "Fichier trop volumineux (max 50MB)" });
  }
  return res.status(500).json({ success: false, error: err?.message || "Erreur serveur" });
});

// Start
app.listen(PORT, () => {
  console.log("========================================");
  console.log(`🚀 Serveur démarré sur le port ${PORT}`);
  console.log(`🌐 Domaine public: ${PUBLIC_SERVER_URL}`);
  console.log(`📦 GitHub: ${GITHUB_OWNER}/${GITHUB_REPO}#${GITHUB_BRANCH} (${GITHUB_IMAGES_DIR})`);
  console.log(`📧 SMTP: ${SMTP_HOST}:${SMTP_PORT}`);
  console.log("========================================");
});
