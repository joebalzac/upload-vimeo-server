// lib/uploadStore.ts
import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();

// How long a pending token record should live (key TTL). Cleanup timing is controlled by cron.
const TTL_SECONDS = Number(process.env.UPLOAD_PENDING_TTL_SECONDS || 6 * 60 * 60); // 6h default

const INDEX_KEY = "vimeo:pending:index";

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

export async function storePendingUpload(args: {
  pending_token: string;
  video_id: string;
  created_at: string;
}) {
  const rec: PendingRecord = {
    video_id: args.video_id,
    created_at: args.created_at,
  };

  // 1) Store pending mapping with TTL
  await redis.set(pendingKey(args.pending_token), rec, { ex: TTL_SECONDS });

  // 2) Also index this token by time for cleanup scans
  const score = Date.parse(args.created_at) || Date.now();
  await redis.zadd(INDEX_KEY, { score, member: args.pending_token });
}

export async function readPendingUpload(pending_token: string) {
  return await redis.get<PendingRecord>(pendingKey(pending_token));
}

export async function confirmPendingUpload(args: {
  pending_token: string;
  video_id: string;
  confirmed_at: string;
}) {
  const key = pendingKey(args.pending_token);
  const rec = await redis.get<PendingRecord>(key);

  // If token missing/expired, still mark confirmed (helps if you change flows later)
  if (!rec) {
    await redis.set(
      confirmedKey(args.video_id),
      { confirmed_at: args.confirmed_at },
      { ex: 30 * 24 * 60 * 60 }
    ); // 30d
    return { ok: false, reason: "pending_token_not_found" as const };
  }

  if (rec.video_id !== args.video_id) {
    return { ok: false, reason: "video_id_mismatch" as const };
  }

  // Mark confirmed and remove pending record + index entry
  await redis.set(
    confirmedKey(args.video_id),
    { confirmed_at: args.confirmed_at },
    { ex: 30 * 24 * 60 * 60 }
  ); // 30d

  await redis.del(key);
  await redis.zrem(INDEX_KEY, args.pending_token);

  return { ok: true };
}

/**
 * Returns pending records older than cutoffISO, up to limit.
 * Also prunes orphan index members (tokens whose pending keys no longer exist).
 */
export async function listExpiredPending(cutoffISO: string, limit: number) {
  const cutoffMs = Date.parse(cutoffISO);
  if (!Number.isFinite(cutoffMs)) return [];

  // tokens older than cutoff (by score)
  const raw = await redis.zrange(
    INDEX_KEY,
    "-inf",
    cutoffMs,
    {
      byScore: true,
      offset: 0,
      count: limit,
    } as any
  );

  const tokens = (raw as unknown[]).map((t) => String(t));
  if (!tokens.length) return [];

  const recs = await Promise.all(
    tokens.map((token) => redis.get<PendingRecord>(pendingKey(token)))
  );

  const results: Array<PendingRecord & { pending_token: string }> = [];
  const orphans: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const rec = recs[i];
    if (rec) results.push({ ...rec, pending_token: token });
    else orphans.push(token);
  }

  // prune orphaned zset members so cleanup doesn't get stuck with garbage
  if (orphans.length) {
    await redis.zrem(INDEX_KEY, ...orphans);
  }

  return results;
}

/**
 * Called by cleanup after Vimeo deletion succeeds.
 * Removes pending key + index member.
 */
export async function markDeleted(pending_token: string, deleted_at: string) {
  // deleted_at isn't stored right now, but we accept it for API compatibility
  await redis.del(pendingKey(pending_token));
  await redis.zrem(INDEX_KEY, pending_token);
  return { ok: true };
}
