# AI 팀 사무실 (로컬 앱)

대표 맥에서만 도는 사무실 프로그램. Claude Code 터미널을 열지 않고 버튼으로 하네스를 돌린다.

- 켜기: `~/Applications/AI 사무실.app` 더블클릭 (서버가 꺼져 있으면 켜고 브라우저로 연다)
- 앱 다시 만들기: `bash office-app/make-mac-app.sh`
- 직접 켜기: `node office-app/server.mjs` → http://127.0.0.1:4777
- 끄기: `lsof -ti :4777 | xargs kill`

## 하는 일
- `runs/`의 가장 최근 실행을 읽어 단계·시안·기록을 보여준다 (3초마다, 실행 중엔 1.5초).
- 요청 버튼(이어서 진행 · 새 실행 · 직원 질문) → 뒤에서 `claude -p`를 실행한다. 구독 사용량으로 처리된다.
  - 훅·verify.mjs·에이전트 설정은 Claude Code가 그대로 적용한다. 허용 도구는 `server.mjs`의 `HARNESS_TOOLS`.
  - Apify는 "새 실행"에서 대표가 켤 때만 허용한다.
- 승인·반려 버튼 → Claude를 거치지 않고 `harness/scripts/approve.mjs`를 바로 실행한다 (승인 단계일 때만).
- 실행 기록: `office-app/logs/<id>.jsonl` (git에 안 올라감)

## 안전
- 127.0.0.1에서만 열리고, Host 헤더가 localhost가 아니면 거절한다.
- 버튼 요청은 서버가 켤 때마다 새로 만드는 토큰이 있어야 받는다 (다른 웹사이트가 대신 누르지 못하게).
