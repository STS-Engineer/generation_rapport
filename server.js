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
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Configuration Multer
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

// Vérifier la connexion SMTP au démarrage
transporter.verify(function(error, success) {
  if (error) {
    console.log('✗ Erreur connexion SMTP:', error.message);
  } else {
    console.log('✓ Serveur SMTP prêt');
  }
});

// Fonction pour décoder base64
function saveBase64Image(base64String, filename) {
  try {
    let base64Data = base64String;
    
    // Nettoyer le préfixe data:image
    if (base64String.includes('base64,')) {
      base64Data = base64String.split('base64,')[1];
    } else if (base64String.includes(',')) {
      base64Data = base64String.split(',')[1];
    }
    
    // Nettoyer les caractères non-base64
    base64Data = base64Data.replace(/[^A-Za-z0-9+/=]/g, '');
    
    if (base64Data.length === 0) {
      throw new Error('Chaîne base64 vide');
    }
    
    // Décoder
    const buffer = Buffer.from(base64Data, 'base64');
    
    console.log(`  → Taille buffer: ${buffer.length} octets`);
    
    if (buffer.length < 50) {
      throw new Error(`Image trop petite (${buffer.length} octets)`);
    }
    
    const filepath = path.join(imagesDir, filename);
    fs.writeFileSync(filepath, buffer);
    
    console.log(`  → Fichier sauvegardé: ${filename}`);
    
    return { filepath, buffer };
  } catch (error) {
    console.error('✗ Erreur décodage:', error.message);
    throw error;
  }
}

// Route de test
app.get('/', (req, res) => {
  res.json({
    message: 'API Email avec Image - Serveur actif',
    version: '3.0',
    endpoints: {
      sendEmailBase64: 'POST /send-email-base64 - Image en base64',
      sendEmailFile: 'POST /send-email-with-image - Upload fichier',
      listImages: 'GET /images - Liste des images'
    }
  });
});

