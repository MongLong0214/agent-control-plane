# Agent Control Plane — Product Requirements Document

- **버전:** 1.3 FINAL
- **상태:** 구현·원자 티켓 분해 승인
- **대체 문서:** `AGENT_CONTROL_PLANE_PRD_v1.2_FINAL.md`
- **동반 Bootstrap SSOT:** `REPO_FACTORY_CONTROL_PLANE_INTEGRATION_PRD_v1.1_FINAL.md`
- **배포 형태:** Local · Single Owner · 24/7 Workstation Service
- **주 인터페이스:** Buzz·Telegram을 통한 Hermes
- **최종 개정일:** 2026-08-12
- **구현 SSOT 문서 집합:** 이 문서 + `REPO_FACTORY_CONTROL_PLANE_INTEGRATION_PRD_v1.1_FINAL.md` 두 개만 사용
- **비규범 문서:** 이전 PRD와 Production Review 문서는 결정 이력일 뿐 구현 입력으로 사용하지 않음

---

# 1. 한 문장 정의

> **Agent Control Plane은 Managed Project Intent를 검증된 Production-Ready 결과로 전환하고, Logical Role을 교체 가능한 Model Runtime Session에 동적으로 Binding하는 단일 Local Runtime Authority다.**

Hermes는 계속 일반 개인비서로 자유롭게 사용한다. Control Plane은 실제 프로젝트 실행·변경·Bootstrap에만 활성화된다. 활성화된 이후에는 다음을 전부 소유한다.

```text
Official Run State
Session/Role Binding
Global Resource Claim
Verification
Mandatory Blind Review
Trusted GitHub Gate·Merge
Continuity
Doctor
B-lite Telemetry
```

---

# 2. 규범 언어와 권위 우선순위

이 문서의 **MUST / MUST NOT / SHOULD / MAY**는 규범적 요구사항이다.

## 2.1 우선순위

1. 이 문서가 Runtime·Security·Merge·Session·Verification·Blind Review·Continuity·State의 최종 권위다.
2. Repo Factory PRD가 Project Bootstrap Compiler의 최종 권위다.
3. 승인된 Project Manifest Digest가 Portable Project Contract의 권위다.
4. Local Registry는 Machine-local Binding과 Drift만 소유한다.
5. Git/GitHub Fact는 Evidence이며 Chat·Agent Claim은 완료 권위가 아니다.

## 2.2 SSOT 분리

```text
Portable Project Contract SSOT = Approved Project Manifest Digest
Local Checkout Binding SSOT    = Agent Control Plane Repository Registry
Dynamic Runtime SSOT           = SQLite State
Technical Candidate Evidence   = Exact Git Tree/Diff/Check
Final Runtime Authority        = agentcpd
Owner Authority                = Non-delegable Human Gate
```

---

# 3. 제품 비전

실제 고자율 IT 조직처럼 동작한다.

```text
Owner
→ Hermes / CEO가 업무 정의
→ Primary Opus CTO가 과설계를 제거하고 실행 소유
→ Worker 병렬 구현
→ Control Plane Exact Verification
→ Independent Blind Review가 결과 공격
→ CTO가 모든 일반 Revision 종결
→ Hermes는 최종 Production-Ready Candidate만 검토
→ Owner는 정말 중대한 결정에만 개입
```

최적화 목표:

- False Completion 없는 높은 자율성
- Project·Session·Provider Topology의 유연성
- Owner Interrupt 최소화
- 명시적 Authority와 Evidence
- Provider Exhaustion에도 유지되는 Continuity
- 작은 작업의 최소 절차
- 미래 Level 6 자가개선을 위한 Decision-grade Telemetry

---

# 4. Hard Invariant

다음은 Advisory가 아니다.

## CP-HI-01 — Managed Write Guard

Project 성격의 모든 Write는 유효한 Managed Run Identity를 가져야 한다.

```text
Git Repository File Mutation
Commit / Branch / Tag
GitHub PR / Issue / Release / Ruleset Write
Project Manifest / Verification Contract Change
Programmatic Merge
```

Tool Adapter가 Operation과 Target Path를 검사한다. Hermes의 분류 판단만 믿지 않는다.

DIRECT는 Read-only Repo 분석과 Managed Repo 밖의 독립 Artifact 생성만 허용한다.

## CP-HI-02 — Single Runtime Authority

Project Repository·Repo Factory Runtime·CTO·Worker·Reviewer는 독자적으로 다음을 할 수 없다.

```text
Run 완료 선언
Authoritative Production Gate 게시
Programmatic Merge
```

## CP-HI-03 — Candidate Contract Pinning

Verification 전에 Approved Contract Digest와 Candidate Snapshot을 Pin한다. Candidate가 자신을 판정하는 Gate를 약화할 수 없다.

## CP-HI-04 — Independent Quality Role

Run의 Producer Session 집합:

```text
Primary CTO
Worker
Integrator
Repairer
Non-blind Reviewer
```

Blind Reviewer Session은 이 집합에 속할 수 없다. Final CEO Session은 해당 Run의 Primary CTO나 Blind Reviewer Session과 같을 수 없다.

## CP-HI-05 — Trusted GitHub Credential

`acp-production-gate` 게시와 Programmatic Merge에 쓰는 GitHub Authority Credential은 `agentcpd`만 접근한다.

다음 환경에는 주입 금지:

```text
CTO
Worker
Reviewer
Verification Subprocess
Repo Factory
Buzz
Telegram
```

## CP-HI-06 — Exact Evidence

Verification·Blind Review·Gate Publish·Merge는 하나의 Exact Candidate Snapshot Digest에 묶인다. Source가 바뀌면 이전 Evidence는 전부 Stale이다.

## CP-HI-07 — Human Role은 대체 불가

CEO·CTO·Worker·Reviewer Runtime은 Failover 가능하지만 Owner-only Authority는 대체할 수 없다.

## CP-HI-08 — Silent Degradation 금지

Evidence 부재·Coverage 누락·Stale Result·Probe Failure·Isolation 상실을 PASS로 표시하면 안 된다.

---

# 5. 용어

## 5.1 Project

장기 관리 대상. Project Activity는 Primary CTO Binding 존재 여부에서 파생한다.

```text
Primary CTO Binding 있음 → activity=ACTIVE
Primary CTO Binding 없음 → activity=INACTIVE
```

Availability는 별도다.

```text
HEALTHY | DEGRADED | UNAVAILABLE
```

## 5.2 Repository

Project/Run이 사용하는 Git Repository. 등록 Repository일 수도 있고 특정 Run에서만 임시로 건드리는 미등록 Repository일 수도 있다.

## 5.3 Run

하나의 Owner/Hermes 목표를 Contract부터 최종 결과까지 추적하는 Official 실행 단위다. 여러 Repository와 Dynamic Task Graph를 포함할 수 있다.

## 5.4 Task

Run 내부의 제한된 작업 단위. 병렬·의존 실행과 여러 Attempt를 가질 수 있다.

## 5.5 Runtime Session

GPT·Claude·Grok 또는 미래 Runtime의 실제 Session. 영구 조직 Identity가 아니다.

## 5.6 Session Incarnation

Session이 실제 생성된 한 번의 생명주기 ID. Session을 새로 띄우면 바뀐다.

## 5.7 Role Binding

Logical Role을 특정 Session에 `bindingGeneration`으로 연결한 상태다.

## 5.8 Role

```text
CEO
BOOTSTRAP_CTO(run)
PRIMARY_CTO(project)
BLIND_REVIEWER(run)
WORKER(task)
OPTIONAL_ADVERSARIAL_REVIEWER(run)
```

## 5.9 Candidate Snapshot

Verification·Review 대상이 되는 Exact Multi-repository Candidate의 불변 표현이다.

## 5.10 Production-Ready Candidate

Pinned Contract·Configured Verification·Mandatory Blind Review·Unresolved Blocker 0·CTO Final Approval을 만족한 Candidate다.

## 5.11 Resource Claim

Repository·Branch·Worktree·Exact Path의 명백한 Cross-Run/CTO 충돌을 방지하는 짧은 Coordination Claim이다.

---

# 6. DIRECT와 MANAGED

## 6.1 DIRECT

Hermes가 직접 처리한다.

```text
번역
커리어 상담
웹 리서치·크롤링
요약
아이디어 검토
기술 설명
Read-only Repository 분석
Managed Repo 밖 독립 문서·Artifact
```

실제 프로젝트 실행이 명확하지 않으면 DIRECT가 Default다.

## 6.2 MANAGED

다음은 Managed다.

