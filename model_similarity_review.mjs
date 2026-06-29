#!/usr/bin/env node
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const runDir = path.resolve(process.argv[2] || '');
const args = parseArgs(process.argv.slice(3));
const endpoint = args.endpoint || process.env.MIMO_ENDPOINT || 'https://api.openai.com/v1';
const model = args.model || process.env.MIMO_MODEL || 'mimo-v2.5';
const apiKey = process.env.MIMO_API_KEY;
const reviewDir = path.join(runDir, 'model_pair_review');
const reviewJson = path.join(runDir, 'model_similarity_review.json');
const reviewCsv = path.join(runDir, 'model_similarity_review.csv');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
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

function csvEscape(value) {
  const text = value == null ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(rows, columns) {
  return [
    columns.map(csvEscape).join(','),
    ...rows.map(row => columns.map(col => csvEscape(row[col])).join(',')),
  ].join('\n') + '\n';
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (fallback !== undefined) return fallback;
    throw error;
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

async function loadSubmissions(dir) {
  const submissionsDir = path.join(dir, 'submissions');
  const files = (await readdir(submissionsDir)).filter(file => file.endsWith('.json')).sort();
  const rows = [];
  for (const file of files) rows.push(await readJson(path.join(submissionsDir, file)));
  return rows;
}

function pairKey(row) {
  return [String(row.aWorkAnswerId), String(row.bWorkAnswerId)].sort().join('__');
}

function slug(value) {
  return String(value || '')
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 120) || 'pair';
}

function mimeFromFile(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'image/png';
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

function clampScore(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function normalizeModelVerdict(value) {
  const text = String(value || '').toLowerCase();
  if (['confirmed', 'plagiarism', 'copy', 'same'].includes(text)) return 'confirmed';
  if (['ignore', 'not_plagiarism', 'not-plagiarism', 'different', 'no'].includes(text)) return 'ignore';
  return 'suspected';
}

function normalizeReview(value, pair) {
  const result = value && typeof value === 'object' ? value : {};
  const status = Number(result.status || 0);
  const apiOk = result.apiOk !== false;
  const modelVerdict = normalizeModelVerdict(result.verdict);
  const confidence = clampScore(result.confidence ?? 0);
  const sameImage = Boolean(result.sameImage ?? result.sameScreenshot);
  const sameCoreEvidence = Boolean(result.sameCoreEvidence);
  const templateSimilarityOnly = Boolean(result.templateSimilarityOnly);
  const confirmThreshold = Number(args.confirmThreshold || 72);
  const ignoreThreshold = Number(args.ignoreThreshold || 65);
  let appliedVerdict = 'suspected';
  if (modelVerdict === 'confirmed' && confidence >= confirmThreshold) appliedVerdict = 'confirmed';
  else if (modelVerdict === 'ignore' && confidence >= ignoreThreshold) appliedVerdict = 'ignore';
  else if (sameImage && confidence >= 65) appliedVerdict = 'confirmed';
  else if (templateSimilarityOnly && confidence >= 60) appliedVerdict = 'ignore';
  if (!apiOk || confidence <= 0) appliedVerdict = String(pair.verdict || 'suspected');
  return {
    key: pairKey(pair),
    model,
    aClass: pair.aClass,
    aName: pair.aName,
    aStudentNo: pair.aStudentNo,
    aWorkAnswerId: pair.aWorkAnswerId,
    bClass: pair.bClass,
    bName: pair.bName,
    bStudentNo: pair.bStudentNo,
    bWorkAnswerId: pair.bWorkAnswerId,
    originalVerdict: pair.verdict,
    appliedVerdict,
    apiOk,
    modelVerdict,
    confidence,
    sameImage,
    sameCoreEvidence,
    templateSimilarityOnly,
    sharedEvidence: Array.isArray(result.sharedEvidence) ? result.sharedEvidence.map(String).slice(0, 12).join('; ') : String(result.sharedEvidence || ''),
    differences: Array.isArray(result.differences) ? result.differences.map(String).slice(0, 12).join('; ') : String(result.differences || ''),
    comment: String(result.comment || '').slice(0, 1200),
    rawText: String(result.rawText || '').slice(0, 2000),
    status,
    retryAfter: String(result.retryAfter || ''),
    siftInliers: pair.siftInliers,
    siftRatio: pair.siftRatio,
    siftCoverage: pair.siftCoverage,
    akazeInliers: pair.akazeInliers,
    akazeRatio: pair.akazeRatio,
    akazeCoverage: pair.akazeCoverage,
    imageHashSimilarity: pair.imageHashSimilarity,
  };
}

function hasHardEvidence(pair) {
  return Boolean(pair.exactObject || pair.exactFile || String(pair.exactShared || '').trim());
}

function isVisualOnlyPair(pair) {
  return !hasHardEvidence(pair) && Number(pair.evidenceSimilarity || 0) <= Number(args.maxEvidence || 0.05);
}

function allowedVerdicts() {
  return new Set(String(args.verdicts || 'confirmed,suspected').split(',').map(item => item.trim()).filter(Boolean));
}

function selectedPairs(pairs) {
  const verdicts = allowedVerdicts();
  const minSift = Number(args.minSift || 300);
  const minAkaze = Number(args.minAkaze || 120);
  const minHash = Number(args.minHash || 0.92);
  let rows = pairs.filter(pair =>
    verdicts.has(pair.verdict)
    && isVisualOnlyPair(pair)
    && (
      Number(pair.siftInliers || 0) >= minSift
      || Number(pair.akazeInliers || 0) >= minAkaze
      || Number(pair.imageHashSimilarity || 0) >= minHash
    )
  );
  if (args.names) {
    const names = new Set(String(args.names).split(',').map(item => item.trim()).filter(Boolean));
    rows = rows.filter(pair => {
      const pairValues = new Set([pair.aName, pair.bName, String(pair.aStudentNo), String(pair.bStudentNo)]);
      if (args['require-all-names']) return [...names].every(name => pairValues.has(name));
      return [...names].some(name => pairValues.has(name));
    });
  }
  rows.sort((a, b) =>
    Number(b.imageHashSimilarity || 0) - Number(a.imageHashSimilarity || 0)
    || Number(b.siftInliers || 0) + Number(b.akazeInliers || 0) - Number(a.siftInliers || 0) - Number(a.akazeInliers || 0)
  );
  const limit = Number(args.limit || 0);
  return limit > 0 ? rows.slice(0, limit) : rows;
}

function assignmentTitle() {
  const base = path.basename(runDir).replace(/^run-/, '');
  return base || '当前作业';
}

function filePairs(pair) {
  const rows = [];
  const add = (label, aFile, bFile) => {
    if (!aFile || !bFile) return;
    const key = `${aFile}__${bFile}`;
    if (rows.some(row => row.key === key)) return;
    rows.push({ label, aFile, bFile, key });
  };
  add('SIFT 命中图', pair.siftAFile, pair.siftBFile);
  add('AKAZE 命中图', pair.akazeAFile, pair.akazeBFile);
  return rows.slice(0, Number(args.maxMatchedPairs || 2));
}

async function imagePart(label, file) {
  const abs = path.resolve(runDir, file);
  const data = await readFile(abs);
  return [
    { type: 'text', text: `${label}: ${file}` },
    { type: 'image_url', image_url: { url: `data:${mimeFromFile(abs)};base64,${data.toString('base64')}` } },
  ];
}

async function buildContent(pair, submissionsById) {
  const a = submissionsById.get(String(pair.aWorkAnswerId));
  const b = submissionsById.get(String(pair.bWorkAnswerId));
  const prompt = [
    '你是信息安全课程作业相似度复核模型。请只根据给出的两名学生命中截图和可见内容，判断这对候选是否构成抄袭/雷同。',
    '这是机器复核步骤，不要迎合候选算法原判；如果只是同一实验任务导致界面、后台、请求日志、终端格式相似，应判为 ignore 或 suspected，不要判 confirmed。',
    '判 confirmed 的标准：同一张照片/同一张截图经过缩放、裁剪、压缩、改文件名；或者背景、拍摄角度、窗口内容、随机值/私有 token/文件名/时间/错误信息等关键证据高度一致，差异只来自分辨率或裁剪。',
    '判 ignore 的标准：只是相同实验模板、相同靶场后台页面、相同工具界面、相同请求日志格式；并且可见 IP、URL、数字、token、账号、时间、路径、响应内容等关键细节不同。',
    '判 suspected 的标准：图像确实接近，但看不清关键差异，或只部分区域相同，无法可靠确认。',
    '特别规则：XSS Cookie 窃取实验中，cookie.php 请求日志、HTTP 头和终端格式天然相似；但如果两张照片/截图背景整体一模一样，应判 confirmed。',
    '特别规则：SSRF 代码审计实验中，进入后台页面本来就会相似；如果后台数字、URL、账号或页面数据不同，不能仅凭后台界面相似判 confirmed。',
    '特别规则：内存马与代码注入审计实验中，WebShell/内存马管理界面、表格、按钮和终端输出格式天然相似；如果内存马 URL、路径、参数、目标地址或响应内容不同，不能仅凭界面相似判 confirmed。',
    '只返回严格 JSON，不要 Markdown。字段：verdict(confirmed|suspected|ignore), confidence(0-100), sameImage(boolean), sameCoreEvidence(boolean), templateSimilarityOnly(boolean), sharedEvidence(array), differences(array), comment。',
    `作业：${assignmentTitle()}`,
    `A：${pair.aClass} ${pair.aName} ${pair.aStudentNo}，提交时间 ${pair.aSubmitTime || ''}`,
    `B：${pair.bClass} ${pair.bName} ${pair.bStudentNo}，提交时间 ${pair.bSubmitTime || ''}`,
    `候选算法指标：哈希 ${pair.imageHashSimilarity}，SIFT ${pair.siftInliers}/${pair.siftRatio}/覆盖${pair.siftCoverage}，AKAZE ${pair.akazeInliers}/${pair.akazeRatio}/覆盖${pair.akazeCoverage}，核心证据相似 ${pair.evidenceSimilarity || 0}`,
    `A OCR/摘要：${[a?.vision?.summary, a?.vision?.extractedText].filter(Boolean).join('\n').slice(0, 2000)}`,
    `B OCR/摘要：${[b?.vision?.summary, b?.vision?.extractedText].filter(Boolean).join('\n').slice(0, 2000)}`,
  ].join('\n');
  const content = [{ type: 'text', text: prompt }];
  for (const item of filePairs(pair)) {
    content.push({ type: 'text', text: `${item.label}：下面先给 A 图，再给 B 图。` });
    content.push(...await imagePart(`A ${pair.aName}`, item.aFile));
    content.push(...await imagePart(`B ${pair.bName}`, item.bFile));
  }
  return content;
}

async function callMimo(pair, submissionsById) {
  const body = {
    model,
    messages: [{ role: 'user', content: await buildContent(pair, submissionsById) }],
    temperature: 0.05,
  };
  const maxRetries = Number(args.retries || process.env.MIMO_RETRIES || 8);
  const retryBaseMs = Number(args.retryBaseMs || process.env.MIMO_RETRY_BASE_MS || 3000);
  let lastFailure = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const result = await callMimoOnce(body, pair);
    if (result.apiOk !== false || !isRetryableFailure(result)) return result;
    lastFailure = result;
    if (attempt >= maxRetries) break;
    const waitMs = retryDelayMs(result, attempt, retryBaseMs);
    console.log(`  retry ${attempt + 1}/${maxRetries} after ${waitMs}ms: ${pair.aName} vs ${pair.bName} (${result.comment})`);
    await sleep(waitMs);
  }
  return lastFailure || normalizeReview({
    apiOk: false,
    verdict: 'suspected',
    confidence: 0,
    comment: 'Mimo 调用失败：未知错误',
  }, pair);
}

async function callMimoOnce(body, pair) {
  let res;
  try {
    res = await fetch(`${endpoint.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Number(args.timeout || process.env.MIMO_TIMEOUT_MS || 120000)),
    });
  } catch (error) {
    return normalizeReview({
      apiOk: false,
      verdict: 'suspected',
      confidence: 0,
      comment: `Mimo 调用失败：${String(error?.message || error).slice(0, 300)}`,
    }, pair);
  }
  const text = await res.text();
  if (!res.ok) {
    return normalizeReview({
      apiOk: false,
      verdict: 'suspected',
      confidence: 0,
      status: res.status,
      retryAfter: res.headers.get('retry-after') || '',
      comment: `Mimo 调用失败：HTTP ${res.status}`,
      rawText: text,
    }, pair);
  }
  let message = text;
  try {
    message = JSON.parse(text)?.choices?.[0]?.message?.content || text;
  } catch {}
  const parsed = parseJsonObject(message);
  parsed.rawText = message;
  return normalizeReview(parsed, pair);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
}

function isRetryableFailure(result) {
  const status = Number(result.status || String(result.comment || '').match(/HTTP\s+(\d+)/i)?.[1] || 0);
  return status === 429 || status === 408 || status >= 500 || /timeout|fetch failed|ECONNRESET|ETIMEDOUT/i.test(String(result.comment || ''));
}

function retryDelayMs(result, attempt, baseMs) {
  const retryAfter = Number(result.retryAfter || 0);
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(120000, retryAfter * 1000);
  const jitter = Math.floor(Math.random() * 750);
  return Math.min(120000, baseMs * (2 ** Math.min(attempt, 5)) + jitter);
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, limit) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function shouldCacheReview(row) {
  return row && row.apiOk !== false && Number(row.confidence || 0) > 0;
}

function applyReviewsToPairs(pairs, reviews) {
  const byKey = new Map(reviews.map(row => [row.key, row]));
  let changed = 0;
  const updated = pairs.map(pair => {
    const review = byKey.get(pairKey(pair));
    if (!review) return pair;
    if (review.apiOk === false || Number(review.confidence || 0) <= 0) return pair;
    const next = {
      ...pair,
      modelReview: {
        model: review.model,
        verdict: review.modelVerdict,
        appliedVerdict: review.appliedVerdict,
        confidence: review.confidence,
        sameImage: review.sameImage,
        sameCoreEvidence: review.sameCoreEvidence,
        templateSimilarityOnly: review.templateSimilarityOnly,
        sharedEvidence: review.sharedEvidence,
        differences: review.differences,
        comment: review.comment,
      },
      verdict: review.appliedVerdict,
      verdictSource: 'mimo-vision',
      decisionReason: `Mimo 成对识图复核：${review.comment || review.modelVerdict}`,
    };
    changed += Number(pair.verdict !== next.verdict || pair.verdictSource !== next.verdictSource);
    return next;
  });
  return { updated, changed };
}

async function main() {
  if (!runDir) throw new Error('usage: node model_similarity_review.mjs <run-dir> [--verdicts confirmed,suspected] [--apply]');
  if (!apiKey && !args['apply-only']) throw new Error('MIMO_API_KEY is not set.');
  const pairs = await readJson(path.join(runDir, 'advanced_similarity.json'));
  const existing = await readJson(reviewJson, []);
  const existingByKey = new Map((Array.isArray(existing) ? existing : []).map(row => [row.key, row]));
  let reviews = Array.isArray(existing) ? existing.slice() : [];

  if (!args['apply-only']) {
    const submissions = await loadSubmissions(runDir);
    const submissionsById = new Map(submissions.map(row => [String(row.workAnswerId), row]));
    await mkdir(reviewDir, { recursive: true });
    const targets = selectedPairs(pairs);
    console.log(`model review candidates: ${targets.length}`);
    const breaker = {
      consecutive429: 0,
      open: false,
      threshold: Number(args.breaker429 || process.env.MIMO_BREAKER_429 || 8),
    };
    const fresh = await mapLimit(targets, Number(args.concurrency || 2), async (pair, index) => {
      if (breaker.open) {
        console.log(`[${index + 1}/${targets.length}] skipped breaker-open ${pair.aName} vs ${pair.bName}`);
        return null;
      }
      const key = pairKey(pair);
      const cacheFile = path.join(reviewDir, `${slug(pair.aName)}_${slug(pair.aStudentNo)}__${slug(pair.bName)}_${slug(pair.bStudentNo)}_${key}.json`);
      if (!args.force && existingByKey.has(key)) {
        const cached = existingByKey.get(key);
        if (shouldCacheReview(cached)) {
          console.log(`[${index + 1}/${targets.length}] cached ${pair.aName} vs ${pair.bName}`);
          return cached;
        }
      }
      if (!args.force && await exists(cacheFile)) {
        const cached = await readJson(cacheFile);
        if (shouldCacheReview(cached)) {
          console.log(`[${index + 1}/${targets.length}] cached-file ${pair.aName} vs ${pair.bName}`);
          return cached;
        }
      }
      console.log(`[${index + 1}/${targets.length}] Mimo ${pair.aName} vs ${pair.bName}`);
      const result = await callMimo(pair, submissionsById);
      if (Number(result.status || 0) === 429) {
        breaker.consecutive429 += 1;
        if (breaker.consecutive429 >= breaker.threshold) {
          breaker.open = true;
          console.log(`  breaker open: consecutive HTTP 429 >= ${breaker.threshold}`);
        }
      } else if (result.apiOk !== false) {
        breaker.consecutive429 = 0;
      }
      if (shouldCacheReview(result)) await writeFile(cacheFile, JSON.stringify(result, null, 2), 'utf8');
      return result;
    });
    const validFresh = fresh.filter(shouldCacheReview);
    const freshByKey = new Map(validFresh.map(row => [row.key, row]));
    reviews = [
      ...reviews.filter(row => !freshByKey.has(row.key)),
      ...validFresh,
    ].sort((a, b) => String(a.aName).localeCompare(String(b.aName), 'zh-Hans-CN') || String(a.bName).localeCompare(String(b.bName), 'zh-Hans-CN'));
    await writeFile(reviewJson, JSON.stringify(reviews, null, 2), 'utf8');
    await writeFile(reviewCsv, toCsv(reviews, [
      'aClass', 'aName', 'aStudentNo', 'aWorkAnswerId',
      'bClass', 'bName', 'bStudentNo', 'bWorkAnswerId',
      'originalVerdict', 'appliedVerdict', 'modelVerdict', 'confidence',
      'sameImage', 'sameCoreEvidence', 'templateSimilarityOnly',
      'sharedEvidence', 'differences', 'comment',
      'siftInliers', 'siftRatio', 'siftCoverage', 'akazeInliers', 'akazeRatio', 'akazeCoverage', 'imageHashSimilarity',
    ]), 'utf8');
    console.log(`Wrote: ${reviewCsv}`);
  }

  if (args.apply || args['apply-only']) {
    const { updated, changed } = applyReviewsToPairs(pairs, reviews);
    await writeFile(path.join(runDir, 'advanced_similarity.json'), JSON.stringify(updated, null, 2), 'utf8');
    await writeFile(path.join(runDir, 'advanced_similarity.csv'), toCsv(updated, Object.keys(updated[0] || {})), 'utf8');
    console.log(`Applied model reviews: ${reviews.length}, changed pairs: ${changed}`);
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
