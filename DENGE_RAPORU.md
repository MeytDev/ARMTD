# ARMTD kampanya dengesi · 0.6.34

**Neo City ilk harita olduğu halde açılışta en az hata payını veriyor.** Xeno’da sıradan bir Archer konumu yaklaşık 10,79 kare yolu ateş altında tutuyor. Neo City’de bu değer 4,12. Yüksek kapsamalı konum, doğru yükseltme sırası ve kule sinerjileri aradaki açığın bir bölümünü kapatıyor. Sıfır yıldız yatırımıyla ilk haritanın 100. dalgasını üç farklı başlangıç dizisinde geçtik. Bundan sonraki tasarım sorusu, başka kule bileşimlerinin de o hedefe hangi bedelle ulaşabildiği.

## Haritanın verdiği zaman

| Birinci seviye Archer, menzil 3,90 | Neo City | Xeno | Elixir |
|---|---:|---:|---:|
| Yürünebilen rotanın uzunluğu, kare | 32 | 88 | 88 |
| İlk dalga Runner'ının boş haritayı geçişi, saniye | 24,62 | 67,69 | 67,69 |
| Yasal 1×1 kule yeri | 267 | 180 | 168 |
| Ortanca yerde menzilde kalan yol, kare | 4,12 | 10,79 | 10,77 |
| En iyi yerde menzilde kalan yol, kare | 13,35 | 22,98 | 19,54 |
| En iyi yerde tek Runner'a ateş edilebilen süre, saniye | 10,27 | 17,68 | 15,03 |
| Menzilden çıkan düşmanın tekrar girdiği yer sayısı | 13 | 103 | 81 |
| En iyi yerde aynı anda menzile girebilen ilk dalga Runner'ı | 8 | 14 | 12 |
| Yasal 2×2 Peel yeri | 200 | 27 | 19 |

Gerçek hareket rotasının her parçasını kulenin menzil dairesiyle kestik. Menzile yeniden girişleri ayrı saydık. Son satırdan önceki değer, 15 Runner'ın ilk dalgadaki gerçek çıkış aralığıyla, yavaşlatma veya ölüm yaşamadan yürüdüğü geometrik üst değerdir. Bir Archer aynı anda birincil hedef olarak tek düşmana ateş eder. Birden fazla aday, hedef değiştirme ve alan hasarı için fırsat yaratır.

Neo City'de Blizzard'ın ortanca yasal konumu ilk seviyede yolun hiçbir bölümüne erişemiyor. En iyi konumu ise 11,17 kareyi kapsıyor. Xeno ve Elixir aynı uzunlukta olsa da Archer ve Sniper farklı sayıda kareye erişiyor. Neo City'nin özel avantajı geniş 2×2 destek alanı. Hex Against Four'da tek bir 2×2 yer dahi yok. Yerleşim önizlemesi artık menzilde kalan yol parçalarını, Peel seçiliyken ilk desteği alabilecek müttefikleri gösteriyor. Büyük bir kule için yer kalmadığında dükkân seçiminde İngilizce açıklama çıkıyor.

Beş yerleşik harita kodunda giriş veya çekirdek karesi boş arazi görünüyordu. Yeni satın almalarda bu kareler korundu. Önceki sürümde buraya yerleştirilmiş kule, eski kayıt yüklenince konumunu ve yatırımını koruyor. WIP haritalarda tek bir tarama seed'iyle (41) aynı sinerji stratejisi Data Rush'ta 93/115, Hex Against Four'da 110/135 dalga temizledi. Diğer beş WIP haritasında hedefe ulaştı. Hex'te bot yer bulamadığı Peel adımını atlayıp kalan kulelerini kurdu. Bu yedi sonuç harita tasarım sorunlarını aramak için birer örnektir.

## Karar kalitesi ve yıldızlar

Temel deneyde her savunma 150 altın ve 25 Core HP ile sıfırdan başlar. Alışveriş sırasında oyuncuyla aynı yer, fiyat, seviye, prestij ve teklif kurallarını kullanır. Normal hızda 1/60 saniyelik simülasyon adımları işler. Otomatik oyuncu saniyede bir kez alışverişini değerlendirir. Dalga erken çağırma, satış, öğretici ödülü ve öğreticinin özel ilk teklifi bu karşılaştırmanın dışında. İlk beş eşlenmiş seed 17, 41, 97, 211 ve 503. Aynı başlangıç seed'i karşılaştırılabilir bir başlangıç verir. Farklı hedefler ve atış sayıları RNG akışını sonradan ayırır.

