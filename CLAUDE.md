# Page Turners — notes for Claude Code

This app runs on **Homeroom**. If you're Claude Code
editing this repo, read the platform conventions before making
changes:

**Platform conventions (authoritative, always current):**
https://app.onhomeroom.com/claude.md

Fetch that URL at the start of each session — it's the single source
of truth for platform-wide behavior (auth model, `USERNODE_ENV`,
public/private tables, "don't `git push`", etc.). The hosted copy is
updated in place when platform rules change, so fetching it gives you
today's rules, not a stale snapshot.

When running inside Homeroom's dev-chat, those same conventions are
already injected into your system prompt, so the fetch is a no-op in
that path — but it's the right reflex when someone runs Claude Code
against this repo locally or from another harness.

## Connector permission prompts

This repo ships `.claude/settings.json`, which allows the **read-only**
Homeroom connector calls (`mcp__homeroom__get_*`,
`…__list_*`, `…__whoami`) so they stop prompting one at a time. Everything
that acts — filing a request, opening or advancing a proposal — still asks.
Claude Code applies those rules only after you accept the
workspace trust dialog, which lists them for review. See `.claude/README.md`
for the whole story, including what to do if you are still being prompted
(usually: your connector is registered under a different name than the rules
assume).

## Check that this checkout is current

You may be working in a fork of this app whose `main` is behind the app's
canonical repository, and nothing in the checkout says so: `git fetch origin`
compares the fork with itself. This matters before you **read** code to answer
a question about how the app behaves now, not only before you edit it.

The canonical repository is named in `.claude/homeroom-canonical-repo`. Check against
it, not against `origin`:

```sh
git fetch "$(cat .claude/homeroom-canonical-repo)" main
git merge-base --is-ancestor FETCH_HEAD HEAD && echo current || echo behind
```

`behind` means this checkout does not contain the canonical `main`. To answer
a question, read the canonical code instead (`git show FETCH_HEAD:<path>`,
`git grep <pattern> FETCH_HEAD`). To change code, start from the exact base
commit your Homeroom work order gives, and never merge or rebase onto the
canonical `main` yourself: which commit a change is diffed against decides
what the group votes on. With the Homeroom connector, `get_checkout_status`
answers the same question.

A session-start hook (`.claude/hooks/homeroom-freshness.sh`, see `.claude/README.md`) runs
this check for you and tells you when you are behind. It is silent offline, so
its silence is not proof the checkout is current. Inside Homeroom's dev-chat
the platform fixes the base commit, and none of this applies.

## Starter template

The starter template's demo screen (the Press! button, the leaderboard and
the `presses` table) was replaced by the real club screen in the app's
first version, built from `design/sketch.html`. Nothing template-shaped is
left; the platform infrastructure (the bridge, theme and dev-console
scripts, the design kit) stays.

If a rule below this line conflicts with the hosted conventions, the
hosted conventions win. This file is **app-specific** — write down
things about *this* app that belong in the repo: product intent,
data-model quirks, style preferences, opt-in policies (e.g. which
tables you've marked private), etc.

---

## About Page Turners

A small book club app. Its one screen answers three questions: what is the
club reading this month, who is hosting the next meetup, and when is that
meetup. The club meets on the last Thursday of every month at 7 pm (UTC).
Anyone can suggest the next book; any signed-in member can set a
suggestion as this month's read. There is no voting in this version: the
suggestions list is the record, and picking is the decision.

## Design

This app's look, from the sketch the creator was shown (`design/sketch.html`,
with `design/sketch.json` describing its job, layout and words). Every
later change follows it, and updates it when a request changes the look on
purpose.

- **Sketch:** `design/sketch.html` is the sketch this app's creator was shown
  when they made it, and `design/sketch.json` says its job, layout and words.
  The first version keeps them; list any change under Assumptions.

- **Palette:** accent: amber, from the sketch; neutrals: the kit's warm greys
- **Signature element:** A countdown to the monthly meetup, phrased as the club would say it
- **Type scale:** `text-title`, `text-heading`, `text-body`, `text-small`
  _(change their sizes in `tailwind.config.js` if you must, not their number)_

Concretely:

- **Accent:** the sketch's amber. The kit's `--accent` token carries it:
  `149 96 7` in the light look (a deep amber, so white `on-accent` text
  stays at 4.5:1) and `251 191 36` in the dark (with dark `on-accent`
  text). Both are the sketch's amber, adjusted only for contrast.
