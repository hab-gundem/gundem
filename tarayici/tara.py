"""Gündem tarayıcı: Google Haberler + Trends + RSS + Wikipedia -> docs/gundem.json

Yalnızca Python standart kütüphanesi kullanır. Çalıştırma:  python tarayici/tara.py
"""

import datetime as dt
import email.utils
import hashlib
import html
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

KOK = Path(__file__).resolve().parent.parent
CIKTI = KOK / "docs" / "gundem.json"  # docs/ = PWA klasörü (GitHub Pages buradan yayınlar)
AYARLAR = Path(__file__).resolve().parent / "ayarlar.json"  # uygulamadaki Ayarlar ekranı buraya yazar

UA_TARAYICI = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) GundemTarayici/0.1"
# Wikimedia, iletişim adresi olan isteklere daha az kısıtlama uyguluyor; GitHub Actions depo adresini verir
UA_WIKI = f"GundemTarayici/0.1 ({os.environ.get('GUNDEM_ILETISIM', 'kisisel, ticari olmayan kullanim')})"
ZAMAN_ASIMI = 20

# Konu sayılarının varsayılanları; ayarlar.json'daki değerler bunların yerine geçer
KONU_SAYISI = 10
SPOR_SAYISI = 6
HABER_ORANI = 0.7  # gündemin bu kadarı Google Haberler'den, kalanı Trends'ten doldurulur
GECMIS_EN_FAZLA = 8
KISI_EN_FAZLA = 3

GOOGLE_HABERLER = "https://news.google.com/rss?hl=tr&gl=TR&ceid=TR:tr"
GOOGLE_SPOR = "https://news.google.com/rss/headlines/section/topic/SPORTS?hl=tr&gl=TR&ceid=TR:tr"
GOOGLE_ARAMA = "https://news.google.com/rss/search?q={q}&hl=tr&gl=TR&ceid=TR:tr"
TRENDS = "https://trends.google.com/trending/rss?geo=TR"
RSS_KAYNAKLARI = {
    "BBC Türkçe": "https://feeds.bbci.co.uk/turkce/rss.xml",
    "DW Türkçe": "https://rss.dw.com/rdf/rss-tur-all",
    "Euronews": "https://tr.euronews.com/rss",
    "NTV": "https://www.ntv.com.tr/gundem.rss",
    # spor özetleri için
    "Sporx": "https://www.sporx.com/_xml/rss.php",
    "A Spor": "https://www.aspor.com.tr/rss/anasayfa.xml",
    "Ajansspor": "https://www.ajansspor.com/rss",
}

# Gündem ya da Trends'ten gelen bir konunun spor olup olmadığını anlamak için
SPOR_KELIMELERI = re.compile(
    r"(?<!\w)(maç|gol|futbol|basketbol|voleybol|tenis|transfer|teknik direktör|süper lig|"
    r"şampiyonlar ligi|avrupa ligi|konferans ligi|derbi|galatasaray|fenerbahçe|beşiktaş|"
    r"trabzonspor|başakşehir|milli takım|formula|nba|euroleague|olimpiyat|antrenör|kupa|"
    r"hakem|penaltı|kaleci|forvet|stoper|puan durumu|fikstür|uefa|fifa|spor)",
    re.IGNORECASE)

ETKISIZ = set("""
ve ile de da ki bu şu o bir için gibi daha en çok mi mı mu mü ne neden nasıl
ama fakat ya veya hem ise olan oldu olarak sonra önce kadar göre karşı üzere
son dakika flaş açıklama açıkladı açıklandı yeni ilk tüm her hiç var yok
haber haberi haberleri video foto galeri canlı izle belli oldu nedir kimdir
geldi etti edildi yaptı dedi dakika saat bugün dün yarın yıl ay gün
""".split())

# İsim dizisini bölen unvan/kurum kelimeleri ("Cumhurbaşkanı Erdoğan" -> "Erdoğan")
UNVANLAR = set("""
cumhurbaşkanı başkanı başkan bakanı bakan bakanlığı belediye belediyesi genel müdürü
milletvekili vekili valisi vali sözcüsü lideri teknik direktör hoca kaptan eski
türkiye türk ab abd nato bm meclis tbmm hükümet parti partisi kulübü
""".split())

KISA_EKLER = re.compile(r"[’'`].*$")
KELIME = re.compile(r"[0-9A-Za-zÇĞİÖŞÜçğıöşüÂâÎîÛû]+(?:[’'][a-zçğıöşü]+)?")
BUYUK_HARF = "ABCÇDEFGĞHIİJKLMNOÖPRSŞTUÜVYZQWX"


# ---------- yardımcılar ----------

def tr_kucuk(s: str) -> str:
    return s.replace("I", "ı").replace("İ", "i").lower()


def kok(kelime: str) -> str:
    """Kaba gövde: kesme işaretinden sonrasını at, ilk 5 harfi al."""
    return tr_kucuk(KISA_EKLER.sub("", kelime))[:5]


def anlamli_kelimeler(metin: str) -> list[str]:
    sonuc = []
    for k in KELIME.findall(metin):
        temiz = KISA_EKLER.sub("", k)
        if len(temiz) < 3 or tr_kucuk(temiz) in ETKISIZ:
            continue
        sonuc.append(temiz)
    return sonuc


