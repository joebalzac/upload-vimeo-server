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

// temporary debug — do NOT commit to client-side code or keep long-term
console.log("ENV debug -- VIMEO_TOKEN present:", !!process.env.VIMEO_TOKEN);
console.log(
  "ENV debug -- VIMEO_FOLDER_ID present:",
  !!process.env.VIMEO_FOLDER_ID,
);

// optional: log lengths only (still be careful with logs retention)
console.log(
  "ENV debug -- VIMEO_TOKEN length:",
  process.env.VIMEO_TOKEN ? process.env.VIMEO_TOKEN.length : 0,
);

function setCors(req: NextApiRequest, res: NextApiResponse) {
  const origin = req.headers.origin || "";
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
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

    // Optional guardrails (you can tune/remove)
    // const MAX_BYTES = 100 * 1024 * 1024; // 100MB
    // if (size > MAX_BYTES) return res.status(400).json({ error: "File too large" });

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
      return res
        .status(createResp.status)
        .json({ error: "Failed to create Vimeo upload", details: text });
    }

    const created: any = await createResp.json();
    const uploadLink: string | undefined = created?.upload?.upload_link;
    const videoUri: string | undefined = created?.uri; // e.g. "/videos/123"
    const videoId = (videoUri || "").split("/").pop();

    if (!uploadLink || !videoUri || !videoId) {
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

    return res.status(200).json({
      upload_link: uploadLink,
      video_id: videoId,
      video_uri: videoUri,
      video_url: videoUrl,
      folder_add_ok: addToFolderResp.ok,
      privacy: DEFAULT_PRIVACY,
    });
  } catch (e: any) {
    return res.status(500).json({
      error: "Server error",
      details: String(e?.message || e),
    });
  }
}
