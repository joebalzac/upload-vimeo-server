// app/api/vimeo/confirm-upload/route.ts
import { NextResponse } from "next/server";
import { confirmPendingUpload } from "@/lib/uploadStore";

export const dynamic = "force-dynamic";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() });
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));

    const pending_token = String(body?.pending_token || "").trim();
    const video_id = String(body?.video_id || "").trim();
    const confirmed_at =
      String(body?.confirmed_at || "").trim() || new Date().toISOString();

    if (!pending_token || !video_id) {
      return NextResponse.json(
        { ok: false, error: "missing pending_token or video_id" },
        { status: 400, headers: corsHeaders() }
      );
    }

    const result = await confirmPendingUpload({
      pending_token,
      video_id,
      confirmed_at,
    });

    // super helpful for diagnosing “why did cron delete it?”
    console.log("[confirm-upload]", { pending_token, video_id, result });

    return NextResponse.json(
      { ok: true, result },
      { status: 200, headers: corsHeaders() }
    );
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: String(err?.message || err) },
      { status: 500, headers: corsHeaders() }
    );
  }
}
