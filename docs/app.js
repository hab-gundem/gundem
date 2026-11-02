// Gündem PWA: gundem.json'u okur; açılan/yıldızlanan konuları ve tekrar sonuçlarını
// cihazda (localStorage) tutar. Konuların içeriği de saklanır, böylece ertesi gün
// gundem.json değişse bile takip edilen konular ve tekrar kartları kaybolmaz.
//
// Tekrar düzeni:
//  - Bugün açılan konular akşam tekrarına girer.
//  - Yıldızlı konular, yıldız kaldırılana kadar uzayan aralıklarla tekrar edilir.
//  - "Hatırlayamadım" denen konular Takip'e geçer; üst üste UNUTULAN_CIKIS kez
//    hatırlanınca çıkar.

const DEPO_ANAHTARI = 'gundem.v1';
const AKSAM_SAATI = 18;                 // bu saatten sonra Gündem sayfasında tekrar hatırlatması çıkar
const ARALIKLAR = [1, 3, 7, 14, 30];    // gün; son aralık sonra hep tekrarlanır
const UNUTULAN_CIKIS = 3;

let gundem = null;        // {olusturulma, konular}
let gundemHatasi = null;
let depo = depoOku();     // {konular: {id: {veri, sonAcilma, yildiz, yildizTarihi, unutulan, seri, adim, sonraki, tekrarlar}}}
let tekrarOturumu = null; // {kuyruk: [id], sira, acik, sonuclar: {id: bool}}

// ---------- depo ----------

function depoOku() {
  try {
    const d = JSON.parse(localStorage.getItem(DEPO_ANAHTARI));
    if (d && d.konular) return d;
  } catch (e) { /* bozuk ya da erişilemez: boş başla */ }
  return { konular: {} };
}

function depoYaz() {
  try { localStorage.setItem(DEPO_ANAHTARI, JSON.stringify(depo)); } catch (e) { /* özel pencere vb. */ }
}

function kayit(konu) {
  const k = depo.konular[konu.id] || (depo.konular[konu.id] = { sonAcilma: null, yildiz: false, tekrarlar: [] });
  k.veri = konu; // her açılışta en güncel içerikle tazele
  return k;
}

