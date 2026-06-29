#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { selectedAssignments } from './assignment_manifest.mjs';

const args = parseArgs(process.argv.slice(2));
const assignments = selectedAssignments(args._);
const attempts = Number(args.attempts || 4);
const delay = String(args.delay || 120);
const wait = String(args.wait || 3000);

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      out._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next == null || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function runStatus(runDir) {
  const submissionsDir = path.join(runDir, 'submissions');
  const students = await readJson(path.join(runDir, 'students.json'), []);
  let submissions = 0;
  let bad = 0;
  if (await exists(submissionsDir)) {
    for (const file of (await readdir(submissionsDir)).filter(name => name.endsWith('.json'))) {
      submissions += 1;
      if (!await readJson(path.join(submissionsDir, file))) bad += 1;
    }
  }
  return {
    students: Array.isArray(students) ? students.length : 0,
    submissions,
    bad,
    complete: Array.isArray(students) && students.length > 0 && students.length === submissions && bad === 0,
  };
}

function runNode(script, scriptArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...scriptArgs], {
      stdio: 'inherit',
      env: {
        ...process.env,
        CDP_EVAL_RETRIES: process.env.CDP_EVAL_RETRIES || '5',
        CDP_NEW_TAB_RETRIES: process.env.CDP_NEW_TAB_RETRIES || '4',
      },
    });
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${script} exited with ${code}`)));
  });
}

async function collectOne(item) {
  const runDir = path.resolve(item.runDir);
  const before = await runStatus(runDir);
  if (!args.force && before.complete) {
    console.log(`\n=== SKIP complete ${item.title}: ${before.submissions}/${before.students} -> ${runDir} ===`);
    return { ...before, title: item.title, runDir, skipped: true, ok: true };
  }

  console.log(`\n=== COLLECT ${item.title}: ${before.submissions}/${before.students || '?'} cached -> ${runDir} ===`);
  let ok = false;
  let lastError = null;
  for (let attempt = 1; attempt <= attempts && !ok; attempt++) {
    try {
      if (attempt > 1) console.log(`Retry ${attempt}/${attempts}: ${item.title}`);
      await runNode('chaoxing-grader.mjs', [
        'collect',
        '--url', item.url,
        '--out', runDir,
        '--delay', delay,
        '--wait', wait,
        '--resume',
      ]);
      ok = true;
    } catch (error) {
      lastError = error;
      console.error(String(error?.message || error));
      if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, 3000 * attempt));
    }
  }

  const after = await runStatus(runDir);
  if (!after.complete) {
    ok = false;
    lastError ||= new Error(`incomplete collection: ${after.submissions}/${after.students}, bad=${after.bad}`);
  }
  return {
    ...after,
    title: item.title,
    runDir,
    skipped: false,
    ok,
    error: ok ? '' : String(lastError?.message || lastError || 'unknown error'),
  };
}

const results = [];
for (const item of assignments) {
  results.push(await collectOne(item));
}

await writeFile('collect_all_status.json', JSON.stringify({
  generatedAt: new Date().toISOString(),
  results,
}, null, 2), 'utf8');

console.log('\n=== COLLECT SUMMARY ===');
for (const row of results) {
  const state = row.ok ? (row.skipped ? 'skip' : 'ok') : 'fail';
  console.log(`${state}\t${row.title}\t${row.submissions}/${row.students}\tbad=${row.bad}\t${row.runDir}${row.error ? `\t${row.error}` : ''}`);
}
if (results.some(row => !row.ok)) process.exitCode = 1;
