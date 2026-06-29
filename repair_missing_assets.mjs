#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { selectedAssignments } from './assignment_manifest.mjs';

const baseDir = path.dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));
const assignments = selectedAssignments(args._);
const dryRun = Boolean(args['dry-run']);
const workers = Number(args.workers || process.env.CHAOXING_REPAIR_WORKERS || 8);
const retries = Number(args.retries || process.env.CHAOXING_REPAIR_RETRIES || 3);
const timeoutMs = Number(args.timeout || process.env.CHAOXING_REPAIR_TIMEOUT_MS || 20000);
const useCurl = args['no-curl'] ? false : process.env.CHAOXING_REPAIR_CURL !== '0';
const curlProxy = String(args.proxy || process.env.CHAOXING_REPAIR_PROXY || '');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
const execFileAsync = promisify(execFile);

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

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
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

function isRepairableSubmissionImage(item) {
  const src = String(item?.src || '');
  let url;
  try {
    url = new URL(src);
  } catch {
    return false;
  }
  if (url.hostname === 'p.ananas.chaoxing.com') {
    return /^\/star3\/(?:origin|750_1024)\//.test(url.pathname);
  }
  if (url.hostname === 'p.cldisk.com') {
    return /^\/star[34]\//.test(url.pathname);
  }
  return false;
}

