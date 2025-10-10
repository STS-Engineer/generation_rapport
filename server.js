# server.py — Support Orchestrator API (FastAPI, Python)
# - Enregistre en PostgreSQL: username, assistant_name, comment, created_at
# - Génère un PDF SANS images (ReportLab)
# - Envoie l'e-mail (O365 AUTH 587 par défaut) en From: Administration STS <administration.STS@avocarbon.com>
# - /health robuste (ne plante pas si DB/ReportLab posent problème)
# - Endpoints:
#   GET  /health
#   GET  /
#   POST /api/echo
#   POST /api/support            (enregistre)
#   GET  /api/support            (liste)
#   GET  /api/support/{assistant_name}  (filtre)
#   POST /api/support/submit-and-email  (enregistre + PDF + e-mail)
#   OPTIONS/GET /api/support/submit-and-email (aide CORS / erreurs 405)
#   GET  /debug/mail-config
#   POST /debug/send-test-email  (envoi test)

import os
import io
import logging
import datetime
import smtplib
from email.message import EmailMessage
from typing import List, Optional

from fastapi import FastAPI, HTTPException, Body, Response, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# ========================= LOGGING =========================
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("support-server")

# ========================= CONFIG DB =========================
PG_HOST = os.getenv("PG_HOST", "avo-adb-001.postgres.database.azure.com")
PG_PORT = int(os.getenv("PG_PORT", "5432"))
PG_DB   = os.getenv("PG_DB", "gpt_support")
PG_USER = os.getenv("PG_USER", "adminavo")
PG_PASS = os.getenv("PG_PASS", "$#fKcdXPg4@ue8AW")
PG_SSLMODE = os.getenv("PG_SSLMODE", "require")  # Azure -> SSL

# ========================= CONFIG SMTP =========================
# Deux modes:
# - O365_AUTH (recommandé): smtp.office365.com:587 + STARTTLS + LOGIN
# - ANON_25 (non recommandé sur App Service): relais EOP sans auth (souvent bloqué)
SMTP_MODE = os.getenv("SMTP_MODE", "O365_AUTH")  # "O365_AUTH" ou "ANON_25"

if SMTP_MODE == "O365_AUTH":
    SMTP_HOST = os.getenv("SMTP_HOST", "smtp.office365.com")
    SMTP_PORT = int(os.getenv("SMTP_PORT", "587"))
    SMTP_USERNAME = os.getenv("SMTP_USERNAME", "administration.STS@avocarbon.com")
    SMTP_PASSWORD = os.getenv("SMTP_PASSWORD", "")
else:
    SMTP_HOST = os.getenv("SMTP_HOST", "avocarbon-com.mail.protection.outlook.com")
    SMTP_PORT = int(os.getenv("SMTP_PORT", "25"))
    SMTP_USERNAME = ""
    SMTP_PASSWORD = ""

EMAIL_FROM_NAME = os.getenv("EMAIL_FROM_NAME", "Administration STS")
EMAIL_FROM = os.getenv("EMAIL_FROM", "administration.STS@avocarbon.com")  # expéditeur affiché
DEFAULT_RECIPIENT = os.getenv("DEFAULT_RECIPIENT", "majed.messai@avocarbon.com")

# ========================= REPORTLAB (robuste) =========================
REPORTLAB_OK = True
try:
    from reportlab.lib.pagesizes import A4
    from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.lib import colors
except Exception as e:
    REPORTLAB_OK = False
    REPORTLAB_IMPORT_ERROR = str(e)

# ========================= POSTGRES =========================
import psycopg2
from psycopg2.extras import RealDictCursor

def get_connection():
    return psycopg2.connect(
        host=PG_HOST, port=PG_PORT, dbname=PG_DB,
        user=PG_USER, password=PG_PASS, sslmode=PG_SSLMODE
    )

def init_db():
    sql = """
    CREATE TABLE IF NOT EXISTS public.support_comments (
        id SERIAL PRIMARY KEY,
        username VARCHAR(255) NOT NULL,
        assistant_name VARCHAR(255) NOT NULL,
        comment TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    """
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(sql)
        conn.commit()
    logger.info("Table support_comments OK")

def save_support_comment(username: str, assistant_name: str, comment: str) -> int:
    sql = """
    INSERT INTO public.support_comments (username, assistant_name, comment)
    VALUES (%s, %s, %s) RETURNING id;
    """
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, (username, assistant_name, comment))
            new_id = cur.fetchone()[0]
        conn.commit()
    return new_id

