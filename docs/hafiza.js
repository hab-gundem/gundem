// Hafıza sekmesi (#/hafiza): hikâye, fıkra, şiir, şarkı/türkü, karikatür, sporcu/takım,
// gezilen yer ve söz kartları. Kartları kullanıcı kendisi ekler; ayrıca her gün tarayıcı
// mitoloji, dini hikâye, söz ve şiirden birer kart getirir (gundem.json -> hafiza).
// Kartlar app.js'deki depoda (depo.konular) kategori "hafiza" ile durur, böylece aynı tekrar
// düzenine girer. Kullanıcının eklediği kartlar kendiliğinden tekrara (yıldızlı) girer;
// günün kartları yıldızlanınca kaydedilir. Her şey yalnızca bu cihazda saklanır.
// app.js'den önce yüklenir; depo, esc, $icerik vb. çizim anında app.js'den gelir.
//
// Adresler: #/hafiza  ·  #/hafiza/b/<bölüm>  ·  #/hafiza/k/<id>[/tekrar]  ·  #/hafiza/d/<bölüm>/<id|yeni>

const HAFIZA_BOLUMLERI = {
  hikaye: { ad: 'Hikâyeler', altlar: ['Mitolojik', 'Dini', 'Kişisel gelişim'], ek: 'Yorumum, benzerlikler ve farklılıklar',
    soru: 'Hikâyeyi anlat: kimler var, ne oldu, ne anlatıyor? Hangi hikâyelere benziyor, farkı ne?' },
  fikra: { ad: 'Fıkralar', altlar: ['Normal', 'Yetişkin'], kime: true, ek: 'Notum',
    soru: 'Fıkrayı baştan sona anlat.' },
  siir: { ad: 'Şiirler', yazar: 'Şair', ek: 'Hikâyesi', soru: 'Şiiri ezberden söyle. Hikâyesi ne?' },
  yetiskin: { ad: 'Yetişkin içerik', yazar: 'Şair', ek: 'Notum', soru: 'Beyitleri hatırla. Ne anlatıyor?' },
  hiciv: { ad: 'Hicivler', yazar: 'Şair', ek: 'Kimi, neyi hicvediyor (bağlam)', soru: 'Hicvi söyle. Kimi, neden hicvediyor?' },
  sarki: { ad: 'Şarkı ve türküler', altlar: ['Şarkı', 'Türkü'], yazar: 'Söz / müzik / yöre', ek: 'Hikâyesi',
    soru: 'Sözlerini söyle. Hikâyesi ne?' },
  karikatur: { ad: 'Karikatürler', yazar: 'Çizer', ek: 'Esprisi / notum', soru: 'Karikatürü ve esprisini anlat.' },
  sporcu: { ad: 'Sporcular ve takımlar', ek: 'Notum', soru: 'Hatırladıklarını say.' },
  yer: { ad: 'Şehirler ve gezdiğim yerler', ek: 'Anılarım', soru: 'Neler gördün, neler yaşadın?' },
  soz: { ad: 'Sözler', yazar: 'Kimin sözü', ek: 'Neden söyledi (bağlam)', soru: 'Sözü ve neden söylendiğini hatırla.' },
};
const HAFIZA_KIME = ['Kadınlara', 'Erkeklere', 'Çocuklara'];
const GORSEL_EN_BUYUK = 1000; // piksel; yüklenen fotoğraf bu boyuta küçültülür (telefonda yer kaplamasın)

let hafizaForm = null;     // {anahtar: "bolum/id", veri}
let hafizaSuzgec = {};     // bölüm -> seçili etiket (alt tür ya da kime)

// ---------- veri ----------

const hafizaBolumu = kart => HAFIZA_BOLUMLERI[kart?.bolum] || HAFIZA_BOLUMLERI.hikaye;

function hafizaKarti(id) {
  return depo.konular[id]?.veri || (gundem?.hafiza || []).find(k => k.id === id) || null;
}

function kayitliKartlar(bolum) {
  return Object.values(depo.konular)
    .filter(k => k.kaydedildi && k.veri?.kategori === 'hafiza' && (!bolum || k.veri.bolum === bolum))
    .sort((a, b) => (b.veri.olusturma || b.yildizTarihi || '').localeCompare(a.veri.olusturma || a.yildizTarihi || ''));
}

