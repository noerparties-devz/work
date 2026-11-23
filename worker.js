/**
 * ============================================================================
 * PROJECT: Noerism Prompt Gallery
 * FINAL BACKEND WORKER (Phase 2 - Phase 6 Complete)
 * Infrastructure: Cloudflare Workers + Cloudflare D1
 * ============================================================================
 */

// 1. KONFIGURASI CORS & HELPER RESPONSE
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...CORS_HEADERS,
    },
  });
}

function errorResponse(message, status = 400, details = null) {
  return jsonResponse(
    {
      success: false,
      error: {
        message,
        status,
        ...(details && { details }),
      },
    },
    status
  );
}

class HttpError extends Error {
  constructor(message, status = 400, details = null) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

async function parseBody(request) {
  try {
    return await request.json();
  } catch {
    throw new HttpError("Format JSON pada request body tidak valid.", 400);
  }
}

// 2. CRYPTOGRAPHY & GENERATOR HELPERS
async function hashAccessCode(plainCode) {
  const encoder = new TextEncoder();
  const data = encoder.encode(`noerism_salt_2026::${plainCode}`);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return "sha256:" + hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function verifyAccessCode(plainCode, storedCode) {
  if (storedCode.startsWith("sha256:")) {
    const hashedInput = await hashAccessCode(plainCode);
    return hashedInput === storedCode;
  }
  return plainCode === storedCode;
}

function generateSessionToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function generateRandomAccessCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const randomValues = new Uint8Array(8);
  crypto.getRandomValues(randomValues);
  let part1 = "";
  let part2 = "";
  for (let i = 0; i < 4; i++) {
    part1 += chars[randomValues[i] % chars.length];
    part2 += chars[randomValues[i + 4] % chars.length];
  }
  return `NRSM-${part1}-${part2}`;
}

const VALID_AVATARS = [
  "assets/profile1.png",
  "assets/profile2.png",
  "assets/profile3.png",
  "assets/profile4.png",
  "assets/profile5.png",
  "assets/admin-profile.png",
];

const VALID_COVERS = [
  "assets/cover1.png",
  "assets/cover2.png",
  "assets/cover3.png",
  "assets/cover4.png",
  "assets/cover5.png",
  "assets/admin-cover.mp4",
];

// 3. AUTHENTICATION & ROLE AUTHORIZATION MIDDLEWARE
function extractBearerToken(request) {
  const authHeader = request.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7).trim();
  return token || null;
}

async function requireAuth(request, env) {
  const token = extractBearerToken(request);
  if (!token) {
    throw new HttpError("Akses ditolak. Token autentikasi tidak ditemukan.", 401);
  }

  await env.DB.prepare("DELETE FROM sessions WHERE expires_at <= CURRENT_TIMESTAMP").run();

  const sessionUser = await env.DB.prepare(
    `SELECT 
      s.id AS session_id,
      s.token,
      s.expires_at,
      u.id,
      u.username,
      u.role,
      u.badge,
      u.status,
      u.avatar_asset,
      u.cover_asset,
      u.tier,
      u.subscription_expires_at,
      u.last_login_at
    FROM sessions s
    INNER JOIN users u ON s.user_id = u.id
    WHERE s.token = ? AND s.expires_at > CURRENT_TIMESTAMP`
  )
    .bind(token)
    .first();

  if (!sessionUser) {
    throw new HttpError("Sesi tidak valid atau telah berakhir. Silakan login kembali.", 401);
  }

  if (sessionUser.status !== "active") {
    await env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(sessionUser.id).run();
    throw new HttpError("Akun Anda telah ditangguhkan (Suspended). Hubungi Admin.", 403);
  }

  return sessionUser;
}

async function requireAdmin(request, env) {
  const user = await requireAuth(request, env);
  if (user.role !== "admin") {
    throw new HttpError("Akses terlarang. Area ini khusus Penguasa (Admin).", 403);
  }
  return user;
}

