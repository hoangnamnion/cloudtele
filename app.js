// ============================================================
//  TeleCloud – app.js  (Part 1: Core + Telegram API + Storage)
// ============================================================

const STORAGE_KEY   = 'tc_files';
const SETTINGS_KEY  = 'tc_settings';
const TG_API        = 'https://api.telegram.org';

// ── DEFAULT CREDENTIALS (hard-coded – works on any device) ──
const DEFAULT_BOT_TOKEN  = '8327837990:AAHVz_qXiui3_Thbo2sN4khegqFoLjAWvd0';
const DEFAULT_CHANNEL_ID = '6754356446';
const DEFAULT_SHEET_URL  = 'https://script.google.com/macros/s/AKfycbydk_V1bxX7crDu9AoOKduSAczCwpF_o4YoWXFYhHbF9xBNbXjJ_IBqiOKZqD4zJH4WMA/exec';

let settings = {
  botToken:  DEFAULT_BOT_TOKEN,
  channelId: DEFAULT_CHANNEL_ID,
  sheetUrl:  DEFAULT_SHEET_URL,
  password:  ''
};
let files = [];           // in-memory file index
let currentFolder = 'all';
let currentView = 'grid';
let currentSort = 'date-desc';
let searchQuery = '';
let currentMediaIndex = -1;
let filteredFiles = [];
let isSyncing = false;

// ── INIT ────────────────────────────────────────────────────
function init() {
  loadSettings();
  // Always ensure hard-coded credentials are in place
  if (!settings.botToken)  settings.botToken  = DEFAULT_BOT_TOKEN;
  if (!settings.channelId) settings.channelId = DEFAULT_CHANNEL_ID;
  if (!settings.sheetUrl)  settings.sheetUrl  = DEFAULT_SHEET_URL;

  loadFilesFromCache();
  // Always skip setup screen — credentials are hard-coded
  hide('setupScreen');
  if (settings.password) {
    show('passwordGate'); hide('mainApp');
  } else {
    launchApp();
  }
  setupDragDrop();
}

async function launchApp() {
  hide('setupScreen'); hide('passwordGate'); show('mainApp');
  fillSettingsDrawer();
  // 1. Load fast local cache first so UI appears immediately
  loadFilesFromCache();
  render();
  // 2. Then load authoritative data from Google Sheets
  await loadFilesFromSheet();
  // 3. Then sync any new messages from Telegram into the sheet
  await syncFromTelegram();
}

// ── SETTINGS ────────────────────────────────────────────────
function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY));
    if (saved) {
      settings = {
        botToken:  saved.botToken  || DEFAULT_BOT_TOKEN,
        channelId: saved.channelId || DEFAULT_CHANNEL_ID,
        sheetUrl:  saved.sheetUrl  || DEFAULT_SHEET_URL,
        password:  saved.password  || ''
      };
    }
  } catch(e){}
}
function persistSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}
function saveSettings() {
  settings.botToken   = val('stToken')     || settings.botToken;
  settings.channelId  = val('stChannelId') || settings.channelId;
  settings.sheetUrl   = val('stSheetUrl').trim();
  settings.password   = val('stPassword');
  persistSettings();
  toggleSettings();
  toast('Đã lưu cài đặt!', 'success');
}
function saveSetup() {
  const t = val('setupToken').trim();
  const c = val('setupChannelId').trim();
  if (!t || !c) { toast('Vui lòng nhập Bot Token và Channel ID!', 'error'); return; }
  settings.botToken  = t;
  settings.channelId = c;
  settings.sheetUrl  = val('setupSheetUrl').trim();
  settings.password  = val('setupPassword').trim();
  persistSettings();
  launchApp();
}
function fillSettingsDrawer() {
  setVal('stToken',     settings.botToken);
  setVal('stChannelId', settings.channelId);
  setVal('stSheetUrl',  settings.sheetUrl);
  setVal('stPassword',  settings.password);
}

// ── PASSWORD ────────────────────────────────────────────────
function checkPassword() {
  const pw = val('passwordInput');
  if (pw === settings.password) { launchApp(); }
  else { show('pwError'); shake(id('passwordInput')); }
}

