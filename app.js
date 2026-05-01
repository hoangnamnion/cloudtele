// ============================================================
//  TeleCloud – app.js (Full Hierarchical Folder System)
// ============================================================

const STORAGE_KEY   = 'tc_files';
const SETTINGS_KEY  = 'tc_settings';
const TG_API        = 'https://api.telegram.org';

// ── DEFAULT CREDENTIALS ──
const DEFAULT_BOT_TOKEN  = '8327837990:AAHVz_qXiui3_Thbo2sN4khegqFoLjAWvd0';
const DEFAULT_CHANNEL_ID = '6754356446';
const DEFAULT_SHEET_URL  = 'https://green-forest-9ebb.caovannamutt.workers.dev/';

let settings = {
  botToken:  DEFAULT_BOT_TOKEN,
  channelId: DEFAULT_CHANNEL_ID,
  sheetUrl:  DEFAULT_SHEET_URL,
  password:  ''
};

let files = [];             // In-memory file index
let folders = [];           // [{id, name, parentId}]
let currentPath = [];       // [{id, name}] for breadcrumbs
let currentFolderId = null; // null = root
let currentFolder = 'all';  // Category filter (all, image, video, etc.)
let currentView = 'grid';
let currentSort = 'date-desc';
let searchQuery = '';
let currentMediaIndex = -1;
let filteredFiles = [];
let isSyncing = false;
let isAdminMode = false;

