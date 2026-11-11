// خادم MCP على المسار /mcp — نقل Streamable HTTP حسب مواصفات MCP
// نستخدم SDK الرسمي: McpServer + StreamableHTTPServerTransport — بلا JSON-RPC يدوي.
//
// جسر Node↔Web: الـ SDK الرسمي يتعامل مع req/res من node:http، بينما Next.js App Router
// يمنحنا Web Request/Response. الجسر هنا يحوّل الطلب إلى IncomingMessage ويجمع مخرجات
// ServerResponse في ReadableStream (بتدفق حي) لبناء Web Response — مع دعم جلسات SSE.
import { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildMcpServer } from "@/lib/mcp-server";
import { ensureSchema } from "@/lib/turso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// استدعاءات الأدوات قد تمتد حتى 240 ثانية انتظارًا — ارفع حد الدالة على Vercel
export const maxDuration = 300;

type SessionEntry = { transport: StreamableHTTPServerTransport };
const g = globalThis as unknown as { __mcpSessions?: Map<string, SessionEntry> };
const sessions = g.__mcpSessions ?? (g.__mcpSessions = new Map<string, SessionEntry>());

// حماية اختيارية: إن ضُبط MCP_ACCESS_TOKEN يُطلب Authorization: Bearer <token>
function bearerOk(req: Request): boolean {
  const token = process.env.MCP_ACCESS_TOKEN;
  if (!token) return true;
  return (req.headers.get("authorization") || "") === `Bearer ${token}`;
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id, mcp-session-id, Last-Event-ID",
  "Access-Control-Expose-Headers": "Mcp-Session-Id, mcp-session-id",
};

function jsonRpcError(status: number, code: number, message: string): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

// تحويل Web Request إلى IncomingMessage بجسم جاهز (حلّلنا الجسم مرة واحدة فقط)
// ملاحظة: الـ SDK (1.32) يمر عبر @hono/node-server الذي يقرأ rawHeaders و socket
// و method/url — لذلك نزوّدها كلها يدويًا على الكائن المحوَّل.
function toNodeRequest(req: Request, rawBody: string | null): IncomingMessage {
  const url = new URL(req.url);
  const headers: Record<string, string> = {};
  const rawHeaders: string[] = [];
  req.headers.forEach((v, k) => {
    headers[k] = v;
    for (const part of v.split(", ")) {
      rawHeaders.push(k, part);
    }
  });
  const body = rawBody !== null ? Readable.from([Buffer.from(rawBody, "utf8")]) : Readable.from([]);
  const nodeReq = body as unknown as IncomingMessage;
  nodeReq.headers = headers;
  (nodeReq as unknown as { rawHeaders: string[] }).rawHeaders = rawHeaders;
  nodeReq.method = req.method;
  nodeReq.url = url.pathname + url.search;
  (nodeReq as unknown as { socket: unknown }).socket = { remoteAddress: "127.0.0.1", remotePort: 0 };
  return nodeReq;
}

// تنفيذ الطلب عبر النقل الرسمي مع بث المخرجات إلى Web Response حيًّا
async function runTransport(req: Request, transport: StreamableHTTPServerTransport, rawBody: string | null): Promise<Response> {
  const nodeReq = toNodeRequest(req, rawBody);

  let status = 200;
  let headSent = false;
  const resHeaders: Record<string, string | string[]> = {};
  let resolveHead!: () => void;
  const headPromise = new Promise<void>((r) => { resolveHead = r; });
  const markHead = (code: number) => {
    status = code;
    if (!headSent) { headSent = true; resolveHead(); }
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const nodeRes = new ServerResponse(nodeReq);

      // التقاط الترويسات المكتوبة عبر setHeader/writeHead لإعادة بنائها في Web Response
      const origSetHeader = nodeRes.setHeader.bind(nodeRes);
      nodeRes.setHeader = (name: string, value: number | string | readonly string[]) => {
        resHeaders[name.toLowerCase()] = value as string | string[];
        return origSetHeader(name, value);
      };
      const origWriteHead = nodeRes.writeHead.bind(nodeRes);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      nodeRes.writeHead = ((code: any, ...rest: any[]) => {
        markHead(Number(code));
        for (const r of rest) {
          if (r && typeof r === "object" && !Array.isArray(r)) {
            for (const [k, v] of Object.entries(r as Record<string, unknown>)) {
              if (v != null) resHeaders[k.toLowerCase()] = v as string;
            }
          }
        }
        return (origWriteHead as (...a: any[]) => unknown)(code, ...rest);
      }) as typeof nodeRes.writeHead;

      const enc = new TextEncoder();
      const push = (chunk: unknown) => {
        try {
          if (chunk == null) return;
          const bytes = typeof chunk === "string" ? enc.encode(chunk) : chunk instanceof Uint8Array ? chunk : enc.encode(String(chunk));
          controller.enqueue(bytes);
        } catch { /* انتهى التدفق */ }
        if (!headSent) markHead(200);
      };
      const origWrite = nodeRes.write.bind(nodeRes) as typeof nodeRes.write;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      nodeRes.write = ((chunk: any, ...rest: any[]) => { push(chunk); return origWrite(chunk, ...rest); }) as typeof nodeRes.write;
      const origEnd = nodeRes.end.bind(nodeRes) as typeof nodeRes.end;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      nodeRes.end = ((chunk?: any, ...rest: any[]) => {
        push(chunk);
        queueMicrotask(() => { try { controller.close(); } catch { /* مقفول */ } });
        return origEnd(chunk, ...rest);
      }) as typeof nodeRes.end;
      nodeRes.on("close", () => { try { controller.close(); } catch { /* مقفول */ } });

      // التنفيذ الفعلي عبر SDK — الأخطاء تُعالج داخليًا بكتابة استجابة JSON-RPC
      transport
        .handleRequest(nodeReq, nodeRes)
        .catch((e) => {
          console.error("[mcp] handleRequest failed:", e);
          markHead(500);
          try { controller.close(); } catch { /* مقفول */ }
        });
    },
    cancel() { /* إلغاء العميل — النقل يعالج الإغلاق بنفسه */ },
  });

  await headPromise;

  const headers = new Headers();
  for (const [k, v] of Object.entries(resHeaders)) {
    if (v != null) headers.set(k, Array.isArray(v) ? v.join(", ") : String(v));
  }
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  return new Response(stream, { status, headers });
}

