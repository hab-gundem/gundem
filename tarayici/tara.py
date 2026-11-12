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
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from html.parser import HTMLParser
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
HABER_ORANI = 0.7  # tercih konularından sonra kalan gündemin bu kadarı Google Haberler'den, kalanı Trends'ten
TERCIH_SAYISI = 4         # gündemde tercih edilen kaynakların manşetlerinden gelen konu sayısı (varsayılan)
TERCIH_SITE_HABER = 30    # her tercih sitesinden bakılan en yeni haber sayısı
TERCIH_KONU_HABER = 3     # bir konuya tercih sitelerinden eklenen en fazla haber
HABER_EN_FAZLA = 8        # bir konuda en fazla haber
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


TR_HARF = set("çğışöüÇĞİŞÖÜ")
TR_SIK = ETKISIZ | set("bin milyon yüzde ilk iki üç hakkında konusunda sonrası öncesi değil".split())
# Türkçede de kelime olanlar (on, el, her, et, dans…) bilerek yok
YABANCI_SIK = set("""
the and of to in is are was were for with from by after his their its will has have
this that who which against over into about win wins how why what when says said
der die und das ist mit für von des les est pour une los las que por con
""".split()) - TR_SIK
TR_KESME = re.compile(r"[’'`](?!(?:s|t|d|m|re|ll|ve)$)[a-zçğıöşü]+$")  # İngilizce 's, 't… değil
TR_EK = re.compile(r"(lar|ler|dan|den|tan|ten|nda|nde|yor|acak|ecek|mış|miş|muş|müş|ını|ini|nın|nin|ndi|dı|di|ti|cı|ci|lı|li|lu|lü|sı|si|spor)$")


def latin_disi_mi(metin: str) -> bool:
    """Arapça, Rusça, Yunanca… yazıyla mı yazılmış?"""
    harfler = [c for c in metin if c.isalpha()]
    disi = sum(not ("a" <= c.lower()[:1] <= "z" or c in TR_HARF or c in "âîûÂÎÛ") for c in harfler)
    return disi > 0.2 * len(harfler) if harfler else False


def turkce_mi(metin: str) -> bool:
    """Kaba dil denetimi: Türkçe harf/kelime yoksa ya da yabancı sık kelimeler ağır basıyorsa Türkçe değildir."""
    if latin_disi_mi(metin):
        return False
    harfler = [c for c in metin if c.isalpha()]
    ham = [k for k in KELIME.findall(metin) if not k.isdigit()]
    kelimeler = [tr_kucuk(KISA_EKLER.sub("", k)) for k in ham]  # "Osimhen'in" -> "osimhen"
    tr = sum(k in TR_SIK for k in kelimeler)
    yab = sum(k in YABANCI_SIK for k in kelimeler)
    tr_harf = sum(c in TR_HARF for c in harfler)
    if len(kelimeler) >= 30:  # uzun metin: oranlara bak
        return yab <= tr and tr_harf >= 0.01 * len(harfler)
    # kısa metin (başlık): Türkçe belirtileri yabancı sık kelimelerle tartılır
    belirti = (tr + 2 * (tr_harf > 0) + sum(bool(TR_KESME.search(k)) for k in ham)
               + sum(bool(TR_EK.search(k)) for k in kelimeler if len(k) >= 5))
    if yab > belirti:
        return False
    # 4+ kelimede hiç Türkçe belirti yoksa yabancıdır ("NBA Highlights: Spurs 125, Trail Blazers 103")
    return not (len(kelimeler) >= 4 and not belirti)


def turkce_haber(h: dict) -> bool:
    return (turkce_mi(h.get("baslik", "")) and not latin_disi_mi(h.get("kaynak", ""))
            and turkce_mi(h.get("ozet", "")))


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
        haberler = [h for h in haberler if turkce_haber(h)]
        if not haberler:
            continue
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
        haberler = [h for h in haberler if turkce_haber(h)]  # Trends yabancı dilde haber de veriyor
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


def ayarlari_oku() -> tuple[list[dict], int, int, list[dict], int]:
    """(spor seçimleri, gündem konu sayısı, genel spor konu sayısı, tercih kaynakları, tercih konu sayısı) döndürür.

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
    kaynaklar = []
    for k in veri.get("tercih_kaynaklar", []):
        if isinstance(k, dict) and str(k.get("site", "")).strip():
            site = re.sub(r"^https?://|^www\.|/.*$", "", k["site"].strip().lower())
            kose = re.sub(r"^https?://|^www\.|/+$", "", str(k.get("kose", "")).strip().lower())
            kaynaklar.append({"ad": str(k.get("ad", "")).strip() or site, "site": site, "kose": kose})
    gundem_sayisi = _sayi(veri.get("gundem_konu_sayisi"), KONU_SAYISI, 1, 20)
    return (secimler, gundem_sayisi,
            _sayi(veri.get("genel_spor_konu_sayisi"), SPOR_SAYISI, 0, 15),
            kaynaklar, min(gundem_sayisi, _sayi(veri.get("tercih_konu_sayisi"), TERCIH_SAYISI, 0, 10)))


# ---------- tercih edilen kaynaklar ----------
# Kullanıcının seçtiği siteler: kendi manşetleri gündeme konu olarak girer, her konu bu
# sitelerde de aranır, bulunan haberler listenin başına geçer ve metin önce onlardan alınır.

def tercih_mi(kaynak: str, kaynaklar: list[dict]) -> bool:
    """Google'ın verdiği kaynak adı (ör. "Sözcü Gazetesi", "birgun.net") tercih edilen sitelerden mi?"""
    s = _sade(kaynak)
    return bool(s) and any(s.startswith(_sade(k["ad"])) or s == _sade(k["site"]) for k in kaynaklar)


def _site_haberleri(site: str) -> list[dict]:
    try:
        ogeler = rss_ogeleri(getir(GOOGLE_ARAMA.format(q=urllib.parse.quote(f"site:{site} when:1d"))))
    except Exception as e:
        uyari(f"Tercih kaynağı okunamadı ({site}): {e}")
        return []
    haberler = []
    for oge in ogeler[:TERCIH_SITE_HABER]:
        baslik, kaynak = baslik_kaynak_ayir(oge["baslik"])
        if not bozuk_baslik(baslik) and turkce_mi(baslik):
            haberler.append({"baslik": baslik, "kaynak": kaynak, "link": oge["link"], "tarih": oge["tarih"],
                             "tercih": True})
    return haberler


def tercih_konulari(kaynaklar: list[dict]) -> list[dict]:
    """Tercih edilen sitelerin son bir günkü haberlerini aynı olaya göre kümeler.

    Konular, kaç farklı tercih kaynağının yazdığına göre sıralanır.
    """
    with ThreadPoolExecutor(4) as is_havuzu:
        listeler = list(is_havuzu.map(_site_haberleri, [k["site"] for k in kaynaklar]))
    kumeler: list[dict] = []
    for haberler in listeler:
        for h in haberler:
            kokler = kok_kumesi(h["baslik"])
            for kume in kumeler:
                ortak = len(kokler & kume["kokler"])
                if ortak >= 3 or (ortak >= 2 and ortak / len(kokler) >= 0.5):
                    if all(_sade(x["kaynak"]) != _sade(h["kaynak"]) for x in kume["haberler"]):
                        kume["haberler"].append(h)
                        kume["kokler"] |= kokler
                    break
            else:
                kumeler.append({"kokler": set(kokler), "haberler": [h]})
    kumeler.sort(key=lambda k: (len(k["haberler"]), max(h["tarih"] or "" for h in k["haberler"])), reverse=True)
    return [{"baslik": k["haberler"][0]["baslik"], "tur": "tercih", "tarih": k["haberler"][0]["tarih"],
             "haberler": k["haberler"][:5]} for k in kumeler]


