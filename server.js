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
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

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
  limits: { fileSize: 10 * 1024 * 1024 },
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

// Fonction pour télécharger une image depuis une URL
function downloadImage(url, filepath) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    
    const file = fs.createWriteStream(filepath);
    
    protocol.get(url, (response) => {
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
    message: 'API Email avec Image - Serveur actif',
    endpoints: {
      sendEmailFromURL: 'POST /send-email-from-url (pour GPT Assistant - envoie URL image)',
      sendEmailFile: 'POST /send-email-with-image (upload fichier)',
      listImages: 'GET /images'
    }
  });
});

// Route principale : GPT envoie l'URL de l'image
app.post('/send-email-from-url', async (req, res) => {
  try {
    const { to, subject, message, imageUrl, imageName } = req.body;

    console.log('=== Nouvelle requête send-email-from-url ===');
    console.log('Destinataire:', to);
    console.log('Sujet:', subject);
    console.log('URL Image:', imageUrl);

    // Validation des champs requis
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

    // Vérifier que c'est bien une URL
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

    // Télécharger l'image depuis l'URL
    console.log('Téléchargement de l\'image...');
    await downloadImage(imageUrl, filepath);
    
    // Lire l'image téléchargée
    const imageBuffer = fs.readFileSync(filepath);
    const imageSize = imageBuffer.length;
    
    console.log(`Image téléchargée: ${filepath} (${imageSize} octets)`);

    if (imageSize < 100) {
      return res.status(400).json({
        success: false,
        error: `Image téléchargée trop petite (${imageSize} octets) - probablement invalide`
      });
    }

    // Déterminer le type MIME
    const ext = path.extname(filename).toLowerCase();
    const mimeTypes = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif'
    };
    const mimeType = mimeTypes[ext] || 'image/png';

    // Configuration de l'email
    const mailOptions = {
      from: `"${EMAIL_FROM_NAME}" <${EMAIL_FROM}>`,
      to: to,
      subject: subject,
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px;">
          <h2 style="color: #333;">${subject}</h2>
          <p style="font-size: 14px; line-height: 1.6;">${message}</p>
          <br>
          <div style="margin: 20px 0;">
            <p style="font-weight: bold; margin-bottom: 10px;">Image jointe ci-dessous:</p>
            <img src="cid:imageContent@email" alt="Image" style="max-width: 100%; height: auto; display: block; border: 2px solid #ddd; border-radius: 4px; padding: 5px; background: #f9f9f9;">
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

    // Envoyer l'email
    console.log('Envoi de l\'email...');
    const info = await transporter.sendMail(mailOptions);

    console.log('✅ Email envoyé avec succès:', info.messageId);

    res.json({
      success: true,
      message: 'Email envoyé avec succès',
      data: {
        messageId: info.messageId,
        imageSaved: filename,
        imagePath: `/images/${filename}`,
        imageSize: `${imageSize} octets`,
        recipient: to
      }
    });

  } catch (error) {
    console.error('❌ Erreur lors de l\'envoi de l\'email:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur lors de l\'envoi de l\'email',
      details: error.message
    });
  }
});

// Route pour envoyer un email avec fichier uploadé
app.post('/send-email-with-image', upload.single('image'), async (req, res) => {
  try {
    const { to, subject, message } = req.body;

    if (!to || !subject || !message) {
      return res.status(400).json({
        success: false,
        error: 'Les champs "to", "subject" et "message" sont requis'
      });
    }

    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'Aucune image n\'a été uploadée'
      });
    }

    const imagePath = req.file.path;
    const imageName = req.file.filename;
    const imageBuffer = fs.readFileSync(imagePath);

    const ext = path.extname(imageName).toLowerCase();
    const mimeTypes = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif'
    };
    const mimeType = mimeTypes[ext] || 'image/png';

    const mailOptions = {
      from: `"${EMAIL_FROM_NAME}" <${EMAIL_FROM}>`,
      to: to,
      subject: subject,
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px;">
          <h2 style="color: #333;">${subject}</h2>
          <p style="font-size: 14px; line-height: 1.6;">${message}</p>
          <br>
          <div style="margin: 20px 0;">
            <p style="font-weight: bold; margin-bottom: 10px;">Image jointe ci-dessous:</p>
            <img src="cid:imageContent@email" alt="Image" style="max-width: 100%; height: auto; display: block; border: 2px solid #ddd; border-radius: 4px; padding: 5px; background: #f9f9f9;">
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

    const info = await transporter.sendMail(mailOptions);

    console.log('✅ Email envoyé avec succès:', info.messageId);

    res.json({
      success: true,
      message: 'Email envoyé avec succès',
      data: {
        messageId: info.messageId,
        imageSaved: imageName,
        imagePath: `/images/${imageName}`,
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

// Route pour lister les images dans le dossier
app.get('/images', (req, res) => {
  try {
    const files = fs.readdirSync(imagesDir);
    const images = files.filter(file => {
      const ext = path.extname(file).toLowerCase();
      return ['.jpg', '.jpeg', '.png', '.gif'].includes(ext);
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
        error: 'Le fichier est trop volumineux (max 10MB)'
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
  console.log(`========================================`);
  console.log(`🚀 Serveur démarré sur le port ${PORT}`);
  console.log(`📧 SMTP: ${SMTP_HOST}:${SMTP_PORT}`);
  console.log(`📁 Dossier images: ${imagesDir}`);
  console.log(`========================================`);
});