// ── FILE STORAGE (Google Sheets primary + localStorage cache) ─

// ---- Local cache helpers ----
function loadFilesFromCache() {
  try { files = JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; } catch(e){ files=[]; }
}
function saveFilesToCache() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(files));
}

// ---- Google Sheets API helper ----
async function sheetApi(body) {
  if (!settings.sheetUrl) return null;
  try {
    const r = await fetch(settings.sheetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' }, // avoids CORS preflight
      body: JSON.stringify(body)
    });
    return await r.json();
  } catch(err) {
    console.warn('Sheet API error:', err);
    return null;
  }
}
async function sheetGet(params = '') {
  if (!settings.sheetUrl) return null;
  try {
    const url = settings.sheetUrl + (params ? '?' + params : '');
    const r = await fetch(url);
    return await r.json();
  } catch(err) {
    console.warn('Sheet GET error:', err);
    return null;
  }
}

// ---- Load from Google Sheets ----
async function loadFilesFromSheet() {
  if (!settings.sheetUrl) return;
  try {
    const res = await sheetGet('action=getFiles');
    if (res && res.ok && Array.isArray(res.files)) {
      files = res.files.map(f => ({
        ...f,
        messageId: Number(f.messageId),
        size:      Number(f.size)      || 0,
        urlTs:     Number(f.urlTs)     || 0,
        date:      Number(f.date)      || 0
      }));
      saveFilesToCache();
      render();
    }
  } catch(e) {
    console.warn('loadFilesFromSheet error:', e);
  }
}

// ---- Backward-compat alias (used in syncFromTelegram) ----
function saveFiles() { saveFilesToCache(); }

// ---- Write helpers ----
async function addFile(f) {
  files.unshift(f);
  saveFilesToCache();
  await sheetApi({ action: 'addFile', file: f });
}
async function removeFile(msgId) {
  files = files.filter(f => f.messageId !== msgId);
  saveFilesToCache();
  await sheetApi({ action: 'deleteFile', messageId: msgId });
}

