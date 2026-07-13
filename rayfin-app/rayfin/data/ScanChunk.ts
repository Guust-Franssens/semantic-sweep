import { authenticated, entity, int, text, uuid } from '@microsoft/rayfin-core';

// One ordered <=4000-char slice of a SavedScan's gzip+base64 payload. Concatenated by seq and
// inflated on load. Bounded NVARCHAR(4000) avoids the NVARCHAR(MAX) GraphQL-schema-gen risk. A plain
// scan_id column (not a relationship) keeps codegen simple; the store deletes chunks explicitly.
@entity()
@authenticated('*', {
  policy: (claims, item) => claims.sub.eq(item.user_id),
})
export class ScanChunk {
  @uuid() id!: string;
  @text({ max: 200 }) user_id!: string;
  @uuid() scan_id!: string;
  @int() seq!: number;
  @text({ max: 4000 }) data!: string;
}
