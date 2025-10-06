"use strict";

/**
 * =========================
 *  GPT PDF Email API (M365)
 * =========================
 * Prérequis ENV :
 *  - O365_SMTP_USER="administration.STS@avocarbon.com"
 *  - O365_SMTP_PASS="*** mot de passe (ou mot de passe d’application) ***"
 *  - EMAIL_FROM_NAME="Administration STS" (optionnel)
 *  - EMAIL_FROM="administration.STS@avocarbon.com" (optionnel)
 *  - PORT=3000 (optionnel)
 *
 * Démarrage :
 *  node server.js
 */

const express = require("express");
const PDFDocument = require("pdfkit");
const nodemailer = require("nodemailer");
const cors = require("cors");

// ------- Chargement variables d'environnement (facultatif si vous utilisez un autre mécanisme) -------
// Si vous avez un fichier .env, décommentez la ligne suivante et installez dotenv : npm i dotenv
// require("dotenv").config();

const app = express();

/* ========================= CONFIG ========================= */
// SMTP Microsoft 365 (STARTTLS sur 587)
const SMTP_HOST = "smtp.office365.com";
const SMTP_PORT = 587;

// Expéditeur par défaut (peut être identique à l'utilisateur SMTP)
const EMAIL_FROM_NAME = process.env.EMAIL_FROM_NAME || "Administration STS";
const EMAIL_FROM = process.env.EMAIL_FROM || "administration.STS@avocarbon.com";

// Identifiants SMTP
const O365_SMTP_USER = process.env.O365_SMTP_USER || "administration.STS@avocarbon.com";
const O365_SMTP_PASS = process.env.O365_SMTP_PASS || "";

// Sécurité : refusez de démarrer sans mot de passe
if (!O365_SMTP_PASS) {
  console.warn("⚠️  O365_SMTP_PASS est vide. Renseignez le mot de passe (ou mot de passe d’application).");
}

/* ========================= MIDDLEWARES ========================= */
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// CORS permissif pour intégration avec ChatGPT / front
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

// Préflight pour toutes les routes
app.options("*", cors());

app.use((req, _res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

/* ====================== TRANSPORTEUR SMTP ====================== */
const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: false, // STARTTLS sur 587
  requireTLS: true,
  auth: {
    user: O365_SMTP_USER,
    pass: O365_SMTP_PASS,
  },
  tls: { minVersion: "TLSv1.2" },
  connectionTimeout: 20_000,
  greetingTimeout: 20_000,
  socketTimeout: 30_000,
  pool: true, // connexions réutilisables
  // maxConnections / maxMessages peuvent être ajustés si besoin
});

(async () => {
  try {
    await transporter.verify();
    console.log("✅ SMTP Office 365 prêt");
  } catch (err) {
    console.error("❌ SMTP erreur lors du verify():", {
      code: err.code,
      command: err.command,
      response: err.response,
      responseCode: err.responseCode,
      message: err.message,
    });
  }
})();

/* ============================ UTILS ============================ */
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function sanitizeFileName(name) {
  return String(name || "rapport")
    .replace(/[^a-z0-9_\-\.]/gi, "_")
    .toLowerCase();
}

