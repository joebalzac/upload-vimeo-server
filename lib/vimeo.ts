export async function vimeoDeleteVideo(videoId: string) {
  const token = process.env.VIMEO_ACCESS_TOKEN;
  if (!token) throw new Error("Missing VIMEO_ACCESS_TOKEN");

  const resp = await fetch(
    `https://api.vimeo.com/videos/${encodeURIComponent(videoId)}`,
    {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.vimeo.*+json;version=3.4",
      },
    }
  );

  // Vimeo delete returns 204 typically. 404 is fine if already gone.
  if (!resp.ok && resp.status !== 404) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`Vimeo delete failed ${resp.status}: ${txt}`);
  }
}
