# Library

The Library contains reusable collections of content that can be used across multiple channels. This includes filler content for gaps in your schedule and playlists that group videos together.

<div class="grid cards" markdown>

-   **[Filler](filler.md)**

    ---

    Collections of videos to play during [Flex](../channels/flex.md) time segments, such as commercials, bumpers, or interstitials.

-   **[Playlists](playlists.md)**

    ---

    Create virtual TV shows by grouping videos into episodes. Scheduling tools will treat these as a single show.

-   **[Smart Collections](smart-collections.md)**

    ---

    Dynamic collections that automatically include content matching specified criteria.

-   **[Trash](trash.md)**

    ---

    Items that went missing since their last scan, held for review before they are permanently removed.

</div>

## When to Use Each

| Feature | Use Case |
|---------|----------|
| **Filler** | Commercials, station IDs, bumpers, short clips to fill gaps |
| **Playlists** | YouTube series, home videos, or any content you want to treat as episodic |
| **Smart Collections** | Auto-updating playlists based on genre, year, rating, etc. |
| **Trash** | Reviewing and permanently removing content that disappeared from your media |

## Plex review scores

The media library table has a **Plex ratings** star action for Plex libraries. **Refresh ratings only** updates review scores for existing items without a full media scan, file reads or schedule changes. The library must be enabled and available; the action never enables it for you.

