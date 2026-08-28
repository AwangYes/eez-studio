# Extension Platform 1.0

Extension Platform 1.0 runs package browser entries in an isolated Electron
sandbox and exposes Studio operations through a capability-gated service host.
The public TypeScript contract is published by `eez-studio-types`.

The service boundary uses stable JSON data transfer objects (DTOs). Extension
code must not depend on Studio implementation objects such as `ProjectStore`,
MobX observables, React components, Electron IPC objects, or object prototypes.

## Package manifest

An Extension Platform 1.0 package declares its metadata in the root
`package.json`:

```json
{
  "name": "com.example.my-extension",
  "version": "1.0.0",
  "displayName": "My Extension",
  "author": "Example",
  "eez-studio": {
    "apiVersion": "1.0",
    "host": "sandbox",
    "browser": "dist/extension.js",
    "activationEvents": ["onStartup"],
    "capabilities": ["project.read", "project.write"],
    "allowedOrigins": ["https://api.example.com"],
    "contributes": {}
  }
}
```

The package `name` is its default extension ID. An explicit `id` is also
accepted. `version` must be semantic versioning. The `eez-studio` object is a
closed object with these fields:

| Field | Required | Meaning |
| --- | --- | --- |
| `apiVersion` | yes | Must be `"1.0"`. |
| `host` | yes | Must be `"sandbox"`. |
| `browser` | yes | Package-relative JavaScript module loaded in the sandbox. |
| `activationEvents` | no | Activation declarations. `onStartup` is the current startup convention. |
| `capabilities` | no | Unique capabilities the extension may request. Declaration is not a grant. |
| `allowedOrigins` | no | Unique, exact HTTPS origins available to `fetch` and related browser APIs. |
| `contributes` | no | JSON-only declarative contributions. Extension-point schemas are defined separately. |

`browser` must stay inside the installed package and use a portable relative
path. Absolute paths, traversal, backslashes, links, devices, and unsupported
archive entries are rejected by installation policy. The root paths
`__host.html` and `__host.js` are reserved by Studio. An allowed origin must be
exact, for example `https://api.example.com` or
`https://api.example.com:8443`. Paths, query strings, wildcards, credentials,
and HTTP origins are not accepted.

The current host activates registered V1 extensions after the Studio home
renderer is ready. The manifest parser records all activation events, but 1.0
does not yet provide general lazy activation routing beyond startup.

### Home section contributions

`contributes.homeSections` adds declarative sections to the Studio Home UI. Its
schema is:

```json
{
  "contributes": {
    "homeSections": [
      {
        "id": "tools",
        "title": "Extension Tools",
        "icon": "material:extension",
        "category": "common",
        "commands": [
          { "id": "refresh", "title": "Refresh" }
        ]
      }
    ]
  }
}
```

An extension can contribute at most 32 Home sections and 32 commands per
section. Section and command IDs are 1 to 128 ASCII letters, digits, dots,
underscores, or hyphens, beginning with a letter or digit. Section IDs and
command IDs must each be unique across the extension. Titles are 1 to 80
characters. Icons must use `material:` followed by a lowercase Material icon
identifier containing only ASCII letters, digits, and underscores; URLs, file
paths, UNC paths, and arbitrary SVG names are rejected. `category` is optional and accepts
`none`, `common`, or `instrument`; it defaults to `common`.

Studio namespaces section IDs with the extension ID. It renders each command as
a button and sends its unqualified command ID to that extension's sandbox.
Contributions are registered when the extension appears in the renderer's
extension registry, including immediately after a dynamic install. Replacing an
extension first removes its previous sections; uninstalling it also closes any
open tabs backed by those sections. Commands issued during the short interval
between contribution registration and sandbox readiness are queued with a
bounded per-extension limit and delivered after activation.

## Browser entry and host API

The browser module must export `activate` and receives a
`SandboxExtensionHostApi`:

```ts
import type {
    SandboxExtensionHostApi,
    StudioProjectSnapshotResult
} from "eez-studio-types";

export async function activate(host: SandboxExtensionHostApi) {
    const projects = await host.request("workspace", "list", {});
    if (projects.length === 0) {
        return;
    }

    const page: StudioProjectSnapshotResult = await host.request(
        "project",
        "snapshot",
        { projectId: projects[0].projectId, limit: 65536 }
    );
    console.log(page.content, page.nextCursor);
}
```

`request(service, method, args)` returns the operation's typed result. A failed
request rejects with an `Error` whose `code` is a `StudioServiceErrorCode`.
`notify` has the same typed argument surface but intentionally discards results
and errors, so extensions should normally use `request`.

