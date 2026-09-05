/* =========================================================
   LEDGER — Group Study Manager
   Pure vanilla JS. No backend. Everything lives in LocalStorage.
   ========================================================= */

const STORAGE_KEY = 'ledger_study_manager_v1';

const TASK_TYPES = ['Theory', 'Practical', 'Assignment', 'Journal', 'Viva', 'Other'];
const WORK_UNITS = ['Pages', 'Questions', 'Programs', 'Experiments', 'Chapters', 'Assignments', 'Other'];

let state = {
  subjects: [],
  tasks: [],
  members: ['Member 1', 'Member 2', 'Member 3'],
  darkMode: false
};

let currentSubjectDetailId = null;
let currentView = 'dashboard';
let confirmCallback = null;

/* ---------------------------------------------------------
   LIVE SYNC (Firebase Realtime Database) — optional
--------------------------------------------------------- */
const SYNC_CONFIG_KEY = 'ledger_sync_config_v1';
let syncConfig = { firebaseConfig: null, groupCode: '', enabled: false };
let firebaseGroupRef = null;
let firebaseDataRef = null;
let firebaseAccessRef = null;
let firebaseMetaRef = null;
let firebaseAppInstance = null;
let authUnsubscribe = null;
let currentUser = null;
let isAdmin = false;
let appUnlocked = false;
let applyingRemoteUpdate = false;
let pushTimer = null;

/* ---------------------------------------------------------
   UTILITIES
--------------------------------------------------------- */
function uid() {
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

function todayISO() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}

function daysBetween(dateStr) {
  if (!dateStr) return null;
  const today = new Date(todayISO());
  const due = new Date(dateStr);
  return Math.round((due - today) / 86400000);
}

function formatDueLabel(dateStr) {
  const diff = daysBetween(dateStr);
  if (diff === null) return null;
  if (diff < 0) return { text: `${Math.abs(diff)}d overdue`, cls: 'overdue' };
  if (diff === 0) return { text: 'Due today', cls: 'today' };
  if (diff === 1) return { text: 'Due tomorrow', cls: 'upcoming' };
  return { text: `Due in ${diff}d`, cls: 'upcoming' };
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

function showToast(msg) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.remove('show'), 2200);
}

function showCelebration(text) {
  const el = document.getElementById('celebration');
  document.getElementById('celebrationText').textContent = text;
  el.classList.add('show');
  clearTimeout(showCelebration._t);
  showCelebration._t = setTimeout(() => el.classList.remove('show'), 1800);
}

/* ---------------------------------------------------------
   PERSISTENCE
--------------------------------------------------------- */
function saveData() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  if (syncConfig.enabled && firebaseDataRef && appUnlocked && !applyingRemoteUpdate) {
    clearTimeout(pushTimer);
    pushTimer = setTimeout(pushStateToFirebase, 250);
  }
}

function loadData() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      state = Object.assign({ subjects: [], tasks: [], members: ['Member 1', 'Member 2', 'Member 3'], darkMode: false }, parsed);
      return true;
    } catch (e) {
      console.error('Could not parse saved data, starting fresh.', e);
    }
  }
  return false;
}

function createSampleData() {
  const subjectNames = ['DBMS', 'Java', 'Data Structure', 'Computer Network', 'Cloud Computing'];
  const subjects = subjectNames.map(name => ({ id: uid(), name }));
  const byName = {};
  subjects.forEach(s => byName[s.name] = s.id);

  const sample = [
    { subject: 'DBMS', type: 'Theory', name: 'Unit 1 Notes', total: 20, completed: 10, unit: 'Pages', assignedTo: 0, priority: 'High', due: 0 },
    { subject: 'DBMS', type: 'Theory', name: 'Unit 2 Notes', total: 25, completed: 25, unit: 'Pages', assignedTo: 0, priority: 'Medium', due: 3 },
    { subject: 'DBMS', type: 'Practical', name: 'Practical 1', total: 5, completed: 5, unit: 'Programs', assignedTo: 1, priority: 'Medium', due: -2 },
    { subject: 'DBMS', type: 'Practical', name: 'Practical 2', total: 6, completed: 3, unit: 'Programs', assignedTo: 1, priority: 'High', due: 1 },
    { subject: 'Java', type: 'Theory', name: 'Unit 1 Notes', total: 20, completed: 8, unit: 'Pages', assignedTo: 2, priority: 'Medium', due: 4 },
    { subject: 'Java', type: 'Practical', name: 'Practical 1', total: 5, completed: 2, unit: 'Programs', assignedTo: 'everyone', priority: 'High', due: 0 },
    { subject: 'Data Structure', type: 'Theory', name: 'Unit 1 Notes', total: 15, completed: 5, unit: 'Pages', assignedTo: 0, priority: 'Low', due: 6 },
    { subject: 'Cloud Computing', type: 'Theory', name: 'Unit 1 Notes', total: 20, completed: 20, unit: 'Pages', assignedTo: 1, priority: 'Medium', due: -1 },
    { subject: 'Computer Network', type: 'Theory', name: 'Unit 1 Notes', total: 25, completed: 12, unit: 'Pages', assignedTo: 2, priority: 'High', due: 2 }
  ];

  const tasks = sample.map(s => {
    const d = new Date();
    d.setDate(d.getDate() + s.due);
    return {
      id: uid(),
      subjectId: byName[s.subject],
      type: s.type,
      name: s.name,
      description: '',
      total: s.total,
      completed: s.completed,
      unit: s.unit,
      unitTopic: '',
      assignedTo: s.assignedTo,
      dueDate: d.toISOString().slice(0, 10),
      priority: s.priority,
      createdAt: Date.now()
    };
  });

  state = { subjects, tasks, members: ['Member 1', 'Member 2', 'Member 3'], darkMode: false };
  saveData();
}

/* ---------------------------------------------------------
   CALCULATIONS
--------------------------------------------------------- */
function calculatePercentage(task) {
  if (!task.total || task.total <= 0) return 0;
  const pct = (task.completed / task.total) * 100;
  return Math.max(0, Math.min(100, Math.round(pct)));
}

function getStatus(task) {
  const pct = calculatePercentage(task);
  if (pct === 0) return { key: 'notstarted', label: 'NOT STARTED' };
  if (pct < 50) return { key: 'inprogress', label: 'IN PROGRESS' };
  if (pct < 100) return { key: 'almostdone', label: 'ALMOST DONE' };
  return { key: 'done', label: 'DONE ✓' };
}

function tasksForSubject(subjectId) {
  return state.tasks.filter(t => t.subjectId === subjectId);
}

function weightedPercent(tasks) {
  const total = tasks.reduce((sum, t) => sum + (t.total || 0), 0);
  const completed = tasks.reduce((sum, t) => sum + (t.completed || 0), 0);
  if (total === 0) return 0;
  return Math.round((completed / total) * 100);
}

function calculateSubjectProgress(subjectId) {
  const all = tasksForSubject(subjectId);
  const theory = all.filter(t => t.type === 'Theory');
  const practical = all.filter(t => t.type === 'Practical');
  return {
    theory: weightedPercent(theory),
    practical: weightedPercent(practical),
    overall: weightedPercent(all)
  };
}

function calculateOverallProgress() {
  return weightedPercent(state.tasks);
}

function getPendingTasks() {
  return state.tasks.filter(t => calculatePercentage(t) < 100);
}