def get_all_comments() -> List[dict]:
    sql = """
    SELECT id, username, assistant_name, comment, created_at
    FROM public.support_comments
    ORDER BY created_at DESC, id DESC;
    """
    with get_connection() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(sql)
            rows = cur.fetchall()
    return [dict(r) for r in rows]

def get_comments_by_assistant(assistant_name: str) -> List[dict]:
    sql = """
    SELECT id, username, assistant_name, comment, created_at
    FROM public.support_comments
    WHERE assistant_name = %s
    ORDER BY created_at DESC, id DESC;
    """
    with get_connection() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(sql, (assistant_name,))
            rows = cur.fetchall()
    return [dict(r) for r in rows]

# ========================= FASTAPI =========================
app = FastAPI(title="Support Orchestrator API (Python)", version="5.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # restreindre si besoin
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ========================= MODELS =========================
class SupportComment(BaseModel):
    username: str
    comment: str
    assistant_name: str

class SubmitAndEmailRequest(BaseModel):
    username: str
    assistant_name: str
    comment: str

# ========================= STARTUP =========================
@app.on_event("startup")
async def startup_event():
    try:
        init_db()
        app.state.init_db_error = None
    except Exception as e:
        app.state.init_db_error = str(e)
        logger.exception("init_db failed")

# ========================= PDF (SANS images) =========================
def build_pdf_bytes(*, username: str, assistant_name: str, comment: str, subject_local: str) -> bytes:
    if not REPORTLAB_OK:
        raise RuntimeError(f"reportlab_missing: {REPORTLAB_IMPORT_ERROR}")

    buffer = io.BytesIO()
    doc = SimpleDocTemplate(buffer, pagesize=A4, leftMargin=36, rightMargin=36, topMargin=40, bottomMargin=40)

    styles = getSampleStyleSheet()
    title_style = ParagraphStyle("Title", parent=styles["Title"], textColor=colors.HexColor("#1e40af"))
    h_style = ParagraphStyle("Heading", parent=styles["Heading2"], textColor=colors.HexColor("#1e40af"))
    p_style = ParagraphStyle("Body", parent=styles["BodyText"], leading=14)

    story = []
    story.append(Paragraph(f"Ticket Support — {assistant_name}", title_style))
    story.append(Spacer(1, 8))
    story.append(Table(
        [[Paragraph(subject_local, styles["BodyText"])]],
        style=TableStyle([
            ("BACKGROUND", (0,0), (-1,-1), colors.HexColor("#e0e7ff")),
            ("BOX", (0,0), (-1,-1), 1, colors.HexColor("#3b82f6")),
            ("LEFTPADDING", (0,0), (-1,-1), 8),
            ("RIGHTPADDING",(0,0), (-1,-1), 8),
            ("TOPPADDING",  (0,0), (-1,-1), 6),
            ("BOTTOMPADDING",(0,0), (-1,-1), 6),
        ])
    ))
    story.append(Spacer(1, 12))

    now_str = datetime.datetime.now().strftime("%d/%m/%Y %H:%M")
    story.append(Paragraph("Introduction", h_style))
    story.append(Spacer(1, 4))
    intro = f"Votre message a été reçu le {now_str}. Ce document résume la demande saisie via l’assistant « {assistant_name} »."
    story.append(Paragraph(intro, p_style))
    story.append(Spacer(1, 12))

    story.append(Paragraph("Résumé du ticket", h_style))
    story.append(Spacer(1, 4))
    resume = (
        f"• <b>Utilisateur</b> : {username}<br/>"
        f"• <b>Assistant</b> : {assistant_name}<br/>"
        f"• <b>Date</b> : {now_str}"
    )
    story.append(Paragraph(resume, p_style))
    story.append(Spacer(1, 12))

    story.append(Paragraph("Commentaire", h_style))
    story.append(Spacer(1, 4))
    story.append(Paragraph((comment or "(vide)").replace("\n", "<br/>"), p_style))
    story.append(Spacer(1, 16))

    story.append(Paragraph("Conclusion", h_style))
    story.append(Spacer(1, 4))
    concl = "Notre équipe de support analysera ce ticket et reviendra vers vous dans les meilleurs délais. Merci pour votre retour."
    story.append(Paragraph(concl, p_style))

    doc.build(story)
    return buffer.getvalue()

# ========================= EMAIL =========================
def send_email_with_pdf(*, to: str, subject: str, html_body: str, pdf_bytes: bytes, pdf_filename: str) -> str:
    """
    Envoie l'e-mail et retourne le Message-Id si disponible.
    """
    if not to:
        raise ValueError("Destinataire manquant")

    msg = EmailMessage()
    msg["From"] = f"{EMAIL_FROM_NAME} <{EMAIL_FROM}>"
    msg["To"] = to
    msg["Subject"] = subject
    msg.set_content("Votre ticket support est joint en PDF.")
    msg.add_alternative(html_body, subtype="html")
    msg.add_attachment(pdf_bytes, maintype="application", subtype="pdf", filename=pdf_filename)

    # Sauvegarde .eml (debug)
    try:
        os.makedirs("outbox", exist_ok=True)
        eml_name = f"{datetime.datetime.utcnow().strftime('%Y%m%d_%H%M%S')}_{subject.replace(' ', '_')}.eml"
        with open(os.path.join("outbox", eml_name), "wb") as f:
            f.write(bytes(msg))
    except Exception as e:
        logger.warning(f"EML non sauvegardé: {e}")

    if SMTP_MODE == "O365_AUTH":
        logger.info(f"SMTP AUTH → {SMTP_HOST}:{SMTP_PORT} as {SMTP_USERNAME}")
        with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=30) as s:
            s.set_debuglevel(1)  # logs SMTP
            s.ehlo()
            s.starttls()
            s.ehlo()
            s.login(SMTP_USERNAME, SMTP_PASSWORD)
            s.send_message(msg)
    else:
        logger.info(f"SMTP ANON 25 → {SMTP_HOST}:{SMTP_PORT}")
        with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=30) as s:
            s.set_debuglevel(1)
            s.ehlo()
            s.send_message(msg)

    return msg.get("Message-Id", "")

