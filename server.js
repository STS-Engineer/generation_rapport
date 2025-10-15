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

// Créer le dossier images
const imagesDir = path.join(__dirname, 'images');
if (!fs.existsSync(imagesDir)) {
  fs.mkdirSync(imagesDir, { recursive: true });
}

// Middleware
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
  limits: { fileSize: 50 * 1024 * 1024 }
});

// Configuration SMTP
const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: false,
  tls: { rejectUnauthorized: false }
});

transporter.verify((error) => {
  if (error) {
    console.log('✗ SMTP Error:', error.message);
  } else {
    console.log('✓ SMTP Ready');
  }
});

// Fonction pour télécharger une image depuis URL
function downloadImageFromURL(url) {
  return new Promise((resolve, reject) => {
    console.log(`Downloading from: ${url}`);
    
    const protocol = url.startsWith('https') ? https : http;
    
    protocol.get(url, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`));
        return;
      }
      
      const chunks = [];
      
      response.on('data', (chunk) => {
        chunks.push(chunk);
      });
      
      response.on('end', () => {
        const buffer = Buffer.concat(chunks);
        console.log(`Downloaded: ${buffer.length} bytes`);
        resolve(buffer);
      });
      
    }).on('error', (err) => {
      reject(err);
    });
  });
}

// Fonction de décodage base64 robuste
function decodeBase64Image(base64String) {
  try {
    console.log(`\n--- DÉCODAGE BASE64 ---`);
    console.log(`Input: ${base64String.length} chars`);
    
    let base64Data = base64String;
    let detectedMime = 'image/png';
    
    // Extraire MIME
    if (base64String.startsWith('data:')) {
      const matches = base64String.match(/^data:([^;]+);base64,(.*)$/);
      if (matches) {
        detectedMime = matches[1];
        base64Data = matches[2];
        console.log(`MIME: ${detectedMime}`);
      }
    } else if (base64String.includes('base64,')) {
      base64Data = base64String.split('base64,')[1];
    }
    
    // Nettoyage
    base64Data = base64Data.replace(/[^A-Za-z0-9+/=]/g, '');
    
    // Padding
    while (base64Data.length % 4 !== 0) {
      base64Data += '=';
    }
    
    console.log(`Cleaned: ${base64Data.length} chars`);
    
    const buffer = Buffer.from(base64Data, 'base64');
    console.log(`Buffer: ${buffer.length} bytes`);
    
    if (buffer.length < 100) {
      throw new Error(`Image trop petite: ${buffer.length} bytes - CORROMPUE`);
    }
    
    // Détecter type
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
    
    console.log(`Type: ${realType} (${extension})`);
    console.log(`Magic: ${magic.slice(0, 4).toString('hex')}`);
    console.log(`-----------------------\n`);
    
    return { buffer, mimeType: realType, extension };
    
  } catch (error) {
    console.error('✗ Décodage échoué:', error.message);
    throw error;
  }
}

// Détecter le type d'image depuis buffer
function detectImageType(buffer) {
  const magic = buffer.slice(0, 8);
  
  if (magic[0] === 0x89 && magic[1] === 0x50 && magic[2] === 0x4E && magic[3] === 0x47) {
    return { mimeType: 'image/png', extension: '.png' };
  } else if (magic[0] === 0xFF && magic[1] === 0xD8 && magic[2] === 0xFF) {
    return { mimeType: 'image/jpeg', extension: '.jpg' };
  } else if (magic[0] === 0x47 && magic[1] === 0x49 && magic[2] === 0x46) {
    return { mimeType: 'image/gif', extension: '.gif' };
  } else if (magic[0] === 0x42 && magic[1] === 0x4D) {
    return { mimeType: 'image/bmp', extension: '.bmp' };
  } else if (magic[0] === 0x52 && magic[1] === 0x49 && magic[2] === 0x46 && magic[3] === 0x46) {
    return { mimeType: 'image/webp', extension: '.webp' };
  }
  
  return { mimeType: 'application/octet-stream', extension: '.bin' };
}

// Route test
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    version: '5.0 - Multi-Input Support',
    endpoints: {
      'POST /send-email': 'Envoyer email (base64, URL ou file)',
      'POST /test-decode': 'Tester décodage',
      'GET /images': 'Liste images'
    },
    supportedInputs: [
      'imageBase64: Image en base64',
      'imageUrl: URL de l\'image à télécharger',
      'image: Upload fichier multipart'
    ]
  });
});

// Route TEST décodage
app.post('/test-decode', async (req, res) => {
  try {
    const { imageBase64, imageUrl } = req.body;
    
    let buffer, mimeType, extension;
    
    if (imageBase64) {
      const result = decodeBase64Image(imageBase64);
      buffer = result.buffer;
      mimeType = result.mimeType;
      extension = result.extension;
    } else if (imageUrl) {
      buffer = await downloadImageFromURL(imageUrl);
      const detected = detectImageType(buffer);
      mimeType = detected.mimeType;
      extension = detected.extension;
    } else {
      return res.status(400).json({ error: 'imageBase64 ou imageUrl requis' });
    }
    
    const filename = `test_${Date.now()}${extension}`;
    const filepath = path.join(imagesDir, filename);
    fs.writeFileSync(filepath, buffer);
    
    res.json({
      success: true,
      message: 'Image décodée et sauvegardée',
      data: {
        filename,
        size: buffer.length,
        mimeType,
        path: `/images/${filename}`
      }
    });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Route PRINCIPALE - Support multiple formats
app.post('/send-email', upload.single('image'), async (req, res) => {
  try {
    const { to, subject, message, imageBase64, imageUrl, imageName } = req.body;

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

    let imageBuffer, imageMimeType, imageExtension, finalFilename;
    const timestamp = Date.now();

    // Déterminer la source de l'image
    if (req.file) {
      // Upload fichier
      console.log('Source: File upload');
      imageBuffer = fs.readFileSync(req.file.path);
      const detected = detectImageType(imageBuffer);
      imageMimeType = detected.mimeType;
      imageExtension = detected.extension;
      finalFilename = req.file.filename;
      
    } else if (imageUrl) {
      // URL
      console.log('Source: URL');
      imageBuffer = await downloadImageFromURL(imageUrl);
      const detected = detectImageType(imageBuffer);
      imageMimeType = detected.mimeType;
      imageExtension = detected.extension;
      finalFilename = `image_${timestamp}${imageExtension}`;
      
      // Sauvegarder
      const filepath = path.join(imagesDir, finalFilename);
      fs.writeFileSync(filepath, imageBuffer);
      
    } else if (imageBase64) {
      // Base64
      console.log('Source: Base64');
      const decoded = decodeBase64Image(imageBase64);
      imageBuffer = decoded.buffer;
      imageMimeType = decoded.mimeType;
      imageExtension = decoded.extension;
      finalFilename = imageName 
        ? imageName.replace(/\.[^.]+$/, imageExtension)
        : `image_${timestamp}${imageExtension}`;
      
      // Sauvegarder
      const filepath = path.join(imagesDir, finalFilename);
      fs.writeFileSync(filepath, imageBuffer);
      
    } else {
      return res.status(400).json({
        success: false,
        error: 'Vous devez fournir: imageBase64, imageUrl, ou upload un fichier'
      });
    }

    console.log(`Image prête: ${finalFilename} (${imageBuffer.length} bytes, ${imageMimeType})`);

    // Vérification taille
    if (imageBuffer.length < 100) {
      throw new Error(`Image corrompue: seulement ${imageBuffer.length} bytes`);
    }

    // Construction email
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
        <body style="margin:0;padding:0;font-family:Arial,sans-serif;background:#f5f5f5;">
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:20px;">
            <tr>
              <td align="center">
                <table width="600" cellpadding="0" cellspacing="0" style="background:white;border-radius:12px;overflow:hidden;box-shadow:0 4px 12px rgba(0,0,0,0.1);">
                  
                  <tr>
                    <td style="background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);padding:40px 30px;text-align:center;">
                      <h1 style="color:white;margin:0;font-size:32px;font-weight:700;">${subject}</h1>
                    </td>
                  </tr>
                  
                  <tr>
                    <td style="padding:40px 35px;">
                      <p style="font-size:16px;line-height:1.8;color:#333;margin:0 0 30px 0;white-space:pre-wrap;">${message}</p>
                      
                      <div style="background:linear-gradient(135deg,#667eea15 0%,#764ba215 100%);border-left:5px solid #667eea;padding:25px;border-radius:8px;margin:30px 0;">
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
                                L'image est disponible en pièce jointe.
                              </p>
                              <p style="margin:0;font-size:13px;color:#999;">
                                <strong>Fichier:</strong> ${finalFilename}<br>
                                <strong>Taille:</strong> ${(imageBuffer.length / 1024).toFixed(1)} KB<br>
                                <strong>Type:</strong> ${imageMimeType.split('/')[1].toUpperCase()}
                              </p>
                            </td>
                          </tr>
                        </table>
                      </div>
                      
                      <div style="background:#fffbea;border:1px solid #ffeaa7;border-radius:6px;padding:15px;margin-top:25px;">
                        <p style="margin:0;font-size:13px;color:#7f6e00;">
                          💡 <strong>Cliquez sur la pièce jointe ci-dessus pour ouvrir l'image.</strong>
                        </p>
                      </div>
                    </td>
                  </tr>
                  
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
          filename: finalFilename,
          content: imageBuffer,
          contentType: imageMimeType
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
          filename: finalFilename,
          size: imageBuffer.length,
          type: imageMimeType
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
      error: error.message,
      details: error.stack
    });
  }
});

// Alias pour compatibilité
app.post('/send-email-base64', (req, res, next) => {
  req.body.imageBase64 = req.body.imageBase64 || req.body.image;
  next();
}, upload.none(), async (req, res) => {
  const handler = app._router.stack.find(r => r.route && r.route.path === '/send-email');
  handler.route.stack[0].handle(req, res);
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
          sizeKB: (stats.size / 1024).toFixed(1),
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
  res.status(500).json({ error: error.message });
});

// Démarrer
app.listen(PORT, () => {
  console.log('========================================');
  console.log('🚀 Email API v5.0 - Multi-Input');
  console.log(`📡 Port: ${PORT}`);
  console.log(`📧 SMTP: ${SMTP_HOST}:${SMTP_PORT}`);
  console.log(`📁 Images: ${imagesDir}`);
  console.log('========================================\n');
});
