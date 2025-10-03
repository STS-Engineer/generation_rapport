/**
 * server.js — API GPT PDF Email (Azure-friendly)
 * Dépendances: npm i express pdfkit nodemailer cors
 */

"use strict";

const express = require("express");
const PDFDocument = require("pdfkit");
const nodemailer = require("nodemailer");
const cors = require("cors");

const app = express();

/* ======================= CONFIG ======================= */
/** SMTP : Office 365 submission (587 + AUTH) — recommandé sur Azure */
const EMAIL_FROM_NAME = "Administration STS";
const EMAIL_FROM = "administration.STS@avocarbon.com";
const EMAIL_USER = "administration.STS@avocarbon.com";

/** ⚠️ Mettez le mot de passe ici OU, mieux, dans App Settings Azure (EMAIL_PASSWORD) */
const EMAIL_PASSWORD = process.env.EMAIL_PASSWORD || "APP_PASSWORD_OU_MDP_ICI";

const O365_HOST = "smtp.office365.com";
const O365_PORT = 587;

/* ===================== MIDDLEWARES ===================== */
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type", "Authorization", "X-API-KEY"]
  })
);
app.use((req, _res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path} | ct=${req.get("content-type") || "n/a"}`);
  next();
});

/* ================== SMTP TRANSPORTER =================== */
if (!EMAIL_USER || !EMAIL_PASSWORD) {
  console.warn("⚠️ EMAIL_USER/EMAIL_PASSWORD manquants. Définissez EMAIL_PASSWORD dans Azure App Settings si possible.");
}

const transporter = nodemailer.createTransport({
  host: O365_HOST,
  port: O365_PORT,
  secure: false, // STARTTLS
  auth: { user: EMAIL_USER, pass: EMAIL_PASSWORD },
  tls: { minVersion: "TLSv1.2" }
});

transporter.verify()
  .then(() => console.log("✅ SMTP 587 prêt (Office 365 submission)"))
  .catch(err => console.error("❌ SMTP erreur:", err && err.message));

/* ======================== UTILS ======================== */
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/**
 * Génère un PDF (Buffer) depuis {title, introduction, sections:[{title,content}], conclusion}
 * Fix: bufferPages:true + boucle paginations sécurisée
 */
function generatePDF(content) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        margin: 50,
        size: "A4",
        bufferPages: true, // <-- important pour switchToPage
        info: { Title: content.title, Author: "Assistant GPT", Subject: content.title }
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
      doc.fontSize(10).fillColor("#6b7280").font("Helvetica")
        .text(`Date: ${new Date().toLocaleDateString("fr-FR", { year: "numeric", month: "long", day: "numeric" })}`, { align: "right" });
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

      // Pagination (sécurisée)
      try {
        const pages = doc.bufferedPageRange();
        const count = pages && typeof pages.count === "number" ? pages.count : 0;
        for (let i = 0; i < count; i++) {
          doc.switchToPage(i);
          doc.fontSize(8).fillColor("#9ca3af")
            .text(`Page ${i + 1} sur ${count}`, 50, doc.page.height - 50, { align: "center" });
        }
      } catch (e) {
        console.warn("⚠️ Pagination non appliquée:", e && e.message);
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Envoi email avec PDF
 */
async function sendEmailWithPdf({ to, subject, messageHtml, pdfBuffer, pdfFilename }) {
  return transporter.sendMail({
    from: { name: EMAIL_FROM_NAME, address: EMAIL_FROM },
    to,
    subject,
    html: messageHtml,
    attachments: [{ filename: pdfFilename, content: pdfBuffer, contentType: "application/pdf" }]
  });
}

/* ========================= ROUTES ========================= */
app.post("/api/generate-and-send", async (req, res) => {
  try {
    const body = req.body || {};
    let email = (body.email || "").toString().trim().replace(/\s+/g, "");
    const subject = (body.subject || "").toString().trim();
    const reportContent = body.reportContent;

    if (!email || !subject || !reportContent) {
      return res.status(400).json({ success: false, error: "Données manquantes", details: "email, subject, reportContent requis" });
    }
    if (!isValidEmail(email)) {
      return res.status(400).json({ success: false, error: "Email invalide", details: `Adresse reçue: "${email}"` });
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
        details: "title, introduction, sections (array), conclusion requis"
      });
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

    await sendEmailWithPdf({ to: email, subject, messageHtml: html, pdfBuffer, pdfFilename: pdfName });

    return res.json({
      success: true,
      message: "Rapport généré et envoyé avec succès (Office365:587)",
      details: { email, pdfSize: `${(pdfBuffer.length / 1024).toFixed(2)} KB` }
    });
  } catch (err) {
    console.error("❌ Erreur:", err);
    return res.status(500).json({ success: false, error: "Erreur lors du traitement", details: err.message });
  }
});

app.get("/health", (_req, res) => {
  res.json({
    status: "OK",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    smtp_mode: "office365",
    smtp_host: O365_HOST,
    smtp_port: O365_PORT,
    from: EMAIL_FROM
  });
});

app.get("/", (_req, res) => {
  res.json({
    name: "GPT PDF Email API",
    version: "1.0.0",
    endpoints: { health: "GET /health", generateAndSend: "POST /api/generate-and-send" },
    smtp_mode: "office365"
  });
});

// 404
app.use((req, res) => res.status(404).json({ error: "Route non trouvée", path: req.path }));

// 500
app.use((err, _req, res, _next) => {
  console.error("Erreur globale:", err);
  res.status(500).json({ error: "Erreur serveur interne", message: err.message });
});

/* ========================= START ========================= */
const PORT = process.env.PORT || 3000; // <-- essentiel sur Azure
app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════╗
║   🚀 API GPT PDF Email (Azure)        ║
║   📡 Port: ${PORT}
║   🔐 SMTP: Office365 (587 + AUTH)
╚════════════════════════════════════════╝
  `);
});

process.on("unhandledRejection", (r) => console.error("Unhandled Rejection:", r));
process.on("uncaughtException", (e) => { console.error("Uncaught Exception:", e); process.exit(1); });
