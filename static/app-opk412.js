// ===== CT COLLEGE BOT - ОПК-412 =====

// ===== КОНФІГУРАЦІЯ =====
const API_BASE = window.location.origin + '/api';;

// ===== КЛЮЧІ СХОВИЩА =====
const STORAGE_KEYS = {
  USER: 'ct_user_opk412',
  SCHEDULE: 'ct_schedule_opk412',
  HOMEWORK: 'ct_homework_opk412',
  THEME: 'ct_theme'
};

// ===== СТАН =====
let isLoggedIn = false;
let userData = null;
let scheduleData = {};
let homeworkData = [];
let coursesList = [];
let currentCourseId = null;
let showOnlySubmittable = true;
let expandedLessonId = null;

// ===== СПОВІЩЕННЯ =====
function showNotification(message, type = 'info') {
  console.log(`[${type.toUpperCase()}] ${message}`);
}

// ===== ІНІЦІАЛІЗАЦІЯ =====
document.addEventListener('DOMContentLoaded', function() {
  initializeTelegramWebApp();
  loadTheme();
  loadStorageData();
  loadUserFromCookie();
  handleOAuthCallback();
  checkAuth();
  initDateSelector();
  loadScheduleForCurrentDay();
  checkBackendHealth();
});

// ===== ПЕРЕВІРКА БЕКЕНДУ =====
async function checkBackendHealth() {
  try {
    const response = await fetch(`${API_BASE}/health`);
    if (response.ok) console.log('✅ Backend доступний');
    else console.warn('⚠️ Backend не відповідає');
  } catch (error) {
    console.error('❌ Backend не запущений! Запустіть: python app.py', error);
  }
}

// Допоміжна функція для читання cookie
function getCookie(name) {
  const value = `; ${document.cookie}`;
  const parts = value.split(`; ${name}=`);
  if (parts.length === 2) return parts.pop().split(';').shift();
  return null;
}

// Читаємо user_data з cookie при завантаженні (після redirect від Google)
function loadUserFromCookie() {
  const userDataCookie = getCookie('user_data');
  if (userDataCookie) {
    try {
      console.log('📥 Raw cookie value:', userDataCookie.substring(0, 50) + '...');
      
      // Декодуємо з base64
      const decodedJson = atob(userDataCookie);
      console.log('🔓 Decoded JSON:', decodedJson);
      
      userData = JSON.parse(decodedJson);
      
      isLoggedIn = true;
      localStorage.setItem(STORAGE_KEYS.USER, JSON.stringify(userData));
      console.log('✅ Loaded user from cookie:', userData.email);
      
      // Видаляємо cookie після читання (він більше не потрібен)
      document.cookie = 'user_data=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;';
      
      updateProfileView();
      return true;
    } catch(e) {
      console.error('❌ Failed to parse user cookie:', e);
      console.error('Cookie value:', userDataCookie);
    }
  } else {
    console.log('ℹ️ No user_data cookie found');
  }
  return false;
}
// ===== ОБРОБНИК OAUTH CALLBACK =====
async function handleOAuthCallback() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  const state = params.get('state');
  
  if (!code) return; // Не callback, звичайне завантаження
  
  console.log('🔄 Processing OAuth callback...');
  
  try {
    // Використовуємо точний redirect_uri, що збігається з Google Console
    const redirectUri = `${window.location.origin}/api/auth/google/callback`;
    console.log('📤 Sending to backend:', { code: code.substring(0, 20) + '...', redirectUri });
    
    const resp = await fetch(`${API_BASE}/auth/google/callback`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      credentials: 'include',
      body: JSON.stringify({
        code: code,
        redirect_uri: redirectUri
      })
    });
    
    console.log('📥 Backend response status:', resp.status);
    
    if (!resp.ok) {
      const errData = await resp.json().catch(() => ({error: 'Unknown error'}));
      console.error('❌ Backend error:', errData);
      throw new Error(errData.error || `HTTP ${resp.status}`);
    }
    
    const data = await resp.json();
    console.log('✅ Backend response:', data);
    
    if (!data.success || !data.user) {
      throw new Error(data.error || 'Auth failed');
    }
    
    // Зберігаємо дані користувача в localStorage
    userData = {
      name: data.user.name,
      email: data.user.email,
      picture: data.user.picture,
      role: data.user.role
    };
    isLoggedIn = true;
    localStorage.setItem(STORAGE_KEYS.USER, JSON.stringify(userData));
    
    console.log(`✅ Successfully logged in as ${userData.email}`);
    
    // Очищаємо URL від параметрів
    window.history.replaceState({}, document.title, window.location.pathname);
    
    // Оновлюємо UI
    updateProfileView();
    try { await fetchServerScheduleIfExists(userData.group || 'ОПК-412'); } catch(e){}
  } catch (error) {
    console.error('❌ OAuth callback error:', error);
    alert('❌ Помилка авторизації: ' + error.message);
    localStorage.removeItem(STORAGE_KEYS.USER);
    userData = null;
    isLoggedIn = false;
  }
}

// ===== TELEGRAM WEB APP =====
function initializeTelegramWebApp() {
  if (window.Telegram && window.Telegram.WebApp) {
    const tg = window.Telegram.WebApp;
    try { tg.ready(); } catch(e){}
    try { tg.expand(); } catch(e){}
    if (tg.colorScheme === 'dark') setTheme('dark');
  }
}

