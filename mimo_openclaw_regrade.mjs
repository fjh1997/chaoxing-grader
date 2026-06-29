#!/usr/bin/env node
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const runDir = path.resolve(process.argv[2] || '');
const args = parseArgs(process.argv.slice(3));
const endpoint = args.endpoint || process.env.MIMO_ENDPOINT || 'https://api.openai.com/v1';
const model = args.model || process.env.MIMO_MODEL || 'mimo-v2.5';
const apiKey = process.env.MIMO_API_KEY;
const execFileAsync = promisify(execFile);
const assignmentGuide = [
  '超星题干：使用 openclaw 进行自动化代码审计，出具审计报告截图上传。',
  '教程要点：前半部分是 ModelScope/OpenClaw 云电脑部署、SSH/内网穿透等准备步骤；这些只能证明环境准备。',
  '教程核心交付在第 10 步：上传需要审计的代码包（例如 unserialize.zip），拖到 OpenClaw 左下角上传框，然后与 OpenClaw 对话让它自动帮你审计。',
  '因此，评分时必须把“部署/打开 OpenClaw/终端配置/内网穿透成功”和“OpenClaw 已对代码包产生审计报告/漏洞分析结果”区分开。',
  '合格的作业截图应能看到学生上传代码包后，OpenClaw 输出代码审计报告、漏洞列表、漏洞类型、风险等级、攻击入口、代码路径、修复建议或明确审计结论。',
].join('\n');

if (!runDir) throw new Error('usage: node mimo_openclaw_regrade.mjs <run-dir> [--force] [--names 姓名,学号]');
if (!apiKey) throw new Error('MIMO_API_KEY is not set.');

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

function slug(value) {
  return String(value || '')
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 120) || 'item';
}

function mimeFromFile(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'image/png';
}

async function prepareImageForModel(file) {
  const maxBytes = Number(args.maxBytes || process.env.MIMO_IMAGE_MAX_BYTES || 900000);
  const maxSide = Number(args.maxSide || process.env.MIMO_IMAGE_MAX_SIDE || 1800);
  const quality = Number(args.jpegQuality || process.env.MIMO_JPEG_QUALITY || 82);
  const abs = path.resolve(runDir, file);
  const info = await stat(abs);
  if (args.noCompress || info.size <= maxBytes) {
    return { file: abs, mime: mimeFromFile(abs), temporary: false };
  }
  const cacheDir = path.join(runDir, '.mimo_image_cache');
  await mkdir(cacheDir, { recursive: true });
  const out = path.join(cacheDir, `${slug(file)}_${maxSide}_${quality}.jpg`);
  if (!await exists(out)) {
    await execFileAsync('convert', [
      abs,
      '-auto-orient',
      '-resize', `${maxSide}x${maxSide}>`,
      '-strip',
      '-quality', String(quality),
      out,
    ], { timeout: 120000 });
  }
  return { file: out, mime: 'image/jpeg', temporary: true };
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

function clamp(value, max = 100) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(max, Math.round(n)));
}

function normalizeResult(value, submission) {
  const result = value && typeof value === 'object' ? value : {};
  const score = clamp(result.score);
  let risk = String(result.risk || '').trim().toLowerCase();
  if (!risk || /高风险|complete|full|pass|success/.test(risk)) risk = score >= 90 ? 'complete_audit_report' : '';
  if (!risk || /低$|low/.test(risk)) risk = score <= 40 ? 'missing_audit_report' : 'partial_or_process_only';
  if (score >= 75 && risk === 'missing_audit_report') risk = 'partial_audit_report';
  if (score < 75 && /高风险|complete_audit_report/.test(risk)) risk = 'partial_or_process_only';
  return {
    workAnswerId: String(submission.workAnswerId),
    className: submission.className,
    name: submission.name,
    studentNo: submission.studentNo,
    model: 'mimo-openclaw-rubric',
    score,
    contentScore: clamp(result.contentScore ?? Math.round(score * 0.4), 40),
    evidenceScore: clamp(result.evidenceScore ?? Math.round(score * 0.4), 40),
    layoutScore: clamp(result.layoutScore ?? Math.round(score * 0.2), 20),
    risk: risk || 'mimo-openclaw-rubric',
    summary: String(result.summary || '').slice(0, 1400),
    missing: Array.isArray(result.missing) ? result.missing.map(String).slice(0, 12) : [],
    extractedText: String(result.extractedText || '').slice(0, 6000),
    comment: String(result.comment || '').slice(0, 1200),
    usedImages: [],
  };
}

function selectedSubmissions(submissions) {
  if (!args.names) return submissions;
  const wanted = new Set(String(args.names).split(',').map(item => item.trim()).filter(Boolean));
  return submissions.filter(row => wanted.has(row.name) || wanted.has(String(row.studentNo)) || wanted.has(String(row.workAnswerId)));
}