`window.eezExtensionHost` exposes the same host object. Prefer the argument
passed to `activate`, which is easier to test and makes the dependency explicit.

## Capability matrix

Every call requires the capability to be present in the manifest and granted
for the resolved workspace scope.

| Service | Methods | Required capability | Availability |
| --- | --- | --- | --- |
| `workspace` | `list`, `activate` | `project.read` | Public in 1.0 |
| `workspace` | `open`, `reload`, `close` | `project.manage` | Public in 1.0 |
| `project` | `describe`, `snapshot`, `getObject`, `getSchema` | `project.read` | Public in 1.0 |
| `project` | `applyEdits`, `save`, `undo`, `redo` | `project.write` | Public in 1.0 |
| `build` | `check`, `run` | `build.execute` | Public in 1.0 |
| `runtime` | `status` | `project.read` | Public in 1.0 |
| `runtime` | `start`, `stop`, `pause`, `resume`, `step` | `runtime.control` | Public in 1.0 |
| `editor` | `navigate`, `select` | `project.read` | Public in 1.0 |
| reserved | none | `input.inject` | No public 1.0 service yet |
| reserved | none | `asset.import` | No public 1.0 service yet |
| reserved | none | `screenshot.capture` | No public 1.0 service yet |
| reserved | none | `storage.secure` | No public Studio service yet |

A manifest declaration is necessary but does not bypass user authorization.
Permissions are scoped to the workspace resolved from the project or URI.
`runtime.control` grants are session-only. Other implemented capabilities can
be granted once or persisted for a workspace. Removing an extension revokes its
stored and session grants. Persistent grants are bound to both the extension ID
and the SHA-256 fingerprint of its verified Ed25519 public key. The
human-readable key ID is display metadata, not an authorization identity.
Unsigned Developer Mode packages receive session-only grants, and replacement
or uninstall invalidates outstanding permission prompts.

Permission prompts are serialized globally. Workspace scope identifiers reject
control characters and excessive lengths before they are used as authorization
keys or displayed to the user.

Before a sandbox starts, Studio re-verifies signed package contents and binds
the host to the verified publisher fingerprint and signed file digests. Every
file response is read once, checked against that immutable digest map, and then
served from the checked bytes. Any mismatch terminates the host. Unsigned
Developer Mode packages use a startup-time digest snapshot and receive the same
per-response mutation detection for the lifetime of that host.

## Workspace and projects

`workspace.list` returns `StudioProjectHandle` records for open project tabs.
The handle contains readiness, dirty and active state, plus revision and disk
hash concurrency tokens when available. Use `workspace.activate` to focus an
open project, `workspace.open` to open a URI, and `workspace.close` to close it.

`workspace.reload` refuses to discard a dirty project unless
`discardChanges: true` is explicit. Loading and reloading can be cancelled by
host shutdown or request timeout.

Project and object IDs are opaque strings. A project ID identifies one open
Studio tab instance; closing and reopening a file may produce another ID.
Object IDs are interpreted only within their project. Do not derive paths or
other implementation details from either identifier.

## Snapshots, objects, and schema

`project.snapshot` returns the serialized project JSON in bounded pages. The
default page is 65,536 UTF-16 code units and the maximum page is 1,048,576.
`cursor` and `nextCursor` use the declared `utf16-code-unit` unit. `offset` is a
compatibility alias for `cursor`. `totalBytes` is the UTF-8 byte length and
`hash` is the SHA-256 hash of the complete snapshot, not just the page.

Read pages against one `revision`. If any page reports a different revision,
discard the partial snapshot and restart. The snapshot hash allows the caller
to verify a reconstructed snapshot.

`project.getObject` returns an object's type and JSON value. `project.getSchema`
returns the available object type names and their properties. Schema property
records state the serialized type name, whether a value is required, and
whether it is read-only. Project-imported object types are included. A property
whose optionality depends on a concrete instance is conservatively marked
`required` and `conditionallyRequired`. Schema strings are identifiers, not JavaScript
constructors or Studio class references.

## Editing and transactions

`project.applyEdits` accepts between 1 and 1,000 synchronous edits:

- `create` adds an object to a named child collection. A `temporaryId` can be
  referenced as a parent or object ID by later edits in the same request.
- `update` replaces writable scalar properties on an existing object.
- `delete` removes an existing object.
- `move` reorders an item within its current compatible child collection at an
  optional zero-based index.

Structured Object, Array, and StringArray updates and cross-collection moves
are intentionally rejected in 1.0. Creating an object still uses Studio's
schema-aware serializer.

The complete edit list executes as one labelled transaction and produces one
undo entry. It is all-or-nothing: validation or execution failure rolls back
commands in reverse order. A rollback failure is surfaced explicitly as
`PROJECT_TRANSACTION_ROLLBACK_FAILED`. Successful creation IDs are returned in
`temporaryIds`.