// 4. ROUTER ENGINE
class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler) {
    const paramNames = [];
    const regexPath = pattern.replace(/:([a-zA-Z0-9_]+)/g, (_, key) => {
      paramNames.push(key);
      return "([^/]+)";
    });
    const regex = new RegExp(`^${regexPath}/?$`);
    this.routes.push({ method, regex, paramNames, handler });
  }

  get(pattern, handler) { this.add("GET", pattern, handler); }
  post(pattern, handler) { this.add("POST", pattern, handler); }
  put(pattern, handler) { this.add("PUT", pattern, handler); }
  patch(pattern, handler) { this.add("PATCH", pattern, handler); }
  delete(pattern, handler) { this.add("DELETE", pattern, handler); }

  async handle(request, env, ctx) {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();

    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    for (const route of this.routes) {
      if (route.method !== method) continue;
      const match = url.pathname.match(route.regex);
      if (match) {
        const params = {};
        route.paramNames.forEach((name, idx) => {
          params[name] = decodeURIComponent(match[idx + 1]);
        });
        return await route.handler({ request, env, ctx, url, params });
      }
    }

    return errorResponse(`Endpoint ${method} ${url.pathname} tidak ditemukan.`, 404);
  }
}

const router = new Router();

// ============================================================================
// CORE & HEALTH ENDPOINTS
// ============================================================================
router.get("/", () => {
  return jsonResponse({
    success: true,
    service: "Noerism Prompt Gallery API",
    version: "1.0.0-final",
    status: "operational",
  });
});

router.get("/api/health", async ({ env }) => {
  if (!env.DB) {
    throw new HttpError("Binding D1 Database (DB) belum dikonfigurasi.", 500);
  }
  const dbCheck = await env.DB.prepare("SELECT COUNT(*) as total_users FROM users").first();
  return jsonResponse({
    success: true,
    database: "connected",
    admin_seeded: (dbCheck?.total_users || 0) >= 1,
    timestamp: new Date().toISOString(),
  });
});

// ============================================================================
// PHASE 3: AUTHENTICATION ENDPOINTS
// ============================================================================
router.post("/api/auth/login", async ({ request, env }) => {
  const body = await parseBody(request);
  const username = (body.username || "").trim();
  const accessCode = (body.access_code || "").trim();

  if (!username || !accessCode) {
    throw new HttpError("Username dan kode akses wajib diisi.", 400);
  }

  const user = await env.DB.prepare(
    `SELECT id, username, access_code, role, badge, status, avatar_asset, cover_asset, tier, subscription_expires_at 
     FROM users WHERE LOWER(username) = LOWER(?)`
  )
    .bind(username)
    .first();

  if (!user) {
    throw new HttpError("Username atau kode akses salah.", 401);
  }

  if (user.status !== "active") {
    throw new HttpError("Akun Anda berstatus Suspended. Silakan hubungi Customer Service.", 403);
  }

  const isValid = await verifyAccessCode(accessCode, user.access_code);
  if (!isValid) {
    throw new HttpError("Username atau kode akses salah.", 401);
  }

  if (!user.access_code.startsWith("sha256:")) {
    const hashed = await hashAccessCode(accessCode);
    await env.DB.prepare("UPDATE users SET access_code = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .bind(hashed, user.id)
      .run();
  }

  const token = generateSessionToken();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const userAgent = request.headers.get("User-Agent") || "Unknown Device";

  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO sessions (user_id, token, user_agent, expires_at) VALUES (?, ?, ?, ?)"
    ).bind(user.id, token, userAgent, expiresAt),
    env.DB.prepare(
      "UPDATE users SET last_login_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
    ).bind(user.id),
    env.DB.prepare(
      "INSERT INTO activity_logs (user_id, action_type) VALUES (?, 'LOGIN_ACTIVATION')"
    ).bind(user.id),
  ]);

  return jsonResponse({
    success: true,
    message: `Selamat datang kembali, ${user.username}!`,
    token,
    expires_at: expiresAt,
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      badge: user.badge,
      status: user.status,
      avatar_asset: user.avatar_asset,
      cover_asset: user.cover_asset,
      tier: user.tier,
      subscription_expires_at: user.subscription_expires_at,
    },
  });
});