// ===== ТЕМА =====
function loadTheme() {
  const savedTheme = localStorage.getItem(STORAGE_KEYS.THEME) || 'light';
  setTheme(savedTheme);
}
function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const themeToggle = document.getElementById('themeToggle');
  if (themeToggle) themeToggle.textContent = theme === 'dark' ? '☀️' : '🌙';
  localStorage.setItem(STORAGE_KEYS.THEME, theme);
}
function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme');
  setTheme(current === 'dark' ? 'light' : 'dark');
}

// ===== СХОВИЩЕ =====
function loadStorageData() {
  const savedSchedule = localStorage.getItem(STORAGE_KEYS.SCHEDULE);
  if (savedSchedule) {
    try { scheduleData = JSON.parse(savedSchedule); } catch(e){ scheduleData = {'ОПК-412':[[],[],[],[],[]]}; }
  } else {
    scheduleData = {'ОПК-412':[[],[],[],[],[]]};
    saveScheduleData();
  }
  const savedHomework = localStorage.getItem(STORAGE_KEYS.HOMEWORK);
  if (savedHomework) {
    try { homeworkData = JSON.parse(savedHomework); } catch(e){ homeworkData = []; }
  } else homeworkData = [];
}
function saveScheduleData() {
  localStorage.setItem(STORAGE_KEYS.SCHEDULE, JSON.stringify(scheduleData));
}
function saveHomeworkData() {
  localStorage.setItem(STORAGE_KEYS.HOMEWORK, JSON.stringify(homeworkData));
}

// ===== GOOGLE OAUTH (ФРОНТЕНД) =====
function initGoogleAuth() {
  const container = document.getElementById('googleSignInBtn');
  if (!container) return;
  container.innerHTML = `
    <button class="btn btn-primary" onclick="loginWithGoogle()" style="padding: 12px 20px;">
      Увійти через Google Classroom
    </button>
  `;
}

async function loginWithGoogle() {
  try {
    const redirect_uri = `${window.location.origin}/api/auth/google/callback`;  // Автоматично визначає домен
    console.log('🔐 Requesting auth URL with redirect_uri:', redirect_uri);
    
    const response = await fetch(`${API_BASE}/auth/google`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ redirect_uri })
    });

    if (!response.ok) {
      throw new Error('Не вдалося запросити URL авторизації');
    }

    const data = await response.json();
    if (data.success && data.authUrl) {
      window.location.href = data.authUrl;
    } else {
      throw new Error('Не отримано URL авторизації');
    }
  } catch (error) {
    console.error('loginWithGoogle error', error);
    showNotification('Помилка авторизації: ' + error.message, 'error');
  }
}

// ===== СИНХРОНІЗАЦІЯ СТАНУ АВТОРИЗАЦІЇ =====
async function checkAuth() {
  const savedUser = localStorage.getItem(STORAGE_KEYS.USER);
  if (!savedUser) {
    initGoogleAuth();
    return;
  }
  try {
    userData = JSON.parse(savedUser);
  } catch(e){ userData = null; localStorage.removeItem(STORAGE_KEYS.USER); initGoogleAuth(); return; }

  try {
    const resp = await fetch(`${API_BASE}/auth/check?userId=${encodeURIComponent(userData.email)}`);
    if (resp.ok) {
      const j = await resp.json();
      if (j.present) {
        isLoggedIn = true;
        updateProfileView();
        // якщо є серверний розклад для групи — завантажуємо його
        try { await fetchServerScheduleIfExists(userData.group || 'ОПК-412'); } catch(e){}
        return;
      } else {
        localStorage.removeItem(STORAGE_KEYS.USER);
        localStorage.removeItem(STORAGE_KEYS.HOMEWORK);
        userData = null;
        isLoggedIn = false;
        initGoogleAuth();
        updateProfileView();
        return;
      }
    }
  } catch (e) {
    console.warn('checkAuth backend check failed', e);
    isLoggedIn = true;
    updateProfileView();
    try { await fetchServerScheduleIfExists(userData.group || 'ОПК-412'); } catch(e){}
  }
}

// Спроба отримати розклад з сервера (якщо є) та замінити локальний
async function fetchServerScheduleIfExists(group='ОПК-412') {
  try {
    const resp = await fetch(`${API_BASE}/schedule/group?group=${encodeURIComponent(group)}`);
    if (!resp.ok) return;
    const j = await resp.json();
    if (j && j.success && j.schedule) {
      scheduleData[group] = j.schedule;
      saveScheduleData();
      loadScheduleForCurrentDay();
      console.log('Синхронизовано розклад з сервера для групи', group);
    }
  } catch (e) {
    console.warn('fetchServerScheduleIfExists failed', e);
  }
}

