const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');

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
const diffPath = getArg('--diff', null);
const maxLines = toInt(getArg('--max-lines', '500'), 500);
const autoYes = process.argv.includes('--yes');

if (!diffPath) {
  console.error('Missing --diff path/to/patch.diff');
  process.exit(1);
}

function parseDiff(diffText) {
  const files = new Set();
  let added = 0;
  let removed = 0;
  const lines = diffText.split(/\r?\n/);
  for (const line of lines) {
    if (line.startsWith('+++ ')) {
      const file = line.slice(4).trim();
      if (file !== '/dev/null') {
        const rel = file.startsWith('b/') ? file.slice(2) : file;
        files.add(rel);
      }
      continue;
    }
    if (line.startsWith('--- ')) {
      const file = line.slice(4).trim();
      if (file !== '/dev/null') {
        const rel = file.startsWith('a/') ? file.slice(2) : file;
        files.add(rel);
      }
      continue;
    }
    if (line.startsWith('+') && !line.startsWith('+++')) added++;
    if (line.startsWith('-') && !line.startsWith('---')) removed++;
  }
  return { files: Array.from(files), added, removed };
}

function ensureInsideRepo(root, relPath) {
  const full = path.resolve(root, relPath);
  const rootFull = path.resolve(root);
  return full.startsWith(rootFull + path.sep) || full === rootFull;
}

function gitAvailable() {
  const r = spawnSync('git', ['--version'], { stdio: 'ignore' });
  return r.status === 0;
}

function runGitApply(args, cwd, stdinText) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', input: stdinText });
}

function backupFiles(root, files) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupRoot = path.join(root, '.forge', 'backup', stamp);
  fs.mkdirSync(backupRoot, { recursive: true });
  for (const rel of files) {
    if (!ensureInsideRepo(root, rel)) {
      throw new Error(`Refusing to backup outside repo: ${rel}`);
    }
    const src = path.join(root, rel);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(backupRoot, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
  return backupRoot;
}

async function promptYesNo(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

async function main() {
  const root = path.resolve(repoPath);
  const diffText = fs.readFileSync(diffPath, 'utf8');
  const hasABPrefix = diffText.includes('--- a/') || diffText.includes('+++ b/');
  const stripArg = hasABPrefix ? '-p1' : '-p0';
  const { files, added, removed } = parseDiff(diffText);

  if (added + removed > maxLines) {
    console.error(`Refusing to apply: ${added + removed} lines exceed limit ${maxLines}.`);
    process.exit(1);
  }

  for (const rel of files) {
    if (!ensureInsideRepo(root, rel)) {
      console.error(`Refusing to touch outside repo: ${rel}`);
      process.exit(1);
    }
  }

  console.log('Review:');
  console.log(`- Files: ${files.length}`);
  console.log(`- Added lines: ${added}`);
  console.log(`- Removed lines: ${removed}`);
  files.forEach((f) => console.log(`  - ${f}`));

  if (!autoYes) {
    const ok = await promptYesNo('Apply patch? (y/N): ');
    if (!ok) {
      console.log('Cancelled.');
      return;
    }
  }

  if (!gitAvailable()) {
    console.error('git not available. Install git to apply patches safely.');
    process.exit(1);
  }

  const check = runGitApply(['apply', '--check', '--ignore-space-change', stripArg], root, diffText);
  if (check.status !== 0) {
    console.error('Patch does not apply cleanly:');
    console.error(check.stderr || check.stdout);
    process.exit(1);
  }

  const backupRoot = backupFiles(root, files);
  console.log(`Backup created at ${backupRoot}`);

  const apply = runGitApply(['apply', '--ignore-space-change', stripArg], root, diffText);
  if (apply.status !== 0) {
    console.error('Failed to apply patch:');
    console.error(apply.stderr || apply.stdout);
    process.exit(1);
  }

  console.log('Patch applied.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
