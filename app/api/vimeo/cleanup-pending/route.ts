// File: app/api/vimeo/cleanup/route.ts
import { NextResponse } from "next/server";
import { vimeoDeleteVideo } from "@/lib/vimeo";

const DEFAULT_HOURS = 24;
const DEFAULT_LIMIT = 25;

export async function OPTIONS(req: Request) {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, x-cleanup-secret",
    "Access-Control-Allow-Origin": "*",
  };
  return new NextResponse(null, { status: 204, headers });
}

function pickListFn(store: any) {
  // Try several plausible exported names for retrieving expired/pending records
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
  // Try several plausible exported names for marking a pending token deleted
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
  // simple secret header protection (optional)
  const secret = process.env.CLEANUP_SECRET;
  const provided = req.headers.get("x-cleanup-secret");

  if (secret && provided !== secret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    // dynamic import so we don't fail at compile time if named exports differ
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
            "Could not find expected functions in @/lib/uploadStore. Expected a listing function (examples: listExpiredPending, listExpired, getExpiredPending) and a mark-delete function (examples: markDeleted, markPendingDeleted).",
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

    // call the store's listing function. Try to pass (cutoffISO, limit) but
    // if the function expects different params it may ignore extras.
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

    // process sequentially (safe) — can be batched/concurrent later if desired
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
        // attempt delete on Vimeo (ignore failures but record)
        try {
          await vimeoDeleteVideo(String(item.video_id));
          item.deleted_on_vimeo = true;
          deletedCount++;
        } catch (err: any) {
          item.deleted_on_vimeo = false;
          item.vimeo_error = String(err?.message || err);
        }

        // mark deleted in store (ensure we don't retry)
        try {
          // call mark function with common signatures:
          // markDeleted(pending_token, deletedAt) OR markDeleted({ pending_token, deleted_at })
          const deletedAt = new Date().toISOString();
          const res =
            // try (token, deletedAt)
            await markFn(item.pending_token, deletedAt).catch(
              async (err: any) => {
                // try ({ pending_token, deleted_at })
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
      {
        status: 200,
        headers: { "Access-Control-Allow-Origin": "*" },
      }
    );
  } catch (err: any) {
    return NextResponse.json(
      {
        error: String(err?.message || err),
      },
      { status: 500 }
    );
  }
}
