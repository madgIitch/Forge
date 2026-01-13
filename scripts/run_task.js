const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

function getArg(name, fallback) {
  const idx = process.argv.indexOf(name);
  if (idx === -1 || idx + 1 >= process.argv.length) return fallback;
  return process.argv[idx + 1];
}

const repoPath = getArg('--repo', process.cwd());
const task = getArg('--task', null);
const overrideCmd = getArg('--cmd', null);
const maxErrors = Number(getArg('--max-errors', '10'));
const noParse = process.argv.includes('--no-parse');
const noAuto = process.argv.includes('--no-auto');
const noAutoWarn = process.argv.includes('--no-auto-warn');
const autoLoop = process.argv.includes('--auto') || (!noAuto && task === 'lint');
const autoWarn = process.argv.includes('--auto-warn') || (!noAutoWarn && task === 'lint');
const maxAttempts = Number(getArg('--attempts', task === 'lint' ? '3' : '2'));
const autoRetries = Number(getArg('--auto-retries', '2'));
const patchPath = getArg('--patch', path.join(repoPath, '.forge', 'auto.patch'));
let maxFiles = task === 'lint' ? 0 : 1;
const maxFilesArg = getArg('--auto-max-files', null);
if (maxFilesArg !== null) {
  const parsed = Number(maxFilesArg);
  if (Number.isFinite(parsed)) maxFiles = parsed;
}

if (!task && !overrideCmd) {
  console.error('Missing --task <lint|test|build> or --cmd "<command>"');
  process.exit(1);
}

const taskMap = {
  lint: 'npm run lint',
  test: 'npm test',
  build: 'npm run build'
};

const cmd = overrideCmd || taskMap[task];
if (!cmd) {
  console.error(`Unknown task: ${task}`);
  process.exit(1);
}