def tercih_haberleri_ekle(konu: dict, kaynaklar: list[dict]) -> None:
    """Konuyu tercih edilen sitelerde arar; bulunanları ve zaten listedeki tercih haberlerini başa alır."""
    for h in konu["haberler"]:
        h["tercih"] = h.get("tercih") or tercih_mi(h.get("kaynak", ""), kaynaklar)
    sorgu = arama_sorgusu(konu)
    if konu["tur"] != "tercih" and sorgu:
        siteler = " OR ".join(f"site:{k['site']}" for k in kaynaklar)
        q = f"{sorgu} ({siteler}) when:{konu.get('gun', HABER_GUN)}d"
        try:
            ogeler = rss_ogeleri(getir(GOOGLE_ARAMA.format(q=urllib.parse.quote(q))))
        except Exception as e:
            uyari(f"Tercih araması başarısız ({sorgu}): {e}")
            ogeler = []
        sorgu_kokleri = kok_kumesi(sorgu)
        gerekli = min(2, len(sorgu_kokleri))
        var = {tr_kucuk(h["baslik"]) for h in konu["haberler"]}
        kaynaklari = {_sade(h["kaynak"]) for h in konu["haberler"] if h["tercih"]}
        eklenen = []
        for oge in ogeler:
            baslik, kaynak = baslik_kaynak_ayir(oge["baslik"])
            if (tr_kucuk(baslik) in var or _sade(kaynak) in kaynaklari
                    or len(kok_kumesi(baslik) & sorgu_kokleri) < gerekli):
                continue
            kaynaklari.add(_sade(kaynak))
            eklenen.append({"baslik": baslik, "kaynak": kaynak, "link": oge["link"], "tarih": oge["tarih"],
                            "tercih": True})
            if len(eklenen) == TERCIH_KONU_HABER:
                break
        konu["haberler"] = eklenen + konu["haberler"]
    konu["haberler"].sort(key=lambda h: not h["tercih"])  # kararlı sıralama: kendi içlerinde sıra korunur
    konu["haberler"] = konu["haberler"][:HABER_EN_FAZLA]


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
        if bozuk_baslik(baslik) or not turkce_mi(baslik) or not any(g and g <= kokler for g in gerekenler):
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
                        "kategori": "spor", "tarih": haberler[0]["tarih"], "haberler": haberler, "gun": secim["gun"],
                        "gerekenler": gerekenler})
    return konular


# ---------- spor yayın akışı ----------
# Spor Ekranı'nın gün sayfalarından (saat, karşılaşma, lig, kanal) yalnızca spor seçimlerine uyanlar.
# Seçimdeki "yayin" alanı: kelime (adda ya da ligde tam kelime), spor (Futbol, Voleybol…),
# lig (ligde biri geçmeli), haric (adda ya da ligde geçerse atlanır). Yoksa seçimin adı aranır.
YAYIN_GUN = "https://www.sporekrani.com/home/day/{}"
YAYIN_GUN_SAYISI = 7  # bugün dahil
_KATLA = str.maketrans("çğıöşüâîû", "cgiosuaiu")


def _katla(s: str) -> str:
    return tr_kucuk(s).translate(_KATLA)


def _yayin_uyar(secim: dict, ad: str, lig: str, spor: str) -> bool:
    y = secim.get("yayin") or {}
    metin = _katla(f"{ad} {lig}")
    kelimeler = y.get("kelime") or secim.get("baslikta") or [secim["ad"]]
    if not any(re.search(rf"(?<!\w){re.escape(_katla(k))}(?!\w)", metin) for k in kelimeler):
        return False
    if y.get("spor") and _katla(y["spor"]) != _katla(spor):
        return False
    if y.get("lig") and not any(_katla(x) in _katla(lig) for x in y["lig"]):
        return False
    return not any(_katla(x) in metin for x in y.get("haric", []))


def yayin_akisi(secimler: list[dict]) -> list[dict]:
    """Önümüzdeki günlerde seçimlerin hangi gün, saat ve kanalda yayınlanacağı."""
    if not secimler:
        return []
    bugun = dt.date.fromisoformat(bugun_tr())
    sonuc = []
    for i in range(YAYIN_GUN_SAYISI):
        gun = (bugun + dt.timedelta(days=i)).isoformat()
        try:
            sayfa = getir(YAYIN_GUN.format(gun)).decode("utf-8", "replace")
        except Exception as e:
            uyari(f"Yayın akışı okunamadı ({gun}): {e}")
            continue
        for blok in sayfa.split('<a href="/home/match/')[1:]:
            blok = blok.split("</a>")[0]
            bul = lambda sinif: html.unescape((re.search(rf'class="{sinif}[ "][^>]*>([^<]*)', blok) or [None, ""])[1]).strip()
            ad, lig, saat = bul("event-list__name"), bul("event-list__league"), bul("event-list__time")
            spor = html.unescape((re.search(r'alt="([^"]*)"[^>]*event-list__sport-icon', blok) or [None, ""])[1])
            kanallar = list(dict.fromkeys(html.unescape(k) for k in
                                          re.findall(r'event-list__channel rounded.*?alt="([^"]*)"', blok, re.S)))
            secim = next((s for s in secimler if _yayin_uyar(s, ad, lig, spor)), None)
            if not secim or not re.fullmatch(r"\d\d:\d\d", saat):
                continue
            yol = re.match(r'[^"]+', blok)[0]
            sonuc.append({"tarih": gun, "saat": saat, "ad": ad, "lig": lig, "secim": secim["ad"],
                          "kanallar": [k for k in kanallar if _katla(k) != "yayin yok"],
                          "link": "https://www.sporekrani.com/home/match/" + yol})
        time.sleep(1)
    print(f"  {len(sonuc)} yayın bulundu")
    return sonuc


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
        if h.get("ozet") and len(h["ozet"]) >= 40 and turkce_mi(h["ozet"]):
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
        if len(kok_kumesi(baslik) & sorgu_kokleri) < gerekli or not turkce_mi(baslik):
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


# ---------- haber metni ve görsel ----------
# Konunun haberlerinden birinin sayfası açılır; metin (paragraflar) ve paylaşım görseli
# (og:image) alınır. Google Haberler bağlantıları önce asıl habere çözülür.

UA_HABER = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/130.0 Safari/537.36")
METIN_EN_FAZLA = 8000   # karakter; daha uzunsa paragraf sınırında kesilir
SAYFA_DENEME = 3        # metin bulunana kadar konu başına en fazla bu kadar haber sayfası açılır
HABER_GUN = 3           # gündem/spor haberlerinde sayfanın kendi yayın tarihi en fazla bu kadar gün eski olabilir
YAYIN_ALANLARI = ("article:published_time", "datepublished", "og:published_time", "published_time",
                  "pubdate", "publishdate", "date")
METIN_COP = re.compile(r"©|tüm hakları|abone ol|çerez|cookie|whatsapp kanal|google news|"
                       r"bizi takip edin|haberin devamı|ilginizi çekebilir", re.IGNORECASE)


