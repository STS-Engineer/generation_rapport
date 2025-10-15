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

// Créer le dossier images
const imagesDir = path.join(__dirname, 'images');
if (!fs.existsSync(imagesDir)) {
  fs.mkdirSync(imagesDir, { recursive: true });
}

// Middleware avec limite augmentée
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Configuration Multer
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, imagesDir),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|bmp|webp/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('Format non supporté'));
    }
  }
});

// Configuration SMTP
const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: false,
  tls: { rejectUnauthorized: false }
});

// Vérification SMTP
transporter.verify((error, success) => {
  if (error) {
    console.log('✗ SMTP Error:', error.message);
  } else {
    console.log('✓ SMTP Ready');
  }
});

// Fonction de décodage base64 ROBUSTE
function decodeAndSaveImage(base64String, filename) {
  try {
    console.log('\n--- DÉCODAGE IMAGE ---');
    console.log(`Input length: ${base64String.length} chars`);
    
    let base64Data = base64String;
    let detectedMime = 'image/png';
    
    // Extraire le type MIME si présent
    if (base64String.startsWith('data:')) {
      const matches = base64String.match(/^data:([^;]+);base64,(.*)$/);
      if (matches) {
        detectedMime = matches[1];
        base64Data = matches[2];
        console.log(`Detected MIME: ${detectedMime}`);
      }
    } else if (base64String.includes('base64,')) {
      base64Data = base64String.split('base64,')[1];
    }
    
    // Nettoyage agressif
    base64Data = base64Data
      .replace(/\s+/g, '')           // Espaces
      .replace(/\n/g, '')            // Retours ligne
      .replace(/\r/g, '')            // Carriage return
      .replace(/[^A-Za-z0-9+/=]/g, ''); // Caractères invalides
    
    console.log(`Cleaned length: ${base64Data.length} chars`);
    
    if (base64Data.length === 0) {
      throw new Error('Base64 vide après nettoyage');
    }
    
    // Ajouter padding si nécessaire
    while (base64Data.length % 4 !== 0) {
      base64Data += '=';
    }
    
    // Décoder
    const buffer = Buffer.from(base64Data, 'base64');
    console.log(`Buffer size: ${buffer.length} bytes`);
    
    if (buffer.length < 100) {
      throw new Error(`Buffer trop petit: ${buffer.length} bytes - Image probablement corrompue`);
    }
    
    // Détecter le type d'image par magic number
    const magic = buffer.slice(0, 8);
    let realType = 'unknown';
    let extension = '.bin';
    
    if (magic[0] === 0x89 && magic[1] === 0x50 && magic[2] === 0x4E && magic[3] === 0x47) {
      realType = 'image/png';
      extension = '.png';
    } else if (magic[0] === 0xFF && magic[1] === 0xD8 && magic[2] === 0xFF) {
      realType = 'image/jpeg';
      extension = '.jpg';
    } else if (magic[0] === 0x47 && magic[1] === 0x49 && magic[2] === 0x46) {
      realType = 'image/gif';
      extension = '.gif';
    } else if (magic[0] === 0x42 && magic[1] === 0x4D) {
      realType = 'image/bmp';
      extension = '.bmp';
    }
    
    console.log(`Magic bytes: ${magic.slice(0, 4).toString('hex')}`);
    console.log(`Detected type: ${realType}`);
    
    // Corriger le nom de fichier avec la bonne extension
    const finalFilename = filename.replace(/\.[^.]+$/, extension);
    const filepath = path.join(imagesDir, finalFilename);
    
    // Sauvegarder
    fs.writeFileSync(filepath, buffer);
    console.log(`✓ Saved: ${finalFilename}`);
    console.log('-------------------\n');
    
    return {
      filepath,
      buffer,
      filename: finalFilename,
      mimeType: realType,
      size: buffer.length
    };
    
  } catch (error) {
    console.error('✗ Decode error:', error.message);
    throw new Error(`Décodage échoué: ${error.message}`);
  }
}

