const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const DEFAULT_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5-coder:7b-instruct';
const DEFAULT_URL = process.env.OLLAMA_URL || 'http://localhost:11434';

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
const question = getArg('--question', null) || getArg('-q', null);
const model = getArg('--model', DEFAULT_MODEL);
const embedModel = getArg('--embed-model', 'nomic-embed-text');
const maxDepth = toInt(getArg('--max-depth', '3'), 3);
const maxFiles = toInt(getArg('--max-files', '80'), 80);
const maxBytes = toInt(getArg('--max-bytes', '12000'), 12000);
const numCtx = toInt(getArg('--ctx', '4096'), 4096);
const numPredict = toInt(getArg('--predict', '256'), 256);
const dryRun = process.argv.includes('--dry-run');
const dumpPath = getArg('--dump', null);
const rgIncludeArg = getArg('--rg-include', null);
const rgExcludeArg = getArg('--rg-exclude', null);
const useRag = process.argv.includes('--rag');
const ragIndexPath = getArg('--rag-index', null);
const ragTopK = toInt(getArg('--rag-topk', '5'), 5);
const includeFilesArg = getArg('--include-files', null);

if (!question) {
  console.error('Missing --question "..."');
  process.exit(1);
}

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

function listTree(root, depth, limit) {
  const results = [];
  function walk(dir, currentDepth) {
    if (results.length >= limit) return;
    if (currentDepth > depth) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= limit) break;
      if (entry.name.startsWith('.DS_Store')) continue;
      if (IGNORE_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full);
      if (entry.isDirectory()) {
        results.push(rel + path.sep);
        walk(full, currentDepth + 1);
      } else {
        results.push(rel);
      }
    }
  }
  walk(root, 1);
  return results;
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

function loadSystemPrompt() {
  const promptPath = path.join(__dirname, '..', 'prompts', 'agent.md');
  const text = readFileSafe(promptPath, 20000);
  if (!text) {
    return 'You are a coding assistant. Use only provided context. Ask for files or searches if needed.';
  }
  return text.replace(/^SYSTEM:\s*/i, '').trim();
}

function extractKeywords(text) {
  const words = text.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) || [];
  const stop = new Set(['the','and','para','que','como','donde','what','why','this','that','with','from','por','una','uno','las','los']);
  const filtered = [];
  for (const w of words) {
    if (w.length < 3) continue;
    if (stop.has(w)) continue;
    if (!filtered.includes(w)) filtered.push(w);
    if (filtered.length >= 6) break;
  }
  return filtered;
}

function containsKeyword(text, keywords) {
  if (!keywords.length) return true;
  const lower = text.toLowerCase();
  return keywords.some((k) => lower.includes(k));
}

function truncateLines(text, maxLines) {
  const lines = text.split(/\r?\n/);
  if (lines.length <= maxLines) return text;
  return lines.slice(0, maxLines).join('\n') + '\n...[truncated]';
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function rgAvailable() {
  try {
    const r = spawnSync('rg', ['--version'], { stdio: 'ignore' });
    return r.status === 0;
  } catch {
    return false;
  }
}

function splitGlobArg(value) {
  if (!value) return [];
  return value.split(',').map((v) => v.trim()).filter(Boolean);
}

function detectPreferredRoots(root) {
  const candidates = ['src', 'lib', 'app'];
  return candidates.filter((dir) => {
    try {
      return fs.statSync(path.join(root, dir)).isDirectory();
    } catch {
      return false;
    }
  });
}

function runRipgrep(root, query, includeGlobs, excludeGlobs) {
  if (!rgAvailable()) return 'rg not available';
  if (!query) return 'rg skipped (no keywords)';
  const pattern = query.split('|').map(escapeRegex).join('|');
  const args = ['-n', '-S', '--max-count', '3', '--max-columns', '200'];

  // Excludes
  const excludes = ['!.git/*', '!node_modules/**', '!**/node_modules/**']
    .concat(excludeGlobs.map((g) => g.startsWith('!') ? g : `!${g}`));
  for (const glob of excludes) {
    args.push('--glob', glob);
  }

  // Includes (if any). When provided, rg limits the search to these globs.
  for (const glob of includeGlobs) {
    args.push('--glob', glob);
  }

  args.push(pattern, root);
  try {
    const r = spawnSync('rg', args, { encoding: 'utf8', maxBuffer: 200000 });
    if (r.status !== 0 && !r.stdout) return 'rg no matches';
    return r.stdout ? r.stdout.trim() : 'rg no matches';
  } catch (err) {
    return `rg error: ${err.message}`;
  }
}

function parseRipgrepMatches(rgOutput) {
  if (!rgOutput) return [];
  if (rgOutput.startsWith('rg ')) return [];
  const matches = [];
  const lines = rgOutput.split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^(.+?):(\d+):(.*)$/);
    if (!m) continue;
    const lineNum = Number(m[2]);
    if (!Number.isFinite(lineNum)) continue;
    matches.push({ file: m[1], line: lineNum });
  }
  return matches;
}