def sayfa_getir(url: str, veri: bytes | None = None, basliklar: dict | None = None) -> tuple[str, str]:
    """Tek denemelik sayfa isteği; (metin, son adres) döner."""
    istek = urllib.request.Request(url, data=veri, headers={
        "User-Agent": UA_HABER, "Accept-Language": "tr-TR,tr;q=0.9", **(basliklar or {})})
    with urllib.request.urlopen(istek, timeout=15) as yanit:
        govde = yanit.read(3_000_000)
        return govde.decode(yanit.headers.get_content_charset() or "utf-8", "replace"), yanit.geturl()


_GOOGLE_KAPISI = threading.Semaphore(2)  # Google bağlantı çözmeye aynı anda en fazla 2 istek (yoksa 429)


def _google_getir(url: str, veri: bytes | None = None, basliklar: dict | None = None) -> str:
    """news.google.com isteği; 429 gelirse bekleyip yeniden dener."""
    for deneme in range(4):
        try:
            with _GOOGLE_KAPISI:
                return sayfa_getir(url, veri, basliklar)[0]
        except urllib.error.HTTPError as e:
            if e.code != 429 or deneme == 3:
                raise
            sure = 10 * 2 ** deneme
            uyari(f"429, {sure} sn bekleniyor: news.google.com")
            time.sleep(sure)


def google_linki_coz(link: str) -> str:
    """news.google.com/rss/articles/... bağlantısını haberin asıl adresine çevirir."""
    m = re.search(r"news\.google\.com/(?:rss/)?articles/([^?/]+)", link)
    if not m:
        return link
    gid = m.group(1)
    sayfa = _google_getir(f"https://news.google.com/articles/{gid}?hl=tr&gl=TR&ceid=TR:tr")
    imza = re.search(r'data-n-a-sg="([^"]+)"', sayfa)
    zaman = re.search(r'data-n-a-ts="([^"]+)"', sayfa)
    if not (imza and zaman):
        raise ValueError("Google Haberler bağlantısı çözülemedi")
    istek = ["garturlreq", [["X", "X", ["X", "X"], None, None, 1, 1, "US:en", None, 1, None, None, None,
                             None, None, 0, 1], "X", "X", 1, [1, 1, 1], 1, 1, None, 0, 0, None, 0],
             gid, int(zaman.group(1)), imza.group(1)]
    govde = "f.req=" + urllib.parse.quote(json.dumps([[["Fbv4je", json.dumps(istek), None, "generic"]]]))
    yanit = _google_getir("https://news.google.com/_/DotsSplashUi/data/batchexecute", govde.encode(),
                          {"Content-Type": "application/x-www-form-urlencoded;charset=UTF-8"})
    return json.loads(json.loads(yanit.split("\n\n")[1])[0][2])[1]


class _SayfaAyirici(HTMLParser):
    ATLA = {"script", "style", "noscript", "figure", "figcaption", "aside", "nav", "footer",
            "header", "form", "button", "iframe", "svg", "template"}

    def __init__(self):
        super().__init__()
        self.atla = 0
        self.p: list[str] | None = None
        self.paragraflar: list[str] = []
        self.ld: list[str] = []
        self.ld_icinde = False
        self.meta: dict[str, str] = {}

    def handle_starttag(self, etiket, nitelik):
        n = dict(nitelik)
        if etiket == "meta":
            ad = (n.get("property") or n.get("name") or "").lower()
            if ad and n.get("content"):
                self.meta.setdefault(ad, n["content"])
        elif etiket == "script" and (n.get("type") or "").lower() == "application/ld+json":
            self.ld_icinde = True
            self.ld.append("")
            return
        if etiket in self.ATLA:
            self.atla += 1
        elif etiket == "p" and not self.atla:
            self.p = []
        elif etiket == "br" and self.p is not None:
            self.p.append(" ")

    def handle_endtag(self, etiket):
        if etiket == "script" and self.ld_icinde:
            self.ld_icinde = False
            return
        if etiket in self.ATLA and self.atla:
            self.atla -= 1
        elif etiket == "p" and self.p is not None:
            metin = re.sub(r"\s+", " ", "".join(self.p)).strip()
            if metin:
                self.paragraflar.append(metin)
            self.p = None

    def handle_data(self, veri):
        if self.ld_icinde:
            self.ld[-1] += veri
        elif self.p is not None and not self.atla:
            self.p.append(veri)


def _govde_bul(o) -> str | None:
    """JSON-LD içinde articleBody arar."""
    if isinstance(o, dict):
        if isinstance(o.get("articleBody"), str) and len(o["articleBody"]) > 200:
            return o["articleBody"]
        o = list(o.values())
    if isinstance(o, list):
        for v in o:
            bulunan = _govde_bul(v)
            if bulunan:
                return bulunan
    return None


def _sade(s: str) -> str:
    return re.sub(r"\W+", "", tr_kucuk(s))


def haber_sayfasi(link: str) -> dict:
    """Haber sayfasından {paragraflar, gorsel, link} çıkarır."""
    adres = google_linki_coz(link)
    sayfa, adres = sayfa_getir(adres)
    ayirici = _SayfaAyirici()
    ayirici.feed(sayfa)
    govde = None
    for parca in ayirici.ld:
        try:
            govde = _govde_bul(json.loads(parca))
        except ValueError:
            continue
        if govde:
            break
    paragraflar: list[str] = []
    for p in ayirici.paragraflar:
        p = html.unescape(p)
        if len(p) >= 60 and not METIN_COP.search(p) and p not in paragraflar:
            paragraflar.append(p)
    if govde:
        govde = html_temizle(govde)
        sade_govde = _sade(govde)
        # sayfadaki paragraflardan yalnızca haberin gövdesinde geçenler kalır (reklam, öneri vb. elenir)
        eslesen = [p for p in paragraflar if _sade(p[:60]) in sade_govde]
        if sum(map(len, eslesen)) >= len(govde) * 0.5:
            paragraflar = eslesen
        else:  # paragraf yapısı yoksa gövdeyi üçer cümlelik paragraflara böl
            cumleler = re.split(r"(?<=[.!?])\s*(?=[A-ZÇĞİÖŞÜ0-9\"'“])", govde)
            paragraflar = [" ".join(cumleler[i:i + 3]) for i in range(0, len(cumleler), 3)]
    sonuc, toplam = [], 0
    for p in paragraflar:
        if toplam + len(p) > METIN_EN_FAZLA and sonuc:
            break
        sonuc.append(p)
        toplam += len(p)
    yayin = None
    for ad in YAYIN_ALANLARI:  # sayfanın kendi yayın tarihi (Google'ın verdiği tarih yanıltabiliyor)
        yayin = tarih_coz(ayirici.meta.get(ad))
        if yayin:
            break
    if not yayin:
        for parca in ayirici.ld:
            m = re.search(r'"datePublished"\s*:\s*"([^"]+)"', parca)
            if m and (yayin := tarih_coz(m.group(1))):
                break
    yazar = ayirici.meta.get("author") or ayirici.meta.get("article:author") or ""
    if not yazar or yazar.startswith("http"):
        yazar = ""
        for parca in ayirici.ld:
            m = re.search(r'"author"\s*:\s*\[?\s*\{[^{}]*?"name"\s*:\s*"([^"]+)"', parca)
            if m:
                yazar = m.group(1)
                break
    gorsel = ayirici.meta.get("og:image") or ayirici.meta.get("twitter:image") or ""
    gorsel = urllib.parse.urljoin(adres, html.unescape(gorsel)) if gorsel else ""
    return {"paragraflar": sonuc, "gorsel": gorsel if gorsel.startswith(("http://", "https://")) else "",
            "link": adres, "yayin": yayin, "yazar": html.unescape(yazar).strip()}


