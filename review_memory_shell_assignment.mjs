#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const args = parseArgs(process.argv.slice(2));
const runDir = path.resolve(args.run || 'runs/memory-shell-assignment');
const endpoint = (args.endpoint || process.env.MIMO_ENDPOINT || 'https://api.openai.com/v1').replace(/\/$/, '');
const model = args.model || process.env.MIMO_MODEL || 'mimo-v2.5';
const apiKey = process.env.MIMO_API_KEY || args.key || '';
const outDir = path.join(runDir, 'memory_shell_review');
const forceReview = Boolean(args.force || args['force-review']);
const forceOcr = Boolean(args['force-ocr']);
const limit = args.limit ? Number(args.limit) : Infinity;
const onlyIds = new Set(String(args['work-answer-ids'] || '').split(/[,;\s]+/).map(s => s.trim()).filter(Boolean));
const delayMs = Number(args.delay || process.env.MIMO_DELAY_MS || 900);
const tesseractExe = args.tesseract || process.env.TESSERACT_EXE || '/mnt/c/Program Files/Tesseract-OCR/tesseract.exe';

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

async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
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

function slug(value, fallback = 'item') {
  const s = String(value || '')
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 120);
  return s || fallback;
}

function csvEscape(value) {
  const s = value == null ? '' : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows, cols) {
  return [
    cols.map(csvEscape).join(','),
    ...rows.map(row => cols.map(col => csvEscape(row[col])).join(',')),
  ].join('\n') + '\n';
}

function mimeFromFile(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  return 'image/png';
}

function isLikelyStudentAnswerImage(asset) {
  const bytes = Number(asset?.bytes || 0);
  const file = String(asset?.file || '').toLowerCase();
  if (!asset?.ok || !asset?.file) return false;
  if (/(?:^|[/_-])(avatar|head|icon|logo|button|btn|emoji|face|loading|blank|default|popclose|rotate|revoke|eidt)(?:[/_.-]|$)/i.test(file)) return false;
  if (bytes > 0 && bytes < 5000) return false;
  return true;
}

function selectAssets(submission) {
  const assets = Array.isArray(submission.assets) ? submission.assets : [];
  const rawAssets = Array.isArray(submission.rawAssets) ? submission.rawAssets : [];
  const preferred = assets.some(isLikelyStudentAnswerImage) ? assets : rawAssets;
  const out = [];
  const seen = new Set();
  for (const asset of preferred) {
    if (!isLikelyStudentAnswerImage(asset)) continue;
    const key = asset.file || asset.src;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(asset);
  }
  return out;
}

async function prepareImage(file) {
  const maxBytes = Number(process.env.MIMO_IMAGE_MAX_BYTES || 900000);
  const maxSide = Number(process.env.MIMO_IMAGE_MAX_SIDE || 1800);
  const quality = Number(process.env.MIMO_JPEG_QUALITY || 82);
  const st = await stat(file);
  if (st.size <= maxBytes || process.env.MIMO_NO_COMPRESS === '1') {
    return { file, mime: mimeFromFile(file) };
  }
  const cacheDir = path.join(runDir, '.mimo_image_cache_memory_shell');
  await mkdir(cacheDir, { recursive: true });
  const out = path.join(cacheDir, `${slug(path.relative(runDir, file))}_${maxSide}_${quality}.jpg`);
  if (!await exists(out)) {
    execFileSync('convert', [
      file,
      '-auto-orient',
      '-resize', `${maxSide}x${maxSide}>`,
      '-strip',
      '-quality', String(quality),
      out,
    ], { timeout: 120000 });
  }
  return { file: out, mime: 'image/jpeg' };
}

function toWindowsPath(file) {
  const resolved = path.resolve(file);
  const match = resolved.match(/^\/mnt\/([a-z])\/(.*)$/i);
  if (!match) return resolved;
  return `${match[1].toUpperCase()}:\\${match[2].split('/').join('\\')}`;
}

