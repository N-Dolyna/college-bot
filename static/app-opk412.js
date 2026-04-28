// ===== CT COLLEGE BOT — ОПК-412 (PATCHED v2) =====
// Fixes: BUG-01 (дубль loadUserFromCookie), BUG-02 (await loadCourses),
//        BUG-03 (coursesLoading guard), BUG-04 (sequential init),
//        BUG-05 (openInClassroom defined), WARN-01 (fetch timeout),
//        WARN-02 (retry button), WARN-03 (offline auth warning),
//        PERF-01 (courses TTL cache), PERF-02 (cold start message)
// New:   Фільтр курсів (ручний вибір), TG-підключення

// ===== CONFIG =====
const API_BASE = window.location.origin + '/api';

// ===== STORAGE KEYS =====
const STORAGE_KEYS = {
  USER: 'ct_user_opk412',
  SCHEDULE: 'ct_schedule_opk412',
  HOMEWORK: 'ct_homework_opk412',
  THEME: 'ct_theme',
  HIDDEN_COURSES: 'ct_hidden_courses', // NEW: приховані курси
};

// ===== STATE =====
let isLoggedIn = false;
let userData = null;
let scheduleData = {};
let homeworkData = [];
let coursesList = [];
let currentCourseId = null;
let showOnlySubmittable = true;
let expandedLessonId = null;

// NEW: захист від паралельних запитів + TTL кеш
let coursesLoading = false;
let coursesCache = null;
let coursesCacheTime = 0;
const COURSES_TTL = 5 * 60 * 1000; // 5 хвилин

// ===== NOTIFICATIONS =====
function showNotification(message, type = 'info') {
  console.log(`[${type.toUpperCase()}] ${message}`);
  const notification = document.createElement('div');
  notification.style.cssText = `
    position:fixed; top:80px; right:20px; padding:16px 20px;
    border-radius:12px; z-index:999999; box-shadow:0 4px 16px rgba(0,0,0,0.2);
    max-width:360px; animation:slideIn 0.3s ease-out; color:white;
  `;
  const styles = {
    success: { bg: '#34C759', icon: '✅' },
    error:   { bg: '#FF3B30', icon: '❌' },
    info:    { bg: '#007AFF', icon: 'ℹ️' },
    warning: { bg: '#FFB800', icon: '⚠️' }
  };
  const s = styles[type] || styles.info;
  notification.style.background = s.bg;
  notification.innerHTML = `<strong>${s.icon} ${message}</strong>`;
  document.body.appendChild(notification);
  setTimeout(() => {
    notification.style.animation = 'slideOut 0.3s ease-in';
    setTimeout(() => notification.remove(), 300);
  }, 3500);
}

// Анімації для сповіщень
const _notifStyle = document.createElement('style');
_notifStyle.textContent = `
  @keyframes slideIn { from { transform:translateX(400px); opacity:0 } to { transform:translateX(0); opacity:1 } }
  @keyframes slideOut { from { transform:translateX(0); opacity:1 } to { transform:translateX(400px); opacity:0 } }
`;
document.head.appendChild(_notifStyle);

// ===== FETCH З TIMEOUT =====
// FIX WARN-01: всі запити до API мають timeout 12 сек
async function fetchWithTimeout(url, options = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    return resp;
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') throw new Error('Сервер не відповів за 12 сек. Спробуйте ще раз.');
    throw e;
  }
}

// ===== INITIALIZATION =====
// FIX BUG-04: послідовна ініціалізація (не паралельна)
document.addEventListener('DOMContentLoaded', async function () {
  initializeTelegramWebApp();
  loadTheme();
  loadStorageData();

  // Спочатку cookie (від OAuth redirect), потім перевірка на сервері
  const fromCookie = loadUserFromCookie();
  if (!fromCookie) {
    await checkAuth(); // тільки якщо cookie не спрацював
  }

  initDateSelector();
  loadScheduleForCurrentDay();
  checkBackendHealth();
});

// ===== BACKEND HEALTH =====
async function checkBackendHealth() {
  try {
    const response = await fetchWithTimeout(`${API_BASE}/health`, {}, 5000);
    if (response.ok) console.log('✅ Backend доступний');
    else console.warn('⚠️ Backend не відповідає');
  } catch (error) {
    console.warn('❌ Backend недоступний:', error.message);
  }
}

// ===== COOKIE HELPER =====
function getCookie(name) {
  const value = `; ${document.cookie}`;
  const parts = value.split(`; ${name}=`);
  if (parts.length === 2) return parts.pop().split(';').shift();
  return null;
}

// ===== LOAD USER FROM COOKIE =====
// FIX BUG-01: лише одна версія функції — правильна (base64)
function loadUserFromCookie() {
  const userDataCookie = getCookie('user_data');
  if (!userDataCookie) return false;
  try {
    const decodedJson = atob(userDataCookie);
    userData = JSON.parse(decodedJson);
    isLoggedIn = true;
    localStorage.setItem(STORAGE_KEYS.USER, JSON.stringify(userData));
    console.log('✅ Завантажено користувача з cookie:', userData.email);
    // Видаляємо cookie після зчитування
    document.cookie = 'user_data=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;';
    updateProfileView();
    return true;
  } catch (e) {
    console.error('❌ Не вдалося прочитати user_data cookie:', e);
    return false;
  }
}

