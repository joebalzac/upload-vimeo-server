import { NextResponse } from "next/server";
import crypto from "crypto";
import { createPending } from "@/lib/uploadStore";

const VIMEO_TOKEN = process.env.VIMEO_TOKEN || "";
const VIMEO_FOLDER_ID = process.env.VIMEO_FOLDER_ID || "";
const DEFAULT_PRIVACY = process.env.VIMEO_DEFAULT_PRIVACY || "unlisted";

// allowlist = host origins only (no paths)
const ALLOWED_ORIGINS = new Set<string>([
  "https://eliseai.com",
  "https://elise-ai-v3-7ffb9f5ea1acd5af317df8c7a1e.webflow.io",
  "http://localhost:3000",
  "http://localhost:5173",
]);

function normalizeOrigin(origin: string | null) {
  if (!origin) return null;
  try {
    // URL constructor will strip paths, query, hash
    return new URL(origin).origin;
  } catch {
    return origin;
  }
}

function corsHeaders(origin: string | null) {
  const normalized = normalizeOrigin(origin);
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "POST, OPTIONS, GET, PUT, PATCH",
    // include TUS-related headers and common ones
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, Tus-Resumable, Upload-Offset, Upload-Length, Upload-Metadata, X-Requested-With",
    "Access-Control-Expose-Headers": "X-Debug-Blocked-Origin",
    Vary: "Origin",
  };

  if (normalized && ALLOWED_ORIGINS.has(normalized)) {
    headers["Access-Control-Allow-Origin"] = normalized;
    // If you rely on credentials (cookies/authorization), uncomment next line:
    // headers["Access-Control-Allow-Credentials"] = "true";
  } else if (!origin) {
    headers["Access-Control-Allow-Origin"] = "*";
  } else {
    headers["X-Debug-Blocked-Origin"] = origin;
  }

  return headers;
}

export async function OPTIONS(req: Request) {
  const origin = req.headers.get("origin");
  console.log("[DEBUG] OPTIONS /api/vimeo/create-upload", { origin });
  return new NextResponse(null, { status: 204, headers: corsHeaders(origin) });
}

export async function POST(req: Request) {
  const origin = req.headers.get("origin");
  console.log("[DEBUG] POST /api/vimeo/create-upload", { origin });

  const headers = corsHeaders(origin);

  if (!VIMEO_TOKEN || !VIMEO_FOLDER_ID) {
    return NextResponse.json(
      {
        error: "Server not configured",
        details:
          "Missing VIMEO_TOKEN or VIMEO_FOLDER_ID in environment variables",
      },
      { status: 500, headers }
    );
  }

  const body = await req.json().catch(() => ({}));
  const { filename, size, name } = body as {
    filename?: string;
    size?: number;
    name?: string;
  };

  if (!size || typeof size !== "number" || Number.isNaN(size) || size <= 0) {
    return NextResponse.json(
      { error: "Missing/invalid size" },
      { status: 400, headers }
    );
  }

  // 1) Create Vimeo video placeholder with tus upload
  const createResp = await fetch("https://api.vimeo.com/me/videos", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${VIMEO_TOKEN}`,
      Accept: "application/vnd.vimeo.*+json;version=3.4",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      upload: { approach: "tus", size },
      name: name || filename || "User submission",
      privacy: { view: DEFAULT_PRIVACY },
    }),
  });

  if (!createResp.ok) {
    const text = await createResp.text().catch(() => "");
    return NextResponse.json(
      { error: "Failed to create Vimeo upload", details: text },
      { status: createResp.status, headers }
    );
  }

  const created: any = await createResp.json().catch(() => null);
  const uploadLink: string | undefined = created?.upload?.upload_link;
  const videoUri: string | undefined = created?.uri; // e.g. "/videos/123"
  const videoId = (videoUri || "").split("/").pop();

  if (!uploadLink || !videoUri || !videoId) {
    return NextResponse.json(
      {
        error: "Vimeo response missing upload_link/video id",
        details: JSON.stringify({
          uploadLink: !!uploadLink,
          videoUri: !!videoUri,
          videoId: !!videoId,
        }),
      },
      { status: 500, headers }
    );
  }

  // 2) Best-effort: add video to folder (do not block upload if it fails)
  let folder_add_ok = false;
  try {
    const addToFolderResp = await fetch(
      `https://api.vimeo.com/me/folders/${VIMEO_FOLDER_ID}/videos/${videoId}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${VIMEO_TOKEN}`,
          Accept: "application/vnd.vimeo.*+json;version=3.4",
        },
      }
    );
    folder_add_ok = addToFolderResp.ok;
  } catch (err) {
    console.warn("[WARN] add-to-folder failed (non-blocking):", err);
  }

  // 3) Option C: create a pending token + store "pending upload" record
  const pending_token = crypto.randomBytes(24).toString("hex");
  const created_at = new Date().toISOString();

  try {
    await createPending({
      pending_token,
      video_id: String(videoId),
      video_uri: String(videoUri),
      video_url: `https://vimeo.com/${videoId}`,
      status: "pending",
      created_at,
    });
  } catch (err) {
    // If storage fails, we still return upload link (so user isn't blocked),
    // but Option C cleanup won't work for this upload.
    console.warn(
      "[WARN] createPending failed (Option C disabled for this upload):",
      err
    );
  }

  return NextResponse.json(
    {
      upload_link: uploadLink,
      video_id: videoId,
      video_uri: videoUri,
      video_url: `https://vimeo.com/${videoId}`,
      folder_add_ok,
      privacy: DEFAULT_PRIVACY,

      // NEW
      pending_token,
    },
    { status: 200, headers }
  );
}
