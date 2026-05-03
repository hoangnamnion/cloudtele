// ============================================================
//  TeleCloud – app.js (HOÀN CHỈNH)
//  - Chống zoom toàn trang, chỉ zoom khi xem ảnh
//  - Thoát ảnh -> trang về vị trí ban đầu
//  - Upload song song nhiều file, mỗi file có thanh tiến trình
//  - Cache URL để load ảnh nhanh
// ============================================================

const STORAGE_KEY   = 'tc_files';
const SETTINGS_KEY  = 'tc_settings';
const TG_API        = 'https://api.telegram.org';

// ── DEFAULT CREDENTIALS ──
const DEFAULT_BOT_TOKEN  = '8327837990:AAHVz_qXiui3_Thbo2sN4khegqFoLjAWvd0';
const DEFAULT_CHANNEL_ID = '6754356446';
const DEFAULT_SHEET_URL  = 'https://green-forest-9ebb.caovannamutt.workers.dev/';

// ── TỐI ƯU: Cache URL trong memory ──
const urlCache = new Map();
const IMAGE_CACHE_DURATION = 60 * 60 * 1000;
const MAX_CONCURRENT_UPLOADS = 3;
const MAX_CONCURRENT_REFRESH = 5;

let settings = {
  botToken:  DEFAULT_BOT_TOKEN,
  channelId: DEFAULT_CHANNEL_ID,
  sheetUrl:  DEFAULT_SHEET_URL,
  password:  ''
};

let files = [];
let folders = [];
let currentPath = [];
let currentFolderId = null;
let currentFolder = 'all';
let currentView = 'grid';
let currentSort = 'date-desc';
let searchQuery = '';
let currentMediaIndex = -1;
let filteredFiles = [];
let isSyncing = false;
let isAdminMode = false;
let currentTab = 'dashboard';

// ── LƯU TRẠNG THÁI SCROLL TRƯỚC KHI MỞ ẢNH ──
let savedScrollPosition = { x: 0, y: 0 };

// ╔═══════════════════════════════════════════════════════════╗
// ║              CHỐNG ZOOM TOÀN TRANG                       ║
// ║    Chỉ cho phép zoom khi Media Viewer đang mở            ║
// ╚═══════════════════════════════════════════════════════════╝

function isMediaOpen() {
  const modal = document.getElementById('mediaModal');
  return modal && !modal.classList.contains('hidden');
}

// Ngăn pinch zoom (2 ngón)
document.addEventListener('touchmove', function(e) {
  if (e.touches.length > 1 && !isMediaOpen()) {
    e.preventDefault();
  }
}, { passive: false });

// Ngăn gesture zoom trên Safari iOS
document.addEventListener('gesturestart', function(e) {
  if (!isMediaOpen()) e.preventDefault();
});

document.addEventListener('gesturechange', function(e) {
  if (!isMediaOpen()) e.preventDefault();
});

document.addEventListener('gestureend', function(e) {
  if (!isMediaOpen()) e.preventDefault();
});

// Ngăn Ctrl+Scroll / Cmd+Scroll zoom
document.addEventListener('wheel', function(e) {
  if ((e.ctrlKey || e.metaKey) && !isMediaOpen()) {
    e.preventDefault();
  }
}, { passive: false });

// Ngăn Ctrl+ / Ctrl- / Ctrl+0
document.addEventListener('keydown', function(e) {
  if ((e.ctrlKey || e.metaKey) && (e.key === '+' || e.key === '-' || e.key === '0')) {
    if (!isMediaOpen()) {
      e.preventDefault();
    }
  }
});

// ╔═══════════════════════════════════════════════════════════╗
// ║                      INIT                                ║
// ╚═══════════════════════════════════════════════════════════╝

function init() {
  initTheme();
  const yearEl = id('year');
  if (yearEl) yearEl.textContent = new Date().getFullYear();
  loadSettings();
  
  if (!settings.botToken)  settings.botToken  = DEFAULT_BOT_TOKEN;
  if (!settings.channelId) settings.channelId = DEFAULT_CHANNEL_ID;
  if (!settings.sheetUrl)  settings.sheetUrl  = DEFAULT_SHEET_URL;
  persistSettings();

  loadFilesFromCache();
  loadUrlCache();
  
  if (settings.password) {
    show('passwordGate');
    hide('mainApp');
  } else {
    launchApp();
  }
  setupDragDrop();
}

function initTheme() {
  const theme = localStorage.getItem('tc_theme') || 'dark';
  document.documentElement.setAttribute('data-theme', theme);
  const btn = document.getElementById('themeToggle');
  if (btn) {
    btn.innerHTML = theme === 'dark' ? '<span class="icon">🌙</span>' : '<span class="icon">☀️</span>';
    btn.onclick = toggleTheme;
  }
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme');
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('tc_theme', next);
  const btn = document.getElementById('themeToggle');
  if (btn) {
    btn.innerHTML = next === 'dark' ? '<span class="icon">🌙</span>' : '<span class="icon">☀️</span>';
  }
}

async function launchApp() {
  hide('passwordGate');
  show('mainApp');
  fillSettingsDrawer();
  loadFilesFromCache();
  render();
  
  await Promise.all([
    loadFilesFromSheet(),
    syncFromTelegram(),
    loadFolders()
  ]);
}

// ╔═══════════════════════════════════════════════════════════╗
// ║                  URL CACHE MANAGEMENT                    ║
// ╚═══════════════════════════════════════════════════════════╝

function loadUrlCache() {
  try {
    const cached = JSON.parse(localStorage.getItem('tc_urlCache') || '{}');
    Object.entries(cached).forEach(([key, val]) => {
      if (val && val.url && (Date.now() - val.urlTs) < IMAGE_CACHE_DURATION) {
        urlCache.set(key, val); // Key là fileId (string)
      }
    });
  } catch(e) {}
}

function saveUrlCache() {
  const obj = {};
  urlCache.forEach((val, key) => { obj[key] = val; });
  try { localStorage.setItem('tc_urlCache', JSON.stringify(obj)); } catch(e) {}
}

