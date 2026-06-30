#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pipeline } from 'node:stream/promises';

const PROXY = process.env.CDP_PROXY_URL || 'http://localhost:3456';
const BASE = 'https://mooc2-ans.chaoxing.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
const MIMO_ENDPOINT = process.env.MIMO_ENDPOINT || 'https://api.openai.com/v1';
const MIMO_MODEL = process.env.MIMO_MODEL || 'mimo-v2.5';

function usage() {
  console.log(`
Usage:
  node chaoxing-grader.mjs discover --url <course-or-mark-url> [--out run-dir]
  node chaoxing-grader.mjs collect  --url <course-or-mark-url> [--assignment-title 作业十五] [--out run-dir]
  node chaoxing-grader.mjs vision   --run run-dir [--model mimo-v2.5] [--only-pending] [--force]
  node chaoxing-grader.mjs pair-review --run run-dir [--threshold 0.92] [--names 张三,李四]
  node chaoxing-grader.mjs grade    --run run-dir [--threshold 0.92] [--first-submit-wins]
  node chaoxing-grader.mjs submit   --run run-dir [--apply] [--all] [--allow-zero]

Notes:
  collect, vision and grade are read-only.
  submit prints a dry run unless --apply is present.
`);
}

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
    if (next == null || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function assertArg(value, name) {
  if (!value) {
    throw new Error(`missing required argument: --${name}`);
  }
  return value;
}

function absUrl(urlOrPath) {
  return new URL(urlOrPath, BASE).toString();
}

function slug(value, fallback = 'item') {
  const s = String(value || '')
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 120);
  return s || fallback;
}

function csvEscape(value) {
  const s = value == null ? '' : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows, columns) {
  return [
    columns.map(csvEscape).join(','),
    ...rows.map(row => columns.map(col => csvEscape(row[col])).join(',')),
  ].join('\n') + '\n';
}