def kok_kumesi(metin: str) -> set[str]:
    return {kok(k) for k in anlamli_kelimeler(metin)}


def getir(url: str, ua: str = UA_TARAYICI) -> bytes:
    istek = urllib.request.Request(url, headers={"User-Agent": ua})
    for deneme in range(4):
        try:
            with urllib.request.urlopen(istek, timeout=ZAMAN_ASIMI) as yanit:
                return yanit.read()
        except urllib.error.HTTPError as e:
            if e.code != 429 or deneme == 3:
                raise
            # çok istek: sunucunun istediği kadar (yoksa 5, 10, 20 sn) bekle
            bekle = e.headers.get("Retry-After", "")
            sure = int(bekle) if bekle.isdigit() else 5 * 2 ** deneme
            uyari(f"429, {sure} sn bekleniyor: {urllib.parse.urlsplit(url).netloc}")
            time.sleep(sure)
        except (TimeoutError, urllib.error.URLError) as e:
            if deneme == 3:
                raise
            uyari(f"Bağlantı sorunu, yeniden deneniyor ({urllib.parse.urlsplit(url).netloc}): {e}")
            time.sleep(3)


_wiki_son_istek = 0.0
WIKI_ARALIK = 1.0  # Wikimedia istekleri arası en az bu kadar saniye


def getir_json(url: str):
    """Wikimedia API isteği; art arda isteklerde 429 almamak için aralıklı gönderir."""
    global _wiki_son_istek
    bekle = _wiki_son_istek + WIKI_ARALIK - time.monotonic()
    if bekle > 0:
        time.sleep(bekle)
    try:
        return json.loads(getir(url, UA_WIKI))
    finally:
        _wiki_son_istek = time.monotonic()


def html_temizle(s: str | None) -> str:
    if not s:
        return ""
    s = re.sub(r"<[^>]+>", " ", s)
    s = html.unescape(s)
    return re.sub(r"\s+", " ", s).strip()


def tarih_coz(s: str | None) -> str | None:
    if not s:
        return None
    try:
        return email.utils.parsedate_to_datetime(s).astimezone(dt.timezone.utc).isoformat()
    except (TypeError, ValueError):
        pass
    try:  # RDF/Atom: 2026-10-29T10:00:00+01:00
        return dt.datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(dt.timezone.utc).isoformat()
    except ValueError:
        return None


def baslik_kaynak_ayir(baslik: str) -> tuple[str, str]:
    """Google Haberler başlıkları 'Başlık - Kaynak' biçimindedir."""
    if " - " in baslik:
        b, k = baslik.rsplit(" - ", 1)
        return b.strip(), k.strip()
    return baslik.strip(), ""


def uyari(msg: str) -> None:
    print(f"  ! {msg}", file=sys.stderr)


# ---------- kaynaklar ----------

def rss_ogeleri(xml_bayt: bytes) -> list[dict]:
    """RSS 2.0, RDF ve Atom öğelerini düz sözlüklere çevirir."""
    kok_eleman = ET.fromstring(xml_bayt)
    ogeler = []
    for oge in kok_eleman.iter():
        etiket = oge.tag.rsplit("}", 1)[-1]
        if etiket not in ("item", "entry"):
            continue
        alanlar = {}
        for c in oge:
            ad = c.tag.rsplit("}", 1)[-1]
            if ad == "link" and c.get("href"):
                alanlar.setdefault("link", c.get("href"))
            else:
                alanlar.setdefault(ad, (c.text or "").strip())
        ogeler.append({
            "baslik": html_temizle(alanlar.get("title")),
            "link": alanlar.get("link", ""),
            "aciklama": html_temizle(alanlar.get("description") or alanlar.get("summary")),
            "ham_aciklama": alanlar.get("description", ""),
            "tarih": tarih_coz(alanlar.get("pubDate") or alanlar.get("date")
                              or alanlar.get("published") or alanlar.get("updated")),
        })
    return ogeler


def google_haberler_konulari(adres: str = GOOGLE_HABERLER) -> list[dict]:
    """En çok okunanlar (ya da bir bölüm, ör. spor): her öğe birden fazla kaynağın haberinden oluşan bir kümedir."""
    konular = []
    for oge in rss_ogeleri(getir(adres)):
        baslik, kaynak = baslik_kaynak_ayir(oge["baslik"])
        haberler = []
        for link, metin, kaynak2 in re.findall(
                r'<a href="([^"]+)"[^>]*>(.*?)</a>(?:&nbsp;|\s)*<font[^>]*>(.*?)</font>',
                oge["ham_aciklama"]):
            haberler.append({"baslik": html_temizle(metin), "kaynak": html_temizle(kaynak2),
                             "link": html.unescape(link), "tarih": oge["tarih"]})
        if not haberler:
            haberler = [{"baslik": baslik, "kaynak": kaynak, "link": oge["link"], "tarih": oge["tarih"]}]
        konular.append({"baslik": baslik, "tur": "haberler", "tarih": oge["tarih"], "haberler": haberler})
    return konular


def trafik_sayisi(s: str) -> int:
    return int(re.sub(r"\D", "", s) or 0)


