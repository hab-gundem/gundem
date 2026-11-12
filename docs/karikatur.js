// Karikatürler: depodaki şifreli paket (karikatur.bin = parolayla AES-GCM şifrelenmiş zip)
// indirilir, uygulamanın içinde açılır ve resimler IndexedDB'de saklanır. Telefonun galerisi
// bu resimleri görmez. Parola yalnızca bu telefonda saklanır, depoda yoktur.
// Paket biçimi: "KRK1" + 16 bayt tuz + 12 bayt iv + şifreli zip (PBKDF2-SHA256, 200000 tur).
// Paketi bilgisayarda tarayici/karikatur_paketle.mjs oluşturur.

const KARIKATUR_PAKET = 'karikatur.bin';
const KARIKATUR_PAROLA = 'gundem-karikatur-parola';
const KARIKATUR_TARIH = 'gundem-karikatur-tarih';
const KARIKATUR_DB = 'gundem-karikatur';
let karikatur = { durum: '', calisiyor: false, sayi: null, adresler: [], acik: -1 };

const karikaturParola = () => { try { return localStorage.getItem(KARIKATUR_PAROLA) || ''; } catch { return ''; } };

function karikaturDb() {
  return new Promise((coz, red) => {
    const r = indexedDB.open(KARIKATUR_DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('resimler', { keyPath: 'ad' });
    r.onsuccess = () => coz(r.result);
    r.onerror = () => red(r.error);
  });
}

async function karikaturIslem(kip, is) {
  const db = await karikaturDb();
  return new Promise((coz, red) => {
    const t = db.transaction('resimler', kip);
    const sonuc = is(t.objectStore('resimler'));
    t.oncomplete = () => { db.close(); coz(sonuc?.result); };
    t.onerror = () => { db.close(); red(t.error); };
  });
}

const karikaturSay = () => karikaturIslem('readonly', s => s.count());
const karikaturHepsi = () => karikaturIslem('readonly', s => s.getAll());

// ---------- zip ----------
async function zipAc(tampon) {
  const v = new DataView(tampon);
  let son = -1;
  for (let i = tampon.byteLength - 22; i >= Math.max(0, tampon.byteLength - 65557); i--) {
    if (v.getUint32(i, true) === 0x06054b50) { son = i; break; }
  }
  if (son < 0) throw new Error('Zip okunamadı');
  const adet = v.getUint16(son + 10, true);
  let p = v.getUint32(son + 16, true);
  const cozucu = new TextDecoder();
  const dosyalar = [];
  for (let n = 0; n < adet; n++) {
    if (v.getUint32(p, true) !== 0x02014b50) throw new Error('Zip bozuk');
    const yontem = v.getUint16(p + 10, true);
    const boyut = v.getUint32(p + 20, true);
    const adUz = v.getUint16(p + 28, true), ekUz = v.getUint16(p + 30, true), notUz = v.getUint16(p + 32, true);
    const yerel = v.getUint32(p + 42, true);
    const ad = cozucu.decode(new Uint8Array(tampon, p + 46, adUz));
    p += 46 + adUz + ekUz + notUz;
    const uzanti = (ad.match(/\.(jpe?g|png|gif|webp)$/i) || [])[1];
    if (!uzanti) continue;
    const bas = yerel + 30 + v.getUint16(yerel + 26, true) + v.getUint16(yerel + 28, true);
    let veri = new Uint8Array(tampon, bas, boyut);
    if (yontem === 8) {
      veri = await new Response(new Blob([veri]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer();
    } else if (yontem !== 0) continue;
    const tur = { jpg: 'jpeg', jpeg: 'jpeg', png: 'png', gif: 'gif', webp: 'webp' }[uzanti.toLowerCase()];
    dosyalar.push({ ad: ad.split('/').pop(), blob: new Blob([veri], { type: `image/${tur}` }) });
  }
  return dosyalar;
}

async function paketCoz(tampon, parola) {
  const b = new Uint8Array(tampon);
  if (new TextDecoder().decode(b.slice(0, 4)) !== 'KRK1') throw new Error('Paket tanınmadı');
  const ham = await crypto.subtle.importKey('raw', new TextEncoder().encode(parola), 'PBKDF2', false, ['deriveKey']);
  const anahtar = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: b.slice(4, 20), iterations: 200000, hash: 'SHA-256' },
    ham, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  try {
    return await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b.slice(20, 32) }, anahtar, b.slice(32));
  } catch {
    throw new Error('Parola yanlış');
  }
}

