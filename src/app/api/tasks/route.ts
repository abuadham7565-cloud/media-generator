// لوحة المهام للواجهة — إحصائيات + أحدث المهام (تُستخدم بالاستقصاء كل ~5 ثوانٍ)
import { listRecentTasks, taskStats } from "@/lib/turso";
import { parse } from "@/lib/tasks-view";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const limit = Math.max(1, Math.min(50, Number(url.searchParams.get("limit") ?? 20) || 20));
  const [stats, rows] = await Promise.all([taskStats(), listRecentTasks(limit)]);
  return Response.json({ stats, tasks: rows.map(parse) }, { status: 200 });
}
