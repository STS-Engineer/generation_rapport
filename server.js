"use strict";

/**
 * =========================
 *  GPT PDF Email API (M365)
 * =========================
 * ENV requis :
 *  - O365_SMTP_USER="administration.STS@avocarbon.com"
 *  - O365_SMTP_PASS="shnlgdyfbcztbhxn"
 * Optionnels :
 *  - EMAIL_FROM="administration.STS@avocarbon.com"
 *  - EMAIL_FROM_NAME="Administration STS"
 *  - PORT=3000
 */

// require("dotenv").config(); // décommente si tu utilises un .env

const express = require("express");
const PDFDocument = require("pdfkit");
const nodemailer = require("nodemailer");
const cors = require("cors");
const crypto = require("crypto");
const net = require("net");
const dns = require("dns").promises;

const app = express();

/* ========================= CONFIG ========================= */
const SMTP_HOST = "smtp.office365.com";
const SMTP_PORT = 587;

const EMAIL_FROM_NAME = process.env.EMAIL_FROM_NAME || "Administration STS";
const EMAIL_FROM = process.env.EMAIL_FROM || "administration.STS@avocarbon.com";

const O365_SMTP_USER = process.env.O365_SMTP_USER || "administration.STS@avocarbon.com";
const O365_SMTP_PASS = process.env.O365_SMTP_PASS || "shnlgdyfbcztbhxn";

/* ====== Hard-stop si identifiants manquants (évite erreurs confuses) ====== */
if (!O365_SMTP_USER || !O365_SMTP_PASS) {
  console.error("❌ SMTP creds manquants : O365_SMTP_USER ou O365_SMTP_PASS est vide.");
  console.error("   -> Défini les variables d'environnement puis redémarre le service.");
  process.exit(1);
}

/* ========================= MIDDLEWARES ========================= */
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

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
      "x-correlation-id",
    ],
  })
);
app.options("*", cors());

app.use((req, _res, next) => {
  const cid = req.headers["x-correlation-id"] || crypto.randomUUID();
  req.correlationId = cid;
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  console.log(
    `${new Date().toISOString()} [CID:${cid}] ${req.method} ${req.path} ip=${ip} ua="${req.headers["user-agent"] || ""}"`
  );
  next();
});

/* ====================== TRANSPORTEUR SMTP ====================== */
const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: false,     // STARTTLS sur 587
  requireTLS: true,
  auth: { user: O365_SMTP_USER, pass: O365_SMTP_PASS },
  tls: { minVersion: "TLSv1.2" },
  connectionTimeout: 20_000,
  greetingTimeout: 20_000,
  socketTimeout: 30_000,
  pool: true,
  logger: true,      // logs Nodemailer
  debug: true,       // traces protocole SMTP
});

console.log(
  `SMTP creds chargés -> user=${O365_SMTP_USER.replace(/.(?=.{3})/g, "*")} passLen=${O365_SMTP_PASS.length}`
);

(async () => {
  try {
    await transporter.verify();
    console.log("✅ SMTP Office 365 prêt (verify OK)");
  } catch (err) {
    console.error("❌ SMTP verify() a échoué :", formatSmtpError(err));
  }
})();

