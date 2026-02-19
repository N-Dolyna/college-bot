# =========================================================
# app.py — CT College Bot Backend
# =========================================================

import os
import sys
import json
import logging
import threading
import tempfile
import requests
import jwt
import datetime
import base64
from datetime import datetime, timedelta, timezone
from functools import wraps
from flask import Flask, request, jsonify, session, redirect
from flask_cors import CORS
# Бібліотеки Google Auth
try:
    from google.oauth2.credentials import Credentials
    from google_auth_oauthlib.flow import Flow
    from googleapiclient.discovery import build
    from google.auth.transport.requests import Request as GoogleRequest
    GOOGLE_LIBS_AVAILABLE = True
except ImportError:
    GOOGLE_LIBS_AVAILABLE = False

# Локальні модулі

from schedule_parser import parse_schedule_file, extractGroups, load_workbook

# =========================================================
# 1. ЛОГУВАННЯ ТА ОТОЧЕННЯ
# =========================================================

# Логування: файл + консоль
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    handlers=[
        logging.FileHandler("app.log", encoding='utf-8'),
        logging.StreamHandler(sys.stdout)
    ]
)
logger = logging.getLogger(__name__)

# Завантаження .env (якщо є бібліотека python-dotenv)
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    logger.warning("⚠️ python-dotenv not installed. Reading variables directly from OS environment.")

# =========================================================
# 2. СУВОРА КОНФІГУРАЦІЯ
# =========================================================

class Config:
    # 1. Секрети (Обов'язкові)
    GOOGLE_CLIENT_ID = os.getenv('GOOGLE_CLIENT_ID')
    GOOGLE_CLIENT_SECRET = os.getenv('GOOGLE_CLIENT_SECRET')
    
    # 2. Налаштування оточення (Обов'язкові)
    GOOGLE_REDIRECT_URI = os.getenv('GOOGLE_REDIRECT_URI')
    SECRET_KEY = os.getenv('SECRET_KEY')
    # 3. Списки (Обов'язкові, парсимо з рядка)
    _admins = os.getenv('ADMIN_EMAILS', '')
    ADMIN_EMAILS = [e.strip() for e in _admins.split(',')] if _admins else []

    _cors = os.getenv('ALLOWED_CORS', '')
    ALLOWED_CORS = [o.strip() for o in _cors.split(',')] if _cors else []
    
    # 4. Файли (Константи)
    SCHEDULE_FILE = 'schedule_source.xlsx' 
    TOKENS_FILE = 'user_tokens.json'
    MAX_CONTENT_LENGTH = 10 * 1024 * 1024  # 10 MB

# ВАЛІДАЦІЯ КОНФІГУРАЦІЇ ПРИ СТАРТІ
def validate_config():
    missing = []
    if not Config.SECRET_KEY: missing.append("SECRET_KEY")
    if not Config.GOOGLE_CLIENT_ID: missing.append("GOOGLE_CLIENT_ID")
    if not Config.GOOGLE_CLIENT_SECRET: missing.append("GOOGLE_CLIENT_SECRET")
    if not Config.GOOGLE_REDIRECT_URI: missing.append("GOOGLE_REDIRECT_URI")
    if not Config.ADMIN_EMAILS: missing.append("ADMIN_EMAILS")
    
    if missing:
        logger.critical(f"❌ CRITICAL: Missing environment variables: {', '.join(missing)}")
        logger.critical("❌ Please create a .env file or set these variables.")
        sys.exit(1) # Жорсткий вихід, якщо конфіг зламано

validate_config()

