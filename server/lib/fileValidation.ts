import type { AssetKind } from '../../shared/types.ts';

export interface DetectedFileInfo {
  kind: AssetKind;
  mime: string;
  extension: string;
}

function startsWith(buf: Buffer, bytes: number[], offset = 0): boolean {
  if (buf.length < offset + bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) {
    if (buf[offset + i] !== bytes[i]) return false;
  }
  return true;
}

function asciiAt(buf: Buffer, offset: number, text: string): boolean {
  if (buf.length < offset + text.length) return false;
  return buf.subarray(offset, offset + text.length).toString('ascii') === text;
}

/**
 * Parses ZIP Central Directory entries safely to inspect OOXML structure
 * without trusting file extensions or generic application/zip MIME.
 */
function listZipEntryNames(buf: Buffer): string[] | null {
  if (buf.length < 22) return null;
  if (!startsWith(buf, [0x50, 0x4b, 0x03, 0x04])) return null;

  // Locate End of Central Directory (PK\x05\x06) scanning backwards up to 65KB
  const minOffset = Math.max(0, buf.length - 65557);
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= minOffset; i--) {
    if (
      buf[i] === 0x50 &&
      buf[i + 1] === 0x4b &&
      buf[i + 2] === 0x05 &&
      buf[i + 3] === 0x06
    ) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) return null;

  const totalEntries = buf.readUInt16LE(eocdOffset + 10);
  const cdSize = buf.readUInt32LE(eocdOffset + 12);
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);

  if (cdOffset + cdSize > eocdOffset || totalEntries > 10000) {
    return null;
  }

  const names: string[] = [];
  let cursor = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (cursor + 46 > cdOffset + cdSize) return null;
    if (
      buf[cursor] !== 0x50 ||
      buf[cursor + 1] !== 0x4b ||
      buf[cursor + 2] !== 0x01 ||
      buf[cursor + 3] !== 0x02
    ) {
      return null;
    }
    const nameLen = buf.readUInt16LE(cursor + 28);
    const extraLen = buf.readUInt16LE(cursor + 30);
    const commentLen = buf.readUInt16LE(cursor + 32);
    const nameStart = cursor + 46;
    const nameEnd = nameStart + nameLen;
    if (nameEnd > cdOffset + cdSize) return null;
    names.push(buf.subarray(nameStart, nameEnd).toString('utf8'));
    cursor = nameEnd + extraLen + commentLen;
  }

  return names;
}

export function detectAndValidateFile(
  buf: Buffer,
  options: { allowOfficeAndPdf: boolean; allowAudio: boolean; allowImage: boolean }
): DetectedFileInfo | null {
  if (!buf || buf.length < 4) return null;

  // Explicitly block executables and HTML/SVG script payloads
  if (startsWith(buf, [0x4d, 0x5a]) || startsWith(buf, [0x7f, 0x45, 0x4c, 0x46])) {
    return null;
  }
  const headText = buf.subarray(0, Math.min(buf.length, 256)).toString('utf8').trimStart().toLowerCase();
  if (headText.startsWith('<!doctype') || headText.startsWith('<html') || headText.startsWith('<svg') || headText.startsWith('<script')) {
    return null;
  }

  // Images
  if (options.allowImage) {
    if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
      return { kind: 'image', mime: 'image/png', extension: '.png' };
    }
    if (startsWith(buf, [0xff, 0xd8, 0xff])) {
      return { kind: 'image', mime: 'image/jpeg', extension: '.jpg' };
    }
    if (asciiAt(buf, 0, 'RIFF') && asciiAt(buf, 8, 'WEBP')) {
      return { kind: 'image', mime: 'image/webp', extension: '.webp' };
    }
    if (asciiAt(buf, 0, 'GIF87a') || asciiAt(buf, 0, 'GIF89a')) {
      return { kind: 'image', mime: 'image/gif', extension: '.gif' };
    }
  }

  // PDF (ISO 32000 allows %PDF- within first 1024 bytes, e.g. after UTF-8 BOM or whitespace)
  if (options.allowOfficeAndPdf) {
    const pdfHead = buf.subarray(0, Math.min(buf.length, 1024)).toString('latin1');
    if (pdfHead.includes('%PDF-')) {
      const tail = buf.subarray(Math.max(0, buf.length - 65536)).toString('latin1');
      if (tail.includes('%%EOF')) {
        return { kind: 'pdf', mime: 'application/pdf', extension: '.pdf' };
      }
      return null; // Reject truncated PDF
    }
  }

  // Office Open XML (DOCX, PPTX, XLSX)
  if (options.allowOfficeAndPdf && startsWith(buf, [0x50, 0x4b, 0x03, 0x04])) {
    const entries = listZipEntryNames(buf);
    if (!entries) return null;
    const hasContentTypes = entries.includes('[Content_Types].xml');
    if (!hasContentTypes) return null;

    if (entries.some((e) => e === 'word/document.xml')) {
      return {
        kind: 'office',
        mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        extension: '.docx',
      };
    }
    if (entries.some((e) => e === 'ppt/presentation.xml')) {
      return {
        kind: 'office',
        mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        extension: '.pptx',
      };
    }
    if (entries.some((e) => e === 'xl/workbook.xml')) {
      return {
        kind: 'office',
        mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        extension: '.xlsx',
      };
    }
    // Reject generic ZIP archives masquerading as Office documents
    return null;
  }

  // Audio formats
  if (options.allowAudio) {
    if (startsWith(buf, [0x1a, 0x45, 0xdf, 0xa3])) {
      return { kind: 'audio', mime: 'audio/webm', extension: '.webm' };
    }
    if (asciiAt(buf, 0, 'OggS')) {
      return { kind: 'audio', mime: 'audio/ogg', extension: '.ogg' };
    }
    if (asciiAt(buf, 0, 'RIFF') && asciiAt(buf, 8, 'WAVE')) {
      return { kind: 'audio', mime: 'audio/wav', extension: '.wav' };
    }
    if (
      asciiAt(buf, 0, 'ID3') ||
      (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)
    ) {
      return { kind: 'audio', mime: 'audio/mpeg', extension: '.mp3' };
    }
    if (asciiAt(buf, 4, 'ftyp')) {
      return { kind: 'audio', mime: 'audio/mp4', extension: '.m4a' };
    }
  }

  return null;
}