// ── TELEGRAM API ─────────────────────────────────────────────
async function tgApi(method, params = {}) {
  const url = `${TG_API}/bot${settings.botToken}/${method}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params)
  });
  const data = await r.json();
  if (!data.ok) throw new Error(data.description || 'Telegram API error');
  return data.result;
}

async function tgApiForm(method, formData) {
  const url = `${TG_API}/bot${settings.botToken}/${method}`;
  const r = await fetch(url, { method: 'POST', body: formData });
  const data = await r.json();
  if (!data.ok) throw new Error(data.description || 'Telegram API error');
  return data.result;
}

async function getFileUrl(fileId) {
  const info = await tgApi('getFile', { file_id: fileId });
  return `${TG_API}/file/bot${settings.botToken}/${info.file_path}`;
}

async function refreshFileUrls() {
  toast('Đang làm mới URL...', 'info');
  let updated = 0;
  for (const f of files) {
    try {
      f.url = await getFileUrl(f.fileId);
      f.urlTs = Date.now();
      updated++;
    } catch(e){}
  }
  saveFiles();
  render();
  toast(`Đã làm mới ${updated} file`, 'success');
}

// ── SYNC FROM TELEGRAM ───────────────────────────────────────
// Reads message history from the channel and rebuilds the file index.
// Uses getUpdates trick: forward exported messages aren't available via
// Bot API, so we use getChatHistory via the bot's own messages instead.
async function syncFromTelegram() {
  if (isSyncing) return;
  isSyncing = true;
  showSyncStatus('syncing');
  try {
    const known = new Set(files.map(f => f.messageId));
    let newCount = 0;
    // Telegram Bot API doesn't expose full channel history directly.
    // We use getUpdates with offset to scan recent messages, and also
    // fetch by iterating forwardMessages from known IDs.
    // Best available approach: use copyMessage offset scanning.
    // We'll pull up to 100 updates at a time.
    let offset = 0;
    let attempts = 0;
    const maxAttempts = 5;
    while (attempts < maxAttempts) {
      const updates = await tgApi('getUpdates', {
        offset,
        limit: 100,
        allowed_updates: ['channel_post', 'message']
      });
      if (!updates || updates.length === 0) break;
      for (const upd of updates) {
        const msg = upd.channel_post || upd.message;
        if (!msg) { offset = upd.update_id + 1; continue; }
        offset = upd.update_id + 1;
        if (String(msg.chat.id) !== String(settings.channelId) &&
            String(msg.chat.id) !== '-100' + String(settings.channelId)) continue;
        const parsed = parseMessageToFile(msg);
        if (parsed && !known.has(parsed.messageId)) {
          known.add(parsed.messageId);
          files.push(parsed);
          newCount++;
        }
      }
      attempts++;
      if (updates.length < 100) break;
    }
    // Sort by date descending
    files.sort((a, b) => b.date - a.date);
    saveFiles();
    render();
    if (newCount > 0) {
      toast(`✅ Đồng bộ xong! Thêm ${newCount} file mới`, 'success');
    } else {
      toast('✅ Dữ liệu đã cập nhật', 'success');
    }
  } catch(err) {
    console.error('Sync error:', err);
    toast('Sync thất bại: ' + err.message, 'error');
  } finally {
    isSyncing = false;
    showSyncStatus('idle');
  }
}

// Full re-sync: clears local cache and re-fetches everything from Telegram
async function fullSyncFromTelegram() {
  if (!confirm('Xóa cache local và đồng bộ lại hoàn toàn từ Telegram?')) return;
  files = [];
  saveFiles();
  await syncFromTelegram();
}

function parseMessageToFile(msg) {
  let fileId, fileSize, mime, name;
  if (msg.photo) {
    const p = msg.photo[msg.photo.length - 1];
    fileId = p.file_id; fileSize = p.file_size;
    mime = 'image/jpeg'; name = `photo_${msg.message_id}.jpg`;
  } else if (msg.video) {
    fileId = msg.video.file_id; fileSize = msg.video.file_size;
    mime = msg.video.mime_type || 'video/mp4';
    name = msg.video.file_name || `video_${msg.message_id}.mp4`;
  } else if (msg.audio) {
    fileId = msg.audio.file_id; fileSize = msg.audio.file_size;
    mime = msg.audio.mime_type || 'audio/mpeg';
    name = msg.audio.file_name || msg.audio.title || `audio_${msg.message_id}.mp3`;
  } else if (msg.document) {
    fileId = msg.document.file_id; fileSize = msg.document.file_size;
    mime = msg.document.mime_type || 'application/octet-stream';
    name = msg.document.file_name || `file_${msg.message_id}`;
  } else if (msg.voice) {
    fileId = msg.voice.file_id; fileSize = msg.voice.file_size;
    mime = 'audio/ogg'; name = `voice_${msg.message_id}.ogg`;
  } else if (msg.video_note) {
    fileId = msg.video_note.file_id; fileSize = msg.video_note.file_size;
    mime = 'video/mp4'; name = `videonote_${msg.message_id}.mp4`;
  } else {
    return null;
  }

  // Extract folder from caption hashtag  #folder_name
  let folder = autoFolder(mime);
  const cap = msg.caption || '';
  const tagMatch = cap.match(/#telecloud\s+#([\w]+)/);
  if (tagMatch) folder = tagMatch[1];

  // Extract real filename from caption first line
  const capLines = cap.split('\n');
  if (capLines[0] && capLines[0].startsWith('📁 ')) {
    name = capLines[0].replace('📁 ', '').trim() || name;
  }

  return {
    messageId: msg.message_id,
    fileId,
    name,
    size: fileSize || 0,
    type: mime,
    folder,
    url: '',
    urlTs: 0,
    date: (msg.date || 0) * 1000
  };
}

function showSyncStatus(state) {
  const btn = document.getElementById('syncBtn');
  if (!btn) return;
  if (state === 'syncing') {
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Đang sync...';
    btn.disabled = true;
  } else {
    btn.innerHTML = '<i class="fas fa-sync-alt"></i> Làm mới';
    btn.disabled = false;
  }
}

// ── UPLOAD ───────────────────────────────────────────────────
async function uploadFiles(fileList) {
  const folder = val('uploadFolderCustom').trim() || val('uploadFolderSelect') || '';
  const queue = id('uploadQueue');

  for (const file of fileList) {
    if (file.size > 50 * 1024 * 1024) {
      toast(`${file.name}: vượt quá 50MB`, 'error'); continue;
    }
    const itemId = 'uq_' + Date.now() + Math.random().toString(36).slice(2);
    const icon = fileIcon(file.type, file.name);
    queue.insertAdjacentHTML('beforeend', `
      <div class="upload-item" id="${itemId}">
        <div class="upload-item-icon">${icon}</div>
        <div class="upload-item-info">
          <div class="upload-item-name">${file.name}</div>
          <div class="upload-item-status" id="${itemId}_s">Đang chuẩn bị...</div>
          <div class="progress-bar"><div class="progress-fill" id="${itemId}_p" style="width:0%"></div></div>
        </div>
        <div class="upload-status-icon" id="${itemId}_i">⏳</div>
      </div>`);

    try {
      setUploadProgress(itemId, 30, 'Đang upload...');
      const fd = new FormData();
      fd.append('chat_id', settings.channelId);
      const caption = buildCaption(file.name, folder, file.size, file.type);
      fd.append('caption', caption);

      let method, fieldName, thumbFileId = null;
      const mt = file.type;
      if (mt.startsWith('image/'))      { method = 'sendPhoto';    fieldName = 'photo'; }
      else if (mt.startsWith('video/')) { method = 'sendVideo';    fieldName = 'video'; }
      else if (mt.startsWith('audio/')) { method = 'sendAudio';    fieldName = 'audio'; }
      else                              { method = 'sendDocument'; fieldName = 'document'; }

      fd.append(fieldName, file, file.name);
      setUploadProgress(itemId, 60, 'Đang gửi lên Telegram...');

      const result = await tgApiForm(method, fd);
      setUploadProgress(itemId, 90, 'Hoàn thành...');

      const msgId = result.message_id;
      const tgObj = result.photo
        ? result.photo[result.photo.length - 1]
        : result[fieldName];

      const fileId = tgObj?.file_id || tgObj?.[0]?.file_id;
      const tgSize = tgObj?.file_size || file.size;
      let fileUrl = '';
      try { fileUrl = await getFileUrl(fileId); } catch(e){}

      addFile({
        messageId: msgId,
        fileId,
        name: file.name,
        size: tgSize,
        type: mt || 'application/octet-stream',
        folder: folder || autoFolder(mt),
        url: fileUrl,
        urlTs: Date.now(),
        date: Date.now(),
        thumb: mt.startsWith('image/') ? fileUrl : null
      });

      setUploadProgress(itemId, 100, 'Đã upload!');
      id(itemId + '_i').textContent = '✅';
      render();
    } catch(err) {
      id(itemId + '_s').textContent = 'Lỗi: ' + err.message;
      id(itemId + '_i').textContent = '❌';
      toast('Upload thất bại: ' + err.message, 'error');
    }
  }
}

function setUploadProgress(itemId, pct, status) {
  const p = id(itemId + '_p');
  const s = id(itemId + '_s');
  if (p) p.style.width = pct + '%';
  if (s) s.textContent = status;
}

function buildCaption(name, folder, size, type) {
  return `📁 ${name}\n#telecloud ${folder ? '#' + folder.replace(/\s+/g,'_') : ''}\nSize: ${formatSize(size)} | Type: ${type}`;
}

