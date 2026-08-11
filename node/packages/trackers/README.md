# Tracker adapter profiles

This is the compact adapter profile for the Node implementation. It documents current public
behavior, including known conformance boundaries; operational workflow examples remain in the
[CLI guide](../cli/README.md).

## Shared contract

Adapters expose `fetchIssuesByStates(states)` and `fetchIssuesByIds(ids)`. Both return complete
`Issue` snapshots. Node uses camelCase (`nativeRef`, `branchName`, `assigneeId`, `blockedBy`,
`createdAt`, and `updatedAt`) for the fields named with snake_case in the Symphony specification.
Every returned `Issue` contains every normalized field. Each profile below states whether an absent
or unusable provider value becomes a fallback, is omitted as a row, or fails the operation. Empty
state or ID inputs make no provider request.

Registry/provider validation and classified GitHub/Linear scheduler-read failures expose
`TrackerError`, exported from `@ai-symphony/trackers/error.js` and re-exported by the CLI embedding
API, with a stable `category` and a redacted `message`. Memory construction uses the same form;
valid documented Memory fixtures have no read failure:

| Category | Meaning |
| --- | --- |
| `unsupported_tracker_kind` | Registry lookup for an unknown kind. |
| `invalid_tracker_config` | Invalid provider settings or read input. |
| `missing_tracker_secret` | A required local credential or configured environment variable is unavailable. |
| `tracker_request` | Transport, caller-abort, or timeout failure. |
| `tracker_status` | A non-success provider status that is not a recognized rate limit. |
| `tracker_response` | Invalid JSON, GraphQL, payload, or refreshed identity. |
| `tracker_pagination` | An unsafe, malformed, looping, or excessive page sequence. |
| `tracker_rate_limited` | A provider response recognized as rate limiting. |

Unknown kinds use `Unsupported tracker kind: <kind>`. GitHub and Linear request wrappers never
attach the raw provider error as `cause` or include a response body. They add no structured
`status`, `retryable`, or `retry_after_ms` field; an HTTP status may still appear in the redacted
message. The orchestrator treats all categories as operation failures; the category is for portable
logs and embedding integrations.

### Provider-native Claude tools

Memory exposes no provider-native agent tool. GitHub and Linear can expose these issue-bound tools
to Claude:

| Tool | Provider | Input |
| --- | --- | --- |
| `mcp__symphony__comment_current_issue` | GitHub, Linear | `{ body: string }`, trimmed length 1..65,536 |
| `mcp__symphony__add_current_issue_label` | GitHub, Linear | `{ label: string }`, trimmed length 1..50 |
| `mcp__symphony__remove_current_issue_label` | GitHub, Linear | `{ label: string }`, trimmed length 1..50 |
| `mcp__symphony__set_current_issue_state` | GitHub | `{ state: "open" | "closed" }` |
| `mcp__symphony__set_current_issue_state` | Linear | `{ state: string }`, trimmed length 1..100 |
| `mcp__symphony__publish_current_change` | GitHub | `{ commit_message, pull_request_title, pull_request_body }`; trimmed message length 1..200, trimmed title length 1..256, body length 0..65,536 |

Tools are available only in a non-`plan` Claude run when the exact name is allowed, not disallowed,
and the corresponding issue-mutation or publishing callback is present. Host delivery removes
issue tools from the model; Codex exposes none. Every mutation is bound to the current issue, and
the configured retry label cannot be added or removed by the model. Tracker credentials remain in
the host; configured and default credential variables are removed from the coding-agent child.

Issue updates return text `Updated <identifier>` and structured
`{ identifier, action }`, where `action` is `comment`, `add_label`, `remove_label`, or `set_state`.
Publishing returns `Published <identifier>: <url>` and
`{ identifier, url, number, branch }`. The MCP SDK reports input-schema rejection as its own input
validation error. Once input is valid, callback/provider failures return `isError: true` with only
`The current issue could not be updated` or `The current change could not be published`; provider
details never reach the model. Direct mutation and publishing APIs retain their operation-specific
plain `Error` validation outside the portable construction/read error contract.