```text
Repository Mutation
PR/Issue 실행
Feature/Bug/Refactor/Release
Project Bootstrap
Production-ready Review·Merge
Verification Contract Change
```

Managed Work는 Official Run을 만든다.

## 6.3 Dynamic Promotion

DIRECT 대화 중 실제 실행 요청이 나오면 그 시점에 MANAGED로 승격한다. 기존 조사·논의는 Run Contract에 요약할 수 있지만 Run 생성 전에 Write를 시작하면 안 된다.

## 6.4 Capacity Class

GPT Capacity를 다음처럼 구분한다.

```text
1. Managed CEO Decision / Owner Interaction
2. Mandatory Blind Review
3. Lightweight DIRECT Conversation
4. DIRECT Bulk Work
5. Luna Max Worker Capacity
```

가능한 한 Owner의 가벼운 대화는 유지한다. 다만 큰 DIRECT 작업은 Critical Managed Role을 고갈시키기 전에 다른 Provider로 Routing·축소·중지할 수 있다.

---

# 7. 전체 아키텍처

```text
User
├─ Buzz
└─ Telegram
      ↓ Authenticated Ingress
Hermes Logical CEO Endpoint
      ↓
┌──────────────── Agent Control Plane ────────────────┐
│ Run / Contract                                      │
│ Session Registry + Role Binding                     │
│ Provider Capacity Monitor                           │
│ Role Continuity Kernel                              │
│ Task / Resource Receipt                             │
│ Verification Engine                                 │
│ Mandatory Blind Review Gate                         │
│ GitHub Integration Kernel                           │
│ Doctor + Watchdog                                   │
│ Outbox + Audit + Telemetry                          │
└─────────────────────────────────────────────────────┘
      ↓ Buzz Dispatch
Dynamic Claude Opus Primary CTO Sessions
      ↓
GPT / Claude / Optional Grok Workers
```

Repo Factory는 제한된 Bootstrap Capability로 호출하며 두 번째 Runtime Authority가 아니다.

---

# 8. 역할과 책임

## 8.1 Owner

극히 예외적이고 중대한 결정을 담당한다. Owner Interrupt 목표는 대략 3% 미만이지만 Hard SLA가 아니라 운영 원칙이다.

## 8.2 Hermes / CEO

소유 범위:

```text
DIRECT Assistance
DIRECT vs MANAGED 분류
PRD·ADR·Ticket·Acceptance Specification
run.executionMode
Priority
제품·Architecture Level Decision
CTO Escalation Resolution
Final Production-Ready Confirm
Owner Escalation Filtering
```

일반 구현·Test·Review Revision은 받지 않는다.

## 8.3 Primary CTO

Primary CTO는 영구 Identity가 아니라 Dynamic Claude Opus Session Assignment다.

소유 범위:

```text
Read-only Discovery
Anti-overengineering Review
Lean Execution Plan·Dynamic Task Graph
Worker/Provider/Concurrency Routing
Cross-repository Engineering Decision
Integration
Revision Loop
Final CTO Approval
```

Official Run이 존재하고 안전한 In-scope Work가 남아 있으면 수동 대기하면 안 된다. Run이 0개면 임의 유지보수·Refactor를 시작하지 않는다.

## 8.4 Worker

Bounded Task를 수행한다. GPT Disposable Capacity가 건강한 경우 기계적 Programming은 GPT Luna Max를 우선한다. Terra·Sonnet은 계속 사용할 수 있으나 무의미한 대규모 Fan-out을 Default로 하지 않는다.

## 8.5 Blind Reviewer

Fresh·Isolated Session이다. Preferred Runtime은 GPT-5.6 Sol xhigh, Continuity Fallback은 Fresh Claude Opus다.

## 8.6 Control Plane

State·Authority·Admission·Evidence·Trusted Credential·Lifecycle을 소유한다. CTO의 의미적 Engineering 판단까지 중앙 통제하지 않는다.

---

# 9. Project·Repository·Session·Binding

## 9.1 Project Registry

Project Record는 Project Identity와 Activation Reference만 가진다. Project Manifest 복제본이 아니다.

```text
projectId
activeManifestDigest
activity = Primary CTO Binding에서 파생
availability = Runtime Health에서 파생
createdAt
```

## 9.2 Repository Registry

Machine-local Binding을 저장한다.

```text
Normalized Remote Identity
Absolute Checkout Path
Project Relation
Trust Class
Active Manifest Digest
Last Observed Head
Drift State
```

Absolute Path는 Committed Manifest에 들어가지 않는다.

## 9.3 Session Lifecycle

```text
STARTING
READY
DRAINING
STOPPED
ERROR
```

`BUSY`는 Owned Active Run에서 파생하며 Session Lifecycle로 저장하지 않는다.

## 9.4 Binding

```text
roleKey
sessionId
sessionIncarnation
bindingGeneration
mode = PREFERRED | FALLBACK
status = ACTIVE | REVOKED
```

Project당 Active Primary CTO Binding은 최대 1개다.

## 9.5 CTO 자동 생성

Primary CTO가 없는 Project에 Run이 들어오면:

```text
Fresh Claude Opus Session 생성
→ Buzz 연결
→ Doctor Readiness
→ PRIMARY_CTO(project) Binding
→ Project ACTIVE
→ Run Dispatch
```

Run도 CTO도 없으면 Project는 INACTIVE이며 자율 유지보수를 하지 않는다.

---

# 10. CTO 교체·종료·Suspend

## 10.1 정상 교체

교체 요청은 언제든 가능하지만 실제 Switchover는 기존 CTO의 Active Run이 0일 때만 가능하다.

```text
Replacement Requested
→ Old CTO DRAINING
→ New Run Dispatch 금지
→ New Run QUEUED
→ Existing Run 완료
→ Structured Handoff
→ New Session READY
→ HANDOFF_ACK
→ Atomic Binding Generation Switch
→ Old Session STOPPED
```

장기 BLOCKED Run이 교체를 무기한 막으면 CTO/CEO가 Continue·Cancel·Capacity Suspend 중 하나를 결정해야 한다.

## 10.2 Handoff Package

필수:

```text
Project Status
Active Manifest Digest
중요 Recent Decision
Open Blocker
Queued Work
Repository/Branch Facts
Known Risk
Recommended Next Action
```

장기 지식은 Git·ADR·CommitLore에 남기고 Handoff에는 현재 운영 문맥만 넣는다.

## 10.3 Emergency Takeover

Owner Session/Runtime이 실제로 불가할 때만 사용한다.

```text
Control Plane·Git Evidence로 Recovery Package 생성
→ RECOVERY_TAKEOVER Event
→ Old Binding Generation Revoke
→ Fresh Acting CTO
→ RECOVERY_ACK
→ Run Owner 변경
```

Old Generation의 늦은 Result는 Audit-only다.

## 10.4 Capacity Suspend

심각한 Capacity Crisis에서는 Hermes가 특정 Project Suspend를 제안할 수 있다. Owner 승인이 필수다.

```text
New Work 정지
Active Run Checkpoint
Worker 안전 정리
Recovery Package
Primary CTO Binding 제거
Project INACTIVE
```

---

# 11. Run과 Task Graph

## 11.1 Run 생성과 Owner Pinning

Run 생성 시 `ownerBinding=null`일 수 있다. Dispatch Admission에서 다음을 Pin한다.

```text
ownerSessionId
ownerBindingGeneration
ownerSessionIncarnation
```

정상 상황에서 Run Owner는 완료까지 고정된다. Emergency Takeover만 예외다.

## 11.2 Run Concurrency

Primary CTO는 여러 Run을 동시에 소유할 수 있고 각 Run도 여러 Task를 병렬 실행할 수 있다. 기본 Global/Project Hard Cap은 없다.

CTO 판단 입력:

```text
Dependency
Write/Resource Conflict
CPU/RAM/Swap
Provider Quota Bucket
Available Token/Runtime
Review Bottleneck
Failure History
External API Constraint
```

## 11.3 Dynamic Task Graph

CTO는 Graph를 생성·수정·확장·직렬화한다. Control Plane은 Machine-checkable Dependency·Resource Claim·Completion Evidence만 검증한다.

## 11.4 Multi-repository Run

Repository별 Branch·Worktree·PR State를 가진다. 하나의 Run이라고 Cross-repo Merge가 Atomic한 것은 아니다.

Run Contract 필수:

```text
Repository Role
Per-repo Candidate Snapshot
Verification Order
PR/Merge Dependency
Merge Order
Partial Merge State
Compensation/Rollback
```

---

# 12. Run Execution Mode

필드명은 `run.executionMode`다.