def konu_metni(konu: dict) -> dict:
    """Metin bulunana kadar haber sayfalarını açar: yayın tarihi eski olanları atar, ilk uygun metni ve görseli döner.

    Google Haberler eski bir sayfayı yeni tarihle listeleyebiliyor; bu yüzden sayfanın kendi
    yayın tarihine bakılır. Sayfa açılamazsa ya da tarih yazmıyorsa haber, Google tarihiyle kalır.
    Konunun bütün haberleri eskiyse konunun "haberler" listesi boş kalır (konu düşürülür).
    """
    esik = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=konu.get("gun", HABER_GUN))).isoformat()
    kokler = kok_kumesi(konu["baslik"])
    gerekli = min(2, len(kokler))
    sonuc: dict = {}
    kalan, atilan = [], set()
    for sira, h in enumerate(konu["haberler"]):
        if sira >= SAYFA_DENEME or "metin" in sonuc:  # Google'ı yormamak için: metin bulununca kalanlar açılmaz
            kalan.append(h)
            continue
        try:
            s = haber_sayfasi(h["link"])
        except Exception as e:
            uyari(f"Haber sayfası okunamadı ({h.get('kaynak', '')}): {e}")
            kalan.append(h)
            continue
        if s["yayin"]:
            if s["yayin"] < esik:
                uyari(f"Eski haber atıldı ({s['yayin'][:10]}): {h['baslik'][:60]}")
                atilan.add(tr_kucuk(h["baslik"]))
                continue
            h["tarih"] = s["yayin"]
        kalan.append(h)
        if s["gorsel"] and not sonuc.get("gorsel"):
            sonuc["gorsel"] = s["gorsel"]
        metin = " ".join(s["paragraflar"])
        if ("metin" not in sonuc and len(metin) >= 300 and len(kokler & kok_kumesi(metin)) >= gerekli
                and turkce_mi(metin)):
            sonuc.update({"metin": s["paragraflar"], "metin_kaynagi": h.get("kaynak", ""),
                          "metin_link": s["link"], "metin_tarih": h["tarih"]})
            if s["gorsel"]:
                sonuc["gorsel"] = s["gorsel"]
    kalan.sort(key=lambda h: (bool(h.get("tercih")), h["tarih"] or ""), reverse=True)
    konu["haberler"] = kalan
    if kalan:
        konu["tarih"] = max(h["tarih"] or "" for h in kalan) or None
        if tr_kucuk(konu["baslik"]) in atilan:  # başlık eski haberden geliyordu
            konu["baslik"] = max(kalan, key=lambda h: h["tarih"] or "")["baslik"]
    return sonuc


# ---------- köşe yazıları ----------
# Tercih edilen kaynakların köşe yazısı bölümlerinde (ör. t24.com.tr/yazarlar) konu aranır.
# Google tam metinde aradığı için ilgisiz yazılar da gelir; yazı açılıp konuyla örtüşmesine bakılır.

KOSE_GUN = 3          # kaç günlük yazılara bakılır
KOSE_DENEME = 4       # konu başına en fazla bu kadar yazı açılır
KOSE_EN_FAZLA = 2     # konu başına gösterilen yazı
KOSE_OZET = 700       # yazının gösterilen ilk kısmı (karakter)


def _kose_basligi(baslik: str) -> tuple[str, str]:
    """Google başlığından (yazar, yazı başlığı): "X yazdı : Y", "X | Y", "Y - X" kalıpları."""
    if m := re.match(r"(.+?) yazdı\s*:\s*(.+)", baslik):
        return m.group(1).strip(), m.group(2).strip()
    if m := re.match(r"([^|]{3,40}) \| (.+)", baslik):
        return m.group(1).strip(), m.group(2).strip()
    return "", baslik


def kose_yazilari(konu: dict, kaynaklar: list[dict]) -> list[dict]:
    yollar = [k["kose"] for k in kaynaklar if k.get("kose")]
    sorgu = arama_sorgusu(konu)
    if not yollar or not sorgu:
        return []
    q = f"{sorgu} ({' OR '.join(f'site:{y}' for y in yollar)}) when:{KOSE_GUN}d"
    try:
        ogeler = rss_ogeleri(getir(GOOGLE_ARAMA.format(q=urllib.parse.quote(q))))
    except Exception as e:
        uyari(f"Köşe yazısı araması başarısız ({sorgu}): {e}")
        return []
    sorgu_kokleri = kok_kumesi(sorgu)
    gerekli = min(2, len(sorgu_kokleri))
    konu_k = konu_kokleri(konu)
    yazilar, yazarlar = [], set()
    for oge in ogeler[:KOSE_DENEME]:
        baslik, kaynak = baslik_kaynak_ayir(oge["baslik"])
        yazar, baslik = _kose_basligi(baslik)
        try:
            s = haber_sayfasi(oge["link"])
        except Exception as e:
            uyari(f"Köşe yazısı okunamadı ({kaynak}): {e}")
            continue
        metin = " ".join(s["paragraflar"])
        kokler = kok_kumesi(metin)
        if (len(metin) < 400 or len(kokler & sorgu_kokleri) < gerekli or len(kokler & konu_k) < 4
                or not turkce_mi(metin)):
            continue  # konuyla ilgisiz
        yazar = yazar or s["yazar"]
        if _sade(yazar) in yazarlar:
            continue
        yazarlar.add(_sade(yazar))
        ozet = ""
        for p in s["paragraflar"]:
            if len(ozet) >= KOSE_OZET:
                break
            ozet += (" " if ozet else "") + p
        if len(ozet) > KOSE_OZET + 200:  # cümle sonunda kes, olmazsa kelime sonunda
            kes = ozet[:KOSE_OZET + 200]
            nokta = max(kes.rfind(". "), kes.rfind("? "), kes.rfind("! "))
            ozet = kes[:nokta + 1] if nokta > KOSE_OZET // 2 else kes.rsplit(" ", 1)[0] + "…"
        yazilar.append({"yazar": yazar, "baslik": baslik, "kaynak": kaynak, "tarih": s["yayin"] or oge["tarih"],
                        "ozet": ozet, "link": s["link"]})
        if len(yazilar) == KOSE_EN_FAZLA:
            break
    return yazilar


# ---------- günün hafıza kartları ----------
# Her gün mitoloji, dini hikâye, yazar sözü ve şiirden birer kart. Kaynaklar Vikipedi,
# Vikisöz ve Vikikaynak kategorileri; seçim tarihe bağlı, aynı gün aynı kart gelir.

HAFIZA_KATEGORILERI = {
    "mitoloji": ("tr.wikipedia.org", ["Yunan mitolojisi", "Türk mitolojisi", "Roma mitolojisi",
                                      "İskandinav mitolojisi", "Mısır mitolojisi"]),
    "din": ("tr.wikipedia.org", ["Peygamberler", "İslam peygamberleri", "Kur'an'daki kişiler",
                                 "Tevrat'taki kişiler", "Eski Ahit'teki kişiler"]),
    "soz": ("", []),  # yalnızca SOZ_YAZARLARI (Vikisöz)
    "siir": ("", []),  # Ömer Hayyam rubaileri (Vikikaynak'ta yok, aşağıdaki siteden)
    "yetiskin": ("", []),  # müstehcen divan şiiri; metinler tarayici/yetiskin/ altında
    "hiciv": ("", []),  # Neyzen Tevfik, Şair Eşref; metinler tarayici/hiciv/hiciv.json
    "replik": ("", []),  # yerli ve yabancı film replikleri; tarayici/replik/replik.json
}
# Günün sözü yalnızca bu düşünürlerden (kullanıcı seçimi); Vikisöz sayfa adları
SOZ_YAZARLARI = ["Baruch Spinoza", "Epiktetos", "Seneca", "Marcus Aurelius", "Epikuros",
                 "Michel de Montaigne", "Arthur Schopenhauer"]
