import type { NextApiRequest, NextApiResponse } from "next";

const VIMEO_TOKEN = process.env.VIMEO_TOKEN!;
const VIMEO_FOLDER_ID = process.env.VIMEO_FOLDER_ID!;
const DEFAULT_PRIVACY = process.env.VIMEO_DEFAULT_PRIVACY || "unlisted";

function vimeoHeaders() {
  return {
    Authorization: `Bearer ${VIMEO_TOKEN}`,
    Accept: "application/vnd.vimeo.*+json;version=3.4",
    "Content-Type": "application/json",
  };
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  if (req.method !== "POST")
    return res.status(405).json({ error: "Method not allowed" });
  if (!VIMEO_TOKEN || !VIMEO_FOLDER_ID)
    return res.status(500).json({ error: "Server not configured" });

  const { filename, size, name } = req.body || {};
  if (!size || typeof size !== "number")
    return res.status(400).json({ error: "Missing/invalid size" });

  // 1) Create a Vimeo video placeholder with tus upload approach
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

  const created = await createResp.json();
  const uploadLink = created?.upload?.upload_link;
  const videoUri = created?.uri;
  const videoId = (videoUri || "").split("/").pop();

  if (!uploadLink || !videoId) {
    return res
      .status(500)
      .json({ error: "Vimeo response missing upload_link/video id" });
  }

  // 2) Add video to your folder
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

  // Vimeo share URL pattern (works for unlisted too; Vimeo adds a hash when truly unlisted)
  const videoUrl = `https://vimeo.com/${videoId}`;

  return res.status(200).json({
    upload_link: uploadLink,
    video_id: videoId,
    video_uri: videoUri,
    video_url: videoUrl,
    folder_add_ok: addToFolderResp.ok,
  });
}
