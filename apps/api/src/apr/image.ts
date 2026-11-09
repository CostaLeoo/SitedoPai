import { createHash } from 'node:crypto';
import sharp from 'sharp';

export const MAX_PHOTO_BYTES = 15 * 1024 * 1024;

export type ImageCheck =
  | { ok: true; mime: string; display: Buffer; sha256: string; width: number; height: number }
  | { ok: false; code: 'TOO_LARGE' | 'UNSUPPORTED_TYPE' | 'HEIC_NOT_SUPPORTED' | 'INVALID_IMAGE'; message: string };

/** Identifica o tipo real pelos primeiros bytes; a extensão e o Content-Type enviados são ignorados. */
export function sniff(buf: Buffer): 'image/jpeg' | 'image/png' | 'image/webp' | 'image/heic' | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.length >= 12 && buf.toString('ascii', 4, 8) === 'ftyp' && /^(heic|heix|hevc|mif1|msf1)$/.test(buf.toString('ascii', 8, 12))) return 'image/heic';
  return null;
}

/**
 * Valida a foto e gera a cópia de exibição: decodifica de verdade (arquivo
 * disfarçado de imagem falha aqui), corrige a orientação, limita a 1600 px e
 * reencoda em JPEG SEM metadados (sem EXIF/GPS). O original é guardado à parte,
 * intacto, para fins probatórios.
 */
export async function processPhoto(buf: Buffer): Promise<ImageCheck> {
  if (buf.length > MAX_PHOTO_BYTES) return { ok: false, code: 'TOO_LARGE', message: 'A foto passa de 15 MB.' };
  const mime = sniff(buf);
  if (mime === 'image/heic') {
    return { ok: false, code: 'HEIC_NOT_SUPPORTED', message: 'Fotos HEIC ainda não são aceitas. Envie em JPEG (no iPhone: Ajustes › Câmera › Formatos › Mais compatível).' };
  }
  if (!mime) return { ok: false, code: 'UNSUPPORTED_TYPE', message: 'Envie uma foto em JPEG, PNG ou WebP.' };
  try {
    const img = sharp(buf, { limitInputPixels: 60_000_000, failOn: 'error' });
    const meta = await img.metadata();
    if (!meta.width || !meta.height) throw new Error('sem dimensões');
    const display = await img.rotate().resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 82, mozjpeg: true }).toBuffer();
    return { ok: true, mime, display, sha256: createHash('sha256').update(buf).digest('hex'), width: meta.width, height: meta.height };
  } catch {
    return { ok: false, code: 'INVALID_IMAGE', message: 'Não foi possível ler a imagem. Tire a foto novamente.' };
  }
}