SOZ_ATLA = ["Depremleri düşün"]  # Vikisöz'de söz olmayan, sonradan eklenmiş satırlar
HAYYAM_SAYFA = "https://www.xn--edebiyatgretmeni-twb.net/rubailer{}.htm"  # 1. sayfa ekisiz, sonra 2…15
HAYYAM_SAYFA_SAYISI = 15
HIKAYE_EN_FAZLA = 6000  # karakter


def _site_sorgu(site: str, **parametre) -> dict:
    parametre.update(format="json", formatversion=2)
    return getir_json(f"https://{site}/w/api.php?" + urllib.parse.urlencode(parametre))


def _kategori_uyeleri(site: str, kategoriler: list[str]) -> list[str]:
    uyeler: list[str] = []
    for kat in kategoriler:
        try:
            yanit = _site_sorgu(site, action="query", list="categorymembers", cmtitle=f"Kategori:{kat}",
                                cmnamespace=0, cmlimit=500)
        except Exception as e:
            uyari(f"Kategori okunamadı ({site} {kat}): {e}")
            continue
        for u in yanit.get("query", {}).get("categorymembers", []):
            if u["title"] not in uyeler and not u["title"][0].isdigit() and u["title"] != kat:
                uyeler.append(u["title"])
    return uyeler


def _gunun_sirasi(adaylar: list[str], tur: str, gun: str) -> list[str]:
    """Adayları tarihe bağlı, her gün değişen bir sıraya koyar."""
    return sorted(adaylar, key=lambda a: hashlib.sha1(f"{gun}|{tur}|{a}".encode()).hexdigest())


def _wiki_yazisi(baslik: str, en_fazla: int = HIKAYE_EN_FAZLA, giris: bool = False) -> dict | None:
    s = _site_sorgu("tr.wikipedia.org", action="query", titles=baslik, prop="extracts|pageimages|info",
                    explaintext=1, exsectionformat="plain", pithumbsize=600, inprop="url", redirects=1,
                    **({"exintro": 1} if giris else {}))
    sayfa = (s.get("query", {}).get("pages") or [{}])[0]
    metin = sayfa.get("extract", "")
    # kaynakça vb. son bölümleri at
    metin = re.split(r"\n(?:Kaynakça|Ayrıca bakınız|Dış bağlantılar|Notlar)\n", metin)[0]
    paragraflar, toplam = [], 0
    for p in (x.strip() for x in metin.split("\n")):
        if len(p) < 40:
            continue
        if toplam + len(p) > en_fazla and paragraflar:
            break
        paragraflar.append(p)
        toplam += len(p)
    if not paragraflar:
        return None
    return {"baslik": sayfa.get("title", baslik), "metin": paragraflar, "link": sayfa.get("fullurl", ""),
            "gorsel": sayfa.get("thumbnail", {}).get("source", "")}


def _viki_temizle(s: str) -> str:
    s = re.sub(r"\[\[(?:[^|\]]*\|)?([^\]]*)\]\]", r"\1", s)        # [[a|b]] -> b
    s = re.sub(r"\[https?://\S+ ([^\]]*)\]", r"\1", s)              # [adres yazı] -> yazı
    s = re.sub(r"\{\{[^{}]*\}\}", "", s)                            # basit şablonlar
    s = re.sub(r"<ref[^>]*>.*?</ref>|<ref[^>]*/>", "", s, flags=re.S)
    s = s.replace("'''", "").replace("''", "")
    return html_temizle(s)


def _gunun_sozu(adaylar: list[str]) -> dict | None:
    for yazar in adaylar[:5]:
        try:
            wt = _site_sorgu("tr.wikiquote.org", action="parse", page=yazar, prop="wikitext",
                             redirects=1)["parse"]["wikitext"]
        except Exception as e:
            uyari(f"Vikisöz ({yazar}): {e}")
            continue
        wt = re.split(r"^==+\s*(?:Hakkında|Kaynakça)", wt, flags=re.M)[0]  # başkalarının onun hakkındaki sözleri
        sozler = [_viki_temizle(m) for m in re.findall(r"^\*(?!\*)\s*(.+)$", wt, re.M)]
        sozler = [s for s in sozler if 20 <= len(s) <= 300 and " — " not in s
                  and not any(a in s for a in SOZ_ATLA)]
        if not sozler:
            continue
        soz = _gunun_sirasi(sozler, "soz", bugun_tr())[0]
        try:
            bilgi = _wiki_yazisi(yazar, 800, giris=True) or {}
        except Exception:
            bilgi = {}
        kisa = " ".join(soz.split()[:6]) + ("…" if len(soz.split()) > 6 else "")
        return {"bolum": "soz", "baslik": kisa, "yazar": yazar, "metin": [soz],
                "bilgi": " ".join(bilgi.get("metin", [])[:1]), "bilgi_baslik": "Yazar hakkında",
                "link": "https://tr.wikiquote.org/wiki/" + urllib.parse.quote(yazar.replace(" ", "_")),
                "gorsel": bilgi.get("gorsel", ""), "kaynak": "Vikisöz"}
    return None


def _gunun_siiri(adaylar: list[str]) -> dict | None:
    for baslik in adaylar[:5]:
        try:
            wt = _site_sorgu("tr.wikisource.org", action="parse", page=baslik, prop="wikitext")["parse"]["wikitext"]
        except Exception as e:
            uyari(f"Vikikaynak ({baslik}): {e}")
            continue
        govde = re.search(r"\{\{söz\|(.*?)\}\}\s*(?:<br>|$|-)", wt, re.S) or re.search(r"<poem>(.*?)</poem>", wt, re.S)
        if not govde:
            continue
        ham = re.sub(r"<br\s*/?>[ \t]*\r?\n?", "\n", govde.group(1))
        satirlar = [_viki_temizle(x) for x in ham.split("\n")]
        dortlukler, parca = [], []
        for st in satirlar + [""]:
            if st:
                parca.append(st)
            elif parca:
                dortlukler.append("\n".join(parca))
                parca = []
        if not dortlukler:
            continue
        yazar = re.search(r"\|\s*yazar\s*=\s*([^\n|]*)", wt)
        sozluk = [_viki_temizle(x) for x in re.findall(r"^:(.+)$", wt, re.M)]
        return {"bolum": "siir", "baslik": baslik, "yazar": _viki_temizle(yazar.group(1)) if yazar else "",
                "metin": dortlukler, "bilgi": "\n".join(s for s in sozluk if s), "bilgi_baslik": "Sözlük",
                "link": "https://tr.wikisource.org/wiki/" + urllib.parse.quote(baslik.replace(" ", "_")),
                "gorsel": "", "kaynak": "Vikikaynak"}
    return None