function getCompletedTasks() {
  return state.tasks.filter(t => calculatePercentage(t) === 100);
}

function getTodayTasks() {
  const today = todayISO();
  return state.tasks
    .filter(t => calculatePercentage(t) < 100)
    .filter(t => t.dueDate === today || (t.dueDate && t.dueDate < today) || t.priority === 'High' || (t.dueDate && daysBetween(t.dueDate) <= 2))
    .sort((a, b) => {
      const da = a.dueDate ? daysBetween(a.dueDate) : 999;
      const db = b.dueDate ? daysBetween(b.dueDate) : 999;
      if (da !== db) return da - db;
      const prioOrder = { High: 0, Medium: 1, Low: 2 };
      return prioOrder[a.priority] - prioOrder[b.priority];
    });
}

function subjectName(id) {
  const s = state.subjects.find(s => s.id === id);
  return s ? s.name : 'Unknown';
}

function memberLabel(assignedTo) {
  if (assignedTo === 'everyone') return 'Everyone';
  const idx = Number(assignedTo);
  return state.members[idx] || 'Unassigned';
}

/* ---------------------------------------------------------
   TASK CRUD
--------------------------------------------------------- */
function addTask(data) {
  const task = {
    id: uid(),
    subjectId: data.subjectId,
    type: data.type,
    name: data.name,
    description: data.description || '',
    total: Math.max(1, Number(data.total) || 1),
    completed: Math.min(Math.max(0, Number(data.completed) || 0), Number(data.total) || 1),
    unit: data.unit,
    unitTopic: data.unitTopic || '',
    assignedTo: data.assignedTo,
    dueDate: data.dueDate || '',
    priority: data.priority || 'Medium',
    createdAt: Date.now()
  };
  state.tasks.push(task);
  saveData();
  return task;
}

function editTask(id, data) {
  const task = state.tasks.find(t => t.id === id);
  if (!task) return;
  Object.assign(task, {
    subjectId: data.subjectId,
    type: data.type,
    name: data.name,
    description: data.description || '',
    total: Math.max(1, Number(data.total) || 1),
    unit: data.unit,
    unitTopic: data.unitTopic || '',
    assignedTo: data.assignedTo,
    dueDate: data.dueDate || '',
    priority: data.priority || 'Medium'
  });
  task.completed = Math.min(task.completed, task.total);
  saveData();
}

function deleteTask(id) {
  state.tasks = state.tasks.filter(t => t.id !== id);
  saveData();
}

function updateProgress(id, newCompleted) {
  const task = state.tasks.find(t => t.id === id);
  if (!task) return;
  const wasComplete = calculatePercentage(task) === 100;
  task.completed = Math.min(Math.max(0, newCompleted), task.total);
  saveData();
  const isComplete = calculatePercentage(task) === 100;
  if (isComplete && !wasComplete) {
    showCelebration(`"${task.name}" completed!`);
  }
}

function incrementTask(id) {
  const task = state.tasks.find(t => t.id === id);
  if (!task) return;
  updateProgress(id, task.completed + 1);
  renderAll();
}

function decrementTask(id) {
  const task = state.tasks.find(t => t.id === id);
  if (!task) return;
  updateProgress(id, task.completed - 1);
  renderAll();
}

/* ---------------------------------------------------------
   SUBJECT CRUD
--------------------------------------------------------- */
function addSubject(name) {
  const subject = { id: uid(), name };
  state.subjects.push(subject);
  saveData();
  return subject;
}

function editSubject(id, name) {
  const s = state.subjects.find(s => s.id === id);
  if (s) { s.name = name; saveData(); }
}

function deleteSubject(id) {
  state.subjects = state.subjects.filter(s => s.id !== id);
  state.tasks = state.tasks.filter(t => t.subjectId !== id);
  saveData();
}

