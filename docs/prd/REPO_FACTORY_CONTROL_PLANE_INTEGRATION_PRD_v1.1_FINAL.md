# Repo Factory × Agent Control Plane 통합 PRD

- **버전:** 1.1 FINAL
- **상태:** 구현·원자 티켓 분해 승인
- **대체 문서:** `REPO_FACTORY_CONTROL_PLANE_INTEGRATION_PRD_v1.0.md`
- **동반 Runtime SSOT:** `AGENT_CONTROL_PLANE_PRD_v1.3_FINAL.md`
- **제품 책임:** Hermes / CEO Role
- **기술 책임:** Bootstrap CTO Role
- **최종 개정일:** 2026-08-12
- **구현 SSOT 문서 집합:** 이 문서 + `AGENT_CONTROL_PLANE_PRD_v1.3_FINAL.md` 두 개만 사용
- **비규범 문서:** 이전 PRD와 Production Review 문서는 결정 이력일 뿐 구현 입력으로 사용하지 않음

---

# 1. 한 문장 정의

> **Repo Factory는 승인된 프로젝트 씨앗을 검증 가능하고 이식 가능한 저장소 계약으로 컴파일한 뒤, 장기 실행 권한을 Agent Control Plane에 인계하는 Project Bootstrap Compiler다.**

Repo Factory의 책임은 프로젝트 창세까지다. 다음은 소유하지 않는다.

```text
장기 에이전트 세션
Provider/모델 라우팅
Official Run 실행
Blind Review Runtime
Merge 권한
Continuity
Doctor
창세 이후 스케줄링
```

전체 경계는 다음과 같다.

```text
Seed
→ 조사·명세
→ Lean 기술 검토
→ Canonical Bootstrap Plan
→ 로컬/GitHub/CI 생성
→ Bootstrap Verification
→ RepoFactoryResult
→ Agent Control Plane Activation
→ Primary CTO
```

`RepoFactoryResult`가 수용되면 Repo Factory는 종료한다. 이후 프로젝트 운영은 전부 Agent Control Plane이 소유한다.

---

# 2. 규범 언어와 문서 권위

이 문서의 **MUST / MUST NOT / SHOULD / MAY**는 규범적 요구사항이다.

## 2.1 권위 우선순위

1. `AGENT_CONTROL_PLANE_PRD_v1.3_FINAL.md`가 Runtime·보안·GitHub Write·Verification·Blind Review·Session·Continuity의 최종 권위다.
2. 이 문서는 Project Bootstrap과 생성 저장소 계약의 최종 권위다.
3. 생성 저장소는 프로젝트 고유 계약을 가질 수 있지만 Agent Control Plane의 Runtime 권위를 재정의할 수 없다.
4. Candidate는 자신을 판정하는 동일 Run의 계약을 약화할 수 없다.

## 2.2 공통 계약

다음 Schema는 두 시스템이 공유하며 구현 정본은 한 곳만 둔다.

```text
VerificationCommand
CandidateSnapshot
GitHubGateEvidence
ExternalWriteReceipt
ProjectManifest
RepoFactoryResult
ACPBootstrapActivationResult
```

Repo Factory는 의미가 다른 복제 Schema를 만들면 안 된다.

## 2.3 권위가 아닌 표면

다음은 Projection 또는 Evidence이지 Runtime 권위가 아니다.

```text
GitHub Issue 상태
Label·Milestone
README 주장
Agent 자기보고
Chat Transcript
Activation 이후 Repo Factory의 로컬 상태
```

---

# 3. 제품 목표

## 3.1 목표

Repo Factory는 반드시 다음을 만족해야 한다.

1. 자연어 프로젝트 씨앗을 불필요한 문서 강제 없이 구현 착수 가능한 저장소로 만든다.
2. Hermes / GPT-5.6 Sol이 제품·명세의 권위 있는 작성자가 된다.
3. Claude Opus Bootstrap CTO가 Apply 전에 과설계를 제거한다.
4. 절대경로·세션·채널·비밀이 없는 Portable Project Contract를 만든다.
5. Placeholder가 없는 실제 Stack-specific CI를 만든다.
6. `main`/`dev`와 승인된 우아한형제들 기반 변형 브랜치 전략을 만든다.
7. 모든 외부 쓰기를 사전 계획·귀속·멱등·사후 재조회 가능하게 만든다.
8. Agent Control Plane이 활성화할 수 있는 결정적 `RepoFactoryResult`를 만든다.
9. 하나의 Bootstrap Operation에서 한 개 이상의 저장소를 지원한다.
10. 필요한 증거 또는 실행 능력이 없으면 정직하게 실패한다.

## 3.2 비목표

Repo Factory는 다음을 해서는 안 된다.

- 영구 Scheduler/Daemon 운영
- Primary CTO Lifecycle 소유
- 장기 Worker Provider·동시성 선택
- Provider 사용량 모니터링
- `acp-production-gate` 게시
- Routine Merge 승인·실행
- Continuity Failover 구현
- Activation 이후 Doctor Monitoring
- Primary CTO와 별개의 Project ACTIVE 상태 생성
- 생성 저장소마다 전체 Runtime Kernel 복제
- 작은 프로젝트에 PRD·ADR·Ticket을 형식적으로 강제

---

# 4. 역할과 책임 경계

## 4.1 User / Owner

Owner는 목적과 최종 Owner-only 결정을 제공한다. 다음과 같은 좁은 Human Gate에서만 호출된다.

```text
비가역 외부 영향
큰 비용
Public 전환
파괴적 작업
제품 핵심 방향 변경
```

## 4.2 Hermes / CEO Role

Hermes는 다음을 소유한다.