function scoreMatch(root, filePath) {
  const rel = path.relative(root, filePath).replace(/\\/g, '/');
  const parts = rel.split('/');
  let score = 0;
  if (parts[0] === 'src' || parts[0] === 'lib' || parts[0] === 'app') score += 3;
  if (rel.includes('/lib/')) score += 2;
  if (rel.includes('/src/')) score += 2;
  if (rel.includes('/app/')) score += 1;
  return score;
}

function buildSnippets(root, matches, maxSnippets = 6, contextLines = 3) {
  const snippets = [];
  const seen = new Set();
  const sorted = matches.slice().sort((a, b) => {
    const scoreA = scoreMatch(root, a.file);
    const scoreB = scoreMatch(root, b.file);
    return scoreB - scoreA;
  });

  for (const match of sorted) {
    if (snippets.length >= maxSnippets) break;
    const key = `${match.file}:${match.line}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const text = readFileSafe(match.file, maxBytes);
    if (!text) continue;
    const lines = text.split(/\r?\n/);
    const idx = Math.max(match.line - 1, 0);
    const start = Math.max(idx - contextLines, 0);
    const end = Math.min(idx + contextLines, lines.length - 1);
    const excerpt = [];
    for (let i = start; i <= end; i++) {
      excerpt.push(`${i + 1}: ${lines[i]}`);
    }
    const rel = path.relative(root, match.file);
    snippets.push(`--- ${rel} (match at ${match.line}) ---\n${excerpt.join('\n')}`);
  }

  return snippets;
}

function loadRagIndex(indexPath) {
  try {
    const raw = fs.readFileSync(indexPath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function cosineSim(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

function pathBoost(root, filePath) {
  const rel = path.relative(root, filePath).replace(/\\/g, '/');
  let score = 0;
  if (rel.startsWith('src/') || rel.startsWith('lib/') || rel.startsWith('app/')) score += 0.08;
  if (rel.includes('/lib/')) score += 0.04;
  if (rel.includes('/src/')) score += 0.04;
  if (rel.includes('/app/')) score += 0.02;
  const ext = path.extname(rel).toLowerCase();
  const codeExts = new Set(['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java', '.kt', '.cs', '.cpp', '.c', '.rb', '.php', '.swift']);
  const docExts = new Set(['.md', '.mdx', '.txt', '.pdf']);
  if (codeExts.has(ext)) score += 0.06;
  if (docExts.has(ext)) score -= 0.08;
  return score;
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

function stripFences(text) {
  let cleaned = text.replace(/```diff|```/g, '');
  cleaned = cleaned.replace(/^diff\s*[\r\n]/i, '');
  cleaned = cleaned.replace(/[\r\n]diff[\r\n]/ig, '\n');
  return cleaned;
}

async function retrieveRag(root, questionText) {
  const indexPath = ragIndexPath || path.join(root, '.forge', 'rag_index.json');
  const index = loadRagIndex(indexPath);
  if (!index || !Array.isArray(index.chunks) || index.chunks.length === 0) {
    return { results: [], notice: `RAG index not found. Run: node scripts/rag_index.js --repo "${root}"` };
  }

  const queryVec = normalize(await embedText(questionText));
  if (!queryVec) return { results: [], notice: 'RAG embedding failed.' };

  const scored = index.chunks.map((chunk) => {
    const score = cosineSim(queryVec, chunk.embedding) + pathBoost(root, chunk.file);
    return { score, chunk };
  }).sort((a, b) => b.score - a.score).slice(0, ragTopK);

  return { results: scored.map((s) => s.chunk), notice: null };
}

async function gatherContext() {
  const root = path.resolve(repoPath);
  const tree = listTree(root, maxDepth, maxFiles);

  const keyFiles = [
    'README.md', 'readme.md', 'package.json', 'tsconfig.json', 'jsconfig.json',
    'pyproject.toml', 'requirements.txt', 'Cargo.toml', 'go.mod', 'Makefile',
    '.env.example'
  ];

  const keywords = extractKeywords(question);
  const rgQuery = keywords.join('|');
  const keyFileContents = [];
  for (const file of keyFiles) {
    const full = path.join(root, file);
    const text = readFileSafe(full, maxBytes);
    if (!text) continue;
    if (!containsKeyword(text, keywords) && file.toLowerCase().includes('readme')) continue;
    const trimmed = truncateLines(text.trim(), 200);
    keyFileContents.push(`--- ${file} ---\n${trimmed}`);
  }

  const includeGlobs = splitGlobArg(rgIncludeArg);
  const excludeGlobs = splitGlobArg(rgExcludeArg);

  if (includeGlobs.length === 0) {
    const preferred = detectPreferredRoots(root);
    for (const dir of preferred) includeGlobs.push(`**/${dir}/**`);
  }

  const rgOutput = runRipgrep(root, rgQuery, includeGlobs, excludeGlobs);
  const rgMatches = parseRipgrepMatches(rgOutput);
  const rgSnippets = buildSnippets(root, rgMatches);

  const includeFiles = splitGlobArg(includeFilesArg);
  const includeFileContents = [];
  for (const rel of includeFiles) {
    const full = path.join(root, rel);
    const text = readFileSafe(full, maxBytes);
    if (text) {
      includeFileContents.push(`--- ${rel} ---\n${text.trim()}`);
    }
  }

  let ragResults = [];
  let ragNotice = null;
  if (useRag) {
    const rag = await retrieveRag(root, question);
    ragResults = rag.results;
    ragNotice = rag.notice;
  }

  return {
    root,
    tree,
    keyFileContents,
    rgOutput,
    rgSnippets,
    ragResults,
    ragNotice,
    includeFileContents
  };
}

async function chatWithOllama(systemPrompt, userContent) {
  const url = `${DEFAULT_URL}/api/chat`;
  const body = {
    model,
    stream: true,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent }
    ],
    options: {
      num_ctx: numCtx,
      num_predict: numPredict,
      temperature: 0.15
    }
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`HTTP ${res.status}: ${errText}`);
  }
  if (!res.body) throw new Error('No response body');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      const json = JSON.parse(line);
      if (json.message && json.message.content) {
        const cleaned = stripFences(json.message.content);
        process.stdout.write(cleaned);
      }
    }
  }
}

async function main() {
  const systemPrompt = loadSystemPrompt();
  const { root, tree, keyFileContents, rgOutput, rgSnippets, ragResults, ragNotice, includeFileContents } = await gatherContext();
  const hasIncludedFiles = includeFileContents.length > 0;

  const contextParts = [];
  if (useRag) {
    if (ragNotice) {
      contextParts.push(`RAG:\n${ragNotice}`);
    } else if (ragResults.length) {
      const ragText = ragResults.map((r) => {
        const rel = path.relative(root, r.file);
        return `--- ${rel} (lines ${r.startLine}-${r.endLine}) ---\n${r.text}`;
      }).join('\n\n');
      contextParts.push('RAG (semantic matches):\n' + ragText);
    }
  }

  if (hasIncludedFiles) {
    contextParts.push('Requested files:\n' + includeFileContents.join('\n\n'));
  } else if (rgSnippets.length) {
    contextParts.push('Snippets (rg matches):\n' + rgSnippets.join('\n\n'));
  } else {
    contextParts.push('Repo tree (limited):\n' + (tree.length ? tree.join('\n') : 'n/a'));
    contextParts.push('Search (rg):\n' + rgOutput);
    contextParts.push('Key files:\n' + (keyFileContents.length ? keyFileContents.join('\n\n') : 'n/a'));
  }

  const context = contextParts.join('\n\n');

  const userContent = [
    `Question: ${question}`,
    hasIncludedFiles
      ? '\nUse ONLY the provided context. Output ONLY a unified diff. If you need more files, reply with: NEED_FILES: <paths>.'
      : '\nUse ONLY the provided snippets. If the answer is not in the snippets, reply with: NEED_FILES: <paths>.',
    '\nContext:\n' + context
  ].join('\n');

  if (dryRun) {
    console.log('--- DRY RUN: context preview ---');
    console.log(userContent);
    if (dumpPath) {
      fs.writeFileSync(dumpPath, userContent, 'utf8');
      console.log(`--- Wrote context to ${dumpPath} ---`);
    }
    return;
  }

  await chatWithOllama(systemPrompt, userContent);
  process.stdout.write('\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