## Memory tracker profile

### Configuration

- Exact kind: `memory`.
- `provider.issues` is an optional fixture array and defaults to `[]`. Other provider keys are
  currently ignored.
- Each issue requires string `id`, `identifier`, and `title` with length at least one. `state` must
  contain a non-whitespace character. These values are copied verbatim rather than trimmed.
  Optional fixture defaults are `native_ref: null`, `description: null`, `priority: null`,
  `branch_name: null`, `url: null`, `assignee_id: null`, `labels: []`, `blocked_by: []`,
  `dispatchable: true`, `created_at: null`, and `updated_at: null`.
- `native_ref` is always `null`; non-null input is rejected because Memory retains no additional
  provider identity. `priority` is an integer or `null`; `url` is a Zod-valid URL string or `null`;
  blocker `id`, `identifier`, and state values are strings or `null`; timestamps are RFC 3339
  strings with `Z` or a numeric offset, or `null`. Unknown issue and blocker keys are stripped.
- Invalid fixture schemas produce `invalid_tracker_config` with the Zod validation message.
  Duplicate values produce `Duplicate memory issue id: <id>` or
  `Duplicate memory issue identifier: <identifier>` in the same category. The adapter has no
  credential setting.

### Scope, identity, and normalization

The fixture set is the entire scope. There is no network, authentication, pagination, provider
request limit, retry, or persistence. State inputs are trimmed and compared case-insensitively;
the original fixture state is preserved. ID inputs are deduplicated in first-seen order and unknown
IDs are omitted. Reads return independent structured clones.

`id` and `identifier` are copied from the fixture; `nativeRef` is always `null`. Labels are trimmed,
lowercased, deduplicated, and blank values are dropped. Other optional values use the validated
fixture value or the default above. Valid reads have no request, status, response, pagination, or
rate-limit error form. `setIssueState(id, state)` is an embedding/test helper, not an agent tool: a
blank state throws `Memory issue state must be a non-empty string`; success returns `void`, preserves
the supplied state spelling, and sets `updatedAt` to the current ISO timestamp. An unknown ID throws
`Unknown memory issue <id>` as a plain `Error`.

## Linear tracker profile

### Configuration

- Exact kind: `linear`.
- The only provider keys are `project_slug`, `api_key`, `assignee`, and `endpoint`; unknown keys are
  rejected in sorted order.
- `project_slug` is required and trimmed. `api_key` defaults to `$LINEAR_API_KEY` and must be an
  exact `$ENV_NAME` reference. `assignee` defaults to `null`; a case-insensitive `me` becomes `me`,
  otherwise it is a trimmed Linear user ID.
- `endpoint` defaults to `https://api.linear.app/graphql`, must be HTTPS without credentials, query,
  or fragment, and has trailing slashes removed. Offline validation does not resolve the API-key
  environment variable.
- Workflow defaults are active states `Todo` and `In Progress`, terminal states `Done`, `Closed`,
  `Cancelled`, `Canceled`, and `Duplicate`, and no required labels.

Configuration failures use `invalid_tracker_config` with these exact message forms:

- `Unsupported Linear tracker provider option(s): <sorted keys>`
- `Linear tracker provider.project_slug must be a non-empty string`
- `Linear tracker provider.api_key must be an environment reference such as $LINEAR_API_KEY`
- `Linear tracker provider.assignee must be a non-empty Linear user ID or 'me'`
- `Linear tracker provider.endpoint must be an HTTPS URL`, optionally followed by
  ` without credentials, query, or fragment`
- `Linear tracker state at index <N> must be a non-empty string`
- `Linear tracker issue id at index <N> must be a non-empty string`

An unset or blank referenced secret uses `missing_tracker_secret` and
`Linear API key environment variable <NAME> is not set`. Retry control uses
`Linear retry control requires an explicit tracker API key environment reference`; host handoff
uses the analogous `Linear host handoff ...` message. Both require explicit
`provider.api_key: $ENV_NAME`, and neither that variable nor `LINEAR_API_KEY` may appear in the
coding-agent environment allowlist.