function generatePDF(content) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        margin: 50,
        size: "A4",
        info: {
          Title: content.title,
          Author: "Assistant GPT",
          Subject: content.title,
        },
      });

      const chunks = [];
      doc.on("data", (c) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      // Titre
      doc
        .fontSize(26)
        .font("Helvetica-Bold")
        .fillColor("#1e40af")
        .text(content.title || "Rapport", { align: "center" });
      doc.moveDown(0.5);

      // Ligne
      doc
        .strokeColor("#3b82f6")
        .lineWidth(2)
        .moveTo(50, doc.y)
        .lineTo(doc.page.width - 50, doc.y)
        .stroke();
      doc.moveDown();

      // Date
      doc
        .fontSize(10)
        .fillColor("#6b7280")
        .font("Helvetica")
        .text(
          `Date: ${new Date().toLocaleDateString("fr-FR", {
            year: "numeric",
            month: "long",
            day: "numeric",
          })}`,
          { align: "right" }
        );
      doc.moveDown(2);

      // Introduction
      if (content.introduction) {
        doc.fontSize(16).font("Helvetica-Bold").fillColor("#1f2937").text("Introduction");
        doc.moveDown(0.5);
        doc
          .fontSize(11)
          .font("Helvetica")
          .fillColor("#374151")
          .text(content.introduction, { align: "justify", lineGap: 3 });
        doc.moveDown(2);
      }

      // Sections
      if (Array.isArray(content.sections)) {
        content.sections.forEach((section, index) => {
          if (doc.y > 650) doc.addPage();
          doc
            .fontSize(14)
            .font("Helvetica-Bold")
            .fillColor("#1e40af")
            .text(`${index + 1}. ${section.title || "Section"}`);
          doc.moveDown(0.5);
          doc
            .fontSize(11)
            .font("Helvetica")
            .fillColor("#374151")
            .text(section.content || "", { align: "justify", lineGap: 3 });
          doc.moveDown(1.5);
        });
      }

      // Conclusion
      if (content.conclusion) {
        if (doc.y > 650) doc.addPage();
        doc.fontSize(16).font("Helvetica-Bold").fillColor("#1f2937").text("Conclusion");
        doc.moveDown(0.5);
        doc
          .fontSize(11)
          .font("Helvetica")
          .fillColor("#374151")
          .text(content.conclusion, { align: "justify", lineGap: 3 });
      }

      // Pagination
      const pages = doc.bufferedPageRange();
      for (let i = 0; i < pages.count; i++) {
        doc.switchToPage(i);
        doc
          .fontSize(8)
          .fillColor("#9ca3af")
          .text(`Page ${i + 1} sur ${pages.count}`, 50, doc.page.height - 50, { align: "center" });
      }

      doc.end();
    } catch (err) {
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

/**
 * POST /api/generate-and-send
 * Corps JSON (conforme au schéma fourni) :
 * {
 *   "email": "destinataire@exemple.com",
 *   "subject": "Rapport - [TITRE]",
 *   "reportContent": {
 *     "title": "...",
 *     "introduction": "...",
 *     "sections": [{ "title": "...", "content": "..." }],
 *     "conclusion": "..."
 *   }
 * }
 */
app.post("/api/generate-and-send", async (req, res) => {
  try {
    const { email, subject, reportContent } = req.body || {};

    // Validations
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
        details:
          "reportContent doit contenir title, introduction, sections (array d’objets {title, content}), conclusion",
      });
    }

    // Génération PDF
    const pdfBuffer = await generatePDF(reportContent);
    const pdfName = `rapport_${sanitizeFileName(reportContent.title)}_${Date.now()}.pdf`;

    // Corps HTML de l'e-mail
    const html = `
      <!DOCTYPE html>
      <html>
        <body style="font-family: Arial, sans-serif; line-height:1.6; color:#111827;">
          <h2 style="margin:0 0 8px 0;">📄 Votre rapport est prêt</h2>
          <div style="background:#e0e7ff;padding:12px;border-left:4px solid #667eea;border-radius:6px;margin:12px 0;">
            <strong>📌 Titre :</strong> ${escapeHtml(reportContent.title)}<br>
            <strong>📅 Date :</strong> ${new Date().toLocaleDateString("fr-FR")}
          </div>
          <p>Vous trouverez le rapport complet en pièce jointe au format PDF.</p>
          <p style="color:#6b7280;font-size:12px">© ${new Date().getFullYear()} ${escapeHtml(
            EMAIL_FROM_NAME
          )}</p>
        </body>
      </html>
    `;

    // Envoi
    try {
      await sendEmailWithPdf({
        to: email,
        subject, // on respecte le sujet fourni par l'appelant
        messageHtml: html,
        pdfBuffer,
        pdfFilename: pdfName,
      });
    } catch (err) {
      console.error("SMTP error:", {
        code: err.code,
        command: err.command,
        response: err.response,
        responseCode: err.responseCode,
        message: err.message,
      });
      return res.status(502).json({
        success: false,
        error: "Erreur SMTP lors de l'envoi",
        details: err.message,
      });
    }

    return res.json({
      success: true,
      message: "Rapport généré et envoyé avec succès",
      details: {
        email,
        pdfSizeKB: Number((pdfBuffer.length / 1024).toFixed(2)),
        fileName: pdfName,
      },
    });
  } catch (err) {
    console.error("❌ Erreur générale:", err);
    return res.status(500).json({
      success: false,
      error: "Erreur lors du traitement",
      details: err.message,
    });
  }
});

/**
 * POST /api/generate
 * -> Génère le PDF et le renvoie en téléchargement (sans e-mail)
 * Corps JSON attendu :
 * { "reportContent": { title, introduction, sections[], conclusion } }
 */
app.post("/api/generate", async (req, res) => {
  try {
    const { reportContent } = req.body || {};
    if (
      !reportContent ||
      !reportContent.title ||
      !reportContent.introduction ||
      !Array.isArray(reportContent.sections) ||
      !reportContent.conclusion
    ) {
      return res.status(400).json({
        success: false,
        error: "Structure du rapport invalide",
        details:
          "reportContent doit contenir title, introduction, sections (array d’objets {title, content}), conclusion",
      });
    }

    const pdfBuffer = await generatePDF(reportContent);
    const pdfName = `rapport_${sanitizeFileName(reportContent.title)}_${Date.now()}.pdf`;

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${pdfName}"`);
    return res.send(pdfBuffer);
  } catch (err) {
    console.error("❌ Erreur /api/generate:", err);
    return res.status(500).json({ success: false, error: "Erreur serveur", details: err.message });
  }
});

/**
 * GET /health
 */
app.get("/health", (_req, res) => {
  res.json({
    status: "OK",
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    service: "PDF Report API (M365 SMTP 587)",
  });
});

/**
 * GET /
 */
app.get("/", (_req, res) => {
  res.json({
    name: "GPT PDF Email API",
    version: "1.1.0",
    status: "running",
    smtpHost: SMTP_HOST,
    smtpPort: SMTP_PORT,
    endpoints: {
      health: "GET /health",
      generateAndSend: "POST /api/generate-and-send",
      generateOnly: "POST /api/generate",
    },
  });
});

// 404
app.use((req, res) => res.status(404).json({ error: "Route non trouvée", path: req.path }));

// 500
app.use((err, _req, res, _next) => {
  console.error("Erreur middleware:", err);
  res.status(500).json({ error: "Erreur serveur", message: err.message });
});

/* ============================ START ============================ */
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 API démarrée sur port ${PORT}`);
});

/* ============================ HELPERS ============================ */
function escapeHtml(str = "") {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// Gestion des erreurs non catchées
process.on("unhandledRejection", (r) => console.error("Unhandled Rejection:", r));
process.on("uncaughtException", (e) => {
  console.error("Uncaught Exception:", e);
  // On n'appelle pas process.exit(1) en prod PaaS pour laisser le processus redémarrer proprement
});
