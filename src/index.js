// 김동식 작가와의 만남 참여 사이트 (Cloudflare Worker + D1)
// 학생 화면은 public/index.html, 여기는 제출 저장과 교사용 목록만 맡는다.

const KINDS = {
  gray: '회색 인간',
  bognar: '보그나르 주식회사',
  gobaek: '고백은 이미 본 장면',
  helper: '재능기부 도우미',
  question: '작가님께 질문',
};
const ROLES = ['사회자', '손재주', '미적감각'];
// 파일을 받는 종류와 허용 확장자
const FILE_RULE = {
  bognar: { ext: /\.(pptx?|pdf)$/i, msg: 'PPT(.ppt, .pptx) 또는 PDF 파일만 올릴 수 있습니다.' },
  gobaek: { ext: /\.(hwpx?|txt)$/i, msg: '한글 파일(.hwp, .hwpx) 또는 텍스트 파일(.txt)만 올릴 수 있습니다.' },
};
// 보그나르 설명과 고백은 줄거리는 간단히만 받는다
const SHORT_BODY = 300;
const MAX_FILE = 10 * 1024 * 1024;
// 최소구현: R2가 꺼져 있어 파일을 D1에 조각으로 저장한다. 조각 크기는 public/index.html과 같아야 한다.
const CHUNK_BYTES = 720000;
const CHUNK_CHARS = 960000;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const clean = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    try {
      if (req.method === 'POST' && url.pathname === '/api/login') return await login(req, env);
      if (req.method === 'POST' && url.pathname === '/api/submit') return await submit(req, env);
      if (req.method === 'POST' && url.pathname === '/api/chunk') return await saveChunk(req, url, env);
      const m = url.pathname.match(/^\/t\/([a-z0-9]+)(\/chunk)?$/);
      if (req.method === 'GET' && m) {
        const row = await env.DB.prepare("SELECT value FROM config WHERE key = 'admin_key'").first();
        if (!row || row.value !== m[1]) return new Response('Not found', { status: 404 });
        return m[2] ? await readChunk(url, env) : await teacherPage(env);
      }
      return new Response('Not found', { status: 404 });
    } catch (e) {
      console.error(e);
      return json({ error: '서버 오류가 났습니다. 잠시 뒤 다시 시도해 주세요.' }, 500);
    }
  },
};

