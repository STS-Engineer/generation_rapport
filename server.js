/**
 * server.js — API GPT PDF Email (SMTP EOP :25, sans authentification)
 * Dépendances :  npm i express pdfkit nodemailer cors
 * Test POST (Postman):
 *   URL:     http://localhost:3000/api/generate-and-send
 *   Headers: Content-Type: application/json
 *   Body: {
 *     "email": "majed.messai@avocarbon.com",
 *     "subject": "Test de rapport GPT",
 *     "reportContent": {
 *       "title": "Rapport hebdo STS",
 *       "introduction": "Résumé des activités de la semaine.",
 *       "sections": [
 *         { "title": "Incidents", "content": "Aucun incident critique." },
 *         { "title": "Projets", "content": "Avancement normal." }
 *       ],
 *       "conclusion": "Actions prévues."
 *     }
 *   }
 */

"use strict";

const express = require("express");
const PDFDocument = require("pdfkit");
const nodemailer = require("nodemailer");
const cors = require("cors");

const app = express();

/* ========================= CONFIG FIXE ========================= */
/** Mode EOP (relay) — pas d'authentification */
const SMTP_HOST = "avocarbon-com.mail.protection.outlook.com";
const SMTP_PORT = 25;

/** Identité d'expéditeur (doit être autorisée par le connector) */
const EMAIL_FROM_NAME = "Administration STS";
const EMAIL_FROM = "administration.STS@avocarbon.com";

/* ========================= MIDDLEWARES ========================= */
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true })); // accepte aussi x-www-form-urlencoded
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// Log simple + type de contenu pour debug
app.use((req, _res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path} | type=${req.get("content-type") || "n/a"}`);
  next();
});

/* ====================== TRANSPORTEUR SMTP ====================== */
/** IMPORTANT : pas d'auth ici. L'IP publique du serveur doit être autorisée dans un connector O365. */
const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: false,
  tls: { minVersion: "TLSv1.2" },
});

// Test transport SMTP au démarrage
transporter
  .verify()
  .then(() => console.log("✅ SMTP EOP prêt (port 25, sans auth)"))
  .catch((err) => console.error("❌ SMTP erreur:", err.message));

/* ============================ UTILS ============================ */
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/**
 * Génère un PDF (Buffer) depuis {title, introduction, sections:[{title,content}], conclusion}
 */
function generatePDF(content) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        margin: 50,
        size: "A4",
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
        doc.fontSize(11).font("Helvetica").fillColor("#374151")
          .text(content.introduction, { align: "justify", lineGap: 3 });
        doc.moveDown(2);
      }

      // Sections
      if (Array.isArray(content.sections)) {
        content.sections.forEach((section, index) => {
          if (doc.y > 650) doc.addPage();
          doc.fontSize(14).font("Helvetica-Bold").fillColor("#1e40af").text(`${index + 1}. ${section.title}`);
          doc.moveDown(0.5);
          doc.fontSize(11).font("Helvetica").fillColor("#374151")
            .text(section.content, { align: "justify", lineGap: 3 });
          doc.moveDown(1.5);
        });
      }

      // Conclusion
      if (content.conclusion) {
        if (doc.y > 650) doc.addPage();
        doc.fontSize(16).font("Helvetica-Bold").fillColor("#1f2937").text("Conclusion");
        doc.moveDown(0.5);
        doc.fontSize(11).font("Helvetica").fillColor("#374151")
          .text(content.conclusion, { align: "justify", lineGap: 3 });
      }

      // Pagination
      const pages = doc.bufferedPageRange();
      for (let i = 0; i < pages.count; i++) {
        doc.switchToPage(i);
        doc.fontSize(8).fillColor("#9ca3af").text(
          `Page ${i + 1} sur ${pages.count}`,
          50,
          doc.page.height - 50,
          { align: "center" }
        );
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Envoie un email avec le PDF en pièce jointe (via EOP port 25)
 */
async function sendEmailWithPdf({ to, subject, messageHtml, pdfBuffer, pdfFilename }) {
  return transporter.sendMail({
    from: { name: EMAIL_FROM_NAME, address: EMAIL_FROM }, // doit être autorisé par le connector
    to,
    subject,
    html: messageHtml,
    attachments: [
      { filename: pdfFilename, content: pdfBuffer, contentType: "application/pdf" },
    ],
  });
}

/* ============================ ROUTES ============================ */
app.post("/api/generate-and-send", async (req, res) => {
  try {
    const { email, subject, reportContent } = req.body || {};

    if (!email || !subject || !reportContent) {
      return res.status(400).json({
        success: false,
        error: "Données manquantes",
        details: "Envoyez un JSON avec email, subject, reportContent",
        example: {
          email: "majed.messai@avocarbon.com",
          subject: "Test",
          reportContent: {
            title: "Titre",
            introduction: "Intro",
            sections: [{ title: "S1", content: "C1" }],
            conclusion: "Fin",
          },
        },
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
        details: "title, introduction, sections (array), conclusion sont requis",
      });
    }

    // Génération du PDF
    const pdfBuffer = await generatePDF(reportContent);
    const pdfName = `rapport_${reportContent.title.replace(/[^a-z0-9]/gi, "_").toLowerCase()}_${Date.now()}.pdf`;

    // Corps HTML du mail
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

    // Envoi
    await sendEmailWithPdf({
      to: email,
      subject: `Rapport : ${reportContent.title}`,
      messageHtml: html,
      pdfBuffer,
      pdfFilename: pdfName,
    });

    return res.json({
      success: true,
      message: "Rapport généré et envoyé avec succès (EOP relay, sans auth)",
      details: {
        email,
        pdfSize: `${(pdfBuffer.length / 1024).toFixed(2)} KB`,
      },
    });
  } catch (err) {
    console.error("❌ Erreur:", err);
    return res.status(500).json({
      success: false,
      error: "Erreur lors du traitement",
      details: err.message,
    });
  }
});

app.get("/health", (_req, res) => {
  res.json({
    status: "OK",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    smtp_host: SMTP_HOST,
    smtp_port: SMTP_PORT,
    mode: "EOP (relay sans auth)",
    from: EMAIL_FROM,
  });
});

app.get("/", (_req, res) => {
  res.json({
    name: "GPT PDF Email API (EOP :25, sans auth)",
    version: "1.0.0",
    endpoints: {
      health: "GET /health",
      generateAndSend: "POST /api/generate-and-send",
    },
  });
});

// 404
app.use((req, res) => res.status(404).json({ error: "Route non trouvée", path: req.path }));

// 500
app.use((err, _req, res, _next) => {
  console.error("Erreur globale:", err);
  res.status(500).json({ error: "Erreur serveur interne", message: err.message });
});

/* ============================ START ============================ */
const PORT = 3000;
app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════╗
║   🚀 API GPT PDF Email (EOP :25)      ║
║   📡 Port: ${PORT}
║   🌍 Mode: EOP relay (sans auth)
╚════════════════════════════════════════╝
  `);
});

// Hardening erreurs non capturées
process.on("unhandledRejection", (r) => console.error("Unhandled Rejection:", r));
process.on("uncaughtException", (e) => { console.error("Uncaught Exception:", e); process.exit(1); });
