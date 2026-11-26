/** The zip a backup is written as (backup/zip.ts): written as it streams, read back by parts. */
import { describe, expect, it } from "vitest";
import { crc32, readEntry, readZipDirectory, ZipError, ZipWriter } from "../src/backup/zip";

async function zipOf(add: (zip: ZipWriter) => Promise<void>): Promise<Uint8Array> {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const zip = new ZipWriter(writer);
  const done = (async () => {
    await add(zip);
    await zip.finish();
  })().catch(async (error) => {
    await writer.abort(error).catch(() => undefined);
    throw error;
  });
  const read = new Response(readable).arrayBuffer().catch(() => new ArrayBuffer(0));
  await done;
  return new Uint8Array(await read);
}

const readAtOf = (bytes: Uint8Array) => async (offset: number, length: number) => bytes.slice(offset, offset + length);

describe("backup zip", () => {
  it("knows the CRC-32 every zip program checks", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    expect(crc32(new TextEncoder().encode("6789"), crc32(new TextEncoder().encode("12345")))).toBe(0xcbf43926);
  });

  it("reads back text, bytes and a stream, each by its name", async () => {
    const big = new Uint8Array(300_000).map((_, i) => i % 251);
    const bytes = await zipOf(async (zip) => {
      await zip.add("manifest.json", '{"a":1}');
      await zip.add("files/assets/x", new Uint8Array([1, 2, 3]));
      await zip.add("files/video", new Response(big).body!);
      await zip.add("ü/name.txt", "");
    });
    const entries = await readZipDirectory(bytes.length, readAtOf(bytes));
    expect([...entries.keys()]).toEqual(["manifest.json", "files/assets/x", "files/video", "ü/name.txt"]);
    expect(new TextDecoder().decode(await readEntry(entries.get("manifest.json")!, readAtOf(bytes)))).toBe('{"a":1}');
    expect([...(await readEntry(entries.get("files/assets/x")!, readAtOf(bytes)))]).toEqual([1, 2, 3]);
    expect(await readEntry(entries.get("files/video")!, readAtOf(bytes))).toEqual(big);
    expect((await readEntry(entries.get("ü/name.txt")!, readAtOf(bytes))).length).toBe(0);
  });

  it("says a file is not a zip, and finds a damaged entry", async () => {
    await expect(readZipDirectory(5, readAtOf(new Uint8Array(5)))).rejects.toBeInstanceOf(ZipError);
    await expect(readZipDirectory(100, readAtOf(new Uint8Array(100)))).rejects.toBeInstanceOf(ZipError);
    const bytes = await zipOf((zip) => zip.add("a.txt", "hello"));
    const entries = await readZipDirectory(bytes.length, readAtOf(bytes));
    const broken = bytes.slice();
    broken[30 + "a.txt".length] = "j".charCodeAt(0);
    await expect(readEntry(entries.get("a.txt")!, readAtOf(broken))).rejects.toThrow(/damaged/);
  });

  it("refuses the same name twice", async () => {
    await expect(
      zipOf(async (zip) => {
        await zip.add("a", "1");
        await zip.add("a", "2");
      }),
    ).rejects.toThrow(/already/);
  });
});