- 프로젝트 의도 해석
- `bootstrapProfile` 선택
- 필요할 때 PRD·ADR·Ticket·Acceptance 작성
- Scope / Non-goal / Priority / Visibility 결정
- Owner 승인이 필요하지 않은 Bootstrap Plan 승인
- Agent Control Plane을 통한 최종 Production-Ready Confirm

Hermes는 강한 모델이라는 이유만으로 불필요한 구현 메커니즘을 추가하면 안 된다.

## 4.3 Bootstrap CTO Role

Bootstrap CTO는 Agent Control Plane이 `BOOTSTRAP_CTO(run)`에 동적으로 Binding한 Claude Opus Session이다.

반드시 다음을 수행한다.

- 기술 타당성 조사
- 잘못된 가정의 Buzz Challenge
- 불필요한 Service·Layer·State·Permission·추상화·문서·미래 대비 제거
- 가장 작은 Production-Ready Genesis로 축소
- Stack-specific CI와 Verification Command 정의
- 비가역/Owner 결정 식별
- Apply 전 기술 ACK

승인된 제품 목표나 Non-goal을 조용히 바꾸면 안 된다.

## 4.4 Repo Factory Engine

동일한 Canonical Plan과 Environment Snapshot에 대해 결정적으로 동작해야 한다.

소유 범위:

```text
Plan Compilation
File/Template Rendering
GitHub Write Plan 생성
Repository 생성·보수
Branch/Profile 생성
CI 생성
Portable Manifest 생성
Issue Projection
Bootstrap Verification Orchestration
External Write Receipt
```

Agent Session을 생성·제어하지 않는다.

## 4.5 Agent Control Plane

다음을 소유한다.

```text
PROJECT_BOOTSTRAP Official Run
BOOTSTRAP_CTO Binding
Verification Sandbox
Trusted GitHub Credential
Mandatory Blind Review
Final CEO Gate
Local Repository Binding
Primary CTO Activation
Buzz 연결
Handoff ACK
Doctor
Activation 이후 Runtime 권위
```

## 4.6 Project Repository

저장소에는 이식 가능한 프로젝트 산출물만 둔다.

```text
Source Code
Project Test
Portable Project Manifest
CI Workflow
필요한 PRD·ADR·Ticket
README·AGENTS
활성화된 경우 CommitLore 로컬 설정
```

다음은 저장소에 커밋하면 안 된다.

```text
Local Session ID
Provider Quota 상태
Telegram/Buzz Identity
절대 Checkout Path
Agent Control Plane Privileged Credential
```

---

# 5. 진입과 사용자 경험

## 5.1 진입 규칙

실제로 저장소를 생성하거나 실질적으로 복구·개편하는 요청은 `MANAGED`이며 반드시 `PROJECT_BOOTSTRAP` Run을 만든다.

아이디어 상담·이름 논의·조사·기획은 `DIRECT`로 시작할 수 있다. 사용자가 실제 생성·적용을 요청하는 순간 승격한다.

```text
DIRECT 논의
→ “실제로 만들어”
→ MANAGED_WRITE_GUARD
→ PROJECT_BOOTSTRAP Run
```

## 5.2 질문 최소화

Hermes는 되돌리기 쉬운 값을 추론하고, 정말 Owner 결정이 필요한 항목만 한 번에 묶어 질문해야 한다. 현재 대화·로컬 환경·GitHub·승인된 Default에서 이미 알 수 있는 내용은 다시 묻지 않는다.

## 5.3 사용자에게 보이는 진행

저수준 Agent 로그 대신 다음 정도만 보인다.

```text
Specification Ready
Lean Review Complete
Bootstrap Plan Authorized
Repositories Created
CI Verified
Blind Review Passed
Primary CTO Active
```

CTO↔CEO의 중요한 기술 논의는 Buzz에서 Owner에게 보인다.

---

# 6. Bootstrap Profile

일반 Run의 `run.executionMode`와 구분하기 위해 필드명을 `bootstrapProfile`로 고정한다.

## 6.1 SIMPLE

작고 되돌리기 쉬운 Prototype·CLI·실험·소규모 OSS에 사용한다.

필수:

```text
Portable Project Manifest
README
AGENTS
실제 Stack-specific CI
Verification Commands
main/dev Branch Contract
RepoFactoryResult
```

선택:

```text
PRD
ADR
Ticket/Issue
Research Dossier
CommitLore Blocking Requirement
```

형식적 개수 충족을 위해 문서를 만들면 안 된다.

## 6.2 STANDARD

일반적인 지속 관리 프로젝트에 사용한다.

필수:

```text
Compact PRD 또는 동등한 명세
필요한 구현 Ticket
중요한 결정만 ADR
실제 CI·Verification Profile
Branch Contract
Ticket이 있으면 Issue Projection
Deployment Default에 따른 CommitLore
```

## 6.3 GUARDED

Security/Auth·Protocol·Migration·Benchmark·민감 데이터·중요 OSS·연구 기반 시스템에 사용한다.

추가 요구 가능 항목:

```text
Adversarial Evidence Search
Reproduction Experiment
Architecture ADR
Acceptance Oracle
Rollback Strategy
Security Command
Measurement Preregistration
Provenance/Reproducibility Evidence
```

## 6.4 선택과 Challenge

Hermes가 `bootstrapProfile`을 선택한다. Bootstrap CTO는 과소·과대 분류를 Buzz에서 Challenge할 수 있고, 최종 명세 결정은 Hermes가 한다.

---

# 7. End-to-End Bootstrap Pipeline

## Phase A — Intake

Agent Control Plane은 다음 입력으로 `PROJECT_BOOTSTRAP` Run을 만든다.

```text
seed
bootstrapProfile
priority
requested repositories
visibility intent
human-gate facts
origin metadata
```

