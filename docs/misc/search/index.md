
<style>
    table {
        width: 100%;
    }
</style>

Tunarr features a built-in search index powered by [Meilisearch](https://www.meilisearch.com/). When scanning libraries from your media sources, Tunarr will add information to the search index, which can then be queried to filter content.

Tunarr's search supports a basic query language to create structured searches, as well as a "free text" search which looks within all fields. A syntax diagram of the Tunarr query language can be viewed [here](/search_syntax.html).

## Syntax

Tunarr's search feature different typed fields, such as `string`, `number`, and `date`. Each type has a set of supported operators.

## Strings

| Operator | Description | Example
|---|---|---|
| `:` or `=` | Equals | `title:"30 Rock"`|
| `<` or `<=` | Starts With | `title <= A` |
| `!=` | Not Equals | `title != "Sesame Street"` |
| `~` | Contains | `title ~ Hours` |
| `!~` | Not Contains | `title !~ "Sesame"` |
| `in` | Set includes | `title IN ["30 Rock", "Arrested Development"]` |
| `not in` | Set excludes | `genre NOT IN [comedy, horror]` |

!!! note
    Only **double-quotes** are supported for quoted strings.

## Numbers

| Operator | Description | Example
|---|---|---|
| `:` or `=` | Equals | `video_width = 1920`|
| `<` | Less Than | `minutes < 30` |
| `<=` | Less Than or Equal To | `minutes <= 22` |
| `>` | Greater Than | `minutes > 60` |
| `>=` | Greater Than or Equal To | `minutes >= 60` |
| `!=` | Not Equals | `video_height != 2160` |
| `between` | Range query (`[]` used for inclusive and `()` for exclusive ranges) | `minutes between [10, 30]` |

## Plex numeric ratings and Omnirating

Numeric scores are separate from content classifications. `rating = "PG-13"` still filters age/content ratings. Use `omnirating` or `score("provider", "type")` for review scores.

All numeric rating filters and sorts use **0–100**. Tunarr retains Plex's original 0–10 values for display. Personal ratings also show their equivalent 0–5 stars: `score("plex", "personal") >= 80` means at least four stars.

```text
omnirating > 70
score("imdb", "audience") >= 70.5
score("rottentomatoes", "critic") between [70, 90]
score("plex", "personal") >= 80
```

For example, select Action movies released from 2007 with an Omnirating above 70:

```text
type = "movie" AND genre = "Action" AND release_date >= 2007-01-01 AND omnirating > 70
```

Provider/type identities come from Plex metadata and the saved field catalog. IMDb and Rotten Tomatoes are examples, not guaranteed providers. Unknown providers remain available. Tunarr does not contact review services, download provider images or obtain scores that Plex does not supply. Use the field picker to find the identities available in your library; new fields can wait for search-index setup.

**Omnirating** is the arithmetic mean of distinct public provider/type scores. Critic and audience scores each contribute equally. Duplicate entries and known scalar aliases do not add another vote. Personal stars never contribute. For example, scores of 60, 36, 50 and 65 produce **52.75**. Display values round to two decimal places; filtering and sorting retain full precision.

Missing scores are unknown, not zero. They do not match numeric comparisons, including `!=`, and sort after scored items in either direction. An explicit zero is a valid score. A grouping does not inherit ratings from its parent or children, and vote counts alone do not supply a score.

In library search, use the existing filter builder to choose a score and threshold. Use **Sort by** and **Direction** for highest/lowest scores. **Default order** restores normal ordering, including episode and track order. Keyword searches retain their existing relevance rules. Saved filters retain provider identities even if a later Plex response no longer supplies that score.

Plex item tooltips show original and normalized values, personal stars, contribution counts, aliases and observation time. Previously imported items can remain unknown until a successful detail refresh.

### Refresh existing ratings without a media scan

1. Open the library table and select the **Plex ratings** star action for the library.
2. Select **Refresh ratings only**. The library must be enabled, available and not busy.
3. Check the job status and counts. Metadata processing can reach 100% while search updates are still pending. Only **Completed** confirms the whole job.
4. To stop queued or active work, select **Cancel refresh**. Closing the dialog does not cancel the job.

This operation uses existing item IDs only. It does not discover or delete media, read media files, reconcile durations, change channel schedules or enable libraries. It uses the normal scan queue and library locks, with two metadata requests at a time, a real 10-second request deadline and a 4 MiB response limit. It does not automatically retry failed item requests.

Failed or malformed requests preserve the item's previous snapshot. A successful full response with no ratings clears old scores. Authentication failure stops that library's job; other item failures produce an honest partial result. Account or identity changes stop stale responses from being applied. Search-index failures can leave saved snapshots newer than search results and are reported as unconfirmed updates. Missing base search documents require the normal index rebuild; a ratings refresh does not create incomplete documents.

After correcting a failure, explicitly run **Refresh ratings only** again. Unchanged scores are still sent to the search index. The dialog keeps the last job for each library in server memory; a server restart clears job status, not saved ratings.

## Dates

Date fields support both absolute and relative date expressions.

!!! info
    Date fields accept only 2 formats: `YYYY-MM-DD` or `YYYYMMDD` and can optionally be wrapped in double-quotes.

### Absolute Dates

| Operator | Description | Example
|---|---|---|
| `:` or `=` | Equals | `release_date = 1990-12-05`|
| `<` | Before | `release_date < 2020-01-01` |
| `<=` | On or Before | `release_date <= 2020-01-01` |
| `>` | After | `release_date > 2000-01-01` |
| `>=` | On or After | `added_date >= 2024-06-01` |
| `!=` | Not Equals | `release_date != 2000-01-01` |
| `between` | Date range | `release_date between [2000-01-01, 2010-12-31]` |

### Relative Dates

Relative date expressions let you search based on how recently content was released or added, without specifying exact dates.

| Operator | Description | Example
|---|---|---|
| `inthelast` | Within the given time period | `release_date inthelast 2 weeks` |
| `notinthelast` | Outside the given time period | `added_date notinthelast 1 year` |

Relative dates take a number and a time unit: **day(s)**, **week(s)**, **month(s)**, or **year(s)**.

```
release_date inthelast 30 days
added_date inthelast 6 months
release_date notinthelast 1 year
```

These expressions are evaluated at query time, so "inthelast 2 weeks" always means the most recent two weeks from the current date.

## Compound Queries

Query clauses can be combined using the standard boolean operators `AND` and `OR`. Parentheses can be used to disambiguage query clause groups in more complex queries. For example:

```
genre IN [Horror, Comedy] AND title <= A
```

## Fields

Fields available for search:

| Field | Type | Description | Examples |
|-------|------|---|----|
| `title` | `string` | Program title | 30 Rock | 
| `type` | `string` | Program type | `show`, `movie`, `episode` |
| `rating` | `string` | Program content rating, not a numeric review score | PG-13 |
| `omnirating` | `number` | Mean public review score, excluding personal stars | `omnirating > 70` |
| `score("provider", "type")` | `number` | One Plex-provided score, normalized to 0–100 | `score("imdb", "audience") >= 80` |
| `duration` | `number` | Program duration in milliseconds | - |
| `minutes` | `number` | Program duration in minutes | - |
| `seconds` | `number` | Program duration in seconds | - |
| `actor` | `string` | Actor name | Dwyane Johnson |
| `writer` | `string` | Writer name | - |
| `director` | `string` | Director name | - |
| `genre` | `string` | Program genre | `Comedy` |
| `tags` | `string` | Program tags | - |
| `video_codec` | `string` | Video codec of the program | `hevc` |
| `audio_codec` | `string` | Audio codec of the program | `ac3` |
| `video_height` | `number` | Video height dimension in pixels | `1080` |
| `video_width` | `number` | Video width dimension in pixels | `1920` |
| `video_bit_depth` | `number` | Video pixel bit depth | `10` |
| `audio_channels` | `number` | Whole number audio channels | `2`, `5.1` => `6` | 
| `audio_language` | `string` | Audio language (ISO 639-2 codes - see [Wikipedia page](https://en.wikipedia.org/wiki/List_of_ISO_639-2_codes)), this looks at all available audio languages for the movie/shows | `eng`, `spa` |
| `subtitle_language` | `string` | Subtitle languages (ISO 639-2 codes - see [Wikipedia page](https://en.wikipedia.org/wiki/List_of_ISO_639-2_codes)) | `eng` | 
| `release_year` | `number` | Program release year | `1990` |
| `release_date` | `date` | Program's original release date | `1990-12-05` (`YYYY-MM-DD` or `YYYYMMDD`) |
| `added_date` | `date` | When the program was added to Tunarr | `2024-06-01` |
| `show_title` | `string` | Title of the show a program belongs to (only applicable to episodes) | 30 Rock |
| `show_genre` | `string` | Genre of the show a program belongs to (only applicable to episodes) | comedy |
| `show_tags` | `string` | Tag on the show the program belongs to (only applicable to episodes) | - |
| `show_studio` | `string` | Studio on the show the program belongs to | - |
| `season` | `number` | Season number. For episodes: their season's number; for season groupings: their own number. `0` for Specials. | `1` |
| `media_source_name` | `string` | Name of the media source (Plex server, Jellyfin server, etc.) the program was imported from | `My Plex` |
| `library_name` | `string` | Name of the library within the media source the program belongs to | `TV Shows` |

!!! note
    The `season` field is only populated for content indexed after this change. Force-rescan existing TV libraries to populate it for previously indexed episodes and season groupings.