/* ---------------------------------------------------------
   IMPORT / EXPORT / RESET
--------------------------------------------------------- */
function exportData() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `ledger-backup-${todayISO()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  showToast('Backup downloaded.');
}

function importData(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const parsed = JSON.parse(e.target.result);
      if (!parsed.subjects || !parsed.tasks) throw new Error('Invalid file');
      state = Object.assign({ subjects: [], tasks: [], members: ['Member 1', 'Member 2', 'Member 3'], darkMode: false }, parsed);
      saveData();
      applyDarkMode();
      renderAll();
      showToast('Data imported successfully.');
    } catch (err) {
      showToast('Could not import that file.');
    }
  };
  reader.readAsText(file);
}

function resetAllData() {
  localStorage.removeItem(STORAGE_KEY);
  createSampleData();
  applyDarkMode();
  renderAll();
  showToast('All data has been reset.');
}

/* ---------------------------------------------------------
   DARK MODE
--------------------------------------------------------- */
function toggleDarkMode() {
  state.darkMode = !state.darkMode;
  saveData();
  applyDarkMode();
}

function applyDarkMode() {
  document.documentElement.setAttribute('data-theme', state.darkMode ? 'dark' : 'light');
  const icon = state.darkMode ? '☀' : '☾';
  const label = state.darkMode ? 'Light mode' : 'Dark mode';
  document.getElementById('darkModeIcon').textContent = icon;
  document.getElementById('darkModeLabel').textContent = label;
  document.getElementById('darkModeToggleMobile').textContent = icon;
}

/* ---------------------------------------------------------
   SYNC: connect to group, then gate behind Google sign-in
--------------------------------------------------------- */
function loadSyncConfig() {
  const raw = localStorage.getItem(SYNC_CONFIG_KEY);
  if (raw) {
    try { syncConfig = Object.assign(syncConfig, JSON.parse(raw)); } catch (e) { /* ignore bad data */ }
  }
}

function saveSyncConfig() {
  localStorage.setItem(SYNC_CONFIG_KEY, JSON.stringify(syncConfig));
}

function setSyncStatus(text, cls) {
  const badge = document.getElementById('syncStatusBadge');
  if (!badge) return;
  badge.textContent = text;
  badge.className = 'sync-status ' + cls;
}

function connectSync(silent) {
  const configText = document.getElementById('firebaseConfigInput').value.trim();
  const groupCode = document.getElementById('groupCodeInput').value.trim();
  if (!configText || !groupCode) {
    if (!silent) showToast('Firebase config ane group code, banne bharo.');
    return;
  }

  let parsedConfig;
  try {
    parsedConfig = JSON.parse(configText);
  } catch (e) {
    setSyncStatus('Invalid config', 'error');
    if (!silent) showToast('Firebase config valid JSON nathi lagtu.');
    return;
  }

  if (typeof firebase === 'undefined') {
    setSyncStatus('Offline', 'error');
    if (!silent) showToast('Internet connection check karo — Firebase load na thayu.');
    return;
  }

  setSyncStatus('Connecting…', 'connecting');

  try {
    const existing = firebase.apps.find(a => a.name === 'ledgerApp');
    if (existing) existing.delete();
    const app = firebase.initializeApp(parsedConfig, 'ledgerApp');
    firebaseAppInstance = app;
    const db = firebase.database(app);
    const safeCode = groupCode.replace(/[^a-zA-Z0-9-_]/g, '_');

    firebaseGroupRef = db.ref('groups/' + safeCode);
    firebaseDataRef = firebaseGroupRef.child('data');
    firebaseAccessRef = firebaseGroupRef.child('access');
    firebaseMetaRef = firebaseGroupRef.child('meta');

    syncConfig = { firebaseConfig: parsedConfig, groupCode, enabled: true };
    saveSyncConfig();

    initAuthGate();
    if (!silent) showToast('Group connected — sign in with Google to continue.');
  } catch (e) {
    console.error(e);
    setSyncStatus('Connection failed', 'error');
    if (!silent) showToast('Connect na thayu — config check karo.');
  }
}

function disconnectSync() {
  if (firebaseAccessRef) firebaseAccessRef.off();
  if (firebaseDataRef) firebaseDataRef.off();
  if (authUnsubscribe) { authUnsubscribe(); authUnsubscribe = null; }
  if (firebaseAppInstance && firebaseAppInstance.auth().currentUser) {
    firebaseAppInstance.auth().signOut().catch(() => {});
  }
  firebaseGroupRef = null;
  firebaseDataRef = null;
  firebaseAccessRef = null;
  firebaseMetaRef = null;
  firebaseAppInstance = null;
  currentUser = null;
  isAdmin = false;
  appUnlocked = false;
  syncConfig.enabled = false;
  saveSyncConfig();
  setSyncStatus('Not connected', 'off');
  hideAuthOverlay();
  document.getElementById('authMini').style.display = 'none';
  document.getElementById('accessPanel').style.display = 'none';
  showToast('Live sync band karyu. Have data sirf aa device par j save thashe.');
}

/* ---------------------------------------------------------
   AUTH GATE: Google sign-in + admin approval
--------------------------------------------------------- */
function initAuthGate() {
  if (typeof firebase === 'undefined' || !firebase.auth || !firebaseAppInstance) {
    setSyncStatus('Offline', 'error');
    return;
  }
  showAuthOverlay('signedout');
  if (authUnsubscribe) authUnsubscribe();
  authUnsubscribe = firebaseAppInstance.auth().onAuthStateChanged(handleAuthStateChange);
}

function handleAuthStateChange(user) {
  currentUser = user;
  if (!user) {
    isAdmin = false;
    appUnlocked = false;
    document.getElementById('authMini').style.display = 'none';
    document.getElementById('accessPanel').style.display = 'none';
    showAuthOverlay('signedout');
    return;
  }

  firebaseMetaRef.child('adminUid').once('value').then((snap) => {
    const adminUid = snap.val();

    if (!adminUid) {
      // Nobody is admin yet — first person to sign in claims it.
      const profile = {
        status: 'approved', role: 'admin',
        name: user.displayName || 'Admin', email: user.email || '',
        photoURL: user.photoURL || '', requestedAt: Date.now()
      };
      firebaseMetaRef.child('adminUid').set(user.uid);
      firebaseAccessRef.child(user.uid).set(profile).then(() => {
        isAdmin = true;
        unlockApp(profile);
      });
      return;
    }

    firebaseAccessRef.child(user.uid).once('value').then((accSnap) => {
      let profile = accSnap.val();
      if (!profile) {
        profile = {
          status: 'pending', role: 'student',
          name: user.displayName || 'Student', email: user.email || '',
          photoURL: user.photoURL || '', requestedAt: Date.now()
        };
        firebaseAccessRef.child(user.uid).set(profile);
      }
      isAdmin = (adminUid === user.uid) || profile.role === 'admin';

      if (profile.status === 'approved') {
        unlockApp(profile);
      } else {
        showAuthOverlay('pending', profile);
        listenForApproval(user.uid);
      }
    });
  });
}

function listenForApproval(uid) {
  firebaseAccessRef.child(uid).on('value', (snap) => {
    const profile = snap.val();
    if (profile && profile.status === 'approved') {
      firebaseAccessRef.child(uid).off();
      unlockApp(profile);
    }
  });
}

function unlockApp(profile) {
  appUnlocked = true;
  hideAuthOverlay();
  updateAuthMini(profile);
  attachDataSync();
  if (isAdmin) attachAccessRequestsListener();
}

function showAuthOverlay(stateName, profile) {
  const overlay = document.getElementById('authOverlay');
  overlay.classList.add('show');
  document.getElementById('authStateSignedOut').style.display = stateName === 'signedout' ? 'block' : 'none';
  document.getElementById('authStatePending').style.display = stateName === 'pending' ? 'block' : 'none';
  if (stateName === 'pending') {
    document.getElementById('pendingUserName').textContent = profile?.name || 'Hey';
  }
}

function hideAuthOverlay() {
  document.getElementById('authOverlay').classList.remove('show');
}

function updateAuthMini(profile) {
  const mini = document.getElementById('authMini');
  mini.style.display = 'flex';
  document.getElementById('authMiniPhoto').src = profile.photoURL || '';
  document.getElementById('authMiniName').textContent = profile.name;
  document.getElementById('authMiniRole').textContent = profile.role === 'admin' ? 'Admin' : 'Student';
}

/* ---------------------------------------------------------
   ACCESS REQUESTS (admin panel)
--------------------------------------------------------- */
function attachAccessRequestsListener() {
  firebaseAccessRef.on('value', (snap) => {
    renderAccessPanel(snap.val() || {});
  });
}

function renderAccessPanel(accessMap) {
  const panel = document.getElementById('accessPanel');
  panel.style.display = 'block';
  const entries = Object.entries(accessMap);
  const pending = entries.filter(([id, p]) => p.status === 'pending');
  const approved = entries.filter(([id, p]) => p.status === 'approved');

  document.getElementById('accessPendingList').innerHTML = pending.length ? pending.map(([id, p]) => `
    <div class="access-row">
      <img class="access-avatar" src="${p.photoURL || ''}" onerror="this.style.visibility='hidden'">
      <div class="access-info">
        <div class="access-name">${escapeHtml(p.name)}</div>
        <div class="access-email">${escapeHtml(p.email)}</div>
      </div>
      ${isAdmin ? `<div class="access-actions">
        <button class="btn-secondary small-btn" data-approve-uid="${id}">Approve</button>
        <button class="btn-danger-outline small-btn" data-reject-uid="${id}">Reject</button>
      </div>` : ''}
    </div>
  `).join('') : `<p class="empty-note">No pending requests.</p>`;

  document.getElementById('accessApprovedList').innerHTML = approved.length ? approved.map(([id, p]) => `
    <div class="access-row">
      <img class="access-avatar" src="${p.photoURL || ''}" onerror="this.style.visibility='hidden'">
      <div class="access-info">
        <div class="access-name">${escapeHtml(p.name)} ${p.role === 'admin' ? '<span class="badge type-tag">Admin</span>' : ''}</div>
        <div class="access-email">${escapeHtml(p.email)}</div>
      </div>
      ${isAdmin && p.role !== 'admin' ? `<div class="access-actions"><button class="text-btn danger" data-revoke-uid="${id}">Revoke</button></div>` : ''}
    </div>
  `).join('') : `<p class="empty-note">No approved members yet.</p>`;

  if (isAdmin) {
    panel.querySelectorAll('[data-approve-uid]').forEach(btn => btn.addEventListener('click', () => {
      firebaseAccessRef.child(btn.dataset.approveUid).update({ status: 'approved' });
      showToast('Access approved.');
    }));
    panel.querySelectorAll('[data-reject-uid]').forEach(btn => btn.addEventListener('click', () => {
      firebaseAccessRef.child(btn.dataset.rejectUid).remove();
      showToast('Request rejected.');
    }));
    panel.querySelectorAll('[data-revoke-uid]').forEach(btn => btn.addEventListener('click', () => {
      firebaseAccessRef.child(btn.dataset.revokeUid).remove();
      showToast('Access revoked.');
    }));
  }
}

/* ---------------------------------------------------------
   DATA SYNC (once approved)
--------------------------------------------------------- */
function attachDataSync() {
  firebaseDataRef.once('value').then((snap) => {
    const remote = snap.val();
    if (remote && Array.isArray(remote.subjects) && remote.subjects.length > 0) {
      applyingRemoteUpdate = true;
      state = Object.assign({ subjects: [], tasks: [], members: ['Member 1', 'Member 2', 'Member 3'], darkMode: false }, remote);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      applyDarkMode();
      renderAll();
      applyingRemoteUpdate = false;
    } else {
      pushStateToFirebase();
    }
    attachRemoteListener();
    setSyncStatus('Connected', 'connected');
  }).catch((err) => {
    console.error(err);
    setSyncStatus('Connection failed', 'error');
  });
}

function attachRemoteListener() {
  if (!firebaseDataRef) return;
  firebaseDataRef.on('value', (snap) => {
    const remote = snap.val();
    if (!remote) return;
    applyingRemoteUpdate = true;
    state = Object.assign({ subjects: [], tasks: [], members: ['Member 1', 'Member 2', 'Member 3'], darkMode: false }, remote);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    applyDarkMode();
    renderAll();
    applyingRemoteUpdate = false;
    setSyncStatus('Connected', 'connected');
  }, (err) => {
    console.error(err);
    setSyncStatus('Connection lost', 'error');
  });
}

function pushStateToFirebase() {
  if (!firebaseDataRef) return;
  firebaseDataRef.set(state).catch((err) => {
    console.error(err);
    setSyncStatus('Sync error', 'error');
  });
}

/* ---------------------------------------------------------
   RENDER: DASHBOARD
--------------------------------------------------------- */
function renderStatCards(container, tasks, subjects) {
  const pending = tasks.filter(t => calculatePercentage(t) < 100).length;
  const completed = tasks.length - pending;
  const overall = weightedPercent(tasks);
  container.innerHTML = `
    <div class="stat-card">
      <div class="stat-value">${subjects.length}</div>
      <div class="stat-label">Total subjects</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${tasks.length}</div>
      <div class="stat-label">Total tasks</div>
    </div>
    <div class="stat-card good">
      <div class="stat-value">${completed}</div>
      <div class="stat-label">Completed</div>
    </div>
    <div class="stat-card warn">
      <div class="stat-value">${pending}</div>
      <div class="stat-label">Pending</div>
    </div>
    <div class="stat-card accent">
      <div class="stat-value">${overall}%</div>
      <div class="stat-label">Overall progress</div>
    </div>
  `;
}

function renderDashboard() {
  renderStatCards(document.getElementById('statRow'), state.tasks, state.subjects);

  const totalUnits = state.tasks.reduce((s, t) => s + t.total, 0);
  const completedUnits = state.tasks.reduce((s, t) => s + t.completed, 0);
  const remainingUnits = totalUnits - completedUnits;
  const overall = totalUnits === 0 ? 0 : Math.round((completedUnits / totalUnits) * 100);

  document.getElementById('pagesBarFill').style.width = overall + '%';
  document.getElementById('pagesCompletedLabel').textContent = `${completedUnits} / ${totalUnits} completed`;
  document.getElementById('pagesPercentLabel').textContent = `${overall}%`;
  document.getElementById('pagesNote').textContent = `${remainingUnits} remaining`;

  // Remaining work by subject
  const remainingList = document.getElementById('remainingList');
  const rows = state.subjects.map(s => {
    const tasks = tasksForSubject(s.id);
    const remaining = tasks.reduce((sum, t) => sum + (t.total - t.completed), 0);
    const unit = tasks[0]?.unit || 'units';
    return { name: s.name, remaining, unit };
  }).filter(r => r.remaining > 0).sort((a, b) => b.remaining - a.remaining);

  remainingList.innerHTML = rows.length
    ? rows.map(r => `
        <div class="remaining-row">
          <span class="r-name">${escapeHtml(r.name)}</span>
          <span class="r-amount">${r.remaining} ${escapeHtml(r.unit)} remaining</span>
        </div>`).join('')
    : `<p class="empty-note">Nothing remaining — everything's written up.</p>`;

  // Today's work preview (top 4)
  const todayTasks = getTodayTasks().slice(0, 4);
  document.getElementById('dashTodayList').innerHTML = todayTasks.length
    ? todayTasks.map(t => todayCardHTML(t)).join('')
    : `<p class="empty-note">Nothing urgent today. Nice.</p>`;

  // Deadlines grid
  renderDeadlineGrid();

  attachTaskActionListeners(document.getElementById('dashTodayList'));
}

