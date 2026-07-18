/* ─── Constants ─── */
const ADMIN_USER = 'admin';
const ADMIN_PASS = 'admin123';

/* Одноразовый режим: правильный ответ не показывается по ходу викторины,
   вместо этого в конце открывается разбор всех вопросов.
   false — вернуться к показу ответа после каждого вопроса. */
const SHOW_ANSWER_REVIEW = true;

/* ─── Firebase ─── */
let firebaseDB = null;

/* ─── Storage (localStorage + Firebase sync) ─── */
const store = {
  get: (k) => {
    try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; }
  },
  set: (k, v) => {
    localStorage.setItem(k, JSON.stringify(v));
    if (firebaseDB) {
      firebaseDB.ref(k).set(v === undefined ? null : v).catch(console.error);
    }
  },
};

/* Вспомогательная функция: Firebase возвращает массив как объект {0:…,1:…} */
function fbToArray(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val;
  return Object.values(val).filter(x => x !== null && x !== undefined);
}

/* Точечная запись одного пользователя: пишет только users/<username>,
   а не весь узел 'users' целиком. Так параллельные регистрации/сохранения
   результатов у разных людей не затирают друг друга — раньше именно
   это приводило к пропаже участников и результатов при одновременной записи.
   userObj === null удаляет пользователя. */
function saveUser(username, userObj) {
  const users = store.get('users') || {};
  if (userObj === null) delete users[username];
  else users[username] = userObj;
  localStorage.setItem('users', JSON.stringify(users));
  if (firebaseDB) {
    firebaseDB.ref('users/' + username).set(userObj).catch(console.error);
  }
}

/* ─── State ─── */
let currentUser     = null;
let quiz            = {};
let globalTimer     = null;
let scheduleWatcher = null;

/* ─── Screen router ─── */
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById('screen-' + id).classList.add('active');
}

/* ══════════════════════════════════════
   HELPERS
══════════════════════════════════════ */
function formatTime(sec) {
  const m = Math.floor(sec / 60).toString().padStart(2, '0');
  const s = (sec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function genTempPassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  return Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

/* ══════════════════════════════════════
   SCHEDULE HELPERS
══════════════════════════════════════ */
function getSchedule() { return store.get('quiz_schedule') || null; }

function scheduleState(sched) {
  if (!sched || !sched.enabled) return 'none';
  const now   = Date.now();
  const start = new Date(sched.start).getTime();
  const end   = new Date(sched.end).getTime();
  if (now < start) return 'future';
  if (now >= end)  return 'expired';
  return 'active';
}

function isQuizAvailable() { return scheduleState(getSchedule()) === 'active'; }

function fmtDatetime(iso) {
  return new Date(iso).toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function userAlreadyPlayed() {
  if (!currentUser || currentUser.isAdmin) return false;
  const sched = getSchedule();
  if (scheduleState(sched) !== 'active') return false;
  const schedStart = new Date(sched.start).getTime();
  return (currentUser.results || []).some(r => r.finishedAt && r.finishedAt >= schedStart);
}

function getUserCurrentResult() {
  const sched = getSchedule();
  if (!sched) return null;
  const schedStart = new Date(sched.start).getTime();
  return (currentUser.results || []).find(r => r.finishedAt && r.finishedAt >= schedStart) || null;
}

/* ─── Schedule watcher (проверка истечения) ─── */
function startScheduleWatcher() {
  clearInterval(scheduleWatcher);
  scheduleWatcher = setInterval(checkScheduleExpiry, 10_000);
  checkScheduleExpiry();
}

function checkScheduleExpiry() {
  const sched = getSchedule();
  if (!sched || !sched.enabled || sched.archived) return;
  if (scheduleState(sched) !== 'expired') return;

  /* В момент закрытия у этого сеанса обычно открыто сразу много вкладок
     (все участники + админ) — каждая раз в 10с проверяет истечение.
     Без транзакции все они одновременно решат, что архивируют сеанс,
     и отчёт/письмо с результатами уйдут по нескольку раз. Транзакция
     на флаге archived гарантирует, что дальше пройдёт только одна из них. */
  if (firebaseDB) {
    firebaseDB.ref('quiz_schedule').transaction(cur => {
      if (!cur || cur.archived) return; // уже архивируется другой вкладкой — не продолжаем
      return { ...cur, archived: true };
    }, (err, committed, snapshot) => {
      if (err) { console.error(err); return; }
      if (!committed) return; // проиграли гонку за право архивировать
      archiveAndWipe(snapshot.val());
    });
  } else {
    sched.archived = true;
    store.set('quiz_schedule', sched);
    archiveAndWipe(sched);
  }
}

function archiveAndWipe(sched) {
  const users   = store.get('users') || {};
  const results = [];
  Object.values(users).forEach(u =>
    (u.results || []).forEach(({ review, ...r }) => results.push({ username: u.username, ...r }))
  );
  results.sort((a, b) => b.pct - a.pct || (a.finishedAt || 0) - (b.finishedAt || 0));

  const reports = store.get('quiz_reports') || [];
  reports.unshift({ id: Date.now(), start: sched.start, end: sched.end, closedAt: new Date().toISOString(), results });
  store.set('quiz_reports', reports);

  /* Точечно обнуляем results каждого участника (без перезаписи всего узла
     'users'), чтобы не затереть чей-то ещё не долетевший до базы результат. */
  Object.keys(users).forEach(k => { users[k].results = []; });
  localStorage.setItem('users', JSON.stringify(users));
  if (firebaseDB) {
    const updates = {};
    Object.keys(users).forEach(k => { updates['users/' + k + '/results'] = []; });
    firebaseDB.ref().update(updates).catch(console.error);
  }
  if (currentUser && !currentUser.isAdmin) currentUser.results = [];

  sendReportEmail(results, sched);

  if (document.getElementById('screen-home').classList.contains('active')) renderHomeAvailability();
}

async function sendReportEmail(results, sched) {
  const emailjsReady = typeof EMAILJS_PUBLIC_KEY !== 'undefined' && EMAILJS_PUBLIC_KEY !== 'YOUR_PUBLIC_KEY';
  const templateReady = typeof EMAILJS_REPORT_TEMPLATE_ID !== 'undefined' && EMAILJS_REPORT_TEMPLATE_ID !== 'YOUR_REPORT_TEMPLATE_ID';
  const adminEmailReady = typeof ADMIN_EMAIL !== 'undefined' && ADMIN_EMAIL !== 'YOUR_ADMIN_EMAIL';

  if (!emailjsReady || !templateReady || !adminEmailReady) return;

  const reportLines = results.map((r, i) => {
    const medals = ['🥇', '🥈', '🥉'];
    const place = medals[i] || `${i + 1}.`;
    return `${place} ${r.username} — ${r.score}/${r.total} (${r.pct}%)`;
  }).join('\n');

  const reportText = results.length
    ? reportLines
    : 'Никто не прошёл викторину.';

  try {
    await emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_REPORT_TEMPLATE_ID, {
      to_email:     ADMIN_EMAIL,
      to_name:      'Администратор',
      period:       `${fmtDatetime(sched.start)} — ${fmtDatetime(sched.end)}`,
      participants: results.length,
      report_text:  reportText,
    });
  } catch (err) {
    console.error('Ошибка отправки отчёта:', err);
  }
}

/* ══════════════════════════════════════
   FIREBASE REAL-TIME LISTENERS
══════════════════════════════════════ */
function setupRealtimeListeners() {
  /* Расписание: любое устройство меняет расписание → обновить экран */
  firebaseDB.ref('quiz_schedule').on('value', snap => {
    localStorage.setItem('quiz_schedule', JSON.stringify(snap.val()));
    if (currentUser && document.getElementById('screen-home').classList.contains('active')) {
      renderHomeAvailability();
    }
    if (currentUser?.isAdmin) {
      const schedContent = document.getElementById('atab-schedule');
      if (schedContent?.classList.contains('active')) renderScheduleTab();
    }
  });

  /* Пользователи: новая регистрация с другого устройства → видно в панели */
  firebaseDB.ref('users').on('value', snap => {
    const users = snap.val() || {};
    localStorage.setItem('users', JSON.stringify(users));
    /* Обновить currentUser свежими данными из базы */
    if (currentUser && !currentUser.isAdmin && users[currentUser.username]) {
      currentUser = users[currentUser.username];
    }
    if (currentUser?.isAdmin) {
      const usersContent = document.getElementById('atab-users');
      if (usersContent?.classList.contains('active')) renderUsersTab();
    }
  });

  /* Вопросы: admin меняет вопросы — все видят обновлённый список */
  firebaseDB.ref('bible_questions').on('value', snap => {
    if (snap.val()) {
      const qs = fbToArray(snap.val());
      localStorage.setItem('bible_questions', JSON.stringify(qs));
    }
  });

  /* Субтитр */
  firebaseDB.ref('quiz_subtitle').on('value', snap => {
    const text = snap.val() || '';
    localStorage.setItem('quiz_subtitle', JSON.stringify(text));
    loadSubtitle();
  });
}

/* ══════════════════════════════════════
   AUTH
══════════════════════════════════════ */
document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('form-' + btn.dataset.tab).classList.add('active');
  });
});

