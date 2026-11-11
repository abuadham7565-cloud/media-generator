// بناء خادم MCP بالأدوات الخمس — يستخدم SDK الرسمي (McpServer) بلا JSON-RPC يدوي
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SERVER_INFO, SERVER_INSTRUCTIONS, TOOL_DESCRIPTIONS } from "./mcp-constants";
import { runGeneration, runMerge, refreshAndGetTask, type ProgressCb } from "./generator";
import { listRecentTasks } from "./turso";
import { resolveModel } from "./models";
import type { MediaType } from "./types";

// صياغة موحدة لنتائج الأدوات — النتائج بالعربية دائمًا
const mk = (text: string, isError = false) => ({
  content: [{ type: "text" as const, text }],
  ...(isError ? { isError: true } : {}),
});

// استخراج progressToken من _meta إن زوّد العميل الطلب به
function progressTokenOf(extra: unknown): string | number | undefined {
  const meta = (extra as { _meta?: { progressToken?: string | number } } | undefined)?._meta;
  return meta?.progressToken;
}

// مُبثّ التقدم: كل ~3 ثوانٍ رسالة عربية مع progress/total — يُرسل فقط إن وُجد progressToken
function makeProgressCb(extra: unknown): ProgressCb | undefined {
  const token = progressTokenOf(extra);
  if (token === undefined) return undefined;
  const sendNotification = (extra as { sendNotification: (n: unknown) => Promise<void> }).sendNotification.bind(extra);
  return async (p) => {
    try {
      await sendNotification({
        method: "notifications/progress",
        params: { progressToken: token, progress: p.progress, total: p.total, message: p.message },
      });
    } catch {
      // فشل إشعار التقدم لا يفشل المهمة
    }
  };
}

const IMAGE_RATIOS = ["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5", "16:9", "9:16", "2:1", "1:2", "21:9", "9:21", "3:1", "1:3"] as const;
const VIDEO_RATIOS = ["auto", "1:1", "16:9", "9:16", "3:2", "2:3"] as const;