// Route test
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    version: '4.0 - Robust Decoder',
    endpoints: {
      'POST /send-email-base64': 'Envoyer email avec image base64',
      'POST /send-email-with-image': 'Upload fichier',
      'GET /images': 'Liste images',
      'POST /test-decode': 'Tester décodage seul'
    }
  });
});

// Route de test décodage
app.post('/test-decode', async (req, res) => {
  try {
    const { imageBase64, testName } = req.body;
    
    if (!imageBase64) {
      return res.status(400).json({ error: 'imageBase64 requis' });
    }
    
    const filename = testName || `test_${Date.now()}.png`;
    const result = decodeAndSaveImage(imageBase64, filename);
    
    res.json({
      success: true,
      message: 'Image décodée avec succès',
      data: {
        filename: result.filename,
        size: result.size,
        mimeType: result.mimeType,
        path: `/images/${result.filename}`
      }
    });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Route principale EMAIL
app.post('/send-email-base64', async (req, res) => {
  try {
    const { to, subject, message, imageBase64, imageName } = req.body;

    console.log('\n========== NEW EMAIL REQUEST ==========');
    console.log(`To: ${to}`);
    console.log(`Subject: ${subject}`);

    // Validation
    if (!to || !subject || !message) {
      return res.status(400).json({
        success: false,
        error: 'Champs "to", "subject" et "message" requis'
      });
    }

    if (!imageBase64) {
      return res.status(400).json({
        success: false,
        error: 'Champ "imageBase64" requis'
      });
    }

    // Nom de fichier
    const timestamp = Date.now();
    const baseFilename = imageName || `image_${timestamp}.png`;
    
    // Décoder l'image
    const imageData = decodeAndSaveImage(imageBase64, baseFilename);
    
    console.log(`Preparing email...`);
    console.log(`  Attachment: ${imageData.filename} (${imageData.size} bytes)`);
    
    // Email
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
        <body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; background-color: #f5f5f5;">
          <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #f5f5f5; padding: 20px;">
            <tr>
              <td align="center">
                <table width="600" cellpadding="0" cellspacing="0" border="0" style="background-color: white; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.1);">
                  
                  <tr>
                    <td style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 40px 30px; text-align: center;">
                      <h1 style="color: white; margin: 0; font-size: 32px; font-weight: 700; letter-spacing: -0.5px;">${subject}</h1>
                    </td>
                  </tr>
                  
                  <tr>
                    <td style="padding: 40px 35px;">
                      <p style="font-size: 16px; line-height: 1.8; color: #333; margin: 0 0 30px 0; white-space: pre-wrap;">${message}</p>
                      
                      <div style="background: linear-gradient(135deg, #667eea15 0%, #764ba215 100%); border-left: 5px solid #667eea; padding: 25px; border-radius: 8px; margin: 30px 0;">
                        <table width="100%" cellpadding="0" cellspacing="0">
                          <tr>
                            <td width="60" valign="top">
                              <div style="width: 50px; height: 50px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); border-radius: 50%; display: flex; align-items: center; justify-content: center;">
                                <span style="font-size: 24px; color: white;">📎</span>
                              </div>
                            </td>
                            <td valign="top">
                              <h3 style="margin: 0 0 8px 0; font-size: 18px; color: #333; font-weight: 600;">Image jointe</h3>
                              <p style="margin: 0 0 8px 0; font-size: 14px; color: #666; line-height: 1.6;">
                                L'image est disponible en pièce jointe de cet email.
                              </p>
                              <p style="margin: 0; font-size: 13px; color: #999;">
                                <strong>Fichier :</strong> ${imageData.filename}<br>
                                <strong>Taille :</strong> ${(imageData.size / 1024).toFixed(1)} KB<br>
                                <strong>Type :</strong> ${imageData.mimeType.split('/')[1].toUpperCase()}
                              </p>
                            </td>
                          </tr>
                        </table>
                      </div>
                      
                      <div style="background-color: #fffbea; border: 1px solid #ffeaa7; border-radius: 6px; padding: 15px; margin-top: 25px;">
                        <p style="margin: 0; font-size: 13px; color: #7f6e00; line-height: 1.5;">
                          💡 <strong>Astuce :</strong> Cliquez sur la pièce jointe ci-dessus pour ouvrir l'image.
                        </p>
                      </div>
                    </td>
                  </tr>
                  
                  <tr>
                    <td style="background-color: #fafafa; padding: 25px 35px; border-top: 1px solid #e0e0e0;">
                      <table width="100%" cellpadding="0" cellspacing="0">
                        <tr>
                          <td align="center">
                            <p style="margin: 0; font-size: 13px; color: #666; font-weight: 600;">Administration STS</p>
                            <p style="margin: 5px 0 0 0; font-size: 12px; color: #999;">
                              ${new Date().toLocaleDateString('fr-FR', { 
                                weekday: 'long', 
                                year: 'numeric', 
                                month: 'long', 
                                day: 'numeric' 
                              })}
                            </p>
                          </td>
                        </tr>
                      </table>
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
          filename: imageData.filename,
          content: imageData.buffer,
          contentType: imageData.mimeType
        }
      ]
    };

    console.log('Sending email...');
    const info = await transporter.sendMail(mailOptions);

    console.log('✓ EMAIL SENT');
    console.log(`  Message ID: ${info.messageId}`);
    console.log('=====================================\n');

    res.json({
      success: true,
      message: 'Email envoyé avec succès',
      data: {
        messageId: info.messageId,
        image: {
          filename: imageData.filename,
          size: imageData.size,
          type: imageData.mimeType,
          path: imageData.filepath
        },
        recipient: to,
        timestamp: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('✗ ERROR:', error.message);
    console.error('=====================================\n');
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Route upload fichier
app.post('/send-email-with-image', upload.single('image'), async (req, res) => {
  try {
    const { to, subject, message } = req.body;

    if (!to || !subject || !message || !req.file) {
      return res.status(400).json({
        success: false,
        error: 'Champs manquants'
      });
    }

    const imageBuffer = fs.readFileSync(req.file.path);
    const ext = path.extname(req.file.filename).toLowerCase();
    const mimeTypes = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif'
    };

    const mailOptions = {
      from: `"${EMAIL_FROM_NAME}" <${EMAIL_FROM}>`,
      to: to,
      subject: subject,
      html: `<p>${message}</p><p><strong>Image jointe : ${req.file.filename}</strong></p>`,
      attachments: [{
        filename: req.file.filename,
        content: imageBuffer,
        contentType: mimeTypes[ext] || 'application/octet-stream'
      }]
    };

    const info = await transporter.sendMail(mailOptions);

    res.json({
      success: true,
      messageId: info.messageId,
      filename: req.file.filename
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Liste images
app.get('/images', (req, res) => {
  try {
    const files = fs.readdirSync(imagesDir);
    const images = files.filter(f => /\.(jpg|jpeg|png|gif|bmp|webp)$/i.test(f));

    res.json({
      success: true,
      count: images.length,
      images: images.map(img => {
        const stats = fs.statSync(path.join(imagesDir, img));
        return {
          name: img,
          size: stats.size,
          created: stats.birthtime
        };
      })
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Erreurs
app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    return res.status(400).json({ error: error.message });
  }
  res.status(500).json({ error: error.message });
});

// Démarrer
app.listen(PORT, () => {
  console.log('========================================');
  console.log('🚀 Email API v4.0 - Robust Decoder');
  console.log(`📡 Port: ${PORT}`);
  console.log(`📧 SMTP: ${SMTP_HOST}:${SMTP_PORT}`);
  console.log(`📁 Images: ${imagesDir}`);
  console.log('========================================\n');
});