/* ============================ UTILS ============================ */
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
function sanitizeFileName(name) {
  return String(name || "rapport").replace(/[^a-z0-9_\-\.]/gi, "_").toLowerCase();
}
function escapeHtml(str = "") {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
function formatSmtpError(err) {
  return {
    name: err.name,
    message: err.message,
    code: err.code,
    command: err.command,
    response: err.response,
    responseCode: err.responseCode,
  };
}

/* ===================== PDF GENERATION (corrigé) ===================== */
function generatePDF(content) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        margin: 50,
        size: "A4",
        bufferPages: true, // ✅ indispensable pour switchToPage
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

      // ======= Contenu =======
      // Titre
      doc.fontSize(26).font("Helvetica-Bold").fillColor("#1e40af")
         .text(content.title || "Rapport", { align: "center" });
      doc.moveDown(0.5);

      // Ligne
      doc.strokeColor("#3b82f6").lineWidth(2)
         .moveTo(50, doc.y).lineTo(doc.page.width - 50, doc.y).stroke();
      doc.moveDown();

      // Date
      doc.fontSize(10).fillColor("#6b7280").font("Helvetica")
         .text(`Date: ${new Date().toLocaleDateString("fr-FR", {
            year: "numeric", month: "long", day: "numeric"
         })}`, { align: "right" });
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
          doc.fontSize(14).font("Helvetica-Bold").fillColor("#1e40af")
             .text(`${index + 1}. ${section.title || "Section"}`);
          doc.moveDown(0.5);
          doc.fontSize(11).font("Helvetica").fillColor("#374151")
             .text(section.content || "", { align: "justify", lineGap: 3 });
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

      // ======= Pagination (AVANT doc.end) =======
      try {
        console.log("[PDF] Pagination: start");
        const range = doc.bufferedPageRange(); // { start, count }
        console.log("[PDF] bufferedPageRange =", range);
        for (let i = range.start; i < range.start + range.count; i++) {
          doc.switchToPage(i); // ✅ possible car bufferPages:true
          doc.fontSize(8).fillColor("#9ca3af").text(
            `Page ${i - range.start + 1} sur ${range.count}`,
            50,
            doc.page.height - 50,
            { align: "center", width: doc.page.width - 100 }
          );
        }
        console.log("[PDF] Pagination: done");
      } catch (e) {
        console.error("⚠️ Pagination error (non bloquant):", e.message);
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

/* ====================== ENVOI EMAIL ====================== */
async function sendEmailWithPdf({ to, subject, messageHtml, pdfBuffer, pdfFilename, cid }) {
  console.log(`[CID:${cid}] Envoi e-mail via ${SMTP_HOST}:${SMTP_PORT} en tant que ${O365_SMTP_USER.replace(/.(?=.{3})/g, "*")}`);
  return transporter.sendMail({
    from: { name: EMAIL_FROM_NAME, address: EMAIL_FROM },
    to,
    subject,
    html: messageHtml,
    attachments: [{ filename: pdfFilename, content: pdfBuffer, contentType: "application/pdf" }],
  });
}

/* ================ ENDPOINTS DIAGNOSTIC ================ */
// Vérification config (sans exposer secrets)
app.get("/config-check", (_req, res) => {
  res.json({
    smtpHost: SMTP_HOST,
    smtpPort: SMTP_PORT,
    hasUser: !!O365_SMTP_USER,
    hasPass: !!O365_SMTP_PASS,
    userMasked: O365_SMTP_USER ? O365_SMTP_USER.replace(/.(?=.{3})/g, "*") : null,
    passLen: O365_SMTP_PASS ? O365_SMTP_PASS.length : 0,
  });
});

/**
 * GET /diag
 * Diagnostique : DNS, TCP 587, verify Nodemailer
 */
app.get("/diag", async (req, res) => {
  const cid = req.correlationId || crypto.randomUUID();
  const out = { correlationId: cid, host: SMTP_HOST, port: SMTP_PORT, steps: [] };

  try {
    const a = await dns.lookup(SMTP_HOST, { all: true });
    out.steps.push({ step: "dns.lookup", ok: true, addresses: a });
  } catch (e) {
    out.steps.push({ step: "dns.lookup", ok: false, error: e.message });
  }

  const tcpResult = await new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    socket.setTimeout(6000);
    socket.connect(SMTP_PORT, SMTP_HOST, () => {
      done = true; socket.destroy(); resolve({ ok: true });
    });
    socket.on("error", (err) => {
      if (done) return; done = true; resolve({ ok: false, error: err.message, code: err.code });
    });
    socket.on("timeout", () => {
      if (done) return; done = true; socket.destroy(); resolve({ ok: false, error: "timeout" });
    });
  });
  out.steps.push({ step: "tcp-connect", ...tcpResult });

  try {
    await transporter.verify();
    out.steps.push({ step: "transporter.verify", ok: true });
  } catch (e) {
    out.steps.push({ step: "transporter.verify", ok: false, error: formatSmtpError(e) });
  }

  return res.json(out);
});

/* ============================ ROUTES ============================ */
/**
 * POST /api/generate-and-send
 */