### Scope, paging, and request limits

State reads are scoped by project slug, requested provider-native state names, and the optional
assignee/`me` filter. Returned state names are trimmed but preserve provider spelling and are
post-filtered case-insensitively. State inputs are trimmed and deduplicated case-insensitively while
retaining the first spelling. Results preserve provider page and row order.

Issue pages are requested sequentially, 50 at a time, for at most 1,000 pages. `hasNextPage` must be
boolean; a next page requires a nonblank, nonrepeating `endCursor`. Each GraphQL request has a fresh
30-second timeout and the adapter performs no retry. Only the first 50 inverse relations are read;
they are not separately paginated, so incomplete or truncated blocker data fails closed for Todo
dispatch.

ID inputs are trimmed and deduplicated case-sensitively, then refreshed in batches of 50. The query
keeps project scope but intentionally omits the candidate assignee filter. Results return in the
first-requested order; missing IDs are omitted, while malformed, duplicate, or unexpected returned
IDs fail the complete read.

### Identity and normalization

- `id` is the opaque Linear GraphQL issue ID; `identifier` is the human-readable issue key;
  `nativeRef` is `null`.
- Required `id`, `identifier`, `title`, and state values are trimmed, nonblank strings. A malformed
  candidate is omitted; a malformed requested ID record fails the ID read.
- `description` is a string or `null`; `priority` is a safe integer or `null`; `branchName` and
  `assigneeId` are trimmed nonblank strings or `null`; `url` is HTTP(S) or `null`; timestamps are
  RFC 3339 values with an offset or `null`.
- Labels are trimmed, lowercased, deduplicated, and malformed or blank entries are dropped.
  `blockedBy` contains only inverse `blocks` relations, with nullable trimmed `id`, `identifier`,
  and state fields.
- `dispatchable` passes assignee routing automatically when none is configured, compares a
  configured user ID exactly with `assignee.id`, and requires `assignee.isMe === true` for `me`.
  In Todo only, blocker metadata must also be complete and every blocker state terminal, compared
  case-insensitively; other states ignore blockers for this flag. Active states and required labels
  remain scheduler checks.

Malformed state-list candidates are omitted. When a logger is supplied—as all built-in CLI and
orchestrator paths do—each affected provider page emits one warning, `Dropping malformed Linear
issue records`, with only the aggregate `malformed_count`; raw records are never logged. A malformed
requested ID record fails the complete ID read.

### Mutation and error mapping

The shared comment, label, and state tools above revalidate the bound live issue, project, team, and
configured assignee. State and label lookups request at most two results, require a complete
nonpaginated response and one unique, case-insensitive, unarchived match; label matches may be team-
or workspace-scoped but not groups. Existing state/label membership is a no-op. The manual Claude
comment tool exposes no idempotency key; host delivery supplies a UUIDv4 key, and the direct
embedding mutation API may also supply one. An idempotent comment lookup likewise requests two
results, requires `hasNextPage: false`, and rejects an ambiguous or reused key. Mutations honor
caller abort and the 30-second timeout.

Linear read errors map as follows:

- A plain transport/abort/timeout error becomes `tracker_request`.
- A native `SyntaxError` becomes `tracker_response`.
- An SDK `LinearError` with `Ratelimited` type or status 429 becomes `tracker_rate_limited`.
- An SDK `LinearError` with another numeric non-2xx status becomes `tracker_status`.
- Every other SDK `LinearError`, including GraphQL auth/application errors on HTTP 200, becomes
  `tracker_response`.
- An incoming `TrackerError` keeps its category but is rewrapped.

All of these request-boundary forms use the redacted message `Linear GraphQL request failed`.
Adapter-produced `tracker_response` messages are exactly
`Linear GraphQL returned an invalid response`, `Linear GraphQL response is missing data`,
`Linear GraphQL returned an invalid issue page`, `Linear GraphQL returned an invalid issue list`,
`Linear returned a malformed issue during ID refresh`, or
`Linear returned an unexpected issue during ID refresh`. `tracker_pagination` messages are exactly
`Linear issue pagination is missing hasNextPage`, `Linear issue pagination is missing endCursor`,
`Linear issue pagination cursor loop detected`, or
`Linear issue pagination exceeded 1000 pages`. The SDK can surface invalid JSON as `SyntaxError`
before preserving an HTTP status; that form is therefore classified as `tracker_response`.