// ===== OAUTH CALLBACK =====
async function handleOAuthCallback() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  if (!code) return false;

  console.log('🔄 Обробка OAuth callback...');
  try {
    const redirectUri = `${window.location.origin}/api/auth/google/callback`;
    const resp = await fetchWithTimeout(`${API_BASE}/auth/google/callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ code, redirect_uri: redirectUri })
    });

    if (!resp.ok) {
      const errData = await resp.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error(errData.error || `HTTP ${resp.status}`);
    }
    const data = await resp.json();
    if (!data.success || !data.user) throw new Error(data.error || 'Auth failed');

    userData = { name: data.user.name, email: data.user.email, picture: data.user.picture, role: data.user.role };
    isLoggedIn = true;
    localStorage.setItem(STORAGE_KEYS.USER, JSON.stringify(userData));
    window.history.replaceState({}, document.title, window.location.pathname);
    updateProfileView();
    try { await fetchServerScheduleIfExists(userData.group || 'ОПК-412'); } catch (e) {}
    return true;
  } catch (error) {
    console.error('❌ OAuth callback error:', error);
    showNotification('Помилка авторизації: ' + error.message, 'error');
    return false;
  }
}

// ===== GOOGLE AUTH INIT =====
function initGoogleAuth() {
  const container = document.getElementById('googleSignInBtn');
  if (!container) return;
  container.innerHTML = `
    <button class="btn btn-primary" onclick="loginWithGoogle()" style="padding:12px 20px;">
      Увійти через Google Classroom
    </button>
  `;
}

async function loginWithGoogle() {
  try {
    const redirect_uri = `${window.location.origin}/api/auth/google/callback`;
    const response = await fetchWithTimeout(`${API_BASE}/auth/google`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ redirect_uri })
    });
    if (!response.ok) throw new Error('Не вдалося запросити URL авторизації');
    const data = await response.json();
    if (data.success && data.authUrl) window.location.href = data.authUrl;
    else throw new Error('Не отримано URL авторизації');
  } catch (error) {
    showNotification('Помилка авторизації: ' + error.message, 'error');
  }
}

// ===== AUTH STATE SYNC =====
// FIX WARN-03: при помилці мережі — не вважаємо залогіненим мовчки
async function checkAuth() {
  const savedUser = localStorage.getItem(STORAGE_KEYS.USER);
  if (!savedUser) { initGoogleAuth(); return; }
  try { userData = JSON.parse(savedUser); }
  catch (e) { userData = null; localStorage.removeItem(STORAGE_KEYS.USER); initGoogleAuth(); return; }

  try {
    const resp = await fetchWithTimeout(`${API_BASE}/auth/check?userId=${encodeURIComponent(userData.email)}`, {}, 8000);
    if (resp.ok) {
      const j = await resp.json();
      if (j.present) {
        isLoggedIn = true;
        updateProfileView();
        try { await fetchServerScheduleIfExists(userData.group || 'ОПК-412'); } catch (e) {}
      } else {
        localStorage.removeItem(STORAGE_KEYS.USER);
        userData = null; isLoggedIn = false;
        initGoogleAuth(); updateProfileView();
      }
    }
  } catch (e) {
    // Мережева помилка — показуємо попередження, не "тихо" логінимо
    console.warn('checkAuth: мережева помилка', e.message);
    isLoggedIn = true; // дозволяємо офлайн-режим з кешем
    updateProfileView();
    showNotification('⚠️ Немає звʼязку з сервером. Режим офлайн.', 'warning');
    try { await fetchServerScheduleIfExists(userData.group || 'ОПК-412'); } catch (e) {}
  }
}

// ===== SERVER SCHEDULE SYNC =====
async function fetchServerScheduleIfExists(group = 'ОПК-412') {
  try {
    const resp = await fetchWithTimeout(`${API_BASE}/schedule/group?group=${encodeURIComponent(group)}`, {}, 8000);
    if (!resp.ok) return;
    const j = await resp.json();
    if (j && j.success && j.schedule) {
      scheduleData[group] = j.schedule;
      saveScheduleData();
      loadScheduleForCurrentDay();
    }
  } catch (e) { console.warn('fetchServerScheduleIfExists:', e.message); }
}

// ===== PROFILE UI =====
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
      if (userData.picture) avatarEl.innerHTML = `<img src="${userData.picture}" alt="Avatar" style="width:100%;height:100%;border-radius:50%;object-fit:cover;">`;
      else avatarEl.textContent = (userData.name || 'U').split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase();
    }

    let overdueCount = 0;
    try { overdueCount = JSON.parse(localStorage.getItem(STORAGE_KEYS.HOMEWORK) || '[]').filter(h => h.status === 'overdue').length; } catch (e) {}
    if (statsEl) statsEl.textContent = `Прострочених завдань: ${overdueCount}`;

    if (userData.role === 'admin') {
      const adminPanel = document.getElementById('adminPanel');
      if (adminPanel) adminPanel.style.display = 'block';
    }

    // NEW: Показуємо кнопку підключення TG-бота
    renderTelegramConnectButton();
  } else {
    if (loggedIn) loggedIn.style.display = 'none';
    if (login) login.style.display = 'block';
    if (profileCard) profileCard.style.display = 'none';
    initGoogleAuth();
  }
}

// ===== NEW: TELEGRAM CONNECT BUTTON =====
function renderTelegramConnectButton() {
  const container = document.getElementById('telegramConnect');
  if (!container || !userData) return;
  const tgLinked = userData.telegram_id;
  if (tgLinked) {
    container.innerHTML = `
      <div style="display:flex; align-items:center; gap:10px; padding:12px; background:var(--card-bg); border-radius:12px; border:1px solid var(--border); margin-top:12px;">
        <span style="font-size:24px;">✅</span>
        <div>
          <div style="font-weight:600;">Telegram підключено</div>
          <div style="font-size:13px; color:var(--text-secondary);">Сповіщення про уроки та дедлайни активні</div>
        </div>
        <button class="btn btn-secondary" onclick="unlinkTelegram()" style="margin-left:auto;">Відʼєднати</button>
      </div>`;
  } else {
    const botName = 'Kharkiv_CT_College_Bot'; 
    const deepLink = `https://t.me/${botName}?start=link_${encodeURIComponent(btoa(userData.email))}`;
    container.innerHTML = `
      <div style="padding:12px; background:var(--card-bg); border-radius:12px; border:1px solid var(--border); margin-top:12px;">
        <div style="display:flex; align-items:center; gap:10px; margin-bottom:10px;">
          <span style="font-size:24px;">🔔</span>
          <div>
            <div style="font-weight:600;">Підключити Telegram-сповіщення</div>
            <div style="font-size:13px; color:var(--text-secondary);">Нагадування про уроки та дедлайни</div>
          </div>
        </div>
        <a href="${deepLink}" target="_blank" rel="noopener noreferrer">
          <button class="btn btn-primary" style="width:100%;">📲 Підключити через Telegram</button>
        </a>
      </div>`;
  }
}