- **Signature element:** the meetup countdown: a progress bar that fills
  across the month, with the days remaining under it ("16 days to go"; on
  the day itself, "We meet tonight").
- **Words:** "This month's read", "hosting", "Next meetup", "Suggestions",
  "Suggest a book" / "Suggest it" (the form's submit button). Keep these
  exact spellings.
- Both looks are kept and follow the viewer's Homeroom theme (the theme
  `<script>` after the bridge tag sets a `dark` class on `<html>`); there
  is no theme picker and no fixed look.

The kit is in `styles/tailwind-input.css`: colour tokens with a light and
a dark value (named in `tailwind.config.js`), and a few components
(`btn-primary`, `btn-secondary`, `field`, `list` and `list-row`,
`card`, `section-label`, `skeleton`, `state-empty`, `state-error`).
Re-theme by changing the token values there, keeping every text pair at
4.5:1 or more in both looks.

### Assumptions

- A **"Books read"** section (a new word not in the original sketch) was
  added below Suggestions after the original sketch: every book the club
  finishes moves there when a new pick is set, with each member's 1-5 star
  rating. Stars are small inline SVG icons in the accent/muted tokens.
  Recorded here as the sketch change that feature makes.

- Colour comes only from the tokens (`bg-ground`, `bg-surface`,
  `text-fg`, `text-muted`, `border-line`, `bg-accent` with
  `text-on-accent`, ...): never a raw hex value or a stock palette class.
- Tap targets are at least 44 px; the buttons and fields already are.
- Every screen that loads data has honest loading, empty and error states.
  Never show the empty state while loading or after a failure; an error says
  what failed, what still works, and offers Retry.
- Seed obviously fake staging demo data so the populated screen can be seen
  ("Staging mock data" in the platform conventions).
- No cards in cards, no uppercase eyebrows, no emoji as icons.

## App-specific conventions

- **All meetup maths is in UTC** (the server's own zone): the last
  Thursday of the month at 19:00 UTC. If the group is somewhere else,
  change `nextMeetup`/`lastThursdayAt19` in `server.js` and the date
  rendering in `public/index.html` together, and update this line.
- **Read "now" through the platform**: `req.now` on the server (set by the
  `requestNow` middleware) and `usernode.now()` in the page, never
  `new Date()` or SQL's `NOW()`, wherever the moment decides what shows,
  so a staging preview can be shown as of a chosen moment.
- **`suggestions` is append-only in v1**: no editing, deleting or voting.
  `POST /api/current-read` (setting the month's read) is the decision.
- **`read_books` and `ratings`**: when `POST /api/current-read` replaces the
  pick, the outgoing book is archived into `read_books` (title, author and
  suggester carried over from the suggestion, `finished_at` from `req.now`;
  `UNIQUE (suggestion_id)` + `ON CONFLICT DO NOTHING` make a re-pick
  idempotent so a book never appears twice). `ratings` holds one 1-5 star
  rating per signed-in member per read book (primary key on
  `read_book_id, user_id`); `POST /api/ratings` upserts it. Both tables are
  public (titles and usernames only).
- **Host rotation is a lazy read-time advance**: the single `club_state`
  row stores the host and the meetup they anchor; when `GET /api/club`
  finds that meetup in the past, it rotates the host one place per missed
  meetup through the platform's member list (creator first, wrapping) and
  stores the new host and meetup. With a roster but no stored host, the
  member after the creator hosts first (the creator's v1 choice was
  priya_t1006); with no roster at all, the stored host stands and a
  hostless meetup shows "to be decided".
- **Staging seed** (boot block, `IS_STAGING` only): suggestions 900001 to
  900003, titled "Staging demo: The Midnight Library", "Staging demo:
  Piranesi" and "Staging demo: Project Hail Mary", owned by the fake
  `staging-demo-reader`, with 900001 set as the current pick, and the
  stored host anchored to the meetup current at seed time (COALESCE, so
  nothing already stored is overwritten). Also two archived books in
  `read_books`, 900001 "Staging demo: The Left Hand of Darkness" (rated 5
  by `staging-demo-reader`, 4 by `staging-demo-rater`) and 900002 "Staging
  demo: Circe" (rated 3 by `staging-demo-reader`), `suggestion_id` NULL and
  `finished_at` staggered past dates. No unrated book is seeded, so the
  "No ratings yet" state stays reachable. The empty screen stays
  reachable: no logic reads the seed's presence.