function getCachedUrl(fileId) {
  if (!fileId) return null;
  const cached = urlCache.get(String(fileId));
  if (cached && (Date.now() - cached.urlTs) < IMAGE_CACHE_DURATION) {
    return cached.url;
  }
  return null;
}

function setCachedUrl(fileId, url) {
  if (!fileId || !url) return;
  urlCache.set(String(fileId), { url, urlTs: Date.now() });
}

// ╔═══════════════════════════════════════════════════════════╗
// ║                     SETTINGS                             ║
// ╚═══════════════════════════════════════════════════════════╝

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
  } catch(e) {}
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

function fillSettingsDrawer() {
  setVal('stToken',     settings.botToken);
  setVal('stChannelId', settings.channelId);
  setVal('stSheetUrl',  settings.sheetUrl);
  setVal('stPassword',  settings.password);
}

// ╔═══════════════════════════════════════════════════════════╗
// ║                    PASSWORD                              ║
// ╚═══════════════════════════════════════════════════════════╝

function checkPassword() {
  const pw = val('passwordInput');
  if (pw === settings.password) {
    launchApp();
  } else {
    show('pwError');
    shake(id('passwordInput'));
  }
}

// ╔═══════════════════════════════════════════════════════════╗
// ║                 STORAGE & API                            ║
// ╚═══════════════════════════════════════════════════════════╝

function loadFilesFromCache() {
  try { files = JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; } catch(e) { files = []; }
  try { 
    let cachedFolders = JSON.parse(localStorage.getItem('tc_folders')) || []; 
    folders = cachedFolders.filter(f => f && f.name && f.name !== 'undefined');
  } catch(e) { folders = []; }
}

function saveFilesToCache() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(files));
}

function saveFoldersToCache() {
  localStorage.setItem('tc_folders', JSON.stringify(folders));
}

async function sheetApi(body) {
  if (!settings.sheetUrl) return null;
  try {
    const r = await fetch(settings.sheetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    return await r.json();
  } catch(err) { return null; }
}

async function sheetGet(params = '') {
  if (!settings.sheetUrl) return null;
  try {
    const url = settings.sheetUrl + (params ? '?' + params : '');
    const r = await fetch(url);
    return await r.json();
  } catch(err) { return null; }
}

async function loadFilesFromSheet() {
  if (!settings.sheetUrl) return;
  const res = await sheetGet('action=getFiles');
  if (res && res.ok && Array.isArray(res.files)) {
    files = res.files.map(f => ({
      ...f,
      messageId: Number(f.messageId),
      size: Number(f.size) || 0,
      urlTs: Number(f.urlTs) || 0,
      date: Number(f.date) || 0
    }));
    saveFilesToCache();
    render();
  }
}

async function loadFolders() {
  if (!settings.sheetUrl) return;
  const res = await sheetGet('action=getFolders');
  if (res && res.ok && Array.isArray(res.folders)) {
    folders = res.folders.filter(f => f && f.name && f.name !== 'undefined');
    saveFoldersToCache();
    render();
  }
}

async function saveFolders() {
  saveFoldersToCache();
  if (settings.sheetUrl) {
    await sheetApi({ action: 'saveFolders', folders });
  }
}

function saveFiles() { saveFilesToCache(); }

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

// ╔═══════════════════════════════════════════════════════════╗
// ║                 TELEGRAM API                             ║
// ╚═══════════════════════════════════════════════════════════╝

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
  const cached = getCachedUrl(fileId);
  if (cached) return cached;
  
  const info = await tgApi('getFile', { file_id: fileId });
  const url = `${TG_API}/file/bot${settings.botToken}/${info.file_path}`;
  setCachedUrl(fileId, url);
  return url;
}

async function batchGetFileUrls(fileInfos) {
  const results = [];
  const toFetch = [];
  
  fileInfos.forEach(f => {
    const cached = getCachedUrl(f.fileId);
    if (cached) {
      results.push({ ...f, url: cached });
    } else {
      toFetch.push(f);
    }
  });
  
  if (toFetch.length > 0) {
    // Giới hạn số lượng fetch song song để tránh bị Telegram chặn (Rate Limit)
    for (let i = 0; i < toFetch.length; i += MAX_CONCURRENT_REFRESH) {
      const chunk = toFetch.slice(i, i + MAX_CONCURRENT_REFRESH);
      const fetched = await Promise.all(
        chunk.map(async f => {
          try {
            const url = await getFileUrl(f.fileId);
            return { ...f, url };
          } catch(e) {
            return { ...f, url: '' };
          }
        })
      );
      results.push(...fetched);
    }
  }
  
  return results;
}

async function syncFromTelegram() {
  if (isSyncing) return;
  isSyncing = true;
  showSyncStatus('syncing');
  try {
    await loadFilesFromSheet();
    await loadFolders();

    const known = new Set(files.map(f => f.messageId));
    let discovered = [];
    let offset = 0;
    
    for (let i = 0; i < 5; i++) {
      const updates = await tgApi('getUpdates', { offset, limit: 100 });
      if (!updates || updates.length === 0) break;
      
      for (const upd of updates) {
        offset = upd.update_id + 1;
        const msg = upd.channel_post || upd.message;
        if (!msg) continue;
        if (String(msg.chat.id) !== String(settings.channelId) && 
            String(msg.chat.id) !== '-100' + String(settings.channelId)) continue;
        
        const parsed = parseMessageToFile(msg);
        if (parsed && !known.has(parsed.messageId)) {
          discovered.push(parsed);
          known.add(parsed.messageId);
        }
      }
      if (updates.length < 100) break;
    }
    
    if (discovered.length > 0) {
      const withUrls = await batchGetFileUrls(
        discovered.map(f => ({ fileId: f.fileId, messageId: f.messageId }))
      );
      
      withUrls.forEach(r => {
        const orig = discovered.find(d => d.messageId === r.messageId);
        if (orig && r.url) {
          orig.url = r.url;
          orig.urlTs = Date.now();
        }
      });
      
      files.push(...discovered);
      files.sort((a, b) => b.date - a.date);
      saveFiles();
      saveUrlCache();
      render();
      await sheetApi({ action: 'addFiles', files: discovered });
      toast(`Đã đồng bộ ${discovered.length} file`, 'success');
    }
  } catch(e) {
    console.error('Sync error:', e);
  } finally {
    isSyncing = false;
    showSyncStatus('idle');
  }
}

