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

// URL publique de votre serveur Azure
const PUBLIC_SERVER_URL = process.env.PUBLIC_SERVER_URL || "https://pdf-api.azurewebsites.net";

// Créer le dossier images s'il n'existe pas
const imagesDir = path.join(__dirname, 'images');
if (!fs.existsSync(imagesDir)) {
  fs.mkdirSync(imagesDir, { recursive: true });
  console.log('Dossier images créé');
}

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ✅ Servir les images publiquement
app.use('/images', express.static(imagesDir, {
  maxAge: '1y',
  etag: false
}));

// Configuration Multer
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, imagesDir);
  },
  filename: (req, file, cb) => {
    const timestamp = Date.now();
    const randomNum = Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    const filename = `img-${timestamp}-${randomNum}${ext}`;
    cb(null, filename);
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

// Route de test
app.get('/', (req, res) => {
  res.json({
    message: 'API Email avec Images Publiques',
    version: '3.1.0',
    serverUrl: PUBLIC_SERVER_URL,
    endpoints: {
      uploadImage: 'POST /upload-image (Upload et reçoit URL publique)',
      sendEmail: 'POST /send-email-with-image (Envoie email)',
      listImages: 'GET /list-images',
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

// ==================== 1️⃣ ROUTE: UPLOAD IMAGE ET RECEVOIR URL ====================
app.post('/upload-image', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'Aucune image n\'a été reçue'
      });
    }

    const filename = req.file.filename;
    const filesize = req.file.size;

    console.log(`✅ Image uploadée: ${filename} (${filesize} octets)`);

    if (filesize < 100) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({
        success: false,
        error: `Image trop petite (${filesize} octets)`
      });
    }

    // 🌐 Générer l'URL publique
    const publicImageUrl = `${PUBLIC_SERVER_URL}/images/${filename}`;

    console.log(`🌐 URL publique générée: ${publicImageUrl}`);

    res.json({
      success: true,
      message: 'Image uploadée et hébergée avec succès',
      data: {
        filename: filename,
        size: `${filesize} octets`,
        publicUrl: publicImageUrl,
        timestamp: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('❌ Erreur upload:', error);
    
    if (req.file && fs.existsSync(req.file.path)) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (e) {}
    }

    res.status(500).json({
      success: false,
      error: 'Erreur lors de l\'upload de l\'image',
      details: error.message
    });
  }
});

// ==================== 2️⃣ ROUTE: ENVOYER EMAIL AVEC IMAGE ====================
app.post('/send-email-with-image', async (req, res) => {
  try {
    const { to, subject, message, imageUrl } = req.body;

    console.log('=== Nouvelle requête send-email-with-image ===');
    console.log('Destinataire:', to);
    console.log('Image URL:', imageUrl);

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

    // Télécharger l'image depuis l'URL publique
    const timestamp = Date.now();
    const randomNum = Math.round(Math.random() * 1E9);
    const ext = path.extname(imageUrl).split('?')[0]; // Enlever les paramètres
    const tempFilename = `temp-${timestamp}-${randomNum}${ext}`;
    const tempPath = path.join(imagesDir, tempFilename);

    console.log('📥 Téléchargement de l\'image depuis URL...');
    await downloadImage(imageUrl, tempPath);
    
    const imageBuffer = fs.readFileSync(tempPath);
    const imageSize = imageBuffer.length;
    
    console.log(`✅ Image téléchargée: ${tempFilename} (${imageSize} octets)`);

    if (imageSize < 100) {
      fs.unlinkSync(tempPath);
      return res.status(400).json({
        success: false,
        error: `Image invalide ou trop petite (${imageSize} octets)`
      });
    }

    // Déterminer le type MIME
    const extLower = (ext || '.png').toLowerCase();
    const mimeTypes = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp'
    };
    const mimeType = mimeTypes[extLower] || 'image/png';

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
          filename: tempFilename,
          content: imageBuffer,
          contentType: mimeType,
          cid: 'imageContent@email',
          contentDisposition: 'inline'
        }
      ]
    };

    console.log('📧 Envoi de l\'email...');
    const info = await transporter.sendMail(mailOptions);

    console.log('✅ Email envoyé avec succès:', info.messageId);

    // Nettoyer le fichier temporaire
    fs.unlinkSync(tempPath);

    res.json({
      success: true,
      message: 'Email envoyé avec succès',
      data: {
        messageId: info.messageId,
        recipient: to,
        imageUrl: imageUrl,
        imageSize: `${imageSize} octets`,
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

// ==================== ROUTE COMBINÉE: UPLOAD + ENVOYER EMAIL ====================
app.post('/upload-and-send-email', upload.single('image'), async (req, res) => {
  try {
    const { to, subject, message } = req.body;

    console.log('=== Nouvelle requête upload-and-send-email ===');
    console.log('Destinataire:', to);

    // Validation
    if (!to || !subject || !message) {
      if (req.file) fs.unlinkSync(req.file.path);
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

    const filename = req.file.filename;
    const imageSize = req.file.size;

    console.log(`✅ Image uploadée: ${filename} (${imageSize} octets)`);

    if (imageSize < 100) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({
        success: false,
        error: `Image trop petite (${imageSize} octets)`
      });
    }

    // 🌐 Générer l'URL publique
    const publicImageUrl = `${PUBLIC_SERVER_URL}/images/${filename}`;
    
    console.log(`🌐 URL publique: ${publicImageUrl}`);

    // Lire l'image
    const imageBuffer = fs.readFileSync(req.file.path);

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
          filename: filename,
          content: imageBuffer,
          contentType: mimeType,
          cid: 'imageContent@email',
          contentDisposition: 'inline'
        }
      ]
    };

    console.log('📧 Envoi de l\'email...');
    const info = await transporter.sendMail(mailOptions);

    console.log('✅ Email envoyé avec succès:', info.messageId);

    res.json({
      success: true,
      message: 'Image uploadée et email envoyé avec succès',
      data: {
        messageId: info.messageId,
        filename: filename,
        publicUrl: publicImageUrl,
        imageSize: `${imageSize} octets`,
        recipient: to,
        timestamp: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('❌ Erreur:', error);
    
    if (req.file && fs.existsSync(req.file.path)) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (e) {}
    }

    res.status(500).json({
      success: false,
      error: 'Erreur lors de l\'upload/envoi',
      details: error.message
    });
  }
});

// Route pour lister les images hébergées
app.get('/list-images', (req, res) => {
  try {
    const files = fs.readdirSync(imagesDir);
    const images = files.filter(file => {
      const ext = path.extname(file).toLowerCase();
      return ['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext);
    }).map(file => ({
      filename: file,
      url: `${PUBLIC_SERVER_URL}/images/${file}`,
      path: `/images/${file}`
    }));

    res.json({
      success: true,
      count: images.length,
      serverUrl: PUBLIC_SERVER_URL,
      images: images
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
  console.log(`🌐 URL Publique: ${PUBLIC_SERVER_URL}`);
  console.log(`📧 SMTP: ${SMTP_HOST}:${SMTP_PORT}`);
  console.log(`📁 Dossier images: ${imagesDir}`);
  console.log(`\n✅ Routes disponibles:`);
  console.log(`   1️⃣  POST /upload-image`);
  console.log(`   2️⃣  POST /send-email-with-image`);
  console.log(`   3️⃣  POST /upload-and-send-email (COMBINÉ)`);
  console.log(`   📋 GET /list-images`);
  console.log(`   🏥 GET /health`);
  console.log(`========================================`);
});
