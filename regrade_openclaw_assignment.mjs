#!/usr/bin/env node
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

const runDir = path.resolve(process.argv[2] || '');
if (!runDir) {
  console.error('usage: node regrade_openclaw_assignment.mjs <run-dir>');
  process.exit(1);
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

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function loadSubmissions(dir) {
  const submissionsDir = path.join(dir, 'submissions');
  const rows = [];
  for (const file of (await readdir(submissionsDir)).filter(name => name.endsWith('.json')).sort()) {
    rows.push(await readJson(path.join(submissionsDir, file)));
  }
  return rows;
}

function classifyFromMetrics(metrics, assetCount) {
  if (!assetCount) {
    return {
      score: 0,
      kind: 'no_evidence',
      label: '作业一证据复核：未提交有效作业截图',
      comment: '未看到有效的 OpenClaw 审计报告或审计过程截图，无法证明完成代码审计。',
    };
  }
  const dark = Number(metrics.dark || 0);
  const bright = Number(metrics.bright || 0);
  const edge = Number(metrics.edge || 0);
  const lap = Number(metrics.lap || 0);
  if (bright >= 0.28 && edge < 0.03 && lap < 350) {
    return {
      score: 30,
      kind: 'empty_openclaw_page',
      label: '作业一证据复核：仅见 OpenClaw 空界面/聊天页',
      comment: '截图仅能证明打开了 OpenClaw 页面，未展示审计报告、漏洞列表、分析结果或有效审计输出。',
    };
  }
  if (dark < 0.08 && edge < 0.015 && lap < 180) {
    return {
      score: 20,
      kind: 'blank_or_error_page',
      label: '作业一证据复核：截图内容不足或疑似错误页',
      comment: '截图未展示可核验的 OpenClaw 审计过程或报告结果，作业证据不足。',
    };
  }
  if (dark >= 0.32 && edge >= 0.035 && lap >= 500) {
    return {
      score: 90,
      kind: 'terminal_or_report_evidence',
      label: '作业一证据复核：截图包含较密集的审计输出/报告证据',
      comment: '截图能看到较密集的终端、代码审计输出或报告内容，基本能证明完成 OpenClaw 自动化代码审计。',
    };
  }
  if (assetCount >= 2 && (edge >= 0.025 || dark >= 0.15)) {
    return {
      score: 80,
      kind: 'partial_multi_image_evidence',
      label: '作业一证据复核：多图但审计报告证据不完整',
      comment: '提交了多张相关截图，但审计报告、漏洞列表或分析结论展示不够完整。',
    };
  }
  if (edge >= 0.03 || lap >= 400 || dark >= 0.15) {
    return {
      score: 60,
      kind: 'limited_process_evidence',
      label: '作业一证据复核：有操作过程截图但报告结果不足',
      comment: '截图显示一定操作过程，但缺少明确的 OpenClaw 审计报告、漏洞结果或分析结论。',
    };
  }
  return {
    score: 40,
    kind: 'weak_evidence',
    label: '作业一证据复核：证据较弱',
    comment: '截图与 OpenClaw 作业相关性较弱，未充分展示自动化代码审计报告内容。',
  };
}

async function imageMetrics(dir, submission) {
  const assets = (Array.isArray(submission.assets) ? submission.assets : [])
    .filter(asset => asset?.ok && asset?.file);
  if (!assets.length) return { assetCount: 0, dark: 0, bright: 0, edge: 0, lap: 0, files: '' };
  const script = `
import cv2, json, os, sys
rows=[]
for p in sys.argv[1:]:
    img=cv2.imread(p)
    if img is None:
        continue
    h,w=img.shape[:2]
    gray=cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    center=gray[int(h*.12):int(h*.88), int(w*.08):int(w*.92)]
    rows.append({
        "dark": float((center<70).mean()),
        "bright": float((center>225).mean()),
        "edge": float(cv2.Canny(center,80,160).mean()/255),
        "lap": float(cv2.Laplacian(center, cv2.CV_64F).var()),
    })
print(json.dumps(rows, ensure_ascii=False))
`;
  const files = assets.map(asset => path.resolve(dir, asset.file));
  const result = spawnSync(process.env.PYTHON || '.venv-cv/bin/python', ['-c', script, ...files], {
    cwd: process.cwd(),
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`metric extraction failed: ${result.stderr || result.stdout}`);
  }
  const rows = JSON.parse(result.stdout || '[]');
  return {
    assetCount: assets.length,
    dark: Math.max(0, ...rows.map(row => Number(row.dark || 0))),
    bright: Math.max(0, ...rows.map(row => Number(row.bright || 0))),
    edge: Math.max(0, ...rows.map(row => Number(row.edge || 0))),
    lap: Math.max(0, ...rows.map(row => Number(row.lap || 0))),
    files: assets.map(asset => asset.file).join(';'),
  };
}

const [drafts, submissions] = await Promise.all([
  readJson(path.join(runDir, 'grading_draft.json')),
  loadSubmissions(runDir),
]);
const subById = new Map(submissions.map(row => [String(row.workAnswerId), row]));
const auditRows = [];
let changed = 0;

for (const row of drafts) {
  if (row.skip) continue;
  const sub = subById.get(String(row.workAnswerId));
  const metrics = sub ? await imageMetrics(runDir, sub) : { assetCount: 0, dark: 0, bright: 0, edge: 0, lap: 0, files: '' };
  const result = classifyFromMetrics(metrics, metrics.assetCount);
  const previousScore = Number(row.draftScore);
  if (previousScore !== result.score || !String(row.basis || '').startsWith('作业一证据复核')) changed++;
  row.draftScore = result.score;
  row.risk = row.risk || '';
  row.basis = result.label;
  row.draftComment = `${result.comment} 评分依据：${result.label}。`;
  auditRows.push({
    className: row.className,
    name: row.name,
    studentNo: row.studentNo,
    workAnswerId: row.workAnswerId,
    previousScore,
    draftScore: row.draftScore,
    kind: result.kind,
    basis: row.basis,
    assetCount: metrics.assetCount,
    dark: metrics.dark.toFixed(4),
    bright: metrics.bright.toFixed(4),
    edge: metrics.edge.toFixed(4),
    lap: metrics.lap.toFixed(1),
    files: metrics.files,
  });
}

await writeFile(path.join(runDir, 'grading_draft.json'), JSON.stringify(drafts, null, 2), 'utf8');
await writeFile(path.join(runDir, 'grading_draft_openclaw_audit.csv'), toCsv(auditRows, [
  'className', 'name', 'studentNo', 'workAnswerId', 'previousScore', 'draftScore', 'kind', 'basis',
  'assetCount', 'dark', 'bright', 'edge', 'lap', 'files',
]), 'utf8');
await writeFile(path.join(runDir, 'grading_draft_advanced.csv'), toCsv(drafts, [
  'approved', 'skip', 'className', 'name', 'studentNo', 'workAnswerId',
  'status', 'existingScore', 'draftScore', 'draftComment', 'risk', 'basis', 'reviewUrl',
]), 'utf8');

console.log(`Regraded ${auditRows.length} OpenClaw assignment rows, changed=${changed}`);
console.log(`Wrote ${path.join(runDir, 'grading_draft_openclaw_audit.csv')}`);