async function jsonFile(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(data, null, 2), 'utf8');
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function readJsonOptional(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function fileExists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function cdp(pathname, body) {
  const options = body == null
    ? {}
    : { method: 'POST', body: String(body), headers: { 'content-type': 'text/plain;charset=utf-8' } };
  const res = await fetch(`${PROXY}${pathname}`, options);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`CDP ${pathname} failed: ${res.status} ${text.slice(0, 500)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function newTab(url) {
  const attempts = Number(process.env.CDP_NEW_TAB_RETRIES || 3);
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const result = await cdp('/new', url);
      if (!result?.targetId) throw new Error(`failed to create tab: ${JSON.stringify(result)}`);
      return result.targetId;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(1200 * attempt);
    }
  }
  throw lastError;
}

async function closeTab(target) {
  try {
    await cdp(`/close?target=${encodeURIComponent(target)}`);
  } catch {
    // Best-effort cleanup only.
  }
}

async function evalIn(target, fn, ...args) {
  const expression = `(async()=>await (${fn})(...${JSON.stringify(args)}))()`;
  const attempts = fn?.name === 'browserSubmitReview'
    ? 1
    : Number(process.env.CDP_EVAL_RETRIES || 4);
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const result = await cdp(`/eval?target=${encodeURIComponent(target)}`, expression);
      if (result?.error) throw new Error(result.error);
      return result?.value;
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isRetriableCdpError(error)) break;
      console.warn(`CDP eval retry ${attempt + 1}/${attempts} for ${fn?.name || 'anonymous'}: ${String(error?.message || error).slice(0, 180)}`);
      await sleep(1500 * attempt);
    }
  }
  throw lastError;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function mapLimit(items, limit, fn) {
  const rows = Array.from(items);
  const results = new Array(rows.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Number(limit) || 1) }, async () => {
    while (next < rows.length) {
      const index = next++;
      results[index] = await fn(rows[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function isRetriableCdpError(error) {
  return /timeout|timed out|Runtime\.evaluate|Target closed|ECONNRESET|ECONNREFUSED|fetch failed|socket hang up|CDP .* failed: 5\d\d/i
    .test(String(error?.message || error));
}

async function resolveMarkUrl(inputUrl, opts = {}) {
  const url = assertArg(inputUrl, 'url');
  if (url.includes('/work/mark?')) {
    return { markUrl: url, assignments: [] };
  }

  const target = await newTab(url);
  try {
    await sleep(Number(opts.wait || 1500));
    const assignments = await evalIn(target, browserDiscoverAssignments);
    if (!assignments.length) {
      throw new Error('no assignment mark links were found in the course work list');
    }
    let selected = null;
    if (opts.assignmentTitle) {
      selected = assignments.find(a => a.title.includes(opts.assignmentTitle));
      if (!selected) {
        throw new Error(`no assignment matched title: ${opts.assignmentTitle}`);
      }
    } else if (opts.assignmentIndex != null) {
      selected = assignments[Number(opts.assignmentIndex)];
    } else {
      selected = assignments[0];
    }
    if (!selected) {
      throw new Error(`assignment index is out of range`);
    }
    return { markUrl: selected.markUrl, assignments, selected };
  } finally {
    await closeTab(target);
  }
}

async function discover(opts) {
  const outDir = opts.out || path.resolve('chaoxing-grader', `discover-${Date.now()}`);
  const resolved = await resolveMarkUrl(opts.url, opts);
  await mkdir(outDir, { recursive: true });
  await jsonFile(path.join(outDir, 'assignments.json'), resolved.assignments);
  await jsonFile(path.join(outDir, 'selected.json'), resolved.selected || { markUrl: resolved.markUrl });
  console.log(`Found ${resolved.assignments.length} assignment(s).`);
  if (resolved.selected) {
    console.log(`Selected: ${resolved.selected.title}`);
    console.log(`Mark URL: ${resolved.selected.markUrl}`);
  }
  console.log(`Wrote: ${outDir}`);
}

async function collect(opts) {
  const resolved = await resolveMarkUrl(opts.url, opts);
  const outDir = path.resolve(opts.out || path.join('chaoxing-grader', `run-${new Date().toISOString().replace(/[:.]/g, '-')}`));
  const pageSize = Number(opts['page-size'] || 200);
  const classFilter = opts.classes && opts.classes !== 'all'
    ? new Set(String(opts.classes).split(',').map(s => s.trim()).filter(Boolean))
    : null;
  const refreshWorkAnswerIds = optionSet(opts['refresh-work-answer-ids'] || opts['work-answer-ids']);

  await mkdir(outDir, { recursive: true });
  const target = await newTab(resolved.markUrl);
  try {
    await sleep(Number(opts.wait || 1200));
    const meta = await evalIn(target, browserMarkMeta);
    meta.markUrl = resolved.markUrl;
    meta.selectedAssignment = resolved.selected || null;
    meta.collectedAt = new Date().toISOString();
    await jsonFile(path.join(outDir, 'metadata.json'), meta);

    const classes = meta.classes.filter(cls => !classFilter || classFilter.has(cls.name) || classFilter.has(cls.classId));
    if (!classes.length) {
      throw new Error('no class matched --classes filter');
    }

    const allRows = [];
    const unsubmittedRows = [];
    for (const cls of classes) {
      console.log(`Collecting class: ${cls.name} (${cls.classId}), work ${cls.workId}`);
      const rows = await collectClassRows(target, meta, cls, pageSize);
      console.log(`  submitted rows: ${rows.length}`);
      for (const [index, row] of rows.entries()) {
        process.stdout.write(`  [${index + 1}/${rows.length}] ${row.name} ${row.studentNo} ${row.status}\r`);
        const submissionFile = path.join(outDir, 'submissions', `${slug(cls.name)}_${slug(row.studentNo)}_${slug(row.name)}_${row.workAnswerId}.json`);
        const shouldRefresh = refreshWorkAnswerIds.has(String(row.workAnswerId));
        if (opts.resume && !shouldRefresh && await fileExists(submissionFile)) {
          try {
            const cached = await readJson(submissionFile);
            allRows.push(compactStudentRow(cached));
            continue;
          } catch (error) {
            console.warn(`  cached submission is invalid, refreshing ${row.name} ${row.studentNo}: ${String(error?.message || error).slice(0, 160)}`);
          }
        }
        const review = await evalIn(target, browserReviewData, row.reviewUrl);
        const submission = {
          ...row,
          className: cls.name,
          classId: cls.classId,
          classWorkId: cls.workId,
          assignmentTitle: meta.title,
          reviewUrl: absUrl(row.reviewUrl),
          review,
          assets: [],
        };
        submission.assets = await downloadSubmissionAssets(submission, outDir);
        await jsonFile(submissionFile, submission);
        allRows.push(compactStudentRow(submission));
        await sleep(Number(opts.delay || 250));
      }
      process.stdout.write('\n');

      const unsubmitted = await collectClassRows(target, meta, cls, pageSize, {
        submit: 'false',
        requireReviewUrl: false,
      });
      console.log(`  unsubmitted rows: ${unsubmitted.length}`);
      for (const row of unsubmitted) {
        unsubmittedRows.push({
          ...row,
          className: cls.name,
          classId: cls.classId,
          classWorkId: cls.workId,
          assignmentTitle: meta.title,
          reviewUrl: '',
        });
      }
    }

    await jsonFile(path.join(outDir, 'students.json'), allRows);
    await writeFile(path.join(outDir, 'students.csv'), toCsv(allRows, [
      'className', 'name', 'studentNo', 'workAnswerId', 'personId', 'submitTime',
      'ip', 'status', 'existingScore', 'grader', 'answerTextLength', 'imageCount', 'reviewUrl',
    ]), 'utf8');
    await jsonFile(path.join(outDir, 'unsubmitted_students.json'), unsubmittedRows);
    await writeFile(path.join(outDir, 'unsubmitted_students.csv'), toCsv(unsubmittedRows, [
      'className', 'name', 'studentNo', 'workAnswerId', 'personId', 'submitTime',
      'ip', 'status', 'existingScore', 'grader', 'reviewUrl',
    ]), 'utf8');
    console.log(`Collected ${allRows.length} submissions into ${outDir}`);
  } finally {
    await closeTab(target);
  }
}

async function collectClassRows(target, meta, cls, pageSize, options = {}) {
  const rows = [];
  let page = 1;
  let totalPage = 1;
  do {
    const result = await evalIn(target, browserMarkListRows, {
      courseId: meta.courseId,
      classId: cls.classId,
      workId: cls.workId,
      cpi: meta.cpi,
      evaluation: meta.evaluation || '0',
      status: options.status || '0',
      submit: options.submit || 'true',
      groupId: '0',
      sort: '0',
      order: '0',
      unEval: 'false',
      search: '',
      from: meta.from || '',
      topicid: meta.topicid || '0',
      includeMissing: !options.requireReviewUrl,
      page,
      size: pageSize,
    });
    totalPage = Number(result.totalPage || 1);
    rows.push(...result.rows);
    page++;
  } while (page <= totalPage);
  return rows;
}

function compactStudentRow(submission) {
  return {
    className: submission.className,
    name: submission.name,
    studentNo: submission.studentNo,
    workAnswerId: submission.workAnswerId,
    personId: submission.personId,
    submitTime: submission.submitTime,
    ip: submission.ip,
    status: submission.status,
    existingScore: submission.existingScore,
    grader: submission.grader,
    answerTextLength: submission.review.answerText.length,
    imageCount: submission.review.images.length,
    reviewUrl: submission.reviewUrl,
  };
}

async function downloadSubmissionAssets(submission, outDir) {
  const folder = path.join(
    outDir,
    'downloads',
    `${slug(submission.className)}_${slug(submission.studentNo)}_${slug(submission.name)}_${submission.workAnswerId}`,
  );
  await mkdir(folder, { recursive: true });

  const images = Array.isArray(submission.review.images) ? submission.review.images : [];
  const assetWorkers = Number(process.env.CHAOXING_ASSET_WORKERS || 6);
  return mapLimit(images, assetWorkers, async (image, index) => {
    const objectId = objectIdFromUrl(image.src);
    const fileId = objectId || imageFileIdFromUrl(image.src) || `image_${index + 1}`;
    const initialFile = path.join(folder, `q${image.questionIndex || 1}_${index + 1}_${slug(fileId)}.bin`);
    const result = await downloadFile(image.src, initialFile, submission.reviewUrl);
    if (!result.ok) {
      return { ...image, objectId, ok: false, error: result.error };
    }
    const finalFile = await normalizeExtension(result.file, result.contentType);
    const hash = await sha256File(finalFile);
    const ahash = await imageAhash(finalFile);
    return {
      ...image,
      objectId,
      ok: true,
      file: path.relative(outDir, finalFile),
      contentType: result.contentType,
      bytes: result.bytes,
      sha256: hash,
      ahash,
    };
  });
}

async function downloadFile(url, file, referer) {
  try {
    const res = await fetch(url, {
      headers: {
        'user-agent': UA,
        'referer': referer || BASE,
        'accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      },
      redirect: 'follow',
    });
    if (!res.ok || !res.body) {
      return { ok: false, error: `HTTP ${res.status}` };
    }
    await pipeline(res.body, createWriteStream(file));
    const st = await stat(file);
    return {
      ok: true,
      file,
      bytes: st.size,
      contentType: res.headers.get('content-type') || '',
    };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

async function normalizeExtension(file, contentType) {
  let ext = '';
  if (contentType.includes('png')) ext = '.png';
  else if (contentType.includes('jpeg') || contentType.includes('jpg')) ext = '.jpg';
  else if (contentType.includes('gif')) ext = '.gif';
  else if (contentType.includes('webp')) ext = '.webp';
  if (!ext) {
    try {
      const info = execFileSync('file', ['-b', '--mime-type', file], { encoding: 'utf8' }).trim();
      if (info.includes('png')) ext = '.png';
      else if (info.includes('jpeg')) ext = '.jpg';
      else if (info.includes('gif')) ext = '.gif';
      else if (info.includes('webp')) ext = '.webp';
    } catch {
      ext = '';
    }
  }
  if (!ext || file.endsWith(ext)) return file;
  const next = file.replace(/\.bin$/, ext);
  await rename(file, next);
  return next;
}

async function sha256File(file) {
  const data = await readFile(file);
  return createHash('sha256').update(data).digest('hex');
}

async function imageAhash(file) {
  try {
    const out = execFileSync('convert', [
      file,
      '-auto-orient',
      '-alpha', 'remove',
      '-alpha', 'off',
      '-resize', '8x8!',
      '-colorspace', 'Gray',
      '-depth', '8',
      'txt:-',
    ], { encoding: 'utf8', timeout: 15000 });
    const values = [];
    for (const line of out.split(/\r?\n/)) {
      const gray = line.match(/gray\((\d+(?:\.\d+)?)\)/i);
      const srgb = line.match(/srgb\((\d+),(\d+),(\d+)\)/i);
      if (gray) values.push(Number(gray[1]));
      else if (srgb) values.push((Number(srgb[1]) + Number(srgb[2]) + Number(srgb[3])) / 3);
    }
    if (values.length < 64) return null;
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    return values.slice(0, 64).map(v => v >= avg ? '1' : '0').join('');
  } catch {
    return null;
  }
}

function objectIdFromUrl(src) {
  const m = String(src || '').match(/\/origin\/([0-9a-fA-F]{16,})/);
  return m?.[1] || '';
}

function imageFileIdFromUrl(src) {
  const m = String(src || '').match(/\/([0-9a-fA-F]{16,})\.(?:png|jpe?g|gif|webp)(?:[?#].*)?$/i);
  return m?.[1] || '';
}

async function loadSubmissions(runDir) {
  const dir = path.join(runDir, 'submissions');
  const files = await readdir(dir);
  const submissions = [];
  for (const file of files.filter(f => f.endsWith('.json'))) {
    const submission = await readJson(path.join(dir, file));
    submission.__file = path.join(dir, file);
    submissions.push(submission);
  }
  return submissions;
}

async function applyLocalVisionOverrides(runDir, submissions, { persist = false } = {}) {
  const rows = await readJsonOptional(path.join(runDir, 'local_vision_overrides.json'), []);
  const overrides = new Map((Array.isArray(rows) ? rows : [])
    .filter(row => row?.workAnswerId)
    .map(row => [String(row.workAnswerId), row]));
  if (!overrides.size) return 0;

  let count = 0;
  for (const submission of submissions) {
    const override = overrides.get(String(submission.workAnswerId));
    if (!override) continue;
    submission.vision = {
      ...(submission.vision || {}),
      ...override,
      model: override.model || 'local-evidence-review',
      risk: override.risk || 'local-evidence-review',
    };
    count++;
    if (persist && submission.__file) {
      const copy = { ...submission };
      delete copy.__file;
      await jsonFile(submission.__file, copy);
    }
  }
  return count;
}

async function vision(opts) {
  const apiKey = process.env.MIMO_API_KEY;
  if (!apiKey) {
    throw new Error('MIMO_API_KEY is not set. Export it in the shell; do not put it in source files.');
  }
  const runDir = path.resolve(assertArg(opts.run, 'run'));
  const submissions = await loadSubmissions(runDir);
  await applyLocalVisionOverrides(runDir, submissions, { persist: true });
  const rubric = await loadRubric(opts, runDir);
  const calibration = buildCalibration(submissions, opts);
  await writeFile(path.join(runDir, 'calibration_used.txt'), calibration.text, 'utf8');
  const workAnswerIds = optionSet(opts['work-answer-ids']);
  const selectedBase = workAnswerIds.size
    ? submissions.filter(s => workAnswerIds.has(String(s.workAnswerId)))
    : submissions;
  const selected = opts['only-pending']
    ? selectedBase.filter(s => !/已完成|已批/.test(s.status))
    : selectedBase;
  const visionDir = path.join(runDir, 'vision');
  await mkdir(visionDir, { recursive: true });
  const rows = [];

  for (const [index, submission] of selected.entries()) {
    const outFile = path.join(visionDir, `${slug(submission.className)}_${slug(submission.studentNo)}_${slug(submission.name)}_${submission.workAnswerId}.json`);
    if (!opts.force && await fileExists(outFile)) {
      const cached = await readJson(outFile);
      if (isVisionCacheFresh(cached, submission)) {
        submission.vision = cached;
        rows.push(visionSummaryRow(submission, cached));
        console.log(`[${index + 1}/${selected.length}] cached ${submission.name}`);
        continue;
      }
      console.log(`[${index + 1}/${selected.length}] stale-cache ${submission.name}`);
    }
    console.log(`[${index + 1}/${selected.length}] vision ${submission.className} ${submission.name} ${submission.studentNo}`);
    const result = await analyzeSubmissionVision(submission, runDir, {
      endpoint: opts.endpoint || MIMO_ENDPOINT,
      model: opts.model || MIMO_MODEL,
      apiKey,
      rubric,
      calibration,
      assignmentTitle: opts['assignment-title'] || submission.review?.title || submission.assignmentTitle || '',
    });
    submission.vision = result;
    await jsonFile(outFile, result);
    if (submission.__file) {
      const copy = { ...submission };
      delete copy.__file;
      await jsonFile(submission.__file, copy);
    }
    rows.push(visionSummaryRow(submission, result));
    await sleep(Number(opts.delay || 900));
  }

  await writeFile(path.join(runDir, 'vision_summary.csv'), toCsv(rows, [
    'className', 'name', 'studentNo', 'workAnswerId', 'status',
    'score', 'contentScore', 'evidenceScore', 'layoutScore', 'risk',
    'summary', 'missing', 'comment',
  ]), 'utf8');
  console.log(`Wrote: ${path.join(runDir, 'vision_summary.csv')}`);
}

async function loadRubric(opts, runDir) {
  const candidates = [
    opts['rubric-file'],
    process.env.CHAOXING_RUBRIC_FILE,
    path.join(runDir, 'rubric_used.txt'),
    path.join(runDir, 'rubric.txt'),
    ...rubricCandidatesForRun(runDir),
  ].filter(Boolean);
  for (const candidate of candidates) {
    const file = path.resolve(candidate);
    if (!await fileExists(file)) continue;
    const raw = await readFile(file, 'utf8');
    const text = extractTextFromMaybeHtml(raw);
    const summary = summarizeRubric(text);
    await writeFile(path.join(runDir, 'rubric_used.txt'), summary, 'utf8');
    return { file, text: summary };
  }
  return { file: '', text: defaultCourseRubric() };
}

function rubricCandidatesForRun(runDir) {
  const name = path.basename(runDir).toLowerCase();
  const cwd = process.cwd();
  const rows = [];
  if (/log4j/.test(name)) {
    rows.push(path.join(cwd, 'Log4j漏洞实验指导手册_HTML版', 'Log4j漏洞实验指导手册.html'));
  }
  if (/ssrf/.test(name)) {
    rows.push(path.join(cwd, 'ssrf-lab-realistic', 'docs', 'SSRF实验指导手册.html'));
  }
  if (/命令注入|command/.test(name)) {
    rows.push(
      path.join(cwd, '命令注入实验指导手册_HTML版', '命令注入实验指导手册.html'),
      path.join(cwd, 'javacmd-lab-realistic', 'docs', '命令注入实验指导手册.html'),
    );
  }
  if (/transformer/.test(name)) {
    rows.push(
      path.join(cwd, '本节课交付清单_Transformer有回显RCE.md'),
      path.join(cwd, 'Transformer链可视化实验.html'),
      path.join(cwd, 'gadget-lab-realistic', 'docs', '实验指导手册.html'),
    );
  }
  if (/gadget|反序列化/.test(name)) {
    rows.push(
      path.join(cwd, 'gadget-lab-realistic', 'docs', '实验指导手册.html'),
      path.join(cwd, 'Java Gadget反序列化与Transformer有回显RCE_PPT文案.md'),
    );
  }
  if (/反射|reflection/.test(name)) {
    rows.push(
      path.join(cwd, 'reflection-lab-realistic', 'docs', '实验指导手册.html'),
      path.join(cwd, '反射.md'),
    );
  }
  if (/内存马|memory/.test(name)) {
    rows.push(
      path.join(cwd, '反序列化与内存马实验作业.html.txt'),
      path.join(cwd, 'NotebookLM导入版_反序列化与内存马原理材料.md'),
    );
  }
  if (/sql/.test(name)) {
    rows.push(
      path.join(cwd, 'SQL注入到RCE实验作业.html'),
      path.join(cwd, 'SQL注入到RCE实验作业.md'),
    );
  }
  if (/文件上传|upload/.test(name)) {
    rows.push(
      path.join(cwd, '文件上传漏洞实验作业.html'),
      path.join(cwd, '文件上传漏洞实验作业.md'),
    );
  }
  if (/逻辑漏洞|logic/.test(name)) {
    rows.push(path.join(cwd, '优惠券逻辑漏洞实验作业.md'));
  }
  rows.push(path.join(cwd, 'Log4j漏洞实验指导手册.html'));
  return rows;
}

function extractTextFromMaybeHtml(raw) {
  return String(raw || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(h[1-6]|p|div|li|tr|pre|code)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function summarizeRubric(text) {
  const lines = String(text || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const keywords = /实验目标|代码审计|漏洞|利用|成功|截图|修复|验证|payload|回显|回连|上传|注入|反序列化|gadget|cookie|xss|ssrf|sql|命令|反射|内存马|逻辑漏洞|评分|提交/i;
  const picked = [];
  for (const line of lines) {
    if (keywords.test(line) || picked.length < 20) picked.push(line);
    if (picked.join('\n').length > 9000) break;
  }
  const core = [
    '评分标准摘要：',
    '1. 必须结合本作业指导书判断截图是否证明实验成功，不能只按截图数量给分。',
    '2. 关键证据通常包括：实验环境/靶场、源码或关键代码审计结论、payload/请求或脚本、漏洞触发过程、成功结果截图、修复或总结。',
    '3. 成功作业应能串起完整链路：找到漏洞点、构造利用、触发目标、看到结果，并能说明原因。',
    '4. 如果只展示准备工作、工具启动、无关页面或结果不可读，即使排版好也不能给高分。',
    '5. 排版会影响分数：截图顺序、清晰度、关键区域是否被裁切/遮挡、文字是否可读、是否能串起完整实验过程。',
  ].join('\n');
  return `${core}\n\n指导书摘录：\n${picked.join('\n')}`.slice(0, 12000);
}

function defaultCourseRubric() {
  return [
    '信息安全代码审计实验通用评分标准：',
    '实验目标：结合指导书完成代码审计、漏洞定位、利用验证和结果说明。',
    '成功证据：靶场或环境页面、关键源码/审计结论、payload/请求/脚本、漏洞触发结果、成功验证截图、必要的修复说明。',
    '排版要求：截图清晰、顺序合理、关键文本可读、不要只贴无关页面或截断关键日志。',
  ].join('\n');
}

function buildCalibration(submissions, opts = {}) {
  const maxExamples = Number(opts['max-examples'] || process.env.CHAOXING_MAX_EXAMPLES || 14);
  const graded = submissions
    .filter(s => /已完成|已批/.test(s.status))
    .map(s => ({
      className: s.className,
      name: s.name,
      studentNo: s.studentNo,
      score: Number(reviewScore(s)),
      imageCount: s.review?.images?.length || 0,
      textLength: normalizeText(s.review?.answerText || '').length,
      comment: reviewComment(s),
    }))
    .filter(s => Number.isFinite(s.score))
    .sort((a, b) => b.score - a.score || b.imageCount - a.imageCount);

  const scoreBuckets = new Map();
  for (const item of graded) {
    const key = String(item.score);
    if (!scoreBuckets.has(key)) scoreBuckets.set(key, []);
    scoreBuckets.get(key).push(item);
  }

  const examples = [];
  for (const score of [...scoreBuckets.keys()].sort((a, b) => Number(b) - Number(a))) {
    examples.push(...scoreBuckets.get(score).slice(0, 3));
    if (examples.length >= maxExamples) break;
  }

  const distribution = [...scoreBuckets.entries()]
    .sort((a, b) => Number(b[0]) - Number(a[0]))
    .map(([score, rows]) => `${score}分:${rows.length}人`)
    .join('；');

  const exampleText = examples.slice(0, maxExamples).map(e => {
    const comment = e.comment ? `；教师评语：${e.comment}` : '';
    return `- ${e.score}分：${e.name}(${e.studentNo})，${e.imageCount}张图，提取文字${e.textLength}字${comment}`;
  }).join('\n');

  const text = [
    '教师已批样例/打分风格校准：',
    `已批分数分布：${distribution || '暂无已批样例'}`,
    '请参考这些已批分数的尺度，但不要机械按图片数量给分；必须结合指导书判断截图是否证明实验成功。',
    '一般尺度：100/95 表示完整或基本完整成功；90 表示主要成功但证据/排版略有不足；70/60 表示只体现部分过程或缺关键成功截图；0 表示无法验证有效完成。',
    '已批样例：',
    exampleText || '暂无',
  ].join('\n').slice(0, 7000);
  return { text, examples };
}

function cleanComment(value) {
  return extractTextFromMaybeHtml(String(value || ''))
    .replace(/\uFFFD+/g, '')
    .replace(/[^\S\r\n]+/g, ' ')
    .trim()
    .slice(0, 500);
}

function reviewScore(submission) {
  const questionScore = (submission.review?.formFields || [])
    .find(field => /^score\d+$/.test(String(field.name || '')))?.value;
  return questionScore || submission.existingScore || '';
}

function reviewComment(submission) {
  const questionComment = (submission.review?.formFields || [])
    .map(field => /^answer\d+$/.test(String(field.name || '')) ? cleanComment(field.value) : '')
    .filter(Boolean)
    .join('；');
  return questionComment || cleanComment(submission.review?.comment || '');
}

async function analyzeSubmissionVision(submission, runDir, config) {
  const assets = selectVisionAssets(submission);
  if (!assets.length) {
    return {
      model: config.model,
      score: 0,
      contentScore: 0,
      evidenceScore: 0,
      layoutScore: 0,
      risk: 'no_images',
      summary: '未提取到可识别的答案图片。',
      missing: ['答案截图'],
      comment: '未见有效作答截图，无法确认完成情况。',
      extractedText: '',
      rawText: '',
      usedImages: [],
    };
  }

  const selectedAssets = assets;
  const imageParts = [];
  for (const asset of selectedAssets) {
    const prepared = await prepareImageForModel(path.resolve(runDir, asset.file), runDir);
    const data = await readFile(prepared.file);
    const mime = prepared.mime;
    imageParts.push({
      type: 'image_url',
      image_url: { url: `data:${mime};base64,${data.toString('base64')}` },
    });
  }

  const prompt = [
    `你是信息安全代码审计课程的助教，正在批改“${config.assignmentTitle || submission.assignmentTitle || '当前实验'}”作业截图。`,
    '你必须严格依据下面的实验指导书/评分标准判断作业是否成功，不要只按截图数量给分。',
    '请同时考虑文字内容是否正确、实验过程是否完整、截图证据是否充分、排版/可读性是否影响核验。',
    '重点检查是否能看到：实验环境或靶场、关键源码或审计结论、payload/请求/脚本、漏洞触发过程、成功结果、最终验证结论。',
    '排版评分要考虑截图是否清晰、关键区域是否被遮挡或裁切、顺序是否便于阅读、是否只堆图但没有可读证据。',
    '如果截图无法证明本作业要求的漏洞利用或验证成功，即使排版好也不能给高分；如果内容正确但排版混乱或关键文字不可读，需要扣排版分。',
    '只返回严格 JSON，不要 Markdown。字段：score(0-100), contentScore(0-40), evidenceScore(0-40), layoutScore(0-20), risk, summary, missing(array), extractedText, comment。',
    `学生：${submission.className} ${submission.name} ${submission.studentNo}。平台状态：${submission.status}。`,
    `实验指导书/评分标准：\n${config.rubric?.text || defaultCourseRubric()}`,
    `已批样例校准：\n${config.calibration?.text || ''}`,
  ].join('\n');

  const body = {
    model: config.model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          ...imageParts,
        ],
      },
    ],
    temperature: 0.1,
  };

  const text = await callMimoChat(config, body, submission);
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { choices: [{ message: { content: text } }] };
  }
  const content = data?.choices?.[0]?.message?.content || data?.output_text || text;
  const parsed = parseJsonObject(content);
  const normalized = normalizeVisionResult(parsed, submission);
  normalized.model = config.model;
  normalized.rawText = content;
  normalized.usedImages = selectedAssets.map(a => a.file);
  return normalized;
}

function visionMaxImages() {
  const n = Number(process.env.MIMO_MAX_IMAGES || 6);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 6;
}

function isLikelyStudentAnswerImage(asset) {
  const bytes = Number(asset?.bytes || 0);
  const minBytes = Number(process.env.MIMO_MIN_IMAGE_BYTES || 5000);
  const file = String(asset?.file || asset?.name || '').toLowerCase();
  if (/(?:^|[/_-])(avatar|head|icon|logo|button|btn|emoji|face|loading|blank|default)(?:[/_.-]|$)/i.test(file)) {
    return false;
  }
  if (bytes > 0 && bytes < minBytes) return false;
  return true;
}

function selectVisionAssets(submission, maxImages = visionMaxImages()) {
  const assets = (submission.assets || []).filter(a => a.ok && a.file);
  const meaningful = assets.filter(isLikelyStudentAnswerImage);
  const pool = meaningful.length ? meaningful : assets;
  if (pool.length <= maxImages) return pool;

  const selected = new Set();
  const add = index => {
    if (index >= 0 && index < pool.length) selected.add(pool[index]);
  };

  for (let index = 0; index < Math.min(3, pool.length, maxImages); index++) add(index);
  for (let index = Math.max(0, pool.length - 2); index < pool.length; index++) add(index);

  const bySize = [...pool]
    .sort((a, b) => Number(b.bytes || 0) - Number(a.bytes || 0));
  for (const asset of bySize) {
    if (selected.size >= maxImages) break;
    selected.add(asset);
  }

  return pool.filter(asset => selected.has(asset)).slice(0, maxImages);
}

function isVisionCacheFresh(cached, submission) {
  const used = Array.isArray(cached?.usedImages) ? cached.usedImages.map(String) : [];
  const current = selectVisionAssets(submission).map(asset => String(asset.file));
  return used.length === current.length && used.every((file, index) => file === current[index]);
}

async function prepareImageForModel(file, runDir) {
  const maxBytes = Number(process.env.MIMO_IMAGE_MAX_BYTES || 900000);
  const maxSide = Number(process.env.MIMO_IMAGE_MAX_SIDE || 1800);
  const quality = Number(process.env.MIMO_JPEG_QUALITY || 82);
  const st = await stat(file);
  if (process.env.MIMO_NO_COMPRESS === '1' || st.size <= maxBytes) {
    return { file, mime: mimeFromFile(file) };
  }
  const cacheDir = path.join(runDir, '.mimo_image_cache');
  await mkdir(cacheDir, { recursive: true });
  const out = path.join(cacheDir, `${slug(path.relative(runDir, file))}_${maxSide}_${quality}.jpg`);
  if (!await fileExists(out)) {
    execFileSync('convert', [
      file,
      '-auto-orient',
      '-resize', `${maxSide}x${maxSide}>`,
      '-strip',
      '-quality', String(quality),
      out,
    ], { timeout: 120000 });
  }
  return { file: out, mime: 'image/jpeg' };
}

async function callMimoChat(config, body, submission) {
  const timeoutMs = Number(process.env.MIMO_TIMEOUT_MS || config.timeoutMs || 120000);
  const retries = Number(process.env.MIMO_RETRIES || 4);
  const baseMs = Number(process.env.MIMO_RETRY_BASE_MS || 5000);
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(`${config.endpoint.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'authorization': `Bearer ${config.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      if (res.ok) return text;
      lastError = new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`);
      if (!(res.status === 429 || res.status >= 500) || attempt >= retries) {
        throw lastError;
      }
    } catch (error) {
      lastError = error;
      if (attempt >= retries || !/429|timeout|fetch failed|ECONNRESET|ETIMEDOUT|HTTP 5/i.test(String(error?.message || error))) {
        throw error;
      }
    }
    const waitMs = Math.min(120000, baseMs * (2 ** Math.min(attempt, 5)) + Math.floor(Math.random() * 1000));
    console.log(`  Mimo retry ${attempt + 1}/${retries} after ${waitMs}ms: ${submission.name} (${String(lastError?.message || lastError).slice(0, 120)})`);
    await sleep(waitMs);
  }
  throw lastError || new Error('Mimo API failed');
}

