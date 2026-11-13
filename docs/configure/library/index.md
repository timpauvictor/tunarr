# Library

The Library contains reusable collections of content that can be used across multiple channels. This includes filler content for gaps in your schedule and custom shows that group videos together.

<div class="grid cards" markdown>

-   **[Filler](filler.md)**

    ---

    Collections of videos to play during [Flex](../channels/flex.md) time segments, such as commercials, bumpers, or interstitials.

-   **[Custom Shows](custom-shows.md)**

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
| **Custom Shows** | YouTube series, home videos, or any content you want to treat as episodic |
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

Import stores metadata, not downloaded source videos or a playback guarantee. Existing transcode/profile limitations still apply: split inputs require transcoding, and ErsatzTV requires dynamic playout.
