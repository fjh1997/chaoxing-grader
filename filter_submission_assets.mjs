#!/usr/bin/env node
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { selectedAssignments } from './assignment_manifest.mjs';

const baseDir = path.dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));
const assignments = selectedAssignments(args._);
const dryRun = Boolean(args['dry-run']);
const commonMinFreq = Number(args['common-min-freq'] || process.env.COMMON_SUBMISSION_IMAGE_MIN_FREQ || 5);
const commonMinRatio = Number(args['common-min-ratio'] || process.env.COMMON_SUBMISSION_IMAGE_MIN_RATIO || 0.20);

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

function isStudentSubmissionImage(item) {
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

function realObjectId(item) {
  const objectId = String(item?.objectId || '');
  if (objectId && !/^image_\d+$/.test(objectId)) return objectId;
  const src = String(item?.src || '');
  let url;
  try {
    url = new URL(src);
  } catch {
    return '';
  }
  const match = url.pathname.match(/\/star3\/(?:origin|750_1024)\/([0-9a-fA-F]{16,})(?:\.[a-z0-9]+)?$/i)
    || url.pathname.match(/\/([0-9a-fA-F]{16,})(?:\.[a-z0-9]+)?$/i);
  return match?.[1] || '';
}

function rawAssetsFor(row) {
  return Array.isArray(row.rawAssets) ? row.rawAssets : (Array.isArray(row.assets) ? row.assets : []);
}

function rawImagesFor(row) {
  return Array.isArray(row.review?.rawImages)
    ? row.review.rawImages
    : (Array.isArray(row.review?.images) ? row.review.images : []);
}

function isCommonStudentImage(item, commonAssets) {
  if (!commonAssets) return false;
  const objectId = realObjectId(item);
  const sha = String(item?.sha256 || '');
  return Boolean(
    (objectId && commonAssets.objects.has(objectId))
    || (sha && commonAssets.hashes.has(sha))
  );
}

function buildCommonAssets(rows) {
  const objectCounts = new Map();
  const hashCounts = new Map();
  for (const row of rows) {
    const objects = new Set();
    const hashes = new Set();
    for (const asset of rawAssetsFor(row)) {
      if (!isStudentSubmissionImage(asset)) continue;
      const objectId = realObjectId(asset);
      const sha = String(asset?.sha256 || '');
      if (objectId) objects.add(objectId);
      if (sha) hashes.add(sha);
    }
    for (const objectId of objects) objectCounts.set(objectId, (objectCounts.get(objectId) || 0) + 1);
    for (const sha of hashes) hashCounts.set(sha, (hashCounts.get(sha) || 0) + 1);
  }
  const n = Math.max(1, rows.length);
  const objects = new Set([...objectCounts.entries()]
    .filter(([, count]) => count >= commonMinFreq && count / n >= commonMinRatio)
    .map(([value]) => value));
  const hashes = new Set([...hashCounts.entries()]
    .filter(([, count]) => count >= commonMinFreq && count / n >= commonMinRatio)
    .map(([value]) => value));
  return { objects, hashes };
}

function cleanSubmission(row, commonAssets) {
  const rawAssets = rawAssetsFor(row);
  const rawImages = rawImagesFor(row);
  const sourceAssets = rawAssets.filter(isStudentSubmissionImage);
  const assets = sourceAssets.filter(asset => !isCommonStudentImage(asset, commonAssets));
  const allowedSrc = new Set(assets.map(asset => String(asset.src || '')));
  const images = rawImages.filter(img => {
    const src = String(img.src || '');
    return allowedSrc.has(src) || (isStudentSubmissionImage(img) && !isCommonStudentImage(img, commonAssets));
  });
  return {
    changed: assets.length !== (row.assets || []).length || images.length !== (row.review?.images || []).length || !row.rawAssets || !row.review?.rawImages,
    next: {
      ...row,
      rawAssets,
      assets,
      review: {
        ...(row.review || {}),
        rawImages,
        images,
      },
      assetFilter: {
        version: 2,
        keptAssets: assets.length,
        removedAssets: rawAssets.length - assets.length,
        removedCommonAssets: sourceAssets.length - assets.length,
        keptImages: images.length,
        removedImages: rawImages.length - images.length,
        commonMinFreq,
        commonMinRatio,
        rule: 'keep student-uploaded p.ananas/p.cldisk star3 origin or 750_1024 images; drop Chaoxing UI images, avatars, and per-assignment common instruction images',
      },
    },
  };
}

const summary = [];
for (const item of assignments) {
  const runDir = path.isAbsolute(item.runDir)
    ? item.runDir
    : path.resolve(baseDir, item.runDir.replace(/^chaoxing-grader[\\/]/, ''));
  const subDir = path.join(runDir, 'submissions');
  let files;
  try {
    files = (await readdir(subDir)).filter(name => name.endsWith('.json')).sort();
  } catch {
    summary.push({ title: item.title, runDir, ok: false, error: 'missing submissions dir' });
    continue;
  }

  const rows = [];
  for (const file of files) {
    const filePath = path.join(subDir, file);
    try {
      rows.push({ file, row: await readJson(filePath) });
    } catch {
      rows.push({ file, row: null, error: 'invalid json' });
    }
  }

  const validRows = rows.filter(item => item.row).map(item => item.row);
  const commonAssets = buildCommonAssets(validRows);
  let submissions = 0;
  let bad = 0;
  let changed = 0;
  let keptAssets = 0;
  let removedAssets = 0;
  let removedCommonAssets = 0;
  let keptImages = 0;
  let removedImages = 0;
  for (const { file, row } of rows) {
    if (!row) {
      bad++;
      continue;
    }
    const filePath = path.join(subDir, file);
    const beforeAssets = rawAssetsFor(row).length;
    const beforeImages = rawImagesFor(row).length;
    const { changed: rowChanged, next } = cleanSubmission(row, commonAssets);
    submissions++;
    if (rowChanged) changed++;
    keptAssets += next.assets.length;
    removedAssets += beforeAssets - next.assets.length;
    removedCommonAssets += next.assetFilter.removedCommonAssets;
    keptImages += next.review.images.length;
    removedImages += beforeImages - next.review.images.length;
    if (!dryRun && rowChanged) await writeFile(filePath, JSON.stringify(next, null, 2), 'utf8');
  }

  summary.push({
    title: item.title,
    runDir,
    ok: true,
    submissions,
    bad,
    changed,
    keptAssets,
    removedAssets,
    removedCommonAssets,
    keptImages,
    removedImages,
    commonObjects: commonAssets.objects.size,
    commonHashes: commonAssets.hashes.size,
  });
}

const outFile = path.join(baseDir, 'asset_filter_status.json');
if (!dryRun) {
  await writeFile(outFile, JSON.stringify({
    generatedAt: new Date().toISOString(),
    summary,
  }, null, 2), 'utf8');
}

for (const row of summary) {
  if (!row.ok) {
    console.log(`fail\t${row.title}\t${row.error}`);
  } else {
    console.log(`${dryRun ? 'dry' : 'ok'}\t${row.title}\tchanged=${row.changed}/${row.submissions}\tbad=${row.bad || 0}\tassets kept=${row.keptAssets} removed=${row.removedAssets} common=${row.removedCommonAssets}\timages kept=${row.keptImages} removed=${row.removedImages}\tcommon objects=${row.commonObjects} hashes=${row.commonHashes}`);
  }
}
if (summary.some(row => !row.ok || row.bad)) process.exitCode = 1;
