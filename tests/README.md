# LVGL Textarea / ButtonMatrix checks

```sh
npm ci --ignore-scripts
node node_modules/electron/install.js
npm run build
npm run test:lvgl-metadata
xvfb-run -a npm run test:lvgl  # Linux, or npm run test:lvgl on a desktop
```

- The metadata gate compares all 73 catalog IDs with the generated framework's
  dispatch table, instantiates all five shipped WASM engines, checks the new map
  exports, and excludes test-only exports from release modules.
- The Electron test bootstraps the actual editor, loads/saves/reopens a project,
  checks old-project defaults and the shared Buttons class, resolves LVGL symbols,
  verifies nested Flow property indexes, and generates Flow/non-Flow C output.
- Nested Buttons edits use the actual command manager: undo/redo, add/delete,
  clipboard cloning, grouped multi-object changes and validation are exercised.
- Actual editor preview calls run against LVGL 8.4.0 / 9.2.2 / 9.3.0 / 9.4.0 / 9.5.0.
- Studio Run builds and executes a saved project for all five versions, with
  Start → LVGL Actions, all eight new actions, actual Textarea VALUE_CHANGED
  assignments, getter results, and live non-empty → empty → non-empty bindings.
- Generated Flow and non-Flow C, headers and assets are emitted for every version.
  `tests/native` compiles them as C, links the bundled amalgamation where needed,
  and executes the result with AddressSanitizer/UndefinedBehaviorSanitizer. This
  includes translation-hook output, 200 live-binding updates and teardown.
- Fixtures/generated C are written to `build/lvgl-regression`. UI state and the
  scratch database are isolated in the OS temporary directory.
- Runtime action execution and native sanitizer tests belong to the corresponding
  `studio-wasm-libs` change. Merely exporting `lv_*` functions is not that test.

The `LVGL validation` workflow builds and packages a directory artifact. It has
read-only repository permissions and never creates a release.

The workflow exercises Electron on Linux, Windows and macOS. Linux packaging is
followed by a five-version native generated-code matrix. For a local native run:

```sh
cmake -S tests/native -B /tmp/eez-generated -G Ninja \
  -DLVGL_VERSION=8.4.0 \
  -DLVGL_SOURCE_DIR=/path/to/studio-wasm-libs/lvgl-runtime/v8.4.0/lvgl \
  -DLVGL_CONFIG_FILE=/path/to/studio-wasm-libs/lvgl-runtime/v8.4.0/lv_conf.h
cmake --build /tmp/eez-generated --target generated-flow generated-no-flow --parallel 2
ctest --test-dir /tmp/eez-generated --output-on-failure
```

The exact LVGL commits used by CI come from `studio-wasm-libs` commit
`89789f6de80786ae9a26106e2881088002fd5846`. No device-specific fonts or hardware are
required for these host tests; project-specific fonts/input devices remain part
of the downstream firmware's integration testing.
