# Lean PRD - Excel Is Modelinden Uretim Otomasyonuna Gecis

## Context
Mevcut operasyon gercek hayatta agent bazli Excel workflow'u ile yuruyor: lead yakalama, showing planlama, follow-up ve sonuc takibi. lease-bot uygulamasinda AI decisioning, platform policy, inbox, showings ve observability temelleri var; ancak Excel'deki operasyon modelinin tamamini production seviyesinde, browser otomasyonu ile uc uca kapsayan bir akis henuz tamamlanmis degil.

## Problem Statement
Isverenin ve agentlarin Excel'e ihtiyac duymadan ayni isi (hatta daha guvenli ve hizli sekilde) uygulama icinden yurutmesi gerekiyor. Zorunlu 5 platformda (spareroom, renthop, leasebreak, roomies, furnishedfinder) gelen mesajlarin anlik sisteme dusmesi, AI tarafinda dogru karar verilmesi, uygun durumlarda otomatik cevap gonderilmesi, AI'in kararsiz kaldigi yerde agent'in dashboarddan platforma tekrar girmeden cevap verebilmesi ve tum akislarin izlenebilir olmasi zorunlu.

## Goals
- Excel'deki gercek operasyon modelini (ucret haric) uygulama icine birebir tasimak.
- 5 zorunlu platformda browser otomasyonu ile ingest + outbound akisini production hazir hale getirmek.
- AI ile lead/showing/follow-up/outcome kararlarini otomatiklestirmek.
- Human-in-the-loop gerektiren durumlarda agent dashboarddan direkt platforma mesaj gonderimini saglamak.
- Uygulamayi plan tamamlandiginda production rollout ve e2e dogrulama icin hazir hale getirmek.

## Non-Goals
- Ucret/payroll/komisyon hesaplama (faz disi).
- Yeni platform ekleme (zorunlu 5 platform disi).
- Native mobil uygulama.

## Users
- Admin: platform policy, operasyon kontrolu, kalite ve gozlemlenebilirlik yonetimi.
- Agent: gunluk inbox, showing gorevleri, follow-up, manuel insan cevabi, outcome guncelleme.
- Ops/Engineering: entegrasyon sagligi, retry/circuit-breaker, release gateleri.

## Source Workflow (Excel Referansi)
- Lead: kim yazdi, hangi platformdan geldi, hangi ilana geldi.
- Showing: ne zaman/nerede/person-virtual, uygun agent atamasi.
- Follow-up: birinci ve ikinci takip aksiyonlari.
- Outcome: not interested, wants to reschedule, no reply, confirmed/completed vb sonuclar.