function normalizeVisionResult(value, submission) {
  const result = value && typeof value === 'object' ? value : {};
  const score = clampScore(result.score ?? fallbackImageScore(submission));
  const contentScore = clampScore(result.contentScore ?? Math.round(score * 0.4), 40);
  const evidenceScore = clampScore(result.evidenceScore ?? Math.round(score * 0.4), 40);
  const layoutScore = clampScore(result.layoutScore ?? Math.round(score * 0.2), 20);
  return {
    score,
    contentScore,
    evidenceScore,
    layoutScore,
    risk: String(result.risk || '').slice(0, 200),
    summary: String(result.summary || '').slice(0, 1000),
    missing: Array.isArray(result.missing) ? result.missing.map(String).slice(0, 12) : [],
    extractedText: String(result.extractedText || '').slice(0, 6000),
    comment: String(result.comment || commentForDraft(score, '', 'Mimo vision')).slice(0, 1000),
  };
}

function parseJsonObject(text) {
  const s = String(text || '').trim();
  try {
    return JSON.parse(s);
  } catch {}
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try { return JSON.parse(fenced[1]); } catch {}
  }
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(s.slice(start, end + 1)); } catch {}
  }
  return {};
}

function mimeFromFile(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'image/png';
}

function clampScore(value, max = 100) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(max, Math.round(n)));
}

