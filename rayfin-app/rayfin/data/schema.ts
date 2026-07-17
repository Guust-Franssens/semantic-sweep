import { SavedScan } from './SavedScan.js';
import { ScanChunk } from './ScanChunk.js';
import { ScanDecision } from './ScanDecision.js';

// Data model registered with the Rayfin managed DB (mssql). The `schema` value array drives Data API
// Builder generation at `rayfin up db apply`; the type map keeps `client.data.<Entity>` strongly
// typed. (Name kept as BlankAppSchema so the auth/client service imports stay untouched.)
export type BlankAppSchema = {
  SavedScan: SavedScan;
  ScanChunk: ScanChunk;
  ScanDecision: ScanDecision;
};

export const schema = [SavedScan, ScanChunk, ScanDecision];