## 12.1 SIMPLE

작고 낮은 위험의 작업. 별도 Plan 문서는 생략할 수 있지만 Task Contract·Candidate Snapshot·Verification·Blind Review는 필수다.

## 12.2 STANDARD

일반 Feature·Bug·Refactor·Multi-task 작업. Lean Plan 필수.

## 12.3 GUARDED

Security·Auth·Migration·Benchmark Methodology·Sensitive Data·Release·Governance·Irreversible Risk 작업. Risk Control·Rollback·강한 Verification 필수.

## 12.4 Mode Decision

Hermes가 Mode를 선택한다. CTO는 Buzz에서 Challenge할 수 있고 최종 결정은 Hermes가 한다.

---

# 13. Task Contract와 Lean Planning

## 13.1 Task Contract

Hermes가 권위 있는 명세를 작성한다.

```text
Goal
Why
Scope / Non-goal
Acceptance
Priority
Human Gate
필요한 PRD·ADR·Ticket
```

## 13.2 Plan 전 Read-only Discovery

CTO는 File Read·Search·Non-mutating Command·Git Status/History를 수행할 수 있다. File Mutation·Implementation Worker Spawn·External Write는 금지다.

## 13.3 De-overengineering Review

CTO는 현재 목표·Production Safety·Maintainability에 필요하지 않은 기술적 복잡성을 제거해야 한다.

기본 제거 후보:

```text
Unused Abstraction
Extra Service/Layer
Redundant State
Premature Policy DSL
Unnecessary Approval Gate
Excessive DB Normalization
Future-only Feature
Unconsumed Schema Field
```

## 13.4 Lean Plan

STANDARD/GUARDED Plan은 다음만 포함한다.

```text
Task
Dependency
Repository/Branch/Worktree Intent
Verification Intent
Known Conflict
Risk / Escalation Point
```

SIMPLE에 Verbose Graph DSL을 강제하지 않는다.

---

# 14. Provider Capacity와 Autonomous Routing

## 14.1 Provider Adapter

기본 Deployment Provider는 GPT·Claude·Optional Grok이다. 실제 Subscription Plan·Quota Size·Expiry는 Local Deployment Config이며 PRD Constant가 아니다.

현재 운영값처럼 GPT/Claude x20, Grok 소형 Plan·만료 예정 등의 정보는 Local Config에 기록할 수 있지만 Architecture Contract가 아니다. Optional Provider를 끄더라도 Role/Run Contract가 깨지면 안 된다.

## 14.2 Usage Probe

Provider Adapter는 가장 안정적인 Source를 선택한다.

```text
Structured Local Interface
Official CLI/Status Interface
/usage Parsing
Explicitly Approved Stable Source
```

Event-driven Refresh + 짧은 Configurable Freshness Cache를 사용한다.

반드시 Refresh:

```text
Run Dispatch Admission 전
큰 Worker Fan-out 전
Mandatory Blind Review 전
Continuity 평가 전
Doctor Capacity Report 전
Provider Switch/Allocation Failure 시
```

Dashboard를 위해 모든 Provider를 매분 Polling하지 않는다.

## 14.3 Capacity Model

```json
{
  "provider": "gpt",
  "sensorHealth": "HEALTHY",
  "runtimeHealth": "HEALTHY",
  "allocationAdmission": "OPEN",
  "observedAt": "...",
  "buckets": [
    {
      "id": "rolling-5h",
      "remainingPercent": 62,
      "resetAt": "...",
      "capabilities": ["ceo", "blind-review", "luna-worker"]
    }
  ]
}
```

정식 상태:

```text
sensorHealth        = HEALTHY | STALE | ERROR
runtimeHealth       = HEALTHY | DEGRADED | UNAVAILABLE
allocationAdmission = OPEN | CONSERVE | SUSPENDED
```

`STALE`은 Freshness Window 안에서만 유효하다. Window가 지나면 신규 Allocation을 중단한다.

정상 Routing에 `UNKNOWN quota`는 없다. Probe가 실패하면 신규 Allocation을 Suspend하고 기존 Critical Session은 별도 Runtime Health Probe를 수행한다.

## 14.4 Advisory Capacity State

```text
HEALTHY
CONSERVE
CRITICAL
EXHAUSTED
```

관련 Bucket·Reset·Burn Rate·Role Demand를 종합한다. CTO는 Raw/Normalized Fact를 받고 Worker/Concurrency의 최종 Router다.

## 14.5 Role Priority

```text
GPT
1. Managed CEO / Owner Interaction
2. Mandatory Blind Review
3. Lightweight DIRECT Conversation
4. DIRECT Bulk Work
5. Luna Max Worker

Claude
1. Active Primary/Acting CTO Continuity
2. Acting CEO/Reviewer Continuity
3. Sonnet Worker

Grok
Optional Adversarial Review Only
Critical Path 단독 의존 금지
```

Priority는 고정하되 Reserve 비율은 동적이다. 30% 같은 고정 Reserve를 두지 않는다.

계산 입력:

```text
Quota Bucket
Reset Time
Burn Rate
In-flight Run
예상 Mandatory Review
Role Coverage Demand
```

## 14.6 Routing Guidance

```text
Mechanical Low-ambiguity Code → Luna Max 우선
Normal Implementation → Luna/Sonnet/Terra 중 CTO 판단
Complex Semantic Work → Sonnet 또는 CTO 직접
Architecture/Root Cause/High Risk → Opus CTO 직접
Optional Diversity → Grok
```

Token을 소모하기 위한 대규모 Fan-out을 금지한다.

---

# 15. Role Continuity Kernel

## 15.1 Role과 Runtime 분리

Role은 안정적이고 Runtime Session은 교체 가능하다.

Preferred Normal Binding:

```text
CEO Role             → Hermes / GPT-5.6 Sol
PRIMARY_CTO(project) → Claude Opus
BLIND_REVIEWER(run)  → Fresh GPT-5.6 Sol xhigh
Mechanical Worker    → GPT Luna Max if Disposable Capacity Healthy
```

Continuity에서 Runtime이 바뀌어도 Logical Role은 유지된다.

## 15.2 Continuity Mode

```text
NORMAL
DEGRADED
SURVIVAL
```

Grok은 Optional이므로 Grok 부재만으로 DEGRADED가 되지 않는다.

## 15.3 RoleCoveragePlan

Failover 전에 다음을 계산한다.

```text
Required Active Roles
Available Quota Buckets / Capabilities
Session Spawn Capability
Role Isolation
Project Priority
In-flight Work
Expected Reset
```

결과:

```text
FULL_COVERAGE
PARTIAL_COVERAGE
NO_VALID_COVERAGE
```

가능한 Action:

```text
WAIT_FOR_RESET
FALLBACK_ROLE
PAUSE_NEW_WORK
OWNER_APPROVED_PROJECT_SUSPEND
SURVIVAL
```

## 15.4 GPT Unavailable

Preferred Fallback:

```text
CEO → Fresh Claude Opus Acting CEO
Blind Reviewer → 별도 Fresh Claude Opus
Existing Claude Opus CTO → 계속 실행
```

세 Session은 모두 분리한다. Claude Capacity가 부족하면 New Work를 Pause하거나 Project Suspend를 제안한다.

## 15.5 Claude Unavailable

Preferred Fallback:

```text
Primary CTO → 필요한 Project별 Fresh GPT Sol Acting CTO
Blind Reviewer → 별도 Fresh GPT Sol xhigh
Hermes CEO → 기존 별도 GPT Session
```

## 15.6 GPT·Claude 모두 Unavailable

SURVIVAL 진입:

```text
State/Queue 보존
Deterministic Diagnostic
Optional Limited Triage
Production-Ready Completion 금지
Owner Escalation
```

Local LLM Fallback은 Backlog다.

## 15.7 Atomic Failover와 Message Fencing

모든 Message Envelope:

```text
roleKey
bindingGeneration
targetSessionId
runId
messageId
payloadDigest
expiresAt
```

Failover Transaction:

```text
New Session READY
→ One DB Transaction으로 New Generation ACTIVE
→ Logical Endpoint Route Switch
→ Old Binding REVOKED
→ Pending Outbox Retarget 또는 Reject
```

Revoked Generation의 ACK/Result는 Audit-only다.

## 15.8 Restoration

Provider 복구가 In-flight Run Owner를 빼앗으면 안 된다.

- 진행 중 Fallback Review는 기존 Reviewer가 완료
- 신규 Review부터 Preferred Provider
- Acting CTO는 Active Run 0 이후 Normal Drain/Handoff
- CEO는 현재 Decision 종료와 Continuity Summary 후 복귀