function konuBul(id) {
  return (gundem && gundem.konular.find(k => k.id === id)) || depo.konular[id]?.veri || null;
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

function bugunAcilanlar() {
  return Object.entries(depo.konular)
    .filter(([, k]) => k.sonAcilma && yerelGun(k.sonAcilma) === bugun())
    .sort((a, b) => a[1].sonAcilma.localeCompare(b[1].sonAcilma))
    .map(([id]) => id);
}

const bugunTekrarlandi = id => (depo.konular[id]?.tekrarlar || []).some(t => t.tarih === bugun());

function bekleyenTekrar() {
  const vadeli = Object.entries(depo.konular)
    .filter(([, k]) => vadesiGeldi(k))
    .sort((a, b) => a[1].sonraki.localeCompare(b[1].sonraki))
    .map(([id]) => id);
  return [...new Set([...bugunAcilanlar(), ...vadeli])].filter(id => !bugunTekrarlandi(id));
}

function tekrarNedeni(id) {
  const k = depo.konular[id];
  if (k?.unutulan) return `Hatırlayamadığın · ${k.seri || 0}/${UNUTULAN_CIKIS} hatırlandı`;
  if (k?.sonAcilma && yerelGun(k.sonAcilma) === bugun()) return 'Bugün açtın';
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
  if (!takipte(k)) k.sonraki = null;
}

function takiptenCikar(k) {
  k.unutulan = false;
  k.seri = 0;
  if (!takipte(k)) k.sonraki = null;
}

// ---------- çizim ----------

const $icerik = document.getElementById('icerik');
const $baslik = document.getElementById('baslik');
const $geri = document.getElementById('geri');

function ciz() {
  let [, sayfa = '', id] = location.hash.split('/');
  if (sayfa === 'yildizli') sayfa = 'takip'; // eski adres
  $geri.hidden = sayfa !== 'konu';
  document.querySelectorAll('.alt a').forEach(a => {
    a.classList.toggle('etkin', a.dataset.sayfa === (sayfa || 'gundem'));
  });
  if (sayfa === 'konu') detayCiz(decodeURIComponent(id || ''));
  else if (sayfa === 'tekrar') tekrarCiz();
  else if (sayfa === 'takip') takipCiz();
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
  const okundu = !!depo.konular[konu.id]?.sonAcilma;
  const etiket = konu.tur === 'trends' ? '<span class="etiket">Trends</span>' : '';
  const kisiler = konu.kisiler?.length ? `<span>${konu.kisiler.map(p => esc(p.ad)).join(', ')}</span>` : '';
  return `<li class="konu-karti${okundu ? ' okundu' : ''}">
    <a href="#/konu/${encodeURIComponent(konu.id)}">
      <h2>${esc(konu.baslik)}</h2>
      <p>${esc(konu.ozet)}</p>
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

// Spor sekmesi: her seçim (tarayici/spor_secimleri.json) ayrı başlık, en altta genel spor gündemi
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

function takipCiz() {
  $baslik.textContent = 'Takip';
  const kayitlar = Object.values(depo.konular).filter(k => k.veri);
  const yildizli = kayitlar.filter(k => k.yildiz)
    .sort((a, b) => (b.yildizTarihi || '').localeCompare(a.yildizTarihi || ''));
  const unutulan = kayitlar.filter(k => k.unutulan && !k.yildiz)
    .sort((a, b) => (a.sonraki || '').localeCompare(b.sonraki || ''));
  const sonraki = k => (k.sonraki ? `<div class="takip-bilgi">Sonraki tekrar: ${gunYaz(k.sonraki)}</div>` : '');

  $icerik.innerHTML = `
    <section class="bolum ilk"><h3>Yıldızlı</h3>
      ${yildizli.length
        ? `<ul class="liste">${yildizli.map(k => konuKarti(k.veri, sonraki(k))).join('')}</ul>`
        : '<p class="bos-satir">Yıldızladığın konular burada durur ve yıldızı kaldırana kadar düzenli olarak tekrara gelir.</p>'}
    </section>
    <section class="bolum"><h3>Hatırlayamadıkların</h3>
      ${unutulan.length
        ? `<ul class="liste">${unutulan.map(k => konuKarti(k.veri,
            `<div class="takip-bilgi">Sonraki tekrar: ${gunYaz(k.sonraki)} · ${k.seri || 0}/${UNUTULAN_CIKIS} hatırlandı</div>`)
            .replace('</li>', `<button class="cikar-dugme" data-cikar="${esc(k.veri.id)}" aria-label="Listeden çıkar">✕</button></li>`)).join('')}</ul>`
        : `<p class="bos-satir">Tekrarda "Hatırlayamadım" dediğin konular buraya gelir; üst üste ${UNUTULAN_CIKIS} kez hatırlayınca çıkar.</p>`}
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

function detayCiz(id) {
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
  depoYaz();

  const ozetKaynagi = konu.ozet_kaynagi === 'başlıklar'
    ? 'Haber başlıklarından derlendi'
    : `Kaynak: ${esc(konu.ozet_kaynagi)}`;
  const takipNotu = k.unutulan && k.sonraki
    ? `<span>Hatırlayamadıkların listesinde · sonraki tekrar ${gunYaz(k.sonraki)}</span>` : '';

  $icerik.innerHTML = `<article class="detay">
    <div class="detay-ust">
      <h2 class="konu-basligi">${esc(konu.baslik)}</h2>
      ${yildizDugmesi(konu.id)}
    </div>
    <div class="meta">${kategori(konu) === 'spor' ? `<span class="etiket">${esc(konu.secim || 'Spor')}</span>` : ''}
      ${konu.tur === 'trends' ? '<span class="etiket">Trends</span>' : ''}
      ${konu.tarih ? `<span>${tarihYaz(konu.tarih)}</span>` : ''}${takipNotu}</div>
    <p class="ozet">${esc(konu.ozet)}</p>
    <div class="kaynak-notu">${ozetKaynagi}</div>

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

function tekrarCiz() {
  $baslik.textContent = 'Tekrar';
  if (!tekrarOturumu || (tekrarOturumu.sira >= tekrarOturumu.kuyruk.length && bekleyenTekrar().length)) {
    tekrarOturumu = { kuyruk: bekleyenTekrar(), sira: 0, acik: false, sonuclar: {} };
  }
  const o = tekrarOturumu;

  if (!o.kuyruk.length) {
    const yaklasan = Object.values(depo.konular).filter(k => takipte(k) && k.sonraki)
      .map(k => k.sonraki).sort()[0];
    $icerik.innerHTML = `<div class="bos">Şu an tekrar edilecek konu yok.<br>
      Gündemden okuduğun konular akşam burada tekrar kartı olur.
      ${yaklasan ? `<br><br>Sıradaki takip tekrarı: <strong>${gunYaz(yaklasan)}</strong>` : ''}</div>`;
    return;
  }

  if (o.sira >= o.kuyruk.length) {
    const sonuclar = Object.values(o.sonuclar);
    const hatirlanan = sonuclar.filter(Boolean).length;
    $icerik.innerHTML = `<div class="sonuc-ozeti">
      <p>Bugünkü tekrar bitti.</p>
      ${sonuclar.length ? `<div class="sayilar">${hatirlanan} / ${sonuclar.length}</div><p>konuyu hatırladın.</p>` : ''}
      ${sonuclar.length > hatirlanan ? '<p>Hatırlayamadıkların Takip bölümüne eklendi.</p>' : ''}
      ${bugunAcilanlar().length ? '<div class="dugmeler"><button class="dugme" data-eylem="yeniden">Bugün açtıklarımı yeniden tekrarla</button></div>' : ''}
    </div>`;
    return;
  }

  const id = o.kuyruk[o.sira];
  const konu = konuBul(id);
  if (!konu) { o.sira++; return tekrarCiz(); }
  const yuzde = Math.round((o.sira / o.kuyruk.length) * 100);
  const sonGecmis = (konu.gecmis || []).slice(-3);
  const neden = tekrarNedeni(id);

  $icerik.innerHTML = `
    <div class="ilerleme">${o.sira + 1}. kart / ${o.kuyruk.length}</div>
    <div class="ilerleme-cubugu"><span style="width:${yuzde}%"></span></div>
    <div class="tekrar-karti">
      ${neden ? `<div class="neden">${esc(neden)}</div>` : ''}
      <h2>${esc(konu.baslik)}</h2>
      ${o.acik ? `<div class="cevap">
          <section class="bolum"><h3>Ne oldu</h3><p>${esc(konu.ozet)}</p></section>
          ${konu.kisiler?.length ? `<section class="bolum"><h3>Kimler</h3><ul>${konu.kisiler.map(p =>
            `<li><strong>${esc(p.ad)}</strong>${p.aciklama ? ` — ${esc(p.aciklama)}` : ''}</li>`).join('')}</ul></section>` : ''}
          ${sonGecmis.length ? `<section class="bolum"><h3>Öncesinde</h3><ul>${sonGecmis.map(h =>
            `<li>${tarihYaz(h.tarih)}: ${esc(h.baslik)}</li>`).join('')}</ul></section>` : ''}
          <section class="bolum"><h3>Sohbette sor</h3><div class="soru">${esc(konu.soru)}</div></section>
          <p class="kaynak-notu"><a href="#/konu/${encodeURIComponent(id)}">Konunun tamamını aç</a></p>
        </div>
        <div class="dugmeler">
          <button class="dugme kotu" data-eylem="unuttum">Hatırlayamadım</button>
          <button class="dugme iyi" data-eylem="hatirladim">Hatırladım</button>
        </div>`
      : `<div class="ipucu">Önce aklından anlatmaya çalış:
          <ul><li>Ne oldu?</li><li>Kimler var?</li><li>Öncesinde ne olmuştu?</li></ul></div>
        <div class="dugmeler"><button class="dugme ana" data-eylem="goster">Cevabı göster</button></div>`}
    </div>`;
}

function tekrarSonucu(hatirladi) {
  const o = tekrarOturumu;
  const id = o.kuyruk[o.sira];
  const konu = konuBul(id);
  if (konu) {
    sonucuIsle(kayit(konu), hatirladi);
    depoYaz();
  }
  o.sonuclar[id] = hatirladi;
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
    if (location.hash.startsWith('#/konu/')) {
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
    const k = depo.konular[cikar.dataset.cikar];
    if (k) { takiptenCikar(k); depoYaz(); ciz(); }
    return;
  }
  const eylem = e.target.closest('[data-eylem]')?.dataset.eylem;
  if (eylem === 'goster') { tekrarOturumu.acik = true; ciz(); }
  else if (eylem === 'hatirladim') tekrarSonucu(true);
  else if (eylem === 'unuttum') tekrarSonucu(false);
  else if (eylem === 'yeniden') {
    tekrarOturumu = { kuyruk: bugunAcilanlar(), sira: 0, acik: false, sonuclar: {} };
    ciz();
  }
});

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
