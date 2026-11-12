// Karikatür paketini oluşturur: resim klasörlerini (ya da tek bir zip'i) parolayla şifreleyip docs/karikatur.bin yazar.
// Kullanım:  node tarayici/karikatur_paketle.mjs <parola> <klasör> [klasör…]   ya da   <parola> <zip>
// Klasörlerin yalnızca kendi içindeki resimler alınır (alt klasörler alınmaz); zip'te hepsi tek dizinde: karikaturler/
// Uygulama bu dosyayı indirir, aynı parolayla açar (docs/karikatur.js). Biçim:
// "KRK1" + 16 bayt tuz + 12 bayt iv + AES-256-GCM şifreli zip (anahtar PBKDF2-SHA256, 200000 tur).
import { readFileSync, writeFileSync, statSync, readdirSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32 } from 'node:zlib';
import { webcrypto as crypto } from 'node:crypto';

const [parola, ...kaynaklar] = process.argv.slice(2);
if (!parola || !kaynaklar.length) {
  console.error('Kullanım: node tarayici/karikatur_paketle.mjs <parola> <klasör> [klasör…]  ya da  <parola> <zip>');
  process.exit(1);
}

// Klasörlerden sıkıştırmasız (resimler zaten sıkışık) zip yap; aynı ad iki klasörde varsa sonrakine ek konur
function klasordenZip(klasorler) {
  const dosyalar = [], adlar = new Set();
  klasorler.forEach((klasor, k) => {
    for (const a of readdirSync(klasor).filter(a => /\.(jpe?g|png|gif|webp)$/i.test(a)).sort()) {
      const ad = adlar.has(a.toLowerCase()) ? `${k + 1}-${a}` : a;
      adlar.add(ad.toLowerCase());
      dosyalar.push({ yol: join(klasor, a), ad });
    }
  });
  const yereller = [], merkez = [];
  let konum = 0;
  for (const { yol, ad } of dosyalar) {
    const veri = readFileSync(yol);
    const adB = Buffer.from(`karikaturler/${ad}`, 'utf8');
    const crc = crc32(veri);
    const y = Buffer.alloc(30);
    y.writeUInt32LE(0x04034b50, 0); y.writeUInt16LE(20, 4); y.writeUInt16LE(0x0800, 6);
    y.writeUInt32LE(crc, 14); y.writeUInt32LE(veri.length, 18); y.writeUInt32LE(veri.length, 22); y.writeUInt16LE(adB.length, 26);
    const m = Buffer.alloc(46);
    m.writeUInt32LE(0x02014b50, 0); m.writeUInt16LE(20, 4); m.writeUInt16LE(20, 6); m.writeUInt16LE(0x0800, 8);
    m.writeUInt32LE(crc, 16); m.writeUInt32LE(veri.length, 20); m.writeUInt32LE(veri.length, 24); m.writeUInt16LE(adB.length, 28);
    m.writeUInt32LE(konum, 42);
    yereller.push(y, adB, veri); merkez.push(m, adB);
    konum += 30 + adB.length + veri.length;
  }
  const merkezB = Buffer.concat(merkez);
  const son = Buffer.alloc(22);
  son.writeUInt32LE(0x06054b50, 0); son.writeUInt16LE(dosyalar.length, 8); son.writeUInt16LE(dosyalar.length, 10);
  son.writeUInt32LE(merkezB.length, 12); son.writeUInt32LE(konum, 16);
  console.log(`${dosyalar.length} resim`);
  return Buffer.concat([...yereller, merkezB, son]);
}

const zip = statSync(kaynaklar[0]).isDirectory() ? klasordenZip(kaynaklar) : readFileSync(kaynaklar[0]);
const tuz = crypto.getRandomValues(new Uint8Array(16));
const iv = crypto.getRandomValues(new Uint8Array(12));
const ham = await crypto.subtle.importKey('raw', new TextEncoder().encode(parola), 'PBKDF2', false, ['deriveKey']);
const anahtar = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: tuz, iterations: 200000, hash: 'SHA-256' },
  ham, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
const sifreli = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, anahtar, zip));
const hedef = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'karikatur.bin');
writeFileSync(hedef, Buffer.concat([Buffer.from('KRK1'), tuz, iv, sifreli]));
console.log(`${kaynaklar.map(k => basename(k)).join(' + ')} → docs/karikatur.bin (${(sifreli.length / 1e6).toFixed(1)} MB)`);
