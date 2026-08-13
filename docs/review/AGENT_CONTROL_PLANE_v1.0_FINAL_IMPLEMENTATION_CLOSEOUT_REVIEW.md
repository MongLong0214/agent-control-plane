# Agent Control Plane v1.0 — Final Implementation Closeout & Production-Readiness Master Review

> **대상 저장소:** `https://github.com/MongLong0214/agent-control-plane`
> **검수 기준 브랜치:** `main`
> **검수 기준 커밋:** [`312772fba9a64adc760f0766bfa9200fadeb3b78`](https://github.com/MongLong0214/agent-control-plane/commit/312772fba9a64adc760f0766bfa9200fadeb3b78)
> **검수 일자:** 2026-08-13, Asia/Seoul
> **문서 버전:** `1.0 FINAL CLOSURE SSOT`
> **현재 판정:** **BLOCK — v1 Production-ready 아님**
> **최종 목표:** 이 문서 하나로 v1 구현·실배포·실테스트·운영 기준선·release를 종결하고, ACP 2.0의 허용된 Offline/Shadow 개발 범위와 Gate A를 명확히 연결한다.

---

## 문서 권위와 사용법

이 문서는 다음 이전 리뷰를 **대체하는 최종 구현 종결 정본**이다.

```text
AGENT_CONTROL_PLANE_FINAL_A_TO_Z_PRODUCTION_REVIEW_v1.0.md
AGENT_CONTROL_PLANE_FINAL_PRODUCTION_READINESS_REVIEW_AZ_2026-08-13.md
AGENT_CONTROL_PLANE_FINAL_PRODUCTION_READINESS_REVIEW_2026-08-13.md
```

규범 우선순위는 다음과 같다.

```text
1. AGENT_CONTROL_PLANE_PRD_v1.3_FINAL.md
   = v1 제품·도메인·역할·기능 계약

2. 이 문서
   = 구현 종결, 보안 경계, Production Acceptance, ACP 2.0 Entry 보완 계약

3. ADR / tickets / GitHub issues
   = 구현 세부와 작업 추적

4. README / 일반 설명 문서
   = 비규범적 사용 안내
```

PRD와 이 문서가 충돌하는 것처럼 보이면 다음 원칙으로 해석한다.

- 제품 목표와 역할 경계는 PRD를 따른다.
- 실제 권위 강제, 보안, fail-closed, live acceptance, 운영 배포와 2.0 기준선은 이 문서를 따른다.
- Gate를 낮추거나 PRD 요구를 조용히 삭제하는 방식으로 충돌을 해결하지 않는다.
- 구현이 문서보다 약하면 구현을 고친다. 문서를 구현 수준으로 낮추지 않는다.

구현 에이전트는 이 문서 전체를 읽은 뒤 기존 GitHub issue를 재사용하고, 없는 결함만 새 issue로 생성한다. **테스트 이름, interface 존재, mock success만으로 완료를 선언할 수 없다.** 각 항목은 production entry point와 live evidence까지 닫혀야 한다.


### 상태 용어

```text
OPEN        아직 구현 또는 검증되지 않음
CODE_DONE   코드와 deterministic regression은 완료
WIRED       production composition/entry point에 실제 연결됨
LIVE_PROVEN 실제 daemon/provider/channel/GitHub 환경 evidence 완료
CLOSED      current HEAD의 fresh independent review까지 통과
WAIVED      Owner가 잔여 위험을 명시 승인; P0/Hard Invariant에는 사용 금지
```

### Finding 종료 규칙

Blocker/Major를 닫으려면 다음 네 가지가 모두 필요하다.

```text
1. exact fixing commit SHA
2. 결함을 재현하고 수정 전 실패·수정 후 통과하는 load-bearing regression
3. production entry point 또는 live canary evidence
4. PRD/ADR/운영 문서/Issue SSOT의 정합성
```

단순히 issue를 close하거나 test 이름에 scenario ID를 붙이는 것은 종료가 아니다.

### 한눈에 보는 최종 실행 순서

```text
W0 Repository/CI 보호
→ W1 Completion Authority + daemon finalizer
→ W2 GitHub Trust + Human Gate + Branch Contract
→ W3 CTO Handoff + Continuity + Worker provenance
→ W4 Reviewer + Provider Usage + Write Boundary
→ W5 Single Daemon + Channels + Migration + launchd
→ W6 실제 Full Vertical E2E + Multi-repo/Release/Hotfix
→ W7 3개 Dogfood Project / 30 Lifecycle + Fresh A–Z Review
→ v1.0.0 Tag/Release
→ ACP 2.0 Pre-Gate Offline 개발 즉시 허용
→ Gate A 충족 후 Feasibility Slice
```

---

# Part I. 현재 Snapshot과 최종 방향

## 1. 검수 시점 GitHub Snapshot

| 항목 | 현재 관측값 |
|---|---|
| `main` SHA | `312772fba9a64adc760f0766bfa9200fadeb3b78` |
| 최신 `project-ci` | 성공 |
| 최신 알려진 테스트 결과 | 516 passed / 1 skipped |
| Open `review-blocker` | 4 |
| Open `review-major` | 15 |
| 존재 브랜치 | `main`, `dev`, `integration/r4` |
| Branch protection | 세 브랜치 모두 없음 |
| CI 실행 명령 | `pnpm typecheck`, `pnpm test` |
| CI에서 빠진 명령 | `pnpm build`, `pnpm lint`, `pnpm trace`, `node scripts/ssot-report.mjs` |
| GitHub App gate | 미실행 |
| Buzz live delivery | 미실행 |
| Telegram production ingress | listener/routing 미연결 |
| Real 2-repo ordered merge | 미실행 |
| GitHub Release/Tag | 0 |
| local independent rerun | 이 리뷰 환경에서는 repository clone 불가; GitHub exact source·Actions·evidence로 검토 |

현재 snapshot은 **코드가 비어 있다는 뜻이 아니다.** v1은 이미 substantial runtime을 구현했다. 그러나 actual production composition과 live external path가 끝까지 연결되지 않았다.

## 2. 최종 의사결정

```text
v1 Architecture Direction       APPROVE
현재 main의 Production Release   BLOCK
v1 전면 재설계                    NO
기존 P0/P1 종결                  REQUIRED
실제 Mac Deployment              REQUIRED
30-Run Baseline                  REQUIRED FOR ACP2 GATE A
ACP 2.0 기능을 v1에 혼입          PROHIBITED
```

v1의 최종 목적은 다음 한 문장이다.

> **Hermes가 제출한 Managed Project Work를 단일 `agentcpd` 권위 아래에서 교체 가능한 CTO/worker가 실행하고, exact evidence·독립 review·Owner/CEO authority·trusted GitHub finalization·장애 복구를 거쳐 실제로 merge된 결과까지 만드는 로컬 Production Runtime.**

## 3. ACP 2.0이 생겼다고 v1에 추가하면 안 되는 것

다음은 ACP 2.0의 연구·증폭 계층이며 v1 closeout 범위가 아니다.

```text
Context Compiler
Decision-space Reducer
Task Eligibility / Mid-tier Qualification
Smallest Graph Optimizer
Adaptive Topology Generator
Failure Localization Engine
Knowledge Graph / Context Graph
Obsidian Integration
Lesson / Playbook / Policy Promotion
Model Substitution Router
Online self-improvement
```

이 기능을 지금 v1에 넣으면 production blocker를 흐리고 baseline을 오염시킨다.

## 4. ACP 2.0 때문에 v1에 반드시 남겨야 하는 기반

2.0 기능이 아니라 **측정 가능성**만 v1에 포함한다.

```text
exact role/provider/model/effort identity
adapter + harness + prompt/rule bundle version/digest
Run/Task DAG 구조와 observed parallel width
provider-reported usage와 estimated usage의 분리
verification/review/revision/merge/post-merge facts
owner/CEO intervention count
task class tag
immutable redacted run export
```

이 기반이 없으면 2.0에서 Sonnet/Terra와 Opus/Sol을 비교해도 어떤 향상이 모델 때문인지 시스템 때문인지 알 수 없다.


## 5. Repo Factory 범위의 최종 해석

ACP v1 closeout에서 **Repo Factory 제품 자체를 이 저장소 안에 재구현하지 않는다.** 다음 경계를 고정한다.

```text
ACP v1이 반드시 완료할 것
- RepoFactoryResult / ACPBootstrapActivationResult versioned schema
- Project Manifest import와 provenance 검증
- Project registration
- BOOTSTRAP_CTO / PRIMARY_CTO activation
- Buzz 연결·Handoff/ACK·Doctor 결과
- schema-valid contract canary

별도 Repo Factory 저장소가 담당할 것
- Seed / Research / PRD / ADR / Ticket
- repository genesis
- main/dev/feature/task/release/hotfix 생성
- GitHub/CI provisioning
- Portable Manifest / RepoFactoryResult 생산
```

`AGENT_CONTROL_PLANE_PRD_v1.3_FINAL.md` §42의 Repo Factory bootstrap Acceptance는 ACP 측에서 **실제 contract를 소비하여 activation을 끝내는 black-box canary**로 닫는다. Repo Factory의 내부 scheduler·reviewer·merge runtime을 ACP에 복제하지 않는다.

다만 실제 Repo Factory 제품과의 통합 E2E는 ACP v1 release 이후 별도 통합 단계에서 수행할 수 있으며, ACP 2.0 Production Gate B 전에는 반드시 완료해야 한다. 이 해석은 ACP v1을 별도 제품에 불필요하게 결박하지 않으면서 integration contract를 거짓으로 통과시키지 않기 위한 것이다.

## 6. 기존 리뷰 대비 이번 최종본의 추가·승격 사항

1. **Clean-install authority bootstrap**을 P0로 추가한다. Fresh DB에서 Hermes CEO session과 binding을 안전하게 등록할 공식 경로가 필요하다.
2. **Versioned migration + backup/restore + launchd reboot drill**을 단순 운영 개선이 아니라 v1 release blocker로 승격한다.
3. **Single-daemon authority**를 명확히 한다. `agentctl` mutation은 동일 DB에 별도 `ControlPlane`을 열지 않고 daemon RPC를 사용해야 한다.
4. **ACP 2.0 Baseline Readiness Contract**를 추가한다. 이는 topology 최적화가 아니라 v1 실행 facts의 정확한 관측 계약이다.
5. **ACP 2.0 Gate A**를 v1 exit 뒤에 명시한다. v1 PASS 후에도 30개 real Run 기준선 없이 production model substitution을 시작하지 않는다.

---

# Part II. A–Z 상세 Production Findings

아래 상세 Findings는 이전 최종 A–Z 리뷰의 검증 내용을 통합한 것이다. 이후 Part III~IX의 closeout 계약과 충돌하면 뒤쪽의 더 구체적인 완료 계약이 우선한다.

## 0. 최종 결론

현재 `agent-control-plane`은 문서나 스켈레톤 수준이 아니다. 다음 핵심 구성요소가 실제 TypeScript·SQLite·테스트로 구현되어 있다.

- Run / Task / Session / Role / Binding Generation
- SQLite 기반 상태·불변식·transaction
- Candidate Snapshot / digest / stale evidence 차단
- Verification Sandbox / disposable worktree
- 독립 Blind Review packet / coverage
- Production-Ready Packet / CEO decision
- Managed Write Guard / Resource Claim
- GitHub Integration Kernel
- Provider Capacity / Continuity / Doctor / Watchdog
- Repo Factory activation contract
- MCP / Buzz / Telegram ingress primitives

특히 exact candidate, immutable evidence, stale-generation fencing, append-only receipt, negative test 중심의 품질 문화는 개인 프로젝트 범위를 확실히 넘어선다.

그러나 **“구성요소가 존재한다”와 “실제 운영 파이프라인이 끝까지 연결된다”는 다르다.** 현재 `main`에는 다음과 같은 치명적인 단절이 남아 있다.

1. Production-ready packet 이후 Run 상태가 `ACTIVE`가 아니므로 trusted GitHub gate와 merge가 실행될 수 없다.
2. CEO CONFIRM 이후 GitHub Kernel을 자동으로 호출하는 daemon-owned finalizer가 없다.
3. Human Gate의 authoritative 판정과 merge 판정이 서로 달라 Owner 결정을 우회할 수 있다.
4. 정상 CTO handoff는 실제 MCP 인증 경로에서 교착된다.
5. `release/* → main`, `hotfix/* → dev|release/*`의 source lineage가 잘못 모델링되어 확정한 브랜치 전략이 깨진다.
6. Continuity Kernel은 plan과 `failover()`를 구현했지만 provider 장애 시 자동 role rebind를 호출하는 production trigger가 없다.
7. “모든 Mode의 GPT-5.6 Sol xhigh Blind Review”가 실제로는 동작하지 않고 Claude fallback이 정상 경로가 된다.
8. Buzz·Telegram·Provider usage·GitHub App·multi-repo merge가 실환경에서 닫히지 않았다.
9. `agentctl`이 daemon RPC가 아니라 동일 SQLite에 두 번째 `ControlPlane`을 생성해 single runtime authority를 훼손한다.
10. 현재 “real E2E”는 real Claude와 sandbox를 사용하지만 Hermes/Buzz/MCP/worker/GitHub finalize를 우회한 component integration test다.

따라서 현재 등급은 다음이 정확하다.

```text
Prototype                 PASS
Architecture Candidate    PASS
Functional Alpha          PASS
Hardened Alpha            PASS
Production Candidate      CONDITIONAL
Production Ready          BLOCK
Repo Factory 진입         HOLD
```

---

## 1. 판정 요약

| 영역 | 점수 | 판정 |
|---|---:|---|
| 제품 비전·역할 분리 | 9.2 | 매우 강함 |
| Domain Model·SSOT | 8.6 | 강함 |
| SQLite 불변식·transaction | 8.8 | 강함 |
| Evidence·stale fencing | 8.8 | 강함 |
| Verification Sandbox | 8.0 | 강하지만 macOS 한계 존재 |
| Blind Review 설계 | 7.2 | packet/coverage 강함, 실제 모델·격리 미완 |
| GitHub Kernel 내부 로직 | 7.5 | 세밀하지만 실제 finalization 경로 단절 |
| CTO lifecycle | 6.3 | 개념은 강함, 정상 handoff 경로 차단 |
| Capacity·Continuity | 6.7 | 계산은 고도화, 실제 수집·자동 rebind 미완 |
| Doctor·Watchdog·Repair | 7.8 | read-only 진단 분리가 좋음 |
| MCP·Ingress | 7.3 | 인증 primitives 좋음, Telegram/Buzz 실제 wiring 미완 |
| 운영 배포 | 4.5 | App·Buzz·launchd·migration·branch protection 미완 |
| 테스트 품질 | 8.5 | negative test 밀도 우수 |
| 실제 E2E 증명력 | 5.2 | real component는 있으나 운영 경로 우회 |
| **종합 구현 수준** | **7.5/10** | 높은 수준의 hardened alpha |
| **Production Readiness** | **5.5/10** | 현재 운영 승인 불가 |

---

## 2. 검수 범위와 방법

### 2.1 확인한 범위

- 현재 `main` commit 및 전체 repository tree
- `README.md`, PRD 2개, ADR 8개, Acceptance ledger, ticket DAG
- 최신 GitHub Actions run과 test/typecheck 결과
- `src/db`, `run`, `session`, `cto`, `continuity`, `capacity`, `review`, `verify`
- `guard`, `claims`, `github`, `doctor`, `outbox`, `ingress`, `buzz`, `mcp`
- `bootstrap`, `cli`, `daemon`, launchd 설정
- SIMPLE / STANDARD / GUARDED real-run evidence
- 열린 `review-blocker`, `review-major`, `acceptance`, `prerequisite` 이슈
- `main/dev/integration` branch와 protection 상태
- Repo Factory integration boundary

### 2.2 증거 기준

다음 우선순위로 판정했다.

```text
production entry point
> composition-root wiring
> persistent state/DB constraint
> integration/scenario test
> unit test
> documentation claim
```

테스트 이름에 Requirement ID가 있다고 구현된 것으로 인정하지 않았다. **실제 daemon/MCP/CLI 경로가 해당 코드를 호출하는지**를 별도로 확인했다.

### 2.3 한계

이 리뷰 환경에서는 public repository를 로컬 clone하여 재실행할 수 없었다. 따라서 독립적인 로컬 test run 대신 다음을 사용했다.

- exact commit의 전체 GitHub source
- latest GitHub Actions result와 job log
- repository가 보관한 evidence
- exact commit을 대상으로 등록된 독립 review issues

즉 이 문서는 **코드·운영 경로·CI·증거를 결합한 전수 정적 리뷰**이며, GitHub App/Buzz/Telegram/provider quota가 실제 설치된 host에서 수행한 deployment acceptance test는 아니다. 그 live acceptance 자체가 현재 미완료 항목이다.

---

## 3. 현재 증명된 것과 증명되지 않은 것

### 3.1 증명된 것

- SQLite가 다수의 uniqueness·monotonicity·append-only 제약을 강제한다.
- Candidate Snapshot이 repository별 head/tree/diff를 고정한다.
- Verification은 disposable worktree에서 exact head를 사용한다.
- candidate-controlled Git hook을 끄고 materialized tree를 재검증한다.
- stale owner generation의 결과를 task state에 반영하지 않는다.
- Blind Review packet이 diff/verification/coverage를 digest로 결박한다.
- review omission이 있는 PASS를 그대로 production PASS로 승격하지 않는다.
- outbox message에 roleKey, bindingGeneration, targetSessionId, payloadDigest가 있다.
- provider capacity unknown/stale를 기본적으로 fail-closed 처리한다.
- Owner decision은 ProductionGate 내부에서는 admitted ingress receipt와 current candidate에 결박된다.
- Fake/modelled GitHub API에서 exact-head, gate creator, merge replay, post-merge predicate가 상당히 폭넓게 검증된다.
- SIMPLE/STANDARD/GUARDED에서 real Claude invocation·local sandbox·fresh review를 사용한 기록이 있다.

### 3.2 아직 증명되지 않은 것

- CEO CONFIRM 이후 real GitHub App check-run publish → merge → post-merge의 전체 흐름
- daemon이 GitHub Kernel을 자동으로 호출하는 production finalize path
- real two-repository ordered merge
- 정상 CTO drain → handoff → ACK → binding generation switch
- GPT-5.6 Sol xhigh의 mandatory blind review
- GPT·Claude·Grok 실제 `/usage` 자동 수집
- provider outage → RoleCoveragePlan → automatic role failover
- Buzz에 연결된 actor가 정확히 bound Claude session으로 실행되고 결과를 돌려주는 과정
- Telegram message → Hermes → ACP → Buzz CTO 실제 통합
- 3개 프로젝트·30 lifecycle 이상에서 false completion 등 0건
- `main/dev` branch protection과 required checks
- schema upgrade가 실제 state를 보존하는 migration
- launchd를 통한 재부팅 후 production startup

---


## 4. v1 Hard Invariant 최종 Closure Matrix

| Invariant | 최종 강제 위치 | 현재 상태 | Release Closure |
|---|---|---|---|
| CP-HI-01 Managed Write | ACP-owned worktree/write adapter 또는 명시적으로 축소된 source-write contract + claim + GitHub mediation | 부분 | P0-12 + P1-03 CLOSED |
| CP-HI-02 Single Runtime Authority | daemon-only writable SQLite/capabilities + authenticated operator RPC | 실패 | P0-13 CLOSED |
| CP-HI-03 Candidate Pinning | immutable contract/manifest/snapshot digest + finalizer recheck | 강함 | full vertical stale test PASS |
| CP-HI-04 Independent Quality | complete producer history + fresh isolated reviewer + independent CEO | 부분 | P0-07/08 + P1-02 CLOSED |
| CP-HI-05 Trusted GitHub Credential | daemon-only GitHub App installation-token provider | 미완 | P0-14 LIVE_PROVEN |
| CP-HI-06 Exact Evidence | exact snapshot/verifier/review/GitHub receipts/post-merge evidence | 강함·운영 미완 | external live E2E PASS |
| CP-HI-07 Human non-delegable | authenticated Owner receipt + one latest-wins/current-candidate predicate | merge 결함 | P0-03 CLOSED |
| CP-HI-08 No Silent Degradation | explicit unsupported/degraded/survival + measured isolation | 부분 | P0-06/08/11 CLOSED |
| Role ≠ Runtime Model | logical Role + versioned runtime/capability policy | 구조상 강함 | model-hardcode regression PASS |
| State Upgrade Safety | ordered migration + backup/restore + reboot reconcile | 없음 | P0-17 CLOSED |
| ACP2 Baseline Integrity | exact model/graph/usage/quality facts + immutable export | 부분 | P0-18 + V1-BR CLOSED |
| v1 Scope Fence | ACP2 capability layer를 production v1에 혼입하지 않음 | 유지 필요 | final diff/fresh review PASS |

이 표의 `부분`은 코드 조각이 있다는 뜻이지 Release Gate를 통과했다는 뜻이 아니다.

## 5. A–Z 전수 판정

| 구분 | 영역 | 판정 | 핵심 요약 |
|---|---|---|---|
| A | Architecture | PASS | 역할·runtime·state를 분리한 방향은 정확함 |
| B | Branch & Build | BLOCK | 브랜치 lineage 결함, main/dev 무보호, CI 불완전 |
| C | Capacity | REVISE | reserve 계산은 강함, 실제 usage collector와 Grok 없음 |
| D | Database | REVISE | 불변식은 강함, migration 부재 |
| E | Evidence | PASS/REVISE | immutable evidence 강함, E2E claim이 실제 범위보다 큼 |
| F | Finalization | BLOCK | CEO confirm 이후 GitHub finalize 연결 없음 |
| G | GitHub Kernel | BLOCK | 내부 로직은 강하지만 상태/호출/owner gate 결함 |
| H | Human Gate | BLOCK | ProductionGate와 Merge가 다른 predicate 사용 |
| I | Ingress & Identity | REVISE | primitives 좋음, Telegram production listener 없음 |
| J | Job/Task Graph | REVISE | DAG 좋음, AWAITING_HUMAN 후 graph mutation 가능 |
| K | Key/Credential | REVISE | file permission 좋음, GH_TOKEN child env 노출 위험 |
| L | Lifecycle | BLOCK | normal CTO DRAIN/ACK 교착, final merge state 부재 |
| M | MCP & Messaging | BLOCK | authenticated MCP는 좋으나 handoff·Buzz runtime bridge 불완전 |
| N | Network/Sandbox | REVISE | write/network 제한 강함, allowlist 미지원·read deny-list 한계 |
| O | Outbox | PASS | durable CAS·retry/fencing 설계가 강함 |
| P | Provider Runtime | BLOCK | GPT reviewer unusable, Grok adapter 없음 |
| Q | Quality/CI | REVISE | test 밀도 우수, build/lint/trace/SSOT/live E2E 미실행 |
| R | Reviewer | BLOCK | GPT policy 미충족, isolation attestation 과장 |
| S | State Machine/SSOT | BLOCK | finalize state 부족, docs/issues/test counts drift |
| T | Telemetry/Doctor | PASS/REVISE | 진단 분리 좋음, 실제 long-run acceptance 미완 |
| U | Upgrade/Deployment | BLOCK | launchd placeholder, schema migration 없음 |
| V | Verification | REVISE | exact worktree 강함, env shell parser·allowlist 모순 |
| W | Write Guard/Worktree | BLOCK | Guard가 actual source mutation path에 있지 않음 |
| X | Cross-repository | BLOCK | model 존재, real ordered merge 미실행 |
| Y | Yield/Maintainability | REVISE | 명시적 코드지만 상태·docs·issues가 과다하게 흔들림 |
| Z | Zero-false-completion Gate | BLOCK | 30 lifecycle observation과 fresh PASS review 없음 |

---

## 6. P0 — Production을 막는 차단 결함

### P0-01. Production-ready 이후 GitHub write가 구조적으로 거부된다

#### 현상

`ManagedWriteGuard`는 project-natured write를 `run.state === ACTIVE`일 때만 허용한다.

반면 Candidate Pipeline은 packet을 만들며 `READY_FOR_CEO_REVIEW`로 전환하고, CEO CONFIRM은 `COMPLETED`로 전환한다.

```text
ACTIVE
→ verification
→ blind review
→ READY_FOR_CEO_REVIEW
→ CEO CONFIRM
→ COMPLETED
→ gate_publish / merge_execute 시도
→ WRITE_RUN_NOT_ACTIVE
```

#### 영향

정상 completion과 GitHub merge를 동시에 만족할 수 없다. 테스트에서 GitHub Kernel을 호출하려면 CEO packet 이전의 ACTIVE 상태를 사용해야 하므로, 실제 제품 순서가 검증되지 않는다.

#### 수정 계약

```text
ACTIVE
→ READY_FOR_CEO_REVIEW
→ CEO_APPROVED
→ MERGING
→ POST_MERGE_VERIFYING
→ COMPLETED
```

- `ACTIVE`: CTO/worker source write 허용
- `READY_FOR_CEO_REVIEW`: source write 금지, CEO decision만
- `CEO_APPROVED/MERGING`: daemon-owned GitHub write만 허용
- `POST_MERGE_VERIFYING`: exact merge commit 검증
- `COMPLETED`: 모든 managed write 금지

#### Acceptance Criteria

- packet 생성 후 `gate_publish`가 성공한다.
- CEO CONFIRM 전 `merge_execute`는 실패한다.
- CEO CONFIRM 후 daemon finalizer만 merge할 수 있다.
- `COMPLETED` 이후 gate/merge/tag 재실행은 idempotent receipt 조회만 허용한다.

#### 관련

- [#383](https://github.com/MongLong0214/agent-control-plane/issues/383)
- [`managed-write-guard.ts`](https://github.com/MongLong0214/agent-control-plane/blob/312772fba9a64adc760f0766bfa9200fadeb3b78/src/guard/managed-write-guard.ts)
- [`production-gate.ts`](https://github.com/MongLong0214/agent-control-plane/blob/312772fba9a64adc760f0766bfa9200fadeb3b78/src/ceo/production-gate.ts)

---

### P0-02. Daemon-owned GitHub Finalizer가 없다

#### 현상

`GitHubKernel`에는 다음 메서드가 존재한다.

```text
prPrepare
gatePublish
mergeEvaluate
mergeExecute
postMergeVerify
releaseTag
verifyHotfixPropagation
issueProject
```

그러나 production daemon, Hermes MCP, CTO MCP, `agentctl` 어디에도 CEO CONFIRM 이후 이들을 순서대로 호출하는 고수준 operation이 없다.

#### 영향

현재 시스템은 packet과 CEO completion까지는 갈 수 있지만, GitHub에서 실제 결과를 반영하지 않는다. Kernel은 테스트가 직접 호출하는 library surface다.

#### 수정 계약

daemon 내부에 단 하나의 고수준 orchestration을 추가한다.

```text
finalizeApprovedRun(runId)
```

순서:

1. current CEO approval 확인
2. candidate snapshot/contract/manifest 재확인
3. repo별 PR prepare
4. trusted gate publish
5. mergeOrder 순서대로 merge
6. 각 repo exact merge SHA post-merge verification
7. 다음 repo release
8. 전체 성공 후 COMPLETED
9. 부분 실패 시 BLOCKED_POST_MERGE + compensation plan

저수준 GitHub operation을 Hermes·CTO에 노출하지 않는다.

#### Acceptance Criteria

- production daemon entry point를 통해 1-repo real finalize 성공
- 2-repo ordered finalize 성공
- crash 후 pending receipt reconcile
- replay 시 duplicate PR/check/merge/tag 0

#### 관련

- [#386](https://github.com/MongLong0214/agent-control-plane/issues/386)
- [`control-plane.ts`](https://github.com/MongLong0214/agent-control-plane/blob/312772fba9a64adc760f0766bfa9200fadeb3b78/src/app/control-plane.ts)
- [`github-kernel.ts`](https://github.com/MongLong0214/agent-control-plane/blob/312772fba9a64adc760f0766bfa9200fadeb3b78/src/github/github-kernel.ts)

---

### P0-03. Human Gate 판정이 merge에서 약화된다

#### 현상

`ProductionGate.humanGateStatus()`는 다음을 올바르게 확인한다.

- current Contract의 모든 gate item
- current candidate snapshot
- humanGateDigest
- superseded 제외
- item별 latest decision
- 후속 rejection이 이전 approval 취소

그러나 `GitHubKernel`은 별도의 약한 로직으로 `approved === true`인 OwnerDecision artifact가 하나라도 있는지 확인한다.

#### 공격/실패 시나리오

```text
gate items: [production release, destructive data change]
owner approves only production release
merge kernel: approval 1개 발견 → humanGateSatisfied
```

또는:

```text
owner approves
owner later rejects
ProductionGate: unsatisfied
merge kernel: old approval row 발견 → satisfied
```

#### 수정 계약

Human Gate predicate는 한 곳만 존재해야 한다.

```text
ProductionGate.humanGateStatus(runId)
```

Gate publish와 Merge evaluate가 이 결과와 digest를 직접 사용한다. `APPROVAL` row 자체를 authority로 취급하지 않는다.

#### Acceptance Criteria

- 2개 중 1개 승인 시 merge 실패
- 승인 후 rejection 시 merge 실패
- 다른 candidate의 approval은 실패
- caller가 직접 삽입한 artifact는 실패
- exact Owner ingress receipt 없는 approval은 실패

#### 관련

- [#381](https://github.com/MongLong0214/agent-control-plane/issues/381)
- [#377](https://github.com/MongLong0214/agent-control-plane/issues/377)
- [`production-gate.ts`](https://github.com/MongLong0214/agent-control-plane/blob/312772fba9a64adc760f0766bfa9200fadeb3b78/src/ceo/production-gate.ts)
- [`github-kernel.ts`](https://github.com/MongLong0214/agent-control-plane/blob/312772fba9a64adc760f0766bfa9200fadeb3b78/src/github/github-kernel.ts)

---

### P0-04. 정상 CTO handoff가 production MCP 경로에서 교착된다

#### 현상 A — DRAINING CTO가 기존 Run을 끝낼 수 없다

`cto_replace`는 기존 CTO를 즉시 `DRAINING`으로 만든다. 그러나 MCP handshake와 request authentication은 `READY`만 허용한다.

결과:

```text
DRAINING
→ 신규 Run 차단: 정상
→ 기존 Run result_submit/task_receipt/escalation/handoff_submit도 차단: 결함
```

#### 현상 B — Incoming CTO의 ACK 순환

Incoming replacement는 ACK해야 Primary CTO binding을 얻는다. 그런데 CTO MCP socket은 active CTO binding이 있어야 접속할 수 있다.

```text
ACK → binding 필요
binding → ACK 필요
```

#### 현상 C — ACK payload가 잘린다

`CtoLifecycle.acknowledgeHandoff()`는 session-authenticated full envelope를 요구하고 bare session ID를 거부한다. CTO MCP port는 현재 bare `peer.sessionId`만 넘긴다.

#### 수정 계약

- outgoing `DRAINING`은 **기존 소유 Run에 한정된** result/task/escalation/handoff mutation 허용
- 신규 Run ACK/claim/dispatch는 차단
- incoming replacement 전용 `handoff.sock` 또는 pending-handoff endpoint
- 인증:
  - session secret
  - session incarnation
  - pending `to_session_id`
  - messageId
  - payloadDigest
  - fromGeneration
- ACK와 binding generation switch를 한 transaction으로 처리

#### Acceptance Criteria

실제 daemon/MCP 경로로:

```text
ACTIVE CTO
→ replace requested
→ DRAINING while finishing current Run
→ active runs 0
→ handoff delivered
→ incoming ACK
→ generation +1
→ old CTO STOPPED
→ next Run new CTO
```

#### 관련

- [#378](https://github.com/MongLong0214/agent-control-plane/issues/378)
- [#379](https://github.com/MongLong0214/agent-control-plane/issues/379)
- [`cto-lifecycle.ts`](https://github.com/MongLong0214/agent-control-plane/blob/312772fba9a64adc760f0766bfa9200fadeb3b78/src/cto/cto-lifecycle.ts)
- [`agentcpd.ts`](https://github.com/MongLong0214/agent-control-plane/blob/312772fba9a64adc760f0766bfa9200fadeb3b78/src/daemon/agentcpd.ts)
- [`cto-server.ts`](https://github.com/MongLong0214/agent-control-plane/blob/312772fba9a64adc760f0766bfa9200fadeb3b78/src/mcp/cto-server.ts)

---

### P0-05. 확정한 Release/Hotfix 브랜치 전략이 Kernel에서 깨진다

#### 요구 계약

```text
main
dev
feature/*
task/*
release/*
hotfix/*
```

```text
release/*: dev에서 분기 → main + dev
hotfix/*: main에서 분기 → main + dev + active release/*
```

#### 현재 결함

Candidate repository의 `baseBranch`가 다음 두 의미로 동시에 사용된다.

- branch가 원래 어디서 잘렸는가
- 현재 PR target이 무엇인가

따라서 `release/* → main`에서 source origin이 `main`으로 오인되고, `hotfix/* → dev|release/*`에서도 동일 문제가 발생한다.

#### 수정 계약

Candidate Snapshot에 분리한다.

```text
originBranch
originSha
candidateBranch
candidateHeadSha
targetBranch
targetBaseSha
```

Branch contract는 origin을 확인하고, merge contract는 target을 확인한다.

#### Acceptance Criteria

실제 GitHub test/repository에서:

- feature → dev
- task → feature
- task → dev
- task → release
- release → main
- release → dev
- hotfix → main
- hotfix → dev
- hotfix → 모든 active release

모두 exact origin/target으로 통과해야 한다.

#### 관련

- [#382](https://github.com/MongLong0214/agent-control-plane/issues/382)
- [`branch-contract.ts`](https://github.com/MongLong0214/agent-control-plane/blob/312772fba9a64adc760f0766bfa9200fadeb3b78/src/github/branch-contract.ts)
- [`github-kernel.ts`](https://github.com/MongLong0214/agent-control-plane/blob/312772fba9a64adc760f0766bfa9200fadeb3b78/src/github/github-kernel.ts)

---

### P0-06. Continuity가 mode만 계산하고 role을 자동 재배치하지 않는다

#### 현상

Continuity Kernel은 다음을 잘 구현했다.

- `RoleCoveragePlan`
- `NORMAL / DEGRADED / SURVIVAL`
- provider/capability별 assignment plan
- fresh session provisioning
- `failover()`와 generation switch

그러나 provider failure 경로가 호출하는 것은 `evaluate()`이며, 이는 mode/plan을 저장할 뿐 `failover()`를 실행하지 않는다. Daemon watchdog, Hermes MCP, CLI에도 automatic reconciliation entry point가 없다.

#### 영향

```text
GPT exhausted
→ mode DEGRADED 기록
→ CEO Role은 죽은 GPT session에 계속 binding
```

즉 Continuity Kernel이 “진단기”로는 작동하지만 사용자가 가장 중요하다고 확정한 “자동 재배선 kernel”로 닫히지 않는다.

#### 수정 계약

daemon-owned `reconcileContinuity(plan)`:

1. capacity refresh
2. current bindings와 plan 비교
3. 필수 role별 fresh session 생성
4. readiness/Buzz 확인
5. atomic binding switch
6. stale message fencing
7. in-flight role는 recovery takeover 또는 defer
8. restore 시 non-preemptive handoff

#### Acceptance Criteria

- GPT down → Claude Acting CEO + Claude reviewer, CTO 유지
- Claude down → GPT Acting CTO, CEO 유지
- provider 복구 → 신규 work부터 preferred restore
- old session late result → rejected
- role isolation 불충족 → SURVIVAL, 품질 gate 하향 없음

#### 관련

- [`continuity-kernel.ts`](https://github.com/MongLong0214/agent-control-plane/blob/312772fba9a64adc760f0766bfa9200fadeb3b78/src/continuity/continuity-kernel.ts)
- [`capacity-monitor.ts`](https://github.com/MongLong0214/agent-control-plane/blob/312772fba9a64adc760f0766bfa9200fadeb3b78/src/capacity/capacity-monitor.ts)
- [`daemon.ts`](https://github.com/MongLong0214/agent-control-plane/blob/312772fba9a64adc760f0766bfa9200fadeb3b78/src/daemon/daemon.ts)

---

### P0-07. Mandatory GPT-5.6 Sol xhigh Blind Review가 실제로는 불가능하다

#### 현상

Default reviewer preference는 GPT-5.6 Sol xhigh다. 그러나 Codex adapter는 `supportsReviewerIsolation = false`이고 isolation request를 즉시 거부한다.

결과적으로 정상 상태에서도 Claude Opus/Sonnet fallback이 사용된다. 이는 “GPT capacity outage 때만 fallback”이 아니라 “항상 fallback”이다.

Real E2E도 Claude reviewer를 사용하며 기본 model은 `sonnet`이다.

#### 영향

사용자가 확정한 가장 중요한 quality gate를 충족하지 않는다.

#### 수정 계약

- Codex/GPT reviewer용 packet-only adapter 구현
- fresh provider session identity 증명
- producer checkout/transcript 접근 금지
- no repository tools
- full packet digest/coverage
- xhigh effort 확인
- 실제 answer의 providerSessionId와 bound reviewer session 연결

#### Acceptance Criteria

Normal mode real E2E evidence에 다음이 있어야 한다.

```text
provider = gpt
model = gpt-5.6-sol
effort = xhigh
freshSession = true
producerIntersection = 0
omittedItems = 0
```

Claude reviewer는 GPT unavailable/insufficient capacity일 때만 fallback으로 나타나야 한다.

#### 관련

- [`blind-review.ts`](https://github.com/MongLong0214/agent-control-plane/blob/312772fba9a64adc760f0766bfa9200fadeb3b78/src/review/blind-review.ts)
- [`cli-adapters.ts`](https://github.com/MongLong0214/agent-control-plane/blob/312772fba9a64adc760f0766bfa9200fadeb3b78/src/runtime/cli-adapters.ts)
- [`real-project.test.ts`](https://github.com/MongLong0214/agent-control-plane/blob/312772fba9a64adc760f0766bfa9200fadeb3b78/tests/e2e/real-project.test.ts)

---

### P0-08. Reviewer isolation attestation이 실제 보증보다 강하게 표현된다

### 현재 구현의 장점

- candidate checkout, DB, `.claude`, `.codex`를 deny path로 요청
- separate packet root
- write confinement
- fresh session
- producer binding independence

### 남은 결함

- reviewer profile이 `(allow default)` 기반
- network는 실제로 열려 있음
- scoped provider credential directory가 없으면 real HOME 사용
- `isolationAttested`는 adversarial child read probe가 아니라 profile setup 성공에 가까움
- static withheld list가 실제 OS 차단 결과보다 강한 주장을 할 수 있음

#### 수정 계약

Attestation은 요청이 아니라 **실측 결과**여야 한다.

Reviewer child가 다음 read를 실제 시도하고 모두 실패해야 한다.

```text
producer transcript
candidate checkout
other checkout/worktree
ACP DB
ACP secrets
~/.claude/projects
~/.codex sessions
GitHub credentials
```

packet root의 지정 파일만 성공해야 한다.

#### Acceptance Criteria

- 경로별 OS errno와 canonical path가 evidence에 기록
- 하나라도 읽히면 `ISOLATION_LOST`
- static `withheld` 목록 대신 `enforcedDenials`
- scoped provider auth가 없으면 reviewer session constitution 자체를 refuse

#### 관련

- [#360](https://github.com/MongLong0214/agent-control-plane/issues/360)
- [`cli-adapters.ts`](https://github.com/MongLong0214/agent-control-plane/blob/312772fba9a64adc760f0766bfa9200fadeb3b78/src/runtime/cli-adapters.ts)
- [`blind-review.ts`](https://github.com/MongLong0214/agent-control-plane/blob/312772fba9a64adc760f0766bfa9200fadeb3b78/src/review/blind-review.ts)

---

### P0-09. Buzz transport와 실제 bound provider session 사이의 실행 bridge가 없다

#### 현상

`CtoLifecycle.spawn()`은 headless Claude session ID를 만들고 `BuzzCliTransport.openChannel()`로 channel 하나를 선택한다. 그러나 다음 mapping이 실제로 증명되지 않는다.

```text
Buzz channel actor
↔ ACP session
↔ Claude externalSessionId
↔ Primary CTO binding
↔ MCP caller
```

Buzz adapter는 메시지를 channel에 보내지만, 해당 메시지가 정확히 그 Claude session을 실행시키고 그 session이 MCP를 호출하는 runtime bridge는 보이지 않는다.

#### 영향

“CTO에게 Buzz로 작업 지시”는 transport delivery와 runtime execution이 분리된 상태다.

#### 수정 계약

둘 중 하나로 명시해야 한다.

**A. Buzz-managed session**

```text
Buzz session이 provider runtime을 실제 소유
→ actor binding
→ MCP credential
```

**B. Daemon invocation bridge**

```text
outbox event
→ daemon이 bound externalSessionId로 provider invoke
→ 대화를 Buzz에 mirror
→ provider result를 MCP operation으로 반영
```

#### Acceptance Criteria

- Buzz envelope 1건이 exact bound session에 전달
- session이 run_ack/plan_submit/result_submit 호출
- 다른 session/actor는 거부
- generation switch 뒤 old actor 응답 거부
- Doctor가 HEALTHY

#### 관련

- [#243](https://github.com/MongLong0214/agent-control-plane/issues/243)
- [`buzz-adapter.ts`](https://github.com/MongLong0214/agent-control-plane/blob/312772fba9a64adc760f0766bfa9200fadeb3b78/src/buzz/buzz-adapter.ts)
- [`cto-lifecycle.ts`](https://github.com/MongLong0214/agent-control-plane/blob/312772fba9a64adc760f0766bfa9200fadeb3b78/src/cto/cto-lifecycle.ts)

---

### P0-10. Telegram은 parser만 있고 production ingress server가 없다

#### 현상

`TelegramIngress`는 allowlist, chat, webhook secret, replay, forwarded-content wrapping을 잘 구현한다.

그러나 `agentcpd` startup은 MCP listeners와 Buzz actor ingress listener만 시작한다. Telegram webhook listener/long-poll adapter, Hermes routing, owner response path가 없다.

#### 영향

사용자가 확정한:

```text
Telegram → Hermes → ACP → Buzz CTO
```

흐름은 아직 구현되지 않았다.

#### 수정 계약

- authenticated local webhook or long-poll service
- owner/chat allowlist
- Telegram update → DIRECT/MANAGED Hermes input
- managed request는 Hermes MCP로 전달
- response correlation/idempotency
- forwarded content untrusted wrapper 유지
- owner decision은 admitted receipt로만

#### Acceptance Criteria

real Telegram message로 Run 생성 → Buzz CTO dispatch까지 evidence를 남긴다.

#### 관련

- [`telegram.ts`](https://github.com/MongLong0214/agent-control-plane/blob/312772fba9a64adc760f0766bfa9200fadeb3b78/src/ingress/telegram.ts)
- [`agentcpd.ts`](https://github.com/MongLong0214/agent-control-plane/blob/312772fba9a64adc760f0766bfa9200fadeb3b78/src/daemon/agentcpd.ts)

---

### P0-11. GPT·Claude·Grok 실제 usage 자동 수집이 없다

#### 현상

현재 source는 owner가 작성하는 local JSON file이다. daemon은 adapter가 읽은 값을 다시 file에 저장하지만, provider quota를 새로 관측하지 않는다.

또 default adapter는 GPT와 Claude뿐이고 Grok adapter가 없다.

### 사용자 요구와 불일치

사용자는 세 CLI의 interactive `/usage`로 실제 사용량을 확인할 수 있다고 명시했다. 현재 구현은 non-interactive `usage` subcommand 부재만 확인한 뒤 수동 file source로 종결했다.

#### 수정 계약

Provider별 collector:

```text
ClaudeUsageCollector
CodexUsageCollector
GrokUsageCollector
```

- PTY를 통해 CLI 진입
- `/usage` 입력
- stable parser
- raw output digest
- observedAt/resetAt/remainingPercent/capability normalization
- parser fixture와 mutation test
- failure 시 allocation suspend

#### Acceptance Criteria

세 provider의 real output fixture와 live probe를 모두 통과하고, Doctor/Continuity가 normalized bucket을 사용한다.

#### 관련

- [`capacity-source.md`](https://github.com/MongLong0214/agent-control-plane/blob/312772fba9a64adc760f0766bfa9200fadeb3b78/docs/capacity-source.md)
- [`capacity-monitor.ts`](https://github.com/MongLong0214/agent-control-plane/blob/312772fba9a64adc760f0766bfa9200fadeb3b78/src/capacity/capacity-monitor.ts)
- [`cli-adapters.ts`](https://github.com/MongLong0214/agent-control-plane/blob/312772fba9a64adc760f0766bfa9200fadeb3b78/src/runtime/cli-adapters.ts)

---

### P0-12. Managed Write Guard가 actual source mutation path에 있지 않다

#### 현상

Hard Invariant는 file mutation, git write, manifest change, GitHub write를 모두 Guard가 중재한다고 설명한다.

하지만 실제 source mutation은 agent/worker가 assigned checkout에서 직접 수행한다. Real E2E도 `writeFileSync`와 `git`을 직접 실행하고 Guard authorization을 consume하지 않는다.

GitHub Kernel의 `mediate()`조차 branch/path/worktree target을 Guard에 넘기지 않아 remote claim/fence가 정확한 target을 모른다.

#### 수정 방향 — 과설계 금지

모든 syscall을 proxy하려고 하지 않는다. 보증을 실제 가능한 수준으로 정정한다.

```text
ACP-owned write
- registry/manifest activation
- worktree lifecycle
- GitHub PR/gate/merge/release
→ Guard를 반드시 통과

Agent source write
- assigned disposable worktree만 writable
- active resource claim 필수
- session/task receipt와 worktree 결박
→ 개별 fs syscall이 Guard API를 거친다고 주장하지 않음
```

GitHub `mediate()`에는 operation별 branch/resource target을 반드시 전달한다.

#### Acceptance Criteria

- no claim worker cannot obtain writable worktree
- worker cannot write outside assigned worktree
- another Run’s branch/worktree/path conflict blocks admission
- GitHub write consumes matching branch/resource claim
- different branches can proceed concurrently

#### 관련

- [#355](https://github.com/MongLong0214/agent-control-plane/issues/355)
- [#356](https://github.com/MongLong0214/agent-control-plane/issues/356)
- [`managed-write-guard.ts`](https://github.com/MongLong0214/agent-control-plane/blob/312772fba9a64adc760f0766bfa9200fadeb3b78/src/guard/managed-write-guard.ts)
- [`github-kernel.ts`](https://github.com/MongLong0214/agent-control-plane/blob/312772fba9a64adc760f0766bfa9200fadeb3b78/src/github/github-kernel.ts)
- [`real-project.test.ts`](https://github.com/MongLong0214/agent-control-plane/blob/312772fba9a64adc760f0766bfa9200fadeb3b78/tests/e2e/real-project.test.ts)

---

### P0-13. `agentctl`이 두 번째 Runtime Authority를 생성한다

#### 현상

`agentctl`은 daemon socket을 호출하지 않고 `new ControlPlane(defaultConfig())`로 동일 SQLite file을 직접 연다.

다음 mutation을 별도 process에서 수행한다.

- run cancel
- repair
- owner approval
- capacity file write
- project registration

### 위험

- daemon의 process-local reservation/in-flight map 우회
- single-instance lock 밖의 writer
- outbox/doctor/watchdog와 race
- process-local capability issuance가 새 process에서 다시 mint될 수 있음
- “agentcpd만 authoritative writer” 불변식 위반

#### 수정 계약

```text
agentctl read commands
→ daemon read RPC 또는 SQLite read-only connection

agentctl write commands
→ authenticated operator socket
→ agentcpd가 처리
```

CLI process에서 `ControlPlane`을 생성하지 않는다.

#### Acceptance Criteria

- daemon 실행 중 CLI가 DB write connection을 열지 않음
- daemon down 시 mutation fail-closed
- concurrent CLI requests가 idempotent
- evidence/completion capability는 daemon process에서만 발급

#### 관련

- [`agentctl.ts`](https://github.com/MongLong0214/agent-control-plane/blob/312772fba9a64adc760f0766bfa9200fadeb3b78/src/cli/agentctl.ts)
- [`database.ts`](https://github.com/MongLong0214/agent-control-plane/blob/312772fba9a64adc760f0766bfa9200fadeb3b78/src/db/database.ts)
- [`agentcpd.ts`](https://github.com/MongLong0214/agent-control-plane/blob/312772fba9a64adc760f0766bfa9200fadeb3b78/src/daemon/agentcpd.ts)

---

### P0-14. Trusted GitHub Gate의 live authority가 없다

#### 현상

PAT/일반 token으로 check-run 생성 시 GitHub가 App authentication을 요구한다. 현재 Gate predicates는 Fake/modelled API에서만 검증됐다.

`main`과 `dev`도 보호되지 않았다.

#### 수정 계약

- GitHub App 설치
- `checks:write`, 필요한 최소 repository permission
- creator identity pin
- daemon credential store
- `main/dev` ruleset
- required `project-ci` + `acp-production-gate`
- bypass actor 0
- force push/delete 금지

#### Acceptance Criteria

real repository에서:

```text
untrusted same-name check → merge refused
trusted App check exact head → accepted
missing gate → refused
stale gate → refused
direct push → refused
```

#### 관련

- [#242](https://github.com/MongLong0214/agent-control-plane/issues/242)
- [`credential-store.ts`](https://github.com/MongLong0214/agent-control-plane/blob/312772fba9a64adc760f0766bfa9200fadeb3b78/src/github/credential-store.ts)

---

### P0-15. Real multi-repo 및 운영 관측 Acceptance가 미완료다

#### 현상

- two-repo freeze/merge-order test는 존재
- real two-repository merge sequence는 없음
- 3개 프로젝트·30 lifecycle observation 없음
- false completion/duplicate dispatch/stale acceptance/forged gate/unauthorized merge의 실운영 0건 미증명

#### Acceptance Criteria

- 실제 2개 repository ordered merge
- repo1 post-merge PASS 전 repo2 merge 금지
- partial failure compensation
- 3개 프로젝트 이상
- 30 lifecycle 이상
- 관측 window/duration/query 보관
- routine revision owner interrupt 0

#### 관련

- [#240](https://github.com/MongLong0214/agent-control-plane/issues/240)
- [#241](https://github.com/MongLong0214/agent-control-plane/issues/241)
- [`ACCEPTANCE.md`](https://github.com/MongLong0214/agent-control-plane/blob/312772fba9a64adc760f0766bfa9200fadeb3b78/docs/ACCEPTANCE.md)

---

## 7. P1 — 반드시 수정해야 하는 주요 결함

### P1-01. `AWAITING_HUMAN`에서 Task Graph를 확장할 수 있다

Packet이 만들어진 후 CEO가 Owner decision을 요구하면 Run은 `AWAITING_HUMAN`이 된다. 그러나 graph seal set에 이 상태가 없어 새 task를 추가할 수 있다. 기존 packet의 completeness가 거짓이 된다.

**수정:** `AWAITING_HUMAN`을 sealed state로 포함하거나 graph mutation 시 candidate/packet을 명시적으로 supersede한다.

관련: [#375](https://github.com/MongLong0214/agent-control-plane/issues/375), [`task-graph.ts`](https://github.com/MongLong0214/agent-control-plane/blob/312772fba9a64adc760f0766bfa9200fadeb3b78/src/run/task-graph.ts)

---

### P1-02. Worker provenance가 optional input에 의존한다

`workerSessionId`와 process ID가 모두 optional이다. 현재 producer-history는 정보가 없으면 fail-closed하므로 즉시 reviewer reuse가 허용되는 것은 아니지만, 실제 worker identity가 durable binding으로 강제되지 않아 review availability와 forensic accuracy를 caller 입력에 의존한다.

**수정:** `WORKER:<taskId>` binding 필수, execution receipt의 `workerSessionId`는 그 binding과 일치해야 한다.

관련: [#380](https://github.com/MongLong0214/agent-control-plane/issues/380), [`binding-registry.ts`](https://github.com/MongLong0214/agent-control-plane/blob/312772fba9a64adc760f0766bfa9200fadeb3b78/src/session/binding-registry.ts)

---

### P1-03. Claim expiry의 Guard/DB 의미가 불일치한다

Guard는 시간상 expired claim을 무시할 수 있지만 SQLite partial unique index는 status가 `HELD`인 동안 slot을 점유한다.

**수정:** claim read/acquire/guard decision 시작 시 같은 transaction에서 overdue를 `EXPIRED`로 전환한다.

관련: [#358](https://github.com/MongLong0214/agent-control-plane/issues/358), [`claim-registry.ts`](https://github.com/MongLong0214/agent-control-plane/blob/312772fba9a64adc760f0766bfa9200fadeb3b78/src/claims/claim-registry.ts), [`schema.sql`](https://github.com/MongLong0214/agent-control-plane/blob/312772fba9a64adc760f0766bfa9200fadeb3b78/src/db/schema.sql)

---

### P1-04. GitHub issue projection이 100개 이후 duplicate를 만들 수 있다

Issue marker 탐색이 first page 100건에 한정된다.

**수정:** bounded pagination + bound 초과 시 fail-closed + >100 fixture.

관련: [#385](https://github.com/MongLong0214/agent-control-plane/issues/385)

---

### P1-05. Atomic expected-base flag가 dead configuration이다

REST merge는 exact head만 조건화하고 expected base는 atomic하게 고정하지 못한다. 코드에 `supportsAtomicExpectedBase`가 있지만 실제 request에 사용되지 않는다.

**수정:** 실제 지원 경로를 구현하거나 flag를 제거하고 residual race를 공식 계약으로 제한한다. GUARDED release는 merge queue/up-to-date requirement를 권장한다.

관련: [#384](https://github.com/MongLong0214/agent-control-plane/issues/384), [`github-kernel.ts`](https://github.com/MongLong0214/agent-control-plane/blob/312772fba9a64adc760f0766bfa9200fadeb3b78/src/github/github-kernel.ts)

---

### P1-06. CTO session workdir가 `process.cwd()`다

CTO와 continuity session provisioning이 project checkout이 아니라 daemon current directory를 사용한다. launchd에서는 예상하지 못한 위치일 수 있다. Multi-repo에서는 더 모호하다.

**수정:** neutral managed runtime root를 만들고 participating repository paths를 packet/MCP로 제공하거나, primary repo checkout을 명시적으로 선택한다. 실제 workdir를 session row에 저장한다.

관련: [`cto-lifecycle.ts`](https://github.com/MongLong0214/agent-control-plane/blob/312772fba9a64adc760f0766bfa9200fadeb3b78/src/cto/cto-lifecycle.ts), [`continuity-kernel.ts`](https://github.com/MongLong0214/agent-control-plane/blob/312772fba9a64adc760f0766bfa9200fadeb3b78/src/continuity/continuity-kernel.ts)

---

### P1-07. 현재 “Real E2E” 명칭이 실제 범위를 과장한다

Real E2E는 다음을 직접 호출한다.

- `ControlPlane` constructor
- provider adapter direct invocation
- `tasks.submit`
- `artifacts.put`
- `claims.acquire`
- `writeFileSync`와 git
- `pipeline.submitResult`
- `ceo.submitCeoDecision`

실제 Hermes MCP, Buzz, CTO MCP, worker runtime, GitHub App, merge, post-merge를 통과하지 않는다. 또한 CI 기본 run에서는 skip된다.

**수정:** 현재 test는 `real-component-integration`으로 rename하고, 별도 `deployment-e2e`를 만든다.

관련: [`real-project.test.ts`](https://github.com/MongLong0214/agent-control-plane/blob/312772fba9a64adc760f0766bfa9200fadeb3b78/tests/e2e/real-project.test.ts)

---

### P1-08. Traceability가 scenario ID 존재만으로 coverage를 주장한다

현재 traceability는 test text에서 scenario ID를 찾는 방식이다. Production path가 아닌 direct service test도 coverage로 계산된다.

**수정:** Requirement마다 다음을 기록한다.

```text
production entry point
positive test
negative test
real adapter or modelled boundary
live evidence requirement
```

관련: [`traceability.md`](https://github.com/MongLong0214/agent-control-plane/blob/312772fba9a64adc760f0766bfa9200fadeb3b78/evidence/traceability.md)

---

### P1-09. CI가 required quality commands를 모두 실행하지 않는다

현재 CI는 install, typecheck, test만 수행한다.

빠진 것:

```text
build
lint
trace
ssot-report
deployment config validation
opt-in/live release E2E
```

또 explicit `permissions`, `timeout-minutes`, `concurrency`가 없다.

**수정:** PR CI와 release acceptance를 분리한다.

관련: [`.github/workflows/ci.yml`](https://github.com/MongLong0214/agent-control-plane/blob/312772fba9a64adc760f0766bfa9200fadeb3b78/.github/workflows/ci.yml)

---

### P1-10. SSOT 문서와 Issue count가 drift됐다

- README test count
- issue #306 test count
- current CI test count
- old review count
- “private until PASS” 문구와 현재 public 상태

가 서로 다르다.

**수정:** current SHA와 GitHub API에서 status ledger를 생성하고 수동 숫자를 제거한다.

---

### P1-11. Schema migration 경로가 없다

`SCHEMA_VERSION`이 다르면 daemon이 fail-closed하며, ordered migration은 없다. 개발 중 schema가 자주 변하는 시스템에서 24/7 state를 유지할 수 없다.

**수정:**

```text
versioned migrations
backup-before-migrate
integrity_check
migration receipt
rollback/restoration drill
```

관련: [`database.ts`](https://github.com/MongLong0214/agent-control-plane/blob/312772fba9a64adc760f0766bfa9200fadeb3b78/src/db/database.ts)

---

### P1-12. launchd 설정은 배포 가능한 산출물이 아니다

- path placeholder
- home placeholder
- `/usr/bin/env node`
- WorkingDirectory 없음
- required MCP/Buzz/Ingress secret 없음
- install/uninstall/upgrade script 없음

**수정:** rendered plist installer, absolute Node path, protected env source/Keychain, preflight, rollback.

관련: [`com.agentcontrolplane.agentcpd.plist`](https://github.com/MongLong0214/agent-control-plane/blob/312772fba9a64adc760f0766bfa9200fadeb3b78/deploy/com.agentcontrolplane.agentcpd.plist)

---

### P1-13. State directory와 DB/worktree permission 검증이 부족하다

Daemon은 stateDir를 0700으로 고치지만 `agentctl`이 먼저 DB를 만들거나 다른 entry point가 직접 생성하면 동일 보증이 없다. Worktree root와 SQLite file mode도 명시적으로 검증되지 않는다.

**수정:** 모든 composition root에서 0700/0600/owner UID를 공통 preflight로 강제하고 Doctor가 확인한다.

---

### P1-14. GitHub authority token을 child environment로 전달한다

Credential file 자체의 0700/0600 검사는 좋다. 그러나 `gh` child process에 `GH_TOKEN` environment로 전달한다. 같은 OS user의 다른 process가 child environment를 읽을 수 있는 플랫폼에서는 authority boundary가 약해진다.

**수정 우선순위:**

1. in-process HTTPS client
2. short-lived GitHub App token in daemon memory
3. env가 아닌 protected credential helper/FD
4. exact executable path
5. same-user process scrape regression

관련: [`credential-store.ts`](https://github.com/MongLong0214/agent-control-plane/blob/312772fba9a64adc760f0766bfa9200fadeb3b78/src/github/credential-store.ts)

---

### P1-15. Verification `env` shell detection 우회가 가능하다

`envLaunchesShell()`은 `env FOO=1 bash -c ...`에서 `FOO=1`을 executable로 오인할 수 있다.

**수정:** `NAME=VALUE`, `-u`, `--unset`, `-S`를 정확히 파싱해 실제 executable을 검사한다.

관련: [`verification-command.ts`](https://github.com/MongLong0214/agent-control-plane/blob/312772fba9a64adc760f0766bfa9200fadeb3b78/src/contracts/verification-command.ts)

---

### P1-16. `network=allowlist` 계약과 runtime이 모순된다

README는 dependency install step에 allowlist 사용을 안내하지만 sandbox와 manifest portability는 allowlist를 거부한다.

**수정:** 구현 전까지 Repo Factory/문서/schema에서 allowlist를 production-supported로 소개하지 않는다. 이후 proxy/firewall 기반 enforcement를 추가한다.

관련: [`sandbox.ts`](https://github.com/MongLong0214/agent-control-plane/blob/312772fba9a64adc760f0766bfa9200fadeb3b78/src/verify/sandbox.ts), [`manifest.ts`](https://github.com/MongLong0214/agent-control-plane/blob/312772fba9a64adc760f0766bfa9200fadeb3b78/src/contracts/manifest.ts)

---

### P1-17. Owner-authorized repair CLI가 실제로 작동하지 않는다

`agentctl repair execute --owner`는 `authorizedBy=OWNER`만 넣고 Owner identity/receipt를 넘기지 않는다. RepairService는 allowlisted owner를 요구하므로 documented CLI가 거부된다.

**수정:** operator ingress receipt를 통해 exact repair parameters를 승인하도록 한다.

관련: [`agentctl.ts`](https://github.com/MongLong0214/agent-control-plane/blob/312772fba9a64adc760f0766bfa9200fadeb3b78/src/cli/agentctl.ts), [`repair.ts`](https://github.com/MongLong0214/agent-control-plane/blob/312772fba9a64adc760f0766bfa9200fadeb3b78/src/doctor/repair.ts)

---

### P1-18. Telegram owner identity와 actual response path가 없다

Telegram class는 있지만 daemon wiring, webhook server, reply adapter, owner identity deployment가 없다.

**수정:** P0-10과 함께 deployment test.

---

### P1-19. Public repository 기본 운영 문서가 부족하다

현재 public repository에는 명시적인 LICENSE, SECURITY policy, CONTRIBUTING, release notes가 보이지 않는다.

**수정:** 실제 공개 OSS 의도가 있다면 추가한다. 내부 시스템 공개만 목적이라면 README에 support/security posture와 “not production-ready”를 명확히 표시한다.

---

### P1-20. Open issue queue에 이미 수정된 finding이 섞여 있다

현재 capacity code는 refresh trigger, dynamic reserve, reset horizon, per-bucket burn rate를 구현하고 있다. 따라서 #54/#55/#176/#182 일부는 current HEAD에서 stale일 가능성이 높다.

**수정:** issue를 무조건 구현하지 말고 current HEAD에서 재현 → close with commit/test 또는 keep.

---

## 8. P2 — 품질·운영 완성도 개선

- Actions runtime deprecation warning 해소
- README의 test count 자동 생성
- Changelog/Release process
- branch `integration/r4` 정리
- `dev`가 main보다 뒤처진 상태를 정상 flow로 복구
- signed commit/tag policy 검토
- log rotation과 retention
- telemetry retention/compaction
- DB backup schedule
- release artifact checksum
- `fast_forward`를 schema가 허용하지만 GitHub PR API가 지원하지 않는 계약 정리
- Post-merge command도 canonical structured command schema로 통일
- generated architecture/status diagram
- performance benchmark: DB growth, 1000 Runs, 100k audit rows, 10 concurrent Run
- graceful shutdown 중 in-flight external operation reconcile

---

## 9. 모듈별 상세 판정

| Module | 강점 | 결함/리스크 | 판정 |
|---|---|---|---|
| `core` | stable reason codes, digest, explicit Decision | reason-code contract를 release CI에서 고정해야 함 | PASS |
| `db` | strong SQLite triggers, BEGIN IMMEDIATE, capability marker | migration 없음, second-process authority | REVISE |
| `domain` | 명시적 vocabulary | GitHub finalize states 부족 | BLOCK |
| `registry` | project/repository 분리 | absolute local binding permission/preflight 강화 | PASS/REVISE |
| `session` | secret hash, incarnation, lifecycle | headless external session/Buzz identity bridge 미완 | REVISE |
| `binding` | generation monotonicity, atomic switch | normal handoff endpoint 교착 | BLOCK |
| `run` | pinned contract, candidate lifecycle | completion이 merge보다 먼저, E2E direct 호출 | BLOCK |
| `task` | DAG, dependency, stale owner handling | AWAITING_HUMAN seal, worker identity optional | REVISE |
| `claims` | minimal mechanical conflict model | expiry/unique-index mismatch | REVISE |
| `guard` | DIRECT vs MANAGED classification | actual source write path 미연결, remote target 누락 | BLOCK |
| `verify` | exact worktree, hooks disabled, resource/output bounds | allowlist 미지원, read deny-list, parser gap | REVISE |
| `review` | coverage/digest/chunking 강함 | GPT unavailable, isolation overclaim | BLOCK |
| `ceo` | packet transaction, strong owner status | merge kernel이 같은 predicate 미사용 | BLOCK |
| `github` | exact head, idempotency, postflight receipts | finalizer 없음, branch lineage, owner gate | BLOCK |
| `capacity` | current code의 reserve 계산은 높은 수준 | actual source와 Grok 없음 | REVISE |
| `continuity` | RoleCoveragePlan·atomic switch 설계 좋음 | automatic rebind production trigger 없음 | BLOCK |
| `cto` | drain/handoff/recovery 모델 강함 | MCP path deadlock, workdir 모호 | BLOCK |
| `outbox` | durable CAS, retry classification, generation fencing | real Buzz ACK 미검증 | PASS/REVISE |
| `buzz` | transport/authority 분리 | exact runtime bridge/live relay 미검증 | BLOCK |
| `ingress` | HMAC/allowlist/replay/untrusted data | Telegram production listener 없음 | REVISE |
| `mcp` | sealed function-only ports, session auth | incoming handoff exception 미구현 | BLOCK |
| `doctor` | read-only, scoped finding contract | 일부 remedy CLI unusable, live dependencies 미검증 | PASS/REVISE |
| `watchdog` | lightweight overdue scan | continuity failover 실행까지 연결 안 됨 | REVISE |
| `repair` | explicit allowlist/risk/precondition | Owner CLI receipt 경로 없음 | REVISE |
| `bootstrap` | RepoFactoryResult/Activation 분리 좋음 | producer side 미구현, live handoff/Buzz에 의존 | PASS/REVISE |
| `daemon` | lock, reconcile, watchdog, health | finalizer/Telegram/failover coordinator 없음 | BLOCK |
| `cli` | 운영 명령 vocabulary 명확 | DB에 직접 두 번째 CP 생성 | BLOCK |
| `deploy` | launchd 방향 적절 | placeholder, secret/preflight/install 미완 | BLOCK |
| `tests` | negative regression 밀도 높음 | direct service test가 production path를 대체 | REVISE |
| `docs/evidence` | 자기 결함을 숨기지 않음 | counts/state가 current HEAD와 drift | REVISE |

---

## 10. 테스트·CI 리뷰

## 10.1 좋은 점

- unit/scenario/integration 층이 분리되어 있다.
- stale evidence, forged gate, duplicate request, process cleanup 같은 negative test가 많다.
- exact candidate와 reviewer coverage를 여러 방향으로 변조한다.
- current main CI는 typecheck/test green이다.
- Actions는 commit SHA로 pin되어 있다.

## 10.2 문제

### 테스트가 실제 entry point를 우회한다

다음 패턴이 반복된다.

```text
production: daemon → MCP → runtime bridge → service
test:       service object 직접 호출
```

따라서 production wiring이 빠져도 unit/scenario가 green일 수 있다. 실제 열린 BLOCKER 4건이 그 증거다.

### Real E2E가 full E2E가 아니다

Current real test에는 다음이 없다.

- real Hermes MCP
- real Buzz delivery/ACK
- real CTO MCP
- real worker session
- capacity-admitted worker path
- GPT Sol reviewer
- GitHub App gate
- merge/post-merge

### CI에서 빠진 것

```text
pnpm build
pnpm lint
pnpm trace
node scripts/ssot-report.mjs
deployment config test
real release E2E
```

## 10.3 권장 Test Pyramid

```text
Unit
- pure domain/DB predicate

Integration
- composition root + real SQLite + fake external provider

Production-path scenario
- authenticated MCP/operator socket만 사용
- service direct call 금지

Deployment E2E
- launchd daemon
- real Claude/GPT/Grok
- real Buzz/Telegram
- GitHub App
- real merge/post-merge
```

---

## 11. 보안 리뷰

## 11.1 강점

- Candidate command 환경을 상속하지 않고 구성
- secret path deny
- output size/time/CPU/process limits
- GitHub credential file mode/owner 검사
- MCP token + session secret + incarnation + binding generation
- ingress allowlist/HMAC/replay
- owner decision exact parameter digest
- untrusted external content wrapper
- test adapter를 production registry에서 분리

## 11.2 남은 보안 리스크

| Risk | Severity | 설명 |
|---|---|---|
| Source write guard 미연결 | High | agent가 worktree 밖에 쓰지 못하게 runtime-level enforcement 필요 |
| GH_TOKEN child env | High | same-user process에서 authority token 노출 가능성 |
| Reviewer HOME/network | High | packet-only claim이 실제 boundary보다 강함 |
| CLI second writer | High | daemon in-memory fence/authority 모델 우회 |
| main/dev unprotected | High | direct push로 CI/evidence 수정 가능 |
| DB/worktree permission | Medium/High | local sensitive state read 가능성 |
| Telegram/Buzz live auth 미검증 | High | identity binding을 실환경에서 증명하지 못함 |
| no schema migration | Medium | 긴급 upgrade에서 state loss/unsafe manual migration |

---


## 11.3 Security Threat Model Closure

### 보호 자산

```text
GitHub App private key / installation token
Provider login/session credentials
Buzz/Telegram secrets
ACP SQLite / WAL / backup
Owner identities and approval receipts
Role binding generation
Candidate, verification and review evidence
Project source repositories
Operator/CEO/CTO Unix sockets
```

### 공격자·실패 모델

```text
untrusted repository code executed during verification
prompt-injected external content
stale/dead provider or agent session
producer attempting reviewer/CEO authority
local same-user process attempting socket/DB/child-env access
forged GitHub check or replayed approval
provider quota/runtime failure
partial GitHub write or daemon crash
misconfigured permissions, symlink or migration
```

### Release 전 필수 공격 테스트

- Reviewer child가 producer transcript, candidate checkout, ACP DB, other worktree, provider history, secrets를 읽으려는 시도.
- Verification command가 network, parent path, other checkout, daemon socket, credential store를 접근하는 시도.
- DIRECT-labelled request가 registered project source/Git/GitHub write를 수행하는 시도.
- Old generation CTO/worker/reviewer/CEO가 state 또는 GitHub side effect를 변경하는 시도.
- Telegram/Buzz replay, actor spoofing, forwarded prompt injection.
- 외부 actor가 같은 이름의 `acp-production-gate`를 생성하는 시도.
- Owner approval artifact 직접 삽입, 과거 candidate 승인 재사용, 승인 후 거부 무시 시도.
- 두 Run이 동일 branch/path/worktree를 동시에 claim하는 시도.
- DB backup/restore에 symlink·permissive mode·corrupt file을 사용하는 시도.
- daemon crash를 gate publish, first merge, binding switch, migration 사이에 주입하는 시도.

각 공격 테스트는 “실패했다”는 서술이 아니라 stable reason code, audit evidence, external side-effect count로 증명한다.

## 12. 과설계 여부

현재 시스템은 이미 상당히 크다. 하지만 다음은 사용자의 실제 요구이므로 제거하면 안 된다.

```text
Role/Runtime separation
Continuity
Provider Capacity
Mandatory Blind Review
Doctor
Repo Factory boundary
Multi-repo
GitHub trusted finalization
```

반대로 다음 방식으로 고치면 오버엔지니어링이다.

- Kubernetes scheduler 추가
- distributed consensus
- generic workflow DSL
- event sourcing 전환
- 모든 filesystem syscall broker
- 자체 container orchestration 플랫폼
- 정책 언어 추가
- 별도 cloud control plane

필요한 수정은 대부분 작고 명시적이다.

```text
finalize state 2~3개
daemon finalizer 1개
shared humanGate predicate 1개
handoff endpoint 1개
branch origin fields
usage collector adapters
operator RPC
runtime bridge
```

---

## 13. 추가 P0 Closeout Findings

### P0-16. Fresh installation에서 Hermes CEO authority를 안전하게 bootstrap할 공식 경로가 없다

#### 현상

Hermes MCP socket은 `CEO` Role의 active binding과 session secret을 요구한다. 그러나 fresh DB에서 operator가 다음을 안전하게 수행하는 supported one-time flow가 명확하지 않다.

```text
Hermes runtime identity 확인
→ session 생성
→ possession proof 발급
→ session READY 확인
→ CEO binding generation 1 생성
→ MCP credential 전달
→ first authenticated request
```

테스트가 `sessions.create()`와 `bindings.bind()`를 직접 호출하는 것은 설치 UX가 아니다. raw DB insert도 허용할 수 없다.

#### 수정 계약

다음 중 하나의 좁은 bootstrap command를 제공한다.

```text
agentcpd init --hermes-command ...
또는
agentctl bootstrap hermes ...  # daemon의 uninitialized-only bootstrap socket 사용
```

조건:

- DB에 CEO active binding이 없을 때만 사용 가능
- owner-local Unix permission + one-time token + runtime possession proof
- 재실행은 idempotent read 또는 명시적 거부
- 기존 CEO가 있으면 별도 continuity/handoff path만 허용
- session secret을 stdout/log/audit에 평문 저장하지 않음
- bootstrap 완료 전 Hermes MCP listener는 authority mutation을 허용하지 않음

#### Acceptance

```text
empty state directory
→ install
→ bootstrap Hermes
→ agentcpd restart
→ Hermes MCP authenticated project_get/doctor_run
```

raw SQL, fixture helper, in-process service call 없이 성공해야 한다.

### P0-17. Long-lived local daemon을 위한 migration·backup·restore·reboot 계약이 없다

#### 현상

현재 schema version mismatch는 fail-closed지만, state를 보존하는 ordered migration과 rollback/restore 절차가 없다. launchd plist도 install-time placeholder를 포함한다. 장기간 24/7 운영할 시스템에서 upgrade가 곧 DB 폐기를 뜻하면 Production-ready가 아니다.

#### 수정 계약

- ordered schema migration registry
- migration 전 consistent backup
- migration checksum/version 기록
- failure 시 original DB 복원
- backup retention과 owner-only permission
- unsupported future schema 거부
- rendered launchd installer/uninstaller
- reboot 후 lock/state/outbox/session reconciliation
- upgrade rehearsal fixture from previous released schema

#### Acceptance

```text
v1.previous fixture DB
→ backup
→ migrate
→ daemon start
→ state invariants verify
→ injected migration failure
→ restore
→ previous binary/read-only inspection
```

모든 단계가 scripted evidence로 남아야 한다.

### P0-18. Production completion과 ACP 2.0 baseline을 연결할 immutable export가 없다

이 항목은 v1 runtime correctness 자체보다 **ACP 2.0 Gate A의 차단 조건**이다. Production-ready tag는 가능하더라도 ACP 2.0 Feasibility Slice는 이 항목 없이는 시작할 수 없다.

수정 계약은 Part III의 `V1-BR-01`~`V1-BR-10`을 따른다.

---
# Part III. ACP 2.0 Baseline Readiness를 위한 v1 필수 계약

## V1-BR-01 — Exact Runtime Identity

모든 model invocation과 role session은 최소 다음을 남긴다.

```text
runId / taskId
logical role
provider
requested model
observed/returned model identity
model version/build when exposed
reasoning/effort tier
session id + incarnation
binding generation
harness version
adapter version
tool policy digest
context/input packet digest
startedAt / endedAt / duration
outcome / failure class
```

모델 이름을 Role의 영구 정의로 저장하지 않는다.

```text
PRIMARY_CTO != Claude Opus
PRIMARY_CTO → preferred runtime policy → Claude Opus
```

Acceptance:

- 동일 `PRIMARY_CTO` Role을 test composition에서 다른 production-capable adapter로 binding할 수 있다.
- domain table과 state machine에 `opus`, `sol`, `sonnet`, `terra` 같은 모델명이 invariant로 박혀 있지 않다.
- actual provider가 요청 모델과 다르게 응답하면 drift를 기록하고 qualification evidence로 사용하지 않는다.

## V1-BR-02 — Usage and Cost Evidence

Provider-reported usage와 ACP-estimated usage를 분리한다.

```text
source = PROVIDER_REPORTED | CLI_REPORTED | QUOTA_DELTA | ACP_ESTIMATED | UNAVAILABLE
input_tokens
output_tokens
cache_read_tokens
cache_write_tokens
reasoning_tokens when exposed
quota bucket before / after
resetAt
raw observation digest
parser/collector version
confidence
```

규칙:

- 값이 없으면 0으로 채우지 않고 `UNAVAILABLE`을 기록한다.
- 서로 다른 Provider token 단위를 단순 합산해 단일 “총 토큰”으로 부르지 않는다.
- Quality-normalized cost 계산에 사용할 환산식은 versioned config로 남긴다.
- `/usage` PTY parsing을 쓰면 raw text hash와 parser version을 함께 기록한다.

## V1-BR-03 — Execution Graph Baseline

v1은 topology optimizer를 만들지 않지만 실제 DAG 형태를 기록한다.

```text
node/task count
edge/dependency count
graph depth
max observed parallel width
worker sessions/models
critical path duration when derivable
plan revision count
graph revision count
claim conflict count
retry / repair count
serialized vs parallel decision
```

Task graph 전체 prompt나 chain-of-thought는 저장하지 않는다. 구조적 facts와 결과 digest만 저장한다.

## V1-BR-04 — Quality Baseline

모든 Run에는 다음 결과가 연결되어야 한다.

```text
deterministic verification status
expected vs observed verifier inputs
blind review verdict and finding categories
revision count
CEO decision
owner intervention count
merge receipt
post-merge verification
rollback/compensation occurrence
defect escape observed later
final outcome
```

`COMPLETED`인데 quality result가 없는 row를 DB/traceability check가 거부해야 한다.

## V1-BR-05 — Stable Task-Class Tagging

ACP 2.0의 initial task profiler를 학습시키지 않는다. v1에서는 작고 설명 가능한 taxonomy만 기록한다.

```text
MECHANICAL_CHANGE
LOCAL_BUG_FIX
BOUNDED_FEATURE
TEST_OR_FIXTURE
DEPENDENCY_OR_MIGRATION
MULTI_REPO_CHANGE
PERFORMANCE
SECURITY
ARCHITECTURE
PRODUCT_OR_OWNER_JUDGMENT
OTHER
```

분류는 Hermes/CTO가 제안할 수 있지만 최종 값은 structured contract field이며 변경 이력이 남는다. 분류 불확실성을 숨기지 않고 `OTHER` 또는 confidence를 기록한다.

## V1-BR-06 — Immutable Run Evidence Export

offline ACP 2.0 experiment에서 v1 DB를 직접 조작하지 않도록 versioned export를 제공한다.

```text
agentctl run export <runId>
agentctl baseline export --from ... --to ...
```

Export는 다음을 포함한다.

- contract/snapshot/verification/review/merge digests
- model/runtime facts
- task graph structure
- usage/capacity facts
- quality and human intervention facts
- harness/binary/schema version

포함하지 않는다.

- chain-of-thought
- full private transcript
- credentials
- raw `.env`
- 필요 없는 source code 전체

Export는 canonical JSON, schema id, checksum을 가진다.

## V1-BR-07 — Harness Version Pinning

모델 성능과 harness 성능을 분리하려면 다음이 고정되어야 한다.

```text
ACP binary commit/version
schema version
adapter version
prompt/rule bundle digest
project manifest digest
verification contract digest
review policy digest
```

Run 중 bundle이 바뀌면 기존 evidence를 새로운 harness 결과로 섞지 않는다.

## V1-BR-08 — Experiment Isolation Preparation

v1 production state와 ACP 2.0 offline experiment state를 분리한다.

- experiment는 production SQLite를 write하지 않는다.
- holdout task solution, reviewer verdict, prior candidate를 context source로 자동 노출하지 않는다.
- production lessons/Obsidian write-back은 v1에 없다.
- experiment artifacts는 별도 directory/database와 `experimentId`를 가진다.
- 실험 실패가 production routing을 바꾸지 않는다.

## V1-BR-09 — Repo Factory Integration Contract Freeze

Repo Factory 자체를 v1 closeout 중 다시 구현하지 않는다. 다음 interface만 versioned schema와 contract test로 freeze한다.

```text
RepoFactoryResult
ACPBootstrapActivationResult
Project Manifest import
Project registration
Primary CTO creation/assignment
Buzz connection
Handoff/ACK
Doctor activation result
```

Schema 변경은 compatibility rule과 version bump를 요구한다.

## V1-BR-10 — Baseline Minimum

ACP 2.0 Feasibility Slice 시작 전에 최소 다음을 확보한다.

```text
real Run >= 30
real project >= 1
represented task class >= 3
all required quality facts coverage = 100%
model identity coverage = 100%
duration coverage = 100%
usage evidence availability separately reported
false completion = 0
unauthorized merge = 0
```

30 Run이 모두 같은 trivial task이면 기준선으로 인정하지 않는다.

---

# Part IV. 최종 구현 Dependency DAG

```text
W0 Repository Protection / CI
 └─ W1 Authority & Finalization
     ├─ W2 GitHub Trust / Branch / Human Gate
     ├─ W3 Session / Handoff / Continuity
     └─ W4 Provider / Reviewer / Worker Provenance
          └─ W5 Channels / Daemon / Deployment / Migration
               └─ W6 Full Vertical Acceptance
                    └─ W7 30-Run Baseline & Fresh Review
                         └─ ACP 2.0 Gate A
```

각 Wave는 이전 Wave의 실제 entry-point test가 green일 때만 다음으로 넘어간다. 서로 독립인 코드 수정은 병렬 가능하지만, shared authority/state machine/schema를 건드리는 PR은 직렬화한다.

## Wave 0 — Repository 자체를 보호한다

1. `main`, `dev` ruleset 적용
2. PR required, force-push/delete 차단
3. required check에 다음 포함

```text
pnpm lint
pnpm typecheck
pnpm build
pnpm test
pnpm trace
node scripts/ssot-report.mjs
```

4. CI workflow digest/creator를 trusted evidence로 사용할 수 있게 pin
5. `integration/r4`의 목적을 문서화하고 필요 없으면 정리
6. README의 test count를 생성 값으로 교체

Exit:

```text
main/dev direct unsafe push 불가
fresh PR에서 모든 required CI green
build artifact가 실제 daemon/CLI를 실행 가능
```

## Wave 1 — Completion Authority를 종결한다

대상: P0-01, P0-02, P0-03, P1-01.

1. finalization state를 명시한다.

```text
ACTIVE
→ READY_FOR_CEO_REVIEW
→ CEO_APPROVED
→ MERGING
→ POST_MERGE_VERIFYING
→ COMPLETED
```

2. source mutation과 daemon-only external write 권한을 상태별로 분리한다.
3. `finalizeApprovedRun(runId)` 하나가 gate/merge/post-merge를 소유한다.
4. Human Gate 판정은 `ProductionGate.humanGateStatus()` 또는 단일 shared service만 사용한다.
5. packet 이후 Task Graph는 sealed된다.
6. finalization attempt/lease/receipt를 durable하게 만든다.

Exit:

```text
CEO CONFIRM 후 source write 불가
agentcpd만 gate/merge 가능
crash/restart 후 duplicate merge 없이 재개
COMPLETED는 post-merge evidence 없이 불가
```

## Wave 2 — GitHub Trust와 Branch Contract를 종결한다

대상: P0-05, P0-14, P1-04, P1-05 및 #356.

1. branch origin과 PR target을 분리한다.
2. GitHub mediate에 target branch/ref/resource를 전달한다.
3. branch/path-only claim이 unrelated release/check/merge를 승인하지 못하게 한다.
4. issue/check-run/branch/release pagination을 bounded fail-closed로 구현한다.
5. expected-base support를 실제 사용하거나 dead claim을 제거한다.
6. GitHub App creator identity와 check payload digest를 검증한다.

필수 matrix:

```text
feature/* : dev origin → dev target
task/*    : feature/* | dev | release/* origin/target contract
release/* : dev origin → main and dev targets
hotfix/*  : main origin → main, dev, active release/* targets
```

Exit:

```text
real release and hotfix propagation success
same-name forged check rejected
>100 issue/check fixture idempotent
base/head race policy가 거짓 보증 없이 명시됨
```

## Wave 3 — CTO lifecycle과 Continuity를 종결한다

대상: P0-04, P0-06, P0-16, P1-02.

1. outgoing `DRAINING` CTO는 기존 owned Run mutation만 허용한다.
2. incoming unbound session 전용 pending-handoff ACK endpoint를 둔다.
3. ACK는 session proof, incarnation, messageId, payloadDigest, fromGeneration을 모두 검증한다.
4. normal handoff와 recovery takeover를 분리한다.
5. provider failure event가 evaluate에서 끝나지 않고 planned failover를 실행하는 coordinator를 둔다.
6. role coverage insufficient이면 명시적으로 pause/survival한다.
7. clean Hermes CEO bootstrap을 구현한다.
8. Worker session/binding provenance를 mandatory로 만든다.

Exit:

```text
normal CTO replace end-to-end
old generation late result audit-only
GPT unavailable → Claude acting role or explicit SURVIVAL
Claude unavailable → GPT acting CTO or explicit SURVIVAL
clean install → Hermes MCP connected
```

## Wave 4 — Reviewer·Provider·Write Boundary를 종결한다

대상: P0-07, P0-08, P0-11, P0-12, P1-13~16.

1. GPT-5.6 Sol xhigh reviewer의 실제 fresh isolated invocation 경로를 만든다.
2. Claude fallback은 실제 preferred failure일 때만 사용한다.
3. reviewer isolation은 child probe로 측정한다.
4. claim/write authority model을 현실적으로 하나로 닫는다.

허용되는 두 설계 중 하나를 명시적으로 선택한다.

```text
A. Agent write가 반드시 ACP-owned writable worktree/adapter를 통과
B. Managed Write Guard의 보증을 daemon/GitHub write로 축소하고
   source write는 sandbox root + resource claim으로 보증
```

보증하지 못하는 syscall-level mediation을 문서에 남기지 않는다.

5. GPT/Claude/Grok capacity collector를 구현한다.
6. provider-reported와 estimated usage를 분리한다.
7. Grok은 optional adversarial role로만 등록 가능하게 한다.

Exit:

```text
preferred GPT blind review real success
reviewer child cannot read producer transcript/checkout/DB/credential paths
worker provenance complete
capacity unknown cannot route
actual usage evidence persisted
```

## Wave 5 — Single Authority·Channel·Deployment를 종결한다

대상: P0-09, P0-10, P0-13, P0-17, P1-11/12/17/18.

1. `agentctl` mutation은 daemon RPC/socket으로만 수행한다.
2. read-only offline inspection은 explicit read-only mode만 허용한다.
3. Buzz actor/session/binding/runtime bridge를 닫는다.
4. Telegram webhook/polling listener와 Hermes routing을 연결한다.
5. installer가 launchd plist를 실제 absolute path/environment로 render한다.
6. secrets/state directories의 owner/mode/symlink 검사를 preflight한다.
7. versioned schema migration, backup, restore를 구현한다.
8. daemon health/readiness와 supervisor restart를 검증한다.

Exit:

```text
두 번째 ControlPlane writer 생성 불가
reboot 후 agentcpd 자동 정상 복구
Telegram/Buzz authenticated round trip
migration/restore drill PASS
```

## Wave 6 — Full Vertical Acceptance

실제 Mac과 실제 GitHub repository에서 다음을 수행한다.

```text
User/Telegram or Buzz
→ Hermes authenticated MCP
→ managed run create/dispatch
→ real Primary CTO session
→ real worker binding and source change
→ exact candidate freeze
→ deterministic local/CI verification
→ GPT Sol xhigh fresh blind review
→ CEO confirm
→ daemon finalizer
→ GitHub App gate publish
→ ordered merge
→ post-merge verification
→ durable completion
```

필수 추가 canary:

- verification failure → localized manual contract evidence → repair → reverify
- blind review REVISE → CTO repair → fresh reviewer
- normal CTO handoff
- provider outage failover
- daemon kill/restart during finalization
- release branch propagation
- hotfix propagation
- real two-repo ordered merge with second repo blocked until first post-merge PASS

Exit:

```text
manual raw DB edit = 0
manual issue/check state fabrication = 0
hidden service-direct shortcut = 0
```

## Wave 7 — Baseline Observation과 Fresh Review

1. 최소 30 real Runs를 수행한다.
2. 최소 3 task class를 포함한다.
3. P0/P1 escape, owner intervention, model identity, graph shape, usage, duration을 수집한다.
4. V1-BR export를 생성한다.
5. current HEAD 기준 fresh GPT-5.6 Sol xhigh independent review를 수행한다.
6. open blocker/major를 evidence로 닫고 stale issue를 정리한다.
7. `v1.0.0` release/tag를 생성한다.

---

# Part V. Test Pyramid와 필수 증거

## Layer 1 — Unit / Constraint

- DB trigger/index negative tests
- parser/schema tests
- digest/canonicalization tests
- state transition tests

이 계층은 production readiness를 단독으로 증명하지 않는다.

## Layer 2 — Composition-root Integration

테스트는 `new ControlPlane(testConfig)`만 호출하는 것이 아니라 production composition과 같은 attach/wiring을 사용한다.

검증 대상:

- handoff authentication port attached
- continuity coordinator attached
- Buzz/ingress ports attached
- capacity observer attached
- daemon finalizer attached
- operator RPC attached

## Layer 3 — Local Daemon E2E

실제 `dist/daemon/agentcpd.js` process를 실행하고 Unix socket을 통해 Hermes/CTO/operator를 호출한다. service object direct call은 금지한다.

## Layer 4 — External Live E2E

- GitHub App
- real GitHub repo/PR/check/merge
- real Buzz relay
- real Telegram webhook/update
- real GPT/Claude/Grok CLI where configured

mock/FakeGitHub 결과는 이 계층을 대체하지 못한다.

## Layer 5 — Fault / Recovery

fault injection 지점:

```text
after state transition before outbox delivery
after gate publish before receipt completion
after first repo merge before post-merge
before/after binding switch
during migration
during daemon restart
provider session death
```

각 지점에서 duplicate side effect, stale authority, false completion이 없어야 한다.

## Evidence Bundle 규칙

각 live canary는 다음을 저장한다.

```text
reviewed commit SHA
ACP binary/schema/harness version
runId
candidate snapshot digest
role/session/generation history
verification result
review result
GitHub receipts
post-merge result
doctor report
redacted logs
exact timestamps
```

credential, raw chain-of-thought, full private transcript는 저장하지 않는다.

---

# Part VI. 최종 Production-ready Gate

다음이 모두 충족되어야 v1 `PASS`다.

```text
[ ] current HEAD open review-blocker = 0
[ ] current applicable review-major = 0 또는 Owner-accepted documented residual only
[ ] main/dev protected + required CI
[ ] CI: lint/build/typecheck/test/trace/SSOT
[ ] clean Hermes CEO bootstrap
[ ] agentctl mutation via daemon only
[ ] CEO CONFIRM → daemon finalizer → real GitHub gate → merge → post-merge
[ ] Human Gate all-items/latest-wins/current-candidate single predicate
[ ] release/hotfix origin/target contract real success
[ ] normal CTO drain/handoff/ACK real success
[ ] provider failure automatic failover or explicit SURVIVAL
[ ] GPT-5.6 Sol xhigh normal blind review real success
[ ] reviewer isolation measured, not declared
[ ] Worker binding/provenance complete
[ ] actual GPT/Claude/Grok capacity/usage collection for configured providers
[ ] Buzz exact bound session delivery/ACK
[ ] Telegram → Hermes → ACP → CTO round trip
[ ] schema migration + backup/restore drill
[ ] reboot/launchd/reconcile success
[ ] real one-repo and two-repo ordered merge
[ ] schema-valid RepoFactoryResult → ACP activation black-box canary
[ ] 최소 3개 Dogfood Project + 30개 이상 Run/Bootstrap Lifecycle observation
[ ] false completion, duplicate dispatch, stale accepted result, forged gate, unauthorized merge = 0
[ ] fresh independent A–Z review = PASS
[ ] v1.0.0 tag/release with immutable evidence index
```

Owner가 residual risk를 수용할 수 있는 항목은 availability/performance limitation뿐이다. 다음은 waiver 대상이 아니다.

```text
false completion
owner authority bypass
reviewer/producer identity collapse
stale generation acceptance
forged trusted gate
unauthorized merge
credential exposure
silent evidence degradation
```

---

# Part VII. ACP 2.0 개발 전환 규칙과 Gate A

v1의 Full Vertical Acceptance와 `v1.0.0` release가 끝나는 즉시 다음 **Pre-Gate Offline 개발**은 시작할 수 있다.

```text
Graph IR/schema draft
Offline task pack
Evaluation harness
Static structural validator
Context projection prototype
Baseline export reader
Paired experiment runner skeleton
```

이는 production ACP runtime을 변경하지 않으며, 사용자가 원하는 “v1 실테스트 후 바로 2.0 개발”에 해당한다.

다만 실제 Mid-tier substitution Feasibility Slice와 production routing 실험은 아래 Gate A를 통과한 뒤에만 시작한다.

v1 Production-ready PASS 이후 아래를 확인한다.

```text
[ ] agentcpd real deployment
[ ] Hermes migration complete
[ ] 최소 1개 Primary CTO migration complete
[ ] GitHub gate/merge/post-merge E2E
[ ] 최소 1개 real project 운영
[ ] Repo Factory integration contract frozen
[ ] B-lite telemetry / V1-BR facts reliable
[ ] real Run >= 30 또는 동등한 baseline evidence
[ ] immutable baseline export generated
```

이 Gate를 통과하면 ACP 2.0에서 허용되는 첫 개발 범위는 **offline/shadow Feasibility Slice**다.

```text
Task Profile schema
Eligibility Gate prototype
Context projection prototype
Smallest static graph compiler
Structural validator
Verifier portfolio experiment
Failure packet prototype
Paired holdout experiment harness
```

아직 금지:

```text
production router 교체
unqualified mid-tier automatic promotion
adaptive topology production mutation
Obsidian runtime dependency
lesson/policy automatic promotion
Gate 약화
```

최종 전환 순서:

```text
v1 code/live blockers 종결
→ v1 Full Vertical Acceptance
→ 3 projects / 30 lifecycle observation
→ fresh A–Z PASS
→ v1.0.0 release
→ ACP2 Pre-Gate Offline 개발
→ Gate A evidence 확인
→ ACP2 Feasibility Slice
→ paired holdout non-inferiority experiment
→ Gate B를 통과한 task class만 production canary
```

---

# Part VIII. 구현 에이전트에게 그대로 전달할 최종 지시문

```text
이 문서를 Agent Control Plane v1의 유일한 구현 종결 Review/Addendum으로 사용한다.
Repository에 vendored된 AGENT_CONTROL_PLANE_PRD_v1.3_FINAL.md는 제품 기능 SSOT다.
이전 A–Z 리뷰와 중간 review 문서는 별도로 합성하지 말고 historical evidence로만 취급한다.
이 문서의 finding, Wave, Acceptance, Evidence, Release Gate를 하나의 dependency graph로 실행한다.

목표는 이슈를 닫는 것이 아니라 실제 Mac에서 Agent Control Plane v1을 production-ready로
동작시키고, ACP 2.0 feasibility 실험을 위한 신뢰 가능한 baseline까지 만드는 것이다.

진행 규칙:
1. 문서의 P0/P1/V1-BR 요구를 current HEAD에서 재현한다.
2. 이미 수정된 이슈는 재현 evidence와 load-bearing regression으로 닫는다.
3. 실제 남은 항목은 Wave 0→7 dependency 순서로 구현한다.
4. service object direct test만으로 production path를 완료했다고 주장하지 않는다.
5. daemon/MCP/operator/GitHub/Buzz/Telegram/provider 실제 entry point를 검증한다.
6. Gate, Owner Authority, reviewer independence, exact evidence를 약화하지 않는다.
7. ACP 2.0 기능(Context Compiler, graph optimizer, model substitution, Obsidian 등)을 v1에 넣지 않는다.
8. 단, V1-BR telemetry/export/version facts는 v1 closeout 범위다.
9. external credential이 없으면 mock으로 완료하지 말고 prerequisite와 live acceptance를 분리한다.
10. 모든 코드 변경은 regression, negative test, live evidence 중 해당되는 증거를 갖는다.
11. open blocker=0, applicable major=0, fresh independent review PASS 전에는 완료 선언하지 않는다.
12. v1.0.0 release evidence와 ACP 2.0 Gate A checklist를 최종 보고한다.
13. 최종 산출물로 requirement/finding→issue→commit→test→live evidence 추적표를 제출한다.
14. 모든 external prerequisite는 owner action, secret, expected evidence, blocking scope를 명시한다.
15. partial completion을 Production-ready로 부르지 않는다.

최종 산출물:
- current-state triage report
- GitHub issue/milestone/dependency DAG
- implemented PRs and exact SHAs
- deterministic + composition + daemon + live evidence bundle
- migration/backup/reboot report
- dogfood 30-lifecycle zero-count report
- fresh independent A–Z verdict
- v1.0.0 release note/evidence index
- ACP 2.0 Pre-Gate/Gate A readiness report

먼저 현재 finding→issue→dependency DAG와 구현 순서를 짧게 보고한 뒤,
치명적인 Owner 결정이 필요하지 않으면 승인 대기 없이 구현·테스트·배포 준비·증거 정리까지 진행한다.
```

---

# Part IX. 최종 판정문

> 현재 `main@312772fba9a6`는 높은 수준의 hardened alpha이며, 핵심 설계 방향은 유지해야 한다. 그러나 완료 authority, GitHub finalization, Human Gate, CTO handoff, Continuity execution, reviewer isolation, provider usage, channel wiring, single-daemon authority, migration과 live E2E가 닫히지 않아 Production-ready는 BLOCK이다. 이 문서의 Wave 0~7을 완료하면 v1은 단순 orchestration demo가 아니라 네 Mac에서 Hermes와 교체 가능한 CTO/worker들을 운영하는 실제 Control Plane이 된다. Full Vertical Acceptance 뒤에는 ACP 2.0의 Pre-Gate Offline 구현을 즉시 시작할 수 있고, 3개 Project·30 Lifecycle 기준선과 Gate A가 닫히면 “Qualified mid-tier + system = frontier-equivalent final outcome” 명제를 paired offline/shadow 방식으로 검증한다. v1에 2.0 기능을 섞지 않고, v1을 신뢰 가능한 운영·측정 기반으로 완성하는 것이 가장 빠른 2.0 경로다.


---

# Part X. 문서 자체 검증

```text
현재 기준 SHA: 312772fba9a64adc760f0766bfa9200fadeb3b78
문서 상태: FINAL CLOSURE SSOT
이전 A–Z 리뷰 대체: YES
P0 상세 Finding: 18
P1 상세 Finding: 20
ACP2 Baseline Readiness Contract: 10
Hard Invariant Closure Matrix: 포함
Security Threat Model: 포함
Repo Factory 책임 경계: 포함
Clean-install bootstrap: 포함
Migration/backup/reboot: 포함
Full Vertical E2E: 포함
3 projects / 30 lifecycle: 포함
ACP2 Pre-Gate 즉시 착수 범위: 포함
ACP2 runtime capability scope creep: 금지
Markdown fence marker: 166 (짝수/정상=True)
현재 문서 줄 수: 2548
```

---

# Appendix A. Evidence Index

## Live repository state references

- [Branches API snapshot](https://api.github.com/repos/MongLong0214/agent-control-plane/branches?per_page=100)
- [Main workflow runs](https://api.github.com/repos/MongLong0214/agent-control-plane/actions/runs?branch=main&per_page=20)
- [Open review blockers](https://github.com/MongLong0214/agent-control-plane/issues?q=is%3Aissue+is%3Aopen+label%3Areview-blocker)
- [Open review majors](https://github.com/MongLong0214/agent-control-plane/issues?q=is%3Aissue+is%3Aopen+label%3Areview-major)

## Repository

- [Reviewed commit](https://github.com/MongLong0214/agent-control-plane/commit/312772fba9a64adc760f0766bfa9200fadeb3b78)
- [README](https://github.com/MongLong0214/agent-control-plane/blob/312772fba9a64adc760f0766bfa9200fadeb3b78/README.md)
- [Acceptance ledger](https://github.com/MongLong0214/agent-control-plane/blob/312772fba9a64adc760f0766bfa9200fadeb3b78/docs/ACCEPTANCE.md)
- [ACP PRD v1.3](https://github.com/MongLong0214/agent-control-plane/blob/312772fba9a64adc760f0766bfa9200fadeb3b78/docs/prd/AGENT_CONTROL_PLANE_PRD_v1.3_FINAL.md)
- [Repo Factory Integration PRD v1.1](https://github.com/MongLong0214/agent-control-plane/blob/312772fba9a64adc760f0766bfa9200fadeb3b78/docs/prd/REPO_FACTORY_CONTROL_PLANE_INTEGRATION_PRD_v1.1_FINAL.md)

## Core runtime

- [Database](https://github.com/MongLong0214/agent-control-plane/blob/312772fba9a64adc760f0766bfa9200fadeb3b78/src/db/database.ts)
- [Schema](https://github.com/MongLong0214/agent-control-plane/blob/312772fba9a64adc760f0766bfa9200fadeb3b78/src/db/schema.sql)
- [Run Engine](https://github.com/MongLong0214/agent-control-plane/blob/312772fba9a64adc760f0766bfa9200fadeb3b78/src/run/run-engine.ts)
- [Task Graph](https://github.com/MongLong0214/agent-control-plane/blob/312772fba9a64adc760f0766bfa9200fadeb3b78/src/run/task-graph.ts)
- [Binding Registry](https://github.com/MongLong0214/agent-control-plane/blob/312772fba9a64adc760f0766bfa9200fadeb3b78/src/session/binding-registry.ts)
- [Session Registry](https://github.com/MongLong0214/agent-control-plane/blob/312772fba9a64adc760f0766bfa9200fadeb3b78/src/session/session-registry.ts)

## Trust and verification

- [Managed Write Guard](https://github.com/MongLong0214/agent-control-plane/blob/312772fba9a64adc760f0766bfa9200fadeb3b78/src/guard/managed-write-guard.ts)
- [Claims](https://github.com/MongLong0214/agent-control-plane/blob/312772fba9a64adc760f0766bfa9200fadeb3b78/src/claims/claim-registry.ts)
- [Sandbox](https://github.com/MongLong0214/agent-control-plane/blob/312772fba9a64adc760f0766bfa9200fadeb3b78/src/verify/sandbox.ts)
- [Worktree](https://github.com/MongLong0214/agent-control-plane/blob/312772fba9a64adc760f0766bfa9200fadeb3b78/src/verify/worktree.ts)
- [Blind Review](https://github.com/MongLong0214/agent-control-plane/blob/312772fba9a64adc760f0766bfa9200fadeb3b78/src/review/blind-review.ts)
- [Production Gate](https://github.com/MongLong0214/agent-control-plane/blob/312772fba9a64adc760f0766bfa9200fadeb3b78/src/ceo/production-gate.ts)
- [GitHub Kernel](https://github.com/MongLong0214/agent-control-plane/blob/312772fba9a64adc760f0766bfa9200fadeb3b78/src/github/github-kernel.ts)
- [Credential Store](https://github.com/MongLong0214/agent-control-plane/blob/312772fba9a64adc760f0766bfa9200fadeb3b78/src/github/credential-store.ts)

## Runtime operations

- [Capacity](https://github.com/MongLong0214/agent-control-plane/blob/312772fba9a64adc760f0766bfa9200fadeb3b78/src/capacity/capacity-monitor.ts)
- [Continuity](https://github.com/MongLong0214/agent-control-plane/blob/312772fba9a64adc760f0766bfa9200fadeb3b78/src/continuity/continuity-kernel.ts)
- [CTO Lifecycle](https://github.com/MongLong0214/agent-control-plane/blob/312772fba9a64adc760f0766bfa9200fadeb3b78/src/cto/cto-lifecycle.ts)
- [Doctor](https://github.com/MongLong0214/agent-control-plane/blob/312772fba9a64adc760f0766bfa9200fadeb3b78/src/doctor/doctor.ts)
- [Watchdog](https://github.com/MongLong0214/agent-control-plane/blob/312772fba9a64adc760f0766bfa9200fadeb3b78/src/doctor/watchdog.ts)
- [Repair](https://github.com/MongLong0214/agent-control-plane/blob/312772fba9a64adc760f0766bfa9200fadeb3b78/src/doctor/repair.ts)
- [Outbox](https://github.com/MongLong0214/agent-control-plane/blob/312772fba9a64adc760f0766bfa9200fadeb3b78/src/outbox/outbox.ts)

## Channels and interfaces

- [Hermes MCP](https://github.com/MongLong0214/agent-control-plane/blob/312772fba9a64adc760f0766bfa9200fadeb3b78/src/mcp/hermes-server.ts)
- [CTO MCP](https://github.com/MongLong0214/agent-control-plane/blob/312772fba9a64adc760f0766bfa9200fadeb3b78/src/mcp/cto-server.ts)
- [Ingress Guard](https://github.com/MongLong0214/agent-control-plane/blob/312772fba9a64adc760f0766bfa9200fadeb3b78/src/ingress/ingress-guard.ts)
- [Telegram](https://github.com/MongLong0214/agent-control-plane/blob/312772fba9a64adc760f0766bfa9200fadeb3b78/src/ingress/telegram.ts)
- [Buzz](https://github.com/MongLong0214/agent-control-plane/blob/312772fba9a64adc760f0766bfa9200fadeb3b78/src/buzz/buzz-adapter.ts)
- [Agent CLI](https://github.com/MongLong0214/agent-control-plane/blob/312772fba9a64adc760f0766bfa9200fadeb3b78/src/cli/agentctl.ts)
- [Daemon](https://github.com/MongLong0214/agent-control-plane/blob/312772fba9a64adc760f0766bfa9200fadeb3b78/src/daemon/agentcpd.ts)
- [Daemon lifecycle](https://github.com/MongLong0214/agent-control-plane/blob/312772fba9a64adc760f0766bfa9200fadeb3b78/src/daemon/daemon.ts)
- [launchd plist](https://github.com/MongLong0214/agent-control-plane/blob/312772fba9a64adc760f0766bfa9200fadeb3b78/deploy/com.agentcontrolplane.agentcpd.plist)

## ACP 2.0 cross-reference

- `AGENT_CONTROL_PLANE_PRD_v2.0_RESEARCH_CONSOLIDATED_FINAL.md` — Gate A와 Baseline contract의 상위 규범
- `ACP2_FRONTIER_MODEL_SUBSTITUTION_TECHNICAL_FEASIBILITY_REVIEW_2026-08-13.md` — mid-tier substitution의 기술 타당성 근거
- `ACP2_303_SOURCE_EVIDENCE_LEDGER_2026-08-13.md` — 연구 evidence ledger

## Current blocking issues

- [#381 Human Gate merge predicate](https://github.com/MongLong0214/agent-control-plane/issues/381)
- [#382 Release/Hotfix lineage](https://github.com/MongLong0214/agent-control-plane/issues/382)
- [#383 Guard state vs GitHub finalization](https://github.com/MongLong0214/agent-control-plane/issues/383)
- [#378 Handoff ACK production path](https://github.com/MongLong0214/agent-control-plane/issues/378)
- [#386 GitHub Kernel not invoked by shipped surface](https://github.com/MongLong0214/agent-control-plane/issues/386)
- [#360 Reviewer isolation](https://github.com/MongLong0214/agent-control-plane/issues/360)
- [#355 Managed Write Guard not on source path](https://github.com/MongLong0214/agent-control-plane/issues/355)
- [#356 GitHub mediate target missing](https://github.com/MongLong0214/agent-control-plane/issues/356)
- [#240 Real two-repo merge](https://github.com/MongLong0214/agent-control-plane/issues/240)
- [#241 Observation window](https://github.com/MongLong0214/agent-control-plane/issues/241)
- [#242 GitHub App](https://github.com/MongLong0214/agent-control-plane/issues/242)
- [#243 Buzz live delivery](https://github.com/MongLong0214/agent-control-plane/issues/243)

---

Document SHA-256: `05bb82a3442197545140c73786cab3d09671b197b50d63903bffccf8e6750828`