Use numeric score fields or **Omnirating** to filter and sort imported content. The existing `rating` field still means the age/content classification. See the [numeric ratings search and refresh guide](../../misc/search/index.md#plex-numeric-ratings-and-omnirating) for score units, missing values, personal stars and partial-job recovery.

## YouTube videos and ordered collections

Configure a **YouTube** media source and use **Test setup** to check its configured extractor and JavaScript runtime. These companion tools must be available on the server. YouTube availability is best-effort; only import content you are authorized to use. Account cookies, private/paid content, DRM and running livestreams are not supported.

Tunarr reuses its own Node runtime for YouTube JavaScript challenges, including the Node embedded in standalone Tunarr executables. No Deno installation or second Node download is required. An administrator can optionally select a trusted Node >=22 executable with `TUNARR_YOUTUBE_JS_RUNTIME_PATH`; leave it unset to use Tunarr's runtime. This does not bypass YouTube account, CAPTCHA or access restrictions. **Test setup** checks the extractor pin and runtime without playing a video.

1. Open the channel programmer and select the YouTube source, or use **Import YouTube links** in the Library table.
2. Paste one HTTPS YouTube video, playlist or creator URL per line. A watch link containing both a video and playlist requires an explicit choice. Creator links resolve to the canonical channel's uploads collection, including eligible recorded uploads rather than only one channel tab. Choose **Newest first** or **Oldest first** for creators.
3. Review the entries. Playlist order and repeated occurrences are preserved, while repeated inputs are reported and are not expanded twice. Unknown-duration and unavailable entries remain visible but cannot be added. Confirm exclusions before adding a partial eligible set.
4. In the programmer, select occurrences or use **Select all eligible**, then **Add to programming**. Existing draft items stay in place. Only normal **Save** persists channel programming; importing alone does not modify it. Imported metadata remains in the Library if you discard the draft.

Use the import dialog's **Saved collections** tab to browse an existing collection without extraction or media probing. Grid/list view and pagination retain occurrence selection, even when several entries refer to the same video. **Refresh collection** updates its metadata and membership. The Library table's existing scan controls refresh all saved collections and individual videos, with the normal queue/progress ownership.

**Refreshing updates this library, not existing channel programming.** Removed playlist entries do not delete the catalogue video or rewrite saved order, durations or channel timing. Apply desired changes deliberately through the existing programmer and Save.

Enumeration must finish before collection membership is published. Cancellation, temporary failure or a safety limit retains the last complete snapshot and its successful-refresh time. Retry uses the same programme/occurrence identity, not duplicate catalogue rows. The default collection limit is 1,000 entries; administrators can set `TUNARR_YOUTUBE_MAX_COLLECTION_ENTRIES` from 1 to 10,000. A request accepts at most 50 links and 10,000 total entries. Limits produce an explicit error, never a silently shortened playlist.

Import stores metadata, not downloaded source videos or a playback guarantee. Existing transcode/profile limitations still apply: split inputs require transcoding, and ErsatzTV requires dynamic playout. Normal linear channels advance while nobody watches. **On-Demand** is the separate, explicit pause-on-idle setting; importing YouTube does not enable it.

### Server tools

This build requires **yt-dlp 2026.10.26** and **Node >=22**. Tunarr reuses its owning Node, including embedded Node in standalone builds. The extractor's bundled JavaScript solver runs locally; remote components, user extractor configuration, plugins, cookies and extractor caches are disabled.

- **Source checkout / dev container:** `pnpm dev` in `server/` attempts optional provisioning. To install or retry explicitly, run `pnpm --dir server download-youtube` from the repository root. An offline optional download does not stop other sources.
- **Standalone:** keep `yt-dlp` (`yt-dlp.exe` on Windows) beside Tunarr, with `yt-dlp-LICENSE.txt` and `yt-dlp-THIRD_PARTY_LICENSES.txt`. Extract the whole archive, not just the Tunarr executable. Lookup also supports the existing `bin/` layout and architecture-suffixed build artifacts.
- **Production container:** the existing binary build provisions the companion and notices; `/tunarr/bin/yt-dlp` points to the artifact. No Deno or extra Node download is added.
- **Administrator override:** `TUNARR_YTDLP_PATH` selects a trusted extractor executable, not an options string or directory. Its version must still match the tested pin. `TUNARR_YOUTUBE_JS_RUNTIME_PATH` optionally selects a trusted Node >=22 executable. Missing or mismatched tools disable YouTube operations, not other media sources. Do not use yt-dlp's self-update command against the bundled companion; reinstall the matching Tunarr companions instead.

Downloads use pinned SHA-256 values, including the complete upstream license texts, and validate all needed bytes before replacing an existing binary. The Alpine x64 target uses the official musl artifact, not a renamed glibc build. macOS x64/arm64 use the universal upstream artifact. The current Linux x64 container and Windows x64 provisioned-tool paths have native smoke evidence; Linux arm64, Alpine and macOS native operation remain **Unverified**, as does a fresh full production-image boot. Target mappings and archive layouts are checked but are not native execution claims.

The standalone yt-dlp builds include third-party software and are distributed under GPLv3+ as described by upstream. Retain both bundled notice files. See the [pinned release and source](https://github.com/yt-dlp/yt-dlp/releases/tag/2026.10.26) and [upstream source/license details](https://github.com/yt-dlp/yt-dlp/blob/2026.10.26/THIRD_PARTY_LICENSES.txt). Distributors must satisfy the applicable source and license obligations; this guide is not a legal compliance certification.

### Playback compatibility

| Path | YouTube behavior |
| --- | --- |
| Conventional FFmpeg HLS | Separate audio/video inputs, matched seeks and saved slot bounds have target-host evidence. Use a compatible transcoding profile. |
| ErsatzTV dynamic playout | Split inputs have pinned-worker evidence. Keep dynamic playout enabled. |
| ErsatzTV static/pre-resolved windows | Explicitly unsupported for YouTube; use dynamic playout. |
| Copy/remux/direct-only profiles | Split inputs require transcoding. Change the profile explicitly; Tunarr does not silently remove audio or change profiles. |
| Other native platforms, output modes and physical TV clients | Do not infer support from a metadata import. Variants without their own receipt remain unverified; check a representative channel before relying on them. |

Playback resolves fresh stream inputs when a viewer-owned attempt needs them. Import, collection browsing, guide generation and ordinary setup tests do not probe or download media. Existing bounded playback buffers and temporary segments still apply; there is no full-video staging or always-on playlist prefetch. Signed inputs are not a persistent playback cache. After the last viewer, cleanup follows the existing session rules (including heartbeat staleness and the cleanup delay), not an immediate guarantee when a TV is switched off.

### Recovery

| Symptom | Action |
| --- | --- |
| Test setup reports missing/mismatched tools | Reinstall all matching companions, or rerun the source provisioning command. Check executable permissions and trusted override paths, then retry **Test setup**. This checks tools only. |
| Import is unavailable, pending or partial | Review the entry details. Unknown/zero-duration items are not schedulable. Retry after access or metadata recovers; explicitly confirm exclusions before Add. Import success does not verify playback. |
| Collection refresh fails, loops or hits a safety limit | Keep the last complete collection. Check its successful-refresh time and diagnostic detail, then retry **Refresh collection**. Use smaller authorized collections or an appropriate configured entry limit; incomplete membership is never published as complete. |
| Cancelled request or connection failure | Inputs and saved programming remain. Retry the same operation. Closing or navigating away stops owned work; late results cannot append into another draft. |
| JavaScript challenge, CAPTCHA, sign-in or rate limit | A JavaScript runtime does not bypass access controls. Wait and retry only when appropriate; this build does not accept cookies or accounts, including Premium. Do not expose credentials to extractor arguments. |
| Playback fails after a successful import | Check the channel's transcode/profile and worker mode, then use the existing stream troubleshooting tool. Its explicit probe can temporarily request media. An unavailable source fills the remaining saved slot rather than compressing the channel schedule. |

To apply a refreshed collection deliberately, use **Edit channel programming** from its Library row, choose the channel, and use the normal programmer's Add/Save flow. Refresh never rewrites existing channels, and there is no synchronization wizard.
