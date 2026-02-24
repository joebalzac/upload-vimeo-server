// app/api/vimeo/folder-videos/route.ts
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const VIMEO_TOKEN  = process.env.VIMEO_TOKEN!;
const FOLDER_ID   = process.env.VIMEO_FOLDER_ID!;

const FIELDS = [
  "uri",
  "name",
  "duration",
  "created_time",
  "pictures",
  "embed",
].join(",");

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() });
}

export async function GET(req: Request) {
  const headers = corsHeaders();

  if (!VIMEO_TOKEN || !FOLDER_ID) {
    return NextResponse.json(
      { error: "Missing VIMEO_ACCESS_TOKEN or VIMEO_FOLDER_ID env vars" },
      { status: 500, headers }
    );
  }

  const url    = new URL(req.url);
  const page   = Math.max(1, Number(url.searchParams.get("page")   || 1));
  const perPage = Math.min(48, Math.max(1, Number(url.searchParams.get("per_page") || 12)));

  const vimeoUrl =
    `https://api.vimeo.com/me/projects/${FOLDER_ID}/videos` +
    `?fields=${FIELDS}&page=${page}&per_page=${perPage}&sort=date&direction=desc`;

  const res = await fetch(vimeoUrl, {
    headers: {
      Authorization: `Bearer ${VIMEO_TOKEN}`,
      Accept: "application/vnd.vimeo.*+json;version=3.4",
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return NextResponse.json(
      { error: `Vimeo API error ${res.status}`, detail: text },
      { status: res.status, headers }
    );
  }

  const raw = await res.json();

  // Normalise each video into the shape VimeoVideoGrid.tsx expects
  const videos = (raw.data ?? []).map((v: any) => {
    const id = String(v.uri).replace("/videos/", "");

    // Pick the largest thumbnail Vimeo returns
    const sizes: any[] = v.pictures?.sizes ?? [];
    const thumbnail = sizes.length
      ? sizes[sizes.length - 1].link
      : "";

    return {
      id,
      title:        v.name        ?? "Untitled",
      duration:     v.duration    ?? 0,
      created_time: v.created_time ?? "",
      thumbnail,
      embed_url:    `https://player.vimeo.com/video/${id}`,
      description:  v.description ?? "",
      
    };
  });

  return NextResponse.json(
    {
      videos,
      total: raw.total ?? videos.length,
      page:  raw.page  ?? page,
    },
    { status: 200, headers }
  );
}