# Her gün aranan ama sohbete konu olmayan terimler
TREND_GURULTU = re.compile(
    r"ezan|namaz|iftar|sahur|imsak|hava durumu|saat kaç|loto|şans topu|piyango|"
    r"altın fiyat|dolar|euro|döviz|burç|maç özeti|canlı izle|şifre|giriş|sorgula|"
    r"kesinti|hutbe|eczane|kaçta|ne zaman|başvuru|tatil mi|yayın akışı",
    re.IGNORECASE)


def trend_anlamli(terim: str, haberler: list[dict]) -> bool:
    if TREND_GURULTU.search(terim) or len(haberler) < 2:
        return False
    # Terim kendi haber başlıklarında hiç geçmiyorsa bağlantı zayıftır ("Transfermarkt")
    if not kok_kumesi(terim) <= kok_kumesi(" ".join(h["baslik"] for h in haberler)):
        return False
    if len(terim.split()) == 1:
        # Tek kelime ancak cümle ortasında hep büyük harfle geçiyorsa özel addır;
        # küçük harfle geçiyor ya da hiç cümle ortasında geçmiyorsa sıradan kelimedir ("Ödeme").
        desen = re.compile(rf"(?<![\wçğıöşü]){re.escape(tr_kucuk(terim))}", re.IGNORECASE)
        ortada = [m.group(0) for h in haberler for m in desen.finditer(h["baslik"]) if m.start() > 0]
        if not ortada or any(k[:1].islower() for k in ortada):
            return False
    return True


def trends_konulari() -> list[dict]:
    ns = {"ht": "https://trends.google.com/trending/rss"}
    kok_eleman = ET.fromstring(getir(TRENDS))
    konular = []
    for oge in kok_eleman.iter("item"):
        terim = (oge.findtext("title") or "").strip()
        haberler = []
        for h in oge.findall("ht:news_item", ns):
            haberler.append({
                "baslik": html_temizle(h.findtext("ht:news_item_title", "", ns)),
                "kaynak": h.findtext("ht:news_item_source", "", ns),
                "link": h.findtext("ht:news_item_url", "", ns),
                "tarih": tarih_coz(oge.findtext("pubDate")),
                "ozet": html_temizle(h.findtext("ht:news_item_snippet", "", ns)),
            })
        if not trend_anlamli(terim, haberler):
            continue
        konular.append({
            "baslik": " ".join(k[:1].replace("i", "İ").upper() + k[1:] for k in terim.split()),
            "tur": "trends",
            "terim": terim,
            "trafik": trafik_sayisi(oge.findtext("ht:approx_traffic", "", ns)),
            "tarih": tarih_coz(oge.findtext("pubDate")),
            "haberler": haberler,
        })
    konular.sort(key=lambda k: k["trafik"], reverse=True)
    return konular


def rss_havuzu() -> list[dict]:
    havuz = []
    for ad, url in RSS_KAYNAKLARI.items():
        try:
            for oge in rss_ogeleri(getir(url)):
                oge["kaynak"] = ad
                oge["kokler"] = kok_kumesi(oge["baslik"] + " " + oge["aciklama"])
                havuz.append(oge)
        except Exception as e:  # bir kaynak çökerse diğerleri devam eder
            uyari(f"{ad} okunamadı: {e}")
    return havuz


# ---------- ayarlar (tarayici/ayarlar.json) ----------

def _sayi(deger, varsayilan: int, en_az: int, en_cok: int) -> int:
    try:
        return max(en_az, min(en_cok, int(deger)))
    except (TypeError, ValueError):
        return varsayilan


def ayarlari_oku() -> tuple[list[dict], int, int]:
    """(spor seçimleri, gündem konu sayısı, genel spor konu sayısı) döndürür.

    Dosya yoksa ya da bozuksa varsayılanlarla devam edilir; adı boş seçimler atlanır.
    """
    try:
        veri = json.loads(AYARLAR.read_text(encoding="utf-8"))
    except FileNotFoundError:
        veri = {}
    except (json.JSONDecodeError, OSError) as e:
        uyari(f"Ayarlar okunamadı ({AYARLAR.name}): {e}")
        veri = {}
    secimler = [s for s in veri.get("spor_secimleri", []) if isinstance(s, dict) and str(s.get("ad", "")).strip()]
    for s in secimler:
        s["ad"] = s["ad"].strip()
        if not str(s.get("arama", "")).strip():
            s.pop("arama", None)
        if not [b for b in s.get("baslikta", []) if str(b).strip()]:
            s.pop("baslikta", None)
        s["gun"] = _sayi(s.get("gun"), 3, 1, 30)
        s["adet"] = _sayi(s.get("adet"), 4, 1, 10)
    return (secimler,
            _sayi(veri.get("gundem_konu_sayisi"), KONU_SAYISI, 1, 20),
            _sayi(veri.get("genel_spor_konu_sayisi"), SPOR_SAYISI, 0, 15))


