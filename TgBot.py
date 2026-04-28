#!/usr/bin/env python3
"""
tg_bot.py — Telegram бот для CT College Bot
Запускати ОКРЕМО від app.py: python tg_bot.py

Встановлення:
  pip install python-telegram-bot --break-system-packages

Змінні оточення:
  TELEGRAM_BOT_TOKEN  — токен від @BotFather
  BACKEND_URL         — URL вашого Flask сервера (напр. https://ct-college-bot.onrender.com)
"""

import os
import logging
import base64
import requests
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import Application, CommandHandler, CallbackQueryHandler, ContextTypes

logging.basicConfig(
    format='%(asctime)s [%(levelname)s] %(name)s - %(message)s',
    level=logging.INFO
)
logger = logging.getLogger(__name__)

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

BOT_TOKEN   = os.getenv('TELEGRAM_BOT_TOKEN')
BACKEND_URL = os.getenv('BACKEND_URL', 'http://localhost:8000')

if not BOT_TOKEN:
    raise RuntimeError("TELEGRAM_BOT_TOKEN not set in environment!")

# ─────────────────────────────────────────────
# КОМАНДИ
# ─────────────────────────────────────────────

async def cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """
    /start — вітання
    /start link_<base64email> — підключення акаунту
    """
    args = context.args
    chat_id = update.effective_chat.id

    if args and args[0].startswith('link_'):
        encoded_email = args[0][5:]  # прибираємо "link_"
        try:
            email = base64.b64decode(encoded_email.encode()).decode('utf-8')
        except Exception:
            await update.message.reply_text("❌ Невірне посилання. Спробуйте знову з застосунку.")
            return

        # Відправляємо на бекенд
        try:
            resp = requests.post(f"{BACKEND_URL}/api/telegram/link", json={
                'encoded_email': encoded_email,
                'chat_id': chat_id,
                'notify_lessons': True,
                'notify_deadlines': True
            }, timeout=10)

            if resp.status_code == 200:
                # Бекенд сам відправить вітання через send_telegram_notification
                logger.info(f"✅ Linked {email} -> chat_id {chat_id}")
            elif resp.status_code == 404:
                await update.message.reply_text(
                    "❌ Акаунт не знайдено.\n\n"
                    "Будь ласка, спочатку увійдіть через Google у веб-застосунку:\n"
                    f"{BACKEND_URL}"
                )
            else:
                error_data = resp.json()
                await update.message.reply_text(f"❌ Помилка: {error_data.get('error', 'Unknown error')}")
        except requests.RequestException as e:
            logger.error(f"Backend error: {e}")
            await update.message.reply_text("❌ Сервер недоступний. Спробуйте пізніше.")
        return

    # Звичайний /start без параметрів
    keyboard = [[
        InlineKeyboardButton("📅 Розклад сьогодні", callback_data="schedule"),
        InlineKeyboardButton("⚠️ Дедлайни", callback_data="deadlines")
    ], [
        InlineKeyboardButton("⚙️ Налаштування", callback_data="settings")
    ]]
    reply_markup = InlineKeyboardMarkup(keyboard)

    await update.message.reply_text(
        "👋 <b>Привіт! Це CT College Bot</b>\n\n"
        "Я допомагаю студентам:\n"
        "📅 Нагадую про уроки (за 15 хв)\n"
        "⚠️ Попереджаю про дедлайни (за 24 год та 1 год)\n\n"
        "<b>Щоб підключитися:</b>\n"
        "Відкрийте застосунок → Профіль → «Підключити Telegram»",
        parse_mode='HTML',
        reply_markup=reply_markup
    )