# ========================= ROUTES SERVICE =========================
@app.get("/")
async def root():
    return {
        "name": "Support Orchestrator API (Python)",
        "version": "5.0.0",
        "status": "running",
        "db": {"host": PG_HOST, "db": PG_DB, "user": PG_USER},
        "smtp": {"mode": SMTP_MODE, "host": SMTP_HOST, "port": SMTP_PORT, "from": EMAIL_FROM},
        "default_recipient": DEFAULT_RECIPIENT,
        "init_db_error": getattr(app.state, "init_db_error", None),
        "reportlab_ok": REPORTLAB_OK
    }

@app.get("/health")
async def health_check():
    return {
        "status": "ok",
        "time": datetime.datetime.utcnow().isoformat() + "Z",
        "reportlab_ok": REPORTLAB_OK,
        "reportlab_error": (REPORTLAB_IMPORT_ERROR if not REPORTLAB_OK else None),
        "init_db_error": getattr(app.state, "init_db_error", None),
        "smtp_mode": SMTP_MODE,
        "smtp_host": SMTP_HOST,
        "smtp_port": SMTP_PORT
    }

@app.post("/api/echo")
async def echo(body: Optional[dict] = Body(default=None)):
    return {"ok": True, "got": body or {}}

# ========================= CRUD LECTURE =========================
@app.get("/api/support")
async def get_all_support_comments_route():
    try:
        return {"success": True, "comments": get_all_comments()}
    except Exception as e:
        logger.exception("get_all_support_comments error")
        raise HTTPException(status_code=500, detail=f"Erreur lors de la récupération: {str(e)}")

@app.get("/api/support/{assistant_name}")
async def get_support_comments_by_assistant_route(assistant_name: str):
    try:
        return {"success": True, "assistant_name": assistant_name, "comments": get_comments_by_assistant(assistant_name.strip())}
    except Exception as e:
        logger.exception("get_support_comments_by_assistant error")
        raise HTTPException(status_code=500, detail=f"Erreur lors de la récupération: {str(e)}")

@app.post("/api/support")
async def create_support_comment_route(comment: SupportComment):
    try:
        new_id = save_support_comment(
            username=comment.username.strip(),
            assistant_name=comment.assistant_name.strip(),
            comment=comment.comment,
        )
        return {"success": True, "message": "Commentaire enregistré avec succès", "comment_id": new_id}
    except Exception as e:
        logger.exception("create_support_comment error")
        raise HTTPException(status_code=500, detail=f"Erreur lors de l'enregistrement: {str(e)}")

# ========================= ORCHESTRATEUR =========================
# (handlers GET/OPTIONS pour éviter 405 si un proxy teste la route)
@app.options("/api/support/submit-and-email")
async def submit_support_and_email_options():
    return Response(status_code=204)