def secim_konulari(secim: dict) -> list[dict]:
    """Seçim için Google Haberler'de arar; aynı olayı anlatan başlıkları tek konuda toplar.

    Konular, kaç sitenin yazdığına göre (önem) sıralanır.
    """
    ad = secim["ad"]
    sorgu = f"{secim.get('arama', ad)} when:{secim.get('gun', 3)}d"
    try:
        ogeler = rss_ogeleri(getir(GOOGLE_ARAMA.format(q=urllib.parse.quote(sorgu))))
    except Exception as e:
        uyari(f"Seçim araması başarısız ({ad}): {e}")
        return []
    gerekenler = [kok_kumesi(b) for b in secim.get("baslikta", [ad])]
    ortak_kokler = set().union(*gerekenler)  # her başlıkta geçen ad, benzerlik ölçümüne katılmaz
    kumeler: list[dict] = []
    for oge in ogeler:
        baslik, kaynak = baslik_kaynak_ayir(oge["baslik"])
        kokler = kok_kumesi(baslik)
        if bozuk_baslik(baslik) or not any(g and g <= kokler for g in gerekenler):
            continue
        haber = {"baslik": baslik, "kaynak": kaynak, "link": oge["link"], "tarih": oge["tarih"]}
        ayirt = kokler - ortak_kokler
        for kume in kumeler:
            ortak = len(ayirt & kume["kokler"])
            if ortak >= 3 or (ayirt and ortak / len(ayirt) >= 0.5):
                kume["haberler"].append(haber)
                kume["kokler"] |= ayirt
                break
        else:
            kumeler.append({"kokler": set(ayirt), "haberler": [haber]})
    kumeler.sort(key=lambda k: (len(k["haberler"]), max(h["tarih"] or "" for h in k["haberler"])), reverse=True)
    konular = []
    for kume in kumeler[:secim.get("adet", 4)]:
        haberler = sorted(kume["haberler"], key=lambda h: h["tarih"] or "", reverse=True)[:5]
        konular.append({"baslik": kume["haberler"][0]["baslik"], "tur": "secim", "secim": ad,
                        "kategori": "spor", "tarih": haberler[0]["tarih"], "haberler": haberler,
                        "gerekenler": gerekenler})
    return konular


# ---------- konu işleme ----------

def konu_kokleri(konu: dict) -> set[str]:
    metin = konu["baslik"] + " " + " ".join(h["baslik"] for h in konu["haberler"])
    return kok_kumesi(metin)


def ayni_konu_mu(a: dict, b: dict) -> bool:
    ka, kb = konu_kokleri(a), konu_kokleri(b)
    if not ka or not kb:
        return False
    # Kümeler çok başlıktan oluşur; birkaç sıradan kelimenin örtüşmesi aynı konu demek değildir
    ortak = len(ka & kb)
    oran = ortak / min(len(ka), len(kb))
    return (ortak >= 2 and oran >= 0.5) or (ortak >= 4 and oran >= 0.3)


def spor_mu(konu: dict) -> bool:
    """Spor bölümünden geldiyse ya da başlıklarda en az 2 spor kelimesi geçiyorsa."""
    if konu.get("kaynak_bolum") == "spor":
        return True
    metin = konu["baslik"] + " " + " ".join(h["baslik"] for h in konu["haberler"])
    return len(SPOR_KELIMELERI.findall(metin)) >= 2


def arama_sorgusu(konu: dict) -> str:
    if konu["tur"] == "trends":
        return konu["terim"]
    # Kısa sorgu en iyi sonucu veriyor: önce cümle ortasındaki özel adlar,
    # sonra cümle başı kelimeler, sonra uzun sıradan kelimeler; en fazla 3 kelime.
    adaylar = []
    for parca in re.split(r"[:!?.…]+", konu["baslik"]):
        for i, k in enumerate(anlamli_kelimeler(parca)):
            if k[0] in BUYUK_HARF and not k.isupper():
                oncelik = 1 if i == 0 else 0
            else:
                oncelik = 2
            adaylar.append((oncelik, -len(k) if oncelik == 2 else len(adaylar), k))
    secilen = []
    for _, _, k in sorted(adaylar):
        if tr_kucuk(k) not in UNVANLAR and k not in secilen:
            secilen.append(k)
        if len(secilen) == 3:
            break
    return " ".join(secilen)


def ozet_bul(konu: dict, havuz: list[dict]) -> tuple[str, str]:
    """En iyi eşleşen RSS öğesinin açıklamasını özet olarak alır; yoksa başlıklardan kurar."""
    kokler = konu_kokleri(konu)
    # Konunun çekirdek kelimeleri (arama sorgusu) özette mutlaka geçmeli
    cekirdek = kok_kumesi(arama_sorgusu(konu))
    gerekli = min(2, len(cekirdek))
    en_iyi, en_iyi_skor = None, 0
    # Spor seçimi konusunda seçimin adı (ya da eş anlamlısı) da geçmeli
    gerekenler = konu.get("gerekenler") or []
    for oge in havuz:
        if len(oge["aciklama"]) < 40 or len(cekirdek & oge["kokler"]) < gerekli:
            continue
        if gerekenler and not any(g and g <= oge["kokler"] for g in gerekenler):
            continue
        skor = len(kokler & oge["kokler"])
        if skor > en_iyi_skor:
            en_iyi, en_iyi_skor = oge, skor
    if en_iyi and en_iyi_skor >= 3:
        return cumle_kirp(en_iyi["aciklama"], 3), en_iyi["kaynak"]
    for h in konu["haberler"]:
        if h.get("ozet") and len(h["ozet"]) >= 40:
            return cumle_kirp(h["ozet"], 3), h["kaynak"]
    basliklar = []
    for h in konu["haberler"]:
        if bozuk_baslik(h["baslik"]):
            continue
        b = h["baslik"].rstrip(".…") + "."
        if b not in basliklar:
            basliklar.append(b)
        if len(basliklar) == 3:
            break
    return " ".join(basliklar), "başlıklar"


