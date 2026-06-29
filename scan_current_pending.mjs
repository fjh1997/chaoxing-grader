#!/usr/bin/env node
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { selectedAssignments } from './assignment_manifest.mjs';

const PROXY = process.env.CDP_PROXY_URL || 'http://localhost:3456';
const BASE = 'https://mooc2-ans.chaoxing.com';
const args = parseArgs(process.argv.slice(2));
const assignments = selectedAssignments(args._);
const pageSize = Number(args['page-size'] || 200);
const outJson = args.out || 'current_pending_scan.json';
const outCsv = args.csv || outJson.replace(/\.json$/i, '.csv');

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

async function cdp(pathname, body) {
  const options = body == null
    ? {}
    : { method: 'POST', body: String(body), headers: { 'content-type': 'text/plain;charset=utf-8' } };
  const res = await fetch(`${PROXY}${pathname}`, options);
  const text = await res.text();
  if (!res.ok) throw new Error(`CDP ${pathname} failed: ${res.status} ${text.slice(0, 500)}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function newTab(url) {
  const attempts = Number(process.env.CDP_NEW_TAB_RETRIES || 4);
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
  } catch {}
}

async function evalIn(target, fn, ...fnArgs) {
  const expression = `(${fn})(...${JSON.stringify(fnArgs)})`;
  const attempts = Number(process.env.CDP_EVAL_RETRIES || 4);
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const result = await cdp(`/eval?target=${encodeURIComponent(target)}`, expression);
      if (result?.error) throw new Error(result.error);
      return result?.value;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(1500 * attempt);
    }
  }
  throw lastError;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function absUrl(urlOrPath) {
  return new URL(urlOrPath, BASE).toString();
}

async function knownIds(runDir) {
  const ids = new Set();
  const students = await readJson(path.join(runDir, 'students.json'), []);
  if (Array.isArray(students)) {
    for (const row of students) {
      if (row?.workAnswerId) ids.add(String(row.workAnswerId));
    }
  }
  return ids;
}

async function scanOne(item) {
  const runDir = path.resolve(item.runDir);
  const localIds = await knownIds(runDir);
  const target = await newTab(item.url);
  try {
    await sleep(Number(args.wait || 1200));
    const meta = await evalIn(target, browserMarkMeta);
    const rows = [];
    for (const cls of meta.classes) {
      const clsRows = await evalIn(target, browserCollectRows, {
        courseId: meta.courseId,
        classId: cls.classId,
        workId: cls.workId,
        cpi: meta.cpi,
        evaluation: meta.evaluation || '0',
        from: meta.from || '',
        topicid: meta.topicid || '0',
        pageSize,
      });
      for (const row of clsRows) {
        const statusText = `${row.status || ''} ${row.actionText || ''} ${row.grader || ''}`.trim();
        const pending = /待批阅|重做待批阅|批阅/.test(statusText) && !/已完成|已批|查看/.test(statusText);
        rows.push({
          ...row,
          assignmentKey: item.key,
          assignmentTitle: item.title,
          runDir: item.runDir,
          className: cls.name,
          classId: cls.classId,
          classWorkId: cls.workId,
          pending,
          locallyKnown: localIds.has(String(row.workAnswerId)),
          newLocalId: !localIds.has(String(row.workAnswerId)),
          reviewUrl: row.reviewUrl ? absUrl(row.reviewUrl) : '',
        });
      }
    }
    return {
      key: item.key,
      title: item.title,
      runDir: item.runDir,
      totalSubmitted: rows.length,
      currentPending: rows.filter(row => row.pending).length,
      newPending: rows.filter(row => row.pending && row.newLocalId).length,
      knownPending: rows.filter(row => row.pending && row.locallyKnown).length,
      rows,
      error: '',
    };
  } catch (error) {
    return {
      key: item.key,
      title: item.title,
      runDir: item.runDir,
      totalSubmitted: 0,
      currentPending: 0,
      newPending: 0,
      knownPending: 0,
      rows: [],
      error: String(error?.message || error),
    };
  } finally {
    await closeTab(target);
  }
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
    cpi: document.querySelector('#cpi')?.value || '',
    evaluation: document.querySelector('#evaluation')?.value || '0',
    from: document.querySelector('#from')?.value || '',
    topicid: document.querySelector('#topicid')?.value || '0',
    classes,
  };
}

async function browserCollectRows(params) {
  const rows = [];
  let page = 1;
  let totalPage = 1;
  do {
    const query = new URLSearchParams({
      courseid: params.courseId,
      clazzid: params.classId,
      workid: params.workId,
      submit: 'true',
      status: '0',
      groupId: '0',
      cpi: params.cpi,
      evaluation: params.evaluation || '0',
      sort: '0',
      order: '0',
      unEval: 'false',
      search: '',
      from: params.from || '',
      topicid: params.topicid || '0',
      pages: String(page),
      size: String(params.pageSize || 200),
    });
    const html = await fetch('/mooc2-ans/work/mark-list?' + query, { credentials: 'include' }).then(r => r.text());
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const pageRows = [...doc.querySelectorAll('ul.dataBody_td')].map(ul => {
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
    }).filter(row => row.workAnswerId);
    rows.push(...pageRows);
    const totalText = doc.querySelector('.pageDiv, .pageInfo, .totalPage')?.innerText || '';
    const totalMatch = totalText.match(/共\s*(\d+)\s*页|\/\s*(\d+)/);
    totalPage = Number(totalMatch?.[1] || totalMatch?.[2] || 1) || 1;
    page++;
  } while (page <= totalPage);
  return rows;
}

const results = [];
for (const item of assignments) {
  console.log(`Scanning ${item.title}`);
  const result = await scanOne(item);
  results.push(result);
  const marker = result.error ? 'fail' : 'ok';
  console.log(`${marker}\t${item.key}\tsubmitted=${result.totalSubmitted}\tpending=${result.currentPending}\tnewPending=${result.newPending}${result.error ? `\t${result.error}` : ''}`);
  await sleep(Number(args.delay || 300));
}

const flatRows = results.flatMap(result => result.rows);
const pendingRows = flatRows.filter(row => row.pending);
const newPendingRows = pendingRows.filter(row => row.newLocalId);

await writeFile(outJson, JSON.stringify({
  generatedAt: new Date().toISOString(),
  totals: {
    assignments: results.length,
    submittedRows: flatRows.length,
    currentPendingRows: pendingRows.length,
    newPendingRows: newPendingRows.length,
  },
  results,
  pendingRows,
  newPendingRows,
}, null, 2), 'utf8');
await writeFile(outCsv, toCsv(pendingRows, [
  'assignmentKey', 'assignmentTitle', 'runDir', 'className', 'name', 'studentNo', 'workAnswerId',
  'submitTime', 'ip', 'status', 'grader', 'existingScore', 'actionText', 'locallyKnown', 'newLocalId', 'reviewUrl',
]), 'utf8');

console.log(`Wrote ${outJson}`);
console.log(`Wrote ${outCsv}`);
console.log(`Current pending rows: ${pendingRows.length}; new local ids: ${newPendingRows.length}`);
if (results.some(result => result.error)) process.exitCode = 1;
