import { NextResponse } from "next/server";
import { listExpiredPending, markDeleted } from "@/lib/uploadStore";
import { vimeoDeleteVideo } from "@/lib/vimeo";

export async function POST(req: Request) {
  const secret = process.env.CLEANUP_SECRET;
  const provided = req.headers.get("x-cleanup-secret");

  if (secret && provided !== secret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const url = new URL(req.url);
    const hours = Number(url.searchParams.get("hours") || 24);
    const limit = Number(url.searchParams.get("limit") || 25);

    const cutoffMs = Date.now() - hours * 60 * 60 * 1000;
    const cutoffISO = new Date(cutoffMs).toISOString();

    const pending = await listExpiredPending(cutoffISO, limit);

    let deleted = 0;
    for (const rec of pending) {
      try {
        await vimeoDeleteVideo(rec.video_id);
      } catch {
        // don't block cleanup if Vimeo returns errors; still mark deleted to avoid loops
      }
      await markDeleted(rec.pending_token, new Date().toISOString());
      deleted++;
    }

    return NextResponse.json({
      ok: true,
      cutoffISO,
      found: pending.length,
      deleted,
    });
  } catch (e: any) {
    return NextResponse.json(
      { error: String(e?.message || e) },
      { status: 500 }
    );
  }
}