function parseMessageToFile(msg) {
  let fileId, fileSize, mime, name;
  
  if (msg.photo) {
    const p = msg.photo[msg.photo.length - 1];
    fileId = p.file_id;
    fileSize = p.file_size;
    mime = 'image/jpeg';
    name = `photo_${msg.message_id}.jpg`;
  } else if (msg.video) {
    fileId = msg.video.file_id;
    fileSize = msg.video.file_size;
    mime = msg.video.mime_type || 'video/mp4';
    name = msg.video.file_name || `video_${msg.message_id}.mp4`;
  } else if (msg.document) {
    fileId = msg.document.file_id;
    fileSize = msg.document.file_size;
    mime = msg.document.mime_type || 'application/octet-stream';
    name = msg.document.file_name || `file_${msg.message_id}`;
  } else if (msg.audio) {
    fileId = msg.audio.file_id;
    fileSize = msg.audio.file_size;
    mime = msg.audio.mime_type || 'audio/mpeg';
    name = msg.audio.file_name || `audio_${msg.message_id}.mp3`;
  } else {
    return null;
  }

  let folder = autoFolder(mime);
  const cap = msg.caption || '';
  const tagMatch = cap.match(/#telecloud\s+#([\w]+)/);
  if (tagMatch) folder = tagMatch[1];

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
  const btn = id('syncBtn');
  if (!btn) return;
  if (state === 'syncing') {
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Sync...';
    btn.disabled = true;
  } else {
    btn.innerHTML = '<i class="fas fa-sync-alt"></i> Làm mới';
    btn.disabled = false;
  }
}

// ╔═══════════════════════════════════════════════════════════╗
// ║              UPLOAD SONG SONG                            ║
// ╚═══════════════════════════════════════════════════════════╝

async function uploadFiles(fileList) {
  if (!fileList || fileList.length === 0) return;
  
  const total = fileList.length;
  const folder = val('uploadFolderCustom').trim() || val('uploadFolderSelect') || currentFolderId || '';
  const modalHeader = document.querySelector('#uploadModal h3');
  const originalHeaderText = modalHeader ? modalHeader.innerHTML : '';
  
  const queue = Array.from(fileList).map((file, index) => ({
    file,
    index,
    folder,
    itemId: 'uq_' + Date.now() + '_' + index
  }));
  
  const queueContainer = id('uploadQueue');
  if (!queueContainer) return;
  
  queueContainer.innerHTML = '';
  
  // Tạo UI cho TẤT CẢ file trong queue
  queue.forEach(item => {
    queueContainer.insertAdjacentHTML('beforeend', `
      <div class="upload-item" id="${item.itemId}">
        <div class="upload-item-info">
          <div class="upload-item-name"><span>[${item.index + 1}/${total}]</span> ${esc(item.file.name)}</div>
          <div class="progress-bar"><div class="progress-fill" id="${item.itemId}_p" style="width:0%"></div></div>
          <div class="upload-item-status" id="${item.itemId}_s">⏳ Đang chờ...</div>
        </div>
      </div>`);
  });
  
  if (modalHeader) {
    modalHeader.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Đang tải (0/${total})...`;
  }
  
  let completed = 0;
  let failed = 0;
  
  const batches = [];
  for (let i = 0; i < queue.length; i += MAX_CONCURRENT_UPLOADS) {
    batches.push(queue.slice(i, i + MAX_CONCURRENT_UPLOADS));
  }
  
  for (const batch of batches) {
    const results = await Promise.allSettled(
      batch.map(item => uploadSingleFile(item, total))
    );
    
    results.forEach(result => {
      if (result.status === 'fulfilled' && result.value) {
        completed++;
      } else {
        failed++;
      }
    });
    
    if (modalHeader) {
      modalHeader.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Đang tải (${completed + failed}/${total})...`;
    }
  }
  
  if (modalHeader) {
    modalHeader.innerHTML = originalHeaderText;
  }
  
  if (completed > 0) {
    toast(`✅ Đã tải lên ${completed} file thành công!`, 'success');
  }
  if (failed > 0) {
    toast(`❌ ${failed} file bị lỗi`, 'error');
  }
  
  setTimeout(() => {
    if (queueContainer) {
      queueContainer.querySelectorAll('.upload-item').forEach(el => el.classList.add('fade-out'));
      setTimeout(() => { if (queueContainer) queueContainer.innerHTML = ''; }, 500);
    }
  }, 2000);
  
  render();
}

async function uploadSingleFile(item, total) {
  const { file, folder, itemId } = item;
  
  if (file.size > 50 * 1024 * 1024) {
    updateUploadUI(itemId, 100, `${file.name}: File > 50MB!`, 'error');
    return false;
  }
  
  updateUploadUI(itemId, 5, 'Đang chuẩn bị...', 'uploading');
  
  try {
    const fd = new FormData();
    fd.append('chat_id', settings.channelId);
    fd.append('caption', `📁 ${file.name}\n#telecloud ${folder ? '#' + folder : ''}\nSize: ${formatSize(file.size)}`);
    
    let method;
    if (file.type.startsWith('image/')) {
      method = 'sendPhoto';
      fd.append('photo', file, file.name);
    } else if (file.type.startsWith('video/')) {
      method = 'sendVideo';
      fd.append('video', file, file.name);
    } else {
      method = 'sendDocument';
      fd.append('document', file, file.name);
    }
    
    updateUploadUI(itemId, 25, 'Đang gửi lên Telegram...', 'uploading');
    
    const res = await tgApiForm(method, fd);
    
    updateUploadUI(itemId, 65, 'Đang lấy URL...', 'uploading');
    
    const tgObj = res.photo ? res.photo[res.photo.length - 1] : 
                  res.video || res.document || res.audio;
    const fileUrl = await getFileUrl(tgObj.file_id);
    
    updateUploadUI(itemId, 85, 'Đang lưu chỉ mục...', 'uploading');
    
    await addFile({
      messageId: res.message_id,
      fileId: tgObj.file_id,
      name: file.name,
      size: tgObj.file_size || file.size,
      type: file.type || 'application/octet-stream',
      folder,
      url: fileUrl,
      urlTs: Date.now(),
      date: Date.now()
    });
    
    updateUploadUI(itemId, 100, 'Thành công!', 'success');
    saveUrlCache();
    return true;
    
  } catch (e) {
    updateUploadUI(itemId, 100, `Lỗi: ${e.message}`, 'error');
    console.error('Upload error:', e);
    return false;
  }
}

