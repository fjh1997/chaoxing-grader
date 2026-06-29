#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const baseDir = path.resolve('.');
const statusFile = path.join(baseDir, 'submit_early_bonus_apply_status.json');
const plan = JSON.parse(await readFile(path.join(baseDir, 'submit_early_bonus_status.json'), 'utf8'));
const existing = await readJson(statusFile, { completed: [], failed: [] });
const completed = new Set(existing.completed || []);
const failed = [];

for (const item of plan.summaries) {
  if (completed.has(item.key) && !process.argv.includes('--rerun-completed')) {
    console.log(`skip completed ${item.key}`);
    continue;
  }
  const runDir = path.resolve(item.runDir);
  const draft = path.join(runDir, 'grading_draft_submit_early_bonus.json');
  console.log(`\n=== submit ${item.key} ${item.rows} rows ===`);
  const result = await runNode([
    path.join(baseDir, 'chaoxing-grader.mjs'),
    'submit',
    '--run', runDir,
    '--draft', draft,
    '--apply',
    '--all',
    '--allow-zero',
    '--quiet',
    '--delay', process.env.SUBMIT_DELAY_MS || '1200',
  ]);
  if (result !== 0) {
    failed.push({ key: item.key, runDir: item.runDir, code: result, at: new Date().toISOString() });
    await persist();
    process.exit(result);
  }
  completed.add(item.key);
  await persist();
}

await persist();
console.log(`submit complete: ${completed.size}/${plan.summaries.length}`);

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function persist() {
  await writeFile(statusFile, JSON.stringify({
    updatedAt: new Date().toISOString(),
    completed: [...completed],
    failed,
  }, null, 2), 'utf8');
}

function runNode(args) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, args, {
      stdio: 'inherit',
      cwd: process.cwd(),
      env: process.env,
    });
    child.on('close', code => resolve(code ?? 1));
  });
}
