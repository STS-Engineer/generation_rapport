const express = require('express');
const nodemailer = require('nodemailer');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

/* ========================= CONFIG ========================= */
const SMTP_HOST = "avocarbon-com.mail.protection.outlook.com";
const SMTP_PORT = 25;
const EMAIL_FROM_NAME = "Administration STS";
const EMAIL_FROM = "administration.STS@avocarbon.com";

// Créer le dossier images
const imagesDir = path.join(__dirname, 'images');
if (!fs.existsSync(imagesDir)) {
  fs.mkdirSync(imagesDir, { recursive: true });
}

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Configuration Multer pour upload
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, imagesDir);
  },
  filename: (req, file, cb) => {
    const timestamp = Date.now();
    const randomNum = Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    cb(null, `image_${timestamp}_${randomNum}${ext}`);
  }
});

const upload = multer({
  storage: storage,
  limits: { 
    fileSize: 50 * 1024 * 1024 // 50 MB max
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|bmp|webp/;
    const ext = path.extname(file.originalname).toLowerCase();
    const mime = file.mimetype;
    
    if (allowedTypes.test(ext.substring(1)) && mime.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Seules les images sont autorisées'));
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
transporter.verify((error) => {
  if (error) {
    console.log('✗ SMTP Error:', error.message);
  } else {
    console.log('✓ SMTP Ready');
  }
});

// Route principale
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    version: '6.0 - File Upload Only',
    endpoint: 'POST /send-email',
    method: 'multipart/form-data',
    fields: {
      to: 'string (required) - Email destinataire',
      subject: 'string (required) - Sujet',
      message: 'string (required) - Message',
      image: 'file (required) - Fichier image'
    }
  });
});

// Route d'envoi d'email avec fichier
app.post('/send-email', upload.single('image'), async (req, res) => {
  try {
    console.log('\n========== NOUVELLE REQUÊTE ==========');
    
    const { to, subject, message } = req.body;

    // Validation des champs
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

    console.log(`📧 Destinataire: ${to}`);
    console.log(`📝 Sujet: ${subject}`);
    console.log(`🖼️  Image: ${req.file.filename} (${req.file.size} octets)`);

    // Lire l'image
    const imageBuffer = fs.readFileSync(req.file.path);
    const imageName = req.file.filename;
    const imageMime = req.file.mimetype;

    console.log(`📦 Type MIME: ${imageMime}`);

    // Construction de l'email
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
        <body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;background:#f5f5f5;">
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:20px;">
            <tr>
              <td align="center">
                <table width="600" cellpadding="0" cellspacing="0" style="background:white;border-radius:12px;overflow:hidden;box-shadow:0 4px 12px rgba(0,0,0,0.1);">
                  
                  <!-- Header -->
                  <tr>
                    <td style="background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);padding:40px 30px;text-align:center;">
                      <h1 style="color:white;margin:0;font-size:32px;font-weight:700;">${subject}</h1>
                    </td>
                  </tr>
                  
                  <!-- Message -->
                  <tr>
                    <td style="padding:40px 35px;">
                      <p style="font-size:16px;line-height:1.8;color:#333;margin:0 0 30px 0;white-space:pre-wrap;">${message}</p>
                      
                      <!-- Info image -->
                      <div style="background:linear-gradient(135deg,#667eea15 0%,#764ba215 100%);border-left:5px solid #667eea;padding:25px;border-radius:8px;">
                        <table width="100%" cellpadding="0" cellspacing="0">
                          <tr>
                            <td width="60" valign="top">
                              <div style="width:50px;height:50px;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);border-radius:50%;text-align:center;line-height:50px;">
                                <span style="font-size:24px;">📎</span>
                              </div>
                            </td>
                            <td valign="top">
                              <h3 style="margin:0 0 8px 0;font-size:18px;color:#333;font-weight:600;">Image jointe</h3>
                              <p style="margin:0 0 8px 0;font-size:14px;color:#666;">
                                L'image est disponible en pièce jointe de cet email.
                              </p>
                              <p style="margin:0;font-size:13px;color:#999;">
                                <strong>Fichier:</strong> ${imageName}<br>
                                <strong>Taille:</strong> ${(imageBuffer.length / 1024).toFixed(1)} KB<br>
                                <strong>Type:</strong> ${imageMime.split('/')[1].toUpperCase()}
                              </p>
                            </td>
                          </tr>
                        </table>
                      </div>
                      
                      <!-- Astuce -->
                      <div style="background:#fffbea;border:1px solid #ffeaa7;border-radius:6px;padding:15px;margin-top:25px;">
                        <p style="margin:0;font-size:13px;color:#7f6e00;">
                          💡 <strong>Cliquez sur la pièce jointe ci-dessus pour ouvrir l'image.</strong>
                        </p>
                      </div>
                    </td>
                  </tr>
                  
                  <!-- Footer -->
                  <tr>
                    <td style="background:#fafafa;padding:25px 35px;border-top:1px solid #e0e0e0;text-align:center;">
                      <p style="margin:0;font-size:13px;color:#666;font-weight:600;">Administration STS</p>
                      <p style="margin:5px 0 0 0;font-size:12px;color:#999;">
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
        </body>
        </html>
      `,
      attachments: [
        {
          filename: imageName,
          content: imageBuffer,
          contentType: imageMime
        }
      ]
    };

    // Envoi de l'email
    console.log('📤 Envoi en cours...');
    const info = await transporter.sendMail(mailOptions);

    console.log('✅ EMAIL ENVOYÉ');
    console.log(`   Message ID: ${info.messageId}`);
    console.log('======================================\n');

    res.json({
      success: true,
      message: 'Email envoyé avec succès',
      data: {
        messageId: info.messageId,
        image: {
          filename: imageName,
          size: imageBuffer.length,
          type: imageMime,
          path: `/images/${imageName}`
        },
        recipient: to,
        timestamp: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('❌ ERREUR:', error.message);
    console.error('======================================\n');
    
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
    const images = files.filter(f => 
      /\.(jpg|jpeg|png|gif|bmp|webp)$/i.test(f)
    );

    const imageList = images.map(img => {
      const stats = fs.statSync(path.join(imagesDir, img));
      return {
        name: img,
        size: stats.size,
        sizeKB: (stats.size / 1024).toFixed(1),
        created: stats.birthtime
      };
    });

    res.json({
      success: true,
      count: images.length,
      totalSize: imageList.reduce((sum, img) => sum + img.size, 0),
      images: imageList
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

// Gestion des erreurs Multer
app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        success: false,
        error: 'Fichier trop volumineux (max 50MB)'
      });
    }
    return res.status(400).json({
      success: false,
      error: error.message
    });
  }
  
  if (error.message === 'Seules les images sont autorisées') {
    return res.status(400).json({
      success: false,
      error: error.message
    });
  }
  
  res.status(500).json({
    success: false,
    error: error.message
  });
});

// Démarrer le serveur
app.listen(PORT, () => {
  console.log('========================================');
  console.log('🚀 Email API v6.0 - File Upload Only');
  console.log(`📡 Port: ${PORT}`);
  console.log(`📧 SMTP: ${SMTP_HOST}:${SMTP_PORT}`);
  console.log(`📁 Images: ${imagesDir}`);
  console.log('========================================\n');
});