document.getElementById('form-register').addEventListener('submit', e => {
  e.preventDefault();
  const username = document.getElementById('reg-username').value.trim();
  const email    = document.getElementById('reg-email').value.trim();
  const password = document.getElementById('reg-password').value;
  const errEl    = document.getElementById('reg-error');

  if (username === ADMIN_USER) {
    errEl.textContent = 'Это имя зарезервировано.';
    errEl.classList.remove('hidden'); return;
  }
  const users = store.get('users') || {};
  if (users[username]) {
    errEl.textContent = 'Пользователь с таким именем уже существует.';
    errEl.classList.remove('hidden'); return;
  }
  if (Object.values(users).some(u => u.email === email)) {
    errEl.textContent = 'Этот email уже зарегистрирован.';
    errEl.classList.remove('hidden'); return;
  }
  errEl.classList.add('hidden');
  const newUser = { username, email, password, registeredAt: new Date().toISOString(), results: [] };
  saveUser(username, newUser);
  loginUser(newUser);
});

document.getElementById('form-login').addEventListener('submit', e => {
  e.preventDefault();
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;
  const errEl    = document.getElementById('login-error');

  if (username === ADMIN_USER && password === ADMIN_PASS) {
    loginUser({ username: ADMIN_USER, isAdmin: true, results: [] }); return;
  }
  const users = store.get('users') || {};
  if (!users[username] || users[username].password !== password) {
    errEl.textContent = 'Неверное имя пользователя или пароль.';
    errEl.classList.remove('hidden'); return;
  }
  errEl.classList.add('hidden');
  loginUser(users[username]);
});

function loginUser(user) {
  currentUser = user;
  localStorage.setItem('quiz_session', user.username);
  showHome();
}

document.getElementById('btn-logout').addEventListener('click', () => {
  stopGlobalTimer();
  currentUser = null;
  localStorage.removeItem('quiz_session');
  showScreen('auth');
});

/* ══════════════════════════════════════
   FORGOT PASSWORD
══════════════════════════════════════ */
document.getElementById('btn-forgot').addEventListener('click', () => {
  document.getElementById('forgot-email').value = '';
  document.getElementById('forgot-error').classList.add('hidden');
  document.getElementById('forgot-step-email').classList.remove('hidden');
  document.getElementById('forgot-step-success').classList.add('hidden');
  showScreen('forgot');
});

document.getElementById('btn-forgot-back').addEventListener('click', () => showScreen('auth'));
document.getElementById('btn-forgot-to-login').addEventListener('click', () => showScreen('auth'));