router.get("/api/auth/me", async ({ request, env }) => {
  const user = await requireAuth(request, env);
  return jsonResponse({
    success: true,
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      badge: user.badge,
      status: user.status,
      avatar_asset: user.avatar_asset,
      cover_asset: user.cover_asset,
      tier: user.tier,
      subscription_expires_at: user.subscription_expires_at,
      last_login_at: user.last_login_at,
    },
  });
});

router.post("/api/auth/logout", async ({ request, env }) => {
  const token = extractBearerToken(request);
  if (token) {
    await env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(token).run();
  }
  return jsonResponse({
    success: true,
    message: "Berhasil logout dan sesi telah dihapus.",
  });
});

// ============================================================================
// PHASE 4: ADMIN SYSTEM (DASHBOARD PENGUASA & USER MANAGEMENT)
// ============================================================================
router.get("/api/admin/stats", async ({ request, env }) => {
  await requireAdmin(request, env);

  const [promptsCount, usersCount, activationsCount] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS total FROM prompts").first(),
    env.DB.prepare("SELECT COUNT(*) AS total FROM users").first(),
    env.DB.prepare("SELECT COUNT(*) AS total FROM activity_logs").first(),
  ]);

  return jsonResponse({
    success: true,
    stats: {
      total_prompts: promptsCount?.total || 0,
      total_users: usersCount?.total || 0,
      total_activations: activationsCount?.total || 0,
    },
  });
});

router.get("/api/admin/generate-code", async ({ request, env }) => {
  await requireAdmin(request, env);
  return jsonResponse({
    success: true,
    access_code: generateRandomAccessCode(),
  });
});

router.get("/api/admin/users", async ({ request, env, url }) => {
  await requireAdmin(request, env);

  const search = (url.searchParams.get("search") || "").trim();
  const statusFilter = (url.searchParams.get("status") || "").trim();

  let query = `
    SELECT id, username, role, badge, status, avatar_asset, cover_asset, tier, subscription_expires_at, last_login_at, created_at
    FROM users
    WHERE 1=1
  `;
  const bindings = [];

  if (search) {
    query += " AND (LOWER(username) LIKE LOWER(?) OR LOWER(badge) LIKE LOWER(?))";
    bindings.push(`%${search}%`, `%${search}%`);
  }

  if (statusFilter === "active" || statusFilter === "suspended") {
    query += " AND status = ?";
    bindings.push(statusFilter);
  }

  query += " ORDER BY id ASC";

  const stmt = env.DB.prepare(query);
  const { results } = bindings.length > 0 ? await stmt.bind(...bindings).all() : await stmt.all();

  return jsonResponse({
    success: true,
    total: results.length,
    users: results,
  });
});