export function buildMcpServer(): McpServer {
  // SERVER_INSTRUCTIONS يُرسل مع initialize ليوجّه النموذج للتعامل الصحيح
  const server = new McpServer(SERVER_INFO, { instructions: SERVER_INSTRUCTIONS });

  // 1) generate_image
  server.registerTool(
    "generate_image",
    {
      title: "Generate Image",
      description: TOOL_DESCRIPTIONS.generate_image,
      inputSchema: {
        prompt: z.string().min(1).describe("What to draw. Detailed prompts give better results."),
        model: z.enum(["gpt-image-2-6/flare-text-to-image", "gpt-image-2.6/flare-text-to-image"])
          .default("gpt-image-2-6/flare-text-to-image"),
        aspect_ratio: z.enum(IMAGE_RATIOS).default("auto"),
        resolution: z.enum(["1K", "2K", "4K"]).default("1K"),
        background: z.enum(["auto", "transparent", "opaque"]).default("auto").describe("Only applied at 1K."),
        output_format: z.enum(["png", "jpeg", "webp", "gif"]).default("png"),
        wait_seconds: z.number().int().min(0).max(240).default(90),
      },
    },
    async (args, extra) => {
      const modelDef = resolveModel(args.model ?? "gpt-image-2-6/flare-text-to-image");
      if (!modelDef || modelDef.type !== "image") {
        return mk(`❌ موديل صورة غير معروف: ${args.model}. المتاح: gpt-image-2-6/flare-text-to-image`, true);
      }
      const out = await runGeneration({
        modelDef, type: "image", args: args as unknown as Record<string, unknown>,
        prompt: String(args.prompt ?? ""), onProgress: makeProgressCb(extra),
      });
      if (out.state === "no_keys") {
        return mk(`❌ لا توجد مفاتيح نشطة لخدمة ${modelDef.canonical}. أضف مفتاحًا واحدًا على الأقل من واجهة الإدارة، ثم أعد المحاولة.`, true);
      }
      if (out.state === "failed") return mk(out.message || "❌ فشلت المهمة.", true);
      if (out.state === "completed" && out.urls?.length) {
        return mk(`✅ تم توليد الصورة بنجاح\n\n${out.urls.map((u) => `![image](${u})`).join("\n\n")}\n\n${out.urls.map((u) => `الرابط المباشر: ${u}`).join("\n")}`);
      }
      return mk(`⏳ المهمة قيد المعالجة — task_id: ${out.taskId}\n\nتابع بـ get_task كل ~10 ثوانٍ حتى تكتمل.`);
    },
  );

  // 2) generate_video
  server.registerTool(
    "generate_video",
    {
      title: "Generate Video",
      description: TOOL_DESCRIPTIONS.generate_video,
      inputSchema: {
        prompt: z.string().max(4096).describe("Scene description. Dialogue in the prompt is spoken in the video."),
        image_url: z.string().optional().describe("Optional public image URL as the first frame (image-to-video)."),
        model: z.enum(["grok-imagine-video-1-5-preview", "grok-imagine-video-1.5-preview"])
          .default("grok-imagine-video-1-5-preview"),
        aspect_ratio: z.enum(VIDEO_RATIOS).default("auto"),
        resolution: z.enum(["480p", "720p", "1080p"]).default("480p"),
        enable_audio: z.boolean().default(true),
        duration: z.number().int().min(1).max(15).default(8).describe("Duration in seconds."),
        wait_seconds: z.number().int().min(0).max(240).default(25),
      },
    },
    async (args, extra) => {
      const modelDef = resolveModel(args.model ?? "grok-imagine-video-1-5-preview");
      if (!modelDef || modelDef.type !== "video") {
        return mk(`❌ موديل فيديو غير معروف: ${args.model}. المتاح: grok-imagine-video-1-5-preview`, true);
      }
      const out = await runGeneration({
        modelDef, type: "video", args: args as unknown as Record<string, unknown>,
        prompt: String(args.prompt ?? ""), onProgress: makeProgressCb(extra),
      });
      if (out.state === "no_keys") {
        return mk(`❌ لا توجد مفاتيح نشطة لخدمة ${modelDef.canonical}. أضف مفتاحًا واحدًا على الأقل من واجهة الإدارة، ثم أعد المحاولة.`, true);
      }
      if (out.state === "failed") return mk(out.message || "❌ فشلت المهمة.", true);
      if (out.state === "completed" && out.urls?.length) {
        return mk(`✅ تم توليد الفيديو بنجاح\n\n${out.urls.map((u) => `الرابط المباشر: ${u}`).join("\n")}`);
      }
      return mk(`⏳ المهمة قيد المعالجة — task_id: ${out.taskId}\n\nتابع بـ get_task كل ~10 ثوانٍ حتى تكتمل.`);
    },
  );

  // 3) merge_videos — بلا resolution/fps: خدمة الدمج تثبّت المخرج
  server.registerTool(
    "merge_videos",
    {
      title: "Merge Videos",
      description: TOOL_DESCRIPTIONS.merge_videos,
      inputSchema: {
        urls: z.array(z.string()).min(2).max(10).optional()
          .describe("Public direct video URLs (http/https) in merge order — the first clip starts the final video."),
        task_ids: z.array(z.string()).min(2).max(10).optional()
          .describe("Alternative to urls: task_ids of COMPLETED video generation tasks — their result URLs are merged in this order."),
        wait_seconds: z.number().int().min(0).max(240).default(60),
      },
    },
    async (args, extra) => {
      const out = await runMerge({ args: args as unknown as Record<string, unknown>, onProgress: makeProgressCb(extra) });
      if (out.state === "failed") return mk(out.message || "❌ فشل الدمج.", true);
      if (out.state === "completed" && out.urls?.length) {
        return mk(
          `✅ تم دمج المقاطع بنجاح\n\n${out.urls.map((u) => `الرابط المباشر: ${u}`).join("\n")}\n\n⚠️ ملف الدمج يُحذف من خدمة الدمج بعد ~24 ساعة — شاهده/نزّله سريعًا.`,
        );
      }
      return mk(`⏳ مهمة الدمج قيد المعالجة — task_id: ${out.taskId}\n\nتابع بـ get_task كل ~10 ثوانٍ حتى تكتمل.`);
    },
  );

  // 4) get_task — تتبع أي مهمة (توليد أو دمج) مع تحديث حي
  server.registerTool(
    "get_task",
    {
      title: "Get Task",
      description: TOOL_DESCRIPTIONS.get_task,
      inputSchema: { task_id: z.string().min(1) },
    },
    async (args) => {
      const view = await refreshAndGetTask(String(args.task_id ?? ""));
      return mk(view.text, view.isError);
    },
  );

  // 5) list_media — استرجاع النتائج المخزنة بروابطها (بدون إعادة توليد)
  server.registerTool(
    "list_media",
    {
      title: "List Media",
      description: TOOL_DESCRIPTIONS.list_media,
      inputSchema: {
        type: z.enum(["image", "video", "merge"]).optional(),
        status: z.enum(["completed", "failed", "processing"]).optional(),
        limit: z.number().int().min(1).max(50).default(10),
      },
    },
    async (args) => {
      const rows = await listRecentTasks(args.limit ?? 10, {
        type: args.type as MediaType | undefined,
        status: args.status,
      });
      if (rows.length === 0) return mk("لا توجد وسائط مخزنة بعد — ابدأ بتوليد صورة أو فيديو.");
      const typeName = (t: string) => (t === "image" ? "صورة" : t === "video" ? "فيديو" : "دمج");
      const statusName = (s: string) => (s === "completed" ? "✅ مكتملة" : s === "failed" ? "❌ فاشلة" : "⏳ جارية");
      const lines = rows.map((t, i) => {
        const urls: string[] = (() => { try { const v = JSON.parse(t.result_urls_json || "[]"); return Array.isArray(v) ? v : []; } catch { return []; } })();
        const base = `${i + 1}. [${typeName(t.type)}] ${statusName(t.status)} — task_id: ${t.id}\n   الموديل: ${t.model} — أُنشئت: ${t.created_at} (UTC)`;
        const urlLine = urls.length ? `\n   الرابط: ${urls.join(" | ")}` : "";
        return base + urlLine;
      });
      return mk(`📁 أحدث الوسائط المخزنة (${rows.length}):\n\n${lines.join("\n\n")}`);
    },
  );

  return server;
}
