# ARMTD — Oyun ve Kod İncelemesi

7 Eylül 2026 · İnceleme başlangıç sürümü: 0.6.9 · uygulanan son patch: 0.6.33

## Sonuç ve kapsam

ARMTD'nin geliştirilmeye değer çekirdeği; farklı rollerde yedi kule, birbirini etkileyen destek sistemleri, harita editörü, hedef seçimi ve uyarlamalı müzik. Öncelik yeni içerikten önce savaşın tutarlılığı, kayıt güvenilirliği ve oyuncuya verilen bilginin doğruluğu olmalı.

İnceleme; savaş, dalgalar, kuleler, düşmanlar, mermiler, kayıt, ilerleme, harita, öğretici, arayüz ve ses modüllerinin statik incelemesini; tarayıcıda açılış, harita seçimi, kule satın alma, ilk dalgalar, duraklatma ve kaydet/devam et kontrollerini kapsıyor. Ayrıca 390×844 ekran yerleşimi denendi. Bütün haritalar baştan sona oynanmadı; kapsamlı FPS/GPU profili veya oyuncu çalışması yapılmadı. Performans risklerini ölçülmüş FPS sonucu olarak sunmuyorum.

**Kanıt türleri:** “Doğrulandı” mevcut fonksiyonların tanılama senaryosunda veya arayüzde çalıştırılmasıdır. “Kod bulgusu” ilgili akışın doğrudan incelenmesidir. “Tasarım yorumu” oyuncu testiyle değerlendirilmesi gereken öneridir. P1 önce düzeltilmeli, P2 sonraki geliştirme turu, P3 temizlik anlamındadır.

Mevcut sözdizimi kontrolü 26 dosyada ve yapısal kontrol 14/14 başarılıydı. İkincisi esasen kaynak metninde belirli ifadeleri arıyor; davranışsal doğruluk kanıtı değil. Tekrarlanabilir tanılama: `node tools/audit_cases.mjs`. Sonuçlar `tools/audit_results.json` içinde. Bu betik mevcut hataları gözlemleyen bir araçtır; “oyun hatasız” sonucunu veren bir test paketi değildir.

## 1. Programsal — Performans

1. **P1 — Simülasyon kare hızına bağımlı. Doğrulandı.** `Tower.update` atıştan sonra cooldown'u sıfırdan kuruyor; taşan süreyi kaybediyor ve kare başına en fazla bir atış yapıyor. Saniyede 20 atış ayarlı izole stres senaryosunda, 10 gerçek saniye ve 3× hızda 30 FPS için 300, 60 FPS için 600 atış çıktı. Bunlar gerçek cihaz FPS ölçümleri değil, farklı zaman adımları verilen fonksiyon deneyleri. Çözüm: sabit simülasyon adımı, süre biriktirme ve gerektiğinde bir adımda birden fazla atış. Kaynak: `game/towers.js:1196`, `game/game.js:4118`.

2. **P1 — Hareket ve spawn da süre kaybediyor. Doğrulandı/kod bulgusu.** Düşman bir yol düğümüne ulaşınca kalan hareket mesafesini kullanmıyor. Spawn, geciken karede yalnızca bir düşman oluşturup zamanlayıcıyı yeniden kuruyor. Aynı oyun süresinde düşman konumu değişebiliyor. Çözüm: kalan mesafeyi sonraki segmente taşı; spawn sayacına aralık ekle ve borcu kontrollü tüket. Kaynak: `game/enemies.js:471`, `game/game.js:2026`.

3. **P2 — Her karede gereksiz sabit iş var. Kod bulgusu.** Kuleler hareket etmese de spatial index yeniden kuruluyor; çizimde kule dizisi kopyalanıp sıralanıyor. Her resize kontrolü harita kataloğunu yeniden üreten WIP kontrolünü de çağırıyor. Kule indeksi ve çizim sırasını satın alma/satma sırasında; harita metadatasını harita değişiminde güncelle. Kaynak: `game/game.js:560`, `1312`, `2070`, `2833`.

4. **P2 — Statik harita yeniden çiziliyor. Kod bulgusu.** Arka plan, yaklaşık 300 hücre ve ızgara çizgileri her karede işleniyor. Bunları harita/ölçek değişiminde önceden çizilmiş bir yüzeyde tut. Menüde ve sabit duraklatma ekranında sürekli tam savaş alanı çizimini azalt. Kaynak: `game/game.js:2642`, `4118`.

5. **P2 — HUD ve öğretici fazla DOM işi yapıyor. Kod bulgusu.** HUD 12 Hz'e indirilmiş; bu iyi. Fakat seçili panel hâlâ büyük `innerHTML` bloklarıyla yeniden kuruluyor. Öğretici ayrı animation loop içinde ölçüm ve stil yazımı yapıyor; bekleyen adım ararken adım tanımlarını yeniden üretiyor. Statik paneli bir kez oluştur, yalnızca değişen değerleri yaz; öğretici geometri ölçümlerini resize/hedef değişimine bağla. Kaynak: `game/game.js:3504`, `game/tutorial.js:882`, `913`, `954`.