function autoFolder(mime) {
  if (!mime) return 'other';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.includes('pdf') || mime.includes('document') || mime.includes('text') || mime.includes('spreadsheet') || mime.includes('presentation')) return 'doc';
  return 'other';
}

// ── DELETE ───────────────────────────────────────────────────
async function deleteFile(msgId, skipConfirm = false) {
  if (!skipConfirm && !confirm('Xóa file này? (Sẽ xóa khỏi Telegram và danh sách)')) return;
  try {
    await tgApi('deleteMessage', { chat_id: settings.channelId, message_id: parseInt(msgId) });
  } catch(e) {}
  removeFile(msgId);
  render();
  toast('Đã xóa file', 'success');
}

// ── EXPORT / IMPORT ──────────────────────────────────────────
function exportIndex() {
  const blob = new Blob([JSON.stringify({ settings: { channelId: settings.channelId }, files }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'telecloud_index.json';
  a.click();
}
function importIndex(evt) {
  const file = evt.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const data = JSON.parse(e.target.result);
      if (data.files) { files = data.files; saveFiles(); render(); toast('Đã nhập ' + files.length + ' file', 'success'); }
    } catch(e) { toast('File JSON không hợp lệ', 'error'); }
  };
  reader.readAsText(file);
}
async function clearAllData() {
  if (!confirm('Xóa toàn bộ dữ liệu? (File trên Telegram vẫn còn)')) return;
  localStorage.removeItem(STORAGE_KEY);
  files = [];
  // Also clear Google Sheets if connected
  if (settings.sheetUrl) {
    await sheetApi({ action: 'clearFiles' });
    toast('Đã xóa dữ liệu local và Google Sheets', 'success');
  } else {
    toast('Đã xóa dữ liệu local', 'success');
  }
  render();
}

// ── HELPERS ──────────────────────────────────────────────────
const id = x => document.getElementById(x);
const val = x => (id(x) ? id(x).value : '');
const setVal = (x, v) => { if (id(x)) id(x).value = v || ''; };
function show(x) { id(x) && id(x).classList.remove('hidden'); }
function hide(x) { id(x) && id(x).classList.add('hidden'); }
function toggle(x) { id(x) && id(x).classList.toggle('hidden'); }

function formatSize(bytes) {
  if (!bytes) return '0 B';
  const u = ['B','KB','MB','GB'];
  let i = 0;
  while (bytes >= 1024 && i < 3) { bytes /= 1024; i++; }
  return bytes.toFixed(1) + ' ' + u[i];
}

function formatDate(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString('vi-VN', { day:'2-digit', month:'2-digit', year:'numeric' });
}

function fileIcon(mime, name) {
  if (!mime) mime = '';
  const ext = name ? name.split('.').pop().toLowerCase() : '';
  if (mime.startsWith('image/')) return '🖼️';
  if (mime.startsWith('video/')) return '🎬';
  if (mime.startsWith('audio/')) return '🎵';
  if (mime.includes('pdf')) return '📕';
  if (['doc','docx'].includes(ext)) return '📝';
  if (['xls','xlsx'].includes(ext)) return '📊';
  if (['ppt','pptx'].includes(ext)) return '📑';
  if (['zip','rar','7z','tar','gz'].includes(ext)) return '📦';
  return '📄';
}

function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  id('toastContainer').appendChild(el);
  setTimeout(() => { el.style.animation = 'fadeOut .3s ease forwards'; setTimeout(() => el.remove(), 300); }, 3000);
}

