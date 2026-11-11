"use client";

// لوحة الإدارة العربية (RTL) — صفحة واحدة بثلاث بطاقات:
// أ) مدير المفاتيح  ب) لوحة المهام (تحديث حي كل 5 ثوانٍ)  ج) ربط السيرفر
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

// ————— أنواع البيانات —————
interface Health {
  ok: boolean; database: string; mcpEndpoint: string;
  models: { canonical: string; type: string; providers: string[] }[];
  merger: { base: string | null; configured: boolean; healthy: boolean };
  authRequired: boolean;
}
interface KeyRow {
  id: string; provider: string; label: string; masked_key: string; status: string;
  usage_count: number; success_count: number; fail_count: number;
  last_used_at: string | null; last_checked_at: string | null; last_error: string | null; created_at: string;
}
interface TaskDto {
  id: string; type: string; status: string; progress: number; model: string; prompt: string;
  error_message: string | null; result_urls: string[]; attempts_count: number;
  created_at: string; completed_at: string | null;
}
interface Stats { total: number; completed: number; failed: number; processing: number }

// ————— مساعدات —————
// أوقات SQLite بصيغة UTC بلا منطقة زمنية — نضيف Z لعرضها صحيحة
const fmtTime = (s: string | null): string => {
  if (!s) return "—";
  const iso = s.includes("T") ? s : s.replace(" ", "T") + "Z";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? s : d.toLocaleString("ar", { dateStyle: "short", timeStyle: "short" });
};

const typeLabel = (t: string) => (t === "image" ? "🖼 صورة" : t === "video" ? "🎬 فيديو" : "🎞 دمج");
const typeColor = (t: string) =>
  t === "image" ? "bg-sky-500/15 text-sky-300 border-sky-500/30" : t === "video" ? "bg-fuchsia-500/15 text-fuchsia-300 border-fuchsia-500/30" : "bg-amber-500/15 text-amber-300 border-amber-500/30";

function StatusBadge({ status }: { status: string }) {
  if (status === "completed") return <Badge className="bg-emerald-500/15 text-emerald-300 border-emerald-500/30">مكتملة</Badge>;
  if (status === "failed") return <Badge className="bg-red-500/15 text-red-300 border-red-500/30">فاشلة</Badge>;
  if (status === "exhausted") return <Badge className="bg-amber-500/15 text-amber-300 border-amber-500/30">مستنزف</Badge>;
  if (status === "disabled") return <Badge className="bg-slate-500/15 text-slate-300 border-slate-500/30">معطّل</Badge>;
  if (status === "active") return <Badge className="bg-emerald-500/15 text-emerald-300 border-emerald-500/30">نشط</Badge>;
  return <Badge className="bg-cyan-500/15 text-cyan-300 border-cyan-500/30">قيد المعالجة</Badge>;
}

const copy = async (text: string, label = "تم النسخ") => {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(label);
  } catch {
    toast.error("تعذر النسخ — انسخ يدويًا");
  }
};

const TOOLS = [
  { name: "generate_image", desc: "توليد صورة من وصف نصي (تبديل تلقائي عبر كل المفاتيح)" },
  { name: "generate_video", desc: "توليد فيديو بصوت متزامن أصلي (حوار/مؤثرات/موسيقى)" },
  { name: "merge_videos", desc: "دمج عدة مقاطع في مقطع واحد عالي الجودة بالترتيب المطلوب" },
  { name: "get_task", desc: "تتبع أي مهمة (توليد أو دمج) حتى الاكتمال" },
  { name: "list_media", desc: "استرجاع أحدث الوسائط المخزنة بروابطها" },
];

