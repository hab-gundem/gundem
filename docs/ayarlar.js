// Ayarlar ekranı (#/ayarlar): tarayici/ayarlar.json dosyasını GitHub API üzerinden okur ve yazar.
// Okuma herkese açık depodan anahtarsız yapılır; yazmak için kullanıcının oluşturduğu
// ince ayarlı (fine-grained) GitHub anahtarı gerekir. Anahtar yalnızca bu cihazda saklanır.
// Kayıtlar "hab-gundem" adıyla yapılır; kullanıcının hesap adı kayıtlarda görünmez.
// app.js'den önce yüklenir; esc, $icerik, $baslik çizim anında app.js'den gelir.

const GH_DEPO = 'hab-gundem/gundem';
const GH_DOSYA = 'tarayici/ayarlar.json';
const GH_GOREV = 'gundem.yml';
const GH_KIMLIK = { name: 'hab-gundem', email: 'hab-gundem@users.noreply.github.com' };
const ANAHTAR_DEPOSU = 'gundem.anahtar';
const ANAHTAR_BILGISI = 'gundem.anahtar.bilgi'; // {ad, tarih}: ekranda gösterilir, anahtarın kendisi gösterilmez
const SINIRLAR = {
  gundem_konu_sayisi: [1, 20, 10],
  genel_spor_konu_sayisi: [0, 15, 6],
  tercih_konu_sayisi: [0, 10, 4],
  gun: [1, 30, 3],
  adet: [1, 10, 4],
};

// {veri, sha, yukleniyor, hata, mesaj: {tur, metin}, kaydediliyor, degisti, yenile}
// duzenlenen: düzenleme alanı açık olan seçimin sırası (yoksa null); duzenlenenKaynak: aynısı tercih kaynakları için
// anahtarAcik: anahtar düzenleme alanı
const ayar = { veri: null, sha: null, yukleniyor: false, hata: null, mesaj: null,
  kaydediliyor: false, degisti: false, yenile: true, duzenlenen: null, duzenlenenKaynak: null, anahtarAcik: false };

function anahtarOku() {
  try { return localStorage.getItem(ANAHTAR_DEPOSU) || ''; } catch (e) { return ''; }
}

function anahtarBilgisi() {
  try { return JSON.parse(localStorage.getItem(ANAHTAR_BILGISI)) || {}; } catch (e) { return {}; }
}

// deger boşsa anahtar ve bilgisi silinir; deger null ise anahtar korunur, sadece adı değişir
function anahtarYaz(deger, ad = '') {
  try {
    if (deger === '') {
      localStorage.removeItem(ANAHTAR_DEPOSU);
      localStorage.removeItem(ANAHTAR_BILGISI);
      return true;
    }
    const bilgi = anahtarBilgisi();
    if (deger !== null) {
      localStorage.setItem(ANAHTAR_DEPOSU, deger);
      bilgi.tarih = new Date().toISOString();
    }
    bilgi.ad = ad;
    localStorage.setItem(ANAHTAR_BILGISI, JSON.stringify(bilgi));
    return true;
  } catch (e) { return false; }
}

// ---------- GitHub API ----------

function base64Coz(b64) {
  const ikili = atob(b64.replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(ikili, c => c.charCodeAt(0)));
}

function base64Yap(metin) {
  const baytlar = new TextEncoder().encode(metin);
  let ikili = '';
  for (let i = 0; i < baytlar.length; i += 0x8000) ikili += String.fromCharCode(...baytlar.subarray(i, i + 0x8000));
  return btoa(ikili);
}

