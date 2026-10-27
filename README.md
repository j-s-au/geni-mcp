# geni-mcp

An MCP server for the [Geni.com](https://www.geni.com) genealogy API. It covers all 89 documented REST endpoints with 48 tools, and is built for careful research on a shared world tree. Requests are slow on purpose, every write is logged, and anything that changes the tree's structure must be enabled explicitly.

## What it does

- **Read the tree:**
  - profiles, singly or 50 at a time;
  - immediate family;
  - **ancestors up to 20 generations in one call, numbered Ahnentafel-style, with a list of missing numbers**;
  - descendants, found by walking the tree;
  - relationship paths (with Geni's notifications and emails turned off);
  - side-by-side comparison of two profiles;
  - name search and tree matches.
- **Edit profiles:**
  - change names, events, occupation and visibility, with a dry-run preview showing before and after;
  - append dated research notes to a profile's About text without touching what's already there.
- **Add sources:** create documents from scans, PDFs, transcriptions or URLs, tag them to profiles, and comment on them.
- **Work with media and the rest:**
  - photos, videos and albums, including main profile photos;
  - projects, surname pages, and your own lists (managed profiles, max family, followed items, uploads);
  - revisions and statistics;
  - a read-only `geni_raw_get` for anything else.

## Safety model

| `GENI_WRITE_LEVEL` | Allows |
|---|---|
| `readonly` | Reads only |
| `safe` (default) | Plus in-place edits: profile and union updates, notes, documents, media, tags, comments, projects, follows |
| `full` | Plus structural changes: `create_profile`, `add_relative`, `add_to_union`, `merge_profiles`, `delete_profile`, `delete_media` |

- **Structural tools** also refuse to run without `confirm: true` on each call.
- **Every write** is appended to `~/.config/geni-mcp/audit.jsonl` with a timestamp, the target, the request, and the earlier values where they were fetched. Uploaded file contents are never logged.
- **Uploads** of a local file need `confirm: true`; without it the tool names the file and its size and sends nothing. Files come only from the upload folders (`GENI_UPLOAD_DIRS`, default `~/Documents`). Only known image, PDF, text and video types are accepted. Hidden files and the server's config folder are always refused, so text on a Geni profile can't trick Claude into publishing your private files.
- **Pacing:**
  - Requests are serialised and spaced 2 s apart by default; Geni allows 40 per 10 s.
  - The server honours Geni's `X-API-Rate-*` headers, and pauses the whole queue when throttled.
  - Every request times out after 60 s.
- **Blocks:** if Geni returns an IP-block page, the server refuses all further calls for 30 minutes.
- **`geni_raw_get`** refuses write endpoints (add, update, delete, merge, tag and similar), and any path containing `%`, `;`, whitespace or control characters, which could hide one.

## Setup

1. Register an app at <https://www.geni.com/platform/developer/apps> with callback `http://geni-mcp.test:3000/oauth/callback`.
   - Geni's firewall blocks redirect URIs containing `localhost` (and can block your IP for 24 hours), so use a made-up hostname and map it to this computer: `echo "127.0.0.1 geni-mcp.test" | sudo tee -a /etc/hosts`.
2. Install and build:
   ```bash
   git clone https://github.com/j-s-au/geni-mcp.git ~/geni-mcp
   cd ~/geni-mcp && npm ci && npm run build
   ```
3. Configure it: `cp env.example ~/.config/geni-mcp/env && chmod 600 ~/.config/geni-mcp/env`, then fill in the app id and secret.
4. Register the server with Claude Code: `claude mcp add geni -s user -- ~/geni-mcp/run-local.sh`
5. In Claude, run `auth_start` and open the URL. A listener on 127.0.0.1, port 3000, catches Geni's redirect and saves the token to `~/.config/geni-mcp/tokens.json` (mode 600). The token refreshes automatically.
   - If the listener can't start, or there is no hosts entry (the browser then shows an error page), paste the redirect URL into `auth_complete` instead.

## Tools

| Tool | Level | Purpose |
|---|---|---|
| `auth_start` | read | Log in to Geni |
| `auth_complete` | read | Finish Geni login manually |
| `auth_status` | read | Login state, token expiry, rate-limit headers, write level |
| `auth_logout` | read | Revoke and delete the token |
| `get_user` | read | Current Geni user |
| `get_profile` | read | Get a Geni profile |
| `get_profiles` | read | Get up to 50 profiles |
| `get_immediate_family` | read | Parents, siblings, partners, children, union ids |
| `get_ancestors` | read | Ancestors (Ahnentafel), up to 20 generations (6 when walking, see below) |
| `get_descendants` | read | Descendants (one request per person) |
| `get_relationship_path` | read | Relationship and linking chain (no notifications) |
| `compare_profiles` | read | Immediate families of two profiles side by side |
| `search_profiles` | read | Name search |
| `list_profile_media` | read | Documents, photos or videos on a profile |
| `get_tree_matches` | read | Tree matches (experimental, undocumented endpoint) |
| `update_profile` | safe | Update a profile |
| `append_about_note` | safe | Append a dated research note to About |
| `follow_profile` | safe | Follow or unfollow a profile |
| `create_profile` | full + confirm | Create an unconnected profile |
| `add_relative` | full + confirm | Add a parent, child, partner or sibling |
| `merge_profiles` | full + confirm | Merge two profiles |
| `delete_profile` | full + confirm | Delete a profile |
| `get_union` | read | Get unions (couples) |
| `update_union` | safe | Update marriage or divorce |
| `add_to_union` | full + confirm | Add a child or partner to a couple |
| `get_media` | read | Get documents, photos, videos or albums |
| `media_related` | read | Comments, tagged profiles, projects or album photos |
| `create_document` | safe (+ confirm for a file) | Create a document (source) |
| `upload_media` | safe + confirm | Upload a photo or video |
| `set_profile_photo` | safe (+ confirm for a file) | Set a profile's main photo |
| `update_media` | safe | Update a document, photo or video |
| `tag_media` | safe | Tag or untag profiles |
| `add_comment` | safe | Comment on a document, photo or video |
| `delete_media` | full + confirm | Delete a document, photo or video |
| `save_album` | safe | Create or rename a photo album |
| `get_project` | read | Get projects |
| `search_projects` | read | Search projects |
| `project_members` | read | Project profiles, collaborators or followers |
| `add_to_project` | safe | Add profiles or documents to a project |
| `update_project` | safe | Update a project |
| `get_surname` | read | Get a surname page |
| `surname_members` | read | Surname profiles or followers |
| `list_mine` | read | Managed profiles, max family, followed items, uploads, albums, labels |
| `get_app_metadata` | read | Read this app's per-user note (512 bytes) |
| `save_app_metadata` | safe | Save this app's per-user note |
| `get_revision` | read | Get a revision |
| `world_tree_stats` | read | World Family Tree size and statistics |
| `geni_raw_get` | read | Raw GET for any API path |

Endpoints deliberately left out: `user/add`, which creates Geni accounts.

## Things the Geni docs leave open

Confirmed live on 28 Oct 2026:
- `immediate-family` returns `{focus, nodes}`, with profiles and unions linked by `edges` (`rel: partner | child`) on both sides. Nodes are keyed by numeric id even when you ask by GUID.
- Batch `ids=` returns `{results: [...]}`, not in request order.
- Errors look like `{error: {type, message}}`, e.g. 403 `ApiException: Approved client app required`.
- **`profile/ancestors` needs an app approved by Geni.** Until then `get_ancestors` climbs `immediate-family` one person per request, capped at 6 generations.
- Geni's firewall blocks a `localhost` redirect URI (see Setup).

Still assumptions, to be confirmed on first use: See the Geni developer docs at https://www.geni.com/platform/developer/help.

- The HTTP status for throttling is undocumented. Errors are classified defensively.
- Dates on document, photo and video writes are sent as a JSON-serialised Date object, as the docs describe.
- `merge_profiles` does not document which profile survives.
- `append_about_note` must replace the whole About text, because Geni has no append. It re-reads the text just before writing and refuses if it changed, or if About text exists only in another language.
- `profile/search` documents only a `names` parameter.

## Development

```bash
npm test            # unit + tool tests with a fake Geni (no network)
npm run coverage    # 80% thresholds enforced
npm run typecheck
npm run build
```
