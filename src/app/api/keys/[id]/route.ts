// تعطيل/تنشيط يدوي وحذف مفتاح
import { NextRequest } from "next/server";
import { deleteKey, setKeyStatus } from "@/lib/keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let body: { action?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "طلب غير صالح: JSON غير صحيح." }, { status: 400 });
  }
  if (body.action !== "disable" && body.action !== "enable") {
    return Response.json({ error: "الإجراء يجب أن يكون disable أو enable." }, { status: 400 });
  }
  const ok = await setKeyStatus(id, body.action === "disable" ? "disabled" : "active");
  if (!ok) return Response.json({ error: "المفتاح غير موجود." }, { status: 404 });
  return Response.json({ ok: true }, { status: 200 });
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const ok = await deleteKey(id);
  if (!ok) return Response.json({ error: "المفتاح غير موجود." }, { status: 404 });
  return Response.json({ ok: true }, { status: 200 });
}