## 15.9 DIRECT Context Continuity

Managed Work는 DB/Git Evidence로 강하게 복구한다. DIRECT 개인비서 대화 Context는 Best-effort다. Failover를 위해 Raw Full Transcript를 저장하지 않는다.

---

# 16. Candidate Snapshot

## 16.1 Contract

```json
{
  "schema": "agent-control-plane.candidate-snapshot.v1",
  "runId": "...",
  "contractDigest": "sha256:...",
  "repositories": [
    {
      "identity": "github:owner/repo",
      "repositoryRole": "primary",
      "baseBranch": "dev",
      "baseHead": "...",
      "candidateHead": "...",
      "treeDigest": "sha256:...",
      "diffDigest": "sha256:...",
      "worktreeId": "...",
      "manifestDigest": "sha256:...",
      "touchedPaths": []
    }
  ],
  "createdAt": "..."
}
```

## 16.2 Freeze

모든 Repository Entry를 Freeze한 뒤 Verification을 시작한다. 하나의 Head·Tree·Manifest라도 바뀌면 전체 Snapshot과 Evidence가 Stale이다.

## 16.3 Unregistered Repository

미등록 Local Git Repo도 Run에서 자유롭게 건드릴 수 있다. Control Plane은 그 Run에 한해 Temporary Repository Identity와 Local Binding을 기록하며 자동으로 Active Project로 등록하지 않는다.

---

# 17. Verification Engine

## 17.1 Verification Profile

```text
simple
standard
guarded
```

`run.executionMode`와 대응하지만 실제 Command는 Project-specific이다.

## 17.2 Command Schema

```json
{
  "id": "test",
  "argv": ["npm", "test"],
  "repositoryRole": "primary",
  "cwd": ".",
  "timeoutSeconds": 1200,
  "envAllowlist": ["CI"],
  "network": "deny",
  "required": true,
  "evidenceMode": "BOTH_REQUIRED"
}
```

기본 Shell Interpolation 금지.

## 17.3 Evidence Mode

```text
LOCAL_COMMAND
TRUSTED_CI
BOTH_REQUIRED
```

CI Result는 Exact Candidate Head와 Approved Workflow/Config Digest가 일치할 때만 유효하다.

## 17.4 Sandbox

Candidate Command마다:

```text
Disposable Worktree
Sanitized Environment
Provider/GitHub/Buzz/Telegram Authority Secret 없음
Restricted Writable Root
Process Group + Timeout + Child Cleanup
CPU/Memory/Output Limit
Network Policy
```

v1은 Owner-trusted Repository만 지원하지만 Secret Stripping과 Worktree Isolation은 생략하지 않는다.

## 17.5 Unregistered Repository Verification

Active Project Manifest가 없는 Repo는 CTO가 Package Manifest·Makefile·README·CI를 조사해 Run-scoped `VerificationCommand`를 제안할 수 있다.

Control Plane은 동일 argv/Sandbox Contract로 검증하고 해당 Run에서만 실행한다. Project Registration 또는 `CONTRACT_CHANGE` Run 없이 Default Contract로 영구 저장하지 않는다.

방어 가능한 검증 방법을 찾지 못하면 `VERIFICATION_GAP`를 명시하며 완료로 숨기지 않는다.

## 17.6 Result Contract

```text
runId
candidateSnapshotDigest
commandId
repository identity
source = local | ci
exact head
startedAt / endedAt
exit code
bounded output digest
status
```

## 17.7 Completeness Gate

Expected Required Input을 Count한다. Missing Command·Missing Repo·Null Result·Stale CI·Incomplete Output은 성공을 막는다.

---

# 18. Mandatory Independent Blind Review

## 18.1 모든 Mode 필수

SIMPLE·STANDARD·GUARDED 전부 CTO가 Hermes에게 완료 보고하기 전에 Blind Review를 통과해야 한다.

Preferred Reviewer:

```text
GPT-5.6 Sol xhigh
```

## 18.2 자동 호출

Deterministic Verification PASS 후 Control Plane이 자동 호출한다. CTO/Hermes가 수동으로 호출하지 않는다.

## 18.3 Reviewer Input

전달:

```text
Task Contract / Acceptance
Candidate Snapshot Manifest
Actual Diff / Artifact
Verification Evidence
필요한 Project Context
```

금지:

```text
Worker/CTO Reasoning
Chat History
Self-assessment
Previous Verdict Anchoring
```

## 18.4 Complete Review Packet

```text
runId
candidateSnapshotDigest
contractDigest
reviewerRoleBindingGeneration
reviewerSessionId
reviewerSessionIncarnation
provider/model/effort
inputManifest
coveredRepositories
coveredFiles
omittedItems
verdict
findings
createdAt
```

PASS에서 `omittedItems=0` 필수.

## 18.5 Large Change

한 Context에 들어가지 않으면:

```text
File/Chunk Blind Reviewers
→ Coverage Reducer: 모든 File ≥1 검토 확인
→ Finding Dedupe
→ Final Fresh Reviewer
```

File/Repository 누락을 조용히 허용하지 않는다.

## 18.6 Verdict / Revision Loop

```text
PASS
REVISE
BLOCK
```

REVISE는 원래 CTO에게 자동 반환한다. Verification과 Fresh Blind Review를 다시 실행한다. 일반 Revision Loop는 Hermes에게 보고하지 않는다.

다음만 Escalation:

```text
반복/소진 실패
Scope Conflict
Policy Exception
제품 결정
```

## 18.7 Degraded Assurance

Fallback에서 Producer와 동일 Provider Family를 사용할 수는 있으나 Session/Context Independence는 필수다. GUARDED는 추가 Challenger를 요구할 수 있다.

유효한 Isolation/Coverage가 불가능하면 Gate를 낮추지 말고 Wait 또는 SURVIVAL로 간다.

---

# 19. CEO 최종 운영

## 19.1 Production-Ready Packet

Hermes가 기본적으로 받는 것:

```text
Project / Run / Goal
Result Summary
Candidate Snapshot Digest
Verification Summary
Blind Review PASS / Digest
Known Residual Risk
Changed Repositories
CTO Recommendation
Human Gate Status
```

필요할 때 Evidence로 Drill-down한다.

## 19.2 Final Decision

```text
CONFIRM
FINAL_REVISE
OWNER_DECISION_REQUIRED
```

Confirm은 Exact Candidate Snapshot에 묶인다. Candidate가 바뀌면 무효다.

## 19.3 Automatic Notification

Hermes 자동 알림은 세 가지뿐이다.

```text
READY_FOR_CEO_REVIEW
True Escalation
Critical System Failure
```

---

# 20. CTO↔CEO Escalation

CTO가 막히거나 기술 실행 권한 밖의 중요한 결정이 필요하면 즉시 Buzz에서 Escalation한다.

```text
question
options
CTO recommendation
why it matters
blocksCriticalPath
runId
```

Non-blocking이면 Run은 ACTIVE를 유지하고 다른 작업을 진행한다. Critical Path가 막히면 `BLOCKED / CEO_DECISION_REQUIRED`다.

Hermes가 대부분 종결한다. 좁은 Owner Decision만 `AWAITING_HUMAN`으로 보낸다.

---

# 21. Human Gate

Owner 승인 필수:

```text
비가역 Production Action
파괴적 Data Migration/Delete
Security/Permission Boundary 확대
Public API/Protocol Breaking Change
제품 핵심 방향 변경
큰 신규 비용·Paid Plan 변경
Project 폐기
Capacity 기반 Project Suspend
Quality Gate Reduction Exception
사전 위임되지 않은 Public/Release
```

“Agent가 잘 모르겠다”는 Human Gate 사유가 아니다. Hermes 권한 내에서 판단 가능하면 Hermes가 닫는다.

---

# 22. Run Priority

```text
CRITICAL
NORMAL
LOW
```

Hermes가 지정하고 CTO가 실제 Preemption·Parallel Order를 결정한다. CRITICAL 간 제품/사업 Priority 충돌만 Hermes에게 Escalation한다.

---

# 23. Global Conflict와 Resource Claim

## 23.1 CTO 책임

Semantic Dependency·Integration Sequence·Worktree Strategy는 CTO가 책임진다.

## 23.2 Control Plane 책임

최소 Global Resource Claim Registry:

```text
repository identity
branch
worktree
optional declared write paths
owner run/session generation
lease/expiry
```

Hard Reject:

```text
Same Worktree Simultaneous Writer
Same Branch Simultaneous Writer
Revoked Owner Generation
Exact Declared Path Overlap
```

Semantic Conflict는 CTO 판단으로 남긴다.

