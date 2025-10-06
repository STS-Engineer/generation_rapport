"use strict";

const express = require("express");
const PDFDocument = require("pdfkit");
const nodemailer = require("nodemailer");
const cors = require("cors");

const app = express();

/* ========================= CONFIG ========================= */
const EMAIL_FROM_NAME = process.env.EMAIL_FROM_NAME || "Administration STS";
const EMAIL_FROM = process.env.EMAIL_FROM || "administration.STS@avocarbon.com";

// SMTP Office 365 recommandé (STARTTLS 587)
const SMTP_HOST = process.env.SMTP_HOST || "smtp.office365.com";
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_USER = process.env.M365_USER || EMAIL_FROM;                 // Doit être autorisé pour "Send As"
const SMTP_PASS = process.env.M365_PASSWORD || process.env.M365_APP_PASSWORD;

/* ========================= MIDDLEWARES ========================= */
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

app.use(
  cors({
    origin: true,
    credentials: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "openai-conversation-id", "openai-ephemeral-user-id"],
  })
);
app.options("*", cors());

// Forcer JSON (évite retours HTML proxy) + logs simples
app.use((req, res, next) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

/* ====================== TRANSPORTEUR SMTP ====================== */
const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: false,          // STARTTLS
  requireTLS: true,
  auth: SMTP_USER && SMTP_PASS ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
  tls: { minVersion: "TLSv1.2" },
});

transporter
  .verify()
  .then(() => console.log("✅ SMTP prêt:", SMTP_HOST, SMTP_PORT))
  .catch((err) => console.error("❌ SMTP erreur:", err && err.message));

/* ============================ UTILS ============================ */
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function b64ToBufferMaybe(data) {
  if (!data) return null;
  const commaIdx = data.indexOf(",");
  const b64 = data.startsWith("data:") ? data.slice(commaIdx + 1) : data;
  try {
    return Buffer.from(b64, "base64");
  } catch {
    return null;
  }
}

function looksLikePngOrJpeg(buf) {
  if (!buf || buf.length < 10) return false;
  const isJpeg = buf[0] === 0xff && buf[1] === 0xd8;
  const pngSig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const isPng = pngSig.every((b, i) => buf[i] === b);
  return isJpeg || isPng;
}

function drawTable(doc, { caption, headers = [], rows = [] }, opts = {}) {
  const startX = opts.x || 50;
  let y = opts.y || doc.y;
  const pageW = doc.page.width - 100; // 50 de marge chaque côté
  const colCount = Math.max(headers.length, ...(rows.map((r) => r.length)), 1);
  const colW = pageW / colCount;
  const rowH = 20;

  if (caption) {
    doc.fontSize(13).font("Helvetica-Bold").fillColor("#1f2937").text(caption, startX, y);
    y += 18;
  }

  if (headers.length) {
    doc.rect(startX, y, pageW, rowH).fill("#e5e7eb").stroke("#d1d5db");
    headers.forEach((h, i) => {
      doc.fillColor("#111827").font("Helvetica-Bold").fontSize(10)
        .text(String(h), startX + i * colW + 6, y + 6, { width: colW - 12, ellipsis: true });
    });
    y += rowH;
  }

  rows.forEach((row) => {
    if (y + rowH > doc.page.height - 80) {
      doc.addPage();
      y = 50;
    }
    doc.rect(startX, y, pageW, rowH).stroke("#e5e7eb");
    row.forEach((cell, i) => {
      doc.fillColor("#374151").font("Helvetica").fontSize(10)
        .text(String(cell ?? ""), startX + i * colW + 6, y + 6, { width: colW - 12, ellipsis: true });
    });
    y += rowH;
  });

  doc.moveDown();
  return y;
}

function safeAddImage(doc, { caption, imageBase64 }, opts = {}) {
  const { label = "image", maxW = doc.page.width - 100, maxH = 300 } = opts;
  const buf = b64ToBufferMaybe(imageBase64);
  if (!buf || !looksLikePngOrJpeg(buf)) {
    console.error(`❌ ${label}: buffer invalide ou format non PNG/JPEG`);
    if (doc.y > 600) doc.addPage();
    if (caption) doc.fontSize(12).fillColor("#991b1b").text(`${caption} indisponible`, { align: "left" });
    doc.moveDown(0.25);
    doc.rect(50, doc.y, maxW, 40).stroke("#ef4444");
    doc.moveDown(2);
    return false;
  }
  try {
    if (doc.y > 600) doc.addPage();
    if (caption) {
      doc.fontSize(14).font("Helvetica-Bold").fillColor("#1e40af").text(caption, { align: "left" });
      doc.moveDown(0.5);
    }
    doc.image(buf, { fit: [maxW, maxH], align: "center" });
    doc.moveDown(1.5);
    return true;
  } catch (e) {
    console.error(`❌ ${label}: ${e.message}`);
    if (caption) doc.fontSize(12).fillColor("#991b1b").text(`${caption} non rendue`, { align: "left" });
    doc.moveDown(0.25);
    doc.rect(50, doc.y, maxW, 40).stroke("#ef4444");
    doc.moveDown(2);
    return false;
  }
}

