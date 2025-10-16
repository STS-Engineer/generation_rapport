const express = require('express');
const nodemailer = require('nodemailer');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');

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
  console.log('Dossier images créé');
}

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use('/images', express.static(imagesDir));

// Configuration Multer pour sauvegarder les fichiers dans le dossier images
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, imagesDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|webp/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    
    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('Seules les images sont autorisées (jpeg, jpg, png, gif, webp)'));
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

// Fonction pour télécharger une image depuis une URL
function downloadImage(url, filepath) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    
    const file = fs.createWriteStream(filepath);
    
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    };
    
    protocol.get(url, options, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`Échec du téléchargement: ${response.statusCode}`));
        return;
      }
      
      response.pipe(file);
      
      file.on('finish', () => {
        file.close();
        resolve(filepath);
      });
    }).on('error', (err) => {
      fs.unlink(filepath, () => {});
      reject(err);
    });
  });
}

// Fonction pour convertir base64 en fichier
function saveBase64Image(base64Data, filepath) {
  return new Promise((resolve, reject) => {
    try {
      // Supprimer le préfixe data:image/... s'il existe
      const base64String = base64Data.replace(/^data:image\/\w+;base64,/, '');
      const buffer = Buffer.from(base64String, 'base64');
      fs.writeFileSync(filepath, buffer);
      resolve(filepath);
    } catch (error) {
      reject(error);
    }
  });
}

// Route de test
app.get('/', (req, res) => {
  res.json({
    message: 'API Email avec Image - Serveur actif',
    version: '3.0.0',
    endpoints: {
      uploadAndSendEmail: 'POST /upload-and-send-email (GPT envoie fichier uploadé)',
      sendEmailFromURL: 'POST /send-email-from-url (envoie URL image)',
      sendEmailWithBase64: 'POST /send-email-with-base64 (envoie image en base64)',
      listImages: 'GET /images-list',
      health: 'GET /health'
    }
  });
});

// Route de santé
app.get('/health', (req, res) => {
  res.json({
    success: true,
    status: 'Service actif',
    timestamp: new Date().toISOString()
  });
});