## GitHub Issues tracker profile

### Configuration

- Exact kind: `github`.
- The only provider keys are `owner`, `repo`, `endpoint`, `token`, `base_branch`, and `git_url`;
  unknown keys are rejected in sorted order.
- `owner` and `repo` are required, trimmed, nonblank, and limited to letters, digits, `_`, `.`, and
  `-`.
- `endpoint` defaults to `https://api.github.com`, accepts HTTP(S) without credentials, query, or
  fragment, and has trailing slashes removed. Any effective token requires HTTPS.
- `token` is optional but, when present, must be an exact `$ENV_NAME` reference. At the default
  endpoint only, an omitted token can use a nonblank `GITHUB_TOKEN`; a custom endpoint remains
  anonymous unless an explicit reference is configured. Workflow delivery or control requires an
  explicit token reference.
- `base_branch` is optional, trimmed, at most 255 characters, and rejects whitespace or control
  characters. `git_url` is optional safe HTTPS without credentials, query, or fragment, and its
  decoded path must be exactly `/<owner>/<repo>` with optional `.git`. Default-endpoint publishing
  derives the github.com URL; a custom API endpoint requires explicit `git_url` for publishing.
- When `base_branch` is omitted, Git publishing discovers it from `refs/remotes/origin/HEAD` and
  fails closed if no safe branch can be resolved.
- Workflow defaults are active state `open`, terminal state `closed`, and no required labels.

Offline provider validation checks the token-reference form and transport policy without reading
the environment. Constructing the live adapter resolves the reference and may emit
`missing_tracker_secret`. Reads may be anonymous, but direct mutation and publishing require an
effective token.

Invalid values use `invalid_tracker_config` with these exact message forms:

- `Unsupported GitHub tracker provider option(s): <sorted keys>`
- `GitHub tracker provider.<owner|repo> must be a non-empty string` or
  `... must contain only letters, numbers, '.', '_', or '-'`
- `GitHub tracker provider.endpoint must be an HTTP(S) URL`, optionally followed by
  ` without credentials, query, or fragment`
- `GitHub tracker provider.token must be an environment reference such as $GITHUB_TOKEN`
- `GitHub tracker refuses to send a token over a non-HTTPS endpoint`
- `GitHub tracker provider.base_branch must be a non-empty branch name`
- `GitHub tracker provider.git_url must be a safe HTTPS repository URL`, optionally followed by
  ` for the configured repository`
- `GitHub tracker state at index <N> must be open, closed, or all` or
  `Unsupported GitHub issue state: <value>`
- `GitHub issue id at index <N> must be a positive decimal issue number`

An explicit unset/blank environment reference uses `missing_tracker_secret` and
`GitHub token environment variable <NAME> is not set`. Delivery or retry control uses
`Host-controlled GitHub features require an explicit tracker token environment reference` when
the explicit reference is absent; neither that variable nor `GITHUB_TOKEN` may appear in the
coding-agent environment allowlist.

### Scope, paging, and request limits

Reads are repository-scoped under `/repos/<owner>/<repo>/issues`. Required routing labels are not a
provider-side scope; the scheduler filters them. Pull requests returned by the Issues API are
retained as normalized records with `dispatchable: false`, so the scheduler excludes them from
dispatch. State inputs are trimmed, lowercased, and deduplicated; `all` expands to both `open` and
`closed` and is sent as the provider's `state=all` request.

State pages use `per_page=100`, `sort=created`, and `direction=asc`, with a maximum of 1,000 pages.
A validated `rel=next` link is followed even after a short page; without a Link header, a full page
falls back to the next numeric page. Pagination rejects loops, credentials, a different origin or
path, fragments, invalid syntax, and multiple next targets. One 30-second deadline covers each REST
request and its body read, redirects fail closed, and the adapter performs no retry.

