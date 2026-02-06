# Lean PRD - Gercek Platform Entegrasyonu ve Uretim Hazirligi

## Context
Mevcut lease-bot mimarisinde platform baglayici katmani soyut durumda, fakat cogu akista no-op/simulasyon davranisi var. Uygulama production seviyesine alinacaksa Spareroom, Roomies, Leasebreak, RentHop ve FurnishedFinder icin gercek entegrasyonlarin devreye alinmasi, admin tarafindan platform bazli kontrol edilmesi ve mesaj gonderim davranisinin (hemen gonder vs draft) yonetilebilir olmasi gerekiyor.

## Problem Statement
Sistem bugun pipeline seviyesinde karar verebiliyor ancak gercek platformlarda guvenilir ingest/send dongusu, platform ac/kapa kontrolu ve admin kontrollu gonderim stratejisi net ve testli degil. Bu eksikler production ciktiginda hatali gonderim, platform erisim bloklari ve operasyonel kontrol kaybi olusturur.

## Goals
- Bes zorunlu platform icin (Spareroom, Roomies, Leasebreak, RentHop, FurnishedFinder) gercek entegrasyon calisir halde olsun.
- Tum platformlar RPA tabanli calissin (API varsayimi yok).
- Her platform admin panelinden ayri ayri aktif/pasif yapilabilsin.
- Mesaj gonderim modu admin tarafindan yonetilebilsin: `auto_send` veya `draft_only`.
- Worker akisi idempotent, gozlemlenebilir, retry ve hata-izolasyonlu sekilde production seviyesine ciksin.
- E2E testler, smoke ve rollout runbook ile canliya cikis kriterleri netlestirilsin.

## Non-Goals
- Yeni CRM/ERP entegrasyonu.
- Platform disi yeni kanal (WhatsApp, SMS vb.) eklemek.
- Mobil native uygulama.

## Users
- Admin: Platform baglantilarini, aktiflik durumunu ve gonderim modunu yonetir.
- Agent: Konusma ve randevu akislarini takip eder; riskli mesajlarda admin review bekler.
- Ops/Engineering: Entegrasyon sagligini, hata oranlarini ve release gate'lerini izler.

## Requirements
- R1: Zorunlu platform kapsami birebir uygulanacak: `spareroom`, `roomies`, `leasebreak`, `renthop`, `furnishedfinder`.
- R2: Tum zorunlu platformlar RPA connector uzerinden entegre edilecek; API connector bu kapsamda kullanilmayacak.
- R3: Platform baglantisi calisma zamani aktiflik kontrolu destekleyecek (`is_active`/`enabled`) ve worker ingest/send sadece aktif platform hesaplarina kosacak.
- R4: Admin panelinde platform bazli ac/kapa toggles olacak ve degisiklikler API + DB uzerinden kalici saklanacak.
- R5: Admin panelinde mesaj gonderim modu ayari olacak: `auto_send` (policy uygun ise hemen gonder) ve `draft_only` (her zaman draft).
- R6: Gonderim modu global default + platform hesap seviyesinde override destekleyecek; worker kararinda tek kaynak olarak bu ayarlar kullanilacak.
- R7: Outbound dispatch akisi idempotent olacak; tekrar denemelerde cift gonderim engellenecek (message-level dispatch key / unique guard).
- R8: Retry/backoff davranisi platform ve hata tipine gore politikali olacak; retry sonunda basarisiz isler DLQ/escalation akisine alinacak.
- R9: Platform connector katmani credential yonetimini sadece env-ref/secret-manager uzerinden yapacak; plain secret commit edilmeyecek.
- R10: API/RPA dispatch denemeleri ve sonuclari AuditLogs + observability metriklerine platform bazli yansitilacak (success, retry, fail, blocked).
- R11: Admin/ops panelinde platform saglik gorunumu olacak: son basarili ingest/send zamani, hata sayisi, disable nedeni.
- R12: Inbox akisinda auto-send acik olsa bile guardrail/riskli durumlarda zorunlu admin review korunacak.
- R13: E2E test paketi, her zorunlu platform icin en az bir ingest ve bir outbound senaryosunu (mocked browser gateway veya sandbox) dogrulayacak.
- R14: CI quality gates API testleri + worker testleri + web smoke + entegrasyon contract/e2e test adimini zorunlu kilacak.
- R15: Rollout plani staged olacak (shadow -> canary -> full) ve her adimda rollback kosullari/runbook adimlari tanimli olacak.
- R16: RPA anti-bot/dayaniklilik katmani zorunlu olacak: hiz limiti, jitter, session yenileme, retry siniri, captchaya yakalanma tespiti ve circuit-breaker.

## Success Metrics
- Zorunlu 5 platformun production readiness checklist tamamlama orani: %100.
- Platform dispatch basari orani (retry sonrasi): >= %98.
- Hatali/tekrarli outbound (duplicate send): 0.
- Admin tarafindan platform ac/kapa ve gonderim modu degisikligi yansima suresi: <= 1 dakika.
- E2E/critical gates pass orani release adiminda: %100.

## Constraints
- Mevcut monorepo yapisi korunacak (`apps/api`, `apps/worker`, `apps/web`, `packages/*`).
- Better Auth + RBAC modeli korunacak.
- Tum hedef platformlarda mesajlasma entegrasyonu RPA uzerinden ilerleyecek.
- Production sirri dosyalara yazilamaz; sadece env/secret manager referanslari kullanilir.