function shake(el) {
  el.style.animation = 'none';
  el.offsetHeight;
  el.style.animation = 'shake .4s ease';
}

document.addEventListener('DOMContentLoaded', init);

// ============================================================
//  PART 2 – UI Rendering & Events
// ============================================================

// ── RENDER ───────────────────────────────────────────────────
function render() {
  updateSidebarCounts();
  renderFileGrid();
  updateStorageStats();
}

function getFilteredFiles() {
  let list = [...files];
  // Folder filter
  if (currentFolder !== 'all') {
    if (['image','video','audio','doc','other'].includes(currentFolder)) {
      list = list.filter(f => f.folder === currentFolder || autoFolder(f.type) === currentFolder);
    } else {
      list = list.filter(f => f.folder === currentFolder);
    }
  }
  // Search
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    list = list.filter(f => f.name.toLowerCase().includes(q));
  }
  // Sort
  const [by, dir] = currentSort.split('-');
  list.sort((a, b) => {
    let va = a[by === 'date' ? 'date' : by === 'name' ? 'name' : 'size'];
    let vb = b[by === 'date' ? 'date' : by === 'name' ? 'name' : 'size'];
    if (typeof va === 'string') { va = va.toLowerCase(); vb = vb.toLowerCase(); }
    if (va < vb) return dir === 'asc' ? -1 : 1;
    if (va > vb) return dir === 'asc' ? 1 : -1;
    return 0;
  });
  return list;
}

