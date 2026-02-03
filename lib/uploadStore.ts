// lib/uploadStore.ts
import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();

const TTL_SECONDS = Number(
  process.env.UPLOAD_PENDING_TTL_SECONDS || 6 * 60 * 60
); // 6h default

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

  // Store pending mapping with TTL
  await redis.set(pendingKey(args.pending_token), rec, { ex: TTL_SECONDS });
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

  // If token missing/expired, nothing to confirm (but we can still consider it confirmed by video id)
  if (!rec) {
    // Mark confirmed anyway to prevent deletion by other mechanisms if you add them later
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

  // Mark confirmed and delete pending token mapping
  await redis.set(
    confirmedKey(args.video_id),
    { confirmed_at: args.confirmed_at },
    { ex: 30 * 24 * 60 * 60 }
  ); // 30d
  await redis.del(key);

  return { ok: true };
}
