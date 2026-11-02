// Gündem PWA: gundem.json'u okur; açılan/yıldızlanan konuları ve tekrar sonuçlarını
// cihazda (localStorage) tutar. Konuların içeriği de saklanır, böylece ertesi gün
// gundem.json değişse bile takip edilen konular ve tekrar kartları kaybolmaz.
//
// Tekrar düzeni:
//  - Yalnızca yıldızlı (favori) konular tekrara girer; yıldız kaldırılana kadar
//    uzayan aralıklarla tekrar edilir. Sadece okunan konular tekrara girmez.
//  - "Hatırlayamadım" denen konular Tekrar sekmesindeki "Hatırlayamadıkların"
//    listesine geçer; üst üste UNUTULAN_CIKIS kez hatırlanınca çıkar.
//  - Gündem ve spor konuları ayrı ayrı tekrar edilir.
//  - Tekrar kartından açılan konular Tekrar sekmesinde ayrı listelenir.

const DEPO_ANAHTARI = 'gundem.v1';
const AKSAM_SAATI = 18;                 // bu saatten sonra Gündem sayfasında tekrar hatırlatması çıkar
const ARALIKLAR = [1, 3, 7, 14, 30];    // gün; son aralık sonra hep tekrarlanır
const UNUTULAN_CIKIS = 3;

let gundem = null;        // {olusturulma, konular}
let gundemHatasi = null;
let depo = depoOku();     // {konular: {id: {veri, sonAcilma, tekrardanAcilma, yildiz, yildizTarihi, unutulan, seri, adim, sonraki, tekrarlar}}}
let tekrarOturumu = null; // {kat, kuyruk: [id], sira, acik, sonuclar: {id: bool}}
const TEKRAR_KATLARI = { gundem: 'Gündem', spor: 'Spor', hafiza: 'Hafıza' };

// ---------- depo ----------

function depoOku() {
  try {
    const d = JSON.parse(localStorage.getItem(DEPO_ANAHTARI));
    if (d && d.konular) return d;
  } catch (e) { /* bozuk ya da erişilemez: boş başla */ }
  return { konular: {} };
}

// yazılamazsa (yer doldu, özel pencere vb.) false döner
function depoYaz() {
  try { localStorage.setItem(DEPO_ANAHTARI, JSON.stringify(depo)); return true; } catch (e) { return false; }
}

function kayit(konu) {
  const k = depo.konular[konu.id] || (depo.konular[konu.id] = { sonAcilma: null, yildiz: false, tekrarlar: [] });
  k.veri = konu; // her açılışta en güncel içerikle tazele
  return k;
}

function konuBul(id) {
  return (gundem && gundem.konular.find(k => k.id === id)) || depo.konular[id]?.veri
    || (gundem?.hafiza || []).find(k => k.id === id) || null;
}

// ---------- yardımcılar ----------

const bugun = () => new Date().toLocaleDateString('sv'); // YYYY-MM-DD, yerel saat
const yerelGun = iso => new Date(iso).toLocaleDateString('sv');

