#!/usr/bin/env node
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assignments } from './assignment_manifest.mjs';

const baseDir = path.dirname(fileURLToPath(import.meta.url));
const targetKeys = new Set(['zuoye7-upload', 'zuoye8-sql', 'zuoye9-memory-shell']);
const overridePath = path.join(baseDir, 'behinder_url_review', 'behinder_url_consistency_all.json');
const statusPath = path.join(baseDir, 'submit_behinder_adjusted_status.json');

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function loadSubmissions(runDir) {
  const dir = path.join(runDir, 'submissions');
  if (!await exists(dir)) return new Map();
  const out = new Map();
  for (const file of (await readdir(dir)).filter(name => name.endsWith('.json'))) {
    const row = await readJson(path.join(dir, file), null);
    if (row?.workAnswerId) out.set(String(row.workAnswerId), row);
  }
  return out;
}

function parseSubmitTime(value) {
  const text = String(value || '').trim();
  const full = text.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (full) return new Date(Number(full[1]), Number(full[2]) - 1, Number(full[3]), Number(full[4]), Number(full[5]), Number(full[6] || 0)).getTime();
  const partial = text.match(/(\d{1,2})[-/](\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (partial) return new Date(new Date().getFullYear(), Number(partial[1]) - 1, Number(partial[2]), Number(partial[3]), Number(partial[4]), Number(partial[5] || 0)).getTime();
  return Number.MAX_SAFE_INTEGER;
}

function scoreNumber(row) {
  const value = Number(row?.draftScore ?? row?.score ?? row?.existingScore);
  return Number.isFinite(value) ? value : 0;
}

function isPlagiarismZero(row) {
  if (scoreNumber(row) !== 0) return false;
  const text = [row?.risk, row?.basis, row?.draftComment].filter(Boolean).join(' ');
  return /advanced-confirmed|高级相似检测|雷同|后续雷同|首个提交/.test(text);
}

function isUnsubmitted(row) {
  const text = [row?.status, row?.basis, row?.draftComment].filter(Boolean).join(' ');
  return /未交|not submitted|未显示已交作业/.test(text);
}

function bonusForRank(index, count) {
  const pct = (index + 1) / Math.max(1, count);
  if (pct <= 0.2) return 5;
  if (pct <= 0.5) return 3;
  return 1;
}

function clampScore(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function commentWithAdjustments(row, originalBaseScore, adjustedBaseScore, override, bonus, finalScore, submitTime) {
  const parts = [];
  const base = String(row.draftComment || '').trim() || '已按作业截图和实验完成情况评分。';
  parts.push(base);
  if (override && adjustedBaseScore < originalBaseScore) {
    const reason = override.status === 'wrong-assignment-path'
      ? '冰蝎 URL/路径属于其他实验或不符合本作业要求'
      : '未能识别到符合本作业要求的冰蝎 URL/路径证据';
    parts.push(`冰蝎 URL/路径复核：${reason}，基准分由 ${originalBaseScore} 调整为 ${adjustedBaseScore}。`);
  }
  if (bonus > 0) {
    parts.push(`早交加分：同班同作业按提交时间排序，本次提交时间 ${submitTime || '未知'}，加 ${bonus} 分；最终 ${finalScore} 分。`);
  }
  return parts.join(' ');
}

const overrideRows = await readJson(overridePath, []);
const overrideByWorkAnswerId = new Map();
for (const row of Array.isArray(overrideRows) ? overrideRows : []) {
  if (!targetKeys.has(row.assignmentKey) || !row?.workAnswerId) continue;
  const current = Number(row.currentBaseScore);
  const suggested = Number(row.suggestedBaseScore);
  if (Number.isFinite(current) && Number.isFinite(suggested) && suggested < current) {
    overrideByWorkAnswerId.set(String(row.workAnswerId), {
      suggestedBaseScore: suggested,
      status: row.status,
      reason: row.reason,
      assignmentKey: row.assignmentKey,
      assignmentTitle: row.assignmentTitle,
    });
  }
}

const summaries = [];
for (const assignment of assignments.filter(item => targetKeys.has(item.key))) {
  const runDir = path.resolve(baseDir, '..', assignment.runDir);
  const sourceDraftPath = path.join(runDir, 'grading_draft.json');
  const drafts = await readJson(sourceDraftPath, []);
  if (!Array.isArray(drafts) || !drafts.length) continue;
  const submissions = await loadSubmissions(runDir);
  const enriched = drafts.map(row => {
    const sub = submissions.get(String(row.workAnswerId));
    const originalBaseScore = scoreNumber(row);
    const override = overrideByWorkAnswerId.get(String(row.workAnswerId));
    const adjustedBaseScore = override ? Math.min(originalBaseScore, override.suggestedBaseScore) : originalBaseScore;
    return {
      row,
      originalBaseScore,
      adjustedBaseScore,
      override,
      submitTime: sub?.submitTime || '',
      submitOrder: parseSubmitTime(sub?.submitTime || ''),
      plagiarismZero: isPlagiarismZero(row),
      unsubmitted: isUnsubmitted(row),
      bonus: 0,
    };
  });

  const byClass = new Map();
  for (const item of enriched) {
    const className = String(item.row.className || '未分班');
    if (!byClass.has(className)) byClass.set(className, []);
    byClass.get(className).push(item);
  }
  for (const classRows of byClass.values()) {
    const eligible = classRows
      .filter(item => item.adjustedBaseScore > 0 && !item.plagiarismZero && !item.unsubmitted && item.submitOrder < Number.MAX_SAFE_INTEGER)
      .sort((a, b) => a.submitOrder - b.submitOrder
        || String(a.row.studentNo || '').localeCompare(String(b.row.studentNo || ''), 'zh-Hans-CN')
        || String(a.row.name || '').localeCompare(String(b.row.name || ''), 'zh-Hans-CN'));
    eligible.forEach((item, index) => {
      item.bonus = bonusForRank(index, eligible.length);
    });
  }

  const submitDrafts = enriched.map(item => {
    const finalScore = clampScore(Math.min(100, item.adjustedBaseScore + item.bonus));
    const appliedBonus = finalScore - item.adjustedBaseScore;
    return {
      ...item.row,
      approved: true,
      draftScore: finalScore,
      draftComment: commentWithAdjustments(item.row, item.originalBaseScore, item.adjustedBaseScore, item.override, appliedBonus, finalScore, item.submitTime),
      earlyBonusBaseScore: item.adjustedBaseScore,
      earlyBonusOriginalBaseScore: item.originalBaseScore,
      earlyBonus: appliedBonus,
      earlyBonusSubmitTime: item.submitTime,
      earlyBonusPolicy: '同班同作业按提交时间排序：前20% +5，20%-50% +3，其余已交 +1；抄袭0分/未交不加；单作业封顶100。',
      behinderUrlAdjusted: Boolean(item.override && item.adjustedBaseScore < item.originalBaseScore),
      behinderUrlAdjustment: item.override || null,
    };
  });

  const outFile = path.join(runDir, 'grading_draft_submit_behinder_adjusted.json');
  await writeFile(outFile, JSON.stringify(submitDrafts, null, 2), 'utf8');
  summaries.push({
    key: assignment.key,
    title: assignment.title,
    runDir: assignment.runDir,
    draft: outFile,
    rows: submitDrafts.filter(row => !row.skip && row.reviewUrl).length,
    adjustedRows: submitDrafts.filter(row => row.behinderUrlAdjusted).length,
    bonusRows: submitDrafts.filter(row => Number(row.earlyBonus || 0) > 0).length,
    zeroRows: submitDrafts.filter(row => !row.skip && row.reviewUrl && Number(row.draftScore) === 0).length,
  });
}

await writeFile(statusPath, JSON.stringify({
  generatedAt: new Date().toISOString(),
  overridePath,
  summaries,
}, null, 2), 'utf8');

for (const row of summaries) {
  console.log(`${row.key}\trows=${row.rows}\tadjusted=${row.adjustedRows}\tbonus=${row.bonusRows}\tzero=${row.zeroRows}\t${row.draft}`);
}
