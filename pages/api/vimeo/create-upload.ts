import type { NextApiRequest, NextApiResponse } from "next";

const VIMEO_TOKEN = process.env.VIMEO_TOKEN || "";
const VIMEO_FOLDER_ID = process.env.VIMEO_FOLDER_ID || "";
const DEFAULT_PRIVACY = process.env.VIMEO_DEFAULT_PRIVACY || "unlisted";

/**
 * Allowed front-end origins — update if you add domains later.
 */
const ALLOWED_ORIGINS = new Set<string>([
  "https://eliseai.com",
  "https://elise-ai-v3-7ffb9f5ea1acd5af317df8c7a1e.webflow.io",
  "https://upload-vimeo-server.vercel.app", // your backend frontend (if used)
  "http://localhost:5173",
  "http://localhost:3000",
]);

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
  // CORS & preflight
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();

  // Only POST for real work
  if (req.method !== "POST")
    return res.status(405).json({ error: "Method not allowed" });

  // Env check
  if (!VIMEO_TOKEN || !VIMEO_FOLDER_ID) {
    return res.status(500).json({
      error: "Server not configured",
      details: "Missing VIMEO_TOKEN or VIMEO_FOLDER_ID",
    });
  }

  try {
    const { filename, size, name } = (req.body || {}) as {
      filename?: string;
      size?: number;
      name?: string;
    };

    if (!size || typeof size !== "number" || Number.isNaN(size) || size <= 0) {
      return res.status(400).json({ error: "Missing/invalid size" });
    }

    // Create the Vimeo upload (tus)
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
      const details = await createResp.text();
      return res
        .status(createResp.status)
        .json({ error: "Failed to create Vimeo upload", details });
    }

    const created: any = await createResp.json();
    const uploadLink: string | undefined = created?.upload?.upload_link;
    const videoUri: string | undefined = created?.uri;
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

    // Best-effort: add to folder
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
    return res
      .status(500)
      .json({ error: "Server error", details: String(e?.message || e) });
  }
}
