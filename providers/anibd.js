import { episodeMeta, expectedCount, json } from "../core/new-provider-utils.js";

const BASE = "https://epeng.animeapps.top";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

async function fetchJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!res.ok) throw new Error(`anibd ${res.status}: ${url}`);
  return res.json();
}

async function fetchHtml(url, referer) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml",
      ...(referer ? { Referer: referer } : {}),
    },
  });
  if (!res.ok) throw new Error(`anibd ${res.status}: ${url}`);
  return res.text();
}

async function fetchServers(anilistId) {
  const data = await fetchJson(`${BASE}/api2.php?epid=${anilistId}`);
  return Array.isArray(data) ? data : [];
}

async function fetchPlayerLinks(providerLink) {
  const data = await fetchJson(`${BASE}/apilink.php?data=${encodeURIComponent(providerLink)}`);
  return Array.isArray(data) ? data : [];
}

function absolutizeUrl(raw, origin) {
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw;
  return `${origin}${raw.startsWith("/") ? "" : "/"}${raw}`;
}

function extractVideoUrl(html, origin) {
  const m = html.match(/videoUrl\s*:\s*"([^"]+)"/);
  if (!m) return null;
  return absolutizeUrl(m[1], origin);
}

// AniBD's own site plays subtitles fine, but this scraper only ever pulled
// `videoUrl` out of the player script and discarded everything else on the
// page — including whatever subtitle/track info sits right next to it, so
// no `subtitles` field was ever sent back to the client.
// Different AniBD mirrors phrase the track info differently, so we try a
// few known shapes here and merge whatever matches instead of betting on
// just one. If the mirror uses a shape none of these catch, this returns
// [] (same silent-no-subs behaviour as before) rather than throwing.
function extractSubtitles(html, origin) {
  const subs = [];
  const seen = new Set();

  const add = (rawUrl, label) => {
    const url = absolutizeUrl(rawUrl, origin);
    if (!url || seen.has(url)) return;
    seen.add(url);
    const ext = url.match(/\.(vtt|srt|ass)(?:\?|#|$)/i)?.[1]?.toLowerCase() || "vtt";
    subs.push({ url, label: label || "", srclang: "", format: ext, default: subs.length === 0 });
  };

  // Shape 1: native <track kind="subtitles"|"captions" src="..." label="..."> tags
  const trackRe = /<track\b([^>]*)>/gi;
  let t;
  while ((t = trackRe.exec(html)) !== null) {
    const attrs = t[1];
    const kind = attrs.match(/kind=["']?([^"'\s>]+)/i)?.[1] ?? "";
    if (kind && !/^(subtitles|captions)$/i.test(kind)) continue;
    const src = attrs.match(/src=["']([^"']+)["']/i)?.[1] ?? attrs.match(/src=([^\s"'>]+)/i)?.[1];
    if (!src) continue;
    const label = attrs.match(/label=["']([^"']*)["']/i)?.[1] ?? "";
    add(src, label);
  }

  // Shape 2: a bare key next to videoUrl, e.g. subUrl / subtitle / subtitleUrl / captionUrl: "..."
  const kvRe = /\b(?:subUrl|subsUrl|subtitleUrl|subtitle|captionUrl|captions?)\s*:\s*"([^"]+)"/gi;
  let kv;
  while ((kv = kvRe.exec(html)) !== null) add(kv[1], "");

  // Shape 3: jwplayer-style tracks: [ {file:"...", label:"...", kind:"captions"}, ... ]
  const tracksMatch = html.match(/tracks\s*:\s*\[([\s\S]*?)\]/i);
  if (tracksMatch) {
    const itemRe = /\{[^{}]*\}/g;
    let im;
    while ((im = itemRe.exec(tracksMatch[1])) !== null) {
      const item = im[0];
      if (!/kind\s*:\s*["'](captions|subtitles)["']/i.test(item)) continue;
      const file = item.match(/file\s*:\s*["']([^"']+)["']/i)?.[1];
      const label = item.match(/label\s*:\s*["']([^"']*)["']/i)?.[1] ?? "";
      if (file) add(file, label);
    }
  }

  return subs;
}

async function resolvePlayerStream(playerLink) {
  const origin = new URL(playerLink).origin;
  const referer = `${origin}/`;
  const html = await fetchHtml(playerLink, referer);
  const hls = extractVideoUrl(html, origin);
  if (!hls) throw new Error(`anibd: no videoUrl found at ${playerLink}`);
  const subtitles = extractSubtitles(html, origin);
  return { hls, referer, subtitles };
}

function audioFromServerName(name = "") {
  return /dub/i.test(name) ? "dub" : "sub";
}

function buildEpisodeLists(anilistId, groups, ctx, expected) {
  const sub = [];
  const dub = [];
  const seenSub = new Set();
  const seenDub = new Set();
  for (const group of groups) {
    const audio = audioFromServerName(group.server_name);
    for (const ep of group.server_data ?? []) {
      const number = Number(ep.name ?? ep.slug);
      if (!Number.isFinite(number) || number < 1) continue;
      if (expected && number > expected) continue;
      const bucket = audio === "dub" ? dub : sub;
      const seen = audio === "dub" ? seenDub : seenSub;
      if (seen.has(number)) continue;
      seen.add(number);
      const meta = episodeMeta(number, ctx);
      bucket.push({
        id: `watch/anibd/${anilistId}/${audio}/anibd-${number}`,
        number,
        title: meta.title ?? `Episode ${number}`,
        duration: meta.duration,
        filler: meta.filler,
        uncensored: meta.uncensored,
        description: meta.description,
        image: meta.image,
        airDate: meta.airDate,
        sourceLink: ep.link,
        audio,
      });
    }
  }
  sub.sort((a, b) => a.number - b.number);
  dub.sort((a, b) => a.number - b.number);
  return { sub, dub };
}

export async function getEpisodes(anilistId, ctx = {}) {
  const groups = await fetchServers(anilistId);
  if (!groups.length) throw new Error(`anibd: no episodes found for AniList ${anilistId}`);
  const expected = expectedCount(ctx.media, ctx.anizip, ctx.jikanEps);
  return {
    meta: {
      id: String(anilistId),
      source: "anibd",
      matchScore: 1,
      numbering: "standard",
      episodeOffset: 0,
    },
    episodes: buildEpisodeLists(anilistId, groups, ctx, expected),
  };
}

async function findEpisodeLink(anilistId, audio, epNum) {
  const groups = await fetchServers(anilistId);
  for (const group of groups) {
    if (audioFromServerName(group.server_name) !== audio) continue;
    for (const ep of group.server_data ?? []) {
      if (Number(ep.name ?? ep.slug) === Number(epNum)) return ep.link;
    }
  }
  return null;
}

async function handleWatch(anilistId, audio, epNum) {
  const providerLink = await findEpisodeLink(anilistId, audio, epNum);
  if (!providerLink) return json({ error: `anibd episode ${epNum} not found` }, 404);

  const servers = await fetchPlayerLinks(providerLink);
  const streams = [];
  let activeAssigned = false;

  for (const entry of servers) {
    if (!entry?.link) continue;
    try {
      const { hls, referer, subtitles } = await resolvePlayerStream(entry.link);
      streams.push({
        url: hls,
        type: "hls",
        server: entry.server ?? "AniBD",
        referer,
        subtitles,
        priority: activeAssigned ? 4 : 5,
        isActive: !activeAssigned,
      });
      activeAssigned = true;
    } catch {
      streams.push({
        url: entry.link,
        type: "embed",
        server: entry.server ?? "AniBD",
        referer: `${new URL(entry.link).origin}/`,
        priority: 1,
        isActive: false,
      });
    }
  }

  return json({ anilistId: Number(anilistId), episode: Number(epNum), audio, streams });
}

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,OPTIONS",
          "Access-Control-Allow-Headers": "*",
        },
      });
    }
    const url = new URL(request.url);
    try {
      const m = url.pathname.match(/^\/watch\/anibd\/(\d+)\/(sub|dub)\/anibd-(\d+)\/?$/);
      if (m) return await handleWatch(m[1], m[2], m[3]);
      return json({ error: "Not found" }, 404);
    } catch (err) {
      return json({ error: err.message, stack: err.stack }, 500);
    }
  },
};
