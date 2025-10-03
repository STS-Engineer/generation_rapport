/**
 * server.js — API GPT PDF Email (SMTP compatible Azure)
 * Dépendances :  npm i express pdfkit nodemailer cors
 */

"use strict";

const express = require("express");
const PDFDocument = require("pdfkit");
const nodemailer = require("nodemailer");
const cors = require("cors");

const app = express();

/* ========================= CONFIG SMTP ========================= */
/** 
 * IMPORTANT AZURE : Le port 25 est BLOQUÉ sur Azure App Service.
 * Solutions :
 * 1) Utilisez le port 587 avec authentification SMTP
 * 2) OU configurez un connecteur avec port 25 via Azure VM/Container
 */

// Option 1 : SMTP avec authentification (RECOMMANDÉ pour Azure)
const SMTP_HOST = process.env.SMTP_HOST || "smtp.office365.com";
const SMTP_PORT = parseInt(process.env.SMTP_PORT || "587", 10);
const SMTP_USER = process.env.SMTP_USER || "administration.STS@avocarbon.com";
const SMTP_PASS = process.env.SMTP_PASS || ""; // À DÉFINIR dans Azure App Settings

// Option 2 : EOP relay (nécessite un connecteur O365 ET Azure VM, pas App Service)
// const SMTP_HOST = "avocarbon-com.mail.protection.outlook.com";
// const SMTP_PORT = 25;

const EMAIL_FROM_NAME = "Administration STS";
const EMAIL_FROM = process.env.EMAIL_FROM || "administration.STS@avocarbon.com";

/* ========================= MIDDLEWARES ========================= */
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.use((req, _res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

/* ====================== TRANSPORTEUR SMTP ====================== */
const transporterConfig = {
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: SMTP_PORT === 465, // true pour 465, false pour 587
  tls: { 
    minVersion: "TLSv1.2",
    rejectUnauthorized: process.env.NODE_ENV === "production" // Strict en production
  },
};

// Ajout de l'authentification si les credentials sont fournis
if (SMTP_USER && SMTP_PASS) {
  transporterConfig.auth = {
    user: SMTP_USER,
    pass: SMTP_PASS,
  };
  console.log("ℹ️  Mode SMTP : Authentification activée");
} else {
  console.log("⚠️  Mode SMTP : Relay sans authentification (vérifiez le connecteur O365)");
}

const transporter = nodemailer.createTransport(transporterConfig);

// Test transport SMTP au démarrage
transporter
  .verify()
  .then(() => console.log(`✅ SMTP prêt sur ${SMTP_HOST}:${SMTP_PORT}`))
  .catch((err) => {
    console.error("❌ SMTP erreur:", err.message);
    if (SMTP_PORT === 25) {
      console.error("⚠️  Le port 25 est bloqué sur Azure App Service. Utilisez le port 587 avec authentification.");
    }
  });

/* ============================ UTILS ============================ */
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

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

async function sendEmailWithPdf({ to, subject, messageHtml, pdfBuffer, pdfFilename }) {
  return transporter.sendMail({
    from: { name: EMAIL_FROM_NAME, address: EMAIL_FROM },
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
      message: "Rapport généré et envoyé avec succès",
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
    smtp_auth: !!(SMTP_USER && SMTP_PASS),
    from: EMAIL_FROM,
  });
});

app.get("/", (_req, res) => {
  res.json({
    name: "GPT PDF Email API",
    version: "1.0.0",
    endpoints: {
      health: "GET /health",
      generateAndSend: "POST /api/generate-and-send",
    },
  });
});

app.use((req, res) => res.status(404).json({ error: "Route non trouvée", path: req.path }));

app.use((err, _req, res, _next) => {
  console.error("Erreur globale:", err);
  res.status(500).json({ error: "Erreur serveur interne", message: err.message });
});

/* ============================ START ============================ */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════╗
║   🚀 API GPT PDF Email                ║
║   📡 Port: ${PORT}                        
║   🔧 SMTP: ${SMTP_HOST}:${SMTP_PORT}      
╚════════════════════════════════════════╝
  `);
});

process.on("unhandledRejection", (r) => console.error("Unhandled Rejection:", r));
process.on("uncaughtException", (e) => { console.error("Uncaught Exception:", e); process.exit(1); });