6. **P2 — Etki yoğunluğunun üst sınırı yok. Kod bulgusu.** Pooling mevcut ve yararlı; ancak havuz kapasitesi aktif parçacık sayısını sınırlamıyor. Breaker toplu saldırıları, zincirler, zehir bildirimleri, gölgeler ve gradientler beraber pahalı olabilir. Hasar yazılarını düşman başına birleştir, görsel efekt bütçesi ve düşük efekt seçeneği ekle. Önce p95/p99 kare süresi ölç. Kaynak: `game/towers.js:1365`, `1380`, `game/projectiles.js:523`, `game/game.js:2642`.

7. **P2 — Spatial index her saldırı türünde kullanılmıyor. Kod bulgusu.** Mage zincirleri, Breaker cleave ve Peel hedef seçiminde tam dizi taramaları var. Önce hedeflenen stres sahnesinde maliyetlerini ölç; anlamlı olanları mevcut indeks üzerinden geçir. Sabit kule konumlarından yararlanarak Peel komşuluk bilgisini önceden hesapla. Kaynak: `game/towers.js:1038`, `1365`, `1439`.

8. **P2 — FPS göstergesi ve menü yükü iyileştirildi. ◐** FPS hesabı gerçek geçen `elapsed` süresini kullanıyor; menü açıkken kule/düşman simülasyonu ve kapalı canvas çizimi artık çalışmıyor. Full-screen blur/transform kaldırıldı; canvas yerleşim ölçümü yalnızca resize/harita boyutu değişiminde yapılıyor. Ayrıntılı sampler'daki `frame/p95/p99` artık gerçek render-frame aralığını, `js` ise yalnızca JavaScript callback maliyetini raporluyor. Tek sekmeli canlı IAB hızlı gözleminde ana menü yaklaşık 56–61 FPS, Settings 27–31 FPS ve Map Select 34–35 FPS gösterdi; erişilebilirlik/screenshot çağrıları ölçümü etkileyebildiği için bunlar baseline değildir. Menü sayfalarında kalan adaylar compositor'daki `backdrop-filter`, çoklu gradient/box-shadow ve büyük patch-notes/map-card DOM'udur. Referans cihaz p95/p99/bellek baseline ölçümü hâlâ ayrıca yapılmalı. Kaynak: `game/game.js`, `styles.css`, `tools/phase1_perf_baseline.md`.

## 2. Açıklar — Buglar ve suistimal edilebilir davranışlar

1. **P1 — Aktif savaş kaydı tam snapshot değil. ◐** Dalga 1 sürerken dalga 2 çağrıldığında kayıt artık en erken güvenli dalga checkpoint'ini (1) seçiyor; böylece eski dalga atlanmıyor. Ancak düşmanlar, aktif dalga listesi, mermiler ve efektler kayıt verisine yazılmadığı için yükleme dalga başlangıcına geri dönüyor ve o andaki savaş durumu kayboluyor. Kalan seçenek: eksiksiz savaş snapshot'ı veya yalnızca tamamen temizlenmiş dalgalar arasında checkpoint. Kaynak: `game/game.js` kayıt/snapshot akışı.

2. **P1 — Zehirden ölen düşman üsse de vurabiliyor. Doğrulandı.** DOT ölümünden sonra `Enemy.update` hareket bölümüne devam ediyor. Çıkış yakınında aynı düşman hem `dead` hem `reachedExit` oldu; Core 25→24 ve Gold 150→168. Ölüm sonrası fonksiyondan çıkılmalı; ölüm/kaçış birbirini dışlayan durumlar olmalı. Kaynak: `game/enemies.js:471`, `game/game.js:2073`.

3. **P1 — Başlangıç kurtarma sistemi kayıt silebiliyor. Kod bulgusu.** Boot watchdog ikinci başarısız açılışta kayıt, yıldızlar ve istatistik anahtarlarını siliyor. Yavaş modül yüklenmesi de başarısız açılış sayılabilir. Ayrıca sürüm reset anahtarı yoksa `main.js` ilk açılışta veri siliyor. Önce hata ekranı ve yedekleme; veri sıfırlama ayrı, açık bir kullanıcı işlemi olmalı. Kaynak: `index.html:519`, `game/main.js:300`.

4. **P1 — Zehir prestige etkisi oyun hızına göre değişiyor. Doğrulandı.** Mermi oyun zamanıyla hareket ediyor; tekrar vuruş aralığı `performance.now()` ile gerçek zamana bağlı. Aynı üç saniyelik simülasyon için sabit menzil deneyinde 1× hızda 36, 3× hızda 12 tekrar oluştu. Tüm savaş etkileri aynı simülasyon saatini kullanmalı. Kaynak: `game/projectiles.js:445`, `game/towers.js:1380`.

