# 용어 확정 — agent-control-plane 이 SSOT 다

확정: 오너 결정 2026-08-14. 작성: CTO 총괄. 저장소 반입: 이 커밋.

이 파일이 단어의 정본이다. `scripts/verify-terminology.mjs` 가 금지어를 검사하며,
`pnpm terminology` 로 단독 실행할 수 있고 CI 가 매 푸시마다 돌린다. 규약이 문서에만
있으면 지켜지는지 알 수 없고, 검사에만 있으면 왜 그런지 알 수 없다 — 둘 다 둔다.
근거 자료: `~/projects/agent-control-plane` 전수(234파일 90,172줄),
`~/.hermes/bridge/same-session-acp` 전수(12파일 16,084줄), `~/.hermes/bridge/ssot/SSOT.md`.

**agent-control-plane 이 단일 SSOT 다.** Hermes 쪽 상태는 파생이며, 아래
"흡수 목록"이 끝나면 Hermes SSOT 는 은퇴한다. 충돌 시 ACP 가 이긴다 — 예외 없다.

이 문서는 구현 계획이 아니라 **단어의 뜻을 못 박는 문서**다. 지금 두 시스템이
같은 단어를 다른 뜻으로 쓰고 있고, 그대로 합치면 구현자가 그때그때 한쪽을
고른다. 진 쪽 성질은 조용히 사라지고, 사라진 줄도 모른다.

---

## 1. 충돌하는 단어와 확정된 뜻

각 행: **확정된 뜻** / 그 단어를 쓰던 다른 용법은 **무엇으로 바꿔 부르는가**.

### ACP (신설)

| | |
|---|---|
| **확정** | **agent-control-plane** — 이 저장소. 문서·이슈·커밋에서 `ACP` 는 언제나 이것이다 |
| **금지** | **Agent Client Protocol** 을 `ACP` 로 줄여 쓰지 않는다. 그건 에디터(VS Code·Zed·JetBrains)가 에이전트에 붙는 별개 프로토콜이고 이 저장소와 아무 관계가 없다 |
| **대체어** | 그건 **Agent Client Protocol** 이라고 전부 적는다. `hermes acp` 하위명령이 그것이다 (`hermes --help`: *"Run Hermes Agent as an ACP (Agent Client Protocol) server"*) |
| **왜** | 2026-08-17 에 실제로 오독을 낳았다. 프로세스 목록에 `buzz-acp --agent-command hermes --agent-args=acp` 가 떠 있어서 **CEO 가 컨트롤 플레인 위에서 도는 것처럼 보인다.** 아니다 — 그건 에디터 프로토콜 서버다. 두 ACP 가 같은 약어를 쓰는 한, 프로세스 목록은 확인이 아니라 오답의 출처다 |

