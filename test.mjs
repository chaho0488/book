// 자체 점검: D1을 흉내 낸 메모리 DB로 제출 → 파일 조각 저장 → 교사 화면까지 돌려 본다
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
const post = (d) => call('/api/submit', { method: 'POST', body: JSON.stringify(d) });

// 1. 정상 제출
let r = await post({ kind: 'gray', student_no: '1203', name: '홍길동', body: '만약 내가 <b>회색</b> 인간이라면' });
assert.equal(r.status, 200);

// 2. 잘못된 입력은 거절
assert.equal((await post({ kind: 'gray', student_no: '12a3', name: '홍', body: 'x' })).status, 400);
assert.equal((await post({ kind: 'gray', student_no: '1203', name: '홍', body: '' })).status, 400);
assert.equal((await post({ kind: 'nope', student_no: '1203', name: '홍', body: 'x' })).status, 400);
assert.equal((await post({ kind: 'helper', student_no: '1203', name: '홍', role: '가수' })).status, 400);
assert.equal((await post({ kind: 'bognar', student_no: '1203', name: '홍' })).status, 400);
assert.equal((await post({ kind: 'bognar', student_no: '1203', name: '홍', file_name: 'a.exe', file_size: 10 })).status, 400);
assert.equal((await post({ kind: 'bognar', student_no: '1203', name: '홍', file_name: 'a.pptx', file_size: 11 * 1024 * 1024 })).status, 400);

// 3. 파일 제출: 조각 2개짜리
const bytes = Buffer.alloc(720000 + 5000, 7);
r = await post({ kind: 'bognar', student_no: '2101', name: '김철수', team: '2102 이영희', file_name: '기획.pptx', file_size: bytes.length });
const sub = await r.json();
assert.equal(sub.chunks, 2);
const chunk = (seq, token, body) => call(`/api/chunk?id=${sub.id}&seq=${seq}&token=${token}`, { method: 'POST', body });
// 남의 제출물에 붙이기, 범위 밖 조각, base64가 아닌 내용은 거절
assert.equal((await chunk(0, 'wrong', 'AAAA')).status, 403);
assert.equal((await chunk(2, sub.token, 'AAAA')).status, 403);
assert.equal((await chunk(0, sub.token, '<script>')).status, 400);
assert.equal((await chunk(0, sub.token, bytes.subarray(0, 720000).toString('base64'))).status, 200);

// 4. 교사 화면: 열쇠가 틀리면 404, 조각이 덜 올라오면 '끊김' 표시
assert.equal((await call('/t/wrongkey')).status, 404);
let html = await (await call('/t/testkey1')).text();
assert.ok(html.includes('올리다 끊김'));
assert.equal((await chunk(1, sub.token, bytes.subarray(720000).toString('base64'))).status, 200);
html = await (await call('/t/testkey1')).text();
assert.ok(html.includes('기획.pptx 내려받기'));
// 학생이 적은 태그는 글자로만 보여야 한다
assert.ok(html.includes('&lt;b&gt;회색&lt;/b&gt;') && !html.includes('<b>회색</b>'));

// 5. 조각을 다시 합치면 원본과 같다
const parts = [];
for (let i = 0; i < 2; i++) parts.push(Buffer.from(await (await call(`/t/testkey1/chunk?id=${sub.id}&seq=${i}`)).text(), 'base64'));
assert.ok(Buffer.concat(parts).equals(bytes));
assert.equal((await call(`/t/wrongkey/chunk?id=${sub.id}&seq=0`)).status, 404);

console.log('모든 점검 통과');
