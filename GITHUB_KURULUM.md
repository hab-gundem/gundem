# GitHub Kurulum Rehberi

Bu rehber, Gündem uygulamasını GitHub'a kurmak için **senin** yapacağın adımları anlatır.
Bilgisayardaki işleri (dosyaları gönderme vb.) Claude yapacak; o adımlar ayrıca işaretli.

Sonunda elinde şunlar olacak:
- Telefonda açılan bir adres: `ORGANIZASYON-ADI.github.io/gundem`
- Her sabah 06:00'da kendiliğinden güncellenen bir gündem (bilgisayarın kapalı olsa bile)

Toplam süre: yaklaşık 15-20 dakika.

---

## 1. Organizasyon aç (sen, bir kez)

Organizasyon, ana hesabının altında ama kendi adı olan ücretsiz bir alan. Uygulamanın adresinde
ana hesabının adı değil, organizasyonun adı görünür.

1. github.com'a **ana hesabınla** giriş yap.
2. Sağ üstteki **+** işaretine tıkla → **New organization**.
3. **Free** planı seç (**Create a free organization**).
4. Formu doldur:
   - **Organization name:** Takma bir ad seç, örn. `takmaad-gundem`. Bu ad adreste görünecek.
     Küçük harf ve tire kullan; Türkçe karakter kullanma.
   - **Contact email:** Gmail adresin olabilir. Herkese gösterilmez.
   - **This organization belongs to:** **My personal account** seç.
5. Bulmaca çıkarsa çöz, şartları onayla → **Next**.
6. "Add organization members" ekranında kimseyi ekleme → **Complete setup** (ya da **Skip**).

### Üyeliğinin gizli olduğunu kontrol et
1. Organizasyon sayfasında **People** sekmesine gir.
2. Kendi adının yanında **Private** yazmalı. **Public** yazıyorsa tıklayıp **Private** yap.

---

## 2. E-posta gizliliğini aç (sen, bir kez)

1. Sağ üstte profil resmin → **Settings** → soldan **Emails**.
2. **Keep my email addresses private** kutusunu işaretle.
3. **Block command line pushes that expose my email** kutusunu da işaretle.

---

## 3. Boş depo oluştur (sen)

1. Sağ üstteki **+** → **New repository**.
2. **Owner:** listeden **organizasyonunu** seç (ana hesabını değil!).
3. **Repository name:** `gundem`
4. **Public** seç.
5. Aşağıdaki kutuların **hiçbirini işaretleme** (README, .gitignore, license yok). Depo boş olmalı.
6. **Create repository**.

👉 **Claude'a organizasyonun adını yaz.**

---

## 4. Dosyaları gönder (Claude)

Claude bilgisayarda depoyu hazırlayıp dosyaları gönderecek. Göndermeden önce sana soracak.

- İlk gönderimde bir **GitHub giriş penceresi** açılır. **Ana hesabınla** giriş yap ve izin ver.
- Gönderilmeyenler: `yedek/` klasörü ve `KARARLAR.md` (kişisel notların).

---

## 5. Yayını aç: GitHub Pages (sen)

1. Depo sayfasında (`github.com/ORGANIZASYON-ADI/gundem`) **Settings** sekmesine gir.
2. Soldan **Pages**.
3. **Source:** **Deploy from a branch**
4. **Branch:** `main` seç, yanındaki klasörü **/docs** yap → **Save**.
5. 1-2 dakika bekle, sayfayı yenile. Üstte şu yazı çıkar:
   **"Your site is live at https://ORGANIZASYON-ADI.github.io/gundem/"**

---

## 6. Otomatik görevin yazma iznini kontrol et (sen)

1. Depoda **Settings** → soldan **Actions** → **General**.
2. En alttaki **Workflow permissions** bölümünde **Read and write permissions** seçili olsun → **Save**.

---

## 7. İlk güncellemeyi elle çalıştır (sen)

Sabahı beklemeden denemek için:

1. Depoda **Actions** sekmesine gir.
   (Otomatik görevleri açmak için onay isterse **I understand my workflows, go ahead and enable them**.)
2. Soldan **Gündem** görevini seç → sağda **Run workflow** → **Run workflow**.
3. 5-6 dakika sürer. Yeşil ✓ çıkarsa tamam. Kırmızı ✗ çıkarsa Claude'a söyle.

Bundan sonra her sabah 06:00 civarında kendiliğinden çalışır.
(GitHub bazen 10-30 dakika gecikmeyle başlatabilir, normaldir.)

---

## 8. Telefona kur (sen)

1. Telefonda **Chrome** ile `https://ORGANIZASYON-ADI.github.io/gundem/` adresini aç.
2. Sağ üstteki **⋮** menüsü → **Ana ekrana ekle** (ya da **Uygulamayı yükle**).
3. Ana ekranda **Gündem** simgesi çıkar. Normal bir uygulama gibi açılır.

GitHub uygulaması ya da telefonda GitHub hesabına giriş **gerekmez**.

---

## Sonrası: spor seçimlerini değiştirmek

Bilgisayardan ya da telefondan (Chrome ile):

1. `github.com/ORGANIZASYON-ADI/gundem` → `tarayici` klasörü → `spor_secimleri.json`
2. Sağ üstteki **kalem** simgesi (Edit).
3. Değişikliği yap. Dosyanın başında her alanın ne işe yaradığı yazıyor.
4. **Commit changes** → tekrar **Commit changes**.
5. Değişiklik ertesi sabahki gündemde görünür. Hemen görmek istersen 7. adımdaki gibi elle çalıştır.

---

## Bilmen gerekenler

- **Ne açık, ne gizli?** Kod, günlük haber derlemesi ve spor seçimlerin herkes tarafından görülebilir.
  Okuduğun konular, yıldızların ve tekrar sonuçların **sadece telefonunda** kalır.
- **Organizasyonun sana ait olduğu ne kadar gizli?** Üyelik listesi gizlidir; organizasyon sayfasına
  bakan biri seni göremez. Ama ilk gönderimi ana hesabın yaptığı için, GitHub'ın etkinlik kayıtlarını
  bilerek inceleyen biri bağlantıyı bulabilir. Günlük güncellemeleri ise GitHub'ın kendi robotu yapar,
  onlarda adın geçmez.
- **İki adımlı doğrulama:** GitHub bir süre sonra isteyebilir. Telefon numarası şart değil;
  Google Authenticator gibi bir doğrulama uygulaması yeterli.
- **Bir şey ters giderse:** Actions sekmesindeki kırmızı ✗'e tıklayıp ekran görüntüsünü ya da
  hata yazısını Claude'a göster.