async function ocrAsset(asset) {
  const ocrDir = path.join(runDir, 'memory_shell_ocr');
  await mkdir(ocrDir, { recursive: true });
  const key = slug(asset.sha256 || asset.file);
  const outFile = path.join(ocrDir, `${key}.txt`);
  if (!forceOcr && await exists(outFile)) return readFile(outFile, 'utf8');

  const src = path.resolve(runDir, asset.file);
  const tmpDir = '/mnt/c/Temp/cx_ocr';
  await mkdir(tmpDir, { recursive: true });
  const tmp = path.join(tmpDir, `${key}.png`);
  try {
    execFileSync('convert', [
      src,
      '-auto-orient',
      '-resize', '220%',
      '-colorspace', 'Gray',
      '-sharpen', '0x1',
      tmp,
    ], { timeout: 120000 });
  } catch {
    await copyFile(src, tmp);
  }
  const winPath = toWindowsPath(tmp);
  const outputs = [];
  for (const psm of ['6', '11']) {
    try {
      outputs.push(execFileSync(tesseractExe, [
        winPath,
        'stdout',
        '-l', 'eng',
        '--psm', psm,
      ], {
        encoding: 'utf8',
        timeout: 120000,
        stdio: ['ignore', 'pipe', 'pipe'],
      }));
    } catch (error) {
      outputs.push(String(error?.stderr || error?.message || error));
    }
  }
  const text = outputs.join('\n\n');
  await writeFile(outFile, text, 'utf8');
  return text;
}

function normalizeOcr(text) {
  return String(text || '')
    .replace(/[\\｜]/g, '/')
    .replace(/[‘’`]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[：]/g, ':')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function isStrongShellPiece(value, submission = {}) {
  const v = normalizeOcr(value)
    .replace(/^https?:\s*\//, 'http://')
    .replace(/\s+/g, '')
    .replace(/[),.;，。；]+$/g, '');
  if (!v) return false;
  const studentNo = String(submission.studentNo || '');
  const hasPathContext = /https?:|(?:\d{1,3}\.){3}:\d+|localhost:\d+|\/examonline\//i.test(v);
  const tail = (v.split('/examonline/').pop() || v).replace(/[?#].*$/, '').replace(/^\/+|\/+$/g, '');
  const bareTail = tail.replace(/\.(?:jsp|jspx|txt|do|action|tet|ixt)$/i, '');
  const weakBare = /^(?:shell|shel1|sh3ll|shell\.jsp|hack|hacks|hack1234|dsb|wx|exam|style|2026|38)$/i;
  if (weakBare.test(tail) || weakBare.test(bareTail)) return false;
  if (studentNo && v.includes(studentNo)) return true;
  if (studentNo && studentNo.length >= 2) {
    const last2 = studentNo.slice(-2).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(?:shell|shel1|sh3ll|hack|memshell|filter)[_.-]?${last2}(?:\\D|$)`, 'i').test(v)) return true;
  }
  if (/(?:shell|shel1|sh3ll|memshell|behinderfilter|filter)[\w.-]{2,}(?:\.(?:jsp|jspx|txt|do|action|tet|ixt))?/i.test(v)) return true;
  if (hasPathContext && /\/examonline\/[a-z][a-z0-9_-]{3,}(?:\.(?:jsp|jspx|txt|do|action|tet|ixt))?/i.test(v)) return true;
  return false;
}

function classifyShellPieces(pieces, submission = {}) {
  const strong = [];
  const weak = [];
  for (const piece of pieces) {
    if (isStrongShellPiece(piece, submission)) strong.push(piece);
    else weak.push(piece);
  }
  return {
    strongShellUrlOrPath: strong.join('; '),
    weakShellUrlOrPath: weak.join('; '),
    visibleStrongShellPath: strong.length > 0,
  };
}