**지금 CEO 는 컨트롤 플레인 위에서 돌지 않는다.** 추론이 아니라 측정이다: `agentcpd` 는 설치만 되고 한 번도 로드된 적이 없으며(#564), 배포 DB 는 `sessions` 0 · `assignments` 0 이다. Role 을 쥔 대화 액터가 하나도 없다는 뜻이고, 위에서 돌고 있다면 있어야 한다. `~/.hermes/bridge/bridge-supervisor.sh` 에 `agent-control-plane` 이나 `agentcpd` 언급도 0건이다.

`~/.hermes/bridge/ssot/STATUS.json` 은 `ACP_SINGLE_SSOT__HERMES_LEGACY_STATE_SUBORDINATE` 를 선언한다. **선언이 아직 사실이 아니고**, 이름 충돌이 그 간극을 가려 왔다. 그래서 P1·P3 는 증명 항목이 아니라 **그 선언을 사실로 만드는 경로**다.

### session

| | |
|---|---|
| **확정** | ACP `assignments` 가 Role 을 묶는 대상. 교체 가능한 모델 런타임. 장애복구로 바뀌는 것이 정상이고 오너 승인이 필요 없다. (PRD:17 "Logical Role 을 교체 가능한 Model Runtime Session 에 동적 Binding") |
| **금지** | "오래 살고 트랜스크립트를 가진 대화 상대" 를 session 이라 부르지 않는다 |
| **대체어** | 그건 **conversational actor (대화 액터)** 다 |
| **왜** | 두 뜻이 정확히 반대다. Hermes 는 "안 바뀌었음" 을 증명하려 싸우고 ACP 는 "바꿔도 된다" 가 기능이다. 같은 단어로는 둘 다 표현할 수 없다 |

### conversational actor (신설)

| | |
|---|---|
| **확정** | 트랜스크립트를 소유하고, 원일이 Remote Control · Buzz · 텔레그램 어느 통로로 접근하든 **같은 히스토리에 도달하는 대상**. 수명이 길다. 교체는 오너 승인이 필요한 세대 회전이다 |
| **관계** | `assignments` 행은 Role 을 **conversational actor 에** 바인딩한다. 모델 런타임에 직접 바인딩하지 않는다. 장애복구는 대화 액터 *안에서* 런타임을 갈아끼우고, 대화 액터 자체가 사라졌을 때만 새 세대를 만든다 |
| **왜 필요** | 이 구분이 없으면 ACP 의 failover 가 원일이 대화 중인 CTO 를 조용히 회전시킨다. 원일은 상대가 바뀐 줄 모른 채 맥락을 잃는다 |

### actor

| | |
|---|---|
| **확정** | ACP `assignments.role_key` 를 현재 보유한 주체. "누가 그 역할인가" 의 답 |
| **금지** | Buzz 의 `buzz_actor_id` 를 actor 라고 줄여 부르지 않는다 |
| **대체어** | 그건 **channel identity (채널 신원)** — 특정 전송 표면에서의 pubkey 신원일 뿐 역할이 아니다 |
| **왜** | `sessions.buzz_actor_id` 는 "이 채널에서 인증된 신원" 이고, 역할 보유는 `assignments` 가 정한다. 둘을 같은 말로 부르면 "allowlist 에 있는 이름" 이 곧 권한처럼 읽힌다 — ACP 가 명시적으로 금지하는 오해다 |

### SSOT

| | |
|---|---|
| **확정** | agent-control-plane. 그 안에서 PRD §2 가 정한 4분할을 그대로 쓴다 — Portable Project Contract = 승인된 Manifest Digest / Local Checkout Binding = Repository Registry / Dynamic Runtime = SQLite / Final Runtime Authority = `agentcpd` |
| **금지** | `~/.hermes/bridge/ssot/` 를 SSOT 라고 부르지 않는다 |
| **대체어** | **Hermes legacy state (레거시 상태)**. 흡수 목록이 끝나면 은퇴한다 |
| **왜** | 두 SSOT 가 공존하면 "액터는 맞는데 보드가 따로 노는" 상태가 생긴다. 그건 두 문서가 각자 금지한 바로 그 실패다 |

### CTO

| | |
|---|---|
| **확정** | `PRIMARY_CTO` 역할을 보유한 conversational actor. 프로젝트당 하나 |
| **금지** | tmux 세션이나 프로세스를 CTO 라고 부르지 않는다 |
| **대체어** | 그건 **attachment (접속)** — 대화 액터에 붙은 여러 통로 중 하나 |
| **왜** | tmux 창 두 개가 같은 대화 액터에 붙어 있으면 CTO 가 둘이 아니라 하나다. 지금 `cto-census` 가 tmux 를 세는 것은 과도기 근사일 뿐이며, 통합 후에는 `assignments` 를 세야 한다 |

### binding

| | |
|---|---|
| **확정** | `assignments` 행 하나. `role_key` 당 ACTIVE 는 최대 하나(부분 유니크 인덱스), `binding_generation` 은 단조 증가, 식별 컬럼 불변, 취소는 종단 |
| **금지** | 라우팅 설정이나 채널 매핑을 binding 이라 부르지 않는다 |
| **대체어** | 그건 **route (경로)** 다 |

### attestation

| | |
|---|---|
| **확정** | "이 연결 반대편이 정확히 그 프로세스임" 의 커널 수준 증명 — `LOCAL_PEERPID` / `LOCAL_PEEREPID` / `LOCAL_PEERCRED`, 프로세스 시작시각(마이크로초), 소켓·트랜스크립트 `dev`/`ino`, 연결 전후 재관측 |
| **주의** | ACP 안에 이미 "reviewer isolation attestation" 이라는 다른 용법이 있다. 그건 **isolation attestation** 으로 한정해 부른다 |
| **왜** | 이 증명은 Hermes 가 가진 가장 단단한 것이고 ACP 에는 없다. 이름이 겹치면 흡수 과정에서 "이미 있다" 고 오판한다 |

### evidence

| | |
|---|---|
| **확정** | ACP `run_artifacts` — 내용 주소 지정, 불변, capability 토큰 + DB 트리거로 이중 강제, candidate snapshot digest 에 결박 |
| **금지** | 사람이 손으로 쓴 receipt 파일을 evidence 라고 부르지 않는다 |
| **대체어** | 그건 **report (보고)** 다 |
| **왜** | ACP 의 evidence 는 소스가 바뀌면 자동 stale 이 된다(CP-HI-06). 손으로 쓴 파일은 그 성질이 없다. 같은 말로 부르면 stale 판정이 적용되는 줄 착각한다 — 실제로 `evidence/review/*.json` 이 지금 그 상태다 |

### gate

| | |
|---|---|
| **확정** | `acp-production-gate` — Trusted Credential 로만 생성되는 GitHub check. 이름이 아니라 **creator identity + payload provenance** 로 검증된다 |
| **금지** | Hermes STATUS.json 의 게이트 문자열을 gate 라 부르지 않는다 |
| **대체어** | 그건 **phase marker (단계 표시)** — 진행 상태 라벨이지 머지 술어가 아니다 |

### run

| | |
|---|---|
| **확정** | ACP `runs` 행. `QUEUED → ACTIVE → … → COMPLETED` 상태 기계. 완료 판정 권한은 `agentcpd` 만 갖는다 |
| **주의** | Hermes 에는 대응물이 없다. "작업"·"태스크"를 run 이라 부르지 말고, ACP 어휘를 쓸 거면 `run` / `task` / `task_execution` 을 정확히 구분한다 |

---

## 2. ACP 가 Hermes 로부터 흡수해야 하는 것

> **2026-08-14 개정.** 최초 판의 3항목은 1차 소스 재검증에서 하나가 사실오류였고 둘이 과대
> 서술이었다. 아래가 정정본이다. 개정 전 문구는 이 절 끝에 남긴다 — 넓게 적힌 흡수 목록은
> 이미 있는 것을 다시 만들게 하므로, 무엇이 왜 좁아졌는지가 목록 자체보다 중요하다.

흡수는 3항목이 아니라 **스키마 1개 + 함수군 1개 + 증명 계약 1개**다.

### (1) 스키마 — `conversational_actor` 1급 엔티티화

`assignments` 가 모델 런타임이 아니라 conversational actor 에 바인딩한다. §5 에 실측 비용이
있다: 마이그레이션 1개 + 코드 참조 약 200곳, v15~v17 머지 후 v18.

**절단선.** 등가성 *증명 기계*(트랜스크립트 관측, origin 행 판정)는 ACP 밖에 남기고 어댑터
계약으로 두며 E2E 가 검증한다. 넓게 읽으면 채팅 라우팅이 control plane 에 들어오는 스코프
크리프가 된다. **ACP 는 대화 라우터가 아니다.**

### (2) 함수군 — peercred 최소본

`peercred.c` 126줄과 그 검증 래퍼만. **provenance 체제는 선택**으로 둔다 — 컴파일러 해시,
SDK 빌드, `/dev/fd` dlopen, Node 정확 핀을 통째로 가져오면 ACP 가 Node 업그레이드마다 재빌드와
provenance 재발급에 묶인다. T6 후보 동결에는 맞는 규율이지만 범용 데몬에는 과설계다.

**가치는 적대자 방어가 아니라 오식별 방지다.** 소켓이 0600 이므로 공격자는 같은 UID 뿐이고,
같은 UID 면 secret 도 읽는다. 실제로 막는 것은 PID 재사용과, 낡은 레지스트리가 엉뚱한 살아있는
프로세스를 가리키는 경우다.

필요한 지점은 둘뿐이다:
- **(a)** 데몬 재시작 후 이미 돌던 액터에 재바인딩할 때 — 부모 관계가 소실된 유일한 정상 경로
- **(b)** 데몬이 안 띄운 외부 액터 (owner-live 세션)

`agentcpd` 가 직접 띄운 자식은 부모-자식 관계가 신원을 주므로 `getProcessStart` 한 함수면 족하다.

### (3) 증명 계약 — 목적지에서의 exactly-once

**최초 판의 "ACP 의 outbox/ingress 는 유일성을 증명하지 않는다" 는 틀렸다.** `IngressGuard` 는
`inbound_messages` 에 대한 nonce replay 방어를 이미 갖고 있고, 그것이 **입장 시점 유일성**이다.

실제 갭은 좁다: **목적지에서의 exactly-once** — "그 액터의 히스토리에 정확히 한 번 들어갔고
정확히 한 번 응답했다". 그것만 없다. 넓게 적으면 이미 있는 nonce 방어를 다시 만든다.

### 흡수 대상 메커니즘이 물려주는 엣지케이스

어댑터를 가져오면 같이 오는 것들이다. 셋 다 어댑터 자체의 결함이 아니라 상수와 계약의 문제다.

| # | 증상 | 대응 |
|---|---|---|
| 1 | `OBSERVATION_TIMEOUT_MS` 10초 — 긴 추론 턴이 넘기면 프레임은 이미 소켓에 쓰였는데 호출자가 재시도해 `buildFrame` 이 새 nonce 를 만들고 **턴이 둘 생긴다** | "썼는지 모르면 UNKNOWN, 재시도 금지" 가 지금은 호출자 규약에만 있다. **코드로 내린다** — 타임아웃 반환값을 실패가 아니라 UNKNOWN 으로 구분하는 것부터 |
| 2 | `MAX_TRANSCRIPT_DELTA_BYTES` 1MB — 바쁜 액터가 관측 창 동안 1MB 를 넘기면 MALFORMED 로 접힌다. 83MB 활성 트랜스크립트에서 현실적이다 | 상한 상향 또는 분할 읽기 |
| 3 | `TURN_IN_PROGRESS` 단일 비행 — 어댑터당 동시 요청 거부라 CEO→CTO 트래픽이 직렬화된다 | 지금은 맞는 설계. 롤아웃 후 병목이 되므로 **의도된 제약으로 문서화** |

재독해에서 버그는 나오지 않았다 — routing-core 의 fd 고정, 이벤트 키 중복 거부,
`TARGET_DUPLICATE` 판정, 트랜스크립트 로테이션 시 fail-closed 모두 결함 없음.

### 개정 전 문구 (보존)

> 1. **프로세스 수준 attestation.** ACP 의 세션 신원은 `session_secret_hash` + `buzz_actor_id`
>    다. … same-session-acp 가 이걸 커널에 직접 물어서 해결한다. 흡수 대상 1순위.
> 2. **표면 등가성.** … `conversational actor` 개념이 들어가야 비로소 표현된다.
> 3. **ingress 유일성 증명.** … ACP 의 outbox/ingress 는 전달을 다루지 유일성을 증명하지 않는다.

1번의 "보안 다운그레이드" 프레이밍은 과장, 2번은 넓게 읽으면 스코프 크리프, 3번은 사실오류다.

## 3. 지금 즉시 적용되는 것

- **문서·커밋·이슈에서 위 금지어를 쓰지 않는다.** 특히 `session` 을 대화 액터
  뜻으로 쓰지 않는다. 이게 가장 자주 나올 혼동이다.
- **`cto-census` 는 과도기 도구다.** 지금 tmux 를 세는 것은 근사이며, 통합 후에는
  `assignments` 대 attestation 대조로 바뀐다. 스크립트 안에 그 교체 지점이
  함수 하나로 격리돼 있다.
- **`actor_cardinality` 는 개수가 아니라 집합이어야 한다.** CTO 는 자유롭게
  교체·삭제·추가된다. 개수를 박으면 온보딩마다 최상위 계약을 고치게 된다.
  현재 실제로 어긋나 있다 — 등록 3, 실제 4(repo-factory 미등록).
- **T6 봉인은 전송 독립 계약으로 서술한다.** `buzz-acp` 구현 세부로 적히면
  ACP 로 옮길 수 없다. 옮길 수 있게 적어야 흡수 1·3번이 성립한다.

---

## 4. 알려진 예산 항목 (결정 아님)

- **플랫폼 고정.** same-session-acp 는 Node 22.23.2 / darwin / arm64 에 못 박혀
  있고 컴파일러·SDK·헤더 해시까지 검사한다. ACP CI 도 macOS 전용이다. 흡수
  결과물은 macOS-arm64 + 정확한 Node 핀이며, Node 업그레이드는 재빌드 +
  provenance 재발급을 동반한다.
- **CP-HI-08 의 Linux 경로 미검증.** `memoryLimitForPlatform("linux")` 가 순수
  함수 반환값으로만 단언되고 행동으로 실행된 적이 없다. Linux 를 대상에 넣으면
  이것부터 채운다.
- **회전 비용.** CTO 를 ACP 아래로 옮기면 새 세대가 되고 E2E 를 다시 돌려야 한다.
  그래서 현 세대 E2E 를 먼저 한 번 남긴다 — 세운 적 없는 성질은 보존됐는지
  검증할 수 없다.

---

## 5. `conversational actor` 도입 비용 — 실측 (2026-08-14, main @6c721be)

§1 의 `conversational actor` 는 데이터 모델을 건드린다. "지금 정하면 마이그레이션 하나,
나중이면 여러 개" 라는 추정에 대해 실제로 센 숫자다.

### 마이그레이션 개수: 1 개로 가능하다

`assignments` 는 `session_id` 를 신원 컬럼으로 갖고, 그 위에 인덱스 4개·트리거 6개가 얹혀
있으며, 그 중 `assignments_owner_tuple` 은 `(role_key, binding_generation, session_id,
session_incarnation)` 복합 유니크 인덱스다. `runs` 가 이 튜플을 복합 FK 로 참조한다
(`schema.sql:295`). SQLite 에서 트리거·인덱스가 참조하는 신원 컬럼은 제자리 변경이 안 되므로
**`assignments` 와 `runs` 를 둘 다 재작성**해야 한다.

이 저장소에 이미 선례가 있다 — v13 (`v13-finalization-state-machine`) 이
`foreignKeysOffDuringApply: true` 로 `runs` 한 개를 76줄에 재작성했다. 마이그레이션 프레임워크는
한 마이그레이션 안에서 여러 테이블을 재작성할 수 있으므로, **두 테이블 재작성 + `conversational_actors`
신설을 v18 하나로 담을 수 있다.** 대략 v13 의 두 배 규모다.

즉 오너의 "하나" 추정은 마이그레이션 개수에 한해서는 맞다.

### 그런데 비용은 마이그레이션에 있지 않다

추정이 빗나가는 곳은 코드 표면이다. 신원 개념이 이동하면 같이 움직여야 하는 참조:

| 심볼 | src | tests | 계 |
|---|---:|---:|---:|
| `owner_session_id` | 54 | 46 | 100 |
| `sessionIncarnation` | 45 | 14 | 59 |
| `session_incarnation` | 14 | 12 | 26 |
| `owner_session_incarnation` | 13 | 7 | 20 |

`assignments` 를 언급하는 src 파일은 15개다. `session_id` 전체는 src 104 회지만 대부분
`sessions` 테이블 자신의 것이고 그건 안 바뀐다 — session 의 확정된 뜻(교체 가능한 모델 런타임)은
그대로다.

**따라서 실측 규모는 마이그레이션 1개 + 코드 참조 약 200곳이다.** 마이그레이션은 싸고 참조가 비싸다.

### 순서에 대한 결론

지금 하면 안 된다. 이유는 규모가 아니라 체인이다:

- main 은 `SCHEMA_VERSION = 14`
- `terra10/verifysec` 이 v15·v16 을 얹어 16
- `terra10/telegram` 이 그 위에 v17 을 얹어 17 (verifysec 위에 쌓인 것이고 충돌은 아니다 — v15·v16 정의가 동일하다)

conversational actor 는 v18 이며, **v15~v17 이 머지된 뒤 안정된 체인 위에서** 해야 한다. 지금
main 에 넣으면 세 레인이 전부 재번호를 받는다. 코드 참조 200곳도 같은 이유로 네 레인과 충돌한다.

`buzz-actor-qualified` 린트 규칙을 staged 로 둔 것도 같은 판단이다 — 규칙은 지금 넣되 이름 변경은
레인이 들어온 뒤에 한다.

---

## 6. 필드 이름은 계약이다

용어를 바꾸면 그 용어를 담은 **필드 이름**도 바뀐다. 그런데 산문과 필드는 틀렸을 때
결과가 다르다. 산문이 틀리면 사람이 읽다가 알아챈다. 필드가 바뀌면 읽는 쪽이 조용히
아무것도 못 읽는다 — 에러도 없이.

실제로 겪었다. §1 의 확정("STATUS.json 의 게이트 문자열은 gate 가 아니라 phase marker")을
적용하면서 CEO 가 `gate` 필드를 `LEGACY_FIELD__SEE_CURRENT_PHASE_MARKER` 로 바꾸고 실제
상태를 `current_phase_marker` 로 옮겼다. 개명은 지시대로였다. 그런데 그 순간 총괄의 감시가
3분간 멀었다 — 모니터가 `.gate` 를 읽고 있었고, 개명된 필드는 **아무것도 잘못되지 않은 채로**
옛 이름에서 사라졌다. 값이 `LEGACY_FIELD...` 문자열이 됐을 뿐이고 case 패턴은 그걸 모른다.

용어 변경이 감시를 끄는 데 3분이 걸렸다. ACP 가 SSOT 가 되면 이 필드 이름들이 모든 표면이
읽는 인터페이스가 되므로, 그때는 3분이 아니다.

### 규범 셋

1. **개명해도 옛 이름을 지우지 않는다.** 옛 키를 남겨 새 이름을 가리키게 한다. CEO 가 실제로
   한 `LEGACY_FIELD__SEE_CURRENT_PHASE_MARKER` 가 옳은 패턴이다 — 값 자체가 다음 목적지를
   말하므로, 옛 이름만 아는 소비자도 "사라졌다" 가 아니라 "옮겨갔다" 를 읽는다.
2. **읽는 쪽은 새 이름 우선, 옛 이름 폴백으로 짠다.** 한쪽만 읽는 소비자는 개명 시점에
   반드시 멀게 된다.
3. **개명은 이 문서에 기록한다** — 어떤 필드가 언제 무엇으로 바뀌었는지. 아래 표가 그 자리다.

### 개명 기록

| 날짜 | 표면 | 옛 이름 | 새 이름 | 옛 이름 상태 |
|---|---|---|---|---|
| 2026-08-14 | Hermes `STATUS.json` | `gate` | `current_phase_marker` | 유지, 값이 `LEGACY_FIELD__SEE_CURRENT_PHASE_MARKER` |

### 이 저장소에 이미 있는 같은 원칙

`src/core/reason-codes.ts` 에 270개 코드가 있고 `scripts/verify-reason-codes.mjs` 가 그중
`PUBLISHED` 38개를 append-only 로 강제한다 — 발행된 코드는 삭제도 개명도 안 된다. 그게 정확히
위 규범 1의 구현이며, 이미 한 번 실제로 작동했다: 용어 확정문의 `actor` → `channel identity`
개명이 `INGRESS_ACTOR_NOT_ALLOWLISTED` 에는 적용되지 **않는다**. 산문은 고치되 발행된 코드는
그대로 둔다. 외부 계약이 개명보다 우선한다.

SSOT 필드 이름에도 같은 보호를 적용할 수 있다. reason code 와 다른 점은 필드가 여러 표면에
흩어져 있어 단일 카탈로그가 없다는 것이므로, 먼저 카탈로그를 만들어야 한다 — 위 개명 기록 표가
그 시작이다.