function updateUploadUI(itemId, percent, status, type) {
  const pFill = id(itemId + '_p');
  const pStat = id(itemId + '_s');
  
  if (pFill) {
    pFill.style.width = percent + '%';
    if (type === 'error') {
      pFill.style.background = 'var(--danger)';
    } else if (type === 'success') {
      pFill.style.background = 'var(--success)';
    }
  }
  
  if (pStat) {
    let icon, color;
    switch(type) {
      case 'success':
        icon = '✅';
        color = 'var(--success)';
        break;
      case 'error':
        icon = '❌';
        color = 'var(--danger)';
        break;
      default:
        icon = '⏳';
        color = 'var(--sub)';
    }
    pStat.innerHTML = `<span style="color:${color}">${icon} ${status}</span>`;
  }
}

// ╔═══════════════════════════════════════════════════════════╗
// ║                    DELETE                                ║
// ╚═══════════════════════════════════════════════════════════╝

async function deleteFile(msgId, skipConfirm = false) {
  if (!skipConfirm && !confirm('Xóa file này?')) return;
  try {
    await tgApi('deleteMessage', { chat_id: settings.channelId, message_id: parseInt(msgId) });
  } catch(e) {
    console.warn('Delete from Telegram failed:', e);
  }
  await removeFile(msgId);
  render();
}

async function clearAllData() {
  if (!confirm('Xóa TOÀN BỘ dữ liệu trên máy và Cloud?')) return;
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem('tc_folders');
  localStorage.removeItem('tc_urlCache');
  files = [];
  folders = [];
  urlCache.clear();
  if (settings.sheetUrl) {
    await sheetApi({ action: 'clearFiles' });
    await sheetApi({ action: 'saveFolders', folders: [] });
  }
  render();
  toast('Đã xóa toàn bộ dữ liệu!', 'success');
}

// ╔═══════════════════════════════════════════════════════════╗
// ║                    SORT                                  ║
// ╚═══════════════════════════════════════════════════════════╝

function setSort(sortType) {
  currentSort = sortType;
  render();
}

function sortFiles(list) {
  const sorted = [...list];
  switch(currentSort) {
    case 'date-asc':
      return sorted.sort((a, b) => a.date - b.date);
    case 'name-asc':
      return sorted.sort((a, b) => a.name.localeCompare(b.name));
    case 'size-desc':
      return sorted.sort((a, b) => b.size - a.size);
    case 'date-desc':
    default:
      return sorted.sort((a, b) => b.date - a.date);
  }
}

// ╔═══════════════════════════════════════════════════════════╗
// ║                    RENDER                                ║
// ╚═══════════════════════════════════════════════════════════╝

function render() {
  updateSidebarCounts();
  
  if (currentTab === 'dashboard') {
    show('dashboardView');
    hide('filesView');
    renderDashboard();
  } else {
    hide('dashboardView');
    show('filesView');
    renderFileGrid();
  }
  
  updateStorageStats();
  
  const mediaDel = id('mediaDelBtn');
  if (mediaDel) {
    isAdminMode ? mediaDel.classList.remove('hidden') : mediaDel.classList.add('hidden');
  }

  // Update active sidebar nav
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
  if (currentTab === 'dashboard') {
    id('nav-dashboard')?.classList.add('active');
  } else {
    id('nav-files')?.classList.add('active');
  }

  // Update active mobile nav
  document.querySelectorAll('.m-nav-item').forEach(el => el.classList.remove('active'));
  if (currentTab === 'dashboard') {
    id('m-nav-home')?.classList.add('active');
  } else if (currentTab === 'files') {
    id('m-nav-files')?.classList.add('active');
  }
}

function showView(tab) {
  currentTab = tab;
  if (tab === 'files') {
    currentFolder = 'all';
    currentFolderId = null;
    searchQuery = '';
  }
  render();
}

function renderDashboard() {
  updateGreeting();
  updateDashboardStats();
  renderRecentFiles();
}

function updateGreeting() {
  const hour = new Date().getHours();
  let g = 'Chào buổi tối!';
  if (hour < 12) g = 'Chào buổi sáng!';
  else if (hour < 18) g = 'Chào buổi chiều!';
  
  const el = id('greetingText');
  if (el) el.textContent = g;
}

function updateDashboardStats() {
  const totalFiles = files.length;
  const totalSize = files.reduce((acc, f) => acc + (f.size || 0), 0);
  const totalFolders = folders.length;
  
  setTxt('stat-total-files', totalFiles);
  setTxt('stat-total-size', formatSize(totalSize));
  setTxt('stat-total-folders', totalFolders);
  
  // Categories count
  const cats = { image: 0, video: 0, audio: 0, document: 0 };
  files.forEach(f => {
    if (f.type.startsWith('image/')) cats.image++;
    else if (f.type.startsWith('video/')) cats.video++;
    else if (f.type.startsWith('audio/')) cats.audio++;
    else cats.document++;
  });
  
  setTxt('cat-img-count', cats.image + ' file');
  setTxt('cat-vid-count', cats.video + ' file');
  setTxt('cat-aud-count', cats.audio + ' file');
  setTxt('cat-doc-count', cats.document + ' file');
}