function optionSet(value) {
  return new Set(String(value || '')
    .split(/[,;\s]+/)
    .map(item => item.trim())
    .filter(Boolean));
}

function fallbackImageScore(submission) {
  const imageCount = validAssetCount(submission);
  if (imageCount >= 3) return 90;
  if (imageCount === 2) return 80;
  if (imageCount === 1) return 60;
  return 0;
}

function visionBasisLabel(visionResult) {
  const model = String(visionResult?.model || '');
  const risk = String(visionResult?.risk || '');
  if (/local-evidence|local_review|本地截图复核/i.test(`${model}\n${risk}`)) return '本地截图复核';
  return 'Mimo vision';
}

function visionSummaryRow(submission, visionResult) {
  return {
    className: submission.className,
    name: submission.name,
    studentNo: submission.studentNo,
    workAnswerId: submission.workAnswerId,
    status: submission.status,
    score: visionResult.score,
    contentScore: visionResult.contentScore,
    evidenceScore: visionResult.evidenceScore,
    layoutScore: visionResult.layoutScore,
    risk: visionResult.risk,
    summary: visionResult.summary,
    missing: (visionResult.missing || []).join('; '),
    comment: visionResult.comment,
  };
}

async function pairReview(opts) {
  const apiKey = process.env.MIMO_API_KEY;
  if (!apiKey) {
    throw new Error('MIMO_API_KEY is not set. Export it in the shell; do not put it in source files.');
  }
  const runDir = path.resolve(assertArg(opts.run, 'run'));
  const threshold = Number(opts.threshold || 0.92);
  const submissions = await loadSubmissions(runDir);
  await applyLocalVisionOverrides(runDir, submissions, { persist: false });
  const byId = new Map(submissions.map(s => [String(s.workAnswerId), s]));
  const nameFilter = opts.names
    ? new Set(String(opts.names).split(',').map(s => s.trim()).filter(Boolean))
    : null;
  let pairs = computeSimilarities(submissions)
    .filter(pair => pair.overall >= threshold || pair.exactObjectOverlap > 0 || pair.exactFileOverlap > 0)
    .sort((a, b) => b.overall - a.overall);
  if (nameFilter) {
    pairs = pairs.filter(pair => nameFilter.has(pair.aName) || nameFilter.has(pair.bName) || nameFilter.has(pair.aStudentNo) || nameFilter.has(pair.bStudentNo));
  }
  const limit = Number(opts.limit || pairs.length);
  pairs = pairs.slice(0, limit);

  const reviewDir = path.join(runDir, 'pair_review');
  await mkdir(reviewDir, { recursive: true });
  const rows = [];
  for (const [index, pair] of pairs.entries()) {
    const a = byId.get(String(pair.aWorkAnswerId));
    const b = byId.get(String(pair.bWorkAnswerId));
    if (!a || !b) continue;
    console.log(`[${index + 1}/${pairs.length}] pair-review ${a.name} vs ${b.name}`);
    const outFile = path.join(reviewDir, `${slug(a.name)}_${slug(a.studentNo)}__${slug(b.name)}_${slug(b.studentNo)}.json`);
    let result;
    if (!opts.force && await fileExists(outFile)) {
      result = await readJson(outFile);
    } else {
      result = await analyzePairSimilarity(a, b, runDir, {
        endpoint: opts.endpoint || MIMO_ENDPOINT,
        model: opts.model || MIMO_MODEL,
        apiKey,
        timeoutMs: Number(process.env.MIMO_TIMEOUT_MS || opts.timeout || 120000),
      });
      await jsonFile(outFile, result);
      await sleep(Number(opts.delay || 900));
    }
    rows.push(pairReviewRow(pair, a, b, result));
  }

  await jsonFile(path.join(runDir, 'pair_review.json'), rows);
  await writeFile(path.join(runDir, 'pair_review.csv'), toCsv(rows, [
    'aClass', 'aName', 'aStudentNo', 'bClass', 'bName', 'bStudentNo',
    'overall', 'reason', 'verdict', 'confidence', 'sameCoreEvidence',
    'sharedEvidence', 'differences', 'comment',
  ]), 'utf8');
  console.log(`Wrote: ${path.join(runDir, 'pair_review.csv')}`);
}

