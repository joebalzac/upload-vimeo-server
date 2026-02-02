import { NextResponse } from "next/server";
import { confirmByToken } from "@/lib/uploadStore";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { pending_token, video_id, confirmed_at } = body || {};

    if (!pending_token || !video_id) {
      return NextResponse.json(
        { error: "Missing pending_token/video_id" },
        { status: 400 },
      );
    }

    const ok = await confirmByToken(
      String(pending_token),
      String(video_id),
      String(confirmed_at || new Date().toISOString()),
    );

    return NextResponse.json({ ok });
  } catch (e: any) {
    return NextResponse.json(
      { error: String(e?.message || e) },
      { status: 500 },
    );
  }
}
