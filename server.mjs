#!/usr/bin/env node
// AI 팀 사무실 (로컬 앱) — 대표 맥에서만 도는 서버.
// runs/를 직접 읽어 하네스 진행을 보여주고, 버튼을 누르면 Claude Code를 뒤에서 실행해요(claude -p).
// 훅·verify.mjs·에이전트 설정은 Claude Code가 그대로 적용해요. 승인 버튼만 Claude를 거치지 않고
// 대표가 누른 순간 harness/scripts/approve.mjs를 바로 실행해요.
import http from 'node:http';
import { readFileSync, readdirSync, statSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { join, resolve, dirname, relative, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RUNS = join(ROOT, 'runs');
const PUBLIC = join(ROOT, 'office-app', 'public');
const LOGS = join(ROOT, 'office-app', 'logs');
const PORT = Number(process.env.OFFICE_PORT) || 4777;
const CLAUDE = process.env.CLAUDE_BIN || 'claude';
// Finder에서 켜면 PATH가 짧아서, 훅이 쓰는 node와 claude를 찾을 수 있게 넣어 줘요
const PATH = [dirname(process.execPath), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', process.env.PATH].filter(Boolean).join(':');
// 다른 웹사이트가 이 서버에 요청을 보내지 못하게, 페이지에 심은 토큰이 있어야 버튼 요청을 받아요
const TOKEN = randomBytes(16).toString('hex');
const SLUG = /^[\w-]+$/;
const SCREENS = ['홈', '기록하기', '내역', '통계', '예산·설정', '아직 미정'];
// harness/rules.yaml screens와 같은 이름 (slug = 날짜-파일이름)
const SCREEN_KEYS = { '홈': 'home', '기록하기': 'record', '내역': 'history', '통계': 'stats', '예산·설정': 'budget', '아직 미정': 'explore' };
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const manualDir = slug => join(RUNS, slug, 'p1-research', 'references', 'manual');
const manualCount = slug => { try { return readdirSync(manualDir(slug)).filter(n => !n.startsWith('.')).length; } catch { return 0; } };
const AGENTS = { moa: '모아', haru: '하루', sora: '소라', koda: '코다', tes: '테스' };
const WHO = { p1: 'moa', p2: 'haru', p3: 'sora', approval: 'sora', p4: 'koda', p5: 'tes', done: 'tes', blocked: 'tes' };

/* ---------- 하네스 상태 읽기 ---------- */
function readJson(p) { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } }
function latestRun() {
  if (!existsSync(RUNS)) return null;
  const runs = readdirSync(RUNS).filter(s => SLUG.test(s) && existsSync(join(RUNS, s, 'state.json')))
    .map(s => ({ s, t: statSync(join(RUNS, s, 'state.json')).mtimeMs, open: !['done'].includes(readJson(join(RUNS, s, 'state.json'))?.phase) }))
    .sort((a, b) => (b.open - a.open) || (b.t - a.t));
  return runs[0]?.s || null; // 끝나지 않은 실행을 먼저, 그다음 최근 것
}
function htmlFiles(slug) {
  const out = [];
  const add = (dir, kind, test) => {
    const d = join(RUNS, slug, dir);
    if (!existsSync(d)) return;
    for (const n of readdirSync(d).filter(test).sort())
      out.push({ id: `${kind}-${n}`, name: n.replace(/\.html$/, ''), kind, path: `${dir}/${n}`, mtime: statSync(join(d, n)).mtimeMs });
  };
  const an = join(RUNS, slug, 'p1-research', 'analysis.md');
  if (existsSync(an)) out.push({ id: 'research-analysis', name: '리서치 결과', kind: 'research', path: 'p1-research/analysis.md', mtime: statSync(an).mtimeMs });
  add('p3-concept', 'key', n => /^key-.+\.html$/.test(n));
  add('p4-design/screens', 'screen', n => n.endsWith('.html'));
  return out;
}
function approvalOf(slug) {
  try { return readFileSync(join(RUNS, slug, 'p3-concept', 'approval.md'), 'utf8').match(/^status:\s*(\w+)/m)?.[1] || null; } catch { return null; }
}
function harnessDoc() {
  const slug = latestRun();
  if (!slug) return null;
  const st = readJson(join(RUNS, slug, 'state.json'));
  if (!st) return null;
  const g = st.gates?.[st.phase];
  const running = job?.status === 'taking';
  const status = st.phase === 'done' ? 'done' : st.phase === 'blocked' ? 'blocked'
    : running ? 'run' : g && g.result !== 'pass' ? g.result : 'ready';
  return {
    slug, screens: st.screens || [], phase: st.phase, status, who: WHO[st.phase] || 'tes',
    message: st.log?.at(-1)?.text || '', gates: st.gates || {}, failures: st.failures || {}, log: st.log || [],
    approval: approvalOf(slug), updatedAt: statSync(join(RUNS, slug, 'state.json')).mtimeMs,
  };
}

/* ---------- Claude Code 실행 ---------- */
const jobs = []; // 최근 요청 (새 것이 앞)
let job = null;  // 지금 도는 것
let proc = null;
const COMMON = `

[로컬 사무실 앱에서 보낸 요청]
- 대표가 사무실 앱 버튼으로 보낸 요청이에요. 대화로 되물을 수 없으니, 대표 결정이 필요하면 멈추고 마지막 답에 질문을 적어요.
- run-harness의 "사무실 동기화"(ArtifactData)는 하지 않아요. 앱이 runs/를 직접 읽어요.
- 승인 대기(wait)가 되면 멈추고, 마지막 답에 "사무실 앱에서 시안을 보고 승인·반려 버튼을 눌러 주세요"라고 적어요. approve.mjs는 실행하지 않아요.
- 마지막 답은 대표에게 보여줄 한두 문장으로 써요.`;
// 모아의 레퍼런스 도구: 유아이볼 (무료, 읽기 전용)
const UIBOWL_TOOLS = ['search_ui_patterns', 'search_components', 'filter_by_app', 'search_by_ocr_text'].map(t => `mcp__claude_ai_uibowl__${t}`);
const HARNESS_TOOLS = ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Agent', 'Skill', 'TodoWrite', 'WebSearch', 'WebFetch',
  'Bash(node harness/scripts/verify.mjs:*)', 'Bash(node harness/tests/run-tests.mjs)', 'Bash(mkdir:*)', 'Bash(date:*)', 'Bash(ls:*)', ...UIBOWL_TOOLS];

function buildJob(b) {
  const memo = b.text ? `\n\n대표 메모: ${b.text}` : '';
  if (b.kind === 'start') {
    if (!SCREENS.includes(b.screen)) throw new Error('화면을 골라 주세요.');
    const n = manualCount(`${today()}-${SCREEN_KEYS[b.screen]}`);
    const refs = !b.refs ? '안 넣는다' : n ? `넣었다 — manual 폴더에 이미 ${n}개 있으니 멈추지 말고 바로 P1을 진행한다` : '넣는다 — 폴더를 만들고 경로를 알려준 뒤 멈춘다';
    return {
      prompt: `/run-harness ${b.screen}\n첫 실행 질문의 답: 1) 화면: ${b.screen} 2) references/manual 레퍼런스: ${refs}${memo}${COMMON}`,
      tools: HARNESS_TOOLS, deny: [],
    };
  }
  if (b.kind === 'continue') return { prompt: `하네스 이어서 해줘.${memo}${COMMON}`, tools: HARNESS_TOOLS, deny: [] };
  if (b.kind === 'ask') {
    if (!AGENTS[b.to]) throw new Error('받을 직원을 골라 주세요.');
    if (!b.text) throw new Error('질문을 적어 주세요.');
    return {
      prompt: `${AGENTS[b.to]}(${b.to}) 에이전트를 Agent 도구로 불러 아래 대표의 질문을 그대로 전하고, 그 답을 고치지 않고 마지막 답으로 돌려줘. 파일은 쓰지 않고, 판정·승인도 하지 않는다.\n\n질문: ${b.text}`,
      tools: ['Read', 'Glob', 'Grep', 'Agent'], deny: ['Write', 'Edit', 'Bash'],
    };
  }
  throw new Error('알 수 없는 요청이에요.');
}
// stream-json 한 줄을 사람이 읽을 기록으로
function describe(ev) {
  if (ev.type === 'assistant') return (ev.message?.content || []).map(c => {
    if (c.type === 'text' && c.text.trim()) return `말 · ${c.text.trim().slice(0, 300)}`;
    if (c.type !== 'tool_use') return null;
    const i = c.input || {};
    if (c.name === 'Agent' || c.name === 'Task') return `직원 호출 · ${AGENTS[i.subagent_type] || i.subagent_type || ''} ${i.description || ''}`;
    if (c.name === 'Bash') return `실행 · ${String(i.command || '').slice(0, 160)}`;
    if (['Write', 'Edit'].includes(c.name)) return `저장 · ${relative(ROOT, String(i.file_path || ''))}`;
    if (c.name === 'Skill') return `스킬 · ${i.skill || ''}`;
    return `도구 · ${c.name}`;
  }).filter(Boolean);
  if (ev.type === 'result') return [`끝 · ${ev.is_error ? '오류로 멈췄어요' : '완료'}`];
  return [];
}
function startJob(b) {
  if (job?.status === 'taking') throw new Error('다른 요청이 아직 도는 중이에요. 끝나거나 멈춘 뒤에 다시 보내 주세요.');
  const spec = buildJob(b);
  const id = 'j' + Date.now().toString(36);
  job = { id, kind: b.kind, screen: b.screen, refs: !!b.refs, to: b.to, text: b.text || '',
    status: 'taking', reply: '', createdAt: Date.now(), log: [] };
  jobs.unshift(job); jobs.length = Math.min(jobs.length, 10);
  mkdirSync(LOGS, { recursive: true });
  const logFile = join(LOGS, `${id}.jsonl`);
  const args = ['-p', spec.prompt, '--output-format', 'stream-json', '--verbose', '--permission-mode', 'default'];
  if (spec.deny.length) args.push('--disallowedTools', ...spec.deny);
  args.push('--allowedTools', ...spec.tools);
  const me = job;
  proc = spawn(CLAUDE, args, { cwd: ROOT, env: { ...process.env, PATH }, stdio: ['ignore', 'pipe', 'pipe'] });
  let buf = '';
  proc.stdout.on('data', d => {
    buf += d; let k;
    while ((k = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, k); buf = buf.slice(k + 1);
      if (!line.trim()) continue;
      appendFileSync(logFile, line + '\n');
      let ev; try { ev = JSON.parse(line); } catch { continue; }
      me.log.push(...describe(ev)); if (me.log.length > 200) me.log.splice(0, me.log.length - 200);
      if (ev.type === 'result') { me.reply = String(ev.result || '').trim().slice(0, 1200); me.failed = !!ev.is_error; }
    }
  });
  proc.stderr.on('data', d => { me.log.push(`오류 · ${String(d).trim().slice(0, 300)}`); });
  proc.on('error', e => { me.status = 'refused'; me.reply = `Claude Code를 실행하지 못했어요: ${e.message}`; proc = null; });
  proc.on('close', code => {
    if (me.status === 'taking') me.status = code === 0 && !me.failed ? 'done' : 'refused';
    if (!me.reply && me.status === 'refused') me.reply = me.stopped ? '대표가 멈췄어요.' : `중간에 멈췄어요 (종료 코드 ${code}).`;
    proc = null;
  });
  return job;
}

/* ---------- 직원과 1:1 대화: 직원 지침과 지금 하네스 상태를 주고 Claude Code에게 답을 받아요 (읽기 전용) ---------- */
const PERSONA = { moa: ['모아', '리서처'], haru: ['하루', '기획 PM'], sora: ['소라', '디자이너'], koda: ['코다', '개발자'], tes: ['테스', 'QA'] };
function chatReply({ id, turns }) {
  return new Promise((ok, fail) => {
    const [name, role] = PERSONA[id] || [];
    if (!name) return fail(new Error('대화할 직원을 찾지 못했어요.'));
    let guide = '';
    try { guide = readFileSync(join(ROOT, '.claude', 'agents', `${id}.md`), 'utf8').replace(/^---[\s\S]*?---\s*/, ''); } catch {}
    const hz = harnessDoc();
    const state = hz
      ? `지금 하네스 실행: runs/${hz.slug}/ · 화면 ${hz.screens.join('·')} · 단계 ${hz.phase}(${hz.status}) · 승인 ${hz.approval ?? '없음'}\n최근 기록:\n${hz.log.slice(-6).map(l => '- ' + l.text).join('\n')}`
      : '지금 하네스 실행이 없어요.';
    const talk = (Array.isArray(turns) ? turns : []).slice(-12).map(([w, t]) => `${w === 'me' ? '대표' : name}: ${String(t).slice(0, 600)}`).join('\n');
    const prompt = `너는 "${name}"(${role}), 대표(사용자)와 일하는 AI 디자인 팀 직원이야. 대표와 1:1 메신저로 이야기하고 있어.
[네 역할 지침]
${guide}
[지금 상태]
${state}
[규칙]
- 한국어 해요체로 2~5문장. 형식적인 인사나 "확인했어요, 메모해 둘게요" 같은 빈말은 하지 마. 대표가 한 말에 직접 답해.
- 필요하면 runs/ 아래 실제 파일(analysis.md, screens.md, tokens.md, 시안 HTML, review.md)과 docs/를 읽고 거기 있는 내용으로 구체적으로 말해. 읽지 않은 걸 지어내지 마. 모르면 모른다고 해.
- 파일을 쓰거나 고치지 않고, 하네스 단계를 실행·승인하지 않아. 대표가 일을 시키거나 시안을 고치라고 하면, 하네스 패널의 "새 실행"이나 "이어서 진행"으로 보내 달라고 안내하고 필요한 메모 문장을 같이 알려 줘.
- 네 담당이 아닌 일은 담당 직원을 알려 줘 (모아 리서치, 하루 설계, 소라 시안, 코다 디자인, 테스 판정).
[대화]
${talk}
${name}:`;
    const p = spawn(CLAUDE, ['-p', prompt, '--output-format', 'json', '--allowedTools', 'Read', 'Glob', 'Grep', '--disallowedTools', 'Write', 'Edit', 'Bash'],
      { cwd: ROOT, env: { ...process.env, PATH }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { p.kill('SIGTERM'); fail(new Error('답이 너무 오래 걸려서 멈췄어요. 다시 말을 걸어 주세요.')); }, 150000);
    p.stdout.on('data', d => out += d); p.stderr.on('data', d => err += d);
    p.on('error', e => { clearTimeout(timer); fail(e); });
    p.on('close', () => {
      clearTimeout(timer);
      try { const j = JSON.parse(out); if (j.is_error) throw new Error(String(j.result || '').slice(0, 200)); return ok(String(j.result || '').trim()); }
      catch (e) { return fail(new Error(/limit/i.test(out + err) ? 'Claude 사용 한도에 걸렸어요. 한도가 풀린 뒤 다시 말을 걸어 주세요.' : '답을 받지 못했어요. 다시 한 번 말을 걸어 주세요.')); }
    });
  });
}

/* ---------- 승인 (대표가 버튼을 누른 순간 직접 실행) ---------- */
function approve(slug, reject) {
  return new Promise((ok, fail) => {
    if (!SLUG.test(slug || '') || !existsSync(join(RUNS, slug, 'state.json'))) return fail(new Error('실행을 찾지 못했어요.'));
    if (readJson(join(RUNS, slug, 'state.json'))?.phase !== 'approval') return fail(new Error('지금은 승인 단계가 아니에요.'));
    if (job?.status === 'taking') return fail(new Error('요청이 도는 중에는 승인할 수 없어요.'));
    const args = [join(ROOT, 'harness', 'scripts', 'approve.mjs'), slug];
    if (reject != null) args.push('--reject', String(reject).slice(0, 500) || '(사유 없음)');
    execFile(process.execPath, args, { cwd: ROOT }, (e, out, err) => e ? fail(new Error(String(err || e.message).trim())) : ok(String(out).trim()));
  });
}

/* ---------- HTTP ---------- */
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.json': 'application/json' };
const send = (res, code, body, type = 'application/json; charset=utf-8') => {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};
const readBody = req => new Promise((ok, fail) => {
  let s = ''; req.on('data', d => { s += d; if (s.length > 1e5) req.destroy(); });
  req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch { fail(new Error('요청 형식이 잘못됐어요.')); } });
});
const pub = j => j && ({ ...j, log: undefined });