document.getElementById('btn-forgot-send').addEventListener('click', async () => {
  const email = document.getElementById('forgot-email').value.trim();
  const errEl = document.getElementById('forgot-error');

  if (!email) {
    errEl.textContent = 'Введите email.';
    errEl.classList.remove('hidden'); return;
  }

  const users = store.get('users') || {};
  const user  = Object.values(users).find(u => u.email === email);

  if (!user) {
    errEl.textContent = 'Пользователь с таким email не найден.';
    errEl.classList.remove('hidden'); return;
  }
  errEl.classList.add('hidden');

  const tempPass = genTempPassword();
  const updatedUser = { ...user, password: tempPass };
  saveUser(user.username, updatedUser);

  const btn = document.getElementById('btn-forgot-send');
  btn.textContent = 'Отправка...';
  btn.disabled = true;

  const emailjsReady = typeof EMAILJS_PUBLIC_KEY !== 'undefined' && EMAILJS_PUBLIC_KEY !== 'YOUR_PUBLIC_KEY';

  if (emailjsReady) {
    try {
      await emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, {
        to_email:      user.email,
        to_name:       user.username,
        temp_password: tempPass,
      });
      showForgotSuccess(user.email, false);
    } catch (err) {
      showForgotSuccess(user.email, true, tempPass);
    }
  } else {
    showForgotSuccess(user.email, true, tempPass);
  }

  btn.textContent = 'Выслать пароль';
  btn.disabled = false;
});

function showForgotSuccess(email, showOnScreen, tempPass) {
  document.getElementById('forgot-step-email').classList.add('hidden');
  document.getElementById('forgot-step-success').classList.remove('hidden');

  const textEl = document.getElementById('forgot-success-text');
  if (showOnScreen) {
    textEl.innerHTML = `Временный пароль для <strong>${email}</strong>:<br>
      <span class="temp-pass-box">${tempPass}</span><br>
      <small>Запомните его и войдите в систему.</small>`;
  } else {
    textEl.innerHTML = `Письмо с временным паролем отправлено на<br><strong>${email}</strong><br>
      <small>Проверьте папку «Спам», если письмо не пришло.</small>`;
  }
}

/* ══════════════════════════════════════
   HOME
══════════════════════════════════════ */
function showHome() {
  stopGlobalTimer();
  document.getElementById('home-greeting').textContent = `👋 Привет, ${currentUser.username}!`;
  document.getElementById('btn-admin-panel').classList.toggle('hidden', !currentUser.isAdmin);
  renderHomeAvailability();
  showScreen('home');
  startScheduleWatcher();
}

function hideAllHomeBlocks() {
  ['home-available', 'home-completed', 'home-admin', 'home-unavailable']
    .forEach(id => document.getElementById(id).classList.add('hidden'));
}

function renderHomeAvailability() {
  hideAllHomeBlocks();
  const sched = getSchedule();
  const state = scheduleState(sched);

  if (currentUser.isAdmin) {
    document.getElementById('home-admin').classList.remove('hidden');
    return;
  }

  if (state === 'active') {
    if (userAlreadyPlayed()) {
      const res = getUserCurrentResult();
      document.getElementById('home-completed').classList.remove('hidden');
      document.getElementById('home-completed-score').innerHTML = `
        <div class="completed-score-num">${res.score}/${res.total}</div>
        <div class="completed-score-pct">${res.pct}%</div>
        <div class="completed-score-time">Время: ${formatTime(res.elapsed)} · ${res.date}</div>`;
      document.getElementById('btn-review')
        .classList.toggle('hidden', !(SHOW_ANSWER_REVIEW && res.review));
    } else {
      const qs = getQuestions();
      document.getElementById('home-available').classList.remove('hidden');
      document.getElementById('home-q-count').textContent = `${qs.length} вопросов`;
      document.getElementById('home-duration').textContent = `${qs.length} минут`;
      document.getElementById('home-schedule-end').textContent = `До ${fmtDatetime(sched.end)}`;
    }
  } else {
    document.getElementById('home-unavailable').classList.remove('hidden');
    const reasonEl  = document.getElementById('home-unavail-reason');
    const nextWinEl = document.getElementById('home-next-window');
    if (state === 'future') {
      reasonEl.textContent = 'Викторина ещё не началась.';
      nextWinEl.classList.remove('hidden');
      nextWinEl.textContent = `Начало: ${fmtDatetime(sched.start)}`;
    } else if (state === 'expired') {
      reasonEl.textContent = 'Время викторины истекло. Ожидайте следующего сеанса.';
      nextWinEl.classList.add('hidden');
    } else {
      reasonEl.textContent = 'Администратор ещё не открыл викторину.';
      nextWinEl.classList.add('hidden');
    }
  }
}

document.getElementById('btn-start').addEventListener('click', () => {
  if (!isQuizAvailable() || userAlreadyPlayed()) { renderHomeAvailability(); return; }
  startQuiz();
});
document.getElementById('btn-admin-shortcut').addEventListener('click', showAdmin);

/* ══════════════════════════════════════
   ANSWER REVIEW (доступен, пока идёт сеанс)
══════════════════════════════════════ */
document.getElementById('btn-review').addEventListener('click', showReview);
document.getElementById('btn-back-review').addEventListener('click', showHome);

function showReview() {
  const res = getUserCurrentResult();
  if (!res || !res.review) { renderHomeAvailability(); return; }
  const sched = getSchedule();
  document.getElementById('review-note').textContent =
    `Ваш результат: ${res.score}/${res.total} (${res.pct}%)`
    + (sched ? ` · разбор доступен до ${fmtDatetime(sched.end)}` : '');
  renderAnswerReview(document.getElementById('review-answers'), fbToArray(res.review));
  showScreen('review');
}

/* ══════════════════════════════════════
   GLOBAL TIMER
══════════════════════════════════════ */
function startGlobalTimer() {
  quiz.remaining = quiz.duration;
  updateTimerDisplay();
  globalTimer = setInterval(() => {
    quiz.remaining--;
    updateTimerDisplay();
    if (quiz.remaining <= 0) { stopGlobalTimer(); finishQuiz(true); }
  }, 1000);
}

