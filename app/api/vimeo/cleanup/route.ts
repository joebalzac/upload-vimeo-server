// File: app/api/vimeo/cleanup/route.ts
import { NextResponse } from "next/server";
import { vimeoDeleteVideo } from "@/lib/vimeo";

const DEFAULT_HOURS = 24;
const DEFAULT_LIMIT = 25;

// Shared CORS headers (also returned on errors so the browser doesn't hide responses)
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
    // include both common casings to avoid preflight mismatches
    "Access-Control-Allow-Headers": "Content-Type, Authorization, authorization",
    "Access-Control-Max-Age": "86400",
  } as Record<string, string>;
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() });
}

function pickListFn(store: any) {
  const candidates = [
    "listExpiredPending",
    "listExpired",
    "listPending",
    "getExpiredPending",
    "getExpired",
    "findExpiredPending",
    "getPendingUploadsOlderThan",
    "listPendingUploads",
    "listPendingByCutoff",
  ];
  for (const name of candidates) {
    if (typeof store?.[name] === "function") return store[name].bind(store);
  }
  return null;
}

function pickMarkDeletedFn(store: any) {
  const candidates = [
    "markDeleted",
    "markPendingDeleted",
    "setDeleted",
    "deletePendingRecord",
    "markAsDeleted",
    "confirmDeletion",
  ];
  for (const name of candidates) {
    if (typeof store?.[name] === "function") return store[name].bind(store);
  }
  return null;
}

export async function POST(req: Request) {
  const headers = corsHeaders();

  // ✅ Vercel Cron uses Authorization: Bearer <CRON_SECRET>
  const cronSecret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization") || req.headers.get("Authorization") || "";

  if (cronSecret && auth !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers });
  }

  try {
    // dynamic import so type/export mismatches don't break compilation
    const storeModule = await import("@/lib/uploadStore").catch((err) => {
      throw new Error(
        `Failed to import uploadStore: ${String(err?.message || err)}`
      );
    });

    const listFn = pickListFn(storeModule);
    const markFn = pickMarkDeletedFn(storeModule);

    if (!listFn || !markFn) {
      const available = Object.keys(storeModule || {}).join(", ") || "<no-exports>";
      return NextResponse.json(
        {
          error: "uploadStore API mismatch",
          message:
            "Could not find expected functions in @/lib/uploadStore. Expected a listing function and a mark-delete function.",
          availableExports: available,
        },
        { status: 500, headers }
      );
    }

    const url = new URL(req.url);
    const hours = Number(url.searchParams.get("hours") || DEFAULT_HOURS);
    const limit = Number(url.searchParams.get("limit") || DEFAULT_LIMIT);

    if (Number.isNaN(hours) || hours <= 0) {
      return NextResponse.json({ error: "Invalid hours parameter" }, { status: 400, headers });
    }
    if (Number.isNaN(limit) || limit <= 0) {
      return NextResponse.json({ error: "Invalid limit parameter" }, { status: 400, headers });
    }

    const cutoffMs = Date.now() - hours * 60 * 60 * 1000;
    const cutoffISO = new Date(cutoffMs).toISOString();

    // Try common signature (cutoffISO, limit). If your store ignores extras, that's fine.
    const pending: Array<any> = await listFn(cutoffISO, limit);

    if (!Array.isArray(pending)) {
      return NextResponse.json(
        {
          error: "uploadStore.list function returned non-array",
          returned: typeof pending,
        },
        { status: 500, headers }
      );
    }

    const results: Array<any> = [];
    let deletedCount = 0;

    for (const rec of pending) {
      const item: any = {
        pending_token: rec?.pending_token ?? rec?.token ?? rec?.id ?? null,
        video_id: rec?.video_id ?? rec?.videoId ?? rec?.video_id_str ?? rec?.video ?? null,
        created_at: rec?.created_at ?? rec?.createdAt ?? rec?.ts ?? null,
      };

      if (!item.pending_token || !item.video_id) {
        item.error = "missing_pending_token_or_video_id";
        results.push(item);
        continue;
      }

      // 1) delete from Vimeo (best effort)
      try {
        await vimeoDeleteVideo(String(item.video_id));
        item.deleted_on_vimeo = true;
        deletedCount++;
      } catch (err: any) {
        item.deleted_on_vimeo = false;
        item.vimeo_error = String(err?.message || err);
      }

      // 2) mark deleted in store so it won't retry forever
      try {
        const deletedAt = new Date().toISOString();

        const res = await markFn(item.pending_token, deletedAt).catch(async () => {
          return await markFn({
            pending_token: item.pending_token,
            deleted_at: deletedAt,
          });
        });

        item.mark_result = typeof res === "undefined" ? "ok" : res;
      } catch (err: any) {
        item.mark_error = String(err?.message || err);
      }

      results.push(item);
    }

    return NextResponse.json(
      {
        ok: true,
        cutoffISO,
        requested_hours: hours,
        requested_limit: limit,
        found: pending.length,
        deleted: deletedCount,
        results,
      },
      { status: 200, headers }
    );
  } catch (err: any) {
    return NextResponse.json(
      { error: String(err?.message || err) },
      { status: 500, headers }
    );
  }
}

// ✅ REQUIRED for Vercel Cron (GET)
export async function GET(req: Request) {
  return POST(req);
}