5. **P1 — Öğretici bazı haritalarda çıkmaza girebilir. Kod + harita testi.** Archer için `(7,5)`, Mage için `(8,5)` zorunlu; öğretici harita türüyle sınırlı değil. Xeno'da iki hücre de inşa edilemez; başka haritalarda da engeller var. Öğretici sıfırlanıp bu haritada açılırsa veya benzer bir özel haritada başlanırsa zorunlu yerleştirme yapılamaz. Ayrı öğretici haritası veya geçerli dinamik konum seçimi kullan. Kaynak: `game/tutorial.js:6`, `339`, `557`.

6. **P2 — Sol/üst kenardaki Core koordinatı bozuluyor. Doğrulandı.** `exit.x || w-1` ve `exit.y || h-1`, geçerli sıfır koordinatını yok sayıyor. `(0,0)` hedefi 4×4 testte `(3,3)` oldu. `??` ve açık sayı doğrulaması kullan. Kaynak: `game/map.js`, `GameMap.constructor`.

7. **P2 — Cleanse köklenmeyi temizlemiyor. Doğrulandı.** Frostbite temizleniyor, `rootTime` 3 saniye kalıyor. Durum etkilerini tek bir temizleme politikası üzerinden kaldır. Kaynak: `game/enemies.js:352`, `689`.

8. **P2 — Altın bonusu Restart sonrasında kalıyor. Doğrulandı.** `nextWaveNowGoldBuff` constructor/load sırasında sıfırlanıyor, `restart` içinde sıfırlanmıyor. İzole testte 4×/10 saniyelik bonus yeni koşuya taşındı. Yeni koşu durumunu tek factory fonksiyonuyla oluştur. Kaynak: `game/game.js:1946`.

9. **P2 — Peel hedef yokken her kare bildirim üretiyor. Doğrulandı.** Prestige sesi/yazısı uygun hedef kontrolünden önce; hedef yoksa mana tüketilmiyor. Tek prestige Peel ile bir saniyede 60 bildirim oluştu. Hedefi önce kontrol et, başarısız denemeye geri bekleme koy. Kaynak: `game/towers.js:1301`.

10. **P2 — Blizzard becerisinde Magic çarpanı iki kez uygulanıyor. Kod bulgusu.** `magicPower(this)` zaten perk ve Peel Magic çarpanını içeriyor; Frost Pulse tekrar aynı çarpanlarla çarpılıyor. Gösterilen açıklama aynı hesabı kullanmıyor. Hasar çözümü ve önizleme tek fonksiyondan çıkmalı. Kaynak: `game/towers.js:48`, `1439` içindeki `basePulseMagic` hesabı.

11. **P2 — Test araçları yayın kodunda, fakat artık login akışı yok. ◐** Dev araçları altın, HP, dalga ve hız değiştiriyor; görünür olmaları yalnızca açık `?devtools=1` geliştirme bayrağına bağlı. Settings içindeki `admin/admin` istemci login'i kaldırıldı. Bu tek oyunculu yerel oyunda bir sunucu ele geçirme açığı değildir; fakat ilerleme/rekabet doğruluğu sağlamaz. Yayın derlemesinde dev araçlarını tamamen ayırmak ve sandbox koşularını ilerlemeden izole etmek hâlâ önerilir. Gelecekte çevrimiçi skor varsa sunucu doğrulaması gerekir. Kaynak: `game/devtools.js`, `game/main.js`, `game/ui.js`.

12. **P2/P3 — Bozuk kayıt ve aşırı sayısal değer sınırları zayıf. Kod bulgusu + sınır testi.** Magic penetrasyonu MR'yi 6000 aştığında formülde tekillik, daha fazla aştığında negatif hasar oluşabiliyor. Normal dengeli oyunda erişildiği gösterilmedi; yüklenen aşırı değerler için doğrulandı. Kayıttan gelen özel yükseltme başlıkları HTML olarak yazılıyor; mevcut akışta bunun uzaktan sömürüldüğünü gösteren kayıt paylaşma yolu bulunmadı. Yüklenen veriyi şemayla sınırla, metni `textContent` ile yaz; savunma hesabını negatif bölgede güvenli tanımla. Kaynak: `game/damage.js`, `game/game.js:1010`, `3826`.

## 3. Tasarımsal — Game design ve programming design

1. **P1 — Oyun kimliği netleştirildi. ◐** İlk kampanya haritası 100 dalga sürer. Sonraki haritaların hedefleri 105, 110 ve devamında +5 olarak onaylandı. Kampanya zaferinden sonra oyuncu Endless'a geçebilir. Kalıcı ilerleme ve rastgele yükseltme ekonomisinin iki mod arasındaki dengesi sonraki turun konusu.