## 23.3 Claim의 성격

Permanent Scheduler/Project Ownership이 아니라 짧은 Coordination Evidence다. 모든 CTO는 안전할 때 모든 Repo를 자유롭게 조사·작업할 수 있다.

---

# 24. GitHub Integration Kernel

Repo-local Merge Broker를 제거한 뒤 남는 권위를 중앙 Trusted Layer로 흡수하는 P0 Module이다.

## 24.1 Trusted Credential Boundary

- Project Repo 밖 Local Secret Store
- `agentcpd` Process만 접근
- Verification/Repo Factory/Agent Session에 노출 금지
- Owner Manual GitHub Access는 허용하되 Out-of-band Audit
- 모든 Agent/Automation Merge는 이 Kernel 사용

## 24.2 Operation

```text
pr_prepare
gate_publish
merge_evaluate
merge_execute
post_merge_verify
release_tag
rollback_prepare
issue_project
```

## 24.3 PR Prepare

검증:

```text
Run Identity
Resource Claim
Source/Base/Target Branch Contract
Candidate Snapshot
Project Contract가 요구하는 PR Linkage
Current Owner Generation
```

## 24.4 Production Gate

`acp-production-gate`는 Trusted Credential만 만든다.

Payload Binding:

```text
runId
candidateSnapshotDigest
contractDigest
verificationDigest
blindReviewDigest
humanGateDigest
bindingGeneration
exact head
timestamp
```

Check Name만 믿지 않고 Creator Identity와 Payload Provenance를 검증한다.

## 24.5 Merge Evaluate

필수 Predicate:

```text
Exact Head
Expected Current Base/Target
Active Contract Digest
Valid Resource Claim
Current Required Verification
Blind Review PASS
Human Gate Satisfied
Branch Profile Satisfied
Current Role Generation
Idempotency
```

## 24.6 Merge Execute

Programmatic Merge의 유일한 Writer다. Branch Protection/Ruleset을 우회하지 않는다. Stale Head/Base를 거부하고 Idempotent Receipt를 남긴다.

모든 Target 포함:

```text
feature/**
release/**
hotfix/**
dev
main
```

## 24.7 Post-merge Verification

Merge API Success는 완료가 아니다. Exact Merge Commit의 Configured Post-merge Check를 검증한다.

실패 시:

```text
Dependent Merge 진행 차단
Controlled Repair/Rollback Path
```

## 24.8 Release Tag

Tag 조건:

```text
Configured Semver Match
Exact Accepted main Merge Commit
Duplicate Target Conflict 없음
Push 후 Reread
```

## 24.9 Hotfix Propagation

`main`, `dev`, 모든 Active `release/*`에 Fix 존재를 검증한다.

## 24.10 Multi-repo Merge

Merge Order·Dependency를 명시한다. Partial Merge를 기록하며 가짜 Atomicity를 주장하지 않는다.

Compensation:

```text
Rollback
Forward Fix
Halt
```

---

# 25. Doctor와 Lightweight Watchdog

## 25.1 Doctor Scope

```text
Primary CTO / Session / Binding
Buzz Connectivity
Run / Queue / Blocker
Worker / Subagent Resource
Worktree
Git / Repo State
CPU / RAM / Swap
Provider Capacity Bucket
Continuity / Role Coverage
Trusted GitHub Gate Health
```

## 25.2 최소 Runtime Resource Receipt

Node별 Live Status API나 Chat Progress Reporting은 필수가 아니다. Runtime Adapter가 기계 Receipt를 자동 생성한다.

```text
task_execution_started
- runId/taskId
- owner binding generation
- worker session/process id
- provider/model
- repo/worktree
- startedAt

task_execution_finished
- status
- resultDigest
- endedAt
```

Long Job은 낮은 빈도의 Observed Activity Lease를 기록할 수 있다.

## 25.3 Watchdog

Cheap Timer가 Overdue Run·Task·Session·Claim만 확인한다. Full Doctor를 상시 실행하지 않는다. 이상 발견 시 Scoped Doctor를 Trigger한다.

## 25.4 Finding Contract

```text
code
severity = INFO | WARN | ERROR | CRITICAL
scope
blocking
confidence
observedEvidence
recommendedAction
```

## 25.5 Deterministic Aggregation

```text
CRITICAL Blocking Finding → ERROR
ERROR Blocking Finding    → BLOCKED
WARN/ERROR Nonblocking    → DEGRADED
그 외                     → HEALTHY
```

## 25.6 Invocation

```text
“A CTO 닥터 돌려봐”
“전체 시스템 닥터 돌려봐”
```

Automatic Trigger:

```text
CTO Create/Replace
Repeated Dispatch Failure
Continuity Transition
Provider Probe Failure
Watchdog Stall
Buzz Reconnect Failure
```

## 25.7 Repair

Doctor는 Read-only다. Repair는 별도 Operation Contract다.

```text
operation allowlist
risk
preconditions
dry-run
expected effect
undo/compensation
authorization = HERMES | OWNER
receipt
```

Low-risk Cleanup은 Hermes가 승인할 수 있다. Data Loss Risk는 Owner 승인 필수.

---

# 26. Repo Factory Integration

## 26.1 Entry

실제 프로젝트 생성은 `PROJECT_BOOTSTRAP` Run이다.

## 26.2 Bootstrap Role

Control Plane은 기술 타당성·Lean Review를 위해 `BOOTSTRAP_CTO(run)`에 Claude Opus Session을 Binding한다.

Session이 건강하고 Blind Reviewer로 사용되지 않았으며 Activation Policy가 허용하면 Primary CTO로 승격할 수 있다. 아니면 Fresh Primary CTO를 만든다.

## 26.3 Result 분리

```text
RepoFactoryResult
→ Repo/File/GitHub/CI/Manifest/Receipt

ACPBootstrapActivationResult
→ Registration/Local Binding/Blind Review/CEO Confirm/Primary CTO/Buzz/Handoff/Doctor
```

Activation Result만 Run을 완료할 수 있다.

## 26.4 Project Manifest

Committed Manifest는 Portable, Local Path는 Repository Registry에 둔다. Active Digest를 Pin하고 Contract Change는 Dedicated Run으로 처리한다.

## 26.5 Handoff

Structured Handoff를 Persist하고 ACK를 받아야 Activation 완료다.

---

# 27. Buzz·Telegram·MCP Authentication

## 27.1 User Ingress

Buzz·Telegram은 Stable Hermes Logical Endpoint를 호출한다.

Telegram 필수:

```text
Allowed Owner User ID
Allowed Chat ID
Bot/Update Authenticity
Message Nonce / Idempotency
```

## 27.2 Buzz Identity

Buzz Actor/Session ID를 Active Role Binding에 Mapping한다. Display Name만으로 권한을 주지 않는다.

CTO↔CEO Discussion은 Owner에게 보인다.

## 27.3 MCP

Restricted Unix Socket 또는 동등 Local Transport·Filesystem Permission·Application Token/Peer Check를 사용한다. 모든 Mutation은 Run ID와 Message Idempotency Key를 가진다.

## 27.4 Untrusted Content

Forwarded Message·Crawled Webpage·Repo Document·Tool Output은 Data이지 Command가 아니다. Role·Scope·Credential·Human Gate Policy를 바꿀 수 없다.

## 27.5 Outbox

Outbox Message는 §15.7 Fenced Envelope를 사용한다. Binding 변경 시 아직 유효한 Message만 Deterministic Retarget하고 나머지는 Stale Reject한다.

---

# 28. Runtime Interface

## 28.1 Hermes MCP

```text
run_create
run_get
run_cancel
run_priority_set
project_get
cto_start
cto_replace
cto_suspend
cto_resume
doctor_run
continuity_status
owner_decision_submit
```

## 28.2 CTO MCP

```text
run_ack
contract_get
plan_submit
resource_claim
resource_release
task_receipt_submit
result_submit
escalation_open
handoff_submit
handoff_ack
capacity_get
doctor_run
```

CTO는 Mandatory Blind Review나 Production Gate를 수동 호출·게시하지 않는다.

## 28.3 GitHub Kernel Interface

```text
pr_prepare
gate_publish
merge_evaluate
merge_execute
post_merge_verify
release_tag
rollback_prepare
issue_project
```

## 28.4 CLI

```text
agentctl doctor
agentctl run show
agentctl run cancel
agentctl continuity status
agentctl outbox retry
agentctl owner approve
agentctl repair dry-run|execute
```

## 28.5 v1 Interface 범위

v1.3 External Interface는 다음으로 제한한다.

