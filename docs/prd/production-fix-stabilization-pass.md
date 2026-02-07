# Lean PRD - Production Fix Stabilization Pass

## Context
Mevcut buyuk implementasyon paketinde ana capability'ler eklendi ancak kritik release kapilarinda kalan aciklar var: API testleri yeni workflow testlerinde DB baglanti ayari nedeniyle fail ediyor, web smoke script mevcut UI ile uyumsuz, AI kararinin workflow state'e kalici yansimasi eksik, slot secimi worker tarafinda agent+assignment kesisimi yerine yalniz unit availability'den uretiliyor, ingestte listing/unit baglami tam kurulmadan conversation olusabiliyor.

## Problem Statement
Sistemde feature kapsaminda ilerleme olsa da production readiness "green" degil. Kisa bir stabilizasyon fazi ile test/fix gap'leri kapatmadan rollout yapmak operasyonel risk olusturur (yanlis slot oneri, eksik workflow state, CI gate fail, smoke fail).

## Goals
- Kalan P0/P1 aciklari hizli ve guvenli sekilde kapatmak.
- CI ve smoke gate'lerini yesile almak.
- AI + scheduling + ingest akisini PRD modeliyle tam hizalamak.
- Mock runtime'in productiona sizmasini engellemek.

## Non-Goals
- Yeni platform ekleme.
- Ucret/payroll kapsami.
- Buyuk UI redesign.

## Users
- Admin
- Agent
- Ops/Engineering

## Requirements
- R1: API test paketi tam yesil olacak; workflow testlerinde DB baglanti konfigurasyonu deterministic hale getirilecek.
- R2: Web smoke script mevcut UI route/heading beklentileriyle uyumlu olacak ve gate fail etmeyecek.
- R3: Worker slot onerisi `unit + assignment + agent availability + conflict` kesisiminden beslenecek.
- R4: AI outcome kararlari (`workflowOutcome`, `showingState`, `followUpStage`) Conversation workflow alanlarina state-transition kurallariyla persist edilecek.
- R5: Ingest asamasinda conversation kayitlari listing/unit ile eslenebildigi durumda baglam kaybetmeden olusturulacak; eslesmeyenler auditlenecek.
- R6: Manual agent reply yolunda guardrail/policy kontrolu server-side zorunlu olacak; riskli icerik dispatch edilmeyecek.
- R7: Runtime modu productionda `playwright` zorunlu olacak; `mock` sadece test/local explicit opt-in ile calisacak.
- R8: Observability snapshot'ta fix kapsamindaki sinyaller gorunur olacak (workflow transition, human_required queue, slot-source, ingest-linkage).
- R9: Release kritik gate seti API+worker+web smoke+integrations contract adimlarinda tam pass olacak.
- R10: Runbook/release checklist fix fazi degisikliklerini ve rollback adimlarini acikca belgeyecek.

## Success Metrics
- M1: `npm run test -w @lease-bot/api` pass (0 fail).
- M2: `npm run smoke -w @lease-bot/web` pass.
- M3: Worker tarafinda slot source dogrulamasi testte assignment-kesisimli kanitlanir.
- M4: Mock runtime production env'de fail-fast olur.
- M5: Release critical gate adimlari %100 pass.

## Constraints
- Monorepo mimarisi korunacak.
- Better Auth + RBAC korunacak.
- Secretlar sadece env/ref ile yonetilecek.
- Stabilizasyon fazi kisa tutulacak; kapsam disi feature eklenmeyecek.
