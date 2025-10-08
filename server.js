"use strict";

/**
 * GPT PDF Email API — server.js (corrigé)
 * - Nettoyage/validation Base64 robuste (padding, base64url, préfixe data:)
 * - Insertion d'image fiable dans PDFKit
 * - Endpoints: /api/test-image, /api/generate-and-send, /health
 * - SMTP via EOP (Outlook) — variables d'env possibles
 */

const express = require("express");
const PDFDocument = require("pdfkit");
const nodemailer = require("nodemailer");
const cors = require("cors");

const app = express();

/* ========================= CONFIG ========================= */
const SMTP_HOST = process.env.SMTP_HOST || "avocarbon-com.mail.protection.outlook.com";
const SMTP_PORT = Number(process.env.SMTP_PORT || 25);
const EMAIL_FROM_NAME = process.env.EMAIL_FROM_NAME || "Administration STS";
const EMAIL_FROM = process.env.EMAIL_FROM || "administration.STS@avocarbon.com";
const MIN_IMAGE_BYTES = Number(process.env.MIN_IMAGE_BYTES || 500);

/* ========================= MIDDLEWARES ========================= */
app.use(express.json({ limit: "50mb" })); // limite élevée pour images base64
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// CORS large (ajustez origin si besoin)
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

// Logging simple
app.use((req, _res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

/* ====================== TRANSPORTEUR SMTP ====================== */
const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: false, // port 25
  tls: { minVersion: "TLSv1.2" },
});

transporter
  .verify()
  .then(() => console.log("✅ SMTP EOP prêt"))
  .catch((err) => console.error("❌ SMTP erreur:", err.message));

/* ============================ UTILS ============================ */
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/** Nettoyage + validation syntaxique base64
 * - Enlève prefixe data:*
 * - Normalise base64url -> base64
 * - Supprime ZWSP & blancs
 * - Padding automatique
 */
function cleanAndValidateBase64(imageData) {
  if (typeof imageData !== "string") {
    throw new Error("imageData doit être une chaîne base64");
  }

  let base64Data = imageData.trim();

  // 1) Enlever un éventuel préfixe data URL
  if (base64Data.startsWith("data:")) {
    const comma = base64Data.indexOf(",");
    base64Data = comma >= 0 ? base64Data.slice(comma + 1) : base64Data;
  }

  // 2) Supprimer espaces, retours, ZWSP
  base64Data = base64Data.replace(/[\u200B-\u200D\uFEFF\s\r\n\t]/g, "");

  // 3) Normaliser base64url -> base64
  base64Data = base64Data.replace(/-/g, "+").replace(/_/g, "/");

  // 4) Retirer tout caractère non base64
  base64Data = base64Data.replace(/[^A-Za-z0-9+/=]/g, "");

  // 5) Padding automatique si nécessaire
  const mod4 = base64Data.length % 4;
  if (mod4 === 1) {
    throw new Error("Chaîne base64 invalide (longueur % 4 == 1)");
  }
  if (mod4 > 0) {
    base64Data += "=".repeat(4 - mod4);
  }

  // 6) Garde-fou simple avant décodage
  if (base64Data.length < 100) {
    throw new Error("Chaîne base64 trop courte avant décodage");
  }

  return base64Data;
}

