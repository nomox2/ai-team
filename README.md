# AI 팀 사무실 (로컬 앱)

대표 맥에서만 도는 사무실 프로그램. Claude Code 터미널을 열지 않고 버튼으로 하네스를 돌린다.

이 저장소에는 사무실 앱(`server.mjs`, `public/`)만 있다. 하네스 본체(`runs/`, `harness/`, `docs/`, `.claude/`)는 작업 폴더 `AI_team`에 있고, 앱은 그 폴더를 읽고 거기서 하네스를 실행한다.

- 켜기: `node server.mjs` → http://127.0.0.1:4777
- 끄기: `lsof -ti :4777 | xargs kill`
- 4777을 다른 프로그램이 쓰고 있으면 포트를 바꾼다: `OFFICE_PORT=4778 node server.mjs`
- 작업 폴더는 이 폴더 옆의 `../AI_team`이다. 다른 곳이면 `OFFICE_ROOT=/경로/AI_team node server.mjs`
- `claude`를 못 찾으면 `CLAUDE_BIN=/경로/claude`로 알려 준다.
- 맥 앱: `bash make-mac-app.sh`로 `~/Applications/AI 사무실.app`을 만든다 (이미 있으면 새로 만든다). 더블클릭하면 서버를 켜고 브라우저로 연다. 포트를 바꾸려면 `OFFICE_PORT=4778 bash make-mac-app.sh`. 서버 기록은 `~/Library/Logs/AI-사무실/server.log`.
- 앱마다 하네스 폴더가 따로면 앱도 따로 만든다: `OFFICE_NAME="포트폴리오 사무실" OFFICE_ROOT=~/Desktop/포트폴리오 OFFICE_PORT=4779 bash make-mac-app.sh`. 앱마다 포트를 다르게 하면 여러 개를 동시에 열 수 있다. 새 앱용 하네스 폴더는 `ai-team-harness`의 `new-app.sh`로 만든다.

## 하는 일
- `AI_team/runs/`의 가장 최근 실행을 읽어 단계·시안·기록을 보여준다 (3초마다, 실행 중엔 1.5초).
- 요청 버튼(이어서 진행 · 새 실행 · 직원 질문) → 뒤에서 `claude -p`를 실행한다. 구독 사용량으로 처리된다.
  - 훅·verify.mjs·에이전트 설정은 Claude Code가 그대로 적용한다. 허용 도구는 `server.mjs`의 `HARNESS_TOOLS`.
- "새 실행"은 화면을 고르지 않는다. 모아가 PRD 기준으로 리서치하고, 하루가 P2에서 만들 화면을 정한다 (범위는 덧붙일 말로 줄 수 있다). 실행 이름은 `날짜-run`(같은 날 두 번째부터 `-run-2`).
- 승인·반려 버튼 → Claude를 거치지 않고 `harness/scripts/approve.mjs`를 바로 실행한다 (승인 단계일 때만).
- 실행 기록: `AI_team/office-app/logs/<id>.jsonl` (git에 안 올라감)

## 안전
- 127.0.0.1에서만 열리고, Host 헤더가 localhost가 아니면 거절한다.
- 버튼 요청은 서버가 켤 때마다 새로 만드는 토큰이 있어야 받는다 (다른 웹사이트가 대신 누르지 못하게).
