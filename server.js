const express = require('express');
const nodemailer = require('nodemailer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

/* ========================= CONFIGURATION ========================= */
const SMTP_HOST = "avocarbon-com.mail.protection.outlook.com";
const SMTP_PORT = 25;
const EMAIL_FROM_NAME = "Administration STS";
const EMAIL_FROM = "administration.STS@avocarbon.com";

// Créer le dossier images s'il n'existe pas
const imagesDir = path.join(__dirname, 'images');
if (!fs.existsSync(imagesDir)) {
  fs.mkdirSync(imagesDir, { recursive: true });
  console.log('✅ Dossier images créé');
}

// ========================= MIDDLEWARE =========================
app.use(express.json({ limit: '150mb' }));
app.use(express.urlencoded({ extended: true, limit: '150mb', parameterLimit: 100000 }));
app.use('/images', express.static(imagesDir));

// ========================= SMTP CONFIGURATION =========================
const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: false,
  tls: {
    rejectUnauthorized: false
  }
});

// ========================= ROUTES =========================

// Route: Vérifier l'état du serveur
app.get('/', (req, res) => {
  res.json({
    message: '✅ API Email avec Base64 - Serveur actif',
    version: '6.0.0',
    method: 'Base64 Encoding/Decoding',
    endpoint: 'POST /send-email-base64',
    parameters: {
      to: 'majed.messai@avocarbon.com',
      subject: 'mejed',
      message: 'mejed123',
      image: 'image encodée en base64 (complet)',
      imageName: 'nom du fichier'
    },
    status: 'Running'
  });
});

// ========================= FONCTION: Décoder et envoyer email =========================
async function decodeAndSendEmail(base64String, imageName, to, subject, message) {
  try {
    console.log('1️⃣ Début du décodage base64...');
    
    // 1. Nettoyer le base64 (supprimer le préfixe data: si présent)
    let cleanBase64 = base64String;
    if (base64String.includes(',')) {
      cleanBase64 = base64String.split(',')[1];
      console.log('   ℹ️  Préfixe data: supprimé');
    }
    
    // 2. Décoder le base64 en binaire
    let imageBuffer;
    try {
      imageBuffer = Buffer.from(cleanBase64, 'base64');
      console.log(`   ✅ Base64 décodé: ${imageBuffer.length} octets`);
    } catch (error) {
      throw new Error(`Erreur lors du décodage base64: ${error.message}`);
    }

    // 3. Vérifier que le fichier n'est pas vide
    if (imageBuffer.length === 0) {
      throw new Error('L\'image décodée est vide (0 octets)');
    }

    // 4. Générer un nom de fichier unique
    console.log('2️⃣ Génération du nom de fichier...');
    const timestamp = Date.now();
    const randomNum = Math.round(Math.random() * 1E9);
    const extension = path.extname(imageName);
    const filename = `image_${timestamp}_${randomNum}${extension}`;
    const filepath = path.join(imagesDir, filename);
    console.log(`   ✅ Nom généré: ${filename}`);

    // 5. Sauvegarder l'image sur le serveur
    console.log('3️⃣ Sauvegarde de l\'image...');
    fs.writeFileSync(filepath, imageBuffer);
    console.log(`   ✅ Image sauvegardée: ${filepath}`);
    console.log(`   📊 Taille: ${imageBuffer.length} octets (${(imageBuffer.length / 1024).toFixed(2)} KB)`);

    // 6. Déterminer le type MIME
    console.log('4️⃣ Détermination du type MIME...');
    const ext = extension.toLowerCase();
    const mimeTypes = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.bmp': 'image/bmp'
    };
    const mimeType = mimeTypes[ext] || 'image/jpeg';
    console.log(`   ✅ Type MIME: ${mimeType}`);

    // 7. Préparer le contenu HTML de l'email
    console.log('5️⃣ Préparation du template email...');
    const htmlContent = `
      <html>
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
        </head>
        <body style="font-family: Arial, sans-serif; margin: 0; padding: 0; background-color: #f9f9f9;">
          <div style="padding: 20px; max-width: 600px; margin: 0 auto;">
            
            <!-- Header avec titre -->
            <div style="border-bottom: 3px solid #007bff; padding: 15px; margin-bottom: 20px; background-color: white; border-radius: 8px;">
              <h2 style="color: #333; margin: 0; font-size: 24px;">${subject}</h2>
            </div>
            
            <!-- Message principal -->
            <div style="background-color: white; padding: 20px; border-radius: 8px; margin-bottom: 20px;">
              <p style="font-size: 15px; line-height: 1.8; color: #555; margin: 0;">
                ${message}
              </p>
            </div>

            <!-- Information sur la pièce jointe -->
            <div style="background-color: white; padding: 20px; border-radius: 8px; margin-bottom: 20px; border: 1px solid #ddd;">
              <p style="font-size: 14px; color: #666; margin: 0;">
                📎 <strong>Image jointe:</strong> ${filename}
              </p>
            </div>

            <!-- Footer -->
            <div style="border-top: 2px solid #eee; padding-top: 15px; margin-top: 30px; text-align: center; background-color: white; padding: 15px; border-radius: 8px;">
              <p style="font-size: 12px; color: #999; margin: 0;">
                📧 Email envoyé via API Administration STS<br>
                ⏰ ${new Date().toLocaleString('fr-FR')}
              </p>
            </div>
            
          </div>
        </body>
      </html>
    `;
    console.log('   ✅ Template prêt');

    // 8. Préparer l'email avec pièce jointe
    console.log('6️⃣ Préparation de l\'email...');
    const mailOptions = {
      from: `"${EMAIL_FROM_NAME}" <${EMAIL_FROM}>`,
      to: to,
      subject: subject,
      html: htmlContent,
      attachments: [
        {
          filename: filename,
          content: imageBuffer,
          contentType: mimeType
        }
      ]
    };
    console.log('   ✅ Email préparé');

    // 9. Envoyer l'email
    console.log('7️⃣ Envoi de l\'email via SMTP...');
    const info = await transporter.sendMail(mailOptions);
    console.log(`   ✅ Email envoyé!`);
    console.log(`   📧 Message ID: ${info.messageId}`);

    return {
      success: true,
      messageId: info.messageId,
      image: {
        filename: filename,
        size: imageBuffer.length,
        type: mimeType,
        path: `/images/${filename}`
      },
      recipient: to,
      timestamp: new Date().toISOString()
    };

  } catch (error) {
    console.error('❌ Erreur:', error.message);
    throw error;
  }
}