const server = http.createServer(async (req, res) => {
  // localhost 주소로 들어온 요청만 받아요 (다른 사이트가 주소를 바꿔치기해 들어오는 것 막기)
  if (![`127.0.0.1:${PORT}`, `localhost:${PORT}`].includes(req.headers.host)) return send(res, 403, { error: 'forbidden' });
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html'))
      return send(res, 200, readFileSync(join(PUBLIC, 'index.html'), 'utf8').replace('__OFFICE_TOKEN__', TOKEN), TYPES['.html']);
    // 서버가 다시 켜져 토큰이 바뀐 뒤에도 열려 있는 페이지가 새 토큰을 받아 가게 (같은 주소의 페이지만 읽을 수 있어요)
    if (req.method === 'GET' && url.pathname === '/api/token') return send(res, 200, { token: TOKEN });
    if (req.method === 'GET' && url.pathname === '/api/state') {
      const hz = harnessDoc();
      return send(res, 200, { hz, files: hz ? htmlFiles(hz.slug) : [], jobs: jobs.map(pub), log: job?.log.slice(-40) || [], running: job?.status === 'taking' });
    }
    // 시안 HTML (runs/<slug>/p3-concept, p4-design/screens 안의 .html만)
    const fm = url.pathname.match(/^\/files\/([\w-]+)\/(p3-concept\/key-[^/]+\.html|p4-design\/screens\/[^/]+\.html|p1-research\/analysis\.md)$/);
    if (req.method === 'GET' && fm) {
      const p = resolve(RUNS, fm[1], decodeURIComponent(fm[2]));
      if (!p.startsWith(join(RUNS, fm[1]) + sep) || !existsSync(p)) return send(res, 404, { error: 'not found' });
      return send(res, 200, readFileSync(p, 'utf8'), 'text/plain; charset=utf-8');
    }
    // 레퍼런스 이미지 (리서치 결과 안에서 보여 주기용, 이미지 파일만)
    const im = url.pathname.match(/^\/files\/([\w-]+)\/p1-research\/references\/(manual|auto)\/([^/]+\.(png|jpe?g|gif|webp|avif))$/i);
    if (req.method === 'GET' && im) {
      const base = join(RUNS, im[1], 'p1-research', 'references', im[2]);
      const p = resolve(base, decodeURIComponent(im[3]));
      if (!p.startsWith(base + sep) || !existsSync(p)) return send(res, 404, { error: 'not found' });
      const t = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif' }[im[4].toLowerCase()];
      return send(res, 200, readFileSync(p), t);
    }
    if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
      const p = resolve(PUBLIC, '.' + decodeURIComponent(url.pathname));
      if (p.startsWith(PUBLIC + sep) && existsSync(p) && statSync(p).isFile()) return send(res, 200, readFileSync(p), TYPES[extname(p)] || 'application/octet-stream');
      return send(res, 404, { error: 'not found' });
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'method' });
    if (req.headers['x-office-token'] !== TOKEN) return send(res, 403, { error: '페이지를 새로고침해 주세요.' });
    const b = await readBody(req);
    if (url.pathname === '/api/jobs') return send(res, 200, { job: pub(startJob(b)) });
    if (url.pathname === '/api/stop') {
      if (proc && job?.status === 'taking') { job.stopped = true; job.status = 'refused'; job.reply = '대표가 멈췄어요.'; proc.kill('SIGTERM'); }
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/api/chat') return send(res, 200, { reply: await chatReply(b) });
    if (url.pathname === '/api/dismiss') {   // 끝난 요청 기록 지우기 (도는 중인 건 못 지움)
      const k = jobs.findIndex(j => j.id === b.id && j.status !== 'taking');
      if (k >= 0) jobs.splice(k, 1);
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/api/approve') return send(res, 200, { message: await approve(b.slug, b.reject ?? null) });
    if (url.pathname === '/api/open-refs') {
      // 실행 전이면 고른 화면으로 오늘 slug를 만들어 폴더부터 열어요 (run-harness도 같은 경로를 써요)
      const slug = b.screen ? `${today()}-${SCREEN_KEYS[b.screen] || ''}` : b.slug;
      if (!SLUG.test(slug || '') || (b.screen && !SCREEN_KEYS[b.screen])) throw new Error('실행을 찾지 못했어요.');
      const d = manualDir(slug);
      mkdirSync(d, { recursive: true });
      execFile('open', [d]);
      return send(res, 200, { ok: true, count: manualCount(slug) });
    }
    return send(res, 404, { error: 'not found' });
  } catch (e) { return send(res, 400, { error: e.message }); }
});
server.on('error', e => { console.error(e.code === 'EADDRINUSE' ? `포트 ${PORT}을 이미 쓰고 있어요. 사무실이 이미 켜져 있는지 확인해 주세요.` : e.message); process.exit(1); });
server.listen(PORT, '127.0.0.1', () => console.log(`AI 팀 사무실: http://127.0.0.1:${PORT}`));
const quit = () => { proc?.kill('SIGTERM'); process.exit(0); };
process.on('SIGINT', quit); process.on('SIGTERM', quit);