Edits make the project dirty but do not save it. Use `project.save` separately.
`project.undo` and `project.redo` also produce new revisions.

## Revisions and saving

`StudioRevision` is an opaque, project-instance-scoped optimistic concurrency
token. Never parse it, compare it lexically, or persist it as durable project
identity. Pass the revision most recently observed by the extension as
`expectedRevision` on `applyEdits`, `save`, `undo`, and `redo`. A stale token fails with
`PROJECT_REVISION_CONFLICT` before the operation mutates or saves the project.

`diskHash` is the SHA-256 hash of the last loaded or successfully saved project
file. Pass an observed value as `expectedDiskHash` to pin the save to that
specific observation. When the field is omitted, `project.save` defaults to
Studio's own last loaded or saved disk hash, so disk writes still use compare
and swap. A mismatch fails with `PROJECT_DISK_HASH_CONFLICT`. A new project with
no disk baseline has no disk hash precondition.

Saving writes and flushes a same-directory temporary file, checks the expected
disk hash again immediately before replacement, atomically replaces the target,
and flushes the directory where the platform supports it. Each ProjectStore
serializes the complete save operation, so a later default-CAS save observes
the disk hash produced by the preceding save. Save As clears the old file hash
for the new target and restores the previous path and hash on failure.

Omitting `expectedRevision` disables only the caller's in-memory revision
guard. It does not disable the default disk hash guard. Extensions that combine
read, edit, and save operations should normally send both tokens they observed.

## Build, runtime, and editor

`build.check` validates a project and `build.run` produces build files. Both
return the revision used, an `ok` flag based on Studio output errors, and a
JSON-compatible result payload. A successful request can still return
`ok: false` when the project has build or validation errors. Pass
`expectedRevision` to reject a queued build if the project changed before it
starts. A build also fails with `PROJECT_REVISION_CONFLICT` if the project
changes while it runs, and cancelled queued builds do not start.
Extension API builds are generated in a sibling staging directory; output files
and manifest orphan removals are committed only after a final cancellation and
revision barrier. Unsafe absolute, traversal, or symlinked output paths are
rejected before they can write or delete outside the configured destination.

Runtime states are `stopped`, `starting`, `running`, and `paused`.
`runtime.start` can request debugger mode. `runtime.step` requires a paused
runtime and accepts `step-into`, `step-over`, or `step-out`; the default is
`step-over`. Runtime commands return the resulting status record.

`editor.navigate` reveals an object in the appropriate editor.
`editor.select` changes Studio's current object selection. These methods affect
the user's UI but do not mutate the project model.

## Events

`SandboxExtensionHostApi.subscribe` registers a listener for the
`StudioExtensionEvent` discriminated union and returns an unsubscribe function:

```ts
const unsubscribe = host.subscribe(event => {
    if (event.type === "runtime.changed") {
        console.log(event.projectId, event.status.state);
    }
});

// During extension cleanup:
unsubscribe();
```

The public event DTOs cover workspace changes, active projects, project changes
and saves, completed builds, runtime state, and editor selection. Studio 1.0
publishes `workspace.changed`; other event variants are reserved until their
emitters are integrated. Extensions must still refresh authoritative state with
request methods. Manifest activation events select when an extension starts and
are separate from host data events.

## Lifecycle and cleanup

Studio parses and registers a V1 descriptor without executing package code in
the application process. The sandbox host then imports the `browser` module and
awaits `activate(host)`. A load timeout or activation rejection tears down the
host and reports an activation error.

Sandbox deactivation is host-owned in 1.0. Shutdown, replacement, reload, and
uninstall call the optional module `deactivate(reason)` hook and wait up to
three seconds. Disposal then aborts outstanding service dispatch, removes IPC
listeners, destroys the isolated browser, and unregisters its protocol handler.
Extensions must still tolerate forced disposal after the deadline.

The separately exported `ExtensionContext` and `ExtensionModule` types describe
the managed module lifecycle used by Studio's context-based extension registry.
That registry aborts the context signal, awaits `deactivate`, and disposes all
registered subscriptions. A manifest `host: "sandbox"` browser entry receives
`SandboxExtensionHostApi`, not `ExtensionContext`.

## Sandbox boundary

Each V1 extension runs in a hidden `BrowserWindow` with:

- Electron sandboxing and context isolation enabled;
- Node integration and `<webview>` disabled;
- web security enabled;
- navigation and new windows denied;
- Chromium permissions, devices, display capture, and downloads denied;
- a private protocol limited to regular files inside the installation root;
- a content security policy whose default source is `none`;
- network access limited to exact manifest-declared HTTPS origins; and
- Studio access limited to the preload host's request, notify, and subscribe
  methods.

