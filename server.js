"use strict";

const express = require("express");
const PDFDocument = require("pdfkit");
const nodemailer = require("nodemailer");
const cors = require("cors");
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const sharp = require("sharp"); // normalisation d'images

const app = express();

/* ========================= CONFIG FIXE ========================= */
const SMTP_HOST = "avocarbon-com.mail.protection.outlook.com";
const SMTP_PORT = 25;
const EMAIL_FROM_NAME = "Administration STS";
const EMAIL_FROM = "administration.STS@avocarbon.com";

/* ========================= MIDDLEWARES ========================= */
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// Servir des fichiers statiques (ex: ./assets/img.png -> /static/img.png)
app.use("/static", express.static(path.join(process.cwd(), "assets")));

// CORS permissif (ChatGPT / navigateurs)
app.use(
  cors({
    origin: true,
    credentials: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "openai-conversation-id",
      "openai-ephemeral-user-id",
    ],
  })
);
app.options("*", cors());

app.use((req, _res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

/* ====================== TRANSPORTEUR SMTP ====================== */
const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: false,
  tls: { minVersion: "TLSv1.2" },
});
transporter
  .verify()
  .then(() => console.log("✅ SMTP EOP prêt"))
  .catch((err) =>
    console.error("❌ SMTP erreur:", err && err.message ? err.message : String(err))
  );

/* ============================ UTILS ============================ */
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim());
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Fallback base64 (compat si on vous en envoie encore)
function cleanAndValidateBase64(imageData) {
  if (imageData == null) throw new Error("imageData vide");
  let base64Data = String(imageData);
  if (base64Data.startsWith("data:image")) {
    const idx = base64Data.indexOf(",");
    base64Data = idx >= 0 ? base64Data.slice(idx + 1) : base64Data;
  }
  base64Data = base64Data.replace(/[\s\n\r\t]/g, "").replace(/[^A-Za-z0-9+/=]/g, "");
  if (!base64Data) throw new Error("imageData après nettoyage est vide");
  return base64Data;
}