async function analyzePairSimilarity(a, b, runDir, config) {
  const imageParts = [];
  for (const [label, sub] of [['A', a], ['B', b]]) {
    const assets = (sub.assets || []).filter(asset => asset.ok && asset.file).slice(0, Number(process.env.MIMO_PAIR_MAX_IMAGES || 4));
    for (const [index, asset] of assets.entries()) {
      const file = path.resolve(runDir, asset.file);
      const data = await readFile(file);
      imageParts.push({ type: 'text', text: `${label} 图${index + 1}: ${sub.className} ${sub.name} ${sub.studentNo} 文件 ${asset.file}` });
      imageParts.push({
        type: 'image_url',
        image_url: { url: `data:${mimeFromFile(file)};base64,${data.toString('base64')}` },
      });
    }
  }

  const prompt = [
    '你是信息安全课程作业抄袭复核助教。请比较两名学生的 Log4J 漏洞实验截图，判断是否疑似雷同/抄袭。',
    '重要：相同的黑底终端、同一工具界面、类似 JNDI-Injection-Exploit 输出格式、HTTP server 日志格式，不能单独作为抄袭证据。',
    '请重点比较核心证据是否一致：IP、端口、payload 随机路径、LDAP/RMI/DNS/HTTP 回连路径、命令输出、文件名、截图顺序、错误信息、时间/终端内容、是否同一张图裁剪。',
    '如果只是版式相似但 IP/payload/路径/日志内容明显不同，应判定为 not_plagiarism 或 uncertain，而不是 plagiarism。',
    '只返回严格 JSON，字段：verdict(plagiarism|not_plagiarism|uncertain), confidence(0-100), sameCoreEvidence(boolean), sharedEvidence(array), differences(array), comment。',
    `A 学生：${a.className} ${a.name} ${a.studentNo}`,
    `A 识图摘要：${a.vision?.summary || ''}`,
    `A 提取文字：${a.vision?.extractedText || ''}`,
    `B 学生：${b.className} ${b.name} ${b.studentNo}`,
    `B 识图摘要：${b.vision?.summary || ''}`,
    `B 提取文字：${b.vision?.extractedText || ''}`,
  ].join('\n');

  const body = {
    model: config.model,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, ...imageParts] }],
    temperature: 0.05,
  };

  let res;
  try {
    res = await fetch(`${config.endpoint.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${config.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.timeoutMs || 120000),
    });
  } catch (e) {
    return {
      verdict: 'uncertain',
      confidence: 0,
      sameCoreEvidence: false,
      sharedEvidence: [],
      differences: [],
      comment: `Mimo 成对复核失败：${String(e?.message || e).slice(0, 300)}`,
    };
  }
  const text = await res.text();
  if (!res.ok) {
    return {
      verdict: 'uncertain',
      confidence: 0,
      sameCoreEvidence: false,
      sharedEvidence: [],
      differences: [],
      comment: `Mimo 成对复核失败：HTTP ${res.status}`,
      rawText: text.slice(0, 2000),
    };
  }
  const data = parseJsonObject(JSON.parse(text)?.choices?.[0]?.message?.content || text);
  return normalizePairReview(data);
}

function normalizePairReview(value) {
  const result = value && typeof value === 'object' ? value : {};
  const verdict = ['plagiarism', 'not_plagiarism', 'uncertain'].includes(result.verdict) ? result.verdict : 'uncertain';
  return {
    verdict,
    confidence: clampScore(result.confidence || 0),
    sameCoreEvidence: Boolean(result.sameCoreEvidence),
    sharedEvidence: Array.isArray(result.sharedEvidence) ? result.sharedEvidence.map(String).slice(0, 10) : [],
    differences: Array.isArray(result.differences) ? result.differences.map(String).slice(0, 10) : [],
    comment: String(result.comment || '').slice(0, 1000),
  };
}

function pairReviewRow(pair, a, b, result) {
  return {
    aClass: a.className,
    aName: a.name,
    aStudentNo: a.studentNo,
    bClass: b.className,
    bName: b.name,
    bStudentNo: b.studentNo,
    overall: pair.overall,
    reason: pair.reason,
    verdict: result.verdict,
    confidence: result.confidence,
    sameCoreEvidence: result.sameCoreEvidence,
    sharedEvidence: (result.sharedEvidence || []).join('; '),
    differences: (result.differences || []).join('; '),
    comment: result.comment,
  };
}

async function grade(opts) {
  const runDir = path.resolve(assertArg(opts.run, 'run'));
  const threshold = Number(opts.threshold || 0.92);
  const submissions = await loadSubmissions(runDir);
  const unsubmitted = await loadUnsubmittedRows(runDir, submissions);
  const localOverrides = await applyLocalVisionOverrides(runDir, submissions, { persist: true });
  const pairs = computeSimilarities(submissions)
    .filter(pair => pair.overall >= threshold || pair.exactObjectOverlap > 0 || pair.exactFileOverlap > 0)
    .sort((a, b) => b.overall - a.overall);

  await jsonFile(path.join(runDir, 'similarity_report.json'), pairs);
  await writeFile(path.join(runDir, 'similarity_report.csv'), toCsv(pairs, [
    'overall', 'textSimilarity', 'imageSimilarity', 'evidenceSimilarity', 'exactObjectOverlap', 'exactFileOverlap',
    'sharedEvidence',
    'aClass', 'aName', 'aStudentNo', 'aStatus', 'aScore',
    'bClass', 'bName', 'bStudentNo', 'bStatus', 'bScore',
    'reason',
  ]), 'utf8');

  const drafts = [
    ...buildDrafts(submissions, pairs, opts),
    ...buildUnsubmittedDrafts(unsubmitted),
  ];
  await jsonFile(path.join(runDir, 'grading_draft.json'), drafts);
  await writeFile(path.join(runDir, 'grading_draft.csv'), toCsv(drafts, [
    'approved', 'skip', 'className', 'name', 'studentNo', 'workAnswerId',
    'status', 'existingScore', 'draftScore', 'draftComment', 'risk', 'basis', 'reviewUrl',
  ]), 'utf8');
  await writeFile(path.join(runDir, 'review_report.html'), htmlReport(submissions, drafts, pairs), 'utf8');

  const pending = drafts.filter(d => !d.skip);
  console.log(`Submissions: ${submissions.length}`);
  if (unsubmitted.length) console.log(`Unsubmitted rows: ${unsubmitted.length}`);
  if (localOverrides) console.log(`Applied local vision overrides: ${localOverrides}`);
  console.log(`Similarity pairs >= ${threshold}: ${pairs.length}`);
  console.log(`Drafts needing review: ${pending.length}`);
  console.log(`Wrote: ${path.join(runDir, 'grading_draft.csv')}`);
}

async function loadUnsubmittedRows(runDir, submissions = []) {
  const rows = await readJsonOptional(path.join(runDir, 'unsubmitted_students.json'), []);
  if (!Array.isArray(rows) || !rows.length) return [];
  const submittedKeys = new Set(submissions.map(row =>
    `${row.className || ''}\n${row.studentNo || ''}\n${row.name || ''}`));
  return rows.filter(row => !submittedKeys.has(`${row.className || ''}\n${row.studentNo || ''}\n${row.name || ''}`));
}

function buildUnsubmittedDrafts(rows) {
  return rows.map(row => ({
    approved: false,
    skip: false,
    className: row.className,
    name: row.name,
    studentNo: row.studentNo,
    workAnswerId: row.workAnswerId || `unsubmitted-${row.classId || ''}-${row.studentNo || row.name || ''}`,
    status: '未交',
    existingScore: '',
    draftScore: 0,
    draftComment: '平台未显示已交作业，未提供可批阅作业内容和截图，按未交处理。',
    risk: '',
    basis: `not submitted: ${row.submitTime || ''}${row.ip ? ` ${row.ip}` : ''}`.trim(),
    reviewUrl: '',
  }));
}

function computeSimilarities(submissions) {
  const commonAssets = buildCommonAssetIndex(submissions);
  const commonEvidenceTokens = buildCommonEvidenceTokenIndex(submissions);
  const pairs = [];
  for (let i = 0; i < submissions.length; i++) {
    for (let j = i + 1; j < submissions.length; j++) {
      const a = submissions[i];
      const b = submissions[j];
      const textSimilarity = textSim(a.review.answerText, b.review.answerText);
      const imageResult = imageSim(a, b, commonAssets);
      const evidenceResult = evidenceSim(a, b, commonEvidenceTokens);
      const overall = Math.max(textSimilarity, imageResult.score, evidenceResult.score);
      pairs.push({
        overall: round(overall),
        textSimilarity: round(textSimilarity),
        imageSimilarity: round(imageResult.score),
        evidenceSimilarity: round(evidenceResult.score),
        exactObjectOverlap: imageResult.exactObjectOverlap,
        exactFileOverlap: imageResult.exactFileOverlap,
        sharedEvidence: evidenceResult.shared.join('; '),
        aClass: a.className,
        aName: a.name,
        aStudentNo: a.studentNo,
        aStatus: a.status,
        aScore: a.existingScore,
        bClass: b.className,
        bName: b.name,
        bStudentNo: b.studentNo,
        bStatus: b.status,
        bScore: b.existingScore,
        aWorkAnswerId: a.workAnswerId,
        bWorkAnswerId: b.workAnswerId,
        reason: imageResult.reason || evidenceResult.reason || (textSimilarity >= 0.85 ? 'text highly similar' : ''),
      });
    }
  }
  return pairs;
}

function buildCommonEvidenceTokenIndex(submissions) {
  const counts = new Map();
  for (const submission of submissions) {
    for (const token of evidenceTokens(evidenceText(submission))) {
      counts.set(token, (counts.get(token) || 0) + 1);
    }
  }
  const n = Math.max(1, submissions.length);
  const minFreq = Number(process.env.COMMON_EVIDENCE_MIN_FREQ || 5);
  const minRatio = Number(process.env.COMMON_EVIDENCE_MIN_RATIO || 0.20);
  return new Set([...counts.entries()]
    .filter(([, count]) => count >= minFreq && count / n >= minRatio)
    .map(([value]) => value));
}

function buildCommonAssetIndex(submissions) {
  const objectCounts = new Map();
  const shaCounts = new Map();
  for (const submission of submissions) {
    const objects = new Set();
    const hashes = new Set();
    for (const asset of submission.assets || []) {
      if (!asset.ok) continue;
      const objectId = realObjectId(asset);
      if (objectId) objects.add(objectId);
      if (asset.sha256) hashes.add(asset.sha256);
    }
    for (const value of objects) objectCounts.set(value, (objectCounts.get(value) || 0) + 1);
    for (const value of hashes) shaCounts.set(value, (shaCounts.get(value) || 0) + 1);
  }
  const n = Math.max(1, submissions.length);
  const minFreq = Number(process.env.COMMON_ASSET_MIN_FREQ || 5);
  const minRatio = Number(process.env.COMMON_ASSET_MIN_RATIO || 0.20);
  const commonObjects = new Set([...objectCounts.entries()]
    .filter(([, count]) => count >= minFreq && count / n >= minRatio)
    .map(([value]) => value));
  const commonHashes = new Set([...shaCounts.entries()]
    .filter(([, count]) => count >= minFreq && count / n >= minRatio)
    .map(([value]) => value));
  return { commonObjects, commonHashes };
}

function isCommonAsset(asset, commonAssets) {
  if (!commonAssets) return false;
  const objectId = realObjectId(asset);
  const sha = asset?.sha256 || '';
  return Boolean((objectId && commonAssets.commonObjects.has(objectId)) || (sha && commonAssets.commonHashes.has(sha)));
}

function round(n) {
  return Math.round(Number(n || 0) * 10000) / 10000;
}

function imageSim(a, b, commonAssets = null) {
  const aAssets = (a.assets || []).filter(x => x.ok && !isCommonAsset(x, commonAssets));
  const bAssets = (b.assets || []).filter(x => x.ok && !isCommonAsset(x, commonAssets));
  const aObj = new Set(aAssets.map(realObjectId).filter(Boolean));
  const bObj = new Set(bAssets.map(realObjectId).filter(Boolean));
  const aSha = new Set(aAssets.map(x => x.sha256).filter(Boolean));
  const bSha = new Set(bAssets.map(x => x.sha256).filter(Boolean));
  const exactObjectOverlap = [...aObj].filter(x => bObj.has(x)).length;
  const exactFileOverlap = [...aSha].filter(x => bSha.has(x)).length;
  if (exactObjectOverlap || exactFileOverlap) {
    return {
      score: 1,
      exactObjectOverlap,
      exactFileOverlap,
      reason: exactObjectOverlap ? 'same uploaded object id' : 'same downloaded file hash',
    };
  }
  const aHashes = aAssets.map(x => x.ahash).filter(Boolean);
  const bHashes = bAssets.map(x => x.ahash).filter(Boolean);
  if (!aHashes.length || !bHashes.length) {
    return { score: 0, exactObjectOverlap, exactFileOverlap, reason: '' };
  }
  const shorter = aHashes.length <= bHashes.length ? aHashes : bHashes;
  const longer = aHashes.length <= bHashes.length ? bHashes : aHashes;
  let total = 0;
  for (const h of shorter) {
    const best = Math.max(...longer.map(other => 1 - hamming(h, other) / 64));
    total += best;
  }
  return {
    score: total / shorter.length,
    exactObjectOverlap,
    exactFileOverlap,
    reason: 'image perceptual hash similar',
  };
}

function realObjectId(asset) {
  const objectId = String(asset?.objectId || '');
  if (objectId && !/^image_\d+$/.test(objectId)) return objectId;
  return imageFileIdFromUrl(asset?.src || '');
}

function hamming(a, b) {
  let count = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) count++;
  }
  return count + Math.abs(a.length - b.length);
}

function textSim(a, b) {
  const aa = normalizeText(a);
  const bb = normalizeText(b);
  if (aa.length < 20 || bb.length < 20) return 0;
  const as = ngrams(aa, 3);
  const bs = ngrams(bb, 3);
  let intersection = 0;
  for (const x of as) if (bs.has(x)) intersection++;
  const union = as.size + bs.size - intersection;
  return union ? intersection / union : 0;
}

function evidenceSim(a, b, commonTokens = new Set()) {
  const aTokens = new Set([...evidenceTokens(evidenceText(a))].filter(token => !commonTokens.has(token)));
  const bTokens = new Set([...evidenceTokens(evidenceText(b))].filter(token => !commonTokens.has(token)));
  if (aTokens.size < 3 || bTokens.size < 3) return { score: 0, shared: [], reason: '' };
  const shared = [...aTokens].filter(token => bTokens.has(token)).sort();
  const union = new Set([...aTokens, ...bTokens]);
  const jaccard = shared.length / union.size;
  const containment = shared.length / Math.min(aTokens.size, bTokens.size);
  const score = Math.max(jaccard, containment);
  return {
    score,
    shared,
    reason: score >= 0.7 ? 'core evidence text similar' : '',
  };
}

function evidenceText(submission) {
  const vision = submission.vision || {};
  return [
    vision.extractedText || '',
    vision.summary || '',
    vision.comment || '',
    submission.review?.answerText || '',
  ].join('\n');
}

function evidenceTokens(text) {
  const value = String(text || '').toLowerCase();
  const tokens = new Set();
  const patterns = [
    /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
    /\b(?:nc|ncat)\s+-[a-z]*\s*(?:\d{2,5})\b/g,
    /\blistening\s+on\s+(?:\d{1,3}\.){3}\d{1,3}\s+\d{2,5}\b/g,
    /\bconnection\s+received\s+on\s+(?:\d{1,3}\.){3}\d{1,3}\s+\d{2,5}\b/g,
    /\bdocker\s+compose\s+up\s+--build\b/g,
    /\bcommand\s+'docker'\s+not\s+found\b/g,
    /\b(?:apt\s+install\s+)?(?:docker\.io|podman-docker)\b/g,
    /\bbuilding\s+war:\s*\S+\.war\b/g,
    /\b[\w.-]+\.war\b/g,
    /\b(?:ldap|rmi|http):\/\/[^\s"'<>]+/g,
    /\/(?:rce|uvvvi|exec|exectemplate)[\w.-]*/g,
    /\bexectemplatejdk8(?:\.class)?\b/g,
    /\brce[-_][a-z0-9_-]+/g,
    /\bsqli\b/g,
  ];
  for (const pattern of patterns) {
    for (const match of value.matchAll(pattern)) {
      tokens.add(match[0].replace(/\s+/g, ' ').trim());
    }
  }
  return tokens;
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, '').replace(/[，。；：,.!?！？、]/g, '').toLowerCase();
}

function studentEvidenceText(review = {}) {
  if (review.studentAnswerText) return String(review.studentAnswerText);
  const text = String(review.answerText || '');
  const markers = ['学生答案：', '学生答案:', '学生作答：', '学生作答:', '作答：', '作答:'];
  let start = -1;
  for (const marker of markers) {
    const index = text.indexOf(marker);
    if (index >= 0 && (start < 0 || index < start)) start = index + marker.length;
  }
  if (start < 0) return '';
  const tail = text.slice(start);
  const endMarkers = ['正确答案：', '正确答案:', '评分', '题目批语', '快速评语', '添加标记', '相似度查询', '作业批语：', '作业批语:'];
  const end = endMarkers
    .map(marker => tail.indexOf(marker))
    .filter(index => index >= 0)
    .sort((a, b) => a - b)[0];
  return end == null ? tail : tail.slice(0, end);
}

function validAssetCount(submission) {
  if (Array.isArray(submission?.assets)) {
    return submission.assets.filter(asset => asset?.ok && asset?.file).length;
  }
  return submission?.review?.images?.length || 0;
}

function ngrams(text, n) {
  const set = new Set();
  for (let i = 0; i <= text.length - n; i++) set.add(text.slice(i, i + n));
  return set;
}

function buildDrafts(submissions, pairs, opts = {}) {
  const byId = new Map(submissions.map(s => [String(s.workAnswerId), s]));
  const pairById = new Map();
  for (const pair of pairs) {
    for (const id of [pair.aWorkAnswerId, pair.bWorkAnswerId]) {
      if (!pairById.has(String(id))) pairById.set(String(id), []);
      pairById.get(String(id)).push(pair);
    }
  }
  const firstSubmitRules = opts['first-submit-wins']
    ? buildFirstSubmitRules(submissions, pairs, {
      threshold: Number(opts['plagiarism-threshold'] || opts.threshold || 0.92),
      includeFuzzy: Boolean(opts['first-submit-include-fuzzy']),
    })
    : new Map();

  return submissions.map(sub => {
    const existingScore = parseFloat(sub.existingScore);
    const completed = /已完成|已批/.test(sub.status);
    if (completed) {
      return {
        approved: false,
        skip: true,
        className: sub.className,
        name: sub.name,
        studentNo: sub.studentNo,
        workAnswerId: sub.workAnswerId,
        status: sub.status,
        existingScore: reviewScore(sub),
        draftScore: reviewScore(sub),
        draftComment: reviewComment(sub),
        risk: '',
        basis: 'already graded',
        reviewUrl: sub.reviewUrl,
      };
    }

    const related = (pairById.get(String(sub.workAnswerId)) || []).sort((a, b) => b.overall - a.overall);
    const firstSubmitRule = firstSubmitRules.get(String(sub.workAnswerId));
    const nearestGraded = related
      .map(pair => {
        const otherId = String(pair.aWorkAnswerId) === String(sub.workAnswerId) ? pair.bWorkAnswerId : pair.aWorkAnswerId;
        const other = byId.get(String(otherId));
        const score = parseFloat(other?.existingScore);
        return { pair, other, score };
      })
      .find(x => x.other && /已完成|已批/.test(x.other.status) && !Number.isNaN(x.score));

    const visionResult = sub.vision && Number.isFinite(Number(sub.vision.score)) ? sub.vision : null;
    const imageCount = validAssetCount(sub);
    const textLen = normalizeText(studentEvidenceText(sub.review)).length;
    let draftScore;
    let basis;
    if (firstSubmitRule) {
      draftScore = 0;
      basis = firstSubmitRule.basis;
    } else if (visionResult) {
      draftScore = clampScore(visionResult.score);
      basis = `${visionBasisLabel(visionResult)}: content ${visionResult.contentScore ?? ''}/40, evidence ${visionResult.evidenceScore ?? ''}/40, layout ${visionResult.layoutScore ?? ''}/20`;
    } else if (nearestGraded && nearestGraded.pair.overall >= 0.95) {
      draftScore = nearestGraded.score;
      basis = `matched graded sample ${nearestGraded.other.name} (${nearestGraded.pair.overall})`;
    } else if (imageCount >= 3 || textLen >= 500) {
      draftScore = 90;
      basis = 'has three or more submitted images or substantial text';
    } else if (imageCount === 2 || textLen >= 250) {
      draftScore = 80;
      basis = 'has partial but usable evidence';
    } else if (imageCount === 1 || textLen >= 80) {
      draftScore = 60;
      basis = 'has limited evidence';
    } else {
      draftScore = 0;
      basis = 'no usable answer content extracted';
    }

    const highRisk = related.filter(p => p.exactObjectOverlap > 0 || p.exactFileOverlap > 0);
    const risk = highRisk.length
      ? highRisk.slice(0, 3).map(p => {
          const otherName = p.aWorkAnswerId === sub.workAnswerId ? p.bName : p.aName;
          return `${otherName}:${p.overall}`;
        }).join('; ')
      : '';
    const comment = firstSubmitRule
      ? firstSubmitRule.comment
      : visionResult
      ? visionCommentForDraft(visionResult, risk, basis)
      : commentForDraft(draftScore, risk, basis);
    return {
      approved: false,
      skip: false,
      className: sub.className,
      name: sub.name,
      studentNo: sub.studentNo,
      workAnswerId: sub.workAnswerId,
      status: sub.status,
      existingScore: sub.existingScore,
      draftScore,
      draftComment: comment,
      risk,
      basis,
      reviewUrl: sub.reviewUrl,
    };
  });
}

function buildFirstSubmitRules(submissions, pairs, options = {}) {
  const threshold = Number(options.threshold || 0.92);
  const includeFuzzy = Boolean(options.includeFuzzy);
  const parent = new Map(submissions.map(s => [String(s.workAnswerId), String(s.workAnswerId)]));
  const qualifyingPairs = pairs.filter(pair =>
    pair.exactObjectOverlap > 0 ||
    pair.exactFileOverlap > 0 ||
    (includeFuzzy && pair.overall >= threshold)
  );

  function find(id) {
    const key = String(id);
    const p = parent.get(key) || key;
    if (p === key) return key;
    const root = find(p);
    parent.set(key, root);
    return root;
  }

  function union(a, b) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  }

  for (const pair of qualifyingPairs) {
    union(pair.aWorkAnswerId, pair.bWorkAnswerId);
  }

  const groups = new Map();
  for (const sub of submissions) {
    const root = find(sub.workAnswerId);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(sub);
  }

  const pairKey = (a, b) => [String(a), String(b)].sort().join('::');
  const pairByKey = new Map();
  for (const pair of qualifyingPairs) {
    pairByKey.set(pairKey(pair.aWorkAnswerId, pair.bWorkAnswerId), pair);
  }

  const rules = new Map();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const ordered = group.slice().sort(compareSubmitOrder);
    const first = ordered[0];
    for (const sub of ordered.slice(1)) {
      if (/已完成|已批/.test(sub.status)) continue;
      let bestPair = pairByKey.get(pairKey(first.workAnswerId, sub.workAnswerId));
      if (!bestPair) {
        bestPair = qualifyingPairs
          .filter(pair =>
            String(pair.aWorkAnswerId) === String(sub.workAnswerId) ||
            String(pair.bWorkAnswerId) === String(sub.workAnswerId)
          )
          .sort((a, b) => b.overall - a.overall)[0];
      }
      const basis = `首个提交保留分：本组最早提交为 ${first.name}(${first.studentNo}) ${first.submitTime || '未知时间'}；当前提交 ${sub.submitTime || '未知时间'}，相似度 ${bestPair?.overall ?? ''}`;
      const comment = `作业与 ${first.name}(${first.studentNo}) 等同学提交内容高度雷同，且提交时间晚于本组首个提交者，按“第一个做出来的有分，后续雷同作业 0 分”处理。`;
      rules.set(String(sub.workAnswerId), { first, pair: bestPair, basis, comment });
    }
  }
  return rules;
}

function compareSubmitOrder(a, b) {
  const at = parseSubmitTime(a.submitTime);
  const bt = parseSubmitTime(b.submitTime);
  if (at !== bt) return at - bt;
  return String(a.studentNo || '').localeCompare(String(b.studentNo || ''), 'zh-Hans-CN');
}

function parseSubmitTime(value) {
  const text = String(value || '').trim();
  const full = text.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (full) {
    return new Date(
      Number(full[1]),
      Number(full[2]) - 1,
      Number(full[3]),
      Number(full[4]),
      Number(full[5]),
      Number(full[6] || 0),
    ).getTime();
  }
  const partial = text.match(/(\d{1,2})[-/](\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (partial) {
    return new Date(
      new Date().getFullYear(),
      Number(partial[1]) - 1,
      Number(partial[2]),
      Number(partial[3]),
      Number(partial[4]),
      Number(partial[5] || 0),
    ).getTime();
  }
  return Number.MAX_SAFE_INTEGER;
}

function commentForDraft(score, risk, basis) {
  let text;
  if (score >= 90) text = '作业材料较完整，能够体现主要实验过程和结果。';
  else if (score >= 80) text = '作业基本完成，过程或结果证据略有缺失。';
  else if (score >= 60) text = '作业提交内容偏少，关键步骤和结果说明不够完整。';
  else text = '未见有效作答内容或附件，无法确认完成情况。';
  if (risk) text += ` 检测到与其他同学提交内容高度相似：${risk}，请后续注意独立完成。`;
  text += ` 评分依据：${basis}。`;
  return text;
}

function visionCommentForDraft(visionResult, risk, basis) {
  let text = visionResult.comment || commentForDraft(visionResult.score, '', basis);
  const missing = Array.isArray(visionResult.missing) && visionResult.missing.length
    ? ` 缺失或不足：${visionResult.missing.join('、')}。`
    : '';
  if (missing && !text.includes('缺失')) text += missing;
  if (risk) text += ` 检测到与其他同学提交内容高度相似：${risk}，请后续注意独立完成。`;
  text += ` 评分依据：${basis}。`;
  return text;
}

function htmlReport(submissions, drafts, pairs) {
  const byId = new Map(submissions.map(s => [String(s.workAnswerId), s]));
  const pending = drafts.filter(d => !d.skip);
  const scoreCounts = new Map();
  for (const d of pending) scoreCounts.set(String(d.draftScore), (scoreCounts.get(String(d.draftScore)) || 0) + 1);
  const riskCount = pending.filter(d => d.risk).length;
  const cards = pending
    .slice()
    .sort((a, b) => (b.risk ? 1 : 0) - (a.risk ? 1 : 0) || a.className.localeCompare(b.className, 'zh-Hans-CN') || a.studentNo.localeCompare(b.studentNo))
    .map(d => {
      const sub = byId.get(String(d.workAnswerId));
      const vision = sub?.vision;
      const images = (sub?.assets || []).filter(a => a.ok).map(asset => `
        <a href="${attr(asset.file)}" target="_blank" title="${attr(asset.objectId || '')}">
          <img src="${attr(asset.file)}" alt="${attr(d.name)} answer image">
        </a>`).join('');
      const visionLine = vision ? `
          <p class="vision">识图：内容 ${esc(vision.contentScore ?? '')}/40 · 证据 ${esc(vision.evidenceScore ?? '')}/40 · 排版 ${esc(vision.layoutScore ?? '')}/20</p>
          ${vision.summary ? `<p class="summary-text">${esc(vision.summary)}</p>` : ''}` : '';
      return `
        <section class="card ${d.risk ? 'risk' : ''}">
          <div class="card-head">
            <div>
              <h2>${esc(d.name)} <span>${esc(d.studentNo)}</span></h2>
              <p>${esc(d.className)} · ${esc(d.status)} · ${esc(String(sub?.review?.images?.length || 0))} 张图</p>
            </div>
            <div class="score">${esc(d.draftScore)}</div>
          </div>
          ${d.risk ? `<div class="riskline">相似风险：${esc(d.risk)}</div>` : ''}
          ${visionLine}
          <p class="comment">${esc(d.draftComment)}</p>
          <p class="basis">${esc(d.basis)}</p>
          <div class="images">${images || '<span class="empty">无图片</span>'}</div>
          <p class="links"><a href="${attr(d.reviewUrl)}" target="_blank">打开超星批阅页</a></p>
        </section>`;
    }).join('\n');
  const pairRows = pairs.slice(0, 80).map(pair => `
    <tr>
      <td>${esc(pair.overall)}</td>
      <td>${esc(pair.reason)}</td>
      <td>${esc(pair.aClass)} / ${esc(pair.aName)} / ${esc(pair.aStudentNo)}</td>
      <td>${esc(pair.bClass)} / ${esc(pair.bName)} / ${esc(pair.bStudentNo)}</td>
    </tr>`).join('\n');
  const scoreText = [...scoreCounts.entries()].sort((a, b) => Number(a[0]) - Number(b[0])).map(([score, count]) => `${score}: ${count}`).join(' / ');
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>超星作业批改复核报告</title>
<style>
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #1f2937; background: #f6f7f9; }
  header { padding: 24px 32px; background: #ffffff; border-bottom: 1px solid #e5e7eb; position: sticky; top: 0; z-index: 2; }
  h1 { margin: 0 0 8px; font-size: 24px; }
  .summary { display: flex; gap: 18px; flex-wrap: wrap; color: #4b5563; font-size: 14px; }
  main { padding: 24px 32px 48px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap: 16px; align-items: start; }
  .card { background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; padding: 16px; }
  .card.risk { border-color: #dc2626; box-shadow: inset 4px 0 0 #dc2626; }
  .card-head { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; }
  h2 { margin: 0; font-size: 18px; }
  h2 span { color: #6b7280; font-size: 13px; font-weight: 500; }
  p { margin: 6px 0; }
  .score { min-width: 54px; height: 42px; border-radius: 6px; display: grid; place-items: center; background: #111827; color: #fff; font-size: 22px; font-weight: 700; }
  .riskline { margin: 12px 0 8px; padding: 8px 10px; border-radius: 6px; background: #fef2f2; color: #991b1b; font-size: 13px; }
  .comment { line-height: 1.55; }
  .vision { color: #14532d; background: #f0fdf4; border-radius: 6px; padding: 7px 9px; font-size: 13px; }
  .summary-text { color: #374151; font-size: 13px; line-height: 1.5; }
  .basis { color: #6b7280; font-size: 12px; }
  .images { display: grid; grid-template-columns: repeat(auto-fill, minmax(92px, 1fr)); gap: 8px; margin-top: 12px; }
  .images a { display: block; background: #f3f4f6; border: 1px solid #e5e7eb; border-radius: 6px; overflow: hidden; height: 110px; }
  .images img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .empty { color: #9ca3af; font-size: 13px; }
  .links a { color: #2563eb; font-size: 13px; }
  table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 8px; overflow: hidden; margin-top: 16px; }
  th, td { border-bottom: 1px solid #e5e7eb; padding: 10px 12px; text-align: left; font-size: 13px; vertical-align: top; }
  th { background: #f9fafb; font-weight: 700; }
  .section-title { margin: 28px 0 12px; font-size: 18px; }
</style>
</head>
<body>
<header>
  <h1>超星作业批改复核报告</h1>
  <div class="summary">
    <span>提交总数：${submissions.length}</span>
    <span>待批草稿：${pending.length}</span>
    <span>有相似风险：${riskCount}</span>
    <span>分数分布：${esc(scoreText || '无')}</span>
    <span><a href="grading_draft.csv">grading_draft.csv</a></span>
    <span><a href="similarity_report.csv">similarity_report.csv</a></span>
  </div>
</header>
<main>
  <div class="grid">${cards}</div>
  <h2 class="section-title">高相似记录</h2>
  <table>
    <thead><tr><th>相似度</th><th>依据</th><th>学生 A</th><th>学生 B</th></tr></thead>
    <tbody>${pairRows || '<tr><td colspan="4">无</td></tr>'}</tbody>
  </table>
</main>
</body>
</html>`;
}

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function attr(value) {
  return esc(String(value ?? '').split(path.sep).join('/'));
}

async function submit(opts) {
  const runDir = path.resolve(assertArg(opts.run, 'run'));
  const draftFile = opts.draft ? path.resolve(opts.draft) : path.join(runDir, 'grading_draft.json');
  const drafts = await readJson(draftFile);
  const candidates = drafts.filter(d => !d.skip && d.reviewUrl && (opts.all || d.approved === true));
  if (!candidates.length) {
    console.log('No draft rows selected. Set approved=true in grading_draft.json, or pass --all.');
    return;
  }
  console.log(`Selected ${candidates.length} row(s) for submission.`);
  if (!opts.quiet) {
    for (const d of candidates) {
      console.log(`${d.className} ${d.name} ${d.studentNo}: ${d.draftScore} - ${d.draftComment}`);
    }
  }
  if (!opts.apply) {
    console.log('Dry run only. Re-run with --apply to submit to Chaoxing.');
    return;
  }
  if (!opts['allow-zero'] && candidates.some(d => Number(d.draftScore) === 0)) {
    throw new Error('refusing to submit zero scores without --allow-zero');
  }

  const metadata = await readJson(path.join(runDir, 'metadata.json'));
  const target = await newTab(metadata.markUrl);
  try {
    await sleep(1000);
    for (const [i, draft] of candidates.entries()) {
      console.log(`Submitting [${i + 1}/${candidates.length}] ${draft.name} ${draft.draftScore}`);
      const result = await evalIn(target, browserSubmitReview, draft.reviewUrl, String(draft.draftScore), draft.draftComment);
      if (!result?.ok) {
        throw new Error(`submit failed for ${draft.name}: ${JSON.stringify(result)}`);
      }
      await sleep(Number(opts.delay || 800));
    }
  } finally {
    await closeTab(target);
  }
}

function browserDiscoverAssignments() {
  const frame = document.querySelector('iframe[src*="/work/list"]') || document.querySelector('#frame_content-zy');
  const doc = frame?.contentDocument || document;
  const links = [...doc.querySelectorAll('a.piyueBtn, a[href*="/work/mark?"]')];
  return links.map((a, index) => {
    let row = a.closest('li, .workList, .taskList, .dataBody_td') || a.parentElement;
    let current = row;
    for (let depth = 0; current && depth < 8; depth++, current = current.parentElement) {
      const currentText = (current.innerText || '').replace(/\s+/g, ' ').trim();
      if (/作答时间|已交|待批/.test(currentText) && /批阅/.test(currentText)) {
        row = current;
        break;
      }
    }
    const text = (row?.innerText || a.innerText || '').replace(/\s+/g, ' ').trim();
    const title = text.split(/信安|作答时间|批阅/)[0].trim() || `assignment-${index + 1}`;
    return {
      index,
      title,
      text,
      markUrl: a.href,
    };
  }).filter(x => x.markUrl);
}

function browserMarkMeta() {
  const classes = [...document.querySelectorAll('.classli')].map(li => ({
    name: (li.querySelector('.className')?.innerText || li.title || li.innerText || '').replace(/待批.*$/, '').trim(),
    classId: li.getAttribute('data') || '',
    workId: li.getAttribute('data1') || '',
    pendingText: li.innerText.replace(/\s+/g, ' ').trim(),
  })).filter(x => x.classId && x.workId);
  return {
    title: (document.querySelector('.mark_title')?.innerText || document.querySelector('h2')?.innerText || document.title || '').trim(),
    url: location.href,
    courseId: document.querySelector('#courseid')?.value || '',
    classId: document.querySelector('#clazzid')?.value || '',
    workId: document.querySelector('#workid')?.value || '',
    cpi: document.querySelector('#cpi')?.value || '',
    taskId: document.querySelector('#taskId')?.value || '',
    evaluation: document.querySelector('#evaluation')?.value || '0',
    from: document.querySelector('#from')?.value || '',
    topicid: document.querySelector('#topicid')?.value || '0',
    classes,
  };
}

async function browserMarkListRows(params) {
  const query = new URLSearchParams({
    courseid: params.courseId,
    clazzid: params.classId,
    workid: params.workId,
    submit: params.submit || 'true',
    status: params.status || '0',
    groupId: params.groupId || '0',
    cpi: params.cpi,
    evaluation: params.evaluation || '0',
    sort: params.sort || '0',
    order: params.order || '0',
    unEval: params.unEval || 'false',
    search: params.search || '',
    from: params.from || '',
    topicid: params.topicid || '0',
    pages: String(params.page || 1),
    size: String(params.size || 200),
  });
  const html = await fetch('/mooc2-ans/work/mark-list?' + query, { credentials: 'include' }).then(r => r.text());
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const rows = [...doc.querySelectorAll('ul.dataBody_td')].map(ul => {
    const cells = [...ul.children].map(li => li.innerText.replace(/\s+/g, ' ').trim());
    const link = ul.querySelector('a.cz_py');
    const scoreInput = ul.querySelector('.scoreInput');
    return {
      workAnswerId: ul.id,
      personId: ul.getAttribute('createid') || '',
      name: ul.querySelector('.py_name')?.innerText.trim() || '',
      studentNo: cells[2] || '',
      submitTime: cells[3] || '',
      ip: cells[4] || '',
      status: cells[5] || '',
      grader: cells[6] || '',
      existingScore: scoreInput?.value || '',
      reviewUrl: link?.getAttribute('data') || '',
      actionText: link?.innerText.replace(/\s+/g, ' ').trim() || '',
    };
  }).filter(x => x.workAnswerId && (params.includeMissing || x.reviewUrl));
  const totalText = doc.querySelector('.pageDiv, .pageInfo, .totalPage')?.innerText || '';
  const totalMatch = totalText.match(/共\s*(\d+)\s*页|\/\s*(\d+)/);
  const totalPage = Number(totalMatch?.[1] || totalMatch?.[2] || 1) || 1;
  return { rows, totalPage };
}

async function browserReviewData(reviewUrl) {
  const html = await fetch(reviewUrl, { credentials: 'include' }).then(r => r.text());
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const abs = value => value ? new URL(value, location.href).href : '';
  const form = doc.querySelector('form[action*="save-review"], form');
  const formFields = [...doc.querySelectorAll('input, textarea, select')].map(el => ({
    tag: el.tagName,
    name: el.name || '',
    id: el.id || '',
    type: el.type || '',
    value: el.value ?? '',
  }));
  const answerRoot = doc.querySelector('.stuAnswerWords, .studentAns, .answerCon, .Py_answer, .mark_item, body') || doc.body;
  const images = [...answerRoot.querySelectorAll('img')]
    .map((img, imageIndex) => ({
      questionIndex: 1,
      imageIndex: imageIndex + 1,
      src: abs(img.getAttribute('data-original') || img.getAttribute('data-src') || img.getAttribute('src') || ''),
      alt: img.getAttribute('alt') || '',
      title: img.getAttribute('title') || '',
    }))
    .filter(img => img.src && !/blank|loading|default/i.test(img.src));
  const answerText = (answerRoot.innerText || '')
    .replace(/\s+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const questions = [...doc.querySelectorAll('.mark_item, .TiMu, .questionLi, .question')]
    .map((node, index) => ({
      index: index + 1,
      text: (node.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 2000),
    }));
  return {
    url: reviewUrl,
    title: (doc.querySelector('.mark_title, h1, h2')?.innerText || doc.title || '').trim(),
    formAction: abs(form?.getAttribute('action') || '/mooc2-ans/work/library/save-review'),
    formFields,
    studentPanelText: (doc.querySelector('.stuInfo, .studentInfo, .mark_name')?.innerText || '').replace(/\s+/g, ' ').trim(),
    comment: doc.querySelector('textarea[name="comment"], textarea[name="reason"], #textCon')?.value || '',
    totalScore: doc.querySelector('#score, input[name="score"]')?.value || '',
    fullScore: doc.querySelector('#fullScore, input[name="fullScore"]')?.value || '',
    answerText,
    images,
    questions,
  };
}

async function browserSubmitReview(reviewUrl, score, comment) {
  const normalizeScore = value => {
    const number = Number(String(value ?? '').trim());
    return Number.isFinite(number) ? String(number) : String(value ?? '').trim();
  };
  const normalizeReviewText = value => {
    const div = document.createElement('div');
    div.innerHTML = String(value ?? '');
    return (div.textContent || div.innerText || String(value ?? ''))
      .replace(/\s+/g, ' ')
      .trim();
  };
  const escapeHtml = value => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

  const targetScore = String(score ?? '').trim();
  const targetComment = String(comment ?? '').trim();
  const htmlComment = /<\/?[a-z][\s\S]*>/i.test(targetComment)
    ? targetComment
    : `<p>${escapeHtml(targetComment)}</p>`;
  try {
    const html = await fetch(reviewUrl, { credentials: 'include' }).then(r => r.text());
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const form = doc.querySelector('form[action*="save-review"], form');
    if (!form) {
      return {
        ok: false,
        error: 'review form not found',
        pageTitle: doc.title || '',
        pageUrl: reviewUrl,
        bodyPreview: (doc.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 300),
      };
    }
    const action = new URL(form.getAttribute('action') || '/mooc2-ans/work/library/save-review', location.href);
    action.searchParams.set('score', targetScore);
    action.searchParams.set('markType', '1');
    const data = new URLSearchParams();
    for (const el of [...form.querySelectorAll('input, textarea, select')]) {
      if (!el.name || el.disabled) continue;
      if ((el.type === 'checkbox' || el.type === 'radio') && !el.checked) continue;
      if (el.tagName === 'SELECT' && el.multiple) {
        for (const option of [...el.options].filter(o => o.selected)) {
          data.append(el.name, option.value ?? '');
        }
        continue;
      }
      data.append(el.name, el.value ?? '');
    }

    data.set('score', targetScore);
    data.set('markType', '1');
    data.set('back', '1');

    const questionScoreNames = [...form.querySelectorAll('input[name^="score"]')]
      .map(el => el.name)
      .filter(name => /^score\d+$/.test(name));
    for (const key of questionScoreNames) {
      data.set(key, targetScore);
    }

    const questionIds = [...new Set(questionScoreNames.map(name => name.replace(/^score/, '')).filter(Boolean))];
    if (questionIds.length) data.set('answerwqbid', `${questionIds.join(',')},`);

    const commentInputs = [...form.querySelectorAll('textarea[name^="answer"], textarea[name="comment"], textarea[name="reason"]')]
      .map(el => el.name)
      .filter(Boolean);
    for (const key of commentInputs) {
      data.set(key, htmlComment);
    }
    if (!commentInputs.includes('comment')) data.set('comment', htmlComment);

    const res = await fetch(action.href, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'x-requested-with': 'XMLHttpRequest',
      },
      body: data.toString(),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // Some pages return text during transient login or throttling states.
    }
    const postOk = res.ok && (json ? json.status !== false : !/失败|错误|error/i.test(text.slice(0, 500)));

    await new Promise(resolve => setTimeout(resolve, 500));
    const verifyUrl = new URL(reviewUrl, location.href);
    verifyUrl.searchParams.set('_verify', String(Date.now()));
    const verifyHtml = await fetch(verifyUrl.href, { credentials: 'include', cache: 'no-store' }).then(r => r.text());
    const verifyDoc = new DOMParser().parseFromString(verifyHtml, 'text/html');
    const scoreValues = [
      verifyDoc.querySelector('#tmpscore')?.value,
      verifyDoc.querySelector('input[name="score"]')?.value,
      ...[...verifyDoc.querySelectorAll('input[name^="score"]')]
        .filter(el => /^score\d+$/.test(el.name || ''))
        .map(el => el.value),
    ].filter(value => value != null && value !== '');
    const savedComment = verifyDoc.querySelector('textarea[name="comment"], textarea[name="reason"], #textCon')?.value || '';
    const expectedComment = normalizeReviewText(targetComment);
    const actualComment = normalizeReviewText(savedComment);
    const commentOk = !expectedComment || actualComment.includes(expectedComment);
    const scoreOk = scoreValues.some(value => normalizeScore(value) === normalizeScore(targetScore));

    return {
      ok: Boolean(postOk && scoreOk && commentOk),
      status: res.status,
      postOk,
      response: json || text.slice(0, 300),
      scoreOk,
      commentOk,
      scoreValues,
      commentPreview: actualComment.slice(0, 160),
      action: action.pathname + action.search,
    };
  } catch (error) {
    return {
      ok: false,
      error: String(error?.message || error),
      stack: String(error?.stack || '').slice(0, 800),
      pageUrl: reviewUrl,
    };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  try {
    if (command === 'discover') await discover(args);
    else if (command === 'collect') await collect(args);
    else if (command === 'vision') await vision(args);
    else if (command === 'pair-review') await pairReview(args);
    else if (command === 'grade') await grade(args);
    else if (command === 'submit') await submit(args);
    else {
      usage();
      if (command) process.exitCode = 1;
    }
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}

main();
