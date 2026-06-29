#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { selectedAssignments } from './assignment_manifest.mjs';

const args = parseArgs(process.argv.slice(2));
const assignments = selectedAssignments(args._);
const workers = String(args.workers || process.env.SIMILARITY_WORKERS || 8);
const threshold = String(args.threshold || 0.92);
const python = args.python || '.venv-cv/bin/python';
const rebuildOnly = Boolean(args['rebuild-only']);

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

function pairStudentIds(pair) {
  return [String(pair.aWorkAnswerId), String(pair.bWorkAnswerId)].filter(Boolean);
}

function evidenceGroupKeys(pair) {
  const exact = String(pair.exactShared || '')
    .split(/[;,]/)
    .map(item => item.trim())
    .filter(Boolean)
    .sort();
  if (exact.length) return exact.map(item => `exact:${item}`);
  const siftFiles = [pair.siftAFile, pair.siftBFile].filter(Boolean).map(String).sort();
  const akazeFiles = [pair.akazeAFile, pair.akazeBFile].filter(Boolean).map(String).sort();
  if (siftFiles.length === 2 && Number(pair.siftInliers || 0) > 0) return [`sift:${siftFiles.join('|')}`];
  if (akazeFiles.length === 2 && Number(pair.akazeInliers || 0) > 0) return [`akaze:${akazeFiles.join('|')}`];
  return [`pair:${pair.aWorkAnswerId}|${pair.bWorkAnswerId}`];
}

function buildSimilarityGroups(pairs, verdict) {
  const selected = pairs.filter(row => row.verdict === verdict);
  const groups = new Map();
  for (const pair of selected) {
    const ids = pairStudentIds(pair);
    if (ids.length < 2) continue;
    for (const key of evidenceGroupKeys(pair)) {
      if (!groups.has(key)) groups.set(key, new Set());
      ids.forEach(id => groups.get(key).add(String(id)));
    }
  }
  return [...groups.values()].filter(ids => ids.size >= 2).map(ids => [...ids]);
}

function similarityStats(rows) {
  if (!Array.isArray(rows)) {
    return { confirmed: 0, suspected: 0, confirmedPairs: 0, suspectedPairs: 0 };
  }
  const confirmedGroups = buildSimilarityGroups(rows, 'confirmed');
  const suspectedGroups = buildSimilarityGroups(rows, 'suspected');
  const countPeople = groups => {
    const ids = new Set();
    groups.forEach(group => group.forEach(id => ids.add(String(id))));
    return ids.size;
  };
  return {
    confirmed: countPeople(confirmedGroups),
    suspected: countPeople(suspectedGroups),
    confirmedPairs: rows.filter(row => row.verdict === 'confirmed').length,
    suspectedPairs: rows.filter(row => row.verdict === 'suspected').length,
  };
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
  const drafts = await readJson(path.join(runDir, 'grading_draft.json'), []);
  const advanced = await readJson(path.join(runDir, 'advanced_similarity.json'), []);
  const stats = similarityStats(advanced);
  return {
    students: Array.isArray(students) ? students.length : 0,
    submissions,
    bad,
    drafts: Array.isArray(drafts) ? drafts.length : 0,
    advanced: Array.isArray(advanced) ? advanced.length : 0,
    ...stats,
    complete: Array.isArray(students) && students.length > 0 && students.length === submissions && bad === 0,
    report: await exists(path.join(runDir, 'review_report.html')),
  };
}

function runCommand(command, commandArgs, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      stdio: 'inherit',
      env: {
        ...process.env,
        SIMILARITY_WORKERS: workers,
      },
      ...options,
    });
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${command} ${commandArgs.join(' ')} exited with ${code}`)));
  });
}

async function reportOne(item) {
  const runDir = path.resolve(item.runDir);
  const before = await runStatus(runDir);
  if (!before.complete) {
    console.log(`\n=== SKIP incomplete ${item.title}: ${before.submissions}/${before.students}, bad=${before.bad} ===`);
    return { ...before, title: item.title, runDir, ok: false, skipped: true, error: 'collection incomplete' };
  }

  console.log(`\n=== REPORT ${item.title}: ${before.submissions} submissions -> ${runDir} ===`);
  try {
    if (!rebuildOnly) {
      await runCommand(process.execPath, [
        'chaoxing-grader.mjs',
        'grade',
        '--run', runDir,
        '--threshold', threshold,
      ]);
      await runCommand(python, [
        'advanced_similarity.py',
        runDir,
        '--workers', workers,
      ]);
    }
    await runCommand(process.execPath, [
      'apply_advanced_similarity.mjs',
      runDir,
    ]);
    await runCommand(process.execPath, [
      'build_advanced_report.mjs',
      runDir,
      '--replace-main',
    ]);
    const after = await runStatus(runDir);
    return { ...after, title: item.title, runDir, ok: true, skipped: false, error: '' };
  } catch (error) {
    const after = await runStatus(runDir);
    return { ...after, title: item.title, runDir, ok: false, skipped: false, error: String(error?.message || error) };
  }
}

const results = [];
for (const item of assignments) {
  results.push(await reportOne(item));
}

await writeFile('report_all_status.json', JSON.stringify({
  generatedAt: new Date().toISOString(),
  results,
}, null, 2), 'utf8');

console.log('\n=== REPORT SUMMARY ===');
for (const row of results) {
  const state = row.ok ? 'ok' : (row.skipped ? 'skip' : 'fail');
  console.log(`${state}\t${row.title}\t${row.submissions}/${row.students}\tdraft=${row.drafts}\tconfirmedPeople=${row.confirmed}\tsuspectedPeople=${row.suspected}\tconfirmedPairs=${row.confirmedPairs}\tsuspectedPairs=${row.suspectedPairs}\treport=${row.report ? 'yes' : 'no'}\t${row.runDir}${row.error ? `\t${row.error}` : ''}`);
}
if (results.some(row => !row.ok)) process.exitCode = 1;
