// Benchmark Ollama: latency to first token, tokens/s, and 4k context stability.
// Usage: node scripts/bench_ollama.js --model qwen2.5-coder:7b-instruct

const { performance } = require('perf_hooks');

const DEFAULT_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5-coder:7b-instruct';
const BASE_URL = process.env.OLLAMA_URL || 'http://localhost:11434';

function getArg(name, fallback) {
  const idx = process.argv.indexOf(name);
  if (idx === -1 || idx + 1 >= process.argv.length) return fallback;
  return process.argv[idx + 1];
}

const MODEL = getArg('--model', DEFAULT_MODEL);
const NUM_CTX = Number(getArg('--ctx', '4096'));
const NUM_PREDICT = Number(getArg('--predict', '256'));
const LONG_CHARS = Number(getArg('--long-chars', '12000'));

function buildLongPrompt(targetChars) {
  const chunk = 'This is a stability test for long context. ' +
    'It repeats to approximate a 4k context window. ' +
    'Ignore the repetition and just answer the last question. ';
  const repeats = Math.ceil(targetChars / chunk.length);
  let body = '';
  for (let i = 0; i < repeats; i++) body += chunk;
  return body + '\n\nQuestion: Summarize the goal of this test in one sentence.';
}

async function runCase(name, prompt, options) {
  const url = `${BASE_URL}/api/generate`;
  const body = {
    model: MODEL,
    prompt,
    stream: true,
    options
  };

  const t0 = performance.now();
  let firstTokenMs = null;
  let finalStats = null;
  let fullText = '';

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`HTTP ${res.status}: ${errText}`);
  }

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
      if (json.response) {
        fullText += json.response;
        if (firstTokenMs === null) firstTokenMs = performance.now() - t0;
      }
      if (json.done) finalStats = json;
    }
  }

  const totalMs = performance.now() - t0;
  let tokensPerSec = null;
  let evalCount = null;

  if (finalStats && typeof finalStats.eval_count === 'number' && typeof finalStats.eval_duration === 'number') {
    evalCount = finalStats.eval_count;
    const evalSeconds = finalStats.eval_duration / 1e9;
    tokensPerSec = evalSeconds > 0 ? evalCount / evalSeconds : null;
  }

  return {
    name,
    firstTokenMs,
    totalMs,
    evalCount,
    tokensPerSec,
    preview: fullText.slice(0, 120).replace(/\s+/g, ' ')
  };
}

async function main() {
  console.log(`Model: ${MODEL}`);
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`num_ctx: ${NUM_CTX}, num_predict: ${NUM_PREDICT}`);
  console.log('');

  const quickPrompt = 'Reply with the word OK.';
  const longPrompt = buildLongPrompt(LONG_CHARS);

  const cases = [
    {
      name: 'latency-first-token',
      prompt: quickPrompt,
      options: { num_ctx: NUM_CTX, num_predict: 16, temperature: 0.1 }
    },
    {
      name: 'throughput',
      prompt: 'Write a short explanation of what a hash map is.',
      options: { num_ctx: NUM_CTX, num_predict: NUM_PREDICT, temperature: 0.1 }
    },
    {
      name: 'stability-4k',
      prompt: longPrompt,
      options: { num_ctx: 4096, num_predict: 128, temperature: 0.1 }
    }
  ];

  for (const c of cases) {
    const r = await runCase(c.name, c.prompt, c.options);
    console.log(`Case: ${r.name}`);
    console.log(`  first_token_ms: ${r.firstTokenMs === null ? 'n/a' : r.firstTokenMs.toFixed(1)}`);
    console.log(`  total_ms: ${r.totalMs.toFixed(1)}`);
    console.log(`  eval_count: ${r.evalCount ?? 'n/a'}`);
    console.log(`  tokens_per_s: ${r.tokensPerSec === null ? 'n/a' : r.tokensPerSec.toFixed(2)}`);
    console.log(`  preview: ${r.preview}`);
    console.log('');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