function objectIdFromUrl(src) {
  const text = String(src || '');
  const match = text.match(/\/star3\/(?:origin|750_1024)\/([0-9a-fA-F]{16,})(?:\.[a-z0-9]+)?(?:[?#].*)?$/i)
    || text.match(/\/origin\/([0-9a-fA-F]{16,})(?:\.[a-z0-9]+)?(?:[?#].*)?$/i);
  return match?.[1] || '';
}

function imageFileIdFromUrl(src) {
  const text = String(src || '');
  const match = text.match(/\/([0-9a-fA-F]{16,})(?:\.[a-z0-9]+)?(?:[?#].*)?$/i)
    || text.match(/\/star[34]\/([^/?#]+)\/origin(?:\.[a-z0-9]+)?(?:[?#].*)?$/i);
  return match?.[1] || '';
}

function outputFolder(runDir, row) {
  return path.join(
    runDir,
    'downloads',
    `${slug(row.className)}_${slug(row.studentNo)}_${slug(row.name)}_${row.workAnswerId}`,
  );
}

function outputFile(runDir, row, image, index) {
  const objectId = objectIdFromUrl(image.src);
  const fileId = objectId || imageFileIdFromUrl(image.src) || `image_${index + 1}`;
  return path.join(outputFolder(runDir, row), `q${image.questionIndex || 1}_${index + 1}_${slug(fileId)}.bin`);
}

async function downloadFile(url, file, referer) {
  await mkdir(path.dirname(file), { recursive: true });
  let lastError = '';
  for (let attempt = 1; attempt <= retries; attempt++) {
    if (useCurl) {
      const result = await downloadFileWithCurl(url, file, referer);
      if (result.ok) return result;
      lastError = result.error;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: {
          'user-agent': UA,
          'referer': referer || 'https://mooc2-ans.chaoxing.com',
          'accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        },
        redirect: 'follow',
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        lastError = `HTTP ${res.status}`;
      } else {
        await pipeline(res.body, createWriteStream(file));
        const st = await stat(file);
        return {
          ok: true,
          file,
          bytes: st.size,
          contentType: res.headers.get('content-type') || '',
        };
      }
    } catch (error) {
      lastError = String(error?.message || error);
    } finally {
      clearTimeout(timer);
    }
    await new Promise(resolve => setTimeout(resolve, attempt * 500));
  }
  return { ok: false, error: lastError || 'download failed' };
}

async function downloadFileWithCurl(url, file, referer) {
  const seconds = Math.max(3, Math.ceil(timeoutMs / 1000));
  const curlArgs = [
    '-L',
    '--fail',
    '--silent',
    '--show-error',
    '--max-time', String(seconds),
    '--connect-timeout', String(Math.min(10, seconds)),
    '-A', UA,
    '-e', referer || 'https://mooc2-ans.chaoxing.com',
    '-H', 'accept: image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
    '-o', file,
  ];
  if (curlProxy) curlArgs.unshift('--proxy', curlProxy);
  curlArgs.push(url);
  try {
    await execFileAsync('curl', curlArgs, {
      timeout: timeoutMs + 5000,
      maxBuffer: 1024 * 1024,
    });
    const st = await stat(file);
    const contentType = mimeType(file);
    if (!contentType.startsWith('image/')) {
      return { ok: false, error: `curl downloaded non-image: ${contentType || 'unknown'}` };
    }
    return { ok: true, file, bytes: st.size, contentType };
  } catch (error) {
    return { ok: false, error: String(error?.stderr || error?.message || error).trim() };
  }
}

function mimeType(file) {
  try {
    return execFileSync('file', ['-b', '--mime-type', file], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

async function normalizeExtension(file, contentType) {
  let ext = '';
  if (/png/i.test(contentType)) ext = '.png';
  else if (/jpe?g/i.test(contentType)) ext = '.jpg';
  else if (/gif/i.test(contentType)) ext = '.gif';
  else if (/webp/i.test(contentType)) ext = '.webp';
  if (!ext) {
    const info = mimeType(file);
    if (info.includes('png')) ext = '.png';
    else if (info.includes('jpeg')) ext = '.jpg';
    else if (info.includes('gif')) ext = '.gif';
    else if (info.includes('webp')) ext = '.webp';
  }
  if (!ext || file.endsWith(ext)) return file;
  const next = file.replace(/\.bin$/, ext);
  if (next !== file) {
    try {
      await rename(file, next);
      return next;
    } catch {}
  }
  return file;
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

async function mapLimit(items, limit, fn) {
  const rows = Array.from(items);
  const results = new Array(rows.length);
  let next = 0;
  const workerCount = Math.max(1, Number(limit) || 1);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (next < rows.length) {
      const index = next++;
      results[index] = await fn(rows[index], index);
    }
  }));
  return results;
}

function shouldRepair(runDir, row, image) {
  if (!isRepairableSubmissionImage(image)) return false;
  if (!image.ok || !image.file) return true;
  return !exists(path.join(runDir, image.file));
}

async function repairImage(runDir, row, image, index) {
  if (!await shouldRepair(runDir, row, image)) return { changed: false, image };
  const initialFile = outputFile(runDir, row, image, index);
  if (dryRun) return { changed: false, planned: true, image };
  const result = await downloadFile(image.src, initialFile, row.reviewUrl);
  if (!result.ok) {
    return {
      changed: true,
      image: {
        ...image,
        objectId: image.objectId || objectIdFromUrl(image.src),
        ok: false,
        error: result.error,
      },
    };
  }
  const finalFile = await normalizeExtension(result.file, result.contentType);
  const hash = await sha256File(finalFile);
  const ahash = await imageAhash(finalFile);
  return {
    changed: true,
    image: {
      ...image,
      objectId: image.objectId || objectIdFromUrl(image.src),
      ok: true,
      file: path.relative(runDir, finalFile),
      contentType: result.contentType,
      bytes: result.bytes,
      sha256: hash,
      ahash,
      error: '',
    },
  };
}

async function repairSubmission(runDir, filePath) {
  const row = await readJson(filePath);
  const rawAssets = Array.isArray(row.rawAssets) ? row.rawAssets : (Array.isArray(row.assets) ? row.assets : []);
  let planned = 0;
  let repaired = 0;
  let failed = 0;
  const nextAssets = await mapLimit(rawAssets, workers, async (image, index) => {
    if (!isRepairableSubmissionImage(image)) return image;
    const missing = !image.ok || !image.file || !await exists(path.join(runDir, image.file || ''));
    if (!missing) return image;
    planned++;
    const result = await repairImage(runDir, row, image, index);
    if (result.planned) return image;
    if (result.changed && result.image.ok) repaired++;
    if (result.changed && !result.image.ok) failed++;
    return result.image;
  });
  const changed = JSON.stringify(nextAssets) !== JSON.stringify(rawAssets);
  if (!dryRun && changed) {
    const assetBySrc = new Map(nextAssets.map(asset => [String(asset.src || ''), asset]));
    const currentAssets = Array.isArray(row.assets) ? row.assets : [];
    const mergedAssets = currentAssets.map(asset => assetBySrc.get(String(asset.src || '')) || asset);
    for (const asset of nextAssets) {
      if (isRepairableSubmissionImage(asset) && asset.ok && !mergedAssets.some(item => String(item.src || '') === String(asset.src || ''))) {
        mergedAssets.push(asset);
      }
    }
    const rawImages = Array.isArray(row.review?.rawImages)
      ? row.review.rawImages
      : (Array.isArray(row.review?.images) ? row.review.images : []);
    const nextRawImages = rawImages.map(img => assetBySrc.get(String(img.src || '')) || img);
    await writeFile(filePath, JSON.stringify({
      ...row,
      rawAssets: nextAssets,
      assets: mergedAssets,
      review: {
        ...(row.review || {}),
        rawImages: nextRawImages,
      },
    }, null, 2), 'utf8');
  }
  return { planned, repaired, failed, changed };
}

const summary = [];
for (const item of assignments) {
  const runDir = path.isAbsolute(item.runDir)
    ? item.runDir
    : path.resolve(baseDir, item.runDir.replace(/^chaoxing-grader[\\/]/, ''));
  const subDir = path.join(runDir, 'submissions');
  let files = [];
  try {
    files = (await readdir(subDir)).filter(name => name.endsWith('.json')).sort();
  } catch {
    summary.push({ title: item.title, ok: false, error: 'missing submissions dir' });
    continue;
  }
  let planned = 0;
  let repaired = 0;
  let failed = 0;
  let changed = 0;
  for (const file of files) {
    const result = await repairSubmission(runDir, path.join(subDir, file));
    planned += result.planned;
    repaired += result.repaired;
    failed += result.failed;
    if (result.changed) changed++;
  }
  summary.push({ title: item.title, ok: true, submissions: files.length, planned, repaired, failed, changed });
}

if (!dryRun) {
  await writeFile(path.join(baseDir, 'asset_repair_status.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    summary,
  }, null, 2), 'utf8');
}

for (const row of summary) {
  if (!row.ok) console.log(`fail\t${row.title}\t${row.error}`);
  else console.log(`${dryRun ? 'dry' : 'ok'}\t${row.title}\tsubmissions=${row.submissions}\tplanned=${row.planned}\trepaired=${row.repaired}\tfailed=${row.failed}\tchanged=${row.changed}`);
}
if (summary.some(row => !row.ok || row.failed)) process.exitCode = 1;
