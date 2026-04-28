# =========================================================
# app.py — CT College Bot Backend (v2 PATCHED)
# Fixes: BUG-06 (хардкод URL), BUG-07 (utcnow), WARN-04 (schedule на диск),
#        WARN-05 (JWT перевірка)
# New: Telegram bot integration, push notifications (уроки + дедлайни)
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
import asyncio
from datetime import datetime, timedelta, timezone
from functools import wraps
from flask import Flask, request, jsonify, session, redirect
from flask_cors import CORS

# Google Auth Libraries
try:
    from google.oauth2.credentials import Credentials
    from google_auth_oauthlib.flow import Flow
    from googleapiclient.discovery import build
    from google.auth.transport.requests import Request as GoogleRequest
    GOOGLE_LIBS_AVAILABLE = True
except ImportError:
    GOOGLE_LIBS_AVAILABLE = False

# Telegram bot library
try:
    from telegram import Bot
    from telegram.constants import ParseMode
    TELEGRAM_LIBS_AVAILABLE = True
except ImportError:
    TELEGRAM_LIBS_AVAILABLE = False
    logging.warning("python-telegram-bot not installed. Run: pip install python-telegram-bot --break-system-packages")

from schedule_parser import parse_schedule_file, extractGroups, load_workbook

# =========================================================
# 1. LOGGING
# =========================================================
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    handlers=[
        logging.FileHandler("app.log", encoding='utf-8'),
        logging.StreamHandler(sys.stdout)
    ]
)
logger = logging.getLogger(__name__)

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

# =========================================================
# 2. CONFIG
# =========================================================
class Config:
    GOOGLE_CLIENT_ID     = os.getenv('GOOGLE_CLIENT_ID')
    GOOGLE_CLIENT_SECRET = os.getenv('GOOGLE_CLIENT_SECRET')
    GOOGLE_REDIRECT_URI  = os.getenv('GOOGLE_REDIRECT_URI')
    SECRET_KEY           = os.getenv('SECRET_KEY')
    TELEGRAM_BOT_TOKEN   = os.getenv('TELEGRAM_BOT_TOKEN')   # NEW

    # FIX BUG-06: більше не хардкод
    FRONTEND_URL = os.getenv('FRONTEND_URL', 'http://localhost:8000')

    _admins = os.getenv('ADMIN_EMAILS', '')
    ADMIN_EMAILS = [e.strip() for e in _admins.split(',') if e.strip()]

    _cors = os.getenv('ALLOWED_CORS', '')
    ALLOWED_CORS = [o.strip() for o in _cors.split(',') if o.strip()]

    SCHEDULE_FILE     = 'schedule_source.xlsx'
    SCHEDULE_CACHE_FILE = 'schedule_cache.json'  # NEW: WARN-04
    TOKENS_FILE       = 'user_tokens.json'
    TG_USERS_FILE     = 'tg_users.json'           # NEW: зберігання TG chat_id
    MAX_CONTENT_LENGTH = 10 * 1024 * 1024

