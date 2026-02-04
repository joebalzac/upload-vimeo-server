// app/api/vimeo/create-upload/route.ts
import { NextResponse } from "next/server";
import crypto from "crypto";
import { storePendingUpload } from "@/lib/uploadStore";
import { vimeoAddToFolder, vimeoCreateTusUpload } from "@/lib/vimeo";

const VIMEO_FOLDER_ID = process.env.VIMEO_FOLDER_ID || "";

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
    return new URL(origin).origin;
  } catch {
    return origin;
  }
}

function corsHeaders(origin: string | null) {
  const normalized = normalizeOrigin(origin);
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "POST, OPTIONS, GET, PUT, PATCH",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, Tus-Resumable, Upload-Offset, Upload-Length, Upload-Metadata, X-Requested-With",
    "Access-Control-Expose-Headers": "X-Debug-Blocked-Origin",
    Vary: "Origin",
  };

  if (normalized && ALLOWED_ORIGINS.has(normalized)) {
    headers["Access-Control-Allow-Origin"] = normalized;
  } else if (!origin) {
    headers["Access-Control-Allow-Origin"] = "*";
  } else {
    headers["X-Debug-Blocked-Origin"] = origin;
  }

  return headers;
}

export async function OPTIONS(req: Request) {
  const origin = req.headers.get("origin");
  return new NextResponse(null, { status: 204, headers: corsHeaders(origin) });
}

export async function POST(req: Request) {
  const origin = req.headers.get("origin");
  const headers = corsHeaders(origin);

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

  try {
    // 1) Create Vimeo upload placeholder (server-side)
    const created = await vimeoCreateTusUpload({
      size,
      name: name || filename || "User submission",
    });

    // 2) Best-effort: add to folder/project
    let folder_add_ok = false;
    if (VIMEO_FOLDER_ID) {
      folder_add_ok = await vimeoAddToFolder({
        folderId: VIMEO_FOLDER_ID,
        videoId: created.video_id,
      });
    }

    // 3) Store pending record for cleanup
    const pending_token = crypto.randomBytes(24).toString("hex");
    await storePendingUpload({
      pending_token,
      video_id: created.video_id,
      created_at: new Date().toISOString(),
    });

    return NextResponse.json(
      { ...created, folder_add_ok, pending_token },
      { status: 200, headers }
    );
  } catch (err: any) {
    return NextResponse.json(
      { error: "Failed to create Vimeo upload", details: String(err?.message || err) },
      { status: 500, headers }
    );
  }
}
