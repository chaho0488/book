// 자체 점검: D1을 흉내 낸 메모리 DB로 들어오기 → 제출 → 고치기 → 파일 조각 → 교사 화면까지 돌려 본다
// 실행: node --experimental-sqlite test.mjs
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import worker from './src/index.js';

const db = new DatabaseSync(':memory:');
db.exec(readFileSync('./schema.sql', 'utf8'));
db.exec("INSERT INTO config VALUES ('admin_key', 'testkey1')");
const stmt = (sql, args = []) => ({
  bind: (...a) => stmt(sql, a),
  first: async () => db.prepare(sql).get(...args) ?? null,
  all: async () => ({ results: db.prepare(sql).all(...args) }),
  run: async () => db.prepare(sql).run(...args),
});
const env = { DB: { prepare: (sql) => stmt(sql) } };
const call = (path, init) => worker.fetch(new Request('https://book.test' + path, init), env);
const post = (path, d) => call(path, { method: 'POST', body: JSON.stringify(d) });
const A = { student_no: '1203', password: '4321' };
const login = (d) => post('/api/login', d);
const submit = (d) => post('/api/submit', { ...A, ...d });
const mine = async (d = A) => Object.fromEntries((await (await login(d)).json()).items.map((i) => [i.kind, i]));

// 1. 들어오기: 처음이면 이름이 있어야 하고, 그때 넣은 비밀번호가 내 비밀번호가 된다
assert.equal((await login({ student_no: '12a3', name: '홍', password: '4321' })).status, 400);
assert.equal((await login({ ...A, password: '12' })).status, 400);
assert.equal((await login(A)).status, 400);
assert.equal((await login({ ...A, name: '홍길동' })).status, 200);
assert.equal((await login({ ...A, password: '0000' })).status, 403);
assert.equal((await login(A)).status, 200);
// 비밀번호는 그대로 저장되지 않는다
assert.ok(!JSON.stringify(db.prepare('SELECT * FROM students').all()).includes('4321'));

// 2. 들어오지 않은 학번, 틀린 비밀번호로는 제출할 수 없다
assert.equal((await post('/api/submit', { student_no: '9999', password: '4321', kind: 'gray', body: 'x' })).status, 403);
assert.equal((await submit({ password: '0000', kind: 'gray', body: 'x' })).status, 403);

// 3. 제출하고, 다시 내면 새 줄이 생기지 않고 그 줄이 고쳐진다
assert.equal((await submit({ kind: 'gray', body: '만약 내가 <b>회색</b> 인간이라면' })).status, 200);
assert.equal((await mine()).gray.body, '만약 내가 <b>회색</b> 인간이라면');
assert.equal((await submit({ kind: 'gray', body: '고친 글 <b>회색</b>' })).status, 200);
assert.equal(db.prepare("SELECT COUNT(*) AS n FROM submissions WHERE kind = 'gray'").get().n, 1);
assert.equal((await mine()).gray.body, '고친 글 <b>회색</b>');

// 4. 잘못된 입력은 거절
assert.equal((await submit({ kind: 'gray', body: '' })).status, 400);
assert.equal((await submit({ kind: 'nope', body: 'x' })).status, 400);
assert.equal((await submit({ kind: 'helper', role: '가수' })).status, 400);
assert.equal((await submit({ kind: 'bognar' })).status, 400);
assert.equal((await submit({ kind: 'bognar', file_name: 'a.pptx', file_size: 10 })).status, 400);
assert.equal((await submit({ kind: 'bognar', body: '설명', file_name: 'a.exe', file_size: 10 })).status, 400);
assert.equal((await submit({ kind: 'bognar', body: '설명', file_name: 'a.pptx', file_size: 11 * 1024 * 1024 })).status, 400);
assert.equal((await submit({ kind: 'bognar', body: '가'.repeat(301), file_name: 'a.pptx', file_size: 10 })).status, 400);
// 보그나르는 설명만으로는 안 되고 PPT 초안이 꼭 있어야 한다
assert.equal((await submit({ kind: 'bognar', body: '설명만' })).status, 400);
assert.equal((await submit({ kind: 'gobaek', body: '줄거리' })).status, 400);
assert.equal((await submit({ kind: 'gobaek', body: '줄거리', file_name: 'a.pptx', file_size: 10 })).status, 400);
assert.equal((await (await submit({ kind: 'question', body: '질문', file_name: 'a.hwp', file_size: 10 })).json()).chunks, 0);

