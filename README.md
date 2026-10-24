# Önceliklerim

Kişisel öncelik listesi + Telegram hatırlatıcı.

- **Sayfa** (`index.html`, GitHub Pages): görev ekle, öncelik ver, "Yapıldı mı? → Evet" ile listeden çıkar.
- **Bot** (`scripts/notify.mjs`, GitHub Actions, 5 dakikada bir): zamanı gelen görevleri Telegram'a gönderir. Mesajdaki **✅ Yaptım** butonuna basınca görev listeden çıkar ve bir daha hatırlatılmaz.
- Görevler `data` dalındaki `tasks.json` içinde **şifreli** durur (AES-GCM, şifre: `TASKS_PASSWORD`). Repo public olsa da içerik okunamaz.

| Öncelik | Hatırlatma |
|---|---|
| 1 | Bitene kadar saatte bir |
| 2 | 3 saatte bir |
| 3 | Günde bir (09:00) |
| 4 | 2 günde bir (09:00) |
| 5 | Haftada bir (09:00) |

İş görevleri yalnızca **Pazartesi–Cuma 08:00–18:00**, ev görevleri **her gün 08:00–22:00** arasında hatırlatılır (Türkiye saati). Pencere dışında zamanı gelen hatırlatma bir sonraki uygun saate kayar (ör. Cuma 18:00 sonrası iş → Pazartesi 08:00). GitHub'ın zamanlayıcısı birkaç dakika, yoğun saatlerde biraz daha gecikebilir.

## Kurulum

1. **Telegram botu:** Telegram'da `@BotFather` → `/newbot` → bir isim ve `..._bot` ile biten kullanıcı adı ver. Verdiği **token**'ı kopyala.
2. **Secret'lar:** Repo → Settings → Secrets and variables → Actions → *New repository secret*
   - `TELEGRAM_BOT_TOKEN` = BotFather'ın verdiği token
   - `TASKS_PASSWORD` = görevleri şifreleyecek, kendi belirlediğin bir şifre
3. **Pages:** Repo → Settings → Pages → *Deploy from a branch* → `main` / `(root)`.
4. **Sayfa token'ı:** GitHub → Settings → Developer settings → Fine-grained tokens → *Generate new token*
   - Repository access: *Only select repositories* → bu repo
   - Permissions → Contents: **Read and write**
5. **Bağla:** Telegram'da botuna `/start` yaz. Repo → Actions → *Hatırlatıcı* → *Run workflow* (ya da 5 dk bekle). "✅ Bağlandı!" mesajı gelir.
6. **Kullan:** `https://<kullanıcı>.github.io/<repo>/` adresini aç, ⚙️ kısmına token'ı ve `TASKS_PASSWORD` ile aynı şifreyi gir.

Bot komutları: `/liste` açık görevleri gösterir.