/* ======================== PDF GENERATION ======================== */
function generatePDF(content) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        bufferPages: true, // ✅ indispensable pour switchToPage
        margin: 50,
        size: "A4",
        info: { Title: content.title, Author: "Assistant GPT", Subject: content.title },
      });

      const chunks = [];
      doc.on("data", (c) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      // Titre
      doc.fontSize(26).font("Helvetica-Bold").fillColor("#1e40af").text(content.title, { align: "center" });
      doc.moveDown(0.5);
      doc.strokeColor("#3b82f6").lineWidth(2).moveTo(50, doc.y).lineTo(doc.page.width - 50, doc.y).stroke();
      doc.moveDown();

      // Date
      doc
        .fontSize(10)
        .fillColor("#6b7280")
        .font("Helvetica")
        .text(`Date: ${new Date().toLocaleDateString("fr-FR", { year: "numeric", month: "long", day: "numeric" })}`, {
          align: "right",
        });
      doc.moveDown(2);

      // Introduction
      if (content.introduction) {
        doc.fontSize(16).font("Helvetica-Bold").fillColor("#1f2937").text("Introduction");
        doc.moveDown(0.5);
        doc.fontSize(11).font("Helvetica").fillColor("#374151").text(content.introduction, {
          align: "justify",
          lineGap: 3,
        });
        doc.moveDown(2);
      }

      // Sections
      if (Array.isArray(content.sections)) {
        content.sections.forEach((section, index) => {
          if (doc.y > 650) doc.addPage();
          doc.fontSize(14).font("Helvetica-Bold").fillColor("#1e40af").text(`${index + 1}. ${section.title}`);
          doc.moveDown(0.5);
          doc.fontSize(11).font("Helvetica").fillColor("#374151").text(section.content, {
            align: "justify",
            lineGap: 3,
          });
          doc.moveDown(1.5);
        });
      }

      // Tableau
      if (content.table && Array.isArray(content.table.rows) && content.table.rows.length) {
        if (doc.y > 650) doc.addPage();
        drawTable(doc, content.table, { x: 50, y: doc.y });
        doc.moveDown(1.5);
      }

      // Graphe
      if (content.graph?.imageBase64) {
        safeAddImage(doc, { caption: content.graph.caption || "Graphe", imageBase64: content.graph.imageBase64 }, { label: "graph", maxH: 280 });
      }

      // Photo
      if (content.photo?.imageBase64) {
        safeAddImage(doc, { caption: content.photo.caption || "Photo", imageBase64: content.photo.imageBase64 }, { label: "photo", maxH: 320 });
      }

      // Conclusion
      if (content.conclusion) {
        if (doc.y > 650) doc.addPage();
        doc.fontSize(16).font("Helvetica-Bold").fillColor("#1f2937").text("Conclusion");
        doc.moveDown(0.5);
        doc.fontSize(11).font("Helvetica").fillColor("#374151").text(content.conclusion, {
          align: "justify",
          lineGap: 3,
        });
      }

      // Pagination (avec garde-fou)
      const pages = doc.bufferedPageRange(); // { start, count }
      if (pages && typeof pages.count === "number" && pages.count > 0) {
        for (let i = 0; i < pages.count; i++) {
          doc.switchToPage(i);
          doc
            .fontSize(8)
            .fillColor("#9ca3af")
            .text(`Page ${i + 1} sur ${pages.count}`, 50, doc.page.height - 50, { align: "center" });
        }
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

async function sendEmailWithPdf({ to, subject, messageHtml, pdfBuffer, pdfFilename }) {
  return transporter.sendMail(
    {
      from: { name: EMAIL_FROM_NAME, address: EMAIL_FROM },
      to,
      subject,
      html: messageHtml,
      attachments: [{ filename: pdfFilename, content: pdfBuffer, contentType: "application/pdf" }],
    },
    { timeout: 15000 } // évite timeouts proxy
  );
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

    const rc = reportContent;
    if (!rc.title || !rc.introduction || !Array.isArray(rc.sections) || !rc.conclusion) {
      return res.status(400).json({ success: false, error: "Structure du rapport invalide" });
    }

    // Validations optionnelles
    if (rc.table) {
      if (!Array.isArray(rc.table.headers) || !Array.isArray(rc.table.rows)) {
        return res.status(400).json({ success: false, error: "Tableau invalide : headers/rows requis" });
      }
    }
    if (rc.graph?.imageBase64) {
      const gb = b64ToBufferMaybe(rc.graph.imageBase64);
      if (!looksLikePngOrJpeg(gb)) {
        return res.status(400).json({ success: false, error: "Graph invalide : imageBase64 doit être PNG ou JPEG valide" });
      }
    }
    if (rc.photo?.imageBase64) {
      const pb = b64ToBufferMaybe(rc.photo.imageBase64);
      if (!looksLikePngOrJpeg(pb)) {
        return res.status(400).json({ success: false, error: "Photo invalide : imageBase64 doit être PNG ou JPEG valide" });
      }
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
      details: { email, pdfSize: `${(pdfBuffer.length / 1024).toFixed(2)} KB` },
    });
  } catch (err) {
    console.error("❌ Erreur:", err);
    return res.status(500).json({
      success: false,
      error: "Erreur lors du traitement",
      details: err && err.message,
    });
  }
});

app.post("/api/echo", (req, res) => {
  return res.status(200).json({ ok: true, got: req.body || {} });
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
    version: "1.1.2",
    status: "running",
    endpoints: {
      health: "GET /health",
      echo: "POST /api/echo",
      generateAndSend: "POST /api/generate-and-send",
    },
  });
});

app.use((req, res) => res.status(404).json({ error: "Route non trouvée", path: req.path }));

app.use((err, _req, res, _next) => {
  console.error("Erreur:", err);
  res.status(500).json({ error: "Erreur serveur", message: err && err.message });
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