function getTransportById(sessionId: string): SessionEntry | undefined {
  return sessions.get(sessionId);
}

async function createSession(): Promise<SessionEntry> {
  // جلسة حية لكل عميل: نقل + خادم بأدواته الخمس يُربطان فورًا حتى يجيب initialize
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sid) => { sessions.set(sid, entry); },
    onsessionclosed: (sid) => { sessions.delete(sid); },
  });
  const entry: SessionEntry = { transport };
  const server = buildMcpServer();
  await server.connect(transport);
  return entry;
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function POST(req: Request) {
  if (!bearerOk(req)) return jsonRpcError(401, -32001, "Unauthorized: مطلوب Authorization: Bearer <MCP_ACCESS_TOKEN>");
  await ensureSchema();

  // حلّل الجسم مرة واحدة — نقرأ method لتحديد الجلسة ثم نمرره للـ SDK كparsedBody
  const raw = await req.text();
  let parsed: Record<string, unknown> | undefined;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return jsonRpcError(400, -32700, "Parse error: JSON غير صالح");
  }

  const sessionId = req.headers.get("mcp-session-id") || req.headers.get("Mcp-Session-Id");
  const method = String(parsed?.method ?? "");

  let entry: SessionEntry | undefined;
  if (sessionId) {
    entry = getTransportById(sessionId);
    if (!entry) return jsonRpcError(404, -32001, "Session not found: الجلسة غير موجودة أو انتهت — أعد التهيئة initialize");
  } else if (method === "initialize") {
    entry = await createSession();
  } else {
    return jsonRpcError(400, -32000, "Bad Request: أرسل initialize أولًا للحصول على mcp-session-id");
  }

  return runTransport(req, entry.transport, raw);
}

export async function GET(req: Request) {
  if (!bearerOk(req)) return jsonRpcError(401, -32001, "Unauthorized: مطلوب Authorization: Bearer <MCP_ACCESS_TOKEN>");
  // قناة SSE منفصلة من السيرفر للعميل (اختيارية في المواصفة)
  const sessionId = req.headers.get("mcp-session-id") || req.headers.get("Mcp-Session-Id");
  const entry = sessionId ? getTransportById(sessionId) : undefined;
  if (!entry) return jsonRpcError(404, -32001, "Session not found: لا توجد جلسة بهذا المعرف");
  return runTransport(req, entry.transport, null);
}

export async function DELETE(req: Request) {
  if (!bearerOk(req)) return jsonRpcError(401, -32001, "Unauthorized: مطلوب Authorization: Bearer <MCP_ACCESS_TOKEN>");
  // إنهاء الجلسة صراحةً
  const sessionId = req.headers.get("mcp-session-id") || req.headers.get("Mcp-Session-Id");
  const entry = sessionId ? getTransportById(sessionId) : undefined;
  if (!entry) return jsonRpcError(404, -32001, "Session not found: لا توجد جلسة بهذا المعرف");
  try {
    await entry.transport.close();
  } finally {
    sessions.delete(sessionId as string);
  }
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