def bozuk_baslik(baslik: str) -> bool:
    """Spam/bozuk başlık: harf oranı düşük ya da harfler aralıklı ('V I V O y D i r e c t o')."""
    harf = sum(c.isalpha() for c in baslik)
    return harf < 0.6 * len(baslik.replace(" ", "")) or bool(re.search(r"(?:\b\w ){5,}", baslik))


def cumle_kirp(metin: str, adet: int) -> str:
    cumleler = re.split(r"(?<=[.!?])\s+", metin)
    return " ".join(cumleler[:adet]).strip()


def gecmis_haberler(konu: dict) -> list[dict]:
    """Konuyu Google Haberler'de arar (son günler + 'before:' ile daha eskisi).

    Sorgu kelimeleriyle örtüşmeyenler atılır; kalanlar zaman çizgisine yayılarak
    eskiden yeniye dizilir.
    """
    sorgu = arama_sorgusu(konu)
    if not sorgu:
        return []
    simdi = dt.datetime.now(dt.timezone.utc)
    eski_sinir = (simdi - dt.timedelta(days=5)).strftime("%Y-%m-%d")
    ogeler = []
    for q in (sorgu, f"{sorgu} before:{eski_sinir}"):
        try:
            ogeler += rss_ogeleri(getir(GOOGLE_ARAMA.format(q=urllib.parse.quote(q))))
        except Exception as e:
            uyari(f"Geçmiş araması başarısız ({q}): {e}")
    sorgu_kokleri = kok_kumesi(sorgu)
    gerekli = min(2, len(sorgu_kokleri))
    esik = (simdi - dt.timedelta(days=1)).isoformat()
    guncel_basliklar = {tr_kucuk(h["baslik"]) for h in konu["haberler"]}
    gecmis, gorulen = [], set()
    for oge in ogeler:
        baslik, kaynak = baslik_kaynak_ayir(oge["baslik"])
        anahtar = tr_kucuk(baslik)
        if not oge["tarih"] or oge["tarih"] >= esik or anahtar in gorulen or anahtar in guncel_basliklar:
            continue
        if len(kok_kumesi(baslik) & sorgu_kokleri) < gerekli:
            continue
        gorulen.add(anahtar)
        gecmis.append({"baslik": baslik, "kaynak": kaynak, "link": oge["link"], "tarih": oge["tarih"]})
    gecmis.sort(key=lambda h: h["tarih"])
    n = len(gecmis)
    if n > GECMIS_EN_FAZLA:  # zaman çizgisine eşit aralıkla yay, en yeniyi koru
        gecmis = [gecmis[round(i * (n - 1) / (GECMIS_EN_FAZLA - 1))] for i in range(GECMIS_EN_FAZLA)]
    return gecmis


# ---------- kişiler (Wikipedia + Wikidata) ----------
# Wikimedia art arda çok isteğe 429 veriyor. Bu yüzden konu konu değil, tüm
# konuların adayları toplanıp az sayıda toplu istekle sorgulanır.

WIKI_API = "https://tr.wikipedia.org/w/api.php"


def aday_isimler(metinler: list[str]) -> tuple[list[str], list[str]]:
    """Büyük harfli kelime dizilerinden aday adlar çıkarır.

    Dönüş: (2-3 kelimelik adaylar, tek kelimelik adaylar), ikisi de sıklığa göre.
    """
    coklu: dict[str, int] = {}
    tekli: dict[str, int] = {}
    for metin in metinler:
        kelimeler = [KISA_EKLER.sub("", k) for k in KELIME.findall(metin)]
        i = 0
        while i < len(kelimeler):
            j = i
            while j < len(kelimeler) and kelimeler[j][:1] in BUYUK_HARF and not kelimeler[j].isupper() \
                    and tr_kucuk(kelimeler[j]) not in ETKISIZ and tr_kucuk(kelimeler[j]) not in UNVANLAR:
                j += 1
            for uzunluk in (3, 2):
                for s in range(i, j - uzunluk + 1):
                    ad = " ".join(kelimeler[s:s + uzunluk])
                    coklu[ad] = coklu.get(ad, 0) + 1
            for k in kelimeler[i:j]:
                if len(k) >= 4:
                    tekli[k] = tekli.get(k, 0) + 1
            i = max(j, i + 1)
    # Metinde küçük harfle de geçen kelime özel ad değildir ("Sağanak yağış ... sağanak")
    kucukler = {k for m in metinler for k in KELIME.findall(m) if k[:1].islower()}
    tekli = {k: n for k, n in tekli.items() if tr_kucuk(k) not in kucukler}
    sirala = lambda d: sorted(d, key=lambda a: -d[a])  # noqa: E731
    return sirala(coklu)[:8], sirala(tekli)[:5]


