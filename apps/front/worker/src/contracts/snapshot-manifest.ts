import { z } from 'zod';

export interface SnapshotManifest {
  schema_version: 1;
  latest_snapshot_key: string;
  generated_at: number;
  published_at: number;
  last_publish_error_at?: number;
}

export const snapshotManifestSchema = z.object({
  schema_version: z.literal(1),
  latest_snapshot_key: z.string().min(1),
  generated_at: z.number().int().nonnegative(),
  published_at: z.number().int().nonnegative(),
  last_publish_error_at: z.number().int().nonnegative().optional(),
});

export function encodeSnapshotManifest(manifest: SnapshotManifest): string {
  return JSON.stringify(manifest);
}