app.post("/api/generate-and-send", async (req, res) => {
  const cid = req.correlationId || crypto.randomUUID();
  try {
    const { email, subject, reportContent } = req.body || {};

    if (!email || !subject || !reportContent) {
      console.warn(`[CID:${cid}] 400 - Données manquantes`);
      return res.status(400).json({
        success: false, correlationId: cid,
        error: "Données manquantes",
        details: "Envoyez email, subject, reportContent",
      });
    }
    if (!isValidEmail(email)) {
      console.warn(`[CID:${cid}] 400 - Email invalide : ${email}`);
      return res.status(400).json({ success: false, correlationId: cid, error: "Email invalide" });
    }
    if (!reportContent.title || !reportContent.introduction || !Array.isArray(reportContent.sections) || !reportContent.conclusion) {
      console.warn(`[CID:${cid}] 400 - Structure du rapport invalide`);
      return res.status(400).json({
        success: false, correlationId: cid,
        error: "Structure du rapport invalide",
        details: "reportContent doit contenir title, introduction, sections (array {title, content}), conclusion",
      });
    }

    // Génération PDF
    const pdfBuffer = await generatePDF(reportContent);
    const pdfName = `rapport_${sanitizeFileName(reportContent.title)}_${Date.now()}.pdf`;
    console.log(`[CID:${cid}] PDF généré (${(pdfBuffer.length / 1024).toFixed(2)} KB) -> ${pdfName}`);

    // Email HTML
    const html = `<!DOCTYPE html>
<html><body style="font-family: Arial, sans-serif; line-height:1.6; color:#111827;">
  <h2 style="margin:0 0 8px 0;">📄 Votre rapport est prêt</h2>
  <div style="background:#e0e7ff;padding:12px;border-left:4px solid #667eea;border-radius:6px;margin:12px 0;">
    <strong>📌 Titre :</strong> ${escapeHtml(reportContent.title)}<br>
    <strong>📅 Date :</strong> ${new Date().toLocaleDateString("fr-FR")}
  </div>
  <p>Vous trouverez le rapport complet en pièce jointe au format PDF.</p>
  <p style="color:#6b7280;font-size:12px">© ${new Date().getFullYear()} ${escapeHtml(EMAIL_FROM_NAME)}</p>
</body></html>`;

    // Envoi
    try {
      await sendEmailWithPdf({
        to: email,
        subject,
        messageHtml: html,
        pdfBuffer,
        pdfFilename: pdfName,
        cid,
      });
      console.log(`[CID:${cid}] ✅ E-mail envoyé à ${email} (sujet="${subject}")`);
    } catch (err) {
      const info = formatSmtpError(err);
      console.error(`[CID:${cid}] ❌ SMTP error`, info);
      return res.status(502).json({
        success: false,
        correlationId: cid,
        error: "Erreur SMTP lors de l'envoi",
        details: info,
      });
    }

    return res.json({
      success: true,
      correlationId: cid,
      message: "Rapport généré et envoyé avec succès",
      details: {
        email,
        pdfSizeKB: Number((pdfBuffer.length / 1024).toFixed(2)),
        fileName: pdfName,
      },
    });
  } catch (err) {
    console.error(`[CID:${cid}] ❌ Erreur générale:`, err);
    return res.status(500).json({
      success: false,
      correlationId: cid,
      error: "Erreur lors du traitement",
      details: err.message,
    });
  }
});

/**
 * POST /api/generate  -> Génère et renvoie le PDF sans email
 */
app.post("/api/generate", async (req, res) => {
  const cid = req.correlationId || crypto.randomUUID();
  try {
    const { reportContent } = req.body || {};
    if (!reportContent || !reportContent.title || !reportContent.introduction || !Array.isArray(reportContent.sections) || !reportContent.conclusion) {
      console.warn(`[CID:${cid}] 400 - Structure du rapport invalide (generate)`);
      return res.status(400).json({
        success: false, correlationId: cid,
        error: "Structure du rapport invalide",
        details: "reportContent doit contenir title, introduction, sections (array {title, content}), conclusion",
      });
    }

    const pdfBuffer = await generatePDF(reportContent);
    const pdfName = `rapport_${sanitizeFileName(reportContent.title)}_${Date.now()}.pdf`;

    console.log(`[CID:${cid}] PDF généré pour téléchargement direct -> ${pdfName}`);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${pdfName}"`);
    return res.send(pdfBuffer);
  } catch (err) {
    console.error(`[CID:${cid}] ❌ Erreur /api/generate:`, err);
    return res.status(500).json({ success: false, correlationId: cid, error: "Erreur serveur", details: err.message });
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
    version: "1.3.0",
    status: "running",
    smtpHost: SMTP_HOST,
    smtpPort: SMTP_PORT,
    endpoints: {
      health: "GET /health",
      configCheck: "GET /config-check",
      diag: "GET /diag",
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

// Erreurs non catchées
process.on("unhandledRejection", (r) => console.error("Unhandled Rejection:", r));
process.on("uncaughtException", (e) => {
  console.error("Uncaught Exception:", e);
});
