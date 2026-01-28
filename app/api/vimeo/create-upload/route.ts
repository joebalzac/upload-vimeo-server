import { NextResponse } from "next/server";

const VIMEO_TOKEN = process.env.VIMEO_TOKEN || "";
const VIMEO_FOLDER_ID = process.env.VIMEO_FOLDER_ID || "";
const DEFAULT_PRIVACY = process.env.VIMEO_DEFAULT_PRIVACY || "unlisted";

const ALLOWED_ORIGINS = new Set<string>([
  "https://eliseai.com/innovators-club",
  "https://elise-ai-v3-7ffb9f5ea1acd5af317df8c7a1e.webflow.io/innovators-club",
  "http://localhost:3000",
  "http://localhost:5173",
]);

function corsHeaders(origin: string | null) {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Expose-Headers": "X-Debug-Blocked-Origin",
    "Vary": "Origin",
  };

  if (origin && ALLOWED_ORIGINS.has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  } else if (!origin) {
    // server-to-server / non-browser
    headers["Access-Control-Allow-Origin"] = "*";
  } else {
    // browser origin not allowed
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
        details: "Missing VIMEO_TOKEN or VIMEO_FOLDER_ID in environment variables",
      },
      { status: 500, headers },
    );
  }

  const body = await req.json().catch(() => ({}));
  const { filename, size, name } = body as {
    filename?: string;
    size?: number;
    name?: string;
  };

  if (!size || typeof size !== "number" || Number.isNaN(size) || size <= 0) {
    return NextResponse.json({ error: "Missing/invalid size" }, { status: 400, headers });
  }

  // 1. Create Vimeo video placeholder with tus upload
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
    const text = await createResp.text();
    return NextResponse.json(
      { error: "Failed to create Vimeo upload", details: text },
      { status: createResp.status, headers },
    );
  }

  const created: any = await createResp.json();
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
      { status: 500, headers },
    );
  }

  // 2. Best-effort: add video to folder (do not block upload if it fails)
  const addToFolderResp = await fetch(
    `https://api.vimeo.com/me/folders/${VIMEO_FOLDER_ID}/videos/${videoId}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${VIMEO_TOKEN}`,
        Accept: "application/vnd.vimeo.*+json;version=3.4",
      },
    },
  );

  return NextResponse.json(
    {
      upload_link: uploadLink,
      video_id: videoId,
      video_uri: videoUri,
      video_url: `https://vimeo.com/${videoId}`,
      folder_add_ok: addToFolderResp.ok,
      privacy: DEFAULT_PRIVACY,
    },
    { status: 200, headers },
  );
}