Run 생성 시 ownerBinding은 비어 있을 수 있다. 기술 실행 전에 `BOOTSTRAP_CTO` Session을 Binding하고 `bindingGeneration`을 고정한다.

## Phase B — Evidence

- SIMPLE: 명백한 중복·불가능성을 피하는 최소 조사
- STANDARD: Targeted 경쟁·선행·실패 조건 조사
- GUARDED: 위험에 맞는 전체 Evidence Lane

Evidence는 `확인`, `재현`, `반증`, `미확인`을 구분해야 한다.

## Phase C — CEO Specification

Hermes는 필요한 것만 만든다.

```text
Goal / Non-goal
Acceptance Criteria
제품 Scope가 필요하면 PRD
지속 결정이 있으면 ADR
실행 분해 가치가 있으면 Ticket
Owner-only Decision / Human Gate
```

## Phase D — De-overengineering Review

Bootstrap CTO는 다음 중 하나를 반환한다.

```text
LEAN_ACCEPT
LEAN_REVISE
CEO_DECISION_REQUIRED
OWNER_DECISION_REQUIRED
```

제거한 항목에는 간단한 이유를 남긴다. 제품 Scope를 바꾸지 않는 기술적 과설계는 CTO가 직접 제거할 수 있다. Scope 변경은 Hermes 결정이 필요하다.

## Phase E — Canonical Plan

Repo Factory는 `BootstrapPlanCore`와 별도의 `EnvironmentObservation`을 만든다.

외부 쓰기 전에 전체 Plan을 검토할 수 있어야 한다.

## Phase F — Authorization

Plan은 다음 필드를 가진다.

```text
authorization = HERMES | OWNER
```

Hermes는 사용자 요청에 이미 포함된 Private·Reversible·저비용 Setup을 승인할 수 있다. 다음은 Owner 승인이 필요하다.

```text
Public 노출
Paid Plan 변경
파괴적 대체
비가역 이름·Package Publish
기타 Human Gate
```

## Phase G — Apply

승인된 Operation만 수행하고 모든 Resource에 `ExternalWriteReceipt`를 남긴다.

## Phase H — Bootstrap Verification

Agent Control Plane의 Trusted Verification Engine이 승인된 Contract Digest로 실행한다. Candidate가 수정한 설정을 같은 Candidate 판정에 사용하지 않는다.

## Phase I — RepoFactoryResult

Repo Factory는 Repository/Bootstrap Fact만 반환한다. CTO 활성화나 Project 완료를 주장하지 않는다.

## Phase J — ACP Activation

Agent Control Plane이 다음을 수행한다.

1. `RepoFactoryResult` 검증
2. 승인된 Project Manifest Digest 활성화
3. Local Repository Binding 생성
4. Mandatory Blind Review
5. Hermes Final Confirm
6. Primary CTO Binding 또는 Bootstrap CTO 승격
7. Buzz 연결
8. Structured Handoff 저장
9. `HANDOFF_ACK`
10. Doctor
11. `ACPBootstrapActivationResult`

`PROJECT_BOOTSTRAP` Run 완료는 Agent Control Plane만 결정한다.

---

# 8. Canonical Plan·Observation·Digest

## 8.1 BootstrapPlanCore

결정적 Plan에는 의도와 Operation만 포함한다.

```json
{
  "schema": "repo-factory.bootstrap-plan.v2",
  "bootstrapOperationId": "uuid",
  "requestDigest": "sha256:...",
  "bootstrapProfile": "STANDARD",
  "authorization": "HERMES",
  "repositories": [],
  "files": [],
  "githubOperations": [],
  "branchContracts": [],
  "verificationContractDigest": "sha256:...",
  "projectManifestDigest": "sha256:..."
}
```

다음은 포함하지 않는다.

```text
Timestamp
Absolute Path
Session ID
Provider Usage
Transient API Result
```

## 8.2 EnvironmentObservation

변동 가능한 관측은 분리한다.

```text
Local Destination Availability
Remote Name Availability
Current GitHub Facts
Runtime/Tool Version
Current Account Capability
observedAt
```

필요하면 Plan은 `environmentSnapshotId`를 참조하지만 관측 Byte를 Canonical Intent Digest에 섞지 않는다.

## 8.3 Canonicalization

UTF-8·Object Key Sort·의미 있는 Array 순서·정규화된 Newline·Volatile Field 제거를 강제한다.

반드시 다음을 증명한다.

```text
같은 PlanCore → 같은 Digest
Operation/Contract 변경 → 다른 Digest
Timestamp만 변경 → PlanCore Digest 불변
```

---

# 9. 우아한형제들 기반 `main`/`dev` Branch Strategy

참조 글의 master/develop Git-flow를 `main`/`dev`로 바꾸고, Single Owner Agent Control Plane 환경에 맞게 명시적으로 변형한다.

## 9.1 장기 Branch

### `main`

- Production/Release History
- Release와 Hotfix Integration만 수용
- Release Tag는 승인된 `main` Merge Commit을 정확히 가리킴

### `dev`

- 기본 Integration Branch
- Feature/Release Branch의 Source
- 일반 기능 통합과 Release/Hotfix Back-propagation 수용

## 9.2 보조 Branch Machine Contract

| Pattern | 필수 Base | 허용 Target | 목적 |
|---|---|---|---|
| `feature/<feature-id>-<slug>` | `dev` | `dev` | 공유 Feature Integration |
| `task/<ticket-id>-<slug>` | 선언된 `feature/*`, `dev`, `release/*` | 선언된 Parent | 원자 구현 |
| `fix/<ticket-id>-<slug>` | `dev` 또는 Active `release/*` | 동일 계열 | 일반 결함 수정 |
| `release/<semver>` | `dev` | `main`과 `dev` | 안정화·Release |
| `hotfix/<ticket-id>-<slug>` | `main` | `main`, `dev`, 모든 Active `release/*` | 긴급 Production 수정 |

