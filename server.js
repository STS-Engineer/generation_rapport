const express = require('express');
const nodemailer = require('nodemailer');
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

// Middleware - Augmenter les limites pour base64
app.use(express.json({ 
  limit: '100mb',
  strict: false,
  type: ['application/json', 'text/plain']
}));
app.use(express.urlencoded({ 
  extended: true, 
  limit: '100mb',
  parameterLimit: 100000
}));
app.use('/images', express.static(imagesDir));

// Middleware personnalisé pour logs de taille
app.use((req, res, next) => {
  if (req.method === 'POST' && req.path === '/send-email') {
    const contentLength = req.headers['content-length'];
    console.log(`📥 Requête reçue: ${contentLength} bytes`);
  }
  next();
});

// Configuration du transporteur SMTP
const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: false,
  auth: false,
  tls: {
    rejectUnauthorized: false,
    minVersion: 'TLSv1.2'
  },
  connectionTimeout: 5000,
  socketTimeout: 5000,
  logger: true,
  debug: true
});

// Route de test
app.get('/', (req, res) => {
  res.json({
    message: '✅ API Email avec Image Base64 - Serveur actif',
    version: '4.0.0',
    method: 'Base64 Encoding/Decoding',
    endpoint: 'POST /send-email',
    parameters: {
      to: 'email du destinataire (string)',
      subject: 'sujet de l\'email (string)',
      message: 'contenu du message (string)',
      image: 'image en base64 (string)',
      imageName: 'nom du fichier avec extension ex: photo.jpg (string)'
    },
    status: 'Running'
  });
});

// ========== ROUTE UNIQUE: Envoyer email avec image Base64 ==========
app.post('/send-email', async (req, res) => {
  try {
    const { to, subject, message, image, imageName } = req.body;

    console.log('========================================');
    console.log('📧 Nouvelle requête: /send-email');
    console.log('Destinataire:', to);
    console.log('Sujet:', subject);
    console.log('Message:', message);
    console.log('ImageName:', imageName);
    console.log('Base64 reçu - Longueur:', image ? image.length : 0, 'caractères');
    console.log('Base64 reçu - Début:', image ? image.substring(0, 50) : 'NONE');
    console.log('Base64 reçu - Fin:', image ? image.substring(Math.max(0, image.length - 50)) : 'NONE');
    console.log('========================================');

    // ========== VALIDATION DES CHAMPS ==========
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

    if (!image) {
      return res.status(400).json({
        success: false,
        error: 'Le champ "image" (base64) est requis'
      });
    }

    if (!imageName) {
      return res.status(400).json({
        success: false,
        error: 'Le champ "imageName" est requis (ex: photo.jpg)'
      });
    }

    // ========== DÉCODER L'IMAGE BASE64 ==========
    let imageBuffer;
    try {
      // Supprimer le préfixe "data:image/..." s'il existe
      let base64String = image;
      if (image.includes(',')) {
        base64String = image.split(',')[1];
      }
      
      imageBuffer = Buffer.from(base64String, 'base64');
      console.log(`✅ Image décodée: ${imageBuffer.length} octets`);
    } catch (error) {
      return res.status(400).json({
        success: false,
        error: 'Erreur lors du décodage de l\'image base64',
        details: error.message
      });
    }

    // ========== SAUVEGARDER L'IMAGE ==========
    const timestamp = Date.now();
    const randomNum = Math.round(Math.random() * 1E9);
    const extension = path.extname(imageName);
    const filename = `image_${timestamp}_${randomNum}${extension}`;
    const filepath = path.join(imagesDir, filename);

    try {
      fs.writeFileSync(filepath, imageBuffer);
      console.log(`💾 Image sauvegardée: ${filename}`);
    } catch (error) {
      return res.status(500).json({
        success: false,
        error: 'Erreur lors de la sauvegarde de l\'image',
        details: error.message
      });
    }

    // ========== DÉTERMINER LE TYPE MIME ==========
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

    // ========== PRÉPARER L'EMAIL ==========
    const mailOptions = {
      from: `"${EMAIL_FROM_NAME}" <${EMAIL_FROM}>`,
      to: to,
      subject: subject,
      html: `
        <html>
          <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
          </head>
          <body style="font-family: Arial, sans-serif; margin: 0; padding: 0; background-color: #f9f9f9;">
            <div style="padding: 20px; max-width: 600px; margin: 0 auto;">
              
              <!-- Header -->
              <div style="border-bottom: 3px solid #007bff; padding-bottom: 15px; margin-bottom: 20px; background-color: white; padding: 15px; border-radius: 8px;">
                <h2 style="color: #333; margin: 0; font-size: 24px;">${subject}</h2>
              </div>
              
              <!-- Message -->
              <div style="background-color: white; padding: 20px; border-radius: 8px; margin-bottom: 20px;">
                <p style="font-size: 15px; line-height: 1.8; color: #555; margin: 0;">
                  ${message}
                </p>
              </div>

              <!-- Image Section -->
              <div style="text-align: center; margin: 30px 0; background-color: white; padding: 20px; border-radius: 8px;">
                <p style="font-weight: bold; margin-bottom: 15px; color: #333; font-size: 14px;">
                  📎 Image:
                </p>
                <div style="display: inline-block; border: 2px solid #007bff; border-radius: 10px; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.15); max-width: 100%;">
                  <img src="cid:imageContent@email" alt="Image" style="max-width: 500px; height: auto; display: block; width: 100%; border: none;">
                </div>
              </div>

              <!-- Footer -->
              <div style="border-top: 2px solid #eee; padding-top: 15px; margin-top: 30px; text-align: center; background-color: white; padding: 15px; border-radius: 8px;">
                <p style="font-size: 12px; color: #999; margin: 0;">
                  📧 Email envoyé via API Administration STS<br>
                  📁 Fichier: ${filename}<br>
                  ⏰ ${new Date().toLocaleString('fr-FR')}
                </p>
              </div>
              
            </div>
          </body>
        </html>
      `,
      attachments: [
        {
          filename: filename,
          content: imageBuffer,
          contentType: mimeType,
          cid: 'imageContent@email',
          contentDisposition: 'inline'
        }
      ]
    };

    // ========== ENVOYER L'EMAIL ==========
    console.log('📤 Envoi de l\'email...');
    const info = await transporter.sendMail(mailOptions);

    console.log('✅ Email envoyé avec succès!');
    console.log('Message ID:', info.messageId);
    console.log('========================================');

    // ========== RÉPONSE SUCCÈS ==========
    res.json({
      success: true,
      message: 'Email envoyé avec succès',
      data: {
        messageId: info.messageId,
        recipient: to,
        subject: subject,
        image: {
          filename: filename,
          size: imageBuffer.length,
          type: mimeType,
          path: `/images/${filename}`
        },
        timestamp: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('❌ Erreur générale:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur lors de l\'envoi de l\'email',
      details: error.message
    });
  }
});

// ========== ROUTE: Lister les images ==========
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

// Gestion des erreurs globales
app.use((error, req, res, next) => {
  console.error('🚨 Erreur:', error);
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
  console.log('🔗 Endpoint: POST /send-email');
  console.log('📝 Paramètres: to, subject, message, image (base64), imageName');
  console.log('========================================');
});
