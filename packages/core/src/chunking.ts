// Document normalization and bounded chunking for knowledge ingestion.
const MAX_CHUNKS = 4000;
const CHUNK_SIZE = 1200;
const MARKDOWN_IMAGE_DATA_URI_REGEX = /!\[[^\]]*]\(\s*data:[^)]+\)/gi;
const DATA_URI_REGEX = /data:[^;\s)]+;base64,[a-z0-9+/=\s]+/gi;
const LONG_BASE64_TOKEN_REGEX = /\b[A-Za-z0-9+/]{300,}={0,2}\b/g;

function normalizeText(text: string) {
  return text
    .replace(/\u0000/g, ' ')
    .replace(/\u00a0/g, ' ')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function sanitizeExtractedText(text: string) {
  return normalizeText(
    text
      .replace(MARKDOWN_IMAGE_DATA_URI_REGEX, ' ')
      .replace(DATA_URI_REGEX, ' ')
      .replace(LONG_BASE64_TOKEN_REGEX, ' '),
  );
}

function countSignalWords(text: string) {
  return text
    .split(/\s+/)
    .map((token) => token.replace(/[^a-z0-9]/gi, ''))
    .filter((token) => token.length >= 2).length;
}

function normalizeExtractedText(text: string, options?: { forImage?: boolean }) {
  const cleaned = sanitizeExtractedText(text);
  if (!cleaned) return '';
  if (!options?.forImage) return cleaned;
  if (cleaned.length >= 48) return cleaned;
  if (countSignalWords(cleaned) >= 8) return cleaned;
  return '';
}

function splitLongSegment(segment: string, maxLength: number) {
  const cleaned = segment.trim();
  if (!cleaned) return [] as string[];
  if (cleaned.length <= maxLength) return [cleaned];

  const slices: string[] = [];
  let start = 0;
  while (start < cleaned.length) {
    let end = Math.min(cleaned.length, start + maxLength);
    if (end < cleaned.length) {
      const boundary = cleaned.lastIndexOf(' ', end);
      if (boundary > start + Math.floor(maxLength * 0.6)) {
        end = boundary;
      }
    }
    const part = cleaned.slice(start, end).trim();
    if (part) slices.push(part);
    start = end;
  }
  return slices;
}

function buildChunkUnits(text: string) {
  const paragraphUnits = text
    .split(/\n{2,}/)
    .map((unit) => unit.trim())
    .filter(Boolean);
  const baseUnits =
    paragraphUnits.length > 1
      ? paragraphUnits
      : text
          .split('\n')
          .map((unit) => unit.trim())
          .filter(Boolean);

  const maxUnitLength = Math.max(240, Math.floor(CHUNK_SIZE * 0.75));
  const units: string[] = [];
  for (const unit of baseUnits) {
    units.push(...splitLongSegment(unit, maxUnitLength));
  }
  return units;
}

// Repetitive tables and numbered records still contain useful knowledge.
// Preserve every non-empty chunk instead of discarding repeated vocabulary.
function isLowSignalChunk(text: string) {
  return !text.trim();
}

export function chunkText(text: string) {
  const normalized = normalizeText(text);
  if (!normalized) return [] as string[];

  const units = buildChunkUnits(normalized);
  if (units.length === 0) return [] as string[];

  const chunks: string[] = [];
  let current = '';

  const pushChunk = (value: string) => {
    const cleaned = normalizeText(value);
    if (!cleaned) return;
    if (isLowSignalChunk(cleaned)) return;
    if (chunks.length > 0 && chunks[chunks.length - 1] === cleaned) return;
    chunks.push(cleaned);
  };

  for (const unit of units) {
    if (chunks.length >= MAX_CHUNKS) break;
    const candidate = current ? `${current}\n${unit}` : unit;
    if (candidate.length <= CHUNK_SIZE) {
      current = candidate;
      continue;
    }

    if (current) {
      pushChunk(current);
      if (chunks.length >= MAX_CHUNKS) break;
    }

    if (unit.length >= CHUNK_SIZE) {
      const longParts = splitLongSegment(unit, CHUNK_SIZE);
      for (let index = 0; index < longParts.length && chunks.length < MAX_CHUNKS; index += 1) {
        pushChunk(longParts[index]);
      }
      current = '';
      continue;
    }

    current = unit;
  }

  if (current && chunks.length < MAX_CHUNKS) {
    pushChunk(current);
  }

  if (chunks.length >= MAX_CHUNKS)
    throw new Error('Document exceeds the chunk limit; split it into smaller files.');
  return chunks;
}