const metinParcala = s => String(s || '').split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);

function kartEtiketleri(kart) {
  const b = hafizaBolumu(kart);
  return [b.ad, kart.alt, ...(kart.kime || []).map(k => `${k} anlatılır`)].filter(Boolean);
}

// ---------- çizim ----------

function hafizaCiz(tur, a, b) {
  if (tur === 'b') return hafizaBolumCiz(a);
  if (tur === 'k') return hafizaKartCiz(decodeURIComponent(a || ''), b === 'tekrar');
  if (tur === 'd') return hafizaFormCiz(a, decodeURIComponent(b || 'yeni'));
  return hafizaAnaCiz();
}

function hafizaListeKarti(kart) {
  const ilk = (kart.metin || [])[0] || '';
  return `<li class="konu-karti">
    <a href="#/hafiza/k/${encodeURIComponent(kart.id)}">
      <h2>${esc(kart.baslik)}</h2>
      <p>${esc(ilk)}</p>
      <div class="meta">${kartEtiketleri(kart).map((e, i) => i ? `<span>${esc(e)}</span>` : `<span class="etiket">${esc(e)}</span>`).join('')}
        ${kart.yazar ? `<span>${esc(kart.yazar)}</span>` : ''}</div>
    </a>
    ${yildizDugmesi(kart.id)}
  </li>`;
}

function hafizaAnaCiz() {
  $baslik.textContent = 'Hafıza';
  const bugunku = gundem?.hafiza || [];
  $icerik.innerHTML = `
    <section class="bolum ilk"><h3>Günün kartları</h3>
      ${bugunku.length
        ? `<ul class="liste">${bugunku.map(hafizaListeKarti).join('')}</ul>
           <p class="kaynak-notu">Beğendiğini ☆ ile kaydet; kaydedilen kart kendi bölümüne girer ve tekrara gelir.</p>`
        : `<p class="bos-satir">${gundem ? 'Bugün otomatik kart gelmedi.' : 'Yükleniyor…'}</p>`}
    </section>
    <section class="bolum"><h3>Bölümler</h3>
      <ul class="ayar-liste">${Object.entries(HAFIZA_BOLUMLERI).map(([id, b]) => `<li>
        <a class="ayar-satiri bolum-satiri" href="#/hafiza/b/${id}">
          <span class="ad"><b>${esc(b.ad)}</b></span>
          <span class="sayi">${kayitliKartlar(id).length}</span><span aria-hidden="true">›</span>
        </a></li>`).join('')}
      </ul>
    </section>
    <p class="kaynak-notu">Kartlar yalnızca bu telefonda saklanır.</p>`;
}

function hafizaBolumCiz(bolum) {
  const b = HAFIZA_BOLUMLERI[bolum];
  if (!b) { location.replace('#/hafiza'); return; }
  $baslik.textContent = b.ad;
  const secenekler = [...(b.altlar || []), ...(b.kime ? HAFIZA_KIME : [])];
  const secili = hafizaSuzgec[bolum] || '';
  const kartlar = kayitliKartlar(bolum).map(k => k.veri)
    .filter(k => !secili || k.alt === secili || (k.kime || []).includes(secili));
  $icerik.innerHTML = `
    ${secenekler.length ? `<div class="suzgec">${['', ...secenekler].map(s =>
      `<button type="button" class="cip${s === secili ? ' secili' : ''}" data-hafiza="suz" data-bolum="${bolum}" data-deger="${esc(s)}">
        ${s ? esc(HAFIZA_KIME.includes(s) ? `${s} anlatılır` : s) : 'Tümü'}</button>`).join('')}</div>` : ''}
    ${kartlar.length
      ? `<ul class="liste">${kartlar.map(hafizaListeKarti).join('')}</ul>`
      : `<p class="bos-satir">${secili ? 'Bu seçimde kart yok.' : 'Henüz kart yok.'}</p>`}
    <a class="dugme ekle-dugme" href="#/hafiza/d/${bolum}/yeni">+ Kart ekle</a>`;
}

