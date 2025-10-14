const express = require('express');
const nodemailer = require('nodemailer');
const multer = require('multer');
const path = require('path');

const app = express();
const PORT = 3000;

/* ========================= CONFIG FIXE ========================= */
const SMTP_HOST = "avocarbon-com.mail.protection.outlook.com";
const SMTP_PORT = 25;
const EMAIL_FROM_NAME = "Administration STS";
const EMAIL_FROM = "administration.STS@avocarbon.com";

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Configuration Multer pour gérer l'upload de fichiers
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // Limite de 5MB
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    
    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('Seules les images sont autorisées (jpeg, jpg, png, gif)'));
    }
  }
});

// Configuration du transporteur SMTP
const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: false,
  tls: {
    rejectUnauthorized: false
  }
});

// Vérification de la connexion SMTP au démarrage
transporter.verify((error, success) => {
  if (error) {
    console.error('❌ Erreur de connexion SMTP:', error);
  } else {
    console.log('✅ Serveur SMTP prêt à envoyer des emails');
  }
});

/* ========================= ROUTES ========================= */

// Route de test
app.get('/', (req, res) => {
  res.json({ 
    message: 'API Email avec Photo - Opérationnelle',
    version: '1.0.0',
    endpoints: {
      sendEmailWithPhoto: 'POST /send-email-with-photo',
      sendEmailWithEmbeddedPhoto: 'POST /send-email-with-embedded-photo'
    }
  });
});

// Route pour envoyer un email avec photo en pièce jointe
app.post('/send-email-with-photo', upload.single('photo'), async (req, res) => {
  try {
    const { to, subject, text, html } = req.body;

    // Validation des champs requis
    if (!to || !subject) {
      return res.status(400).json({ 
        error: 'Les champs "to" et "subject" sont obligatoires' 
      });
    }

    if (!req.file) {
      return res.status(400).json({ 
        error: 'Aucune photo n\'a été uploadée' 
      });
    }

    // Configuration de l'email
    const mailOptions = {
      from: `"${EMAIL_FROM_NAME}" <${EMAIL_FROM}>`,
      to: to,
      subject: subject,
      text: text || 'Veuillez consulter la pièce jointe.',
      html: html || '<p>Veuillez consulter la pièce jointe.</p>',
      attachments: [
        {
          filename: req.file.originalname,
          content: req.file.buffer,
          contentType: req.file.mimetype
        }
      ]
    };

    // Envoi de l'email
    const info = await transporter.sendMail(mailOptions);

    res.status(200).json({
      success: true,
      message: 'Email envoyé avec succès',
      messageId: info.messageId,
      photo: req.file.originalname
    });

  } catch (error) {
    console.error('Erreur lors de l\'envoi de l\'email:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur lors de l\'envoi de l\'email',
      details: error.message
    });
  }
});

// Route pour envoyer un email avec photo intégrée dans le HTML
app.post('/send-email-with-embedded-photo', upload.single('photo'), async (req, res) => {
  try {
    const { to, subject, text } = req.body;

    if (!to || !subject) {
      return res.status(400).json({ 
        error: 'Les champs "to" et "subject" sont obligatoires' 
      });
    }

    if (!req.file) {
      return res.status(400).json({ 
        error: 'Aucune photo n\'a été uploadée' 
      });
    }

    // HTML avec image intégrée
    const htmlContent = `
      <div style="font-family: Arial, sans-serif;">
        <h2>${subject}</h2>
        <p>${text || 'Veuillez consulter l\'image ci-dessous.'}</p>
        <img src="cid:photo" alt="Photo" style="max-width: 100%; height: auto;" />
      </div>
    `;

    const mailOptions = {
      from: `"${EMAIL_FROM_NAME}" <${EMAIL_FROM}>`,
      to: to,
      subject: subject,
      text: text || 'Veuillez consulter la photo.',
      html: htmlContent,
      attachments: [
        {
          filename: req.file.originalname,
          content: req.file.buffer,
          contentType: req.file.mimetype,
          cid: 'photo' // Content-ID pour référencer l'image dans le HTML
        }
      ]
    };

    const info = await transporter.sendMail(mailOptions);

    res.status(200).json({
      success: true,
      message: 'Email avec photo intégrée envoyé avec succès',
      messageId: info.messageId,
      photo: req.file.originalname
    });

  } catch (error) {
    console.error('Erreur lors de l\'envoi de l\'email:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur lors de l\'envoi de l\'email',
      details: error.message
    });
  }
});

// Gestion des erreurs Multer
app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        error: 'Le fichier est trop volumineux (max 5MB)'
      });
    }
  }
  if (error) {
    return res.status(400).json({
      error: error.message
    });
  }
  next();
});

// Démarrage du serveur
app.listen(PORT, () => {
  console.log(`🚀 Serveur démarré sur http://localhost:${PORT}`);
});
