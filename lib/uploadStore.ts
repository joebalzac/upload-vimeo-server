import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();

const TTL_SECONDS = Number(
  process.env.UPLOAD_PENDING_TTL_SECONDS || 6 * 60 * 60
); // 6h default
const PENDING_INDEX_KEY = "vimeo:pending:index";

function pendingKey(token: string) {
  return `vimeo:pending:${token}`;
}
function confirmedKey(videoId: string) {
  return `vimeo:confirmed:${videoId}`;
}

export type PendingRecord = {
  video_id: string;
  created_at: string;
};

// ✅ store + index
export async function storePendingUpload(args: {
  pending_token: string;
  video_id: string;
  created_at: string;
}) {
  const rec: PendingRecord = {
    video_id: args.video_id,
    created_at: args.created_at,
  };

  const createdMs = Date.parse(args.created_at);

  // Store pending mapping with TTL
  await redis.set(pendingKey(args.pending_token), rec, { ex: TTL_SECONDS });

  // Index token by created time (ms)
  if (!Number.isNaN(createdMs)) {
    await redis.zadd(PENDING_INDEX_KEY, {
      score: createdMs,
      member: args.pending_token,
    });
  }
}

export async function readPendingUpload(pending_token: string) {
  return await redis.get<PendingRecord>(pendingKey(pending_token));
}

// ✅ list “expired pending” for cleanup route (matches your handler’s expected call shape)
export async function listExpiredPending(cutoffISO: string, limit: number) {
  const cutoffMs = Date.parse(cutoffISO);
  const max = Number.isNaN(cutoffMs) ? Date.now() : cutoffMs;

  const tokens = await redis.zrange(PENDING_INDEX_KEY, 0, max, {
    byScore: true,
    offset: 0,
    count: limit,
  });

  const out: Array<{
    pending_token: string;
    video_id: string;
    created_at: string;
  }> = [];

  for (const token of tokens as string[]) {
    const rec = await redis.get<PendingRecord>(pendingKey(token));
    if (!rec?.video_id) {
      await redis.zrem(PENDING_INDEX_KEY, token);
      continue;
    }

    const isConfirmed = await redis.get(confirmedKey(rec.video_id));
    if (isConfirmed) {
      await redis.del(pendingKey(token));
      await redis.zrem(PENDING_INDEX_KEY, token);
      continue;
    }

    out.push({
      pending_token: token,
      video_id: rec.video_id,
      created_at: rec.created_at,
    });
  }

  return out;
}

// ✅ “mark deleted” for cleanup route
// called as markFn(pending_token, deletedAtISO) in your route
export async function markDeleted(pending_token: string, _deleted_at: string) {
  await redis.del(pendingKey(pending_token));
  await redis.zrem(PENDING_INDEX_KEY, pending_token);
  return { ok: true };
}

export async function confirmPendingUpload(args: {
  pending_token: string;
  video_id: string;
  confirmed_at: string;
}) {
  const key = pendingKey(args.pending_token);
  const rec = await redis.get<PendingRecord>(key);

  if (!rec) {
    await redis.set(
      confirmedKey(args.video_id),
      { confirmed_at: args.confirmed_at },
      { ex: 30 * 24 * 60 * 60 }
    );
    return { ok: false, reason: "pending_token_not_found" as const };
  }

  if (rec.video_id !== args.video_id) {
    return { ok: false, reason: "video_id_mismatch" as const };
  }

  await redis.set(
    confirmedKey(args.video_id),
    { confirmed_at: args.confirmed_at },
    { ex: 30 * 24 * 60 * 60 }
  );

  // delete pending mapping + remove from index
  await redis.del(key);
  await redis.zrem(PENDING_INDEX_KEY, args.pending_token);

  return { ok: true };
}
