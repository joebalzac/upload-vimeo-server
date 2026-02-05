// app/api/vimeo/cleanup/route.ts
import { NextResponse } from "next/server";
import { vimeoDeleteVideo, vimeoWhoAmI } from "@/lib/vimeo";
import {
  isConfirmed,
  listExpiredPending,
  markDeleted,
} from "@/lib/uploadStore";

// Important for cron/logging: prevents cached responses in Vercel
export const dynamic = "force-dynamic";

const DEFAULT_HOURS = 24;
const DEFAULT_LIMIT = 25;

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() });
}

function parseBearer(authHeader: string | null) {
  if (!authHeader) return "";
  return authHeader.replace(/^Bearer\s+/i, "").trim();
}

async function handler(req: Request) {
  // Vercel Cron: Authorization: Bearer <CRON_SECRET>
  const cronSecret = process.env.CRON_SECRET;
  const token = parseBearer(req.headers.get("authorization"));

  if (cronSecret && token !== cronSecret) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401, headers: corsHeaders() }
    );
  }

  // (Optional) TEMP DEBUG: verify which Vimeo account token belongs to (no token printed)
  try {
    const who = await vimeoWhoAmI();
    console.log("[cleanup] vimeo /me status:", who.status);
  } catch (e: any) {
    console.log("[cleanup] vimeo /me failed:", String(e?.message || e));
  }

  const url = new URL(req.url);

  const limit = Number(url.searchParams.get("limit") || DEFAULT_LIMIT);

  // minutes takes precedence; hours is fallback
  const minutesParam = url.searchParams.get("minutes");
  const hoursParam = url.searchParams.get("hours");

  let minutes: number;
  if (minutesParam != null) minutes = Number(minutesParam);
  else if (hoursParam != null) minutes = Number(hoursParam) * 60;
  else minutes = DEFAULT_HOURS * 60;

  if (Number.isNaN(minutes) || minutes <= 0) {
    return NextResponse.json(
      { error: "Invalid minutes/hours" },
      { status: 400, headers: corsHeaders() }
    );
  }
  if (Number.isNaN(limit) || limit <= 0) {
    return NextResponse.json(
      { error: "Invalid limit" },
      { status: 400, headers: corsHeaders() }
    );
  }

  const cutoffMs = Date.now() - minutes * 60 * 1000;
  const cutoffISO = new Date(cutoffMs).toISOString();

  const pending: any[] = await listExpiredPending(cutoffISO, limit);
  if (!Array.isArray(pending)) {
    return NextResponse.json(
      {
        error: "uploadStore list returned non-array",
        returned: typeof pending,
      },
      { status: 500, headers: corsHeaders() }
    );
  }

  const results: any[] = [];
  let deletedCount = 0;

  for (const rec of pending) {
    const pending_token =
      rec.pending_token ?? rec.pendingToken ?? rec.token ?? rec.id ?? null;

    const video_id =
      rec.video_id ?? rec.videoId ?? rec.video_id_str ?? rec.video ?? null;

    const item: any = {
      pending_token,
      video_id,
      created_at: rec.created_at ?? rec.createdAt ?? rec.ts ?? null,
    };

    if (!pending_token || !video_id) {
      item.error = "missing_pending_token_or_video_id";
      results.push(item);
      continue;
    }

    // SAFETY: skip if upload was already confirmed (form submitted)
    try {
      const confirmed = await isConfirmed(String(video_id));
      if (confirmed) {
        item.skipped = "already_confirmed";
        results.push(item);
        continue;
      }
    } catch (err: any) {
      console.log(
        "[cleanup] isConfirmed check failed:",
        String(err?.message || err)
      );
      // continue with deletion rather than failing the whole cron
    }

    // 1) Delete on Vimeo (record status/body so prod debugging is easy)
    const del = await vimeoDeleteVideo(String(video_id));
    item.vimeo_status = del.status;

    if (del.ok) {
      item.deleted_on_vimeo = true;
      deletedCount++;

      // 2) Only mark deleted in store if Vimeo delete succeeded
      try {
        const deletedAt = new Date().toISOString();
        const res = await markDeleted(pending_token, deletedAt);
        item.mark_result = typeof res === "undefined" ? "ok" : res;
      } catch (err: any) {
        item.mark_error = String(err?.message || err);
      }
    } else {
      item.deleted_on_vimeo = false;
      item.vimeo_error = del.body || `status ${del.status}`;
      item.mark_result = "skipped_mark_deleted_due_to_vimeo_failure";
    }

    results.push(item);
  }

  console.log("[cleanup] run", {
    cutoffISO,
    requested_minutes: minutes,
    limit,
    found: pending.length,
    deleted: deletedCount,
    sample: results.slice(0, 3),
  });

  return NextResponse.json(
    {
      ok: true,
      cutoffISO,
      requested_minutes: minutes,
      requested_limit: limit,
      found: pending.length,
      deleted: deletedCount,
      results,
    },
    { status: 200, headers: corsHeaders() }
  );
}

// POST supported
export async function POST(req: Request) {
  try {
    return await handler(req);
  } catch (err: any) {
    return NextResponse.json(
      { error: String(err?.message || err) },
      { status: 500, headers: corsHeaders() }
    );
  }
}

// REQUIRED for Vercel Cron (GET)
export async function GET(req: Request) {
  return POST(req);
}
