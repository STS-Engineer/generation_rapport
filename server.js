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
  console.log('Dossier images créé');
}

// Middleware
app.use(express.json({ limit: '10mb' })); // Augmenter la limite pour base64
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
  limits: { fileSize: 10 * 1024 * 1024 }, // Limite de 10MB
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

// Fonction pour décoder base64 et sauvegarder l'image
function saveBase64Image(base64String, filename) {
  try {
    // Nettoyer la chaîne base64 si elle contient le préfixe data:image
    let base64Data = base64String;
    if (base64String.includes('base64,')) {
      base64Data = base64String.split('base64,')[1];
    }
    
    // Nettoyer les espaces et retours à la ligne
    base64Data = base64Data.replace(/\s/g, '');
    
    // Décoder et sauvegarder
    const buffer = Buffer.from(base64Data, 'base64');
    
    console.log(`Taille du buffer décodé: ${buffer.length} octets`);
    
    if (buffer.length < 100) {
      throw new Error(`Image trop petite (${buffer.length} octets) - probablement corrompue ou incomplète. Une image DALL-E devrait faire au moins 5KB.`);
    }
    
    const filepath = path.join(imagesDir, filename);
    fs.writeFileSync(filepath, buffer);
    
    console.log(`Image sauvegardée avec succès: ${filepath} (${buffer.length} octets)`);
    
    return filepath;
  } catch (error) {
    console.error('Erreur lors du décodage base64:', error);
    throw error;
  }
}

// Route de test
app.get('/', (req, res) => {
  res.json({
    message: 'API Email avec Image - Serveur actif',
    endpoints: {
      sendEmailBase64: 'POST /send-email-base64 (pour GPT Assistant)',
      sendEmailFile: 'POST /send-email-with-image (upload fichier)',
      testImage: 'POST /test-image (tester le décodage)'
    }
  });
});

// Route de test pour vérifier le décodage base64
app.post('/test-image', async (req, res) => {
  try {
    const { imageBase64, imageName } = req.body;

    if (!imageBase64) {
      return res.status(400).json({
        success: false,
        error: 'Le champ "imageBase64" est requis'
      });
    }

    console.log('=== Test de décodage image ===');
    console.log('Longueur base64 reçue:', imageBase64.length);
    console.log('Premiers 100 caractères:', imageBase64.substring(0, 100));
    console.log('Derniers 50 caractères:', imageBase64.substring(imageBase64.length - 50));

    // Générer un nom de fichier de test
    const timestamp = Date.now();
    const extension = imageName ? path.extname(imageName) : '.png';
    const filename = `test-${timestamp}${extension}`;

    // Tenter de sauvegarder
    const imagePath = saveBase64Image(imageBase64, filename);
    const imageBuffer = fs.readFileSync(imagePath);

    // Vérifier les magic bytes pour déterminer le type réel
    let detectedType = 'Inconnu';
    if (imageBuffer[0] === 0x89 && imageBuffer[1] === 0x50 && imageBuffer[2] === 0x4E && imageBuffer[3] === 0x47) {
      detectedType = 'PNG';
    } else if (imageBuffer[0] === 0xFF && imageBuffer[1] === 0xD8 && imageBuffer[2] === 0xFF) {
      detectedType = 'JPEG';
    } else if (imageBuffer[0] === 0x47 && imageBuffer[1] === 0x49 && imageBuffer[2] === 0x46) {
      detectedType = 'GIF';
    }

    res.json({
      success: true,
      message: 'Image décodée avec succès',
      data: {
        filename: filename,
        path: `/images/${filename}`,
        base64Length: imageBase64.length,
        bufferSize: imageBuffer.length,
        detectedType: detectedType,
        firstBytes: Array.from(imageBuffer.slice(0, 10)),
        isValidImage: detectedType !== 'Inconnu'
      }
    });

  } catch (error) {
    console.error('Erreur lors du test:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur lors du décodage',
      details: error.message
    });
  }
});