router.post("/api/admin/users", async ({ request, env }) => {
  await requireAdmin(request, env);
  const body = await parseBody(request);

  const username = (body.username || "").trim();
  const rawAccessCode = (body.access_code || "").trim() || generateRandomAccessCode();
  const role = body.role === "admin" ? "admin" : "user";
  const badge = (body.badge || (role === "admin" ? "PENGUASA" : "ENTERPRISE")).trim();
  const tier = ["standard", "vip", "enterprise"].includes(body.tier) ? body.tier : "enterprise";

  if (!username || username.length < 3) {
    throw new HttpError("Username wajib diisi minimal 3 karakter.", 400);
  }

  if (!/^[a-zA-Z0-9._-]+$/.test(username)) {
    throw new HttpError("Username hanya boleh berisi huruf, angka, titik, underscore, atau strip.", 400);
  }

  if (rawAccessCode.length < 4) {
    throw new HttpError("Kode akses minimal 4 karakter.", 400);
  }

  const existing = await env.DB.prepare("SELECT id FROM users WHERE LOWER(username) = LOWER(?)")
    .bind(username)
    .first();
  if (existing) {
    throw new HttpError(`Username '${username}' sudah digunakan.`, 409);
  }

  const randomIdx = Math.floor(Math.random() * 5) + 1;
  const avatarAsset = VALID_AVATARS.includes(body.avatar_asset)
    ? body.avatar_asset
    : role === "admin"
    ? "assets/admin-profile.png"
    : `assets/profile${randomIdx}.png`;

  const coverAsset = VALID_COVERS.includes(body.cover_asset)
    ? body.cover_asset
    : role === "admin"
    ? "assets/admin-cover.mp4"
    : `assets/cover${randomIdx}.png`;

  const hashedCode = await hashAccessCode(rawAccessCode);

  const insertResult = await env.DB.prepare(
    `INSERT INTO users (username, access_code, role, badge, status, avatar_asset, cover_asset, tier)
     VALUES (?, ?, ?, ?, 'active', ?, ?, ?)
     RETURNING id, username, role, badge, status, avatar_asset, cover_asset, tier, created_at`
  )
    .bind(username, hashedCode, role, badge, avatarAsset, coverAsset, tier)
    .first();

  await env.DB.prepare("INSERT INTO activity_logs (user_id, action_type) VALUES (?, 'ACCOUNT_CREATED')")
    .bind(insertResult.id)
    .run();

  return jsonResponse(
    {
      success: true,
      message: `Akun '${username}' berhasil dibuat.`,
      plain_access_code: rawAccessCode,
      user: insertResult,
    },
    201
  );
});

router.patch("/api/admin/users/:id/username", async ({ request, env, params }) => {
  await requireAdmin(request, env);
  const userId = Number(params.id);
  const body = await parseBody(request);
  const newUsername = (body.username || "").trim();

  if (!newUsername || newUsername.length < 3 || !/^[a-zA-Z0-9._-]+$/.test(newUsername)) {
    throw new HttpError("Username baru tidak valid (minimal 3 karakter, tanpa spasi).", 400);
  }

  const targetUser = await env.DB.prepare("SELECT id, username FROM users WHERE id = ?").bind(userId).first();
  if (!targetUser) {
    throw new HttpError("Pengguna tidak ditemukan.", 404);
  }

  const duplicate = await env.DB.prepare("SELECT id FROM users WHERE LOWER(username) = LOWER(?) AND id != ?")
    .bind(newUsername, userId)
    .first();
  if (duplicate) {
    throw new HttpError(`Username '${newUsername}' sudah dipakai akun lain.`, 409);
  }

  await env.DB.prepare("UPDATE users SET username = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .bind(newUsername, userId)
    .run();

  return jsonResponse({
    success: true,
    message: `Username berhasil diubah menjadi '${newUsername}'.`,
    user_id: userId,
    username: newUsername,
  });
});

router.patch("/api/admin/users/:id/reset-code", async ({ request, env, params }) => {
  await requireAdmin(request, env);
  const userId = Number(params.id);
  let newCode = "";

  try {
    const body = await request.json();
    newCode = (body.access_code || "").trim();
  } catch {
    newCode = "";
  }

  if (!newCode) {
    newCode = generateRandomAccessCode();
  } else if (newCode.length < 4) {
    throw new HttpError("Kode akses baru minimal 4 karakter.", 400);
  }

  const targetUser = await env.DB.prepare("SELECT id, username FROM users WHERE id = ?").bind(userId).first();
  if (!targetUser) {
    throw new HttpError("Pengguna tidak ditemukan.", 404);
  }

  const hashedCode = await hashAccessCode(newCode);

  await env.DB.batch([
    env.DB.prepare("UPDATE users SET access_code = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(
      hashedCode,
      userId
    ),
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId),
  ]);

  return jsonResponse({
    success: true,
    message: `Kode akses untuk '${targetUser.username}' berhasil di-reset.`,
    user_id: userId,
    username: targetUser.username,
    plain_access_code: newCode,
  });
});

