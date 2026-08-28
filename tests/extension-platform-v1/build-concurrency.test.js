"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const projectRoot = path.resolve(__dirname, "../..");
const { SerializedTaskQueue } = require(path.join(
    projectRoot,
    "build/project-editor/build/serialized-task-queue.js"
));
const {
    UnsafeBuildPathError,
    commitGuardedStagedBuildSync,
    createBuildStagingFolder,
    removeBuildStagingFolder,
    resolveBuildOutputPath,
    validateBuildManifestFiles
} = require(path.join(
    projectRoot,
    "build/project-editor/build/build-output.js"
));

async function withTemporaryDirectory(operation) {
    const directoryPath = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), "eez-build-output-test-")
    );
    try {
        return await operation(directoryPath);
    } finally {
        await fs.promises.rm(directoryPath, { recursive: true, force: true });
    }
}

test("serialized task queue prevents overlapping builds", async () => {
    const queue = new SerializedTaskQueue();
    let activeTasks = 0;
    let maximumActiveTasks = 0;
    const order = [];

    const run = value =>
        queue.run(async () => {
            activeTasks++;
            maximumActiveTasks = Math.max(maximumActiveTasks, activeTasks);
            order.push(`start-${value}`);
            await new Promise(resolve => setTimeout(resolve, 5));
            order.push(`finish-${value}`);
            activeTasks--;
            return value;
        });

    assert.deepEqual(await Promise.all([run(1), run(2), run(3)]), [1, 2, 3]);
    assert.equal(maximumActiveTasks, 1);
    assert.deepEqual(order, [
        "start-1",
        "finish-1",
        "start-2",
        "finish-2",
        "start-3",
        "finish-3"
    ]);
});

test("serialized task queue continues after a failed build", async () => {
    const queue = new SerializedTaskQueue();
    const failed = queue.run(async () => {
        throw new Error("expected build failure");
    });
    const recovered = queue.run(async () => "next build");

    await assert.rejects(failed, /expected build failure/);
    assert.equal(await recovered, "next build");
});

test("serialized task queue skips a task cancelled before it starts", async () => {
    const queue = new SerializedTaskQueue();
    const controller = new AbortController();
    let releaseFirst;
    let markFirstStarted;
    const firstStarted = new Promise(resolve => (markFirstStarted = resolve));
    let cancelledTaskRan = false;

    const first = queue.run(async () => {
        markFirstStarted();
        await new Promise(resolve => (releaseFirst = resolve));
    });
    const cancelled = queue.run(async () => {
        cancelledTaskRan = true;
    }, controller.signal);
    const cancelledResult = assert.rejects(
        cancelled,
        error => error.code === "CANCELLED"
    );

    await firstStarted;
    controller.abort();
    releaseFirst();
    await first;
    await cancelledResult;
    assert.equal(cancelledTaskRan, false);
});

test("serialized task queue checks cancellation when a task completes", async () => {
    const queue = new SerializedTaskQueue();
    const controller = new AbortController();
    let releaseTask;
    let markTaskStarted;
    const taskStarted = new Promise(resolve => (markTaskStarted = resolve));
    const waitForRelease = new Promise(resolve => (releaseTask = resolve));

    const cancelled = queue.run(async () => {
        markTaskStarted();
        await waitForRelease;
        return "completed body";
    }, controller.signal);

    await taskStarted;
    controller.abort();
    releaseTask();
    await assert.rejects(cancelled, error => error.code === "CANCELLED");
    assert.equal(await queue.run(async () => "next task"), "next task");
});

test("build output paths reject absolute and traversal paths on every platform", async () => {
    await withTemporaryDirectory(async destinationFolderPath => {
        for (const unsafePath of [
            "../outside.c",
            "sub/../../outside.c",
            "sub\\..\\..\\outside.c",
            "/tmp/outside.c",
            "C:\\outside.c",
            "\\\\server\\share\\outside.c"
        ]) {
            assert.throws(
                () =>
                    resolveBuildOutputPath(
                        destinationFolderPath,
                        unsafePath
                    ),
                error => error instanceof UnsafeBuildPathError
            );
        }

        assert.equal(
            resolveBuildOutputPath(destinationFolderPath, "src/generated.c"),
            path.join(destinationFolderPath, "src", "generated.c")
        );
    });
});

