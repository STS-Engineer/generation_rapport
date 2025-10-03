/**
 * server.js — API GPT PDF Email (BUGFIX switchToPage + SMTP auth)
 * npm i express pdfkit nodemailer cors
 */

"use strict";

const express = require("express");
const PDFDocument = require("pdfkit");
const nodemailer = require("nodemailer");
const cors = require("cors");

const app = express();

/* ========================= CONFIG ========================= */
const SMTP_HOST = process.env.SMTP_HOST || "smtp.office365.com";
const SMTP_PORT = parseInt(process.env.SMTP_PORT || "587", 10);
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";
const EMAIL_FROM = process.env.EMAIL_FROM || "administration.STS@avocarbon.com";
const EMAIL_FROM_NAME = "Administration STS";

/* ========================= MIDDLEWARES ========================= */
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cors());

/* ====================== SMTP TRANSPORT ====================== */
let transporter;
let smtpError = null;

try {
  const config = {
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    tls: { 
      minVersion: "TLSv1.2",
      rejectUnauthorized: false // Permet les certificats auto-signés en dev
    },
  };

  if (SMTP_USER && SMTP_PASS) {
    config.auth = { user: SMTP_USER, pass: SMTP_PASS };
    console.log(`✅ SMTP: ${SMTP_HOST}:${SMTP_PORT} (auth: ${SMTP_USER})`);
  } else {
    console.log(`⚠️  SMTP: ${SMTP_HOST}:${SMTP_PORT} (SANS auth)`);
    smtpError = "Identifiants SMTP manquants (SMTP_USER/SMTP_PASS non définis)";
  }

  transporter = nodemailer.createTransport(config);

  // Test connexion
  transporter.verify()
    .then(() => {
      console.log("✅ SMTP connexion validée");
      smtpError = null;
    })
    .catch(err => {
      console.error("❌ SMTP erreur:", err.message);
      smtpError = err.message;
    });

} catch (err) {
  console.error("❌ Erreur création transporter:", err.message);
  smtpError = err.message;
}

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
        bufferPages: true, // IMPORTANT pour switchToPage
        info: { Title: content.title, Author: "Assistant GPT" },
      });

      const chunks = [];
      doc.on("data", (c) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      // En-tête
      doc.fontSize(24).font("Helvetica-Bold").fillColor("#1e40af")
        .text(content.title, { align: "center" });
      doc.moveDown(0.5);
      doc.strokeColor("#3b82f6").lineWidth(2)
        .moveTo(50, doc.y).lineTo(doc.page.width - 50, doc.y).stroke();
      doc.moveDown(2);

      // Date
      doc.fontSize(10).fillColor("#6b7280").font("Helvetica")
        .text(`Date: ${new Date().toLocaleDateString("fr-FR")}`, { align: "right" });
      doc.moveDown(2);

      // Introduction
      if (content.introduction) {
        doc.fontSize(14).font("Helvetica-Bold").fillColor("#1f2937").text("Introduction");
        doc.moveDown(0.5);
        doc.fontSize(11).font("Helvetica").fillColor("#374151")
          .text(content.introduction, { align: "justify", lineGap: 3 });
        doc.moveDown(2);
      }

      // Sections
      if (Array.isArray(content.sections)) {
        content.sections.forEach((section, i) => {
          if (doc.y > 650) doc.addPage();
          doc.fontSize(13).font("Helvetica-Bold").fillColor("#1e40af")
            .text(`${i + 1}. ${section.title}`);
          doc.moveDown(0.5);
          doc.fontSize(11).font("Helvetica").fillColor("#374151")
            .text(section.content, { align: "justify", lineGap: 3 });
          doc.moveDown(1.5);
        });
      }

      // Conclusion
      if (content.conclusion) {
        if (doc.y > 650) doc.addPage();
        doc.fontSize(14).font("Helvetica-Bold").fillColor("#1f2937").text("Conclusion");
        doc.moveDown(0.5);
        doc.fontSize(11).font("Helvetica").fillColor("#374151")
          .text(content.conclusion, { align: "justify", lineGap: 3 });
      }

      // PAGINATION CORRIGÉE - Ne pas utiliser switchToPage si une seule page
      const range = doc.bufferedPageRange();
      if (range && range.count > 0) {
        for (let i = 0; i < range.count; i++) {
          doc.switchToPage(i);
          doc.fontSize(8).fillColor("#9ca3af").text(
            `Page ${i + 1}/${range.count}`,
            50,
            doc.page.height - 50,
            { align: "center", width: doc.page.width - 100 }
          );
        }
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

async function sendEmailWithPdf({ to, subject, messageHtml, pdfBuffer, pdfFilename }) {
  if (!transporter) {
    throw new Error("SMTP transporter non initialisé");
  }
  if (smtpError) {
    throw new Error(`SMTP non disponible: ${smtpError}`);
  }
  
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

    // Validation
    if (!email || !subject || !reportContent) {
      return res.status(400).json({
        success: false,
        error: "Paramètres manquants",
        required: ["email", "subject", "reportContent"],
      });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({ success: false, error: "Email invalide" });
    }

    if (!reportContent.title || !reportContent.introduction || 
        !Array.isArray(reportContent.sections) || !reportContent.conclusion) {
      return res.status(400).json({
        success: false,
        error: "Structure reportContent invalide",
        required: ["title", "introduction", "sections[]", "conclusion"],
      });
    }

    // Vérification SMTP avant génération PDF
    if (smtpError) {
      return res.status(503).json({
        success: false,
        error: "Service SMTP indisponible",
        details: smtpError,
        hint: "Vérifiez SMTP_USER et SMTP_PASS dans Azure App Settings",
      });
    }

    // Génération PDF
    console.log(`[${new Date().toISOString()}] Génération PDF pour: ${email}`);
    const pdfBuffer = await generatePDF(reportContent);
    const pdfName = `rapport_${Date.now()}.pdf`;

    // Email HTML
    const html = `
      <!DOCTYPE html>
      <html>
        <body style="font-family: Arial, sans-serif; line-height:1.6; color:#111827;">
          <h2>📄 Votre rapport est prêt</h2>
          <div style="background:#e0e7ff;padding:12px;border-left:4px solid #667eea;margin:12px 0;">
            <strong>Sujet :</strong> ${subject}<br>
            <strong>Titre :</strong> ${reportContent.title}<br>
            <strong>Date :</strong> ${new Date().toLocaleDateString("fr-FR")}
          </div>
          <p>Vous trouverez le rapport complet en pièce jointe.</p>
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

    console.log(`[${new Date().toISOString()}] ✅ Rapport envoyé à ${email}`);
    return res.json({
      success: true,
      message: "Rapport généré et envoyé avec succès",
      details: { 
        email, 
        pdfSize: `${(pdfBuffer.length / 1024).toFixed(2)} KB`,
        timestamp: new Date().toISOString(),
      },
    });

  } catch (err) {
    console.error(`[${new Date().toISOString()}] ❌ Erreur:`, err);
    return res.status(500).json({
      success: false,
      error: "Erreur lors du traitement",
      details: err.message,
      stack: process.env.NODE_ENV === "development" ? err.stack : undefined,
    });
  }
});

app.get("/health", (_req, res) => {
  res.json({
    status: smtpError ? "DEGRADED" : "OK",
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    config: {
      smtp_host: SMTP_HOST,
      smtp_port: SMTP_PORT,
      smtp_auth: !!(SMTP_USER && SMTP_PASS),
      smtp_user: SMTP_USER ? SMTP_USER.substring(0, 10) + "..." : "non défini",
      smtp_error: smtpError || null,
      email_from: EMAIL_FROM,
    },
  });
});

app.get("/", (_req, res) => {
  res.json({
    name: "GPT PDF Email API",
    version: "1.1.0",
    status: "running",
    endpoints: {
      health: "GET /health",
      generate: "POST /api/generate-and-send",
    },
  });
});

// 404
app.use((req, res) => {
  res.status(404).json({ error: "Route non trouvée", path: req.path });
});

// Error handler
app.use((err, _req, res, _next) => {
  console.error("Erreur globale:", err);
  res.status(500).json({ error: "Erreur serveur", message: err.message });
});

/* ============================ START ============================ */
const PORT = process.env.PORT || 8080;

app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════╗
║  🚀 API PDF Email v1.1.0              ║
║  📡 Port: ${PORT}                        
║  🔧 SMTP: ${SMTP_HOST}:${SMTP_PORT}
║  📧 From: ${EMAIL_FROM}
║  ${smtpError ? '⚠️  SMTP: ' + smtpError.substring(0, 30) : '✅ SMTP: OK'}
╚════════════════════════════════════════╝
  `);
});

// Gestion des erreurs non capturées
process.on("unhandledRejection", (reason) => {
  console.error("⚠️  Unhandled Rejection:", reason);
});

process.on("uncaughtException", (error) => {
  console.error("❌ Uncaught Exception:", error);
  process.exit(1);
});