def validate_config():
    missing = []
    for key in ['SECRET_KEY', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI']:
        if not getattr(Config, key):
            missing.append(key)
    if missing:
        logger.critical(f"❌ CRITICAL: Missing env vars: {', '.join(missing)}")
        sys.exit(1)
    if not Config.TELEGRAM_BOT_TOKEN:
        logger.warning("⚠️ TELEGRAM_BOT_TOKEN not set — TG notifications disabled")

validate_config()

app = Flask(__name__)
app.config.from_object(Config)
CORS(app,
     supports_credentials=True,
     origins=Config.ALLOWED_CORS if Config.ALLOWED_CORS else ['*'],
     allow_headers=['Content-Type', 'Authorization'],
     methods=['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
     expose_headers=['Content-Type'])

# =========================================================
# 3. STORAGE
# =========================================================
USER_TOKENS_CACHE = {}
SCHEDULE_CACHE    = {}
TG_USERS_CACHE    = {}   # email -> {chat_id, notify_lessons, notify_deadlines}
_tokens_lock = threading.Lock()
_tg_lock     = threading.Lock()

def atomic_write_json(path, data):
    dirn = os.path.dirname(path) or '.'
    fd, tmp_path = tempfile.mkstemp(dir=dirn, text=True)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        os.replace(tmp_path, path)
    except Exception as e:
        logger.error(f"❌ Write failed ({path}): {e}")
        if os.path.exists(tmp_path): os.remove(tmp_path)

def _load_json_file(path):
    if os.path.exists(path):
        try:
            with open(path, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception as e:
            logger.error(f"❌ Load failed ({path}): {e}")
    return {}

def load_tokens():
    global USER_TOKENS_CACHE
    USER_TOKENS_CACHE = _load_json_file(Config.TOKENS_FILE)
    logger.info(f"✅ Loaded {len(USER_TOKENS_CACHE)} user tokens.")

def save_token(email, token_data):
    with _tokens_lock:
        USER_TOKENS_CACHE[email] = token_data
        atomic_write_json(Config.TOKENS_FILE, USER_TOKENS_CACHE)

def delete_token(email):
    with _tokens_lock:
        USER_TOKENS_CACHE.pop(email, None)
        atomic_write_json(Config.TOKENS_FILE, USER_TOKENS_CACHE)

# NEW: TG users persistence
def load_tg_users():
    global TG_USERS_CACHE
    TG_USERS_CACHE = _load_json_file(Config.TG_USERS_FILE)
    logger.info(f"✅ Loaded {len(TG_USERS_CACHE)} TG users.")

def save_tg_user(email, data):
    with _tg_lock:
        TG_USERS_CACHE[email] = data
        atomic_write_json(Config.TG_USERS_FILE, TG_USERS_CACHE)

def delete_tg_user(email):
    with _tg_lock:
        TG_USERS_CACHE.pop(email, None)
        atomic_write_json(Config.TG_USERS_FILE, TG_USERS_CACHE)

# =========================================================
# 4. SCHEDULE (з збереженням на диск — WARN-04)
# =========================================================
def reload_schedule_from_excel():
    global SCHEDULE_CACHE
    if not os.path.exists(Config.SCHEDULE_FILE):
        logger.warning(f"⚠️ Schedule file '{Config.SCHEDULE_FILE}' missing.")
        # Намагаємось завантажити кеш з диску
        cached = _load_json_file(Config.SCHEDULE_CACHE_FILE)
        if cached:
            SCHEDULE_CACHE = cached
            logger.info("✅ Loaded schedule from disk cache.")
        return
    try:
        parsed_data = parse_schedule_file(Config.SCHEDULE_FILE, 57)
        SCHEDULE_CACHE['ОПК-412'] = parsed_data
        # FIX WARN-04: зберігаємо на диск щоб не губити після перезапуску
        atomic_write_json(Config.SCHEDULE_CACHE_FILE, SCHEDULE_CACHE)
        logger.info("✅ Schedule loaded and saved to disk cache.")
    except Exception as e:
        logger.error(f"❌ Schedule parsing error: {e}")

def save_schedule_cache():
    """Зберігає поточний SCHEDULE_CACHE на диск."""
    atomic_write_json(Config.SCHEDULE_CACHE_FILE, SCHEDULE_CACHE)

# =========================================================
# 5. HELPERS
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

# NEW WARN-05: JWT перевірка для захищених маршрутів
def require_jwt(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        token = (
            request.cookies.get('token') or
            request.headers.get('Authorization', '').replace('Bearer ', '')
        )
        if not token:
            return json_error("Unauthorized", 401)
        try:
            payload = jwt.decode(token, Config.SECRET_KEY, algorithms=["HS256"])
            request.jwt_email = payload.get('email')
        except jwt.ExpiredSignatureError:
            return json_error("Token expired", 401)
        except jwt.InvalidTokenError:
            return json_error("Invalid token", 401)
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
            creds.refresh(GoogleRequest())
            token_data['token'] = creds.token
            save_token(email, token_data)
        return creds
    except Exception as e:
        logger.error(f"❌ Creds error for {email}: {e}")
        return None

# FIX BUG-07: datetime.now(timezone.utc) замість утcnow()
def make_jwt(email):
    payload = {
        "email": email,
        "role": "admin" if email in Config.ADMIN_EMAILS else "student",
        "exp": datetime.now(timezone.utc) + timedelta(days=7)
    }
    return jwt.encode(payload, Config.SECRET_KEY, algorithm="HS256")

# =========================================================
# 6. TELEGRAM NOTIFICATIONS
# =========================================================
def get_telegram_bot():
    if not TELEGRAM_LIBS_AVAILABLE or not Config.TELEGRAM_BOT_TOKEN:
        return None
    return Bot(token=Config.TELEGRAM_BOT_TOKEN)

async def _send_tg_message(chat_id: int, text: str):
    """Відправляє повідомлення в Telegram."""
    bot = get_telegram_bot()
    if not bot: return False
    try:
        await bot.send_message(chat_id=chat_id, text=text, parse_mode=ParseMode.HTML)
        return True
    except Exception as e:
        logger.error(f"TG send error to {chat_id}: {e}")
        return False

def send_telegram_notification(chat_id: int, text: str):
    """Синхронна обгортка для відправки TG повідомлення."""
    try:
        loop = asyncio.new_event_loop()
        result = loop.run_until_complete(_send_tg_message(chat_id, text))
        loop.close()
        return result
    except Exception as e:
        logger.error(f"TG notification error: {e}")
        return False

def notify_lesson_start(email: str, lesson: dict):
    """Сповіщення про початок уроку."""
    tg_data = TG_USERS_CACHE.get(email)
    if not tg_data or not tg_data.get('notify_lessons', True):
        return
    chat_id = tg_data.get('chat_id')
    if not chat_id: return

    link = lesson.get('conference') or lesson.get('link') or ''
    link_text = f'\n🔗 <a href="{link}">Приєднатися</a>' if link else ''
    teacher = f"\n👤 {lesson['teacher']}" if lesson.get('teacher') else ''

    text = (
        f"🔔 <b>Скоро урок!</b>\n\n"
        f"📚 <b>{lesson.get('title', 'Урок')}</b>\n"
        f"⏰ {lesson.get('time', '')}{teacher}{link_text}\n\n"
        f"<i>Починається через 15 хвилин</i>"
    )
    threading.Thread(target=send_telegram_notification, args=(chat_id, text), daemon=True).start()

def notify_deadline(email: str, assignment_title: str, course_name: str, deadline_str: str, hours_left: int):
    """Сповіщення про дедлайн завдання."""
    tg_data = TG_USERS_CACHE.get(email)
    if not tg_data or not tg_data.get('notify_deadlines', True):
        return
    chat_id = tg_data.get('chat_id')
    if not chat_id: return

    emoji = "🚨" if hours_left <= 1 else "⚠️"
    time_text = "1 годину" if hours_left <= 1 else f"{hours_left} годин"

    text = (
        f"{emoji} <b>Дедлайн наближається!</b>\n\n"
        f"📝 <b>{assignment_title}</b>\n"
        f"📚 {course_name}\n"
        f"⏰ Дедлайн: {deadline_str}\n\n"
        f"<i>Залишилось менше {time_text}!</i>"
    )
    threading.Thread(target=send_telegram_notification, args=(chat_id, text), daemon=True).start()

# =========================================================
# 7. LESSON NOTIFICATION SCHEDULER
# =========================================================
def schedule_lesson_notifications():
    """
    Перевіряє розклад кожну хвилину.
    За 15 хвилин до початку уроку — відправляє TG сповіщення.
    """
    if not TG_USERS_CACHE:
        return

    now = datetime.now(timezone.utc).astimezone()
    current_weekday = now.weekday()  # 0=Пн, 4=Пт
    if current_weekday > 4:
        return  # Вихідні — нічого не робимо

    schedule = SCHEDULE_CACHE.get('ОПК-412', [])
    if not schedule or current_weekday >= len(schedule):
        return

    today_lessons = schedule[current_weekday]
    notify_time = now + timedelta(minutes=15)

    for lesson in today_lessons:
        time_str = lesson.get('time', '')
        if not time_str:
            continue
        # Парсимо час (формат "8:30" або "08:30-10:05")
        try:
            start_str = time_str.split('-')[0].strip()
            lesson_hour, lesson_min = map(int, start_str.split(':'))
            lesson_dt = now.replace(hour=lesson_hour, minute=lesson_min, second=0, microsecond=0)
            # Сповіщення якщо до уроку 14-16 хвилин
            diff = abs((lesson_dt - notify_time).total_seconds())
            if diff <= 60:
                for email in list(TG_USERS_CACHE.keys()):
                    notify_lesson_start(email, lesson)
        except Exception:
            continue

def start_notification_scheduler():
    """Запускає фоновий потік для перевірки уроків та дедлайнів."""
    def run():
        import time
        logger.info("🕐 Notification scheduler started")
        while True:
            try:
                schedule_lesson_notifications()
                check_deadline_notifications()
            except Exception as e:
                logger.error(f"Scheduler error: {e}")
            time.sleep(60)  # Перевірка кожну хвилину
    t = threading.Thread(target=run, daemon=True)
    t.start()

def check_deadline_notifications():
    """Перевіряє дедлайни для всіх підключених користувачів."""
    if not TG_USERS_CACHE or not GOOGLE_LIBS_AVAILABLE:
        return

    now = datetime.now(timezone.utc)

    for email, tg_data in list(TG_USERS_CACHE.items()):
        if not tg_data.get('notify_deadlines', True):
            continue
        if not tg_data.get('chat_id'):
            continue

        creds = get_google_creds(email)
        if not creds:
            continue

        try:
            srv = build('classroom', 'v1', credentials=creds)
            courses_res = srv.courses().list(studentId='me', courseStates=['ACTIVE']).execute()
            courses = courses_res.get('courses', [])

            for course in courses:
                try:
                    cw_res = srv.courses().courseWork().list(
                        courseId=course['id'],
                        orderBy='dueDate asc'
                    ).execute()
                    for work in cw_res.get('courseWork', []):
                        dd = work.get('dueDate')
                        dt_time = work.get('dueTime', {})
                        if not dd:
                            continue
                        try:
                            deadline_dt = datetime(
                                dd['year'], dd['month'], dd['day'],
                                dt_time.get('hours', 23), dt_time.get('minutes', 59),
                                tzinfo=timezone.utc
                            )
                            hours_left = (deadline_dt - now).total_seconds() / 3600

                            # Сповіщення за 24 години і за 1 годину
                            notify_key = f"{email}_{work['id']}"
                            notified = tg_data.get('notified_assignments', {})

                            if 23.5 <= hours_left <= 24.5 and '24h' not in notified.get(work['id'], ''):
                                notify_deadline(email, work['title'], course.get('name', ''),
                                                deadline_dt.strftime('%d.%m %H:%M'), 24)
                                notified[work['id']] = notified.get(work['id'], '') + '24h'
                                tg_data['notified_assignments'] = notified
                                save_tg_user(email, tg_data)

                            elif 0.5 <= hours_left <= 1.5 and '1h' not in notified.get(work['id'], ''):
                                notify_deadline(email, work['title'], course.get('name', ''),
                                                deadline_dt.strftime('%d.%m %H:%M'), 1)
                                notified[work['id']] = notified.get(work['id'], '') + '1h'
                                tg_data['notified_assignments'] = notified
                                save_tg_user(email, tg_data)
                        except Exception:
                            continue
                except Exception:
                    continue
        except Exception as e:
            logger.error(f"Deadline check error for {email}: {e}")

# =========================================================
# 8. ROUTES
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
        'schedule_loaded': 'ОПК-412' in SCHEDULE_CACHE,
        'telegram_ready': bool(Config.TELEGRAM_BOT_TOKEN and TELEGRAM_LIBS_AVAILABLE)
    })

# --- AUTH ---
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
    if request.method == 'GET':
        code = request.args.get('code')
        redirect_uri = Config.GOOGLE_REDIRECT_URI
    else:
        data = request.get_json(force=True)
        code = data.get('code')
        redirect_uri = data.get('redirect_uri', Config.GOOGLE_REDIRECT_URI)

    if not code:
        return json_error("No code", 400)

    try:
        token_url = "https://oauth2.googleapis.com/token"
        payload = {
            'code': code, 'client_id': Config.GOOGLE_CLIENT_ID,
            'client_secret': Config.GOOGLE_CLIENT_SECRET,
            'redirect_uri': redirect_uri, 'grant_type': 'authorization_code'
        }
        res = requests.post(token_url, data=payload, timeout=10)
        t_data = res.json()

        if 'error' in t_data:
            return json_error(t_data.get('error_description', 'Token error'), 400)

        creds = Credentials(token=t_data['access_token'])
        user_info = build('oauth2', 'v2', credentials=creds).userinfo().get().execute()
        email = user_info.get('email')
        if not email:
            return json_error("No email in profile", 500)

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

        token = make_jwt(email)  # FIX BUG-07: використовуємо нову функцію

        if request.method == 'GET':
            # FIX BUG-06: FRONTEND_URL з env, не хардкод
            response = redirect(Config.FRONTEND_URL)
            response.set_cookie('token', token, httponly=True, secure=True, samesite='Lax', max_age=7*24*60*60)

            user_data_dict = {
                'name': user_info.get('name', ''),
                'email': email,
                'picture': user_info.get('picture', ''),
                'role': 'admin' if email in Config.ADMIN_EMAILS else 'student',
                'telegram_id': TG_USERS_CACHE.get(email, {}).get('chat_id')  # NEW
            }
            user_data_b64 = base64.b64encode(json.dumps(user_data_dict).encode()).decode('ascii')
            response.set_cookie('user_data', user_data_b64, max_age=60, secure=True, samesite='Lax')
            return response

        # POST response
        resp_data = {
            'success': True,
            'user': {
                'name': user_info.get('name', ''),
                'email': email,
                'picture': user_info.get('picture', ''),
                'role': 'admin' if email in Config.ADMIN_EMAILS else 'student',
                'telegram_id': TG_USERS_CACHE.get(email, {}).get('chat_id')  # NEW
            },
            'token': token
        }
        resp = jsonify(resp_data)
        resp.set_cookie('token', token, httponly=True, secure=True, samesite='Lax', max_age=7*24*60*60)
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

# =========================================================
# NEW: TELEGRAM ROUTES
# =========================================================
@app.route('/api/telegram/link', methods=['POST'])
def telegram_link():
    """
    Телеграм бот викликає цей ендпоінт коли юзер натискає /start link_<base64email>.
    Зберігає chat_id для email.
    """
    data = request.json or {}
    encoded_email = data.get('encoded_email')
    chat_id = data.get('chat_id')
    notify_lessons = data.get('notify_lessons', True)
    notify_deadlines = data.get('notify_deadlines', True)

    if not encoded_email or not chat_id:
        return json_error("encoded_email and chat_id required", 400)

    try:
        email = base64.b64decode(encoded_email.encode()).decode('utf-8')
    except Exception:
        return json_error("Invalid encoded_email", 400)

    if email not in USER_TOKENS_CACHE:
        return json_error("User not found. Please log in via the web app first.", 404)

    save_tg_user(email, {
        'chat_id': chat_id,
        'notify_lessons': notify_lessons,
        'notify_deadlines': notify_deadlines,
        'notified_assignments': {}
    })
    logger.info(f"✅ TG linked: {email} -> chat_id {chat_id}")

    # Вітальне повідомлення
    send_telegram_notification(chat_id,
        f"✅ <b>Підключено!</b>\n\n"
        f"Тепер ви будете отримувати сповіщення:\n"
        f"{'✅' if notify_lessons else '❌'} Про початок уроків (за 15 хв)\n"
        f"{'✅' if notify_deadlines else '❌'} Про дедлайни завдань (за 24 год та 1 год)\n\n"
        f"Команди:\n"
        f"/schedule — розклад на сьогодні\n"
        f"/deadlines — найближчі дедлайни\n"
        f"/settings — налаштування сповіщень\n"
        f"/stop — відʼєднати бота"
    )

    return jsonify({'success': True, 'email': email})

@app.route('/api/telegram/unlink', methods=['POST'])
def telegram_unlink():
    """Відʼєднує TG від акаунту."""
    data = request.json or {}
    email = data.get('userId')
    if not email:
        return json_error("userId required", 400)
    tg_data = TG_USERS_CACHE.get(email)
    if tg_data and tg_data.get('chat_id'):
        send_telegram_notification(tg_data['chat_id'],
            "🔕 Telegram-сповіщення відʼєднано.\n\nДля повторного підключення поверніться в застосунок.")
    delete_tg_user(email)
    return jsonify({'success': True})

@app.route('/api/telegram/settings', methods=['POST'])
def telegram_settings():
    """Оновлює налаштування сповіщень."""
    data = request.json or {}
    email = data.get('userId')
    if not email or email not in TG_USERS_CACHE:
        return json_error("User not linked", 404)
    tg_data = TG_USERS_CACHE[email]
    if 'notify_lessons' in data:
        tg_data['notify_lessons'] = bool(data['notify_lessons'])
    if 'notify_deadlines' in data:
        tg_data['notify_deadlines'] = bool(data['notify_deadlines'])
    save_tg_user(email, tg_data)
    return jsonify({'success': True, 'settings': tg_data})

@app.route('/api/telegram/webhook', methods=['POST'])
def telegram_webhook():
    """
    Webhook від Telegram.
    Обробляє команди: /start, /schedule, /deadlines, /settings, /stop
    """
    if not TELEGRAM_LIBS_AVAILABLE:
        return jsonify({'ok': True})

    update = request.json or {}
    message = update.get('message', {})
    chat_id = message.get('chat', {}).get('id')
    text = message.get('text', '')

    if not chat_id or not text:
        return jsonify({'ok': True})

    # /start link_<base64email>
    if text.startswith('/start link_'):
        encoded_email = text.replace('/start link_', '').strip()
        try:
            email = base64.b64decode(encoded_email.encode()).decode('utf-8')
            if email in USER_TOKENS_CACHE:
                save_tg_user(email, {
                    'chat_id': chat_id,
                    'notify_lessons': True,
                    'notify_deadlines': True,
                    'notified_assignments': {}
                })
                send_telegram_notification(chat_id,
                    f"✅ <b>Підключено успішно!</b>\n\n"
                    f"Акаунт: <code>{email}</code>\n\n"
                    f"Ви будете отримувати:\n"
                    f"🔔 Нагадування про уроки (за 15 хв)\n"
                    f"⚠️ Нагадування про дедлайни (за 24 год та 1 год)\n\n"
                    f"Команди: /schedule /deadlines /settings /stop"
                )
            else:
                send_telegram_notification(chat_id,
                    "❌ Акаунт не знайдено.\nСпочатку увійдіть через Google у застосунку.")
        except Exception as e:
            logger.error(f"TG link error: {e}")
            send_telegram_notification(chat_id, "❌ Помилка підключення. Спробуйте знову.")

    # /schedule — розклад на сьогодні
    elif text == '/schedule':
        email = _get_email_by_chat_id(chat_id)
        if not email:
            send_telegram_notification(chat_id, "❌ Спочатку підключіть акаунт через застосунок.")
        else:
            _send_today_schedule(chat_id)

    # /deadlines — найближчі дедлайни
    elif text == '/deadlines':
        email = _get_email_by_chat_id(chat_id)
        if not email:
            send_telegram_notification(chat_id, "❌ Спочатку підключіть акаунт через застосунок.")
        else:
            threading.Thread(target=_send_upcoming_deadlines, args=(chat_id, email), daemon=True).start()

    # /settings — налаштування
    elif text == '/settings':
        email = _get_email_by_chat_id(chat_id)
        if email and email in TG_USERS_CACHE:
            tg_data = TG_USERS_CACHE[email]
            send_telegram_notification(chat_id,
                f"⚙️ <b>Налаштування сповіщень</b>\n\n"
                f"{'✅' if tg_data.get('notify_lessons') else '❌'} Уроки\n"
                f"{'✅' if tg_data.get('notify_deadlines') else '❌'} Дедлайни\n\n"
                f"Для зміни — відкрийте Профіль у застосунку."
            )

    # /stop — відʼєднати
    elif text == '/stop':
        email = _get_email_by_chat_id(chat_id)
        if email:
            delete_tg_user(email)
            send_telegram_notification(chat_id,
                "🔕 Сповіщення вимкнено. До побачення!\n\nДля повторного підключення — відкрийте застосунок.")
        else:
            send_telegram_notification(chat_id, "Ви не були підключені.")

    return jsonify({'ok': True})

def _get_email_by_chat_id(chat_id):
    for email, data in TG_USERS_CACHE.items():
        if data.get('chat_id') == chat_id:
            return email
    return None

def _send_today_schedule(chat_id):
    now = datetime.now(timezone.utc).astimezone()
    weekday = now.weekday()
    if weekday > 4:
        send_telegram_notification(chat_id, "📅 Сьогодні вихідний день. Відпочивайте! 🎉")
        return

    schedule = SCHEDULE_CACHE.get('ОПК-412', [])
    if not schedule or weekday >= len(schedule):
        send_telegram_notification(chat_id, "📅 Розклад не завантажено.")
        return

    today_lessons = schedule[weekday]
    if not today_lessons:
        send_telegram_notification(chat_id, "📅 Сьогодні занять немає.")
        return

    days_ua = ['Понеділок', 'Вівторок', 'Середа', 'Четвер', 'Пʼятниця']
    lines = [f"📅 <b>Розклад — {days_ua[weekday]}</b>\n"]
    for i, lesson in enumerate(today_lessons, 1):
        link = lesson.get('conference') or lesson.get('link') or ''
        link_text = f' <a href="{link}">🔗</a>' if link else ''
        lines.append(
            f"{i}. <b>{lesson.get('time', '')}</b> {lesson.get('title', '')}{link_text}\n"
            f"   👤 {lesson.get('teacher', 'Викладач не вказано')}"
        )
    send_telegram_notification(chat_id, '\n'.join(lines))

def _send_upcoming_deadlines(chat_id, email):
    creds = get_google_creds(email)
    if not creds:
        send_telegram_notification(chat_id, "❌ Помилка доступу до Classroom.")
        return

    try:
        srv = build('classroom', 'v1', credentials=creds)
        courses_res = srv.courses().list(studentId='me', courseStates=['ACTIVE']).execute()
        now = datetime.now(timezone.utc)
        upcoming = []

        for course in courses_res.get('courses', []):
            try:
                cw_res = srv.courses().courseWork().list(
                    courseId=course['id'], orderBy='dueDate asc'
                ).execute()
                for work in cw_res.get('courseWork', []):
                    dd = work.get('dueDate')
                    if not dd: continue
                    deadline_dt = datetime(dd['year'], dd['month'], dd['day'], 23, 59, tzinfo=timezone.utc)
                    if deadline_dt > now:
                        upcoming.append({
                            'title': work['title'],
                            'course': course.get('name', ''),
                            'deadline': deadline_dt,
                            'hours_left': (deadline_dt - now).total_seconds() / 3600
                        })
            except Exception:
                continue

        upcoming.sort(key=lambda x: x['deadline'])
        upcoming = upcoming[:5]  # Топ 5 найближчих

        if not upcoming:
            send_telegram_notification(chat_id, "✅ Немає найближчих дедлайнів!")
            return

        lines = ["⚠️ <b>Найближчі дедлайни:</b>\n"]
        for item in upcoming:
            hours = item['hours_left']
            if hours <= 24:
                urgency = "🚨"
            elif hours <= 72:
                urgency = "⚠️"
            else:
                urgency = "📌"
            lines.append(
                f"{urgency} <b>{item['title']}</b>\n"
                f"   📚 {item['course']}\n"
                f"   📅 {item['deadline'].strftime('%d.%m %H:%M')}"
            )
        send_telegram_notification(chat_id, '\n\n'.join(lines))

    except Exception as e:
        logger.error(f"_send_upcoming_deadlines error: {e}")
        send_telegram_notification(chat_id, "❌ Помилка отримання завдань.")

# =========================================================
# 9. CLASSROOM & SCHEDULE ROUTES
# =========================================================
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
            dt = None
            dd = work.get('dueDate')
            if dd:
                dt = datetime(dd['year'], dd['month'], dd['day'], tzinfo=timezone.utc)
                if dt < datetime.now(timezone.utc): status = 'overdue'
            out.append({
                'id': work['id'],
                'title': work['title'],
                'description': work.get('description'),
                'status': status,
                'maxPoints': work.get('maxPoints'),
                'deadline': dt.isoformat() if dt else None
            })
        return jsonify({'success': True, 'assignments': out})
    except Exception as e:
        logger.error(f"Coursework error: {e}")
        return json_error(str(e), 500)

@app.route('/api/schedule/group', methods=['GET'])
def get_schedule():
    grp = request.args.get('group', 'ОПК-412')
    data = SCHEDULE_CACHE.get(grp)
    if data: return jsonify({'success': True, 'group': grp, 'schedule': data})
    return json_error("Schedule not found", 404)

@app.route('/api/schedule/save', methods=['POST'])
def save_schedule_manual():
    data = request.json or {}
    uid = data.get('userId')
    grp = data.get('group')
    sched = data.get('schedule')
    if uid not in Config.ADMIN_EMAILS: return json_error("Forbidden", 403)
    SCHEDULE_CACHE[grp] = sched
    save_schedule_cache()  # FIX WARN-04: зберігаємо на диск
    logger.info(f"✏️ Schedule updated by {uid}")
    return jsonify({'success': True})

@app.route('/api/schedule/upload', methods=['POST'])
def upload_schedule():
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

@app.route('/api/schedule/parse-local', methods=['POST'])
def parse_local():
    reload_schedule_from_excel()
    data = SCHEDULE_CACHE.get('ОПК-412')
    if data: return jsonify({'success': True, 'schedule': data})
    return json_error("Failed to parse schedule", 500)

@app.route('/api/schedule/groups', methods=['GET'])
def get_groups_list():
    try:
        wb = load_workbook(Config.SCHEDULE_FILE, data_only=True)
        return jsonify({'success': True, 'groups': extractGroups(wb.active)})
    except Exception as e:
        return json_error(str(e), 500)

# =========================================================
# STARTUP
# =========================================================
if __name__ == '__main__':
    load_tokens()
    load_tg_users()
    reload_schedule_from_excel()
    start_notification_scheduler()  # NEW: запускаємо scheduler

    port = int(os.getenv('PORT', 8000))
    logger.info(f"🚀 Server running on port {port}")
    app.run(debug=False, port=port, host='0.0.0.0')