// ========================= ROUTE: Envoyer email avec base64 =========================
app.post('/send-email-base64', async (req, res) => {
  try {
    const { to, subject, message, image, imageName } = req.body;

    console.log('========================================');
    console.log('📧 NOUVELLE REQUÊTE: /send-email-base64');
    console.log('========================================');
    console.log('Destinataire:', to);
    console.log('Sujet:', subject);
    console.log('Message:', message);
    console.log('Nom fichier:', imageName);
    console.log('Base64 reçu - Longueur:', image ? image.length : 0, 'caractères');
    if (image) {
      console.log('Base64 - Début:', image.substring(0, 50));
      console.log('Base64 - Fin:', image.substring(Math.max(0, image.length - 50)));
    }
    console.log('========================================');

    // ========== VALIDATION ==========
    if (!to) {
      console.error('❌ Erreur: to manquant');
      return res.status(400).json({
        success: false,
        error: 'Le champ "to" (email) est requis'
      });
    }

    if (!subject) {
      console.error('❌ Erreur: subject manquant');
      return res.status(400).json({
        success: false,
        error: 'Le champ "subject" est requis'
      });
    }

    if (!message) {
      console.error('❌ Erreur: message manquant');
      return res.status(400).json({
        success: false,
        error: 'Le champ "message" est requis'
      });
    }

    if (!image) {
      console.error('❌ Erreur: image (base64) manquante');
      return res.status(400).json({
        success: false,
        error: 'Le champ "image" (base64) est requis'
      });
    }

    if (!imageName) {
      console.error('❌ Erreur: imageName manquant');
      return res.status(400).json({
        success: false,
        error: 'Le champ "imageName" est requis (ex: photo.jpg)'
      });
    }

    // ========== DÉCODER ET ENVOYER ==========
    const result = await decodeAndSendEmail(
      image,
      imageName,
      to,
      subject,
      message
    );

    // ========== RÉPONSE SUCCÈS ==========
    console.log('========================================');
    console.log('✅ SUCCÈS TOTAL!');
    console.log('========================================');
    
    res.json({
      success: true,
      message: 'Email envoyé avec succès',
      data: result
    });

  } catch (error) {
    console.error('========================================');
    console.error('❌ ERREUR LORS DE L\'ENVOI');
    console.error('========================================');
    console.error('Détails:', error.message);
    console.error('========================================');
    
    res.status(500).json({
      success: false,
      error: 'Erreur lors de l\'envoi de l\'email',
      details: error.message
    });
  }
});

// ========================= ROUTE: Lister les images =========================
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
        sizeMB: (stats.size / (1024 * 1024)).toFixed(2),
        created: stats.birthtime
      };
    });

    const totalSize = imageDetails.reduce((sum, img) => sum + img.size, 0);

    res.json({
      success: true,
      count: images.length,
      totalSize: totalSize,
      totalSizeKB: (totalSize / 1024).toFixed(2),
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

// ========================= GESTION DES ERREURS =========================
app.use((error, req, res, next) => {
  console.error('🚨 Erreur middleware:', error.message);
  
  res.status(500).json({
    success: false,
    error: error.message || 'Erreur serveur'
  });
});

// ========================= DÉMARRER LE SERVEUR =========================
app.listen(PORT, () => {
  console.log('========================================');
  console.log('🚀 SERVEUR DÉMARRÉ AVEC SUCCÈS!');
  console.log('========================================');
  console.log(`📍 Port: ${PORT}`);
  console.log(`📧 SMTP: ${SMTP_HOST}:${SMTP_PORT}`);
  console.log(`📁 Dossier images: ${imagesDir}`);
  console.log(`✉️  Email FROM: ${EMAIL_FROM}`);
  console.log('');
  console.log('🔗 ENDPOINTS:');
  console.log('   1. GET  / - Vérifier l\'état');
  console.log('   2. POST /send-email-base64 - Envoyer email');
  console.log('   3. GET  /images-list - Lister les images');
  console.log('');
  console.log('📝 FORMAT:');
  console.log('   Content-Type: application/json');
  console.log('   Method: Base64 + Decode');
  console.log('');
  console.log('🖼️ IMAGE:');
  console.log('   - Encodée en base64 par le GPT');
  console.log('   - Décodée par le serveur');
  console.log('   - Sauvegardée sur Azure');
  console.log('   - Envoyée en pièce jointe');
  console.log('========================================');
});
