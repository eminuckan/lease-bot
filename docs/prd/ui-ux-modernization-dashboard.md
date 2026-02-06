# Lean PRD - UI/UX Modernizasyonu (Shadcn Dashboard + Login)

## Context
Mevcut `apps/web` arayuzu MVP seviyesinde, tutarsiz spacing/typography, zayif bilgi hiyerarsisi ve modern interaction kaliplari (toast, switch, calendar/date input, kalici tema secimi) acisindan yetersizdir. Hedef; mevcut React + Vite + TanStack Router mimarisini koruyarak, shadcn temelli modern, minimal ve production-ready bir deneyim sunmaktir.

## Problem Statement
- Dashboard ve login ekraninda gorsel/etkilesim tutarsizliklari var.
- Bilgi yogun ekranlarda okunabilirlik ve aksiyon kesfi zayif.
- Tema secimi kalici degil (dark mode persistence yok).
- Tarih secimi deneyimi basit native input ile sinirli.
- Kullaniciya anlik geri bildirim mesajlari modern toast standardinda degil.

## Goals
- Notr renk paletiyle modern, minimal ve tutarli bir design system kurulumu.
- Sidebar olmadan ust navigasyon ile sade, hizli ulasilabilir bilgi mimarisi.
- Login dahil tum kritik akislarda mobile-first, tutarli spacing ve tipografi.
- Shadcn ekosistemiyle modern component seti (switch, toast, date input, calendar).
- Kalici dark/light tema secimi (kullanici tekrar girdiginde korunur).

## Non-Goals
- Backend API contract degisikligi.
- Auth/RBAC is kurali degisikligi.
- Yeni is akisi ekleyip domain mantigini degistirme (UI/UX odakli kalinacak).

## Users
- Admin: inbox/assignment/showings/platform ekranlarini yogun kullanan operasyon kullanicisi.
- Agent: gunluk randevu/takvim ve inbox aksiyonlarini mobilde hizli kullanan saha kullanicisi.

## Requirements
- R1: `apps/web` genelinde notr bir token tabanli color system tanimlanacak (light/dark), mevcut kirmizi-krem agirligi kaldirilacak.
- R2: Global typography/spacing scale tanimlanacak ve login + admin + agent ekranlarinda tutarli uygulanacak.
- R3: Uygulama layout'u sidebar olmadan ust navigasyon odakli sade bilgi mimarisi ile guncellenecek.
- R4: Login ekrani modernlestirilecek; hiyerarsi, bosluklar, input/cta dengesi ve hata metinleri iyilestirilecek.
- R5: Dashboard panellerinde modern shadcn patternleri uygulanacak (card gruplama, segment kontrol, empty/loading states, sticky kritik aksiyon).
- R6: Tarih secimi gereken filtrelerde native `type=date` yerine shadcn tabanli date picker/calendar deneyimi kullanilacak.
- R7: Agent aylik bos gun gorunumu icin basit bir calendar paneli eklenecek; en az agent ve unit baglaminda filtrelenebilir olacak.
- R8: Platform controls benzeri policy aksiyonlarinda switch bileseni ile ac/kapa kontrol modeli uygulanacak.
- R9: Sistem mesajlari ve islem geri bildirimleri card ici text yerine modern toast standardina alinacak (Sonner).
- R10: Dark mode eklenecek; tema secimi local storage ile kalici olacak ve uygulama acilisinda secili tema hydrate edilecek.
- R11: Erisilebilirlikte minimum seviye korunacak: klavye odagi gorunurlugu, kontrast, dokunma hedefleri ve semantic role/label kullanimi.
- R12: Mobil oncelikli deneyimde 320-430px genislikte kritik akislarda (login, panel gecisi, filtreleme, form aksiyonu) kullanilabilirlik korunacak.
- R13: Mevcut smoke test kritik yolu kirilmadan guncellenecek; gerekli test-id/selector degisimleri kontrollu ve izlenebilir yapilacak.
- R14: Uretim hazirligi icin `@lease-bot/web` build ve smoke senaryosu yesil gecmeli.

## Success Metrics
- Kritik ekranlarda gorsel tutarlilik ve okunabilirlik artisi (tasarim review checklist pass).
- Theme persistence dogrulugu: yeniden giriste secili tema %100 korunur.
- Smoke test ve build basarisi: %100.
- Mobil kritik akislarda manual QA checklist pass.

## Constraints
- Mevcut monorepo, React 18, Vite, TanStack Router yapisi korunacak.
- Degisiklikler `apps/web` odakli olacak; API davranisi degismeyecek.
- Ekranlar shadcn uyumlu sade/minimal dilde kalacak (gereksiz animasyon veya asiri gorsel yuk yok).
