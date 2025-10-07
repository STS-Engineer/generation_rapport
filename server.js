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
app.use(express.json({ limit: "50mb" })); // payload image volumineux
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

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
  .catch((err) => console.error("❌ SMTP erreur:", err.message));

/* ============================ UTILS ============================ */
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/**
 * Normalise & valide une Data URL base64 (ou chaîne base64 brute).
 * - Retire BOM/zero-width/CRLF
 * - Décode %xx si présent (cas %2B/%2F)
 * - Convertit espaces -> '+', base64url (-,_) -> standard (+,/)
 * - Ajoute le padding manquant (=) pour longueur %4
 * - Vérifie caractères autorisés et taille minimale
 * - Détecte le type via magic numbers
 * Retourne { buffer, mime }
 */
function sanitizeBase64DataUrl(input, opts = { debug: false }) {
  if (typeof input !== "string") throw new Error("image doit être une chaîne");

  let s = input
    .trim()
    .replace(/^\uFEFF/, "") // BOM
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, ""); // zero-width

  let mime = null;
  if (s.startsWith("data:")) {
    const comma = s.indexOf(",");
    if (comma === -1) throw new Error("Data URL invalide (pas de virgule)");
    const header = s.slice(5, comma); // après "data:"
    s = s.slice(comma + 1); // payload
    const parts = header.split(";");
    mime = parts[0] || null;
    const isBase64Declared = parts.some((p) => p.toLowerCase() === "base64");
    if (!isBase64Declared) {
      throw new Error("Le Data URL n’est pas en base64 (ex: ;utf8).");
    }
  }

  // Si on voit des %xx (url-encodé), décoder
  if (/%[0-9A-Fa-f]{2}/.test(s)) {
    try {
      s = decodeURIComponent(s);
    } catch {
      // ignore si invalide
    }
  }

  // Si payload a été url-encodé via form-urlencoded, '+' est devenu espace : on le rétablit
  s = s.replace(/ /g, "+");

  // Supprimer CR/LF/TAB
  s = s.replace(/[\r\n\t]/g, "");

  // base64url -> base64 standard
  s = s.replace(/-/g, "+").replace(/_/g, "/");

  // Padding à multiple de 4
  const mod4 = s.length % 4;
  if (mod4 === 2) s += "==";
  else if (mod4 === 3) s += "=";
  else if (mod4 === 1) throw new Error("Longueur base64 invalide");

  // Vérifier alphabet base64
  if (!/^[A-Za-z0-9+/=]+$/.test(s)) {
    const m = s.match(/[^A-Za-z0-9+/=]/);
    const pos = m ? s.indexOf(m[0]) : -1;
    throw new Error(
      pos >= 0
        ? `Contient un caractère non base64 à l'index ${pos} (code ${s.charCodeAt(
            pos
          )})`
        : "Contient des caractères non base64"
    );
  }

  const buf = Buffer.from(s, "base64");
  if (buf.length < 500) {
    throw new Error(
      `Image trop petite (${buf.length} octets). Minimum 500 octets requis.`
    );
  }

  // Détection type
  let detected = "unknown";
  if (buf[0] === 0xff && buf[1] === 0xd8) detected = "image/jpeg";
  else if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47
  )
    detected = "image/png";
  else if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46)
    detected = "image/gif";
  else if (
    buf.slice(0, 4).toString() === "RIFF" &&
    buf.slice(8, 12).toString() === "WEBP"
  )
    detected = "image/webp";

  if (opts.debug) {
    console.log(
      "[sanitizeBase64DataUrl] len:",
      s.length,
      "mod4:",
      mod4,
      "mime:",
      mime,
      "detected:",
      detected
    );
  }

  return { buffer: buf, mime: mime || detected };
}