function renderFileGrid() {
  const grid = id('fileGrid');
  filteredFiles = getFilteredFiles();
  id('fileBadge').textContent = filteredFiles.length + ' file';

  if (filteredFiles.length === 0) {
    grid.innerHTML = '';
    show('emptyState');
    return;
  }
  hide('emptyState');

  if (currentView === 'grid') {
    grid.className = 'file-grid';
    grid.innerHTML = filteredFiles.map((f, i) => buildGridCard(f, i)).join('');
  } else {
    grid.className = 'file-grid list-view';
    grid.innerHTML = filteredFiles.map((f, i) => buildListCard(f, i)).join('');
  }
}

function buildGridCard(f, i) {
  const isImg = f.type.startsWith('image/');
  const isVid = f.type.startsWith('video/');
  const thumbEl = (isImg || isVid) && f.url
    ? `<div style="position:relative">
        ${isImg ? `<img class="file-thumb" src="${f.url}" alt="${esc(f.name)}" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
                   <div class="file-thumb-placeholder" style="display:none">${fileIcon(f.type,f.name)}</div>`
                : `<div class="file-thumb-placeholder">${fileIcon(f.type,f.name)}</div>`}
        ${isVid ? `<div class="video-badge">▶ Video</div>` : ''}
        <div class="play-overlay"><div class="play-icon">▶</div></div>
       </div>`
    : `<div class="file-thumb-placeholder">${fileIcon(f.type, f.name)}</div>`;

  return `<div class="file-card" onclick="openMedia(${i})">
    ${thumbEl}
    <div class="file-card-info">
      <div class="file-card-name" title="${esc(f.name)}">${esc(f.name)}</div>
      <div class="file-card-meta">${formatSize(f.size)} · ${formatDate(f.date)}</div>
    </div>
    <div class="file-card-actions">
      <button class="card-action-btn" onclick="event.stopPropagation();shareFile('${f.url}','${esc(f.name)}')" title="Copy link">🔗</button>
      <button class="card-action-btn" onclick="event.stopPropagation();downloadFile('${f.url}','${esc(f.name)}')" title="Tải về">⬇️</button>
      <button class="card-action-btn del" onclick="event.stopPropagation();deleteFile(${f.messageId})" title="Xóa">🗑️</button>
    </div>
  </div>`;
}

function buildListCard(f, i) {
  const isImg = f.type.startsWith('image/');
  const thumbEl = isImg && f.url
    ? `<img class="file-thumb" src="${f.url}" alt="" loading="lazy" onerror="this.outerHTML='<div class=\\'file-thumb-placeholder\\'>${fileIcon(f.type,f.name)}</div>'">`
    : `<div class="file-thumb-placeholder">${fileIcon(f.type, f.name)}</div>`;

  return `<div class="file-card list-card" onclick="openMedia(${i})">
    ${thumbEl}
    <div class="list-info">
      <div class="list-name" title="${esc(f.name)}">${esc(f.name)}</div>
      <div class="list-meta">${f.folder || 'other'} · ${formatSize(f.size)} · ${formatDate(f.date)}</div>
    </div>
    <div class="list-actions" onclick="event.stopPropagation()">
      <button class="list-action-btn" onclick="shareFile('${f.url}','${esc(f.name)}')" title="Copy link"><i class="fas fa-link"></i></button>
      <button class="list-action-btn" onclick="downloadFile('${f.url}','${esc(f.name)}')" title="Tải về"><i class="fas fa-download"></i></button>
      <button class="list-action-btn del" onclick="deleteFile(${f.messageId})" title="Xóa"><i class="fas fa-trash"></i></button>
    </div>
  </div>`;
}

function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;'); }

function updateSidebarCounts() {
  const counts = { all: files.length, image: 0, video: 0, audio: 0, doc: 0, other: 0 };
  files.forEach(f => {
    const folder = f.folder || autoFolder(f.type);
    if (counts[folder] !== undefined) counts[folder]++;
    else counts.other++;
  });
  Object.keys(counts).forEach(k => {
    const el = id('cnt-' + k);
    if (el) el.textContent = counts[k];
  });
  // Custom folders
  const customFolderNames = [...new Set(files.map(f => f.folder).filter(f => f && !['image','video','audio','doc','other'].includes(f)))];
  const nav = id('customFolders');
  if (nav) {
    nav.innerHTML = customFolderNames.map(name => {
      const cnt = files.filter(f => f.folder === name).length;
      const active = currentFolder === name ? 'active' : '';
      return `<a class="nav-item ${active}" onclick="setFolder('${name}')" data-folder="${name}">
        <i class="fas fa-folder"></i> ${esc(name)} <span class="badge">${cnt}</span>
      </a>`;
    }).join('');
  }
}

