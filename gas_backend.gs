// ============================================================
//  TeleCloud – Google Apps Script Backend
//  Deploy as: Web App > Execute as ME > Anyone can access
// ============================================================

const SHEET_NAME = 'files';
const SETTINGS_SHEET = 'settings';

function getSheet(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    if (name === SHEET_NAME) {
      sheet.appendRow(['messageId','fileId','name','size','type','folder','url','urlTs','date','thumb']);
    }
  }
  return sheet;
}

// ── GET: load all files ──────────────────────────────────────
function doGet(e) {
  const action = e.parameter.action || 'getFiles';
  let result;
  if (action === 'getFiles') {
    result = getAllFiles();
  } else if (action === 'ping') {
    result = { ok: true, ts: Date.now() };
  }
  return output(result);
}

// ── POST: add / delete / clear files ────────────────────────
function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); } catch(err) { return output({ ok: false, error: 'Invalid JSON' }); }

  if (body.action === 'addFile') {
    addFile(body.file);
    return output({ ok: true });
  }
  if (body.action === 'deleteFile') {
    deleteFile(body.messageId);
    return output({ ok: true });
  }
  if (body.action === 'clearFiles') {
    clearFiles();
    return output({ ok: true });
  }
  if (body.action === 'updateUrl') {
    updateFileUrl(body.messageId, body.url, body.urlTs);
    return output({ ok: true });
  }
  return output({ ok: false, error: 'Unknown action' });
}

function getAllFiles() {
  const sheet = getSheet(SHEET_NAME);
  const rows = sheet.getDataRange().getValues();
  if (rows.length <= 1) return { ok: true, files: [] };
  const headers = rows[0];
  const files = rows.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => obj[h] = row[i]);
    return obj;
  });
  return { ok: true, files };
}

function addFile(file) {
  const sheet = getSheet(SHEET_NAME);
  // Check if messageId already exists
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(file.messageId)) return; // duplicate
  }
  sheet.appendRow([
    file.messageId, file.fileId, file.name, file.size,
    file.type, file.folder, file.url || '', file.urlTs || 0,
    file.date, file.thumb || ''
  ]);
}

function deleteFile(messageId) {
  const sheet = getSheet(SHEET_NAME);
  const data = sheet.getDataRange().getValues();
  for (let i = data.length - 1; i >= 1; i--) {
    if (String(data[i][0]) === String(messageId)) {
      sheet.deleteRow(i + 1);
    }
  }
}

function updateFileUrl(messageId, url, urlTs) {
  const sheet = getSheet(SHEET_NAME);
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const urlCol = headers.indexOf('url') + 1;
  const urlTsCol = headers.indexOf('urlTs') + 1;
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(messageId)) {
      if (urlCol > 0) sheet.getRange(i + 1, urlCol).setValue(url);
      if (urlTsCol > 0) sheet.getRange(i + 1, urlTsCol).setValue(urlTs);
      break;
    }
  }
}

function clearFiles() {
  const sheet = getSheet(SHEET_NAME);
  const lastRow = sheet.getLastRow();
  if (lastRow > 1) sheet.deleteRows(2, lastRow - 1);
}

function output(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