async function unlinkTelegram() {
  if (!userData) return;
  try {
    await fetchWithTimeout(`${API_BASE}/telegram/unlink`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: userData.email })
    });
    delete userData.telegram_id;
    localStorage.setItem(STORAGE_KEYS.USER, JSON.stringify(userData));
    renderTelegramConnectButton();
    showNotification('Telegram відʼєднано', 'info');
  } catch (e) {
    showNotification('Помилка: ' + e.message, 'error');
  }
}

// ===== LOGOUT =====
function logout() {
  if (!confirm('Ви впевнені, що хочете вийти?')) return;
  fetch(`${API_BASE}/auth/logout`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: userData?.email })
  }).catch(e => console.warn('logout backend failed', e)).finally(() => {
    localStorage.removeItem(STORAGE_KEYS.USER);
    localStorage.removeItem(STORAGE_KEYS.HOMEWORK);
    // Скидаємо кеш курсів при виході
    coursesCache = null; coursesCacheTime = 0; coursesList = [];
    isLoggedIn = false; userData = null;
    updateProfileView();
  });
}

// ===== GOOGLE CLASSROOM: COURSES =====
// FIX BUG-02: async + FIX BUG-03: guard від паралельних запитів + PERF-01: TTL кеш
async function loadCourses() {
  if (!isLoggedIn || !userData) { console.log('not logged in'); return; }

  // Захист від дублювання запитів
  if (coursesLoading) {
    console.log('courses already loading...');
    return;
  }

  // TTL кеш — не перезапитуємо якщо дані свіжі
  const now = Date.now();
  if (coursesCache && (now - coursesCacheTime) < COURSES_TTL) {
    coursesList = coursesCache;
    renderCoursesList();
    return;
  }

  const container = document.getElementById('homeworkContent');
  coursesLoading = true;

  // PERF-02: показуємо "сервер прокидається" через 5 сек
  let wakeupMsg = null;
  const wakeupTimer = setTimeout(() => {
    if (coursesLoading && container) {
      wakeupMsg = document.createElement('p');
      wakeupMsg.style.cssText = 'color:var(--text-secondary);font-size:13px;text-align:center;margin-top:8px;';
      wakeupMsg.textContent = '⏳ Сервер прокидається, зачекайте ~15 сек...';
      container.appendChild(wakeupMsg);
    }
  }, 5000);

  container.innerHTML = `<div class="loading"><div class="spinner"></div><p>Завантаження курсів...</p></div>`;

  try {
    const resp = await fetchWithTimeout(
      `${API_BASE}/classroom/courses?userId=${encodeURIComponent(userData.email)}`,
      {}, 20000 // 20 сек для cold start
    );
    if (!resp.ok) {
      const e = await resp.json().catch(() => ({ error: 'HTTP' }));
      throw new Error(e.error || `HTTP ${resp.status}`);
    }
    const j = await resp.json();
    coursesList = j.courses || [];

    // Зберігаємо в кеш
    coursesCache = coursesList;
    coursesCacheTime = Date.now();

    renderCoursesList();
  } catch (e) {
    console.error('loadCourses failed', e);
    // WARN-02: кнопка Retry
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">❌</div>
        <h3>Не вдалося завантажити курси</h3>
        <p style="color:var(--text-secondary);">${e.message}</p>
        <button class="btn btn-primary" onclick="coursesCache=null;loadCourses();" style="margin-top:12px;">
          🔄 Спробувати ще раз
        </button>
      </div>`;
  } finally {
    clearTimeout(wakeupTimer);
    coursesLoading = false;
  }
}

// ===== NEW: HIDDEN COURSES (фільтр курсів) =====
function getHiddenCourses() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEYS.HIDDEN_COURSES) || '[]'); }
  catch (e) { return []; }
}
function setHiddenCourses(ids) {
  localStorage.setItem(STORAGE_KEYS.HIDDEN_COURSES, JSON.stringify(ids));
}
function toggleCourseVisibility(courseId) {
  const hidden = getHiddenCourses();
  const idx = hidden.indexOf(courseId);
  if (idx === -1) hidden.push(courseId);
  else hidden.splice(idx, 1);
  setHiddenCourses(hidden);
  renderCoursesList(); // перемалювати
}

function renderCoursesList() {
  const container = document.getElementById('homeworkContent');
  if (!coursesList || coursesList.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">📚</div>
        <h3>Курси не знайдені</h3>
        <p>Можливо, ви ще не підключали Google Classroom.</p>
      </div>`;
    return;
  }

  const hidden = getHiddenCourses();
  const visibleCourses = coursesList.filter(c => !hidden.includes(c.id));
  const hiddenCourses = coursesList.filter(c => hidden.includes(c.id));

  let html = `
    <div style="display:flex; gap:10px; align-items:center; margin-bottom:12px; flex-wrap:wrap;">
      <div style="font-weight:700;">Курси (${visibleCourses.length}/${coursesList.length}):</div>
      <button class="btn btn-secondary" onclick="openCourseFilterModal()" style="margin-left:auto; font-size:13px;">
        ⚙️ Налаштувати курси
      </button>
      <label style="display:flex; gap:8px; align-items:center; font-size:13px;">
        <input type="checkbox" id="submittableToggle" ${showOnlySubmittable ? 'checked' : ''} onchange="toggleSubmittableFilter(this.checked)">
        <span>Тільки завдання</span>
      </label>
    </div>
    <div id="coursesList" style="display:flex; flex-direction:column; gap:8px; margin-bottom:16px;"></div>
    <div id="courseAssignments"></div>`;

  container.innerHTML = html;
  const listEl = document.getElementById('coursesList');

  // Показуємо тільки видимі курси
  visibleCourses.forEach(c => {
    const item = document.createElement('div');
    item.className = 'homework-card';
    item.style.cursor = 'pointer';
    item.onclick = () => {
      currentCourseId = c.id;
      loadAssignmentsForCourse(c.id, c.name);
      document.querySelectorAll('#coursesList .homework-card').forEach(el => el.style.opacity = '0.6');
      item.style.opacity = '1';
    };
    item.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <div>
          <div style="font-weight:700;">${c.name}</div>
          <div style="font-size:13px; color:var(--text-secondary)">${c.section || ''}</div>
        </div>
      </div>`;
    listEl.appendChild(item);
  });

  if (hiddenCourses.length > 0) {
    const hint = document.createElement('div');
    hint.style.cssText = 'font-size:12px; color:var(--text-secondary); text-align:center; margin-top:4px;';
    hint.textContent = `${hiddenCourses.length} курс(ів) приховано`;
    listEl.appendChild(hint);
  }
}

// ===== NEW: MODAL — вибір видимих курсів =====
function openCourseFilterModal() {
  const old = document.getElementById('course-filter-modal');
  if (old) old.remove();

  const hidden = getHiddenCourses();
  const overlay = document.createElement('div');
  overlay.id = 'course-filter-modal';
  overlay.style.cssText = 'position:fixed;left:0;top:0;right:0;bottom:0;background:rgba(0,0,0,0.45);z-index:999999;display:flex;align-items:center;justify-content:center;';

  const courseRows = coursesList.map(c => `
    <label style="display:flex; align-items:center; gap:12px; padding:10px; background:var(--card-bg); border-radius:10px; cursor:pointer; margin-bottom:8px;">
      <input type="checkbox" data-course-id="${c.id}" ${!hidden.includes(c.id) ? 'checked' : ''} style="width:18px;height:18px;cursor:pointer;">
      <div>
        <div style="font-weight:600;">${c.name}</div>
        <div style="font-size:12px; color:var(--text-secondary);">${c.section || ''}</div>
      </div>
    </label>`).join('');

  overlay.innerHTML = `
    <div style="width:480px; max-width:95%; max-height:80vh; overflow:auto; background:var(--bg); border-radius:16px; padding:20px; box-shadow:0 8px 32px rgba(0,0,0,0.25);">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;">
        <h3 style="margin:0; font-size:18px;">⚙️ Вибір курсів</h3>
        <button id="cfm-close" class="btn" style="padding:6px 12px;">✕</button>
      </div>
      <p style="font-size:13px; color:var(--text-secondary); margin-bottom:16px;">
        Зніміть галочку з курсів, які не хочете бачити (особисті, тестові тощо).
      </p>
      <div id="cfm-list">${courseRows}</div>
      <div style="display:flex; gap:10px; margin-top:16px;">
        <button id="cfm-save" class="btn btn-primary" style="flex:1;">Зберегти</button>
        <button id="cfm-all" class="btn btn-secondary">Показати всі</button>
      </div>
    </div>`;

  document.body.appendChild(overlay);

  document.getElementById('cfm-close').onclick = () => overlay.remove();
  document.getElementById('cfm-all').onclick = () => {
    overlay.querySelectorAll('input[type=checkbox]').forEach(cb => cb.checked = true);
  };
  document.getElementById('cfm-save').onclick = () => {
    const newHidden = [];
    overlay.querySelectorAll('input[data-course-id]').forEach(cb => {
      if (!cb.checked) newHidden.push(cb.dataset.courseId);
    });
    setHiddenCourses(newHidden);
    overlay.remove();
    renderCoursesList();
    showNotification('Налаштування курсів збережено', 'success');
  };
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
}

// ===== ASSIGNMENTS =====
function toggleSubmittableFilter(checked) {
  showOnlySubmittable = checked;
  if (currentCourseId) loadAssignmentsForCourse(currentCourseId);
}

async function loadAssignmentsForCourse(courseId, courseName = '') {
  if (!isLoggedIn || !userData) return;
  const container = document.getElementById('courseAssignments');
  container.innerHTML = `<div class="loading"><div class="spinner"></div><p>Завантаження завдань...</p></div>`;

  // Wakeup hint після 5 сек
  const wakeupTimer = setTimeout(() => {
    if (container.querySelector('.spinner')) {
      const p = document.createElement('p');
      p.style.cssText = 'color:var(--text-secondary);font-size:13px;text-align:center;';
      p.textContent = '⏳ Зачекайте, завантажую...';
      container.appendChild(p);
    }
  }, 5000);

  try {
    const resp = await fetchWithTimeout(
      `${API_BASE}/classroom/coursework?userId=${encodeURIComponent(userData.email)}&courseId=${encodeURIComponent(courseId)}&submittable=${showOnlySubmittable}`,
      {}, 15000
    );
    if (!resp.ok) {
      const e = await resp.json().catch(() => ({ error: 'HTTP' }));
      throw new Error(e.error || `HTTP ${resp.status}`);
    }
    const j = await resp.json();
    const assignments = j.assignments || [];
    if (assignments.length === 0) {
      container.innerHTML = `<div class="empty-state"><div class="empty-state-icon">📭</div><h3>Немає завдань</h3><p>Для цього курсу немає доступних завдань.</p></div>`;
      return;
    }
    let html = `<h3 style="margin-bottom:12px;">Завдання${courseName ? ' — ' + courseName : ''}</h3>`;
    assignments.forEach(hw => {
      const deadline = hw.deadline ? new Date(hw.deadline).toLocaleString('uk-UA') : 'Без дедлайну';
      const courseLink = `https://classroom.google.com/c/${courseId}/a/${hw.id}/details`;
      html += `
        <div class="homework-card status-${hw.status}">
          <div class="homework-header">
            <div class="homework-subject">${courseName || ''}</div>
            <div class="homework-status status-${hw.status}">${hw.status === 'overdue' ? '❌ Прострочено' : '⏳ Очікує'}</div>
          </div>
          <div class="homework-title">${hw.title}</div>
          <div style="font-size:13px; color:var(--text-secondary); margin-top:8px;">
            ${hw.description ? (hw.description.length > 200 ? hw.description.slice(0, 200) + '…' : hw.description) : ''}
          </div>
          <div class="homework-deadline">📅 ${deadline}</div>
          <div style="margin-top:10px; display:flex; gap:8px; flex-wrap:wrap;">
            <a href="${courseLink}" target="_blank" rel="noopener noreferrer">
              <button class="btn btn-secondary">Відкрити в Classroom</button>
            </a>
          </div>
        </div>`;
    });
    container.innerHTML = html;
  } catch (e) {
    console.error('loadAssignmentsForCourse failed', e);
    container.innerHTML = `
      <div class="empty-state">
        <h3>Помилка завантаження завдань</h3>
        <p>${e.message}</p>
        <button class="btn btn-primary" onclick="loadAssignmentsForCourse('${courseId}','${courseName}')" style="margin-top:12px;">
          🔄 Спробувати ще раз
        </button>
      </div>`;
  } finally {
    clearTimeout(wakeupTimer);
  }
}

