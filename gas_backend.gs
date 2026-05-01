// ============================================================
//  TeleCloud – Google Apps Script Backend
//  Deploy as: Web App > Execute as ME > Anyone can access
//
//  ALL requests come in as GET to avoid browser CORS/redirect issues.
//  Write actions are sent via ?payload=<JSON-encoded-body>
// ============================================================

const SHEET_NAME = 'files';

function getSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(['messageId','fileId','name','size','type','folder','url','urlTs','date','thumb']);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

// ── ALL requests handled in doGet ───────────────────────────
function doGet(e) {
  // If ?payload= param exists → it's a write action sent as GET
  if (e.parameter.payload) {
    try {
      const body = JSON.parse(decodeURIComponent(e.parameter.payload));
      return handleAction(body);
    } catch(err) {
      return output({ ok: false, error: 'Invalid payload: ' + err.message });
    }
  }

  // Otherwise → read action
  const action = e.parameter.action || 'getFiles';
  if (action === 'getFiles') return output(getAllFiles());
  if (action === 'ping')     return output({ ok: true, ts: Date.now() });
  return output({ ok: false, error: 'Unknown action' });
}

// Keep doPost for backward compatibility
function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    return handleAction(body);
  } catch(err) {
    return output({ ok: false, error: 'Invalid JSON: ' + err.message });
  }
}

function handleAction(body) {
  if (body.action === 'addFile')     { addFile(body.file);                                   return output({ ok: true }); }
  if (body.action === 'deleteFile')  { deleteFile(body.messageId);                           return output({ ok: true }); }
  if (body.action === 'clearFiles')  { clearFiles();                                         return output({ ok: true }); }
  if (body.action === 'updateUrl')   { updateFileUrl(body.messageId, body.url, body.urlTs);  return output({ ok: true }); }
  return output({ ok: false, error: 'Unknown action: ' + body.action });
}

// ── CRUD ────────────────────────────────────────────────────
function getAllFiles() {
  const sheet = getSheet();
  const rows = sheet.getDataRange().getValues();
  if (rows.length <= 1) return { ok: true, files: [] };
  const headers = rows[0];
  const files = rows.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = row[i]; });
    return obj;
  });
  return { ok: true, files };
}

function addFile(file) {
  if (!file || !file.messageId) return;
  const sheet = getSheet();
  // Prevent duplicates
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(file.messageId)) return;
  }
  sheet.appendRow([
    file.messageId, file.fileId, file.name, file.size,
    file.type, file.folder || '', file.url || '', file.urlTs || 0,
    file.date, file.thumb || ''
  ]);
}

function deleteFile(messageId) {
  const sheet = getSheet();
  const data = sheet.getDataRange().getValues();
  for (let i = data.length - 1; i >= 1; i--) {
    if (String(data[i][0]) === String(messageId)) {
      sheet.deleteRow(i + 1);
    }
  }
}

function updateFileUrl(messageId, url, urlTs) {
  const sheet = getSheet();
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const urlCol  = headers.indexOf('url')   + 1;
  const urlTsCol = headers.indexOf('urlTs') + 1;
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(messageId)) {
      if (urlCol   > 0) sheet.getRange(i + 1, urlCol).setValue(url);
      if (urlTsCol > 0) sheet.getRange(i + 1, urlTsCol).setValue(urlTs);
      break;
    }
  }
}

function clearFiles() {
  const sheet = getSheet();
  const lastRow = sheet.getLastRow();
  if (lastRow > 1) sheet.deleteRows(2, lastRow - 1);
}

// ── Output helper ────────────────────────────────────────────
function output(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