```text
MCP
Buzz Adapter
Telegram Ingress
Minimal CLI
```

REST·GraphQL·Web UI·Public SDK는 Backlog다.

---

# 29. State Machine

## 29.1 Run State

```text
QUEUED
ACTIVE
BLOCKED
READY_FOR_CEO_REVIEW
CEO_APPROVED
MERGING
POST_MERGE_VERIFYING
BLOCKED_POST_MERGE
REVISION_REQUIRED
AWAITING_HUMAN
COMPLETED
FAILED
CANCELLED
```

## 29.2 Transition

```text
QUEUED → ACTIVE
ACTIVE → BLOCKED | READY_FOR_CEO_REVIEW | FAILED | CANCELLED | AWAITING_HUMAN
BLOCKED → ACTIVE | FAILED | CANCELLED | AWAITING_HUMAN
READY_FOR_CEO_REVIEW → CEO_APPROVED | REVISION_REQUIRED | AWAITING_HUMAN
CEO_APPROVED → MERGING
MERGING → POST_MERGE_VERIFYING | BLOCKED_POST_MERGE
POST_MERGE_VERIFYING → MERGING | COMPLETED | BLOCKED_POST_MERGE
REVISION_REQUIRED → ACTIVE | FAILED | CANCELLED
AWAITING_HUMAN → ACTIVE | CANCELLED | FAILED
```

`PROJECT_BOOTSTRAP` has no repository merge to finalize. Its CEO-confirmed activation result
may take `READY_FOR_CEO_REVIEW → COMPLETED` only through the bootstrap-activation completion
capability; ordinary work must take the ordered daemon finalization path above.

## 29.3 Event로만 기록

```text
DISPATCHED
PLAN_REJECTED
CEO_REVIEWING
PARTIAL_FAILURE
CTO_ESCALATION
CEO_DECISION
RECOVERY_TAKEOVER
CONTINUITY_ACTIVATED
```

## 29.4 Session State

```text
STARTING
READY
DRAINING
STOPPED
ERROR
```

## 29.5 Continuity State

```text
NORMAL
DEGRADED
SURVIVAL
```

---

# 30. Persistence Model

Table 수 자체는 품질 목표가 아니다. 독립 Lifecycle·Integrity·Query가 있을 때만 Table을 분리한다.

## 30.1 Table

```text
projects
repositories
sessions
assignments
runs
run_artifacts
task_executions
capacity_snapshots
resource_claims
outbox
audit_events
```

`run_artifacts`는 Typed Immutable Artifact를 저장한다.

```text
Task Contract
Plan
Candidate Snapshot
Verification
Blind Review
Production-Ready Packet
Approval
Handoff
Continuity Summary
```

## 30.2 최소 Constraint

```text
Project당 Active PRIMARY_CTO Binding Unique
Active roleKey Binding Unique
Session Incarnation Immutable
roleKey별 bindingGeneration Monotonic
Outbox Idempotency Key Unique
Run Owner = sessionId + bindingGeneration
Verification/Review Artifact에 candidateSnapshotDigest 필수
Capacity Snapshot = provider + bucket + observedAt Unique
Same Branch/Worktree/Exact Path Writer Conflict 금지
Active Manifest Digest는 Immutable Artifact Reference
```

## 30.3 Transaction 필수 구간

```text
Binding Failover
Run Owner Takeover
Production Gate Publish Record
Merge Receipt
Resource Claim Acquire/Release
State Transition + Outbox Enqueue
```

## 30.4 제외

```text
Event Sourcing
Audit Hash Chain
Generic Policy DSL
Distributed Consensus
Cloud DB
```

---

# 31. B-lite Decision-grade Telemetry

## 31.1 목적

Chain-of-thought·모든 Tool Call을 저장하지 않고 미래 Routing·Graph 최적화에 필요한 Evidence만 모은다.

## 31.2 Controlled Vocabulary

```text
taskCategory
- mechanical
- implementation
- investigation
- integration
- test
- review
- docs
- migration
- benchmark
- security

failureClass
- transient
- repairable
- contract
- security
- policy
- capacity
- infrastructure
- unknown_observed

reviewFindingCategory
- correctness
- regression
- security
- scope
- performance
- maintainability
- evidence
- freshness
- source
```

## 31.3 저장 범위

Run:

```text
mode
priority
duration
revision count
outcome
```

Task/Worker:

```text
category
provider/model
attempt
duration
status
failure class
start 시 concurrency width
```

Quality:

```text
verification outcome
blind verdict
finding category
CEO outcome
```

Capacity:

```text
quota bucket
reset
burn trend
sensor/runtime/admission state
```

Graph:

```text
task count
dependency count
max observed fan-out
serialization/conflict event
```

Continuity:

```text
coverage plan
fallback role
mode transition
restore
```

## 31.4 Collection Boundary

Per-second Heartbeat는 필요 없다. Start/Finish Resource Receipt와 Long Job의 Low-frequency Activity면 충분하다.

Missing Telemetry는 Missing으로 남기며 Success로 Impute하지 않는다.

## 31.5 Retention / Redaction

- Raw Bounded Log: 짧은 Retention
- Normalized Metric: 긴 Retention
- Secret·Private Payload Redaction
- Full Prompt·Transcript·Chain-of-thought 저장 금지

---

# 32. Level 6 경계

v1.3은 Evidence를 수집하고 Recommendation을 제공하지만 Routing Policy·Gate를 자동 수정하지 않는다.

Backlog:

```text
Routing Recommendation
Shadow Policy Evaluation
Canary Change
Automatic Promotion/Rollback
Local LLM Emergency Fallback
```

충분한 Dogfood Evidence 전에는 활성화하지 않는다.

---

# 33. Security Boundary

## 33.1 Local Daemon

`agentcpd`는 Single Local Service이며 Process Supervisor 아래에서 실행한다. macOS Reference는 `launchd` 또는 동등 Supervisor다.

필수:

```text
Single-instance Lock
Least-privilege Filesystem Permission
Crash-loop Backoff
Health Endpoint
Structured Restart Recovery
```

## 33.2 Repository Access

모든 CTO는 Owner의 모든 Repo에 접근할 수 있다. 이는 Engineering Capability이며 Project 행정권한과 다르다. Resource Claim과 Run Authority는 유지한다.

## 33.3 Secret 분리

```text
GitHub Authority
Provider Session
Buzz/Telegram Connector
Verification Subprocess
```

Verification Subprocess에는 앞의 세 Secret을 주입하지 않는다.

## 33.4 Prompt Injection

외부 Content는 Role/System Instruction·Write Authorization·Verification 약화·Secret 공개·Owner Identity를 바꿀 수 없다.

## 33.5 Owner Out-of-band Write

Owner의 Manual GitHub 변경은 허용하지만 감지한다. Stale Candidate를 무효화하고 Doctor Warning 또는 Contract Reconciliation을 요구할 수 있다.

---

# 34. Failure and Recovery

## 34.1 Dispatch Failure

Failure Class와 Idempotency가 허용할 때만 Retry한다. Outbox Idempotency와 Binding Generation으로 Duplicate Dispatch를 막는다.

## 34.2 Verification Failure

CTO Revision으로 돌아간다. Evidence는 실패 Candidate Snapshot에 그대로 묶인다.

## 34.3 Incomplete Result

Expected Task/Result Count가 다르면 Synthesis와 Completion을 차단한다.

## 34.4 Stale Result

Old Generation 또는 Changed Candidate Result는 Audit-only다.

## 34.5 Process Restart

```text
Single-instance Lock 획득
Active Binding/Run/Outbox/Claim Load
Session/Process Reconcile
Stale Claim Inspect/Expire
Scoped Doctor
Idempotent Dispatch Resume
```

## 34.6 Backup

SQLite Safe Journaling·Periodic Local Backup. Provider Secret·Raw Full Transcript는 Backup에 넣지 않는다.

---

# 35. Policy Model

## 35.1 Hard Invariant

Typed Code와 DB Constraint로 구현한다. Generic DSL로 만들지 않는다.

## 35.2 Soft Decision

CTO 소유:

```text
Worker Model/Provider
Fan-out
Task Graph
Semantic Conflict
Implementation Detail
```

Hermes 소유:

```text
Execution Mode
Product Specification
Priority
CEO Authority 내 Exception
```

## 35.3 Generic Policy Language 없음

Project 차이는 Small Typed Config로 처리한다. 실제 정책 복잡성이 증명되기 전에는 Rule Engine을 만들지 않는다.

---

# 36. Control Plane Repository CI

필수:

