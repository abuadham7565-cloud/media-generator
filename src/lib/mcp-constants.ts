// ثوابت خادم MCP — معلومات السيرفر وتعليماته وأوصاف الأدوات (بالعربية في النتائج، والوصف بالإنجليزية ليفهمها العميل)

export const SERVER_INFO = { name: "media-generator-mcp", version: "1.2.0" } as const;

export const SERVER_INSTRUCTIONS = `AI media generation server (kie.ai + CometAPI with automatic sequential multi-key failover, plus video merging).
Workflow: call generate_image or generate_video. If the response contains finished URLs, show them to the user.
If it returns a task_id with status PROCESSING, call get_task with that task_id every ~10 seconds until status is completed (show the URL) or failed (explain why).
IMPORTANT: the server automatically switches API keys in strict order on any failure (exhausted balance, invalid key, rate limits) and continues the SAME task under the same task_id — you will never encounter key/balance errors. Never stop or warn the user about keys or balances; just keep polling get_task until the result appears.
To concatenate several finished clips into one video, call merge_videos with 'urls' (direct links) or 'task_ids' (completed video tasks, in merge order); track it with get_task the same way. Note: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.
Use list_media to recall previously generated media from the database.`;

export const TOOL_DESCRIPTIONS = {
  generate_image:
    "Generate an image with gpt-image-2-6/flare-text-to-image (automatic failover across all active API keys). Returns the finished image URL if it completes within the wait window; otherwise returns a task_id — call get_task with it every ~10 seconds until completed, then show the URL and stop.",
  generate_video:
    "Generate a video with grok-imagine-video-1-5-preview (native synchronized audio — dialogue/effects/music; optional image-to-video). Video takes minutes: a short wait streams progress, then a task_id is returned — track it with get_task every ~10 seconds.",
  merge_videos:
    'Merge several clips into ONE final video in the given order. Pass "urls" (public direct video links — e.g. links from generate_video) or "task_ids" (completed video generation tasks — their result URLs are resolved from the database in this order — ideal after generating several clips). Merging is usually fast: a short wait streams progress, then a merge task_id — track it with get_task. NOTE: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.',
  get_task:
    "Track any task by its id — image/video generation AND merging (reads the Turso database and refreshes live from the provider/merging service while in progress). Poll every ~10 seconds; when completed you will find the result URLs — show them to the user and stop polling.",
  list_media:
    "Latest images/videos/merges stored with their URLs from the database (no regeneration) — to recall previous results.",
} as const;