function hafizaKartCiz(id, tekrardan) {
  const kart = hafizaKarti(id);
  $baslik.textContent = 'Kart';
  if (!kart) {
    $icerik.innerHTML = `<div class="bos">${gundem || gundemHatasi ? 'Bu kart bulunamadı.' : 'Yükleniyor…'}</div>`;
    return;
  }
  const k = depo.konular[id];
  if (k && tekrardan) { k.tekrardanAcilma = new Date().toISOString(); depoYaz(); }
  const b = hafizaBolumu(kart);
  $icerik.innerHTML = `<article class="detay">
    ${kart.gorsel ? `<img class="haber-gorseli hafiza-gorseli" src="${kart.gorsel.startsWith('data:image/') ? kart.gorsel : guvenliAdres(kart.gorsel)}"
      alt="" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}
    <div class="detay-ust">
      <h2 class="konu-basligi">${esc(kart.baslik)}</h2>
      ${yildizDugmesi(kart.id)}
    </div>
    <div class="meta">${kartEtiketleri(kart).map(e => `<span class="etiket">${esc(e)}</span>`).join('')}
      ${kart.yazar ? `<span>${esc(kart.yazar)}</span>` : ''}</div>
    ${hafizaMetni(kart)}
    ${kart.ek ? `<section class="bolum"><h3>${esc(b.ek)}</h3><p class="satirli">${esc(kart.ek)}</p></section>` : ''}
    ${kart.bilgi ? `<section class="bolum"><h3>${esc(kart.bilgi_baslik || 'Bilgi')}</h3><p class="satirli">${esc(kart.bilgi)}</p></section>` : ''}
    ${kart.link ? `<p class="kaynak-notu">Kaynak: ${esc(kart.kaynak || '')} · <a href="${guvenliAdres(kart.link)}" target="_blank" rel="noopener">sayfada aç</a></p>` : ''}
    <div class="dugmeler">
      <a class="dugme" href="#/hafiza/d/${esc(kart.bolum)}/${encodeURIComponent(kart.id)}">✎ Düzenle</a>
      ${k?.kaydedildi ? `<button type="button" class="dugme kotu" data-hafiza="sil" data-id="${esc(kart.id)}">Sil</button>` : ''}
    </div>
    ${!k?.kaydedildi ? '<p class="kaynak-notu">Kaydetmek ve tekrara almak için ☆\'a bas. Düzenleyip kaydedersen de kaydedilir.</p>' : ''}
  </article>`;
  window.scrollTo(0, 0);
}

// Her paragraf; bugünkü Türkçe karşılığı (anlam) varsa hemen altında
const metinParagraflari = kart => kart.metin.map((p, i) => `<p>${esc(p)}</p>`
  + (kart.anlam?.[i] ? `<p class="anlam">${esc(kart.anlam[i])}</p>` : '')).join('');

// Kart metni: haber metni gibi uzun basınca kısalır ("Devamını oku")
function hafizaMetni(kart) {
  if (!kart.metin?.length) return '';
  return `<div class="haber-metni satirli" data-uzun-bas>${metinParagraflari(kart)}</div>
    ${kart.anlam_notu ? `<div class="kaynak-notu">${esc(kart.anlam_notu)}</div>` : ''}
    <button type="button" class="devami-dugme" data-eylem="devami">Devamını oku ▾</button>
    <div class="kaynak-notu"><span class="ipucu-yazi">Kısaltmak için metne basılı tut</span></div>`;
}

// Tekrar kartı (app.js tekrarCiz çağırır): ön yüz soru, arka yüz kartın içeriği
function hafizaTekrarIcerigi(kart, acik) {
  const b = hafizaBolumu(kart);
  const ust = kart.yazar ? `<p class="kaynak-notu">${esc(kart.yazar)}</p>` : '';
  if (!acik) return `${ust}<div class="ipucu">${esc(b.soru)}</div>`;
  return `${ust}<div class="cevap">
    ${kart.gorsel ? `<img class="haber-gorseli" src="${kart.gorsel.startsWith('data:image/') ? kart.gorsel : guvenliAdres(kart.gorsel)}"
      alt="" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}
    ${kart.metin?.length ? `<div class="satirli">${metinParagraflari(kart)}</div>` : ''}
    ${kart.ek ? `<section class="bolum"><h3>${esc(b.ek)}</h3><p class="satirli">${esc(kart.ek)}</p></section>` : ''}
    ${kart.bilgi ? `<section class="bolum"><h3>${esc(kart.bilgi_baslik || 'Bilgi')}</h3><p class="satirli">${esc(kart.bilgi)}</p></section>` : ''}
    <p class="kaynak-notu"><a href="#/hafiza/k/${encodeURIComponent(kart.id)}/tekrar">Kartın tamamını aç</a></p>
  </div>`;
}