Parent Branch는 Branch Contract에 기록하며 Agent Control Plane GitHub Integration Kernel이 PR 생성·Merge 시 검증한다.

## 9.3 Update Strategy와 Merge Strategy

두 개념을 분리한다.

```text
updateStrategy = rebase_before_review
mergeStrategy  = merge_commit | fast_forward
```

Default:

- Private Task/Fix Branch는 Review 전에 선언 Target 최신 Head 위로 Rebase 가능
- 공유 `feature/*`, `release/*`, `hotfix/*`, `dev`, `main` History Rewrite 금지
- 공유·장기 Branch 통합은 승인된 Merge Strategy 사용, 기본 `merge_commit`
- Merge Method는 Project Manifest Contract이며 임의 추론 금지

## 9.4 Gate Coverage

Target Branch와 무관하게 모든 Programmatic PR Merge는 Agent Control Plane을 통과한다.

```text
feature/**
release/**
hotfix/**
dev
main
```

Native Ruleset은 Defense in Depth다. 일부 Repository Profile이 모든 Pattern을 물리적으로 강제하지 못하므로 최종 권위는 Trusted GitHub Integration Kernel이다.

## 9.5 Release 규칙

Release 완료 조건:

1. `release/<semver>`가 예상 `dev` Head에서 시작
2. 전체 Release Candidate Snapshot Verification·Blind Review PASS
3. Trusted Gate를 통해 `main` Merge
4. Release 변경이 `dev`에도 존재
5. Tag가 정확한 `main` Release Merge Commit을 가리킴
6. Duplicate Tag 거부
7. Push 후 GitHub API 재조회
8. Manifest 정책에 따른 Release Branch Cleanup

## 9.6 Hotfix 전파

Hotfix는 `main`, `dev`, 그리고 Fix를 포함하지 않은 모든 Active `release/*`에 전파해야 한다.

---

# 10. Portable Project Manifest

## 10.1 위치

```text
.agent-control-plane/project.json
```

## 10.2 불변식

Committed Manifest는 반드시:

- Machine Portable
- Absolute Path 없음
- Local User/Home 없음
- Session/Provider/Channel ID 없음
- Secret/Privileged Credential Reference 없음
- Repository-relative Path만 사용
- Canonical Digest 보유
- Versioned Project Contract로 취급

## 10.3 예시

```json
{
  "schema": "agent-control-plane.project.v2",
  "projectId": "example-project",
  "repositories": [
    {
      "role": "primary",
      "remote": "github:MongLong0214/example-project",
      "manifestRoot": "."
    }
  ],
  "branchProfile": {
    "longLived": ["main", "dev"],
    "defaultBranch": "dev",
    "updateStrategy": "rebase_before_review",
    "mergeStrategy": "merge_commit",
    "releaseTagPolicy": "semver"
  },
  "verificationProfiles": {
    "simple": ["typecheck"],
    "standard": ["typecheck", "test"],
    "guarded": ["typecheck", "test", "build", "security"]
  },
  "verificationCommands": [
    {
      "id": "test",
      "argv": ["npm", "test"],
      "repositoryRole": "primary",
      "cwd": ".",
      "timeoutSeconds": 1200,
      "envAllowlist": ["CI"],
      "network": "deny",
      "required": true
    }
  ],
  "commitlore": {
    "mode": "required"
  }
}
```

## 10.4 Contract Activation

Run Dispatch Admission 시 Active Manifest Digest를 Pin한다.

Candidate가 Manifest를 수정해도 현재 Run은 이전 Active Digest로 판정한다. 새 Manifest는 별도 `CONTRACT_CHANGE` Run에서 모든 Gate를 통과한 후 다음 Run부터 활성화한다.

---

# 11. Local Registry Binding

절대 Checkout Path는 Agent Control Plane Local Registry에만 둔다.

```text
Portable Contract SSOT = Approved Manifest Digest
Local Checkout Binding SSOT = ACP Repository Registry
Runtime State SSOT = ACP Database
```

Repo Factory는 Local Binding Proposal을 반환할 수 있지만 Repository에 커밋하지 않는다.

Local Binding 필드:

```text
Normalized Repository Identity
Absolute Checkout Path
Filesystem Trust Class
Observed Remote URL
Last Observed Head
Active Manifest Digest
Drift Status
```

---

# 12. 공통 Verification Command Contract

기본 Command 표현은 argv 방식 하나다.

```json
{
  "id": "build",
  "argv": ["npm", "run", "build"],
  "repositoryRole": "primary",
  "cwd": ".",
  "timeoutSeconds": 1200,
  "envAllowlist": ["CI", "NODE_ENV"],
  "network": "deny",
  "required": true,
  "evidenceMode": "LOCAL_COMMAND"
}
```

규칙:

- 기본 `sh -c`, Pipe, Redirect, Command Substitution, Shell Interpolation 금지
- Privileged Shell Profile은 별도 GUARDED Contract와 권한 필요
- `cwd`는 Repository-relative
- Network는 `deny | allowlist | allow`
- Output·Resource Limit 필수
- Evidence Mode는 `LOCAL_COMMAND | TRUSTED_CI | BOTH_REQUIRED`
- 다른 Head의 CI Result는 Stale

---

# 13. Bootstrap Contracts

## 13.1 BootstrapRequest

```text
runId
seed
bootstrapProfile
priority
repository intents
visibility intent
Owner constraints
origin
```

## 13.2 BootstrapPlanCore

§8의 승인된 정확한 의도다.