function extractErrorRefs(output) {
  const refs = [];
  const seen = new Set();

  const patterns = [
    /([A-Za-z]:\\[^:\r\n]+?\.[A-Za-z0-9]+):(\d+)(?::(\d+))?/g,
    /((?:\/[^:\r\n]+)+\.[A-Za-z0-9]+):(\d+)(?::(\d+))?/g
  ];

  for (const re of patterns) {
    let m;
    while ((m = re.exec(output)) !== null) {
      const file = m[1];
      const line = m[2];
      const col = m[3] || '';
      const key = `${file}:${line}:${col}`;
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push({ file, line, col });
    }
  }

  // Handle eslint/next lint style:
  // ./path/to/file.tsx
  // 12:34  Warning: ...
  const lines = output.split(/\r?\n/);
  for (let i = 0; i < lines.length - 1; i++) {
    const fileLine = lines[i].trim();
    const posLine = lines[i + 1].trim();
    if (!fileLine || !posLine) continue;
    if (fileLine.startsWith('./') || fileLine.match(/^[A-Za-z]:\\/)) {
      const m = posLine.match(/^(\d+):(\d+)/);
      if (!m) continue;
      const file = fileLine.replace(/^\.\//, '');
      const line = m[1];
      const col = m[2];
      const key = `${file}:${line}:${col}`;
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push({ file, line, col });
    }
  }

  return refs.slice(0, Number.isFinite(maxErrors) ? maxErrors : 10);
}

function toRepoRelative(root, filePath) {
  const full = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(root, filePath);
  const rootFull = path.resolve(root);
  if (!full.startsWith(rootFull + path.sep)) return null;
  return path.relative(rootFull, full).replace(/\\/g, '/');
}

function runCommand(command, cwd) {
  return spawnSync(command, { cwd, shell: true, encoding: 'utf8' });
}

function normalizePath(value) {
  return value.replace(/\\/g, '/');
}

function selectTargetFiles(files) {
  if (!Number.isFinite(maxFiles) || maxFiles <= 0) return files;
  return files.slice(0, maxFiles);
}

function isTargetLine(line, targetSet) {
  const cleaned = normalizePath(line.trim().replace(/^\.\//, ''));
  if (!cleaned) return false;
  if (targetSet.has(cleaned)) return true;
  for (const target of targetSet) {
    if (cleaned.endsWith('/' + target) || cleaned === target) return true;
  }
  return false;
}

function filterLintOutput(output, targetFiles) {
  const targetSet = new Set(targetFiles.map(normalizePath));
  const lines = output.split(/\r?\n/);
  const kept = [];
  let capturing = false;
  for (const line of lines) {
    if (isTargetLine(line, targetSet)) {
      capturing = true;
    }
    if (capturing) {
      kept.push(line);
      if (!line.trim()) capturing = false;
    }
  }
  const text = kept.join('\n').trim();
  return text.length ? text : output;
}

function buildFixPrompt(errorsText, strict, allowedFiles) {
  const allowed =
    allowedFiles && allowedFiles.length
      ? ['Allowed files:', ...allowedFiles.map((file) => `- ${file}`)].join('\n')
      : '';
  if (strict) {
    return [
      'OUTPUT ONLY a unified diff.',
      'Start with: --- a/<path> and +++ b/<path>.',
      'No prose, no markdown fences, no diff --git, no index.',
      'Fix ONLY the lint warnings in the listed file(s).',
      'Do NOT change JSX structure.',
      allowed,
      'If changes are needed outside the allowed files, output an empty patch.',
      'Errors:',
      errorsText
    ].filter(Boolean).join('\n');
  }
  return [
    'Output ONLY a unified diff (--- / +++).',
    'Do not include diff --git, index lines, or code fences.',
    'Fix ONLY the lint warnings in the listed file(s). Keep changes minimal.',
    'Do not change files not listed.',
    allowed,
    'Errors:',
    errorsText
  ].filter(Boolean).join('\n');
}

function runChatFix(root, refs, outputText) {
  const includeFiles = [];
  for (const r of refs) {
    const rel = toRepoRelative(root, r.file);
    if (rel && !includeFiles.includes(rel)) includeFiles.push(rel);
  }
  if (includeFiles.length === 0) return { ok: false, reason: 'No repo-local files found in errors.' };
  const targetFiles = selectTargetFiles(includeFiles);

  const filtered = task === 'lint' ? filterLintOutput(outputText, targetFiles) : outputText;
  const baseErrors = filtered.slice(0, 4000);

  const scriptPath = path.join(__dirname, 'forge_cli.js');
  const cfg = loadConfig(root);

  for (let attempt = 1; attempt <= autoRetries; attempt++) {
    const question = buildFixPrompt(baseErrors, attempt > 1, targetFiles);
    const args = [
      scriptPath,
      '--repo', root,
      '--include-files', targetFiles.join(','),
      '--max-bytes', '200000',
      '--question', question
    ];
    if (cfg.model) {
      args.push('--model', cfg.model);
    }
    if (cfg.ctx) {
      args.push('--ctx', String(cfg.ctx));
    }
    if (cfg.predict) {
      args.push('--predict', String(cfg.predict));
    }

    const result = spawnSync('node', args, { encoding: 'utf8' });
    if (result.status !== 0) {
      if (attempt === autoRetries) {
        return { ok: false, reason: result.stderr || 'forge_cli failed' };
      }
      continue;
    }

    const cleaned = cleanPatch(result.stdout || '');
    if (!isValidPatch(cleaned)) {
      if (attempt === autoRetries) {
        return { ok: false, reason: 'Patch output was invalid or incomplete.' };
      }
      continue;
    }
    const patchFiles = extractPatchFiles(cleaned);
    const allowed = new Set(targetFiles.map((f) => f.replace(/\\/g, '/')));
    const outside = patchFiles.filter((f) => !allowed.has(f));
    if (outside.length) {
      if (attempt === autoRetries) {
        return { ok: false, reason: `Patch touched unexpected files: ${outside.join(', ')}` };
      }
      continue;
    }
    fs.mkdirSync(path.dirname(patchPath), { recursive: true });
    fs.writeFileSync(patchPath, cleaned, 'utf8');
    return { ok: true, patchPath };
  }

  return { ok: false, reason: 'Patch generation failed after retries.' };
}

function applyPatch(root, patchFile) {
  const scriptPath = path.join(__dirname, 'apply_diff.js');
  const args = [scriptPath, '--repo', root, '--diff', patchFile, '--yes'];
  const result = spawnSync('node', args, { encoding: 'utf8' });
  return result.status === 0;
}

function loadConfig(root) {
  const configPath = path.join(root, '.forge', 'config.json');
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return {};
  }
}
function cleanPatch(text) {
  return text
    .replace(/```diff|```/g, '')
    .replace(/^\s*diff\s*$/gmi, '')
    .replace(/^diff --git .*$/gmi, '')
    .replace(/^index .*$/gmi, '')
    .trim() + '\n';
}

function isValidPatch(text) {
  return /^---\s.+\n\+\+\+\s.+/m.test(text);
}

function extractPatchFiles(text) {
  const files = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('--- ')) {
      const next = lines[i + 1] || '';
      if (!next.startsWith('+++ ')) continue;
      const file = next.replace(/^\+\+\+\s+/, '').trim().replace(/^b\//, '');
      if (file && file !== '/dev/null') files.push(file);
    }
  }
  return files;
}

let attempt = 1;
while (attempt <= maxAttempts) {
  console.log(`Running: ${cmd} (attempt ${attempt}/${maxAttempts})`);
  const result = runCommand(cmd, path.resolve(repoPath));

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

  if (!noParse) {
    const combined = `${result.stdout || ''}\n${result.stderr || ''}`;
    const refs = extractErrorRefs(combined);
    if (refs.length) {
      console.log('\nParsed errors:');
      for (const r of refs) {
        const loc = r.col ? `${r.line}:${r.col}` : r.line;
        console.log(`- ${r.file}:${loc}`);
      }
    }

    const hasWarnings = /warning:/i.test(combined) || /warning\s+.+$/im.test(combined);
    if (autoLoop && (result.status !== 0 || autoWarn && hasWarnings)) {
      const combined = `${result.stdout || ''}\n${result.stderr || ''}`;
      const refs = extractErrorRefs(combined);
      if (!refs.length) {
        console.log('Auto-loop stopped: no error locations found.');
        process.exit(result.status ?? 1);
      }
      const fix = runChatFix(path.resolve(repoPath), refs, combined);
      if (!fix.ok) {
        console.log(`Auto-loop stopped: ${fix.reason}`);
        process.exit(result.status ?? 1);
      }
      const applied = applyPatch(path.resolve(repoPath), fix.patchPath);
      if (!applied) {
        console.log('Auto-loop stopped: failed to apply patch.');
        process.exit(result.status ?? 1);
      }
      attempt++;
      continue;
    }
  }

  process.exit(result.status ?? 1);
}

process.exit(1);