async function ghIstek(yol, secenek = {}) {
  const anahtar = anahtarOku();
  const yanit = await fetch(`https://api.github.com/repos/${GH_DEPO}/${yol}`, {
    ...secenek,
    cache: 'no-store',
    headers: {
      Accept: 'application/vnd.github+json',
      ...(anahtar ? { Authorization: `Bearer ${anahtar}` } : {}),
      ...(secenek.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  if (!yanit.ok) {
    const hata = new Error(`HTTP ${yanit.status}`);
    hata.durum = yanit.status;
    throw hata;
  }
  return yanit.status === 204 ? null : yanit.json();
}

function ghHataMetni(e, yazma) {
  if (!e.durum) return 'GitHub\'a ulaşılamadı. İnternet bağlantını kontrol et.';
  if (e.durum === 401) return 'Anahtar geçersiz ya da süresi dolmuş. Yeni bir anahtar oluşturup aşağıya yapıştır.';
  if (yazma && (e.durum === 403 || e.durum === 404)) {
    return 'Anahtarın bu depoya yazma izni yok. Anahtarda depo olarak "gundem" ve "Contents: Read and write" seçili mi? '
      + 'Organizasyon onayı bekliyor olabilir (yardıma bak).';
  }
  if (e.durum === 403) return 'GitHub şu an çok fazla istek aldığını söylüyor. Biraz sonra tekrar dene.';
  if (e.durum === 409) return 'Ayarlar bu arada başka yerden değişmiş. Son hâli yüklendi; değişikliğini tekrar yapıp kaydet.';
  return `GitHub hatası (${e.message}).`;
}

async function ayarlariYukle() {
  ayar.yukleniyor = true;
  ayar.hata = null;
  ayarCizGerekirse();
  try {
    const dosya = await ghIstek(`contents/${GH_DOSYA}?ref=main`);
    ayar.veri = JSON.parse(base64Coz(dosya.content));
    if (!Array.isArray(ayar.veri.spor_secimleri)) ayar.veri.spor_secimleri = [];
    if (!Array.isArray(ayar.veri.tercih_kaynaklar)) ayar.veri.tercih_kaynaklar = [];
    ayar.sha = dosya.sha;
    ayar.degisti = false;
  } catch (e) {
    ayar.hata = e instanceof SyntaxError ? 'Ayar dosyası bozuk (JSON okunamadı).' : ghHataMetni(e, false);
  }
  ayar.yukleniyor = false;
  ayarCizGerekirse();
}

// ---------- doğrulama ----------

function sinirla(deger, [enAz, enCok]) {
  if (deger === null || deger === undefined || String(deger).trim() === '') return null;
  const n = Number(deger);
  return Number.isInteger(n) && n >= enAz && n <= enCok ? n : null;
}

function ayarHatalari(v) {
  const hatalar = [];
  for (const alan of ['gundem_konu_sayisi', 'genel_spor_konu_sayisi']) {
    const [enAz, enCok] = SINIRLAR[alan];
    if (sinirla(v[alan], SINIRLAR[alan]) === null) {
      hatalar.push(`${alan === 'gundem_konu_sayisi' ? 'Gündem' : 'Genel spor'} konu sayısı ${enAz} ile ${enCok} arasında bir tam sayı olmalı.`);
    }
  }
  const tercih = v.tercih_konu_sayisi;
  if (tercih !== undefined && tercih !== '' && sinirla(tercih, SINIRLAR.tercih_konu_sayisi) === null) {
    hatalar.push(`Tercih kaynaklarından gelen konu sayısı ${SINIRLAR.tercih_konu_sayisi[0]} ile ${SINIRLAR.tercih_konu_sayisi[1]} arasında olmalı.`);
  }
  v.tercih_kaynaklar.forEach((k, i) => {
    if (!(k.site || '').trim()) hatalar.push(`${i + 1}. kaynak: site boş olamaz (ör. birgun.net).`);
  });
  const adlar = new Set();
  v.spor_secimleri.forEach((s, i) => {
    const ad = (s.ad || '').trim();
    const sira = `${i + 1}. seçim`;
    if (!ad) hatalar.push(`${sira}: ad boş olamaz.`);
    else if (adlar.has(ad.toLocaleLowerCase('tr'))) hatalar.push(`${sira}: "${ad}" adı iki kez kullanılmış.`);
    adlar.add(ad.toLocaleLowerCase('tr'));
    for (const alan of ['gun', 'adet']) {
      if (s[alan] !== undefined && s[alan] !== '' && sinirla(s[alan], SINIRLAR[alan]) === null) {
        hatalar.push(`${sira}: ${alan === 'gun' ? 'gün' : 'konu sayısı'} ${SINIRLAR[alan][0]} ile ${SINIRLAR[alan][1]} arasında olmalı.`);
      }
    }
  });
  return hatalar;
}

// Formdan gelen değerleri dosyaya yazılacak hâle getirir (boş alanlar dosyadan çıkar).
function temizHal(v) {
  const kopya = JSON.parse(JSON.stringify(v));
  kopya.gundem_konu_sayisi = Number(kopya.gundem_konu_sayisi);
  kopya.genel_spor_konu_sayisi = Number(kopya.genel_spor_konu_sayisi);
  if (kopya.tercih_konu_sayisi === undefined || kopya.tercih_konu_sayisi === '') delete kopya.tercih_konu_sayisi;
  else kopya.tercih_konu_sayisi = Number(kopya.tercih_konu_sayisi);
  kopya.tercih_kaynaklar = kopya.tercih_kaynaklar.map(k => ({
    ad: (k.ad || '').trim(),
    site: k.site.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, ''),
    ...((k.kose || '').trim()
      ? { kose: k.kose.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '') } : {}),
  }));
  kopya.spor_secimleri = kopya.spor_secimleri.map(s => {
    const t = { ...s, ad: s.ad.trim(), dal: (s.dal || '').trim() };
    if ((t.arama || '').trim()) t.arama = t.arama.trim(); else delete t.arama;
    const baslikta = (Array.isArray(t.baslikta) ? t.baslikta : String(t.baslikta || '').split(','))
      .map(b => b.trim()).filter(Boolean);
    if (baslikta.length) t.baslikta = baslikta; else delete t.baslikta;
    for (const alan of ['gun', 'adet']) {
      if (t[alan] === undefined || t[alan] === '') delete t[alan]; else t[alan] = Number(t[alan]);
    }
    return t;
  });
  return kopya;
}

// ---------- kaydetme ----------

async function ayarlariKaydet() {
  const hatalar = ayarHatalari(ayar.veri);
  if (hatalar.length) {
    ayar.mesaj = { tur: 'kotu', metin: hatalar.join('<br>') };
    ayarCizGerekirse();
    return;
  }
  if (!anahtarOku()) {
    ayar.mesaj = { tur: 'kotu', metin: 'Kaydetmek için önce aşağıdaki "GitHub anahtarı" bölümüne anahtarını yapıştır.' };
    ayarCizGerekirse();
    return;
  }
  ayar.kaydediliyor = true;
  ayar.mesaj = null;
  ayarCizGerekirse();
  const yeni = temizHal(ayar.veri);
  try {
    const sonuc = await ghIstek(`contents/${GH_DOSYA}`, {
      method: 'PUT',
      body: JSON.stringify({
        message: 'Ayarlar: uygulamadan güncellendi',
        content: base64Yap(JSON.stringify(yeni, null, 2) + '\n'),
        sha: ayar.sha,
        branch: 'main',
        committer: GH_KIMLIK,
        author: GH_KIMLIK,
      }),
    });
    ayar.veri = yeni;
    ayar.sha = sonuc.content.sha;
    ayar.degisti = false;
    let metin = 'Kaydedildi. Değişiklik yarın sabahki gündemde görünecek.';
    if (ayar.yenile) {
      try {
        await ghIstek(`actions/workflows/${GH_GOREV}/dispatches`, { method: 'POST', body: JSON.stringify({ ref: 'main' }) });
        metin = 'Kaydedildi. Gündem şimdi yeniden toplanıyor; 5-10 dakika sonra uygulamayı kapatıp açınca yeni hâli görünür.';
      } catch (e) {
        metin = 'Kaydedildi, ama gündem hemen yenilenemedi (anahtarda "Actions: Read and write" izni yok olabilir). '
          + 'Değişiklik yarın sabahki gündemde görünecek.';
      }
    }
    ayar.mesaj = { tur: 'iyi', metin };
  } catch (e) {
    ayar.mesaj = { tur: 'kotu', metin: ghHataMetni(e, true) };
    if (e.durum === 409) await ayarlariYukle();
  }
  ayar.kaydediliyor = false;
  ayarCizGerekirse();
}

// ---------- çizim ----------

const ayarSayfasindaMi = () => location.hash.startsWith('#/ayarlar');
function ayarCizGerekirse() { if (ayarSayfasindaMi()) ayarlarCiz(); }

function sayiAlani(etiket, alan, deger, aciklama, sinir, i) {
  const veri = i === undefined ? '' : ` data-i="${i}"`;
  return `<label class="alan alan-sayi"><span>${etiket}</span>
    <input type="number" inputmode="numeric" min="${sinir[0]}" max="${sinir[1]}" placeholder="${sinir[2]}"
      value="${esc(deger ?? '')}" data-alan="${alan}"${veri}>
    ${aciklama ? `<small>${aciklama}</small>` : ''}</label>`;
}

function metinAlani(etiket, alan, deger, aciklama, i, yerTutucu = '', liste = '') {
  return `<label class="alan"><span>${etiket}</span>
    <input type="text" value="${esc(deger ?? '')}" data-alan="${alan}" data-i="${i}" placeholder="${esc(yerTutucu)}"
      ${liste ? `data-liste="${liste}"` : ''}
      autocapitalize="off" autocomplete="off" spellcheck="false">
    ${aciklama ? `<small>${aciklama}</small>` : ''}</label>`;
}

// Seçimler liste olarak görünür; ✎ ile o seçimin düzenleme alanı açılır
function secimKarti(s, i, toplam) {
  const baslikta = Array.isArray(s.baslikta) ? s.baslikta.join(', ') : (s.baslikta || '');
  const acik = ayar.duzenlenen === i;
  return `<li>
    <div class="ayar-satiri">
      <span class="ad"><b>${i + 1}. ${esc(s.ad || 'Yeni seçim')}</b>${s.dal ? `<small>${esc(s.dal)}</small>` : ''}</span>
      <span class="secim-dugmeleri">
        <button type="button" data-ayar="yukari" data-i="${i}" ${i === 0 ? 'disabled' : ''} aria-label="Yukarı taşı">↑</button>
        <button type="button" data-ayar="asagi" data-i="${i}" ${i === toplam - 1 ? 'disabled' : ''} aria-label="Aşağı taşı">↓</button>
        <button type="button" data-ayar="duzenle" data-i="${i}" class="kalem-dugme" aria-expanded="${acik}" aria-label="Düzenle">✎</button>
      </span>
    </div>
    ${acik ? `<div class="duzen-alani">
    ${metinAlani('Ad', 'ad', s.ad, 'Spor sekmesinde başlık olarak görünür.', i, 'ör. Takım adı')}
    ${metinAlani('Dal', 'dal', s.dal, 'Adın yanındaki açıklama (isteğe bağlı).', i, 'ör. Futbol')}
    ${metinAlani('Arama ifadesi', 'arama', s.arama,
      'Google Haberler\'de aranır. Boşsa ad aranır. "tırnak" tam ifade arar, -kelime o kelimeyi dışarıda bırakır, OR seçenek ekler.', i)}
    ${metinAlani('Başlıkta geçmeli', 'baslikta', baslikta,
      'Virgülle ayır. Haber başlığında bunlardan biri yoksa haber elenir. Boşsa ad kullanılır.', i)}
    <div class="alan-satiri">
      ${sayiAlani('Kaç günlük', 'gun', s.gun, '', SINIRLAR.gun, i)}
      ${sayiAlani('En fazla konu', 'adet', s.adet, '', SINIRLAR.adet, i)}
    </div>
    <div class="dugmeler">
      <button type="button" class="dugme kotu" data-ayar="sil" data-i="${i}">Sil</button>
      <button type="button" class="dugme" data-ayar="duzenle" data-i="${i}">Kapat</button>
    </div>
    </div>` : ''}
  </li>`;
}

// Tercih edilen kaynaklar: haberleri öne çıkacak yayınlar (ad + site)
function kaynakKarti(k, i) {
  const acik = ayar.duzenlenenKaynak === i;
  return `<li>
    <div class="ayar-satiri">
      <span class="ad"><b>${esc(k.ad || k.site || 'Yeni kaynak')}</b>${k.site ? `<small>${esc(k.site)}</small>` : ''}</span>
      <span class="secim-dugmeleri">
        <button type="button" data-ayar="kaynak-duzenle" data-i="${i}" class="kalem-dugme" aria-expanded="${acik}" aria-label="Düzenle">✎</button>
      </span>
    </div>
    ${acik ? `<div class="duzen-alani">
    ${metinAlani('Ad', 'ad', k.ad, 'Yayının adı.', i, 'ör. BirGün', 'tercih_kaynaklar')}
    ${metinAlani('Site', 'site', k.site, 'Sitenin adresi. Haberler bu sitede aranır.', i, 'ör. birgun.net', 'tercih_kaynaklar')}
    ${metinAlani('Köşe yazıları adresi', 'kose', k.kose, 'İsteğe bağlı. Konu bu adreste aranır, ilgili köşe yazıları konuda görünür.', i, 'ör. t24.com.tr/yazarlar', 'tercih_kaynaklar')}
    <div class="dugmeler">
      <button type="button" class="dugme kotu" data-ayar="kaynak-sil" data-i="${i}">Sil</button>
      <button type="button" class="dugme" data-ayar="kaynak-duzenle" data-i="${i}">Kapat</button>
    </div>
    </div>` : ''}
  </li>`;
}

function anahtarBolumu() {
  const kayitli = !!anahtarOku();
  const bilgi = anahtarBilgisi();
  const acik = ayar.anahtarAcik || !kayitli;
  const durum = kayitli
    ? `<b>✓ ${esc(bilgi.ad || 'adsız')}</b>${bilgi.tarih ? `<small>Kaydedildi: ${esc(tarihYaz(bilgi.tarih))}</small>` : ''}`
    : '<b>Anahtar yok</b><small>Kaydetmek için bir kez anahtar oluşturup buraya yapıştırman gerekiyor.</small>';
  return `<section class="bolum"><h3>GitHub anahtarı</h3>
    <ul class="ayar-liste"><li>
    <div class="ayar-satiri">
      <span class="ad anahtar-durumu ${kayitli ? 'iyi' : ''}">${durum}</span>
      ${kayitli ? `<span class="secim-dugmeleri"><button type="button" data-ayar="anahtar-duzenle" class="kalem-dugme"
        aria-expanded="${acik}" aria-label="Düzenle">✎</button></span>` : ''}
    </div>
    ${acik ? `<div class="duzen-alani">
      <label class="alan"><span>Anahtarın adı</span>
        <input type="text" id="anahtar-adi" value="${esc(bilgi.ad || '')}" placeholder="ör. gundem-ayarlar" autocomplete="off" spellcheck="false">
        <small>Kendin hatırlaman için; GitHub'da verdiğin adı yazabilirsin.</small></label>
      <label class="alan"><span>${kayitli ? 'Yeni anahtar (sadece değiştireceksen)' : 'Anahtar'}</span>
        <input type="password" id="anahtar-girisi" placeholder="github_pat_…" autocomplete="off" spellcheck="false"></label>
      <div class="dugmeler">
        <button type="button" class="dugme ana" data-ayar="anahtar-kaydet">Anahtarı kaydet</button>
        ${kayitli ? '<button type="button" class="dugme kotu" data-ayar="anahtar-sil">Anahtarı sil</button>' : ''}
      </div>
      <details class="yardim"${kayitli ? '' : ' open'}><summary>Anahtar nasıl oluşturulur?</summary>
        <p>Telefonda yaparsan kopyala-yapıştır kolay olur. <strong>Ana hesabınla</strong> giriş yapmış olmalısın.</p>
        <ol>
          <li><a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">Bu bağlantıyı aç</a> (GitHub → Settings → Developer settings → Fine-grained tokens → Generate new token).</li>
          <li><b>Token name:</b> <code>gundem-ayarlar</code></li>
          <li><b>Resource owner:</b> <code>hab-gundem</code> seç (kendi hesabını değil).</li>
          <li><b>Expiration:</b> en uzun süreyi seç. Süresi dolunca yenisini oluşturup buraya yapıştırırsın.</li>
          <li><b>Repository access:</b> <i>Only select repositories</i> → <code>gundem</code>.</li>
          <li><b>Permissions → Repository permissions:</b> <i>Contents</i> → <b>Read and write</b>, <i>Actions</i> → <b>Read and write</b>.</li>
          <li><b>Generate token</b>. Çıkan <code>github_pat_…</code> ile başlayan anahtarı kopyala; bir daha gösterilmez.</li>
          <li>Buradaki kutuya yapıştır → <b>Anahtarı kaydet</b>.</li>
        </ol>
        <p>Kaydederken "yazma izni yok" hatası alırsan organizasyon anahtarı onaylamanı bekliyor olabilir:
          <a href="https://github.com/organizations/hab-gundem/settings/personal-access-token-requests" target="_blank" rel="noopener">onay sayfası</a>
          → anahtarı seç → <b>Approve</b>.</p>
        <p>Anahtar yalnızca bu telefonda saklanır ve sadece <code>gundem</code> deposuna yazabilir.
          Telefonunu kaybedersen GitHub → Settings → Developer settings → Fine-grained tokens'tan silebilirsin.</p>
      </details>
    </div>` : ''}
    </li></ul>
  </section>`;
}

function ayarlarCiz() {
  $baslik.textContent = 'Ayarlar';
  const mesaj = ayar.mesaj ? `<div class="ayar-mesaji ${ayar.mesaj.tur}" role="status">${ayar.mesaj.metin}</div>` : '';
  if (!ayar.veri) {
    $icerik.innerHTML = ayar.hata
      ? `<div class="bos">Ayarlar yüklenemedi.<br><small>${esc(ayar.hata)}</small><br><br>
          <button type="button" class="dugme" data-ayar="yeniden-yukle">Tekrar dene</button></div>${mesaj}${anahtarBolumu()}`
      : '<div class="bos">Ayarlar yükleniyor…</div>';
    if (!ayar.yukleniyor && !ayar.hata) ayarlariYukle();
    return;
  }
  const v = ayar.veri;
  $icerik.innerHTML = `
    <section class="bolum ilk"><h3>Konu sayıları</h3>
      <div class="ayar-karti alan-satiri">
        ${sayiAlani('Gündem', 'gundem_konu_sayisi', v.gundem_konu_sayisi, `${SINIRLAR.gundem_konu_sayisi[0]}-${SINIRLAR.gundem_konu_sayisi[1]}`, SINIRLAR.gundem_konu_sayisi)}
        ${sayiAlani('Genel spor', 'genel_spor_konu_sayisi', v.genel_spor_konu_sayisi, `${SINIRLAR.genel_spor_konu_sayisi[0]}-${SINIRLAR.genel_spor_konu_sayisi[1]}`, SINIRLAR.genel_spor_konu_sayisi)}
      </div>
    </section>
    <section class="bolum"><h3>Tercih ettiğim kaynaklar</h3>
      <p class="bos-satir">Her konu bu sitelerde de aranır; bulunan haberler listenin başına geçer, metin önce onlardan alınır.
        Bu sitelerin manşetleri de gündeme konu olarak girer.</p>
      ${v.tercih_kaynaklar.length
        ? `<ul class="ayar-liste">${v.tercih_kaynaklar.map(kaynakKarti).join('')}</ul>`
        : '<p class="bos-satir">Henüz kaynak yok. Gündem Google Haberler\'in öne çıkardıklarından oluşur.</p>'}
      <button type="button" class="dugme ekle-dugme" data-ayar="kaynak-ekle">+ Kaynak ekle</button>
      <div class="ayar-karti alan-satiri">
        ${sayiAlani('Gündemde bu kaynakların manşetlerinden', 'tercih_konu_sayisi', v.tercih_konu_sayisi, `${SINIRLAR.tercih_konu_sayisi[0]}-${SINIRLAR.tercih_konu_sayisi[1]} konu (gündem sayısının içinden)`, SINIRLAR.tercih_konu_sayisi)}
      </div>
    </section>
    <section class="bolum"><h3>Spor seçimleri</h3>
      ${v.spor_secimleri.length
        ? `<ul class="ayar-liste">${v.spor_secimleri.map((s, i) => secimKarti(s, i, v.spor_secimleri.length)).join('')}</ul>`
        : '<p class="bos-satir">Henüz seçim yok. Spor sekmesinde sadece genel spor gündemi görünür.</p>'}
      <button type="button" class="dugme ekle-dugme" data-ayar="ekle">+ Seçim ekle</button>
    </section>
    <section class="bolum kaydet-bolumu">
      ${mesaj}
      <label class="onay"><input type="checkbox" data-alan="yenile" ${ayar.yenile ? 'checked' : ''}>
        Kaydedince gündemi hemen yeniden topla (yoksa yarın sabah)</label>
      <div class="dugmeler">
        <button type="button" class="dugme ana" data-ayar="kaydet" ${ayar.kaydediliyor ? 'disabled' : ''}>
          ${ayar.kaydediliyor ? 'Kaydediliyor…' : ayar.degisti ? 'Kaydet •' : 'Kaydet'}</button>
        <button type="button" class="dugme" data-ayar="vazgec" ${ayar.kaydediliyor ? 'disabled' : ''}>Değişiklikleri geri al</button>
      </div>
    </section>
    ${anahtarBolumu()}`;
}

// ---------- olaylar ----------

document.addEventListener('input', e => {
  const g = e.target;
  if (!ayarSayfasindaMi() || !g.dataset.alan || !ayar.veri) return;
  if (g.dataset.alan === 'yenile') { ayar.yenile = g.checked; return; }
  const liste = g.dataset.liste || 'spor_secimleri';
  const hedef = g.dataset.i === undefined ? ayar.veri : ayar.veri[liste][Number(g.dataset.i)];
  hedef[g.dataset.alan] = g.value;
  if (liste === 'tercih_kaynaklar') {
    const baslik = g.closest('li')?.querySelector('.ayar-satiri .ad b');
    if (baslik) baslik.textContent = hedef.ad || hedef.site || 'Yeni kaynak';
  } else if (g.dataset.alan === 'ad') {
    const baslik = g.closest('li')?.querySelector('.ayar-satiri .ad b');
    if (baslik) baslik.textContent = `${Number(g.dataset.i) + 1}. ${g.value || 'Yeni seçim'}`;
  }
  if (!ayar.degisti) {
    ayar.degisti = true;
    const kaydet = document.querySelector('[data-ayar="kaydet"]');
    if (kaydet) kaydet.textContent = 'Kaydet •';
  }
});

document.addEventListener('click', e => {
  const d = e.target.closest('[data-ayar]');
  if (!d || !ayarSayfasindaMi()) return;
  const eylem = d.dataset.ayar;
  const liste = ayar.veri?.spor_secimleri;
  const i = Number(d.dataset.i);
  if (eylem === 'kaydet') { ayarlariKaydet(); return; }
  if (eylem === 'yeniden-yukle') { ayarlariYukle(); return; }
  if (eylem === 'anahtar-kaydet') {
    const deger = document.getElementById('anahtar-girisi').value.trim();
    const ad = document.getElementById('anahtar-adi').value.trim();
    if (!deger && !anahtarOku()) return;
    const oldu = anahtarYaz(deger || null, ad);
    ayar.mesaj = oldu
      ? { tur: 'iyi', metin: deger ? 'Anahtar kaydedildi.' : 'Anahtarın adı kaydedildi.' }
      : { tur: 'kotu', metin: 'Anahtar bu tarayıcıda saklanamadı (gizli pencere olabilir).' };
    if (oldu) ayar.anahtarAcik = false;
  } else if (eylem === 'anahtar-sil') {
    if (!confirm('Anahtar bu telefondan silinsin mi?')) return;
    anahtarYaz('');
    ayar.anahtarAcik = false;
    ayar.mesaj = { tur: 'iyi', metin: 'Anahtar silindi.' };
  } else if (eylem === 'anahtar-duzenle') {
    ayar.anahtarAcik = !ayar.anahtarAcik;
  } else if (eylem === 'duzenle') {
    ayar.duzenlenen = ayar.duzenlenen === i ? null : i;
  } else if (eylem === 'kaynak-duzenle') {
    ayar.duzenlenenKaynak = ayar.duzenlenenKaynak === i ? null : i;
  } else if (eylem === 'kaynak-ekle') {
    ayar.veri.tercih_kaynaklar.push({ ad: '', site: '' });
    ayar.duzenlenenKaynak = ayar.veri.tercih_kaynaklar.length - 1;
    ayar.degisti = true;
    ayarlarCiz();
    document.querySelector('.duzen-alani input')?.focus();
    return;
  } else if (eylem === 'kaynak-sil') {
    const k = ayar.veri.tercih_kaynaklar[i];
    if (!confirm(`"${k.ad || k.site || 'Yeni kaynak'}" silinsin mi?`)) return;
    ayar.veri.tercih_kaynaklar.splice(i, 1);
    ayar.duzenlenenKaynak = null;
    ayar.degisti = true;
  } else if (eylem === 'vazgec') {
    if (ayar.degisti && !confirm('Kaydedilmemiş değişiklikler geri alınsın mı?')) return;
    ayar.veri = null;
    ayar.mesaj = null;
    ayar.duzenlenen = null;
    ayar.duzenlenenKaynak = null;
    ayarlariYukle();
    return;
  } else if (eylem === 'ekle') {
    liste.push({ ad: '', dal: '' });
    ayar.duzenlenen = liste.length - 1;
    ayar.degisti = true;
    ayarlarCiz();
    document.querySelector('.duzen-alani input')?.focus();
    return;
  } else if (eylem === 'sil') {
    if (!confirm(`"${liste[i].ad || 'Yeni seçim'}" silinsin mi?`)) return;
    liste.splice(i, 1);
    ayar.duzenlenen = null;
    ayar.degisti = true;
  } else if (eylem === 'yukari' || eylem === 'asagi') {
    const j = eylem === 'yukari' ? i - 1 : i + 1;
    [liste[i], liste[j]] = [liste[j], liste[i]];
    if (ayar.duzenlenen === i) ayar.duzenlenen = j;
    else if (ayar.duzenlenen === j) ayar.duzenlenen = i;
    ayar.degisti = true;
  }
  ayarlarCiz();
});