function renderRecentFiles() {
  const container = id('recentList');
  if (!container) return;
  
  const recent = files.slice(0, 10);
  if (recent.length === 0) {
    container.innerHTML = '<p style="color:var(--muted);font-size:14px;padding:20px">Chưa có file nào gần đây.</p>';
    return;
  }
  
  container.innerHTML = recent.map((f, i) => {
    const thumb = getFileThumb(f);
    return `
      <div class="recent-item" onclick="openMedia(${files.indexOf(f)})">
        <img src="${thumb}" class="recent-thumb" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2280%22>📄</text></svg>'">
        <div class="recent-name">${esc(f.name)}</div>
      </div>
    `;
  }).join('');
}

function filterByCategory(cat) {
  currentTab = 'files';
  currentFolder = 'all';
  searchQuery = '';
  
  // Custom filter logic could be added here if needed, 
  // but for now we just switch to files and let user search or we could auto-fill search
  if (cat === 'image') searchQuery = '.jpg .png .jpeg .gif';
  else if (cat === 'video') searchQuery = '.mp4 .mkv .mov';
  else if (cat === 'audio') searchQuery = '.mp3 .wav .flac';
  else if (cat === 'document') searchQuery = '.pdf .docx .txt .zip';
  
  const searchInput = id('searchInput');
  if (searchInput) searchInput.value = searchQuery;
  
  render();
}

function getFileThumb(f) {
  if (f.type.startsWith('image/')) return f.url || '';
  if (f.type.startsWith('video/')) return 'data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2280%22>🎬</text></svg>';
  if (f.type.startsWith('audio/')) return 'data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2280%22>🎵</text></svg>';
  return 'data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2280%22>📄</text></svg>';
}

function renderFileGrid(skipRefresh = false) {
  const grid = id('fileGrid');
  if (!grid) return;
  
  filteredFiles = getFilteredFiles();
  filteredFiles = sortFiles(filteredFiles);
  renderBreadcrumbs();

  let html = '';
  
  // Folders
  const levelFolders = folders.filter(f => f && f.id && f.parentId === currentFolderId);
  html += levelFolders.map(f => `
    <div class="file-card folder-card" onclick="navigateToFolder('${esc(f.id)}')">
      <div class="file-thumb-placeholder">
        <i class="fas fa-folder" style="color:#fbbf24;font-size:48px"></i>
      </div>
      <div class="file-card-info">
        <div class="file-card-name">${esc(f.name)}</div>
        <div class="file-card-meta">Thư mục</div>
      </div>
      ${isAdminMode ? `
      <div class="file-card-actions">
        <button class="card-action-btn edit" onclick="event.stopPropagation();renameFolder('${esc(f.id)}')" title="Đổi tên">
          <i class="fas fa-edit"></i>
        </button>
        <button class="card-action-btn del" onclick="event.stopPropagation();deleteFolder('${esc(f.id)}')" title="Xóa">
          <i class="fas fa-trash"></i>
        </button>
      </div>` : ''}
    </div>
  `).join('');

  // Files
  const levelFiles = currentFolder === 'all' 
    ? filteredFiles.filter(f => {
        if (currentFolderId === null) {
          return !f.folder || f.folder === 'all' || !folders.find(fol => fol && fol.id === f.folder);
        }
        return f.folder === currentFolderId;
      })
    : filteredFiles;

  html += levelFiles.map((f, localIdx) => {
    const globalIdx = filteredFiles.indexOf(f);
    return buildGridCard(f, globalIdx);
  }).join('');
  
  grid.innerHTML = html;
  
  // Preload ảnh visible
  if (currentView === 'grid') {
    preloadVisibleImages(levelFiles);
  }
  
  if (levelFiles.length > 0 || levelFolders.length > 0) {
    hide('emptyState');
  } else {
    show('emptyState');
  }
  
  const badge = id('fileBadge');
  if (badge) badge.textContent = levelFiles.length + ' file';

  if (!skipRefresh) refreshVisibleUrls(levelFiles);
}

function preloadVisibleImages(visibleFiles) {
  const imageFiles = visibleFiles.filter(f => f.type && f.type.startsWith('image/'));
  const preloadCount = Math.min(imageFiles.length, 15);
  
  for (let i = 0; i < preloadCount; i++) {
    const f = imageFiles[i];
    const url = f.url || getCachedUrl(f.fileId);
    if (url) {
      const img = new Image();
      img.src = url;
    }
  }
}

async function refreshVisibleUrls(visibleFiles) {
  const now = Date.now();
  const toRefresh = visibleFiles.filter(f => {
    if (!f.url && !getCachedUrl(f.fileId)) return true;
    return (now - (f.urlTs || 0) > 55 * 60 * 1000);
  }).slice(0, MAX_CONCURRENT_REFRESH);
  
  if (toRefresh.length === 0) return;

  const results = await batchGetFileUrls(
    toRefresh.map(f => ({ fileId: f.fileId, messageId: f.messageId }))
  );
  
  const updates = [];
  results.forEach(r => {
    const f = files.find(file => file.messageId === r.messageId);
    if (f && r.url) {
      f.url = r.url;
      f.urlTs = now;
      setCachedUrl(f.fileId, r.url);
      updates.push({ messageId: f.messageId, url: r.url, urlTs: now });
    }
  });

  if (updates.length > 0) {
    saveFilesToCache();
    saveUrlCache();
    updateImagesInGrid();
    if (settings.sheetUrl) {
      sheetApi({ action: 'updateUrls', updates }).catch(() => {});
    }
  }
}

function updateImagesInGrid() {
  renderFileGrid(true);
}