## 13.3 ExternalWriteReceipt

모든 외부 Resource Write는 다음을 남긴다.

```text
bootstrapOperationId
requestDigest
operationId
resourceType
resourceIdentity
preexisting
beforeStateDigest
afterStateDigest
createdAt
rereadAt
verified
```

이름은 같지만 Provenance가 다른 Resource는 Resume가 아니라 `RESOURCE_COLLISION`이다.

## 13.4 RepoFactoryResult

```json
{
  "schema": "repo-factory.result.v2",
  "runId": "...",
  "bootstrapOperationId": "...",
  "planDigest": "sha256:...",
  "projectManifestDigest": "sha256:...",
  "repositories": [],
  "externalWriteReceipts": [],
  "bootstrapVerification": [],
  "ciEvidence": [],
  "unresolvedGaps": []
}
```

다음은 포함하거나 주장하면 안 된다.

```text
Primary CTO Assignment
Buzz Connection
Doctor PASS
Blind Review PASS
CEO Final Confirm
Project ACTIVE
```

## 13.5 ACPBootstrapActivationResult

Agent Control Plane이 생성한다.

```text
Project Registration
Local Binding
Blind Review
CEO Confirm
Primary CTO Binding
Buzz
Handoff ACK
Doctor
Activity/Availability
```

## 13.6 BootstrapHandoffSeed

Repo Factory는 이식 가능한 Seed를 제공할 수 있다.

```text
Project Goal
Active Manifest Digest
Created Repositories/Branches
중요 ADR·PRD·Ticket 위치
Verification Commands
Known Limitations
Recommended First Runs
```

Session-specific State는 포함하지 않는다.

---

# 14. CI와 Trusted Gate

## 14.1 Stack-specific Generation

승인된 Stack에 맞는 실제 Setup·Install·Test·Build를 생성해야 한다.

Apply된 Repository에 다음이 남아 있으면 실패다.

```text
Runtime Setup 대신 Placeholder Echo
Unresolved Template Token
Runner 기본 Runtime 암묵 의존
Dependency Install 누락
승인된 Full SHA가 아닌 Action Tag
```

v1.1 기본 Template은 Node·Python·Go·Rust를 포함해야 한다. Unknown Stack은 Reviewed Custom Template을 요구하며 Node Default로 조용히 대체하지 않는다.

## 14.2 Candidate-independent Authority

Candidate는 Project Test를 포함할 수 있지만 자신을 판정하는 Trusted Decision Code 또는 Active Verification Contract를 제어할 수 없다.

- CI Workflow·Manifest 변경은 Contract Change
- Agent Control Plane이 승인된 Workflow/Config Digest Pin
- Candidate Gate Logic 변경은 이전 Trusted Contract로 판정
- `acp-production-gate`는 Agent Control Plane만 게시

## 14.3 기본 Check

생성 Repository는 다음을 노출한다.

```text
project-ci
```

Agent Control Plane은 다음을 게시한다.

```text
acp-production-gate
```

`acp-production-gate`는 Active Contract·Trusted Verification·필수 Security Lane·Blind Review·Human Gate·Exact Head를 종합한다.

Merge Predicate에 포함되지 않은 Security Workflow를 “Merge Gate”라고 부르면 안 된다.

## 14.4 CI Trust

`TRUSTED_CI` 유효 조건:

```text
Exact Candidate Head
Approved Workflow/Config Digest
Trusted Creator Identity
Non-vacuous Required Job
Current Result
```

---

# 15. Verification 실행 안전성

Repo Factory는 Agent Control Plane에 Verification을 요청한다. Candidate Command를 Privileged Local Credential 환경에서 직접 실행하지 않는다.

Agent Control Plane이 제공해야 하는 최소 격리:

```text
Disposable Worktree
Sanitized Environment
Provider/GitHub/Buzz/Telegram Secret 제거
Writable Root 제한
Process Group Timeout·Child Cleanup
CPU/Memory/Output Limit
Network Policy
Candidate Snapshot Pinning
```

v1.1은 Owner가 신뢰하는 Repository만 지원한다. 그래도 Secret Stripping과 Isolated Worktree는 필수다.

---

# 16. GitHub 외부 쓰기와 멱등성

## 16.1 Plan-before-Apply

Remote Repository·Branch·Ruleset·Issue·Milestone·Tag·Setting은 Exact Plan 승인 전 쓰면 안 된다.

## 16.2 Post-write Reread

모든 Write는 GitHub에서 재조회하고 Expected State와 비교한다. Command Exit 0만으로 완료 증거가 되지 않는다.

## 16.3 Idempotency

이름이 아니라 Operation Provenance를 기준으로 한다.

```text
같은 Operation + 같은 Intent + 같은 Resource → Resume
같은 이름 + 다른 Provenance → RESOURCE_COLLISION
Partial Apply → Verified Receipt 이후부터 Resume
```

## 16.4 Multi-repository Bootstrap

여러 Repository를 만들거나 복구할 수 있다. Repository별 Receipt와 Partial State를 가진다.

가짜 Atomicity를 주장하지 않는다. 일부 성공·일부 실패 시 다음을 명시한다.

```text
완료 Resource
실패 Operation
Safe Resume Point
필요한 Compensation
```

---

# 17. Ticket과 GitHub Issue Projection

## 17.1 Artifact 정책

- SIMPLE: Ticket 선택
- STANDARD: 실행 분해 가치가 있을 때만
- GUARDED: 위험에 따라 상세 Ticket·Acceptance Oracle

## 17.2 최소 Ticket Contract

실행이나 판정에 영향을 주는 필드만 둔다.

```text
id
goal
dependencies
필요한 경우 scope/owned paths
acceptance
verification refs
risk
stop/escalation condition
```

