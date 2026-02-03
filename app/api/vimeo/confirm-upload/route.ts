// app/api/vimeo/confirm-upload/route.ts
import { NextResponse } from "next/server";
import { confirmPendingUpload } from "@/lib/uploadStore";

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const { pending_token, video_id, confirmed_at } = body as {
    pending_token?: string;
    video_id?: string;
    confirmed_at?: string;
  };

  if (!pending_token || !video_id) {
    return NextResponse.json(
      { error: "Missing pending_token or video_id" },
      { status: 400 }
    );
  }

  const result = await confirmPendingUpload({
    pending_token,
    video_id,
    confirmed_at: confirmed_at || new Date().toISOString(),
  });

  return NextResponse.json({ ok: true, result }, { status: 200 });
}