test("build manifests reject paths that could delete outside the output root", async () => {
    await withTemporaryDirectory(async destinationFolderPath => {
        assert.throws(
            () =>
                validateBuildManifestFiles(destinationFolderPath, [
                    "generated.c",
                    "../../source.c"
                ]),
            error => error instanceof UnsafeBuildPathError
        );
        assert.throws(
            () => validateBuildManifestFiles(destinationFolderPath, {}),
            error => error instanceof UnsafeBuildPathError
        );
    });
});

test("build output containment rejects an existing symlink escape", async t => {
    if (process.platform === "win32") {
        t.skip("creating symlinks requires optional Windows privileges");
        return;
    }

    await withTemporaryDirectory(async temporaryRoot => {
        const destinationFolderPath = path.join(temporaryRoot, "output");
        const outsideFolderPath = path.join(temporaryRoot, "outside");
        await fs.promises.mkdir(destinationFolderPath);
        await fs.promises.mkdir(outsideFolderPath);
        await fs.promises.symlink(
            outsideFolderPath,
            path.join(destinationFolderPath, "escape")
        );

        assert.throws(
            () =>
                resolveBuildOutputPath(
                    destinationFolderPath,
                    "escape/generated.c"
                ),
            error => error instanceof UnsafeBuildPathError
        );
    });
});

test("a failed guarded build barrier leaves destination files unchanged", async () => {
    await withTemporaryDirectory(async temporaryRoot => {
        const destinationFolderPath = path.join(temporaryRoot, "output");
        await fs.promises.mkdir(destinationFolderPath);
        await fs.promises.writeFile(
            path.join(destinationFolderPath, "generated.c"),
            "previous",
            "utf8"
        );
        const stagingFolderPath = await createBuildStagingFolder(
            destinationFolderPath
        );
        await fs.promises.writeFile(
            path.join(stagingFolderPath, "generated.c"),
            "next",
            "utf8"
        );

        assert.throws(
            () =>
                commitGuardedStagedBuildSync(
                    stagingFolderPath,
                    destinationFolderPath,
                    [],
                    () => {
                        const error = new Error("revision changed");
                        error.code = "PROJECT_REVISION_CONFLICT";
                        throw error;
                    }
                ),
            error => error.code === "PROJECT_REVISION_CONFLICT"
        );
        assert.equal(
            await fs.promises.readFile(
                path.join(destinationFolderPath, "generated.c"),
                "utf8"
            ),
            "previous"
        );
        await removeBuildStagingFolder(stagingFolderPath);
    });
});

test("a successful guarded build atomically enters commit and removes safe orphans", async () => {
    await withTemporaryDirectory(async temporaryRoot => {
        const destinationFolderPath = path.join(temporaryRoot, "output");
        await fs.promises.mkdir(destinationFolderPath);
        await fs.promises.writeFile(
            path.join(destinationFolderPath, "orphan.c"),
            "old",
            "utf8"
        );
        const stagingFolderPath = await createBuildStagingFolder(
            destinationFolderPath
        );
        await fs.promises.mkdir(path.join(stagingFolderPath, "src"));
        await fs.promises.writeFile(
            path.join(stagingFolderPath, "src", "generated.c"),
            "next",
            "utf8"
        );
        let guardCalls = 0;

        commitGuardedStagedBuildSync(
            stagingFolderPath,
            destinationFolderPath,
            ["orphan.c"],
            () => guardCalls++
        );

        assert.equal(guardCalls, 1);
        assert.equal(
            await fs.promises.readFile(
                path.join(destinationFolderPath, "src", "generated.c"),
                "utf8"
            ),
            "next"
        );
        assert.equal(fs.existsSync(path.join(destinationFolderPath, "orphan.c")), false);
        await removeBuildStagingFolder(stagingFolderPath);
    });
});