// ===== ПРОФІЛЬ КОРИСТУВАЧА =====
function updateProfileView() {
  const loggedIn = document.getElementById('loggedInProfile');
  const login = document.getElementById('loginProfile');
  const profileCard = document.getElementById('profileCard');

  if (isLoggedIn && userData) {
    if (loggedIn) loggedIn.style.display = 'block';
    if (login) login.style.display = 'none';
    if (profileCard) profileCard.style.display = 'block';

    const nameEl = document.getElementById('profileName');
    const emailEl = document.getElementById('profileEmail');
    const avatarEl = document.getElementById('userAvatar');
    const statsEl = document.getElementById('profileStats');

    if (nameEl) nameEl.textContent = userData.name;
    if (emailEl) emailEl.textContent = userData.email;
    if (avatarEl) {
      if (userData.picture) avatarEl.innerHTML = `<img src="${userData.picture}" alt="Avatar">`;
      else avatarEl.textContent = (userData.name || 'U').split(' ').map(n=>n[0]).join('').substring(0,2).toUpperCase();
    }

    let overdueCount = 0;
    try { overdueCount = JSON.parse(localStorage.getItem(STORAGE_KEYS.HOMEWORK)||'[]').filter(h=>h.status==='overdue').length; } catch(e){ overdueCount=0; }
    if (statsEl) statsEl.textContent = `Просрочено завдань: ${overdueCount}`;

    if (userData.role === 'admin') {
      const adminPanel = document.getElementById('adminPanel');
      if (adminPanel) adminPanel.style.display = 'block';
    }
  } else {
    if (loggedIn) loggedIn.style.display = 'none';
    if (login) login.style.display = 'block';
    if (profileCard) profileCard.style.display = 'none';
    initGoogleAuth();
  }
}

// ===== ВИХІД =====
function logout() {
  if (!isLoggedIn || !userData) {
    localStorage.removeItem(STORAGE_KEYS.USER);
    localStorage.removeItem(STORAGE_KEYS.HOMEWORK);
    isLoggedIn = false;
    userData = null;
    updateProfileView();
    return;
  }
  if (!confirm('Ви впевнені, що хочете вийти?')) return;
  fetch(`${API_BASE}/auth/logout`, {
    method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({userId: userData.email})
  }).catch(e=>console.warn('logout backend failed',e)).finally(()=>{
    localStorage.removeItem(STORAGE_KEYS.USER);
    localStorage.removeItem(STORAGE_KEYS.HOMEWORK);
    isLoggedIn = false;
    userData = null;
    updateProfileView();
  });
}

// ===== GOOGLE CLASSROOM: КУРСИ / ЗАВДАННЯ =====
async function loadCourses() {
  if (!isLoggedIn || !userData) { console.log('not logged in'); return; }
  const container = document.getElementById('homeworkContent');
  container.innerHTML = `<div class="loading"><div class="spinner"></div><p>Завантаження курсів...</p></div>`;
  try {
    const resp = await fetch(`${API_BASE}/classroom/courses?userId=${encodeURIComponent(userData.email)}`);
    if (!resp.ok) { const e = await resp.json().catch(()=>({error:'HTTP'})); throw new Error(e.error||`HTTP ${resp.status}`); }
    const j = await resp.json();
    coursesList = j.courses || [];
    renderCoursesList();
  } catch (e) {
    console.error('loadCourses failed', e);
    container.innerHTML = `<div class="empty-state"><h3>Не вдалося завантажити курси</h3><p>${e.message}</p></div>`;
  }
}
function renderCoursesList() {
  const container = document.getElementById('homeworkContent');
  if (!coursesList || coursesList.length === 0) {
    container.innerHTML = `<div class="empty-state"><div class="empty-state-icon">📚</div><h3>Курси не знайдені</h3><p>Можливо, ви ще не підключали Google Classroom.</p></div>`;
    return;
  }
  let html = `<div style="display:flex; gap:10px; align-items:center; margin-bottom:12px;">
      <div style="font-weight:700;">Курси:</div>
      <label style="margin-left:auto; display:flex; gap:8px; align-items:center;">
        <input type="checkbox" id="submittableToggle" ${showOnlySubmittable?'checked':''} onchange="toggleSubmittableFilter(this.checked)">
        <span>Показывать только сдаваемые</span>
      </label>
    </div>
    <div id="coursesList" style="display:flex; flex-direction:column; gap:8px; margin-bottom:16px;"></div>
    <div id="courseAssignments"></div>`;
  container.innerHTML = html;
  const listEl = document.getElementById('coursesList');
  coursesList.forEach(c=>{
    const item = document.createElement('div');
    item.className='homework-card';
    item.style.cursor='pointer';
    item.onclick = ()=>{ currentCourseId = c.id; loadAssignmentsForCourse(c.id,c.name); document.querySelectorAll('#coursesList .homework-card').forEach(el=>el.style.opacity='0.6'); item.style.opacity='1'; };
    item.innerHTML = `<div style="display:flex; justify-content:space-between; align-items:center;"><div style="font-weight:700;">${c.name}</div><div style="font-size:13px; color:var(--text-secondary)">${c.section||''}</div></div>`;
    listEl.appendChild(item);
  });
}
function toggleSubmittableFilter(checked) { showOnlySubmittable = checked; if (currentCourseId) loadAssignmentsForCourse(currentCourseId); }