function buildGridCard(f, i) {
  const isImg = f.type && f.type.startsWith('image/');
  const isVid = f.type && f.type.startsWith('video/');
  
  const imgUrl = f.url || getCachedUrl(f.fileId);
  const thumb = (isImg || isVid) && imgUrl 
    ? `<img src="${imgUrl}" class="file-thumb" loading="lazy" decoding="async" alt="${esc(f.name)}">` 
    : `<div class="file-thumb-placeholder">${fileIcon(f.type, f.name)}</div>`;
  
  if (currentView === 'list') {
    return `
      <div class="file-card list-card" onclick="openMedia(${i})">
        ${thumb}
        <div class="list-info">
          <div class="list-name">${esc(f.name)}</div>
          <div class="list-meta">${formatSize(f.size)} · ${formatDate(f.date)}</div>
        </div>
        ${isAdminMode ? `
        <div class="list-actions">
          <button class="list-action-btn del" onclick="event.stopPropagation();deleteFile(${f.messageId})" title="Xóa">
            <i class="fas fa-trash"></i>
          </button>
        </div>` : ''}
      </div>`;
  }
  
  return `
    <div class="file-card" onclick="openMedia(${i})">
      <div class="file-card-thumb-wrapper">
        ${thumb}
        ${isVid ? '<div class="video-badge"><i class="fas fa-play"></i> Video</div>' : ''}
      </div>
      <div class="file-card-info">
        <div class="file-card-name">${esc(f.name)}</div>
        <div class="file-card-meta">${formatSize(f.size)} · ${formatDate(f.date)}</div>
      </div>
      ${isAdminMode ? `
      <div class="file-card-actions">
        <button class="card-action-btn edit" onclick="event.stopPropagation();renameFile(${f.messageId})" title="Đổi tên">
          <i class="fas fa-edit"></i>
        </button>
        <button class="card-action-btn del grid-del" onclick="event.stopPropagation();deleteFile(${f.messageId})">
          <i class="fas fa-trash"></i>
        </button>
      </div>` : ''}
    </div>`;
}

function renderBreadcrumbs() {
  const container = id('sectionTitle');
  if (!container) return;
  
  let html = `<span onclick="resetNavigation()" style="cursor:pointer;color:var(--accent)">🏠 Tất cả</span>`;
  currentPath.forEach((p, idx) => {
    html += ` <i class="fas fa-chevron-right" style="font-size:10px;margin:0 8px;opacity:0.5"></i> `;
    if (idx === currentPath.length - 1) {
      html += `<span style="color:var(--text)">${esc(p.name)}</span>`;
    } else {
      html += `<span onclick="navigateToPathIndex(${idx})" style="cursor:pointer;color:var(--accent)">${esc(p.name)}</span>`;
    }
  });
  container.innerHTML = html;
}

function getFolderPath(folderId) {
  let path = [];
  let curr = folders.find(f => f && f.id === folderId);
  while (curr) {
    path.unshift({ id: curr.id, name: curr.name });
    curr = folders.find(f => f && f.id === curr.parentId);
  }
  return path;
}

function navigateToFolder(id) {
  currentFolderId = id;
  currentPath = getFolderPath(id);
  render();
}

function navigateToPathIndex(idx) {
  currentPath = currentPath.slice(0, idx + 1);
  currentFolderId = currentPath[idx].id;
  render();
}

function resetNavigation() {
  currentFolderId = null;
  currentPath = [];
  currentFolder = 'all';
  render();
}

async function addCustomFolder() {
  const name = prompt('Tên thư mục mới:');
  if (name && name.trim()) {
    folders.push({ id: 'fol_' + Date.now(), name: name.trim(), parentId: currentFolderId });
    await saveFolders();
    render();
  }
}

function renameFolder(id) {
  const f = folders.find(fol => fol.id === id);
  if (!f) return;
  const newName = prompt('Nhập tên mới cho thư mục:', f.name);
  if (newName && newName.trim() && newName !== f.name) {
    f.name = newName.trim();
    saveFolders();
    render();
  }
}

async function renameFile(msgId) {
  const f = files.find(file => file.messageId === msgId);
  if (!f) return;
  const newName = prompt('Nhập tên mới cho file:', f.name);
  if (newName && newName.trim() && newName !== f.name) {
    f.name = newName.trim();
    saveFilesToCache();
    render();
    if (settings.sheetUrl) {
      await sheetApi({ action: 'updateFile', file: f });
    }
  }
}

async function deleteFolder(id) {
  if (!confirm('Xóa thư mục này?')) return;
  folders = folders.filter(f => f.id !== id);
  await saveFolders();
  render();
}

function updateSidebarCounts() {
  const counts = { all: files.length, image: 0, video: 0, audio: 0, doc: 0, other: 0 };
  files.forEach(f => {
    const cat = autoFolder(f.type);
    if (counts[cat] !== undefined) {
      counts[cat]++;
    } else {
      counts.other++;
    }
  });
  
  ['all', 'image', 'video', 'audio', 'doc', 'other'].forEach(k => {
    const el = id('cnt-' + k);
    if (el) {
      const countSpan = el.querySelector('span');
      if (countSpan) {
        countSpan.textContent = counts[k];
      } else {
        el.textContent = counts[k];
      }
    }
  });
  
  const nav = id('customFolders');
  if (nav) {
    const rootFolders = folders.filter(f => f && !f.parentId);
    nav.innerHTML = rootFolders.map(f => `
      <div class="nav-item-wrapper" style="display:flex;align-items:center;justify-content:space-between">
        <a class="nav-item ${currentFolderId === f.id ? 'active' : ''}" 
           onclick="navigateToFolder('${esc(f.id)}')" style="flex:1">
          <i class="fas fa-folder"></i> ${esc(f.name)}
        </a>
        ${isAdminMode ? `<button onclick="event.stopPropagation();deleteFolder('${esc(f.id)}')" 
          style="background:none;border:none;color:var(--danger);padding:8px;cursor:pointer;font-size:12px;opacity:0.6"
          onmouseover="this.style.opacity='1'" onmouseout="this.style.opacity='0.6'">
          <i class="fas fa-times"></i></button>` : ''}
      </div>`).join('');
  }
  
  const sel = id('uploadFolderSelect');
  if (sel) {
    sel.innerHTML = `<option value="">-- Thư mục hiện tại --</option>` + 
      folders.filter(f => f && f.id).map(f => 
        `<option value="${esc(f.id)}">📁 ${esc(f.name)}</option>`
      ).join('');
  }
}