def _gunun_rubaisi(gun: str) -> dict | None:
    """Günün sayfasını açar, içinden günün rubaisini seçer."""
    sayfalar = _gunun_sirasi([str(i) for i in range(1, HAYYAM_SAYFA_SAYISI + 1)], "siir", gun)
    for sayfa in sayfalar[:3]:
        adres = HAYYAM_SAYFA.format("" if sayfa == "1" else sayfa)
        try:
            ham = getir(adres).decode("utf-8", "replace")
        except Exception as e:
            uyari(f"Rubai sayfası okunamadı ({sayfa}): {e}")
            continue
        govde = ham.split('class="entry-content"', 1)[-1].split("</article>", 1)[0]
        rubailer: dict[str, list[str]] = {}
        no = None
        for p in re.findall(r"<p[^>]*>(.*?)</p>", govde, re.S):
            satir = html_temizle(p)
            if re.fullmatch(r"\d+\.", satir):
                no = satir[:-1]
                rubailer[no] = []
            elif no and satir:
                rubailer[no].append(satir)
        rubailer = {n: s for n, s in rubailer.items() if len(s) >= 2}
        if not rubailer:
            continue
        no = _gunun_sirasi(list(rubailer), "rubai", gun)[0]
        satirlar = rubailer[no]
        return {"bolum": "siir", "baslik": satirlar[0].rstrip(";:,."), "yazar": "Ömer Hayyam",
                "metin": ["\n".join(satirlar)], "bilgi": "", "bilgi_baslik": "",
                "link": adres, "gorsel": "", "kaynak": "edebiyatöğretmeni.net"}
    return None


YETISKIN_DOSYALARI = ["sevk-engiz.json", "zenanname.json"]  # tarayici/yetiskin/ altında; {eser, yazar, kaynak, link, beyitler}
YETISKIN_BEYIT = 12                       # günün parçası kaç beyit


def _gunun_yetiskin_parcasi(gun: str) -> dict | None:
    """Eserlerden birinin tarihe bağlı rastgele bir yerinden YETISKIN_BEYIT beyitlik parça."""
    dizin = os.path.join(os.path.dirname(os.path.abspath(__file__)), "yetiskin")
    dosya = _gunun_sirasi(YETISKIN_DOSYALARI, "yetiskin", gun)[0]
    with open(os.path.join(dizin, dosya), encoding="utf-8") as f:
        eser = json.load(f)
    beyitler = eser["beyitler"]
    if not beyitler:
        return None
    adet = min(YETISKIN_BEYIT, len(beyitler))
    bas = int(hashlib.sha1(f"{gun}|yetiskin|{dosya}".encode()).hexdigest(), 16) % (len(beyitler) - adet + 1)
    parca = beyitler[bas:bas + adet]
    bolumler = list(dict.fromkeys(b["bolum"] for b in parca if b.get("bolum")))
    return {"bolum": "yetiskin", "baslik": f"{eser['eser']} ({bas + 1}-{bas + adet}. beyitler)",
            "yazar": eser["yazar"], "metin": [b["b"] for b in parca],
            **({"anlam": [b.get("a", "") for b in parca], "anlam_notu": eser.get("anlam_notu", "")}
               if any(b.get("a") for b in parca) else {}),
            "bilgi": "\n".join(bolumler), "bilgi_baslik": "Eserin bölümü",
            "link": eser["link"], "gorsel": "", "kaynak": eser["kaynak"]}


def _gunun_hicvi(gun: str) -> dict | None:
    """tarayici/hiciv/hiciv.json'dan tarihe bağlı bir hiciv."""
    dosya = os.path.join(os.path.dirname(os.path.abspath(__file__)), "hiciv", "hiciv.json")
    with open(dosya, encoding="utf-8") as f:
        siirler = json.load(f)["siirler"]
    if not siirler:
        return None
    s = _gunun_sirasi([str(i) for i in range(len(siirler))], "hiciv", gun)[0]
    s = siirler[int(s)]
    anlam = s.get("anlam") or []
    return {"bolum": "hiciv", "baslik": s["baslik"], "yazar": s["sair"], "metin": s["metin"],
            **({"anlam": anlam, "anlam_notu": "Bugünkü Türkçe karşılıklar Claude tarafından yazıldı; akademik çeviri değildir."}
               if any(anlam) else {}),
            "bilgi": s.get("baglam", ""), "bilgi_baslik": "Kimi, neyi hicvediyor",
            "link": s.get("link", ""), "gorsel": "", "kaynak": s.get("kaynak", "")}


def _gunun_repligi(gun: str) -> dict | None:
    """tarayici/replik/replik.json'dan tarihe bağlı bir film repliği."""
    dosya = os.path.join(os.path.dirname(os.path.abspath(__file__)), "replik", "replik.json")
    with open(dosya, encoding="utf-8") as f:
        replikler = json.load(f)["replikler"]
    if not replikler:
        return None
    r = replikler[int(_gunun_sirasi([str(i) for i in range(len(replikler))], "replik", gun)[0])]
    film = f"{r['film']} ({r['yil']})" if r.get("yil") else r["film"]
    metin = [r["replik"]] + ([f"Aslı: “{r['asil']}”"] if r.get("asil") and r["asil"] != r["replik"] else [])
    return {"bolum": "replik", "alt": r["tur"], "baslik": film, "yazar": r.get("soyleyen", ""), "metin": metin,
            "bilgi": r.get("hikaye", ""), "bilgi_baslik": "Neden söyleniyor", "link": "", "gorsel": "", "kaynak": ""}


def bugun_tr() -> str:
    return (dt.datetime.now(dt.timezone.utc) + dt.timedelta(hours=3)).date().isoformat()


def hafiza_kartlari() -> list[dict]:
    """Günün mitoloji, dini hikâye, söz ve şiir kartları."""
    gun = bugun_tr()
    kartlar = []
    for tur, (site, kategoriler) in HAFIZA_KATEGORILERI.items():
        adaylar = _gunun_sirasi(_kategori_uyeleri(site, kategoriler), tur, gun) if site else []
        kart = None
        try:
            if tur == "soz":
                kart = _gunun_sozu(_gunun_sirasi(SOZ_YAZARLARI, tur, gun))
            elif tur == "siir":
                kart = _gunun_rubaisi(gun)
            elif tur == "yetiskin":
                kart = _gunun_yetiskin_parcasi(gun)
            elif tur == "hiciv":
                kart = _gunun_hicvi(gun)
            elif tur == "replik":
                kart = _gunun_repligi(gun)
            else:
                for baslik in adaylar[:5]:
                    yazi = _wiki_yazisi(baslik)
                    if yazi and sum(map(len, yazi["metin"])) >= 400:
                        kart = {"bolum": "hikaye", "alt": "Mitolojik" if tur == "mitoloji" else "Dini",
                                **yazi, "yazar": "", "kaynak": "Vikipedi"}
                        break
        except Exception as e:
            uyari(f"Hafıza kartı ({tur}): {e}")
        if kart:
            kart["id"] = "h" + hashlib.sha1(f"{kart['bolum']}|{kart['baslik']}|{kart.get('yazar', '')}".encode()).hexdigest()[:11]
            kart["kategori"] = "hafiza"
            kartlar.append(kart)
            print(f"  ✓ {tur}: {kart['baslik'][:60]}")
    return kartlar