function gunEkle(gun, n) {
  const t = new Date(`${gun}T12:00:00`);
  t.setDate(t.getDate() + n);
  return t.toLocaleDateString('sv');
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const guvenliAdres = u => (/^https?:\/\//i.test(u || '') ? esc(u) : '#');

function tarihYaz(iso, yilla = true) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('tr-TR', { day: 'numeric', month: 'short', ...(yilla ? { year: 'numeric' } : {}) });
}

function saatYaz(iso) {
  const t = new Date(iso);
  const gun = yerelGun(iso) === bugun() ? 'Bugün' : tarihYaz(iso, false);
  return `${gun} ${t.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })}`;
}

function gunYaz(gun) {
  if (gun === bugun()) return 'bugün';
  if (gun === gunEkle(bugun(), 1)) return 'yarın';
  return tarihYaz(`${gun}T12:00:00`, false);
}

const kategori = konu => konu.kategori || 'gundem';

// ---------- tekrar planı ----------

const takipte = k => !!(k && (k.yildiz || k.unutulan));
const vadesiGeldi = k => takipte(k) && k.sonraki && k.sonraki <= bugun();

const bugunTekrarlandi = id => (depo.konular[id]?.tekrarlar || []).some(t => t.tarih === bugun());

// kat verilirse yalnızca o kategorinin (gundem/spor) konuları
function bekleyenTekrar(kat) {
  return Object.entries(depo.konular)
    .filter(([id, k]) => vadesiGeldi(k) && !bugunTekrarlandi(id) && (!kat || kategori(k.veri || {}) === kat))
    .sort((a, b) => a[1].sonraki.localeCompare(b[1].sonraki))
    .map(([id]) => id);
}

function tekrarNedeni(id) {
  const k = depo.konular[id];
  if (k?.unutulan) return `Hatırlayamadığın · ${k.seri || 0}/${UNUTULAN_CIKIS} hatırlandı`;
  if (k?.veri?.kategori === 'hafiza') return kartEtiketleri(k.veri).join(' · ');
  if (k?.yildiz) return 'Yıldızlı';
  return '';
}

function sonucuIsle(k, hatirladi) {
  k.tekrarlar = (k.tekrarlar || []).filter(t => t.tarih !== bugun());
  k.tekrarlar.push({ tarih: bugun(), hatirladi });
  if (!hatirladi) {
    k.unutulan = true;
    k.seri = 0;
    k.adim = 0;
  } else {
    k.seri = (k.seri || 0) + 1;
    if (k.unutulan && k.seri >= UNUTULAN_CIKIS) k.unutulan = false;
    k.adim = (k.adim || 0) + 1;
  }
  const aralik = hatirladi ? ARALIKLAR[Math.min(k.adim - 1, ARALIKLAR.length - 1)] : ARALIKLAR[0];
  k.sonraki = takipte(k) ? gunEkle(bugun(), aralik) : null;
}

function yildizDegistir(k) {
  k.yildiz = !k.yildiz;
  k.yildizTarihi = k.yildiz ? new Date().toISOString() : null;
  if (k.yildiz && !k.sonraki) { k.sonraki = gunEkle(bugun(), ARALIKLAR[0]); k.adim = k.adim || 0; }
  if (k.yildiz && k.veri?.kategori === 'hafiza') k.kaydedildi = true; // hafıza kartı kendi bölümüne girer
  if (!takipte(k)) k.sonraki = null;
}

function takiptenCikar(k) {
  k.unutulan = false;
  k.seri = 0;
  if (!takipte(k)) k.sonraki = null;
}

// Tekrardan tamamen çıkar: yıldız da kalkar, hatırlayamadıklardan da çıkar
function tekrardanCikar(k) {
  k.yildiz = false;
  k.yildizTarihi = null;
  takiptenCikar(k);
}

// ---------- çizim ----------

const $icerik = document.getElementById('icerik');
const $baslik = document.getElementById('baslik');
const $geri = document.getElementById('geri');

function ciz() {
  let [, sayfa = '', id, ek] = location.hash.split('/');
  if (sayfa === 'yildizli') sayfa = 'takip'; // eski adres
  $geri.hidden = sayfa !== 'konu' && sayfa !== 'ayarlar' && !((sayfa === 'tekrar' || sayfa === 'hafiza') && id);
  document.querySelectorAll('.alt a').forEach(a => {
    a.classList.toggle('etkin', a.dataset.sayfa === (sayfa || 'gundem'));
  });
  if (sayfa === 'konu') detayCiz(decodeURIComponent(id || ''), ek === 'tekrar');
  else if (sayfa === 'tekrar') (TEKRAR_KATLARI[id] ? tekrarCiz(id) : tekrarAnaCiz());
  else if (sayfa === 'takip') takipCiz();
  else if (sayfa === 'ayarlar') ayarlarCiz(); // ayarlar.js
  else if (sayfa === 'hafiza') hafizaCiz(id, ek, location.hash.split('/')[4]); // hafiza.js
  else if (sayfa === 'spor') listeCiz('spor');
  else listeCiz('gundem');
  rozetGuncelle();
}

function rozetGuncelle() {
  const n = bekleyenTekrar().length;
  const $r = document.getElementById('rozet');
  $r.hidden = n === 0;
  $r.textContent = n;
}

function yildizDugmesi(id) {
  const acik = !!depo.konular[id]?.yildiz;
  return `<button class="yildiz-dugme" data-yildiz="${esc(id)}" aria-pressed="${acik}"
    aria-label="${acik ? 'Yıldızı kaldır' : 'Yıldızla'}">${acik ? '★' : '☆'}</button>`;
}

function konuKarti(konu, ek = '') {
  const hafizaMi = kategori(konu) === 'hafiza';
  const okundu = !hafizaMi && !!depo.konular[konu.id]?.sonAcilma;
  const etiket = konu.tur === 'trends' ? '<span class="etiket">Trends</span>'
    : hafizaMi ? `<span class="etiket">${esc(hafizaBolumu(konu).ad)}</span>` : '';
  const kisiler = konu.kisiler?.length ? `<span>${konu.kisiler.map(p => esc(p.ad)).join(', ')}</span>` : '';
  return `<li class="konu-karti${okundu ? ' okundu' : ''}">
    <a href="${hafizaMi ? '#/hafiza/k/' : '#/konu/'}${encodeURIComponent(konu.id)}">
      <h2>${esc(konu.baslik)}</h2>
      <p>${esc(hafizaMi ? (konu.metin || [])[0] : konu.ozet)}</p>
      <div class="meta">${etiket}${kisiler}${okundu ? '<span>✓ okundu</span>' : ''}</div>
      ${ek}
    </a>
    ${yildizDugmesi(konu.id)}
  </li>`;
}

function listeCiz(tur) {
  $baslik.textContent = tur === 'spor' ? 'Spor' : 'Gündem';
  if (!gundem) {
    $icerik.innerHTML = gundemHatasi
      ? `<div class="bos">Gündem yüklenemedi.<br><small>${esc(gundemHatasi)}</small></div>`
      : '<div class="bos">Yükleniyor…</div>';
    return;
  }
  let ust = '';
  const bekleyen = bekleyenTekrar().length;
  if (tur === 'gundem' && bekleyen && new Date().getHours() >= AKSAM_SAATI) {
    ust = `<div class="bilgi">Akşam tekrarı hazır: ${bekleyen} konu.
      <a href="#/tekrar">Tekrara başla →</a></div>`;
  }
  const konular = gundem.konular.filter(k => kategori(k) === tur);
  if (tur === 'spor') {
    $icerik.innerHTML = sporGruplari(konular);
    return;
  }
  $icerik.innerHTML = ust + (konular.length
    ? `<ul class="liste">${konular.map(k => konuKarti(k)).join('')}</ul>`
    : `<div class="bos">Bugün ${tur === 'spor' ? 'spor' : 'gündem'} konusu yok.</div>`);
}

// Spor sekmesi: her seçim (tarayici/ayarlar.json) ayrı başlık, en altta genel spor gündemi
function sporGruplari(konular) {
  const grup = (baslik, liste, bosMetin) => `<section class="bolum spor-grubu"><h3>${baslik}</h3>
    ${liste.length ? `<ul class="liste">${liste.map(k => konuKarti(k)).join('')}</ul>`
      : `<p class="bos-satir">${bosMetin}</p>`}</section>`;
  const gruplar = (gundem.spor_secimleri || []).map(s => grup(
    `${esc(s.ad)}${s.dal ? ` <span class="dal">· ${esc(s.dal)}</span>` : ''}`,
    konular.filter(k => k.secim === s.ad), 'Son günlerde haber yok.'));
  gruplar.push(grup('Genel spor gündemi', konular.filter(k => !k.secim), 'Bugün genel spor konusu yok.'));
  return gruplar.join('');
}

// ✕ düğmeli konu kartı (listeden çıkarmak için); eylem: data-cikar değeri ("unutulan" / "acilan")
function cikarilabilirKart(konu, ek, eylem, etiket) {
  return konuKarti(konu, ek).replace(/<\/li>$/,
    `<button class="cikar-dugme" data-cikar="${eylem}" data-id="${esc(konu.id)}" aria-label="${etiket}">✕</button></li>`);
}

function takipCiz() {
  $baslik.textContent = 'Takip';
  const yildizli = Object.values(depo.konular).filter(k => k.veri && k.yildiz && kategori(k.veri) !== 'hafiza')
    .sort((a, b) => (b.yildizTarihi || '').localeCompare(a.yildizTarihi || ''));
  const sonraki = k => (k.sonraki ? `<div class="takip-bilgi">Sonraki tekrar: ${gunYaz(k.sonraki)}</div>` : '');

  $icerik.innerHTML = `
    <section class="bolum ilk"><h3>Yıldızlı</h3>
      ${yildizli.length
        ? `<ul class="liste">${yildizli.map(k => konuKarti(k.veri, sonraki(k))).join('')}</ul>`
        : '<p class="bos-satir">Yıldızladığın konular burada durur ve yıldızı kaldırana kadar düzenli olarak tekrara gelir.</p>'}
    </section>`;
}

function kisiBlogu(p) {
  const resim = p.resim
    ? `<img src="${guvenliAdres(p.resim)}" alt="" loading="lazy">`
    : `<div class="resimsiz" aria-hidden="true">${esc((p.ad || '?')[0])}</div>`;
  return `<div class="kisi">${resim}<div>
    <h4>${esc(p.ad)}</h4>
    ${p.aciklama ? `<p class="aciklama">${esc(p.aciklama)}</p>` : ''}
    ${p.ozet ? `<p>${esc(p.ozet)}</p>` : ''}
    ${p.link ? `<a href="${guvenliAdres(p.link)}" target="_blank" rel="noopener">Wikipedia'da oku</a>` : ''}
  </div></div>`;
}

function haberSatiri(h) {
  return `<a href="${guvenliAdres(h.link)}" target="_blank" rel="noopener">${esc(h.baslik)}</a>
    ${h.kaynak ? `<span class="kaynak"> · ${esc(h.kaynak)}</span>` : ''}`;
}

// Haberin metni: uzun basınca kısalır ("Devamını oku" çıkar), yeniden uzun basınca açılır
function haberMetni(konu) {
  if (!konu.metin?.length) {
    const ozetKaynagi = konu.ozet_kaynagi === 'başlıklar'
      ? 'Haber başlıklarından derlendi'
      : `Kaynak: ${esc(konu.ozet_kaynagi)}`;
    return `<p class="ozet">${esc(konu.ozet)}</p><div class="kaynak-notu">${ozetKaynagi}</div>`;
  }
  return `<div class="haber-metni" data-uzun-bas>
      ${konu.metin.map(p => `<p>${esc(p)}</p>`).join('')}
    </div>
    <button type="button" class="devami-dugme" data-eylem="devami">Devamını oku ▾</button>
    <div class="kaynak-notu">Kaynak: ${esc(konu.metin_kaynagi)}
      ${konu.metin_link ? ` · <a href="${guvenliAdres(konu.metin_link)}" target="_blank" rel="noopener">sayfada aç</a>` : ''}
      · <span class="ipucu-yazi">Kısaltmak için metne basılı tut</span></div>`;
}

function detayCiz(id, tekrardan = false) {
  const konu = konuBul(id);
  $baslik.textContent = 'Konu';
  if (!konu) {
    $icerik.innerHTML = gundem || gundemHatasi
      ? '<div class="bos">Bu konu artık bulunamadı.</div>'
      : '<div class="bos">Yükleniyor…</div>';
    return;
  }
  const k = kayit(konu);
  k.sonAcilma = new Date().toISOString();
  if (tekrardan) k.tekrardanAcilma = k.sonAcilma;
  depoYaz();

  const takipNotu = k.unutulan && k.sonraki
    ? `<span>Hatırlayamadıkların listesinde · sonraki tekrar ${gunYaz(k.sonraki)}</span>` : '';

  $icerik.innerHTML = `<article class="detay">
    ${konu.gorsel ? `<img class="haber-gorseli" src="${guvenliAdres(konu.gorsel)}" alt="" referrerpolicy="no-referrer"
      onerror="this.remove()">` : ''}
    <div class="detay-ust">
      <h2 class="konu-basligi">${esc(konu.baslik)}</h2>
      ${yildizDugmesi(konu.id)}
    </div>
    <div class="meta">${kategori(konu) === 'spor' ? `<span class="etiket">${esc(konu.secim || 'Spor')}</span>` : ''}
      ${konu.tur === 'trends' ? '<span class="etiket">Trends</span>' : ''}
      ${konu.tarih ? `<span>${tarihYaz(konu.tarih)}</span>` : ''}${takipNotu}</div>
    ${haberMetni(konu)}

    <section class="bolum"><h3>Sohbette sor</h3><div class="soru">${esc(konu.soru)}</div></section>

    ${konu.kisiler?.length ? `<section class="bolum"><h3>Kişiler</h3>${konu.kisiler.map(kisiBlogu).join('')}</section>` : ''}

    ${konu.gecmis?.length ? `<section class="bolum"><h3>Geçmişte ne oldu</h3>
      <ol class="zaman-cizgisi">${konu.gecmis.map(h => `<li>
        <time datetime="${esc(h.tarih)}">${tarihYaz(h.tarih)}</time>${haberSatiri(h)}</li>`).join('')}
      </ol></section>` : ''}

    ${konu.haberler?.length ? `<section class="bolum"><h3>Bugünkü haberler</h3>
      <ul class="haberler">${konu.haberler.map(h => `<li>${haberSatiri(h)}</li>`).join('')}</ul></section>` : ''}
  </article>`;
  window.scrollTo(0, 0);
}

// ---------- tekrar ----------

// Tekrar sekmesinin ana sayfası: gündem ve spor tekrarı ayrı, altında
// hatırlayamadıkların ve tekrar kartından açtıkların
function tekrarAnaCiz() {
  $baslik.textContent = 'Tekrar';
  const kayitlar = Object.values(depo.konular).filter(k => k.veri);
  const yaklasan = kayitlar.filter(k => takipte(k) && k.sonraki && k.sonraki > bugun())
    .map(k => k.sonraki).sort()[0];
  const katBolumu = (kat, ad, ilk) => {
    const n = bekleyenTekrar(kat).length;
    return `<section class="bolum${ilk ? ' ilk' : ''}"><h3>${ad} tekrarı</h3>
      <div class="ayar-karti tekrar-satiri">
        <span>${n ? `<strong>${n}</strong> konu bekliyor` : 'Bekleyen konu yok'}</span>
        ${n ? `<a class="dugme ana" href="#/tekrar/${kat}">Başla</a>` : ''}
      </div></section>`;
  };
  const unutulan = kayitlar.filter(k => k.unutulan)
    .sort((a, b) => (a.sonraki || '').localeCompare(b.sonraki || ''));
  const acilan = kayitlar.filter(k => k.tekrardanAcilma)
    .sort((a, b) => b.tekrardanAcilma.localeCompare(a.tekrardanAcilma));

  $icerik.innerHTML = `
    ${katBolumu('gundem', 'Gündem', true)}
    ${katBolumu('spor', 'Spor')}
    ${katBolumu('hafiza', 'Hafıza')}
    ${yaklasan ? `<p class="kaynak-notu">Sıradaki tekrar: <strong>${gunYaz(yaklasan)}</strong></p>` : ''}
    <section class="bolum"><h3>Hatırlayamadıkların</h3>
      ${unutulan.length
        ? `<ul class="liste">${unutulan.map(k => cikarilabilirKart(k.veri,
            `<div class="takip-bilgi">Sonraki tekrar: ${gunYaz(k.sonraki)} · ${k.seri || 0}/${UNUTULAN_CIKIS} hatırlandı</div>`,
            'unutulan', 'Tekrardan çıkar')).join('')}</ul>`
        : `<p class="bos-satir">Tekrarda "Hatırlayamadım" dediğin konular buraya gelir; üst üste ${UNUTULAN_CIKIS} kez hatırlayınca çıkar.</p>`}
    </section>
    <section class="bolum"><h3>Tekrardan açtıkların</h3>
      ${acilan.length
        ? `<ul class="liste">${acilan.map(k => cikarilabilirKart(k.veri,
            `<div class="takip-bilgi">Açıldı: ${esc(saatYaz(k.tekrardanAcilma))}</div>`,
            'acilan', 'Bu listeden çıkar')).join('')}</ul>`
        : '<p class="bos-satir">Tekrar kartında "Konunun tamamını aç" ile açtığın konular burada durur.</p>'}
    </section>
    <p class="kaynak-notu">Yalnızca yıldızladığın konular tekrara gelir.</p>`;
}

function tekrarCiz(kat) {
  $baslik.textContent = `${TEKRAR_KATLARI[kat]} tekrarı`;
  if (!tekrarOturumu || tekrarOturumu.kat !== kat
      || (tekrarOturumu.sira >= tekrarOturumu.kuyruk.length && bekleyenTekrar(kat).length)) {
    tekrarOturumu = { kat, kuyruk: bekleyenTekrar(kat), sira: 0, acik: false, sonuclar: {} };
  }
  const o = tekrarOturumu;

  if (!o.kuyruk.length) {
    $icerik.innerHTML = `<div class="bos">Şu an tekrar edilecek ${TEKRAR_KATLARI[kat].toLocaleLowerCase('tr')} konusu yok.<br>
      Yıldızladığın konular burada tekrar kartı olur.<br><br><a href="#/tekrar">Tekrar sayfasına dön</a></div>`;
    return;
  }

  if (o.sira >= o.kuyruk.length) {
    const sonuclar = Object.values(o.sonuclar);
    const hatirlanan = sonuclar.filter(Boolean).length;
    $icerik.innerHTML = `<div class="sonuc-ozeti">
      <p>${TEKRAR_KATLARI[kat]} tekrarı bitti.</p>
      ${sonuclar.length ? `<div class="sayilar">${hatirlanan} / ${sonuclar.length}</div><p>konuyu hatırladın.</p>` : ''}
      ${sonuclar.length > hatirlanan ? '<p>Hatırlayamadıkların Tekrar sayfasındaki listeye eklendi.</p>' : ''}
      <div class="dugmeler"><a class="dugme" href="#/tekrar">Tekrar sayfasına dön</a></div>
    </div>`;
    return;
  }

  const id = o.kuyruk[o.sira];
  const konu = konuBul(id);
  if (!konu) { o.sira++; return tekrarCiz(kat); }
  const yuzde = Math.round((o.sira / o.kuyruk.length) * 100);
  const sonGecmis = (konu.gecmis || []).slice(-3);
  const neden = tekrarNedeni(id);

  $icerik.innerHTML = `
    <div class="ilerleme">${o.sira + 1}. kart / ${o.kuyruk.length}</div>
    <div class="ilerleme-cubugu"><span style="width:${yuzde}%"></span></div>
    <div class="tekrar-karti">
      ${neden ? `<div class="neden">${esc(neden)}</div>` : ''}
      <h2>${esc(konu.baslik)}</h2>
      ${kategori(konu) === 'hafiza' ? `${hafizaTekrarIcerigi(konu, o.acik)}
        <div class="dugmeler">${o.acik
          ? `<button class="dugme kotu" data-eylem="unuttum">Hatırlayamadım</button>
             <button class="dugme iyi" data-eylem="hatirladim">Hatırladım</button>`
          : '<button class="dugme ana" data-eylem="goster">Cevabı göster</button>'}</div>`
      : o.acik ? `<div class="cevap">
          <section class="bolum"><h3>Ne oldu</h3><p>${esc(konu.ozet)}</p></section>
          ${konu.kisiler?.length ? `<section class="bolum"><h3>Kimler</h3><ul>${konu.kisiler.map(p =>
            `<li><strong>${esc(p.ad)}</strong>${p.aciklama ? ` — ${esc(p.aciklama)}` : ''}</li>`).join('')}</ul></section>` : ''}
          ${sonGecmis.length ? `<section class="bolum"><h3>Öncesinde</h3><ul>${sonGecmis.map(h =>
            `<li>${tarihYaz(h.tarih)}: ${esc(h.baslik)}</li>`).join('')}</ul></section>` : ''}
          <section class="bolum"><h3>Sohbette sor</h3><div class="soru">${esc(konu.soru)}</div></section>
          <p class="kaynak-notu"><a href="#/konu/${encodeURIComponent(id)}/tekrar">Konunun tamamını aç</a></p>
        </div>
        <div class="dugmeler">
          <button class="dugme kotu" data-eylem="unuttum">Hatırlayamadım</button>
          <button class="dugme iyi" data-eylem="hatirladim">Hatırladım</button>
        </div>`
      : `<div class="ipucu">Önce aklından anlatmaya çalış:
          <ul><li>Ne oldu?</li><li>Kimler var?</li><li>Öncesinde ne olmuştu?</li></ul></div>
        <div class="dugmeler"><button class="dugme ana" data-eylem="goster">Cevabı göster</button></div>`}
      <button type="button" class="metin-dugme" data-eylem="tekrardan-cikar">Bu konuyu tekrardan çıkar</button>
    </div>`;
}

// hatirladi: true / false; null = konu tekrardan çıkarıldı
function tekrarSonucu(hatirladi) {
  const o = tekrarOturumu;
  const id = o.kuyruk[o.sira];
  const konu = konuBul(id);
  if (konu) {
    if (hatirladi === null) tekrardanCikar(kayit(konu));
    else sonucuIsle(kayit(konu), hatirladi);
    depoYaz();
  }
  if (hatirladi !== null) o.sonuclar[id] = hatirladi;
  o.sira++;
  o.acik = false;
  ciz();
  window.scrollTo(0, 0);
}

// ---------- olaylar ----------

document.addEventListener('click', e => {
  const yildiz = e.target.closest('[data-yildiz]');
  if (yildiz) {
    e.preventDefault();
    const konu = konuBul(yildiz.dataset.yildiz);
    if (!konu) return;
    yildizDegistir(kayit(konu));
    depoYaz();
    if (/^#\/(konu|hafiza\/k)\//.test(location.hash)) {
      // detayı yeniden çizmeden sadece düğmeyi güncelle (sayfa başa kaymasın)
      yildiz.outerHTML = yildizDugmesi(konu.id);
      rozetGuncelle();
    } else {
      ciz();
    }
    return;
  }
  const cikar = e.target.closest('[data-cikar]');
  if (cikar) {
    const k = depo.konular[cikar.dataset.id];
    if (!k) return;
    if (cikar.dataset.cikar === 'unutulan') {
      if (!confirm(`"${k.veri?.baslik || 'Bu konu'}" tekrardan çıkarılsın mı?`)) return;
      tekrardanCikar(k);
    } else {
      k.tekrardanAcilma = null;
    }
    depoYaz();
    ciz();
    return;
  }
  const eylem = e.target.closest('[data-eylem]')?.dataset.eylem;
  if (eylem === 'goster') { tekrarOturumu.acik = true; ciz(); }
  else if (eylem === 'hatirladim') tekrarSonucu(true);
  else if (eylem === 'unuttum') tekrarSonucu(false);
  else if (eylem === 'tekrardan-cikar') {
    if (confirm('Bu konu tekrardan çıkarılsın mı? (Yıldızı da kalkar.)')) tekrarSonucu(null);
  } else if (eylem === 'devami') {
    document.querySelector('.haber-metni')?.classList.remove('kisa');
  }
});

// Haber metnine uzun basınca metin kısalır / açılır
let uzunBasma = null;
document.addEventListener('pointerdown', e => {
  const metin = e.target.closest('[data-uzun-bas]');
  if (!metin) return;
  const { clientX: x, clientY: y } = e;
  uzunBasma = { x, y, zaman: setTimeout(() => {
    uzunBasma = null;
    metin.classList.toggle('kisa');
    navigator.vibrate?.(20);
    if (metin.classList.contains('kisa')) metin.scrollIntoView({ block: 'nearest' });
  }, 550) };
});
const uzunBasmaIptal = () => { if (uzunBasma) { clearTimeout(uzunBasma.zaman); uzunBasma = null; } };
document.addEventListener('pointerup', uzunBasmaIptal);
document.addEventListener('pointercancel', uzunBasmaIptal);
document.addEventListener('pointermove', e => {
  if (uzunBasma && Math.hypot(e.clientX - uzunBasma.x, e.clientY - uzunBasma.y) > 10) uzunBasmaIptal();
});
document.addEventListener('contextmenu', e => { if (e.target.closest('[data-uzun-bas]')) e.preventDefault(); });

// ---------- haberleri yenile ----------
// Anahtar kayıtlıysa GitHub'daki görevi başlatır (5-10 dk) ve yeni gundem.json gelene kadar
// yarım dakikada bir bakar. Anahtar yoksa sadece sitedeki son hâli yeniden yükler.

const YENILEME_BEKLEME = 30 * 1000;
const YENILEME_EN_FAZLA = 20 * 60 * 1000;
let yenileniyor = false;

function durumGoster(metin, sure = 6000) {
  const $d = document.getElementById('durum');
  $d.textContent = metin;
  $d.hidden = !metin;
  clearTimeout(durumGoster.zaman);
  if (metin && sure) durumGoster.zaman = setTimeout(() => { $d.hidden = true; }, sure);
}

async function haberleriYenile() {
  if (yenileniyor) { durumGoster('Haberler hâlâ toplanıyor, hazır olunca kendiliğinden yenilenecek.'); return; }
  const $d = document.getElementById('yenile');
  const onceki = gundem?.olusturulma;
  if (!anahtarOku()) {
    await gundemYukle();
    durumGoster(gundem?.olusturulma !== onceki ? 'Haberler yenilendi.'
      : 'Sitedeki en son gündem yüklendi. Haberleri şimdi yeniden toplatmak için Ayarlar\'a GitHub anahtarı eklemelisin.', 8000);
    return;
  }
  yenileniyor = true;
  $d.classList.add('donuyor');
  try {
    await ghIstek(`actions/workflows/${GH_GOREV}/dispatches`, { method: 'POST', body: JSON.stringify({ ref: 'main' }) });
    durumGoster('Haberler toplanıyor. 5-10 dakika sürer; hazır olunca kendiliğinden yenilenir.', 8000);
    const baslangic = Date.now();
    while (Date.now() - baslangic < YENILEME_EN_FAZLA) {
      await new Promise(r => setTimeout(r, YENILEME_BEKLEME));
      try {
        const yanit = await fetch('gundem.json', { cache: 'no-store' });
        const yeni = yanit.ok ? await yanit.json() : null;
        if (yeni && yeni.olusturulma !== onceki) {
          gundem = yeni;
          gundemHatasi = null;
          document.getElementById('guncelleme').textContent = `Güncelleme: ${saatYaz(gundem.olusturulma)}`;
          ciz();
          durumGoster('Haberler yenilendi.');
          return;
        }
      } catch (e) { /* ağ kesintisi: sonraki denemede */ }
    }
    durumGoster('Haberler 20 dakikada gelmedi. Biraz sonra uygulamayı kapatıp açmayı dene.', 8000);
  } catch (e) {
    durumGoster(e.durum === 403 || e.durum === 404
      ? 'Haberler toplatılamadı: anahtarda "Actions: Read and write" izni yok olabilir.'
      : ghHataMetni(e, false), 10000);
  } finally {
    yenileniyor = false;
    $d.classList.remove('donuyor');
  }
}

document.getElementById('yenile').addEventListener('click', haberleriYenile);

$geri.addEventListener('click', () => {
  if (history.length > 1) history.back();
  else location.hash = '#/';
});

window.addEventListener('hashchange', ciz);

// ---------- başlangıç ----------

async function gundemYukle() {
  try {
    const yanit = await fetch('gundem.json', { cache: 'no-cache' });
    if (!yanit.ok) throw new Error(`HTTP ${yanit.status}`);
    gundem = await yanit.json();
    document.getElementById('guncelleme').textContent = `Güncelleme: ${saatYaz(gundem.olusturulma)}`;
  } catch (e) {
    gundemHatasi = e.message;
  }
  ciz();
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => { /* çevrimdışı özellik olmadan da çalışır */ });
}

ciz();
gundemYukle();
