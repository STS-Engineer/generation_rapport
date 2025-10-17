const express = require('express');
const nodemailer = require('nodemailer');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

/* ========================= CONFIG FIXE ========================= */
const SMTP_HOST = "avocarbon-com.mail.protection.outlook.com";
const SMTP_PORT = 25;
const EMAIL_FROM_NAME = "Administration STS";
const EMAIL_FROM = "administration.STS@avocarbon.com";
const AZURE_URL = process.env.AZURE_URL || "https://pdf-api.azurewebsites.net";

// Créer le dossier images s'il n'existe pas
const imagesDir = path.join(__dirname, 'images');
if (!fs.existsSync(imagesDir)) {
  fs.mkdirSync(imagesDir, { recursive: true });
  console.log('✅ Dossier images créé');
}

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use('/images', express.static(imagesDir));

// Configuration Multer pour upload en mémoire
const storage = multer.memoryStorage();

const upload = multer({
  storage: storage,
  limits: { fileSize: 50 * 1024 * 1024 },
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
    version: '3.1.0',
    method: 'Upload fichier depuis GPT ou Utilisateur',
    endpoints: {
      sendEmail: 'POST /send-email (Image en multipart/form-data)',
      sendEmailFromUrl: 'POST /send-email-from-url (Image depuis URL)',
      listImages: 'GET /images',
      getImage: 'GET /images/:filename'
    },
    status: 'Running'
  });
});

// ========== FONCTION UTILITAIRE: Sauvegarder image et envoyer mail ==========
async function saveAndSendEmail(imageBuffer, imageOriginalName, to, subject, message) {
  try {
    // 1️⃣ Générer un nom de fichier unique
    const timestamp = Date.now();
    const randomNum = Math.round(Math.random() * 1E9);
    const extension = path.extname(imageOriginalName);
    const filename = `image_${timestamp}_${randomNum}${extension}`;
    const filepath = path.join(imagesDir, filename);

    // 2️⃣ Sauvegarder l'image sur le serveur Azure
    fs.writeFileSync(filepath, imageBuffer);
    const imageSize = imageBuffer.length;
    console.log(`💾 Image sauvegardée: ${filename} (${imageSize} octets)`);

    // 3️⃣ Déterminer le type MIME
    const ext = extension.toLowerCase();
    const mimeTypes = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.bmp': 'image/bmp'
    };
    const mimeType = mimeTypes[ext] || 'image/png';

    // 4️⃣ Configuration de l'email avec l'image
    const mailOptions = {
      from: `"${EMAIL_FROM_NAME}" <${EMAIL_FROM}>`,
      to: to,
      subject: subject,
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px; max-width: 600px; margin: 0 auto; background-color: #f9f9f9;">
          <div style="border-bottom: 3px solid #007bff; padding-bottom: 15px; margin-bottom: 20px; background-color: white; padding: 15px;">
            <h2 style="color: #333; margin: 0; font-size: 24px;">${subject}</h2>
          </div>
          
          <div style="background-color: white; padding: 20px; border-radius: 8px; margin-bottom: 20px;">
            <p style="font-size: 15px; line-height: 1.8; color: #555; margin-bottom: 20px;">
              ${message}
            </p>
          </div>

          <div style="text-align: center; margin: 30px 0; background-color: white; padding: 20px; border-radius: 8px;">
            <p style="font-weight: bold; margin-bottom: 15px; color: #333; font-size: 14px;">
              📎 Image jointe ci-dessous:
            </p>
            <div style="display: inline-block; border: 2px solid #007bff; border-radius: 10px; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.15); max-width: 100%;">
              <img src="cid:imageContent@email" alt="Image" style="max-width: 500px; height: auto; display: block; width: 100%;">
            </div>
          </div>

          <div style="border-top: 2px solid #eee; padding-top: 15px; margin-top: 30px; text-align: center; background-color: white; padding: 15px;">
            <p style="font-size: 12px; color: #999; margin: 0;">
              📧 Email envoyé via API Administration STS<br>
              📁 Fichier: ${filename}
            </p>
          </div>
        </div>
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

    // 5️⃣ Envoyer l'email
    console.log('📤 Envoi de l\'email...');
    const info = await transporter.sendMail(mailOptions);

    console.log('✅ Email envoyé avec succès!');
    console.log('Message ID:', info.messageId);

    return {
      success: true,
      messageId: info.messageId,
      image: {
        filename: filename,
        size: imageSize,
        type: mimeType,
        url: `${AZURE_URL}/images/${filename}`
      },
      recipient: to,
      timestamp: new Date().toISOString()
    };

  } catch (error) {
    console.error('❌ Erreur:', error);
    throw error;
  }
}

// ========== ROUTE 1: Upload image directe (GPT ou formulaire) ==========
app.post('/send-email', upload.single('image'), async (req, res) => {
  try {
    const { to, subject, message } = req.body;

    console.log('========================================');
    console.log('📧 Nouvelle requête: /send-email');
    console.log('Destinataire:', to);
    console.log('Sujet:', subject);
    console.log('Fichier:', req.file ? req.file.originalname : 'Aucun');
    console.log('========================================');

    // Validation
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

    // Traiter l'image
    const result = await saveAndSendEmail(
      req.file.buffer,
      req.file.originalname,
      to,
      subject,
      message
    );

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

// ========== ROUTE 2: Envoyer image depuis URL (DALL-E, etc.) ==========
app.post('/send-email-from-url', async (req, res) => {
  try {
    const { to, subject, message, imageUrl } = req.body;

    console.log('========================================');
    console.log('📧 Nouvelle requête: /send-email-from-url');
    console.log('Destinataire:', to);
    console.log('URL image:', imageUrl ? 'Reçue' : 'Manquante');
    console.log('========================================');

    // Validation
    if (!to || !subject || !message || !imageUrl) {
      return res.status(400).json({
        success: false,
        error: 'Les champs to, subject, message et imageUrl sont requis'
      });
    }

    // 1️⃣ Télécharger l'image depuis l'URL
    console.log('⬇️  Téléchargement de l\'image depuis:', imageUrl);
    const response = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      timeout: 30000
    });

    const imageBuffer = Buffer.from(response.data);
    const contentType = response.headers['content-type'];
    
    // Déterminer l'extension
    let extension = '.png';
    if (contentType.includes('jpeg')) extension = '.jpg';
    else if (contentType.includes('png')) extension = '.png';
    else if (contentType.includes('gif')) extension = '.gif';
    else if (contentType.includes('webp')) extension = '.webp';

    const imageName = `image_dalle${extension}`;

    console.log(`✅ Image téléchargée (${imageBuffer.length} octets)`);

    // 2️⃣ Sauvegarder et envoyer
    const result = await saveAndSendEmail(
      imageBuffer,
      imageName,
      to,
      subject,
      message
    );

    res.json({
      success: true,
      message: 'Email avec image DALL-E envoyé avec succès',
      data: result
    });

  } catch (error) {
    console.error('❌ Erreur:', error.message);
    res.status(500).json({
      success: false,
      error: 'Erreur lors de l\'envoi',
      details: error.message
    });
  }
});

// ========== ROUTE 3: Lister les images ==========
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
        created: stats.birthtime,
        url: `${AZURE_URL}/images/${file}`
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

// Gestion des erreurs multer
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
  console.log('🔗 Endpoints:');
  console.log('   POST /send-email (upload direct)');
  console.log('   POST /send-email-from-url (depuis URL)');
  console.log('   GET /images-list (liste)');
  console.log('========================================');
});
