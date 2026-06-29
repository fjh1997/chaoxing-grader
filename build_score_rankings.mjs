#!/usr/bin/env node
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assignments } from './assignment_manifest.mjs';

const baseDir = path.dirname(fileURLToPath(import.meta.url));
const statusPath = path.join(baseDir, 'report_all_status.json');
const htmlPath = path.join(baseDir, 'score_rankings.html');
const jsonPath = path.join(baseDir, 'score_rankings.json');
const totalCsvPath = path.join(baseDir, 'class_total_rankings.csv');
const assignmentCsvPath = path.join(baseDir, 'assignment_score_rankings.csv');

function toPosix(filePath) {
  return filePath.split(path.sep).join('/');
}

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

function chineseNumberToInt(text) {
  const values = {
    一: 1,
    二: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
    十: 10,
  };
  if (!text) return 999;
  if (text === '十') return 10;
  if (text.startsWith('十')) return 10 + (values[text.slice(1)] || 0);
  if (text.endsWith('十')) return (values[text[0]] || 0) * 10;
  if (text.includes('十')) {
    const [tens, ones] = text.split('十');
    return (values[tens] || 1) * 10 + (values[ones] || 0);
  }
  return values[text] || 999;
}

function orderFromTitle(title, fallback) {
  const match = String(title || '').match(/作业([一二三四五六七八九十]+)/);
  const order = chineseNumberToInt(match?.[1] || '');
  return Number.isFinite(order) ? order : fallback;
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

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function compareStudent(a, b) {
  return String(a.studentNo || '').localeCompare(String(b.studentNo || ''), 'zh-Hans-CN')
    || String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hans-CN');
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

function escapeScriptJson(value) {
  return JSON.stringify(value, null, 2).replace(/<\//g, '<\\/');
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

const status = await readJson(statusPath, { generatedAt: new Date().toISOString(), results: [] });
const generatedAt = status.generatedAt || new Date().toISOString();
const manifestOrder = new Map(assignments.map((item, index) => [path.basename(item.runDir), index + 1]));

const assignmentRecords = [];
for (const [index, row] of (status.results || []).entries()) {
  const runDir = path.isAbsolute(row.runDir || '')
    ? row.runDir
    : path.resolve(baseDir, row.runDir || '');
  const draftPath = path.join(runDir, 'grading_draft.json');
  if (!await exists(draftPath)) continue;
  const drafts = await readJson(draftPath, []);
  if (!Array.isArray(drafts) || drafts.length === 0) continue;
  const runDirName = path.basename(runDir);
  assignmentRecords.push({
    id: runDirName,
    title: row.title || runDirName,
    order: manifestOrder.get(runDirName) || orderFromTitle(row.title || runDirName, index + 1),
    runDirName,
    runDir,
    reportHref: toPosix(path.relative(baseDir, path.join(runDir, 'review_report_advanced.html'))),
    drafts,
  });
}

assignmentRecords.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title, 'zh-Hans-CN'));

const classMap = new Map();
const assignmentRankings = [];
const assignmentCsvRows = [];

for (const assignment of assignmentRecords) {
  const byClass = new Map();
  for (const row of assignment.drafts) {
    const className = String(row.className || '未分班');
    if (!byClass.has(className)) byClass.set(className, []);
    byClass.get(className).push(row);

    if (!classMap.has(className)) {
      classMap.set(className, {
        className,
        assignmentIds: new Set(),
        assignmentTitles: new Map(),
        students: new Map(),
      });
    }
    const classItem = classMap.get(className);
    classItem.assignmentIds.add(assignment.id);
    classItem.assignmentTitles.set(assignment.id, assignment.title);
    const studentKey = String(row.studentNo || row.name || row.workAnswerId);
    if (!classItem.students.has(studentKey)) {
      classItem.students.set(studentKey, {
        className,
        name: row.name || '',
        studentNo: row.studentNo || '',
        scores: new Map(),
        totalScore: 0,
        submitted: 0,
        zeroCount: 0,
        plagiarismZeroCount: 0,
      });
    }
    const student = classItem.students.get(studentKey);
    const score = scoreNumber(row);
    student.name = row.name || student.name;
    student.studentNo = row.studentNo || student.studentNo;
    student.scores.set(assignment.id, {
      score,
      title: assignment.title,
      status: row.status || '',
      risk: row.risk || '',
      basis: row.basis || '',
      comment: row.draftComment || '',
      reviewUrl: row.reviewUrl || '',
      plagiarismZero: isPlagiarismZero(row),
      unsubmitted: isUnsubmitted(row),
    });
  }

  const classes = [];
  for (const [className, rows] of [...byClass.entries()].sort((a, b) => a[0].localeCompare(b[0], 'zh-Hans-CN'))) {
    const ranked = withRanks(
      [...rows].sort((a, b) => scoreNumber(b) - scoreNumber(a) || compareStudent(a, b)),
      scoreNumber,
    ).map(row => ({
      rank: row.rank,
      className,
      name: row.name || '',
      studentNo: row.studentNo || '',
      score: scoreNumber(row),
      status: row.status || '',
      risk: row.risk || '',
      basis: row.basis || '',
      comment: row.draftComment || '',
      reviewUrl: row.reviewUrl || '',
      plagiarismZero: isPlagiarismZero(row),
      unsubmitted: isUnsubmitted(row),
    }));
    classes.push({ className, count: ranked.length, rows: ranked });
    for (const item of ranked) {
      assignmentCsvRows.push({
        assignmentTitle: assignment.title,
        assignmentId: assignment.id,
        ...item,
      });
    }
  }
  assignmentRankings.push({
    id: assignment.id,
    title: assignment.title,
    order: assignment.order,
    reportHref: assignment.reportHref,
    classes,
  });
}

const classSummaries = [];
const totalCsvRows = [];

for (const classItem of [...classMap.values()].sort((a, b) => a.className.localeCompare(b.className, 'zh-Hans-CN'))) {
  const assignmentIds = [...classItem.assignmentIds].sort((a, b) => {
    const aa = assignmentRecords.find(item => item.id === a);
    const bb = assignmentRecords.find(item => item.id === b);
    return (aa?.order || 999) - (bb?.order || 999) || String(a).localeCompare(String(b), 'zh-Hans-CN');
  });
  const rows = [];
  for (const student of classItem.students.values()) {
    let totalScore = 0;
    let zeroCount = 0;
    let plagiarismZeroCount = 0;
    let submitted = 0;
    for (const scoreRow of student.scores.values()) {
      totalScore += scoreRow.score;
      if (!scoreRow.unsubmitted) submitted += 1;
      if (scoreRow.score === 0) zeroCount += 1;
      if (scoreRow.plagiarismZero) plagiarismZeroCount += 1;
    }
    rows.push({
      className: classItem.className,
      name: student.name,
      studentNo: student.studentNo,
      totalScore: round(totalScore, 2),
      averageScore: round(submitted ? totalScore / submitted : 0, 2),
      submitted,
      missing: Math.max(0, assignmentIds.length - submitted),
      zeroCount,
      plagiarismZeroCount,
      scores: Object.fromEntries(assignmentIds.map(id => [id, student.scores.get(id)?.score ?? null])),
    });
  }
  const rankedRows = withRanks(
    rows.sort((a, b) =>
      b.totalScore - a.totalScore
      || b.averageScore - a.averageScore
      || b.submitted - a.submitted
      || a.zeroCount - b.zeroCount
      || compareStudent(a, b)
    ),
    row => row.totalScore,
  );
  const averageTotal = rankedRows.reduce((sum, row) => sum + row.totalScore, 0) / (rankedRows.length || 1);
  const averageScore = rankedRows.reduce((sum, row) => sum + row.averageScore, 0) / (rankedRows.length || 1);
  const summary = {
    className: classItem.className,
    studentCount: rankedRows.length,
    assignmentCount: assignmentIds.length,
    averageTotal: round(averageTotal, 2),
    averageScore: round(averageScore, 2),
    zeroCount: rankedRows.reduce((sum, row) => sum + row.zeroCount, 0),
    plagiarismZeroCount: rankedRows.reduce((sum, row) => sum + row.plagiarismZeroCount, 0),
    assignments: assignmentIds.map(id => ({
      id,
      title: classItem.assignmentTitles.get(id) || id,
    })),
    rows: rankedRows,
  };
  classSummaries.push(summary);
  for (const row of rankedRows) {
    totalCsvRows.push({
      ...row,
      assignmentCount: summary.assignmentCount,
      assignmentScores: summary.assignments
        .map(item => `${item.title}:${row.scores[item.id] == null ? '' : row.scores[item.id]}`)
        .join(' | '),
    });
  }
}

const totals = {
  classes: classSummaries.length,
  assignments: assignmentRecords.length,
  records: assignmentCsvRows.length,
  students: classSummaries.reduce((sum, row) => sum + row.studentCount, 0),
  zeros: assignmentCsvRows.filter(row => row.score === 0).length,
  plagiarismZeros: assignmentCsvRows.filter(row => row.plagiarismZero).length,
  averageScore: round(assignmentCsvRows.reduce((sum, row) => sum + row.score, 0) / (assignmentCsvRows.length || 1), 2),
};

const data = {
  generatedAt,
  totals,
  classSummaries,
  assignmentRankings,
};

await writeFile(jsonPath, JSON.stringify(data, null, 2), 'utf8');
await writeFile(totalCsvPath, toCsv(totalCsvRows, [
  { header: '班级', value: row => row.className },
  { header: '排名', value: row => row.rank },
  { header: '姓名', value: row => row.name },
  { header: '学号', value: row => row.studentNo },
  { header: '总分', value: row => row.totalScore },
  { header: '均分', value: row => row.averageScore },
  { header: '已交作业数', value: row => row.submitted },
  { header: '班级作业数', value: row => row.assignmentCount },
  { header: '缺交数', value: row => row.missing },
  { header: '0分次数', value: row => row.zeroCount },
  { header: '雷同0分次数', value: row => row.plagiarismZeroCount },
  { header: '各作业分数', value: row => row.assignmentScores },
]), 'utf8');
await writeFile(assignmentCsvPath, toCsv(assignmentCsvRows, [
  { header: '作业', value: row => row.assignmentTitle },
  { header: '作业ID', value: row => row.assignmentId },
  { header: '班级', value: row => row.className },
  { header: '排名', value: row => row.rank },
  { header: '姓名', value: row => row.name },
  { header: '学号', value: row => row.studentNo },
  { header: '分数', value: row => row.score },
  { header: '状态', value: row => row.status },
  { header: '雷同0分', value: row => row.plagiarismZero ? '是' : '否' },
  { header: '风险', value: row => row.risk },
  { header: '依据', value: row => row.basis },
  { header: '评语', value: row => row.comment },
  { header: '批阅页', value: row => row.reviewUrl },
]), 'utf8');

const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>班级作业分数排名</title>
  <style>
    :root {
      --bg: #f5f7fa;
      --panel: #ffffff;
      --ink: #1b2430;
      --muted: #647184;
      --line: #d9e0e8;
      --line-strong: #b9c4d0;
      --accent: #1769aa;
      --accent-soft: #e8f2fb;
      --ok: #087443;
      --danger: #b42318;
      --warn: #9a5b00;
      --shadow: 0 1px 2px rgba(27, 36, 48, 0.08);
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      background: var(--bg);
      color: var(--ink);
      font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
      letter-spacing: 0;
    }

    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }

    .topbar {
      position: sticky;
      top: 0;
      z-index: 10;
      background: var(--panel);
      border-bottom: 1px solid var(--line);
      box-shadow: var(--shadow);
      padding: 14px 18px 12px;
    }

    .title-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 12px;
    }

    h1 {
      margin: 0;
      font-size: 20px;
      line-height: 1.25;
    }

    .actions {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px;
    }

    .actions a,
    button,
    select,
    input {
      border: 1px solid var(--line-strong);
      border-radius: 6px;
      background: #fff;
      color: var(--ink);
      min-height: 34px;
      padding: 6px 10px;
      font: inherit;
    }

    .actions a.primary,
    button.active {
      border-color: var(--accent);
      background: var(--accent);
      color: #fff;
    }

    .generated {
      color: var(--muted);
      font-size: 12px;
      white-space: nowrap;
    }

    .summary {
      display: grid;
      grid-template-columns: repeat(7, minmax(92px, 1fr));
      gap: 8px;
    }

    .metric {
      min-height: 58px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #fbfcfd;
      padding: 8px 10px;
    }

    .metric span {
      display: block;
      color: var(--muted);
      font-size: 12px;
    }

    .metric strong {
      display: block;
      margin-top: 2px;
      font-size: 20px;
      line-height: 1.1;
    }

    main {
      width: min(1600px, 100%);
      margin: 0 auto;
      padding: 16px 18px 28px;
    }

    .toolbar {
      display: grid;
      grid-template-columns: minmax(180px, 1fr) minmax(180px, 1fr) minmax(180px, 1fr) auto auto;
      gap: 8px;
      align-items: center;
      margin-bottom: 12px;
    }

    .panel {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
      box-shadow: var(--shadow);
      overflow: hidden;
    }

    .panel-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      border-bottom: 1px solid var(--line);
      padding: 12px 14px;
      background: #fbfcfd;
    }

    .panel-head h2 {
      margin: 0;
      font-size: 16px;
    }

    .panel-head p {
      margin: 2px 0 0;
      color: var(--muted);
      font-size: 12px;
    }

    .table-wrap {
      overflow: auto;
      max-height: calc(100vh - 260px);
    }

    table {
      width: 100%;
      border-collapse: collapse;
      min-width: 860px;
    }

    th,
    td {
      border-bottom: 1px solid var(--line);
      padding: 8px 10px;
      text-align: left;
      vertical-align: top;
    }

    th {
      position: sticky;
      top: 0;
      z-index: 2;
      background: #f0f4f8;
      color: #334155;
      font-size: 12px;
      white-space: nowrap;
    }

    tbody tr:hover { background: #f8fbfd; }
    .num { text-align: right; font-variant-numeric: tabular-nums; }
    .rank { width: 58px; font-weight: 800; }
    .score { display: inline-flex; min-width: 38px; justify-content: center; border-radius: 6px; background: var(--ink); color: #fff; padding: 2px 7px; font-weight: 800; }
    .score.zero { background: var(--danger); }
    .muted { color: var(--muted); }
    .risk { color: var(--danger); font-weight: 700; }
    .ok { color: var(--ok); font-weight: 700; }
    .comment { max-width: 520px; color: #344256; }
    .hidden { display: none; }

    .tabs {
      display: flex;
      gap: 8px;
      margin-bottom: 12px;
    }

    .empty {
      padding: 28px;
      color: var(--muted);
      text-align: center;
    }

    @media (max-width: 900px) {
      .title-row {
        align-items: flex-start;
        flex-direction: column;
      }

      .summary {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }

      .toolbar {
        grid-template-columns: 1fr;
      }

      .generated {
        white-space: normal;
      }
    }
  </style>
</head>
<body>
  <header class="topbar">
    <div class="title-row">
      <div>
        <h1>班级作业分数排名</h1>
        <div class="generated">生成时间：<time id="generatedAt"></time></div>
      </div>
      <nav class="actions" aria-label="页面操作">
        <a href="reports_index.html">报告索引</a>
        <a href="class_total_rankings.csv">总分 CSV</a>
        <a href="assignment_score_rankings.csv">作业排名 CSV</a>
      </nav>
    </div>
    <section class="summary" aria-label="总览">
      <div class="metric"><span>班级</span><strong id="totalClasses">0</strong></div>
      <div class="metric"><span>作业</span><strong id="totalAssignments">0</strong></div>
      <div class="metric"><span>学生</span><strong id="totalStudents">0</strong></div>
      <div class="metric"><span>评分记录</span><strong id="totalRecords">0</strong></div>
      <div class="metric"><span>平均分</span><strong id="averageScore">0</strong></div>
      <div class="metric"><span>0 分记录</span><strong id="totalZeros">0</strong></div>
      <div class="metric"><span>雷同 0 分</span><strong id="plagiarismZeros">0</strong></div>
    </section>
  </header>

  <main>
    <div class="tabs" role="tablist">
      <button id="totalTab" class="active" type="button">班级总分排名</button>
      <button id="assignmentTab" type="button">单次作业排名</button>
    </div>

    <section id="totalView">
      <div class="toolbar">
        <select id="classSelect" aria-label="选择班级"></select>
        <input id="totalSearch" type="search" placeholder="搜索姓名或学号">
        <span></span>
        <span></span>
        <span class="muted">总分按该班已采集作业累加</span>
      </div>
      <div class="panel">
        <div class="panel-head">
          <div>
            <h2 id="classTitle">班级总分排名</h2>
            <p id="classMeta"></p>
          </div>
        </div>
        <div id="totalTable" class="table-wrap"></div>
      </div>
    </section>

    <section id="assignmentView" class="hidden">
      <div class="toolbar">
        <select id="assignmentSelect" aria-label="选择作业"></select>
        <select id="assignmentClassSelect" aria-label="选择班级"></select>
        <input id="assignmentSearch" type="search" placeholder="搜索姓名或学号">
        <a id="assignmentReportLink" href="#" target="_blank" rel="noreferrer">打开该作业报告</a>
        <span class="muted">同分并列排名</span>
      </div>
      <div class="panel">
        <div class="panel-head">
          <div>
            <h2 id="assignmentTitle">单次作业排名</h2>
            <p id="assignmentMeta"></p>
          </div>
        </div>
        <div id="assignmentTable" class="table-wrap"></div>
      </div>
    </section>
  </main>

  <script>
    const data = ${escapeScriptJson(data)};

    const totalTab = document.getElementById('totalTab');
    const assignmentTab = document.getElementById('assignmentTab');
    const totalView = document.getElementById('totalView');
    const assignmentView = document.getElementById('assignmentView');
    const classSelect = document.getElementById('classSelect');
    const totalSearch = document.getElementById('totalSearch');
    const totalTable = document.getElementById('totalTable');
    const assignmentSelect = document.getElementById('assignmentSelect');
    const assignmentClassSelect = document.getElementById('assignmentClassSelect');
    const assignmentSearch = document.getElementById('assignmentSearch');
    const assignmentTable = document.getElementById('assignmentTable');
    const assignmentReportLink = document.getElementById('assignmentReportLink');

    function formatNumber(value) {
      return Number(value || 0).toLocaleString('zh-CN');
    }

    function setText(id, value) {
      document.getElementById(id).textContent = formatNumber(value);
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

    function shortText(value, max = 90) {
      const text = String(value || '').replace(/\\s+/g, ' ').trim();
      return text.length > max ? text.slice(0, max - 1) + '…' : text;
    }

    function scorePill(score) {
      return '<span class="score ' + (Number(score) === 0 ? 'zero' : '') + '">' + esc(score) + '</span>';
    }

    function matches(row, query) {
      if (!query) return true;
      const text = [row.name, row.studentNo].join(' ').toLowerCase();
      return text.includes(query.toLowerCase());
    }

    function renderTotal() {
      const summary = data.classSummaries.find(item => item.className === classSelect.value) || data.classSummaries[0];
      if (!summary) {
        totalTable.innerHTML = '<div class="empty">暂无排名数据</div>';
        return;
      }
      const query = totalSearch.value.trim();
      const rows = summary.rows.filter(row => matches(row, query));
      document.getElementById('classTitle').textContent = summary.className + ' 总分排名';
      document.getElementById('classMeta').textContent =
        '学生 ' + summary.studentCount + ' 人，作业 ' + summary.assignmentCount
        + ' 个，平均总分 ' + summary.averageTotal + '，单项均分 ' + summary.averageScore
        + '，雷同 0 分 ' + summary.plagiarismZeroCount + ' 次。';
      if (!rows.length) {
        totalTable.innerHTML = '<div class="empty">没有匹配的学生</div>';
        return;
      }
      const assignmentHeads = summary.assignments.map(item => '<th class="num">' + esc(item.title.replace(/^作业/, '作业 ')) + '</th>').join('');
      const body = rows.map(row => {
        const scoreCells = summary.assignments.map(item => {
          const score = row.scores[item.id];
          return '<td class="num">' + (score == null ? '<span class="muted">-</span>' : esc(score)) + '</td>';
        }).join('');
        return '<tr>'
          + '<td class="rank">' + esc(row.rank) + '</td>'
          + '<td><strong>' + esc(row.name) + '</strong><br><span class="muted">' + esc(row.studentNo) + '</span></td>'
          + '<td class="num">' + scorePill(row.totalScore) + '</td>'
          + '<td class="num">' + esc(row.averageScore) + '</td>'
          + '<td class="num">' + esc(row.submitted) + '</td>'
          + '<td class="num">' + esc(row.missing) + '</td>'
          + '<td class="num">' + esc(row.zeroCount) + '</td>'
          + '<td class="num">' + esc(row.plagiarismZeroCount) + '</td>'
          + scoreCells
          + '</tr>';
      }).join('');
      totalTable.innerHTML = '<table><thead><tr>'
        + '<th>排名</th><th>学生</th><th class="num">总分</th><th class="num">均分</th><th class="num">已交</th><th class="num">缺交</th><th class="num">0分</th><th class="num">雷同0分</th>'
        + assignmentHeads
        + '</tr></thead><tbody>' + body + '</tbody></table>';
    }

    function selectedAssignment() {
      return data.assignmentRankings.find(item => item.id === assignmentSelect.value) || data.assignmentRankings[0];
    }

    function refreshAssignmentClasses() {
      const assignment = selectedAssignment();
      const previous = assignmentClassSelect.value;
      assignmentClassSelect.textContent = '';
      for (const item of assignment?.classes || []) {
        const option = document.createElement('option');
        option.value = item.className;
        option.textContent = item.className + ' (' + item.count + ')';
        assignmentClassSelect.appendChild(option);
      }
      if ([...assignmentClassSelect.options].some(option => option.value === previous)) {
        assignmentClassSelect.value = previous;
      }
    }

    function renderAssignment() {
      const assignment = selectedAssignment();
      if (!assignment) {
        assignmentTable.innerHTML = '<div class="empty">暂无作业排名数据</div>';
        return;
      }
      if (![...assignmentClassSelect.options].length) refreshAssignmentClasses();
      const classItem = assignment.classes.find(item => item.className === assignmentClassSelect.value) || assignment.classes[0];
      const query = assignmentSearch.value.trim();
      const rows = (classItem?.rows || []).filter(row => matches(row, query));
      document.getElementById('assignmentTitle').textContent = assignment.title;
      document.getElementById('assignmentMeta').textContent =
        (classItem?.className || '') + '，提交 ' + (classItem?.count || 0) + ' 人。';
      assignmentReportLink.href = assignment.reportHref || '#';
      if (!rows.length) {
        assignmentTable.innerHTML = '<div class="empty">没有匹配的学生</div>';
        return;
      }
      const body = rows.map(row => '<tr>'
        + '<td class="rank">' + esc(row.rank) + '</td>'
        + '<td><strong>' + esc(row.name) + '</strong><br><span class="muted">' + esc(row.studentNo) + '</span></td>'
        + '<td class="num">' + scorePill(row.score) + '</td>'
        + '<td>' + esc(row.status) + '</td>'
        + '<td>' + (row.plagiarismZero ? '<span class="risk">是</span>' : '<span class="muted">否</span>') + '</td>'
        + '<td class="risk">' + esc(shortText(row.risk, 48)) + '</td>'
        + '<td class="comment" title="' + esc(row.comment) + '">' + esc(shortText(row.comment, 120)) + '</td>'
        + '<td>' + (row.reviewUrl ? '<a href="' + esc(row.reviewUrl) + '" target="_blank" rel="noreferrer">批阅页</a>' : '') + '</td>'
        + '</tr>').join('');
      assignmentTable.innerHTML = '<table><thead><tr>'
        + '<th>排名</th><th>学生</th><th class="num">分数</th><th>状态</th><th>雷同0分</th><th>风险</th><th>评语</th><th>链接</th>'
        + '</tr></thead><tbody>' + body + '</tbody></table>';
    }

    function showView(name) {
      const total = name === 'total';
      totalView.classList.toggle('hidden', !total);
      assignmentView.classList.toggle('hidden', total);
      totalTab.classList.toggle('active', total);
      assignmentTab.classList.toggle('active', !total);
      history.replaceState(null, '', total ? '#total' : '#assignment');
    }

    document.getElementById('generatedAt').textContent = new Date(data.generatedAt).toLocaleString('zh-CN');
    setText('totalClasses', data.totals.classes);
    setText('totalAssignments', data.totals.assignments);
    setText('totalStudents', data.totals.students);
    setText('totalRecords', data.totals.records);
    setText('averageScore', data.totals.averageScore);
    setText('totalZeros', data.totals.zeros);
    setText('plagiarismZeros', data.totals.plagiarismZeros);

    for (const summary of data.classSummaries) {
      const option = document.createElement('option');
      option.value = summary.className;
      option.textContent = summary.className + ' (' + summary.studentCount + ')';
      classSelect.appendChild(option);
    }
    for (const assignment of data.assignmentRankings) {
      const option = document.createElement('option');
      option.value = assignment.id;
      option.textContent = assignment.title;
      assignmentSelect.appendChild(option);
    }

    totalTab.addEventListener('click', () => showView('total'));
    assignmentTab.addEventListener('click', () => showView('assignment'));
    classSelect.addEventListener('change', renderTotal);
    totalSearch.addEventListener('input', renderTotal);
    assignmentSelect.addEventListener('change', () => {
      refreshAssignmentClasses();
      renderAssignment();
    });
    assignmentClassSelect.addEventListener('change', renderAssignment);
    assignmentSearch.addEventListener('input', renderAssignment);

    refreshAssignmentClasses();
    renderTotal();
    renderAssignment();
    showView(location.hash === '#assignment' ? 'assignment' : 'total');
  </script>
</body>
</html>
`;

await writeFile(htmlPath, html, 'utf8');
console.log(`Wrote ${htmlPath}`);
console.log(`Wrote ${jsonPath}`);
console.log(`Wrote ${totalCsvPath}`);
console.log(`Wrote ${assignmentCsvPath}`);
