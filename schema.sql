-- 제출물 한 건이 한 줄
CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  student_no TEXT NOT NULL,
  name TEXT NOT NULL,
  team TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  script TEXT NOT NULL DEFAULT '', -- 고백은: 붙여넣은 공연 대본
  file_name TEXT NOT NULL DEFAULT '',
  file_size INTEGER NOT NULL DEFAULT 0,
  file_chunks INTEGER NOT NULL DEFAULT 0,
  token TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- PPT 파일은 D1 한 칸 2MB 제한 때문에 base64 조각으로 나눠 저장
CREATE TABLE IF NOT EXISTS file_chunks (
  sub_id INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (sub_id, seq)
);

-- 교사용 주소의 열쇠는 코드가 아니라 여기에 둠 (저장소가 공개여도 드러나지 않게)
CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 학생 한 명이 한 줄. 비밀번호는 그대로 두지 않고 소금을 섞은 해시만 저장
CREATE TABLE IF NOT EXISTS students (
  student_no TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  salt TEXT NOT NULL,
  hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- 같은 학생의 같은 종류는 한 줄만 (다시 내면 그 줄을 고침)
CREATE UNIQUE INDEX IF NOT EXISTS one_per_kind ON submissions (student_no, kind);