export default function Dashboard() {
  const [origin, setOrigin] = useState("");
  const [health, setHealth] = useState<Health | null>(null);
  const [keys, setKeys] = useState<KeyRow[]>([]);
  const [stats, setStats] = useState<Stats>({ total: 0, completed: 0, failed: 0, processing: 0 });
  const [tasks, setTasks] = useState<TaskDto[]>([]);

  // نموذج إضافة مفتاح
  const [provider, setProvider] = useState("kie");
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);

  const mcpUrl = origin ? `${origin}/mcp` : "";

  const loadHealth = useCallback(async () => {
    try {
      const r = await fetch("/api/health", { cache: "no-store" });
      setHealth(await r.json());
    } catch { /* نُبقي القيمة السابقة */ }
  }, []);
  const loadKeys = useCallback(async () => {
    try {
      const r = await fetch("/api/keys", { cache: "no-store" });
      const j = await r.json();
      setKeys(j.keys ?? []);
    } catch { /* نُبقي القيمة السابقة */ }
  }, []);
  const loadTasks = useCallback(async () => {
    try {
      const r = await fetch("/api/tasks?limit=20", { cache: "no-store" });
      const j = await r.json();
      setTasks(j.tasks ?? []);
      setStats(j.stats ?? stats);
    } catch { /* نُبقي القيمة السابقة */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setOrigin(window.location.origin);
    loadHealth(); loadKeys(); loadTasks();
    const h = setInterval(loadHealth, 10_000);
    const k = setInterval(loadKeys, 10_000);
    const t = setInterval(loadTasks, 5_000);
    return () => { clearInterval(h); clearInterval(k); clearInterval(t); };
  }, [loadHealth, loadKeys, loadTasks]);

  const addKey = async () => {
    if (!apiKey.trim()) { toast.error("أدخل مفتاح API"); return; }
    setBusy(true);
    try {
      const r = await fetch("/api/keys", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, api_key: apiKey.trim(), label: label.trim() }),
      });
      const j = await r.json();
      if (!r.ok) { toast.error(j.error || "فشل إضافة المفتاح"); return; }
      toast.success("أُضيف المفتاح بنجاح");
      setApiKey(""); setLabel("");
      loadKeys();
    } catch {
      toast.error("تعذر الاتصال بالسيرفر");
    } finally { setBusy(false); }
  };

  const toggleKey = async (k: KeyRow) => {
    const action = k.status === "disabled" ? "enable" : "disable";
    const r = await fetch(`/api/keys/${k.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) });
    if (r.ok) { toast.success(action === "disable" ? "عُطّل المفتاح" : "نُشّط المفتاح"); loadKeys(); }
    else toast.error("فشل تحديث المفتاح");
  };
  const removeKey = async (k: KeyRow) => {
    const r = await fetch(`/api/keys/${k.id}`, { method: "DELETE" });
    if (r.ok) { toast.success("حُذف المفتاح"); loadKeys(); }
    else toast.error("فشل حذف المفتاح");
  };

  // صيغ JSON للربط — تُبنى من الرابط الفعلي وحالة التوثيق
  const authHeaders = health?.authRequired ? `,\n        "headers": { "Authorization": "Bearer <MCP_ACCESS_TOKEN>" }` : "";
  const jsonChatGPT = `{\n  "mcpServers": {\n    "media-generator": {\n      "url": "${mcpUrl}"${health?.authRequired ? authHeaders : ""}\n    }\n  }\n}`;
  const jsonClaude = `{\n  "mcpServers": {\n    "media-generator": {\n      "type": "http",\n      "url": "${mcpUrl}"${health?.authRequired ? authHeaders : ""}\n    }\n  }\n}`;
  const jsonCursor = `{\n  "mcpServers": {\n    "media-generator": {\n      "url": "${mcpUrl}"${health?.authRequired ? authHeaders : ""}\n    }\n  }\n}`;

  return (
    <main className="mx-auto max-w-6xl px-4 pb-16 pt-6 sm:px-6">
      {/* ————— الهيدر ————— */}
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-cyan-500 to-fuchsia-500 text-2xl">✨</div>
          <div>
            <h1 className="text-xl font-bold sm:text-2xl">مولّد الوسائط — خادم MCP</h1>
            <p className="text-sm text-muted-foreground">توليد الصور والفيديو بالذكاء الاصطناعي ودمج المقاطع</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" className={health?.ok ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300" : "border-red-500/40 bg-red-500/10 text-red-300"}>
            {health?.ok ? "● Turso متصل" : "● غير متصل"}
          </Badge>
          <Badge variant="outline" className={health?.merger?.healthy ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300" : health?.merger?.configured ? "border-red-500/40 bg-red-500/10 text-red-300" : "border-amber-500/40 bg-amber-500/10 text-amber-300"}>
            {health?.merger?.healthy ? "● خدمة الدمج جاهزة" : health?.merger?.configured ? "● خدمة الدمج لا تستجيب" : "● خدمة الدمج غير مهيأة"}
          </Badge>
          {health?.authRequired ? <Badge variant="outline" className="border-cyan-500/40 bg-cyan-500/10 text-cyan-300">● محمي بـ Token</Badge> : null}
        </div>
      </header>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* ————— أ) مدير المفاتيح ————— */}
        <Card className="border-white/10 bg-white/5 backdrop-blur">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">🔑 مدير المفاتيح</CardTitle>
            <CardDescription>
              أضف عدة مفاتيح لكل مزود — التجربة تسلسلية (أول مفتاح ثم التالي ثم التالي) مع تبديل فوري تلقائي عند أي خطأ أو نفاد رصيد دون توقف.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-[130px_1fr]">
              <div className="space-y-1.5">
                <Label htmlFor="provider">المزود</Label>
                <Select value={provider} onValueChange={setProvider}>
                  <SelectTrigger id="provider"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="kie">kie.ai</SelectItem>
                    <SelectItem value="cometapi">CometAPI</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="label">تسمية اختيارية</Label>
                <Input id="label" dir="rtl" placeholder="مثال: مفتاح رئيسي" value={label} onChange={(e) => setLabel(e.target.value)} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="apikey">مفتاح API</Label>
              <div className="flex gap-2" dir="ltr">
                <Input id="apikey" className="font-mono text-left" placeholder="الصق المفتاح هنا" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
                <Button onClick={addKey} disabled={busy} className="shrink-0 bg-gradient-to-l from-cyan-500 to-fuchsia-500 text-white hover:opacity-90">
                  {busy ? "جارٍ الإضافة…" : "إضافة"}
                </Button>
              </div>
            </div>

            <div className="max-h-96 space-y-2 overflow-y-auto pe-1">
              {keys.length === 0 ? (
                <p className="rounded-lg border border-dashed border-white/15 p-4 text-center text-sm text-muted-foreground">لا توجد مفاتيح بعد — أضف أول مفتاح أعلاه.</p>
              ) : (
                keys.map((k) => (
                  <div key={k.id} className="rounded-lg border border-white/10 bg-white/5 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2" dir="ltr">
                        <code className="font-mono text-sm">{k.masked_key}</code>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <Badge variant="outline" className="border-white/20 bg-white/5">{k.provider === "kie" ? "kie.ai" : "CometAPI"}</Badge>
                        <StatusBadge status={k.status} />
                      </div>
                    </div>
                    {k.label ? <p className="mt-1 text-sm text-muted-foreground">🏷 {k.label}</p> : null}
                    <p className="mt-1 text-xs text-muted-foreground">
                      الاستخدام: {k.usage_count} — نجاح: {k.success_count} — فشل: {k.fail_count}
                      {k.last_used_at ? ` — آخر استخدام: ${fmtTime(k.last_used_at)}` : ""}
                    </p>
                    {k.last_error ? <p className="mt-1 truncate text-xs text-red-300/80" title={k.last_error}>آخر خطأ: {k.last_error}</p> : null}
                    <div className="mt-2 flex gap-2">
                      <Button size="sm" variant="outline" className="h-7 border-white/20 text-xs" onClick={() => toggleKey(k)}>
                        {k.status === "disabled" ? "تنشيط" : "تعطيل"}
                      </Button>
                      <Button size="sm" variant="outline" className="h-7 border-red-500/30 text-xs text-red-300 hover:bg-red-500/10" onClick={() => removeKey(k)}>
                        حذف
                      </Button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </CardContent>
        </Card>

        {/* ————— ب) لوحة المهام ————— */}
        <Card className="border-white/10 bg-white/5 backdrop-blur">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">📋 لوحة المهام</CardTitle>
            <CardDescription>تتحدث تلقائيًا كل 5 ثوانٍ — الحالة والتقدم والروابط وأرقام المحاولات.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-4 gap-2">
              {[
                { label: "الإجمالي", v: stats.total, c: "text-foreground" },
                { label: "مكتملة", v: stats.completed, c: "text-emerald-300" },
                { label: "فاشلة", v: stats.failed, c: "text-red-300" },
                { label: "جارية", v: stats.processing, c: "text-cyan-300" },
              ].map((s) => (
                <div key={s.label} className="rounded-lg border border-white/10 bg-white/5 p-2 text-center">
                  <div className={`text-xl font-bold ${s.c}`}>{s.v}</div>
                  <div className="text-xs text-muted-foreground">{s.label}</div>
                </div>
              ))}
            </div>

            <div className="max-h-[430px] space-y-2 overflow-y-auto pe-1">
              {tasks.length === 0 ? (
                <p className="rounded-lg border border-dashed border-white/15 p-4 text-center text-sm text-muted-foreground">لا توجد مهام بعد — استدعِ generate_image أو generate_video من أي عميل MCP.</p>
              ) : (
                tasks.map((t) => (
                  <div key={t.id} className="rounded-lg border border-white/10 bg-white/5 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className={typeColor(t.type)}>{typeLabel(t.type)}</Badge>
                        <StatusBadge status={t.status} />
                        {t.attempts_count > 1 ? <Badge variant="outline" className="border-white/20 bg-white/5 text-xs">المحاولات: {t.attempts_count}</Badge> : null}
                      </div>
                      <span className="text-xs text-muted-foreground">{fmtTime(t.created_at)}</span>
                    </div>
                    {t.status === "processing" ? (
                      <div className="mt-2 flex items-center gap-2">
                        <Progress value={t.progress} className="h-1.5 flex-1" />
                        <span className="text-xs text-cyan-300">{t.progress}%</span>
                      </div>
                    ) : null}
                    <p className="mt-1.5 font-mono text-xs text-muted-foreground" dir="ltr">{t.model}</p>
                    {t.prompt ? <p className="mt-1 line-clamp-2 text-sm">{t.prompt}</p> : null}
                    {t.error_message ? <p className="mt-1 text-xs text-red-300/80">❌ {t.error_message}</p> : null}
                    {t.result_urls.length > 0 ? (
                      <div className="mt-2 flex flex-wrap gap-2">
                        {t.result_urls.map((u, i) => (
                          <a key={i} href={u} target="_blank" rel="noreferrer" dir="ltr"
                             className="rounded-md border border-cyan-500/30 bg-cyan-500/10 px-2 py-1 text-xs text-cyan-300 hover:bg-cyan-500/20">
                            فتح الرابط {t.result_urls.length > 1 ? `#${i + 1}` : ""} ↗
                          </a>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ))
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ————— ج) ربط السيرفر ————— */}
      <Card className="mt-6 border-white/10 bg-white/5 backdrop-blur">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">🔌 ربط السيرفر</CardTitle>
          <CardDescription>انسخ الرابط والصيغة المناسبة لعميل MCP لديك — الأدوات الخمس جاهزة فورًا.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-2" dir="ltr">
            <Input readOnly value={mcpUrl || "…"} className="font-mono text-left" onFocus={(e) => e.currentTarget.select()} />
            <Button variant="outline" className="shrink-0 border-white/20" onClick={() => copy(mcpUrl, "نُسخ رابط MCP")}>نسخ الرابط</Button>
          </div>

          <Tabs defaultValue="chatgpt">
            <TabsList className="flex-wrap">
              <TabsTrigger value="chatgpt">ChatGPT / GPT Agents</TabsTrigger>
              <TabsTrigger value="claude">Claude Desktop</TabsTrigger>
              <TabsTrigger value="cursor">Cursor / Windsurf / Cline</TabsTrigger>
            </TabsList>
            {[
              { id: "chatgpt", json: jsonChatGPT, note: "في ChatGPT: Settings → Connectors → Create → Custom MCP server وضع الرابط في «Server URL»." },
              { id: "claude", json: jsonClaude, note: "الصيغة لملف claude_desktop_config.json مع «type»: \"http\"." },
              { id: "cursor", json: jsonCursor, note: "الصيغة لملف mcp.json في Cursor / Windsurf / Cline." },
            ].map((tab) => (
              <TabsContent key={tab.id} value={tab.id} className="space-y-2">
                <div className="flex justify-end">
                  <Button size="sm" variant="outline" className="border-white/20" onClick={() => copy(tab.json, "نُسخ JSON")}>نسخ JSON</Button>
                </div>
                <pre dir="ltr" className="max-h-56 overflow-auto rounded-lg border border-white/10 bg-black/40 p-3 text-left font-mono text-xs leading-5 text-cyan-100">{tab.json}</pre>
                <p className="text-xs text-muted-foreground">{tab.note}</p>
              </TabsContent>
            ))}
          </Tabs>

          <div className="flex flex-wrap gap-2">
            {TOOLS.map((tool) => (
              <div key={tool.name} className="rounded-lg border border-white/10 bg-white/5 px-3 py-2">
                <code dir="ltr" className="block text-left font-mono text-xs text-fuchsia-300">{tool.name}</code>
                <span className="text-xs text-muted-foreground">{tool.desc}</span>
              </div>
            ))}
          </div>

          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-200">
            ⚠️ الفيديو يحتاج دقائق: يعيد السيرفر task_id فورًا، ويتابَع تلقائيًا بـ get_task كل 10 ثوانٍ — وعند اكتمال المهمة يُعرض الرابط في الدردشة ويتوقف. أثناء الانتظار يُبَث تقدم حي (Progress notifications) حتى لا تنقطع العملية.
          </div>
        </CardContent>
      </Card>

      <footer className="mt-8 text-center text-xs text-muted-foreground">
        خادم MCP للوسائط — روابط فقط ولا تنزيل أي وسائط على السيرفر · مفاتيح مُقنَّعة دائمًا · تبديل تسلسلي صامت للمفاتيح
      </footer>
    </main>
  );
}