2. **P1 — Kampanya süresi ve karar yoğunluğu 100 dalga tabanıyla yeniden çerçevelendi. ◐** İlk harita 100 dalga; Map 2/3 için mevcut registry hedefleri 105/110. Uzunluğu yalnızca sayı artışı taşımaması için mevcut boss/affix/destek karşılaşmaları 20 dalgalık karar blokları olarak ölçülecek; ara boss ve seçim araları içerik turunda eklenebilir.

3. **P1 — Harita denge baseline'ı genişletildi. ◐** Her kampanya haritası için rota uzunluğu, yerleşilebilir/engel hücre sayısı, hedef dalga, her temel kule için en iyi menzil kapsaması ve hedef dalganın rastgele affix'siz HP/altın bütçesi otomatik ölçülür. Kapsama, ateş altında kalma süresinin karşılaştırılabilir vekilidir; sayıların karşılaştırmalı denge kararı sonraki turdadır.

4. **P1 — Kule yükseltmeleri daha anlamlı seçenekler sunmalı.** Mevcut special seçenekleri çoğunlukla AD/AS/MAG yüzdesi. Bunlara davranış değiştiren, bedeli olan yollar ekle: Archer delici atış veya hızlı tek hedef; Blizzard güçlü yavaşlatma veya kırılganlık; Poison uzun süreli DOT veya kontrollü patlatma. Rastgelelik stratejiyi tamamen geçersiz kılmamalı.

5. **P1 — Mage Prestige rol değişimi görünür. ✓** Seviye 20'deki son yükseltme artık `Prestige` olarak etiketlenir ve satın alma öncesi Mage'in normal saldırıyı kalıcı olarak bırakıp Mana aura desteğine geçeceğini açıkça bildirir. İleride saldıran/support uzmanlıklarını iki ayrı yol yapmak daha derin bir tasarım alternatifi olarak kalır.

6. **P2 — Destek ve ekonomi bileşimi ölçülebilir hale getirildi. ◐** Run istatistikleri Peel buff olay/sürelerini ve Sniper Carepackage altınını kaydediyor. Tam 100 dalgalık çoklu seed karşılaştırması ve azalan getiri ayarı sonraki denge testinin girdisidir.

7. **P1 — Öğretici akışı kısaltıldı. ✓** İlk kampanya haritası artık yalnızca “yerleştir → başlat → yükselt” akışını zorunlu tutar. İstatistik, düşman ve beceri ayrıntıları Seçili panel ve Codex'te isteğe bağlıdır; sonraki ve özel haritalar öğreticiyi çalıştırmaz.

8. **P1 — Mobil yerleşim yeniden düzenlendi. ✓** 390×844 düzeninde savaş alanı üstte; seçili kule/log orta bölümde; dalga ve mağaza kontrolleri altta akıyor. Masaüstü kontrast iyileştirmesi ve gerçek cihaz doğrulaması ayrıca izlenebilir.

9. **P1 — Mimari sınırlar kademeli ayrıştırıldı. ◐** Content registry, progression, event bus, UI adapter, spatial index ve persistence sınırları aktif; `game.js`/`main.js` içindeki renderer ve DOM orkestrasyonu henüz tamamen ayrılmadı. Phase 2 smoke testi 14/14 kontrolü koruyor.

10. **P1 — Test ve tekrar üretilebilirlik seed akışıyla iyileştirildi. ◐** Gameplay rastgeleliği seed’li RNG akışını kullanıyor; seed/state run save içine taşınıyor ve `startFreshRun({ seed })` ile tekrar üretilebilir koşu başlatılabiliyor. Ses ve custom-map kimliklerindeki kozmetik rastgelelik ayrı kanala taşınacak.

## 4. Anlamsızlıklar — Çelişkiler ve boşa çalışan sistemler

1. **P1 — Erişilemeyen yükseltme. ✓ Düzeltildi.** Nadirlik seviye 8 için maliyetler `1+1+2+3+5+8+13+21=54`; mevcut on haritanın beşer yıldızı toplam 50. Son maliyet 17 olarak düzenlendi; sekiz seviye artık tam `50` yıldız tutuyor. Regresyon testi toplam maliyetin kampanya ödülünü aşmamasını doğrular. Kaynak: `game/main.js`, `tools/audit_cases.mjs`.

2. **P1 — 105→106 dalga geçişi süreklileştirildi. ✓** Kapasite büyürken overcap katsayısının 3.1→1 sıfırlanması kaldırıldı; taşan düşman bütçesi her dalganın etkin kapasitesine göre hesaplanıyor. Regresyon testi 106. dalganın 105'in normal-düşman HP'sinde büyük düşüş yaratmamasını ve artışın kontrollü kalmasını doğrular.

3. **P2 — İlk dalga temposu clamp'te kaybolmuyor. ✓** Erken dalga çarpanları dinamik clamp sınırları içinde korunuyor; dalga 1–10 için ayrı aralıklar ve ek 1–3 kolaylaştırması regresyon testinde doğrulanıyor. Kaynak: `game/waves.js`, `tools/audit_cases.mjs`.