function validateImageBuffer(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    throw new Error("Le contenu décodé n’est pas un Buffer");
  }
  if (buffer.length < MIN_IMAGE_BYTES) {
    throw new Error(
      `Image trop petite (${buffer.length} octets). Minimum ${MIN_IMAGE_BYTES} octets requis.`
    );
  }

  // Magic bytes
  const b0 = buffer[0], b1 = buffer[1], b2 = buffer[2], b3 = buffer[3];
  const isPNG = b0 === 0x89 && b1 === 0x50 && b2 === 0x4e && b3 === 0x47; // 89 50 4E 47
  const isJPEG = b0 === 0xff && b1 === 0xd8; // FF D8
  const isGIF = b0 === 0x47 && b1 === 0x49 && b2 === 0x46; // 47 49 46

  if (!isPNG && !isJPEG && !isGIF) {
    const mb = [b0, b1, b2, b3].map((x) => x?.toString(16).padStart(2, "0")).join(" ");
    throw new Error(
      `Format d'image non supporté (magic bytes: ${mb}). Attendu: PNG, JPEG ou GIF.`
    );
  }

  return true;
}

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
        .text(`Date: ${new Date().toLocaleDateString("fr-FR", { year: "numeric", month: "long", day: "numeric" })}`,
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
        content.sections.forEach((section, index) => {
          // Nouvelle page si proche du bas
          if (doc.y > doc.page.height - 150) doc.addPage();

          doc.fontSize(14).font("Helvetica-Bold").fillColor("#1e40af").text(`${index + 1}. ${section.title}`);
          doc.moveDown(0.5);

          // Contenu texte
          if (section.content) {
            doc.fontSize(11).font("Helvetica").fillColor("#374151").text(section.content, { align: "justify", lineGap: 3 });
            doc.moveDown(1);
          }

          // Image si présente
          if (section.image) {
            try {
              const cleanedBase64 = cleanAndValidateBase64(section.image);
              console.log("Image base64 len:", cleanedBase64.length, "head:", cleanedBase64.slice(0, 48));

              let imageBuffer;
              try {
                imageBuffer = Buffer.from(cleanedBase64, "base64");
              } catch (_e) {
                throw new Error("Impossible de décoder le base64");
              }

              validateImageBuffer(imageBuffer);

              const maxWidth = doc.page.width - 100; // marges
              const maxHeight = 300; // hauteur max image

              if (doc.y > doc.page.height - maxHeight - 100) doc.addPage();

              const startY = doc.y;
              doc.image(imageBuffer, { fit: [maxWidth, maxHeight], align: "center" });
              const imageHeight = doc.y - startY;
              if (imageHeight < 50) doc.moveDown(3); else doc.moveDown(1);

              if (section.imageCaption) {
                doc.fontSize(9).fillColor("#6b7280").font("Helvetica-Oblique").text(section.imageCaption, { align: "center" });
                doc.moveDown(1);
              }
            } catch (imgError) {
              console.error("Erreur chargement image:", imgError.message);
              doc.fontSize(10).fillColor("#ef4444").text("⚠️ Erreur lors du chargement de l'image", { align: "center" });
              doc.fontSize(8).fillColor("#9ca3af").text(`(${imgError.message})`, { align: "center" });
              doc.moveDown(1);
            }
          }

          doc.moveDown(1.5);
        });
      }

      // Conclusion
      if (content.conclusion) {
        if (doc.y > doc.page.height - 150) doc.addPage();
        doc.fontSize(16).font("Helvetica-Bold").fillColor("#1f2937").text("Conclusion");
        doc.moveDown(0.5);
        doc.fontSize(11).font("Helvetica").fillColor("#374151").text(content.conclusion, { align: "justify", lineGap: 3 });
      }

      // Numéros de page
      const range = doc.bufferedPageRange();
      for (let i = 0; i < range.count; i++) {
        doc.switchToPage(i);
        const oldY = doc.y;
        doc.fontSize(8).fillColor("#9ca3af");
        doc.text(`Page ${i + 1} sur ${range.count}`,
          50,
          doc.page.height - 50,
          { align: "center", lineBreak: false, width: doc.page.width - 100 }
        );
        if (i < range.count - 1) {
          doc.switchToPage(i);
          doc.y = oldY;
        }
      }

      doc.end();
    } catch (err) {
      console.error("Erreur génération PDF:", err);
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
app.post("/api/generate-and-send", async (req, res) => {
  try {
    const { email, subject, reportContent } = req.body || {};

    if (!email || !subject || !reportContent) {
      return res.status(400).json({ success: false, error: "Données manquantes", details: "Envoyez email, subject, reportContent" });
    }
    if (!isValidEmail(email)) {
      return res.status(400).json({ success: false, error: "Email invalide" });
    }
    if (!reportContent.title || !reportContent.introduction || !Array.isArray(reportContent.sections) || !reportContent.conclusion) {
      return res.status(400).json({ success: false, error: "Structure du rapport invalide" });
    }

    const pdfBuffer = await generatePDF(reportContent);
    const pdfName = `rapport_${reportContent.title.replace(/[^a-z0-9]/gi, "_").toLowerCase()}_${Date.now()}.pdf`;

    const html = `
      <!DOCTYPE html>
      <html>
        <body style="font-family: Arial, sans-serif; line-height:1.6; color:#111827;">
          <h2 style="margin:0 0 8px 0;">📄 Votre rapport est prêt</h2>
          <div style="background:#e0e7ff;padding:12px;border-left:4px solid #667eea;border-radius:6px;margin:12px 0;">
            <strong>📊 Sujet :</strong> ${subject}<br>
            <strong>📌 Titre :</strong> ${reportContent.title}<br>
            <strong>📅 Date :</strong> ${new Date().toLocaleDateString("fr-FR")}
          </div>
          <p>Vous trouverez le rapport complet en pièce jointe au format PDF.</p>
          <p style="color:#6b7280;font-size:12px">© ${new Date().getFullYear()} ${EMAIL_FROM_NAME}</p>
        </body>
      </html>
    `;

    await sendEmailWithPdf({ to: email, subject: `Rapport : ${reportContent.title}`, messageHtml: html, pdfBuffer, pdfFilename: pdfName });

    return res.json({ success: true, message: "Rapport généré et envoyé avec succès", details: { email, pdfSize: `${(pdfBuffer.length / 1024).toFixed(2)} KB` } });
  } catch (err) {
    console.error("❌ Erreur:", err);
    return res.status(500).json({ success: false, error: "Erreur lors du traitement", details: err.message });
  }
});

app.post("/api/test-image", async (req, res) => {
  try {
    const { imageData } = req.body || {};
    if (!imageData) {
      return res.status(400).json({ error: "imageData requis" });
    }

    let cleanedBase64;
    try {
      cleanedBase64 = cleanAndValidateBase64(imageData);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }

    let buffer;
    try {
      buffer = Buffer.from(cleanedBase64, "base64");
    } catch (err) {
      return res.status(400).json({ error: "Impossible de décoder le base64", details: err.message });
    }

    try {
      validateImageBuffer(buffer);
    } catch (validationError) {
      return res.status(400).json({
        error: validationError.message,
        hints: [
          "Vérifiez que la chaîne base64 n'est pas tronquée",
          "Évitez les retours à la ligne",
          "N'envoyez pas 'data:image/...;base64,' si votre client le supprime mal",
          "Assurez-vous que 'imageData' dépasse ~100 caractères"
        ],
        sampleHead: cleanedBase64.slice(0, 32),
      });
    }

    // Détecter le type via magic bytes
    let type = "inconnu";
    if (buffer[0] === 0xff && buffer[1] === 0xd8) type = "JPEG";
    else if (buffer[0] === 0x89 && buffer[1] === 0x50) type = "PNG";
    else if (buffer[0] === 0x47 && buffer[1] === 0x49) type = "GIF";

    return res.json({
      success: true,
      imageType: type,
      size: `${(buffer.length / 1024).toFixed(2)} KB`,
      sizeBytes: buffer.length,
      dimensions: "OK - Image valide pour PDFKit",
      magicBytes: `${buffer[0].toString(16).padStart(2, "0")} ${buffer[1].toString(16).padStart(2, "0")}`,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get("/health", (_req, res) => {
  res.json({ status: "OK", timestamp: new Date().toISOString(), uptime: Math.floor(process.uptime()), service: "PDF Report API" });
});

app.get("/", (_req, res) => {
  res.json({ name: "GPT PDF Email API", version: "1.0.1", status: "running", endpoints: { health: "GET /health", generateAndSend: "POST /api/generate-and-send", testImage: "POST /api/test-image" } });
});

app.use((req, res) => res.status(404).json({ error: "Route non trouvée", path: req.path }));

app.use((err, _req, res, _next) => {
  console.error("Erreur:", err);
  res.status(500).json({ error: "Erreur serveur", message: err.message });
});

/* ============================ START ============================ */
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 API démarrée sur port ${PORT}`);
});

process.on("unhandledRejection", (r) => console.error("Unhandled Rejection:", r));
process.on("uncaughtException", (e) => { console.error("Uncaught Exception:", e); process.exit(1); });