function renderDeadlineGrid() {
  const grid = document.getElementById('deadlineGrid');
  const buckets = { Overdue: [], Today: [], Tomorrow: [], 'This week': [], Upcoming: [] };
  const pending = getPendingTasks().filter(t => t.dueDate);
  pending.forEach(t => {
    const diff = daysBetween(t.dueDate);
    if (diff < 0) buckets.Overdue.push(t);
    else if (diff === 0) buckets.Today.push(t);
    else if (diff === 1) buckets.Tomorrow.push(t);
    else if (diff <= 7) buckets['This week'].push(t);
    else buckets.Upcoming.push(t);
  });
  grid.innerHTML = Object.entries(buckets).map(([label, list]) => `
    <div class="deadline-col">
      <div class="deadline-col-title">${label} (${list.length})</div>
      ${list.slice(0, 4).map(t => `<div class="deadline-item">${escapeHtml(t.name)}</div>`).join('') || '<div class="deadline-item" style="border:none;color:var(--ink-faint);">—</div>'}
    </div>
  `).join('');
}

function todayCardHTML(t) {
  const pct = calculatePercentage(t);
  const status = getStatus(t);
  const dueLabel = formatDueLabel(t.dueDate);
  const dotCls = dueLabel?.cls === 'overdue' ? 'overdue' : (t.priority === 'Low' ? 'low' : '');
  return `
    <div class="today-card ${dotCls}">
      <div class="task-top">
        <div class="task-title-block">
          <div class="task-name">${escapeHtml(subjectName(t.subjectId))} — ${escapeHtml(t.name)}</div>
          <div class="task-meta">
            <span class="badge type-tag">${escapeHtml(t.type)}</span>
            <span class="badge priority-${t.priority}">${t.priority}</span>
            ${dueLabel ? `<span class="due-tag ${dueLabel.cls}">${dueLabel.text}</span>` : ''}
          </div>
        </div>
        <span class="badge ${status.key}">${status.label}</span>
      </div>
      <div class="task-progress-row">
        <span class="task-progress-count">${t.completed} / ${t.total} ${escapeHtml(t.unit)}</span>
        <div class="task-bar"><div class="task-bar-fill ${status.key}" style="width:${pct}%"></div></div>
        <span class="task-percent">${pct}%</span>
      </div>
      <div class="task-actions">
        <button class="text-btn" data-open-progress="${t.id}">Continue</button>
        <button class="icon-btn" data-increment="${t.id}" ${t.completed >= t.total ? 'disabled' : ''}>+1</button>
        <button class="text-btn" data-mark-done="${t.id}" ${t.completed >= t.total ? 'disabled' : ''}>Done</button>
      </div>
    </div>
  `;
}