| Neo City, temizlenen son dalga | Nadirlik seviyesi 0, medyan | Nadirlik seviyesi 8, medyan |
|---|---:|---:|
| Karma kuleler, menzili yola ulaşan orta konum | 16 | 21 |
| Aynı alışveriş, en çok yolu gören konum | 31 | 34 |
| Sadece Archer, birden fazla kuleye yatırım | 41 | 61 |
| Önce ucuz alan hasarı, sonra önceden seçilmiş prestij eşikleri | 75 | 100 |

Aynı prestij stratejisi Xeno'da hem sıfır hem sekiz nadirlik seviyesinde beşer koşunun beşinde de 105'i geçti. Neo City'de sıfır yatırımdaki beş sonuç 37, 66, 75, 88 ve 91. Maksimum yıldız yatırımı, ilk haritaya yeni gelen oyuncuya açık olmadığı için ayrı bir geç oyun deneyi olarak değerlendirildi.

**Sıfır yıldızla kazanma yolu.** İkinci strateji, Archer prestijini birden fazla Archer ile değerlendiriyor, Breaker'a alan hasarı için yatırım yapıyor, bir Blizzard'ı en hızlı hedefe ve bir Poison'ı en az zehirli hedefe yönlendiriyor. Daha sonra Peel ve Mage birlikte çalışıyor. Gerçek ilk harita kampanyasını 10 seed'in 3'ünde tamamladı. Kazanan seed'ler 97, 211 ve 4093. Aynı strateji ve yıldız seviyesinde ilk beş ve ek beş seed'in sonuçları sırasıyla 2/5 ve 1/5. Örnekler, insan oyuncuların kazanma oranını tahmin etmek için toplanmadı.

**En önemli denge riski Core HP birikimi.** Bu üç zaferde 44, 245 ve 262 düşman çekirdeğe ulaştı. Canı yalnız simülatörde 50 ile sınırlandırıp aynı 10 oyunu tekrarladığımızda tek zafer kaldı. Seed 97 kazandı, 211 dalga 85'i, 4093 dalga 86'yı temizledikten sonra kaybetti. Üst sınırı oyuna almadık. Önce alternatif bir savunmanın daha az kaçakla kazanabildiğini göstermek gerekiyor. Peel'in başlangıç canını aşabildiği ve erken çağrının ödemeyi ne zamana ertelediği artık oyun içinde açıklanıyor.

**Roguelike teklifinin büyüklüğü.** Her kart kendi nadirliğini çeker. Üç karttan en az birinin Legendary veya Mythical olma olasılığı seviye 0'da %3,26, seviye 8'de %28,92. Her seviyenin tam dağılımı katalogda. 0 ve 8 için toplam 60.000 kart çekilerek dağılımlar ayrıca kontrol edildi. Seçilen kule, vuruş miktarı, hedef önceliği ve aktif beceriyi değiştirdiği için nadirlik tek başına savaş değerini açıklamaz. Archer'da %12, aynı düşmana tekrar isabette okun savunma öncesi hasarına eklenen adımdır. Magic, Power Shot üzerinden bu hasara etki edebilir. Yeni kule uzmanlığı tasarlarken aynı açıklıkla hangi istatistiğin hangi davranışı değiştirdiğini göstermeliyiz.

## Dalga baskısı ve ekonomi

| Dalga | Planlı düşman | Doğuşta toplam HP | Hepsi öldürülürse doğrudan altın |
|---|---:|---:|---:|
| 1 | 15 | 2.325 | 270 |
| 10 | 3 | 42.721 | 1.116 |
| 11 | 45 | 74.106 | 1.458 |
| 50 | 7 | 1.490.860 | 9.360 |
| 80 | 9 | 5.440.643 | 20.275 |
| 99 | 70 | 27.348.368 | 19.593 |
| 100 | 11 | 10.114.122 | 192.427 |
| 105 | 70 | 32.697.656 | 20.825 |
| 110 | 12 | 13.226.357 | 26.159 |
| 145 | 118 | 113.570.153 | 53.282 |

Tablo, seed 17 ile gerçek düşman üreticisinden gelen ilk kadrodur. Affix'ler dahil. Boss çağrıları, iyileşme, kaçaklar, kule gelirleri ve erken çağrı altını yalnız savaş koşularında ortaya çıkar. 99. dalganın delmesiz fiziksel hasar ihtiyacı 67,24 milyon, büyü hasarı ihtiyacı 34,29 milyon. Bunlar kule debuff'ları öncesindeki savunma farkını gösterir. 100. dalganın toplam HP'si daha düşük olsa da hasarı tek hedefte toplama ve boss döngüsüne yetişme şartları farklı. 100. dalga ödülü, ilk haritada final ödülü iken Xeno'da son beş dalgayı finanse ediyor. Bu ödülü değiştirmek iki haritada farklı sonuç verir.