소비자가 없는 Oracle·Budget·Invalidation·Path Ownership을 강제하지 않는다.

## 17.3 Issue Projection

Ticket File은 Portable Contract, GitHub Issue는 Projection이다. Marker 기반 Projection은 Title·Body·Label·Milestone·필요한 State Policy까지 멱등 동기화한다.

Activation 이후 Agent Control Plane GitHub Integration Kernel이 공유 Repo Factory Projection Library를 호출한다. Repo Factory Runtime을 다시 켜지 않는다.

---

# 18. CommitLore 정책

CommitLore는 Decision Memory이며 Operational Authority가 아니다.

기본 Deployment Profile:

| Bootstrap Profile | Default | 실패 처리 |
|---|---|---|
| SIMPLE | preferred | 명시적 Required가 아니면 Warning |
| STANDARD | required | Bootstrap Revision 또는 승인된 예외 |
| GUARDED | Decision Memory가 중요하면 required | Blocking |

규칙:

- Enabled Repository는 `commitlore init`, `commitlore doctor` 실행
- 실패를 PASS로 축약 금지
- `operationalAuthority=false` 불변
- ADR·Git·Verification·Control Plane State 대체 금지

---

# 19. 실패와 복구

## 19.1 Planning Failure

외부 Write 없음. Hermes/Bootstrap CTO가 명세 또는 Plan 수정.

## 19.2 Apply Failure

Partial Receipt 반환. Unknown Write를 무작정 재시도하지 않는다.

## 19.3 CI/Verification Failure

`PROJECT_BOOTSTRAP` Run은 CTO Revision으로 돌아간다. Owner-level Decision이 아니면 Owner에게 올리지 않는다.

## 19.4 Session/Provider Failure

Agent Control Plane Continuity Kernel이 처리한다. Repo Factory는 Durable Plan/Result 외 Runtime State를 소유하지 않는다.

## 19.5 Contract Drift

Apply된 Manifest가 승인 Digest와 다르면 `BOOTSTRAP_CONTRACT_DRIFT`로 Activation 거부.

---

# 20. 현재 Repository 리팩터링 결정

## 20.1 유지·고도화

```text
Research Protocol
Citation Verification
Dossier Template
Identity/Naming Protocol
Dogfooding Principle
Stack/Template Rendering
Bootstrap Verification
GitHub Profile Resolver
Issue Projection
Canary Framework
```

## 20.2 Generated Repository에서 제거

```text
Autopilot Runtime
Repo-local Scheduler
Repo-local Worker/Reviewer Adapter
Lease/Retry/Recovery Runtime
Repo-local Merge Broker
Repo-local Doctor
Permanent Governance State Machine
Provider/Model Routing Config
Fixed WIP Cap
```

## 20.3 Agent Control Plane으로 이관

```text
Run/Task Execution
Resource Claim
Provider Capacity
Session Lifecycle
Blind Review
GitHub Merge Authority
Post-merge Verification
Rollback Coordination
Doctor
Telemetry
Continuity
```

## 20.4 Trusted Validator 재설계

기존 Candidate-side Governance/Reviewer/Security Script는 권위로 유지하면 안 된다. 재사용 가치가 있는 Pure Validation Logic은 Trusted Versioned Validator로 옮겨 Agent Control Plane이 Candidate Snapshot에 대해 실행한다.

---

# 21. 목표 Repo Factory 구조

```text
repo-factory/
├── SKILL.md
├── README.md
├── profiles/
│   ├── simple.json
│   ├── standard.json
│   └── guarded.json
├── schemas/
│   ├── bootstrap-request.schema.json
│   ├── bootstrap-plan.schema.json
│   ├── repo-factory-result.schema.json
│   ├── external-write-receipt.schema.json
│   └── project-manifest.schema.json
├── scripts/
│   ├── plan.py
│   ├── apply.py
│   ├── verify-bootstrap.py
│   ├── configure-github.py
│   ├── project-issues.py
│   ├── github-profile.py
│   ├── verify-citations.py
│   └── run-canary.py
├── templates/
│   ├── common/
│   ├── node/
│   ├── python/
│   ├── go/
│   └── rust/
├── references/
└── tests/
```

---

# 22. Integration Interface

공개 Operation은 세 개로 제한한다.

## 22.1 `bootstrap_plan`

입력:

```text
BootstrapRequest
Approved Specification Artifacts
```

출력:

```text
BootstrapPlanCore
EnvironmentObservation
Plan Diff Summary
Human Gate Classification
```

## 22.2 `bootstrap_apply`

Precondition:

```text
Authorized Plan Digest
Valid bootstrapOperationId
No Resource Collision
Current Environment Compatible
```

출력은 External Write Receipt와 Local Materialization Fact다.

## 22.3 `bootstrap_verify`

Agent Control Plane Trusted Verification을 요청하고 `RepoFactoryResult`를 반환한다.

Production Gate를 게시하거나 Project ACTIVE를 선언하지 않는다.

---

# 23. 기능 요구사항