def _wiki_sorgu(**parametre) -> dict:
    q = urllib.parse.urlencode({"action": "query", "format": "json", **parametre})
    return getir_json(f"{WIKI_API}?{q}").get("query", {})


def wiki_basliklari(adlar: list[str]) -> dict[str, tuple[str, str]]:
    """ad -> (sayfa başlığı, Wikidata kimliği), 50'şerli isteklerle.

    Yönlendirmeleri izler ('Bahçeli' -> 'Devlet Bahçeli'); anlam ayrımı ve olmayan sayfalar düşer.
    """
    sonuc = {}
    for i in range(0, len(adlar), 50):
        parti = adlar[i:i + 50]
        try:
            yanit = _wiki_sorgu(titles="|".join(parti), redirects=1, prop="pageprops",
                                ppprop="wikibase_item|disambiguation")
        except Exception as e:
            uyari(f"Wikipedia başlık sorgusu: {e}")
            continue
        hedef = {a: a for a in parti}
        for adim in ("normalized", "redirects"):
            donusum = {d["from"]: d["to"] for d in yanit.get(adim, [])}
            hedef = {a: donusum.get(t, t) for a, t in hedef.items()}
        qid = {s["title"]: s["pageprops"]["wikibase_item"] for s in yanit.get("pages", {}).values()
               if "wikibase_item" in s.get("pageprops", {}) and "disambiguation" not in s["pageprops"]}
        for a, t in hedef.items():
            if t in qid:
                sonuc[a] = (t, qid[t])
    return sonuc


def wiki_ara(ad: str) -> list[str]:
    """Tek kelimelik ad için ilk 5 arama sonucundan son kelimesi bu ad olan başlıklar."""
    try:
        yanit = _wiki_sorgu(list="search", srsearch=ad, srlimit=5, srprop="")
    except Exception as e:
        uyari(f"Wikipedia araması ({ad}): {e}")
        return []
    basliklar = []
    for s in yanit.get("search", []):
        kelimeler = re.sub(r"\s*\(.*\)$", "", s["title"]).split()
        if len(kelimeler) > 1 and tr_kucuk(kelimeler[-1]) == tr_kucuk(ad):
            basliklar.append(s["title"])
    return basliklar


def wikidata_insanlar(qidler: set[str]) -> dict[str, dict]:
    """Q kimliklerinden insan (Q5) olanlar -> {aciklama, yasiyor}. Tek SPARQL sorgusu."""
    if not qidler:
        return {}
    sorgu = """SELECT ?q ?olum ?dtr ?den WHERE {
  VALUES ?q { %s }
  ?q wdt:P31 wd:Q5 .
  OPTIONAL { ?q wdt:P570 ?olum }
  OPTIONAL { ?q schema:description ?dtr FILTER(LANG(?dtr) = "tr") }
  OPTIONAL { ?q schema:description ?den FILTER(LANG(?den) = "en") }
}""" % " ".join("wd:" + q for q in sorted(qidler))
    try:
        yanit = getir_json("https://query.wikidata.org/sparql?"
                           + urllib.parse.urlencode({"query": sorgu, "format": "json"}))
    except Exception as e:
        uyari(f"Wikidata sorgusu: {e}")
        return {}
    sonuc = {}
    for satir in yanit["results"]["bindings"]:
        q = satir["q"]["value"].rsplit("/", 1)[-1]
        kayit = sonuc.setdefault(q, {"aciklama": "", "yasiyor": True})
        if "olum" in satir:  # P570: ölüm tarihi
            kayit["yasiyor"] = False
        kayit["aciklama"] = kayit["aciklama"] or satir.get("dtr", satir.get("den", {})).get("value", "")
    return sonuc


def wiki_ayrintilar(basliklar: list[str]) -> dict[str, dict]:
    """Sayfa başlığı -> giriş özeti, adres, küçük resim (özet en fazla 20 sayfa/istek)."""
    sonuc = {}
    for i in range(0, len(basliklar), 20):
        try:
            yanit = _wiki_sorgu(titles="|".join(basliklar[i:i + 20]), prop="extracts|pageimages|info",
                                exintro=1, explaintext=1, exsentences=3, exlimit=20,
                                pithumbsize=200, inprop="url")
        except Exception as e:
            uyari(f"Wikipedia ayrıntıları: {e}")
            continue
        for s in yanit.get("pages", {}).values():
            sonuc[s["title"]] = {"ozet": s.get("extract", ""), "link": s.get("fullurl", ""),
                                 "resim": s.get("thumbnail", {}).get("source")}
    return sonuc