function getFilteredFiles() {
  let list = [...files];
  if (currentFolder !== 'all') {
    list = list.filter(f => autoFolder(f.type) === currentFolder);
  }
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    list = list.filter(f => f.name.toLowerCase().includes(q));
  }
  return list;
}

function updateStorageStats() {
  const totalSize = files.reduce((sum, f) => sum + (f.size || 0), 0);
  const totalEl = id('totalSize');
  const filesEl = id('totalFiles');
  const fillEl = id('storageFill');
  
  if (totalEl) totalEl.textContent = formatSize(totalSize);
  if (filesEl) filesEl.textContent = files.length + ' files';
  if (fillEl) {
    const maxSize = 2 * 1024 * 1024 * 1024;
    const percent = Math.min((totalSize / maxSize) * 100, 100);
    fillEl.style.width = percent + '%';
  }
}

// ╔═══════════════════════════════════════════════════════════╗
// ║              EXPORT / IMPORT                             ║
// ╚═══════════════════════════════════════════════════════════╝

function exportIndex() {
  const data = { files, folders, exportDate: new Date().toISOString() };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'telecloud-backup-' + new Date().toISOString().slice(0, 10) + '.json';
  a.click();
  URL.revokeObjectURL(url);
  toast('Đã xuất danh sách!', 'success');
}

async function importIndex(event) {
  const file = event.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (data.files && Array.isArray(data.files)) {
      files = data.files;
      saveFilesToCache();
    }
    if (data.folders && Array.isArray(data.folders)) {
      folders = data.folders.filter(f => f && f.name);
      saveFoldersToCache();
    }
    render();
    toast('Đã nhập danh sách!', 'success');
  } catch(e) {
    toast('Lỗi khi đọc file JSON!', 'error');
  }
  event.target.value = '';
}

// ╔═══════════════════════════════════════════════════════════╗
// ║              MOBILE SEARCH                               ║
// ╚═══════════════════════════════════════════════════════════╝

function toggleMobileSearch() {
  const overlay = id('mobileSearchOverlay');
  if (overlay) {
    overlay.classList.toggle('hidden');
    if (!overlay.classList.contains('hidden')) {
      const input = id('mSearchInput');
      if (input) input.focus();
    }
  }
}

function clearSearch() {
  searchQuery = '';
  setVal('searchInput', '');
  setVal('mSearchInput', '');
  render();
}

function handleFileSelect(event) {
  if (event.target.files && event.target.files.length > 0) {
    uploadFiles(event.target.files);
    event.target.value = '';
  }
}

// ╔═══════════════════════════════════════════════════════════╗
// ║              HELPERS                                    ║
// ╚═══════════════════════════════════════════════════════════╝

const id = x => document.getElementById(x);
const val = x => {
  const el = id(x);
  return el ? el.value : '';
};
const setVal = (x, v) => {
  const el = id(x);
  if (el) el.value = v || '';
};
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function show(x) {
  const el = id(x);
  if (el) el.classList.remove('hidden');
}

function hide(x) {
  const el = id(x);
  if (el) el.classList.add('hidden');
}

function formatSize(b) {
  if (!b) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (b >= 1024 && i < 3) { b /= 1024; i++; }
  return b.toFixed(1) + ' ' + u[i];
}

function formatDate(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleDateString('vi-VN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
}

function autoFolder(m) {
  if (!m) return 'other';
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  return 'doc';
}

function fileIcon(m, n) {
  if (m && m.startsWith('image/')) return '🖼️';
  if (m && m.startsWith('video/')) return '🎬';
  if (m && m.startsWith('audio/')) return '🎵';
  return '📄';
}

function toast(m, t = 'info') {
  const container = id('toastContainer');
  if (!container) return;
  
  const el = document.createElement('div');
  el.className = `toast ${t}`;
  el.textContent = m;
  container.appendChild(el);
  
  setTimeout(() => {
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 300);
  }, 3000);
}

function shake(el) {
  if (!el) return;
  el.classList.add('shake');
  setTimeout(() => el.classList.remove('shake'), 400);
}

// ╔═══════════════════════════════════════════════════════════╗
// ║              UI EVENTS                                  ║
// ╚═══════════════════════════════════════════════════════════╝

function toggleSidebar() {
  const sidebar = id('sidebar');
  const overlay = id('sidebarOverlay');
  if (!sidebar) return;
  
  sidebar.classList.toggle('open');
  if (overlay && window.innerWidth <= 768) {
    overlay.classList.toggle('show', sidebar.classList.contains('open'));
  }
}

function toggleSettings() {
  const drawer = id('settingsDrawer');
  const overlay = id('settingsOverlay');
  if (!drawer || !overlay) return;
  
  const isOpen = drawer.classList.contains('show');
  
  if (isOpen) {
    drawer.classList.remove('show');
    overlay.classList.remove('show');
  } else {
    fillSettingsDrawer();
    isAdminMode = false;
    render();
    hide('adminSettings');
    show('adminLoginSection');
    drawer.classList.add('show');
    overlay.classList.add('show');
  }
}

function unlockAdmin() {
  if (val('adminUnlockInput') === 'Nam2005@@@') {
    isAdminMode = true;
    render();
    hide('adminLoginSection');
    show('adminSettings');
    toast('🔓 Đã mở khóa!', 'success');
  } else {
    toast('Sai mật khẩu Admin!', 'error');
    shake(id('adminUnlockInput'));
  }
}

// ╔═══════════════════════════════════════════════════════════╗
// ║         MEDIA VIEWER (CÓ ZOOM, KHÔI PHỤC KHI THOÁT)     ║
// ╚═══════════════════════════════════════════════════════════╝

