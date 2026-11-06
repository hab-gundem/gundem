// Çevrimdışı okuma: uygulama dosyaları ve gundem.json önce ağdan alınıp önbelleğe
// yazılır, ağ yoksa son kaydedilen kullanılır (böylece güncellemeler hemen görünür).
// Kişi fotoğrafları görüldükçe önbelleğe alınır.

const SURUM = 'gundem-v8';
const KABUK = ['./', 'index.html', 'app.js', 'ayarlar.js', 'hafiza.js', 'style.css', 'manifest.webmanifest',
  'ikon.svg', 'ikon-192.png', 'ikon-512.png'];
const RESIM_ONBELLEGI = 'gundem-resimler';

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SURUM).then(c => c.addAll(KABUK)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(adlar => Promise.all(adlar.filter(a => a !== SURUM && a !== RESIM_ONBELLEGI).map(a => caches.delete(a))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const istek = e.request;
  if (istek.method !== 'GET') return;
  const adres = new URL(istek.url);

  if (adres.origin === location.origin) {
    e.respondWith(
      fetch(istek)
        .then(yanit => {
          if (yanit.ok) {
            const kopya = yanit.clone();
            caches.open(SURUM).then(c => c.put(istek, kopya));
          }
          return yanit;
        })
        .catch(() => caches.match(istek, { ignoreSearch: true }))
    );
    return;
  }

  // yalnızca Wikipedia kişi fotoğrafları önbelleğe alınır; haber görselleri çok olduğundan
  // (ve her biri önbellekte büyük yer kapladığından) doğrudan ağdan gelir
  if (istek.destination === 'image' && adres.hostname.endsWith('wikimedia.org')) {
    e.respondWith(
      caches.open(RESIM_ONBELLEGI).then(c => c.match(istek).then(kayitli => kayitli ||
        fetch(istek).then(yanit => { c.put(istek, yanit.clone()); return yanit; })))
    );
  }
});