async function imagePart(label, file) {
  const prepared = await prepareImageForModel(file);
  const data = await readFile(prepared.file);
  return [
    { type: 'text', text: `${label}: ${file}${prepared.temporary ? '（模型输入已等比例压缩，原图未修改）' : ''}` },
    { type: 'image_url', image_url: { url: `data:${prepared.mime};base64,${data.toString('base64')}` } },
  ];
}

async function buildContent(submission) {
  const assets = (Array.isArray(submission.assets) ? submission.assets : [])
    .filter(asset => asset?.ok && asset?.file)
    .slice(0, Number(args.maxImages || process.env.MIMO_MAX_IMAGES || 6));
  const prompt = [
    '你是信息安全代码审计课程作业一的评分模型。必须只按统一规则评分，不得按学生姓名、学号或先验印象特殊处理。',
    '【实验指导书/题干摘要】',
    assignmentGuide,
    '【评分任务】',
    '根据实验指导书和学生上传的截图，判断是否真正完成 OpenClaw 自动化代码审计并产出审计报告。',
    '高分必要证据：截图中必须能看到 OpenClaw 代码审计报告、漏洞/风险列表、审计结果、具体漏洞说明、扫描/分析结论，或能清晰证明 OpenClaw 完成了代码审计并产生结果。',
    '不能高分的情况：只看到 Dockerfile、entrypoint、启动脚本、部署命令、环境变量、Tomcat/Java 启动日志、普通终端代码片段、OpenClaw 空聊天/控制台页面、网络错误页、登录页、无关问答页。这些只能证明准备或部署过程，不能证明完成“自动化代码审计并出具报告”。',
    '如果截图主要是教程前半部分的 ModelScope/OpenClaw 部署、SSH、Sakura Frp、ngrok、WindTerm、远程连接或内网穿透，不能按审计报告给高分。',
    '评分区间：',
    '90-100：OpenClaw 审计报告/漏洞列表/审计结论清楚可见，证据完整，截图可读。',
    '75-85：能看到 OpenClaw 审计结果或报告的一部分，但结论/漏洞细节/排版略不足。',
    '55-65：只有部署、启动、工具使用过程、代码/脚本/终端内容，缺少 OpenClaw 审计报告或漏洞结果。',
    '25-40：只打开空 OpenClaw 页面、聊天页、错误页，或证据非常弱。',
    '0-20：没有有效作业截图或完全无关。',
    '请特别区分：黑底终端文字很多不等于审计报告。若主要内容是 Docker entrypoint/启动脚本/环境配置，应给 55-65 分，不能给 90。',
    '只返回严格 JSON，不要 Markdown。字段：score(0-100), contentScore(0-40), evidenceScore(0-40), layoutScore(0-20), risk, summary, missing(array), extractedText, comment。',
    `学生：${submission.className} ${submission.name} ${submission.studentNo}`,
    `平台提交时间：${submission.submitTime || ''}`,
  ].join('\n');
  const content = [{ type: 'text', text: prompt }];
  for (const [index, asset] of assets.entries()) {
    content.push(...await imagePart(`作业截图${index + 1}`, asset.file));
  }
  return { content, assets };
}

async function callMimo(submission) {
  const { content, assets } = await buildContent(submission);
  if (!assets.length) {
    return {
      workAnswerId: String(submission.workAnswerId),
      className: submission.className,
      name: submission.name,
      studentNo: submission.studentNo,
      model: 'mimo-openclaw-rubric',
      score: 0,
      contentScore: 0,
      evidenceScore: 0,
      layoutScore: 0,
      risk: 'no_valid_images',
      summary: '未找到有效作业截图。',
      missing: ['作业截图', 'OpenClaw审计报告'],
      extractedText: '',
      comment: '未见有效 OpenClaw 审计报告截图，无法证明完成作业。',
      usedImages: [],
    };
  }
  const body = {
    model,
    messages: [{ role: 'user', content }],
    temperature: 0.05,
  };
  const maxRetries = Number(args.retries || process.env.MIMO_RETRIES || 6);
  const baseMs = Number(args.retryBaseMs || process.env.MIMO_RETRY_BASE_MS || 5000);
  let lastError = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(`${endpoint.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(Number(args.timeout || process.env.MIMO_TIMEOUT_MS || 180000)),
      });
      const text = await res.text();
      if (!res.ok) {
        lastError = new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`);
        if (res.status === 429 || res.status >= 500) {
          if (attempt < maxRetries) {
            const waitMs = Math.min(120000, baseMs * (2 ** Math.min(attempt, 5)) + Math.floor(Math.random() * 1000));
            console.log(`  retry ${attempt + 1}/${maxRetries} after ${waitMs}ms: ${submission.name} (${res.status})`);
            await sleep(waitMs);
            continue;
          }
        }
        throw lastError;
      }
      const message = JSON.parse(text)?.choices?.[0]?.message?.content || text;
      const normalized = normalizeResult(parseJsonObject(message), submission);
      normalized.rawText = String(message).slice(0, 2000);
      normalized.usedImages = assets.map(asset => asset.file);
      return normalized;
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries && /429|timeout|fetch failed|ECONNRESET|ETIMEDOUT|HTTP 5/i.test(String(error?.message || error))) {
        const waitMs = Math.min(120000, baseMs * (2 ** Math.min(attempt, 5)) + Math.floor(Math.random() * 1000));
        console.log(`  retry ${attempt + 1}/${maxRetries} after ${waitMs}ms: ${submission.name} (${String(error?.message || error).slice(0, 100)})`);
        await sleep(waitMs);
        continue;
      }
      break;
    }
  }
  throw lastError || new Error('Mimo review failed');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
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

