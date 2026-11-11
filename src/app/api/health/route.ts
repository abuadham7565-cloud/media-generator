// فحص الصحة — قاعدة البيانات + جهوزية خدمة الدمج + الموديلات + حالة التوثيق
import { dbHealthy, ensureSchema } from "@/lib/turso";
import { MODELS } from "@/lib/models";
import { mergerBase, mergerConfigured, mergerHealth } from "@/lib/merger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  await ensureSchema();
  const dbOk = await dbHealthy();
  const mergerOk = await mergerHealth();

  return Response.json(
    {
      ok: dbOk,
      database: dbOk ? "turso-connected" : "disconnected",
      mcpEndpoint: "/mcp",
      models: MODELS.map((m) => ({ canonical: m.canonical, type: m.type, providers: m.providers })),
      merger: {
        base: mergerConfigured() ? mergerBase() : null,
        configured: mergerConfigured(),
        healthy: mergerOk,
      },
      authRequired: !!process.env.MCP_ACCESS_TOKEN,
    },
    { status: 200 },
  );
}