4. **P2 — Açıklamalar gerçek becerileri anlatmıyor. ✓ Düzeltildi.** Archer açıklaması 12 saniye/4×; uygulama 16.2 saniye/5.2×. Peel açıklaması bir hedef; kod en fazla iki prestige hedefini yükseltiyor. Siphon açıklaması prestige mana azaltıyor diyor; uygulama bunu yapmıyor. Süre, aura ve Carepackage açıklamaları artık ilgili hesap yardımcılarından veya etkin mekanik değerlerden üretiliyor. Kaynak: `game/towers.js`, `game/game.js`.

5. **P2 — “First” hedefleme düzeltildi. ✓** First modu her atışta menzildeki en ilerideki düşmanı yeniden seçiyor; hedef kilidi diğer modların mevcut davranışı olarak korunuyor. Aynı segment içindeki hassas ilerleme için yol metriği sonraki denge turunda iyileştirilebilir. Kaynak: `game/towers.js`.

6. **P2 — Patch notes ödülü öğretici tamamlamaya bağlandı. ✓** Patch notları artık ödül vermez; ilk haritanın üç adımlı öğreticisi tamamlandığında tek seferlik Starting Gold +30 açılır. Kaynak: `game/main.js`, `game/tutorial.js`.

7. **P2 — Bazı “ayarlar” etkin kural değil. ◐** Kullanılmayan `PRESTIGE_UPGRADE_COST_FLAT` ve erişilemeyen `wave===100 && !isBigBoss` dalı kaldırıldı. Eski tier/ekonomi değerlerinin tek kataloğa taşınması sonraki mimari turda sürüyor.

8. **P2 — Sürüm ve süre bilgisi tek kaynaklı hale getirildi. ✓** Paket ve oyun sürümü aynı patch değerini taşıyor; aktif süre `simTime` olarak kaydedilip yükleniyor ve Continue bunu sıfırlamıyor. Kaynak: `package.json`, `game/game.js`.

9. **P2 — Hasar istatistikleri ayrıştırıldı. ✓** `takeDamage` artık gerçek HP kaybını ve overkill'i ayrı kaydediyor; kule paneli `real / overkill / kills` gösteriyor. DOT kaynakları gerçek hasar üzerinden yazılıyor; destek buff olay/süre ve Carepackage altın telemetrisi de run istatistiklerine eklendi. Kaynak: `game/enemies.js`, `game/game.js`, `game/towers.js`.

## Benzer oyunlardan alınabilecek dersler

| Referans | Kaynakta görülen yaklaşım | ARMTD için önerim |
|---|---|---|
| Bloons TD 6 | Kule başına üç yükseltme yolu, farklı yetenekler; challenge/odyssey oluşturup paylaşma | Yedi kuleyi daha çok yüzdeden ziyade farklı oynanış yollarıyla derinleştir; mevcut editöre kural/seed paylaşımı ekle |
| Kingdom Rush | Aynı bölümler için Campaign, Heroic ve Iron çeşitleri | Beş yıldızın bazılarını koşu öncesinde seçilen, kuralları açık challenge modlarına dönüştür |
| Rogue Tower | Oyuncunun etkilediği genişleyen rota, rastgele kartlar ve arazi yüksekliğinin önemi | Ayrı roguelite modunda rota kararı, kontrollü kart seçimi ve yerleşim fırsat maliyeti dene |

