<div align="center">

# Anivexa API 2.1

**Anime streaming aggregator API — one endpoint, all your sources.**

![Views](https://visitor-badge.laobi.icu/badge?page_id=walterwhite-69.Anivexa-API)
[![Discord](https://img.shields.io/badge/Join%20Discord-5865F2?style=flat-square&logo=discord&logoColor=white)](https://discord.com/invite/zs22ZJttZM)
[![GitHub stars](https://img.shields.io/github/stars/walterwhite-69/Anivexa-API?style=flat-square&color=yellow)](https://github.com/walterwhite-69/Anivexa-API/stargazers)

</div>

---

## What is this?

A single API that aggregates anime episode lists and streaming links from multiple providers. Give it an AniList ID, get back everything — episodes, sources, and stream URLs — all in one place.

It's the backbone powering **[Anivexa](https://github.com/walterwhite-69/Anivexa)**, a full anime streaming client built on top of this.

---

## Providers

| Provider | Status | Notes |
|---|---|---|
| **AnimePahe** | ⚠️ Unstable | Recently switched from DDoS-Guard to Cloudflare JS Challenge — may need updates |
| **AllManga** | ✅ Active | Great coverage, sub + dub |
| **Reanime** | ✅ Active | Solid source for a wide range of titles |
| **AniKoto** | ✅ Active | Good library, consistent |
| **AnimeGG** | ✅ Active | Fuzzy title matching, handles sequels well |
| **AniNeko** | ✅ Active | Reliable slug-based matching |
| **AniDB App** | ✅ Active | Language-aware, AniDB ID backed |

---

## Routes

```
GET /map/:anilistId
```
Returns cross-platform ID mappings — MAL, TVDB, TMDB, Kitsu, AniDB, and more.

```
GET /episodes/:anilistId
```
Returns episode lists from all providers in a single response, with smart background refresh.

```
GET /watch/:provider/:anilistId/sub|dub/:provider-:ep
```
Returns stream URLs for a specific episode from a specific provider.

```
GET /stream/reanime/:id/sub|dub/:ep
```
302 redirect directly to the HLS stream.

---

## Self-hosted

```bash
git clone https://github.com/walterwhite-69/Anivexa-API
cd all-api
node server.js
```

Runs on Node.js. No build step needed.

---

## Contributing

> **Only request providers that self-host their content. No scrapers of third-party sites.**

Got a provider you'd like added? Open an issue or drop it in the Discord.

This project is community-kept-alive — if it helps you, please:

- ⭐ **Star the repo** so others can find it
- 💬 **[Join the Discord](https://discord.com/invite/zs22ZJttZM)** to discuss, report issues, or suggest providers
- 🛠️ **Open a PR** if you want to add or fix something

---

## Note on AnimePahe

When this was last updated, AnimePahe switched from DDoS-Guard to a Cloudflare JS Challenge. The provider code is there but may not work reliably right now. I'll push a fix when I figure out the new bypass — or feel free to contribute one.

---

<div align="center">

hope it helped :3
and bro it took me a while to make, so thank me later

[![Discord](https://img.shields.io/badge/Join%20the%20community-5865F2?style=for-the-badge&logo=discord&logoColor=white)](https://discord.com/invite/zs22ZJttZM)

</div>
