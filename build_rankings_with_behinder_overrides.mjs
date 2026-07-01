#!/usr/bin/env node
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assignments, classAssignmentRules } from './assignment_manifest.mjs';

const baseDir = path.dirname(fileURLToPath(import.meta.url));
const outJson = path.join(baseDir, 'score_rankings_behinder_adjusted.json');
const outCsv = path.join(baseDir, 'class_total_rankings_behinder_adjusted.csv');
const outHtml = path.join(baseDir, 'score_rankings_behinder_adjusted.html');
const overridePath = path.join(baseDir, 'behinder_url_review', 'behinder_url_consistency_all.json');

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

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function compareStudent(a, b) {
  return String(a.studentNo || '').localeCompare(String(b.studentNo || ''), 'zh-Hans-CN')
    || String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hans-CN');
}

function ruleApplies(rule, className) {
  if (rule.className && rule.className === className) return true;
  if (rule.classNamePattern) return new RegExp(rule.classNamePattern).test(className);
  return false;
}

function assignmentTokens(assignment) {
  return new Set([assignment.key, assignment.id, assignment.runDirName, assignment.title, assignment.runDir].filter(Boolean));
}

function hasToken(tokens, values = []) {
  return values.some(value => tokens.has(value));
}

function isAssignedToClass(className, assignment) {
  const rules = (classAssignmentRules || []).filter(rule => ruleApplies(rule, className));
  if (!rules.length) return true;
  const tokens = assignmentTokens(assignment);
  const includeRules = rules.filter(rule => Array.isArray(rule.includeKeys) && rule.includeKeys.length);
  const included = includeRules.length ? includeRules.some(rule => hasToken(tokens, rule.includeKeys)) : true;
  const excluded = rules.some(rule => hasToken(tokens, rule.excludeKeys || []));
  return included && !excluded;
}

function withRanks(rows, valueFn) {
  let lastValue = null;
  let lastRank = 0;
  return rows.map((row, index) => {
    const value = valueFn(row);
    const rank = index === 0 || value !== lastValue ? index + 1 : lastRank;
    lastValue = value;
    lastRank = rank;
    return { ...row, rank };
  });
}

function csvValue(value) {
  const text = value == null ? '' : String(value);
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}