function stopGlobalTimer() { clearInterval(globalTimer); globalTimer = null; }

function updateTimerDisplay() {
  const el = document.getElementById('quiz-timer');
  const m  = Math.floor(quiz.remaining / 60).toString().padStart(2, '0');
  const s  = (quiz.remaining % 60).toString().padStart(2, '0');
  el.textContent = `⏱ ${m}:${s}`;
  el.classList.remove('urgent', 'warning');
  if      (quiz.remaining <= 60)  el.classList.add('urgent');
  else if (quiz.remaining <= 300) el.classList.add('warning');
}

/* ══════════════════════════════════════
   QUIZ
══════════════════════════════════════ */
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function startQuiz() {
  const questions = shuffle(getQuestions());
  const duration = questions.length * 60;
  quiz = { questions, idx: 0, score: 0, answers: [], remaining: duration, duration, startTime: Date.now() };
  showScreen('quiz');
  startGlobalTimer();
  renderQuestion();
}

function renderQuestion() {
  const q = quiz.questions[quiz.idx];
  const total = quiz.questions.length;
  document.getElementById('quiz-counter').textContent = `Вопрос ${quiz.idx + 1} из ${total}`;
  document.getElementById('progress-fill').style.width = `${(quiz.idx / total) * 100}%`;
  document.getElementById('quiz-question').textContent = q.q;
  document.getElementById('quiz-feedback').classList.add('hidden');
  const nextBtn = document.getElementById('btn-next');
  nextBtn.classList.add('hidden');
  nextBtn.textContent = quiz.idx === total - 1 ? 'Завершить →' : 'Следующий →';

  const optCont = document.getElementById('quiz-options');
  optCont.innerHTML = '';
  q.options.forEach((opt, i) => {
    const btn = document.createElement('button');
    btn.className = 'option-btn';
    btn.textContent = opt.trim();
    btn.addEventListener('click', () => selectAnswer(i));
    optCont.appendChild(btn);
  });
}

function selectAnswer(chosen) {
  const q = quiz.questions[quiz.idx];
  const correct = q.answer;
  const isCorrect = chosen === correct;

  document.querySelectorAll('.option-btn').forEach((btn, i) => {
    btn.disabled = true;
    if (i === correct) btn.classList.add('correct');
    else if (i === chosen) btn.classList.add('wrong');
  });

  const feedback = document.getElementById('quiz-feedback');
  feedback.classList.remove('hidden', 'correct', 'wrong');
  if (isCorrect) {
    feedback.textContent = '✅ Правильно!';
    feedback.classList.add('correct');
    quiz.score++;
  } else {
    feedback.textContent = `❌ Неверно. Правильный ответ: «${q.options[correct].trim()}»`;
    feedback.classList.add('wrong');
  }
  quiz.answers[quiz.idx] = chosen;
  document.getElementById('btn-next').classList.remove('hidden');
}

document.getElementById('btn-next').addEventListener('click', () => {
  quiz.idx++;
  quiz.idx < quiz.questions.length ? renderQuestion() : finishQuiz(false);
});

/* ══════════════════════════════════════
   RESULTS
══════════════════════════════════════ */
/* Разбор: по одной записи на каждый вопрос, включая те, до которых не дошли.
   chosen === -1 означает «нет ответа» (null Firebase молча выбрасывает). */
function buildReview() {
  return quiz.questions.map((q, i) => {
    const chosen = quiz.answers[i];
    return {
      q: q.q,
      options: q.options.map(o => o.trim()),
      correct: q.answer,
      chosen: chosen === undefined || chosen === null ? -1 : chosen,
    };
  });
}

function renderAnswerReview(container, review) {
  container.innerHTML = '';
  review.forEach((a, i) => {
    const noAnswer  = a.chosen === -1;
    const isCorrect = !noAnswer && a.chosen === a.correct;
    const row = document.createElement('div');
    row.className = 'answer-row';
    row.innerHTML = `
      <span class="icon">${noAnswer ? '➖' : isCorrect ? '✅' : '❌'}</span>
      <div class="q">
        <div>${i + 1}. ${a.q}</div>
        <div class="your-ans ${isCorrect ? 'ok' : 'bad'}">
          ${noAnswer ? 'Вы не ответили' : `Ваш ответ: ${a.options[a.chosen]}`}
        </div>
        ${isCorrect ? '' : `<div class="correct-ans">✔ Правильный ответ: ${a.options[a.correct]}</div>`}
      </div>`;
    container.appendChild(row);
  });
}

function finishQuiz(timeOut) {
  stopGlobalTimer();
  const total = quiz.questions.length;
  const review = SHOW_ANSWER_REVIEW ? buildReview() : null;
  const score = review ? review.filter(a => a.chosen === a.correct).length : quiz.score;
  const elapsed = quiz.duration - quiz.remaining;
  const pct = Math.round((score / total) * 100);
  const finishedAt = Date.now();

  document.getElementById('progress-fill').style.width = '100%';

  let emoji = '😢', title = 'Не расстраивайтесь!';
  if (pct >= 90)      { emoji = '🏆'; title = 'Превосходно! Вы настоящий знаток Библии!'; }
  else if (pct >= 70) { emoji = '🎉'; title = 'Отличный результат!'; }
  else if (pct >= 50) { emoji = '👍'; title = 'Хороший результат!'; }
  if (timeOut) title = '⏰ Время вышло! ' + title;

  document.getElementById('result-emoji').textContent = emoji;
  document.getElementById('result-title').textContent = title;
  document.getElementById('result-score').textContent = `${score} / ${total} (${pct}%)`;
  document.getElementById('result-time').textContent  = `Потрачено времени: ${formatTime(elapsed)}`;

  const answersEl = document.getElementById('result-answers');
  if (review) {
    renderAnswerReview(answersEl, review);
  } else {
    answersEl.innerHTML = '';
    quiz.answers.forEach(a => {
      const row = document.createElement('div');
      row.className = 'answer-row';
      row.innerHTML = `
        <span class="icon">${a.isCorrect ? '✅' : '❌'}</span>
        <div class="q">
          <div>${a.q}</div>
          ${!a.isCorrect ? `<div class="correct-ans">✔ ${a.options[a.correct].trim()}</div>` : ''}
        </div>`;
      answersEl.appendChild(row);
    });
  }

  if (!currentUser.isAdmin) {
    const users = store.get('users') || {};
    const freshUser = users[currentUser.username];
    if (freshUser) {
      const entry = { score, total, pct, elapsed, finishedAt, date: new Date().toLocaleDateString('ru-RU') };
      if (review) entry.review = review;
      const updatedUser = { ...freshUser, results: [entry, ...(freshUser.results || [])] };
      saveUser(currentUser.username, updatedUser);
      currentUser = updatedUser;
    }
  }
  showScreen('result');
}

