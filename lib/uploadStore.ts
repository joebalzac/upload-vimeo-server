import { Redis } from "@upstash/redis";
const redis = Redis.fromEnv();

const TTL_SECONDS = Number(process.env.UPLOAD_PENDING_TTL_SECONDS || 6 * 60); // set to 300 for 5 min tests

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

  // 1) store record (TTL)
  await redis.set(pendingKey(args.pending_token), rec, { ex: TTL_SECONDS });

  // 2) index by time for cleanup
  const score = Date.parse(args.created_at) || Date.now();
  await redis.zadd(INDEX_KEY, { score, member: args.pending_token });
}

export async function readPendingUpload(pending_token: string) {
  return await redis.get<PendingRecord>(pendingKey(pending_token));
}

export async function listExpiredPending(cutoffISO: string, limit: number) {
  const cutoffMs = Date.parse(cutoffISO);
  if (!Number.isFinite(cutoffMs)) return [];

  const raw = await redis.zrange(INDEX_KEY, 0, cutoffMs, {
    byScore: true,
    offset: 0,
    count: limit,
  } as any);

  const tokens = (raw as unknown[]).map((t) => String(t));
  if (tokens.length === 0) return [];

  const records = await Promise.all(
    tokens.map((token) => redis.get<PendingRecord>(pendingKey(token)))
  );

  return records
    .map((rec, i) => (rec ? { ...rec, pending_token: tokens[i] } : null))
    .filter(Boolean) as Array<PendingRecord & { pending_token: string }>;
}

export async function markDeleted(pending_token: string, deleted_at: string) {
  await redis.zrem(INDEX_KEY, pending_token);
  await redis.del(pendingKey(pending_token));
}

export async function confirmPendingUpload(args: {
  pending_token: string;
  video_id: string;
  confirmed_at: string;
}) {
  const key = pendingKey(args.pending_token);
  const rec = await redis.get<PendingRecord>(key);

  // mark confirmed by video id
  await redis.set(
    confirmedKey(args.video_id),
    { confirmed_at: args.confirmed_at },
    { ex: 30 * 24 * 60 * 60 }
  );

  // remove pending
  await redis.del(key);
  await redis.zrem(INDEX_KEY, args.pending_token);

  if (!rec) return { ok: false, reason: "pending_token_not_found" as const };
  if (rec.video_id !== args.video_id)
    return { ok: false, reason: "video_id_mismatch" as const };

  return { ok: true };
}
