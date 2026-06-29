#!/usr/bin/env node
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assignments } from './assignment_manifest.mjs';

const baseDir = path.dirname(fileURLToPath(import.meta.url));
const jsonPath = path.join(baseDir, 'score_rankings_early_bonus.json');
const htmlPath = path.join(baseDir, 'score_rankings_early_bonus.html');
const csvPath = path.join(baseDir, 'class_total_rankings_early_bonus.csv');

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
  if (full) {
    return new Date(Number(full[1]), Number(full[2]) - 1, Number(full[3]), Number(full[4]), Number(full[5]), Number(full[6] || 0)).getTime();
  }
  const partial = text.match(/(\d{1,2})[-/](\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (partial) {
    return new Date(new Date().getFullYear(), Number(partial[1]) - 1, Number(partial[2]), Number(partial[3]), Number(partial[4]), Number(partial[5] || 0)).getTime();
  }
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

function compareStudent(a, b) {
  return String(a.studentNo || '').localeCompare(String(b.studentNo || ''), 'zh-Hans-CN')
    || String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hans-CN');
}

const classMap = new Map();
const assignmentSummaries = [];

for (const item of assignments) {
  const runDir = path.isAbsolute(item.runDir)
    ? item.runDir
    : path.resolve(baseDir, item.runDir.replace(/^chaoxing-grader[\\/]/, ''));
  const drafts = await readJson(path.join(runDir, 'grading_draft.json'), []);
  if (!Array.isArray(drafts) || drafts.length === 0) continue;
  const submissions = await loadSubmissions(runDir);
  const rows = drafts.map(row => {
    const sub = submissions.get(String(row.workAnswerId));
    return {
      ...row,
      baseScore: scoreNumber(row),
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
      submitted: eligible.length,
      rows: classRows.map(row => ({
        className,
        name: row.name || '',
        studentNo: row.studentNo || '',
        workAnswerId: row.workAnswerId || '',
        baseScore: row.baseScore,
        bonus: row.bonus,
        finalScore: Math.min(100, row.baseScore + row.bonus),
        submitTime: row.submitTime,
        plagiarismZero: row.plagiarismZero,
        unsubmitted: row.unsubmitted,
      })),
    });
  }
  assignmentSummaries.push({ id: path.basename(runDir), title: item.title, runDir, classes: classSummaries });

  for (const row of rows) {
    const className = String(row.className || '未分班');
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
    student.submitted += row.unsubmitted ? 0 : 1;
    student.zeroCount += row.baseScore === 0 ? 1 : 0;
    student.plagiarismZeroCount += row.plagiarismZero ? 1 : 0;
    student.assignments[item.key] = {
      title: item.title,
      baseScore: row.baseScore,
      bonus: finalScore - row.baseScore,
      finalScore,
      submitTime: row.submitTime,
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
    baseAverage: round(row.baseTotal / Math.max(1, classItem.assignmentCount)),
    bonusAverage: round(row.bonusTotal / Math.max(1, classItem.assignmentCount)),
    finalAverage: round(row.finalTotal / Math.max(1, classItem.assignmentCount)),
  }));
  classSummaries.push({
    className: classItem.className,
    studentCount: rows.length,
    assignmentCount: classItem.assignmentCount,
    rows,
  });
  csvRows.push(...rows);
}

const output = {
  generatedAt: new Date().toISOString(),
  policy: {
    description: '同班同作业按提交时间排序：前20% +5，20%-50% +3，其余已交 +1；抄袭0分/未交不加；单作业封顶100。',
    top20PercentBonus: 5,
    top50PercentBonus: 3,
    submittedBonus: 1,
    capPerAssignment: 100,
  },
  classSummaries,
  assignmentSummaries,
};

await writeFile(jsonPath, JSON.stringify(output, null, 2), 'utf8');
await writeFile(csvPath, toCsv(csvRows, [
  { header: 'className', value: row => row.className },
  { header: 'rank', value: row => row.rank },
  { header: 'name', value: row => row.name },
  { header: 'studentNo', value: row => row.studentNo },
  { header: 'baseTotal', value: row => row.baseTotal },
  { header: 'bonusTotal', value: row => row.bonusTotal },
  { header: 'finalTotal', value: row => row.finalTotal },
  { header: 'baseAverage', value: row => row.baseAverage },
  { header: 'finalAverage', value: row => row.finalAverage },
  { header: 'zeroCount', value: row => row.zeroCount },
  { header: 'plagiarismZeroCount', value: row => row.plagiarismZeroCount },
]), 'utf8');

const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>早交加分排名</title>
  <style>
    body{margin:0;background:#f6f8fb;color:#1f2937;font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif}
    header{position:sticky;top:0;background:#fff;border-bottom:1px solid #d8e0ea;padding:14px 18px;z-index:2}
    h1{margin:0 0 6px;font-size:20px}
    .meta{color:#64748b;font-size:12px}
    main{padding:16px 18px 28px}
    section{margin:0 0 22px}
    h2{font-size:17px;margin:0 0 10px}
    table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #d8e0ea}
    th,td{border-bottom:1px solid #e5ebf2;padding:7px 8px;text-align:left;white-space:nowrap}
    th{background:#eef3f8;font-weight:700;color:#334155}
    tr:hover td{background:#f8fbff}
    .num{text-align:right;font-variant-numeric:tabular-nums}
    .warn{color:#b42318;font-weight:600}
    a{color:#1769aa}
  </style>
</head>
<body>
  <header>
    <h1>早交加分排名</h1>
    <div class="meta">规则：${esc(output.policy.description)} 生成时间：${esc(output.generatedAt)} ｜ <a href="score_rankings.html">原始排名</a> ｜ <a href="class_total_rankings_early_bonus.csv">CSV</a></div>
  </header>
  <main>
    ${classSummaries.map(group => `
      <section>
        <h2>${esc(group.className)} · ${group.studentCount} 人 · ${group.assignmentCount} 个作业</h2>
        <table>
          <thead><tr><th>排名</th><th>姓名</th><th>学号</th><th class="num">原总分</th><th class="num">早交加分</th><th class="num">加分后总分</th><th class="num">加分后均分</th><th class="num">抄袭0分</th></tr></thead>
          <tbody>
            ${group.rows.map(row => `
              <tr>
                <td>${row.rank}</td>
                <td>${esc(row.name)}</td>
                <td>${esc(row.studentNo)}</td>
                <td class="num">${row.baseTotal}</td>
                <td class="num">${row.bonusTotal}</td>
                <td class="num">${row.finalTotal}</td>
                <td class="num">${row.finalAverage}</td>
                <td class="num ${row.plagiarismZeroCount ? 'warn' : ''}">${row.plagiarismZeroCount}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </section>`).join('')}
  </main>
</body>
</html>`;

await writeFile(htmlPath, html, 'utf8');

console.log(`Wrote ${htmlPath}`);
console.log(`Wrote ${jsonPath}`);
console.log(`Wrote ${csvPath}`);