async function openMedia(idx) {
  currentMediaIndex = idx;
  const f = filteredFiles[idx];
  if (!f) return;

  // LƯU VỊ TRÍ SCROLL HIỆN TẠI trước khi mở ảnh
  savedScrollPosition = {
    x: window.scrollX,
    y: window.scrollY
  };

  // Lấy URL (cache nếu có)
  if (!f.url || Date.now() - (f.urlTs || 0) > 50 * 60 * 1000) {
    try {
      f.url = await getFileUrl(f.fileId);
      f.urlTs = Date.now();
      setCachedUrl(f.messageId, f.url);
      saveFiles();
      saveUrlCache();
    } catch(e) {
      console.warn('Không lấy được URL cho:', f.name);
    }
  }

  show('mediaModal');
  
  const nameEl = id('mediaName');
  const sizeEl = id('mediaSize');
  if (nameEl) nameEl.textContent = f.name;
  if (sizeEl) sizeEl.textContent = formatSize(f.size);

  // CHO PHÉP ZOOM khi mở media viewer
  const metaViewport = document.querySelector('meta[name="viewport"]');
  if (metaViewport) {
    metaViewport.setAttribute('content', 
      'width=device-width, initial-scale=1.0, maximum-scale=5.0, user-scalable=yes');
  }

  const stage = id('mediaStage');
  if (!stage) return;

  if (f.type && f.type.startsWith('image/')) {
    stage.innerHTML = `
      <div class="zoomable-image-container">
        <img src="${f.url}" 
             style="max-width:100%;max-height:80vh;touch-action:pan-x pan-y pinch-zoom;"
             alt="${esc(f.name)}">
      </div>`;
    stage.classList.add('allow-zoom');
  } else if (f.type && f.type.startsWith('video/')) {
    stage.innerHTML = `
      <video src="${f.url}" controls autoplay 
             style="max-width:100%;max-height:80vh;touch-action:manipulation;">
      </video>`;
    stage.classList.remove('allow-zoom');
  } else {
    stage.innerHTML = `
      <div class="doc-preview">
        <h1 style="font-size:80px">📄</h1>
        <p style="font-size:18px;margin:16px 0">${esc(f.name)}</p>
        <button class="btn-primary" onclick="downloadFile('${f.url}','${esc(f.name)}')">
          <i class="fas fa-download"></i> Tải về
        </button>
      </div>`;
    stage.classList.remove('allow-zoom');
  }
}

function closeMediaModal() {
  hide('mediaModal');
  
  const stage = id('mediaStage');
  if (stage) {
    stage.innerHTML = '';
    stage.classList.remove('allow-zoom');
  }

  // KHÓA ZOOM LẠI
  const metaViewport = document.querySelector('meta[name="viewport"]');
  if (metaViewport) {
    metaViewport.setAttribute('content', 
      'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no');
  }

  // KHÔI PHỤC VỊ TRÍ SCROLL BAN ĐẦU
  // Dùng requestAnimationFrame để đảm bảo DOM đã cập nhật
  requestAnimationFrame(() => {
    window.scrollTo(savedScrollPosition.x, savedScrollPosition.y);
  });
}

function downloadFile(u, n) {
  if (!u) return;
  const a = document.createElement('a');
  a.href = u;
  a.download = n || 'file';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

function shareFile(u, n) {
  if (u) {
    navigator.clipboard.writeText(u).then(() => {
      toast('📋 Đã copy link!', 'success');
    }).catch(() => {
      toast('Không thể copy link', 'error');
    });
  } else {
    toast('URL không khả dụng', 'error');
  }
}

// ╔═══════════════════════════════════════════════════════════╗
// ║              NAVIGATION & VIEW                          ║
// ╚═══════════════════════════════════════════════════════════╝

function setFolder(f) {
  currentFolder = f;
  resetNavigation();
}

function setView(v) {
  currentView = v;
  render();
}

function handleSearch(q) {
  searchQuery = q;
  render();
}

function setupDragDrop() {
  document.body.ondragover = function(e) {
    e.preventDefault();
    const mainApp = id('mainApp');
    if (mainApp && !mainApp.classList.contains('hidden')) {
      show('uploadModal');
    }
  };
}

// ╔═══════════════════════════════════════════════════════════╗
// ║              DOM READY                                   ║
// ╚═══════════════════════════════════════════════════════════╝

document.addEventListener('DOMContentLoaded', init);

// ╔═══════════════════════════════════════════════════════════╗
// ║              GLOBAL EXPORTS                              ║
// ╚═══════════════════════════════════════════════════════════╝

window.setFolder = setFolder;
window.navigateToFolder = navigateToFolder;
window.resetNavigation = resetNavigation;
window.navigateToPathIndex = navigateToPathIndex;
window.deleteFolder = deleteFolder;
window.renameFolder = renameFolder;
window.renameFile = renameFile;
window.deleteFile = deleteFile;
window.unlockAdmin = unlockAdmin;
window.toggleSettings = toggleSettings;
window.toggleSidebar = toggleSidebar;
window.openUploadModal = function() { show('uploadModal'); };
window.closeUploadModal = function() { hide('uploadModal'); };
window.closeMediaModal = closeMediaModal;
window.saveSettings = saveSettings;
window.clearAllData = clearAllData;
window.syncFromTelegram = syncFromTelegram;
window.handleSearch = handleSearch;
window.navigateMedia = function(d) {
  const n = currentMediaIndex + d;
  if (n >= 0 && n < filteredFiles.length) openMedia(n);
};
window.downloadCurrentFile = function() {
  const f = filteredFiles[currentMediaIndex];
  if (f) downloadFile(f.url, f.name);
};
window.shareCurrentFile = function() {
  const f = filteredFiles[currentMediaIndex];
  if (f) shareFile(f.url, f.name);
};
window.deleteCurrentFile = async function() {
  const f = filteredFiles[currentMediaIndex];
  if (f && confirm('Xóa file này?')) {
    closeMediaModal();
    await deleteFile(f.messageId, true);
  }
};
window.setView = setView;
window.setSort = setSort;
window.exportIndex = exportIndex;
window.importIndex = importIndex;
window.toggleMobileSearch = toggleMobileSearch;
window.clearSearch = clearSearch;
window.handleFileSelect = handleFileSelect;
window.downloadFile = downloadFile;
window.shareFile = shareFile;
window.addCustomFolder = addCustomFolder;
window.checkPassword = checkPassword;
window.saveSetup = launchApp;