/* ---------------------------------------------------------
   RENDER: SUBJECTS
--------------------------------------------------------- */
function renderSubjects() {
  const grid = document.getElementById('subjectGrid');
  if (state.subjects.length === 0) {
    grid.innerHTML = `<p class="empty-note">No subjects yet — add your first one.</p>`;
    return;
  }
  grid.innerHTML = state.subjects.map(s => {
    const prog = calculateSubjectProgress(s.id);
    const count = tasksForSubject(s.id).length;
    return `
      <div class="subject-card" data-subject-open="${s.id}">
        <div class="subject-card-top">
          <div>
            <div class="subject-card-name">${escapeHtml(s.name)}</div>
            <div class="subject-card-meta">${count} task${count === 1 ? '' : 's'}</div>
          </div>
          <button class="subject-card-icon-btn" data-subject-delete="${s.id}" title="Delete subject">✕</button>
        </div>
        <div class="subject-card-rows">
          <div class="subject-card-row"><span class="lbl">Theory</span><div class="thin-bar" style="margin:0;flex:1;"><div class="thin-bar-fill theory" style="width:${prog.theory}%"></div></div><span class="pct">${prog.theory}%</span></div>
          <div class="subject-card-row"><span class="lbl">Practical</span><div class="thin-bar" style="margin:0;flex:1;"><div class="thin-bar-fill practical" style="width:${prog.practical}%"></div></div><span class="pct">${prog.practical}%</span></div>
          <div class="subject-card-row"><span class="lbl">Overall</span><div class="thin-bar" style="margin:0;flex:1;"><div class="thin-bar-fill overall" style="width:${prog.overall}%"></div></div><span class="pct">${prog.overall}%</span></div>
        </div>
        <span class="subject-card-open">Open subject →</span>
      </div>
    `;
  }).join('');

  grid.querySelectorAll('[data-subject-open]').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-subject-delete]')) return;
      openSubjectDetail(el.dataset.subjectOpen);
    });
  });
  grid.querySelectorAll('[data-subject-delete]').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = el.dataset.subjectDelete;
      const s = state.subjects.find(s => s.id === id);
      openConfirm(`Delete "${s.name}"?`, `This removes the subject and all its tasks. This can't be undone.`, () => {
        deleteSubject(id);
        renderAll();
        showToast('Subject deleted.');
      });
    });
  });
}

/* ---------------------------------------------------------
   RENDER: SUBJECT DETAIL
--------------------------------------------------------- */
function openSubjectDetail(id) {
  currentSubjectDetailId = id;
  switchView('subject-detail');
  renderSubjectDetail();
}

function renderSubjectDetail() {
  const s = state.subjects.find(s => s.id === currentSubjectDetailId);
  if (!s) { switchView('subjects'); return; }
  const prog = calculateSubjectProgress(s.id);
  document.getElementById('subjectDetailName').textContent = s.name;
  document.getElementById('subjectDetailProgress').textContent = `Overall progress: ${prog.overall}%`;

  document.getElementById('sdTheoryFill').style.width = prog.theory + '%';
  document.getElementById('sdTheoryPercent').textContent = prog.theory + '%';
  document.getElementById('sdPracticalFill').style.width = prog.practical + '%';
  document.getElementById('sdPracticalPercent').textContent = prog.practical + '%';
  document.getElementById('sdOverallFill').style.width = prog.overall + '%';
  document.getElementById('sdOverallPercent').textContent = prog.overall + '%';

  const all = tasksForSubject(s.id);
  const theory = all.filter(t => t.type === 'Theory');
  const practical = all.filter(t => t.type === 'Practical');
  const other = all.filter(t => !['Theory', 'Practical'].includes(t.type));

  document.getElementById('sdTheoryList').innerHTML = theory.length ? theory.map(t => taskCardHTML(t)).join('') : `<p class="empty-note">No theory work yet.</p>`;
  document.getElementById('sdPracticalList').innerHTML = practical.length ? practical.map(t => taskCardHTML(t)).join('') : `<p class="empty-note">No practical work yet.</p>`;
  document.getElementById('sdOtherList').innerHTML = other.length ? other.map(t => taskCardHTML(t)).join('') : `<p class="empty-note">No other work yet.</p>`;

  const remainingUnits = all.reduce((sum, t) => sum + (t.total - t.completed), 0);
  const unitLabel = all[0]?.unit || 'units';
  document.getElementById('sdRemainingBanner').textContent = all.length ? `Remaining work: ${remainingUnits} ${unitLabel}` : 'No work logged for this subject yet.';

  ['sdTheoryList', 'sdPracticalList', 'sdOtherList'].forEach(id => attachTaskActionListeners(document.getElementById(id)));
}

/* ---------------------------------------------------------
   TASK CARD HTML (shared by subject detail + all tasks)
--------------------------------------------------------- */
function taskCardHTML(t) {
  const pct = calculatePercentage(t);
  const status = getStatus(t);
  const dueLabel = formatDueLabel(t.dueDate);
  return `
    <div class="task-card ${status.key === 'done' ? 'done' : ''}">
      <div class="task-top">
        <div class="task-title-block">
          <div class="task-name">${escapeHtml(t.name)}</div>
          ${t.description ? `<div class="task-desc">${escapeHtml(t.description)}</div>` : ''}
          <div class="task-meta">
            <span class="badge type-tag">${escapeHtml(t.type)}</span>
            <span class="badge priority-${t.priority}">${t.priority}</span>
            <span class="sep">·</span>
            <span class="badge type-tag">${escapeHtml(memberLabel(t.assignedTo))}</span>
            ${dueLabel ? `<span class="due-tag ${dueLabel.cls}">${dueLabel.text}</span>` : ''}
          </div>
        </div>
        <span class="badge ${status.key}">${status.label}</span>
      </div>
      <div class="task-progress-row">
        <span class="task-progress-count">${t.completed} / ${t.total} ${escapeHtml(t.unit)}</span>
        <div class="task-bar"><div class="task-bar-fill ${status.key}" style="width:${pct}%"></div></div>
        <span class="task-percent">${pct}%</span>
      </div>
      <div class="task-actions">
        <button class="icon-btn" data-decrement="${t.id}" ${t.completed <= 0 ? 'disabled' : ''} title="-1">−</button>
        <button class="icon-btn" data-increment="${t.id}" ${t.completed >= t.total ? 'disabled' : ''} title="+1">+</button>
        <button class="text-btn" data-open-progress="${t.id}">Edit progress</button>
        <button class="text-btn" data-edit-task="${t.id}">Edit</button>
        <button class="text-btn danger" data-delete-task="${t.id}">Delete</button>
      </div>
    </div>
  `;
}