| ID | 요구사항 | Blocking |
|---|---|---:|
| RF-001 | 실제 저장소 생성은 `PROJECT_BOOTSTRAP` Managed Run으로 진입한다. | P0 |
| RF-002 | `bootstrapProfile`과 `run.executionMode`를 구분한다. | P1 |
| RF-003 | Hermes가 명세, Bootstrap CTO가 Lean 기술 검토를 소유한다. | P0 |
| RF-004 | SIMPLE은 필요한 Artifact만 생성한다. | P0 |
| RF-005 | Plan Intent와 Volatile Observation을 분리해 Canonical Digest를 만든다. | P0 |
| RF-006 | Plan Authorization을 `HERMES|OWNER`로 명시한다. | P1 |
| RF-007 | Committed Manifest는 Portable하며 Absolute Path가 없다. | P0 |
| RF-008 | Active Manifest Digest를 Pin하고 Contract Self-weakening을 막는다. | P0 |
| RF-009 | Verification Command는 공통 argv Schema를 사용한다. | P0 |
| RF-010 | Stack-specific CI에 실제 Setup·Install·Test·Build가 있고 Placeholder가 없다. | P0 |
| RF-011 | Branch Source·Target·Update·Merge·Release·Hotfix를 Machine-readable로 만든다. | P0 |
| RF-012 | 모든 Programmatic Merge Target은 Agent Control Plane이 통제한다. | P0 |
| RF-013 | 모든 외부 Write는 Provenance와 Post-write Evidence를 가진다. | P0 |
| RF-014 | 같은 이름의 무관한 Resource는 `RESOURCE_COLLISION`이다. | P0 |
| RF-015 | Multi-repo Bootstrap은 Repo별 Receipt와 Partial State를 가진다. | P0 |
| RF-016 | RepoFactoryResult와 ACPBootstrapActivationResult를 분리한다. | P0 |
| RF-017 | Bootstrap 이후 Issue Projection을 Runtime 재활성화 없이 재사용한다. | P1 |
| RF-018 | CommitLore Failure는 Profile-aware이며 Silent PASS가 없다. | P1 |
| RF-019 | Candidate-controlled Validator/Config가 자기 자신을 승인할 수 없다. | P0 |
| RF-020 | Bootstrap Verification은 ACP Isolated Verification Engine에서 실행한다. | P0 |
| RF-021 | Durable Result와 Handoff Seed 생성 후 Repo Factory는 종료한다. | P0 |

---

# 24. Acceptance Traceability

| Requirement | Scenario | Evidence Source | Blocking |
|---|---|---|---:|
| RF-001 | RF-S01 | `PROJECT_BOOTSTRAP` Run Record | P0 |
| RF-002 | RF-S01 | Request/Run Field Schema | P1 |
| RF-003 | RF-S03 | Hermes Spec + Bootstrap CTO Lean Verdict | P0 |
| RF-004 | RF-S02 | Generated Artifact Manifest | P0 |
| RF-005 | RF-S04 | Canonical Digest Repetition Test | P0 |
| RF-006 | RF-S24, RF-S25 | Plan Authorization Record | P1 |
| RF-007 | RF-S05 | Project Manifest Schema Validation | P0 |
| RF-008 | RF-S06, RF-S22 | Pinned Contract Digest + Contract-change Evidence | P0 |
| RF-009 | RF-S07 | VerificationCommand Schema Result | P0 |
| RF-010 | RF-S08, RF-S09 | Rendered CI + Exact-head CI Result | P0 |
| RF-011 | RF-S10–RF-S13 | Branch Contract Validation | P0 |
| RF-012 | RF-S10–RF-S13 | Trusted GitHub Kernel Merge Evidence | P0 |
| RF-013 | RF-S14 | ExternalWriteReceipt + Post-write Reread | P0 |
| RF-014 | RF-S15 | `RESOURCE_COLLISION` Result | P0 |
| RF-015 | RF-S16 | Per-repo Receipt + Partial Resume Evidence | P0 |
| RF-016 | RF-S17 | Distinct Result Schema Validation | P0 |
| RF-017 | RF-S18 | ACP `issue_project` Receipt | P1 |
| RF-018 | RF-S19–RF-S21 | Profile-specific CommitLore Result | P1 |
| RF-019 | RF-S22 | Candidate Gate Weakening Rejection | P0 |
| RF-020 | RF-S23 | Verification Sandbox Evidence | P0 |
| RF-021 | RF-S17 | Repo Factory Exit + ACP Activation Evidence | P0 |

---

# 25. 필수 Scenario Suite

## Core Flow

- **RF-S01:** DIRECT 논의가 실제 생성 요청 시에만 Managed로 승격된다.
- **RF-S02:** SIMPLE 프로젝트에 필요 없는 PRD·ADR·Ticket이 생성되지 않는다.
- **RF-S03:** STANDARD 과설계 명세가 제품 Scope 변경 없이 Lean하게 축소된다.
- **RF-S04:** Timestamp가 달라도 같은 PlanCore는 같은 Digest를 만든다.

## Manifest / Contract

- **RF-S05:** Absolute Path·Session ID·Provider·Channel ID가 있는 Manifest를 거부한다.
- **RF-S06:** Candidate가 Verification을 `true`로 바꾸지만 현재 Run은 이전 Contract를 사용한다.
- **RF-S07:** Shell String/Pipeline은 거부되고 argv Command는 통과한다.

## CI

- **RF-S08:** Node Template이 Lower/Latest Runtime과 Dependency를 실제 설치한다.
- **RF-S09:** Unresolved Placeholder가 Bootstrap 완료를 막는다.

## Branch / Release

- **RF-S10:** 잘못된 Base의 Feature Branch 거부.
- **RF-S11:** 선언하지 않은 Parent로 가는 Task PR 거부.
- **RF-S12:** Exact `main` Merge Commit이 아닌 Release Tag 거부.
- **RF-S13:** Active Release에 Hotfix가 없으면 완료 거부.

## External Write

- **RF-S14:** Repo/Branch/Issue 생성 후 GitHub 재조회 검증.
- **RF-S15:** 무관한 Same-name Repo는 `RESOURCE_COLLISION`, 무변경.
- **RF-S16:** 2-Repo Bootstrap Partial Failure 후 결정적 Resume.

## Boundary

- **RF-S17:** RepoFactoryResult에 CTO/Doctor Field가 없고 ACPActivationResult가 공급한다.
- **RF-S18:** Post-bootstrap Ticket Projection은 ACP를 통해 동기화된다.

