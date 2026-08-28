const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const utils = require(path.join(
    __dirname,
    "../../build/home/extensions-v1/interaction-service-utils.js"
));

test("input validator rejects unsafe and oversized sequences", () => {
    assert.throws(
        () => utils.validateInputRequest({ target: "studio-ui", events: [] }),
        error => error.code === "INVALID_ARGUMENT"
    );
    assert.throws(
        () =>
            utils.validateInputRequest({
                target: "studio-ui",
                events: [{ type: "pointer", action: "move", x: -1, y: 0 }]
            }),
        error => error.code === "INVALID_ARGUMENT"
    );
});

test("capture validator enforces bounded rectangles and targets", () => {
    const valid = utils.validateCaptureRequest({
        target: "runtime",
        projectId: "project-1",
        rect: { x: 0, y: 0, width: 100, height: 80 },
        format: "jpeg",
        quality: 75
    });
    assert.equal(valid.format, "jpeg");
    assert.throws(
        () =>
            utils.validateCaptureRequest({
                rect: { x: 0, y: 0, width: 4097, height: 4096 }
            }),
        error => error.code === "INVALID_ARGUMENT"
    );
});

test("asset target resolver rejects traversal, absolute and empty components", () => {
    const root = path.resolve("/tmp/project");
    assert.equal(utils.resolveAssetTarget(root, "images/icon.png").relativePath, "images/icon.png");
    for (const value of ["../escape.bin", "/tmp/escape.bin", "images//icon.png", "images/../icon.png"]) {
        assert.throws(() => utils.resolveAssetTarget(root, value), error => error.code === "ASSET_PATH_UNSAFE");
    }
});

test("rate limiter bounds calls in a sliding window", () => {
    const limiter = new utils.SlidingWindowRateLimiter(2, 1000);
    limiter.consume("ext", 1000);
    limiter.consume("ext", 1001);
    assert.throws(() => limiter.consume("ext", 1002), error => error.code === "TOO_MANY_REQUESTS");
    limiter.consume("ext", 2002);
});
