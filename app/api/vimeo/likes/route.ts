// app/api/vimeo/likes/route.ts
import { NextResponse } from "next/server";
import { Redis } from "@upstash/redis";

export const dynamic = "force-dynamic";

const LIKE_KEY = (id: string) => `video:likes:${id}`;

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

export const OPTIONS = async () =>
  new NextResponse(null, { status: 204, headers: corsHeaders() });

// GET /api/vimeo/likes?video_id=123
export const GET = async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const video_id = searchParams.get("video_id");

  if (!video_id) {
    return NextResponse.json(
      { error: "Missing video_id" },
      { status: 400, headers: corsHeaders() },
    );  
  }

  const count = Number(await Redis.fromEnv().get(LIKE_KEY(video_id))) || 0;
  return NextResponse.json({ video_id, count }, { headers: corsHeaders() });
};

// POST /api/vimeo/likes  { video_id, action: "like" | "unlike" }
export const POST = async (req: Request) => {
  const body = await req.json().catch(() => ({}));
  const { video_id, action } = body as { video_id?: string; action?: string };

  if (!video_id || !["like", "unlike"].includes(action ?? "")) {
    return NextResponse.json(
      { error: "Missing video_id or invalid action" },
      { status: 400, headers: corsHeaders() },
    );
  }

  const key = LIKE_KEY(video_id);
  const count =
    action === "like"
      ? await Redis.fromEnv().incr(key)
      : Math.max(0, Number((await Redis.fromEnv().get(key)) || 0) - 1);

  if (action === "unlike") await Redis.fromEnv().set(key, count);

  return NextResponse.json({ video_id, count }, { headers: corsHeaders() });
};