// FIX BUG-05: openInClassroom тепер визначена
function openInClassroom(courseId, assignmentId) {
  const url = courseId && assignmentId
    ? `https://classroom.google.com/c/${courseId}/a/${assignmentId}/details`
    : 'https://classroom.google.com';
  window.open(url, '_blank', 'noopener,noreferrer');
}

// ===== LOAD HOMEWORK (tab entrypoint) =====
// FIX BUG-02: async + await
async function loadHomework() {
  const container = document.getElementById('homeworkContent');
  if (!isLoggedIn || !userData) {
    if (container) container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">🔐</div>
        <h3>Увійдіть для перегляду завдань</h3>
        <p>Натисніть "Увійти через Google Classroom" у Профілі.</p>
      </div>`;
    try { initGoogleAuth(); } catch (e) {}
    return;
  }

  if (container) container.innerHTML = `<div class="loading"><div class="spinner"></div><p>Завантаження курсів...</p></div>`;

  try {
    await loadCourses(); // FIX: await!
  } catch (err) {
    console.error('loadHomework error', err);
    if (container) container.innerHTML = `
      <div class="empty-state">
        <h3>Помилка при завантаженні</h3>
        <p>${err?.message || ''}</p>
        <button class="btn btn-primary" onclick="loadHomework()" style="margin-top:12px;">🔄 Спробувати ще раз</button>
      </div>`;
  }
}
window.loadHomework = loadHomework;

// ===== SCHEDULE PARSING =====
async function parseLocalSchedule() {
  try {
    const resp = await fetchWithTimeout(`${API_BASE}/schedule/parse-local`, { method: 'POST' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const j = await resp.json();
    if (j.error) throw new Error(j.error);
    scheduleData['ОПК-412'] = j.schedule;
    saveScheduleData();
    loadScheduleForCurrentDay();
    showNotification('Розклад успішно завантажено', 'success');
  } catch (e) { showNotification('Помилка: ' + e.message, 'error'); }
}

async function handleExcelUpload(e) {
  const file = e.target.files[0];
  if (!file) return;
  if (!file.name.match(/\.(xlsx|xls)$/)) { showNotification('Оберіть файл .xlsx або .xls', 'error'); return; }
  try {
    showNotification('Завантаження файлу...', 'info');
    const fd = new FormData();
    fd.append('file', file);
    fd.append('group', 'ОПК-412');
    const resp = await fetchWithTimeout(`${API_BASE}/schedule/upload`, { method: 'POST', body: fd }, 30000);
    if (!resp.ok) { const err = await resp.json().catch(() => ({ error: 'HTTP' })); throw new Error(err.error || `HTTP ${resp.status}`); }
    const j = await resp.json();
    if (j.error) throw new Error(j.error);
    scheduleData['ОПК-412'] = j.schedule;
    saveScheduleData();
    loadScheduleForCurrentDay();
    showNotification('Розклад успішно завантажено!', 'success');
    if (userData?.role === 'admin') {
      if (confirm('Зберегти розклад на сервері для всіх користувачів?')) {
        await saveScheduleToServer();
        showNotification('Розклад збережено на сервері', 'success');
      }
    }
  } catch (error) {
    showNotification('Помилка завантаження: ' + error.message, 'error');
  } finally {
    e.target.value = '';
  }
}

// ===== STORAGE =====
function loadStorageData() {
  const savedSchedule = localStorage.getItem(STORAGE_KEYS.SCHEDULE);
  if (savedSchedule) {
    try { scheduleData = JSON.parse(savedSchedule); } catch (e) { scheduleData = { 'ОПК-412': [[], [], [], [], []] }; }
  } else {
    scheduleData = { 'ОПК-412': [[], [], [], [], []] };
    saveScheduleData();
  }
  const savedHomework = localStorage.getItem(STORAGE_KEYS.HOMEWORK);
  if (savedHomework) {
    try { homeworkData = JSON.parse(savedHomework); } catch (e) { homeworkData = []; }
  } else homeworkData = [];
}
function saveScheduleData() { localStorage.setItem(STORAGE_KEYS.SCHEDULE, JSON.stringify(scheduleData)); }
function saveHomeworkData() { localStorage.setItem(STORAGE_KEYS.HOMEWORK, JSON.stringify(homeworkData)); }

// ===== SCHEDULE UI =====
function extractMeetingLink(lesson) {
  if (!lesson) return null;
  const candidates = [];
  function pushUrls(txt) {
    if (!txt || typeof txt !== 'string') return;
    const withProto = txt.match(/https?:\/\/[^\s'"]+/gi);
    if (withProto) withProto.forEach(u => candidates.push(u));
    const bare = txt.match(/\b(?:zoom\.us\/[^\s'"]+|meet\.google\.com\/[^\s'"]+|teams\.microsoft\.com\/[^\s'"]+)\b/gi);
    if (bare) bare.forEach(b => candidates.push(b));
  }
  const fields = ['conference', 'conferenceUrl', 'link', 'zoom', 'joinUrl', 'join_url', 'conference_link', 'meetingUrl', 'url', 'notes', 'info'];
  fields.forEach(f => { const v = lesson[f]; if (!v) return; if (typeof v === 'string') pushUrls(v); });
  pushUrls(lesson.title || ''); pushUrls(lesson.description || '');
  if (candidates.length === 0) { try { pushUrls(JSON.stringify(lesson)); } catch (e) {} }
  if (candidates.length > 0) {
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
  lessons.forEach((lesson, i) => {
    const id = `lesson-${dayIndex}-${i}`;
    const link = extractMeetingLink(lesson);
    const desc = lesson.description ? String(lesson.description) : '';
    const shortDesc = desc.length > 200 ? desc.slice(0, 200) + '…' : desc;
    const showRoom = lesson.room && lesson.room !== 'Не вказано';
    html += `
      <div class="lesson-card" id="${id}" style="cursor:pointer;">
        <div class="lesson-main" data-lesson-id="${id}" style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;">
          <div style="flex:1;">
            <div style="display:flex;justify-content:space-between;align-items:center;">
              <span class="lesson-time">${lesson.time || ''}</span>
              <span class="lesson-type">${lesson.type || ''}</span>
            </div>
            <div class="lesson-title" style="margin-top:6px;font-weight:600;">${lesson.title || ''}${link ? ' <span>🔗</span>' : ''}</div>
            <div style="font-size:13px;color:var(--text-secondary);margin-top:8px;">${shortDesc}</div>
            <div style="font-size:13px;color:var(--text-secondary);margin-top:8px;">
              ${lesson.teacher ? `<span style="margin-right:12px;">👤 ${lesson.teacher}</span>` : ''}
              ${showRoom ? `<span>🚪 ${lesson.room}</span>` : ''}
            </div>
          </div>
          <div style="margin-left:12px;display:flex;flex-direction:column;gap:8px;align-items:flex-end;">
            ${link ? `<a href="${link}" target="_blank" rel="noopener noreferrer"><button class="btn btn-primary">Приєднатися</button></a>` : `<div style="height:40px;"></div>`}
            <button class="btn btn-secondary toggle-details-btn" data-lesson-id="${id}" aria-expanded="false" style="padding:8px 10px;">Деталі</button>
          </div>
        </div>
        <div id="${id}-panel" style="display:none;margin-top:12px;padding-top:12px;border-top:1px solid var(--border);">
          <div style="font-size:13px;color:var(--text-secondary);line-height:1.6;">
            ${lesson.description ? `<div style="margin-bottom:8px;">${lesson.description}</div>` : ''}
            ${link ? `<div style="margin-bottom:8px;"><strong>Посилання:</strong> <a href="${link}" target="_blank" rel="noopener noreferrer">${link}</a></div>` : '<div><em>Посилання не знайдено</em></div>'}
            ${lesson.teacher ? `<div><strong>Викладач:</strong> ${lesson.teacher}</div>` : ''}
            ${showRoom ? `<div><strong>Кабінет:</strong> ${lesson.room}</div>` : ''}
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
  container._lessonClickHandler = function (ev) {
    if (ev.target.closest('a')) return;
    const toggle = ev.target.closest('.toggle-details-btn');
    if (toggle) { toggleLessonExpand(toggle.dataset.lessonId); return; }
    const main = ev.target.closest('.lesson-main');
    if (main) toggleLessonExpand(main.dataset.lessonId);
  };
  container.addEventListener('click', container._lessonClickHandler);
}

function toggleLessonExpand(lessonId) {
  if (expandedLessonId && expandedLessonId !== lessonId) {
    const prev = document.getElementById(`${expandedLessonId}-panel`);
    const prevBtn = document.querySelector(`[data-lesson-id="${expandedLessonId}"].toggle-details-btn`);
    if (prev) prev.style.display = 'none';
    if (prevBtn) prevBtn.setAttribute('aria-expanded', 'false');
  }
  const panel = document.getElementById(`${lessonId}-panel`);
  const btn = document.querySelector(`[data-lesson-id="${lessonId}"].toggle-details-btn`);
  if (!panel) return;
  const hidden = panel.style.display === 'none' || panel.style.display === '';
  panel.style.display = hidden ? 'block' : 'none';
  if (btn) btn.setAttribute('aria-expanded', hidden ? 'true' : 'false');
  expandedLessonId = hidden ? lessonId : null;
  if (hidden) try { panel.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) {}
}

// ===== EXPORT / SAVE =====
function exportSchedule() {
  const data = JSON.stringify(scheduleData['ОПК-412'] || [], null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = 'schedule-opk412.json'; a.click(); URL.revokeObjectURL(url);
}

async function saveScheduleToServer(group = 'ОПК-412') {
  if (!userData?.email) throw new Error('Спочатку увійдіть');
  const resp = await fetchWithTimeout(`${API_BASE}/schedule/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: userData.email, group, schedule: scheduleData[group] || [] })
  });
  if (!resp.ok) { const err = await resp.json().catch(() => ({ error: 'HTTP' })); throw new Error(err.error || `HTTP ${resp.status}`); }
  const j = await resp.json();
  if (!j.success) throw new Error('save failed');
  return j;
}

// ===== TELEGRAM WEBAPP =====
function initializeTelegramWebApp() {
  if (window.Telegram && window.Telegram.WebApp) {
    const tg = window.Telegram.WebApp;
    try { tg.ready(); } catch (e) {}
    try { tg.expand(); } catch (e) {}
    if (tg.colorScheme === 'dark') setTheme('dark');
  }
}

// ===== THEME =====
function loadTheme() { setTheme(localStorage.getItem(STORAGE_KEYS.THEME) || 'light'); }
function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const t = document.getElementById('themeToggle');
  if (t) t.textContent = theme === 'dark' ? '☀️' : '🌙';
  localStorage.setItem(STORAGE_KEYS.THEME, theme);
}
function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme');
  setTheme(cur === 'dark' ? 'light' : 'dark');
}

// ===== DATE SELECTOR =====
function initDateSelector() {
  const daysShort = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт'];
  const container = document.getElementById('dateSelector');
  if (!container) return;
  const today = new Date(); const cur = today.getDay();
  const active = (cur >= 1 && cur <= 5) ? cur - 1 : 0;
  container.innerHTML = '';
  daysShort.forEach((d, i) => {
    const btn = document.createElement('div');
    btn.className = 'date-btn' + (i === active ? ' active' : '');
    btn.innerHTML = `<div class="day">${d}</div>`;
    btn.onclick = () => { document.querySelectorAll('.date-btn').forEach(b => b.classList.remove('active')); btn.classList.add('active'); loadScheduleForDay(i); };
    container.appendChild(btn);
  });
  loadScheduleForDay(active);
}
function loadScheduleForCurrentDay() { const d = new Date().getDay(); loadScheduleForDay((d >= 1 && d <= 5) ? d - 1 : 0); }

// ===== NAV =====
(function overrideBottomNavHandlers() {
  function activate(tab) {
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    if (tab === 'schedule') { document.getElementById('scheduleTab')?.classList.add('active'); document.querySelectorAll('.nav-item')[0]?.classList.add('active'); }
    else if (tab === 'homework') { document.getElementById('homeworkTab')?.classList.add('active'); document.querySelectorAll('.nav-item')[1]?.classList.add('active'); if (typeof loadHomework === 'function') loadHomework().catch(() => {}); }
    else if (tab === 'profile') { document.getElementById('profileTab')?.classList.add('active'); document.querySelectorAll('.nav-item')[2]?.classList.add('active'); updateProfileView(); }
  }
  function init() {
    const nav = Array.from(document.querySelectorAll('.nav-item'));
    if (!nav.length) return;
    nav.forEach(n => { try { n.onclick = null; } catch (e) {} n.style.cursor = 'pointer'; });
    const tabs = ['schedule', 'homework', 'profile'];
    nav.forEach((el, idx) => el.addEventListener('click', ev => { try { ev.preventDefault(); } catch (e) {} activate(tabs[idx] || 'schedule'); }));
    const activeNav = document.querySelector('.nav-item.active') || nav[0];
    activate(tabs[nav.indexOf(activeNav)] || 'schedule');
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();

// ===== ADMIN EDITOR =====
async function openScheduleLinkEditor(group = 'ОПК-412') {
  let schedule = scheduleData[group] || [];
  try {
    const resp = await fetchWithTimeout(`${API_BASE}/schedule/group?group=${encodeURIComponent(group)}`, {}, 8000);
    if (resp.ok) { const j = await resp.json(); if (j?.success && j.schedule) schedule = j.schedule; }
  } catch (e) { console.warn('Server schedule fetch failed', e); }
  renderScheduleEditor(group, schedule);
}

function renderScheduleEditor(group, schedule) {
  const old = document.getElementById('schedule-editor');
  if (old) old.remove();
  const overlay = document.createElement('div');
  overlay.id = 'schedule-editor';
  overlay.style.cssText = 'position:fixed;left:0;top:0;right:0;bottom:0;background:rgba(0,0,0,0.35);z-index:999999;display:flex;align-items:center;justify-content:center;';
  overlay.innerHTML = `
    <div style="width:900px;max-width:95%;max-height:90%;overflow:auto;background:var(--bg);border-radius:12px;padding:16px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
        <h3 style="margin:0;">Редактор посилань — ${group}</h3>
        <div>
          <button id="saveEditorBtn" class="btn btn-primary" style="margin-right:8px;">Зберегти локально</button>
          <button id="saveServerEditorBtn" class="btn btn-secondary" style="margin-right:8px;">Зберегти на сервер</button>
          <button id="closeEditorBtn" class="btn">Закрити</button>
        </div>
      </div>
      <div id="schedule-editor-body"></div>
    </div>`;
  document.body.appendChild(overlay);
  document.getElementById('closeEditorBtn').onclick = () => overlay.remove();
  document.getElementById('saveEditorBtn').onclick = () => { scheduleData[group] = readScheduleFromEditor(); saveScheduleData(); loadScheduleForCurrentDay(); showNotification('Розклад збережено локально', 'success'); };
  document.getElementById('saveServerEditorBtn').onclick = async () => {
    scheduleData[group] = readScheduleFromEditor(); saveScheduleData();
    try { await saveScheduleToServer(group); showNotification('Розклад збережено на сервері', 'success'); }
    catch (e) { showNotification('Помилка збереження: ' + e.message, 'error'); }
  };
  const body = document.getElementById('schedule-editor-body');
  const days = ['Понеділок', 'Вівторок', 'Середа', 'Четвер', 'Пʼятниця'];
  body.innerHTML = '';
  for (let d = 0; d < 5; d++) {
    const dayLessons = schedule[d] || [];
    const dayDiv = document.createElement('div');
    dayDiv.style.marginBottom = '12px';
    dayDiv.innerHTML = `<h4 style="margin-bottom:8px;">${days[d]} (${dayLessons.length} пар)</h4>`;
    dayLessons.forEach((les, idx) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:8px;align-items:center;margin-bottom:6px;';
      row.innerHTML = `
        <div style="flex:1;"><div style="font-weight:600;">${idx + 1}. ${les.time || ''} ${les.title || ''}</div><div style="font-size:13px;color:#666;">${les.teacher || ''}${les.room ? ' • ' + les.room : ''}</div></div>
        <input data-day="${d}" data-idx="${idx}" class="editor-link-input" type="text" value="${les.conference || ''}" placeholder="Посилання на конференцію" style="flex:0 0 420px;padding:8px;border:1px solid var(--border);border-radius:8px;background:var(--input-bg,#fff);color:var(--text);"/>
        <button class="btn btn-secondary editor-apply-btn" data-day="${d}" data-idx="${idx}">OK</button>`;
      dayDiv.appendChild(row);
    });
    body.appendChild(dayDiv);
  }
  body.querySelectorAll('.editor-apply-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const d = Number(btn.dataset.day); const idx = Number(btn.dataset.idx);
      const input = body.querySelector(`.editor-link-input[data-day="${d}"][data-idx="${idx}"]`);
      const val = input.value.trim();
      if (!schedule[d]) schedule[d] = [];
      schedule[d][idx] = schedule[d][idx] || {};
      if (val) schedule[d][idx].conference = val; else delete schedule[d][idx].conference;
      input.style.borderColor = '#4CAF50';
      setTimeout(() => input.style.borderColor = '', 800);
    });
  });
}

function readScheduleFromEditor() {
  const body = document.getElementById('schedule-editor-body');
  if (!body) return scheduleData['ОПК-412'] || [];
  const base = scheduleData['ОПК-412'] ? JSON.parse(JSON.stringify(scheduleData['ОПК-412'])) : [[], [], [], [], []];
  body.querySelectorAll('.editor-link-input').forEach(inp => {
    const d = Number(inp.dataset.day); const idx = Number(inp.dataset.idx);
    const val = inp.value.trim();
    base[d] = base[d] || []; base[d][idx] = base[d][idx] || {};
    if (val) base[d][idx].conference = val; else delete base[d][idx].conference;
  });
  return base;
}

// ===== EXPORTS =====
try {
  window.loadHomework = loadHomework;
  window.updateProfileView = updateProfileView;
  window.initGoogleAuth = initGoogleAuth;
  window.openInClassroom = openInClassroom;
  window.openCourseFilterModal = openCourseFilterModal;
} catch (e) { console.warn('export failed', e); }