async function loadAssignmentsForCourse(courseId, courseName='') {
  if (!isLoggedIn || !userData) return;
  const container = document.getElementById('courseAssignments');
  container.innerHTML = `<div class="loading"><div class="spinner"></div><p>Завантаження завдань...</p></div>`;
  try {
    const resp = await fetch(`${API_BASE}/classroom/coursework?userId=${encodeURIComponent(userData.email)}&courseId=${encodeURIComponent(courseId)}&submittable=${showOnlySubmittable}`);
    if (!resp.ok) { const e = await resp.json().catch(()=>({error:'HTTP'})); throw new Error(e.error||`HTTP ${resp.status}`); }
    const j = await resp.json();
    const assignments = j.assignments || [];
    if (assignments.length === 0) {
      container.innerHTML = `<div class="empty-state"><div class="empty-state-icon">📭</div><h3>Немає завдань</h3><p>Для даного курсу немає доступних завдань.</p></div>`;
      return;
    }
    let html = `<h3 style="margin-bottom:12px;">Завдання${courseName? ' — '+courseName : ''}</h3>`;
    assignments.forEach(hw=>{
      const deadline = hw.deadline? new Date(hw.deadline).toLocaleString('uk-UA') : 'Без дедлайну';
      const safeLink = hw.alternateLink && /^https?:\/\//i.test(hw.alternateLink) ? hw.alternateLink : null;
      html += `<div class="homework-card status-${hw.status}"><div class="homework-header"><div class="homework-subject">${courseName||''}</div><div class="homework-status status-${hw.status}">${hw.status}</div></div><div class="homework-title">${hw.title}</div><div style="font-size:13px; color:var(--text-secondary); margin-top:8px;">${hw.description? (hw.description.length>200? hw.description.slice(0,200)+'…': hw.description) : ''}</div><div class="homework-deadline">📅 ${deadline}</div><div style="margin-top:10px; display:flex; gap:8px;">${safeLink ? `<a href="${safeLink}" target="_blank" rel="noopener noreferrer" style="text-decoration: none;"><button class="btn btn-secondary">🔗 Відкрити в Classroom</button></a>` : `<button class="btn btn-secondary" disabled style="opacity: 0.5; cursor: not-allowed;">Немає посилання</button>`}</div></div>`;
    });
    container.innerHTML = html;
  } catch(e) {
    console.error('loadAssignmentsForCourse failed', e);
    container.innerHTML = `<div class="empty-state"><h3>Ошибка загрузки заданий</h3><p>${e.message}</p></div>`;
  }
}