// ---------- ekleme / düzenleme ----------

function hafizaFormCiz(bolum, id) {
  const b = HAFIZA_BOLUMLERI[bolum];
  if (!b) { location.replace('#/hafiza'); return; }
  const anahtar = `${bolum}/${id}`;
  if (!hafizaForm || hafizaForm.anahtar !== anahtar) {
    const eski = id !== 'yeni' ? hafizaKarti(id) : null;
    hafizaForm = { anahtar, veri: eski
      ? { ...eski, metin: (eski.metin || []).join('\n\n'), kime: [...(eski.kime || [])] }
      : { bolum, baslik: '', yazar: '', metin: '', ek: '', alt: '', kime: [], gorsel: '' } };
  }
  const v = hafizaForm.veri;
  $baslik.textContent = id === 'yeni' ? `${b.ad}: yeni kart` : 'Kartı düzenle';
  $icerik.innerHTML = `<div class="ayar-karti hafiza-formu">
    <label class="alan"><span>Başlık</span>
      <input type="text" data-hf="baslik" value="${esc(v.baslik)}" placeholder="Kartın adı"></label>
    ${b.altlar ? `<div class="alan"><span>Tür</span><div class="suzgec">${b.altlar.map(a =>
      `<button type="button" class="cip${v.alt === a ? ' secili' : ''}" data-hafiza="alt" data-deger="${esc(a)}">${esc(a)}</button>`).join('')}</div></div>` : ''}
    ${b.kime ? `<div class="alan"><span>Kime anlatılabilir</span><div class="suzgec">${HAFIZA_KIME.map(a =>
      `<button type="button" class="cip${v.kime.includes(a) ? ' secili' : ''}" data-hafiza="kime" data-deger="${esc(a)}">${esc(a)}</button>`).join('')}</div></div>` : ''}
    ${b.yazar ? `<label class="alan"><span>${esc(b.yazar)}</span>
      <input type="text" data-hf="yazar" value="${esc(v.yazar)}"></label>` : ''}
    <label class="alan"><span>Metin</span>
      <textarea data-hf="metin" rows="8" placeholder="Paragrafları boş satırla ayır">${esc(v.metin)}</textarea></label>
    <label class="alan"><span>${esc(b.ek)}</span>
      <textarea data-hf="ek" rows="4">${esc(v.ek)}</textarea></label>
    <div class="alan"><span>Görsel</span>
      ${v.gorsel ? `<img class="form-gorseli" src="${v.gorsel.startsWith('data:image/') ? v.gorsel : guvenliAdres(v.gorsel)}" alt="" referrerpolicy="no-referrer">
        <button type="button" class="metin-dugme sola" data-hafiza="gorsel-sil">Görseli kaldır</button>` : ''}
      <input type="file" accept="image/*" data-hafiza-dosya>
      <small>Fotoğraf çekebilir ya da galeriden seçebilirsin.</small></div>
    <div class="dugmeler">
      <button type="button" class="dugme" data-hafiza="vazgec">Vazgeç</button>
      <button type="button" class="dugme ana" data-hafiza="kaydet">Kaydet</button>
    </div>
  </div>`;
}