@app.get("/api/support/submit-and-email")
async def submit_support_and_email_get():
    return {
        "ok": False,
        "hint": "Use POST with JSON body { username, assistant_name, comment } on this endpoint.",
        "example": {
            "username": "Utilisateur",
            "assistant_name": "rapport gpt",
            "comment": "le rapport est vide"
        }
    }

class SubmitAndEmailRequest(BaseModel):
    username: str
    assistant_name: str
    comment: str

@app.post("/api/support/submit-and-email")
async def submit_support_and_email(payload: SubmitAndEmailRequest = Body(...)):
    """
    1) Enregistre le commentaire
    2) Génère un PDF SANS images
    3) Envoie un e-mail From: Administration STS <administration.STS@avocarbon.com>
       au destinataire DEFAULT_RECIPIENT
    """
    try:
        # (1) DB
        comment_id = save_support_comment(
            username=payload.username.strip(),
            assistant_name=payload.assistant_name.strip(),
            comment=payload.comment,
        )

        # Sujet auto (côté serveur)
        subject_local = f"Ticket Support — {payload.assistant_name.strip()}"

        # (2) PDF
        pdf_bytes = build_pdf_bytes(
            username=payload.username.strip(),
            assistant_name=payload.assistant_name.strip(),
            comment=payload.comment,
            subject_local=subject_local
        )
        pdf_filename = f"ticket_support_{payload.assistant_name.strip().lower().replace(' ', '_')}_{int(datetime.datetime.now().timestamp())}.pdf"

        # (3) Email
        html = f"""
        <!DOCTYPE html>
        <html>
          <body style="font-family: Arial, sans-serif; line-height:1.6; color:#111827;">
            <h2 style="margin:0 0 8px 0;">🆘 Ticket Support</h2>
            <div style="background:#fef3c7;padding:12px;border-left:4px solid #f59e0b;border-radius:6px;margin:12px 0;">
              <strong>👤 Utilisateur :</strong> {payload.username}<br>
              <strong>🤖 Assistant :</strong> {payload.assistant_name}<br>
              <strong>🕒 Date :</strong> {datetime.datetime.now().strftime('%d/%m/%Y %H:%M')}
            </div>
            <p>Le ticket est joint en PDF.</p>
            <p style="color:#6b7280;font-size:12px">© {datetime.datetime.now().year} {EMAIL_FROM_NAME}</p>
          </body>
        </html>
        """
        message_id = send_email_with_pdf(
            to=DEFAULT_RECIPIENT,
            subject=subject_local,
            html_body=html,
            pdf_bytes=pdf_bytes,
            pdf_filename=pdf_filename
        )

        return {
            "success": True,
            "message": "Commentaire enregistré, PDF généré et e-mail envoyé",
            "ticket": {
                "id": comment_id,
                "username": payload.username,
                "assistant_name": payload.assistant_name,
                "created_at": datetime.datetime.utcnow().isoformat() + "Z"
            },
            "email": {
                "to": DEFAULT_RECIPIENT,
                "subject": subject_local,
                "pdf_title": f"Ticket Support — {payload.assistant_name}",
                "pdf_size_kb": f"{len(pdf_bytes)/1024:.2f} KB",
                "message_id": message_id or None
            }
        }

    except Exception as e:
        logger.exception("submit_support_and_email error")
        raise HTTPException(status_code=500, detail=f"submit-and-email error: {e}")

# ========================= DEBUG SMTP =========================
@app.get("/debug/mail-config")
async def debug_mail_config():
    return {
        "mode": SMTP_MODE,
        "host": SMTP_HOST,
        "port": SMTP_PORT,
        "from": EMAIL_FROM,
        "from_name": EMAIL_FROM_NAME,
        "username_set": bool(SMTP_USERNAME),
        "password_set": bool(SMTP_PASSWORD),
        "recipient": DEFAULT_RECIPIENT
    }

@app.post("/debug/send-test-email")
async def debug_send_test_email(
    to: str = Query(DEFAULT_RECIPIENT),
    subject: str = Query("Test Administration STS"),
):
    try:
        pdf_bytes = b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n"
        html = "<b>Test e-mail</b> depuis /debug/send-test-email"
        mid = send_email_with_pdf(to=to, subject=subject, html_body=html, pdf_bytes=pdf_bytes, pdf_filename="test.pdf")
        return {"ok": True, "to": to, "subject": subject, "message_id": mid}
    except Exception as e:
        logger.exception("debug_send_test_email error")
        raise HTTPException(status_code=500, detail=str(e))

# ========================= MAIN LOCAL =========================
if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server:app", host="127.0.0.1", port=8000, reload=True)
