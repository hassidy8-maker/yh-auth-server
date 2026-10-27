// ============================================================================
// YH Macro — Custom License Authentication Server
// Powered by Node.js & Built-in SQLite (Zero Dependencies Needed)
// ============================================================================

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const PORT = parseInt(process.env.PORT || "3001", 10);
const HOST = process.env.HOST || "0.0.0.0";
const ADMIN_SECRET = process.env.ADMIN_SECRET || "YH_AUTH_SECRET_2026_MASTER";
const MASTER_KEY = process.env.MASTER_KEY || "YH-ADMIN-47D0-135A-2026-SECURE";
const CRYPTO_SIGN_KEY = process.env.CRYPTO_SIGN_KEY || "YH_AUTH_SIG_K89F2A90_2026_MASTER";

// Cryptographic anti-tamper signature (HMAC-SHA256)
function signLicense(key, machineId, expiresAt) {
  const hmac = crypto.createHmac("sha256", CRYPTO_SIGN_KEY);
  hmac.update(`${key}:${machineId || "UNBOUND"}:${expiresAt || "LIFETIME"}`);
  return hmac.digest("hex");
}

// Database connection (Turso Cloud SQLite with local node:sqlite fallback)
const TURSO_URL = process.env.TURSO_DATABASE_URL || "libsql://yh-mc-hassidy8-maker.aws-eu-central-1.turso.io";
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN || "eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3OTMxMjk5MTksImlkIjoiMDFhMTdlZGMtMDAwMS03MDUzLTgzZDgtMzE2Yzc1NmU4YTk5Iiwia2lkIjoiZ2VoMXdLUWhyU21OeEtjV29HQnNselpsQzJHYm9rTUhLRTN6aFFYMWQtcyIsInJpZCI6ImZjZDU2OTAxLWE1MmUtNGU0Ny05MjYzLTI5NjZkNmQ3NjRmYiJ9.JQq4ZJeke51IzL6YCqrD2NwcQO4ZcqpDCouiq2vdtumrou91wcGVPbszq6YSQkgsU0shbJPWnoCq2p1s4BQAAw";

let db;

function mapArg(arg) {
  if (arg === null || arg === undefined) return { type: "null" };
  if (typeof arg === "number") {
    return Number.isInteger(arg) ? { type: "integer", value: String(arg) } : { type: "float", value: arg };
  }
  if (typeof arg === "boolean") return { type: "integer", value: arg ? "1" : "0" };
  return { type: "text", value: String(arg) };
}

