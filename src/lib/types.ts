// أنواع مشتركة للمشروع — تُستخدم في طبقات قاعدة البيانات والمفاتيح والمزودين والمنسّق

export type ProviderId = "kie" | "cometapi";
export type TaskProvider = ProviderId | "merger";
export type MediaType = "image" | "video" | "merge";
export type ErrorClass = "disabled" | "exhausted" | "provider" | "params" | "temporary";

// تعريف موديل في السجل: الاسم القانوني + الصيغ البديلة + المزودون الذين يخدمونه
export interface ModelDef {
  canonical: string;          // الاسم كما يراه عميل MCP
  aliases: string[];          // صيغ بديلة نقبلها ونوحّدها (شرطات/نقاط)
  type: MediaType;
  providers: ProviderId[];    // تُجرَّب مفاتيحهم كلها بالترتيب التسلسلي
  providerModel: Record<ProviderId, string>; // اسم الموديل كما يُرسل لكل مزود
}

// صف مفتاح من قاعدة البيانات (داخلي — لا يخرج أبدًا إلا مُقنَّعًا)
export interface ProviderKeyRow {
  id: string;
  provider: ProviderId;
  label: string;
  api_key: string;
  status: string; // active | exhausted | disabled
  usage_count: number;
  success_count: number;
  fail_count: number;
  last_used_at: string | null;
  last_checked_at: string | null;
  last_error: string | null;
  created_at: string;
}

// محاولة واحدة مسجلة في attempts_json
export interface AttemptRecord {
  provider: string;
  keyId: string;
  keyLabel: string;
  ok: boolean;
  errorClass: ErrorClass | null;
  error: string | null;
  at: string;
}

// صف مهمة
export interface TaskRow {
  id: string;                  // task_id الذي يراه العميل
  provider: TaskProvider | null;
  provider_task_id: string | null;
  key_id: string | null;
  model: string;
  type: MediaType;
  prompt: string;
  params_json: string;
  status: string;              // pending | processing | completed | failed
  progress: number;            // 0..100
  result_urls_json: string | null;
  error_message: string | null;
  attempts_json: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

// خطأ من مزود خارجي — يُصنَّف لاحقًا في classifyProviderError
export class ProviderError extends Error {
  constructor(public status: number | null, message: string) {
    super(message);
    this.name = "ProviderError";
  }
}