document.getElementById('btn-home').addEventListener('click', showHome);

/* ══════════════════════════════════════
   LEADERBOARD
══════════════════════════════════════ */
document.getElementById('btn-leaderboard').addEventListener('click', showLeaderboard);
document.getElementById('btn-back-lb').addEventListener('click', showHome);

function showLeaderboard() {
  const users = store.get('users') || {};
  const sched = getSchedule();
  const schedStart = sched ? new Date(sched.start).getTime() : 0;

  const ranking = [];
  Object.values(users).forEach(u => {
    if (!u.results || !u.results.length) return;
    const sessionResults = sched
      ? u.results.filter(r => r.finishedAt && r.finishedAt >= schedStart)
      : u.results;
    if (!sessionResults.length) return;
    const best = sessionResults.reduce((b, r) =>
      r.pct > b.pct || (r.pct === b.pct && (r.finishedAt || 0) < (b.finishedAt || 0)) ? r : b
    );
    ranking.push({ username: u.username, ...best });
  });
  ranking.sort((a, b) => b.pct - a.pct || (a.finishedAt || 0) - (b.finishedAt || 0));

  const myEntry = ranking.find(r => r.username === currentUser.username);
  const myRank  = myEntry ? ranking.indexOf(myEntry) + 1 : null;
  const myRankEl = document.getElementById('lb-my-rank');

  if (myEntry && !currentUser.isAdmin) {
    myRankEl.classList.remove('hidden');
    const medals = ['🥇', '🥈', '🥉'];
    myRankEl.innerHTML = `
      <div class="rank-num">${medals[myRank - 1] || '#' + myRank}</div>
      <div class="rank-info">
        <div class="rank-label">Ваше место среди участников</div>
        <div class="rank-score">${myEntry.score}/${myEntry.total} (${myEntry.pct}%)</div>
        <div class="rank-detail">Время: ${formatTime(myEntry.elapsed)} · ${myEntry.date}</div>
      </div>`;
  } else {
    myRankEl.classList.add('hidden');
  }

  const list = document.getElementById('leaderboard-list');
  list.innerHTML = '';
  if (!ranking.length) {
    list.innerHTML = '<p style="text-align:center;color:var(--text-muted);padding:24px">Пока никто не прошёл викторину.</p>';
  } else {
    ranking.forEach((r, i) => {
      const isMe  = !currentUser.isAdmin && r.username === currentUser.username;
      const medal = ['🥇', '🥈', '🥉'][i] || (i + 1);
      const row   = document.createElement('div');
      row.className = 'lb-row' + (isMe ? ' lb-me' : '');
      row.innerHTML = `
        <span class="lb-rank">${medal}</span>
        <div class="lb-info">
          <div class="lb-name">${isMe ? '👤 ' + r.username + ' (вы)' : currentUser.isAdmin ? r.username : 'Участник #' + (i + 1)}</div>
          <div class="lb-detail">${r.date} · ${formatTime(r.elapsed)}</div>
        </div>
        <span class="lb-score">${r.score}/${r.total}</span>`;
      list.appendChild(row);
    });
  }
  showScreen('leaderboard');
}

/* ══════════════════════════════════════
   ADMIN PANEL
══════════════════════════════════════ */
document.getElementById('btn-admin-panel').addEventListener('click', showAdmin);
document.getElementById('btn-back-admin').addEventListener('click', showHome);

document.querySelectorAll('.admin-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.admin-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.admin-tab-content').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('atab-' + btn.dataset.atab).classList.add('active');
    if (btn.dataset.atab === 'users')    renderUsersTab();
    if (btn.dataset.atab === 'schedule') renderScheduleTab();
    if (btn.dataset.atab === 'reports')  renderReportsTab();
  });
});

function showAdmin() {
  document.querySelectorAll('.admin-tab').forEach((t, i) => t.classList.toggle('active', i === 0));
  document.querySelectorAll('.admin-tab-content').forEach((t, i) => t.classList.toggle('active', i === 0));
  renderAdminList();
  showScreen('admin');
}

/* ── Questions tab ── */
document.getElementById('btn-add-question').addEventListener('click', () => openModal(null));

