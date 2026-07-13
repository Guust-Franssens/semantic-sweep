// Packs a ScanResult into DB-storable chunks and back. Pipeline:
//   encodeScan (lossless JSON) -> gzip -> base64 -> split into <=4000-char slices
// so it fits bounded NVARCHAR(4000) columns (avoids the NVARCHAR(MAX) GraphQL-gen risk) while
// keeping the write count low (gzip shrinks the highly-repetitive DAX/schema text ~8-10x).
//
// CompressionStream / DecompressionStream are available in the Fabric app's Chromium runtime and in
// Node (used by the vitest suite), so this module is isomorphic.

import type { ScanResult } from "@engine/scan";

import { decodeScan, encodeScan } from "./scanCodec";

export const CHUNK_CHARS = 4000; // NVARCHAR(4000) ceiling — one base64 char per NVARCHAR unit.

async function streamToBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

async function gzip(text: string): Promise<Uint8Array> {
  const cs = new CompressionStream("gzip");
  const writer = cs.writable.getWriter();
  void writer.write(new TextEncoder().encode(text));
  void writer.close();
  return streamToBytes(cs.readable);
}

async function gunzip(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const ds = new DecompressionStream("gzip");
  const writer = ds.writable.getWriter();
  void writer.write(bytes);
  void writer.close();
  return new TextDecoder().decode(await streamToBytes(ds.readable));
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const step = 0x8000; // chunk fromCharCode so a large payload can't overflow the call stack
  for (let i = 0; i < bytes.length; i += step) {
    bin += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Compress + encode a scan, returning ordered chunks (each <= CHUNK_CHARS) ready to persist. */
export async function packScan(scan: ScanResult): Promise<string[]> {
  const b64 = bytesToBase64(await gzip(encodeScan(scan)));
  const chunks: string[] = [];
  for (let i = 0; i < b64.length; i += CHUNK_CHARS) chunks.push(b64.slice(i, i + CHUNK_CHARS));
  return chunks;
}

/** Reassemble + decompress ordered chunks back into a ScanResult (inverse of packScan). */
export async function unpackScan(chunks: string[]): Promise<ScanResult> {
  return decodeScan(await gunzip(base64ToBytes(chunks.join(""))));
}