async def cmd_schedule(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Надсилає розклад на сьогодні."""
    chat_id = update.effective_chat.id
    try:
        resp = requests.post(f"{BACKEND_URL}/api/telegram/webhook", json={
            'message': {'chat': {'id': chat_id}, 'text': '/schedule'}
        }, timeout=15)
    except Exception as e:
        await update.message.reply_text("❌ Сервер недоступний. Спробуйте пізніше.")

async def cmd_deadlines(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Надсилає найближчі дедлайни."""
    chat_id = update.effective_chat.id
    await update.message.reply_text("⏳ Завантажую дедлайни...")
    try:
        requests.post(f"{BACKEND_URL}/api/telegram/webhook", json={
            'message': {'chat': {'id': chat_id}, 'text': '/deadlines'}
        }, timeout=30)
    except Exception as e:
        await update.message.reply_text("❌ Сервер недоступний. Спробуйте пізніше.")

async def cmd_settings(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Налаштування сповіщень."""
    chat_id = update.effective_chat.id
    keyboard = [[
        InlineKeyboardButton("🔔 Уроки: ВКЛ", callback_data="toggle_lessons"),
        InlineKeyboardButton("⚠️ Дедлайни: ВКЛ", callback_data="toggle_deadlines")
    ], [
        InlineKeyboardButton("🔕 Відʼєднати бота", callback_data="confirm_stop")
    ]]
    await update.message.reply_text(
        "⚙️ <b>Налаштування сповіщень</b>\n\n"
        "Оберіть що хочете змінити:",
        parse_mode='HTML',
        reply_markup=InlineKeyboardMarkup(keyboard)
    )

async def cmd_stop(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Відʼєднати бота."""
    chat_id = update.effective_chat.id
    keyboard = [[
        InlineKeyboardButton("✅ Так, відʼєднати", callback_data="do_stop"),
        InlineKeyboardButton("❌ Скасувати", callback_data="cancel_stop")
    ]]
    await update.message.reply_text(
        "❓ Ви впевнені, що хочете відʼєднати бота?\n\n"
        "Ви більше не будете отримувати сповіщення.",
        reply_markup=InlineKeyboardMarkup(keyboard)
    )

async def cmd_help(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        "📖 <b>Команди бота:</b>\n\n"
        "/start — головне меню\n"
        "/schedule — розклад на сьогодні\n"
        "/deadlines — найближчі дедлайни\n"
        "/settings — налаштування сповіщень\n"
        "/stop — відʼєднати бота\n"
        "/help — ця довідка",
        parse_mode='HTML'
    )

# ─────────────────────────────────────────────
# CALLBACK КНОПКИ
# ─────────────────────────────────────────────

async def button_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    chat_id = update.effective_chat.id
    data = query.data

    if data == "schedule":
        await query.message.reply_text("⏳ Завантажую розклад...")
        try:
            requests.post(f"{BACKEND_URL}/api/telegram/webhook", json={
                'message': {'chat': {'id': chat_id}, 'text': '/schedule'}
            }, timeout=15)
        except Exception:
            await query.message.reply_text("❌ Сервер недоступний.")

    elif data == "deadlines":
        await query.message.reply_text("⏳ Завантажую дедлайни...")
        try:
            requests.post(f"{BACKEND_URL}/api/telegram/webhook", json={
                'message': {'chat': {'id': chat_id}, 'text': '/deadlines'}
            }, timeout=30)
        except Exception:
            await query.message.reply_text("❌ Сервер недоступний.")

    elif data == "settings":
        await cmd_settings(update, context)

    elif data == "confirm_stop" or data == "do_stop":
        if data == "confirm_stop":
            keyboard = [[
                InlineKeyboardButton("✅ Так, відʼєднати", callback_data="do_stop"),
                InlineKeyboardButton("❌ Скасувати", callback_data="cancel_stop")
            ]]
            await query.edit_message_text(
                "❓ Ви впевнені?",
                reply_markup=InlineKeyboardMarkup(keyboard)
            )
        else:
            try:
                requests.post(f"{BACKEND_URL}/api/telegram/webhook", json={
                    'message': {'chat': {'id': chat_id}, 'text': '/stop'}
                }, timeout=10)
                await query.edit_message_text("✅ Бота відʼєднано. До побачення!")
            except Exception:
                await query.edit_message_text("❌ Помилка. Спробуйте /stop")

    elif data == "cancel_stop":
        await query.edit_message_text("✅ Відміно. Бот продовжує роботу.")

# ─────────────────────────────────────────────
# MAIN
# ─────────────────────────────────────────────

def main():
    app = Application.builder().token(BOT_TOKEN).build()

    app.add_handler(CommandHandler("start",    cmd_start))
    app.add_handler(CommandHandler("schedule", cmd_schedule))
    app.add_handler(CommandHandler("deadlines",cmd_deadlines))
    app.add_handler(CommandHandler("settings", cmd_settings))
    app.add_handler(CommandHandler("stop",     cmd_stop))
    app.add_handler(CommandHandler("help",     cmd_help))
    app.add_handler(CallbackQueryHandler(button_callback))

    logger.info("🤖 CT College Bot запущено!")
    logger.info(f"🌐 Backend: {BACKEND_URL}")
    app.run_polling(allowed_updates=["message", "callback_query"])

if __name__ == '__main__':
    main()
