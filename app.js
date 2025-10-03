// frontend/js/app.js
// Инициализация Telegram Web App
const tg = window.Telegram.WebApp;

// Инициализируем приложение
tg.expand(); // Раскрываем на весь экран
tg.enableClosingConfirmation(); // Подтверждение закрытия

// Получаем информацию о пользователе
const user = tg.initDataUnsafe.user;
if (user) {
    console.log('Пользователь:', user);
}

// Логика переключения вкладок
document.addEventListener('DOMContentLoaded', function() {
    const navButtons = document.querySelectorAll('.nav-btn');
    const tabContents = document.querySelectorAll('.tab-content');
    
    navButtons.forEach(button => {
        button.addEventListener('click', function() {
            const tabId = this.getAttribute('data-tab');
            
            // Убираем активный класс у всех кнопок и вкладок
            navButtons.forEach(btn => btn.classList.remove('active'));
            tabContents.forEach(content => content.classList.remove('active'));
            
            // Добавляем активный класс текущим элементам
            this.classList.add('active');
            document.getElementById(tabId).classList.add('active');
        });
    });
    
    // Имитация загрузки данных
    loadSchedule();
    loadHomework();
});

// Загрузка расписания (заглушка)
function loadSchedule() {
    console.log('Загрузка расписания...');
    // Здесь будет реальный API запрос
}

// Загрузка заданий (заглушка)
function loadHomework() {
    console.log('Загрузка домашних заданий...');
    // Здесь будет реальный API запрос
}

// Функция для отправки данных в бота
function sendDataToBot(data) {
    tg.sendData(JSON.stringify(data));
}