if (TURSO_URL && TURSO_TOKEN) {
  const tursoEndpoint = TURSO_URL.replace(/^libsql:\/\//i, "https://").replace(/\/$/, "") + "/v2/pipeline";

  async function tursoExec(sql, args = []) {
    const hranaArgs = args.map(mapArg);
    const res = await fetch(tursoEndpoint, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${TURSO_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        requests: [
          { type: "execute", stmt: { sql, args: hranaArgs } },
          { type: "close" },
        ],
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Turso HTTP ${res.status}: ${errText}`);
    }

    const json = await res.json();
    const firstResult = json.results?.[0];
    if (!firstResult || firstResult.type === "error") {
      throw new Error(firstResult?.error?.message || "Turso query execution failed");
    }

    const result = firstResult.response.result;
    const cols = (result.cols || []).map((c) => c.name);
    const rows = (result.rows || []).map((row) => {
      const item = {};
      cols.forEach((col, i) => {
        const cell = row[i];
        if (!cell || cell.type === "null") item[col] = null;
        else if (cell.type === "integer") item[col] = parseInt(cell.value, 10);
        else if (cell.type === "float") item[col] = cell.value;
        else item[col] = cell.value;
      });
      return item;
    });

    return { rows, changes: result.affected_row_count || 0 };
  }

  db = {
    async query(sql, ...args) {
      const res = await tursoExec(sql, args);
      return res.rows;
    },
    async get(sql, ...args) {
      const res = await tursoExec(sql, args);
      return res.rows[0] || null;
    },
    async run(sql, ...args) {
      return await tursoExec(sql, args);
    },
    async exec(sql) {
      const stmts = sql.split(";").map((s) => s.trim()).filter(Boolean);
      for (const s of stmts) {
        await tursoExec(s, []);
      }
    },
  };
  console.log(`[YH AUTH] Connected to Turso Cloud SQLite: ${TURSO_URL}`);
} else {
  const { DatabaseSync } = require("node:sqlite");
  const DB_PATH = process.env.DB_PATH || path.join(__dirname, "licenses.db");
  const localDb = new DatabaseSync(DB_PATH);

  db = {
    async query(sql, ...args) {
      return localDb.prepare(sql).all(...args);
    },
    async get(sql, ...args) {
      return localDb.prepare(sql).get(...args) || null;
    },
    async run(sql, ...args) {
      const info = localDb.prepare(sql).run(...args);
      return { changes: info.changes };
    },
    async exec(sql) {
      localDb.exec(sql);
    },
  };
  console.log(`[YH AUTH] Connected to Local SQLite database: ${DB_PATH}`);
}

async function initDb() {
  try {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS licenses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT UNIQUE NOT NULL,
        duration TEXT NOT NULL,
        activated_at TEXT,
        expires_at TEXT,
        machine_id TEXT,
        is_active INTEGER DEFAULT 1,
        created_at TEXT NOT NULL,
        permissions TEXT DEFAULT '{}'
      )
    `);
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_licenses_key ON licenses(key)`);
    console.log("[YH AUTH] Database schema ready.");
  } catch (err) {
    console.error("[YH AUTH] Database init error:", err.message);
  }
}
initDb().catch(console.error);

// Helper: Duration to expiration date from now
function computeExpiresAt(duration) {
  const now = new Date();
  switch (duration) {
    case "Seconds":
      return new Date(now.getTime() + 30 * 1000).toISOString();
    case "Week":
      return new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
    case "Month":
      return new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
    case "Year":
      return new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000).toISOString();
    case "Lifetime":
    default:
      return null;
  }
}

// Helper: Generate standard YH license key
function generateLicenseKey(duration) {
  const bytes = crypto.randomBytes(12);
  const part1 = bytes.subarray(0, 3).toString("hex").toUpperCase();
  const part2 = bytes.subarray(3, 6).toString("hex").toUpperCase();
  const part3 = bytes.subarray(6, 9).toString("hex").toUpperCase();
  const part4 = bytes.subarray(9, 12).toString("hex").toUpperCase();

  let durCode = "L";
  switch (duration) {
    case "Seconds": durCode = "S"; break;
    case "Week": durCode = "W"; break;
    case "Month": durCode = "M"; break;
    case "Year": durCode = "Y"; break;
    case "Lifetime": default: durCode = "L"; break;
  }

  return `YH-${part1}-${part2}-${part3}-${part4}-${durCode}`;
}

// Helper: Send JSON response
function sendJson(res, statusCode, data) {
  const payload = JSON.stringify(data);
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
  });
  res.end(payload);
}

// Helper: Parse request JSON body
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1e6) {
        req.destroy();
        reject(new Error("Body too large"));
      }
    });
    req.on("end", () => {
      if (!body.trim()) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

// Helper: Validate Admin Authorization
function isAuthorizedAdmin(req, body = {}) {
  const authHeader = req.headers["authorization"] || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  const apiKey = req.headers["apikey"] || "";
  const bodySecret = body.secret || "";

  return (
    token === ADMIN_SECRET ||
    apiKey === ADMIN_SECRET ||
    bodySecret === ADMIN_SECRET ||
    token === MASTER_KEY ||
    apiKey === MASTER_KEY
  );
}

// Server router
const server = http.createServer(async (req, res) => {
  // CORS Preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
    });
    return res.end();
  }

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;

  try {
    // ------------------------------------------------------------------------
    // API 1: ACTIVATE LICENSE KEY
    // POST /api/license/activate
    // ------------------------------------------------------------------------
    if (pathname === "/api/license/activate" && req.method === "POST") {
      const body = await parseBody(req);
      const rawKey = (body.key || "").trim().toUpperCase();
      const machineId = (body.machine_id || "").trim();

      if (!rawKey) {
        return sendJson(res, 400, { valid: false, message: "License key is required" });
      }

      // Master admin key bypass
      if (rawKey === MASTER_KEY) {
        return sendJson(res, 200, {
          valid: true,
          is_admin: true,
          key: rawKey,
          duration: "Lifetime",
          activated_at: new Date().toISOString(),
          expires_at: null,
          machine_id: machineId || null,
          message: "Master Admin Authorized",
          signature: signLicense(rawKey, machineId, null),
          permissions: {
            can_create_keys: true,
            can_delete_keys: true,
            can_reset_hwid: true,
          },
        });
      }

      const record = await db.get("SELECT * FROM licenses WHERE key = ?", rawKey);

      if (!record) {
        return sendJson(res, 404, { valid: false, message: "License key not found" });
      }

      if (!record.is_active) {
        return sendJson(res, 403, { valid: false, message: "License key has been revoked" });
      }

      // Check Expiration
      if (record.expires_at) {
        const expiresAt = new Date(record.expires_at);
        if (new Date() > expiresAt) {
          await db.run("UPDATE licenses SET is_active = 0 WHERE id = ?", record.id);
          return sendJson(res, 403, { valid: false, message: "License key has expired" });
        }
      }

      // HWID Lock Verification
      const now = new Date().toISOString();
      let updatedMachineId = record.machine_id;

      if (!record.machine_id || record.machine_id === "") {
        // First activation on machine: lock to this HWID
        updatedMachineId = machineId || null;
        let finalExpiresAt = record.expires_at;

        // If expires_at was not pre-calculated, calculate upon first activation
        if (!finalExpiresAt && record.duration !== "Lifetime") {
          finalExpiresAt = computeExpiresAt(record.duration);
        }

        await db.run(`
          UPDATE licenses 
          SET machine_id = ?, activated_at = COALESCE(activated_at, ?), expires_at = ?
          WHERE id = ?
        `, updatedMachineId, now, finalExpiresAt, record.id);

        record.machine_id = updatedMachineId;
        record.activated_at = record.activated_at || now;
        record.expires_at = finalExpiresAt;
      } else if (record.machine_id !== machineId) {
        return sendJson(res, 403, {
          valid: false,
          message: "License is already registered to another computer (HWID mismatch)",
        });
      }

      let perms = {};
      try {
        perms = JSON.parse(record.permissions || "{}");
      } catch {}

      return sendJson(res, 200, {
        valid: true,
        is_admin: Boolean(perms.can_create_keys || perms.can_delete_keys || perms.can_reset_hwid),
        key: record.key,
        duration: record.duration,
        activated_at: record.activated_at,
        expires_at: record.expires_at,
        machine_id: record.machine_id,
        signature: signLicense(record.key, record.machine_id, record.expires_at),
        permissions: perms,
        message: "License activated successfully",
      });
    }

    // ------------------------------------------------------------------------
    // API 2: PERIODIC LICENSE STATUS CHECK
    // POST /api/license/check
    // ------------------------------------------------------------------------
    if (pathname === "/api/license/check" && req.method === "POST") {
      const body = await parseBody(req);
      const rawKey = (body.key || "").trim().toUpperCase();
      const machineId = (body.machine_id || "").trim();

      if (!rawKey) {
        return sendJson(res, 400, { valid: false, message: "License key is required" });
      }

      if (rawKey === MASTER_KEY) {
        return sendJson(res, 200, {
          valid: true,
          is_admin: true,
          key: rawKey,
          expires_at: null,
          is_active: true,
          signature: signLicense(rawKey, machineId, null),
          permissions: {
            can_create_keys: true,
            can_delete_keys: true,
            can_reset_hwid: true,
          },
        });
      }

      const record = await db.get("SELECT * FROM licenses WHERE key = ?", rawKey);

      if (!record || !record.is_active) {
        return sendJson(res, 404, { valid: false, is_active: false, message: "License invalid or revoked" });
      }

      if (record.expires_at) {
        const expiresAt = new Date(record.expires_at);
        if (new Date() > expiresAt) {
          await db.run("UPDATE licenses SET is_active = 0 WHERE id = ?", record.id);
          return sendJson(res, 403, { valid: false, is_active: false, message: "License expired" });
        }
      }

      if (record.machine_id && machineId && record.machine_id !== machineId) {
        return sendJson(res, 403, { valid: false, is_active: false, message: "HWID mismatch" });
      }

      let perms = {};
      try {
        perms = JSON.parse(record.permissions || "{}");
      } catch {}

      return sendJson(res, 200, {
        valid: true,
        is_admin: Boolean(perms.can_create_keys || perms.can_delete_keys || perms.can_reset_hwid),
        key: record.key,
        duration: record.duration,
        expires_at: record.expires_at,
        machine_id: record.machine_id,
        is_active: true,
        signature: signLicense(record.key, record.machine_id, record.expires_at),
        permissions: perms,
      });
    }

    // ------------------------------------------------------------------------
    // API 3: CREATE LICENSE KEY (ADMIN)
    // POST /api/license/create
    // ------------------------------------------------------------------------
    if (pathname === "/api/license/create" && req.method === "POST") {
      const body = await parseBody(req);
      if (!isAuthorizedAdmin(req, body)) {
        return sendJson(res, 401, { error: "Unauthorized admin access" });
      }

      const duration = body.duration || "Lifetime";
      const key = (body.key || generateLicenseKey(duration)).trim().toUpperCase();
      // Expiration countdown starts ONLY upon first activation on the user's machine, not on generation
      const expiresAt = body.expires_at || null;
      const createdAt = new Date().toISOString();
      const permissions = JSON.stringify(body.permissions || {});

      try {
        await db.run(`
          INSERT INTO licenses (key, duration, expires_at, created_at, permissions, is_active)
          VALUES (?, ?, ?, ?, ?, 1)
        `, key, duration, expiresAt, createdAt, permissions);

        return sendJson(res, 201, {
          success: true,
          key,
          duration,
          expires_at: expiresAt,
          created_at: createdAt,
          message: "License created successfully",
        });
      } catch (err) {
        return sendJson(res, 400, { error: "Key already exists or database error: " + err.message });
      }
    }

    // ------------------------------------------------------------------------
    // API 4: RESET HWID (ADMIN)
    // POST /api/license/reset-hwid
    // ------------------------------------------------------------------------
    if (pathname === "/api/license/reset-hwid" && req.method === "POST") {
      const body = await parseBody(req);
      if (!isAuthorizedAdmin(req, body)) {
        return sendJson(res, 401, { error: "Unauthorized admin access" });
      }

      const key = (body.key || "").trim().toUpperCase();
      if (!key) return sendJson(res, 400, { error: "Key is required" });

      const info = await db.run("UPDATE licenses SET machine_id = NULL WHERE key = ?", key);
      if (info.changes === 0) {
        return sendJson(res, 404, { error: "Key not found" });
      }

      return sendJson(res, 200, { success: true, message: `HWID reset for ${key}` });
    }

    // ------------------------------------------------------------------------
    // API 5: DELETE LICENSE (ADMIN)
    // POST /api/license/delete  OR  DELETE /api/license/delete
    // ------------------------------------------------------------------------
    if (pathname === "/api/license/delete" && (req.method === "POST" || req.method === "DELETE")) {
      const body = await parseBody(req);
      if (!isAuthorizedAdmin(req, body)) {
        return sendJson(res, 401, { error: "Unauthorized admin access" });
      }

      const key = (body.key || "").trim().toUpperCase();
      if (!key) return sendJson(res, 400, { error: "Key is required" });

      const info = await db.run("DELETE FROM licenses WHERE key = ?", key);
      if (info.changes === 0) {
        return sendJson(res, 404, { error: "Key not found" });
      }

      return sendJson(res, 200, { success: true, message: `Key ${key} deleted` });
    }

    // ------------------------------------------------------------------------
    // API 6: LIST ALL LICENSES (ADMIN)
    // GET /api/license/list
    // ------------------------------------------------------------------------
    if (pathname === "/api/license/list" && req.method === "GET") {
      if (!isAuthorizedAdmin(req)) {
        return sendJson(res, 401, { error: "Unauthorized admin access" });
      }

      const rows = await db.query("SELECT * FROM licenses ORDER BY id DESC");
      const licenses = rows.map((r) => {
        let perms = null;
        try { perms = JSON.parse(r.permissions || "{}"); } catch {}
        return {
          id: r.id,
          key: r.key,
          duration: r.duration,
          machine_id: r.machine_id,
          expires_at: r.expires_at,
          activated_at: r.activated_at,
          is_active: Boolean(r.is_active),
          created_at: r.created_at,
          permissions: perms,
        };
      });

      return sendJson(res, 200, licenses);
    }

    // ------------------------------------------------------------------------
    // API 7: UPDATE PERMISSIONS (ADMIN)
    // POST /api/license/permissions
    // ------------------------------------------------------------------------
    if (pathname === "/api/license/permissions" && req.method === "POST") {
      const body = await parseBody(req);
      if (!isAuthorizedAdmin(req, body)) {
        return sendJson(res, 401, { error: "Unauthorized admin access" });
      }

      const key = (body.key || "").trim().toUpperCase();
      const permsStr = JSON.stringify(body.permissions || {});

      await db.run("UPDATE licenses SET permissions = ? WHERE key = ?", permsStr, key);
      return sendJson(res, 200, { success: true, message: `Permissions updated for ${key}` });
    }

    // ------------------------------------------------------------------------
    // API 8: SYSTEM STATS
    // GET /api/stats
    // ------------------------------------------------------------------------
    if (pathname === "/api/stats" && req.method === "GET") {
      const totalRes = await db.get("SELECT COUNT(*) as count FROM licenses");
      const activeRes = await db.get("SELECT COUNT(*) as count FROM licenses WHERE is_active = 1");
      const lockedRes = await db.get("SELECT COUNT(*) as count FROM licenses WHERE machine_id IS NOT NULL AND machine_id != ''");
      const total = totalRes?.count || 0;
      const active = activeRes?.count || 0;
      const locked = lockedRes?.count || 0;
      return sendJson(res, 200, { total, active, locked });
    }

    // ------------------------------------------------------------------------
    // FRONTEND: WEB ADMIN DASHBOARD
    // GET / or GET /admin
    // ------------------------------------------------------------------------
    if (pathname === "/" || pathname === "/admin") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(getAdminDashboardHtml());
    }

    // 404 Handler
    sendJson(res, 404, { error: "Endpoint not found" });
  } catch (err) {
    console.error("[YH AUTH ERROR]", err);
    sendJson(res, 500, { error: "Internal server error: " + err.message });
  }
});

// Start Server
server.listen(PORT, HOST, () => {
  console.log(`================================================================`);
  console.log(`  âš¡ï¸  YH MACRO AUTH SERVER IS ONLINE!`);
  console.log(`  ðŸŒ  Local Address:     http://localhost:${PORT}`);
  console.log(`  ðŸ›¡ï¸   Admin Dashboard:   http://localhost:${PORT}/admin`);
  console.log(`  ðŸ”‘ Master Secret:     ${ADMIN_SECRET}`);
  console.log(`  ðŸ‘‘ Master Key:        ${MASTER_KEY}`);
  console.log(`================================================================`);
});

// Embedded Cyberpunk Web Admin Dashboard
function getAdminDashboardHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>YH Macro — License Auth Dashboard</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&family=JetBrains+Mono:wght@500;700&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: #07090f;
      color: #e2e8f0;
      font-family: 'Plus Jakarta Sans', sans-serif;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }
    .header {
      background: rgba(13, 18, 28, 0.85);
      border-bottom: 1px solid rgba(0, 240, 255, 0.2);
      backdrop-filter: blur(12px);
      padding: 16px 32px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      position: sticky;
      top: 0;
      z-index: 100;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .logo-badge {
      width: 36px;
      height: 36px;
      background: linear-gradient(135deg, #00f0ff, #0077ff);
      border-radius: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 800;
      color: #07090f;
      font-size: 16px;
      box-shadow: 0 0 15px rgba(0, 240, 255, 0.4);
    }
    .title {
      font-size: 18px;
      font-weight: 800;
      letter-spacing: 0.5px;
      color: #fff;
    }
    .subtitle {
      font-size: 11px;
      color: #00f0ff;
      font-weight: 700;
      letter-spacing: 1.5px;
      text-transform: uppercase;
    }
    .container {
      max-width: 1200px;
      width: 100%;
      margin: 32px auto;
      padding: 0 24px;
      flex: 1;
    }
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 18px;
      margin-bottom: 32px;
    }
    .stat-card {
      background: rgba(13, 18, 28, 0.6);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 14px;
      padding: 20px;
      position: relative;
      overflow: hidden;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
    }
    .stat-card::before {
      content: '';
      position: absolute;
      top: 0; left: 0; right: 0;
      height: 2px;
      background: linear-gradient(90deg, #00f0ff, transparent);
    }
    .stat-label {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: #7a8fa8;
      font-weight: 700;
    }
    .stat-value {
      font-size: 28px;
      font-weight: 800;
      color: #00f0ff;
      margin-top: 6px;
      font-family: 'JetBrains Mono', monospace;
    }
    .panel {
      background: rgba(13, 18, 28, 0.65);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 16px;
      padding: 24px;
      margin-bottom: 32px;
      box-shadow: 0 8px 30px rgba(0, 0, 0, 0.4);
    }
    .panel-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 20px;
    }
    .panel-title {
      font-size: 16px;
      font-weight: 800;
      color: #fff;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .btn {
      padding: 10px 18px;
      border-radius: 10px;
      font-weight: 700;
      font-size: 13px;
      cursor: pointer;
      transition: all 0.2s ease;
      border: none;
      display: inline-flex;
      align-items: center;
      gap: 8px;
    }
    .btn-cyan {
      background: linear-gradient(135deg, #00f0ff, #00aaff);
      color: #07090f;
      box-shadow: 0 0 15px rgba(0, 240, 255, 0.3);
    }
    .btn-cyan:hover {
      box-shadow: 0 0 25px rgba(0, 240, 255, 0.6);
      transform: translateY(-1px);
    }
    .btn-dark {
      background: #141c2b;
      color: #00f0ff;
      border: 1px solid rgba(0, 240, 255, 0.3);
    }
    .btn-dark:hover {
      background: #1e2a3f;
    }
    .btn-danger {
      background: rgba(255, 68, 68, 0.15);
      color: #ff4444;
      border: 1px solid rgba(255, 68, 68, 0.3);
    }
    .btn-danger:hover {
      background: rgba(255, 68, 68, 0.3);
    }
    .btn-sm {
      padding: 6px 12px;
      font-size: 11px;
      border-radius: 6px;
    }
    .form-row {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
    }
    select, input {
      background: #090d15;
      border: 1px solid rgba(255, 255, 255, 0.12);
      color: #fff;
      padding: 10px 16px;
      border-radius: 10px;
      font-size: 13px;
      outline: none;
      font-family: inherit;
    }
    select:focus, input:focus {
      border-color: #00f0ff;
      box-shadow: 0 0 10px rgba(0, 240, 255, 0.2);
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 12px;
    }
    th {
      text-align: left;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: #7a8fa8;
      padding: 12px 14px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    }
    td {
      padding: 14px;
      font-size: 13px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.04);
    }
    tr:hover td {
      background: rgba(0, 240, 255, 0.02);
    }
    .mono {
      font-family: 'JetBrains Mono', monospace;
      color: #00f0ff;
      font-weight: 700;
    }
    .badge {
      display: inline-block;
      padding: 4px 8px;
      border-radius: 6px;
      font-size: 10px;
      font-weight: 800;
      letter-spacing: 0.5px;
      text-transform: uppercase;
    }
    .badge-active {
      background: rgba(0, 255, 136, 0.15);
      color: #00ff88;
      border: 1px solid rgba(0, 255, 136, 0.3);
    }
    .badge-expired {
      background: rgba(255, 68, 68, 0.15);
      color: #ff4444;
      border: 1px solid rgba(255, 68, 68, 0.3);
    }
    .hwid-tag {
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px;
      color: #a0aec0;
      background: rgba(255, 255, 255, 0.05);
      padding: 4px 8px;
      border-radius: 6px;
    }
    #toast {
      position: fixed;
      bottom: 24px;
      right: 24px;
      background: #00f0ff;
      color: #07090f;
      padding: 12px 24px;
      border-radius: 10px;
      font-weight: 800;
      font-size: 13px;
      box-shadow: 0 4px 20px rgba(0, 240, 255, 0.5);
      display: none;
      z-index: 999;
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="brand">
      <div class="logo-badge">YH</div>
      <div>
        <div class="title">YH Macro Auth</div>
        <div class="subtitle">License Management Engine</div>
      </div>
    </div>
    <div style="display: flex; gap: 10px; align-items: center;">
      <span style="font-size: 12px; color: #7a8fa8;">Secret Key:</span>
      <input type="password" id="adminSecretInput" placeholder="Admin Secret" value="YH_AUTH_SECRET_2026_MASTER" style="width: 220px; padding: 6px 12px; font-size: 12px;" />
      <button class="btn btn-dark btn-sm" onclick="loadLicenses()">Refresh</button>
    </div>
  </div>

  <div class="container">
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">Total Licenses</div>
        <div class="stat-value" id="statTotal">0</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Active Licenses</div>
        <div class="stat-value" id="statActive" style="color: #00ff88;">0</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">HWID Locked</div>
        <div class="stat-value" id="statLocked" style="color: #00aaff;">0</div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-header">
        <div class="panel-title">âš¡ï¸  Generate New License Key</div>
      </div>
      <div class="form-row">
        <select id="durationSelect">
          <option value="Lifetime">Lifetime (No Expiry)</option>
          <option value="Year">1 Year (365 Days)</option>
          <option value="Month">1 Month (30 Days)</option>
          <option value="Week">1 Week (7 Days)</option>
          <option value="Seconds">30 Seconds (Testing)</option>
        </select>
        <button class="btn btn-cyan" onclick="createLicense()">+ Generate Key</button>
      </div>
    </div>

    <div class="panel">
      <div class="panel-header">
        <div class="panel-title">ðŸ”‘ All Registered Licenses</div>
        <input type="text" id="searchInput" placeholder="Search by key or HWID..." oninput="filterLicenses()" style="width: 280px; padding: 6px 12px;" />
      </div>
      <div style="overflow-x: auto;">
        <table>
          <thead>
            <tr>
              <th>License Key</th>
              <th>Duration</th>
              <th>Status</th>
              <th>Locked Machine ID</th>
              <th>Expires At</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody id="licensesTableBody">
            <tr><td colspan="6" style="text-align: center; color: #7a8fa8; padding: 24px;">Loading licenses...</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>

  <div id="toast"></div>

  <script>
    let allLicenses = [];

    function showToast(msg) {
      const t = document.getElementById("toast");
      t.innerText = msg;
      t.style.display = "block";
      setTimeout(() => { t.style.display = "none"; }, 3000);
    }

    function getSecret() {
      return document.getElementById("adminSecretInput").value.trim();
    }

    async function loadLicenses() {
      try {
        const res = await fetch("/api/license/list", {
          headers: { "Authorization": "Bearer " + getSecret() }
        });
        if (!res.ok) {
          throw new Error("HTTP " + res.status);
        }
        allLicenses = await res.json();
        renderTable(allLicenses);
        updateStats();
      } catch (err) {
        document.getElementById("licensesTableBody").innerHTML = 
          '<tr><td colspan="6" style="text-align: center; color: #ff4444; padding: 24px;">Failed to load licenses. Check Admin Secret.</td></tr>';
      }
    }

    function updateStats() {
      document.getElementById("statTotal").innerText = allLicenses.length;
      document.getElementById("statActive").innerText = allLicenses.filter(l => l.is_active).length;
      document.getElementById("statLocked").innerText = allLicenses.filter(l => l.machine_id).length;
    }

    function renderTable(list) {
      const tbody = document.getElementById("licensesTableBody");
      if (!list.length) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: #7a8fa8; padding: 24px;">No licenses generated yet.</td></tr>';
        return;
      }

      tbody.innerHTML = list.map(item => {
        const isExp = item.expires_at && new Date() > new Date(item.expires_at);
        const statusBadge = (!item.is_active || isExp) 
          ? '<span class="badge badge-expired">Expired</span>'
          : (!item.machine_id 
              ? '<span class="badge" style="background: rgba(0, 240, 255, 0.15); color: #00f0ff; border: 1px solid rgba(0, 240, 255, 0.3);">Ready</span>' 
              : '<span class="badge badge-active">Active</span>');

        const hwidDisplay = item.machine_id 
          ? '<span class="hwid-tag">' + item.machine_id.substring(0, 16) + '...</span>'
          : '<span style="color: #64748b; font-size: 11px;">Unbound (Any PC)</span>';

        const expDisplay = item.expires_at 
          ? new Date(item.expires_at).toLocaleDateString() + ' ' + new Date(item.expires_at).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})
          : (item.duration === "Lifetime" ? "Never (Lifetime)" : "Unused (Starts on activation)");

        return '<tr>' +
          '<td><span class="mono">' + item.key + '</span></td>' +
          '<td>' + item.duration + '</td>' +
          '<td>' + statusBadge + '</td>' +
          '<td>' + hwidDisplay + '</td>' +
          '<td>' + expDisplay + '</td>' +
          '<td>' +
            '<div style="display: flex; gap: 6px;">' +
              '<button class="btn btn-dark btn-sm" onclick="copyKey(\\'' + item.key + '\\')">Copy</button>' +
              (item.machine_id ? '<button class="btn btn-dark btn-sm" onclick="resetHwid(\\'' + item.key + '\\')">Reset HWID</button>' : '') +
              '<button class="btn btn-danger btn-sm" onclick="deleteKey(\\'' + item.key + '\\')">Delete</button>' +
            '</div>' +
          '</td>' +
        '</tr>';
      }).join("");
    }

    function filterLicenses() {
      const q = document.getElementById("searchInput").value.toLowerCase();
      const filtered = allLicenses.filter(l => 
        l.key.toLowerCase().includes(q) || 
        (l.machine_id && l.machine_id.toLowerCase().includes(q))
      );
      renderTable(filtered);
    }

    async function createLicense() {
      const duration = document.getElementById("durationSelect").value;
      try {
        const res = await fetch("/api/license/create", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": "Bearer " + getSecret()
          },
          body: JSON.stringify({ duration })
        });
        const data = await res.json();
        if (data.success) {
          showToast("Generated key: " + data.key);
          await loadLicenses();
        } else {
          alert("Error: " + (data.error || "Failed to create"));
        }
      } catch (e) {
        alert("Failed to connect to auth server: " + e.message);
      }
    }

    async function resetHwid(key) {
      if (!confirm("Reset HWID lock for " + key + "?\\nUser can activate on a new PC.")) return;
      try {
        const res = await fetch("/api/license/reset-hwid", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": "Bearer " + getSecret()
          },
          body: JSON.stringify({ key })
        });
        const data = await res.json();
        if (data.success) {
          showToast("HWID reset for " + key);
          await loadLicenses();
        } else {
          alert(data.error || "Failed to reset");
        }
      } catch (e) {
        alert(e.message);
      }
    }

    async function deleteKey(key) {
      if (!confirm("Permanently delete key " + key + "?")) return;
      try {
        const res = await fetch("/api/license/delete", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": "Bearer " + getSecret()
          },
          body: JSON.stringify({ key })
        });
        const data = await res.json();
        if (data.success) {
          showToast("Deleted " + key);
          await loadLicenses();
        } else {
          alert(data.error || "Failed to delete");
        }
      } catch (e) {
        alert(e.message);
      }
    }

    function copyKey(key) {
      navigator.clipboard.writeText(key);
      showToast("Copied key: " + key);
    }

    // Auto-load on open
    loadLicenses();
  </script>
</body>
</html>`;
}