// Paketi baştan indirir, eski resimleri silip yenilerini yazar
async function karikaturYenile() {
  const parola = karikaturParola();
  if (!parola || karikatur.calisiyor) return;
  karikatur.calisiyor = true;
  const durum = metin => { karikatur.durum = metin; karikaturCizGerekirse(); };
  try {
    durum('İndiriliyor…');
    const yanit = await fetch(`${KARIKATUR_PAKET}?t=${Date.now()}`, { cache: 'no-store' });
    if (!yanit.ok) throw new Error(yanit.status === 404 ? 'Depoda karikatür paketi yok' : `İndirilemedi (${yanit.status})`);
    const paket = await yanit.arrayBuffer();
    durum('Açılıyor…');
    const dosyalar = await zipAc(await paketCoz(paket, parola));
    await karikaturIslem('readwrite', s => { s.clear(); dosyalar.forEach(d => s.put(d)); });
    try { localStorage.setItem(KARIKATUR_TARIH, new Date().toISOString()); } catch {}
    karikatur.sayi = dosyalar.length;
    karikaturAdresleriBirak();
    durum(`${dosyalar.length} karikatür yüklendi.`);
  } catch (e) {
    durum(`Olmadı: ${e.message}`);
  } finally {
    karikatur.calisiyor = false;
    karikaturCizGerekirse();
  }
}

function karikaturAdresleriBirak() {
  karikatur.adresler.forEach(a => URL.revokeObjectURL(a.url));
  karikatur.adresler = [];
}

