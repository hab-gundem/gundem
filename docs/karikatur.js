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
  if (location.hash.startsWith('#/ayarlar') || location.hash === '#/hafiza/b/karikatur') ciz();
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

function karikaturBuyukCiz() {
  document.querySelector('.karikatur-buyuk')?.remove();
  const i = karikatur.acik;
  if (i < 0 || !karikatur.adresler[i]) return;
  const n = karikatur.adresler.length;
  document.body.insertAdjacentHTML('beforeend', `<div class="karikatur-buyuk" data-karikatur="kapat">
    <img src="${karikatur.adresler[i].url}" alt="">
    <div class="karikatur-gezinme">
      <button type="button" class="dugme" data-karikatur="onceki" ${i ? '' : 'disabled'}>‹ Önceki</button>
      <span>${i + 1} / ${n}</span>
      <button type="button" class="dugme" data-karikatur="sonraki" ${i < n - 1 ? '' : 'disabled'}>Sonraki ›</button>
    </div>
  </div>`);
}

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
    karikatur.acik = Number(d.dataset.i); karikaturBuyukCiz();
  } else if (eylem === 'onceki' || eylem === 'sonraki') {
    e.stopPropagation();
    karikatur.acik += eylem === 'onceki' ? -1 : 1; karikaturBuyukCiz();
  } else if (eylem === 'kapat' && e.target.tagName !== 'BUTTON') {
    karikatur.acik = -1; karikaturBuyukCiz();
  }
});

window.addEventListener('hashchange', () => { karikatur.acik = -1; karikaturBuyukCiz(); });
