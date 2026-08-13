# Agent Control Plane v1.0 — Final Implementation Closeout Prompt

첨부한 `AGENT_CONTROL_PLANE_v1.0_FINAL_IMPLEMENTATION_CLOSEOUT_REVIEW.md`를
Agent Control Plane v1의 **유일한 구현 종결 Review/Addendum**으로 사용해.

레포에 vendored된 `docs/prd/AGENT_CONTROL_PLANE_PRD_v1.3_FINAL.md`는 제품 기능 SSOT이며,
이전 A–Z 리뷰와 중간 리뷰 문서는 역사적 evidence로만 취급해.

## 목표

이 문서의 **P0, P1, V1-BR, Wave 0~7, Live Acceptance, Production-Ready Gate**를
하나의 dependency graph로 실행해.

목표는 issue를 닫거나 테스트 숫자를 늘리는 것이 아니다.

실제 Mac 환경에서 다음 production vertical을 끝까지 닫는 것이 목표다.

```text
agentcpd
→ Hermes
→ Primary CTO
→ Worker
→ Deterministic Verification
→ GPT-5.6 Sol xhigh Blind Review
→ CEO Confirm
→ GitHub App Production Gate
→ Ordered Merge
→ Post-merge Verification
→ COMPLETED
```

## 실행 원칙

1. 현재 `main`의 실제 상태를 먼저 조사하고 문서의 finding이 이미 해결됐는지 재검증한다.
2. 해결된 항목은 구현을 반복하지 말고 commit SHA와 regression evidence로 close한다.
3. 아직 유효한 항목만 dependency 순서대로 구현한다.
4. P0가 남아 있는 상태에서 cosmetic cleanup, 미래 기능, ACP 2.0 기능을 먼저 구현하지 않는다.
5. 테스트가 존재한다는 이유만으로 완료로 간주하지 않는다. 해당 enforcement를 제거했을 때 실제로 regression test가 실패하는지 확인한다.
6. mock/fake path만 통과한 기능은 production-ready로 간주하지 않는다.
7. 실제 provider/runtime/GitHub/Buzz/Telegram/MCP/launchd 경로가 요구되는 항목은 live evidence까지 확보한다.
8. Owner만 할 수 있는 외부 설정이 필요한 경우에만 명확한 blocker로 분리한다.
9. 치명적인 Owner 결정이 없다면 승인 대기 없이 구현·검증·evidence 정리까지 계속 진행한다.
10. 과설계하지 않는다. ACP v1의 기존 architecture를 유지하고, 가장 작은 production-ready 수정으로 종결한다.

## ACP 2.0 범위 금지

이번 작업에는 다음을 넣지 마.

```text
Context Compiler
Task Eligibility Engine
Graph Optimizer
Adaptive Topology
Failure Localization Engine
Obsidian Integration
Knowledge Graph
Model Substitution Router
Lesson / Playbook 자동 승격
Self-improvement Runtime
Online RL
```

단, ACP 2.0의 향후 paired experiment를 위한 **v1 baseline telemetry/evidence contract**는
Closeout Review에 정의된 범위까지 반드시 완성한다.

## 필수 완료 조건

다음 조건을 모두 만족하기 전에는 `PRODUCTION_READY` 또는 `DONE`이라고 보고하지 마.

- P0 Release Blocker = 0
- Production-relevant P1 = 0 또는 문서가 허용한 명시적 accepted residual risk
- full typecheck / lint / build / tests PASS
- requirement ↔ scenario traceability PASS
- fresh database + migration + backup/restore 검증 PASS
- daemon single-authority / restart recovery PASS
- Hermes CEO bootstrap 및 MCP 연결 PASS
- Primary CTO 실제 provider session 연결 PASS
- DRAINING → HANDOFF → ACK → binding switch 실제 경로 PASS
- Worker identity / claim / worktree confinement PASS
- deterministic verification PASS
- fresh independent GPT-5.6 Sol xhigh blind review 정상 경로 PASS
- Human Gate의 단일 authoritative predicate PASS
- GitHub App production gate publish PASS
- CEO 승인 후 daemon-owned ordered merge PASS
- post-merge verification PASS
- release/hotfix lineage PASS
- real two-repository ordered merge PASS
- Buzz live delivery/ACK PASS
- Telegram → Hermes ingress PASS
- launchd install/start/restart/upgrade/rollback 검증 PASS
- branch protection / required checks 설정 완료
- 3개 프로젝트 / 30+ lifecycle 관측 조건을 Closeout Review 정의대로 충족
- false completion / unauthorized merge / stale-generation acceptance = 0
- immutable/redacted ACP v2 baseline export 생성 가능
- fresh independent A–Z production review PASS

## Issue 종료 규칙

GitHub issue를 닫을 때는 반드시 다음 중 하나를 남겨.

```text
FIXED
- commit SHA
- regression test
- live evidence (필요한 경우)

STALE / ALREADY FIXED
- current HEAD에서 더 이상 재현되지 않는 근거
- 이를 증명하는 test 또는 code path

NOT APPLICABLE
- 현재 PRD/architecture에서 적용되지 않는 이유
```

근거 없는 close는 금지한다.

## 최종 보고 형식

작업 종료 시 다음 순서로 보고해.

1. 최종 `main` SHA
2. Production-Ready verdict
3. 닫은 P0/P1 목록과 evidence
4. 남은 accepted residual risks
5. 전체 test/build/traceability 결과
6. 실제 Mac deployment 상태
7. Hermes / CTO / Worker / Blind Reviewer 연결 상태
8. GitHub App gate → merge → post-merge live evidence
9. Buzz / Telegram live evidence
10. migration / backup / restore evidence
11. 3-project / 30-lifecycle observation 결과
12. ACP 2.0 baseline export 위치와 schema
13. `v1.0.0` release/tag 정보
14. ACP 2.0 진입 가능 여부: `GO` 또는 `HOLD`

## 최종 원칙

**ACP v1은 “코드가 많고 테스트가 많은 프로젝트”가 아니라,
실제 에이전트 조직을 안전하게 운영하고, 검증하고, 복구하고, production까지 닫는
단일 Local Runtime Authority여야 한다.**

Closeout Review의 요구를 약화하거나 우회해서 PASS를 만들지 마.