function updateStorageStats() {
  const total = files.reduce((s, f) => s + (f.size || 0), 0);
  if (id('totalSize')) id('totalSize').textContent = formatSize(total);
  if (id('totalFiles')) id('totalFiles').textContent = files.length + ' files';
}

function updateSectionTitle() {
  const titles = { all: 'Tất cả file', image: 'Ảnh', video: 'Video', audio: 'Âm nhạc', doc: 'Tài liệu', other: 'Khác' };
  const title = titles[currentFolder] || currentFolder;
  if (id('sectionTitle')) id('sectionTitle').textContent = title;
}

// ── FOLDER & VIEW ─────────────────────────────────────────────
function setFolder(folder) {
  currentFolder = folder;
  document.querySelectorAll('.nav-item').forEach(el => {
    el.classList.toggle('active', el.dataset.folder === folder);
  });
  updateSectionTitle();
  render();
  if (window.innerWidth <= 768) toggleSidebar();
}

function setView(v) {
  currentView = v;
  id('gridBtn').classList.toggle('active', v === 'grid');
  id('listBtn').classList.toggle('active', v === 'list');
  renderFileGrid();
}

function setSort(v) { currentSort = v; renderFileGrid(); }

function addCustomFolder() {
  const name = prompt('Tên thư mục mới:');
  if (name && name.trim()) {
    const key = name.trim().toLowerCase().replace(/\s+/g, '_');
    id('uploadFolderSelect').innerHTML += `<option value="${key}">${name.trim()}</option>`;
    updateSidebarCounts();
    toast('Thêm thư mục: ' + name.trim(), 'success');
  }
}

// ── SEARCH ───────────────────────────────────────────────────
function handleSearch(q) {
  searchQuery = q;
  id('clearSearchBtn').classList.toggle('hidden', !q);
  renderFileGrid();
}
function clearSearch() {
  searchQuery = '';
  id('searchInput').value = '';
  id('clearSearchBtn').classList.add('hidden');
  renderFileGrid();
}

// ── SIDEBAR ──────────────────────────────────────────────────
function toggleSidebar() {
  id('sidebar').classList.toggle('open');
}

// ── SETTINGS ─────────────────────────────────────────────────
function toggleSettings() {
  toggle('settingsDrawer');
  toggle('settingsOverlay');
  if (!id('settingsDrawer').classList.contains('hidden')) fillSettingsDrawer();
}

// ── UPLOAD MODAL ─────────────────────────────────────────────
function openUploadModal() {
  show('uploadModal');
  id('uploadQueue').innerHTML = '';
  id('fileInput').value = '';
}
function closeUploadModal() { hide('uploadModal'); }

function handleFileSelect(evt) {
  uploadFiles(Array.from(evt.target.files));
}

// ── DRAG & DROP ──────────────────────────────────────────────
function setupDragDrop() {
  const body = document.body;
  body.addEventListener('dragover', e => {
    e.preventDefault();
    if (id('mainApp') && !id('mainApp').classList.contains('hidden')) {
      openUploadModal();
      const dz = id('dropZone');
      if (dz) dz.classList.add('drag-over');
    }
  });
  body.addEventListener('drop', e => {
    e.preventDefault();
    const dz = id('dropZone');
    if (dz) dz.classList.remove('drag-over');
    const files = Array.from(e.dataTransfer.files);
    if (files.length) uploadFiles(files);
  });
  body.addEventListener('dragleave', e => {
    if (e.clientX === 0 && e.clientY === 0) {
      const dz = id('dropZone');
      if (dz) dz.classList.remove('drag-over');
    }
  });

  // Drop zone inside upload modal
  const dz = id('dropZone');
  if (dz) {
    dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drag-over'); });
    dz.addEventListener('dragleave', () => dz.classList.remove('drag-over'));
    dz.addEventListener('drop', e => {
      e.preventDefault(); dz.classList.remove('drag-over');
      uploadFiles(Array.from(e.dataTransfer.files));
    });
  }
}

