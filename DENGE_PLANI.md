# ARMTD kampanya denge planı

İlk referans Neo City. Harita sıralamasını zorluk etiketi olarak kullanmıyoruz. Ortak dalgalarla aynı bütçeyi ve aynı karar politikasını oynatıp farkın nereden geldiğini ölçüyoruz. Kampanya hedefleri 100, 105 ve 110. Aşağıdaki her satır sonraki bir çalışma için de tek başına prompt olarak kullanılabilir.

| Sıra | Çalışma promptu | Teslim ve karar ölçütü |
|---|---|---|
| 1 | Mevcut çalışan sürümü yedekle ve GitHub'da işaretle. | Açılabilen kaynak arşivi ve geri dönülebilir commit. |
| 2 | Rakiplerin kule rolleri, yerleşim ve dengeleme kararlarını birincil kaynaklardan incele. | ARMTD'ye aktarılabilecek kararlar ve sınırları. |
| 3 | Her haritanın gerçek yürüyüş rotasını ve her kule için yasal konumlarını çıkar. | Yol uzunluğu, menzildeki mesafe, tekrar giriş, aynı anda erişilebilen düşman, destek alanı. |
| 4 | Dalga üretimini bütün haritalarda karşılaştır. | Aynı dalga için sıra, adet, çıkış aralığı ve boss aynı. |
| 5 | Oyunu görüntüsüz, sabit zaman adımı ve tekrarlanabilir rastgelelikle çalıştır. | Gerçek savaş, ekonomi, kaçak ve satın alma kurallarıyla çalışan komut. |
| 6 | Aynı satın alma kararlarını farklı yerleşimlerle oynat. | Aynı seed'lerde harita ve karar kalitesinin ayrı ayrı etkisi. |
| 7 | İlk dalgadan son kampanya dalgasına kadar baskı ve gelir tablosunu çıkar. | Her dalgada HP, savunma, adet, hız, ödül, çıkış aralığı ve boss katkısı. |
| 8 | En büyük baskı sıçramalarını ve son dalgalardaki başarısızlıkları araştır. | Gerçek ekonomiyle ulaşılabilen bölümler ile izole geç oyun deneyleri ayrı. |
| 9 | Yıldız yatırımının teklif kalitesi ve oyun sonucuna etkisini ölç. | Eşlenmiş koşular, nadirlik olasılıkları, tutorial teklifinin kapsamı. |
| 10 | Kule rolleri, yeni kule ekleme yolu ve tek tipe yatırım stratejisini denetle. | Yerleşim, hasar, destek ve harcanan altınla açıklanan sonuçlar. |
| 11 | Oyuncunun tehditleri görüp duyabildiğini, boss zamanlamasını ve müzik geçişlerini kontrol et. | Oyun içi İngilizce açıklama, olay geçiş testi, insanla doğrulanacak algı soruları. |
| 12 | Ölçüme dayanan değişiklikleri aynı deneylerle yeniden çalıştır ve yayınla. | Tekrarlanabilir sonuç dosyası, regresyon kontrolleri, GitHub sürümü ve açık kalan deneyler. |

## İlk turun durumu

- ✓ **1–4.** Sürüm 0.6.33 yedeklendi. Üç rakip incelendi. On haritada gerçek rota, yedi kulenin yerleşimi ve ortak dalga üretimi kontrol edildi.
- ✓ **5–7.** Görüntüsüz savaş motoru, alışveriş politikaları ve 1–145. dalgaların sayı dökümü çalışıyor. Yeni kuleler, kayıtlı tanımlarından otomatik olarak sayısal karşılaştırmaya giriyor.
- ✓ **8–10.** 100. dalga sıfır yıldız yatırımıyla başlangıçtan geçildi. Yıldız seviyeleri ve kule bileşimleri karşılaştırıldı. Yedi kulenin her biri müttefikli kontrol senaryosunda denendi. Çekirdek canını sınırlayan bir alternatif ölçüldü.
- ✓ **11–12.** Yerleşim ve yenilgi geri bildirimi, erken çağrılan dalgaların ekonomisi ve müzikteki duraklatma davranışı güncellendi. Testler ve yeniden üretim komutları rapora eklendi.

### Bir sonraki turda karar verilecek sırayla

1. **İkinci bir sıfır yıldız stratejisi bul.** Peel kullanmadan veya can biriktirmeye daha az dayanan bir savunmayla ilk haritanın finalini dene. Önceden ayrılmış yeni seed'lerle, kaçan düşman ve kalan can dağılımlarını karşılaştır.
2. **İlk yenilginin ne öğrettiğini ölç.** Yeni oyuncuya aynı haritada iki deneme ver. İkinci denemede konumu, hedef önceliğini veya yükseltme zamanını değiştirdi mi, ilk kaçağı kaç dalga erteledi? Sonucu simülasyonla karşılaştır.
3. **Ortak uzmanlık kuralını ikinci kuleyle doğrula.** İki gerçekten farklı görev sunan bir kule seç. Stat ölçeklerini ve fırsat maliyetini İngilizce seçim metninde göster. Özel teklif RNG'si ile uzmanlık seçimi ayrı kalmalı.
4. **Sekizinci haritanın rolünü kararlaştır.** Peel'siz etap tasarımı isteniyorsa harita seçiminde belirt. Bütün kulelerin kullanılacağı bir etap isteniyorsa 2×2 alan sağlayan ikinci tasarımın rotasını ve savaş sonuçlarını aynı seed ile karşılaştır.
5. **Ses ve görsel okunabilirliği insanla doğrula.** İlk boss'un zayıflık penceresini ses kapalıyken ve açıkken ne zaman fark ettiklerini ölç. Aynı deneyi kısa rota üzerinde yoğun bir geç dalgada tekrarla.