```text
Typecheck / Static Analysis
Unit Test
SQLite Migration / Constraint Test
State-machine Property Test
Security Test
Provider Probe Parser Fixture
GitHub Kernel Mock + Live Canary
Continuity Scenario Suite
Sandbox Escape Test
Repo Factory Integration Canary
```

Negative Test 필수:

```text
Stale Generation
Forged Gate
Replayed Message
Wrong Target Branch
Candidate Contract Weakening
Secret Exposure
```

---

# 37. 기능 요구사항

| ID | 요구사항 | Blocking |
|---|---|---:|
| CP-001 | Hermes가 DIRECT/MANAGED를 자율 분류하되 Tool-level Managed Write Guard가 강제한다. | P0 |
| CP-002 | Project·Repository·Session·Binding의 권위를 분리한다. | P0 |
| CP-003 | Project당 Active Primary CTO 최대 1개, Activity와 Availability를 분리한다. | P0 |
| CP-004 | CTO Create·Drain·Handoff·Replace·Suspend·Recovery를 지원한다. | P0 |
| CP-005 | Run Owner를 Dispatch 시 Pin하고 Binding Generation으로 Fence한다. | P0 |
| CP-006 | CTO 자율 아래 여러 Run/Task의 병렬 실행을 허용한다. | P0 |
| CP-007 | Global Resource Claim으로 명백한 Cross-CTO Conflict를 방지한다. | P0 |
| CP-008 | Provider Usage를 Multi-bucket으로 수집하고 Sensor/Runtime/Admission을 분리한다. | P0 |
| CP-009 | Failover 전 RoleCoveragePlan을 계산한다. | P0 |
| CP-010 | Failover와 Message Fencing을 Atomic하게 수행한다. | P0 |
| CP-011 | Candidate Snapshot이 모든 Touched Repository를 완전하게 표현한다. | P0 |
| CP-012 | Verification은 공통 argv Schema와 Isolated Sandbox를 사용한다. | P0 |
| CP-013 | 모든 Execution Mode에 Automatic Independent Blind Review가 필수다. | P0 |
| CP-014 | Blind Review Coverage와 Producer Session Independence를 증명한다. | P0 |
| CP-015 | `agentcpd`만 Trusted GitHub Gate·Programmatic Merge Credential을 소유한다. | P0 |
| CP-016 | GitHub Integration Kernel이 PR·Merge·Post-merge·Tag·Rollback·Issue Projection을 소유한다. | P0 |
| CP-017 | Doctor는 Runtime Receipt와 Watchdog Stall Evidence를 사용한다. | P0 |
| CP-018 | Buzz·Telegram·MCP는 Authentication·Replay 방어를 가진다. | P0 |
| CP-019 | RepoFactoryResult와 ACP Activation Result를 분리한다. | P0 |
| CP-020 | CEO는 Final Candidate·True Escalation·Critical Failure만 자동 보고받는다. | P0 |
| CP-021 | Telemetry는 Decision-grade·Redacted이며 Full Trace가 아니다. | P1 |
| CP-022 | Daemon은 Supervised·Single-instance·Restart Reconcile을 지원한다. | P1 |

---

# 38. Acceptance Traceability

| Requirement | Scenario | Evidence Source | Blocking |
|---|---|---|---:|
| CP-001 | CP-S01–CP-S03 | Managed Write Guard Decision + Run Record | P0 |
| CP-002 | CP-S04, CP-S05 | Manifest/Registry Authority Validation | P0 |
| CP-003 | CP-S06 | Unique Active Primary CTO Constraint | P0 |
| CP-004 | CP-S07–CP-S10 | Session Lifecycle + Handoff Records | P0 |
| CP-005 | CP-S11 | Owner Binding Fence + Recovery Receipt | P0 |
| CP-006 | CP-S12 | Parallel Run/Task Execution Evidence | P0 |
| CP-007 | CP-S13–CP-S15 | Resource Claim Decision Records | P0 |
| CP-008 | CP-S16–CP-S18 | Capacity Bucket Snapshots + Routing Record | P0 |
| CP-009 | CP-S19–CP-S22 | RoleCoveragePlan | P0 |
| CP-010 | CP-S23, CP-S24 | Binding Transaction + Stale Message Audit | P0 |
| CP-011 | CP-S25, CP-S26 | CandidateSnapshot Manifest | P0 |
| CP-012 | CP-S27–CP-S29 | Sandbox + Verification Result | P0 |
| CP-013 | CP-S30, CP-S33 | Automatic Blind Review Artifact | P0 |
| CP-014 | CP-S31, CP-S32, CP-S34 | Session Independence + Coverage Manifest | P0 |
| CP-015 | CP-S35 | Trusted Gate Creator/Payload Evidence | P0 |
| CP-016 | CP-S36–CP-S42 | PR/Merge/Post-merge/Tag Receipts | P0 |
| CP-017 | CP-S43–CP-S47 | Doctor Finding + Watchdog Trigger | P0 |
| CP-018 | CP-S48–CP-S51 | Ingress Auth/Replay/Injection Results | P0 |
| CP-019 | CP-S52 | Bootstrap Result Separation Validation | P0 |
| CP-020 | CP-S53–CP-S55 | CEO Notification/Escalation Audit | P0 |
| CP-021 | CP-S56, CP-S57 | Redacted B-lite Telemetry Records | P1 |
| CP-022 | CP-S58, CP-S59 | Supervisor + Restart Reconciliation Evidence | P1 |

---

# 39. 필수 Scenario Suite

## DIRECT / MANAGED

- **CP-S01:** Read-only Repo 분석은 DIRECT 유지.
- **CP-S02:** DIRECT Repo Mutation 시도 → Managed Run 부재로 거부.
- **CP-S03:** 실행 요청 후 Managed Promotion·Run 생성·Write 진행.

## Registry / CTO

- **CP-S04:** Absolute Path가 있는 Committed Manifest 거부.
- **CP-S05:** Local Checkout Path는 Repository Registry에만 존재.
- **CP-S06:** Project에 Active Primary CTO 2개 생성 거부.
- **CP-S07:** CTO 없는 Project Run → Fresh Opus 자동 Binding.
- **CP-S08:** Active Run 중 Replace Request → DRAINING, Switchover 대기.
- **CP-S09:** Replacement 중 New Run QUEUED.
- **CP-S10:** New CTO Handoff ACK 전 Old Binding 유지.
- **CP-S11:** Dead Owner Recovery Takeover·Late Result Reject.

## Graph / Conflict

- **CP-S12:** Independent Task를 여러 Provider로 Fan-out.
- **CP-S13:** Same Worktree Writer Conflict 거부.
- **CP-S14:** 다른 CTO의 Exact Path Claim Overlap 거부.
- **CP-S15:** Semantic Conflict는 Warning 후 CTO 판단.

## Capacity

- **CP-S16:** GPT/Claude Usage의 여러 Window를 Bucket으로 Normalization.
- **CP-S17:** Probe Failure → New Allocation Suspend, Existing Critical Runtime 별도 Probe.
- **CP-S18:** GPT Disposable Capacity Healthy → Mechanical Task에 Luna Max 선택.

## Continuity

- **CP-S19:** GPT Exhausted, Claude Full Coverage 가능 → DEGRADED/FULL_COVERAGE.
- **CP-S20:** GPT Exhausted, Claude 일부만 Coverage → Suspend Recommendation.
- **CP-S21:** Claude Exhausted → Distinct GPT Acting CTO/Reviewer/CEO.
- **CP-S22:** GPT+Claude 불가 → SURVIVAL, Production Completion 금지.
- **CP-S23:** Old Generation Late Message → State 불변.
- **CP-S24:** Provider 복구가 In-flight Owner/Reviewer를 즉시 교체하지 않음.

## Candidate / Verification

- **CP-S25:** 2-Repo Snapshot Freeze 후 1 Repo Head 변경 → 전체 Evidence Stale.
- **CP-S26:** Unregistered Repo Temporary Binding, Active Project 자동 등록 없음.
- **CP-S27:** Candidate Test가 Authority Secret 접근 실패.
- **CP-S28:** Timeout Child Process Group Kill.
- **CP-S29:** Old Head Trusted CI Result 거부.

## Blind Review

- **CP-S30:** SIMPLE도 Sol xhigh 자동 Review.
- **CP-S31:** 같은 Worker Session Reviewer Binding 거부.
- **CP-S32:** Large Diff에서 File 1개 Coverage 누락 → PASS 불가.
- **CP-S33:** REVISE는 CTO로만 돌아가고 CEO 알림 없음.
- **CP-S34:** Fallback Isolation 불가 → Wait/SURVIVAL, Gate 약화 없음.