def kisileri_bul(konular: list[dict], ozetler: list[str], gecmisler: list[list[dict]]) -> list[list[dict]]:
    """Her konu için en fazla KISI_EN_FAZLA kişi; tüm konular birlikte sorgulanır.

    Geçmiş haber başlıkları iki işe yarar: bugünkü başlıktaki soyadı tamamlar
    ('Dervişoğlu' -> 'Müsavat Dervişoğlu') ve doğru kişiyi seçmek için bağlamı zenginleştirir.
    """
    hazirlik = []
    for konu, ozet, gecmis in zip(konular, ozetler, gecmisler):
        metinler = [konu["baslik"], ozet] + [h["baslik"] for h in konu["haberler"]]
        gecmis_basliklar = [h["baslik"] for h in gecmis]
        coklu, tekli = aday_isimler(metinler)
        tamamlanan = []
        for soyad in tekli:
            onceki: dict[str, int] = {}
            for b in gecmis_basliklar:
                for m in re.finditer(rf"(?<!\w)([{BUYUK_HARF}][a-zçğıöşüâîû]+) {re.escape(soyad)}(?!\w)", b):
                    if tr_kucuk(m.group(1)) not in UNVANLAR | ETKISIZ:
                        onceki[m.group(1)] = onceki.get(m.group(1), 0) + 1
            if onceki:
                ad = max(onceki, key=onceki.get) + " " + soyad
                if ad not in coklu:
                    tamamlanan.append(ad)
        hazirlik.append((tamamlanan + coklu, tekli, kok_kumesi(" ".join(metinler + gecmis_basliklar))))

    # 1) Adları doğrudan sayfa başlığı olarak dene, insan olanları ayır
    sayfa = wiki_basliklari(sorted({a for c, t, _ in hazirlik for a in c + t}))
    insan = wikidata_insanlar({q for _, q in sayfa.values()})
    dogrudan = {a: t for a, (t, q) in sayfa.items() if q in insan}

    # 2) Tek kelimeler (çoğunlukla soyad) belirsizdir: Wikipedia'nın yönlendirmesi de
    #    yanlış kişiye gidebilir ('Dervişoğlu' -> futbolcu). Aranır, yönlendirme de
    #    seçeneklerden biri olur, seçimi haber bağlamı yapar. Konu başına en fazla 3.
    aranacak = set()
    for coklu, tekli, _ in hazirlik:
        parcalar = {k for a in coklu if a in dogrudan for k in a.split()}
        aranacak.update([t for t in tekli if t not in parcalar][:3])
    arama = {ad: wiki_ara(ad) for ad in sorted(aranacak)}
    yonlendirme = {}  # tek kelime -> Wikipedia'nın doğrudan gösterdiği kişi
    for ad in arama:
        if ad in dogrudan:
            yonlendirme[ad] = dogrudan.pop(ad)
            arama[ad].append(yonlendirme[ad])
    arama_sayfa = wiki_basliklari(sorted({b for liste in arama.values() for b in liste}))
    insan.update(wikidata_insanlar({q for _, q in arama_sayfa.values() if q not in insan}))
    baslik_qid = {t: q for t, q in list(sayfa.values()) + list(arama_sayfa.values()) if q in insan}

    # 3) İnsan sayfalarının özet/resim bilgisi
    ayrinti = wiki_ayrintilar(sorted(baslik_qid))

    def kayit(baslik: str) -> dict:
        bilgi = insan[baslik_qid[baslik]]
        return {"ad": baslik, "aciklama": bilgi["aciklama"], **ayrinti.get(baslik, {"ozet": "", "link": "", "resim": None})}

    sonuclar = []
    for coklu, tekli, baglam in hazirlik:
        bulunan, adlar = [], set()
        for aday in coklu + tekli:
            if aday in dogrudan:
                baslik = dogrudan[aday]
            elif arama.get(aday):
                # Öncelik: yaşayan ('Netanyahu' -> Binyamin, ölen babası değil), sonra
                # Wikipedia'nın yönlendirdiği, sonra haberle (adın kendisi hariç) çok örtüşen.
                # Yalnızca aramayla bulunup en az 2 kelimeyle örtüşmeyen alınmaz
                # ('Rapid' -> Johnny Rapid; tek ortak kelimesi 'oyuncu' idi).
                def ortusme(t: str) -> int:
                    k = kayit(t)
                    return len((kok_kumesi(k["aciklama"] + " " + k["ozet"]) & baglam) - kok_kumesi(t))
                secenekler = [t for t in dict.fromkeys(arama[aday]) if t in baslik_qid
                              and (ortusme(t) >= 2 or t == yonlendirme.get(aday))]
                if not secenekler:
                    continue
                baslik = max(secenekler, key=lambda t: (
                    insan[baslik_qid[t]]["yasiyor"], t == yonlendirme.get(aday), ortusme(t)))
            else:
                continue
            if baslik in baslik_qid and baslik not in adlar:
                adlar.add(baslik)
                bulunan.append(kayit(baslik))
                if len(bulunan) == KISI_EN_FAZLA:
                    break
        sonuclar.append(bulunan)
    return sonuclar


# ---------- soru ----------

SORULAR_KISILI = [
    "{kisi} bu konuda doğru mu davranıyor sence?",
    "Sence {kisi} bundan sonra ne yapacak?",
    "{kisi} yerinde olsan ne yapardın?",
]
SORULAR_GENEL = [
    "“{konu}” haberini duydun mu? Sence bunun arkasında ne var?",
    "“{konu}” — sence bundan sonra ne olur?",
    "“{konu}” sence bizi nasıl etkiler?",
    "“{konu}” hakkında ne düşünüyorsun?",
]


def kisa_konu(baslik: str) -> str:
    """Başlığın ilk cümleciği: 'X oldu: ayrıntı... İşte ...' -> 'X oldu'."""
    parca = re.split(r"\s*(?:[:!?…]|\.\.\.|\s-\s|\|)\s*", baslik)[0].strip(" .'\"“”")
    if len(parca.split()) < 2:
        parca = baslik
    kelimeler = parca.split()
    return parca if len(kelimeler) <= 8 else " ".join(kelimeler[:6]) + "…"


