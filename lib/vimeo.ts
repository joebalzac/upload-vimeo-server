// lib/vimeo.ts
const VIMEO_TOKEN = process.env.VIMEO_TOKEN || "";
const DEFAULT_PRIVACY = process.env.VIMEO_DEFAULT_PRIVACY || "unlisted";

function vimeoHeaders() {
  if (!VIMEO_TOKEN) throw new Error("Missing VIMEO_TOKEN");
  return {
    Authorization: `Bearer ${VIMEO_TOKEN}`,
    Accept: "application/vnd.vimeo.*+json;version=3.4",
  };
}

export async function vimeoCreateTusUpload(args: {
  size: number;
  name: string;
}) {
  const resp = await fetch("https://api.vimeo.com/me/videos", {
    method: "POST",
    headers: {
      ...vimeoHeaders(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      upload: { approach: "tus", size: args.size },
      name: args.name,
      privacy: { view: DEFAULT_PRIVACY },
    }),
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`Vimeo create failed ${resp.status}: ${txt}`);
  }

  const created: any = await resp.json();
  const upload_link: string | undefined = created?.upload?.upload_link;
  const video_uri: string | undefined = created?.uri; // "/videos/123"
  const video_id = (video_uri || "").split("/").pop();

  if (!upload_link || !video_uri || !video_id) {
    throw new Error("Vimeo response missing upload_link/video id");
  }

  return {
    upload_link,
    video_id,
    video_uri,
    video_url: `https://vimeo.com/${video_id}`,
    privacy: DEFAULT_PRIVACY,
  };
}

export async function vimeoAddToFolder(args: {
  folderId: string;
  videoId: string;
}) {
  const resp = await fetch(
    `https://api.vimeo.com/me/folders/${args.folderId}/videos/${encodeURIComponent(args.videoId)}`,
    { method: "PUT", headers: vimeoHeaders() }
  );
  return resp.ok;
}

/**
 * Delete a Vimeo video.
 * Returns status/body so callers can log/decide whether to mark deleted in Redis.
 * Treats 204 (deleted) and 404 (already gone) as success.
 */
export async function vimeoDeleteVideo(videoId: string) {
  const resp = await fetch(
    `https://api.vimeo.com/videos/${encodeURIComponent(videoId)}`,
    { method: "DELETE", headers: vimeoHeaders() }
  );

  const body = await resp.text().catch(() => "");

  if (resp.status === 204 || resp.status === 404) {
    return { ok: true, status: resp.status, body };
  }

  return { ok: false, status: resp.status, body };
}

/**
 * Debug helper: tells you which Vimeo user/account this token belongs to.
 * Safe to log status + a small snippet of body.
 */
export async function vimeoWhoAmI() {
  const resp = await fetch("https://api.vimeo.com/me", {
    method: "GET",
    headers: vimeoHeaders(),
  });

  const body = await resp.text().catch(() => "");
  return { ok: resp.ok, status: resp.status, body };
}
