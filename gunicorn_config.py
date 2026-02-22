# =========================================================
# Gunicorn Configuration для CT College Bot
# =========================================================

# Адреса та порт
bind = "0.0.0.0:8000"

# Кількість worker процесів
# Рекомендація: (2 x CPU cores) + 1
# Для Render free tier: 2 workers
workers = 2

# Таймаут запиту (секунди)
# ✅ ЗБІЛЬШЕНО з 30 до 120 секунд для Google Classroom API
timeout = 120

# Час очікування keep-alive з'єднань
keepalive = 5

# Логування
errorlog = "-"   # Виводити в stderr
accesslog = "-"  # Виводити в stdout
loglevel = "info"

# Graceful timeout для перезапуску
graceful_timeout = 120

# Worker class
worker_class = "sync"

# Максимальна кількість запитів перед перезапуском worker
# Допомагає уникнути витоків пам'яті
max_requests = 1000
max_requests_jitter = 50
