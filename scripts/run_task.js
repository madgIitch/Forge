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
const autoVerbose = process.argv.includes('--auto-verbose');
const autoDumpPrompt = process.argv.includes('--auto-dump-prompt');
const maxAttempts = Number(getArg('--attempts', task === 'lint' ? '6' : '2'));
const autoRetries = Number(getArg('--auto-retries', '2'));
const patchPath = getArg('--patch', path.join(repoPath, '.forge', 'auto.patch'));
let maxFiles = 1;
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

function logAuto(message) {
  if (autoVerbose) console.log(message);
}

function truncateText(text, maxChars) {
  if (!text) return '';
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + '\n...[truncated]';
}

function previewText(text, maxLines) {
  if (!text) return '';
  const lines = text.split(/\r?\n/);
  if (lines.length <= maxLines) return text.trim();
  return lines.slice(0, maxLines).join('\n').trim() + '\n...[truncated]';
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

function buildFixPrompt(errorsText, strict, allowedFiles, note, root) {
  const allowed =
    allowedFiles && allowedFiles.length
      ? ['Allowed files:', ...allowedFiles.map((file) => `- ${file}`)].join('\n')
      : '';

  // Detect React Hook errors and provide context
  const hasReactHookError = /useEffect|useCallback|useMemo|React Hook/i.test(errorsText);
  const hasMissingFunctionDep = /missing.*function|function.*dependency|wrap.*useCallback/i.test(errorsText);

  // Extract relevant file snippet if React Hook error
  let fileSnippet = '';
  if (hasReactHookError && allowedFiles && allowedFiles.length > 0) {
    try {
      const filePath = path.join(root, allowedFiles[0]);
      const fileContent = fs.readFileSync(filePath, 'utf8');
      const lines = fileContent.split('\n');

      // Find imports and first 80 lines (usually enough for component start)
      const snippet = lines.slice(0, Math.min(80, lines.length)).join('\n');
      fileSnippet = [
        '',
        `Current file content (first 80 lines of ${allowedFiles[0]}):`,
        '```',
        snippet,
        '```',
        ''
      ].join('\n');
    } catch (e) {
      // Ignore if can't read
    }
  }

  const reactHookExample = hasReactHookError ? [
    '',
    'CRITICAL: If a function is used in useEffect, you MUST wrap it in useCallback.',
    'DO NOT just add the function to the dependency array.',
    'You MUST modify BOTH the import statement AND the function definition.',
    '',
    'React Hook fix example:',
    '--- a/Component.tsx',
    '+++ b/Component.tsx',
    '@@ -1,8 +1,8 @@',
    '-import { useEffect, useState } from "react";',
    '+import { useEffect, useState, useCallback } from "react";',
    ' ',
    ' function Component() {',
    '-  const loadData = async () => {',
    '+  const loadData = useCallback(async () => {',
    '     // fetch logic',
    '-  };',
    '+  }, [dependency1, dependency2]);',
    ' ',
    '   useEffect(() => {',
    '     loadData();',
    '-  }, []);',
    '+  }, [loadData]);',
  ].join('\n') : '';

  const example = [
    'Example:',
    '--- a/path/to/file.ts',
    '+++ b/path/to/file.ts',
    '@@',
    '-const x = 1;',
    '+const x = 2;'
  ].join('\n');

  if (strict) {
    return [
      'OUTPUT ONLY a unified diff.',
      'Start with: --- a/<path> and +++ b/<path>.',
      'No prose, no markdown fences, no diff --git, no index.',
      'Fix ONLY the lint warnings in the listed file(s).',
      'Do NOT change JSX structure.',
      'Do NOT output no-op diffs (changes that don\'t actually change anything).',
      allowed,
      'If changes are needed outside the allowed files, output an empty patch.',
      note ? `Previous attempt issue: ${note}` : '',
      fileSnippet,
      example,
      reactHookExample,
      'Errors:',
      errorsText
    ].filter(Boolean).join('\n');
  }
  return [
    'Output ONLY a unified diff (--- / +++).',
    'Do not include diff --git, index lines, or code fences.',
    'Fix ONLY the lint warnings in the listed file(s). Keep changes minimal.',
    'Do not change files not listed.',
    note ? `Previous attempt issue: ${note}` : '',
    fileSnippet,
    example,
    reactHookExample,
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
  const debugRoot = path.join(root, '.forge');
  const debugResponsePath = path.join(debugRoot, 'auto.last.response.txt');
  const debugCleanPath = path.join(debugRoot, 'auto.last.cleaned.diff');
  const debugPromptPath = path.join(debugRoot, 'auto.last.prompt.txt');

  logAuto(`Auto-fix targets (${targetFiles.length}): ${targetFiles.join(', ')}`);
  logAuto(`Auto-fix error context:\n${truncateText(baseErrors, 800)}`);

  const scriptPath = path.join(__dirname, 'forge_cli.js');
  const cfg = loadConfig(root);

  let lastNote = '';
  for (let attempt = 1; attempt <= autoRetries; attempt++) {
    logAuto(`Auto-fix attempt ${attempt}/${autoRetries}`);
    const strictPrompt = task === 'lint' ? true : attempt > 1;
    const question = buildFixPrompt(baseErrors, strictPrompt, targetFiles, lastNote, root);
    if (autoVerbose || autoDumpPrompt) {
      fs.mkdirSync(debugRoot, { recursive: true });
      fs.writeFileSync(debugPromptPath, question, 'utf8');
      logAuto(`Auto-fix prompt saved: ${debugPromptPath}`);
    }
    const args = [
      scriptPath,
      '--repo', root,
      '--include-files', targetFiles.join(','),
      '--max-bytes', '200000',
      '--no-validate-diff',
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

    const rawOut = result.stdout || '';
    const cleaned = cleanPatch(rawOut);
    if (autoVerbose) {
      fs.mkdirSync(debugRoot, { recursive: true });
      fs.writeFileSync(debugResponsePath, rawOut, 'utf8');
      fs.writeFileSync(debugCleanPath, cleaned, 'utf8');
      logAuto(`Auto-fix raw response saved: ${debugResponsePath}`);
      logAuto(`Auto-fix cleaned diff saved: ${debugCleanPath}`);
    }
    if (!isValidPatch(cleaned)) {
      lastNote = 'Output was not a unified diff with ---/+++ headers.';
      if (autoVerbose) {
        logAuto('Auto-fix invalid diff preview:');
        logAuto(previewText(rawOut, 20));
      }
      if (attempt === autoRetries) {
        return { ok: false, reason: 'Patch output was invalid or incomplete.' };
      }
      continue;
    }
    if (isNoOpDiff(cleaned)) {
      lastNote = 'Diff contains no actual changes (no-op diff). The model did not fix the issue.';
      if (autoVerbose) {
        logAuto('Auto-fix generated no-op diff (no real changes)');
      }
      if (attempt === autoRetries) {
        return { ok: false, reason: 'Diff contains no actual changes.' };
      }
      continue;
    }
    const patchFiles = extractPatchFiles(cleaned);
    const allowed = new Set(targetFiles.map((f) => f.replace(/\\/g, '/')));
    const outside = patchFiles.filter((f) => !allowed.has(f));
    if (outside.length) {
      lastNote = `Patch touched unexpected files: ${outside.join(', ')}`;
      if (autoVerbose) {
        logAuto(`Auto-fix unexpected files: ${outside.join(', ')}`);
      }
      if (attempt === autoRetries) {
        return { ok: false, reason: `Patch touched unexpected files: ${outside.join(', ')}` };
      }
      continue;
    }
    // Save patch to both locations for compatibility
    const finalPatchPath = path.join(root, '.forge', 'auto.patch');
    fs.mkdirSync(path.dirname(finalPatchPath), { recursive: true });
    fs.writeFileSync(finalPatchPath, cleaned, 'utf8');
    return { ok: true, patchPath: finalPatchPath };
  }

  return { ok: false, reason: 'Patch generation failed after retries.' };
}

function applyPatch(root, patchFile) {
  const scriptPath = path.join(__dirname, 'apply_diff.js');
  const args = [scriptPath, '--repo', root, '--diff', patchFile, '--yes'];
  const result = spawnSync('node', args, { encoding: 'utf8' });
  return result.status === 0;
}

/**
 * Apply patch with post-validation
 * Returns: { applied: boolean, improved: boolean, errorCount: number }
 */
function applyPatchWithValidation(root, patchFile, originalErrorRefs) {
  // Check if repo is clean
  const statusResult = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });
  const hasChanges = statusResult.stdout.trim().length > 0;

  if (hasChanges) {
    logAuto('⚠️  Working directory has uncommitted changes. Creating stash...');
    const stashResult = spawnSync('git', ['stash', 'push', '-u', '-m', 'forge-auto-fix-backup'],
      { cwd: root, encoding: 'utf8' });
    if (stashResult.status !== 0) {
      return { applied: false, improved: false, errorCount: originalErrorRefs.length,
        reason: 'Failed to stash changes' };
    }
  }

  // Apply patch using git apply --reject (allows partial application)
  const patchContent = fs.readFileSync(patchFile, 'utf8');
  const gitApplyResult = spawnSync('git', ['apply', '--reject', '--whitespace=fix'],
    { cwd: root, input: patchContent, encoding: 'utf8' });

  const patchApplied = gitApplyResult.status === 0 || gitApplyResult.stdout.includes('Applied');

  if (!patchApplied && gitApplyResult.stderr) {
    logAuto(`Git apply warnings: ${gitApplyResult.stderr.substring(0, 200)}`);
  }

  // Re-run the task to get new errors
  const newResult = runTaskCommand(root);
  const newRefs = parseErrorRefs(newResult.output);

  const improved = newRefs.length < originalErrorRefs.length;
  const errorCount = newRefs.length;

  if (improved) {
    logAuto(`✅ Improvement detected: ${originalErrorRefs.length} → ${newRefs.length} errors`);
    // Keep changes, drop stash if exists
    if (hasChanges) {
      spawnSync('git', ['stash', 'drop'], { cwd: root });
    }
    return { applied: true, improved: true, errorCount };
  } else {
    logAuto(`❌ No improvement: ${originalErrorRefs.length} → ${newRefs.length} errors. Reverting...`);
    // Revert changes
    spawnSync('git', ['reset', '--hard', 'HEAD'], { cwd: root });
    spawnSync('git', ['clean', '-fd'], { cwd: root }); // Remove .rej files

    // Restore stash if exists
    if (hasChanges) {
      spawnSync('git', ['stash', 'pop'], { cwd: root });
    }

    return { applied: false, improved: false, errorCount: originalErrorRefs.length,
      reason: `Errors unchanged or increased (${newRefs.length})` };
  }
}

function runTaskCommand(root) {
  const cfg = loadConfig(root);
  const cmd = cfg.tasks && cfg.tasks[task] ? cfg.tasks[task] : `npm run ${task}`;

  // Cross-platform command execution
  const isWindows = process.platform === 'win32';
  const shell = isWindows ? 'cmd' : 'sh';
  const shellFlag = isWindows ? '/c' : '-c';

  const result = spawnSync(shell, [shellFlag, cmd], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    shell: true
  });

  return { output: result.stdout + result.stderr, exitCode: result.status };
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

function isNoOpDiff(text) {
  const lines = text.split(/\r?\n/);
  let hasRealChange = false;
  for (const line of lines) {
    if (line.startsWith('-') && !line.startsWith('---')) {
      const removed = line.slice(1).trim();
      // Look for corresponding + line with same content
      const idx = lines.indexOf(line);
      if (idx !== -1 && idx + 1 < lines.length) {
        const nextLine = lines[idx + 1];
        if (nextLine.startsWith('+') && !nextLine.startsWith('+++')) {
          const added = nextLine.slice(1).trim();
          if (removed !== added) {
            hasRealChange = true;
            break;
          }
        }
      }
    }
  }
  return !hasRealChange;
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

      // Use post-validation: apply patch and verify improvement
      const validation = applyPatchWithValidation(path.resolve(repoPath), fix.patchPath, refs);

      if (validation.improved) {
        console.log(`✅ Auto-fix successful! Errors reduced: ${refs.length} → ${validation.errorCount}`);
        if (validation.errorCount === 0) {
          console.log('🎉 All errors fixed!');
          process.exit(0);
        }
        // Continue loop with remaining errors
        attempt++;
        continue;
      } else {
        console.log(`Auto-loop stopped: ${validation.reason || 'No improvement after applying patch'}`);
        process.exit(result.status ?? 1);
      }
    }
  }

  process.exit(result.status ?? 1);
}

process.exit(1);