function extractShellEvidence(rawText, submission = {}) {
  const text = normalizeOcr(rawText)
    .replace(/h\s*t\s*t\s*p\s*s?\s*:/g, 'http:')
    .replace(/htps:/g, 'https:')
    .replace(/httos:/g, 'https:')
    .replace(/hittp:/g, 'http:');
  const shellPieces = [];
  const patterns = [
    /https?:\s*\/{0,2}[^\s'"<>，。；]+/gi,
    /(?:(?:\d{1,3}\.){3}\d{1,3}:\d{2,5}|localhost:\d{2,5})[^\s'"<>，。；]*/gi,
    /\/(?:examonline|sqli|upload|session|phoneshop|campusbbs)\/[^\s'"<>，。；]*/gi,
    /\b(?:shell|shel1|sh3ll|hack|dsb|memshell|behinderfilter)[\w.-]*(?:\.(?:jsp|jspx|txt|do|action))?\b/gi,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const value = match[0].replace(/\s+/g, '');
      if (!value) continue;
      if (/apache|tomcat-|java\.oracle|closer\.cgi|tar\.gz|register\.html|login\.html|web-inf|meta-inf|\/css\b/.test(value)) continue;
      if (/(?:shell|shel1|sh3ll|hack|dsb|memshell|behinderfilter|\.jsp|\.jspx|\.txt|\/examonline\/[a-z0-9_-]{2,})/i.test(value)) {
        shellPieces.push(value);
      }
    }
  }
  const unique = [...new Set(shellPieces)].slice(0, 8);
  const classified = classifyShellPieces(unique, submission);
  return {
    shellUrlOrPath: unique.join('; '),
    visibleShellUrl: unique.some(value => /https?:|(?:\d{1,3}\.){3}\d{1,3}:\d{2,5}|localhost:\d{2,5}/i.test(value)),
    visibleShellPath: unique.length > 0,
    ...classified,
  };
}

async function reviewByOcrRules(submission, assets) {
  const perImage = [];
  for (const asset of assets) {
    const text = await ocrAsset(asset);
    perImage.push({ file: asset.file, text });
  }
  const rawText = perImage.map(row => `### ${row.file}\n${row.text}`).join('\n\n');
  const text = normalizeOcr(rawText);
  const shell = extractShellEvidence(rawText, submission);
  const hasBehinderConnection = /java_home|catalina_home|gpg_keys|java\.runtime\.name|java\.vm|tomcat_native|pwd\s*=|\/usr\/local\/tomcat|behinder|rebeyond|\bok\b.*connect|connection.*success|environment variable|basic info/.test(text);
  const hasPayloadGeneration = /ysuserial|ysoserial|commonscollections|commonsbeanutils|java\s+-jar|generatepayload|payload|behinderfilter|memshell|transformer|base64\s*(?:encode|payload|字符串|编码)/.test(text);
  const hasTriggerEvidence = /examprogress|saveprogress|progress(?:id|=|\/|\b)|objectinputstream|readobject|burp|repeater|curl|post\s+\/(?:examonline|[^\s]+)|反序列化|触发|提交/.test(text);
  const hasInjectionEvidence = /(?:behinderfilter|memshell|内存马|defineclass|classloader|inject|injection|addfilter|filterdef|filtermap|standardcontext|applicationfilterconfig).{0,120}(?:success|ok|registered|loaded|added|注入成功|添加成功|成功)/.test(text)
    || /(?:success|ok|registered|loaded|added|注入成功|添加成功|成功).{0,120}(?:behinderfilter|memshell|内存马|defineclass|classloader|inject|injection|addfilter|filterdef|filtermap|standardcontext|applicationfilterconfig)/.test(text);
  const onlyBehinderEnv = hasBehinderConnection && !shell.visibleStrongShellPath && !hasPayloadGeneration && !hasTriggerEvidence && !hasInjectionEvidence;
  const hasStrongShellPath = shell.visibleStrongShellPath;

  let score;
  if (assets.length === 0) {
    score = 0;
  } else if (hasStrongShellPath && hasBehinderConnection && hasPayloadGeneration && hasTriggerEvidence && hasInjectionEvidence) {
    score = assets.length >= 4 ? 95 : 90;
  } else if (hasStrongShellPath && hasBehinderConnection && hasPayloadGeneration && (hasTriggerEvidence || hasInjectionEvidence)) {
    score = assets.length >= 4 ? 90 : 85;
  } else if (hasStrongShellPath && hasBehinderConnection && (hasTriggerEvidence || hasInjectionEvidence || hasPayloadGeneration)) {
    score = 75;
  } else if (hasStrongShellPath && hasBehinderConnection) {
    score = 65;
  } else if (hasStrongShellPath && hasPayloadGeneration && (hasTriggerEvidence || hasInjectionEvidence)) {
    score = 65;
  } else if (hasStrongShellPath && (hasPayloadGeneration || hasTriggerEvidence || hasInjectionEvidence)) {
    score = 55;
  } else if (hasPayloadGeneration && (hasTriggerEvidence || hasInjectionEvidence)) {
    score = 55;
  } else if (hasPayloadGeneration || hasTriggerEvidence) {
    score = 45;
  } else if (hasBehinderConnection) {
    score = 45;
  } else {
    score = 30;
  }

  const missing = [];
  if (!hasStrongShellPath) missing.push('本次内存马 URL/路径（需可见且可区分本次作业）');
  if (!hasPayloadGeneration) missing.push('ysuserial/payload 生成证据');
  if (!hasTriggerEvidence) missing.push('反序列化触发或 progress 提交证据');
  if (!hasInjectionEvidence) missing.push('内存马注入成功证据');
  if (!hasBehinderConnection) missing.push('冰蝎连接成功或控制结果');

  const summary = hasStrongShellPath
    ? `OCR 检出可区分本次作业的木马 URL/路径：${shell.strongShellUrlOrPath || shell.shellUrlOrPath}。`
    : shell.visibleShellPath
    ? `OCR 只检出弱路径或通用标识：${shell.weakShellUrlOrPath || shell.shellUrlOrPath}，不足以证明是本次作业的内存马。`
    : hasBehinderConnection
    ? 'OCR 只检出冰蝎/服务器环境信息或目录信息，未检出本次内存马 URL/路径。'
    : 'OCR 未检出可证明内存马连接成功的关键证据。';
  const comment = score >= 85
    ? '截图能看到本次内存马 URL/路径，并能结合 payload、触发或注入过程证明实验链路，按较完整完成处理。'
    : score >= 65
    ? '截图能看到部分关键证据，但 payload 生成、反序列化触发、内存马注入或冰蝎连接链路不完整，不能按高分处理。'
    : hasBehinderConnection
    ? '截图主要是冰蝎界面、服务器环境变量或目录信息，未显示本次作业对应的内存马 URL/路径，无法判断是否连接的是本次注入的内存马，不能给高分。'
    : '未见能够证明本次内存马注入和冰蝎连接成功的有效截图，按低分处理。';

  return {
    workAnswerId: String(submission.workAnswerId),
    className: submission.className,
    name: submission.name,
    studentNo: submission.studentNo,
    model: 'local-ocr-memory-shell-rubric',
    score,
    contentScore: Math.round(score * 0.4),
    evidenceScore: Math.round(score * 0.4),
    layoutScore: Math.max(0, score - Math.round(score * 0.4) - Math.round(score * 0.4)),
    risk: 'memory-shell-url-path-review',
    summary,
    missing,
    comment,
    extractedText: rawText.slice(0, 6000),
    visibleShellUrl: shell.visibleShellUrl,
    visibleShellPath: shell.visibleShellPath,
    visibleStrongShellPath: shell.visibleStrongShellPath,
    shellUrlOrPath: shell.shellUrlOrPath,
    strongShellUrlOrPath: shell.strongShellUrlOrPath,
    weakShellUrlOrPath: shell.weakShellUrlOrPath,
    hasPayloadGeneration,
    hasTriggerEvidence,
    hasInjectionEvidence,
    hasBehinderConnection,
    onlyBehinderEnv,
    usedImages: assets.map(asset => asset.file),
  };
}

function parseJsonObject(text) {
  const s = String(text || '').trim();
  try { return JSON.parse(s); } catch {}
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

function clampScore(value, max = 100) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(max, Math.round(n)));
}

function normalizeReview(value, submission, assets) {
  const v = value && typeof value === 'object' ? value : {};
  const visibleShellUrl = Boolean(v.visibleShellUrl);
  const visibleShellPath = Boolean(v.visibleShellPath);
  const shellUrlOrPath = String(v.shellUrlOrPath || '').slice(0, 500);
  const pieces = shellUrlOrPath.split(/\s*;\s*|\n+/).map(s => s.trim()).filter(Boolean);
  const shellClass = classifyShellPieces(pieces, submission);
  const visibleStrongShellPath = Boolean(v.visibleStrongShellPath) || shellClass.visibleStrongShellPath;
  const hasInjectionEvidence = Boolean(v.hasInjectionEvidence);
  const hasPayloadGeneration = Boolean(v.hasPayloadGeneration);
  const hasTriggerEvidence = Boolean(v.hasTriggerEvidence);
  const hasBehinderConnection = Boolean(v.hasBehinderConnection);
  const onlyBehinderEnv = Boolean(v.onlyBehinderEnv);
  let score = clampScore(v.score);

  // Hard guardrail: a Behinder environment page without visible URL/path cannot be high score.
  if (hasBehinderConnection && !visibleStrongShellPath && !hasInjectionEvidence && !hasTriggerEvidence) {
    score = Math.min(score || 0, 45);
  } else if (hasBehinderConnection && !visibleStrongShellPath) {
    score = Math.min(score || 0, 60);
  } else if (visibleStrongShellPath && hasBehinderConnection && !hasInjectionEvidence && !hasTriggerEvidence) {
    score = Math.min(score || 0, 65);
  } else if (visibleStrongShellPath && hasBehinderConnection && (hasInjectionEvidence || hasTriggerEvidence)) {
    score = score || 85;
  } else if (assets.length === 0) {
    score = 0;
  } else if (!score) {
    score = assets.length >= 3 ? 70 : assets.length === 2 ? 55 : 40;
  }

  const missing = Array.isArray(v.missing) ? v.missing.map(String).slice(0, 12) : [];
  if (!visibleStrongShellPath && !missing.some(x => /URL|路径|木马/.test(x))) {
    missing.push('本次内存马 URL/路径（需可见且可区分本次作业）');
  }
  if (!hasInjectionEvidence && !missing.some(x => /注入|payload|触发|反序列化/.test(x))) {
    missing.push('payload 生成、反序列化触发或内存马注入过程');
  }

  const contentScore = clampScore(v.contentScore ?? Math.round(score * 0.4), 40);
  const evidenceScore = clampScore(v.evidenceScore ?? Math.round(score * 0.4), 40);
  const layoutScore = clampScore(v.layoutScore ?? Math.round(score * 0.2), 20);
  const comment = String(v.comment || '').trim()
    || (score >= 85
      ? '能够看到本次内存马连接 URL/路径，并有注入或触发过程证据，实验链路基本成立。'
      : score >= 60
      ? '能看到部分内存马或冰蝎连接证据，但关键链路不完整。'
      : '截图无法证明本次作业对应的内存马注入与连接成功，不能仅凭冰蝎界面或环境变量给高分。');

  return {
    workAnswerId: String(submission.workAnswerId),
    className: submission.className,
    name: submission.name,
    studentNo: submission.studentNo,
    model: 'mimo-memory-shell-rubric',
    score,
    contentScore,
    evidenceScore,
    layoutScore,
    risk: 'memory-shell-url-path-review',
    summary: String(v.summary || '').slice(0, 1000),
    missing,
    comment,
    extractedText: String(v.extractedText || '').slice(0, 6000),
    visibleShellUrl,
    visibleShellPath,
    visibleStrongShellPath,
    shellUrlOrPath,
    strongShellUrlOrPath: shellClass.strongShellUrlOrPath,
    weakShellUrlOrPath: shellClass.weakShellUrlOrPath,
    hasPayloadGeneration,
    hasTriggerEvidence,
    hasInjectionEvidence,
    hasBehinderConnection,
    onlyBehinderEnv,
    usedImages: assets.map(asset => asset.file),
  };
}

async function callMimo(submission, assets) {
  if (!apiKey) throw new Error('MIMO_API_KEY is not set');
  const imageParts = [];
  for (const asset of assets.slice(0, Number(args['max-images'] || process.env.MIMO_MAX_IMAGES || 8))) {
    const prepared = await prepareImage(path.resolve(runDir, asset.file));
    const data = await readFile(prepared.file);
    imageParts.push({ type: 'text', text: `图片文件：${asset.file}` });
    imageParts.push({
      type: 'image_url',
      image_url: { url: `data:${prepared.mime};base64,${data.toString('base64')}` },
    });
  }
  const prompt = [
    '你是信息安全代码审计课程助教，请严格批改“作业九 内存马与代码注入审计”。',
    '实验目标：审计青云在线考试系统的反序列化漏洞，生成 ysuserial/CommonsCollections payload，注入 Tomcat Filter 内存马，然后用冰蝎 Behinder 连接该内存马控制服务器。',
    '关键判分规则：',
    '1. 不能只因为看到冰蝎/Behinder 界面、环境变量、JRE 系统属性、文件管理列表就给高分。',
    '2. 必须能看到本次作业对应的内存马 URL 或路径，例如 examonline 下的具体 shell/filter 路径、冰蝎连接栏 URL、请求路径、Filter 路径，或等价可核验证据。',
    '3. 每次作业的 URL/路径不同。如果截图没有显示 URL/路径，无法判断是不是这次作业的内存马，最高只能按低分/部分证据处理。',
    '4. 高分必须能串起：payload 生成或关键参数、反序列化触发/提交 progress、内存马注入成功、冰蝎连接到同一 URL/路径。',
    '5. 如果只有冰蝎基本信息/环境变量输出但没有连接 URL/路径，也没有注入过程，最高 45 分。',
    '6. 如果有冰蝎连接且可见 URL/路径，但缺少 payload 生成/触发/注入过程，最高 65 分。',
    '7. 如果有可见 URL/路径，并能看到注入/触发过程或 payload 生成，通常 80-95；链路完整、截图清晰可 95-100。',
    '8. 如果只是文件马目录、Tomcat 目录、工具界面或无关文字，按 0-45。',
    '请只返回严格 JSON，不要 Markdown。字段：score(0-100), contentScore(0-40), evidenceScore(0-40), layoutScore(0-20), visibleShellUrl(boolean), visibleShellPath(boolean), shellUrlOrPath(string), hasPayloadGeneration(boolean), hasTriggerEvidence(boolean), hasInjectionEvidence(boolean), hasBehinderConnection(boolean), onlyBehinderEnv(boolean), summary, missing(array), extractedText, comment。',
    `学生：${submission.className} ${submission.name} ${submission.studentNo}，提交时间：${submission.submitTime || ''}`,
  ].join('\n');
  const body = {
    model,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, ...imageParts] }],
    temperature: 0.05,
  };
  const retries = Number(process.env.MIMO_RETRIES || args.retries || 4);
  let lastText = '';
  for (let attempt = 0; attempt <= retries; attempt++) {
    let res;
    try {
      res = await fetch(`${endpoint}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(Number(process.env.MIMO_TIMEOUT_MS || args.timeout || 120000)),
      });
      lastText = await res.text();
    } catch (error) {
      lastText = String(error?.message || error);
      if (attempt >= retries) throw error;
      const wait = Math.min(120000, 5000 * (2 ** Math.min(attempt, 5)) + Math.floor(Math.random() * 1000));
      console.log(`  retry ${attempt + 1}/${retries} after ${wait}ms: ${submission.name} ${lastText.slice(0, 120)}`);
      await sleep(wait);
      continue;
    }
    if (res.ok) {
      const response = parseJsonObject(lastText);
      const content = response?.choices?.[0]?.message?.content || response?.output_text || lastText;
      const parsed = parseJsonObject(content);
      const normalized = normalizeReview(parsed, submission, assets);
      normalized.rawText = String(content).slice(0, 6000);
      return normalized;
    }
    if (!(res.status === 429 || res.status >= 500) || attempt >= retries) {
      throw new Error(`Mimo HTTP ${res.status}: ${lastText.slice(0, 500)}`);
    }
    const wait = Math.min(120000, 5000 * (2 ** Math.min(attempt, 5)) + Math.floor(Math.random() * 1000));
    console.log(`  retry ${attempt + 1}/${retries} after ${wait}ms: ${submission.name} HTTP ${res.status}`);
    await sleep(wait);
  }
  throw new Error(`Mimo failed: ${lastText.slice(0, 500)}`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  const submissionsDir = path.join(runDir, 'submissions');
  const submissions = [];
  for (const file of (await readdir(submissionsDir)).filter(name => name.endsWith('.json')).sort()) {
    const sub = await readJson(path.join(submissionsDir, file), null);
    if (sub?.workAnswerId) submissions.push(sub);
  }
  const draftRows = await readJson(path.join(runDir, 'grading_draft_submit_early_bonus.json'), [])
    || await readJson(path.join(runDir, 'grading_draft.json'), []);
  const draftById = new Map((Array.isArray(draftRows) ? draftRows : []).map(row => [String(row.workAnswerId), row]));
  const selected = submissions
    .filter(sub => !onlyIds.size || onlyIds.has(String(sub.workAnswerId)))
    .filter(sub => {
      if (args['all']) return true;
      const row = draftById.get(String(sub.workAnswerId));
      return Number(row?.earlyBonusBaseScore ?? row?.draftScore ?? 0) >= Number(args['min-current-score'] || 60);
    })
    .slice(0, limit);

  await mkdir(outDir, { recursive: true });
  const results = [];
  for (const [index, sub] of selected.entries()) {
    const assets = selectAssets(sub);
    const outFile = path.join(outDir, `${slug(sub.className)}_${slug(sub.studentNo)}_${slug(sub.name)}_${sub.workAnswerId}.json`);
    if (!forceReview && await exists(outFile)) {
      const cached = await readJson(outFile, null);
      if (cached) {
        results.push(cached);
        console.log(`[${index + 1}/${selected.length}] cached ${sub.className} ${sub.name} ${cached.score}`);
        continue;
      }
    }
    console.log(`[${index + 1}/${selected.length}] review ${sub.className} ${sub.name} ${sub.studentNo} images=${assets.length}`);
    const result = args['rules-only']
      ? await reviewByOcrRules(sub, assets)
      : await callMimo(sub, assets);
    await writeFile(outFile, JSON.stringify(result, null, 2), 'utf8');
    results.push(result);
    await sleep(delayMs);
  }

  const overrides = results.map(row => ({
    workAnswerId: row.workAnswerId,
    className: row.className,
    name: row.name,
    studentNo: row.studentNo,
    model: row.model,
    score: row.score,
    contentScore: row.contentScore,
    evidenceScore: row.evidenceScore,
    layoutScore: row.layoutScore,
    risk: row.risk,
    summary: row.summary,
    missing: row.missing,
    comment: row.comment,
    extractedText: row.extractedText,
    usedImages: row.usedImages,
    visibleShellUrl: row.visibleShellUrl,
    visibleShellPath: row.visibleShellPath,
    visibleStrongShellPath: row.visibleStrongShellPath,
    shellUrlOrPath: row.shellUrlOrPath,
    strongShellUrlOrPath: row.strongShellUrlOrPath,
    weakShellUrlOrPath: row.weakShellUrlOrPath,
    hasPayloadGeneration: row.hasPayloadGeneration,
    hasTriggerEvidence: row.hasTriggerEvidence,
    hasInjectionEvidence: row.hasInjectionEvidence,
    hasBehinderConnection: row.hasBehinderConnection,
    onlyBehinderEnv: row.onlyBehinderEnv,
  }));
  await writeFile(path.join(runDir, 'memory_shell_review_overrides.json'), JSON.stringify(overrides, null, 2), 'utf8');
  await writeFile(path.join(runDir, 'memory_shell_review_summary.csv'), toCsv(results, [
    'className', 'name', 'studentNo', 'workAnswerId', 'score',
    'visibleShellUrl', 'visibleShellPath', 'visibleStrongShellPath',
    'shellUrlOrPath', 'strongShellUrlOrPath', 'weakShellUrlOrPath',
    'hasPayloadGeneration', 'hasTriggerEvidence', 'hasInjectionEvidence',
    'hasBehinderConnection', 'onlyBehinderEnv', 'summary', 'missing', 'comment',
  ]), 'utf8');
  console.log(`Wrote ${path.join(runDir, 'memory_shell_review_overrides.json')}`);
  console.log(`Wrote ${path.join(runDir, 'memory_shell_review_summary.csv')}`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