// ==================== ROUTE PRINCIPALE POUR GPT ====================
// GPT envoie un fichier uploadé par l'utilisateur
app.post('/upload-and-send-email', upload.single('image'), async (req, res) => {
  try {
    const { to, subject, message } = req.body;

    console.log('=== Nouvelle requête upload-and-send-email ===');
    console.log('Destinataire:', to);
    console.log('Sujet:', subject);
    console.log('Fichier reçu:', req.file?.filename);

    // Validation des champs requis
    if (!to || !subject || !message) {
      return res.status(400).json({
        success: false,
        error: 'Les champs "to", "subject" et "message" sont requis'
      });
    }

    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'Aucune image n\'a été reçue'
      });
    }

    const imagePath = req.file.path;
    const imageName = req.file.filename;
    const imageSize = req.file.size;

    console.log(`Image reçue: ${imageName} (${imageSize} octets)`);

    // Vérifier que le fichier existe et a une taille valide
    if (imageSize < 100) {
      fs.unlinkSync(imagePath);
      return res.status(400).json({
        success: false,
        error: `Image trop petite (${imageSize} octets) - fichier invalide`
      });
    }

    // Lire l'image
    const imageBuffer = fs.readFileSync(imagePath);

    // Déterminer le type MIME
    const ext = path.extname(imageName).toLowerCase();
    const mimeTypes = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp'
    };
    const mimeType = mimeTypes[ext] || 'image/png';

    // Configuration de l'email
    const mailOptions = {
      from: `"${EMAIL_FROM_NAME}" <${EMAIL_FROM}>`,
      to: to,
      subject: subject,
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px; background: #f5f5f5;">
          <div style="background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
            <h2 style="color: #333; margin-top: 0;">${escapeHtml(subject)}</h2>
            <p style="font-size: 14px; line-height: 1.6; color: #555;">${escapeHtml(message)}</p>
            <hr style="border: none; border-top: 1px solid #ddd; margin: 20px 0;">
            <div style="margin: 20px 0; text-align: center;">
              <p style="font-weight: bold; margin-bottom: 15px; color: #333;">Pièce jointe :</p>
              <img src="cid:imageContent@email" alt="Image" style="max-width: 100%; height: auto; display: block; border: 2px solid #ddd; border-radius: 4px; padding: 5px; background: #f9f9f9;">
            </div>
            <p style="font-size: 12px; color: #999; margin-top: 20px; border-top: 1px solid #eee; padding-top: 10px;">
              Message envoyé par Administration STS
            </p>
          </div>
        </div>
      `,
      attachments: [
        {
          filename: imageName,
          content: imageBuffer,
          contentType: mimeType,
          cid: 'imageContent@email',
          contentDisposition: 'inline'
        }
      ]
    };

    // Envoyer l'email
    console.log('Envoi de l\'email...');
    const info = await transporter.sendMail(mailOptions);

    console.log('✅ Email envoyé avec succès:', info.messageId);

    res.json({
      success: true,
      message: 'Email envoyé avec succès',
      data: {
        messageId: info.messageId,
        imageSaved: imageName,
        imageSize: `${imageSize} octets`,
        recipient: to,
        timestamp: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('❌ Erreur:', error);
    
    // Nettoyer le fichier en cas d'erreur
    if (req.file && fs.existsSync(req.file.path)) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (e) {}
    }

    res.status(500).json({
      success: false,
      error: 'Erreur lors de l\'envoi de l\'email',
      details: error.message
    });
  }
});

// Route alternative : GPT envoie l'URL de l'image
app.post('/send-email-from-url', async (req, res) => {
  try {
    const { to, subject, message, imageUrl, imageName } = req.body;

    console.log('=== Nouvelle requête send-email-from-url ===');
    console.log('Destinataire:', to);
    console.log('URL Image:', imageUrl);

    // Validation
    if (!to || !subject || !message) {
      return res.status(400).json({
        success: false,
        error: 'Les champs "to", "subject" et "message" sont requis'
      });
    }

    if (!imageUrl) {
      return res.status(400).json({
        success: false,
        error: 'Le champ "imageUrl" est requis'
      });
    }

    if (!imageUrl.startsWith('http://') && !imageUrl.startsWith('https://')) {
      return res.status(400).json({
        success: false,
        error: 'imageUrl doit être une URL valide (http:// ou https://)'
      });
    }

    // Générer un nom de fichier unique
    const timestamp = Date.now();
    const randomNum = Math.round(Math.random() * 1E9);
    const extension = imageName ? path.extname(imageName) : '.png';
    const filename = `${timestamp}-${randomNum}${extension}`;
    const filepath = path.join(imagesDir, filename);

    // Télécharger l'image
    console.log('Téléchargement de l\'image...');
    await downloadImage(imageUrl, filepath);
    
    const imageBuffer = fs.readFileSync(filepath);
    const imageSize = imageBuffer.length;
    
    console.log(`Image téléchargée: ${filename} (${imageSize} octets)`);

    if (imageSize < 100) {
      fs.unlinkSync(filepath);
      return res.status(400).json({
        success: false,
        error: `Image téléchargée trop petite (${imageSize} octets)`
      });
    }

    // Déterminer le type MIME
    const ext = path.extname(filename).toLowerCase();
    const mimeTypes = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp'
    };
    const mimeType = mimeTypes[ext] || 'image/png';

    // Configuration de l'email
    const mailOptions = {
      from: `"${EMAIL_FROM_NAME}" <${EMAIL_FROM}>`,
      to: to,
      subject: subject,
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px; background: #f5f5f5;">
          <div style="background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
            <h2 style="color: #333; margin-top: 0;">${escapeHtml(subject)}</h2>
            <p style="font-size: 14px; line-height: 1.6; color: #555;">${escapeHtml(message)}</p>
            <hr style="border: none; border-top: 1px solid #ddd; margin: 20px 0;">
            <div style="margin: 20px 0; text-align: center;">
              <img src="cid:imageContent@email" alt="Image" style="max-width: 100%; height: auto; display: block; border: 2px solid #ddd; border-radius: 4px; padding: 5px;">
            </div>
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

    console.log('Envoi de l\'email...');
    const info = await transporter.sendMail(mailOptions);

    console.log('✅ Email envoyé avec succès:', info.messageId);

    res.json({
      success: true,
      message: 'Email envoyé avec succès',
      data: {
        messageId: info.messageId,
        imageSaved: filename,
        imageSize: `${imageSize} octets`,
        recipient: to,
        timestamp: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('❌ Erreur:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur lors de l\'envoi de l\'email',
      details: error.message
    });
  }
});

// Route pour envoyer avec image en base64
app.post('/send-email-with-base64', async (req, res) => {
  try {
    const { to, subject, message, imageBase64, imageName } = req.body;

    console.log('=== Nouvelle requête send-email-with-base64 ===');
    console.log('Destinataire:', to);

    if (!to || !subject || !message || !imageBase64) {
      return res.status(400).json({
        success: false,
        error: 'Les champs "to", "subject", "message" et "imageBase64" sont requis'
      });
    }

    // Générer un nom de fichier unique
    const timestamp = Date.now();
    const randomNum = Math.round(Math.random() * 1E9);
    const extension = imageName ? path.extname(imageName) : '.png';
    const filename = `${timestamp}-${randomNum}${extension}`;
    const filepath = path.join(imagesDir, filename);

    // Sauvegarder l'image base64
    console.log('Conversion du base64...');
    await saveBase64Image(imageBase64, filepath);
    
    const imageBuffer = fs.readFileSync(filepath);
    const imageSize = imageBuffer.length;

    console.log(`Image convertie: ${filename} (${imageSize} octets)`);

    if (imageSize < 100) {
      fs.unlinkSync(filepath);
      return res.status(400).json({
        success: false,
        error: 'Image invalide ou trop petite'
      });
    }

    // Déterminer le type MIME
    const ext = path.extname(filename).toLowerCase();
    const mimeTypes = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp'
    };
    const mimeType = mimeTypes[ext] || 'image/png';

    const mailOptions = {
      from: `"${EMAIL_FROM_NAME}" <${EMAIL_FROM}>`,
      to: to,
      subject: subject,
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px;">
          <h2 style="color: #333;">${escapeHtml(subject)}</h2>
          <p style="font-size: 14px; line-height: 1.6;">${escapeHtml(message)}</p>
          <div style="margin: 20px 0; text-align: center;">
            <img src="cid:imageContent@email" alt="Image" style="max-width: 100%; height: auto; border-radius: 4px;">
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

    console.log('Envoi de l\'email...');
    const info = await transporter.sendMail(mailOptions);

    console.log('✅ Email envoyé:', info.messageId);

    res.json({
      success: true,
      message: 'Email envoyé avec succès',
      data: {
        messageId: info.messageId,
        imageSaved: filename,
        recipient: to
      }
    });

  } catch (error) {
    console.error('❌ Erreur:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur lors de l\'envoi de l\'email',
      details: error.message
    });
  }
});

// Route pour lister les images
app.get('/images-list', (req, res) => {
  try {
    const files = fs.readdirSync(imagesDir);
    const images = files.filter(file => {
      const ext = path.extname(file).toLowerCase();
      return ['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext);
    });

    res.json({
      success: true,
      count: images.length,
      images: images
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
        error: 'Le fichier est trop volumineux (max 50MB)'
      });
    }
  }
  res.status(500).json({
    success: false,
    error: error.message
  });
});

// Fonction pour échapper HTML
function escapeHtml(text) {
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return text.replace(/[&<>"']/g, m => map[m]);
}

// Démarrer le serveur
app.listen(PORT, () => {
  console.log(`========================================`);
  console.log(`🚀 Serveur démarré sur le port ${PORT}`);
  console.log(`📧 SMTP: ${SMTP_HOST}:${SMTP_PORT}`);
  console.log(`📁 Dossier images: ${imagesDir}`);
  console.log(`✅ Routes disponibles:`);
  console.log(`   POST /upload-and-send-email (GPT upload)`);
  console.log(`   POST /send-email-from-url`);
  console.log(`   POST /send-email-with-base64`);
  console.log(`   GET /health`);
  console.log(`========================================`);
});
