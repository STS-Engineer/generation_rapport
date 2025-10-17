const express = require('express');
const nodemailer = require('nodemailer');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

/* ========================= CONFIG FIXE ========================= */
const SMTP_HOST = "avocarbon-com.mail.protection.outlook.com";
const SMTP_PORT = 25;
const EMAIL_FROM_NAME = "Administration STS";
const EMAIL_FROM = "administration.STS@avocarbon.com";

// Créer le dossier images s'il n'existe pas
const imagesDir = path.join(__dirname, 'images');
if (!fs.existsSync(imagesDir)) {
  fs.mkdirSync(imagesDir, { recursive: true });
  console.log('✅ Dossier images créé');
}

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Configuration Multer pour upload en mémoire
const storage = multer.memoryStorage();

const upload = multer({
  storage: storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|webp|bmp/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    
    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('Seules les images sont autorisées'));
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

// Route de test
app.get('/', (req, res) => {
  res.json({
    message: '✅ API Email avec Image - Serveur actif',
    version: '3.0.0',
    method: 'Upload fichier depuis GPT',
    endpoints: {
      sendEmail: 'POST /send-email (GPT upload image directement)',
      listImages: 'GET /images'
    },
    status: 'Running'
  });
});

// ========== ROUTE PRINCIPALE: GPT UPLOAD L'IMAGE ==========
app.post('/send-email', upload.single('image'), async (req, res) => {
  try {
    const { to, subject, message } = req.body;

    console.log('========================================');
    console.log('📧 Nouvelle requête send-email');
    console.log('Destinataire:', to);
    console.log('Sujet:', subject);
    console.log('Fichier reçu:', req.file ? req.file.originalname : 'Aucun');
    console.log('========================================');

    // Validation des champs requis
    if (!to) {
      return res.status(400).json({
        success: false,
        error: 'Le champ "to" est requis'
      });
    }

    if (!subject) {
      return res.status(400).json({
        success: false,
        error: 'Le champ "subject" est requis'
      });
    }

    if (!message) {
      return res.status(400).json({
        success: false,
        error: 'Le champ "message" est requis'
      });
    }

    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'Aucun fichier image n\'a été uploadé'
      });
    }

    // Générer un nom de fichier unique
    const timestamp = Date.now();
    const randomNum = Math.round(Math.random() * 1E9);
    const extension = path.extname(req.file.originalname);
    const filename = `image_${timestamp}_${randomNum}${extension}`;
    const filepath = path.join(imagesDir, filename);

    // Sauvegarder l'image sur le serveur Azure
    fs.writeFileSync(filepath, req.file.buffer);
    
    const imageSize = req.file.size;
    console.log(`💾 Image sauvegardée: ${filename} (${imageSize} octets)`);

    // Déterminer le type MIME
    const ext = extension.toLowerCase();
    const mimeTypes = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.bmp': 'image/bmp'
    };
    const mimeType = mimeTypes[ext] || req.file.mimetype || 'image/png';

    // Configuration de l'email
    const mailOptions = {
      from: `"${EMAIL_FROM_NAME}" <${EMAIL_FROM}>`,
      to: to,
      subject: subject,
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px; max-width: 600px; margin: 0 auto;">
          <div style="border-bottom: 3px solid #007bff; padding-bottom: 15px; margin-bottom: 20px;">
            <h2 style="color: #333; margin: 0;">${subject}</h2>
          </div>
          <p style="font-size: 15px; line-height: 1.8; color: #555; margin-bottom: 25px;">
            ${message}
          </p>
          <div style="text-align: center; margin: 30px 0;">
            <p style="font-weight: bold; margin-bottom: 15px; color: #333; font-size: 14px;">
              📎 Image jointe ci-dessous:
            </p>
            <div style="display: inline-block; border: 3px solid #007bff; border-radius: 10px; overflow: hidden; box-shadow: 0 4px 8px rgba(0,0,0,0.15);">
              <img src="cid:imageContent@email" alt="Image" style="max-width: 100%; height: auto; display: block;">
            </div>
          </div>
          <div style="border-top: 2px solid #eee; padding-top: 20px; margin-top: 30px; text-align: center;">
            <p style="font-size: 12px; color: #999; margin: 0;">
              📧 Email envoyé via API Administration STS
            </p>
          </div>
        </div>
      `,
      attachments: [
        {
          filename: filename,
          content: req.file.buffer,
          contentType: mimeType,
          cid: 'imageContent@email',
          contentDisposition: 'inline'
        }
      ]
    };

    // Envoyer l'email
    console.log('📤 Envoi de l\'email...');
    const info = await transporter.sendMail(mailOptions);

    console.log('✅ Email envoyé avec succès!');
    console.log('Message ID:', info.messageId);
    console.log('========================================');

    res.json({
      success: true,
      message: 'Email envoyé avec succès',
      data: {
        messageId: info.messageId,
        image: {
          filename: filename,
          size: imageSize,
          type: mimeType,
          path: `/images/${filename}`
        },
        recipient: to,
        timestamp: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('❌ Erreur lors de l\'envoi:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur lors de l\'envoi de l\'email',
      details: error.message
    });
  }
});

// ========== ROUTE: Lister les images ==========
app.get('/images', (req, res) => {
  try {
    const files = fs.readdirSync(imagesDir);
    const images = files.filter(file => {
      const ext = path.extname(file).toLowerCase();
      return ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'].includes(ext);
    });

    const imageDetails = images.map(file => {
      const filepath = path.join(imagesDir, file);
      const stats = fs.statSync(filepath);
      return {
        name: file,
        size: stats.size,
        sizeKB: (stats.size / 1024).toFixed(2),
        created: stats.birthtime
      };
    });

    const totalSize = imageDetails.reduce((sum, img) => sum + img.size, 0);

    res.json({
      success: true,
      count: images.length,
      totalSize: totalSize,
      totalSizeMB: (totalSize / (1024 * 1024)).toFixed(2),
      images: imageDetails
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Erreur lors de la lecture du dossier images',
      details: error.message
    });
  }
});

// Gestion des erreurs globales
app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        success: false,
        error: 'Fichier trop volumineux (max 50MB)'
      });
    }
  }
  res.status(500).json({
    success: false,
    error: error.message
  });
});

// Démarrer le serveur
app.listen(PORT, () => {
  console.log('========================================');
  console.log('🚀 Serveur démarré avec succès!');
  console.log(`📍 Port: ${PORT}`);
  console.log(`📧 SMTP: ${SMTP_HOST}:${SMTP_PORT}`);
  console.log(`📁 Dossier images: ${imagesDir}`);
  console.log(`✉️  Email FROM: ${EMAIL_FROM}`);
  console.log(`📤 Méthode: Upload fichier direct`);
  console.log('========================================');
});
