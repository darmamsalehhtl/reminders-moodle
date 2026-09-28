# Implementation Plan — Phase 2: Task Aggregator (Teams)

> Planning doc for the implementer (Sonnet). Read this **and** `IMPLEMENTATION_PLAN.md`
> (phase 1) fully before writing code. Source brief: `task-aggregator-teams-phase2.md`.
>
> Phase 1 is live and working: Moodle web services -> normalized `Task[]` ->
> terminal view -> macOS Reminders sync, on a daily launchd schedule.
> **Phase 2 must not regress that.** The riskiest part of this phase is not
> the Graph API, it is the deduplication (section 5) and the reminder-identity
> migration (section 6).

---

## 0. Findings that change the brief (verified 2026-09-28)

| Assumption in brief | Reality | Consequence |
|---|---|---|
| Teams school tasks live at `/me/todo/lists/{id}/tasks` | That endpoint is **Microsoft To Do** (personal task lists), not Teams class assignments. Teacher-assigned Teams work lives at `/education/me/assignments`. Different API, different permission, different consent story. | Both must be supported as separate providers; see section 1. Which one *you* actually need is the one open question (section 13). |
| `TEAMS_CLIENT_SECRET` + client-credentials flow | Microsoft's own docs for `GET /education/me/assignments` state: *"Calling the `/me` endpoint requires a signed-in user and therefore delegated permissions. Application permissions aren't supported when using the `/me` endpoint."* A client secret / app-only token **cannot** read "my" tasks at all. | Drop the secret entirely. Use the **device code flow** (public client, no secret). See section 2. |
| "User muss einmalig App registrieren, Permissions `Tasks.Read` setzen" — presented as a formality | Depends on the permission: `Tasks.Read` (delegated) **does not require admin consent**. `EduAssignments.ReadBasic` (delegated) **does require admin consent**. | To Do/Planner: you can self-consent. Teams class assignments: needs a request to HTL's M365 admin. This is a hard gate, not a formality. |
| — | HTL Leonding's M365 tenant exists and is resolvable: **`91fc072c-edef-4f97-bdc5-cfb67718ae3a`** (for both `htl-leonding.ac.at` and `students.htl-leonding.ac.at`; `edu.htl-leonding.ac.at` is not a tenant domain). Its `/oauth2/v2.0/devicecode` endpoint responds and only demands `client_id`, so the device code flow is reachable. | Ship the tenant id as the `.env.example` default; no guessing needed. |
| — | Both Graph endpoints exist and answer `401 InvalidAuthenticationToken` (not 404) when called unauthenticated. | Error-shape for the client's error mapping is known. |
| Dedupe rule: "Levenshtein distance < 3 AND due date ±1 day" | **This silently loses homework.** `"Mathe Hausaufgabe 5"` vs `"Mathe Hausaufgabe 6"` is distance **1**, `"Übung 1"` vs `"Übung 11"` is distance **1**. Both would merge into one reminder and one real assignment would disappear. | Replaced with a conservative rule that hard-gates on the numbers in the title. See section 5. |
| Tech stack: `@azure/identity` + `@microsoft/microsoft-graph-client` + `axios` + `rss-parser` | Phase 1 deliberately has none of those (global `fetch`, no RSS at all — RSS doesn't exist in Moodle, see phase 1 plan §0). The two Azure SDKs pull ~40 transitive deps to wrap what is one token POST and one GET. | Zero new runtime dependencies; mirror the existing `MoodleClient` as `GraphClient`. See section 3. |

### Non-negotiable: no borrowed client IDs

There are widely-circulated "tricks" that reuse Microsoft's own first-party
client IDs (Graph Explorer, Azure CLI, Teams desktop) to skip app
registration and consent. **Do not implement that.** It is impersonating
another publisher's app, it violates the API terms, and it would make the
portfolio repo unshippable. If consent is unavailable, the honest answer is
"this provider is unavailable" — the CLI says so and keeps working with the
providers that are available.

---

## 1. Providers

Phase 2 turns the single Moodle fetch into a provider registry. Every
provider returns the **same normalized `Task[]`** already defined in phase 1.

| Provider | Graph endpoint | Delegated scope | Admin consent? | What it covers |
|---|---|---|---|---|
| `moodle` | (phase 1: web services / iCal) | — | — | Moodle assignments. Already done. |
| `todo` | `GET /me/todo/lists`, then `GET /me/todo/lists/{id}/tasks` | `Tasks.Read` | **No** | Microsoft To Do lists, incl. "Flagged email" and anything you or Teams put there. |
| `planner` | `GET /me/planner/tasks` | `Tasks.Read` | **No** | Planner tasks assigned to you (the Teams "Tasks by Planner" tab). |
| `edu` | `GET /education/me/assignments?$expand=submissions` | `EduAssignments.ReadBasic` | **Yes** | Real Teams class assignments from teachers. |

`Tasks.Read` covers **both** To Do and Planner (per the permission docs), so
`todo` + `planner` cost exactly one consent prompt that you can grant
yourself.

### Provider interface (`src/providers/index.js`)

```js
/** @typedef {{ name: string, label: string,
 *   isConfigured(cfg): boolean,
 *   fetch(cfg, { from, to, log }): Promise<Task[]> }} Provider */
```

Registry order is fixed and meaningful (it feeds the dedupe precedence in
section 6): `moodle`, `edu`, `planner`, `todo`.

### `edu` response shape — two traps

1. `classId` is a bare GUID. The course name needs a second call to
   `GET /education/classes/{classId}` (`displayName`). Cache it per run;
   these change ~never, so also persist the map in the state file.
2. The docs' own note says `instructions`, `assignedDateTime`, `assignTo`,
   `resourcesFolderUrl` and `webUrl` "will always display null" on this
   endpoint — yet several of Microsoft's own example responses on that same
   page show a populated `webUrl`. Treat it as **possibly null**: use
   `webUrl` when present, otherwise fall back to
   `GET /education/classes/{classId}/assignments/{id}` for the detail, and if
   that is also empty, leave `url: null` rather than fabricating a link.

Use `$expand=submissions` and treat a submission `status` of `submitted` or
`returned` as done -> filter the task out. `$filter=dueDateTime ge ...` and
`$orderby=dueDateTime` are supported, so filter server-side. Follow
`@odata.nextLink` until exhausted.

### `todo`/`planner` filtering

- To Do: skip `status === 'completed'`; due date is `dueDateTime.dateTime` +
  `.timeZone` (a **local** wall-clock time + named zone, *not* UTC — parsing
  it as UTC is a silent off-by-hours bug). Lists must be paged too.
- Planner: `percentComplete === 100` means done; due is `dueDateTime` (ISO,
  real UTC). Planner tasks frequently have **no** due date — those go into
  phase 1's existing `undated` bucket and are **never** dedupe candidates.

---

## 2. Authentication (`src/graph/auth.js`)

Device code flow, public client, no secret:

1. `POST https://login.microsoftonline.com/{tenant}/oauth2/v2.0/devicecode`
   with `client_id` + `scope`.
   Scope string: `offline_access Tasks.Read` (plus ` EduAssignments.ReadBasic`
   only when the `edu` provider is enabled — never request a scope you don't
   need, it turns a self-consentable app into an admin-gated one).
2. Print `user_code` + `verification_uri` and tell the user to open it.
3. Poll `POST .../oauth2/v2.0/token` with
   `grant_type=urn:ietf:params:oauth:grant-type:device_code`, honouring the
   returned `interval`; `authorization_pending` means keep polling,
   `slow_down` means increase the interval, `expired_token`/`authorization_declined`
   are terminal.
4. Persist the **refresh token**, refresh with `grant_type=refresh_token`.
   Access tokens last ~1h; never store them on disk beyond the run.

**The app registration must have "Allow public client flows" = Yes**, or step 3
fails with `AADSTS7000218`. Put that in the README setup steps verbatim — it is
the single most common setup failure for this flow.

### Where the refresh token lives

Not `.env`. A refresh token is a long-lived credential for the user's whole
school account, which is a different risk class from the Moodle token.
Primary: **macOS Keychain** via `security add-generic-password` /
`find-generic-password` (service `moodle-task-fetcher`, account `ms-refresh-token`).
Fallback when Keychain is unavailable (non-macOS, locked keychain):
`~/.moodle-task-fetcher/ms-token.json`, mode `0600`, with a printed warning
that it is plaintext. Both paths go through one `TokenStore` so the rest of
the code doesn't care which is in use.

New CLI command: `--login-ms` (phase 1's `--login` stays Moodle-only), plus
`--logout-ms` to delete the stored token.

---

## 3. Tech stack decision

**Zero new runtime dependencies.** Concretely:

- No `@azure/identity` / `@azure/msal-node`: our need is one flow, one scope,
  one refresh call — ~120 lines against `fetch`, fully unit-testable with an
  injected `fetchImpl` exactly like phase 1's client tests. MSAL's value is
  broker/cache/multi-account handling we don't use.
- No `@microsoft/microsoft-graph-client`: `GraphClient` mirrors
  `MoodleClient` (timeout, retry, typed errors), so both backends behave and
  fail the same way and share the same test patterns.
- No `axios`/`rss-parser`: not in phase 1, not needed now.
- Levenshtein/Dice: ~25 lines, no `fast-levenshtein`.

Trade-off, stated honestly: we own the refresh-token edge cases MSAL would
handle for us. Accepted because the surface is small and the alternative
drags ~40 transitive packages into a repo whose selling point is that it has
four.

`GraphClient` must additionally respect **`Retry-After`** on `429`/`503`
(Graph throttles and tells you how long to wait). Phase 1's `MoodleClient`
currently retries 429 on a fixed backoff and ignores the header — port the
`Retry-After` handling into the shared retry helper and let both use it.

---

## 4. Module layout (additions)

```
src/graph/auth.js          device code flow, refresh, TokenStore wiring
src/graph/client.js        GraphClient: fetch + retry + Retry-After + errors
src/graph/tokenstore.js    Keychain primary, 0600 file fallback
src/providers/index.js     registry, selection, parallel fetch, per-provider isolation
src/providers/moodle.js    wraps the existing phase 1 fetch (ws|ical)
src/providers/todo.js      /me/todo/*
src/providers/planner.js   /me/planner/tasks
src/providers/edu.js       /education/me/assignments + class-name resolution
src/aggregate/normalize.js title normalization (umlauts, punctuation, numbers)
src/aggregate/similarity.js trigram Dice coefficient
src/aggregate/dedupe.js    pairing -> clusters (the critical logic)
src/render/terminal.js     (extend) source badges + statistics block
src/state/store.js         (extend) v1 -> v2 migration, class-name cache
src/reminders/sync.js      (extend) cluster-aware planning
test/...                   dedupe, normalize, providers, auth, graph client
```

One provider failing (expired consent, Graph outage) must **not** fail the
run: `providers/index.js` fetches each in parallel, collects errors, and
returns `{ tasks, errors }`. A Moodle-only result is still a useful result —
that is exactly how phase 1 behaves today and it must stay true.

---

## 5. Deduplication — the part that can lose homework

A false merge means an assignment silently never reaches Reminders. A false
non-merge means one duplicate line in a list. **These costs are wildly
asymmetric, so the rule is deliberately conservative: when in doubt, don't
merge.**

Two tasks are duplicates only if **all** of these hold:

1. **Different sources.** Two tasks from the same provider are never merged —
   the provider's own ids are authoritative, and "Übung 1"/"Übung 2" from one
   Moodle course are genuinely two tasks.
2. **Both have a due date, and it's the same calendar day** in the local
   timezone. Undated tasks are never merge candidates. (`DEDUPE_DAY_TOLERANCE=1`
   may widen this to ±1 day as the brief wanted, but the default is 0 —
   ±1 day would merge "Essay Teil 1" due Monday with "Essay Teil 2" due Tuesday.)
3. **Identical number multiset** in the title. `numbersOf("Mathe HÜ 5") = [5]`,
   `numbersOf("Mathe HÜ 6") = [6]` -> different -> not duplicates, regardless of
   string similarity. This single gate is what fixes the brief's algorithm.
4. **Normalized title similarity >= 0.90** (trigram Dice coefficient).
   Normalization: NFKD, lowercase, `ä/ö/ü/ß -> ae/oe/ue/ss`, punctuation to
   spaces, collapse whitespace. Dice on character trigrams beats raw
   Levenshtein here because it is length-normalized (`"Essay"` vs
   `"Englisch Essay Abgabe"` should not merge, and Levenshtein-with-a-fixed-
   threshold gets that wrong in both directions depending on length).

### Clustering

Pairwise matches are grouped into clusters with one extra invariant: **a
cluster holds at most one task per source.** That caps transitive
over-merging (a -> b -> c chaining three different assignments into one) at
the only shape that makes sense: "the same assignment, seen once per system".

Each cluster gets a **primary member** by fixed source precedence
`moodle > edu > planner > todo` (Moodle and Edu carry real teacher-set
deadlines; To Do entries are often self-created copies). The primary supplies
title, course and due date; other members contribute their source label and
their URL as extra lines in the reminder body.

---

## 6. Reminder identity & state migration (do not get this wrong)

Phase 1 keys `state.tasks` by `stableId` (`"ws:12345"`). Phase 2 introduces
clusters, whose membership can change between runs — and if the reminder key
changes, **the daily job creates a second reminder for an assignment that is
already there.**

Two rules prevent that:

1. **Do not change existing id prefixes.** Moodle tasks keep `ws:`/`ical:`
   ids. The new display field is `task.sourceName` (`'moodle'`); the
   transport stays in `task.transport`. Renaming ids to `moodle:` would
   orphan every reminder currently in the user's Reminders app.
2. **Match clusters to reminders by *any* known member id**, not by the
   cluster's current primary. State v2:

```json
{ "version": 2,
  "entries": {
    "<entryKey>": { "reminderId": "x-apple-reminder://...",
                    "memberIds": ["ws:12345", "todo:AAMk..."],
                    "hash": "...", "syncedAt": "...", "deletedByUser": false } },
  "classNames": { "<classId>": "4AHIF Mathematik" } }
```

Lookup: for a cluster, find the entry sharing at least one `memberIds`
element; that's the reminder to update. Then union the ids back into
`memberIds`. So when a Teams copy of a Moodle task appears on day 3, day 3
*updates* the existing reminder instead of adding a second one — and when the
Moodle side later disappears, the entry is still found via the To Do id.

**Migration v1 -> v2** runs once, in `loadState`: every v1
`tasks[id] = {reminderId, hash}` becomes
`entries[id] = {reminderId, memberIds: [id], hash}`. Phase 1's
"user deleted it on purpose -> never recreate" behaviour must survive the
migration; there is already a test for it, extend rather than replace it.

Reminder title keeps the brief's source tag (`[Moodle] …`,
`[Moodle + Teams] …`), with `--no-source-prefix` to turn it off. Note the
cost so it's a conscious choice: when a second source joins a cluster the
title changes, so the change-hash changes and the reminder gets updated —
that's correct behaviour, just expect update traffic on those days.

---

## 7. CLI & renderer changes

New/changed flags:

- `--providers <list>` — e.g. `moodle,todo`. Default: every configured provider.
- `--moodle-only`, `--teams-only` — brief-compatible shorthands.
- `--moodle-source <ws|ical>` — **renames phase 1's `--source`**, which is now
  ambiguous. Keep `--source` working as a deprecated alias that prints a
  one-line notice; the installed launchd job passes no flags, so nothing breaks.
- `--verbose` — per-task provenance: what each provider returned, every
  dedupe decision (matched / rejected and which gate rejected it), what was
  created/updated/skipped. This is the debugging surface the brief asks for
  and the thing that makes dedupe problems diagnosable.
- `--login-ms`, `--logout-ms`.
- `--doctor` (extend) — per provider: configured? token valid? scope granted?
  and **how many items it returned**. This is what empirically answers
  section 13 without guessing.

Terminal view keeps phase 1's box and buckets, adds the `[Source]` badge per
line and the statistics block from the brief:

```
📊 STATISTIK:
  Moodle Tasks: 5
  Teams Tasks:  3   (To Do 2, Klassenaufgaben 1)
  Duplikate erkannt: 1
  → Total in Reminders: 7
```

`--json` gains `sources: []`, `duplicateOf`, and a `stats` object. Existing
JSON fields must not change shape — phase 1's `--json` contract stays.

---

## 8. Security

- No client secret anywhere (public client). If a `TEAMS_CLIENT_SECRET` is
  found in `.env`, print a warning that it is unnecessary and ignored.
- Refresh token in Keychain by default (section 2); never logged.
- Extend phase 1's `scrub()` secret list with the MS access + refresh tokens
  so no Graph error can print one.
- `.env.example` gains `MS_CLIENT_ID`, `MS_TENANT_ID` (default
  `91fc072c-edef-4f97-bdc5-cfb67718ae3a`), `MS_PROVIDERS`. Accept the brief's
  `TEAMS_CLIENT_ID`/`TEAMS_TENANT_ID` as aliases.
- **The phase 2 brief contains the old leaked Moodle token.** It has to be
  scrubbed *before* the brief is committed, otherwise it re-enters git
  history that was just rewritten to remove it.

---

## 9. Error handling

- `invalid_grant` on refresh -> token revoked/expired -> clear stored token,
  tell the user to run `--login-ms`, exit code 2 (config), not 1.
- `403` + `Authorization_RequestDenied` on `/education/*` -> consent for
  `EduAssignments.ReadBasic` was never granted -> name the permission and say
  it needs an M365 admin; disable that provider for the run instead of failing.
- `429`/`503` -> respect `Retry-After` (section 3).
- Graph `@odata.nextLink` loops: hard page cap like phase 1's 20-page guard.
- One provider's failure is reported and survived, never fatal (section 4).

---

## 10. Testing (`node:test`, no framework)

- `test/normalize.test.js` — umlauts, punctuation, casing, number extraction.
- `test/dedupe.test.js` — **the important one.** Must include, as explicit
  regression tests: `"Mathe Hausaufgabe 5"` vs `"…6"` do **not** merge;
  `"Übung 1"` vs `"Übung 11"` do **not** merge; same title+same day across
  two sources **do** merge; same title different day do not; undated never
  merges; two same-source tasks never merge; a cluster never takes two tasks
  from one source; plus the brief's own two test cases.
- `test/cluster-identity.test.js` — a cluster gaining a member updates the
  existing reminder; losing its primary still resolves to the same reminder;
  v1 -> v2 migration preserves `reminderId` and `deletedByUser`.
- `test/graph-client.test.js` — injected `fetchImpl`: 401/403/429-with-
  `Retry-After`, nextLink paging, HTML-instead-of-JSON.
- `test/auth.test.js` — device code polling (`authorization_pending` ->
  success), `slow_down`, `expired_token`, refresh + `invalid_grant`.
- `test/providers/*.test.js` — fixtures captured from the real response shapes
  (To Do's `dueDateTime.dateTime` + `timeZone` must have a test proving it is
  not parsed as UTC).
- Keychain and Reminders bridges stay manual (`--dry-run`), as in phase 1.

---

## 11. Build order & commit plan

1. `refactor(model): add sourceName/transport without changing task ids`
2. `refactor(http): shared retry helper honouring Retry-After`
3. `feat(providers): provider registry with per-provider error isolation`
4. `refactor(providers): move the phase 1 Moodle fetch behind the registry`
5. `feat(graph): Graph REST client with typed errors and nextLink paging`
6. `feat(graph): token store backed by macOS Keychain with file fallback`
7. `feat(graph): device code login + refresh (--login-ms/--logout-ms)`
8. `feat(providers): Microsoft To Do provider`
9. `feat(providers): Planner provider`
10. `feat(providers): education assignments provider + class-name cache`
11. `feat(aggregate): title normalization and trigram similarity`
12. `feat(aggregate): conservative cross-source dedupe with clustering`
13. `feat(state): v2 entries with memberIds + v1 migration`
14. `feat(reminders): cluster-aware sync planning`
15. `feat(render): source badges and statistics block`
16. `feat(cli): --providers/--verbose/--moodle-source, extended --doctor`
17. `test: dedupe and cluster-identity regression suites`
18. `docs: README for Azure app registration, consent, troubleshooting`

Steps 1–4 are a pure refactor: phase 1's 39 tests must still pass, and
`node bin/moodle-tasks.js` must behave identically, before any Graph code
lands.

---

## 12. Definition of done

- Phase 1's 39 tests still green; Moodle-only runs byte-identical to before.
- `--doctor` reports each provider's status and item count against the real
  tenant.
- A Moodle task and a To Do copy of it produce **one** reminder; running
  twice more changes nothing.
- `"… Hausaufgabe 5"` and `"… Hausaufgabe 6"` produce **two** reminders.
- Consent missing for `edu` -> that provider reports and is skipped, the run
  still exits 0 with the other providers' tasks.
- No token (Moodle or MS) anywhere in `git log -p`.

---

## 13. Open question (does not block the build)

**Which "Teams tasks" do you actually have?** The two candidates need
different permissions and only one of them needs your school's admin:

- Teachers post work under a Teams **class** -> "Aufgaben"/Assignments tab ->
  that's the `edu` provider -> `EduAssignments.ReadBasic` -> **admin consent
  required**.
- You keep work in **To Do** or a Teams **"Tasks by Planner"** tab ->
  `todo`/`planner` -> `Tasks.Read` -> **you can consent yourself**.

Build order handles this without an answer: providers land in the order
`todo` (self-consentable, so it can be tested immediately), then `planner`,
then `edu`. `--doctor`'s per-provider item count then answers the question
empirically on the first real run. If `edu` turns out to be the one that
matters and consent is refused, nothing else in the phase is wasted — the
aggregation, clustering, state migration and renderer all work the same for
two providers as for four.