// Téléchargement URL -> Buffer (gère redirections + timeout)
function fetchUrlToBuffer(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;
    const req = client.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const nextUrl = res.headers.location.startsWith("http")
          ? res.headers.location
          : new URL(res.headers.location, url).toString();
        res.resume();
        return resolve(fetchUrlToBuffer(nextUrl));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} pour ${url}`));
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    });
    req.on("error", reject);
    req.setTimeout(15000, () => req.destroy(new Error("Timeout téléchargement image")));
  });
}

// Chargement image depuis URL, chemin local, ou base64 (fallback)
async function loadImageToBuffer({ imageUrl, imagePath, imageBase64 }) {
  if (imageUrl) {
    return await fetchUrlToBuffer(imageUrl);
  }
  if (imagePath) {
    const full = path.resolve(imagePath);
    if (!fs.existsSync(full)) {
      throw new Error(
        `Fichier image introuvable: ${full} (cwd=${process.cwd()}). Vérifie le déploiement et/ou utilise imageUrl.`
      );
    }
    return fs.promises.readFile(full);
  }
  if (imageBase64) {
    const cleaned = cleanAndValidateBase64(imageBase64);
    return Buffer.from(cleaned, "base64");
  }
  throw new Error("Aucune source d'image fournie (imageUrl | imagePath | image base64).");
}

// Validation légère + logs magic bytes
function validateImageBuffer(buffer) {
  if (!buffer || !Buffer.isBuffer(buffer)) {
    throw new Error("Image non Buffer");
  }
  if (buffer.length < 10) {
    throw new Error(`Image trop petite (${buffer.length} octets)`);
  }
  const isPNG =
    buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
  const isJPEG = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  const isGIF = buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46;

  console.log(
    `Image validation - PNG:${isPNG}, JPEG:${isJPEG}, GIF:${isGIF} | Magic: ${buffer[0]
      .toString(16)
      .padStart(2, "0")} ${buffer[1].toString(16).padStart(2, "0")} ${buffer[2]
      .toString(16)
      .padStart(2, "0")} ${buffer[3].toString(16).padStart(2, "0")}`
  );

  if (!isPNG && !isJPEG && !isGIF) {
    console.warn("⚠️ Format non reconnu — tentative avec PDFKit tout de même.");
  }
  return true;
}

/**
 * Normalise une image problématique pour PDFKit :
 * - respect orientation EXIF
 * - convertit en PNG (ou JPEG) propre
 * - évite les marqueurs APP/JFIF exotiques
 */
async function normalizeImageBuffer(buffer, { format = "png" } = {}) {
  const img = sharp(buffer, { failOn: "none" }).rotate();
  if (format === "png") {
    return await img.png({ compressionLevel: 9 }).toBuffer();
  } else {
    return await img.jpeg({ quality: 90, chromaSubsampling: "4:4:4" }).toBuffer();
  }
}

/**
 * Génère un PDF à partir d'un contenu structuré
 * content = { title, introduction, sections:[{ title, content, imageUrl?, imagePath?, imageCaption?, image? (base64 fallback) }], conclusion }
 */
function generatePDF(content) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        margin: 50,
        size: "A4",
        bufferPages: true,
        info: { Title: content.title, Author: "Assistant GPT", Subject: content.title },
      });

      const chunks = [];
      doc.on("data", (c) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      // En-tête
      doc.fontSize(26).font("Helvetica-Bold").fillColor("#1e40af").text(content.title, { align: "center" });
      doc.moveDown(0.5);
      doc.strokeColor("#3b82f6").lineWidth(2).moveTo(50, doc.y).lineTo(doc.page.width - 50, doc.y).stroke();
      doc.moveDown();

      // Date
      doc
        .fontSize(10)
        .fillColor("#6b7280")
        .font("Helvetica")
        .text(
          `Date: ${new Date().toLocaleDateString("fr-FR", { year: "numeric", month: "long", day: "numeric" })}`,
          { align: "right" }
        );
      doc.moveDown(2);

      // Introduction
      if (content.introduction) {
        doc.fontSize(16).font("Helvetica-Bold").fillColor("#1f2937").text("Introduction");
        doc.moveDown(0.5);
        doc.fontSize(11).font("Helvetica").fillColor("#374151").text(content.introduction, { align: "justify", lineGap: 3 });
        doc.moveDown(2);
      }

      // Sections
      if (Array.isArray(content.sections)) {
        (async () => {
          for (let index = 0; index < content.sections.length; index++) {
            const section = content.sections[index];

            if (doc.y > doc.page.height - 150) {
              doc.addPage();
            }

            doc.fontSize(14).font("Helvetica-Bold").fillColor("#1e40af").text(`${index + 1}. ${section.title || "Section"}`);
            doc.moveDown(0.5);

            if (section.content) {
              doc.fontSize(11).font("Helvetica").fillColor("#374151").text(section.content, { align: "justify", lineGap: 3 });
              doc.moveDown(1);
            }

            // Image via URL (prioritaire), sinon imagePath, sinon base64 "image"
            if (section.imageUrl || section.imagePath || section.image) {
              try {
                console.log("=== Insertion image ===");
                const buf = await loadImageToBuffer({
                  imageUrl: section.imageUrl,
                  imagePath: section.imagePath,
                  imageBase64: section.image, // fallback legacy
                });

                validateImageBuffer(buf);

                const maxWidth = doc.page.width - 100;
                const maxHeight = 300;

                if (doc.y > doc.page.height - maxHeight - 100) {
                  doc.addPage();
                }

                // Essai 1 : insertion normale
                try {
                  doc.image(buf, { fit: [maxWidth, maxHeight], align: "center" });
                } catch (err1) {
                  const m1 = String((err1 && (err1.message || err1.reason)) ?? err1);
                  console.warn("Image insert error:", m1);

                  // Essai 2 : width seulement
                  try {
                    doc.image(buf, { width: maxWidth, align: "center" });
                  } catch (err2) {
                    const m2 = String((err2 && (err2.message || err2.reason)) ?? err2);
                    console.warn("Image insert retry (width) error:", m2);

                    // Essai 3 : normalisation via sharp → PNG propre
                    console.log("🧼 Normalisation image via sharp (PNG)...");
                    const normalized = await normalizeImageBuffer(buf, { format: "png" });
                    validateImageBuffer(normalized);
                    doc.image(normalized, { fit: [maxWidth, maxHeight], align: "center" });
                  }
                }

                doc.moveDown(1);
                if (section.imageCaption) {
                  doc.fontSize(9).fillColor("#6b7280").font("Helvetica-Oblique").text(section.imageCaption, { align: "center" });
                  doc.moveDown(1);
                }
              } catch (imgError) {
                const msg = (imgError && (imgError.message || imgError.reason)) ?? String(imgError);
                console.error("❌ Erreur image:", msg);
                doc.fontSize(10).fillColor("#ef4444").text("⚠️ Erreur lors du chargement de l'image", { align: "center" });
                doc.fontSize(8).fillColor("#9ca3af").text(`(${msg})`, { align: "center" });
                doc.moveDown(1);
              }
            }

            doc.moveDown(1.5);
          }

          // Conclusion
          if (content.conclusion) {
            if (doc.y > doc.page.height - 150) {
              doc.addPage();
            }
            doc.fontSize(16).font("Helvetica-Bold").fillColor("#1f2937").text("Conclusion");
            doc.moveDown(0.5);
            doc.fontSize(11).font("Helvetica").fillColor("#374151").text(content.conclusion, { align: "justify", lineGap: 3 });
          }

          // Numérotation
          const range = doc.bufferedPageRange();
          for (let i = 0; i < range.count; i++) {
            doc.switchToPage(i);
            const oldY = doc.y;
            doc.fontSize(8).fillColor("#9ca3af");
            doc.text(`Page ${i + 1} sur ${range.count}`, 50, doc.page.height - 50, {
              align: "center",
              lineBreak: false,
              width: doc.page.width - 100,
            });
            if (i < range.count - 1) {
              doc.switchToPage(i);
              doc.y = oldY;
            }
          }

          doc.end();
        })().catch(reject);
      } else {
        doc.end();
      }
    } catch (err) {
      console.error("Erreur génération PDF:", err && err.stack ? err.stack : String(err));
      reject(err);
    }
  });
}

async function sendEmailWithPdf({ to, subject, messageHtml, pdfBuffer, pdfFilename }) {
  return transporter.sendMail({
    from: { name: EMAIL_FROM_NAME, address: EMAIL_FROM },
    to,
    subject,
    html: messageHtml,
    attachments: [{ filename: pdfFilename, content: pdfBuffer, contentType: "application/pdf" }],
  });
}

/* ============================ ROUTES ============================ */

// Debug simple
app.post("/api/echo", (req, res) => {
  res.json({ ok: true, got: req.body || {} });
});

app.post("/api/generate-and-send", async (req, res) => {
  try {
    const { email, subject, reportContent } = req.body || {};

    if (!email || !subject || !reportContent) {
      return res.status(400).json({
        success: false,
        error: "Données manquantes",
        details: "Envoyez email, subject, reportContent",
      });
    }
    if (!isValidEmail(email)) {
      return res.status(400).json({ success: false, error: "Email invalide" });
    }
    if (
      !reportContent.title ||
      !reportContent.introduction ||
      !Array.isArray(reportContent.sections) ||
      !reportContent.conclusion
    ) {
      return res.status(400).json({
        success: false,
        error: "Structure du rapport invalide",
      });
    }

    const pdfBuffer = await generatePDF(reportContent);
    const pdfName = `rapport_${String(reportContent.title).replace(/[^a-z0-9]/gi, "_").toLowerCase()}_${Date.now()}.pdf`;

    const html = `
      <!DOCTYPE html>
      <html>
        <body style="font-family: Arial, sans-serif; line-height:1.6; color:#111827;">
          <h2 style="margin:0 0 8px 0;">📄 Votre rapport est prêt</h2>
          <div style="background:#e0e7ff;padding:12px;border-left:4px solid #667eea;border-radius:6px;margin:12px 0;">
            <strong>📊 Sujet :</strong> ${escapeHtml(subject)}<br>
            <strong>📌 Titre :</strong> ${escapeHtml(reportContent.title)}<br>
            <strong>📅 Date :</strong> ${new Date().toLocaleDateString("fr-FR")}
          </div>
          <p>Vous trouverez le rapport complet en pièce jointe au format PDF.</p>
          <p style="color:#6b7280;font-size:12px">© ${new Date().getFullYear()} ${EMAIL_FROM_NAME}</p>
        </body>
      </html>
    `;

    await sendEmailWithPdf({
      to: email,
      subject: `Rapport : ${reportContent.title}`,
      messageHtml: html,
      pdfBuffer,
      pdfFilename: pdfName,
    });

    return res.json({
      success: true,
      message: "Rapport généré et envoyé avec succès",
      details: {
        email,
        pdfSize: `${(pdfBuffer.length / 1024).toFixed(2)} KB`,
      },
    });
  } catch (err) {
    console.error("❌ Erreur:", err && err.stack ? err.stack : String(err));
    return res.status(500).json({
      success: false,
      error: "Erreur lors du traitement",
      details: (err && err.message) ?? String(err),
    });
  }
});

// Test image (accepte imageUrl ou imageData base64 legacy)
app.post("/api/test-image", async (req, res) => {
  try {
    const { imageUrl, imageData } = req.body || {};

    let buffer;
    if (imageUrl) {
      buffer = await fetchUrlToBuffer(imageUrl);
    } else if (imageData) {
      const cleanedBase64 = cleanAndValidateBase64(imageData);
      buffer = Buffer.from(cleanedBase64, "base64");
    } else {
      return res.status(400).json({ error: "Fournir imageUrl ou imageData" });
    }

    try {
      validateImageBuffer(buffer);
    } catch (validationError) {
      return res.status(400).json({ error: validationError.message });
    }

    // Type
    let type = "inconnu";
    if (buffer[0] === 0xff && buffer[1] === 0xd8) type = "JPEG";
    else if (buffer[0] === 0x89 && buffer[1] === 0x50) type = "PNG";
    else if (buffer[0] === 0x47 && buffer[1] === 0x49) type = "GIF";

    // Peut-on normaliser ?
    let normalizedOk = false;
    try {
      const norm = await normalizeImageBuffer(buffer, { format: "png" });
      if (norm && norm.length > 10) normalizedOk = true;
    } catch (_e) {}

    return res.json({
      success: true,
      imageType: type,
      size: `${(buffer.length / 1024).toFixed(2)} KB`,
      sizeBytes: buffer.length,
      magicBytes: `${buffer[0].toString(16).padStart(2, "0")} ${buffer[1]
        .toString(16)
        .padStart(2, "0")} ${buffer[2].toString(16).padStart(2, "0")} ${buffer[3]
        .toString(16)
        .padStart(2, "0")}`,
      normalizedPreviewPossible: normalizedOk,
    });
  } catch (err) {
    return res.status(500).json({ error: (err && err.message) ?? String(err) });
  }
});

app.get("/health", (_req, res) => {
  res.json({
    status: "OK",
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    service: "PDF Report API",
  });
});

app.get("/", (_req, res) => {
  res.json({
    name: "GPT PDF Email API",
    version: "1.0.0",
    status: "running",
    endpoints: {
      health: "GET /health",
      echo: "POST /api/echo",
      testImage: "POST /api/test-image",
      generateAndSend: "POST /api/generate-and-send",
      static: "GET /static/<fichier>", // ex: /static/img.png
    },
  });
});

/* ========================= 404 & ERREUR ======================== */
app.use((req, res) => res.status(404).json({ error: "Route non trouvée", path: req.path }));
app.use((err, _req, res, _next) => {
  console.error("Erreur middleware:", err && err.stack ? err.stack : String(err));
  res.status(500).json({ error: "Erreur serveur", message: (err && err.message) ?? String(err) });
});

/* ============================ START ============================ */
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 API démarrée sur port ${PORT}`);
});

/* ========================= PROCESS HOOKS ======================= */
process.on("unhandledRejection", (r) =>
  console.error("Unhandled Rejection:", r && r.stack ? r.stack : String(r))
);
process.on("uncaughtException", (e) => {
  console.error("Uncaught Exception:", e && e.stack ? e.stack : String(e));
  process.exit(1);
});
