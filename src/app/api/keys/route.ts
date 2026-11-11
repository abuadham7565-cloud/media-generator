// إدارة المفاتيح — القائمة كاملة مع إخفاء المفاتيح دائمًا (maskKey)
import { NextRequest } from "next/server";
import { addKey, listKeys } from "@/lib/keys";
import type { ProviderId } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const keys = await listKeys();
  return Response.json({ keys }, { status: 200 });
}

export async function POST(req: NextRequest) {
  let body: { provider?: string; api_key?: string; label?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "طلب غير صالح: JSON غير صحيح." }, { status: 400 });
  }
  const provider = String(body.provider ?? "").trim();
  const apiKey = String(body.api_key ?? "").trim();
  const label = String(body.label ?? "").trim();

  if (provider !== "kie" && provider !== "cometapi") {
    return Response.json({ error: "المزود يجب أن يكون kie أو cometapi." }, { status: 400 });
  }
  if (!apiKey) return Response.json({ error: "أدخل مفتاح API." }, { status: 400 });

  const r = await addKey(provider as ProviderId, apiKey, label);
  if (!r.ok) return Response.json({ error: r.error }, { status: 409 });
  return Response.json({ key: r.key }, { status: 201 });
}
