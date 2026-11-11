// طبقة Turso (libSQL عبر HTTP) — إلزامية للتوافق مع Vercel serverless (لا ملفات SQLite محلية)
import { createClient, type Client } from "@libsql/client";
import type { AttemptRecord, TaskRow, MediaType } from "./types";

// إنشاء مؤجّل: يمنع فشل next build عند غياب متغيرات البيئة وقت البناء
let _client: Client | null = null;
function client(): Client {
  if (!_client) {
    _client = createClient({
      url: process.env.TURSO_DATABASE_URL || "http://localhost:8080",
      authToken: process.env.TURSO_AUTH_TOKEN || undefined,
    });
  }
  return _client;
}

export const turso = new Proxy({} as Client, {
  get(_t, prop) {
    const real = client() as unknown as Record<string | symbol, unknown>;
    const v = real[prop];
    return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(real) : v;
  },
});

// إنشاء الجداول عند أول وصول فقط — بلا أداة migrations
let schemaPromise: Promise<void> | null = null;
export function ensureSchema(): Promise<void> {
  if (!schemaPromise) schemaPromise = createSchema();
  return schemaPromise;
}

async function createSchema(): Promise<void> {
  await turso.execute(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      provider TEXT,
      provider_task_id TEXT,
      key_id TEXT,
      model TEXT NOT NULL,
      type TEXT NOT NULL,
      prompt TEXT DEFAULT '',
      params_json TEXT DEFAULT '{}',
      status TEXT NOT NULL,
      progress INTEGER DEFAULT 0,
      result_urls_json TEXT,
      error_message TEXT,
      attempts_json TEXT DEFAULT '[]',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT
    )
  `);
  await turso.execute(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      label TEXT DEFAULT '',
      api_key TEXT NOT NULL,
      status TEXT DEFAULT 'active',
      usage_count INTEGER DEFAULT 0,
      success_count INTEGER DEFAULT 0,
      fail_count INTEGER DEFAULT 0,
      last_used_at TEXT,
      last_checked_at TEXT,
      last_error TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
}

export async function dbHealthy(): Promise<boolean> {
  try {
    await turso.execute("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

const nowIso = () => new Date().toISOString();

// ————— مخططات الصفوف (قراءة بأسماء الأعمدة صراحةً) —————
function mapTask(r: Record<string, unknown>): TaskRow {
  return {
    id: String(r.id ?? ""),
    provider: (r.provider as TaskRow["provider"]) ?? null,
    provider_task_id: (r.provider_task_id as string) ?? null,
    key_id: (r.key_id as string) ?? null,
    model: String(r.model ?? ""),
    type: String(r.type ?? "image") as MediaType,
    prompt: String(r.prompt ?? ""),
    params_json: String(r.params_json ?? "{}"),
    status: String(r.status ?? "pending"),
    progress: Number(r.progress ?? 0),
    result_urls_json: (r.result_urls_json as string) ?? null,
    error_message: (r.error_message as string) ?? null,
    attempts_json: (r.attempts_json as string) ?? "[]",
    created_at: String(r.created_at ?? ""),
    updated_at: String(r.updated_at ?? ""),
    completed_at: (r.completed_at as string) ?? null,
  };
}

// ————— عمليات المهام —————
export interface NewTaskInput {
  id: string;
  provider: TaskRow["provider"];
  provider_task_id: string | null;
  key_id: string | null;
  model: string;
  type: MediaType;
  prompt: string;
  params_json: string;
}

export async function insertTask(t: NewTaskInput): Promise<void> {
  await ensureSchema();
  await turso.execute({
    sql: `INSERT INTO tasks (id, provider, provider_task_id, key_id, model, type, prompt, params_json, status, progress)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0)`,
    args: [t.id, t.provider, t.provider_task_id, t.key_id, t.model, t.type, t.prompt, t.params_json],
  });
}

export async function getTask(id: string): Promise<TaskRow | null> {
  await ensureSchema();
  const rs = await turso.execute({ sql: "SELECT * FROM tasks WHERE id = ? LIMIT 1", args: [id] });
  if (rs.rows.length === 0) return null;
  return mapTask(rs.rows[0] as unknown as Record<string, unknown>);
}

// تحديث جزئي للمهمة — يضيف attempts ويضبط completed_at تلقائيًا عند الاكتمال
export interface TaskPatch {
  provider?: TaskRow["provider"];
  provider_task_id?: string | null;
  key_id?: string | null;
  status?: string;
  progress?: number;
  result_urls_json?: string | null;
  error_message?: string | null;
  attempt?: AttemptRecord; // محاولة تُدمج في attempts_json
}

export async function updateTask(id: string, patch: TaskPatch): Promise<void> {
  await ensureSchema();
  const sets: string[] = [];
  const args: (string | number | null)[] = [];

  if (patch.provider !== undefined) { sets.push("provider = ?"); args.push(patch.provider); }
  if (patch.provider_task_id !== undefined) { sets.push("provider_task_id = ?"); args.push(patch.provider_task_id); }
  if (patch.key_id !== undefined) { sets.push("key_id = ?"); args.push(patch.key_id); }
  if (patch.status !== undefined) {
    sets.push("status = ?");
    args.push(patch.status);
    if (patch.status === "completed") {
      sets.push("completed_at = COALESCE(completed_at, ?)");
      args.push(nowIso());
    }
  }
  if (patch.progress !== undefined) { sets.push("progress = ?"); args.push(Math.max(0, Math.min(100, Math.round(patch.progress)))); }
  if (patch.result_urls_json !== undefined) { sets.push("result_urls_json = ?"); args.push(patch.result_urls_json); }
  if (patch.error_message !== undefined) { sets.push("error_message = ?"); args.push(patch.error_message); }

  if (patch.attempt) {
    // قراءة-ثم-كتابة لسجل المحاولات (التزامن العملي هنا محدود)
    const cur = await getTask(id);
    let attempts: AttemptRecord[] = [];
    try { attempts = cur?.attempts_json ? JSON.parse(cur.attempts_json) : []; } catch { attempts = []; }
    attempts.push(patch.attempt);
    if (attempts.length > 200) attempts = attempts.slice(-200); // حماية من النمو اللانهائي
    sets.push("attempts_json = ?");
    args.push(JSON.stringify(attempts));
  }

  if (sets.length === 0) return;
  sets.push("updated_at = ?");
  args.push(nowIso());
  args.push(id);
  await turso.execute({ sql: `UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`, args });
}

export async function getTaskByProviderTaskId(provider: string, providerTaskId: string): Promise<TaskRow | null> {
  await ensureSchema();
  const rs = await turso.execute({
    sql: "SELECT * FROM tasks WHERE provider = ? AND provider_task_id = ? ORDER BY created_at DESC, id DESC LIMIT 1",
    args: [provider, providerTaskId],
  });
  if (rs.rows.length === 0) return null;
  return mapTask(rs.rows[0] as unknown as Record<string, unknown>);
}

export async function listRecentTasks(
  limit = 20,
  filters: { type?: MediaType; status?: string } = {},
): Promise<TaskRow[]> {
  await ensureSchema();
  const where: string[] = [];
  const args: string[] = [];
  if (filters.type) { where.push("type = ?"); args.push(filters.type); }
  if (filters.status) { where.push("status = ?"); args.push(filters.status); }
  const sql = `SELECT * FROM tasks ${where.length ? "WHERE " + where.join(" AND ") : ""}
               ORDER BY created_at DESC, id DESC LIMIT ?`;
  args.push(String(limit));
  const rs = await turso.execute({ sql, args });
  return rs.rows.map((r) => mapTask(r as unknown as Record<string, unknown>));
}

export interface TaskStats {
  total: number; completed: number; failed: number; processing: number;
}

export async function taskStats(): Promise<TaskStats> {
  await ensureSchema();
  const rs = await turso.execute(`
    SELECT
      COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) AS completed,
      COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
      COALESCE(SUM(CASE WHEN status IN ('processing','pending') THEN 1 ELSE 0 END), 0) AS processing
    FROM tasks
  `);
  const r = rs.rows[0] as unknown as Record<string, unknown>;
  return {
    total: Number(r.total ?? 0),
    completed: Number(r.completed ?? 0),
    failed: Number(r.failed ?? 0),
    processing: Number(r.processing ?? 0),
  };
}