// Route principale : BASE64 avec pièce jointe uniquement
app.post('/send-email-base64', async (req, res) => {
  try {
    const { to, subject, message, imageBase64, imageName } = req.body;

    console.log('========== NOUVELLE DEMANDE ==========');
    console.log(`Destinataire: ${to}`);
    console.log(`Sujet: ${subject}`);

    // Validation
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

    // Générer nom unique
    const timestamp = Date.now();
    const randomNum = Math.round(Math.random() * 1E9);
    const extension = imageName ? path.extname(imageName) : '.png';
    const filename = `image_${timestamp}${extension}`;

    console.log('Traitement de l\'image...');
    
    // Sauvegarder l'image
    const { filepath, buffer } = saveBase64Image(imageBase64, filename);
    
    // Type MIME
    const ext = path.extname(filename).toLowerCase();
    const mimeTypes = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif'
    };
    const mimeType = mimeTypes[ext] || 'image/png';
    
    console.log(`  → Type MIME: ${mimeType}`);
    
    // Configuration email simple avec pièce jointe
    const mailOptions = {
      from: `"${EMAIL_FROM_NAME}" <${EMAIL_FROM}>`,
      to: to,
      subject: subject,
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
        </head>
        <body style="margin: 0; padding: 0; font-family: Arial, sans-serif; background-color: #f5f5f5;">
          <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #f5f5f5; padding: 20px;">
            <tr>
              <td align="center">
                <table width="600" cellpadding="0" cellspacing="0" border="0" style="background-color: white; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
                  
                  <!-- Header -->
                  <tr>
                    <td style="background: linear-gradient(135deg, #4CAF50 0%, #45a049 100%); padding: 30px 20px; text-align: center;">
                      <h1 style="color: white; margin: 0; font-size: 28px; font-weight: 600;">${subject}</h1>
                    </td>
                  </tr>
                  
                  <!-- Content -->
                  <tr>
                    <td style="padding: 40px 30px;">
                      <p style="font-size: 15px; line-height: 1.8; color: #333; margin: 0 0 25px 0;">${message}</p>
                      
                      <div style="background-color: #f9f9f9; border-left: 4px solid #4CAF50; padding: 20px; margin: 25px 0; border-radius: 4px;">
                        <p style="margin: 0; font-size: 14px; color: #555;">
                          <strong style="color: #4CAF50;">📎 Image jointe</strong><br>
                          <span style="font-size: 13px; color: #777;">L'image est disponible en pièce jointe de cet email.</span><br>
                          <span style="font-size: 12px; color: #999; font-style: italic;">Nom du fichier : ${filename}</span>
                        </p>
                      </div>
                      
                      <p style="font-size: 13px; color: #999; margin: 20px 0 0 0; line-height: 1.6;">
                        💡 <em>Pour visualiser l'image, veuillez ouvrir la pièce jointe ci-dessus.</em>
                      </p>
                    </td>
                  </tr>
                  
                  <!-- Footer -->
                  <tr>
                    <td style="background-color: #f9f9f9; padding: 20px 30px; text-align: center; border-top: 1px solid #e0e0e0;">
                      <p style="font-size: 12px; color: #999; margin: 0;">
                        <strong style="color: #666;">Administration STS</strong><br>
                        ${new Date().toLocaleDateString('fr-FR', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
                      </p>
                    </td>
                  </tr>
                  
                </table>
              </td>
            </tr>
          </table>
        </body>
        </html>
      `,
      attachments: [
        {
          filename: filename,
          content: buffer,
          contentType: mimeType
        }
      ]
    };

    console.log('Envoi de l\'email...');
    
    // Envoyer
    const info = await transporter.sendMail(mailOptions);

    console.log('✓ Email envoyé avec succès');
    console.log(`  → Message ID: ${info.messageId}`);
    console.log(`  → Image: ${filename} (${buffer.length} octets)`);
    console.log('======================================\n');

    res.json({
      success: true,
      message: 'Email envoyé avec succès',
      data: {
        messageId: info.messageId,
        imageSaved: filename,
        imageSize: buffer.length,
        imagePath: filepath,
        recipient: to,
        timestamp: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('✗ ERREUR:', error.message);
    console.error('======================================\n');
    res.status(500).json({
      success: false,
      error: 'Erreur lors de l\'envoi de l\'email',
      details: error.message
    });
  }
});

// Route alternative : Upload fichier
app.post('/send-email-with-image', upload.single('image'), async (req, res) => {
  try {
    const { to, subject, message } = req.body;

    if (!to || !subject || !message) {
      return res.status(400).json({
        success: false,
        error: 'Champs requis manquants'
      });
    }

    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'Aucune image uploadée'
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
        <!DOCTYPE html>
        <html>
        <body style="font-family: Arial, sans-serif; padding: 20px; background-color: #f5f5f5;">
          <div style="max-width: 600px; margin: 0 auto; background: white; padding: 30px; border-radius: 8px;">
            <h2 style="color: #333; border-bottom: 3px solid #4CAF50; padding-bottom: 10px;">${subject}</h2>
            <p style="font-size: 14px; line-height: 1.8; color: #555;">${message}</p>
            <div style="margin: 20px 0; padding: 15px; background-color: #f0f0f0; border-radius: 4px;">
              <strong>📎 Image jointe : ${imageName}</strong>
            </div>
            <p style="font-size: 12px; color: #999;">Administration STS - ${new Date().toLocaleDateString('fr-FR')}</p>
          </div>
        </body>
        </html>
      `,
      attachments: [
        {
          filename: imageName,
          content: imageBuffer,
          contentType: mimeType
        }
      ]
    };

    const info = await transporter.sendMail(mailOptions);

    res.json({
      success: true,
      message: 'Email envoyé',
      data: {
        messageId: info.messageId,
        imageSaved: imageName,
        imageSize: imageBuffer.length
      }
    });

  } catch (error) {
    console.error('Erreur:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Lister les images
app.get('/images', (req, res) => {
  try {
    const files = fs.readdirSync(imagesDir);
    const images = files.filter(file => {
      const ext = path.extname(file).toLowerCase();
      return ['.jpg', '.jpeg', '.png', '.gif'].includes(ext);
    });

    const imageDetails = images.map(img => {
      const stats = fs.statSync(path.join(imagesDir, img));
      return {
        name: img,
        size: stats.size,
        created: stats.birthtime,
        modified: stats.mtime
      };
    });

    res.json({
      success: true,
      count: images.length,
      totalSize: imageDetails.reduce((sum, img) => sum + img.size, 0),
      images: imageDetails
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Supprimer une image
app.delete('/images/:filename', (req, res) => {
  try {
    const filename = req.params.filename;
    const filepath = path.join(imagesDir, filename);
    
    if (!fs.existsSync(filepath)) {
      return res.status(404).json({
        success: false,
        error: 'Image non trouvée'
      });
    }
    
    fs.unlinkSync(filepath);
    
    res.json({
      success: true,
      message: 'Image supprimée',
      filename: filename
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Gestion erreurs
app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        success: false,
        error: 'Fichier trop volumineux (max 10MB)'
      });
    }
  }
  res.status(500).json({
    success: false,
    error: error.message
  });
});

// Démarrer
app.listen(PORT, () => {
  console.log('========================================');
  console.log('🚀 Serveur Email API v3.0');
  console.log(`📡 Port: ${PORT}`);
  console.log(`📧 SMTP: ${SMTP_HOST}:${SMTP_PORT}`);
  console.log(`📁 Dossier images: ${imagesDir}`);
  console.log('========================================\n');
});
