const fs = require('fs');
const path = require('path');

const DEFAULT_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const DEFAULT_MODEL = process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text';

function getArg(name, fallback) {
  const idx = process.argv.indexOf(name);
  if (idx === -1 || idx + 1 >= process.argv.length) return fallback;
  return process.argv[idx + 1];
}

function toInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

const repoPath = getArg('--repo', process.cwd());
const outPath = getArg('--out', null);
const embedModel = getArg('--model', DEFAULT_MODEL);
const maxChars = toInt(getArg('--max-chars', '1200'), 1200);
const overlap = toInt(getArg('--overlap', '200'), 200);
const maxBytes = toInt(getArg('--max-bytes', '200000'), 200000);

const IGNORE_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', 'out', '.next', '.turbo',
  'venv', '.venv', '__pycache__', '.mypy_cache'
]);

function isTextBuffer(buf) {
  const sample = buf.slice(0, 2048);
  for (const byte of sample) {
    if (byte === 0) return false;
  }
  return true;
}

function readFileSafe(filePath, limitBytes) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > limitBytes) return null;
    const buf = fs.readFileSync(filePath);
    if (!isTextBuffer(buf)) return null;
    return buf.toString('utf8');
  } catch {
    return null;
  }
}

function collectFiles(root) {
  const results = [];
  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        results.push(full);
      }
    }
  }
  walk(root);
  return results;
}

function buildLineIndex(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

function lineAt(starts, index) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (starts[mid] <= index) {
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return Math.max(1, hi + 1);
}

function chunkText(text) {
  const chunks = [];
  if (!text) return chunks;
  const starts = buildLineIndex(text);
  let pos = 0;
  while (pos < text.length) {
    const end = Math.min(pos + maxChars, text.length);
    const slice = text.slice(pos, end).trim();
    if (slice) {
      const startLine = lineAt(starts, pos);
      const endLine = lineAt(starts, end);
      chunks.push({ text: slice, startLine, endLine });
    }
    if (end >= text.length) break;
    pos = end - overlap;
  }
  return chunks;
}

async function embedText(text) {
  const url = `${DEFAULT_URL}/api/embeddings`;
  const body = { model: embedModel, prompt: text };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`HTTP ${res.status}: ${errText}`);
  }
  const json = await res.json();
  return Array.isArray(json.embedding) ? json.embedding : null;
}

function normalize(vec) {
  if (!vec) return null;
  let sum = 0;
  for (const v of vec) sum += v * v;
  const norm = Math.sqrt(sum);
  if (!norm) return vec;
  return vec.map((v) => v / norm);
}

async function main() {
  const root = path.resolve(repoPath);
  const outFile = outPath || path.join(root, '.forge', 'rag_index.json');
  fs.mkdirSync(path.dirname(outFile), { recursive: true });

  const files = collectFiles(root);
  const chunks = [];

  for (const file of files) {
    const text = readFileSafe(file, maxBytes);
    if (!text) continue;
    const fileChunks = chunkText(text);
    for (const chunk of fileChunks) {
      chunks.push({ file, ...chunk });
    }
  }

  const indexed = [];
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    const embedding = normalize(await embedText(c.text));
    if (!embedding) continue;
    indexed.push({
      file: c.file,
      startLine: c.startLine,
      endLine: c.endLine,
      text: c.text,
      embedding
    });
    if ((i + 1) % 20 === 0) {
      console.log(`Embedded ${i + 1}/${chunks.length} chunks...`);
    }
  }

  const index = {
    version: 1,
    model: embedModel,
    repoPath: root,
    createdAt: new Date().toISOString(),
    chunks: indexed
  };

  fs.writeFileSync(outFile, JSON.stringify(index), 'utf8');
  console.log(`Wrote index: ${outFile}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
