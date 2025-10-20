const express = require('express');
const nodemailer = require('nodemailer');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

/* ========================= CONFIGURATION ========================= */
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

// ========================= MIDDLEWARE =========================
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb', parameterLimit: 100000 }));
app.use('/images', express.static(imagesDir));

// ========================= MULTER CONFIGURATION =========================
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB max
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|webp|bmp/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    
    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('Seules les images (JPG, PNG, GIF, WebP, BMP) sont autorisées'));
    }
  }
});

// ========================= SMTP CONFIGURATION =========================
const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: false,
  tls: {
    rejectUnauthorized: false
  }
});

// ========================= ROUTES =========================

// Route: Vérifier l'état du serveur
app.get('/', (req, res) => {
  res.json({
    message: '✅ API Email avec Image - Serveur actif',
    version: '5.0.0',
    method: 'Multipart Upload (Direct File)',
    endpoint: 'POST /send-email',
    parameters: {
      to: 'majed.messai@avocarbon.com (FIXE)',
      subject: 'mejed (FIXE)',
      message: 'mejed123 (FIXE)',
      image: 'fichier image uploadé (VARIABLE)'
    },
    status: 'Running'
  });
});

// ========================= FONCTION: Sauvegarder et envoyer email =========================
async function saveAndSendEmail(imageBuffer, imageName, to, subject, message) {
  try {
    // 1. Générer un nom de fichier unique
    const timestamp = Date.now();
    const randomNum = Math.round(Math.random() * 1E9);
    const extension = path.extname(imageName);
    const filename = `image_${timestamp}_${randomNum}${extension}`;
    const filepath = path.join(imagesDir, filename);

    // 2. Sauvegarder l'image sur le serveur
    fs.writeFileSync(filepath, imageBuffer);
    console.log(`💾 Image sauvegardée: ${filename} (${imageBuffer.length} octets)`);

    // 3. Déterminer le type MIME
    const ext = extension.toLowerCase();
    const mimeTypes = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.bmp': 'image/bmp'
    };
    const mimeType = mimeTypes[ext] || 'image/jpeg';

    // 4. Préparer le contenu HTML de l'email
    const htmlContent = `
      <html>
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
        </head>
        <body style="font-family: Arial, sans-serif; margin: 0; padding: 0; background-color: #f9f9f9;">
          <div style="padding: 20px; max-width: 600px; margin: 0 auto;">
            
            <!-- Header avec titre -->
            <div style="border-bottom: 3px solid #007bff; padding: 15px; margin-bottom: 20px; background-color: white; border-radius: 8px;">
              <h2 style="color: #333; margin: 0; font-size: 24px;">${subject}</h2>
            </div>
            
            <!-- Message principal -->
            <div style="background-color: white; padding: 20px; border-radius: 8px; margin-bottom: 20px;">
              <p style="font-size: 15px; line-height: 1.8; color: #555; margin: 0;">
                ${message}
              </p>
            </div>

            <!-- Information sur la pièce jointe -->
            <div style="background-color: white; padding: 20px; border-radius: 8px; margin-bottom: 20px; border: 1px solid #ddd;">
              <p style="font-size: 14px; color: #666; margin: 0;">
                📎 <strong>Image jointe:</strong> ${filename}
              </p>
            </div>

            <!-- Footer -->
            <div style="border-top: 2px solid #eee; padding-top: 15px; margin-top: 30px; text-align: center; background-color: white; padding: 15px; border-radius: 8px;">
              <p style="font-size: 12px; color: #999; margin: 0;">
                📧 Email envoyé via API Administration STS<br>
                ⏰ ${new Date().toLocaleString('fr-FR')}
              </p>
            </div>
            
          </div>
        </body>
      </html>
    `;

    // 5. Préparer l'email avec pièce jointe
    const mailOptions = {
      from: `"${EMAIL_FROM_NAME}" <${EMAIL_FROM}>`,
      to: to,
      subject: subject,
      html: htmlContent,
      attachments: [
        {
          filename: filename,
          content: imageBuffer,
          contentType: mimeType
        }
      ]
    };

    // 6. Envoyer l'email
    console.log('📤 Envoi de l\'email...');
    const info = await transporter.sendMail(mailOptions);

    console.log('✅ Email envoyé avec succès!');
    console.log('Message ID:', info.messageId);

    return {
      success: true,
      messageId: info.messageId,
      image: {
        filename: filename,
        size: imageBuffer.length,
        type: mimeType,
        path: `/images/${filename}`
      },
      recipient: to,
      timestamp: new Date().toISOString()
    };

  } catch (error) {
    console.error('❌ Erreur:', error);
    throw error;
  }
}

// ========================= ROUTE: Envoyer email avec image =========================
app.post('/send-email', upload.single('image'), async (req, res) => {
  try {
    const { to, subject, message } = req.body;

    console.log('========================================');
    console.log('📧 Nouvelle requête: /send-email');
    console.log('Destinataire:', to);
    console.log('Sujet:', subject);
    console.log('Message:', message);
    console.log('Fichier reçu:', req.file ? req.file.originalname : 'AUCUN');
    console.log('Taille fichier:', req.file ? req.file.size : 0, 'bytes');
    console.log('========================================');

    // ========== VALIDATION ==========
    if (!to) {
      return res.status(400).json({
        success: false,
        error: 'Le champ "to" (email) est requis'
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
        error: 'Aucun fichier image n\'a été uploadé. Utilisez le champ "image" en multipart/form-data'
      });
    }

    // ========== TRAITER L'IMAGE ==========
    const result = await saveAndSendEmail(
      req.file.buffer,
      req.file.originalname,
      to,
      subject,
      message
    );

    // ========== RÉPONSE SUCCÈS ==========
    res.json({
      success: true,
      message: 'Email envoyé avec succès',
      data: result
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

// ========================= ROUTE: Lister les images =========================
app.get('/images-list', (req, res) => {
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
      error: 'Erreur lors de la lecture des images',
      details: error.message
    });
  }
});

// ========================= GESTION DES ERREURS =========================
app.use((error, req, res, next) => {
  console.error('🚨 Erreur:', error.message);
  
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        success: false,
        error: 'Fichier trop volumineux (max 100MB)'
      });
    }
  }
  
  res.status(500).json({
    success: false,
    error: error.message || 'Erreur serveur'
  });
});

// ========================= DÉMARRER LE SERVEUR =========================
app.listen(PORT, () => {
  console.log('========================================');
  console.log('🚀 Serveur démarré avec succès!');
  console.log(`📍 Port: ${PORT}`);
  console.log(`📧 SMTP: ${SMTP_HOST}:${SMTP_PORT}`);
  console.log(`📁 Dossier images: ${imagesDir}`);
  console.log(`✉️  Email FROM: ${EMAIL_FROM}`);
  console.log('🔗 Endpoint: POST /send-email');
  console.log('📝 Format: multipart/form-data');
  console.log('🖼️ Image: Pièce jointe avec aperçu dans Outlook');
  console.log('========================================');
});