function renderAdminList() {
  document.getElementById('admin-subtitle').value = store.get('quiz_subtitle') || '';
  const questions = getQuestions();
  document.getElementById('admin-q-total').textContent = `Всего вопросов: ${questions.length}`;
  const list = document.getElementById('admin-questions-list');
  list.innerHTML = '';

  if (!questions.length) {
    list.innerHTML = '<p style="text-align:center;color:var(--text-muted);padding:24px">Нет вопросов.</p>';
    return;
  }
  questions.forEach((q, idx) => {
    const opts = q.options.map((o, i) =>
      `<span class="admin-q-opt ${i === q.answer ? 'correct' : ''}">${o.trim()}</span>`
    ).join('');
    const row = document.createElement('div');
    row.className = 'admin-q-row';
    row.innerHTML = `
      <div class="admin-q-body">
        <div class="admin-q-text">${idx + 1}. ${q.q}</div>
        <div class="admin-q-opts">${opts}</div>
      </div>
      <div class="admin-q-actions">
        <button class="btn-icon btn-secondary" data-edit="${idx}">✏️</button>
        <button class="btn-icon btn-danger"     data-del="${idx}">🗑️</button>
      </div>`;
    list.appendChild(row);
  });
  list.querySelectorAll('[data-edit]').forEach(btn =>
    btn.addEventListener('click', () => openModal(parseInt(btn.dataset.edit))));
  list.querySelectorAll('[data-del]').forEach(btn =>
    btn.addEventListener('click', () => {
      const qs = getQuestions();
      qs.splice(parseInt(btn.dataset.del), 1);
      saveQuestions(qs);
      renderAdminList();
    }));
}

/* ── Users tab ── */
function renderUsersTab() {
  const users  = store.get('users') || {};
  const sched  = getSchedule();
  const schedStart = sched ? new Date(sched.start).getTime() : 0;
  const list   = document.getElementById('admin-users-list');
  const entries = Object.values(users);

  document.getElementById('admin-users-total').textContent = `Зарегистрировано: ${entries.length}`;
  list.innerHTML = '';

  if (!entries.length) {
    list.innerHTML = '<p style="text-align:center;color:var(--text-muted);padding:24px">Нет зарегистрированных пользователей.</p>';
    return;
  }

  entries.sort((a, b) => {
    const aPlayed = (a.results || []).some(r => r.finishedAt && r.finishedAt >= schedStart);
    const bPlayed = (b.results || []).some(r => r.finishedAt && r.finishedAt >= schedStart);
    if (aPlayed !== bPlayed) return bPlayed - aPlayed;
    return new Date(b.registeredAt || 0) - new Date(a.registeredAt || 0);
  });

  entries.forEach(u => {
    const played = (u.results || []).some(r => r.finishedAt && r.finishedAt >= schedStart);
    const bestResult = (u.results || []).reduce((best, r) =>
      !best || r.pct > best.pct || (r.pct === best.pct && r.finishedAt < best.finishedAt) ? r : best
    , null);
    const regDate = u.registeredAt
      ? new Date(u.registeredAt).toLocaleDateString('ru-RU')
      : '—';

    const row = document.createElement('div');
    row.className = 'user-row';
    row.innerHTML = `
      <div class="user-info">
        <div class="user-name">
          ${u.username}
          ${played ? '<span class="user-badge played">✅ прошёл</span>' : '<span class="user-badge">—</span>'}
        </div>
        <div class="user-detail">
          📧 ${u.email}
          ${bestResult ? ` · Лучший результат: <strong>${bestResult.score}/${bestResult.total} (${bestResult.pct}%)</strong>` : ''}
          · Рег.: ${regDate}
        </div>
      </div>
      <div class="user-actions">
        <button class="btn-icon btn-secondary" data-reset="${u.username}" title="Сбросить пароль">🔑</button>
        <button class="btn-icon btn-danger"     data-deluser="${u.username}" title="Удалить">🗑️</button>
      </div>`;
    list.appendChild(row);
  });

  list.querySelectorAll('[data-reset]').forEach(btn =>
    btn.addEventListener('click', () => adminResetPassword(btn.dataset.reset)));
  list.querySelectorAll('[data-deluser]').forEach(btn =>
    btn.addEventListener('click', () => adminDeleteUser(btn.dataset.deluser)));
}

function adminResetPassword(username) {
  const users = store.get('users') || {};
  if (!users[username]) return;
  const tempPass = genTempPassword();
  saveUser(username, { ...users[username], password: tempPass });

  document.getElementById('reset-modal-body').innerHTML = `
    <p style="margin-bottom:12px">Новый временный пароль для <strong>${username}</strong>:</p>
    <div class="temp-pass-box">${tempPass}</div>
    <p style="margin-top:12px;font-size:.85rem;color:var(--text-muted)">
      Сообщите пароль пользователю — он сможет войти и установить новый.
    </p>`;
  document.getElementById('reset-modal-overlay').classList.remove('hidden');
}

function adminDeleteUser(username) {
  if (!confirm(`Удалить пользователя «${username}»? Это действие нельзя отменить.`)) return;
  saveUser(username, null);
  renderUsersTab();
}

document.getElementById('reset-modal-close').addEventListener('click', () =>
  document.getElementById('reset-modal-overlay').classList.add('hidden'));
document.getElementById('reset-modal-overlay').addEventListener('click', e => {
  if (e.target === document.getElementById('reset-modal-overlay'))
    document.getElementById('reset-modal-overlay').classList.add('hidden');
});

/* ── Schedule tab ── */
function renderScheduleTab() {
  const sched  = getSchedule();
  const state  = scheduleState(sched);
  const statusEl = document.getElementById('schedule-status-block');
  statusEl.className = 'schedule-status ' + state;
  const labels = {
    active:  `✅ Викторина активна с ${fmtDatetime(sched.start)} до ${fmtDatetime(sched.end)}`,
    future:  `⏳ Откроется ${fmtDatetime(sched.start)} — до ${fmtDatetime(sched.end)}`,
    expired: `🔒 Сеанс завершён. Результаты сохранены в отчёт.`,
    none:    '—  Расписание не задано. Викторина недоступна.',
  };
  statusEl.textContent = labels[state];
  if (sched && sched.start) {
    document.getElementById('sched-start').value = sched.start;
    document.getElementById('sched-end').value   = sched.end;
  }
}