function attachTaskActionListeners(container) {
  if (!container) return;
  container.querySelectorAll('[data-increment]').forEach(el => el.addEventListener('click', () => incrementTask(el.dataset.increment)));
  container.querySelectorAll('[data-decrement]').forEach(el => el.addEventListener('click', () => decrementTask(el.dataset.decrement)));
  container.querySelectorAll('[data-mark-done]').forEach(el => el.addEventListener('click', () => {
    const t = state.tasks.find(t => t.id === el.dataset.markDone);
    if (t) { updateProgress(t.id, t.total); renderAll(); }
  }));
  container.querySelectorAll('[data-open-progress]').forEach(el => el.addEventListener('click', () => openProgressModal(el.dataset.openProgress)));
  container.querySelectorAll('[data-edit-task]').forEach(el => el.addEventListener('click', () => openTaskModal(el.dataset.editTask)));
  container.querySelectorAll('[data-delete-task]').forEach(el => el.addEventListener('click', () => {
    const t = state.tasks.find(t => t.id === el.dataset.deleteTask);
    openConfirm(`Delete "${t.name}"?`, `This task will be removed permanently.`, () => {
      deleteTask(t.id);
      renderAll();
      showToast('Task deleted.');
    });
  }));
}

/* ---------------------------------------------------------
   RENDER: TODAY
--------------------------------------------------------- */
function renderToday() {
  const tasks = getTodayTasks();
  const list = document.getElementById('todayList');
  list.innerHTML = tasks.length ? tasks.map(t => todayCardHTML(t)).join('') : `<p class="empty-note">Nothing urgent — pick anything from All Tasks to get ahead.</p>`;
  attachTaskActionListeners(list);
}

/* ---------------------------------------------------------
   RENDER: ALL TASKS (with filters/search)
--------------------------------------------------------- */
let taskFilters = { search: '', subject: 'all', member: 'all', priority: 'all', type: 'all', status: 'all' };

function populateTaskFilterOptions() {
  const subjectSelect = document.getElementById('filterSubject');
  subjectSelect.innerHTML = '<option value="all">All subjects</option>' + state.subjects.map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');
  const memberSelect = document.getElementById('filterMember');
  memberSelect.innerHTML = '<option value="all">All members</option>' + state.members.map((m, i) => `<option value="${i}">${escapeHtml(m)}</option>`).join('') + `<option value="everyone">Everyone</option>`;
}

function renderTasksList() {
  populateTaskFilterOptions();
  document.getElementById('filterSubject').value = taskFilters.subject;
  document.getElementById('filterMember').value = taskFilters.member;
  document.getElementById('filterPriority').value = taskFilters.priority;

  let tasks = [...state.tasks];

  if (taskFilters.search.trim()) {
    const q = taskFilters.search.trim().toLowerCase();
    tasks = tasks.filter(t =>
      t.name.toLowerCase().includes(q) ||
      subjectName(t.subjectId).toLowerCase().includes(q) ||
      t.type.toLowerCase().includes(q) ||
      memberLabel(t.assignedTo).toLowerCase().includes(q) ||
      (t.description || '').toLowerCase().includes(q)
    );
  }
  if (taskFilters.subject !== 'all') tasks = tasks.filter(t => t.subjectId === taskFilters.subject);
  if (taskFilters.member !== 'all') tasks = tasks.filter(t => String(t.assignedTo) === taskFilters.member);
  if (taskFilters.priority !== 'all') tasks = tasks.filter(t => t.priority === taskFilters.priority);
  if (taskFilters.type !== 'all') tasks = tasks.filter(t => t.type === taskFilters.type);
  if (taskFilters.status === 'Pending') tasks = tasks.filter(t => calculatePercentage(t) < 100);
  if (taskFilters.status === 'Completed') tasks = tasks.filter(t => calculatePercentage(t) === 100);

  const list = document.getElementById('allTasksList');
  list.innerHTML = tasks.length ? tasks.map(t => `
    <div>
      <div class="task-meta" style="margin-bottom:4px;">
        <span class="badge type-tag">${escapeHtml(subjectName(t.subjectId))}</span>
      </div>
      ${taskCardHTML(t)}
    </div>
  `).join('') : `<p class="empty-note">No tasks match your filters.</p>`;
  attachTaskActionListeners(list);
}