async function hashPw(salt, pw) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(salt + ':' + pw));
  return [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

async function readJson(req) {
  if (Number(req.headers.get('content-length') || 0) > 50000) return null;
  try {
    return JSON.parse(await req.text());
  } catch {
    return null;
  }
}

// 학번 + 비밀번호 확인. 처음 보는 학번이면 (allowCreate일 때) 그 비밀번호로 새로 등록한다.
// 최소구현: 틀린 횟수 제한이 없다. 장난으로 남을 잠그는 일을 막으려고 뺐고, 문제가 생기면 교사 화면 잠금과 함께 보완한다.
async function auth(d, env, allowCreate) {
  const studentNo = clean(d.student_no, 10);
  const pw = typeof d.password === 'string' ? d.password : '';
  if (!/^\d{3,6}$/.test(studentNo)) return { err: json({ error: '학번을 숫자로 적어 주세요.' }, 400) };
  if (pw.length < 4 || pw.length > 20) return { err: json({ error: '비밀번호는 4~20자로 정해 주세요.' }, 400) };
  const st = await env.DB.prepare('SELECT student_no, name, salt, hash FROM students WHERE student_no = ?').bind(studentNo).first();
  if (st) {
    if ((await hashPw(st.salt, pw)) !== st.hash)
      return { err: json({ error: '비밀번호가 다릅니다. 이 학번으로 처음 정한 비밀번호를 넣어 주세요.' }, 403) };
    return { st };
  }
  if (!allowCreate) return { err: json({ error: '처음 화면에서 학번과 비밀번호를 다시 넣어 주세요.' }, 403) };
  const name = clean(d.name, 20);
  if (!name) return { err: json({ error: '처음이면 이름도 적어 주세요.' }, 400) };
  const salt = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO students (student_no, name, salt, hash, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(studentNo, name, salt, await hashPw(salt, pw), new Date().toISOString())
    .run();
  return { st: { student_no: studentNo, name } };
}

// 들어오기: 맞으면 내가 낸 것들을 돌려준다 (어느 기기에서든 같은 학번·비밀번호로 확인)
async function login(req, env) {
  const d = await readJson(req);
  if (!d) return json({ error: '잘못된 요청입니다.' }, 400);
  const { st, err } = await auth(d, env, true);
  if (err) return err;
  // 이름을 잘못 적었으면 비밀번호가 맞을 때 고쳐 준다
  const name = clean(d.name, 20);
  if (name && name !== st.name) {
    st.name = name;
    await env.DB.prepare('UPDATE students SET name = ? WHERE student_no = ?').bind(name, st.student_no).run();
    await env.DB.prepare('UPDATE submissions SET name = ? WHERE student_no = ?').bind(name, st.student_no).run();
  }
  const { results } = await env.DB.prepare(
    `SELECT s.kind, s.team, s.role, s.body, s.file_name, s.created_at,
            s.file_chunks > 0 AND s.file_chunks = (SELECT COUNT(*) FROM file_chunks c WHERE c.sub_id = s.id) AS file_ok
     FROM submissions s WHERE s.student_no = ?`
  ).bind(st.student_no).all();
  return json({ ok: true, name: st.name, items: results });
}

// 제출: 같은 학생의 같은 종류는 한 줄만 두고, 다시 내면 그 줄을 고친다
async function submit(req, env) {
  const d = await readJson(req);
  if (!d) return json({ error: '잘못된 요청입니다.' }, 400);
  const { st, err } = await auth(d, env, false);
  if (err) return err;
  const kind = clean(d.kind, 20);
  const team = clean(d.team, 200);
  const role = clean(d.role, 10);
  const body = clean(d.body, 6000);

  if (!KINDS[kind]) return json({ error: '제출 종류를 다시 골라 주세요.' }, 400);
  if (kind === 'helper' && !ROLES.includes(role)) return json({ error: '도우미 분야를 골라 주세요.' }, 400);
  if (kind !== 'helper' && !body) return json({ error: '내용을 적어 주세요.' }, 400);
  const rule = FILE_RULE[kind];
  // 잘라서 저장하면 학생 글이 말없이 사라지므로 길면 돌려보낸다
  if (rule && body.length > SHORT_BODY) return json({ error: `설명은 ${SHORT_BODY}자 이내로 간단히 적어 주세요.` }, 400);

  const old = await env.DB.prepare(
    `SELECT s.id, s.file_name, s.file_size, s.file_chunks,
            s.file_chunks > 0 AND s.file_chunks = (SELECT COUNT(*) FROM file_chunks c WHERE c.sub_id = s.id) AS file_ok
     FROM submissions s WHERE s.student_no = ? AND s.kind = ?`
  ).bind(st.student_no, kind).first();

  // 새 파일을 고르지 않았으면 전에 올린 파일을 그대로 둔다
  let fileName = old ? old.file_name : '', fileSize = old ? old.file_size : 0, fileChunks = old ? old.file_chunks : 0;
  const newFile = Boolean(rule && d.file_name);
  if (newFile) {
    fileName = clean(d.file_name, 100);
    fileSize = Number(d.file_size);
    if (!rule.ext.test(fileName)) return json({ error: rule.msg }, 400);
    if (!Number.isInteger(fileSize) || fileSize < 1 || fileSize > MAX_FILE)
      return json({ error: '파일은 10MB 이하만 올릴 수 있습니다.' }, 400);
    fileChunks = Math.ceil(fileSize / CHUNK_BYTES);
  }
  if (kind === 'gobaek' && !newFile && !(old && old.file_ok))
    return json({ error: '대본 또는 각색안 파일(한글 또는 텍스트)을 올려 주세요.' }, 400);

  const token = crypto.randomUUID();
  const now = new Date().toISOString();
  const r = kind === 'helper' ? role : '';
  let id;
  if (old) {
    id = old.id;
    await env.DB.prepare(
      'UPDATE submissions SET name = ?, team = ?, role = ?, body = ?, file_name = ?, file_size = ?, file_chunks = ?, token = ?, created_at = ? WHERE id = ?'
    ).bind(st.name, team, r, body, fileName, fileSize, fileChunks, token, now, id).run();
    // 최소구현: 새 파일을 올리다 끊기면 전 파일도 없어진다. 교사 화면에 '끊김'으로 보이고 학생에게 다시 올리라고 안내한다.
    if (newFile) await env.DB.prepare('DELETE FROM file_chunks WHERE sub_id = ?').bind(id).run();
  } else {
    const row = await env.DB.prepare(
      `INSERT INTO submissions (kind, student_no, name, team, role, body, file_name, file_size, file_chunks, token, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
    ).bind(kind, st.student_no, st.name, team, r, body, fileName, fileSize, fileChunks, token, now).first();
    id = row.id;
  }
  return json({ ok: true, id, token, chunks: newFile ? fileChunks : 0 });
}

async function saveChunk(req, url, env) {
  if (Number(req.headers.get('content-length') || 0) > CHUNK_CHARS) return json({ error: '조각이 너무 큽니다.' }, 413);
  const id = Number(url.searchParams.get('id'));
  const seq = Number(url.searchParams.get('seq'));
  const token = url.searchParams.get('token') || '';
  const data = await req.text();
  if (!Number.isInteger(id) || !Number.isInteger(seq) || seq < 0) return json({ error: '잘못된 요청입니다.' }, 400);
  if (!data || data.length > CHUNK_CHARS || !/^[A-Za-z0-9+/]+=*$/.test(data)) return json({ error: '잘못된 파일 조각입니다.' }, 400);
  // 제출할 때 받은 token이 맞아야 그 제출물에 파일을 붙일 수 있다
  const sub = await env.DB.prepare('SELECT file_chunks FROM submissions WHERE id = ? AND token = ?').bind(id, token).first();
  if (!sub || seq >= sub.file_chunks) return json({ error: '제출 정보를 찾을 수 없습니다.' }, 403);
  await env.DB.prepare('INSERT OR REPLACE INTO file_chunks (sub_id, seq, data) VALUES (?, ?, ?)').bind(id, seq, data).run();
  return json({ ok: true });
}

async function readChunk(url, env) {
  const row = await env.DB.prepare('SELECT data FROM file_chunks WHERE sub_id = ? AND seq = ?')
    .bind(Number(url.searchParams.get('id')), Number(url.searchParams.get('seq')))
    .first();
  if (!row) return new Response('Not found', { status: 404 });
  return new Response(row.data, { headers: { 'content-type': 'text/plain' } });
}

// 한국 시간으로 "11/30 12:05" 꼴
const kst = (iso) => {
  const t = new Date(new Date(iso).getTime() + 9 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${t.getUTCMonth() + 1}/${t.getUTCDate()} ${p(t.getUTCHours())}:${p(t.getUTCMinutes())}`;
};

async function teacherPage(env) {
  const { results } = await env.DB.prepare(
    `SELECT s.id, s.kind, s.student_no, s.name, s.team, s.role, s.body, s.file_name, s.file_chunks, s.created_at,
            (SELECT COUNT(*) FROM file_chunks c WHERE c.sub_id = s.id) AS saved
     FROM submissions s ORDER BY s.id DESC`
  ).all();

  const sections = Object.entries(KINDS)
    .map(([kind, title]) => {
      const rows = results.filter((r) => r.kind === kind);
      const trs = rows
        .map((r) => {
          let file = '';
          if (r.file_name) {
            file =
              r.saved === r.file_chunks
                ? `<button type="button" data-id="${r.id}" data-n="${r.file_chunks}" data-name="${esc(r.file_name)}">${esc(r.file_name)} 내려받기</button>`
                : `<em>${esc(r.file_name)} (올리다 끊김, 다시 제출 필요)</em>`;
          }
          return `<tr><td>${kst(r.created_at)}</td><td>${esc(r.student_no)}</td><td>${esc(r.name)}</td><td>${esc(r.team || r.role)}</td><td class="body">${esc(r.body)}${file ? `<div>${file}</div>` : ''}</td></tr>`;
        })
        .join('');
      const third = kind === 'helper' ? '분야' : '팀원';
      return `<h2>${title} <small>${rows.length}건</small></h2>
<table><thead><tr><th>마지막 제출</th><th>학번</th><th>이름</th><th>${third}</th><th>내용</th></tr></thead><tbody>${trs || '<tr><td colspan="5">아직 없습니다.</td></tr>'}</tbody></table>`;
    })
    .join('');

  const html = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>제출 목록 (교사용)</title>
<style>
body{font-family:system-ui,sans-serif;margin:16px;color:#111;line-height:1.5}
h1{font-size:22px}h2{font-size:18px;margin-top:32px}small{font-weight:400;color:#555}
table{border-collapse:collapse;width:100%;font-size:14px}
th,td{border:1px solid #999;padding:6px 8px;text-align:left;vertical-align:top}
th{background:#eee;white-space:nowrap}td.body{white-space:pre-wrap;word-break:break-word;min-width:240px}
button{margin-top:6px;padding:6px 10px;font-size:14px}.wrap{overflow-x:auto}
</style></head><body>
<h1>작가와의 만남 제출 목록 <small>전체 ${results.length}건 · 새로고침하면 최신 내용</small></h1>
<p>이 주소를 아는 사람은 누구나 볼 수 있습니다. 선생님들끼리만 공유해 주세요.</p>
<div class="wrap">${sections}</div>
<script>
// 조각으로 저장된 파일을 차례로 받아 하나로 합쳐 내려받는다
document.addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-id]');
  if (!b) return;
  const label = b.textContent;
  b.disabled = true;
  try {
    const parts = [];
    for (let i = 0; i < Number(b.dataset.n); i++) {
      b.textContent = '받는 중 ' + (i + 1) + '/' + b.dataset.n;
      const r = await fetch(location.pathname + '/chunk?id=' + b.dataset.id + '&seq=' + i);
      if (!r.ok) throw new Error();
      parts.push(Uint8Array.from(atob(await r.text()), (c) => c.charCodeAt(0)));
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(parts));
    a.download = b.dataset.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  } catch {
    alert('파일을 받지 못했습니다. 다시 눌러 주세요.');
  }
  b.textContent = label;
  b.disabled = false;
});
</script></body></html>`;
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}
