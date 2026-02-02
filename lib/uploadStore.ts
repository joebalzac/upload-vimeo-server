import { Redis } from "@upstash/redis";

export type UploadStatus = "pending" | "confirmed" | "deleted";

export type UploadRecord = {
  pending_token: string;
  video_id: string;
  video_uri?: string;
  video_url?: string;
  status: UploadStatus;
  created_at: string;
  confirmed_at?: string;
  deleted_at?: string;
};

const redis = Redis.fromEnv();

// Keys:
// pending:{token} -> UploadRecord
// pending_by_time -> ZSET score=timestampMs member=token

export async function createPending(record: UploadRecord) {
  const token = record.pending_token;
  const ts = Date.parse(record.created_at) || Date.now();

  await redis.set(`pending:${token}`, record);
  await redis.zadd("pending_by_time", { score: ts, member: token });
}

export async function confirmByToken(
  token: string,
  video_id: string,
  confirmed_at: string
) {
  const key = `pending:${token}`;
  const rec = await redis.get<UploadRecord>(key);

  if (!rec) return false;
  if (rec.video_id !== video_id) return false;

  const updated: UploadRecord = {
    ...rec,
    status: "confirmed",
    confirmed_at,
  };

  await redis.set(key, updated);
  // Remove from zset so cleanup won’t touch it
  await redis.zrem("pending_by_time", token);

  return true;
}

export async function listExpiredPending(cutoffISO: string, limit: number) {
  const cutoffMs = Date.parse(cutoffISO);
  if (!Number.isFinite(cutoffMs)) return [];

  // tokens older than cutoff
  const tokens = await redis.zrange("pending_by_time", "-inf", cutoffMs, {
    byScore: true,
    offset: 0,
    count: limit,
  });

  if (!tokens?.length) return [];

  const records = await Promise.all(
    tokens.map((t) => redis.get<UploadRecord>(`pending:${t}`))
  );

  return records.filter(Boolean) as UploadRecord[];
}

export async function markDeleted(token: string, deleted_at: string) {
  const key = `pending:${token}`;
  const rec = await redis.get<UploadRecord>(key);

  if (rec) {
    await redis.set(key, {
      ...rec,
      status: "deleted",
      deleted_at,
    } satisfies UploadRecord);
  }

  await redis.zrem("pending_by_time", token);
}