# ---------- konuya dair söz ----------
# Gündem konusunun kelimeleri bu anahtarlarla eşleşirse konunun altına bir söz konur.
# Önce elimizdeki hicivlere (hiciv.json'daki "anahtar"), yoksa Vikisöz'ün konu sayfalarına bakılır.
KONU_SOZ_SAYFALARI = {
    "Yolsuzluk": ["yolsuzluk", "rüşvet", "usulsüzlük", "zimmet", "ihale", "kara para", "fon"],
    "Adalet": ["adalet", "adli", "yargı", "hakim", "savcı", "dava", "tutuklama", "tutuklu", "iddianame"],
    "Hukuk": ["hukuk", "anayasa", "kanun", "yasa", "mahkeme"],
    "Hapishane": ["cezaevi", "hapis", "mahkum", "tutuklu"],
    "Savaş": ["savaş", "saldırı", "bombardıman", "füze", "cephe", "işgal", "çatışma"],
    "Barış": ["barış", "ateşkes", "müzakere"],
    "Ekonomi": ["ekonomi", "enflasyon", "faiz", "merkez bankası", "büyüme", "borsa", "ihracat"],
    "Vergi": ["vergi", "kdv", "ötv", "harç"],
    "Para": ["para", "dolar", "euro", "maaş", "ücret"],
    "Yoksulluk": ["yoksul", "yoksulluk", "asgari", "geçim"],
    "Açlık": ["açlık", "kıtlık"],
    "Demokrasi": ["demokrasi", "seçim", "sandık", "referandum"],
    "Siyaset": ["parti", "milletvekili", "meclis", "muhalefet", "bakan", "kabine"],
    "İktidar": ["iktidar", "cumhurbaşkanı"],
    "Özgürlük": ["özgürlük", "sansür", "yasak", "gözaltı"],
    "Medya": ["gazeteci", "basın", "medya", "televizyon", "rtük"],
    "İnternet": ["internet", "sosyal medya", "erişim"],
    "Eğitim": ["eğitim", "öğrenci", "öğretmen", "üniversite", "yök", "sınav", "okul"],
    "Sağlık": ["sağlık", "hastane", "doktor", "ilaç", "salgın"],
    "Deprem": ["deprem", "sarsıntı"],
    "Çevre": ["çevre", "orman", "kirlilik", "iklim", "=sel", "selde", "sel felaketi"],
    "Kadın": ["kadın", "kadına"],
    "Çocuk": ["çocuk", "çocuğa"],
    "Şiddet": ["şiddet", "cinayet", "öldürdü", "katil"],
    "Emek": ["işçi", "grev", "sendika", "emekçi"],
    "Asker": ["asker", "şehit"],
    "Teknoloji": ["yapay zeka", "teknoloji"],
}
VIKISOZ_YAZAR_DEGIL = {"Kaynakça", "Kaynaklar", "Ayrıca bakınız", "Alıntılar", "Sözler", "Notlar", "Dış bağlantılar"}
VIKISOZ_ATLA = {"Adolf Hitler"}  # haber altında yersiz kaçan yazarlar
_vikisoz_onbellek: dict[str, list[dict]] = {}


def _eslesen(anahtarlar: list[str], metin: str, kelimeler: set[str]) -> int:
    """Kaç anahtar geçiyor: "=x" tam kelime, boşluklu anahtar metin içinde, diğerleri kelime başı."""
    sayi = 0
    for a in (tr_kucuk(x) for x in anahtarlar):
        if a.startswith("="):
            sayi += a[1:] in kelimeler
        elif " " in a:
            sayi += a in metin
        else:
            sayi += any(k.startswith(a) for k in kelimeler)
    return sayi


def _vikisoz_sozleri(sayfa: str) -> list[dict]:
    """Vikisöz konu sayfasındaki sözler: [{metin, yazar}] (yazarı belli olanlar)."""
    if sayfa in _vikisoz_onbellek:
        return _vikisoz_onbellek[sayfa]
    try:
        wt = _site_sorgu("tr.wikiquote.org", action="parse", page=sayfa, prop="wikitext")["parse"]["wikitext"]
    except Exception as e:
        uyari(f"Vikisöz konu sayfası ({sayfa}): {e}")
        wt = ""
    sozler, baslik_yazar, son = [], "", None
    for satir in wt.splitlines():
        m = re.match(r"^==\s*\[\[([^\]|]+)(?:\|[^\]]*)?\]\]\s*==\s*$", satir) or re.match(r"^==\s*([^=]+?)\s*==\s*$", satir)
        if m:
            baslik_yazar = "" if m.group(1).strip() in VIKISOZ_YAZAR_DEGIL else m.group(1).strip()
            son = None
            continue
        if satir.startswith("**") and son is not None and not son["yazar"]:
            y = re.match(r"^\*\*\s*\[\[([^\]|]+)", satir)
            if y:
                son["yazar"] = y.group(1).strip()
            continue
        if re.match(r"^\*(?!\*)", satir):
            ham = satir[1:].replace("<br>", "\n").replace("<br />", "\n").replace("<br/>", "\n")
            yazar = ""
            y = re.search(r"\s[—–-]\s*\[\[([^\]|]+)(?:\|[^\]]*)?\]\]\s*$", ham) or re.search(r"\s[—–-]\s*([A-ZÇĞİÖŞÜ][^\n<]{2,40})$", ham)
            if y:
                yazar, ham = y.group(1).strip(), ham[:y.start()]
            metin = "\n".join(_viki_temizle(x) for x in ham.split("\n")).strip()
            son = {"metin": metin, "yazar": yazar or baslik_yazar}
            if 20 <= len(metin) <= 400:
                sozler.append(son)
    sozler = [x for x in sozler if x["yazar"] and x["yazar"] not in VIKISOZ_YAZAR_DEGIL | VIKISOZ_ATLA]
    _vikisoz_onbellek[sayfa] = sozler
    return sozler


def konu_sozlerini_ekle(konular: list[dict]) -> None:
    """Gündem konularına, kelimeleri eşleşirse bir hiciv ya da söz ekler (konu["konu_sozu"])."""
    try:
        with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "hiciv", "hiciv.json"), encoding="utf-8") as f:
            hicivler = [h for h in json.load(f)["siirler"] if h.get("anahtar")]
    except Exception as e:
        uyari(f"Hicivler okunamadı: {e}")
        hicivler = []
    kullanilan: set[str] = set()
    for konu in konular:
        if konu.get("kategori") != "gundem":
            continue
        metin = tr_kucuk(konu["baslik"] + " " + " ".join(h["baslik"] for h in konu["haberler"][:6]))
        kelimeler = set(re.findall(r"\w+", metin))
        tohum = lambda x: hashlib.sha1(f"{konu['id']}|{x}".encode()).hexdigest()  # noqa: E731
        adaylar = [(_eslesen(h["anahtar"], metin, kelimeler), h) for h in hicivler]
        adaylar = sorted((a for a in adaylar if a[0] and a[1]["baslik"] not in kullanilan),
                         key=lambda a: (-a[0], tohum(a[1]["baslik"])))
        if adaylar:
            h = adaylar[0][1]
            kullanilan.add(h["baslik"])
            konu["konu_sozu"] = {"tur": "hiciv", "baslik": h["baslik"], "metin": "\n\n".join(h["metin"]),
                                 "yazar": h["sair"], "anlam": "\n\n".join(a for a in (h.get("anlam") or []) if a),
                                 "kaynak": h.get("kaynak", ""), "link": h.get("link", "")}
            continue
        sayfalar = sorted(((_eslesen(a, metin, kelimeler), s) for s, a in KONU_SOZ_SAYFALARI.items()),
                          key=lambda a: -a[0])
        sayfalar = [x for x in sayfalar if x[0]]
        for _, sayfa in sayfalar[:2]:
            sozler = [x for x in _vikisoz_sozleri(sayfa) if x["metin"] not in kullanilan]
            if sozler:
                soz = min(sozler, key=lambda x: tohum(x["metin"]))
                kullanilan.add(soz["metin"])
                konu["konu_sozu"] = {"tur": "soz", "metin": soz["metin"], "yazar": soz["yazar"],
                                     "kaynak": f"Vikisöz – {sayfa}",
                                     "link": "https://tr.wikiquote.org/wiki/" + urllib.parse.quote(sayfa.replace(" ", "_"))}
                break