## Functional Requirements
- R1: Sistem zorunlu platform setini birebir destekleyecek: `spareroom`, `renthop`, `leasebreak`, `roomies`, `furnishedfinder`.
- R2: Tum zorunlu platformlar browser otomasyonu (RPA) ile calisacak; API entegrasyonuna bagimli olunmayacak.
- R3: Her platform icin inbound ingest ve outbound dispatch contract'i production ortaminda aktif olacak.
- R4: Platforma yeni mesaj dustugu anda (near-real-time) sistemde conversation/message olusacak; p95 ingest gecikmesi hedefi tanimlanacak.
- R5: Inbound mesajlar listing/unit/platform/thread/sender kimligi ile kaydedilecek; cevabin baglami bu kimlikten beslenecek.
- R6: AI decision pipeline inbound mesaji intent + risk + next-action olarak siniflandiracak.
- R7: AI kararinda en az su outcome niyetleri ayirt edilecek: `not_interested`, `wants_reschedule`, `no_reply`, `showing_confirmed`, `general_question`, `human_required`.
- R8: `no_reply` state'i gecici olacak; lead yeni cevap verirse state otomatik guncellenecek (stale state kalmayacak).
- R9: Showing onerileri `unit availability + agent assignment + agent availability + conflict checks` birlesik kurali ile uretilecek.
- R10: Slot secimi yapildiginda booking idempotent sekilde olusacak ve ilgili agent gorev listesine dusecek.
- R11: Showing lifecycle durumlari en az su state'leri destekleyecek: `pending`, `confirmed`, `reschedule_requested`, `cancelled`, `completed`, `no_show`.
- R12: Follow-up modeli en az iki asamali olacak (`follow_up_1`, `follow_up_2`) ve due-time + owner + status bilgisi tasiyacak.
- R13: Follow-up mesajlari AI tarafindan baglama uygun yazilacak; policy'ye gore auto-send veya draft-only davranacak.
- R14: AI'in guveninin dusuk oldugu, riskli veya policy disi durumlarda `human_required` karari uretilecek.
- R15: `human_required` mesajlari agent inbox'unda aksiyon olarak gorunecek.
- R16: Agent, ilgili platforma tekrar login olmadan dashboard uzerinden manuel cevap gonderebilecek; cevap platform thread'ine dispatch edilecek.
- R17: Agent cevaplari da guardrail/policy/logging katmanindan gececek (audit zorunlu).
- R18: Admin paneli platform bazli `is_active`, `send_mode`, `integration_mode`, health ve hata gorunurulugunu sunacak.
- R19: Her platform icin anti-bot/dayaniklilik mekanizmalari olacak: rate limit, jitter, retry, session refresh, captcha/challenge handling, circuit breaker.
- R20: Retry tukenirse olay DLQ/escalation olarak isaretlenecek ve operasyon panelinde gorunecek.
- R21: Worker orkestrasyonu ingest -> decision -> dispatch zincirini tek isletim modelinde calistiracak.
- R22: Coklu worker calismasinda duplicate send engellenecek (claim + dispatch idempotency).
- R23: Agent scope izolasyonu zorunlu olacak; agent sadece kendi atanmis/gerekli kayitlari gorecek ve yonetecek.
- R24: Admin tam gorunum ve override yetkisine sahip olacak.
- R25: UI mevcut tasarim dilini koruyacak; admin/agent deneyimleri operasyonel hiz odakli duzenlenecek.
- R26: Agent dashboardu minimum olarak gunluk plan, bekleyen human-required mesajlar, bugunku showings ve follow-up kuyrugunu gosterecek.
- R27: Outcome guncellemeleri (not interested/reschedule/no_show/completed) dashboarddan tek tikla yapilabilir olacak.
- R28: Tum kritik kararlar ve platform eylemleri audit log + observability metriklerine platform/agent/conversation bazinda yazilacak.
- R29: E2E test paketi 5 platform ingest+outbound contract'ini, AI karar yolunu, human-handoff yolunu ve showing lifecycle yolunu dogrulayacak.
- R30: Rollout plani shadow -> canary -> full adimlariyla tanimlanacak; rollback kosullari runbook'ta net olacak.

## Success Metrics
- M1: Zorunlu 5 platformun ingest+dispatch production readiness kapsami: %100.
- M2: Ingest p95 gecikme: <= 60 saniye (platform kisitlarina gore konfigure edilebilir).
- M3: Retry sonrasi dispatch basari orani: >= %98.
- M4: Duplicate outbound send: 0.
- M5: Human-required mesajlarin agent tarafinda ilk aksiyon suresi (median): <= 5 dakika (is saatlerinde).
- M6: Showing conflict kaynakli hatali cift booking: 0.
- M7: E2E kritik yol pass orani release gate'te: %100.

## Constraints
- Monorepo yapisi korunacak (`apps/api`, `apps/worker`, `apps/web`, `packages/*`).
- Better Auth + RBAC korunacak.
- Secret'lar kodda veya repoda tutulmayacak; env/secret ref modeli zorunlu.
- Ucret/payroll bu fazda implement edilmeyecek.

## Rollout Notes
- Baslangic modu: tum platformlarda `draft_only` + observability baseline.
- Shadow asamada ingest ve AI kararlar uretilecek, outbound canliya kontrollu gecilecek.
- Canary'de secili platform hesaplarinda `auto_send` acilacak.
- Full rollout, hata butcesi ve metrik hedefleri saglandiginda tamamlanacak.