Extension code cannot import Node, Electron, Studio internals, or files outside
its installed package. Capabilities do not relax the browser sandbox. Network
origins do not grant Studio capabilities, and Studio capabilities do not grant
network access.

## Installation identity and recovery

Studio preserves the manifest extension ID as the public identity. IDs that are
not already short, safe directory names, including scoped IDs such as
`@example/extension`, are mapped to one lowercase SHA-256-based opaque directory name under the
extensions root. An ID never creates nested installation directories.

Archive extraction and replacement transactions use
`<extensions>/cache/.staging`. An update backup remains uncommitted until the
new package receives its activation acknowledgement. On startup, Studio always
rolls an uncommitted backup back over its target; after acknowledgement the
backup is atomically marked committed and can be removed without rollback.
Fresh installs use equivalent pending and installed markers. Studio also
removes abandoned incoming directories. Uninstall transactions restore an
uncommitted `uninstall` directory and atomically mark it `removed` only after
the uninstall acknowledgement. Filesystem cleanup errors are reported instead
of being treated as successful deletion. Install, update, and uninstall
operations for the same extension ID are serialized through one operation
queue; a failed operation does not block the next queued operation.
Before a retry starts, Studio resolves any staging state for that extension ID.
Startup recovery groups all markers by target: a committed install/update marker
preserves its target over stale rollback markers, while conflicting uncommitted
transactions fail closed without deleting or selecting either candidate.
If staging recovery reports any error, Studio skips the installed extension
root for that startup so an uncommitted target cannot activate.

Catalog ZIP metadata is authoritative. The statically inspected package ID,
version, and V1-or-legacy classification must match the selected catalog entry
before executable code can load. A catalog entry declared as V1 cannot
downgrade to the legacy loader. Catalog legacy or custom-loader packages
execute only when the catalog explicitly declares a non-V1 extension type.
Existing unsigned legacy catalog packages remain supported; the signature
requirement applies to V1 packages.

## Legacy packages

A package without `eez-studio.apiVersion` follows the legacy loader. Legacy
packages can declare `main` or `node-module` entries and can execute CommonJS
code in the application process. Their `init` and `destroy` hooks remain for
compatibility.

Legacy activation and initialization have a 10 second deadline. Deactivation,
destruction, and each managed subscription cleanup have a 3 second deadline.
Studio aborts the managed context before cleanup and continues startup or
shutdown after a hook times out.

The V1 sandbox, DTO, permission, and concurrency guarantees are not retrofitted
onto legacy packages. A package should migrate fully to the V1 manifest and
browser entry instead of mixing legacy execution fields with V1 assumptions.

## Publishing, signatures, and Developer Mode

The V1 release policy for production or catalog distribution is:

1. A package is signed by a trusted publisher identity.
2. The archive digest is verified before installation.
3. Updates reverify the signature, digest, and publisher identity before
   replacing an installed version.
4. Publisher key changes use an explicit trust and rotation process.

Unsigned local V1 ZIP packages require explicit Developer Mode, enabled with
`--extension-developer-mode` or `EEZ_STUDIO_EXTENSION_DEVELOPER_MODE=1`. The
extension manager displays a persistent warning while this mode is active. It
bypasses publisher trust only; it does not weaken sandboxing, capability
prompts, allowed-origin checks, path validation, archive limits, or concurrency
guards.

V1 installation validates archive entries before extraction and verifies a
signed, canonical file manifest with an Ed25519 publisher key. Studio repeats
that verification at process startup and extension reload to detect installed
files changed after installation. Catalog V1 installs always require a
signature.
Signed paths are normalized to Unicode NFC and sorted by UTF-8 byte order before
the signature payload is constructed, so verification is independent of host
locale and filesystem enumeration order.
The reviewed keys in
`trusted-publishers.ts` are the built-in trust roots; release engineering must
populate that table through normal source review before publishing a catalog
extension. Replacement uses a staged directory, backup switch, and rollback on
static validation, registration, or sandbox activation failure. The renderer
waits for a main-process activation acknowledgement before deleting the backup;
failed fresh installs are removed, while failed updates restore and reactivate
the previous package. Uninstall uses the same staged-directory approach.

Catalog metadata may pin the publisher's SHA-256 SPKI fingerprint. Studio
compares that pin with the verified signing key before executable extension code
can load. In-place V1 replacement always requires the same publisher
fingerprint; changing publishers, including replacing a signed package with an
unsigned Developer Mode package, requires an explicit uninstall first.