router.patch("/api/admin/users/:id/status", async ({ request, env, params }) => {
  const admin = await requireAdmin(request, env);
  const userId = Number(params.id);
  const body = await parseBody(request);
  const status = body.status;

  if (status !== "active" && status !== "suspended") {
    throw new HttpError("Status harus berupa 'active' atau 'suspended'.", 400);
  }

  if (admin.id === userId && status === "suspended") {
    throw new HttpError("Anda tidak dapat menonaktifkan akun Admin Anda sendiri.", 400);
  }

  const targetUser = await env.DB.prepare("SELECT id, username FROM users WHERE id = ?").bind(userId).first();
  if (!targetUser) {
    throw new HttpError("Pengguna tidak ditemukan.", 404);
  }

  const queries = [
    env.DB.prepare("UPDATE users SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(status, userId),
  ];

  if (status === "suspended") {
    queries.push(env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId));
  } else {
    queries.push(
      env.DB.prepare("INSERT INTO activity_logs (user_id, action_type) VALUES (?, 'ACCOUNT_ACTIVATED')").bind(userId)
    );
  }

  await env.DB.batch(queries);

  return jsonResponse({
    success: true,
    message:
      status === "active"
        ? `Akun '${targetUser.username}' berhasil diaktifkan.`
        : `Akun '${targetUser.username}' berhasil di-suspend.`,
    user_id: userId,
    status,
  });
});

router.delete("/api/admin/users/:id", async ({ request, env, params }) => {
  const admin = await requireAdmin(request, env);
  const userId = Number(params.id);

  if (admin.id === userId) {
    throw new HttpError("Anda tidak dapat menghapus akun Admin Anda sendiri.", 400);
  }

  const targetUser = await env.DB.prepare("SELECT id, username FROM users WHERE id = ?").bind(userId).first();
  if (!targetUser) {
    throw new HttpError("Pengguna tidak ditemukan.", 404);
  }

  await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(userId).run();

  return jsonResponse({
    success: true,
    message: `Akun '${targetUser.username}' berhasil dihapus secara permanen.`,
  });
});

// ============================================================================
// PHASE 5: ADMIN PROMPT MANAGEMENT ENDPOINTS
// ============================================================================

// GET /api/admin/prompts -> Semua prompt (Published & Draft) untuk Admin
router.get("/api/admin/prompts", async ({ request, env, url }) => {
  await requireAdmin(request, env);

  const search = (url.searchParams.get("search") || "").trim();
  const status = (url.searchParams.get("status") || "").trim();
  const model = (url.searchParams.get("model") || "").trim();

  let query = `
    SELECT p.*, u.username AS author_username
    FROM prompts p
    LEFT JOIN users u ON p.created_by = u.id
    WHERE 1=1
  `;
  const bindings = [];

  if (search) {
    query += " AND (LOWER(p.code) LIKE LOWER(?) OR LOWER(p.title) LIKE LOWER(?) OR LOWER(p.description) LIKE LOWER(?))";
    bindings.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }

  if (status === "published" || status === "draft") {
    query += " AND p.status = ?";
    bindings.push(status);
  }

  if (model) {
    query += " AND LOWER(p.ai_model) = LOWER(?)";
    bindings.push(model);
  }

  query += " ORDER BY p.id DESC";

  const stmt = env.DB.prepare(query);
  const { results } = bindings.length > 0 ? await stmt.bind(...bindings).all() : await stmt.all();

  return jsonResponse({
    success: true,
    total: results.length,
    prompts: results,
  });
});

// GET /api/admin/prompts/:id -> Detail satu prompt untuk form Edit
router.get("/api/admin/prompts/:id", async ({ request, env, params }) => {
  await requireAdmin(request, env);
  const promptId = Number(params.id);

  const prompt = await env.DB.prepare("SELECT * FROM prompts WHERE id = ?").bind(promptId).first();
  if (!prompt) {
    throw new HttpError("Prompt tidak ditemukan.", 404);
  }

  return jsonResponse({
    success: true,
    prompt,
  });
});

