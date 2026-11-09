# AI visibility and crawlability acceptance — 2026-11-09

This record combines the local source/build check completed on 2026-11-09 with separately dated remote observations below. It does not promise that the new examples are indexed or cited by AI systems.

## Verified in the current worktree

- The inspected public HTML pages have one `h1`, a canonical link, and a meta description. The legal pages `cookie`, `privacy`, `refund`, and `terms` carry `noindex, nofollow`; the other inspected pages do not carry a blocking robots meta tag.
- The public `/examples/` page is now in the static build allowlist and sitemap. Its four image assets and two MP4 assets are present under `media/examples/`; the MP4 manifest records the exact source sizes `2,717,894` and `3,121,309` bytes.
- `sitemap.xml` lists the root and the indexable editorial/product routes. The noindex legal pages are not listed.
- `robots.txt` is currently:

  ```text
  User-agent: *
  Allow: /
  Sitemap: https://fancycafeaivideo.pro/sitemap.xml
  ```

  No extra crawler user-agent or WAF rule was inferred or added.
- `scripts/build-static.mjs` publishes only its explicit top-level directory/file allowlist and approved public extensions. `.data` and `.secrets` are not in that allowlist. The recursive `media` copy is already available for public media nested under `media/`.
- Existing `deploy/video-assets.mjs` sizes match the three tracked MP4 files: `pet.mp4` 586,136 bytes, `reference-19s.mp4` 2,293,781 bytes, and `reference-preview.mp4` 288,226 bytes.
- The final build passed 107 tests, and all six example assets plus the original MP4 manifest entries matched their recorded SHA/byte-length checks.

## Link and route result

- The previously identified `/history`, `/settings/files`, and `/settings/security` dead-link paths were removed across the site; the latest-video entry now points to `/#generator`.

## Generation media integration boundary

The current public examples are under `examples/` and `media/examples/`. The existing recursive media allowlist copies the approved image/video extensions, while `deploy/video-assets.mjs` now records both example MP4 byte lengths for range serving. The publish test also rejects private `.data` and `.secrets` directories in built output.

## Remote evidence supplied by root

- Cloudflare GraphQL window `2026-11-08T03:42:25Z` to `2026-11-09T03:42:25Z`: `OAI-SearchBot` had 2 verified Search Engine Crawler requests, both HTTP 200. Googlebot had 29 requests: 15 HTTP 200, 10 HTTP 301, and 4 HTTP 307. The 307s were directory-slash redirects for `/about` and `/first-time-in-a-fancy-cafe-ai-free`; no 403/429 was observed for those crawlers.
- GSC (checked 2026-11-09) confirms the existing property and sitemap processing. The prior sitemap report said 11 discovered pages; that is discovery, not proof that 11 pages were indexed. The homepage URL Inspection was actually indexed, crawlAllowed/indexAllowed were true, fetch succeeded, and Google canonical matched the inspected homepage. Last crawl shown was `2026-11-08 18:59:20`.
- Video indexing was 0 in the supplied GSC summary. Bing had only a public landing page in the current browser session; no signed-in property evidence was available, so no Bing indexing conclusion is made.
- No AI answer citation or conversion claim is made from these crawler/GSC observations. No robots or WAF change was necessary; the supplied zone evidence showed no custom firewall/rate-limit block relevant to this check.
- This record is the pre-publish technical verification for the new examples route/media. The final release SHA and post-publish online playback/download review are recorded separately; no deployment or new examples indexing result is claimed here.

## What remains unverified

Technical crawlability is not evidence that a URL is indexed, ranked, or cited by an AI system.
