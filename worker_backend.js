/**
 * TeleCloud - Cloudflare Worker Backend
 * 
 * Instructions:
 * 1. Create a KV Namespace named 'TELECLOUD_KV'.
 * 2. Bind it to this worker with the variable name 'FILES_KV'.
 * 3. Deploy this code.
 */

const KV_KEY = "telecloud_files_v1";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const method = request.method;

    // Handle CORS
    if (method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    if (!env.FILES_KV) {
      return jsonResponse({ ok: false, error: "FILES_KV binding is missing. Please check your Worker settings -> Variables -> KV Namespace Bindings." }, 500);
    }

    try {
      // ── READ ACTION (GET) ──
      if (method === "GET") {
        const action = url.searchParams.get("action") || "getFiles";
        
        if (action === "getFiles") {
          const data = await env.FILES_KV.get(KV_KEY);
          const files = data ? JSON.parse(data) : [];
          return jsonResponse({ ok: true, files });
        }
        
        if (action === "ping") {
          return jsonResponse({ ok: true, ts: Date.now() });
        }
      }

      // ── WRITE ACTION (POST) ──
      if (method === "POST") {
        const body = await request.json();
        const action = body.action;

        let files = JSON.parse((await env.FILES_KV.get(KV_KEY)) || "[]");

        if (action === "addFile") {
          const newFile = body.file;
          if (!files.find(f => f.messageId === newFile.messageId)) {
            files.unshift(newFile);
            await env.FILES_KV.put(KV_KEY, JSON.stringify(files));
          }
          return jsonResponse({ ok: true });
        }

        if (action === "addFiles") {
          const newFiles = body.files || [];
          const existingIds = new Set(files.map(f => f.messageId));
          const toAdd = newFiles.filter(f => !existingIds.has(f.messageId));
          
          if (toAdd.length > 0) {
            files = [...toAdd, ...files];
            await env.FILES_KV.put(KV_KEY, JSON.stringify(files));
          }
          return jsonResponse({ ok: true, added: toAdd.length });
        }

        if (action === "deleteFile") {
          const msgId = body.messageId;
          files = files.filter(f => f.messageId !== msgId);
          await env.FILES_KV.put(KV_KEY, JSON.stringify(files));
          return jsonResponse({ ok: true });
        }

        if (action === "updateUrls") {
          const updates = body.updates || [];
          const updatesMap = {};
          updates.forEach(u => { updatesMap[u.messageId] = u; });

          let changed = false;
          files = files.map(f => {
            if (updatesMap[f.messageId]) {
              changed = true;
              return { ...f, url: updatesMap[f.messageId].url, urlTs: updatesMap[f.messageId].urlTs };
            }
            return f;
          });

          if (changed) {
            await env.FILES_KV.put(KV_KEY, JSON.stringify(files));
          }
          return jsonResponse({ ok: true });
        }

        if (action === "clearFiles") {
          await env.FILES_KV.put(KV_KEY, "[]");
          return jsonResponse({ ok: true });
        }
      }

      return jsonResponse({ ok: false, error: "Invalid request" }, 400);

    } catch (err) {
      return jsonResponse({ ok: false, error: err.message }, 500);
    }
  },
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