// Route pour envoyer un email avec image en BASE64 (pour GPT Assistant)
app.post('/send-email-base64', async (req, res) => {
  try {
    const { to, subject, message, imageBase64, imageName } = req.body;

    // Validation des champs requis
    if (!to || !subject || !message) {
      return res.status(400).json({
        success: false,
        error: 'Les champs "to", "subject" et "message" sont requis'
      });
    }

    if (!imageBase64) {
      return res.status(400).json({
        success: false,
        error: 'Le champ "imageBase64" est requis'
      });
    }

    // Générer un nom de fichier unique
    const timestamp = Date.now();
    const randomNum = Math.round(Math.random() * 1E9);
    const extension = imageName ? path.extname(imageName) : '.png';
    const filename = `${timestamp}-${randomNum}${extension}`;

    // Sauvegarder l'image décodée
    const imagePath = saveBase64Image(imageBase64, filename);
    console.log(`Image base64 décodée et sauvegardée: ${imagePath}`);

    // Lire l'image en buffer
    const imageBuffer = fs.readFileSync(imagePath);
    
    // Déterminer le type MIME
    const ext = path.extname(filename).toLowerCase();
    const mimeTypes = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif'
    };
    const mimeType = mimeTypes[ext] || 'image/png';
    
    // Configuration de l'email avec CID reference
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
            <img src="cid:uniqueImageCID@nodemailer" alt="Image" style="max-width: 100%; height: auto; display: block; border: 2px solid #ddd; border-radius: 4px; padding: 5px; background: #f9f9f9;">
          </div>
          <br>
          <p style="font-size: 12px; color: #666;">Si l'image ne s'affiche pas, veuillez consulter la pièce jointe.</p>
        </div>
      `,
      attachments: [
        {
          filename: filename,
          content: imageBuffer,
          contentType: mimeType,
          cid: 'uniqueImageCID@nodemailer',
          contentDisposition: 'inline'
        },
        {
          filename: filename,
          content: imageBuffer,
          contentType: mimeType,
          contentDisposition: 'attachment'
        }
      ]
    };

    // Envoyer l'email
    const info = await transporter.sendMail(mailOptions);

    console.log('Email envoyé avec succès:', info.messageId);

    res.json({
      success: true,
      message: 'Email envoyé avec succès',
      data: {
        messageId: info.messageId,
        imageSaved: filename,
        imagePath: `/images/${filename}`,
        recipient: to
      }
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

// Route pour envoyer un email avec image (upload fichier classique)
app.post('/send-email-with-image', upload.single('image'), async (req, res) => {
  try {
    const { to, subject, message } = req.body;

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
        error: 'Aucune image n\'a été uploadée'
      });
    }

    // Chemin complet de l'image sauvegardée
    const imagePath = req.file.path;
    const imageName = req.file.filename;

    console.log(`Image sauvegardée: ${imagePath}`);

    // Lire l'image en buffer
    const imageBuffer = fs.readFileSync(imagePath);
    
    // Déterminer le type MIME
    const ext = path.extname(imageName).toLowerCase();
    const mimeTypes = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif'
    };
    const mimeType = mimeTypes[ext] || 'image/png';

    // Configuration de l'email avec CID reference
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
            <img src="cid:uniqueImageCID@nodemailer" alt="Image" style="max-width: 100%; height: auto; display: block; border: 2px solid #ddd; border-radius: 4px; padding: 5px; background: #f9f9f9;">
          </div>
          <br>
          <p style="font-size: 12px; color: #666;">Si l'image ne s'affiche pas, veuillez consulter la pièce jointe.</p>
        </div>
      `,
      attachments: [
        {
          filename: imageName,
          content: imageBuffer,
          contentType: mimeType,
          cid: 'uniqueImageCID@nodemailer',
          contentDisposition: 'inline'
        },
        {
          filename: imageName,
          content: imageBuffer,
          contentType: mimeType,
          contentDisposition: 'attachment'
        }
      ]
    };

    // Envoyer l'email
    const info = await transporter.sendMail(mailOptions);

    console.log('Email envoyé avec succès:', info.messageId);

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
    console.error('Erreur lors de l\'envoi de l\'email:', error);
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