ID inputs are deduplicated and fetched serially, one GET per unique issue. HTTP 404 responses are
omitted; pull-request records are returned with `dispatchable: false`. A returned issue number that
differs from the request fails the read. Internal
idempotent comment lookup scans 100 comments per page for at most 100 pages and updates the lowest
matching comment ID. Open-pull-request lookup requests up to 100 results and rejects multiple
matches.

### Identity and normalization

- `id` is `String(number)` while `nativeRef.number` remains numeric; `identifier` is
  `<owner>/<repo>#<number>`; `nativeRef` is `{ owner, repo, number }`.
- `title` is trimmed and nonblank; `description` is `body` or `null`; state remains provider-native
  `open` or `closed`; `priority` and `branchName` are `null`; `url` is `html_url` or `null`;
  `assigneeId` is the assignee login or `null`.
- Labels accept strings or label objects, then trim, lowercase, deduplicate, and drop blank,
  missing, null, or malformed names. `blockedBy` is `[]`; `dispatchable` is `false` when the payload
  has its own `pull_request` key and `true` otherwise.
- `createdAt` and `updatedAt` preserve supplied RFC 3339 timestamps with an offset; absent or
  unusable timestamps become `null`. Unusable optional body, URL, or assignee values also become
  `null`.

State-list reads omit payloads rejected by the issue schema. When a logger is supplied—as all
built-in CLI and orchestrator paths do—each affected provider page emits one warning, `Dropping
malformed GitHub issue records`, with only the aggregate `malformed_count`; raw records are never
logged. ID refresh remains strict: any payload rejected by the issue schema, or any refreshed
identity mismatch, makes the complete read fail with `tracker_response`. An object with its own
`pull_request` key is normalized with `dispatchable: false`; state reads also omit otherwise valid
issues outside the requested state set.

### Mutation, publishing, and error mapping

The shared GitHub tools map to REST comment creation, label add/removal, and issue-state update.
Manual comments are not idempotent. Host delivery hashes its UUID marker, scans existing comments,
and creates or updates the lowest matching ID. Publishing validates the workspace, pushes a branch,
and creates or reuses one open pull request. Repository, positive issue ID, and numeric `nativeRef`
are bound to the configured tracker; the deterministic branch is
`symphony/issue-<positive issue id>`. The exact model-facing schema and results are in the shared
tool table above.

GitHub request messages are redacted templates:

- Transport, abort, and timeout use `tracker_request` with
  `GitHub API <METHOD> <PATH> was aborted`, `... timed out after 30000ms`, or `... failed`.
- Required-read non-success statuses use `tracker_status` and
  `GitHub API <METHOD> <PATH> failed with HTTP <STATUS>`, except ID-refresh 404, which is omitted,
  and HTTP 429 or HTTP 403 carrying `Retry-After` or zero `x-ratelimit-remaining`, which use
  `tracker_rate_limited`. A headerless 403 remains `tracker_status`; the adapter does not expose
  retry timing metadata. Mutation paths may explicitly accept an operation-specific status such as
  the pull-request creation race's HTTP 422.
- Invalid JSON uses `tracker_response` and
  `GitHub API <METHOD> <PATH> returned invalid JSON`. Invalid issue lists, strict ID-refresh issue
  schemas, and refreshed identities use respectively `... returned a non-array issue list`,
  `... returned an invalid issue: <validation details>`, or
  `... returned issue <actual> instead of <requested>`. A response-body stream interruption is
  `tracker_request` and uses the redacted `... failed` message.
- `tracker_pagination` messages are `GitHub pagination Link loop detected for GET <PATH>`,
  `GitHub issue pagination exceeded 1000 pages`, `GitHub API returned an invalid pagination Link
  for rel=next`, `GitHub API returned multiple pagination Links for rel=next`, or a
  `GitHub pagination Link must ...` message naming credentials, origin, repository path, or
  fragment invariants.