## GitHub Kernel

- **CP-S35:** Candidate가 동일 Check Name 생성 → Trusted Creator/Payload 불일치로 거부.
- **CP-S36:** Branch Contract 위반 Target → PR Prepare 거부.
- **CP-S37:** Feature/Release Target에 Gate 없는 Merge 거부.
- **CP-S38:** Stale Base/Head Merge 거부.
- **CP-S39:** Valid Exact-head Merge 1회, Replay Receipt 반환.
- **CP-S40:** Post-merge Failure → Dependent 차단·Rollback/Repair.
- **CP-S41:** Wrong Commit/Duplicate Release Tag 거부.
- **CP-S42:** Active Release에 Hotfix 누락 → Propagation Incomplete.

## Doctor / Watchdog

- **CP-S43:** Receipt/Runtime Mismatch로 Dead Worker 감지.
- **CP-S44:** Orphan Worktree 감지, 자동 삭제 없음.
- **CP-S45:** CPU/RAM Pressure → Deterministic DEGRADED.
- **CP-S46:** Deadline 이후 Event 없음 → Watchdog Scoped Doctor.
- **CP-S47:** Repair는 Explicit Contract·Authorization 필요.

## Ingress

- **CP-S48:** Non-allowlisted Telegram User 거부.
- **CP-S49:** Replayed Buzz/MCP Message Idempotent Ignore.
- **CP-S50:** Old Binding Generation Dispatch 거부.
- **CP-S51:** Crawled Prompt Injection이 Run/Write/Secret에 영향 없음.

## Bootstrap / CEO

- **CP-S52:** RepoFactoryResult만으로 Bootstrap Completion 불가.
- **CP-S53:** Routine Worker/Test/Review Churn은 CEO 자동 알림 없음.
- **CP-S54:** True CTO Escalation이 Buzz에 표시되고 Hermes가 종결.
- **CP-S55:** Owner Decision → AWAITING_HUMAN → 정상 Resume.

## Telemetry / Daemon

- **CP-S56:** Task Start/Finish Receipt로 Doctor/Telemetry 충족, Per-second Reporting 없음.
- **CP-S57:** Missing Telemetry는 Missing으로 표시.
- **CP-S58:** Daemon Crash/Restart 후 Duplicate Dispatch 없이 Reconcile.
- **CP-S59:** Crash Loop Backoff.

---

# 40. 비기능 요구사항

## Reliability

- State Transition + Outbox Enqueue Transactional
- Stale Generation/Snapshot Active State Mutation 금지
- 모든 Merge/Tag/Write Idempotent Receipt
- Bounded Absence of Progress를 Watchdog 감지
- Restart Reconciliation Deterministic

## Security

- Agent Session에 Trusted GitHub Authority Credential 없음
- Candidate Command는 Isolated Secret-stripped Worktree
- Ingress Authentication·Replay Resistance
- Candidate Contract Self-weakening 금지
- External Content는 Untrusted Data

## Maintainability

- Explicit Typed Code + Small Config, Policy DSL 없음
- Common Schema Versioning 정본 1개
- Runtime 책임을 Project Repo에 복제 금지
- Provider Adapter가 Collection Difference 은닉
- Table 수는 Lifecycle/Integrity로 정당화

## Performance

- Permanent Full-system Scan 없음
- Watchdog는 Overdue Resource만 검사
- Usage Probe Event-driven + Cache
- CTO가 Live Condition 기반 Fan-out 결정
- DIRECT는 Managed Execution이 아니면 Control Plane 우회

## Privacy

- Chain-of-thought·Full Prompt·Full Transcript 저장 금지
- Telemetry Secret/Private Payload Redaction
- Public Manifest에 Local Metadata 없음
- DIRECT Continuity를 위한 Transcript Hoarding 금지

## Explainability

모든 Denial·Transition은 Stable Reason Code와 핵심 Evidence를 반환한다.

---

# 41. 구현 Slice

## Slice 0 — Trusted Core

```text
SQLite Schema / Constraint
Run State Machine
Managed Write Guard
Candidate Snapshot
VerificationCommand
Outbox / Idempotency
```

## Slice 1 — One Safe Project Run

```text
Project/Repository Registry
Primary CTO Binding
Buzz Dispatch
Resource Receipt/Claim
Verification Sandbox
Mandatory Blind Review
Final CEO Packet
```

## Slice 2 — GitHub Integration Kernel

```text
Trusted Credential
PR Prepare
Gate Publish
Merge/Post-merge
Tag/Hotfix/Rollback
```

## Slice 3 — Dynamic Runtime

```text
CTO Create/Replace/Handoff/Suspend
Watchdog / Doctor
Session/Process Reconcile
```

## Slice 4 — Capacity / Continuity

```text
Provider Quota Bucket
RoleCoveragePlan
Atomic Failover / Message Fencing
Restore
```

## Slice 5 — Repo Factory Integration

```text
PROJECT_BOOTSTRAP
BOOTSTRAP_CTO
RepoFactoryResult Validation
Activation / Handoff / Doctor
```

## Slice 6 — Telemetry / Dogfood

```text
B-lite Metric
3-project Dogfood
Failure/Recovery Observation
Level 6 Recommendation Input
```

---

# 42. Definition of Done

Agent Control Plane v1.3 완료 조건:

1. CP-S01~CP-S59 전부 PASS
2. DB Constraint·Transactional Failover Test PASS
3. SIMPLE·STANDARD·GUARDED Real Run 각 1개 End-to-End 완료
4. Explicit Merge Order를 가진 Multi-repo Run 1개 완료
5. GPT-down·Claude-down Continuity에서 Role/Session Independence 위반 0
6. Repo Factory Bootstrap → Primary CTO Activation → Doctor 완료
7. Scenario Suite + 최소 3개 Dogfood Project + 30개 이상 Run/Bootstrap Lifecycle 관측 범위에서 False Completion 0, Duplicate Dispatch 0, Accepted Stale Generation Result 0, Forged Production Gate 0, Unauthorized Programmatic Merge 0
8. Zero Count의 관측 범위·기간 기록
9. Dogfood 기간 Routine Technical Revision으로 Owner Interrupt 0
10. 모든 P0 Requirement가 Scenario/Evidence에 연결

---

# 43. Backlog

```text
Local LLM Emergency Fallback
Automatic Level 6 Routing Promotion
Shadow/Canary Policy Change
Cloud/Multi-user Deployment
Untrusted Repo용 Strong VM/Container Isolation
Web Dashboard
Advanced Semantic Conflict Detection
REST / GraphQL / Public SDK
```

---

# 44. Production Review Closure Matrix

| Review Item | 반영 위치 |
|---|---|
| P0-01 | §4 CP-HI-01, §6 |
| P0-02/P0-03/P0-04 | §§9, 16, 26 |
| P0-05/P0-06/P0-07 | §24 |
| P0-08/P0-09 | §17 |
| P0-10 | §§11.4, 16, 24.10 |
| P0-11/P0-12 | §18 |
| P0-13/P0-14 | §25 |
| P0-15 | §23 |
| P0-16/P0-17 | §§14–15 |
| P0-18 | §15.7 |
| P0-19 | §27 |
| P0-20 | §26 |
| P0-21 | Repo Factory §§13.3, 16 |
| P1-02–P1-06 | §§9–10, 11.1, 29 |
| P1-07–P1-10 | §§6.4, 14–15 |
| P1-11 | §17.3 |
| P1-19/P1-20 | §§24.10, 26 |
| P1-21/P1-22 | §25 |
| P1-23/P1-24 | §§30, 33 |
| P1-25 | §31 |
| P1-26/P1-27 | §§38, 42 |

---

# 45. 최종 고정 원칙

```text
Hermes는 자유롭고, Managed Write는 자유롭지 않다.
Role은 안정적이고 Runtime은 교체 가능하다.
Authority는 Role과 Current Binding Generation을 따른다.
Project Activity는 Primary CTO 존재에서 파생하고 Availability는 별도다.
CTO는 Engineering Strategy를, Control Plane은 Authority와 Evidence를 소유한다.
Candidate는 자신을 판정하는 Contract/Gate를 제어할 수 없다.
모든 Mode는 Independent Blind Review를 받는다.
모든 Programmatic Merge는 Trusted GitHub Kernel을 통과한다.
Provider Exhaustion은 Valid RoleCoveragePlan 후에만 Role을 재배선한다.
Doctor는 진단하고 Repair는 명시적으로 실행한다.
Repo Factory는 만들고 Agent Control Plane은 운영한다.
Owner Interrupt는 예외다.
```
