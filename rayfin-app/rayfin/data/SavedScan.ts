import { authenticated, boolean, date, entity, int, text, uuid } from '@microsoft/rayfin-core';

// One saved estate scan. The full ScanResult is gzip+base64 encoded and split across ScanChunk rows
// (bounded NVARCHAR(4000)); the summary counts here let the "saved scans" list render without
// unpacking the blob. Rows are scoped to the signed-in user via the user_id policy (claims.sub).
@entity()
@authenticated('*', {
  policy: (claims, item) => claims.sub.eq(item.user_id),
})
export class SavedScan {
  @uuid() id!: string;
  @text({ max: 200 }) user_id!: string;
  @text({ max: 200 }) label!: string;
  @text({ max: 40 }) mode!: string;
  @text({ max: 400 }) source!: string;
  @int() models!: number;
  @int() pairs!: number;
  @int() clusters!: number;
  @int() chains!: number;
  @int() systemGenerated!: number;
  @int() review!: number;
  @boolean() usageLoaded!: boolean;
  @int() chunkCount!: number;
  @date() scannedAt!: Date;
}
