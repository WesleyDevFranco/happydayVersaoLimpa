import "server-only";

import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, normalize, resolve, sep } from "node:path";
import sharp, { type Metadata, type OutputInfo } from "sharp";

import { env } from "@/lib/env";

/** Largest edge kept for a full-size photo. Beyond this nobody can tell. */
const MAX_EDGE = 2000;
/** Gallery thumbnails and mini-card covers. */
const THUMB_EDGE = 480;
/** JPEG quality — 82 is the point where artifacts stop being visible. */
const QUALITY = 82;

/** Hard cap on an incoming file. Phone photos are 3–8 MB; 15 is generous. */
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

/**
 * Refuses absurd pixel counts before decoding.
 *
 * A 200 KB PNG can declare 60000×60000 and expand to tens of gigabytes when
 * decoded — the classic decompression bomb. sharp reads the header first and
 * throws if the declared size exceeds this, so we never allocate the buffer.
 */
const MAX_INPUT_PIXELS = 60_000_000;

export interface StoredImage {
  /** Path relative to UPLOAD_DIR, as stored in the photos table. */
  path: string;
  thumbPath: string;
  width: number;
  height: number;
  bytes: number;
  /** "#rrggbb", precomputed for the player's gradient. */
  dominantColor: string;
}

export class UploadError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "UploadError";
  }
}

/**
 * Resolves a relative storage path to an absolute one, refusing anything
 * that escapes UPLOAD_DIR.
 *
 * Every caller passes a path that came, however indirectly, from a request.
 * `../../etc/passwd` must not resolve — checking the resolved prefix is the
 * only reliable way, since normalize() alone still allows escaping.
 */
export function resolveUploadPath(relativePath: string): string {
  const root = resolve(env.UPLOAD_DIR);
  const target = resolve(root, normalize(relativePath));

  if (target !== root && !target.startsWith(root + sep)) {
    throw new UploadError("caminho inválido", 400);
  }
  return target;
}

type ImageFormat = "jpeg" | "png" | "webp" | "heic";

const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * `ftyp` brands that mean HEVC inside a HEIF container. `mif1` stays out on
 * purpose: it only says "some HEIF image", and AVIF files carry it too.
 */
const HEIC_BRANDS = new Set([
  "heic",
  "heix",
  "hevc",
  "hevx",
  "heim",
  "heis",
  "hevm",
  "hevs",
]);

/** Real `ftyp` boxes are under 100 bytes; no reason to walk a giant one. */
const MAX_FTYP_BYTES = 256;

/**
 * Names the format from the file's leading bytes, or null if we don't take it.
 *
 * sharp picks a decoder by looking at the content, and it carries several we
 * never want exposed to strangers — librsvg for SVG above all. Even
 * `metadata()` runs them, so this has to happen first. Anyone can reach this
 * code: a draft's editToken is free to mint.
 */
function sniffImageFormat(input: Buffer): ImageFormat | null {
  if (input.subarray(0, 3).equals(JPEG_MAGIC)) return "jpeg";
  if (input.subarray(0, 8).equals(PNG_MAGIC)) return "png";

  if (
    input.toString("latin1", 0, 4) === "RIFF" &&
    input.toString("latin1", 8, 12) === "WEBP"
  ) {
    return "webp";
  }

  if (input.toString("latin1", 4, 8) === "ftyp") {
    const isHeicBrand = (at: number) =>
      HEIC_BRANDS.has(input.toString("latin1", at, at + 4));

    // Major brand at 8, minor version at 12, compatible brands from 16 on.
    if (isHeicBrand(8)) return "heic";
    const end = Math.min(
      input.readUInt32BE(0),
      MAX_FTYP_BYTES,
      input.byteLength,
    );
    for (let at = 16; at + 4 <= end; at += 4) {
      if (isHeicBrand(at)) return "heic";
    }
  }

  return null;
}