// POST /api/admin/prompts -> Menambah prompt baru
router.post("/api/admin/prompts", async ({ request, env }) => {
  const admin = await requireAdmin(request, env);
  const body = await parseBody(request);

  const code = (body.code || "").trim();
  const title = (body.title || "").trim();
  const description = (body.description || "").trim();
  const promptBy = (body.prompt_by || "Noerism").trim();
  const aiModel = (body.ai_model || "").trim();
  const imageUrl = (body.image_url || "").trim();
  const fullPrompt = (body.full_prompt || "").trim();
  const outfitPrompt = (body.outfit_prompt || "").trim();
  const status = body.status === "published" ? "published" : "draft";
  const accessLevel = body.access_level === "vip" ? "vip" : "all";

  if (!code || !title || !description || !aiModel || !imageUrl || !fullPrompt) {
    throw new HttpError(
      "Field wajib (Code, Judul, Deskripsi, Model AI, URL Gambar, dan Full Prompt) harus diisi.",
      400
    );
  }

  const existingCode = await env.DB.prepare("SELECT id FROM prompts WHERE LOWER(code) = LOWER(?)")
    .bind(code)
    .first();
  if (existingCode) {
    throw new HttpError(`Kode prompt '${code}' sudah digunakan. Gunakan kode unik lain (misal: Noerism_2).`, 409);
  }

  const created = await env.DB.prepare(
    `INSERT INTO prompts (
      code, title, description, prompt_by, ai_model, image_url, full_prompt, outfit_prompt, status, access_level, created_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING *`
  )
    .bind(code, title, description, promptBy, aiModel, imageUrl, fullPrompt, outfitPrompt, status, accessLevel, admin.id)
    .first();

  return jsonResponse(
    {
      success: true,
      message: `Prompt '${title}' (${code}) berhasil disimpan sebagai ${status.toUpperCase()}.`,
      prompt: created,
    },
    201
  );
});

// PUT /api/admin/prompts/:id -> Edit seluruh detail prompt
router.put("/api/admin/prompts/:id", async ({ request, env, params }) => {
  await requireAdmin(request, env);
  const promptId = Number(params.id);
  const body = await parseBody(request);

  const existing = await env.DB.prepare("SELECT * FROM prompts WHERE id = ?").bind(promptId).first();
  if (!existing) {
    throw new HttpError("Prompt tidak ditemukan.", 404);
  }

  const code = (body.code ?? existing.code).trim();
  const title = (body.title ?? existing.title).trim();
  const description = (body.description ?? existing.description).trim();
  const promptBy = (body.prompt_by ?? existing.prompt_by).trim();
  const aiModel = (body.ai_model ?? existing.ai_model).trim();
  const imageUrl = (body.image_url ?? existing.image_url).trim();
  const fullPrompt = (body.full_prompt ?? existing.full_prompt).trim();
  const outfitPrompt = (body.outfit_prompt ?? existing.outfit_prompt ?? "").trim();
  const status = body.status === "published" || body.status === "draft" ? body.status : existing.status;
  const accessLevel = body.access_level === "vip" || body.access_level === "all" ? body.access_level : existing.access_level;

  if (!code || !title || !description || !aiModel || !imageUrl || !fullPrompt) {
    throw new HttpError("Semua kolom utama prompt tidak boleh dikosongkan.", 400);
  }

  const duplicateCode = await env.DB.prepare("SELECT id FROM prompts WHERE LOWER(code) = LOWER(?) AND id != ?")
    .bind(code, promptId)
    .first();
  if (duplicateCode) {
    throw new HttpError(`Kode prompt '${code}' sudah dipakai oleh prompt lain.`, 409);
  }

  const updated = await env.DB.prepare(
    `UPDATE prompts SET
      code = ?,
      title = ?,
      description = ?,
      prompt_by = ?,
      ai_model = ?,
      image_url = ?,
      full_prompt = ?,
      outfit_prompt = ?,
      status = ?,
      access_level = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
    RETURNING *`
  )
    .bind(code, title, description, promptBy, aiModel, imageUrl, fullPrompt, outfitPrompt, status, accessLevel, promptId)
    .first();

  return jsonResponse({
    success: true,
    message: `Prompt '${title}' berhasil diperbarui.`,
    prompt: updated,
  });
});

