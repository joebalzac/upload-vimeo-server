import type { NextApiRequest, NextApiResponse } from "next";

const VIMEO_TOKEN = process.env.VIMEO_TOKEN || "";
const VIMEO_FOLDER_ID = process.env.VIMEO_FOLDER_ID || "";
const DEFAULT_PRIVACY = process.env.VIMEO_DEFAULT_PRIVACY || "unlisted";

/**
 * ✅ Set these to your actual allowed frontend origins.
 * Webflow examples:
 * - https://www.yoursite.com
 * - https://yoursite.webflow.io (staging)
 */
const ALLOWED_ORIGINS = new Set<string>([
  "https://eliseai.com",
  "https://elise-ai-v3-7ffb9f5ea1acd5af317df8c7a1e.webflow.io",
  "http://localhost:3000",
  "http://localhost:5173",
]);

function setCors(req: NextApiRequest, res: NextApiResponse) {
  const origin = (req.headers.origin || "") as string;

  // If origin is present and allowed, echo it back.
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  } else if (!origin) {
    // No origin (likely server-to-server); allow by default for server requests.
    res.setHeader("Access-Control-Allow-Origin", "*");
  } else {
    // Origin present but not in allowlist — do not set ACAO (will block browser requests).
    console.warn("[CORS] Request origin not in ALLOWED_ORIGINS:", origin);
    // For visibility while debugging, also include a header that we can inspect in logs.
    res.setHeader("X-Debug-Blocked-Origin", origin);
  }

  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  // Expose any headers you later want the browser to read
  res.setHeader("Access-Control-Expose-Headers", "X-Debug-Blocked-Origin");
}

function vimeoHeaders() {
  return {
    Authorization: `Bearer ${VIMEO_TOKEN}`,
    Accept: "application/vnd.vimeo.*+json;version=3.4",
    "Content-Type": "application/json",
  };
}

type ErrorResponse = { error: string; details?: string };
type SuccessResponse = {
  upload_link: string;
  video_id: string;
  video_uri: string;
  video_url: string;
  folder_add_ok: boolean;
  privacy: string;
};

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<SuccessResponse | ErrorResponse>,
) {
  // Per-request debug log (will appear in Vercel function logs)
  console.log("[DEBUG] /api/vimeo/create-upload incoming", {
    time: new Date().toISOString(),
    method: req.method,
    origin: req.headers.origin,
    url: req.url,
  });

  // For extra visibility: log whether env vars exist (masked)
  console.log("[DEBUG] env presence", {
    VIMEO_TOKEN_present: !!VIMEO_TOKEN,
    VIMEO_FOLDER_ID_present: !!VIMEO_FOLDER_ID,
    // don't log the token contents
  });

  // ✅ CORS for browser-based frontends (Webflow/React)
  setCors(req, res);

  // ✅ Preflight for CORS
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  // ✅ Method check
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // ✅ Env var sanity
  if (!VIMEO_TOKEN || !VIMEO_FOLDER_ID) {
    console.error("[ERROR] Missing env vars VIMEO_TOKEN or VIMEO_FOLDER_ID");
    return res.status(500).json({
      error: "Server not configured",
      details:
        "Missing VIMEO_TOKEN or VIMEO_FOLDER_ID in environment variables",
    });
  }

  try {
    const { filename, size, name } = (req.body || {}) as {
      filename?: string;
      size?: number;
      name?: string;
    };

    // ✅ Basic validation
    if (!size || typeof size !== "number" || Number.isNaN(size) || size <= 0) {
      return res.status(400).json({ error: "Missing/invalid size" });
    }

    // 1) Create Vimeo video placeholder with tus upload
    const createResp = await fetch("https://api.vimeo.com/me/videos", {
      method: "POST",
      headers: vimeoHeaders(),
      body: JSON.stringify({
        upload: { approach: "tus", size },
        name: name || filename || "User submission",
        privacy: { view: DEFAULT_PRIVACY },
      }),
    });

    if (!createResp.ok) {
      const text = await createResp.text();
      console.error("[ERROR] Vimeo create failed:", createResp.status, text);
      return res
        .status(createResp.status)
        .json({ error: "Failed to create Vimeo upload", details: text });
    }

    const created: any = await createResp.json();
    // Log the important parts of the Vimeo response for debugging (avoid huge dumps)
    console.log("[DEBUG] Vimeo create response keys:", Object.keys(created));

    const uploadLink: string | undefined = created?.upload?.upload_link;
    const videoUri: string | undefined = created?.uri; // e.g. "/videos/123"
    const videoId = (videoUri || "").split("/").pop();

    if (!uploadLink || !videoUri || !videoId) {
      console.error("[ERROR] Vimeo response missing fields", {
        uploadLink: !!uploadLink,
        videoUri: !!videoUri,
        videoId: !!videoId,
      });
      return res.status(500).json({
        error: "Vimeo response missing upload_link/video id",
        details: JSON.stringify({
          uploadLink: !!uploadLink,
          videoUri: !!videoUri,
          videoId: !!videoId,
        }),
      });
    }

    // 2) Best-effort: add video to folder (do not block upload if it fails)
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

    // Note: truly "unlisted" URLs may include a hash in some contexts.
    // For your flow, storing video_id + video_uri is the reliable identifier.
    const videoUrl = `https://vimeo.com/${videoId}`;

    // Return the upload link and metadata to the frontend
    return res.status(200).json({
      upload_link: uploadLink,
      video_id: videoId,
      video_uri: videoUri,
      video_url: videoUrl,
      folder_add_ok: addToFolderResp.ok,
      privacy: DEFAULT_PRIVACY,
    });
  } catch (e: any) {
    console.error("[ERROR] handler caught", e);
    return res.status(500).json({
      error: "Server error",
      details: String(e?.message || e),
    });
  }
}