Bunlar birebir kopyalama önerileri değil; mevcut sisteme uyarlama yorumlarıdır. Kaynaklar: [Ninja Kiwi'nin BTD6 sayfası](https://store.steampowered.com/app/960090/Bloons_TD_6/), [Ironhide strateji rehberi](https://play.kingdomrush.com/kingdom-rush-strategy-guide), [Rogue Tower geliştirici açıklaması](https://store.steampowered.com/app/1843760/Rogue_Tower/).

**Oyunun ayırt edici yönü olarak destek ağını seçerdim.** Cyberpunk tema içinde kuleler arası enerji/bant genişliği paylaşımı; menzil, bağlantı sayısı ve aşırı yük riski üzerinden oyuncuya yerleşim kararı sunabilir. Peel bir geç oyun istatistik çarpanı yerine erişilebilir ağ düğümü olur. Bu yeni bir tasarım önerisidir ve önce üç kule/tek harita prototipinde sınanmalıdır.

## Baştan yazsaydım

### Coding ve program tasarımı

Tarayıcı odağını koruyarak **TypeScript + bağımsız simülasyon + PixiJS çizimi + HTML/CSS menü/HUD** seçerdim. TypeScript veri sözleşmelerini açıklaştırır; kayıt/import verisi için ayrıca çalışma zamanı doğrulaması gerekir. PixiJS sahne grafiği ve çizim birleştirme altyapısı sağlar; sabit adımlı simülasyonu yine ayrıca kurarım. Motor değiştirmek tek başına mevcut bugları çözmez. [TypeScript dokümantasyonu](https://www.typescriptlang.org/docs/handbook/2/everyday-types.html), [PixiJS çizim döngüsü](https://pixijs.com/8.x/guides/concepts/render-loop).

```text
src/
  simulation/   state, clock, commands, combat, targeting, status, waves
  content/      towers, enemies, maps, upgrades, balance
  rendering/    scene, sprites, effects, quality
  ui/           menu, hud, inspector, tutorial, accessibility
  persistence/  schemas, migrations, snapshots, backups
  progression/  rewards, unlocks, challenges
  audio/        music, effects
tests/          combat, save-roundtrip, maps, timing, smoke
```

Temel sözleşme: UI bir `BuildTower`/`UpgradeTower` komutu gönderir; simülasyon para, konum ve durum kurallarını doğrular, state'i değiştirir, sonuç olayı üretir. Renderer ve ses yalnızca sonuçları tüketir. Böylece UI veya admin aynı kuralları atlayamaz; simülasyon DOM olmadan test edilebilir.

Başlangıçta 60 Hz sabit adım; 3× hız üç kat simülasyon zamanı işler. Gecikmeler için kontrollü adım bütçesi ve açık yavaşlama politikası olur. Savaş zamanı, gerçek UI zamanı ve ses zamanı ayrı tutulur. Kare sonunda ölüm/ödül/kaçış sonuçları tek kez işlenir. Çapraz tarayıcı deterministik replay hedeflenirse sayısal toleranslar ayrıca tasarlanır.

Kayıt; sürüm, seed/RNG durumu, simülasyon saati, kuleler, düşmanlar, aktif dalgalar, etkiler ve bekleyen mekanik işleri kapsar. Kapatılamayan JavaScript callback'leri yerine veri olarak saklanabilen planlanmış olaylar kullanılır. Önceki sağlam kayıt yedekte tutulur. Bir kayıt/yükleme turu, kesintisiz koşuyla aynı sonucu vermelidir.

Tam ECS, çok iş parçacığı veya sunucuyu ilk günden kurmam. Ölçüm simülasyon darboğazını gösterirse Worker; rekabet/ortak oyun istenirse sunucu doğrulaması eklerim. İlk hedef basit, açık ve test edilebilir sınırlar.

### Gameplay ve görsel tasarım

- İlk sürüm: üç tamamlanmış harita, yedi kule, her kuleye iki belirgin uzmanlık ve 100 dalgalık kampanya.
- İlk beş dalga temel kararları öğretir; sonraki gruplar zırh, sürü, hız ve destek düşmanlarını anlaşılır kombinasyonlarla tanıtır.
- Bosslar yalnızca yüksek HP olmaz: önceden görülen saldırı/temizleme döngüsü, müdahale penceresi ve karşı strateji sunar.
- Dalga öncesi düşman kompozisyonu, dirençler ve özel tehlike gösterilir. Erken çağırma ödülü sınırlı, açık ve dalga kimliğine bağlı olur.
- Bütün koşuyu durduran dört ayrı kule milestone'u yerine daha az fakat daha güçlü uzmanlık kararı; toplu basit yükseltme korunur.
- Kalıcı ilerleme yeni seçenek ve kozmetik açar; ana kampanya zorunlu güç grind'ına dayanmaz. Endless büyümesi ayrı dengelenir.
- HUD önce para, üs, dalga, seçili kulenin rolü ve yükseltme sonucunu gösterir. Ayrıntılı formüller açılır paneldedir. Dokunmatik kontrol, klavye erişimi ve azaltılmış hareket modu baştan tasarlanır.
- Sonuç ekranı “hangi düşman kaçtı, savunma nerede yetersizdi, gerçek hasar/slow/destek katkısı neydi?” sorularını cevaplar.

## Uygulama sırası ve başarı ölçütleri

| Aşama | İş | Tamamlanma ölçütü |
|---|---|---|
| 1 — Doğruluk ◐ | Kayıt atlama, veri silme, DOT/kaçış, zaman farkları, reset, Cleanse, harita sıfır koordinatı | Tekrarlanabilir bug senaryoları düzeltme sonrası davranış testine dönüşür; tam aktif-savaş snapshot'ı ayrıca tamamlanır |
| 2 — Anlaşılabilirlik ✓ | Beceri açıklamaları, yıldız ekonomisi, kısa öğretici, mobil HUD | Oyuncu yardım almadan yerleştirir/başlatır/yükseltir; bütün ödüller erişilebilir |
| 3 — Denge ◐ | Üç harita, kule uzmanlıkları, boss ritmi ve ekonomi sınırları | Aynı seed'lerde farklı makul dizilimlerin kazanma oranı ve kaçan düşman dağılımı karşılaştırılır |
| 4 — Performans ◐ | Statik çizim cache'i, DOM fark güncellemeleri, efekt bütçesi, menü idle yükü | Tanımlı referans cihazda normal/yoğun sahnede p95/p99 kare süresi ve bellek eğrisi ölçülür |
| 5 — İçerik | Yeni haritalar, roguelite mod, paylaşılabilir challenge | Önceki testler korunur; her yeni içerik mevcut denge eğrisine karşı sınanır |

Mevcut projeyi hemen tamamen değiştirmek yerine bir harita ve birkaç kulelik yeni çekirdeği yanında kurup kıyaslardım. Yeni çekirdek kayıt, zaman ve test koşullarını sağladığında içerik aşamalı taşınır. Böylece eldeki oynanabilir sürüm kaybedilmez.

### Uygulama durumu — 0.6.30

İlk doğruluk turundaki tekrarlanabilir düzeltmeler tamamlandı; aktif savaş kaydının tam düşman/mermi/efekt snapshot'ı hâlâ sonraki adımdır. Performans aşamasında sabit zamanlı simülasyon, statik harita cache’i, kule/düşman spatial-index kullanımının genişletilmesi, seçili HUD panel imzası, öğretici step/geometri cache’i ve görsel efekt bütçeleri uygulanmış durumda. Ayarlar menüsüne kalıcı Reduced Effects seçeneği eklendi; bu seçenek yalnızca geçici görselleri azaltır, savaş simülasyonunu değiştirmez. Continue artık simülasyon saatini de taşıyor; kazanma süresi kayıt yüklemesinden sonra sıfırlanmıyor. Mobil kırılımda savaş alanı üstte, seçili kule/log orta bölümde, dalga/mağaza kontrolleri altta akacak şekilde yeniden düzenlendi. Her turdan sonra `node tools/check_syntax.mjs` ve `node tools/audit_cases.mjs` çalıştırılıyor; bu kontroller davranış regresyonlarını yakalamak için temel kapı olarak kullanılmalı.

Tamamlanan işaretler:

- ✓ Sabit zamanlı simülasyon, FPS bağımsız hareket/atış/spawn ve simülasyon saatli Continue kaydı.
- ✓ Kayıt yedekleme/doğrulama, DOT/kaçış, Cleanse, Restart bonusu, sıfır koordinatlı Core ve Peel hedef kontrolü.
- ✓ Dinamik harita öğreticisi, HUD/tutorial cache’leri, statik harita cache’i, spatial-index saldırı sorguları ve efekt bütçeleri.
- ✓ Settings’te kalıcı Reduced Effects seçeneği ve 390 px sınıfı mobil yerleşim kırılımı; işletim sisteminin reduced-motion tercihi etkin olduğunda arayüz bunu `ON (System)` olarak açıkça gösterir.
- ✓ FPS sayacı ana menü ve oyun içinde görünür; ayrıntılı p95/p99 sampler’ı `window.__armtdPerf = true` ile ayrıca çalışır.
- ✓ Prestige açıklamaları gerçek süre, çarpan, hedef sayısı ve Carepackage dalga formülüyle eşleşir.
- ✓ Rarity Upgrade 8. seviye, on haritanın kazanılabilir 50 yıldızıyla erişilebilir.
- ✓ İlk kampanya haritasında üç adımlı (yerleştir → başlat → yükselt) öğretici; sonraki ve özel haritalarda öğretici yok.
- ✓ Endless geçişinde 105→106 dalga baskısı süreklidir; dinamik düşman kapasitesi overcap hesabında kullanılır.
- ✓ Mage'in 20→21 Prestige yükseltmesi, kalıcı saldırı kaybını ve Mana aura rolünü satın almadan önce gösterir.
- ◐ Harita denge baseline'ı rota, yerleşim alanı, engel, hedef dalga, kule menzil kapsaması ve sabit HP/altın bütçesini üretir; karşılaştırmalı ayar kararı sonraki adımdır.
- ✓ Ana menü açıkken savaş simülasyonu durur; FPS ölçümü gerçek geçen render süresini kullanır.
- ✓ First hedef modu her atışta en ilerideki geçerli düşmanı yeniden seçer; diğer modların hedef kilidi korunur.
- ✓ Starting Gold +30 ödülü patch-notes tıklamasından çıkarıldı ve ilk harita öğreticisi tamamlanmasına bağlandı.
- ✓ Gerçek hasar/overkill ayrımı, destek buff süresi/olayları ve Carepackage altın telemetrisi.
- ◐ Seed’li gameplay RNG ve save içi RNG durumu; kozmetik RNG ayrıştırması sonraki temizlikte.
- ✓ Tutorial scripted Special Upgrade yalnızca Tutorial ayarı açıkken ilk haritadaki Archer milestone’ına sınırlandı; sonraki special upgrade’ler normal Star/RNG olasılıklarını kullanır.
- ✓ Settings içindeki Login/Admin kartı ve istemci tarafı `admin/admin` giriş akışı kaldırıldı; dev panel yalnızca açık `devtools=1` geliştirme bayrağıyla görünür.
- ✓ Menü sayfalarında pahalı wrap blur/transform ve örtülü canvas redraw kaldırıldı; tutorial scheduler menüde RAF çalıştırmıyor.
- ✓ Canvas `getBoundingClientRect()`/layout ölçümü render başına değil, resize veya harita boyutu değişiminde çalışıyor.
- ✓ Kampanya hedefleri onaylandı. İlk üç harita sırasıyla 100, 105 ve 110 dalga sürer.
- ✓ Render FPS'i artık seeded combat RNG akışını tüketmez; ekran sarsıntısı ayrı, görsel rastgelelik kullanır.
- ✓ Savaş alanı okunabilirliği: giriş/Core işaretleri, seçili kule hedef bağlantısı, Core'a yaklaşan düşman alarmı ve eşikli düşman HP/boss göstergeleri eklendi; savaş sayıları değişmez.
- ✓ Saldırı okunabilirliği: kule-renkli yönlü atış flash’ları, türlere özgü düşman siluetleri, vuruş animasyonlu/crit vurgulu damage sayıları ve stack + etkin DPS gösteren Poison rozeti eklendi; bunların tamamı görsel katmandadır ve Reduced Effects ile azalır.
- ◐ Referans cihazda 20–30 saniyelik p95/p99/bellek baseline ölçümü henüz yapılmadı.

### Aşama 3 — Taktik kararlar (0.6.31–0.6.33)

1. ✓ **Dalgayı okumak.** Oyun paneli sıradaki dalganın çıkış sırasını, her grubun sayısını ve varsa dalga direncini gerçek dalga planından gösterir. Neo City'de 6. dalgaya tanklar öncülük eder. 8. dalgada tank kolunun önünde ve arkasında birer Runner grubu vardır. Aynı düşman bütçesiyle hedef önceliği ve kule konumunun etkisini karşılaştırmak için ilk iki karşılaşma bunlar.
2. ✓ **Archer'a görev vermek.** 5. seviyeden itibaren kule panelinde kalıcı bir uzmanlık seçilebilir. Delici atış ana hedefin arkasındaki 2,5 karede en fazla iki düşmana daha %55 hasar verir. Tek hedef uzmanlığında aynı düşmana peş peşe isabetler %12 adımlarla güçlenir ve altıncı isabette +%60'a ulaşır. Uzmanlık seçimi yıldızlara bağlı Special Upgrade çekilişinden bağımsızdır.
3. ✓ **Boss'a hazırlanmak.** 10. dalganın boss'u doğduktan 6 oyun saniyesi sonra Cleanse kullanır. 4 saniye sonra 2 düşman çağırır ve 5 saniye boyunca %35 fazla hasar alır. Döngü tekrarlanır. Sıra 9. dalgada panelde görünür. Savaş sırasında boss etiketi evreyi, dalga paneli kalan süreyi gösterir.
4. ☐ **100 dalgaya yaymak.** İlk on dalgada işe yarayan kararları haritanın sonraki bölümlerinde destek düşmanları, direnç ve kule sinerjileriyle birleştir. İlerleme ölçütü aynı seed'de iki farklı savunmanın hangi grupları geçirdiği ve nerede Core hasarı aldığıdır.

## Başlatıcı ve yapılan değişiklikler

Klasörde **OYUNU_BASLAT.cmd** dosyasına çift tıkla. Node.js kullanarak `http://127.0.0.1:5500/` adresinde sunucu açar ve varsayılan tarayıcıyı başlatır. VS Code Live Server gerekmez. Bu bir yerel HTTP sunucusudur; otomatik yeniden yükleme özelliği yoktur, dosya değişiminden sonra F5 kullanılır. Pencereyi kapatmak veya Ctrl+C sunucuyu durdurur.

Node PATH'te yoksa bu bilgisayardaki Codex Node konumu denenir. Başka bilgisayarda Node.js LTS kurulumu gerekebilir. Port doluysa başka servisi sonlandırmaz; açıklayıcı hata gösterir. Kayıtlar tarayıcı ve origin'e bağlıdır: eski `localhost` veya farklı porttaki kayıtlar yeni `127.0.0.1:5500` adresinde görünmeyebilir; bu aktarım yapılmadı.

Bu rapor ilk inceleme snapshot’ı olarak korunuyor; uygulama değişiklikleri 0.6.30 patch notlarında ve kaynak dosyalarda izlenebilir. Eklenenler: başlatıcı, `tools/start-game.ps1`, `tools/serve.mjs`, tanılama betiği/JSON çıktısı ve bu rapor. Sunucunun HTML/JS/görsel yanıtları, HEAD, bulunamayan dosya, gizli yol/traversal reddi ve port çakışması kontrol edildi. Tarayıcıda oyun açıldı; varsayılan harici tarayıcı açma dalı ayrıca çalıştırılmadı.
