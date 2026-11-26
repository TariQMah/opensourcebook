/** An R2 bucket in memory: enough of get, put and head for uploads and assets. */
import type { R2BucketLike } from "../../src/types";

interface StoredObject {
  bytes: ArrayBuffer;
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
}

export class FakeR2Bucket implements R2BucketLike {
  readonly objects = new Map<string, StoredObject>();

  /** Every get, with the range it asked for, so a test can see what was read. */
  readonly reads: Array<{ key: string; range?: { offset: number; length: number } }> = [];

  async get(key: string, options?: { range?: { offset: number; length: number } }) {
    this.reads.push({ key, ...(options?.range ? { range: options.range } : {}) });
    const object = this.objects.get(key);
    if (!object) return null;
    const range = options?.range;
    const bytes = range ? object.bytes.slice(range.offset, range.offset + range.length) : object.bytes.slice(0);
    return {
      key,
      size: object.bytes.byteLength,
      httpMetadata: object.httpMetadata,
      customMetadata: object.customMetadata,
      body: new Response(bytes).body!,
      arrayBuffer: async () => bytes.slice(0),
    };
  }

  async put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | string | ReadableStream<Uint8Array>,
    options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> },
  ) {
    const bytes = value instanceof ReadableStream
      ? await new Response(value).arrayBuffer()
      : typeof value === "string"
      ? (new TextEncoder().encode(value).buffer as ArrayBuffer)
      : value instanceof ArrayBuffer
        ? value
        : (value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer);
    this.objects.set(key, { bytes, httpMetadata: options?.httpMetadata, customMetadata: options?.customMetadata });
    return { key };
  }

  async delete(key: string) {
    this.objects.delete(key);
  }

  async head(key: string) {
    const object = this.objects.get(key);
    if (!object) return null;
    return { key, size: object.bytes.byteLength, httpMetadata: object.httpMetadata, customMetadata: object.customMetadata };
  }
}
