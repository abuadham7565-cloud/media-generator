// سجل الموديلات — موديلان مدمجان مثبّتان كما هما، وقابلان للتجاوز بمتغيرات البيئة
import type { ModelDef } from "./types";

const envOr = (v: string | undefined, dflt: string) => (v && v.trim() ? v.trim() : dflt);

export const MODELS: ModelDef[] = [
  {
    canonical: "gpt-image-2-6/flare-text-to-image",
    aliases: ["gpt-image-2.6/flare-text-to-image", "gpt-image-2-6 flare-text-to-image", "gpt-image-2.6 flare-text-to-image"],
    type: "image",
    providers: ["kie", "cometapi"],
    providerModel: {
      kie: envOr(process.env.KIE_IMAGE_MODEL, "gpt-image-2-6/flare-text-to-image"),
      cometapi: envOr(process.env.COMETAPI_IMAGE_MODEL, "gpt-image-2.6-flare-text-to-image"),
    },
  },
  {
    canonical: "grok-imagine-video-1-5-preview",
    aliases: ["grok-imagine-video-1.5-preview", "grok-imagine-video-1-5 preview", "grok-imagine-video-1.5 preview"],
    type: "video",
    providers: ["kie", "cometapi"],
    providerModel: {
      kie: envOr(process.env.KIE_VIDEO_MODEL, "grok-imagine-video-1-5-preview"),
      cometapi: envOr(process.env.COMETAPI_VIDEO_MODEL, "grok-imagine-video-1-5-preview"),
    },
  },
];

// توحيد الاسم: أحرف صغيرة + النقاط إلى شرطات + حذف الفراغات — لقبول الصيغ البديلة
const normalize = (s: string) => s.trim().toLowerCase().replace(/\./g, "-").replace(/\s+/g, "");

export function resolveModel(input: string): ModelDef | null {
  if (!input) return null;
  const n = normalize(input);
  for (const m of MODELS) {
    if (normalize(m.canonical) === n) return m;
    if (m.aliases.some((a) => normalize(a) === n)) return m;
  }
  return null;
}