## CommitLore

- **RF-S19:** SIMPLE Optional CommitLore 부재 → Warning.
- **RF-S20:** STANDARD Required CommitLore 부재 → Revision.
- **RF-S21:** GUARDED Required Decision Memory 부재 → Blocking.

## Trust / Safety

- **RF-S22:** Candidate가 Validator/Workflow/Manifest를 약화해도 Trusted Gate는 이전 Contract를 유지한다.
- **RF-S23:** Candidate Verification이 Provider/GitHub/Telegram/Buzz Secret을 읽지 못한다.
- **RF-S24:** Plan Authorization 없는 외부 Write 거부.
- **RF-S25:** Hermes 승인 Plan이라도 Public 노출은 Owner에게 Escalation.

---

# 26. 비기능 요구사항

## Reliability

- 모든 Applied Resource는 Provenance Receipt 보유
- 같은 Operation 재실행 결정성
- Agent Self-report만으로 PASS 금지
- Partial Multi-repo Operation 중복 없이 Resume

## Security

- Candidate-controlled Gate 자기승인 금지
- Committed Artifact에 Local Credential·Absolute Path 금지
- Bootstrap Command는 ACP Verification Sandbox에서 실행
- Repo Factory가 Trusted GitHub Gate Credential을 받지 않음

## Maintainability

- 생성 저장소에는 Project Contract와 CI만 두고 Runtime Platform 복제 금지
- Stack Template 독립 Versioning·Test
- Common Schema 구현 정본 1개
- Bootstrap Profile이 소비하지 않는 Reference는 Runtime Load 금지

## Performance

- SIMPLE에서 불필요한 Research/Artifact 생성 금지
- Plan/Apply Incremental·Idempotent
- Remote Call은 안전한 범위에서 Batch

## Privacy

- Public Repo에 Absolute Path·Username·Session ID·Private Receipt·Channel Identity·Quota Snapshot 금지
- Raw Reasoning·Full Chat Transcript를 Bootstrap Artifact로 생성 금지

---

# 27. 구현 단계

## Slice 0 — Common Contracts

```text
Shared Schema
Canonicalization
Portable Project Manifest
VerificationCommand
Result/Receipt Contract
```

## Slice 1 — Bootstrap Compiler

```text
Request Parsing
Profile-aware Artifact Selection
PlanCore/Observation 분리
Lean Review Contract
Deterministic Rendering
```

## Slice 2 — Stack CI / Branch Contract

```text
Node/Python/Go/Rust Template
Branch Matrix
Release/Hotfix/Tag Contract
No-placeholder Gate
```

## Slice 3 — External Writes

```text
GitHub Configuration
Provenance Receipt
Post-write Reread
Collision / Partial Apply
Issue Projection
```

## Slice 4 — ACP Integration

```text
PROJECT_BOOTSTRAP Run
BOOTSTRAP_CTO Binding
Verification Sandbox Request
RepoFactoryResult Validation
Activation / Handoff
```

## Slice 5 — Dogfood

```text
SIMPLE / STANDARD / GUARDED Real Project
Public / Private Profile
Actual GPT/Claude Bootstrap Workflow
Repeat / Recovery
```

---

# 28. Definition of Done

Repo Factory v1.1 완료 조건:

1. RF-S01~RF-S25 전부 PASS
2. SIMPLE·STANDARD·GUARDED 각 1개 End-to-End Bootstrap
3. Required Scenario Suite와 최소 3개 Dogfood Repo, 관련 30개 이상 Bootstrap/Activation Lifecycle 관측 범위에서 Unauthorized Write 0, False Activation 0, Duplicate External Resource 0, Candidate-controlled Gate Bypass 0
4. Zero Count의 관측 범위·기간 기록
5. Generated CI가 Exact Generated Head에서 Placeholder 없이 Green
6. 모든 프로젝트가 Portable Manifest와 별도 RepoFactoryResult 생성
7. Agent Control Plane이 Project 활성화·Handoff ACK·Doctor 완료
8. Activation 이후 Repo Factory Runtime Authority 0
9. Repo Factory 담당 P0 Requirement가 Scenario/Evidence에 연결

---

# 29. Production Review Closure Matrix

| Review Item | 반영 위치 |
|---|---|
| P0-02/P0-03 | §§10–11, RF-007 |
| P0-04 | §10.4, RF-008 |
| P0-07 | §9.4, RF-012 |
| P0-09 | §12, RF-009 |
| P0-10 | §§13.4, 16.4, RF-015 |
| P0-20 | §§7, 13.4–13.5, RF-016 |
| P0-21 | §16, RF-013–014 |
| P1-01 | §6 |
| P1-12/P1-13 | §§7–8 |
| P1-14–P1-17 | §9 |
| P1-18 | §18 |
| P1-19 | §17.3 |
| P1-20 | §§13.3, 16.4 |
| P1-26/P1-27 | §§24, 28 |

---

# 30. 최종 고정 원칙

```text
Repo Factory는 만들고, Agent Control Plane은 운영한다.
명세는 강하게, Genesis는 Lean하게 만든다.
Portable Contract는 Commit하고 Local Binding은 Local에 둔다.
Candidate는 자신을 판정하는 Contract를 약화할 수 없다.
모든 외부 Write는 Provenance와 Reread Evidence를 가진다.
Same-name Resource를 현재 Operation 소유로 추정하지 않는다.
모든 Programmatic Merge는 Trusted Control Plane Kernel이 수행한다.
생성 Repository에는 Project Truth만 두고 Runtime Platform을 복제하지 않는다.
RepoFactoryResult는 Project Activation이 아니다.
```