document.getElementById('btn-sched-save').addEventListener('click', () => {
  const start = document.getElementById('sched-start').value;
  const end   = document.getElementById('sched-end').value;
  const errEl = document.getElementById('sched-error');
  if (!start || !end) { errEl.textContent = 'Укажите дату начала и окончания.'; errEl.classList.remove('hidden'); return; }
  if (new Date(end) <= new Date(start)) { errEl.textContent = 'Окончание должно быть позже начала.'; errEl.classList.remove('hidden'); return; }
  errEl.classList.add('hidden');
  store.set('quiz_schedule', { start, end, enabled: true, archived: false });
  renderScheduleTab();
});

document.getElementById('btn-sched-clear').addEventListener('click', () => {
  store.set('quiz_schedule', { enabled: false });
  document.getElementById('sched-start').value = '';
  document.getElementById('sched-end').value   = '';
  document.getElementById('sched-error').classList.add('hidden');
  renderScheduleTab();
});

/* ── Reports tab ── */
document.getElementById('btn-send-report-now').addEventListener('click', async () => {
  const btn = document.getElementById('btn-send-report-now');
  const statusEl = document.getElementById('report-send-status');
  const users = store.get('users') || {};
  const sched = getSchedule();

  const results = [];
  Object.values(users).forEach(u =>
    (u.results || []).forEach(r => results.push({ username: u.username, ...r }))
  );
  results.sort((a, b) => b.pct - a.pct || (a.finishedAt || 0) - (b.finishedAt || 0));

  btn.disabled = true;
  btn.textContent = '📧 Отправляем...';
  statusEl.classList.add('hidden');

  const emailjsReady = typeof EMAILJS_PUBLIC_KEY !== 'undefined' && EMAILJS_PUBLIC_KEY !== 'YOUR_PUBLIC_KEY';
  const templateReady = typeof EMAILJS_REPORT_TEMPLATE_ID !== 'undefined' && EMAILJS_REPORT_TEMPLATE_ID !== 'YOUR_REPORT_TEMPLATE_ID';
  const adminEmailReady = typeof ADMIN_EMAIL !== 'undefined' && ADMIN_EMAIL !== 'YOUR_ADMIN_EMAIL';

  if (!emailjsReady || !templateReady || !adminEmailReady) {
    statusEl.textContent = '❌ Ошибка: проверьте ADMIN_EMAIL и EMAILJS_REPORT_TEMPLATE_ID в emailjs-config.js';
    statusEl.classList.remove('hidden');
    btn.disabled = false;
    btn.textContent = '📧 Отправить отчёт сейчас';
    return;
  }

  const reportLines = results.map((r, i) => {
    const medals = ['🥇', '🥈', '🥉'];
    const place = medals[i] || `${i + 1}.`;
    return `${place} ${r.username} — ${r.score}/${r.total} (${r.pct}%)`;
  }).join('\n');

  const reportText = results.length ? reportLines : 'Никто не прошёл викторину.';
  const period = sched ? `${fmtDatetime(sched.start)} — ${fmtDatetime(sched.end)}` : 'Без расписания';

  try {
    await emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_REPORT_TEMPLATE_ID, {
      to_email:     ADMIN_EMAIL,
      to_name:      'Администратор',
      period,
      participants: results.length,
      report_text:  reportText,
    });
    statusEl.textContent = `✅ Отчёт отправлен на ${ADMIN_EMAIL}`;
  } catch (err) {
    statusEl.textContent = `❌ Ошибка отправки: ${err?.text || err?.message || JSON.stringify(err)}`;
  }

  statusEl.classList.remove('hidden');
  btn.disabled = false;
  btn.textContent = '📧 Отправить отчёт сейчас';
});

function renderReportsTab() {
  const raw     = store.get('quiz_reports');
  const reports = Array.isArray(raw) ? raw : fbToArray(raw);
  const listEl  = document.getElementById('admin-reports-list');
  listEl.innerHTML = '';
  if (!reports.length) {
    listEl.innerHTML = '<p style="text-align:center;color:var(--text-muted);padding:24px">Отчётов пока нет.</p>';
    return;
  }
  reports.forEach(rep => {
    const row = document.createElement('div');
    row.className = 'report-row';
    row.innerHTML = `
      <span class="report-icon">📊</span>
      <div class="report-info">
        <div class="report-title">${fmtDatetime(rep.start)} — ${fmtDatetime(rep.end)}</div>
        <div class="report-detail">Закрыт: ${fmtDatetime(rep.closedAt)}</div>
      </div>
      <span class="report-badge">${rep.results.length} уч.</span>`;
    row.addEventListener('click', () => openReport(rep));
    listEl.appendChild(row);
  });
}

function openReport(rep) {
  document.getElementById('report-modal-title').textContent =
    `Отчёт: ${fmtDatetime(rep.start)} — ${fmtDatetime(rep.end)}`;
  const body = document.getElementById('report-modal-body');
  body.innerHTML = '';
  if (!rep.results.length) {
    body.innerHTML = '<p style="color:var(--text-muted)">Никто не прошёл викторину.</p>';
  } else {
    rep.results.forEach((r, i) => {
      const medals = ['🥇', '🥈', '🥉'];
      const row = document.createElement('div');
      row.className = 'report-user-row';
      row.innerHTML = `
        <span class="report-user-rank">${medals[i] || i + 1}</span>
        <div class="report-user-info">
          <div class="report-user-name">${r.username}</div>
          <div class="report-user-detail">${r.date} · ${formatTime(r.elapsed)}</div>
        </div>
        <span class="report-user-score">${r.score}/${r.total} (${r.pct}%)</span>`;
      body.appendChild(row);
    });
  }
  document.getElementById('report-modal-overlay').classList.remove('hidden');
}

document.getElementById('report-modal-close').addEventListener('click', () =>
  document.getElementById('report-modal-overlay').classList.add('hidden'));
document.getElementById('report-modal-overlay').addEventListener('click', e => {
  if (e.target === document.getElementById('report-modal-overlay'))
    document.getElementById('report-modal-overlay').classList.add('hidden');
});

/* ── Question modal ── */
let editingIdx = null;