async function main() {
  const submissions = selectedSubmissions(await loadSubmissions(runDir));
  const reviewDir = path.join(runDir, 'openclaw_mimo_review');
  await mkdir(reviewDir, { recursive: true });
  const fresh = [];
  const failed = [];
  for (const [index, submission] of submissions.entries()) {
    const cacheFile = path.join(reviewDir, `${slug(submission.className)}_${slug(submission.studentNo)}_${slug(submission.name)}_${submission.workAnswerId}.json`);
    let result;
    if (!args.force && await exists(cacheFile)) {
      result = await readJson(cacheFile);
      console.log(`[${index + 1}/${submissions.length}] cached ${submission.name}`);
    } else {
      console.log(`[${index + 1}/${submissions.length}] Mimo OpenClaw ${submission.className} ${submission.name} ${submission.studentNo}`);
      try {
        result = await callMimo(submission);
      } catch (error) {
        if (!args.continueOnError) throw error;
        const failedRow = {
          workAnswerId: String(submission.workAnswerId),
          className: submission.className,
          name: submission.name,
          studentNo: submission.studentNo,
          error: String(error?.message || error).slice(0, 1200),
        };
        failed.push(failedRow);
        console.error(`  failed: ${submission.name} ${failedRow.error}`);
        await sleep(Number(args.delay || process.env.MIMO_DELAY_MS || 900));
        continue;
      }
      await writeFile(cacheFile, JSON.stringify(result, null, 2), 'utf8');
      await sleep(Number(args.delay || process.env.MIMO_DELAY_MS || 900));
    }
    fresh.push(result);
  }

  const overrideFile = path.join(runDir, 'local_vision_overrides.json');
  const existing = await readJson(overrideFile, []);
  const reviewedIds = new Set(fresh.map(row => String(row.workAnswerId)));
  const fullSuccessfulRun = !args.names && failed.length === 0;
  const keep = (Array.isArray(existing) ? existing : [])
    .filter(row => !reviewedIds.has(String(row.workAnswerId)))
    .filter(row => !fullSuccessfulRun || !/^local-evidence-review:/.test(String(row.risk || '')));
  const rows = [...keep, ...fresh].sort((a, b) =>
    String(a.className || '').localeCompare(String(b.className || ''), 'zh-Hans-CN')
    || String(a.studentNo || '').localeCompare(String(b.studentNo || ''), 'zh-Hans-CN')
    || String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hans-CN'));
  await writeFile(overrideFile, JSON.stringify(rows, null, 2), 'utf8');
  await writeFile(path.join(runDir, 'openclaw_mimo_review.csv'), toCsv(fresh, [
    'className', 'name', 'studentNo', 'workAnswerId', 'score', 'contentScore', 'evidenceScore', 'layoutScore',
    'risk', 'summary', 'missing', 'comment', 'extractedText', 'usedImages',
  ]), 'utf8');
  if (failed.length) {
    await writeFile(path.join(runDir, 'openclaw_mimo_review_failed.json'), JSON.stringify(failed, null, 2), 'utf8');
    await writeFile(path.join(runDir, 'openclaw_mimo_review_failed.csv'), toCsv(failed, [
      'className', 'name', 'studentNo', 'workAnswerId', 'error',
    ]), 'utf8');
  }
  console.log(`Wrote ${overrideFile}`);
  console.log(`Wrote ${path.join(runDir, 'openclaw_mimo_review.csv')}`);
  if (failed.length) console.log(`Failed ${failed.length}; see ${path.join(runDir, 'openclaw_mimo_review_failed.csv')}`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
