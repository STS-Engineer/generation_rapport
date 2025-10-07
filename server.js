"use strict";

const express = require("express");
const PDFDocument = require("pdfkit");
const nodemailer = require("nodemailer");
const cors = require("cors");

const app = express();

/* ========================= CONFIG FIXE ========================= */
const SMTP_HOST = "avocarbon-com.mail.protection.outlook.com";
const SMTP_PORT = 25;
const EMAIL_FROM_NAME = "Administration STS";
const EMAIL_FROM = "administration.STS@avocarbon.com";

/* ========================= MIDDLEWARES ========================= */
app.use(express.json({ limit: "50mb" })); // Augmenté pour les images
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// CORS plus permissif pour ChatGPT
app.use(
  cors({
    origin: true,
    credentials: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "openai-conversation-id", "openai-ephemeral-user-id"],
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
  secure: false,
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
        doc.fontSize(11).font("Helvetica").fillColor("#374151")
          .text(content.introduction, { align: "justify", lineGap: 3 });
        doc.moveDown(2);
      }

      // Sections
      if (Array.isArray(content.sections)) {
        content.sections.forEach((section, index) => {
          // Vérifier si besoin d'une nouvelle page
          if (doc.y > doc.page.height - 150) {
            doc.addPage();
          }
          
          doc.fontSize(14).font("Helvetica-Bold").fillColor("#1e40af").text(`${index + 1}. ${section.title}`);
          doc.moveDown(0.5);
          
          // Contenu texte
          if (section.content) {
            doc.fontSize(11).font("Helvetica").fillColor("#374151")
              .text(section.content, { align: "justify", lineGap: 3 });
            doc.moveDown(1);
          }
          
          // Image (si présente)
          if (section.image) {
            try {
              // Extraire les données base64
              let imageBuffer;
              if (section.image.startsWith('data:')) {
                // Format: data:image/png;base64,iVBORw0KG...
                const base64Data = section.image.split(',')[1] || section.image.split(',')[0];
                imageBuffer = Buffer.from(base64Data, 'base64');
              } else {
                // Base64 pur
                imageBuffer = Buffer.from(section.image, 'base64');
              }
              
              // Calculer les dimensions
              const maxWidth = doc.page.width - 100; // Marges
              const maxHeight = 300; // Hauteur max de l'image
              
              // Vérifier si on a assez d'espace, sinon nouvelle page
              if (doc.y > doc.page.height - maxHeight - 100) {
                doc.addPage();
              }
              
              // Options d'image
              const imageOptions = {
                fit: [maxWidth, maxHeight],
                align: 'center',
                valign: 'center'
              };
              
              // Ajouter l'image
              doc.image(imageBuffer, {
                ...imageOptions,
                x: (doc.page.width - maxWidth) / 2,
                y: doc.y
              });
              
              doc.moveDown(2);
              
              // Légende (si présente)
              if (section.imageCaption) {
                doc.fontSize(9).fillColor("#6b7280").font("Helvetica-Oblique")
                  .text(section.imageCaption, { align: "center" });
                doc.moveDown(1);
              }
              
            } catch (imgError) {
              console.error("Erreur chargement image:", imgError);
              doc.fontSize(10).fillColor("#ef4444")
                .text("⚠️ Erreur lors du chargement de l'image", { align: "center" });
              doc.moveDown(1);
            }
          }
          
          doc.moveDown(1.5);
        });
      }

      // Conclusion
      if (content.conclusion) {
        if (doc.y > doc.page.height - 150) {
          doc.addPage();
        }
        
        doc.fontSize(16).font("Helvetica-Bold").fillColor("#1f2937").text("Conclusion");
        doc.moveDown(0.5);
        doc.fontSize(11).font("Helvetica").fillColor("#374151")
          .text(content.conclusion, { align: "justify", lineGap: 3 });
      }

      // Numéros de page
      const range = doc.bufferedPageRange();
      
      for (let i = 0; i < range.count; i++) {
        doc.switchToPage(i);
        
        const oldY = doc.y;
        
        doc.fontSize(8).fillColor("#9ca3af");
        doc.text(
          `Page ${i + 1} sur ${range.count}`,
          50,
          doc.page.height - 50,
          { 
            align: "center",
            lineBreak: false,
            width: doc.page.width - 100
          }
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
    uptime: Math.floor(process.uptime()),
    service: "PDF Report API"
  });
});

app.get("/", (_req, res) => {
  res.json({
    name: "GPT PDF Email API",
    version: "1.0.0",
    status: "running",
    endpoints: {
      health: "GET /health",
      generateAndSend: "POST /api/generate-and-send",
    },
  });
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