Neo City'de ayrıca 50, 80 ve 100. dalgaları tek başına oynattık. Kurulum bütçesi önceki bütün planlı düşmanların potansiyel ödülü ve başlangıç altınıydı. Üçünde de çekirdek ayakta kaldı. 50 ve 80'de boss kaçtı. İlk dalgadan ilerleyen bir oyuncunun bu bütçeyi kazanması, hayatta kalması ve doğru anda harcaması ayrı bir sınav.

Erken dalga çağırmada iki kural düzeltildi. 105. dalgadan kalma bir Runner, 106. dalga sıraya girse bile çekirdeğe 1 vuruyor. 106. dalganın Runner'ı 5 vuruyor. Peel'de ise örneğin 9. dalgada bir, 10. dalgada iki kez biriken Uplink tek temizlemede üçü için de ödeme yapıyor. Her ödeme kendi dalgasının tarifesini kullanıyor. Kampanyadaki bütün haritalar 6. ve 8. dalganın özel dizilişleri dahil aynı düşman sırasını kullanıyor.

## Yedi kuleyi aynı yöntemle karşılaştırmak

Katalog her kule için 1–21. seviyelerde toplam yatırım, bir sonraki fiyat, AD, AS, menzil, Magic, kritik, mana ve delme değerlerini üretir. Ham seviye eğrisinde rastgele teklifler uygulanmaz. Savaş deneylerinde gerçek teklifler çekilir. Otomatik kule deneyi kayıtlı her kuleyi 9, 39, 79 ve 80. dalgalarda aynı seviye 5 Archer'ın yanına ekler. Sadece yardımcı Archer ile oynanan koşu her dalganın kontrolüdür. Deney çekirdeği dalga sonuna kadar dayanacak kadar yüksek tutulur. Bu, bir kitle kontrol veya destek kulesinin müttefiğine kazandırdığı zamanı da ölçmeye imkân verir.

| Kule | Toplam yatırım, seviye 5 | Toplam yatırım, seviye 21 | Özellikle izlenecek etki |
|---|---:|---:|---|
| Archer | 620 | 19.112 | Odak ve delici atış, başka Archer'lara prestij katkısı |
| Mage | 879 | 27.075 | Zincirin sıçradığı hedefler, prestij sonrası müttefik mana üretimi |
| Blizzard | 1.810 | 55.741 | Hızlı hedefleri tutma süresi, diğer kulelere sağlanan atış zamanı |
| Breaker | 2.068 | 63.701 | Zırh kırma, grup yoğunluğu ve prestij alan vuruşu |
| Poison | 2.585 | 79.632 | Zehrin hedefte kalabildiği süre ve dağıtım tercihi |
| Sniper | 15.511 | 477.786 | Uzun menzil, fazla hasar, zamanla güçlenme ve altın getirisi |
| Peel | 113.750 | 3.503.778 | İlk bağlantı için yer, buff süresi, Core HP ve ödeme |

Örneğin 39. dalgada seviye 10 Sniper ve yardımcı Archer 425.219 HP sildi, 15 düşmanı öldürdü. Seviye 10 Blizzard ve aynı yardımcı 196.183 HP sildi, bir düşmanı öldürdü. İki aday kulenin maliyeti 66.904 ve 7.806 altın. Yardımcı tek başına 15.332 HP sildi. Bu örnek, Sniper'ı sırf öldürme sayısına bakarak güçsüzleştirmenin neden kötü bir karar olacağını gösteriyor. Peel aynı deneyde 727 altın üretti. Buff saniyeleri aynı anda birden çok buff ve hedefi içerir.

Yeni bir kule tanımı dükkâna, istatistik sayaçlarına, Codex listesine, seviyelere göre fiyat ve stat dökümüne, harita ölçümüne ve bu dört karşılaşmaya otomatik girer. Özgün saldırısı ve uzmanlıkları kendi tasarımına göre yazılır. Strateji botlarına yeni kuleyle uyumlu bir alışveriş planı eklenince kampanya katkısı da ölçülebilir.

## Rakiplerden alınan tasarım kararları

