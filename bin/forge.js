const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

function usage() {
  console.log(`forge <command> [args]\n\nCommands:\n  chat     Chat with repo context (Ollama)\n  index    Build RAG index for a repo\n  apply    Apply unified diff with guardrails\n  run      Run lint/test/build and parse errors\n  config   Show or set defaults\n  help     Show help\n\nExamples:\n  forge chat --repo . --question "¿Dónde se calcula X?"\n  forge index --repo C:\\repo\n  forge apply --repo C:\\repo --diff change.diff\n  forge run --repo C:\\repo --task lint\n  forge run --repo C:\\repo --task lint --auto --auto-warn --attempts 2\n  forge config\n  forge config --set repo=C:\\repo\n`);
}

const CONFIG_PATH = path.join(__dirname, '..', '.forge', 'config.json');

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveConfig(cfg) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
}

function showHelp() {
  usage();
  console.log('\nDetails:\n  forge chat   -> wraps scripts/forge_cli.js\n  forge index  -> wraps scripts/rag_index.js\n  forge apply  -> wraps scripts/apply_diff.js\n  forge run    -> wraps scripts/run_task.js\n  forge config -> defaults stored in .forge/config.json\n');
}

const args = process.argv.slice(2);
const cmd = args[0];

if (!cmd || cmd === '-h' || cmd === '--help') {
  showHelp();
  process.exit(0);
}

function run(script, rest) {
  const scriptPath = path.join(__dirname, '..', 'scripts', script);
  const cfg = loadConfig();
  const injected = [];
  if (cfg.repo && !rest.includes('--repo')) {
    injected.push('--repo', cfg.repo);
  }
  if (cfg.model && !rest.includes('--model')) {
    injected.push('--model', cfg.model);
  }
  if (cfg.ctx && !rest.includes('--ctx')) {
    injected.push('--ctx', String(cfg.ctx));
  }
  if (cfg.predict && !rest.includes('--predict')) {
    injected.push('--predict', String(cfg.predict));
  }
  const result = spawnSync('node', [scriptPath, ...injected, ...rest], { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}

switch (cmd) {
  case 'chat':
    run('forge_cli.js', args.slice(1));
    break;
  case 'index':
    run('rag_index.js', args.slice(1));
    break;
  case 'apply':
    run('apply_diff.js', args.slice(1));
    break;
  case 'run':
    run('run_task.js', args.slice(1));
    break;
  case 'config': {
    const cfg = loadConfig();
    const setIdx = args.indexOf('--set');
    if (setIdx !== -1 && args[setIdx + 1]) {
      const [key, value] = args[setIdx + 1].split('=');
      if (!key || !value) {
        console.error('Usage: forge config --set key=value');
        process.exit(1);
      }
      if (key === 'ctx' || key === 'predict') {
        const num = Number(value);
        if (!Number.isFinite(num) || num <= 0) {
          console.error(`Invalid ${key}: ${value}`);
          process.exit(1);
        }
        cfg[key] = num;
      } else {
        cfg[key] = value;
      }
      saveConfig(cfg);
      console.log('Saved config:', cfg);
      process.exit(0);
    }
    console.log(cfg);
    break;
  }
  case 'help':
    showHelp();
    break;
  default:
    console.error(`Unknown command: ${cmd}`);
    showHelp();
    process.exit(1);
}