app = Flask(__name__)
app.config.from_object(Config)
from flask_cors import cross_origin
CORS(app, 
     supports_credentials=True, 
     origins=Config.ALLOWED_CORS if Config.ALLOWED_CORS else ['*'],
     allow_headers=['Content-Type', 'Authorization'],
     methods=['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
     expose_headers=['Content-Type'])

# =========================================================
# 3. ЗБЕРІГАННЯ (JSON + блокування)
# =========================================================

USER_TOKENS_CACHE = {} 
SCHEDULE_CACHE = {} 
_tokens_lock = threading.Lock()

def atomic_write_json(path, data):
    dirn = os.path.dirname(path) or '.'
    fd, tmp_path = tempfile.mkstemp(dir=dirn, text=True)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        os.replace(tmp_path, path)
    except Exception as e:
        logger.error(f"❌ Write failed: {e}")
        if os.path.exists(tmp_path): os.remove(tmp_path)

def load_tokens():
    global USER_TOKENS_CACHE
    if os.path.exists(Config.TOKENS_FILE):
        with _tokens_lock:
            try:
                with open(Config.TOKENS_FILE, 'r', encoding='utf-8') as f:
                    USER_TOKENS_CACHE = json.load(f)
                logger.info(f"✅ Loaded {len(USER_TOKENS_CACHE)} tokens.")
            except Exception as e:
                logger.error(f"❌ Failed to load tokens: {e}")

def save_token(email, token_data):
    with _tokens_lock:
        USER_TOKENS_CACHE[email] = token_data
        atomic_write_json(Config.TOKENS_FILE, USER_TOKENS_CACHE)

def delete_token(email):
    with _tokens_lock:
        if email in USER_TOKENS_CACHE:
            del USER_TOKENS_CACHE[email]
            atomic_write_json(Config.TOKENS_FILE, USER_TOKENS_CACHE)

# =========================================================
# 4. ЛОГІКА РОЗКЛАДУ (в пам'яті)
# =========================================================

def reload_schedule_from_excel():
    global SCHEDULE_CACHE
    if not os.path.exists(Config.SCHEDULE_FILE):
        logger.warning(f"⚠️ Schedule file '{Config.SCHEDULE_FILE}' missing. Schedule is empty.")
        return

    try:
        logger.info(f"📂 Parsing {Config.SCHEDULE_FILE}...")
        # 57 - індекс для ОПК-412
        parsed_data = parse_schedule_file(Config.SCHEDULE_FILE, 57) 
        SCHEDULE_CACHE['ОПК-412'] = parsed_data
        logger.info("✅ Schedule loaded into memory.")
    except Exception as e:
        logger.error(f"❌ Schedule parsing error: {e}")

# =========================================================
# 5. ДОПОМІЖНІ ФУНКЦІЇ
# =========================================================

def json_error(msg, status=400):
    return jsonify({'error': msg}), status

def require_google_auth(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if not GOOGLE_LIBS_AVAILABLE:
            return json_error("Google Auth libs missing on server", 500)
        return f(*args, **kwargs)
    return decorated

def get_google_creds(email):
    token_data = USER_TOKENS_CACHE.get(email)
    if not token_data: return None

    try:
        creds = Credentials(
            token=token_data['token'],
            refresh_token=token_data.get('refresh_token'),
            token_uri=token_data.get('token_uri'),
            client_id=token_data.get('client_id'),
            client_secret=token_data.get('client_secret'),
            scopes=token_data.get('scopes')
        )
        if creds.expired and creds.refresh_token:
            logger.info(f"🔄 Refreshing token for {email}")
            creds.refresh(GoogleRequest())
            token_data['token'] = creds.token
            save_token(email, token_data)
        return creds
    except Exception as e:
        logger.error(f"❌ Creds error for {email}: {e}")
        return None

# =========================================================
# 6. API МАРШРУТИ
# =========================================================

@app.route('/')
def index():
    return app.send_static_file('index.html')

@app.route('/app-opk412.js')
def serve_js():
    return app.send_static_file('app-opk412.js')

@app.route('/manifest.json')
def serve_manifest():
    return app.send_static_file('manifest.json')

@app.route('/api/health', methods=['GET'])
def health():
    return jsonify({
        'status': 'ok', 
        'auth_ready': GOOGLE_LIBS_AVAILABLE,
        'schedule_loaded': 'ОПК-412' in SCHEDULE_CACHE
    })

# --- АВТЕНТИФІКАЦІЯ ---
@app.route('/api/auth/google', methods=['POST'])
@require_google_auth
def auth_init():
    data = request.json or {}
    redirect_uri = data.get('redirect_uri', Config.GOOGLE_REDIRECT_URI)
    try:
        flow = Flow.from_client_config(
            {"web": {
                "client_id": Config.GOOGLE_CLIENT_ID,
                "client_secret": Config.GOOGLE_CLIENT_SECRET,
                "auth_uri": "https://accounts.google.com/o/oauth2/auth",
                "token_uri": "https://oauth2.googleapis.com/token",
                "redirect_uris": [redirect_uri]
            }},
            scopes=[
                'openid',
                'https://www.googleapis.com/auth/userinfo.email',
                'https://www.googleapis.com/auth/userinfo.profile',
                'https://www.googleapis.com/auth/classroom.courses.readonly',
                'https://www.googleapis.com/auth/classroom.coursework.me.readonly',
                'https://www.googleapis.com/auth/classroom.student-submissions.me.readonly'
            ],
            redirect_uri=redirect_uri
        )
        auth_url, state = flow.authorization_url(prompt='consent')
        session['oauth_state'] = state
        return jsonify({'success': True, 'authUrl': auth_url, 'state': state})
    except Exception as e:
        logger.exception("Auth init failed")
        return json_error(str(e), 500)

@app.route('/api/auth/google/callback', methods=['GET', 'POST'])
def auth_callback():
    # ✅ Для GET запиту (від Google) - беремо з URL параметрів
    if request.method == 'GET':
        code = request.args.get('code')
        redirect_uri = Config.GOOGLE_REDIRECT_URI
        logger.info(f"📥 GET callback received with code: {code[:20] if code else 'None'}...")
    
    # ✅ Для POST запиту (від фронтенду) - беремо з JSON
    elif request.method == 'POST':
        data = request.get_json(force=True)
        code = data.get('code')
        redirect_uri = data.get('redirect_uri', Config.GOOGLE_REDIRECT_URI)
        logger.info(f"📥 POST callback received with code: {code[:20] if code else 'None'}...")

    if not code:
        return json_error("No code", 400)

    try:
        token_url = "https://oauth2.googleapis.com/token"
        payload = {
            'code': code,
            'client_id': Config.GOOGLE_CLIENT_ID,
            'client_secret': Config.GOOGLE_CLIENT_SECRET,
            'redirect_uri': redirect_uri,
            'grant_type': 'authorization_code'
        }

        res = requests.post(token_url, data=payload, timeout=10)
        t_data = res.json()

        if 'error' in t_data:
            logger.error(f"❌ Token error: {t_data}")
            return json_error(t_data.get('error_description', 'Token error'), 400)

        # Отримуємо профіль
        creds = Credentials(token=t_data['access_token'])
        user_info = build('oauth2', 'v2', credentials=creds).userinfo().get().execute()
        email = user_info.get('email')

        if not email:
            return json_error("No email in profile", 500)

        # Збереження токена Google
        save_data = {
            'token': t_data['access_token'],
            'refresh_token': t_data.get('refresh_token'),
            'token_uri': token_url,
            'client_id': Config.GOOGLE_CLIENT_ID,
            'client_secret': Config.GOOGLE_CLIENT_SECRET,
            'scopes': t_data.get('scope', '').split()
        }

        old_data = USER_TOKENS_CACHE.get(email)
        if not save_data['refresh_token'] and old_data:
            save_data['refresh_token'] = old_data.get('refresh_token')

        save_token(email, save_data)

        logger.info(f"✅ Logged in: {email}")

        # ===== Створюємо JWT =====
        jwt_payload = {
            "email": email,
            "role": "admin" if email in Config.ADMIN_EMAILS else "student",
            "exp": datetime.utcnow() + timedelta(days=7)
        }

        token = jwt.encode(jwt_payload, Config.SECRET_KEY, algorithm="HS256")

        # ✅ Для GET від Google - робимо redirect на фронтенд
        if request.method == 'GET':
            logger.info("🔄 Redirecting to frontend after successful auth")
            response = redirect("https://ct-college-bot.onrender.com/")
            
            # Встановлюємо cookie з JWT токеном
            response.set_cookie(
                'token',
                token,
                httponly=True,
                secure=True,
                samesite='Lax',
                max_age=7*24*60*60  # 7 днів
            )
            
            # Підготовлюємо дані користувача
            user_data_dict = {
                'name': user_info.get('name', ''),
                'email': email,
                'picture': user_info.get('picture', ''),
                'role': 'admin' if email in Config.ADMIN_EMAILS else 'student'
            }
            
            # Кодуємо в base64 для безпечної передачі через cookie
            user_data_json = json.dumps(user_data_dict)
            user_data_b64 = base64.b64encode(user_data_json.encode('utf-8')).decode('ascii')
            
            logger.info(f"📤 Setting user_data cookie (base64): {user_data_b64[:50]}...")
            
            # Встановлюємо cookie user_data (без httponly, щоб JS міг прочитати)
            response.set_cookie(
                'user_data', 
                user_data_b64, 
                max_age=60,  # 60 секунд - тільки для передачі даних
                secure=True, 
                samesite='Lax'
            )
            
            return response

        # ✅ Для POST - повертаємо JSON
        response_data = {
            'success': True,
            'user': {
                'name': user_info.get('name', ''),
                'email': email,
                'picture': user_info.get('picture', ''),
                'role': 'admin' if email in Config.ADMIN_EMAILS else 'student'
            },
            'token': token
        }
        
        resp = jsonify(response_data)
        resp.set_cookie(
            'token',
            token,
            httponly=True,
            secure=True,
            samesite='Lax',
            max_age=7*24*60*60
        )
        
        return resp

    except Exception as e:
        logger.exception("❌ Auth callback failed")
        return json_error(str(e), 500)

@app.route('/api/auth/check', methods=['GET'])
def auth_check():
    uid = request.args.get('userId')
    return jsonify({'success': True, 'present': uid in USER_TOKENS_CACHE})

@app.route('/api/auth/logout', methods=['POST'])
def logout():
    uid = (request.json or {}).get('userId')
    if uid: delete_token(uid)
    return jsonify({'success': True})

# --- CLASSROOM ---
@app.route('/api/classroom/courses', methods=['GET'])
@require_google_auth
def get_courses():
    uid = request.args.get('userId')
    creds = get_google_creds(uid)
    if not creds: return json_error("Unauthorized", 401)
    
    try:
        srv = build('classroom', 'v1', credentials=creds)
        res = srv.courses().list(studentId='me', courseStates=['ACTIVE']).execute()
        simple = [{'id': c['id'], 'name': c.get('name'), 'section': c.get('section')} for c in res.get('courses', [])]
        return jsonify({'success': True, 'courses': simple})
    except Exception as e:
        logger.error(f"Courses error: {e}")
        return json_error(str(e), 500)

@app.route('/api/classroom/coursework', methods=['GET'])
@require_google_auth
def get_coursework():
    uid = request.args.get('userId')
    cid = request.args.get('courseId')
    submittable = request.args.get('submittable', 'true') == 'true'
    creds = get_google_creds(uid)
    if not creds or not cid: return json_error("Bad params", 400)

    try:
        srv = build('classroom', 'v1', credentials=creds)
        res = srv.courses().courseWork().list(courseId=cid, orderBy='dueDate desc').execute()
        out = []
        for work in res.get('courseWork', []):
            if submittable and work.get('workType') == 'MATERIAL': continue
            
            status = 'pending'
            dd = work.get('dueDate')
            if dd:
                dt = datetime(dd['year'], dd['month'], dd['day'])
                if dt < datetime.now(): status = 'overdue'

            out.append({
                'id': work['id'],
                'title': work['title'],
                'description': work.get('description'),
                'status': status,
                'maxPoints': work.get('maxPoints'),
                'deadline': dt.isoformat() if dd else None
            })
        return jsonify({'success': True, 'assignments': out})
    except Exception as e:
        logger.error(f"Coursework error: {e}")
        return json_error(str(e), 500)

# --- SCHEDULE ---
@app.route('/api/schedule/group', methods=['GET'])
def get_schedule():
    grp = request.args.get('group', 'ОПК-412')
    data = SCHEDULE_CACHE.get(grp)
    if data:
        return jsonify({'success': True, 'group': grp, 'schedule': data})
    return json_error("Schedule not found", 404)

@app.route('/api/schedule/save', methods=['POST'])
def save_schedule_manual():
    # Адмін зберігає правки в пам'ять
    data = request.json or {}
    uid = data.get('userId')
    grp = data.get('group')
    sched = data.get('schedule')
    if uid not in Config.ADMIN_EMAILS: return json_error("Forbidden", 403)
    
    SCHEDULE_CACHE[grp] = sched
    logger.info(f"✏️ Schedule updated manually by {uid}")
    return jsonify({'success': True})

@app.route('/api/schedule/upload', methods=['POST'])
def upload_schedule():
    # Адмін завантажує файл
    if 'file' not in request.files: return json_error("No file")
    f = request.files['file']
    if not f.filename.endswith(('.xlsx', '.xls')): return json_error("Invalid file")

    try:
        f.save(Config.SCHEDULE_FILE)
        reload_schedule_from_excel()
        return jsonify({'success': True, 'schedule': SCHEDULE_CACHE.get('ОПК-412'), 'group': 'ОПК-412'})
    except Exception as e:
        logger.error(f"Upload failed: {e}")
        return json_error(str(e), 500)

@app.route('/api/schedule/groups', methods=['GET'])
def get_groups_list():
    try:
        wb = load_workbook(Config.SCHEDULE_FILE, data_only=True)
        return jsonify({'success': True, 'groups': extractGroups(wb.active)})
    except Exception as e:
        return json_error(str(e), 500)

# =========================================================
# ЗАПУСК
# =========================================================
if __name__ == '__main__':
    load_tokens()
    reload_schedule_from_excel()
    
    port = int(os.getenv('PORT', 8000))
    logger.info(f"🚀 Server running on port {port}")
    app.run(debug=False, port=port, host='0.0.0.0')
