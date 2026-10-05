# Page Turners

Our little book club, running on Homeroom. The screen shows what the club
is reading this month, who is hosting the next meetup, and a countdown to
it: the club meets on the **last Thursday of every month at 7 pm** (UTC).
Everyone can suggest the next book, and any signed-in member can set one
of the suggestions as this month's read.

## How it works

- **This month's read** — the book a member picked, with its author and
  the meetup date as the due date. Until someone picks, the card points at
  the suggestions list.
- **Next meetup** — always the next upcoming last-Thursday-of-the-month at
  7 pm, with the host and a progress bar that fills across the month
  ("16 days to go"; on the day itself, "We meet tonight"). Hosting rotates
  through the platform's member list (creator first) and advances by
  itself when a meetup passes; the first host was the creator's choice.
- **Suggestions** — every proposed book, newest first, with who suggested
  it. There is no voting in this version: the list is the record, and
  picking is the decision.

## Under the hood

- **Sign-in** — the server verifies the platform-issued user token (an
  RS256 JWT) on every request, so the app already knows who is using it.
  Guests can look around; every write needs an account (the platform asks
  them to make one).
- **Data** — a `suggestions` table plus a one-row `club_state` table
  (current pick, host, and the meetup that host anchors). Both are public
  tables: they carry only book titles and usernames.
- **API** — `GET /api/club` (one read drives the whole screen),
  `POST /api/suggestions`, `POST /api/current-read`, and `GET /health`.
- **Meetup maths** — all in UTC, computed from `req.now` /
  `usernode.now()`, never `new Date()` or `NOW()`, so a staging preview
  can be shown as of a chosen moment. If the group ever meets in another
  zone, see CLAUDE.md's "App-specific conventions".
- **Styling** — the design kit in `styles/tailwind-input.css`: the
  sketch's amber accent on the kit's warm greys, in a light and a dark
  look that follow the viewer's Homeroom theme. `npm run build` compiles
  the stylesheet during image creation (Kubernetes/Paketo or standalone
  Docker).
- **Staging** — seeded on boot with obviously fake demo suggestions
  ("Staging demo: …") owned by a fake identity, so previews and checks see
  the populated screen.

## Changing this app

To change this app, ask Homeroom bot: open the app on Homeroom, tap the
Homeroom icon in the header, then **Ask for a change**, and describe the
change in plain English. You can also run Claude Code against this repo
directly; start with `CLAUDE.md`, which carries the app-specific notes and
points at the platform rules.