// ── MEDIA VIEWER ─────────────────────────────────────────────
async function openMedia(index) {
  currentMediaIndex = index;
  const f = filteredFiles[index];
  if (!f) return;

  // Refresh URL if older than 50 min
  if (!f.url || Date.now() - (f.urlTs || 0) > 50 * 60 * 1000) {
    try { f.url = await getFileUrl(f.fileId); f.urlTs = Date.now(); saveFiles(); } catch(e){}
  }

  show('mediaModal');
  id('mediaName').textContent = f.name;
  id('mediaSize').textContent = formatSize(f.size);
  renderMediaStage(f);
  id('prevBtn').classList.toggle('hidden', index <= 0);
  id('nextBtn').classList.toggle('hidden', index >= filteredFiles.length - 1);
}

function renderMediaStage(f) {
  const stage = id('mediaStage');
  const mime = f.type || '';
  if (mime.startsWith('image/')) {
    stage.innerHTML = `<img src="${f.url}" alt="${esc(f.name)}" style="max-width:100%;max-height:80vh;object-fit:contain;border-radius:8px">`;
  } else if (mime.startsWith('video/')) {
    stage.innerHTML = `<video src="${f.url}" controls autoplay style="max-width:100%;max-height:80vh;border-radius:8px" controlsList="nodownload"></video>`;
  } else if (mime.startsWith('audio/')) {
    stage.innerHTML = `<div style="text-align:center">
      <div style="font-size:80px;margin-bottom:16px">🎵</div>
      <p style="margin-bottom:16px;color:var(--sub)">${esc(f.name)}</p>
      <audio src="${f.url}" controls autoplay style="width:360px;max-width:100%"></audio>
    </div>`;
  } else {
    stage.innerHTML = `<div class="doc-preview">
      <div class="doc-icon">${fileIcon(f.type, f.name)}</div>
      <p>${esc(f.name)}</p>
      <p style="color:var(--muted);font-size:14px;margin-bottom:20px">${formatSize(f.size)}</p>
      <button class="btn-primary" style="display:inline-flex;width:auto;gap:8px" onclick="downloadFile('${f.url}','${esc(f.name)}')">
        <i class="fas fa-download"></i> Tải về
      </button>
    </div>`;
  }
}

function closeMediaModal() {
  hide('mediaModal');
  const stage = id('mediaStage');
  if (stage) stage.innerHTML = '';
}

function navigateMedia(dir) {
  const newIndex = currentMediaIndex + dir;
  if (newIndex >= 0 && newIndex < filteredFiles.length) openMedia(newIndex);
}

function downloadCurrentFile() {
  const f = filteredFiles[currentMediaIndex];
  if (f) downloadFile(f.url, f.name);
}
function shareCurrentFile() {
  const f = filteredFiles[currentMediaIndex];
  if (f) shareFile(f.url, f.name);
}
async function deleteCurrentFile() {
  const f = filteredFiles[currentMediaIndex];
  if (!f) return;
  if (!confirm('Xóa file này?')) return;
  closeMediaModal();
  await deleteFile(f.messageId, true);
}

function downloadFile(url, name) {
  const a = document.createElement('a');
  a.href = url; a.download = name; a.target = '_blank';
  a.click();
}
function shareFile(url, name) {
  if (url) {
    navigator.clipboard.writeText(url).then(() => toast('Đã copy link: ' + name, 'success'));
  } else toast('File chưa có URL, hãy Làm mới trước', 'error');
}

// ── KEYBOARD ─────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (!id('mediaModal').classList.contains('hidden')) {
    if (e.key === 'ArrowLeft')  navigateMedia(-1);
    if (e.key === 'ArrowRight') navigateMedia(1);
    if (e.key === 'Escape')     closeMediaModal();
  }
  if (e.key === 'Escape') {
    closeUploadModal();
    if (!id('settingsDrawer').classList.contains('hidden')) toggleSettings();
  }
});