function generatePDF(content) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        margin: 50,
        size: "A4",
        bufferPages: true,
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

      // En-tête
      doc
        .fontSize(26)
        .font("Helvetica-Bold")
        .fillColor("#1e40af")
        .text(content.title, { align: "center" });
      doc.moveDown(0.5);
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
        doc
          .fontSize(16)
          .font("Helvetica-Bold")
          .fillColor("#1f2937")
          .text("Introduction");
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
          if (doc.y > doc.page.height - 150) doc.addPage();

          doc
            .fontSize(14)
            .font("Helvetica-Bold")
            .fillColor("#1e40af")
            .text(`${index + 1}. ${section.title}`);
          doc.moveDown(0.5);

          if (section.content) {
            doc
              .fontSize(11)
              .font("Helvetica")
              .fillColor("#374151")
              .text(section.content, { align: "justify", lineGap: 3 });
            doc.moveDown(1);
          }

          // Image
          if (section.image) {
            try {
              const { buffer, mime } = sanitizeBase64DataUrl(section.image);

              // PDFKit supporte JPEG & PNG uniquement
              if (mime !== "image/jpeg" && mime !== "image/png") {
                throw new Error(
                  `Type d'image non supporté par PDFKit (${mime}). Utilisez JPEG ou PNG.`
                );
              }

              const maxWidth = doc.page.width - 100;
              const maxHeight = 300;

              if (doc.y > doc.page.height - maxHeight - 100) doc.addPage();

              const startY = doc.y;
              doc.image(buffer, { fit: [maxWidth, maxHeight], align: "center" });
              const imageHeight = doc.y - startY;

              if (imageHeight < 50) doc.moveDown(3);
              else doc.moveDown(1);

              if (section.imageCaption) {
                doc
                  .fontSize(9)
                  .fillColor("#6b7280")
                  .font("Helvetica-Oblique")
                  .text(section.imageCaption, { align: "center" });
                doc.moveDown(1);
              }
            } catch (imgError) {
              console.error("Erreur chargement image:", imgError.message);
              doc
                .fontSize(10)
                .fillColor("#ef4444")
                .text("⚠️ Erreur lors du chargement de l'image", {
                  align: "center",
                });
              doc
                .fontSize(8)
                .fillColor("#9ca3af")
                .text(`(${imgError.message})`, { align: "center" });
              doc.moveDown(1);
            }
          }

          doc.moveDown(1.5);
        });
      }

      // Conclusion
      if (content.conclusion) {
        if (doc.y > doc.page.height - 150) doc.addPage();
        doc
          .fontSize(16)
          .font("Helvetica-Bold")
          .fillColor("#1f2937")
          .text("Conclusion");
        doc.moveDown(0.5);
        doc
          .fontSize(11)
          .font("Helvetica")
          .fillColor("#374151")
          .text(content.conclusion, { align: "justify", lineGap: 3 });
      }

      // Pagination
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
    } catch (err) {
      console.error("Erreur génération PDF:", err);
      reject(err);
    }
  });
}

async function sendEmailWithPdf({
  to,
  subject,
  messageHtml,
  pdfBuffer,
  pdfFilename,
}) {
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
    const pdfName = `rapport_${reportContent.title
      .replace(/[^a-z0-9]/gi, "_")
      .toLowerCase()}_${Date.now()}.pdf`;

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

/**
 * Validation d'une image base64 (diagnostic rapide)
 */
app.post("/api/test-image", (req, res) => {
  try {
    const { imageData } = req.body || {};
    if (!imageData) {
      return res.status(400).json({ error: "imageData requis" });
    }

    const { buffer, mime } = sanitizeBase64DataUrl(imageData);
    const pdfkitOk = mime === "image/jpeg" || mime === "image/png";

    return res.json({
      success: true,
      mime,
      size: `${(buffer.length / 1024).toFixed(2)} KB`,
      pdfkitCompatible: pdfkitOk,
      note: pdfkitOk ? "OK pour PDFKit" : "Utilisez JPEG ou PNG pour PDFKit",
    });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

/**
 * Endpoint de debug pour voir où ça casse si besoin
 */
app.post("/api/debug/base64", (req, res) => {
  try {
    const { data } = req.body || {};
    if (!data) return res.status(400).json({ error: "champ 'data' requis" });

    try {
      const { buffer, mime } = sanitizeBase64DataUrl(data, { debug: true });
      return res.json({
        ok: true,
        mime,
        size: buffer.length,
        head: buffer.slice(0, 8).toString("hex"),
      });
    } catch (e) {
      const s = String(data);
      return res.status(400).json({
        ok: false,
        error: e.message,
        sampleStart: s.slice(0, 80),
        sampleEnd: s.slice(-40),
        length: s.length,
      });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
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
      generateAndSend: "POST /api/generate-and-send",
      testImage: "POST /api/test-image",
      debugBase64: "POST /api/debug/base64",
    },
  });
});

// 404
app.use((req, res) =>
  res.status(404).json({ error: "Route non trouvée", path: req.path })
);

// 500
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
process.on("uncaughtException", (e) => {
  console.error("Uncaught Exception:", e);
  process.exit(1);
});
