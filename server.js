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
app.use(express.json({ limit: '150mb' }));
app.use(express.urlencoded({ extended: true, limit: '150mb' }));
app.use('/images', express.static(imagesDir));

// Configuration Multer pour upload en mémoire
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 50 * 1024 * 1024 // 50MB max
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
    message: '✅ API Email avec Multer - Serveur actif',
    version: '7.0.0',
    method: 'Multipart/Form-Data avec Multer',
    endpoints: [
      'GET  / - Vérifier l\'état',
      'POST /send-email-file - Envoyer email avec fichier',
      'POST /send-email-base64 - Envoyer email avec base64 (legacy)',
      'GET  /images-list - Lister les images'
    ],
    status: 'Running'
  });
});

// ========================= ROUTE: Envoyer email avec FICHIER (MULTER) =========================
app.post('/send-email-file', upload.single('image'), async (req, res) => {
  try {
    const { to, subject, message } = req.body;
    const file = req.file;

    console.log('========================================');
    console.log('📧 NOUVELLE REQUÊTE: /send-email-file');
    console.log('========================================');
    console.log('Destinataire:', to);
    console.log('Sujet:', subject);
    console.log('Message:', message);
    if (file) {
      console.log('Fichier reçu:', file.originalname);
      console.log('Taille:', file.size, 'octets');
      console.log('Type MIME:', file.mimetype);
      console.log('Buffer length:', file.buffer.length);
    }
    console.log('========================================');

    // ========== VALIDATION ==========
    if (!to) {
      console.error('❌ Erreur: to manquant');
      return res.status(400).json({
        success: false,
        error: 'Le champ "to" (email) est requis'
      });
    }

    if (!subject) {
      console.error('❌ Erreur: subject manquant');
      return res.status(400).json({
        success: false,
        error: 'Le champ "subject" est requis'
      });
    }

    if (!message) {
      console.error('❌ Erreur: message manquant');
      return res.status(400).json({
        success: false,
        error: 'Le champ "message" est requis'
      });
    }

    if (!file) {
      console.error('❌ Erreur: fichier image manquant');
      return res.status(400).json({
        success: false,
        error: 'Le fichier image est requis'
      });
    }

    // ========== TRAITEMENT DU FICHIER ==========
    console.log('1️⃣ Traitement du fichier...');
    
    const imageBuffer = file.buffer;
    const originalName = file.originalname;
    
    // Vérifier que le fichier n'est pas vide
    if (imageBuffer.length === 0) {
      throw new Error('L\'image reçue est vide (0 octets)');
    }

    // Générer un nom de fichier unique
    console.log('2️⃣ Génération du nom de fichier...');
    const timestamp = Date.now();
    const randomNum = Math.round(Math.random() * 1E9);
    const extension = path.extname(originalName);
    const filename = `image_${timestamp}_${randomNum}${extension}`;
    const filepath = path.join(imagesDir, filename);
    console.log(`   ✅ Nom généré: ${filename}`);

    // Sauvegarder l'image sur le serveur
    console.log('3️⃣ Sauvegarde de l\'image...');
    fs.writeFileSync(filepath, imageBuffer);
    console.log(`   ✅ Image sauvegardée: ${filepath}`);
    console.log(`   📊 Taille: ${imageBuffer.length} octets (${(imageBuffer.length / 1024).toFixed(2)} KB)`);

    // Préparer le contenu HTML de l'email
    console.log('4️⃣ Préparation du template email...');
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
                📎 <strong>Image jointe:</strong> ${filename}<br>
                📊 <strong>Taille:</strong> ${(imageBuffer.length / 1024).toFixed(2)} KB<br>
                📁 <strong>Type:</strong> ${file.mimetype}
              </p>
            </div>

            <!-- Footer -->
            <div style="border-top: 2px solid #eee; padding-top: 15px; margin-top: 30px; text-align: center; background-color: white; padding: 15px; border-radius: 8px;">
              <p style="font-size: 12px; color: #999; margin: 0;">
                📧 Email envoyé via API Administration STS<br>
                ⏰ ${new Date().toLocaleString('fr-FR')}<br>
                🚀 Méthode: Multipart/Form-Data
              </p>
            </div>
            
          </div>
        </body>
      </html>
    `;
    console.log('   ✅ Template prêt');

    // Préparer l'email avec pièce jointe
    console.log('5️⃣ Préparation de l\'email...');
    const mailOptions = {
      from: `"${EMAIL_FROM_NAME}" <${EMAIL_FROM}>`,
      to: to,
      subject: subject,
      html: htmlContent,
      attachments: [
        {
          filename: filename,
          content: imageBuffer,
          contentType: file.mimetype
        }
      ]
    };
    console.log('   ✅ Email préparé');

    // Envoyer l'email
    console.log('6️⃣ Envoi de l\'email via SMTP...');
    const info = await transporter.sendMail(mailOptions);
    console.log(`   ✅ Email envoyé!`);
    console.log(`   📧 Message ID: ${info.messageId}`);

    // Réponse succès
    console.log('========================================');
    console.log('✅ SUCCÈS TOTAL!');
    console.log('========================================');
    
    res.json({
      success: true,
      message: 'Email envoyé avec succès',
      data: {
        messageId: info.messageId,
        recipient: to,
        image: {
          filename: filename,
          originalName: originalName,
          size: imageBuffer.length,
          sizeKB: (imageBuffer.length / 1024).toFixed(2),
          sizeMB: (imageBuffer.length / (1024 * 1024)).toFixed(2),
          type: file.mimetype,
          path: `/images/${filename}`
        },
        timestamp: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('========================================');
    console.error('❌ ERREUR LORS DE L\'ENVOI');
    console.error('========================================');
    console.error('Détails:', error.message);
    console.error('Stack:', error.stack);
    console.error('========================================');
    
    res.status(500).json({
      success: false,
      error: 'Erreur lors de l\'envoi de l\'email',
      details: error.message
    });
  }
});

// ========================= ROUTE: Envoyer email avec BASE64 (LEGACY) =========================
app.post('/send-email-base64', async (req, res) => {
  try {
    const { to, subject, message, image, imageName } = req.body;

    console.log('========================================');
    console.log('📧 REQUÊTE LEGACY: /send-email-base64');
    console.log('========================================');

    // Validation
    if (!to || !subject || !message || !image || !imageName) {
      return res.status(400).json({
        success: false,
        error: 'Tous les champs sont requis (to, subject, message, image, imageName)'
      });
    }

    // Nettoyer le base64
    let cleanBase64 = image;
    if (image.includes(',')) {
      cleanBase64 = image.split(',')[1];
    }
    
    // Décoder
    const imageBuffer = Buffer.from(cleanBase64, 'base64');
    
    if (imageBuffer.length === 0) {
      throw new Error('L\'image décodée est vide');
    }

    // Générer nom de fichier
    const timestamp = Date.now();
    const randomNum = Math.round(Math.random() * 1E9);
    const extension = path.extname(imageName);
    const filename = `image_${timestamp}_${randomNum}${extension}`;
    const filepath = path.join(imagesDir, filename);

    // Sauvegarder
    fs.writeFileSync(filepath, imageBuffer);

    // Type MIME
    const ext = extension.toLowerCase();
    const mimeTypes = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp'
    };
    const mimeType = mimeTypes[ext] || 'image/jpeg';

    // Email
    const mailOptions = {
      from: `"${EMAIL_FROM_NAME}" <${EMAIL_FROM}>`,
      to: to,
      subject: subject,
      html: `<p>${message}</p><p>📎 Image jointe: ${filename}</p>`,
      attachments: [{
        filename: filename,
        content: imageBuffer,
        contentType: mimeType
      }]
    };

    const info = await transporter.sendMail(mailOptions);

    res.json({
      success: true,
      message: 'Email envoyé avec succès (méthode legacy)',
      data: {
        messageId: info.messageId,
        image: {
          filename: filename,
          size: imageBuffer.length
        }
      }
    });

  } catch (error) {
    console.error('❌ Erreur base64:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
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
        sizeMB: (stats.size / (1024 * 1024)).toFixed(2),
        created: stats.birthtime,
        url: `/images/${file}`
      };
    });

    const totalSize = imageDetails.reduce((sum, img) => sum + img.size, 0);

    res.json({
      success: true,
      count: images.length,
      totalSize: totalSize,
      totalSizeKB: (totalSize / 1024).toFixed(2),
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
  console.error('🚨 Erreur middleware:', error.message);
  
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
    error: error.message || 'Erreur serveur'
  });
});

// ========================= DÉMARRER LE SERVEUR =========================
app.listen(PORT, () => {
  console.log('========================================');
  console.log('🚀 SERVEUR DÉMARRÉ AVEC SUCCÈS!');
  console.log('========================================');
  console.log(`📍 Port: ${PORT}`);
  console.log(`📧 SMTP: ${SMTP_HOST}:${SMTP_PORT}`);
  console.log(`📁 Dossier images: ${imagesDir}`);
  console.log(`✉️  Email FROM: ${EMAIL_FROM}`);
  console.log('');
  console.log('🔗 ENDPOINTS:');
  console.log('   1. GET  / - Vérifier l\'état');
  console.log('   2. POST /send-email-file - Envoyer email (MULTER) 🆕');
  console.log('   3. POST /send-email-base64 - Envoyer email (LEGACY)');
  console.log('   4. GET  /images-list - Lister les images');
  console.log('');
  console.log('📝 MÉTHODES:');
  console.log('   🆕 /send-email-file → multipart/form-data + Multer');
  console.log('   📜 /send-email-base64 → application/json + base64');
  console.log('');
  console.log('🖼️ UPLOAD:');
  console.log('   - Fichier binaire direct (pas de base64)');
  console.log('   - Limite: 50MB par fichier');
  console.log('   - Formats: JPG, PNG, GIF, WEBP, BMP');
  console.log('========================================');
});