/* ---------------------------------------------------------
   RENDER: MEMBERS
--------------------------------------------------------- */
function renderMembers() {
  const grid = document.getElementById('memberGrid');
  grid.innerHTML = state.members.map((name, idx) => {
    const assigned = state.tasks.filter(t => t.assignedTo === idx || t.assignedTo === 'everyone');
    const completed = assigned.filter(t => calculatePercentage(t) === 100).length;
    const pending = assigned.length - completed;
    const pct = weightedPercent(assigned);
    const circumference = 2 * Math.PI * 30;
    const offset = circumference - (pct / 100) * circumference;
    return `
      <div class="member-card">
        <div class="circle-progress">
          <svg width="74" height="74" viewBox="0 0 74 74">
            <circle class="circ-bg" cx="37" cy="37" r="30"></circle>
            <circle class="circ-fill" cx="37" cy="37" r="30" stroke-dasharray="${circumference}" stroke-dashoffset="${offset}"></circle>
          </svg>
          <span class="circ-text">${pct}%</span>
        </div>
        <div class="member-info">
          <div class="member-name">${escapeHtml(name)}</div>
          <div class="member-stats">
            <span><b>${completed}</b> done</span>
            <span><b>${pending}</b> pending</span>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

/* ---------------------------------------------------------
   RENDER: REPORTS
--------------------------------------------------------- */
function renderReports() {
  renderStatCards(document.getElementById('reportStatRow'), state.tasks, state.subjects);

  const totalUnits = state.tasks.reduce((s, t) => s + t.total, 0);
  const completedUnits = state.tasks.reduce((s, t) => s + t.completed, 0);
  document.getElementById('reportUnits').innerHTML = `
    <div class="remaining-row"><span class="r-name">Total units logged</span><span class="r-amount" style="color:var(--ink)">${totalUnits}</span></div>
    <div class="remaining-row"><span class="r-name">Completed units</span><span class="r-amount" style="color:var(--green)">${completedUnits}</span></div>
    <div class="remaining-row"><span class="r-name">Remaining units</span><span class="r-amount">${totalUnits - completedUnits}</span></div>
  `;

  document.getElementById('reportSubjects').innerHTML = state.subjects.map(s => {
    const prog = calculateSubjectProgress(s.id);
    return `
      <div class="subject-card-row" style="margin-bottom:10px;">
        <span class="lbl" style="width:140px;font-weight:600;color:var(--ink);">${escapeHtml(s.name)}</span>
        <div class="thin-bar" style="margin:0;flex:1;"><div class="thin-bar-fill overall" style="width:${prog.overall}%"></div></div>
        <span class="pct">${prog.overall}%</span>
      </div>
    `;
  }).join('') || `<p class="empty-note">No subjects yet.</p>`;

  document.getElementById('reportMembers').innerHTML = state.members.map((name, idx) => {
    const assigned = state.tasks.filter(t => t.assignedTo === idx || t.assignedTo === 'everyone');
    const pct = weightedPercent(assigned);
    return `
      <div class="subject-card-row" style="margin-bottom:10px;">
        <span class="lbl" style="width:140px;font-weight:600;color:var(--ink);">${escapeHtml(name)}</span>
        <div class="thin-bar" style="margin:0;flex:1;"><div class="thin-bar-fill overall" style="width:${pct}%"></div></div>
        <span class="pct">${pct}%</span>
      </div>
    `;
  }).join('');
}

/* ---------------------------------------------------------
   RENDER: SETTINGS
--------------------------------------------------------- */
function renderSettings() {
  const wrap = document.getElementById('settingsMembers');
  wrap.innerHTML = state.members.map((name, idx) => `
    <div class="settings-member-row">
      <label>Member ${idx + 1}</label>
      <input type="text" data-member-idx="${idx}" value="${escapeHtml(name)}">
    </div>
  `).join('');
}

/* ---------------------------------------------------------
   VIEW SWITCHING
--------------------------------------------------------- */
function switchView(view) {
  currentView = view;
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('view-' + view).classList.add('active');
  document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.view === view));
  closeMobileSidebar();
  renderViewContent(view);
  window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
}

function renderViewContent(view) {
  switch (view) {
    case 'dashboard': renderDashboard(); break;
    case 'subjects': renderSubjects(); break;
    case 'subject-detail': renderSubjectDetail(); break;
    case 'today': renderToday(); break;
    case 'tasks': renderTasksList(); break;
    case 'members': renderMembers(); break;
    case 'reports': renderReports(); break;
    case 'settings': renderSettings(); break;
  }
}

function renderAll() {
  renderViewContent(currentView);
}

function closeMobileSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebarOverlay').classList.remove('show');
}

/* ---------------------------------------------------------
   MODAL: ADD / EDIT TASK
--------------------------------------------------------- */
function populateSubjectDropdown(selectEl, selectedId) {
  selectEl.innerHTML = state.subjects.map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');
  if (selectedId) selectEl.value = selectedId;
}

function populateAssignedDropdown(selectEl, selectedValue) {
  const options = state.members.map((m, i) => `<option value="${i}">${escapeHtml(m)}</option>`);
  options.push(`<option value="everyone">Everyone</option>`);
  selectEl.innerHTML = options.join('');
  if (selectedValue !== undefined) selectEl.value = String(selectedValue);
}

function openTaskModal(taskId, presetSubjectId, presetType) {
  const overlay = document.getElementById('taskModalOverlay');
  const form = document.getElementById('taskForm');
  form.reset();

  populateSubjectDropdown(document.getElementById('taskSubject'), presetSubjectId);
  populateAssignedDropdown(document.getElementById('taskAssigned'), 0);

  if (state.subjects.length === 0) {
    showToast('Add a subject first.');
    return;
  }

  if (taskId) {
    const t = state.tasks.find(t => t.id === taskId);
    document.getElementById('taskModalTitle').textContent = 'Edit work';
    document.getElementById('taskId').value = t.id;
    document.getElementById('taskSubject').value = t.subjectId;
    document.getElementById('taskType').value = t.type;
    document.getElementById('taskName').value = t.name;
    document.getElementById('taskDescription').value = t.description;
    document.getElementById('taskTotal').value = t.total;
    document.getElementById('taskUnit').value = t.unit;
    document.getElementById('taskUnitTopic').value = t.unitTopic || '';
    document.getElementById('taskAssigned').value = String(t.assignedTo);
    document.getElementById('taskPriority').value = t.priority;
    document.getElementById('taskDueDate').value = t.dueDate || '';
  } else {
    document.getElementById('taskModalTitle').textContent = 'Add work';
    document.getElementById('taskId').value = '';
    if (presetType) document.getElementById('taskType').value = presetType;
    document.getElementById('taskTotal').value = 10;
  }

  overlay.classList.add('show');
  document.getElementById('taskName').focus();
}

function closeTaskModal() {
  document.getElementById('taskModalOverlay').classList.remove('show');
}

function handleTaskFormSubmit(e) {
  e.preventDefault();
  const id = document.getElementById('taskId').value;
  const data = {
    subjectId: document.getElementById('taskSubject').value,
    type: document.getElementById('taskType').value,
    name: document.getElementById('taskName').value.trim(),
    description: document.getElementById('taskDescription').value.trim(),
    total: document.getElementById('taskTotal').value,
    unit: document.getElementById('taskUnit').value,
    unitTopic: document.getElementById('taskUnitTopic').value.trim(),
    assignedTo: document.getElementById('taskAssigned').value,
    priority: document.getElementById('taskPriority').value,
    dueDate: document.getElementById('taskDueDate').value
  };
  if (!data.name || !data.subjectId) return;

  if (id) {
    editTask(id, data);
    showToast('Task updated.');
  } else {
    data.completed = 0;
    addTask(data);
    showToast('Task added.');
  }
  closeTaskModal();
  renderAll();
}

/* ---------------------------------------------------------
   MODAL: EDIT PROGRESS
--------------------------------------------------------- */
function openProgressModal(taskId) {
  const t = state.tasks.find(t => t.id === taskId);
  if (!t) return;
  document.getElementById('progressTaskId').value = t.id;
  document.getElementById('progressModalName').textContent = `${subjectName(t.subjectId)} — ${t.name}`;
  document.getElementById('progressCompleted').value = t.completed;
  document.getElementById('progressCompleted').max = t.total;
  document.getElementById('progressTotal').value = t.total;
  document.getElementById('progressModalOverlay').classList.add('show');
}

function closeProgressModal() {
  document.getElementById('progressModalOverlay').classList.remove('show');
}

function handleProgressFormSubmit(e) {
  e.preventDefault();
  const id = document.getElementById('progressTaskId').value;
  const t = state.tasks.find(t => t.id === id);
  if (!t) return;
  let total = Math.max(1, Number(document.getElementById('progressTotal').value) || 1);
  let completed = Math.max(0, Number(document.getElementById('progressCompleted').value) || 0);
  completed = Math.min(completed, total);
  t.total = total;
  const wasComplete = false;
  saveData();
  updateProgress(id, completed);
  closeProgressModal();
  renderAll();
}

/* ---------------------------------------------------------
   MODAL: SUBJECT
--------------------------------------------------------- */
function openSubjectModal(subjectId) {
  const overlay = document.getElementById('subjectModalOverlay');
  document.getElementById('subjectForm').reset();
  if (subjectId) {
    const s = state.subjects.find(s => s.id === subjectId);
    document.getElementById('subjectModalTitle').textContent = 'Edit subject';
    document.getElementById('subjectId').value = s.id;
    document.getElementById('subjectName').value = s.name;
  } else {
    document.getElementById('subjectModalTitle').textContent = 'Add subject';
    document.getElementById('subjectId').value = '';
  }
  overlay.classList.add('show');
  document.getElementById('subjectName').focus();
}

function closeSubjectModal() {
  document.getElementById('subjectModalOverlay').classList.remove('show');
}

function handleSubjectFormSubmit(e) {
  e.preventDefault();
  const id = document.getElementById('subjectId').value;
  const name = document.getElementById('subjectName').value.trim();
  if (!name) return;
  if (id) {
    editSubject(id, name);
    showToast('Subject updated.');
  } else {
    addSubject(name);
    showToast('Subject added.');
  }
  closeSubjectModal();
  renderAll();
}

/* ---------------------------------------------------------
   MODAL: CONFIRM
--------------------------------------------------------- */
function openConfirm(title, message, onConfirm) {
  document.getElementById('confirmModalTitle').textContent = title;
  document.getElementById('confirmModalMessage').textContent = message;
  confirmCallback = onConfirm;
  document.getElementById('confirmModalOverlay').classList.add('show');
}

function closeConfirm() {
  document.getElementById('confirmModalOverlay').classList.remove('show');
  confirmCallback = null;
}

/* ---------------------------------------------------------
   EVENT WIRING
--------------------------------------------------------- */
function wireEvents() {
  // Nav
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', () => switchView(item.dataset.view));
  });
  document.querySelectorAll('[data-view-link]').forEach(el => {
    el.addEventListener('click', () => switchView(el.dataset.viewLink));
  });

  // Mobile sidebar
  document.getElementById('hamburgerBtn').addEventListener('click', () => {
    document.getElementById('sidebar').classList.add('open');
    document.getElementById('sidebarOverlay').classList.add('show');
  });
  document.getElementById('sidebarOverlay').addEventListener('click', closeMobileSidebar);

  // Dark mode
  document.getElementById('darkModeToggle').addEventListener('click', toggleDarkMode);
  document.getElementById('darkModeToggleMobile').addEventListener('click', toggleDarkMode);

  // Add work buttons
  document.getElementById('addWorkBtnDash').addEventListener('click', () => openTaskModal());
  document.getElementById('addWorkBtnTasks').addEventListener('click', () => openTaskModal());
  document.getElementById('addTheoryBtn').addEventListener('click', () => openTaskModal(null, currentSubjectDetailId, 'Theory'));
  document.getElementById('addPracticalBtn').addEventListener('click', () => openTaskModal(null, currentSubjectDetailId, 'Practical'));

  // Task modal
  document.getElementById('taskForm').addEventListener('submit', handleTaskFormSubmit);
  document.getElementById('taskModalClose').addEventListener('click', closeTaskModal);
  document.getElementById('taskCancelBtn').addEventListener('click', closeTaskModal);
  document.getElementById('taskModalOverlay').addEventListener('click', (e) => { if (e.target.id === 'taskModalOverlay') closeTaskModal(); });

  // Progress modal
  document.getElementById('progressForm').addEventListener('submit', handleProgressFormSubmit);
  document.getElementById('progressModalClose').addEventListener('click', closeProgressModal);
  document.getElementById('progressCancelBtn').addEventListener('click', closeProgressModal);
  document.getElementById('progressModalOverlay').addEventListener('click', (e) => { if (e.target.id === 'progressModalOverlay') closeProgressModal(); });

  // Subject modal
  document.getElementById('addSubjectBtn').addEventListener('click', () => openSubjectModal());
  document.getElementById('editSubjectBtn').addEventListener('click', () => openSubjectModal(currentSubjectDetailId));
  document.getElementById('deleteSubjectBtn').addEventListener('click', () => {
    const s = state.subjects.find(s => s.id === currentSubjectDetailId);
    if (!s) return;
    openConfirm(`Delete "${s.name}"?`, `This removes the subject and all its tasks. This can't be undone.`, () => {
      deleteSubject(s.id);
      switchView('subjects');
      showToast('Subject deleted.');
    });
  });
  document.getElementById('subjectForm').addEventListener('submit', handleSubjectFormSubmit);
  document.getElementById('subjectModalClose').addEventListener('click', closeSubjectModal);
  document.getElementById('subjectCancelBtn').addEventListener('click', closeSubjectModal);
  document.getElementById('subjectModalOverlay').addEventListener('click', (e) => { if (e.target.id === 'subjectModalOverlay') closeSubjectModal(); });

  // Confirm modal
  document.getElementById('confirmCancelBtn').addEventListener('click', closeConfirm);
  document.getElementById('confirmOkBtn').addEventListener('click', () => {
    if (confirmCallback) confirmCallback();
    closeConfirm();
  });

  // Tasks view: search + filters
  document.getElementById('searchInput').addEventListener('input', (e) => { taskFilters.search = e.target.value; renderTasksList(); });
  document.getElementById('filterSubject').addEventListener('change', (e) => { taskFilters.subject = e.target.value; renderTasksList(); });
  document.getElementById('filterMember').addEventListener('change', (e) => { taskFilters.member = e.target.value; renderTasksList(); });
  document.getElementById('filterPriority').addEventListener('change', (e) => { taskFilters.priority = e.target.value; renderTasksList(); });
  document.querySelectorAll('[data-filter-type]').forEach(chip => {
    chip.addEventListener('click', () => {
      taskFilters.type = chip.dataset.filterType;
      taskFilters.status = 'all';
      document.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      renderTasksList();
    });
  });
  document.querySelectorAll('[data-filter-status]').forEach(chip => {
    chip.addEventListener('click', () => {
      taskFilters.status = chip.dataset.filterStatus;
      taskFilters.type = 'all';
      document.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      renderTasksList();
    });
  });

  // Settings
  document.getElementById('saveMembersBtn').addEventListener('click', () => {
    document.querySelectorAll('[data-member-idx]').forEach(input => {
      const idx = Number(input.dataset.memberIdx);
      const val = input.value.trim();
      if (val) state.members[idx] = val;
    });
    saveData();
    renderAll();
    showToast('Member names saved.');
  });
  document.getElementById('exportBtn').addEventListener('click', exportData);
  document.getElementById('importInput').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) importData(file);
    e.target.value = '';
  });
  document.getElementById('resetBtn').addEventListener('click', () => {
    openConfirm('Are you sure?', 'All saved study data will be deleted and replaced with fresh sample data.', resetAllData);
  });
  document.getElementById('printReportBtn').addEventListener('click', () => window.print());

  // Live sync
  document.getElementById('connectSyncBtn').addEventListener('click', () => connectSync(false));
  document.getElementById('disconnectSyncBtn').addEventListener('click', disconnectSync);

  // Google auth
  document.getElementById('googleSignInBtn').addEventListener('click', () => {
    if (typeof firebase === 'undefined' || !firebase.auth || !firebaseAppInstance) { showToast('Pehla group connect karo.'); return; }
    const provider = new firebase.auth.GoogleAuthProvider();
    firebaseAppInstance.auth().signInWithPopup(provider).catch((err) => {
      console.error(err);
      if (err.code === 'auth/operation-not-supported-in-this-environment') {
        showToast('Google sign-in file:// par kaam nathi karto — website ne host karo (GitHub Pages).');
      } else if (err.code === 'auth/unauthorized-domain') {
        showToast('Aa domain Firebase ma authorized nathi — Authentication > Authorized domains ma umero.');
      } else if (err.code !== 'auth/popup-closed-by-user') {
        showToast('Sign-in fail thayu: ' + (err.code || 'unknown error'));
      }
    });
  });
  document.getElementById('signOutFromPendingBtn').addEventListener('click', () => {
    if (firebaseAppInstance) firebaseAppInstance.auth().signOut();
  });
  document.getElementById('signOutBtn').addEventListener('click', () => {
    if (firebaseAppInstance) firebaseAppInstance.auth().signOut();
  });

  // Escape key closes modals
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeTaskModal(); closeProgressModal(); closeSubjectModal(); closeConfirm();
    }
  });
}

/* ---------------------------------------------------------
   INIT
--------------------------------------------------------- */
function init() {
  loadSyncConfig();
  const hadData = loadData();
  if (!hadData || state.subjects.length === 0) {
    createSampleData();
  }
  applyDarkMode();
  wireEvents();
  switchView('dashboard');

  if (syncConfig.enabled && syncConfig.firebaseConfig && syncConfig.groupCode) {
    document.getElementById('firebaseConfigInput').value = JSON.stringify(syncConfig.firebaseConfig, null, 2);
    document.getElementById('groupCodeInput').value = syncConfig.groupCode;
    connectSync(true);
  }
}

document.addEventListener('DOMContentLoaded', init);
