// File: app/api/vimeo/cleanup/route.ts
import { NextResponse } from "next/server";
import { vimeoDeleteVideo } from "@/lib/vimeo";

// Important for cron/logging: prevents cached responses in Vercel
export const dynamic = "force-dynamic";

const DEFAULT_HOURS = 24;
const DEFAULT_LIMIT = 25;

export async function OPTIONS() {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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

async function handler(req: Request) {
  // Vercel Cron: Authorization: Bearer <CRON_SECRET>
  const cronSecret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization") || "";

  if (cronSecret && auth !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Import uploadStore dynamically to avoid TS/export-name mismatch at build time
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
          "Could not find expected functions in @/lib/uploadStore (list + markDeleted).",
        availableExports: available,
      },
      { status: 500 }
    );
  }

  const url = new URL(req.url);

  const limit = Number(url.searchParams.get("limit") || DEFAULT_LIMIT);

  // NEW: minutes takes precedence; hours is fallback
  const minutesParam = url.searchParams.get("minutes");
  const hoursParam = url.searchParams.get("hours");

  let minutes: number;
  if (minutesParam != null) {
    minutes = Number(minutesParam);
  } else if (hoursParam != null) {
    minutes = Number(hoursParam) * 60;
  } else {
    minutes = DEFAULT_HOURS * 60;
  }

  if (Number.isNaN(minutes) || minutes <= 0) {
    return NextResponse.json(
      { error: "Invalid minutes/hours" },
      { status: 400 }
    );
  }
  if (Number.isNaN(limit) || limit <= 0) {
    return NextResponse.json({ error: "Invalid limit" }, { status: 400 });
  }

  const cutoffMs = Date.now() - minutes * 60 * 1000;
  const cutoffISO = new Date(cutoffMs).toISOString();

  const pending: any[] = await listFn(cutoffISO, limit);
  if (!Array.isArray(pending)) {
    return NextResponse.json(
      {
        error: "uploadStore list returned non-array",
        returned: typeof pending,
      },
      { status: 500 }
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

    // 1) Delete on Vimeo
    let vimeoDeleted = false;
    try {
      await vimeoDeleteVideo(String(video_id));
      vimeoDeleted = true;
      item.deleted_on_vimeo = true;
      deletedCount++;
    } catch (err: any) {
      item.deleted_on_vimeo = false;
      item.vimeo_error = String(err?.message || err);
    }

    // 2) Only mark deleted in store if Vimeo delete succeeded
    if (vimeoDeleted) {
      try {
        const deletedAt = new Date().toISOString();
        const res = await markFn(pending_token, deletedAt).catch(async () => {
          return await markFn({ pending_token, deleted_at: deletedAt });
        });
        item.mark_result = typeof res === "undefined" ? "ok" : res;
      } catch (err: any) {
        item.mark_error = String(err?.message || err);
      }
    } else {
      item.mark_result = "skipped_mark_deleted_due_to_vimeo_failure";
    }

    results.push(item);
  }

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
    { status: 200, headers: { "Access-Control-Allow-Origin": "*" } }
  );
}

// POST supported
export async function POST(req: Request) {
  try {
    return await handler(req);
  } catch (err: any) {
    return NextResponse.json(
      { error: String(err?.message || err) },
      { status: 500 }
    );
  }
}

// REQUIRED for Vercel Cron (GET)
export async function GET(req: Request) {
  return POST(req);
}