// PATCH /api/admin/prompts/:id/status -> Toggle cepat Publish / Draft
router.patch("/api/admin/prompts/:id/status", async ({ request, env, params }) => {
  await requireAdmin(request, env);
  const promptId = Number(params.id);
  const body = await parseBody(request);
  const status = body.status;

  if (status !== "published" && status !== "draft") {
    throw new HttpError("Status publikasi harus 'published' atau 'draft'.", 400);
  }

  const existing = await env.DB.prepare("SELECT id, title FROM prompts WHERE id = ?").bind(promptId).first();
  if (!existing) {
    throw new HttpError("Prompt tidak ditemukan.", 404);
  }

  await env.DB.prepare("UPDATE prompts SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .bind(status, promptId)
    .run();

  return jsonResponse({
    success: true,
    message: `Status prompt '${existing.title}' diubah menjadi ${status.toUpperCase()}.`,
    prompt_id: promptId,
    status,
  });
});

// DELETE /api/admin/prompts/:id -> Hapus prompt
router.delete("/api/admin/prompts/:id", async ({ request, env, params }) => {
  await requireAdmin(request, env);
  const promptId = Number(params.id);

  const existing = await env.DB.prepare("SELECT id, title FROM prompts WHERE id = ?").bind(promptId).first();
  if (!existing) {
    throw new HttpError("Prompt tidak ditemukan.", 404);
  }

  await env.DB.prepare("DELETE FROM prompts WHERE id = ?").bind(promptId).run();

  return jsonResponse({
    success: true,
    message: `Prompt '${existing.title}' berhasil dihapus.`,
  });
});

// ============================================================================
// PHASE 6: USER FEATURES (PROMPT GALLERY, DETAIL, SEARCH & SAVED PROMPTS)
// ============================================================================

// GET /api/prompts -> Galeri Prompt Published + Pencarian Kode/Judul + Filter Kategori Model AI
router.get("/api/prompts", async ({ request, env, url }) => {
  const user = await requireAuth(request, env);

  const search = (url.searchParams.get("search") || "").trim();
  const category = (url.searchParams.get("category") || "").trim(); // Contoh: 'GPT Image', 'Gemini AI'

  let query = `
    SELECT 
      p.id,
      p.code,
      p.title,
      p.description,
      p.prompt_by,
      p.ai_model,
      p.image_url,
      p.access_level,
      p.created_at,
      CASE WHEN sp.id IS NOT NULL THEN 1 ELSE 0 END AS is_saved
    FROM prompts p
    LEFT JOIN saved_prompts sp ON p.id = sp.prompt_id AND sp.user_id = ?
    WHERE p.status = 'published'
  `;
  const bindings = [user.id];

  if (search) {
    query += " AND (LOWER(p.code) LIKE LOWER(?) OR LOWER(p.title) LIKE LOWER(?) OR LOWER(p.description) LIKE LOWER(?))";
    bindings.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }

  if (category && category.toLowerCase() !== "all") {
    query += " AND LOWER(p.ai_model) = LOWER(?)";
    bindings.push(category);
  }

  query += " ORDER BY p.id DESC";

  const { results } = await env.DB.prepare(query).bind(...bindings).all();

  // Ambil daftar kategori AI Model yang tersedia dari prompt published
  const { results: categoriesResult } = await env.DB.prepare(
    "SELECT DISTINCT ai_model FROM prompts WHERE status = 'published' ORDER BY ai_model ASC"
  ).all();

  return jsonResponse({
    success: true,
    total: results.length,
    categories: categoriesResult.map((c) => c.ai_model),
    prompts: results.map((item) => ({
      ...item,
      is_saved: Boolean(item.is_saved),
    })),
  });
});

// GET /api/prompts/:identifier -> Detail Prompt lengkap (Full Prompt & Outfit Prompt) berdasarkan ID atau Code
router.get("/api/prompts/:identifier", async ({ request, env, params }) => {
  const user = await requireAuth(request, env);
  const identifier = params.identifier;

  const isNumericId = /^\d+$/.test(identifier);
  const query = `
    SELECT 
      p.*,
      CASE WHEN sp.id IS NOT NULL THEN 1 ELSE 0 END AS is_saved
    FROM prompts p
    LEFT JOIN saved_prompts sp ON p.id = sp.prompt_id AND sp.user_id = ?
    WHERE ${isNumericId ? "p.id = ?" : "LOWER(p.code) = LOWER(?)"}
      ${user.role === "admin" ? "" : "AND p.status = 'published'"}
  `;

  const prompt = await env.DB.prepare(query)
    .bind(user.id, isNumericId ? Number(identifier) : identifier)
    .first();

  if (!prompt) {
    throw new HttpError("Detail prompt tidak ditemukan atau belum dipublikasikan.", 404);
  }

  // Persiapan pembatasan VIP di masa mendatang
  if (prompt.access_level === "vip" && user.role !== "admin" && user.tier === "standard") {
    throw new HttpError("Prompt ini khusus member VIP / Enterprise.", 403);
  }

  return jsonResponse({
    success: true,
    prompt: {
      ...prompt,
      is_saved: Boolean(prompt.is_saved),
    },
  });
});

// GET /api/saved-prompts -> Daftar prompt yang disimpan oleh user
router.get("/api/saved-prompts", async ({ request, env }) => {
  const user = await requireAuth(request, env);

  const { results } = await env.DB.prepare(
    `SELECT 
      p.id,
      p.code,
      p.title,
      p.description,
      p.prompt_by,
      p.ai_model,
      p.image_url,
      p.access_level,
      sp.created_at AS saved_at
    FROM saved_prompts sp
    INNER JOIN prompts p ON sp.prompt_id = p.id
    WHERE sp.user_id = ? AND p.status = 'published'
    ORDER BY sp.created_at DESC`
  )
    .bind(user.id)
    .all();

  return jsonResponse({
    success: true,
    total: results.length,
    prompts: results.map((item) => ({
      ...item,
      is_saved: true,
    })),
  });
});

// POST /api/saved-prompts/:id/toggle -> Simpan atau Hapus dari Saved Prompts
router.post("/api/saved-prompts/:id/toggle", async ({ request, env, params }) => {
  const user = await requireAuth(request, env);
  const promptId = Number(params.id);

  const prompt = await env.DB.prepare("SELECT id, title FROM prompts WHERE id = ? AND status = 'published'")
    .bind(promptId)
    .first();
  if (!prompt) {
    throw new HttpError("Prompt tidak ditemukan.", 404);
  }

  const existing = await env.DB.prepare("SELECT id FROM saved_prompts WHERE user_id = ? AND prompt_id = ?")
    .bind(user.id, promptId)
    .first();

  if (existing) {
    await env.DB.prepare("DELETE FROM saved_prompts WHERE id = ?").bind(existing.id).run();
    return jsonResponse({
      success: true,
      saved: false,
      message: `Prompt '${prompt.title}' dihapus dari daftar tersimpan.`,
    });
  } else {
    await env.DB.prepare("INSERT INTO saved_prompts (user_id, prompt_id) VALUES (?, ?)").bind(user.id, promptId).run();
    return jsonResponse({
      success: true,
      saved: true,
      message: `Prompt '${prompt.title}' berhasil disimpan.`,
    });
  }
});

// ============================================================================
// ENTRY POINT WORKER
// ============================================================================
export default {
  async fetch(request, env, ctx) {
    try {
      return await router.handle(request, env, ctx);
    } catch (err) {
      if (err instanceof HttpError) {
        return errorResponse(err.message, err.status, err.details);
      }
      console.error("Unhandled Worker Error:", err);
      return errorResponse(
        "Terjadi kesalahan internal pada server.",
        500,
        err?.message || "Unknown error"
      );
    }
  },
};