function karikaturCizGerekirse() {
  if (/^#\/(ayarlar|hafiza$|hafiza\/b\/karikatur)/.test(location.hash)) ciz();
}

// Uygulama açılınca: parola var, resim yoksa (ilk kez) indir
async function karikaturBaslat() {
  try {
    karikatur.sayi = await karikaturSay();
    if (!karikatur.sayi && karikaturParola()) karikaturYenile();
    else karikaturCizGerekirse();
  } catch {}
}

// ---------- Ayarlar bölümü ----------
function karikaturAyarBolumu() {
  const parola = karikaturParola();
  let tarih = '';
  try { tarih = localStorage.getItem(KARIKATUR_TARIH) || ''; } catch {}
  return `<section class="bolum"><h3>Karikatürler</h3>
    <div class="ayar-karti">
      <p class="bos-satir">Karikatürler depodan şifreli indirilir ve yalnızca bu uygulamanın içinde durur; galeride görünmez.
        ${karikatur.sayi ? `Şu an <b>${karikatur.sayi}</b> karikatür var${tarih ? ` (yüklendi: ${esc(saatYaz(tarih))})` : ''}.` : ''}</p>
      <label class="alan"><span>Parola</span>
        <input type="password" id="karikatur-parola" value="${esc(parola)}" autocomplete="off" spellcheck="false"></label>
      ${karikatur.durum ? `<p class="kaynak-notu" role="status">${esc(karikatur.durum)}</p>` : ''}
      <div class="dugmeler">
        <button type="button" class="dugme ana" data-karikatur="yenile" ${karikatur.calisiyor ? 'disabled' : ''}>
          ${karikatur.calisiyor ? 'Yükleniyor…' : 'Karikatürleri yenile'}</button>
      </div>
    </div>
  </section>`;
}

// ---------- Hafıza → Karikatürler: ızgara ve büyük görünüm ----------
function karikaturGaleri() {
  return `<section class="bolum"><h3>İndirilen karikatürler</h3><div id="karikatur-izgara" class="karikatur-izgara">
    <p class="bos-satir">${karikatur.calisiyor ? esc(karikatur.durum) : 'Yükleniyor…'}</p></div></section>`;
}

async function karikaturGaleriDoldur() {
  const kutu = document.getElementById('karikatur-izgara');
  if (!kutu) return;
  try {
    if (!karikatur.adresler.length) {
      const hepsi = (await karikaturHepsi()).sort((a, b) => a.ad.localeCompare(b.ad, 'tr', { numeric: true }));
      karikaturAdresleriBirak();
      karikatur.adresler = hepsi.map(r => ({ ad: r.ad, url: URL.createObjectURL(r.blob) }));
    }
  } catch { karikatur.adresler = []; }
  const kutu2 = document.getElementById('karikatur-izgara');
  if (!kutu2) return;
  kutu2.innerHTML = karikatur.adresler.length
    ? karikatur.adresler.map((a, i) => `<button type="button" data-karikatur="ac" data-i="${i}">
        <img src="${a.url}" alt="" loading="lazy"></button>`).join('')
    : `<p class="bos-satir">${karikatur.calisiyor ? esc(karikatur.durum)
      : karikaturParola() ? 'Henüz karikatür yok. Ayarlar → Karikatürleri yenile.' : 'Ayarlar → Karikatürler bölümüne parolayı yazıp yenile.'}</p>`;
}

// Tam ekran: X ya da telefonun geri tuşuyla kapanır. Resimler yan yana bir şeritte durur;
// sürüklerken yandaki resim görünür, bırakınca yumuşakça kayar. İki parmakla ya da çift
// dokunuşla yakınlaşır, yakınken tek parmakla gezilir. Ekran dönünce görünüm sıfırlanır.
const gorunum = { olcek: 1, x: 0, y: 0, kaydir: 0 };
const ARALIK = 16;          // resimler arası boşluk (px)
let gecisSuruyor = false;

const seritGenisligi = () => innerWidth + ARALIK;

function karikaturBuyukCiz() {
  let kutu = document.querySelector('.karikatur-buyuk');
  const i = karikatur.acik;
  if (i < 0 || !karikatur.adresler[i]) { kutu?.remove(); return; }
  if (!kutu) {
    document.body.insertAdjacentHTML('beforeend', `<div class="karikatur-buyuk">
      <button type="button" class="karikatur-kapat" data-karikatur="kapat" aria-label="Kapat">✕</button>
      <div class="karikatur-sahne"><div class="karikatur-serit">
        ${[-1, 0, 1].map(k => `<div class="karikatur-kare" data-k="${k}"><img alt="" draggable="false"></div>`).join('')}
      </div></div>
      <div class="karikatur-sayac"></div>
    </div>`);
    kutu = document.querySelector('.karikatur-buyuk');
    sahneBagla(kutu.querySelector('.karikatur-sahne'));
  }
  Object.assign(gorunum, { olcek: 1, x: 0, y: 0, kaydir: 0 });
  kutu.querySelectorAll('.karikatur-kare').forEach(kare => {
    const k = Number(kare.dataset.k);
    const adres = karikatur.adresler[i + k]?.url;
    const img = kare.querySelector('img');
    kare.style.transform = `translateX(${k * seritGenisligi()}px)`;
    img.style.transform = '';
    if (adres) { if (img.getAttribute('src') !== adres) img.src = adres; img.hidden = false; }
    else { img.removeAttribute('src'); img.hidden = true; }
  });
  kutu.querySelector('.karikatur-sayac').textContent = `${i + 1} / ${karikatur.adresler.length}`;
  donustur(false);
}

const ortaResim = () => document.querySelector('.karikatur-kare[data-k="0"] img');

function donustur(animasyon) {
  const serit = document.querySelector('.karikatur-serit');
  const img = ortaResim();
  if (!serit || !img) return;
  const gecis = animasyon ? 'transform .25s ease-out' : 'none';
  serit.style.transition = gecis;
  img.style.transition = gecis;
  serit.style.transform = `translateX(${gorunum.kaydir}px)`;
  img.style.transform = `translate(${gorunum.x}px, ${gorunum.y}px) scale(${gorunum.olcek})`;
}

// Yakınken resmin ekran dışına kaçmasını engelle
function sinirla() {
  const img = ortaResim();
  if (!img) return;
  // resim kutusu tüm ekranı kaplar (object-fit: contain); görünen resmin boyutunu doğal orandan hesapla
  const oran = Math.min(innerWidth / (img.naturalWidth || 1), innerHeight / (img.naturalHeight || 1));
  const gw = (img.naturalWidth || innerWidth) * oran, gy = (img.naturalHeight || innerHeight) * oran;
  const fx = Math.max(0, (gw * gorunum.olcek - innerWidth) / 2);
  const fy = Math.max(0, (gy * gorunum.olcek - innerHeight) / 2);
  gorunum.x = Math.min(fx, Math.max(-fx, gorunum.x));
  gorunum.y = Math.min(fy, Math.max(-fy, gorunum.y));
}

// Ekrandaki (cx, cy) noktası yerinde kalacak şekilde ölçeği değiştir
function olcekle(yeni, cx, cy) {
  yeni = Math.min(5, Math.max(1, yeni));
  const ox = cx - innerWidth / 2, oy = cy - innerHeight / 2;
  gorunum.x = ox - (ox - gorunum.x) * (yeni / gorunum.olcek);
  gorunum.y = oy - (oy - gorunum.y) * (yeni / gorunum.olcek);
  gorunum.olcek = yeni;
  if (yeni === 1) { gorunum.x = 0; gorunum.y = 0; }
}

// Şeridi bir resim kaydırıp, kayma bitince yeni sıraya göre yeniden diz
function karikaturGec(adim) {
  const yeni = karikatur.acik + adim;
  if (gecisSuruyor || yeni < 0 || yeni >= karikatur.adresler.length) return false;
  gecisSuruyor = true;
  gorunum.kaydir = -adim * seritGenisligi();
  donustur(true);
  const serit = document.querySelector('.karikatur-serit');
  let bitti = false;
  const bitir = () => {
    if (bitti) return;
    bitti = true;
    gecisSuruyor = false;
    karikatur.acik = yeni;
    karikaturBuyukCiz();
  };
  serit.addEventListener('transitionend', bitir, { once: true });
  setTimeout(bitir, 350);   // transitionend gelmezse
  return true;
}

function sahneBagla(sahne) {
  const parmak = new Map();
  let bas = null, ikili = null, sonDokunus = 0;
  sahne.addEventListener('pointerdown', e => {
    if (gecisSuruyor) return;
    sahne.setPointerCapture(e.pointerId);
    parmak.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (parmak.size === 1) {
      bas = { x: e.clientX, y: e.clientY, gx: gorunum.x, gy: gorunum.y, zaman: Date.now(), hareket: false };
    } else if (parmak.size === 2) {
      const [a, b] = [...parmak.values()];
      ikili = { mesafe: Math.hypot(a.x - b.x, a.y - b.y) || 1, olcek: gorunum.olcek };
      gorunum.kaydir = 0; bas = null;
    }
  });
  sahne.addEventListener('pointermove', e => {
    if (!parmak.has(e.pointerId)) return;
    parmak.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (parmak.size === 2 && ikili) {
      const [a, b] = [...parmak.values()];
      olcekle(ikili.olcek * Math.hypot(a.x - b.x, a.y - b.y) / ikili.mesafe, (a.x + b.x) / 2, (a.y + b.y) / 2);
      sinirla(); donustur(false);
    } else if (parmak.size === 1 && bas) {
      const dx = e.clientX - bas.x, dy = e.clientY - bas.y;
      if (Math.abs(dx) > 8 || Math.abs(dy) > 8) bas.hareket = true;
      if (gorunum.olcek > 1) {
        gorunum.x = bas.gx + dx; gorunum.y = bas.gy + dy; sinirla();
      } else {
        // ilk ya da son resimde kenara doğru çekince direnç
        const ucta = (dx > 0 && karikatur.acik === 0) || (dx < 0 && karikatur.acik === karikatur.adresler.length - 1);
        gorunum.kaydir = ucta ? dx * 0.3 : dx;
      }
      donustur(false);
    }
  });
  const birak = e => {
    if (!parmak.has(e.pointerId)) return;
    parmak.delete(e.pointerId);
    if (parmak.size === 1) {   // iki parmaktan biri kalktı: kalanla gezmeye devam
      const [k] = [...parmak.values()];
      bas = { x: k.x, y: k.y, gx: gorunum.x, gy: gorunum.y, zaman: 0, hareket: true };
      ikili = null;
      return;
    }
    if (parmak.size || !bas) { ikili = null; return; }
    const dx = e.clientX - bas.x;
    const hiz = Math.abs(dx) / Math.max(1, Date.now() - bas.zaman);   // hızlı fiske de geçirsin
    if (gorunum.olcek === 1 && (Math.abs(dx) > innerWidth * 0.25 || (Math.abs(dx) > 30 && hiz > 0.5))
        && karikaturGec(dx < 0 ? 1 : -1)) { bas = null; return; }
    gorunum.kaydir = 0;
    if (!bas.hareket && Date.now() - bas.zaman < 300) {   // çift dokunuş: yakınlaştır / geri al
      if (Date.now() - sonDokunus < 300) {
        olcekle(gorunum.olcek > 1 ? 1 : 2.5, e.clientX, e.clientY); sinirla(); sonDokunus = 0;
      } else sonDokunus = Date.now();
    }
    donustur(true);
    bas = null;
  };
  sahne.addEventListener('pointerup', birak);
  sahne.addEventListener('pointercancel', birak);
}

// Ekran dönünce (ya da boyut değişince) yakınlaştırmayı sıfırla, resmi yeni ekrana sığdır
let boyutZamanlayici = 0;
window.addEventListener('resize', () => {
  clearTimeout(boyutZamanlayici);
  boyutZamanlayici = setTimeout(() => { if (karikatur.acik >= 0 && !gecisSuruyor) karikaturBuyukCiz(); }, 100);
});

function karikaturAc(i) {
  karikatur.acik = i;
  history.pushState({ karikatur: true }, '');   // geri tuşu önce bu görünümü kapatsın
  karikaturBuyukCiz();
}

function karikaturKapat() {
  if (history.state?.karikatur) history.back();   // popstate kapatır
  else { karikatur.acik = -1; karikaturBuyukCiz(); }
}

window.addEventListener('popstate', () => {
  if (karikatur.acik >= 0 && !history.state?.karikatur) { karikatur.acik = -1; karikaturBuyukCiz(); }
});

document.addEventListener('click', e => {
  const d = e.target.closest('[data-karikatur]');
  if (!d) return;
  const eylem = d.dataset.karikatur;
  if (eylem === 'yenile') {
    const parola = document.getElementById('karikatur-parola')?.value.trim() || '';
    if (!parola) { karikatur.durum = 'Önce parolayı yaz.'; ciz(); return; }
    try { localStorage.setItem(KARIKATUR_PAROLA, parola); } catch {}
    karikaturYenile();
  } else if (eylem === 'ac') {
    karikaturAc(Number(d.dataset.i));
  } else if (eylem === 'kapat') {
    karikaturKapat();
  }
});

window.addEventListener('hashchange', () => { karikatur.acik = -1; karikaturBuyukCiz(); });