function gorselKucult(dosya) {
  return new Promise((coz, red) => {
    const okuyucu = new FileReader();
    okuyucu.onerror = () => red(new Error('Dosya okunamadı'));
    okuyucu.onload = () => {
      const resim = new Image();
      resim.onerror = () => red(new Error('Görsel açılamadı'));
      resim.onload = () => {
        const oran = Math.min(1, GORSEL_EN_BUYUK / Math.max(resim.width, resim.height));
        const tuval = document.createElement('canvas');
        tuval.width = Math.round(resim.width * oran);
        tuval.height = Math.round(resim.height * oran);
        tuval.getContext('2d').drawImage(resim, 0, 0, tuval.width, tuval.height);
        coz(tuval.toDataURL('image/jpeg', 0.75));
      };
      resim.src = okuyucu.result;
    };
    okuyucu.readAsDataURL(dosya);
  });
}

function hafizaKaydet() {
  const v = hafizaForm.veri;
  const baslik = v.baslik.trim();
  if (!baslik) { alert('Başlık boş olamaz.'); return; }
  const yeni = !v.id;
  const kart = {
    ...v,
    id: v.id || `k${Date.now().toString(36)}`,
    kategori: 'hafiza',
    baslik,
    yazar: (v.yazar || '').trim(),
    metin: metinParcala(v.metin),
    ek: (v.ek || '').trim(),
    olusturma: v.olusturma || new Date().toISOString(),
  };
  const oncekiKayit = depo.konular[kart.id] ? JSON.parse(JSON.stringify(depo.konular[kart.id])) : null;
  const k = kayit(kart);
  if (!k.kaydedildi) {
    k.kaydedildi = true;
    if (!k.yildiz) yildizDegistir(k); // eklenen/kaydedilen kart tekrara girer
  }
  if (!depoYaz()) {
    // yer kalmadı: değişikliği geri al
    if (oncekiKayit) depo.konular[kart.id] = oncekiKayit; else delete depo.konular[kart.id];
    alert('Kaydedilemedi: telefonda bu uygulamaya ayrılan yer doldu. Görseli kaldırıp tekrar dene.');
    return;
  }
  hafizaForm = null;
  location.replace(`#/hafiza/k/${encodeURIComponent(kart.id)}`);
  if (!yeni) ciz();
}

// ---------- olaylar ----------

const hafizadaMi = () => location.hash.startsWith('#/hafiza');

document.addEventListener('input', e => {
  const alan = e.target.dataset?.hf;
  if (!alan || !hafizaForm || !hafizadaMi()) return;
  hafizaForm.veri[alan] = e.target.value;
});

document.addEventListener('change', async e => {
  if (!e.target.matches?.('[data-hafiza-dosya]') || !hafizaForm) return;
  const dosya = e.target.files?.[0];
  if (!dosya) return;
  try {
    hafizaForm.veri.gorsel = await gorselKucult(dosya);
  } catch (hata) {
    alert(hata.message);
  }
  ciz();
});

document.addEventListener('click', e => {
  const d = e.target.closest('[data-hafiza]');
  if (!d || !hafizadaMi()) return;
  const eylem = d.dataset.hafiza;
  const deger = d.dataset.deger;
  if (eylem === 'suz') {
    hafizaSuzgec[d.dataset.bolum] = deger;
  } else if (eylem === 'alt') {
    hafizaForm.veri.alt = hafizaForm.veri.alt === deger ? '' : deger;
  } else if (eylem === 'kime') {
    const liste = hafizaForm.veri.kime;
    const i = liste.indexOf(deger);
    if (i >= 0) liste.splice(i, 1); else liste.push(deger);
  } else if (eylem === 'gorsel-sil') {
    hafizaForm.veri.gorsel = '';
  } else if (eylem === 'kaydet') {
    hafizaKaydet();
    return;
  } else if (eylem === 'vazgec') {
    hafizaForm = null;
    history.back();
    return;
  } else if (eylem === 'sil') {
    const kart = hafizaKarti(d.dataset.id);
    if (!confirm(`"${kart?.baslik || 'Bu kart'}" silinsin mi? Tekrardan da çıkar.`)) return;
    delete depo.konular[d.dataset.id];
    depoYaz();
    location.replace(`#/hafiza/b/${kart?.bolum || ''}`);
    return;
  }
  ciz();
});