// ===== ЗАВАНТАЖЕННЯ ДОМАШНІХ ЗАВДАНЬ =====
function loadHomework() {
  const container = document.getElementById('homeworkContent');
  if (!isLoggedIn || !userData) {
    if (container) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">🔐</div>
          <h3>Увійдіть для перегляду завдань</h3>
          <p>Натисніть "Увійти через Google Classroom" у Профілі.</p>
        </div>
      `;
    }
    try { initGoogleAuth(); } catch(e){}
    return;
  }

  if (container) container.innerHTML = `<div class="loading"><div class="spinner"></div><p>Завантаження курсів...</p></div>`;

  try {
    if (typeof loadCourses === 'function') {
      loadCourses();
    } else {
      if (container) {
        container.innerHTML = `
          <div class="empty-state">
            <div class="empty-state-icon">📚</div>
            <h3>Курси тимчасово недоступні</h3>
            <p>Спробуйте перезавантажити сторінку або повторити вхід.</p>
          </div>
        `;
      }
      console.warn('loadCourses not defined');
    }
  } catch (err) {
    console.error('loadHomework error', err);
    if (container) container.innerHTML = `<div class="empty-state"><h3>Помилка при завантаженні</h3><p>${err && err.message ? err.message : ''}</p></div>`;
  }
}
try { if (typeof loadHomework === 'function') window.loadHomework = loadHomework; } catch(e){}

// ===== УТИЛІТИ: парсинг локальний, завантаження, експорт розкладу =====
async function parseLocalSchedule(){
  try {
    const resp = await fetch(`${API_BASE}/schedule/parse-local`, {method:'POST'});
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const j = await resp.json();
    if (j.error) throw new Error(j.error);
    scheduleData['ОПК-412'] = j.schedule;
    saveScheduleData();
    loadScheduleForCurrentDay();
    showNotification('Розклад успішно завантажено','success');
  } catch(e){ console.error('parseLocalSchedule',e); showNotification('Помилка: '+e.message,'error'); }
}
async function handleExcelUpload(e) {
  const file = e.target.files[0];
  if (!file) return;

  // Перевірка типу файлу
  if (!file.name.match(/\.(xlsx|xls)$/)) {
    alert('Будь ласка, завантажте файл Excel (.xlsx або .xls)');
    return;
  }

  try {
    showNotification('Завантаження та парсинг файлу...', 'info');
    
    // Створюємо FormData для відправки файлу
    const fd = new FormData();
    fd.append('file', file);
    fd.append('group', 'ОПК-412');

    // Відправляємо файл на сервер для парсингу
    const resp = await fetch(`${API_BASE}/schedule/upload`, {
      method: 'POST',
      body: fd
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({error: 'HTTP'}));
      throw new Error(err.error || `HTTP ${resp.status}`);
    }

    const j = await resp.json();
    
    if (j.error) {
      throw new Error(j.error);
    }

    // Зберігаємо розпарсений розклад локально
    scheduleData['ОПК-412'] = j.schedule;
    saveScheduleData();
    loadScheduleForCurrentDay();
    
    showNotification('Розклад успішно завантажено!', 'success');

    // Пропонуємо адміну зберегти на сервер
    if (userData && userData.role === 'admin') {
      if (confirm('Файл успішно завантажено та розпарсено!\n\nБажаєте зберегти цей розклад на сервері для всіх користувачів?\n\n✅ Так - розклад буде доступний всім\n❌ Ні - розклад залишиться лише у вас локально')) {
        try {
          await saveScheduleToServer();
          alert('✅ Розклад успішно збережено на сервері для всіх користувачів!');
        } catch (saveErr) {
          console.error('Помилка збереження на сервер:', saveErr);
          alert('⚠️ Розклад завантажено локально, але не вдалося зберегти на сервер:\n' + saveErr.message);
        }
      }
    }

    // Очищаємо input для можливості повторного завантаження того самого файлу
    e.target.value = '';

  } catch (error) {
    console.error('handleExcelUpload error:', error);
    showNotification('Помилка завантаження: ' + error.message, 'error');
    alert('❌ Помилка при завантаженні файлу:\n\n' + error.message + '\n\nПеревірте:\n• Файл у форматі .xlsx або .xls\n• Структура файлу відповідає очікуваній\n• Сервер запущено (python app.py)');
    
    // Очищаємо input навіть при помилці
    e.target.value = '';
  }
}

// ===== АЛЬТЕРНАТИВА: КЛІЄНТСЬКИЙ ПАРСИНГ (якщо сервер недоступний) =====
// Ця функція парсить Excel прямо у браузері за допомогою SheetJS

async function handleExcelUploadClientSide(e) {
  const file = e.target.files[0];
  if (!file) return;

  if (!file.name.match(/\.(xlsx|xls)$/)) {
    alert('Будь ласка, завантажте файл Excel (.xlsx або .xls)');
    return;
  }

  try {
    showNotification('Парсинг файлу у браузері...', 'info');

    // Читаємо файл як ArrayBuffer
    const arrayBuffer = await file.arrayBuffer();
    
    // Парсимо за допомогою SheetJS (бібліотека вже підключена в HTML)
    const workbook = XLSX.read(arrayBuffer, { type: 'array' });
    const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
    
    // Перетворюємо на JSON
    const jsonData = XLSX.utils.sheet_to_json(firstSheet, { header: 1 });
    
    console.log('Дані з Excel:', jsonData);

    // Тут потрібно додати логіку парсингу для вашого формату
    // Це спрощений приклад - адаптуйте під свою структуру
    const schedule = parseScheduleFromData(jsonData);

    scheduleData['ОПК-412'] = schedule;
    saveScheduleData();
    loadScheduleForCurrentDay();
    
    showNotification('Розклад завантажено!', 'success');

    if (userData && userData.role === 'admin') {
      if (confirm('Бажаєте зберегти на сервері?')) {
        await saveScheduleToServer();
      }
    }

    e.target.value = '';

  } catch (error) {
    console.error('Client-side parsing error:', error);
    showNotification('Помилка: ' + error.message, 'error');
    alert('❌ Помилка парсингу файлу:\n' + error.message);
    e.target.value = '';
  }
}

// Допоміжна функція для парсингу даних
function parseScheduleFromData(data) {
  // Це приклад - адаптуйте під свою структуру Excel
  const schedule = [[], [], [], [], []]; // 5 днів тижня
  
  // Тут потрібно додати логіку парсингу для вашого формату
  
  return schedule;
}

function showNotification(message, type = 'info') {
  console.log(`[${type.toUpperCase()}] ${message}`);
  
  // Створюємо візуальне сповіщення
  const notification = document.createElement('div');
  notification.style.position = 'fixed';
  notification.style.top = '80px';
  notification.style.right = '20px';
  notification.style.padding = '16px 20px';
  notification.style.borderRadius = '12px';
  notification.style.zIndex = '999999';
  notification.style.boxShadow = '0 4px 16px rgba(0,0,0,0.2)';
  notification.style.maxWidth = '400px';
  notification.style.animation = 'slideIn 0.3s ease-out';
  
  // Стилі залежно від типу
  const styles = {
    'success': { bg: '#34C759', icon: '✅' },
    'error': { bg: '#FF3B30', icon: '❌' },
    'info': { bg: '#007AFF', icon: 'ℹ️' },
    'warning': { bg: '#FFB800', icon: '⚠️' }
  };
  
  const style = styles[type] || styles['info'];
  notification.style.background = style.bg;
  notification.style.color = 'white';
  notification.innerHTML = `<strong>${style.icon} ${message}</strong>`;
  
  document.body.appendChild(notification);
  
  // Видаляємо через 3 секунди
  setTimeout(() => {
    notification.style.animation = 'slideOut 0.3s ease-in';
    setTimeout(() => notification.remove(), 300);
  }, 3000);
}

// CSS анімації
const style = document.createElement('style');
style.textContent = `
  @keyframes slideIn {
    from {
      transform: translateX(400px);
      opacity: 0;
    }
    to {
      transform: translateX(0);
      opacity: 1;
    }
  }
  
  @keyframes slideOut {
    from {
      transform: translateX(0);
      opacity: 1;
    }
    to {
      transform: translateX(400px);
      opacity: 0;
    }
  }
`;
document.head.appendChild(style);

function exportSchedule(){
  const data = JSON.stringify(scheduleData['ОПК-412']||[], null, 2);
  const blob = new Blob([data], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = 'schedule-opk412.json'; a.click(); URL.revokeObjectURL(url);
}

// ===== РОЗКЛАД / ЗАНЯТТЯ (розгортання + посилання на конференції) =====
function extractMeetingLink(lesson) {
  if (!lesson) return null;
  const candidates = [];
  function pushUrls(txt) {
    if (!txt || typeof txt !== 'string') return;
    const withProto = txt.match(/https?:\/\/[^\s'"]+/gi);
    if (withProto) withProto.forEach(u=>candidates.push(u));
    const bare = txt.match(/\b(?:zoom\.us\/[^\s'"]+|us02web\.zoom\.us\/[^\s'"]+|meet\.google\.com\/[^\s'"]+|teams\.microsoft\.com\/[^\s'"]+|zoom\.com\/[^\s'"]+)\b/gi);
    if (bare) bare.forEach(b=>candidates.push(b));
  }
  const fields = ['conference','conferenceUrl','link','zoom','joinUrl','join_url','conference_link','meetingUrl','url','notes','info','summary'];
  fields.forEach(f=>{
    const v = lesson[f];
    if (!v) return;
    if (typeof v === 'string') pushUrls(v);
    else if (typeof v === 'object') {
      const sub = v.joinUrl || v.join_url || v.link || v.url || v.entryPoint || v['conferenceUrl'];
      if (sub && typeof sub === 'string') pushUrls(sub);
      if (v.description) pushUrls(String(v.description));
    }
  });
  pushUrls(lesson.title||''); pushUrls(lesson.description||''); pushUrls(lesson.teacher||'');
  if (candidates.length===0) { try { pushUrls(JSON.stringify(lesson)); } catch(e){} }
  if (candidates.length>0) {
    let url = candidates[0];
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    return url;
  }
  return null;
}

function loadScheduleForDay(dayIndex) {
  const lessons = scheduleData['ОПК-412']?.[dayIndex] || [];
  const container = document.getElementById('scheduleContent');
  if (!lessons || lessons.length === 0) {
    if (container) container.innerHTML = `<div class="empty-state"><div class="empty-state-icon">📅</div><p>Немає занять на цей день</p></div>`;
    return;
  }
  let html = '';
  lessons.forEach((lesson, i)=>{
    const id = `lesson-${dayIndex}-${i}`;
    const link = extractMeetingLink(lesson);
    const desc = lesson.description? String(lesson.description) : '';
    const shortDesc = desc.length>200? desc.slice(0,200)+'…': desc;
    const showRoom = lesson.room && lesson.room !== 'Не вказано';
    html += `<div class="lesson-card" id="${id}" data-lesson-id="${id}" style="cursor:pointer;">
      <div class="lesson-main" data-lesson-id="${id}" style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;">
        <div style="flex:1;">
          <div class="lesson-header" style="display:flex;justify-content:space-between;align-items:center;">
            <span class="lesson-time">${lesson.time||''}</span>
            <span class="lesson-type">${lesson.type||''}</span>
          </div>
          <div class="lesson-title" style="margin-top:6px; font-weight:600;">${lesson.title||''}${link? ' <span style="margin-left:8px;">🔗</span>':''}</div>
          <div class="lesson-summary" style="font-size:13px; color:var(--text-secondary); margin-top:8px;">${shortDesc}</div>
          <div class="lesson-meta" style="font-size:13px; color:var(--text-secondary); margin-top:8px;">
            ${lesson.teacher? `<span style="display:inline-block; margin-right:12px;">👤 ${lesson.teacher}</span>` : ''}
            ${showRoom? `<span style="display:inline-block;">🚪 ${lesson.room}</span>` : ''}
          </div>
        </div>
        <div style="margin-left:12px; display:flex; flex-direction:column; gap:8px; align-items:flex-end;">
          ${link? `<a class="join-link" href="${link}" target="_blank" rel="noopener noreferrer"><button class="btn btn-primary">Приєднатися</button></a>` : `<div style="height:40px;"></div>`}
          <button class="btn btn-secondary toggle-details-btn" data-lesson-id="${id}" aria-expanded="false" style="padding:8px 10px;">Деталі</button>
        </div>
      </div>
      <div class="lesson-details-panel" id="${id}-panel" style="display:none; margin-top:12px; padding-top:12px; border-top:1px solid var(--border);">
        <div style="font-size:13px; color:var(--text-secondary); line-height:1.4;">
          ${lesson.description? `<div style="margin-bottom:8px;">${lesson.description}</div>` : ''}
          ${link? `<div style="margin-bottom:8px;"><strong>Посилання:</strong> <a href="${link}" target="_blank" rel="noopener noreferrer">${link}</a></div>` : `<div style="margin-bottom:8px;"><em>Посилання не знайдено</em></div>`}
          ${lesson.teacher? `<div><strong>Викладач:</strong> ${lesson.teacher}</div>` : ''}
          ${showRoom? `<div><strong>Кабінет:</strong> ${lesson.room}</div>` : ''}
        </div>
      </div>
    </div>`;
  });
  container.innerHTML = html;
  attachLessonHandlers();
}

function attachLessonHandlers() {
  const container = document.getElementById('scheduleContent');
  if (!container) return;
  if (container._lessonClickHandler) container.removeEventListener('click', container._lessonClickHandler);
  container._lessonClickHandler = function(ev) {
    const join = ev.target.closest('.join-link');
    if (join) return;
    const toggle = ev.target.closest('.toggle-details-btn');
    if (toggle) { const id = toggle.dataset.lessonId; if (id) toggleLessonExpand(id); return; }
    const main = ev.target.closest('.lesson-main');
    if (main) { const id = main.dataset.lessonId; if (id) toggleLessonExpand(id); }
  };
  container.addEventListener('click', container._lessonClickHandler);
}
function toggleLessonExpand(lessonId) {
  if (expandedLessonId && expandedLessonId !== lessonId) {
    const prev = document.getElementById(`${expandedLessonId}-panel`);
    const prevBtn = document.querySelector(`[data-lesson-id="${expandedLessonId}"].toggle-details-btn`);
    if (prev) prev.style.display = 'none';
    if (prevBtn) prevBtn.setAttribute('aria-expanded','false');
  }
  const panel = document.getElementById(`${lessonId}-panel`);
  const btn = document.querySelector(`[data-lesson-id="${lessonId}"].toggle-details-btn`);
  if (!panel) return;
  const hidden = panel.style.display === 'none' || panel.style.display === '';
  panel.style.display = hidden ? 'block' : 'none';
  if (btn) btn.setAttribute('aria-expanded', hidden ? 'true' : 'false');
  expandedLessonId = hidden ? lessonId : null;
  if (hidden) try { panel.scrollIntoView({behavior:'smooth', block:'center'}); } catch(e){}
}

// ===== ВИПРАВЛЕННЯ НАВІГАЦІЇ (перевизначення inline onclick) =====
(function overrideBottomNavHandlers(){
  function activate(tab){
    document.querySelectorAll('.tab-content').forEach(t=>t.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active'));
    if (tab==='schedule'){ document.getElementById('scheduleTab').classList.add('active'); document.querySelectorAll('.nav-item')[0]?.classList.add('active'); }
    else if (tab==='homework'){ document.getElementById('homeworkTab').classList.add('active'); document.querySelectorAll('.nav-item')[1]?.classList.add('active'); if (typeof loadHomework==='function') try{loadHomework()}catch(e){} }
    else if (tab==='profile'){ document.getElementById('profileTab').classList.add('active'); document.querySelectorAll('.nav-item')[2]?.classList.add('active'); if (typeof updateProfileView==='function') try{updateProfileView()}catch(e){} }
  }
  function init(){
    const nav = Array.from(document.querySelectorAll('.nav-item'));
    if (!nav.length) return;
    nav.forEach(n=>{ try{ n.onclick = null }catch(e){} n.style.cursor='pointer'; });
    const tabs = ['schedule','homework','profile'];
    nav.forEach((el, idx)=> el.addEventListener('click', ev=>{ try{ev.preventDefault()}catch(e){} activate(tabs[idx]||'schedule'); }, false));
    const activeNav = document.querySelector('.nav-item.active') || nav[0];
    activate(tabs[nav.indexOf(activeNav)]||'schedule');
  }
  if (document.readyState==='loading') document.addEventListener('DOMContentLoaded', init); else init();
})();

// ===== АДМІН: редактор UI + збереження на сервер =====
async function openScheduleLinkEditor(group='ОПК-412') {
  try {
    // отримуємо розклад з сервера, якщо є, інакше локальний
    let schedule = scheduleData[group] || [];
    try {
      const resp = await fetch(`${API_BASE}/schedule/group?group=${encodeURIComponent(group)}`);
      if (resp.ok) {
        const j = await resp.json();
        if (j && j.success && j.schedule) schedule = j.schedule;
      }
    } catch(e){
      console.warn('Server schedule fetch failed', e);
    }

    // відображаємо модальне вікно
    renderScheduleEditor(group, schedule);
  } catch (e) {
    console.error('openScheduleLinkEditor', e);
    alert('Не вдалося відкрити редактор: ' + e.message);
  }
}

function renderScheduleEditor(group, schedule) {
  // видаляємо існуючий
  const old = document.getElementById('schedule-editor');
  if (old) old.remove();

  const overlay = document.createElement('div');
  overlay.id = 'schedule-editor';
  overlay.style.position = 'fixed';
  overlay.style.left = '0';
  overlay.style.top = '0';
  overlay.style.right = '0';
  overlay.style.bottom = '0';
  overlay.style.background = 'rgba(0,0,0,0.35)';
  overlay.style.zIndex = '999999';
  overlay.style.display = 'flex';
  overlay.style.alignItems = 'center';
  overlay.style.justifyContent = 'center';
  overlay.innerHTML = `
    <div style="width:900px; max-width:95%; max-height:90%; overflow:auto; background:white; border-radius:12px; padding:16px;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
        <h3 style="margin:0">Редактор посилань — ${group}</h3>
        <div>
          <button id="saveEditorBtn" class="btn btn-primary" style="margin-right:8px;">Зберегти (локально)</button>
          <button id="saveServerEditorBtn" class="btn btn-secondary" style="margin-right:8px;">Зберегти на сервер</button>
          <button id="closeEditorBtn" class="btn">Закрити</button>
        </div>
      </div>
      <div id="schedule-editor-body"></div>
    </div>
  `;
  document.body.appendChild(overlay);

  // Закриття при кліку на затемнений фон (АЛЕ НЕ на само модальне вікно)
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      overlay.remove();
    }
  });

  document.getElementById('closeEditorBtn').onclick = (e) => {
    e.stopPropagation();
    overlay.remove();
  };
  document.getElementById('saveEditorBtn').onclick = (e) => {
    e.stopPropagation();
    // збираємо відредагований розклад з DOM
    const newSchedule = readScheduleFromEditor();
    scheduleData[group] = newSchedule;
    saveScheduleData();
    loadScheduleForCurrentDay();
    alert('Розклад збережено локально.');
  };
  document.getElementById('saveServerEditorBtn').onclick = async (e) => {
    e.stopPropagation();
    const newSchedule = readScheduleFromEditor();
    scheduleData[group] = newSchedule;
    saveScheduleData();
    try {
      await saveScheduleToServer(group);
      alert('Розклад збережено на сервері.');
    } catch (e) {
      alert('Не вдалося зберегти на сервері: ' + e.message);
    }
  };

  // будуємо тіло редактора: дні та заняття
  const body = document.getElementById('schedule-editor-body');
  const days = ['Понеділок','Вівторок','Середа','Четвер','П\'ятниця'];
  body.innerHTML = '';
  for (let d = 0; d < 5; d++) {
    const dayLessons = schedule[d] || [];
    const dayDiv = document.createElement('div');
    dayDiv.style.marginBottom = '12px';
    dayDiv.innerHTML = `<h4 style="margin-bottom:8px;">${days[d]} (${dayLessons.length} пар)</h4>`;
    dayLessons.forEach((les, idx) => {
      const linkVal = les.conference || '';
      const title = les.title || `${les.time || ''} ${les.title || ''}`;
      const lessonRow = document.createElement('div');
      lessonRow.style.display = 'flex';
      lessonRow.style.gap = '8px';
      lessonRow.style.alignItems = 'center';
      lessonRow.style.marginBottom = '6px';
      lessonRow.innerHTML = `
        <div style="flex:1;">
          <div style="font-weight:600;">${idx+1}. ${title}</div>
          <div style="font-size:13px; color:#666;">${les.teacher || ''} ${les.room? ' • ' + les.room : ''}</div>
        </div>
        <input data-day="${d}" data-idx="${idx}" class="editor-link-input" type="text" value="${linkVal}" placeholder="Посилання на конференцію (https://...)" style="flex:0 0 420px; padding:8px; border:1px solid #ddd; border-radius:8px;"/>
        <button class="btn btn-secondary editor-apply-btn" data-day="${d}" data-idx="${idx}">Зберегти</button>
      `;
      dayDiv.appendChild(lessonRow);
    });
    body.appendChild(dayDiv);
  }

  // поведінка кнопок застосування: оновлюємо змінну розкладу (в DOM)
  body.querySelectorAll('.editor-apply-btn').forEach(btn => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const d = Number(btn.dataset.day);
      const idx = Number(btn.dataset.idx);
      const input = body.querySelector(`.editor-link-input[data-day="${d}"][data-idx="${idx}"]`);
      const val = input.value.trim();
      if (!schedule[d]) schedule[d] = [];
      schedule[d][idx] = schedule[d][idx] || {};
      if (val) schedule[d][idx].conference = val;
      else delete schedule[d][idx].conference;
      input.style.borderColor = '#4CAF50';
      setTimeout(()=> input.style.borderColor = '#ddd', 800);
    });
  });
}

function readScheduleFromEditor() {
  // читаємо значення з DOM
  const body = document.getElementById('schedule-editor-body');
  if (!body) return scheduleData['ОПК-412'] || [];
  // реконструюємо, скануючи inputs
  const inputs = Array.from(body.querySelectorAll('.editor-link-input'));
  // клонуємо існуючий розклад для збереження полів
  const group = 'ОПК-412';
  const base = (scheduleData[group] && Array.isArray(scheduleData[group])) ? JSON.parse(JSON.stringify(scheduleData[group])) : [[],[],[],[],[]];
  inputs.forEach(inp => {
    const d = Number(inp.dataset.day);
    const idx = Number(inp.dataset.idx);
    const val = inp.value.trim();
    base[d] = base[d] || [];
    base[d][idx] = base[d][idx] || {};
    if (val) base[d][idx].conference = val;
    else delete base[d][idx].conference;
  });
  return base;
}

async function saveScheduleToServer(group='ОПК-412') {
  if (!userData || !userData.email) throw new Error('Спочатку увійдіть');
  const payload = {
    userId: userData.email,
    group: group,
    schedule: scheduleData[group] || []
  };
  const resp = await fetch(`${API_BASE}/schedule/save`, {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify(payload)
  });
  if (!resp.ok) {
    const err = await resp.json().catch(()=>({error:'HTTP'}));
    throw new Error(err.error || `HTTP ${resp.status}`);
  }
  const j = await resp.json();
  if (!j.success) throw new Error('save failed');
  return j;
}

// ===== КІНЕЦЬ РЕДАКТОРА РОЗКЛАДУ =====

// ===== ВИБІР ДАТИ =====
function initDateSelector(){
  const days = ['Понеділок','Вівторок','Середа','Четвер','П\'ятниця'];
  const daysShort = ['Пн','Вт','Ср','Чт','Пт'];
  const container = document.getElementById('dateSelector');
  if (!container) return;
  const today = new Date(); const current = today.getDay();
  const active = (current>=1 && current<=5)? current-1 : 0;
  container.innerHTML=''; daysShort.forEach((d,i)=>{
    const btn = document.createElement('div'); btn.className='date-btn'+(i===active?' active':''); btn.innerHTML=`<div class="day">${d}</div>`;
    btn.onclick = ()=>{ document.querySelectorAll('.date-btn').forEach(b=>b.classList.remove('active')); btn.classList.add('active'); loadScheduleForDay(i); };
    container.appendChild(btn);
  });
  loadScheduleForDay(active);
}
function loadScheduleForCurrentDay(){ const today = new Date(); const d = today.getDay(); const idx = (d>=1 && d<=5)? d-1 : 0; loadScheduleForDay(idx); }

// ===== БЕЗПЕЧНИЙ ЕКСПОРТ =====
try {
  if (typeof switchTab === 'function') window.switchTab = switchTab;
  if (typeof loadHomework === 'function') window.loadHomework = loadHomework;
  if (typeof updateProfileView === 'function') window.updateProfileView = updateProfileView;
  if (typeof initGoogleAuth === 'function') window.initGoogleAuth = initGoogleAuth;
} catch(e){ console.warn('export failed', e); }