# ---------- ana akış ----------

def konu_sonucu(konu: dict, ozet: str, ozet_kaynagi: str, gecmis: list[dict], kisi_listesi: list[dict],
                metin: dict) -> dict:
    konu["kisiler"] = kisi_listesi
    if metin.get("metin") and ozet_kaynagi == "başlıklar":
        # başlıklardan derlenmiş özet yerine haberin kendi ilk cümleleri
        ozet, ozet_kaynagi = cumle_kirp(" ".join(metin["metin"][:2]), 3), metin["metin_kaynagi"]
    sonuc = {
        "id": hashlib.sha1((konu["tur"] + konu["baslik"]).encode()).hexdigest()[:12],
        "baslik": konu["baslik"],
        "tur": konu["tur"],
        "kategori": konu["kategori"],
        **({"secim": konu["secim"]} if konu.get("secim") else {}),
        "tarih": konu["tarih"],
        "ozet": ozet,
        "ozet_kaynagi": ozet_kaynagi,
        **metin,
        "haberler": [{**{k: h[k] for k in ("baslik", "kaynak", "link", "tarih")},
                      **({"tercih": True} if h.get("tercih") else {})} for h in konu["haberler"]],
        "gecmis": gecmis,
        "kisiler": konu["kisiler"],
        "soru": soru_uret(konu),
        **({"yorumlar": konu["yorumlar"]} if konu.get("yorumlar") else {}),
    }
    print(f"  ✓ {sonuc['baslik'][:60]}  (geçmiş {len(sonuc['gecmis'])}, kişi {len(sonuc['kisiler'])}, "
          f"metin {len(sonuc.get('metin', []))} paragraf{', görsel' if sonuc.get('gorsel') else ''})")
    return sonuc


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

    print("Kaynaklar okunuyor...")
    secimler, konu_sayisi, spor_sayisi, kaynaklar, tercih_sayisi = ayarlari_oku()
    with ThreadPoolExecutor(4) as havuz_is:
        f_haber = havuz_is.submit(google_haberler_konulari)
        f_spor = havuz_is.submit(google_haberler_konulari, GOOGLE_SPOR)
        f_trend = havuz_is.submit(trends_konulari)
        f_rss = havuz_is.submit(rss_havuzu)
        f_secimler = [havuz_is.submit(secim_konulari, s) for s in secimler]
        f_tercih = havuz_is.submit(tercih_konulari, kaynaklar) if kaynaklar else None
        f_yayin = havuz_is.submit(yayin_akisi, secimler)
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

    # Bir önceki çalıştırmanın gündem konuları: üstte tekrar gösterilmez, "Önceki konular" olarak en alta iner
    try:
        onceki_veri = json.loads(CIKTI.read_text(encoding="utf-8"))
        onceki = [{**k, "onceki": True} for k in onceki_veri.get("konular", [])
                  if k.get("kategori") == "gundem" and not k.get("onceki")]
    except Exception:
        onceki = []

    gundem_secilen: list[dict] = []
    spor_secilen: list[dict] = []

    def ekle(k: dict, gundem_siniri: int) -> None:
        """Konuyu spor ya da gündem listesine koyar; aynı konu iki kez girmez."""
        if any(ayni_konu_mu(k, s) for s in gundem_secilen + spor_secilen + secim_secilen):
            return
        if not spor_mu(k) and any(ayni_konu_mu(k, o) for o in onceki):
            return
        if spor_mu(k):
            if len(spor_secilen) < spor_sayisi:
                k["kategori"] = "spor"
                spor_secilen.append(k)
        elif len(gundem_secilen) < gundem_siniri:
            k["kategori"] = "gundem"
            gundem_secilen.append(k)

    if f_tercih:  # tercih edilen kaynakların manşetleri gündemin başına
        for k in f_tercih.result():
            if len(gundem_secilen) >= tercih_sayisi:
                break
            if not spor_mu(k):
                ekle(k, tercih_sayisi)
    haber_en_fazla = len(gundem_secilen) + max(1, round((konu_sayisi - len(gundem_secilen)) * HABER_ORANI))
    for k in haber_konulari:
        ekle(k, haber_en_fazla)
    for k in trend_konulari:
        ekle(k, konu_sayisi)
    for k in haber_konulari:  # Trends yetmezse haberlerle tamamla
        ekle(k, konu_sayisi)
    for k in spor_konulari:  # spor bölümünün kendi konuları
        ekle(k, 0)
    secilen = gundem_secilen + secim_secilen + spor_secilen

    if kaynaklar:
        print("Konular tercih edilen kaynaklarda aranıyor...")
        with ThreadPoolExecutor(4) as is_havuzu:
            list(is_havuzu.map(lambda k: tercih_haberleri_ekle(k, kaynaklar), secilen))
    print("Haber metinleri, görseller ve yayın tarihleri alınıyor...")
    with ThreadPoolExecutor(6) as is_havuzu:
        metinler = list(is_havuzu.map(konu_metni, secilen))
    for k in secilen:
        if not k["haberler"]:
            uyari(f"Konunun bütün haberleri eski, konu atıldı: {k['baslik'][:60]}")
    secilen, metinler = [k for k in secilen if k["haberler"]], [m for k, m in zip(secilen, metinler) if k["haberler"]]
    n_gundem = sum(k["kategori"] == "gundem" for k in secilen)
    n_secim = sum(k["tur"] == "secim" for k in secilen)
    print(f"{n_gundem} gündem + {n_secim} seçim + {len(secilen) - n_gundem - n_secim} spor konusu işleniyor...")
    ozetler = [ozet_bul(k, rss) for k in secilen]
    kose_konulari = [k for k in secilen if k["kategori"] == "gundem"]
    if any(k.get("kose") for k in kaynaklar):
        print("Köşe yazıları aranıyor...")
        with ThreadPoolExecutor(4) as is_havuzu:
            for k, y in zip(kose_konulari, is_havuzu.map(lambda k: kose_yazilari(k, kaynaklar), kose_konulari)):
                k["yorumlar"] = y
    print("Geçmiş haberler aranıyor...")
    with ThreadPoolExecutor(4) as is_havuzu:
        gecmisler = list(is_havuzu.map(gecmis_haberler, secilen))
    print("Kişiler aranıyor (Wikipedia)...")
    kisi_listeleri = kisileri_bul(secilen, [o for o, _ in ozetler], gecmisler)
    konular = [konu_sonucu(k, o, ok, g, kl, m)
               for k, (o, ok), g, kl, m in zip(secilen, ozetler, gecmisler, kisi_listeleri, metinler)]
    print("Konulara söz/hiciv aranıyor...")
    konu_sozlerini_ekle(konular)

    print("Günün hafıza kartları...")
    try:
        hafiza = hafiza_kartlari()
    except Exception as e:
        uyari(f"Hafıza kartları alınamadı: {e}")
        hafiza = []

    try:
        yayinlar = f_yayin.result()
    except Exception as e:
        uyari(f"Yayın akışı alınamadı: {e}")
        yayinlar = []

    CIKTI.parent.mkdir(parents=True, exist_ok=True)
    veri = {"olusturulma": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
            "spor_secimleri": [{"ad": s["ad"], "dal": s.get("dal", "")} for s in secimler],
            "yayinlar": yayinlar,
            "konular": konular + onceki,
            "hafiza": hafiza}
    CIKTI.write_text(json.dumps(veri, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Yazıldı: {CIKTI}")


if __name__ == "__main__":
    main()
