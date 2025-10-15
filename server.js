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
    
    console.log(`Taille du buffer: ${buffer.length} octets`);
    
    if (buffer.length < 50) {
      throw new Error(`Image trop petite (${buffer.length} octets)`);
    }
    
    const filepath = path.join(imagesDir, filename);
    fs.writeFileSync(filepath, buffer);
    
    console.log(`✓ Image sauvegardée: ${filename}`);
    
    return { filepath, buffer, base64Data };
  } catch (error) {
    console.error('✗ Erreur décodage:', error.message);
    throw error;
  }
}

// Route de test
app.get('/', (req, res) => {
  res.json({
    message: 'API Email avec Image - Serveur actif',
    endpoints: {
      sendEmailBase64: 'POST /send-email-base64',
      sendEmailFile: 'POST /send-email-with-image',
      listImages: 'GET /images'
    }
  });
});

// Route principale : BASE64 avec Data URI + Attachment
app.post('/send-email-base64', async (req, res) => {
  try {
    const { to, subject, message, imageBase64, imageName } = req.body;

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
    const filename = `${timestamp}-${randomNum}${extension}`;

    // Sauvegarder l'image
    const { filepath, buffer, base64Data } = saveBase64Image(imageBase64, filename);
    
    // Type MIME
    const ext = path.extname(filename).toLowerCase();
    const mimeTypes = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif'
    };
    const mimeType = mimeTypes[ext] || 'image/png';
    
    // Créer Data URI pour l'image
    const dataUri = `data:${mimeType};base64,${base64Data}`;
    
    // Configuration email avec Data URI + Attachment
    const mailOptions = {
      from: `"${EMAIL_FROM_NAME}" <${EMAIL_FROM}>`,
      to: to,
      subject: subject,
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
        </head>
        <body style="margin: 0; padding: 0; font-family: Arial, sans-serif;">
          <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #f4f4f4; padding: 20px;">
            <tr>
              <td align="center">
                <table width="600" cellpadding="0" cellspacing="0" border="0" style="background-color: white; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
                  <!-- Header -->
                  <tr>
                    <td style="background-color: #4CAF50; padding: 20px; text-align: center;">
                      <h1 style="color: white; margin: 0; font-size: 24px;">${subject}</h1>
                    </td>
                  </tr>
                  
                  <!-- Message -->
                  <tr>
                    <td style="padding: 30px;">
                      <p style="font-size: 14px; line-height: 1.6; color: #333; margin: 0 0 20px 0;">${message}</p>
                    </td>
                  </tr>
                  
                  <!-- Image avec Data URI -->
                  <tr>
                    <td style="padding: 0 30px 30px 30px;">
                      <p style="font-weight: bold; margin-bottom: 15px; color: #333;">Image jointe :</p>
                      <div style="text-align: center; background-color: #f9f9f9; padding: 15px; border-radius: 8px; border: 1px solid #ddd;">
                        <img src="${dataUri}" alt="Image jointe" style="max-width: 100%; height: auto; display: block; margin: 0 auto; border-radius: 4px;" />
                      </div>
                    </td>
                  </tr>
                  
                  <!-- Footer -->
                  <tr>
                    <td style="background-color: #f9f9f9; padding: 20px; text-align: center; border-top: 1px solid #eee;">
                      <p style="font-size: 11px; color: #999; margin: 0;">Administration STS - ${new Date().toLocaleDateString('fr-FR')}</p>
                      <p style="font-size: 10px; color: #bbb; margin: 5px 0 0 0;">Si l'image ne s'affiche pas, consultez la pièce jointe.</p>
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

    // Envoyer
    const info = await transporter.sendMail(mailOptions);

    console.log('✓ Email envoyé:', info.messageId);
    console.log(`  → Destinataire: ${to}`);
    console.log(`  → Image: ${filename} (${buffer.length} octets)`);

    res.json({
      success: true,
      message: 'Email envoyé avec succès',
      data: {
        messageId: info.messageId,
        imageSaved: filename,
        imageSize: buffer.length,
        imagePath: `/images/${filename}`,
        recipient: to,
        timestamp: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('✗ Erreur:', error.message);
    res.status(500).json({
      success: false,
      error: 'Erreur lors de l\'envoi',
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
    
    // Convertir en base64 pour Data URI
    const base64Data = imageBuffer.toString('base64');
    const dataUri = `data:${mimeType};base64,${base64Data}`;

    const mailOptions = {
      from: `"${EMAIL_FROM_NAME}" <${EMAIL_FROM}>`,
      to: to,
      subject: subject,
      html: `
        <!DOCTYPE html>
        <html>
        <body style="font-family: Arial, sans-serif; padding: 20px;">
          <h2 style="color: #333;">${subject}</h2>
          <p style="font-size: 14px; line-height: 1.6;">${message}</p>
          <div style="margin: 30px 0; text-align: center;">
            <img src="${dataUri}" alt="Image" style="max-width: 100%; height: auto; border-radius: 8px;">
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
        imageSaved: imageName
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

    res.json({
      success: true,
      count: images.length,
      images: images.map(img => ({
        name: img,
        size: fs.statSync(path.join(imagesDir, img)).size,
        created: fs.statSync(path.join(imagesDir, img)).birthtime
      }))
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
  console.log(`========================================`);
  console.log(`🚀 Serveur sur le port ${PORT}`);
  console.log(`📧 SMTP: ${SMTP_HOST}:${SMTP_PORT}`);
  console.log(`📁 Images: ${imagesDir}`);
  console.log(`========================================`);
});