// ── INIT ────────────────────────────────────────────────────
function init() {
  loadSettings();
  
  if (DEFAULT_SHEET_URL && settings.sheetUrl !== DEFAULT_SHEET_URL) {
    settings.sheetUrl = DEFAULT_SHEET_URL;
    persistSettings();
  }

  if (!settings.botToken)  settings.botToken  = DEFAULT_BOT_TOKEN;
  if (!settings.channelId) settings.channelId = DEFAULT_CHANNEL_ID;

  loadFilesFromCache();
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
  loadFilesFromCache();
  render();
  await loadFilesFromSheet();
  await syncFromTelegram();
  await loadFolders();
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

// ── STORAGE & API ───────────────────────────────────────────
function loadFilesFromCache() {
  try { files = JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; } catch(e){ files=[]; }
  try { 
    let cachedFolders = JSON.parse(localStorage.getItem('tc_folders')) || []; 
    folders = cachedFolders.filter(f => f && f.name && f.name !== 'undefined');
  } catch(e){ folders=[]; }
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

async function syncFromTelegram() {
  if (isSyncing) return;
  isSyncing = true;
  showSyncStatus('syncing');
  try {
    // 1. Luôn tải dữ liệu mới nhất từ Cloud về trước
    await loadFilesFromSheet();
    await loadFolders();

    const known = new Set(files.map(f => f.messageId));
    let discovered = [];
    let offset = 0;
    for (let i=0; i<5; i++) {
      const updates = await tgApi('getUpdates', { offset, limit: 100 });
      if (!updates || updates.length === 0) break;
      for (const upd of updates) {
        offset = upd.update_id + 1;
        const msg = upd.channel_post || upd.message;
        if (!msg) continue;
        if (String(msg.chat.id) !== String(settings.channelId) && String(msg.chat.id) !== '-100' + String(settings.channelId)) continue;
        const parsed = parseMessageToFile(msg);
        if (parsed && !known.has(parsed.messageId)) { discovered.push(parsed); known.add(parsed.messageId); }
      }
      if (updates.length < 100) break;
    }
    if (discovered.length > 0) {
      await Promise.all(discovered.map(async f => { try { f.url = await getFileUrl(f.fileId); f.urlTs = Date.now(); } catch(e){} }));
      files.push(...discovered);
      files.sort((a,b) => b.date - a.date);
      saveFiles();
      render();
      await sheetApi({ action: 'addFiles', files: discovered });
      toast(`Đã đồng bộ ${discovered.length} file`, 'success');
    }
  } catch(e) { console.error(e); }
  finally { isSyncing = false; showSyncStatus('idle'); }
}

function parseMessageToFile(msg) {
  let fileId, fileSize, mime, name;
  if (msg.photo) {
    const p = msg.photo[msg.photo.length - 1];
    fileId = p.file_id; fileSize = p.file_size; mime = 'image/jpeg'; name = `photo_${msg.message_id}.jpg`;
  } else if (msg.video) {
    fileId = msg.video.file_id; fileSize = msg.video.file_size; mime = msg.video.mime_type || 'video/mp4'; name = msg.video.file_name || `video_${msg.message_id}.mp4`;
  } else if (msg.document) {
    fileId = msg.document.file_id; fileSize = msg.document.file_size; mime = msg.document.mime_type || 'application/octet-stream'; name = msg.document.file_name || `file_${msg.message_id}`;
  } else if (msg.audio) {
    fileId = msg.audio.file_id; fileSize = msg.audio.file_size; mime = msg.audio.mime_type || 'audio/mpeg'; name = msg.audio.file_name || `audio_${msg.message_id}.mp3`;
  } else return null;

  let folder = autoFolder(mime);
  const cap = msg.caption || '';
  const tagMatch = cap.match(/#telecloud\s+#([\w]+)/);
  if (tagMatch) folder = tagMatch[1];

  const capLines = cap.split('\n');
  if (capLines[0] && capLines[0].startsWith('📁 ')) name = capLines[0].replace('📁 ', '').trim() || name;

  return { messageId: msg.message_id, fileId, name, size: fileSize || 0, type: mime, folder, url: '', urlTs: 0, date: (msg.date || 0) * 1000 };
}

function showSyncStatus(state) {
  const btn = id('syncBtn');
  if (!btn) return;
  btn.innerHTML = state === 'syncing' ? '<i class="fas fa-spinner fa-spin"></i> Sync...' : '<i class="fas fa-sync-alt"></i> Làm mới';
  btn.disabled = state === 'syncing';
}

// ── UPLOAD ───────────────────────────────────────────────────
async function uploadFiles(fileList) {
  if (!fileList || fileList.length === 0) return;
  const total = fileList.length;
  const folder = val('uploadFolderCustom').trim() || val('uploadFolderSelect') || currentFolderId || '';
  const modalHeader = document.querySelector('#uploadModal h3');
  const originalHeaderText = modalHeader.innerHTML;

  for (let i = 0; i < total; i++) {
    const file = fileList[i];
    modalHeader.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Đang tải ${i+1}/${total}...`;
    
    if (file.size > 50*1024*1024) { 
      toast(`${file.name}: File > 50MB!`, 'error'); 
      continue; 
    }

    const itemId = 'uq_' + Date.now() + i;
    id('uploadQueue').insertAdjacentHTML('afterbegin', `
      <div class="upload-item" id="${itemId}">
        <div class="upload-item-info">
          <div class="upload-item-name"><span>[${i+1}/${total}]</span> ${file.name}</div>
          <div class="progress-bar active"><div class="progress-fill" id="${itemId}_p" style="width:10%"></div></div>
          <div class="upload-item-status" id="${itemId}_s">Đang chuẩn bị...</div>
        </div>
      </div>`);

    try {
      const pFill = id(itemId + '_p');
      const pStat = id(itemId + '_s');
      
      const fd = new FormData();
      fd.append('chat_id', settings.channelId);
      fd.append('caption', `📁 ${file.name}\n#telecloud ${folder ? '#' + folder : ''}\nSize: ${formatSize(file.size)}`);
      
      let method = file.type.startsWith('image/') ? 'sendPhoto' : file.type.startsWith('video/') ? 'sendVideo' : 'sendDocument';
      fd.append(method.replace('send','').toLowerCase(), file, file.name);

      if (pFill) pFill.style.width = '30%';
      if (pStat) pStat.textContent = 'Đang gửi lên Telegram...';

      const res = await tgApiForm(method, fd);
      
      if (pFill) pFill.style.width = '80%';
      if (pStat) pStat.textContent = 'Đang lưu vào chỉ mục...';

      const tgObj = res.photo ? res.photo[res.photo.length-1] : res.video || res.document || res.audio;
      const fileUrl = await getFileUrl(tgObj.file_id);
      
      await addFile({ 
        messageId: res.message_id, 
        fileId: tgObj.file_id, 
        name: file.name, 
        size: tgObj.file_size, 
        type: file.type, 
        folder, 
        url: fileUrl, 
        urlTs: Date.now(), 
        date: Date.now() 
      });

      if (pFill) pFill.style.width = '100%';
      if (pStat) pStat.innerHTML = '<span style="color:#10b981">Thành công! ✅</span>';
      setTimeout(() => id(itemId)?.classList.add('fade-out'), 2000);
      setTimeout(() => id(itemId)?.remove(), 2500);
      render();
    } catch(e) { 
      id(itemId + '_s').innerHTML = `<span style="color:#ef4444">Lỗi: ${e.message}</span>`;
      toast('Lỗi upload: ' + e.message, 'error'); 
    }
  }
  modalHeader.innerHTML = originalHeaderText;
}

// ── DELETE ───────────────────────────────────────────────────
async function deleteFile(msgId, skipConfirm = false) {
  if (!skipConfirm && !confirm('Xóa file này?')) return;
  try { await tgApi('deleteMessage', { chat_id: settings.channelId, message_id: parseInt(msgId) }); } catch(e){}
  removeFile(msgId);
  render();
}

async function clearAllData() {
  if (!confirm('Xóa TOÀN BỘ dữ liệu trên máy và Cloud?')) return;
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem('tc_folders');
  files = []; folders = [];
  if (settings.sheetUrl) {
    await sheetApi({ action: 'clearFiles' });
    await sheetApi({ action: 'saveFolders', folders: [] });
  }
  render();
}

// ── SORT FUNCTION ────────────────────────────────────────────
function setSort(sortType) {
  currentSort = sortType;
  render();
}

function sortFiles(list) {
  switch(currentSort) {
    case 'date-asc': return list.sort((a, b) => a.date - b.date);
    case 'name-asc': return list.sort((a, b) => a.name.localeCompare(b.name));
    case 'size-desc': return list.sort((a, b) => b.size - a.size);
    case 'date-desc':
    default: return list.sort((a, b) => b.date - a.date);
  }
}

// ── RENDER ───────────────────────────────────────────────────
function render() {
  updateSidebarCounts();
  renderFileGrid();
  updateStorageStats();
  
  // Ẩn hiện nút xóa trong Media Viewer
  const mediaDel = id('mediaDelBtn');
  if (mediaDel) isAdminMode ? show('mediaDelBtn') : hide('mediaDelBtn');
}

function renderFileGrid(skipRefresh = false) {
  const grid = id('fileGrid');
  filteredFiles = getFilteredFiles();
  filteredFiles = sortFiles(filteredFiles);
  renderBreadcrumbs();

  let html = '';
  // 1. Folders
  const levelFolders = folders.filter(f => f && f.id && f.parentId === currentFolderId);
  html += levelFolders.map(f => `
    <div class="file-card folder-card" onclick="navigateToFolder('${f.id}')">
      <div class="file-thumb-placeholder"><i class="fas fa-folder" style="color:#fbbf24;font-size:48px"></i></div>
      <div class="file-card-info">
        <div class="file-card-name">${esc(f.name)}</div>
        <div class="file-card-meta">Thư mục</div>
      </div>
      ${isAdminMode ? `<button class="card-action-btn del grid-del" onclick="event.stopPropagation();deleteFolder('${f.id}')"><i class="fas fa-trash"></i></button>` : ''}
    </div>
  `).join('');

  // 2. Files
  const levelFiles = currentFolder === 'all' 
    ? filteredFiles.filter(f => (currentFolderId === null ? (!f.folder || f.folder === 'all' || !folders.find(fol => fol && fol.id === f.folder)) : f.folder === currentFolderId))
    : filteredFiles;

  html += levelFiles.map(f => {
    const globalIdx = filteredFiles.indexOf(f);
    return buildGridCard(f, globalIdx);
  }).join('');
  grid.innerHTML = html;
  html ? hide('emptyState') : show('emptyState');
  
  // Cập nhật file count
  const badge = id('fileBadge');
  if (badge) badge.textContent = levelFiles.length + ' file';

  // Tự động làm mới URL cho các file đang hiển thị nếu hết hạn
  if (!skipRefresh) refreshVisibleUrls(levelFiles);
}

async function refreshVisibleUrls(visibleFiles) {
  const now = Date.now();
  const toRefresh = visibleFiles.filter(f => !f.url || (now - (f.urlTs || 0) > 55 * 60 * 1000)).slice(0, 10);
  if (toRefresh.length === 0) return;

  const updates = [];
  for (const f of toRefresh) {
    try {
      const newUrl = await getFileUrl(f.fileId);
      f.url = newUrl;
      f.urlTs = now;
      updates.push({ messageId: f.messageId, url: newUrl, urlTs: now });
      
      // Cập nhật trực tiếp vào DOM thay vì gọi render()
      const img = document.querySelector(`img[src*="${f.fileId}"]`) || 
                  document.querySelector(`.file-card[onclick*="openMedia"] img`); 
      // Cách tốt hơn: dùng data-attribute hoặc tìm theo index. 
      // Nhưng đơn giản nhất là render lại sau khi xong toàn bộ batch.
    } catch (e) { console.warn('Refresh URL failed for', f.name); }
  }

  if (updates.length > 0) {
    saveFilesToCache();
    // Thay vì renderFileGrid(), ta chỉ cần cập nhật lại các ảnh
    updateImagesInGrid();
    if (settings.sheetUrl) {
      await sheetApi({ action: 'updateUrls', updates });
    }
  }
}

function updateImagesInGrid() {
  const imgs = document.querySelectorAll('.file-thumb');
  imgs.forEach(img => {
    // Nếu ảnh chưa có src hoặc src cũ, trình duyệt sẽ tự tải lại khi ta render card
    // Để an toàn và mượt, ta render lại Grid nhưng KHÔNG gọi refreshVisibleUrls nữa
    renderFileGrid(true); 
  });
}

function buildGridCard(f, i) {
  const isImg = f.type.startsWith('image/');
  const isVid = f.type.startsWith('video/');
  const thumb = (isImg || isVid) && f.url ? `<img src="${f.url}" class="file-thumb" loading="lazy">` : `<div class="file-thumb-placeholder">${fileIcon(f.type, f.name)}</div>`;
  
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
          <button class="list-action-btn del" onclick="event.stopPropagation();deleteFile(${f.messageId})" title="Xóa"><i class="fas fa-trash"></i></button>
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
      ${isAdminMode ? `<button class="card-action-btn del grid-del" onclick="event.stopPropagation();deleteFile(${f.messageId})"><i class="fas fa-trash"></i></button>` : ''}
    </div>`;
}

function renderBreadcrumbs() {
  const container = id('sectionTitle');
  if (!container) return;
  let html = `<span onclick="resetNavigation()" style="cursor:pointer;color:var(--accent)">Tất cả</span>`;
  currentPath.forEach((p, idx) => {
    html += ` <i class="fas fa-chevron-right" style="font-size:10px;margin:0 8px;opacity:0.5"></i> `;
    if (idx === currentPath.length-1) html += `<span>${esc(p.name)}</span>`;
    else html += `<span onclick="navigateToPathIndex(${idx})" style="cursor:pointer;color:var(--accent)">${esc(p.name)}</span>`;
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
function resetNavigation() { currentFolderId = null; currentPath = []; currentFolder = 'all'; render(); }

async function addCustomFolder() {
  const name = prompt('Tên thư mục mới:');
  if (name && name.trim()) {
    folders.push({ id: 'fol_'+Date.now(), name: name.trim(), parentId: currentFolderId });
    await saveFolders();
    render();
  }
}
async function deleteFolder(id) {
  if (!confirm('Xóa thư mục?')) return;
  folders = folders.filter(f => f.id !== id);
  await saveFolders();
  render();
}

function updateSidebarCounts() {
  const counts = { all: files.length, image:0, video:0, audio:0, doc:0, other:0 };
  files.forEach(f => { const cat = autoFolder(f.type); if (counts[cat] !== undefined) counts[cat]++; else counts.other++; });
  Object.keys(counts).forEach(k => { if (id('cnt-'+k)) id('cnt-'+k).textContent = counts[k]; });
  const nav = id('customFolders');
  if (nav) {
    const rootFolders = folders.filter(f => f && !f.parentId);
    nav.innerHTML = rootFolders.map(f => `
      <div class="nav-item-wrapper" style="display:flex; align-items:center; justify-content:space-between">
        <a class="nav-item ${currentFolderId === f.id ? 'active' : ''}" onclick="navigateToFolder('${f.id}')" style="flex:1">
          <i class="fas fa-folder"></i> ${esc(f.name)}
        </a>
        ${isAdminMode ? `<button onclick="deleteFolder('${f.id}')" style="background:none; border:none; color:var(--danger); padding:8px; cursor:pointer; font-size:12px; opacity:0.6" onmouseover="this.style.opacity='1'" onmouseout="this.style.opacity='0.6'"><i class="fas fa-times"></i></button>` : ''}
      </div>`).join('');
  }
  const sel = id('uploadFolderSelect');
  if (sel) {
    sel.innerHTML = `<option value="">-- Hiện tại --</option>` + folders.filter(f => f && f.id).map(f => `<option value="${f.id}">📁 ${esc(f.name)}</option>`).join('');
  }
}

function getFilteredFiles() {
  let list = [...files];
  if (currentFolder !== 'all') list = list.filter(f => autoFolder(f.type) === currentFolder);
  if (searchQuery) list = list.filter(f => f.name.toLowerCase().includes(searchQuery.toLowerCase()));
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
    // Giả lập % sử dụng (giới hạn 2GB cho Telegram bot)
    const maxSize = 2 * 1024 * 1024 * 1024; // 2GB
    const percent = Math.min((totalSize / maxSize) * 100, 100);
    fillEl.style.width = percent + '%';
  }
}

// ── EXPORT / IMPORT ──────────────────────────────────────────
function exportIndex() {
  const data = { files, folders, exportDate: new Date().toISOString() };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'telecloud-backup-' + new Date().toISOString().slice(0,10) + '.json';
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

// ── MOBILE SEARCH ────────────────────────────────────────────
function toggleMobileSearch() {
  const overlay = id('mobileSearchOverlay');
  if (overlay) {
    overlay.classList.toggle('hidden');
    if (!overlay.classList.contains('hidden')) {
      id('mSearchInput').focus();
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
  uploadFiles(event.target.files);
  event.target.value = ''; // Reset để có thể chọn lại cùng 1 file
}

// ── HELPERS ──────────────────────────────────────────────────
const id = x => document.getElementById(x);
const val = x => id(x)?.value || '';
const setVal = (x, v) => { if (id(x)) id(x).value = v || ''; };
const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');
function show(x) { id(x)?.classList.remove('hidden'); }
function hide(x) { id(x)?.classList.add('hidden'); }
function formatSize(b) { if (!b) return '0 B'; const u=['B','KB','MB','GB']; let i=0; while(b>=1024 && i<3){b/=1024;i++;} return b.toFixed(1)+' '+u[i]; }
function formatDate(ts) { return new Date(ts).toLocaleDateString('vi-VN'); }
function autoFolder(m) { if(!m) return 'other'; if(m.startsWith('image/')) return 'image'; if(m.startsWith('video/')) return 'video'; if(m.startsWith('audio/')) return 'audio'; return 'doc'; }
function fileIcon(m, n) { if(m?.startsWith('image/')) return '🖼️'; if(m?.startsWith('video/')) return '🎬'; if(m?.startsWith('audio/')) return '🎵'; return '📄'; }
function toast(m, t='info') {
  const el = document.createElement('div'); el.className = `toast ${t}`; el.textContent = m; id('toastContainer').appendChild(el);
  setTimeout(() => { el.style.opacity='0'; setTimeout(() => el.remove(), 300); }, 3000);
}
function shake(el) { el.classList.add('shake'); setTimeout(() => el.classList.remove('shake'), 400); }

// ── UI EVENTS ────────────────────────────────────────────────
function toggleSidebar() { id('sidebar').classList.toggle('open'); id('sidebarOverlay')?.classList.toggle('show', window.innerWidth<=768 && id('sidebar').classList.contains('open')); }
function toggleSettings() { id('settingsDrawer').classList.toggle('show'); id('settingsOverlay').classList.toggle('show'); if (id('settingsDrawer').classList.contains('show')) { fillSettingsDrawer(); isAdminMode=false; render(); hide('adminSettings'); show('adminLoginSection'); } }
function unlockAdmin() { if (val('adminUnlockInput') === 'Nam2005@@@') { isAdminMode=true; render(); hide('adminLoginSection'); show('adminSettings'); } else toast('Sai mật khẩu!', 'error'); }

async function openMedia(idx) {
  currentMediaIndex = idx; const f = filteredFiles[idx]; if (!f) return;
  if (!f.url || Date.now() - (f.urlTs||0) > 50*60*1000) { try { f.url = await getFileUrl(f.fileId); f.urlTs = Date.now(); saveFiles(); } catch(e){} }
  show('mediaModal'); id('mediaName').textContent = f.name; id('mediaSize').textContent = formatSize(f.size);
  const stage = id('mediaStage');
  if (f.type.startsWith('image/')) stage.innerHTML = `<img src="${f.url}" style="max-width:100%;max-height:80vh">`;
  else if (f.type.startsWith('video/')) stage.innerHTML = `<video src="${f.url}" controls autoplay style="max-width:100%;max-height:80vh"></video>`;
  else stage.innerHTML = `<div class="doc-preview"><h1>📄</h1><p>${f.name}</p><button class="btn-primary" onclick="downloadFile('${f.url}','${f.name}')">Tải về</button></div>`;
}
function closeMediaModal() { hide('mediaModal'); id('mediaStage').innerHTML = ''; }
function downloadFile(u, n) { const a = document.createElement('a'); a.href = u; a.download = n; a.click(); }
function shareFile(u, n) { if (u) { navigator.clipboard.writeText(u).then(() => toast('Đã copy link!')); } else toast('Lỗi URL', 'error'); }

function setFolder(f) { currentFolder = f; resetNavigation(); }
function setView(v) { currentView = v; render(); }
function handleSearch(q) { searchQuery = q; render(); }

function setupDragDrop() {
  document.body.ondragover = e => { e.preventDefault(); if (!id('mainApp').classList.contains('hidden')) show('uploadModal'); };
  // Bỏ listener thừa gây lặp lại
}

document.addEventListener('DOMContentLoaded', init);
window.setFolder = setFolder;
window.navigateToFolder = navigateToFolder;
window.resetNavigation = resetNavigation;
window.navigateToPathIndex = navigateToPathIndex;
window.deleteFolder = deleteFolder;
window.deleteFile = deleteFile;
window.unlockAdmin = unlockAdmin;
window.toggleSettings = toggleSettings;
window.toggleSidebar = toggleSidebar;
window.openUploadModal = () => show('uploadModal');
window.closeUploadModal = () => hide('uploadModal');
window.closeMediaModal = closeMediaModal;
window.saveSettings = saveSettings;
window.clearAllData = clearAllData;
window.syncFromTelegram = syncFromTelegram;
window.handleSearch = handleSearch;
window.navigateMedia = (d) => { const n = currentMediaIndex+d; if (n>=0 && n<filteredFiles.length) openMedia(n); };
window.downloadCurrentFile = () => { const f = filteredFiles[currentMediaIndex]; if (f) downloadFile(f.url, f.name); };
window.shareCurrentFile = () => { const f = filteredFiles[currentMediaIndex]; if (f) shareFile(f.url, f.name); };
window.deleteCurrentFile = async () => { const f = filteredFiles[currentMediaIndex]; if (f && confirm('Xóa?')) { closeMediaModal(); await deleteFile(f.messageId, true); } };
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
window.saveSetup = saveSetup;