/**
 * Validates, normalizes and stores one uploaded image.
 *
 * The pipeline, in order and for a reason:
 *
 *  1. Check the leading bytes against the formats we accept. A client's
 *     Content-Type is just a claim, and this is what keeps an SVG named
 *     `.jpg` away from sharp's decoders.
 *  2. `sharp()` parses the bytes. A `.jpg` that isn't an image dies here.
 *  3. `.rotate()` bakes in EXIF orientation. It has to happen *before*
 *     metadata is dropped, or every photo shot in portrait comes out sideways.
 *  4. Resize down (never up) to MAX_EDGE.
 *  5. Re-encode as JPEG. sharp writes no metadata unless asked, so the EXIF
 *     block — camera, timestamps, and the **GPS coordinates of someone's
 *     home** — is gone. That matters more here than anywhere: these are
 *     photos of a couple, uploaded to a link that gets forwarded around.
 *  6. Name the file by the hash of the *processed* bytes, which makes the
 *     URL immutable (safe to cache forever) and dedupes re-uploads for free.
 */
export async function storeImage(
  siteId: string,
  input: Buffer,
): Promise<StoredImage> {
  if (input.byteLength === 0) {
    throw new UploadError("arquivo vazio");
  }
  if (input.byteLength > MAX_UPLOAD_BYTES) {
    throw new UploadError("imagem maior que 15 MB", 413);
  }

  const format = sniffImageFormat(input);
  if (!format) {
    throw new UploadError(
      "formato não aceito — envie JPG, PNG, WebP ou HEIC",
      415,
    );
  }

  const pipeline = sharp(input, { limitInputPixels: MAX_INPUT_PIXELS });

  let meta: Metadata;
  try {
    meta = await pipeline.metadata();
  } catch {
    throw new UploadError("não consegui ler essa imagem — envie JPG, PNG, WebP ou HEIC");
  }

  if (!meta.width || !meta.height) {
    throw new UploadError("imagem sem dimensões válidas");
  }

  let full: { data: Buffer; info: OutputInfo };
  let thumb: Buffer;
  try {
    full = await pipeline
      .rotate()
      .resize(MAX_EDGE, MAX_EDGE, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: QUALITY, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });

    thumb = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS })
      .rotate()
      .resize(THUMB_EDGE, THUMB_EDGE, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 78, mozjpeg: true })
      .toBuffer();
  } catch {
    // A corrupt file can pass metadata() and only die when decoded. So does
    // every real HEIC: sharp's prebuilt libvips reads the header but ships no
    // HEVC decoder.
    throw new UploadError(
      format === "heic"
        ? "não consegui converter essa foto HEIC — envie em JPG, PNG ou WebP"
        : "não consegui ler essa imagem — envie JPG, PNG, WebP ou HEIC",
    );
  }

  const hash = createHash("sha256")
    .update(full.data)
    .digest("hex")
    .slice(0, 32);

  const relDir = join("sites", siteId);
  const path = join(relDir, `${hash}.jpg`);
  const thumbPath = join(relDir, `${hash}_t.jpg`);

  const absPath = resolveUploadPath(path);
  await mkdir(dirname(absPath), { recursive: true });
  await writeFile(absPath, full.data);
  await writeFile(resolveUploadPath(thumbPath), thumb);

  return {
    path,
    thumbPath,
    width: full.info.width,
    height: full.info.height,
    bytes: full.data.byteLength,
    dominantColor: await dominantColor(full.data),
  };
}

/**
 * The image's dominant color, for the player background gradient.
 *
 * Computed here rather than in the browser so an uploaded photo behaves
 * like a bundled one — `useImagePalette` needs the pixels on a canvas,
 * which costs a decode on every page load.
 */
async function dominantColor(jpeg: Buffer): Promise<string> {
  try {
    const { dominant } = await sharp(jpeg).stats();
    const hex = (n: number) => n.toString(16).padStart(2, "0");
    return `#${hex(dominant.r)}${hex(dominant.g)}${hex(dominant.b)}`;
  } catch {
    // A color is a nicety; failing the whole upload over it would not be.
    return "#1db954";
  }
}

/** Deletes every stored file for a site. Used when a draft is swept. */
export async function deleteSiteFiles(siteId: string): Promise<void> {
  await rm(resolveUploadPath(join("sites", siteId)), {
    recursive: true,
    force: true,
  });
}

/** The public URL a stored path is served at. */
export function mediaUrl(relativePath: string): string {
  return `/api/media/${relativePath.split(sep).join("/")}`;
}
