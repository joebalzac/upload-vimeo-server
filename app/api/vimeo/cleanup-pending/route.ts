// File: app/api/vimeo/cleanup/route.ts
import { NextResponse } from "next/server";
import { vimeoDeleteVideo } from "@/lib/vimeo";

const DEFAULT_HOURS = 24;
const DEFAULT_LIMIT = 25;

export async function OPTIONS(req: Request) {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Origin": "*",
  };
  return new NextResponse(null, { status: 204, headers });
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
    if (typeof store[name] === "function") return store[name].bind(store);
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
    if (typeof store[name] === "function") return store[name].bind(store);
  }
  return null;
}

export async function POST(req: Request) {
  // ✅ Vercel cron uses Authorization: Bearer <CRON_SECRET>
  const cronSecret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization") || "";

  if (cronSecret && auth !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const storeModule = await import("@/lib/uploadStore").catch((err) => {
      throw new Error(
        `Failed to import uploadStore: ${String(err?.message || err)}`
      );
    });

    const listFn = pickListFn(storeModule);
    const markFn = pickMarkDeletedFn(storeModule);

    if (!listFn || !markFn) {
      const available = Object.keys(storeModule).join(", ") || "<no-exports>";
      return NextResponse.json(
        {
          error: "uploadStore API mismatch",
          message:
            "Could not find expected functions in @/lib/uploadStore. Expected a listing function and a mark-delete function.",
          availableExports: available,
        },
        { status: 500 }
      );
    }

    const url = new URL(req.url);
    const hours = Number(url.searchParams.get("hours") || DEFAULT_HOURS);
    const limit = Number(url.searchParams.get("limit") || DEFAULT_LIMIT);

    if (Number.isNaN(hours) || hours <= 0) {
      return NextResponse.json(
        { error: "Invalid hours parameter" },
        { status: 400 }
      );
    }
    if (Number.isNaN(limit) || limit <= 0) {
      return NextResponse.json(
        { error: "Invalid limit parameter" },
        { status: 400 }
      );
    }

    const cutoffMs = Date.now() - hours * 60 * 60 * 1000;
    const cutoffISO = new Date(cutoffMs).toISOString();

    const pending: Array<any> = await listFn(cutoffISO, limit);

    if (!Array.isArray(pending)) {
      return NextResponse.json(
        {
          error: "uploadStore.list function returned non-array",
          returned: typeof pending,
        },
        { status: 500 }
      );
    }

    const results: Array<any> = [];
    let deletedCount = 0;

    for (const rec of pending) {
      const item: any = {
        pending_token: rec.pending_token ?? rec.token ?? rec.id ?? null,
        video_id:
          rec.video_id ?? rec.videoId ?? rec.video_id_str ?? rec.video ?? null,
        created_at: rec.created_at ?? rec.createdAt ?? rec.ts ?? null,
      };

      if (!item.pending_token || !item.video_id) {
        item.error = "missing_pending_token_or_video_id";
        results.push(item);
        continue;
      }

      try {
        try {
          await vimeoDeleteVideo(String(item.video_id));
          item.deleted_on_vimeo = true;
          deletedCount++;
        } catch (err: any) {
          item.deleted_on_vimeo = false;
          item.vimeo_error = String(err?.message || err);
        }

        try {
          const deletedAt = new Date().toISOString();
          const res = await markFn(item.pending_token, deletedAt).catch(
            async () => {
              return await markFn({
                pending_token: item.pending_token,
                deleted_at: deletedAt,
              });
            }
          );

          item.mark_result = typeof res === "undefined" ? "ok" : res;
        } catch (err: any) {
          item.mark_error = String(err?.message || err);
        }
      } catch (outerErr: any) {
        item.error = String(outerErr?.message || outerErr);
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
      { status: 200, headers: { "Access-Control-Allow-Origin": "*" } }
    );
  } catch (err: any) {
    return NextResponse.json(
      { error: String(err?.message || err) },
      { status: 500 }
    );
  }
}

// ✅ REQUIRED for Vercel Cron (GET)
export async function GET(req: Request) {
  return POST(req);
}