// 5. 파일 제출: 조각 2개짜리
const bytes = Buffer.alloc(720000 + 5000, 7);
let r = await submit({ kind: 'bognar', body: '설명', team: '1204 이영희', file_name: '기획.pptx', file_size: bytes.length });
const sub = await r.json();
assert.equal(sub.chunks, 2);
const chunk = (seq, token, body) => call(`/api/chunk?id=${sub.id}&seq=${seq}&token=${token}`, { method: 'POST', body });
// 남의 제출물에 붙이기, 범위 밖 조각, base64가 아닌 내용은 거절
assert.equal((await chunk(0, 'wrong', 'AAAA')).status, 403);
assert.equal((await chunk(2, sub.token, 'AAAA')).status, 403);
assert.equal((await chunk(0, sub.token, '<script>')).status, 400);
assert.equal((await chunk(0, sub.token, bytes.subarray(0, 720000).toString('base64'))).status, 200);

// 6. 교사 화면: 열쇠가 틀리면 404, 조각이 덜 올라오면 '끊김' 표시
assert.equal((await call('/t/wrongkey')).status, 404);
let html = await (await call('/t/testkey1')).text();
assert.ok(html.includes('올리다 끊김'));
assert.equal((await mine()).bognar.file_ok, 0);
assert.equal((await chunk(1, sub.token, bytes.subarray(720000).toString('base64'))).status, 200);
assert.equal((await mine()).bognar.file_ok, 1);
html = await (await call('/t/testkey1')).text();
assert.ok(html.includes('기획.pptx 내려받기'));
// 학생이 적은 태그는 글자로만 보여야 한다
assert.ok(html.includes('&lt;b&gt;회색&lt;/b&gt;') && !html.includes('<b>회색</b>'));

// 7. 조각을 다시 합치면 원본과 같다
const parts = [];
for (let i = 0; i < 2; i++) parts.push(Buffer.from(await (await call(`/t/testkey1/chunk?id=${sub.id}&seq=${i}`)).text(), 'base64'));
assert.ok(Buffer.concat(parts).equals(bytes));
assert.equal((await call(`/t/wrongkey/chunk?id=${sub.id}&seq=0`)).status, 404);

// 8. 글만 고치면 전에 올린 파일은 그대로 남는다
r = await submit({ kind: 'bognar', body: '고친 설명' });
assert.equal((await r.json()).chunks, 0);
const b = (await mine()).bognar;
assert.ok(b.body === '고친 설명' && b.file_name === '기획.pptx' && b.file_ok === 1);

// 9. 고백은: 파일이 올라가 있으면 줄거리만 고칠 수 있다
r = await submit({ kind: 'gobaek', body: '줄거리', file_name: '대본.txt', file_size: 4 });
const g = await r.json();
assert.equal((await submit({ kind: 'gobaek', body: '줄거리2' })).status, 400); // 아직 파일이 안 올라옴
r = await submit({ kind: 'gobaek', body: '줄거리', file_name: '대본.hwpx', file_size: 4 });
const g2 = await r.json();
assert.equal(g2.id, g.id);
assert.equal((await call(`/api/chunk?id=${g.id}&seq=0&token=${g.token}`, { method: 'POST', body: 'AAAA' })).status, 403); // 옛 token은 못 씀
assert.equal((await call(`/api/chunk?id=${g2.id}&seq=0&token=${g2.token}`, { method: 'POST', body: 'AAAA' })).status, 200);
assert.equal((await submit({ kind: 'gobaek', body: '줄거리2' })).status, 200);

// 9-1. 고백은 대본은 파일 없이 붙여넣은 글로도 낼 수 있고, 다시 들어오면 그 글이 보인다
const C = { student_no: '3101', password: 'pass1' };
await login({ ...C, name: '박대본' });
assert.equal((await post('/api/submit', { ...C, kind: 'gobaek', body: '줄거리' })).status, 400);
assert.equal((await post('/api/submit', { ...C, kind: 'gobaek', body: '줄거리', script: '가'.repeat(15001) })).status, 400);
assert.equal((await post('/api/submit', { ...C, kind: 'gobaek', body: '줄거리', script: '철수: <안녕>' })).status, 200);
assert.equal((await mine(C)).gobaek.script, '철수: <안녕>');
assert.ok((await (await call('/t/testkey1')).text()).includes('[공연 대본]\n철수: &lt;안녕&gt;'));
// 다른 종류에 대본을 보내도 저장하지 않는다
await post('/api/submit', { ...C, kind: 'gray', body: '글', script: '몰래' });
assert.equal((await mine(C)).gray.script, '');

// 10. 다른 학생은 자기 것만 본다. 이름을 고치면 낸 글의 이름도 바뀐다
const B = { student_no: '2101', password: 'abcd' };
assert.equal((await login({ ...B, name: '김철수' })).status, 200);
assert.deepEqual(await mine(B), {});
assert.equal((await (await login({ ...A, name: '홍길순' })).json()).name, '홍길순');
assert.equal(db.prepare("SELECT COUNT(*) AS n FROM submissions WHERE name = '홍길순'").get().n, 4);

console.log('모든 점검 통과');
