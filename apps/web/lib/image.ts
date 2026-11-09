'use client';
export const MAX_BYTES = 15 * 1024 * 1024;

/**
 * Prepara a foto para envio. JPEG, PNG e WebP vão como estão (o original é a
 * prova). HEIC (iPhone) é convertido para JPEG quando o navegador consegue
 * abrir; caso contrário, a pessoa recebe instrução clara.
 */
export async function preparePhoto(file: File): Promise<{ blob: Blob; name: string; converted: boolean }> {
  if (file.size > MAX_BYTES) throw new Error('A foto passa de 15 MB. Tire outra com resolução menor.');
  const isHeic = /image\/hei[cf]/i.test(file.type) || /\.(heic|heif)$/i.test(file.name);
  if (!isHeic) return { blob: file, name: file.name || 'foto.jpg', converted: false };
  try {
    const bitmap = await createImageBitmap(file);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.92));
    if (!blob) throw new Error();
    return { blob, name: file.name.replace(/\.(heic|heif)$/i, '.jpg'), converted: true };
  } catch {
    throw new Error('Este aparelho não converteu a foto HEIC. No iPhone: Ajustes › Câmera › Formatos › Mais compatível.');
  }
}