- **Clash Royale.** Supercell, kullanım ve kazanma oranlarını oyun denemeleriyle birlikte değerlendirdiğini açıklıyor. Örneklerden birinde Zap değişikliğini Goblin'i tek vuruşta öldürme eşiği üzerinden tartışıyor. ARMTD için karşılığı, bir değişiklikten önce hangi düşmanın bir atış daha yaşayacağını, hangi kaçağın önleneceğini ve bunun kaça mal olduğunu yazmak. PvP kullanım oranını tek oyunculu TD'ye doğrudan aktarmak uygun olmaz. [Supercell’in denge notları](https://supercell.com/en/games/clashroyale/blog/release-notes/balance-changes-coming/)
- **Kingdom Rush.** Ironhide aynı harita için Campaign, Heroic ve Iron çözümlerini ayrı gösteriyor. ARMTD'de normal zafer, hasarsız zafer ve Sniper'sız zafer kendi başlarına ölçülmeli. Tek kazanma yüzdesi bu farklı hedefleri birleştirir. [Ironhide strateji rehberi](https://play.kingdomrush.com/kingdom-rush-strategy-guide)
- **Emberward.** Refic Games kule seçimiyle tetromino bloklardan rota kurmayı aynı savunma kararının parçaları yapıyor. Bizim sabit rotalarımızda oyuncunun değiştirebildiği şey ateş hattı. Yola girip çıkan menzilin yerleşim sırasında görünür olması bu yüzden önemli. [Geliştiricinin oyun tanıtımı](https://store.steampowered.com/app/2459550/Emberward/)

## Sunum, müzik ve doğrulama

Yenilgi ekranı ölümcül kaçağın dalgasını, türünü, kalan can yüzdesini ve çekirdeğe verdiği hasarı İngilizce gösteriyor. Ayrı bir tarayıcı kaydında Neo City açıldı, öğreticide Archer satın alındı, yükseltildi ve dalgalar erken çağrıldı. Son darbeyi %81 canla ulaşan 4. dalga Runner'ı vurdu. Daha ileri bir dalga sıradayken bile doğru kaynak gösterildi.

Müzik, menüde daha sakin bir tempo kullanıyor. Kampanyada yoğunluk artıyor, 70. dalgadan itibaren ek ritmik katman devreye giriyor, boss dalgasında alt bas geliyor. Çekirdek hasarı geçici ton değişimi istiyor. Duraklatılmış ses motorunda boss gelişinin yeni sesleri zamanlayabildiği yol düzeltildi. Menüde ses üretimi, duraklatmada sessizlik, boss alt bası, yeniden başlatma ve mute otomatik olarak kontrol edildi. Uzun bir koşuda melodik tekrar veya yorgunluk hissini değerlendirmek için kulaklık ve hoparlörle insan dinleme oturumu gerekiyor.

## Yeniden üretim

Sonuç dosyalarında 127 normal kampanya koşusu, 10 deneysel can sınırı koşusu, önceki dalgaların geliriyle finanse edilmiş 11 tek dalga ve 32 kule/kontrol karşılaşması var. Seed 97 ile Neo City zaferinde 4.935,5 saniyelik oyun bu makinede yaklaşık 11,3 saniyede hesaplandı. Bu tek ölçüm yaklaşık 437 kat hızlanmaya karşılık geliyor. Tarayıcı FPS'i için ayrı ölçüm gerekir.

Bağımlılık kurulumu gerekmiyor. Bu turda Node 24 kullanıldı. Aşağıdaki komutların tamamı proje kökünden çalışır. Daha kısa bir kıyas için son dalgayı `--until 20` ile sınırlandırabilirsiniz.

```powershell
node tools/balance.mjs --catalog-only --output tools/balance_catalog.json
node tools/balance.mjs --seeds 17,41,97,211,503 --stars 0,8 --probes --output tools/balance_baseline.json
node tools/balance.mjs --maps 1,2 --seeds 17,41,97,211,503 --stars 0,8 --policies breakpoints --output tools/balance_breakpoints.json
node tools/balance.mjs --maps 1 --seeds 17,41,97,211,503,809,1019,2711,4093,8111 --policies synergy --output tools/balance_synergy.json
node tools/balance.mjs --maps 1 --seeds 17,41,97,211,503,809,1019,2711,4093,8111 --policies synergy --experimental-core-cap 50 --output tools/balance_core_cap_trial.json
node tools/balance.mjs --maps 4,5,6,7,8,9,10 --seeds 41 --policies synergy --output tools/balance_wip.json
node tools/balance.mjs --maps 1 --seeds 17 --catalog-only --tower-trials --output tools/balance_towers.json
node tools/check_balance.mjs
node tools/audit_cases.mjs
node tools/check_phase2.mjs
node tools/check_syntax.mjs
```

`cleared` çekirdek hayattayken temizlenen son dalga, `wave` ulaşılan son dalgadır. Kontrol noktalarının dört sütunu dalga, Core HP, eldeki altın ve toplam öldürmedir. Nadirlik seviyesi 8, sekiz alışverişin tamamını ifade eder ve 50 kampanya yıldızı gerektirir. Yıldızlar kartların olasılıklarını değiştirir. Oyuncu bireysel bir koşuda istediği teklifin garantisini almaz.