def soru_uret(konu: dict) -> str:
    h = int(hashlib.md5(konu["baslik"].encode()).hexdigest(), 16)
    if konu["kisiler"]:
        return SORULAR_KISILI[h % len(SORULAR_KISILI)].format(kisi=konu["kisiler"][0]["ad"])
    return SORULAR_GENEL[h % len(SORULAR_GENEL)].format(konu=kisa_konu(konu["baslik"]))


# ---------- ana akış ----------

def konu_sonucu(konu: dict, ozet: str, ozet_kaynagi: str, gecmis: list[dict], kisi_listesi: list[dict]) -> dict:
    konu["kisiler"] = kisi_listesi
    sonuc = {
        "id": hashlib.sha1((konu["tur"] + konu["baslik"]).encode()).hexdigest()[:12],
        "baslik": konu["baslik"],
        "tur": konu["tur"],
        "kategori": konu["kategori"],
        **({"secim": konu["secim"]} if konu.get("secim") else {}),
        "tarih": konu["tarih"],
        "ozet": ozet,
        "ozet_kaynagi": ozet_kaynagi,
        "haberler": [{k: h[k] for k in ("baslik", "kaynak", "link", "tarih")} for h in konu["haberler"]],
        "gecmis": gecmis,
        "kisiler": konu["kisiler"],
        "soru": soru_uret(konu),
    }
    print(f"  ✓ {sonuc['baslik'][:60]}  (geçmiş {len(sonuc['gecmis'])}, kişi {len(sonuc['kisiler'])})")
    return sonuc


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

    print("Kaynaklar okunuyor...")
    secimler, konu_sayisi, spor_sayisi = ayarlari_oku()
    haber_en_fazla = max(1, round(konu_sayisi * HABER_ORANI))
    with ThreadPoolExecutor(4) as havuz_is:
        f_haber = havuz_is.submit(google_haberler_konulari)
        f_spor = havuz_is.submit(google_haberler_konulari, GOOGLE_SPOR)
        f_trend = havuz_is.submit(trends_konulari)
        f_rss = havuz_is.submit(rss_havuzu)
        f_secimler = [havuz_is.submit(secim_konulari, s) for s in secimler]
    haber_konulari, rss = f_haber.result(), f_rss.result()
    secim_secilen: list[dict] = []
    for f in f_secimler:
        for k in f.result():
            if not any(ayni_konu_mu(k, s) for s in secim_secilen):
                secim_secilen.append(k)
    try:
        trend_konulari = f_trend.result()
    except Exception as e:
        uyari(f"Trends okunamadı: {e}")
        trend_konulari = []
    try:
        spor_konulari = f_spor.result()
    except Exception as e:
        uyari(f"Spor bölümü okunamadı: {e}")
        spor_konulari = []
    for k in spor_konulari:
        k["kaynak_bolum"] = "spor"

    gundem_secilen: list[dict] = []
    spor_secilen: list[dict] = []

    def ekle(k: dict, gundem_siniri: int) -> None:
        """Konuyu spor ya da gündem listesine koyar; aynı konu iki kez girmez."""
        if any(ayni_konu_mu(k, s) for s in gundem_secilen + spor_secilen + secim_secilen):
            return
        if spor_mu(k):
            if len(spor_secilen) < spor_sayisi:
                k["kategori"] = "spor"
                spor_secilen.append(k)
        elif len(gundem_secilen) < gundem_siniri:
            k["kategori"] = "gundem"
            gundem_secilen.append(k)

    for k in haber_konulari:
        ekle(k, haber_en_fazla)
    for k in trend_konulari:
        ekle(k, konu_sayisi)
    for k in haber_konulari:  # Trends yetmezse haberlerle tamamla
        ekle(k, konu_sayisi)
    for k in spor_konulari:  # spor bölümünün kendi konuları
        ekle(k, 0)
    secilen = gundem_secilen + secim_secilen + spor_secilen

    print(f"{len(gundem_secilen)} gündem + {len(secim_secilen)} seçim + {len(spor_secilen)} spor konusu işleniyor...")
    ozetler = [ozet_bul(k, rss) for k in secilen]
    print("Geçmiş haberler aranıyor...")
    with ThreadPoolExecutor(4) as is_havuzu:
        gecmisler = list(is_havuzu.map(gecmis_haberler, secilen))
    print("Kişiler aranıyor (Wikipedia)...")
    kisi_listeleri = kisileri_bul(secilen, [o for o, _ in ozetler], gecmisler)
    konular = [konu_sonucu(k, o, ok, g, kl)
               for k, (o, ok), g, kl in zip(secilen, ozetler, gecmisler, kisi_listeleri)]

    CIKTI.parent.mkdir(parents=True, exist_ok=True)
    veri = {"olusturulma": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
            "spor_secimleri": [{"ad": s["ad"], "dal": s.get("dal", "")} for s in secimler],
            "konular": konular}
    CIKTI.write_text(json.dumps(veri, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Yazıldı: {CIKTI}")


if __name__ == "__main__":
    main()
