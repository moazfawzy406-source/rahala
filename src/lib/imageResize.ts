export async function resizeImageForUpload(
  file: File,
  maxLongestSide: number,
  quality = 0.86
): Promise<{ blob: Blob; filename: string }> {
  // Keep animated GIFs untouched if within size; resize static PNG/JPEG/WebP
  if (file.type === 'image/gif') {
    return { blob: file, filename: file.name };
  }

  const bitmapUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('تعذر قراءة الصورة'));
      el.src = bitmapUrl;
    });

    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if (!w || !h) {
      return { blob: file, filename: file.name };
    }

    const longest = Math.max(w, h);
    const scale = longest > maxLongestSide ? maxLongestSide / longest : 1;
    const targetW = Math.max(1, Math.round(w * scale));
    const targetH = Math.max(1, Math.round(h * scale));

    // If no scaling needed and file is already compact (< 1.5MB), keep original
    if (scale === 1 && file.size <= 1_500_000) {
      return { blob: file, filename: file.name };
    }

    const canvas = document.createElement('canvas');
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return { blob: file, filename: file.name };
    }
    ctx.drawImage(img, 0, 0, targetW, targetH);

    const targetMime = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('تعذر ضغط الصورة'))),
        targetMime,
        quality
      );
    });

    const ext = targetMime === 'image/png' ? '.png' : '.jpg';
    const base = file.name.replace(/\.[^.]+$/, '') || 'image';
    return { blob, filename: `${base}${ext}` };
  } finally {
    URL.revokeObjectURL(bitmapUrl);
  }
}