function toCsv(rows, columns) {
  return [
    columns.map(col => csvValue(col.header)).join(','),
    ...rows.map(row => columns.map(col => csvValue(col.value(row))).join(',')),
  ].join('\n') + '\n';
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

const overrideRows = await readJson(overridePath, []);
const overrideByWorkAnswerId = new Map();
for (const row of Array.isArray(overrideRows) ? overrideRows : []) {
  if (!row?.workAnswerId) continue;
  const current = Number(row.currentBaseScore);
  const suggested = Number(row.suggestedBaseScore);
  if (Number.isFinite(current) && Number.isFinite(suggested) && suggested < current) {
    overrideByWorkAnswerId.set(String(row.workAnswerId), {
      suggestedBaseScore: suggested,
      status: row.status,
      reason: row.reason,
      assignmentTitle: row.assignmentTitle,
    });
  }
}

const classMap = new Map();
const assignmentSummaries = [];

for (const item of assignments) {
  const runDir = path.resolve(baseDir, '..', item.runDir);
  const assignmentMeta = { ...item, id: path.basename(runDir), runDirName: path.basename(runDir), runDir };
  const drafts = await readJson(path.join(runDir, 'grading_draft.json'), []);
  if (!Array.isArray(drafts) || drafts.length === 0) continue;
  const submissions = await loadSubmissions(runDir);
  const rows = drafts.map(row => {
    const sub = submissions.get(String(row.workAnswerId));
    const override = overrideByWorkAnswerId.get(String(row.workAnswerId));
    const originalBaseScore = scoreNumber(row);
    const baseScore = override ? Math.min(originalBaseScore, override.suggestedBaseScore) : originalBaseScore;
    return {
      ...row,
      originalBaseScore,
      baseScore,
      override,
      submitTime: sub?.submitTime || '',
      submitOrder: parseSubmitTime(sub?.submitTime || ''),
      plagiarismZero: isPlagiarismZero(row),
      unsubmitted: isUnsubmitted(row),
      bonus: 0,
    };
  });

  const byClass = new Map();
  for (const row of rows) {
    const className = String(row.className || '未分班');
    if (!isAssignedToClass(className, assignmentMeta)) continue;
    if (!byClass.has(className)) byClass.set(className, []);
    byClass.get(className).push(row);
  }

  const classSummaries = [];
  for (const [className, classRows] of byClass.entries()) {
    const eligible = classRows
      .filter(row => row.baseScore > 0 && !row.plagiarismZero && !row.unsubmitted && row.submitOrder < Number.MAX_SAFE_INTEGER)
      .sort((a, b) => a.submitOrder - b.submitOrder || compareStudent(a, b));
    eligible.forEach((row, index) => {
      row.bonus = bonusForRank(index, eligible.length);
    });
    classSummaries.push({
      className,
      rows: classRows.map(row => ({
        className,
        name: row.name || '',
        studentNo: row.studentNo || '',
        workAnswerId: row.workAnswerId || '',
        baseScore: row.baseScore,
        originalBaseScore: row.originalBaseScore,
        bonus: row.bonus,
        finalScore: Math.min(100, row.baseScore + row.bonus),
        submitTime: row.submitTime,
        override: row.override || null,
      })),
    });
  }
  assignmentSummaries.push({ key: item.key, title: item.title, classes: classSummaries });

  for (const row of rows) {
    const className = String(row.className || '未分班');
    if (!isAssignedToClass(className, assignmentMeta)) continue;
    const key = String(row.studentNo || row.name || row.workAnswerId);
    if (!classMap.has(className)) classMap.set(className, { className, students: new Map(), assignmentCount: 0 });
    const classItem = classMap.get(className);
    if (!classItem.students.has(key)) {
      classItem.students.set(key, {
        className,
        name: row.name || '',
        studentNo: row.studentNo || '',
        baseTotal: 0,
        bonusTotal: 0,
        finalTotal: 0,
        adjustedDelta: 0,
        submitted: 0,
        zeroCount: 0,
        plagiarismZeroCount: 0,
        assignments: {},
      });
    }
    const student = classItem.students.get(key);
    const finalScore = Math.min(100, row.baseScore + row.bonus);
    student.name = row.name || student.name;
    student.studentNo = row.studentNo || student.studentNo;
    student.baseTotal += row.baseScore;
    student.bonusTotal += finalScore - row.baseScore;
    student.finalTotal += finalScore;
    student.adjustedDelta += row.baseScore - row.originalBaseScore;
    student.submitted += row.unsubmitted ? 0 : 1;
    student.zeroCount += row.baseScore === 0 ? 1 : 0;
    student.plagiarismZeroCount += row.plagiarismZero ? 1 : 0;
    student.assignments[item.key] = {
      title: item.title,
      baseScore: row.baseScore,
      originalBaseScore: row.originalBaseScore,
      bonus: finalScore - row.baseScore,
      finalScore,
      submitTime: row.submitTime,
      override: row.override || null,
    };
  }
  for (const classItem of classMap.values()) {
    if (byClass.has(classItem.className)) classItem.assignmentCount += 1;
  }
}

const classSummaries = [];
const csvRows = [];
for (const classItem of [...classMap.values()].sort((a, b) => a.className.localeCompare(b.className, 'zh-Hans-CN'))) {
  const rows = withRanks(
    [...classItem.students.values()].sort((a, b) =>
      b.finalTotal - a.finalTotal
      || b.baseTotal - a.baseTotal
      || compareStudent(a, b)),
    row => row.finalTotal,
  ).map(row => ({
    ...row,
    baseTotal: round(row.baseTotal),
    bonusTotal: round(row.bonusTotal),
    finalTotal: round(row.finalTotal),
    adjustedDelta: round(row.adjustedDelta),
    baseAverage: round(row.baseTotal / Math.max(1, classItem.assignmentCount)),
    finalAverage: round(row.finalTotal / Math.max(1, classItem.assignmentCount)),
  }));
  classSummaries.push({ className: classItem.className, studentCount: rows.length, assignmentCount: classItem.assignmentCount, rows });
  csvRows.push(...rows);
}

const output = {
  generatedAt: new Date().toISOString(),
  policy: {
    description: '在现有 grading_draft.json 基础上叠加冰蝎 URL/路径一致性报告中的建议降分，再按早交加分规则排名；尚未写回超星。',
    overridePath: path.relative(baseDir, overridePath),
    overrideCount: overrideByWorkAnswerId.size,
  },
  classSummaries,
  assignmentSummaries,
};

await writeFile(outJson, JSON.stringify(output, null, 2), 'utf8');
await writeFile(outCsv, toCsv(csvRows, [
  { header: 'className', value: row => row.className },
  { header: 'rank', value: row => row.rank },
  { header: 'name', value: row => row.name },
  { header: 'studentNo', value: row => row.studentNo },
  { header: 'baseTotal', value: row => row.baseTotal },
  { header: 'bonusTotal', value: row => row.bonusTotal },
  { header: 'finalTotal', value: row => row.finalTotal },
  { header: 'finalAverage', value: row => row.finalAverage },
  { header: 'adjustedDelta', value: row => row.adjustedDelta },
  { header: 'zeroCount', value: row => row.zeroCount },
  { header: 'plagiarismZeroCount', value: row => row.plagiarismZeroCount },
]), 'utf8');

const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>新规则临时排名</title>
  <style>
    body{margin:0;background:#f6f8fb;color:#1f2937;font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif}
    header{position:sticky;top:0;background:#fff;border-bottom:1px solid #d8e0ea;padding:14px 18px;z-index:2}
    h1{margin:0 0 6px;font-size:20px}.meta{color:#64748b;font-size:12px}
    main{padding:16px 18px 28px}section{margin:0 0 22px}h2{font-size:17px;margin:0 0 10px}
    table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #d8e0ea}
    th,td{border-bottom:1px solid #e5ebf2;padding:7px 8px;text-align:left;white-space:nowrap}
    th{background:#eef3f8;color:#334155}.num{text-align:right;font-variant-numeric:tabular-nums}.bad{color:#b42318;font-weight:700}
  </style>
</head>
<body>
  <header>
    <h1>新规则临时排名</h1>
    <div class="meta">${esc(output.policy.description)} 生成时间：${esc(output.generatedAt)} ｜ 覆盖降分记录：${output.policy.overrideCount} ｜ CSV：class_total_rankings_behinder_adjusted.csv</div>
  </header>
  <main>
    ${classSummaries.map(group => `
      <section>
        <h2>${esc(group.className)} · ${group.studentCount} 人 · ${group.assignmentCount} 个作业</h2>
        <table>
          <thead><tr><th>排名</th><th>姓名</th><th>学号</th><th class="num">基准总分</th><th class="num">早交加分</th><th class="num">最终总分</th><th class="num">最终均分</th><th class="num">本次调整</th><th class="num">雷同0分</th></tr></thead>
          <tbody>${group.rows.map(row => `
            <tr>
              <td>${row.rank}</td><td>${esc(row.name)}</td><td>${esc(row.studentNo)}</td>
              <td class="num">${row.baseTotal}</td><td class="num">${row.bonusTotal}</td><td class="num">${row.finalTotal}</td><td class="num">${row.finalAverage}</td>
              <td class="num ${row.adjustedDelta ? 'bad' : ''}">${row.adjustedDelta}</td><td class="num ${row.plagiarismZeroCount ? 'bad' : ''}">${row.plagiarismZeroCount}</td>
            </tr>`).join('')}</tbody>
        </table>
      </section>`).join('')}
  </main>
</body>
</html>`;

await writeFile(outHtml, html, 'utf8');
console.log(`Wrote ${outHtml}`);
console.log(`Wrote ${outJson}`);
console.log(`Wrote ${outCsv}`);
