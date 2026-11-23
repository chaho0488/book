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
const FILE_EXT = /\.(pptx?|pdf)$/i;
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

async function submit(req, env) {
  if (Number(req.headers.get('content-length') || 0) > 50000) return json({ error: '내용이 너무 깁니다.' }, 413);
  let d;
  try {
    d = JSON.parse(await req.text());
  } catch {
    return json({ error: '잘못된 요청입니다.' }, 400);
  }
  const kind = clean(d.kind, 20);
  const studentNo = clean(d.student_no, 10);
  const name = clean(d.name, 20);
  const team = clean(d.team, 200);
  const role = clean(d.role, 10);
  const body = clean(d.body, 6000);

  if (!KINDS[kind]) return json({ error: '제출 종류를 다시 골라 주세요.' }, 400);
  if (!/^\d{3,6}$/.test(studentNo)) return json({ error: '학번을 숫자로 적어 주세요.' }, 400);
  if (!name) return json({ error: '이름을 적어 주세요.' }, 400);
  if (kind === 'helper' && !ROLES.includes(role)) return json({ error: '도우미 분야를 골라 주세요.' }, 400);

  // 파일은 보그나르만 받는다
  let fileName = '', fileSize = 0, fileChunks = 0;
  if (kind === 'bognar' && d.file_name) {
    fileName = clean(d.file_name, 100);
    fileSize = Number(d.file_size);
    if (!FILE_EXT.test(fileName)) return json({ error: 'PPT(.ppt, .pptx) 또는 PDF 파일만 올릴 수 있습니다.' }, 400);
    if (!Number.isInteger(fileSize) || fileSize < 1 || fileSize > MAX_FILE)
      return json({ error: '파일은 10MB 이하만 올릴 수 있습니다.' }, 400);
    fileChunks = Math.ceil(fileSize / CHUNK_BYTES);
  }
  const needsBody = kind === 'gray' || kind === 'gobaek' || kind === 'question';
  if (needsBody && !body) return json({ error: '내용을 적어 주세요.' }, 400);
  if (kind === 'bognar' && !body && !fileName) return json({ error: '설명을 적거나 PPT 파일을 올려 주세요.' }, 400);

  const token = crypto.randomUUID();
  const row = await env.DB.prepare(
    `INSERT INTO submissions (kind, student_no, name, team, role, body, file_name, file_size, file_chunks, token, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
  )
    .bind(kind, studentNo, name, team, kind === 'helper' ? role : '', body, fileName, fileSize, fileChunks, token, new Date().toISOString())
    .first();
  return json({ ok: true, id: row.id, token, chunks: fileChunks });
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
<table><thead><tr><th>제출 시각</th><th>학번</th><th>이름</th><th>${third}</th><th>내용</th></tr></thead><tbody>${trs || '<tr><td colspan="5">아직 없습니다.</td></tr>'}</tbody></table>`;
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
