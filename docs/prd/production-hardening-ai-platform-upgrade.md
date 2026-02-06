# Lean PRD - Production Hardening + AI Platform Upgrade

## Context
Mevcut lease-bot MVP calisiyor ancak web tarafinda runtime hata (React is not defined), UI teknik borcu, platform uyumsuzlugu (istenen platform listesi ile mevcut liste farkli), AI orkestrasyon eksigi ve kritik bir is kurali acigi var: unit-employee esleme + showing atama akisi uretim seviyesinde tamam degil.

## Problem Statement
Sistem su an operasyonel ekibin gunluk mesaj akisinda guvenilir, olceklenebilir ve dogrulanabilir bir sekilde kullanabilecegi seviyede degil. Ozellikle su akisin tam ve guvenli calismasi gerekiyor:
- Bir platformdaki belirli bir unit ilanina mesaj gelir.
- AI niyeti degerlendirir (tour/showing istegi vb).
- Sistem ilgili unit icin uygun calisan(lar)i ve musait saatleri bulur.
- Lead secim yaptiginda showing randevusu dogru calisana atanir.
- Atanan calisan panelde gorevini gorur.

## Goals
- Uretimde beyaz ekran/runtime hatasiz web uygulamasi.
- Shadcn/ui tabanli, test edilebilir ve surdurulebilir web paneli.
- UI/UX tasarimi mobile-first olacak; birincil kullanim senaryosu telefon.
- Vercel AI SDK + Google Gemini Flash 3.0 ile niyet analizi ve yanit olusturma.
- Spareroom, Roomies, Leasebreak, RentHop, FurnishedFinder platformlarinin eksiksiz desteklenmesi.
- Auto-send acik/kapali kontrolu ve riskli/uygunsuz mesajlarda admin bildirim akisi.
- Unit-calisan esleme + musaitlik + showing atama islemlerinin uc uca izlenebilir sekilde calismasi.

## Non-Goals
- SSR/SEO odakli public web deneyimi.
- CRM/ERP gibi harici sistemlerle derin iki yonlu entegrasyon.
- Mobil native uygulama.

## Users
- Admin: kural, platform, template, auto-send, unit-agent assignment ve denetim yonetir.
- Part-time leasing agent: haftalik musaitlik girer, atanan showings gorevlerini gorur, gerekirse override eder.

## Key Scenario (Target Behavior)
- Leasebreak platformunda 155 Ridge Street unit ilanina inbound mesaj gelir: "Merhaba, uniti gormek istiyorum".
- AI bunu tour/showing intent olarak siniflar.
- Sistem bu unit ile iliskili calisanlari bulur (ornek: Maurik, Leyla).
- Musaitlikten uygun slotlar derlenir (ornek: Leyla 11:00-12:00, Maurik 15:00-16:00).
- Lead'e slot secimi iceren cevap gider.
- Lead 15:00-16:00 secerse randevu Maurik'e atanir ve uygulamada Maurik panelinde showing gorevi gorunur.

## Requirements
- R1: `apps/web` runtime hatasi (React is not defined) kalici olarak giderilecek; dev ve production build acilisi sorunsuz olacak.
- R2: Web arayuzu shadcn/ui + Tailwind tabanina gecirilecek; temel ekranlar (Inbox, Conversation Detail, Unit/Listing, Unit-Agent Assignment, Agent Availability, Showings, Templates, Automation, Observability) bileşen bazli yeniden yapilandirilacak.
- R3: Routing katmani dosya tabanli ve moduler olacak; admin/agent akislari net olarak ayrilacak; SPA yapisi korunacak (SSR yok).
- R4: AI katmani Vercel AI SDK ile yeniden duzenlenecek; provider olarak Google Gemini Flash 3.0 kullanilacak; provider degisimine acik soyutlama korunacak.
- R5: AI pipeline gelen mesaji intent bazli degerlendirecek; tour/showing talebine uygun template/slot yaniti uretecek; uygun olmayan/riskli/ambiguous mesajlari admin review + bildirim akisina dusurecek.
- R6: Auto-send ayari panelden acilip kapanabilir olacak; acik oldugunda yalnizca policy tarafindan uygun bulunan mesajlar otomatik gonderilecek, digerleri taslak/uyari akisina dusecek.
- R7: Platform connector katmani Spareroom, Roomies, Leasebreak, RentHop, FurnishedFinder icin eksiksiz destek verecek; credentials yonetimi env-ref mantigiyla surdurulecek.
- R8: Audit ve observability metrikleri AI karar nedeni, gonderim sonucu, platform bazli hata, admin escalation eventlerini kapsayacak sekilde genisletilecek.
- R9: Test kapsami en az su seviyede olacak: API route/integration testleri, worker pipeline testleri, web kritik akis smoke testleri; CI seviyesinde fail-fast calisacak.
- R10: `.env.example` ve operasyon dokumantasyonu yeni AI/platform degiskenleri ile guncellenecek; gizli anahtarlar repoya girmeyecek.
- R11: Unit ile ilgilenebilecek calisanlar coklu olarak tanimlanabilecek (many-to-many unit-agent assignment); atama aktif/pasif ve oncelik bilgisi tasiyabilecek.
- R12: Calisan bazli musaitlik yonetimi desteklenecek: haftalik tekrar eden program + gunluk override + timezone; unit uygunlugu ile birlikte sorgulanabilir olacak.
- R13: AI tarafinda tour/showing intent kararindan sonra cevapta sunulacak slotlar "unit + atanabilir calisan + calisan musaitligi" birlesik kuralina gore secilecek.
- R14: Lead'in secimi kaydedildiginde `ShowingAppointment` benzeri bir kayit olusacak; secilen slot, unit, platform thread, atanan agent ve durum (pending/confirmed/cancelled/completed) izlenecek.
- R15: Agent panelinde kendisine atanmis showing gorevleri takvim/liste olarak gorunecek; filtreleme en az tarih, durum ve unit bazinda olacak.
- R16: Cakisma onleme uygulanacak: ayni agent ayni zaman araliginda cift booking alamaz; uygun degilse alternatif slot onerilir veya admin review tetiklenir.
- R17: UI mobile-first tasarlanacak; telefon ekranlarinda (320-430px) tum kritik akislarda tek elle kullanima uygun layout, hizli okunabilir tipografi, buyuk dokunma hedefleri ve sticky aksiyonlar saglanacak.
- R18: Mobile-first UX icin performans hedefleri uygulanacak: ilk boyama ve route gecislerinde hafif payload, kritik listelerde sanallastirma/paginasyon, agir tablolarda mobile uygun card-list fallback.

## Success Metrics
- Beyaz ekran/runtime error: 0
- Mesaj isleme basari orani (ingest + decision + draft/send): >= %99 (retry sonrasi)
- Yanlis auto-send orani: <= %1 (ilk rollout)
- Admin escalation gorunurlugu: %100 (riskli mesajlarin tamami denetlenebilir log ile)
- Showing atama dogrulugu: %100 (atanan showing kaydi ile agent panel gorunumu tutarli)
- Cakisma nedeniyle hatali cift booking: 0
- Mobil akislarda tamamlanma orani (inbox->randevu) desktop ile en fazla %10 farkla.

## Constraints
- Mevcut monorepo yapisi korunacak (apps/api, apps/web, apps/worker, packages/*).
- Mevcut auth (Better Auth) ve RBAC modeli korunacak.
- Mevcut veritabani modeli mumkun oldugunca evrimsel migration ile ilerleyecek, yikici degisikliklerden kacilacak.