function addOptionRow(wrap, value = '', checked = false) {
  const count = wrap.querySelectorAll('.modal-opt-row').length;
  const row = document.createElement('div');
  row.className = 'modal-opt-row';
  row.innerHTML = `
    <input type="radio" name="correct-opt" value="${count}" ${checked ? 'checked' : ''} />
    <input type="text" class="opt-input" placeholder="Вариант ${count + 1}" value="${value}" />
    <button type="button" class="btn-icon btn-danger btn-del-opt" title="Удалить">✕</button>`;
  row.querySelector('.btn-del-opt').addEventListener('click', () => {
    if (wrap.querySelectorAll('.modal-opt-row').length <= 2) return;
    row.remove();
    wrap.querySelectorAll('.modal-opt-row').forEach((r, i) => {
      r.querySelector('input[type="radio"]').value = i;
      r.querySelector('.opt-input').placeholder = `Вариант ${i + 1}`;
    });
  });
  wrap.appendChild(row);
}

function openModal(idx) {
  editingIdx = idx;
  document.getElementById('modal-title').textContent = idx === null ? 'Новый вопрос' : 'Редактировать вопрос';
  document.getElementById('modal-error').classList.add('hidden');
  const questions = getQuestions();
  const q = idx !== null ? questions[idx] : { q: '', options: ['', '', '', ''], answer: 0 };
  document.getElementById('modal-q').value = q.q;
  const wrap = document.getElementById('modal-options');
  wrap.innerHTML = '';
  q.options.forEach((opt, i) => addOptionRow(wrap, opt.trim(), i === q.answer));
  document.getElementById('modal-overlay').classList.remove('hidden');
  document.getElementById('modal-q').focus();
}

document.getElementById('btn-add-option').addEventListener('click', () => {
  const wrap = document.getElementById('modal-options');
  if (wrap.querySelectorAll('.modal-opt-row').length >= 6) return;
  addOptionRow(wrap);
});

document.getElementById('modal-cancel').addEventListener('click', () =>
  document.getElementById('modal-overlay').classList.add('hidden'));
document.getElementById('modal-overlay').addEventListener('click', e => {
  if (e.target === document.getElementById('modal-overlay'))
    document.getElementById('modal-overlay').classList.add('hidden');
});

document.getElementById('modal-save').addEventListener('click', () => {
  const qText   = document.getElementById('modal-q').value.trim();
  const options = [...document.querySelectorAll('.opt-input')].map(i => i.value.trim());
  const radio   = document.querySelector('input[name="correct-opt"]:checked');
  const errEl   = document.getElementById('modal-error');
  if (!qText)             { errEl.textContent = 'Введите текст вопроса.';        errEl.classList.remove('hidden'); return; }
  if (options.some(o=>!o)){ errEl.textContent = 'Заполните все варианты.';       errEl.classList.remove('hidden'); return; }
  if (!radio)             { errEl.textContent = 'Отметьте правильный ответ.';    errEl.classList.remove('hidden'); return; }
  errEl.classList.add('hidden');
  const answer    = parseInt(radio.value);
  const questions = getQuestions();
  const entry     = { q: qText, options, answer, id: Date.now() };
  if (editingIdx === null) questions.push(entry);
  else questions[editingIdx] = { ...entry, id: questions[editingIdx].id };
  saveQuestions(questions);
  document.getElementById('modal-overlay').classList.add('hidden');
  renderAdminList();
});

/* ══════════════════════════════════════
   SUBTITLE
══════════════════════════════════════ */
function loadSubtitle() {
  const text = store.get('quiz_subtitle') || '';
  ['auth-subtitle', 'home-subtitle'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    el.style.display = text ? '' : 'none';
  });
}

document.getElementById('btn-subtitle-save').addEventListener('click', () => {
  const text = document.getElementById('admin-subtitle').value.trim();
  store.set('quiz_subtitle', text);
  loadSubtitle();
  const saved = document.getElementById('subtitle-saved');
  saved.classList.remove('hidden');
  setTimeout(() => saved.classList.add('hidden'), 2000);
});

/* ══════════════════════════════════════
   INIT (async — ждём Firebase)
══════════════════════════════════════ */
(async function init() {
  const overlay = document.getElementById('loading-overlay');

  const fbConfigured = typeof FIREBASE_CONFIG !== 'undefined'
    && FIREBASE_CONFIG.apiKey !== 'YOUR_API_KEY';

  if (fbConfigured) {
    try {
      if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
      firebaseDB = firebase.database();

      /* Загружаем все данные из Firebase в localStorage */
      const snap = await firebaseDB.ref('/').once('value');
      const data = snap.val() || {};

      if (data.users)
        localStorage.setItem('users', JSON.stringify(data.users));
      if (data.quiz_schedule)
        localStorage.setItem('quiz_schedule', JSON.stringify(data.quiz_schedule));
      if (data.quiz_subtitle != null)
        localStorage.setItem('quiz_subtitle', JSON.stringify(data.quiz_subtitle));
      if (data.bible_questions)
        localStorage.setItem('bible_questions', JSON.stringify(fbToArray(data.bible_questions)));
      if (data.quiz_reports)
        localStorage.setItem('quiz_reports', JSON.stringify(fbToArray(data.quiz_reports)));

      setupRealtimeListeners();
    } catch (err) {
      console.error('Firebase init error:', err);
      /* Продолжаем в режиме localStorage */
    }
  }

  /* Проверяем истёкшее расписание сразу после загрузки данных */
  checkScheduleExpiry();

  /* Скрываем экран загрузки */
  if (overlay) overlay.style.display = 'none';

  loadSubtitle();

  const session = localStorage.getItem('quiz_session');
  if (session === ADMIN_USER) {
    loginUser({ username: ADMIN_USER, isAdmin: true, results: [] }); return;
  }
  if (session) {
    const users = store.get('users') || {};
    if (users[session]) { loginUser(users[session]); return; }
  }
  showScreen('auth');
})();
